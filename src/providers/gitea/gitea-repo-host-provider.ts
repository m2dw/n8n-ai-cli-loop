import type { GiteaClient, GiteaResponse } from "./gitea-client.js";
import { branchName } from "../../handlers/pr-helpers.js";
import type {
  RepoHostProvider,
  FindPullRequestResult,
  PullRequest,
  CreatePullRequestInput,
  ProviderResult,
  ProviderRead,
} from "../types.js";

// ---------------------------------------------------------------------------
// Gitea REST-backed repository-host provider
//
// The Gitea sibling of GhRepoHostProvider. It implements the SAME
// RepoHostProvider interface so handlers route PR operations through the seam
// without knowing the backend, but the call shapes are Gitea's, not GitHub's —
// honoring the architecture's standing rule that Gitea's REST API must not be
// assumed GitHub-compatible (docs/gitea-private-work-items.md, "Verification
// obligation"). The verified Gitea v1 surface used here:
//
//   - create PR : POST   /repos/{owner}/{repo}/pulls       { title, head, base, body }
//   - get PR    : GET    /repos/{owner}/{repo}/pulls/{index}
//   - list PRs  : GET    /repos/{owner}/{repo}/pulls?state=open  (NO head filter)
//   - PR comment: POST   /repos/{owner}/{repo}/issues/{index}/comments  { body }
//
// Two Gitea-specific differences are handled deliberately:
//
//  1. **No head-branch list filter.** Unlike `gh pr list --head <branch>`, the
//     Gitea list endpoint has no `head` query parameter, so the head-branch
//     convention (`ai/issue-<n>`) is resolved by listing open PRs and matching
//     `head.ref` client-side. Because there is no server-side filter, the lookup
//     pages through ALL open PRs (not just the first page) so a match on a later
//     page is never missed. The convention itself stays owned here, exactly as in
//     the GitHub provider.
//  2. **Coarser mergeability.** Gitea exposes a single boolean `mergeable` and
//     has no equivalent of GitHub's `mergeStateStatus`. See {@link mapMergeable}
//     for the documented degradation.
//
// A pull request and its conversation share an index in Gitea (a PR *is* an
// issue), so PR comments post to the `issues/{index}/comments` endpoint with the
// PR number — there is no separate PR-comment resource.
// ---------------------------------------------------------------------------

/** Open-PR list page size requested from Gitea when scanning for the head branch. */
const LIST_PAGE_SIZE = 50;
/**
 * Hard cap on pages scanned by {@link GiteaRepoHostProvider.findPullRequestForWorkItem}.
 * Bounds the pagination loop so a misbehaving server that always returns a full
 * page can never spin forever; `100 * 50 = 5000` open PRs is far beyond any
 * realistic active set, so reaching it signals a fault, not a real "not found".
 */
const MAX_LIST_PAGES = 100;

/** Comment list page size used when scanning for a sticky marker comment. */
const COMMENT_PAGE_SIZE = 50;
/**
 * Hard cap on comment pages scanned by {@link GiteaRepoHostProvider.upsertStickyPrComment}.
 * `20 * 50 = 1000` comments is far beyond any realistic PR thread, so reaching
 * the cap signals a misbehaving server rather than a genuinely absent marker.
 */
const MAX_COMMENT_PAGES = 20;

/** Shape of the relevant fields in a Gitea PullRequest JSON object. */
interface GiteaPullRequestJson {
  number?: number;
  html_url?: string;
  url?: string;
  state?: string;
  head?: { ref?: string; repo?: { full_name?: string } };
  base?: { ref?: string; repo?: { full_name?: string } };
  mergeable?: boolean;
}

export class GiteaRepoHostProvider implements RepoHostProvider {
  constructor(
    private readonly client: GiteaClient,
    private readonly owner: string,
    private readonly repo: string,
  ) {}

  private get repoPath(): string {
    return `repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}`;
  }

  findPullRequestForWorkItem(issueNumber: number): FindPullRequestResult {
    const head = branchName(issueNumber);
    // Gitea has no `head` list filter (unlike `gh pr list --head`), so the
    // head-branch convention is resolved by listing open PRs and matching
    // `head.ref` client-side. A single page is not enough: a repo with more open
    // PRs than one page would hide a matching `ai/issue-<n>` head on a later page,
    // making the lookup wrongly report `kind: "none"` and the workflow create a
    // duplicate PR or hand off incorrectly. So page through the open PRs until the
    // branch is found or the list is exhausted (a short/empty page = last page).
    for (let page = 1; page <= MAX_LIST_PAGES; page++) {
      let res: GiteaResponse;
      try {
        res = this.client.request({
          method: "GET",
          path: `/${this.repoPath}/pulls`,
          query: { state: "open", limit: LIST_PAGE_SIZE, page },
        });
      } catch (err) {
        return { kind: "failed", error: `gitea pulls list failed: ${errMessage(err)}` };
      }

      if (!ok(res.status)) {
        return { kind: "failed", error: `gitea pulls list failed (HTTP ${res.status}): ${res.body.slice(0, 300)}` };
      }

      let prs: GiteaPullRequestJson[];
      try {
        prs = JSON.parse(res.body) as GiteaPullRequestJson[];
      } catch {
        return { kind: "failed", error: `gitea pulls list returned non-JSON output: ${res.body.slice(0, 200)}` };
      }

      const match = prs.find((pr) => pr.head?.ref === head);
      if (match) {
        return { kind: "found", pullRequest: mapPullRequest(match) };
      }

      // A page shorter than the requested size (including an empty page) is the
      // last page, so no open PR matches the head branch.
      if (prs.length < LIST_PAGE_SIZE) {
        return { kind: "none" };
      }
    }

    // Every page was full up to the cap without a match: rather than risk an
    // unbounded loop against a misbehaving server (or wrongly claim "none" after
    // giving up), fail loudly so the caller does not create a duplicate PR.
    return {
      kind: "failed",
      error: `gitea pulls list exceeded ${MAX_LIST_PAGES} pages (${MAX_LIST_PAGES * LIST_PAGE_SIZE} open PRs) without resolving issue #${issueNumber}`,
    };
  }

  createPullRequest(input: CreatePullRequestInput): ProviderRead<PullRequest> {
    let res: GiteaResponse;
    try {
      res = this.client.request({
        method: "POST",
        path: `/${this.repoPath}/pulls`,
        body: { title: input.title, body: input.body, head: input.head, base: input.base },
      });
    } catch (err) {
      return { ok: false, error: `gitea pulls create failed: ${errMessage(err)}` };
    }

    if (!ok(res.status)) {
      return { ok: false, error: `gitea pulls create failed (HTTP ${res.status}): ${res.body.slice(0, 300)}` };
    }

    let pr: GiteaPullRequestJson;
    try {
      pr = JSON.parse(res.body) as GiteaPullRequestJson;
    } catch {
      return { ok: false, error: `gitea pulls create returned non-JSON output: ${res.body.slice(0, 200)}` };
    }
    return { ok: true, value: mapPullRequest(pr) };
  }

  getPullRequest(selector: string): ProviderRead<PullRequest> {
    let res: GiteaResponse;
    try {
      res = this.client.request({
        method: "GET",
        path: `/${this.repoPath}/pulls/${encodeURIComponent(selector)}`,
      });
    } catch (err) {
      return { ok: false, error: `gitea pulls view failed: ${errMessage(err)}` };
    }

    if (!ok(res.status)) {
      return { ok: false, error: `gitea pulls view failed (HTTP ${res.status}): ${res.body.slice(0, 300)}` };
    }

    let pr: GiteaPullRequestJson;
    try {
      pr = JSON.parse(res.body) as GiteaPullRequestJson;
    } catch {
      return { ok: false, error: `gitea pulls view returned non-JSON output: ${res.body.slice(0, 200)}` };
    }
    return { ok: true, value: mapPullRequest(pr) };
  }

  commentPullRequest(selector: string, body: string): ProviderResult {
    // A Gitea PR shares its index with an issue, so the conversation comment is
    // posted to the issues/{index}/comments endpoint with the PR number.
    let res: GiteaResponse;
    try {
      res = this.client.request({
        method: "POST",
        path: `/${this.repoPath}/issues/${encodeURIComponent(selector)}/comments`,
        body: { body },
      });
    } catch (err) {
      return { ok: false, error: `gitea pr comment failed: ${errMessage(err)}` };
    }

    if (!ok(res.status)) {
      return { ok: false, error: `gitea pr comment failed (HTTP ${res.status}): ${res.body.slice(0, 200)}` };
    }
    return { ok: true };
  }

  upsertStickyPrComment(prNumber: number, marker: string, body: string): ProviderResult {
    // Resolve the authenticated identity so we only edit comments we own.
    // Gitea rejects PATCH requests to comments authored by a different user,
    // which would leave the outbox row permanently pending. When the identity
    // lookup succeeds we match by exact login; if it fails we skip the edit and
    // create a new comment instead.
    let botLogin: string | undefined;
    try {
      const whoamiRes = this.client.request({ method: "GET", path: "/user" });
      if (ok(whoamiRes.status)) {
        const user = JSON.parse(whoamiRes.body) as { login?: string };
        botLogin = typeof user.login === "string" ? user.login : undefined;
      }
    } catch {
      // Identity unavailable — fall through; any marker comment will be skipped
      // and a fresh comment will be created.
    }

    // Page through all existing comments to find the sticky one by marker.
    // A single request can miss the marker when the thread exceeds the default
    // page size, causing a duplicate comment — match the paginated approach used
    // by findPullRequestForWorkItem.
    let commentId: number | undefined;
    for (let page = 1; page <= MAX_COMMENT_PAGES; page++) {
      let listRes: GiteaResponse;
      try {
        listRes = this.client.request({
          method: "GET",
          path: `/${this.repoPath}/issues/${prNumber}/comments`,
          query: { limit: COMMENT_PAGE_SIZE, page },
        });
      } catch (err) {
        return { ok: false, error: `gitea list comments failed: ${errMessage(err)}` };
      }
      if (!ok(listRes.status)) {
        return { ok: false, error: `gitea list comments failed (HTTP ${listRes.status}): ${listRes.body.slice(0, 200)}` };
      }

      let comments: Array<{ id: number; body: string; user?: { login?: string } }>;
      try {
        comments = JSON.parse(listRes.body) as Array<{ id: number; body: string; user?: { login?: string } }>;
      } catch {
        // Ignore JSON parse errors — fall through to create a new comment.
        break;
      }

      const found = comments.find(
        (c) =>
          typeof c.body === "string" &&
          c.body.includes(marker) &&
          // Only match comments owned by this identity; skip unowned marker
          // comments so we fall through to creating a new one rather than
          // attempting an edit that Gitea would reject.
          (botLogin !== undefined ? c.user?.login === botLogin : false),
      );
      if (found) {
        commentId = found.id;
        break;
      }

      // A page shorter than the requested size means this is the last page.
      if (comments.length < COMMENT_PAGE_SIZE) {
        break;
      }
    }

    if (commentId !== undefined) {
      let editRes: GiteaResponse;
      try {
        editRes = this.client.request({
          method: "PATCH",
          path: `/${this.repoPath}/issues/comments/${commentId}`,
          body: { body },
        });
      } catch (err) {
        return { ok: false, error: `gitea edit comment failed: ${errMessage(err)}` };
      }
      if (!ok(editRes.status)) {
        if (editRes.status === 429 || editRes.status >= 500) {
          // Transient failure — propagate as error so the outbox retries on the next
          // dispatch instead of posting a duplicate sticky comment.
          return { ok: false, error: `gitea edit comment failed (HTTP ${editRes.status}): ${editRes.body.slice(0, 200)}` };
        }
        // Permanent failure (e.g. 403 Forbidden — token cannot edit this comment).
        // Fall back to creating a new comment rather than leaving the outbox entry pending forever.
        return this.commentPullRequest(String(prNumber), body);
      }
      return { ok: true };
    }

    return this.commentPullRequest(String(prNumber), body);
  }
}

/** A 2xx response status. */
function ok(status: number): boolean {
  return status >= 200 && status < 300;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Map a Gitea PullRequest JSON object to the provider-neutral {@link PullRequest}.
 *
 * Mergeability degrades deliberately because Gitea lacks GitHub's richer fields:
 *
 *  - `mergeable` (string) is derived from Gitea's single boolean `mergeable`:
 *    `true` → `"MERGEABLE"`, `false` → `"CONFLICTING"`, absent → `"UNKNOWN"`.
 *  - `mergeStateStatus` is **never set**: Gitea has no equivalent of GitHub's
 *    merge-state status (CLEAN/DIRTY/BLOCKED/…), so the field stays absent rather
 *    than being faked.
 *
 * This keeps the existing consumers safe-by-default. The review merge gate
 * promotes only on a confirmed `"MERGEABLE"`, so an `"UNKNOWN"` (Gitea could not
 * compute mergeability) fails closed to a human rather than auto-merging, and a
 * `"CONFLICTING"` routes to conflict resolution exactly as on GitHub. Note that
 * Gitea's boolean conflates a true content conflict with a policy block (e.g.
 * required reviews), so a `"CONFLICTING"` from Gitea is a conservative "not
 * cleanly mergeable" signal, not a guaranteed textual conflict.
 */
function mapPullRequest(pr: GiteaPullRequestJson): PullRequest {
  return {
    number: typeof pr.number === "number" ? pr.number : 0,
    url: pr.html_url ?? pr.url ?? "",
    headRefName: pr.head?.ref ?? "",
    ...(pr.state !== undefined ? { state: pr.state } : {}),
    ...(pr.base?.ref !== undefined ? { baseRefName: pr.base.ref } : {}),
    mergeable: mapMergeable(pr.mergeable),
    ...mapCrossRepository(pr),
  };
}

/**
 * Derive the provider-neutral `isCrossRepository` flag by comparing the head and
 * base repositories. A forked head lives in a different repo than the base, so its
 * `full_name` differs. Only emit the flag when BOTH repo identities are present:
 * an older/partial Gitea payload that omits `head.repo`/`base.repo` leaves the flag
 * absent (treated as "not a fork") rather than guessing, mirroring GitHub's
 * absent-when-not-queried contract.
 */
function mapCrossRepository(pr: GiteaPullRequestJson): { isCrossRepository?: boolean } {
  const headRepo = pr.head?.repo?.full_name;
  const baseRepo = pr.base?.repo?.full_name;
  if (headRepo === undefined || baseRepo === undefined) return {};
  return { isCrossRepository: headRepo !== baseRepo };
}

/** Degrade Gitea's boolean `mergeable` onto the provider-neutral enum. */
function mapMergeable(mergeable: boolean | undefined): string {
  if (mergeable === true) return "MERGEABLE";
  if (mergeable === false) return "CONFLICTING";
  return "UNKNOWN";
}
