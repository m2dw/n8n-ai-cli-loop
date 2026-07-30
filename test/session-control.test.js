/**
 * Session-control pure logic (issue #531): circuit-breaker policy resolution,
 * consecutive-failure counting, trip evaluation, and handler-context metadata
 * extraction.
 */
import {
  circuitBreakerEvalWindow,
  countConsecutiveFailures,
  evaluateCircuitBreaker,
  extractRunMetadata,
  fetchCircuitBreakerWindows,
  isFailureOutcome,
  resolveCircuitBreakerPolicy,
  CIRCUIT_BREAKER_EVAL_WINDOW,
  DEFAULT_MAX_CONSECUTIVE_FAILURES,
  DEFAULT_MAX_ISSUE_PHASE_FAILURES,
} from '../dist/index.js';

// Newest-first ledger entries, matching listRecentRuns ordering.
function entry(overrides = {}) {
  return {
    id: 1,
    sessionId: 's',
    issueNumber: 7,
    phase: 'implementation',
    outcome: 'failed',
    createdAt: '2026-07-28T00:00:00.000Z',
    ...overrides,
  };
}

function failures(n, overrides = {}) {
  return Array.from({ length: n }, (_, i) => entry({ id: 100 - i, ...overrides }));
}

const POLICY = { maxConsecutiveFailures: 5, maxIssuePhaseFailures: 3 };

describe('resolveCircuitBreakerPolicy', () => {
  test('defaults when env is empty', () => {
    expect(resolveCircuitBreakerPolicy({})).toEqual({
      maxConsecutiveFailures: DEFAULT_MAX_CONSECUTIVE_FAILURES,
      maxIssuePhaseFailures: DEFAULT_MAX_ISSUE_PHASE_FAILURES,
    });
  });

  test('reads explicit thresholds from env', () => {
    expect(
      resolveCircuitBreakerPolicy({
        CIRCUIT_BREAKER_SESSION_FAILURES: '7',
        CIRCUIT_BREAKER_ISSUE_PHASE_FAILURES: '2',
      }),
    ).toEqual({ maxConsecutiveFailures: 7, maxIssuePhaseFailures: 2 });
  });

  test('0 is a valid explicit disable', () => {
    const policy = resolveCircuitBreakerPolicy({
      CIRCUIT_BREAKER_SESSION_FAILURES: '0',
      CIRCUIT_BREAKER_ISSUE_PHASE_FAILURES: '0',
    });
    expect(policy).toEqual({ maxConsecutiveFailures: 0, maxIssuePhaseFailures: 0 });
  });

  test('invalid values fall back to defaults (a typo never disables the breaker)', () => {
    expect(
      resolveCircuitBreakerPolicy({
        CIRCUIT_BREAKER_SESSION_FAILURES: 'nope',
        CIRCUIT_BREAKER_ISSUE_PHASE_FAILURES: '-3',
      }),
    ).toEqual({
      maxConsecutiveFailures: DEFAULT_MAX_CONSECUTIVE_FAILURES,
      maxIssuePhaseFailures: DEFAULT_MAX_ISSUE_PHASE_FAILURES,
    });
    expect(resolveCircuitBreakerPolicy({ CIRCUIT_BREAKER_SESSION_FAILURES: '2.5' }))
      .toEqual({
        maxConsecutiveFailures: DEFAULT_MAX_CONSECUTIVE_FAILURES,
        maxIssuePhaseFailures: DEFAULT_MAX_ISSUE_PHASE_FAILURES,
      });
  });
});

describe('circuitBreakerEvalWindow', () => {
  test('uses the fixed window when thresholds fit inside it', () => {
    expect(circuitBreakerEvalWindow({ maxConsecutiveFailures: 5, maxIssuePhaseFailures: 3 }))
      .toBe(CIRCUIT_BREAKER_EVAL_WINDOW);
    expect(circuitBreakerEvalWindow({ maxConsecutiveFailures: 0, maxIssuePhaseFailures: 0 }))
      .toBe(CIRCUIT_BREAKER_EVAL_WINDOW);
  });

  test('grows to cover a threshold above the fixed window (either rule)', () => {
    expect(circuitBreakerEvalWindow({ maxConsecutiveFailures: 51, maxIssuePhaseFailures: 3 }))
      .toBe(51);
    expect(circuitBreakerEvalWindow({ maxConsecutiveFailures: 5, maxIssuePhaseFailures: 80 }))
      .toBe(80);
  });
});

describe('countConsecutiveFailures / isFailureOutcome', () => {
  test('only failed counts as a failure outcome', () => {
    expect(isFailureOutcome('failed')).toBe(true);
    for (const outcome of ['success', 'needs_fix', 'conflict', 'blocked', 'tool_request', 'delayed']) {
      expect(isFailureOutcome(outcome)).toBe(false);
    }
  });

  test('counts from the newest entry and stops at the first non-failure', () => {
    expect(countConsecutiveFailures([])).toBe(0);
    expect(countConsecutiveFailures(failures(3))).toBe(3);
    expect(
      countConsecutiveFailures([
        entry(),
        entry({ outcome: 'success' }),
        entry(),
        entry(),
      ]),
    ).toBe(1);
    // A quota delay between failures also ends the streak.
    expect(
      countConsecutiveFailures([entry(), entry({ outcome: 'delayed' }), entry()]),
    ).toBe(1);
  });
});

describe('evaluateCircuitBreaker', () => {
  test('no trip on an empty ledger or when the newest run did not fail', () => {
    expect(evaluateCircuitBreaker([], POLICY)).toEqual({ trip: false });
    // 5 old failures followed by a success: the breaker only fires on a
    // failing run, never re-trips on a later success.
    expect(
      evaluateCircuitBreaker([entry({ outcome: 'success' }), ...failures(5)], POLICY),
    ).toEqual({ trip: false });
  });

  test('trips on N consecutive session-wide failures', () => {
    const decision = evaluateCircuitBreaker(failures(5), POLICY);
    expect(decision.trip).toBe(true);
    expect(decision.rule).toBe('session_consecutive_failures');
    expect(decision.count).toBe(5);
    expect(decision.threshold).toBe(5);
    expect(decision.reason).toContain('5 consecutive failed run(s)');
  });

  test('does not trip below the session threshold when issues differ', () => {
    // 4 failures across different issues: below session threshold (5), and no
    // single issue+phase reaches 3.
    const runs = [
      entry({ issueNumber: 1 }),
      entry({ issueNumber: 2 }),
      entry({ issueNumber: 3 }),
      entry({ issueNumber: 4 }),
    ];
    expect(evaluateCircuitBreaker(runs, POLICY)).toEqual({ trip: false });
  });

  test('trips on N consecutive failures for the SAME issue+phase, across interleaved runs', () => {
    // Issue 7 fails 3x with successful runs of other issues interleaved — the
    // interleaved successes neither reset nor count toward the streak.
    const runs = [
      entry({ issueNumber: 7 }),
      entry({ issueNumber: 8, outcome: 'success' }),
      entry({ issueNumber: 7 }),
      entry({ issueNumber: 9, outcome: 'success' }),
      entry({ issueNumber: 7 }),
    ];
    const decision = evaluateCircuitBreaker(runs, POLICY);
    expect(decision.trip).toBe(true);
    expect(decision.rule).toBe('issue_phase_failures');
    expect(decision.count).toBe(3);
    expect(decision.reason).toContain('issue #7');
  });

  test('a success for the same issue+phase resets that streak', () => {
    const runs = [
      entry({ issueNumber: 7 }),
      entry({ issueNumber: 7 }),
      entry({ issueNumber: 7, outcome: 'success' }),
      entry({ issueNumber: 7 }),
      entry({ issueNumber: 7 }),
    ];
    expect(evaluateCircuitBreaker(runs, POLICY)).toEqual({ trip: false });
  });

  test('a different phase for the same issue is a separate streak', () => {
    const runs = [
      entry({ issueNumber: 7, phase: 'review' }),
      entry({ issueNumber: 7, phase: 'implementation' }),
      entry({ issueNumber: 7, phase: 'review' }),
      entry({ issueNumber: 7, phase: 'implementation' }),
    ];
    expect(evaluateCircuitBreaker(runs, POLICY)).toEqual({ trip: false });
  });

  test('a dedicated issue+phase window trips even when the session window no longer holds the streak', () => {
    // Review finding on issue #531: the session-wide window has been capped so
    // it retains only the newest failure for issue 7 plus interleaved runs of
    // other issues; the older issue-7 failures fell off. The dedicated
    // issue+phase window (from listRecentIssuePhaseRuns) still holds the full
    // streak and must drive the rule.
    const recentRuns = [
      entry({ issueNumber: 7 }),
      ...Array.from({ length: 10 }, (_, i) => entry({ issueNumber: 100 + i, outcome: 'success' })),
    ];
    const issuePhaseRuns = [entry({ issueNumber: 7 }), entry({ issueNumber: 7 }), entry({ issueNumber: 7 })];
    // Without the dedicated window the filter fallback sees a single failure.
    expect(evaluateCircuitBreaker(recentRuns, POLICY)).toEqual({ trip: false });
    const decision = evaluateCircuitBreaker(recentRuns, POLICY, issuePhaseRuns);
    expect(decision.trip).toBe(true);
    expect(decision.rule).toBe('issue_phase_failures');
    expect(decision.count).toBe(3);
  });

  test('0 thresholds disable each rule independently', () => {
    expect(
      evaluateCircuitBreaker(failures(10), { maxConsecutiveFailures: 0, maxIssuePhaseFailures: 0 }),
    ).toEqual({ trip: false });
    // Session rule disabled, issue+phase rule still trips.
    const decision = evaluateCircuitBreaker(failures(10), {
      maxConsecutiveFailures: 0,
      maxIssuePhaseFailures: 3,
    });
    expect(decision.trip).toBe(true);
    expect(decision.rule).toBe('issue_phase_failures');
  });
});

describe('fetchCircuitBreakerWindows', () => {
  function fakeControl({ recent, issuePhase }) {
    const calls = [];
    return {
      calls,
      async listRecentRuns(sessionId, limit, maxId) {
        calls.push(['listRecentRuns', sessionId, limit, maxId]);
        return recent;
      },
      async listRecentIssuePhaseRuns(sessionId, issueNumber, phase, limit, maxId) {
        calls.push(['listRecentIssuePhaseRuns', sessionId, issueNumber, phase, limit, maxId]);
        return issuePhase;
      },
    };
  }

  test('fetches a dedicated window for the newest entry\'s issue+phase, sized to the threshold', async () => {
    const recent = [entry({ issueNumber: 7, phase: 'review' })];
    const issuePhase = [entry({ issueNumber: 7, phase: 'review' })];
    const control = fakeControl({ recent, issuePhase });
    const windows = await fetchCircuitBreakerWindows(control, 's', POLICY);
    expect(windows).toEqual({ recent, issuePhaseRuns: issuePhase });
    expect(control.calls).toEqual([
      ['listRecentRuns', 's', CIRCUIT_BREAKER_EVAL_WINDOW, undefined],
      ['listRecentIssuePhaseRuns', 's', 7, 'review', POLICY.maxIssuePhaseFailures, undefined],
    ]);
  });

  test('forwards the anchor id to both window queries', async () => {
    // Review finding on issue #531: recordRunAndEvaluate anchors the
    // evaluation at the row it just inserted so concurrently recorded runs
    // cannot dethrone it as the newest entry; both windows must be bounded by
    // that id.
    const recent = [entry({ issueNumber: 7, phase: 'review' })];
    const issuePhase = [entry({ issueNumber: 7, phase: 'review' })];
    const control = fakeControl({ recent, issuePhase });
    await fetchCircuitBreakerWindows(control, 's', POLICY, 42);
    expect(control.calls).toEqual([
      ['listRecentRuns', 's', CIRCUIT_BREAKER_EVAL_WINDOW, 42],
      ['listRecentIssuePhaseRuns', 's', 7, 'review', POLICY.maxIssuePhaseFailures, 42],
    ]);
  });

  test('skips the dedicated fetch on an empty ledger or when the issue+phase rule is disabled', async () => {
    const empty = fakeControl({ recent: [], issuePhase: [] });
    expect(await fetchCircuitBreakerWindows(empty, 's', POLICY)).toEqual({ recent: [] });
    expect(empty.calls).toEqual([['listRecentRuns', 's', CIRCUIT_BREAKER_EVAL_WINDOW, undefined]]);

    const disabled = fakeControl({ recent: [entry()], issuePhase: [] });
    const windows = await fetchCircuitBreakerWindows(disabled, 's', {
      maxConsecutiveFailures: 5,
      maxIssuePhaseFailures: 0,
    });
    expect(windows.issuePhaseRuns).toBeUndefined();
    expect(disabled.calls).toEqual([['listRecentRuns', 's', CIRCUIT_BREAKER_EVAL_WINDOW, undefined]]);
  });
});

describe('extractRunMetadata', () => {
  test('reads resolvedProfile and well-known cost/token keys', () => {
    expect(
      extractRunMetadata({
        resolvedProfile: { agentId: 'codex', model: 'gpt-5.2-codex', effort: 'high' },
        costUsd: 1.25,
        inputTokens: 1000,
        outputTokens: 200,
      }),
    ).toEqual({
      agent: 'codex',
      model: 'gpt-5.2-codex',
      effort: 'high',
      costUsd: 1.25,
      inputTokens: 1000,
      outputTokens: 200,
    });
  });

  test('tolerates missing/odd shapes without throwing', () => {
    expect(extractRunMetadata(undefined)).toEqual({});
    expect(extractRunMetadata({})).toEqual({});
    expect(
      extractRunMetadata({ resolvedProfile: 'not-an-object', costUsd: 'NaN', inputTokens: NaN }),
    ).toEqual({});
    expect(extractRunMetadata({ resolvedProfile: { agentId: 42, model: null } })).toEqual({});
  });
});
