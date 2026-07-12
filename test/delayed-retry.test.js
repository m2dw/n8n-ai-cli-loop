/**
 * Delayed retry for quota/rate-limit failures (issue #25).
 *
 * Covers:
 *   - claimNextTask ignores queued tasks whose notBefore is in the future
 *   - claimNextTask claims queued tasks whose notBefore has expired
 *   - claiming clears a stale notBefore
 *   - runNextPhase: a `delayed` handler result releases the task back to queued
 *     with notBefore = now + delay, appends phase.delayed, and reports `delayed`
 *   - the delay is configurable (option + handler retryAfterMs override)
 */
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  SqliteTaskStore,
  MemoryTaskStore,
  runNextPhase,
  DEFAULT_QUOTA_RETRY_DELAY_MS,
} from '../dist/index.js';

const NOW = '2026-06-07T10:00:00.000Z';
const FUTURE = '2026-06-07T12:00:00.000Z'; // 2h after NOW
const PAST = '2026-06-07T09:00:00.000Z'; // 1h before NOW
const NOW_PLUS_2H = '2026-06-07T12:00:00.000Z';

// ---------------------------------------------------------------------------
// Store-level claim gating — runs against both store implementations.
// ---------------------------------------------------------------------------

describe.each([
  ['SqliteTaskStore', () => makeSqlite()],
  ['MemoryTaskStore', () => ({ store: new MemoryTaskStore(), cleanup: () => {} })],
])('claimNextTask notBefore gating — %s', (_name, factory) => {
  let store;
  let cleanup;

  beforeEach(() => {
    ({ store, cleanup } = factory());
  });

  afterEach(() => {
    cleanup();
  });

  async function enqueueWithNotBefore(notBefore) {
    await store.enqueueTask({
      sessionId: 's',
      issueNumber: 1,
      phase: 'research',
      now: NOW,
    });
    // notBefore is set via a transition, mirroring how the phase runner stamps it.
    const res = await store.transitionTask(
      { sessionId: 's', issueNumber: 1 },
      { status: 'queued' },
      { notBefore, now: NOW },
    );
    expect(res.ok).toBe(true);
  }

  const claim = (now) =>
    store.claimNextTask({ sessionId: 's', workerId: 'w', runId: 'r', now, leaseMs: 60000 });

  test('does not claim a task whose notBefore is in the future', async () => {
    await enqueueWithNotBefore(FUTURE);
    expect(await claim(NOW)).toBeUndefined();
  });

  test('claims a task whose notBefore has expired', async () => {
    await enqueueWithNotBefore(PAST);
    const claimed = await claim(NOW);
    expect(claimed).toMatchObject({ sessionId: 's', issueNumber: 1, status: 'claimed' });
  });

  test('claims exactly at notBefore (now === notBefore is eligible)', async () => {
    await enqueueWithNotBefore(NOW);
    const claimed = await claim(NOW);
    expect(claimed?.status).toBe('claimed');
  });

  test('claiming clears a stale notBefore', async () => {
    await enqueueWithNotBefore(PAST);
    await claim(NOW);
    const t = await store.getTask({ sessionId: 's', issueNumber: 1 });
    expect(t.notBefore).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// runNextPhase — delayed result handling
// ---------------------------------------------------------------------------

describe('runNextPhase — delayed (quota/rate-limit) handling', () => {
  let store;
  let cleanup;

  beforeEach(() => {
    ({ store, cleanup } = makeSqlite());
  });
  afterEach(() => cleanup());

  async function enqueue() {
    await store.enqueueTask({ sessionId: 's', issueNumber: 7, phase: 'research', now: NOW });
  }

  const request = { sessionId: 's', workerId: 'w', runId: 'run-1', now: NOW };

  test('releases the task back to queued with notBefore = now + default delay', async () => {
    await enqueue();
    const handler = async () => ({ result: 'delayed', message: 'quota', context: { artifactDir: '/a' } });

    const outcome = await runNextPhase({ store, request, handlers: { research: handler } });

    expect(outcome.status).toBe('delayed');
    expect(outcome.notBefore).toBe(NOW_PLUS_2H);
    expect(outcome.task).toMatchObject({ status: 'queued', phase: 'research', notBefore: NOW_PLUS_2H });
    expect(outcome.task.ownerRunId).toBeUndefined();

    const persisted = await store.getTask({ sessionId: 's', issueNumber: 7 });
    expect(persisted).toMatchObject({ status: 'queued', notBefore: NOW_PLUS_2H });

    // The delayed task is not reclaimable before notBefore...
    expect(await store.claimNextTask({ ...request, runId: 'run-2', now: '2026-06-07T11:00:00.000Z' })).toBeUndefined();
    // ...but is reclaimable once the window elapses.
    const reclaimed = await store.claimNextTask({ ...request, runId: 'run-3', now: '2026-06-07T16:00:00.000Z' });
    expect(reclaimed?.issueNumber).toBe(7);
  });

  test('appends a phase.delayed event (and no phase.completed)', async () => {
    await enqueue();
    const handler = async () => ({ result: 'delayed', message: 'rate limit', context: {} });
    await runNextPhase({ store, request, handlers: { research: handler } });

    const events = await store.listEvents({ sessionId: 's', issueNumber: 7 });
    const types = events.map((e) => e.type);
    expect(types).toContain('phase.delayed');
    expect(types).not.toContain('phase.completed');
    const delayed = events.find((e) => e.type === 'phase.delayed');
    expect(delayed.data).toMatchObject({ phase: 'research', notBefore: NOW_PLUS_2H, delayMs: DEFAULT_QUOTA_RETRY_DELAY_MS });
  });

  test('delay is configurable via quotaRetryDelayMs option', async () => {
    await enqueue();
    const handler = async () => ({ result: 'delayed', context: {} });
    const outcome = await runNextPhase({
      store,
      request,
      handlers: { research: handler },
      quotaRetryDelayMs: 60 * 60 * 1000, // 1h
    });
    expect(outcome.notBefore).toBe('2026-06-07T11:00:00.000Z');
  });

  test('handler retryAfterMs takes precedence over the option/default', async () => {
    await enqueue();
    const handler = async () => ({ result: 'delayed', retryAfterMs: 30 * 60 * 1000, context: {} }); // 30m
    const outcome = await runNextPhase({
      store,
      request,
      handlers: { research: handler },
      quotaRetryDelayMs: 60 * 60 * 1000,
    });
    expect(outcome.notBefore).toBe('2026-06-07T10:30:00.000Z');
  });

  test('does not enqueue GitHub label side effects for a delayed task', async () => {
    await enqueue();
    const enqueued = [];
    const outboxStore = { enqueue: async (e) => { enqueued.push(e); return { enqueued: true }; } };
    const session = {
      sessionId: 's', repoRoot: '/tmp', artifactRoot: '/tmp/.artifacts',
      githubRepo: 'o/r', githubOwner: 'o', githubName: 'r',
      defaults: { implementationAgent: 'claude', reviewAgent: 'codex', researchAgent: 'gemini' },
      workItemProvider: { provider: 'github-issues', auth: { mode: 'gh' } },
      labels: { active: 'ai:active', blocked: 'ai:blocked', readyForHuman: 'ai:rfh' },
    };
    const handler = async () => ({ result: 'delayed', context: {} });
    await runNextPhase({ store, request, handlers: { research: handler }, outboxStore, session });
    // A quota/rate-limit delay publishes a single status comment (issue #352) and
    // NO label side effects (the delayed-retry timing is owned by SQLite alone).
    const labelEffects = enqueued.filter((e) => e.topic === 'gh:label:add' || e.topic === 'gh:label:remove');
    expect(labelEffects).toHaveLength(0);
    const comments = enqueued.filter((e) => e.topic === 'gh:comment');
    expect(comments).toHaveLength(1);
    expect(comments[0].payload.body).toContain('quota/rate-limit delay');
  });
});

// ---------------------------------------------------------------------------
// runNextPhase — quota/rate-limit delay GitHub comment (issue #352)
// ---------------------------------------------------------------------------

describe('runNextPhase — quota/rate-limit delay comment (issue #352)', () => {
  let store;
  let cleanup;

  beforeEach(() => {
    ({ store, cleanup } = makeSqlite());
  });
  afterEach(() => cleanup());

  const SESSION = {
    sessionId: 's', repoRoot: '/srv/work/repo', artifactRoot: '/srv/work/repo/.artifacts',
    githubRepo: 'o/r', githubOwner: 'o', githubName: 'r',
    defaults: { implementationAgent: 'claude', reviewAgent: 'codex', researchAgent: 'gemini' },
    workItemProvider: { provider: 'github-issues', auth: { mode: 'gh' } },
    labels: { active: 'ai:active', blocked: 'ai:blocked', readyForHuman: 'ai:rfh' },
  };
  const request = { sessionId: 's', workerId: 'w', runId: 'run-1', now: NOW };

  async function enqueueImpl() {
    await store.enqueueTask({ sessionId: 's', issueNumber: 7, phase: 'implementation', now: NOW });
  }

  function makeOutbox() {
    const enqueued = [];
    return {
      enqueued,
      store: { enqueue: async (e) => { const dup = enqueued.some((x) => x.idempotencyKey === e.idempotencyKey); if (!dup) enqueued.push(e); return { enqueued: !dup }; } },
    };
  }

  test('enqueues one gh:comment naming the phase, agent, and absolute retry time', async () => {
    await enqueueImpl();
    const { enqueued, store: outboxStore } = makeOutbox();
    // Raw quota output in the handler message must NOT leak into the public comment.
    const handler = async () => ({
      result: 'delayed',
      message: 'Claude usage limit reached; try again in 4h — /srv/work/repo/.artifacts/run-1/out.log',
      context: {},
    });

    await runNextPhase({ store, request, handlers: { implementation: handler }, outboxStore, session: SESSION });

    const comments = enqueued.filter((e) => e.topic === 'gh:comment');
    expect(comments).toHaveLength(1);
    const body = comments[0].payload.body;
    expect(body).toContain('Agent quota/rate-limit delay');
    expect(body).toContain('`implementation`');
    expect(body).toContain('Claude'); // resolved implementation agent display name
    // Absolute timestamp with timezone (NOW + 2h default), not a relative phrase.
    expect(body).toContain('2026-06-07 12:00:00 UTC');
    expect(body).not.toMatch(/try again in/i);
    // No raw output / local paths leaked.
    expect(body).not.toContain('out.log');
    expect(body).not.toContain('/srv/work/repo');
  });

  test('names the persisted assignment agent, not the task column / session default', async () => {
    // The task's persisted assignment (intake authority) routes implementation to
    // Codex, while the task column and session default still say Claude. The
    // quota-delay handler returns a context WITHOUT the assignment, so naming the
    // agent from the post-transition task would lose it and report the wrong agent.
    await store.enqueueTask({
      sessionId: 's',
      issueNumber: 7,
      phase: 'implementation',
      implementationAgent: 'claude',
      context: {
        assignment: {
          flow: 'code',
          implementationAgent: 'codex',
          reviewAgent: 'codex',
          conflictResolutionAgent: 'claude',
          resolvedAt: NOW,
          source: 'session-config',
        },
      },
      now: NOW,
    });
    const { enqueued, store: outboxStore } = makeOutbox();
    const handler = async () => ({ result: 'delayed', context: { artifactDir: '/a' } });

    await runNextPhase({ store, request, handlers: { implementation: handler }, outboxStore, session: SESSION });

    const comments = enqueued.filter((e) => e.topic === 'gh:comment');
    expect(comments).toHaveLength(1);
    const body = comments[0].payload.body;
    expect(body).toContain('Codex'); // persisted assignment agent
    expect(body).not.toContain('Claude');
  });

  test('does not duplicate the comment while the same delay (notBefore) is active', async () => {
    await enqueueImpl();
    const { enqueued, store: outboxStore } = makeOutbox();
    const handler = async () => ({ result: 'delayed', context: {} });

    // First delay → comment enqueued.
    await runNextPhase({ store, request, handlers: { implementation: handler }, outboxStore, session: SESSION });
    // Re-claim at the same logical `now` (same notBefore) and delay again — a
    // duplicate scheduler tick must NOT post a second comment.
    await runNextPhase({ store, request: { ...request, runId: 'run-2' }, handlers: { implementation: handler }, outboxStore, session: SESSION });

    const comments = enqueued.filter((e) => e.topic === 'gh:comment');
    expect(comments).toHaveLength(1);
  });

  test('posts a fresh comment when a later delay yields a new retry time', async () => {
    await enqueueImpl();
    const { enqueued, store: outboxStore } = makeOutbox();
    const handler = async () => ({ result: 'delayed', context: {} });

    await runNextPhase({ store, request, handlers: { implementation: handler }, outboxStore, session: SESSION });
    // A later run at a different `now` produces a different notBefore → new comment.
    const later = '2026-06-07T16:00:00.000Z';
    await runNextPhase({ store, request: { ...request, runId: 'run-2', now: later }, handlers: { implementation: handler }, outboxStore, session: SESSION });

    const comments = enqueued.filter((e) => e.topic === 'gh:comment');
    expect(comments).toHaveLength(2);
  });

  test('no comment enqueued when no outbox store is configured', async () => {
    await enqueueImpl();
    const handler = async () => ({ result: 'delayed', context: {} });
    const outcome = await runNextPhase({ store, request, handlers: { implementation: handler } });
    expect(outcome.status).toBe('delayed');
  });

  test('routes the quota-delay comment to the work-item provider for a gitea-issues session', async () => {
    // For a non-GitHub work-item session the legacy `gh:comment` row would be
    // handed a failing GitHub runner by the dispatcher and strand forever. The
    // quota-delay effect must route through the work-item provider so it becomes a
    // provider-neutral `workitem:comment` row targeting the Gitea work-item repo.
    await enqueueImpl();
    const { enqueued, store: outboxStore } = makeOutbox();
    const giteaSession = {
      ...SESSION,
      workItemProvider: {
        provider: 'gitea-issues',
        auth: { mode: 'api-token', tokenEnv: 'GITEA_TOKEN' },
        gitea: { baseUrl: 'https://gitea.example.com', owner: 'ai-private', repo: 'work-items' },
      },
    };
    const handler = async () => ({ result: 'delayed', context: {} });

    await runNextPhase({ store, request, handlers: { implementation: handler }, outboxStore, session: giteaSession });

    // No legacy GitHub-specific row was produced.
    expect(enqueued.filter((e) => e.topic === 'gh:comment')).toHaveLength(0);
    const workItemComments = enqueued.filter((e) => e.topic === 'workitem:comment');
    expect(workItemComments).toHaveLength(1);
    // Retargeted at the Gitea work-item repo and tagged with the provider kind.
    expect(workItemComments[0].payload).toMatchObject({
      provider: 'gitea-issues',
      owner: 'ai-private',
      repo: 'work-items',
      issueNumber: 7,
    });
    expect(workItemComments[0].payload.body).toContain('Agent quota/rate-limit delay');
  });
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function makeSqlite() {
  const tmpDir = mkdtempSync(join(tmpdir(), 'delayed-retry-test-'));
  const store = new SqliteTaskStore(join(tmpDir, 'test.db'));
  return {
    store,
    cleanup: () => {
      store.close();
      rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}
