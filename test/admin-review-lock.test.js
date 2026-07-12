import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { IssueWorktreeLock, issueLockScope } from '../dist/index.js';

// Operator recovery for the lock a worktree-enabled review holds (issue #459).
// Worktree-safe review (issue #456) serializes on the per-issue worktree lock
// (scope <session>::issue-<n>); `review-lock status|release` is the review-named
// entry point to inspect and force-release that exact lock. These tests cover
// the canonical/session review-lock release path AND assert the existing
// issue-scoped `worktree release-lock` behavior is unchanged (regression).

const CLI = new URL('../dist/cli/admin.js', import.meta.url).pathname;

let tmpDir;
let lockDir;

function run(...args) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
    return { code: 0, stdout };
  } catch (err) {
    return { code: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'admin-review-lock-test-'));
  lockDir = join(tmpDir, 'state', 'worktree-locks');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('admin review-lock status', () => {
  test('reports an unheld review lock with its scope', () => {
    const r = run('review-lock', 'status', '--session-id', 'addon-dev', '--issue-number', '42', '--lock-dir', lockDir);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.lockKind).toBe('review');
    expect(out.reviewLockScope).toBe(issueLockScope('addon-dev', 42));
    expect(out.reviewLockScope).toBe('addon-dev::issue-42');
    expect(out.held).toBe(false);
    expect(out.locked).toBe(false);
    expect(out.ownerContextId).toBe(null);
  });

  test('reports a held review lock with its owner', () => {
    const lock = new IssueWorktreeLock(lockDir);
    lock.acquire('review-ctx', 'addon-dev', 77);

    const r = run('review-lock', 'status', '--session-id', 'addon-dev', '--issue-number', '77', '--lock-dir', lockDir);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.lockKind).toBe('review');
    expect(out.reviewLockScope).toBe('addon-dev::issue-77');
    expect(out.held).toBe(true);
    expect(out.locked).toBe(true);
    expect(out.ownerContextId).toBe('review-ctx');
  });

  test('requires --issue-number', () => {
    const r = run('review-lock', 'status', '--session-id', 'addon-dev', '--lock-dir', lockDir);
    expect(r.code).toBe(1);
  });

  test('rejects unknown flags (fail fast)', () => {
    const r = run('review-lock', 'status', '--session-id', 'addon-dev', '--issue-number', '1', '--bogus');
    expect(r.code).toBe(1);
  });
});

describe('admin review-lock release', () => {
  test('missing lock is a safe no-op', () => {
    const r = run('review-lock', 'release', '--session-id', 'addon-dev', '--issue-number', '808', '--lock-dir', lockDir, '--yes');
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.lockKind).toBe('review');
    expect(out.reviewLockScope).toBe('addon-dev::issue-808');
    expect(out.released).toBe(false);
    expect(out.reason).toBe('no_lock');
  });

  test('refuses a live lock without --force', () => {
    const lock = new IssueWorktreeLock(lockDir);
    lock.acquire('review-ctx', 'addon-dev', 909);

    const r = run('review-lock', 'release', '--session-id', 'addon-dev', '--issue-number', '909', '--lock-dir', lockDir, '--yes');
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.released).toBe(false);
    expect(out.reason).toBe('lock_held');
    // Still held.
    expect(lock.inspect('addon-dev', 909).locked).toBe(true);
  });

  test('previews then releases a stale review lock with --yes', () => {
    // Staleness is judged by the inspecting process's 24h TTL, so backdate the
    // lock rather than shrinking the TTL (which the CLI process would not see).
    const lock = new IssueWorktreeLock(lockDir);
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    lock.acquire('review-ctx', 'addon-dev', 1001, old);
    expect(lock.inspect('addon-dev', 1001).stale).toBe(true);

    const preview = run('review-lock', 'release', '--session-id', 'addon-dev', '--issue-number', '1001', '--lock-dir', lockDir);
    expect(preview.code).toBe(0);
    const previewOut = JSON.parse(preview.stdout.trim());
    expect(previewOut.wouldRelease).toBe(true);
    expect(previewOut.released).toBe(false);
    // Preview must not mutate the lock.
    expect(lock.inspect('addon-dev', 1001).contextId).toBe('review-ctx');

    const r = run('review-lock', 'release', '--session-id', 'addon-dev', '--issue-number', '1001', '--lock-dir', lockDir, '--yes');
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.lockKind).toBe('review');
    expect(out.reviewLockScope).toBe('addon-dev::issue-1001');
    expect(out.released).toBe(true);
    expect(out.wasStale).toBe(true);
    expect(lock.inspect('addon-dev', 1001).contextId).toBe(null);
  });

  test('force-releases a live lock with --force --yes', () => {
    const lock = new IssueWorktreeLock(lockDir);
    lock.acquire('review-ctx', 'addon-dev', 1212);
    expect(lock.inspect('addon-dev', 1212).locked).toBe(true);

    const r = run('review-lock', 'release', '--session-id', 'addon-dev', '--issue-number', '1212', '--lock-dir', lockDir, '--force', '--yes');
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.released).toBe(true);
    expect(out.wasStale).toBe(false);
    expect(lock.inspect('addon-dev', 1212).contextId).toBe(null);
  });

  test('requires --issue-number', () => {
    const r = run('review-lock', 'release', '--session-id', 'addon-dev', '--lock-dir', lockDir, '--yes');
    expect(r.code).toBe(1);
  });

  test('rejects unknown flags (fail fast)', () => {
    const r = run('review-lock', 'release', '--session-id', 'addon-dev', '--issue-number', '1', '--bogus');
    expect(r.code).toBe(1);
  });

  test('unknown review-lock action exits non-zero', () => {
    const r = run('review-lock', 'bogus', '--session-id', 'addon-dev', '--issue-number', '1');
    expect(r.code).toBe(1);
  });
});

describe('review-lock and worktree release-lock share one issue-scoped lock', () => {
  test('review-lock releases the lock that worktree release-lock then sees as gone', () => {
    const lock = new IssueWorktreeLock(lockDir);
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    lock.acquire('review-ctx', 'addon-dev', 2002, old);

    const released = run('review-lock', 'release', '--session-id', 'addon-dev', '--issue-number', '2002', '--lock-dir', lockDir, '--yes');
    expect(JSON.parse(released.stdout.trim()).released).toBe(true);

    // The same lock scope is now empty from worktree release-lock's view.
    const wt = run('worktree', 'release-lock', '--session-id', 'addon-dev', '--issue-number', '2002', '--lock-dir', lockDir, '--yes');
    expect(wt.code).toBe(0);
    const wtOut = JSON.parse(wt.stdout.trim());
    expect(wtOut.released).toBe(false);
    expect(wtOut.reason).toBe('no_lock');
  });

  test('regression: worktree release-lock still releases an issue-scoped lock unchanged', () => {
    const lock = new IssueWorktreeLock(lockDir);
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    lock.acquire('impl-ctx', 'addon-dev', 3003, old);
    expect(lock.inspect('addon-dev', 3003).stale).toBe(true);

    const wt = run('worktree', 'release-lock', '--session-id', 'addon-dev', '--issue-number', '3003', '--lock-dir', lockDir, '--yes');
    expect(wt.code).toBe(0);
    const wtOut = JSON.parse(wt.stdout.trim());
    expect(wtOut.released).toBe(true);
    expect(wtOut.wasStale).toBe(true);
    // worktree release-lock output stays issue-scoped (no review labels).
    expect(wtOut.lockKind).toBeUndefined();
    expect(wtOut.reviewLockScope).toBeUndefined();
    expect(lock.inspect('addon-dev', 3003).contextId).toBe(null);
  });
});
