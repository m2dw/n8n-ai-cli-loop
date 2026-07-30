/**
 * Shared admin command framework (issue #309).
 *
 * Before this layer each admin subcommand re-implemented the same argv loop,
 * the same `--session-id`/`--session-ref` resolution, the same
 * `--issue-number`/`--phase` validation, and its own output formatting. That let
 * behaviour drift: for example the Tool Request commands accepted only
 * `--session-id` while every other session-scoped command also accepted
 * `--session-ref`.
 *
 * This module centralises the common pieces so a command declares which options
 * it needs (a {@link CommonOptionSpec}) and gets back validated, typed
 * {@link CommonOptions}. The shared output helpers live in {@link ./cli-io}
 * (emit/report/die plus the resolved {@link OutputMode}); a command's supported
 * output modes are declared in admin.ts via the human-default command set. Result
 * shaping (success / safe no-op / failure) and exit-code mapping follow the
 * docs/admin-cli-contract.md contract: success and safe no-ops exit 0 via
 * emit()/report(); validation/setup failures exit non-zero via die().
 */

import type { TaskPhase } from "../core/task.js";
import { DEFAULT_SESSIONS_PATH, resolveSessionRef } from "../registries/json-session-registry.js";

/** Task phases accepted by `--phase` across recovery/enqueue commands. */
export const VALID_PHASES: readonly TaskPhase[] = [
  "implementation",
  "review",
  "conflict_resolution",
  "research",
  "content_research",
  "content_draft",
  "content_review",
  "planner",
];

/**
 * Strict tokenizer spec. A caller declares every option it accepts so that an
 * unrecognized `--flag` (e.g. a `--dry-ru` typo of `--dry-run`) is rejected
 * instead of silently swallowed. This is an operator-safety guarantee, not
 * cosmetic polish: a misspelled `--dry-run` must never turn a preview into a
 * mutation (issue #401).
 */
export interface TokenizeSpec {
  /** Flags that take no value (e.g. `dry-run`, `all`, `yes`). */
  booleanFlags?: readonly string[];
  /** Flags that consume the following token as their value. */
  valueFlags?: readonly string[];
  /** When true, non-option positional arguments are collected; otherwise rejected. */
  allowPositionals?: boolean;
}

export interface TokenizedArgs {
  args: Record<string, string>;
  flags: Set<string>;
  positionals: string[];
}

/** Levenshtein edit distance, used only to suggest the closest valid flag. */
function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const row = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = row[j];
      row[j] = Math.min(
        row[j] + 1,
        row[j - 1] + 1,
        prev + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      prev = tmp;
    }
  }
  return row[n];
}

/**
 * Build the error message for an unrecognized `--flag`, suggesting the closest
 * known option when one is plausibly a typo (edit distance within a third of the
 * name's length). The message always names the offending flag.
 */
export function unknownFlagError(name: string, known: readonly string[]): string {
  let best: string | undefined;
  let bestDist = Infinity;
  for (const candidate of known) {
    const d = editDistance(name, candidate);
    if (d < bestDist) {
      bestDist = d;
      best = candidate;
    }
  }
  const threshold = Math.max(2, Math.floor(name.length / 3));
  if (best !== undefined && bestDist <= threshold) {
    return `Unknown option: --${name} (did you mean --${best}?)`;
  }
  return `Unknown option: --${name}`;
}

/**
 * Tokenize an argv slice into `--flag value` pairs and standalone boolean
 * `--flag`s, rejecting anything the caller did not declare. `booleanFlags` lists
 * the flags that take no value; `valueFlags` lists the flags that consume the
 * following token as their value. An unknown `--flag`, a value flag whose value
 * is missing or is itself another `--flag`, or an unexpected positional argument
 * each return `{ error }` (the message names the offending token). Global flags
 * (`--json`, `--quiet`, `--verbose`) are stripped upstream in main() before a
 * command parser runs, so they never reach here.
 */
export function tokenizeArgs(
  argv: string[],
  spec: TokenizeSpec = {},
): TokenizedArgs | { error: string } {
  const boolSet = new Set(spec.booleanFlags ?? []);
  const valueSet = new Set(spec.valueFlags ?? []);
  const known = [...boolSet, ...valueSet];
  const args: Record<string, string> = {};
  const flags = new Set<string>();
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok.startsWith("--")) {
      if (spec.allowPositionals) {
        positionals.push(tok);
        continue;
      }
      return { error: `Unexpected argument: ${tok}` };
    }
    const name = tok.slice(2);
    if (boolSet.has(name)) {
      flags.add(name);
      continue;
    }
    if (valueSet.has(name)) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        return { error: `--${name} requires a value` };
      }
      args[name] = next;
      i++;
      continue;
    }
    return { error: unknownFlagError(name, known) };
  }
  return { args, flags, positionals };
}

/**
 * Resolve the shared session selector. Commands accept either the canonical
 * `--session-id` (never validated against sessions.json so existing callers keep
 * working) or a compact `--session-ref` (sessionId | sessionNo | alias) that is
 * resolved to the canonical sessionId via the shared registry resolver. The two
 * flags are mutually exclusive.
 */
export function resolveSessionSelector(
  args: Record<string, string>,
): { sessionId: string } | { error: string } {
  const hasId = args["session-id"] !== undefined;
  const hasRef = args["session-ref"] !== undefined;

  if (hasId && hasRef) {
    return { error: "Provide only one of --session-id or --session-ref, not both" };
  }
  if (hasId) {
    const sessionId = args["session-id"];
    if (sessionId === "") {
      return { error: "--session-id must not be empty" };
    }
    return { sessionId };
  }
  if (hasRef) {
    const sessionsPath = args["sessions-path"] ?? DEFAULT_SESSIONS_PATH;
    try {
      return { sessionId: resolveSessionRef(sessionsPath, args["session-ref"]) };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }
  return { error: "--session-id or --session-ref is required" };
}

/**
 * Validate and parse `--issue-number`. Returns `{ value: undefined }` when the
 * flag is absent so callers can decide whether it is required.
 */
export function parseIssueNumber(
  args: Record<string, string>,
): { value: number | undefined } | { error: string } {
  if (args["issue-number"] === undefined) return { value: undefined };
  const n = Number(args["issue-number"]);
  if (!Number.isInteger(n) || n <= 0) {
    return { error: `--issue-number must be a positive integer, got: ${args["issue-number"]}` };
  }
  return { value: n };
}

/** How a command treats a common option: required, optional, or unsupported. */
type OptionMode = "required" | "optional" | "none";

export interface CommonOptionSpec {
  /** Whether the command resolves a session selector (--session-id/--session-ref). */
  session?: "required" | "none";
  /** How `--issue-number` is treated. */
  issueNumber?: OptionMode;
  /** How `--phase` is treated (only "optional" or "none" are meaningful today). */
  phase?: OptionMode;
  /** Whether the command supports `--dry-run`. */
  dryRun?: boolean;
  /** Extra command-specific boolean flags to recognize (e.g. "all", "yes"). */
  booleanFlags?: readonly string[];
  /** Extra command-specific value flags to recognize (e.g. "action", "message"). */
  valueFlags?: readonly string[];
  /** When true, accept non-option positional arguments (collected in flags-free positionals). */
  allowPositionals?: boolean;
}

export interface CommonOptions {
  /** Canonical sessionId; "" when the command does not take a session. */
  sessionId: string;
  issueNumber: number | undefined;
  phase: TaskPhase | undefined;
  contextId: string | undefined;
  dbPath: string | undefined;
  sessionsPath: string;
  dryRun: boolean;
  /** Raw token maps so commands can read their own extra options. */
  args: Record<string, string>;
  flags: Set<string>;
}

/**
 * Parse the common admin options for a command from an argv slice according to
 * `spec`. Returns `{ error }` for the first validation failure (the message
 * always contains the offending flag name so the dual-mode {@link die} contract
 * surfaces it consistently), otherwise the validated {@link CommonOptions} plus
 * the raw token maps for any command-specific extras.
 */
export function parseCommonOptions(
  argv: string[],
  spec: CommonOptionSpec = {},
): CommonOptions | { error: string } {
  const booleanFlags = [
    ...(spec.dryRun ? ["dry-run"] : []),
    ...(spec.booleanFlags ?? []),
  ];
  // The full set of known value flags. `--context-id`/`--db-path` are universal
  // infrastructure options every command may pass; the session selector and its
  // `--sessions-path` are known only when the command resolves a session;
  // `--issue-number`/`--phase` only when the spec opts in. Anything else is a typo.
  const valueFlags = [
    "context-id",
    "db-path",
    ...(spec.session === "required" ? ["session-id", "session-ref", "sessions-path"] : []),
    ...(spec.issueNumber && spec.issueNumber !== "none" ? ["issue-number"] : []),
    ...(spec.phase === "optional" || spec.phase === "required" ? ["phase"] : []),
    ...(spec.valueFlags ?? []),
  ];
  const tokenized = tokenizeArgs(argv, {
    booleanFlags,
    valueFlags,
    allowPositionals: spec.allowPositionals,
  });
  if ("error" in tokenized) return { error: tokenized.error };
  const { args, flags } = tokenized;

  let sessionId = "";
  if (spec.session === "required") {
    const selector = resolveSessionSelector(args);
    if ("error" in selector) return { error: selector.error };
    sessionId = selector.sessionId;
  }

  let issueNumber: number | undefined;
  if (spec.issueNumber && spec.issueNumber !== "none") {
    const parsed = parseIssueNumber(args);
    if ("error" in parsed) return { error: parsed.error };
    issueNumber = parsed.value;
    if (spec.issueNumber === "required" && issueNumber === undefined) {
      return { error: "--issue-number is required" };
    }
  }

  let phase: TaskPhase | undefined;
  if (spec.phase === "optional" || spec.phase === "required") {
    if (args["phase"] !== undefined) {
      if (!VALID_PHASES.includes(args["phase"] as TaskPhase)) {
        return { error: `--phase must be one of: ${VALID_PHASES.join(", ")}, got: ${args["phase"]}` };
      }
      phase = args["phase"] as TaskPhase;
    } else if (spec.phase === "required") {
      return { error: "--phase is required" };
    }
  }

  return {
    sessionId,
    issueNumber,
    phase,
    contextId: args["context-id"],
    dbPath: args["db-path"],
    sessionsPath: args["sessions-path"] ?? DEFAULT_SESSIONS_PATH,
    dryRun: flags.has("dry-run"),
    args,
    flags,
  };
}
