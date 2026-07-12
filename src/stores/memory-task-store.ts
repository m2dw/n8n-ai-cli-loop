import type {
  AiTask,
  ClaimNextTaskRequest,
  EnqueueTaskInput,
  StoreResult,
  TaskEvent,
  TaskExpected,
  TaskKey,
  TaskPatch,
} from "../core/task.js";
import { applyTaskPatch, isRunnable, leaseExpiry, priorityRank } from "../core/transitions.js";
import { ASSIGNMENT_CONTEXT_KEY } from "../core/assignment.js";
import type { TaskStore } from "../core/task-store.js";

const DEFAULT_LEASE_MS = 30 * 60 * 1000;

export class MemoryTaskStore implements TaskStore {
  readonly #tasks = new Map<string, AiTask>();
  readonly #events: TaskEvent[] = [];

  async enqueueTask(input: EnqueueTaskInput): Promise<StoreResult<AiTask>> {
    const now = input.now ?? new Date().toISOString();
    const key = taskMapKey(input);
    const existing = this.#tasks.get(key);
    if (existing) {
      // Re-enqueue dependency-held implementation tasks (issue #224). Mirror the
      // SqliteTaskStore behavior: a blocked implementation task is re-activated so
      // that intake can pick it up once its blocker becomes stack-ready.
      if (existing.status === "blocked" && existing.phase === "implementation") {
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

  async appendEvent(event: TaskEvent): Promise<void> {
    this.#events.push({ ...event, task: { ...event.task }, data: cloneRecord(event.data) });
  }

  async listEvents(key: TaskKey): Promise<TaskEvent[]> {
    return this.#events
      .filter((event) => event.task.sessionId === key.sessionId && event.task.issueNumber === key.issueNumber)
      .map((event) => ({ ...event, task: { ...event.task }, data: cloneRecord(event.data) }));
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
