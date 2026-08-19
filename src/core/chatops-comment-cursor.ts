/**
 * Durable ChatOps comment cursor and complete scan window (issue #781).
 *
 * This module is the *discovery* layer: given the pages a provider returned
 * for one issue's comment list, decide whether they prove a complete scan
 * window, in what total order the comments sit, which of them are new
 * candidates, and how far a durable cursor may advance. It never fetches
 * anything, never persists anything, and never decides whether a candidate
 * may execute — see `docs/chatops-comment-cursor-contract.md` for the full
 * contract, including what is deliberately *not* here (claim/dispatch/ack,
 * database restore, replay — tracked by issues #782-#785, #697, #915-#919,
 * #722).
 *
 * It builds directly on:
 * - `src/core/chatops-identity.ts` (#780) for the scope a cursor row is
 *   keyed by — this module never re-derives identity.
 * - `src/core/chatops-command.ts` (#777) for the comment shape, the
 *   first-seen edit policy this module makes durable, and marker
 *   authentication.
 *
 * Every exported function is pure and total over its documented input shape:
 * no I/O, no clock, no randomness, no store access. A cursor decision is
 * therefore reproducible from the pages that produced it, which is what lets
 * a caller re-run a scan after a crash and get the same answer.
 */

import { createHash } from "crypto";
import {
  MAX_CHATOPS_COMMENT_BODY_CHARS,
  isAuthenticatedChatOpsMarker,
  looksLikeCommandAttempt,
  parseChatOpsMarkerBody,
} from "./chatops-command.js";
import type { ChatOpsCommentInput, ChatOpsMarkerOutcome } from "./chatops-command.js";

// ---------------------------------------------------------------------------
// Comment identity and total ordering (contract §3)
// ---------------------------------------------------------------------------

/**
 * The canonical shape of a provider comment identifier: a decimal digit
 * string with no leading zeros, as standardized by
 * `docs/chatops-command-grammar-contract.md` §7 for acknowledgement markers.
 * Both supported providers (GitHub, Gitea) issue decimal integer comment ids.
 */
export const CHATOPS_COMMENT_ID_RE = /^(0|[1-9][0-9]*)$/;

/**
 * A well-formed instant: ISO-8601 with an explicit timezone designator.
 *
 * A timestamp without a zone (`2026-01-01T00:00:00`) is deliberately rejected
 * rather than interpreted as local time — the same string would order
 * differently on two hosts, and ordering is the one thing this module must
 * get right.
 *
 * Shape only: the capture groups exist so the calendar fields can be range
 * checked separately (see {@link parseChatOpsTimestamp}), because a shape
 * match alone accepts dates that do not exist.
 */
const ISO_INSTANT_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/;

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function daysInMonth(year: number, month: number): number {
  if (month !== 2) return DAYS_IN_MONTH[month - 1];
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return leap ? 29 : 28;
}

/** One comment as read from a work-item provider, plus its provider identifier. */
export interface ChatOpsObservedComment extends ChatOpsCommentInput {
  /** Provider comment id, canonical decimal digit string ({@link CHATOPS_COMMENT_ID_RE}). */
  id: string;
}

/**
 * The total ordering key for one comment (contract §3): creation instant
 * first, comment id as the tie-break.
 *
 * The id tie-break is what makes the ordering total. Provider timestamps are
 * second-precision, so two comments sharing a timestamp are routine; ordering
 * on the timestamp alone would leave their relative position undefined and a
 * timestamp-only cursor would then have no way to say "I processed one of
 * these but not the other" without skipping the other.
 */
export interface ChatOpsCommentOrderKey {
  /** Creation instant in epoch milliseconds. */
  createdAtMs: number;
  /** Provider comment id, compared numerically (contract §3). */
  commentId: string;
}

function assertCommentId(id: string): void {
  if (typeof id !== "string" || !CHATOPS_COMMENT_ID_RE.test(id)) {
    throw new Error(
      `ChatOps comment id must be a canonical decimal string with no leading zeros, got ${JSON.stringify(id)}`,
    );
  }
}

/**
 * Parse a provider timestamp into epoch milliseconds.
 *
 * The calendar fields are range checked before the value is accepted. Shape
 * and parseability are not enough: `Date.parse` silently *normalizes* an
 * impossible date, so `2026-02-30T00:00:00Z` would otherwise be accepted as
 * March 2 and become a durable cursor position derived from a value the
 * provider never meant. The contract says a malformed timestamp fails closed,
 * so an out-of-range field is rejected rather than rolled over.
 *
 * @throws Error if the value is not an ISO-8601 instant with an explicit
 * timezone designator, names a date or time that does not exist, or does not
 * parse to a finite time.
 */
export function parseChatOpsTimestamp(value: string, field = "timestamp"): number {
  const match = typeof value === "string" ? ISO_INSTANT_RE.exec(value) : null;
  if (!match) {
    throw new Error(
      `ChatOps ${field} must be an ISO-8601 instant with an explicit timezone, got ${JSON.stringify(value)}`,
    );
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  // Undefined for the `Z` spelling, which carries no offset fields to check.
  const offsetHour: string | undefined = match[7];
  const offsetMinute: string | undefined = match[8];
  const inRange =
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth(year, month) &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    (!offsetHour || (Number(offsetHour) <= 23 && Number(offsetMinute) <= 59));
  if (!inRange) {
    throw new Error(
      `ChatOps ${field} names a calendar date or time that does not exist: ${JSON.stringify(value)}`,
    );
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new Error(`ChatOps ${field} is not a valid instant: ${JSON.stringify(value)}`);
  }
  return ms;
}

/**
 * Compare two canonical comment ids **numerically**, without going through
 * `Number` (contract §3).
 *
 * For decimal strings with no leading zeros, "shorter is smaller, equal
 * length compares lexically" is exactly numeric order, and unlike
 * `Number(id)` it stays exact past `Number.MAX_SAFE_INTEGER` — a plain
 * lexical compare would put `"9"` after `"10"`, and a float compare would
 * eventually collapse two distinct ids onto one value.
 *
 * @throws Error if either id is not canonical.
 */
export function compareChatOpsCommentIds(a: string, b: string): number {
  assertCommentId(a);
  assertCommentId(b);
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Derive the total ordering key for one comment (contract §3).
 *
 * @throws Error if the id or `createdAt` is malformed — a comment whose place
 * in the ordering cannot be established is never silently ordered somewhere.
 */
export function deriveChatOpsCommentOrderKey(comment: {
  id: string;
  createdAt: string;
}): ChatOpsCommentOrderKey {
  assertCommentId(comment.id);
  return {
    createdAtMs: parseChatOpsTimestamp(comment.createdAt, "createdAt"),
    commentId: comment.id,
  };
}

/** Total order over {@link ChatOpsCommentOrderKey}: instant, then id (contract §3). */
export function compareChatOpsCommentOrderKeys(
  a: ChatOpsCommentOrderKey,
  b: ChatOpsCommentOrderKey,
): number {
  if (a.createdAtMs !== b.createdAtMs) return a.createdAtMs < b.createdAtMs ? -1 : 1;
  return compareChatOpsCommentIds(a.commentId, b.commentId);
}

// ---------------------------------------------------------------------------
// The cursor (contract §4)
// ---------------------------------------------------------------------------

/**
 * The durable high-water mark for one cursor scope — one
 * `(ChatOpsProviderIdentity, issueNumber)` pair, keyed exactly as
 * `docs/chatops-identity-contract.md` §6 defines (this module never
 * re-derives that key).
 *
 * Semantics are **exclusive**: every comment whose order key is `<=` this
 * mark has been observed and durably recorded (§9); everything above it has
 * not. `createdAt` is retained verbatim alongside the parsed instant because
 * the provider's own `since` filter takes a timestamp string, not a key
 * (§6).
 */
export interface ChatOpsCommentCursor {
  /** Creation instant of the last comment in the last complete window, epoch ms. */
  createdAtMs: number;
  /** That comment's `createdAt`, verbatim as the provider reported it. */
  createdAt: string;
  /** That comment's id — the tie-break half of the mark. */
  commentId: string;
}

/**
 * The durable cursor row for one scope: whether the scope has been
 * bootstrapped at all, and where it sits (contract §4.1).
 *
 * The two halves are independent because a position alone cannot express
 * "bootstrapped over an issue that had no comments". Persisting only a `null`
 * position for that case would make the next scan indistinguishable from a
 * first-ever scan, and a command posted in between would be recorded as
 * pre-existing and skipped forever (§8).
 */
export interface ChatOpsCursorState {
  /**
   * True once a complete window has been recorded for this scope — including
   * an empty bootstrap window. This is the initialization sentinel; a scan
   * with `initialized: true` never bootstraps again.
   */
  initialized: boolean;
  /** The high-water mark, or `null` when no comment has ever been recorded. */
  cursor: ChatOpsCommentCursor | null;
}

/** The state of a scope that has never completed a scan (contract §4.1, §8). */
export const CHATOPS_UNINITIALIZED_CURSOR_STATE: ChatOpsCursorState = Object.freeze({
  initialized: false,
  cursor: null,
});

/** The ordering key a cursor sits at. */
export function chatOpsCursorOrderKey(cursor: ChatOpsCommentCursor): ChatOpsCommentOrderKey {
  return { createdAtMs: cursor.createdAtMs, commentId: cursor.commentId };
}

/** Build a cursor positioned exactly at `comment` (contract §4). */
export function chatOpsCursorFromComment(comment: ChatOpsObservedComment): ChatOpsCommentCursor {
  const key = deriveChatOpsCommentOrderKey(comment);
  return { createdAtMs: key.createdAtMs, createdAt: comment.createdAt, commentId: comment.id };
}

/**
 * How far below the cursor's instant the provider's `since` filter is asked
 * to start (contract §6).
 *
 * One second, because the lower bound must be *inclusive of the cursor's own
 * timestamp* and neither supported provider guarantees that:
 * GitHub documents `since` as "last updated **after** the given time" and
 * truncates comment timestamps to whole seconds, so asking for exactly the
 * cursor's instant can legitimately exclude a sibling comment created in the
 * same second. Over-fetching costs one page at worst — every comment at or
 * below the cursor is dropped by the order-key comparison in
 * {@link evaluateChatOpsScanWindow} anyway — whereas under-fetching would
 * permanently skip a command at a timestamp boundary.
 */
export const CHATOPS_SCAN_SINCE_MARGIN_MS = 1000;

/**
 * The `since` value a scan must send for this cursor, or `null` when there is
 * no position yet — the comment list is then read from its beginning, whether
 * that is a bootstrap or a scope whose bootstrap window was empty (§4.1, §8).
 *
 * Returned second-precision and UTC-normalized, since that is the shape both
 * providers accept.
 *
 * @throws Error if `marginMs` is not a non-negative finite integer.
 */
export function chatOpsScanSinceBound(
  cursor: ChatOpsCommentCursor | null,
  marginMs: number = CHATOPS_SCAN_SINCE_MARGIN_MS,
): string | null {
  if (!Number.isInteger(marginMs) || marginMs < 0) {
    throw new Error(`ChatOps scan since-margin must be a non-negative integer, got ${marginMs}`);
  }
  if (!cursor) return null;
  const floored = Math.floor((cursor.createdAtMs - marginMs) / 1000) * 1000;
  return new Date(Math.max(0, floored)).toISOString().replace(/\.\d{3}Z$/, "Z");
}

// ---------------------------------------------------------------------------
// The complete scan window (contract §5, §7, §11)
// ---------------------------------------------------------------------------

/** One page of comments exactly as a provider returned it (contract §6). */
export interface ChatOpsScanPage {
  /** The page's comments, in the provider's ascending order. */
  comments: readonly ChatOpsObservedComment[];
  /** Whether the provider signalled that further pages exist beyond this one. */
  hasMore: boolean;
}

/**
 * Upper bound on pages one scan may consume (contract §5).
 *
 * This is a runaway guard, not a budget the scan is expected to hit:
 * exceeding it fails the window closed (nothing advances) rather than
 * advancing the cursor over a prefix, because a prefix cannot prove the
 * completeness a dispatch decision needs (§5).
 */
export const CHATOPS_MAX_SCAN_PAGES = 200;

/** Why a set of pages failed to prove a complete scan window (contract §11). */
export type ChatOpsScanIncompleteReason =
  /** A page could not be fetched at all (caller-reported). */
  | "page-fetch-failed"
  /** No pages were supplied; a scan always reads at least one page. */
  | "no-pages"
  /** The last supplied page still reported `hasMore` — the list end was never reached. */
  | "pages-truncated"
  /** More pages followed one that reported `hasMore: false`. */
  | "trailing-page-after-end"
  /** More pages than {@link CHATOPS_MAX_SCAN_PAGES} were supplied. */
  | "page-budget-exhausted"
  /** A comment id was not a canonical decimal string. */
  | "malformed-comment-id"
  /** A `createdAt`/`updatedAt` was not a well-formed instant. */
  | "malformed-timestamp"
  /** A page's own comments were not strictly ascending. */
  | "page-out-of-order"
  /** A previously unseen comment appeared behind the scan frontier. */
  | "unstable-ordering"
  /** The same comment id was returned twice with a different id-level field. */
  | "identity-conflict";

/** A set of pages that does not prove a complete window; nothing may advance (contract §11). */
export interface ChatOpsScanWindowIncomplete {
  kind: "incomplete";
  reason: ChatOpsScanIncompleteReason;
  detail: string;
  /**
   * Whether re-running the same scan could plausibly succeed without an
   * operator or code change. `false` means a human has to look — retrying a
   * provider that reports contradictory data just burns quota (§11).
   */
  retryable: boolean;
}

/** A set of pages that proves a complete window (contract §5). */
export interface ChatOpsScanWindowComplete {
  kind: "complete";
  /**
   * True when this window bootstrapped the scope — scanned with no prior
   * cursor *and* no prior initialization sentinel (contract §4.1, §8).
   */
  bootstrap: boolean;
  /**
   * Every comment strictly above the prior cursor, in ascending order, with
   * overlap duplicates removed (first occurrence wins, §7).
   */
  comments: readonly ChatOpsObservedComment[];
  /**
   * Where the cursor may advance to: the last comment of `comments`, or the
   * prior cursor unchanged when the window added nothing. `null` only when no
   * comment has ever been observed for the scope.
   */
  nextCursor: ChatOpsCommentCursor | null;
  /**
   * The whole durable row to persist for this window (§4.1): `nextCursor`
   * plus `initialized: true`, which stays true even when `nextCursor` is
   * `null`. Persisting this rather than the position alone is what stops an
   * empty bootstrap from being re-bootstrapped over a command posted since
   * (§8).
   */
  nextState: ChatOpsCursorState;
  /** Pages consumed, for observability. */
  pagesRead: number;
  /** Comments dropped because they sat at or below the prior cursor (§7). */
  droppedAtOrBelowCursor: number;
  /** Comments dropped as overlap duplicates of an id already seen this window (§7). */
  droppedDuplicates: number;
}

export type ChatOpsScanWindow = ChatOpsScanWindowComplete | ChatOpsScanWindowIncomplete;

/** Input to {@link evaluateChatOpsScanWindow}. */
export interface ChatOpsScanWindowInput {
  /** The durable cursor this scan resumed from, or `null` when there is none. */
  cursor: ChatOpsCommentCursor | null;
  /**
   * Whether the scope has already been bootstrapped (§4.1, §8). Defaults to
   * `cursor !== null`, so a caller holding only a position keeps the obvious
   * meaning; pass `true` with a `null` cursor for a scope whose bootstrap
   * window was empty — every comment it finds is then genuinely new rather
   * than pre-existing backlog.
   */
  initialized?: boolean;
  /** Pages in the order the provider returned them. */
  pages: readonly ChatOpsScanPage[];
  /** Override for {@link CHATOPS_MAX_SCAN_PAGES}. */
  maxPages?: number;
}

/** Read the §4.1 state a scan input describes, applying the default. */
function scanInputState(input: ChatOpsScanWindowInput): ChatOpsCursorState {
  const initialized = input.initialized ?? (input.cursor !== null);
  if (!initialized && input.cursor !== null) {
    throw new Error(
      "ChatOps scan input has a cursor position but is marked uninitialized; a position implies a completed window",
    );
  }
  return { initialized, cursor: input.cursor };
}

function incomplete(
  reason: ChatOpsScanIncompleteReason,
  detail: string,
  retryable: boolean,
): ChatOpsScanWindowIncomplete {
  return { kind: "incomplete", reason, detail, retryable };
}

/**
 * Report a page the caller could not fetch, in the same shape a structural
 * failure produces, so every "this scan did not complete" path is handled
 * identically by the caller (contract §11).
 */
export function chatOpsScanFetchFailure(detail: string): ChatOpsScanWindowIncomplete {
  return incomplete("page-fetch-failed", detail, true);
}

/**
 * Decide whether `pages` prove a complete scan window and, if so, what is new
 * in it and how far the cursor may advance (contract §5, §7).
 *
 * Fail-closed by construction: every non-`complete` return advances nothing.
 * A caller must never persist a cursor, a first-seen record, or a candidate
 * from an `incomplete` result.
 */
export function evaluateChatOpsScanWindow(input: ChatOpsScanWindowInput): ChatOpsScanWindow {
  const state = scanInputState(input);
  const maxPages = input.maxPages ?? CHATOPS_MAX_SCAN_PAGES;
  if (!Number.isInteger(maxPages) || maxPages < 1) {
    throw new Error(`ChatOps scan maxPages must be a positive integer, got ${maxPages}`);
  }

  const pages = input.pages;
  if (pages.length === 0) {
    return incomplete("no-pages", "a scan must read at least one page", false);
  }
  if (pages.length > maxPages) {
    return incomplete(
      "page-budget-exhausted",
      `scan read ${pages.length} pages, over the ${maxPages}-page guard`,
      false,
    );
  }
  for (let i = 0; i < pages.length - 1; i += 1) {
    if (!pages[i].hasMore) {
      return incomplete(
        "trailing-page-after-end",
        `page ${i + 1} reported no further pages but ${pages.length} pages were supplied`,
        false,
      );
    }
  }
  if (pages[pages.length - 1].hasMore) {
    return incomplete(
      "pages-truncated",
      `page ${pages.length} still reports further pages; the comment list end was never reached`,
      true,
    );
  }

  const cursorKey = state.cursor ? chatOpsCursorOrderKey(state.cursor) : null;
  const seen = new Map<string, ChatOpsObservedComment>();
  const fresh: ChatOpsObservedComment[] = [];
  let frontier: ChatOpsCommentOrderKey | null = null;
  let droppedAtOrBelowCursor = 0;
  let droppedDuplicates = 0;

  for (let p = 0; p < pages.length; p += 1) {
    let pagePrev: ChatOpsCommentOrderKey | null = null;
    for (const comment of pages[p].comments) {
      if (typeof comment.id !== "string" || !CHATOPS_COMMENT_ID_RE.test(comment.id)) {
        return incomplete(
          "malformed-comment-id",
          `page ${p + 1}: comment id ${JSON.stringify(comment.id)} is not a canonical decimal string`,
          false,
        );
      }
      let key: ChatOpsCommentOrderKey;
      try {
        key = deriveChatOpsCommentOrderKey(comment);
        // `updatedAt` never orders anything, but it is half of #777's
        // first-seen edit decision, so an unusable value must fail the window
        // rather than be recorded as a first-seen field nothing can compare.
        parseChatOpsTimestamp(comment.updatedAt, "updatedAt");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return incomplete(
          "malformed-timestamp",
          `page ${p + 1}, comment ${comment.id}: ${message}`,
          false,
        );
      }

      if (pagePrev && compareChatOpsCommentOrderKeys(key, pagePrev) <= 0) {
        return incomplete(
          "page-out-of-order",
          `page ${p + 1}: comment ${comment.id} is not strictly after the comment before it on the same page`,
          false,
        );
      }
      pagePrev = key;

      const prior = seen.get(comment.id);
      if (prior) {
        // Overlapping pages are expected (§7). Content may legitimately differ
        // between two reads of the same comment — that is an edit landing
        // mid-scan, and #777 §6 resolves it by keeping the first-seen copy.
        // The *ordering* half of the comment may not differ: if it did, the
        // key that positioned the window would itself be unstable.
        if (prior.createdAt !== comment.createdAt) {
          return incomplete(
            "identity-conflict",
            `comment ${comment.id} was returned with two different createdAt values ` +
              `(${prior.createdAt} then ${comment.createdAt})`,
            false,
          );
        }
        droppedDuplicates += 1;
        continue;
      }

      if (frontier && compareChatOpsCommentOrderKeys(key, frontier) <= 0) {
        return incomplete(
          "unstable-ordering",
          `page ${p + 1}: previously unseen comment ${comment.id} sorts at or behind the scan frontier; ` +
            `the provider's ordering is not stable, so no gap-free window can be proven`,
          true,
        );
      }

      seen.set(comment.id, comment);
      frontier = key;

      if (cursorKey && compareChatOpsCommentOrderKeys(key, cursorKey) <= 0) {
        droppedAtOrBelowCursor += 1;
        continue;
      }
      fresh.push(comment);
    }
  }

  const nextCursor =
    fresh.length > 0 ? chatOpsCursorFromComment(fresh[fresh.length - 1]) : state.cursor;

  return {
    kind: "complete",
    bootstrap: !state.initialized,
    comments: fresh,
    nextCursor,
    nextState: { initialized: true, cursor: nextCursor },
    pagesRead: pages.length,
    droppedAtOrBelowCursor,
    droppedDuplicates,
  };
}

// ---------------------------------------------------------------------------
// Candidate selection at the scan boundary (contract §10)
// ---------------------------------------------------------------------------

/** Result of {@link selectChatOpsCandidates}. */
export interface ChatOpsCandidateSelection {
  /**
   * Comments this session has never recorded a first-seen row for, ascending.
   *
   * "Candidate" means *newly discovered*, not *not yet executed*: whether a
   * candidate may run is the execution ledger's question, not this layer's
   * (contract §10, §16).
   */
  candidates: readonly ChatOpsObservedComment[];
  /** Ids dropped because a first-seen record already exists for them. */
  alreadyObserved: readonly string[];
}

/**
 * Split a complete window's comments into newly discovered candidates and
 * ones already recorded (contract §10).
 *
 * `hasFirstSeen` is injected rather than read from a store so this stays
 * pure; a caller backs it with the first-seen table (§9).
 */
export function selectChatOpsCandidates(
  window: ChatOpsScanWindowComplete,
  hasFirstSeen: (commentId: string) => boolean,
): ChatOpsCandidateSelection {
  const candidates: ChatOpsObservedComment[] = [];
  const alreadyObserved: string[] = [];
  for (const comment of window.comments) {
    if (hasFirstSeen(comment.id)) alreadyObserved.push(comment.id);
    else candidates.push(comment);
  }
  return { candidates, alreadyObserved };
}

// ---------------------------------------------------------------------------
// First-seen records (contract §9)
// ---------------------------------------------------------------------------

/**
 * The durable first-seen record for one comment — the immutable input
 * `docs/chatops-command-grammar-contract.md` §6 requires recognition to be a
 * function of, made to survive a restart.
 *
 * Written once, never updated (§9). A later observation of the same comment
 * with different content is an edit, which §6 says to ignore, not apply.
 */
export interface ChatOpsFirstSeenRecord {
  commentId: string;
  /** Author login exactly as first reported. */
  author: string;
  /** Creation timestamp verbatim — also the ordering half of the cursor. */
  createdAt: string;
  /** Last-update timestamp verbatim. `updatedAt !== createdAt` here is #777's `ambiguous-edit`. */
  updatedAt: string;
  /**
   * The body verbatim, or `null` when it exceeded
   * {@link MAX_CHATOPS_COMMENT_BODY_CHARS} — such a body is `malformed` by
   * grammar §10 regardless of content, so storing it would grow the row
   * without changing any decision it can ever feed.
   */
  body: string | null;
  /** Length of the original body in characters, retained even when `body` is `null`. */
  bodyLength: number;
  /** sha256 of the original body — lets an over-long or edited body still be compared. */
  bodySha256: string;
  /** True when the comment already existed at bootstrap and is therefore never dispatched (§8). */
  bootstrap: boolean;
}

/**
 * Build the durable first-seen record for one comment (contract §9).
 *
 * @throws Error if the comment's id or timestamps are malformed — the same
 * validation {@link evaluateChatOpsScanWindow} applies, repeated here because
 * a record may be built from a hand-constructed comment.
 */
export function buildChatOpsFirstSeenRecord(
  comment: ChatOpsObservedComment,
  options: { bootstrap: boolean },
): ChatOpsFirstSeenRecord {
  assertCommentId(comment.id);
  parseChatOpsTimestamp(comment.createdAt, "createdAt");
  parseChatOpsTimestamp(comment.updatedAt, "updatedAt");
  const body = comment.body;
  return {
    commentId: comment.id,
    author: comment.author,
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
    body: body.length > MAX_CHATOPS_COMMENT_BODY_CHARS ? null : body,
    bodyLength: body.length,
    bodySha256: createHash("sha256").update(body, "utf8").digest("hex"),
    bootstrap: options.bootstrap,
  };
}

/** What a re-observation of an already-recorded comment means (contract §9). */
export type ChatOpsFirstSeenReconciliation =
  /** Byte-identical to what was recorded. */
  | { kind: "unchanged" }
  /** The body or `updatedAt` moved: an edit after first observation. Ignored by #777 §6. */
  | { kind: "edited-after-first-seen"; detail: string }
  /** An id-level field moved. The record and the observation cannot be the same comment. */
  | { kind: "identity-conflict"; detail: string };

/**
 * Compare a stored first-seen record against a fresh observation of the same
 * comment id (contract §9).
 *
 * The split matters: content drift is the *expected* case an edit produces
 * and must never fail a scan, while `createdAt`/author drift means the
 * provider contradicted itself about what comment this id is — which
 * invalidates both the ordering key and the trust decision built on it.
 */
export function reconcileChatOpsFirstSeen(
  stored: ChatOpsFirstSeenRecord,
  observed: ChatOpsObservedComment,
): ChatOpsFirstSeenReconciliation {
  if (stored.commentId !== observed.id) {
    throw new Error(
      `ChatOps first-seen reconciliation compared different comments (${stored.commentId} vs ${observed.id})`,
    );
  }
  if (stored.createdAt !== observed.createdAt) {
    return {
      kind: "identity-conflict",
      detail: `createdAt changed from ${stored.createdAt} to ${observed.createdAt}`,
    };
  }
  if (stored.author !== observed.author) {
    return {
      kind: "identity-conflict",
      detail: `author changed from ${stored.author} to ${observed.author}`,
    };
  }
  const observedSha = createHash("sha256").update(observed.body, "utf8").digest("hex");
  if (stored.updatedAt !== observed.updatedAt) {
    return {
      kind: "edited-after-first-seen",
      detail: `updatedAt changed from ${stored.updatedAt} to ${observed.updatedAt}`,
    };
  }
  if (stored.bodySha256 !== observedSha) {
    return {
      kind: "edited-after-first-seen",
      detail: "body changed while updatedAt did not",
    };
  }
  return { kind: "unchanged" };
}

// ---------------------------------------------------------------------------
// Bootstrap (contract §8)
// ---------------------------------------------------------------------------

/** One comment a bootstrap scan recorded but will never dispatch (contract §8). */
export interface ChatOpsBootstrapSkippedCommand {
  commentId: string;
  author: string;
  createdAt: string;
}

/** The outcome of bootstrapping a cursor scope (contract §8). */
export interface ChatOpsBootstrapPlan {
  /** Where the cursor starts, or `null` when the issue has no comments yet. */
  cursor: ChatOpsCommentCursor | null;
  /**
   * The durable row this plan produces (§4.1). `initialized` is `true` even
   * when `cursor` is `null`, and persisting it is mandatory: without the
   * sentinel the next scan would bootstrap again and record a command posted
   * in the meantime as pre-existing backlog, skipping it permanently.
   */
  state: ChatOpsCursorState;
  /** First-seen records for every comment in the bootstrap window, all flagged `bootstrap`. */
  records: readonly ChatOpsFirstSeenRecord[];
  /**
   * Pre-existing comments that look like command attempts and are
   * deliberately not dispatched. Reporting this list is what makes bootstrap
   * skipping *explicit* rather than silent (§8) — a caller must surface it.
   */
  skippedCommandAttempts: readonly ChatOpsBootstrapSkippedCommand[];
}

/**
 * Plan the bootstrap of a cursor scope from its first complete window
 * (contract §8).
 *
 * Every pre-existing comment is recorded as first-seen and none is
 * dispatched: replaying commands that predate the surface being enabled
 * would execute instructions nobody re-issued, and their acknowledgement
 * markers (if any) belong to a history this session never observed. The
 * skipped attempts are returned rather than dropped so "we chose not to run
 * these" is visible.
 *
 * An issue with no comments still bootstraps: the plan's `state` carries
 * `initialized: true` with a `null` position, so the scope is marked as
 * having been scanned. Persisting only the position would leave the next scan
 * looking like a first-ever one, and the first `/grant` posted in between
 * would be recorded as pre-existing backlog and never dispatched — the exact
 * permanent skip §8 exists to prevent.
 *
 * @throws Error if called with a non-bootstrap window — advancing an existing
 * cursor is {@link evaluateChatOpsScanWindow}'s job, not this function's.
 */
export function planChatOpsBootstrap(window: ChatOpsScanWindowComplete): ChatOpsBootstrapPlan {
  if (!window.bootstrap) {
    throw new Error(
      "ChatOps bootstrap plan requires a window scanned with no prior cursor and no prior initialization",
    );
  }
  const records = window.comments.map((comment) =>
    buildChatOpsFirstSeenRecord(comment, { bootstrap: true }),
  );
  const skippedCommandAttempts = window.comments
    .filter((comment) => looksLikeCommandAttempt(comment.body))
    .map((comment) => ({
      commentId: comment.id,
      author: comment.author,
      createdAt: comment.createdAt,
    }));
  return {
    cursor: window.nextCursor,
    state: window.nextState,
    records,
    skippedCommandAttempts,
  };
}

// ---------------------------------------------------------------------------
// Marker discovery across page boundaries (contract §5.1)
// ---------------------------------------------------------------------------

/**
 * Which comments in a window carry an *authenticated* acknowledgement marker
 * (`docs/chatops-command-grammar-contract.md` §7), and what each marker
 * targets.
 *
 * This is discovery only — it says a marker exists, never what to do about
 * it. Suppression/replay decisions are the execution ledger's (§16).
 */
export interface ChatOpsWindowMarkerIndex {
  /** Comment ids an authenticated `chatops-claimed` marker refers to. */
  claimed: ReadonlySet<string>;
  /** Comment ids an authenticated `chatops-ack` marker refers to, with its outcome. */
  acked: ReadonlyMap<string, ChatOpsMarkerOutcome>;
  /** Ids of the marker comments themselves, so a caller can exclude them from candidates. */
  markerCommentIds: ReadonlySet<string>;
}

/**
 * Index the authenticated markers in a set of comments (contract §5.1).
 *
 * Because a complete window always runs to the end of the comment list (§5),
 * a marker posted before the scan started is always in the same window as the
 * command it refers to — even when the command is the last comment on one
 * page and the marker is the first on the next. That is precisely why a
 * partial window may never be dispatched from.
 *
 * A look-alike marker from a non-automation author is not indexed: §7 of the
 * grammar contract makes author membership half of what authenticates a
 * marker, so an untrusted comment can never suppress a trusted command.
 */
export function indexAuthenticatedChatOpsMarkers(
  comments: readonly ChatOpsObservedComment[],
  automationLogins: readonly string[],
): ChatOpsWindowMarkerIndex {
  const claimed = new Set<string>();
  const acked = new Map<string, ChatOpsMarkerOutcome>();
  const markerCommentIds = new Set<string>();
  for (const comment of comments) {
    if (!isAuthenticatedChatOpsMarker(comment, automationLogins)) continue;
    const marker = parseChatOpsMarkerBody(comment.body);
    if (!marker) continue;
    markerCommentIds.add(comment.id);
    if (marker.kind === "claimed") claimed.add(marker.commentId);
    else acked.set(marker.commentId, marker.outcome);
  }
  return { claimed, acked, markerCommentIds };
}
