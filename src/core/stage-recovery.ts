/**
 * Staged verification: bounded recovery of the implementation lane's `loop`
 * stage (issue #1106 — `docs/staged-verification-contract.md` §7 rows 4–6 and
 * `docs/verification-evidence-validity-contract.md` §7.3, the counter #1096 §9
 * assigns to slice S7).
 *
 * The final stage already bounds its non-code terminations through the
 * persisted `finalRecoveryStreak` (#1103). This module is the loop stage's half,
 * and it is deliberately pure: the lane reads the persisted record, runs the
 * stage, and asks {@link decideLoopStageRecovery} what the outcome it just
 * observed allows. Nothing here executes, reads a verdict, or writes a store.
 *
 * Two rules it keeps:
 *
 * 1. **Only non-code terminations count** (#1096 §7.3 rule 1). `interrupted`,
 *    `unknown` and `infrastructure` extend the consecutive streak; `passed`,
 *    `code-failed` and `timed-out` reset it, because the run got far enough to
 *    say something about the change. No repair cap is read or moved (rule 2).
 * 2. **Unreadable state fails closed.** A record that does not parse cannot say
 *    how many attempts were spent, so it parks rather than retrying without a
 *    bound.
 *
 * Issue #1155 removed the third: #1094 §7 row 5's single re-run of a first
 * `unknown` over the **entire required set**. It existed to widen a narrowed
 * selection on the run meant to settle it, and with the selection policy retired
 * every stage run already covers the whole required set — so an `unknown` has
 * nothing left to widen and takes the ordinary bounded retry.
 */

import type { StageOutcome } from "./staged-verification-state.js";

/**
 * The task-context key of the implementation lane's loop-stage recovery record.
 *
 * Kept beside `verificationRepairCycles` (#934) rather than inside the
 * `stagedVerification` state: the loop stage does not allocate a stage run in
 * the store (#1102), and a counter belongs with the lane whose completion
 * persists it. Absent or `null` reads as "no consecutive non-code termination".
 */
export const LOOP_STAGE_RECOVERY_CONTEXT_KEY = "stagedLoopRecovery";

/** #1096 §7.3 rule 1: the outcomes that consume the recovery budget. */
export const NON_CODE_STAGE_OUTCOMES = ["interrupted", "unknown", "infrastructure"] as const;

export type NonCodeStageOutcome = (typeof NON_CODE_STAGE_OUTCOMES)[number];

export function isNonCodeStageOutcome(outcome: StageOutcome): outcome is NonCodeStageOutcome {
  return (NON_CODE_STAGE_OUTCOMES as readonly string[]).includes(outcome);
}

/**
 * What the next claim may do with the preserved worktree.
 *
 * `verification` — the run ended on a non-code termination AFTER the agent's
 * work was captured as a dirty continuation, so the only work left is to verify
 * it: the next claim re-runs the loop stage over the same bytes instead of
 * spending an agent turn that has nothing to change (#1094 §7 rule 3).
 */
export type LoopStageContinuation = "verification";

export interface LoopStageRecoveryRecord {
  /** Consecutive non-code loop-stage terminations, including the one recorded. */
  readonly streak: number;
  readonly lastOutcome: NonCodeStageOutcome;
  /** Present only on the delayed retry that preserved the work for verification. */
  readonly continuation?: LoopStageContinuation;
  /** The run whose dirty continuation the `continuation` is bound to. */
  readonly runId?: string;
}

export type LoopStageRecoveryStreakRead =
  | { readonly readable: true; readonly streak: number; readonly record?: LoopStageRecoveryRecord }
  | { readonly readable: false; readonly detail: string };

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** Read the persisted record. Absent and `null` are a zero streak; anything malformed is unreadable. */
export function readLoopStageRecovery(
  context: Record<string, unknown> | undefined,
): LoopStageRecoveryStreakRead {
  const raw = context?.[LOOP_STAGE_RECOVERY_CONTEXT_KEY];
  if (raw === undefined || raw === null) return { readable: true, streak: 0 };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { readable: false, detail: `${LOOP_STAGE_RECOVERY_CONTEXT_KEY}: not an object` };
  }
  const value = raw as Record<string, unknown>;
  if (!isNonNegativeInteger(value.streak)) {
    return { readable: false, detail: `${LOOP_STAGE_RECOVERY_CONTEXT_KEY}.streak: not a non-negative integer` };
  }
  if (typeof value.lastOutcome !== "string" || !(NON_CODE_STAGE_OUTCOMES as readonly string[]).includes(value.lastOutcome)) {
    return { readable: false, detail: `${LOOP_STAGE_RECOVERY_CONTEXT_KEY}.lastOutcome: not a non-code stage outcome` };
  }
  if (value.continuation !== undefined && value.continuation !== "verification") {
    return { readable: false, detail: `${LOOP_STAGE_RECOVERY_CONTEXT_KEY}.continuation: not "verification"` };
  }
  if (value.runId !== undefined && (typeof value.runId !== "string" || value.runId.length === 0)) {
    return { readable: false, detail: `${LOOP_STAGE_RECOVERY_CONTEXT_KEY}.runId: not a non-empty string` };
  }
  const record: LoopStageRecoveryRecord = {
    streak: value.streak,
    lastOutcome: value.lastOutcome as NonCodeStageOutcome,
    ...(value.continuation === "verification" ? { continuation: "verification" as const } : {}),
    ...(typeof value.runId === "string" ? { runId: value.runId } : {}),
  };
  return { readable: true, streak: value.streak, record };
}

export type LoopStageParkReason =
  /** #1096 §7.3 rule 4: the consecutive streak passed `maxStageRecoveryAttempts`. */
  | "recovery-budget-exhausted"
  /** The persisted record cannot say how much budget was spent. */
  | "recovery-state-unreadable"
  /**
   * Issue #1154: a Stage 1 test result whose §5 route is the handoff —
   * `retained-unresolved` or `termination-unknown`. Never re-run automatically.
   * A complete Stage 1 that skipped every selected file is not one of them: it
   * is `empty` and continues to review (decision D6, issue #1165).
   */
  | "test-stage-handoff";

export type LoopStageRecoveryDecision =
  /** A verdict-bearing outcome: the lane's shipped route decides, and the streak resets. */
  | { readonly kind: "reset" }
  /** Rows 4–6 within budget: the shipped host-failure route, with no agent turn. */
  | { readonly kind: "retry"; readonly record: LoopStageRecoveryRecord }
  /** The lane's existing human handoff. The work is preserved, never discarded. */
  | { readonly kind: "park"; readonly reason: LoopStageParkReason; readonly record?: LoopStageRecoveryRecord };

export interface DecideLoopStageRecoveryInput {
  readonly outcome: StageOutcome;
  /** The streak before this run: {@link readLoopStageRecovery}'s, or `undefined` when unreadable. */
  readonly priorStreak: number | undefined;
  /** `stagedVerification.maxStageRecoveryAttempts`, already validated positive at load. */
  readonly maxAttempts: number;
}

/**
 * #1094 §7 rows 1–6 over one loop-stage outcome, bounded by #1096 §7.3.
 *
 * The order is the order of the bounds: a verdict first (nothing to recover),
 * then unreadable state, then the budget. Issue #1155 removed row 5's inner
 * bound with the full re-run it governed, so `unknown` retries under the same
 * budget as every other non-code termination.
 */
export function decideLoopStageRecovery(input: DecideLoopStageRecoveryInput): LoopStageRecoveryDecision {
  if (!isNonCodeStageOutcome(input.outcome)) return { kind: "reset" };
  if (input.priorStreak === undefined) return { kind: "park", reason: "recovery-state-unreadable" };
  const record: LoopStageRecoveryRecord = { streak: input.priorStreak + 1, lastOutcome: input.outcome };
  if (record.streak > input.maxAttempts) {
    return { kind: "park", reason: "recovery-budget-exhausted", record };
  }
  return { kind: "retry", record };
}

export interface VerificationOnlyResumeInput {
  /** The persisted record, as {@link readLoopStageRecovery} read it. */
  readonly recovery: LoopStageRecoveryStreakRead;
  /** The dirty continuation the implementation preflight has ALREADY validated byte for byte. */
  readonly activeDirtyContinuation: Record<string, unknown> | undefined;
  readonly stagedVerificationEnabled: boolean;
  /** A fix turn whose prompt carries the dispute disposition contract always needs the agent. */
  readonly dispositionContractRendered: boolean;
}

/**
 * May this claim skip the implementation agent and only verify?
 *
 * Only when every one of these holds — each is a reason the agent would have
 * nothing to do, or a reason skipping it could lose something:
 *
 * - the feature is on (disabling it restores today's behavior exactly);
 * - the persisted record says the last run ended on a non-code termination and
 *   preserved its work for `verification`;
 * - the implementation preflight validated a dirty continuation (path set and
 *   patch bytes both unchanged since that run), and it is THAT run's marker;
 * - no disposition contract is pending, whose answer only an agent turn gives.
 */
export function admitVerificationOnlyResume(input: VerificationOnlyResumeInput): boolean {
  if (!input.stagedVerificationEnabled || input.dispositionContractRendered) return false;
  const recovery = input.recovery;
  if (!recovery.readable) return false;
  const record = recovery.record;
  if (record === undefined || record.continuation !== "verification" || record.runId === undefined) return false;
  const dirty = input.activeDirtyContinuation;
  if (dirty === undefined) return false;
  return typeof dirty.runId === "string" && dirty.runId === record.runId;
}
