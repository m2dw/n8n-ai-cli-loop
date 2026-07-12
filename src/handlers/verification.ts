import { writeFileSync } from "fs";
import { join } from "path";
import type { CommandRunner } from "./command-runner.js";
import type { VerificationCommands } from "../core/session.js";

// ---------------------------------------------------------------------------
// Shell tokenizer
//
// Splits a verification command string into argv tokens, honouring single and
// double quotes so a command like `npm run "lint:all"` is tokenized correctly.
// ---------------------------------------------------------------------------

export function parseShellTokens(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let i = 0;
  while (i < command.length) {
    const ch = command[i];
    if (ch === "'") {
      i++;
      while (i < command.length && command[i] !== "'") {
        current += command[i++];
      }
      i++; // closing quote
    } else if (ch === '"') {
      i++;
      while (i < command.length && command[i] !== '"') {
        if (command[i] === "\\" && i + 1 < command.length) {
          i++;
          current += command[i++];
        } else {
          current += command[i++];
        }
      }
      i++; // closing quote
    } else if (ch === " " || ch === "\t") {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      i++;
    } else {
      current += ch;
      i++;
    }
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}

// ---------------------------------------------------------------------------
// Output bound
//
// Verification output (e.g. a full `npm test` log) is bounded before it is
// surfaced in task context or a repair prompt so a verbose run cannot grow the
// persisted context column without limit. The tail is kept because test runners
// print the failing assertions and summary at the end of the log.
// ---------------------------------------------------------------------------

export const MAX_VERIFICATION_OUTPUT_CHARS = 4000;

// Capture buffer for a verification command's combined stdout+stderr. Verbose
// but passing commands (a full `npm test` or build log) can exceed Node's
// default 1 MiB `execFileSync` buffer, which makes the default runner throw —
// surfacing as a non-zero exit before `boundVerificationOutput` can trim the
// log, so a passing command would be misreported as a failed verification.
// Capture generously here and let `boundVerificationOutput` trim only the
// stored feedback. Keep it aligned with the worker's command buffer (80 MiB).
export const MAX_VERIFICATION_BUFFER_BYTES = 80 * 1024 * 1024;

export function boundVerificationOutput(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_VERIFICATION_OUTPUT_CHARS) return trimmed;
  return "…(truncated)\n" + trimmed.slice(trimmed.length - MAX_VERIFICATION_OUTPUT_CHARS);
}

// ---------------------------------------------------------------------------
// Verification runner
// ---------------------------------------------------------------------------

export interface VerificationFailure {
  /** Name of the failing verification command (the key in session.verification). */
  name: string;
  /** Exit code returned by the failing command. */
  exitCode: number;
  /** Bounded combined stdout+stderr from the failing command. */
  output: string;
}

export interface VerificationOutcome {
  passed: boolean;
  /** One entry per command that was run, in order, up to and including any failure. */
  results: { name: string; passed: boolean }[];
  /** Present only when passed === false. */
  failure?: VerificationFailure;
}

/** Status of a single verification command extracted from the issue body. */
export interface IssueRequiredVerification {
  /** The raw command string as it appeared in the issue body. */
  command: string;
  /** Whether the command was run and passed, run and failed, or not run at all. */
  status: "passed" | "failed" | "not_run";
  /** Exit code when status is "failed". */
  exitCode?: number;
  /** Bounded failure output when status is "failed". */
  failureSummary?: string;
}

/**
 * Returns true when a session verification value is considered equivalent to a
 * required command. Handles two cases:
 *
 * 1. Exact match (trimmed strings are equal).
 * 2. Shell-wrapper equivalence: an entry like `bash -lc 'cd frontend && npm test'`
 *    is a runnable form of the compound command `cd frontend && npm test` that the
 *    extractor records. Comparing by inner command prevents compound directory-
 *    scoped checks from being permanently blocked as "not_run".
 */
function matchesRequiredCommand(sessionValue: string, required: string): boolean {
  const sv = sessionValue.trim();
  const req = required.trim();
  if (sv === req) return true;
  // bash/sh/zsh [-flags] '<cmd>' or "<cmd>"
  const m = /^(?:bash|sh|zsh)\s+(?:-\w+\s+)*(?:'([^']*)'|"([^"]*)")$/.exec(sv);
  if (m) {
    const inner = (m[1] ?? m[2] ?? "").trim();
    return inner === req;
  }
  return false;
}

/** Evidence of a manually-executed verification command supplied by the operator. */
export interface ManualVerificationEntry {
  /** The command string as supplied by the operator. */
  command: string;
  /** Exit code from running the command. */
  exitCode: number;
  /** Bounded, sanitized output from the command. */
  output: string;
  /** ISO timestamp when the evidence was recorded. */
  recordedAt: string;
  /** How the evidence was supplied: e.g. "operator_input". */
  source: string;
}

/**
 * Match extracted issue-required commands against what session.verification
 * actually ran. Each required command is matched by comparing its string
 * (trimmed) to the VALUES in `sessionVerification`, including shell-wrapped
 * equivalents such as `bash -lc '<cmd>'`.
 *
 * Called after session.verification has been fully executed with no failures,
 * so any matched command is known to have passed. Unmatched commands are
 * marked "not_run", unless operator-supplied `manualEvidence` covers the
 * command with a passing (exit 0) result.
 */
export function buildIssueVerificationStatus(
  requiredCommands: string[],
  sessionVerification: VerificationCommands,
  manualEvidence?: ManualVerificationEntry[],
): IssueRequiredVerification[] {
  const sessionValues = Object.values(sessionVerification).map((c) => c.trim());
  const evidence = manualEvidence ?? [];
  return requiredCommands.map((command): IssueRequiredVerification => {
    const req = command.trim();
    if (sessionValues.some((sv) => matchesRequiredCommand(sv, req))) {
      return { command, status: "passed" };
    }
    const manualEntry = evidence.find((e) => e.exitCode === 0 && matchesRequiredCommand(e.command, req));
    if (manualEntry !== undefined) {
      return { command, status: "passed" };
    }
    return { command, status: "not_run" };
  });
}

/**
 * Run each configured verification command in order, stopping at the first
 * failure. Writes a per-command log under `artifactDir` when provided.
 *
 * An empty verification map passes trivially.
 */
export function runVerification(
  runner: CommandRunner,
  verification: VerificationCommands,
  cwd: string,
  artifactDir?: string,
  logPrefix = "verification",
): VerificationOutcome {
  const results: { name: string; passed: boolean }[] = [];
  for (const [name, command] of Object.entries(verification)) {
    const [verCmd, ...verArgs] = parseShellTokens(command);
    if (!verCmd) {
      // Skip empty command strings rather than spawning an empty process.
      results.push({ name, passed: true });
      continue;
    }
    const r = runner.run(verCmd, verArgs, { cwd, maxBuffer: MAX_VERIFICATION_BUFFER_BYTES });
    if (artifactDir) {
      writeFileSync(join(artifactDir, `${logPrefix}-${name}.log`), r.stdout + r.stderr, "utf8");
    }
    if (r.exitCode !== 0) {
      results.push({ name, passed: false });
      return {
        passed: false,
        results,
        failure: {
          name,
          exitCode: r.exitCode,
          output: boundVerificationOutput([r.stdout, r.stderr].filter(Boolean).join("\n")),
        },
      };
    }
    results.push({ name, passed: true });
  }
  return { passed: true, results };
}
