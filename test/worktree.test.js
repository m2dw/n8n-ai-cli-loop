import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import {
  resolveIssueWorktree,
  listWorktrees,
  removeWorktree,
  parseWorktreeList,
  canonicalizePath,
  findWorktreeByPath,
  IssueWorktreeLock,
  issueLockScope,
  issueWorktreePath,
  issueWorktreeId,
  sessionWorktreeDir,
  researchWorktreePath,
  classifyManagedWorktree,
  redactWorktreePaths,
  resolveWorktreeRoot,
  DEFAULT_WORKTREE_ROOT,
  WORKTREE_ROOT_ENV,
} from '../dist/index.js';

// ---------------------------------------------------------------------------
// Real-git fixtures: a canonical repo with one commit on `main`. Worktree
// operations run against real `git worktree` so the semantics (one branch per
// worktree, dirty-tree isolation, remove refusal) are validated for real.
// ---------------------------------------------------------------------------

let tmpDir;
let repoRoot;
let worktreeRoot;

function git(args, cwd) {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    cwd,
    encoding: 'utf8',
  });
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'worktree-test-'));
  repoRoot = join(tmpDir, 'repo');
  worktreeRoot = join(tmpDir, 'state', 'worktrees');
  execFileSync('git', ['init', '-q', '-b', 'main', repoRoot]);
  writeFileSync(join(repoRoot, 'README.md'), '# repo\n');
  git(['add', '-A'], repoRoot);
  git(['commit', '-q', '-m', 'initial'], repoRoot);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Path / identity helpers
// ---------------------------------------------------------------------------

describe('worktree path helpers', () => {
  test('issueWorktreePath follows <root>/<session>/issue-<n>/repo', () => {
    expect(issueWorktreePath('/state', 'addon-dev', 365)).toBe('/state/addon-dev/issue-365/repo');
  });

  test('issueWorktreeId is a stable location-independent id', () => {
    expect(issueWorktreeId('addon-dev', 365)).toBe('addon-dev/issue-365');
  });

  test('session segment is encoded so a slash cannot traverse out of root', () => {
    const dir = sessionWorktreeDir('/state', 'a/b');
    expect(dir).toBe('/state/a%2Fb');
    expect(dir.startsWith('/state/')).toBe(true);
  });

  test('dot-only session segments cannot traverse out of root', () => {
    // `encodeURIComponent('.')`/`('..')` leave dots unchanged, so without
    // explicit handling path.join would resolve them as current/parent dir
    // references and escape the managed root. They must encode to literal names.
    expect(sessionWorktreeDir('/state', '.')).toBe('/state/%2E');
    expect(sessionWorktreeDir('/state', '..')).toBe('/state/%2E%2E');
    expect(issueWorktreePath('/state', '..', 365)).toBe('/state/%2E%2E/issue-365/repo');
    // The resolved worktree path stays under the managed root for both.
    for (const sid of ['.', '..']) {
      expect(issueWorktreePath('/state', sid, 7).startsWith('/state/')).toBe(true);
    }
    // A dot embedded in an otherwise-normal segment is untouched (not dot-only).
    expect(sessionWorktreeDir('/state', 'a.b')).toBe('/state/a.b');
  });

  test('resolveWorktreeRoot honors session root, then env, then default', () => {
    expect(resolveWorktreeRoot({ sessionRoot: '/custom', env: {} })).toBe('/custom');
    expect(resolveWorktreeRoot({ env: { [WORKTREE_ROOT_ENV]: '/from-env' } })).toBe('/from-env');
    expect(resolveWorktreeRoot({ env: {} })).toBe(DEFAULT_WORKTREE_ROOT);
    // Blank values are treated as unset.
    expect(resolveWorktreeRoot({ sessionRoot: '   ', env: {} })).toBe(DEFAULT_WORKTREE_ROOT);
  });

  test('resolveWorktreeRoot rejects a relative root so worktrees stay outside the checkout', () => {
    // A relative root would make `git worktree add` plant the tree inside repoRoot.
    expect(() => resolveWorktreeRoot({ sessionRoot: 'worktrees', env: {} })).toThrow(/absolute path/);
    expect(() => resolveWorktreeRoot({ env: { [WORKTREE_ROOT_ENV]: 'rel/state' } })).toThrow(
      new RegExp(WORKTREE_ROOT_ENV),
    );
    // The always-absolute default is unaffected.
    expect(resolveWorktreeRoot({ env: {} })).toBe(DEFAULT_WORKTREE_ROOT);
  });
});

// ---------------------------------------------------------------------------
// parseWorktreeList
// ---------------------------------------------------------------------------

describe('parseWorktreeList', () => {
  test('parses porcelain records into structured entries', () => {
    const porcelain = [
      'worktree /repo',
      'HEAD abc123',
      'branch refs/heads/main',
      '',
      'worktree /state/s/issue-7/repo',
      'HEAD def456',
      'branch refs/heads/ai/issue-7',
      'locked',
      '',
    ].join('\n');
    const entries = parseWorktreeList(porcelain);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ path: '/repo', branch: 'refs/heads/main', detached: false });
    expect(entries[1]).toMatchObject({ path: '/state/s/issue-7/repo', branch: 'refs/heads/ai/issue-7', locked: true });
  });

  test('marks detached worktrees', () => {
    const entries = parseWorktreeList(['worktree /d', 'HEAD aaa', 'detached', ''].join('\n'));
    expect(entries[0].detached).toBe(true);
    expect(entries[0].branch).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// resolveIssueWorktree — create a worktree for a new issue
// ---------------------------------------------------------------------------

describe('resolveIssueWorktree', () => {
  const base = (issueNumber) => ({
    repoRoot,
    sessionId: 'addon-dev',
    issueNumber,
    branch: `ai/issue-${issueNumber}`,
    baseRef: 'main',
    worktreeRoot,
  });

  test('creates a worktree for a new issue, checked out on its branch', () => {
    const result = resolveIssueWorktree(base(101));
    expect(result.ok).toBe(true);
    expect(result.created).toBe(true);
    expect(result.path).toBe(canonicalizePath(issueWorktreePath(worktreeRoot, 'addon-dev', 101)));
    expect(result.worktreeId).toBe('addon-dev/issue-101');
    expect(existsSync(result.path)).toBe(true);
    const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], result.path).trim();
    expect(branch).toBe('ai/issue-101');
    // Neither a local nor a remote ref existed — created fresh from baseRef, so it is
    // guaranteed to start exactly there (issue #667 review, P1).
    expect(result.branchReused).toBe(false);
    expect(result.startedFromRemoteHead).toBe(false);
  });

  test('resumes (reuses) an existing issue worktree without recreating it', () => {
    const first = resolveIssueWorktree(base(101));
    // Leave a marker so we can prove the SAME tree is reused, not recreated.
    writeFileSync(join(first.path, 'marker.txt'), 'resume-me');
    const second = resolveIssueWorktree(base(101));
    expect(second.ok).toBe(true);
    expect(second.created).toBe(false);
    expect(second.path).toBe(first.path);
    expect(readFileSync(join(second.path, 'marker.txt'), 'utf8')).toBe('resume-me');
  });

  test('dirty state in one issue worktree does not affect another issue', () => {
    const a = resolveIssueWorktree(base(101));
    // Dirty the first issue's worktree.
    writeFileSync(join(a.path, 'dirty.txt'), 'uncommitted');
    const aStatus = git(['status', '--porcelain'], a.path).trim();
    expect(aStatus.length).toBeGreaterThan(0);

    // A second, unrelated issue gets its own clean worktree.
    const b = resolveIssueWorktree(base(102));
    expect(b.ok).toBe(true);
    expect(b.path).not.toBe(a.path);
    const bStatus = git(['status', '--porcelain'], b.path).trim();
    expect(bStatus).toBe('');

    // The first issue is still dirty and isolated.
    expect(git(['status', '--porcelain'], a.path).trim().length).toBeGreaterThan(0);
  });

  test('rejects a relative worktree root instead of planting it inside the checkout', () => {
    const result = resolveIssueWorktree({ ...base(101), worktreeRoot: 'relative/state' });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/absolute path/);
    // Nothing was added to the canonical repo.
    const listed = listWorktrees(repoRoot);
    expect(listed.worktrees).toHaveLength(1);
  });

  test('rejects an absolute worktree root nested inside the canonical checkout', () => {
    // `<repoRoot>/worktrees` is absolute but inside the canonical checkout; creating
    // there would leave an untracked tree that dirties/blocks the shared repo.
    const result = resolveIssueWorktree({ ...base(101), worktreeRoot: join(repoRoot, 'worktrees') });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/outside the canonical checkout/);
    // Nothing was added to the canonical repo, and no stray directory was planted.
    const listed = listWorktrees(repoRoot);
    expect(listed.worktrees).toHaveLength(1);
    expect(existsSync(join(repoRoot, 'worktrees'))).toBe(false);
  });

  test('refuses to reuse a worktree left on the wrong branch (fail closed)', () => {
    const first = resolveIssueWorktree(base(101));
    expect(first.ok).toBe(true);
    // Simulate manual recovery that moved the worktree off the issue branch.
    git(['checkout', '-q', '-b', 'side-branch'], first.path);

    const reused = resolveIssueWorktree(base(101));
    expect(reused.ok).toBe(false);
    expect(reused.error).toMatch(/refs\/heads\/side-branch/);
    expect(reused.error).toMatch(/refs\/heads\/ai\/issue-101/);
  });

  test('refuses to reuse a detached worktree (fail closed)', () => {
    const first = resolveIssueWorktree(base(101));
    expect(first.ok).toBe(true);
    git(['checkout', '-q', '--detach', 'HEAD'], first.path);

    const reused = resolveIssueWorktree(base(101));
    expect(reused.ok).toBe(false);
    expect(reused.error).toMatch(/detached HEAD/);
  });

  test('recreates a worktree whose checkout was deleted out of band instead of reusing the stale entry', () => {
    const first = resolveIssueWorktree(base(101));
    expect(first.ok).toBe(true);
    // Commit on the issue branch so we can prove the branch (and its work) survives
    // the recovery — only the checkout directory is lost.
    writeFileSync(join(first.path, 'work.txt'), 'committed-work');
    git(['add', '-A'], first.path);
    git(['commit', '-q', '-m', 'issue work'], first.path);

    // Delete the checkout directory out of band; git still lists the registration
    // but now flags it `prunable`.
    rmSync(first.path, { recursive: true, force: true });
    const stale = findWorktreeByPath(repoRoot, first.path);
    expect(stale.worktree.prunable).toBe(true);

    // Resolving again must recreate the checkout (not falsely report reuse) and
    // restore the branch's committed work.
    const recovered = resolveIssueWorktree(base(101));
    expect(recovered.ok).toBe(true);
    expect(recovered.created).toBe(true);
    expect(recovered.path).toBe(first.path);
    expect(existsSync(recovered.path)).toBe(true);
    expect(readFileSync(join(recovered.path, 'work.txt'), 'utf8')).toBe('committed-work');
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], recovered.path).trim()).toBe('ai/issue-101');
  });

  test('checks out an existing branch as-is rather than resetting it', () => {
    // Pre-create the branch with a distinct commit, then resolve a worktree for it.
    git(['branch', 'ai/issue-200', 'main'], repoRoot);
    git(['worktree', 'add', '-q', join(tmpDir, 'tmpwt'), 'ai/issue-200'], repoRoot);
    writeFileSync(join(tmpDir, 'tmpwt', 'feature.txt'), 'x');
    git(['add', '-A'], join(tmpDir, 'tmpwt'));
    git(['commit', '-q', '-m', 'feature work'], join(tmpDir, 'tmpwt'));
    git(['worktree', 'remove', join(tmpDir, 'tmpwt')], repoRoot);

    const result = resolveIssueWorktree(base(200));
    expect(result.ok).toBe(true);
    expect(result.created).toBe(true);
    // The committed feature work is present — the branch was checked out, not reset.
    expect(existsSync(join(result.path, 'feature.txt'))).toBe(true);
  });

  test('migrates a clean branch left checked out in the canonical repo by detaching it', () => {
    // Reproduce the implementation success path: the canonical repoRoot is left
    // checked out on the issue branch with a clean working tree.
    git(['checkout', '-q', '-b', 'ai/issue-301'], repoRoot);

    const result = resolveIssueWorktree(base(301));
    expect(result.ok).toBe(true);
    expect(result.created).toBe(true);
    // The branch moved into the per-issue worktree.
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], result.path).trim()).toBe('ai/issue-301');
    // The canonical checkout was detached (freeing the branch), not deleted.
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot).trim()).toBe('HEAD');
  });

  test('fails closed when the canonical checkout is dirty on the issue branch', () => {
    // The new per-issue worktree is created from the branch ref only and does not
    // carry the canonical checkout's working tree/index. Detaching here would
    // strand the uncommitted work in the canonical checkout while the next phase
    // runs against the clean branch head, so the resolver must refuse rather than
    // silently discard pending work.
    git(['checkout', '-q', '-b', 'ai/issue-302'], repoRoot);
    writeFileSync(join(repoRoot, 'uncommitted.txt'), 'work in progress');

    const result = resolveIssueWorktree(base(302));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/uncommitted changes/);
    // The canonical checkout was not mutated and the pending work survives.
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot).trim()).toBe('ai/issue-302');
    expect(readFileSync(join(repoRoot, 'uncommitted.txt'), 'utf8')).toBe('work in progress');
    // No worktree was added for the issue.
    expect(existsSync(canonicalizePath(issueWorktreePath(worktreeRoot, 'addon-dev', 302)))).toBe(false);
  });

  test('restores the canonical branch when worktree add fails after detaching', () => {
    // Canonical repoRoot is left on the issue branch (the implementation success
    // path), but a stale, non-registered directory already occupies the target
    // worktree path so `git worktree add` fails AFTER the canonical checkout has
    // been detached. The resolver must re-attach the canonical checkout to its
    // branch rather than leaving the shared repo on detached HEAD.
    git(['checkout', '-q', '-b', 'ai/issue-305'], repoRoot);
    // The canonical checkout must be clean to reach the detach step (a dirty tree
    // fails closed before detaching), so the add-failure restore path is exercised.
    // Plant a stale, non-empty directory at the deterministic target path.
    const target = canonicalizePath(issueWorktreePath(worktreeRoot, 'addon-dev', 305));
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'stale.txt'), 'leftover');

    const result = resolveIssueWorktree(base(305));
    expect(result.ok).toBe(false);
    // The canonical checkout was restored to its branch (not left detached).
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot).trim()).toBe('ai/issue-305');
  });

  test('refuses to steal a branch already checked out in another worktree', () => {
    // The branch is checked out in a sibling worktree (not the canonical repo);
    // detaching the canonical checkout would not free it, so fail closed.
    git(['branch', 'ai/issue-302', 'main'], repoRoot);
    git(['worktree', 'add', '-q', join(tmpDir, 'sibling'), 'ai/issue-302'], repoRoot);

    const result = resolveIssueWorktree(base(302));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/already checked out at/);
    expect(result.error).toMatch(/refusing to add a second worktree/);
  });

  test('recovers the remote issue branch head when the local branch is missing', () => {
    // Fresh checkout / recovery: the issue branch lives on `origin` (carrying
    // pushed PR commits) but no local `refs/heads/ai/issue-303` exists. The
    // worktree must start from the remote PR head, not a fresh branch off baseRef.
    const remote = join(tmpDir, 'remote.git');
    execFileSync('git', ['init', '-q', '--bare', remote]);
    git(['remote', 'add', 'origin', remote], repoRoot);

    // Create the issue branch with a distinct PR commit and push it to origin
    // (which also creates the `refs/remotes/origin/ai/issue-303` tracking ref).
    git(['checkout', '-q', '-b', 'ai/issue-303', 'main'], repoRoot);
    writeFileSync(join(repoRoot, 'pr-head.txt'), 'pushed PR work');
    git(['add', '-A'], repoRoot);
    git(['commit', '-q', '-m', 'pr head commit'], repoRoot);
    const prHead = git(['rev-parse', 'HEAD'], repoRoot).trim();
    git(['push', '-q', 'origin', 'ai/issue-303'], repoRoot);

    // Drop the local branch so only origin/ai/issue-303 remains.
    git(['checkout', '-q', 'main'], repoRoot);
    git(['branch', '-q', '-D', 'ai/issue-303'], repoRoot);

    const result = resolveIssueWorktree(base(303));
    expect(result.ok).toBe(true);
    expect(result.created).toBe(true);
    // Started from the remote PR head, not from `main` (baseRef) — the pushed
    // commit and its file are present.
    expect(git(['rev-parse', 'HEAD'], result.path).trim()).toBe(prHead);
    expect(existsSync(join(result.path, 'pr-head.txt'))).toBe(true);
    // No local branch existed to "reuse" (branchReused: false), but the branch was
    // recovered from an existing remote head rather than created fresh from baseRef —
    // callers that validate a dependency start point's ancestry must treat this the
    // same as a reused branch (issue #667 review, P1).
    expect(result.branchReused).toBe(false);
    expect(result.startedFromRemoteHead).toBe(true);
  });

  test('fails closed when the local issue branch has diverged from origin', () => {
    // The local ai/issue-N branch exists, but origin advanced / was force-pushed
    // past it (follow-up commits landed on the PR head elsewhere). Building the
    // worktree from the stale local ref would put the next phase on the wrong PR
    // head, so the resolver must refuse rather than silently diverge.
    const remote = join(tmpDir, 'remote-304.git');
    execFileSync('git', ['init', '-q', '--bare', remote]);
    git(['remote', 'add', 'origin', remote], repoRoot);

    // Local issue branch with one commit, pushed to origin (creates the tracking
    // ref refs/remotes/origin/ai/issue-304 pointing at the local head).
    git(['checkout', '-q', '-b', 'ai/issue-304', 'main'], repoRoot);
    writeFileSync(join(repoRoot, 'local.txt'), 'local work');
    git(['add', '-A'], repoRoot);
    git(['commit', '-q', '-m', 'local commit'], repoRoot);
    git(['push', '-q', 'origin', 'ai/issue-304'], repoRoot);

    // Advance origin past the local ref from a throwaway detached worktree so
    // refs/heads/ai/issue-304 stays put while origin/ai/issue-304 moves ahead.
    const adv = join(tmpDir, 'advance-304');
    git(['worktree', 'add', '-q', '--detach', adv, 'ai/issue-304'], repoRoot);
    writeFileSync(join(adv, 'remote.txt'), 'remote follow-up');
    git(['add', '-A'], adv);
    git(['commit', '-q', '-m', 'remote follow-up'], adv);
    git(['push', '-q', 'origin', 'HEAD:ai/issue-304'], adv);
    git(['worktree', 'remove', '--force', adv], repoRoot);
    git(['fetch', '-q', 'origin'], repoRoot);

    // Back on main, the local issue branch is now strictly behind origin.
    git(['checkout', '-q', 'main'], repoRoot);

    const result = resolveIssueWorktree(base(304));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/diverged from origin/);
    // Nothing was added for the issue and the canonical checkout was not mutated.
    const listed = listWorktrees(repoRoot);
    expect(listed.worktrees.map((w) => canonicalizePath(w.path))).not.toContain(
      canonicalizePath(issueWorktreePath(worktreeRoot, 'addon-dev', 304)),
    );
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot).trim()).toBe('main');
  });

  test('reuses the local issue branch when it is ahead of origin (safe)', () => {
    // Local carries every pushed commit plus extra local work (origin head is an
    // ancestor of local). This is the safe relationship — the worktree should be
    // created from the local ref, preserving the local-ahead commits.
    const remote = join(tmpDir, 'remote-306.git');
    execFileSync('git', ['init', '-q', '--bare', remote]);
    git(['remote', 'add', 'origin', remote], repoRoot);

    git(['checkout', '-q', '-b', 'ai/issue-306', 'main'], repoRoot);
    writeFileSync(join(repoRoot, 'pushed.txt'), 'pushed work');
    git(['add', '-A'], repoRoot);
    git(['commit', '-q', '-m', 'pushed commit'], repoRoot);
    git(['push', '-q', 'origin', 'ai/issue-306'], repoRoot);

    // Local advances beyond origin (extra unpushed work).
    writeFileSync(join(repoRoot, 'ahead.txt'), 'local ahead');
    git(['add', '-A'], repoRoot);
    git(['commit', '-q', '-m', 'local-ahead commit'], repoRoot);
    const localHead = git(['rev-parse', 'HEAD'], repoRoot).trim();

    git(['checkout', '-q', 'main'], repoRoot);

    const result = resolveIssueWorktree(base(306));
    expect(result.ok).toBe(true);
    expect(result.created).toBe(true);
    // Started from the local-ahead head, preserving the unpushed commit.
    expect(git(['rev-parse', 'HEAD'], result.path).trim()).toBe(localHead);
    expect(existsSync(join(result.path, 'ahead.txt'))).toBe(true);
  });

  test('refuses to reuse an existing worktree after origin diverged (fail closed)', () => {
    // A worktree was created on an earlier phase, then origin advanced / was
    // force-pushed past its local branch and a later `git fetch` updated the
    // remote-tracking ref. Resuming on the stale local ref would run the next
    // phase on the wrong PR head, so reuse must apply the same divergence guard
    // as creation rather than trusting the path-keyed worktree.
    const remote = join(tmpDir, 'remote-307.git');
    execFileSync('git', ['init', '-q', '--bare', remote]);
    git(['remote', 'add', 'origin', remote], repoRoot);

    // First phase: create the worktree and publish its branch to origin so the
    // local and remote heads start in sync.
    const first = resolveIssueWorktree(base(307));
    expect(first.ok).toBe(true);
    expect(first.created).toBe(true);
    git(['push', '-q', 'origin', 'ai/issue-307'], first.path);

    // Origin advances past the worktree's local ref (follow-up commits landed on
    // the PR head from elsewhere). Use a throwaway detached worktree so the issue
    // worktree's local branch ref stays put while origin/ai/issue-307 moves ahead.
    const adv = join(tmpDir, 'advance-307');
    git(['worktree', 'add', '-q', '--detach', adv, 'ai/issue-307'], repoRoot);
    writeFileSync(join(adv, 'remote.txt'), 'remote follow-up');
    git(['add', '-A'], adv);
    git(['commit', '-q', '-m', 'remote follow-up'], adv);
    git(['push', '-q', 'origin', 'HEAD:ai/issue-307'], adv);
    git(['worktree', 'remove', '--force', adv], repoRoot);
    git(['fetch', '-q', 'origin'], repoRoot);

    // Resuming the same issue must fail closed on the divergence rather than
    // reusing the stale worktree.
    const reused = resolveIssueWorktree(base(307));
    expect(reused.ok).toBe(false);
    expect(reused.error).toMatch(/diverged from origin/);
    expect(reused.error).toMatch(/refusing to reuse/);
  });

  test('with allowFastForward, creates a worktree from a behind-origin (fast-forwardable) local branch', () => {
    // Local ai/issue-N is strictly BEHIND origin (origin advanced with a descendant
    // commit), so it can be cleanly fast-forwarded. The fix-followup path opts into
    // allowFastForward and reconciles with `git pull --ff-only` afterward, so the
    // resolver must accept the behind-origin ref instead of failing its containment
    // guard (issue #454 review).
    const remote = join(tmpDir, 'remote-308.git');
    execFileSync('git', ['init', '-q', '--bare', remote]);
    git(['remote', 'add', 'origin', remote], repoRoot);

    git(['checkout', '-q', '-b', 'ai/issue-308', 'main'], repoRoot);
    writeFileSync(join(repoRoot, 'local.txt'), 'local work');
    git(['add', '-A'], repoRoot);
    git(['commit', '-q', '-m', 'local commit'], repoRoot);
    const localHead = git(['rev-parse', 'HEAD'], repoRoot).trim();
    git(['push', '-q', 'origin', 'ai/issue-308'], repoRoot);

    // Advance origin past the local ref with a descendant commit, so local stays an
    // ancestor of origin (strictly behind = fast-forwardable).
    const adv = join(tmpDir, 'advance-308');
    git(['worktree', 'add', '-q', '--detach', adv, 'ai/issue-308'], repoRoot);
    writeFileSync(join(adv, 'remote.txt'), 'remote follow-up');
    git(['add', '-A'], adv);
    git(['commit', '-q', '-m', 'remote follow-up'], adv);
    git(['push', '-q', 'origin', 'HEAD:ai/issue-308'], adv);
    git(['worktree', 'remove', '--force', adv], repoRoot);
    git(['fetch', '-q', 'origin'], repoRoot);
    git(['checkout', '-q', 'main'], repoRoot);

    // The strict guard (default) still refuses the behind-origin ref.
    const strict = resolveIssueWorktree(base(308));
    expect(strict.ok).toBe(false);
    expect(strict.error).toMatch(/diverged from origin/);

    // With allowFastForward the worktree is created from the local ref; the caller
    // fast-forwards it onto origin afterward.
    const ff = resolveIssueWorktree({ ...base(308), allowFastForward: true });
    expect(ff.ok).toBe(true);
    expect(ff.created).toBe(true);
    expect(git(['rev-parse', 'HEAD'], ff.path).trim()).toBe(localHead);
  });

  test('with allowFastForward, still rejects a genuinely diverged (non-fast-forwardable) local branch', () => {
    // Origin was force-pushed to a SIBLING history (not a descendant of the local
    // head), so local is neither ahead of nor an ancestor of origin — it cannot be
    // fast-forwarded. allowFastForward must NOT relax the guard for a real divergence;
    // the later `git pull --ff-only` would fail anyway, so fail closed here (issue #454
    // review).
    const remote = join(tmpDir, 'remote-309.git');
    execFileSync('git', ['init', '-q', '--bare', remote]);
    git(['remote', 'add', 'origin', remote], repoRoot);

    git(['checkout', '-q', '-b', 'ai/issue-309', 'main'], repoRoot);
    writeFileSync(join(repoRoot, 'local.txt'), 'local work');
    git(['add', '-A'], repoRoot);
    git(['commit', '-q', '-m', 'local commit'], repoRoot);
    git(['push', '-q', 'origin', 'ai/issue-309'], repoRoot);

    // Force-push a diverging commit (built off main, not off the local head).
    const adv = join(tmpDir, 'advance-309');
    git(['worktree', 'add', '-q', '--detach', adv, 'main'], repoRoot);
    writeFileSync(join(adv, 'diverge.txt'), 'diverging history');
    git(['add', '-A'], adv);
    git(['commit', '-q', '-m', 'diverging commit'], adv);
    git(['push', '-q', '-f', 'origin', 'HEAD:ai/issue-309'], adv);
    git(['worktree', 'remove', '--force', adv], repoRoot);
    git(['fetch', '-q', 'origin'], repoRoot);
    git(['checkout', '-q', 'main'], repoRoot);

    const ff = resolveIssueWorktree({ ...base(309), allowFastForward: true });
    expect(ff.ok).toBe(false);
    expect(ff.error).toMatch(/diverged from origin/);
  });
});

// ---------------------------------------------------------------------------
// list / find / remove
// ---------------------------------------------------------------------------

describe('listWorktrees / removeWorktree', () => {
  const base = (issueNumber) => ({
    repoRoot,
    sessionId: 'addon-dev',
    issueNumber,
    branch: `ai/issue-${issueNumber}`,
    baseRef: 'main',
    worktreeRoot,
  });

  test('lists the canonical repo plus created issue worktrees', () => {
    resolveIssueWorktree(base(101));
    const listed = listWorktrees(repoRoot);
    expect(listed.ok).toBe(true);
    const paths = listed.worktrees.map((w) => canonicalizePath(w.path));
    expect(paths).toContain(canonicalizePath(repoRoot));
    expect(paths).toContain(canonicalizePath(issueWorktreePath(worktreeRoot, 'addon-dev', 101)));
  });

  test('findWorktreeByPath resolves a worktree for a tool-request target', () => {
    const created = resolveIssueWorktree(base(305));
    const found = findWorktreeByPath(repoRoot, created.path);
    expect(found.ok).toBe(true);
    expect(found.worktree).toBeDefined();
    expect(canonicalizePath(found.worktree.path)).toBe(created.path);
    // The path a Tool Request grant/resolve would operate on is deterministic.
    expect(created.path).toBe(canonicalizePath(issueWorktreePath(worktreeRoot, 'addon-dev', 305)));
  });

  test('removes a clean worktree and refuses a dirty one without --force', () => {
    const wt = resolveIssueWorktree(base(101));
    writeFileSync(join(wt.path, 'dirty.txt'), 'x');

    const refused = removeWorktree(repoRoot, wt.path);
    expect(refused.ok).toBe(false);
    expect(existsSync(wt.path)).toBe(true);

    const forced = removeWorktree(repoRoot, wt.path, { force: true });
    expect(forced.ok).toBe(true);
    expect(existsSync(wt.path)).toBe(false);
    const listed = listWorktrees(repoRoot);
    expect(listed.worktrees.map((w) => w.path)).not.toContain(wt.path);
  });

  test('--force removes a locked worktree (requires git double force)', () => {
    const wt = resolveIssueWorktree(base(101));
    // Lock it the way `git worktree lock` does; a single `-f` cannot override this.
    git(['worktree', 'lock', wt.path], repoRoot);

    const refused = removeWorktree(repoRoot, wt.path);
    expect(refused.ok).toBe(false);
    expect(existsSync(wt.path)).toBe(true);

    const forced = removeWorktree(repoRoot, wt.path, { force: true });
    expect(forced.ok).toBe(true);
    expect(existsSync(wt.path)).toBe(false);
    const listed = listWorktrees(repoRoot);
    expect(listed.worktrees.map((w) => w.path)).not.toContain(wt.path);
  });
});

// ---------------------------------------------------------------------------
// Issue-scoped lock: same issue serialized, different issues concurrent
// ---------------------------------------------------------------------------

describe('IssueWorktreeLock', () => {
  let lockDir;
  let lock;
  beforeEach(() => {
    lockDir = join(tmpDir, 'worktree-locks');
    lock = new IssueWorktreeLock(lockDir);
  });

  test('issueLockScope composes session and issue', () => {
    expect(issueLockScope('addon-dev', 7)).toBe('addon-dev::issue-7');
  });

  test('the same issue cannot run concurrently', () => {
    const first = lock.acquire('run-A', 'addon-dev', 7);
    expect(first.locked).toBe(true);
    const second = lock.acquire('run-B', 'addon-dev', 7);
    expect(second.locked).toBe(false);
    expect(second.reason).toBe('lock_held');
  });

  test('different issues may run concurrently', () => {
    const a = lock.acquire('run-A', 'addon-dev', 7);
    const b = lock.acquire('run-B', 'addon-dev', 8);
    expect(a.locked).toBe(true);
    expect(b.locked).toBe(true);
  });

  test('the same issue across different sessions is independent', () => {
    expect(lock.acquire('run-A', 'session-1', 7).locked).toBe(true);
    expect(lock.acquire('run-B', 'session-2', 7).locked).toBe(true);
  });

  test('release frees the issue lock for the next run', () => {
    expect(lock.acquire('run-A', 'addon-dev', 7).locked).toBe(true);
    const released = lock.release('run-A', 'addon-dev', 7);
    expect(released.released).toBe(true);
    expect(lock.acquire('run-B', 'addon-dev', 7).locked).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// classifyManagedWorktree: the inverse of the path builders (issue #855).
// Admin cleanup walks `git worktree list` output and must tell the durable
// per-issue checkout apart from a throwaway per-run research checkout, because
// the two get opposite preservation policies.
// ---------------------------------------------------------------------------

describe('classifyManagedWorktree', () => {
  const SESSION = 'addon-dev';
  const ROOT = '/state/worktrees';
  const prefix = sessionWorktreeDir(ROOT, SESSION) + '/';

  test('classifies the durable per-issue checkout', () => {
    const rel = issueWorktreePath(ROOT, SESSION, 42).slice(prefix.length);
    expect(classifyManagedWorktree(rel)).toEqual({ kind: 'issue', issueNumber: 42 });
  });

  test('classifies a per-run research checkout and recovers its run id', () => {
    const rel = researchWorktreePath(ROOT, SESSION, 42, 'run-855-1').slice(prefix.length);
    expect(classifyManagedWorktree(rel)).toEqual({
      kind: 'research',
      issueNumber: 42,
      runId: 'run-855-1',
    });
  });

  test('round-trips a run id that needed path encoding', () => {
    // researchWorktreePath percent-encodes the run id segment, so the
    // classifier must decode it or the reported run id would not match the run.
    const runId = 'run/855 #1';
    const rel = researchWorktreePath(ROOT, SESSION, 7, runId).slice(prefix.length);
    expect(classifyManagedWorktree(rel)).toEqual({ kind: 'research', issueNumber: 7, runId });
  });

  test('treats any other child of issue-<n> as the durable worktree', () => {
    // Preserves the historical behavior of the cleanup scan: the whole
    // issue-<n> subtree belongs to that issue unless it is a research sibling.
    expect(classifyManagedWorktree('issue-9')).toEqual({ kind: 'issue', issueNumber: 9 });
    expect(classifyManagedWorktree('issue-9/repo/src')).toEqual({ kind: 'issue', issueNumber: 9 });
  });

  test('returns null for a path that is not a managed layout', () => {
    expect(classifyManagedWorktree('scratch/repo')).toBeNull();
    expect(classifyManagedWorktree('issue-abc/repo')).toBeNull();
    expect(classifyManagedWorktree('')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Redaction: local worktree paths never leak
// ---------------------------------------------------------------------------

describe('redactWorktreePaths', () => {
  test('replaces the worktree root and sub-paths with a placeholder', () => {
    const root = '/var/lib/n8n/worktrees';
    const text = `worktree at ${root}/addon-dev/issue-7/repo broke`;
    expect(redactWorktreePaths(text, root)).toBe('worktree at <worktree> broke');
  });

  test('leaves unrelated text untouched', () => {
    expect(redactWorktreePaths('nothing to redact', '/state/worktrees')).toBe('nothing to redact');
  });
});
