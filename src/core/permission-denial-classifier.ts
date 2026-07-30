// ---------------------------------------------------------------------------
// Headless agent permission-denial classifier (issue #804, first slice of #802)
//
// A headless Gemini/Antigravity run can be *soft-denied*: the CLI asks for a
// tool permission it cannot obtain non-interactively, gives up on that tool
// call, and still exits 0 with empty stdout. Seen only through the process
// result, that is indistinguishable from "the agent produced nothing"
// (`empty-output`), even though the actionable cause — a denied read/search or
// a denied command/process operation — was written to the CLI's own local
// diagnostics. This module turns that diagnostic into a distinct, structured
// classification so the operator sees *why* the run produced nothing.
//
// Provenance (docs/phase-contracts.md "Agent Diagnostic Provenance and Retry
// Classification"): like the quota classifier, this consumes only an
// `AgentFailureDiagnostic` that a provider adapter has already vetted — never
// raw stdout. An agent can quote the phrase "permission denied" inside a
// transcript, diff, or test fixture just as easily as a CLI can emit it, so
// text matching is only performed against the bounded, provider-owned channel
// the adapter established. When no adapter vouches for the invocation (e.g.
// `ANTIGRAVITY_BIN` points at an operator-supplied wrapper), no diagnostic is
// produced and the run keeps its existing classification.
//
// This module only *diagnoses*. It grants no permission, relaxes no policy,
// and adds no execution path (explicitly out of scope for #804).
// ---------------------------------------------------------------------------

import type { AgentDiagnosticSource, AgentFailureDiagnostic } from "./agent-diagnostics.js";

/**
 * Which class of operation the denial applies to.
 *
 * - `read` — a repository read/search operation (file read, directory listing,
 *   glob/grep) was denied.
 * - `command` — a command/process operation (shell command, subprocess) was
 *   denied.
 * - `unspecified` — a denial was detected but the diagnostic does not support
 *   the read-vs-command distinction (no operation token, or evidence for both).
 *   Deliberately not guessed: an operator reading a wrong operation class is
 *   worse than one reading "unspecified".
 */
export type DeniedOperationClass = "read" | "command" | "unspecified";

/**
 * Denial phrasing shared across CLIs. Kept conservative for the same reason
 * the quota signals are: a false positive re-labels an ordinary empty run as a
 * permission problem and sends the operator after a policy that is fine. Only
 * phrases that state a permission/approval outcome are listed — POSIX errno
 * prose such as "operation not permitted" is deliberately excluded because an
 * ordinary filesystem error would match it.
 */
const GENERIC_DENIAL_SIGNALS: string[] = [
  "permission denied",
  "permission_denied",
  "permission-denied",
  "permissiondenied",
  "access denied",
  "denied by policy",
  "denied by the user",
  "user denied",
  "operation denied",
  "request denied",
  "requires approval",
  "approval required",
  "requires permission",
  "permission required",
  "not permitted by",
  "no permission to",
  "lacks permission",
  "missing permission",
  "without permission",
  "blocked by permission",
  "not allowed by",
];

/**
 * Agent-specific denial phrasing layered on top of the generic set. Kept
 * deliberately small: an entry here should be wording that unambiguously states
 * a refusal for that CLI. Help text that merely mentions permissions ("add a
 * permission rule to allow this tool") is not listed — it can accompany a
 * denial, but it can equally appear in ordinary startup output, and matching it
 * would re-label unproductive runs as permission problems.
 */
const AGENT_DENIAL_SIGNALS: Partial<Record<string, string[]>> = {
  gemini: ["tool call denied", "not in the allowed tools"],
};

// Operation tokens are matched against the denial's own evidence window only
// (see `evidenceWindow`), not the whole diagnostic, so an unrelated mention
// elsewhere in the capture cannot mislabel the denial.
//
// They are split into two tiers because a diagnostic line commonly quotes the
// *arguments* of the rejected call alongside its name — `run_shell_command
// "grep -rn foo": permission denied` mentions both a command tool and the word
// "grep". Tier 1 is the identifier of the tool that was actually rejected; tier
// 2 is prose and bare command words that can just as easily come from inside
// those arguments. When tier 1 matches, it decides alone (see
// `classifyOperation`), so a denied shell command keeps the actionable
// `command` class instead of collapsing to `unspecified`.

/** Tier 1 — tool identifiers naming a denied read/search operation. */
const READ_TOOL_TOKENS: string[] = [
  "read_file",
  "read_many_files",
  "readfile",
  "read(",
  "list_directory",
  "listdirectory",
  "search_file",
  "search(",
  "glob",
];

/** Tier 2 — prose/argument tokens suggesting a read/search operation. */
const READ_GENERIC_TOKENS: string[] = [
  "read file",
  "reading file",
  "file read",
  "list directory",
  "directory listing",
  "grep",
  "search file",
  "file search",
  "codebase search",
  "view file",
];

/** Tier 1 — tool identifiers naming a denied command/process operation. */
const COMMAND_TOOL_TOKENS: string[] = [
  "run_shell_command",
  "runshellcommand",
  "shell_command",
  "shell(",
  "command(",
  "run_command",
  "execute_command",
  "exec(",
];

/** Tier 2 — prose/argument tokens suggesting a command/process operation. */
const COMMAND_GENERIC_TOKENS: string[] = [
  "shell command",
  "run shell",
  "run command",
  "execute command",
  "subprocess",
  "spawn",
  "child process",
  "terminal command",
  "bash",
];

/** Max denial records retained; keeps a scrolling transcript from being kept wholesale. */
export const MAX_DENIAL_EVIDENCE_LINES = 6;
/** Max operation tokens recorded per denial record. */
export const MAX_DENIAL_OPERATION_TOKENS = 8;
/** Max characters retained for the matched signal. */
export const MAX_DENIAL_SIGNAL_CHARS = 120;

/** Trusted diagnostic channel a denial was seen on. */
export type DenialChannel = "code" | "text";

/**
 * One retained denial record.
 *
 * Every string field is a literal from this module's own fixed vocabulary — the
 * denial signal lists and the operation token lists — never a span copied out of
 * the diagnostic. That is the artifact contract for issue #804: a denied command
 * body, its arguments, a generated scratch path, or an echoed prompt line cannot
 * be retained here even when the CLI prints it on (or next to) the denial line,
 * because no captured text is carried over at all. `channel` + `line` is the
 * pointer an operator follows to the detail, which stays local.
 *
 * That pointer is relative to the *diagnostic this classification consumed*, not
 * to the process's whole output: the adapter hands over a bounded tail of the
 * channel (agent-diagnostics.ts MAX_DIAGNOSTIC_TEXT_LENGTH) which, for a verbose
 * run, drops leading lines and may begin mid-line. A caller persisting these
 * records must therefore persist the diagnostic text it passed in, or record its
 * offset, rather than resolving the line against a fuller capture of the same
 * stream — the numbers would not line up (issue #804 review). The research
 * handler does the former; see `permissionDenialDiagnosticArtifact`.
 */
export interface DenialEvidence {
  /** Which trusted diagnostic channel the denial was seen on. */
  channel: DenialChannel;
  /** 1-based line number of the denial within that channel's bounded diagnostic text. */
  line: number;
  /** Matched denial phrase; always a literal from the fixed signal lists. */
  signal: string;
  /** Operation class resolved for this denial. */
  operation: DeniedOperationClass;
  /** Operation tokens seen in this denial's window; literals from the fixed token lists. */
  operationTokens: string[];
}

export interface PermissionDenialClassification {
  /** True when the trusted diagnostic states a permission/approval denial. */
  isPermissionDenied: boolean;
  /** Operation class the denial applies to. Only meaningful when denied. */
  operation: DeniedOperationClass;
  /** The matched denial phrase, bounded. Present only when denied. */
  signal?: string;
  /** Bounded, content-free records of each detected denial, for local artifacts. */
  evidence: DenialEvidence[];
  /** True when denial records were dropped by the bounds above. */
  evidenceTruncated: boolean;
  /** How many denial lines were detected, including any beyond the retention bound. */
  denialCount: number;
  /** Trusted source the diagnostic came from, echoed for the artifact record. */
  source?: AgentDiagnosticSource;
}

/** Fresh "not a denial" result — never a shared constant, so a caller that
 *  keeps or mutates `evidence` cannot affect a later classification. */
function notDenied(): PermissionDenialClassification {
  return { isPermissionDenied: false, operation: "unspecified", evidence: [], evidenceTruncated: false, denialCount: 0 };
}

/** One scanned line of the trusted capture, tagged with where it came from. */
interface ScannedLine {
  channel: DenialChannel;
  /** 1-based line number *within its own channel*, so it points into that capture. */
  line: number;
  /** Lowercased text, used for matching only — never retained. */
  lower: string;
}

/** Lines surrounding a denial line that are scanned for operation tokens. */
function evidenceWindow(lines: ScannedLine[], index: number): string {
  return lines
    .slice(Math.max(0, index - 1), Math.min(lines.length, index + 2))
    .map((l) => l.lower)
    .join("\n");
}

function findDenialSignal(line: string, agentId: string | undefined): string | undefined {
  const agentSignals = agentId ? AGENT_DENIAL_SIGNALS[agentId] ?? [] : [];
  for (const signal of [...agentSignals, ...GENERIC_DENIAL_SIGNALS]) {
    if (line.includes(signal)) return signal;
  }
  return undefined;
}

/** Tokens matched in a denial window, kept split by operation class and tier. */
interface MatchedOperationTokens {
  readTools: string[];
  commandTools: string[];
  readGeneric: string[];
  commandGeneric: string[];
}

/**
 * Which known operation tokens the denial window mentions.
 *
 * Returns the matching entries *from the constant lists*, not the surrounding
 * text they were found in, so nothing a caller persists can carry tool
 * arguments or neighbouring diagnostic content.
 */
function matchOperationTokens(window: string): MatchedOperationTokens {
  const has = (t: string): boolean => window.includes(t);
  return {
    readTools: READ_TOOL_TOKENS.filter(has),
    commandTools: COMMAND_TOOL_TOKENS.filter(has),
    readGeneric: READ_GENERIC_TOKENS.filter(has),
    commandGeneric: COMMAND_GENERIC_TOKENS.filter(has),
  };
}

/** One decisive class, or `unspecified` when neither or both sides matched. */
function decideOperation(read: string[], command: string[]): DeniedOperationClass {
  if (read.length > 0 && command.length === 0) return "read";
  if (command.length > 0 && read.length === 0) return "command";
  return "unspecified";
}

/**
 * Resolve the operation class, preferring the rejected tool's own identifier
 * over tokens that may have come from its arguments.
 *
 * `run_shell_command "grep -rn foo": permission denied` names a command tool and
 * mentions a read word; weighing both equally would report `unspecified` for a
 * denial whose class is plainly `command`. So whenever a tier-1 tool identifier
 * is present it decides on its own, and the prose/argument tokens are consulted
 * only for diagnostics that name no tool at all. Two *tool* identifiers of
 * opposing classes in one window still resolve to `unspecified` — that is real
 * ambiguity, not argument noise.
 */
function classifyOperation(matched: MatchedOperationTokens): DeniedOperationClass {
  if (matched.readTools.length > 0 || matched.commandTools.length > 0) {
    return decideOperation(matched.readTools, matched.commandTools);
  }
  return decideOperation(matched.readGeneric, matched.commandGeneric);
}

/**
 * Retained token list: the matched tokens, minus those that are merely
 * substrings of another match (`shell_command` inside `run_shell_command`), and
 * capped. Overlap in the token lists is deliberate — it widens matching — but
 * recording every overlapping variant would only pad the artifact. Tool
 * identifiers come first so a truncated list keeps the deciding tokens.
 */
function retainedOperationTokens(matched: MatchedOperationTokens): string[] {
  const all = [...matched.readTools, ...matched.commandTools, ...matched.readGeneric, ...matched.commandGeneric];
  return all
    .filter((token) => !all.some((other) => other !== token && other.includes(token)))
    .slice(0, MAX_DENIAL_OPERATION_TOKENS);
}

/**
 * Classify a trusted agent failure diagnostic as a headless permission denial
 * (or not).
 *
 * Operation resolution is per-denial and evidence-scoped: each denial line is
 * examined together with its immediate neighbours (CLIs commonly print the tool
 * name on the line above/below the refusal). Denials that disagree, or that
 * carry no operation token at all, resolve to `unspecified` rather than
 * picking a side.
 *
 * The diagnostic is *read* line by line but never *copied*: the returned
 * evidence records only which known signal and which known operation tokens
 * matched, plus where. Neighbouring lines therefore inform the operation class
 * without any of their content being retained (see `DenialEvidence`).
 */
export function classifyPermissionDenial(
  diagnostic: AgentFailureDiagnostic | undefined,
): PermissionDenialClassification {
  if (!diagnostic) return notDenied();
  const code = diagnostic.code ?? "";
  const text = diagnostic.text ?? "";
  if (!`${code}${text}`.trim()) return notDenied();
  const agentId = typeof diagnostic.agentId === "string" ? diagnostic.agentId : undefined;

  // Both channels are scanned as one sequence, so a structured provider code is
  // still read together with the message that follows it, while each line keeps
  // a channel-local number that points into that channel's own bounded
  // diagnostic text (see `DenialEvidence` for what that number is relative to).
  const scanned: ScannedLine[] = [
    ...code.split("\n").map((raw, i) => ({ channel: "code" as const, line: i + 1, lower: raw.toLowerCase() })),
    ...text.split("\n").map((raw, i) => ({ channel: "text" as const, line: i + 1, lower: raw.toLowerCase() })),
  ];

  let signal: string | undefined;
  const operations = new Set<DeniedOperationClass>();
  const evidence: DenialEvidence[] = [];
  let evidenceTruncated = false;
  let denialCount = 0;

  for (let i = 0; i < scanned.length; i++) {
    const entry = scanned[i]!;
    const matched = findDenialSignal(entry.lower, agentId);
    if (!matched) continue;
    denialCount++;
    const boundedSignal = matched.slice(0, MAX_DENIAL_SIGNAL_CHARS);
    if (signal === undefined) signal = boundedSignal;
    const tokens = matchOperationTokens(evidenceWindow(scanned, i));
    const operation = classifyOperation(tokens);
    operations.add(operation);
    if (evidence.length >= MAX_DENIAL_EVIDENCE_LINES) {
      evidenceTruncated = true;
      continue;
    }
    evidence.push({
      channel: entry.channel,
      line: entry.line,
      signal: boundedSignal,
      operation,
      operationTokens: retainedOperationTokens(tokens),
    });
  }

  if (denialCount === 0) return notDenied();

  // A single decisive class wins even if other denials in the same capture
  // carried no operation token; genuine disagreement (both read and command
  // denied) stays `unspecified` rather than picking one.
  const decisive = [...operations].filter((op) => op !== "unspecified");
  const operation: DeniedOperationClass = decisive.length === 1 ? decisive[0]! : "unspecified";

  return {
    isPermissionDenied: true,
    operation,
    ...(signal !== undefined ? { signal } : {}),
    evidence,
    evidenceTruncated,
    denialCount,
    source: diagnostic.source,
  };
}

/**
 * Public-safe wording for a denied operation class. Deliberately names only the
 * class — never the denied path, command body, tool arguments, or matched
 * diagnostic text — because callers interpolate this into GitHub comments and
 * Slack notifications (issue #804 acceptance criteria).
 */
export function describeDeniedOperation(operation: DeniedOperationClass): string {
  switch (operation) {
    case "read":
      return "repository read/search operation";
    case "command":
      return "command/process operation";
    default:
      return "tool operation";
  }
}
