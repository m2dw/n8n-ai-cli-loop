import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SqliteTaskStore, SqliteOutboxStore } from '../dist/index.js';

// Issue #608 — `admin task cancel`: first-class, terminal task cancellation
// with preview-by-default / --yes confirmation, and `admin task
// reconcile-closed` for closed-Issue reconciliation.

const CLI = new URL('../dist/cli/admin.js', import.meta.url).pathname;

let tmpDir;
let dbPath;
let sessionsPath;

function run(...args) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
    return { code: 0, stdout };
  } catch (err) {
    return { code: err.status ?? 1, stdout: err.stdout ?? '' };
  }
}

function parse(result) {
  return JSON.parse(result.stdout.trim());
}

function writeSession(overrides = {}) {
  const session = {
    sessionId: 'addon-dev',
    repoKey: 'some-repo',
    repoRoot: join(tmpDir, 'repo'),
    githubRepo: 'm2dw/some-repo',
    artifactDir: '.n8n-artifacts',
    defaults: { implementationAgent: 'claude', reviewAgent: 'codex' },
    verification: {},
    labels: { active: 'ai:active', blocked: 'ai:blocked', readyForHuman: 'ai:ready-for-human' },
    ...overrides,
  };
  writeFileSync(sessionsPath, JSON.stringify({ sessions: [session] }), 'utf8');
  return session;
}

async function seedTask(issueNumber, { phase = 'implementation', status, ownerRunId } = {}) {
  const store = new SqliteTaskStore(dbPath);
  await store.enqueueTask({ sessionId: 'addon-dev', issueNumber, phase, now: '2026-07-01T00:00:00.000Z' });
  if (status === 'claimed' || status === 'running') {
    await store.claimNextTask({
      sessionId: 'addon-dev', workerId: 'w', runId: ownerRunId ?? 'run-1',
      now: '2026-07-01T00:01:00.000Z', leaseMs: 600000,
    });
    if (status === 'running') {
      await store.transitionTask(
        { sessionId: 'addon-dev', issueNumber },
        { status: 'claimed' },
        { status: 'running', now: '2026-07-01T00:01:30.000Z' },
      );
    }
  } else if (status === 'blocked') {
    await store.transitionTask(
      { sessionId: 'addon-dev', issueNumber },
      { status: 'queued' },
      { status: 'blocked', phase, now: '2026-07-01T00:01:00.000Z' },
    );
  } else if (status === 'ready_for_human') {
    await store.transitionTask(
      { sessionId: 'addon-dev', issueNumber },
      { status: 'queued' },
      { status: 'ready_for_human', phase, now: '2026-07-01T00:01:00.000Z' },
    );
  } else if (status === 'done' || status === 'failed') {
    await store.transitionTask(
      { sessionId: 'addon-dev', issueNumber },
      { status: 'queued' },
      { status, now: '2026-07-01T00:01:00.000Z' },
    );
  }
  store.close();
}

async function getTask(issueNumber) {
  const store = new SqliteTaskStore(dbPath);
  const task = await store.getTask({ sessionId: 'addon-dev', issueNumber });
  store.close();
  return task;
}

async function getOutbox() {
  const store = new SqliteOutboxStore(dbPath);
  const entries = await store.listPending();
  store.close();
  return entries;
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'admin-task-cancel-test-'));
  dbPath = join(tmpDir, 'dev_loop.db');
  sessionsPath = join(tmpDir, 'sessions.json');
  writeSession();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Discoverability
// ---------------------------------------------------------------------------

describe('admin CLI — task cancel: discoverability', () => {
  test('appears in "help" listing', () => {
    const r = run('help');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('task cancel');
    expect(r.stdout).toContain('task reconcile-closed');
  });

  test('"help task cancel" shows its options', () => {
    const r = run('help', 'task cancel');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('--issue-number');
    expect(r.stdout).toContain('--reason');
    expect(r.stdout).toContain('--yes');
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe('admin CLI — task cancel: validation', () => {
  test('requires --session-id', () => {
    const r = run('task', 'cancel', '--issue-number', '1', '--db-path', dbPath);
    expect(r.code).toBe(1);
  });

  test('requires --issue-number', () => {
    const r = run('task', 'cancel', '--session-id', 'addon-dev', '--db-path', dbPath, '--sessions-path', sessionsPath);
    expect(r.code).toBe(1);
  });

  test('unknown flag is rejected', () => {
    const r = run(
      'task', 'cancel',
      '--session-id', 'addon-dev', '--issue-number', '1',
      '--sessions-path', sessionsPath, '--db-path', dbPath,
      '--bogus-flag',
    );
    expect(r.code).toBe(1);
  });

  test('unknown sessionId dies cleanly', () => {
    const r = run(
      'task', 'cancel',
      '--session-id', 'no-such-session', '--issue-number', '1',
      '--sessions-path', sessionsPath, '--db-path', dbPath,
    );
    expect(r.code).toBe(1);
  });

  test('missing task reports not_found', () => {
    const r = run(
      'task', 'cancel',
      '--session-id', 'addon-dev', '--issue-number', '999',
      '--sessions-path', sessionsPath, '--db-path', dbPath,
      '--json',
    );
    expect(r.code).toBe(1);
    expect(parse(r)).toMatchObject({ ok: false, reasonCode: 'not_found' });
  });
});

// ---------------------------------------------------------------------------
// Preview by default
// ---------------------------------------------------------------------------

describe('admin CLI — task cancel: preview by default', () => {
  test('without --yes, previews and does not mutate', async () => {
    await seedTask(101, { status: 'queued' });

    const r = run(
      'task', 'cancel',
      '--session-id', 'addon-dev', '--issue-number', '101',
      '--sessions-path', sessionsPath, '--db-path', dbPath,
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Preview');
    expect(r.stdout).toContain('Run with --yes to apply.');

    const task = await getTask(101);
    expect(task.status).toBe('queued');
  });

  test('--json preview reports wouldCancel:true without mutating', async () => {
    await seedTask(102, { status: 'queued' });

    const r = run(
      'task', 'cancel',
      '--session-id', 'addon-dev', '--issue-number', '102',
      '--sessions-path', sessionsPath, '--db-path', dbPath,
      '--json',
    );
    expect(r.code).toBe(0);
    expect(parse(r)).toMatchObject({ ok: true, wouldCancel: true, taskStatus: 'queued' });

    const task = await getTask(102);
    expect(task.status).toBe('queued');
  });

  test('previewing a claimed task surfaces the owner and the safe-boundary warning', async () => {
    await seedTask(103, { status: 'claimed', ownerRunId: 'run-owner-1' });

    const r = run(
      'task', 'cancel',
      '--session-id', 'addon-dev', '--issue-number', '103',
      '--sessions-path', sessionsPath, '--db-path', dbPath,
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('run-owner-1');
    expect(r.stdout).toContain('will NOT force-stop the active run');
  });
});

// ---------------------------------------------------------------------------
// Confirmed cancellation across every non-terminal status
// ---------------------------------------------------------------------------

describe('admin CLI — task cancel: --yes cancels from any non-terminal status', () => {
  test.each(['queued', 'claimed', 'running', 'blocked', 'ready_for_human'])(
    'cancels a %s task',
    async (status) => {
      await seedTask(200, { status });

      const r = run(
        'task', 'cancel',
        '--session-id', 'addon-dev', '--issue-number', '200',
        '--sessions-path', sessionsPath, '--db-path', dbPath,
        '--yes', '--json',
      );
      expect(r.code).toBe(0);
      expect(parse(r)).toMatchObject({ ok: true, cancelled: true });

      const task = await getTask(200);
      expect(task.status).toBe('cancelled');
      expect(task.ownerRunId).toBeUndefined();
    },
  );

  test('records the --reason text on the task event and the operator comment, and posts no label mutation', async () => {
    await seedTask(201, { status: 'queued' });

    const r = run(
      'task', 'cancel',
      '--session-id', 'addon-dev', '--issue-number', '201',
      '--sessions-path', sessionsPath, '--db-path', dbPath,
      '--reason', 'superseded by #999', '--yes',
    );
    expect(r.code).toBe(0);

    const task = await getTask(201);
    expect(task.context.cancelReason).toBe('superseded by #999');

    // Bounded, path-safe, operator-visible — and no label churn (issue #608:
    // cancellation must never look like a GitHub Issue Relationship signal).
    const entries = await getOutbox();
    const forIssue = entries.filter((e) => e.payload.issueNumber === 201);
    expect(forIssue).toHaveLength(1);
    expect(forIssue[0].topic).toBe('gh:comment');
    expect(forIssue[0].payload.body).toContain('superseded by #999');
    expect(entries.some((e) => e.topic.startsWith('gh:label'))).toBe(false);
  });

  // Issue #608 review, P2: an operator-supplied --reason is unbounded input;
  // the queued comment must stay bounded rather than embedding it verbatim.
  test('bounds an oversized --reason in the operator comment', async () => {
    await seedTask(202, { status: 'queued' });
    const hugeReason = 'x'.repeat(5000);

    const r = run(
      'task', 'cancel',
      '--session-id', 'addon-dev', '--issue-number', '202',
      '--sessions-path', sessionsPath, '--db-path', dbPath,
      '--reason', hugeReason, '--yes',
    );
    expect(r.code).toBe(0);

    const entries = await getOutbox();
    const forIssue = entries.filter((e) => e.payload.issueNumber === 202);
    expect(forIssue).toHaveLength(1);
    expect(forIssue[0].payload.body.length).toBeLessThan(hugeReason.length);
    expect(forIssue[0].payload.body).toContain('…(truncated)');
  });
});

// ---------------------------------------------------------------------------
// Terminal-status refusals
// ---------------------------------------------------------------------------

describe('admin CLI — task cancel: terminal-status refusals', () => {
  test('refuses a done task', async () => {
    await seedTask(300, { status: 'done' });

    const r = run(
      'task', 'cancel',
      '--session-id', 'addon-dev', '--issue-number', '300',
      '--sessions-path', sessionsPath, '--db-path', dbPath,
      '--yes', '--json',
    );
    expect(r.code).toBe(1);
    expect(parse(r)).toMatchObject({ ok: false, reasonCode: 'terminal', taskStatus: 'done' });

    const task = await getTask(300);
    expect(task.status).toBe('done');
  });

  test('refuses a failed task', async () => {
    await seedTask(301, { status: 'failed' });

    const r = run(
      'task', 'cancel',
      '--session-id', 'addon-dev', '--issue-number', '301',
      '--sessions-path', sessionsPath, '--db-path', dbPath,
      '--yes', '--json',
    );
    expect(r.code).toBe(1);
    expect(parse(r)).toMatchObject({ ok: false, reasonCode: 'terminal', taskStatus: 'failed' });
  });

  test('repeated cancellation reports already_cancelled deterministically', async () => {
    await seedTask(302, { status: 'queued' });

    const first = run(
      'task', 'cancel',
      '--session-id', 'addon-dev', '--issue-number', '302',
      '--sessions-path', sessionsPath, '--db-path', dbPath,
      '--yes', '--json',
    );
    expect(first.code).toBe(0);
    expect(parse(first)).toMatchObject({ ok: true, cancelled: true });

    const second = run(
      'task', 'cancel',
      '--session-id', 'addon-dev', '--issue-number', '302',
      '--sessions-path', sessionsPath, '--db-path', dbPath,
      '--yes', '--json',
    );
    expect(second.code).toBe(1);
    expect(parse(second)).toMatchObject({ ok: false, reasonCode: 'already_cancelled' });

    const task = await getTask(302);
    expect(task.status).toBe('cancelled');
  });
});

// ---------------------------------------------------------------------------
// task reconcile-closed
// ---------------------------------------------------------------------------

describe('admin CLI — task reconcile-closed', () => {
  test('requires --session-id', () => {
    const r = run('task', 'reconcile-closed', '--db-path', dbPath);
    expect(r.code).toBe(1);
  });

  test('refuses a non-github-issues work-item provider', () => {
    writeSession({ workItemProvider: { provider: 'jira', auth: { mode: 'gh' } } });
    const r = run(
      'task', 'reconcile-closed',
      '--session-id', 'addon-dev',
      '--sessions-path', sessionsPath, '--db-path', dbPath,
    );
    expect(r.code).toBe(1);
    expect(r.stdout.toLowerCase()).toContain('not_planned');
  });

  test('single-issue mode reports not_found for a missing task', () => {
    const r = run(
      'task', 'reconcile-closed',
      '--session-id', 'addon-dev', '--issue-number', '999',
      '--sessions-path', sessionsPath, '--db-path', dbPath,
    );
    expect(r.code).toBe(1);
  });
});
