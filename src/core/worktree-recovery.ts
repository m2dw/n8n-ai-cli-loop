/**
 * Worktree-aware drift recovery classification (issue #408).
 *
 * The per-issue worktree model (#400) replaces shared-checkout dirty-state
 * failures, but introduces new drift classes between the task context, the
 * branch refs, the worktree registry (`git worktree list`), the issue-scoped
 * lock, and PR state. This module is the pure, dependency-free decision core
 * that maps a gathered state snapshot to a single recommended recovery action
 * plus operator-facing guidance. The git/PR/lock probing and the admin CLI
 * presentation live in src/cli/admin.ts; keeping the decision logic here makes
 * every drift case unit-testable without a real repository, mirroring the
 * handler/runner split used elsewhere.
 *
 * Crucially the guidance strings are path-free (they reference only issue
 * numbers and branch names): a recovery assessment may be surfaced in operator
 * output, but it must never carry an absolute local worktree path into a public
 * GitHub/Gitea comment (issue #408 acceptance; complements the redaction in
 * core/worktree-paths.ts and core/outbox-effects.ts).
 */

/**
 * The single recommended action for an issue's drift state. The admin output
 * frames every assessment as one of: resume, recreate (worktree or from
 * remote), cleanup, report-only drift, or skip (active lock).
 */
export type WorktreeRecoveryAction =
  /** Branch + managed worktree both exist and agree → resume the worktree. */
  | "resume"
  /** Branch exists locally with meaningful work but the worktree is missing → recreate it from the branch. */
  | "recreate-worktree"
  /** The managed per-issue path holds a stale (prunable) registration — its checkout directory was deleted out of band → prune the registration, then recreate the worktree. */
  | "prune-and-recreate-worktree"
  /** No local branch/worktree, but a remote branch/PR exists → recreate the local worktree from remote state. */
  | "recreate-from-remote"
  /** The managed per-issue path is already registered to a detached/foreign worktree → remove it before resume/recreate. */
  | "resolve-path-conflict"
  /** The issue branch is checked out in a worktree at a non-managed path → relocate/remove that holder before recreate. */
  | "relocate-worktree"
  /** Local-only branch with no commits ahead of base and no PR → stale cleanup candidate (the #404 class). */
  | "cleanup-stale"
  /** Task context points at a worktree that no longer resolves and nothing is recoverable → report drift, do not hard-fail. */
  | "report-drift"
  /** An active (non-stale) lock owns the issue → do not recover; another run is executing it. */
  | "skip-locked";

/** Lock state for an issue's worktree scope (a subset of the lock store's inspect result). */
export interface WorktreeRecoveryLock {
  held: boolean;
  /** True when the lock is older than its TTL — the owning process likely died without releasing it. */
  stale: boolean;
}

/**
 * Gathered, side-effect-free view of one issue's drift state. The admin command
 * populates this from `git`, the worktree registry, the issue lock, the task
 * store, and (best-effort) PR context; tests construct it directly.
 */
export interface WorktreeRecoverySnapshot {
  issueNumber: number;
  /** The issue branch, e.g. `ai/issue-<n>`. */
  branch: string;
  /** A local branch ref (`refs/heads/<branch>`) exists in the canonical repo. */
  localBranchExists: boolean;
  /** A remote branch (`origin/<branch>`) exists. `"unknown"` when the lookup was ambiguous (network/auth). */
  remoteBranch: "yes" | "no" | "unknown";
  /** An open PR is recorded/known for the issue. */
  prOpen: boolean;
  /** A git worktree is registered at the managed per-issue path AND is on `branch`. */
  worktreeRegistered: boolean;
  /**
   * A git worktree is registered at the managed per-issue path but is detached or
   * checked out on a different branch — it occupies the path without matching
   * `branch`. `git worktree add` cannot recreate into it and a resume would fail
   * closed on the mismatch, so this is a distinct drift case from a missing
   * worktree (`worktreeRegistered === false` with no entry).
   */
  worktreePathConflict: boolean;
  /**
   * The managed per-issue path holds a *prunable* worktree registration: git still
   * lists the path but its checkout directory was deleted out of band, so the
   * registration is stale. `worktreeRegistered` is false here (the path cannot be
   * resumed), but a plain `git worktree add <managedPath> <branch>` fails with
   * "missing but already registered worktree" until the stale registration is
   * pruned. This is a distinct drift case from a cleanly missing worktree: the
   * recovery must prune (or force) before it can recreate.
   */
  worktreePrunable: boolean;
  /**
   * The issue branch is checked out in a worktree at a path *other* than the
   * managed per-issue path — a legacy/shared checkout, a moved worktree root, or
   * the canonical repo itself. `git worktree add <managedPath> <branch>` refuses
   * to add a branch that is already checked out elsewhere, so a recreate would
   * fail closed; this is a distinct drift case that must surface the holder and a
   * relocate/remove step rather than recommending recreate-worktree.
   */
  branchCheckedOutElsewhere: boolean;
  /** Commits the local branch is ahead of base; `null` when unknown or the branch is absent. */
  commitsAheadOfBase: number | null;
  /** A task row exists for the issue (its context expects the worktree to be resumable). */
  taskExists: boolean;
  /** Lock state for the issue's worktree scope, or `null` when no lock was found. */
  lock: WorktreeRecoveryLock | null;
}

/** The classified recommendation for one issue, suitable for both JSON and human rendering. */
export interface WorktreeRecoveryAssessment {
  issueNumber: number;
  branch: string;
  action: WorktreeRecoveryAction;
  /** True when the recommended path resumes meaningful state rather than discarding it. */
  resume: boolean;
  /** True when the issue is a cleanup candidate rather than a resume candidate. */
  stale: boolean;
  /** True when a held-but-stale issue lock is present that an operator should release (worktree release-lock) first. */
  staleLock: boolean;
  /** Operator-facing, path-free explanation of what to do. */
  guidance: string;
}

/** True when the remote branch is known to exist (an ambiguous lookup is not treated as present). */
function remoteBranchPresent(remote: "yes" | "no" | "unknown"): boolean {
  return remote === "yes";
}

/**
 * Classify one issue's drift state into a single recovery recommendation.
 *
 * Precedence (first match wins):
 *  1. Active (non-stale) lock — never touch a worktree a live run owns.
 *  2. Managed path occupied by a detached/foreign worktree — resolve the path
 *     conflict (remove it) before any resume/recreate can succeed.
 *  3. Issue branch checked out in a worktree at a non-managed path — relocate it;
 *     `git worktree add` cannot recreate a branch that is already checked out
 *     elsewhere, so recreate-worktree would fail closed.
 *  4. Managed path holds a stale (prunable) registration — its checkout directory
 *     was deleted out of band; prune the registration, then recreate. A plain
 *     recreate fails with "missing but already registered worktree" until pruned.
 *  5. Branch + worktree present and agree — resume.
 *  6. Branch present, worktree missing — recreate from the branch when it holds
 *     work (commits ahead / PR / remote) or its ahead-of-base count is unknown;
 *     only a verified zero-ahead, no-PR branch is the #404 stale class.
 *  7. No local branch but a remote branch/PR exists — recreate from remote.
 *  8. A task expects a worktree but nothing is recoverable — report drift.
 *  9. Nothing references the issue — stale cleanup candidate.
 *
 * A held-but-stale lock never blocks recovery (cases 2–8); it is surfaced via
 * `staleLock` and an appended `worktree release-lock` hint so the operator clears
 * the issue lock before resuming.
 */
export function assessWorktreeRecovery(
  snapshot: WorktreeRecoverySnapshot,
): WorktreeRecoveryAssessment {
  const { issueNumber, branch } = snapshot;
  const base = { issueNumber, branch };

  // 1. An active lock dominates every other signal: a live run is executing this
  // issue's worktree, so recovery must not touch it. A stale lock does NOT block
  // recovery — it is recoverable state, surfaced below.
  if (snapshot.lock?.held && !snapshot.lock.stale) {
    return {
      ...base,
      action: "skip-locked",
      resume: false,
      stale: false,
      staleLock: false,
      guidance:
        `An active lock holds issue #${issueNumber}; another run is executing it. ` +
        `Do not recover — wait for it to finish, or inspect the owner before forcing.`,
    };
  }

  const staleLock = Boolean(snapshot.lock?.held && snapshot.lock.stale);
  const lockHint = staleLock
    ? ` A stale issue lock is present (owner likely crashed); release it with ` +
      `'worktree release-lock --session-id <id> --issue-number ${issueNumber} --yes' before resuming.`
    : "";

  const remotePresent = remoteBranchPresent(snapshot.remoteBranch);

  // 2. The managed per-issue path is occupied by a detached/foreign worktree. This
  // must precede the missing-worktree cases: `worktreeRegistered` is false here, so
  // case 6 would otherwise mis-recommend `recreate-worktree`, but `git worktree add`
  // cannot recreate into an already registered path and a resume fails closed on the
  // branch mismatch. Surface it as its own actionable drift: remove the conflicting
  // worktree first, then recovery can resume or recreate.
  if (snapshot.worktreePathConflict) {
    return {
      ...base,
      action: "resolve-path-conflict",
      resume: false,
      stale: false,
      staleLock,
      guidance:
        `Issue #${issueNumber}'s managed worktree path is already registered to a different checkout ` +
        `(detached or on another branch), so it cannot be resumed or recreated in place. Remove the ` +
        `conflicting worktree (git worktree remove / prune) first, then re-run recovery to resume or ` +
        `recreate branch '${branch}'.` +
        lockHint,
    };
  }

  // 3. The issue branch is checked out in a worktree at a path other than the
  // managed one (a legacy/shared checkout, a moved worktree root, or the canonical
  // repo). It is not registered at the managed path, so `worktreeRegistered` is
  // false and case 6 would otherwise mis-recommend `recreate-worktree` — but
  // `git worktree add <managedPath> <branch>` refuses to add a branch that is
  // already checked out elsewhere, so that recreate fails closed. Surface the
  // holder and a relocate/remove step instead.
  if (snapshot.branchCheckedOutElsewhere) {
    return {
      ...base,
      action: "relocate-worktree",
      resume: false,
      stale: false,
      staleLock,
      guidance:
        `Branch '${branch}' is already checked out in another worktree (for example a legacy shared ` +
        `checkout, a moved worktree root, or the canonical repo), not at issue #${issueNumber}'s managed ` +
        `path. Git refuses to add a branch that is already checked out elsewhere, so it cannot be recreated ` +
        `in place: remove or relocate that holding worktree (git worktree remove / move) first, then re-run ` +
        `recovery to resume or recreate branch '${branch}'.` +
        lockHint,
    };
  }

  // 4. The managed per-issue path holds a stale (prunable) registration: git still
  // lists the path but its checkout directory was deleted out of band. This must
  // precede the missing-worktree cases: `worktreeRegistered` is false here, so case
  // 6 would otherwise recommend a plain `recreate-worktree`, but `git worktree add
  // <managedPath> <branch>` fails with "missing but already registered worktree"
  // until the stale registration is pruned. Surface a prune-then-recreate path so
  // the recommendation is executable.
  if (snapshot.worktreePrunable) {
    // If the branch itself is a verified local-only stale artifact (the #404
    // class: local branch exists, zero commits ahead of base, no remote branch,
    // no PR), recreating the worktree would just rebuild empty stale state. Route
    // it to cleanup instead — but note that the prunable registration must also be
    // cleared, otherwise the leftover entry blocks a clean next run.
    const aheadKnown = snapshot.commitsAheadOfBase !== null;
    const aheadOfBase = (snapshot.commitsAheadOfBase ?? 0) > 0;
    const remoteUnknown = snapshot.remoteBranch === "unknown";
    const hasWork = aheadOfBase || snapshot.prOpen || remotePresent;
    const provablyStale =
      snapshot.localBranchExists && !hasWork && aheadKnown && !remoteUnknown;
    if (provablyStale) {
      return {
        ...base,
        action: "cleanup-stale",
        resume: false,
        stale: true,
        staleLock,
        guidance:
          `Local-only branch '${branch}' has no commits ahead of base and no PR, so it is a stale cleanup ` +
          `candidate even though issue #${issueNumber}'s managed worktree path is still registered (git ` +
          `reports it prunable). Prune the stale registration first (git worktree prune, or git worktree ` +
          `remove --force) and delete the local branch, so the next run starts cleanly instead of rebuilding ` +
          `an empty worktree.` +
          lockHint,
      };
    }
    return {
      ...base,
      action: "prune-and-recreate-worktree",
      resume: true,
      stale: false,
      staleLock,
      guidance:
        `Issue #${issueNumber}'s managed worktree path is still registered but its checkout directory was ` +
        `deleted out of band (git reports it prunable). Recreating in place fails with "missing but already ` +
        `registered worktree" until the stale registration is cleared, so prune it first ` +
        `(git worktree prune, or git worktree remove --force) and then recreate the worktree from branch ` +
        `'${branch}'.` +
        lockHint,
    };
  }

  // 5. Branch and worktree both present and agree → resume the existing tree.
  if (snapshot.worktreeRegistered && snapshot.localBranchExists) {
    return {
      ...base,
      action: "resume",
      resume: true,
      stale: false,
      staleLock,
      guidance:
        `Branch '${branch}' and its managed worktree both exist; resume the worktree.` +
        lockHint,
    };
  }

  // 6. Local branch exists but the managed worktree is missing.
  if (snapshot.localBranchExists && !snapshot.worktreeRegistered) {
    const aheadKnown = snapshot.commitsAheadOfBase !== null;
    const aheadOfBase = (snapshot.commitsAheadOfBase ?? 0) > 0;
    const remoteUnknown = snapshot.remoteBranch === "unknown";
    const hasWork = aheadOfBase || snapshot.prOpen || remotePresent;
    if (hasWork) {
      return {
        ...base,
        action: "recreate-worktree",
        resume: true,
        stale: false,
        staleLock,
        guidance:
          `Branch '${branch}' holds work (commits ahead, an open PR, or a remote branch) but its managed ` +
          `worktree is missing; recreate the worktree from the existing branch (checked out, not branched — ` +
          `so it never fails with "branch already exists").` +
          lockHint,
      };
    }
    // The #404 stale class requires PROOF the branch is local-only and empty: a
    // known-zero ahead-of-base count AND a known-absent remote branch, with no
    // PR. When either signal is unknown we have not proven local-only, so we must
    // NOT take the verified-stale cleanup path below — recommending deletion of a
    // branch whose state is merely unreachable is unsafe. Two unknown signals
    // reach here: `git rev-list base..branch` failing (base missing/renamed, so
    // `commitsAheadOfBase` is null) or `git ls-remote` failing for network/auth
    // reasons (so `remoteBranch` is "unknown"). In both cases recreate the
    // worktree and let the operator inspect rather than steering toward deletion.
    if (!aheadKnown || remoteUnknown) {
      const reason = !aheadKnown
        ? `its commits ahead of base could not be determined (the base branch may be missing or renamed locally)`
        : `its remote branch state could not be determined (the remote lookup failed, e.g. network/auth)`;
      return {
        ...base,
        action: "recreate-worktree",
        resume: true,
        stale: false,
        staleLock,
        guidance:
          `Branch '${branch}' has no open PR, but ${reason}, so it cannot be confirmed a local-only stale ` +
          `branch. Its managed worktree is missing; recreate the worktree from the existing branch and ` +
          `inspect it — do not delete the branch until its state is known.` +
          lockHint,
      };
    }
    return {
      ...base,
      action: "cleanup-stale",
      resume: false,
      stale: true,
      staleLock,
      guidance:
        `Local-only branch '${branch}' has no commits ahead of base and no PR; it is a stale cleanup ` +
        `candidate. Delete the local branch (and any leftover worktree) so the next run starts cleanly ` +
        `instead of failing with "branch already exists".` +
        lockHint,
    };
  }

  // 7. No local branch, but a remote branch or open PR exists → recreate locally.
  if (!snapshot.localBranchExists && (snapshot.prOpen || remotePresent)) {
    return {
      ...base,
      action: "recreate-from-remote",
      resume: true,
      stale: false,
      staleLock,
      guidance:
        `No local branch or worktree, but a remote branch/PR exists for issue #${issueNumber}; recreate the ` +
        `local worktree from the remote branch '${branch}'.` +
        lockHint,
    };
  }

  // 8. A task expects this issue's worktree but nothing is recoverable (no
  // worktree, no local branch, no usable remote/PR). Report recoverable drift
  // rather than letting the phase hard-fail generically.
  if (snapshot.taskExists) {
    return {
      ...base,
      action: "report-drift",
      resume: false,
      stale: false,
      staleLock,
      guidance:
        `A task expects issue #${issueNumber}'s worktree, but no worktree, local branch, recoverable remote ` +
        `branch, or PR exists. This is recoverable drift, not a hard failure: re-queue the issue to start a ` +
        `fresh implementation worktree.` +
        lockHint,
    };
  }

  // 9. Nothing references the issue at all → stale cleanup candidate.
  return {
    ...base,
    action: "cleanup-stale",
    resume: false,
    stale: true,
    staleLock,
    guidance:
      `No worktree, branch, PR, or task references issue #${issueNumber}; nothing to resume.` +
      lockHint,
  };
}
