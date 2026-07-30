/**
 * Tests for Slack ready_for_human notifications (issue #465).
 *
 * Covers:
 *  - enqueueSlackNotificationEffect: configured, unconfigured, disabled, idempotency
 *  - dispatchOutbox / dispatchSlackNotification: success, failure (HTTP error,
 *    network error, missing env var), task-state isolation after dispatch failure
 *  - Phase-runner integration: ready_for_human transition enqueues Slack entry
 */
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SqliteTaskStore } from '../dist/stores/sqlite-task-store.js';
import { SqliteOutboxStore } from '../dist/stores/sqlite-outbox-store.js';
import { enqueueSlackNotificationEffect } from '../dist/core/outbox-effects.js';
import { dispatchOutbox } from '../dist/handlers/gh-dispatcher.js';
import { runNextPhase } from '../dist/core/phase-runner.js';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const NOW = '2026-07-03T10:00:00.000Z';

/** Minimal resolved session without Slack configured. */
const SESSION_NO_SLACK = {
  sessionId: 'test-session',
  repoKey: 'test-repo',
  repoRoot: '/tmp/test-repo',
  githubRepo: 'org/repo',
  artifactDir: '.artifacts',
  artifactRoot: '/tmp/test-repo/.artifacts',
  githubOwner: 'org',
  githubName: 'repo',
  defaults: { implementationAgent: 'claude', reviewAgent: 'codex' },
  verification: {},
  labels: { active: 'ai:active', blocked: 'ai:blocked', readyForHuman: 'ai:ready-for-human' },
  workItemProvider: { provider: 'github-issues', auth: { mode: 'gh' } },
  repoHostProvider: { provider: 'github', auth: { mode: 'gh' } },
};

/** Session with Slack notifications enabled. */
const SESSION_WITH_SLACK = {
  ...SESSION_NO_SLACK,
  notifications: {
    slack: { enabled: true, webhookUrlEnv: 'SLACK_WEBHOOK_URL' },
  },
};

/** Session with Slack notifications disabled. */
const SESSION_SLACK_DISABLED = {
  ...SESSION_NO_SLACK,
  notifications: {
    slack: { enabled: false, webhookUrlEnv: 'SLACK_WEBHOOK_URL' },
  },
};

const TASK = {
  sessionId: 'test-session',
  issueNumber: 42,
  phase: 'review',
  context: {},
  attempts: {},
};

const RESULT_SUCCESS = { result: 'success', message: 'Review passed', context: {} };
const RESULT_BLOCKED = {
  result: 'blocked',
  message: 'Unresolvable conflict',
  context: { prUrl: 'https://github.com/org/repo/pull/7' },
};
const RESULT_TOOL_REQUEST = {
  result: 'tool_request',
  message: 'Needs npm install',
  context: {},
};
const RESULT_FAILED = {
  result: 'failed',
  error: 'Conflict resolution agent exited with code 1',
  context: { prUrl: 'https://github.com/org/repo/pull/9' },
};

// ---------------------------------------------------------------------------
// SQLite store helpers
// ---------------------------------------------------------------------------

let tmpDir;
let dbPath;
let outboxStore;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'slack-notif-test-'));
  dbPath = join(tmpDir, 'test.db');
  outboxStore = new SqliteOutboxStore(dbPath);
});

afterEach(() => {
  outboxStore.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// enqueueSlackNotificationEffect
// ---------------------------------------------------------------------------

describe('enqueueSlackNotificationEffect — configured', () => {
  test('enqueues a slack:notification entry on ready_for_human', async () => {
    await enqueueSlackNotificationEffect(
      outboxStore, SESSION_WITH_SLACK, TASK, 'review', RESULT_SUCCESS, 'run-1', NOW,
    );

    const pending = await outboxStore.listPending();
    const slack = pending.find((e) => e.topic === 'slack:notification');
    expect(slack).toBeDefined();
    expect(slack.payload.topic).toBe('slack:notification');
    expect(slack.payload.issueNumber).toBe(42);
    expect(slack.payload.phase).toBe('review');
    expect(slack.payload.sessionId).toBe('test-session');
    expect(slack.payload.webhookUrlEnv).toBe('SLACK_WEBHOOK_URL');
    expect(slack.payload.issueUrl).toContain('/issues/42');
    // reason is sanitized from result.message
    expect(slack.payload.reason).toBe('Review passed');
  });

  test('includes PR URL from context when available', async () => {
    await enqueueSlackNotificationEffect(
      outboxStore, SESSION_WITH_SLACK, TASK, 'review', RESULT_BLOCKED, 'run-2', NOW,
    );

    const pending = await outboxStore.listPending();
    const slack = pending.find((e) => e.topic === 'slack:notification');
    expect(slack.payload.prUrl).toBe('https://github.com/org/repo/pull/7');
  });

  test('does not include local paths in payload (reason sanitized)', async () => {
    const resultWithPath = {
      result: 'blocked',
      message: 'Failed: /Users/moto/git/repo/artifact.txt has issues',
      context: {},
    };
    await enqueueSlackNotificationEffect(
      outboxStore, SESSION_WITH_SLACK, TASK, 'implementation', resultWithPath, 'run-3', NOW,
    );

    const pending = await outboxStore.listPending();
    const slack = pending.find((e) => e.topic === 'slack:notification');
    expect(slack.payload.reason).not.toContain('/Users/moto');
    expect(slack.payload.reason).toContain('<path>');
  });

  test('owner/repo are GitHub coordinates (for dispatch filter)', async () => {
    await enqueueSlackNotificationEffect(
      outboxStore, SESSION_WITH_SLACK, TASK, 'review', RESULT_SUCCESS, 'run-4', NOW,
    );

    const pending = await outboxStore.listPending();
    const slack = pending.find((e) => e.topic === 'slack:notification');
    expect(slack.payload.owner).toBe('org');
    expect(slack.payload.repo).toBe('repo');
  });
});

describe('enqueueSlackNotificationEffect — unconfigured / disabled', () => {
  test('enqueues nothing when session has no notifications config', async () => {
    await enqueueSlackNotificationEffect(
      outboxStore, SESSION_NO_SLACK, TASK, 'review', RESULT_SUCCESS, 'run-5', NOW,
    );

    const pending = await outboxStore.listPending();
    expect(pending.filter((e) => e.topic === 'slack:notification')).toHaveLength(0);
  });

  test('enqueues nothing when slack.enabled is false', async () => {
    await enqueueSlackNotificationEffect(
      outboxStore, SESSION_SLACK_DISABLED, TASK, 'review', RESULT_SUCCESS, 'run-6', NOW,
    );

    const pending = await outboxStore.listPending();
    expect(pending.filter((e) => e.topic === 'slack:notification')).toHaveLength(0);
  });
});

describe('enqueueSlackNotificationEffect — idempotency', () => {
  test('same runId produces exactly one outbox entry', async () => {
    await enqueueSlackNotificationEffect(
      outboxStore, SESSION_WITH_SLACK, TASK, 'review', RESULT_SUCCESS, 'run-idem', NOW,
    );
    // Call again with the same runId (simulating a retry)
    await enqueueSlackNotificationEffect(
      outboxStore, SESSION_WITH_SLACK, TASK, 'review', RESULT_SUCCESS, 'run-idem', NOW,
    );

    const pending = await outboxStore.listPending();
    expect(pending.filter((e) => e.topic === 'slack:notification')).toHaveLength(1);
  });

  test('different runId produces separate entries', async () => {
    await enqueueSlackNotificationEffect(
      outboxStore, SESSION_WITH_SLACK, TASK, 'review', RESULT_SUCCESS, 'run-a', NOW,
    );
    await enqueueSlackNotificationEffect(
      outboxStore, SESSION_WITH_SLACK, TASK, 'review', RESULT_SUCCESS, 'run-b', NOW,
    );

    const pending = await outboxStore.listPending();
    expect(pending.filter((e) => e.topic === 'slack:notification')).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// dispatchOutbox — slack:notification dispatch
// ---------------------------------------------------------------------------

const SLACK_PAYLOAD = {
  topic: 'slack:notification',
  owner: 'org',
  repo: 'repo',
  webhookUrlEnv: 'TEST_SLACK_WEBHOOK',
  sessionId: 'test-session',
  issueNumber: 42,
  phase: 'review',
  reason: 'Review passed',
  issueUrl: 'https://github.com/org/repo/issues/42',
};

function okGhRunner() {
  return { run: () => ({ exitCode: 0, stdout: '', stderr: '' }) };
}

async function enqueueSlackEntry(payload = SLACK_PAYLOAD) {
  await outboxStore.enqueue({
    idempotencyKey: `test-session:42:run-dispatch:slack:notification`,
    topic: 'slack:notification',
    payload,
    now: NOW,
  });
}

describe('dispatchOutbox — Slack notification success', () => {
  test('calls fetch and marks entry sent', async () => {
    await enqueueSlackEntry();

    const calls = [];
    const mockFetch = async (url, opts) => {
      calls.push({ url, opts });
      return { ok: true, status: 200, text: async () => '' };
    };

    const result = await dispatchOutbox(outboxStore, okGhRunner(), {
      cwd: '/tmp',
      fetchImpl: mockFetch,
      env: { TEST_SLACK_WEBHOOK: 'https://hooks.slack.com/fake' },
    });

    expect(result.dispatched).toBe(1);
    expect(result.failed).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://hooks.slack.com/fake');
    expect(JSON.parse(calls[0].opts.body).text).toContain('issue #42');

    const remaining = await outboxStore.listPending();
    expect(remaining.filter((e) => e.topic === 'slack:notification')).toHaveLength(0);
  });
});

describe('dispatchOutbox — Slack notification failures', () => {
  test('env var not set — entry stays pending, error reported', async () => {
    await enqueueSlackEntry();

    const result = await dispatchOutbox(outboxStore, okGhRunner(), {
      cwd: '/tmp',
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => '' }),
      env: {}, // no TEST_SLACK_WEBHOOK
    });

    expect(result.dispatched).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.errors[0].error).toContain('TEST_SLACK_WEBHOOK');

    const remaining = await outboxStore.listPending();
    expect(remaining.filter((e) => e.topic === 'slack:notification')).toHaveLength(1);
  });

  test('HTTP error — entry stays pending, status reported', async () => {
    await enqueueSlackEntry();

    const mockFetch = async () => ({
      ok: false,
      status: 500,
      text: async () => 'internal_error',
    });

    const result = await dispatchOutbox(outboxStore, okGhRunner(), {
      cwd: '/tmp',
      fetchImpl: mockFetch,
      env: { TEST_SLACK_WEBHOOK: 'https://hooks.slack.com/fake' },
    });

    expect(result.dispatched).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.errors[0].error).toContain('HTTP 500');

    const remaining = await outboxStore.listPending();
    expect(remaining.filter((e) => e.topic === 'slack:notification')).toHaveLength(1);
  });

  test('network failure — entry stays pending, error reported', async () => {
    await enqueueSlackEntry();

    const mockFetch = async () => {
      throw new Error('ECONNREFUSED');
    };

    const result = await dispatchOutbox(outboxStore, okGhRunner(), {
      cwd: '/tmp',
      fetchImpl: mockFetch,
      env: { TEST_SLACK_WEBHOOK: 'https://hooks.slack.com/fake' },
    });

    expect(result.dispatched).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.errors[0].error).toContain('ECONNREFUSED');

    const remaining = await outboxStore.listPending();
    expect(remaining.filter((e) => e.topic === 'slack:notification')).toHaveLength(1);
  });

  test('Slack failure does not affect other outbox entries dispatched in the same run', async () => {
    // Enqueue a normal comment entry alongside the failing Slack entry
    await outboxStore.enqueue({
      idempotencyKey: 'test-session:42:run-1:gh:comment:impl:success',
      topic: 'gh:comment',
      payload: { topic: 'gh:comment', owner: 'org', repo: 'repo', issueNumber: 42, body: 'done' },
      now: NOW,
    });
    await enqueueSlackEntry();

    const mockFetch = async () => ({ ok: false, status: 503, text: async () => 'unavailable' });

    const result = await dispatchOutbox(outboxStore, okGhRunner(), {
      cwd: '/tmp',
      fetchImpl: mockFetch,
      env: { TEST_SLACK_WEBHOOK: 'https://hooks.slack.com/fake' },
    });

    // gh:comment should succeed (okGhRunner), slack should fail
    expect(result.dispatched).toBe(1);
    expect(result.failed).toBe(1);

    const remaining = await outboxStore.listPending();
    expect(remaining.filter((e) => e.topic === 'slack:notification')).toHaveLength(1);
    expect(remaining.filter((e) => e.topic === 'gh:comment')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// dispatchOutbox — Slack-only runner isolation
// ---------------------------------------------------------------------------

describe('dispatchOutbox — Slack-only runner isolation', () => {
  test('runner resolver failure does not abort a Slack-only drain', async () => {
    // Only a Slack notification entry is pending — no GitHub rows.
    await enqueueSlackEntry();

    // A runner factory that throws — simulates a GitHub App installation-token
    // exchange failing due to missing credentials or a network partition. Before
    // the fix, this would abort the drain before calling the Slack webhook.
    const failingRunner = async () => {
      throw new Error('GitHub App token exchange failed');
    };

    const mockFetch = async () => ({ ok: true, status: 200, text: async () => '' });

    // Should succeed: the runner is never resolved for a Slack-only batch.
    const result = await dispatchOutbox(outboxStore, failingRunner, {
      cwd: '/tmp',
      fetchImpl: mockFetch,
      env: { TEST_SLACK_WEBHOOK: 'https://hooks.slack.com/fake' },
    });

    expect(result.dispatched).toBe(1);
    expect(result.failed).toBe(0);

    const remaining = await outboxStore.listPending();
    expect(remaining.filter((e) => e.topic === 'slack:notification')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Phase-runner integration — ready_for_human transition enqueues Slack entry
// ---------------------------------------------------------------------------

describe('phase-runner integration — Slack notification on ready_for_human', () => {
  let taskStore;

  beforeEach(() => {
    taskStore = new SqliteTaskStore(dbPath);
  });

  afterEach(() => {
    taskStore.close();
  });

  async function enqueueTask(phase, context = {}) {
    return taskStore.enqueueTask({
      sessionId: 'test-session',
      issueNumber: 42,
      phase,
      now: NOW,
      context,
    });
  }

  test('review success → ready_for_human → Slack entry enqueued (slack configured)', async () => {
    await enqueueTask('review', {});
    const handler = async () => ({ result: 'success', message: 'Review passed', context: {} });

    const outcome = await runNextPhase({
      store: taskStore,
      request: { sessionId: 'test-session', workerId: 'w1', runId: 'run-pr1', now: NOW },
      handlers: { review: handler },
      outboxStore,
      session: SESSION_WITH_SLACK,
      now: NOW,
    });

    expect(outcome.status).toBe('completed');
    const pending = await outboxStore.listPending();
    const slack = pending.find((e) => e.topic === 'slack:notification');
    expect(slack).toBeDefined();
    expect(slack.payload.phase).toBe('review');
    expect(slack.payload.issueNumber).toBe(42);
  });

  test('review success → ready_for_human → no Slack entry (slack not configured)', async () => {
    await enqueueTask('review', {});
    const handler = async () => ({ result: 'success', message: 'Review passed', context: {} });

    await runNextPhase({
      store: taskStore,
      request: { sessionId: 'test-session', workerId: 'w1', runId: 'run-pr2', now: NOW },
      handlers: { review: handler },
      outboxStore,
      session: SESSION_NO_SLACK,
      now: NOW,
    });

    const pending = await outboxStore.listPending();
    expect(pending.filter((e) => e.topic === 'slack:notification')).toHaveLength(0);
  });

  test('implementation tool_request → ready_for_human → Slack entry enqueued', async () => {
    await enqueueTask('implementation', {});
    const handler = async () => ({
      result: 'tool_request',
      message: 'Needs npm install',
      context: { toolRequest: { command: 'npm install', reason: 'install deps' } },
    });

    await runNextPhase({
      store: taskStore,
      request: { sessionId: 'test-session', workerId: 'w1', runId: 'run-pr3', now: NOW },
      handlers: { implementation: handler },
      outboxStore,
      session: SESSION_WITH_SLACK,
      now: NOW,
    });

    const pending = await outboxStore.listPending();
    const slack = pending.find((e) => e.topic === 'slack:notification');
    expect(slack).toBeDefined();
    expect(slack.payload.phase).toBe('implementation');
  });

  test('implementation success → queued for review (not ready_for_human) → no Slack entry', async () => {
    await enqueueTask('implementation', {});
    const handler = async () => ({
      result: 'success',
      context: { prUrl: 'https://github.com/org/repo/pull/5' },
    });

    await runNextPhase({
      store: taskStore,
      request: { sessionId: 'test-session', workerId: 'w1', runId: 'run-pr4', now: NOW },
      handlers: { implementation: handler },
      outboxStore,
      session: SESSION_WITH_SLACK,
      now: NOW,
    });

    const pending = await outboxStore.listPending();
    expect(pending.filter((e) => e.topic === 'slack:notification')).toHaveLength(0);
  });

  test('a broken outboxStore no longer blocks or drops the transactional outbox write (issue #701)', async () => {
    // Before #701, every effect was written directly through the `outboxStore`
    // instance passed into runNextPhase, so a throwing sink was silently
    // swallowed — the task still completed with the notification dropped. Now
    // the task transition and every outbox effect commit atomically through
    // the task store's own SQLite connection (completePhaseWithEffects), so a
    // broken `outboxStore` object passed in has no bearing on the actual
    // write: it is never called to perform it.
    const brokenOutbox = {
      enqueue: async () => {
        throw new Error('injected outbox failure');
      },
      replacePendingPrSummary: async () => {
        throw new Error('injected outbox failure');
      },
      listPending: (limit) => outboxStore.listPending(limit),
      markSent: (id, sentAt) => outboxStore.markSent(id, sentAt),
    };

    await enqueueTask('review', {});
    const handler = async () => ({ result: 'success', message: 'Review passed', context: {} });

    const outcome = await runNextPhase({
      store: taskStore,
      request: { sessionId: 'test-session', workerId: 'w1', runId: 'run-pr5', now: NOW },
      handlers: { review: handler },
      outboxStore: brokenOutbox,
      session: SESSION_WITH_SLACK,
      now: NOW,
    });

    expect(outcome.status).toBe('completed');
    expect(outcome.task.status).toBe('ready_for_human');

    // The Slack notification was actually enqueued — via taskStore's own SQLite
    // connection, not the broken outboxStore's enqueue() — so a real
    // SqliteOutboxStore opened on the same dbPath sees it.
    const pending = await outboxStore.listPending();
    const slack = pending.find((e) => e.topic === 'slack:notification');
    expect(slack).toBeDefined();
  });

  test('conflict_resolution failed → failed status → Slack entry enqueued (slack configured)', async () => {
    await enqueueTask('conflict_resolution', {});
    const handler = async () => ({
      result: 'failed',
      error: 'Conflict resolution agent exited with code 1',
      context: { prUrl: 'https://github.com/org/repo/pull/9' },
    });

    const outcome = await runNextPhase({
      store: taskStore,
      request: { sessionId: 'test-session', workerId: 'w1', runId: 'run-fail1', now: NOW },
      handlers: { conflict_resolution: handler },
      outboxStore,
      session: SESSION_WITH_SLACK,
      now: NOW,
    });

    expect(outcome.status).toBe('completed');
    expect(outcome.task.status).toBe('failed');
    const pending = await outboxStore.listPending();
    const slack = pending.find((e) => e.topic === 'slack:notification');
    expect(slack).toBeDefined();
    expect(slack.payload.transition).toBe('failed');
    expect(slack.payload.phase).toBe('conflict_resolution');
    expect(slack.payload.issueNumber).toBe(42);
    expect(slack.payload.reason).toBe('Conflict resolution agent exited with code 1');
  });

  test('implementation failed → failed status → Slack entry enqueued (slack configured)', async () => {
    await enqueueTask('implementation', {});
    const handler = async () => ({
      result: 'failed',
      error: 'Agent exited non-zero',
      context: {},
    });

    await runNextPhase({
      store: taskStore,
      request: { sessionId: 'test-session', workerId: 'w1', runId: 'run-fail2', now: NOW },
      handlers: { implementation: handler },
      outboxStore,
      session: SESSION_WITH_SLACK,
      now: NOW,
    });

    const pending = await outboxStore.listPending();
    const slack = pending.find((e) => e.topic === 'slack:notification');
    expect(slack).toBeDefined();
    expect(slack.payload.transition).toBe('failed');
    expect(slack.payload.phase).toBe('implementation');
  });

  test('failed transition → no Slack entry (slack not configured)', async () => {
    await enqueueTask('conflict_resolution', {});
    const handler = async () => ({
      result: 'failed',
      error: 'Something went wrong',
      context: {},
    });

    await runNextPhase({
      store: taskStore,
      request: { sessionId: 'test-session', workerId: 'w1', runId: 'run-fail3', now: NOW },
      handlers: { conflict_resolution: handler },
      outboxStore,
      session: SESSION_NO_SLACK,
      now: NOW,
    });

    const pending = await outboxStore.listPending();
    expect(pending.filter((e) => e.topic === 'slack:notification')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// enqueueSlackNotificationEffect — failed result payload
// ---------------------------------------------------------------------------

describe('enqueueSlackNotificationEffect — failed result', () => {
  test('enqueues a slack:notification with transition=failed and reason from error', async () => {
    await enqueueSlackNotificationEffect(
      outboxStore, SESSION_WITH_SLACK, TASK, 'conflict_resolution', RESULT_FAILED, 'run-f1', NOW,
    );

    const pending = await outboxStore.listPending();
    const slack = pending.find((e) => e.topic === 'slack:notification');
    expect(slack).toBeDefined();
    expect(slack.payload.transition).toBe('failed');
    expect(slack.payload.phase).toBe('conflict_resolution');
    expect(slack.payload.reason).toBe('Conflict resolution agent exited with code 1');
    expect(slack.payload.issueNumber).toBe(42);
    expect(slack.payload.sessionId).toBe('test-session');
  });

  test('includes PR URL from context when available on failed result', async () => {
    await enqueueSlackNotificationEffect(
      outboxStore, SESSION_WITH_SLACK, TASK, 'conflict_resolution', RESULT_FAILED, 'run-f2', NOW,
    );

    const pending = await outboxStore.listPending();
    const slack = pending.find((e) => e.topic === 'slack:notification');
    expect(slack.payload.prUrl).toBe('https://github.com/org/repo/pull/9');
  });

  test('sanitizes local paths in error string on failed result', async () => {
    const resultWithPath = {
      result: 'failed',
      error: 'Push failed: /Users/moto/git/repo/.git/MERGE_HEAD exists',
      context: {},
    };
    await enqueueSlackNotificationEffect(
      outboxStore, SESSION_WITH_SLACK, TASK, 'conflict_resolution', resultWithPath, 'run-f3', NOW,
    );

    const pending = await outboxStore.listPending();
    const slack = pending.find((e) => e.topic === 'slack:notification');
    expect(slack.payload.reason).not.toContain('/Users/moto');
    expect(slack.payload.reason).toContain('<path>');
  });

  test('ready_for_human result has transition=ready_for_human', async () => {
    await enqueueSlackNotificationEffect(
      outboxStore, SESSION_WITH_SLACK, TASK, 'review', RESULT_SUCCESS, 'run-f4', NOW,
    );

    const pending = await outboxStore.listPending();
    const slack = pending.find((e) => e.topic === 'slack:notification');
    expect(slack.payload.transition).toBe('ready_for_human');
  });
});

// ---------------------------------------------------------------------------
// dispatchOutbox — Slack message text for failed vs ready_for_human
// ---------------------------------------------------------------------------

describe('dispatchOutbox — Slack message text for failed vs ready_for_human', () => {
  test('failed transition: Slack message says Failed, not Ready for human', async () => {
    await outboxStore.enqueue({
      idempotencyKey: 'test-session:42:run-msg1:slack:notification',
      topic: 'slack:notification',
      payload: {
        ...SLACK_PAYLOAD,
        transition: 'failed',
        reason: 'Agent exited non-zero',
      },
      now: NOW,
    });

    const calls = [];
    const mockFetch = async (url, opts) => {
      calls.push({ url, opts });
      return { ok: true, status: 200, text: async () => '' };
    };

    await dispatchOutbox(outboxStore, okGhRunner(), {
      cwd: '/tmp',
      fetchImpl: mockFetch,
      env: { TEST_SLACK_WEBHOOK: 'https://hooks.slack.com/fake' },
    });

    const body = JSON.parse(calls[0].opts.body);
    expect(body.text).toContain('Failed');
    expect(body.text).not.toContain('Ready for human');
    expect(body.text).toContain('Error: Agent exited non-zero');
  });

  test('ready_for_human transition: Slack message says Ready for human', async () => {
    await outboxStore.enqueue({
      idempotencyKey: 'test-session:42:run-msg2:slack:notification',
      topic: 'slack:notification',
      payload: {
        ...SLACK_PAYLOAD,
        transition: 'ready_for_human',
        reason: 'Review passed',
      },
      now: NOW,
    });

    const calls = [];
    const mockFetch = async (url, opts) => {
      calls.push({ url, opts });
      return { ok: true, status: 200, text: async () => '' };
    };

    await dispatchOutbox(outboxStore, okGhRunner(), {
      cwd: '/tmp',
      fetchImpl: mockFetch,
      env: { TEST_SLACK_WEBHOOK: 'https://hooks.slack.com/fake' },
    });

    const body = JSON.parse(calls[0].opts.body);
    expect(body.text).toContain('Ready for human');
    expect(body.text).not.toContain('Failed');
    expect(body.text).toContain('Reason: Review passed');
  });
});
