/**
 * Gitea binding of the ChatOps comment port (issue #1032).
 *
 * The sibling of `src/providers/github/gh-chatops-comment-port.ts`, satisfying
 * the same `docs/chatops-comment-cursor-contract.md` §6 capability surface over
 * Gitea's REST API instead of the `gh` CLI. Nothing above this file learns that
 * a session is on Gitea: the pass, the cursor, the ledger and the result
 * publication all keep deciding from `ChatOpsScanPage`s and
 * `ChatOpsPostResult`s.
 *
 * The two adapters differ in exactly one contract-visible way — where the
 * end-of-list signal comes from — and that difference is forced by Gitea:
 *
 * - **Ascending order by creation.** Gitea's `ListIssueComments` orders by
 *   `created_unix` ascending, so a concurrent post can only appear at the *end*
 *   of the list and is picked up by this scan or the next, never skipped. This
 *   is the same pinned provider assumption §6.1 records for GitHub; a change in
 *   it is a documented contract violation rather than a silent skip. The core
 *   still verifies it per page (`page-out-of-order`) and across pages
 *   (`unstable-ordering`), so a Gitea that violated it would fail the window
 *   closed rather than advance a cursor over a gap.
 * - **End-of-list is proven by an EMPTY page, never a short one.** A
 *   self-hosted Gitea clamps `limit` to its own configured max page size, so a
 *   *full* page routinely comes back shorter than requested. Deriving `hasMore`
 *   from a short page — what `chatOpsPageFromComments` does, and what is
 *   correct for GitHub — would declare the window complete at the first clamped
 *   page, and every comment past it would fall below the advanced cursor
 *   without ever being seen: precisely the skip `docs/chatops-comment-cursor-contract.md`
 *   I1 forbids. Zero is the one length the server cannot have clamped, so it is
 *   the one that proves exhaustion. The cost is one extra request per scan;
 *   the alternative is an unprovable window. Every other Gitea listing in this
 *   codebase (`listCandidateItems`, `resolveLabelId`, `getDependencies`,
 *   `hasItemCommentWithMarker`) terminates the same way, for the same reason.
 * - **Verbatim timestamps in one spelling.** `created_at` and `updated_at` are
 *   passed through untouched. Normalizing one and not the other would make an
 *   unedited comment look edited and get it refused as `ambiguous-edit`.
 *
 * The `since` filter is an optimization only (§6.1): Gitea filters on
 * `updated_unix`, and the core's order-key comparison — not the filter — is what
 * drops already-seen comments. An instance that ignored it entirely would be
 * equally correct, just slower. It is sent as the RFC 3339 string
 * `chatOpsScanSinceBound` produces, not as epoch seconds — see `listComments`.
 *
 * Two properties of the transport itself are part of keeping the pass bounded
 * and its identities stable, and are argued where they are implemented:
 * requests carry a wall-clock bound ({@link DEFAULT_REQUEST_TIMEOUT_MS}) so an
 * unresponsive instance cannot hang a scheduled scan, and the response is
 * decoded without a floating-point round trip
 * ({@link parseJsonPreservingLargeIntegers}) so an int64 comment id past 2^53
 * survives exactly.
 *
 * Authentication is the session's configured Gitea `api-token`, carried in the
 * `Authorization` header the shared transport builds. There is no ambient CLI
 * login to fall back to and none is attempted: markers must be posted under the
 * identity an operator can name in `automationLogins`, or they do not
 * authenticate as ChatOps evidence at all
 * (`docs/chatops-execution-ledger-contract.md` §10.3).
 *
 * SECURITY: comment bodies and author logins are untrusted input — this adapter
 * only transports them. Error strings are built from status lines and response
 * snippets that are redacted before they are bounded (see `#redactedSnippet` —
 * the order matters), so the API token can never reach a pass note, an audit
 * record, or a published comment.
 */

import type {
  ChatOpsCommentPageRequest,
  ChatOpsCommentPageResult,
  ChatOpsCommentPort,
  ChatOpsPostResult,
} from "../../core/chatops-comment-port.js";
import type { ChatOpsObservedComment } from "../../core/chatops-comment-cursor.js";
import {
  buildGiteaApiUrl,
  createGiteaHttp,
  redactGiteaSecrets,
  type GiteaHttpRequest,
  type GiteaHttpResponse,
} from "./gitea-client.js";

/** How much of a Gitea response is echoed into an error string. */
const ERROR_DETAIL_CHARS = 200;

/**
 * Wall-clock bound on a single Gitea request made by this port.
 *
 * A ChatOps pass is a *bounded* pass: `chatops-scan` is invoked on a schedule
 * and every outcome — including every failure — has to be a reported pass
 * result the next invocation can retry from. The shared `defaultGiteaHttp`
 * transport is deliberately unbounded (`gitea-client.ts`), which is the right
 * default for the retry/backoff-driven runtime paths but is exactly wrong here:
 * a Gitea that accepts the connection and then never answers would block in
 * `spawnSync` forever, and the scan step would neither fail nor complete.
 *
 * So this port builds its own bounded transport. A timeout surfaces as a
 * transport-level throw, which `#send` already converts into the synthetic
 * status-0 envelope — i.e. an ordinary reported failure that advances no
 * cursor and is retried on the next pass. The bound is per request, not per
 * pass; a slow-but-alive instance still walks its pages.
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** Shape of a Gitea issue comment as returned by the REST API (fields we read). */
interface RawGiteaComment {
  id?: unknown;
  body?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
  user?: { login?: unknown } | null;
}

/**
 * Convert one raw API comment, or explain why it cannot be converted.
 *
 * A missing author or timestamp is reported rather than defaulted, exactly as
 * the GitHub adapter does: the author is the entire trust gate (#777 §5) and the
 * timestamps are the ordering key plus the edit test, so a comment missing any
 * of them cannot be placed in the window at all. Failing the page keeps the
 * window unproven, which is what `evaluateChatOpsScanWindow` needs in order to
 * advance nothing.
 */
function toObservedComment(raw: RawGiteaComment, index: number): ChatOpsObservedComment | string {
  const id = raw.id;
  if (typeof id !== "number" && typeof id !== "string") {
    return `comment ${index} carries no usable id`;
  }
  const author = raw.user?.login;
  if (typeof author !== "string" || author === "") {
    return `comment ${String(id)} carries no author login`;
  }
  const createdAt = raw.created_at;
  const updatedAt = raw.updated_at;
  if (typeof createdAt !== "string" || typeof updatedAt !== "string") {
    return `comment ${String(id)} carries no created_at/updated_at pair`;
  }
  return {
    id: typeof id === "number" ? String(id) : id,
    author,
    body: typeof raw.body === "string" ? raw.body : "",
    createdAt,
    updatedAt,
  };
}

export interface GiteaChatOpsCommentPortOptions {
  /** Base URL of the Gitea instance, e.g. `https://gitea.example.com`. */
  baseUrl: string;
  /** Owning organization or user of the work-item container. */
  owner: string;
  /** Repository name within `owner`. */
  repo: string;
  /** API token resolved at runtime by indirection (never persisted). */
  token: string;
  /** Optional API base path. Defaults to `/api/v1`. */
  apiPath?: string;
  /**
   * Wall-clock bound on a single request, in milliseconds. A missing or
   * non-positive value falls back to {@link DEFAULT_REQUEST_TIMEOUT_MS}: there
   * is no way to ask this port for an unbounded transport, because a scheduled
   * pass has no way to recover from one. Ignored when `http` is supplied — an
   * injected transport owns its own bound.
   */
  timeoutMs?: number;
  /**
   * Injectable HTTP transport. Defaults to a *bounded* Node-subprocess
   * transport (see {@link DEFAULT_REQUEST_TIMEOUT_MS}), never the shared
   * unbounded `defaultGiteaHttp`.
   */
  http?: GiteaHttpRequest;
}

export class GiteaChatOpsCommentPort implements ChatOpsCommentPort {
  readonly #baseUrl: string;
  readonly #owner: string;
  readonly #repo: string;
  readonly #token: string;
  readonly #apiPath: string | undefined;
  readonly #http: GiteaHttpRequest;

  constructor(options: GiteaChatOpsCommentPortOptions) {
    this.#baseUrl = options.baseUrl;
    this.#owner = options.owner;
    this.#repo = options.repo;
    this.#token = options.token;
    this.#apiPath = options.apiPath;
    this.#http =
      options.http ??
      createGiteaHttp({
        timeoutMs:
          options.timeoutMs !== undefined && options.timeoutMs > 0
            ? options.timeoutMs
            : DEFAULT_REQUEST_TIMEOUT_MS,
      });
  }

  async listComments(request: ChatOpsCommentPageRequest): Promise<ChatOpsCommentPageResult> {
    const query: Record<string, string> = {
      page: String(request.page),
      limit: String(request.perPage),
    };
    // Gitea's `since` filters on `updated_unix`, like GitHub's, but it is sent
    // as an RFC 3339 *string*, not as integer seconds. `ListIssueComments`
    // declares it `type: string, format: date-time`, and the handler parses it
    // with `time.Parse(time.RFC3339, ...)` (`GetQueryBeforeSince` →
    // `parseTime`), converting to `updated_unix` server-side; the official Go
    // SDK likewise sends `opt.Since.Format(time.RFC3339)`. Sending the epoch
    // seconds that name suggests would fail that parse and take the whole page
    // request to 422 — turning an optimization into a permanent
    // `page-fetch-failed`. `chatOpsScanSinceBound` already returns exactly the
    // second-precision UTC spelling both providers accept, so it is forwarded
    // verbatim.
    //
    // It stays an optimization only (§6.1): it shrinks the page, while §6.1's
    // order-key comparison is what actually excludes already-seen comments, so
    // an instance that ignored the filter entirely would be equally correct.
    if (request.since !== null) query.since = request.since;

    const res = this.#send("GET", this.#repoPath(`/issues/${request.issueNumber}/comments`), {
      query,
    });
    if (!isSuccess(res)) {
      // Every non-2xx lands here — 401/403 (auth), 429 (rate limit), 5xx
      // (provider), and the synthetic status 0 the transport reports for a
      // connection failure. The port surface carries no failure taxonomy on
      // purpose: `fetchChatOpsScanPages` turns any of them into one
      // `page-fetch-failed` window, which advances nothing and is retried on the
      // next pass. The status is kept in the text so an operator reading the
      // pass note can tell a bad token from a busy instance.
      return {
        ok: false,
        error: this.#failure(`gitea list comments failed (page ${request.page})`, res),
      };
    }

    let raw: unknown;
    try {
      raw = parseJsonPreservingLargeIntegers(res.body);
    } catch {
      return {
        ok: false,
        error:
          `gitea list comments returned non-JSON output (page ${request.page}): ` +
          `${this.#redactedSnippet(res.body)}`,
      };
    }
    if (!Array.isArray(raw)) {
      return {
        ok: false,
        error: `gitea list comments returned a non-array payload (page ${request.page})`,
      };
    }

    const comments: ChatOpsObservedComment[] = [];
    for (let i = 0; i < raw.length; i += 1) {
      const converted = toObservedComment(raw[i] as RawGiteaComment, i);
      if (typeof converted === "string") {
        return { ok: false, error: redactGiteaSecrets(converted, [this.#token]) };
      }
      comments.push(converted);
    }
    // `hasMore` keys on a NON-EMPTY page, not a short one — see the header. A
    // clamped-but-full page must not be read as the end of the list, so the walk
    // costs one extra request and terminates on the empty page that follows.
    return { ok: true, page: { comments, hasMore: comments.length > 0 } };
  }

  async postComment(issueNumber: number, body: string): Promise<ChatOpsPostResult> {
    // Posted verbatim: a marker's trimmed body must stay exactly canonical
    // (`docs/chatops-result-contract.md` §5.1), so nothing is wrapped, prefixed,
    // or annotated here. Gitea has no native idempotency key for comments; the
    // ledger's acknowledgement reservation, not the provider, is what makes a
    // republished marker at-most-once.
    const res = this.#send("POST", this.#repoPath(`/issues/${issueNumber}/comments`), {
      body: { body },
    });
    if (!isSuccess(res)) {
      return { ok: false, error: this.#failure("gitea comment post failed", res) };
    }
    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // Low-level request helpers (mirroring GiteaWorkItemProvider)
  // -------------------------------------------------------------------------

  #repoPath(suffix: string): string {
    return `/repos/${encodeURIComponent(this.#owner)}/${encodeURIComponent(this.#repo)}${suffix}`;
  }

  #send(
    method: string,
    endpointPath: string,
    opts: { query?: Record<string, string>; body?: unknown } = {},
  ): GiteaHttpResponse {
    const hasBody = opts.body !== undefined;
    const headers: Record<string, string> = {
      // Gitea personal access tokens use the `token <value>` scheme.
      Authorization: `token ${this.#token}`,
      Accept: "application/json",
      "User-Agent": "n8n-ai-cli-loop",
      ...(hasBody ? { "Content-Type": "application/json" } : {}),
    };
    try {
      // Inside the guard with the request itself: `buildGiteaApiUrl` throws on a
      // base URL that will not parse, and this port's callers must see a
      // reported failure rather than an exception either way.
      const url = buildGiteaApiUrl(this.#baseUrl, this.#apiPath, endpointPath, opts.query);
      return this.#http({
        method,
        url,
        headers,
        ...(hasBody ? { body: JSON.stringify(opts.body) } : {}),
      });
    } catch (err) {
      // The transport throws only on a transport-level failure (DNS, connection
      // refused/reset, a bounded-probe timeout); a non-2xx HTTP response is a
      // normal return. Converting the throw into a synthetic status-0 envelope
      // keeps this port's promise to the pass: `listComments` and `postComment`
      // report failures, they never reject. That matters most for the claim
      // marker, where a *thrown* post would escape `dispatchRow` mid-attempt
      // instead of leaving the row `dispatching` for the next pass's
      // reconciliation to settle from provider evidence (§8).
      const message = redactGiteaSecrets(err instanceof Error ? err.message : String(err), [
        this.#token,
      ]);
      return { status: 0, statusText: `transport error: ${message}`, body: "" };
    }
  }

  /** A redacted, bounded one-line description of a failed response. */
  #failure(label: string, res: GiteaHttpResponse): string {
    const snippet = this.#redactedSnippet(res.body || res.statusText || "");
    return `${label} (HTTP ${res.status}): ${snippet}`;
  }

  /**
   * Bound provider-supplied text for an error string — redacting FIRST, then
   * truncating.
   *
   * The order is the whole point. {@link redactGiteaSecrets} matches complete
   * credentials (the configured token, a 40-char hex token, a `token`/`Bearer`
   * header value); truncating first can cut one of those in half, leaving a
   * prefix that no longer matches any pattern and therefore survives redaction
   * into a pass note or an audit record. A Gitea that echoes the request — a
   * proxy 400 quoting the `Authorization` header, say — is exactly the case
   * where the echoed token straddles {@link ERROR_DETAIL_CHARS}. Redacting the
   * complete body first collapses every credential to `[redacted]` before any
   * cut can land inside one, so the truncation that follows can only ever
   * shorten already-safe text.
   */
  #redactedSnippet(text: string): string {
    return redactGiteaSecrets(text, [this.#token]).slice(0, ERROR_DETAIL_CHARS);
  }
}

function isSuccess(res: GiteaHttpResponse): boolean {
  return res.status >= 200 && res.status < 300;
}

/**
 * `JSON.parse`, but integer literals too large for a double survive as strings.
 *
 * Gitea comment ids are int64. `JSON.parse` maps every number onto a double, so
 * an id past `Number.MAX_SAFE_INTEGER` is *rounded before this file ever sees
 * it*: `9007199254740993` arrives as `9007199254740992`. That id is the canonical
 * comment identity — the cursor's order key, the ledger's row scope and the
 * acknowledgement marker all carry it — and the core compares ids digit-wise
 * precisely so that they stay exact past 2^53 (`compareChatOpsCommentIds`). A
 * rounded id would name a different comment than the one that was read: two
 * neighbours could collapse onto one value, so a scan could no longer
 * deduplicate an already-handled command or authenticate the marker it posted.
 *
 * So the payload is re-tokenized once before parsing and every integer literal
 * that cannot round-trip through a double is quoted, reaching
 * {@link toObservedComment} as an exact decimal string. Quoting is applied to
 * every such literal, not just `id`: the alternative is a field-aware parser,
 * and no field this adapter reads is a number (`body`, `user.login`,
 * `created_at`, `updated_at` are all strings).
 *
 * @throws SyntaxError for malformed JSON, exactly as `JSON.parse` does.
 */
function parseJsonPreservingLargeIntegers(text: string): unknown {
  return JSON.parse(quoteUnsafeIntegerLiterals(text));
}

/** A JSON integer literal: optional sign, no leading zeros, no fraction/exponent. */
const CANONICAL_INTEGER = /^-?(?:0|[1-9][0-9]*)$/;

/** The non-digit characters that may appear in a JSON fraction/exponent tail. */
const EXPONENT_CHARS = new Set(["e", "E", "+", "-"]);

/** Whether `ch` is an ASCII decimal digit. */
function isDigit(ch: string | undefined): boolean {
  return ch !== undefined && ch >= "0" && ch <= "9";
}

/**
 * Rewrite JSON text so that integer literals outside the safe-integer range
 * become string literals. Everything else — strings (escapes included), floats,
 * exponents, structure and whitespace — is copied through byte for byte, so a
 * payload with no oversized integer is passed to `JSON.parse` unchanged.
 */
function quoteUnsafeIntegerLiterals(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '"') {
      // A string literal is copied verbatim: digits inside it are text, and a
      // `\"` must not be mistaken for the closing quote.
      const start = i;
      i += 1;
      while (i < text.length) {
        const c = text[i]!;
        if (c === "\\") {
          i += 2;
          continue;
        }
        i += 1;
        if (c === '"') break;
      }
      out += text.slice(start, i);
      continue;
    }
    if (ch === "-" || isDigit(ch)) {
      // Outside a string, a digit can only begin a number token in valid JSON.
      const start = i;
      if (ch === "-") i += 1;
      while (isDigit(text[i])) i += 1;
      if (text[i] === "." || text[i] === "e" || text[i] === "E") {
        // A fraction or exponent is a real number, not an identifier; consume
        // the rest of the token and leave it alone.
        i += 1;
        while (isDigit(text[i]) || EXPONENT_CHARS.has(text[i]!)) i += 1;
        out += text.slice(start, i);
        continue;
      }
      const token = text.slice(start, i);
      // Only a *well-formed* JSON integer is rewritten. A malformed token is
      // copied through so `JSON.parse` still rejects the payload: quoting it
      // would turn invalid JSON into a valid string and hide the defect.
      const rewritable = CANONICAL_INTEGER.test(token) && !Number.isSafeInteger(Number(token));
      out += rewritable ? `"${token}"` : token;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}
