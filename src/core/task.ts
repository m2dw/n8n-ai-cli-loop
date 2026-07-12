export type TaskPhase =
  | "implementation"
  | "review"
  | "conflict_resolution"
  | "research"
  | "planner";

export type TaskStatus =
  | "queued"
  | "claimed"
  | "running"
  | "blocked"
  | "ready_for_human"
  | "done"
  | "failed";

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
  Pick<AiTask, "status" | "phase" | "ownerRunId" | "leaseExpiresAt">
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

export type StoreResultCode = "not_found" | "conflict" | "already_exists";

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
