/**
 * §13 backward compatibility at the point subsequent implementation/fix
 * processing consumes `task.context` (issue #842).
 *
 * This module owns no schema, classifier, or validator of its own. It
 * composes the issue #836 compatibility helper
 * (`legacyFindingFromReviewFeedback`) and the issue #836 runtime validator
 * (`validateReviewDisputeContext`) to answer one question for a persisted
 * task context: which representation of "what the review said" is
 * authoritative right now, and is any of it disputable?
 *
 * Pure and side-effect-free by construction: every call recomputes its
 * answer straight from `context.reviewFeedback` and `context.reviewDispute`,
 * so repeated calls against the same context are byte-identical — idempotent
 * without a persisted "converted" flag. Nothing here writes back to the task
 * context, so there is no separate conversion step to keep in sync: a stale
 * legacy view is superseded automatically the next time this runs against a
 * context whose `reviewDispute` a later admitted review (issue #841) has
 * overwritten.
 */
import type { TaskContext } from "./task.js";
import {
  legacyFindingFromReviewFeedback,
  REVIEW_DISPUTE_DEFAULT_LIMITS,
  type LegacyReviewFinding,
  type ReviewDisputeContext,
  type ReviewDisputeLimits,
} from "./review-dispute.js";
import { validateReviewDisputeContext } from "./review-dispute-validation.js";

/**
 * How a task context's review state resolves for consumption:
 *  - `disabled`   — the protocol is off (`session.reviewDispute.enabled` is
 *    `false`); any `reviewDispute` block present is ignored, matching §13's
 *    byte-identical-to-today rule.
 *  - `empty`      — no feedback of either shape.
 *  - `legacy`     — free-form `reviewFeedback` only, no structured block.
 *  - `mixed`      — a valid structured block plus residual free prose; both
 *    keep their §13 roles (structured findings admitted, prose keeps its
 *    legacy blocking force).
 *  - `structured` — a valid, fully structured block; it alone is
 *    authoritative, and no legacy finding is reported even if
 *    `reviewFeedback` happens to still hold text.
 *  - `malformed`  — a `reviewDispute` block is present but fails validation.
 *    §12 fail-closed: never trusted, never silently repaired or upgraded.
 */
export const REVIEW_COMPAT_MODES = ["disabled", "empty", "legacy", "mixed", "structured", "malformed"] as const;
export type ReviewCompatMode = (typeof REVIEW_COMPAT_MODES)[number];

export interface ReviewCompatResolution {
  mode: ReviewCompatMode;
  /** The non-disputable §13 view of the free-form prose, when one applies. */
  legacyFinding: LegacyReviewFinding | null;
  /** The validated structured block, only when it is authoritative. */
  reviewDispute: ReviewDisputeContext | null;
  /** Set only in `malformed` mode: why `context.reviewDispute` was rejected. */
  malformedReason?: string;
}

export interface ResolveReviewCompatOptions {
  /**
   * `session.reviewDispute.enabled`. Omit or pass `true` to classify a
   * present `reviewDispute` block normally; pass `false` explicitly for the
   * disabled/rollback path, where any structured block is ignored.
   */
  enabled?: boolean;
  /** The session's resolved §6.1 limits; defaults are used when absent. */
  limits?: ReviewDisputeLimits;
}

/**
 * Resolve which review representation is authoritative for `context`
 * (§13, issue #842's task-context consumption boundary).
 *
 * Bounded and deterministic: the legacy finding is bounded by
 * `legacyFindingFromReviewFeedback`, the structured block is bounded by
 * `validateReviewDisputeContext`, and the same `context` always yields the
 * same resolution.
 */
export function resolveReviewCompatContext(
  context: TaskContext,
  opts: ResolveReviewCompatOptions = {},
): ReviewCompatResolution {
  const feedback = typeof context["reviewFeedback"] === "string" ? (context["reviewFeedback"] as string) : undefined;

  if (opts.enabled === false) {
    return { mode: "disabled", legacyFinding: null, reviewDispute: null };
  }

  const raw = context["reviewDispute"];
  if (raw === undefined || raw === null) {
    const legacyFinding = legacyFindingFromReviewFeedback(feedback);
    return legacyFinding
      ? { mode: "legacy", legacyFinding, reviewDispute: null }
      : { mode: "empty", legacyFinding: null, reviewDispute: null };
  }

  const validated = validateReviewDisputeContext(raw, "reviewDispute", opts.limits ?? REVIEW_DISPUTE_DEFAULT_LIMITS);
  if (!validated.ok) {
    // §12 fail-closed: a malformed structured block is never trusted, never
    // interpreted, and never silently repaired or upgraded — it is treated
    // exactly as absent, and whatever legacy prose exists keeps flowing.
    return {
      mode: "malformed",
      legacyFinding: legacyFindingFromReviewFeedback(feedback),
      reviewDispute: null,
      malformedReason: `${validated.failure.reason}${validated.failure.detail ? `:${validated.failure.detail}` : ""}`,
    };
  }

  const reviewDispute = validated.value;
  if (reviewDispute.reviewStructure === "structured") {
    // §13: a fully structured review's residual prose is empty by
    // construction. The structured block is authoritative regardless of
    // whatever text `reviewFeedback` still carries (e.g. left over from a
    // prior legacy run), so no legacy finding is reported here.
    return { mode: "structured", legacyFinding: null, reviewDispute };
  }
  const legacyFinding = legacyFindingFromReviewFeedback(feedback);
  if (reviewDispute.reviewStructure === "mixed") {
    return { mode: "mixed", legacyFinding, reviewDispute };
  }
  // `reviewStructure === "legacy"` on a *present* block: issue #841's
  // admission path never persists this combination, since it always counts
  // at least one structured block, but a hand-authored or future context
  // could. Nothing structured is actually authoritative here, so report it
  // the same as no block at all — while still returning the block itself,
  // since it is validated and callers may want to see it.
  return { mode: "legacy", legacyFinding, reviewDispute };
}
