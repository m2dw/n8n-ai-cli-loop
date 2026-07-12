import type { GhRunner } from "./gh-runner.js";
import type { BlockedByEntry } from "../../core/github-intake.js";
import type {
  WorkItemProvider,
  WorkItem,
  WorkItemDetails,
  WorkItemTransition,
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

  async getDependencies(issueNumber: number): Promise<BlockedByEntry[]> {
    type IssueRelationshipsPage = {
      nodes?: Array<{ number?: number; state?: string; stateReason?: string | null }>;
      pageInfo?: { hasNextPage: boolean; endCursor?: string | null };
    };
    type GraphQLResponse = {
      data?: { repository?: { issue?: { blockedBy?: IssueRelationshipsPage } } };
      errors?: Array<{ message: string }>;
    };

    const allNodes: Array<{ number?: number; state?: string; stateReason?: string | null }> = [];
    let cursor: string | null = null;

    do {
      const args = [
        "api", "graphql",
        "-f", `query=${BLOCKED_BY_QUERY}`,
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

      const rel = response.data?.repository?.issue?.blockedBy;
      allNodes.push(...(rel?.nodes ?? []));

      const pageInfo = rel?.pageInfo;
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
    // 404 is acceptable for remove (label already absent).
    if (result.exitCode !== 0 && !result.stderr.includes("404")) {
      return { ok: false, error: `gh api label:remove failed (exit ${result.exitCode}): ${(result.stderr || result.stdout).slice(0, 200)}` };
    }
    return { ok: true };
  }
}
