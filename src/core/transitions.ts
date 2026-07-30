import type { AiTask, TaskPatch, TaskPhase, TaskStatus } from "./task.js";
import { ARTIFACT_DIR_PENDING_CONTEXT_FIELD } from "../handlers/artifact-dir.js";

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
  const context = patch.context ? { ...task.context, ...patch.context } : task.context;
  // issue #611 review: a patch carrying `artifactDir` is this run's own
  // statement about that path — most handlers reach mkdirSync/
  // isSafeArtifactDirAfterRun success and hand back a fresh, validated
  // directory without also repeating the pending marker at every return
  // site, so default it to cleared here rather than requiring every call
  // site to remember. Only auto-clears when the patch omits the pending key
  // outright (`Object.prototype.hasOwnProperty`): a patch that still intends
  // the path to be pending (a pre-creation failure) always sets both keys
  // together as sibling literals (see the phase handlers) and is left
  // untouched. A patch that spreads `...task.context` AND overrides
  // `artifactDir` to a new value in the same object also carries forward
  // whatever pending value the old context happened to hold — indistinguishable
  // here from a deliberate `true` — so a handler using that shape must assert
  // `[ARTIFACT_DIR_PENDING_CONTEXT_FIELD]: false` itself alongside the override
  // (see content-research.ts's quota-delayed return) rather than relying on
  // this default.
  if (
    patch.context &&
    Object.prototype.hasOwnProperty.call(patch.context, "artifactDir") &&
    !Object.prototype.hasOwnProperty.call(patch.context, ARTIFACT_DIR_PENDING_CONTEXT_FIELD)
  ) {
    context[ARTIFACT_DIR_PENDING_CONTEXT_FIELD] = false;
  }
  return {
    ...task,
    ...patch,
    context,
    attempts: patch.attempts ? { ...task.attempts, ...patch.attempts } : task.attempts,
    updatedAt: now,
    // Monotonic write counter (issue #622 review, P2) — see AiTask.revision.
    revision: (task.revision ?? 0) + 1,
  };
}

/**
 * Bounds the content_draft <-> content_review editorial cycle (issue #603
 * review follow-up). Unlike the code implementation/review loop, the content
 * review agent can indefinitely return `needs_fix`; without a cap the task
 * would loop forever spending agent runs with no human handoff.
 */
export const DEFAULT_MAX_CONTENT_REVIEW_CYCLES = 3;

export function nextPhaseAfter(
  phase: TaskPhase,
  result: "success" | "needs_fix" | "conflict" | "blocked" | "tool_request",
  task?: Pick<AiTask, "attempts" | "context">,
  admissionRejected?: boolean,
): { status: TaskStatus; phase: TaskPhase; contextPatch?: Record<string, unknown> } {
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
  // A report-only-mode admission rejection of conflict_resolution (issue #532
  // review) must stay resumable the same way: the phase-admission preflight
  // (see phase-runner.ts) rejected the task before the lock/worktree/handler
  // ever ran, so this is not a genuine conflict escalation — it is a hold that
  // lifts automatically once report-only mode is turned off. `ready_for_human`
  // would clear the conflict-routing labels (outbox-effects.ts) and strand the
  // task, since store reactivation (issue #224) only re-activates `blocked`
  // implementation tasks. A *handler*-decided conflict_resolution `blocked`
  // (e.g. a non-auto-resolvable or repeated semantic conflict) is unaffected —
  // it never sets `admissionRejected` and keeps escalating to ready_for_human.
  if (result === "blocked" && phase === "conflict_resolution" && admissionRejected) {
    return { status: "blocked", phase };
  }
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
  if (phase === "content_research" && result === "success") {
    return { status: "queued", phase: "content_draft" };
  }
  if (phase === "content_draft" && result === "success") {
    return { status: "queued", phase: "content_review" };
  }
  if (phase === "content_review" && result === "needs_fix") {
    // `attempts.content_review` counts every CLAIM of this phase, including runs
    // that were released back to `queued` after a quota/rate-limit delay (issue
    // #25) and later reclaimed — those never produced an editorial verdict, so
    // counting them toward the cap could escalate to a human after far fewer
    // than DEFAULT_MAX_CONTENT_REVIEW_CYCLES actual draft/review revisions.
    // Track completed `needs_fix` cycles in task context instead, incremented
    // only here (i.e. only on an actual editorial "needs revision" outcome).
    const priorCycles =
      typeof task?.context?.contentReviewNeedsFixCycles === "number"
        ? task.context.contentReviewNeedsFixCycles
        : 0;
    const cycles = priorCycles + 1;
    if (cycles >= DEFAULT_MAX_CONTENT_REVIEW_CYCLES) {
      // Cap hit: hand off to a human. The content_review handler deliberately
      // leaves `context.artifactDir` pointing at the draft dir (containing
      // content-draft-output.md) for this terminal path — do not touch it here.
      return { status: "ready_for_human", phase };
    }
    // Looping back to content_draft: it reads `ctx.artifactDir` as the research
    // dir, so restore it from `researchArtifactDir` (stashed by content_draft's
    // success context) before re-queuing. This is the one place that knows the
    // task is actually continuing the cycle rather than reaching the cap.
    const researchArtifactDir =
      typeof task?.context?.researchArtifactDir === "string"
        ? task.context.researchArtifactDir
        : undefined;
    return {
      status: "queued",
      phase: "content_draft",
      contextPatch: {
        contentReviewNeedsFixCycles: cycles,
        ...(researchArtifactDir !== undefined ? { artifactDir: researchArtifactDir } : {}),
      },
    };
  }
  // Review passed. A dependency-started PR (one whose branch was created from a
  // blocker PR head) is delivered to the session base branch (`main`) just like
  // any other PR, so a passing review follows the normal ready_for_human handoff.
  // It is NOT held back merely because `dependencyBase` metadata is present:
  // merge ordering is owned by GitHub Issue Relationships and human review, not
  // by this system (issue #233).
  return { status: "ready_for_human", phase };
}
