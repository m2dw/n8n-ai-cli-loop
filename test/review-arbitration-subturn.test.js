/**
 * Issue #955: the §7.1 arbitration sub-turn, routed and applied
 * (src/handlers/review-arbitration-subturn.ts,
 * docs/review-dispute-contract.md §7 rows 13–21, §7.1, §8.3, §9, §12).
 *
 * #954 resolves the arbiter and invokes it; this slice decides what the answer
 * MEANS and applies it exactly once. Everything below is asserted through the
 * real dispatch path — `dispatchDisputeSubTurn` with the real #847 router and the
 * real #840 applicator — so a passing case is one where the transition, the
 * counters, and the routing all agree:
 *
 *  - every §8.1 verdict reaches exactly one row, and every cap boundary is
 *    exercised from BOTH sides (`minConfidence`, the arbitration-pass budget, the
 *    malformed-attempt cap, and the one bounded evidence round);
 *  - a failure that is not the arbiter's ANSWER — a timeout, a nonzero exit, an
 *    exhausted budget, a lineage that moved — instantiates no row, spends no
 *    counter, and parks;
 *  - a re-delivered claim replays the row it already committed instead of buying
 *    a second verdict, and the replay writes nothing;
 *  - the review phase dispatches the turn when the caller supplies the runtime
 *    §8.2/§8.3 needs, and parks exactly as before when it does not.
 */
import {
  REVIEW_DISPUTE_ARBITRATION_APPLIED_CONTEXT_KEY,
  createArbitrationSubTurnRunner,
  parseArbitrationAppliedRecord,
} from '../dist/handlers/review-arbitration-subturn.js';
import { REVIEW_DISPUTE_ARBITRATION_CONTEXT_KEY } from '../dist/handlers/review-arbitration-turn.js';
import { runReviewDisputeSubTurn } from '../dist/handlers/review-reconsideration-turn.js';
import { createArbiterCandidateResolver } from '../dist/core/review-arbiter-profile.js';
import {
  REVIEW_DISPUTE_SUB_TURN_CONTEXT_KEY,
  dispatchDisputeSubTurn,
  disputeSubTurnIdentity,
} from '../dist/core/review-dispute-dispatch.js';
import { transitionDigest } from '../dist/core/review-dispute-transition.js';
import { REVIEW_DISPUTE_DEFAULT_LIMITS, ZERO_LINEAGE_COUNTERS } from '../dist/core/review-dispute.js';
import { createHash } from 'crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const LINEAGE = 'ln-aaaaaaaaaaaa';
const LINEAGE_B = 'ln-bbbbbbbbbbbb';
const BOUNDARY = 'src/auth/handler.ts';
const RUN_ID = 'run-review-9';
/** What `disputeSubTurnIdentity` derives for a first-attempt arbitration turn. */
const DERIVED_RUN_ID = `${RUN_ID}~runner.0`;
const RATIONALE =
  'The Issue contract requires a 401 on every entry path, and the middleware the rebuttal cites does not run on '
  + 'the direct-dispatch path, so the finding holds.';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function lineage(overrides = {}) {
  const { counters: counterOverrides, ...rest } = overrides;
  return {
    lineageId: LINEAGE,
    state: 'arbitration_pending',
    version: 1,
    counters: { ...ZERO_LINEAGE_COUNTERS, rebuttals: 1, reconsiderations: 1, ...counterOverrides },
    rebuttedVersions: [1],
    disputeRuns: [{ version: 1, runId: 'run-impl-1' }],
    humanGate: false,
    severity: 'P1',
    affectedBoundary: BOUNDARY,
    ...rest,
  };
}

function context(lineages = { [LINEAGE]: lineage() }) {
  return { version: 1, reviewStructure: 'structured', lineages };
}

/** The §8.3 policy, cross-provider by default: parties on OpenAI and Google. */
function settings(arbiter = {}, limits = REVIEW_DISPUTE_DEFAULT_LIMITS) {
  return {
    enabled: true,
    limits,
    arbiter: { providers: ['claude'], allowSameProvider: false, minConfidence: 0.7, ...arbiter },
  };
}

function runtime(overrides = {}) {
  return {
    settings: settings(),
    implementation: { agentId: 'codex', model: 'gpt-5-codex' },
    review: { agentId: 'gemini', model: 'gemini-3.1-pro' },
    resolveCandidate: createArbiterCandidateResolver({ env: {} }),
    issueBody: 'The endpoint must never return 500 for an unauthenticated request.',
    disputeArtifactDir: '/artifacts/runs/run-impl-1',
    reconsiderationArtifactDir: '/artifacts/runs/run-review-2',
    artifactDir: '/artifacts/runs/run-review-9',
    artifactRoot: '/artifacts',
    repoCwd: '/worktree',
    timestamp: '2026-08-05T03:00:00.000Z',
    env: {},
    ...overrides,
  };
}

function turnFor(lineageIds = [LINEAGE]) {
  return { kind: 'runner_arbitration', rule: 2, lineageIds };
}

function identityFor(turn = turnFor(), runId = RUN_ID, attempt = 0) {
  const derived = disputeSubTurnIdentity({ runId, turn, ...(attempt === 0 ? {} : { attempt }) });
  expect(derived.ok).toBe(true);
  return derived.value;
}

/** #846's bounded summary, built from the input the adapter actually passed. */
function summaryFor(input, { verdict = null, failure = null, timedOut = false, exitCode = 0 } = {}) {
  const profile = input.selection.profile;
  return {
    lineageId: input.pending.lineageId,
    version: input.pending.version,
    runKey: `${input.pending.lineageId}@${input.pending.version}#${input.run.runId}`,
    bundleDigest: 'deadbeefcafe',
    promptBytes: 512,
    bundleEntries: 4,
    rawOutputBytes: 128,
    bundleArtifact: 'arbitration-bundle.json',
    rawArtifact: 'arbitration-raw.txt',
    stderrArtifact: null,
    runnerErrorArtifact: null,
    verdictArtifact: verdict === null ? null : 'arbitration-ln-aaaaaaaaaaaa.json',
    excerpts: 2,
    unresolvedExcerpts: 0,
    exitCode,
    timedOut,
    durationMs: 1200,
    profile: {
      agentId: profile.agentId,
      provider: profile.provider,
      model: profile.model,
      effort: profile.effort,
      toolPolicy: profile.toolPolicy,
      candidateIndex: profile.candidateIndex,
      minConfidence: profile.minConfidence,
      sameProviderFallback: profile.sameProviderFallback,
      sharedProviderWith: [...profile.sharedProviderWith],
    },
    verdict:
      verdict === null
        ? null
        : {
            lineageId: verdict.lineageId,
            version: verdict.version,
            verdict: verdict.verdict,
            confidence: verdict.confidence,
            decisive: DECISIVE.includes(verdict.verdict),
            minConfidence: profile.minConfidence,
            meetsMinConfidence: meets(verdict, profile.minConfidence),
            rationaleChars: RATIONALE.length,
            ignoredFindingShapedFields: [],
          },
    failure,
  };
}

const DECISIVE = ['reviewer_correct', 'implementer_correct'];

function meets(record, minConfidence) {
  return !DECISIVE.includes(record.verdict) || record.confidence >= minConfidence;
}

/**
 * An `invoke` stub that returns one admitted §8.1 verdict.
 *
 * The confidence routing is #846's already-applied answer, so the stub computes
 * it exactly as #846 does — from the SELECTED profile's own threshold — rather
 * than from a constant that could disagree with the policy under test.
 */
function invokeVerdict(record, calls = []) {
  return (input) => {
    calls.push(input);
    const minConfidence = input.selection.profile.minConfidence;
    return {
      ok: true,
      admitted: {
        record,
        lineage: input.context.lineages[record.lineageId],
        ignoredFindingShapedFields: [],
      },
      confidence: {
        decisive: DECISIVE.includes(record.verdict),
        minConfidence,
        confidence: record.confidence,
        meetsMinConfidence: meets(record, minConfidence),
      },
      bundle: { entries: [], digest: 'deadbeefcafe' },
      artifacts: [{ name: 'arbitration-ln-aaaaaaaaaaaa.json', content: '{}' }],
      summary: summaryFor(input, { verdict: record }),
    };
  };
}

/** An `invoke` stub that returns one typed #846 failure. */
function invokeFailure(failure, { timedOut = false, exitCode = 1 } = {}, calls = []) {
  return (input) => {
    calls.push(input);
    return {
      ok: false,
      failure,
      bundle: null,
      artifacts: [],
      summary: summaryFor(input, { failure, timedOut, exitCode }),
    };
  };
}

function verdictRecord(overrides = {}) {
  return { lineageId: LINEAGE, version: 1, verdict: 'reviewer_correct', confidence: 0.86, rationale: RATIONALE, ...overrides };
}

/**
 * One dispatch through the real adapter, router, and transition layer.
 *
 * Nothing is stubbed except #846's invocation itself: the profile is resolved by
 * #839, the row is chosen by #847, and the block is written by #840.
 */
async function dispatch({
  ctx = context(),
  turn = turnFor(),
  identity,
  limits = REVIEW_DISPUTE_DEFAULT_LIMITS,
  ...overrides
} = {}) {
  return dispatchDisputeSubTurn({
    turn,
    context: ctx,
    identity: identity ?? identityFor(turn),
    limits,
    runner: createArbitrationSubTurnRunner(runtime(overrides)),
  });
}

/** The one applied lineage transition of a completion. */
function appliedRow(completion) {
  expect(completion.transition).not.toBeNull();
  expect(completion.transition.applied).toHaveLength(1);
  return completion.transition.applied[0];
}

function arbitrationSummary(completion) {
  return completion.result.context[REVIEW_DISPUTE_ARBITRATION_CONTEXT_KEY];
}

// ---------------------------------------------------------------------------
// 1. Rows 13–18: the four §8.1 verdicts
// ---------------------------------------------------------------------------

describe('every verdict reaches exactly one §7 row', () => {
  test('row 13: a confident `reviewer_correct` makes the finding binding', async () => {
    const calls = [];
    const completion = await dispatch({ invoke: invokeVerdict(verdictRecord(), calls) });

    expect(completion.disposition).toBe('applied');
    expect(completion.result.result).toBe('success');
    expect(appliedRow(completion)).toMatchObject({
      lineageId: LINEAGE,
      row: 13,
      fromState: 'arbitration_pending',
      toState: 'binding',
      auditEvent: 'dispute.arbitration.verdict',
      reason: 'reviewer-correct',
      actor: 'arbiter',
      replayed: false,
    });
    // §8.3: passes count RETURNED verdicts, whatever the row decided.
    expect(appliedRow(completion).countersAfter.arbitrationPasses).toBe(1);
    expect(appliedRow(completion).countersAfter.malformedArbiterAttempts).toBe(0);
    // §7.1 rule 2: `binding` is the implementer's turn, not a resolution.
    expect(completion.transition.routing).toMatchObject({ rule: 2, turn: 'implementer', nextPhase: 'implementation' });
    // The arbiter #839 selected is the only agent invoked — never either party.
    expect(calls).toHaveLength(1);
    expect(calls[0].selection.profile.agentId).toBe('claude');
    expect(calls[0].run.runId).toBe(DERIVED_RUN_ID);
  });

  test('row 14: a confident `implementer_correct` overrules the finding', async () => {
    const completion = await dispatch({
      invoke: invokeVerdict(verdictRecord({ verdict: 'implementer_correct', confidence: 0.91 })),
    });

    expect(appliedRow(completion)).toMatchObject({
      row: 14,
      toState: 'resolved_overruled',
      // §10.3: the terminal lineage's RESOLUTION is the event, not the verdict.
      auditEvent: 'dispute.resolved',
      reason: 'implementer-correct',
    });
    expect(appliedRow(completion).countersAfter.arbitrationPasses).toBe(1);
  });

  test('row 15: `spec_ambiguous` escalates whatever its confidence', async () => {
    const completion = await dispatch({
      invoke: invokeVerdict(verdictRecord({ verdict: 'spec_ambiguous', confidence: 0.99 })),
    });

    expect(appliedRow(completion)).toMatchObject({
      row: 15,
      toState: 'escalated_human',
      auditEvent: 'dispute.escalated.human',
      reason: 'spec-ambiguous',
    });
    // A verdict was returned, so the pass is spent even though nothing decided.
    expect(appliedRow(completion).countersAfter.arbitrationPasses).toBe(1);
    expect(completion.transition.routing.readyForHuman).toBe(true);
  });

  test('row 16: `insufficient_evidence` requests the one bounded round', async () => {
    const completion = await dispatch({
      invoke: invokeVerdict(verdictRecord({ verdict: 'insufficient_evidence', confidence: 0.8 })),
    });

    expect(appliedRow(completion)).toMatchObject({
      row: 16,
      toState: 'evidence_requested',
      auditEvent: 'dispute.evidence.requested',
      reason: 'insufficient-evidence',
    });
    // §6.1: row 16 REQUESTS the round; row 22 is what marks it used, so a
    // requested-but-never-answered round stays distinguishable from a spent one.
    expect(appliedRow(completion).countersAfter).toMatchObject({ arbitrationPasses: 1, evidenceRoundsUsed: 0 });
    const route = arbitrationSummary(completion).route;
    expect(route.evidence).toMatchObject({ available: true, budget: 1, used: 0, unavailableReason: null });
  });

  test('row 17: the same verdict escalates once the round is already spent', async () => {
    const completion = await dispatch({
      ctx: context({ [LINEAGE]: lineage({ counters: { evidenceRoundsUsed: 1 } }) }),
      invoke: invokeVerdict(verdictRecord({ verdict: 'insufficient_evidence', confidence: 0.8 })),
    });

    expect(appliedRow(completion)).toMatchObject({
      row: 17,
      toState: 'escalated_human',
      reason: 'insufficient-evidence-round-unavailable',
    });
    expect(arbitrationSummary(completion).route.evidence.unavailableReason).toBe('round-consumed');
  });

  test('row 17: and when no arbitration pass would remain to weigh the evidence', async () => {
    // §6.1's other half: the round budget is untouched, but this verdict spends
    // the last pass, so a collected round would have nobody left to present it to.
    const completion = await dispatch({
      ctx: context({
        [LINEAGE]: lineage({
          counters: { arbitrationPasses: REVIEW_DISPUTE_DEFAULT_LIMITS.maxArbitrationPassesPerLineage - 1 },
        }),
      }),
      invoke: invokeVerdict(verdictRecord({ verdict: 'insufficient_evidence', confidence: 0.8 })),
    });

    expect(appliedRow(completion)).toMatchObject({ row: 17, toState: 'escalated_human' });
    expect(arbitrationSummary(completion).route.evidence).toMatchObject({
      unavailableReason: 'no-remaining-arbitration-pass',
      arbitrationPassesRemaining: 0,
    });
  });

  test('row 17: and when the session configured the round away entirely', async () => {
    const limits = { ...REVIEW_DISPUTE_DEFAULT_LIMITS, maxEvidenceRoundsPerLineage: 0 };
    const completion = await dispatch({
      limits,
      settings: settings({}, limits),
      invoke: invokeVerdict(verdictRecord({ verdict: 'insufficient_evidence', confidence: 0.8 })),
    });

    expect(appliedRow(completion)).toMatchObject({ row: 17, toState: 'escalated_human' });
    expect(arbitrationSummary(completion).route.evidence.unavailableReason).toBe('round-budget-zero');
  });
});

// ---------------------------------------------------------------------------
// 2. §8.3's confidence threshold
// ---------------------------------------------------------------------------

describe('the minConfidence boundary', () => {
  test.each([
    ['reviewer_correct', 13, 'binding'],
    ['implementer_correct', 14, 'resolved_overruled'],
  ])('a %s verdict AT the threshold decides (row %i)', async (verdict, row, toState) => {
    // Exactly `minConfidence`: §8.3's gate is "below the threshold", so the
    // boundary value itself decides rather than escalating.
    const completion = await dispatch({ invoke: invokeVerdict(verdictRecord({ verdict, confidence: 0.7 })) });
    expect(appliedRow(completion)).toMatchObject({ row, toState });
  });

  test.each(['reviewer_correct', 'implementer_correct'])(
    'a %s verdict just BELOW the threshold decides nothing (row 18)',
    async (verdict) => {
      const completion = await dispatch({
        invoke: invokeVerdict(verdictRecord({ verdict, confidence: 0.699 })),
      });
      expect(appliedRow(completion)).toMatchObject({
        row: 18,
        toState: 'escalated_human',
        reason: 'low-confidence-verdict',
      });
      // Neither party wins by default, and the returned verdict still spends a pass.
      expect(appliedRow(completion).countersAfter.arbitrationPasses).toBe(1);
    },
  );

  test('a session-raised threshold moves the boundary with it', async () => {
    const completion = await dispatch({
      settings: settings({ minConfidence: 0.95 }),
      invoke: invokeVerdict(verdictRecord({ confidence: 0.9 })),
    });
    expect(appliedRow(completion)).toMatchObject({ row: 18, reason: 'low-confidence-verdict' });
    expect(arbitrationSummary(completion).route.confidence).toMatchObject({
      decisive: true,
      confidence: 0.9,
      minConfidence: 0.95,
      meetsMinConfidence: false,
    });
  });
});

// ---------------------------------------------------------------------------
// 3. Row 19: no acceptable independent arbiter
// ---------------------------------------------------------------------------

describe('an unavailable arbiter is row 19, never a party winning by default', () => {
  test('no candidate list escalates and spends no counter', async () => {
    const calls = [];
    const completion = await dispatch({
      settings: settings({ providers: [] }),
      invoke: invokeVerdict(verdictRecord(), calls),
    });

    expect(appliedRow(completion)).toMatchObject({
      row: 19,
      toState: 'escalated_human',
      auditEvent: 'dispute.escalated.human',
      reason: 'no-acceptable-arbiter',
      actor: 'arbiter',
    });
    // §8.3: nothing was invoked, so nothing was spent.
    expect(appliedRow(completion).countersAfter).toEqual(lineage().counters);
    expect(calls).toHaveLength(0);
    expect(arbitrationSummary(completion).route.arbiterUnavailable).toBe('no-candidates');
  });

  test('a candidate list that shares a provider with a party is refused, not substituted', async () => {
    const calls = [];
    const completion = await dispatch({
      // The only candidate is on the review party's own provider, and §8.3's
      // same-provider opt-in is off.
      review: { agentId: 'claude', model: 'claude-sonnet-4-5' },
      invoke: invokeVerdict(verdictRecord(), calls),
    });

    expect(appliedRow(completion)).toMatchObject({ row: 19, toState: 'escalated_human' });
    expect(calls).toHaveLength(0);
    const summary = arbitrationSummary(completion);
    expect(summary.route.arbiterUnavailable).toBe('no-acceptable-candidate');
    // The audit an operator reads: what was tried and why each was passed over.
    expect(summary.candidateRejections.map((r) => r.reason)).toEqual(['same-provider-not-allowed']);
  });
});

// ---------------------------------------------------------------------------
// 4. Rows 20–21: §12's malformed-attempt budget
// ---------------------------------------------------------------------------

describe('malformed arbiter output spends the §12 budget and never a pass', () => {
  test.each(['empty-output', 'malformed-response'])('row 20: a below-cap %s attempt retries', async (kind) => {
    const completion = await dispatch({ invoke: invokeFailure({ kind, detail: null }) });

    expect(appliedRow(completion)).toMatchObject({
      row: 20,
      fromState: 'arbitration_pending',
      // The lineage STAYS pending: the arbiter is re-invoked under #839's own
      // selection policy, which is what makes row 20 a retry rather than a stop.
      toState: 'arbitration_pending',
      auditEvent: 'dispute.arbitration.malformed',
      reason: 'malformed-arbiter-output',
    });
    expect(appliedRow(completion).countersAfter).toMatchObject({
      malformedArbiterAttempts: 1,
      arbitrationPasses: 0,
    });
    // §7.1: the next normative turn is selected automatically — the runner turn
    // again, which the review phase dispatches (issue #955).
    expect(completion.transition.routing).toMatchObject({ rule: 2, turn: 'runner', nextPhase: 'review' });
  });

  test('row 21: the attempt that REACHES the cap escalates', async () => {
    const cap = REVIEW_DISPUTE_DEFAULT_LIMITS.maxMalformedArbiterAttemptsPerLineage;
    const completion = await dispatch({
      ctx: context({ [LINEAGE]: lineage({ counters: { malformedArbiterAttempts: cap - 1 } }) }),
      invoke: invokeFailure({ kind: 'malformed-response', detail: 'verdict:absent' }),
    });

    expect(appliedRow(completion)).toMatchObject({
      row: 21,
      toState: 'escalated_human',
      auditEvent: 'dispute.escalated.human',
      reason: 'malformed-arbiter-cap-reached',
    });
    expect(appliedRow(completion).countersAfter).toMatchObject({
      malformedArbiterAttempts: cap,
      arbitrationPasses: 0,
    });
  });

  test('a lineage already at the cap escalates rather than retrying without bound', async () => {
    const cap = REVIEW_DISPUTE_DEFAULT_LIMITS.maxMalformedArbiterAttemptsPerLineage;
    const completion = await dispatch({
      ctx: context({ [LINEAGE]: lineage({ counters: { malformedArbiterAttempts: cap } }) }),
      invoke: invokeFailure({ kind: 'empty-output', detail: null }),
    });
    // §6.1's ceiling is enforced by the transition layer even though #847 named
    // row 21: the counter may not exceed the cap, so the row is refused and the
    // debate stops where it is rather than being written past its own bound.
    expect(completion.disposition).toBe('parked');
    expect(completion.failure.kind).toBe('stale_lineage');
    expect(completion.failure.protocol).toMatchObject({ reason: 'too-many-items' });
    // A park carries no application at all: nothing was written.
    expect(completion.transition).toBeNull();
    expect(completion.result.result).toBe('blocked');
  });
});

// ---------------------------------------------------------------------------
// 5. Operational failures: no row, no counter, no state change
// ---------------------------------------------------------------------------

describe('a failure that is not the arbiter\'s answer instantiates no row', () => {
  test('a killed agent parks as a timeout, distinct from one that ran and refused', async () => {
    // #953's lesson on the arbiter lane: #846 reports both as `agent-failed`, so
    // the deadline fact travels separately or every timeout reads as a refusal.
    const completion = await dispatch({
      invoke: invokeFailure({ kind: 'agent-failed', detail: 'timeout' }, { timedOut: true, exitCode: null }),
    });

    expect(completion.disposition).toBe('parked');
    expect(completion.result.result).toBe('blocked');
    expect(completion.failure).toMatchObject({ kind: 'timeout' });
    expect(completion.transition).toBeNull();
    expect(arbitrationSummary(completion).route).toMatchObject({
      row: null,
      intent: 'operational_failure',
      reason: 'operational-failure',
      operational: { kind: 'agent-failed', failureClass: 'agent-unavailable' },
    });
    // Nothing may be replayed from a run that instantiated no row.
    expect(completion.result.context[REVIEW_DISPUTE_ARBITRATION_APPLIED_CONTEXT_KEY]).toBeUndefined();
  });

  test('a nonzero exit parks as an invocation failure, not as malformed output', async () => {
    const completion = await dispatch({
      invoke: invokeFailure({ kind: 'agent-failed', detail: 'exit:1' }, { timedOut: false, exitCode: 1 }),
    });
    expect(completion.failure.kind).toBe('invocation_failed');
    // §12's malformed budget belongs to the arbiter's ANSWER; an agent that never
    // answered must not shorten it.
    expect(completion.transition).toBeNull();
  });

  test('an exhausted arbitration-pass budget refuses before any row fires', async () => {
    const completion = await dispatch({
      ctx: context({
        [LINEAGE]: lineage({
          counters: { arbitrationPasses: REVIEW_DISPUTE_DEFAULT_LIMITS.maxArbitrationPassesPerLineage },
        }),
      }),
      invoke: invokeVerdict(verdictRecord()),
    });

    expect(completion.disposition).toBe('parked');
    expect(completion.failure.kind).toBe('stale_lineage');
    expect(arbitrationSummary(completion).route.operational).toMatchObject({
      kind: 'arbitration-passes-exhausted',
      failureClass: 'precondition',
    });
  });

  test('a turn whose lineages have all left `arbitration_pending` parks', async () => {
    const completion = await dispatch({
      ctx: context({ [LINEAGE]: lineage({ state: 'binding' }) }),
      invoke: invokeVerdict(verdictRecord()),
    });
    // The dispatch layer refuses first: the block moved under the selected turn.
    expect(completion.disposition).toBe('parked');
    expect(completion.failure).toMatchObject({ kind: 'stale_lineage' });
  });

  test('a missing reconsideration directory parks without invoking anything', async () => {
    const calls = [];
    const completion = await dispatch({
      reconsiderationArtifactDir: '',
      invoke: invokeVerdict(verdictRecord(), calls),
    });
    expect(completion.disposition).toBe('parked');
    expect(completion.failure).toMatchObject({ kind: 'invocation_failed', detail: 'reconsiderationArtifactDir:absent' });
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 6. One lineage per dispatch
// ---------------------------------------------------------------------------

describe('one arbitration answers one lineage', () => {
  test('the first pending lineage is answered and the rest are left for the next cycle', async () => {
    const calls = [];
    const ctx = context({
      [LINEAGE]: lineage(),
      [LINEAGE_B]: lineage({ lineageId: LINEAGE_B, disputeRuns: [{ version: 1, runId: 'run-impl-1' }] }),
    });
    const turn = turnFor([LINEAGE, LINEAGE_B]);
    // A terminal row for the answered lineage, so the turn §7.1 selects next is
    // decided by the SIBLING rather than by the row this dispatch applied.
    const record = verdictRecord({ verdict: 'implementer_correct', confidence: 0.91 });
    const completion = await dispatch({ ctx, turn, invoke: invokeVerdict(record, calls) });

    expect(calls).toHaveLength(1);
    expect(calls[0].pending.lineageId).toBe(LINEAGE);
    expect(appliedRow(completion).lineageId).toBe(LINEAGE);
    // The sibling is untouched — same state, same counters — and §7.1 selects the
    // runner turn again for it.
    const after = completion.transition.context.lineages[LINEAGE_B];
    expect(after).toMatchObject({ state: 'arbitration_pending', counters: ctx.lineages[LINEAGE_B].counters });
    expect(completion.transition.routing).toMatchObject({ turn: 'runner', nextPhase: 'review' });
  });
});

// ---------------------------------------------------------------------------
// 7. Replay: a re-delivered claim buys no second verdict
// ---------------------------------------------------------------------------

describe('a duplicate delivery replays the committed row', () => {
  /** The block as it stands after a committed row, with #840's ledger entry. */
  function afterRow(state, { version = 1, counters = {}, runId = DERIVED_RUN_ID } = {}) {
    return context({
      [LINEAGE]: lineage({
        state,
        version,
        counters: { arbitrationPasses: 1, ...counters },
        appliedTransitions: [transitionDigest(LINEAGE, version, runId)],
      }),
    });
  }

  const RECORD = {
    lineages: {
      [LINEAGE]: {
        runId: DERIVED_RUN_ID,
        version: 1,
        row: 13,
        intent: 'implementation',
        reason: 'reviewer-correct',
        auditEvent: 'dispute.arbitration.verdict',
        nextState: 'binding',
        arbitrationPasses: 1,
        malformedArbiterAttempts: 0,
      },
    },
  };

  test('the same run id replays row 13 without invoking the arbiter or moving a counter', async () => {
    const calls = [];
    const ctx = afterRow('binding');
    const before = ctx.lineages[LINEAGE].counters;
    const completion = await dispatch({ ctx, applied: RECORD, invoke: invokeVerdict(verdictRecord(), calls) });

    expect(calls).toHaveLength(0);
    expect(completion.disposition).toBe('replayed');
    expect(completion.result.result).toBe('success');
    // The previously committed application, reported identically — and nothing
    // written: the block is byte-identical to the one on file.
    expect(appliedRow(completion)).toMatchObject({
      lineageId: LINEAGE,
      row: 13,
      toState: 'binding',
      reason: 'reviewer-correct',
      replayed: true,
    });
    expect(completion.transition.unchanged).toBe(true);
    expect(completion.transition.replayed).toBe(true);
    expect(completion.transition.context.lineages[LINEAGE].counters).toEqual(before);
    // The routing a replay reports is the routing the first delivery reported.
    expect(completion.transition.routing).toMatchObject({ turn: 'implementer', nextPhase: 'implementation' });
    expect(arbitrationSummary(completion).route.replayed).toBe(true);
  });

  test('a row-20 redelivery replays the retry rather than spending a second attempt', async () => {
    const calls = [];
    const ctx = context({
      [LINEAGE]: lineage({
        counters: { malformedArbiterAttempts: 1 },
        appliedTransitions: [transitionDigest(LINEAGE, 1, DERIVED_RUN_ID)],
      }),
    });
    const completion = await dispatch({
      ctx,
      applied: {
        lineages: {
          [LINEAGE]: {
            runId: DERIVED_RUN_ID,
            version: 1,
            row: 20,
            intent: 'arbitration_retry',
            reason: 'malformed-arbiter-output',
            auditEvent: 'dispute.arbitration.malformed',
            nextState: 'arbitration_pending',
            arbitrationPasses: 0,
            malformedArbiterAttempts: 1,
          },
        },
      },
      invoke: invokeFailure({ kind: 'empty-output', detail: null }, {}, calls),
    });

    expect(calls).toHaveLength(0);
    expect(completion.disposition).toBe('replayed');
    expect(appliedRow(completion)).toMatchObject({ row: 20, replayed: true });
    expect(completion.transition.context.lineages[LINEAGE].counters.malformedArbiterAttempts).toBe(1);
  });

  test('a record with no matching ledger entry is not a replay: the run is still owed', async () => {
    // The record is written by the run that produced the decision, so a run whose
    // transition was REFUSED leaves one describing a row that never applied. The
    // ledger — which only names committed transitions — is what admits it.
    const calls = [];
    const completion = await dispatch({ applied: RECORD, invoke: invokeVerdict(verdictRecord(), calls) });

    expect(calls).toHaveLength(1);
    expect(completion.disposition).toBe('applied');
    expect(appliedRow(completion)).toMatchObject({ row: 13, replayed: false });
  });

  test('a DIFFERENT claim is a new attempt, not a replay of the recorded one', async () => {
    const calls = [];
    const turn = turnFor();
    const completion = await dispatch({
      turn,
      identity: identityFor(turn, 'run-review-10'),
      applied: RECORD,
      invoke: invokeVerdict(verdictRecord(), calls),
    });

    expect(calls).toHaveLength(1);
    expect(completion.disposition).toBe('applied');
  });

  test('a committed row is recorded for the NEXT delivery to recognize', async () => {
    const completion = await dispatch({ invoke: invokeVerdict(verdictRecord()) });
    const record = completion.result.context[REVIEW_DISPUTE_ARBITRATION_APPLIED_CONTEXT_KEY];
    expect(record.lineages[LINEAGE]).toEqual({
      runId: DERIVED_RUN_ID,
      version: 1,
      row: 13,
      intent: 'implementation',
      reason: 'reviewer-correct',
      auditEvent: 'dispute.arbitration.verdict',
      nextState: 'binding',
      arbitrationPasses: 1,
      malformedArbiterAttempts: 0,
    });
    // An earlier lineage's entry survives the write, so a task arbitrating two
    // lineages across two runs keeps both.
    const second = await dispatch({
      applied: { lineages: { [LINEAGE_B]: { ...RECORD.lineages[LINEAGE], runId: 'run-old~runner.0' } } },
      invoke: invokeVerdict(verdictRecord()),
    });
    const merged = second.result.context[REVIEW_DISPUTE_ARBITRATION_APPLIED_CONTEXT_KEY];
    expect(Object.keys(merged.lineages).sort()).toEqual([LINEAGE, LINEAGE_B].sort());
  });
});

// ---------------------------------------------------------------------------
// 8. The persisted record is admitted, never trusted
// ---------------------------------------------------------------------------

describe('parseArbitrationAppliedRecord', () => {
  test('drops entries it could not have written and keeps the rest', () => {
    const parsed = parseArbitrationAppliedRecord({
      lineages: {
        [LINEAGE]: {
          runId: DERIVED_RUN_ID,
          version: 1,
          row: 13,
          intent: 'implementation',
          reason: 'reviewer-correct',
          auditEvent: 'dispute.arbitration.verdict',
          nextState: 'binding',
          arbitrationPasses: 1,
          malformedArbiterAttempts: 0,
        },
        // Row 22 belongs to the evidence round, not to this turn's router.
        [LINEAGE_B]: {
          runId: DERIVED_RUN_ID,
          version: 1,
          row: 22,
          intent: 'implementation',
          reason: 'reviewer-correct',
          auditEvent: 'dispute.arbitration.verdict',
          nextState: 'binding',
          arbitrationPasses: 1,
          malformedArbiterAttempts: 0,
        },
      },
    });
    expect(Object.keys(parsed.lineages)).toEqual([LINEAGE]);
  });

  test.each([
    ['a missing run id', { runId: '' }],
    ['a counter movement wider than one', { arbitrationPasses: 2 }],
    ['an audit event outside §10.3', { auditEvent: 'dispute.made.up' }],
    ['a state outside the lineage vocabulary', { nextState: 'decided' }],
    ['a version below one', { version: 0 }],
  ])('refuses %s', (_name, overrides) => {
    const parsed = parseArbitrationAppliedRecord({
      lineages: {
        [LINEAGE]: {
          runId: DERIVED_RUN_ID,
          version: 1,
          row: 13,
          intent: 'implementation',
          reason: 'reviewer-correct',
          auditEvent: 'dispute.arbitration.verdict',
          nextState: 'binding',
          arbitrationPasses: 1,
          malformedArbiterAttempts: 0,
          ...overrides,
        },
      },
    });
    expect(parsed.lineages).toEqual({});
  });

  test.each([undefined, null, 'nonsense', { lineages: 7 }])('an unusable record reads as empty', (value) => {
    expect(parseArbitrationAppliedRecord(value).lineages).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// 9. The review-phase gate
// ---------------------------------------------------------------------------

describe('the review phase dispatches the runner turn', () => {
  const reconsiderationRuntime = {
    issueBody: 'body',
    disputeArtifactDir: '/artifacts/runs/run-impl-1',
    artifactDir: '/artifacts/runs/run-review-9',
    artifactRoot: '/artifacts',
    repoCwd: '/worktree',
    agentId: 'gemini',
    timestamp: '2026-08-05T03:00:00.000Z',
  };

  async function gate(overrides = {}) {
    return runReviewDisputeSubTurn({
      enabled: true,
      limits: REVIEW_DISPUTE_DEFAULT_LIMITS,
      persisted: context(),
      runId: RUN_ID,
      runtime: reconsiderationRuntime,
      ...overrides,
    });
  }

  test('an arbitration turn with a runtime routes the verdict', async () => {
    const result = await gate({ arbitration: runtime({ invoke: invokeVerdict(verdictRecord()) }) });

    expect(result.kind).toBe('handled');
    expect(result.result.result).toBe('success');
    expect(result.result.disputeTransition.applied[0]).toMatchObject({ row: 13, toState: 'binding' });
    const summary = result.result.context[REVIEW_DISPUTE_SUB_TURN_CONTEXT_KEY];
    expect(summary).toMatchObject({ turn: 'runner_arbitration', taskTurn: 'runner', disposition: 'applied' });
  });

  test('an arbitration turn with NO runtime parks exactly as it did before', async () => {
    const result = await gate();

    expect(result.kind).toBe('handled');
    expect(result.result.result).toBe('blocked');
    const summary = result.result.context[REVIEW_DISPUTE_SUB_TURN_CONTEXT_KEY];
    expect(summary).toMatchObject({ turn: 'runner_arbitration', failure: 'no_implementation' });
  });

  test('the evidence turn without a supplied runtime still parks (issue #964 gates it on one)', async () => {
    const result = await gate({
      persisted: context({ [LINEAGE]: lineage({ state: 'evidence_requested', counters: { arbitrationPasses: 1 } }) }),
      arbitration: runtime({ invoke: invokeVerdict(verdictRecord()) }),
    });

    expect(result.result.result).toBe('blocked');
    expect(result.result.context[REVIEW_DISPUTE_SUB_TURN_CONTEXT_KEY]).toMatchObject({
      turn: 'evidence_collection',
      failure: 'no_implementation',
    });
  });

  test('an ordinary review is still an ordinary review', async () => {
    const result = await gate({
      persisted: context({
        [LINEAGE]: lineage({
          state: 'open',
          counters: { rebuttals: 0, reconsiderations: 0 },
          rebuttedVersions: [],
          disputeRuns: [],
        }),
      }),
      arbitration: runtime({ invoke: invokeVerdict(verdictRecord()) }),
    });
    // An `open` lineage is the implementer's turn; the review phase falls through.
    expect(result.kind).toBe('ordinary_review');
  });

  test('the arbiter\'s rationale never reaches task context', async () => {
    const result = await gate({ arbitration: runtime({ invoke: invokeVerdict(verdictRecord()) }) });
    const serialized = JSON.stringify(result.result.context);
    expect(serialized).not.toContain(RATIONALE);
    // The bounded projection travels instead: a character count and the literals.
    expect(arbitrationSummary({ result: result.result }).invocation.verdict.rationaleChars).toBe(RATIONALE.length);
  });
});

// ---------------------------------------------------------------------------
// 10. The reviewer run this turn arbitrates is the SELECTED lineage's (P1)
// ---------------------------------------------------------------------------

describe('the reconsideration of record is looked up per lineage', () => {
  /** Two disputed findings, both awaiting the runner's turn. */
  const twoLineages = () =>
    context({
      [LINEAGE]: lineage(),
      [LINEAGE_B]: lineage({ lineageId: LINEAGE_B, disputeRuns: [{ version: 1, runId: 'run-impl-1' }] }),
    });

  /**
   * What two reviewer runs leave behind. A reviewer sub-turn answers ONE lineage
   * per review run, so the single-valued runtime values — the directory
   * `/artifacts/runs/run-review-2` and the `gemini` review party — are the SECOND
   * run's, while this turn arbitrates the first still-pending lineage.
   */
  const perLineage = (first = { artifactDir: '/artifacts/runs/run-review-1', agentId: 'codex' }) => ({
    lineages: {
      [LINEAGE]: { version: 1, ...first },
      [LINEAGE_B]: { version: 1, artifactDir: '/artifacts/runs/run-review-2', agentId: 'gemini' },
    },
  });

  test('the bundle reads the selected lineage\'s reconsideration directory', async () => {
    const calls = [];
    const completion = await dispatch({
      ctx: twoLineages(),
      turn: turnFor([LINEAGE, LINEAGE_B]),
      reconsiderations: perLineage(),
      invoke: invokeVerdict(verdictRecord(), calls),
    });

    expect(completion.disposition).toBe('applied');
    expect(calls).toHaveLength(1);
    expect(calls[0].pending.lineageId).toBe(LINEAGE);
    // Not the runtime's `/artifacts/runs/run-review-2`, which holds
    // `reconsideration-<LINEAGE_B>.json` and would park this lineage on a
    // missing artifact that exists one directory over.
    expect(calls[0].reconsiderationArtifactDir).toBe('/artifacts/runs/run-review-1');
    // The fix run's own directory is unaffected: it is written once per debate.
    expect(calls[0].disputeArtifactDir).toBe('/artifacts/runs/run-impl-1');
  });

  test('§8.3 measures independence against the reviewer that answered THIS lineage', async () => {
    const completion = await dispatch({
      ctx: twoLineages(),
      turn: turnFor([LINEAGE, LINEAGE_B]),
      reconsiderations: perLineage(),
      invoke: invokeVerdict(verdictRecord()),
    });

    expect(appliedRow(completion)).toMatchObject({ lineageId: LINEAGE, row: 13 });
    // `codex`, from the record — not the runtime's `gemini`, which reviewed the
    // sibling. Read back as an id alone: the provider is re-derived from it and
    // the model stays unknown.
    expect(arbitrationSummary(completion).parties.review).toEqual({
      role: 'review',
      agentId: 'codex',
      provider: 'openai',
      model: null,
    });
  });

  test('a reviewer of record on the candidate\'s own provider is refused, not substituted', async () => {
    const calls = [];
    const completion = await dispatch({
      ctx: twoLineages(),
      turn: turnFor([LINEAGE, LINEAGE_B]),
      // This lineage was reconsidered by the only configured candidate's own
      // provider. Measured against the LAST reviewer run (`gemini`) the candidate
      // looks independent and would judge its own reconsideration — the
      // independence violation P1 names.
      reconsiderations: perLineage({ artifactDir: '/artifacts/runs/run-review-1', agentId: 'claude' }),
      invoke: invokeVerdict(verdictRecord(), calls),
    });

    expect(appliedRow(completion)).toMatchObject({ row: 19, toState: 'escalated_human' });
    expect(calls).toHaveLength(0);
    expect(arbitrationSummary(completion).candidateRejections.map((r) => r.reason))
      .toEqual(['same-provider-not-allowed']);
  });

  test.each([
    ['no record at all', undefined],
    [
      'a record naming only the sibling',
      { lineages: { [LINEAGE_B]: { version: 1, artifactDir: '/artifacts/runs/run-review-2', agentId: 'codex' } } },
    ],
    [
      'an entry for a version this lineage has not reached',
      { lineages: { [LINEAGE]: { version: 2, artifactDir: '/artifacts/runs/run-review-1', agentId: 'codex' } } },
    ],
    [
      'an entry with no usable directory',
      { lineages: { [LINEAGE]: { version: 1, artifactDir: '', agentId: 'codex' } } },
    ],
    ['an unreadable record', 'nonsense'],
  ])('%s leaves the caller\'s own values in place', async (_name, reconsiderations) => {
    const calls = [];
    const completion = await dispatch({
      ctx: twoLineages(),
      turn: turnFor([LINEAGE, LINEAGE_B]),
      ...(reconsiderations === undefined ? {} : { reconsiderations }),
      invoke: invokeVerdict(verdictRecord(), calls),
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].reconsiderationArtifactDir).toBe('/artifacts/runs/run-review-2');
    expect(arbitrationSummary(completion).parties.review).toMatchObject({ agentId: 'gemini' });
  });

  test('an entry naming an agent this runner does not know keeps the caller\'s party', async () => {
    // The directory is still this lineage's own — a path is a path, and the
    // invocation re-checks it against the artifact root. Only the identity is
    // dropped: §8.3 has no provider to measure against for a name this process
    // cannot resolve.
    const calls = [];
    const completion = await dispatch({
      ctx: twoLineages(),
      turn: turnFor([LINEAGE, LINEAGE_B]),
      reconsiderations: perLineage({ artifactDir: '/artifacts/runs/run-review-1', agentId: 'reviewer-of-the-year' }),
      invoke: invokeVerdict(verdictRecord(), calls),
    });

    expect(calls[0].reconsiderationArtifactDir).toBe('/artifacts/runs/run-review-1');
    expect(arbitrationSummary(completion).parties.review).toMatchObject({ agentId: 'gemini' });
  });
});

// ---------------------------------------------------------------------------
// 10b. The single-valued reviewer summary is admitted per lineage too (P1)
// ---------------------------------------------------------------------------

describe('the reviewer summary is believed only for the lineage it named', () => {
  /** Two disputed findings, both awaiting the runner's turn. */
  const twoLineages = () =>
    context({
      [LINEAGE]: lineage(),
      [LINEAGE_B]: lineage({ lineageId: LINEAGE_B, disputeRuns: [{ version: 1, runId: 'run-impl-1' }] }),
    });

  /**
   * `task.context.reviewDisputeReconsideration`: the LAST reviewer sub-turn's
   * own invocation summary, which is the only place a debate older than the
   * per-lineage record wrote its reviewer down — and, being single-valued, names
   * whichever lineage that run answered.
   */
  const summary = (overrides = {}) => ({
    lineageId: LINEAGE,
    version: 1,
    profile: { agentId: 'codex', provider: 'openai', model: 'gpt-5-codex' },
    ...overrides,
  });

  test('a summary for THIS lineage supplies the reviewer the record is missing', async () => {
    const calls = [];
    const completion = await dispatch({
      ctx: twoLineages(),
      turn: turnFor([LINEAGE, LINEAGE_B]),
      reconsiderationSummary: summary(),
      invoke: invokeVerdict(verdictRecord(), calls),
    });

    expect(appliedRow(completion)).toMatchObject({ lineageId: LINEAGE, row: 13 });
    // `codex`, from the summary — not the caller's `gemini`. Read back as an id
    // alone, like every other persisted identity.
    expect(arbitrationSummary(completion).parties.review).toEqual({
      role: 'review',
      agentId: 'codex',
      provider: 'openai',
      model: null,
    });
    // Only the identity: the directory a summary names is its own run's, and the
    // caller's per-lineage resolution of it stands.
    expect(calls[0].reconsiderationArtifactDir).toBe('/artifacts/runs/run-review-2');
  });

  test('a summary for THIS lineage on the candidate\'s provider refuses the candidate', async () => {
    const calls = [];
    const completion = await dispatch({
      ctx: twoLineages(),
      turn: turnFor([LINEAGE, LINEAGE_B]),
      reconsiderationSummary: summary({ profile: { agentId: 'claude', model: 'claude-sonnet-4-5' } }),
      invoke: invokeVerdict(verdictRecord(), calls),
    });

    expect(appliedRow(completion)).toMatchObject({ row: 19, toState: 'escalated_human' });
    expect(calls).toHaveLength(0);
    expect(arbitrationSummary(completion).candidateRejections.map((r) => r.reason))
      .toEqual(['same-provider-not-allowed']);
  });

  test('a summary for the SIBLING lineage never displaces the caller\'s reviewer', async () => {
    // The violation P1 names, in the direction that actually harms: the selected
    // finding was reviewed by `claude`, and an earlier reconsideration of the
    // sibling by `gemini` would make the only configured candidate look
    // independent — leaving it to judge its own review.
    const calls = [];
    const completion = await dispatch({
      ctx: twoLineages(),
      turn: turnFor([LINEAGE, LINEAGE_B]),
      review: { agentId: 'claude', model: 'claude-sonnet-4-5' },
      reconsiderationSummary: summary({
        lineageId: LINEAGE_B,
        profile: { agentId: 'gemini', provider: 'google', model: 'gemini-3.1-pro' },
      }),
      invoke: invokeVerdict(verdictRecord(), calls),
    });

    // No candidate survives, so the summary carries no `parties` to inspect: the
    // rejection is the proof, and `claude` is the only party-side provider the
    // candidate could have shared (the implementer is on OpenAI).
    expect(appliedRow(completion)).toMatchObject({ row: 19, toState: 'escalated_human' });
    expect(calls).toHaveLength(0);
    expect(arbitrationSummary(completion).candidateRejections.map((r) => r.reason))
      .toEqual(['same-provider-not-allowed']);
  });

  test('the per-lineage record outranks a summary naming the same lineage', async () => {
    const completion = await dispatch({
      ctx: twoLineages(),
      turn: turnFor([LINEAGE, LINEAGE_B]),
      reconsiderations: {
        lineages: { [LINEAGE]: { version: 1, artifactDir: '/artifacts/runs/run-review-1', agentId: 'codex' } },
      },
      reconsiderationSummary: summary({ profile: { agentId: 'claude', model: 'claude-sonnet-4-5' } }),
      invoke: invokeVerdict(verdictRecord()),
    });

    // The record names the run that answered THIS lineage; the summary is the
    // fall-back for a debate that has no such entry, not a second opinion.
    expect(appliedRow(completion)).toMatchObject({ lineageId: LINEAGE, row: 13 });
    expect(arbitrationSummary(completion).parties.review).toMatchObject({ agentId: 'codex' });
  });

  test.each([
    ['a version this lineage has not reached', { version: 4 }],
    ['an invocation that resolved no profile', { profile: null }],
    ['an agent this runner does not know', { profile: { agentId: 'reviewer-of-the-year' } }],
  ])('a summary with %s leaves the caller\'s reviewer in place', async (_name, overrides) => {
    const completion = await dispatch({
      ctx: twoLineages(),
      turn: turnFor([LINEAGE, LINEAGE_B]),
      reconsiderationSummary: summary(overrides),
      invoke: invokeVerdict(verdictRecord()),
    });

    expect(arbitrationSummary(completion).parties.review).toMatchObject({ agentId: 'gemini' });
  });
});

// ---------------------------------------------------------------------------
// 11. The fix run this turn arbitrates is the SELECTED lineage's too (P1)
// ---------------------------------------------------------------------------

describe('the rebuttal of record is looked up per lineage', () => {
  /** Two disputed findings, both awaiting the runner's turn. */
  const twoLineages = () =>
    context({
      [LINEAGE]: lineage({ disputeRuns: [{ version: 1, runId: 'run-impl-1' }] }),
      [LINEAGE_B]: lineage({ lineageId: LINEAGE_B, disputeRuns: [{ version: 1, runId: 'run-impl-2' }] }),
    });

  /**
   * What two fix runs leave behind. A fix run rebuts only the lineages ITS OWN
   * response disputed — a row 11 material revision sends one lineage back to the
   * implementer while the other stays disputed — so the single-valued runtime
   * values below (`/artifacts/runs/run-impl-2` and the `gemini` implementer) are
   * the SECOND run's, while this turn arbitrates the first still-pending lineage.
   */
  const perLineage = (first = { artifactDir: '/artifacts/runs/run-impl-1', agentId: 'codex' }) => ({
    lineages: {
      [LINEAGE]: { version: 1, ...first },
      [LINEAGE_B]: { version: 1, artifactDir: '/artifacts/runs/run-impl-2', agentId: 'gemini' },
    },
  });

  /** The last fix run's values, as the review handler resolves them today. */
  const lastFixRun = {
    disputeArtifactDir: '/artifacts/runs/run-impl-2',
    implementation: { agentId: 'gemini', model: 'gemini-3.1-pro' },
  };

  test('the bundle reads the selected lineage\'s rebuttal directory', async () => {
    const calls = [];
    const completion = await dispatch({
      ctx: twoLineages(),
      turn: turnFor([LINEAGE, LINEAGE_B]),
      ...lastFixRun,
      rebuttals: perLineage(),
      invoke: invokeVerdict(verdictRecord(), calls),
    });

    expect(completion.disposition).toBe('applied');
    expect(calls).toHaveLength(1);
    expect(calls[0].pending.lineageId).toBe(LINEAGE);
    // Not the runtime's `/artifacts/runs/run-impl-2`, which holds
    // `dispute-<LINEAGE_B>.json`: reading it would fail on a missing — or, worse,
    // an identity-mismatched — artifact and park a resolvable dispute.
    expect(calls[0].disputeArtifactDir).toBe('/artifacts/runs/run-impl-1');
    // The reviewer's directory is untouched by the implementer half.
    expect(calls[0].reconsiderationArtifactDir).toBe('/artifacts/runs/run-review-2');
  });

  test('§8.3 measures independence against the implementer that rebutted THIS lineage', async () => {
    const completion = await dispatch({
      ctx: twoLineages(),
      turn: turnFor([LINEAGE, LINEAGE_B]),
      ...lastFixRun,
      rebuttals: perLineage(),
      invoke: invokeVerdict(verdictRecord()),
    });

    expect(appliedRow(completion)).toMatchObject({ lineageId: LINEAGE, row: 13 });
    // `codex`, from the record — not the runtime's `gemini`, which rebutted the
    // sibling. Read back as an id alone: the provider is re-derived from it and
    // the model stays unknown.
    expect(arbitrationSummary(completion).parties.implementation).toEqual({
      role: 'implementation',
      agentId: 'codex',
      provider: 'openai',
      model: null,
    });
  });

  test('an implementer of record on the candidate\'s own provider is refused, not substituted', async () => {
    const calls = [];
    const completion = await dispatch({
      ctx: twoLineages(),
      turn: turnFor([LINEAGE, LINEAGE_B]),
      ...lastFixRun,
      // This lineage was rebutted by the only configured candidate's own
      // provider. Measured against the LAST fix run (`gemini`) the candidate
      // looks independent and would judge its own rebuttal — the independence
      // violation P1 names.
      rebuttals: perLineage({ artifactDir: '/artifacts/runs/run-impl-1', agentId: 'claude' }),
      invoke: invokeVerdict(verdictRecord(), calls),
    });

    expect(appliedRow(completion)).toMatchObject({ row: 19, toState: 'escalated_human' });
    expect(calls).toHaveLength(0);
    expect(arbitrationSummary(completion).candidateRejections.map((r) => r.reason))
      .toEqual(['same-provider-not-allowed']);
  });

  test.each([
    ['no record at all', undefined],
    [
      'a record naming only the sibling',
      { lineages: { [LINEAGE_B]: { version: 1, artifactDir: '/artifacts/runs/run-impl-2', agentId: 'codex' } } },
    ],
    [
      'an entry for a version this lineage has not reached',
      { lineages: { [LINEAGE]: { version: 2, artifactDir: '/artifacts/runs/run-impl-1', agentId: 'codex' } } },
    ],
    [
      'an entry with no usable directory',
      { lineages: { [LINEAGE]: { version: 1, artifactDir: '', agentId: 'codex' } } },
    ],
    ['an unreadable record', 'nonsense'],
  ])('%s leaves the caller\'s own values in place', async (_name, rebuttals) => {
    const calls = [];
    const completion = await dispatch({
      ctx: twoLineages(),
      turn: turnFor([LINEAGE, LINEAGE_B]),
      ...lastFixRun,
      ...(rebuttals === undefined ? {} : { rebuttals }),
      invoke: invokeVerdict(verdictRecord(), calls),
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].disputeArtifactDir).toBe('/artifacts/runs/run-impl-2');
    expect(arbitrationSummary(completion).parties.implementation).toMatchObject({ agentId: 'gemini' });
  });

  test('an entry naming an agent this runner does not know keeps the caller\'s party', async () => {
    // The directory is still this lineage's own — a path is a path, and the
    // invocation re-checks it against the artifact root. Only the identity is
    // dropped: §8.3 has no provider to measure against for a name this process
    // cannot resolve.
    const calls = [];
    const completion = await dispatch({
      ctx: twoLineages(),
      turn: turnFor([LINEAGE, LINEAGE_B]),
      ...lastFixRun,
      rebuttals: perLineage({ artifactDir: '/artifacts/runs/run-impl-1', agentId: 'implementer-of-the-year' }),
      invoke: invokeVerdict(verdictRecord(), calls),
    });

    expect(calls[0].disputeArtifactDir).toBe('/artifacts/runs/run-impl-1');
    expect(arbitrationSummary(completion).parties.implementation).toMatchObject({ agentId: 'gemini' });
  });

  test('both halves are selected for the same lineage in one dispatch', async () => {
    // The two records are written by different phases and read back
    // independently; what matters to §8.2 is that ONE lineage's directories and
    // ONE lineage's parties reach the same invocation.
    const calls = [];
    const completion = await dispatch({
      ctx: twoLineages(),
      turn: turnFor([LINEAGE, LINEAGE_B]),
      ...lastFixRun,
      rebuttals: perLineage(),
      reconsiderations: {
        lineages: {
          [LINEAGE]: { version: 1, artifactDir: '/artifacts/runs/run-review-1', agentId: 'codex' },
          [LINEAGE_B]: { version: 1, artifactDir: '/artifacts/runs/run-review-2', agentId: 'gemini' },
        },
      },
      invoke: invokeVerdict(verdictRecord(), calls),
    });

    expect(calls[0].pending.lineageId).toBe(LINEAGE);
    expect(calls[0].disputeArtifactDir).toBe('/artifacts/runs/run-impl-1');
    expect(calls[0].reconsiderationArtifactDir).toBe('/artifacts/runs/run-review-1');
    expect(arbitrationSummary(completion).parties).toMatchObject({
      implementation: { agentId: 'codex' },
      review: { agentId: 'codex' },
    });
  });
});

// ---------------------------------------------------------------------------
// 8. §7 row 22: the admitted round reaches the re-presented arbitration
// ---------------------------------------------------------------------------

/**
 * Issue #964 review, P1: after both evidence parties complete and row 22 returns
 * the lineage to `arbitration_pending`, the arbitration invoked next must carry
 * the round's admitted attachments — resolved from the persisted round record
 * and each party's own §10.2 record file, which is the only place an
 * `issue_quote` survives verbatim (the context record holds its digest).
 */
describe('the admitted evidence round reaches the re-presented arbitration', () => {
  const QUOTE = 'The endpoint must never return 500 for an unauthenticated request.';
  const IMPL_REF = { kind: 'file', path: BOUNDARY, startLine: 4, endLine: 9 };
  const REVIEW_QUOTE_REF = { kind: 'issue_quote', quote: QUOTE };
  const REVIEW_TEST_REF = { kind: 'test', name: 'auth handler rejects anonymous direct dispatch' };

  let root;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'arb-evidence-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const digestOf = (content) => createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 12);

  /** The #956 context projection of one full §3.3 reference. */
  const persistedRef = (ref) =>
    ref.kind === 'issue_quote'
      ? { kind: 'issue_quote', quoteDigest: digestOf(ref.quote), quoteChars: ref.quote.length }
      : ref;

  /** Write one party's §10.2 record file; return its dir and #956 artifact ref. */
  function writeRecord(party, refs, { tamper } = {}) {
    const dir = join(root, `run-evidence-${party}`);
    const name = `evidence-${party}-${LINEAGE}.json`;
    const content = JSON.stringify({
      party,
      lineageId: LINEAGE,
      version: 1,
      round: 1,
      attempt: 0,
      answered: true,
      attachments: refs.length,
      references: refs,
      dropped: [],
    });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), tamper === undefined ? content : tamper(content), 'utf8');
    return { dir, artifact: { name, digest: digestOf(content), bytes: Buffer.byteLength(content, 'utf8') } };
  }

  /**
   * A completed round exactly as #963 persists one — the round record with both
   * parties on file (quotes projected to digests) and the per-party execution
   * record naming each run's artifact directory — plus the record files on disk.
   */
  function completedRound({ implementer = [], reviewer = [], version = 1, tamper = {} } = {}) {
    const evidenceCollections = {};
    const parties = {};
    for (const [party, refs] of [
      ['implementer', implementer],
      ['reviewer', reviewer],
    ]) {
      const written = writeRecord(party, refs, { tamper: tamper[party] });
      evidenceCollections[party] = { artifactDir: written.dir, timestamp: '2026-08-05T02:00:00.000Z', summary: {} };
      parties[party] = {
        runId: `${RUN_ID}~evidence.${party}.0`,
        attempt: 0,
        attachments: refs.length,
        references: refs.map(persistedRef),
        artifacts: [written.artifact],
      };
    }
    return {
      artifactRoot: root,
      evidenceRound: {
        lineages: { [LINEAGE]: { version, round: 1, parties, recordedRunId: `${RUN_ID}~evidence.reviewer.0` } },
      },
      evidenceCollections,
    };
  }

  test('both parties\' admitted references reach #846, in party order, quotes verbatim', async () => {
    const calls = [];
    const completion = await dispatch({
      ...completedRound({ implementer: [IMPL_REF], reviewer: [REVIEW_QUOTE_REF, REVIEW_TEST_REF] }),
      invoke: invokeVerdict(verdictRecord(), calls),
    });

    expect(completion.disposition).toBe('applied');
    expect(appliedRow(completion).row).toBe(13);
    expect(calls).toHaveLength(1);
    expect(calls[0].evidenceRoundAttachments).toEqual([
      { party: 'implementer', ref: IMPL_REF },
      { party: 'reviewer', ref: REVIEW_QUOTE_REF },
      { party: 'reviewer', ref: REVIEW_TEST_REF },
    ]);
    // The span itself, not the digest the context column holds: the record file
    // is what rehydrated it.
    expect(calls[0].evidenceRoundAttachments[1].ref.quote).toBe(QUOTE);
  });

  test('an empty valid round travels as an empty list, and reads no record file', async () => {
    const calls = [];
    const round = completedRound();
    // No party admitted anything, so no record file may be demanded: remove
    // them to prove the resolution never opens one.
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    const completion = await dispatch({ ...round, invoke: invokeVerdict(verdictRecord(), calls) });

    expect(completion.disposition).toBe('applied');
    expect(calls[0].evidenceRoundAttachments).toEqual([]);
  });

  test('a round recorded against another version is not reused (§2.2)', async () => {
    const calls = [];
    const completion = await dispatch({
      ...completedRound({ implementer: [IMPL_REF], version: 2 }),
      invoke: invokeVerdict(verdictRecord(), calls),
    });

    // The stale round is dropped, never attached: the arbitration proceeds
    // exactly as one for a lineage that had no round.
    expect(completion.disposition).toBe('applied');
    expect(calls[0].evidenceRoundAttachments).toBeUndefined();
  });

  test('a record file that no longer matches its recorded digest parks before the arbiter runs', async () => {
    const calls = [];
    const completion = await dispatch({
      ...completedRound({
        implementer: [IMPL_REF],
        tamper: { implementer: (content) => content.replace(IMPL_REF.path, 'src/other.ts') },
      }),
      invoke: invokeVerdict(verdictRecord(), calls),
    });

    expect(completion.disposition).toBe('parked');
    expect(completion.result.result).toBe('blocked');
    expect(completion.failure).toMatchObject({ kind: 'invocation_failed', detail: 'evidenceRound:implementer:record-digest' });
    expect(completion.transition).toBeNull();
    // Fail-closed BEFORE the invocation: no pass may be spent on a verdict
    // decided without the round's evidence.
    expect(calls).toHaveLength(0);
  });

  test('a party whose record files cannot be located parks, not silently re-arbitrates', async () => {
    const calls = [];
    const round = completedRound({ implementer: [IMPL_REF] });
    delete round.evidenceCollections.implementer;
    const completion = await dispatch({ ...round, invoke: invokeVerdict(verdictRecord(), calls) });

    expect(completion.disposition).toBe('parked');
    expect(completion.failure).toMatchObject({
      kind: 'invocation_failed',
      detail: 'evidenceRound:implementer:artifact-dir-absent',
    });
    expect(calls).toHaveLength(0);
  });

  test('an unreadable round record parks as invalid context', async () => {
    const calls = [];
    const completion = await dispatch({
      evidenceRound: { lineages: { [LINEAGE]: { version: 1, parties: { implementer: { runId: '', attempt: 0, attachments: 0 } } } } },
      invoke: invokeVerdict(verdictRecord(), calls),
    });

    expect(completion.disposition).toBe('parked');
    expect(completion.failure).toMatchObject({ kind: 'invalid_context' });
    expect(calls).toHaveLength(0);
  });

  test('a matching-version round that never closed parks instead of dropping a party\'s answer', async () => {
    const calls = [];
    const completion = await dispatch({
      evidenceRound: {
        lineages: {
          [LINEAGE]: {
            version: 1,
            round: 1,
            parties: {
              implementer: { runId: `${RUN_ID}~evidence.implementer.0`, attempt: 0, attachments: 0, references: [] },
              reviewer: { runId: `${RUN_ID}~evidence.reviewer.0`, attempt: 0, attachments: 0, status: 'recoverable' },
            },
          },
        },
      },
      invoke: invokeVerdict(verdictRecord(), calls),
    });

    expect(completion.disposition).toBe('parked');
    expect(completion.failure).toMatchObject({ kind: 'invalid_context', detail: `evidenceRound:${LINEAGE}:incomplete` });
    expect(calls).toHaveLength(0);
  });

  test('a caller-supplied attachment list is kept over the persisted round', async () => {
    const calls = [];
    const supplied = [{ party: 'reviewer', ref: REVIEW_TEST_REF }];
    const completion = await dispatch({
      ...completedRound({ implementer: [IMPL_REF] }),
      evidenceRoundAttachments: supplied,
      invoke: invokeVerdict(verdictRecord(), calls),
    });

    expect(completion.disposition).toBe('applied');
    expect(calls[0].evidenceRoundAttachments).toEqual(supplied);
  });
});
