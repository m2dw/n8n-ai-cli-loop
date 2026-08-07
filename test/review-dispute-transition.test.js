/**
 * Unit tests for the issue #840 transition applicator
 * (src/core/review-dispute-transition.ts, docs/review-dispute-contract.md §7,
 * §7.1, §10.1, §10.3).
 *
 * The document is the authority; these tests pin the applicator against it. Two
 * properties are asserted over and over, because they are the whole reason this
 * layer exists:
 *
 *  - **every row of the §7 table has exactly one tested next state**, and the
 *    rows their owners already decided (#845's 11/12/26, #847's 13–21) are
 *    APPLIED here rather than re-decided — the tests build those decisions with
 *    the real predecessor functions, never by hand;
 *  - **nothing is applied twice.** A re-delivered run reads its own ledger entry
 *    and moves no counter, changes no state, and adds no audit entry.
 *
 * Every decision fed in is produced by the real predecessor module — the #843
 * parser, the #844 writer, #845's `decideRevision`, #847's
 * `routeArbitrationOutcome` — so no test can apply a transition the contract
 * would never have produced.
 */
import {
  MAX_APPLIED_TRANSITIONS_PER_LINEAGE,
  REVIEW_DISPUTE_DEFAULT_LIMITS,
  ZERO_LINEAGE_COUNTERS,
} from '../dist/core/review-dispute.js';
import { parseFixDispositionResponse } from '../dist/core/review-fix-disposition-response.js';
import { persistFixDisputes } from '../dist/core/review-dispute-persistence.js';
import { decideRevision } from '../dist/core/review-revision-decision.js';
import { parseArbitrationResponse } from '../dist/core/review-arbitration-response.js';
import { arbitrationRunKey } from '../dist/core/review-arbitration-prompt.js';
import { routeArbitrationOutcome } from '../dist/core/review-arbitration-route.js';
import { validateReviewDisputeContext } from '../dist/core/review-dispute-validation.js';
import {
  DISPUTE_TASK_OUTCOMES,
  DISPUTE_TRANSITION_ROWS,
  aggregateDisputeRouting,
  applyDisputeTransition,
  transitionDigest,
} from '../dist/core/review-dispute-transition.js';

const LINEAGE_A = 'ln-aaaaaaaaaaaa';
const LINEAGE_B = 'ln-bbbbbbbbbbbb';
const BOUNDARY = 'src/auth/handler.ts';
const ARGUMENT = 'The null session is already rejected by the middleware, so the cited crash cannot occur.';
const RATIONALE = 'RATIONALE-ONLY-TOKEN: the rebuttal misreads the acceptance criterion.';

const RUN = { runId: 'run-1', actor: 'implementer' };
const OTHER_RUN = { runId: 'run-2', actor: 'implementer' };
const IMPL_RUN = { runId: 'run-1', agentId: 'claude', timestamp: '2026-08-05T00:00:00.000Z' };
const OTHER_IMPL_RUN = { runId: 'run-2', agentId: 'claude', timestamp: '2026-08-05T01:00:00.000Z' };

const REVIEWER_META = {
  agentId: 'codex',
  model: 'gpt-5-codex',
  effort: 'high',
  reviewRunId: 'run-review-1',
  timestamp: '2026-08-05T10:00:00.000Z',
};

function limits(overrides = {}) {
  return { ...REVIEW_DISPUTE_DEFAULT_LIMITS, ...overrides };
}

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

// ---------------------------------------------------------------------------
// #843/#844 fixtures: a fix run's dispositions
// ---------------------------------------------------------------------------

function disputeRecord(id, version = 1, overrides = {}) {
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
    ...overrides,
  };
}

function fixedRecord(id, version = 1) {
  return { lineageId: id, version, disposition: 'fixed', note: 'Added the null guard.' };
}

function blockedRecord(id, version = 1) {
  return { lineageId: id, version, disposition: 'blocked', note: 'Needs a credential automation cannot supply.' };
}

function block(records) {
  return `Here are my dispositions.\n\n\`\`\`json\n${JSON.stringify(records, null, 2)}\n\`\`\`\n`;
}

/** The #837 prompt view of every lineage that still awaits a disposition. */
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

/**
 * A `dispositions` decision, built by the REAL #843 parser and #844 writer over
 * `ctx`. `current` is the block the transition is applied to, so a test can hand
 * an older run's decision to a block that has since moved.
 */
function dispositions(
  ctx,
  records,
  { runProducedFileChanges = false, run = IMPL_RUN, sessionLimits, findings, current = ctx } = {},
) {
  const resolved = sessionLimits ?? REVIEW_DISPUTE_DEFAULT_LIMITS;
  const outcome = parseFixDispositionResponse({
    response: block(records),
    findings: findings ?? promptFindings(ctx),
    lineages: ctx.lineages,
    reviewStructure: ctx.reviewStructure,
    runProducedFileChanges,
    resolveEvidenceRef: () => true,
    limits: resolved,
  });
  const persisted = persistFixDisputes({
    context: current,
    outcome,
    run,
    runProducedFileChanges,
    limits: resolved,
  });
  if (!persisted.ok) throw new Error(`fixture not persisted: ${JSON.stringify(persisted.failure)}`);
  return { kind: 'dispositions', persistence: persisted.value, outcome, runProducedFileChanges };
}

// ---------------------------------------------------------------------------
// #838/#845 fixtures: the reviewer's reconsideration
// ---------------------------------------------------------------------------

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

function recordedVersion(id, overrides = {}) {
  return { ...findingBody(overrides), lineageId: id, humanGate: false, reviewerMeta: REVIEWER_META };
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

/** A material revision: the successor's `preconditions` genuinely differ (§5). */
const MATERIAL_REVISION = revisionRecord({
  successor: { preconditions: 'A retry arrives while the bulk cursor is mid-scan and the forward cursor is absent.' },
});
/** A wording-only revision: never material (§5). */
const REWORDED_REVISION = revisionRecord({
  changedFields: ['failureScenario'],
  successor: { failureScenario: 'So the retried row is never rescanned: retryEntry leaves the cursor ahead.' },
});
const REVISED_BOUNDARY = 'src/auth/session.ts';
/** A material revision that moves the finding's surface AND its severity (§5). */
const RESURFACED_REVISION = revisionRecord({
  changedFields: ['severity', 'affectedBoundary'],
  successor: { severity: 'P2', affectedBoundary: REVISED_BOUNDARY },
});

function reconsideration(id, ctx, kind, { revision, sessionLimits, versions } = {}) {
  const record = {
    lineageId: id,
    version: ctx.lineages[id].version,
    reconsideration: kind,
    rationale: 'The premise was wrong; the corrected one still shows the defect.',
    ...(revision === undefined ? {} : { revision }),
  };
  const admitted = { record, lineage: ctx.lineages[id] };
  if (kind !== 'revise') return { kind: 'reconsideration', admitted };
  const decision = decideRevision({
    admitted,
    versions: versions ?? [recordedVersion(id)],
    ...(sessionLimits === undefined ? {} : { limits: sessionLimits }),
  });
  return { kind: 'reconsideration', admitted, revision: decision };
}

// ---------------------------------------------------------------------------
// #846/#847 fixtures: one arbitration turn
// ---------------------------------------------------------------------------

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

/** A #846 success, admitted by the REAL response parser. */
function invocationOk(target, { verdict, confidence, runId = 'run-arb-1', minConfidence = 0.7 }) {
  const record = { lineageId: target.lineageId, version: target.version, verdict, confidence, rationale: RATIONALE };
  const parsed = parseArbitrationResponse({
    response: ['Here is my judgement.', '', '```json', JSON.stringify(record, null, 2), '```', ''].join('\n'),
    pending: { lineageId: target.lineageId, version: target.version },
    lineages: { [target.lineageId]: target },
    minConfidence,
  });
  if (parsed.admitted === null) throw new Error(`fixture not admitted: ${JSON.stringify(parsed.failure)}`);
  return {
    ok: true,
    admitted: parsed.admitted,
    confidence: parsed.confidence,
    bundle: { entries: [] },
    artifacts: [],
    summary: invocationSummary({
      lineageId: target.lineageId,
      version: target.version,
      runId,
      verdict: parsed.summary,
    }),
  };
}

function invocationFailed(target, { kind, detail = null, runId = 'run-arb-1' }) {
  return {
    ok: false,
    failure: { kind, detail },
    bundle: null,
    artifacts: [],
    summary: invocationSummary({
      lineageId: target.lineageId,
      version: target.version,
      runId,
      failure: { kind, detail },
    }),
  };
}

function arbitration(ctx, id, outcome, { sessionLimits } = {}) {
  const target = ctx.lineages[id];
  const decision = routeArbitrationOutcome({
    lineage: target,
    version: target.version,
    outcome,
    ...(sessionLimits === undefined ? {} : { limits: sessionLimits }),
  });
  return { kind: 'arbitration', decision };
}

/**
 * `parseAgainst` exists because #846's parser refuses to admit a verdict for a
 * lineage whose arbitration budget is already spent — so a test that wants to
 * route a REAL verdict at an exhausted lineage parses it against the same
 * lineage one pass earlier, then routes the result at the exhausted record.
 */
function verdictTurn(ctx, id, options) {
  const target = options.parseAgainst ?? ctx.lineages[id];
  return arbitration(ctx, id, { kind: 'invocation', result: invocationOk(target, options) }, options);
}

function failedTurn(ctx, id, options) {
  return arbitration(ctx, id, { kind: 'invocation', result: invocationFailed(ctx.lineages[id], options) }, options);
}

function unavailableArbiter(ctx, id, runId = 'run-arb-1') {
  return arbitration(ctx, id, {
    kind: 'profile',
    resolution: {
      kind: 'human_handoff',
      lineageId: id,
      reason: 'no-acceptable-candidate',
      row: 19,
      rejections: [{ index: 0, candidate: 'claude', reason: 'same-provider-not-allowed', detail: 'implementation' }],
    },
    run: { runId },
  });
}

// ---------------------------------------------------------------------------
// The applicator under test
// ---------------------------------------------------------------------------

function apply(ctx, decision, { run = RUN, sessionLimits } = {}) {
  const result = applyDisputeTransition({
    context: ctx,
    decision,
    run,
    ...(sessionLimits === undefined ? {} : { limits: sessionLimits }),
  });
  if (!result.ok) throw new Error(`transition failed: ${JSON.stringify(result.failure)}`);
  return result.value;
}

function applyRaw(ctx, decision, { run = RUN, sessionLimits } = {}) {
  return applyDisputeTransition({
    context: ctx,
    decision,
    run,
    ...(sessionLimits === undefined ? {} : { limits: sessionLimits }),
  });
}

/** Assert one applied row landed on exactly one next state. */
function expectRow(value, { lineageId = LINEAGE_A, row, from, to, event }) {
  const entry = value.applied.find((e) => e.lineageId === lineageId);
  expect(entry).toBeDefined();
  expect({ row: entry.row, from: entry.fromState, to: entry.toState }).toEqual({ row, from, to });
  expect(entry.replayed).toBe(false);
  if (event !== undefined) expect(entry.auditEvent).toBe(event);
  expect(value.context.lineages[lineageId].state).toBe(to);
  return entry;
}

// ---------------------------------------------------------------------------
// §7 rows 1–8, 23–25: the implementation dispositions
// ---------------------------------------------------------------------------

describe('§7 rows 1–8 and 23–25 — implementation dispositions', () => {
  test('row 1: `fixed` on an open version-1 finding resolves the lineage', () => {
    const ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A) });
    const value = apply(ctx, dispositions(ctx, [fixedRecord(LINEAGE_A)], { runProducedFileChanges: true }));

    expectRow(value, { row: 1, from: 'open', to: 'resolved_fixed', event: 'dispute.resolved' });
    expect(value.context.lineages[LINEAGE_A].outcome).toBe('resolved_fixed');
    expect(value.context.lineages[LINEAGE_A].counters).toEqual(ZERO_LINEAGE_COUNTERS);
  });

  test('row 2: an admitted, not human-gated dispute of version 1 awaits the reviewer', () => {
    const ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A) });
    const value = apply(ctx, dispositions(ctx, [disputeRecord(LINEAGE_A)]));

    expectRow(value, { row: 2, from: 'open', to: 'disputed', event: 'dispute.rebuttal.recorded' });
    expect(value.context.lineages[LINEAGE_A].counters.rebuttals).toBe(1);
    expect(value.context.lineages[LINEAGE_A].rebuttedVersions).toEqual([1]);
    expect(value.routing.turn).toBe('reviewer');
  });

  test('row 3: a dispute of a human-gated finding escalates at admission', () => {
    const ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A, { humanGate: true }) });
    const value = apply(ctx, dispositions(ctx, [disputeRecord(LINEAGE_A)]));

    expectRow(value, { row: 3, from: 'open', to: 'escalated_human', event: 'dispute.escalated.human' });
    expect(value.routing.outcome).toBe('human_handoff');
    expect(value.routing.readyForHuman).toBe(true);
  });

  test('row 4: `blocked` on version 1 escalates to a human', () => {
    const ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A) });
    const value = apply(ctx, dispositions(ctx, [blockedRecord(LINEAGE_A)]));

    expectRow(value, { row: 4, from: 'open', to: 'escalated_human', event: 'dispute.escalated.human' });
    expect(value.context.lineages[LINEAGE_A].outcome).toBe('escalated_human');
  });

  test('row 5: `fixed` on the version-2 final response resolves the lineage', () => {
    const ctx = context({
      [LINEAGE_A]: lineage(LINEAGE_A, {
        version: 2,
        rebuttedVersions: [1],
        counters: { rebuttals: 1, reconsiderations: 1 },
      }),
    });
    const value = apply(ctx, dispositions(ctx, [fixedRecord(LINEAGE_A, 2)], { runProducedFileChanges: true }));

    expectRow(value, { row: 5, from: 'open', to: 'resolved_fixed', event: 'dispute.resolved' });
  });

  test('row 6: a dispute of version 2 skips reconsideration and goes straight to arbitration', () => {
    const ctx = context({
      [LINEAGE_A]: lineage(LINEAGE_A, {
        version: 2,
        rebuttedVersions: [1],
        counters: { rebuttals: 1, reconsiderations: 1 },
      }),
    });
    const value = apply(ctx, dispositions(ctx, [disputeRecord(LINEAGE_A, 2)]));

    expectRow(value, { row: 6, from: 'open', to: 'arbitration_pending', event: 'dispute.rebuttal.recorded' });
    // §6.2's "no third round": the lineage never enters `disputed` again.
    expect(value.context.lineages[LINEAGE_A].counters.reconsiderations).toBe(1);
    expect(value.context.lineages[LINEAGE_A].rebuttedVersions).toEqual([1, 2]);
    expect(value.routing.turn).toBe('runner');
  });

  test('row 7: a dispute of a human-gated version 2 escalates instead of arbitrating', () => {
    const ctx = context({
      [LINEAGE_A]: lineage(LINEAGE_A, {
        humanGate: true,
        version: 2,
        rebuttedVersions: [1],
        counters: { rebuttals: 1, reconsiderations: 1 },
      }),
    });
    const value = apply(ctx, dispositions(ctx, [disputeRecord(LINEAGE_A, 2)]));

    expectRow(value, { row: 7, from: 'open', to: 'escalated_human', event: 'dispute.escalated.human' });
  });

  test('row 8: `blocked` on version 2 escalates to a human', () => {
    const ctx = context({
      [LINEAGE_A]: lineage(LINEAGE_A, {
        version: 2,
        rebuttedVersions: [1],
        counters: { rebuttals: 1, reconsiderations: 1 },
      }),
    });
    const value = apply(ctx, dispositions(ctx, [blockedRecord(LINEAGE_A, 2)]));

    expectRow(value, { row: 8, from: 'open', to: 'escalated_human' });
  });

  test('row 23: `fixed` on a binding finding resolves it', () => {
    const ctx = context({
      [LINEAGE_A]: lineage(LINEAGE_A, {
        state: 'binding',
        rebuttedVersions: [1],
        counters: { rebuttals: 1, reconsiderations: 1, arbitrationPasses: 1 },
      }),
    });
    const value = apply(ctx, dispositions(ctx, [fixedRecord(LINEAGE_A)], { runProducedFileChanges: true }));

    expectRow(value, { row: 23, from: 'binding', to: 'resolved_fixed', event: 'dispute.resolved' });
  });

  test('row 24: `blocked` on a binding finding escalates to a human', () => {
    const ctx = context({
      [LINEAGE_A]: lineage(LINEAGE_A, {
        state: 'binding',
        rebuttedVersions: [1],
        counters: { rebuttals: 1, reconsiderations: 1, arbitrationPasses: 1 },
      }),
    });
    const value = apply(ctx, dispositions(ctx, [blockedRecord(LINEAGE_A)]));

    expectRow(value, { row: 24, from: 'binding', to: 'escalated_human' });
  });

  test('row 25: with the reconsideration round configured away, a dispute arbitrates instead', () => {
    const sessionLimits = limits({ maxReconsiderationsPerLineage: 0 });
    const ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A) });
    const value = apply(ctx, dispositions(ctx, [disputeRecord(LINEAGE_A)], { sessionLimits }), { sessionLimits });

    expectRow(value, { row: 25, from: 'open', to: 'arbitration_pending', event: 'dispute.rebuttal.recorded' });
    expect(value.context.lineages[LINEAGE_A].counters.reconsiderations).toBe(0);
  });

  test('a `fixed` claim in a run with no diff is refused before any transition (§3.4)', () => {
    const ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A) });
    // #843 rejects it first, so nothing reaches the applicator; the lineage is
    // untouched and the run still counts it as unanswered.
    const decision = dispositions(ctx, [fixedRecord(LINEAGE_A)], { runProducedFileChanges: false });
    expect(decision.outcome.admitted).toEqual([]);
    const value = apply(ctx, decision);

    expect(value.applied).toEqual([]);
    expect(value.context.lineages[LINEAGE_A].state).toBe('open');
    expect(value.unchanged).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §7 rows 9–12 and 26: the reviewer's reconsideration
// ---------------------------------------------------------------------------

describe('§7 rows 9–12 and 26 — reviewer reconsideration', () => {
  const disputedContext = (overrides = {}) =>
    context({
      [LINEAGE_A]: lineage(LINEAGE_A, {
        state: 'disputed',
        rebuttedVersions: [1],
        counters: { rebuttals: 1 },
        ...overrides,
      }),
    });

  test('row 9: `withdraw` resolves the finding with no change required', () => {
    const ctx = disputedContext();
    const value = apply(ctx, reconsideration(LINEAGE_A, ctx, 'withdraw'), { run: { runId: 'run-r1', actor: 'reviewer' } });

    expectRow(value, { row: 9, from: 'disputed', to: 'resolved_withdrawn', event: 'dispute.resolved' });
    expect(value.context.lineages[LINEAGE_A].counters.reconsiderations).toBe(1);
    expect(value.routing.outcome).toBe('resolved_without_changes');
    expect(value.routing.resolvedWithoutChanges).toBe(true);
    expect(value.context.resolvedWithoutChanges).toBe(true);
  });

  test('row 10: `uphold` proceeds directly to arbitration', () => {
    const ctx = disputedContext();
    const value = apply(ctx, reconsideration(LINEAGE_A, ctx, 'uphold'), { run: { runId: 'run-r1', actor: 'reviewer' } });

    expectRow(value, { row: 10, from: 'disputed', to: 'arbitration_pending', event: 'dispute.reconsideration.recorded' });
    expect(value.context.lineages[LINEAGE_A].counters.reconsiderations).toBe(1);
    expect(value.routing.turn).toBe('runner');
  });

  test('row 11: a structurally material revision opens version 2 for one final response', () => {
    const ctx = disputedContext();
    const decision = reconsideration(LINEAGE_A, ctx, 'revise', { revision: MATERIAL_REVISION });
    expect(decision.revision.row).toBe(11);
    const value = apply(ctx, decision, { run: { runId: 'run-r1', actor: 'reviewer' } });

    expectRow(value, { row: 11, from: 'disputed', to: 'open', event: 'dispute.revision.material' });
    expect(value.context.lineages[LINEAGE_A].version).toBe(2);
    // §2.3: the predecessor's consumed slot stays on record, so version 2 gets
    // exactly one fresh rebuttal slot and version 1 is never rebutted again.
    expect(value.context.lineages[LINEAGE_A].rebuttedVersions).toEqual([1]);
    expect(value.routing.turn).toBe('implementer');
  });

  // §2.1/§11: the record mirrors the CURRENT version's fields, so admitting the
  // successor must bring the successor's own. A version 2 left carrying version
  // 1's boundary would prompt the final implementation response against the
  // surface the reviewer revised AWAY from, and publish the old severity with it.
  test('row 11: the admitted successor carries its own severity and boundary', () => {
    const ctx = disputedContext();
    const decision = reconsideration(LINEAGE_A, ctx, 'revise', { revision: RESURFACED_REVISION });
    expect(decision.revision.row).toBe(11);
    const value = apply(ctx, decision, { run: { runId: 'run-r1', actor: 'reviewer' } });

    const after = value.context.lineages[LINEAGE_A];
    expect(after.version).toBe(2);
    expect(after.affectedBoundary).toBe(REVISED_BOUNDARY);
    expect(after.severity).toBe('P2');
  });

  test('rows 12 and 26 leave the unpersisted candidate out of the record', () => {
    const ctx = disputedContext();
    // Row 12: severity moved too, but §5 never makes severity material on its
    // own — and a candidate that was not admitted changes no recorded field.
    const reworded = reconsideration(LINEAGE_A, ctx, 'revise', {
      revision: revisionRecord({
        changedFields: ['severity', 'failureScenario'],
        successor: { severity: 'P2', failureScenario: REWORDED_REVISION.successor.failureScenario },
      }),
    });
    expect(reworded.revision.row).toBe(12);
    const twelve = apply(ctx, reworded, { run: { runId: 'run-r1', actor: 'reviewer' } });
    expect(twelve.context.lineages[LINEAGE_A].severity).toBe('P1');
    expect(twelve.context.lineages[LINEAGE_A].affectedBoundary).toBe(BOUNDARY);

    // Row 26: material, but the successor has no version budget, so the lineage
    // arbitrates at version 1 — with version 1's own fields.
    const sessionLimits = limits({ maxVersionsPerLineage: 1 });
    const capped = reconsideration(LINEAGE_A, ctx, 'revise', { revision: RESURFACED_REVISION, sessionLimits });
    expect(capped.revision.row).toBe(26);
    const twentySix = apply(ctx, capped, { run: { runId: 'run-r1', actor: 'reviewer' }, sessionLimits });
    expect(twentySix.context.lineages[LINEAGE_A].version).toBe(1);
    expect(twentySix.context.lineages[LINEAGE_A].severity).toBe('P1');
    expect(twentySix.context.lineages[LINEAGE_A].affectedBoundary).toBe(BOUNDARY);
  });

  test('row 12: a wording-only revision arbitrates and grants no further rebuttal', () => {
    const ctx = disputedContext();
    const decision = reconsideration(LINEAGE_A, ctx, 'revise', { revision: REWORDED_REVISION });
    expect(decision.revision.row).toBe(12);
    const value = apply(ctx, decision, { run: { runId: 'run-r1', actor: 'reviewer' } });

    expectRow(value, { row: 12, from: 'disputed', to: 'arbitration_pending' });
    expect(value.applied[0].auditEvent).toBe(decision.revision.auditEvents[0]);
    expect(value.context.lineages[LINEAGE_A].version).toBe(1);
  });

  test('row 26: a material revision with no successor-version budget arbitrates at version 1', () => {
    const sessionLimits = limits({ maxVersionsPerLineage: 1 });
    const ctx = disputedContext();
    const decision = reconsideration(LINEAGE_A, ctx, 'revise', { revision: MATERIAL_REVISION, sessionLimits });
    expect(decision.revision.row).toBe(26);
    const value = apply(ctx, decision, { run: { runId: 'run-r1', actor: 'reviewer' }, sessionLimits });

    expectRow(value, { row: 26, from: 'disputed', to: 'arbitration_pending', event: 'dispute.revision.material' });
    expect(value.context.lineages[LINEAGE_A].version).toBe(1);
  });

  test("a rejected revision changes nothing and consumes no counter (§12)", () => {
    const ctx = disputedContext();
    // A revision aimed at a version the lineage has moved past.
    const decision = reconsideration(LINEAGE_A, ctx, 'revise', {
      revision: revisionRecord({ predecessorVersion: 2, successor: { version: 3 } }),
    });
    expect(decision.revision.intent).toBe('rejected');
    const value = apply(ctx, decision, { run: { runId: 'run-r1', actor: 'reviewer' } });

    expect(value.applied).toEqual([]);
    expect(value.refused).toHaveLength(1);
    expect(value.unchanged).toBe(true);
    expect(value.context.lineages[LINEAGE_A]).toEqual(ctx.lineages[LINEAGE_A]);
  });

  test('a reconsideration against a lineage that has since moved is refused (CAS)', () => {
    const ctx = disputedContext();
    const decision = reconsideration(LINEAGE_A, ctx, 'uphold');
    const moved = context({
      [LINEAGE_A]: { ...ctx.lineages[LINEAGE_A], state: 'arbitration_pending', counters: { ...ZERO_LINEAGE_COUNTERS, rebuttals: 1, reconsiderations: 1 } },
    });
    const value = apply(moved, decision, { run: { runId: 'run-r1', actor: 'reviewer' } });

    expect(value.applied).toEqual([]);
    expect(value.refused[0].failure.reason).toBe('invalid-state-record');
    expect(value.unchanged).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §7 rows 13–22: arbitration and the bounded evidence round
// ---------------------------------------------------------------------------

describe('§7 rows 13–22 — arbitration and evidence', () => {
  const ARB_RUN = { runId: 'run-arb-1', actor: 'arbiter' };
  const pendingContext = ({ counters: counterOverrides = {}, ...rest } = {}) =>
    context({
      [LINEAGE_A]: lineage(LINEAGE_A, {
        state: 'arbitration_pending',
        rebuttedVersions: [1],
        ...rest,
        counters: { rebuttals: 1, reconsiderations: 1, ...counterOverrides },
      }),
    });

  test('row 13: a confident `reviewer_correct` makes the finding binding', () => {
    const ctx = pendingContext();
    const value = apply(ctx, verdictTurn(ctx, LINEAGE_A, { verdict: 'reviewer_correct', confidence: 0.9 }), {
      run: ARB_RUN,
    });

    expectRow(value, { row: 13, from: 'arbitration_pending', to: 'binding', event: 'dispute.arbitration.verdict' });
    expect(value.context.lineages[LINEAGE_A].counters.arbitrationPasses).toBe(1);
    expect(value.routing.turn).toBe('implementer');
  });

  test('row 14: a confident `implementer_correct` overrules the finding', () => {
    const ctx = pendingContext();
    const value = apply(ctx, verdictTurn(ctx, LINEAGE_A, { verdict: 'implementer_correct', confidence: 0.95 }), {
      run: ARB_RUN,
    });

    expectRow(value, { row: 14, from: 'arbitration_pending', to: 'resolved_overruled', event: 'dispute.resolved' });
    expect(value.context.lineages[LINEAGE_A].outcome).toBe('resolved_overruled');
  });

  test('row 15: `spec_ambiguous` escalates whatever its confidence', () => {
    const ctx = pendingContext();
    const value = apply(ctx, verdictTurn(ctx, LINEAGE_A, { verdict: 'spec_ambiguous', confidence: 0.99 }), {
      run: ARB_RUN,
    });

    expectRow(value, { row: 15, from: 'arbitration_pending', to: 'escalated_human', event: 'dispute.escalated.human' });
    expect(value.context.lineages[LINEAGE_A].counters.arbitrationPasses).toBe(1);
  });

  test('row 16: `insufficient_evidence` with an available round requests evidence', () => {
    const ctx = pendingContext();
    const value = apply(ctx, verdictTurn(ctx, LINEAGE_A, { verdict: 'insufficient_evidence', confidence: 0.4 }), {
      run: ARB_RUN,
    });

    expectRow(value, {
      row: 16,
      from: 'arbitration_pending',
      to: 'evidence_requested',
      event: 'dispute.evidence.requested',
    });
    // Row 16 REQUESTS the round; row 22 is what marks it used.
    expect(value.context.lineages[LINEAGE_A].counters.evidenceRoundsUsed).toBe(0);
    expect(value.routing.turn).toBe('evidence');
  });

  test('row 17: `insufficient_evidence` with the round already used escalates', () => {
    const ctx = pendingContext({ counters: { evidenceRoundsUsed: 1 } });
    const value = apply(ctx, verdictTurn(ctx, LINEAGE_A, { verdict: 'insufficient_evidence', confidence: 0.4 }), {
      run: ARB_RUN,
    });

    expectRow(value, { row: 17, from: 'arbitration_pending', to: 'escalated_human' });
  });

  test('row 18: a decisive verdict below the threshold decides nothing', () => {
    const ctx = pendingContext();
    const value = apply(ctx, verdictTurn(ctx, LINEAGE_A, { verdict: 'reviewer_correct', confidence: 0.4 }), {
      run: ARB_RUN,
    });

    expectRow(value, { row: 18, from: 'arbitration_pending', to: 'escalated_human' });
    expect(value.context.lineages[LINEAGE_A].counters.arbitrationPasses).toBe(1);
  });

  test('row 19: no acceptable arbiter escalates and spends no counter', () => {
    const ctx = pendingContext();
    const value = apply(ctx, unavailableArbiter(ctx, LINEAGE_A), { run: ARB_RUN });

    expectRow(value, { row: 19, from: 'arbitration_pending', to: 'escalated_human' });
    expect(value.context.lineages[LINEAGE_A].counters).toEqual({
      ...ZERO_LINEAGE_COUNTERS,
      rebuttals: 1,
      reconsiderations: 1,
    });
  });

  test('row 20: a below-cap malformed attempt retries and never spends a pass', () => {
    const ctx = pendingContext();
    const value = apply(ctx, failedTurn(ctx, LINEAGE_A, { kind: 'malformed-response' }), { run: ARB_RUN });

    expectRow(value, {
      row: 20,
      from: 'arbitration_pending',
      to: 'arbitration_pending',
      event: 'dispute.arbitration.malformed',
    });
    expect(value.context.lineages[LINEAGE_A].counters.malformedArbiterAttempts).toBe(1);
    expect(value.context.lineages[LINEAGE_A].counters.arbitrationPasses).toBe(0);
  });

  test('row 21: the cap-reaching malformed attempt escalates and carries the count', () => {
    const ctx = pendingContext({ counters: { malformedArbiterAttempts: 1 } });
    const value = apply(ctx, failedTurn(ctx, LINEAGE_A, { kind: 'empty-output', runId: 'run-arb-2' }), {
      run: { runId: 'run-arb-2', actor: 'arbiter' },
    });

    const entry = expectRow(value, {
      row: 21,
      from: 'arbitration_pending',
      to: 'escalated_human',
      event: 'dispute.escalated.human',
    });
    expect(entry.countersAfter.malformedArbiterAttempts).toBe(2);
    expect(entry.countersAfter.arbitrationPasses).toBe(0);
  });

  test('row 22: recording the evidence round returns the lineage to arbitration and marks it used', () => {
    const ctx = context({
      [LINEAGE_A]: lineage(LINEAGE_A, {
        state: 'evidence_requested',
        rebuttedVersions: [1],
        counters: { rebuttals: 1, reconsiderations: 1, arbitrationPasses: 1 },
      }),
    });
    const value = apply(
      ctx,
      { kind: 'evidence_round', lineageId: LINEAGE_A, version: 1, attachmentsRecorded: 2 },
      { run: { runId: 'run-ev-1', actor: 'runner' } },
    );

    expectRow(value, { row: 22, from: 'evidence_requested', to: 'arbitration_pending' });
    expect(value.context.lineages[LINEAGE_A].counters.evidenceRoundsUsed).toBe(1);
  });

  test('row 22 accepts a round that collected no attachments at all', () => {
    const ctx = context({
      [LINEAGE_A]: lineage(LINEAGE_A, {
        state: 'evidence_requested',
        rebuttedVersions: [1],
        counters: { rebuttals: 1, reconsiderations: 1, arbitrationPasses: 1 },
      }),
    });
    const value = apply(
      ctx,
      { kind: 'evidence_round', lineageId: LINEAGE_A, version: 1, attachmentsRecorded: 0 },
      { run: { runId: 'run-ev-1', actor: 'runner' } },
    );

    expect(value.context.lineages[LINEAGE_A].state).toBe('arbitration_pending');
  });

  test('an operational invocation failure applies no row and consumes no counter', () => {
    const ctx = pendingContext();
    const decision = failedTurn(ctx, LINEAGE_A, { kind: 'agent-failed', detail: 'exit:1' });
    expect(decision.decision.intent).toBe('operational_failure');
    const value = apply(ctx, decision, { run: ARB_RUN });

    expect(value.applied).toEqual([]);
    expect(value.unchanged).toBe(true);
    expect(value.operational).toEqual({ kind: 'agent-failed', failureClass: 'agent-unavailable', detail: 'exit:1' });
    expect(value.context.lineages[LINEAGE_A].counters.arbitrationPasses).toBe(0);
  });

  test('a verdict routed against an older counter baseline is refused', () => {
    const ctx = pendingContext();
    const decision = verdictTurn(ctx, LINEAGE_A, { verdict: 'reviewer_correct', confidence: 0.9 });
    // The lineage moved on between the routing and the write: one pass is
    // already spent, so the decision's `countersAfter` no longer describes it.
    const moved = context({
      [LINEAGE_A]: {
        ...ctx.lineages[LINEAGE_A],
        counters: { ...ctx.lineages[LINEAGE_A].counters, arbitrationPasses: 1 },
      },
    });
    const value = apply(moved, decision, { run: ARB_RUN });

    expect(value.applied).toEqual([]);
    expect(value.refused[0].failure.reason).toBe('invalid-state-record');
    expect(value.unchanged).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §6.1 caps
// ---------------------------------------------------------------------------

describe('§6.1 caps — every counter is bounded and never clamped', () => {
  test('a second run cannot rebut the same version', () => {
    const ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A) });
    const first = apply(ctx, dispositions(ctx, [disputeRecord(LINEAGE_A)]));
    const second = apply(
      first.context,
      dispositions(ctx, [disputeRecord(LINEAGE_A)], { run: OTHER_IMPL_RUN, current: first.context }),
      { run: OTHER_RUN },
    );

    expect(second.applied).toEqual([]);
    expect(second.refused[0].failure.reason).toBe('rebuttal-slot-consumed');
    expect(second.context.lineages[LINEAGE_A].counters.rebuttals).toBe(1);
  });

  test('a reconsideration beyond the round budget is refused, not clamped', () => {
    const ctx = context({
      [LINEAGE_A]: lineage(LINEAGE_A, {
        state: 'disputed',
        rebuttedVersions: [1],
        counters: { rebuttals: 1, reconsiderations: 1 },
      }),
    });
    const value = apply(ctx, reconsideration(LINEAGE_A, ctx, 'withdraw'), {
      run: { runId: 'run-r2', actor: 'reviewer' },
    });

    expect(value.applied).toEqual([]);
    expect(value.refused[0].failure.reason).toBe('too-many-items');
    expect(value.context.lineages[LINEAGE_A].counters.reconsiderations).toBe(1);
  });

  test('an exhausted arbitration budget ends the turn as an operational precondition', () => {
    const ctx = context({
      [LINEAGE_A]: lineage(LINEAGE_A, {
        state: 'arbitration_pending',
        rebuttedVersions: [1],
        counters: { rebuttals: 1, reconsiderations: 1, arbitrationPasses: 2 },
      }),
    });
    const fresh = {
      ...ctx.lineages[LINEAGE_A],
      counters: { ...ctx.lineages[LINEAGE_A].counters, arbitrationPasses: 1 },
    };
    const value = apply(
      ctx,
      verdictTurn(ctx, LINEAGE_A, { verdict: 'reviewer_correct', confidence: 0.9, parseAgainst: fresh }),
      { run: { runId: 'run-arb-3', actor: 'arbiter' } },
    );

    expect(value.applied).toEqual([]);
    expect(value.operational.kind).toBe('arbitration-passes-exhausted');
    expect(value.context.lineages[LINEAGE_A].counters.arbitrationPasses).toBe(2);
  });

  test('a second evidence round is refused once the budget is spent', () => {
    const ctx = context({
      [LINEAGE_A]: lineage(LINEAGE_A, {
        state: 'evidence_requested',
        rebuttedVersions: [1],
        counters: { rebuttals: 1, reconsiderations: 1, arbitrationPasses: 1, evidenceRoundsUsed: 1 },
      }),
    });
    const value = apply(
      ctx,
      { kind: 'evidence_round', lineageId: LINEAGE_A, version: 1, attachmentsRecorded: 1 },
      { run: { runId: 'run-ev-2', actor: 'runner' } },
    );

    expect(value.applied).toEqual([]);
    expect(value.refused[0].failure.reason).toBe('too-many-items');
    expect(value.unchanged).toBe(true);
  });

  test('a decision addressed to a version the lineage has moved past is refused', () => {
    const ctx = context({
      [LINEAGE_A]: lineage(LINEAGE_A, {
        state: 'evidence_requested',
        version: 2,
        rebuttedVersions: [1],
        counters: { rebuttals: 1, reconsiderations: 1, arbitrationPasses: 1 },
      }),
    });
    const value = apply(
      ctx,
      { kind: 'evidence_round', lineageId: LINEAGE_A, version: 1, attachmentsRecorded: 1 },
      { run: { runId: 'run-ev-4', actor: 'runner' } },
    );

    expect(value.applied).toEqual([]);
    expect(value.refused[0].failure.reason).toBe('stale-version');
    expect(value.unchanged).toBe(true);
  });

  test('an evidence round with no arbitration pass left to receive it is refused', () => {
    const ctx = context({
      [LINEAGE_A]: lineage(LINEAGE_A, {
        state: 'evidence_requested',
        rebuttedVersions: [1],
        counters: { rebuttals: 1, reconsiderations: 1, arbitrationPasses: 2 },
      }),
    });
    const value = apply(
      ctx,
      { kind: 'evidence_round', lineageId: LINEAGE_A, version: 1, attachmentsRecorded: 1 },
      { run: { runId: 'run-ev-3', actor: 'runner' } },
    );

    expect(value.refused[0].failure.reason).toBe('arbitration-passes-exhausted');
    expect(value.unchanged).toBe(true);
  });

  test('a malformed-attempt cap lowered to 1 escalates on the first attempt (row 21)', () => {
    const sessionLimits = limits({ maxMalformedArbiterAttemptsPerLineage: 1 });
    const ctx = context({
      [LINEAGE_A]: lineage(LINEAGE_A, {
        state: 'arbitration_pending',
        rebuttedVersions: [1],
        counters: { rebuttals: 1, reconsiderations: 1 },
      }),
    });
    const value = apply(ctx, failedTurn(ctx, LINEAGE_A, { kind: 'empty-output', sessionLimits }), {
      run: { runId: 'run-arb-1', actor: 'arbiter' },
      sessionLimits,
    });

    expectRow(value, { row: 21, from: 'arbitration_pending', to: 'escalated_human' });
    expect(value.context.lineages[LINEAGE_A].counters.malformedArbiterAttempts).toBe(1);
  });

  test('the applied-transition ledger itself is bounded', () => {
    const ledger = Array.from({ length: MAX_APPLIED_TRANSITIONS_PER_LINEAGE }, (_, i) =>
      i.toString(16).padStart(12, '0'),
    );
    const ctx = context({
      [LINEAGE_A]: lineage(LINEAGE_A, { state: 'disputed', rebuttedVersions: [1], counters: { rebuttals: 1 }, appliedTransitions: ledger }),
    });
    const value = apply(ctx, reconsideration(LINEAGE_A, ctx, 'withdraw'), {
      run: { runId: 'run-r9', actor: 'reviewer' },
    });

    expect(value.applied).toEqual([]);
    expect(value.refused[0].failure.reason).toBe('too-many-items');
  });
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe('duplicate delivery', () => {
  test('re-delivering the same fix run applies nothing a second time', () => {
    const ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A), [LINEAGE_B]: lineage(LINEAGE_B) });
    const findings = promptFindings(ctx);
    const records = [disputeRecord(LINEAGE_A), fixedRecord(LINEAGE_B)];
    const first = apply(ctx, dispositions(ctx, records, { runProducedFileChanges: true }));
    expect(first.replayed).toBe(false);

    const redelivery = dispositions(ctx, records, {
      runProducedFileChanges: true,
      findings,
      current: first.context,
    });
    const second = apply(first.context, redelivery);

    expect(second.replayed).toBe(true);
    expect(second.unchanged).toBe(true);
    expect(second.applied.every((entry) => entry.replayed)).toBe(true);
    expect(second.context).toEqual(first.context);
  });

  // A dispute #844 recorded BEFORE this ledger existed carries its consumed
  // rebuttal slot and its `disputeRuns` key, but no `appliedTransitions` entry:
  // the row it earned was never applied, because this layer did not exist yet.
  // #844 still answers the retry from its own key, so the entry arrives
  // `replayed` — and reading that as "already answered" would strand the record
  // in `disputed` forever, since the spent slot means no later run may dispute
  // the version again to push it forward.
  test('a dispute recorded before the ledger existed is advanced, not replayed (row 25)', () => {
    const sessionLimits = limits({ maxReconsiderationsPerLineage: 0 });
    const open = context({ [LINEAGE_A]: lineage(LINEAGE_A) });
    const findings = promptFindings(open);
    const records = [disputeRecord(LINEAGE_A)];
    // The block #844 alone writes, exactly as a pre-#840 task still carries it.
    const preLedger = dispositions(open, records, { sessionLimits }).persistence.context;
    expect(preLedger.lineages[LINEAGE_A].state).toBe('disputed');
    expect(preLedger.lineages[LINEAGE_A].appliedTransitions).toBeUndefined();

    const redelivery = dispositions(open, records, { sessionLimits, findings, current: preLedger });
    expect(redelivery.persistence.persisted[0].replayed).toBe(true);
    const value = apply(preLedger, redelivery, { sessionLimits });

    expectRow(value, { row: 25, from: 'disputed', to: 'arbitration_pending', event: 'dispute.rebuttal.recorded' });
    expect(value.replayed).toBe(false);
    // The slot was charged by the delivery that recorded it; this one spends none.
    expect(value.applied[0].counterDelta).toEqual(ZERO_LINEAGE_COUNTERS);
    expect(value.context.lineages[LINEAGE_A].counters.rebuttals).toBe(1);
    expect(value.context.lineages[LINEAGE_A].rebuttedVersions).toEqual([1]);
    expect(value.routing.turn).toBe('runner');
  });

  test('advancing a pre-ledger dispute writes the entry that makes the NEXT retry a replay', () => {
    const open = context({ [LINEAGE_A]: lineage(LINEAGE_A) });
    const findings = promptFindings(open);
    const records = [disputeRecord(LINEAGE_A)];
    const preLedger = dispositions(open, records).persistence.context;

    const first = apply(preLedger, dispositions(open, records, { findings, current: preLedger }));
    // Row 2's next state is where #844 already left it, so only the ledger moves.
    expectRow(first, { row: 2, from: 'disputed', to: 'disputed', event: 'dispute.rebuttal.recorded' });
    expect(first.context.lineages[LINEAGE_A].appliedTransitions).toEqual([transitionDigest(LINEAGE_A, 1, 'run-1')]);

    const second = apply(first.context, dispositions(open, records, { findings, current: first.context }));

    expect(second.replayed).toBe(true);
    expect(second.unchanged).toBe(true);
    expect(second.context).toEqual(first.context);
    expect(second.context.lineages[LINEAGE_A].counters.rebuttals).toBe(1);
  });

  test('a pre-ledger dispute is refused when #844 read a different block than the stored one', () => {
    const open = context({ [LINEAGE_A]: lineage(LINEAGE_A) });
    const findings = promptFindings(open);
    const records = [disputeRecord(LINEAGE_A)];
    const preLedger = dispositions(open, records).persistence.context;
    const redelivery = dispositions(open, records, { findings, current: preLedger });
    // A replayed entry rewrites nothing, so #844's copy must be the record on
    // file. This one moved after it was read: the advance may not write over it.
    const moved = context({ [LINEAGE_A]: { ...preLedger.lineages[LINEAGE_A], severity: 'P2' } });
    const value = apply(moved, redelivery);

    expect(value.applied).toEqual([]);
    expect(value.refused[0].failure).toEqual({
      reason: 'invalid-state-record',
      detail: `lineages[${LINEAGE_A}]:cas`,
    });
    expect(value.context.lineages[LINEAGE_A]).toEqual(moved.lineages[LINEAGE_A]);
  });

  // Every redelivery above rebuilds #844's persistence against the block the
  // previous delivery wrote. A crash between the commit and the phase's
  // completion does NOT: the retry carries the identical approved decision,
  // whose `persistence` still holds the pre-transition block. #844 recognizes
  // the dispute half from its own key, but it leaves a `fixed`/`blocked` lineage
  // out of `persisted` entirely — rows 1/5/23 and 4/8/24 are this layer's — so
  // only the transition ledger can tell that terminal record apart from a
  // competing writer.
  test('re-delivering the identical approved decision replays its `fixed` half', () => {
    const ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A), [LINEAGE_B]: lineage(LINEAGE_B) });
    const decision = dispositions(ctx, [disputeRecord(LINEAGE_A), fixedRecord(LINEAGE_B)], {
      runProducedFileChanges: true,
    });
    const first = apply(ctx, decision);
    expect(first.context.lineages[LINEAGE_A].state).toBe('disputed');
    expect(first.context.lineages[LINEAGE_B].state).toBe('resolved_fixed');

    const second = apply(first.context, decision);

    expect(second.replayed).toBe(true);
    expect(second.unchanged).toBe(true);
    expect(second.refused).toEqual([]);
    expect(second.applied.every((entry) => entry.replayed)).toBe(true);
    expect(second.context).toEqual(first.context);
  });

  test('re-delivering the identical approved decision replays its `blocked` half', () => {
    const ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A) });
    const decision = dispositions(ctx, [blockedRecord(LINEAGE_A)], { runProducedFileChanges: true });
    const first = apply(ctx, decision);
    expect(first.context.lineages[LINEAGE_A].state).toBe('escalated_human');

    const second = apply(first.context, decision);

    expect(second.replayed).toBe(true);
    expect(second.refused).toEqual([]);
    expect(second.context).toEqual(first.context);
    expect(second.routing.readyForHuman).toBe(true);
  });

  test('a lineage that moved for another reason still fails closed (CAS)', () => {
    const ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A), [LINEAGE_B]: lineage(LINEAGE_B) });
    const decision = dispositions(ctx, [disputeRecord(LINEAGE_A), fixedRecord(LINEAGE_B)], {
      runProducedFileChanges: true,
    });
    // B resolved under a DIFFERENT run: no ledger entry of this one's, so the
    // block is newer review state and nothing may be written over it.
    const moved = context({
      ...ctx.lineages,
      [LINEAGE_B]: { ...ctx.lineages[LINEAGE_B], state: 'resolved_fixed', outcome: 'resolved_fixed' },
    });
    const result = applyRaw(moved, decision);

    expect(result.ok).toBe(false);
    expect(result.failure.reason).toBe('invalid-state-record');
    expect(result.failure.detail).toBe(`lineages[${LINEAGE_B}]:cas`);
  });

  test('re-delivering an arbitration verdict spends no second pass', () => {
    const ctx = context({
      [LINEAGE_A]: lineage(LINEAGE_A, {
        state: 'arbitration_pending',
        rebuttedVersions: [1],
        counters: { rebuttals: 1, reconsiderations: 1 },
      }),
    });
    const decision = verdictTurn(ctx, LINEAGE_A, { verdict: 'reviewer_correct', confidence: 0.9 });
    const run = { runId: 'run-arb-1', actor: 'arbiter' };
    const first = apply(ctx, decision, { run });
    const second = apply(first.context, decision, { run });

    expect(second.replayed).toBe(true);
    expect(second.context.lineages[LINEAGE_A].counters.arbitrationPasses).toBe(1);
    expect(second.applied[0].counterDelta.arbitrationPasses).toBe(0);
    expect(second.routing).toEqual(first.routing);
  });

  test('a DIFFERENT run delivering the same reconsideration is refused, not replayed', () => {
    const ctx = context({
      [LINEAGE_A]: lineage(LINEAGE_A, { state: 'disputed', rebuttedVersions: [1], counters: { rebuttals: 1 } }),
    });
    const decision = reconsideration(LINEAGE_A, ctx, 'uphold');
    const first = apply(ctx, decision, { run: { runId: 'run-r1', actor: 'reviewer' } });
    const second = apply(first.context, decision, { run: { runId: 'run-r2', actor: 'reviewer' } });

    expect(second.applied).toEqual([]);
    expect(second.refused).toHaveLength(1);
    expect(second.context.lineages[LINEAGE_A].counters.reconsiderations).toBe(1);
  });

  // The other half of #847's "dedupe on the run key, not the row": a genuinely
  // NEW arbitration turn for the same lineage version must carry a new run id.
  // Reusing one is indistinguishable from a redelivery, and this layer fails
  // closed in the direction that never applies a transition twice.
  test('a second arbitration turn reusing one run id is dropped as a replay', () => {
    const ctx = context({
      [LINEAGE_A]: lineage(LINEAGE_A, {
        state: 'arbitration_pending',
        rebuttedVersions: [1],
        counters: { rebuttals: 1, reconsiderations: 1 },
      }),
    });
    const run = { runId: 'run-arb-1', actor: 'arbiter' };
    const first = apply(ctx, failedTurn(ctx, LINEAGE_A, { kind: 'malformed-response' }), { run });
    expect(first.context.lineages[LINEAGE_A].counters.malformedArbiterAttempts).toBe(1);

    const retry = failedTurn(first.context, LINEAGE_A, { kind: 'malformed-response' });
    expect(retry.decision.row).toBe(21);
    const second = apply(first.context, retry, { run });

    expect(second.replayed).toBe(true);
    expect(second.context.lineages[LINEAGE_A].counters.malformedArbiterAttempts).toBe(1);
    expect(second.context.lineages[LINEAGE_A].state).toBe('arbitration_pending');
  });

  test('the ledger digest is stable and opaque', () => {
    const digest = transitionDigest(LINEAGE_A, 1, 'run-1');
    expect(digest).toBe(transitionDigest(LINEAGE_A, 1, 'run-1'));
    expect(digest).toMatch(/^[0-9a-f]{12}$/);
    expect(digest).not.toContain('run-1');
    expect(transitionDigest(LINEAGE_A, 2, 'run-1')).not.toBe(digest);
  });

  test('a re-delivered row-6 dispute reads as a replay rather than a refusal', () => {
    const ctx = context({
      [LINEAGE_A]: lineage(LINEAGE_A, {
        version: 2,
        rebuttedVersions: [1],
        counters: { rebuttals: 1, reconsiderations: 1 },
      }),
    });
    const findings = promptFindings(ctx);
    const first = apply(ctx, dispositions(ctx, [disputeRecord(LINEAGE_A, 2)]));
    expect(first.context.lineages[LINEAGE_A].state).toBe('arbitration_pending');

    const second = apply(
      first.context,
      dispositions(ctx, [disputeRecord(LINEAGE_A, 2)], { findings, current: first.context }),
    );

    expect(second.replayed).toBe(true);
    expect(second.refused).toEqual([]);
    expect(second.context).toEqual(first.context);
  });
});

// ---------------------------------------------------------------------------
// §7.1 run-level aggregation
// ---------------------------------------------------------------------------

describe('§7.1 run-level aggregation', () => {
  const build = (states) =>
    context(
      Object.fromEntries(
        Object.entries(states).map(([id, state]) => [
          id,
          lineage(id, {
            state,
            ...(state === 'resolved_fixed' || state === 'resolved_withdrawn' || state === 'resolved_overruled' || state === 'escalated_human'
              ? { outcome: state }
              : {}),
          }),
        ]),
      ),
    );

  test('rule 1 wins over every other state', () => {
    const routing = aggregateDisputeRouting(build({ [LINEAGE_A]: 'open', [LINEAGE_B]: 'escalated_human' }));
    expect(routing.rule).toBe(1);
    expect(routing.outcome).toBe('human_handoff');
    expect(routing.readyForHuman).toBe(true);
    expect(routing.escalatedLineageIds).toEqual([LINEAGE_B]);
  });

  test('rule 1 also fires for a terminal lineage carrying `reopen_requested`', () => {
    const ctx = context({
      [LINEAGE_A]: lineage(LINEAGE_A, { state: 'resolved_withdrawn', outcome: 'resolved_withdrawn', reopenRequested: true }),
    });
    const routing = aggregateDisputeRouting(ctx);
    expect(routing.rule).toBe(1);
    expect(routing.reopenRequestedLineageIds).toEqual([LINEAGE_A]);
  });

  test('rule 2 prefers the implementer turn over a waiting `disputed` lineage', () => {
    const routing = aggregateDisputeRouting(build({ [LINEAGE_A]: 'disputed', [LINEAGE_B]: 'open' }));
    expect(routing).toMatchObject({ rule: 2, turn: 'implementer', nextPhase: 'implementation' });
    expect(routing.actionableLineageIds).toEqual([LINEAGE_B]);
  });

  test('rule 2 falls through disputed → evidence → runner', () => {
    expect(aggregateDisputeRouting(build({ [LINEAGE_A]: 'disputed' })).turn).toBe('reviewer');
    expect(aggregateDisputeRouting(build({ [LINEAGE_A]: 'evidence_requested' })).turn).toBe('evidence');
    expect(aggregateDisputeRouting(build({ [LINEAGE_A]: 'arbitration_pending' })).turn).toBe('runner');
    expect(aggregateDisputeRouting(build({ [LINEAGE_A]: 'arbitration_pending' })).nextPhase).toBeNull();
  });

  test('rule 3 routes an unreviewed diff back to review and clears the deferred flag', () => {
    const ctx = { ...build({ [LINEAGE_A]: 'resolved_withdrawn' }), pendingReReview: true };
    const routing = aggregateDisputeRouting(ctx);
    expect(routing).toMatchObject({ rule: 3, outcome: 're_review', nextPhase: 'review', pendingReReview: false });
  });

  test('rule 4 records the zero-change outcome only for a fully structured review', () => {
    const structured = aggregateDisputeRouting(build({ [LINEAGE_A]: 'resolved_withdrawn' }));
    expect(structured).toMatchObject({ rule: 4, outcome: 'resolved_without_changes', resolvedWithoutChanges: true });

    const mixed = aggregateDisputeRouting({
      ...build({ [LINEAGE_A]: 'resolved_withdrawn' }),
      reviewStructure: 'mixed',
    });
    expect(mixed).toMatchObject({ rule: 4, outcome: 'no_change_run_invalid', resolvedWithoutChanges: false });
  });

  test('a block with no lineage leaves the legacy path untouched', () => {
    const routing = aggregateDisputeRouting(context({}, { reviewStructure: 'legacy' }));
    expect(routing).toMatchObject({ rule: null, outcome: 'legacy', turn: 'none', nextPhase: null, readyForHuman: false });
  });

  test('aggregation is order-independent', () => {
    const forward = aggregateDisputeRouting(build({ [LINEAGE_A]: 'open', [LINEAGE_B]: 'disputed' }));
    const reverse = aggregateDisputeRouting(build({ [LINEAGE_B]: 'disputed', [LINEAGE_A]: 'open' }));
    expect(forward).toEqual(reverse);
  });

  test('every declared outcome literal is one this aggregation can produce', () => {
    const produced = new Set([
      aggregateDisputeRouting(build({ [LINEAGE_A]: 'escalated_human' })).outcome,
      aggregateDisputeRouting(build({ [LINEAGE_A]: 'open' })).outcome,
      aggregateDisputeRouting({ ...build({ [LINEAGE_A]: 'resolved_fixed' }), pendingReReview: true }).outcome,
      aggregateDisputeRouting(build({ [LINEAGE_A]: 'resolved_withdrawn' })).outcome,
      aggregateDisputeRouting({ ...build({ [LINEAGE_A]: 'resolved_withdrawn' }), reviewStructure: 'mixed' }).outcome,
      aggregateDisputeRouting(context({})).outcome,
    ]);
    expect([...produced].sort()).toEqual([...DISPUTE_TASK_OUTCOMES].sort());
  });

  test('a diff-bearing fix run that keeps a lineage open defers its re-review', () => {
    const ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A), [LINEAGE_B]: lineage(LINEAGE_B) });
    const value = apply(
      ctx,
      dispositions(ctx, [fixedRecord(LINEAGE_A), disputeRecord(LINEAGE_B)], { runProducedFileChanges: true }),
    );

    expect(value.routing).toMatchObject({ rule: 2, turn: 'reviewer', pendingReReview: true });
    expect(value.context.pendingReReview).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Finding admission and whole-operation failures
// ---------------------------------------------------------------------------

describe('finding admission and fail-closed inputs', () => {
  test('a newly admitted lineage opens at version 1 and emits `dispute.finding.opened`', () => {
    const before = context({}, { reviewStructure: 'legacy' });
    const next = context({ [LINEAGE_A]: lineage(LINEAGE_A) });
    const value = apply(before, { kind: 'finding_admission', next }, { run: { runId: 'run-review-1', actor: 'reviewer' } });

    expect(value.applied).toEqual([
      expect.objectContaining({ lineageId: LINEAGE_A, auditEvent: 'dispute.finding.opened', row: null }),
    ]);
    expect(value.context.reviewStructure).toBe('structured');
    expect(value.routing.turn).toBe('implementer');
  });

  test('an admission that rewrites a lineage already on file fails closed', () => {
    const before = context({ [LINEAGE_A]: lineage(LINEAGE_A, { state: 'disputed', rebuttedVersions: [1], counters: { rebuttals: 1 } }) });
    const next = context({ [LINEAGE_A]: lineage(LINEAGE_A) });
    const result = applyRaw(before, { kind: 'finding_admission', next }, { run: { runId: 'run-review-2', actor: 'reviewer' } });

    expect(result.ok).toBe(false);
    expect(result.failure.reason).toBe('invalid-state-record');
  });

  test('a re-delivered admission opens nothing and writes nothing', () => {
    const before = context({}, { reviewStructure: 'legacy' });
    const next = context({ [LINEAGE_A]: lineage(LINEAGE_A) });
    const run = { runId: 'run-review-1', actor: 'reviewer' };
    const first = apply(before, { kind: 'finding_admission', next }, { run });
    const second = apply(first.context, { kind: 'finding_admission', next: first.context }, { run });

    expect(second.replayed).toBe(true);
    expect(second.applied).toEqual([]);
    expect(second.context).toEqual(first.context);
  });

  test('a dispositions decision computed against a different block fails closed', () => {
    const ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A), [LINEAGE_B]: lineage(LINEAGE_B) });
    const decision = dispositions(ctx, [disputeRecord(LINEAGE_A)]);
    // The block moved for a reason this layer cannot see: B was revised while
    // the fix run was in flight.
    const moved = context({
      [LINEAGE_A]: ctx.lineages[LINEAGE_A],
      [LINEAGE_B]: lineage(LINEAGE_B, { state: 'disputed', rebuttedVersions: [1], counters: { rebuttals: 1 } }),
    });
    const result = applyRaw(moved, decision);

    expect(result.ok).toBe(false);
    expect(result.failure.detail).toContain(LINEAGE_B);
  });

  test('an unvalidatable baseline is refused rather than written over', () => {
    const result = applyRaw(context({ [LINEAGE_A]: lineage(LINEAGE_A, { counters: { rebuttals: 9 } }) }), {
      kind: 'reopen_request',
      lineageId: LINEAGE_A,
    });
    expect(result.ok).toBe(false);
  });

  test('`reopen_requested` escalates at run level without moving the terminal lineage', () => {
    const ctx = context({
      [LINEAGE_A]: lineage(LINEAGE_A, { state: 'resolved_overruled', outcome: 'resolved_overruled' }),
    });
    const value = apply(ctx, { kind: 'reopen_request', lineageId: LINEAGE_A }, { run: { runId: 'run-x', actor: 'runner' } });

    expect(value.applied[0]).toMatchObject({
      auditEvent: 'dispute.reopen.requested',
      row: null,
      fromState: 'resolved_overruled',
      toState: 'resolved_overruled',
    });
    expect(value.context.lineages[LINEAGE_A].reopenRequested).toBe(true);
    expect(value.routing).toMatchObject({ rule: 1, outcome: 'human_handoff', readyForHuman: true });
  });

  test('`reopen_requested` on a live lineage is refused (§6.4)', () => {
    const ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A) });
    const value = apply(ctx, { kind: 'reopen_request', lineageId: LINEAGE_A }, { run: { runId: 'run-x', actor: 'runner' } });

    expect(value.applied).toEqual([]);
    expect(value.refused[0].failure.reason).toBe('not-actionable-state');
  });
});

// ---------------------------------------------------------------------------
// Contract-wide invariants
// ---------------------------------------------------------------------------

describe('contract-wide invariants', () => {
  test('every produced block validates and carries no prose', () => {
    const ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A) });
    const value = apply(ctx, dispositions(ctx, [disputeRecord(LINEAGE_A)]));

    expect(validateReviewDisputeContext(value.context).ok).toBe(true);
    expect(value.serialized).not.toContain(ARGUMENT);
    expect(JSON.stringify(value.event)).not.toContain(ARGUMENT);
    expect(JSON.stringify(value.event)).not.toContain(RATIONALE);
  });

  test('the event payload carries the run identity, the rows, and nothing else unbounded', () => {
    const ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A) });
    const value = apply(ctx, dispositions(ctx, [disputeRecord(LINEAGE_A)]));

    expect(value.event).toMatchObject({ decision: 'dispositions', runId: 'run-1', actor: 'implementer' });
    expect(value.event.auditEvents).toEqual(['dispute.rebuttal.recorded']);
    expect(value.event.routing).toEqual(value.routing);
  });

  test('every §7 row this layer can name is in the declared row vocabulary', () => {
    const rows = new Set(DISPUTE_TRANSITION_ROWS);
    for (const row of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26]) {
      expect(rows.has(row)).toBe(true);
    }
  });

  test('the applicator is a pure function of its inputs', () => {
    const ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A) });
    const decision = dispositions(ctx, [disputeRecord(LINEAGE_A)]);
    const snapshot = JSON.parse(JSON.stringify(ctx));
    const first = apply(ctx, decision);
    const second = apply(ctx, decision);

    expect(JSON.parse(JSON.stringify(ctx))).toEqual(snapshot);
    expect(first.serialized).toBe(second.serialized);
    expect(first.routing).toEqual(second.routing);
  });
});
