/**
 * Behavioural coverage of the admin CLI. Since issue #1018 these cases drive the
 * dispatcher in-process through the shared harness instead of spawning a Node
 * process each; the real-executable contract (argv parsing, exit status, stream
 * separation, env isolation) lives in `admin-cli-subprocess.test.js`.
 */
import { jest } from '@jest/globals';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SqliteTaskStore } from '../dist/index.js';
import { CLI_PROBE_INDETERMINATE_MARKER, CLI_PROBE_STUB_ENV } from '../dist/core/cli-probe.js';
import { runAdmin } from './helpers/admin-cli.js';
import { runUntilProbeAnswers } from './helpers/cli-probe.js';

// These cases were synchronous before the #1018 migration, so Jest's 5s default
// could never fire mid-body. They await now, and several still fork real git and
// agent-CLI probes, so give the whole file the same headroom the other
// spawn-touching suites use rather than letting a loaded runner flake.
jest.setTimeout(30_000);

let tmpDir;
let dbPath;
let lockDir;

async function run(...args) {
  return runAdmin(args);
}

// runJson appends --json so the structured stdout contract is exercised even for
// operator-facing commands that now default to human-readable text (issue #308).
async function runJson(...args) {
  return run(...args, '--json');
}

// runFull is retained as an alias: the harness always captures stderr, so the
// distinction the subprocess helper needed no longer exists.
async function runFull(...args) {
  return run(...args);
}

function parse(result) {
  return JSON.parse(result.stdout.trim());
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'admin-cli-test-'));
  dbPath = join(tmpDir, 'dev_loop.db');
  lockDir = join(tmpDir, 'locks');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('admin CLI — help subcommand', () => {
  test('no args exits 0 and prints human-readable help', async () => {
    const r = await run();
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('admin');
    expect(r.stdout).toContain('help');
    expect(r.stdout).toContain('task-status');
  });

  test('"help --json" still prints human-readable help (help is carved out of --json)', async () => {
    const r = await run('help', '--json');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('task-status');
    expect(() => JSON.parse(r.stdout.trim())).toThrow();
  });

  test('"help" subcommand exits 0 and lists all commands', async () => {
    const r = await run('help');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('help');
    expect(r.stdout).toContain('task-status');
    expect(r.stdout).toContain('github-intake');
    expect(r.stdout).toContain('enqueue-task');
    expect(r.stdout).toContain('run-one-phase');
    expect(r.stdout).toContain('dispatch-outbox');
  });

  test('"help <subcommand>" exits 0 and shows options for that subcommand', async () => {
    const r = await run('help', 'task-status');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('task-status');
    expect(r.stdout).toContain('--session-id');
    expect(r.stdout).toContain('--issue-number');
    expect(r.stdout).toContain('--db-path');
  });

  test('"help <unknown>" exits non-zero', async () => {
    const r = await run('help', 'no-such-command');
    expect(r.code).not.toBe(0);
  });
});

describe('admin CLI — unknown subcommand', () => {
  test('unknown subcommand exits non-zero', async () => {
    const r = await run('bogus-command');
    expect(r.code).not.toBe(0);
    expect(parse(r)).toMatchObject({ ok: false, error: expect.stringContaining('bogus-command') });
  });
});

describe('admin CLI — task-status subcommand', () => {
  test('missing --session-id exits non-zero', async () => {
    const r = await runJson('task-status', '--db-path', dbPath);
    expect(r.code).not.toBe(0);
    expect(parse(r)).toMatchObject({ ok: false, error: expect.stringContaining('session-id') });
  });

  test('invalid --issue-number exits non-zero', async () => {
    const r = await runJson('task-status', '--session-id', 'addon-dev', '--issue-number', 'abc', '--db-path', dbPath);
    expect(r.code).not.toBe(0);
    expect(parse(r)).toMatchObject({ ok: false, error: expect.stringContaining('issue-number') });
  });

  test('returns empty task list when no tasks exist', async () => {
    const r = await runJson('task-status', '--session-id', 'addon-dev', '--db-path', dbPath);
    expect(r.code).toBe(0);
    expect(parse(r)).toMatchObject({ ok: true, sessionId: 'addon-dev', tasks: [] });
  });

  test('lists tasks for a session', async () => {
    const store = new SqliteTaskStore(dbPath);
    await store.enqueueTask({ sessionId: 'addon-dev', issueNumber: 10, phase: 'research' });
    await store.enqueueTask({ sessionId: 'addon-dev', issueNumber: 20, phase: 'implementation' });
    store.close();

    const r = await runJson('task-status', '--session-id', 'addon-dev', '--db-path', dbPath);
    expect(r.code).toBe(0);
    const out = parse(r);
    expect(out.ok).toBe(true);
    expect(out.tasks).toHaveLength(2);
    expect(out.tasks[0]).toMatchObject({ sessionId: 'addon-dev', issueNumber: 10, phase: 'research', status: 'queued' });
    expect(out.tasks[1]).toMatchObject({ sessionId: 'addon-dev', issueNumber: 20, phase: 'implementation', status: 'queued' });
  });

  test('--issue-number filters to a single task', async () => {
    const store = new SqliteTaskStore(dbPath);
    await store.enqueueTask({ sessionId: 'addon-dev', issueNumber: 10, phase: 'research' });
    await store.enqueueTask({ sessionId: 'addon-dev', issueNumber: 20, phase: 'implementation' });
    store.close();

    const r = await runJson('task-status', '--session-id', 'addon-dev', '--issue-number', '10', '--db-path', dbPath);
    expect(r.code).toBe(0);
    const out = parse(r);
    expect(out.ok).toBe(true);
    expect(out.issueNumber).toBe(10);
    expect(out.tasks).toHaveLength(1);
    expect(out.tasks[0]).toMatchObject({ issueNumber: 10, phase: 'research' });
  });

  test('--issue-number returns empty list when task does not exist', async () => {
    const r = await runJson('task-status', '--session-id', 'addon-dev', '--issue-number', '999', '--db-path', dbPath);
    expect(r.code).toBe(0);
    const out = parse(r);
    expect(out.ok).toBe(true);
    expect(out.tasks).toHaveLength(0);
  });

  test('does not return tasks from other sessions', async () => {
    const store = new SqliteTaskStore(dbPath);
    await store.enqueueTask({ sessionId: 'session-a', issueNumber: 1, phase: 'research' });
    await store.enqueueTask({ sessionId: 'session-b', issueNumber: 2, phase: 'implementation' });
    store.close();

    const r = await runJson('task-status', '--session-id', 'session-a', '--db-path', dbPath);
    expect(r.code).toBe(0);
    const out = parse(r);
    expect(out.tasks).toHaveLength(1);
    expect(out.tasks[0].sessionId).toBe('session-a');
  });

  test('task entries include expected fields', async () => {
    const store = new SqliteTaskStore(dbPath);
    await store.enqueueTask({ sessionId: 'addon-dev', issueNumber: 5, phase: 'review', priority: 'high' });
    store.close();

    const r = await runJson('task-status', '--session-id', 'addon-dev', '--db-path', dbPath);
    const out = parse(r);
    const task = out.tasks[0];
    expect(task).toHaveProperty('sessionId');
    expect(task).toHaveProperty('issueNumber');
    expect(task).toHaveProperty('status');
    expect(task).toHaveProperty('phase');
    expect(task).toHaveProperty('priority', 'high');
    expect(task).toHaveProperty('createdAt');
    expect(task).toHaveProperty('updatedAt');
  });
});

describe('admin CLI — list-stuck subcommand', () => {
  test('missing --session-id exits non-zero', async () => {
    const r = await runJson('list-stuck', '--db-path', dbPath);
    expect(r.code).not.toBe(0);
    expect(parse(r)).toMatchObject({ ok: false, error: expect.stringContaining('session-id') });
  });

  test('returns empty categories when no tasks exist', async () => {
    const r = await runJson('list-stuck', '--session-id', 'addon-dev', '--db-path', dbPath);
    expect(r.code).toBe(0);
    const out = parse(r);
    expect(out).toMatchObject({
      ok: true,
      sessionId: 'addon-dev',
      summary: { failed: 0, stale: 0, mismatched: 0, noLease: 0, total: 0 },
      failed: [],
      stale: [],
      mismatched: [],
      noLease: [],
    });
  });

  test('identifies failed tasks', async () => {
    const store = new SqliteTaskStore(dbPath);
    await store.enqueueTask({ sessionId: 'addon-dev', issueNumber: 1, phase: 'implementation' });
    await store.transitionTask(
      { sessionId: 'addon-dev', issueNumber: 1 },
      { status: 'queued' },
      { status: 'failed', lastError: 'something went wrong' },
    );
    store.close();

    const r = await runJson('list-stuck', '--session-id', 'addon-dev', '--db-path', dbPath);
    expect(r.code).toBe(0);
    const out = parse(r);
    expect(out.summary.failed).toBe(1);
    expect(out.failed).toHaveLength(1);
    expect(out.failed[0]).toMatchObject({ issueNumber: 1, status: 'failed', lastError: 'something went wrong' });
    expect(out.stale).toHaveLength(0);
    expect(out.mismatched).toHaveLength(0);
  });

  test('identifies stale tasks (claimed with expired lease)', async () => {
    const expiredLease = new Date(Date.now() - 60_000).toISOString();
    const store = new SqliteTaskStore(dbPath);
    await store.enqueueTask({ sessionId: 'addon-dev', issueNumber: 2, phase: 'research' });
    await store.transitionTask(
      { sessionId: 'addon-dev', issueNumber: 2 },
      { status: 'queued' },
      { status: 'claimed', ownerRunId: 'run-abc', leaseExpiresAt: expiredLease },
    );
    store.close();

    const r = await runJson('list-stuck', '--session-id', 'addon-dev', '--db-path', dbPath);
    expect(r.code).toBe(0);
    const out = parse(r);
    expect(out.summary.stale).toBe(1);
    expect(out.stale).toHaveLength(1);
    expect(out.stale[0]).toMatchObject({ issueNumber: 2, status: 'claimed' });
    expect(out.failed).toHaveLength(0);
  });

  test('identifies mismatched task: claimed with no ownerRunId', async () => {
    const futureLease = new Date(Date.now() + 30 * 60_000).toISOString();
    const store = new SqliteTaskStore(dbPath);
    await store.enqueueTask({ sessionId: 'addon-dev', issueNumber: 3, phase: 'review' });
    // Transition to claimed without setting ownerRunId
    await store.transitionTask(
      { sessionId: 'addon-dev', issueNumber: 3 },
      { status: 'queued' },
      { status: 'claimed', leaseExpiresAt: futureLease },
    );
    store.close();

    const r = await runJson('list-stuck', '--session-id', 'addon-dev', '--db-path', dbPath);
    expect(r.code).toBe(0);
    const out = parse(r);
    expect(out.summary.mismatched).toBe(1);
    expect(out.mismatched).toHaveLength(1);
    expect(out.mismatched[0]).toMatchObject({ issueNumber: 3, status: 'claimed' });
  });

  test('identifies mismatched task: queued with orphaned ownerRunId', async () => {
    const store = new SqliteTaskStore(dbPath);
    await store.enqueueTask({ sessionId: 'addon-dev', issueNumber: 4, phase: 'implementation' });
    await store.transitionTask(
      { sessionId: 'addon-dev', issueNumber: 4 },
      { status: 'queued' },
      { ownerRunId: 'orphaned-run-123' },
    );
    store.close();

    const r = await runJson('list-stuck', '--session-id', 'addon-dev', '--db-path', dbPath);
    expect(r.code).toBe(0);
    const out = parse(r);
    expect(out.summary.mismatched).toBe(1);
    expect(out.mismatched).toHaveLength(1);
    expect(out.mismatched[0]).toMatchObject({ issueNumber: 4, status: 'queued' });
  });

  test('healthy queued tasks do not appear in any category', async () => {
    const store = new SqliteTaskStore(dbPath);
    await store.enqueueTask({ sessionId: 'addon-dev', issueNumber: 5, phase: 'research' });
    store.close();

    const r = await runJson('list-stuck', '--session-id', 'addon-dev', '--db-path', dbPath);
    expect(r.code).toBe(0);
    const out = parse(r);
    expect(out.summary.total).toBe(0);
    expect(out.failed).toHaveLength(0);
    expect(out.stale).toHaveLength(0);
    expect(out.mismatched).toHaveLength(0);
  });

  test('healthy claimed task (active lease, has ownerRunId) is not stuck', async () => {
    const futureLease = new Date(Date.now() + 30 * 60_000).toISOString();
    const store = new SqliteTaskStore(dbPath);
    await store.enqueueTask({ sessionId: 'addon-dev', issueNumber: 6, phase: 'review' });
    await store.transitionTask(
      { sessionId: 'addon-dev', issueNumber: 6 },
      { status: 'queued' },
      { status: 'claimed', ownerRunId: 'run-healthy', leaseExpiresAt: futureLease },
    );
    store.close();

    const r = await runJson('list-stuck', '--session-id', 'addon-dev', '--db-path', dbPath);
    expect(r.code).toBe(0);
    const out = parse(r);
    expect(out.summary.total).toBe(0);
  });

  test('identifies active task with ownerRunId but no lease as noLease', async () => {
    const store = new SqliteTaskStore(dbPath);
    await store.enqueueTask({ sessionId: 'addon-dev', issueNumber: 7, phase: 'implementation' });
    await store.transitionTask(
      { sessionId: 'addon-dev', issueNumber: 7 },
      { status: 'queued' },
      { status: 'claimed', ownerRunId: 'run-nolease' },
    );
    store.close();

    const r = await runJson('list-stuck', '--session-id', 'addon-dev', '--db-path', dbPath);
    expect(r.code).toBe(0);
    const out = parse(r);
    expect(out.summary.noLease).toBe(1);
    expect(out.noLease).toHaveLength(1);
    expect(out.noLease[0]).toMatchObject({ issueNumber: 7, status: 'claimed', ownerRunId: 'run-nolease' });
    expect(out.stale).toHaveLength(0);
    expect(out.mismatched).toHaveLength(0);
  });

  test('output includes now, summary, and all four category arrays', async () => {
    const r = await runJson('list-stuck', '--session-id', 'addon-dev', '--db-path', dbPath);
    expect(r.code).toBe(0);
    const out = parse(r);
    expect(out).toHaveProperty('ok', true);
    expect(out).toHaveProperty('sessionId', 'addon-dev');
    expect(out).toHaveProperty('now');
    expect(out).toHaveProperty('summary');
    expect(out).toHaveProperty('failed');
    expect(out).toHaveProperty('stale');
    expect(out).toHaveProperty('mismatched');
    expect(out).toHaveProperty('noLease');
  });

  test('list-stuck appears in help output', async () => {
    const r = await run('help');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('list-stuck');
  });
});

describe('admin CLI — recover subcommand', () => {
  test('missing --session-id exits non-zero', async () => {
    const r = await runJson('recover', '--db-path', dbPath);
    expect(r.code).not.toBe(0);
    expect(parse(r)).toMatchObject({ ok: false, error: expect.stringContaining('session-id') });
  });

  test('invalid --issue-number exits non-zero', async () => {
    const r = await runJson('recover', '--session-id', 'addon-dev', '--issue-number', 'abc', '--db-path', dbPath);
    expect(r.code).not.toBe(0);
    expect(parse(r)).toMatchObject({ ok: false, error: expect.stringContaining('issue-number') });
  });

  test('invalid --phase exits non-zero', async () => {
    const r = await runJson('recover', '--session-id', 'addon-dev', '--phase', 'bogus-phase', '--db-path', dbPath);
    expect(r.code).not.toBe(0);
    expect(parse(r)).toMatchObject({ ok: false, error: expect.stringContaining('phase') });
  });

  test('returns empty recovered list when no recoverable tasks exist', async () => {
    const r = await runJson('recover', '--session-id', 'addon-dev', '--db-path', dbPath);
    expect(r.code).toBe(0);
    const out = parse(r);
    expect(out).toMatchObject({ ok: true, sessionId: 'addon-dev', recovered: [], skipped: [] });
  });

  // Operator-safety (issue #401): a misspelled --dry-run must fail fast and never
  // be silently dropped, which would turn a preview into a real mutation.
  test.each(['--dry-ru', '--dryrun', '--dry_run'])(
    'typo %s fails and performs no recovery mutation',
    async (typo) => {
      const store = new SqliteTaskStore(dbPath);
      await store.enqueueTask({ sessionId: 'addon-dev', issueNumber: 7, phase: 'implementation' });
      await store.transitionTask(
        { sessionId: 'addon-dev', issueNumber: 7 },
        { status: 'queued' },
        { status: 'failed', lastError: 'boom' },
      );
      store.close();

      const r = await runJson('recover', '--session-id', 'addon-dev', '--db-path', dbPath, typo);
      expect(r.code).not.toBe(0);
      expect(parse(r)).toMatchObject({ ok: false, error: expect.stringContaining(typo.slice(2)) });

      // The task must still be failed — the unknown flag aborted before any mutation.
      const check = new SqliteTaskStore(dbPath);
      const tasks = check.listTasks('addon-dev', 7);
      check.close();
      expect(tasks[0].status).toBe('failed');
    },
  );

  test('--dry-ru error suggests the closest valid option', async () => {
    const r = await runJson('recover', '--session-id', 'addon-dev', '--db-path', dbPath, '--dry-ru');
    expect(r.code).not.toBe(0);
    expect(parse(r).error).toContain('did you mean --dry-run?');
  });

  test('an unknown value-style flag is rejected', async () => {
    const r = await runJson('recover', '--session-id', 'addon-dev', '--db-path', dbPath, '--bogus', 'x');
    expect(r.code).not.toBe(0);
    expect(parse(r)).toMatchObject({ ok: false, error: expect.stringContaining('bogus') });
  });

  test('a value flag with no following value is rejected', async () => {
    const r = await runJson('recover', '--db-path', dbPath, '--session-id');
    expect(r.code).not.toBe(0);
    expect(parse(r)).toMatchObject({ ok: false, error: expect.stringContaining('session-id requires a value') });
  });

  test('recovers a failed task back to queued', async () => {
    const store = new SqliteTaskStore(dbPath);
    await store.enqueueTask({ sessionId: 'addon-dev', issueNumber: 1, phase: 'implementation' });
    await store.transitionTask(
      { sessionId: 'addon-dev', issueNumber: 1 },
      { status: 'queued' },
      { status: 'failed', lastError: 'something went wrong' },
    );
    store.close();

    const r = await runJson('recover', '--session-id', 'addon-dev', '--db-path', dbPath);
    expect(r.code).toBe(0);
    const out = parse(r);
    expect(out.ok).toBe(true);
    expect(out.recovered).toHaveLength(1);
    expect(out.recovered[0]).toMatchObject({ issueNumber: 1, status: 'queued', previousStatus: 'failed' });
  });

  test('--issue-number recovers only the specified task', async () => {
    const store = new SqliteTaskStore(dbPath);
    await store.enqueueTask({ sessionId: 'addon-dev', issueNumber: 1, phase: 'implementation' });
    await store.enqueueTask({ sessionId: 'addon-dev', issueNumber: 2, phase: 'research' });
    await store.transitionTask({ sessionId: 'addon-dev', issueNumber: 1 }, { status: 'queued' }, { status: 'failed', lastError: 'err' });
    await store.transitionTask({ sessionId: 'addon-dev', issueNumber: 2 }, { status: 'queued' }, { status: 'failed', lastError: 'err' });
    store.close();

    const r = await runJson('recover', '--session-id', 'addon-dev', '--issue-number', '1', '--db-path', dbPath);
    expect(r.code).toBe(0);
    const out = parse(r);
    expect(out.recovered).toHaveLength(1);
    expect(out.recovered[0].issueNumber).toBe(1);
  });

  test('--phase overrides the phase when re-queuing', async () => {
    const store = new SqliteTaskStore(dbPath);
    await store.enqueueTask({ sessionId: 'addon-dev', issueNumber: 3, phase: 'implementation' });
    await store.transitionTask({ sessionId: 'addon-dev', issueNumber: 3 }, { status: 'queued' }, { status: 'failed', lastError: 'err' });
    store.close();

    const r = await runJson('recover', '--session-id', 'addon-dev', '--issue-number', '3', '--phase', 'review', '--db-path', dbPath);
    expect(r.code).toBe(0);
    const out = parse(r);
    expect(out.recovered).toHaveLength(1);
    expect(out.recovered[0]).toMatchObject({ phase: 'review', previousPhase: 'implementation' });
  });

  test('--dry-run shows would-recover without changing tasks', async () => {
    const store = new SqliteTaskStore(dbPath);
    await store.enqueueTask({ sessionId: 'addon-dev', issueNumber: 4, phase: 'research' });
    await store.transitionTask({ sessionId: 'addon-dev', issueNumber: 4 }, { status: 'queued' }, { status: 'failed', lastError: 'err' });
    store.close();

    const r = await runJson('recover', '--session-id', 'addon-dev', '--dry-run', '--db-path', dbPath);
    expect(r.code).toBe(0);
    const out = parse(r);
    expect(out.dryRun).toBe(true);
    expect(out.wouldRecover).toHaveLength(1);
    expect(out.wouldRecover[0].issueNumber).toBe(4);

    // Task should still be failed
    const store2 = new SqliteTaskStore(dbPath);
    const task = await store2.getTask({ sessionId: 'addon-dev', issueNumber: 4 });
    store2.close();
    expect(task?.status).toBe('failed');
  });

  test('recover appears in help output', async () => {
    const r = await run('help');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('recover');
  });

  test('"help recover" states that omitting --phase preserves the task\'s current phase', async () => {
    const r = await run('help', 'recover');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("current phase");
  });

  test('invalid --from value exits non-zero', async () => {
    const r = await runJson('recover', '--session-id', 'addon-dev', '--from', 'failed', '--phase', 'review', '--db-path', dbPath);
    expect(r.code).not.toBe(0);
    expect(parse(r)).toMatchObject({ ok: false, error: expect.stringContaining('ready_for_human') });
  });

  test('--from ready_for_human without --phase exits non-zero', async () => {
    const r = await runJson('recover', '--session-id', 'addon-dev', '--from', 'ready_for_human', '--db-path', dbPath);
    expect(r.code).not.toBe(0);
    expect(parse(r)).toMatchObject({ ok: false, error: expect.stringContaining('--phase') });
  });

  test('recover without --from does not touch ready_for_human tasks', async () => {
    const store = new SqliteTaskStore(dbPath);
    await store.enqueueTask({ sessionId: 'addon-dev', issueNumber: 242, phase: 'review' });
    await store.transitionTask(
      { sessionId: 'addon-dev', issueNumber: 242 },
      { status: 'queued' },
      { status: 'ready_for_human' },
    );
    store.close();

    const r = await runJson('recover', '--session-id', 'addon-dev', '--db-path', dbPath);
    expect(r.code).toBe(0);
    const out = parse(r);
    expect(out.recovered).toHaveLength(0);

    const store2 = new SqliteTaskStore(dbPath);
    const task = await store2.getTask({ sessionId: 'addon-dev', issueNumber: 242 });
    store2.close();
    expect(task?.status).toBe('ready_for_human');
  });

  test('--from ready_for_human --phase conflict_resolution requeues a ready_for_human / review task (#242 style)', async () => {
    const store = new SqliteTaskStore(dbPath);
    await store.enqueueTask({ sessionId: 'addon-dev', issueNumber: 242, phase: 'review' });
    await store.transitionTask(
      { sessionId: 'addon-dev', issueNumber: 242 },
      { status: 'queued' },
      { status: 'ready_for_human' },
    );
    store.close();

    const r = await runJson('recover', '--session-id', 'addon-dev', '--issue-number', '242',
      '--from', 'ready_for_human', '--phase', 'conflict_resolution', '--db-path', dbPath);
    expect(r.code).toBe(0);
    const out = parse(r);
    expect(out.ok).toBe(true);
    expect(out.recovered).toHaveLength(1);
    expect(out.recovered[0]).toMatchObject({
      issueNumber: 242,
      status: 'queued',
      phase: 'conflict_resolution',
      previousStatus: 'ready_for_human',
      previousPhase: 'review',
    });

    const store2 = new SqliteTaskStore(dbPath);
    const task = await store2.getTask({ sessionId: 'addon-dev', issueNumber: 242 });
    store2.close();
    expect(task?.status).toBe('queued');
    expect(task?.phase).toBe('conflict_resolution');
    expect(task?.ownerRunId).toBeUndefined();
    expect(task?.leaseExpiresAt).toBeUndefined();
    expect(task?.lastError).toBeUndefined();
  });

  // Issue #984: the PIR handoff guidance used to tell operators to dispose of
  // the stranded refinement task row with `admin task cancel` — which leaves a
  // terminal `cancelled` row that ordinary implementation intake
  // (`enqueueTask`) only reactivates from `blocked`, never from `cancelled`,
  // so the Issue could never reach implementation again. The corrected
  // guidance instead points at this same generic `admin recover --from
  // ready_for_human --phase implementation` surface #951's operator used by
  // hand. This test reproduces #951's escalated-refinement shape end to end.
  test('--from ready_for_human --phase implementation moves a PIR-escalated refinement task to queued/implementation and it is claimable (#951/#984)', async () => {
    const store = new SqliteTaskStore(dbPath);
    await store.enqueueTask({
      sessionId: 'addon-dev',
      issueNumber: 951,
      phase: 'refinement',
      context: {
        refinement: {
          state: 'escalated_human',
          handoffReason: 'no_convergence',
          counters: { rounds: 2, malformedAttempts: { refiner: 0, critic: 0 }, agentFailures: { refiner: 0, critic: 0 }, staleRestarts: 0 },
        },
      },
    });
    await store.transitionTask(
      { sessionId: 'addon-dev', issueNumber: 951 },
      { status: 'queued' },
      { status: 'ready_for_human' },
    );
    store.close();

    const r = await runJson('recover', '--session-id', 'addon-dev', '--issue-number', '951',
      '--from', 'ready_for_human', '--phase', 'implementation', '--db-path', dbPath);
    expect(r.code).toBe(0);
    const out = parse(r);
    expect(out.recovered).toHaveLength(1);
    expect(out.recovered[0]).toMatchObject({
      issueNumber: 951,
      status: 'queued',
      phase: 'implementation',
      previousStatus: 'ready_for_human',
      previousPhase: 'refinement',
    });

    const store2 = new SqliteTaskStore(dbPath);
    const task = await store2.getTask({ sessionId: 'addon-dev', issueNumber: 951 });
    expect(task?.status).toBe('queued');
    expect(task?.phase).toBe('implementation');
    // No cancelled row anywhere: the same row that carried the escalation now
    // carries the implementation work.
    expect(task?.context?.refinement?.state).toBe('escalated_human');

    // Claimable by the implementation phase afterward — the acceptance bar
    // `admin task cancel` could never clear, because a cancelled row is
    // terminal and intake cannot reactivate it.
    const claimed = await store2.claimNextTask({
      sessionId: 'addon-dev',
      workerId: 'w1',
      runId: 'run-1',
      supportedPhases: ['implementation'],
    });
    store2.close();
    expect(claimed?.issueNumber).toBe(951);
    expect(claimed?.status).toBe('claimed');
    expect(claimed?.phase).toBe('implementation');
  });

  // Pins the exact failure #984 fixes: following the OLD guidance
  // (`admin task cancel` instead of `admin recover`) leaves a terminal row
  // that ordinary implementation intake cannot reactivate, permanently
  // stranding the Issue even though its labels look executable.
  test('the old guidance (admin task cancel) is a dead end: a cancelled row is never reactivated by implementation intake', async () => {
    const store = new SqliteTaskStore(dbPath);
    await store.enqueueTask({
      sessionId: 'addon-dev',
      issueNumber: 951,
      phase: 'refinement',
      context: { refinement: { state: 'escalated_human', handoffReason: 'no_convergence' } },
    });
    await store.transitionTask(
      { sessionId: 'addon-dev', issueNumber: 951 },
      { status: 'queued' },
      { status: 'ready_for_human' },
    );

    const cancelled = await store.cancelTask({ sessionId: 'addon-dev', issueNumber: 951 });
    expect(cancelled.ok).toBe(true);
    expect(cancelled.value.status).toBe('cancelled');

    // The labels now look right (status:needs-implementation added by hand),
    // so the next intake poll re-enqueues at phase implementation — and hits
    // the terminal row instead of starting work.
    const reenqueued = await store.enqueueTask({ sessionId: 'addon-dev', issueNumber: 951, phase: 'implementation' });
    store.close();
    expect(reenqueued.ok).toBe(false);
    expect(reenqueued.code).toBe('already_exists');
    expect(reenqueued.current.status).toBe('cancelled');
  });

  test('--from ready_for_human recovers all matching tasks when --issue-number is omitted', async () => {
    const store = new SqliteTaskStore(dbPath);
    for (const n of [10, 11]) {
      await store.enqueueTask({ sessionId: 'addon-dev', issueNumber: n, phase: 'review' });
      await store.transitionTask({ sessionId: 'addon-dev', issueNumber: n }, { status: 'queued' }, { status: 'ready_for_human' });
    }
    // issue 12 is failed — should remain untouched
    await store.enqueueTask({ sessionId: 'addon-dev', issueNumber: 12, phase: 'implementation' });
    await store.transitionTask({ sessionId: 'addon-dev', issueNumber: 12 }, { status: 'queued' }, { status: 'failed', lastError: 'err' });
    store.close();

    const r = await runJson('recover', '--session-id', 'addon-dev', '--from', 'ready_for_human', '--phase', 'conflict_resolution', '--db-path', dbPath);
    expect(r.code).toBe(0);
    const out = parse(r);
    expect(out.recovered).toHaveLength(2);
    expect(out.recovered.map((t) => t.issueNumber).sort()).toEqual([10, 11]);

    const store2 = new SqliteTaskStore(dbPath);
    const task12 = await store2.getTask({ sessionId: 'addon-dev', issueNumber: 12 });
    store2.close();
    expect(task12?.status).toBe('failed');
  });

  test('--from ready_for_human --dry-run shows would-recover without changing tasks', async () => {
    const store = new SqliteTaskStore(dbPath);
    await store.enqueueTask({ sessionId: 'addon-dev', issueNumber: 242, phase: 'review' });
    await store.transitionTask(
      { sessionId: 'addon-dev', issueNumber: 242 },
      { status: 'queued' },
      { status: 'ready_for_human' },
    );
    store.close();

    const r = await runJson('recover', '--session-id', 'addon-dev', '--issue-number', '242',
      '--from', 'ready_for_human', '--phase', 'conflict_resolution', '--dry-run', '--db-path', dbPath);
    expect(r.code).toBe(0);
    const out = parse(r);
    expect(out.dryRun).toBe(true);
    expect(out.wouldRecover).toHaveLength(1);
    expect(out.wouldRecover[0]).toMatchObject({
      issueNumber: 242,
      status: 'queued',
      phase: 'conflict_resolution',
      previousStatus: 'ready_for_human',
    });

    const store2 = new SqliteTaskStore(dbPath);
    const task = await store2.getTask({ sessionId: 'addon-dev', issueNumber: 242 });
    store2.close();
    expect(task?.status).toBe('ready_for_human');
  });

  // issue #677: an operator running `admin recover --from ready_for_human --phase
  // review` on an implementation Tool Request handoff (the exact shape the
  // implementation handler leaves — see src/handlers/implementation.ts) must be
  // refused, not silently routed into review with no PR/implementation-complete
  // handoff behind it. See also the pure-store coverage in
  // test/sqlite-task-store.test.js (recoverHandoff — unresolved Tool Request guard).
  async function seedToolRequestTask(issueNumber, extraContext = {}) {
    const store = new SqliteTaskStore(dbPath);
    await store.enqueueTask({ sessionId: 'addon-dev', issueNumber, phase: 'implementation', implementationAgent: 'claude' });
    await store.transitionTask(
      { sessionId: 'addon-dev', issueNumber },
      { status: 'queued' },
      {
        status: 'ready_for_human',
        phase: 'implementation',
        context: {
          labels: ['status:needs-implementation', 'agent:claude'],
          toolRequest: {
            command: 'npm install left-pad',
            displayCommand: 'npm install left-pad',
            reason: 'needed for the fix',
            expectedFiles: ['package.json'],
            necessity: 'required',
            requestedBy: 'claude',
            mode: 'new',
            requestedAt: '2026-06-07T00:00:00.000Z',
            resolved: false,
          },
          ...extraContext,
        },
      },
    );
    store.close();
  }

  test('--from ready_for_human --phase review rejects an unresolved implementation Tool Request handoff', async () => {
    await seedToolRequestTask(300);

    const r = await runJson('recover', '--session-id', 'addon-dev', '--issue-number', '300',
      '--from', 'ready_for_human', '--phase', 'review', '--db-path', dbPath);
    expect(r.code).toBe(0);
    const out = parse(r);
    expect(out.recovered).toHaveLength(0);
    expect(out.skipped).toHaveLength(1);
    expect(out.skipped[0]).toMatchObject({ issueNumber: 300 });
    expect(out.skipped[0].reason).toMatch(/tool_request_unresolved/);
    expect(out.skipped[0].reason).toMatch(/tool-request resolve/);

    // The handoff is completely untouched: same status/phase, Tool Request still
    // unresolved and still resolvable via the dedicated flows — no branch/worktree
    // cleanup or partial-implementation artifact side effects ran.
    const store2 = new SqliteTaskStore(dbPath);
    const task = await store2.getTask({ sessionId: 'addon-dev', issueNumber: 300 });
    store2.close();
    expect(task?.status).toBe('ready_for_human');
    expect(task?.phase).toBe('implementation');
    expect(task?.context.toolRequest.resolved).toBe(false);
  });

  test('--from ready_for_human --phase review --dry-run previews the tool_request_unresolved skip', async () => {
    await seedToolRequestTask(300);

    const r = await runJson('recover', '--session-id', 'addon-dev', '--issue-number', '300',
      '--from', 'ready_for_human', '--phase', 'review', '--dry-run', '--db-path', dbPath);
    expect(r.code).toBe(0);
    const out = parse(r);
    expect(out.dryRun).toBe(true);
    expect(out.wouldRecover).toHaveLength(0);
    expect(out.wouldSkip).toHaveLength(1);
    expect(out.wouldSkip[0]).toMatchObject({ issueNumber: 300 });
    expect(out.wouldSkip[0].reason).toMatch(/tool_request_unresolved/);

    const store2 = new SqliteTaskStore(dbPath);
    const task = await store2.getTask({ sessionId: 'addon-dev', issueNumber: 300 });
    store2.close();
    expect(task?.status).toBe('ready_for_human');
  });

  test('--from ready_for_human --phase review rejects a dependency-started task (continuation base is another issue branch) with an unresolved Tool Request', async () => {
    await seedToolRequestTask(301, {
      dependencyBase: {
        baseIssueNumber: 50,
        basePrNumber: 88,
        baseHeadRefName: 'ai/issue-50',
        basePrUrl: 'https://github.com/m2dw/test-repo/pull/88',
        baseHeadSha: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
      },
    });

    const r = await runJson('recover', '--session-id', 'addon-dev', '--issue-number', '301',
      '--from', 'ready_for_human', '--phase', 'review', '--db-path', dbPath);
    expect(r.code).toBe(0);
    const out = parse(r);
    expect(out.recovered).toHaveLength(0);
    expect(out.skipped).toHaveLength(1);
    expect(out.skipped[0].reason).toMatch(/tool_request_unresolved/);

    const store2 = new SqliteTaskStore(dbPath);
    const task = await store2.getTask({ sessionId: 'addon-dev', issueNumber: 301 });
    store2.close();
    expect(task?.status).toBe('ready_for_human');
    expect(task?.context.dependencyBase).toMatchObject({ baseIssueNumber: 50 });
    expect(task?.context.toolRequest.resolved).toBe(false);
  });

  test('--from ready_for_human --phase review still recovers a task whose Tool Request is already resolved', async () => {
    await seedToolRequestTask(302);
    // Resolve it as an operator would (mirrors admin tool-request resolve's
    // stored shape) before attempting the recover.
    const store = new SqliteTaskStore(dbPath);
    const before = await store.getTask({ sessionId: 'addon-dev', issueNumber: 302 });
    await store.transitionTask(
      { sessionId: 'addon-dev', issueNumber: 302 },
      { status: 'ready_for_human' },
      {
        context: {
          ...before.context,
          toolRequest: {
            ...before.context.toolRequest,
            resolved: true,
            resolution: { action: 'reject', resolvedAt: '2026-06-07T00:05:00.000Z' },
          },
        },
      },
    );
    store.close();

    const r = await runJson('recover', '--session-id', 'addon-dev', '--issue-number', '302',
      '--from', 'ready_for_human', '--phase', 'review', '--db-path', dbPath);
    expect(r.code).toBe(0);
    const out = parse(r);
    expect(out.recovered).toHaveLength(1);
    expect(out.recovered[0]).toMatchObject({ issueNumber: 302, status: 'queued', phase: 'review' });
  });
});

describe('admin CLI — recover-cap-handoff subcommand', () => {
  async function enqueueCapHandoff(store, issueNumber, reviewCycles = 3) {
    await store.enqueueTask({ sessionId: 'addon-dev', issueNumber, phase: 'review' });
    await store.transitionTask(
      { sessionId: 'addon-dev', issueNumber },
      { status: 'queued' },
      {
        status: 'ready_for_human',
        context: { reviewLoopCapReached: true, reviewCycles, reviewLoopMaxCycles: 3 },
      },
    );
  }

  test('missing --session-id exits non-zero', async () => {
    const r = await runJson('recover-cap-handoff', '--db-path', dbPath);
    expect(r.code).not.toBe(0);
    expect(parse(r)).toMatchObject({ ok: false, error: expect.stringContaining('session-id') });
  });

  test('invalid --issue-number exits non-zero', async () => {
    const r = await runJson('recover-cap-handoff', '--session-id', 'addon-dev', '--issue-number', 'abc', '--db-path', dbPath);
    expect(r.code).not.toBe(0);
    expect(parse(r)).toMatchObject({ ok: false, error: expect.stringContaining('issue-number') });
  });

  test('invalid --phase exits non-zero', async () => {
    const r = await runJson('recover-cap-handoff', '--session-id', 'addon-dev', '--phase', 'bogus-phase', '--db-path', dbPath);
    expect(r.code).not.toBe(0);
    expect(parse(r)).toMatchObject({ ok: false, error: expect.stringContaining('phase') });
  });

  test('returns empty recovered list when no cap-handoff tasks exist', async () => {
    const r = await runJson('recover-cap-handoff', '--session-id', 'addon-dev', '--db-path', dbPath);
    expect(r.code).toBe(0);
    const out = parse(r);
    expect(out).toMatchObject({ ok: true, sessionId: 'addon-dev', recovered: [], skipped: [] });
  });

  test('ignores ready_for_human tasks without reviewLoopCapReached', async () => {
    const store = new SqliteTaskStore(dbPath);
    await store.enqueueTask({ sessionId: 'addon-dev', issueNumber: 1, phase: 'review' });
    await store.transitionTask(
      { sessionId: 'addon-dev', issueNumber: 1 },
      { status: 'queued' },
      { status: 'ready_for_human' },
    );
    store.close();

    const r = await runJson('recover-cap-handoff', '--session-id', 'addon-dev', '--db-path', dbPath);
    expect(r.code).toBe(0);
    const out = parse(r);
    expect(out.recovered).toHaveLength(0);
  });

  test('recovers a cap-handoff task back to queued with phase review', async () => {
    const store = new SqliteTaskStore(dbPath);
    await enqueueCapHandoff(store, 1);
    store.close();

    const r = await runJson('recover-cap-handoff', '--session-id', 'addon-dev', '--db-path', dbPath);
    expect(r.code).toBe(0);
    const out = parse(r);
    expect(out.ok).toBe(true);
    expect(out.recovered).toHaveLength(1);
    expect(out.recovered[0]).toMatchObject({
      issueNumber: 1,
      status: 'queued',
      phase: 'review',
      previousStatus: 'ready_for_human',
      previousPhase: 'review',
      reviewCycles: 3,
    });
  });

  test('resets reviewCycles to 0 in stored context', async () => {
    const store = new SqliteTaskStore(dbPath);
    await enqueueCapHandoff(store, 2, 3);
    store.close();

    await runJson('recover-cap-handoff', '--session-id', 'addon-dev', '--db-path', dbPath);

    const store2 = new SqliteTaskStore(dbPath);
    const task = await store2.getTask({ sessionId: 'addon-dev', issueNumber: 2 });
    store2.close();
    expect(task?.context?.reviewCycles).toBe(0);
    expect(task?.status).toBe('queued');
  });

  test('--issue-number recovers only the specified task', async () => {
    const store = new SqliteTaskStore(dbPath);
    await enqueueCapHandoff(store, 1);
    await enqueueCapHandoff(store, 2);
    store.close();

    const r = await runJson('recover-cap-handoff', '--session-id', 'addon-dev', '--issue-number', '1', '--db-path', dbPath);
    expect(r.code).toBe(0);
    const out = parse(r);
    expect(out.recovered).toHaveLength(1);
    expect(out.recovered[0].issueNumber).toBe(1);
  });

  test('--phase overrides the phase when re-queuing', async () => {
    const store = new SqliteTaskStore(dbPath);
    await enqueueCapHandoff(store, 3);
    store.close();

    const r = await runJson('recover-cap-handoff', '--session-id', 'addon-dev', '--issue-number', '3', '--phase', 'implementation', '--db-path', dbPath);
    expect(r.code).toBe(0);
    const out = parse(r);
    expect(out.recovered).toHaveLength(1);
    expect(out.recovered[0]).toMatchObject({ phase: 'implementation', previousPhase: 'review' });
  });

  test('--dry-run shows would-recover without changing tasks', async () => {
    const store = new SqliteTaskStore(dbPath);
    await enqueueCapHandoff(store, 4);
    store.close();

    const r = await runJson('recover-cap-handoff', '--session-id', 'addon-dev', '--dry-run', '--db-path', dbPath);
    expect(r.code).toBe(0);
    const out = parse(r);
    expect(out.dryRun).toBe(true);
    expect(out.wouldRecover).toHaveLength(1);
    expect(out.wouldRecover[0]).toMatchObject({ issueNumber: 4, status: 'queued', phase: 'review' });

    const store2 = new SqliteTaskStore(dbPath);
    const task = await store2.getTask({ sessionId: 'addon-dev', issueNumber: 4 });
    store2.close();
    expect(task?.status).toBe('ready_for_human');
  });

  test('resolves --session-ref to the canonical sessionId and recovers', async () => {
    const sessionsPath = join(tmpDir, 'sessions.json');
    writeFileSync(
      sessionsPath,
      JSON.stringify({
        sessions: [{
          sessionId: 'addon-dev',
          sessionNo: 1,
          aliases: ['addon'],
          repoKey: 'addon-dev-repo',
          repoRoot: '/tmp/addon-dev',
          githubRepo: 'm2dw/addon-dev',
          artifactDir: '.n8n-artifacts',
          defaults: { implementationAgent: 'claude', reviewAgent: 'codex' },
          verification: { test: 'npm test' },
          labels: { active: 'ai:active', blocked: 'ai:blocked', readyForHuman: 'ai:ready-for-human' },
        }],
      }),
      'utf8',
    );
    const store = new SqliteTaskStore(dbPath);
    await enqueueCapHandoff(store, 1);
    store.close();

    const r = await runJson(
      'recover-cap-handoff', '--session-ref', 'addon',
      '--sessions-path', sessionsPath, '--db-path', dbPath,
    );
    expect(r.code).toBe(0);
    const out = parse(r);
    expect(out).toMatchObject({ ok: true, sessionId: 'addon-dev' });
    expect(out.recovered).toHaveLength(1);
    expect(out.recovered[0].issueNumber).toBe(1);
  });

  test('recover-cap-handoff appears in help output', async () => {
    const r = await run('help');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('recover-cap-handoff');
  });

  test('"help recover-cap-handoff" documents --session-ref', async () => {
    const r = await run('help', 'recover-cap-handoff');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('--session-ref');
  });

  test('"help recover-cap-handoff" states that omitting --phase defaults to review', async () => {
    const r = await run('help', 'recover-cap-handoff');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("defaults to review");
  });
});

describe('admin CLI — session-init subcommand', () => {
  let sessionsPath;

  beforeEach(() => {
    sessionsPath = join(tmpDir, 'sessions.json');
  });

  const baseArgs = (extra = []) => [
    'session-init',
    '--session-id', 'addon-dev',
    '--repo-key', 'thunderbird-auth-results-filter',
    '--repo-root', '/Users/moto/git/thunderbird-auth-results-filter',
    '--github-repo', 'm2dw/thunderbird-auth-results-filter',
    '--artifact-dir', '.n8n-artifacts',
    '--implementation-agent', 'claude',
    '--review-agent', 'codex',
    '--sessions-path', sessionsPath,
    ...extra,
  ];

  test('creates sessions.json when it does not exist', async () => {
    const r = await run(...baseArgs());
    expect(r.code).toBe(0);
    const out = parse(r);
    expect(out.ok).toBe(true);
    expect(out.sessionsPath).toBe(sessionsPath);
    expect(out.session).toMatchObject({
      sessionId: 'addon-dev',
      repoKey: 'thunderbird-auth-results-filter',
      repoRoot: '/Users/moto/git/thunderbird-auth-results-filter',
      githubRepo: 'm2dw/thunderbird-auth-results-filter',
      artifactDir: '.n8n-artifacts',
      defaults: { implementationAgent: 'claude', reviewAgent: 'codex' },
      labels: { active: 'ai:active', blocked: 'ai:blocked', readyForHuman: 'ai:ready-for-human' },
    });
  });

  test('sessions.json file is written with a sessions array', async () => {
    await run(...baseArgs());
    const file = JSON.parse(readFileSync(sessionsPath, 'utf8'));
    expect(Array.isArray(file.sessions)).toBe(true);
    expect(file.sessions).toHaveLength(1);
    expect(file.sessions[0].sessionId).toBe('addon-dev');
  });

  test('appends to an existing sessions.json', async () => {
    await run(...baseArgs());
    const r2 = await run(
      'session-init',
      '--session-id', 'workflow-dev',
      '--repo-key', 'n8n-ai-cli-loop',
      '--repo-root', '/Users/moto/git/n8n-ai-cli-loop',
      '--github-repo', 'm2dw/n8n-ai-cli-loop',
      '--artifact-dir', '.n8n-artifacts',
      '--implementation-agent', 'codex',
      '--review-agent', 'claude',
      '--sessions-path', sessionsPath,
    );
    expect(r2.code).toBe(0);
    const file = JSON.parse(readFileSync(sessionsPath, 'utf8'));
    expect(file.sessions).toHaveLength(2);
    expect(file.sessions.map((s) => s.sessionId)).toEqual(['addon-dev', 'workflow-dev']);
  });

  test('errors when session-id already exists', async () => {
    await run(...baseArgs());
    const r2 = await run(...baseArgs());
    expect(r2.code).not.toBe(0);
    expect(parse(r2)).toMatchObject({ ok: false, error: expect.stringContaining('addon-dev') });
  });

  test('errors when repo-key already exists', async () => {
    await run(...baseArgs());
    const r2 = await run(
      'session-init',
      '--session-id', 'workflow-dev',
      '--repo-key', 'thunderbird-auth-results-filter',
      '--repo-root', '/Users/moto/git/n8n-ai-cli-loop',
      '--github-repo', 'm2dw/n8n-ai-cli-loop',
      '--artifact-dir', '.n8n-artifacts',
      '--implementation-agent', 'codex',
      '--review-agent', 'claude',
      '--sessions-path', sessionsPath,
    );
    expect(r2.code).not.toBe(0);
    expect(parse(r2)).toMatchObject({
      ok: false,
      error: expect.stringContaining('repoKey "thunderbird-auth-results-filter"'),
    });
  });

  test('optional --research-agent is stored in defaults', async () => {
    const r = await run(...baseArgs(['--research-agent', 'gemini']));
    expect(r.code).toBe(0);
    const out = parse(r);
    expect(out.session.defaults).toMatchObject({ researchAgent: 'gemini' });
  });

  test('--verification-json stores verification commands', async () => {
    const r = await run(...baseArgs(['--verification-json', '{"test":"npm test"}']));
    expect(r.code).toBe(0);
    const out = parse(r);
    expect(out.session.verification).toEqual({ test: 'npm test' });
  });

  test('custom label flags override defaults', async () => {
    const r = await run(...baseArgs([
      '--labels-active', 'status:active',
      '--labels-blocked', 'status:blocked',
      '--labels-ready-for-human', 'status:review',
    ]));
    expect(r.code).toBe(0);
    const out = parse(r);
    expect(out.session.labels).toEqual({
      active: 'status:active',
      blocked: 'status:blocked',
      readyForHuman: 'status:review',
    });
  });

  test('missing required --session-id exits non-zero', async () => {
    const r = await run(
      'session-init',
      '--repo-key', 'some-repo',
      '--repo-root', '/some/path',
      '--github-repo', 'owner/repo',
      '--artifact-dir', '.artifacts',
      '--implementation-agent', 'claude',
      '--review-agent', 'codex',
      '--sessions-path', sessionsPath,
    );
    expect(r.code).not.toBe(0);
    expect(parse(r)).toMatchObject({ ok: false, error: expect.stringContaining('session-id') });
  });

  test('invalid --implementation-agent exits non-zero', async () => {
    const r = await run(...baseArgs().map((a) => a === 'claude' ? 'invalid-agent' : a));
    expect(r.code).not.toBe(0);
    expect(parse(r)).toMatchObject({ ok: false });
  });

  test('invalid --verification-json exits non-zero', async () => {
    const r = await run(...baseArgs(['--verification-json', 'not-json']));
    expect(r.code).not.toBe(0);
    expect(parse(r)).toMatchObject({ ok: false, error: expect.stringContaining('verification-json') });
  });

  test('session-init appears in help output', async () => {
    const r = await run('help');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('session-init');
  });
});

describe('admin CLI — context create subcommand', () => {
  let sessionsPath;

  beforeEach(() => {
    sessionsPath = join(tmpDir, 'sessions.json');
  });

  test('missing --execution-id exits non-zero', async () => {
    const r = await run('context', 'create', '--session-id', 'addon-dev', '--db-path', dbPath);
    expect(r.code).not.toBe(0);
    expect(parse(r)).toMatchObject({ ok: false, error: expect.stringContaining('execution-id') });
  });

  test('missing --session-id exits non-zero', async () => {
    const r = await run('context', 'create', '--execution-id', 'exec-1', '--db-path', dbPath);
    expect(r.code).not.toBe(0);
    expect(parse(r)).toMatchObject({ ok: false, error: expect.stringContaining('session-id') });
  });

  test('creates context record and emits contextId', async () => {
    const r = await run('context', 'create', '--execution-id', 'exec-42', '--session-id', 'addon-dev', '--db-path', dbPath);
    expect(r.code).toBe(0);
    expect(parse(r)).toMatchObject({ ok: true, contextId: 'exec-42' });
  });

  test('stored context resolves sessionId in subsequent CLI calls', async () => {
    // Create the context record
    const create = await run('context', 'create', '--execution-id', 'exec-ctx-1', '--session-id', 'addon-dev', '--db-path', dbPath);
    expect(create.code).toBe(0);

    // Verify the context store resolves the sessionId
    const { SqliteContextStore } = await import('../dist/index.js');
    const store = new SqliteContextStore(dbPath);
    const resolved = store.getSessionId('exec-ctx-1');
    store.close();
    expect(resolved).toBe('addon-dev');
  });

  test('upsert overwrites existing context record', async () => {
    await run('context', 'create', '--execution-id', 'exec-same', '--session-id', 'session-a', '--db-path', dbPath);
    const r = await run('context', 'create', '--execution-id', 'exec-same', '--session-id', 'session-b', '--db-path', dbPath);
    expect(r.code).toBe(0);
    expect(parse(r)).toMatchObject({ ok: true, contextId: 'exec-same' });
  });

  test('unknown context action exits non-zero', async () => {
    const r = await run('context', 'bogus');
    expect(r.code).not.toBe(0);
    expect(parse(r)).toMatchObject({ ok: false, error: expect.stringContaining('bogus') });
  });
});

describe('admin CLI — context create with --session-ref', () => {
  let sessionsPath;

  const SESSION = {
    sessionId: 'thunderbird-auth-results',
    sessionNo: 2,
    aliases: ['addon', 'tar'],
    repoKey: 'thunderbird-auth-results-filter',
    repoRoot: '/Users/moto/git/thunderbird-auth-results-filter',
    githubRepo: 'm2dw/thunderbird-auth-results-filter',
    artifactDir: '.n8n-artifacts',
    defaults: { implementationAgent: 'claude', reviewAgent: 'codex' },
    verification: { test: 'npm test' },
    labels: { active: 'ai:active', blocked: 'ai:blocked', readyForHuman: 'ai:ready-for-human' },
  };

  beforeEach(() => {
    sessionsPath = join(tmpDir, 'sessions.json');
    writeFileSync(sessionsPath, JSON.stringify({ sessions: [SESSION] }), 'utf8');
  });

  async function storedSessionId(contextId) {
    const { SqliteContextStore } = await import('../dist/index.js');
    const store = new SqliteContextStore(dbPath);
    const resolved = store.getSessionId(contextId);
    store.close();
    return resolved;
  }

  test('resolves an alias to the canonical sessionId and stores it', async () => {
    const r = await run('context', 'create', '--execution-id', 'exec-ref-alias',
      '--session-ref', 'addon', '--sessions-path', sessionsPath, '--db-path', dbPath);
    expect(r.code).toBe(0);
    expect(parse(r)).toMatchObject({ ok: true, contextId: 'exec-ref-alias' });
    expect(await storedSessionId('exec-ref-alias')).toBe('thunderbird-auth-results');
  });

  test('resolves a numeric sessionNo to the canonical sessionId', async () => {
    const r = await run('context', 'create', '--execution-id', 'exec-ref-no',
      '--session-ref', '2', '--sessions-path', sessionsPath, '--db-path', dbPath);
    expect(r.code).toBe(0);
    expect(await storedSessionId('exec-ref-no')).toBe('thunderbird-auth-results');
  });

  test('resolves an exact sessionId passed as --session-ref', async () => {
    const r = await run('context', 'create', '--execution-id', 'exec-ref-id',
      '--session-ref', 'thunderbird-auth-results', '--sessions-path', sessionsPath, '--db-path', dbPath);
    expect(r.code).toBe(0);
    expect(await storedSessionId('exec-ref-id')).toBe('thunderbird-auth-results');
  });

  test('unknown --session-ref exits non-zero with a clear error', async () => {
    const r = await run('context', 'create', '--execution-id', 'exec-ref-x',
      '--session-ref', 'no-such-ref', '--sessions-path', sessionsPath, '--db-path', dbPath);
    expect(r.code).not.toBe(0);
    expect(parse(r)).toMatchObject({ ok: false, error: expect.stringContaining('Unknown session reference') });
  });

  test('providing both --session-id and --session-ref exits non-zero', async () => {
    const r = await run('context', 'create', '--execution-id', 'exec-ref-both',
      '--session-id', 'thunderbird-auth-results', '--session-ref', 'addon',
      '--sessions-path', sessionsPath, '--db-path', dbPath);
    expect(r.code).not.toBe(0);
    expect(parse(r)).toMatchObject({ ok: false, error: expect.stringContaining('only one') });
  });

  test('--session-id still works without a sessions.json (backward compatible)', async () => {
    const r = await run('context', 'create', '--execution-id', 'exec-ref-compat',
      '--session-id', 'addon-dev', '--db-path', dbPath);
    expect(r.code).toBe(0);
    expect(parse(r)).toMatchObject({ ok: true, contextId: 'exec-ref-compat' });
  });

  test('--session-ref is documented in help output', async () => {
    const r = await run('help', 'context create');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('--session-ref');
  });
});

describe('admin CLI — session-doctor subcommand', () => {
  let sessionsPath;
  let repoRoot;
  let tmpBin;

  beforeEach(() => {
    sessionsPath = join(tmpDir, 'sessions.json');
    repoRoot = join(tmpDir, 'repo');
    tmpBin = join(tmpDir, 'bin');
    mkdirSync(tmpBin, { recursive: true });
    for (const cmd of ['gh', 'claude', 'codex', 'gemini']) {
      writeFileSync(join(tmpBin, cmd), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    }
  });

  async function runDoctor(...args) {
    return runAdmin(args, { env: { PATH: `${tmpBin}:${process.env.PATH ?? ''}` } });
  }

  function writeSession(overrides = {}) {
    const session = {
      sessionId: 'addon-dev',
      repoKey: 'some-repo',
      repoRoot,
      githubRepo: 'm2dw/some-repo',
      artifactDir: '.n8n-artifacts',
      defaults: { implementationAgent: 'claude', reviewAgent: 'claude' },
      verification: {},
      labels: { active: 'ai:active', blocked: 'ai:blocked', readyForHuman: 'ai:ready-for-human' },
      ...overrides,
    };
    writeFileSync(sessionsPath, JSON.stringify({ sessions: [session] }), 'utf8');
    return session;
  }

  test('missing --session-id exits non-zero', async () => {
    const r = await runDoctor('session-doctor', '--sessions-path', sessionsPath);
    expect(r.code).not.toBe(0);
    expect(parse(r)).toMatchObject({ ok: false, error: expect.stringContaining('session-id') });
  });

  test('unknown session-id exits non-zero', async () => {
    writeSession();
    const r = await runDoctor('session-doctor', '--session-id', 'no-such-session', '--sessions-path', sessionsPath);
    expect(r.code).not.toBe(0);
    expect(parse(r)).toMatchObject({ ok: false, error: expect.stringContaining('no-such-session') });
  });

  test('missing sessions file exits non-zero', async () => {
    const r = await runDoctor('session-doctor', '--session-id', 'addon-dev', '--sessions-path', join(tmpDir, 'nonexistent.json'));
    expect(r.code).not.toBe(0);
    expect(parse(r)).toMatchObject({ ok: false, error: expect.stringContaining('not found') });
  });

  test('returns ok:true with checks array and allPassed fields', async () => {
    writeSession();
    const r = await runDoctor('session-doctor', '--session-id', 'addon-dev', '--sessions-path', sessionsPath);
    expect(r.code).toBe(0);
    const out = parse(r);
    expect(out).toMatchObject({ ok: true, sessionId: 'addon-dev' });
    expect(Array.isArray(out.checks)).toBe(true);
    expect(typeof out.allPassed).toBe('boolean');
  });

  test('checks array includes all expected check names', async () => {
    writeSession();
    const r = await runDoctor('session-doctor', '--session-id', 'addon-dev', '--sessions-path', sessionsPath);
    expect(r.code).toBe(0);
    const out = parse(r);
    const names = out.checks.map((c) => c.name);
    expect(names).toContain('repoRootExists');
    expect(names).toContain('repoIsGit');
    expect(names).toContain('ghAuth');
    expect(names).toContain('ghRepoAccess');
    expect(names).toContain('claudeCli');
  });

  test('each check has name, category, and ok fields', async () => {
    writeSession();
    const r = await runDoctor('session-doctor', '--session-id', 'addon-dev', '--sessions-path', sessionsPath);
    expect(r.code).toBe(0);
    const out = parse(r);
    for (const check of out.checks) {
      expect(typeof check.name).toBe('string');
      expect(['repo', 'github', 'aiCli', 'storage', 'worktree', 'registry']).toContain(check.category);
      expect(typeof check.ok).toBe('boolean');
    }
  });

  test('repoRootExists check fails when repoRoot does not exist', async () => {
    writeSession({ repoRoot: join(tmpDir, 'no-such-dir') });
    const r = await runDoctor('session-doctor', '--session-id', 'addon-dev', '--sessions-path', sessionsPath);
    expect(r.code).toBe(0);
    const out = parse(r);
    const check = out.checks.find((c) => c.name === 'repoRootExists');
    expect(check.ok).toBe(false);
    expect(typeof check.error).toBe('string');
  });

  test('repoRootExists check passes when repoRoot exists', async () => {
    mkdirSync(repoRoot, { recursive: true });
    writeSession();
    const r = await runDoctor('session-doctor', '--session-id', 'addon-dev', '--sessions-path', sessionsPath);
    expect(r.code).toBe(0);
    const out = parse(r);
    const check = out.checks.find((c) => c.name === 'repoRootExists');
    expect(check.ok).toBe(true);
  });

  test('repoIsGit is skipped with error when repoRoot does not exist', async () => {
    writeSession({ repoRoot: join(tmpDir, 'no-such-dir') });
    const r = await runDoctor('session-doctor', '--session-id', 'addon-dev', '--sessions-path', sessionsPath);
    expect(r.code).toBe(0);
    const out = parse(r);
    const check = out.checks.find((c) => c.name === 'repoIsGit');
    expect(check.ok).toBe(false);
    expect(check.error).toMatch(/Skipped/);
  });

  test('repoIsGit check fails when repoRoot is not a git repo', async () => {
    mkdirSync(repoRoot, { recursive: true });
    writeSession();
    const r = await runDoctor('session-doctor', '--session-id', 'addon-dev', '--sessions-path', sessionsPath);
    expect(r.code).toBe(0);
    const out = parse(r);
    const check = out.checks.find((c) => c.name === 'repoIsGit');
    expect(check.ok).toBe(false);
  });

  test('repoIsGit check passes when repoRoot is a git repository', async () => {
    mkdirSync(repoRoot, { recursive: true });
    execFileSync('git', ['init'], { cwd: repoRoot });
    writeSession();
    const r = await runDoctor('session-doctor', '--session-id', 'addon-dev', '--sessions-path', sessionsPath);
    expect(r.code).toBe(0);
    const out = parse(r);
    const check = out.checks.find((c) => c.name === 'repoIsGit');
    expect(check.ok).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Review-dispute arbiter diagnostics (issue #839, contract §8.3)
  // -------------------------------------------------------------------------

  const ARBITER_CHECKS = ['arbiterConfig', 'arbiterCandidates', 'arbiterSelection'];

  /**
   * A doctor environment with the operator model/effort/budget overrides
   * cleared, so a developer who exports CLAUDE_MODEL in their own shell does not
   * change what these assertions see. Anything named in `extra` is kept.
   */
  function doctorEnv(extra = {}) {
    // Harness env entries are overrides on top of the current environment, and
    // `undefined` means "unset for this run" — so a key the caller did not name
    // is cleared rather than deleted from a copied environment object.
    const env = { PATH: `${tmpBin}:${process.env.PATH ?? ''}` };
    for (const key of [
      'CLAUDE_MODEL', 'CLAUDE_EFFORT', 'CLAUDE_MAX_BUDGET_USD',
      'CODEX_MODEL', 'CODEX_EFFORT', 'ANTIGRAVITY_BIN',
    ]) {
      if (!(key in extra)) env[key] = undefined;
    }
    return { ...env, ...extra };
  }

  /**
   * Answer every agent-CLI probe from the deterministic seam (issue #897).
   *
   * Selection policy — which candidate wins, and why — is pure, but reaching it
   * through `session-doctor` used to require forking throwaway shell scripts and
   * trusting the host to schedule them promptly. Under concurrent verification
   * load it did not: a probe that timed out turned `same-provider-model-unknown`
   * into `cli-unavailable` and failed the review that filed this issue. Tests
   * about SELECTION therefore stub availability; the tests that are genuinely
   * about probing a real executable are marked as such and keep spawning.
   */
  function probeStub(statuses) {
    return { [CLI_PROBE_STUB_ENV]: JSON.stringify(statuses) };
  }

  const ALL_CLIS_AVAILABLE = probeStub({ claude: 'available', codex: 'available', gemini: 'available' });

  async function doctorChecks(session, extraEnv = {}) {
    writeSession(session);
    const args = ['session-doctor', '--session-id', 'addon-dev', '--sessions-path', sessionsPath];
    const { stdout } = await runAdmin(args, { env: doctorEnv(extraEnv) });
    return Object.fromEntries(JSON.parse(stdout.trim()).checks.map((c) => [c.name, c]));
  }

  test('no arbiter checks are emitted while the dispute protocol is disabled', async () => {
    for (const reviewDispute of [undefined, { enabled: false }, { arbiter: { providers: ['claude'] } }]) {
      const checks = await doctorChecks(reviewDispute === undefined ? {} : { reviewDispute });
      for (const name of ARBITER_CHECKS) expect(checks[name]).toBeUndefined();
    }
  });

  test('a valid cross-provider candidate reports the profile it would invoke', async () => {
    const checks = await doctorChecks({
      defaults: { implementationAgent: 'codex', reviewAgent: 'codex' },
      reviewDispute: { enabled: true, arbiter: { providers: ['claude'], minConfidence: 0.8 } },
    }, ALL_CLIS_AVAILABLE);
    expect(checks.arbiterConfig).toMatchObject({ category: 'aiCli', ok: true });
    expect(checks.arbiterConfig.detail).toContain('minConfidence: 0.8');
    expect(checks.arbiterCandidates.ok).toBe(true);
    expect(checks.arbiterSelection.ok).toBe(true);
    // Provider, model, effort — everything the invocation layer needs, and the
    // parties it was proven independent of.
    expect(checks.arbiterSelection.detail).toContain('claude/anthropic');
    expect(checks.arbiterSelection.detail).toContain('model opus');
    expect(checks.arbiterSelection.detail).toContain('effort high');
    expect(checks.arbiterSelection.detail).toContain('implementation codex/openai, review codex/openai');
    expect(checks.arbiterSelection.detail).toContain('sameProviderFallback: false');
  });

  test('an empty candidate list fails arbiterConfig with the row-19 consequence', async () => {
    const checks = await doctorChecks({
      defaults: { implementationAgent: 'codex', reviewAgent: 'codex' },
      reviewDispute: { enabled: true, arbiter: { providers: [] } },
    });
    expect(checks.arbiterConfig.ok).toBe(false);
    expect(checks.arbiterConfig.error).toMatch(/providers is empty/);
    expect(checks.arbiterSelection.ok).toBe(false);
    expect(checks.arbiterSelection.error).toMatch(/row 19/);
  });

  test('an unsupported arbiter agent id fails arbiterConfig at the config boundary', async () => {
    const checks = await doctorChecks({
      reviewDispute: { enabled: true, arbiter: { providers: ['anthropic'] } },
    });
    expect(checks.arbiterConfig.ok).toBe(false);
    expect(checks.arbiterConfig.error).toMatch(/providers\[0\]/);
    for (const name of ['arbiterCandidates', 'arbiterSelection']) {
      expect(checks[name].ok).toBe(false);
      expect(checks[name].error).toMatch(/^Skipped:/);
    }
  });

  test('an agent with no arbiter invocation is reported as an unusable candidate', async () => {
    const checks = await doctorChecks({
      defaults: { implementationAgent: 'claude', reviewAgent: 'claude' },
      reviewDispute: { enabled: true, arbiter: { providers: ['gemini'] } },
    });
    expect(checks.arbiterCandidates.ok).toBe(false);
    expect(checks.arbiterCandidates.error).toMatch(/gemini\[0\]: unsupported-role/);
    expect(checks.arbiterSelection.ok).toBe(false);
    // Issue #965: the selection remedy has to be one the operator can act on.
    // "Add a candidate from another provider" is not, when the candidate would
    // be refused by §8.2's capability table before independence is measured —
    // so the check names the table and where the fix actually lives.
    expect(checks.arbiterSelection.error).toMatch(/no VERIFIED no-tools invocation for that agent/);
    expect(checks.arbiterSelection.error).toMatch(/checked before independence is/);
    expect(checks.arbiterSelection.error).toMatch(/defined for `claude` only/);
  });

  test('a same-provider-only refusal does not claim the capability table is the problem', async () => {
    // The other half: `claude` DOES resolve, and is refused by §8.3 alone. An
    // operator here is not blocked by the runner, so the capability note must
    // not appear and send them looking for a code change.
    const checks = await doctorChecks({
      defaults: { implementationAgent: 'claude', reviewAgent: 'claude' },
      reviewDispute: { enabled: true, arbiter: { providers: ['claude'] } },
    }, ALL_CLIS_AVAILABLE);
    expect(checks.arbiterSelection.ok).toBe(false);
    expect(checks.arbiterSelection.error).toMatch(/same-provider-not-allowed/);
    expect(checks.arbiterSelection.error).not.toMatch(/no VERIFIED no-tools invocation/);
  });

  // -------------------------------------------------------------------------
  // Probe classification (issue #897)
  //
  // The distinction these pin is the whole issue: "the CLI is missing" is a
  // finding an operator acts on, "the probe never answered" is a question to
  // ask again. Before #897 both came out as `cli-unavailable`, so a saturated
  // host produced a phantom configuration diagnosis — and, through review
  // verification, a phantom code-quality failure.
  // -------------------------------------------------------------------------

  const INDETERMINATE_STATUSES = [
    ['a probe timeout', 'timeout'],
    ['a refused fork', 'spawn-error'],
  ];

  test.each(INDETERMINATE_STATUSES)('%s is reported as indeterminate, not as a missing CLI', async (_label, status) => {
    const checks = await doctorChecks(
      {
        defaults: { implementationAgent: 'codex', reviewAgent: 'codex' },
        reviewDispute: { enabled: true, arbiter: { providers: ['claude'] } },
      },
      probeStub({ claude: status, codex: 'available' }),
    );
    // The role check cannot claim success — nothing was verified — but it says
    // which of the two things failed, and marks itself as not a finding.
    expect(checks.claudeCli.ok).toBe(false);
    expect(checks.claudeCli.transient).toBe(true);
    expect(checks.claudeCli.error).toContain(CLI_PROBE_INDETERMINATE_MARKER);
    expect(checks.claudeCli.error).toMatch(/says nothing about whether claude is installed/);
    expect(checks.claudeCli.error).not.toMatch(/not found on PATH/);
    // …and the arbiter candidate is refused under its own reason code, with the
    // remedy being "re-run", not "install something".
    expect(checks.arbiterCandidates.ok).toBe(false);
    expect(checks.arbiterCandidates.transient).toBe(true);
    expect(checks.arbiterCandidates.error).toMatch(/claude\[0\]: cli-probe-indeterminate/);
    expect(checks.arbiterCandidates.error).toMatch(/Re-run session-doctor when the host is less loaded/);
    expect(checks.arbiterCandidates.error).not.toMatch(/cli-unavailable/);
  }, 30_000);

  test('a missing executable is still reported as cli-unavailable', async () => {
    const checks = await doctorChecks(
      {
        defaults: { implementationAgent: 'codex', reviewAgent: 'codex' },
        reviewDispute: { enabled: true, arbiter: { providers: ['claude'] } },
      },
      probeStub({ claude: 'not-found', codex: 'available' }),
    );
    expect(checks.claudeCli.ok).toBe(false);
    expect(checks.claudeCli.transient).toBeUndefined();
    expect(checks.claudeCli.error).toMatch(/claude was not found on PATH \(ENOENT\)/);
    expect(checks.arbiterCandidates.error).toMatch(/claude\[0\]: cli-unavailable/);
    expect(checks.arbiterCandidates.transient).toBeUndefined();
  }, 30_000);

  test('a CLI that ran and exited non-zero is reported as that, and is not transient', async () => {
    const checks = await doctorChecks(
      { defaults: { implementationAgent: 'claude', reviewAgent: 'claude' } },
      probeStub({ claude: 'non-zero-exit' }),
    );
    expect(checks.claudeCli.ok).toBe(false);
    expect(checks.claudeCli.transient).toBeUndefined();
    expect(checks.claudeCli.error).toMatch(/claude exited 1/);
    expect(checks.claudeCli.error).not.toContain(CLI_PROBE_INDETERMINATE_MARKER);
  }, 30_000);

  test('a stubbed probe is never passed off as a real availability fact', async () => {
    const checks = await doctorChecks(
      { defaults: { implementationAgent: 'claude', reviewAgent: 'claude' } },
      probeStub({ claude: 'available' }),
    );
    expect(checks.claudeCli.ok).toBe(true);
    expect(checks.claudeCli.detail).toContain('[stubbed probe]');
  }, 30_000);

  // A stub doctor cannot fully honour must fail the run: silently ignoring it
  // would let the real probe spawn after all, which is the nondeterminism the
  // seam exists to remove — and a passing run would hide that it happened. The
  // typo case is the dangerous one: `claud` parses, stubs nothing, and leaves
  // the actual `claude` check spawning for real.
  for (const [label, raw] of [
    ['unparseable', '{not json'],
    ['a typo\'d agent key', JSON.stringify({ claud: 'available' })],
    ['a CLI that is not stubbable', JSON.stringify({ claude: 'available', gh: 'available' })],
  ]) {
    test(`a probe stub that is ${label} fails loudly rather than falling back to real spawns`, async () => {
      writeSession({ defaults: { implementationAgent: 'claude', reviewAgent: 'claude' } });
      const { code, stdout } = await runAdmin(
        ['session-doctor', '--session-id', 'addon-dev', '--sessions-path', sessionsPath],
        { env: doctorEnv({ [CLI_PROBE_STUB_ENV]: raw }) },
      );
      expect(code).not.toBe(0);
      expect(JSON.parse(stdout.trim())).toMatchObject({
        ok: false, error: expect.stringContaining(CLI_PROBE_STUB_ENV),
      });
    }, 30_000);
  }

  test('an unavailable candidate CLI is reported as such, not as a config problem', async () => {
    // Integration: a REAL spawn against a real PATH, kept deliberately so the
    // typed classification above is anchored to what the OS actually does.
    // A PATH without `claude` on it: the arbiter candidate cannot be invoked.
    const binOnlyGh = join(tmpDir, 'bin-gh');
    mkdirSync(binOnlyGh, { recursive: true });
    for (const cmd of ['gh', 'codex']) {
      writeFileSync(join(binOnlyGh, cmd), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    }
    const checks = await doctorChecks(
      {
        defaults: { implementationAgent: 'codex', reviewAgent: 'codex' },
        reviewDispute: { enabled: true, arbiter: { providers: ['claude'] } },
      },
      { PATH: binOnlyGh },
    );
    expect(checks.arbiterCandidates.ok).toBe(false);
    expect(checks.arbiterCandidates.error).toMatch(/claude\[0\]: cli-unavailable/);
  });

  test('a provider overlap is a selection refusal, not an unusable candidate', async () => {
    const checks = await doctorChecks({
      defaults: { implementationAgent: 'claude', reviewAgent: 'claude' },
      reviewDispute: { enabled: true, arbiter: { providers: ['claude'] } },
    }, ALL_CLIS_AVAILABLE);
    expect(checks.arbiterCandidates.ok).toBe(true);
    expect(checks.arbiterSelection.ok).toBe(false);
    expect(checks.arbiterSelection.error).toMatch(/claude\[0\]: same-provider-not-allowed/);
  });

  test('explicit same-provider fallback is reported, and says why it cannot be proven here', async () => {
    // The regression that filed issue #897: under host contention this probe
    // timed out, the answer flipped from `same-provider-model-unknown` to
    // `cli-unavailable`, and a green branch failed review. Availability is now
    // an injected fact, so the assertion is about policy only.
    const checks = await doctorChecks({
      defaults: { implementationAgent: 'claude', reviewAgent: 'claude' },
      reviewDispute: { enabled: true, arbiter: { providers: ['claude'], allowSameProvider: true } },
    }, ALL_CLIS_AVAILABLE);
    expect(checks.arbiterConfig.detail).toContain('allowSameProvider: true');
    expect(checks.arbiterSelection.ok).toBe(false);
    expect(checks.arbiterSelection.error).toMatch(/same-provider-model-unknown/);
    expect(checks.arbiterSelection.error).toMatch(/only known once the implementation and review runs exist/);
  });

  test('an invalid resolved profile is reported as a profile error', async () => {
    const checks = await doctorChecks(
      {
        defaults: { implementationAgent: 'codex', reviewAgent: 'codex' },
        reviewDispute: { enabled: true, arbiter: { providers: ['claude'] } },
      },
      { CLAUDE_EFFORT: 'turbo', ...ALL_CLIS_AVAILABLE },
    );
    expect(checks.arbiterCandidates.ok).toBe(false);
    expect(checks.arbiterCandidates.error).toMatch(/claude\[0\]: profile-error \(effort:invalid\)/);
  });

  test('the arbiter checks never re-probe a CLI the role checks already probed', async () => {
    const counter = join(tmpDir, 'claude-probes.log');
    writeFileSync(join(tmpBin, 'claude'), `#!/bin/sh\necho run >> "${counter}"\nexit 0\n`, { mode: 0o755 });
    // Counting spawns is the whole subject here, so this case cannot stub
    // availability the way the selection cases above do — which leaves it
    // exposed to the starved probe of issue #897: a `claude` the host never got
    // round to running is (correctly) refused as a candidate, and the count is
    // then of a run that never happened. Ask again from a clean counter, and
    // decline to assert at all if the host never answers.
    const { result: checks, answered } = await runUntilProbeAnswers(
      async () => {
        rmSync(counter, { force: true });
        return doctorChecks({
          defaults: { implementationAgent: 'codex', reviewAgent: 'codex' },
          // Claude is named twice, and is also probed as the conflict-resolution
          // agent by the role checks — one spawn, whatever the reporting.
          reviewDispute: { enabled: true, arbiter: { providers: ['claude', 'claude'] } },
        });
      },
      // `claudeCli` carries the probe's own verdict; the arbiter checks are read
      // too so the refusal they cascade into is not mistaken for an answer.
      (result) => ['claudeCli', 'arbiterCandidates', 'arbiterSelection']
        .map((name) => result[name]?.error ?? '')
        .join('\n'),
    );
    if (!answered) return;
    expect(checks.arbiterSelection.ok).toBe(true);
    expect(readFileSync(counter, 'utf8').trim().split('\n')).toHaveLength(1);
    // Each attempt forks real children under a 60s probe budget apiece, so the
    // retry schedule needs headroom the file-wide 30s does not give it.
  }, 240_000);

  // Issue #849 rollout regressions. The checks themselves are #839's and are
  // deliberately NOT duplicated here; what these pin is that an ENABLED session
  // gets an actionable, complete readiness answer out of them — which is the
  // thing an operator turning the protocol on is relying on.

  test('an enabled, healthy session reports usable implementation and review profiles', async () => {
    // Deliberately unstubbed: the point of this case is that the readiness
    // answer an operator gets is backed by REAL probes of both agent CLIs. That
    // keeps it exposed to the starved probe of issue #897 — under concurrent
    // verification load even an `exit 0` stub can miss its budget, and the check
    // then reports the host's ETIMEDOUT rather than the stub's own answer. So
    // ask again from a clean run, and decline to assert at all if the host never
    // answered rather than failing as if the session were misconfigured.
    const { result: checks, answered } = await runUntilProbeAnswers(
      async () => doctorChecks({
        defaults: { implementationAgent: 'codex', reviewAgent: 'codex' },
        reviewDispute: { enabled: true, arbiter: { providers: ['claude'] } },
      }),
      // Both probed CLIs, plus the arbiter checks that cascade off them, so a
      // starved probe cannot reach the assertions as a derived failure.
      (result) => ['codexCli', 'claudeCli', ...ARBITER_CHECKS]
        .map((name) => result[name]?.error ?? '')
        .join('\n'),
    );
    if (!answered) return;
    // The role checks emit an entry only when the role is UNUSABLE, so their
    // absence is the positive signal — asserted explicitly so a future change
    // that starts failing them cannot pass this file silently.
    expect(checks.implementationAgentCli).toBeUndefined();
    expect(checks.reviewAgentCli).toBeUndefined();
    // The agents behind those roles were really probed, and both answered.
    expect(checks.codexCli.ok).toBe(true);
    expect(checks.claudeCli.ok).toBe(true);
    // …and all three arbiter checks pass, so an enabled session is ready.
    for (const name of ARBITER_CHECKS) expect(checks[name].ok).toBe(true);
    // Each attempt forks real children under a 60s probe budget apiece, so the
    // retry schedule needs headroom the file-wide default does not give it.
  }, 240_000);

  test('an unusable role skips the arbiter checks and says which one to fix first', async () => {
    const checks = await doctorChecks({
      defaults: { implementationAgent: 'not-an-agent', reviewAgent: 'codex' },
      reviewDispute: { enabled: true, arbiter: { providers: ['claude'] } },
    });
    expect(checks.implementationAgentCli.ok).toBe(false);
    // The arbiter is measured AGAINST the two parties (§8.3), so with one of
    // them unusable there is no question to answer — and the skip says so
    // rather than reporting a second, derived failure.
    expect(checks.arbiterConfig.ok).toBe(true);
    for (const name of ['arbiterCandidates', 'arbiterSelection']) {
      expect(checks[name].ok).toBe(false);
      expect(checks[name].error).toMatch(/^Skipped: the session's default implementation\/review agents are unusable/);
    }
  });

  test('when every arbitration would escalate, the remediation names both concrete fixes', async () => {
    const checks = await doctorChecks({
      defaults: { implementationAgent: 'claude', reviewAgent: 'claude' },
      reviewDispute: { enabled: true, arbiter: { providers: ['claude'] } },
    }, ALL_CLIS_AVAILABLE);
    expect(checks.arbiterSelection.ok).toBe(false);
    const error = checks.arbiterSelection.error;
    // The consequence, stated as a consequence…
    expect(error).toMatch(/Every arbitration would escalate to a human/);
    expect(error).toMatch(/§8\.3, §7 row 19/);
    // …and the two things an operator can actually do about it.
    expect(error).toMatch(/Add a candidate whose provider differs from both parties/);
    expect(error).toMatch(/reviewDispute\.arbiter\.allowSameProvider/);
  });

  // -------------------------------------------------------------------------
  // Reviewer reconsideration capability (issue #1073, contract §8.2/§17.12)
  // -------------------------------------------------------------------------

  test('reviewerReconsiderationCapability is not emitted while the dispute protocol is disabled', async () => {
    for (const reviewDispute of [undefined, { enabled: false }, { arbiter: { providers: ['claude'] } }]) {
      const checks = await doctorChecks(reviewDispute === undefined ? {} : { reviewDispute });
      expect(checks.reviewerReconsiderationCapability).toBeUndefined();
    }
  });

  test('a claude reviewer passes reconsideration capability even when no independent arbiter is configured', async () => {
    const checks = await doctorChecks({
      defaults: { implementationAgent: 'claude', reviewAgent: 'claude' },
      reviewDispute: { enabled: true, arbiter: { providers: ['claude'] } },
    }, ALL_CLIS_AVAILABLE);
    expect(checks.reviewerReconsiderationCapability).toMatchObject({ category: 'aiCli', ok: true });
    expect(checks.reviewerReconsiderationCapability.detail).toMatch(/claude may take the reviewer's §4\.1 reconsideration turn/);
    // Both parties on Anthropic refuse every arbiter candidate (§8.3) — that is
    // a real, documented limitation of THIS check, and it must not read as
    // reconsideration being unavailable too: the two checks disagree here on
    // purpose.
    expect(checks.arbiterSelection.ok).toBe(false);
  });

  test('a codex reviewer fails reconsideration capability without being reported as arbitration-unavailable', async () => {
    const checks = await doctorChecks({
      defaults: { implementationAgent: 'claude', reviewAgent: 'codex' },
      reviewDispute: { enabled: true, arbiter: { providers: ['claude'] } },
    }, ALL_CLIS_AVAILABLE);
    // Structured review support (D1) is unaffected: no reviewAgentCli finding.
    expect(checks.reviewAgentCli).toBeUndefined();
    expect(checks.reviewerReconsiderationCapability.ok).toBe(false);
    const error = checks.reviewerReconsiderationCapability.error;
    expect(error).toMatch(/Unsupported reconsideration agent: codex/);
    expect(error).toMatch(/profile_unavailable/);
    expect(error).toMatch(/contract §15 G2/);
    // Distinguished from the arbiter-unavailable case: fixing one is not fixing the other.
    expect(error).toMatch(/different stop from an unavailable independent arbiter/);
  });

  // Issue #1085: with the §17.6 D2 opt-in recorded, the same check must report
  // the turn as SUPPORTED and say under which posture — an operator who cannot
  // tell an enabled-and-supported Codex reconsideration from a disabled one, or
  // from the `no-tools` posture, has been given a tick and no information.
  test('a codex reviewer with the read-bounded opt-in passes, and the detail names the posture', async () => {
    const checks = await doctorChecks({
      defaults: { implementationAgent: 'claude', reviewAgent: 'codex' },
      reviewDispute: {
        enabled: true,
        arbiter: { providers: ['claude'] },
        reconsideration: { readBounded: true },
      },
    }, ALL_CLIS_AVAILABLE);
    expect(checks.reviewerReconsiderationCapability.ok).toBe(true);
    const detail = checks.reviewerReconsiderationCapability.detail;
    expect(detail).toMatch(/under the `read-bounded` posture/);
    // The limitation travels with the capability, at the surface an operator
    // reads before trusting a verdict.
    expect(detail).toMatch(/READS are not bounded/);
    expect(detail).toMatch(/reviewDispute\.reconsideration\.readBounded/);
    // It is not a claim about arbitration, which D2 did not admit.
    expect(checks.arbiterSelection.ok).toBe(false);
  });

  test('reviewerReconsiderationCapability is skipped when the review role itself is unusable', async () => {
    const checks = await doctorChecks({
      defaults: { implementationAgent: 'claude', reviewAgent: 'not-an-agent' },
      reviewDispute: { enabled: true, arbiter: { providers: ['claude'] } },
    });
    expect(checks.reviewerReconsiderationCapability.ok).toBe(false);
    expect(checks.reviewerReconsiderationCapability.error).toMatch(/^Skipped: the session's default review agent is unusable/);
  });

  test('ghRepoAccess check includes detail with githubRepo', async () => {
    writeSession();
    const r = await runDoctor('session-doctor', '--session-id', 'addon-dev', '--sessions-path', sessionsPath);
    expect(r.code).toBe(0);
    const out = parse(r);
    const check = out.checks.find((c) => c.name === 'ghRepoAccess');
    expect(check.detail).toBe('m2dw/some-repo');
  });

  test('distinct agents each get their own check entry', async () => {
    writeSession({
      defaults: { implementationAgent: 'claude', reviewAgent: 'codex', researchAgent: 'gemini' },
    });
    const r = await runDoctor('session-doctor', '--session-id', 'addon-dev', '--sessions-path', sessionsPath);
    expect(r.code).toBe(0);
    const out = parse(r);
    const names = out.checks.map((c) => c.name);
    expect(names).toContain('claudeCli');
    expect(names).toContain('codexCli');
    expect(names).toContain('geminiCli');
  });

  test('duplicate agents across roles produce a single check entry', async () => {
    writeSession({
      defaults: { implementationAgent: 'claude', reviewAgent: 'claude' },
    });
    const r = await runDoctor('session-doctor', '--session-id', 'addon-dev', '--sessions-path', sessionsPath);
    expect(r.code).toBe(0);
    const out = parse(r);
    const agentChecks = out.checks.filter((c) => c.name === 'claudeCli');
    expect(agentChecks).toHaveLength(1);
  });

  test('allPassed is false when any check fails', async () => {
    writeSession({ repoRoot: join(tmpDir, 'no-such-dir') });
    const r = await runDoctor('session-doctor', '--session-id', 'addon-dev', '--sessions-path', sessionsPath);
    expect(r.code).toBe(0);
    const out = parse(r);
    expect(out.allPassed).toBe(false);
  });

  test('session-doctor appears in help output', async () => {
    const r = await run('help');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('session-doctor');
  });

  const REQUIRED_LABELS = [
    'agent:claude', 'agent:codex', 'agent:gemini',
    'status:needs-implementation', 'status:needs-fix', 'status:needs-review',
    'status:research-needed', 'status:needs-conflict-resolution', 'status:backlog',
    'ai:active', 'ai:blocked', 'ai:ready-for-human',
  ];

  function writeGhStub(labelNames) {
    const json = JSON.stringify(labelNames.map((n) => ({ name: n })));
    const script = `#!/bin/sh\nif [ "$1" = "label" ] && [ "$2" = "list" ]; then\n  echo '${json}'\n  exit 0\nfi\nexit 0\n`;
    writeFileSync(join(tmpBin, 'gh'), script, { mode: 0o755 });
  }

  /**
   * Both label cases assert what the `gh` stub REPORTED, so a run the host was
   * too loaded to complete says nothing about them (issue #897): the probe comes
   * back ETIMEDOUT and the check carries the errno instead of the stub's JSON.
   * Every `github` check is inspected, not just this one, so the cascade
   * ("Skipped: githubRepo is not accessible") that a starved `gh repo view`
   * produces is recognised as the same non-answer.
   */
  async function runLabelsDoctor() {
    return runUntilProbeAnswers(
      () => runDoctor('session-doctor', '--session-id', 'addon-dev', '--sessions-path', sessionsPath),
      (run) => parse(run).checks
        .filter((c) => c.category === 'github')
        .map((c) => c.error ?? '')
        .join('\n'),
    );
  }

  test('ghRequiredLabels passes when all required labels are present', async () => {
    writeSession();
    writeGhStub(REQUIRED_LABELS);
    const { result: r, answered } = await runLabelsDoctor();
    if (!answered) return;
    expect(r.code).toBe(0);
    const out = parse(r);
    const check = out.checks.find((c) => c.name === 'ghRequiredLabels');
    expect(check.ok).toBe(true);
    // Each attempt forks real children under a 60s probe budget apiece, so the
    // retry schedule needs headroom the file-wide 30s does not give it.
  }, 240_000);

  test('ghRequiredLabels fails and lists missing labels with a create remediation', async () => {
    writeSession();
    writeGhStub(REQUIRED_LABELS.filter((l) => l !== 'status:backlog'));
    const { result: r, answered } = await runLabelsDoctor();
    if (!answered) return;
    expect(r.code).toBe(0);
    const out = parse(r);
    const check = out.checks.find((c) => c.name === 'ghRequiredLabels');
    expect(check.ok).toBe(false);
    expect(check.error).toContain('status:backlog');
    expect(check.error).toContain('gh label create');
  }, 240_000);

  test('ghRequiredLabels is skipped when githubRepo is not configured', async () => {
    writeSession({ githubRepo: undefined });
    const r = await runDoctor('session-doctor', '--session-id', 'addon-dev', '--sessions-path', sessionsPath);
    expect(r.code).toBe(0);
    const out = parse(r);
    const check = out.checks.find((c) => c.name === 'ghRequiredLabels');
    expect(check.ok).toBe(false);
    expect(check.error).toMatch(/Skipped/);
  });

  test('artifactDirGitignored passes when artifactDir is listed in .gitignore', async () => {
    mkdirSync(repoRoot, { recursive: true });
    execFileSync('git', ['init'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, '.gitignore'), '.n8n-artifacts/\n', 'utf8');
    writeSession();
    const r = await runDoctor('session-doctor', '--session-id', 'addon-dev', '--sessions-path', sessionsPath);
    expect(r.code).toBe(0);
    const out = parse(r);
    const check = out.checks.find((c) => c.name === 'artifactDirGitignored');
    expect(check.ok).toBe(true);
  });

  test('artifactDirGitignored fails with a fix remediation when artifactDir is not ignored', async () => {
    mkdirSync(repoRoot, { recursive: true });
    execFileSync('git', ['init'], { cwd: repoRoot });
    writeSession();
    const r = await runDoctor('session-doctor', '--session-id', 'addon-dev', '--sessions-path', sessionsPath);
    expect(r.code).toBe(0);
    const out = parse(r);
    const check = out.checks.find((c) => c.name === 'artifactDirGitignored');
    expect(check.ok).toBe(false);
    expect(check.error).toContain('.gitignore');
  });

  test('sqliteDbHealth passes when the db has not been created yet', async () => {
    writeSession();
    const dbFile = join(tmpDir, 'not-yet-created.db');
    const r = await runDoctor(
      'session-doctor', '--session-id', 'addon-dev', '--sessions-path', sessionsPath, '--db-path', dbFile,
    );
    expect(r.code).toBe(0);
    const out = parse(r);
    const check = out.checks.find((c) => c.name === 'sqliteDbHealth');
    expect(check.ok).toBe(true);
  });

  test('sqliteDbHealth passes for a healthy WAL-mode database', async () => {
    writeSession();
    const dbFile = join(tmpDir, 'healthy.db');
    const store = new SqliteTaskStore(dbFile);
    store.close();
    const r = await runDoctor(
      'session-doctor', '--session-id', 'addon-dev', '--sessions-path', sessionsPath, '--db-path', dbFile,
    );
    expect(r.code).toBe(0);
    const out = parse(r);
    const check = out.checks.find((c) => c.name === 'sqliteDbHealth');
    expect(check.ok).toBe(true);
  });

  test('sqliteDbHealth fails for a corrupt database file', async () => {
    writeSession();
    const dbFile = join(tmpDir, 'corrupt.db');
    writeFileSync(dbFile, 'not a real sqlite file', 'utf8');
    const r = await runDoctor(
      'session-doctor', '--session-id', 'addon-dev', '--sessions-path', sessionsPath, '--db-path', dbFile,
    );
    expect(r.code).toBe(0);
    const out = parse(r);
    const check = out.checks.find((c) => c.name === 'sqliteDbHealth');
    expect(check.ok).toBe(false);
  });

  test('worktreeStateRoot fails when session.worktrees.root is relative', async () => {
    writeSession({ worktrees: { root: 'relative/worktrees' } });
    const r = await runDoctor('session-doctor', '--session-id', 'addon-dev', '--sessions-path', sessionsPath);
    expect(r.code).toBe(0);
    const out = parse(r);
    const check = out.checks.find((c) => c.name === 'worktreeStateRoot');
    expect(check.ok).toBe(false);
    expect(check.error).toMatch(/absolute/);
  });

  test('worktreeStateRoot passes for a valid absolute root', async () => {
    writeSession({ worktrees: { root: join(tmpDir, 'worktrees') } });
    const r = await runDoctor('session-doctor', '--session-id', 'addon-dev', '--sessions-path', sessionsPath);
    expect(r.code).toBe(0);
    const out = parse(r);
    const check = out.checks.find((c) => c.name === 'worktreeStateRoot');
    expect(check.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// admin CLI — repo-lock subcommand
// ---------------------------------------------------------------------------

describe('admin CLI — repo-lock acquire subcommand', () => {
  async function createContext(contextId, sessionId) {
    return run('context', 'create', '--execution-id', contextId, '--session-id', sessionId, '--db-path', dbPath);
  }

  test('missing --context-id exits non-zero', async () => {
    const r = await run('repo-lock', 'acquire', '--db-path', dbPath, '--lock-dir', lockDir);
    expect(r.code).not.toBe(0);
    expect(parse(r)).toMatchObject({ ok: false, error: expect.stringContaining('context-id') });
  });

  test('unknown context-id exits non-zero', async () => {
    const r = await run('repo-lock', 'acquire', '--context-id', 'no-such-ctx', '--db-path', dbPath, '--lock-dir', lockDir);
    expect(r.code).not.toBe(0);
    expect(parse(r)).toMatchObject({ ok: false, error: expect.stringContaining('no-such-ctx') });
  });

  test('acquires lock and emits locked:true on first call', async () => {
    await createContext('ctx-100', 'my-session');
    const r = await run('repo-lock', 'acquire', '--context-id', 'ctx-100', '--db-path', dbPath, '--lock-dir', lockDir);
    expect(r.code).toBe(0);
    expect(parse(r)).toMatchObject({ ok: true, locked: true, contextId: 'ctx-100', sessionId: 'my-session' });
  });

  test('returns locked:false with reason lock_held when another context holds the lock', async () => {
    await createContext('ctx-100', 'my-session');
    await createContext('ctx-101', 'my-session');

    await run('repo-lock', 'acquire', '--context-id', 'ctx-100', '--db-path', dbPath, '--lock-dir', lockDir);

    const r = await run('repo-lock', 'acquire', '--context-id', 'ctx-101', '--db-path', dbPath, '--lock-dir', lockDir);
    expect(r.code).toBe(0);
    const out = parse(r);
    expect(out).toMatchObject({ ok: true, locked: false, reason: 'lock_held', ownerContextId: 'ctx-100' });
    expect(out.ownerStartedAt).toBeDefined();
  });

  test('different sessions do not contend', async () => {
    await createContext('ctx-200', 'session-a');
    await createContext('ctx-201', 'session-b');

    await run('repo-lock', 'acquire', '--context-id', 'ctx-200', '--db-path', dbPath, '--lock-dir', lockDir);

    const r = await run('repo-lock', 'acquire', '--context-id', 'ctx-201', '--db-path', dbPath, '--lock-dir', lockDir);
    expect(r.code).toBe(0);
    expect(parse(r)).toMatchObject({ ok: true, locked: true, contextId: 'ctx-201', sessionId: 'session-b' });
  });

  test('repo-lock acquire appears in help output', async () => {
    const r = await run('help');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('repo-lock acquire');
  });
});

describe('admin CLI — repo-lock status subcommand', () => {
  async function createContext(contextId, sessionId) {
    return run('context', 'create', '--execution-id', contextId, '--session-id', sessionId, '--db-path', dbPath);
  }

  test('missing --session-id exits non-zero', async () => {
    const r = await run('repo-lock', 'status', '--lock-dir', lockDir);
    expect(r.code).not.toBe(0);
    expect(parse(r)).toMatchObject({ ok: false, error: expect.stringContaining('session-id') });
  });

  test('status with no lock: locked:false, null owner fields', async () => {
    const r = await run('repo-lock', 'status', '--session-id', 'my-session', '--lock-dir', lockDir);
    expect(r.code).toBe(0);
    const out = parse(r);
    expect(out).toMatchObject({
      ok: true,
      sessionId: 'my-session',
      locked: false,
      contextId: null,
      startedAt: null,
      ageMs: null,
      stale: null,
    });
    expect(typeof out.lockPath).toBe('string');
    expect(out.lockPath).toContain('my-session');
  });

  test('status with active lock: locked:true with owner fields', async () => {
    await createContext('ctx-s1', 'my-session');
    await run('repo-lock', 'acquire', '--context-id', 'ctx-s1', '--db-path', dbPath, '--lock-dir', lockDir);

    const r = await run('repo-lock', 'status', '--session-id', 'my-session', '--lock-dir', lockDir);
    expect(r.code).toBe(0);
    const out = parse(r);
    expect(out).toMatchObject({
      ok: true,
      sessionId: 'my-session',
      locked: true,
      contextId: 'ctx-s1',
      stale: false,
    });
    expect(typeof out.startedAt).toBe('string');
    expect(typeof out.ageMs).toBe('number');
    expect(out.ageMs).toBeGreaterThanOrEqual(0);
    expect(typeof out.lockPath).toBe('string');
  });

  test('repo-lock status appears in help output', async () => {
    const r = await run('help');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('repo-lock status');
  });
});

describe('admin CLI — repo-lock force-release subcommand', () => {
  async function createContext(contextId, sessionId) {
    return run('context', 'create', '--execution-id', contextId, '--session-id', sessionId, '--db-path', dbPath);
  }

  test('missing --session-id exits non-zero', async () => {
    const r = await run('repo-lock', 'force-release', '--yes', '--lock-dir', lockDir);
    expect(r.code).not.toBe(0);
    expect(parse(r)).toMatchObject({ ok: false, error: expect.stringContaining('session-id') });
  });

  test('refuses without --yes', async () => {
    const r = await run('repo-lock', 'force-release', '--session-id', 'my-session', '--lock-dir', lockDir);
    expect(r.code).not.toBe(0);
    expect(parse(r)).toMatchObject({ ok: false, error: expect.stringContaining('--yes') });
  });

  test('idempotent: released:false with reason no_lock when no lock exists', async () => {
    const r = await run('repo-lock', 'force-release', '--session-id', 'my-session', '--yes', '--lock-dir', lockDir);
    expect(r.code).toBe(0);
    expect(parse(r)).toMatchObject({ ok: true, released: false, reason: 'no_lock' });
  });

  test('force-release with owner match: removes the lock', async () => {
    await createContext('ctx-fr1', 'my-session');
    await run('repo-lock', 'acquire', '--context-id', 'ctx-fr1', '--db-path', dbPath, '--lock-dir', lockDir);

    const r = await run('repo-lock', 'force-release', '--session-id', 'my-session', '--context-id', 'ctx-fr1', '--yes', '--lock-dir', lockDir);
    expect(r.code).toBe(0);
    const out = parse(r);
    expect(out).toMatchObject({ ok: true, released: true, ownerContextId: 'ctx-fr1', wasStale: false });

    // Lock should be gone: status now reports unlocked
    const status = parse(await run('repo-lock', 'status', '--session-id', 'my-session', '--lock-dir', lockDir));
    expect(status.locked).toBe(false);
  });

  test('force-release with owner mismatch: refuses when --context-id does not match owner', async () => {
    await createContext('ctx-fr2', 'my-session');
    await run('repo-lock', 'acquire', '--context-id', 'ctx-fr2', '--db-path', dbPath, '--lock-dir', lockDir);

    const r = await run('repo-lock', 'force-release', '--session-id', 'my-session', '--context-id', 'ctx-OTHER', '--yes', '--lock-dir', lockDir);
    expect(r.code).toBe(0);
    const out = parse(r);
    expect(out).toMatchObject({ ok: true, released: false, reason: 'owner_mismatch', ownerContextId: 'ctx-fr2' });

    // Lock should still be held
    const status = parse(await run('repo-lock', 'status', '--session-id', 'my-session', '--lock-dir', lockDir));
    expect(status.locked).toBe(true);
    expect(status.contextId).toBe('ctx-fr2');
  });

  test('force-release without --context-id removes any lock regardless of owner', async () => {
    await createContext('ctx-fr3', 'my-session');
    await run('repo-lock', 'acquire', '--context-id', 'ctx-fr3', '--db-path', dbPath, '--lock-dir', lockDir);

    const r = await run('repo-lock', 'force-release', '--session-id', 'my-session', '--yes', '--lock-dir', lockDir);
    expect(r.code).toBe(0);
    const out = parse(r);
    expect(out).toMatchObject({ ok: true, released: true, ownerContextId: 'ctx-fr3' });
  });

  test('repo-lock force-release appears in help output', async () => {
    const r = await run('help');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('repo-lock force-release');
  });
});

describe('admin CLI — repo-lock release subcommand', () => {
  async function createContext(contextId, sessionId) {
    return run('context', 'create', '--execution-id', contextId, '--session-id', sessionId, '--db-path', dbPath);
  }

  test('missing --context-id exits non-zero', async () => {
    const r = await run('repo-lock', 'release', '--db-path', dbPath, '--lock-dir', lockDir);
    expect(r.code).not.toBe(0);
    expect(parse(r)).toMatchObject({ ok: false, error: expect.stringContaining('context-id') });
  });

  test('unknown context-id exits non-zero', async () => {
    const r = await run('repo-lock', 'release', '--context-id', 'no-such-ctx', '--db-path', dbPath, '--lock-dir', lockDir);
    expect(r.code).not.toBe(0);
    expect(parse(r)).toMatchObject({ ok: false, error: expect.stringContaining('no-such-ctx') });
  });

  test('releases the lock when owner matches and returns released:true', async () => {
    await createContext('ctx-300', 'my-session');
    await run('repo-lock', 'acquire', '--context-id', 'ctx-300', '--db-path', dbPath, '--lock-dir', lockDir);

    const r = await run('repo-lock', 'release', '--context-id', 'ctx-300', '--db-path', dbPath, '--lock-dir', lockDir);
    expect(r.code).toBe(0);
    expect(parse(r)).toMatchObject({ ok: true, released: true });
  });

  test('returns released:false with reason not_owner when context is not the lock owner', async () => {
    await createContext('ctx-300', 'my-session');
    await createContext('ctx-399', 'my-session');
    await run('repo-lock', 'acquire', '--context-id', 'ctx-300', '--db-path', dbPath, '--lock-dir', lockDir);

    const r = await run('repo-lock', 'release', '--context-id', 'ctx-399', '--db-path', dbPath, '--lock-dir', lockDir);
    expect(r.code).toBe(0);
    expect(parse(r)).toMatchObject({ ok: true, released: false, reason: 'not_owner' });
  });

  test('returns released:false with reason no_lock when no lock exists (idempotent)', async () => {
    await createContext('ctx-300', 'my-session');
    const r = await run('repo-lock', 'release', '--context-id', 'ctx-300', '--db-path', dbPath, '--lock-dir', lockDir);
    expect(r.code).toBe(0);
    expect(parse(r)).toMatchObject({ ok: true, released: false, reason: 'no_lock' });
  });

  test('a subsequent acquire succeeds after release', async () => {
    await createContext('ctx-300', 'my-session');
    await createContext('ctx-301', 'my-session');
    await run('repo-lock', 'acquire', '--context-id', 'ctx-300', '--db-path', dbPath, '--lock-dir', lockDir);
    await run('repo-lock', 'release', '--context-id', 'ctx-300', '--db-path', dbPath, '--lock-dir', lockDir);

    const r = await run('repo-lock', 'acquire', '--context-id', 'ctx-301', '--db-path', dbPath, '--lock-dir', lockDir);
    expect(r.code).toBe(0);
    expect(parse(r)).toMatchObject({ ok: true, locked: true, contextId: 'ctx-301' });
  });

  test('repo-lock release appears in help output', async () => {
    const r = await run('help');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('repo-lock release');
  });
});

describe('admin CLI — task-assign subcommand', () => {
  let sessionsPath;

  const SESSION = {
    sessionId: 'test-session',
    repoKey: 'test-repo',
    repoRoot: '/tmp/test-repo',
    githubRepo: 'm2dw/test-repo',
    artifactDir: '.n8n-artifacts',
    defaults: { implementationAgent: 'claude', reviewAgent: 'codex' },
    verification: {},
    labels: { active: 'ai:active', blocked: 'ai:blocked', readyForHuman: 'ai:ready-for-human' },
    assignmentProfiles: {
      codexOnly: { implementation: 'codex', review: 'codex' },
      docs: { implementation: 'claude', review: 'claude' },
    },
    flowRules: [
      { flow: 'codexOnly', labels: ['agent:codex'] },
      { flow: 'code', default: true },
    ],
  };

  beforeEach(() => {
    sessionsPath = join(tmpDir, 'sessions.json');
    writeFileSync(sessionsPath, JSON.stringify({ sessions: [SESSION] }), 'utf8');
  });

  function baseArgs(...extra) {
    return [
      'task-assign',
      '--session-id', 'test-session',
      '--issue-number', '42',
      '--sessions-path', sessionsPath,
      '--db-path', dbPath,
      ...extra,
    ];
  }

  test('missing --session-id exits non-zero', async () => {
    const r = await run('task-assign', '--issue-number', '42', '--profile', 'codexOnly', '--sessions-path', sessionsPath, '--db-path', dbPath);
    expect(r.code).not.toBe(0);
    expect(parse(r)).toMatchObject({ ok: false, error: expect.stringContaining('session-id') });
  });

  test('missing --issue-number exits non-zero', async () => {
    const r = await run('task-assign', '--session-id', 'test-session', '--profile', 'codexOnly', '--sessions-path', sessionsPath, '--db-path', dbPath);
    expect(r.code).not.toBe(0);
    expect(parse(r)).toMatchObject({ ok: false, error: expect.stringContaining('issue-number') });
  });

  test('no profile or agent flags exits non-zero', async () => {
    const r = await run(...baseArgs());
    expect(r.code).not.toBe(0);
    expect(parse(r)).toMatchObject({ ok: false, error: expect.stringContaining('--profile') });
  });

  test('invalid --implementation-agent value exits non-zero', async () => {
    const r = await run(...baseArgs('--implementation-agent', 'gpt4'));
    expect(r.code).not.toBe(0);
    expect(parse(r)).toMatchObject({ ok: false, error: expect.stringContaining('implementation-agent') });
  });

  test('unknown profile exits non-zero', async () => {
    const store = new SqliteTaskStore(dbPath);
    await store.enqueueTask({ sessionId: 'test-session', issueNumber: 42, phase: 'implementation' });
    store.close();

    const r = await run(...baseArgs('--profile', 'no-such-profile'));
    expect(r.code).not.toBe(0);
    expect(parse(r)).toMatchObject({ ok: false, error: expect.stringContaining('no-such-profile') });
  });

  test('unknown session exits non-zero', async () => {
    const r = await run('task-assign', '--session-id', 'unknown-session', '--issue-number', '42', '--profile', 'codexOnly', '--sessions-path', sessionsPath, '--db-path', dbPath);
    expect(r.code).not.toBe(0);
    expect(parse(r)).toMatchObject({ ok: false });
  });

  test('task not found exits non-zero', async () => {
    const r = await run(...baseArgs('--profile', 'codexOnly'));
    expect(r.code).not.toBe(0);
    expect(parse(r)).toMatchObject({ ok: false, error: expect.stringContaining('#42') });
  });

  test('refuses to reassign a claimed task', async () => {
    const futureLease = new Date(Date.now() + 30 * 60_000).toISOString();
    const store = new SqliteTaskStore(dbPath);
    await store.enqueueTask({ sessionId: 'test-session', issueNumber: 42, phase: 'implementation' });
    await store.transitionTask(
      { sessionId: 'test-session', issueNumber: 42 },
      { status: 'queued' },
      { status: 'claimed', ownerRunId: 'run-active', leaseExpiresAt: futureLease },
    );
    store.close();

    const r = await run(...baseArgs('--profile', 'codexOnly'));
    expect(r.code).not.toBe(0);
    expect(parse(r)).toMatchObject({ ok: false, error: expect.stringContaining('claimed') });
  });

  test('refuses to reassign a running task', async () => {
    const futureLease = new Date(Date.now() + 30 * 60_000).toISOString();
    const store = new SqliteTaskStore(dbPath);
    await store.enqueueTask({ sessionId: 'test-session', issueNumber: 42, phase: 'implementation' });
    await store.transitionTask(
      { sessionId: 'test-session', issueNumber: 42 },
      { status: 'queued' },
      { status: 'running', ownerRunId: 'run-active', leaseExpiresAt: futureLease },
    );
    store.close();

    const r = await run(...baseArgs('--profile', 'codexOnly'));
    expect(r.code).not.toBe(0);
    expect(parse(r)).toMatchObject({ ok: false, error: expect.stringContaining('running') });
  });

  test('reassigns a failed task to a named profile', async () => {
    const store = new SqliteTaskStore(dbPath);
    await store.enqueueTask({ sessionId: 'test-session', issueNumber: 42, phase: 'implementation' });
    await store.transitionTask(
      { sessionId: 'test-session', issueNumber: 42 },
      { status: 'queued' },
      { status: 'failed', lastError: 'timed out' },
    );
    store.close();

    const r = await run(...baseArgs('--profile', 'codexOnly'));
    expect(r.code).toBe(0);
    const out = parse(r);
    expect(out.ok).toBe(true);
    expect(out.sessionId).toBe('test-session');
    expect(out.issueNumber).toBe(42);
    expect(out.new).toMatchObject({
      flow: 'codexOnly',
      implementationAgent: 'codex',
      reviewAgent: 'codex',
    });
  });

  test('reassigns a ready_for_human task using explicit agents', async () => {
    const store = new SqliteTaskStore(dbPath);
    await store.enqueueTask({ sessionId: 'test-session', issueNumber: 42, phase: 'review' });
    await store.transitionTask(
      { sessionId: 'test-session', issueNumber: 42 },
      { status: 'queued' },
      { status: 'ready_for_human' },
    );
    store.close();

    const r = await run(...baseArgs('--implementation-agent', 'codex', '--review-agent', 'codex'));
    expect(r.code).toBe(0);
    const out = parse(r);
    expect(out.ok).toBe(true);
    expect(out.new).toMatchObject({ implementationAgent: 'codex', reviewAgent: 'codex' });
  });

  test('reassigns a queued task using the built-in code profile', async () => {
    const store = new SqliteTaskStore(dbPath);
    await store.enqueueTask({ sessionId: 'test-session', issueNumber: 42, phase: 'implementation' });
    store.close();

    const r = await run(...baseArgs('--profile', 'code'));
    expect(r.code).toBe(0);
    const out = parse(r);
    expect(out.ok).toBe(true);
    expect(out.new).toMatchObject({
      flow: 'code',
      implementationAgent: 'claude',
      reviewAgent: 'codex',
    });
  });

  test('dry-run reports intended change without writing to DB', async () => {
    const store = new SqliteTaskStore(dbPath);
    await store.enqueueTask({
      sessionId: 'test-session',
      issueNumber: 42,
      phase: 'implementation',
      implementationAgent: 'claude',
    });
    store.close();

    const r = await run(...baseArgs('--profile', 'codexOnly', '--dry-run'));
    expect(r.code).toBe(0);
    const out = parse(r);
    expect(out.ok).toBe(true);
    expect(out.dryRun).toBe(true);
    expect(out.new).toMatchObject({ implementationAgent: 'codex', reviewAgent: 'codex' });

    // Task should be unchanged
    const store2 = new SqliteTaskStore(dbPath);
    const tasks = store2.listTasks('test-session', 42);
    store2.close();
    expect(tasks[0].implementationAgent).toBe('claude');
  });

  test('dry-run does not append an event', async () => {
    const store = new SqliteTaskStore(dbPath);
    await store.enqueueTask({ sessionId: 'test-session', issueNumber: 42, phase: 'implementation' });
    store.close();

    await run(...baseArgs('--profile', 'codexOnly', '--dry-run'));

    const store2 = new SqliteTaskStore(dbPath);
    const events = await store2.listEvents({ sessionId: 'test-session', issueNumber: 42 });
    store2.close();
    expect(events.filter(e => e.type === 'assignment_changed')).toHaveLength(0);
  });

  test('appends an assignment_changed event on successful reassignment', async () => {
    const store = new SqliteTaskStore(dbPath);
    await store.enqueueTask({ sessionId: 'test-session', issueNumber: 42, phase: 'implementation' });
    store.close();

    const r = await run(...baseArgs('--profile', 'codexOnly'));
    expect(r.code).toBe(0);

    const store2 = new SqliteTaskStore(dbPath);
    const events = await store2.listEvents({ sessionId: 'test-session', issueNumber: 42 });
    store2.close();

    const event = events.find(e => e.type === 'assignment_changed');
    expect(event).toBeDefined();
    expect(event.data.profile).toBe('codexOnly');
    expect(event.data.new).toMatchObject({ implementationAgent: 'codex' });
  });

  test('emits previous and new assignment in output', async () => {
    const store = new SqliteTaskStore(dbPath);
    await store.enqueueTask({
      sessionId: 'test-session',
      issueNumber: 42,
      phase: 'implementation',
      context: {
        assignment: {
          flow: 'code',
          implementationAgent: 'claude',
          reviewAgent: 'codex',
          conflictResolutionAgent: 'claude',
          resolvedAt: new Date().toISOString(),
          source: 'default',
        },
      },
    });
    store.close();

    const r = await run(...baseArgs('--profile', 'codexOnly'));
    expect(r.code).toBe(0);
    const out = parse(r);
    expect(out.previous).toMatchObject({ implementationAgent: 'claude', reviewAgent: 'codex' });
    expect(out.new).toMatchObject({ implementationAgent: 'codex', reviewAgent: 'codex', flow: 'codexOnly' });
  });

  test('does not modify task status, phase, or other context fields', async () => {
    const store = new SqliteTaskStore(dbPath);
    await store.enqueueTask({
      sessionId: 'test-session',
      issueNumber: 42,
      phase: 'review',
      context: { prUrl: 'https://github.com/m2dw/test-repo/pull/5', branch: 'ai/issue-42' },
    });
    await store.transitionTask(
      { sessionId: 'test-session', issueNumber: 42 },
      { status: 'queued' },
      { status: 'ready_for_human' },
    );
    store.close();

    const r = await run(...baseArgs('--profile', 'docs'));
    expect(r.code).toBe(0);

    const store2 = new SqliteTaskStore(dbPath);
    const tasks = store2.listTasks('test-session', 42);
    store2.close();
    const t = tasks[0];
    expect(t.status).toBe('ready_for_human');
    expect(t.phase).toBe('review');
    expect(t.context.prUrl).toBe('https://github.com/m2dw/test-repo/pull/5');
    expect(t.context.branch).toBe('ai/issue-42');
  });

  test('GitHub labels are not changed (no outbox entries)', async () => {
    const store = new SqliteTaskStore(dbPath);
    await store.enqueueTask({ sessionId: 'test-session', issueNumber: 42, phase: 'implementation' });
    store.close();

    await run(...baseArgs('--profile', 'codexOnly'));

    // SqliteTaskStore does not create outbox entries; command must not emit any
    // label side effects. We verify by confirming no exception and the result is ok.
    const r = await run(...baseArgs('--profile', 'docs'));
    expect(r.code).toBe(0);
  });

  test('task-assign appears in help output', async () => {
    const r = await run('help');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('task-assign');
  });
});

// ---------------------------------------------------------------------------
// Output contract (issue #308): human-readable default + --json structured
// ---------------------------------------------------------------------------

describe('admin CLI — output contract (issue #308)', () => {
  function isJsonStdout(stdout) {
    const trimmed = stdout.trim();
    if (trimmed === '' || trimmed[0] !== '{') return false;
    try {
      JSON.parse(trimmed);
      return true;
    } catch {
      return false;
    }
  }

  test('global options are documented in help', async () => {
    const r = await run('help');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Global options');
    expect(r.stdout).toContain('--json');
    expect(r.stdout).toContain('--quiet');
    expect(r.stdout).toContain('--verbose');
  });

  test('per-command help notes the default output mode', async () => {
    const operator = await run('help', 'task-status');
    expect(operator.stdout).toContain('human-readable by default');
    const machine = await run('help', 'context create');
    expect(machine.stdout).toContain('structured JSON');
  });

  test('task-status prints human-readable text by default (no tasks)', async () => {
    const r = await run('task-status', '--session-id', 'addon-dev', '--db-path', dbPath);
    expect(r.code).toBe(0);
    expect(isJsonStdout(r.stdout)).toBe(false);
    expect(r.stdout).toContain('No tasks found');
    expect(r.stdout).toContain('addon-dev');
  });

  test('task-status renders task rows as readable text by default', async () => {
    const store = new SqliteTaskStore(dbPath);
    await store.enqueueTask({ sessionId: 'addon-dev', issueNumber: 10, phase: 'research' });
    store.close();

    const r = await run('task-status', '--session-id', 'addon-dev', '--db-path', dbPath);
    expect(r.code).toBe(0);
    expect(isJsonStdout(r.stdout)).toBe(false);
    expect(r.stdout).toContain('#10');
    expect(r.stdout).toContain('queued');
    expect(r.stdout).toContain('research');
  });

  test('task-status --json still emits structured JSON for machine callers', async () => {
    const store = new SqliteTaskStore(dbPath);
    await store.enqueueTask({ sessionId: 'addon-dev', issueNumber: 10, phase: 'research' });
    store.close();

    const r = await run('task-status', '--session-id', 'addon-dev', '--db-path', dbPath, '--json');
    expect(r.code).toBe(0);
    expect(isJsonStdout(r.stdout)).toBe(true);
    const out = JSON.parse(r.stdout.trim());
    expect(out.ok).toBe(true);
    expect(out.tasks[0]).toMatchObject({ issueNumber: 10, phase: 'research', status: 'queued' });
  });

  test('list-stuck prints human-readable text by default (none stuck)', async () => {
    const r = await run('list-stuck', '--session-id', 'addon-dev', '--db-path', dbPath);
    expect(r.code).toBe(0);
    expect(isJsonStdout(r.stdout)).toBe(false);
    expect(r.stdout).toContain('No stuck tasks');
  });

  test('recover --dry-run prints a human-readable planned action by default', async () => {
    const r = await run('recover', '--session-id', 'addon-dev', '--dry-run', '--db-path', dbPath);
    expect(r.code).toBe(0);
    expect(isJsonStdout(r.stdout)).toBe(false);
    expect(r.stdout).toContain('Dry run');
  });

  test('recover --dry-run --json emits structured JSON', async () => {
    const r = await run('recover', '--session-id', 'addon-dev', '--dry-run', '--db-path', dbPath, '--json');
    expect(r.code).toBe(0);
    expect(isJsonStdout(r.stdout)).toBe(true);
    expect(JSON.parse(r.stdout.trim())).toMatchObject({ ok: true, dryRun: true, wouldRecover: [] });
  });

  test('recover-cap-handoff --dry-run prints a human-readable planned action by default', async () => {
    const r = await run('recover-cap-handoff', '--session-id', 'addon-dev', '--dry-run', '--db-path', dbPath);
    expect(r.code).toBe(0);
    expect(isJsonStdout(r.stdout)).toBe(false);
    expect(r.stdout).toContain('Dry run');
  });

  test('--quiet suppresses the summary header in human output', async () => {
    const store = new SqliteTaskStore(dbPath);
    await store.enqueueTask({ sessionId: 'addon-dev', issueNumber: 10, phase: 'research' });
    store.close();

    const r = await run('task-status', '--session-id', 'addon-dev', '--db-path', dbPath, '--quiet');
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain('task(s) for');
    expect(r.stdout).toContain('#10');
  });

  test('human-mode errors go to stderr, not stdout', async () => {
    const r = await runFull('task-status', '--db-path', dbPath);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('session-id');
    expect(isJsonStdout(r.stdout)).toBe(false);
  });

  test('JSON-mode errors stay on stdout for machine callers', async () => {
    const r = await runFull('task-status', '--db-path', dbPath, '--json');
    expect(r.code).not.toBe(0);
    expect(isJsonStdout(r.stdout)).toBe(true);
    expect(JSON.parse(r.stdout.trim())).toMatchObject({ ok: false });
  });

  test('machine commands (context create) still default to JSON', async () => {
    const r = await run('context', 'create', '--execution-id', 'exec-1', '--session-id', 'addon-dev', '--db-path', dbPath);
    expect(r.code).toBe(0);
    expect(isJsonStdout(r.stdout)).toBe(true);
    expect(JSON.parse(r.stdout.trim())).toMatchObject({ ok: true, contextId: 'exec-1' });
  });
});
