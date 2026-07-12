import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SqliteTaskStore } from '../dist/index.js';

const CLI = new URL('../dist/cli/admin.js', import.meta.url).pathname;

let tmpDir;
let dbPath;
let sessionsPath;

function run(...args) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
    return { code: 0, stdout };
  } catch (err) {
    return { code: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

function parse(result) {
  return JSON.parse(result.stdout.trim());
}

function writeSessions() {
  writeFileSync(sessionsPath, JSON.stringify({
    sessions: [{
      sessionId: 'test-session',
      repoRoot: tmpDir,
      githubRepo: 'test/repo',
      artifactDir: '.n8n-artifacts',
      baseBranch: 'main',
      labels: { active: 'ai:active', blocked: 'ai:blocked', readyForHuman: 'ai:ready-for-human' },
    }],
  }));
}

async function enqueueTask(issueNumber) {
  const store = new SqliteTaskStore(dbPath);
  try {
    await store.enqueueTask({
      sessionId: 'test-session',
      issueNumber,
      phase: 'implementation',
      context: {},
    });
  } finally {
    store.close();
  }
}

async function setNotBefore(issueNumber, notBefore) {
  const store = new SqliteTaskStore(dbPath);
  try {
    const res = await store.transitionTask(
      { sessionId: 'test-session', issueNumber },
      { status: 'queued' },
      { notBefore, now: new Date().toISOString() },
    );
    if (!res.ok) throw new Error(`transitionTask failed: ${res.code}`);
  } finally {
    store.close();
  }
}

async function claimTask(issueNumber) {
  const store = new SqliteTaskStore(dbPath);
  try {
    const res = await store.transitionTask(
      { sessionId: 'test-session', issueNumber },
      { status: 'queued' },
      {
        status: 'claimed',
        ownerRunId: 'test-run',
        leaseExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        now: new Date().toISOString(),
      },
    );
    if (!res.ok) throw new Error(`claimTask transition failed: ${res.code}`);
  } finally {
    store.close();
  }
}

async function getTask(issueNumber) {
  const store = new SqliteTaskStore(dbPath);
  try {
    return await store.getTask({ sessionId: 'test-session', issueNumber });
  } finally {
    store.close();
  }
}

function clearDelay(...extra) {
  return run(
    'task', 'clear-delay',
    '--session-id', 'test-session',
    '--issue-number', '1',
    '--db-path', dbPath,
    '--sessions-path', sessionsPath,
    '--json',
    ...extra,
  );
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'admin-task-clear-delay-test-'));
  dbPath = join(tmpDir, 'loop.db');
  sessionsPath = join(tmpDir, 'sessions.json');
  writeSessions();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const FUTURE = new Date(Date.now() + 60 * 60 * 1000).toISOString();

describe('admin task clear-delay', () => {
  test('preview mode (no --yes) shows what would be cleared without mutating', async () => {
    await enqueueTask(1);
    await setNotBefore(1, FUTURE);

    const r = clearDelay();
    expect(r.code).toBe(0);
    const out = parse(r);
    expect(out.ok).toBe(true);
    expect(out.cleared).toBe(false);
    expect(out.wouldClear).toBe(true);
    expect(out.previousNotBefore).toBe(FUTURE);

    // Task should not have been mutated
    const task = await getTask(1);
    expect(task?.notBefore).toBe(FUTURE);
  });

  test('confirmed execution (--yes) clears not_before and task is runnable', async () => {
    await enqueueTask(1);
    await setNotBefore(1, FUTURE);

    const r = clearDelay('--yes');
    expect(r.code).toBe(0);
    const out = parse(r);
    expect(out.ok).toBe(true);
    expect(out.cleared).toBe(true);
    expect(out.previousNotBefore).toBe(FUTURE);
    expect(out.notBefore).toBeNull();

    // Task should now have no delay
    const task = await getTask(1);
    expect(task?.notBefore).toBeUndefined();
  });

  test('already-clear no-op: returns ok when not_before is already null', async () => {
    await enqueueTask(1);
    // No not_before set

    const r = clearDelay('--yes');
    expect(r.code).toBe(0);
    const out = parse(r);
    expect(out.ok).toBe(true);
    expect(out.cleared).toBe(false);
    expect(out.reason).toBe('already_clear');
  });

  test('missing task returns non-zero exit', () => {
    // No task enqueued
    const r = clearDelay('--yes');
    expect(r.code).not.toBe(0);
    const out = parse(r);
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('not_found');
  });

  test('claimed task is refused', async () => {
    await enqueueTask(1);
    await claimTask(1);

    const r = clearDelay('--yes');
    expect(r.code).not.toBe(0);
    const out = parse(r);
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('active_task');
    expect(out.taskStatus).toBe('claimed');
  });

  test('human-readable output (no --json) shows preview text with --yes hint', async () => {
    await enqueueTask(1);
    await setNotBefore(1, FUTURE);

    const r = run(
      'task', 'clear-delay',
      '--session-id', 'test-session',
      '--issue-number', '1',
      '--db-path', dbPath,
      '--sessions-path', sessionsPath,
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Preview');
    expect(r.stdout).toContain('--yes');
  });

  test('--session-id is required', () => {
    const r = run(
      'task', 'clear-delay',
      '--issue-number', '1',
      '--db-path', dbPath,
      '--json',
    );
    expect(r.code).not.toBe(0);
    const out = parse(r);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/session/i);
  });

  test('--issue-number is required', () => {
    const r = run(
      'task', 'clear-delay',
      '--session-id', 'test-session',
      '--db-path', dbPath,
      '--json',
    );
    expect(r.code).not.toBe(0);
    const out = parse(r);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/issue-number/i);
  });
});
