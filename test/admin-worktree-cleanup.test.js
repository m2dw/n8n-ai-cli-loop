import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import {
  resolveIssueWorktree,
  issueWorktreePath,
  researchWorktreePath,
  canonicalizePath,
  SqliteTaskStore,
  IssueWorktreeLock,
} from '../dist/index.js';

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
        worktrees: { root: worktreeRoot },
      },
    ],
  };
  writeFileSync(sessionsPath, JSON.stringify(sessions, null, 2));
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'admin-wt-cleanup-test-'));
  repoRoot = join(tmpDir, 'repo');
  worktreeRoot = join(tmpDir, 'state', 'worktrees');
  sessionsPath = join(tmpDir, 'sessions.json');
  dbPath = join(tmpDir, 'dev_loop.db');
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

/**
 * Materialize a leaked per-run research checkout: a detached worktree at the
 * `issue-<n>/research-<runId>` path, exactly what `prepareResearchWorkspace`
 * creates and what a killed research process leaves behind. Created with plain
 * git rather than through the handler so the fixture needs no `origin` remote.
 */
function createResearchWorktree(issueNumber, runId) {
  const path = researchWorktreePath(worktreeRoot, 'addon-dev', issueNumber, runId);
  mkdirSync(dirname(path), { recursive: true });
  const head = git(['rev-parse', 'HEAD'], repoRoot).trim();
  git(['worktree', 'add', '--detach', path, head], repoRoot);
  return canonicalizePath(path);
}

async function enqueue(issueNumber, status) {
  const store = new SqliteTaskStore(dbPath);
  try {
    await store.enqueueTask({ sessionId: 'addon-dev', issueNumber, phase: 'implementation', implementationAgent: 'claude' });
    if (status && status !== 'queued') {
      await store.transitionTask(
        { sessionId: 'addon-dev', issueNumber },
        { status: 'queued' },
        { status, phase: 'implementation' },
      );
    }
  } finally {
    store.close();
  }
}

function cleanup(...extra) {
  return run('worktree', 'cleanup', '--session-id', 'addon-dev', '--sessions-path', sessionsPath, '--db-path', dbPath, '--lock-dir', lockDir, ...extra);
}

describe('admin worktree cleanup', () => {
  test('dry-run by default: reports candidates and removes nothing', async () => {
    const wt = createIssueWorktree(101); // orphaned (no task row)
    await enqueue(202, 'done');
    const wt2 = createIssueWorktree(202); // terminal

    const r = cleanup();
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.dryRun).toBe(true);
    expect(out.examined).toBe(2);
    expect(out.wouldRemove.map((i) => i.issueNumber).sort()).toEqual([101, 202]);
    // Nothing actually removed.
    expect(existsSync(wt.path)).toBe(true);
    expect(existsSync(wt2.path)).toBe(true);
  });

  test('skips a worktree backing an active task', async () => {
    const wt = createIssueWorktree(303);
    await enqueue(303, 'running');

    const r = cleanup('--yes');
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.removed).toEqual([]);
    const skipped = out.skipped.find((i) => i.issueNumber === 303);
    expect(skipped.classification).toBe('active');
    expect(skipped.reason).toMatch(/active task/);
    expect(existsSync(wt.path)).toBe(true);
  });

  test('prunes a terminal worktree (issue done, clean, pushed)', async () => {
    const wt = createIssueWorktree(404);
    await enqueue(404, 'done');

    const r = cleanup('--yes');
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.removed.map((i) => i.issueNumber)).toEqual([404]);
    expect(out.removed[0].classification).toBe('terminal');
    expect(existsSync(wt.path)).toBe(false);
  });

  test('skips a dirty worktree unless --force', async () => {
    const wt = createIssueWorktree(505);
    await enqueue(505, 'done');
    writeFileSync(join(wt.path, 'dirty.txt'), 'x');

    const skip = cleanup('--yes');
    expect(skip.code).toBe(0);
    const skipOut = JSON.parse(skip.stdout.trim());
    expect(skipOut.removed).toEqual([]);
    const item = skipOut.skipped.find((i) => i.issueNumber === 505);
    expect(item.dirty).toBe(true);
    expect(item.reason).toMatch(/dirty/);
    expect(existsSync(wt.path)).toBe(true);

    const forced = cleanup('--yes', '--force');
    expect(forced.code).toBe(0);
    const forcedOut = JSON.parse(forced.stdout.trim());
    expect(forcedOut.removed.map((i) => i.issueNumber)).toEqual([505]);
    expect(existsSync(wt.path)).toBe(false);
  });

  test('skips a worktree whose branch has unpushed commits unless --force', async () => {
    const wt = createIssueWorktree(606);
    await enqueue(606, 'done');
    // Commit on the issue branch inside the worktree; there is no origin, so the
    // commit is local-only (unpushed).
    writeFileSync(join(wt.path, 'work.txt'), 'progress');
    git(['add', '-A'], wt.path);
    git(['commit', '-q', '-m', 'wip'], wt.path);

    const skip = cleanup('--yes');
    expect(skip.code).toBe(0);
    const skipOut = JSON.parse(skip.stdout.trim());
    expect(skipOut.removed).toEqual([]);
    const item = skipOut.skipped.find((i) => i.issueNumber === 606);
    expect(item.unpushedCommits).toBe(true);
    expect(item.dirty).toBe(false);
    expect(item.reason).toMatch(/unpushed/);
    expect(existsSync(wt.path)).toBe(true);

    const forced = cleanup('--yes', '--force');
    expect(forced.code).toBe(0);
    const forcedOut = JSON.parse(forced.stdout.trim());
    expect(forcedOut.removed.map((i) => i.issueNumber)).toEqual([606]);
    expect(existsSync(wt.path)).toBe(false);
  });

  test('skips a worktree with a live issue lock', async () => {
    const wt = createIssueWorktree(707);
    await enqueue(707, 'done');
    const lock = new IssueWorktreeLock(lockDir);
    lock.acquire('owner-ctx', 'addon-dev', 707);

    const r = cleanup('--yes');
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.removed).toEqual([]);
    const item = out.skipped.find((i) => i.issueNumber === 707);
    expect(item.lockHeld).toBe(true);
    expect(item.reason).toMatch(/locked/);
    expect(existsSync(wt.path)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Leaked per-run research checkouts (issue #855). A research run that is
  // killed between `git worktree add` and its own cleanup leaves a
  // `research-<runId>` directory that nothing else can reclaim: a retry gets a
  // new run id, so it creates a new path. These pin that such a checkout is
  // reachable by cleanup even while its issue's task is still active, and that
  // the live issue lock is still the interlock protecting a run in flight.
  // -------------------------------------------------------------------------

  test('removes a leaked research checkout even while the issue task is active', async () => {
    const research = createResearchWorktree(808, 'run-855-crashed');
    await enqueue(808, 'running');
    const durable = createIssueWorktree(808);

    const r = cleanup('--yes');
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout.trim());

    const removed = out.removed.find((i) => i.path === research);
    expect(removed).toBeDefined();
    expect(removed.kind).toBe('research');
    expect(removed.runId).toBe('run-855-crashed');
    expect(removed.classification).toBe('research-leaked');
    expect(existsSync(research)).toBe(false);

    // The durable worktree of the same in-flight issue must be untouched: the
    // per-run checkout is disposable, the issue's own worktree is not.
    const skipped = out.skipped.find((i) => i.path === canonicalizePath(durable.path));
    expect(skipped.classification).toBe('active');
    expect(existsSync(durable.path)).toBe(true);
  }, 30_000);

  test('removes a leaked research checkout with agent scratch without --force', async () => {
    // A crashed run's checkout is normally dirty (agent scratch). The dirty
    // guard protects branch work; a detached read-only research checkout has
    // none, so it must not force the operator into a second --force run.
    const research = createResearchWorktree(818, 'run-855-dirty');
    writeFileSync(join(research, 'scratch.txt'), 'agent scratch\n');
    await enqueue(818, 'queued');

    const r = cleanup('--yes');
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    const removed = out.removed.find((i) => i.path === research);
    expect(removed).toBeDefined();
    expect(removed.dirty).toBe(true); // reported honestly, but does not gate
    expect(existsSync(research)).toBe(false);
  }, 30_000);

  test('skips a leaked research checkout while the issue lock is live', async () => {
    const research = createResearchWorktree(828, 'run-855-inflight');
    await enqueue(828, 'running');
    const lock = new IssueWorktreeLock(lockDir);
    lock.acquire('owner-ctx', 'addon-dev', 828);

    const r = cleanup('--yes');
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.removed).toEqual([]);
    const item = out.skipped.find((i) => i.path === research);
    expect(item.lockHeld).toBe(true);
    expect(item.reason).toMatch(/locked/);
    expect(existsSync(research)).toBe(true);
  }, 30_000);

  test('fails the command when a remove candidate cannot be removed', () => {
    // Orphaned (no task row) and clean, so it classifies as a remove candidate.
    // Git-lock it AFTER classification's view so `git worktree remove` (without
    // --force) fails — the same shape as a worktree that becomes locked/dirty or
    // whose permissions change after classification.
    const wt = createIssueWorktree(606);
    git(['worktree', 'lock', wt.path], repoRoot);

    const r = cleanup('--yes');
    // Reporting per-item errors must not exit 0, or scripts treat the prune as
    // fully successful.
    expect(r.code).toBe(1);
    const out = JSON.parse(r.stdout.trim());
    expect(out.ok).toBe(false);
    expect(out.removed).toEqual([]);
    expect(out.errors).toHaveLength(1);
    expect(out.errors[0].issueNumber).toBe(606);
    // The worktree is still on disk because removal failed.
    expect(existsSync(wt.path)).toBe(true);
  });

  test('rejects unknown flags (fail fast)', () => {
    const r = cleanup('--forse');
    expect(r.code).toBe(1);
    const out = JSON.parse(r.stdout.trim());
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/Unknown option/);
  });

  test('requires --session-id', () => {
    const r = run('worktree', 'cleanup', '--sessions-path', sessionsPath);
    expect(r.code).toBe(1);
  });
});

describe('admin worktree release-lock', () => {
  test('missing lock is a safe no-op', () => {
    const r = run('worktree', 'release-lock', '--session-id', 'addon-dev', '--issue-number', '808', '--lock-dir', lockDir, '--yes');
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.released).toBe(false);
    expect(out.reason).toBe('no_lock');
  });

  test('refuses a live lock without --force', () => {
    const lock = new IssueWorktreeLock(lockDir);
    lock.acquire('owner-ctx', 'addon-dev', 909);

    const r = run('worktree', 'release-lock', '--session-id', 'addon-dev', '--issue-number', '909', '--lock-dir', lockDir, '--yes');
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.released).toBe(false);
    expect(out.reason).toBe('lock_held');
    // Still held.
    expect(lock.inspect('addon-dev', 909).locked).toBe(true);
  });

  test('releases a stale lock with --yes', () => {
    // Staleness is judged by the inspecting process's TTL (24h default), so make
    // the lock genuinely old by backdating its startedAt rather than shrinking
    // the TTL (which the CLI process would not see).
    const lock = new IssueWorktreeLock(lockDir);
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    lock.acquire('owner-ctx', 'addon-dev', 1001, old);
    expect(lock.inspect('addon-dev', 1001).stale).toBe(true);

    const preview = run('worktree', 'release-lock', '--session-id', 'addon-dev', '--issue-number', '1001', '--lock-dir', lockDir);
    expect(preview.code).toBe(0);
    expect(JSON.parse(preview.stdout.trim()).wouldRelease).toBe(true);

    const r = run('worktree', 'release-lock', '--session-id', 'addon-dev', '--issue-number', '1001', '--lock-dir', lockDir, '--yes');
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.released).toBe(true);
    expect(lock.inspect('addon-dev', 1001).contextId).toBe(null);
  });

  test('rejects unknown flags (fail fast)', () => {
    const r = run('worktree', 'release-lock', '--session-id', 'addon-dev', '--issue-number', '1', '--bogus');
    expect(r.code).toBe(1);
  });
});
