import type { GhRunner } from "./gh-runner.js";
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
// GitHub `gh`-backed repository-host provider
//
// Wraps the current `gh pr` behavior behind the RepoHostProvider interface so
// handlers route PR operations through the seam instead of building `gh` argv
// themselves. The exact argv is preserved so existing behavior is unchanged.
//
// The head-branch convention (`ai/issue-<n>`) is owned here: callers ask for the
// PR of a work item, not of a branch.
// ---------------------------------------------------------------------------

/** Fields requested for a PR read — the superset all callers consume. */
const PR_FIELDS = "number,url,headRefName,state,baseRefName,mergeable,mergeStateStatus,isCrossRepository";

export class GhRepoHostProvider implements RepoHostProvider {
  constructor(
    private readonly runner: GhRunner,
    private readonly githubRepo: string,
    private readonly cwd: string,
  ) {}

  findPullRequestForWorkItem(issueNumber: number): FindPullRequestResult {
    const head = branchName(issueNumber);
    const result = this.runner.run(
      [
        "pr", "list",
        "--repo", this.githubRepo,
        "--head", head,
        "--state", "open",
        "--json", PR_FIELDS,
        "--limit", "1",
      ],
      { cwd: this.cwd },
    );

    if (result.exitCode !== 0) {
      return {
        kind: "failed",
        error: `gh pr list failed (exit ${result.exitCode}): ${(result.stderr || result.stdout).slice(0, 300)}`,
      };
    }

    let prs: PullRequest[];
    try {
      prs = JSON.parse(result.stdout.trim()) as PullRequest[];
    } catch {
      return { kind: "failed", error: `gh pr list returned non-JSON output: ${result.stdout.slice(0, 200)}` };
    }

    if (prs.length === 0) {
      return { kind: "none" };
    }

    return { kind: "found", pullRequest: prs[0] };
  }

  createPullRequest(input: CreatePullRequestInput): ProviderRead<PullRequest> {
    const result = this.runner.run(
      [
        "pr", "create",
        "--repo", this.githubRepo,
        "--title", input.title,
        "--body", input.body,
        "--head", input.head,
        "--base", input.base,
      ],
      { cwd: this.cwd },
    );

    if (result.exitCode !== 0) {
      return {
        ok: false,
        error: `gh pr create failed (exit ${result.exitCode}): ${(result.stderr || result.stdout).slice(0, 300)}`,
      };
    }

    // `gh pr create` prints the created PR URL. Derive the PR number from it; the
    // head/base are the inputs we just opened against. No extra `gh` call.
    const url = result.stdout.trim();
    const numberMatch = url.match(/\/pull\/(\d+)/);
    return {
      ok: true,
      value: {
        number: numberMatch ? parseInt(numberMatch[1], 10) : 0,
        url,
        headRefName: input.head,
        baseRefName: input.base,
      },
    };
  }

  getPullRequest(selector: string): ProviderRead<PullRequest> {
    const result = this.runner.run(
      ["pr", "view", selector, "--repo", this.githubRepo, "--json", PR_FIELDS],
      { cwd: this.cwd },
    );

    if (result.exitCode !== 0) {
      return {
        ok: false,
        error: `gh pr view failed (exit ${result.exitCode}): ${(result.stderr || result.stdout).slice(0, 300)}`,
      };
    }

    let pr: PullRequest;
    try {
      pr = JSON.parse(result.stdout.trim()) as PullRequest;
    } catch {
      return { ok: false, error: `gh pr view returned non-JSON output: ${result.stdout.slice(0, 200)}` };
    }

    return { ok: true, value: pr };
  }

  commentPullRequest(selector: string, body: string): ProviderResult {
    const result = this.runner.run(
      ["pr", "comment", selector, "--repo", this.githubRepo, "--body", body],
      { cwd: this.cwd },
    );

    if (result.exitCode !== 0) {
      return {
        ok: false,
        error: `gh pr comment failed (exit ${result.exitCode}): ${(result.stderr || result.stdout).slice(0, 300)}`,
      };
    }

    return { ok: true };
  }

  upsertStickyPrComment(prNumber: number, marker: string, body: string): ProviderResult {
    // Resolve the authenticated identity so we only edit comments we own.
    // An unowned comment containing the marker must not be PATCHed — GitHub rejects
    // edits to comments authored by other users, causing the outbox entry to fail
    // permanently. When botLogin is resolved, we match by exact login. When it is
    // unavailable (GitHub App installation tokens return no user login from /user),
    // we fall back to matching Bot-typed comments — see the find() predicate below.
    let botLogin: string | undefined;
    const whoamiResult = this.runner.run(["api", "/user"], { cwd: this.cwd });
    if (whoamiResult.exitCode === 0) {
      try {
        const user = JSON.parse(whoamiResult.stdout) as { login?: string };
        botLogin = typeof user.login === "string" ? user.login : undefined;
      } catch {
        // Parse failure — treat as unknown identity, will create a fresh comment.
      }
    }

    // Paginate through all PR/issue comments to locate the sticky one by marker.
    // GitHub PRs share the comment thread with issues, accessible at the issues endpoint.
    // Without pagination a sticky comment beyond page 1 would be missed and duplicated.
    let commentId: number | undefined;
    // When botLogin is unknown (GitHub App installation tokens), collect ALL Bot-typed
    // marker comments across all pages. We try them newest-first (reverse order) so that
    // our own sticky comment — created on a prior run after an ownership failure —
    // is reached before any older foreign-bot comment. Stopping at the first Bot-typed
    // comment would re-hit the foreign bot's comment every run and spam new copies.
    const botTypeCandidateIds: number[] = [];
    const PER_PAGE = 100;
    for (let page = 1; ; page++) {
      const listResult = this.runner.run(
        [
          "api",
          "--method", "GET",
          `repos/${this.githubRepo}/issues/${prNumber}/comments`,
          "--field", `per_page=${PER_PAGE}`,
          "--field", `page=${page}`,
        ],
        { cwd: this.cwd },
      );
      if (listResult.exitCode !== 0) {
        return {
          ok: false,
          error: `gh api list comments (page ${page}) failed (exit ${listResult.exitCode}): ${(listResult.stderr || listResult.stdout).slice(0, 200)}`,
        };
      }

      let comments: Array<{ id: number; body: string; user?: { login?: string; type?: string } }> = [];
      try {
        comments = JSON.parse(listResult.stdout) as Array<{ id: number; body: string; user?: { login?: string; type?: string } }>;
      } catch {
        // Ignore JSON parse errors — fall through to create a new comment.
        break;
      }

      if (botLogin !== undefined) {
        // Exact login known — take the first owned marker comment and stop scanning.
        const found = comments.find(
          (c) => typeof c.body === "string" && c.body.includes(marker) && c.user?.login === botLogin,
        );
        if (found) {
          commentId = found.id;
          break;
        }
      } else {
        // Bot-type fallback (GitHub App installation tokens carry no user login).
        // Collect every Bot-authored marker comment; we'll try them all after scanning.
        for (const c of comments) {
          if (typeof c.body === "string" && c.body.includes(marker) && c.user?.type === "Bot") {
            botTypeCandidateIds.push(c.id);
          }
        }
      }

      // If this page returned fewer than PER_PAGE entries there are no more pages.
      if (comments.length < PER_PAGE) break;
    }

    if (commentId !== undefined) {
      // Exact login match — PATCH directly; ownership is guaranteed, no fallback needed.
      const editResult = this.runner.run(
        [
          "api",
          `repos/${this.githubRepo}/issues/comments/${commentId}`,
          "--method", "PATCH",
          "-f", `body=${body}`,
        ],
        { cwd: this.cwd },
      );
      if (editResult.exitCode !== 0) {
        return {
          ok: false,
          error: `gh api edit comment ${commentId} failed (exit ${editResult.exitCode}): ${(editResult.stderr || editResult.stdout).slice(0, 200)}`,
        };
      }
      return { ok: true };
    }

    if (botTypeCandidateIds.length > 0) {
      // Bot-type fallback: try candidates newest-first (reverse chronological order).
      // Our own sticky comment — if created on a prior run — is newer than any
      // pre-existing foreign-bot comment, so iterating in reverse finds it first
      // and avoids re-PATCHing (and 403/404-failing on) the foreign-bot comment.
      for (let i = botTypeCandidateIds.length - 1; i >= 0; i--) {
        const candidateId = botTypeCandidateIds[i];
        const editResult = this.runner.run(
          [
            "api",
            `repos/${this.githubRepo}/issues/comments/${candidateId}`,
            "--method", "PATCH",
            "-f", `body=${body}`,
          ],
          { cwd: this.cwd },
        );
        if (editResult.exitCode === 0) return { ok: true };
        const errText = editResult.stderr || editResult.stdout;
        const isOwnershipFailure = /\b(403|404)\b/.test(errText);
        if (!isOwnershipFailure) {
          // Transient error (429, 5xx) — return error so the outbox row stays
          // pending and the dispatcher can retry without creating a duplicate.
          return {
            ok: false,
            error: `gh api edit comment ${candidateId} failed (exit ${editResult.exitCode}): ${errText.slice(0, 200)}`,
          };
        }
        // Ownership failure — this comment belongs to a different bot; try the next candidate.
      }
      // All candidates failed with ownership errors — create a fresh sticky comment.
      return this.commentPullRequest(String(prNumber), body);
    }

    return this.commentPullRequest(String(prNumber), body);
  }
}
