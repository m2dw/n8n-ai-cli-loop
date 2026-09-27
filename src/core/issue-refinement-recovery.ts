/**
 * Issue #980: §13's operator recovery command, as pure decisions
 * (docs/issue-refinement-contract.md §13, §12 row 36).
 *
 * §13 gives exactly one edge out of `escalated_human`, and it is deliberately
 * not automatic: nothing observes "the human fixed it", so the transition is an
 * explicit command. Everything that command has to DECIDE lives here — which
 * task rows it may act on, which label shapes it may act against, and what the
 * reset actually is — so the CLI shell around it (`cli/issue-refinement-recover`)
 * owns only I/O: the session, the store, the issue lock, the live label read,
 * and the commit.
 *
 * Two properties this module exists to keep:
 *
 *  - **Refusal is total.** Every precondition is evaluated BEFORE anything is
 *    written, and each one answers with its own literal, so a preview and an
 *    apply can never disagree about whether the row is recoverable and an apply
 *    can never be half-performed. §13: "applying against any other shape is
 *    refused rather than half-performed".
 *  - **The reset is a projection of the old block, not a fresh one.** Row 36
 *    keeps `context.assignment` and the applied-refinement record; rebuilding
 *    the block from admission inputs would drop the §10 trust record and make
 *    the retry escalate `unexpected_managed_region` against the lane's own
 *    write. So {@link planRefinementRecovery} spreads the failed attempt's block
 *    and clears named fields — anything a later slice adds to the block is
 *    carried forward by default, which is the safe direction for a reset that
 *    must not lose a trust record it does not know about.
 */

import type { AiTask } from "./task.js";
import { isClaimExpired } from "./transitions.js";
import type {
  RefinementContextBlock,
  RefinementCounters,
  RefinementHandoffReason,
} from "./issue-refinement.js";
import {
  DEFAULT_REFINEMENT_MARKER_LABEL,
  EXECUTABLE_STATUS_LABELS,
  readRefinementContextBlock,
} from "./issue-refinement.js";
import type { RefinementApplyContextBlock } from "./issue-refinement-apply.js";
import { recordedRefinementHandoffLabel } from "./issue-refinement-publication.js";

/** §15: the audit event row 36 emits. */
export const REFINEMENT_RECOVERY_EVENT = "refinement.recovery.applied";

/**
 * Why a task row cannot take row 36. Each literal names ONE precondition, so an
 * operator reading a refusal knows which thing to fix; a single "not
 * recoverable" answer would send them to read the contract instead.
 */
export type RefinementRecoveryRefusal =
  /** No task row for this session/Issue at all. */
  | "task_not_found"
  /** §13: the command targets `ready_for_human` only. */
  | "status_not_ready_for_human"
  /** §13: …at phase `refinement` only. */
  | "phase_not_refinement"
  /** The row carries no §15 block: it never entered this lane. */
  | "no_refinement_block"
  /** §13: …whose state is `escalated_human`. Includes an already-recovered row. */
  | "state_not_escalated_human"
  /** §13: "and so is a claimed or running task". */
  | "task_claimed";

/** Why the live label shape cannot take row 36 (§13's label precondition). */
export type RefinementRecoveryLabelRefusal =
  /** The row-1 marker is missing; recovery would return the row to `pending` with nothing to admit it. */
  | "marker_label_absent"
  /** An executable `status:*` label is on the Issue; row 2 refuses exactly this shape. */
  | "executable_status_label_present";

/** What the command observed on the Issue, reported by preview and by a refusal. */
export interface RefinementRecoveryLabelObservation {
  /** Every label the live Issue carries, as read. */
  labels: string[];
  /** The marker this session admits on (`session.labels.needsRefinement`). */
  markerLabel: string;
  markerPresent: boolean;
  /** The §1 executable statuses observed beside it; empty is the admissible shape. */
  executableStatusLabels: string[];
  /** `null` when the shape is admissible. */
  refusal: RefinementRecoveryLabelRefusal | null;
}

/**
 * Evaluate §13's label precondition — the row-1 admissible shape.
 *
 * Deliberately NOT `evaluateRefinementAdmission`: that also requires an
 * `agent:*` owner, because it is deciding whether to CREATE a task and resolve
 * `context.assignment` from labels. Recovery creates nothing and re-resolves
 * nothing (§14: "the assignment captured at admission is carried forward"), so
 * an Issue whose `agent:*` label was removed after admission still recovers —
 * the pinned owner lives in the block, not on the Issue.
 */
export function evaluateRefinementRecoveryLabels(
  labels: readonly string[],
  markerLabel: string = DEFAULT_REFINEMENT_MARKER_LABEL,
): RefinementRecoveryLabelObservation {
  const set = new Set(labels);
  const markerPresent = set.has(markerLabel);
  const executableStatusLabels = EXECUTABLE_STATUS_LABELS.filter((l) => set.has(l));
  // Marker first: an Issue missing the marker AND carrying an executable status
  // has been handed to another lane by hand, and "put the marker back" is the
  // wrong instruction for it — `admin recover --from ready_for_human --phase
  // implementation` is (issue #984; never `admin task cancel`, whose terminal
  // row implementation intake cannot reactivate). Reporting the absent marker
  // names the step §13 asks for either way, and the observation carries both
  // facts so the operator sees the whole shape.
  const refusal: RefinementRecoveryLabelRefusal | null = !markerPresent
    ? "marker_label_absent"
    : executableStatusLabels.length > 0
      ? "executable_status_label_present"
      : null;
  return { labels: [...labels], markerLabel, markerPresent, executableStatusLabels, refusal };
}

/** The task-side half of §13's preconditions, evaluated against one row. */
export type RefinementRecoveryTarget =
  | { ok: false; refusal: RefinementRecoveryRefusal; state?: string | undefined }
  | { ok: true; block: RefinementApplyContextBlock; handoffReason: RefinementHandoffReason | null };

/**
 * Decide whether this task row is the one §13 lets recovery act on.
 *
 * `now` is only used for the claim check: `ready_for_human` is not a claimed
 * status, but a row can still carry an `ownerRunId` and a live lease (a crash
 * between the handoff commit and the claim release, an operator inspecting a
 * row mid-run), and §13 refuses a claimed task. An EXPIRED lease is not a live
 * claim — that row is exactly what `admin recover` exists to unstick — so it
 * recovers.
 */
export function evaluateRefinementRecoveryTarget(
  task: AiTask | undefined,
  now: string,
): RefinementRecoveryTarget {
  if (!task) return { ok: false, refusal: "task_not_found" };
  // The block state outranks the status and the phase, because a recovery this
  // command already performed leaves the row `queued`/`pending`: answering that
  // one with `status_not_ready_for_human` would send the operator to "fix" a
  // status that is exactly right. The actionable fact is that the handoff is
  // already recovered, and only the state says so. A row whose state IS
  // `escalated_human` falls through to the task-shape checks unchanged, so the
  // wrong-status and wrong-phase refusals still name themselves.
  const block = readRefinementContextBlock(task.context);
  if (block && block.state !== "escalated_human") {
    return { ok: false, refusal: "state_not_escalated_human", state: block.state };
  }
  if (task.status !== "ready_for_human") {
    return { ok: false, refusal: "status_not_ready_for_human" };
  }
  if (task.phase !== "refinement") {
    return { ok: false, refusal: "phase_not_refinement" };
  }
  if (!block) return { ok: false, refusal: "no_refinement_block" };
  // A live claim is an owner AND an unexpired lease. An owner with no lease at
  // all is not one: a running phase always holds a lease it renews, so that
  // shape is a leftover, and refusing it would make the row unrecoverable by
  // any command — the hand-edited-SQLite dead end this command exists to remove.
  // The "still running" case is caught by the issue lock the caller holds, not
  // by this field.
  if (task.ownerRunId && task.leaseExpiresAt && !isClaimExpired(task, now)) {
    return { ok: false, refusal: "task_claimed" };
  }
  return {
    ok: true,
    block: block as RefinementApplyContextBlock,
    handoffReason: block.handoffReason ?? null,
  };
}

/** Empty §8 counters — what row 36 resets every counter to. */
function clearedCounters(): RefinementCounters {
  return {
    rounds: 0,
    malformedAttempts: { refiner: 0, critic: 0 },
    agentFailures: { refiner: 0, critic: 0 },
    staleRestarts: 0,
  };
}

/**
 * The number of §13 recoveries a block records, read tolerantly.
 *
 * Absent on every block written before this slice, and absent means zero — the
 * same absence-is-default migration every other optional §15 field takes.
 */
export function refinementRecoveryCount(block: RefinementContextBlock | undefined): number {
  // Read as `unknown`: the block comes back out of persisted task context, which
  // an older build or a hand edit can have written anything into.
  const value: unknown = block?.recoveries;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** One field the reset clears or keeps, as a literal a preview can print. */
export interface RefinementRecoveryReset {
  /** Block/task fields returned to their pre-attempt value. */
  cleared: string[];
  /** Fields row 36 names as surviving the reset. */
  preserved: string[];
}

export interface RefinementRecoveryPlan {
  /** The §15 block to persist: `pending`, no handoff reason, counters at zero. */
  block: RefinementApplyContextBlock;
  /** The reason the failed attempt stopped for, for the preview and the event. */
  previousHandoffReason: RefinementHandoffReason | null;
  /**
   * The ready-for-human label the failed attempt's handoff actually added, as
   * recorded on its block (issue #980 review), or `null` when the block predates
   * that record. It is what the removal this recovery enqueues must name: the
   * session's configured label can have been renamed since the escalation, and
   * the compensating removal has to name the label the add used, not the one
   * config happens to hold now.
   */
  previousHandoffLabel: string | null;
  /** 1-based ordinal of the recovery this plan performs (§16 attempt discriminator). */
  recoveries: number;
  reset: RefinementRecoveryReset;
}

/**
 * Build the row-36 reset for an escalated block.
 *
 * Pure and total: it neither reads nor validates the label shape (the caller
 * does, against the live Issue) and never fails — by the time it runs, the
 * target has already been accepted by
 * {@link evaluateRefinementRecoveryTarget}.
 *
 * What is deliberately KEPT, beyond what row 36 names:
 *
 *  - `appliedRefinements` — §10's trust record for a managed region this lane
 *    verifiably wrote. Clearing it is the one reset that would replace a stuck
 *    state with another one (§13).
 *  - `sourceFingerprint` / `managedRegion` — the target-side observations from
 *    admission. Neither is a snapshot: they are recomputed on the next capture,
 *    and they identify the Issue this row was admitted for.
 *  - `progressMilestones` — the #975 publication ledger. A retry crossing the
 *    same boundary as the failed attempt re-derives the same milestone id, so
 *    keeping the ledger keeps the Issue free of a second identical progress
 *    comment; a boundary the failed attempt never reached is not in it and
 *    publishes normally.
 *  - `activationPlan`, `roles`, `limits`, `markerLabel`, `admittedAt` — the
 *    admission record §14 requires the retry to reuse rather than re-resolve.
 */
export function planRefinementRecovery(input: {
  block: RefinementApplyContextBlock;
  now: string;
}): RefinementRecoveryPlan {
  const previous = input.block;
  const recoveries = refinementRecoveryCount(previous) + 1;
  // Destructured out rather than deleted: every one of these belongs to the
  // attempt that failed, and the next attempt re-derives it from a fresh
  // snapshot (§13, "the next refinement run captures a fresh predecessor
  // snapshot and starts with the refiner").
  const {
    accepted: _accepted,
    pendingRetry: _pendingRetry,
    execution: _execution,
    apply: _apply,
    // §5.2 (issue #1003): the evidence gate belongs to the attempt that
    // stopped. The retry re-captures the declaration and the evidence from
    // scratch, so a stale gate record would describe a snapshot that no longer
    // exists — and an operator who fixed the declaration would still see the
    // old gaps on the requeued row.
    evidenceGate: _evidenceGate,
    // §15 (issue #1176): the same holds for the critic's recorded block — it
    // names the blocker of the attempt that stopped, not of the retry.
    criticBlock: _criticBlock,
    ...retained
  } = previous;
  const block: RefinementApplyContextBlock = {
    ...retained,
    state: "pending",
    handoffReason: null,
    // Cleared with the reason it belongs to: the label it names has just been
    // scheduled for removal, so leaving it on a `pending` block would make a
    // later recovery compensate for an add that is no longer outstanding.
    handoffLabel: null,
    predecessorFingerprint: null,
    appliedRegionDigest: null,
    predecessors: [],
    counters: clearedCounters(),
    recoveries,
    updatedAt: input.now,
  };
  return {
    block,
    previousHandoffReason: previous.handoffReason ?? null,
    previousHandoffLabel: recordedRefinementHandoffLabel(previous),
    recoveries,
    reset: {
      cleared: [
        "refinement.state → pending",
        "refinement.handoffReason",
        "refinement.handoffLabel",
        "refinement.predecessorFingerprint",
        "refinement.appliedRegionDigest",
        "refinement.predecessors",
        "refinement.counters (rounds, malformed, agent failures, stale restarts)",
        "refinement.accepted",
        "refinement.evidenceGate",
        "refinement.criticBlock",
        "refinement.pendingRetry",
        "refinement.execution",
        "refinement.apply",
        "task.status → queued",
        "task.phase → refinement",
        "task.notBefore",
        "task.ownerRunId",
        "task.leaseExpiresAt",
        "task.lastError",
      ],
      preserved: [
        "context.assignment",
        "refinement.appliedRefinements",
        "refinement.activationPlan",
        "refinement.roles",
        "refinement.limits",
        "refinement.markerLabel",
        "refinement.sourceFingerprint",
        "refinement.progressMilestones",
        `${previous.markerLabel ?? DEFAULT_REFINEMENT_MARKER_LABEL} (the Issue marker is never touched)`,
      ],
    },
  };
}

/**
 * The idempotency key of the label removal one recovery publishes.
 *
 * Keyed on the session, the Issue, and the recovery ordinal — never on a run id
 * and never on a timestamp. The command is `--yes`-gated and one-shot, but its
 * commit can lose the CAS and be re-run, and an operator can legitimately run
 * it again after a later handoff: the ordinal is what makes the second recovery
 * a second row instead of a duplicate the outbox swallows.
 */
export function refinementRecoveryIdempotencyKey(input: {
  sessionId: string;
  issueNumber: number;
  recoveries: number;
}): string {
  return [
    input.sessionId,
    String(input.issueNumber),
    "refinement-recovery",
    String(input.recoveries),
    "label-remove",
  ].join(":");
}

/** The `refinement.recovery.applied` event payload (§15). */
export function refinementRecoveryEvent(input: {
  issueNumber: number;
  previousHandoffReason: RefinementHandoffReason | null;
  recoveries: number;
  markerLabel: string;
}): { type: string; data: Record<string, unknown> } {
  return {
    type: REFINEMENT_RECOVERY_EVENT,
    data: {
      issueNumber: input.issueNumber,
      refinementState: "pending",
      previousState: "escalated_human",
      previousHandoffReason: input.previousHandoffReason,
      recoveries: input.recoveries,
      markerLabel: input.markerLabel,
    },
  };
}
