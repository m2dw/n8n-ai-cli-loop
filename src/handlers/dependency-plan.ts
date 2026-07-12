import type { DependencyChecker, BlockedByEntry } from "../core/github-intake.js";
import type { CommandRunner } from "./command-runner.js";
import { GhRepoHostProvider } from "../providers/github/gh-repo-host-provider.js";
import { GhWorkItemProvider } from "../providers/github/gh-work-item-provider.js";
import { ghRunnerFromCommandRunner } from "../providers/github/gh-runner.js";
import type { GhRunner } from "../providers/github/gh-runner.js";
import type { PullRequest, RepoHostProvider } from "../providers/types.js";

export type DependencyExecutionPlan =
  | { kind: "none" }
  | {
      kind: "ready";
      baseIssueNumber: number;
      basePrNumber: number;
      baseHeadRefName: string;
      basePrUrl: string;
    }
  | {
      kind: "blocked" | "unsupported";
      reason: string;
      /** Unsatisfied blockers — open, or closed as `not_planned`. */
      blockers: BlockedByEntry[];
      /**
       * Full `blocked by` relationship list (open + closed) captured at resolve
       * time. Mirrors the DependencyDecision.blockedBy contract so a blocked
       * recheck can persist a complete audit snapshot, not just the open subset.
       */
      allBlockers: BlockedByEntry[];
    };

type BlockerPrInfo = PullRequest;

/**
 * Resolves whether an issue's `blocked by` relationships have a usable blocker PR
 * for stacked dependency execution.
 *
 * - No unsatisfied blockers (none / all closed as completed) → kind: "none"
 * - Any blocker closed as `not_planned`                     → kind: "unsupported"
 * - One open blocker with usable open PR                    → kind: "ready"
 * - One open blocker, no open PR                            → kind: "blocked"
 * - One open blocker, PR is conflicted/dirty                → kind: "blocked"
 * - Multiple open blockers                                  → kind: "unsupported"
 *
 * A blocker's PR is "usable" when it is open, non-conflicting, and the blocker
 * issue is implementation-complete — signalled by the success-specific stackReady
 * marker, which is applied only when a review PASSES. The readyForHuman label is
 * not accepted as that signal because this codebase also applies it to review
 * escalations (loop-cap, ambiguous output, unconfirmable base) that did not pass.
 *
 * Blocked/unsupported plans carry both the open `blockers` (the active subset)
 * and `allBlockers` (the full open+closed relationship list) so callers can
 * record a complete dependency audit snapshot.
 */
export async function resolveDependencyExecutionPlan(
  issueNumber: number,
  opts: {
    depChecker: DependencyChecker;
    runner: CommandRunner;
    /**
     * Pre-resolved `gh` executors for the session's configured provider auth
     * (e.g. GitHub App token-injecting runners). Default to the operator's `gh`
     * session wrapped from the CommandRunner, preserving behavior when omitted.
     */
    repoHostRunner?: GhRunner;
    workItemRunner?: GhRunner;
    /**
     * The session's resolved repo-host provider (GitHub or Gitea). When supplied,
     * the blocker PR lookup routes through it so a `gitea` repo host reads blocker
     * PRs over the Gitea REST API rather than `gh`. Falls back to a GitHub provider
     * built from `repoHostRunner` when omitted (legacy callers / tests).
     */
    repoHost?: RepoHostProvider;
    /**
     * The session's work-item provider kind. Stacked execution reads the single
     * blocker's readiness label from the GitHub *work-item* tracker
     * ({@link GhWorkItemProvider}), which only describes the blocker when the work
     * items themselves live on GitHub Issues. For any other provider (e.g.
     * `gitea-issues`) the blocker's readiness lives on a different tracker than the
     * GitHub repo-host PRs, so stacking is unsupported: an open blocker fails
     * closed here instead of being matched against a same-numbered GitHub issue's
     * labels read from the wrong tracker. Defaults to `github-issues`, preserving
     * existing behavior for callers that omit it.
     */
    workItemProvider?: string;
    githubRepo: string;
    cwd: string;
    /**
     * The human-handoff label. Retained for diagnostics only: it is NOT accepted
     * as an implementation-complete signal, because this codebase applies it both
     * to passing reviews and to escalated (failed) ones, so it cannot distinguish
     * a reviewed blocker from one whose review did not pass (issue #208).
     */
    readyForHumanLabel: string;
    /**
     * Stack-readiness marker — the success-specific signal applied only when a
     * review PASSES. A blocker carrying this label is implementation-complete and
     * usable as a stacking base. This is the sole accepted readiness signal
     * (issue #208, A<-B<-C). Optional only for legacy callers; production always
     * supplies it, and without it no blocker resolves as ready.
     */
    stackReadyLabel?: string;
  },
): Promise<DependencyExecutionPlan> {
  const { depChecker, runner, githubRepo, cwd, readyForHumanLabel, stackReadyLabel } = opts;
  const workItemProvider = opts.workItemProvider ?? "github-issues";
  const repoHostRunner = opts.repoHostRunner ?? ghRunnerFromCommandRunner(runner);

  const blockedBy = await depChecker.getBlockedBy(issueNumber);
  const openBlockers = blockedBy.filter((b) => b.state === "open");
  const notPlannedBlockers = blockedBy.filter(
    (b) => b.state === "closed" && b.stateReason === "not_planned",
  );

  if (openBlockers.length === 0 && notPlannedBlockers.length === 0) {
    return { kind: "none" };
  }

  // A blocker closed as `not_planned` (abandoned / superseded) does not satisfy
  // a dependency — it must be rewired to a completed or stack-ready replacement.
  if (notPlannedBlockers.length > 0) {
    return {
      kind: "unsupported",
      reason:
        `Issue #${issueNumber} has ${notPlannedBlockers.length} blocker(s) closed as not-planned: ` +
        notPlannedBlockers.map((b) => `#${b.issueNumber}`).join(", ") +
        `. Closing an abandoned or superseded issue does not satisfy a dependency. ` +
        `Rewire the dependent to a completed or stack-ready replacement before running.`,
      blockers: [...notPlannedBlockers, ...openBlockers],
      allBlockers: blockedBy,
    };
  }

  // Fail closed for non-GitHub work items BEFORE any GitHub work-item read. The
  // stacking decision below resolves the blocker's readiness label from the
  // GitHub work-item tracker, but for a `gitea-issues` (or any non-GitHub)
  // session the blocker's readiness lives on a different tracker than the GitHub
  // repo-host PRs. Reading a same-numbered GitHub issue's labels here would let a
  // decision from the wrong tracker either green-light or block the task. Stacked
  // execution is unsupported for such providers, so an open blocker holds the
  // task until it is resolved on the work-item tracker.
  if (workItemProvider !== "github-issues") {
    return {
      kind: "unsupported",
      reason:
        `Issue #${issueNumber} has ${openBlockers.length} open blocker(s); stacked execution is not ` +
        `supported for the "${workItemProvider}" work-item provider (blocker readiness lives on a different ` +
        `tracker than the GitHub repo-host PRs). Holding until the blocker is resolved.`,
      blockers: openBlockers,
      allBlockers: blockedBy,
    };
  }

  // GitHub work items only past this point: resolve the GitHub work-item runner
  // lazily so a non-GitHub session never constructs a `gh`-backed reader it must
  // not use.
  const workItemRunner = opts.workItemRunner ?? ghRunnerFromCommandRunner(runner);

  if (openBlockers.length > 1) {
    return {
      kind: "unsupported",
      reason: `Issue #${issueNumber} has ${openBlockers.length} open blockers; only one is supported for stacked execution.`,
      blockers: openBlockers,
      allBlockers: blockedBy,
    };
  }

  const blocker = openBlockers[0];
  const repoHost = opts.repoHost ?? new GhRepoHostProvider(repoHostRunner, githubRepo, cwd);
  const found = repoHost.findPullRequestForWorkItem(blocker.issueNumber);

  if (found.kind === "none") {
    return {
      kind: "blocked",
      reason: `Blocker issue #${blocker.issueNumber} has no open PR; cannot use as branch base.`,
      blockers: openBlockers,
      allBlockers: blockedBy,
    };
  }

  if (found.kind === "failed") {
    return {
      kind: "blocked",
      reason: `Failed to resolve open PR for blocker #${blocker.issueNumber}: ${found.error}`,
      blockers: openBlockers,
      allBlockers: blockedBy,
    };
  }

  const prInfo: BlockerPrInfo = found.pullRequest;

  if (!prInfo.headRefName) {
    return {
      kind: "blocked",
      reason: `Blocker PR for issue #${blocker.issueNumber} is missing headRefName.`,
      blockers: openBlockers,
      allBlockers: blockedBy,
    };
  }

  if (prInfo.mergeable === "CONFLICTING" || prInfo.mergeStateStatus === "DIRTY") {
    return {
      kind: "blocked",
      reason: `Blocker PR #${prInfo.number} for issue #${blocker.issueNumber} is not usable (mergeable=${prInfo.mergeable}, mergeStateStatus=${prInfo.mergeStateStatus}).`,
      blockers: openBlockers,
      allBlockers: blockedBy,
    };
  }

  const workItems = new GhWorkItemProvider(workItemRunner, githubRepo, cwd);
  const itemDetails = workItems.getItem(blocker.issueNumber);

  if (!itemDetails.ok) {
    return {
      kind: "blocked",
      reason: `Failed to resolve labels for blocker #${blocker.issueNumber}: ${itemDetails.error}`,
      blockers: openBlockers,
      allBlockers: blockedBy,
    };
  }
  const issueLabels = itemDetails.value.labels;

  // Implementation-complete must be confirmed by the success-specific stack-ready
  // marker, which is applied only when a review PASSES. The readyForHuman label is
  // deliberately NOT accepted here: this codebase also applies readyForHuman when
  // a review is ESCALATED to a human (loop-cap, ambiguous output, unconfirmable
  // stacked base) without passing, so trusting it would let a dependent stack on a
  // blocker whose review failed (issue #208 review follow-up).
  const stackReady = stackReadyLabel !== undefined && issueLabels.includes(stackReadyLabel);
  if (!stackReady) {
    const expected = stackReadyLabel ? `"${stackReadyLabel}"` : "the stack-ready marker (not configured)";
    return {
      kind: "blocked",
      reason: `Blocker issue #${blocker.issueNumber} is not ready for stacking (missing review-passed marker ${expected}; the "${readyForHumanLabel}" label is not accepted because it is also applied to escalated reviews that did not pass).`,
      blockers: openBlockers,
      allBlockers: blockedBy,
    };
  }

  return {
    kind: "ready",
    baseIssueNumber: blocker.issueNumber,
    basePrNumber: prInfo.number,
    baseHeadRefName: prInfo.headRefName,
    basePrUrl: prInfo.url,
  };
}
