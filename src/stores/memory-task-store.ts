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
} from "../core/task.js";
import { applyTaskPatch, isClaimExpired, isRunnable, leaseExpiry, priorityRank } from "../core/transitions.js";
import { ASSIGNMENT_CONTEXT_KEY } from "../core/assignment.js";
import { hasUnresolvedToolRequest } from "../core/tool-request.js";
import type { OutboxEffect, PhaseCompletionTransition, TaskStore } from "../core/task-store.js";

const DEFAULT_LEASE_MS = 30 * 60 * 1000;

export class MemoryTaskStore implements TaskStore {
  readonly #tasks = new Map<string, AiTask>();
  readonly #events: TaskEvent[] = [];
  readonly #outboxEntries = new Map<string, { topic: string; payload: unknown; createdAt: string }>();

  async enqueueTask(input: EnqueueTaskInput): Promise<StoreResult<AiTask>> {
    const now = input.now ?? new Date().toISOString();
    const key = taskMapKey(input);
    const existing = this.#tasks.get(key);
    if (existing) {
      // Re-enqueue dependency-held implementation tasks (issue #224). Mirror the
      // SqliteTaskStore behavior: a blocked implementation task is re-activated so
      // that intake can pick it up once its blocker becomes stack-ready. The same
      // applies to a conflict_resolution task held `blocked` by the report-only
      // admission gate (issue #532 review) — reactivated once report-only mode is
      // disabled and intake re-derives the phase from its still-present label.
      if (
        existing.status === "blocked" &&
        (existing.phase === "implementation" || existing.phase === "conflict_resolution")
      ) {
        // Keep the pinned assignment immutable across reactivation (issue #259).
        // Restore the originally pinned assignment when one exists; otherwise this
        // is a legacy task whose agent columns are the authority, so drop the
        // freshly resolved intake assignment to keep agentForPhase following the
        // original columns instead of a new config-derived assignment.
        const freshContext = { ...existing.context, ...(input.context ?? {}) };
        if (existing.context[ASSIGNMENT_CONTEXT_KEY] !== undefined) {
          freshContext[ASSIGNMENT_CONTEXT_KEY] = existing.context[ASSIGNMENT_CONTEXT_KEY];
        } else {
          delete freshContext[ASSIGNMENT_CONTEXT_KEY];
        }
        const updated: AiTask = {
          ...existing,
          status: "queued",
          phase: input.phase,
          implementationAgent: input.implementationAgent ?? existing.implementationAgent,
          reviewAgent: input.reviewAgent ?? existing.reviewAgent,
          researchAgent: input.researchAgent ?? existing.researchAgent,
          context: freshContext,
          ownerRunId: undefined,
          leaseExpiresAt: undefined,
          lastError: undefined,
          updatedAt: now,
          // Monotonic write counter (issue #622 review, P2) — see AiTask.revision.
          revision: (existing.revision ?? 0) + 1,
        };
        this.#tasks.set(key, updated);
        return { ok: true, value: cloneTask(updated), reactivated: true };
      }
      return { ok: false, code: "already_exists", current: cloneTask(existing) };
    }
    const task: AiTask = {
      sessionId: input.sessionId,
      issueNumber: input.issueNumber,
      status: "queued",
      phase: input.phase,
      priority: input.priority ?? "normal",
      implementationAgent: input.implementationAgent,
      reviewAgent: input.reviewAgent,
      researchAgent: input.researchAgent,
      attempts: {},
      context: input.context ?? {},
      createdAt: now,
      updatedAt: now,
      revision: 0,
    };
    this.#tasks.set(key, task);
    return { ok: true, value: cloneTask(task) };
  }

  async getTask(key: TaskKey): Promise<AiTask | undefined> {
    return cloneTask(this.#tasks.get(taskMapKey(key)));
  }

  async claimNextTask(request: ClaimNextTaskRequest): Promise<AiTask | undefined> {
    const now = request.now ?? new Date().toISOString();
    const leaseMs = request.leaseMs ?? DEFAULT_LEASE_MS;
    const candidate = [...this.#tasks.values()]
      .filter((task) => task.sessionId === request.sessionId)
      .filter((task) => isRunnable(task, now))
      .filter((task) => !request.supportedPhases || request.supportedPhases.includes(task.phase))
      // issue #677: mirror SqliteTaskStore — a live (unresolved) implementation
      // Tool Request handoff must never be claimed into review, however the row
      // reached `queued`/review, so the review-handler backstop never has a real
      // task to corrupt.
      .filter((task) => !(task.phase === "review" && hasUnresolvedToolRequest(task.context)))
      .sort((a, b) => {
        const byPriority = priorityRank(a.priority) - priorityRank(b.priority);
        if (byPriority !== 0) return byPriority;
        return Date.parse(a.createdAt) - Date.parse(b.createdAt);
      })[0];

    if (!candidate) return undefined;

    const claimed = applyTaskPatch(candidate, {
      status: "claimed",
      ownerRunId: request.runId,
      leaseExpiresAt: leaseExpiry(now, leaseMs),
      // Clear any delay window now that the task has been claimed (issue #25),
      // matching SqliteTaskStore so a stale notBefore can't re-gate a re-queue.
      notBefore: undefined,
      now,
      context: { workerId: request.workerId },
    });
    this.#tasks.set(taskMapKey(claimed), claimed);
    return cloneTask(claimed);
  }

  async transitionTask(
    key: TaskKey,
    expected: TaskExpected,
    patch: TaskPatch,
  ): Promise<StoreResult<AiTask>> {
    const mapKey = taskMapKey(key);
    const current = this.#tasks.get(mapKey);
    if (!current) return { ok: false, code: "not_found" };
    if (!matchesExpected(current, expected)) {
      return { ok: false, code: "conflict", current: cloneTask(current) };
    }
    const updated = applyTaskPatch(current, patch);
    this.#tasks.set(mapKey, updated);
    return { ok: true, value: cloneTask(updated) };
  }

  async releaseClaim(
    key: TaskKey,
    ownerRunId: string,
    now = new Date().toISOString(),
  ): Promise<StoreResult<AiTask>> {
    return this.transitionTask(
      key,
      { ownerRunId },
      { status: "queued", ownerRunId: undefined, leaseExpiresAt: undefined, now },
    );
  }

  async listSessionTasks(sessionId: string): Promise<AiTask[]> {
    return [...this.#tasks.values()]
      .filter((t) => t.sessionId === sessionId)
      .map((t) => cloneTask(t));
  }

  async recoverTask(
    key: TaskKey,
    options: { phase?: TaskPhase; now?: string } = {},
  ): Promise<StoreResult<AiTask>> {
    const now = options.now ?? new Date().toISOString();
    const mapKey = taskMapKey(key);
    const current = this.#tasks.get(mapKey);
    if (!current) return { ok: false, code: "not_found" };

    const RECOVERABLE: AiTask["status"][] = ["failed", "claimed", "running"];
    if (!RECOVERABLE.includes(current.status)) {
      return { ok: false, code: "conflict", current: cloneTask(current) };
    }
    if (
      (current.status === "claimed" || current.status === "running") &&
      !isClaimExpired(current, now)
    ) {
      return { ok: false, code: "conflict", current: cloneTask(current) };
    }

    const updated: AiTask = {
      ...current,
      status: "queued",
      phase: options.phase ?? current.phase,
      ownerRunId: undefined,
      leaseExpiresAt: undefined,
      lastError: undefined,
      updatedAt: now,
      revision: (current.revision ?? 0) + 1,
    };
    this.#tasks.set(mapKey, updated);
    return { ok: true, value: cloneTask(updated) };
  }

  async recoverHandoff(
    key: TaskKey,
    options: { fromStatus: TaskStatus; phase: TaskPhase; now?: string },
  ): Promise<StoreResult<AiTask>> {
    const now = options.now ?? new Date().toISOString();
    const mapKey = taskMapKey(key);
    const current = this.#tasks.get(mapKey);
    if (!current) return { ok: false, code: "not_found" };

    if (current.status !== options.fromStatus) {
      return { ok: false, code: "conflict", current: cloneTask(current) };
    }
    if (hasUnresolvedToolRequest(current.context)) {
      return { ok: false, code: "tool_request_unresolved", current: cloneTask(current) };
    }

    const updated: AiTask = {
      ...current,
      status: "queued",
      phase: options.phase,
      ownerRunId: undefined,
      leaseExpiresAt: undefined,
      lastError: undefined,
      updatedAt: now,
      revision: (current.revision ?? 0) + 1,
    };
    this.#tasks.set(mapKey, updated);
    return { ok: true, value: cloneTask(updated) };
  }

  async recoverCapHandoff(
    key: TaskKey,
    options: { phase?: TaskPhase; now?: string } = {},
  ): Promise<StoreResult<AiTask>> {
    const now = options.now ?? new Date().toISOString();
    const mapKey = taskMapKey(key);
    const current = this.#tasks.get(mapKey);
    if (!current) return { ok: false, code: "not_found" };

    if (current.status !== "ready_for_human") {
      return { ok: false, code: "conflict", current: cloneTask(current) };
    }
    if (!current.context["reviewLoopCapReached"]) {
      return { ok: false, code: "conflict", current: cloneTask(current) };
    }

    const { reviewLoopCapReached: _, escalatedEffort: __, ...contextWithoutCap } = current.context;
    const updated: AiTask = {
      ...current,
      status: "queued",
      phase: options.phase ?? "review",
      ownerRunId: undefined,
      leaseExpiresAt: undefined,
      lastError: undefined,
      context: { ...contextWithoutCap, reviewCycles: 0 },
      updatedAt: now,
      revision: (current.revision ?? 0) + 1,
    };
    this.#tasks.set(mapKey, updated);
    return { ok: true, value: cloneTask(updated) };
  }

  async clearTaskDelay(key: TaskKey, options: { now?: string } = {}): Promise<StoreResult<AiTask>> {
    const now = options.now ?? new Date().toISOString();
    const mapKey = taskMapKey(key);
    const current = this.#tasks.get(mapKey);
    if (!current) return { ok: false, code: "not_found" };

    if (current.status !== "queued") {
      return { ok: false, code: "conflict", current: cloneTask(current) };
    }

    const updated: AiTask = {
      ...current,
      notBefore: undefined,
      updatedAt: now,
      revision: (current.revision ?? 0) + 1,
    };
    this.#tasks.set(mapKey, updated);
    return { ok: true, value: cloneTask(updated) };
  }

  /**
   * Cancel a task (issue #608). See {@link TaskStore.cancelTask} for the full
   * contract; this in-memory double mirrors SqliteTaskStore's read-check-write
   * exactly (a single synchronous JS call is already atomic here).
   */
  async cancelTask(
    key: TaskKey,
    options: { reason?: string; now?: string } = {},
  ): Promise<StoreResult<AiTask>> {
    const now = options.now ?? new Date().toISOString();
    return this.#applyCancel(key, options, now);
  }

  /**
   * In-process equivalent of SqliteTaskStore.cancelTaskWithEffects (issue
   * #608 review): the transition, event, and outbox effects all apply
   * synchronously against this store's own in-memory maps, so — as with
   * {@link completePhaseWithEffects} — a single JS call is already atomic.
   */
  async cancelTaskWithEffects(
    key: TaskKey,
    options: { reason?: string; now?: string } = {},
    event: TaskEvent,
    effects: OutboxEffect[],
  ): Promise<StoreResult<AiTask>> {
    const now = options.now ?? new Date().toISOString();
    const result = this.#applyCancel(key, options, now);
    if (!result.ok) return result;

    await this.appendEvent(event);
    for (const effect of effects) this.#applyOutboxEffect(effect);
    return result;
  }

  #applyCancel(
    key: TaskKey,
    options: { reason?: string; now?: string },
    now: string,
  ): StoreResult<AiTask> {
    const mapKey = taskMapKey(key);
    const current = this.#tasks.get(mapKey);
    if (!current) return { ok: false, code: "not_found" };

    if (current.status === "cancelled") {
      return { ok: false, code: "already_cancelled", current: cloneTask(current) };
    }
    if (current.status === "done" || current.status === "failed") {
      return { ok: false, code: "conflict", current: cloneTask(current) };
    }

    const updated: AiTask = {
      ...current,
      status: "cancelled",
      ownerRunId: undefined,
      leaseExpiresAt: undefined,
      notBefore: undefined,
      lastError: undefined,
      context: {
        ...current.context,
        cancelledAt: now,
        ...(options.reason !== undefined ? { cancelReason: options.reason } : {}),
      },
      updatedAt: now,
      revision: (current.revision ?? 0) + 1,
    };
    this.#tasks.set(mapKey, updated);
    return { ok: true, value: cloneTask(updated) };
  }

  async appendEvent(event: TaskEvent): Promise<void> {
    this.#events.push({ ...event, task: { ...event.task }, data: cloneRecord(event.data) });
  }

  async listEvents(key: TaskKey): Promise<TaskEvent[]> {
    return this.#events
      .filter((event) => event.task.sessionId === key.sessionId && event.task.issueNumber === key.issueNumber)
      .map((event) => ({ ...event, task: { ...event.task }, data: cloneRecord(event.data) }));
  }

  /**
   * In-process equivalent of SqliteTaskStore.completePhaseWithEffects (issue
   * #701): the transition, event, and outbox effects all apply synchronously
   * against this store's own in-memory maps, so there is no cross-connection
   * commit to coordinate — a single JS call is already atomic. Effects are
   * retained (idempotency-key deduped, same as the SQLite outbox table) rather
   * than dispatched; this store has no backing outbox/dispatch pipeline of its
   * own, matching its existing role as a lightweight in-memory double.
   */
  async completePhaseWithEffects(
    transition: PhaseCompletionTransition,
    effects: OutboxEffect[],
  ): Promise<StoreResult<AiTask>> {
    const result = await this.transitionTask(transition.key, transition.expected, transition.patch);
    if (!result.ok) return result;

    await this.appendEvent(transition.event);
    for (const effect of effects) this.#applyOutboxEffect(effect);
    return result;
  }

  #applyOutboxEffect(effect: OutboxEffect): void {
    if (this.#outboxEntries.has(effect.input.idempotencyKey)) return;
    if (effect.kind === "replacePendingPrSummary") {
      for (const [key, entry] of this.#outboxEntries) {
        const payload = entry.payload as { owner?: string; repo?: string; prNumber?: number; marker?: string };
        if (
          entry.topic === "repohost:pr-summary" &&
          payload.owner === effect.key.owner &&
          payload.repo === effect.key.repo &&
          payload.prNumber === effect.key.prNumber &&
          payload.marker === effect.key.marker
        ) {
          this.#outboxEntries.delete(key);
        }
      }
    }
    this.#outboxEntries.set(effect.input.idempotencyKey, {
      topic: effect.input.topic,
      payload: effect.input.payload,
      createdAt: effect.input.now ?? new Date().toISOString(),
    });
  }
}

function taskMapKey(key: TaskKey): string {
  return `${key.sessionId}:${key.issueNumber}`;
}

function matchesExpected(task: AiTask, expected: TaskExpected): boolean {
  return Object.entries(expected).every(([field, value]) => task[field as keyof TaskExpected] === value);
}

function cloneTask(task: AiTask): AiTask;
function cloneTask(task: AiTask | undefined): AiTask | undefined;
function cloneTask(task: AiTask | undefined): AiTask | undefined {
  if (!task) return undefined;
  return {
    ...task,
    attempts: { ...task.attempts },
    context: { ...task.context },
  };
}

function cloneRecord<T extends Record<string, unknown> | undefined>(value: T): T {
  if (!value) return value;
  return { ...value } as T;
}
