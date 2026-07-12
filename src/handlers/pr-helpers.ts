import type { AiTask } from "../core/task.js";
import type { RepoHostProvider } from "../providers/types.js";

export interface PrInfo {
  url: string;
  headRefName: string;
  /**
   * True when the PR head lives on a fork (a different repo than the base), so its
   * head is not an `origin` branch. Carried from the provider so worktree fix
   * routing can refuse a forked head rather than push it to origin by branch name
   * (issue #456 review). Absent → not a fork (the conventional same-repo case).
   */
  isCrossRepository?: boolean;
}

export function branchName(issueNumber: number): string {
  return `ai/issue-${issueNumber}`;
}

export function resolvePrContext(task: AiTask): { prUrl?: string; branch?: string } {
  const ctx = task.context as Record<string, unknown>;
  return {
    prUrl: typeof ctx.prUrl === "string" ? ctx.prUrl : undefined,
    branch: typeof ctx.branch === "string" ? ctx.branch : undefined,
  };
}

// Distinguishes a successful "no open PR exists" result (a state callers may
// legitimately hand off) from a `gh`/parse failure (a transient or operator
// problem). Callers like conflict-resolution must not treat a flaky GitHub CLI
// call as if no PR exists.
export type FindOpenPrError =
  | { error: string; kind: "not-found" }
  | { error: string; kind: "lookup-failed" };

export function findOpenPr(
  // The session's resolved repo-host provider (GitHub or Gitea). The head-branch
  // convention is owned by the provider, so this lookup is backend-agnostic.
  host: RepoHostProvider,
  issueNumber: number,
): PrInfo | FindOpenPrError {
  const result = host.findPullRequestForWorkItem(issueNumber);

  if (result.kind === "failed") {
    return { error: result.error, kind: "lookup-failed" };
  }

  if (result.kind === "none") {
    return {
      error: `No open PR found for issue #${issueNumber} (expected head branch: ${branchName(issueNumber)}). ` +
        `Cannot apply fix — create a PR first via status:needs-implementation.`,
      kind: "not-found",
    };
  }

  return {
    url: result.pullRequest.url,
    headRefName: result.pullRequest.headRefName,
    isCrossRepository: result.pullRequest.isCrossRepository,
  };
}

// Resolve the open PR to edit in fix mode, supporting PR heads that do NOT follow
// the conventional `ai/issue-<n>` naming (issue #455).
//
// `findOpenPr` discovers a PR strictly by the head-branch convention
// (`findPullRequestForWorkItem` lists `--head ai/issue-<n>`), so an
// externally-created PR whose head is e.g. `feature/custom` is reported as
// `not-found` even though a real PR exists. The review handoff records that PR's
// identity (`prUrl` / `branch`) in the task context, so when the conventional
// lookup finds nothing we resolve the recorded selector through the provider's
// by-selector read (`getPullRequest`), which matches any head name.
//
// The conventional lookup stays primary: a conventional PR keeps its exact prior
// behavior (including the `--state open` filter), and a genuine lookup failure
// fails closed instead of silently falling back to a possibly-stale recorded
// branch.
export function resolveFixPr(
  host: RepoHostProvider,
  task: AiTask,
  issueNumber: number,
): PrInfo | FindOpenPrError {
  const conventional = findOpenPr(host, issueNumber);
  // Found, or a real lookup failure (transient gh/parse error) — return as-is.
  // Only a clean `not-found` warrants the non-conventional fallback below.
  if (!("error" in conventional) || conventional.kind === "lookup-failed") {
    return conventional;
  }

  // No PR on the conventional head. Resolve from the PR identity recorded in the
  // task context. Prefer a provider-neutral selector: extract the PR NUMBER from
  // the recorded URL rather than passing the raw URL (issue #455 review). Gitea's
  // `getPullRequest` builds `/pulls/${selector}`, so a full PR URL never resolves
  // there; the bare number does, and `gh` accepts it too. Fall back to the raw URL
  // only when the number cannot be parsed (preserving prior GitHub behavior), then
  // to a recorded branch — but only when it is non-conventional (a conventional
  // branch would just re-resolve the same not-found PR).
  const { prUrl, branch } = resolvePrContext(task);
  const prNumber = prUrl !== undefined ? extractPrNumber(prUrl) : undefined;
  const recordedSelector =
    prNumber !== undefined
      ? String(prNumber)
      : (prUrl ?? (branch !== undefined && branch !== branchName(issueNumber) ? branch : undefined));
  if (recordedSelector === undefined) {
    return conventional;
  }

  const read = host.getPullRequest(recordedSelector);
  if (!read.ok) {
    return { error: read.error, kind: "lookup-failed" };
  }
  // Mirror the conventional lookup's `--state open` filter (issue #455 review):
  // `getPullRequest` resolves a PR in ANY state, so a recorded URL pointing at a
  // closed/merged non-conventional PR would otherwise be adopted as the active fix
  // target and pushed to. Reject a non-open PR exactly as the conventional path
  // reports `not-found`. State is absent only when a provider/mock does not report
  // it; treat that leniently so behavior degrades to the prior (URL-only) path.
  if (read.value.state !== undefined && read.value.state.toLowerCase() !== "open") {
    return {
      error: `Recorded PR for issue #${issueNumber} (selector: ${recordedSelector}) is ${read.value.state.toLowerCase()}, not open. ` +
        `Cannot apply fix — reopen the PR or create one via status:needs-implementation.`,
      kind: "not-found",
    };
  }
  return {
    url: read.value.url,
    headRefName: read.value.headRefName,
    isCrossRepository: read.value.isCrossRepository,
  };
}

// Extract a PR number from a GitHub (`/pull/<n>`) or Gitea (`/pulls/<n>`) URL.
// Mirrors the extraction other callers (outbox-effects, conflict-resolution) apply
// to `task.context.prUrl` so the selector handed to a provider is backend-neutral.
export function extractPrNumber(prUrl: string): number | undefined {
  const m = prUrl.match(/\/pulls?\/(\d+)/);
  return m ? parseInt(m[1], 10) : undefined;
}
