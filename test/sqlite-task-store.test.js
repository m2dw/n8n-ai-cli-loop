import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SqliteTaskStore, nextPhaseAfter, runNextPhase } from '../dist/index.js';

let tmpDir;
let store;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'sqlite-task-store-test-'));
  store = new SqliteTaskStore(join(tmpDir, 'test.db'));
});

afterEach(() => {
  store.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('SqliteTaskStore', () => {
  test('claims one runnable task atomically for a session', async () => {
    await store.enqueueTask({
      sessionId: 'addon-dev',
      issueNumber: 134,
      phase: 'implementation',
      priority: 'normal',
      now: '2026-06-06T00:00:00.000Z',
    });

    const claimed = await store.claimNextTask({
      sessionId: 'addon-dev',
      workerId: 'worker-a',
      runId: 'run-1',
      now: '2026-06-06T00:01:00.000Z',
      leaseMs: 60000,
    });
    const secondClaim = await store.claimNextTask({
      sessionId: 'addon-dev',
      workerId: 'worker-b',
      runId: 'run-2',
      now: '2026-06-06T00:01:01.000Z',
      leaseMs: 60000,
    });

    expect(claimed).toMatchObject({
      issueNumber: 134,
      status: 'claimed',
      ownerRunId: 'run-1',
      context: { workerId: 'worker-a' },
    });
    expect(secondClaim).toBeUndefined();
  });

  test('does not claim tasks from another session', async () => {
    await store.enqueueTask({
      sessionId: 'addon-dev',
      issueNumber: 134,
      phase: 'implementation',
      now: '2026-06-06T00:00:00.000Z',
    });

    const claimed = await store.claimNextTask({
      sessionId: 'workflow-dev',
      workerId: 'worker-a',
      runId: 'run-1',
      now: '2026-06-06T00:01:00.000Z',
    });

    expect(claimed).toBeUndefined();
  });

  test('enqueueTask returns already_exists on duplicate', async () => {
    await store.enqueueTask({
      sessionId: 'addon-dev',
      issueNumber: 134,
      phase: 'implementation',
      now: '2026-06-06T00:00:00.000Z',
    });

    const second = await store.enqueueTask({
      sessionId: 'addon-dev',
      issueNumber: 134,
      phase: 'implementation',
      now: '2026-06-06T00:00:01.000Z',
    });

    expect(second).toMatchObject({ ok: false, code: 'already_exists' });
  });

  test('transitionTask uses compare-and-swap expectations', async () => {
    await store.enqueueTask({
      sessionId: 'addon-dev',
      issueNumber: 134,
      phase: 'implementation',
      now: '2026-06-06T00:00:00.000Z',
    });
    await store.claimNextTask({
      sessionId: 'addon-dev',
      workerId: 'worker-a',
      runId: 'run-1',
      now: '2026-06-06T00:01:00.000Z',
    });

    const conflict = await store.transitionTask(
      { sessionId: 'addon-dev', issueNumber: 134 },
      { status: 'queued' },
      { status: 'running', now: '2026-06-06T00:02:00.000Z' },
    );
    const updated = await store.transitionTask(
      { sessionId: 'addon-dev', issueNumber: 134 },
      { status: 'claimed', ownerRunId: 'run-1' },
      { status: 'running', now: '2026-06-06T00:02:00.000Z' },
    );

    expect(conflict).toMatchObject({ ok: false, code: 'conflict' });
    expect(updated).toMatchObject({ ok: true, value: { status: 'running', ownerRunId: 'run-1' } });
  });

  test('transitionTask returns not_found for missing task', async () => {
    const result = await store.transitionTask(
      { sessionId: 'ghost', issueNumber: 999 },
      {},
      { status: 'running', now: '2026-06-06T00:00:00.000Z' },
    );
    expect(result).toMatchObject({ ok: false, code: 'not_found' });
  });

  test('releaseClaim only releases the matching owner', async () => {
    await store.enqueueTask({
      sessionId: 'addon-dev',
      issueNumber: 134,
      phase: 'implementation',
      now: '2026-06-06T00:00:00.000Z',
    });
    await store.claimNextTask({
      sessionId: 'addon-dev',
      workerId: 'worker-a',
      runId: 'run-1',
      now: '2026-06-06T00:01:00.000Z',
    });

    const wrongOwner = await store.releaseClaim({ sessionId: 'addon-dev', issueNumber: 134 }, 'run-2');
    const released = await store.releaseClaim({ sessionId: 'addon-dev', issueNumber: 134 }, 'run-1');

    expect(wrongOwner).toMatchObject({ ok: false, code: 'conflict' });
    expect(released).toMatchObject({ ok: true, value: { status: 'queued' } });
  });

  test('expired claims become runnable again', async () => {
    await store.enqueueTask({
      sessionId: 'addon-dev',
      issueNumber: 134,
      phase: 'implementation',
      now: '2026-06-06T00:00:00.000Z',
    });
    await store.claimNextTask({
      sessionId: 'addon-dev',
      workerId: 'worker-a',
      runId: 'run-1',
      now: '2026-06-06T00:01:00.000Z',
      leaseMs: 1000,
    });

    const reclaimed = await store.claimNextTask({
      sessionId: 'addon-dev',
      workerId: 'worker-b',
      runId: 'run-2',
      now: '2026-06-06T00:01:02.000Z',
    });

    expect(reclaimed).toMatchObject({
      issueNumber: 134,
      status: 'claimed',
      ownerRunId: 'run-2',
      context: { workerId: 'worker-b' },
    });
  });

  test('appendEvent and listEvents persist and retrieve correctly', async () => {
    const key = { sessionId: 'addon-dev', issueNumber: 134 };
    await store.appendEvent({ task: key, type: 'phase.started', runId: 'run-1', createdAt: '2026-06-06T00:01:00.000Z' });
    await store.appendEvent({ task: key, type: 'phase.completed', runId: 'run-1', data: { result: 'success' }, createdAt: '2026-06-06T00:02:00.000Z' });

    const events = await store.listEvents(key);

    expect(events).toMatchObject([
      { type: 'phase.started', runId: 'run-1' },
      { type: 'phase.completed', runId: 'run-1', data: { result: 'success' } },
    ]);
  });

  test('listEvents does not leak events from other tasks', async () => {
    const key1 = { sessionId: 'addon-dev', issueNumber: 1 };
    const key2 = { sessionId: 'addon-dev', issueNumber: 2 };
    await store.appendEvent({ task: key1, type: 'ping', createdAt: '2026-06-06T00:00:00.000Z' });
    await store.appendEvent({ task: key2, type: 'pong', createdAt: '2026-06-06T00:00:01.000Z' });

    const events = await store.listEvents(key1);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('ping');
  });
});

describe('runNextPhase with SqliteTaskStore', () => {
  test('runs only the claimed phase and persists the next state', async () => {
    await store.enqueueTask({
      sessionId: 'addon-dev',
      issueNumber: 134,
      phase: 'implementation',
      implementationAgent: 'claude',
      reviewAgent: 'codex',
      now: '2026-06-06T00:00:00.000Z',
    });

    const outcome = await runNextPhase({
      store,
      request: {
        sessionId: 'addon-dev',
        workerId: 'worker-a',
        runId: 'run-1',
        now: '2026-06-06T00:01:00.000Z',
      },
      handlers: {
        implementation: async (task) => ({
          result: 'success',
          context: { handledIssue: task.issueNumber },
        }),
      },
    });

    expect(outcome).toMatchObject({
      status: 'completed',
      task: {
        status: 'queued',
        phase: 'review',
        ownerRunId: undefined,
        context: { handledIssue: 134 },
        attempts: { implementation: 1 },
      },
    });
    await expect(store.listEvents({ sessionId: 'addon-dev', issueNumber: 134 })).resolves.toMatchObject([
      { type: 'phase.started', runId: 'run-1' },
      { type: 'phase.completed', runId: 'run-1' },
    ]);
  });

  test('moves missing phase handlers to human review', async () => {
    await store.enqueueTask({
      sessionId: 'addon-dev',
      issueNumber: 135,
      phase: 'review',
      now: '2026-06-06T00:00:00.000Z',
    });

    const outcome = await runNextPhase({
      store,
      request: {
        sessionId: 'addon-dev',
        workerId: 'worker-a',
        runId: 'run-1',
        now: '2026-06-06T00:01:00.000Z',
      },
      handlers: {},
    });

    expect(outcome).toMatchObject({
      status: 'phase_missing',
      task: {
        status: 'ready_for_human',
        phase: 'review',
        lastError: 'No handler registered for phase: review',
      },
    });
  });
});

describe('SqliteTaskStore concurrent enqueueTask (two connections, same DB)', () => {
  test('exactly one enqueue wins; the other returns already_exists without throwing', async () => {
    let tmpDir2;
    let storeA;
    let storeB;

    tmpDir2 = mkdtempSync(join(tmpdir(), 'sqlite-concurrent-enqueue-'));
    const dbPath = join(tmpDir2, 'shared.db');

    try {
      storeA = new SqliteTaskStore(dbPath);
      storeB = new SqliteTaskStore(dbPath);

      const input = {
        sessionId: 'concurrent-session',
        issueNumber: 3,
        phase: 'implementation',
        now: '2026-06-06T00:00:00.000Z',
      };

      const [resultA, resultB] = await Promise.all([
        storeA.enqueueTask(input),
        storeB.enqueueTask(input),
      ]);

      const winners = [resultA, resultB].filter((r) => r.ok);
      const losers = [resultA, resultB].filter((r) => !r.ok);
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);
      expect(losers[0]).toMatchObject({ ok: false, code: 'already_exists' });
    } finally {
      storeA?.close();
      storeB?.close();
      rmSync(tmpDir2, { recursive: true, force: true });
    }
  });
});

describe('SqliteTaskStore concurrent transitionTask (two connections, same DB)', () => {
  test('exactly one transition wins; the other gets a clean conflict or not_found', async () => {
    let tmpDir2;
    let storeA;
    let storeB;

    tmpDir2 = mkdtempSync(join(tmpdir(), 'sqlite-concurrent-transition-'));
    const dbPath = join(tmpDir2, 'shared.db');

    try {
      storeA = new SqliteTaskStore(dbPath);
      storeB = new SqliteTaskStore(dbPath);

      await storeA.enqueueTask({
        sessionId: 'concurrent-session',
        issueNumber: 2,
        phase: 'implementation',
        now: '2026-06-06T00:00:00.000Z',
      });

      // Both connections race to transition the same queued task to running.
      const [resultA, resultB] = await Promise.all([
        storeA.transitionTask(
          { sessionId: 'concurrent-session', issueNumber: 2 },
          { status: 'queued' },
          { status: 'running', now: '2026-06-06T00:01:00.000Z' },
        ),
        storeB.transitionTask(
          { sessionId: 'concurrent-session', issueNumber: 2 },
          { status: 'queued' },
          { status: 'running', now: '2026-06-06T00:01:00.000Z' },
        ),
      ]);

      const winners = [resultA, resultB].filter((r) => r.ok);
      const losers = [resultA, resultB].filter((r) => !r.ok);
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);
      expect(losers[0].code).toMatch(/conflict|not_found/);
    } finally {
      storeA?.close();
      storeB?.close();
      rmSync(tmpDir2, { recursive: true, force: true });
    }
  });
});

describe('SqliteTaskStore concurrent claim (two connections, same DB)', () => {
  test('exactly one worker claims the task; the other gets undefined', async () => {
    // Two separate SqliteTaskStore instances sharing the same DB file simulate
    // two concurrent CLI worker processes. The IMMEDIATE transaction ensures
    // only one wins the claim without SQLITE_BUSY_SNAPSHOT errors.
    let tmpDir2;
    let storeA;
    let storeB;

    tmpDir2 = mkdtempSync(join(tmpdir(), 'sqlite-concurrent-test-'));
    const dbPath = join(tmpDir2, 'shared.db');

    try {
      storeA = new SqliteTaskStore(dbPath);
      storeB = new SqliteTaskStore(dbPath);

      await storeA.enqueueTask({
        sessionId: 'concurrent-session',
        issueNumber: 1,
        phase: 'implementation',
        now: '2026-06-06T00:00:00.000Z',
      });

      // Race both claims in the same event-loop tick.
      const [claimA, claimB] = await Promise.all([
        storeA.claimNextTask({
          sessionId: 'concurrent-session',
          workerId: 'worker-a',
          runId: 'run-a',
          now: '2026-06-06T00:01:00.000Z',
          leaseMs: 60000,
        }),
        storeB.claimNextTask({
          sessionId: 'concurrent-session',
          workerId: 'worker-b',
          runId: 'run-b',
          now: '2026-06-06T00:01:00.000Z',
          leaseMs: 60000,
        }),
      ]);

      const winners = [claimA, claimB].filter(Boolean);
      expect(winners).toHaveLength(1);
      expect(winners[0].status).toBe('claimed');
    } finally {
      storeA?.close();
      storeB?.close();
      rmSync(tmpDir2, { recursive: true, force: true });
    }
  });
});

describe('SqliteTaskStore — supportedPhases filtering', () => {
  test('claimNextTask skips tasks whose phase is not in supportedPhases', async () => {
    await store.enqueueTask({ sessionId: 'addon-dev', issueNumber: 201, phase: 'implementation', now: '2026-06-07T00:00:00.000Z' });

    const claimed = await store.claimNextTask({
      sessionId: 'addon-dev', workerId: 'w', runId: 'r1',
      now: '2026-06-07T00:01:00.000Z',
      supportedPhases: ['research'],
    });
    expect(claimed).toBeUndefined();

    const task = await store.getTask({ sessionId: 'addon-dev', issueNumber: 201 });
    expect(task?.status).toBe('queued');
  });

  test('claimNextTask claims task whose phase is in supportedPhases', async () => {
    await store.enqueueTask({ sessionId: 'addon-dev', issueNumber: 202, phase: 'research', now: '2026-06-07T00:00:00.000Z' });

    const claimed = await store.claimNextTask({
      sessionId: 'addon-dev', workerId: 'w', runId: 'r1',
      now: '2026-06-07T00:01:00.000Z',
      supportedPhases: ['research'],
    });
    expect(claimed).toMatchObject({ phase: 'research', status: 'claimed' });
  });

  test('claimNextTask with supportedPhases leaves unsupported task queued', async () => {
    await store.enqueueTask({ sessionId: 'addon-dev', issueNumber: 210, phase: 'implementation', now: '2026-06-07T00:00:00.000Z' });
    await store.enqueueTask({ sessionId: 'addon-dev', issueNumber: 211, phase: 'research', now: '2026-06-07T00:00:01.000Z' });

    const claimed = await store.claimNextTask({
      sessionId: 'addon-dev', workerId: 'w', runId: 'r1',
      now: '2026-06-07T00:01:00.000Z',
      supportedPhases: ['research'],
    });
    expect(claimed).toMatchObject({ issueNumber: 211, phase: 'research' });

    const impl = await store.getTask({ sessionId: 'addon-dev', issueNumber: 210 });
    expect(impl?.status).toBe('queued');
  });

  test('claimNextTask with no supportedPhases remains backward compatible', async () => {
    await store.enqueueTask({ sessionId: 'addon-dev', issueNumber: 220, phase: 'implementation', now: '2026-06-07T00:00:00.000Z' });

    const claimed = await store.claimNextTask({
      sessionId: 'addon-dev', workerId: 'w', runId: 'r1',
      now: '2026-06-07T00:01:00.000Z',
    });
    expect(claimed).toMatchObject({ phase: 'implementation' });
  });
});
