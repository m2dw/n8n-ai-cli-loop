import type { AiTask, ClaimNextTaskRequest, TaskEvent, TaskExpected, TaskKey, TaskPatch, TaskPhase } from "./task.js";
import type { OutboxEffect, TaskStore } from "./task-store.js";
import type { ResolvedSession } from "./session.js";
import type { OutboxEnqueueInput, OutboxEntry, OutboxStore } from "./outbox.js";
import type { AgentFailureKind } from "./agent-diagnostics.js";
import type { RunLedgerEntryInput, RunLedgerOutcome, SessionPauseState } from "./session-control.js";
import { extractRunMetadata } from "./session-control.js";
import { applyTaskPatch, leaseExpiry, nextPhaseAfter } from "./transitions.js";
import { enqueueHandlerCommentEffect, enqueueStatusLabelEffects, enqueueQuotaDelayCommentEffect, enqueueSlackNotificationEffect, enqueuePrSummaryEffect, enqueueHumanGateSummaryEffect, enqueueDisputeOutcomeEffects, enqueueRefinementHandoffEffects } from "./outbox-effects.js";
import { readResolvedAssignment } from "./assignment.js";
import type { ResolvedAssignment } from "./assignment.js";
import { resolveQuotaRetryDelayMs } from "./quota-classifier.js";
import type { DisputeTransitionApplication } from "./review-dispute-transition.js";
import { disputeContextPatch, disputeTransitionEvent, routedPhaseCompletion } from "./review-dispute-commit.js";

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

  async setScanCursor(): Promise<{ persisted: boolean }> {
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

/**
 * One handler-authored audit event, committed by the runner in the SAME
 * `completePhaseWithEffects` transaction as the completion event (issue #869:
 * the refinement loop's `refinement.*` events must land atomically with the
 * context block they describe — an append after a committed completion could
 * fail and leave the block persisted without its required events). The runner
 * stamps the envelope (task key, runId, createdAt); the handler owns type,
 * message, and data. Data must follow the same rule as every task event:
 * literals, counters, and identifiers — never prose or local paths.
 */
export interface PhaseHandlerEvent {
  type: string;
  message?: string;
  data?: Record<string, unknown>;
}

export type PhaseHandlerResult =
  | {
      result: "success" | "needs_fix" | "conflict" | "blocked" | "tool_request";
      context?: Record<string, unknown>;
      message?: string;
      /** See {@link PhaseHandlerEvent}. */
      extraEvents?: PhaseHandlerEvent[];
      /**
       * An already-approved review-dispute transition this run applied (issue
       * #840), carried OUTSIDE `context` because it is not task context: the
       * runner folds its §10.1 block and its one §10.3 audit event into the same
       * `completePhaseWithEffects` transaction as the completion itself, and
       * lets its §7.1 routing override where the task goes next.
       *
       * A handler computes it only on a path that really delivered (a failed,
       * delayed, or handed-off run moves no lineage), and only from the typed
       * predecessor decisions — the runner never parses agent output. Absent for
       * every phase and every task with no structured lineage, which is what
       * keeps the legacy free-form review path unchanged (§13).
       */
      disputeTransition?: DisputeTransitionApplication;
      /**
       * The refinement lane's activation park (issue #870,
       * docs/issue-refinement-contract.md §11 step 6 / §12 row 45): a
       * refinement `success` whose application walk reached `activated` must
       * park the SHARED task row at `blocked`/phase `implementation` — the
       * hold-and-reactivate shape ordinary intake already reactivates (issue
       * #224) — in the SAME completion transaction that commits the
       * `activated` block, so the state move and the park cannot land
       * separately. Overrides the ordinary `nextPhaseAfter` destination the
       * way the dispute routing does; set only by the refinement handler, on
       * the one outcome that finished the label transition, and always from
       * the activation plan persisted at admission (§14) rather than from
       * anything re-derived at activation time.
       */
      refinementActivation?: { targetStatus: "blocked"; targetPhase: "implementation" };
    }
  // A quota/rate-limit exhaustion (issue #25). Not a task failure: the phase is
  // released back to `queued` with a future `notBefore` so the normal schedule
  // retries it once the quota window resets. `retryAfterMs` lets a handler
  // override the default delay (e.g. parsed from a provider "try again in" hint).
  // `category` is the normalized failure category (issue #672) — carried
  // separately from `context` so it reliably reaches the task event and
  // public comment regardless of what a given handler's `context` shape
  // contains, and so category-appropriate wording never claims usage-quota
  // exhaustion for a `rate_limit`/`provider_capacity` failure.
  // `delayKind` (issue #897) says WHAT was delayed. It defaults to the
  // agent-failure reading every pre-#897 caller assumes; a handler that delayed
  // for a reason the agent had no part in must say so, or the public status
  // comment attributes a quota condition to an agent that never ran.
  | { result: "delayed"; context?: Record<string, unknown>; message?: string; retryAfterMs?: number; category?: AgentFailureKind; delayKind?: PhaseDelayKind; extraEvents?: PhaseHandlerEvent[] }
  | { result: "failed"; context?: Record<string, unknown>; error: string };

/**
 * Why a handler asked for a delay.
 *
 * - `agent_failure` — the agent process itself reported a recoverable
 *   quota/rate-limit/capacity condition (issue #25/#672). The default.
 * - `transient_verification` — a runner-owned verification command failed for a
 *   reason that is about the HOST, not the diff (issue #897): today, an
 *   indeterminate CLI availability probe.
 */
export type PhaseDelayKind = "agent_failure" | "transient_verification";

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
  | { status: "lock_contended"; task: AiTask; ownerContextId?: string }
  // Whole-file maintenance contention (issue #818): a `prune`/`restore`/
  // `archive rollup` pass holds a maintenance lock — on the task store, whose
  // `completePhaseWithEffects` then refuses the completion in full, or (review
  // follow-up) on a separately-backed outbox store, whose effect write is
  // attempted before the completion so the effects are never stranded behind a
  // committed transition. Either way the phase completion — which commits the
  // task transition and its outbox effects in one transaction (issue #701) —
  // did not happen, and nothing was written.
  //
  // The claim is handed back: `task` is the requeued (`queued`, unowned,
  // pre-claim attempt count) row, so the phase re-runs on the next tick rather
  // than waiting out this run's lease — a `skipActivityChecks` holder such as
  // `archive rollup` can take the lock while the phase is legitimately live, so
  // that lease may be a full 30 minutes from expiry. `claimNextTask` is itself
  // maintenance-guarded (issue #611), so the re-run cannot begin until the lock
  // clears. Reported distinctly from `claim_lost` because nothing about the
  // claim is actually wrong — this is retryable contention, not a lost race.
  | { status: "maintenance_locked"; task?: AiTask };

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

  // Pre-claim attempt count, kept so a run this process discards wholesale (a
  // pause, or a maintenance-refused completion — issue #818) can hand the task
  // back exactly as it found it rather than burning a retry.
  const priorAttempts = claimed.attempts[claimed.phase] ?? 0;
  const attempts = {
    [claimed.phase]: priorAttempts + 1,
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
          attempts: { [claimed.phase]: priorAttempts },
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
    const delayedExpected: TaskExpected = {
      status: "running",
      phase: running.value.phase,
      ownerRunId: request.runId,
    };
    const delayedPatch: TaskPatch = {
      status: "queued",
      ownerRunId: undefined,
      leaseExpiresAt: undefined,
      notBefore,
      context: result.context,
      now,
    };
    // Handler-authored audit events (issue #869) for a delayed outcome — e.g.
    // the refinement loop's eligibility-hold or agent process-failure event.
    // They are the only record of WHY the released context now carries its
    // hold/`pendingRetry` position, so they commit in the SAME transaction as
    // the release itself (issue #869 review follow-up): appended best-effort
    // after `transitionTask`, a failed write would strand the committed
    // position with its cause missing from the log for good — the resumed run
    // consumes the position and never re-emits the event. Ordered ahead of
    // `phase.delayed` so the log reads cause before effect; that event stays
    // best-effort below, as on every other delayed path.
    const handlerEvents = (result.extraEvents ?? []).map(
      (extra): TaskEvent => ({
        task: key,
        type: extra.type,
        runId: request.runId,
        ...(extra.message !== undefined ? { message: extra.message } : {}),
        ...(extra.data !== undefined ? { data: extra.data } : {}),
        createdAt: now,
      }),
    );
    const [firstHandlerEvent, ...restHandlerEvents] = handlerEvents;
    const delayed = firstHandlerEvent
      ? await store.completePhaseWithEffects(
          {
            key,
            expected: delayedExpected,
            patch: delayedPatch,
            event: firstHandlerEvent,
            ...(restHandlerEvents.length > 0 ? { extraEvents: restHandlerEvents } : {}),
          },
          [],
        )
      : await store.transitionTask(key, delayedExpected, delayedPatch);
    // A held maintenance lock refuses the whole transactional release (issue
    // #818) rather than requeueing the task without its events; surface it as
    // its own retryable outcome exactly like the completion commit does —
    // `claim_lost` would report a concurrent takeover that never happened.
    if (!delayed.ok && delayed.code === "maintenance_locked") {
      return {
        status: "maintenance_locked",
        task: await requeueClaimForMaintenance(store, key, running.value, request.runId, priorAttempts, now),
      };
    }
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
        // (contract §Public status boundary). The refinement lane (issue #869)
        // publishes exactly one thing, and a quota delay is not it: §13 gives
        // the Issue a public comment on a terminal HANDOFF (issue #936), never
        // on a retryable pause, so it is excluded the same way.
        if (running.value.phase !== "content_draft" && running.value.phase !== "content_research" && running.value.phase !== "content_review" && running.value.phase !== "refinement") {
          await enqueueQuotaDelayCommentEffect(
            outboxStore, session, running.value, running.value.phase, notBefore, now, result.category,
            result.delayKind,
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
  const baseContextPatch =
    result.context || ("contextPatch" in transition && transition.contextPatch)
      ? { ...result.context, ...("contextPatch" in transition ? transition.contextPatch : undefined) }
      : undefined;

  // Issue #840: the review-dispute transition this run applied, folded into THIS
  // completion rather than committed on its own. The handler already computed it
  // from the typed predecessor decisions (#843/#844/#845/#847) against the block
  // the task currently holds; what is left is durability, and doing that in a
  // second transaction would let the protocol block move without the completion
  // that produced it — or the reverse.
  //
  // Three things ride along, all from the core transition layer so a later
  // public/admin surface reads the same state instead of rebuilding it:
  //
  //  - the §10.1 block wins over whatever the handler's own context carried, so
  //    the committed block and the event describing it cannot disagree;
  //  - §7.1 routing overrides the ordinary `nextPhaseAfter` destination when it
  //    names one (rules 1 and 2), parks the task for a human when rule 2 selects
  //    a turn this runner cannot dispatch — the reconsideration, evidence, and
  //    arbitration runs, none of which an ordinary review run may finish — and
  //    defers to it only for rules 3/4;
  //  - the one bounded §10.3 audit event is appended in the same transaction.
  //
  // A replayed delivery folds in NOTHING but the routing: the application is
  // byte-identical to the block already on file, no counter moves, and no second
  // audit event is appended — while the retried run still routes exactly as its
  // first delivery did.
  // A `delayed` run never reaches here (it returned above), so `failed` is the
  // only outcome left that must not fold a transition in.
  const disputeApplication: DisputeTransitionApplication | undefined =
    result.result === "failed" ? undefined : result.disputeTransition;
  const contextPatch = disputeApplication
    ? disputeContextPatch(disputeApplication, baseContextPatch)
    : baseContextPatch;
  // The refinement activation park (issue #870, §12 row 45): committed in
  // this same transaction as the `activated` block it belongs to, CAS'd on
  // the row still being this run's — a repeated delivery re-derives the same
  // park and converges. Honoured only for a refinement-phase success, so no
  // other handler can reach for it.
  const refinementActivation =
    result.result === "success" && running.value.phase === "refinement"
      ? result.refinementActivation
      : undefined;
  const routed = disputeApplication
    ? routedPhaseCompletion(disputeApplication.routing, transition, running.value.phase)
    : refinementActivation
      ? { status: refinementActivation.targetStatus, phase: refinementActivation.targetPhase }
      : transition;

  const patch = {
    status: routed.status,
    phase: routed.phase,
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
  // Handler-authored audit events (issue #869) ride in the same transaction as
  // the completion, before any dispute-transition event. A `failed` result has
  // no `extraEvents` field by type, so only delivered outcomes contribute.
  const handlerEvents: PhaseHandlerEvent[] =
    result.result === "failed" ? [] : result.extraEvents ?? [];
  const extraEvents: TaskEvent[] = [
    ...handlerEvents.map(
      (e): TaskEvent => ({
        task: key,
        type: e.type,
        runId: request.runId,
        ...(e.message !== undefined ? { message: e.message } : {}),
        ...(e.data !== undefined ? { data: e.data } : {}),
        createdAt: now,
      }),
    ),
    ...(disputeApplication && !disputeApplication.replayed
      ? [disputeTransitionEvent({ key, application: disputeApplication, runId: request.runId, now })]
      : []),
  ];

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
  // The refinement lane (issue #869/#866 §13) enqueues almost NO GitHub side
  // effects: the loop must not mutate Issue bodies, labels, dependencies,
  // comments, branches, or PRs on its own behalf — the application walk performs
  // its writes through its own port — and the generic completion builders below
  // (status labels, handler comment, human-gate summary) would do exactly that.
  // Its completion commits the task transition, the handler's own audit events,
  // and nothing else.
  //
  // The ONE exception is a terminal handoff (issue #936): §13 items 3–4 require
  // the ready-for-human label and one bounded comment, and a lane that stops
  // without them leaves an Issue that looks — from GitHub — like it is still
  // waiting its turn. `enqueueRefinementHandoffEffects` builds only those two
  // rows, only for a completion whose own context patch reached
  // `escalated_human`, and adds no executable status label (§13 item 2).
  const effectCollector = new OutboxEffectCollector();
  if (outboxStore && session && running.value.phase === "refinement") {
    await enqueueRefinementHandoffEffects(
      effectCollector, session, running.value, result.context, now,
    );
  } else if (outboxStore && session) {
    // `preview` mirrors what completePhaseWithEffects will persist for `patch`
    // (same `applyTaskPatch` over the same pre-transition task): the effect
    // builders read fields off the post-transition task (e.g. merged context),
    // so they need that shape before the real commit happens. `active` (not
    // `running.value`) is the pre-transition base: it carries any worktree-context
    // bookkeeping already persisted before the handler ran (issue #438), which is
    // what the real DB row underneath `completePhaseWithEffects` reflects at this
    // point.
    const preview = applyTaskPatch(active, patch);
    await enqueueHandlerCommentEffect(
      effectCollector, session, preview, running.value.phase, result, request.runId, now, durationMs,
    );
    await enqueueStatusLabelEffects(
      effectCollector, session, preview, routed.status, routed.phase, request.runId, now,
      running.value.phase, result,
    );
    await enqueuePrSummaryEffect(
      effectCollector, session, running.value, running.value.phase, result, request.runId, now,
    );
    await enqueueHumanGateSummaryEffect(
      effectCollector, session, running.value, running.value.phase, result, request.runId, now, durationMs,
    );
    // Issue #848: the §11 comment for a lineage this run resolved or escalated,
    // collected into the SAME transaction as the §10.1 block and the §10.3 event
    // that produced it. `preview` rather than `running.value` so the PR-first
    // routing reads the PR this completion is persisting, and `disputeApplication`
    // rather than a re-read of the block so the published outcome is the one the
    // transition layer actually applied. A replayed delivery, a non-terminal
    // transition, and a task-level §9 handoff each contribute nothing — the
    // builder's own gates, not this call site's.
    const completionPrUrl = result.context?.["prUrl"];
    await enqueueDisputeOutcomeEffects(
      effectCollector, session, preview, disputeApplication, now,
      typeof completionPrUrl === "string" ? completionPrUrl : undefined,
    );
    if (routed.status === "ready_for_human" || routed.status === "failed") {
      await enqueueSlackNotificationEffect(
        effectCollector, session, preview, running.value.phase, result, request.runId, now,
      );
    }
  }

  // `completePhaseWithEffects` commits the transition, the event, and every
  // effect in ONE transaction — but only over the backend `store` itself writes
  // to. The public API still accepts a `store`/`outboxStore` pair that does NOT
  // share a backend (a MemoryTaskStore alongside a real SqliteOutboxStore, or
  // any other OutboxStore implementation), and that pairing has no cross-store
  // transaction to lean on: the effects have to be written to `outboxStore`
  // separately, so SOME failure interleaving is unavoidable and the only real
  // choice is which side of it fails.
  //
  // Writing them BEFORE the transition is that choice (issue #818 review
  // follow-up). The previous ordering — commit, then replay behind a pre-check
  // — left the unrecoverable direction exposed: a maintenance lock acquired
  // between the pre-check and the replay made every enqueue throw *after* the
  // task had already completed, so the run reported success while its
  // comments/labels/notifications were gone for good, with no way to replay
  // them from a task that is no longer at that phase. No read can close that
  // gap, only ordering can. Enqueuing first inverts it: the refusal lands while
  // nothing has transitioned, so the claim is handed back and the phase re-runs
  // intact. The residual exposure is effects that outlive a transition which
  // then fails its CAS — recoverable by construction, since every effect is
  // idempotency-keyed and the re-run re-derives the same ones.
  //
  // The write is all-or-nothing wherever the store can make it so: `enqueueEffects`
  // (issue #818 review follow-up) puts the whole set in ONE transaction behind one
  // in-transaction lock read. Writing effect-by-effect instead lets a lock acquired
  // part-way through leave the earlier rows durable while this run reports
  // retryable contention — and once maintenance releases, the dispatcher publishes
  // a completion comment or status label for a phase that never committed and is
  // about to re-run, possibly to a different result. `written` tracks that case for
  // the stores that cannot batch: a partially written set is NOT safely retryable,
  // so it falls through to the best-effort branch below, which commits the
  // completion the already-durable rows announce and records the gap.
  //
  // A shared backend takes none of this: `backendId` equality proves the
  // transaction below already covers these effects atomically (and refuses them
  // atomically under a lock), so writing them here would put rows in the outbox
  // ahead of — and independently of — the very transition they belong to,
  // exactly the divergence #701 exists to prevent.
  const outboxSharesStoreBackend =
    outboxStore !== undefined && store.backendId !== undefined && store.backendId === outboxStore.backendId;
  let separateOutboxError: unknown;
  if (outboxStore && !outboxSharesStoreBackend && effectCollector.effects.length > 0) {
    let written = 0;
    try {
      if (outboxStore.enqueueEffects) {
        await outboxStore.enqueueEffects(effectCollector.effects);
        written = effectCollector.effects.length;
      } else {
        for (const effect of effectCollector.effects) {
          if (effect.kind === "enqueue") {
            await outboxStore.enqueue(effect.input);
          } else {
            await outboxStore.replacePendingPrSummary(effect.input, effect.key);
          }
          written += 1;
        }
      }
    } catch (outboxErr) {
      // A held maintenance lock is retryable contention, not a phase failure:
      // nothing has transitioned yet, so hand the claim back and report it as
      // its own outcome. Matched on the typed `code` carried by
      // MaintenanceLockedError (stores/maintenance-lock-guard.ts) rather than by
      // importing it, since core must not depend on the store layer.
      //
      // `written === 0` is what makes that honest — the refusal has to have left
      // the outbox exactly as it found it. A refusal that landed mid-set (only
      // possible on a store without `enqueueEffects`) already put effects in the
      // outbox for this completion, so re-running the phase is no longer the
      // clean retry this outcome advertises; that case takes the best-effort
      // branch instead.
      if (isMaintenanceLockedError(outboxErr) && written === 0) {
        return {
          status: "maintenance_locked",
          task: await requeueClaimForMaintenance(store, key, running.value, request.runId, priorAttempts, now),
        };
      }
      // Anything else — including a maintenance refusal that arrived with part
      // of the set already durable — keeps the long-standing best-effort
      // treatment: the completion still commits and the failure is recorded as
      // an event below. For the partial-set case that is the safer direction:
      // committing makes the rows already in the outbox belong to a phase that
      // really did complete, whereas handing the claim back would have them
      // announce a completion that never happened.
      // A `store`/`outboxStore` pair with no shared backend is also the shape a
      // caller uses to pass a deliberately inert sink (the outbox rows then come
      // from the task store's own transaction), so an unrecognized error here is
      // not evidence the effects were lost — unlike the maintenance refusal,
      // which is a definitive "this write will not happen".
      separateOutboxError = outboxErr;
    }
  }

  const completed = await store.completePhaseWithEffects(
    {
      key,
      expected: { status: "running", phase: running.value.phase, ownerRunId: request.runId },
      patch,
      event: completionEvent,
      ...(extraEvents.length > 0 ? { extraEvents } : {}),
    },
    effectCollector.effects,
  );
  // A maintenance lock refuses the whole completion (issue #818) — transition,
  // event, and every outbox effect — rather than committing the transition and
  // dropping the effects. Surface it as its own retryable outcome: reporting
  // `claim_lost` here would tell the operator a concurrent run took the task
  // over, when in fact nothing was written and the same phase re-runs intact
  // once maintenance releases the lock.
  if (!completed.ok && completed.code === "maintenance_locked") {
    return {
      status: "maintenance_locked",
      task: await requeueClaimForMaintenance(store, key, running.value, request.runId, priorAttempts, now),
    };
  }
  if (!completed.ok) return { status: "claim_lost", task: completed.current };

  // Record the completed run in the cost/result ledger (issue #531) — AFTER
  // the completion committed, so the ledger never counts a run whose
  // transition lost its CAS. Synthetic failures (admission/lock/worktree prep)
  // flow through here as `failed` and therefore count toward the circuit
  // breaker exactly like handler failures.
  await recordRunLedgerEntry(
    options, store, key, running.value, result.result, result.context, durationMs, request.runId, now,
  );

  // A non-maintenance failure from the separately-backed effect write above is
  // recorded once the completion has committed, so the gap it may have left is
  // diagnosable from the task's event log (and counted as an infra reason by
  // `issue-plan-history`). Logged here rather than at the catch site because
  // until this point the completion could still have been refused, in which
  // case there would be no gap to report.
  if (separateOutboxError !== undefined) {
    try {
      await store.appendEvent({
        task: key,
        type: "outbox.enqueue.failed",
        runId: request.runId,
        message: separateOutboxError instanceof Error ? separateOutboxError.message : String(separateOutboxError),
        data: { phase: running.value.phase, result: result.result },
        createdAt: now,
      });
    } catch {
      // swallow — the completion itself already committed; this logging is best-effort
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

/**
 * Whether an error is the typed refusal a held maintenance lock raises (issue
 * #818). Matched structurally on `code` rather than by importing
 * `MaintenanceLockedError`, since core must not depend on the store layer.
 */
function isMaintenanceLockedError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "maintenance_locked";
}

/**
 * Return a maintenance-refused completion's claim to the pool (issue #818
 * review follow-up).
 *
 * A `maintenance_locked` completion writes nothing, so the phase must re-run —
 * but the task is still `running`, owned by this run, with a fresh lease
 * (30 minutes by default). Leaving it that way strands it: the lock can be
 * acquired by a `skipActivityChecks` holder such as `archive rollup` while this
 * phase is legitimately live, and once maintenance releases, no tick can claim
 * the task again until that lease expires — the opposite of the retryable
 * behavior this outcome advertises. Requeueing it here makes the re-run
 * immediate. It cannot start *during* maintenance either: `claimNextTask` has
 * been maintenance-guarded since issue #611, so the task simply sits `queued`
 * and unclaimable until the lock clears.
 *
 * The requeue itself goes through `completePhaseWithEffects` (with no effects)
 * rather than a bare `transitionTask` (issue #818 review follow-up): that is
 * the one transition on the `TaskStore` interface which reads the maintenance
 * lock inside its own transaction. A plain `transitionTask` is unguarded, so
 * when the refusal came from the task store's OWN database — a handler that
 * outlived its lease meeting a `restore` at completion — this requeue would
 * write into a file maintenance is replacing: the write is lost with the file,
 * and the exclusion the lock exists to provide is broken in the process. Under
 * that lock the guarded call is refused too, so the task is deliberately left
 * `running` and recovery falls to the post-maintenance mechanisms that already
 * own it (lease expiry, `admin task recover`). When the lock is on a *different*
 * database than the task store (the separate-backend pairing), nothing refuses
 * the requeue and the re-run is immediate as intended.
 *
 * The attempt count is rolled back to its pre-claim value for the same reason
 * the pause path rolls it back: the entire run was discarded by an operator
 * maintenance window, so it must not consume the phase's retry budget.
 *
 * Best-effort and CAS-guarded on this run still owning the task in this phase:
 * if the requeue is refused (maintenance, or a concurrent takeover) or the
 * store itself throws, the outcome is still `maintenance_locked` and the
 * pre-existing lease-expiry recovery remains the backstop. Reports the requeued
 * task when it commits so the caller sees the state that actually landed.
 */
async function requeueClaimForMaintenance(
  store: TaskStore,
  key: TaskKey,
  running: AiTask,
  runId: string,
  priorAttempts: number,
  now: string,
): Promise<AiTask> {
  try {
    const requeued = await store.completePhaseWithEffects(
      {
        key,
        expected: { status: "running", phase: running.phase, ownerRunId: runId },
        patch: {
          status: "queued",
          attempts: { [running.phase]: priorAttempts },
          ownerRunId: undefined,
          leaseExpiresAt: undefined,
          now,
        },
        event: {
          task: key,
          type: "phase.maintenance_requeued",
          runId,
          message: "Phase completion refused by a held maintenance lock; claim returned to the queue.",
          data: { phase: running.phase },
          createdAt: now,
        },
      },
      [],
    );
    return requeued.ok ? requeued.value : (requeued.current ?? running);
  } catch {
    // swallow — reporting the contention matters more than the requeue, and a
    // task left `running` is still recovered by the normal lease-expiry path
    return running;
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
