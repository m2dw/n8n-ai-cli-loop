import type { BlockedByEntry } from "../../core/github-intake.js";
import type {
  WorkItemProvider,
  WorkItem,
  WorkItemDetails,
  WorkItemTransition,
  DependencyMutationResult,
  ProviderResult,
  ProviderRead,
} from "../types.js";
import {
  buildGiteaApiUrl,
  defaultGiteaHttp,
  redactGiteaSecrets,
  type GiteaHttpRequest,
  type GiteaHttpResponse,
} from "./gitea-client.js";

// ---------------------------------------------------------------------------
// Gitea-backed work-item provider (issue #382)
//
// Implements the WorkItemProvider contract against the *verified* Gitea REST API
// (https://docs.gitea.com/api/), NOT by reusing GitHub call shapes:
//
//  - listing issues uses `GET /repos/{o}/{r}/issues?type=issues` and excludes
//    pull requests (Gitea's issue index returns PRs too unless filtered);
//  - label add/remove uses Gitea's numeric label-id endpoints — Gitea does not
//    accept label names the way GitHub's `gh api .../labels` does — so a label
//    name is resolved to its id first, and a missing workflow label fails clearly
//    instead of silently no-op'ing;
//  - dependency relationships use Gitea's native issue-dependencies endpoint.
//
// The instance is reached through an injectable, synchronous HTTP transport
// (see gitea-client.ts) so unit tests drive every branch with a fake — no live
// Gitea server is required.
//
// SECURITY: Gitea issue/comment/label content is untrusted input. This provider
// only reads it and writes operator/handler-supplied text; issue content never
// chooses an endpoint, a label to mutate, or the token. Errors are built from
// status lines / bounded snippets and redacted, so the API token never reaches
// an error message, task context, or a published comment.
// ---------------------------------------------------------------------------

/** Maximum issue-body length surfaced in candidate listings (bounded input). */
const DEFAULT_MAX_BODY_CHARS = 8_000;

/**
 * Per-page size for the issue index. Gitea paginates `GET /issues` and clamps
 * the `limit` query to its configured max page size (50 by default), so the
 * caller's total `limit` is collected by paging at this size rather than asking
 * for it all at once.
 */
const ISSUE_PAGE_LIMIT = 50;

/**
 * Requested page size for the repo-label lookup that resolves names to ids. This
 * is only a hint — Gitea clamps it to the instance's configured max page size — so
 * {@link GiteaWorkItemProvider.resolveLabelId} never infers exhaustion from a page
 * being shorter than this value (a self-hosted cap below it would make a full page
 * look "short"); it pages until the label is found or a genuinely empty page is
 * returned. 50 matches Gitea's default cap so a normal instance needs the fewest
 * round-trips.
 */
const LABEL_LOOKUP_LIMIT = 50;

/**
 * Hard cap on label pages fetched per lookup. The label lookup gates label
 * mutations, so a truncated result must never read as "label absent": if every
 * page up to this cap comes back non-empty, {@link GiteaWorkItemProvider.resolveLabelId}
 * fails closed instead of reporting a possibly-present label as missing. 50 pages
 * spans far more labels than any realistic repo (at least 50, even if the instance
 * clamps the page size all the way down to one).
 */
const LABEL_MAX_PAGES = 50;

/** Requested page size for the native dependency read (a hint Gitea may clamp). */
const DEPENDENCY_LIMIT = 50;

/**
 * Hard cap on dependency pages fetched per issue. The dependency gate is
 * fail-closed, so a runaway list must never be silently truncated: if every page
 * up to this cap comes back non-empty, the read throws instead of returning a
 * partial list. 50 pages spans far more blockers than any realistic dependency
 * fan-in (at least 50, even if the instance clamps the page size down to one).
 */
const DEPENDENCY_MAX_PAGES = 50;

export interface GiteaWorkItemProviderOptions {
  /** Base URL of the Gitea instance, e.g. `https://gitea.example.com`. */
  baseUrl: string;
  /** Owning organization or user. */
  owner: string;
  /** Repository name within `owner`. */
  repo: string;
  /** API token resolved at runtime (never persisted). */
  token: string;
  /** Optional API base path. Defaults to `/api/v1`. */
  apiPath?: string;
  /** Injectable HTTP transport. Defaults to the Node-subprocess transport. */
  http?: GiteaHttpRequest;
  /** Override the bounded issue-body budget. */
  maxBodyChars?: number;
}

/** Shape of a Gitea issue/label as returned by the REST API (fields we read). */
interface GiteaLabel {
  id: number;
  name: string;
}
interface GiteaIssue {
  number: number;
  title?: string;
  html_url?: string;
  body?: string;
  state?: string;
  labels?: GiteaLabel[] | null;
  /** Present and non-null when the entry is actually a pull request. */
  pull_request?: unknown;
}

export class GiteaWorkItemProvider implements WorkItemProvider {
  private readonly baseUrl: string;
  private readonly owner: string;
  private readonly repo: string;
  private readonly token: string;
  private readonly apiPath: string | undefined;
  private readonly http: GiteaHttpRequest;
  private readonly maxBodyChars: number;

  constructor(opts: GiteaWorkItemProviderOptions) {
    this.baseUrl = opts.baseUrl;
    this.owner = opts.owner;
    this.repo = opts.repo;
    this.token = opts.token;
    this.apiPath = opts.apiPath;
    this.http = opts.http ?? defaultGiteaHttp;
    this.maxBodyChars = opts.maxBodyChars ?? DEFAULT_MAX_BODY_CHARS;
  }

  // -------------------------------------------------------------------------
  // Low-level request helpers
  // -------------------------------------------------------------------------

  private repoPath(suffix: string): string {
    return `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}${suffix}`;
  }

  private send(
    method: string,
    endpointPath: string,
    opts: { query?: Record<string, string>; body?: unknown } = {},
  ): GiteaHttpResponse {
    const url = buildGiteaApiUrl(this.baseUrl, this.apiPath, endpointPath, opts.query);
    const hasBody = opts.body !== undefined;
    const headers: Record<string, string> = {
      // Gitea personal access tokens use the `token <value>` scheme.
      Authorization: `token ${this.token}`,
      Accept: "application/json",
      "User-Agent": "n8n-ai-cli-loop",
      ...(hasBody ? { "Content-Type": "application/json" } : {}),
    };
    try {
      return this.http({
        method,
        url,
        headers,
        ...(hasBody ? { body: JSON.stringify(opts.body) } : {}),
      });
    } catch (err) {
      // The transport throws ONLY on a transport-level failure (DNS failure,
      // connection refused/reset) — a non-2xx HTTP response is a normal return.
      // Convert that throw into a synthetic non-2xx envelope so every caller
      // funnels through the same `is2xx` failure path instead of the exception
      // escaping uncaught. This is what keeps the outbox contract intact during a
      // transient Gitea outage: mutation callers (commentItem / transitionItem)
      // then report a retryable per-entry failure and leave the row pending,
      // rather than throwing out of dispatchEntry/dispatchOutbox and aborting the
      // whole CLI. Read callers (listCandidateItems / getDependencies) keep their
      // existing fail / fail-closed behavior since they already throw on a non-2xx
      // response. Status 0 marks "no HTTP response" (it is never 2xx and never the
      // 404 that remove-label tolerates). The message is redacted as defense in
      // depth — the token rides in the request headers, never in a transport
      // error — so it cannot leak through the resulting failure string.
      const message = redactGiteaSecrets(err instanceof Error ? err.message : String(err), [this.token]);
      return { status: 0, statusText: `transport error: ${message}`, body: "" };
    }
  }

  private static is2xx(res: GiteaHttpResponse): boolean {
    return res.status >= 200 && res.status < 300;
  }

  /** A redacted, bounded one-line description of a failed response. */
  private failure(label: string, res: GiteaHttpResponse): string {
    const snippet = (res.body || res.statusText || "").slice(0, 200);
    return redactGiteaSecrets(`${label} (HTTP ${res.status}): ${snippet}`, [this.token]);
  }

  // -------------------------------------------------------------------------
  // WorkItemProvider
  // -------------------------------------------------------------------------

  listCandidateItems(limit: number): WorkItem[] {
    // Gitea paginates the issue index and clamps `limit` to its configured max
    // page size, so a single GET only ever returns one page. Match the GitHub
    // provider's contract — where the CLI `--limit` is the total number of issues
    // to scan — by paging until `limit` candidates are collected or a page comes
    // back empty.
    const perPage = Math.min(Math.max(limit, 1), ISSUE_PAGE_LIMIT);
    // Termination keys on an *empty* page, never a short one: on a self-hosted
    // Gitea whose max page size is below the requested `perPage`, a "full" page is
    // SHORTER than requested even though more issues remain, so stopping on a short
    // page would drop every eligible issue on a later page. Zero is the only length
    // the server cannot have clamped. `maxPages` is just a runaway guard: each page
    // yields at most one candidate per entry, so `limit` pages bounds the scan even
    // if the server clamps down to a one-item page.
    const maxPages = Math.max(limit, 1);
    const out: WorkItem[] = [];
    for (let page = 1; out.length < limit && page <= maxPages; page++) {
      const res = this.send("GET", this.repoPath("/issues"), {
        // `type=issues` excludes pull requests on the Gitea issue index.
        query: { type: "issues", state: "open", page: String(page), limit: String(perPage) },
      });
      if (!GiteaWorkItemProvider.is2xx(res)) {
        throw new Error(this.failure("Gitea issue list failed", res));
      }
      let raw: GiteaIssue[];
      try {
        raw = JSON.parse(res.body) as GiteaIssue[];
      } catch {
        throw new Error(
          redactGiteaSecrets(`Gitea issue list returned non-JSON output: ${res.body.slice(0, 200)}`, [this.token]),
        );
      }
      if (!Array.isArray(raw)) {
        throw new Error("Gitea issue list returned a non-array payload");
      }
      for (const i of raw) {
        // Defense in depth: drop anything that is actually a PR even though
        // `type=issues` should already exclude them.
        if (i.pull_request != null || typeof i.number !== "number") continue;
        const body =
          typeof i.body === "string" && i.body.length > 0 ? this.boundBody(i.body) : undefined;
        out.push({
          number: i.number,
          title: i.title ?? "",
          url: i.html_url ?? "",
          labels: (i.labels ?? []).map((l) => l.name),
          ...(body !== undefined ? { body } : {}),
        } satisfies WorkItem);
        if (out.length >= limit) break;
      }
      // A short page may be a server-clamped full page with more issues to come;
      // only an empty page proves the list is exhausted.
      if (raw.length === 0) break;
    }
    return out;
  }

  getItem(issueNumber: number): ProviderRead<WorkItemDetails> {
    const res = this.send("GET", this.repoPath(`/issues/${issueNumber}`));
    if (!GiteaWorkItemProvider.is2xx(res)) {
      return { ok: false, error: this.failure("Gitea issue read failed", res) };
    }
    let data: GiteaIssue;
    try {
      data = JSON.parse(res.body) as GiteaIssue;
    } catch {
      return {
        ok: false,
        error: redactGiteaSecrets(`Gitea issue read returned non-JSON output: ${res.body.slice(0, 200)}`, [this.token]),
      };
    }
    return { ok: true, value: { labels: (data.labels ?? []).map((l) => l.name) } };
  }

  /**
   * Native Gitea issue dependencies (`GET /repos/{o}/{r}/issues/{n}/dependencies`)
   * list the issues this issue depends on — its `blocked by` set. Mapped to
   * {@link BlockedByEntry}. Per the WorkItemProvider/DependencyChecker contract
   * this MUST throw on any error so callers fail closed; it never fabricates a
   * "no blockers" result on failure.
   */
  async getDependencies(issueNumber: number): Promise<BlockedByEntry[]> {
    return this.readRelationships(issueNumber, "dependencies");
  }

  /**
   * The other end of the same relationship: `GET /repos/{o}/{r}/issues/{n}/blocks`
   * lists the issues this one blocks (issue #791 review). The path is Gitea's
   * documented counterpart of `/dependencies` and, like the mutation paths below,
   * is a PIN — it cannot be exercised against a live Gitea from this repository.
   */
  async getDependents(issueNumber: number): Promise<BlockedByEntry[]> {
    return this.readRelationships(issueNumber, "blocks");
  }

  /**
   * One paginated relationship read, in either direction, shared by the two
   * methods above so both page and fail closed identically.
   */
  private async readRelationships(
    issueNumber: number,
    endpoint: "dependencies" | "blocks",
  ): Promise<BlockedByEntry[]> {
    // The Gitea HTTP envelope exposes no headers (no `X-Total-Count`/`Link`), so
    // there is no total to read up front and no `rel="next"` link to follow. Page
    // until an *empty* page proves the list is exhausted. A short (non-empty) page
    // is NOT proof of exhaustion: a self-hosted Gitea whose max page size is below
    // `DEPENDENCY_LIMIT` returns a short full page even when a later page exists.
    // Because the dependency gate is fail-closed, treating such a short page as
    // complete could miss an open blocker on a later page and let intake/
    // implementation start work on a still-blocked issue.
    const out: BlockedByEntry[] = [];
    for (let page = 1; page <= DEPENDENCY_MAX_PAGES; page++) {
      const res = this.send("GET", this.repoPath(`/issues/${issueNumber}/${endpoint}`), {
        query: { page: String(page), limit: String(DEPENDENCY_LIMIT) },
      });
      if (!GiteaWorkItemProvider.is2xx(res)) {
        throw new Error(this.failure(`Gitea issue ${endpoint} read failed`, res));
      }
      let raw: GiteaIssue[];
      try {
        raw = JSON.parse(res.body) as GiteaIssue[];
      } catch {
        throw new Error(
          redactGiteaSecrets(`Gitea ${endpoint} returned non-JSON output: ${res.body.slice(0, 200)}`, [this.token]),
        );
      }
      if (!Array.isArray(raw)) {
        throw new Error(`Gitea ${endpoint} returned a non-array payload`);
      }
      for (const i of raw) {
        if (typeof i.number === "number") {
          out.push({
            issueNumber: i.number,
            state: i.state?.toLowerCase() === "closed" ? "closed" : "open",
          });
        }
      }
      // A short page may be a server-clamped full page with more blockers to come,
      // so only an empty page proves the list is fully read.
      if (raw.length === 0) {
        return out;
      }
    }
    // Every page up to the cap was non-empty, so the list may extend further. Fail
    // closed rather than return a truncated blocker set that could read as "no
    // open blocker" and let a dependent start work despite an unseen dependency.
    throw new Error(
      `Gitea issue #${issueNumber} still returns ${endpoint} after ${DEPENDENCY_MAX_PAGES} pages; ` +
        `refusing to treat a truncated dependency list as complete (fail closed).`,
    );
  }

  /**
   * Gitea's native issue-dependency writes, the counterpart of the read above:
   *
   *   POST   /repos/{o}/{r}/issues/{index}/dependencies  IssueMeta
   *   DELETE /repos/{o}/{r}/issues/{index}/dependencies  IssueMeta
   *
   * Both name the blocker with an `IssueMeta` body — `{index, owner, repo}` —
   * where `index` is the repository-scoped issue number, the same number
   * `getDependencies` reads back, so no database-id lookup is needed. This is
   * deliberately NOT the GitHub provider's shape: GitHub takes an `issue_id`
   * (database id) and deletes through `.../dependencies/blocked_by/{issue_id}`,
   * while Gitea has no such field and no per-dependency delete route — it
   * answers both writes on the collection and reads the blocker out of the body.
   * Reusing the GitHub call shape here is exactly what
   * `docs/gitea-private-work-items.md` ("do not assume Gitea's REST API is
   * GitHub-compatible") forbids, and Gitea would reject it.
   *
   * `owner`/`repo` are sent rather than left off: Gitea resolves the body
   * against the current repository only when they MATCH it, and otherwise
   * treats the request as a cross-repository dependency — which it refuses
   * unless that feature is enabled. Omitting them therefore fails a same-repo
   * add, which is every edge these chain commands write.
   *
   * Like the GitHub provider's pair, the paths and payload are a PIN — they
   * match Gitea's documented issue-dependency API and cannot be exercised live
   * from this repository — so the verification below is what keeps a wrong PIN
   * loud instead of silent.
   *
   * A duplicate add (Gitea answers 409 when the dependency already exists) is
   * the requested end state, not a failure: it reports `changed: false` so a
   * retry of a half-applied chain edit converges instead of failing on the
   * steps that already landed.
   *
   * A removal answered with 404 is NOT taken at face value. 404 is what this
   * endpoint returns when the dependency is already gone, but it is equally
   * what a Gitea that routes the delete differently — or one whose transport
   * dropped the request body, which several HTTP stacks do for DELETE — returns
   * for a relationship that is still very much in place (issue #791 review).
   * Reporting that as the requested end state would let a chain edit record a
   * removal that never happened, so the claim is checked against the dependency
   * list before it is believed: `changed: false` only when Gitea itself says
   * the blocker is no longer there.
   */
  private async mutateDependency(
    blockedIssueNumber: number,
    blockerIssueNumber: number,
    mode: "add" | "remove",
  ): Promise<DependencyMutationResult> {
    const res = this.send(
      mode === "add" ? "POST" : "DELETE",
      this.repoPath(`/issues/${blockedIssueNumber}/dependencies`),
      { body: { index: blockerIssueNumber, owner: this.owner, repo: this.repo } },
    );
    if (GiteaWorkItemProvider.is2xx(res)) {
      if (mode === "add") return { ok: true, changed: true };
      // Even a 2xx delete is verified: the endpoint answers on the collection,
      // so a server that ignored the body would report success having removed
      // nothing.
      return this.confirmRemoval(blockedIssueNumber, blockerIssueNumber, res, true);
    }
    if (mode === "add" && res.status === 409) return { ok: true, changed: false };
    if (mode === "remove" && res.status === 404) {
      return this.confirmRemoval(blockedIssueNumber, blockerIssueNumber, res, false);
    }
    return {
      ok: false,
      error: this.failure(
        `Gitea dependency:${mode} failed for #${blockedIssueNumber} blocked by #${blockerIssueNumber}`,
        res,
      ),
    };
  }

  /**
   * Read the dependency list back and answer only what it supports: the removal
   * counts as done when the blocker is absent, and fails — with the original
   * response quoted — when it is still listed. A read that cannot be completed
   * is a failure too: an unverifiable removal must not read as a successful one.
   */
  private async confirmRemoval(
    blockedIssueNumber: number,
    blockerIssueNumber: number,
    res: GiteaHttpResponse,
    changed: boolean,
  ): Promise<DependencyMutationResult> {
    let blockers: BlockedByEntry[];
    try {
      blockers = await this.getDependencies(blockedIssueNumber);
    } catch (err) {
      return {
        ok: false,
        error: redactGiteaSecrets(
          `Gitea dependency:remove for #${blockedIssueNumber} blocked by #${blockerIssueNumber} could not be ` +
            `verified (HTTP ${res.status}): ${err instanceof Error ? err.message : String(err)}`,
          [this.token],
        ),
      };
    }
    if (blockers.some((b) => b.issueNumber === blockerIssueNumber)) {
      return {
        ok: false,
        error: this.failure(
          `Gitea dependency:remove for #${blockedIssueNumber} blocked by #${blockerIssueNumber} did not take ` +
            "effect: the blocker is still listed",
          res,
        ),
      };
    }
    return { ok: true, changed };
  }

  async addDependency(blockedIssueNumber: number, blockerIssueNumber: number): Promise<DependencyMutationResult> {
    return this.mutateDependency(blockedIssueNumber, blockerIssueNumber, "add");
  }

  async removeDependency(blockedIssueNumber: number, blockerIssueNumber: number): Promise<DependencyMutationResult> {
    return this.mutateDependency(blockedIssueNumber, blockerIssueNumber, "remove");
  }

  /**
   * Scan the issue's comment history for `marker` (issue #936).
   *
   * Termination keys on an EMPTY page, never a short one — a self-hosted Gitea
   * clamps `limit` to its configured max page size, so a "full" page can come
   * back shorter than requested and stopping there would miss a marker on a
   * later page and duplicate the comment. `MAX_PAGES` is a runaway guard only;
   * exceeding it is a failure rather than "not found", because the caller uses
   * this as a delivery precondition and an unread history is not an absent one.
   */
  hasItemCommentWithMarker(issueNumber: number, marker: string): ProviderRead<boolean> {
    const PER_PAGE = 50;
    const MAX_PAGES = 200;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = this.send("GET", this.repoPath(`/issues/${issueNumber}/comments`), {
        query: { page: String(page), limit: String(PER_PAGE) },
      });
      if (!GiteaWorkItemProvider.is2xx(res)) {
        return { ok: false, error: this.failure(`Gitea issue comment list failed (page ${page})`, res) };
      }
      let comments: Array<{ body?: unknown }>;
      try {
        comments = JSON.parse(res.body) as Array<{ body?: unknown }>;
      } catch {
        return {
          ok: false,
          error: redactGiteaSecrets(
            `Gitea issue comment list returned non-JSON output (page ${page}): ${res.body.slice(0, 200)}`,
            [this.token],
          ),
        };
      }
      if (!Array.isArray(comments)) {
        return { ok: false, error: `Gitea issue comment list returned a non-array payload (page ${page})` };
      }
      if (comments.some((c) => typeof c.body === "string" && c.body.includes(marker))) {
        return { ok: true, value: true };
      }
      if (comments.length === 0) return { ok: true, value: false };
    }
    return {
      ok: false,
      error: `Gitea issue comment list exceeded ${MAX_PAGES} pages for #${issueNumber}; comment history not fully scanned`,
    };
  }

  commentItem(issueNumber: number, body: string): ProviderResult {
    // Gitea has no native idempotency key for comments; dedupe is owned by the
    // local outbox (idempotencyKey on the row), so the parameter is accepted for
    // interface parity but not forwarded.
    const res = this.send("POST", this.repoPath(`/issues/${issueNumber}/comments`), {
      body: { body },
    });
    if (!GiteaWorkItemProvider.is2xx(res)) {
      return { ok: false, error: this.failure("Gitea issue comment failed", res) };
    }
    return { ok: true };
  }

  transitionItem(issueNumber: number, transition: WorkItemTransition): ProviderResult {
    // Gitea's label endpoints key on numeric label ids, so resolve the configured
    // workflow label name to its id first.
    const resolved = this.resolveLabelId(transition.label);
    if (!resolved.ok) return { ok: false, error: resolved.error };
    const labelId = resolved.value;

    if (transition.kind === "add-label") {
      if (labelId === undefined) {
        // The workflow expects this label to exist; a missing one is a real
        // configuration problem, not a no-op. Fail clearly so the operator
        // creates it on the Gitea repo rather than silently dropping the state.
        return {
          ok: false,
          error: `Gitea label not found: "${transition.label}". Create it on the Gitea repository before the workflow uses it.`,
        };
      }
      const res = this.send("POST", this.repoPath(`/issues/${issueNumber}/labels`), {
        body: { labels: [labelId] },
      });
      if (!GiteaWorkItemProvider.is2xx(res)) {
        return { ok: false, error: this.failure("Gitea add-label failed", res) };
      }
      return { ok: true };
    }

    // remove-label: a label that does not exist on the repo is already absent
    // from the issue, so removal is a no-op success (mirroring the GitHub
    // provider's tolerance of a 404 on remove). Reported via `alreadyAbsent`
    // rather than a plain `ok: true` (issue #787 review): a caller that must
    // attribute the removal to THIS call needs to tell "already gone" apart
    // from "this call removed it".
    if (labelId === undefined) return { ok: true, alreadyAbsent: true };
    const res = this.send("DELETE", this.repoPath(`/issues/${issueNumber}/labels/${labelId}`));
    if (!GiteaWorkItemProvider.is2xx(res)) {
      if (res.status === 404) return { ok: true, alreadyAbsent: true };
      return { ok: false, error: this.failure("Gitea remove-label failed", res) };
    }
    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private boundBody(text: string): string {
    if (text.length <= this.maxBodyChars) return text;
    return text.slice(0, this.maxBodyChars) + "\n\n…(truncated)";
  }

  /**
   * Resolve a label name to its Gitea numeric id via the (paginated) repo label
   * list. Returns `{ ok: true, value: undefined }` only when the label is proven
   * absent (an empty page ended the list), so callers can distinguish "absent" (a
   * no-op on remove, a hard error on add) from "lookup failed" (`ok: false`,
   * which includes a truncated list that could not be confirmed exhaustive).
   */
  private resolveLabelId(name: string): ProviderRead<number | undefined> {
    // Gitea paginates the repo label list, so a workflow label that lives on a
    // later page would otherwise read as missing — making add-label transitions
    // fail and remove-label transitions a silent no-op that leaves the issue
    // mislabeled. Page until the label is found or an *empty* page proves the list
    // is exhausted; a short (non-empty) page may be a server-clamped full page.
    for (let page = 1; page <= LABEL_MAX_PAGES; page++) {
      const res = this.send("GET", this.repoPath("/labels"), {
        query: { page: String(page), limit: String(LABEL_LOOKUP_LIMIT) },
      });
      if (!GiteaWorkItemProvider.is2xx(res)) {
        return { ok: false, error: this.failure("Gitea label list failed", res) };
      }
      let labels: GiteaLabel[];
      try {
        labels = JSON.parse(res.body) as GiteaLabel[];
      } catch {
        return {
          ok: false,
          error: redactGiteaSecrets(`Gitea label list returned non-JSON output: ${res.body.slice(0, 200)}`, [this.token]),
        };
      }
      if (!Array.isArray(labels)) {
        return { ok: false, error: "Gitea label list returned a non-array payload" };
      }
      const match = labels.find((l) => l.name === name);
      if (match) return { ok: true, value: match.id };
      // A short page may be a server-clamped full page with more labels to come;
      // only an empty page proves the label genuinely does not exist.
      if (labels.length === 0) return { ok: true, value: undefined };
    }
    // Every page up to the cap was non-empty, so the label list may extend further
    // and we cannot prove this label is absent. Fail closed rather than report a
    // possibly-present label as missing, which would make remove-label a silent
    // no-op and could leave the issue's workflow state wrong.
    return {
      ok: false,
      error:
        `Gitea repository still returns labels after ${LABEL_MAX_PAGES} pages; ` +
        `cannot confirm whether label "${name}" exists (fail closed rather than risk a wrong label transition).`,
    };
  }
}
