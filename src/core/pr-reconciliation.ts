// ---------------------------------------------------------------------------
// Post-create pull-request reconciliation (issue #998)
//
// PR creation is an external side effect; recording `prUrl`/`branch` in task
// context is a separate, later boundary. A run that is interrupted between the
// two leaves the world in a state the retry has to tolerate: the PR exists on
// the repo host, but nothing local remembers it. The retry reaches
// `createPullRequest` again and the host refuses — "a pull request for branch
// ... already exists" — which the handler used to surface as a terminal
// failure, permanently stranding the task (issue #975 / PR #997).
//
// This module owns the DECISION half of the recovery: given the open pull
// requests the repo host reports for the exact expected head branch, may this
// run adopt one as its own and continue through the normal success transition?
// It is deliberately pure and provider-neutral:
//
//   - The evidence is provider DATA (`state`, `headRefName`, `baseRefName`,
//     `isCrossRepository`, `url`), never the human-facing text of a failed
//     `gh pr create`. Error prose is not a contract; a locale change or a CLI
//     rewording must not decide whether a PR is adopted.
//   - Every check fails CLOSED. Adopting the wrong PR means a run's commits are
//     reported under someone else's review, so anything short of one
//     unambiguous, open, same-repository PR on the expected head into the
//     configured base is refused with an actionable reason.
//   - Absent fields are refusals, not passes. A provider that did not report
//     `state` or `baseRefName` has not confirmed the PR is open or correctly
//     targeted, and "not confirmed" is exactly the case this module exists to
//     stop.
// ---------------------------------------------------------------------------

/**
 * The pull-request fields the decision reads.
 *
 * Structurally satisfied by the providers' `PullRequest` (every field there is
 * either present or optional), but declared here so the Orchestration layer
 * keeps depending on nothing.
 */
export interface ReconcilablePullRequest {
  number?: number;
  url?: string;
  headRefName?: string;
  /** Provider state string ("OPEN"/"open"/"CLOSED"/"MERGED"/...). */
  state?: string;
  baseRefName?: string;
  isCrossRepository?: boolean;
}

/** What this run believes it just tried to open. */
export interface PrReconciliationExpectation {
  issueNumber: number;
  /** The exact head branch this run pushed and opened the PR from. */
  head: string;
  /** The configured base branch the PR must target. */
  base: string;
  /** The configured repository slug (`owner/name`). */
  repo: string;
}

/**
 * Why an adoption was refused. Every value is a fail-closed outcome: the caller
 * reports the original creation failure and stops rather than continuing.
 */
export type PrReconciliationRefusal =
  | "no-match"
  | "ambiguous"
  | "head-mismatch"
  | "not-open"
  | "cross-repository"
  | "repository-mismatch"
  | "base-mismatch"
  | "unusable-url";

export type PrReconciliationDecision =
  | { kind: "adopt"; url: string; headRefName: string; number?: number }
  | { kind: "refuse"; reason: PrReconciliationRefusal; message: string };

/**
 * Decide whether one of `candidates` is the pull request this run already
 * created before it lost its task state.
 *
 * `candidates` are the OPEN pull requests the repo host reports for
 * `expected.head` in the configured repository. They are re-validated here
 * rather than trusted: the query is a filter, the decision is the gate.
 */
export function reconcileExistingPullRequest(
  candidates: readonly ReconcilablePullRequest[],
  expected: PrReconciliationExpectation,
): PrReconciliationDecision {
  const subject = `issue #${expected.issueNumber} (expected head "${expected.head}" into "${expected.base}" on ${expected.repo})`;

  if (candidates.length === 0) {
    return {
      kind: "refuse",
      reason: "no-match",
      message: `no open pull request exists for ${subject}`,
    };
  }

  // More than one open PR on a single head is not a state this run can resolve:
  // adopting either would attribute this branch's commits to a PR chosen at
  // random. An operator has to close the duplicate first.
  if (candidates.length > 1) {
    const urls = candidates.map((pr) => pr.url ?? "<no url>").join(", ");
    return {
      kind: "refuse",
      reason: "ambiguous",
      message:
        `${candidates.length} open pull requests match ${subject}: ${urls}. ` +
        `Close the duplicates so exactly one remains, then retry.`,
    };
  }

  const pr = candidates[0];

  // The head is the identity claim — a PR on a different branch is a different
  // PR, whatever the query returned.
  const headRefName = pr.headRefName;
  if (headRefName === undefined || headRefName !== expected.head) {
    return {
      kind: "refuse",
      reason: "head-mismatch",
      message:
        `pull request ${describe(pr)} has head "${headRefName ?? "<unreported>"}", not the expected "${expected.head}" for ${subject}`,
    };
  }

  // Absent state is not "probably open": the host never confirmed it.
  if (pr.state === undefined || pr.state.toLowerCase() !== "open") {
    return {
      kind: "refuse",
      reason: "not-open",
      message:
        `pull request ${describe(pr)} for ${subject} is ${pr.state === undefined ? "of unconfirmed state" : pr.state.toLowerCase()}, not open. ` +
        `Reopen it or delete the branch so a fresh pull request can be created.`,
    };
  }

  // A confirmed fork head is not this run's `origin` branch, so its commits are
  // not the ones this run pushed.
  if (pr.isCrossRepository === true) {
    return {
      kind: "refuse",
      reason: "cross-repository",
      message:
        `pull request ${describe(pr)} for ${subject} has a head in a different repository (fork) and cannot be adopted`,
    };
  }

  const url = typeof pr.url === "string" ? pr.url.trim() : "";
  if (url.length === 0) {
    return {
      kind: "refuse",
      reason: "unusable-url",
      message: `the open pull request matching ${subject} reported no URL, so it cannot be recorded`,
    };
  }

  const urlRepo = repoSlugFromPrUrl(url);
  if (urlRepo === undefined) {
    return {
      kind: "refuse",
      reason: "unusable-url",
      message: `the open pull request matching ${subject} reported an unrecognizable URL (${url})`,
    };
  }
  if (urlRepo.toLowerCase() !== expected.repo.toLowerCase()) {
    return {
      kind: "refuse",
      reason: "repository-mismatch",
      message:
        `pull request ${url} belongs to repository ${urlRepo}, not the configured ${expected.repo} for ${subject}`,
    };
  }

  // Base last: it is the check most likely to be a real, human-fixable
  // mismatch (a PR opened against the wrong target), so its message is the one
  // worth surfacing once identity and repository are established.
  if (pr.baseRefName === undefined || pr.baseRefName !== expected.base) {
    return {
      kind: "refuse",
      reason: "base-mismatch",
      message:
        `pull request ${url} targets base "${pr.baseRefName ?? "<unreported>"}", not the configured "${expected.base}" for ${subject}. ` +
        `Retarget it to "${expected.base}" and retry.`,
    };
  }

  return {
    kind: "adopt",
    url,
    headRefName,
    ...(typeof pr.number === "number" && pr.number > 0 ? { number: pr.number } : {}),
  };
}

/**
 * The `owner/name` slug a PR URL points at, for both GitHub (`/pull/<n>`) and
 * Gitea (`/pulls/<n>`) shapes. `undefined` when the URL is not a PR URL — which
 * callers treat as a refusal, never as a match.
 */
export function repoSlugFromPrUrl(prUrl: string): string | undefined {
  const m = prUrl.match(/\/([^/\s]+)\/([^/\s]+)\/pulls?\/\d+/);
  return m ? `${m[1]}/${m[2]}` : undefined;
}

function describe(pr: ReconcilablePullRequest): string {
  if (typeof pr.url === "string" && pr.url.trim().length > 0) return pr.url.trim();
  if (typeof pr.number === "number" && pr.number > 0) return `#${pr.number}`;
  return "<unidentified>";
}
