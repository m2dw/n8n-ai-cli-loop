/**
 * Unit tests for the arbitration route decision (issue #847,
 * docs/review-dispute-contract.md §7 rows 13–21, §8.3, §9, §12).
 *
 * The document is the authority; these tests pin the routing against it. The
 * properties asserted over and over are the protocol's own invariants:
 *
 *  - every RETURNED verdict consumes exactly one arbitration pass and lands on
 *    exactly one of rows 13–18, whatever it decided;
 *  - malformed arbiter output NEVER consumes a pass, never awards the dispute to
 *    either party, and increments `malformedArbiterAttempts` exactly once;
 *  - operational failures — a subprocess that never ran, an artifact that could
 *    not be read or written, a lineage that is not arbitrable — instantiate no
 *    row, change no state, and move no counter;
 *  - a low-confidence decisive verdict decides nothing; `spec_ambiguous` and
 *    `insufficient_evidence` are not confidence-gated at all;
 *  - one result routes one lineage, and re-routing the same delivery produces a
 *    byte-identical decision and idempotency key.
 *
 * The confidence threshold itself is #846's and is pinned by
 * `review-arbitration-invocation.test.js`; the verdict fixtures below are built
 * by the REAL `parseArbitrationResponse`, so what is pinned here is that this
 * layer CONSUMES that routing rather than recomputing it.
 */
import {
  ARBITER_VERDICTS,
  REVIEW_DISPUTE_DEFAULT_LIMITS,
  ZERO_LINEAGE_COUNTERS,
} from '../dist/core/review-dispute.js';
import { arbitrationRunKey } from '../dist/core/review-arbitration-prompt.js';
import { parseArbitrationResponse } from '../dist/core/review-arbitration-response.js';
import { ARBITRATION_FAILURE_KINDS } from '../dist/handlers/review-arbitration.js';
import {
  ARBITRATION_MALFORMED_FAILURE_KINDS,
  ARBITRATION_OPERATIONAL_CLASSES,
  ARBITRATION_ROUTE_INTENTS,
  ARBITRATION_ROUTE_REASONS,
  ARBITRATION_ROUTE_ROWS,
  EVIDENCE_ROUND_UNAVAILABLE_REASONS,
  isMalformedFailureKind,
  routeArbitrationOutcome,
} from '../dist/core/review-arbitration-route.js';

const LINEAGE_ID = 'ln-0123456789ab';
const OTHER_LINEAGE_ID = 'ln-cafecafecafe';
const RUN_ID = 'run-arb-1';
/** A token no bounded decision may ever carry: it lives only in the rationale. */
const RATIONALE = 'RATIONALE-ONLY-TOKEN: the rebuttal misreads the acceptance criterion.';

function counters(overrides = {}) {
  return { ...ZERO_LINEAGE_COUNTERS, rebuttals: 1, reconsiderations: 1, ...overrides };
}

function lineage(overrides = {}) {
  const { counters: counterOverrides, ...rest } = overrides;
  return {
    lineageId: LINEAGE_ID,
    state: 'arbitration_pending',
    version: 1,
    counters: counters(counterOverrides),
    rebuttedVersions: [1],
    humanGate: false,
    severity: 'P1',
    affectedBoundary: 'src/core/outbox.ts',
    ...rest,
  };
}

function limits(overrides = {}) {
  return { ...REVIEW_DISPUTE_DEFAULT_LIMITS, ...overrides };
}

function profileSummary() {
  return {
    agentId: 'gemini',
    provider: 'google',
    model: 'gemini-3-pro',
    effort: 'high',
    toolPolicy: 'no-tools',
    candidateIndex: 0,
    minConfidence: 0.7,
    sameProviderFallback: false,
    sharedProviderWith: [],
  };
}

/** #846's bounded invocation summary. Names, literals, and counters only. */
function summary({ lineageId = LINEAGE_ID, version = 1, runId = RUN_ID, ...overrides } = {}) {
  return {
    lineageId,
    version,
    runKey: arbitrationRunKey({ lineageId, version, runId }),
    bundleDigest: 'f'.repeat(64),
    promptBytes: 4096,
    bundleEntries: 5,
    rawOutputBytes: 512,
    bundleArtifact: `arbitration-bundle-${lineageId}.json`,
    rawArtifact: `arbitration-raw-${lineageId}.txt`,
    stderrArtifact: null,
    runnerErrorArtifact: null,
    verdictArtifact: `arbitration-${lineageId}.json`,
    excerpts: 2,
    unresolvedExcerpts: 0,
    exitCode: 0,
    durationMs: 1200,
    profile: profileSummary(),
    verdict: null,
    failure: null,
    ...overrides,
  };
}

function verdictResponse({ verdict, confidence, lineageId = LINEAGE_ID, version = 1 }) {
  const record = { lineageId, version, verdict, confidence, rationale: RATIONALE };
  return ['Here is my judgement.', '', '```json', JSON.stringify(record, null, 2), '```', ''].join('\n');
}

/**
 * A #846 success, built by the REAL response parser so the admitted record and
 * the §8.3 confidence routing are the ones the invocation layer produces.
 */
function invocationOk({ verdict, confidence, minConfidence = 0.7, lineageId = LINEAGE_ID, version = 1, runId = RUN_ID } = {}) {
  const target = lineage({ lineageId, version });
  const outcome = parseArbitrationResponse({
    response: verdictResponse({ verdict, confidence, lineageId, version }),
    pending: { lineageId, version },
    lineages: { [lineageId]: target },
    minConfidence,
  });
  if (outcome.admitted === null) {
    throw new Error(`fixture not admitted: ${JSON.stringify(outcome.failure)}`);
  }
  return {
    ok: true,
    admitted: outcome.admitted,
    confidence: outcome.confidence,
    bundle: { entries: [] },
    artifacts: [],
    summary: summary({ lineageId, version, runId, verdict: outcome.summary }),
  };
}

function invocationFailed({ kind, detail = null, lineageId = LINEAGE_ID, version = 1, runId = RUN_ID } = {}) {
  return {
    ok: false,
    failure: { kind, detail },
    bundle: null,
    artifacts: [],
    summary: summary({ lineageId, version, runId, failure: { kind, detail } }),
  };
}

function invocationOutcome(result) {
  return { kind: 'invocation', result };
}

function profileOutcome(resolution, runId = RUN_ID) {
  return { kind: 'profile', resolution, run: { runId } };
}

function unavailableResolution({ lineageId = LINEAGE_ID, reason = 'no-acceptable-candidate', rejections } = {}) {
  return {
    kind: 'human_handoff',
    lineageId,
    reason,
    row: 19,
    rejections: rejections ?? [
      { index: 0, candidate: 'claude', reason: 'same-provider-not-allowed', detail: 'implementation' },
      { index: 1, candidate: 'codex', reason: 'cli-unavailable', detail: null },
    ],
  };
}

function route({ target = lineage(), version = 1, outcome, sessionLimits } = {}) {
  return routeArbitrationOutcome({
    lineage: target,
    version,
    outcome,
    ...(sessionLimits === undefined ? {} : { limits: sessionLimits }),
  });
}

/** Routes a real verdict of `verdict` at `confidence` against `target`. */
function routeVerdict({ verdict, confidence = 0.9, minConfidence = 0.7, target = lineage(), sessionLimits } = {}) {
  return route({
    target,
    version: target.version,
    outcome: invocationOutcome(invocationOk({ verdict, confidence, minConfidence, version: target.version })),
    sessionLimits,
  });
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

/** The five §6.1 counters, all unmoved. */
function expectNoCounterMovement(decision, before) {
  expect(decision.counterDelta).toEqual({
    rebuttals: 0,
    reconsiderations: 0,
    arbitrationPasses: 0,
    malformedArbiterAttempts: 0,
    evidenceRoundsUsed: 0,
  });
  expect(decision.countersAfter).toEqual(before);
}

// ---------------------------------------------------------------------------
// Rows 13–18: the four verdicts
// ---------------------------------------------------------------------------

describe('valid verdict routing', () => {
  test('row 13: a confident reviewer_correct makes the finding binding', () => {
    const decision = routeVerdict({ verdict: 'reviewer_correct', confidence: 0.9 });
    expect(decision.row).toBe(13);
    expect(decision.intent).toBe('implementation');
    expect(decision.currentState).toBe('arbitration_pending');
    expect(decision.nextState).toBe('binding');
    expect(decision.reason).toBe('reviewer-correct');
    expect(decision.auditEvents).toEqual(['dispute.arbitration.verdict']);
    expect(decision.verdict).toBe('reviewer_correct');
    expect(decision.confidence).toMatchObject({ decisive: true, meetsMinConfidence: true, minConfidence: 0.7 });
    expect(decision.counterDelta.arbitrationPasses).toBe(1);
    expect(decision.counterDelta.malformedArbiterAttempts).toBe(0);
    expect(decision.countersAfter.arbitrationPasses).toBe(1);
    expect(decision.evidence).toBeNull();
    expect(decision.operational).toBeNull();
  });

  test('row 14: a confident implementer_correct overrules the finding', () => {
    const decision = routeVerdict({ verdict: 'implementer_correct', confidence: 0.85 });
    expect(decision.row).toBe(14);
    expect(decision.intent).toBe('review_aggregation');
    expect(decision.nextState).toBe('resolved_overruled');
    expect(decision.reason).toBe('implementer-correct');
    expect(decision.auditEvents).toEqual(['dispute.resolved']);
    expect(decision.counterDelta.arbitrationPasses).toBe(1);
  });

  test('row 15: spec_ambiguous escalates to a human at ANY confidence', () => {
    for (const confidence of [0.05, 0.7, 1]) {
      const decision = routeVerdict({ verdict: 'spec_ambiguous', confidence });
      expect(decision.row).toBe(15);
      expect(decision.intent).toBe('human_handoff');
      expect(decision.nextState).toBe('escalated_human');
      expect(decision.reason).toBe('spec-ambiguous');
      expect(decision.auditEvents).toEqual(['dispute.escalated.human']);
      expect(decision.counterDelta.arbitrationPasses).toBe(1);
    }
  });

  test('row 16: insufficient_evidence with a round available requests evidence, at ANY confidence', () => {
    for (const confidence of [0.1, 0.99]) {
      const decision = routeVerdict({ verdict: 'insufficient_evidence', confidence });
      expect(decision.row).toBe(16);
      expect(decision.intent).toBe('evidence_collection');
      expect(decision.nextState).toBe('evidence_requested');
      expect(decision.reason).toBe('insufficient-evidence');
      expect(decision.auditEvents).toEqual(['dispute.evidence.requested']);
      expect(decision.evidence).toEqual({
        available: true,
        budget: 1,
        used: 0,
        arbitrationPassesRemaining: 1,
        unavailableReason: null,
      });
      // §7 row 22 marks the round used; requesting it never does.
      expect(decision.counterDelta.evidenceRoundsUsed).toBe(0);
      expect(decision.counterDelta.arbitrationPasses).toBe(1);
    }
  });

  test('row 17: the evidence round already consumed escalates to a human', () => {
    const decision = routeVerdict({
      verdict: 'insufficient_evidence',
      target: lineage({ counters: { evidenceRoundsUsed: 1 } }),
    });
    expect(decision.row).toBe(17);
    expect(decision.intent).toBe('human_handoff');
    expect(decision.nextState).toBe('escalated_human');
    expect(decision.reason).toBe('insufficient-evidence-round-unavailable');
    expect(decision.evidence.unavailableReason).toBe('round-consumed');
    expect(decision.counterDelta.arbitrationPasses).toBe(1);
  });

  test('row 17: a zero evidence-round budget reports the budget, not the pass', () => {
    const decision = routeVerdict({
      verdict: 'insufficient_evidence',
      sessionLimits: limits({ maxEvidenceRoundsPerLineage: 0 }),
    });
    expect(decision.row).toBe(17);
    expect(decision.evidence).toMatchObject({ available: false, budget: 0, unavailableReason: 'round-budget-zero' });
  });

  test('row 17: an unconsumed round with no arbitration pass left is still unavailable', () => {
    // Default budget of 2 passes, one already spent: this verdict spends the
    // second, so nothing remains to weigh the collected evidence.
    const decision = routeVerdict({
      verdict: 'insufficient_evidence',
      target: lineage({ counters: { arbitrationPasses: 1 } }),
    });
    expect(decision.row).toBe(17);
    expect(decision.evidence).toEqual({
      available: false,
      budget: 1,
      used: 0,
      arbitrationPassesRemaining: 0,
      unavailableReason: 'no-remaining-arbitration-pass',
    });
  });

  test('row 17: a lowered arbitration-pass budget of 1 makes the round unavailable from the start', () => {
    const decision = routeVerdict({
      verdict: 'insufficient_evidence',
      sessionLimits: limits({ maxArbitrationPassesPerLineage: 1 }),
    });
    expect(decision.row).toBe(17);
    expect(decision.evidence.unavailableReason).toBe('no-remaining-arbitration-pass');
    expect(decision.nextState).toBe('escalated_human');
  });

  test('row 18: a decisive verdict below the threshold decides for nobody', () => {
    for (const verdict of ['reviewer_correct', 'implementer_correct']) {
      const decision = routeVerdict({ verdict, confidence: 0.5, minConfidence: 0.7 });
      expect(decision.row).toBe(18);
      expect(decision.intent).toBe('human_handoff');
      expect(decision.nextState).toBe('escalated_human');
      expect(decision.reason).toBe('low-confidence-verdict');
      expect(decision.auditEvents).toEqual(['dispute.escalated.human']);
      expect(decision.confidence).toMatchObject({ decisive: true, meetsMinConfidence: false });
      // The verdict is still recorded — it just does not decide.
      expect(decision.verdict).toBe(verdict);
      expect(decision.counterDelta.arbitrationPasses).toBe(1);
    }
  });

  test('confidence exactly at the threshold is at/above it (row 13, not row 18)', () => {
    const decision = routeVerdict({ verdict: 'reviewer_correct', confidence: 0.7, minConfidence: 0.7 });
    expect(decision.row).toBe(13);
    expect(decision.nextState).toBe('binding');
  });

  test('a lowered threshold admits a verdict the default would escalate', () => {
    const decision = routeVerdict({ verdict: 'implementer_correct', confidence: 0.5, minConfidence: 0.4 });
    expect(decision.row).toBe(14);
    expect(decision.nextState).toBe('resolved_overruled');
  });

  test('every §8.1 verdict maps to exactly one row in 13–18 and spends exactly one pass', () => {
    const rows = ARBITER_VERDICTS.map((verdict) => routeVerdict({ verdict, confidence: 0.9 }));
    for (const decision of rows) {
      expect([13, 14, 15, 16, 17, 18]).toContain(decision.row);
      expect(decision.counterDelta.arbitrationPasses).toBe(1);
      expect(decision.counterDelta.malformedArbiterAttempts).toBe(0);
      expect(decision.countersAfter.arbitrationPasses).toBe(1);
      expect(decision.auditEvents).toHaveLength(1);
      expect(decision.operational).toBeNull();
    }
    expect(new Set(rows.map((decision) => decision.row)).size).toBe(ARBITER_VERDICTS.length);
  });
});

// ---------------------------------------------------------------------------
// Row 19 and the not-applicable inputs
// ---------------------------------------------------------------------------

describe('unavailable arbiter', () => {
  test('row 19: no acceptable arbiter escalates without consuming any counter', () => {
    const target = lineage();
    const decision = route({ target, outcome: profileOutcome(unavailableResolution()) });
    expect(decision.row).toBe(19);
    expect(decision.intent).toBe('human_handoff');
    expect(decision.nextState).toBe('escalated_human');
    expect(decision.reason).toBe('no-acceptable-arbiter');
    expect(decision.auditEvents).toEqual(['dispute.escalated.human']);
    expect(decision.arbiterUnavailable).toBe('no-acceptable-candidate');
    expectNoCounterMovement(decision, target.counters);
  });

  test('row 19 preserves the bounded candidate rejections for diagnostics', () => {
    const decision = route({ outcome: profileOutcome(unavailableResolution({ reason: 'no-candidates' })) });
    expect(decision.arbiterUnavailable).toBe('no-candidates');
    expect(decision.candidateRejections).toEqual([
      { index: 0, candidate: 'claude', reason: 'same-provider-not-allowed', detail: 'implementation' },
      { index: 1, candidate: 'codex', reason: 'cli-unavailable', detail: null },
    ]);
    expect(decision.profile).toBeNull();
    expect(decision.bundleDigest).toBeNull();
    expect(decision.artifactNames).toEqual([]);
  });

  test('row 19 keys on the same three literals as an invocation would', () => {
    const decision = route({ outcome: profileOutcome(unavailableResolution(), 'run-9') });
    expect(decision.runKey).toBe(`${LINEAGE_ID}@1#run-9`);
    expect(decision.idempotencyKey).toBe(`${LINEAGE_ID}@1#run-9|row:19`);
  });

  test('a disabled protocol or a non-arbitration intent is NOT row 19', () => {
    for (const reason of ['dispute-disabled', 'not-arbitration-intent']) {
      const target = lineage();
      const decision = route({
        target,
        outcome: profileOutcome({ kind: 'not_applicable', lineageId: LINEAGE_ID, reason, rejections: [] }),
      });
      expect(decision.row).toBeNull();
      expect(decision.intent).toBe('operational_failure');
      expect(decision.reason).toBe('not-applicable');
      expect(decision.nextState).toBeNull();
      expect(decision.auditEvents).toEqual([]);
      expect(decision.operational).toEqual({ kind: reason, failureClass: 'precondition', detail: 'resolution:not_applicable' });
      expectNoCounterMovement(decision, target.counters);
    }
  });

  test('a SELECTED profile is an input to arbitration, not an outcome of it', () => {
    const target = lineage();
    const decision = route({
      target,
      outcome: profileOutcome({
        kind: 'selected',
        lineageId: LINEAGE_ID,
        profile: { agentId: 'gemini', provider: 'google' },
        rejections: [],
      }),
    });
    expect(decision.intent).toBe('operational_failure');
    expect(decision.row).toBeNull();
    expect(decision.operational.kind).toBe('arbiter-selected-not-invoked');
    expectNoCounterMovement(decision, target.counters);
  });
});

// ---------------------------------------------------------------------------
// Rows 20–21: malformed arbiter output
// ---------------------------------------------------------------------------

describe('malformed arbiter output', () => {
  test('row 20: a first malformed attempt below the cap retries the arbiter', () => {
    for (const kind of ARBITRATION_MALFORMED_FAILURE_KINDS) {
      const target = lineage();
      const decision = route({ target, outcome: invocationOutcome(invocationFailed({ kind })) });
      expect(decision.row).toBe(20);
      expect(decision.intent).toBe('arbitration_retry');
      expect(decision.currentState).toBe('arbitration_pending');
      expect(decision.nextState).toBe('arbitration_pending');
      expect(decision.reason).toBe('malformed-arbiter-output');
      expect(decision.auditEvents).toEqual(['dispute.arbitration.malformed']);
      expect(decision.counterDelta.malformedArbiterAttempts).toBe(1);
      expect(decision.counterDelta.arbitrationPasses).toBe(0);
      expect(decision.countersAfter.malformedArbiterAttempts).toBe(1);
      expect(decision.countersAfter.arbitrationPasses).toBe(0);
      expect(decision.verdict).toBeNull();
      expect(decision.invocationFailure).toEqual({ kind, detail: null });
    }
  });

  test('row 21: the cap-reaching attempt escalates and carries the count', () => {
    const decision = route({
      target: lineage({ counters: { malformedArbiterAttempts: 1 } }),
      outcome: invocationOutcome(invocationFailed({ kind: 'malformed-response', detail: 'verdict:unparseable' })),
    });
    expect(decision.row).toBe(21);
    expect(decision.intent).toBe('human_handoff');
    expect(decision.nextState).toBe('escalated_human');
    expect(decision.reason).toBe('malformed-arbiter-cap-reached');
    expect(decision.auditEvents).toEqual(['dispute.escalated.human']);
    expect(decision.counterDelta.malformedArbiterAttempts).toBe(1);
    expect(decision.countersAfter.malformedArbiterAttempts).toBe(2);
    expect(decision.counterDelta.arbitrationPasses).toBe(0);
    expect(decision.invocationFailure).toEqual({ kind: 'malformed-response', detail: 'verdict:unparseable' });
  });

  test('a lowered cap of 1 makes the FIRST malformed attempt row 21', () => {
    const decision = route({
      outcome: invocationOutcome(invocationFailed({ kind: 'empty-output' })),
      sessionLimits: limits({ maxMalformedArbiterAttemptsPerLineage: 1 }),
    });
    expect(decision.row).toBe(21);
    expect(decision.nextState).toBe('escalated_human');
    expect(decision.countersAfter.malformedArbiterAttempts).toBe(1);
  });

  test('malformed output never awards the dispute to either party', () => {
    for (const attempts of [0, 1, 2]) {
      const decision = route({
        target: lineage({ counters: { malformedArbiterAttempts: attempts } }),
        outcome: invocationOutcome(invocationFailed({ kind: 'empty-output' })),
      });
      expect([20, 21]).toContain(decision.row);
      expect(['arbitration_pending', 'escalated_human']).toContain(decision.nextState);
      expect(decision.verdict).toBeNull();
      expect(decision.confidence).toBeNull();
      expect(decision.counterDelta.arbitrationPasses).toBe(0);
    }
  });

  test('a counter already at the cap escalates rather than retrying without bound', () => {
    const decision = route({
      target: lineage({ counters: { malformedArbiterAttempts: 2 } }),
      outcome: invocationOutcome(invocationFailed({ kind: 'empty-output' })),
    });
    expect(decision.row).toBe(21);
    expect(decision.nextState).toBe('escalated_human');
  });
});

// ---------------------------------------------------------------------------
// Operational failures
// ---------------------------------------------------------------------------

describe('operational failures', () => {
  test('every #846 failure kind is classified, and only response content is malformed', () => {
    for (const kind of ARBITRATION_FAILURE_KINDS) {
      const target = lineage();
      const decision = route({ target, outcome: invocationOutcome(invocationFailed({ kind, detail: 'x' })) });
      // #846's failure survives verbatim whichever way this layer routed it.
      expect(decision.invocationFailure).toEqual({ kind, detail: 'x' });
      if (isMalformedFailureKind(kind)) {
        expect(ARBITRATION_MALFORMED_FAILURE_KINDS).toContain(kind);
        expect([20, 21]).toContain(decision.row);
        expect(decision.counterDelta.malformedArbiterAttempts).toBe(1);
        expect(decision.operational).toBeNull();
        continue;
      }
      expect(decision.intent).toBe('operational_failure');
      expect(decision.reason).toBe('operational-failure');
      expect(decision.row).toBeNull();
      expect(decision.nextState).toBeNull();
      expect(decision.auditEvents).toEqual([]);
      expect(decision.verdict).toBeNull();
      expect(decision.operational.kind).toBe(kind);
      expect(ARBITRATION_OPERATIONAL_CLASSES).toContain(decision.operational.failureClass);
      expectNoCounterMovement(decision, target.counters);
    }
  });

  test('exactly two failure kinds are attributable to the arbiter response', () => {
    expect(ARBITRATION_FAILURE_KINDS.filter((kind) => isMalformedFailureKind(kind))).toEqual([
      'empty-output',
      'malformed-response',
    ]);
  });

  test('an agent that never answered is infrastructure, not malformed output', () => {
    const decision = route({ outcome: invocationOutcome(invocationFailed({ kind: 'agent-failed', detail: 'exit:124' })) });
    expect(decision.operational).toEqual({
      kind: 'agent-failed',
      failureClass: 'agent-unavailable',
      detail: 'exit:124',
    });
    expect(decision.counterDelta.malformedArbiterAttempts).toBe(0);
  });

  test('read failures and write failures are classified apart', () => {
    const read = route({ outcome: invocationOutcome(invocationFailed({ kind: 'missing-dispute-artifact' })) });
    const write = route({ outcome: invocationOutcome(invocationFailed({ kind: 'unsafe-artifact-path' })) });
    expect(read.operational.failureClass).toBe('input-artifact');
    expect(write.operational.failureClass).toBe('artifact-write');
  });
});

// ---------------------------------------------------------------------------
// Preconditions: stale, non-arbitrable, exhausted
// ---------------------------------------------------------------------------

describe('arbitrability preconditions', () => {
  test('a lineage that is no longer arbitration_pending routes nothing', () => {
    for (const state of ['binding', 'escalated_human', 'resolved_overruled', 'open', 'evidence_requested']) {
      const target = lineage({ state });
      const decision = route({
        target,
        outcome: invocationOutcome(invocationOk({ verdict: 'reviewer_correct', confidence: 0.9 })),
      });
      expect(decision.intent).toBe('operational_failure');
      expect(decision.currentState).toBe(state);
      expect(decision.nextState).toBeNull();
      expect(decision.operational).toEqual({
        kind: 'lineage-not-arbitration-pending',
        failureClass: 'precondition',
        detail: `lineage.state:${state}`,
      });
      expectNoCounterMovement(decision, target.counters);
    }
  });

  test('a verdict for a version the lineage has moved past routes nothing', () => {
    const target = lineage({ version: 2 });
    const decision = route({
      target,
      version: 1,
      outcome: invocationOutcome(invocationOk({ verdict: 'reviewer_correct', confidence: 0.9, version: 1 })),
    });
    expect(decision.operational.kind).toBe('not-arbitrable');
    expectNoCounterMovement(decision, target.counters);
  });

  test('an invocation summary naming another version routes nothing', () => {
    const target = lineage({ version: 2 });
    const decision = route({
      target,
      version: 2,
      outcome: invocationOutcome(invocationOk({ verdict: 'reviewer_correct', confidence: 0.9, version: 1 })),
    });
    expect(decision.operational.kind).toBe('not-arbitrable');
    expect(decision.nextState).toBeNull();
  });

  test('an exhausted arbitration budget routes nothing, whatever came back', () => {
    const target = lineage({ counters: { arbitrationPasses: 2 } });
    const outcomes = [
      invocationOutcome(invocationOk({ verdict: 'reviewer_correct', confidence: 0.9 })),
      invocationOutcome(invocationFailed({ kind: 'empty-output' })),
      profileOutcome(unavailableResolution()),
    ];
    for (const outcome of outcomes) {
      const decision = route({ target, outcome });
      expect(decision.intent).toBe('operational_failure');
      expect(decision.operational).toEqual({
        kind: 'arbitration-passes-exhausted',
        failureClass: 'precondition',
        detail: 'lineage.counters.arbitrationPasses:2',
      });
      expectNoCounterMovement(decision, target.counters);
    }
  });

  test('a duplicate delivery after the lineage already moved on spends no second pass', () => {
    const result = invocationOk({ verdict: 'reviewer_correct', confidence: 0.9 });
    const first = route({ target: lineage(), outcome: invocationOutcome(result) });
    expect(first.row).toBe(13);
    // #840 applied it: the lineage is now `binding` with the pass spent.
    const applied = lineage({ state: 'binding', counters: { arbitrationPasses: 1 } });
    const second = route({ target: applied, outcome: invocationOutcome(result) });
    expect(second.row).toBeNull();
    expect(second.operational.kind).toBe('lineage-not-arbitration-pending');
    expectNoCounterMovement(second, applied.counters);
  });
});

// ---------------------------------------------------------------------------
// Idempotency and determinism
// ---------------------------------------------------------------------------

describe('idempotency', () => {
  test('re-routing the same delivery is byte-identical', () => {
    const result = invocationOk({ verdict: 'insufficient_evidence', confidence: 0.8 });
    const target = lineage();
    const first = route({ target, outcome: invocationOutcome(result) });
    const second = route({ target, outcome: invocationOutcome(result) });
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  test('the key distinguishes lineage, version, invocation, and row', () => {
    const keys = new Set();
    keys.add(routeVerdict({ verdict: 'reviewer_correct', confidence: 0.9 }).idempotencyKey);
    keys.add(routeVerdict({ verdict: 'implementer_correct', confidence: 0.9 }).idempotencyKey);
    // Another version of the same lineage.
    keys.add(
      route({
        target: lineage({ version: 2 }),
        version: 2,
        outcome: invocationOutcome(invocationOk({ verdict: 'reviewer_correct', confidence: 0.9, version: 2 })),
      }).idempotencyKey,
    );
    // Another lineage.
    keys.add(
      route({
        target: lineage({ lineageId: OTHER_LINEAGE_ID }),
        outcome: invocationOutcome(invocationOk({ verdict: 'reviewer_correct', confidence: 0.9, lineageId: OTHER_LINEAGE_ID })),
      }).idempotencyKey,
    );
    // Another invocation of the same lineage/version.
    keys.add(
      route({
        outcome: invocationOutcome(invocationOk({ verdict: 'reviewer_correct', confidence: 0.9, runId: 'run-arb-2' })),
      }).idempotencyKey,
    );
    expect(keys.size).toBe(5);
  });

  test('the key carries the invocation run key and the row it produced', () => {
    const decision = routeVerdict({ verdict: 'reviewer_correct', confidence: 0.9 });
    expect(decision.runKey).toBe(`${LINEAGE_ID}@1#${RUN_ID}`);
    expect(decision.idempotencyKey).toBe(`${LINEAGE_ID}@1#${RUN_ID}|row:13`);
  });

  test('a re-delivered malformed run keeps its run key, so #840 can recognize it', () => {
    const result = invocationFailed({ kind: 'empty-output' });
    const first = route({ target: lineage(), outcome: invocationOutcome(result) });
    expect(first.row).toBe(20);
    // #840 applied the attempt; a duplicate delivery now reads the moved counter
    // and names the cap-reaching row — which is why the RUN KEY, not the row, is
    // what identifies an already-applied outcome.
    const applied = lineage({ counters: { malformedArbiterAttempts: 1 } });
    const second = route({ target: applied, outcome: invocationOutcome(result) });
    expect(second.row).toBe(21);
    expect(second.runKey).toBe(first.runKey);
    expect(second.idempotencyKey).not.toBe(first.idempotencyKey);
  });

  test('an operational failure keys on the kind, not on a row it never took', () => {
    const decision = route({ outcome: invocationOutcome(invocationFailed({ kind: 'agent-failed' })) });
    expect(decision.idempotencyKey).toBe(`${LINEAGE_ID}@1#${RUN_ID}|operational:agent-failed`);
  });

  test('the decision never mutates its inputs', () => {
    const target = deepFreeze(lineage());
    const result = deepFreeze(invocationOk({ verdict: 'reviewer_correct', confidence: 0.9 }));
    const before = JSON.stringify({ target, result });
    const decision = route({ target, outcome: invocationOutcome(result) });
    expect(decision.row).toBe(13);
    expect(JSON.stringify({ target, result })).toBe(before);
    // The returned collections are copies, so writing through them reaches no
    // input — the frozen inputs would throw on assignment if it did.
    decision.artifactNames.push('extra.json');
    decision.countersAfter.arbitrationPasses = 99;
    decision.profile.sharedProviderWith.push('review');
    expect(JSON.stringify({ target, result })).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// One lineage per decision
// ---------------------------------------------------------------------------

describe('multi-lineage isolation', () => {
  test("a result for one lineage cannot route another lineage", () => {
    const target = lineage();
    const decision = route({
      target,
      outcome: invocationOutcome(invocationOk({ verdict: 'reviewer_correct', confidence: 0.9, lineageId: OTHER_LINEAGE_ID })),
    });
    expect(decision.lineageId).toBe(LINEAGE_ID);
    expect(decision.intent).toBe('operational_failure');
    expect(decision.operational).toEqual({
      kind: 'profile-lineage-mismatch',
      failureClass: 'precondition',
      detail: `outcome.lineageId:${OTHER_LINEAGE_ID}`,
    });
    expectNoCounterMovement(decision, target.counters);
  });

  test('a resolution for one lineage cannot escalate another', () => {
    const target = lineage();
    const decision = route({ target, outcome: profileOutcome(unavailableResolution({ lineageId: OTHER_LINEAGE_ID })) });
    expect(decision.row).toBeNull();
    expect(decision.operational.kind).toBe('profile-lineage-mismatch');
    expectNoCounterMovement(decision, target.counters);
  });

  test('a verdict record naming another lineage never reaches a counter', () => {
    const target = lineage();
    const ok = invocationOk({ verdict: 'reviewer_correct', confidence: 0.9 });
    // The summary still names this lineage; only the admitted record disagrees.
    const tampered = {
      ...ok,
      admitted: { ...ok.admitted, record: { ...ok.admitted.record, lineageId: OTHER_LINEAGE_ID } },
    };
    const decision = route({ target, outcome: invocationOutcome(tampered) });
    expect(decision.intent).toBe('operational_failure');
    expect(decision.operational.kind).toBe('profile-lineage-mismatch');
    expectNoCounterMovement(decision, target.counters);
  });

  test('a multi-finding task routes each lineage on its own facts', () => {
    const findings = [
      { id: LINEAGE_ID, verdict: 'reviewer_correct', confidence: 0.9, row: 13, next: 'binding' },
      { id: OTHER_LINEAGE_ID, verdict: 'implementer_correct', confidence: 0.95, row: 14, next: 'resolved_overruled' },
      { id: 'ln-aaaabbbbcccc', verdict: 'spec_ambiguous', confidence: 0.9, row: 15, next: 'escalated_human' },
    ];
    const decisions = findings.map((finding) =>
      route({
        target: lineage({ lineageId: finding.id }),
        outcome: invocationOutcome(
          invocationOk({ verdict: finding.verdict, confidence: finding.confidence, lineageId: finding.id }),
        ),
      }),
    );
    decisions.forEach((decision, index) => {
      const finding = findings[index];
      expect(decision.lineageId).toBe(finding.id);
      expect(decision.row).toBe(finding.row);
      expect(decision.nextState).toBe(finding.next);
      expect(decision.countersAfter.arbitrationPasses).toBe(1);
      // Nothing in one decision names any other lineage.
      const serialized = JSON.stringify(decision);
      for (const other of findings.filter((entry) => entry.id !== finding.id)) {
        expect(serialized).not.toContain(other.id);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Boundedness of the decision itself
// ---------------------------------------------------------------------------

describe('bounded decisions', () => {
  test('no rationale, prompt, transcript, or path travels in a decision', () => {
    for (const verdict of ARBITER_VERDICTS) {
      const serialized = JSON.stringify(routeVerdict({ verdict, confidence: 0.9 }));
      expect(serialized).not.toContain('RATIONALE-ONLY-TOKEN');
      expect(serialized).not.toContain('Here is my judgement');
      expect(serialized).not.toMatch(/"[^"]*\/(?:tmp|Users|home)\//);
    }
  });

  test('artifact names travel as names; anything path-shaped is dropped', () => {
    const ok = invocationOk({ verdict: 'reviewer_correct', confidence: 0.9 });
    const decision = route({
      outcome: invocationOutcome({
        ...ok,
        summary: {
          ...ok.summary,
          bundleArtifact: '/tmp/session/run/arbitration-bundle.json',
          rawArtifact: 'arbitration-raw.txt',
          stderrArtifact: null,
        },
      }),
    });
    expect(decision.artifactNames).toEqual(['arbitration-raw.txt', `arbitration-${LINEAGE_ID}.json`]);
  });

  test('the decision reuses the existing state, event, and counter vocabularies', () => {
    const decision = routeVerdict({ verdict: 'reviewer_correct', confidence: 0.9 });
    expect(ARBITRATION_ROUTE_INTENTS).toContain(decision.intent);
    expect(ARBITRATION_ROUTE_REASONS).toContain(decision.reason);
    expect(ARBITRATION_ROUTE_ROWS).toContain(decision.row);
    expect(Object.keys(decision.counterDelta).sort()).toEqual(Object.keys(ZERO_LINEAGE_COUNTERS).sort());
    expect(Object.keys(decision.countersAfter).sort()).toEqual(Object.keys(ZERO_LINEAGE_COUNTERS).sort());
  });

  test('the evidence-availability vocabulary is closed', () => {
    const unavailable = [
      routeVerdict({ verdict: 'insufficient_evidence', sessionLimits: limits({ maxEvidenceRoundsPerLineage: 0 }) }),
      routeVerdict({ verdict: 'insufficient_evidence', target: lineage({ counters: { evidenceRoundsUsed: 1 } }) }),
      routeVerdict({ verdict: 'insufficient_evidence', target: lineage({ counters: { arbitrationPasses: 1 } }) }),
    ];
    expect(unavailable.map((decision) => decision.evidence.unavailableReason)).toEqual([
      ...EVIDENCE_ROUND_UNAVAILABLE_REASONS,
    ]);
  });
});
