/**
 * SqliteSessionControlStore (issue #531): runner-owned session pause state and
 * the per-run cost/result ledger, plus the recordRunAndEvaluate wiring that
 * pauses a session when the circuit breaker trips.
 */
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  SqliteSessionControlStore,
  SqliteTaskStore,
  recordRunAndEvaluate,
} from '../dist/index.js';

const NOW = '2026-07-28T10:00:00.000Z';

let tmpDir;
let dbPath;
let store;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'session-control-'));
  dbPath = join(tmpDir, 'dev_loop.db');
  store = new SqliteSessionControlStore(dbPath);
});

afterEach(() => {
  store.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function ledgerEntry(overrides = {}) {
  return {
    sessionId: 's',
    issueNumber: 7,
    phase: 'implementation',
    outcome: 'failed',
    createdAt: NOW,
    ...overrides,
  };
}

describe('pause state', () => {
  test('a session is unpaused by default', async () => {
    expect(await store.getPauseState('s')).toEqual({ paused: false });
  });

  test('pause round-trips reason/source/pausedBy and resume clears them', async () => {
    const paused = await store.pauseSession('s', {
      reason: 'quota window',
      pausedBy: 'operator',
      source: 'operator',
      now: NOW,
    });
    expect(paused).toEqual({
      changed: true,
      alreadyPaused: false,
      state: { paused: true, reason: 'quota window', pausedAt: NOW, pausedBy: 'operator', source: 'operator' },
    });

    expect(await store.getPauseState('s')).toEqual({
      paused: true,
      reason: 'quota window',
      pausedAt: NOW,
      pausedBy: 'operator',
      source: 'operator',
    });

    const resumed = await store.resumeSession('s', { now: '2026-07-28T11:00:00.000Z' });
    expect(resumed.changed).toBe(true);
    expect(resumed.previous.reason).toBe('quota window');
    expect(await store.getPauseState('s')).toEqual({ paused: false });
  });

  test('resume on an unpaused session is a safe no-op', async () => {
    expect(await store.resumeSession('s')).toEqual({ changed: false });
    // Pause/resume/resume-again: second resume is also a no-op.
    await store.pauseSession('s', { now: NOW });
    await store.resumeSession('s');
    expect(await store.resumeSession('s')).toEqual({ changed: false });
  });

  test('a repeated pause overwrites the stored reason (operator intent wins)', async () => {
    await store.pauseSession('s', { reason: 'first', source: 'circuit_breaker', pausedBy: 'circuit-breaker', now: NOW });
    const second = await store.pauseSession('s', {
      reason: 'second',
      source: 'operator',
      pausedBy: 'operator',
      now: '2026-07-28T12:00:00.000Z',
    });
    expect(second.alreadyPaused).toBe(true);
    expect(second.changed).toBe(true);
    const state = await store.getPauseState('s');
    expect(state.reason).toBe('second');
    expect(state.source).toBe('operator');
  });

  test('onlyIfUnpaused never clobbers an existing pause', async () => {
    await store.pauseSession('s', { reason: 'operator says stop', source: 'operator', now: NOW });
    const attempt = await store.pauseSession('s', {
      reason: 'circuit breaker',
      source: 'circuit_breaker',
      onlyIfUnpaused: true,
    });
    expect(attempt.changed).toBe(false);
    expect(attempt.alreadyPaused).toBe(true);
    expect(attempt.state.reason).toBe('operator says stop');
    expect((await store.getPauseState('s')).reason).toBe('operator says stop');
  });

  test('pause state is per-session', async () => {
    await store.pauseSession('a', { now: NOW });
    expect((await store.getPauseState('a')).paused).toBe(true);
    expect(await store.getPauseState('b')).toEqual({ paused: false });
  });

  test('shares the task-store DB file without clashing', async () => {
    // Same-file coexistence with the task store (the production layout).
    const tasks = new SqliteTaskStore(dbPath);
    try {
      await tasks.enqueueTask({ sessionId: 's', issueNumber: 1, phase: 'implementation', now: NOW });
      await store.pauseSession('s', { reason: 'r', now: NOW });
      expect((await store.getPauseState('s')).paused).toBe(true);
      expect((await tasks.getTask({ sessionId: 's', issueNumber: 1 })).status).toBe('queued');
    } finally {
      tasks.close();
    }
  });
});

describe('run ledger', () => {
  test('records entries and lists newest first with a limit', async () => {
    for (let i = 1; i <= 5; i++) {
      await store.recordRun(
        ledgerEntry({ issueNumber: i, outcome: i % 2 === 0 ? 'success' : 'failed', runId: `run-${i}` }),
      );
    }
    const recent = await store.listRecentRuns('s', 3);
    expect(recent.map((r) => r.issueNumber)).toEqual([5, 4, 3]);
    expect(recent[0].runId).toBe('run-5');
    expect(recent[0].outcome).toBe('failed');
  });

  test('recordRun returns the stored row with its assigned id', async () => {
    const first = await store.recordRun(ledgerEntry({ runId: 'run-1' }));
    const second = await store.recordRun(ledgerEntry({ runId: 'run-2' }));
    expect(first.runId).toBe('run-1');
    expect(second.id).toBeGreaterThan(first.id);
    expect(await store.listRecentRuns('s')).toEqual([second, first]);
  });

  test('maxId bounds both windows to rows at or before the anchor', async () => {
    const anchor = await store.recordRun(ledgerEntry({ runId: 'a' }));
    await store.recordRun(ledgerEntry({ runId: 'later', outcome: 'success' }));
    await store.recordRun(ledgerEntry({ issueNumber: 8, runId: 'later-other' }));

    const recent = await store.listRecentRuns('s', undefined, anchor.id);
    expect(recent.map((r) => r.runId)).toEqual(['a']);
    const issuePhase = await store.listRecentIssuePhaseRuns(
      's', 7, 'implementation', undefined, anchor.id,
    );
    expect(issuePhase.map((r) => r.runId)).toEqual(['a']);
  });

  test('round-trips full metadata and omits absent fields', async () => {
    await store.recordRun(
      ledgerEntry({
        runId: 'run-1',
        durationMs: 1234,
        agent: 'codex',
        model: 'gpt-5.2-codex',
        effort: 'high',
        costUsd: 0.42,
        inputTokens: 1000,
        outputTokens: 250,
      }),
    );
    await store.recordRun(ledgerEntry({ issueNumber: 8 }));

    const [minimal, full] = await store.listRecentRuns('s');
    expect(full).toMatchObject({
      sessionId: 's',
      issueNumber: 7,
      phase: 'implementation',
      outcome: 'failed',
      runId: 'run-1',
      durationMs: 1234,
      agent: 'codex',
      model: 'gpt-5.2-codex',
      effort: 'high',
      costUsd: 0.42,
      inputTokens: 1000,
      outputTokens: 250,
      createdAt: NOW,
    });
    expect(minimal.runId).toBeUndefined();
    expect(minimal.agent).toBeUndefined();
    expect(minimal.costUsd).toBeUndefined();
  });

  test('ledger is per-session', async () => {
    await store.recordRun(ledgerEntry({ sessionId: 'a' }));
    await store.recordRun(ledgerEntry({ sessionId: 'b' }));
    expect((await store.listRecentRuns('a')).length).toBe(1);
    expect((await store.listRecentRuns('b')).length).toBe(1);
  });

  test('listRecentIssuePhaseRuns returns only matching issue+phase rows, newest first, with a limit', async () => {
    await store.recordRun(ledgerEntry({ runId: 'a' }));
    await store.recordRun(ledgerEntry({ issueNumber: 8, runId: 'other-issue' }));
    await store.recordRun(ledgerEntry({ phase: 'review', runId: 'other-phase' }));
    await store.recordRun(ledgerEntry({ sessionId: 'other', runId: 'other-session' }));
    await store.recordRun(ledgerEntry({ runId: 'b', outcome: 'success' }));
    await store.recordRun(ledgerEntry({ runId: 'c' }));

    const rows = await store.listRecentIssuePhaseRuns('s', 7, 'implementation');
    expect(rows.map((r) => r.runId)).toEqual(['c', 'b', 'a']);
    const capped = await store.listRecentIssuePhaseRuns('s', 7, 'implementation', 2);
    expect(capped.map((r) => r.runId)).toEqual(['c', 'b']);
  });
});

describe('recordRunAndEvaluate', () => {
  const POLICY = { maxConsecutiveFailures: 5, maxIssuePhaseFailures: 3 };

  test('records without evaluating on a non-failure outcome', async () => {
    const result = await recordRunAndEvaluate(store, ledgerEntry({ outcome: 'success' }), POLICY);
    expect(result.tripped).toBe(false);
    expect(result.pausedNow).toBe(false);
    expect((await store.listRecentRuns('s')).length).toBe(1);
    expect(await store.getPauseState('s')).toEqual({ paused: false });
  });

  test('pauses the session when the same issue+phase fails N times', async () => {
    let last;
    for (let i = 0; i < 3; i++) {
      last = await recordRunAndEvaluate(store, ledgerEntry(), POLICY);
    }
    expect(last.tripped).toBe(true);
    expect(last.pausedNow).toBe(true);
    expect(last.decision.rule).toBe('issue_phase_failures');
    const state = await store.getPauseState('s');
    expect(state.paused).toBe(true);
    expect(state.source).toBe('circuit_breaker');
    expect(state.pausedBy).toBe('circuit-breaker');
    expect(state.reason).toContain('issue #7');
  });

  test('stays below threshold: two failures do not pause', async () => {
    await recordRunAndEvaluate(store, ledgerEntry(), POLICY);
    const second = await recordRunAndEvaluate(store, ledgerEntry(), POLICY);
    expect(second.tripped).toBe(false);
    expect(await store.getPauseState('s')).toEqual({ paused: false });
  });

  test('a threshold above the fixed eval window still trips (window grows to match)', async () => {
    // 51 consecutive session-wide failures with a threshold of 51: with a fixed
    // 50-row fetch the breaker could never reach the threshold; the fetch
    // window must grow to cover the configured value.
    const policy = { maxConsecutiveFailures: 51, maxIssuePhaseFailures: 0 };
    let last;
    for (let i = 0; i < 51; i++) {
      last = await recordRunAndEvaluate(store, ledgerEntry({ issueNumber: i }), policy);
    }
    expect(last.tripped).toBe(true);
    expect(last.pausedNow).toBe(true);
    expect(last.decision.rule).toBe('session_consecutive_failures');
    expect(last.decision.count).toBe(51);
    expect((await store.getPauseState('s')).paused).toBe(true);
  });

  test('an issue+phase streak separated by more than the session window still trips', async () => {
    // Review finding on issue #531: two failures for issue 7 implementation,
    // then 60 successful runs of OTHER issues (more than the 50-row
    // session-wide window), then a third failure for issue 7. The same-
    // issue+phase rule evaluates over a dedicated issue+phase query, so the
    // interleaved activity can neither reset the streak nor push it out of the
    // evaluated window.
    await recordRunAndEvaluate(store, ledgerEntry(), POLICY);
    await recordRunAndEvaluate(store, ledgerEntry(), POLICY);
    for (let i = 0; i < 60; i++) {
      await recordRunAndEvaluate(
        store,
        ledgerEntry({ issueNumber: 1000 + i, outcome: 'success' }),
        POLICY,
      );
    }
    const last = await recordRunAndEvaluate(store, ledgerEntry(), POLICY);
    expect(last.tripped).toBe(true);
    expect(last.pausedNow).toBe(true);
    expect(last.decision.rule).toBe('issue_phase_failures');
    expect(last.decision.count).toBe(3);
    expect((await store.getPauseState('s')).paused).toBe(true);
  });

  test('a success recorded concurrently after the failure cannot mask the trip', async () => {
    // Review finding on issue #531: with concurrent phases, another issue's
    // run can insert a ledger row between recordRunAndEvaluate's insert and
    // its window reads. The wrapper below lands a success for another issue
    // immediately after every recorded row, so the session-wide window's true
    // newest row is never the just-recorded failure. Anchoring the evaluation
    // at the recorded row's id must still trip the breaker on the Nth failure.
    const racing = {
      getPauseState: (...a) => store.getPauseState(...a),
      pauseSession: (...a) => store.pauseSession(...a),
      listRecentRuns: (...a) => store.listRecentRuns(...a),
      listRecentIssuePhaseRuns: (...a) => store.listRecentIssuePhaseRuns(...a),
      async recordRun(entry) {
        const recorded = await store.recordRun(entry);
        await store.recordRun(ledgerEntry({ issueNumber: 999, outcome: 'success' }));
        return recorded;
      },
    };
    let last;
    for (let i = 0; i < 3; i++) {
      last = await recordRunAndEvaluate(racing, ledgerEntry(), POLICY);
    }
    expect(last.tripped).toBe(true);
    expect(last.pausedNow).toBe(true);
    expect(last.decision.rule).toBe('issue_phase_failures');
    expect((await store.getPauseState('s')).paused).toBe(true);
  });

  test('a trip never overwrites an existing operator pause', async () => {
    await store.pauseSession('s', { reason: 'operator hold', source: 'operator', now: NOW });
    let last;
    for (let i = 0; i < 3; i++) {
      last = await recordRunAndEvaluate(store, ledgerEntry(), POLICY);
    }
    expect(last.tripped).toBe(true);
    expect(last.pausedNow).toBe(false);
    expect((await store.getPauseState('s')).reason).toBe('operator hold');
  });
});
