/**
 * Pure, deterministic classifier for Codex review output.
 *
 * Conservative rule priority (first match wins):
 *   1. conflict  — strong, structural evidence of a real Git merge conflict
 *   2. needs_fix — P1/P2 / "blocking" findings, or an unmet issue requirement
 *                  / acceptance criterion called out by the reviewer
 *   3. success   — output present and no blocking findings detected
 *   4. blocked   — empty/ambiguous output (human needed)
 */

import { CLI_PROBE_INDETERMINATE_MARKER, hasIndeterminateProbeSignal } from "./cli-probe.js";

export type ReviewClassification = "success" | "needs_fix" | "conflict" | "blocked";

export interface ClassificationDetail {
  classification: ReviewClassification;
  hasBlockingFindings: boolean;
  hasConflictSignal: boolean;
  findingCount: number;
  reason: string;
}

// Strong, structural evidence of a *real* Git merge conflict.
//
// Generic prose such as "merge conflict" or "cannot merge" is intentionally NOT
// matched here. The codex review output is freeform discussion of the diff and
// routinely contains conflict-related words when the PR is about conflict-handling
// code, or when failing test names / assertions include strings such as
// "merge conflict in codex output" or "conflict_resolution" (issue #168).
// Matching that prose produced false human escalations even when the PR branch
// was perfectly mergeable. We therefore require reliable evidence: actual Git
// conflict markers, Git's own conflict output, or Git's merge-failure messages.
const CONFLICT_PATTERNS = [
  /^<{7}(?: |$)/m, // <<<<<<< HEAD  (Git conflict marker at line start)
  /^>{7}(?: |$)/m, // >>>>>>> branch (Git conflict marker at line start)
  /^CONFLICT \([^)]*\):/m, // git: "CONFLICT (content): Merge conflict in <file>"
  /^Automatic merge failed/im, // git merge failure summary line
  /merging is not possible because you have unmerged files/i, // git unmerged-files error
];

// P1/P2 priority markers and generic "blocking" language.
// Use bracketed [P1]/[P2] as the canonical finding format to avoid
// matching negative statements like "No P1/P2 findings found."
export const PRIORITY_BLOCKING_PATTERNS = [
  /\[P[12]\]/,
  /\bblocking\s+finding/i,
  /\bcritical\s+finding/i,
  /\bblocker\b/i,
];

// Requirement-fit signals: the reviewer states that the diff fails to satisfy
// an issue requirement or acceptance criterion. These are treated as blocking
// so a clean-but-wrong implementation cannot pass review (issue #174). The
// patterns require a "miss"-style verb adjacent to the requirement/criterion
// noun so plain mentions ("all acceptance criteria are met") do not match.
export const REQUIREMENT_MISS_PATTERNS = [
  /\b(?:miss(?:es|ing|ed)?|unmet|unsatisfied|unaddressed|incomplete|not\s+(?:met|satisfied|addressed|implemented|fulfilled))\b[\s\S]{0,60}?\bacceptance\s+criteri/i,
  /\bacceptance\s+criteri\w*\b[\s\S]{0,60}?\b(?:miss(?:es|ing|ed)?|unmet|unsatisfied|unaddressed|incomplete|not\s+(?:met|satisfied|addressed|implemented|fulfilled))\b/i,
  /\bdoes\s+not\s+(?:meet|satisfy|fulfill|address|implement)\b[\s\S]{0,40}?\b(?:acceptance\s+criteri|requirement)/i,
  /\b(?:missing|unmet|unsatisfied|unaddressed)\s+requirement/i,
];

// Combined set used both for classification and for locating the first
// actionable finding when bounding stored review feedback.
export const BLOCKING_PATTERNS = [
  ...PRIORITY_BLOCKING_PATTERNS,
  ...REQUIREMENT_MISS_PATTERNS,
];

// Signals that the reviewer explicitly requests human input
const HUMAN_INPUT_PATTERNS = [
  /human\s+(review|decision|judgment|input)\s+required/i,
  /needs?\s+human\s+(review|decision)/i,
  /escalate\s+to\s+human/i,
  /manual\s+review\s+required/i,
];

/**
 * Structural evidence of a real Git merge conflict anywhere in the text.
 *
 * Exported so a caller that classifies only PART of a review run's output (issue
 * #841 scopes the prose rules to the text outside the structured envelope) can
 * still test the COMPLETE output for a conflict, which is the one signal no
 * reviewer statement can argue with.
 */
export function hasConflictSignal(output: string): boolean {
  return CONFLICT_PATTERNS.some((p) => p.test(output.trim()));
}

/**
 * How many times one review task may re-run a verification command that failed
 * for a transient reason before the failure is treated as real (issue #897).
 *
 * Small on purpose. A genuinely loaded host recovers within a couple of short
 * backoffs; anything that survives them is either not transient or not going to
 * clear on its own, and an unbounded delay loop would strand the task where no
 * human is looking.
 */
export const MAX_TRANSIENT_VERIFICATION_RETRIES = 2;

/**
 * Task-context key holding the per-command transient retry ledger (issue #897).
 *
 * The budget is per VERIFICATION COMMAND, not per review task. A session with
 * `test`, `package` and `typecheck` would otherwise let an indeterminate probe
 * in `test` spend a shared counter, pass on the retry, and leave `package`'s
 * FIRST indeterminate probe with no budget at all — falling straight through to
 * `needs_fix`, which is the misdiagnosis this issue exists to prevent.
 */
export const TRANSIENT_VERIFICATION_LEDGER_KEY = "verificationTransientRetriesByStep";

/** Legacy single-counter keys, still honoured for tasks delayed before the ledger existed. */
const LEGACY_RETRY_COUNT_KEY = "verificationTransientRetries";
const LEGACY_RETRY_STEP_KEY = "transientVerificationStep";

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function readLedger(ctx: Record<string, unknown> | undefined): Record<string, number> {
  const raw = ctx?.[TRANSIENT_VERIFICATION_LEDGER_KEY];
  const ledger: Record<string, number> = {};
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    for (const [step, count] of Object.entries(raw as Record<string, unknown>)) {
      const parsed = positiveInteger(count);
      if (parsed !== undefined) ledger[step] = parsed;
    }
  }
  return ledger;
}

/**
 * How many transient retries the named verification command has already spent.
 *
 * A pre-ledger context carries a single scalar. It counts only against the step
 * it was recorded alongside; when no step was recorded the scalar is the whole
 * task's count and is honoured for whichever command is failing now, so an
 * in-flight budget is never silently widened by this change.
 */
export function transientVerificationRetriesFor(
  ctx: Record<string, unknown> | undefined,
  step: string,
): number {
  const ledger = readLedger(ctx);
  const scalar = positiveInteger(ctx?.[LEGACY_RETRY_COUNT_KEY]);
  if (scalar === undefined) return ledger[step] ?? 0;
  const scalarStep = ctx?.[LEGACY_RETRY_STEP_KEY];
  const scalarApplies =
    typeof scalarStep === "string" && scalarStep !== "" ? scalarStep === step : true;
  return Math.max(ledger[step] ?? 0, scalarApplies ? scalar : 0);
}

/**
 * The ledger to carry forward when `step` is delayed for the `attempt`-th time.
 *
 * Commands that PASSED in this run have their counters dropped: a command that
 * answered is not mid-transient-failure any more, and keeping its spent budget
 * would shrink what it gets the next time the host actually is saturated.
 */
export function recordTransientVerificationRetry(args: {
  ctx: Record<string, unknown> | undefined;
  step: string;
  attempt: number;
  passedSteps: readonly string[];
}): Record<string, number> {
  const ledger = readLedger(args.ctx);
  const scalar = positiveInteger(args.ctx?.[LEGACY_RETRY_COUNT_KEY]);
  const scalarStep = args.ctx?.[LEGACY_RETRY_STEP_KEY];
  if (scalar !== undefined && typeof scalarStep === "string" && scalarStep !== "") {
    ledger[scalarStep] = Math.max(ledger[scalarStep] ?? 0, scalar);
  }
  for (const passed of args.passedSteps) delete ledger[passed];
  ledger[args.step] = args.attempt;
  return ledger;
}

/**
 * The context patch that retires transient-retry state for commands that PASSED
 * (issue #934 review).
 *
 * A phase that delays for an indeterminate probe and then passes on the retry
 * leaves its spent budget in task context, and the context merge carries it into
 * the next phase. The same command failing transiently in a LATER phase would
 * then start with the earlier phase's partial (or exhausted) count and could be
 * routed to `needs_fix` instead of getting its allowed delayed retry. A command
 * that answered is not mid-transient-failure any more, so its budget is released
 * here exactly as {@link recordTransientVerificationRetry} releases it for the
 * commands that passed alongside a still-failing one.
 *
 * Returns a patch, not a context: every key is meant to be spread over the
 * outgoing context so the merge clears the stale value rather than preserving it.
 */
export function clearTransientVerificationRetries(
  ctx: Record<string, unknown> | undefined,
  passedSteps: readonly string[],
): Record<string, unknown> {
  const ledger = readLedger(ctx);
  for (const passed of passedSteps) delete ledger[passed];
  const scalar = positiveInteger(ctx?.[LEGACY_RETRY_COUNT_KEY]);
  const scalarStep = ctx?.[LEGACY_RETRY_STEP_KEY];
  // A pre-ledger scalar survives only when it names a command that did NOT pass
  // here; a scalar with no step is the whole task's count and is stale once any
  // command has answered, so it is cleared with the rest.
  const scalarSurvives =
    scalar !== undefined
    && typeof scalarStep === "string"
    && scalarStep !== ""
    && !passedSteps.includes(scalarStep);
  return {
    [TRANSIENT_VERIFICATION_LEDGER_KEY]: Object.keys(ledger).length > 0 ? ledger : undefined,
    ...(scalarSurvives
      ? {}
      : {
        [LEGACY_RETRY_COUNT_KEY]: undefined,
        [LEGACY_RETRY_STEP_KEY]: undefined,
        transientVerificationSignal: undefined,
      }),
  };
}

export interface VerificationFailureClassification {
  /**
   * The failure is evidence about the HOST, not about the diff — retry it under
   * the transient-retry policy instead of routing it to `needs_fix`.
   */
  transient: boolean;
  /** The token that established transience, for the task event / operator log. */
  signal?: string;
}

/**
 * Classify a FAILED verification command's captured output (issue #897).
 *
 * The one signal recognized today is an indeterminate CLI probe: a
 * `session-doctor` probe that timed out or could not fork reports itself with
 * {@link CLI_PROBE_INDETERMINATE_MARKER}, and a verification run that surfaces
 * that marker failed because the machine was saturated, not because the
 * implementation is wrong. Routing it to `needs_fix` requeues an
 * implementation phase that correctly finds nothing to change and then fails
 * for producing no diff — the exact loop issue #897 was filed for.
 *
 * Deliberately narrow: it matches the structural marker and nothing else.
 * Verification output quotes the words "timeout", "EAGAIN" and "unavailable"
 * for countless unrelated reasons, and a broader rule would start delaying real
 * test failures.
 */
export function classifyVerificationFailure(output: string): VerificationFailureClassification {
  if (hasIndeterminateProbeSignal(output)) {
    return { transient: true, signal: CLI_PROBE_INDETERMINATE_MARKER };
  }
  return { transient: false };
}

export function classifyReviewOutput(output: string): ClassificationDetail {
  const text = output.trim();

  if (text.length === 0) {
    return {
      classification: "blocked",
      hasBlockingFindings: false,
      hasConflictSignal: false,
      findingCount: 0,
      reason: "Empty review output — cannot classify confidently",
    };
  }

  if (hasConflictSignal(text)) {
    return {
      classification: "conflict",
      hasBlockingFindings: false,
      hasConflictSignal: true,
      findingCount: 0,
      reason: "Review output contains merge-conflict signals",
    };
  }

  const hasPriorityBlocking = PRIORITY_BLOCKING_PATTERNS.some((p) => p.test(text));
  const hasRequirementMiss = REQUIREMENT_MISS_PATTERNS.some((p) => p.test(text));
  if (hasPriorityBlocking || hasRequirementMiss) {
    // Count distinct P1/P2 markers as a rough finding count
    const findingCount = (text.match(/\[P[12]\]/g) ?? []).length || 1;
    return {
      classification: "needs_fix",
      hasBlockingFindings: true,
      hasConflictSignal: false,
      findingCount,
      reason: hasPriorityBlocking
        ? "Review output contains blocking (P1/P2) findings"
        : "Review output reports an unmet issue requirement or acceptance criterion",
    };
  }

  const needsHuman = HUMAN_INPUT_PATTERNS.some((p) => p.test(text));
  if (needsHuman) {
    return {
      classification: "blocked",
      hasBlockingFindings: false,
      hasConflictSignal: false,
      findingCount: 0,
      reason: "Review output requests human judgment",
    };
  }

  // Output present, no blocking markers → clean review
  return {
    classification: "success",
    hasBlockingFindings: false,
    hasConflictSignal: false,
    findingCount: 0,
    reason: "No blocking findings detected in review output",
  };
}
