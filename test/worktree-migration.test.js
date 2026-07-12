/**
 * Mid-flight per-issue worktree enablement for existing active tasks (issue #439).
 *
 * Turning `session.worktrees.enabled` on for a session that already has active
 * tasks / branches / PRs must let each existing task resolve (create on first
 * use) its deterministic issue worktree WITHOUT a DB migration: `worktreeId` /
 * `worktreePath` are recomputed from session + issue, so a task that predates the
 * opt-in carries no worktree fields and still migrates on its next phase.
 *
 * Covers:
 *   - a worktree-disabled session is a no-op (`enabled: false`, no git side effect);
 *   - an existing task with NO recorded worktree fields and no branch creates the
 *     worktree from base (`migrated: true`, `created: true`);
 *   - an existing LOCAL `ai/issue-<n>` branch is used as the continuation point,
 *     preserving its commits;
 *   - an existing PR head (`origin/ai/issue-<n>`, no local branch) is used as the
 *     continuation point;
 *   - a task that already records a worktree path reuses it (`migrated: false`);
 *   - `ai/issue-<n>` held by a clean canonical checkout migrates (detach + add);
 *   - `ai/issue-<n>` held by a DIRTY canonical checkout fails closed with an
 *     actionable commit/stash message.
 */
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { resolveWorktreeMigration, issueWorktreeId, issueWorktreePath } from '../dist/index.js';

let tmpDir;
let repoRoot;
let worktreeRoot;

function git(args, cwd) {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    cwd,
    encoding: 'utf8',
  });
}

function commit(cwd, msg) {
  git(['commit', '-q', '--allow-empty', '-m', msg], cwd);
}

function makeSession(overrides = {}) {
  return {
    sessionId: 'addon-dev',
    repoKey: 'repo',
    repoRoot,
    githubRepo: 'org/repo',
    artifactDir: '.artifacts',
    artifactRoot: join(repoRoot, '.artifacts'),
    githubOwner: 'org',
    githubName: 'repo',
    baseBranch: 'main',
    defaults: { implementationAgent: 'claude', reviewAgent: 'codex' },
    verification: {},
    labels: { active: 'a', blocked: 'b', readyForHuman: 'r' },
    workItemProvider: { provider: 'github-issues', auth: { mode: 'gh' } },
    repoHostProvider: { provider: 'github', auth: { mode: 'gh' } },
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'worktree-migration-test-'));
  repoRoot = join(tmpDir, 'repo');
  worktreeRoot = join(tmpDir, 'state', 'worktrees');
  execFileSync('git', ['init', '-q', '-b', 'main', repoRoot]);
  commit(repoRoot, 'initial');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('resolveWorktreeMigration — disabled', () => {
  test('a session without worktrees enabled is a no-op with no git side effect', () => {
    const r = resolveWorktreeMigration({ session: makeSession(), issueNumber: 7, env: {} });
    expect(r).toEqual({ ok: true, context: { enabled: false } });
    expect(existsSync(worktreeRoot)).toBe(false);
  });
});

describe('resolveWorktreeMigration — existing task without worktree fields', () => {
  test('creates the worktree from base on first use (migrated:true, no branch yet)', () => {
    const session = makeSession({ worktrees: { enabled: true, root: worktreeRoot } });
    // A pre-existing active task whose context predates worktree enablement: no
    // worktreeId / worktreePath recorded at all.
    const r = resolveWorktreeMigration({
      session,
      issueNumber: 7,
      recordedContext: { phaseArtifact: 'whatever' },
      env: {},
    });

    expect(r.ok).toBe(true);
    expect(r.context.enabled).toBe(true);
    expect(r.context.migrated).toBe(true);
    expect(r.context.created).toBe(true);
    expect(r.context.branch).toBe('ai/issue-7');
    expect(r.context.worktreeId).toBe(issueWorktreeId('addon-dev', 7));
    expect(existsSync(issueWorktreePath(worktreeRoot, 'addon-dev', 7))).toBe(true);

    const list = git(['worktree', 'list', '--porcelain'], repoRoot);
    expect(list).toContain('branch refs/heads/ai/issue-7');
  });

  test('uses an existing LOCAL ai/issue-N branch as the continuation point', () => {
    const session = makeSession({ worktrees: { enabled: true, root: worktreeRoot } });
    // Create the issue branch with a distinguishing commit, then return the
    // canonical checkout to main so the branch exists but is not checked out.
    git(['checkout', '-q', '-b', 'ai/issue-7'], repoRoot);
    writeFileSync(join(repoRoot, 'feature.txt'), 'work\n');
    git(['add', '-A'], repoRoot);
    commit(repoRoot, 'feature work');
    git(['checkout', '-q', 'main'], repoRoot);

    const r = resolveWorktreeMigration({
      session,
      issueNumber: 7,
      recordedContext: null,
      env: {},
    });

    expect(r.ok).toBe(true);
    expect(r.context.migrated).toBe(true);
    expect(r.context.created).toBe(true);
    expect(r.context.branch).toBe('ai/issue-7');
    // The existing branch's commit is preserved in the worktree (continuation),
    // not reset to base.
    expect(existsSync(join(r.context.worktreePath, 'feature.txt'))).toBe(true);
  });

  test('uses an existing PR head (origin/ai/issue-N, no local branch) as the continuation point', () => {
    const session = makeSession({ worktrees: { enabled: true, root: worktreeRoot } });
    // Stand up an "origin" repo carrying the PR head branch with a marker commit,
    // wire it as origin, and fetch so only the remote-tracking ref exists locally.
    const originRoot = join(tmpDir, 'origin');
    execFileSync('git', ['init', '-q', '-b', 'main', originRoot]);
    commit(originRoot, 'origin initial');
    git(['checkout', '-q', '-b', 'ai/issue-7'], originRoot);
    writeFileSync(join(originRoot, 'pr-head.txt'), 'pushed\n');
    git(['add', '-A'], originRoot);
    commit(originRoot, 'pr head work');
    git(['remote', 'add', 'origin', originRoot], repoRoot);
    git(['fetch', '-q', 'origin'], repoRoot);

    // Sanity: no local issue branch, but the remote-tracking ref exists.
    expect(() => git(['rev-parse', '--verify', 'refs/heads/ai/issue-7'], repoRoot)).toThrow();
    git(['rev-parse', '--verify', 'refs/remotes/origin/ai/issue-7'], repoRoot);

    const r = resolveWorktreeMigration({
      session,
      issueNumber: 7,
      recordedContext: {},
      env: {},
    });

    expect(r.ok).toBe(true);
    expect(r.context.migrated).toBe(true);
    expect(r.context.created).toBe(true);
    expect(r.context.branch).toBe('ai/issue-7');
    // The PR head commit is recovered into the worktree.
    expect(existsSync(join(r.context.worktreePath, 'pr-head.txt'))).toBe(true);
  });
});

describe('resolveWorktreeMigration — already-migrated task', () => {
  test('reuses the worktree and reports migrated:false when a path is already recorded', () => {
    const session = makeSession({ worktrees: { enabled: true, root: worktreeRoot } });
    const first = resolveWorktreeMigration({ session, issueNumber: 7, recordedContext: null, env: {} });
    expect(first.context.migrated).toBe(true);
    expect(first.context.created).toBe(true);

    // The task now carries the recorded worktree fields from its first phase.
    const second = resolveWorktreeMigration({
      session,
      issueNumber: 7,
      recordedContext: {
        worktreeId: first.context.worktreeId,
        worktreePath: first.context.worktreePath,
      },
      env: {},
    });
    expect(second.ok).toBe(true);
    expect(second.context.migrated).toBe(false);
    expect(second.context.created).toBe(false);
    expect(second.context.worktreePath).toBe(first.context.worktreePath);
  });

  test('reports migrated:true on first creation even when a path was recorded but never materialized', () => {
    const session = makeSession({ worktrees: { enabled: true, root: worktreeRoot } });
    // The non-mutating resolver (`create: false`) persists the deterministic
    // worktreePath for future use WITHOUT running `git worktree add`, so a task
    // can carry a recorded path while no checkout exists on disk yet.
    const recordedPath = issueWorktreePath(worktreeRoot, 'addon-dev', 7);
    expect(existsSync(recordedPath)).toBe(false);

    const r = resolveWorktreeMigration({
      session,
      issueNumber: 7,
      recordedContext: {
        worktreeId: issueWorktreeId('addon-dev', 7),
        worktreePath: recordedPath,
      },
      env: {},
    });

    // First-use creation must NOT be misreported as steady-state reuse just
    // because a path was recorded ahead of materialization.
    expect(r.ok).toBe(true);
    expect(r.context.created).toBe(true);
    expect(r.context.migrated).toBe(true);
    expect(existsSync(recordedPath)).toBe(true);
  });
});

describe('resolveWorktreeMigration — canonical checkout holds the branch', () => {
  test('migrates a CLEAN canonical checkout off the branch into the worktree', () => {
    const session = makeSession({ worktrees: { enabled: true, root: worktreeRoot } });
    // The branch is checked out in the canonical repo itself (the common
    // mid-flight case: the session was running this issue on the shared checkout).
    git(['checkout', '-q', '-b', 'ai/issue-7'], repoRoot);

    const r = resolveWorktreeMigration({
      session,
      issueNumber: 7,
      recordedContext: null,
      env: {},
    });

    expect(r.ok).toBe(true);
    expect(r.context.migrated).toBe(true);
    expect(r.context.created).toBe(true);
    expect(r.context.branch).toBe('ai/issue-7');
    // The worktree now holds the branch; the canonical checkout was detached.
    const list = git(['worktree', 'list', '--porcelain'], repoRoot);
    expect(list).toContain('branch refs/heads/ai/issue-7');
  });

  test('fails closed when the canonical checkout is DIRTY on the branch', () => {
    const session = makeSession({ worktrees: { enabled: true, root: worktreeRoot } });
    git(['checkout', '-q', '-b', 'ai/issue-7'], repoRoot);
    // Uncommitted work that would be stranded by a branch-ref-only migration.
    writeFileSync(join(repoRoot, 'pending.txt'), 'wip\n');

    const r = resolveWorktreeMigration({
      session,
      issueNumber: 7,
      recordedContext: null,
      env: {},
    });

    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/uncommitted changes/);
    expect(r.error).toMatch(/Commit or stash/);
    // Fail-closed leaves shared state untouched: no managed worktree was created
    // and the canonical checkout is still on the branch (not detached).
    expect(existsSync(issueWorktreePath(worktreeRoot, 'addon-dev', 7))).toBe(false);
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot).trim()).toBe('ai/issue-7');
  });
});
