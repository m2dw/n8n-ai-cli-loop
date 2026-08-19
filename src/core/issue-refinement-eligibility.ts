/**
 * Chain-aware progressive Issue refinement — the INTAKE-side predecessor gate
 * (issue #967, docs/issue-refinement-contract.md §4, §12 row 4).
 *
 * §4 already says a predecessor-ineligible Issue is *held* and re-evaluated on
 * the next poll. What it did not say was where that hold lives, and the first
 * implementation put it in the phase handler: intake admitted a `queued`
 * refinement task, the runner claimed it, the handler read the predecessors,
 * refused with `predecessor_not_ready`, and delayed the row by
 * {@link REFINEMENT_RETRY_DELAY_MS} (15 minutes). One held Issue costs one
 * worker turn every fifteen minutes; six of them, against a five-minute poll
 * cadence, cost a turn on nearly every tick — and because those rows are
 * created milliseconds before the chain root's own implementation task, the
 * claim order (priority, then creation time) hands them the worker first and
 * the runnable work behind them never starts.
 *
 * The gate therefore moves in front of the claim: this module answers §4
 * conditions 2–5 from the same read-only port the snapshot builder uses, and
 * intake persists the answer as a NON-RUNNABLE (`blocked`) refinement row
 * instead of a claimable one. Three properties make that safe:
 *
 *  - **It never converts a handoff into a hold.** §4's guard order is
 *    normative *because* the three structural failures are not fixed by
 *    waiting. This module reproduces that order and reports a structural
 *    failure as {@link RefinementIntakeEligibility} `structural`, which intake
 *    treats exactly as it treats an eligible Issue: admit a claimable task, so
 *    the handler raises the handoff a human has to see.
 *  - **It never guesses.** Any provider read that throws is `undetermined`,
 *    and intake changes no persisted state for it — it neither holds a
 *    runnable row nor releases a held one. The pre-#967 behavior (admit, let
 *    the handler hold) is what an undetermined answer falls back to for an
 *    Issue that has no row yet, so a broken relationship query degrades to the
 *    old cost rather than to a wrong decision.
 *  - **It is a scheduling gate, not the authority.** The handler's own
 *    evaluation is unchanged and still runs on every claim, so a predecessor
 *    that becomes unusable between this poll and the phase run is still
 *    refused there (§4 "every negative answer fails closed"). This module only
 *    decides whether the row is worth claiming at all.
 */

import type { BlockedByEntry } from "./github-intake.js";
import type {
  RefinementChainAgreement,
  RefinementIssueRead,
  RefinementPredecessorHold,
  RefinementPullRequestLookup,
  RefinementSnapshotSource,
} from "./issue-refinement-snapshot.js";
import {
  classifyPredecessorUsability,
  directPredecessorNumbers,
} from "./issue-refinement-snapshot.js";
import type { AiTask, TaskStatus } from "./task.js";

/**
 * The reads §4 conditions 2–5 need, and nothing else.
 *
 * A structural subset of {@link RefinementSnapshotSource}, so the production
 * adapter the handler already builds satisfies it without a second
 * implementation — and so this gate can never reach a capture read (comments,
 * changed paths, the issue plan) that would make an intake poll as expensive as
 * a snapshot.
 */
export type RefinementEligibilitySource = Pick<
  RefinementSnapshotSource,
  "getBlockedBy" | "readIssue" | "readPullRequest" | "readChainAgreement"
>;

/** §4's three structural failures, in the order the guard list checks them. */
export type RefinementStructuralReason =
  | "not_chain_scoped"
  | "fan_in_exceeded"
  | "chain_disagreement";

/**
 * What one intake-side evaluation of §4 conditions 2–5 concluded.
 *
 * `structural` deliberately does NOT carry a disposition of its own: intake
 * admits a claimable task for it, because only the handler may raise the §13
 * handoff those rows need.
 */
export type RefinementIntakeEligibility =
  /** §4 condition 4 passes for every predecessor — row 3's guard, as far as intake can see it. */
  | { kind: "eligible"; predecessorIssueNumbers: number[] }
  /** Rows 5/6/7 — the handler must run so a human gets the handoff. */
  | {
      kind: "structural";
      reason: RefinementStructuralReason;
      predecessorIssueNumbers: number[];
      detail?: string;
    }
  /** Row 4 — at least one predecessor satisfies neither §4 shape. */
  | {
      kind: "hold";
      reason: "predecessor_not_ready";
      predecessorIssueNumbers: number[];
      holds: RefinementPredecessorHold[];
    }
  /** A provider read failed. Never a verdict; intake leaves persisted state alone. */
  | { kind: "undetermined"; stage: "blocked_by" | "issue" | "pull_request" | "chain"; detail: string };

export interface EvaluateRefinementIntakeEligibilityInput {
  issueNumber: number;
  source: RefinementEligibilitySource;
  /** `session.labels.stackReady`, exactly as the handler resolves it. */
  stackReadyLabel: string;
  /** §8 `maxPredecessorsPerRefinement`, from the session's resolved limits. */
  maxPredecessorsPerRefinement: number;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Evaluate §4 conditions 2–5 for one marked Issue, in §4's normative order.
 *
 *  1. no direct predecessor        → structural `not_chain_scoped`   (row 7)
 *  2. more than the fan-in cap     → structural `fan_in_exceeded`    (row 5)
 *  3. chain registry disagrees     → structural `chain_disagreement` (row 6)
 *  4. any predecessor not usable   → hold `predecessor_not_ready`    (row 4)
 *  5. otherwise                    → eligible                        (row 3)
 *
 * The order is the whole point of running the structural guards here at all:
 * evaluating condition 4 first and holding on it would bury an Issue that needs
 * a human under a hold no poll can ever clear — the failure §4 calls out by
 * name. It reuses {@link classifyPredecessorUsability} rather than restating
 * the two usable shapes, so this gate and the handler's capture can never
 * disagree about what "usable" means.
 */
export async function evaluateRefinementIntakeEligibility(
  input: EvaluateRefinementIntakeEligibilityInput,
): Promise<RefinementIntakeEligibility> {
  const { issueNumber, source, stackReadyLabel, maxPredecessorsPerRefinement } = input;

  let blockedBy: readonly BlockedByEntry[];
  try {
    blockedBy = await source.getBlockedBy(issueNumber);
  } catch (err) {
    return { kind: "undetermined", stage: "blocked_by", detail: errorText(err) };
  }

  const predecessorIssueNumbers = directPredecessorNumbers(blockedBy);
  if (predecessorIssueNumbers.length === 0) {
    return { kind: "structural", reason: "not_chain_scoped", predecessorIssueNumbers: [] };
  }
  if (predecessorIssueNumbers.length > maxPredecessorsPerRefinement) {
    return {
      kind: "structural",
      reason: "fan_in_exceeded",
      predecessorIssueNumbers,
      detail:
        `${predecessorIssueNumbers.length} direct predecessors; the cap is ` +
        `${maxPredecessorsPerRefinement}`,
    };
  }

  if (source.readChainAgreement) {
    let agreement: RefinementChainAgreement;
    try {
      agreement = await source.readChainAgreement(issueNumber, predecessorIssueNumbers);
    } catch (err) {
      return { kind: "undetermined", stage: "chain", detail: errorText(err) };
    }
    if (agreement.kind === "disagrees") {
      return {
        kind: "structural",
        reason: "chain_disagreement",
        predecessorIssueNumbers,
        ...(agreement.detail !== undefined ? { detail: agreement.detail } : {}),
      };
    }
  }

  const holds: RefinementPredecessorHold[] = [];
  for (const predecessor of predecessorIssueNumbers) {
    let issue: RefinementIssueRead;
    try {
      issue = await source.readIssue(predecessor);
    } catch (err) {
      return { kind: "undetermined", stage: "issue", detail: errorText(err) };
    }
    let lookup: RefinementPullRequestLookup;
    try {
      lookup = await source.readPullRequest(predecessor);
    } catch (err) {
      return { kind: "undetermined", stage: "pull_request", detail: errorText(err) };
    }
    const verdict = classifyPredecessorUsability(issue, lookup, stackReadyLabel);
    if (verdict.kind === "unusable") holds.push(verdict.hold);
  }

  if (holds.length > 0) {
    return { kind: "hold", reason: "predecessor_not_ready", predecessorIssueNumbers, holds };
  }
  return { kind: "eligible", predecessorIssueNumbers };
}

// ---------------------------------------------------------------------------
// The persisted hold
// ---------------------------------------------------------------------------

/**
 * Task-context key under which intake records WHY a refinement row is parked
 * non-runnable.
 *
 * A sibling of `refinementExecutionConflict` (§3.1) and deliberately NOT a
 * field of the §15 block: §1's state set is closed, the held row is still
 * `pending` (nothing about the lane has run), and inventing a state for a
 * scheduling decision would make the state literal mean two different things.
 * It is also the reactivation key — only a row carrying it was parked BY this
 * gate, so only a row carrying it is ever released by it.
 */
export const REFINEMENT_PREDECESSOR_HOLD_KEY = "refinementPredecessorHold";

/** What {@link REFINEMENT_PREDECESSOR_HOLD_KEY} carries: literals and counters only (§15). */
export interface RefinementPredecessorHoldRecord {
  reason: "predecessor_not_ready";
  /** The direct predecessor set observed when the hold was recorded. */
  predecessorIssueNumbers: number[];
  /** Which of them were unusable, and why (§12 row 4 detail literals). */
  holds: RefinementPredecessorHold[];
  /** The status the row carried before it was parked; `undefined` when it was created parked. */
  previousStatus?: TaskStatus;
  heldAt: string;
}

export function buildRefinementPredecessorHold(input: {
  eligibility: Extract<RefinementIntakeEligibility, { kind: "hold" }>;
  previousStatus?: TaskStatus;
  now: string;
}): RefinementPredecessorHoldRecord {
  return {
    reason: "predecessor_not_ready",
    predecessorIssueNumbers: [...input.eligibility.predecessorIssueNumbers],
    holds: input.eligibility.holds.map((h) => ({ ...h })),
    ...(input.previousStatus !== undefined ? { previousStatus: input.previousStatus } : {}),
    heldAt: input.now,
  };
}

/**
 * Read a persisted hold record, tolerantly — the same discipline
 * `readRefinementContextBlock` applies: anything object-shaped carrying the one
 * reason literal is returned as-is, anything else is reported absent rather
 * than defaulted.
 */
export function readRefinementPredecessorHold(
  context: Record<string, unknown> | undefined,
): RefinementPredecessorHoldRecord | undefined {
  const raw = context?.[REFINEMENT_PREDECESSOR_HOLD_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  if ((raw as Record<string, unknown>)["reason"] !== "predecessor_not_ready") return undefined;
  return raw as RefinementPredecessorHoldRecord;
}

/** The `lastError` a held row carries, so `admin status` says why it is parked. */
export function describeRefinementPredecessorHold(
  record: RefinementPredecessorHoldRecord,
): string {
  const detail = record.holds
    .map((h) => `#${h.issueNumber} ${h.reason}${h.detail ? ` (${h.detail})` : ""}`)
    .join(", ");
  return (
    `Refinement held: predecessor_not_ready — ${detail || "no usable predecessor"}. ` +
    "Re-evaluated by the next intake poll."
  );
}

// ---------------------------------------------------------------------------
// The intake disposition
// ---------------------------------------------------------------------------

/**
 * What intake should DO with a marked Issue, given this poll's eligibility
 * answer and the task row (if any) the Issue already owns.
 *
 *  - `admit` — the pre-#967 path, unchanged: create the claimable `refinement`
 *    row, replace a row the Issue left behind in another lane, or find this
 *    lane's row already there and write nothing.
 *  - `hold` — the same create/replace, but parked: the row is written
 *    `blocked`, so it is never claimable and never costs a worker turn.
 *  - `hold_existing` — park the claimable row this poll found. This is the
 *    reconciliation path for rows admitted before #967 and for a row the
 *    handler's own hold delayed back to `queued`.
 *  - `reactivate` — release a row THIS gate parked, now that §4 is satisfied.
 *  - `leave` — nothing to do; the persisted state is already correct.
 *
 * Pure, and total over the status set on purpose: every "do nothing" answer
 * below is a decision with a reason, not a fall-through. Note the asymmetry in
 * how the two non-hold answers are treated — `eligible` and `structural` both
 * produce `admit`, because a structural failure needs the handler to raise the
 * §13 handoff and only a claimable row can reach the handler.
 */
export type RefinementIntakeDisposition =
  | { kind: "admit" }
  | { kind: "hold"; eligibility: Extract<RefinementIntakeEligibility, { kind: "hold" }> }
  | { kind: "hold_existing"; eligibility: Extract<RefinementIntakeEligibility, { kind: "hold" }> }
  | { kind: "reactivate" }
  | { kind: "leave"; reason: RefinementIntakeLeaveReason };

export type RefinementIntakeLeaveReason =
  /** The row is already parked by this gate and §4 is still unsatisfied. */
  | "already_held"
  /** A provider read failed while this gate held the row; a non-answer releases nothing. */
  | "undetermined"
  /** A run owns the row (claimed/running), a human does (ready_for_human), or it is disposed of. */
  | "not_this_gate_s_row";

/**
 * The statuses at which intake may park a refinement row it did not create
 * parked.
 *
 * `claimed`/`running` are excluded because a run owns the row: parking it would
 * race that run's own completion CAS, and the handler's evaluation — which sees
 * fresher reads than this poll did — is the authority while it holds the claim.
 * Every other status is either terminal or a human handoff, and this gate never
 * touches those.
 */
const PARKABLE_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>(["queued"]);

/** Statuses at which a row of ANOTHER lane is still live, so this gate leaves it alone. */
const LIVE_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  "queued",
  "claimed",
  "running",
]);

export function decideRefinementIntakeDisposition(input: {
  eligibility: RefinementIntakeEligibility;
  /** The row the Issue already owns, whichever lane it belongs to. */
  existing: Pick<AiTask, "status" | "phase" | "context"> | undefined;
}): RefinementIntakeDisposition {
  const { eligibility, existing } = input;
  const held =
    existing !== undefined && existing.phase === "refinement" && existing.status === "blocked"
      ? readRefinementPredecessorHold(existing.context)
      : undefined;

  if (eligibility.kind === "undetermined") {
    // A non-answer releases nothing this gate is holding. Everywhere else it
    // falls back to the pre-#967 path, so a broken relationship query costs
    // what it always cost — the handler claims the row and holds it — rather
    // than parking an Issue on a decision that was never made.
    return held !== undefined ? { kind: "leave", reason: "undetermined" } : { kind: "admit" };
  }

  if (eligibility.kind === "hold") {
    if (held !== undefined) return { kind: "leave", reason: "already_held" };
    if (existing === undefined) return { kind: "hold", eligibility };
    if (existing.phase === "refinement") {
      return PARKABLE_STATUSES.has(existing.status)
        ? { kind: "hold_existing", eligibility }
        : { kind: "leave", reason: "not_this_gate_s_row" };
    }
    // A row the Issue left behind in another lane. It is replaced by this
    // lane's row exactly as an admission would replace it — parked, because the
    // predecessors that would make it runnable are not ready. A row that is
    // still live there belongs to the §3.1 guard, not to this one.
    return LIVE_STATUSES.has(existing.status)
      ? { kind: "leave", reason: "not_this_gate_s_row" }
      : { kind: "hold", eligibility };
  }

  // `eligible` and `structural` both mean "let the handler have it": one so the
  // lane runs, the other so the handoff is raised.
  if (held !== undefined) return { kind: "reactivate" };
  return { kind: "admit" };
}
