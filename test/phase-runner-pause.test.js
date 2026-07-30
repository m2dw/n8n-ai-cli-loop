/**
 * runNextPhase session pause gate + run-ledger recording (issue #531).
 *
 * Covers the runner wiring of the injected `checkSessionPause` and
 * `recordRunResult` hooks:
 *   - a paused session claims NOTHING: the outcome is `paused` with the stored
 *     reason, the task stays `queued`, and no events are appended;
 *   - an unpaused session proceeds exactly as before;
 *   - every executed phase is recorded in the ledger with session/issue/phase/
 *     outcome/duration/agent metadata — success, failure, and quota-delay;
 *   - handler-context `resolvedProfile`/cost metadata reaches the entry;
 *   - a recorder failure never masks the phase outcome (it is logged as a
 *     `run.ledger.failed` event);
 *   - omitted hooks behave exactly as before.
 */
import { MemoryTaskStore, runNextPhase } from '../dist/index.js';

const NOW = '2026-07-28T10:00:00.000Z';

let store;

beforeEach(async () => {
  store = new MemoryTaskStore();
  await store.enqueueTask({
    sessionId: 's',
    issueNumber: 7,
    phase: 'implementation',
    implementationAgent: 'claude',
    now: NOW,
  });
});

const request = {
  sessionId: 's',
  workerId: 'w',
  runId: 'run-1',
  supportedPhases: ['implementation'],
  now: NOW,
};

describe('session pause gate', () => {
  test('a paused session claims and executes nothing', async () => {
    let handlerRan = false;
    const outcome = await runNextPhase({
      store,
      request,
      handlers: { implementation: async () => { handlerRan = true; return { result: 'success' }; } },
      checkSessionPause: () => ({
        paused: true,
        reason: 'operator hold',
        pausedAt: NOW,
        pausedBy: 'operator',
        source: 'operator',
      }),
    });

    expect(outcome).toEqual({
      status: 'paused',
      reason: 'operator hold',
      pausedAt: NOW,
      pausedBy: 'operator',
      source: 'operator',
    });
    expect(handlerRan).toBe(false);
    // The queue is untouched: still claimable once resumed, and no events.
    const task = await store.getTask({ sessionId: 's', issueNumber: 7 });
    expect(task.status).toBe('queued');
    expect(task.ownerRunId).toBeUndefined();
    expect(await store.listEvents({ sessionId: 's', issueNumber: 7 })).toEqual([]);
  });

  test('a pause landing after the gate releases the admitted task and executes nothing', async () => {
    // Race (review finding on issue #531): the pre-claim gate sees unpaused,
    // then an operator pauses while this worker is admitting the claim. The
    // recheck is serialized AFTER the claimed→running transition, which is
    // what makes admission race-free: a pause the recheck observes — as here —
    // releases the task back to `queued` with the attempt count restored and
    // no events appended; a pause the recheck does NOT observe can only have
    // landed once the task was already `running`, i.e. the documented
    // "running phases are not force-stopped" exception.
    let handlerRan = false;
    let checks = 0;
    let statusAtRecheck;
    const outcome = await runNextPhase({
      store,
      request,
      handlers: { implementation: async () => { handlerRan = true; return { result: 'success' }; } },
      checkSessionPause: async () => {
        checks += 1;
        if (checks === 1) return { paused: false };
        // Pin the ordering the race fix depends on: at recheck time the task
        // is already observably `running`.
        statusAtRecheck = (await store.getTask({ sessionId: 's', issueNumber: 7 })).status;
        return { paused: true, reason: 'operator hold', source: 'operator' };
      },
    });

    expect(outcome).toEqual({ status: 'paused', reason: 'operator hold', source: 'operator' });
    expect(handlerRan).toBe(false);
    expect(checks).toBe(2);
    expect(statusAtRecheck).toBe('running');
    const task = await store.getTask({ sessionId: 's', issueNumber: 7 });
    expect(task.status).toBe('queued');
    expect(task.ownerRunId).toBeUndefined();
    expect(task.attempts.implementation ?? 0).toBe(0);
    // No phase.started (or any other) event records the aborted admission.
    expect(await store.listEvents({ sessionId: 's', issueNumber: 7 })).toEqual([]);
  });

  test('an unpaused session proceeds normally', async () => {
    const outcome = await runNextPhase({
      store,
      request,
      handlers: { implementation: async () => ({ result: 'success' }) },
      checkSessionPause: () => ({ paused: false }),
    });
    expect(outcome.status).toBe('completed');
  });

  test('an async pause check is awaited', async () => {
    const outcome = await runNextPhase({
      store,
      request,
      handlers: { implementation: async () => ({ result: 'success' }) },
      checkSessionPause: async () => ({ paused: true }),
    });
    expect(outcome).toEqual({ status: 'paused' });
  });
});

describe('run-ledger recording', () => {
  test('a successful run is recorded with assignment-derived agent metadata', async () => {
    const entries = [];
    const outcome = await runNextPhase({
      store,
      request,
      handlers: { implementation: async () => ({ result: 'success' }) },
      recordRunResult: (entry) => { entries.push(entry); },
    });
    expect(outcome.status).toBe('completed');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      sessionId: 's',
      issueNumber: 7,
      phase: 'implementation',
      outcome: 'success',
      runId: 'run-1',
      createdAt: NOW,
      agent: 'claude',
    });
    expect(typeof entries[0].durationMs).toBe('number');
  });

  test('a failed run is recorded as failed', async () => {
    const entries = [];
    const outcome = await runNextPhase({
      store,
      request,
      handlers: { implementation: async () => ({ result: 'failed', error: 'boom' }) },
      recordRunResult: (entry) => { entries.push(entry); },
    });
    expect(outcome.status).toBe('completed');
    expect(outcome.result.result).toBe('failed');
    expect(entries).toHaveLength(1);
    expect(entries[0].outcome).toBe('failed');
  });

  test('a quota-delayed run is recorded as delayed', async () => {
    const entries = [];
    const outcome = await runNextPhase({
      store,
      request,
      handlers: {
        implementation: async () => ({ result: 'delayed', message: 'quota', retryAfterMs: 60_000 }),
      },
      recordRunResult: (entry) => { entries.push(entry); },
    });
    expect(outcome.status).toBe('delayed');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ outcome: 'delayed', phase: 'implementation', issueNumber: 7 });
  });

  test('handler-context resolvedProfile and cost metadata reach the entry', async () => {
    const entries = [];
    await runNextPhase({
      store,
      request,
      handlers: {
        implementation: async () => ({
          result: 'success',
          context: {
            resolvedProfile: { agentId: 'codex', model: 'gpt-5.2-codex', effort: 'high' },
            costUsd: 0.55,
            inputTokens: 900,
            outputTokens: 120,
          },
        }),
      },
      recordRunResult: (entry) => { entries.push(entry); },
    });
    expect(entries[0]).toMatchObject({
      agent: 'codex',
      model: 'gpt-5.2-codex',
      effort: 'high',
      costUsd: 0.55,
      inputTokens: 900,
      outputTokens: 120,
    });
  });

  test('a recorder failure never masks the outcome and is logged as an event', async () => {
    const outcome = await runNextPhase({
      store,
      request,
      handlers: { implementation: async () => ({ result: 'success' }) },
      recordRunResult: () => { throw new Error('ledger unavailable'); },
    });
    expect(outcome.status).toBe('completed');
    const task = await store.getTask({ sessionId: 's', issueNumber: 7 });
    expect(task.status).not.toBe('failed');
    const events = await store.listEvents({ sessionId: 's', issueNumber: 7 });
    const ledgerFailed = events.find((e) => e.type === 'run.ledger.failed');
    expect(ledgerFailed).toBeDefined();
    expect(ledgerFailed.message).toBe('ledger unavailable');
  });

  test('omitted hooks leave behavior unchanged', async () => {
    const outcome = await runNextPhase({
      store,
      request,
      handlers: { implementation: async () => ({ result: 'success' }) },
    });
    expect(outcome.status).toBe('completed');
  });
});
