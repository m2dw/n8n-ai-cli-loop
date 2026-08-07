import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import { SqliteTaskStore, nextPhaseAfter, runNextPhase } from '../dist/index.js';
import { SqliteOutboxStore } from '../dist/stores/sqlite-outbox-store.js';

let tmpDir;
let dbPath;
let store;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'sqlite-task-store-test-'));
  dbPath = join(tmpDir, 'test.db');
  store = new SqliteTaskStore(dbPath);
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

  test('transitionTask supports updatedAt as a compare-and-swap precondition (issue #622 review, P2)', async () => {
    await store.enqueueTask({
      sessionId: 'addon-dev',
      issueNumber: 135,
      phase: 'review',
      now: '2026-06-06T00:00:00.000Z',
    });
    const seeded = await store.transitionTask(
      { sessionId: 'addon-dev', issueNumber: 135 },
      { status: 'queued' },
      { status: 'ready_for_human', context: { missingVerificationCommands: ['a', 'b'] }, now: '2026-06-06T00:01:00.000Z' },
    );
    expect(seeded.ok).toBe(true);
    const staleUpdatedAt = seeded.value.updatedAt;

    // A write built from this snapshot commits and bumps updatedAt again.
    const first = await store.transitionTask(
      { sessionId: 'addon-dev', issueNumber: 135 },
      { status: 'ready_for_human', updatedAt: staleUpdatedAt },
      { status: 'ready_for_human', context: { missingVerificationCommands: ['b'] }, now: '2026-06-06T00:02:00.000Z' },
    );
    expect(first).toMatchObject({ ok: true, value: { context: { missingVerificationCommands: ['b'] } } });

    // A second write still built from the original (now-stale) snapshot must
    // fail closed instead of silently clobbering the first write's context.
    const second = await store.transitionTask(
      { sessionId: 'addon-dev', issueNumber: 135 },
      { status: 'ready_for_human', updatedAt: staleUpdatedAt },
      { status: 'ready_for_human', context: { missingVerificationCommands: ['a'] }, now: '2026-06-06T00:02:00.000Z' },
    );
    expect(second).toMatchObject({ ok: false, code: 'conflict' });

    const final = await store.getTask({ sessionId: 'addon-dev', issueNumber: 135 });
    expect(final.context.missingVerificationCommands).toEqual(['b']);
  });

  test('transitionTask CAS uses a monotonic revision, so same-millisecond writers cannot clobber each other (issue #622 review, P2)', async () => {
    await store.enqueueTask({
      sessionId: 'addon-dev',
      issueNumber: 136,
      phase: 'review',
      now: '2026-06-06T00:00:00.000Z',
    });
    const seeded = await store.transitionTask(
      { sessionId: 'addon-dev', issueNumber: 136 },
      { status: 'queued' },
      { status: 'ready_for_human', context: { missingVerificationCommands: ['a', 'b'] }, now: '2026-06-06T00:01:00.000Z' },
    );
    expect(seeded.ok).toBe(true);
    const staleUpdatedAt = seeded.value.updatedAt;
    const staleRevision = seeded.value.revision;

    // Two operators both read the task at `staleUpdatedAt`/`staleRevision`,
    // then both happen to write with `now` equal to that same millisecond —
    // simulating two processes whose `new Date()` calls collide. A CAS keyed
    // only on `updatedAt` would see the row's timestamp unchanged after the
    // first write and let the second write through too.
    const first = await store.transitionTask(
      { sessionId: 'addon-dev', issueNumber: 136 },
      { status: 'ready_for_human', updatedAt: staleUpdatedAt, revision: staleRevision },
      { status: 'ready_for_human', context: { missingVerificationCommands: ['b'] }, now: staleUpdatedAt },
    );
    expect(first).toMatchObject({ ok: true, value: { context: { missingVerificationCommands: ['b'] } } });
    // The colliding timestamp confirms the scenario: updatedAt did not
    // change, only revision did.
    expect(first.value.updatedAt).toBe(staleUpdatedAt);
    expect(first.value.revision).toBe(staleRevision + 1);

    const second = await store.transitionTask(
      { sessionId: 'addon-dev', issueNumber: 136 },
      { status: 'ready_for_human', updatedAt: staleUpdatedAt, revision: staleRevision },
      { status: 'ready_for_human', context: { missingVerificationCommands: ['a'] }, now: staleUpdatedAt },
    );
    expect(second).toMatchObject({ ok: false, code: 'conflict' });

    const final = await store.getTask({ sessionId: 'addon-dev', issueNumber: 136 });
    expect(final.context.missingVerificationCommands).toEqual(['b']);
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

  // issue #677: `recoverHandoff` is the store method behind `admin recover
  // --from ready_for_human --phase <phase>` — the only path that can move an
  // existing `ready_for_human` task directly into another phase (e.g. review)
  // without going through the normal phase-completion transition. An unresolved
  // implementation Tool Request must be authoritative over that request: it must
  // be resolved through the dedicated tool-request flows, not silently overridden
  // by a generic recover (a mistaken admin action, a stale/conflicting GitHub
  // review label routed through an admin script, etc).
  describe('recoverHandoff — unresolved Tool Request guard (issue #677)', () => {
    async function seedToolRequestTask(issueNumber, extraContext = {}) {
      await store.enqueueTask({
        sessionId: 'addon-dev',
        issueNumber,
        phase: 'implementation',
        implementationAgent: 'claude',
        now: '2026-06-06T00:00:00.000Z',
      });
      await store.transitionTask(
        { sessionId: 'addon-dev', issueNumber },
        { status: 'queued' },
        {
          status: 'ready_for_human',
          phase: 'implementation',
          now: '2026-06-06T00:01:00.000Z',
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
              requestedAt: '2026-06-06T00:01:00.000Z',
              resolved: false,
            },
            ...extraContext,
          },
        },
      );
    }

    test('refuses to move a ready_for_human/implementation task with an unresolved Tool Request into review', async () => {
      await seedToolRequestTask(300);

      const result = await store.recoverHandoff(
        { sessionId: 'addon-dev', issueNumber: 300 },
        { fromStatus: 'ready_for_human', phase: 'review', now: '2026-06-06T00:02:00.000Z' },
      );

      expect(result.ok).toBe(false);
      expect(result.code).toBe('tool_request_unresolved');

      // The task itself — status, phase, and the unresolved Tool Request — is
      // completely untouched: no branch/worktree cleanup, no partial-implementation
      // artifact disturbed, and the Tool Request is exactly as an operator would
      // still need to resolve it.
      const task = await store.getTask({ sessionId: 'addon-dev', issueNumber: 300 });
      expect(task).toMatchObject({ status: 'ready_for_human', phase: 'implementation' });
      expect(task.context.toolRequest).toMatchObject({ resolved: false, command: 'npm install left-pad' });
    });

    test('also refuses a plain requeue back onto the same (implementation) phase', async () => {
      await seedToolRequestTask(301);

      const result = await store.recoverHandoff(
        { sessionId: 'addon-dev', issueNumber: 301 },
        { fromStatus: 'ready_for_human', phase: 'implementation', now: '2026-06-06T00:02:00.000Z' },
      );

      expect(result.ok).toBe(false);
      expect(result.code).toBe('tool_request_unresolved');
    });

    test('a dependency-started task (continuation base is another issue branch) is refused the same way', async () => {
      // context.dependencyBase records the predecessor issue/PR a stacked branch
      // was created from (issue #667). An unresolved Tool Request must block entry
      // into review regardless of whether this task is a plain or dependency-started
      // continuation.
      await seedToolRequestTask(302, {
        dependencyBase: {
          baseIssueNumber: 50,
          basePrNumber: 88,
          baseHeadRefName: 'ai/issue-50',
          basePrUrl: 'https://github.com/m2dw/test-repo/pull/88',
          baseHeadSha: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
        },
      });

      const result = await store.recoverHandoff(
        { sessionId: 'addon-dev', issueNumber: 302 },
        { fromStatus: 'ready_for_human', phase: 'review', now: '2026-06-06T00:02:00.000Z' },
      );

      expect(result.ok).toBe(false);
      expect(result.code).toBe('tool_request_unresolved');

      const task = await store.getTask({ sessionId: 'addon-dev', issueNumber: 302 });
      expect(task).toMatchObject({ status: 'ready_for_human', phase: 'implementation' });
      expect(task.context.dependencyBase).toMatchObject({ baseIssueNumber: 50 });
      expect(task.context.toolRequest.resolved).toBe(false);
    });

    test('a resolved Tool Request does not block recoverHandoff', async () => {
      await store.enqueueTask({
        sessionId: 'addon-dev',
        issueNumber: 303,
        phase: 'review',
        now: '2026-06-06T00:00:00.000Z',
      });
      await store.transitionTask(
        { sessionId: 'addon-dev', issueNumber: 303 },
        { status: 'queued' },
        {
          status: 'ready_for_human',
          phase: 'review',
          now: '2026-06-06T00:01:00.000Z',
          context: {
            toolRequest: {
              command: 'npm install left-pad',
              displayCommand: 'npm install left-pad',
              reason: 'needed for the fix',
              expectedFiles: ['package.json'],
              necessity: 'required',
              requestedBy: 'claude',
              mode: 'new',
              requestedAt: '2026-06-06T00:00:00.000Z',
              resolved: true,
              resolution: { action: 'manual-done', resolvedAt: '2026-06-06T00:00:30.000Z' },
            },
          },
        },
      );

      const result = await store.recoverHandoff(
        { sessionId: 'addon-dev', issueNumber: 303 },
        { fromStatus: 'ready_for_human', phase: 'conflict_resolution', now: '2026-06-06T00:02:00.000Z' },
      );

      expect(result.ok).toBe(true);
      expect(result.value).toMatchObject({ status: 'queued', phase: 'conflict_resolution' });
    });

    test('a task with no Tool Request at all is unaffected', async () => {
      await store.enqueueTask({
        sessionId: 'addon-dev',
        issueNumber: 304,
        phase: 'review',
        now: '2026-06-06T00:00:00.000Z',
      });
      await store.transitionTask(
        { sessionId: 'addon-dev', issueNumber: 304 },
        { status: 'queued' },
        { status: 'ready_for_human', phase: 'review', now: '2026-06-06T00:01:00.000Z' },
      );

      const result = await store.recoverHandoff(
        { sessionId: 'addon-dev', issueNumber: 304 },
        { fromStatus: 'ready_for_human', phase: 'conflict_resolution', now: '2026-06-06T00:02:00.000Z' },
      );

      expect(result.ok).toBe(true);
    });
  });

  // Port conformance (issue #613/P1): recoverTask/recoverCapHandoff/clearTaskDelay/
  // listSessionTasks were promoted from concrete-only methods onto the `TaskStore`
  // interface. These tests pin the allowed-transition/refusal table and the
  // revision-advance requirement for each.
  describe('recoverTask', () => {
    test('recovers a failed task back to queued and advances revision', async () => {
      await store.enqueueTask({ sessionId: 'addon-dev', issueNumber: 400, phase: 'implementation', now: '2026-06-06T00:00:00.000Z' });
      await store.transitionTask(
        { sessionId: 'addon-dev', issueNumber: 400 },
        { status: 'queued' },
        { status: 'failed', now: '2026-06-06T00:01:00.000Z' },
      );
      const before = await store.getTask({ sessionId: 'addon-dev', issueNumber: 400 });

      const result = await store.recoverTask(
        { sessionId: 'addon-dev', issueNumber: 400 },
        { now: '2026-06-06T00:02:00.000Z' },
      );

      expect(result.ok).toBe(true);
      expect(result.value.status).toBe('queued');
      expect(result.value.revision).toBeGreaterThan(before.revision);
    });

    test('refuses a queued task (conflict)', async () => {
      await store.enqueueTask({ sessionId: 'addon-dev', issueNumber: 401, phase: 'implementation', now: '2026-06-06T00:00:00.000Z' });

      const result = await store.recoverTask({ sessionId: 'addon-dev', issueNumber: 401 });

      expect(result.ok).toBe(false);
      expect(result.code).toBe('conflict');
    });

    test('refuses an unexpired claimed/running lease', async () => {
      await store.enqueueTask({ sessionId: 'addon-dev', issueNumber: 402, phase: 'implementation', now: '2026-06-06T00:00:00.000Z' });
      await store.claimNextTask({ sessionId: 'addon-dev', workerId: 'w', runId: 'r', now: '2026-06-06T00:01:00.000Z', leaseMs: 600000 });

      const result = await store.recoverTask({ sessionId: 'addon-dev', issueNumber: 402, }, { now: '2026-06-06T00:02:00.000Z' });

      expect(result.ok).toBe(false);
      expect(result.code).toBe('conflict');
    });

    test('returns not_found for a missing task', async () => {
      const result = await store.recoverTask({ sessionId: 'addon-dev', issueNumber: 40199 });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('not_found');
    });
  });

  describe('recoverCapHandoff', () => {
    async function seedCapHandoffTask(issueNumber) {
      await store.enqueueTask({ sessionId: 'addon-dev', issueNumber, phase: 'review', now: '2026-06-06T00:00:00.000Z' });
      await store.transitionTask(
        { sessionId: 'addon-dev', issueNumber },
        { status: 'queued' },
        {
          status: 'ready_for_human',
          phase: 'review',
          now: '2026-06-06T00:01:00.000Z',
          context: { reviewLoopCapReached: true, escalatedEffort: true, reviewCycles: 3 },
        },
      );
    }

    test('recovers a cap-handoff task to queued/review, clears cap context, and advances revision', async () => {
      await seedCapHandoffTask(410);
      const before = await store.getTask({ sessionId: 'addon-dev', issueNumber: 410 });

      const result = await store.recoverCapHandoff(
        { sessionId: 'addon-dev', issueNumber: 410 },
        { now: '2026-06-06T00:02:00.000Z' },
      );

      expect(result.ok).toBe(true);
      expect(result.value).toMatchObject({ status: 'queued', phase: 'review' });
      expect(result.value.context.reviewLoopCapReached).toBeUndefined();
      expect(result.value.context.reviewCycles).toBe(0);
      expect(result.value.revision).toBeGreaterThan(before.revision);
    });

    test('refuses a ready_for_human task without the cap flag', async () => {
      await store.enqueueTask({ sessionId: 'addon-dev', issueNumber: 411, phase: 'review', now: '2026-06-06T00:00:00.000Z' });
      await store.transitionTask(
        { sessionId: 'addon-dev', issueNumber: 411 },
        { status: 'queued' },
        { status: 'ready_for_human', phase: 'review', now: '2026-06-06T00:01:00.000Z' },
      );

      const result = await store.recoverCapHandoff({ sessionId: 'addon-dev', issueNumber: 411 });

      expect(result.ok).toBe(false);
      expect(result.code).toBe('conflict');
    });

    test('refuses a non-ready_for_human status', async () => {
      await store.enqueueTask({ sessionId: 'addon-dev', issueNumber: 412, phase: 'implementation', now: '2026-06-06T00:00:00.000Z' });

      const result = await store.recoverCapHandoff({ sessionId: 'addon-dev', issueNumber: 412 });

      expect(result.ok).toBe(false);
      expect(result.code).toBe('conflict');
    });
  });

  describe('clearTaskDelay', () => {
    test('clears notBefore on a queued task and advances revision', async () => {
      await store.enqueueTask({ sessionId: 'addon-dev', issueNumber: 420, phase: 'implementation', now: '2026-06-06T00:00:00.000Z' });
      await store.transitionTask(
        { sessionId: 'addon-dev', issueNumber: 420 },
        { status: 'queued' },
        { status: 'queued', notBefore: '2026-06-07T00:00:00.000Z', now: '2026-06-06T00:01:00.000Z' },
      );
      const before = await store.getTask({ sessionId: 'addon-dev', issueNumber: 420 });

      const result = await store.clearTaskDelay(
        { sessionId: 'addon-dev', issueNumber: 420 },
        { now: '2026-06-06T00:02:00.000Z' },
      );

      expect(result.ok).toBe(true);
      expect(result.value.notBefore).toBeUndefined();
      expect(result.value.revision).toBeGreaterThan(before.revision);
    });

    test('refuses a non-queued task', async () => {
      await store.enqueueTask({ sessionId: 'addon-dev', issueNumber: 421, phase: 'implementation', now: '2026-06-06T00:00:00.000Z' });
      await store.claimNextTask({ sessionId: 'addon-dev', workerId: 'w', runId: 'r', now: '2026-06-06T00:01:00.000Z' });

      const result = await store.clearTaskDelay({ sessionId: 'addon-dev', issueNumber: 421 });

      expect(result.ok).toBe(false);
      expect(result.code).toBe('conflict');
    });

    test('returns not_found for a missing task', async () => {
      const result = await store.clearTaskDelay({ sessionId: 'addon-dev', issueNumber: 42199 });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('not_found');
    });
  });

  // Issue #608: first-class task cancellation. `cancelTask` is a terminal,
  // race-safe transition reachable from any non-terminal status.
  describe('cancelTask', () => {
    test('cancels a queued task, clears owner/lease/delay, and advances revision', async () => {
      await store.enqueueTask({ sessionId: 'addon-dev', issueNumber: 600, phase: 'implementation', now: '2026-06-06T00:00:00.000Z' });
      const before = await store.getTask({ sessionId: 'addon-dev', issueNumber: 600 });

      const result = await store.cancelTask(
        { sessionId: 'addon-dev', issueNumber: 600 },
        { reason: 'operator abandoned', now: '2026-06-06T00:01:00.000Z' },
      );

      expect(result.ok).toBe(true);
      expect(result.value.status).toBe('cancelled');
      expect(result.value.ownerRunId).toBeUndefined();
      expect(result.value.leaseExpiresAt).toBeUndefined();
      expect(result.value.notBefore).toBeUndefined();
      expect(result.value.context.cancelledAt).toBe('2026-06-06T00:01:00.000Z');
      expect(result.value.context.cancelReason).toBe('operator abandoned');
      expect(result.value.revision).toBeGreaterThan(before.revision);
    });

    test('cancels a claimed task and clears its lease/owner', async () => {
      await store.enqueueTask({ sessionId: 'addon-dev', issueNumber: 601, phase: 'implementation', now: '2026-06-06T00:00:00.000Z' });
      await store.claimNextTask({ sessionId: 'addon-dev', workerId: 'w', runId: 'r', now: '2026-06-06T00:01:00.000Z', leaseMs: 600000 });

      const result = await store.cancelTask({ sessionId: 'addon-dev', issueNumber: 601 }, { now: '2026-06-06T00:02:00.000Z' });

      expect(result.ok).toBe(true);
      expect(result.value.status).toBe('cancelled');
      expect(result.value.ownerRunId).toBeUndefined();
      expect(result.value.leaseExpiresAt).toBeUndefined();
    });

    test('cancels a running task', async () => {
      await store.enqueueTask({ sessionId: 'addon-dev', issueNumber: 602, phase: 'implementation', now: '2026-06-06T00:00:00.000Z' });
      await store.claimNextTask({ sessionId: 'addon-dev', workerId: 'w', runId: 'r', now: '2026-06-06T00:01:00.000Z', leaseMs: 600000 });
      await store.transitionTask(
        { sessionId: 'addon-dev', issueNumber: 602 },
        { status: 'claimed' },
        { status: 'running', now: '2026-06-06T00:01:30.000Z' },
      );

      const result = await store.cancelTask({ sessionId: 'addon-dev', issueNumber: 602 }, { now: '2026-06-06T00:02:00.000Z' });

      expect(result.ok).toBe(true);
      expect(result.value.status).toBe('cancelled');
    });

    test('cancels a blocked task', async () => {
      await store.enqueueTask({ sessionId: 'addon-dev', issueNumber: 603, phase: 'implementation', now: '2026-06-06T00:00:00.000Z' });
      await store.transitionTask(
        { sessionId: 'addon-dev', issueNumber: 603 },
        { status: 'queued' },
        { status: 'blocked', phase: 'implementation', now: '2026-06-06T00:01:00.000Z' },
      );

      const result = await store.cancelTask({ sessionId: 'addon-dev', issueNumber: 603 }, { now: '2026-06-06T00:02:00.000Z' });

      expect(result.ok).toBe(true);
      expect(result.value.status).toBe('cancelled');
    });

    test('cancels a ready_for_human task', async () => {
      await store.enqueueTask({ sessionId: 'addon-dev', issueNumber: 604, phase: 'review', now: '2026-06-06T00:00:00.000Z' });
      await store.transitionTask(
        { sessionId: 'addon-dev', issueNumber: 604 },
        { status: 'queued' },
        { status: 'ready_for_human', phase: 'review', now: '2026-06-06T00:01:00.000Z' },
      );

      const result = await store.cancelTask({ sessionId: 'addon-dev', issueNumber: 604 }, { now: '2026-06-06T00:02:00.000Z' });

      expect(result.ok).toBe(true);
      expect(result.value.status).toBe('cancelled');
    });

    test('refuses a done task (conflict) — finished work is not retroactively cancellable', async () => {
      await store.enqueueTask({ sessionId: 'addon-dev', issueNumber: 605, phase: 'review', now: '2026-06-06T00:00:00.000Z' });
      await store.transitionTask(
        { sessionId: 'addon-dev', issueNumber: 605 },
        { status: 'queued' },
        { status: 'done', now: '2026-06-06T00:01:00.000Z' },
      );

      const result = await store.cancelTask({ sessionId: 'addon-dev', issueNumber: 605 });

      expect(result.ok).toBe(false);
      expect(result.code).toBe('conflict');
    });

    test('refuses a failed task (conflict)', async () => {
      await store.enqueueTask({ sessionId: 'addon-dev', issueNumber: 606, phase: 'implementation', now: '2026-06-06T00:00:00.000Z' });
      await store.transitionTask(
        { sessionId: 'addon-dev', issueNumber: 606 },
        { status: 'queued' },
        { status: 'failed', now: '2026-06-06T00:01:00.000Z' },
      );

      const result = await store.cancelTask({ sessionId: 'addon-dev', issueNumber: 606 });

      expect(result.ok).toBe(false);
      expect(result.code).toBe('conflict');
    });

    test('repeated cancellation returns already_cancelled, not a generic conflict', async () => {
      await store.enqueueTask({ sessionId: 'addon-dev', issueNumber: 607, phase: 'implementation', now: '2026-06-06T00:00:00.000Z' });
      const first = await store.cancelTask({ sessionId: 'addon-dev', issueNumber: 607 }, { now: '2026-06-06T00:01:00.000Z' });
      expect(first.ok).toBe(true);

      const second = await store.cancelTask({ sessionId: 'addon-dev', issueNumber: 607 }, { now: '2026-06-06T00:02:00.000Z' });

      expect(second.ok).toBe(false);
      expect(second.code).toBe('already_cancelled');
      expect(second.current.status).toBe('cancelled');
    });

    test('returns not_found for a missing task', async () => {
      const result = await store.cancelTask({ sessionId: 'addon-dev', issueNumber: 60899 });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('not_found');
    });

    test('a cancelled task is never claimed by claimNextTask', async () => {
      await store.enqueueTask({ sessionId: 'addon-dev', issueNumber: 608, phase: 'implementation', now: '2026-06-06T00:00:00.000Z' });
      await store.cancelTask({ sessionId: 'addon-dev', issueNumber: 608 }, { now: '2026-06-06T00:01:00.000Z' });

      const claimed = await store.claimNextTask({
        sessionId: 'addon-dev',
        workerId: 'w',
        runId: 'r',
        now: '2026-06-06T00:02:00.000Z',
      });

      expect(claimed).toBeUndefined();
    });

    // Issue #608 acceptance criterion: an already-running task is not
    // force-stopped, but the run's own completion transition safely no-ops
    // once cancellation has landed — this is how "stop at a safe phase
    // boundary" is achieved without any live signal into the handler process.
    test('a running task cancelled mid-flight loses the CAS on its own completion transition', async () => {
      await store.enqueueTask({ sessionId: 'addon-dev', issueNumber: 609, phase: 'implementation', now: '2026-06-06T00:00:00.000Z' });
      await store.claimNextTask({ sessionId: 'addon-dev', workerId: 'w', runId: 'run-1', now: '2026-06-06T00:01:00.000Z', leaseMs: 600000 });
      await store.transitionTask(
        { sessionId: 'addon-dev', issueNumber: 609 },
        { status: 'claimed' },
        { status: 'running', now: '2026-06-06T00:01:30.000Z' },
      );

      // Operator cancels while the phase handler is (conceptually) still executing.
      const cancelled = await store.cancelTask({ sessionId: 'addon-dev', issueNumber: 609 }, { now: '2026-06-06T00:02:00.000Z' });
      expect(cancelled.ok).toBe(true);

      // The run's own completion attempt — unaware of the cancellation — uses
      // the SAME CAS shape `runNextPhase` uses at completion time.
      const completion = await store.transitionTask(
        { sessionId: 'addon-dev', issueNumber: 609 },
        { status: 'running', phase: 'implementation', ownerRunId: 'run-1' },
        { status: 'queued', phase: 'review', ownerRunId: undefined, leaseExpiresAt: undefined, now: '2026-06-06T00:03:00.000Z' },
      );

      expect(completion.ok).toBe(false);
      expect(completion.code).toBe('conflict');
      // The task stays cancelled — the stale completion never overwrote it.
      const final = await store.getTask({ sessionId: 'addon-dev', issueNumber: 609 });
      expect(final.status).toBe('cancelled');
    });
  });

  // ---------------------------------------------------------------------------
  // cancelTaskWithEffects — transactional-outbox guarantee for cancellation
  // (issue #608 review): mirrors the completePhaseWithEffects tests above.
  // ---------------------------------------------------------------------------

  describe('cancelTaskWithEffects', () => {
    test('commits the cancel transition, its task.cancelled event, and the outbox comment together', async () => {
      await store.enqueueTask({ sessionId: 'addon-dev', issueNumber: 620, phase: 'implementation', now: '2026-06-06T00:00:00.000Z' });
      const outboxStore = new SqliteOutboxStore(dbPath);

      const result = await store.cancelTaskWithEffects(
        { sessionId: 'addon-dev', issueNumber: 620 },
        { reason: 'operator abandoned', now: '2026-06-06T00:01:00.000Z' },
        {
          task: { sessionId: 'addon-dev', issueNumber: 620 },
          type: 'task.cancelled',
          runId: 'admin-task-cancel-1',
          message: 'operator abandoned',
          createdAt: '2026-06-06T00:01:00.000Z',
        },
        [
          {
            kind: 'enqueue',
            input: {
              idempotencyKey: 'addon-dev:620:admin-task-cancel-1:gh:comment:task-cancel',
              topic: 'gh:comment',
              payload: { topic: 'gh:comment', owner: 'org', repo: 'repo', issueNumber: 620, body: 'cancelled' },
            },
          },
        ],
      );

      expect(result.ok).toBe(true);
      expect(result.value.status).toBe('cancelled');

      const events = await store.listEvents({ sessionId: 'addon-dev', issueNumber: 620 });
      expect(events.map((e) => e.type)).toContain('task.cancelled');

      // A SEPARATE connection on the same dbPath sees the comment, proving it
      // landed in the same file/transaction as the cancel transition — not via
      // a live SqliteOutboxStore connection written ahead of the transaction.
      const pending = await outboxStore.listPending();
      expect(pending.map((e) => e.topic)).toEqual(['gh:comment']);

      outboxStore.close();
    });

    test('a lost cancellation race (already_cancelled) rolls back — no duplicate event or comment', async () => {
      await store.enqueueTask({ sessionId: 'addon-dev', issueNumber: 621, phase: 'implementation', now: '2026-06-06T00:00:00.000Z' });
      const outboxStore = new SqliteOutboxStore(dbPath);
      await store.cancelTask({ sessionId: 'addon-dev', issueNumber: 621 }, { now: '2026-06-06T00:01:00.000Z' });

      // A second cancellation races in after the first already committed.
      const result = await store.cancelTaskWithEffects(
        { sessionId: 'addon-dev', issueNumber: 621 },
        { reason: 'operator abandoned again', now: '2026-06-06T00:02:00.000Z' },
        {
          task: { sessionId: 'addon-dev', issueNumber: 621 },
          type: 'task.cancelled',
          runId: 'admin-task-cancel-2',
          createdAt: '2026-06-06T00:02:00.000Z',
        },
        [
          {
            kind: 'enqueue',
            input: {
              idempotencyKey: 'addon-dev:621:admin-task-cancel-2:gh:comment:task-cancel',
              topic: 'gh:comment',
              payload: { topic: 'gh:comment', owner: 'org', repo: 'repo', issueNumber: 621, body: 'cancelled again' },
            },
          },
        ],
      );

      expect(result.ok).toBe(false);
      expect(result.code).toBe('already_cancelled');

      // No second event, no comment leaked from the losing transaction.
      const events = await store.listEvents({ sessionId: 'addon-dev', issueNumber: 621 });
      expect(events.filter((e) => e.type === 'task.cancelled')).toHaveLength(0);
      const pending = await outboxStore.listPending();
      expect(pending).toHaveLength(0);

      outboxStore.close();
    });
  });

  describe('listSessionTasks', () => {
    test('lists every task row for a session, none for another', async () => {
      await store.enqueueTask({ sessionId: 'addon-dev', issueNumber: 430, phase: 'implementation', now: '2026-06-06T00:00:00.000Z' });
      await store.enqueueTask({ sessionId: 'addon-dev', issueNumber: 431, phase: 'review', now: '2026-06-06T00:00:00.000Z' });
      await store.enqueueTask({ sessionId: 'other-session', issueNumber: 432, phase: 'implementation', now: '2026-06-06T00:00:00.000Z' });

      const tasks = await store.listSessionTasks('addon-dev');

      expect(tasks.map((t) => t.issueNumber).sort()).toEqual([430, 431]);
      expect(await store.listSessionTasks('unknown-session')).toEqual([]);
    });
  });

  // issue #849 review: a session-wide report used to call listEvents once per
  // task, and the events table had no index at all — so every one of those
  // calls scanned it. These pin both halves of the fix.
  describe('session-wide event reads (issue #849 review)', () => {
    async function seed(sessionId, issueNumber, type, createdAt) {
      await store.appendEvent({ task: { sessionId, issueNumber }, type, createdAt });
    }

    test('listSessionEventsByType returns one type across the session, grouped by issue in append order', async () => {
      await seed('addon-dev', 431, 'review.dispute.transition', '2026-06-06T00:00:02.000Z');
      await seed('addon-dev', 430, 'phase.completed', '2026-06-06T00:00:03.000Z');
      await seed('addon-dev', 430, 'review.dispute.transition', '2026-06-06T00:00:04.000Z');
      await seed('addon-dev', 430, 'review.dispute.transition', '2026-06-06T00:00:05.000Z');
      await seed('other-session', 430, 'review.dispute.transition', '2026-06-06T00:00:06.000Z');

      const events = await store.listSessionEventsByType('addon-dev', 'review.dispute.transition');

      expect(events.map((e) => [e.task.issueNumber, e.createdAt])).toEqual([
        [430, '2026-06-06T00:00:04.000Z'],
        [430, '2026-06-06T00:00:05.000Z'],
        [431, '2026-06-06T00:00:02.000Z'],
      ]);
      expect(await store.listSessionEventsByType('addon-dev', 'no.such.event')).toEqual([]);
      expect(await store.listSessionEventsByType('unknown-session', 'review.dispute.transition')).toEqual([]);
    });

    test('both event reads are index searches, not table scans', () => {
      const raw = new Database(dbPath, { readonly: true });
      try {
        const plan = (sql, ...params) =>
          raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params).map((r) => r.detail).join(' | ');

        const perTask = plan(
          'SELECT * FROM events WHERE session_id = ? AND issue_number = ? ORDER BY id ASC',
          'addon-dev',
          430,
        );
        const perSession = plan(
          'SELECT * FROM events WHERE session_id = ? AND type = ? ORDER BY issue_number ASC, id ASC',
          'addon-dev',
          'review.dispute.transition',
        );

        for (const detail of [perTask, perSession]) {
          expect(detail).toContain('idx_events_session_issue');
          // `SCAN TABLE events` on older SQLite, `SCAN events` on newer.
          expect(detail).not.toMatch(/SCAN (TABLE )?events/);
          // The index already stores each query's ordering, so neither read
          // pays for a sort over the session's whole event history.
          expect(detail).not.toContain('TEMP B-TREE');
        }
      } finally {
        raw.close();
      }
    });
  });
});

// issue #677 review follow-up: `recoverHandoff` and GitHub intake already refuse
// to move a `ready_for_human`/implementation task with an unresolved Tool Request
// into review, so a `queued`/review row carrying an unresolved Tool Request should
// never exist in practice — but if one does (a stale row from before this guard
// existed, a direct DB write, a future caller that bypasses `recoverHandoff`),
// `claimNextTask` must refuse to claim it rather than letting the review handler's
// own backstop fire. That backstop returns a `failed` result, which `runNextPhase`
// would otherwise turn into `status: "failed", phase: "review"` — destroying the
// original `ready_for_human`/`implementation` handoff and leaving the Tool Request
// orphaned from the task that carries it.
describe('claimNextTask refuses a review-phase task with an unresolved Tool Request (issue #677)', () => {
  async function seedBypassedReviewRow(issueNumber) {
    // Simulates a row that reached queued/review with the Tool Request still
    // unresolved WITHOUT going through recoverHandoff's guard (e.g. a direct DB
    // write, or a stale row from before this guard existed) — the exact shape
    // claimNextTask must defend against on its own.
    await store.enqueueTask({
      sessionId: 'addon-dev',
      issueNumber,
      phase: 'review',
      reviewAgent: 'gemini',
      now: '2026-06-06T00:00:00.000Z',
    });
    await store.transitionTask(
      { sessionId: 'addon-dev', issueNumber },
      { status: 'queued' },
      {
        status: 'queued',
        phase: 'review',
        now: '2026-06-06T00:01:00.000Z',
        context: {
          toolRequest: {
            command: 'npm install left-pad',
            displayCommand: 'npm install left-pad',
            reason: 'needed for the fix',
            expectedFiles: ['package.json'],
            necessity: 'required',
            requestedBy: 'claude',
            mode: 'new',
            requestedAt: '2026-06-06T00:01:00.000Z',
            resolved: false,
          },
        },
      },
    );
  }

  test('claimNextTask skips the row instead of claiming it into running/review', async () => {
    await seedBypassedReviewRow(400);

    const claimed = await store.claimNextTask({
      sessionId: 'addon-dev',
      workerId: 'worker-a',
      runId: 'run-1',
      now: '2026-06-06T00:02:00.000Z',
    });

    expect(claimed).toBeUndefined();

    const task = await store.getTask({ sessionId: 'addon-dev', issueNumber: 400 });
    expect(task).toMatchObject({ status: 'queued', phase: 'review' });
    expect(task.context.toolRequest.resolved).toBe(false);
  });

  test('running runNextPhase over the row reports idle and never invokes the review handler', async () => {
    await seedBypassedReviewRow(401);
    let reviewHandlerCalls = 0;

    const outcome = await runNextPhase({
      store,
      request: {
        sessionId: 'addon-dev',
        workerId: 'worker-a',
        runId: 'run-1',
        now: '2026-06-06T00:02:00.000Z',
      },
      handlers: {
        review: async () => {
          reviewHandlerCalls += 1;
          return { result: 'failed', error: 'should never run' };
        },
      },
    });

    expect(outcome).toEqual({ status: 'idle' });
    expect(reviewHandlerCalls).toBe(0);

    // The handoff is exactly as it was: still queued/review with the Tool Request
    // unresolved (this test does not assert the *pre-existing* recovery path back
    // to ready_for_human/implementation — only that nothing further corrupted it).
    const task = await store.getTask({ sessionId: 'addon-dev', issueNumber: 401 });
    expect(task).toMatchObject({ status: 'queued', phase: 'review' });
    expect(task.context.toolRequest.resolved).toBe(false);
  });

  test('a resolved Tool Request no longer blocks the claim', async () => {
    await seedBypassedReviewRow(402);
    await store.transitionTask(
      { sessionId: 'addon-dev', issueNumber: 402 },
      { status: 'queued' },
      {
        context: {
          toolRequest: {
            command: 'npm install left-pad',
            displayCommand: 'npm install left-pad',
            reason: 'needed for the fix',
            expectedFiles: ['package.json'],
            necessity: 'required',
            requestedBy: 'claude',
            mode: 'new',
            requestedAt: '2026-06-06T00:01:00.000Z',
            resolved: true,
            resolution: { action: 'manual-done', resolvedAt: '2026-06-06T00:01:30.000Z' },
          },
        },
        now: '2026-06-06T00:01:45.000Z',
      },
    );

    const claimed = await store.claimNextTask({
      sessionId: 'addon-dev',
      workerId: 'worker-a',
      runId: 'run-1',
      now: '2026-06-06T00:02:00.000Z',
    });

    expect(claimed).toMatchObject({ status: 'claimed', phase: 'review', issueNumber: 402 });
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

// Issue #608 acceptance criterion: "a cancellation racing with claim/requeue
// has deterministic atomic behavior." Both cancelTask and claimNextTask wrap
// their read-check-write in an IMMEDIATE transaction, so SQLite's write lock
// serializes the two connections — exactly one operation's effect survives,
// never a torn write.
describe('SqliteTaskStore concurrent cancel vs. claim (two connections, same DB)', () => {
  test('whichever transaction commits first determines claimResult, but the task always ends cancelled', async () => {
    // cancelTask accepts BOTH `queued` and `claimed` as a starting status, so
    // unlike a claim-vs-claim race there is no "loser" that fails outright:
    // the only thing that differs by commit order is whether the concurrent
    // claim sees the row before or after cancellation lands.
    let tmpDir2;
    let storeA;
    let storeB;

    tmpDir2 = mkdtempSync(join(tmpdir(), 'sqlite-concurrent-cancel-'));
    const dbPath = join(tmpDir2, 'shared.db');

    try {
      storeA = new SqliteTaskStore(dbPath);
      storeB = new SqliteTaskStore(dbPath);

      await storeA.enqueueTask({
        sessionId: 'concurrent-session',
        issueNumber: 5,
        phase: 'implementation',
        now: '2026-06-06T00:00:00.000Z',
      });

      // Race a cancellation against a claim in the same event-loop tick.
      const [cancelResult, claimResult] = await Promise.all([
        storeA.cancelTask({ sessionId: 'concurrent-session', issueNumber: 5 }, { now: '2026-06-06T00:01:00.000Z' }),
        storeB.claimNextTask({
          sessionId: 'concurrent-session',
          workerId: 'worker-b',
          runId: 'run-b',
          now: '2026-06-06T00:01:00.000Z',
          leaseMs: 60000,
        }),
      ]);

      // cancelTask always succeeds here: it saw either `queued` (cancel ran
      // first) or `claimed` (claim ran first) — both are valid starting
      // statuses, so there is no torn write and no unexpected refusal.
      expect(cancelResult.ok).toBe(true);
      expect(cancelResult.value.status).toBe('cancelled');

      if (claimResult === undefined) {
        // Cancel's transaction committed first: claimNextTask's own
        // transaction, running after, found no runnable row.
      } else {
        // Claim's transaction committed first: it claimed normally, and the
        // cancellation that ran after still applied cleanly on top (claimed →
        // cancelled), clearing the owner/lease it had just set.
        expect(claimResult.status).toBe('claimed');
      }

      // Deterministic end state regardless of ordering: the task is cancelled
      // and never left half-claimed.
      const final = await storeA.getTask({ sessionId: 'concurrent-session', issueNumber: 5 });
      expect(final.status).toBe('cancelled');
      expect(final.ownerRunId).toBeUndefined();
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

  // ---------------------------------------------------------------------------
  // completePhaseWithEffects — transactional-outbox guarantee (issue #701)
  // ---------------------------------------------------------------------------

  describe('completePhaseWithEffects', () => {
    async function enqueueRunning(issueNumber) {
      await store.enqueueTask({
        sessionId: 'addon-dev', issueNumber, phase: 'implementation', now: '2026-06-07T00:00:00.000Z',
      });
      await store.claimNextTask({
        sessionId: 'addon-dev', workerId: 'w', runId: 'run-1', now: '2026-06-07T00:00:01.000Z',
      });
      const transitioned = await store.transitionTask(
        { sessionId: 'addon-dev', issueNumber },
        { status: 'claimed' },
        { status: 'running', now: '2026-06-07T00:00:02.000Z' },
      );
      return transitioned.value;
    }

    test('commits the transition, its event, and every outbox effect together', async () => {
      await enqueueRunning(300);
      const outboxStore = new SqliteOutboxStore(dbPath);

      const result = await store.completePhaseWithEffects(
        {
          key: { sessionId: 'addon-dev', issueNumber: 300 },
          expected: { status: 'running', phase: 'implementation', ownerRunId: 'run-1' },
          patch: { status: 'ready_for_human', ownerRunId: undefined, leaseExpiresAt: undefined, now: '2026-06-07T00:00:03.000Z' },
          event: { task: { sessionId: 'addon-dev', issueNumber: 300 }, type: 'phase.completed', runId: 'run-1', createdAt: '2026-06-07T00:00:03.000Z' },
        },
        [
          {
            kind: 'enqueue',
            input: {
              idempotencyKey: 'addon-dev:300:run-1:gh:comment',
              topic: 'gh:comment',
              payload: { topic: 'gh:comment', owner: 'org', repo: 'repo', issueNumber: 300, body: 'done' },
            },
          },
          {
            kind: 'replacePendingPrSummary',
            input: {
              idempotencyKey: 'addon-dev:300:run-1:repohost:pr-summary',
              topic: 'repohost:pr-summary',
              payload: { topic: 'repohost:pr-summary', provider: 'github', owner: 'org', repo: 'repo', prNumber: 5, marker: '<!-- m -->', body: 'summary' },
            },
            key: { owner: 'org', repo: 'repo', prNumber: 5, marker: '<!-- m -->' },
          },
        ],
      );

      expect(result.ok).toBe(true);
      expect(result.value.status).toBe('ready_for_human');

      const events = await store.listEvents({ sessionId: 'addon-dev', issueNumber: 300 });
      expect(events.map((e) => e.type)).toContain('phase.completed');

      // A SEPARATE connection on the same dbPath sees both effects, proving the
      // outbox write landed in the same file/transaction as the transition —
      // not via SqliteOutboxStore's own connection (never touched here).
      const pending = await outboxStore.listPending();
      expect(pending.map((e) => e.topic).sort()).toEqual(['gh:comment', 'repohost:pr-summary']);

      outboxStore.close();
    });

    test('a CAS conflict rolls back the whole transaction — no partial event or effect', async () => {
      await enqueueRunning(301);
      const outboxStore = new SqliteOutboxStore(dbPath);

      // Wrong ownerRunId → the CAS check inside the same transaction fails.
      const result = await store.completePhaseWithEffects(
        {
          key: { sessionId: 'addon-dev', issueNumber: 301 },
          expected: { status: 'running', phase: 'implementation', ownerRunId: 'some-other-run' },
          patch: { status: 'ready_for_human', now: '2026-06-07T00:00:03.000Z' },
          event: { task: { sessionId: 'addon-dev', issueNumber: 301 }, type: 'phase.completed', runId: 'run-1', createdAt: '2026-06-07T00:00:03.000Z' },
        },
        [
          {
            kind: 'enqueue',
            input: {
              idempotencyKey: 'addon-dev:301:run-1:gh:comment',
              topic: 'gh:comment',
              payload: { topic: 'gh:comment', owner: 'org', repo: 'repo', issueNumber: 301, body: 'done' },
            },
          },
        ],
      );

      expect(result.ok).toBe(false);
      expect(result.code).toBe('conflict');

      // Task never transitioned, no phase.completed event, and — critically —
      // no outbox row either: the effect did not leak out despite being handed
      // to completePhaseWithEffects, because it shares the transition's
      // transaction (issue #701 — no effect without its transition).
      const task = await store.getTask({ sessionId: 'addon-dev', issueNumber: 301 });
      expect(task.status).toBe('running');
      const events = await store.listEvents({ sessionId: 'addon-dev', issueNumber: 301 });
      expect(events.map((e) => e.type)).not.toContain('phase.completed');
      const pending = await outboxStore.listPending();
      expect(pending).toHaveLength(0);

      outboxStore.close();
    });

    test('does not delete a dead-lettered PR-summary row when replaced through the transactional path (issue #606 review follow-up)', async () => {
      await enqueueRunning(302);
      const outboxStore = new SqliteOutboxStore(dbPath);
      const summaryKey = { owner: 'org', repo: 'repo', prNumber: 9, marker: '<!-- m -->' };
      const payload = { topic: 'repohost:pr-summary', provider: 'github', owner: 'org', repo: 'repo', prNumber: 9, marker: '<!-- m -->', body: 'old body' };

      // Enqueue run-a directly and exhaust its retry budget so it dead-letters
      // rather than staying pending.
      await outboxStore.enqueue({ idempotencyKey: 'run-a', topic: 'repohost:pr-summary', payload });
      const [entry] = await outboxStore.listPending();
      let markResult;
      for (let i = 0; i < 8; i++) {
        markResult = await outboxStore.markFailed(entry.id, `err-${i}`, '2026-06-07T00:00:00.000Z');
      }
      expect(markResult).toEqual({ deadLettered: true });
      expect(await outboxStore.listPending()).toHaveLength(0);

      // A later phase completes and emits a fresh summary for the same PR
      // through the transactional completePhaseWithEffects path.
      const result = await store.completePhaseWithEffects(
        {
          key: { sessionId: 'addon-dev', issueNumber: 302 },
          expected: { status: 'running', phase: 'implementation', ownerRunId: 'run-1' },
          patch: { status: 'ready_for_human', ownerRunId: undefined, leaseExpiresAt: undefined, now: '2026-06-07T00:00:03.000Z' },
          event: { task: { sessionId: 'addon-dev', issueNumber: 302 }, type: 'phase.completed', runId: 'run-1', createdAt: '2026-06-07T00:00:03.000Z' },
        },
        [
          {
            kind: 'replacePendingPrSummary',
            input: {
              idempotencyKey: 'run-b',
              topic: 'repohost:pr-summary',
              payload: { ...payload, body: 'new body' },
            },
            key: summaryKey,
          },
        ],
      );

      expect(result.ok).toBe(true);

      const pending = await outboxStore.listPending();
      expect(pending).toHaveLength(1);
      expect(pending[0].idempotencyKey).toBe('run-b');

      const raw = new Database(dbPath, { readonly: true });
      try {
        const row = raw.prepare('SELECT idempotency_key, dead_letter_at FROM outbox WHERE idempotency_key = ?').get('run-a');
        expect(row).toBeDefined();
        expect(row.dead_letter_at).not.toBeNull();
      } finally {
        raw.close();
      }

      outboxStore.close();
    });
  });
});
