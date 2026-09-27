/**
 * Issue #840: the durable half of the review-dispute transition layer
 * (docs/review-dispute-contract.md §7, §7.1, §10.1, §10.3).
 *
 * `applyDisputeTransition` decides what the task's §10.1 block looks like after
 * an approved decision. This module writes it — once, atomically, with exactly
 * one bounded task event, through the CAS/transaction boundary that already
 * exists for a phase completion (`TaskStore.completePhaseWithEffects`, issue
 * #701). It issues no separate `transitionTask` + `appendEvent` pair and never
 * touches SQLite itself, which is what makes the three guarantees testable
 * against BOTH store implementations:
 *
 *  - a successful transition commits the task patch and its one event together;
 *  - a CAS/claim-loss conflict commits neither;
 *  - a duplicate delivery writes nothing at all — no counter moves and no second
 *    event is appended — and still reports the same routing intent, so a retried
 *    worker delivery routes identically to the first.
 *
 * What travels here is the protocol state, its literals-only audit record, and
 * — since issue #848 — the bounded §11 public effect the transition authorizes,
 * when it authorizes one. The effect list stays a caller-supplied value rather
 * than something this layer derives: §11 decides WHAT may be published
 * (review-dispute-publication.ts), and this layer decides only that whatever was
 * authorized commits with the transition or not at all.
 *
 * Routing is part of that durable write, not a hint — and it is checked against
 * what this runner can actually dispatch. A §7.1 turn whose run has no
 * production dispatcher parks the task for a human instead of being queued into
 * a phase that cannot discharge it; every current turn has one (the evidence
 * turn gained its dispatcher in issue #964), so the check is the standing guard
 * for a turn added before its dispatcher; see {@link routingLacksDispatcher}.
 *
 * A phase run reaches the same guarantees without a second transaction: the
 * runner folds `disputeContextPatch`, `disputeTransitionEvent`, and
 * `routedPhaseCompletion` into the `completePhaseWithEffects` call it was
 * already issuing for the completion (phase-runner.ts). `commitDisputeTransition`
 * is the standalone form for a caller that has no completion of its own.
 */

import type { AiTask, TaskEvent, TaskExpected, TaskKey, TaskPatch, TaskPhase, TaskStatus } from "./task.js";
import type { OutboxEffect, TaskStore } from "./task-store.js";
import type { DisputeTaskRouting, DisputeTransitionApplication } from "./review-dispute-transition.js";

/** The task-context key the §10.1 block lives under. */
export const REVIEW_DISPUTE_CONTEXT_KEY = "reviewDispute";

/** The one task event a committed transition appends (§10.3). */
export const REVIEW_DISPUTE_TRANSITION_EVENT = "review.dispute.transition";

export interface DisputeCommitInput {
  store: TaskStore;
  key: TaskKey;
  /**
   * The CAS guard, exactly as a phase completion states it — the claim this run
   * holds. A concurrent cancellation, requeue, or competing claim moves one of
   * these fields, the completion loses, and nothing is written.
   */
  expected: TaskExpected;
  /** `applyDisputeTransition`'s value, computed against this task's CURRENT block. */
  application: DisputeTransitionApplication;
  /** The run applying it; recorded on the event, never in the context block. */
  runId: string;
  now: string;
  /**
   * Whether the §7.1 routing intent drives the task lifecycle — `status`,
   * `phase`, and the claim this run holds. Default true.
   *
   * Set false when the caller already owns that decision (the phase runner
   * computes the completion's own transition, claim release included) and only
   * the protocol block and its event should be committed.
   */
  applyRouting?: boolean;
  /**
   * Extra patch fields the caller owns. They win over the routing-derived ones —
   * with one exception: `context[REVIEW_DISPUTE_CONTEXT_KEY]` is always the
   * application's block, never the caller's, so the committed block and the
   * event describing it cannot disagree.
   */
  patch?: TaskPatch;
  /** Overrides the event type; the default is the §10.3 transition event. */
  eventType?: string;
  /**
   * Issue #848: the §11 public effect(s) this transition authorizes, committed
   * in the SAME transaction as the context patch and the audit event.
   *
   * Narrow on purpose. The caller passes a value it built from the typed
   * `application` above ({@link publishableDisputeOutcomes}), never from a later
   * rescan of the database, and this layer neither inspects nor filters it: what
   * may be published is §11's question and is answered before the call. What
   * this layer guarantees is the transactional half — the same guarantee the
   * patch and the event already had, now extended to the comment:
   *
   *  - a replayed delivery returns `duplicate` before the write is assembled, so
   *    no effect is enqueued for a transition that changes nothing;
   *  - a lost CAS, a rolled-back transition, or a held maintenance lock commits
   *    the effects no more than it commits the patch, because
   *    `completePhaseWithEffects` writes all three inside one transaction;
   *  - nothing is enqueued after the transaction has committed, which is the
   *    ordering that would otherwise leave a public comment announcing a
   *    transition that never landed.
   *
   * A phase run reaches the same guarantee through the completion it was already
   * issuing (phase-runner.ts collects the same effects into that transaction).
   */
  effects?: OutboxEffect[];
  /**
   * Further bounded events belonging to this same write — an operator action's
   * audit record, for instance — committed alongside the §10.3 transition event.
   *
   * The §10.3 event stays mandatory and is never replaced by one of these: an
   * operator-initiated transition is still a protocol transition and must leave
   * the same audit record any other one does.
   */
  extraEvents?: TaskEvent[];
}

export type DisputeCommitOutcome =
  /** The patch and its event are durable. */
  | { status: "applied"; task: AiTask; event: TaskEvent }
  /** This delivery was already on file: nothing was written, routing is unchanged. */
  | { status: "duplicate"; routing: DisputeTaskRouting }
  /** The CAS guard no longer holds — neither the patch nor the event committed. */
  | { status: "claim_lost"; current?: AiTask }
  /** A whole-file maintenance lock refused the write in full (issue #818). */
  | { status: "maintenance_locked" };

/**
 * The §7.1 turns this runner can actually dispatch today.
 *
 *  - `implementer` — rule 2's fix run: today's `needs_fix` routing, the
 *    implementation phase handler, which reads the §10.1 block and carries the
 *    open/binding lineages into its prompt.
 *  - `reviewer` — rule 2's reconsideration run (issue #952). It names the
 *    `review` phase but is NOT an ordinary review, and the review handler
 *    dispatches it as an internal sub-turn BEFORE it builds the generic review
 *    prompt (`handlers/review-reconsideration-turn.ts`): a `disputed` lineage
 *    reaches #838's invocation, never the review agent. The two cannot drift
 *    apart silently — that handler's gate has no fall-through for a `disputed`
 *    lineage, so a review run that somehow reached one parks instead of
 *    discharging it.
 *  - `runner` — rule 2's arbitration turn (issue #955). §7.1 dispatches no agent
 *    run of the debate's own parties for it — "the runner advances arbitration
 *    between runs" — but the runner that advances it is a phase run, and the
 *    review handler takes it as an internal sub-turn before it builds the generic
 *    review prompt (`handlers/review-arbitration-subturn.ts`): the ARBITER #839
 *    selected runs, never the review agent, and the routed §7 row is applied
 *    through #840 in the completion's own transaction.
 *  - `evidence` — rule 2's dual-party evidence round (issue #964). It names the
 *    `review` phase and the review handler takes it as an internal sub-turn on
 *    the same terms: #963's per-party collection runner
 *    (`handlers/review-evidence-turn.ts`) runs ONE missing party per phase run,
 *    the partial round persists in the completion, and the phase requeues for
 *    the remaining party until #951 synthesizes row 22 from the pair. A review
 *    run that cannot assemble the party runtime parks through the gate's own
 *    fail-closed path rather than falling through to an ordinary review.
 *  - `re_review` — rule 3: the accumulated diff back to the ordinary review
 *    phase handler, which is exactly what that handler does.
 *  - `none` — rules 4 and the §13 legacy path: no protocol turn at all, so the
 *    caller's ordinary review result stands.
 *
 * Every other turn names a run that has no production dispatcher in this
 * codebase; see {@link routingLacksDispatcher}.
 */
export const DISPATCHABLE_DISPUTE_TURNS: readonly DisputeTaskRouting["turn"][] = [
  "implementer",
  "reviewer",
  "evidence",
  "runner",
  "re_review",
  "none",
];

/**
 * §7.1 turns whose run nothing here dispatches — the fail-closed half of
 * routing.
 *
 * The set is empty today, and the predicate stays: it is what keeps a turn
 * added to §7.1 before its dispatcher exists from being queued into a handler
 * that cannot discharge it. Every turn that was ever here left the same way.
 * The reviewer turn is a **reconsideration** run, not an ordinary review — its
 * prompt carries the pending dispute records and it returns §4 reconsideration
 * records — so routing it onto `review` was unsafe for exactly as long as the
 * review handler had only its ordinary path; issue #952 gave that handler an
 * internal sub-turn that runs #838's invocation before the generic review prompt
 * is built. Issue #955 did the same for the runner turn: the arbiter #839
 * selected is invoked through #846, its verdict is routed to one §7 row by #847,
 * and the row is applied through #840 in the completion's own transaction. Issue
 * #964 closed the set with the evidence turn: #963's per-party collection runner
 * is registered by the same gate, one party per review-phase run, with the round
 * record deciding which party is still owed.
 *
 * While a turn IS undispatchable, the safe destination is a human, not a guess:
 * queueing an ordinary review run risks the WRONG handler discharging the
 * dispute, and holding the task `blocked` risks a valid dispute sitting
 * non-runnable forever with nothing scheduled to wake it. So the task parks as
 * `ready_for_human` — the §9 handoff this contract already uses whenever a
 * required route cannot proceed safely — with the §10.1 block committed
 * unchanged in the same transaction. The lineage keeps its real state, no
 * counter is spent on the park, and the debate resumes exactly where it stopped
 * once a dispatcher lands or an operator acts on it.
 *
 * Rule 1 is excluded because it is already going to a human on its own terms;
 * this predicate answers only "is the turn's run dispatchable".
 */
export function routingLacksDispatcher(routing: DisputeTaskRouting): boolean {
  if (routing.readyForHuman) return false;
  return !DISPATCHABLE_DISPUTE_TURNS.includes(routing.turn);
}

/**
 * The single "this task goes to a human" test: §7.1 rule 1's escalation, plus
 * any turn this runner cannot dispatch ({@link routingLacksDispatcher}).
 *
 * Both callers below route through this one predicate so the standalone commit
 * and a folded phase completion cannot disagree about which runs park.
 */
export function routingRequiresHumanHandoff(routing: DisputeTaskRouting): boolean {
  return routing.readyForHuman || routingLacksDispatcher(routing);
}

/**
 * §7.1, as the task fields it can legitimately move.
 *
 * Rule 1 parks the task for a human (§9). Rule 2 names the phase whose agent
 * takes the next turn — when that turn has a dispatcher; when it does not, the
 * task parks for a human as well rather than being queued into a handler that
 * cannot discharge it, see {@link routingLacksDispatcher}. Rule 3 returns the
 * accumulated diff to review. Rule 4 and the §13 legacy path move nothing: they
 * route through the ordinary review result, unchanged — the caller still owns
 * that completion's lifecycle, and this patch stays empty rather than
 * half-completing it.
 *
 * Whenever routing DOES name a destination — or parks the task — it also
 * completes the claim, exactly as an ordinary phase completion does
 * (phase-runner.ts): the routed run is over, so its `ownerRunId`/
 * `leaseExpiresAt` are released and a re-routed task returns to `queued`. Moving
 * `phase` alone would leave the task claimed/running with the completed run as
 * its owner, and `claimNextTask` would never dispatch the phase this rule just
 * selected.
 */
export function routingTaskPatch(routing: DisputeTaskRouting): TaskPatch {
  // Checked before the phase branch: the reviewer turn names `review`, and that
  // destination is precisely the one that must not be queued.
  if (routingRequiresHumanHandoff(routing)) {
    return { status: "ready_for_human", ownerRunId: undefined, leaseExpiresAt: undefined };
  }
  if (routing.nextPhase !== null) {
    return { status: "queued", phase: routing.nextPhase, ownerRunId: undefined, leaseExpiresAt: undefined };
  }
  return {};
}

/**
 * §7.1 applied to a completion a caller ALREADY decided.
 *
 * The phase runner reaches this rather than {@link routingTaskPatch}: its own
 * `nextPhaseAfter` result is the fallback for rules 3 and 4 and the §13 legacy
 * path, which move nothing of their own, while rules 1 and 2 override it. Claim
 * release is the caller's — every phase completion clears `ownerRunId` and
 * `leaseExpiresAt` already — so only `status`/`phase` are decided here.
 *
 * A human escalation parks the task on the phase that just RAN, not on the one
 * the completion was routing to: that is where an operator resumes, and it is
 * the same shape `nextPhaseAfter` uses for its own `blocked`/`tool_request`
 * handoffs. An undispatchable turn ({@link routingLacksDispatcher}) parks it the
 * same way and for the same reason — critically NOT on `nextPhaseAfter`'s review
 * destination, which would let an ordinary review run finish a task whose
 * arbitration or evidence round never happened.
 */
export function routedPhaseCompletion(
  routing: DisputeTaskRouting,
  fallback: { status: TaskStatus; phase: TaskPhase },
  completedPhase: TaskPhase,
): { status: TaskStatus; phase: TaskPhase } {
  if (routingRequiresHumanHandoff(routing)) return { status: "ready_for_human", phase: completedPhase };
  if (routing.nextPhase !== null) return { status: "queued", phase: routing.nextPhase };
  return fallback;
}

/** The context patch a committed transition writes: the §10.1 block, nothing else. */
export function disputeContextPatch(
  application: DisputeTransitionApplication,
  callerContext?: Record<string, unknown>,
): Record<string, unknown> {
  // Shallow-merged by `applyTaskPatch`, so naming only the protocol block
  // leaves every other context key exactly as the store holds it.
  //
  // The block is assigned LAST, after the caller's own context: a caller
  // merging its phase context (commonly `{ ...task.context, ... }`) carries the
  // PRE-transition block along with it, and letting that win would persist a
  // stale — or hand-built — §10.1 state while the event committed in the same
  // transaction still describes this application. Every other key is the
  // caller's.
  return { ...callerContext, [REVIEW_DISPUTE_CONTEXT_KEY]: application.context };
}

/** The one §10.3 event a committed transition appends. */
export function disputeTransitionEvent(input: {
  key: TaskKey;
  application: DisputeTransitionApplication;
  runId: string;
  now: string;
  eventType?: string;
}): TaskEvent {
  const routing = input.application.routing;
  return {
    task: input.key,
    type: input.eventType ?? REVIEW_DISPUTE_TRANSITION_EVENT,
    runId: input.runId,
    // Literals, counters, ids, and bounded reason tokens only (§10.3): no
    // argument prose, no evidence content, no absolute or artifact path.
    data: {
      ...input.application.event,
      // Why a task the protocol wanted to keep running parked for a human
      // anyway. One literal from `DISPUTE_TASK_TURNS`, present only when the
      // gate fires, so the audit record distinguishes a rule-1 escalation from
      // a turn this runner cannot dispatch yet.
      ...(routingLacksDispatcher(routing) ? { undispatchedTurn: routing.turn } : {}),
    },
    createdAt: input.now,
  };
}

/**
 * Commit one applied transition.
 *
 * The duplicate check comes FIRST and short-circuits the write entirely: a
 * replayed delivery must not append a second event, and an event is a durable
 * write like any other. Everything else goes through
 * `completePhaseWithEffects` with an empty effect list, so the patch and the
 * event share one transaction and one CAS.
 *
 * This is the standalone entry point — a caller with no completion of its own to
 * commit. A phase completion instead folds the same two pieces
 * ({@link disputeContextPatch}, {@link disputeTransitionEvent}) into the
 * transaction it was already going to issue; see `phase-runner.ts`.
 */
export async function commitDisputeTransition(input: DisputeCommitInput): Promise<DisputeCommitOutcome> {
  const application = input.application;
  if (application.replayed) {
    return { status: "duplicate", routing: application.routing };
  }

  const routingPatch = input.applyRouting === false ? {} : routingTaskPatch(application.routing);
  const patch: TaskPatch = {
    ...routingPatch,
    ...input.patch,
    context: disputeContextPatch(application, input.patch?.context),
    now: input.now,
  };
  const event = disputeTransitionEvent({
    key: input.key,
    application,
    runId: input.runId,
    now: input.now,
    eventType: input.eventType,
  });

  const committed = await input.store.completePhaseWithEffects(
    {
      key: input.key,
      expected: input.expected,
      patch,
      event,
      ...(input.extraEvents && input.extraEvents.length > 0 ? { extraEvents: input.extraEvents } : {}),
    },
    // Issue #848: the authorized §11 effects ride inside the same transaction as
    // the patch and the event. An empty list is still the common case — most
    // transitions resolve nothing publishable — and is exactly what #840 passed.
    input.effects ?? [],
  );
  if (committed.ok) return { status: "applied", task: committed.value, event };
  if (committed.code === "maintenance_locked") return { status: "maintenance_locked" };
  return { status: "claim_lost", current: committed.current };
}
