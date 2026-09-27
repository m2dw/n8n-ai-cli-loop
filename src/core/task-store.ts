import type {
  AiTask,
  ClaimNextTaskRequest,
  EnqueueTaskInput,
  StoreResult,
  TaskEvent,
  TaskExpected,
  TaskKey,
  TaskPatch,
  TaskPhase,
  TaskStatus,
} from "./task.js";
import type { OutboxEnqueueInput } from "./outbox.js";

/** Enqueue a fresh outbox row (mirrors {@link OutboxStore.enqueue}). */
export interface OutboxEffectEnqueue {
  kind: "enqueue";
  input: OutboxEnqueueInput;
}

/** Supersede pending PR-summary rows and insert (mirrors {@link OutboxStore.replacePendingPrSummary}). */
export interface OutboxEffectReplacePendingPrSummary {
  kind: "replacePendingPrSummary";
  input: OutboxEnqueueInput;
  key: { owner: string; repo: string; prNumber: number; marker: string };
}

/**
 * Retire every UNSENT row carrying `idempotencyKey`, so an effect a transition
 * is about to contradict can never be delivered after it (issue #980 review).
 *
 * The one producer today is §13's refinement recovery: the handoff it undoes
 * enqueued a ready-for-human label ADD, and a row that failed once is sitting
 * delayed behind its backoff. Enqueueing only the compensating REMOVE is not
 * enough — the remove can dispatch first and the add's retry then re-applies a
 * "needs a human" label to a task that is queued again — so the add has to be
 * retired in the same transaction that requeues the task, not compensated for
 * afterwards.
 *
 * Deliberately "cancel", not "delete": the row keeps its failure history for
 * `admin outbox list`, is excluded from dispatch selection exactly as an
 * operator's `admin outbox cancel` would exclude it, and stays revivable by
 * `admin outbox retry` if the cancellation later turns out to be wrong. A row
 * already sent, already cancelled, or simply absent is left alone — this is a
 * "make sure it will not be delivered" instruction, not an assertion that a row
 * exists.
 *
 * Unlike {@link OutboxStore.cancelEntry}, a row a dispatch attempt currently
 * holds a claim on IS cancelled. That command must refuse it, because it reports
 * to an operator whether the side effect was stopped; here what must not survive
 * is the RETRY, and a concurrent `markFailed` only writes `next_attempt_at`, so
 * it cannot revive a row this cancelled.
 *
 * Cancelling a CLAIMED row does not, by itself, order the attempt already on the
 * wire against the compensating row's own future dispatch: an add whose HTTP
 * call lands after the remove dispatched leaves the label on, `markSent` accepts
 * the claimed row afterwards, and nothing schedules a second removal. That is
 * what {@link OutboxEffectCancelPending.refuseWhileClaimed} exists for.
 */
export interface OutboxEffectCancelPending {
  kind: "cancelPending";
  idempotencyKey: string;
  /** Cancellation timestamp; defaults to the store's own clock. */
  now?: string;
  /**
   * Refuse the WHOLE compound write — nothing cancelled, no transition, no
   * event — when a row carrying this key is being dispatched right now, i.e.
   * holds a claim that is not yet stale (issue #980 review).
   *
   * Without it, cancelling a claimed row stops the retry but cannot abort the
   * request in flight. If the compensating effect committed beside it dispatches
   * before that request completes, the contradicted side effect lands last and
   * stays: the add re-applies `ready-for-human` after the remove already took it
   * off, `markSent` accepts the claimed row, and no later removal is scheduled.
   * Refusing while the claim is live is what makes the pair ordered — the
   * dispatcher's next claim of that row is impossible once the cancellation
   * commits (`claimForDispatch` requires `cancelled_at IS NULL`), so the two
   * writes can only serialize one way.
   *
   * Opt-in per effect, because refusing is only the right answer for a caller
   * that can simply be re-run: §13's `admin refinement recover` is an operator
   * command whose refusal is "try again in a moment", while a phase completion
   * carrying the mirror-image cancellation must commit — re-running the phase to
   * dodge a claim it merely raced would cost far more than the divergence.
   *
   * Enforced by stores that apply this effect INSIDE the transition's own
   * transaction (`SqliteTaskStore`). The portable fallbacks — a store with
   * no shared transaction domain, `cancelPendingOutboxEntriesByKey` — cannot
   * refuse a write they have already begun; they leave a claimed row to its
   * attempt instead, so producers that need this guarantee must commit through
   * the task store.
   */
  refuseWhileClaimed?: boolean;
}

/**
 * A single outbox write produced by a phase completion, queued for
 * {@link TaskStore.completePhaseWithEffects} to commit alongside the task
 * transition (issue #701).
 */
export type OutboxEffect =
  | OutboxEffectEnqueue
  | OutboxEffectReplacePendingPrSummary
  | OutboxEffectCancelPending;

/** The task-store half of a phase completion: the CAS transition plus its event. */
export interface PhaseCompletionTransition {
  key: TaskKey;
  expected: TaskExpected;
  patch: TaskPatch;
  event: TaskEvent;
  /**
   * Further bounded events belonging to the SAME completion, committed in the
   * same transaction and in the order given, immediately after `event` (issue
   * #840). The review-dispute transition layer is the one producer today: its
   * §10.3 audit event describes the protocol block that the completion's own
   * patch writes, so the two must land together or not at all — a separate
   * `appendEvent` would leave the block moved with no record of why, or a record
   * of a move that the CAS refused.
   *
   * Optional and normally absent; a completion with no extra events behaves
   * exactly as it did before.
   */
  extraEvents?: TaskEvent[];
}

export interface TaskStore {
  /**
   * Opaque identity of the durable backend this store writes to (issue #818
   * review follow-up). Two stores reporting the same defined value write to the
   * same database file and therefore share one transaction domain: effects
   * committed through {@link completePhaseWithEffects} are already visible —
   * and already maintenance-guarded — through the paired {@link OutboxStore}.
   *
   * Optional, and `undefined` for any store with no shareable durable backend
   * (in-memory stores, fakes, per-connection `:memory:` databases). `undefined`
   * on either side means "assume nothing is shared", which is the safe default:
   * the caller performs its own outbox write instead of relying on a
   * transaction that does not exist.
   */
  readonly backendId?: string | undefined;

  enqueueTask(input: EnqueueTaskInput): Promise<StoreResult<AiTask>>;
  getTask(key: TaskKey): Promise<AiTask | undefined>;
  claimNextTask(request: ClaimNextTaskRequest): Promise<AiTask | undefined>;
  transitionTask(
    key: TaskKey,
    expected: TaskExpected,
    patch: TaskPatch,
  ): Promise<StoreResult<AiTask>>;
  releaseClaim(key: TaskKey, ownerRunId: string, now?: string): Promise<StoreResult<AiTask>>;
  appendEvent(event: TaskEvent): Promise<void>;

  /**
   * Append `event` unless this task already carries an event of the same
   * `type` whose `data[dedupe.field]` equals `dedupe.value`. Returns whether
   * this call is the one that wrote it.
   *
   * The existence check and the insert must be ONE atomic operation against the
   * durable backend — not a `listEvents` followed by an `appendEvent` (issue
   * #936 review, P2). The callers are the outbox lanes: two `dispatch-outbox`
   * runs, or a drain racing an `admin outbox cancel`, can reach the same
   * terminal row at the same moment from different processes, and a
   * check-then-append would let both observe "no event yet" and both write one.
   * An implementation whose backend has no shared transaction domain (a
   * single-process in-memory store) satisfies this by keeping the check and the
   * insert in one synchronous body, with no `await` between them.
   *
   * Deduping on a `data` field rather than on the event type keeps the
   * guarantee per-effect: a task may legitimately carry several events of one
   * type, one for each effect that produced it.
   */
  appendEventOnce(
    event: TaskEvent,
    dedupe: { field: string; value: string },
  ): Promise<boolean>;

  listEvents(key: TaskKey): Promise<TaskEvent[]>;
  /**
   * Atomically commit a phase completion: the task transition, its
   * `phase.completed` event, and every outbox effect the completion produced,
   * in one transaction (DOMAIN.md §2.3 Orchestration — transactional-outbox
   * guarantee, issue #701). A failure here must fail the whole completion —
   * no transition without its effects, and no effect without its transition —
   * rather than transitioning the task and separately, best-effort, enqueueing
   * its side effects.
   *
   * An implementation whose backend has a whole-file maintenance lock must
   * refuse the entire call with `code: "maintenance_locked"` while that lock is
   * held (issue #818) — this is an outbox enqueue path, and a refusal is
   * all-or-nothing for the same reason the commit is. The lock read must happen
   * inside this same transaction, not as a pre-check.
   */
  completePhaseWithEffects(
    transition: PhaseCompletionTransition,
    effects: OutboxEffect[],
  ): Promise<StoreResult<AiTask>>;

  /**
   * List every task row for a session. Ordering is not guaranteed by the
   * store; callers that need a specific order (e.g. admin ui's
   * most-recently-updated-first) sort client-side.
   */
  listSessionTasks(sessionId: string): Promise<AiTask[]>;

  /**
   * Recover a task stuck in `failed`, or in `claimed`/`running` with an
   * expired lease, back to `queued`. Refuses (returns `conflict`) any other
   * status, or a `claimed`/`running` task whose lease has not yet expired —
   * an active task is never touched. `options.phase` overrides the task's
   * current phase (operator-directed re-route); omitted, the phase is
   * unchanged.
   */
  recoverTask(
    key: TaskKey,
    options?: { phase?: TaskPhase; now?: string },
  ): Promise<StoreResult<AiTask>>;

  /**
   * Recover a task parked in a specific human-handoff status
   * (`options.fromStatus`) back to `queued` at `options.phase`. Refuses
   * (returns `conflict`) if the task's current status does not exactly match
   * `fromStatus`. Refuses (returns `tool_request_unresolved`) if the task
   * carries a live, unresolved implementation Tool Request: that handoff must
   * close through `tool-request resolve`/`tool-request run`, never through a
   * generic requeue.
   */
  recoverHandoff(
    key: TaskKey,
    options: { fromStatus: TaskStatus; phase: TaskPhase; now?: string },
  ): Promise<StoreResult<AiTask>>;

  /**
   * Recover a task held at `ready_for_human` by a review-loop cap
   * (`context.reviewLoopCapReached` truthy) back to `queued` at
   * `options.phase` (default `"review"`), clearing `reviewLoopCapReached`,
   * `escalatedEffort`, and resetting `reviewCycles` to 0. Refuses (returns
   * `conflict`) if the task is not `ready_for_human`, or is
   * `ready_for_human` but the cap flag is not set.
   */
  recoverCapHandoff(
    key: TaskKey,
    options?: { phase?: TaskPhase; now?: string },
  ): Promise<StoreResult<AiTask>>;

  /**
   * Clear the `notBefore` delay on a `queued` task so it becomes immediately
   * claimable. Refuses (returns `conflict`) any non-`queued` status.
   */
  clearTaskDelay(
    key: TaskKey,
    options?: { now?: string },
  ): Promise<StoreResult<AiTask>>;

  /**
   * Cancel a task (issue #608): a terminal, race-safe transition available
   * from any non-terminal status (`queued`, `claimed`, `running`, `blocked`,
   * `ready_for_human`). Implementations must perform the read-check-write
   * atomically (mirroring `claimNextTask`/`transitionTask`'s CAS discipline)
   * so a cancellation racing a concurrent claim/requeue has deterministic
   * behavior: whichever transition's transaction commits first wins, and the
   * loser observes the fully-applied result of the winner rather than a torn
   * write.
   *
   * A `claimed`/`running` task is NOT force-stopped — there is no live signal
   * into an in-flight phase handler's subprocess. Instead, cancelling it here
   * flips `status` to `cancelled` immediately; the active run's own eventual
   * `transitionTask`/`completePhaseWithEffects` call then loses its CAS (its
   * `expected.status` no longer matches) and safely no-ops as `claim_lost` —
   * cancellation therefore takes effect at the run's next safe phase boundary
   * rather than corrupting an active subprocess or worktree.
   *
   * Refuses (`already_cancelled`) a task that is already `cancelled` — a
   * repeated cancellation is a clean, informative no-op, not an error.
   * Refuses (`conflict`) a task that already reached a different terminal
   * status (`done`/`failed`): finished work is not retroactively cancellable.
   */
  cancelTask(
    key: TaskKey,
    options?: { reason?: string; now?: string },
  ): Promise<StoreResult<AiTask>>;

  /**
   * Atomically commit a cancellation (issue #608 review): the same
   * `cancelTask` transition, plus its `task.cancelled` event and every
   * outbox effect the cancellation produced (the operator-visible comment),
   * in one transaction — mirroring `completePhaseWithEffects` (issue #701).
   * Without this, a crash or a failed event/outbox write after the
   * transition commits leaves the task permanently `cancelled` with no
   * event or comment, and retrying cannot repair the gap because a repeat
   * call observes `already_cancelled` and no-ops.
   *
   * Refuses with `code: "maintenance_locked"` under a held maintenance lock,
   * exactly as `completePhaseWithEffects` does (issue #818): refusing in full
   * leaves the task untouched, so the operator's cancellation stays repeatable
   * once the lock clears instead of landing without its comment.
   */
  cancelTaskWithEffects(
    key: TaskKey,
    options: { reason?: string; now?: string } | undefined,
    event: TaskEvent,
    effects: OutboxEffect[],
  ): Promise<StoreResult<AiTask>>;
}
