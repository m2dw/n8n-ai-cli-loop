import type {
  AiTask,
  ClaimNextTaskRequest,
  EnqueueTaskInput,
  StoreResult,
  TaskEvent,
  TaskExpected,
  TaskKey,
  TaskPatch,
} from "./task.js";

export interface TaskStore {
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
  listEvents(key: TaskKey): Promise<TaskEvent[]>;
}
