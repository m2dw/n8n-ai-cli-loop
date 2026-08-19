import type { GhRunner } from "./gh-runner.js";
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

// ---------------------------------------------------------------------------
// GitHub `gh`-backed work-item provider
//
// Wraps the current GitHub Issues behavior behind the WorkItemProvider
// interface: issue listing, label reads, `blocked by` dependency relationships,
// comments, and coarse-state (label) transitions. The exact `gh` argv is
// preserved so existing behavior is unchanged.
// ---------------------------------------------------------------------------

/** The GraphQL query used to read `blocked by` relationships, paginated. */
const BLOCKED_BY_QUERY = `
      query IssueBlockedBy($owner: String!, $name: String!, $number: Int!, $after: String) {
        repository(owner: $owner, name: $name) {
          issue(number: $number) {
            blockedBy(first: 50, after: $after) {
              nodes {
                number
                state
                stateReason
              }
              pageInfo {
                hasNextPage
                endCursor
              }
            }
          }
        }
      }
    `;

/**
 * The same read in the other direction: the Issues this one blocks (issue #791
 * review). `blocking` is the documented counterpart of `blockedBy` on GitHub's
 * Issue type, and like the dependency REST paths below it is a PIN — it cannot
 * be exercised against the live API from this repository, so everything that
 * needs an outgoing relationship goes through this one query and the injectable
 * runner, and a correction is a change here and nowhere else.
 */
const BLOCKING_QUERY = `
      query IssueBlocking($owner: String!, $name: String!, $number: Int!, $after: String) {
        repository(owner: $owner, name: $name) {
          issue(number: $number) {
            blocking(first: 50, after: $after) {
              nodes {
                number
                state
                stateReason
              }
              pageInfo {
                hasNextPage
                endCursor
              }
            }
          }
        }
      }
    `;

export class GhWorkItemProvider implements WorkItemProvider {
  private readonly owner: string;
  private readonly repo: string;

  constructor(
    private readonly runner: GhRunner,
    githubRepo: string,
    private readonly cwd: string,
  ) {
    const slash = githubRepo.indexOf("/");
    if (slash < 0) throw new Error(`Invalid repo format: ${githubRepo}`);
    this.owner = githubRepo.slice(0, slash);
    this.repo = githubRepo.slice(slash + 1);
  }

  private get githubRepo(): string {
    return `${this.owner}/${this.repo}`;
  }

  listCandidateItems(limit: number): WorkItem[] {
    const result = this.runner.run(
      [
        "issue", "list",
        "--repo", this.githubRepo,
        "--state", "open",
        "--limit", String(limit),
        "--json", "number,title,url,labels,body",
      ],
      { cwd: this.cwd },
    );
    if (result.exitCode !== 0) {
      throw new Error(`gh issue list failed (exit ${result.exitCode}): ${(result.stderr || result.stdout).slice(0, 300)}`);
    }
    const raw = JSON.parse(result.stdout) as Array<{
      number: number;
      title: string;
      url: string;
      labels: Array<{ name: string }>;
      body?: string;
    }>;
    return raw.map((i) => ({
      number: i.number,
      title: i.title,
      url: i.url,
      labels: i.labels.map((l) => l.name),
      ...(typeof i.body === "string" ? { body: i.body } : {}),
    }));
  }

  getItem(issueNumber: number): ProviderRead<WorkItemDetails> {
    const result = this.runner.run(
      ["issue", "view", String(issueNumber), "--repo", this.githubRepo, "--json", "labels"],
      { cwd: this.cwd },
    );
    if (result.exitCode !== 0) {
      return { ok: false, error: `gh issue view failed (exit ${result.exitCode}): ${(result.stderr || result.stdout).slice(0, 300)}` };
    }
    let data: { labels: Array<{ name: string }> };
    try {
      data = JSON.parse(result.stdout.trim()) as { labels: Array<{ name: string }> };
    } catch {
      return { ok: false, error: `gh issue view returned non-JSON output: ${result.stdout.slice(0, 200)}` };
    }
    return { ok: true, value: { labels: data.labels.map((l) => l.name) } };
  }

  /**
   * One paginated relationship read, in either direction. Shared by
   * {@link GhWorkItemProvider.getDependencies} and
   * {@link GhWorkItemProvider.getDependents} so both fail closed identically: a
   * non-zero exit, a GraphQL error, a missing issue, and a missing relationship
   * payload all throw rather than read as "no relationships".
   */
  private async readRelationships(
    issueNumber: number,
    field: "blockedBy" | "blocking",
  ): Promise<BlockedByEntry[]> {
    type IssueRelationshipsPage = {
      nodes?: Array<{ number?: number; state?: string; stateReason?: string | null }>;
      pageInfo?: { hasNextPage: boolean; endCursor?: string | null };
    };
    type GraphQLResponse = {
      data?: {
        repository?: { issue?: { blockedBy?: IssueRelationshipsPage; blocking?: IssueRelationshipsPage } };
      };
      errors?: Array<{ message: string }>;
    };

    const allNodes: Array<{ number?: number; state?: string; stateReason?: string | null }> = [];
    let cursor: string | null = null;

    do {
      const args = [
        "api", "graphql",
        "-f", `query=${field === "blockedBy" ? BLOCKED_BY_QUERY : BLOCKING_QUERY}`,
        "-f", `owner=${this.owner}`,
        "-f", `name=${this.repo}`,
        "-F", `number=${issueNumber}`,
      ];
      if (cursor !== null) {
        args.push("-f", `after=${cursor}`);
      }

      const result = this.runner.run(args, { cwd: this.cwd });
      if (result.exitCode !== 0) {
        throw new Error(`gh api graphql failed (exit ${result.exitCode}): ${(result.stderr || result.stdout).slice(0, 300)}`);
      }
      const response = JSON.parse(result.stdout) as GraphQLResponse;

      if (response.errors?.length) {
        throw new Error(`GraphQL error: ${response.errors.map((e) => e.message).join("; ")}`);
      }

      const issueNode = response.data?.repository?.issue;
      if (!issueNode) {
        throw new Error(`gh api graphql: issue #${issueNumber} not found or inaccessible (repository.issue is null)`);
      }
      const rel = issueNode[field];
      if (!rel) {
        throw new Error(`gh api graphql: missing ${field} payload for issue #${issueNumber}`);
      }
      allNodes.push(...(rel.nodes ?? []));

      const pageInfo = rel.pageInfo;
      cursor = pageInfo?.hasNextPage ? (pageInfo.endCursor ?? null) : null;
    } while (cursor !== null);

    return allNodes
      .map((n) => {
        if (typeof n.number !== "number") return null;
        const state = n.state?.toUpperCase() === "CLOSED" ? "closed" : "open";
        const entry: BlockedByEntry = { issueNumber: n.number, state };
        if (state === "closed" && n.stateReason !== undefined) {
          const r = n.stateReason?.toLowerCase();
          entry.stateReason =
            r === "not_planned" ? "not_planned" : r === "completed" ? "completed" : null;
        }
        return entry;
      })
      .filter((e): e is BlockedByEntry => e !== null);
  }

  async getDependencies(issueNumber: number): Promise<BlockedByEntry[]> {
    return this.readRelationships(issueNumber, "blockedBy");
  }

  async getDependents(issueNumber: number): Promise<BlockedByEntry[]> {
    return this.readRelationships(issueNumber, "blocking");
  }

  /**
   * The Issue's numeric database id, which the dependency endpoints identify a
   * blocker by (they take an `issue_id`, not the repository-scoped number every
   * other call here uses).
   */
  private issueDatabaseId(issueNumber: number): ProviderRead<number> {
    const result = this.runner.run(
      ["api", `repos/${this.owner}/${this.repo}/issues/${issueNumber}`, "--jq", ".id"],
      { cwd: this.cwd },
    );
    if (result.exitCode !== 0) {
      return {
        ok: false,
        error: `gh api issue:read failed for #${issueNumber} (exit ${result.exitCode}): ${(result.stderr || result.stdout).slice(0, 200)}`,
      };
    }
    const id = Number(result.stdout.trim());
    if (!Number.isInteger(id) || id <= 0) {
      return { ok: false, error: `gh api issue:read returned no usable id for #${issueNumber}: ${result.stdout.slice(0, 100)}` };
    }
    return { ok: true, value: id };
  }

  /**
   * GitHub's Issue-dependency endpoints, used by both mutations below:
   *
   *   POST   repos/{o}/{r}/issues/{n}/dependencies/blocked_by  {issue_id}
   *   DELETE repos/{o}/{r}/issues/{n}/dependencies/blocked_by/{issue_id}
   *
   * The paths and the `issue_id` (database id, not Issue number) parameter are
   * a PIN: they match GitHub's documented Issue-dependency REST API, and there
   * is no way to exercise the live endpoints from this repository's test
   * environment. Everything that depends on them is therefore routed through
   * these two methods and the injectable {@link GhRunner}, so a correction is a
   * change to the argv built here and nothing else.
   *
   * `alreadyThere` marks the status code the endpoint answers with when the
   * requested end state already holds; it is mapped to `changed: false` rather
   * than an error, which is what makes a retry of a half-applied chain edit
   * converge instead of failing on the steps that already landed.
   */
  private async mutateDependency(
    blockedIssueNumber: number,
    blockerIssueNumber: number,
    mode: "add" | "remove",
  ): Promise<DependencyMutationResult> {
    const id = this.issueDatabaseId(blockerIssueNumber);
    if (!id.ok) return { ok: false, error: id.error };
    const base = `repos/${this.owner}/${this.repo}/issues/${blockedIssueNumber}/dependencies/blocked_by`;
    const args =
      mode === "add"
        ? ["api", base, "--method", "POST", "-F", `issue_id=${id.value}`]
        : ["api", `${base}/${id.value}`, "--method", "DELETE"];
    const result = this.runner.run(args, { cwd: this.cwd });
    if (result.exitCode === 0) return { ok: true, changed: true };
    const detail = result.stderr || result.stdout;
    // A duplicate add (422) and a removal of a relationship that is already
    // gone (404) both mean the tracker already holds the requested end state.
    const alreadyThere = mode === "add" ? "422" : "404";
    if (detail.includes(alreadyThere)) return { ok: true, changed: false };
    return {
      ok: false,
      error: `gh api dependency:${mode} failed for #${blockedIssueNumber} blocked by #${blockerIssueNumber} (exit ${result.exitCode}): ${detail.slice(0, 200)}`,
    };
  }

  async addDependency(blockedIssueNumber: number, blockerIssueNumber: number): Promise<DependencyMutationResult> {
    return this.mutateDependency(blockedIssueNumber, blockerIssueNumber, "add");
  }

  async removeDependency(blockedIssueNumber: number, blockerIssueNumber: number): Promise<DependencyMutationResult> {
    return this.mutateDependency(blockedIssueNumber, blockerIssueNumber, "remove");
  }

  /**
   * Scan the Issue's comment history for `marker` (issue #936).
   *
   * Paginated by hand rather than with `--paginate`, mirroring the sticky
   * PR-comment scan: page-by-page lets the walk stop at the first match instead
   * of downloading the whole history for an Issue whose notice is already there.
   * The scan covers the FULL history — the gap between a delivered POST and the
   * `markSent` that records it can be hours wide after a crash, and any number
   * of newer comments can land in between, so a bounded most-recent window would
   * report the delivery as absent and duplicate it (the same reasoning as
   * `REFINEMENT_COMMENT_SCAN_ALL` in core/issue-refinement-apply.ts).
   * `MAX_PAGES` is a runaway guard only; exceeding it is reported as a failure,
   * never as "not found", because the caller uses this as a precondition.
   */
  hasItemCommentWithMarker(issueNumber: number, marker: string): ProviderRead<boolean> {
    const PER_PAGE = 100;
    const MAX_PAGES = 100;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const result = this.runner.run(
        [
          "api",
          "--method", "GET",
          `repos/${this.owner}/${this.repo}/issues/${issueNumber}/comments`,
          "--field", `per_page=${PER_PAGE}`,
          "--field", `page=${page}`,
        ],
        { cwd: this.cwd },
      );
      if (result.exitCode !== 0) {
        return {
          ok: false,
          error: `gh api list comments (page ${page}) failed (exit ${result.exitCode}): ${(result.stderr || result.stdout).slice(0, 200)}`,
        };
      }
      let comments: Array<{ body?: unknown }>;
      try {
        comments = JSON.parse(result.stdout) as Array<{ body?: unknown }>;
      } catch {
        return { ok: false, error: `gh api list comments (page ${page}) returned non-JSON output` };
      }
      if (!Array.isArray(comments)) {
        return { ok: false, error: `gh api list comments (page ${page}) returned a non-array payload` };
      }
      if (comments.some((c) => typeof c.body === "string" && c.body.includes(marker))) {
        return { ok: true, value: true };
      }
      if (comments.length < PER_PAGE) return { ok: true, value: false };
    }
    return {
      ok: false,
      error: `gh api list comments exceeded ${MAX_PAGES} pages for #${issueNumber}; comment history not fully scanned`,
    };
  }

  commentItem(issueNumber: number, body: string): ProviderResult {
    const result = this.runner.run(
      [
        "api",
        `repos/${this.owner}/${this.repo}/issues/${issueNumber}/comments`,
        "--method", "POST",
        "--field", `body=${body}`,
      ],
      { cwd: this.cwd },
    );
    if (result.exitCode !== 0) {
      return { ok: false, error: `gh api comment failed (exit ${result.exitCode}): ${(result.stderr || result.stdout).slice(0, 200)}` };
    }
    return { ok: true };
  }

  transitionItem(issueNumber: number, transition: WorkItemTransition): ProviderResult {
    if (transition.kind === "add-label") {
      const result = this.runner.run(
        [
          "api",
          `repos/${this.owner}/${this.repo}/issues/${issueNumber}/labels`,
          "--method", "POST",
          "--field", `labels[]=${transition.label}`,
        ],
        { cwd: this.cwd },
      );
      if (result.exitCode !== 0) {
        return { ok: false, error: `gh api label:add failed (exit ${result.exitCode}): ${(result.stderr || result.stdout).slice(0, 200)}` };
      }
      return { ok: true };
    }

    const result = this.runner.run(
      [
        "api",
        `repos/${this.owner}/${this.repo}/issues/${issueNumber}/labels/${encodeURIComponent(transition.label)}`,
        "--method", "DELETE",
      ],
      { cwd: this.cwd },
    );
    // 404 is acceptable for remove (label already absent) but is reported via
    // `alreadyAbsent` rather than folded into a plain `ok: true` (issue #787
    // review): callers that must attribute a removal to THIS call — never to
    // a label that was already gone — need to tell the two apart.
    if (result.exitCode !== 0) {
      if (result.stderr.includes("404")) return { ok: true, alreadyAbsent: true };
      return { ok: false, error: `gh api label:remove failed (exit ${result.exitCode}): ${(result.stderr || result.stdout).slice(0, 200)}` };
    }
    return { ok: true };
  }
}
