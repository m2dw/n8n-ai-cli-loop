/**
 * The issue #951 sub-turn adapter (src/core/review-dispute-dispatch.ts,
 * docs/review-dispute-contract.md §7.1, §9, §10.1–§10.3, §12).
 *
 * The adapter's whole job is to make the three missing sub-turns implementable
 * as plain functions, so every test below drives a FAKE implementation — a
 * function returning a typed decision or a typed failure — and asserts what the
 * adapter did with it. No agent runs, no network, no artifact is written.
 *
 * Four properties carry the slice:
 *
 *  - **identity is derived, never invented.** The run id every transition is
 *    keyed on comes out of the claim's run id plus the sub-turn's coordinates, so
 *    a redelivery converges and a genuine retry does not.
 *  - **only a decision moves state.** Every failure and delay commits nothing:
 *    no transition travels on the result, so the runner has nothing to write.
 *  - **the evidence round takes both parties.** §7.1's evidence turn is one run
 *    per party and row 22 fires "when both have completed", so a first party's
 *    run records its attachments and moves NOTHING — the lineage it leaves in
 *    `evidence_requested` is the only lineage the second party can be dispatched
 *    against.
 *  - **the seam is the existing completion contract.** The success case is fed to
 *    the REAL `runNextPhase` on both task stores, and the block, the routing, and
 *    the audit events must land exactly as they do for any other completion.
 *  - **one route in, and only one.** `dispatchDisputeSubTurn` has exactly one
 *    production caller — the review phase's reviewer sub-turn (#952) — and no
 *    other; #954's arbitration turn shares the protocol tables but never the
 *    dispatcher.
 */
import { mkdtempSync, rmSync, readFileSync, readdirSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { MemoryTaskStore, SqliteTaskStore, runNextPhase } from '../dist/index.js';
import { REVIEW_DISPUTE_DEFAULT_LIMITS, ZERO_LINEAGE_COUNTERS, MAX_RUN_ID_CHARS } from '../dist/core/review-dispute.js';
import { transitionDigest } from '../dist/core/review-dispute-transition.js';
import { REVIEW_DISPUTE_CONTEXT_KEY, REVIEW_DISPUTE_TRANSITION_EVENT } from '../dist/core/review-dispute-commit.js';
import {
  DISPUTE_TURN_KINDS,
  disputeTurnAwaitsDispatcher,
  selectPendingDisputeTurn,
} from '../dist/core/review-dispute-turn.js';
import { evidenceArtifactName } from '../dist/core/review-dispute-evidence-state.js';
import { RECONSIDERATION_FAILURE_KINDS } from '../dist/handlers/review-reconsideration.js';
import { ARBITRATION_FAILURE_KINDS } from '../dist/handlers/review-arbitration.js';
import {
  ARBITRATION_FAILURE_NORMALIZATION,
  RECONSIDERATION_FAILURE_NORMALIZATION,
  normalizeArbitrationFailure,
  normalizeReconsiderationFailure,
  DISPUTE_SUB_TURN_DEFAULT_ACTORS,
  DISPUTE_SUB_TURN_DISPOSITIONS,
  DISPUTE_SUB_TURN_FAILURE_KINDS,
  DISPUTE_SUB_TURN_KINDS,
  DISPUTE_SUB_TURN_REQUIRED_STATES,
  DISPUTE_SUB_TURN_TASK_TURNS,
  MAX_DISPUTE_SUB_TURN_ATTEMPT,
  REVIEW_DISPUTE_EVIDENCE_ROUND_CONTEXT_KEY,
  REVIEW_DISPUTE_SUB_TURN_CONTEXT_KEY,
  REVIEW_DISPUTE_SUB_TURN_EVENT,
  disputeEvidenceRoundComplete,
  disputeSubTurnAlreadyApplied,
  disputeSubTurnIdentity,
  disputeSubTurnRunKey,
  dispatchDisputeSubTurn,
  parseDisputeEvidenceRoundState,
  readDisputeEvidenceRoundState,
} from '../dist/core/review-dispute-dispatch.js';

const LINEAGE_A = 'ln-aaaaaaaaaaaa';
const LINEAGE_B = 'ln-bbbbbbbbbbbb';
const BOUNDARY = 'src/auth/handler.ts';
const RUN_ID = 'run-review-1';

/**
 * The shortest §7 row sequence that reaches each state, copied from the #950
 * fixtures so a lineage this suite dispatches against is one the transition
 * table could actually have produced:
 *
 *  - `disputed` is row 2 — version 1's rebuttal slot consumed, round untouched;
 *  - `arbitration_pending` is rows 2 → 10, which spends the round;
 *  - `evidence_requested` is rows 2 → 10 → 16, so a verdict came back (one pass)
 *    and the round is still available (row 22 charges it on the way out).
 */
const REACHABLE = {
  disputed: { rebuttedVersions: [1], counters: { rebuttals: 1 } },
  arbitration_pending: { rebuttedVersions: [1], counters: { rebuttals: 1, reconsiderations: 1 } },
  evidence_requested: {
    rebuttedVersions: [1],
    counters: { rebuttals: 1, reconsiderations: 1, arbitrationPasses: 1 },
  },
};

function lineage(id, state) {
  const history = REACHABLE[state];
  return {
    lineageId: id,
    state,
    version: 1,
    counters: { ...ZERO_LINEAGE_COUNTERS, ...history.counters },
    rebuttedVersions: [...history.rebuttedVersions],
    humanGate: false,
    severity: 'P1',
    affectedBoundary: BOUNDARY,
  };
}

function context(lineages) {
  return { version: 1, reviewStructure: 'structured', lineages };
}

/** The real #950 selector, so no turn in this suite is hand-authored. */
function select(ctx) {
  const turn = selectPendingDisputeTurn({ enabled: true, persisted: ctx });
  if (!disputeTurnAwaitsDispatcher(turn)) {
    throw new Error(`fixture selected a non-dispatchable turn: ${turn.kind}`);
  }
  return turn;
}

function evidenceTurn(ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A, 'evidence_requested') })) {
  return { ctx, turn: select(ctx) };
}

/** The reviewer turn, which is the one that returns an ordinary #840 decision. */
function reviewerTurn(ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A, 'disputed') })) {
  return { ctx, turn: select(ctx) };
}

function identityFor(turn, overrides = {}) {
  const result = disputeSubTurnIdentity({
    runId: RUN_ID,
    turn,
    ...(turn.kind === 'evidence_collection' ? { party: 'reviewer' } : {}),
    ...overrides,
  });
  if (!result.ok) throw new Error(`identity refused: ${JSON.stringify(result.failure)}`);
  return result.value;
}

/** A sub-turn implementation that records what it was handed. */
function recordingRunner(result) {
  const calls = [];
  const runner = async (request) => {
    calls.push(request);
    return typeof result === 'function' ? result(request) : result;
  };
  runner.calls = calls;
  return runner;
}

/**
 * §7 row 10's decision: the reviewer upheld the finding, which is the ordinary
 * shape of a sub-turn that returns a decision at all. The evidence turn cannot —
 * its runs "change no lineage state themselves" (§7.1) — so every `completed`
 * test below drives the reviewer turn.
 */
function upheld(ctx, lineageId = LINEAGE_A, version = ctx.lineages[lineageId].version) {
  return {
    status: 'completed',
    decision: {
      kind: 'reconsideration',
      admitted: {
        record: {
          lineageId,
          version,
          reconsideration: 'uphold',
          rationale: 'The premise was wrong; the corrected one still shows the defect.',
        },
        lineage: ctx.lineages[lineageId],
      },
    },
  };
}

/** One party's evidence-collection run: attachment counts and nothing else. */
function collected(attachments = { [LINEAGE_A]: 2 }) {
  return { status: 'collected', attachments };
}

/**
 * The OTHER party's run, already on file. Row 22 needs both, so this is what a
 * closing evidence dispatch is handed.
 */
function roundWith(party, overrides = {}) {
  const {
    lineageId = LINEAGE_A,
    version = 1,
    attachments = 1,
    runId = `${RUN_ID}~evidence.${party}.0`,
    attempt = 0,
    recordedRunId,
  } = overrides;
  return {
    lineages: {
      [lineageId]: {
        version,
        parties: { [party]: { runId, attempt, attachments } },
        ...(recordedRunId === undefined ? {} : { recordedRunId }),
      },
    },
  };
}

/** A closing evidence dispatch: the reviewer answers, the implementer already did. */
function closingRound(overrides = {}) {
  return { runner: recordingRunner(collected()), evidenceRound: roundWith('implementer'), ...overrides };
}

describe('sub-turn identity (#951)', () => {
  test('the token list is exactly the set #950 says awaits a dispatcher', () => {
    const awaiting = DISPUTE_TURN_KINDS.filter((kind) => disputeTurnAwaitsDispatcher({ kind }));
    expect([...DISPUTE_SUB_TURN_KINDS].sort()).toEqual([...awaiting].sort());
    // Every mapping is total over that set, so a turn can never reach dispatch
    // without a §7.1 token, a required state, and a default actor.
    for (const kind of DISPUTE_SUB_TURN_KINDS) {
      expect(DISPUTE_SUB_TURN_TASK_TURNS[kind]).toBeTruthy();
      expect(DISPUTE_SUB_TURN_REQUIRED_STATES[kind]).toBeTruthy();
      expect(DISPUTE_SUB_TURN_DEFAULT_ACTORS[kind]).toBeTruthy();
    }
  });

  test('the same request derives the same run id, digest and lineage set', () => {
    const { turn } = evidenceTurn();
    const first = identityFor(turn);
    const second = identityFor(turn);
    expect(second).toEqual(first);
    expect(first.runId.length).toBeLessThanOrEqual(MAX_RUN_ID_CHARS);
    expect(first.taskTurn).toBe('evidence');
    expect(first.party).toBe('reviewer');
    expect(first.attempt).toBe(0);
    expect(first.claimRunId).toBe(RUN_ID);
    expect(first.lineageIds).toEqual([LINEAGE_A]);
    // The per-lineage replay key is #840's own form, not a second vocabulary.
    expect(disputeSubTurnRunKey(first, LINEAGE_A, 1)).toBe(`${LINEAGE_A}@1#${first.runId}`);
  });

  test('party, attempt and turn kind each produce a distinct run id', () => {
    const { turn } = evidenceTurn();
    const reviewerSide = identityFor(turn);
    const implementerSide = identityFor(turn, { party: 'implementer' });
    const retry = identityFor(turn, { attempt: 1 });
    const reconsideration = identityFor(
      select(context({ [LINEAGE_A]: lineage(LINEAGE_A, 'disputed') })),
    );
    const ids = [reviewerSide, implementerSide, retry, reconsideration].map((i) => i.runId);
    expect(new Set(ids).size).toBe(4);
    expect(new Set([reviewerSide, implementerSide, retry, reconsideration].map((i) => i.digest)).size).toBe(4);
  });

  test('a run id close to the ceiling is hashed rather than truncated past it', () => {
    const { turn } = evidenceTurn();
    const long = 'r'.repeat(MAX_RUN_ID_CHARS);
    const identity = identityFor(turn, { runId: long });
    expect(identity.runId.length).toBeLessThanOrEqual(MAX_RUN_ID_CHARS);
    expect(identity.runId).toContain(`#${identity.digest}`);
    // Still deterministic on the hashed branch.
    expect(identityFor(turn, { runId: long }).runId).toBe(identity.runId);
  });

  test.each([
    ['an empty claim run id', { runId: '   ' }, 'invalid-type'],
    ['a run id past the bound', { runId: 'r'.repeat(MAX_RUN_ID_CHARS + 1) }, 'field-too-long'],
    ['a fractional attempt', { attempt: 1.5 }, 'invalid-type'],
    ['a negative attempt', { attempt: -1 }, 'invalid-type'],
    ['an attempt past the bound', { attempt: MAX_DISPUTE_SUB_TURN_ATTEMPT + 1 }, 'invalid-type'],
    ['an unknown party', { party: 'arbiter' }, 'unknown-enum'],
  ])('refuses %s rather than falling back to an ad hoc id', (_label, overrides, reason) => {
    const { turn } = evidenceTurn();
    const result = disputeSubTurnIdentity({ runId: RUN_ID, turn, party: 'reviewer', ...overrides });
    expect(result.ok).toBe(false);
    expect(result.failure.reason).toBe(reason);
  });

  test('the evidence turn requires a party and the other turns refuse one', () => {
    const { turn } = evidenceTurn();
    expect(disputeSubTurnIdentity({ runId: RUN_ID, turn })).toMatchObject({
      ok: false,
      failure: { reason: 'missing-field', detail: 'run.party' },
    });
    const reviewer = select(context({ [LINEAGE_A]: lineage(LINEAGE_A, 'disputed') }));
    expect(disputeSubTurnIdentity({ runId: RUN_ID, turn: reviewer, party: 'reviewer' })).toMatchObject({
      ok: false,
      failure: { reason: 'unknown-field' },
    });
  });
});

describe('dispatch — nothing runs that should not (#951)', () => {
  test('a turn with no registered implementation parks and never moves state', async () => {
    const { ctx, turn } = evidenceTurn();
    const completion = await dispatchDisputeSubTurn({ turn, context: ctx, identity: identityFor(turn), registry: {} });
    expect(completion.disposition).toBe('parked');
    expect(completion.failure).toMatchObject({ kind: 'no_implementation', detail: 'evidence_collection' });
    expect(completion.transition).toBeNull();
    // §9's park, in the shape every other handler uses. Critically: no
    // `disputeTransition` for the runner to commit.
    expect(completion.result.result).toBe('blocked');
    expect(completion.result.disputeTransition).toBeUndefined();
  });

  test('an identity built for a different turn is refused before the implementation runs', async () => {
    const { ctx, turn } = evidenceTurn();
    const other = identityFor(select(context({ [LINEAGE_B]: lineage(LINEAGE_B, 'disputed') })));
    const runner = recordingRunner(collected());
    const completion = await dispatchDisputeSubTurn({ turn, context: ctx, identity: other, runner });
    expect(completion.failure.kind).toBe('invalid_identity');
    expect(runner.calls).toHaveLength(0);
  });

  test('a lineage set that disagrees with the turn is refused', async () => {
    const { ctx, turn } = evidenceTurn();
    const identity = { ...identityFor(turn), lineageIds: [LINEAGE_A, LINEAGE_B] };
    const runner = recordingRunner(collected());
    const completion = await dispatchDisputeSubTurn({ turn, context: ctx, identity, runner });
    expect(completion.failure.kind).toBe('invalid_identity');
    expect(runner.calls).toHaveLength(0);
  });

  test('an evidence identity that names no party is refused, and a reviewer one that names a party', async () => {
    // §7.1 dispatches ONE evidence run per party. A party-less evidence identity
    // would make the two runs one run — and the second indistinguishable from a
    // redelivery of the first — so the pairing is a guard, not a convention.
    const evidence = evidenceTurn();
    const partyless = await dispatchDisputeSubTurn({
      turn: evidence.turn,
      context: evidence.ctx,
      identity: { ...identityFor(evidence.turn), party: null },
      runner: recordingRunner(collected()),
    });
    expect(partyless.failure).toMatchObject({ kind: 'invalid_identity', detail: 'identity.party:absent' });

    const reviewer = reviewerTurn();
    const partied = await dispatchDisputeSubTurn({
      turn: reviewer.turn,
      context: reviewer.ctx,
      identity: { ...identityFor(reviewer.turn), party: 'reviewer' },
      runner: recordingRunner(upheld(reviewer.ctx)),
    });
    expect(partied.failure).toMatchObject({ kind: 'invalid_identity', detail: 'identity.party:reviewer' });
  });

  test('an evidence party outside §7.1\'s two is refused before it can be recorded', async () => {
    // The party is what the round record is KEYED on, so a value that is not one
    // of the two — a field lost across a serialization boundary, a token from
    // somewhere else in the protocol — would be written as a party that does not
    // exist, and the next dispatch would refuse the record this one wrote.
    // Presence is not the test; membership is.
    const evidence = evidenceTurn();
    for (const [party, detail] of [
      [undefined, 'identity.party:absent'],
      ['arbiter', 'identity.party:arbiter'],
      ['', 'identity.party:'],
      ['REVIEWER', 'identity.party:REVIEWER'],
    ]) {
      const runner = recordingRunner(collected());
      const completion = await dispatchDisputeSubTurn({
        turn: evidence.turn,
        context: evidence.ctx,
        identity: { ...identityFor(evidence.turn), party },
        runner,
        evidenceRound: undefined,
      });
      expect(completion.failure).toMatchObject({ kind: 'invalid_identity', detail });
      expect(completion.disposition).toBe('parked');
      expect(completion.transition).toBeNull();
      // Nothing ran, so nothing keyed on the bad party reached the round record.
      expect(runner.calls).toHaveLength(0);
      expect(completion.evidenceRound).toBeNull();
    }
  });

  test('a block that does not validate parks with the §12 failure attached', async () => {
    const { turn } = evidenceTurn();
    const runner = recordingRunner(collected());
    const completion = await dispatchDisputeSubTurn({
      turn,
      // A counter the §6.1 limits never allowed: the block is not one this
      // session could hold, so it is refused rather than acted on.
      context: context({
        [LINEAGE_A]: { ...lineage(LINEAGE_A, 'evidence_requested'), counters: { ...ZERO_LINEAGE_COUNTERS, rebuttals: 99 } },
      }),
      identity: identityFor(turn),
      runner,
    });
    expect(completion.failure.kind).toBe('invalid_context');
    expect(completion.failure.protocol).toBeDefined();
    expect(runner.calls).toHaveLength(0);
  });

  test('a lineage that left the state its turn was selected from is stale, not dispatchable', async () => {
    const { turn } = evidenceTurn();
    const runner = recordingRunner(collected());
    const completion = await dispatchDisputeSubTurn({
      turn,
      // The block moved between selection and dispatch: another worker's
      // completion, an operator action, a resumed stale claim.
      context: context({ [LINEAGE_A]: lineage(LINEAGE_A, 'arbitration_pending') }),
      identity: identityFor(turn),
      runner,
    });
    expect(completion.disposition).toBe('parked');
    expect(completion.failure).toMatchObject({
      kind: 'stale_lineage',
      detail: `lineages.${LINEAGE_A}.state:arbitration_pending`,
    });
    expect(runner.calls).toHaveLength(0);
  });
});

describe('dispatch — a decision, applied once (#951)', () => {
  test('a completed sub-turn becomes a phase completion carrying the transition', async () => {
    const { ctx, turn } = reviewerTurn();
    const identity = identityFor(turn);
    const runner = recordingRunner({
      ...upheld(ctx),
      artifacts: [{ name: 'reconsideration.json', content: '{"reconsideration":"uphold"}' }],
      context: { artifactDir: '/tmp/run-1' },
    });

    const completion = await dispatchDisputeSubTurn({ turn, context: ctx, identity, runner });

    // The implementation is handed values only — no store, no key, no CAS.
    expect(Object.keys(runner.calls[0]).sort()).toEqual(['context', 'identity', 'limits', 'turn']);
    expect(runner.calls[0].identity.runId).toBe(identity.runId);
    expect(runner.calls[0].limits).toEqual(REVIEW_DISPUTE_DEFAULT_LIMITS);

    expect(completion.disposition).toBe('applied');
    expect(completion.result.result).toBe('success');
    // Row 10 sends the upheld finding to arbitration and spends the slot.
    const applied = completion.transition.applied;
    expect(applied).toHaveLength(1);
    expect(applied[0]).toMatchObject({ row: 10, toState: 'arbitration_pending', replayed: false, actor: 'reviewer' });
    expect(applied[0].transitionKey).toBe(transitionDigest(LINEAGE_A, 1, identity.runId));
    expect(completion.transition.context.lineages[LINEAGE_A].counters.reconsiderations).toBe(1);
    // The application travels OUTSIDE context, for the runner to commit.
    expect(completion.result.disputeTransition).toBe(completion.transition);
    // §10.2 bytes travel back for the caller to write; the adapter wrote nothing.
    expect(completion.artifacts).toEqual([{ name: 'reconsideration.json', content: '{"reconsideration":"uphold"}' }]);
    // A turn with no evidence round writes no round record.
    expect(completion.evidenceRound).toBeNull();
    expect(completion.result.context[REVIEW_DISPUTE_EVIDENCE_ROUND_CONTEXT_KEY]).toBeUndefined();
  });

  test('the bounded summary and its one audit event carry literals only', async () => {
    const { ctx, turn } = evidenceTurn();
    const identity = identityFor(turn);
    const completion = await dispatchDisputeSubTurn({
      turn,
      context: ctx,
      identity,
      ...closingRound({
        runner: recordingRunner({
          ...collected(),
          artifacts: [{ name: 'evidence-round.json', content: 'bytes that must not travel' }],
          context: { artifactDir: '/tmp/run-1' },
        }),
      }),
    });

    const summary = completion.result.context[REVIEW_DISPUTE_SUB_TURN_CONTEXT_KEY];
    expect(summary).toMatchObject({
      turn: 'evidence_collection',
      taskTurn: 'evidence',
      party: 'reviewer',
      attempt: 0,
      runId: identity.runId,
      digest: identity.digest,
      lineageIds: [LINEAGE_A],
      disposition: 'applied',
      applied: 1,
      refused: 0,
      replayed: false,
      artifacts: ['evidence-round.json'],
      evidenceRound: {
        party: 'reviewer',
        complete: [LINEAGE_A],
        awaiting: [],
        closing: LINEAGE_A,
        // Both parties' admitted attachments, which is what row 22 records.
        attachmentsRecorded: 3,
        deferred: [],
      },
    });
    // The implementation's own context is merged, never dropped.
    expect(completion.result.context.artifactDir).toBe('/tmp/run-1');

    expect(completion.result.extraEvents).toHaveLength(1);
    expect(completion.result.extraEvents[0].type).toBe(REVIEW_DISPUTE_SUB_TURN_EVENT);
    expect(completion.result.extraEvents[0].data).toEqual(summary);
    // Literals, counters, ids and names only: no artifact bytes, no prose.
    const serialized = JSON.stringify(completion.result.extraEvents[0].data);
    expect(serialized).not.toContain('bytes that must not travel');
    expect(serialized).not.toContain(BOUNDARY);
  });

  test('a redelivery of the same attempt is recognized from the ledger, not from prose', async () => {
    const { ctx, turn } = evidenceTurn();
    const identity = identityFor(turn);
    const dispatch = closingRound();
    const first = await dispatchDisputeSubTurn({ turn, context: ctx, identity, ...dispatch });

    // The retried delivery runs against the block the first one produced — the
    // lineage has already left `evidence_requested`, and the ledger is the only
    // thing that says this run is the one that moved it.
    expect(disputeSubTurnAlreadyApplied(first.transition.context.lineages[LINEAGE_A], identity)).toBe(true);
    const second = await dispatchDisputeSubTurn({
      turn,
      context: first.transition.context,
      identity,
      runner: dispatch.runner,
      // The round record the first delivery committed, closed under its run id.
      evidenceRound: first.evidenceRound,
    });

    expect(second.disposition).toBe('replayed');
    expect(second.transition.replayed).toBe(true);
    expect(second.transition.applied[0]).toMatchObject({ replayed: true, transitionKey: first.transition.applied[0].transitionKey });
    // Nothing moved a second time, and the retry routes exactly as the first did.
    expect(second.transition.context.lineages[LINEAGE_A].counters.evidenceRoundsUsed).toBe(1);
    expect(second.transition.unchanged).toBe(true);
    expect(second.transition.routing).toEqual(first.transition.routing);
  });

  test('a genuine retry under a new attempt is a different run, and is not applied twice', async () => {
    const { ctx, turn } = evidenceTurn();
    const first = identityFor(turn);
    const retry = identityFor(turn, { attempt: 1 });
    const dispatch = closingRound();

    const applied = await dispatchDisputeSubTurn({ turn, context: ctx, identity: first, ...dispatch });
    const retried = await dispatchDisputeSubTurn({ turn, context: ctx, identity: retry, ...dispatch });
    // Against the SAME block both apply, and their keys differ — a second turn
    // for one lineage version is never swallowed as a redelivery of the first.
    expect(retried.transition.applied[0].transitionKey).not.toBe(applied.transition.applied[0].transitionKey);

    // Against the block the first delivery produced, the retry is simply stale:
    // the round it would charge has already been charged.
    const afterwards = await dispatchDisputeSubTurn({
      turn,
      context: applied.transition.context,
      identity: retry,
      runner: dispatch.runner,
      evidenceRound: applied.evidenceRound,
    });
    expect(afterwards.disposition).toBe('parked');
    expect(afterwards.failure.kind).toBe('stale_lineage');
  });

  test('a decision the current block refuses in full parks instead of committing nothing loudly', async () => {
    const { ctx, turn } = reviewerTurn();
    const completion = await dispatchDisputeSubTurn({
      turn,
      context: ctx,
      identity: identityFor(turn),
      // A version this lineage has never carried: #840 refuses the row, applies
      // nothing, and the adapter must not route as though a turn was taken.
      runner: recordingRunner(upheld(ctx, LINEAGE_A, 7)),
    });
    expect(completion.disposition).toBe('parked');
    expect(completion.failure.kind).toBe('stale_lineage');
    expect(completion.failure.protocol.reason).toBe('stale-version');
    expect(completion.result.disputeTransition).toBeUndefined();
  });

  test('a decision the transition layer rejects outright parks with the §12 failure', async () => {
    const { ctx, turn } = reviewerTurn();
    const completion = await dispatchDisputeSubTurn({
      turn,
      context: ctx,
      identity: identityFor(turn),
      // A `revise` answer with no #845 classification behind it: the decision is
      // this turn's own kind and names this turn's own lineage, so it reaches
      // #840 — which refuses the whole application rather than any single row.
      runner: recordingRunner({
        status: 'completed',
        decision: {
          kind: 'reconsideration',
          admitted: {
            record: {
              lineageId: LINEAGE_A,
              version: 1,
              reconsideration: 'revise',
              rationale: 'The premise was wrong; here is the corrected finding.',
            },
            lineage: ctx.lineages[LINEAGE_A],
          },
        },
      }),
    });
    expect(completion.disposition).toBe('parked');
    expect(completion.failure.kind).toBe('transition_refused');
    expect(completion.failure.protocol.reason).toBe('invalid-revision');
    expect(completion.transition).toBeNull();
  });

  test('a decision of another turn\'s kind is malformed, however well-formed it is', async () => {
    const { ctx, turn } = reviewerTurn();
    const completion = await dispatchDisputeSubTurn({
      turn,
      context: ctx,
      identity: identityFor(turn),
      // A finding admission #840 would happily apply — it OPENS a lineage — but
      // one no reconsideration run may return: applying it would add lineages
      // while the disputed lineage this turn was selected for never moved.
      runner: recordingRunner({
        status: 'completed',
        decision: {
          kind: 'finding_admission',
          next: context({ ...ctx.lineages, [LINEAGE_B]: lineage(LINEAGE_B, 'disputed') }),
        },
      }),
    });
    expect(completion.disposition).toBe('parked');
    expect(completion.failure).toMatchObject({
      kind: 'malformed_output',
      detail: 'result.decision.kind:finding_admission:reviewer_reconsideration',
    });
    expect(completion.transition).toBeNull();
    expect(completion.result.disputeTransition).toBeUndefined();
    // Nothing of the block travels, so the runner has no lineage set to write.
    expect(completion.result.context[REVIEW_DISPUTE_CONTEXT_KEY]).toBeUndefined();
  });

  test('a decision addressed outside the turn\'s lineage set is refused before it is applied', async () => {
    const { ctx, turn } = reviewerTurn();
    // A lineage this turn does not cover — so every guard above (its state, its
    // ledger, its round) was computed against a different lineage entirely.
    const outside = 'ln-cccccccccccc';
    const completion = await dispatchDisputeSubTurn({
      turn,
      context: ctx,
      identity: identityFor(turn),
      runner: recordingRunner({
        status: 'completed',
        decision: {
          kind: 'reconsideration',
          admitted: {
            record: {
              lineageId: outside,
              version: 1,
              reconsideration: 'uphold',
              rationale: 'The premise was wrong; the corrected one still shows the defect.',
            },
            lineage: ctx.lineages[LINEAGE_A],
          },
        },
      }),
    });
    expect(completion.disposition).toBe('parked');
    expect(completion.failure).toMatchObject({
      kind: 'malformed_output',
      detail: `result.decision.lineageId:${outside}:unselected`,
    });
    expect(completion.transition).toBeNull();
    expect(completion.result.disputeTransition).toBeUndefined();
  });

  test('a runtime value that is not a result at all is a §12 refusal, not a crash', async () => {
    const { ctx, turn } = reviewerTurn();
    const inadmissible = [
      // The motivating shape: `decision.kind` would be read off nothing.
      [{ status: 'completed' }, 'result.decision'],
      [{ status: 'completed', decision: 'uphold' }, 'result.decision'],
      [{ ...upheld(ctx), actor: 'stranger' }, 'result.actor:stranger'],
      [{ status: 'failed' }, 'result.failure'],
      [{ status: 'failed', failure: { kind: 'exploded', detail: null } }, 'result.failure.kind:exploded'],
      [{ status: 'failed', failure: { kind: 'timeout', detail: 42 } }, 'result.failure.detail'],
      [{ status: 'collected' }, 'result.attachments'],
      [{ status: 'inconclusive' }, 'result.status:inconclusive'],
      [{ ...upheld(ctx), artifacts: ['transcript.md'] }, 'result.artifacts[0]'],
      [{ ...upheld(ctx), context: 'reviewed' }, 'result.context'],
      // The §12 failure a `malformed_output`/`transition_refused` carries is
      // copied verbatim into the context patch and the audit event, so it is
      // admitted as a `ReviewDisputeFailure` and not merely as an object.
      [
        { status: 'failed', failure: { kind: 'malformed_output', detail: null, protocol: 'unparseable' } },
        'result.failure.protocol',
      ],
      [
        { status: 'failed', failure: { kind: 'malformed_output', detail: null, protocol: { reason: 'invented', detail: null } } },
        'result.failure.protocol.reason:invented',
      ],
      [
        { status: 'failed', failure: { kind: 'malformed_output', detail: null, protocol: { detail: null } } },
        'result.failure.protocol.reason:undefined',
      ],
      [
        {
          status: 'failed',
          failure: { kind: 'malformed_output', detail: null, protocol: { reason: 'missing-field', detail: { field: 'x' } } },
        },
        'result.failure.protocol.detail',
      ],
      [undefined, 'result:undefined'],
      [null, 'result:null'],
    ];

    for (const [value, detail] of inadmissible) {
      const completion = await dispatchDisputeSubTurn({
        turn,
        context: ctx,
        identity: identityFor(turn),
        runner: recordingRunner(value),
      });
      expect(completion.failure).toEqual({ kind: 'malformed_output', detail });
      expect(completion.disposition).toBe('parked');
      expect(completion.transition).toBeNull();
      expect(completion.result.disputeTransition).toBeUndefined();
      // §12 refusals are audited like every other outcome — the whole reason a
      // throw would be worse than a park.
      expect(completion.result.extraEvents).toHaveLength(1);
      expect(completion.result.extraEvents[0].type).toBe(REVIEW_DISPUTE_SUB_TURN_EVENT);
      // Not one field of a value this adapter could not admit is carried.
      expect(completion.artifacts).toEqual([]);
    }
  });

  test('a cyclic protocol failure is refused before it can be serialized', async () => {
    // The park this adapter promises is only controlled if the completion it
    // builds can actually be written: a cyclic `reason` copied into the context
    // patch would throw at the SQLite serialization instead, after the refusal
    // had already been reported as handled.
    const { ctx, turn } = reviewerTurn();
    const cyclic = { reason: 'missing-field', detail: null };
    cyclic.reason = cyclic;
    const completion = await dispatchDisputeSubTurn({
      turn,
      context: ctx,
      identity: identityFor(turn),
      runner: recordingRunner({ status: 'failed', failure: { kind: 'malformed_output', detail: null, protocol: cyclic } }),
    });
    expect(completion.failure).toEqual({ kind: 'malformed_output', detail: 'result.failure.protocol.reason:object' });
    expect(completion.disposition).toBe('parked');
    expect(() => JSON.stringify(completion.result)).not.toThrow();
  });

  test('a context patch the task store could not write is refused before it is carried', async () => {
    // The implementation's own `context` is copied VERBATIM into the completion,
    // and the store persists it with `JSON.stringify`. A value that call cannot
    // serialize would throw at persistence — after the adapter had already
    // reported a handled outcome — leaving the claimed task to lease recovery
    // with no record of the run at all. So it is refused here, where a refusal is
    // still a §12 park.
    const { ctx, turn } = reviewerTurn();
    const cyclic = { artifactDir: '/tmp/run-1' };
    cyclic.self = cyclic;
    const deep = {};
    let node = deep;
    for (let level = 0; level < 40; level += 1) {
      node.next = {};
      node = node.next;
    }
    const throwing = {};
    Object.defineProperty(throwing, 'boom', {
      enumerable: true,
      get() {
        throw new Error('a getter that throws is a write that throws');
      },
    });
    const unserializable = [
      [cyclic, 'result.context:cyclic'],
      [{ nested: { list: [{ deeper: cyclic }] } }, 'result.context:cyclic'],
      [{ collected: 3n }, 'result.context:bigint'],
      [{ retry: () => 'later' }, 'result.context:function'],
      [{ key: Symbol('evidence') }, 'result.context:symbol'],
      [{ attachments: Number.NaN }, 'result.context:non-finite'],
      [{ elapsed: Number.POSITIVE_INFINITY }, 'result.context:non-finite'],
      // Serializes as something else entirely — `{}`, an ISO string — so what is
      // read back is not what the implementation returned.
      [{ parties: new Map([['reviewer', 1]]) }, 'result.context:non-plain-object'],
      [{ startedAt: new Date(0) }, 'result.context:non-plain-object'],
      [deep, 'result.context:too-deep'],
      [throwing, 'result.context:unreadable'],
    ];

    for (const [patch, detail] of unserializable) {
      const completion = await dispatchDisputeSubTurn({
        turn,
        context: ctx,
        identity: identityFor(turn),
        runner: recordingRunner({ ...upheld(ctx), context: patch }),
      });
      expect(completion.failure).toEqual({ kind: 'malformed_output', detail });
      expect(completion.disposition).toBe('parked');
      expect(completion.transition).toBeNull();
      expect(completion.result.disputeTransition).toBeUndefined();
      // The park is only controlled if the completion it built can be written.
      expect(() => JSON.stringify(completion.result)).not.toThrow();
      expect(completion.result.context.artifactDir).toBeUndefined();
    }
  });

  test('an ordinary context patch — nesting, shared values, an unset field — still travels', async () => {
    // The guard above admits JSON values, not a narrower shape: an implementation
    // reporting where it wrote its bytes must not be parked for it.
    const { ctx, turn } = reviewerTurn();
    const shared = { attempt: 0 };
    const completion = await dispatchDisputeSubTurn({
      turn,
      context: ctx,
      identity: identityFor(turn),
      runner: recordingRunner({
        ...upheld(ctx),
        context: {
          artifactDir: '/tmp/run-1',
          counts: { admitted: 2, refused: 0, ratio: 0.5 },
          tags: ['reconsideration', null, true],
          // The same object twice is a DAG, not a cycle; the serializer writes it
          // out twice and is happy to.
          first: shared,
          second: shared,
          // Dropped by the serializer either way, so it is not a malformed patch.
          transcript: undefined,
        },
      }),
    });

    expect(completion.disposition).toBe('applied');
    expect(completion.result.context.artifactDir).toBe('/tmp/run-1');
    expect(completion.result.context.counts).toEqual({ admitted: 2, refused: 0, ratio: 0.5 });
    expect(completion.result.context.second).toEqual({ attempt: 0 });
    expect(() => JSON.stringify(completion.result)).not.toThrow();
  });

  test('an artifact name that is not a base name is refused, and never republished', async () => {
    // `DisputeArtifact.name` is a base name because the directory holding it is
    // the caller's: a writer doing `join(runDir, name)` on any of these would
    // land outside that directory once this adapter is wired.
    const { ctx, turn } = reviewerTurn();
    const escaping = ['../outside.txt', '/etc/passwd', 'nested/record.json', '..\\outside.txt', 'C:record.json', '..', '.', ''];

    for (const name of escaping) {
      const completion = await dispatchDisputeSubTurn({
        turn,
        context: ctx,
        identity: identityFor(turn),
        runner: recordingRunner({ ...upheld(ctx), artifacts: [{ name, content: 'bytes' }] }),
      });
      expect(completion.failure).toEqual({ kind: 'malformed_output', detail: 'result.artifacts[0].name' });
      expect(completion.disposition).toBe('parked');
      expect(completion.artifacts).toEqual([]);
      // The offending name is exactly the value that must not reach the audit
      // event or the context patch, so only its index travels.
      expect(completion.result.context[REVIEW_DISPUTE_SUB_TURN_CONTEXT_KEY].artifacts).toBeUndefined();
    }
  });

  test('an implementation may name the actor its turn recorded', async () => {
    const { ctx, turn } = reviewerTurn();
    const completion = await dispatchDisputeSubTurn({
      turn,
      context: ctx,
      identity: identityFor(turn),
      runner: recordingRunner({ ...upheld(ctx), actor: 'runner' }),
    });
    expect(completion.transition.applied[0].actor).toBe('runner');
  });

  test('each turn returning the other turn\'s delivered shape is malformed, not reinterpreted', async () => {
    // §7.1: evidence-collection runs "carry no dispositions, change no lineage
    // state themselves". An evidence run that could name its own transition could
    // close a two-party round on its own.
    const evidence = evidenceTurn();
    const decided = await dispatchDisputeSubTurn({
      turn: evidence.turn,
      context: evidence.ctx,
      identity: identityFor(evidence.turn),
      runner: recordingRunner({
        status: 'completed',
        decision: { kind: 'evidence_round', lineageId: LINEAGE_A, version: 1, attachmentsRecorded: 2 },
      }),
    });
    expect(decided.disposition).toBe('parked');
    expect(decided.failure).toMatchObject({
      kind: 'malformed_output',
      detail: 'result.status:completed:evidence_collection',
    });
    expect(decided.transition).toBeNull();
    expect(decided.result.disputeTransition).toBeUndefined();

    const reviewer = reviewerTurn();
    const collecting = await dispatchDisputeSubTurn({
      turn: reviewer.turn,
      context: reviewer.ctx,
      identity: identityFor(reviewer.turn),
      runner: recordingRunner(collected()),
    });
    expect(collecting.failure).toMatchObject({
      kind: 'malformed_output',
      detail: 'result.status:collected:reviewer_reconsideration',
    });
    expect(collecting.transition).toBeNull();
  });
});

describe('dispatch — the bounded evidence round takes both parties (#951)', () => {
  test('the first party\'s run is recorded and moves nothing at all', async () => {
    const { ctx, turn } = evidenceTurn();
    const identity = identityFor(turn, { party: 'implementer' });
    const completion = await dispatchDisputeSubTurn({
      turn,
      context: ctx,
      identity,
      runner: recordingRunner(collected({ [LINEAGE_A]: 2 })),
    });

    expect(completion.disposition).toBe('collected');
    // §7.1: row 22 fires only "when both have completed". Nothing here may
    // transition — the lineage the second party is dispatched against is
    // precisely the one this run must leave in `evidence_requested` — but the
    // completion routes the task back to the review phase for that remaining
    // internal run (issue #964), through a routing-only application: replayed,
    // nothing applied, the block byte-identical.
    expect(completion.transition).toBeNull();
    expect(completion.result.result).toBe('success');
    expect(completion.result.disputeTransition).toMatchObject({
      replayed: true,
      unchanged: true,
      applied: [],
      refused: [],
      routing: { rule: 2, turn: 'evidence', nextPhase: 'review', readyForHuman: false },
    });
    // The routed application carries the CURRENT block: the lineage stays in
    // `evidence_requested` for the other party's dispatch.
    expect(completion.result.disputeTransition.context.lineages[LINEAGE_A].state).toBe('evidence_requested');
    expect(completion.failure).toBeNull();

    // The party's answer is preserved, keyed on the run that produced it.
    const round = completion.result.context[REVIEW_DISPUTE_EVIDENCE_ROUND_CONTEXT_KEY];
    expect(round).toEqual(completion.evidenceRound);
    expect(round.lineages[LINEAGE_A]).toMatchObject({
      version: 1,
      parties: { implementer: { runId: identity.runId, attempt: 0, attachments: 2 } },
    });
    expect(round.lineages[LINEAGE_A].parties.reviewer).toBeUndefined();
    expect(disputeEvidenceRoundComplete(round.lineages[LINEAGE_A])).toBe(false);
    expect(completion.result.context[REVIEW_DISPUTE_SUB_TURN_CONTEXT_KEY]).toMatchObject({
      disposition: 'collected',
      evidenceRound: { party: 'implementer', attachments: 2, complete: [], awaiting: [LINEAGE_A] },
    });
  });

  test('the second party still reaches the lineage, and row 22 records both sides', async () => {
    const { ctx, turn } = evidenceTurn();
    const implementer = identityFor(turn, { party: 'implementer' });
    const reviewer = identityFor(turn, { party: 'reviewer' });

    const first = await dispatchDisputeSubTurn({
      turn,
      context: ctx,
      identity: implementer,
      runner: recordingRunner(collected({ [LINEAGE_A]: 2 })),
    });
    // Nothing the first run did may stop the second: the block is byte-identical
    // to the one the turn was selected from.
    expect(first.result.context[REVIEW_DISPUTE_CONTEXT_KEY]).toBeUndefined();

    const runner = recordingRunner(collected({ [LINEAGE_A]: 1 }));
    const second = await dispatchDisputeSubTurn({
      turn,
      context: ctx,
      identity: reviewer,
      runner,
      evidenceRound: first.evidenceRound,
    });

    // The second party's run was dispatched — the bug this guards against is a
    // first run that advanced the lineage and left the second nothing to answer.
    expect(runner.calls).toHaveLength(1);
    expect(second.disposition).toBe('applied');
    expect(second.transition.applied[0]).toMatchObject({
      row: 22,
      fromState: 'evidence_requested',
      toState: 'arbitration_pending',
      actor: 'runner',
    });
    expect(second.transition.context.lineages[LINEAGE_A].counters.evidenceRoundsUsed).toBe(1);
    // Both parties' attachments are on the row, and both runs are on the record.
    expect(second.result.context[REVIEW_DISPUTE_SUB_TURN_CONTEXT_KEY].evidenceRound).toMatchObject({
      closing: LINEAGE_A,
      attachmentsRecorded: 3,
    });
    expect(second.evidenceRound.lineages[LINEAGE_A]).toMatchObject({
      parties: {
        implementer: { runId: implementer.runId, attachments: 2 },
        reviewer: { runId: reviewer.runId, attachments: 1 },
      },
      // Spent, and by which run: a redelivery re-derives the same row, a later
      // round starts from an empty record.
      recordedRunId: reviewer.runId,
    });
  });

  test('a round covering several lineages closes them one completion at a time', async () => {
    const ctx = context({
      [LINEAGE_A]: lineage(LINEAGE_A, 'evidence_requested'),
      [LINEAGE_B]: lineage(LINEAGE_B, 'evidence_requested'),
    });
    const turn = select(ctx);
    expect([...turn.lineageIds].sort()).toEqual([LINEAGE_A, LINEAGE_B]);

    const first = await dispatchDisputeSubTurn({
      turn,
      context: ctx,
      identity: identityFor(turn, { party: 'implementer' }),
      // Only one lineage is mentioned: §7.1 allows a run to admit none for the
      // other, and it is still an answer for both.
      runner: recordingRunner(collected({ [LINEAGE_A]: 2 })),
    });
    expect(first.disposition).toBe('collected');
    expect(first.evidenceRound.lineages[LINEAGE_B].parties.implementer.attachments).toBe(0);

    const second = await dispatchDisputeSubTurn({
      turn,
      context: ctx,
      identity: identityFor(turn, { party: 'reviewer' }),
      runner: recordingRunner(collected({ [LINEAGE_B]: 1 })),
      evidenceRound: first.evidenceRound,
    });
    // One application per completion, because the runner folds exactly one into
    // the transaction it commits. The other complete lineage keeps its record and
    // its state, and closes on the next dispatch.
    expect(second.transition.applied).toHaveLength(1);
    expect(second.transition.applied[0].lineageId).toBe(LINEAGE_A);
    expect(second.transition.context.lineages[LINEAGE_B].state).toBe('evidence_requested');
    expect(second.result.context[REVIEW_DISPUTE_SUB_TURN_CONTEXT_KEY].evidenceRound).toMatchObject({
      closing: LINEAGE_A,
      deferred: [LINEAGE_B],
    });
    expect(second.evidenceRound.lineages[LINEAGE_B].recordedRunId).toBeUndefined();
  });

  test('a record collected against a version the lineage has left is replaced, not completed', async () => {
    const { ctx, turn } = evidenceTurn();
    const completion = await dispatchDisputeSubTurn({
      turn,
      context: ctx,
      identity: identityFor(turn),
      runner: recordingRunner(collected()),
      // The finding was revised under the round: what the other party collected
      // was about a version this lineage no longer carries.
      evidenceRound: roundWith('implementer', { version: 2 }),
    });
    expect(completion.disposition).toBe('collected');
    expect(completion.transition).toBeNull();
    expect(completion.evidenceRound.lineages[LINEAGE_A]).toMatchObject({
      version: 1,
      parties: { reviewer: { attachments: 2 } },
    });
    expect(completion.evidenceRound.lineages[LINEAGE_A].parties.implementer).toBeUndefined();
  });

  test('a spent round never closes a later one on its predecessor\'s parties', async () => {
    const { ctx, turn } = evidenceTurn();
    const completion = await dispatchDisputeSubTurn({
      turn,
      context: ctx,
      identity: identityFor(turn),
      runner: recordingRunner(collected()),
      // Both parties on file, but the round was already closed by another run:
      // this is a NEW round for the same lineage, not the end of the old one.
      evidenceRound: {
        lineages: {
          [LINEAGE_A]: {
            version: 1,
            parties: {
              implementer: { runId: 'run-old~evidence.implementer.0', attempt: 0, attachments: 1 },
              reviewer: { runId: 'run-old~evidence.reviewer.0', attempt: 0, attachments: 1 },
            },
            recordedRunId: 'run-old~evidence.reviewer.0',
          },
        },
      },
    });
    expect(completion.disposition).toBe('collected');
    expect(completion.transition).toBeNull();
    expect(completion.evidenceRound.lineages[LINEAGE_A].parties.implementer).toBeUndefined();
    expect(completion.evidenceRound.lineages[LINEAGE_A].recordedRunId).toBeUndefined();
  });

  test('attachments for a lineage the turn does not cover are malformed output', async () => {
    const { ctx, turn } = evidenceTurn();
    const handed = roundWith('implementer');
    const identity = identityFor(turn);
    const completion = await dispatchDisputeSubTurn({
      turn,
      context: ctx,
      identity,
      runner: recordingRunner(collected({ [LINEAGE_A]: 1, [LINEAGE_B]: 3 })),
      evidenceRound: handed,
    });
    expect(completion.disposition).toBe('parked');
    expect(completion.failure).toMatchObject({
      kind: 'malformed_output',
      detail: `attachments.${LINEAGE_B}:unknown`,
    });
    expect(completion.transition).toBeNull();
    // A delivered collection the adapter could not admit is still a run that
    // happened (#963): the answered record survives and the invoked party's
    // stop is marked recoverable rather than left as `not_started`.
    expect(completion.evidenceRound.lineages[LINEAGE_A].parties.implementer)
      .toEqual(handed.lineages[LINEAGE_A].parties.implementer);
    expect(completion.evidenceRound.lineages[LINEAGE_A].parties.reviewer).toEqual({
      runId: identity.runId,
      attempt: 0,
      attachments: 0,
      status: 'recoverable',
      reason: 'malformed_output',
    });
  });

  test.each([
    ['a fractional count', { [LINEAGE_A]: 1.5 }],
    ['a negative count', { [LINEAGE_A]: -1 }],
    ['a count that is not a number', { [LINEAGE_A]: 'two' }],
  ])('%s is malformed output rather than a round this adapter guesses at', async (_label, attachments) => {
    const { ctx, turn } = evidenceTurn();
    const identity = identityFor(turn);
    const completion = await dispatchDisputeSubTurn({
      turn,
      context: ctx,
      identity,
      runner: recordingRunner(collected(attachments)),
      evidenceRound: roundWith('implementer'),
    });
    expect(completion.failure).toMatchObject({
      kind: 'malformed_output',
      detail: `attachments.${LINEAGE_A}:invalid`,
    });
    expect(completion.transition).toBeNull();
    // The inadmissible delivery still marks the invoked party's stop (#963).
    expect(completion.evidenceRound.lineages[LINEAGE_A].parties.reviewer).toMatchObject({
      runId: identity.runId,
      status: 'recoverable',
      reason: 'malformed_output',
    });
  });

  test('a round record that cannot be admitted fails closed before the implementation runs', async () => {
    const { ctx, turn } = evidenceTurn();
    const runner = recordingRunner(collected());
    const completion = await dispatchDisputeSubTurn({
      turn,
      context: ctx,
      identity: identityFor(turn),
      runner,
      // A party token this protocol has no run for: the adapter cannot tell who
      // has answered, and guessing either way is worse than not running.
      evidenceRound: {
        lineages: { [LINEAGE_A]: { version: 1, parties: { arbiter: { runId: 'r', attempt: 0, attachments: 1 } } } },
      },
    });
    expect(runner.calls).toHaveLength(0);
    expect(completion.disposition).toBe('parked');
    expect(completion.failure).toMatchObject({ kind: 'invalid_context' });
    expect(completion.failure.protocol.reason).toBe('unknown-enum');
  });

  test('a failed party run keeps the answered record and marks its own stop recoverable', async () => {
    const { ctx, turn } = evidenceTurn();
    const handed = roundWith('implementer');
    const identity = identityFor(turn);
    const completion = await dispatchDisputeSubTurn({
      turn,
      context: ctx,
      identity,
      runner: recordingRunner({ status: 'failed', failure: { kind: 'timeout', detail: 'ms:600000' } }),
      evidenceRound: handed,
    });
    expect(completion.disposition).toBe('parked');
    // The party that already answered must not have to answer again because the
    // other side timed out: its record survives byte for byte.
    expect(completion.evidenceRound.lineages[LINEAGE_A].parties.implementer)
      .toEqual(handed.lineages[LINEAGE_A].parties.implementer);
    // The failed party's stop is recorded as `recoverable` (#963, #956): not an
    // answer — the round stays incomplete and the party stays owed a run — but a
    // resumed phase can tell "never ran" from "ran and stopped", and why.
    expect(completion.evidenceRound.lineages[LINEAGE_A].parties.reviewer).toEqual({
      runId: identity.runId,
      attempt: 0,
      attachments: 0,
      status: 'recoverable',
      reason: 'timeout',
    });
    expect(disputeEvidenceRoundComplete(completion.evidenceRound.lineages[LINEAGE_A])).toBe(false);
    expect(completion.result.context[REVIEW_DISPUTE_EVIDENCE_ROUND_CONTEXT_KEY]).toEqual(completion.evidenceRound);
  });

  test('the round record round-trips through task context', () => {
    const state = roundWith('implementer', { attachments: 3 });
    const parsed = parseDisputeEvidenceRoundState(JSON.parse(JSON.stringify(state)));
    expect(parsed.ok).toBe(true);
    expect(parsed.value).toEqual(state);
    // Absent is an empty round, not a refusal: a task that has collected nothing
    // carries no record.
    expect(readDisputeEvidenceRoundState(undefined)).toEqual({ ok: true, value: { lineages: {} } });
    expect(readDisputeEvidenceRoundState({ other: 1 })).toEqual({ ok: true, value: { lineages: {} } });
    expect(readDisputeEvidenceRoundState({ [REVIEW_DISPUTE_EVIDENCE_ROUND_CONTEXT_KEY]: state }))
      .toEqual({ ok: true, value: state });
    expect(parseDisputeEvidenceRoundState({ lineages: [] }).ok).toBe(false);
    expect(parseDisputeEvidenceRoundState({ lineages: { [LINEAGE_A]: { version: 0, parties: {} } } }).ok).toBe(false);
  });

  test('`collected` is a disposition this adapter defines', () => {
    expect(DISPUTE_SUB_TURN_DISPOSITIONS).toContain('collected');
  });
});

describe('dispatch — what a completed party admitted is recorded, not just counted (#956)', () => {
  const FILE_REF = { kind: 'file', path: BOUNDARY, startLine: 10, endLine: 20 };
  const QUOTE_REF = { kind: 'issue_quote', quote: 'the handler must reject an expired token' };

  test('the admitted references and dropped counts land on the party record', async () => {
    const { ctx, turn } = evidenceTurn();
    const identity = identityFor(turn, { party: 'implementer' });
    const completion = await dispatchDisputeSubTurn({
      turn,
      context: ctx,
      identity,
      runner: recordingRunner({
        status: 'collected',
        attachments: { [LINEAGE_A]: 2 },
        references: { [LINEAGE_A]: [FILE_REF, QUOTE_REF] },
        dropped: { [LINEAGE_A]: 1 },
        // Named the way this protocol mints an evidence artifact name, so it is
        // attributable to THIS party's run for THIS lineage.
        artifacts: [
          { name: evidenceArtifactName('implementer', LINEAGE_A), content: '{"raw":"bytes that must not travel"}' },
          // A file belonging to something else: it is still written by the
          // caller, and it is still not this lineage's evidence record.
          { name: 'reconsideration-raw-' + LINEAGE_A + '.txt', content: 'not ours' },
        ],
      }),
    });

    expect(completion.disposition).toBe('collected');
    const run = completion.evidenceRound.lineages[LINEAGE_A].parties.implementer;
    expect(run).toMatchObject({ attachments: 2, dropped: 1 });
    // The quoted span is persisted as a digest and a length; the span itself
    // stays in the §10.2 artifact.
    expect(run.references).toEqual([
      FILE_REF,
      { kind: 'issue_quote', quoteDigest: expect.stringMatching(/^[0-9a-f]{12}$/), quoteChars: QUOTE_REF.quote.length },
    ]);
    expect(run.artifacts).toEqual([
      {
        name: evidenceArtifactName('implementer', LINEAGE_A),
        digest: expect.stringMatching(/^[0-9a-f]{12}$/),
        bytes: expect.any(Number),
      },
    ]);

    // Neither the artifact's bytes nor the quoted span reach task context or the
    // one audit event this dispatch appends.
    const serialized = JSON.stringify(completion.result.context) + JSON.stringify(completion.result.extraEvents);
    expect(serialized).not.toContain('bytes that must not travel');
    expect(serialized).not.toContain('expired token');
    expect(completion.result.context[REVIEW_DISPUTE_SUB_TURN_CONTEXT_KEY].evidenceRound).toMatchObject({
      attachments: 2,
      references: 2,
      dropped: 1,
    });
  });

  test('detail for a lineage the turn does not cover is §12 malformed output', async () => {
    const { ctx, turn } = evidenceTurn();
    for (const overrides of [
      { references: { [LINEAGE_B]: [FILE_REF] } },
      { dropped: { [LINEAGE_B]: 1 } },
      // A list that disagrees with the count it accompanies: the record cannot
      // resolve it without inventing evidence or discarding it.
      { attachments: { [LINEAGE_A]: 2 }, references: { [LINEAGE_A]: [FILE_REF] } },
      // An attachment count past the ceiling a §2.1 record's own evidence carries.
      { attachments: { [LINEAGE_A]: 99 } },
    ]) {
      const runner = recordingRunner({ status: 'collected', attachments: { [LINEAGE_A]: 1 }, ...overrides });
      const completion = await dispatchDisputeSubTurn({
        turn,
        context: ctx,
        identity: identityFor(turn),
        runner,
        evidenceRound: roundWith('implementer'),
      });
      expect(completion.disposition).toBe('parked');
      expect(completion.failure.kind).toBe('malformed_output');
      // Nothing moved, and the party that already answered keeps its record.
      expect(completion.transition).toBeNull();
      expect(completion.evidenceRound.lineages[LINEAGE_A].parties.implementer.attachments).toBe(1);
      // The invoked party's inadmissible delivery is a run that happened: its
      // stop is marked recoverable, not left as `not_started` (#963).
      expect(completion.evidenceRound.lineages[LINEAGE_A].parties.reviewer).toMatchObject({
        status: 'recoverable',
        reason: 'malformed_output',
      });
    }
  });

  test('the row-22 audit record says what the round was built from', async () => {
    const { ctx, turn } = evidenceTurn();
    const implementer = identityFor(turn, { party: 'implementer' });
    const first = await dispatchDisputeSubTurn({
      turn,
      context: ctx,
      identity: implementer,
      runner: recordingRunner({
        status: 'collected',
        attachments: { [LINEAGE_A]: 1 },
        references: { [LINEAGE_A]: [FILE_REF] },
      }),
    });
    const second = await dispatchDisputeSubTurn({
      turn,
      context: ctx,
      identity: identityFor(turn),
      runner: recordingRunner(collected({ [LINEAGE_A]: 0 })),
      evidenceRound: first.evidenceRound,
    });

    expect(second.disposition).toBe('applied');
    expect(second.result.context[REVIEW_DISPUTE_SUB_TURN_CONTEXT_KEY].evidenceRound.record).toEqual({
      version: 1,
      round: 1,
      complete: true,
      // The snapshot is the round row 22 was BUILT from: the record is marked
      // spent only once the transition is applied, and a decision the block
      // refuses must not leave an audit record claiming it landed.
      recorded: false,
      attachmentsRecorded: 1,
      parties: {
        implementer: { state: 'completed', attempt: 0, attachments: 1, references: 1 },
        reviewer: { state: 'completed', attempt: 0, attachments: 0 },
      },
    });
    // And the committed record IS spent, keyed on the run that spent it.
    expect(second.evidenceRound.lineages[LINEAGE_A].recordedRunId).toBe(second.identity.runId);
    // Counts and states; never the reference the round admitted.
    expect(JSON.stringify(second.result.extraEvents)).not.toContain(BOUNDARY);
  });

  test('a party still running is not an answer, so row 22 does not fire on it', async () => {
    const { ctx, turn } = evidenceTurn();
    const runner = recordingRunner(collected({ [LINEAGE_A]: 1 }));
    const completion = await dispatchDisputeSubTurn({
      turn,
      context: ctx,
      identity: identityFor(turn),
      runner,
      // The other party has a record — and it is a run that never delivered.
      evidenceRound: {
        lineages: {
          [LINEAGE_A]: {
            version: 1,
            parties: {
              implementer: { runId: `${RUN_ID}~evidence.implementer.0`, attempt: 0, attachments: 0, status: 'running' },
            },
          },
        },
      },
    });
    expect(runner.calls).toHaveLength(1);
    expect(completion.disposition).toBe('collected');
    expect(completion.transition).toBeNull();
    expect(completion.evidenceRound.lineages[LINEAGE_A].parties.implementer.status).toBe('running');
  });
});

describe('dispatch — a collection already on the record is never collected twice (#951)', () => {
  test('a redelivered party run replays its record instead of running again', async () => {
    const { ctx, turn } = evidenceTurn();
    const identity = identityFor(turn, { party: 'implementer' });
    const first = await dispatchDisputeSubTurn({
      turn,
      context: ctx,
      identity,
      runner: recordingRunner(collected({ [LINEAGE_A]: 2 })),
    });

    // The same claim, redelivered before the other party answered: nothing moved,
    // so the block is the one the turn was selected from and the identity is
    // byte-identical — which is exactly what makes this a duplicate and not a
    // second debate.
    const runner = recordingRunner(collected({ [LINEAGE_A]: 5 }));
    const again = await dispatchDisputeSubTurn({
      turn,
      context: ctx,
      identity,
      runner,
      evidenceRound: first.evidenceRound,
    });

    // No second invocation: re-running the party would duplicate its work and
    // artifacts, and its new counts would overwrite the evidence row 22 records.
    expect(runner.calls).toHaveLength(0);
    expect(again.disposition).toBe('collected');
    expect(again.transition).toBeNull();
    expect(again.evidenceRound).toEqual(first.evidenceRound);
    expect(again.evidenceRound.lineages[LINEAGE_A].parties.implementer.attachments).toBe(2);
    expect(again.result.context[REVIEW_DISPUTE_SUB_TURN_CONTEXT_KEY].evidenceRound).toMatchObject({
      attachments: 2,
      replayedCollection: 'party_redelivery',
    });
  });

  test('a genuinely new attempt is not mistaken for a redelivery', async () => {
    const { ctx, turn } = evidenceTurn();
    const first = await dispatchDisputeSubTurn({
      turn,
      context: ctx,
      identity: identityFor(turn, { party: 'implementer' }),
      runner: recordingRunner(collected({ [LINEAGE_A]: 2 })),
    });

    // #840's escape hatch: a re-run that must NOT read as a replay bumps the
    // attempt, and the derived run id — the whole basis of this recognition —
    // differs, so the implementation runs and its answer replaces the old one.
    const runner = recordingRunner(collected({ [LINEAGE_A]: 5 }));
    const retried = await dispatchDisputeSubTurn({
      turn,
      context: ctx,
      identity: identityFor(turn, { party: 'implementer', attempt: 1 }),
      runner,
      evidenceRound: first.evidenceRound,
    });
    expect(runner.calls).toHaveLength(1);
    expect(retried.evidenceRound.lineages[LINEAGE_A].parties.implementer).toMatchObject({
      attempt: 1,
      attachments: 5,
    });
  });

  test('a deferred lineage whose round is already complete closes without re-collecting', async () => {
    const ctx = context({
      [LINEAGE_A]: lineage(LINEAGE_A, 'evidence_requested'),
      [LINEAGE_B]: lineage(LINEAGE_B, 'evidence_requested'),
    });
    const turn = select(ctx);

    const first = await dispatchDisputeSubTurn({
      turn,
      context: ctx,
      identity: identityFor(turn, { party: 'implementer' }),
      runner: recordingRunner(collected({ [LINEAGE_A]: 2, [LINEAGE_B]: 3 })),
    });
    const second = await dispatchDisputeSubTurn({
      turn,
      context: ctx,
      identity: identityFor(turn, { party: 'reviewer' }),
      runner: recordingRunner(collected({ [LINEAGE_A]: 1, [LINEAGE_B]: 4 })),
      evidenceRound: first.evidenceRound,
    });
    // Both lineages are complete, one row 22 per completion: LINEAGE_B keeps a
    // COMPLETE record and its `evidence_requested` state.
    expect(second.transition.applied[0].lineageId).toBe(LINEAGE_A);
    expect(second.result.context[REVIEW_DISPUTE_SUB_TURN_CONTEXT_KEY].evidenceRound.deferred).toEqual([LINEAGE_B]);

    // The next selection sees only the lineage row 22 has not closed yet, under a
    // new claim — so every identity derived from it is a different one, and the
    // naive reading would dispatch a party run whose answer is already on file.
    const deferred = context({ [LINEAGE_B]: lineage(LINEAGE_B, 'evidence_requested') });
    const deferredTurn = select(deferred);
    expect(deferredTurn.lineageIds).toEqual([LINEAGE_B]);
    const identity = identityFor(deferredTurn, { runId: 'run-review-2', party: 'implementer' });
    const runner = recordingRunner(collected({ [LINEAGE_B]: 99 }));
    const drained = await dispatchDisputeSubTurn({
      turn: deferredTurn,
      context: deferred,
      identity,
      runner,
      evidenceRound: second.evidenceRound,
    });

    expect(runner.calls).toHaveLength(0);
    expect(drained.disposition).toBe('applied');
    expect(drained.transition.applied[0]).toMatchObject({
      row: 22,
      lineageId: LINEAGE_B,
      fromState: 'evidence_requested',
      toState: 'arbitration_pending',
      actor: 'runner',
    });
    // Row 22 records what the two parties actually collected — 3 and 4 — not what
    // a re-dispatched party would have collected instead.
    expect(drained.result.context[REVIEW_DISPUTE_SUB_TURN_CONTEXT_KEY].evidenceRound).toMatchObject({
      closing: LINEAGE_B,
      attachmentsRecorded: 7,
      replayedCollection: 'round_complete',
    });
    expect(drained.evidenceRound.lineages[LINEAGE_B].parties)
      .toEqual(second.evidenceRound.lineages[LINEAGE_B].parties);
    expect(drained.evidenceRound.lineages[LINEAGE_B].recordedRunId).toBe(identity.runId);
  });
});

describe('dispatch — a round resumes from the missing party, exactly once per party (#963)', () => {
  test('a party completed under a lost claim is reused, never re-invoked or overwritten', async () => {
    const { ctx, turn } = evidenceTurn();
    const first = await dispatchDisputeSubTurn({
      turn,
      context: ctx,
      identity: identityFor(turn, { party: 'implementer' }),
      runner: recordingRunner(collected({ [LINEAGE_A]: 2 })),
    });
    const recorded = first.evidenceRound.lineages[LINEAGE_A].parties.implementer;

    // The claim was lost and the task re-claimed: every identity derived from
    // the new claim differs, but the round identity — lineage, version, round —
    // does not, and the implementer already answered it.
    const runner = recordingRunner(collected({ [LINEAGE_A]: 9 }));
    const resumed = await dispatchDisputeSubTurn({
      turn,
      context: ctx,
      identity: identityFor(turn, { runId: 'run-review-2', party: 'implementer' }),
      runner,
      evidenceRound: first.evidenceRound,
    });

    expect(runner.calls).toHaveLength(0);
    expect(resumed.disposition).toBe('collected');
    expect(resumed.transition).toBeNull();
    // The admitted result stands byte for byte — same counts, same recording
    // run id — so the retry changed nothing row 22 will record.
    expect(resumed.evidenceRound.lineages[LINEAGE_A].parties.implementer).toEqual(recorded);
    expect(resumed.result.context[REVIEW_DISPUTE_SUB_TURN_CONTEXT_KEY].evidenceRound).toMatchObject({
      attachments: 2,
      replayedCollection: 'party_admitted',
    });
  });

  test('a partial round resumes from the missing party and closes on both answers', async () => {
    const { ctx, turn } = evidenceTurn();
    const first = await dispatchDisputeSubTurn({
      turn,
      context: ctx,
      identity: identityFor(turn, { party: 'implementer' }),
      runner: recordingRunner(collected({ [LINEAGE_A]: 2 })),
    });

    // Restart under a fresh claim: only the reviewer is owed a run, and its
    // collection joins the implementer's persisted answer to close the round.
    const runner = recordingRunner(collected({ [LINEAGE_A]: 3 }));
    const closed = await dispatchDisputeSubTurn({
      turn,
      context: ctx,
      identity: identityFor(turn, { runId: 'run-review-2', party: 'reviewer' }),
      runner,
      evidenceRound: first.evidenceRound,
    });

    expect(runner.calls).toHaveLength(1);
    expect(closed.disposition).toBe('applied');
    expect(closed.transition.applied[0]).toMatchObject({
      row: 22,
      lineageId: LINEAGE_A,
      fromState: 'evidence_requested',
      toState: 'arbitration_pending',
    });
    // Row 22 records what the two parties actually collected — across the two
    // claims — not what a re-dispatched implementer would have collected instead.
    expect(closed.result.context[REVIEW_DISPUTE_SUB_TURN_CONTEXT_KEY].evidenceRound.attachmentsRecorded).toBe(5);
  });

  test('a partially admitted multi-lineage delivery never lets the retry overwrite the admitted answer', async () => {
    const FILE_REF = { kind: 'file', path: BOUNDARY, startLine: 10, endLine: 20 };
    const { ctx, turn } = evidenceTurn(context({
      [LINEAGE_A]: lineage(LINEAGE_A, 'evidence_requested'),
      [LINEAGE_B]: lineage(LINEAGE_B, 'evidence_requested'),
    }));

    // One delivery covering two lineages: A's answer is admissible, B's list
    // disagrees with its count, which the RECORD refuses after A was already
    // admitted — the one order that leaves a partial admission behind.
    const first = await dispatchDisputeSubTurn({
      turn,
      context: ctx,
      identity: identityFor(turn, { party: 'implementer' }),
      runner: recordingRunner({
        status: 'collected',
        attachments: { [LINEAGE_A]: 1, [LINEAGE_B]: 2 },
        references: { [LINEAGE_A]: [FILE_REF], [LINEAGE_B]: [FILE_REF] },
      }),
    });
    expect(first.disposition).toBe('parked');
    expect(first.failure.kind).toBe('malformed_output');
    const recorded = first.evidenceRound.lineages[LINEAGE_A].parties.implementer;
    expect(recorded).toMatchObject({ attachments: 1 });
    expect(first.evidenceRound.lineages[LINEAGE_B].parties.implementer).toMatchObject({
      status: 'recoverable',
      reason: 'malformed_output',
    });

    // The retry runs the party for the whole bundle (§7.1 dispatches a party as
    // a whole) and answers BOTH lineages differently; only the lineage still
    // owed an answer takes the new one.
    const runner = recordingRunner(collected({ [LINEAGE_A]: 9, [LINEAGE_B]: 3 }));
    const resumed = await dispatchDisputeSubTurn({
      turn,
      context: ctx,
      identity: identityFor(turn, { runId: 'run-review-2', party: 'implementer' }),
      runner,
      evidenceRound: first.evidenceRound,
    });

    expect(runner.calls).toHaveLength(1);
    expect(resumed.disposition).toBe('collected');
    expect(resumed.transition).toBeNull();
    // A's admitted answer stands byte for byte — the retry's fresh output for
    // it is discarded — while B's is admitted from the retry.
    expect(resumed.evidenceRound.lineages[LINEAGE_A].parties.implementer).toEqual(recorded);
    expect(resumed.evidenceRound.lineages[LINEAGE_B].parties.implementer).toMatchObject({ attachments: 3 });
    expect(resumed.result.context[REVIEW_DISPUTE_SUB_TURN_CONTEXT_KEY].evidenceRound).toMatchObject({
      attachments: 4,
      reused: [LINEAGE_A],
    });
  });

  test('a deliberately bumped attempt still runs, and its failure downgrades nothing', async () => {
    const { ctx, turn } = evidenceTurn();
    const first = await dispatchDisputeSubTurn({
      turn,
      context: ctx,
      identity: identityFor(turn, { party: 'implementer' }),
      runner: recordingRunner(collected({ [LINEAGE_A]: 2 })),
    });
    const recorded = first.evidenceRound.lineages[LINEAGE_A].parties.implementer;

    // #840's escape hatch asks for a fresh run over the admitted answer — and
    // the fresh run fails. The admitted answer must survive: a completed record
    // is never overwritten by a recoverable marker.
    const runner = recordingRunner({ status: 'failed', failure: { kind: 'invocation_failed', detail: 'exit:1' } });
    const retried = await dispatchDisputeSubTurn({
      turn,
      context: ctx,
      identity: identityFor(turn, { party: 'implementer', attempt: 1 }),
      runner,
      evidenceRound: first.evidenceRound,
    });

    expect(runner.calls).toHaveLength(1);
    expect(retried.disposition).toBe('parked');
    expect(retried.evidenceRound.lineages[LINEAGE_A].parties.implementer).toEqual(recorded);
  });

  test('a delayed party run records its stop, and the retry is not read as a duplicate', async () => {
    const { ctx, turn } = evidenceTurn();
    const identity = identityFor(turn);
    const delayed = await dispatchDisputeSubTurn({
      turn,
      context: ctx,
      identity,
      runner: recordingRunner({ status: 'delayed', failure: { kind: 'invocation_failed', detail: 'quota' } }),
      evidenceRound: roundWith('implementer'),
    });
    expect(delayed.disposition).toBe('delayed');
    expect(delayed.evidenceRound.lineages[LINEAGE_A].parties.reviewer).toEqual({
      runId: identity.runId,
      attempt: 0,
      attachments: 0,
      status: 'recoverable',
      reason: 'invocation_failed',
    });

    // The retry after the delay: a recoverable record is an invocation fact,
    // not an answer, so the party runs — and its delivered answer replaces the
    // stop marker.
    const runner = recordingRunner(collected({ [LINEAGE_A]: 3 }));
    const retried = await dispatchDisputeSubTurn({
      turn,
      context: ctx,
      identity,
      runner,
      evidenceRound: delayed.evidenceRound,
    });
    expect(runner.calls).toHaveLength(1);
    expect(retried.disposition).toBe('applied');
    expect(retried.evidenceRound.lineages[LINEAGE_A].parties.reviewer).toMatchObject({ attachments: 3 });
    expect(retried.evidenceRound.lineages[LINEAGE_A].parties.reviewer.status).toBeUndefined();
  });

  test('a materially revised finding starts a distinct round instead of reusing stale evidence', async () => {
    // The finding is at version 2 now; the round record still carries what BOTH
    // parties collected against version 1. Nothing of it is an answer to the
    // revised finding — not even the party being re-dispatched — so the run
    // happens and the stale record is replaced under the new round identity.
    const revised = context({ [LINEAGE_A]: { ...lineage(LINEAGE_A, 'evidence_requested'), version: 2, rebuttedVersions: [1, 2], counters: { ...ZERO_LINEAGE_COUNTERS, rebuttals: 2, reconsiderations: 1, arbitrationPasses: 1 } } });
    const turn = select(revised);
    const stale = {
      lineages: {
        [LINEAGE_A]: {
          version: 1,
          parties: {
            implementer: { runId: 'old~evidence.implementer.0', attempt: 0, attachments: 2 },
            reviewer: { runId: 'old~evidence.reviewer.0', attempt: 0, attachments: 3 },
          },
        },
      },
    };
    const runner = recordingRunner(collected({ [LINEAGE_A]: 1 }));
    const completion = await dispatchDisputeSubTurn({
      turn,
      context: revised,
      identity: identityFor(turn, { party: 'implementer' }),
      runner,
      evidenceRound: stale,
    });
    expect(runner.calls).toHaveLength(1);
    expect(completion.disposition).toBe('collected');
    expect(completion.evidenceRound.lineages[LINEAGE_A]).toMatchObject({ version: 2 });
    expect(completion.evidenceRound.lineages[LINEAGE_A].parties.implementer).toMatchObject({ attachments: 1 });
    // The version-1 reviewer answer describes prose the debate has replaced: it
    // is dropped with the round it belonged to, never carried into the new one.
    expect(completion.evidenceRound.lineages[LINEAGE_A].parties.reviewer).toBeUndefined();
  });
});

describe('dispatch — the §10.1 block is the adapter\'s, never the implementation\'s (#951)', () => {
  /**
   * An implementation's own context patch, carrying the three keys this protocol
   * owns. Reaching them is not hypothetical: an implementation that rebuilt the
   * block it was handed would write exactly this.
   */
  const FORGED = {
    [REVIEW_DISPUTE_CONTEXT_KEY]: { version: 1, reviewStructure: 'structured', lineages: {} },
    [REVIEW_DISPUTE_EVIDENCE_ROUND_CONTEXT_KEY]: { lineages: {} },
    [REVIEW_DISPUTE_SUB_TURN_CONTEXT_KEY]: { disposition: 'applied' },
    ownField: 'kept',
  };

  test.each([
    ['a failed run', { status: 'failed', failure: { kind: 'timeout', detail: null } }, 'parked'],
    ['a delayed run', { status: 'delayed', failure: { kind: 'invocation_failed', detail: null } }, 'delayed'],
    ['a first party\'s evidence run', collected(), 'collected'],
  ])('%s cannot persist a block it did not transition', async (_label, result, disposition) => {
    const { ctx, turn } = evidenceTurn();
    const completion = await dispatchDisputeSubTurn({
      turn,
      context: ctx,
      identity: identityFor(turn),
      runner: recordingRunner({ ...result, context: { ...FORGED } }),
    });

    expect(completion.disposition).toBe(disposition);
    // These paths all promise the debate state is unchanged, and none of them
    // carries a transition the implementation could rebuild the block from — so
    // the forged block must simply not be in the patch. A first party's
    // completion does carry issue #964's routing-only continuation, but that is
    // built HERE from the validated block, never from the implementation's
    // context patch: nothing applied, and the forged empty lineage set nowhere
    // in it.
    if (disposition === 'collected') {
      expect(completion.result.disputeTransition).toMatchObject({
        replayed: true,
        unchanged: true,
        applied: [],
      });
      expect(completion.result.disputeTransition.context.lineages[LINEAGE_A].state).toBe('evidence_requested');
    } else {
      expect(completion.result.disputeTransition).toBeUndefined();
    }
    expect(completion.result.context[REVIEW_DISPUTE_CONTEXT_KEY]).toBeUndefined();
    // The summary and the round record are this dispatch's own account of itself.
    expect(completion.result.context[REVIEW_DISPUTE_SUB_TURN_CONTEXT_KEY].disposition).toBe(disposition);
    expect(completion.result.context[REVIEW_DISPUTE_EVIDENCE_ROUND_CONTEXT_KEY]).toEqual(completion.evidenceRound);
    // Everything the implementation legitimately owns still travels.
    expect(completion.result.context.ownField).toBe('kept');
  });

  test('a completed decision writes its block from the transition alone', async () => {
    const { ctx, turn } = reviewerTurn();
    const completion = await dispatchDisputeSubTurn({
      turn,
      context: ctx,
      identity: identityFor(turn),
      runner: recordingRunner({ ...upheld(ctx), context: { ...FORGED } }),
    });

    expect(completion.disposition).toBe('applied');
    expect(completion.result.context[REVIEW_DISPUTE_CONTEXT_KEY]).toBeUndefined();
    // A turn with no round writes no round record either, forged or otherwise.
    expect(completion.result.context[REVIEW_DISPUTE_EVIDENCE_ROUND_CONTEXT_KEY]).toBeUndefined();
    expect(completion.result.context.ownField).toBe('kept');
    // The one place the block may come from: the application the runner commits.
    expect(completion.result.disputeTransition.context.lineages[LINEAGE_A].state).not.toBe('disputed');
  });
});

describe('dispatch — failures and delays move nothing (#951)', () => {
  const NORMALIZED = ['timeout', 'malformed_output', 'profile_unavailable', 'invocation_failed', 'artifact_failed'];

  test('every failure kind is a token this adapter defines', () => {
    for (const kind of NORMALIZED) expect(DISPUTE_SUB_TURN_FAILURE_KINDS).toContain(kind);
  });

  test.each(NORMALIZED)('a %s failure parks with no transition and no lost artifacts', async (kind) => {
    const { ctx, turn } = evidenceTurn();
    const identity = identityFor(turn);
    const completion = await dispatchDisputeSubTurn({
      turn,
      context: ctx,
      identity,
      runner: recordingRunner({
        status: 'failed',
        failure: { kind, detail: 'exit:1' },
        artifacts: [{ name: 'raw-output.txt', content: 'transcript' }],
      }),
    });

    expect(completion.disposition).toBe('parked');
    expect(completion.transition).toBeNull();
    expect(completion.result.result).toBe('blocked');
    expect(completion.result.disputeTransition).toBeUndefined();
    expect(completion.failure).toMatchObject({ kind, detail: 'exit:1' });
    // A failed run's transcript is still §10.2 evidence the caller should keep.
    expect(completion.artifacts).toHaveLength(1);
    expect(completion.result.context[REVIEW_DISPUTE_SUB_TURN_CONTEXT_KEY]).toMatchObject({
      disposition: 'parked',
      failure: kind,
      failureDetail: 'exit:1',
    });
    expect(completion.result.extraEvents[0].type).toBe(REVIEW_DISPUTE_SUB_TURN_EVENT);
  });

  test('a delay releases the claim without spending anything', async () => {
    const { ctx, turn } = evidenceTurn();
    const completion = await dispatchDisputeSubTurn({
      turn,
      context: ctx,
      identity: identityFor(turn),
      runner: recordingRunner({
        status: 'delayed',
        failure: { kind: 'invocation_failed', detail: 'quota' },
        retryAfterMs: 60_000,
        category: 'usage_quota',
      }),
    });
    expect(completion.disposition).toBe('delayed');
    expect(completion.transition).toBeNull();
    expect(completion.result).toMatchObject({
      result: 'delayed',
      retryAfterMs: 60_000,
      category: 'usage_quota',
      // The agent-failure reading every sub-turn run implies (issue #897).
      delayKind: 'agent_failure',
    });
    expect(completion.result.disputeTransition).toBeUndefined();
  });

  test('a throwing implementation is a run that did not happen, reported by name only', async () => {
    const { ctx, turn } = evidenceTurn();
    const completion = await dispatchDisputeSubTurn({
      turn,
      context: ctx,
      identity: identityFor(turn),
      runner: async () => {
        throw new TypeError('/Users/someone/secret/path exploded');
      },
    });
    expect(completion.disposition).toBe('parked');
    expect(completion.failure).toEqual({ kind: 'internal_error', detail: 'TypeError' });
    expect(JSON.stringify(completion.result)).not.toContain('secret');
  });
});

describe('dispatch — no implementation text reaches a public surface (#951)', () => {
  // `PhaseHandlerResult.message` is not an internal field: on a `blocked` review
  // completion it is published to GitHub as the handoff comment's `Reason:`. A
  // message an implementation chose would therefore be a publication channel for
  // exactly the rebuttal and rationale prose §11 forbids — and an agent-backed
  // runner's likeliest value for it is its raw response.
  const PROSE = 'Rebuttal: the finding is wrong, see src/app.ts:42 — /Users/someone/run/transcript.txt';

  test.each([
    ['a completed decision', 'reviewer', (ctx) => upheld(ctx), 'applied'],
    ['a first party\'s evidence run', 'evidence', () => collected(), 'collected'],
    ['a failed run', 'evidence', () => ({ status: 'failed', failure: { kind: 'timeout', detail: null } }), 'parked'],
    [
      'a delayed run',
      'evidence',
      () => ({ status: 'delayed', failure: { kind: 'invocation_failed', detail: null } }),
      'delayed',
    ],
  ])('%s cannot choose the text a handoff comment would publish', async (_label, kind, build, disposition) => {
    const { ctx, turn } = kind === 'reviewer' ? reviewerTurn() : evidenceTurn();
    const completion = await dispatchDisputeSubTurn({
      turn,
      context: ctx,
      identity: identityFor(turn),
      runner: recordingRunner({ ...build(ctx), message: PROSE }),
    });

    // Dropped, not refused: a runner compiled against an older shape still runs,
    // it just cannot speak.
    expect(completion.disposition).toBe(disposition);
    expect(completion.result.message).not.toContain('Rebuttal');
    expect(JSON.stringify(completion.result)).not.toContain(PROSE);
    // What travels instead is generated here, from the bounded tokens the summary
    // already publishes.
    expect(completion.result.message).toContain('Review dispute');
  });
});

describe('failure normalization (#951)', () => {
  test('every #838 and #846 invocation-failure token normalizes to a known kind', () => {
    for (const kind of RECONSIDERATION_FAILURE_KINDS) {
      const normalized = normalizeReconsiderationFailure({ kind, detail: null });
      expect(DISPUTE_SUB_TURN_FAILURE_KINDS).toContain(normalized.kind);
    }
    for (const kind of ARBITRATION_FAILURE_KINDS) {
      const normalized = normalizeArbitrationFailure({ kind, detail: null });
      expect(DISPUTE_SUB_TURN_FAILURE_KINDS).toContain(normalized.kind);
    }
    // The tables cover the upstream vocabularies exactly — no token unmapped, no
    // mapping for a token that no longer exists.
    expect(Object.keys(RECONSIDERATION_FAILURE_NORMALIZATION).sort())
      .toEqual([...RECONSIDERATION_FAILURE_KINDS].sort());
    expect(Object.keys(ARBITRATION_FAILURE_NORMALIZATION).sort())
      .toEqual([...ARBITRATION_FAILURE_KINDS].sort());
  });

  test('the routing-relevant groupings are the ones §7.1 acts on', () => {
    expect(normalizeReconsiderationFailure({ kind: 'unsupported-agent', detail: 'claude' }).kind)
      .toBe('profile_unavailable');
    expect(normalizeReconsiderationFailure({ kind: 'lineage-not-disputed', detail: null }).kind)
      .toBe('stale_lineage');
    expect(normalizeArbitrationFailure({ kind: 'arbitration-passes-exhausted', detail: null }).kind)
      .toBe('stale_lineage');
    expect(normalizeArbitrationFailure({ kind: 'profile-lineage-mismatch', detail: null }).kind)
      .toBe('invalid_identity');
  });

  test('a §12 failure travels verbatim and a deadline is told apart from a refusal', () => {
    const protocol = { reason: 'missing-field', detail: 'reconsideration.outcome' };
    const malformed = normalizeReconsiderationFailure({ kind: 'malformed-response', detail: 'field', protocol });
    expect(malformed).toEqual({ kind: 'malformed_output', detail: 'field', protocol });

    const exited = normalizeArbitrationFailure({ kind: 'agent-failed', detail: 'exit:1' });
    expect(exited.kind).toBe('invocation_failed');
    const timedOut = normalizeArbitrationFailure({ kind: 'agent-failed', detail: 'exit:null' }, { timedOut: true });
    expect(timedOut.kind).toBe('timeout');
    // The promotion applies to the run's own failure, never to inadmissible output.
    expect(normalizeArbitrationFailure({ kind: 'empty-output', detail: null }, { timedOut: true }).kind)
      .toBe('malformed_output');
  });
});

const BACKENDS = [
  { name: 'MemoryTaskStore', create: () => ({ store: new MemoryTaskStore(), cleanup: () => {} }) },
  {
    name: 'SqliteTaskStore',
    create: () => {
      const dir = mkdtempSync(join(tmpdir(), 'dispute-dispatch-'));
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

describe.each(BACKENDS)('the completion the runner commits ($name)', ({ create }) => {
  const SESSION = 's';
  const ISSUE = 951;
  const KEY = { sessionId: SESSION, issueNumber: ISSUE };
  const NOW = '2026-08-20T12:00:00.000Z';
  let store;
  let cleanup;

  beforeEach(() => {
    ({ store, cleanup } = create());
  });

  afterEach(() => {
    cleanup();
  });

  const request = { sessionId: SESSION, workerId: 'w', runId: RUN_ID, supportedPhases: ['review'], now: NOW };

  async function enqueue(ctx) {
    await store.enqueueTask({
      sessionId: SESSION,
      issueNumber: ISSUE,
      phase: 'review',
      priority: 'normal',
      context: { [REVIEW_DISPUTE_CONTEXT_KEY]: ctx, reviewFeedback: 'legacy prose stays put' },
      now: '2026-08-20T11:00:00.000Z',
    });
  }

  test('a successful sub-turn commits its block, its routing and both events atomically', async () => {
    const { ctx, turn } = evidenceTurn();
    await enqueue(ctx);
    const completion = await dispatchDisputeSubTurn({
      turn,
      context: ctx,
      identity: identityFor(turn),
      ...closingRound({ runner: recordingRunner({ ...collected(), context: { artifactDir: '/tmp/run-1' } }) }),
    });

    const outcome = await runNextPhase({ store, request, handlers: { review: async () => completion.result } });
    expect(outcome.status).toBe('completed');

    const stored = await store.getTask(KEY);
    // Row 22 landed through the completion the runner was already issuing.
    expect(stored.context[REVIEW_DISPUTE_CONTEXT_KEY].lineages[LINEAGE_A]).toMatchObject({
      state: 'arbitration_pending',
      counters: expect.objectContaining({ evidenceRoundsUsed: 1 }),
    });
    // The handler's own context and the legacy payload are merged, not overwritten.
    expect(stored.context.artifactDir).toBe('/tmp/run-1');
    expect(stored.context.reviewFeedback).toBe('legacy prose stays put');
    expect(stored.context[REVIEW_DISPUTE_SUB_TURN_CONTEXT_KEY].disposition).toBe('applied');
    // The round record lands in the SAME transaction as the block it describes,
    // so a spent round can never be on file without the row that spent it.
    expect(stored.context[REVIEW_DISPUTE_EVIDENCE_ROUND_CONTEXT_KEY].lineages[LINEAGE_A].recordedRunId)
      .toBe(completion.identity.runId);
    // §7.1 rule 2 now names the runner turn, which issue #955 gave a dispatcher:
    // the task is queued back onto `review`, where the arbitration sub-turn runs
    // before any ordinary review work, rather than parking for a human.
    expect(stored.status).toBe('queued');
    expect(stored.phase).toBe('review');
    expect(stored.ownerRunId ?? undefined).toBeUndefined();

    const events = await store.listEvents(KEY);
    const types = events.map((e) => e.type);
    expect(types).toContain('phase.completed');
    expect(types).toContain(REVIEW_DISPUTE_TRANSITION_EVENT);
    expect(types).toContain(REVIEW_DISPUTE_SUB_TURN_EVENT);
    expect(events.find((e) => e.type === REVIEW_DISPUTE_SUB_TURN_EVENT).data).toMatchObject({
      turn: 'evidence_collection',
      disposition: 'applied',
    });
  }, 30_000);

  test('a first evidence party commits its record and not one byte of the block', async () => {
    const { ctx, turn } = evidenceTurn();
    await enqueue(ctx);
    const identity = identityFor(turn, { party: 'implementer' });
    const completion = await dispatchDisputeSubTurn({
      turn,
      context: ctx,
      identity,
      runner: recordingRunner(collected({ [LINEAGE_A]: 2 })),
    });

    await runNextPhase({ store, request, handlers: { review: async () => completion.result } });

    const stored = await store.getTask(KEY);
    // The lineage stays exactly where the round left it, which is the only state
    // the reviewer-side run can be dispatched against.
    expect(stored.context[REVIEW_DISPUTE_CONTEXT_KEY]).toEqual(ctx);
    expect(stored.context[REVIEW_DISPUTE_EVIDENCE_ROUND_CONTEXT_KEY].lineages[LINEAGE_A]).toMatchObject({
      parties: { implementer: { runId: identity.runId, attachments: 2 } },
    });
    expect(stored.context[REVIEW_DISPUTE_EVIDENCE_ROUND_CONTEXT_KEY].lineages[LINEAGE_A].recordedRunId).toBeUndefined();
    const events = await store.listEvents(KEY);
    // No transition happened, so no §10.3 transition event may exist.
    expect(events.map((e) => e.type)).not.toContain(REVIEW_DISPUTE_TRANSITION_EVENT);
    expect(events.find((e) => e.type === REVIEW_DISPUTE_SUB_TURN_EVENT).data.disposition).toBe('collected');
  }, 30_000);

  test('a parked sub-turn commits its audit event and leaves the block untouched', async () => {
    const { ctx, turn } = evidenceTurn();
    await enqueue(ctx);
    const completion = await dispatchDisputeSubTurn({
      turn,
      context: ctx,
      identity: identityFor(turn),
      runner: recordingRunner({ status: 'failed', failure: { kind: 'timeout', detail: 'ms:600000' } }),
    });

    await runNextPhase({ store, request, handlers: { review: async () => completion.result } });

    const stored = await store.getTask(KEY);
    // Not one counter moved, and the lineage is exactly where the debate left it.
    expect(stored.context[REVIEW_DISPUTE_CONTEXT_KEY]).toEqual(ctx);
    expect(stored.status).toBe('ready_for_human');
    const events = await store.listEvents(KEY);
    expect(events.map((e) => e.type)).toContain(REVIEW_DISPUTE_SUB_TURN_EVENT);
    // No transition happened, so no §10.3 transition event may exist.
    expect(events.map((e) => e.type)).not.toContain(REVIEW_DISPUTE_TRANSITION_EVENT);
  }, 30_000);
});

describe('the adapter has exactly one production caller (#951, wired by #952)', () => {
  // A VALUE import of the adapter — `import type { … }` is deliberately excluded,
  // because a type-only importer cannot reach the protocol at runtime. `[^{}]*`
  // keeps a specifier list from spanning a neighbouring import statement.
  const VALUE_IMPORT = /import\s+(?!type[\s{])\{([^{}]*)\}\s*from\s*['"][^'"]*review-dispute-dispatch\.js['"]/g;

  const importers = () => {
    const found = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) {
          walk(path);
          continue;
        }
        if (!path.endsWith('.ts')) continue;
        if (path.endsWith('review-dispute-dispatch.ts')) continue;
        const text = readFileSync(path, 'utf8');
        if (!text.includes('review-dispute-dispatch.js')) continue;
        const bindings = [];
        for (const match of text.matchAll(VALUE_IMPORT)) {
          for (const specifier of match[1].split(',')) {
            const name = specifier.trim().split(/\s+as\s+/)[0].trim();
            if (name) bindings.push(name);
          }
        }
        found.push({ file: path.slice(src.length + 1), bindings });
      }
    };
    const src = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');
    walk(src);
    return found.sort((a, b) => a.file.localeCompare(b.file));
  };

  test('one module dispatches through it, for both registered sub-turns', () => {
    // #951 left this adapter reachable only from tests; #952 gave
    // `dispatchDisputeSubTurn` ONE caller — the review phase's sub-turn gate —
    // and #955 registered the arbitration turn behind that same call rather than
    // opening a second one. #964 registers the evidence turn's runner in that
    // same gate too, so all three §7.1 sub-turns dispatch through the one call.
    // A second caller would be a second, unreviewed route into the protocol.
    const dispatchers = importers().filter((m) => m.bindings.includes('dispatchDisputeSubTurn'));
    expect(dispatchers.map((m) => m.file)).toEqual([join('handlers', 'review-reconsideration-turn.ts')]);
  });

  test('the arbitration modules borrow the protocol tables without opening a second route', () => {
    // #954 builds the `runner_arbitration` sub-turn as VALUES and #955 routes its
    // outcome into a decision; both share this module's kind→state/turn tables,
    // run-key derivation and failure normalization rather than restating them, and
    // neither calls the dispatcher itself — the gate above is the one route. The
    // #963 evidence runner and #964's evidence-turn assembly borrow only TYPES,
    // so neither can reach the protocol at runtime at all.
    const modules = importers();
    expect(modules.map((m) => m.file)).toEqual([
      join('handlers', 'review-arbitration-subturn.ts'),
      join('handlers', 'review-arbitration-turn.ts'),
      join('handlers', 'review-evidence-subturn.ts'),
      join('handlers', 'review-evidence-turn.ts'),
      join('handlers', 'review-reconsideration-turn.ts'),
    ]);
    const evidence = modules.find((m) => m.file.endsWith('review-evidence-subturn.ts'));
    expect(evidence.bindings).toEqual([]);
    const evidenceTurn = modules.find((m) => m.file.endsWith('review-evidence-turn.ts'));
    expect(evidenceTurn.bindings).toEqual([]);
    const arbitration = modules.find((m) => m.file.endsWith('review-arbitration-turn.ts'));
    expect(arbitration.bindings.sort()).toEqual([
      'DISPUTE_SUB_TURN_REQUIRED_STATES',
      'DISPUTE_SUB_TURN_TASK_TURNS',
      'disputeSubTurnRunKey',
      'normalizeArbitrationFailure',
    ]);
    const routing = modules.find((m) => m.file.endsWith('review-arbitration-subturn.ts'));
    expect(routing.bindings.sort()).toEqual(['disputeSubTurnRunKey']);
  });
});
