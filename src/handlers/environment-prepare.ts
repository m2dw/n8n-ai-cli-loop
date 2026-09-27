import { createHash } from "crypto";
import { mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "fs";
import { arch, cpus, freemem, loadavg, platform, totalmem } from "os";
import { dirname, join } from "path";
import type { CommandRunResult, CommandRunner, ProcessTreeCleanup } from "./command-runner.js";
import type { EnvironmentPrepareConfig } from "../core/session.js";
import type { DeclaredEnvironmentSource } from "../core/stage-evidence-validity.js";
import { parseShellTokens, boundVerificationOutput } from "./verification.js";

// ---------------------------------------------------------------------------
// Runner-owned environment preparation (issue #511; docs/environment-prepare-contract.md)
//
// Before a phase's agent runs, this module materialises the full runtime
// dependency tree (e.g. `npm ci` → node_modules) using the EXACT command the
// session operator configured — never one derived from agent output, issue
// text, or repository auto-detection.
//
// A prepare stamp (keyed by worktree identity, command, config, and cacheKeyFiles
// content) prevents redundant reinstalls across retries. A failed run leaves no
// stamp so the next run re-attempts. A changed lockfile (cacheKeyFile) invalidates
// the stamp and triggers a fresh prepare so verification can execute against
// the updated dependencies.
// ---------------------------------------------------------------------------

/** Fallback execution budget when a session omits `timeoutMs`. */
export const ENVIRONMENT_PREPARE_DEFAULT_TIMEOUT_MS = 120_000;

// Aligned with dependencySync: 80 MiB captures a verbose-but-successful
// install without overflowing Node's default 1 MiB execFile buffer.
export const MAX_ENVIRONMENT_PREPARE_BUFFER_BYTES = 80 * 1024 * 1024;

function sha256(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Safe-command gating (issue #511 review, P1)
//
// When allowLifecycleScripts is false (the default), the configured command
// must not trigger npm-style postinstall/install lifecycle scripts from
// agent-influenced manifests or newly-resolved dependencies.
//
// Unlike dependencySync (which uses an allowlist of lockfile-only forms), the
// broader purpose of environmentPrepare means non-npm commands (pip, cargo,
// go, echo, custom scripts) are safe by default. Only the npm/pnpm/yarn
// install-phase subcommands specifically execute package lifecycle hooks and
// must be refused unless --ignore-scripts is effectively set or the operator
// has opted in via allowLifecycleScripts: true.
// ---------------------------------------------------------------------------

/** npm/pnpm install subcommands that trigger package postinstall hooks. */
const NPM_INSTALL_SUBCOMMANDS = new Set(["ci", "install", "i", "add"]);
/** pnpm install subcommands that trigger postinstall hooks. */
const PNPM_INSTALL_SUBCOMMANDS = new Set(["install", "i", "add"]);

function effectiveBooleanFlag(args: string[], flag: string): boolean | undefined {
  const name = flag.replace(/^--/, "");
  const negFlag = `--no-${name}`;
  const parseVal = (v: string): boolean => {
    const t = v.toLowerCase();
    return !(t === "false" || t === "0" || t === "");
  };
  let value: boolean | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === flag) {
      const next = args[i + 1];
      if (next === "true" || next === "false") { value = next === "true"; i++; }
      else { value = true; }
    } else if (a.startsWith(`${flag}=`)) {
      value = parseVal(a.slice(flag.length + 1));
    } else if (a === negFlag) {
      value = false;
    } else if (a.startsWith(`${negFlag}=`)) {
      value = !parseVal(a.slice(negFlag.length + 1));
    }
  }
  return value;
}

/**
 * Scans `args` past global option flags to find the first positional argument
 * (the subcommand). Flags of the form `--flag=value` or `-f=value` are
 * consumed in-place and skipped. Bare flags without `=` (e.g. `--prefix`)
 * may consume the following argument as their value; since we cannot determine
 * this without a complete global-options table, we return `undefined`
 * conservatively so the caller can refuse the ambiguous form.
 */
function findSubcommand(args: string[]): string | undefined {
  for (const a of args) {
    if (!a.startsWith("-")) {
      return a; // first positional argument is the subcommand
    }
    if (!a.includes("=")) {
      // bare --flag: next arg could be its value; stop rather than guess
      return undefined;
    }
    // --flag=value: value is inline, safe to skip
  }
  return undefined;
}

/**
 * Returns true when `cmd`/`args` is an npm/pnpm/yarn install-phase subcommand
 * that executes package lifecycle scripts (postinstall, etc.) without an
 * effective `--ignore-scripts` flag. Other commands — including non-npm
 * package managers, project-build tools, and harmless test shims — return
 * false and are allowed in safe mode.
 *
 * When global flags appear before the subcommand (e.g. `npm --prefix frontend
 * ci` or `pnpm --dir app install`) and the subcommand cannot be resolved
 * unambiguously, the function returns true conservatively so that the safe-mode
 * gate blocks the command unless `--ignore-scripts` is present.
 */
function isLifecycleRunningNpmInstall(cmd: string, args: string[]): boolean {
  const sub = findSubcommand(args);
  if (cmd === "npm") {
    // sub===undefined means global options prevented resolution; treat as
    // potentially install-phase (conservative refusal).
    if (sub === undefined || NPM_INSTALL_SUBCOMMANDS.has(sub)) {
      return effectiveBooleanFlag(args, "--ignore-scripts") !== true;
    }
  }
  if (cmd === "pnpm") {
    if (sub === undefined || PNPM_INSTALL_SUBCOMMANDS.has(sub)) {
      return effectiveBooleanFlag(args, "--ignore-scripts") !== true;
    }
  }
  // `yarn` / `yarn install` both run lifecycle scripts; yarn has no standard
  // --ignore-scripts for the install phase that is reliably honoured.
  if (cmd === "yarn" && (sub === undefined || sub === "install")) {
    return effectiveBooleanFlag(args, "--ignore-scripts") !== true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Worktree-lifetime sentinel (issue #511 review, P2)
//
// The artifact-root stamp survives a worktree prune + recreate at the same
// path, but the prepared outputs (e.g. node_modules) are deleted with the
// worktree. A sentinel written into the worktree-specific git dir is pruned
// along with the worktree, so a recreated checkout loses its sentinel and the
// prepare re-runs even though the artifact-root stamp still matches.
//
// In a git worktree, <cwd>/.git is a file with "gitdir: <path>"; in the
// canonical repo it is a directory. Either way, reading it gives us a
// per-checkout location that is automatically cleaned up by `git worktree
// remove` / `git worktree prune`.
// ---------------------------------------------------------------------------

function resolveGitDir(cwd: string): string {
  const gitEntry = join(cwd, ".git");
  try {
    const s = statSync(gitEntry);
    if (s.isDirectory()) return gitEntry;
    const content = readFileSync(gitEntry, "utf8").trim();
    const match = /^gitdir:\s*(.+)$/.exec(content);
    if (match) {
      const resolved = match[1].trim();
      return resolved.startsWith("/") ? resolved : join(cwd, resolved);
    }
  } catch {
    // Fallback: assume canonical .git directory.
  }
  return gitEntry;
}

function sentinelPath(cwd: string): string {
  return join(resolveGitDir(cwd), "ai-env-prepared");
}

function isSentinelValid(cwd: string, stampKey: string): boolean {
  try {
    return readFileSync(sentinelPath(cwd), "utf8").trim() === stampKey;
  } catch {
    return false;
  }
}

function writeSentinel(cwd: string, stampKey: string): void {
  try {
    const p = sentinelPath(cwd);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, stampKey, "utf8");
  } catch {
    // Best-effort: a failed write means the next run will re-prepare.
  }
}

/**
 * Stable hash of the full environmentPrepare config block. Any config change
 * (e.g. adding a cacheKeyFile, toggling allowLifecycleScripts) invalidates the
 * stamp and triggers a fresh prepare on the next call.
 */
function computeConfigHash(config: EnvironmentPrepareConfig): string {
  const normalized = JSON.stringify({
    enabled: config.enabled,
    command: config.command,
    cacheKeyFiles: config.cacheKeyFiles ? [...config.cacheKeyFiles].sort() : [],
    allowLifecycleScripts: config.allowLifecycleScripts ?? false,
    timeoutMs: config.timeoutMs ?? ENVIRONMENT_PREPARE_DEFAULT_TIMEOUT_MS,
  });
  return sha256(normalized);
}

/**
 * Combined hash of all configured cacheKeyFiles content. A lockfile change
 * (e.g. package-lock.json regenerated by dependency sync) changes this hash
 * and invalidates the stamp. Missing files contribute an empty string so a
 * fresh worktree without a lockfile is still stampable.
 */
function computeCacheKeyFilesHash(cwd: string, cacheKeyFiles: string[] | undefined): string {
  if (!cacheKeyFiles || cacheKeyFiles.length === 0) return sha256("");
  const parts: string[] = [];
  for (const file of cacheKeyFiles) {
    try {
      parts.push(readFileSync(join(cwd, file), "utf8"));
    } catch {
      parts.push(""); // file absent → empty string contribution
    }
  }
  return sha256(parts.join("\0"));
}

interface PrepareStamp {
  worktreeIdentity: string;
  commandHash: string;
  configHash: string;
  cacheKeyFilesHash: string;
  succeededAt: string;
}

function stampDir(artifactRoot: string): string {
  return join(artifactRoot, "environment-prepare-stamps");
}

function stampFilePath(artifactRoot: string, identityHash: string): string {
  return join(stampDir(artifactRoot), `${identityHash}.json`);
}

function readStamp(artifactRoot: string, identityHash: string): PrepareStamp | undefined {
  try {
    return JSON.parse(readFileSync(stampFilePath(artifactRoot, identityHash), "utf8")) as PrepareStamp;
  } catch {
    return undefined;
  }
}

function writeStamp(artifactRoot: string, identityHash: string, stamp: PrepareStamp): void {
  try {
    mkdirSync(stampDir(artifactRoot), { recursive: true });
    writeFileSync(stampFilePath(artifactRoot, identityHash), JSON.stringify(stamp, null, 2), "utf8");
  } catch {
    // Best-effort: a failed stamp write means the next run will re-prepare.
  }
}

// ---------------------------------------------------------------------------
// Stop-reason classification (issue #1060)
//
// A prepare run that is killed on its deadline and one that runs to completion
// and reports a broken dependency tree are different problems with different
// fixes, and before this they were the same `exit 1` carrying whatever the
// command had printed so far. That made a timed-out `npm ci` look like a package
// manager failure, and pointed the operator at the npm deprecation warnings that
// happened to be the tail of the captured output rather than at the deadline.
//
// The reason is therefore classified once, here, and the same classified
// sentence reaches every surface: the run artifact, `task.lastError` (hence
// `admin status`), and the public failure comment.
// ---------------------------------------------------------------------------

/** Why a prepare run stopped. `command-failed` is the only one the command itself chose. */
export type EnvironmentPrepareStopReason =
  /** The command ran to completion and exited non-zero — a real command failure. */
  | "command-failed"
  /** `timeoutMs` expired and the runner killed the command. */
  | "timeout"
  /** The command was terminated by a signal (OOM killer, operator, supervisor). */
  | "signal"
  /** The command never ran: the binary was missing, unexecutable, or the host could not fork. */
  | "spawn-error"
  /** Safe mode refused the command before anything was spawned (see `isLifecycleRunningNpmInstall`). */
  | "refused";

/** Bound on the runner-synthesized diagnostic carried out of a prepare failure. */
export const MAX_ENVIRONMENT_PREPARE_DIAGNOSTIC_CHARS = 500;

/** Bound on the command-output excerpt carried into `lastError` / the failure comment. */
export const MAX_ENVIRONMENT_PREPARE_ERROR_OUTPUT_CHARS = 500;

export interface EnvironmentPrepareOutcome {
  /** `skipped` = stamp matched or config disabled; `ran` = command succeeded; `failed` = command failed. */
  status: "skipped" | "ran" | "failed";
  /**
   * Present when the command ran (ran or failed).
   *
   * For every `stopReason` other than `command-failed` this is the RUNNER's
   * stand-in for a process that never reported a status of its own, so it must
   * not be presented as something the command said — read `stopReason` first.
   */
  exitCode?: number;
  /** Bounded combined stdout+stderr when the command ran. */
  output?: string;
  /** Why the run stopped. Present on every `failed` outcome. */
  stopReason?: EnvironmentPrepareStopReason;
  /**
   * The classified stop reason as one operator-facing clause, with no local
   * paths or command output in it, so it is safe on a public comment. This is
   * the string every surface renders; see {@link environmentPrepareFailureMessage}.
   */
  stopSummary?: string;
  /** The deadline that was in force, so a timeout can be read against it. */
  timeoutMs?: number;
  /** Wall-clock milliseconds the command occupied. */
  durationMs?: number;
  /** Set when the runner killed the command on its deadline. */
  timedOut?: boolean;
  /**
   * Set when the command ignored the deadline's termination signal and had to be
   * force-killed by the runner's external watchdog — the difference between a
   * command that stopped when asked and one that had to be taken down.
   */
  deadlineEscalated?: boolean;
  /** The signal that terminated the command, when one did. */
  signal?: string;
  /** Errno of a spawn-level failure (`ETIMEDOUT`, `ENOENT`, `ENOBUFS`, …). */
  spawnErrorCode?: string;
  /** Bounded runner-synthesized spawn diagnostic — bytes the command never wrote. */
  spawnError?: string;
  /** What the runner did about the command's surviving child processes. */
  processTreeCleanup?: ProcessTreeCleanup;
}

/**
 * Classify a failed prepare run, most-determinate first.
 *
 * `timeout` precedes `signal` and `spawn-error` because a deadline kill IS all
 * three at the OS level — an `ETIMEDOUT` errno on a child killed with `SIGTERM`
 * — and the deadline is the fact the operator needs. `command-failed` is the
 * fallback, so an unrecognised shape stays the plain command failure it already
 * was rather than being upgraded into a scarier claim.
 */
export function classifyEnvironmentPrepareStop(
  result: Pick<
    CommandRunResult,
    "timedOut" | "deadlineEscalated" | "spawnErrorCode" | "spawnError" | "signal"
  >,
): EnvironmentPrepareStopReason {
  // A watchdog escalation is proof the deadline elapsed with the command still
  // running, so it decides the reason on its own — the `SIGKILL` it had to use
  // must not be read back as an ordinary signal termination.
  if (result.timedOut === true || result.deadlineEscalated === true) return "timeout";
  if (result.spawnErrorCode !== undefined) return "spawn-error";
  if (typeof result.signal === "string" && result.signal !== "") return "signal";
  if (result.spawnError !== undefined) return "spawn-error";
  return "command-failed";
}

function summarizeStop(
  reason: EnvironmentPrepareStopReason,
  facts: {
    exitCode?: number;
    timeoutMs?: number;
    durationMs?: number;
    signal?: string;
    spawnErrorCode?: string;
    deadlineEscalated?: boolean;
    processTreeCleanup?: ProcessTreeCleanup;
  },
): string {
  const elapsed = facts.durationMs === undefined ? "" : `, elapsed ${facts.durationMs} ms`;
  const killedWith = facts.signal === undefined ? "" : `, killed with ${facts.signal}`;
  const escalated = facts.deadlineEscalated
    ? ", force-killed after it ignored the deadline's termination signal"
    : "";
  const tree = facts.processTreeCleanup;
  const swept = tree?.terminatedDescendants.length ?? 0;
  // Three states, not two: a sweep that was REFUSED must not render as one that
  // found nothing to do, or the operator reads "cleanup done" for processes that
  // are still running and still holding the locks the next attempt will block on
  // (issue #1060 review, P2).
  const groupCleanup = tree?.processGroupTerminated
    ? "process group terminated"
    : tree?.processGroupSignalError !== undefined
      ? `process group could NOT be terminated (${tree.processGroupSignalError}); processes may still be running`
      : "no process group to terminate";
  const cleanup =
    tree === undefined
      ? ""
      : "; process tree cleanup: " +
        groupCleanup +
        (swept > 0 ? `, ${swept} surviving descendant process(es) terminated` : "");
  switch (reason) {
    case "timeout":
      return `timed out after ${facts.timeoutMs ?? "?"} ms (deadline reached${elapsed}${killedWith}${escalated}${cleanup})`;
    case "signal":
      return `was terminated by signal ${facts.signal ?? "?"} before it could exit (elapsed ${
        facts.durationMs ?? "?"
      } ms${cleanup})`;
    case "spawn-error":
      // ENOBUFS is the one spawn-level errno that means the command DID start —
      // it outgrew the runner's capture buffer and was killed for it. Saying
      // "could not be started" there would send the operator looking for a
      // missing binary.
      return facts.spawnErrorCode === "ENOBUFS"
        ? `wrote more output than the runner's capture buffer allows (ENOBUFS)`
        : `could not be started (${facts.spawnErrorCode ?? "spawn error"})`;
    case "refused":
      return "was refused before it ran";
    case "command-failed":
      return `failed (exit ${facts.exitCode ?? 1})`;
  }
}

/**
 * The one failure sentence every surface renders (issue #1060).
 *
 * Shared rather than formatted per call site so `task.lastError`, `admin status`
 * and the public GitHub comment cannot disagree about why a prepare run stopped
 * — they all read this string. The command output is appended, but for any stop
 * the command did not choose it is labelled as what it is: the partial bytes
 * printed before the stop, not the cause. Without that label a timed-out
 * `npm ci` reads as an npm failure whose cause is the last deprecation warning
 * it happened to print.
 *
 * @param stage Optional parenthetical naming which prepare call this was
 *              (`after dependency sync`, `before review verification`).
 */
export function environmentPrepareFailureMessage(
  outcome: EnvironmentPrepareOutcome,
  stage?: string,
): string {
  const scope = stage === undefined ? "" : ` (${stage})`;
  const summary = outcome.stopSummary ?? summarizeStop("command-failed", { exitCode: outcome.exitCode });
  const excerpt = (outcome.output ?? "").slice(0, MAX_ENVIRONMENT_PREPARE_ERROR_OUTPUT_CHARS);
  if (excerpt === "") return `Environment preparation${scope} ${summary}.`;
  const label =
    outcome.stopReason === undefined || outcome.stopReason === "command-failed" || outcome.stopReason === "refused"
      ? ":"
      : ". Partial output captured before the stop (not the cause):";
  return `Environment preparation${scope} ${summary}${label} ${excerpt}`;
}

// ---------------------------------------------------------------------------
// Runner-context diagnostics (issue #1060)
//
// The reproduction that motivated this had `npm ci` finish in ~10 s when run by
// hand in the very same worktree and hit a 5-minute deadline under the runner,
// three times. Nothing in the artifacts could distinguish the two executions, so
// the investigation had nowhere to start. This block records the parts of the
// execution context that plausibly differ between "an operator's shell" and
// "inside the n8n/runner process tree": host pressure at the moment of the run,
// which process was the parent, and which package-manager environment variables
// were in force.
//
// Names only for the environment — never values. A package-manager env var is
// exactly where a registry token lives (`NPM_CONFIG__AUTH`, `NPM_TOKEN`), and
// this artifact is written on a failure path an operator will be reading.
// ---------------------------------------------------------------------------

/** Cap on the env-var names recorded, so an unusual host cannot grow the artifact. */
const MAX_RECORDED_ENV_NAMES = 60;

/** Env vars that plausibly change how a package manager behaves. Matched on NAME only. */
const EXECUTION_ENV_NAME_PATTERN =
  /^(npm_|NPM_|YARN_|PNPM_|NODE_|COREPACK_|CI$|HOME$|PATH$|TMPDIR$|HTTP_PROXY$|HTTPS_PROXY$|NO_PROXY$)/i;

export interface EnvironmentPrepareRunnerContext {
  /** The exact command string the operator configured. Local artifact only. */
  command: string;
  /** Where it ran. Local artifact only — never posted to a public comment. */
  cwd: string;
  timeoutMs: number;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  /** The prepare command's own pid, when the runner reported one. */
  pid?: number;
  /** The runner process, and what spawned it — a CLI shell vs the n8n worker. */
  runnerPid: number;
  runnerParentPid: number;
  nodeVersion: string;
  platform: string;
  arch: string;
  cpuCount: number;
  /** 1/5/15-minute load averages at the moment the run finished. Zeroes on Windows. */
  loadAverage: number[];
  freeMemBytes: number;
  totalMemBytes: number;
  /** Names (never values) of the package-manager-relevant env vars in force. */
  executionEnvNames: string[];
}

function captureRunnerContext(input: {
  command: string;
  cwd: string;
  timeoutMs: number;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  pid?: number;
}): EnvironmentPrepareRunnerContext {
  const executionEnvNames = Object.keys(process.env)
    .filter((name) => EXECUTION_ENV_NAME_PATTERN.test(name))
    .sort()
    .slice(0, MAX_RECORDED_ENV_NAMES);
  return {
    command: input.command,
    cwd: input.cwd,
    timeoutMs: input.timeoutMs,
    startedAt: new Date(input.startedAt).toISOString(),
    finishedAt: new Date(input.finishedAt).toISOString(),
    durationMs: input.durationMs,
    ...(input.pid === undefined ? {} : { pid: input.pid }),
    runnerPid: process.pid,
    runnerParentPid: process.ppid,
    nodeVersion: process.version,
    platform: platform(),
    arch: arch(),
    cpuCount: cpus().length,
    loadAverage: loadavg(),
    freeMemBytes: freemem(),
    totalMemBytes: totalmem(),
    executionEnvNames,
  };
}

export interface EnsureEnvironmentPreparedOptions {
  /** Session's environmentPrepare config block; `undefined` or `enabled: false` → no-op. */
  config: EnvironmentPrepareConfig | undefined;
  /** Working directory for the prepare command (worktree path in worktree mode; canonicalRoot in shared mode). */
  cwd: string;
  /**
   * Stable identity for this execution context. In worktree mode this is the
   * worktree path (stable for the duration of the issue); in shared mode it is
   * the canonical repo root. Used as the per-identity stamp key — each worktree
   * maintains its own stamp so a new worktree always runs prepare on first use.
   */
  worktreeIdentity: string;
  /** Session-level artifact root (for persistent stamp storage, survives across runs). */
  artifactRoot: string;
  /** Run-specific artifact dir (for the per-run `environment-prepare-result.json`). */
  artifactDir: string;
  runner: CommandRunner;
}

/**
 * Run the session's `environmentPrepare` command when enabled and not already
 * stamped for this worktree + config + cacheKeyFiles combination. An `undefined`
 * or disabled config is a no-op that returns `{ status: "skipped" }`, so the
 * call site stays unconditional.
 *
 * Stamp semantics: a successful run writes a persistent stamp keyed by
 * `worktreeIdentity`, `commandHash`, `configHash`, and `cacheKeyFilesHash`.
 * Subsequent calls with the same key return `{ status: "skipped" }` without
 * spawning a process. A changed cacheKeyFile (e.g. `package-lock.json` updated
 * by dependency sync) computes a different `cacheKeyFilesHash` and causes a
 * fresh prepare run. A failed run leaves no stamp so the next attempt retries.
 *
 * Failure semantics: a nonzero exit fails closed — the outcome is returned so
 * the caller can surface it as a phase failure rather than silently continuing
 * with a broken dependency tree.
 */
export function ensureEnvironmentPrepared(
  opts: EnsureEnvironmentPreparedOptions,
): EnvironmentPrepareOutcome {
  const { config, cwd, worktreeIdentity, artifactRoot, artifactDir, runner } = opts;

  if (!config || !config.enabled) {
    return { status: "skipped" };
  }

  const identityHash = sha256(worktreeIdentity);
  const commandHash = sha256(config.command.trim().replace(/\s+/g, " "));
  const configHash = computeConfigHash(config);
  const cacheKeyFilesHash = computeCacheKeyFilesHash(cwd, config.cacheKeyFiles);

  // Combined key used for the worktree-lifetime sentinel (issue #511 review, P2).
  // The sentinel lives in the worktree-specific git dir so it is pruned when the
  // worktree is removed or recreated, forcing a fresh prepare in the new checkout.
  const stampKey = sha256([worktreeIdentity, commandHash, configHash, cacheKeyFilesHash].join("|"));

  // Check existing stamp — skip if all four key components match AND the
  // worktree-lifetime sentinel is still present (guards against worktree prune +
  // recreate at the same path, which leaves the artifact-root stamp intact but
  // deletes node_modules / the sentinel along with the old worktree directory).
  const existing = readStamp(artifactRoot, identityHash);
  if (
    existing !== undefined &&
    existing.worktreeIdentity === worktreeIdentity &&
    existing.commandHash === commandHash &&
    existing.configHash === configHash &&
    existing.cacheKeyFilesHash === cacheKeyFilesHash &&
    isSentinelValid(cwd, stampKey)
  ) {
    try {
      writeFileSync(
        join(artifactDir, "environment-prepare-result.json"),
        JSON.stringify({ outcome: "skip", stamp: existing }, null, 2),
        "utf8",
      );
    } catch {
      // Best-effort artifact write; skip outcome is still returned.
    }
    return { status: "skipped" };
  }

  const [cmd, ...args] = parseShellTokens(config.command);
  if (!cmd) {
    // Empty/whitespace-only command is treated as a no-op, not a failure.
    return { status: "skipped" };
  }

  // Safe mode (issue #511 review, P1): when allowLifecycleScripts is false (the
  // default), the command must not run npm-style postinstall/install scripts.
  // The agent may have edited manifests and dependency sync may have updated the
  // lockfile, so a lifecycle-running command (e.g. bare `npm ci`) would execute
  // install scripts from agent-influenced dependencies — re-opening the arbitrary-
  // code-execution path the narrow agent allowedTools set exists to close.
  // Non-npm commands (pip, go, cargo, echo, custom scripts) are allowed as-is.
  // Set allowLifecycleScripts: true to run npm/pnpm/yarn install without --ignore-scripts.
  if (!config.allowLifecycleScripts && isLifecycleRunningNpmInstall(cmd, args)) {
    const output =
      `Environment prepare command ${JSON.stringify(config.command)} runs npm/pnpm/yarn ` +
      `lifecycle scripts (postinstall hooks) from agent-influenced dependencies. ` +
      `In safe mode (allowLifecycleScripts unset or false) this is refused: use ` +
      `\`--ignore-scripts\` (e.g. \`npm ci --ignore-scripts\`) to suppress lifecycle ` +
      `scripts, or set environmentPrepare.allowLifecycleScripts: true to explicitly ` +
      `accept the risk.`;
    try {
      writeFileSync(
        join(artifactDir, "environment-prepare-result.json"),
        JSON.stringify({
          outcome: "refused",
          kind: "unsafe-command",
          stopReason: "refused" satisfies EnvironmentPrepareStopReason,
          output,
          worktreeIdentity,
          commandHash,
          configHash,
          cacheKeyFilesHash,
        }, null, 2),
        "utf8",
      );
    } catch {
      // Best-effort.
    }
    return {
      status: "failed",
      exitCode: 0,
      output,
      stopReason: "refused",
      stopSummary: summarizeStop("refused", {}),
    };
  }

  const timeoutMs = config.timeoutMs ?? ENVIRONMENT_PREPARE_DEFAULT_TIMEOUT_MS;
  const startedAt = Date.now();
  const result = runner.run(cmd, args, {
    cwd,
    timeout: timeoutMs,
    maxBuffer: MAX_ENVIRONMENT_PREPARE_BUFFER_BYTES,
    // A prepare command is a process TREE — `npm ci` forks a fetch pool, other
    // package managers start daemons. Killing only the direct child on the
    // deadline strands those descendants: they keep running, keep holding the
    // package-manager cache locks the retry will block on, and are invisible to
    // the next run (issue #1060).
    isolateProcessGroup: true,
  });
  const finishedAt = Date.now();
  // Prefer the runner's own measurement (it brackets the spawn itself); fall
  // back to ours so a stubbed runner still yields a duration.
  const durationMs = result.durationMs ?? finishedAt - startedAt;

  const output = boundVerificationOutput(
    [result.stdout, result.stderr].filter(Boolean).join("\n"),
  );

  if (result.exitCode !== 0) {
    const stopReason = classifyEnvironmentPrepareStop(result);
    const facts = {
      exitCode: result.exitCode,
      timeoutMs,
      durationMs,
      ...(result.signal === undefined ? {} : { signal: result.signal }),
      ...(result.spawnErrorCode === undefined ? {} : { spawnErrorCode: result.spawnErrorCode }),
      ...(result.deadlineEscalated === true ? { deadlineEscalated: true } : {}),
      ...(result.processTreeCleanup === undefined
        ? {}
        : { processTreeCleanup: result.processTreeCleanup }),
    };
    const failure: EnvironmentPrepareOutcome = {
      status: "failed",
      output,
      stopReason,
      stopSummary: summarizeStop(stopReason, facts),
      // `facts` carries exitCode (plus timeout/signal/spawn diagnostics) so the
      // artifact and the outcome cannot disagree.
      ...facts,
      ...(result.timedOut === true ? { timedOut: true } : {}),
      ...(result.spawnError === undefined
        ? {}
        : { spawnError: result.spawnError.slice(0, MAX_ENVIRONMENT_PREPARE_DIAGNOSTIC_CHARS) }),
    };
    try {
      writeFileSync(
        join(artifactDir, "environment-prepare-result.json"),
        JSON.stringify({
          outcome: "failed",
          exitCode: result.exitCode,
          stopReason,
          stopSummary: failure.stopSummary,
          timedOut: result.timedOut === true,
          deadlineEscalated: result.deadlineEscalated === true,
          signal: result.signal ?? null,
          spawnErrorCode: result.spawnErrorCode ?? null,
          spawnError: failure.spawnError ?? null,
          timeoutMs,
          durationMs,
          processTreeCleanup: result.processTreeCleanup ?? null,
          runnerContext: captureRunnerContext({
            command: config.command,
            cwd,
            timeoutMs,
            startedAt,
            finishedAt,
            durationMs,
            ...(result.pid === undefined ? {} : { pid: result.pid }),
          }),
          output,
          worktreeIdentity,
          commandHash,
          configHash,
          cacheKeyFilesHash,
        }, null, 2),
        "utf8",
      );
    } catch {
      // Best-effort.
    }
    // No stamp written on failure — next run retries.
    return failure;
  }

  // Success: persist the stamp so the next call with the same key is a no-op.
  const stamp: PrepareStamp = {
    worktreeIdentity,
    commandHash,
    configHash,
    cacheKeyFilesHash,
    succeededAt: new Date().toISOString(),
  };
  writeStamp(artifactRoot, identityHash, stamp);
  // Write the worktree-lifetime sentinel (issue #511 review, P2). This lives in
  // the worktree-specific git dir so it is pruned when the worktree is removed or
  // recreated, ensuring the prepare re-runs in the new checkout even when the
  // artifact-root stamp still matches.
  writeSentinel(cwd, stampKey);

  try {
    writeFileSync(
      join(artifactDir, "environment-prepare-result.json"),
      // `durationMs` rides along on success too: the reproduction behind issue
      // #1060 is a command that finishes in seconds by hand and minutes under the
      // runner, and that comparison needs a successful run's timing to compare
      // against, not only the failures.
      JSON.stringify({ outcome: "run", exitCode: 0, durationMs, output, stamp }, null, 2),
      "utf8",
    );
  } catch {
    // Best-effort.
  }

  return { status: "ran", exitCode: 0, output, durationMs, timeoutMs };
}

/**
 * The prepare stamp of the last successful prepare in this worktree, as the
 * `environmentIdentity` component's declared source (#1096 §4.5). Reads only;
 * never runs the prepare.
 *
 * `absent` when no prepare is declared. A declared prepare whose stamp is
 * missing, no longer matches the current command/config/cacheKeyFiles, or whose
 * worktree-lifetime sentinel is gone is `unreadable` — the installed state the
 * stamp stood for cannot be vouched for. The value moves with every successful
 * prepare, so a re-prepare between two reads compares unequal.
 */
export function readCurrentPrepareStamp(
  opts: Pick<EnsureEnvironmentPreparedOptions, "config" | "cwd" | "worktreeIdentity" | "artifactRoot">,
): DeclaredEnvironmentSource {
  const { config, cwd, worktreeIdentity, artifactRoot } = opts;
  if (!config || !config.enabled || parseShellTokens(config.command).length === 0) {
    return { state: "absent" };
  }
  const commandHash = sha256(config.command.trim().replace(/\s+/g, " "));
  const configHash = computeConfigHash(config);
  const cacheKeyFilesHash = computeCacheKeyFilesHash(cwd, config.cacheKeyFiles);
  const stampKey = sha256([worktreeIdentity, commandHash, configHash, cacheKeyFilesHash].join("|"));
  const existing = readStamp(artifactRoot, sha256(worktreeIdentity));
  if (existing === undefined) return { state: "unreadable", reason: "prepare_stamp_missing" };
  if (
    existing.worktreeIdentity !== worktreeIdentity ||
    existing.commandHash !== commandHash ||
    existing.configHash !== configHash ||
    existing.cacheKeyFilesHash !== cacheKeyFilesHash ||
    typeof existing.succeededAt !== "string"
  ) {
    return { state: "unreadable", reason: "prepare_stamp_stale" };
  }
  if (!isSentinelValid(cwd, stampKey)) return { state: "unreadable", reason: "prepare_sentinel_missing" };
  return { state: "declared", value: sha256(`${stampKey}|${existing.succeededAt}`) };
}

/**
 * Deletes the worktree-lifetime sentinel so the next `ensureEnvironmentPrepared`
 * call re-runs the prepare command regardless of the artifact-root stamp. Call
 * this after a `git clean -fd` or similar operation that may have removed
 * prepare-materialised files (e.g. node_modules) from a path not covered by
 * .gitignore, so the stamp reflects the actual state of the checkout.
 */
export function clearPrepareSentinel(cwd: string): void {
  try {
    unlinkSync(sentinelPath(cwd));
  } catch {
    // Best-effort: missing sentinel or permission error is harmless — the next
    // prepare call will re-run anyway when isSentinelValid returns false.
  }
}
