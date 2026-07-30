import type { AiTask } from "../core/task.js";
import { hasUnresolvedToolRequest } from "../core/tool-request.js";
import { extractPrNumber } from "./pr-helpers.js";

export interface DependencyReviewBase {
  sha: string;
  refName?: string;
}

/**
 * Parse `context.dependencyBase` into the durable predecessor review-base
 * metadata a dependency-started task's implementation phase recorded when it
 * created the branch (issue #667). `missing: true` means a `dependencyBase`
 * object IS present but carries no `baseHeadSha` — pre-#667 or otherwise
 * incomplete metadata with no durable start point to reproduce the review
 * diff base from. A task with no `dependencyBase` at all (not dependency-
 * started) reports `missing: false` with no `base`.
 */
export function resolveDependencyReviewBase(context: unknown): { base?: DependencyReviewBase; missing: boolean } {
  const raw =
    typeof context === "object" && context !== null
      ? (context as Record<string, unknown>)["dependencyBase"]
      : undefined;
  const obj = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
  if (obj === undefined) return { missing: false };
  const sha =
    typeof obj["baseHeadSha"] === "string" && (obj["baseHeadSha"] as string).trim().length > 0
      ? (obj["baseHeadSha"] as string).trim()
      : undefined;
  if (sha === undefined) return { missing: true };
  const refName = typeof obj["baseHeadRefName"] === "string" ? (obj["baseHeadRefName"] as string).trim() : undefined;
  return { base: { sha, refName }, missing: false };
}

export type ReviewAdmissionResult =
  | { ok: true; dependencyReviewBase?: DependencyReviewBase }
  | { ok: false; result: "failed"; error: string }
  | { ok: false; result: "blocked"; message: string };

/**
 * Review-admission preflight (issue #681). Runs before ANY review-phase side
 * effect — repo-host resolution, worktree lock/materialization, git/gh calls,
 * artifact writes, or the review agent invocation — and requires durable
 * evidence, computable from `task.context` alone (no network or filesystem
 * access), that the task is actually ready for review:
 *
 *  1. No unresolved implementation Tool Request (issue #677) — a live handoff
 *     is authoritative over whatever queued this review run (a mistaken
 *     `admin recover`, a stale/conflicting GitHub review label, etc.).
 *  2. A durable PR reference (`prUrl` or `branch`) is recorded — otherwise
 *     there is no open PR to review or hand off.
 *  3. That reference resolves to a head selector — a PR number parsed from
 *     `prUrl`, or an explicit `branch` — otherwise the recorded `prUrl`
 *     cannot identify which commits to check out.
 *  4. A dependency-started task (`context.dependencyBase` present) carries
 *     the predecessor `baseHeadSha` the implementation phase recorded when it
 *     created the branch (issue #667) — otherwise there is no durable review
 *     diff boundary to reproduce, and reviewing against the session base
 *     would silently include the predecessor's not-yet-merged changes.
 *
 * A rejection here never touches the issue branch, worktree, Tool Request
 * context, or any partial implementation artifact — nothing has been
 * resolved, locked, checked out, or written yet.
 */
export function checkReviewAdmission(task: AiTask): ReviewAdmissionResult {
  const context = task.context as Record<string, unknown>;

  if (hasUnresolvedToolRequest(context)) {
    return {
      ok: false,
      result: "failed",
      error:
        `Issue #${task.issueNumber} has an unresolved implementation Tool Request; refusing to run review. ` +
        `Resolve it first with 'admin tool-request resolve' or 'admin tool-request grant'.`,
    };
  }

  const prUrl = typeof context["prUrl"] === "string" ? (context["prUrl"] as string) : undefined;
  const branchRaw = typeof context["branch"] === "string" ? (context["branch"] as string) : undefined;
  const branch = branchRaw !== undefined && branchRaw.trim().length > 0 ? branchRaw.trim() : undefined;

  if (prUrl === undefined && branch === undefined) {
    return {
      ok: false,
      result: "failed",
      error:
        `No PR URL or branch in task context for issue #${task.issueNumber}; refusing to run review with no PR ` +
        `to hand off. Run implementation first (status:needs-implementation), or record the PR reference via ` +
        `'admin tool-request grant' / 'admin human-review-return' before retrying.`,
    };
  }

  const prNumber = prUrl !== undefined ? extractPrNumber(prUrl) : undefined;
  if (branch === undefined && (prNumber === undefined || prNumber <= 0)) {
    return {
      ok: false,
      result: "failed",
      error:
        `PR reference '${prUrl}' in task context for issue #${task.issueNumber} does not resolve to a PR number ` +
        `and no branch is recorded; refusing to run review with no resolvable PR head. Correct the recorded ` +
        `prUrl or set an explicit branch in the task context before retrying.`,
    };
  }

  const { base: dependencyReviewBase, missing: dependencyReviewBaseMissing } = resolveDependencyReviewBase(context);
  if (dependencyReviewBaseMissing) {
    return {
      ok: false,
      result: "blocked",
      message:
        `Dependency-started issue #${task.issueNumber} has recorded dependency-start metadata with no predecessor ` +
        `head SHA (dependencyBase.baseHeadSha); there is no durable start point to reproduce the review diff base ` +
        `from. Reviewing against the session base would include the predecessor's not-yet-merged changes as if ` +
        `they belonged to this issue — escalating to human instead of running a misleading cumulative review. ` +
        `Re-run implementation to record dependency-start metadata (issue #667).`,
    };
  }

  return { ok: true, ...(dependencyReviewBase !== undefined ? { dependencyReviewBase } : {}) };
}
