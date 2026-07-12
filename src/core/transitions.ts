import type { AiTask, TaskPatch, TaskPhase, TaskStatus } from "./task.js";

export function leaseExpiry(now: string, leaseMs: number): string {
  return new Date(Date.parse(now) + leaseMs).toISOString();
}

export function isClaimExpired(task: AiTask, now: string): boolean {
  if (!task.leaseExpiresAt) return false;
  return Date.parse(task.leaseExpiresAt) <= Date.parse(now);
}

/**
 * A queued task carrying a future `notBefore` is a delayed retry (issue #25):
 * it was released after a quota/rate-limit failure and must not be reclaimed
 * until the delay window elapses.
 */
export function isDelayed(task: AiTask, now: string): boolean {
  if (!task.notBefore) return false;
  return Date.parse(task.notBefore) > Date.parse(now);
}

export function isRunnable(task: AiTask, now: string): boolean {
  if (task.status === "queued") return !isDelayed(task, now);
  if (task.status !== "claimed" && task.status !== "running") return false;
  return isClaimExpired(task, now);
}

export function priorityRank(priority: AiTask["priority"]): number {
  if (priority === "high") return 0;
  if (priority === "low") return 2;
  return 1;
}

export function applyTaskPatch(task: AiTask, patch: TaskPatch): AiTask {
  const now = patch.now ?? new Date().toISOString();
  return {
    ...task,
    ...patch,
    context: patch.context ? { ...task.context, ...patch.context } : task.context,
    attempts: patch.attempts ? { ...task.attempts, ...patch.attempts } : task.attempts,
    updatedAt: now,
  };
}

export function nextPhaseAfter(
  phase: TaskPhase,
  result: "success" | "needs_fix" | "conflict" | "blocked" | "tool_request",
): { status: TaskStatus; phase: TaskPhase } {
  // A disallowed-command Tool Request from an implementation agent is a clean
  // human handoff: hold the task at ready_for_human on the implementation phase
  // so an operator can inspect the request and resolve it (issue #291). Unlike a
  // dependency `blocked`, it does not lift on its own and must not stay queued.
  if (result === "tool_request") return { status: "ready_for_human", phase };
  // Dependency-blocked implementation tasks are held in `blocked` status so they
  // remain eligible for re-enqueue when the blocker becomes stack-ready (issue
  // #224). `ready_for_human` would remove implementation-lane labels from GitHub
  // and permanently dequeue the issue from automation, which is wrong for a hold
  // that lifts naturally when the dependency resolves.
  if (result === "blocked" && phase === "implementation") return { status: "blocked", phase };
  if (result === "blocked") return { status: "ready_for_human", phase };
  if (phase === "implementation" && result === "success") {
    return { status: "queued", phase: "review" };
  }
  if (phase === "review" && result === "needs_fix") {
    return { status: "queued", phase: "implementation" };
  }
  if (phase === "review" && result === "conflict") {
    return { status: "queued", phase: "conflict_resolution" };
  }
  if (phase === "conflict_resolution" && result === "success") {
    return { status: "queued", phase: "review" };
  }
  // Review passed. A dependency-started PR (one whose branch was created from a
  // blocker PR head) is delivered to the session base branch (`main`) just like
  // any other PR, so a passing review follows the normal ready_for_human handoff.
  // It is NOT held back merely because `dependencyBase` metadata is present:
  // merge ordering is owned by GitHub Issue Relationships and human review, not
  // by this system (issue #233).
  return { status: "ready_for_human", phase };
}
