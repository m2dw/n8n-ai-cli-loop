/**
 * The event-derived dispute metrics projection (issue #849,
 * src/core/review-dispute-metrics.ts; docs/review-dispute-contract.md §10.3,
 * docs/review-dispute-operations.md).
 *
 * The aggregation is pure, so this file drives it directly. Every event it
 * folds is produced by the REAL transition layer — `applyDisputeTransition`
 * over decisions built by the real predecessor modules — rather than
 * hand-authored, so a counter here can only move for a transition the contract
 * could actually produce.
 *
 * What is pinned:
 *
 *  - the shape is CLOSED and fully zero-filled, so `--json` consumers see the
 *    same keys for a quiet session as for a busy one;
 *  - every counter the Issue names is derived, and derived from the right
 *    place: the §6.1 counters for anything bounded, the §10.3 literal for
 *    anything that has no counter;
 *  - a duplicate delivery, a replay, and a re-read of the same stream produce
 *    IDENTICAL numbers — the property that makes the report safe to run twice;
 *  - `lineagesResolvedWithoutHuman` is an observed proxy with the documented
 *    definition, and never counts an escalated or reopened lineage;
 *  - the optional window filters on `createdAt` and nothing else.
 */
import { REVIEW_DISPUTE_DEFAULT_LIMITS, ZERO_LINEAGE_COUNTERS, DISPUTE_AUDIT_EVENTS } from '../dist/core/review-dispute.js';
import { parseFixDispositionResponse } from '../dist/core/review-fix-disposition-response.js';
import { persistFixDisputes } from '../dist/core/review-dispute-persistence.js';
import { decideRevision } from '../dist/core/review-revision-decision.js';
import { parseArbitrationResponse } from '../dist/core/review-arbitration-response.js';
import { arbitrationRunKey } from '../dist/core/review-arbitration-prompt.js';
import { routeArbitrationOutcome } from '../dist/core/review-arbitration-route.js';
import { applyDisputeTransition } from '../dist/core/review-dispute-transition.js';
import { REVIEW_DISPUTE_TRANSITION_EVENT } from '../dist/core/review-dispute-commit.js';
import { aggregateDisputeMetrics, emptyDisputeMetrics } from '../dist/core/review-dispute-metrics.js';

const SESSION = 'metrics-session';
const ISSUE = 849;
const KEY = { sessionId: SESSION, issueNumber: ISSUE };
const LINEAGE_A = 'ln-aaaaaaaaaaaa';
const LINEAGE_B = 'ln-bbbbbbbbbbbb';
const BOUNDARY = 'src/auth/handler.ts';
const ARGUMENT = 'The null session is already rejected by the middleware, so the cited crash cannot occur.';
const RATIONALE = 'RATIONALE-ONLY-TOKEN: the rebuttal misreads the acceptance criterion.';

const REVIEWER_META = {
  agentId: 'codex',
  model: 'gpt-5-codex',
  effort: 'high',
  reviewRunId: 'run-review-1',
  timestamp: '2026-08-06T10:00:00.000Z',
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function lineage(id, overrides = {}) {
  const { counters: counterOverrides, ...rest } = overrides;
  return {
    lineageId: id,
    state: 'open',
    version: 1,
    counters: { ...ZERO_LINEAGE_COUNTERS, ...counterOverrides },
    rebuttedVersions: [],
    humanGate: false,
    severity: 'P1',
    affectedBoundary: BOUNDARY,
    ...rest,
  };
}

function context(lineages, overrides = {}) {
  return { version: 1, reviewStructure: 'structured', lineages, ...overrides };
}

function promptFindings(ctx) {
  return Object.values(ctx.lineages)
    .filter((l) => l.state === 'open' || l.state === 'binding')
    .map((l) => ({
      lineageId: l.lineageId,
      version: l.version,
      state: l.state,
      severity: l.severity,
      affectedBoundary: l.affectedBoundary,
      allowedDispositions: l.state === 'binding' ? ['fixed', 'blocked'] : ['fixed', 'review_disputed', 'blocked'],
    }));
}

function fixedRecord(id, version = 1) {
  return { lineageId: id, version, disposition: 'fixed', note: 'Added the null guard.' };
}

function blockedRecord(id, version = 1) {
  return { lineageId: id, version, disposition: 'blocked', note: 'Needs a credential automation cannot supply.' };
}

function disputeRecord(id, version = 1) {
  return {
    lineageId: id,
    version,
    disposition: 'review_disputed',
    dispute: {
      challenged: { lineageId: id, version },
      rebuttalReason: 'false_premise',
      argument: ARGUMENT,
      evidenceRefs: [{ kind: 'file', path: BOUNDARY, startLine: 30, endLine: 36 }],
      whyNoChange: 'A second guard would duplicate the existing one without changing behavior.',
    },
  };
}

function findingBody(overrides = {}) {
  return {
    version: 1,
    severity: 'P1',
    violatedContract: 'Acceptance criterion 3: the retry cursor must rewind inside the CAS transaction.',
    preconditions: 'A retry arrives after the forward cursor advanced past the retried entry.',
    failureScenario: 'retryEntry leaves the cursor ahead, so the retried row is never rescanned.',
    affectedBoundary: BOUNDARY,
    requiredOutcome: 'The cursor rewinds to the retried entry before the transaction commits.',
    evidenceRefs: [{ kind: 'file', path: BOUNDARY, startLine: 10, endLine: 20 }],
    ...overrides,
  };
}

function recordedVersion(id) {
  return { ...findingBody(), lineageId: id, humanGate: false, reviewerMeta: REVIEWER_META };
}

function revisionRecord({ successor = {}, ...overrides } = {}) {
  return {
    predecessorVersion: 1,
    changedFields: ['preconditions'],
    revisionKind: 'corrected_premise',
    materialityClaim: true,
    successor: findingBody({ version: 2, ...successor }),
    ...overrides,
  };
}

const MATERIAL_REVISION = revisionRecord({
  successor: { preconditions: 'A retry arrives while the bulk cursor is mid-scan and the forward cursor is absent.' },
});
const REWORDED_REVISION = revisionRecord({
  changedFields: ['failureScenario'],
  successor: { failureScenario: 'So the retried row is never rescanned: retryEntry leaves the cursor ahead.' },
});
const AMBIGUOUS_REVISION = revisionRecord({
  changedFields: ['failureScenario'],
  successor: { failureScenario: 'The scan skips an entry whose visibility window closed mid-transaction.' },
});

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

function invocationSummary({ lineageId, version, runId, ...overrides }) {
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

function invocationOk(target, { verdict, confidence, runId }) {
  const record = { lineageId: target.lineageId, version: target.version, verdict, confidence, rationale: RATIONALE };
  const parsed = parseArbitrationResponse({
    response: ['```json', JSON.stringify(record), '```'].join('\n'),
    pending: { lineageId: target.lineageId, version: target.version },
    lineages: { [target.lineageId]: target },
    minConfidence: 0.7,
  });
  if (parsed.admitted === null) throw new Error(`fixture not admitted: ${JSON.stringify(parsed.failure)}`);
  return {
    ok: true,
    admitted: parsed.admitted,
    confidence: parsed.confidence,
    bundle: { entries: [] },
    artifacts: [],
    summary: invocationSummary({ lineageId: target.lineageId, version: target.version, runId, verdict: parsed.summary }),
  };
}

function invocationFailed(target, { kind, runId }) {
  return {
    ok: false,
    failure: { kind, detail: null },
    bundle: null,
    artifacts: [],
    summary: invocationSummary({ lineageId: target.lineageId, version: target.version, runId, failure: { kind, detail: null } }),
  };
}

// ---------------------------------------------------------------------------
// A tiny recorder: apply real transitions and collect the events they produce
// ---------------------------------------------------------------------------

/**
 * Applies a decision to the running block and appends the ONE §10.3 event the
 * durable layer would have appended — including the replay short-circuit, so a
 * replayed delivery contributes nothing here either.
 */
class Recorder {
  constructor(ctx, { createdAt = '2026-08-06T12:00:00.000Z', issueNumber = ISSUE } = {}) {
    this.ctx = ctx;
    this.events = [];
    this.createdAt = createdAt;
    this.issueNumber = issueNumber;
  }

  at(createdAt) {
    this.createdAt = createdAt;
    return this;
  }

  /** Apply and record. `force` re-emits the event even on a replay (see below). */
  apply(decision, { runId, actor = 'implementer', force = false } = {}) {
    const result = applyDisputeTransition({ context: this.ctx, decision, run: { runId, actor } });
    if (!result.ok) throw new Error(`transition refused: ${JSON.stringify(result.failure)}`);
    this.ctx = result.value.context;
    if (!result.value.replayed || force) {
      this.events.push({
        task: { sessionId: SESSION, issueNumber: this.issueNumber },
        type: REVIEW_DISPUTE_TRANSITION_EVENT,
        runId,
        data: result.value.event,
        createdAt: this.createdAt,
      });
    }
    return result.value;
  }

  dispositions(records, { diff = false, runId }) {
    const outcome = parseFixDispositionResponse({
      response: `\`\`\`json\n${JSON.stringify(records)}\n\`\`\``,
      findings: promptFindings(this.ctx),
      lineages: this.ctx.lineages,
      reviewStructure: this.ctx.reviewStructure,
      runProducedFileChanges: diff,
      resolveEvidenceRef: () => true,
      limits: REVIEW_DISPUTE_DEFAULT_LIMITS,
    });
    const persisted = persistFixDisputes({
      context: this.ctx,
      outcome,
      run: { runId, agentId: 'claude', timestamp: this.createdAt },
      runProducedFileChanges: diff,
      limits: REVIEW_DISPUTE_DEFAULT_LIMITS,
    });
    if (!persisted.ok) throw new Error(`fixture not persisted: ${JSON.stringify(persisted.failure)}`);
    return this.apply(
      { kind: 'dispositions', persistence: persisted.value, outcome, runProducedFileChanges: diff },
      { runId },
    );
  }

  reconsider(id, kind, { revision, runId }) {
    const record = {
      lineageId: id,
      version: this.ctx.lineages[id].version,
      reconsideration: kind,
      rationale: 'The premise was wrong; the corrected one still shows the defect.',
      ...(revision === undefined ? {} : { revision }),
    };
    const admitted = { record, lineage: this.ctx.lineages[id] };
    const decision = kind === 'revise'
      ? { kind: 'reconsideration', admitted, revision: decideRevision({ admitted, versions: [recordedVersion(id)] }) }
      : { kind: 'reconsideration', admitted };
    return this.apply(decision, { runId, actor: 'reviewer' });
  }

  arbitrate(id, outcome, { runId }) {
    const target = this.ctx.lineages[id];
    return this.apply(
      { kind: 'arbitration', decision: routeArbitrationOutcome({ lineage: target, version: target.version, outcome }) },
      { runId, actor: 'arbiter' },
    );
  }

  verdict(id, verdict, confidence, { runId }) {
    return this.arbitrate(id, { kind: 'invocation', result: invocationOk(this.ctx.lineages[id], { verdict, confidence, runId }) }, { runId });
  }

  malformed(id, { runId }) {
    return this.arbitrate(
      id,
      { kind: 'invocation', result: invocationFailed(this.ctx.lineages[id], { kind: 'malformed-response', runId }) },
      { runId },
    );
  }

  evidenceRound(id, attachmentsRecorded, { runId }) {
    return this.apply(
      { kind: 'evidence_round', lineageId: id, version: this.ctx.lineages[id].version, attachmentsRecorded },
      { runId, actor: 'runner' },
    );
  }

  reopen(id, { runId }) {
    return this.apply({ kind: 'reopen_request', lineageId: id }, { runId, actor: 'runner' });
  }

  task() {
    return { issueNumber: this.issueNumber, events: this.events };
  }
}

function metricsFor(recorders, window) {
  return aggregateDisputeMetrics({
    sessionId: SESSION,
    tasks: (Array.isArray(recorders) ? recorders : [recorders]).map((r) => r.task()),
    ...(window === undefined ? {} : { window }),
  });
}

// ===========================================================================

describe('aggregateDisputeMetrics — shape', () => {
  test('an empty session reports a fully zero-filled, closed payload', () => {
    const m = aggregateDisputeMetrics({ sessionId: SESSION, tasks: [] });
    expect(m).toEqual(emptyDisputeMetrics(SESSION, { from: null, to: null }));
    // Every §10.3 literal has a key, even at zero: a `--json` consumer never
    // has to distinguish "absent" from "none happened".
    for (const literal of DISPUTE_AUDIT_EVENTS) expect(m.auditEvents[literal]).toBe(0);
    for (const outcome of ['resolved_fixed', 'resolved_withdrawn', 'resolved_overruled', 'escalated_human']) {
      expect(m.terminalOutcomes[outcome]).toBe(0);
    }
  });

  test('a task with no dispute events still counts towards the denominator', () => {
    const m = aggregateDisputeMetrics({
      sessionId: SESSION,
      tasks: [
        { issueNumber: 1, events: [{ task: KEY, type: 'phase.completed', data: {}, createdAt: '2026-08-06T12:00:00.000Z' }] },
        { issueNumber: 2, events: [] },
      ],
    });
    expect(m.tasksScanned).toBe(2);
    expect(m.tasksWithDisputeActivity).toBe(0);
    expect(m.transitionEvents).toBe(0);
  });

  test('the payload survives a JSON round trip unchanged (stable machine output)', () => {
    const r = new Recorder(context({ [LINEAGE_A]: lineage(LINEAGE_A) }));
    r.dispositions([disputeRecord(LINEAGE_A)], { runId: 'run-1' });
    const m = metricsFor(r);
    expect(JSON.parse(JSON.stringify(m))).toEqual(m);
  });
});

describe('aggregateDisputeMetrics — the counters the Issue names', () => {
  test('a finding admission opens a lineage', () => {
    const r = new Recorder(context({}, { reviewStructure: 'legacy' }));
    r.apply({ kind: 'finding_admission', next: context({ [LINEAGE_A]: lineage(LINEAGE_A) }) }, {
      runId: 'run-review-1',
      actor: 'reviewer',
    });
    const m = metricsFor(r);
    expect(m.findingsOpened).toBe(1);
    expect(m.auditEvents['dispute.finding.opened']).toBe(1);
    expect(m.decisionKinds.finding_admission).toBe(1);
  });

  test('a rebuttal is counted from its §6.1 counter, including a human-gated one', () => {
    // Rows 3/7 escalate at admission and report `dispute.escalated.human`, yet
    // they still SPEND the version's rebuttal slot. Counting the literal would
    // report zero rebuttals for the disputes an operator most wants to see.
    const gated = new Recorder(context({ [LINEAGE_A]: lineage(LINEAGE_A, { humanGate: true }) }));
    gated.dispositions([disputeRecord(LINEAGE_A)], { runId: 'run-1' });
    const m = metricsFor(gated);
    expect(m.rebuttalsRecorded).toBe(1);
    expect(m.humanEscalations).toBe(1);
    expect(m.auditEvents['dispute.rebuttal.recorded']).toBe(0);
    expect(m.terminalOutcomes.escalated_human).toBe(1);
  });

  test('a reconsideration is counted whichever way the reviewer answered', () => {
    for (const [kind, expectedLiteral] of [
      ['withdraw', 'dispute.resolved'],
      ['uphold', 'dispute.reconsideration.recorded'],
    ]) {
      const r = new Recorder(context({ [LINEAGE_A]: lineage(LINEAGE_A) }));
      r.dispositions([disputeRecord(LINEAGE_A)], { runId: 'run-1' });
      r.reconsider(LINEAGE_A, kind, { runId: 'run-2' });
      const m = metricsFor(r);
      expect(m.reconsiderations).toBe(1);
      expect(m.auditEvents[expectedLiteral]).toBe(1);
    }
  });

  test('revisions are split by the materiality the runner computed', () => {
    const cases = [
      [MATERIAL_REVISION, 'material'],
      [REWORDED_REVISION, 'nonMaterial'],
      [AMBIGUOUS_REVISION, 'ambiguous'],
    ];
    for (const [revision, bucket] of cases) {
      const r = new Recorder(context({ [LINEAGE_A]: lineage(LINEAGE_A) }));
      r.dispositions([disputeRecord(LINEAGE_A)], { runId: 'run-1' });
      r.reconsider(LINEAGE_A, 'revise', { revision, runId: 'run-2' });
      const m = metricsFor(r);
      expect(m.revisions[bucket]).toBe(1);
      const others = Object.entries(m.revisions).filter(([k]) => k !== bucket);
      expect(others.every(([, v]) => v === 0)).toBe(true);
    }
  });

  test('arbitration verdicts count passes spent; an unavailable arbiter spends none', () => {
    const decisive = new Recorder(context({ [LINEAGE_A]: lineage(LINEAGE_A) }));
    decisive.dispositions([disputeRecord(LINEAGE_A)], { runId: 'run-1' });
    decisive.reconsider(LINEAGE_A, 'uphold', { runId: 'run-2' });
    decisive.verdict(LINEAGE_A, 'implementer_correct', 0.9, { runId: 'run-3' });
    const m = metricsFor(decisive);
    // Row 14 reports `dispute.resolved`, not a verdict literal — the pass it
    // spent is what says an arbiter answered.
    expect(m.arbitration.verdicts).toBe(1);
    expect(m.auditEvents['dispute.arbitration.verdict']).toBe(0);
    expect(m.terminalOutcomes.resolved_overruled).toBe(1);

    const unavailable = new Recorder(context({ [LINEAGE_A]: lineage(LINEAGE_A) }));
    unavailable.dispositions([disputeRecord(LINEAGE_A)], { runId: 'run-1' });
    unavailable.reconsider(LINEAGE_A, 'uphold', { runId: 'run-2' });
    unavailable.arbitrate(LINEAGE_A, {
      kind: 'profile',
      resolution: {
        kind: 'human_handoff',
        lineageId: LINEAGE_A,
        reason: 'no-acceptable-candidate',
        row: 19,
        rejections: [{ index: 0, candidate: 'claude', reason: 'same-provider-not-allowed', detail: 'implementation' }],
      },
      run: { runId: 'run-3' },
    }, { runId: 'run-3' });
    const u = metricsFor(unavailable);
    expect(u.arbitration.verdicts).toBe(0);
    expect(u.humanEscalations).toBe(1);
    expect(u.reasons['no-acceptable-arbiter']).toBe(1);
  });

  test('malformed arbiter attempts are counted below and at the cap', () => {
    const r = new Recorder(context({ [LINEAGE_A]: lineage(LINEAGE_A) }));
    r.dispositions([disputeRecord(LINEAGE_A)], { runId: 'run-1' });
    r.reconsider(LINEAGE_A, 'uphold', { runId: 'run-2' });
    r.malformed(LINEAGE_A, { runId: 'run-3' });
    r.malformed(LINEAGE_A, { runId: 'run-4' });
    const m = metricsFor(r);
    expect(m.arbitration.malformedAttempts).toBe(REVIEW_DISPUTE_DEFAULT_LIMITS.maxMalformedArbiterAttemptsPerLineage);
    expect(m.arbitration.verdicts).toBe(0);
    expect(m.reasons['malformed-arbiter-output']).toBe(1);
    expect(m.reasons['malformed-arbiter-cap-reached']).toBe(1);
    expect(m.terminalOutcomes.escalated_human).toBe(1);
  });

  test('an evidence round is reported at both ends, from two different sources', () => {
    const r = new Recorder(context({ [LINEAGE_A]: lineage(LINEAGE_A) }));
    r.dispositions([disputeRecord(LINEAGE_A)], { runId: 'run-1' });
    r.reconsider(LINEAGE_A, 'uphold', { runId: 'run-2' });
    r.verdict(LINEAGE_A, 'insufficient_evidence', 0.8, { runId: 'run-3' });
    r.evidenceRound(LINEAGE_A, 2, { runId: 'run-4' });
    const m = metricsFor(r);
    expect(m.evidence).toEqual({ requested: 1, recorded: 1 });
    // §10.3 gives the round ONE literal for both ends; the counter and the
    // reason are what separate them.
    expect(m.auditEvents['dispute.evidence.requested']).toBe(2);
  });

  test('a §6.4 reopen request is counted and taints its lineage, without a terminal transition', () => {
    const r = new Recorder(context({ [LINEAGE_A]: lineage(LINEAGE_A) }));
    r.dispositions([fixedRecord(LINEAGE_A)], { diff: true, runId: 'run-1' });
    r.reopen(LINEAGE_A, { runId: 'run-2' });
    const m = metricsFor(r);
    expect(m.reopenRequests).toBe(1);
    // The lineage became terminal exactly once; the request did not re-count it.
    expect(m.terminalOutcomes.resolved_fixed).toBe(1);
    expect(m.lineagesReachedTerminal).toBe(1);
    // …and it is no longer "resolved without a human".
    expect(m.lineagesResolvedWithoutHuman).toBe(0);
    expect(m.tasksResolvedWithoutHuman).toBe(0);
    expect(m.tasksEscalatedToHuman).toBe(1);
  });

  test('a §12 refusal is reported as refused, and moves no counter', () => {
    const r = new Recorder(context({ [LINEAGE_A]: lineage(LINEAGE_A) }));
    // §6.4: a reopen request against a LIVE lineage is refused.
    r.apply({ kind: 'reopen_request', lineageId: LINEAGE_A }, { runId: 'run-1', actor: 'runner' });
    const m = metricsFor(r);
    expect(m.decisionsRefused).toBe(1);
    expect(m.transitionsApplied).toBe(0);
    expect(m.reopenRequests).toBe(0);
  });
});

describe('aggregateDisputeMetrics — the observable proxy', () => {
  test('a lineage that resolved on its own counts; one that escalated does not', () => {
    const resolved = new Recorder(context({ [LINEAGE_A]: lineage(LINEAGE_A) }), { issueNumber: 101 });
    resolved.dispositions([fixedRecord(LINEAGE_A)], { diff: true, runId: 'run-1' });

    const escalated = new Recorder(context({ [LINEAGE_B]: lineage(LINEAGE_B) }), { issueNumber: 102 });
    escalated.dispositions([blockedRecord(LINEAGE_B)], { diff: true, runId: 'run-1' });

    const m = metricsFor([resolved, escalated]);
    expect(m.lineagesReachedTerminal).toBe(2);
    expect(m.lineagesResolvedWithoutHuman).toBe(1);
    expect(m.tasksResolvedWithoutHuman).toBe(1);
    expect(m.tasksEscalatedToHuman).toBe(1);
    expect(m.terminalOutcomes).toMatchObject({ resolved_fixed: 1, escalated_human: 1 });
  });

  test('a task with one escalated lineage is not "resolved without human" on the strength of a sibling', () => {
    const both = new Recorder(context({ [LINEAGE_A]: lineage(LINEAGE_A), [LINEAGE_B]: lineage(LINEAGE_B) }));
    both.dispositions([fixedRecord(LINEAGE_A), blockedRecord(LINEAGE_B)], { diff: true, runId: 'run-1' });
    const m = metricsFor(both);
    expect(m.lineagesReachedTerminal).toBe(2);
    expect(m.lineagesResolvedWithoutHuman).toBe(1);
    expect(m.tasksResolvedWithoutHuman).toBe(0);
    expect(m.tasksEscalatedToHuman).toBe(1);
  });

  test('a lineage still in flight counts towards nothing terminal', () => {
    const r = new Recorder(context({ [LINEAGE_A]: lineage(LINEAGE_A) }));
    r.dispositions([disputeRecord(LINEAGE_A)], { runId: 'run-1' });
    const m = metricsFor(r);
    expect(m.lineagesReachedTerminal).toBe(0);
    expect(m.lineagesResolvedWithoutHuman).toBe(0);
    expect(m.tasksResolvedWithoutHuman).toBe(0);
    expect(m.tasksEscalatedToHuman).toBe(0);
  });
});

describe('aggregateDisputeMetrics — idempotence', () => {
  test('re-reading the same stream twice produces identical numbers', () => {
    const r = new Recorder(context({ [LINEAGE_A]: lineage(LINEAGE_A) }));
    r.dispositions([disputeRecord(LINEAGE_A)], { runId: 'run-1' });
    r.reconsider(LINEAGE_A, 'withdraw', { runId: 'run-2' });
    expect(metricsFor(r)).toEqual(metricsFor(r));
  });

  test('a duplicated event delivery is deduplicated by transition key', () => {
    const r = new Recorder(context({ [LINEAGE_A]: lineage(LINEAGE_A) }));
    r.dispositions([fixedRecord(LINEAGE_A)], { diff: true, runId: 'run-1' });
    const once = metricsFor(r);

    // The same event row read twice — an outbox/scan replay, or a caller that
    // handed the same task in twice.
    const doubled = aggregateDisputeMetrics({
      sessionId: SESSION,
      tasks: [{ issueNumber: ISSUE, events: [...r.events, ...r.events] }],
    });
    expect(doubled.transitionsApplied).toBe(once.transitionsApplied);
    expect(doubled.terminalOutcomes).toEqual(once.terminalOutcomes);
    expect(doubled.lineagesReachedTerminal).toBe(once.lineagesReachedTerminal);
    // …and it says so, rather than silently dropping the fact.
    expect(doubled.transitionEvents).toBe(once.transitionEvents * 2);
    expect(doubled.transitionsDeduplicated).toBe(once.transitionsApplied);
  });

  test('a transition entry the protocol marked `replayed` is never counted', () => {
    const ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A) });
    const outcome = parseFixDispositionResponse({
      response: `\`\`\`json\n${JSON.stringify([fixedRecord(LINEAGE_A)])}\n\`\`\``,
      findings: promptFindings(ctx),
      lineages: ctx.lineages,
      reviewStructure: ctx.reviewStructure,
      runProducedFileChanges: true,
      resolveEvidenceRef: () => true,
      limits: REVIEW_DISPUTE_DEFAULT_LIMITS,
    });
    const persisted = persistFixDisputes({
      context: ctx,
      outcome,
      run: { runId: 'run-1', agentId: 'claude', timestamp: '2026-08-06T12:00:00.000Z' },
      runProducedFileChanges: true,
      limits: REVIEW_DISPUTE_DEFAULT_LIMITS,
    });
    expect(persisted.ok).toBe(true);
    const decision = {
      kind: 'dispositions',
      persistence: persisted.value,
      outcome,
      runProducedFileChanges: true,
    };

    const r = new Recorder(ctx);
    r.apply(decision, { runId: 'run-1' });
    // The identical approved decision, re-delivered under the same run id. The
    // transition layer recognizes it, and `force` records its event anyway —
    // the worst case a reader can face, a durable layer that appended before
    // it checked.
    const replay = r.apply(decision, { runId: 'run-1', force: true });
    expect(replay.replayed).toBe(true);

    const m = metricsFor(r);
    expect(m.transitionEvents).toBe(2);
    expect(m.transitionsApplied).toBe(1);
    expect(m.terminalOutcomes.resolved_fixed).toBe(1);
    expect(m.lineagesReachedTerminal).toBe(1);
  });
});

describe('aggregateDisputeMetrics — the optional window', () => {
  function twoDays() {
    const r = new Recorder(context({ [LINEAGE_A]: lineage(LINEAGE_A) }));
    r.at('2026-08-01T09:00:00.000Z').dispositions([disputeRecord(LINEAGE_A)], { runId: 'run-1' });
    r.at('2026-08-05T09:00:00.000Z').reconsider(LINEAGE_A, 'withdraw', { runId: 'run-2' });
    return r;
  }

  test('no window reads everything', () => {
    const m = metricsFor(twoDays());
    expect(m.window).toEqual({ from: null, to: null });
    expect(m.transitionEvents).toBe(2);
    expect(m.terminalOutcomes.resolved_withdrawn).toBe(1);
  });

  test('a bounded window keeps only the events inside it', () => {
    const m = metricsFor(twoDays(), { from: '2026-08-04T00:00:00.000Z' });
    expect(m.window).toEqual({ from: '2026-08-04T00:00:00.000Z', to: null });
    expect(m.transitionEvents).toBe(1);
    expect(m.rebuttalsRecorded).toBe(0);
    expect(m.terminalOutcomes.resolved_withdrawn).toBe(1);

    const early = metricsFor(twoDays(), { to: '2026-08-04T00:00:00.000Z' });
    expect(early.transitionEvents).toBe(1);
    expect(early.rebuttalsRecorded).toBe(1);
    expect(early.terminalOutcomes.resolved_withdrawn).toBe(0);
  });

  test('both ends are inclusive', () => {
    const m = metricsFor(twoDays(), { from: '2026-08-01T09:00:00.000Z', to: '2026-08-05T09:00:00.000Z' });
    expect(m.transitionEvents).toBe(2);
  });

  test('an event with no usable timestamp is excluded from a bounded window', () => {
    const events = [{ task: KEY, type: REVIEW_DISPUTE_TRANSITION_EVENT, data: { applied: [] }, createdAt: '' }];
    expect(aggregateDisputeMetrics({ sessionId: SESSION, tasks: [{ issueNumber: ISSUE, events }] }).transitionEvents).toBe(1);
    expect(
      aggregateDisputeMetrics({
        sessionId: SESSION,
        tasks: [{ issueNumber: ISSUE, events }],
        window: { from: '2026-08-01T00:00:00.000Z' },
      }).transitionEvents,
    ).toBe(0);
  });
});

describe('aggregateDisputeMetrics — hostile input', () => {
  test('an unreadable payload contributes nothing and throws nothing', () => {
    const events = [
      { task: KEY, type: REVIEW_DISPUTE_TRANSITION_EVENT, data: null, createdAt: '2026-08-06T12:00:00.000Z' },
      { task: KEY, type: REVIEW_DISPUTE_TRANSITION_EVENT, data: { applied: 'not-an-array' }, createdAt: '2026-08-06T12:00:00.000Z' },
      {
        task: KEY,
        type: REVIEW_DISPUTE_TRANSITION_EVENT,
        data: { applied: [{ auditEvent: 'not.a.literal', toState: 'not-a-state', counterDelta: { rebuttals: -3 } }] },
        createdAt: '2026-08-06T12:00:00.000Z',
      },
    ];
    const m = aggregateDisputeMetrics({ sessionId: SESSION, tasks: [{ issueNumber: ISSUE, events }] });
    expect(m.transitionEvents).toBe(2);
    expect(m.rebuttalsRecorded).toBe(0);
    expect(m.lineagesReachedTerminal).toBe(0);
    expect(m.auditEvents['dispute.resolved']).toBe(0);
  });

  test('events of other types are never read', () => {
    const r = new Recorder(context({ [LINEAGE_A]: lineage(LINEAGE_A) }));
    r.dispositions([fixedRecord(LINEAGE_A)], { diff: true, runId: 'run-1' });
    const noise = { task: KEY, type: 'phase.completed', data: r.events[0].data, createdAt: '2026-08-06T12:00:00.000Z' };
    const m = aggregateDisputeMetrics({
      sessionId: SESSION,
      tasks: [{ issueNumber: ISSUE, events: [...r.events, noise] }],
    });
    expect(m.transitionEvents).toBe(1);
    expect(m.terminalOutcomes.resolved_fixed).toBe(1);
  });
});
