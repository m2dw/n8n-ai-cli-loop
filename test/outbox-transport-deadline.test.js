/**
 * Outbox transport deadlines (issue #1064).
 *
 * Covers:
 *  - the deadline policy itself: defaults, validation against the claim lease,
 *    the per-attempt budget, and the sanitized diagnostic;
 *  - a hung `gh` (both a real subprocess that respects SIGTERM and one that
 *    ignores it) finishing inside a configured bound and leaving nothing behind;
 *  - a hung Slack request and a hung Slack response BODY, cancelled through the
 *    abort signal and bounded even when a transport ignores it;
 *  - a later eligible row still being attempted after a timed-out row;
 *  - attempt accounting / backoff / dead-lettering being unchanged by a timeout;
 *  - an ambiguous (timed-out) write reconciling against its dedupe marker on the
 *    retry instead of being replayed, and a lost claim stopping the write;
 *  - a deadline ENDING the attempt rather than being handed to the provider as a
 *    result it can read as success (a `SIGTERM`-handling child exiting 0) or as a
 *    missing fact it can route around (the sticky-comment `/user` probe).
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SqliteOutboxStore } from '../dist/stores/sqlite-outbox-store.js';
import { dispatchOutbox, defaultGhRunner } from '../dist/handlers/gh-dispatcher.js';
import { GhTransportTimeoutError, boundedGhRunner } from '../dist/providers/github/gh-runner.js';
import {
  OUTBOX_ATTEMPT_DEADLINE_MS,
  OUTBOX_ATTEMPT_LEASE_MARGIN_MS,
  OUTBOX_TRANSPORT_TIMEOUT_PREFIX,
  describeOutboxTransportTimeout,
  isOutboxTransportTimeout,
  resolveOutboxTransportDeadlines,
  startOutboxAttemptBudget,
} from '../dist/core/outbox-transport-deadline.js';
import { OUTBOX_CLAIM_STALE_MS, OUTBOX_MAX_ATTEMPTS } from '../dist/core/outbox.js';

const CWD = '/tmp';

/** Deadlines small enough for a test but still internally consistent. */
const FAST = { attemptMs: 5_000, ghCallMs: 1_000, slackRequestMs: 200 };

const LABEL_ADD = {
  topic: 'gh:label:add',
  owner: 'org',
  repo: 'repo',
  issueNumber: 10,
  label: 'ai:active',
};

const MARKED_COMMENT = {
  topic: 'gh:comment',
  owner: 'org',
  repo: 'repo',
  issueNumber: 10,
  body: 'status update <!-- ai-marker:42 -->',
  dedupeMarker: '<!-- ai-marker:42 -->',
};

const SLACK = {
  topic: 'slack:notification',
  owner: 'org',
  repo: 'repo',
  webhookUrlEnv: 'SLACK_WEBHOOK_URL',
  sessionId: 'test-session',
  issueNumber: 10,
  phase: 'review',
  transition: 'ready_for_human',
};

const SLACK_ENV = { SLACK_WEBHOOK_URL: 'https://hooks.slack.test/services/T/B/X' };

let tmpDir;
let store;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'outbox-deadline-test-'));
  store = new SqliteOutboxStore(join(tmpDir, 'test.db'));
});

afterEach(() => {
  store.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

/** A gh runner that answers from a scripted list and records the argv it saw. */
function scriptedRunner(handler) {
  const calls = [];
  return {
    calls,
    run(args, opts) {
      calls.push(args);
      return handler(args, opts, calls.length - 1);
    },
  };
}

/** What the bounded runner reports for a call its deadline cut short. */
function timedOutResult(durationMs = 1_000) {
  return {
    exitCode: 1,
    stdout: '',
    stderr: 'Error: spawnSync gh ETIMEDOUT',
    timedOut: true,
    spawnErrorCode: 'ETIMEDOUT',
    durationMs,
    signal: 'SIGTERM',
  };
}

function okResult(stdout = '') {
  return { exitCode: 0, stdout, stderr: '' };
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

describe('resolveOutboxTransportDeadlines', () => {
  test('defaults leave the claim lease a margin to spare', () => {
    const resolved = resolveOutboxTransportDeadlines();
    expect(resolved.attemptMs).toBe(OUTBOX_ATTEMPT_DEADLINE_MS);
    expect(resolved.attemptMs).toBeLessThanOrEqual(
      OUTBOX_CLAIM_STALE_MS - OUTBOX_ATTEMPT_LEASE_MARGIN_MS,
    );
    expect(resolved.ghCallMs).toBeLessThanOrEqual(resolved.attemptMs);
    expect(resolved.slackRequestMs).toBeLessThanOrEqual(resolved.attemptMs);
  });

  test('rejects an attempt budget that would outlive the claim lease', () => {
    expect(() => resolveOutboxTransportDeadlines({ attemptMs: OUTBOX_CLAIM_STALE_MS })).toThrow(
      /claim lease/,
    );
  });

  test('rejects a per-call bound larger than the attempt budget', () => {
    expect(() =>
      resolveOutboxTransportDeadlines({ attemptMs: 10_000, ghCallMs: 20_000 }),
    ).toThrow(/exceeds the attempt budget/);
  });

  test('rejects non-positive and non-finite bounds', () => {
    expect(() => resolveOutboxTransportDeadlines({ slackRequestMs: 0 })).toThrow(/positive/);
    expect(() => resolveOutboxTransportDeadlines({ ghCallMs: Number.POSITIVE_INFINITY })).toThrow(
      /positive/,
    );
  });
});

describe('startOutboxAttemptBudget', () => {
  test('clamps a per-call bound to what is left of the attempt', () => {
    let nowMs = 1_000;
    const budget = startOutboxAttemptBudget(10_000, () => nowMs);
    expect(budget.callTimeoutMs(4_000)).toBe(4_000);
    nowMs += 7_000;
    expect(budget.callTimeoutMs(4_000)).toBe(3_000);
    nowMs += 5_000;
    expect(budget.callTimeoutMs(4_000)).toBe(0);
    expect(budget.expired()).toBe(true);
  });
});

describe('describeOutboxTransportTimeout', () => {
  test('is prefixed, fact-built and sanitized', () => {
    const message = describeOutboxTransportTimeout({
      transport: 'gh',
      stage: 'request',
      limitMs: 1_000,
      attemptMs: 5_000,
      elapsedMs: 1_004,
      escalated: true,
      processGroupTerminated: true,
      outcomeUnknown: true,
      detail: `failed under /Users/someone/secrets with ghp_${'a'.repeat(30)}`,
    });
    expect(message.startsWith(OUTBOX_TRANSPORT_TIMEOUT_PREFIX)).toBe(true);
    expect(isOutboxTransportTimeout(message)).toBe(true);
    expect(message).toContain('bounded at 1000ms');
    expect(message).toContain('attempt budget 5000ms');
    expect(message).toContain('child force-killed');
    expect(message).toContain('remote outcome unknown');
    expect(message).not.toContain('/Users/someone');
    expect(message).not.toContain('ghp_');
  });

  test('says so explicitly when nothing external was in flight', () => {
    const message = describeOutboxTransportTimeout({
      transport: 'gh',
      stage: 'attempt-budget',
      limitMs: 5_000,
      attemptMs: 5_000,
      outcomeUnknown: false,
    });
    expect(message).toContain('no external side effect was left in doubt');
    expect(message).not.toContain('remote outcome unknown');
  });
});

describe('dispatchOutbox — deadline configuration', () => {
  test('refuses an unusable configuration before claiming any row', async () => {
    await store.enqueue({ idempotencyKey: 'k1', topic: 'gh:label:add', payload: LABEL_ADD });
    const runner = scriptedRunner(() => okResult());
    await expect(
      dispatchOutbox(store, runner, { cwd: CWD, deadlines: { attemptMs: OUTBOX_CLAIM_STALE_MS } }),
    ).rejects.toThrow(/claim lease/);
    expect(runner.calls).toHaveLength(0);
    const row = await store.getById(1);
    expect(row.sentAt).toBeUndefined();
    expect(row.claimedAt).toBeUndefined();
    expect(row.attemptCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// gh transport
// ---------------------------------------------------------------------------

describe('dispatchOutbox — bounded gh transport', () => {
  test('records a sanitized timeout and still attempts the next eligible row', async () => {
    await store.enqueue({ idempotencyKey: 'k1', topic: 'gh:label:add', payload: LABEL_ADD });
    await store.enqueue({
      idempotencyKey: 'k2',
      topic: 'gh:label:remove',
      payload: { ...LABEL_ADD, topic: 'gh:label:remove', label: 'ai:blocked' },
    });
    const runner = scriptedRunner((_args, _opts, index) =>
      index === 0 ? timedOutResult() : okResult(),
    );

    const result = await dispatchOutbox(store, runner, { cwd: CWD, deadlines: FAST });

    expect(result.failed).toBe(1);
    expect(result.transportTimeouts).toBe(1);
    // The row behind the hung one was attempted in the same run.
    expect(result.dispatched).toBe(1);
    const [hung, behind] = await Promise.all([store.getById(1), store.getById(2)]);
    expect(behind.sentAt).toBeDefined();
    expect(isOutboxTransportTimeout(hung.lastError)).toBe(true);
    expect(hung.lastError).toContain('remote outcome unknown');
    // Ordinary attempt accounting: one failure, backoff scheduled, not dead.
    expect(hung.attemptCount).toBe(1);
    expect(hung.nextAttemptAt).toBeDefined();
    expect(hung.deadLetterAt).toBeUndefined();
    // The claim is released, so the row is retryable rather than stuck in flight.
    expect(hung.claimedAt).toBeUndefined();
  });

  test('a per-call deadline the runner enforces is passed down, once per call', async () => {
    await store.enqueue({ idempotencyKey: 'k1', topic: 'gh:label:add', payload: LABEL_ADD });
    const seen = [];
    const runner = {
      run(_args, opts) {
        seen.push(opts.timeout);
        return okResult();
      },
    };
    await dispatchOutbox(store, runner, { cwd: CWD, deadlines: FAST });
    expect(seen).toEqual([FAST.ghCallMs]);
  });

  test('repeated timeouts dead-letter the row on the existing budget', async () => {
    await store.enqueue({ idempotencyKey: 'k1', topic: 'gh:label:add', payload: LABEL_ADD });
    const runner = scriptedRunner(() => timedOutResult());
    let lastResult;
    for (let attempt = 1; attempt <= OUTBOX_MAX_ATTEMPTS; attempt++) {
      // `retryEntry` would reset the counter, so make the row due instead by
      // moving the dispatcher's clock past its backoff.
      const now = new Date(Date.parse('2026-09-06T00:00:00.000Z') + attempt * 86_400_000).toISOString();
      lastResult = await dispatchOutbox(store, runner, { cwd: CWD, now, deadlines: FAST });
      expect(lastResult.transportTimeouts).toBe(1);
    }
    const row = await store.getById(1);
    expect(row.attemptCount).toBe(OUTBOX_MAX_ATTEMPTS);
    expect(row.deadLetterAt).toBeDefined();
    expect(lastResult.deadLettered).toBe(1);
    expect(isOutboxTransportTimeout(row.lastError)).toBe(true);
  });

  test('refuses a call once the attempt budget is spent, without issuing it', async () => {
    await store.enqueue({ idempotencyKey: 'k1', topic: 'gh:comment', payload: MARKED_COMMENT });
    // A full page keeps the dedupe-marker scan paginating; each page burns 40s
    // of the 100s attempt budget on this fake clock.
    const fullPage = JSON.stringify(Array.from({ length: 100 }, () => ({ body: 'unrelated' })));
    let nowMs = 1_000_000;
    const runner = scriptedRunner(() => {
      nowMs += 40_000;
      return okResult(fullPage);
    });

    const result = await dispatchOutbox(store, runner, {
      cwd: CWD,
      monotonicNow: () => nowMs,
      deadlines: { attemptMs: 100_000, ghCallMs: 60_000, slackRequestMs: 10_000 },
    });

    expect(result.failed).toBe(1);
    expect(result.transportTimeouts).toBe(1);
    // Three pages fit in the budget; the fourth call is refused rather than
    // issued, and the POST it guards is never reached.
    expect(runner.calls).toHaveLength(3);
    expect(runner.calls.every((args) => !args.includes('POST'))).toBe(true);
    const row = await store.getById(1);
    expect(row.lastError).toContain('attempt-budget');
    expect(row.lastError).toContain('no external side effect was left in doubt');
  });
});

// ---------------------------------------------------------------------------
// A deadline ends the attempt — it is never an answer (P2 review follow-up)
// ---------------------------------------------------------------------------

describe('boundedGhRunner — a deadline is raised, not returned', () => {
  /** A budget with room to spare, so only the per-call bound is in play. */
  function budgetAt(nowMs) {
    return startOutboxAttemptBudget(60_000, () => nowMs);
  }

  test('a timed-out call throws typed facts instead of returning a result', () => {
    const timeouts = [];
    const inner = scriptedRunner(() => timedOutResult(1_000));
    const bounded = boundedGhRunner(inner, {
      perCallMs: 1_000,
      budget: budgetAt(1_000_000),
      onTimeout: (t) => timeouts.push(t),
    });

    let raised;
    try {
      bounded.run(['api', '/user'], { cwd: CWD });
    } catch (err) {
      raised = err;
    }
    expect(raised).toBeInstanceOf(GhTransportTimeoutError);
    expect(raised.timeout.stage).toBe('request');
    expect(raised.timeout.limitMs).toBe(1_000);
    // The message is fact-built: no child stderr rides along on it.
    expect(raised.message).not.toContain('ETIMEDOUT');
    expect(timeouts).toHaveLength(1);
  });

  test('an exit-0 timeout is a timeout: the exit code is not consulted', () => {
    // A `gh` that handles SIGTERM by exiting cleanly. Returning this would read
    // as a successful call at every `exitCode !== 0` check in every provider.
    const inner = scriptedRunner(() => ({ ...timedOutResult(1_000), exitCode: 0 }));
    const bounded = boundedGhRunner(inner, {
      perCallMs: 1_000,
      budget: budgetAt(1_000_000),
      onTimeout: () => {},
    });
    expect(() => bounded.run(['api', '/user'], { cwd: CWD })).toThrow(GhTransportTimeoutError);
  });

  test('stays latched, so a provider that swallows the throw cannot write', () => {
    const timeouts = [];
    const inner = scriptedRunner((_args, _opts, index) =>
      index === 0 ? timedOutResult(1_000) : okResult('{}'),
    );
    const bounded = boundedGhRunner(inner, {
      perCallMs: 1_000,
      budget: budgetAt(1_000_000),
      onTimeout: (t) => timeouts.push(t),
    });

    try {
      bounded.run(['api', '/user'], { cwd: CWD });
    } catch {
      // Exactly what a provider's fallback path does with it.
    }
    expect(() => bounded.run(['pr', 'comment', '7'], { cwd: CWD })).toThrow(
      GhTransportTimeoutError,
    );
    // The fallback write never reached the transport, and the one hang is still
    // reported once rather than as a pile of unwinding diagnostics.
    expect(inner.calls).toHaveLength(1);
    expect(timeouts).toHaveLength(1);
  });

  test('a spent attempt budget throws without issuing the call', () => {
    const timeouts = [];
    const inner = scriptedRunner(() => okResult());
    let nowMs = 1_000_000;
    const budget = startOutboxAttemptBudget(5_000, () => nowMs);
    nowMs += 6_000;
    const bounded = boundedGhRunner(inner, {
      perCallMs: 1_000,
      budget,
      onTimeout: (t) => timeouts.push(t),
    });

    expect(() => bounded.run(['api', '/user'], { cwd: CWD })).toThrow(GhTransportTimeoutError);
    expect(inner.calls).toHaveLength(0);
    expect(timeouts).toEqual([{ stage: 'attempt-budget', limitMs: 5_000 }]);
  });
});

describe('dispatchOutbox — a timeout is never consumed as an answer', () => {
  test('a child that exits 0 on the deadline signal does not mark the row sent', async () => {
    await store.enqueue({ idempotencyKey: 'k1', topic: 'gh:label:add', payload: LABEL_ADD });
    const runner = scriptedRunner(() => ({ ...timedOutResult(), exitCode: 0 }));

    const result = await dispatchOutbox(store, runner, { cwd: CWD, deadlines: FAST });

    expect(result.dispatched).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.transportTimeouts).toBe(1);
    const row = await store.getById(1);
    expect(row.sentAt).toBeUndefined();
    expect(isOutboxTransportTimeout(row.lastError)).toBe(true);
    // Ordinary attempt accounting, and the claim released for the retry.
    expect(row.attemptCount).toBe(1);
    expect(row.claimedAt).toBeUndefined();
  });

  test('a timed-out identity probe does not fall through to a duplicate sticky comment', async () => {
    await store.enqueue({
      idempotencyKey: 'k1',
      topic: 'repohost:pr-summary',
      payload: {
        topic: 'repohost:pr-summary',
        provider: 'github',
        owner: 'org',
        repo: 'repo',
        prNumber: 7,
        marker: '<!-- summary -->',
        body: 'latest',
      },
    });
    // Only the `/user` probe hangs. Everything after it would succeed — which is
    // the point: an unresolved identity makes the existing user-owned sticky
    // comment invisible to the scan, and the provider creates a second one.
    const existing = JSON.stringify([
      { id: 1, body: 'previous <!-- summary -->', user: { login: 'ai-bot', type: 'User' } },
    ]);
    const runner = scriptedRunner((args) => (args[1] === '/user' ? timedOutResult() : okResult(existing)));

    const result = await dispatchOutbox(store, runner, { cwd: CWD, deadlines: FAST });

    expect(result.failed).toBe(1);
    expect(result.transportTimeouts).toBe(1);
    // The attempt stopped at the probe: no comment list, and above all no create.
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]).toEqual(['api', '/user']);
    const row = await store.getById(1);
    expect(row.sentAt).toBeUndefined();
    expect(isOutboxTransportTimeout(row.lastError)).toBe(true);
    expect(row.lastError).toContain('remote outcome unknown');
  });

  test('a provider that reports success after swallowing a timeout still fails the row', async () => {
    await store.enqueue({
      idempotencyKey: 'k1',
      topic: 'workitem:transition',
      payload: {
        topic: 'workitem:transition',
        provider: 'github-issues',
        owner: 'org',
        repo: 'repo',
        issueNumber: 10,
        transition: { kind: 'add-label', label: 'ai:active' },
      },
    });
    const runner = scriptedRunner(() => timedOutResult());
    // A provider that catches the deadline and claims the transition landed.
    // `sent` is the one outcome nothing walks back, so the dispatcher fails
    // closed on the recorded timeout rather than on the provider's word.
    const providers = {
      workItem: (_provider, _repo, cwd, entryRunner) => ({
        transitionItem() {
          try {
            entryRunner.run(['api', 'repos/org/repo/issues/10/labels'], { cwd });
          } catch {
            // Swallowed, exactly as a fallback path would.
          }
          return { ok: true };
        },
      }),
      repoHost: () => undefined,
    };

    const result = await dispatchOutbox(store, runner, { cwd: CWD, providers, deadlines: FAST });

    expect(result.dispatched).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.transportTimeouts).toBe(1);
    const row = await store.getById(1);
    expect(row.sentAt).toBeUndefined();
    expect(isOutboxTransportTimeout(row.lastError)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// gh transport — real subprocesses
// ---------------------------------------------------------------------------

describe('dispatchOutbox — hung gh subprocess', () => {
  let binDir;
  let pidFile;
  let previousPath;

  /**
   * Put a stub `gh` on PATH. `body` is the shell it runs after recording its own
   * pid, so the test can check afterwards whether it is still around.
   *
   * The child is spawned with `spawnEnv()` — the module's own `process.env` —
   * which is why setting `process.env.PATH` from inside the sandbox reaches it.
   */
  function installStubGh(body) {
    binDir = join(tmpDir, 'bin');
    pidFile = join(tmpDir, 'gh.pid');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      join(binDir, 'gh'),
      `#!/bin/sh\nprintf %s "$$" > ${JSON.stringify(pidFile)}\n${body}\n`,
    );
    chmodSync(join(binDir, 'gh'), 0o755);
    previousPath = process.env.PATH;
    process.env.PATH = `${binDir}:${previousPath ?? ''}`;
  }

  afterEach(() => {
    if (previousPath !== undefined) process.env.PATH = previousPath;
    previousPath = undefined;
  });

  /** Whether a pid the stub recorded is still around. */
  function stubStillRunning() {
    if (!existsSync(pidFile)) return false;
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    if (!Number.isInteger(pid) || pid <= 1) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      // EPERM means it exists but is not ours to signal — still running.
      return err.code === 'EPERM';
    }
  }

  test('a child that honours the deadline signal is killed and the row fails', async () => {
    installStubGh('sleep 30');
    await store.enqueue({ idempotencyKey: 'k1', topic: 'gh:label:add', payload: LABEL_ADD });

    const startedAt = Date.now();
    const result = await dispatchOutbox(store, defaultGhRunner, {
      cwd: tmpDir,
      deadlines: { attemptMs: 20_000, ghCallMs: 1_000, slackRequestMs: 1_000 },
    });
    const elapsedMs = Date.now() - startedAt;

    expect(result.failed).toBe(1);
    expect(result.transportTimeouts).toBe(1);
    expect(elapsedMs).toBeLessThan(15_000);
    const row = await store.getById(1);
    expect(isOutboxTransportTimeout(row.lastError)).toBe(true);
    // Nothing left behind: no live child, and no claim anyone would keep renewing.
    expect(stubStillRunning()).toBe(false);
    expect(row.claimedAt).toBeUndefined();
  }, 30_000);

  test('a child that ignores the deadline signal is force-killed', async () => {
    installStubGh('trap "" TERM\nsleep 30');
    await store.enqueue({ idempotencyKey: 'k1', topic: 'gh:label:add', payload: LABEL_ADD });

    const startedAt = Date.now();
    const result = await dispatchOutbox(store, defaultGhRunner, {
      cwd: tmpDir,
      deadlines: { attemptMs: 20_000, ghCallMs: 1_000, slackRequestMs: 1_000 },
    });
    const elapsedMs = Date.now() - startedAt;

    expect(result.failed).toBe(1);
    expect(result.transportTimeouts).toBe(1);
    // The deadline plus the escalation grace, not the child's own 30s sleep.
    expect(elapsedMs).toBeLessThan(20_000);
    const row = await store.getById(1);
    expect(isOutboxTransportTimeout(row.lastError)).toBe(true);
    expect(stubStillRunning()).toBe(false);
    expect(row.claimedAt).toBeUndefined();
  }, 40_000);
});

// ---------------------------------------------------------------------------
// Slack transport
// ---------------------------------------------------------------------------

describe('dispatchOutbox — bounded Slack transport', () => {
  test('cancels a hung request through the abort signal and continues', async () => {
    await store.enqueue({ idempotencyKey: 'k1', topic: 'slack:notification', payload: SLACK });
    await store.enqueue({ idempotencyKey: 'k2', topic: 'gh:label:add', payload: LABEL_ADD });
    let aborted = false;
    const fetchImpl = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          aborted = true;
          reject(new Error('The operation was aborted'));
        });
      });
    const runner = scriptedRunner(() => okResult());

    const startedAt = Date.now();
    const result = await dispatchOutbox(store, runner, {
      cwd: CWD,
      env: SLACK_ENV,
      fetchImpl,
      deadlines: FAST,
    });
    const elapsedMs = Date.now() - startedAt;

    expect(aborted).toBe(true);
    expect(elapsedMs).toBeLessThan(4_000);
    expect(result.failed).toBe(1);
    expect(result.transportTimeouts).toBe(1);
    expect(result.dispatched).toBe(1);
    const slackRow = await store.getById(1);
    expect(isOutboxTransportTimeout(slackRow.lastError)).toBe(true);
    // Slack offers no delivery idempotency, so the retry is not a safe replay.
    expect(slackRow.lastError).toContain('remote outcome unknown');
    expect(slackRow.attemptCount).toBe(1);
    expect(slackRow.nextAttemptAt).toBeDefined();
  });

  test('bounds a transport that ignores the abort signal', async () => {
    await store.enqueue({ idempotencyKey: 'k1', topic: 'slack:notification', payload: SLACK });
    const fetchImpl = () => new Promise(() => {});

    const startedAt = Date.now();
    const result = await dispatchOutbox(store, scriptedRunner(() => okResult()), {
      cwd: CWD,
      env: SLACK_ENV,
      fetchImpl,
      deadlines: FAST,
    });

    expect(Date.now() - startedAt).toBeLessThan(4_000);
    expect(result.failed).toBe(1);
    expect(result.transportTimeouts).toBe(1);
  });

  test('bounds the response body read, not just the request', async () => {
    await store.enqueue({ idempotencyKey: 'k1', topic: 'slack:notification', payload: SLACK });
    let bodyAborted = false;
    const fetchImpl = async (_url, init) => ({
      ok: false,
      status: 500,
      text: () =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            bodyAborted = true;
            reject(new Error('The operation was aborted'));
          });
        }),
    });

    const startedAt = Date.now();
    const result = await dispatchOutbox(store, scriptedRunner(() => okResult()), {
      cwd: CWD,
      env: SLACK_ENV,
      fetchImpl,
      deadlines: FAST,
    });

    expect(bodyAborted).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(4_000);
    expect(result.failed).toBe(1);
    expect(result.transportTimeouts).toBe(1);
    const row = await store.getById(1);
    expect(isOutboxTransportTimeout(row.lastError)).toBe(true);
    // Slack answered — only the trailing body read was cut off, so the delivery
    // outcome is not in doubt, and the status it answered with is preserved.
    expect(row.lastError).toContain('no external side effect was left in doubt');
    expect(row.lastError).toContain('HTTP 500');
  });

  test('an unaffected Slack delivery still succeeds', async () => {
    await store.enqueue({ idempotencyKey: 'k1', topic: 'slack:notification', payload: SLACK });
    const fetchImpl = async () => ({ ok: true, status: 200, text: async () => '' });
    const result = await dispatchOutbox(store, scriptedRunner(() => okResult()), {
      cwd: CWD,
      env: SLACK_ENV,
      fetchImpl,
      deadlines: FAST,
    });
    expect(result.dispatched).toBe(1);
    expect(result.transportTimeouts).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Ambiguous writes
// ---------------------------------------------------------------------------

describe('dispatchOutbox — an ambiguous write is reconciled, not replayed', () => {
  test('a timed-out POST is settled by its dedupe marker on the retry', async () => {
    await store.enqueue({ idempotencyKey: 'k1', topic: 'gh:comment', payload: MARKED_COMMENT });
    let posted = 0;
    let markerVisible = false;
    const runner = scriptedRunner((args) => {
      if (args.includes('POST')) {
        posted += 1;
        // The write reached GitHub and was applied; only the response never
        // came back, which is exactly what makes the outcome unknown.
        markerVisible = true;
        return timedOutResult();
      }
      return okResult(
        JSON.stringify(markerVisible ? [{ body: `landed ${MARKED_COMMENT.dedupeMarker}` }] : []),
      );
    });

    const first = await dispatchOutbox(store, runner, { cwd: CWD, deadlines: FAST });
    expect(first.failed).toBe(1);
    expect(first.transportTimeouts).toBe(1);
    expect(posted).toBe(1);

    // Later, once the backoff has elapsed, the row is eligible again.
    const later = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
    const second = await dispatchOutbox(store, runner, { cwd: CWD, now: later, deadlines: FAST });

    expect(second.dispatched).toBe(1);
    // The marker read settled the row; the ambiguous write was NOT repeated.
    expect(posted).toBe(1);
    const row = await store.getById(1);
    expect(row.sentAt).toBeDefined();
  });

  test('a lost claim stops the write instead of duplicating it', async () => {
    await store.enqueue({ idempotencyKey: 'k1', topic: 'gh:comment', payload: MARKED_COMMENT });
    const runner = scriptedRunner((args) => {
      if (args.includes('POST')) throw new Error('the POST must never be reached');
      return okResult('[]');
    });
    // The row's claim is taken over by another dispatcher between the marker
    // read and the POST it guards: every renewal this attempt tries now loses
    // its compare-and-swap.
    const claimLostStore = {
      isMaintenanceLocked: () => store.isMaintenanceLocked(),
      listPendingEntries: (o) => store.listPendingEntries(o),
      getById: (id) => store.getById(id),
      claimForDispatch: (id, now) => store.claimForDispatch(id, now),
      markSent: (id, sentAt, token) => store.markSent(id, sentAt, token),
      markFailed: (id, error, now, token) => store.markFailed(id, error, now, token),
      getScanCursor: (key) => store.getScanCursor(key),
      setScanCursor: (key, id, fence) => store.setScanCursor(key, id, fence),
      renewClaim: async () => undefined,
    };

    const result = await dispatchOutbox(claimLostStore, runner, { cwd: CWD, deadlines: FAST });

    expect(result.dispatched).toBe(0);
    expect(result.failed).toBe(1);
    expect(runner.calls).toHaveLength(1);
    expect(result.errors[0].error).toContain('outbox claim lost');
  });
});
