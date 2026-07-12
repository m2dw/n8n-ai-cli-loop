/**
 * runNextPhase per-issue execution lock (issue #440).
 *
 * Covers the runner wiring of the injected `acquirePhaseLock`, exercised against
 * the REAL `IssueWorktreeLock` so the integration is faithful:
 *   - an acquired lock lets the handler run and is released afterwards (so the
 *     SAME issue can run again on a later phase);
 *   - the SAME issue is serialized: when its lock is already held the phase does
 *     not run, the claim is released back to `queued`, and `lock_contended` is
 *     reported with a `phase.lock.contended` event;
 *   - DIFFERENT issues are independent: a held lock for one issue never blocks a
 *     phase for another issue;
 *   - a lock-subsystem error fails the task closed with a `phase.lock.failed`
 *     event and the handler never runs;
 *   - the lock is released even when the handler fails;
 *   - an omitted acquirer behaves exactly as before (no lock taken).
 */
import { MemoryTaskStore, runNextPhase, IssueWorktreeLock } from '../dist/index.js';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const NOW = '2026-06-29T10:00:00.000Z';

let store;
let lockDir;
let lock;

beforeEach(async () => {
  store = new MemoryTaskStore();
  lockDir = mkdtempSync(join(tmpdir(), 'phase-lock-'));
  lock = new IssueWorktreeLock(lockDir);
  await store.enqueueTask({ sessionId: 's', issueNumber: 7, phase: 'implementation', now: NOW });
});

afterEach(() => {
  rmSync(lockDir, { recursive: true, force: true });
});

const request = {
  sessionId: 's',
  workerId: 'w',
  runId: 'run-1',
  supportedPhases: ['implementation'],
  now: NOW,
};

// Mirrors run-one-phase's acquireIssuePhaseLock wiring, against the real lock.
function acquirer(ownerId) {
  return (task) => {
    const res = lock.acquire(ownerId, task.sessionId, task.issueNumber);
    if (res.locked) {
      return {
        ok: true,
        acquired: true,
        handle: {
          release() {
            lock.release(ownerId, task.sessionId, task.issueNumber);
          },
        },
      };
    }
    return {
      ok: true,
      acquired: false,
      reason: `issue ${task.issueNumber} is already running`,
      ownerContextId: res.ownerContextId,
    };
  };
}

test('acquires the issue lock, runs the handler, and releases it afterwards', async () => {
  let handlerRan = false;
  const handler = async (task) => {
    handlerRan = true;
    // The lock is held for THIS issue while the handler runs: a competing owner
    // cannot acquire it mid-flight.
    expect(lock.acquire('other', task.sessionId, task.issueNumber).locked).toBe(false);
    return { result: 'success' };
  };

  const outcome = await runNextPhase({
    store,
    request,
    handlers: { implementation: handler },
    acquirePhaseLock: acquirer('run-1'),
  });

  expect(handlerRan).toBe(true);
  expect(outcome.status).toBe('completed');
  // Released after the phase: a later run can re-acquire the same issue lock.
  expect(lock.acquire('run-2', 's', 7).locked).toBe(true);
});

test('the SAME issue is serialized: a held lock blocks the phase and requeues it', async () => {
  // A concurrent run already owns issue 7's lock.
  expect(lock.acquire('holder', 's', 7).locked).toBe(true);

  let handlerRan = false;
  const handler = async () => {
    handlerRan = true;
    return { result: 'success' };
  };

  const outcome = await runNextPhase({
    store,
    request,
    handlers: { implementation: handler },
    acquirePhaseLock: acquirer('run-1'),
  });

  expect(handlerRan).toBe(false);
  expect(outcome.status).toBe('lock_contended');
  expect(outcome.ownerContextId).toBe('holder');

  // The claim was released back to `queued` so the schedule retries it later, with
  // a future `notBefore` backoff so the scheduler reaches other issues meanwhile
  // instead of re-selecting this still-locked issue every tick.
  const persisted = await store.getTask({ sessionId: 's', issueNumber: 7 });
  expect(persisted.status).toBe('queued');
  expect(persisted.ownerRunId).toBeUndefined();
  expect(persisted.notBefore).toBeDefined();
  expect(new Date(persisted.notBefore).getTime()).toBeGreaterThan(new Date(NOW).getTime());

  const events = await store.listEvents({ sessionId: 's', issueNumber: 7 });
  const contended = events.find((e) => e.type === 'phase.lock.contended');
  expect(contended).toBeDefined();
  expect(contended.data.ownerContextId).toBe('holder');
  expect(contended.data.notBefore).toBe(persisted.notBefore);
  // No phase.completed for a contended run — the handler never ran.
  expect(events.map((e) => e.type)).not.toContain('phase.completed');
});

test('DIFFERENT issues are independent: a held lock for one never blocks another', async () => {
  // Fresh store with ONLY issue 8 queued, so the claim is deterministic.
  const store8 = new MemoryTaskStore();
  await store8.enqueueTask({ sessionId: 's', issueNumber: 8, phase: 'implementation', now: NOW });

  // A live run holds issue 7's lock — a different scope that must not block 8.
  expect(lock.acquire('holder', 's', 7).locked).toBe(true);

  let ranIssue;
  const handler = async (task) => {
    ranIssue = task.issueNumber;
    return { result: 'success' };
  };

  const outcome = await runNextPhase({
    store: store8,
    request: { ...request, runId: 'run-8' },
    handlers: { implementation: handler },
    acquirePhaseLock: acquirer('run-8'),
  });

  expect(outcome.status).toBe('completed');
  expect(ranIssue).toBe(8);
  // Issue 7's lock is still held by its owner — issue 8 running never touched it.
  expect(lock.inspect('s', 7).locked).toBe(true);
});

test('a lock-subsystem error fails the task closed and the handler never runs', async () => {
  let handlerRan = false;
  const handler = async () => {
    handlerRan = true;
    return { result: 'success' };
  };

  const outcome = await runNextPhase({
    store,
    request,
    handlers: { implementation: handler },
    acquirePhaseLock: () => ({ ok: false, error: 'lock store unavailable' }),
  });

  expect(handlerRan).toBe(false);
  expect(outcome.status).toBe('completed');
  expect(outcome.result.result).toBe('failed');

  const persisted = await store.getTask({ sessionId: 's', issueNumber: 7 });
  expect(persisted.status).toBe('failed');
  expect(persisted.lastError).toMatch(/lock store unavailable/);

  const events = await store.listEvents({ sessionId: 's', issueNumber: 7 });
  expect(events.find((e) => e.type === 'phase.lock.failed')).toBeDefined();
  expect(events.map((e) => e.type)).toContain('phase.completed');
});

test('the lock is released even when the handler fails', async () => {
  const handler = async () => ({ result: 'failed', error: 'boom' });

  const outcome = await runNextPhase({
    store,
    request,
    handlers: { implementation: handler },
    acquirePhaseLock: acquirer('run-1'),
  });

  expect(outcome.status).toBe('completed');
  expect(outcome.result.result).toBe('failed');
  // The finally released the lock despite the handler failure.
  expect(lock.acquire('run-2', 's', 7).locked).toBe(true);
});

test('an omitted acquirer behaves exactly as before (no lock taken)', async () => {
  let handlerRan = false;
  const handler = async () => {
    handlerRan = true;
    return { result: 'success' };
  };

  const outcome = await runNextPhase({
    store,
    request,
    handlers: { implementation: handler },
  });

  expect(handlerRan).toBe(true);
  expect(outcome.status).toBe('completed');
  // Nothing was ever acquired, so the issue lock is free.
  expect(lock.inspect('s', 7).locked).toBe(false);
});
