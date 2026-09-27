/**
 * Durable-application tests for the issue #840 transition layer
 * (src/core/review-dispute-commit.ts, docs/review-dispute-contract.md §7.1,
 * §10.1, §10.3).
 *
 * The applicator decides; this is the half that WRITES. Both TaskStore
 * implementations are driven through the same table, because the contract this
 * pins is observable behavior rather than an implementation detail:
 *
 *  - the context patch and its ONE bounded event commit together;
 *  - a lost CAS commits neither of them;
 *  - a re-delivered decision writes nothing at all — no counter moves and no
 *    second event lands — and still reports the same routing intent.
 */
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { MemoryTaskStore, SqliteTaskStore } from '../dist/index.js';
import { REVIEW_DISPUTE_DEFAULT_LIMITS, ZERO_LINEAGE_COUNTERS } from '../dist/core/review-dispute.js';
import { parseFixDispositionResponse } from '../dist/core/review-fix-disposition-response.js';
import { persistFixDisputes } from '../dist/core/review-dispute-persistence.js';
import { applyDisputeTransition } from '../dist/core/review-dispute-transition.js';
import {
  DISPATCHABLE_DISPUTE_TURNS,
  REVIEW_DISPUTE_CONTEXT_KEY,
  REVIEW_DISPUTE_TRANSITION_EVENT,
  commitDisputeTransition,
  routedPhaseCompletion,
  routingLacksDispatcher,
  routingRequiresHumanHandoff,
  routingTaskPatch,
} from '../dist/core/review-dispute-commit.js';

const SESSION = 'addon-dev';
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

function blockedRecord(id) {
  return { lineageId: id, version: 1, disposition: 'blocked', note: 'Needs a credential automation cannot supply.' };
}

function fixedRecord(id) {
  return { lineageId: id, version: 1, disposition: 'fixed', note: 'Added the null guard.' };
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

/** One fix run's dispositions, produced by the real #843 parser and #844 writer. */
function decisionFor(ctx, records, { runId = RUN_ID, current = ctx, findings, diff = false } = {}) {
  const outcome = parseFixDispositionResponse({
    response: `\`\`\`json\n${JSON.stringify(records)}\n\`\`\``,
    findings: findings ?? promptFindings(ctx),
    lineages: ctx.lineages,
    reviewStructure: ctx.reviewStructure,
    runProducedFileChanges: diff,
    resolveEvidenceRef: () => true,
    limits: REVIEW_DISPUTE_DEFAULT_LIMITS,
  });
  const persisted = persistFixDisputes({
    context: current,
    outcome,
    run: { runId, agentId: 'claude', timestamp: NOW },
    runProducedFileChanges: diff,
  });
  if (!persisted.ok) throw new Error(`fixture not persisted: ${JSON.stringify(persisted.failure)}`);
  return { kind: 'dispositions', persistence: persisted.value, outcome, runProducedFileChanges: diff };
}

function applied(ctx, decision, runId = RUN_ID) {
  const result = applyDisputeTransition({ context: ctx, decision, run: { runId, actor: 'implementer' } });
  if (!result.ok) throw new Error(`transition failed: ${JSON.stringify(result.failure)}`);
  return result.value;
}

/** Claim a task so there is a live CAS guard to commit against. */
async function claimedTask(store, ctx) {
  await store.enqueueTask({
    sessionId: SESSION,
    issueNumber: ISSUE,
    phase: 'implementation',
    priority: 'normal',
    context: { [REVIEW_DISPUTE_CONTEXT_KEY]: ctx, reviewFeedback: 'legacy prose stays put' },
    now: '2026-08-05T11:00:00.000Z',
  });
  const claimed = await store.claimNextTask({
    sessionId: SESSION,
    workerId: 'worker-a',
    runId: RUN_ID,
    now: '2026-08-05T11:30:00.000Z',
    leaseMs: 60_000,
  });
  if (claimed === undefined) throw new Error('fixture task was not claimed');
  return claimed;
}

const expected = { status: 'claimed', ownerRunId: RUN_ID };

const BACKENDS = [
  {
    name: 'MemoryTaskStore',
    create: () => ({ store: new MemoryTaskStore(), cleanup: () => {} }),
  },
  {
    name: 'SqliteTaskStore',
    create: () => {
      const dir = mkdtempSync(join(tmpdir(), 'dispute-commit-'));
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

describe.each(BACKENDS)('commitDisputeTransition — $name', ({ create }) => {
  let store;
  let cleanup;

  beforeEach(() => {
    ({ store, cleanup } = create());
  });

  afterEach(() => {
    cleanup();
  });

  test('commits the context patch and exactly one bounded event together', async () => {
    const ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A) });
    await claimedTask(store, ctx);
    const value = applied(ctx, decisionFor(ctx, [disputeRecord(LINEAGE_A)]));

    const outcome = await commitDisputeTransition({
      store,
      key: KEY,
      expected,
      application: value,
      runId: RUN_ID,
      now: NOW,
    });

    expect(outcome.status).toBe('applied');
    const stored = await store.getTask(KEY);
    expect(stored.context[REVIEW_DISPUTE_CONTEXT_KEY].lineages[LINEAGE_A].state).toBe('disputed');
    // The legacy free-form payload is untouched: the block is merged, never
    // written over the whole context (§13).
    expect(stored.context.reviewFeedback).toBe('legacy prose stays put');
    // §7.1 rule 2's reviewer turn is a reconsideration run, and since issue #952
    // the review phase dispatches it as an internal sub-turn before it builds an
    // ordinary review prompt — so the turn routes to `review` instead of parking.
    expect(stored.phase).toBe('review');
    expect(stored.status).toBe('queued');
    // Routing owns the lifecycle here, so it completes the claim too: a routed
    // or parked task that stayed claimed by the finished run is a task nobody
    // can pick up.
    expect(stored.ownerRunId ?? undefined).toBeUndefined();
    expect(stored.leaseExpiresAt ?? undefined).toBeUndefined();

    const events = await store.listEvents(KEY);
    const transitions = events.filter((e) => e.type === REVIEW_DISPUTE_TRANSITION_EVENT);
    expect(transitions).toHaveLength(1);
    expect(transitions[0].data.applied[0]).toMatchObject({ lineageId: LINEAGE_A, row: 2, toState: 'disputed' });
    // The reviewer turn has a dispatcher (issue #952), so no park is recorded.
    expect(transitions[0].data.undispatchedTurn).toBeUndefined();
    expect(transitions[0].runId).toBe(RUN_ID);
    // §10.3: literals and counters only.
    expect(JSON.stringify(transitions[0].data)).not.toContain(ARGUMENT);
  });

  test('a routed task is claimable again at the phase §7.1 selected', async () => {
    const ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A) });
    await claimedTask(store, ctx);
    // Rule 3: every lineage terminal with an unreviewed diff — the ordinary
    // review phase, the one destination of this table a handler really serves.
    const value = applied(ctx, decisionFor(ctx, [fixedRecord(LINEAGE_A)], { diff: true }));
    expect(value.routing).toMatchObject({ rule: 3, turn: 're_review', nextPhase: 'review' });

    await commitDisputeTransition({ store, key: KEY, expected, application: value, runId: RUN_ID, now: NOW });

    const next = await store.claimNextTask({
      sessionId: SESSION,
      workerId: 'worker-b',
      runId: 'run-review-1',
      now: '2026-08-05T12:01:00.000Z',
      leaseMs: 60_000,
    });
    expect(next).toBeDefined();
    expect(next.phase).toBe('review');
    expect(next.ownerRunId).toBe('run-review-1');
  }, 30_000);

  test('a parked turn is claimable by nobody until a human or a dispatcher acts', async () => {
    // The other side of the same coin: a task §7.1 sent to a human must not be
    // silently runnable at all. `ready_for_human` is both — visible to an
    // operator, claimed by no worker (`isRunnable`). A `humanGate` finding is the
    // park with the shortest fixture: disputing it escalates at admission (rows
    // 3/7) and rule 1 stops automation, exactly as an undispatchable evidence or
    // runner turn does.
    const ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A, { humanGate: true }) });
    await claimedTask(store, ctx);
    const value = applied(ctx, decisionFor(ctx, [disputeRecord(LINEAGE_A)]));

    await commitDisputeTransition({ store, key: KEY, expected, application: value, runId: RUN_ID, now: NOW });

    const next = await store.claimNextTask({
      sessionId: SESSION,
      workerId: 'worker-b',
      runId: 'run-review-1',
      now: '2026-08-05T12:01:00.000Z',
      leaseMs: 60_000,
    });
    expect(next).toBeUndefined();
    // The lineage keeps the state the protocol gave it, so the debate resumes
    // where it stopped rather than being rolled back or re-decided.
    const stored = await store.getTask(KEY);
    expect(stored.context[REVIEW_DISPUTE_CONTEXT_KEY].lineages[LINEAGE_A].state).toBe('escalated_human');
    expect(stored.context[REVIEW_DISPUTE_CONTEXT_KEY].lineages[LINEAGE_A].counters.rebuttals).toBe(1);
  }, 30_000);

  test('a lost CAS commits neither the patch nor the event', async () => {
    const ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A) });
    await claimedTask(store, ctx);
    const value = applied(ctx, decisionFor(ctx, [disputeRecord(LINEAGE_A)]));

    const outcome = await commitDisputeTransition({
      store,
      key: KEY,
      expected: { status: 'claimed', ownerRunId: 'run-somebody-else' },
      application: value,
      runId: RUN_ID,
      now: NOW,
    });

    expect(outcome.status).toBe('claim_lost');
    const stored = await store.getTask(KEY);
    expect(stored.context[REVIEW_DISPUTE_CONTEXT_KEY].lineages[LINEAGE_A].state).toBe('open');
    const events = await store.listEvents(KEY);
    expect(events.filter((e) => e.type === REVIEW_DISPUTE_TRANSITION_EVENT)).toHaveLength(0);
  });

  test('a duplicate delivery writes nothing and appends no second event', async () => {
    const ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A) });
    await claimedTask(store, ctx);
    const findings = promptFindings(ctx);
    const first = applied(ctx, decisionFor(ctx, [disputeRecord(LINEAGE_A)]));
    await commitDisputeTransition({ store, key: KEY, expected, application: first, runId: RUN_ID, now: NOW });

    const stored = await store.getTask(KEY);
    const redelivery = applied(
      stored.context[REVIEW_DISPUTE_CONTEXT_KEY],
      decisionFor(ctx, [disputeRecord(LINEAGE_A)], { current: stored.context[REVIEW_DISPUTE_CONTEXT_KEY], findings }),
    );
    expect(redelivery.replayed).toBe(true);

    const outcome = await commitDisputeTransition({
      store,
      key: KEY,
      expected,
      application: redelivery,
      runId: RUN_ID,
      now: '2026-08-05T12:05:00.000Z',
    });

    expect(outcome.status).toBe('duplicate');
    expect(outcome.routing).toEqual(first.routing);
    const after = await store.getTask(KEY);
    expect(after.context[REVIEW_DISPUTE_CONTEXT_KEY]).toEqual(stored.context[REVIEW_DISPUTE_CONTEXT_KEY]);
    expect(after.context[REVIEW_DISPUTE_CONTEXT_KEY].lineages[LINEAGE_A].counters.rebuttals).toBe(1);
    const events = await store.listEvents(KEY);
    expect(events.filter((e) => e.type === REVIEW_DISPUTE_TRANSITION_EVENT)).toHaveLength(1);
  });

  test('an escalating route parks the task for a human', async () => {
    const ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A) });
    await claimedTask(store, ctx);
    const value = applied(ctx, decisionFor(ctx, [blockedRecord(LINEAGE_A)]));

    const outcome = await commitDisputeTransition({
      store,
      key: KEY,
      expected,
      application: value,
      runId: RUN_ID,
      now: NOW,
    });

    expect(outcome.status).toBe('applied');
    const stored = await store.getTask(KEY);
    expect(stored.status).toBe('ready_for_human');
    // Parked for a human means parked, not still leased to the run that parked it.
    expect(stored.ownerRunId ?? undefined).toBeUndefined();
    expect(stored.leaseExpiresAt ?? undefined).toBeUndefined();
    expect(stored.context[REVIEW_DISPUTE_CONTEXT_KEY].lineages[LINEAGE_A].outcome).toBe('escalated_human');
    // A rule-1 escalation is the protocol's own decision, not a missing
    // dispatcher: the audit record must not claim otherwise.
    const events = await store.listEvents(KEY);
    const transition = events.find((e) => e.type === REVIEW_DISPUTE_TRANSITION_EVENT);
    expect(transition.data.routing).toMatchObject({ rule: 1, readyForHuman: true });
    expect(transition.data.undispatchedTurn).toBeUndefined();
  });

  test('a caller context patch cannot replace the block the event describes', async () => {
    const ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A) });
    await claimedTask(store, ctx);
    const value = applied(ctx, decisionFor(ctx, [disputeRecord(LINEAGE_A)]));

    const outcome = await commitDisputeTransition({
      store,
      key: KEY,
      expected,
      application: value,
      runId: RUN_ID,
      now: NOW,
      // The shape a caller merging its own phase context arrives with: it carries
      // the PRE-transition block alongside its own keys.
      patch: { context: { [REVIEW_DISPUTE_CONTEXT_KEY]: ctx, artifactDir: '/tmp/run-artifacts' } },
    });

    expect(outcome.status).toBe('applied');
    const stored = await store.getTask(KEY);
    // The validated block wins; the caller's other keys still land.
    expect(stored.context[REVIEW_DISPUTE_CONTEXT_KEY]).toEqual(value.context);
    expect(stored.context[REVIEW_DISPUTE_CONTEXT_KEY].lineages[LINEAGE_A].state).toBe('disputed');
    expect(stored.context.artifactDir).toBe('/tmp/run-artifacts');
  });

  test('`applyRouting: false` leaves status and phase to the caller', async () => {
    const ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A) });
    const claimed = await claimedTask(store, ctx);
    const value = applied(ctx, decisionFor(ctx, [blockedRecord(LINEAGE_A)]));

    await commitDisputeTransition({
      store,
      key: KEY,
      expected,
      application: value,
      runId: RUN_ID,
      now: NOW,
      applyRouting: false,
    });

    const stored = await store.getTask(KEY);
    expect(stored.status).toBe(claimed.status);
    expect(stored.phase).toBe('implementation');
    // The protocol block still landed — only the routing was the caller's.
    expect(stored.context[REVIEW_DISPUTE_CONTEXT_KEY].lineages[LINEAGE_A].state).toBe('escalated_human');
  });

  test('a multi-lineage run commits one block and one event for the whole run', async () => {
    const ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A), [LINEAGE_B]: lineage(LINEAGE_B) });
    await claimedTask(store, ctx);
    const value = applied(ctx, decisionFor(ctx, [disputeRecord(LINEAGE_A), disputeRecord(LINEAGE_B)]));

    await commitDisputeTransition({ store, key: KEY, expected, application: value, runId: RUN_ID, now: NOW });

    const stored = await store.getTask(KEY);
    const block = stored.context[REVIEW_DISPUTE_CONTEXT_KEY];
    expect(block.lineages[LINEAGE_A].state).toBe('disputed');
    expect(block.lineages[LINEAGE_B].state).toBe('disputed');
    const events = await store.listEvents(KEY);
    const transitions = events.filter((e) => e.type === REVIEW_DISPUTE_TRANSITION_EVENT);
    expect(transitions).toHaveLength(1);
    expect(transitions[0].data.applied).toHaveLength(2);
  });
});

/**
 * Every §7.1 turn, and whether this codebase has a dispatcher for its run. The
 * set is empty since issue #964 — the predicate stays as the standing guard for
 * a turn added before its dispatcher, and a token pushed here must park again.
 */
const UNDISPATCHABLE_TURNS = [];

describe('routingLacksDispatcher', () => {
  test('names exactly the turns whose run nothing here dispatches', () => {
    // Every turn that was ever here left the same way. The reviewer turn left
    // this set in issue #952 and the runner turn in issue #955 — neither is an
    // ordinary review; one is a RECONSIDERATION run and the other invokes the
    // independent ARBITER — and issue #964 closed the set with the evidence
    // turn's two per-party collection runs, all three dispatched as internal
    // sub-turns before the generic review prompt is ever built.
    for (const turn of UNDISPATCHABLE_TURNS) {
      expect(routingLacksDispatcher({ readyForHuman: false, nextPhase: null, turn })).toBe(true);
      expect(routingRequiresHumanHandoff({ readyForHuman: false, nextPhase: null, turn })).toBe(true);
    }
    expect(routingLacksDispatcher({ readyForHuman: false, nextPhase: 'review', turn: 'reviewer' })).toBe(false);
    expect(routingLacksDispatcher({ readyForHuman: false, nextPhase: 'review', turn: 'evidence' })).toBe(false);
    expect(routingRequiresHumanHandoff({ readyForHuman: false, nextPhase: 'review', turn: 'evidence' })).toBe(false);
    for (const turn of DISPATCHABLE_DISPUTE_TURNS) {
      expect(routingLacksDispatcher({ readyForHuman: false, nextPhase: null, turn })).toBe(false);
    }
    expect(DISPATCHABLE_DISPUTE_TURNS).toEqual(['implementer', 'reviewer', 'evidence', 'runner', 're_review', 'none']);
    // Rule 1 is already going to a human on its own terms; this predicate
    // answers only "is the turn's run dispatchable".
    expect(routingLacksDispatcher({ readyForHuman: true, nextPhase: null, turn: 'reviewer' })).toBe(false);
    expect(routingRequiresHumanHandoff({ readyForHuman: true, nextPhase: null, turn: 'none' })).toBe(true);
  });
});

describe('routingTaskPatch', () => {
  test('maps each §7.1 rule to the task fields it may move', () => {
    expect(routingTaskPatch({ readyForHuman: true, nextPhase: null, turn: 'none' })).toEqual({
      status: 'ready_for_human',
      ownerRunId: undefined,
      leaseExpiresAt: undefined,
    });
    expect(routingTaskPatch({ readyForHuman: false, nextPhase: 'implementation', turn: 'implementer' })).toEqual({
      status: 'queued',
      phase: 'implementation',
      ownerRunId: undefined,
      leaseExpiresAt: undefined,
    });
    expect(routingTaskPatch({ readyForHuman: false, nextPhase: 'review', turn: 're_review' })).toEqual({
      status: 'queued',
      phase: 'review',
      ownerRunId: undefined,
      leaseExpiresAt: undefined,
    });
    // Rule 4 and the legacy path move nothing: they route through the ordinary
    // review result, which is the caller's to complete.
    expect(routingTaskPatch({ readyForHuman: false, nextPhase: null, turn: 'none' })).toEqual({});
  });

  test('parks the rule-2 turns this runner cannot dispatch', () => {
    // A turn with no dispatcher parks for a human — visible, recoverable, and
    // claimed by nobody — with the claim released. The set is empty today; the
    // loop is what a re-added token must satisfy.
    for (const turn of UNDISPATCHABLE_TURNS) {
      expect(routingTaskPatch({ readyForHuman: false, nextPhase: null, turn })).toEqual({
        status: 'ready_for_human',
        ownerRunId: undefined,
        leaseExpiresAt: undefined,
      });
    }
    // The reviewer turn NAMES the review phase and is queued there since issue
    // #952: the review handler dispatches the reconsideration as an internal
    // sub-turn, so the destination discharges the dispute instead of finishing
    // the task around it.
    expect(routingTaskPatch({ readyForHuman: false, nextPhase: 'review', turn: 'reviewer' })).toEqual({
      status: 'queued',
      phase: 'review',
      ownerRunId: undefined,
      leaseExpiresAt: undefined,
    });
    // The evidence turn joined it in issue #964: each per-party collection run
    // is an internal review-phase sub-turn, so the round continues where the
    // dispatcher lives instead of parking.
    expect(routingTaskPatch({ readyForHuman: false, nextPhase: 'review', turn: 'evidence' })).toEqual({
      status: 'queued',
      phase: 'review',
      ownerRunId: undefined,
      leaseExpiresAt: undefined,
    });
  });
});

describe('routedPhaseCompletion', () => {
  const fallback = { status: 'queued', phase: 'review' };

  test('an undispatchable turn parks on the phase that ran, never on the fallback', () => {
    for (const turn of UNDISPATCHABLE_TURNS) {
      expect(
        routedPhaseCompletion({ readyForHuman: false, nextPhase: null, turn }, fallback, 'implementation'),
      ).toEqual({ status: 'ready_for_human', phase: 'implementation' });
    }
    // The reviewer turn routes instead (issue #952), and to its OWN destination
    // rather than the fallback's.
    expect(
      routedPhaseCompletion({ readyForHuman: false, nextPhase: 'review', turn: 'reviewer' }, fallback, 'implementation'),
    ).toEqual({ status: 'queued', phase: 'review' });
    // As does the evidence turn (issue #964): the round's remaining party run
    // is a review-phase sub-turn, not a park.
    expect(
      routedPhaseCompletion({ readyForHuman: false, nextPhase: 'review', turn: 'evidence' }, fallback, 'implementation'),
    ).toEqual({ status: 'queued', phase: 'review' });
  });

  test('rules 1, 2, 3, and 4 are unchanged', () => {
    expect(
      routedPhaseCompletion({ readyForHuman: true, nextPhase: null, turn: 'none' }, fallback, 'implementation'),
    ).toEqual({ status: 'ready_for_human', phase: 'implementation' });
    expect(
      routedPhaseCompletion(
        { readyForHuman: false, nextPhase: 'implementation', turn: 'implementer' },
        fallback,
        'review',
      ),
    ).toEqual({ status: 'queued', phase: 'implementation' });
    // Rules 3/4 and the §13 legacy path defer to the completion the caller
    // already decided.
    expect(
      routedPhaseCompletion({ readyForHuman: false, nextPhase: null, turn: 'none' }, fallback, 'implementation'),
    ).toBe(fallback);
  });
});
