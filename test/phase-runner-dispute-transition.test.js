/**
 * The review-dispute transition layer, reached from a real phase completion
 * (issue #840; docs/review-dispute-contract.md §7, §7.1, §10.1, §10.3).
 *
 * test/review-dispute-commit.test.js pins the standalone commit. This file pins
 * the production path: a handler hands `runNextPhase` the application it
 * computed from the typed predecessor decisions, and the runner folds it into
 * the ONE transaction it was already going to issue for the completion. What
 * must hold there:
 *
 *  - the §10.1 block and the §10.3 audit event land with the completion's own
 *    patch and `phase.completed` event, in one transaction and under one CAS;
 *  - §7.1 routing decides where the task goes — overriding the ordinary
 *    implementation→review step when it names a dispatchable destination,
 *    PARKING the task for a human when rule 2 selects a turn whose run this
 *    codebase does not dispatch yet (the reconsideration, evidence, and
 *    arbitration turns, none of which an ordinary review run may finish), and
 *    deferring to it only for rules 3/4;
 *  - a lost claim commits none of it;
 *  - a replayed application appends no second audit event and moves no counter,
 *    yet still routes exactly as its first delivery did;
 *  - a completion with no application behaves exactly as it always has (§13).
 *
 * Both TaskStore implementations run the same table, because this is observable
 * contract rather than an implementation detail.
 */
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { MemoryTaskStore, SqliteTaskStore, runNextPhase } from '../dist/index.js';
import { REVIEW_DISPUTE_DEFAULT_LIMITS, ZERO_LINEAGE_COUNTERS } from '../dist/core/review-dispute.js';
import { parseFixDispositionResponse } from '../dist/core/review-fix-disposition-response.js';
import { persistFixDisputes } from '../dist/core/review-dispute-persistence.js';
import { applyDisputeTransition } from '../dist/core/review-dispute-transition.js';
import {
  REVIEW_DISPUTE_CONTEXT_KEY,
  REVIEW_DISPUTE_TRANSITION_EVENT,
} from '../dist/core/review-dispute-commit.js';

const SESSION = 's';
const ISSUE = 840;
const KEY = { sessionId: SESSION, issueNumber: ISSUE };
const LINEAGE_A = 'ln-aaaaaaaaaaaa';
const LINEAGE_B = 'ln-bbbbbbbbbbbb';
const BOUNDARY = 'src/auth/handler.ts';
const ARGUMENT = 'The null session is already rejected by the middleware, so the cited crash cannot occur.';
const RUN_ID = 'run-impl-1';
const NOW = '2026-08-05T12:00:00.000Z';

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

function context(lineages) {
  return { version: 1, reviewStructure: 'structured', lineages };
}

function fixedRecord(id) {
  return { lineageId: id, version: 1, disposition: 'fixed', note: 'Added the null guard.' };
}

function blockedRecord(id) {
  return { lineageId: id, version: 1, disposition: 'blocked', note: 'Needs a credential automation cannot supply.' };
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

function promptFindings(ctx) {
  return Object.values(ctx.lineages)
    .filter((l) => l.state === 'open' || l.state === 'binding')
    .map((l) => ({
      lineageId: l.lineageId,
      version: l.version,
      state: l.state,
      severity: l.severity,
      affectedBoundary: l.affectedBoundary,
      allowedDispositions: ['fixed', 'review_disputed', 'blocked'],
    }));
}

/**
 * One fix run's application, built the way the implementation handler builds it:
 * the real #843 parser, the real #844 writer, and the real #840 applicator. No
 * hand-authored row, state, or counter appears anywhere in these tests.
 */
function application(
  ctx,
  records,
  { runId = RUN_ID, diff = false, current = ctx, findings, limits = REVIEW_DISPUTE_DEFAULT_LIMITS } = {},
) {
  const outcome = parseFixDispositionResponse({
    response: `\`\`\`json\n${JSON.stringify(records)}\n\`\`\``,
    findings: findings ?? promptFindings(ctx),
    lineages: ctx.lineages,
    reviewStructure: ctx.reviewStructure,
    runProducedFileChanges: diff,
    resolveEvidenceRef: () => true,
    limits,
  });
  const persisted = persistFixDisputes({
    context: current,
    outcome,
    run: { runId, agentId: 'claude', timestamp: NOW },
    runProducedFileChanges: diff,
    limits,
  });
  if (!persisted.ok) throw new Error(`fixture not persisted: ${JSON.stringify(persisted.failure)}`);
  const result = applyDisputeTransition({
    context: current,
    decision: {
      kind: 'dispositions',
      persistence: persisted.value,
      outcome,
      runProducedFileChanges: diff,
    },
    run: { runId, actor: 'implementer' },
    limits,
  });
  if (!result.ok) throw new Error(`transition failed: ${JSON.stringify(result.failure)}`);
  return result.value;
}

const BACKENDS = [
  {
    name: 'MemoryTaskStore',
    create: () => ({ store: new MemoryTaskStore(), cleanup: () => {} }),
  },
  {
    name: 'SqliteTaskStore',
    create: () => {
      const dir = mkdtempSync(join(tmpdir(), 'runner-dispute-'));
      const store = new SqliteTaskStore(join(dir, 'test.db'));
      return {
        store,
        cleanup: () => {
          store.close();
          rmSync(dir, { recursive: true, force: true });
        },
      };
    },
  },
];

describe.each(BACKENDS)('runNextPhase — dispute transition fold ($name)', ({ create }) => {
  let store;
  let cleanup;

  beforeEach(() => {
    ({ store, cleanup } = create());
  });

  afterEach(() => {
    cleanup();
  });

  const request = {
    sessionId: SESSION,
    workerId: 'w',
    runId: RUN_ID,
    supportedPhases: ['implementation'],
    now: NOW,
  };

  async function enqueue(ctx) {
    await store.enqueueTask({
      sessionId: SESSION,
      issueNumber: ISSUE,
      phase: 'implementation',
      priority: 'normal',
      context: { [REVIEW_DISPUTE_CONTEXT_KEY]: ctx, reviewFeedback: 'legacy prose stays put' },
      now: '2026-08-05T11:00:00.000Z',
    });
  }

  /** A handler standing in for the implementation handler's success return. */
  function handlerReturning(value, extra = {}) {
    return async () => ({
      result: 'success',
      context: { branch: 'ai/issue-840', prUrl: 'https://example.test/pr/1', ...extra },
      ...(value ? { disputeTransition: value } : {}),
    });
  }

  test('a `fixed` run applies row 1 through the ordinary completion', async () => {
    const ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A) });
    await enqueue(ctx);
    const value = application(ctx, [fixedRecord(LINEAGE_A)], { diff: true });

    const outcome = await runNextPhase({
      store,
      request,
      handlers: { implementation: handlerReturning(value) },
    });

    expect(outcome.status).toBe('completed');
    const stored = await store.getTask(KEY);
    // Row 1: the disposition the run reported really moved the lineage, which is
    // what never happened before the fold existed.
    expect(stored.context[REVIEW_DISPUTE_CONTEXT_KEY].lineages[LINEAGE_A].state).toBe('resolved_fixed');
    // The handler's own context is committed alongside it, and the legacy
    // free-form payload is merged, never written over (§13).
    expect(stored.context.branch).toBe('ai/issue-840');
    expect(stored.context.reviewFeedback).toBe('legacy prose stays put');
    // §7.1 rule 3: every lineage terminal with an unreviewed diff — the same
    // destination the ordinary implementation→review step would have chosen.
    expect(stored.status).toBe('queued');
    expect(stored.phase).toBe('review');

    const events = await store.listEvents(KEY);
    const types = events.map((e) => e.type);
    expect(types).toContain('phase.completed');
    const transitions = events.filter((e) => e.type === REVIEW_DISPUTE_TRANSITION_EVENT);
    expect(transitions).toHaveLength(1);
    expect(transitions[0].runId).toBe(RUN_ID);
    expect(transitions[0].data.applied[0]).toMatchObject({
      lineageId: LINEAGE_A,
      row: 1,
      toState: 'resolved_fixed',
    });
    expect(transitions[0].data.routing).toMatchObject({ rule: 3, outcome: 're_review' });
  }, 30_000);

  test('a `blocked` run escalates to a human instead of routing on to review', async () => {
    const ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A) });
    await enqueue(ctx);
    const value = application(ctx, [blockedRecord(LINEAGE_A)], { diff: true });

    await runNextPhase({ store, request, handlers: { implementation: handlerReturning(value) } });

    const stored = await store.getTask(KEY);
    expect(stored.context[REVIEW_DISPUTE_CONTEXT_KEY].lineages[LINEAGE_A].state).toBe('escalated_human');
    // §7.1 rule 1 overrides `nextPhaseAfter`'s implementation→review step, and
    // parks the task on the phase that RAN so an operator resumes where the work
    // actually stopped.
    expect(stored.status).toBe('ready_for_human');
    expect(stored.phase).toBe('implementation');
    expect(stored.ownerRunId ?? undefined).toBeUndefined();
    expect(stored.leaseExpiresAt ?? undefined).toBeUndefined();

    const events = await store.listEvents(KEY);
    expect(events.filter((e) => e.type === REVIEW_DISPUTE_TRANSITION_EVENT)[0].data.routing)
      .toMatchObject({ rule: 1, outcome: 'human_handoff', readyForHuman: true });
  }, 30_000);

  test('a disputed run parks the reviewer turn for a human and records no prose in the event', async () => {
    const ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A) });
    await enqueue(ctx);
    const value = application(ctx, [disputeRecord(LINEAGE_A)]);
    // §7.1 rule 2 selects the reviewer turn, and the turn's own destination IS
    // the review phase...
    expect(value.routing).toMatchObject({ rule: 2, turn: 'reviewer', nextPhase: 'review' });

    await runNextPhase({ store, request, handlers: { implementation: handlerReturning(value) } });

    const stored = await store.getTask(KEY);
    expect(stored.context[REVIEW_DISPUTE_CONTEXT_KEY].lineages[LINEAGE_A]).toMatchObject({
      state: 'disputed',
      rebuttedVersions: [1],
    });
    // ...but that turn is a RECONSIDERATION run, and the review handler
    // dispatches an ordinary review: it admits new findings and applies no row
    // 9-12, so queueing `review` here would hand a `disputed` lineage to a run
    // that cannot consume it — and let that run finish the task. Until the
    // reconsideration dispatch exists, the task parks for a human on the phase
    // that ran, with the lineage left exactly where the protocol put it.
    expect(stored.status).toBe('ready_for_human');
    expect(stored.phase).toBe('implementation');
    expect(stored.ownerRunId ?? undefined).toBeUndefined();
    expect(stored.leaseExpiresAt ?? undefined).toBeUndefined();

    const events = await store.listEvents(KEY);
    const transition = events.find((e) => e.type === REVIEW_DISPUTE_TRANSITION_EVENT);
    expect(transition.data.applied[0]).toMatchObject({ lineageId: LINEAGE_A, row: 2, toState: 'disputed' });
    // The audit record says WHY a task the protocol wanted to keep running
    // parked — one bounded turn literal, not a rule-1 escalation.
    expect(transition.data.undispatchedTurn).toBe('reviewer');
    expect(transition.data.routing).toMatchObject({ rule: 2, readyForHuman: false });
    // §10.3: literals, counters, ids, and bounded reason tokens only.
    expect(JSON.stringify(transition.data)).not.toContain(ARGUMENT);
  }, 30_000);

  test('a final-version dispute (row 6) parks the runner turn for a human', async () => {
    // Version 2 is the final response, so §6.2 admits no third round: the
    // dispute goes straight to `arbitration_pending`, and §7.1 rule 2 selects
    // the RUNNER turn — no agent run at all.
    const ctx = context({
      [LINEAGE_A]: lineage(LINEAGE_A, {
        version: 2,
        rebuttedVersions: [1],
        counters: { rebuttals: 1, reconsiderations: 1 },
      }),
    });
    await enqueue(ctx);
    const value = application(ctx, [disputeRecord(LINEAGE_A, 2)]);
    expect(value.routing).toMatchObject({ rule: 2, turn: 'runner', nextPhase: null });

    await runNextPhase({ store, request, handlers: { implementation: handlerReturning(value) } });

    const stored = await store.getTask(KEY);
    expect(stored.context[REVIEW_DISPUTE_CONTEXT_KEY].lineages[LINEAGE_A].state).toBe('arbitration_pending');
    // The task must NOT reach the ordinary implementation→review step: the
    // review handler has no arbitration dispatch and would be free to complete
    // the task with no verdict on file. Nor may it sit non-runnable with nothing
    // scheduled to wake it — no production caller advances arbitration yet. It
    // parks for a human on the phase that ran, claim released.
    expect(stored.status).toBe('ready_for_human');
    expect(stored.phase).toBe('implementation');
    expect(stored.ownerRunId ?? undefined).toBeUndefined();
    expect(stored.leaseExpiresAt ?? undefined).toBeUndefined();

    const events = await store.listEvents(KEY);
    const transition = events.find((e) => e.type === REVIEW_DISPUTE_TRANSITION_EVENT);
    expect(transition.data.applied[0]).toMatchObject({
      lineageId: LINEAGE_A,
      row: 6,
      toState: 'arbitration_pending',
    });
    expect(transition.data.undispatchedTurn).toBe('runner');
  }, 30_000);

  test('a zero-reconsideration dispute (row 25) parks the runner turn for a human', async () => {
    // §6.1 with the reconsideration round configured away: the dispute
    // arbitrates immediately instead of entering `disputed`, so rule 2 again
    // selects the runner turn from a first-version finding.
    const limits = { ...REVIEW_DISPUTE_DEFAULT_LIMITS, maxReconsiderationsPerLineage: 0 };
    const ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A) });
    await enqueue(ctx);
    const value = application(ctx, [disputeRecord(LINEAGE_A)], { limits });
    expect(value.routing).toMatchObject({ rule: 2, turn: 'runner', nextPhase: null });

    await runNextPhase({ store, request, handlers: { implementation: handlerReturning(value) } });

    const stored = await store.getTask(KEY);
    expect(stored.context[REVIEW_DISPUTE_CONTEXT_KEY].lineages[LINEAGE_A].state).toBe('arbitration_pending');
    expect(stored.status).toBe('ready_for_human');
    expect(stored.phase).toBe('implementation');
    const events = await store.listEvents(KEY);
    expect(events.find((e) => e.type === REVIEW_DISPUTE_TRANSITION_EVENT).data.applied[0]).toMatchObject({
      row: 25,
      toState: 'arbitration_pending',
    });
  }, 30_000);

  test('an evidence turn parks the task rather than routing it to review', async () => {
    // A lineage already in `evidence_requested` (row 16) keeps the task in rule
    // 2's evidence turn: two per-party collection runs, so no single phase. A
    // sibling resolved by this run must not carry the task off to review while
    // that round is outstanding.
    const ctx = context({
      [LINEAGE_A]: lineage(LINEAGE_A),
      [LINEAGE_B]: lineage(LINEAGE_B, {
        state: 'evidence_requested',
        rebuttedVersions: [1],
        counters: { rebuttals: 1, arbitrationPasses: 1, evidenceRoundsUsed: 1 },
      }),
    });
    await enqueue(ctx);
    const value = application(ctx, [fixedRecord(LINEAGE_A)], { diff: true });
    expect(value.routing).toMatchObject({ rule: 2, turn: 'evidence', nextPhase: null });

    await runNextPhase({ store, request, handlers: { implementation: handlerReturning(value) } });

    const stored = await store.getTask(KEY);
    const block = stored.context[REVIEW_DISPUTE_CONTEXT_KEY];
    expect(block.lineages[LINEAGE_A].state).toBe('resolved_fixed');
    expect(block.lineages[LINEAGE_B].state).toBe('evidence_requested');
    expect(stored.status).toBe('ready_for_human');
    expect(stored.phase).toBe('implementation');
    // §7.1 rule 2: the diff this run produced is deferred, never skipped — rule
    // 3 still owes it a re-review once the evidence round closes.
    expect(block.pendingReReview).toBe(true);
    const events = await store.listEvents(KEY);
    expect(events.find((e) => e.type === REVIEW_DISPUTE_TRANSITION_EVENT).data.undispatchedTurn).toBe('evidence');
  }, 30_000);

  test('multi-lineage aggregation: one escalation outranks a resolved sibling', async () => {
    const ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A), [LINEAGE_B]: lineage(LINEAGE_B) });
    await enqueue(ctx);
    const value = application(ctx, [fixedRecord(LINEAGE_A), blockedRecord(LINEAGE_B)], { diff: true });

    await runNextPhase({ store, request, handlers: { implementation: handlerReturning(value) } });

    const stored = await store.getTask(KEY);
    const lineages = stored.context[REVIEW_DISPUTE_CONTEXT_KEY].lineages;
    expect(lineages[LINEAGE_A].state).toBe('resolved_fixed');
    expect(lineages[LINEAGE_B].state).toBe('escalated_human');
    expect(stored.status).toBe('ready_for_human');
    const events = await store.listEvents(KEY);
    expect(events.filter((e) => e.type === REVIEW_DISPUTE_TRANSITION_EVENT)).toHaveLength(1);
  }, 30_000);

  test('a lost claim commits neither the block nor the audit event', async () => {
    const ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A) });
    await enqueue(ctx);
    const value = application(ctx, [fixedRecord(LINEAGE_A)], { diff: true });

    // Steal the claim from inside the handler, so the completion's CAS is
    // already lost by the time the fold reaches the store.
    const handler = async () => {
      await store.transitionTask(
        KEY,
        { status: 'running', ownerRunId: RUN_ID },
        { status: 'queued', ownerRunId: undefined, leaseExpiresAt: undefined, now: NOW },
      );
      return { result: 'success', context: { branch: 'ai/issue-840' }, disputeTransition: value };
    };

    const outcome = await runNextPhase({ store, request, handlers: { implementation: handler } });

    expect(outcome.status).toBe('claim_lost');
    const stored = await store.getTask(KEY);
    expect(stored.context[REVIEW_DISPUTE_CONTEXT_KEY].lineages[LINEAGE_A].state).toBe('open');
    const events = await store.listEvents(KEY);
    expect(events.filter((e) => e.type === REVIEW_DISPUTE_TRANSITION_EVENT)).toHaveLength(0);
    expect(events.filter((e) => e.type === 'phase.completed')).toHaveLength(0);
  }, 30_000);

  test('a re-delivered application appends no second event and moves no counter', async () => {
    const ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A) });
    await enqueue(ctx);
    const findings = promptFindings(ctx);
    const first = application(ctx, [fixedRecord(LINEAGE_A)], { diff: true });

    await runNextPhase({ store, request, handlers: { implementation: handlerReturning(first) } });
    const afterFirst = await store.getTask(KEY);
    const committed = afterFirst.context[REVIEW_DISPUTE_CONTEXT_KEY];

    // The SAME run delivering again — it re-reads the block its first delivery
    // already moved, so the transition ledger recognizes its own digest and the
    // application reads as a replay. §7.1 rule 3 put the task at `review`, so
    // that is where it re-runs.
    const redelivery = application(ctx, [fixedRecord(LINEAGE_A)], { diff: true, current: committed, findings });
    expect(redelivery.replayed).toBe(true);
    await runNextPhase({
      store,
      request: { ...request, supportedPhases: ['review'], now: '2026-08-05T12:05:00.000Z' },
      handlers: { review: handlerReturning(redelivery) },
    });

    const stored = await store.getTask(KEY);
    // Nothing moved a second time.
    expect(stored.context[REVIEW_DISPUTE_CONTEXT_KEY]).toEqual(committed);
    expect(stored.context[REVIEW_DISPUTE_CONTEXT_KEY].lineages[LINEAGE_A].state).toBe('resolved_fixed');
    // ...and the retried delivery still routed rule 3 identically.
    expect(stored.status).toBe('queued');
    expect(stored.phase).toBe('review');
    const events = await store.listEvents(KEY);
    expect(events.filter((e) => e.type === REVIEW_DISPUTE_TRANSITION_EVENT)).toHaveLength(1);
  }, 30_000);

  test('a parked route is re-parked identically when the same delivery is retried', async () => {
    // The other half of idempotency, on the route that parks: an operator (or a
    // recovery path) puts the parked task back in flight, the same run delivers
    // again, and the retry must neither spend a second rebuttal nor let the task
    // slip past the missing reconsideration dispatch this time.
    const ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A) });
    await enqueue(ctx);
    const findings = promptFindings(ctx);
    const first = application(ctx, [disputeRecord(LINEAGE_A)]);

    await runNextPhase({ store, request, handlers: { implementation: handlerReturning(first) } });
    const afterFirst = await store.getTask(KEY);
    expect(afterFirst.status).toBe('ready_for_human');
    const committed = afterFirst.context[REVIEW_DISPUTE_CONTEXT_KEY];

    await store.transitionTask(
      KEY,
      { status: 'ready_for_human' },
      { status: 'queued', phase: 'implementation', now: '2026-08-05T12:04:00.000Z' },
    );
    const redelivery = application(ctx, [disputeRecord(LINEAGE_A)], { current: committed, findings });
    expect(redelivery.replayed).toBe(true);
    await runNextPhase({
      store,
      request: { ...request, now: '2026-08-05T12:05:00.000Z' },
      handlers: { implementation: handlerReturning(redelivery) },
    });

    const stored = await store.getTask(KEY);
    expect(stored.context[REVIEW_DISPUTE_CONTEXT_KEY]).toEqual(committed);
    expect(stored.context[REVIEW_DISPUTE_CONTEXT_KEY].lineages[LINEAGE_A].counters.rebuttals).toBe(1);
    expect(stored.context[REVIEW_DISPUTE_CONTEXT_KEY].lineages[LINEAGE_A].rebuttedVersions).toEqual([1]);
    expect(stored.status).toBe('ready_for_human');
    expect(stored.phase).toBe('implementation');
    const events = await store.listEvents(KEY);
    expect(events.filter((e) => e.type === REVIEW_DISPUTE_TRANSITION_EVENT)).toHaveLength(1);
  }, 30_000);

  test('a completion with no application is unchanged (§13 legacy path)', async () => {
    await store.enqueueTask({
      sessionId: SESSION,
      issueNumber: ISSUE,
      phase: 'implementation',
      priority: 'normal',
      context: { reviewFeedback: 'legacy prose only' },
      now: '2026-08-05T11:00:00.000Z',
    });

    const outcome = await runNextPhase({
      store,
      request,
      handlers: { implementation: handlerReturning(undefined) },
    });

    expect(outcome.status).toBe('completed');
    const stored = await store.getTask(KEY);
    expect(stored.status).toBe('queued');
    expect(stored.phase).toBe('review');
    expect(stored.context[REVIEW_DISPUTE_CONTEXT_KEY]).toBeUndefined();
    const events = await store.listEvents(KEY);
    expect(events.filter((e) => e.type === REVIEW_DISPUTE_TRANSITION_EVENT)).toHaveLength(0);
    expect(events.filter((e) => e.type === 'phase.completed')).toHaveLength(1);
  }, 30_000);
});
