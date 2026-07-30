/**
 * runNextPhase pre-lock phase-admission preflight (issue #681 review follow-up).
 *
 * The review-admission check (`checkReviewAdmission`) is only side-effect free if
 * it runs BEFORE the issue lock is acquired and the worktree is resolved/created,
 * not from inside the review handler itself — by the time the handler runs,
 * `runNextPhase` has already taken the issue lock and (in worktree mode) persisted
 * `worktreeId`/`worktreePath` into task context and emitted a
 * `phase.worktree.resolved` event.
 *
 * Covers the runner wiring of the injected `admitPhase`:
 *   - a rejected admission fails/blocks the task WITHOUT ever calling
 *     `acquirePhaseLock` or `resolveWorktreeContext`, and the handler never runs;
 *   - an admitted task reaches `acquirePhaseLock`, `resolveWorktreeContext`, and
 *     the handler exactly as if no `admitPhase` had been supplied;
 *   - an omitted `admitPhase` behaves exactly as before (no admission gate).
 */
import { MemoryTaskStore, runNextPhase } from '../dist/index.js';

const NOW = '2026-07-18T10:00:00.000Z';

let store;

beforeEach(async () => {
  store = new MemoryTaskStore();
  await store.enqueueTask({ sessionId: 's', issueNumber: 7, phase: 'review', now: NOW });
});

const request = {
  sessionId: 's',
  workerId: 'w',
  runId: 'run-1',
  supportedPhases: ['review'],
  now: NOW,
};

test('a rejected (failed) admission never acquires the lock or resolves the worktree', async () => {
  let lockCalled = false;
  let worktreeCalled = false;
  let handlerRan = false;
  const handler = async () => {
    handlerRan = true;
    return { result: 'success' };
  };

  const outcome = await runNextPhase({
    store,
    request,
    handlers: { review: handler },
    admitPhase: () => ({ ok: false, result: 'failed', error: 'No PR URL or branch in task context' }),
    acquirePhaseLock: () => {
      lockCalled = true;
      return { ok: true, acquired: true, handle: { release() {} } };
    },
    resolveWorktreeContext: () => {
      worktreeCalled = true;
      return { ok: true, context: { enabled: true, worktreeId: 's/issue-7', worktreePath: '/state/worktrees/s/issue-7/repo' } };
    },
  });

  expect(lockCalled).toBe(false);
  expect(worktreeCalled).toBe(false);
  expect(handlerRan).toBe(false);

  expect(outcome.status).toBe('completed');
  expect(outcome.result.result).toBe('failed');
  expect(outcome.result.error).toMatch(/No PR URL or branch/);

  const persisted = await store.getTask({ sessionId: 's', issueNumber: 7 });
  expect(persisted.status).toBe('failed');
  expect(persisted.context.worktreeId).toBeUndefined();
  expect(persisted.context.worktreePath).toBeUndefined();

  const events = await store.listEvents({ sessionId: 's', issueNumber: 7 });
  expect(events.map((e) => e.type)).not.toContain('phase.lock.failed');
  expect(events.map((e) => e.type)).not.toContain('phase.worktree.resolved');
  expect(events.map((e) => e.type)).not.toContain('phase.worktree.failed');
  // Still flows through the normal completion path for escalation/outbox.
  expect(events.map((e) => e.type)).toContain('phase.completed');
});

test('a rejected (blocked) admission holds the task at ready_for_human without touching the lock/worktree', async () => {
  let lockCalled = false;
  let worktreeCalled = false;

  const outcome = await runNextPhase({
    store,
    request,
    handlers: { review: async () => ({ result: 'success' }) },
    admitPhase: () => ({ ok: false, result: 'blocked', message: 'no durable start point to reproduce the review diff base from' }),
    acquirePhaseLock: () => {
      lockCalled = true;
      return { ok: true, acquired: true, handle: { release() {} } };
    },
    resolveWorktreeContext: () => {
      worktreeCalled = true;
      return { ok: true, context: { enabled: false } };
    },
  });

  expect(lockCalled).toBe(false);
  expect(worktreeCalled).toBe(false);
  expect(outcome.status).toBe('completed');
  expect(outcome.result.result).toBe('blocked');

  const persisted = await store.getTask({ sessionId: 's', issueNumber: 7 });
  expect(persisted.status).toBe('ready_for_human');
});

test('an admitted task reaches the lock, the worktree resolver, and the handler unchanged', async () => {
  const calls = [];
  let handlerContext;

  const outcome = await runNextPhase({
    store,
    request,
    handlers: {
      review: async (task) => {
        calls.push('handler');
        handlerContext = task.context;
        return { result: 'success', context: { prUrl: 'https://x/pr/1' } };
      },
    },
    admitPhase: (task) => {
      expect(task.phase).toBe('review');
      return { ok: true };
    },
    acquirePhaseLock: () => {
      calls.push('lock');
      return { ok: true, acquired: true, handle: { release() {} } };
    },
    resolveWorktreeContext: () => {
      calls.push('worktree');
      return {
        ok: true,
        context: { enabled: true, worktreeId: 's/issue-7', worktreePath: '/state/worktrees/s/issue-7/repo' },
      };
    },
  });

  expect(calls).toEqual(['lock', 'worktree', 'handler']);
  expect(outcome.status).toBe('completed');
  expect(outcome.result.result).toBe('success');
  expect(handlerContext.worktreeId).toBe('s/issue-7');

  const persisted = await store.getTask({ sessionId: 's', issueNumber: 7 });
  expect(persisted.status).toBe('ready_for_human');
  expect(persisted.context.prUrl).toBe('https://x/pr/1');
});

test('an omitted admitPhase behaves exactly as before (no admission gate)', async () => {
  const outcome = await runNextPhase({
    store,
    request,
    handlers: { review: async () => ({ result: 'success' }) },
  });

  expect(outcome.status).toBe('completed');
  expect(outcome.result.result).toBe('success');
});
