import {
  MAX_TRANSIENT_VERIFICATION_RETRIES,
  classifyVerificationFailure,
  transientVerificationRetriesFor,
} from "./review-classifier.js";

// ---------------------------------------------------------------------------
// Implementation-phase verification outcome classification (issue #934)
//
// The implementation handler runs the configured verification commands BEFORE
// any commit/push and repairs an obvious failure inline, once. Before issue
// #934 anything still failing after that bounded inline attempt returned
// `failed`, which is terminal: an ordinary red test suite stopped the whole
// autonomous chain and needed `admin recover` even though the worktree was a
// perfectly valid continuation point.
//
// The bound on the INLINE repair is not the problem and is unchanged. What this
// module owns is the question the handler asks after it: is this failure
// something the implementation agent can keep working on (requeue the same
// task), something about the HOST rather than the diff (delayed retry), or
// something only an operator can fix (stay terminal)?
//
// It is deliberately pure and deliberately narrow. The default answer is
// "ordinary" — a misread ordinary failure only spends a bounded repair cycle
// and still reaches a human at the cap, while a misread setup failure would
// burn agent runs against a machine that can never pass.
// ---------------------------------------------------------------------------

/**
 * How many times ONE task may be automatically requeued to implementation
 * because its configured verification was still failing after the bounded
 * inline repair attempt.
 *
 * Each cycle costs a full implementation run plus its inline repair, so this is
 * small on purpose. A quality gate that three independent agent cycles cannot
 * satisfy is not converging, and an unbounded loop would spend the session's
 * budget where no human is looking. Matches the editorial cap
 * (`DEFAULT_MAX_CONTENT_REVIEW_CYCLES`) rather than inventing a second
 * magnitude for the same "bounded self-correction" idea.
 */
export const DEFAULT_MAX_VERIFICATION_REPAIR_CYCLES = 3;

/**
 * Task-context key holding how many automatic verification-repair requeues this
 * task has already spent (issue #934).
 *
 * Counted in task context rather than from `attempts.implementation` for the
 * same reason the editorial cycle counter is (see transitions.ts): `attempts`
 * counts every CLAIM, including runs released by a quota delay or lock
 * contention that never produced a verification verdict at all. The counter is
 * cleared by a successful implementation, so a later review→fix cycle starts
 * with a full budget.
 */
export const VERIFICATION_REPAIR_CYCLES_CONTEXT_FIELD = "verificationRepairCycles";

/** The failing verification command, as the handler captured it. */
export interface VerificationFailureFacts {
  /** Name of the failing command (the key in `session.verification`). */
  name: string;
  /** Exit code the command returned. */
  exitCode: number;
  /** Bounded combined stdout+stderr from the command. */
  output: string;
}

/**
 * Why a verification failure is an operator-actionable SETUP failure rather
 * than a statement about the diff.
 *
 * - `spawn_failed` — the runner could not execute the configured command at all
 *   (Node reports `spawnSync <cmd> ENOENT/EACCES/...`): a missing or
 *   non-executable binary.
 * - `missing_script` — the package manager has no such script, i.e. the
 *   session's `verification` map names something the repo does not define.
 * - `command_not_found` — a shell-wrapped command (`bash -lc '…'`) exited 127
 *   with the shell's own not-found diagnostic.
 */
export type VerificationEnvironmentSignal =
  | "spawn_failed"
  | "missing_script"
  | "command_not_found";

/**
 * Node's own spawn-level diagnostic, which `defaultCommandRunner` puts on
 * stderr verbatim when `execFileSync` throws before the child ever ran. Matched
 * structurally (the `spawn`/`spawnSync <cmd> <ERRNO>` shape) rather than by
 * prose, and restricted to the errnos that mean "this command cannot be
 * executed here": a saturated host reporting `EAGAIN` is not an operator
 * configuration problem and must keep its ordinary/transient handling.
 */
const SPAWN_FAILURE_PATTERN = /\bspawn(?:Sync)?\s+\S+\s+(?:ENOENT|EACCES|EPERM|ENOEXEC)\b/;

/** npm/pnpm/yarn's structural "the script you asked for does not exist" line. */
const MISSING_SCRIPT_PATTERN = /^\s*(?:npm|yarn|pnpm)\s+(?:ERR!|error|ERROR)\s+Missing script:/mi;

/** A POSIX shell's own not-found diagnostic; only trusted alongside exit 127. */
const COMMAND_NOT_FOUND_PATTERN = /(?:^|\n)[^\n]*:\s*(?:command not found|not found)\s*$/m;

/** Exit status a POSIX shell uses for "command not found". */
const SHELL_COMMAND_NOT_FOUND_EXIT_CODE = 127;

/**
 * Recognize an operator-actionable setup failure in a failed verification run.
 *
 * Returns `undefined` for everything else — including a plain nonzero test
 * result, which is the case issue #934 exists to keep recoverable.
 */
export function classifyVerificationEnvironmentFailure(
  failure: VerificationFailureFacts,
): VerificationEnvironmentSignal | undefined {
  if (SPAWN_FAILURE_PATTERN.test(failure.output)) return "spawn_failed";
  if (MISSING_SCRIPT_PATTERN.test(failure.output)) return "missing_script";
  if (
    failure.exitCode === SHELL_COMMAND_NOT_FOUND_EXIT_CODE &&
    COMMAND_NOT_FOUND_PATTERN.test(failure.output)
  ) {
    return "command_not_found";
  }
  return undefined;
}

/**
 * What the implementation handler should do with a verification failure that
 * survived the bounded inline repair attempt.
 *
 * - `transient` — the failure is evidence about the host, not the diff (issue
 *   #897's indeterminate CLI probe). Delayed retry under the SAME per-command
 *   budget the review phase uses; it does not spend a repair cycle.
 * - `environment` — an operator-actionable setup failure. Stays terminal.
 * - `repair_requeue` — an ordinary quality-gate failure the implementation
 *   agent can continue fixing. Requeue the same task at `implementation`.
 * - `repair_cap_reached` — the same task has already spent every automatic
 *   repair cycle. Hand off to a human.
 */
export type ImplementationVerificationDisposition =
  | { kind: "transient"; signal: string; attempt: number; maxAttempts: number }
  | { kind: "environment"; signal: VerificationEnvironmentSignal }
  | { kind: "repair_requeue"; cycle: number; maxCycles: number }
  | { kind: "repair_cap_reached"; cycles: number; maxCycles: number };

/** Automatic repair cycles this task has already spent. */
export function verificationRepairCyclesSpent(ctx: Record<string, unknown> | undefined): number {
  const raw = ctx?.[VERIFICATION_REPAIR_CYCLES_CONTEXT_FIELD];
  return typeof raw === "number" && Number.isInteger(raw) && raw > 0 ? raw : 0;
}

/**
 * Decide the outcome of a verification failure that the bounded inline repair
 * attempt did not fix.
 *
 * Order matters. The transient probe signal is checked first because it is the
 * narrowest and most specific evidence available (a structural marker emitted
 * by our own doctor probe), and because spending a repair cycle — or declaring
 * an operator-actionable setup failure — on a saturated host is exactly the
 * misdiagnosis issue #897 removed from the review phase.
 */
export function decideImplementationVerificationOutcome(args: {
  failure: VerificationFailureFacts;
  context?: Record<string, unknown>;
  maxCycles?: number;
  maxTransientRetries?: number;
}): ImplementationVerificationDisposition {
  const { failure, context } = args;
  const maxCycles = args.maxCycles ?? DEFAULT_MAX_VERIFICATION_REPAIR_CYCLES;
  const maxTransientRetries = args.maxTransientRetries ?? MAX_TRANSIENT_VERIFICATION_RETRIES;

  const transient = classifyVerificationFailure(failure.output);
  if (transient.transient) {
    const spent = transientVerificationRetriesFor(context, failure.name);
    if (spent < maxTransientRetries) {
      return {
        kind: "transient",
        signal: transient.signal ?? "transient",
        attempt: spent + 1,
        maxAttempts: maxTransientRetries,
      };
    }
    // Budget spent: the failure is treated as real from here on, exactly as the
    // review phase treats it, and falls through to the ordinary handling below.
  }

  const environment = classifyVerificationEnvironmentFailure(failure);
  if (environment !== undefined) return { kind: "environment", signal: environment };

  const spentCycles = verificationRepairCyclesSpent(context);
  if (spentCycles >= maxCycles) {
    return { kind: "repair_cap_reached", cycles: spentCycles, maxCycles };
  }
  return { kind: "repair_requeue", cycle: spentCycles + 1, maxCycles };
}

/** Operator-facing explanation of an environment signal, for the failure message. */
export function describeVerificationEnvironmentSignal(
  signal: VerificationEnvironmentSignal,
): string {
  switch (signal) {
    case "spawn_failed":
      return "the configured command could not be executed (missing or non-executable binary)";
    case "missing_script":
      return "the configured command names a script this repository does not define";
    case "command_not_found":
      return "the shell could not find the configured command";
  }
}
