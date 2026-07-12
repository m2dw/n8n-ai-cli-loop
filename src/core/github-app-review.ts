// ---------------------------------------------------------------------------
// GitHub App human-review detection (Path B in docs/human-review-return-flow.md)
//
// Pure, deterministic selection of human "request changes" review feedback for a
// PR. This is the detection half of the GitHub-App-based human-review return: it
// takes already-fetched PR reviews + inline review comments and decides whether a
// human reviewer has requested changes, and if so collects the feedback text to
// forward to the implementation fix agent.
//
// It performs NO I/O: fetching reviews (which requires `gh` / the GitHub API) and
// the requeue side effects live in the CLI layer. Keeping selection pure makes
// the trust- and identity-separation rules independently testable.
//
// Identity separation is the whole point of the GitHub App path: the automation
// (the GitHub App) and human maintainers carry distinct GitHub identities, so we
// can safely treat human reviews as feedback while ignoring the automation's own
// reviews/comments. We therefore exclude any bot author (GitHub App / Actions),
// identified by either the GitHub `User.type === "Bot"` flag or the conventional
// `[bot]` login suffix, plus any explicitly excluded login (e.g. the configured
// AI actor). Review text is untrusted regardless of role and MUST still be
// bounded + sanitized by the caller before storage or use.
// ---------------------------------------------------------------------------

/** GitHub PR review states. Unknown values are passed through as opaque strings. */
export type PrReviewState =
  | "APPROVED"
  | "CHANGES_REQUESTED"
  | "COMMENTED"
  | "DISMISSED"
  | "PENDING"
  | string;

/** A single PR review (the top-level review, not its inline comments). */
export interface PrReview {
  /** Review id (GitHub numeric id, carried as a string). Empty when unknown. */
  id: string;
  /** Author login. Empty string when unknown. */
  author: string;
  /** GitHub account type for the author, when known ("Bot" | "User" | ...). */
  authorType?: string;
  state: PrReviewState;
  /** Review summary body (may be empty for a review that is only inline comments). */
  body: string;
  /** ISO-8601 submit timestamp. Empty string when unknown. */
  submittedAt: string;
  /** Permalink to the review, when known. */
  url?: string;
}

/** A single inline review comment, associated to a review by `reviewId`. */
export interface PrReviewComment {
  /** The id of the review this comment belongs to (GitHub `pull_request_review_id`). */
  reviewId?: string;
  author: string;
  authorType?: string;
  body: string;
  /** File path the inline comment is attached to, when known. */
  path?: string;
  createdAt?: string;
}

export interface SelectFeedbackOptions {
  /**
   * Additional author logins to treat as automation and exclude (case-insensitive),
   * e.g. the configured AI actor login when it is not a `[bot]` account. Bot
   * accounts are always excluded regardless of this list.
   */
  excludeAuthors?: string[];
}

export interface ReviewFeedbackSelection {
  found: boolean;
  /** Human-readable explanation of the decision (for audit/diagnostics). */
  reason: string;
  /** Assembled (raw, unsanitized) feedback text. Present only when `found`. */
  feedback?: string;
  /**
   * The representative review: the most recently submitted active change request
   * that contributed feedback. Its id/author/timestamp key the caller's
   * already-processed dedup. Present only when `found`.
   */
  review?: PrReview;
  /**
   * Ids of EVERY active CHANGES_REQUESTED review aggregated into the feedback,
   * oldest→newest, with unknown (empty) ids omitted. The caller stores this whole
   * set so a multi-reviewer aggregate is remembered in full: keying dedup on only
   * the representative id would let an older, already-forwarded reviewer's request
   * be requeued again once a newer reviewer clears theirs. Present only when `found`.
   */
  reviewIds?: string[];
  /**
   * Number of distinct active CHANGES_REQUESTED reviews aggregated into the
   * feedback (>= 1). Present only when `found`.
   */
  reviewCount?: number;
  /** Number of inline comments folded into the feedback. Present only when `found`. */
  inlineCommentCount?: number;
}

/**
 * True when a review/comment author is an automation account: the GitHub
 * `User.type === "Bot"` flag (authoritative when present) or the conventional
 * `[bot]` login suffix (e.g. `my-app[bot]`). An empty/unknown login is treated as
 * a bot so it can never be mistaken for human feedback.
 */
export function isBotAuthor(author: string, authorType?: string): boolean {
  if (authorType && authorType.toLowerCase() === "bot") return true;
  if (!author) return true;
  return author.endsWith("[bot]");
}

/** Order reviews oldest→newest. Reviews without a parseable timestamp sort last,
 * preserving input order among themselves so a stable "latest" can still be picked. */
function compareSubmittedAt(a: PrReview, b: PrReview): number {
  const ta = Date.parse(a.submittedAt);
  const tb = Date.parse(b.submittedAt);
  const va = Number.isNaN(ta) ? Number.POSITIVE_INFINITY : ta;
  const vb = Number.isNaN(tb) ? Number.POSITIVE_INFINITY : tb;
  return va - vb;
}

/**
 * Decide whether a human reviewer has requested changes on the PR and, if so,
 * collect the feedback to forward to the fix agent.
 *
 * Rules:
 *   - Automation authors (bots / explicitly excluded logins) are ignored for both
 *     reviews and inline comments — the automation must never feed itself.
 *   - We track each human reviewer's MOST RECENT decisive review. GitHub keeps a
 *     CHANGES_REQUESTED review active until the reviewer APPROVES or the review is
 *     DISMISSED; a later COMMENTED (or PENDING) review does NOT clear it. So only a
 *     subsequent APPROVED/DISMISSED supersedes an earlier CHANGES_REQUESTED — a
 *     reviewer who requests changes and then merely comments still requeues.
 *   - ALL reviewers with an active CHANGES_REQUESTED review are aggregated: every
 *     such review's summary body plus its inline comments (matched by review id,
 *     from non-automation authors) is folded into one feedback blob. Aggregating
 *     (rather than picking only the latest) is what keeps outstanding feedback from
 *     being skipped in a multi-reviewer PR: if we surfaced only the newest request,
 *     the caller would record that one as processed and, on the next poll after the
 *     fix cycle, treat it as already handled and exit — never surfacing an older
 *     reviewer's still-active request. Surfacing everything each requeue means a
 *     later skip (newest active review unchanged) is correct: all current feedback
 *     was already forwarded.
 *   - The representative `review` is the most recently submitted active change
 *     request that actually contributed text; the caller keys its already-processed
 *     dedup on it.
 *   - Approved-only / comment-only / dismissed reviews never requeue. Reviews with
 *     no usable text (empty body and no inline comments) contribute nothing.
 *
 * The returned `feedback` is raw and untrusted; the caller MUST bound + sanitize
 * it before storage or use.
 */
export function selectChangesRequestedFeedback(
  reviews: PrReview[],
  comments: PrReviewComment[],
  opts: SelectFeedbackOptions = {},
): ReviewFeedbackSelection {
  const excluded = new Set((opts.excludeAuthors ?? []).map((a) => a.toLowerCase()));
  const isAutomation = (author: string, authorType?: string): boolean =>
    isBotAuthor(author, authorType) || excluded.has(author.toLowerCase());

  const humanReviews = reviews.filter((r) => !isAutomation(r.author, r.authorType));
  if (humanReviews.length === 0) {
    return { found: false, reason: "No human (non-automation) reviews found on the PR" };
  }

  // Per human reviewer, resolve their latest DECISIVE review state. GitHub keeps a
  // CHANGES_REQUESTED active until the reviewer APPROVES or the review is DISMISSED;
  // COMMENTED/PENDING reviews leave the prior state untouched. So we ignore
  // non-decisive states when resolving each reviewer's standing, and only treat a
  // reviewer as having an active change request when their latest CHANGES_REQUESTED
  // is not followed by an APPROVED/DISMISSED. The selected review is that
  // CHANGES_REQUESTED review itself (not the trailing comment), so its body + inline
  // comments are the feedback.
  const ordered = [...humanReviews].sort(compareSubmittedAt);
  const isDecisive = (state: PrReviewState): boolean =>
    state === "CHANGES_REQUESTED" || state === "APPROVED" || state === "DISMISSED";
  const activeChangeRequestByAuthor = new Map<string, PrReview>();
  for (const r of ordered) {
    if (!isDecisive(r.state)) continue; // comments/pending don't change standing
    if (r.state === "CHANGES_REQUESTED") {
      activeChangeRequestByAuthor.set(r.author, r);
    } else {
      // APPROVED or DISMISSED clears any outstanding change request for this author.
      activeChangeRequestByAuthor.delete(r.author);
    }
  }

  const activeChangeRequests = [...activeChangeRequestByAuthor.values()];
  if (activeChangeRequests.length === 0) {
    return {
      found: false,
      reason:
        "No active human CHANGES_REQUESTED review (only approvals, comments, dismissed, or superseded change requests)",
    };
  }

  // Aggregate every active change request (oldest→newest for stable, readable
  // ordering) rather than only the latest, so no reviewer's outstanding feedback is
  // skipped. Reviews with no usable text contribute nothing.
  activeChangeRequests.sort(compareSubmittedAt);

  interface Contribution {
    review: PrReview;
    text: string;
    inlineCount: number;
  }
  const contributions: Contribution[] = [];
  for (const r of activeChangeRequests) {
    // Inline comments belonging to this review, from non-automation authors.
    const inline = comments.filter(
      (c) =>
        r.id !== "" &&
        c.reviewId === r.id &&
        !isAutomation(c.author, c.authorType) &&
        c.body.trim().length > 0,
    );

    const parts: string[] = [];
    const body = r.body.trim();
    if (body.length > 0) parts.push(body);
    for (const c of inline) {
      const loc = c.path ? `${c.path}: ` : "";
      parts.push(`- ${loc}${c.body.trim()}`);
    }
    if (parts.length === 0) continue; // reviewer left no usable text → contributes nothing

    contributions.push({ review: r, text: parts.join("\n\n"), inlineCount: inline.length });
  }

  if (contributions.length === 0) {
    return {
      found: false,
      reason:
        "Active CHANGES_REQUESTED review(s) have no usable feedback text (empty bodies and no inline comments)",
    };
  }

  // Attribute each block to its reviewer only when more than one reviewer's feedback
  // is actually combined, leaving the single-reviewer output unchanged.
  const multiReviewer = contributions.length > 1;
  const feedback = contributions
    .map((c) =>
      multiReviewer && c.review.author ? `@${c.review.author} requested changes:\n${c.text}` : c.text,
    )
    .join("\n\n")
    .trim();

  // Representative review = the most recently submitted active change request that
  // contributed text (contributions are ordered oldest→newest). The caller keys its
  // already-processed dedup on this review.
  const selected = contributions[contributions.length - 1].review;
  const inlineCommentCount = contributions.reduce((sum, c) => sum + c.inlineCount, 0);
  // Every contributing review's id (unknown ids omitted), so the caller can record
  // and compare the full aggregated set rather than just the representative id.
  const reviewIds = contributions.map((c) => c.review.id).filter((id) => id !== "");

  return {
    found: true,
    reason:
      multiReviewer
        ? `Aggregated ${contributions.length} active human CHANGES_REQUESTED reviews`
        : "Human CHANGES_REQUESTED review selected",
    feedback,
    review: selected,
    reviewIds,
    reviewCount: contributions.length,
    inlineCommentCount,
  };
}
