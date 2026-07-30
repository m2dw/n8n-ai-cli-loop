import type { AiTask, ClaimNextTaskRequest, TaskEvent, TaskKey, TaskPhase } from "./task.js";
import type { OutboxEffect, TaskStore } from "./task-store.js";
import type { ResolvedSession } from "./session.js";
import type { OutboxEnqueueInput, OutboxEntry, OutboxStore } from "./outbox.js";
import type { AgentFailureKind } from "./agent-diagnostics.js";
import type { RunLedgerEntryInput, RunLedgerOutcome, SessionPauseState } from "./session-control.js";
import { extractRunMetadata } from "./session-control.js";
import { applyTaskPatch, leaseExpiry, nextPhaseAfter } from "./transitions.js";
import { enqueueHandlerCommentEffect, enqueueStatusLabelEffects, enqueueQuotaDelayCommentEffect, enqueueSlackNotificationEffect, enqueuePrSummaryEffect, enqueueHumanGateSummaryEffect } from "./outbox-effects.js";
import { readResolvedAssignment } from "./assignment.js";
import type { ResolvedAssignment } from "./assignment.js";
import { resolveQuotaRetryDelayMs } from "./quota-classifier.js";

/**
 * `OutboxStore` adapter that records every `enqueue`/`replacePendingPrSummary`
 * call as an {@link OutboxEffect} instead of writing it, so the existing
 * `enqueue*Effect` builders (outbox-effects.ts) can run unchanged while a phase
 * completion is assembled. The collected effects are committed atomically with
 * the task transition via `TaskStore.completePhaseWithEffects` (issue #701) —
 * nothing here talks to a database.
 *
 * Exported so other atomic-commit call sites (e.g. `admin.ts`'s task
 * cancellation, issue #608 review follow-up) can reuse the same
 * collect-then-commit shape instead of writing through a live `OutboxStore`
 * ahead of the transaction that must contain the effect.
 */
export class OutboxEffectCollector implements OutboxStore {
  readonly effects: OutboxEffect[] = [];

  async enqueue(input: OutboxEnqueueInput): Promise<{ enqueued: boolean }> {
    this.effects.push({ kind: "enqueue", input });
    return { enqueued: true };
  }

  async replacePendingPrSummary(
    input: OutboxEnqueueInput,
    key: { owner: string; repo: string; prNumber: number; marker: string },
  ): Promise<{ enqueued: boolean }> {
    this.effects.push({ kind: "replacePendingPrSummary", input, key });
    return { enqueued: true };
  }

  async listPending(): Promise<OutboxEntry[]> {
    throw new Error("OutboxEffectCollector does not support listPending");
  }

  async listPendingEntries(): Promise<OutboxEntry[]> {
    throw new Error("OutboxEffectCollector does not support listPendingEntries");
  }

  async markSent(): Promise<{ updated: boolean }> {
    throw new Error("OutboxEffectCollector does not support markSent");
  }

  async markFailed(): Promise<{ deadLettered: boolean }> {
    throw new Error("OutboxEffectCollector does not support markFailed");
  }

  async getScanCursor(): Promise<number | undefined> {
    throw new Error("OutboxEffectCollector does not support getScanCursor");
  }

  async setScanCursor(): Promise<void> {
    throw new Error("OutboxEffectCollector does not support setScanCursor");
  }

  async getById(): Promise<OutboxEntry | undefined> {
    throw new Error("OutboxEffectCollector does not support getById");
  }

  async listUnsent(): Promise<OutboxEntry[]> {
    throw new Error("OutboxEffectCollector does not support listUnsent");
  }

  async retryEntry(): Promise<{ retried: boolean; reason?: string }> {
    throw new Error("OutboxEffectCollector does not support retryEntry");
  }

  async cancelEntry(): Promise<{ cancelled: boolean; reason?: string }> {
    throw new Error("OutboxEffectCollector does not support cancelEntry");
  }

  async claimForDispatch(): Promise<boolean> {
    throw new Error("OutboxEffectCollector does not support claimForDispatch");
  }

  async renewClaim(): Promise<string | undefined> {
    throw new Error("OutboxEffectCollector does not support renewClaim");
  }
}

/**
 * Backoff applied to a lock-contended task before it returns to `queued` (issue
 * #440). Without a `notBefore`, a zero-delay requeue lets claimNextTask re-select
 * the SAME locked issue on the very next tick. If that issue is older/higher
 * priority than the others, the scheduler keeps picking it, contending on the
 * held lock and requeuing it again, so DIFFERENT issues never actually proceed in
 * parallel until the holder finishes. A short backoff makes claimNextTask skip
 * the contended issue (its `notBefore` is in the future) and reach other queued
 * work; the holder typically releases within a window or two. Overridable via
 * `RunNextPhaseOptions.lockContentionDelayMs`.
 */
export const DEFAULT_LOCK_CONTENTION_DELAY_MS = 5_000;

/**
 * Context passed to createPhaseHandlers() so every handler can close
 * over the resolved session and the current run identity.
 * Handlers must use session.repoRoot as cwd when spawning subprocesses
 * and runId to derive deterministic artifact paths.
 *
 * contextId is the n8n execution ID of the workflow (or parent workflow) that
 * spawned this phase run. In a flat workflow it equals runId. In a parent/child
 * n8n workflow the parent passes its own $execution.id so child runs can be
 * traced back to the originating execution.
 */
export interface PhaseHandlerContext {
  session: ResolvedSession;
  runId: string;
  workerId: string;
  contextId?: string;
}

export type PhaseHandlerResult =
  | { result: "success" | "needs_fix" | "conflict" | "blocked" | "tool_request"; context?: Record<string, unknown>; message?: string }
  // A quota/rate-limit exhaustion (issue #25). Not a task failure: the phase is
  // released back to `queued` with a future `notBefore` so the normal schedule
  // retries it once the quota window resets. `retryAfterMs` lets a handler
  // override the default delay (e.g. parsed from a provider "try again in" hint).
  // `category` is the normalized failure category (issue #672) — carried
  // separately from `context` so it reliably reaches the task event and
  // public comment regardless of what a given handler's `context` shape
  // contains, and so category-appropriate wording never claims usage-quota
  // exhaustion for a `rate_limit`/`provider_capacity` failure.
  | { result: "delayed"; context?: Record<string, unknown>; message?: string; retryAfterMs?: number; category?: AgentFailureKind }
  | { result: "failed"; context?: Record<string, unknown>; error: string };

export type PhaseHandler = (task: AiTask) => Promise<PhaseHandlerResult>;

export type PhaseHandlers = Partial<Record<TaskPhase, PhaseHandler>>;

/**
 * Per-issue worktree execution context resolved before a phase runs (issue #438).
 * `enabled: false` is the not-applicable case (a phase that never touches the
 * issue branch, e.g. research/planner); the runner records nothing. The shape is
 * intentionally structural so the concrete resolver in handlers/worktree-context.ts
 * is assignable without the core runner importing the handler layer.
 */
export type WorktreeContextResolution =
  | {
      ok: true;
      context:
        | { enabled: false }
        | { enabled: true; worktreeId: string; worktreePath: string; branch?: string; created?: boolean };
    }
  | { ok: false; error: string };

/**
 * Handle returned when the issue-scoped worktree lock is acquired for a phase run
 * (issue #440). The runner calls `release()` once the handler has finished so the
 * SAME issue can run again on a later phase; DIFFERENT issues never share a scope
 * and so never block one another. `release()` must be best-effort/idempotent — the
 * runner calls it from a `finally` and ignores the outcome.
 */
export interface PhaseLockHandle {
  release(): void;
}

/**
 * Result of acquiring the per-issue execution lock before a phase runs (issue
 * #440). The shape is intentionally structural so the concrete acquirer in
 * run-one-phase (backed by `IssueWorktreeLock`) is assignable without the core
 * runner importing the handler/store layer.
 *
 * - `acquired: true` → the run owns the issue lock; the handler proceeds and the
 *   runner releases the handle afterwards. A worktree-disabled (or
 *   not-applicable) phase returns this with a no-op handle so behavior is
 *   unchanged.
 * - `acquired: false` → another live run already holds this issue's lock. The
 *   phase does NOT run; the runner releases the claim back to `queued` so the
 *   normal schedule retries once the holder finishes (the SAME issue is therefore
 *   serialized without relying on n8n preventing overlapping executions).
 * - `ok: false` → the lock subsystem itself errored (e.g. a filesystem fault);
 *   the phase fails closed rather than running without the guard.
 */
export type PhaseLockAcquisition =
  | { ok: true; acquired: true; handle: PhaseLockHandle }
  | { ok: true; acquired: false; reason?: string; ownerContextId?: string; ownerStartedAt?: string }
  | { ok: false; error: string };

/**
 * Result of a pre-lock phase-admission preflight (issue #681). Runs BEFORE
 * `acquirePhaseLock`/`resolveWorktreeContext`, so a rejection here never
 * acquires the issue lock, resolves/creates the worktree, or invokes the
 * handler — the contract a caller like the review-admission check
 * (`checkReviewAdmission`) promises. `ok: false` is surfaced as a synthetic
 * `failed`/`blocked` handler result, flowing through the SAME completion path
 * (status transition, `phase.completed` event, escalation labels/comment) as
 * a real handler outcome.
 */
export type PhaseAdmissionResult =
  | { ok: true }
  | { ok: false; result: "failed"; error: string }
  | { ok: false; result: "blocked"; message: string };

export type PhaseRunOutcome =
  | { status: "idle" }
  // The session is paused (issue #531): an operator or the circuit breaker
  // stopped this session, so NO task was claimed and no handler ran. The pause
  // state lives in the runner-owned store (never GitHub labels); resuming via
  // `admin session resume` restores normal claiming.
  | { status: "paused"; reason?: string; pausedAt?: string; pausedBy?: string; source?: string }
  | { status: "claim_lost"; task?: AiTask }
  | { status: "phase_missing"; task: AiTask }
  | { status: "completed"; task: AiTask; result: PhaseHandlerResult }
  // Quota/rate-limit exhaustion (issue #25): the task was released back to
  // `queued` with `notBefore` set, and run-one-phase reports `delayed` so n8n
  // does not treat temporary quota exhaustion as a workflow crash.
  | { status: "delayed"; task: AiTask; result: PhaseHandlerResult; notBefore: string }
  // Issue lock contention (issue #440): another live run already holds this
  // issue's worktree lock, so the phase did not run. The claim was released back
  // to `queued` (the handler never ran) and the normal schedule retries once the
  // holder finishes. This serializes the SAME issue without failing the task.
  | { status: "lock_contended"; task: AiTask; ownerContextId?: string };

export interface RunNextPhaseOptions {
  store: TaskStore;
  request: ClaimNextTaskRequest;
  handlers: PhaseHandlers;
  now?: string;
  /**
   * When provided along with `session`, completed handler results will enqueue
   * GitHub side-effect entries (comments, coarse labels) into this store.
   * Entries are NOT dispatched inline — call dispatchOutbox() separately.
   */
  outboxStore?: OutboxStore;
  /** Required when outboxStore is provided. */
  session?: ResolvedSession;
  /**
   * n8n execution ID of the workflow (or parent workflow) that initiated this
   * phase run. Recorded in task events so that child phase runs can be traced
   * back to the n8n execution that triggered them. Omit for non-n8n callers.
   */
  contextId?: string;
  /**
   * Delay applied when a handler returns `delayed` (quota/rate-limit
   * exhaustion). Defaults to resolveQuotaRetryDelayMs() (5h, env-overridable).
   * A handler-supplied `retryAfterMs` on the result takes precedence over this.
   */
  quotaRetryDelayMs?: number;
  /**
   * Backoff applied to a lock-contended task before it returns to `queued` (issue
   * #440). Defaults to DEFAULT_LOCK_CONTENTION_DELAY_MS. See that constant for why
   * a zero-delay requeue starves other queued issues during contention.
   */
  lockContentionDelayMs?: number;
  /**
   * Optional per-issue worktree execution-context resolver (issue #438). When
   * provided, it runs after the task transitions to `running` and BEFORE the phase
   * handler, so a repo-working phase resolves/creates the issue worktree and
   * records its stable identity (`worktreeId`/`worktreePath`) in task context. A
   * not-applicable phase resolves to `{ enabled: false }` and nothing is recorded.
   * A resolver error fails the task closed (the worktree could not be prepared).
   * Omit for callers that never use worktrees.
   */
  resolveWorktreeContext?: (
    task: AiTask,
  ) => WorktreeContextResolution | Promise<WorktreeContextResolution>;
  /**
   * Optional per-issue execution-lock acquirer (issue #440). When provided, it
   * runs after the task transitions to `running` and BEFORE the phase handler so a
   * repo-working phase takes the issue-scoped worktree lock around phase
   * execution: the SAME issue cannot run concurrently while DIFFERENT issues (with
   * distinct lock scopes) proceed in parallel. The returned handle is released in
   * a `finally` once the handler finishes. A not-applicable phase returns
   * `acquired: true` with a no-op handle. Contention (`acquired: false`) releases
   * the claim back to `queued` and reports `lock_contended`; a subsystem error
   * (`ok: false`) fails the task closed. Omit for callers that never use worktrees.
   */
  acquirePhaseLock?: (
    task: AiTask,
  ) => PhaseLockAcquisition | Promise<PhaseLockAcquisition>;
  /**
   * Optional pre-lock phase-admission preflight (issue #681). When provided, it
   * runs after the task transitions to `running` and BEFORE `acquirePhaseLock`/
   * `resolveWorktreeContext`, so a rejection here is guaranteed side-effect free —
   * no issue lock taken, no worktree resolved/created, no handler invoked. A
   * `{ ok: false }` result is treated exactly like a handler `failed`/`blocked`
   * result: it flows through the normal completion path (status transition,
   * `phase.completed` event, escalation labels/comment). Omit for callers with no
   * admission gate.
   */
  admitPhase?: (task: AiTask) => PhaseAdmissionResult | Promise<PhaseAdmissionResult>;
  /**
   * Optional session pause check (issue #531). When provided, it runs BEFORE
   * `claimNextTask` — a paused session claims nothing and executes nothing —
   * and is rechecked AFTER the claimed→running transition, so a pause that
   * lands anywhere between the gate and that transition (overlapping
   * executions) releases the task back to `queued` (attempt count restored)
   * instead of executing. Rechecking after the running transition makes the
   * admission race-free: any pause the recheck does not observe necessarily
   * committed after the task was already `running`, which is the documented
   * "running phases are not force-stopped" exception. Either way the runner
   * returns `{ status: "paused" }` with the stored reason so the caller can
   * surface why the session went quiet. Pause state is owned by the runner's
   * own store (SQLite), never GitHub labels. Omit for callers with no
   * session-level controls.
   */
  checkSessionPause?: (sessionId: string) => SessionPauseState | Promise<SessionPauseState>;
  /**
   * Optional per-run result recorder (issue #531). Called once per executed
   * phase — after the completion (or quota-delay release) has been persisted —
   * with the run's ledger entry: session, issue, phase, outcome, duration, and
   * agent/model/effort plus cost metadata when the handler surfaced them. The
   * wiring in run-one-phase records the entry and evaluates the circuit
   * breaker over recent entries (see core/session-control.ts). Best-effort: a
   * recorder failure is logged as a `run.ledger.failed` task event and never
   * masks the phase outcome.
   */
  recordRunResult?: (entry: RunLedgerEntryInput) => void | Promise<void>;
}

/**
 * Agent responsible for a phase per the persisted assignment (falling back to
 * the task's agent columns for legacy tasks), used to attribute a ledger entry
 * when the handler result carried no `resolvedProfile`. Content phases have no
 * per-task agent columns; they are attributed only via `resolvedProfile`.
 */
function assignedAgentForPhase(
  phase: TaskPhase,
  task: AiTask,
  assignment: ResolvedAssignment | undefined,
): string | undefined {
  switch (phase) {
    case "implementation":
      return assignment?.implementationAgent ?? task.implementationAgent;
    case "review":
      return assignment?.reviewAgent ?? task.reviewAgent;
    case "conflict_resolution":
      return assignment?.conflictResolutionAgent ?? task.implementationAgent;
    case "research":
      return assignment?.researchAgent ?? task.researchAgent;
    default:
      return undefined;
  }
}

/**
 * Invoke the caller's `recordRunResult` hook with the run's ledger entry.
 * Best-effort: a recorder failure must never mask the already-persisted phase
 * outcome, so it is logged as a `run.ledger.failed` event and swallowed.
 */
async function recordRunLedgerEntry(
  options: RunNextPhaseOptions,
  store: TaskStore,
  key: TaskKey,
  task: AiTask,
  outcome: RunLedgerOutcome,
  resultContext: Record<string, unknown> | undefined,
  durationMs: number,
  runId: string,
  now: string,
): Promise<void> {
  if (!options.recordRunResult) return;
  const metadata = extractRunMetadata(resultContext);
  const agent = metadata.agent ?? assignedAgentForPhase(task.phase, task, readResolvedAssignment(task));
  const entry: RunLedgerEntryInput = {
    sessionId: key.sessionId,
    issueNumber: key.issueNumber,
    phase: task.phase,
    outcome,
    runId,
    durationMs,
    createdAt: now,
    ...(agent !== undefined ? { agent } : {}),
    ...(metadata.model !== undefined ? { model: metadata.model } : {}),
    ...(metadata.effort !== undefined ? { effort: metadata.effort } : {}),
    ...(metadata.costUsd !== undefined ? { costUsd: metadata.costUsd } : {}),
    ...(metadata.inputTokens !== undefined ? { inputTokens: metadata.inputTokens } : {}),
    ...(metadata.outputTokens !== undefined ? { outputTokens: metadata.outputTokens } : {}),
  };
  try {
    await options.recordRunResult(entry);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      await store.appendEvent({
        task: key,
        type: "run.ledger.failed",
        runId,
        message,
        data: { phase: task.phase, outcome },
        createdAt: now,
      });
    } catch {
      // swallow — the phase outcome is already persisted; this logging is best-effort
    }
  }
}

export async function runNextPhase(options: RunNextPhaseOptions): Promise<PhaseRunOutcome> {
  const { store, request, handlers, outboxStore, session, contextId } = options;
  const now = options.now ?? request.now ?? new Date().toISOString();

  // Session pause gate (issue #531): checked BEFORE any claim so a paused
  // session neither claims nor executes work — the queue is left untouched for
  // whenever the operator (or a resolved circuit-breaker condition) resumes it.
  if (options.checkSessionPause) {
    const pause = await options.checkSessionPause(request.sessionId);
    if (pause.paused) {
      return {
        status: "paused",
        ...(pause.reason !== undefined ? { reason: pause.reason } : {}),
        ...(pause.pausedAt !== undefined ? { pausedAt: pause.pausedAt } : {}),
        ...(pause.pausedBy !== undefined ? { pausedBy: pause.pausedBy } : {}),
        ...(pause.source !== undefined ? { source: pause.source } : {}),
      };
    }
  }

  const claimed = await store.claimNextTask({ ...request, now });
  if (!claimed) return { status: "idle" };

  const key = { sessionId: claimed.sessionId, issueNumber: claimed.issueNumber };

  const attempts = {
    [claimed.phase]: (claimed.attempts[claimed.phase] ?? 0) + 1,
  };
  const running = await store.transitionTask(
    key,
    { status: "claimed", phase: claimed.phase, ownerRunId: request.runId },
    { status: "running", attempts, now },
  );
  if (!running.ok) return { status: "claim_lost", task: running.current };

  // Recheck the pause state AFTER the claimed→running transition: an operator
  // may pause at any point after the pre-claim gate above (overlapping
  // executions), and a successful pause must never admit new work. Ordering
  // the recheck after the running transition serializes pause against
  // admission without a cross-store transaction: a pause that commits before
  // this read is observed here and the task is released back to `queued` with
  // its attempt count restored (no `phase.started` event has been appended
  // yet, so nothing records the aborted admission); a pause that commits after
  // this read finds the task already `running` — exactly the documented
  // "running phases are not force-stopped" exception. There is no interleaving
  // in which a pause succeeds while a task it should have stopped is neither
  // released nor observably running.
  if (options.checkSessionPause) {
    const pause = await options.checkSessionPause(request.sessionId);
    if (pause.paused) {
      const released = await store.transitionTask(
        key,
        { status: "running", phase: claimed.phase, ownerRunId: request.runId },
        {
          status: "queued",
          attempts: { [claimed.phase]: claimed.attempts[claimed.phase] ?? 0 },
          ownerRunId: undefined,
          leaseExpiresAt: undefined,
          now,
        },
      );
      if (!released.ok) return { status: "claim_lost", task: released.current };
      return {
        status: "paused",
        ...(pause.reason !== undefined ? { reason: pause.reason } : {}),
        ...(pause.pausedAt !== undefined ? { pausedAt: pause.pausedAt } : {}),
        ...(pause.pausedBy !== undefined ? { pausedBy: pause.pausedBy } : {}),
        ...(pause.source !== undefined ? { source: pause.source } : {}),
      };
    }
  }

  // Surface the resolved assignment (persisted at intake) on the start event so
  // the agent choice for this run is auditable from the task event log.
  const resolvedAssignment = readResolvedAssignment(running.value);
  await store.appendEvent({
    task: key,
    type: "phase.started",
    runId: request.runId,
    data: {
      phase: running.value.phase,
      workerId: request.workerId,
      ...(contextId !== undefined ? { contextId } : {}),
      ...(resolvedAssignment ? { assignment: resolvedAssignment } : {}),
    },
    createdAt: now,
  });

  const handler = handlers[running.value.phase];
  if (!handler) {
    const missing = await store.transitionTask(
      key,
      { status: "running", phase: running.value.phase, ownerRunId: request.runId },
      {
        status: "ready_for_human",
        ownerRunId: undefined,
        leaseExpiresAt: undefined,
        lastError: `No handler registered for phase: ${running.value.phase}`,
        now,
      },
    );
    return {
      status: "phase_missing",
      task: missing.ok ? missing.value : running.value,
    };
  }

  // Phase-admission preflight (issue #681), run BEFORE the issue lock is taken or
  // the worktree is resolved. A rejection here (e.g. review's unresolved-Tool-
  // Request/missing-PR/missing-dependency-base checks) must never acquire the
  // lock, resolve/create the worktree, or invoke the handler — the promised
  // side-effect-free contract. The result is threaded through as a synthetic
  // handler result below, skipping both the lock and worktree-context blocks
  // entirely when set.
  let admissionResult: PhaseHandlerResult | undefined;
  if (options.admitPhase) {
    const admission = await options.admitPhase(running.value);
    if (!admission.ok) {
      admissionResult =
        admission.result === "failed"
          ? { result: "failed", error: admission.error }
          : { result: "blocked", message: admission.message };
    }
  }

  // Acquire the per-issue execution lock before the phase runs (issue #440). For a
  // repo-working phase this takes the issue-scoped worktree lock so the SAME issue
  // cannot run concurrently while DIFFERENT issues (distinct lock scopes) proceed
  // in parallel; a not-applicable phase resolves to a no-op handle and behavior is
  // unchanged. The handle is released in the `finally` around the handler below.
  // Taken AFTER the handler-missing check so a phase with no registered handler
  // never touches the lock, and AFTER the admission preflight so a rejected
  // admission never touches it either.
  let lockHandle: PhaseLockHandle | undefined;
  // A lock-subsystem failure is recorded here and surfaced as a synthetic `failed`
  // result below (same completion path as a worktree-prep failure), so the phase
  // fails closed rather than running without its guard. The handler is skipped.
  let lockFailure: string | undefined;
  if (admissionResult === undefined && options.acquirePhaseLock) {
    const lock = await options.acquirePhaseLock(running.value);
    if (!lock.ok) {
      lockFailure = lock.error;
      await store.appendEvent({
        task: key,
        type: "phase.lock.failed",
        runId: request.runId,
        message: lock.error,
        data: { phase: running.value.phase, ...(contextId !== undefined ? { contextId } : {}) },
        createdAt: now,
      });
    } else if (!lock.acquired) {
      // Another live run already holds this issue's lock (one active execution per
      // worktree). The handler must not run, so release the claim back to `queued`
      // and report contention; the normal schedule retries once the holder
      // finishes. A short `notBefore` backoff keeps the scheduler from immediately
      // re-selecting this same locked issue every tick (which would starve other
      // queued issues) — claimNextTask skips it until the backoff elapses and
      // reaches different issues meanwhile. No worktree context is recorded and the
      // handler never runs.
      const contentionDelayMs = options.lockContentionDelayMs ?? DEFAULT_LOCK_CONTENTION_DELAY_MS;
      const contentionNotBefore = leaseExpiry(now, contentionDelayMs);
      const requeued = await store.transitionTask(
        key,
        { status: "running", phase: running.value.phase, ownerRunId: request.runId },
        { status: "queued", ownerRunId: undefined, leaseExpiresAt: undefined, notBefore: contentionNotBefore, now },
      );
      if (!requeued.ok) return { status: "claim_lost", task: requeued.current };
      await store.appendEvent({
        task: key,
        type: "phase.lock.contended",
        runId: request.runId,
        ...(lock.reason !== undefined ? { message: lock.reason } : {}),
        // Record only the location-independent owner id — never a worktree path —
        // so the task event log cannot leak a local path.
        data: {
          phase: running.value.phase,
          notBefore: contentionNotBefore,
          delayMs: contentionDelayMs,
          ...(lock.ownerContextId !== undefined ? { ownerContextId: lock.ownerContextId } : {}),
          ...(contextId !== undefined ? { contextId } : {}),
        },
        createdAt: now,
      });
      return {
        status: "lock_contended",
        task: requeued.value,
        ...(lock.ownerContextId !== undefined ? { ownerContextId: lock.ownerContextId } : {}),
      };
    } else {
      lockHandle = lock.handle;
    }
  }

  // Resolve the per-issue worktree execution context before the phase runs (issue
  // #438). For a repo-working phase this creates/reuses the deterministic issue
  // worktree and records its stable identity in task context so later phases
  // re-resolve the same tree; a not-applicable phase resolves to `enabled: false`
  // and records nothing. `active` is the task handed to the handler: it carries
  // the recorded worktree context when one was resolved.
  let active = running.value;
  // A worktree-prep failure is recorded here and surfaced as a synthetic `failed`
  // handler result below, so it flows through the SAME completion path as a handler
  // failure (status transition, phase.completed event, escalation labels/comment)
  // rather than silently diverging. The handler itself is skipped.
  let worktreeFailure: string | undefined;
  let result: PhaseHandlerResult;
  let durationMs: number;
  try {
  // A rejected admission or a lock-subsystem failure skips worktree resolution and
  // the handler entirely; both flow through the synthetic-failure completion path
  // below.
  if (admissionResult === undefined && lockFailure === undefined && options.resolveWorktreeContext) {
    const wt = await options.resolveWorktreeContext(active);
    if (!wt.ok) {
      // The worktree could not be prepared, so the phase cannot run safely. The
      // error string comes from the worktree manager and references only
      // ids/branches/repo paths (never a local worktree path).
      worktreeFailure = wt.error;
      await store.appendEvent({
        task: key,
        type: "phase.worktree.failed",
        runId: request.runId,
        message: wt.error,
        data: { phase: active.phase, ...(contextId !== undefined ? { contextId } : {}) },
        createdAt: now,
      });
    } else if (wt.context.enabled) {
      // Record the stable worktree identity in task context. `worktreeId` is
      // recomputable from session + issue, and the context blob is schemaless, so
      // this needs NO DB migration (applyTaskPatch merges the new keys over the
      // existing context). Persist it BEFORE the handler runs so the identity
      // survives even if the handler crashes/fails.
      const recorded = await store.transitionTask(
        key,
        { status: "running", phase: active.phase, ownerRunId: request.runId },
        {
          status: "running",
          phase: active.phase,
          ownerRunId: request.runId,
          context: { worktreeId: wt.context.worktreeId, worktreePath: wt.context.worktreePath },
          now,
        },
      );
      if (!recorded.ok) return { status: "claim_lost", task: recorded.current };
      active = recorded.value;
      await store.appendEvent({
        task: key,
        type: "phase.worktree.resolved",
        runId: request.runId,
        // Record only the location-independent id + created flag — never the
        // absolute worktree path — so the task event log cannot leak a local path.
        data: {
          phase: active.phase,
          worktreeId: wt.context.worktreeId,
          created: wt.context.created ?? false,
          ...(contextId !== undefined ? { contextId } : {}),
        },
        createdAt: now,
      });
    }
  }

  const phaseStartMs = Date.now();
  // A rejected admission, or a lock/worktree prep failure, surfaces as a synthetic
  // result so it flows through the SAME completion path as a handler failure
  // (status transition, phase.completed event, escalation labels/comment). The
  // handler is skipped in all three cases.
  const prepFailure = lockFailure ?? worktreeFailure;
  result = admissionResult
    ? admissionResult
    : prepFailure
      ? { result: "failed", error: prepFailure }
      : await runHandler(handler, active);
  durationMs = Date.now() - phaseStartMs;

  // Quota/rate-limit exhaustion (issue #25). Release the task back to `queued`
  // with a future `notBefore` so claimNextTask skips it until the quota window
  // is likely reset, instead of failing the task or escalating to a human. The
  // phase is unchanged (the same work is retried), the original output artifact
  // is preserved via the handler's context, and NO GitHub label side effects are
  // enqueued — SQLite alone owns the delayed-retry timing.
  if (result.result === "delayed") {
    const delayMs = result.retryAfterMs ?? options.quotaRetryDelayMs ?? resolveQuotaRetryDelayMs();
    // Anchor the cool-down on `now` (the logical claim timestamp the caller
    // passes in). Mixing in the handler's real wall-clock duration here would
    // cross clock domains — `now` is caller-supplied while durationMs comes from
    // Date.now() — yielding a nondeterministic notBefore that drifts by a few ms
    // even for instant handlers. The lease bounds how long a handler may hold the
    // task, so `now + delayMs` is the correct, reproducible cool-down window.
    const notBefore = leaseExpiry(now, delayMs);
    const delayed = await store.transitionTask(
      key,
      { status: "running", phase: running.value.phase, ownerRunId: request.runId },
      {
        status: "queued",
        ownerRunId: undefined,
        leaseExpiresAt: undefined,
        notBefore,
        context: result.context,
        now,
      },
    );
    if (!delayed.ok) return { status: "claim_lost", task: delayed.current };

    await store.appendEvent({
      task: key,
      type: "phase.delayed",
      runId: request.runId,
      message: result.message,
      data: {
        phase: running.value.phase,
        notBefore,
        delayMs,
        ...(contextId !== undefined ? { contextId } : {}),
        ...(result.category !== undefined ? { category: result.category } : {}),
      },
      createdAt: now,
    });

    // Publish a concise GitHub-facing status comment so operators can see why
    // the issue went quiet (issue #352). Best-effort, mirroring the completed
    // branch: a failure here must NOT mask the delayed outcome — record it as a
    // task event and continue. The existing notBefore/retry behavior is owned by
    // the transition above and is unaffected. The enqueue is idempotent on
    // notBefore, so it is not duplicated while the same delay is active.
    if (outboxStore && session) {
      try {
        // Name the agent from the pre-transition `running.value`, NOT
        // `delayed.value`. The delayed transition persists `result.context`, and
        // quota-delay handlers return a context without the resolved
        // `context.assignment` (only fields like artifactDir/resolvedProfile/
        // quotaSignal). Using `delayed.value` would lose the persisted assignment
        // before agentForPhase runs, so the public comment could name the wrong
        // agent for sessions using assignment profiles or label/manual overrides.
        //
        // content_draft, content_research, and content_review quota retries must
        // not emit a generic GitHub comment — only fixed outcome enums and approved
        // metadata are permitted in GitHub-visible status for these phases
        // (contract §Public status boundary).
        if (running.value.phase !== "content_draft" && running.value.phase !== "content_research" && running.value.phase !== "content_review") {
          await enqueueQuotaDelayCommentEffect(
            outboxStore, session, running.value, running.value.phase, notBefore, now, result.category,
          );
        }
      } catch (outboxErr) {
        const errMsg = outboxErr instanceof Error ? outboxErr.message : String(outboxErr);
        try {
          await store.appendEvent({
            task: key,
            type: "outbox.enqueue.failed",
            runId: request.runId,
            message: errMsg,
            data: { phase: running.value.phase, result: result.result },
            createdAt: now,
          });
        } catch {
          // swallow — returning delayed is more important than logging
        }
      }
    }

    // Record the quota-delayed run in the cost/result ledger (issue #531).
    // `delayed` is not a failure for the circuit breaker, but the row keeps
    // the ledger a faithful account of where cycles went.
    await recordRunLedgerEntry(
      options, store, key, running.value, "delayed", result.context, durationMs, request.runId, now,
    );

    return { status: "delayed", task: delayed.value, result, notBefore };
  }

  const transition =
    result.result === "failed"
      ? { status: "failed" as const, phase: running.value.phase }
      : nextPhaseAfter(running.value.phase, result.result, running.value, admissionResult !== undefined);
  // Merge the handler's own context patch with any bookkeeping patch from
  // nextPhaseAfter (e.g. the content_review needs_fix cycle counter) so neither
  // clobbers the other.
  const contextPatch =
    result.context || ("contextPatch" in transition && transition.contextPatch)
      ? { ...result.context, ...("contextPatch" in transition ? transition.contextPatch : undefined) }
      : undefined;
  const patch = {
    status: transition.status,
    phase: transition.phase,
    ownerRunId: undefined,
    leaseExpiresAt: undefined,
    context: contextPatch,
    lastError: result.result === "failed" ? result.error : undefined,
    now,
  };
  const completionEvent: TaskEvent = {
    task: key,
    type: "phase.completed",
    runId: request.runId,
    message: result.result === "failed" ? result.error : result.message,
    data: { phase: running.value.phase, result: result.result, ...(contextId !== undefined ? { contextId } : {}) },
    createdAt: now,
  };

  // Build every GitHub side effect for this completion up front — via a
  // collector standing in for the real outbox store — instead of writing them
  // as they're produced. `completePhaseWithEffects` then commits the task
  // transition, the completion event, and every collected effect in one
  // transaction (issue #701, DOMAIN.md §2.3 Orchestration:
  // transactional-outbox guarantee). A builder throwing here propagates
  // straight out of runNextPhase — nothing has transitioned yet, so the task
  // stays `running` (recoverable via its lease) rather than completing with
  // silently dropped labels/comments/notifications.
  //
  // `preview` mirrors what completePhaseWithEffects will persist for `patch`
  // (same `applyTaskPatch` over the same pre-transition task): the effect
  // builders read fields off the post-transition task (e.g. merged context),
  // so they need that shape before the real commit happens.
  const effectCollector = new OutboxEffectCollector();
  if (outboxStore && session) {
    // `active` (not `running.value`) is the pre-transition base: it carries any
    // worktree-context bookkeeping already persisted before the handler ran
    // (issue #438), which is what the real DB row underneath
    // `completePhaseWithEffects` reflects at this point.
    const preview = applyTaskPatch(active, patch);
    await enqueueHandlerCommentEffect(
      effectCollector, session, preview, running.value.phase, result, request.runId, now, durationMs,
    );
    await enqueueStatusLabelEffects(
      effectCollector, session, preview, transition.status, transition.phase, request.runId, now,
      running.value.phase, result,
    );
    await enqueuePrSummaryEffect(
      effectCollector, session, running.value, running.value.phase, result, request.runId, now,
    );
    await enqueueHumanGateSummaryEffect(
      effectCollector, session, running.value, running.value.phase, result, request.runId, now, durationMs,
    );
    if (transition.status === "ready_for_human" || transition.status === "failed") {
      await enqueueSlackNotificationEffect(
        effectCollector, session, preview, running.value.phase, result, request.runId, now,
      );
    }
  }

  const completed = await store.completePhaseWithEffects(
    {
      key,
      expected: { status: "running", phase: running.value.phase, ownerRunId: request.runId },
      patch,
      event: completionEvent,
    },
    effectCollector.effects,
  );
  if (!completed.ok) return { status: "claim_lost", task: completed.current };

  // Record the completed run in the cost/result ledger (issue #531) — AFTER
  // the completion committed, so the ledger never counts a run whose
  // transition lost its CAS. Synthetic failures (admission/lock/worktree prep)
  // flow through here as `failed` and therefore count toward the circuit
  // breaker exactly like handler failures.
  await recordRunLedgerEntry(
    options, store, key, running.value, result.result, result.context, durationMs, request.runId, now,
  );

  // `completePhaseWithEffects` only guarantees the effects land wherever
  // `store` itself keeps its outbox rows — the same SQLite file for
  // SqliteTaskStore, or its own in-memory map for MemoryTaskStore. The public
  // API still accepts a `store`/`outboxStore` pair that do NOT share a
  // backend (e.g. a MemoryTaskStore alongside a real SqliteOutboxStore, or any
  // other OutboxStore implementation), and that combination has no
  // cross-store transaction to lean on. Replaying the same effects into
  // `outboxStore` here keeps that contract working: every effect is
  // idempotency-keyed, so replaying it against a store that already has these
  // rows (the shared-backend case above) is a harmless no-op, while a
  // genuinely separate outboxStore actually receives them instead of silently
  // losing them.
  if (outboxStore && effectCollector.effects.length > 0) {
    try {
      for (const effect of effectCollector.effects) {
        if (effect.kind === "enqueue") {
          await outboxStore.enqueue(effect.input);
        } else {
          await outboxStore.replacePendingPrSummary(effect.input, effect.key);
        }
      }
    } catch (outboxErr) {
      const errMsg = outboxErr instanceof Error ? outboxErr.message : String(outboxErr);
      try {
        await store.appendEvent({
          task: key,
          type: "outbox.enqueue.failed",
          runId: request.runId,
          message: errMsg,
          data: { phase: running.value.phase, result: result.result },
          createdAt: now,
        });
      } catch {
        // swallow — the completion itself already committed; this logging is best-effort
      }
    }
  }

  return { status: "completed", task: completed.value, result };
  } finally {
    // Release the issue lock only AFTER the final task transition (completed,
    // delayed, or claim-lost) has been persisted — best-effort. Releasing earlier,
    // while the task is still `running`, would let another worker reclaim an
    // expired task, take the now-free issue lock, and re-run the SAME phase before
    // this run commits its result (duplicate work plus a lost claim). A release
    // failure must not mask the phase outcome; a no-op handle (disabled or
    // not-applicable phase) makes this a cheap no-op.
    if (lockHandle) {
      try {
        lockHandle.release();
      } catch {
        // swallow — the lock TTL/admin recovery is the backstop for a leaked lock
      }
    }
  }
}

async function runHandler(handler: PhaseHandler, task: AiTask): Promise<PhaseHandlerResult> {
  try {
    return await handler(task);
  } catch (error) {
    return {
      result: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
