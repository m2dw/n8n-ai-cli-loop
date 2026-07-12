/**
 * runNextPhase per-issue worktree execution context (issue #438).
 *
 * Covers the runner wiring of the injected `resolveWorktreeContext`:
 *   - an enabled resolution records worktreeId/worktreePath in task context,
 *     appends a `phase.worktree.resolved` event, and the handler sees the context;
 *   - a disabled resolution (and an omitted resolver) records nothing, preserving
 *     today's shared-checkout behavior;
 *   - a resolver error fails the task closed with a `phase.worktree.failed` event
 *     and the handler never runs.
 */
import { MemoryTaskStore, runNextPhase } from '../dist/index.js';

const NOW = '2026-06-07T10:00:00.000Z';

let store;

beforeEach(async () => {
  store = new MemoryTaskStore();
  await store.enqueueTask({ sessionId: 's', issueNumber: 7, phase: 'implementation', now: NOW });
});

const request = {
  sessionId: 's',
  workerId: 'w',
  runId: 'run-1',
  supportedPhases: ['implementation'],
  now: NOW,
};

test('enabled resolution records worktree context and the handler sees it', async () => {
  let seenContext;
  const handler = async (task) => {
    seenContext = task.context;
    return { result: 'success', context: { prUrl: 'https://x/pr/1' } };
  };

  const outcome = await runNextPhase({
    store,
    request,
    handlers: { implementation: handler },
    resolveWorktreeContext: () => ({
      ok: true,
      context: {
        enabled: true,
        worktreeId: 's/issue-7',
        worktreePath: '/state/worktrees/s/issue-7/repo',
        branch: 'ai/issue-7',
        created: true,
      },
    }),
  });

  expect(outcome.status).toBe('completed');
  // The handler ran against the recorded worktree context.
  expect(seenContext.worktreeId).toBe('s/issue-7');
  expect(seenContext.worktreePath).toBe('/state/worktrees/s/issue-7/repo');

  // Persisted task context carries the worktree identity alongside handler output.
  const persisted = await store.getTask({ sessionId: 's', issueNumber: 7 });
  expect(persisted.context.worktreeId).toBe('s/issue-7');
  expect(persisted.context.worktreePath).toBe('/state/worktrees/s/issue-7/repo');
  expect(persisted.context.prUrl).toBe('https://x/pr/1');

  // A resolved event is recorded with the id + created flag, but NEVER the path.
  const events = await store.listEvents({ sessionId: 's', issueNumber: 7 });
  const resolved = events.find((e) => e.type === 'phase.worktree.resolved');
  expect(resolved).toBeDefined();
  expect(resolved.data.worktreeId).toBe('s/issue-7');
  expect(resolved.data.created).toBe(true);
  expect(JSON.stringify(resolved)).not.toContain('/state/worktrees');
});

test('disabled resolution records no worktree context', async () => {
  const handler = async () => ({ result: 'success' });
  await runNextPhase({
    store,
    request,
    handlers: { implementation: handler },
    resolveWorktreeContext: () => ({ ok: true, context: { enabled: false } }),
  });

  const persisted = await store.getTask({ sessionId: 's', issueNumber: 7 });
  expect(persisted.context.worktreeId).toBeUndefined();
  expect(persisted.context.worktreePath).toBeUndefined();

  const events = await store.listEvents({ sessionId: 's', issueNumber: 7 });
  expect(events.map((e) => e.type)).not.toContain('phase.worktree.resolved');
});

test('an omitted resolver behaves exactly as before (no worktree context)', async () => {
  const handler = async () => ({ result: 'success' });
  await runNextPhase({ store, request, handlers: { implementation: handler } });

  const persisted = await store.getTask({ sessionId: 's', issueNumber: 7 });
  expect(persisted.context.worktreeId).toBeUndefined();
  const events = await store.listEvents({ sessionId: 's', issueNumber: 7 });
  expect(events.map((e) => e.type)).not.toContain('phase.worktree.resolved');
});

test('a resolver error fails the task closed and the handler never runs', async () => {
  let handlerRan = false;
  const handler = async () => {
    handlerRan = true;
    return { result: 'success' };
  };

  const outcome = await runNextPhase({
    store,
    request,
    handlers: { implementation: handler },
    resolveWorktreeContext: () => ({ ok: false, error: 'Worktree root must live outside the canonical checkout' }),
  });

  expect(handlerRan).toBe(false);
  expect(outcome.status).toBe('completed');
  expect(outcome.result.result).toBe('failed');

  const persisted = await store.getTask({ sessionId: 's', issueNumber: 7 });
  expect(persisted.status).toBe('failed');
  expect(persisted.lastError).toMatch(/outside the canonical checkout/);

  const events = await store.listEvents({ sessionId: 's', issueNumber: 7 });
  const failed = events.find((e) => e.type === 'phase.worktree.failed');
  expect(failed).toBeDefined();
  // The worktree failure flows through the normal failure-completion path, so a
  // phase.completed (failed) event is also recorded for escalation/outbox.
  expect(events.map((e) => e.type)).toContain('phase.completed');
});
