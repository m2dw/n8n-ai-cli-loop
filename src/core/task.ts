export type TaskPhase =
  | "implementation"
  | "review"
  | "conflict_resolution"
  | "research"
  | "content_research"
  | "content_draft"
  | "content_review"
  | "planner";

export type TaskStatus =
  | "queued"
  | "claimed"
  | "running"
  | "blocked"
  | "ready_for_human"
  | "done"
  | "failed"
  // Terminal, operator-initiated cancellation (issue #608). Reachable from any
  // non-terminal status via `TaskStore.cancelTask`; never set by a phase
  // handler result. See `nextPhaseAfter`/`isRunnable` — a cancelled task is
  // never claimable and never advances to another phase.
  | "cancelled";

export type AgentId = "claude" | "codex" | "gemini";

export type TaskPriority = "high" | "normal" | "low";

export type ImplementationMode = "new" | "fix";

export type TaskAttempts = Partial<Record<TaskPhase, number>>;

export type TaskContext = Record<string, unknown>;

export interface AiTask {
  sessionId: string;
  issueNumber: number;
  status: TaskStatus;
  phase: TaskPhase;
  priority: TaskPriority;
  implementationAgent?: AgentId;
  reviewAgent?: AgentId;
  researchAgent?: AgentId;
  ownerRunId?: string;
  leaseExpiresAt?: string;
  /**
   * Earliest time the task may be claimed again. Set when a phase is delayed
   * after a quota/rate-limit agent failure (issue #25): the task is released
   * back to `queued` but `claimNextTask` ignores it until `now >= notBefore`.
   * Absent means immediately eligible. SQLite is the source of truth for this
   * timing — it is never encoded in GitHub labels.
   */
  notBefore?: string;
  attempts: TaskAttempts;
  context: TaskContext;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
  /**
   * Monotonic write counter, incremented by the store on every mutation
   * (issue #622 review, P2). Two writers can read the same `updatedAt` when
   * their clocks land in the same millisecond, which lets a stale
   * `updatedAt`-only CAS check silently pass; `revision` only ever moves by
   * exactly 1 per write, so it cannot collide the way a wall-clock
   * timestamp can. Defaults to 0 for tasks written before this field
   * existed.
   */
  revision: number;
}

export interface EnqueueTaskInput {
  sessionId: string;
  issueNumber: number;
  phase: TaskPhase;
  priority?: TaskPriority;
  implementationAgent?: AgentId;
  reviewAgent?: AgentId;
  researchAgent?: AgentId;
  context?: TaskContext;
  now?: string;
}

export interface TaskKey {
  sessionId: string;
  issueNumber: number;
}

export type TaskExpected = Partial<
  Pick<AiTask, "status" | "phase" | "ownerRunId" | "leaseExpiresAt" | "updatedAt" | "revision">
>;

export type TaskPatch = Partial<
  Pick<
    AiTask,
    | "status"
    | "phase"
    | "priority"
    | "implementationAgent"
    | "reviewAgent"
    | "researchAgent"
    | "ownerRunId"
    | "leaseExpiresAt"
    | "notBefore"
    | "attempts"
    | "context"
    | "lastError"
  >
> & {
  now?: string;
};

export interface ClaimNextTaskRequest {
  sessionId: string;
  workerId: string;
  runId: string;
  now?: string;
  leaseMs?: number;
  /** When set, only tasks whose phase is in this list are eligible for claiming. */
  supportedPhases?: TaskPhase[];
}

export type StoreResultCode =
  | "not_found"
  | "conflict"
  | "already_exists"
  | "tool_request_unresolved"
  // A repeated `cancelTask` call on a task that is already `cancelled` (issue
  // #608). Distinct from `conflict` (a task that reached a DIFFERENT terminal
  // status — done/failed — and so can never be cancelled) so callers can
  // treat a repeat cancellation as an informative no-op rather than an error.
  | "already_cancelled"
  // A whole-file maintenance lock (`prune`/`restore`/`archive rollup`) is held
  // on the store's database, so a write that would enqueue outbox effects
  // alongside its task transition — `completePhaseWithEffects`,
  // `cancelTaskWithEffects` — was refused in full (issue #818). Distinct from
  // `conflict`: nothing about the task itself is wrong and nothing was
  // mutated; the identical call succeeds once maintenance releases the lock,
  // so callers surface it as retryable contention rather than a failure.
  | "maintenance_locked";

export type StoreResult<T> =
  | { ok: true; value: T; reactivated?: boolean }
  | { ok: false; code: StoreResultCode; current?: AiTask };

export interface TaskEvent {
  task: TaskKey;
  type: string;
  runId?: string;
  message?: string;
  data?: Record<string, unknown>;
  createdAt: string;
}
