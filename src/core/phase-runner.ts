import type { AiTask, ClaimNextTaskRequest, TaskPhase } from "./task.js";
import type { TaskStore } from "./task-store.js";
import type { ResolvedSession } from "./session.js";
import type { OutboxStore } from "./outbox.js";
import { leaseExpiry, nextPhaseAfter } from "./transitions.js";
import { enqueueHandlerCommentEffect, enqueueStatusLabelEffects, enqueueQuotaDelayCommentEffect, enqueueSlackNotificationEffect, enqueuePrSummaryEffect, enqueueHumanGateSummaryEffect } from "./outbox-effects.js";
import { readResolvedAssignment } from "./assignment.js";
import { resolveQuotaRetryDelayMs } from "./quota-classifier.js";

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
  | { result: "delayed"; context?: Record<string, unknown>; message?: string; retryAfterMs?: number }
  | { result: "failed"; context?: Record<string, unknown>; error: string };

export type PhaseHandler = (task: AiTask) => Promise<PhaseHandlerResult>;

export type PhaseHandlers = Partial<Record<TaskPhase, PhaseHandler>>;

/**
 * Per-issue worktree execution context resolved before a phase runs (issue #438).
 * `enabled: false` is the shared-checkout case (worktrees off); the runner records
 * nothing and behavior is unchanged. The shape is intentionally structural so the
 * concrete resolver in handlers/worktree-context.ts is assignable without the core
 * runner importing the handler layer.
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

export type PhaseRunOutcome =
  | { status: "idle" }
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
   * handler, so a worktree-enabled session resolves/creates the issue worktree and
   * records its stable identity (`worktreeId`/`worktreePath`) in task context. A
   * worktree-disabled (or not-applicable) phase resolves to `{ enabled: false }`
   * and nothing is recorded, preserving today's shared-checkout behavior. A
   * resolver error fails the task closed (the worktree could not be prepared).
   * Omit for callers that never use worktrees.
   */
  resolveWorktreeContext?: (
    task: AiTask,
  ) => WorktreeContextResolution | Promise<WorktreeContextResolution>;
  /**
   * Optional per-issue execution-lock acquirer (issue #440). When provided, it
   * runs after the task transitions to `running` and BEFORE the phase handler so a
   * worktree-enabled session takes the issue-scoped worktree lock around phase
   * execution: the SAME issue cannot run concurrently while DIFFERENT issues (with
   * distinct lock scopes) proceed in parallel. The returned handle is released in
   * a `finally` once the handler finishes. A worktree-disabled (or not-applicable)
   * phase returns `acquired: true` with a no-op handle, preserving today's
   * shared-checkout behavior. Contention (`acquired: false`) releases the claim
   * back to `queued` and reports `lock_contended`; a subsystem error (`ok: false`)
   * fails the task closed. Omit for callers that never use worktrees.
   */
  acquirePhaseLock?: (
    task: AiTask,
  ) => PhaseLockAcquisition | Promise<PhaseLockAcquisition>;
}

export async function runNextPhase(options: RunNextPhaseOptions): Promise<PhaseRunOutcome> {
  const { store, request, handlers, outboxStore, session, contextId } = options;
  const now = options.now ?? request.now ?? new Date().toISOString();
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

  // Acquire the per-issue execution lock before the phase runs (issue #440). For a
  // worktree-enabled session this takes the issue-scoped worktree lock so the SAME
  // issue cannot run concurrently while DIFFERENT issues (distinct lock scopes)
  // proceed in parallel; a worktree-disabled (or not-applicable) phase resolves to
  // a no-op handle and behavior is unchanged. The handle is released in the
  // `finally` around the handler below. Taken AFTER the handler-missing check so a
  // phase with no registered handler never touches the lock.
  let lockHandle: PhaseLockHandle | undefined;
  // A lock-subsystem failure is recorded here and surfaced as a synthetic `failed`
  // result below (same completion path as a worktree-prep failure), so the phase
  // fails closed rather than running without its guard. The handler is skipped.
  let lockFailure: string | undefined;
  if (options.acquirePhaseLock) {
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
  // #438). For a worktree-enabled session this creates/reuses the deterministic
  // issue worktree and records its stable identity in task context so later phases
  // re-resolve the same tree; a worktree-disabled (or not-applicable) phase
  // resolves to `enabled: false` and records nothing, keeping today's
  // shared-checkout behavior. The handler cwd is intentionally NOT changed here —
  // that is the deferred follow-up in docs/per-issue-worktrees.md. `active` is the
  // task handed to the handler: it carries the recorded worktree context when one
  // was resolved.
  let active = running.value;
  // A worktree-prep failure is recorded here and surfaced as a synthetic `failed`
  // handler result below, so it flows through the SAME completion path as a handler
  // failure (status transition, phase.completed event, escalation labels/comment)
  // rather than silently diverging. The handler itself is skipped.
  let worktreeFailure: string | undefined;
  let result: PhaseHandlerResult;
  let durationMs: number;
  try {
  // A lock-subsystem failure skips worktree resolution and the handler entirely;
  // it flows through the synthetic-failure completion path below.
  if (lockFailure === undefined && options.resolveWorktreeContext) {
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
  // A lock or worktree prep failure surfaces as a synthetic `failed` result so it
  // flows through the SAME completion path as a handler failure (status
  // transition, phase.completed event, escalation labels/comment). The handler is
  // skipped in that case.
  const prepFailure = lockFailure ?? worktreeFailure;
  result = prepFailure
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
        await enqueueQuotaDelayCommentEffect(
          outboxStore, session, running.value, running.value.phase, notBefore, now,
        );
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

    return { status: "delayed", task: delayed.value, result, notBefore };
  }

  const transition =
    result.result === "failed"
      ? { status: "failed" as const, phase: running.value.phase }
      : nextPhaseAfter(running.value.phase, result.result);
  const completed = await store.transitionTask(
    key,
    { status: "running", phase: running.value.phase, ownerRunId: request.runId },
    {
      status: transition.status,
      phase: transition.phase,
      ownerRunId: undefined,
      leaseExpiresAt: undefined,
      context: result.context,
      lastError: result.result === "failed" ? result.error : undefined,
      now,
    },
  );
  if (!completed.ok) return { status: "claim_lost", task: completed.current };

  await store.appendEvent({
    task: key,
    type: "phase.completed",
    runId: request.runId,
    message: result.result === "failed" ? result.error : result.message,
    data: { phase: running.value.phase, result: result.result, ...(contextId !== undefined ? { contextId } : {}) },
    createdAt: now,
  });

  // Enqueue GitHub side effects if an outbox store and session are configured.
  // Effects are stored but NOT dispatched inline.
  // A failure here must NOT propagate: the task has already transitioned and
  // throwing would prevent the caller from seeing the completed outcome.
  // Instead, record the error as a task event so it is visible and retryable.
  if (outboxStore && session) {
    try {
      await enqueueHandlerCommentEffect(
        outboxStore, session, completed.value, running.value.phase, result, request.runId, now, durationMs,
      );
      await enqueueStatusLabelEffects(
        outboxStore, session, completed.value, transition.status, transition.phase, request.runId, now,
        running.value.phase, result,
      );
      await enqueuePrSummaryEffect(
        outboxStore, session, running.value, running.value.phase, result, request.runId, now,
      );
      await enqueueHumanGateSummaryEffect(
        outboxStore, session, running.value, running.value.phase, result, request.runId, now, durationMs,
      );
      if (transition.status === "ready_for_human" || transition.status === "failed") {
        await enqueueSlackNotificationEffect(
          outboxStore, session, completed.value, running.value.phase, result, request.runId, now,
        );
      }
    } catch (outboxErr) {
      const errMsg = outboxErr instanceof Error ? outboxErr.message : String(outboxErr);
      // Best-effort: if appendEvent itself fails we still return completed.
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
        // swallow — returning completed is more important than logging
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
