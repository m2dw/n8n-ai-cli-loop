import { assessWorktreeRecovery } from '../dist/index.js';

// Minimal snapshot factory: a "clean slate" issue with nothing referencing it.
// Each test overrides only the fields relevant to the drift case it exercises.
function snapshot(overrides = {}) {
  return {
    issueNumber: 408,
    branch: 'ai/issue-408',
    localBranchExists: false,
    remoteBranch: 'no',
    prOpen: false,
    worktreeRegistered: false,
    worktreePrunable: false,
    worktreePathConflict: false,
    branchCheckedOutElsewhere: false,
    commitsAheadOfBase: null,
    taskExists: false,
    lock: null,
    ...overrides,
  };
}

describe('assessWorktreeRecovery — resume vs cleanup classification', () => {
  test('branch + worktree both present → resume', () => {
    const a = assessWorktreeRecovery(
      snapshot({ localBranchExists: true, worktreeRegistered: true, commitsAheadOfBase: 2 }),
    );
    expect(a.action).toBe('resume');
    expect(a.resume).toBe(true);
    expect(a.stale).toBe(false);
    expect(a.guidance).toContain('resume');
  });

  // The #404 class: a local ai/issue-N branch exists, but no remote branch, no
  // PR, no commits ahead of base, and no worktree. It must be reported as a
  // stale cleanup candidate — never resumed and never a "branch already exists"
  // hard failure.
  test('branch-only with no commits ahead and no PR → cleanup-stale (#404 class)', () => {
    const a = assessWorktreeRecovery(
      snapshot({ localBranchExists: true, commitsAheadOfBase: 0 }),
    );
    expect(a.action).toBe('cleanup-stale');
    expect(a.resume).toBe(false);
    expect(a.stale).toBe(true);
    expect(a.guidance).toContain('stale cleanup');
    expect(a.guidance).toContain('branch already exists');
  });

  // Unknown ahead-of-base count (e.g. `git rev-list base..branch` failed because
  // the base branch is missing/renamed locally) must NOT be coalesced to a
  // verified zero and routed to cleanup: we cannot prove the branch is empty, so
  // recreate the worktree and let the operator inspect rather than delete it.
  test('branch with unknown ahead count and no PR/remote → recreate-worktree, not cleanup', () => {
    const a = assessWorktreeRecovery(
      snapshot({ localBranchExists: true, worktreeRegistered: false, commitsAheadOfBase: null }),
    );
    expect(a.action).toBe('recreate-worktree');
    expect(a.resume).toBe(true);
    expect(a.stale).toBe(false);
    expect(a.guidance).toContain('could not be');
    expect(a.guidance).not.toContain('stale cleanup');
  });

  // An unknown remote lookup (e.g. `git ls-remote` failed for network/auth) on a
  // zero-ahead, no-PR local branch must NOT be treated like a proven-absent remote
  // and routed to cleanup: we have not proven the branch is local-only, so an
  // operator following the guidance could delete a branch whose remote/PR state
  // was merely unreachable. Recreate the worktree and inspect instead.
  test('zero-ahead, no-PR branch with unknown remote → recreate-worktree, not cleanup', () => {
    const a = assessWorktreeRecovery(
      snapshot({
        localBranchExists: true,
        worktreeRegistered: false,
        commitsAheadOfBase: 0,
        prOpen: false,
        remoteBranch: 'unknown',
      }),
    );
    expect(a.action).toBe('recreate-worktree');
    expect(a.resume).toBe(true);
    expect(a.stale).toBe(false);
    expect(a.guidance).toContain('remote branch state could not be determined');
    expect(a.guidance).not.toContain('stale cleanup');
  });

  // Missing worktree registry entry: branch exists with commits ahead but the
  // managed worktree is gone → recreate from the branch (checked out, not -b).
  test('branch with work but missing worktree → recreate-worktree', () => {
    const a = assessWorktreeRecovery(
      snapshot({ localBranchExists: true, worktreeRegistered: false, commitsAheadOfBase: 3 }),
    );
    expect(a.action).toBe('recreate-worktree');
    expect(a.resume).toBe(true);
    expect(a.stale).toBe(false);
  });

  test('branch with open PR but missing worktree → recreate-worktree', () => {
    const a = assessWorktreeRecovery(
      snapshot({ localBranchExists: true, commitsAheadOfBase: 0, prOpen: true }),
    );
    expect(a.action).toBe('recreate-worktree');
    expect(a.resume).toBe(true);
  });

  // Managed path occupied by a detached/foreign worktree: the per-issue path is
  // registered but not on `branch`, so worktreeRegistered is false. This must NOT
  // collapse to recreate-worktree (git worktree add cannot reuse the path and a
  // resume fails closed on the mismatch) — it is its own path-conflict drift.
  test('occupied-but-wrong-branch worktree → resolve-path-conflict, not recreate', () => {
    const a = assessWorktreeRecovery(
      snapshot({
        localBranchExists: true,
        worktreeRegistered: false,
        worktreePathConflict: true,
        commitsAheadOfBase: 3,
      }),
    );
    expect(a.action).toBe('resolve-path-conflict');
    expect(a.resume).toBe(false);
    expect(a.stale).toBe(false);
    expect(a.guidance).toContain('already registered');
  });

  // The path conflict takes precedence even when a PR / remote branch exists,
  // since those would otherwise route to a recreate that cannot succeed in place.
  test('occupied path with an open PR still → resolve-path-conflict', () => {
    const a = assessWorktreeRecovery(
      snapshot({
        localBranchExists: true,
        worktreePathConflict: true,
        prOpen: true,
        remoteBranch: 'yes',
      }),
    );
    expect(a.action).toBe('resolve-path-conflict');
  });

  // The issue branch is checked out in a worktree at a non-managed path (a legacy
  // shared checkout, a moved worktree root, or the canonical repo). It is not at
  // the managed path, so worktreeRegistered is false — but recreate-worktree would
  // fail closed because `git worktree add` refuses a branch checked out elsewhere.
  // It must route to relocate-worktree, even when the branch holds work.
  test('branch checked out at a non-managed path → relocate-worktree, not recreate', () => {
    const a = assessWorktreeRecovery(
      snapshot({
        localBranchExists: true,
        worktreeRegistered: false,
        branchCheckedOutElsewhere: true,
        commitsAheadOfBase: 3,
      }),
    );
    expect(a.action).toBe('relocate-worktree');
    expect(a.resume).toBe(false);
    expect(a.stale).toBe(false);
    expect(a.guidance).toContain('already checked out in another worktree');
  });

  // The same drift takes precedence over a PR / remote branch, since those would
  // otherwise route to a recreate that cannot succeed in place.
  test('branch checked out elsewhere with an open PR still → relocate-worktree', () => {
    const a = assessWorktreeRecovery(
      snapshot({
        localBranchExists: true,
        branchCheckedOutElsewhere: true,
        prOpen: true,
        remoteBranch: 'yes',
      }),
    );
    expect(a.action).toBe('relocate-worktree');
  });

  // A prunable registration at the managed path: git still lists the path but its
  // checkout directory was deleted out of band, so worktreeRegistered is false. A
  // plain recreate-worktree would fail with "missing but already registered
  // worktree" until the stale registration is pruned, so this must route to
  // prune-and-recreate-worktree (executable) rather than recreate-worktree.
  test('prunable registration at managed path → prune-and-recreate-worktree, not recreate', () => {
    const a = assessWorktreeRecovery(
      snapshot({
        localBranchExists: true,
        worktreeRegistered: false,
        worktreePrunable: true,
        commitsAheadOfBase: 3,
      }),
    );
    expect(a.action).toBe('prune-and-recreate-worktree');
    expect(a.resume).toBe(true);
    expect(a.stale).toBe(false);
    expect(a.guidance).toContain('prunable');
    expect(a.guidance).toContain('prune');
  });

  // The prune-then-recreate path takes precedence over a PR / remote branch, since
  // those would otherwise route to a plain recreate that fails closed in place.
  test('prunable registration with an open PR still → prune-and-recreate-worktree', () => {
    const a = assessWorktreeRecovery(
      snapshot({
        localBranchExists: true,
        worktreePrunable: true,
        prOpen: true,
        remoteBranch: 'yes',
      }),
    );
    expect(a.action).toBe('prune-and-recreate-worktree');
  });

  // A prunable registration whose branch is itself the #404 stale class (local-only,
  // zero commits ahead of base, no remote branch, no PR) must NOT be recreated — that
  // would rebuild empty stale state. It routes to cleanup-stale, but the guidance must
  // still note the prunable registration that has to be cleared as part of cleanup.
  test('prunable registration on a #404-class stale branch → cleanup-stale, noting prune', () => {
    const a = assessWorktreeRecovery(
      snapshot({
        localBranchExists: true,
        worktreePrunable: true,
        commitsAheadOfBase: 0,
        remoteBranch: 'no',
        prOpen: false,
      }),
    );
    expect(a.action).toBe('cleanup-stale');
    expect(a.resume).toBe(false);
    expect(a.stale).toBe(true);
    expect(a.guidance).toContain('stale cleanup');
    expect(a.guidance).toContain('prunable');
    expect(a.guidance).toContain('prune');
  });

  // branch-with-PR recreate state: the local branch was pruned but a remote PR
  // exists → recreate the local worktree from remote.
  test('no local branch but open PR exists → recreate-from-remote', () => {
    const a = assessWorktreeRecovery(snapshot({ localBranchExists: false, prOpen: true }));
    expect(a.action).toBe('recreate-from-remote');
    expect(a.resume).toBe(true);
  });

  test('no local branch but remote branch exists → recreate-from-remote', () => {
    const a = assessWorktreeRecovery(snapshot({ localBranchExists: false, remoteBranch: 'yes' }));
    expect(a.action).toBe('recreate-from-remote');
    expect(a.resume).toBe(true);
  });

  // An ambiguous remote lookup (network/auth) is NOT treated as "remote exists".
  test('ambiguous remote lookup is not treated as a recreate-from-remote signal', () => {
    const a = assessWorktreeRecovery(
      snapshot({ localBranchExists: false, remoteBranch: 'unknown', taskExists: true }),
    );
    expect(a.action).toBe('report-drift');
  });

  // Task context points to a worktree that no longer resolves and nothing is
  // recoverable → report recoverable drift, not a generic hard failure.
  test('task expects a worktree but nothing recoverable → report-drift', () => {
    const a = assessWorktreeRecovery(snapshot({ taskExists: true }));
    expect(a.action).toBe('report-drift');
    expect(a.resume).toBe(false);
    expect(a.stale).toBe(false);
    expect(a.guidance).toContain('recoverable drift');
  });

  test('nothing references the issue → cleanup-stale', () => {
    const a = assessWorktreeRecovery(snapshot());
    expect(a.action).toBe('cleanup-stale');
    expect(a.stale).toBe(true);
  });
});

describe('assessWorktreeRecovery — lock handling', () => {
  // Active lock skip: a live run owns the issue → do not recover.
  test('active (non-stale) lock → skip-locked, regardless of branch/worktree state', () => {
    const a = assessWorktreeRecovery(
      snapshot({
        localBranchExists: true,
        worktreeRegistered: true,
        lock: { held: true, stale: false },
      }),
    );
    expect(a.action).toBe('skip-locked');
    expect(a.resume).toBe(false);
    expect(a.staleLock).toBe(false);
    expect(a.guidance).toContain('active lock');
  });

  // Stale lock is recoverable: it must not block recovery, but must be surfaced
  // with a `worktree release-lock` hint (the issue-lock release path, not the
  // session-wide repo-lock force-release).
  test('stale lock does not block recovery but is surfaced', () => {
    const a = assessWorktreeRecovery(
      snapshot({
        localBranchExists: true,
        worktreeRegistered: true,
        commitsAheadOfBase: 1,
        lock: { held: true, stale: true },
      }),
    );
    expect(a.action).toBe('resume');
    expect(a.staleLock).toBe(true);
    expect(a.guidance).toContain('stale issue lock');
    expect(a.guidance).toContain('worktree release-lock');
  });

  test('stale lock surfaced on a cleanup-stale issue too', () => {
    const a = assessWorktreeRecovery(
      snapshot({ localBranchExists: true, commitsAheadOfBase: 0, lock: { held: true, stale: true } }),
    );
    expect(a.action).toBe('cleanup-stale');
    expect(a.staleLock).toBe(true);
  });
});

// Guidance must never carry an absolute local path into operator/published
// output (issue #408 acceptance). The classifier only ever references issue
// numbers and branch names.
describe('assessWorktreeRecovery — guidance is path-free', () => {
  const cases = [
    snapshot({ localBranchExists: true, worktreeRegistered: true }),
    snapshot({ localBranchExists: true, commitsAheadOfBase: 0 }),
    snapshot({ localBranchExists: true, commitsAheadOfBase: null }),
    snapshot({ localBranchExists: true, commitsAheadOfBase: 5 }),
    snapshot({ prOpen: true }),
    snapshot({ taskExists: true }),
    snapshot({ localBranchExists: true, worktreePathConflict: true }),
    snapshot({ localBranchExists: true, worktreePrunable: true }),
    snapshot({ localBranchExists: true, branchCheckedOutElsewhere: true }),
    snapshot({ lock: { held: true, stale: false } }),
  ];
  test('no guidance string contains an absolute path', () => {
    for (const s of cases) {
      const a = assessWorktreeRecovery(s);
      expect(a.guidance).not.toMatch(/(^|\s)\/[^\s]+/);
    }
  });
});
