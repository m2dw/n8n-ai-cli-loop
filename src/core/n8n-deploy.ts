/**
 * Deployment planning and verification for the n8n parent/child workflows
 * (issue #822).
 *
 * `admin n8n deploy` is the one supported command for getting the generated
 * workflows into a local n8n. Everything decision-shaped lives here as pure
 * functions over plain data; the CLI layer (src/cli/admin.ts) supplies the
 * facts (resolved paths, derived workflow identity) and the two side effects —
 * a command runner and an artifact reader — so the whole ordering,
 * verification, and publish policy is exercisable with a fake runner and no
 * n8n installation.
 *
 * Deployment order is not cosmetic:
 *
 *   1. generate              — regenerate the local, gitignored artifacts so the
 *                              import can never pick up a stale file
 *   2. check-parent-active   — record whether the parent is active BEFORE the
 *                              import overwrites it (see below); omitted when
 *                              `--publish` already asks for an active parent
 *   3. import-child          — the shared child FIRST: the parent's Call Phase
 *                              Runner node references the child by its stable
 *                              string ID, which n8n cannot resolve if the parent
 *                              lands first
 *   4. import-parent         — the session-specific parent
 *   5. verify-workflows      — `n8n list:workflow`: the imported IDs/names are
 *                              registered, exactly once each
 *   6. verify-parent-config  — the parent really drives the canonical sessionId
 *                              asked for, and really calls the shared child
 *   7. publish-parent        — optional, explicit, and last
 *      / restore-parent-active — instead of publish-parent when publication was
 *                              not requested: re-activates the parent only if it
 *                              was already active before this deploy
 *
 * Verification precedes publication so a mis-imported workflow is never
 * activated: a parent whose Config points at another session would start
 * driving that session on its schedule trigger.
 *
 * Activation is state n8n keeps on the workflow record, and `import:workflow`
 * upserts the whole record — including the generated artifact's `active: false`.
 * A plain re-deploy of a running session would therefore silently stop its
 * schedule trigger, which no invocation asked for. `check-parent-active` reads
 * the prior state before the import and `restore-parent-active` puts it back
 * afterwards, so this command only ever changes activation when explicitly told
 * to: `--publish` activates, and nothing here deactivates.
 *
 * Restoration is deliberately on the far side of verification. A failed deploy
 * leaves a previously active parent inactive rather than re-activating a
 * workflow that just failed its checks; the caller is told so explicitly.
 *
 * That check-then-restore pair is a read of state followed by a write of it, so
 * it only holds when nothing else changes the parent's activation in between.
 * Two concurrent deploys of the same parent would otherwise lose one: a plain
 * deploy reads "inactive", a `--publish` deploy activates, and the plain deploy
 * then imports its `active: false` artifact and skips the restore it decided
 * against — both report success and the published parent ends up down. The
 * whole execution therefore runs under a lock scoped to the parent workflow
 * ({@link n8nDeployLockScope}, supplied by the caller as
 * {@link N8nDeployDeps.acquireLock}), so the check, the import, and the restore
 * are one serialized sequence per parent. The lock covers deploys of the same
 * parent only; activation changed from the n8n UI mid-deploy is outside any
 * lock this command can take.
 *
 * A second, narrower lock covers what deploys of *different* parents share: the
 * child. There is one child artifact and one child workflow ID for the whole
 * install, and `generate` rewrites that artifact with this run's `CLI_BASE`
 * baked into its Execute Command nodes. Two sessions deployed concurrently with
 * different — individually supported — `CLI_BASE` values would otherwise have one
 * run's `import-child` read the artifact the other run had just rewritten, or
 * read it mid-write and fail the import outright, leaving a parent calling a
 * child wired to another installation. Generation and the child import therefore
 * run under a lock scoped to the child workflow
 * ({@link n8nDeployChildLockScope}, supplied as
 * {@link N8nDeployDeps.acquireChildLock}), so "write the shared artifact, then
 * import it" is one serialized sequence across every session.
 *
 * That lock is released as soon as the plan is past `import-child`: every later
 * step concerns this session's own parent, and holding the shared lock through
 * verification and publication would serialize unrelated deploys for nothing.
 * The parent lock is taken first, so a second deploy of the *same* session is
 * told that by name rather than being told the shared child is busy; since
 * neither acquisition blocks — a held lock is refused, not queued — the two
 * cannot deadlock in either order.
 *
 * What the n8n CLI cannot do is make any of this visible to an n8n server that
 * is already running: `import:workflow` and `update:workflow` are separate
 * processes writing the same database, while a live `n8n start` holds its
 * workflows — and its active triggers — in memory and never re-reads them. So
 * `update:workflow --active=true` marks the parent active in the database, but
 * the Schedule Trigger of an already-running instance does not begin firing
 * until that instance restarts. Restarting it is not this command's to do: the
 * process may be a foreground shell, a systemd unit, pm2, or a container, and
 * stopping the wrong one would take the loop down. The deploy therefore states
 * the requirement ({@link N8N_RESTART_NOTICE}, surfaced whenever
 * `restartRequired` is set) rather than reporting an activation it cannot make
 * effective.
 *
 * Scope (deliberately narrow): a local/same-host n8n CLI v1. Deployment over
 * the n8n REST API and remote Docker orchestration are out of scope, so the
 * only n8n surface used here is `import:workflow`, `list:workflow`, and
 * `update:workflow`.
 */

import { sanitizeBody } from "./text-sanitize.js";

// ---------------------------------------------------------------------------
// Plan shape
// ---------------------------------------------------------------------------

/** Ordered, stable step identities. Both output modes key on these. */
export type N8nDeployStepId =
  | "generate"
  | "check-parent-active"
  | "import-child"
  | "import-parent"
  | "verify-workflows"
  | "verify-parent-config"
  | "publish-parent"
  | "restore-parent-active";

/**
 * One external command. `file` and `args` are kept apart — never joined into a
 * shell string — so a path or project ID containing a space, quote, or shell
 * metacharacter travels as exactly one argument. {@link formatCommandLine}
 * exists only to render a command for a human to read.
 */
export interface N8nDeployCommand {
  /** Executable to run. Never interpreted by a shell. */
  file: string;
  /** One element per argument. */
  args: string[];
  /** Environment overrides merged onto the parent environment by the runner. */
  env?: Record<string, string>;
  /** Working directory for the command. */
  cwd?: string;
  /** Hard timeout in milliseconds. */
  timeoutMs: number;
}

export interface N8nDeployStep {
  id: N8nDeployStepId;
  /** One-line operator description of what the step does. */
  label: string;
  /**
   * The command the step runs, or `undefined` for a local check that spawns
   * nothing (`verify-parent-config` reads the generated artifact instead).
   */
  command?: N8nDeployCommand;
}

export interface N8nWorkflowIdentity {
  workflowId: string;
  workflowName: string;
  /** Absolute path of the deployment artifact. */
  artifactPath: string;
  /** Artifact filename on its own — the path-free half, safe to display. */
  artifactFile: string;
}

export interface N8nDeployPlanInput {
  /** Canonical sessionId the parent workflow drives. */
  sessionId: string;
  /** Control-plane repository root (holds `scripts/` and `.n8n-artifacts/`). */
  installRoot: string;
  /** `dist/cli` path baked into the generated Execute Command nodes. */
  cliBase: string;
  /**
   * The `sessions.json` the session was resolved against. Forwarded to the
   * generator, which resolves `SESSION_REF` through the registry itself: with a
   * custom `--sessions-path` it would otherwise look the canonical sessionId up
   * in the *default* registry and fail (or, worse, find a different session).
   */
  sessionsPath: string;
  /** Node executable used to run the generator script. */
  nodeBin: string;
  /** Absolute path of `scripts/build-parent-child-workflow.mjs`. */
  generatorScript: string;
  /** The `n8n` binary (default `"n8n"`, or an explicit `--n8n-bin` path). */
  n8nBin: string;
  /** Optional n8n project the workflows are imported into. */
  projectId?: string;
  /** Whether the plan ends with the explicit publish (activate) step. */
  publish: boolean;
  parent: N8nWorkflowIdentity;
  child: N8nWorkflowIdentity;
}

export interface N8nDeployPlan {
  sessionId: string;
  parent: N8nWorkflowIdentity;
  child: N8nWorkflowIdentity;
  projectId?: string;
  publish: boolean;
  steps: N8nDeployStep[];
}

/**
 * Generating artifacts may compile the TypeScript library on a fresh checkout,
 * which is far slower than any n8n CLI call — hence two budgets rather than one.
 */
export const GENERATE_TIMEOUT_MS = 600_000;
export const N8N_COMMAND_TIMEOUT_MS = 120_000;

/**
 * Lock scope for one parent workflow's deployment.
 *
 * Keyed on the parent workflow ID rather than the session: that is the record
 * whose activation the check/import/restore sequence reads and writes, and it is
 * derived from the canonical sessionId, so two deploys collide exactly when they
 * would fight over the same workflow. Deploys of different sessions overlap
 * freely under this lock; what they do share — the child artifact and the child
 * workflow record — is serialized by {@link n8nDeployChildLockScope} instead.
 */
export function n8nDeployLockScope(parentWorkflowId: string): string {
  return `n8n-deploy:${parentWorkflowId}`;
}

/**
 * Lock scope for the shared child workflow's generation and import.
 *
 * Keyed on the child workflow ID, which is one constant for the whole install:
 * every session's deploy rewrites and imports the same artifact under it, so this
 * scope is deliberately install-wide rather than per session. Distinct from
 * {@link n8nDeployLockScope}'s prefix so the two can never name the same lock
 * file (the two are held at once, and a single scope would self-collide).
 */
export function n8nDeployChildLockScope(childWorkflowId: string): string {
  return `n8n-deploy-child:${childWorkflowId}`;
}

/**
 * Worst case number of timed n8n calls in one plan: the activation probe, the
 * two imports, the verification listing, and the closing activate. The
 * `--publish` plan drops the probe, so no plan exceeds this.
 */
export const N8N_DEPLOY_MAX_N8N_COMMANDS = 5;

/** Total time a deploy may spend *inside* its timed commands. */
const N8N_DEPLOY_COMMAND_BUDGET_MS =
  GENERATE_TIMEOUT_MS + N8N_DEPLOY_MAX_N8N_COMMANDS * N8N_COMMAND_TIMEOUT_MS;

/**
 * Margin added to the command budget before a lock holder is presumed dead.
 *
 * The budget bounds only the time inside the commands themselves. It counts
 * neither the spawn and teardown around each one, nor the untimed local work
 * between them (reading the generated artifacts back, parsing `list:workflow`,
 * `verify-parent-config`), nor the scheduling delay a loaded host adds to all of
 * it. A healthy deploy whose steps each finish just under their limits would
 * therefore age past the exact sum while still running, and a concurrent deploy
 * of the same parent would take the lock from it and interleave their
 * import/restore sequences. Half the budget is far more slack than that overhead
 * has any way to consume, and still leaves the whole window short (25 minutes)
 * — a crashed deploy is recovered automatically rather than by a manual unlock.
 */
export const N8N_DEPLOY_LOCK_SLACK_MS = N8N_DEPLOY_COMMAND_BUDGET_MS / 2;

/**
 * How long a deploy may hold its lock before the holder is presumed dead.
 *
 * A deploy is bounded by its own step timeouts, so anything older than that
 * budget plus {@link N8N_DEPLOY_LOCK_SLACK_MS} is a crashed process, not a slow
 * one. Left at the lock store's day-long default, a deploy killed mid-run would
 * block every later deploy of that session — and, through the shared child's
 * lock, of every other session — until tomorrow.
 *
 * Both locks use it. The child's window (generation through the child import) is
 * a strict prefix of the parent's, so this bound is simply a conservative one for
 * it rather than a second constant to keep in step.
 */
export const N8N_DEPLOY_LOCK_STALE_TTL_MS =
  N8N_DEPLOY_COMMAND_BUDGET_MS + N8N_DEPLOY_LOCK_SLACK_MS;

/**
 * The one thing this command cannot do for the operator (see the file header):
 * an n8n that was already running when the deploy wrote the database keeps
 * serving what it loaded at startup, so an activation is not yet in effect.
 */
export const N8N_RESTART_NOTICE =
  "n8n loads its workflows at startup: if n8n was already running on this host, restart it " +
  "so the imported workflows and the parent's active state take effect — until then an " +
  "activated Schedule Trigger does not fire.";

/**
 * Steps that write the n8n database, and so leave a running n8n out of date.
 * `generate` only writes local artifacts, and the two `list:workflow` steps
 * only read, so neither can make a restart necessary.
 */
const N8N_MUTATING_STEPS: ReadonlySet<N8nDeployStepId> = new Set<N8nDeployStepId>([
  "import-child",
  "import-parent",
  "publish-parent",
  "restore-parent-active",
]);

/**
 * Re-encode a canonical sessionId as a single `SESSION_REF` entry.
 *
 * The generator reads `SESSION_REF` as a comma-separated list and trims each
 * entry, with a backslash escaping the character after it (see
 * `parseSessionRefs`). `sessions.json` accepts a sessionId that contains a comma
 * or is padded with spaces, so handing such a value over raw would split it into
 * two unknown references or silently trim it into a different session. This is
 * the exact inverse: backslashes and commas are escaped everywhere, and leading
 * and trailing whitespace is escaped so it survives the trim.
 */
export function encodeSessionRefEnvValue(sessionId: string): string {
  const chars = [...sessionId];
  let lead = 0;
  while (lead < chars.length && /\s/.test(chars[lead])) lead += 1;
  let trailStart = chars.length;
  while (trailStart > lead && /\s/.test(chars[trailStart - 1])) trailStart -= 1;
  return chars
    .map((ch, i) => {
      if (ch === "\\" || ch === ",") return `\\${ch}`;
      if (i < lead || i >= trailStart) return `\\${ch}`;
      return ch;
    })
    .join("");
}

/**
 * Build the ordered deployment plan. Pure: it neither runs nor reads anything,
 * so a preview is exactly the plan an apply would execute, minus the execution.
 */
export function planN8nDeploy(input: N8nDeployPlanInput): N8nDeployPlan {
  const projectArgs = input.projectId === undefined ? [] : [`--projectId=${input.projectId}`];
  // Read the parent's current activation before the import overwrites it.
  // Pointless when publication was requested — that ends with the parent active
  // either way — so the plan spends the extra n8n call only when the deploy
  // could otherwise deactivate something.
  const activationProbe: N8nDeployStep[] = input.publish
    ? []
    : [
        {
          id: "check-parent-active",
          label: "Record whether the parent workflow is already active",
          command: {
            file: input.n8nBin,
            args: ["list:workflow", "--active=true"],
            timeoutMs: N8N_COMMAND_TIMEOUT_MS,
          },
        },
      ];
  const steps: N8nDeployStep[] = [
    {
      id: "generate",
      label: "Generate the local deployment artifacts for this session",
      command: {
        file: input.nodeBin,
        args: [input.generatorScript],
        env: {
          SESSION_REF: encodeSessionRefEnvValue(input.sessionId),
          CLI_BASE: input.cliBase,
          SESSIONS_PATH: input.sessionsPath,
          // Deploying writes the gitignored artifacts it is about to import and
          // nothing else — never the tracked docs/ templates.
          WORKFLOW_ARTIFACTS_ONLY: "1",
        },
        cwd: input.installRoot,
        timeoutMs: GENERATE_TIMEOUT_MS,
      },
    },
    ...activationProbe,
    {
      id: "import-child",
      label: `Import the shared child workflow (${input.child.workflowId})`,
      command: {
        file: input.n8nBin,
        args: ["import:workflow", `--input=${input.child.artifactPath}`, ...projectArgs],
        timeoutMs: N8N_COMMAND_TIMEOUT_MS,
      },
    },
    {
      id: "import-parent",
      label: `Import the session parent workflow (${input.parent.workflowId})`,
      command: {
        file: input.n8nBin,
        args: ["import:workflow", `--input=${input.parent.artifactPath}`, ...projectArgs],
        timeoutMs: N8N_COMMAND_TIMEOUT_MS,
      },
    },
    {
      id: "verify-workflows",
      label: "Verify both workflow IDs and names are registered exactly once",
      command: {
        file: input.n8nBin,
        args: ["list:workflow"],
        timeoutMs: N8N_COMMAND_TIMEOUT_MS,
      },
    },
    {
      id: "verify-parent-config",
      label: "Verify the parent's Config sessionId and child-workflow reference",
    },
  ];
  steps.push(
    input.publish
      ? {
          id: "publish-parent",
          label: `Publish (activate) the parent workflow ${input.parent.workflowId}`,
          command: {
            file: input.n8nBin,
            args: ["update:workflow", `--id=${input.parent.workflowId}`, "--active=true"],
            timeoutMs: N8N_COMMAND_TIMEOUT_MS,
          },
        }
      : {
          // Runs only when `check-parent-active` found the parent active; the
          // command is identical to publication because restoring an active
          // parent is the same n8n operation, just not one the operator asked
          // for by name.
          id: "restore-parent-active",
          label: `Restore the parent workflow ${input.parent.workflowId} to active if it was active before this deploy`,
          command: {
            file: input.n8nBin,
            args: ["update:workflow", `--id=${input.parent.workflowId}`, "--active=true"],
            timeoutMs: N8N_COMMAND_TIMEOUT_MS,
          },
        },
  );
  return {
    sessionId: input.sessionId,
    parent: input.parent,
    child: input.child,
    ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
    publish: input.publish,
    steps,
  };
}

// ---------------------------------------------------------------------------
// Display and sanitization
// ---------------------------------------------------------------------------

/** POSIX single-quote a token for display when it is not already inert. */
function quoteForDisplay(token: string): string {
  if (token !== "" && /^[A-Za-z0-9_@%+=:,./-]+$/.test(token)) return token;
  return `'${token.replace(/'/g, "'\\''")}'`;
}

/**
 * Render a command the way an operator would type it. Display only — the
 * runner never sees this string, so a quoting bug here can change what is
 * printed but can never change what is executed.
 */
export function formatCommandLine(command: N8nDeployCommand): string {
  const envPrefix = Object.entries(command.env ?? {})
    .map(([key, value]) => `${key}=${quoteForDisplay(value)}`)
    .join(" ");
  const body = [command.file, ...command.args].map(quoteForDisplay).join(" ");
  return envPrefix === "" ? body : `${envPrefix} ${body}`;
}

/**
 * Strip local filesystem paths out of anything the command shows a user.
 *
 * Deploy output is the kind of thing an operator pastes into an issue or a chat
 * when something goes wrong, and it is dense with absolute paths: the install
 * root, the artifact directory, the baked-in `dist/cli` path, plus whatever the
 * n8n CLI echoes back. The workflow IDs, names, and artifact *filenames* are
 * what actually identify a deployment, and those survive untouched.
 */
export function sanitizeDeployText(text: string, localPaths: readonly string[] = []): string {
  return sanitizeBody(text, [...localPaths]);
}

/**
 * The absolute roots {@link sanitizeDeployText} must redact for one deployment.
 *
 * `sanitizeBody`'s built-in rules only know the conventional roots (`/usr`,
 * `/home`, `/Users`, `/opt`, …), so anything installed somewhere unconventional
 * — `--n8n-bin /secret-install/bin/n8n`, a node built under a private prefix, a
 * `--sessions-path` outside `$HOME` — survives them and would be printed in
 * full. Every local path this command can name in its output is therefore
 * listed explicitly.
 *
 * `n8nBin` is the one entry that may legitimately not be a path: the default
 * (and the usual case) is the bare command name `n8n`, resolved through `PATH`.
 * Redacting that would rewrite the literal word `n8n` — every command line the
 * preview prints — as `<path>`, so only a separator-bearing value is taken as a
 * filesystem path. Callers pass the same value they put in the plan, so what is
 * redacted is exactly what is printed.
 */
export function collectN8nDeployLocalPaths(input: {
  installRoot: string;
  artifactDir: string;
  cliBase: string;
  nodeBin: string;
  sessionsPath: string;
  n8nBin: string;
}): string[] {
  const paths = [
    input.installRoot,
    input.artifactDir,
    input.cliBase,
    input.nodeBin,
    input.sessionsPath,
  ];
  if (/[/\\]/.test(input.n8nBin)) paths.push(input.n8nBin);
  return paths.filter((path) => path !== "");
}

// ---------------------------------------------------------------------------
// Verification: `n8n list:workflow`
// ---------------------------------------------------------------------------

export interface N8nWorkflowListEntry {
  id: string;
  name: string;
}

/**
 * Parse `n8n list:workflow` output, whose rows are `<id>|<name>`.
 *
 * Only the first `|` separates the two fields — an n8n workflow ID never
 * contains one, but a name may. Lines with no `|` at all are banner/progress
 * noise and are skipped; a run that yields no rows is reported as a
 * verification failure by {@link verifyImportedWorkflows} rather than silently
 * passing.
 */
export function parseWorkflowList(stdout: string): N8nWorkflowListEntry[] {
  const entries: N8nWorkflowListEntry[] = [];
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    if (line === "") continue;
    const separator = line.indexOf("|");
    if (separator < 0) continue;
    const id = line.slice(0, separator).trim();
    if (id === "") continue;
    entries.push({ id, name: line.slice(separator + 1).trim() });
  }
  return entries;
}

export interface N8nVerificationResult {
  ok: boolean;
  /** Human-readable, path-free descriptions of every failed check. */
  problems: string[];
  /** The rows matched for each expected workflow, when found. */
  matched: { parent?: N8nWorkflowListEntry; child?: N8nWorkflowListEntry };
}

function verifyOneWorkflow(
  role: "parent" | "child",
  expected: { workflowId: string; workflowName: string },
  entries: readonly N8nWorkflowListEntry[],
  problems: string[],
): N8nWorkflowListEntry | undefined {
  const byId = entries.filter((entry) => entry.id === expected.workflowId);
  if (byId.length === 0) {
    problems.push(
      `${role} workflow ${expected.workflowId} is not registered in n8n after import`,
    );
    return undefined;
  }
  if (byId.length > 1) {
    // n8n keys workflows by ID, so this should be impossible — report it rather
    // than picking one arbitrarily and publishing against the wrong record.
    problems.push(
      `${role} workflow ${expected.workflowId} is listed ${byId.length} times`,
    );
  }
  const matched = byId[0];
  if (matched.name !== expected.workflowName) {
    problems.push(
      `${role} workflow ${expected.workflowId} is named ${JSON.stringify(matched.name)}, ` +
        `expected ${JSON.stringify(expected.workflowName)}`,
    );
  }
  // A second workflow under the same name with a different ID is the signature
  // of a duplicate import: the stable IDs exist precisely so a re-deploy updates
  // the existing workflow instead of creating another copy of it.
  const duplicates = entries.filter(
    (entry) => entry.name === expected.workflowName && entry.id !== expected.workflowId,
  );
  for (const duplicate of duplicates) {
    problems.push(
      `a duplicate ${role} workflow named ${JSON.stringify(expected.workflowName)} exists ` +
        `under a different ID (${duplicate.id}) — remove it so the stable ID updates in place`,
    );
  }
  return matched;
}

/**
 * Check that both imported workflows are registered under their stable IDs and
 * expected names, exactly once each.
 */
export function verifyImportedWorkflows(
  entries: readonly N8nWorkflowListEntry[],
  expected: {
    parent: { workflowId: string; workflowName: string };
    child: { workflowId: string; workflowName: string };
  },
): N8nVerificationResult {
  const problems: string[] = [];
  if (entries.length === 0) {
    problems.push(
      "n8n list:workflow returned no readable '<id>|<name>' rows, so the import could not be verified",
    );
    return { ok: false, problems, matched: {} };
  }
  const child = verifyOneWorkflow("child", expected.child, entries, problems);
  const parent = verifyOneWorkflow("parent", expected.parent, entries, problems);
  return {
    ok: problems.length === 0,
    problems,
    matched: {
      ...(parent === undefined ? {} : { parent }),
      ...(child === undefined ? {} : { child }),
    },
  };
}

// ---------------------------------------------------------------------------
// Verification: the parent artifact's Config node
// ---------------------------------------------------------------------------

interface ParentWorkflowShape {
  id?: unknown;
  name?: unknown;
  nodes?: unknown;
}

function findNode(workflow: ParentWorkflowShape, nodeName: string): Record<string, unknown> | undefined {
  if (!Array.isArray(workflow.nodes)) return undefined;
  return workflow.nodes.find(
    (node): node is Record<string, unknown> =>
      typeof node === "object" && node !== null && (node as { name?: unknown }).name === nodeName,
  );
}

/** Read `Config`'s `sessionId` assignment out of the parent workflow JSON. */
function readConfigSessionId(workflow: ParentWorkflowShape): string | undefined {
  const config = findNode(workflow, "Config");
  const parameters = config?.["parameters"];
  if (typeof parameters !== "object" || parameters === null) return undefined;
  const outer = (parameters as { assignments?: unknown }).assignments;
  if (typeof outer !== "object" || outer === null) return undefined;
  const list = (outer as { assignments?: unknown }).assignments;
  if (!Array.isArray(list)) return undefined;
  const entry = list.find(
    (item): item is { value?: unknown } =>
      typeof item === "object" && item !== null && (item as { name?: unknown }).name === "sessionId",
  );
  const value = entry?.value;
  return typeof value === "string" ? value : undefined;
}

/** Read the child workflow the parent's Call Phase Runner node points at. */
function readCalledChildWorkflowId(workflow: ParentWorkflowShape): string | undefined {
  const call = findNode(workflow, "Call Phase Runner");
  const parameters = call?.["parameters"];
  if (typeof parameters !== "object" || parameters === null) return undefined;
  const workflowId = (parameters as { workflowId?: unknown }).workflowId;
  return typeof workflowId === "string" ? workflowId : undefined;
}

/**
 * Verify the parent artifact that was just imported: the identity it registers,
 * the canonical sessionId its Config node drives, and the child it calls.
 *
 * This reads the artifact rather than exporting the workflow back out of n8n
 * because the artifact is byte-for-byte what `import:workflow` was handed —
 * `list:workflow` already confirms n8n accepted it — and it keeps the command's
 * n8n CLI surface to the three documented calls.
 *
 * A mismatch here is exactly the case publication must not survive: an activated
 * parent whose Config names a different session would start driving that other
 * session on its schedule trigger.
 */
export function verifyParentWorkflowConfig(
  workflow: unknown,
  expected: { sessionId: string; workflowId: string; workflowName: string; childWorkflowId: string },
): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  if (typeof workflow !== "object" || workflow === null || Array.isArray(workflow)) {
    return { ok: false, problems: ["the parent artifact is not a workflow object"] };
  }
  const parent = workflow as ParentWorkflowShape;
  if (parent.id !== expected.workflowId) {
    problems.push(
      `the parent artifact declares workflow ID ${JSON.stringify(parent.id)}, ` +
        `expected ${JSON.stringify(expected.workflowId)}`,
    );
  }
  if (parent.name !== expected.workflowName) {
    problems.push(
      `the parent artifact is named ${JSON.stringify(parent.name)}, ` +
        `expected ${JSON.stringify(expected.workflowName)}`,
    );
  }
  const sessionId = readConfigSessionId(parent);
  if (sessionId === undefined) {
    problems.push("the parent artifact has no Config node holding a sessionId");
  } else if (sessionId !== expected.sessionId) {
    problems.push(
      `the parent's Config sessionId is ${JSON.stringify(sessionId)}, ` +
        `expected the canonical ${JSON.stringify(expected.sessionId)}`,
    );
  }
  const childWorkflowId = readCalledChildWorkflowId(parent);
  if (childWorkflowId === undefined) {
    problems.push("the parent artifact has no Call Phase Runner node referencing a child workflow");
  } else if (childWorkflowId !== expected.childWorkflowId) {
    problems.push(
      `the parent calls child workflow ${JSON.stringify(childWorkflowId)}, ` +
        `expected the shared ${JSON.stringify(expected.childWorkflowId)}`,
    );
  }
  return { ok: problems.length === 0, problems };
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export interface N8nCommandResult {
  /** Exit code, or a negative value when the command could not be started. */
  status: number;
  stdout: string;
  stderr: string;
  /**
   * Whether the process actually started. Only a command that ran can have
   * written the n8n database, so this — not the exit code — is what decides
   * whether a restart is required: a missing or unrunnable `n8n` binary reports
   * a negative status without ever touching anything, while a command killed by
   * its timeout reports the same negative status having possibly written half of
   * it. Optional: omitted means "infer from the status", which is right for
   * every result carrying a real exit code.
   */
  started?: boolean;
}

/**
 * Did this command's process run? A non-negative status can only come from a
 * process that exited, so a runner that does not report `started` (a test fake,
 * say) still classifies every real exit code correctly.
 */
function commandStarted(result: N8nCommandResult): boolean {
  return result.started ?? result.status >= 0;
}

export type N8nDeployRunner = (command: N8nDeployCommand) => N8nCommandResult;

/** Reads a deployment artifact. Throws when the file is missing or unreadable. */
export type N8nArtifactReader = (path: string) => string;

/**
 * Result of taking one of the two deployment locks (see the file header).
 *
 * `detail` describes the current holder for the operator, and must be path-free
 * or sanitizable — it is reported. `release` is called exactly once, whatever the
 * deploy's outcome.
 */
export type N8nDeployLockAcquisition =
  | { acquired: true; release: () => void }
  | { acquired: false; detail: string };

export type N8nDeployLockAcquirer = () => N8nDeployLockAcquisition;

export type N8nDeployStepOutcome = "ok" | "failed" | "skipped";

export interface N8nDeployStepResult {
  id: N8nDeployStepId;
  label: string;
  outcome: N8nDeployStepOutcome;
  /** Sanitized command line, for the step to be reproducible by hand. */
  commandLine?: string;
  exitCode?: number;
  /** Sanitized failure detail (command stderr, parse error, problem list). */
  detail?: string;
}

export interface N8nDeployExecution {
  ok: boolean;
  /** Whether the parent workflow was activated by an explicit `--publish`. */
  published: boolean;
  /**
   * Whether the parent was active before this deploy, as read by
   * `check-parent-active`. Absent when that step never ran (publication was
   * requested, so the parent ends active regardless) or never completed.
   *
   * Trustworthy for the length of the run because the deployment lock is held
   * across the check and the restore that acts on it.
   */
  parentWasActive?: boolean;
  /** Whether an already active parent was re-activated after the import. */
  parentActiveRestored: boolean;
  /**
   * Whether this run wrote the n8n database, and so needs an already-running
   * n8n restarted before what it wrote — imported workflow content, and above
   * all the parent's active state — is actually in effect. Set as soon as a
   * database-writing command has *started*: a command that started and then
   * failed partway still leaves the running instance out of date, while one that
   * never started (a missing `n8n` binary) wrote nothing and must not send the
   * operator off to restart a server this run never reached. See
   * {@link N8N_RESTART_NOTICE}.
   */
  restartRequired: boolean;
  steps: N8nDeployStepResult[];
  /** Present once `verify-workflows` has run. */
  verification?: N8nVerificationResult;
  /**
   * `step` is absent only when the run failed before any step could run —
   * another deploy held this parent's lock, or the shared child's.
   */
  failure?: { step?: N8nDeployStepId; reason: string; detail?: string };
}

export interface N8nDeployDeps {
  run: N8nDeployRunner;
  readArtifact: N8nArtifactReader;
  /**
   * Takes the per-parent deployment lock for the whole run (see the file
   * header). Required rather than optional: an unserialized deploy can drop a
   * concurrently published activation, and that must be a compile error at a new
   * call site rather than a silent default.
   */
  acquireLock: N8nDeployLockAcquirer;
  /**
   * Takes the install-wide lock on the shared child workflow, held from before
   * `generate` until `import-child` is done (see the file header). Required for
   * the same reason: without it, concurrent deploys of different sessions can
   * import each other's child artifact.
   */
  acquireChildLock: N8nDeployLockAcquirer;
  /** Extra absolute paths to redact from user-facing output. */
  localPaths?: readonly string[];
}

/**
 * Execute a plan in order, stopping at the first failed step.
 *
 * Stopping is what enforces "fail before publish": the activating step
 * (`publish-parent`, or `restore-parent-active` on a re-deploy) is the last step
 * by construction, so any failed generate/import/verify step leaves it `skipped`
 * and the parent inactive. A parent that was active beforehand therefore stays
 * down after a failed deploy — reported through `parentWasActive` — rather than
 * being re-activated with content that just failed verification.
 *
 * The whole run holds the parent's deployment lock, so the activation state read
 * before the import is still the state this run is restoring afterwards, and its
 * generation and child import additionally hold the install-wide child lock, so
 * the shared artifact it imports is the one it just wrote. Either lock being
 * contended fails the deploy before its first step: another process is mid-deploy
 * of the same parent or of the same shared child, and nothing here is worth
 * racing it for.
 */
export function executeN8nDeploy(
  plan: N8nDeployPlan,
  deps: N8nDeployDeps,
): N8nDeployExecution {
  const localPaths = deps.localPaths ?? [];
  const clean = (text: string): string => sanitizeDeployText(text, localPaths);
  const contended = (reason: string, detail: string): N8nDeployExecution => ({
    ok: false,
    published: false,
    parentActiveRestored: false,
    // Nothing ran, so nothing was written and no restart is owed.
    restartRequired: false,
    steps: plan.steps.map(
      (step): N8nDeployStepResult => ({ id: step.id, label: step.label, outcome: "skipped" }),
    ),
    failure: { reason, detail: clean(detail) },
  });

  // Parent lock first: a second deploy of this same session is then refused by
  // name, rather than being told the shared child is busy. Neither acquisition
  // blocks, so the fixed order is for diagnostics, not deadlock avoidance.
  const lock = deps.acquireLock();
  if (!lock.acquired) {
    return contended(
      `another deploy of parent workflow ${plan.parent.workflowId} is already running`,
      lock.detail,
    );
  }
  try {
    const childLock = deps.acquireChildLock();
    if (!childLock.acquired) {
      return contended(
        `another deploy is generating or importing the shared child workflow ${plan.child.workflowId}`,
        childLock.detail,
      );
    }
    let childLockReleased = false;
    // Idempotent: the step loop releases as soon as the child import is behind
    // it, and the `finally` below covers the runs that never get that far.
    const releaseChildLock = (): void => {
      if (childLockReleased) return;
      childLockReleased = true;
      childLock.release();
    };
    try {
      return runN8nDeploySteps(plan, deps, clean, releaseChildLock);
    } finally {
      releaseChildLock();
    }
  } finally {
    lock.release();
  }
}

/**
 * The step loop itself, split out only so {@link executeN8nDeploy} can wrap it
 * in the locks' `try`/`finally` — every exit path, including a throwing runner
 * or artifact reader, releases both.
 */
function runN8nDeploySteps(
  plan: N8nDeployPlan,
  deps: N8nDeployDeps,
  clean: (text: string) => string,
  releaseChildLock: () => void,
): N8nDeployExecution {
  const steps: N8nDeployStepResult[] = [];
  let verification: N8nVerificationResult | undefined;
  let failure: N8nDeployExecution["failure"];
  let published = false;
  let parentWasActive: boolean | undefined;
  let parentActiveRestored = false;
  let restartRequired = false;

  // The shared child lock covers the plan up to and including `import-child`;
  // everything after it touches this session's parent alone. Located by position
  // rather than by naming the step that follows, because `check-parent-active`
  // already sits inside the window and any further step inserted into it must
  // stay covered rather than silently release the lock early.
  const lastChildLockStep = plan.steps.map((step) => step.id).lastIndexOf("import-child");

  for (const [index, step] of plan.steps.entries()) {
    // Released for skipped steps too: a run that failed at `generate` is done
    // with the shared child, and holding its lock through the rest of the loop
    // would block every other session for nothing.
    if (index > lastChildLockStep) releaseChildLock();

    if (failure !== undefined) {
      steps.push({ id: step.id, label: step.label, outcome: "skipped" });
      continue;
    }

    // Nothing to restore: the parent was inactive before the import, so the
    // artifact's `active: false` is the state it already had.
    if (step.id === "restore-parent-active" && parentWasActive !== true) {
      steps.push({
        id: step.id,
        label: step.label,
        outcome: "skipped",
        detail: "the parent workflow was not active before this deploy",
      });
      continue;
    }

    if (step.id === "verify-parent-config") {
      let raw: string;
      try {
        raw = deps.readArtifact(plan.parent.artifactPath);
      } catch (err) {
        const detail = clean(err instanceof Error ? err.message : String(err));
        steps.push({ id: step.id, label: step.label, outcome: "failed", detail });
        failure = { step: step.id, reason: "the generated parent artifact could not be read", detail };
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        const detail = clean(err instanceof Error ? err.message : String(err));
        steps.push({ id: step.id, label: step.label, outcome: "failed", detail });
        failure = { step: step.id, reason: "the generated parent artifact is not valid JSON", detail };
        continue;
      }
      const configCheck = verifyParentWorkflowConfig(parsed, {
        sessionId: plan.sessionId,
        workflowId: plan.parent.workflowId,
        workflowName: plan.parent.workflowName,
        childWorkflowId: plan.child.workflowId,
      });
      if (!configCheck.ok) {
        const detail = configCheck.problems.map(clean).join("; ");
        steps.push({ id: step.id, label: step.label, outcome: "failed", detail });
        failure = { step: step.id, reason: "parent workflow verification failed", detail };
        continue;
      }
      steps.push({ id: step.id, label: step.label, outcome: "ok" });
      continue;
    }

    // Every remaining step runs a command; `planN8nDeploy` never builds one
    // without. A future local-only step added to the plan and not to the branch
    // above must fail here rather than pass as a silent no-op, or it would
    // report a verification that never ran.
    const command = step.command;
    if (command === undefined) {
      const detail = `step ${step.id} has no command and no local check`;
      steps.push({ id: step.id, label: step.label, outcome: "failed", detail });
      failure = { step: step.id, reason: detail };
      continue;
    }
    const commandLine = clean(formatCommandLine(command));
    const result = deps.run(command);
    // Recorded without regard to the exit code, but only for a command that
    // actually started: an import or activation that failed partway still wrote
    // the database a running n8n is not re-reading, while one that never started
    // — no `n8n` on PATH, a bad `--n8n-bin` — wrote nothing at all, and telling
    // the operator to restart n8n over it would be a lie about what happened.
    if (N8N_MUTATING_STEPS.has(step.id) && commandStarted(result)) restartRequired = true;
    if (result.status !== 0) {
      const detail = clean((result.stderr || result.stdout || "").trim());
      steps.push({
        id: step.id,
        label: step.label,
        outcome: "failed",
        commandLine,
        exitCode: result.status,
        ...(detail === "" ? {} : { detail }),
      });
      failure = {
        step: step.id,
        reason: `${step.id} failed with exit code ${result.status}`,
        ...(detail === "" ? {} : { detail }),
      };
      continue;
    }

    if (step.id === "check-parent-active") {
      // `list:workflow --active=true` lists only active workflows, in the same
      // `<id>|<name>` rows. An empty listing is a legitimate answer here (no
      // workflow is active), unlike in `verify-workflows`.
      parentWasActive = parseWorkflowList(result.stdout).some(
        (entry) => entry.id === plan.parent.workflowId,
      );
      steps.push({
        id: step.id,
        label: step.label,
        outcome: "ok",
        commandLine,
        exitCode: 0,
        detail: parentWasActive
          ? "the parent workflow is active — its active state will be restored after verification"
          : "the parent workflow is not active",
      });
      continue;
    }

    if (step.id === "verify-workflows") {
      verification = verifyImportedWorkflows(parseWorkflowList(result.stdout), {
        parent: plan.parent,
        child: plan.child,
      });
      if (!verification.ok) {
        const detail = verification.problems.map(clean).join("; ");
        steps.push({ id: step.id, label: step.label, outcome: "failed", commandLine, exitCode: 0, detail });
        failure = { step: step.id, reason: "imported workflow verification failed", detail };
        continue;
      }
    }

    if (step.id === "publish-parent") published = true;
    if (step.id === "restore-parent-active") parentActiveRestored = true;
    steps.push({ id: step.id, label: step.label, outcome: "ok", commandLine, exitCode: 0 });
  }

  return {
    ok: failure === undefined,
    published,
    ...(parentWasActive === undefined ? {} : { parentWasActive }),
    parentActiveRestored,
    restartRequired,
    steps,
    ...(verification === undefined ? {} : { verification }),
    ...(failure === undefined ? {} : { failure }),
  };
}
