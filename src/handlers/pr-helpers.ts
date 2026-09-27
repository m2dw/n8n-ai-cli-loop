import type { AiTask } from "../core/task.js";
import type { RepoHostProvider } from "../providers/types.js";
import {
  reconcileExistingPullRequest,
  type PrReconciliationExpectation,
  type PrReconciliationRefusal,
} from "../core/pr-reconciliation.js";
// The branch-naming convention and the two task-context readers are pure and
// are also needed by `core/` modules, so they live in `core/pr-context.ts`
// (see its header) and are re-exported here unchanged for this module's
// existing importers.
import { branchName, extractPrNumber, resolvePrContext } from "../core/pr-context.js";

export { branchName, extractPrNumber, resolvePrContext } from "../core/pr-context.js";

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

// Outcome of trying to adopt an already-created PR after `createPullRequest`
// refused (issue #998). `refused` carries the reason so callers can report why
// the live PR was not usable instead of only that creation failed.
export type AdoptExistingPrResult =
  | { kind: "adopted"; url: string; headRefName: string; number?: number }
  | { kind: "refused"; reason: PrReconciliationRefusal | "lookup-failed"; error: string };

// Resolve the pull request an interrupted earlier run may already have opened
// for `expected.head`, and decide whether this run may adopt it (issue #998).
//
// The order matters and is the whole point: creation is attempted first and this
// runs only on its failure, so the normal path — no PR yet — is untouched and
// costs no extra call. The failure is then answered with PROVIDER DATA rather
// than with the CLI's error prose: any create failure triggers the same
// exact-head lookup, and a failure that was NOT "already exists" simply finds no
// PR and falls through to the original error. Nothing here reads, matches, or
// depends on the wording of the host's message.
//
// A lookup that cannot be read is a refusal, never a "no PR exists": inferring
// absence from a transient failure is what would create the duplicate PR.
export function adoptExistingPrForHead(
  host: RepoHostProvider,
  expected: PrReconciliationExpectation,
): AdoptExistingPrResult {
  const listed = host.findOpenPullRequestsByHead(expected.head);
  if (!listed.ok) {
    return {
      kind: "refused",
      reason: "lookup-failed",
      error: `could not list open pull requests for head "${expected.head}": ${listed.error}`,
    };
  }

  const decision = reconcileExistingPullRequest(listed.value, expected);
  if (decision.kind === "adopt") {
    return {
      kind: "adopted",
      url: decision.url,
      headRefName: decision.headRefName,
      ...(decision.number !== undefined ? { number: decision.number } : {}),
    };
  }
  return { kind: "refused", reason: decision.reason, error: decision.message };
}
