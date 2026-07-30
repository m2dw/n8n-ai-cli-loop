/**
 * Retention taxonomy (issue #611, docs/retention-backup-contract.md §4-§5).
 *
 * Classifies a task row into the retention lifecycle buckets the contract
 * defines, and evaluates whether a task has aged past its retention floor.
 * This module is pure and read-only — it never touches the database.
 *
 * Scope note: only `tasks`/`events` retention is implemented here. Outbox and
 * context-record retention are excluded per the contract's own fail-closed
 * posture (§12): outbox rows have no persisted `session_id` to scope a
 * session-level prune by, and context records have no persisted association
 * to the tasks that use them, so neither can be classified safely from the
 * current schema.
 */

import type { AiTask } from "./task.js";
import { hasUnresolvedToolRequest } from "./tool-request.js";
import { isClaimExpired } from "./transitions.js";

export type RetentionBucket = "active" | "delayed" | "human_gated" | "terminal" | "cancelled";

/** §5: floors are minimums — never eligible sooner, default equals the floor. */
export const TERMINAL_RETENTION_FLOOR_MS = 180 * 24 * 60 * 60 * 1000;
export const CANCELLED_RETENTION_FLOOR_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Classify a task's retention bucket (§4). Mirrors `cli/admin.ts`'s
 * `classifyStatus` liveness logic (claimed/running staleness is a recovery
 * concern, not a retention one — a stale claim is still "active" here) but
 * collapses the finer operator-facing states into the five retention buckets
 * this contract defines.
 */
export function classifyRetentionBucket(task: AiTask, nowIso: string): RetentionBucket {
  switch (task.status) {
    case "done":
    case "failed":
      return "terminal";
    case "cancelled":
      return "cancelled";
    case "blocked":
    case "ready_for_human":
      return "human_gated";
    case "queued":
      return task.notBefore && nowIso < task.notBefore ? "delayed" : "active";
    case "claimed":
    case "running":
      // Staleness (an expired lease) is a recovery concern (`admin recover`),
      // not a retention one — the task is still mid-flight until an operator
      // or the scheduler reclaims it.
      return "active";
    default:
      return "human_gated";
  }
}

export type PruneIneligibleReason =
  | "active"
  | "delayed"
  | "human_gated"
  | "unresolved_tool_request"
  | "within_floor";

export type TaskRetentionEvaluation =
  | { eligible: true; bucket: "terminal" | "cancelled"; floorMs: number; ageMs: number }
  | { eligible: false; bucket: RetentionBucket; reason: PruneIneligibleReason };

/**
 * Evaluate whether a task row is old enough, and otherwise unexcluded, to be
 * a raw-deletion candidate (§4/§5/§12). This does NOT check rollup coverage
 * (§6) — that is a separate, additional precondition callers must apply
 * before actually deleting anything.
 */
export function evaluateTaskRetention(task: AiTask, nowIso: string): TaskRetentionEvaluation {
  const bucket = classifyRetentionBucket(task, nowIso);

  if (bucket === "active") return { eligible: false, bucket, reason: "active" };
  if (bucket === "delayed") return { eligible: false, bucket, reason: "delayed" };
  if (bucket === "human_gated") return { eligible: false, bucket, reason: "human_gated" };

  // §12: an unresolved Tool Request excludes a task outright regardless of
  // its nominal status bucket.
  if (hasUnresolvedToolRequest(task.context)) {
    return { eligible: false, bucket, reason: "unresolved_tool_request" };
  }

  const floorMs = bucket === "terminal" ? TERMINAL_RETENTION_FLOOR_MS : CANCELLED_RETENTION_FLOOR_MS;
  const ageMs = Date.parse(nowIso) - Date.parse(task.updatedAt);
  if (!(ageMs >= floorMs)) {
    return { eligible: false, bucket, reason: "within_floor" };
  }

  return { eligible: true, bucket, floorMs, ageMs };
}

/** Re-exported for callers that only need the staleness check alongside this module. */
export { isClaimExpired };
