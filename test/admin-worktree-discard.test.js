import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { resolveIssueWorktree, IssueWorktreeLock, SqliteTaskStore } from '../dist/index.js';

const CLI = new URL('../dist/cli/admin.js', import.meta.url).pathname;

let tmpDir;
let repoRoot;
let worktreeRoot;
let sessionsPath;
let dbPath;
let lockDir;

function git(args, cwd) {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' });
}

function run(...args) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
    return { code: 0, stdout };
  } catch (err) {
    return { code: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

function writeSessions() {
  const sessions = {
    sessions: [
      {
        sessionId: 'addon-dev',
        repoKey: 'test-repo',
        repoRoot,
        githubRepo: 'm2dw/test-repo',
        artifactDir: '.n8n-artifacts',
        baseBranch: 'main',
        defaults: { implementationAgent: 'claude', reviewAgent: 'codex' },
        verification: { test: 'npm test' },
        labels: { active: 'ai:active', blocked: 'ai:blocked', readyForHuman: 'ai:ready-for-human' },
        worktrees: { enabled: true, root: worktreeRoot },
      },
    ],
  };
  writeFileSync(sessionsPath, JSON.stringify(sessions, null, 2));
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'admin-wt-discard-test-'));
  repoRoot = join(tmpDir, 'repo');
  worktreeRoot = join(tmpDir, 'state', 'worktrees');
  sessionsPath = join(tmpDir, 'sessions.json');
  dbPath = join(tmpDir, 'loop.db');
  lockDir = join(tmpDir, 'state', 'worktree-locks');
  execFileSync('git', ['init', '-q', '-b', 'main', repoRoot]);
  writeFileSync(join(repoRoot, 'README.md'), '# repo\n');
  git(['add', '-A'], repoRoot);
  git(['commit', '-q', '-m', 'initial'], repoRoot);
  writeSessions();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function createIssueWorktree(issueNumber) {
  return resolveIssueWorktree({
    repoRoot,
    sessionId: 'addon-dev',
    issueNumber,
    branch: `ai/issue-${issueNumber}`,
    baseRef: 'main',
    worktreeRoot,
  });
}

function discard(...extra) {
  return run(
    'worktree', 'discard',
    '--session-id', 'addon-dev',
    '--sessions-path', sessionsPath,
    '--db-path', dbPath,
    '--lock-dir', lockDir,
    '--json',
    ...extra,
  );
}

async function enqueue(issueNumber, context) {
  const store = new SqliteTaskStore(dbPath);
  try {
    await store.enqueueTask({
      sessionId: 'addon-dev',
      issueNumber,
      phase: 'implementation',
      context: context ?? {},
    });
  } finally {
    store.close();
  }
}

describe('admin worktree discard', () => {
  test('preview shows dirty tracked and untracked files without mutating', () => {
    const wt = createIssueWorktree(101);
    // Stage a tracked change.
    writeFileSync(join(wt.path, 'README.md'), 'changed\n');
    // Leave an untracked file.
    writeFileSync(join(wt.path, 'untracked.txt'), 'new\n');

    const r = discard('--issue-number', '101');
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.ok).toBe(true);
    expect(out.wouldDiscard).toBe(true);
    expect(out.dirty).toBe(true);
    expect(out.trackedChanges.length).toBeGreaterThan(0);
    expect(out.untrackedFiles).toContain('untracked.txt');
    expect(out.discarded).toBe(false);
    // Files untouched.
    expect(existsSync(join(wt.path, 'untracked.txt'))).toBe(true);
  });

  test('preview on a clean worktree reports dirty=false and no-op hint', () => {
    const wt = createIssueWorktree(102);
    void wt;

    const r = discard('--issue-number', '102');
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.ok).toBe(true);
    expect(out.wouldDiscard).toBe(true);
    expect(out.dirty).toBe(false);
    expect(out.trackedChanges).toEqual([]);
    expect(out.untrackedFiles).toEqual([]);
    expect(out.hint).toMatch(/already clean/);
  });

  test('--yes restores a dirty worktree to clean state', () => {
    const wt = createIssueWorktree(201);
    writeFileSync(join(wt.path, 'README.md'), 'dirty change\n');
    writeFileSync(join(wt.path, 'extra.txt'), 'untracked\n');

    const r = discard('--issue-number', '201', '--yes');
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.ok).toBe(true);
    expect(out.discarded).toBe(true);
    expect(out.trackedChanges.length).toBeGreaterThan(0);
    expect(out.untrackedFiles).toContain('extra.txt');
    // Untracked file removed.
    expect(existsSync(join(wt.path, 'extra.txt'))).toBe(false);
    // Tracked file reverted to HEAD state.
    const content = execFileSync('cat', [join(wt.path, 'README.md')], { encoding: 'utf8' });
    expect(content).toBe('# repo\n');
  });

  test('--yes on an already-clean worktree is a no-op', () => {
    createIssueWorktree(202);

    const r = discard('--issue-number', '202', '--yes');
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.ok).toBe(true);
    expect(out.discarded).toBe(false);
    expect(out.reason).toBe('already_clean');
  });

  test('missing worktree is a safe no-op', () => {
    // No worktree created for issue 999.
    const r = discard('--issue-number', '999');
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.ok).toBe(true);
    expect(out.discarded).toBe(false);
    expect(out.reason).toBe('not_found');
  });

  test('refuses a live issue lock without --force', () => {
    const wt = createIssueWorktree(301);
    writeFileSync(join(wt.path, 'dirty.txt'), 'x');
    const lock = new IssueWorktreeLock(lockDir);
    lock.acquire('owner-ctx', 'addon-dev', 301);

    const r = discard('--issue-number', '301');
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.ok).toBe(true);
    expect(out.discarded).toBe(false);
    expect(out.reason).toBe('lock_held');
    expect(out.stale).toBe(false);
    expect(out.ownerContextId).toBe('owner-ctx');
    expect(out.hint).toMatch(/--force/);
    // File still dirty.
    expect(existsSync(join(wt.path, 'dirty.txt'))).toBe(true);
  });

  test('--force bypasses a live lock and discards dirty state', () => {
    const wt = createIssueWorktree(302);
    writeFileSync(join(wt.path, 'forced.txt'), 'x');
    const lock = new IssueWorktreeLock(lockDir);
    lock.acquire('owner-ctx', 'addon-dev', 302);

    const r = discard('--issue-number', '302', '--yes', '--force');
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.ok).toBe(true);
    expect(out.discarded).toBe(true);
    expect(out.lockForced).toBe(true);
    expect(existsSync(join(wt.path, 'forced.txt'))).toBe(false);
  });

  test('--force on an unlocked worktree acquires and releases the lock (no bypass)', () => {
    // Regression: prior to the fix, --force skipped lock acquisition entirely
    // when no live lock was held, leaving a window for a concurrent worker.
    const wt = createIssueWorktree(304);
    writeFileSync(join(wt.path, 'unlocked-force.txt'), 'x');
    const lock = new IssueWorktreeLock(lockDir);

    // Verify: lock is free before the command.
    expect(lock.inspect('addon-dev', 304).locked).toBe(false);

    const r = discard('--issue-number', '304', '--yes', '--force');
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.ok).toBe(true);
    expect(out.discarded).toBe(true);
    // lockForced is only set when a live lock is actually bypassed; here it must be absent.
    expect(out.lockForced).toBeUndefined();
    // File was removed by the discard.
    expect(existsSync(join(wt.path, 'unlocked-force.txt'))).toBe(false);
    // Lock must be released after the command completes (no orphaned lock).
    expect(lock.inspect('addon-dev', 304).locked).toBe(false);
  });

  test('stale lock does not block discard (no --force needed)', () => {
    const wt = createIssueWorktree(303);
    writeFileSync(join(wt.path, 'stale-dirty.txt'), 'x');
    const lock = new IssueWorktreeLock(lockDir);
    const oldTs = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    lock.acquire('owner-ctx', 'addon-dev', 303, oldTs);
    expect(lock.inspect('addon-dev', 303).stale).toBe(true);

    const r = discard('--issue-number', '303', '--yes');
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.ok).toBe(true);
    expect(out.discarded).toBe(true);
    expect(existsSync(join(wt.path, 'stale-dirty.txt'))).toBe(false);
  });

  test('JSON output by default (human-readable mode without --json emits non-JSON)', () => {
    createIssueWorktree(401);
    // Without --json the output is human-readable (not a JSON object at root).
    const r = run(
      'worktree', 'discard',
      '--session-id', 'addon-dev',
      '--sessions-path', sessionsPath,
      '--lock-dir', lockDir,
      '--issue-number', '401',
    );
    expect(r.code).toBe(0);
    // Human-readable mode still exits 0; content is not strict JSON at root.
    // Just verify it doesn't crash and returns a result.
    expect(r.stdout.length).toBeGreaterThan(0);
  });

  test('rejects unknown flags (fail fast)', () => {
    const r = discard('--issue-number', '1', '--bogus');
    expect(r.code).toBe(1);
    const out = JSON.parse(r.stdout.trim());
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/Unknown option/);
  });

  test('requires --session-id', () => {
    const r = run('worktree', 'discard', '--issue-number', '1', '--json');
    expect(r.code).toBe(1);
  });

  test('requires --issue-number', () => {
    const r = run('worktree', 'discard', '--session-id', 'addon-dev', '--sessions-path', sessionsPath, '--json');
    expect(r.code).toBe(1);
  });

  test('refuses worktree root planted inside the canonical repo root', () => {
    // Write a sessions.json where worktrees.root is inside repoRoot.
    const insideRoot = join(repoRoot, 'internal-worktrees');
    const badSessions = {
      sessions: [
        {
          sessionId: 'addon-dev',
          repoKey: 'test-repo',
          repoRoot,
          githubRepo: 'm2dw/test-repo',
          artifactDir: '.n8n-artifacts',
          baseBranch: 'main',
          defaults: { implementationAgent: 'claude', reviewAgent: 'codex' },
          verification: { test: 'npm test' },
          labels: { active: 'ai:active', blocked: 'ai:blocked', readyForHuman: 'ai:ready-for-human' },
          worktrees: { enabled: true, root: insideRoot },
        },
      ],
    };
    const badSessionsPath = join(tmpDir, 'sessions-inside.json');
    writeFileSync(badSessionsPath, JSON.stringify(badSessions, null, 2));

    const r = run(
      'worktree', 'discard',
      '--session-id', 'addon-dev',
      '--sessions-path', badSessionsPath,
      '--lock-dir', lockDir,
      '--issue-number', '501',
      '--json',
    );
    expect(r.code).toBe(1);
    const out = JSON.parse(r.stdout.trim());
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/inside the canonical repository root/);
  });

  test('refuses when session has worktrees.enabled: false', () => {
    const disabledSessions = {
      sessions: [
        {
          sessionId: 'addon-dev',
          repoKey: 'test-repo',
          repoRoot,
          githubRepo: 'm2dw/test-repo',
          artifactDir: '.n8n-artifacts',
          baseBranch: 'main',
          defaults: { implementationAgent: 'claude', reviewAgent: 'codex' },
          verification: { test: 'npm test' },
          labels: { active: 'ai:active', blocked: 'ai:blocked', readyForHuman: 'ai:ready-for-human' },
          worktrees: { enabled: false, root: worktreeRoot },
        },
      ],
    };
    const disabledSessionsPath = join(tmpDir, 'sessions-disabled.json');
    writeFileSync(disabledSessionsPath, JSON.stringify(disabledSessions, null, 2));

    const r = run(
      'worktree', 'discard',
      '--session-id', 'addon-dev',
      '--sessions-path', disabledSessionsPath,
      '--lock-dir', lockDir,
      '--issue-number', '601',
      '--json',
    );
    expect(r.code).toBe(1);
    const out = JSON.parse(r.stdout.trim());
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/worktrees are not enabled/);
  });

  test('refuses when session omits the worktrees key entirely', () => {
    const noWorktreesSessions = {
      sessions: [
        {
          sessionId: 'addon-dev',
          repoKey: 'test-repo',
          repoRoot,
          githubRepo: 'm2dw/test-repo',
          artifactDir: '.n8n-artifacts',
          baseBranch: 'main',
          defaults: { implementationAgent: 'claude', reviewAgent: 'codex' },
          verification: { test: 'npm test' },
          labels: { active: 'ai:active', blocked: 'ai:blocked', readyForHuman: 'ai:ready-for-human' },
        },
      ],
    };
    const noWorktreesSessionsPath = join(tmpDir, 'sessions-no-worktrees.json');
    writeFileSync(noWorktreesSessionsPath, JSON.stringify(noWorktreesSessions, null, 2));

    const r = run(
      'worktree', 'discard',
      '--session-id', 'addon-dev',
      '--sessions-path', noWorktreesSessionsPath,
      '--lock-dir', lockDir,
      '--issue-number', '602',
      '--json',
    );
    expect(r.code).toBe(1);
    const out = JSON.parse(r.stdout.trim());
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/worktrees are not enabled/);
  });

  test('fails closed when git status cannot inspect the worktree (probe returns ok:false)', () => {
    const wt = createIssueWorktree(502);
    // Remove the worktree directory without unregistering it from git so that
    // git status --porcelain will fail (ENOENT on the cwd).
    rmSync(wt.path, { recursive: true, force: true });

    const r = discard('--issue-number', '502');
    expect(r.code).toBe(1);
    const out = JSON.parse(r.stdout.trim());
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/Failed to inspect worktree status/);
  });

  // A prUrl-only handoff records only prUrl in context.branch is absent; the
  // actual branch must be read from dirtyContinuation.branch (set by the impl
  // handler to fixPr.headRefName ?? conventionalBranch).
  test('accepts a non-conventional PR head branch from dirtyContinuation.branch when context.branch is absent', async () => {
    const customBranch = 'feature/custom-pr-head-702';
    const wt = resolveIssueWorktree({
      repoRoot,
      sessionId: 'addon-dev',
      issueNumber: 702,
      branch: customBranch,
      baseRef: 'main',
      worktreeRoot,
    });
    expect(wt.ok).toBe(true);
    // Enqueue with prUrl only — no context.branch, mirroring a prUrl-only handoff.
    await enqueue(702, {
      prUrl: 'https://github.com/m2dw/test-repo/pull/42',
      dirtyContinuation: { branch: customBranch, phase: 'implementation', issueNumber: 702 },
    });

    writeFileSync(join(wt.path, 'dirty702.txt'), 'untracked\n');

    const r = discard('--issue-number', '702');
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.ok).toBe(true);
    expect(out.wouldDiscard).toBe(true);
    expect(out.dirty).toBe(true);
    expect(out.branch).toBe(customBranch);
    expect(out.untrackedFiles).toContain('dirty702.txt');
  });

  // Fix/review/conflict flows can check out a live PR head whose branch name is
  // not the conventional ai/issue-<n>. The discard command must accept such a
  // worktree by reading the branch recorded in task context rather than
  // hard-coding the conventional name.
  test('accepts a non-conventional PR head branch recorded in task context', async () => {
    const customBranch = 'fix/custom-branch-701';
    const wt = resolveIssueWorktree({
      repoRoot,
      sessionId: 'addon-dev',
      issueNumber: 701,
      branch: customBranch,
      baseRef: 'main',
      worktreeRoot,
    });
    expect(wt.ok).toBe(true);
    // Record the non-conventional branch in the task context, mirroring what
    // fix/review/conflict handlers write to context.branch.
    await enqueue(701, { branch: customBranch });

    writeFileSync(join(wt.path, 'dirty.txt'), 'untracked\n');

    const r = discard('--issue-number', '701');
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.ok).toBe(true);
    expect(out.wouldDiscard).toBe(true);
    expect(out.dirty).toBe(true);
    expect(out.branch).toBe(customBranch);
    expect(out.untrackedFiles).toContain('dirty.txt');
  });
});
