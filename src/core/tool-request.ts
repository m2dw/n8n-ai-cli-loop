/**
 * Tool Request handoff (issue #291).
 *
 * The implementation workflow is non-interactive: an agent cannot request
 * permission inline when it needs a command outside its allowed tool set
 * (for example `npm install <pkg>` to add a dependency). Instead the agent is
 * instructed to emit a single structured `Tool Request` block and stop. The
 * implementation handler detects that block, refuses to run the command, and
 * hands the task to a human instead of treating it as a generic failure or as
 * review feedback.
 *
 * The block format is a sentinel-delimited key/value list so it can be parsed
 * unambiguously from otherwise free-form agent stdout:
 *
 *   <<<TOOL_REQUEST>>>
 *   command: npm install left-pad
 *   reason: The fix depends on left-pad which is not yet a dependency.
 *   expected_files: package.json, package-lock.json
 *   suggested_action: dependencySync
 *   <<<END_TOOL_REQUEST>>>
 *
 * Only `command` is strictly required for a block to count as a request; the
 * remaining fields are best-effort context for the operator.
 */

export const TOOL_REQUEST_OPEN = "<<<TOOL_REQUEST>>>";
export const TOOL_REQUEST_CLOSE = "<<<END_TOOL_REQUEST>>>";

// Bounds keep a hostile or runaway agent from storing an unbounded request in
// task context or leaking a huge block into a public GitHub comment.
const MAX_COMMAND_CHARS = 500;
const MAX_REASON_CHARS = 1000;
const MAX_ACTION_CHARS = 100;
const MAX_FILE_CHARS = 200;
const MAX_FILES = 50;

/** Whether the task is blocked without the command (`required`) or the command
 * is a nicety the human may decline (`optional`). See
 * docs/tool-request-and-dependency-sync.md §2.2. */
export type ToolRequestNecessity = "required" | "optional";

export interface ToolRequest {
  /** The exact command the agent says it needs but is not allowed to run.
   * Sensitive: kept in local metadata/artifacts only, never posted verbatim to
   * a public comment (docs §2.4). Use {@link ToolRequest.displayCommand} for
   * any public surface. */
  command: string;
  /** Redacted form of {@link ToolRequest.command} safe for public display:
   * token/secret-bearing flag values and absolute paths are masked. */
  displayCommand: string;
  /** Why the command is required to complete the issue. */
  reason: string;
  /** Files the agent expects the command to change (may be empty). */
  expectedFiles: string[];
  /** Whether the task is blocked without the command. Defaults to "required". */
  necessity: ToolRequestNecessity;
  /** Operator-facing next-action hint (e.g. "dependencySync"). */
  suggestedAction?: string;
}

/**
 * Produce a public-safe display form of a Tool Request command: mask
 * token/secret/password-bearing flag values and absolute filesystem paths so the
 * exact command (which may embed credentials or host paths) is never the thing
 * posted to a public comment (docs §2.4). The exact command is retained
 * separately in local task-context metadata for an operator to run or grant.
 */
/** Root directory names whose absolute paths are redacted from public Tool
 * Request comments (mirrors the families sanitizeBody redacts). */
const ABS_PATH_ROOT =
  "private|tmp|home|Users|var|opt|run|srv|data|mnt|root|proc|sys|dev|etc|workspace|build|usr|bin|sbin|Applications|Library|System|Volumes";

export function redactCommand(command: string): string {
  return command
    // Credentials embedded in URL userinfo, e.g. `https://user:token@host`
    // (`git clone https://user:token@...`) or `https://ghp_xxx@host`. The
    // secret is NOT a flag value here, so the flag patterns below would miss it.
    // Mask the whole userinfo while keeping scheme and host for operator context.
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, "$1***@")
    // Credential-bearing HTTP header values, e.g.
    // `curl -H 'Authorization: Bearer ghp_xxx'` or `--header "X-Api-Key: SECRET"`.
    // The secret rides inside the header value (again, not a flag value), so it
    // is matched by header name and masked up to the closing quote / end.
    .replace(
      /\b((?:x-)?(?:authorization|proxy-authorization|api[-_]?key|auth[-_]?token|access[-_]?token|private[-_]?token|secret[-_]?token|amz-security-token|session[-_]?token|cookie)\s*:\s*)[^'"\s][^'"]*/gi,
      "$1***",
    )
    // Bare HTTP auth-scheme credentials anywhere (defensive backstop for forms
    // not caught above), e.g. `Bearer ghp_xxx`, `Basic dXNlcjpwYXNz`. The scheme
    // name is kept for context; the token is masked.
    .replace(/\b(Bearer|Basic|Token|Digest|Negotiate|NTLM)\s+[A-Za-z0-9\-._~+/]+=*/g, "$1 ***")
    // Leading/inline credential-bearing environment assignments, e.g.
    // `GITHUB_TOKEN=SECRET npm install` or `MYSQL_PWD=hunter2 mysql`. The spec
    // treats token-bearing environment values as sensitive (docs §2.4), so the
    // value is masked while the variable name is kept for operator context.
    // Quote-aware (like the flag patterns below): a quoted value containing
    // whitespace, e.g. `API_TOKEN="my secret token"`, is consumed through its
    // closing quote so the whole secret is masked rather than just the first
    // word. The closing quote is optional so an unterminated quote is still
    // fully masked.
    .replace(
      /(^|\s)([A-Za-z_][A-Za-z0-9_]*(?:token|password|passwd|secret|auth|apikey|api_key|key|bearer|credentials?|pwd)[A-Za-z0-9_]*=)("[^"]*"?|'[^']*'?|\S+)/gi,
      "$1$2***",
    )
    // --token=xxx, --password xxx, --api-key=xxx-style secret flags, including
    // compound names where the secret word is surrounded by other segments,
    // e.g. `--client-secret=...`, `--access-token ...`, `--secret-access-key ...`.
    // Segments may be joined with either hyphens or underscores, so common
    // underscore-style flags such as `--api_key SECRET` and `--client_secret=...`
    // are masked too. Optional leading/trailing segments are allowed around the
    // secret keyword so the value is masked regardless.
    // The value is quote-aware: a quoted value (e.g. `--password "my secret"`)
    // is consumed through its closing quote so a secret containing whitespace is
    // masked in full rather than leaving the trailing token(s) exposed. The
    // closing quote is optional so an unterminated quote is still fully masked.
    .replace(
      /(--?(?:[a-z0-9]+[-_])*(?:token|password|passwd|secret|auth|api[-_]?key|key|bearer|credentials?)(?:[-_][a-z0-9]+)*s?[=\s])("[^"]*"?|'[^']*'?|\S+)/gi,
      "$1***",
    )
    // Short password flags: `-p hunter2` / `-phunter2` (mysql/redis style).
    // Quote-aware for the same reason as the long flags above.
    .replace(/(^|\s)(-p)([=\s]?)("[^"]*"?|'[^']*'?|\S+)/g, "$1$2$3***")
    // HTTP basic-auth credentials passed curl-style as `-u user:pass` /
    // `--user user:pass` / `-uuser:pass`. The flag name is not a recognized
    // secret keyword, so the long/short flag rules above miss it, yet the
    // password rides after the first colon in the value. Keep the flag and
    // username for operator context and mask the password through the end of
    // the value. Quote-aware like the flags above. A bare value with no colon
    // (e.g. `-u root`, where curl would prompt for the password) carries no
    // secret and is left untouched.
    .replace(
      /(--user[=\s]|(?:^|\s)-u[=\s]?)("[^"]*"?|'[^']*'?|\S+)/gi,
      (match, flag: string, value: string) => {
        const quote = value[0] === '"' || value[0] === "'" ? value[0] : "";
        const inner = quote ? value.slice(1, value.endsWith(quote) ? -1 : undefined) : value;
        const colon = inner.indexOf(":");
        if (colon === -1) return match;
        return `${flag}${quote}${inner.slice(0, colon + 1)}***${quote}`;
      },
    )
    // Known opaque token formats anywhere (last-resort backstop): GitHub tokens
    // and PATs, Slack, OpenAI, AWS access keys. Catches a secret pasted as a
    // bare positional argument that no structural rule above would mask.
    .replace(
      /\b(gh[pousr]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|sk-[A-Za-z0-9]{8,}|AKIA[0-9A-Z]{16})\b/g,
      "***",
    )
    // Absolute Unix paths (mirrors the families sanitizeBody redacts).
    //
    // Quoted absolute paths first: a path inside matching quotes may legitimately
    // contain whitespace (e.g. `cat "/Users/alice/Secret Project/file"`). The
    // unquoted rule below stops at the first space, so without this a public
    // comment would expose the suffix after the space. Consume everything up to
    // the matching closing quote and redact it whole.
    .replace(
      new RegExp(`(["'])\\/(?:${ABS_PATH_ROOT})(?:\\/[^"']*)*\\1`, "g"),
      "$1<path>$1",
    )
    // Unquoted absolute paths. A backslash-escaped whitespace (e.g.
    // `/Users/alice/Secret\ Project/file`) is part of the same path, so escaped
    // characters are consumed via `\\.` rather than terminating the match at the
    // space and leaking the rest of the path.
    .replace(
      new RegExp(
        `(?<![:/\\w])\\/(?:${ABS_PATH_ROOT})(?:\\/(?:\\\\.|[^\\s'"])*)*`,
        "g",
      ),
      "<path>",
    );
}

/**
 * Captured result of a guided run, recorded on the operator response so the next
 * implementation prompt can replay what the command actually produced (issue
 * #430, redesign §4.3/§7). For a no-op verification command (build/test/lint that
 * changes nothing) this captured output is the *deliverable* — without it the
 * next pass re-derives the same uncertainty and re-emits the same request.
 *
 * The exact command may be sensitive, but its output is recorded only in the
 * local/private prompt context (never a public comment), so the bounded
 * stdout/stderr is kept verbatim for the agent.
 */
export interface ToolRequestCapturedResult {
  exitCode: number;
  /** Bounded stdout captured from the guided run (may be empty). */
  stdout?: string;
  /** Bounded stderr captured from the guided run (may be empty). */
  stderr?: string;
}

/**
 * What a guided run did with the changes (if any) the approved command produced
 * (issue #430, redesign §4.3/§8). The disposition is what the redesign separates
 * from execution: the operator drives it explicitly instead of being handed raw
 * git steps.
 *
 *   - `no-op`: the command exited zero and changed nothing (a verification
 *     command). Its {@link ToolRequestCapturedResult} is the deliverable.
 *   - `committed`: the command produced repo changes and the orchestrator
 *     committed and pushed them on the issue branch.
 *   - `discarded`: the command produced repo changes and the operator chose to
 *     revert them (the partial-diff snapshot safeguard still preserves them).
 *   - `failed`: the command exited non-zero; nothing was committed.
 */
export type ToolRequestDisposition = "no-op" | "committed" | "discarded" | "failed";

export interface ToolRequestResolution {
  /** How the handoff was closed:
   *   - `manual-done`: the operator ran the command themselves and requeued.
   *   - `reject`: the operator declined the request.
   *   - `guided-run`: the orchestrator ran the exact approved command on the
   *     operator's behalf in the low-impact execution environment (issue #430),
   *     capturing the result and taking an explicit {@link disposition}.
   *   - `grant`: legacy alias for the pre-redesign one-shot runner (issue #301);
   *     retained so historical records still replay as "the command was run". */
  action: "manual-done" | "reject" | "guided-run" | "grant";
  message?: string;
  resolvedAt: string;
  /** For `guided-run`/`grant`: the {@link hashCommand} fingerprint of the
   * executed command. */
  commandHash?: string;
  /** For `guided-run`: what happened to any changes the command produced
   * (issue #430, redesign §4.3). Absent for `manual-done`/`reject`. */
  disposition?: ToolRequestDisposition;
  /** For `guided-run`: the captured stdout/stderr/exit code of the executed
   * command (issue #430, redesign §7). Folded into the next implementation
   * prompt as continuation context — crucial for no-op verification commands. */
  capturedResult?: ToolRequestCapturedResult;
}

/**
 * Structured Tool Request metadata persisted in `task.context.toolRequest`
 * after a handoff, so an operator can inspect it later via `admin tool-request`.
 */
export interface StoredToolRequest extends ToolRequest {
  requestedBy: string;
  mode: "new" | "fix";
  requestedAt: string;
  resolved: boolean;
  resolution?: ToolRequestResolution;
  /** Set when the same (or similar) command is re-requested after the operator
   * resolved a prior request as `manual-done`. Signals that the repository state
   * still appears unchanged to the agent despite the prior manual-done resolve. */
  repeatedAfterManualDone?: boolean;
  /** Relative name (within the run's artifact dir) of a patch capturing the
   * agent's uncommitted partial implementation at handoff time, when any existed
   * (issue #379). The handoff cleanup (`git checkout -f` + `git clean -fd` +
   * `git branch -D`) would otherwise discard that work irrecoverably; the patch
   * lets an operator reapply it with `git apply`. Always a relative filename,
   * never an absolute path, and never surfaced in public comments. */
  partialDiffArtifact?: string;
  /** Set when the handoff proved there was NO implementation diff to preserve —
   * the agent emitted its Tool Request without producing any file changes (issue
   * #390). Distinguishes "patch deliberately absent because there was nothing to
   * capture" from "patch capture failed", so recovery guidance does not tell the
   * operator to look for a nonexistent `partial-implementation.patch`. */
  noPriorDiff?: boolean;
  /** Set (to a short reason) when partial-diff capture FAILED at handoff time —
   * a diff may have existed but could not be snapshotted to a patch (issue #390).
   * When this happens in new-implementation mode the handler keeps the issue
   * branch as the continuation point instead of deleting it; see
   * {@link preservedBranch}. */
  partialDiffCaptureFailed?: string;
  /** Set to the issue branch name when the handoff preserved that branch as the
   * only continuation point because patch capture failed (issue #390). The
   * partial work is committed onto this branch rather than discarded with
   * `git branch -D`. {@link preservedBranchPushed} records whether it also
   * reached origin. */
  preservedBranch?: string;
  /** Whether {@link preservedBranch} was successfully pushed to origin. When
   * false the branch lives only in the worker checkout and an operator must push
   * it before resolving the request (issue #390). */
  preservedBranchPushed?: boolean;
}

const NECESSITY_VALUES: readonly ToolRequestNecessity[] = ["required", "optional"];

function parseNecessity(value: string): ToolRequestNecessity {
  const v = value.trim().toLowerCase();
  return (NECESSITY_VALUES as readonly string[]).includes(v) ? (v as ToolRequestNecessity) : "required";
}

function bound(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

/**
 * Parse a Tool Request block out of agent stdout. Returns the parsed request,
 * or `undefined` when the output contains no valid block (the common case: the
 * agent completed its edits normally).
 *
 * When more than one block is present the LAST complete block wins — an agent
 * that echoed the instructions before emitting its real request should not be
 * misread.
 */
export function parseToolRequest(output: string): ToolRequest | undefined {
  if (!output || !output.includes(TOOL_REQUEST_OPEN)) return undefined;

  // Find the last complete open/close pair. Anchoring on the last close marker
  // (rather than the last opener) means a stray or echoed opener appearing AFTER
  // a valid block — with no matching close — does not defeat the parse: we still
  // recover the last opener that has a matching close.
  const closeIdx = output.lastIndexOf(TOOL_REQUEST_CLOSE);
  if (closeIdx === -1) return undefined;
  const openIdx = output.lastIndexOf(TOOL_REQUEST_OPEN, closeIdx - TOOL_REQUEST_OPEN.length);
  if (openIdx === -1) return undefined;

  const block = output.slice(openIdx + TOOL_REQUEST_OPEN.length, closeIdx);

  let command = "";
  let reason = "";
  let suggestedAction = "";
  let expectedFiles: string[] = [];
  let necessity: ToolRequestNecessity = "required";

  for (const rawLine of block.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const sep = line.indexOf(":");
    if (sep === -1) continue;
    const key = line.slice(0, sep).trim().toLowerCase().replace(/[\s-]+/g, "_");
    const value = line.slice(sep + 1).trim();
    if (value.length === 0) continue;
    // Ignore template placeholder values. The prompt itself contains the
    // example block (see toolRequestPromptSection) whose values are angle-bracket
    // placeholders like `<the exact command you need to run>`. An agent that
    // echoes that block without filling it in is NOT making a real request, so
    // a placeholder value must not be accepted as a real `command` (which would
    // discard the agent's edits and escalate to a human).
    if (value.startsWith("<") && value.endsWith(">")) continue;

    switch (key) {
      case "command":
        command = bound(value, MAX_COMMAND_CHARS);
        break;
      case "reason":
        reason = bound(value, MAX_REASON_CHARS);
        break;
      case "expected_files":
      case "expected_changed_files":
      case "files":
        expectedFiles = value
          .split(",")
          .map((f) => bound(f, MAX_FILE_CHARS))
          .filter((f) => f.length > 0 && f.toLowerCase() !== "unknown" && f.toLowerCase() !== "none")
          .slice(0, MAX_FILES);
        break;
      case "necessity":
      case "required_or_optional":
      case "required":
        necessity = parseNecessity(value);
        break;
      case "suggested_action":
      case "suggested_next_action":
      case "next_action":
      case "action":
      case "suggested_recovery":
      case "suggested_recovery_path":
        suggestedAction = bound(value, MAX_ACTION_CHARS);
        break;
      default:
        break;
    }
  }

  // A request is only meaningful with a command. Without one there is nothing
  // for the operator to act on, so it is not treated as a Tool Request.
  if (command.length === 0) return undefined;

  return {
    command,
    displayCommand: redactCommand(command),
    reason: reason.length > 0 ? reason : "(no reason provided)",
    expectedFiles,
    necessity,
    ...(suggestedAction.length > 0 ? { suggestedAction } : {}),
  };
}

/**
 * Normalize a Tool Request command for duplicate detection. Only trims leading
 * and trailing whitespace — internal whitespace is preserved so that commands
 * whose arguments contain meaningful spaces (e.g. `printf 'a  b' > file`) are
 * not incorrectly treated as duplicates of commands with different spacing.
 * Case is preserved — command comparison is case-sensitive.
 */
export function normalizeToolRequestCommand(command: string): string {
  return command.trim();
}

/**
 * The instruction snippet appended to implementation prompts so the agent knows
 * how to surface a disallowed command instead of silently failing or trying to
 * run it. Shared between the new-implementation and fix prompts.
 */
export function toolRequestPromptSection(): string[] {
  return [
    "## When You Need A Disallowed Command",
    "",
    "This workflow is non-interactive, so you cannot request permission inline.",
    "If completing this issue requires running a command outside your allowed tool",
    "set (for example installing a dependency with `npm install <pkg>`), do NOT try",
    "to run it and do NOT work around it. Instead stop and emit a single Tool",
    "Request block in exactly this format as the last thing in your response:",
    "",
    TOOL_REQUEST_OPEN,
    "command: <the exact command you need to run>",
    "reason: <why it is required to complete this issue>",
    "expected_files: <comma-separated files you expect it to change, or unknown>",
    "necessity: <required if the task cannot be completed without it, otherwise optional>",
    "suggested_action: <one of: dependencySync, guided-run, manual-review>",
    TOOL_REQUEST_CLOSE,
    "",
    "Only emit a Tool Request block when you are genuinely blocked by a disallowed",
    "command. Do not emit one for commands you are already allowed to run.",
  ];
}

/** Narrow a value read from `task.context.toolRequest` (typed as `unknown` once
 * it leaves the persisted JSON) into a resolved {@link StoredToolRequest}, or
 * return `undefined` when there is no request, it is unresolved, or it lacks the
 * resolution detail needed to address the agent. */
function asResolvedToolRequest(
  value: unknown,
): (StoredToolRequest & { resolution: ToolRequestResolution }) | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const stored = value as Partial<StoredToolRequest>;
  if (stored.resolved !== true) return undefined;
  const resolution = stored.resolution;
  if (typeof resolution !== "object" || resolution === null) return undefined;
  if (typeof stored.command !== "string" || stored.command.length === 0) return undefined;
  return stored as StoredToolRequest & { resolution: ToolRequestResolution };
}

/**
 * Whether `context.toolRequest` holds a live (unresolved) implementation Tool
 * Request handoff — i.e. a request has been recorded but no
 * `manual-done`/`reject`/`guided-run`/`grant` resolution has been stored yet.
 *
 * An unresolved request is authoritative over any conflicting phase routing —
 * a mistaken `admin recover` into another phase, a stale/incorrect GitHub
 * review label, or label-driven intake — until an operator resolves it through
 * the dedicated `tool-request resolve` / `tool-request grant` flows (issue
 * #677). Callers that could otherwise move a task off its current handoff must
 * check this first and refuse the transition rather than silently overriding
 * the SQLite Tool Request state.
 *
 * Reads `task.context.toolRequest` (typed as `unknown` once it leaves the
 * persisted JSON), so it can be called with a task's `context` directly.
 */
export function hasUnresolvedToolRequest(context: unknown): boolean {
  if (typeof context !== "object" || context === null) return false;
  const tr = (context as Record<string, unknown>)["toolRequest"];
  if (typeof tr !== "object" || tr === null || Array.isArray(tr)) return false;
  return (tr as { resolved?: unknown }).resolved !== true;
}

/**
 * Build the "Operator Response To Previous Tool Request" prompt section (issue
 * #422). When the implementation task is requeued after an operator resolved a
 * prior Tool Request, the next implementation prompt must replay that request
 * and the human's answer as conversational continuation — otherwise the agent,
 * seeing an unchanged repo (verification-only commands change no files), simply
 * re-emits the same request and the workflow loops.
 *
 * Returns `[]` when there is no resolved request to report, so callers can splat
 * it unconditionally. Reads the value persisted in `task.context.toolRequest`
 * (a {@link StoredToolRequest}), accepted here as `unknown` since it arrives
 * from untyped task context.
 */
export function toolRequestResolutionPromptSection(toolRequestContext: unknown): string[] {
  const stored = asResolvedToolRequest(toolRequestContext);
  if (stored === undefined) return [];

  const { resolution } = stored;
  const action = resolution.action;
  // The prompt is written locally (artifact dir) and the agent itself emitted
  // the command, so show the exact command for fidelity, falling back to the
  // redacted display form if the exact command was not persisted.
  const command = stored.command.length > 0 ? stored.command : stored.displayCommand;

  const lines: string[] = [
    "## Operator Response To Previous Tool Request",
    "",
    "You previously requested:",
    "",
    `\`${command}\``,
  ];

  const reason = typeof stored.reason === "string" ? stored.reason.trim() : "";
  if (reason.length > 0) {
    lines.push("", "Reason:", reason);
  }

  const expectedFiles = Array.isArray(stored.expectedFiles)
    ? stored.expectedFiles.filter((f): f is string => typeof f === "string" && f.trim().length > 0)
    : [];
  if (expectedFiles.length > 0) {
    lines.push("", "Expected files:", expectedFiles.join(", "));
  }

  // The disposition (issue #430) tells the agent what happened to any changes
  // the command produced, so a guided run reads as "committed" / "no repo
  // changes" / "discarded" rather than an opaque "the command ran".
  const disposition = isDisposition(resolution.disposition) ? resolution.disposition : undefined;
  const respondedLine =
    action === "guided-run" && disposition !== undefined
      ? `The operator responded: guided-run (${dispositionPhrase(disposition)})`
      : `The operator responded: ${action}`;
  lines.push("", respondedLine);

  const message = typeof resolution.message === "string" ? resolution.message.trim() : "";
  if (message.length > 0) {
    lines.push("", "Operator note:", message);
  }

  // Replay the captured command output (issue #430, redesign §7). For a no-op
  // verification command this output is the whole point of the request — it is
  // the answer the agent was missing — so it must reach the next prompt or the
  // agent simply re-emits the same verification request and the workflow loops.
  const capturedLines = capturedResultLines(resolution.capturedResult);
  if (capturedLines.length > 0) {
    lines.push("", ...capturedLines);
  }

  if (typeof resolution.resolvedAt === "string" && resolution.resolvedAt.length > 0) {
    lines.push("", `Resolved at: ${resolution.resolvedAt}`);
  }

  lines.push("");
  if (action === "reject") {
    lines.push(
      "Treat this as feedback from the human. The operator declined to run the command.",
      "Use it to decide the next implementation step.",
      "Do not repeat the same Tool Request unless you have inspected the current",
      "repository state and can explain why the operator's response was insufficient.",
    );
  } else if (disposition === "discarded") {
    // The command ran but the operator threw its changes away — usually because
    // the produced diff was wrong. Re-emitting the same request would just
    // recreate the discarded changes, so steer toward a different approach.
    lines.push(
      "Treat this as feedback from the human. The command ran, but the operator",
      "discarded the changes it produced. Re-inspect the current repository state",
      "and take a different approach rather than re-running the same command.",
      "Do not repeat the same Tool Request unless you can explain why the discarded",
      "changes were nonetheless correct.",
    );
  } else if (disposition === "no-op") {
    // A verification command: no diff to land. The captured output above is the
    // deliverable — point the agent at it explicitly.
    lines.push(
      "Treat this as the human responding to your request. The command has been run;",
      "it changed nothing, so the captured output above is the answer you were missing.",
      "Use it to continue, and do not repeat the same verification request unless you",
      "can explain what is still unresolved after that output.",
    );
  } else if (disposition === "failed") {
    // The command ran and exited non-zero (issue #678): a failing exit code is
    // diagnostic information for the agent, not a reason to stop. The captured
    // stdout/stderr above is the deliverable — point the agent at it and make
    // clear a fresh Tool Request is only warranted for a genuinely different
    // operator action, not a retry of the same failure.
    lines.push(
      "Treat this as the human responding to your request. The command was run and",
      "FAILED — see the captured exit code and output above. Diagnose the failure and",
      "either fix the underlying issue and continue implementation, or emit a new Tool",
      "Request only if a different operator action is genuinely needed. Do not simply",
      "re-request the same command expecting a different result.",
    );
  } else {
    // manual-done (operator ran it), grant/guided-run committed (orchestrator ran
    // the approved command and landed any changes) all mean the command has now
    // been executed and its effects are in the repository.
    lines.push(
      "Treat this as the human responding to your request. The command has been run.",
      "Re-inspect the current repository state and continue from there.",
      "Do not repeat the same Tool Request unless you can explain what is still",
      "inconsistent or stale after the operator response.",
    );
  }

  return lines;
}

const DISPOSITION_VALUES: readonly ToolRequestDisposition[] = [
  "no-op",
  "committed",
  "discarded",
  "failed",
];

function isDisposition(value: unknown): value is ToolRequestDisposition {
  return typeof value === "string" && (DISPOSITION_VALUES as readonly string[]).includes(value);
}

/** Human-readable phrase for the "guided-run (...)" response line. */
function dispositionPhrase(disposition: ToolRequestDisposition): string {
  switch (disposition) {
    case "no-op":
      return "no repo changes";
    case "committed":
      return "changes committed";
    case "discarded":
      return "changes discarded";
    case "failed":
      return "command failed";
  }
}

/** Maximum captured stdout/stderr replayed per stream in the continuation
 * prompt. Bounds a runaway command from flooding the next prompt; the full
 * output remains in the local run artifact. */
const MAX_CAPTURED_OUTPUT_CHARS = 4000;

function boundCaptured(text: string): string {
  const trimmed = text.replace(/\s+$/u, "");
  return trimmed.length > MAX_CAPTURED_OUTPUT_CHARS
    ? `${trimmed.slice(0, MAX_CAPTURED_OUTPUT_CHARS)}\n…(output truncated)`
    : trimmed;
}

/** Render the captured-result block for the continuation prompt, or `[]` when no
 * result was captured (e.g. manual-done / reject, which run nothing). */
function capturedResultLines(result: ToolRequestCapturedResult | undefined): string[] {
  if (result === undefined || typeof result !== "object" || result === null) return [];
  const exitCode = typeof result.exitCode === "number" ? result.exitCode : undefined;
  const stdout = typeof result.stdout === "string" ? boundCaptured(result.stdout) : "";
  const stderr = typeof result.stderr === "string" ? boundCaptured(result.stderr) : "";
  if (exitCode === undefined && stdout.length === 0 && stderr.length === 0) return [];

  const lines: string[] = [
    `Captured command output${exitCode !== undefined ? ` (exit code ${exitCode})` : ""}:`,
  ];
  if (stdout.length > 0) {
    lines.push("", "stdout:", "```", stdout, "```");
  }
  if (stderr.length > 0) {
    lines.push("", "stderr:", "```", stderr, "```");
  }
  if (stdout.length === 0 && stderr.length === 0) {
    lines.push("", "(no output)");
  }
  return lines;
}
