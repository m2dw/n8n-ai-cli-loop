import { MemoryTaskStore, nextPhaseAfter, runNextPhase } from '../dist/index.js';

describe('MemoryTaskStore', () => {
  test('claims one runnable task atomically for a session', async () => {
    const store = new MemoryTaskStore();
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
    const store = new MemoryTaskStore();
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

  test('transitionTask uses compare-and-swap expectations', async () => {
    const store = new MemoryTaskStore();
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

  test('releaseClaim only releases the matching owner', async () => {
    const store = new MemoryTaskStore();
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
    const store = new MemoryTaskStore();
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
});

describe('phase transitions', () => {
  test('dispatches one phase at a time without encoding n8n node order', () => {
    expect(nextPhaseAfter('implementation', 'success')).toEqual({
      status: 'queued',
      phase: 'review',
    });
    expect(nextPhaseAfter('review', 'conflict')).toEqual({
      status: 'queued',
      phase: 'conflict_resolution',
    });
    expect(nextPhaseAfter('conflict_resolution', 'success')).toEqual({
      status: 'queued',
      phase: 'review',
    });
  });

  test('review success becomes ready_for_human', () => {
    expect(nextPhaseAfter('review', 'success')).toEqual({
      status: 'ready_for_human',
      phase: 'review',
    });
    expect(nextPhaseAfter('review', 'success', { context: { prUrl: 'x' } })).toEqual({
      status: 'ready_for_human',
      phase: 'review',
    });
  });

  test('review success on a dependency-started task hands off as ready_for_human, not blocked (issue #242)', () => {
    // A dependency-started PR targets the session base branch (`main`) like any
    // other PR, so a passing review follows the normal ready_for_human handoff.
    // The presence of dependencyBase metadata must NOT hold it blocked.
    const task = {
      context: {
        dependencyBase: {
          baseIssueNumber: 50,
          basePrNumber: 55,
          baseHeadRefName: 'ai/issue-50',
          basePrUrl: 'https://github.com/owner/repo/pull/55',
        },
      },
    };
    expect(nextPhaseAfter('review', 'success', task)).toEqual({
      status: 'ready_for_human',
      phase: 'review',
    });
  });
});

describe('runNextPhase', () => {
  test('runs only the claimed phase and persists the next state', async () => {
    const store = new MemoryTaskStore();
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
    const store = new MemoryTaskStore();
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

describe('MemoryTaskStore — supportedPhases filtering', () => {
  test('claimNextTask skips tasks whose phase is not in supportedPhases', async () => {
    const store = new MemoryTaskStore();
    await store.enqueueTask({ sessionId: 'addon-dev', issueNumber: 1, phase: 'implementation', now: '2026-06-07T00:00:00.000Z' });

    const claimed = await store.claimNextTask({
      sessionId: 'addon-dev', workerId: 'w', runId: 'r1',
      now: '2026-06-07T00:01:00.000Z',
      supportedPhases: ['research'],
    });
    expect(claimed).toBeUndefined();
  });

  test('claimNextTask claims task whose phase is in supportedPhases', async () => {
    const store = new MemoryTaskStore();
    await store.enqueueTask({ sessionId: 'addon-dev', issueNumber: 2, phase: 'research', now: '2026-06-07T00:00:00.000Z' });

    const claimed = await store.claimNextTask({
      sessionId: 'addon-dev', workerId: 'w', runId: 'r1',
      now: '2026-06-07T00:01:00.000Z',
      supportedPhases: ['research'],
    });
    expect(claimed).toMatchObject({ phase: 'research', status: 'claimed' });
  });

  test('claimNextTask with supportedPhases picks research over implementation', async () => {
    const store = new MemoryTaskStore();
    await store.enqueueTask({ sessionId: 'addon-dev', issueNumber: 10, phase: 'implementation', now: '2026-06-07T00:00:00.000Z' });
    await store.enqueueTask({ sessionId: 'addon-dev', issueNumber: 11, phase: 'research', now: '2026-06-07T00:00:01.000Z' });

    const claimed = await store.claimNextTask({
      sessionId: 'addon-dev', workerId: 'w', runId: 'r1',
      now: '2026-06-07T00:01:00.000Z',
      supportedPhases: ['research'],
    });
    expect(claimed).toMatchObject({ issueNumber: 11, phase: 'research' });

    // implementation task must remain queued
    const impl = await store.getTask({ sessionId: 'addon-dev', issueNumber: 10 });
    expect(impl?.status).toBe('queued');
  });

  test('claimNextTask with no supportedPhases remains backward compatible', async () => {
    const store = new MemoryTaskStore();
    await store.enqueueTask({ sessionId: 'addon-dev', issueNumber: 20, phase: 'implementation', now: '2026-06-07T00:00:00.000Z' });

    const claimed = await store.claimNextTask({
      sessionId: 'addon-dev', workerId: 'w', runId: 'r1',
      now: '2026-06-07T00:01:00.000Z',
    });
    expect(claimed).toMatchObject({ phase: 'implementation' });
  });
});
