/**
 * Unit tests for the issue #844 dispute persistence writer
 * (src/core/review-dispute-persistence.ts).
 *
 * The module takes an already-validated #843 outcome and answers one question:
 * what does `task.context.reviewDispute` look like after this run? It is pure,
 * so every case below is a value in, a value out — and that is exactly what
 * makes the two guarantees testable: handing the SAME run's outcome to the
 * function twice must store one dispute, and handing an OLDER run's outcome to a
 * block that has moved on must store none.
 *
 * The outcomes are produced by the real #843 parser rather than hand-built, so
 * no test can persist something the contract would never have admitted.
 */
import {
  DISPUTE_LIFECYCLE_EVENTS,
  persistFixDisputes,
  planDisputeRetention,
} from '../dist/core/review-dispute-persistence.js';
import { parseFixDispositionResponse } from '../dist/core/review-fix-disposition-response.js';
import {
  MAX_LINEAGES_PER_TASK,
  REVIEW_DISPUTE_CONTEXT_MAX_BYTES,
  REVIEW_DISPUTE_DEFAULT_LIMITS,
} from '../dist/core/review-dispute.js';
import { validateReviewDisputeContext } from '../dist/core/review-dispute-validation.js';

const LINEAGE_A = 'ln-aaaaaaaaaaaa';
const LINEAGE_B = 'ln-bbbbbbbbbbbb';
const EVIDENCE_PATH = 'src/auth/handler.ts';
const ARGUMENT = 'The null session is already rejected by the middleware, so the cited crash cannot occur.';

const RUN = { runId: 'run-impl-1', agentId: 'claude', timestamp: '2026-08-05T00:00:00.000Z' };
const OTHER_RUN = { runId: 'run-impl-2', agentId: 'claude', timestamp: '2026-08-05T01:00:00.000Z' };

function lineage(id, overrides = {}) {
  return {
    lineageId: id,
    state: 'open',
    version: 1,
    counters: { rebuttals: 0, reconsiderations: 0, arbitrationPasses: 0, malformedArbiterAttempts: 0, evidenceRoundsUsed: 0 },
    rebuttedVersions: [],
    humanGate: false,
    severity: 'P1',
    affectedBoundary: EVIDENCE_PATH,
    ...overrides,
  };
}

function context(lineages, overrides = {}) {
  return { version: 1, reviewStructure: 'structured', lineages, ...overrides };
}

function disputed(id, version = 1, overrides = {}) {
  return {
    lineageId: id,
    version,
    disposition: 'review_disputed',
    dispute: {
      challenged: { lineageId: id, version },
      rebuttalReason: 'false_premise',
      argument: ARGUMENT,
      evidenceRefs: [{ kind: 'file', path: EVIDENCE_PATH, startLine: 30, endLine: 36 }],
      whyNoChange: 'A second guard would duplicate the existing one without changing behavior.',
    },
    ...overrides,
  };
}

function fixed(id, version = 1) {
  return { lineageId: id, version, disposition: 'fixed', note: 'Added the null guard.' };
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

/** Parse a disposition set against `ctx` exactly as the fix handler does. */
function outcomeFor(ctx, records, { runProducedFileChanges = false } = {}) {
  return parseFixDispositionResponse({
    response: block(records),
    findings: promptFindings(ctx),
    lineages: ctx.lineages,
    reviewStructure: ctx.reviewStructure,
    runProducedFileChanges,
    resolveEvidenceRef: () => true,
    limits: REVIEW_DISPUTE_DEFAULT_LIMITS,
  });
}

function persist(ctx, records, { run = RUN, runProducedFileChanges = false, current = ctx, limits } = {}) {
  const outcome = outcomeFor(ctx, records, { runProducedFileChanges });
  return persistFixDisputes({
    context: current,
    outcome,
    run,
    runProducedFileChanges,
    ...(limits ? { limits } : {}),
  });
}

/** A deep, structurally identical copy — a stored block read back from SQLite. */
function reread(ctx) {
  return JSON.parse(JSON.stringify(ctx));
}

describe('persistFixDisputes — recording an admitted dispute', () => {
  test('moves the lineage to `disputed` and consumes the version rebuttal slot', () => {
    const ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A) });
    const result = persist(ctx, [disputed(LINEAGE_A)]);

    expect(result.ok).toBe(true);
    const value = result.value;
    expect(value.context.lineages[LINEAGE_A]).toMatchObject({
      state: 'disputed',
      version: 1,
      rebuttedVersions: [1],
      disputeRuns: [{ version: 1, runId: 'run-impl-1' }],
    });
    expect(value.context.lineages[LINEAGE_A].counters.rebuttals).toBe(1);
    expect(value.unchanged).toBe(false);
    expect(value.persisted).toEqual([
      { lineageId: LINEAGE_A, version: 1, state: 'disputed', replayed: false },
    ]);
    expect(value.refused).toEqual([]);
    // The block it produces is one the #836 validator accepts, so it can be
    // read back by the next run rather than failing closed as malformed.
    expect(validateReviewDisputeContext(JSON.parse(value.serialized), 'reviewDispute').ok).toBe(true);
  });

  test('returns the typed pending-reconsideration state for downstream routing', () => {
    const ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A) });
    const { value } = persist(ctx, [disputed(LINEAGE_A)]);

    expect(value.routing).toEqual({
      kind: 'pending_reconsideration',
      lineages: [{ lineageId: LINEAGE_A, version: 1 }],
      escalatedLineageIds: [],
      pendingReReview: false,
    });
    expect(value.summary).toMatchObject({
      runId: 'run-impl-1',
      agentId: 'claude',
      persisted: 1,
      replayed: 0,
      refused: 0,
      disputedLineageIds: [LINEAGE_A],
      escalatedLineageIds: [],
      routing: 'pending_reconsideration',
    });
  });

  test('writes the complete record to a local artifact, with no local path inside it', () => {
    const ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A) });
    const { value } = persist(ctx, [disputed(LINEAGE_A)]);

    expect(value.artifacts).toHaveLength(1);
    expect(value.artifacts[0].name).toBe(`dispute-${LINEAGE_A}.json`);
    const record = JSON.parse(value.artifacts[0].content);
    // Complete enough for reconsideration and for a human audit: the argument,
    // the closed rebuttal reason, the evidence, and who produced it.
    expect(record.record.dispute.argument).toBe(ARGUMENT);
    expect(record.record.dispute.rebuttalReason).toBe('false_premise');
    expect(record.record.dispute.evidenceRefs).toEqual([
      { kind: 'file', path: EVIDENCE_PATH, startLine: 30, endLine: 36 },
    ]);
    expect(record.run).toEqual({ runId: 'run-impl-1', agentId: 'claude', timestamp: RUN.timestamp });
    expect(record.state).toBe('disputed');
    // The artifact names only the run's own identity and repository-relative
    // locations — the directory it lands in is the caller's and never inside it.
    expect(value.artifacts[0].content).not.toMatch(/\/(Users|home|tmp|var)\//);
  });

  test('task context stays literals-only: no argument, note, or evidence prose', () => {
    const ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A) });
    const { value } = persist(ctx, [disputed(LINEAGE_A, 1, { note: 'a note that must not travel in task context' })]);

    expect(value.serialized).not.toContain('already rejected by the middleware');
    expect(value.serialized).not.toContain('must not travel');
    expect(JSON.stringify(value.summary)).not.toContain('already rejected by the middleware');
  });

  test('a human-gated finding escalates at dispute admission instead of entering `disputed`', () => {
    const ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A, { humanGate: true }) });
    const { value } = persist(ctx, [disputed(LINEAGE_A)]);

    expect(value.context.lineages[LINEAGE_A]).toMatchObject({
      state: 'escalated_human',
      outcome: 'escalated_human',
      rebuttedVersions: [1],
    });
    // No reviewer turn is proposed for it: the human the gate exists to involve
    // must not be routed around by an automated reconsideration.
    expect(value.routing).toEqual({
      kind: 'pending_reconsideration',
      lineages: [],
      escalatedLineageIds: [LINEAGE_A],
      pendingReReview: false,
    });
  });

  test('a run that admitted no dispute leaves the block byte-identical', () => {
    const ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A) });
    const result = persist(ctx, [fixed(LINEAGE_A)], { runProducedFileChanges: true });

    expect(result.value.unchanged).toBe(true);
    expect(result.value.context.lineages[LINEAGE_A]).toEqual(ctx.lineages[LINEAGE_A]);
    expect(result.value.routing).toEqual({ kind: 'none' });
    expect(result.value.artifacts).toEqual([]);
  });

  test('never persists a rejected or unanswered disposition as an admitted dispute', () => {
    const ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A), [LINEAGE_B]: lineage(LINEAGE_B) });
    // LINEAGE_B's record names a version the lineage does not carry, so #843
    // rejects it; LINEAGE_A is answered and admitted.
    const outcome = outcomeFor(ctx, [disputed(LINEAGE_A), disputed(LINEAGE_B, 2)]);
    expect(outcome.admitted).toHaveLength(1);
    expect(outcome.rejected).toHaveLength(1);

    const { value } = persistFixDisputes({
      context: ctx,
      outcome,
      run: RUN,
      runProducedFileChanges: false,
    });
    expect(value.context.lineages[LINEAGE_A].state).toBe('disputed');
    // The rejected one stays exactly where it was (§12).
    expect(value.context.lineages[LINEAGE_B]).toEqual(ctx.lineages[LINEAGE_B]);
    expect(value.summary.persisted).toBe(1);
  });
});

describe('persistFixDisputes — idempotency for one run identity', () => {
  test('a retried delivery of the same run stores one dispute only', () => {
    const ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A) });
    const first = persist(ctx, [disputed(LINEAGE_A)]);
    // The worker's result is delivered a second time: same run id, same
    // response, but the block now already carries what the first write stored.
    const stored = reread(first.value.context);
    const second = persist(ctx, [disputed(LINEAGE_A)], { current: stored });

    expect(second.ok).toBe(true);
    expect(second.value.unchanged).toBe(true);
    expect(second.value.context.lineages[LINEAGE_A].counters.rebuttals).toBe(1);
    expect(second.value.context.lineages[LINEAGE_A].rebuttedVersions).toEqual([1]);
    expect(second.value.context.lineages[LINEAGE_A].disputeRuns).toEqual([{ version: 1, runId: 'run-impl-1' }]);
    expect(second.value.persisted).toEqual([
      { lineageId: LINEAGE_A, version: 1, state: 'disputed', replayed: true },
    ]);
    expect(second.value.refused).toEqual([]);
    expect(second.value.summary).toMatchObject({ persisted: 0, replayed: 1, refused: 0 });
    // Routing is unchanged by the retry: the same reviewer turn is still pending.
    expect(second.value.routing).toEqual(first.value.routing);
  });

  test('the replayed run rewrites byte-identical artifact content', () => {
    const ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A) });
    const first = persist(ctx, [disputed(LINEAGE_A)]);
    const second = persist(ctx, [disputed(LINEAGE_A)], { current: reread(first.value.context) });

    expect(second.value.artifacts).toEqual(first.value.artifacts);
  });

  test('a human-gated replay is recognized in its terminal state too', () => {
    const ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A, { humanGate: true }) });
    const first = persist(ctx, [disputed(LINEAGE_A)]);
    const second = persist(ctx, [disputed(LINEAGE_A)], { current: reread(first.value.context) });

    expect(second.value.persisted).toEqual([
      { lineageId: LINEAGE_A, version: 1, state: 'escalated_human', replayed: true },
    ]);
    expect(second.value.unchanged).toBe(true);
  });

  test('a replay whose lineage has since moved to a new version is refused, not re-reported', () => {
    // The reviewer revised the finding (§4.2) between the first delivery and the
    // retry: this run's dispute is history, and re-reporting it as pending would
    // request a reviewer turn for a version the reviewer already answered.
    const ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A) });
    const first = persist(ctx, [disputed(LINEAGE_A)]);
    const moved = reread(first.value.context);
    moved.lineages[LINEAGE_A].version = 2;
    moved.lineages[LINEAGE_A].state = 'open';

    const second = persist(ctx, [disputed(LINEAGE_A)], { current: moved });
    expect(second.value.persisted).toEqual([]);
    expect(second.value.refused).toEqual([
      { lineageId: LINEAGE_A, version: 1, failure: { reason: 'stale-version', detail: `lineages[${LINEAGE_A}].version:1` } },
    ]);
    expect(second.value.context.lineages[LINEAGE_A]).toEqual(moved.lineages[LINEAGE_A]);
  });
});

describe('persistFixDisputes — compare-and-set against the current block', () => {
  test('claim loss: a different run cannot record a second rebuttal for the same version', () => {
    // The first worker lost its lease after persisting; a fresh claim re-ran the
    // phase and the new agent produced the same dispute. The version's single
    // §6.1 slot is already spent by another run, so the second one is refused.
    const ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A) });
    const first = persist(ctx, [disputed(LINEAGE_A)]);
    const stored = reread(first.value.context);

    const second = persistFixDisputes({
      context: stored,
      // Parsed against the pre-dispute snapshot, exactly as the re-run would.
      outcome: outcomeFor(ctx, [disputed(LINEAGE_A)]),
      run: OTHER_RUN,
      runProducedFileChanges: false,
    });
    expect(second.value.persisted).toEqual([]);
    expect(second.value.refused).toEqual([
      {
        lineageId: LINEAGE_A,
        version: 1,
        failure: { reason: 'rebuttal-slot-consumed', detail: `lineages[${LINEAGE_A}].version:1` },
      },
    ]);
    expect(second.value.unchanged).toBe(true);
    expect(second.value.context.lineages[LINEAGE_A].counters.rebuttals).toBe(1);
    expect(second.value.context.lineages[LINEAGE_A].disputeRuns).toEqual([{ version: 1, runId: 'run-impl-1' }]);
    expect(second.value.summary.refusals).toEqual([
      { lineageId: LINEAGE_A, version: 1, reason: 'rebuttal-slot-consumed', detail: `lineages[${LINEAGE_A}].version:1` },
    ]);
  });

  test('a stale rebuttal cannot overwrite a newer finding version', () => {
    const ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A) });
    const outcome = outcomeFor(ctx, [disputed(LINEAGE_A)]);
    // The reviewer revised the finding while this run was working.
    const current = context({ [LINEAGE_A]: lineage(LINEAGE_A, { version: 2 }) });

    const { value } = persistFixDisputes({ context: current, outcome, run: RUN, runProducedFileChanges: false });
    expect(value.refused[0].failure.reason).toBe('stale-version');
    expect(value.context.lineages[LINEAGE_A]).toEqual(current.lineages[LINEAGE_A]);
    expect(value.unchanged).toBe(true);
  });

  test('a lineage the reviewer already resolved refuses the dispute', () => {
    const ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A) });
    const outcome = outcomeFor(ctx, [disputed(LINEAGE_A)]);
    const current = context({
      [LINEAGE_A]: lineage(LINEAGE_A, { state: 'resolved_withdrawn', outcome: 'resolved_withdrawn' }),
    });

    const { value } = persistFixDisputes({ context: current, outcome, run: RUN, runProducedFileChanges: false });
    expect(value.refused[0].failure).toEqual({
      reason: 'not-actionable-state',
      detail: `lineages[${LINEAGE_A}].state:resolved_withdrawn`,
    });
    expect(value.context.lineages[LINEAGE_A].state).toBe('resolved_withdrawn');
  });

  test('a version that became `binding` refuses the dispute as row 24 does', () => {
    const ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A) });
    const outcome = outcomeFor(ctx, [disputed(LINEAGE_A)]);
    const current = context({ [LINEAGE_A]: lineage(LINEAGE_A, { state: 'binding' }) });

    const { value } = persistFixDisputes({ context: current, outcome, run: RUN, runProducedFileChanges: false });
    expect(value.refused[0].failure.reason).toBe('dispute-on-binding');
  });

  test('any other drift in the lineage record fails closed rather than overwriting it', () => {
    const ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A) });
    const outcome = outcomeFor(ctx, [disputed(LINEAGE_A)]);
    // Same id, same version, same state — but a counter this run never saw.
    const current = context({
      [LINEAGE_A]: lineage(LINEAGE_A, {
        counters: { rebuttals: 0, reconsiderations: 1, arbitrationPasses: 0, malformedArbiterAttempts: 0, evidenceRoundsUsed: 0 },
      }),
    });

    const { value } = persistFixDisputes({ context: current, outcome, run: RUN, runProducedFileChanges: false });
    expect(value.refused[0].failure).toEqual({
      reason: 'invalid-state-record',
      detail: `lineages[${LINEAGE_A}]:cas`,
    });
    expect(value.unchanged).toBe(true);
  });

  test('a lineage the current block no longer carries is refused as unknown', () => {
    const ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A), [LINEAGE_B]: lineage(LINEAGE_B) });
    const outcome = outcomeFor(ctx, [disputed(LINEAGE_A)]);
    const current = context({ [LINEAGE_B]: lineage(LINEAGE_B) });

    const { value } = persistFixDisputes({ context: current, outcome, run: RUN, runProducedFileChanges: false });
    expect(value.refused[0].failure.reason).toBe('unknown-lineage');
    expect(value.unchanged).toBe(true);
  });

  test('existing task rows need no migration: a block with no `disputeRuns` is written normally', () => {
    // Exactly the shape #841 persists today — nothing #844 added.
    const ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A) });
    expect(ctx.lineages[LINEAGE_A].disputeRuns).toBeUndefined();

    const { value } = persist(ctx, [disputed(LINEAGE_A)]);
    expect(value.context.lineages[LINEAGE_A].disputeRuns).toEqual([{ version: 1, runId: 'run-impl-1' }]);
  });

  test('a pre-#844 record of a consumed slot still refuses a second rebuttal, fail closed', () => {
    // A dispute persisted before run identities were recorded: the slot is
    // spent, but nothing says by whom. It cannot be recognized as a replay, so
    // it is refused — never duplicated.
    const ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A) });
    const outcome = outcomeFor(ctx, [disputed(LINEAGE_A)]);
    const current = context({
      [LINEAGE_A]: lineage(LINEAGE_A, {
        state: 'disputed',
        rebuttedVersions: [1],
        counters: { rebuttals: 1, reconsiderations: 0, arbitrationPasses: 0, malformedArbiterAttempts: 0, evidenceRoundsUsed: 0 },
      }),
    });

    const { value } = persistFixDisputes({ context: current, outcome, run: RUN, runProducedFileChanges: false });
    expect(value.refused[0].failure.reason).toBe('rebuttal-slot-consumed');
    expect(value.context.lineages[LINEAGE_A].counters.rebuttals).toBe(1);
  });

  test('a record too large for its artifact refuses the lineage before moving it', () => {
    const ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A) });
    const outcome = outcomeFor(ctx, [disputed(LINEAGE_A)]);
    const oversized = {
      ...outcome,
      admitted: [
        {
          ...outcome.admitted[0],
          record: {
            ...outcome.admitted[0].record,
            dispute: { ...outcome.admitted[0].record.dispute, argument: 'x'.repeat(100_000) },
          },
        },
      ],
    };

    const { value } = persistFixDisputes({
      context: ctx,
      outcome: oversized,
      run: RUN,
      runProducedFileChanges: false,
    });
    expect(value.refused[0].failure.reason).toBe('payload-too-large');
    // No dispute without its record: the lineage is left exactly as it was.
    expect(value.context.lineages[LINEAGE_A]).toEqual(ctx.lineages[LINEAGE_A]);
    expect(value.artifacts).toEqual([]);
  });
});

describe('persistFixDisputes — mixed and zero-change runs', () => {
  test('a mixed fixed/disputed run records the dispute and defers the diff re-review', () => {
    const ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A), [LINEAGE_B]: lineage(LINEAGE_B) });
    const { value } = persist(ctx, [fixed(LINEAGE_A), disputed(LINEAGE_B)], { runProducedFileChanges: true });

    // The fixed lineage is untouched — §7 rows 1/5/23 are #840's, not this
    // Issue's — while the disputed one carries the pending protocol state.
    expect(value.context.lineages[LINEAGE_A]).toEqual(ctx.lineages[LINEAGE_A]);
    expect(value.context.lineages[LINEAGE_B].state).toBe('disputed');
    // §7.1 rule 2: the diff on the branch is unreviewed, and its re-review is
    // deferred rather than skipped.
    expect(value.context.pendingReReview).toBe(true);
    expect(value.routing).toEqual({
      kind: 'pending_reconsideration',
      lineages: [{ lineageId: LINEAGE_B, version: 1 }],
      escalatedLineageIds: [],
      pendingReReview: true,
    });
  });

  test('a zeroChangeAdmissible all-disputed run records every dispute and no pending re-review', () => {
    const ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A), [LINEAGE_B]: lineage(LINEAGE_B) });
    const outcome = outcomeFor(ctx, [disputed(LINEAGE_A), disputed(LINEAGE_B)]);
    expect(outcome.zeroChangeAdmissible).toBe(true);

    const { value } = persistFixDisputes({ context: ctx, outcome, run: RUN, runProducedFileChanges: false });
    expect(value.context.lineages[LINEAGE_A].state).toBe('disputed');
    expect(value.context.lineages[LINEAGE_B].state).toBe('disputed');
    // No diff was produced, so nothing is waiting to be re-reviewed.
    expect(value.context.pendingReReview).toBeUndefined();
    expect(value.summary).toMatchObject({ persisted: 2, replayed: 0, refused: 0, pendingReReview: false });
    expect(value.artifacts.map((a) => a.name)).toEqual([
      `dispute-${LINEAGE_A}.json`,
      `dispute-${LINEAGE_B}.json`,
    ]);
  });

  test('an already-set pendingReReview flag is carried, never cleared here', () => {
    const ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A) }, { pendingReReview: true });
    const { value } = persist(ctx, [disputed(LINEAGE_A)]);
    expect(value.context.pendingReReview).toBe(true);
  });

  test('task context stays bounded across a full task of findings', () => {
    const lineages = {};
    const records = [];
    for (let i = 0; i < MAX_LINEAGES_PER_TASK; i++) {
      const id = `ln-${i.toString(16).padStart(12, '0')}`;
      lineages[id] = lineage(id);
      records.push(disputed(id));
    }
    const ctx = context(lineages);
    const { value } = persist(ctx, records);

    expect(value.summary.persisted).toBe(MAX_LINEAGES_PER_TASK);
    expect(Buffer.byteLength(value.serialized, 'utf8')).toBeLessThan(REVIEW_DISPUTE_CONTEXT_MAX_BYTES);
    // Bounded because the record is bounded, not because the block was trimmed:
    // every lineage is still there, and none of them carries prose.
    expect(Object.keys(value.context.lineages)).toHaveLength(MAX_LINEAGES_PER_TASK);
    expect(value.serialized).not.toContain('middleware');
  });
});

describe('planDisputeRetention — cleanup after the debate is answered', () => {
  const ctx = context({
    [LINEAGE_A]: lineage(LINEAGE_A, { state: 'disputed', rebuttedVersions: [1], counters: { rebuttals: 1, reconsiderations: 0, arbitrationPasses: 0, malformedArbiterAttempts: 0, evidenceRoundsUsed: 0 } }),
    [LINEAGE_B]: lineage(LINEAGE_B),
  });

  test.each(['withdraw', 'uphold', 'revise', 'arbitration'])(
    '%s clears the pending reviewer turn but retains the record',
    (event) => {
      const plan = planDisputeRetention({ context: ctx, event, lineageId: LINEAGE_A });
      expect(plan.clearedLineageIds).toEqual([LINEAGE_A]);
      // The artifacts are the arbiter's bundle input and the human's audit
      // trail; the moment the debate is answered is not the moment to drop them.
      expect(plan.retainedArtifacts).toEqual([`dispute-${LINEAGE_A}.json`]);
      expect(plan.removableArtifacts).toEqual([]);
      // The §6.1 budget and the #844 idempotency keys survive, so an answered
      // version can never be rebutted a second time.
      expect(plan.retainsContextBookkeeping).toBe(true);
    },
  );

  test('task completion releases every dispute artifact to the session retention policy', () => {
    const plan = planDisputeRetention({ context: ctx, event: 'task_complete' });
    expect(plan.clearedLineageIds).toEqual([LINEAGE_A, LINEAGE_B]);
    expect(plan.retainedArtifacts).toEqual([]);
    expect(plan.removableArtifacts).toEqual([
      `dispute-${LINEAGE_A}.json`,
      `dispute-${LINEAGE_B}.json`,
    ]);
  });

  test('an event for a lineage this task does not carry cleans up nothing', () => {
    const plan = planDisputeRetention({ context: ctx, event: 'uphold', lineageId: 'ln-cccccccccccc' });
    expect(plan).toEqual({
      event: 'uphold',
      clearedLineageIds: [],
      retainedArtifacts: [],
      removableArtifacts: [],
      retainsContextBookkeeping: true,
    });
  });

  test('the lifecycle vocabulary covers every event the contract can answer a dispute with', () => {
    expect([...DISPUTE_LIFECYCLE_EVENTS]).toEqual([
      'withdraw',
      'uphold',
      'revise',
      'arbitration',
      'task_complete',
    ]);
  });
});
