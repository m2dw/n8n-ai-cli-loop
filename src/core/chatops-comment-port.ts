/**
 * The provider-facing ChatOps comment port (issue #1024).
 *
 * `src/core/chatops-comment-cursor.ts` (#781) decides whether a *set of pages*
 * proves a complete scan window; it deliberately never fetches one. This module
 * is the seam between the two: the narrow capability surface a work-item
 * provider must offer (`docs/chatops-comment-cursor-contract.md` §6), plus the
 * bounded page walk that turns it into the `ChatOpsScanPage[]` the core
 * evaluates.
 *
 * It is deliberately smaller than `WorkItemProvider` (`src/providers/types.ts`):
 * ChatOps reads a comment list and posts a comment, and nothing else. Keeping
 * the port to those two operations is what lets the runtime be driven by an
 * in-memory fake in tests without standing up a provider, and what keeps a
 * future provider from having to satisfy the whole work-item surface to carry
 * ChatOps.
 *
 * Everything here is provider-neutral: no `gh`, no REST path, no auth. The
 * GitHub binding lives in `src/providers/github/gh-chatops-comment-port.ts`.
 */

import {
  CHATOPS_MAX_SCAN_PAGES,
  chatOpsScanFetchFailure,
} from "./chatops-comment-cursor.js";
import type {
  ChatOpsObservedComment,
  ChatOpsScanPage,
  ChatOpsScanWindowIncomplete,
} from "./chatops-comment-cursor.js";

/** One page of comments as a provider returned it, or the reason it could not be read. */
export type ChatOpsCommentPageResult =
  | { ok: true; page: ChatOpsScanPage }
  | { ok: false; error: string };

/** Whether a posted comment landed. `error` is already provider-redacted. */
export type ChatOpsPostResult = { ok: true } | { ok: false; error: string };

/** One page request. Page numbering is 1-based, matching both supported providers. */
export interface ChatOpsCommentPageRequest {
  issueNumber: number;
  /**
   * Inclusive-ish lower bound from `chatOpsScanSinceBound`, or `null` to read
   * the list from its beginning. An adapter without a `since` filter ignores
   * this: the order-key comparison, not the filter, is what excludes
   * already-seen comments (§6.1).
   */
  since: string | null;
  /** 1-based page index. */
  page: number;
  /** Requested page size; an adapter may return fewer. */
  perPage: number;
}

/**
 * The two capabilities ChatOps needs from a work-item provider.
 *
 * `listComments` must satisfy `docs/chatops-comment-cursor-contract.md` §6:
 * ascending creation order, stable canonical decimal ids, an explicit
 * end-of-list signal, and `createdAt`/`updatedAt` verbatim in one spelling. An
 * adapter that cannot honor ascending order must not be wired here — there is
 * no descending mode, and a descending walk cannot prove a gap-free window.
 */
export interface ChatOpsCommentPort {
  listComments(request: ChatOpsCommentPageRequest): Promise<ChatOpsCommentPageResult>;
  /**
   * Post one comment verbatim. The body is never re-wrapped or annotated by the
   * adapter: a marker's trimmed body must stay exactly canonical
   * (`docs/chatops-result-contract.md` §5.1), and an adapter that appended a
   * footer would silently destroy every marker's authenticity.
   */
  postComment(issueNumber: number, body: string): Promise<ChatOpsPostResult>;
}

/** Default page size. Nothing in §5 depends on it; only page *sequence* matters. */
export const CHATOPS_SCAN_PAGE_SIZE = 100;

/** A page walk that reached the end of the list, or the reason it did not. */
export type ChatOpsScanFetch =
  | { ok: true; pages: readonly ChatOpsScanPage[] }
  | { ok: false; incomplete: ChatOpsScanWindowIncomplete };

export interface ChatOpsScanFetchOptions {
  perPage?: number;
  maxPages?: number;
}

/**
 * Walk the comment list from `since` to its end, one page at a time.
 *
 * Fail-closed by construction: a page that cannot be fetched ends the walk with
 * `chatOpsScanFetchFailure`, which `evaluateChatOpsScanWindow` treats exactly
 * like a structural defect — nothing advances. Stopping early with the pages
 * collected so far and calling it complete is the one thing this must never do:
 * a prefix cannot prove the completeness a dispatch decision needs (§5), and
 * absence of a marker over an incomplete window is not evidence of anything.
 *
 * The page budget is a runaway guard rather than a quota (§5.2), so exhausting
 * it fails the window rather than truncating it. It is enforced here by asking
 * for at most `maxPages` and letting the core reject a run that still reports
 * `hasMore` — the same `pages-truncated` verdict a provider-side truncation
 * produces, which keeps one code path for "the end was never reached".
 */
export async function fetchChatOpsScanPages(
  port: ChatOpsCommentPort,
  issueNumber: number,
  since: string | null,
  options: ChatOpsScanFetchOptions = {},
): Promise<ChatOpsScanFetch> {
  const perPage = options.perPage ?? CHATOPS_SCAN_PAGE_SIZE;
  const maxPages = options.maxPages ?? CHATOPS_MAX_SCAN_PAGES;
  if (!Number.isInteger(perPage) || perPage < 1) {
    throw new Error(`ChatOps scan perPage must be a positive integer, got ${perPage}`);
  }
  if (!Number.isInteger(maxPages) || maxPages < 1) {
    throw new Error(`ChatOps scan maxPages must be a positive integer, got ${maxPages}`);
  }

  const pages: ChatOpsScanPage[] = [];
  for (let page = 1; page <= maxPages; page += 1) {
    let result: ChatOpsCommentPageResult;
    try {
      result = await port.listComments({ issueNumber, since, page, perPage });
    } catch (err) {
      // A throwing adapter is the same class of event as one that reports a
      // failure: the window is unproven either way, and the caller needs a
      // typed incomplete result, not an exception mid-scan.
      return {
        ok: false,
        incomplete: chatOpsScanFetchFailure(
          `page ${page} threw: ${err instanceof Error ? err.message : String(err)}`,
        ),
      };
    }
    if (!result.ok) {
      return { ok: false, incomplete: chatOpsScanFetchFailure(`page ${page}: ${result.error}`) };
    }
    pages.push(result.page);
    if (!result.page.hasMore) return { ok: true, pages };
  }
  // The last page still reported `hasMore`; hand the pages to the core, which
  // reports `pages-truncated` (retryable) rather than inventing a second verdict.
  return { ok: true, pages };
}

/** Convenience for adapters: derive `hasMore` from a short final page (§6). */
export function chatOpsPageFromComments(
  comments: readonly ChatOpsObservedComment[],
  perPage: number,
): ChatOpsScanPage {
  return { comments, hasMore: comments.length >= perPage };
}
