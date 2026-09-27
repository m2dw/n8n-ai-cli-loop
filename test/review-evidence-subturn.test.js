/**
 * The issue #963 evidence sub-turn runner
 * (src/handlers/review-evidence-subturn.ts,
 * docs/review-dispute-contract.md §7 row 22, §7.1, §9, §12).
 *
 * The runner is the seam between #962's per-party invocation and #951's
 * dispatch adapter, and everything below drives it with a FAKE invocation — a
 * function returning #962's typed result — so no agent runs and no artifact is
 * written. The properties under test are the acceptance rows of the issue:
 *
 *  - a party whose admitted answer is on file for the same round identity is
 *    never invoked again, at the runner and at the adapter;
 *  - a partial round resumes from the missing party and closes on both answers;
 *  - a retry after claim loss or restart does not overwrite an admitted result;
 *  - a materially revised finding is a distinct round identity, so a stale
 *    bundle refuses and stale records are replaced rather than reused;
 *  - duplicate deliveries are idempotent (#951's replay + #840's ledger);
 *  - a transient failure delays, a timeout and a permanent failure park, and an
 *    unreadable answer completes the party with none (§7 row 22) while the
 *    reason survives into the execution record;
 *  - only bounded execution metadata reaches task context, keyed per party.
 */
import { REVIEW_DISPUTE_DEFAULT_LIMITS, ZERO_LINEAGE_COUNTERS } from '../dist/core/review-dispute.js';
import {
  REVIEW_DISPUTE_SUB_TURN_CONTEXT_KEY,
  disputeSubTurnIdentity,
  dispatchDisputeSubTurn,
} from '../dist/core/review-dispute-dispatch.js';
import {
  disputeTurnAwaitsDispatcher,
  selectPendingDisputeTurn,
} from '../dist/core/review-dispute-turn.js';
import { evidenceArtifactName } from '../dist/core/review-dispute-evidence-state.js';
import { EVIDENCE_COLLECTION_FAILURE_KINDS } from '../dist/handlers/review-evidence-collection.js';
import {
  EVIDENCE_COLLECTION_FAILURE_NORMALIZATION,
  REVIEW_DISPUTE_EVIDENCE_COLLECTIONS_CONTEXT_KEY,
  createEvidenceCollectionSubTurnRunner,
  normalizeEvidenceCollectionFailure,
} from '../dist/handlers/review-evidence-subturn.js';

const LINEAGE_A = 'ln-aaaaaaaaaaaa';
const BOUNDARY = 'src/auth/handler.ts';
const RUN_ID = 'run-review-1';
const FILE_REF = { kind: 'file', path: BOUNDARY, startLine: 10, endLine: 20 };
const FILE_REF_2 = { kind: 'file', path: BOUNDARY, startLine: 30, endLine: 40 };

function lineage(id = LINEAGE_A, overrides = {}) {
  return {
    lineageId: id,
    state: 'evidence_requested',
    version: 1,
    counters: { ...ZERO_LINEAGE_COUNTERS, rebuttals: 1, reconsiderations: 1, arbitrationPasses: 1 },
    rebuttedVersions: [1],
    humanGate: false,
    severity: 'P1',
    affectedBoundary: BOUNDARY,
    ...overrides,
  };
}

function context(lineages = { [LINEAGE_A]: lineage() }) {
  return { version: 1, reviewStructure: 'structured', lineages };
}

/** The real #950 selector, so no turn in this suite is hand-authored. */
function evidenceTurn(ctx = context()) {
  const turn = selectPendingDisputeTurn({ enabled: true, persisted: ctx });
  if (!disputeTurnAwaitsDispatcher(turn) || turn.kind !== 'evidence_collection') {
    throw new Error(`fixture selected the wrong turn: ${turn.kind}`);
  }
  return { ctx, turn };
}

function identityFor(turn, overrides = {}) {
  const result = disputeSubTurnIdentity({ runId: RUN_ID, turn, party: 'implementer', ...overrides });
  if (!result.ok) throw new Error(`identity refused: ${JSON.stringify(result.failure)}`);
  return result.value;
}

function request(overrides = {}) {
  const { ctx, turn } = evidenceTurn(overrides.context ?? context());
  return {
    turn,
    identity: overrides.identity ?? identityFor(turn, overrides.identityOverrides ?? {}),
    context: ctx,
    limits: REVIEW_DISPUTE_DEFAULT_LIMITS,
  };
}

/** #962's typed result, as the fake invocation returns it. */
function invocationResult(party, overrides = {}) {
  const attachments = overrides.attachments ?? { [LINEAGE_A]: 1 };
  const references = overrides.references ?? { [LINEAGE_A]: [FILE_REF] };
  return {
    outcome: 'completed',
    collection: {
      party,
      attachments,
      references,
      dropped: overrides.dropped ?? {},
      ignored: [],
      rejected: [],
      droppedRefs: [],
      envelopeFailure: null,
      summary: { party, asked: 1, answered: 1, admitted: 1, dropped: 0, ignoredFields: 0, rejectedRecords: 0, unansweredLineageIds: [], failure: null },
    },
    artifacts: [{ name: evidenceArtifactName(party, LINEAGE_A), content: '{"record":true}' }],
    failure: null,
    summary: {
      party,
      runId: overrides.runId ?? `${RUN_ID}~evidence.${party}.0`,
      attempt: 0,
      round: 1,
      runKeys: {},
      askedLineageIds: [LINEAGE_A],
      bundleDigest: 'd'.repeat(64),
      promptBytes: 1000,
      rawOutputBytes: 100,
      exitCode: 0,
      timedOut: false,
      durationMs: 600,
      artifacts: {},
      profile: { agentId: 'claude', provider: 'anthropic', modelSource: 'default', effortSource: 'default', toolPolicy: 'no-tools', agentSource: 'assignment' },
      evidence: null,
      outcome: 'completed',
      failure: null,
    },
    ...('outcome' in overrides ? { outcome: overrides.outcome } : {}),
    ...('collection' in overrides ? { collection: overrides.collection } : {}),
    ...('failure' in overrides ? { failure: overrides.failure } : {}),
  };
}

function failedResult(party, outcome, failure, { timedOut = false } = {}) {
  const base = invocationResult(party);
  return {
    ...base,
    outcome,
    collection: null,
    artifacts: [],
    failure,
    summary: { ...base.summary, timedOut, outcome, failure },
  };
}

function bundle(overrides = {}) {
  return {
    lineages: [{ lineageId: LINEAGE_A, version: 1 }],
    issueContract: 'The handler must reject a null session.',
    resolvableEvidenceKinds: ['file', 'doc_section', 'issue_quote'],
    ...overrides,
  };
}

/** A fake #962 invocation that records what it was handed. */
function fakeInvoke(result) {
  const calls = [];
  const invoke = (input) => {
    calls.push(input);
    return typeof result === 'function' ? result(input) : result;
  };
  invoke.calls = calls;
  return invoke;
}

function runtime(overrides = {}) {
  return {
    bundle: bundle(),
    agent: { assignment: { implementationAgent: 'claude', reviewAgent: 'claude' } },
    artifactDir: '/tmp/does-not-matter-never-touched',
    repoCwd: '/tmp/never-read-by-the-fake',
    timestamp: '2026-08-21T02:00:00.000Z',
    ...overrides,
  };
}

describe('the runner maps #962 outcomes onto the sub-turn contract (#963)', () => {
  test('a completed invocation is a collected outcome carrying counts, detail and artifacts', () => {
    const invoke = fakeInvoke((input) => invocationResult(input.party));
    const req = request();
    const outcome = createEvidenceCollectionSubTurnRunner(runtime({ invoke }))(req);

    expect(invoke.calls).toHaveLength(1);
    // The sub-turn's derived identity is the invocation's, so the §10.2 records
    // and the round record #951 writes are keyed as one run.
    expect(invoke.calls[0].run).toMatchObject({ runId: req.identity.runId, attempt: 0, round: 1 });
    expect(invoke.calls[0].party).toBe('implementer');
    expect(outcome.status).toBe('collected');
    expect(outcome.attachments).toEqual({ [LINEAGE_A]: 1 });
    expect(outcome.references[LINEAGE_A]).toEqual([FILE_REF]);
    expect(outcome.artifacts).toHaveLength(1);
    // The execution record: bounded summary and the artifact directory, keyed
    // by party so the counterpart's entry survives a shallow merge.
    const record = outcome.context[REVIEW_DISPUTE_EVIDENCE_COLLECTIONS_CONTEXT_KEY];
    expect(record.implementer).toMatchObject({
      artifactDir: '/tmp/does-not-matter-never-touched',
      summary: { party: 'implementer', outcome: 'completed' },
    });
    // Execution metadata only: the artifact BYTES travel as artifacts for the
    // caller to write, never inside the context patch.
    expect(JSON.stringify(outcome.context)).not.toContain('record');
  });

  test('the other party\'s execution record is carried forward, tolerantly', () => {
    const prior = { reviewer: { artifactDir: '/tmp/earlier', summary: { party: 'reviewer' } }, junk: 'dropped' };
    const outcome = createEvidenceCollectionSubTurnRunner(
      runtime({ invoke: fakeInvoke((input) => invocationResult(input.party)), collections: prior }),
    )(request());
    const record = outcome.context[REVIEW_DISPUTE_EVIDENCE_COLLECTIONS_CONTEXT_KEY];
    expect(record.reviewer).toEqual(prior.reviewer);
    expect(record.junk).toBeUndefined();
    // An unreadable prior record costs the audit a line, never the run.
    const tolerant = createEvidenceCollectionSubTurnRunner(
      runtime({ invoke: fakeInvoke((input) => invocationResult(input.party)), collections: 'nonsense' }),
    )(request());
    expect(tolerant.status).toBe('collected');
  });

  test('an unreadable answer completes the party with none, and the reason survives', () => {
    // §7 row 22: "or the round's runs complete with none". #957 defines the
    // envelope failure as advisory, so the party COMPLETES rather than blocking
    // the bounded round forever — and the audit keeps "could not be read"
    // distinct from "had nothing to add" through the execution record.
    const empty = failedResult('implementer', 'invalid_response', { kind: 'empty-output', detail: null });
    const outcome = createEvidenceCollectionSubTurnRunner(runtime({ invoke: fakeInvoke(empty) }))(request());
    expect(outcome.status).toBe('collected');
    expect(outcome.attachments).toEqual({});
    expect(outcome.references).toBeUndefined();
    const record = outcome.context[REVIEW_DISPUTE_EVIDENCE_COLLECTIONS_CONTEXT_KEY];
    expect(record.implementer.summary).toMatchObject({ outcome: 'invalid_response' });
  });

  test('transient failures delay, timeouts and permanent failures park', () => {
    const cases = [
      [failedResult('implementer', 'transient_failure', { kind: 'agent-failed', detail: 'exit:1' }), 'delayed', 'invocation_failed'],
      [failedResult('implementer', 'timeout', { kind: 'agent-timeout', detail: 'exit:null' }, { timedOut: true }), 'failed', 'timeout'],
      [failedResult('implementer', 'permanent_failure', { kind: 'cli-unavailable', detail: 'claude' }), 'failed', 'profile_unavailable'],
      [failedResult('implementer', 'permanent_failure', { kind: 'unsafe-artifact-dir', detail: 'artifactDir' }), 'failed', 'artifact_failed'],
    ];
    for (const [result, status, kind] of cases) {
      const outcome = createEvidenceCollectionSubTurnRunner(runtime({ invoke: fakeInvoke(result) }))(request());
      expect(outcome.status).toBe(status);
      expect(outcome.failure.kind).toBe(kind);
      // The failed attempt's execution record still travels: it is exactly the
      // one an operator goes looking for.
      expect(outcome.context[REVIEW_DISPUTE_EVIDENCE_COLLECTIONS_CONTEXT_KEY].implementer).toBeDefined();
    }
  });

  test('the normalization covers #962\'s failure vocabulary exactly', () => {
    expect(Object.keys(EVIDENCE_COLLECTION_FAILURE_NORMALIZATION).sort())
      .toEqual([...EVIDENCE_COLLECTION_FAILURE_KINDS].sort());
    // The deadline fact is told apart from a refusal (issue #953).
    expect(normalizeEvidenceCollectionFailure({ kind: 'agent-failed', detail: 'exit:1' }, { timedOut: true }).kind)
      .toBe('timeout');
    expect(normalizeEvidenceCollectionFailure({ kind: 'agent-failed', detail: 'exit:1' }).kind)
      .toBe('invocation_failed');
  });

  test('a throwing invocation is a typed failure carrying only the error name', () => {
    const invoke = () => {
      throw new TypeError('secret path /Users/someone/transcript.txt');
    };
    const outcome = createEvidenceCollectionSubTurnRunner(runtime({ invoke }))(request());
    expect(outcome).toEqual({
      status: 'failed',
      failure: { kind: 'internal_error', detail: 'TypeError' },
    });
  });

  test('an identity with no party is refused before anything runs', () => {
    const invoke = fakeInvoke(invocationResult('implementer'));
    const req = request();
    const outcome = createEvidenceCollectionSubTurnRunner(runtime({ invoke }))({
      ...req,
      identity: { ...req.identity, party: null },
    });
    expect(invoke.calls).toHaveLength(0);
    expect(outcome).toEqual({
      status: 'failed',
      failure: { kind: 'invalid_identity', detail: 'identity.party:absent' },
    });
  });
});

describe('the bundle must be this turn\'s, at the current versions (#963)', () => {
  test('a bundle missing a covered lineage, or naming an uncovered one, refuses without invoking', () => {
    const invoke = fakeInvoke(invocationResult('implementer'));
    const missing = createEvidenceCollectionSubTurnRunner(
      runtime({ invoke, bundle: bundle({ lineages: [] }) }),
    )(request());
    expect(missing).toMatchObject({
      status: 'failed',
      failure: { kind: 'invalid_identity', detail: `bundle.lineages:${LINEAGE_A}:absent` },
    });
    const foreign = createEvidenceCollectionSubTurnRunner(
      runtime({
        invoke,
        bundle: bundle({ lineages: [{ lineageId: LINEAGE_A, version: 1 }, { lineageId: 'ln-bbbbbbbbbbbb', version: 1 }] }),
      }),
    )(request());
    expect(foreign).toMatchObject({
      status: 'failed',
      failure: { kind: 'invalid_identity', detail: 'bundle.lineages:ln-bbbbbbbbbbbb:unselected' },
    });
    expect(invoke.calls).toHaveLength(0);
  });

  test('a bundle naming a covered lineage twice refuses without invoking', () => {
    // Presence and version checks look up a Map that collapses duplicates,
    // but the invocation would receive the duplicated array: the agent would
    // see the finding twice and answer a non-exact bundle.
    const invoke = fakeInvoke(invocationResult('implementer'));
    const outcome = createEvidenceCollectionSubTurnRunner(
      runtime({
        invoke,
        bundle: bundle({ lineages: [{ lineageId: LINEAGE_A, version: 1 }, { lineageId: LINEAGE_A, version: 1 }] }),
      }),
    )(request());
    expect(invoke.calls).toHaveLength(0);
    expect(outcome).toMatchObject({
      status: 'failed',
      failure: { kind: 'invalid_identity', detail: `bundle.lineages:${LINEAGE_A}:duplicate` },
    });
  });

  test('a bundle built against a version the lineage has left is stale evidence, not a run', () => {
    // The finding was materially revised after the bundle was assembled: the
    // round identity moved, and collecting over the old brief would gather
    // evidence about prose the debate has already replaced.
    const invoke = fakeInvoke(invocationResult('implementer'));
    const outcome = createEvidenceCollectionSubTurnRunner(
      runtime({ invoke, bundle: bundle({ lineages: [{ lineageId: LINEAGE_A, version: 2 }] }) }),
    )(request());
    expect(invoke.calls).toHaveLength(0);
    expect(outcome).toMatchObject({
      status: 'failed',
      failure: { kind: 'stale_lineage', detail: `bundle.lineages:${LINEAGE_A}:version:2` },
    });
  });
});

describe('an admitted answer is reused, never re-bought (#963)', () => {
  /** The round record after this party completed under a PREVIOUS claim. */
  function recordedRound(party = 'implementer', overrides = {}) {
    return {
      lineages: {
        [LINEAGE_A]: {
          version: overrides.version ?? 1,
          parties: {
            [party]: {
              runId: overrides.runId ?? `run-review-0~evidence.${party}.0`,
              attempt: overrides.attempt ?? 0,
              attachments: overrides.attachments ?? 2,
            },
          },
          ...(overrides.recordedRunId === undefined ? {} : { recordedRunId: overrides.recordedRunId }),
        },
      },
    };
  }

  test('the runner returns the recorded answer without invoking anyone', () => {
    const invoke = fakeInvoke(invocationResult('implementer'));
    const outcome = createEvidenceCollectionSubTurnRunner(
      runtime({ invoke, evidenceRound: recordedRound() }),
    )(request());
    expect(invoke.calls).toHaveLength(0);
    expect(outcome).toEqual({ status: 'collected', attachments: { [LINEAGE_A]: 2 } });
  });

  test('a stale, spent, or other-party record recognizes no reuse', () => {
    for (const round of [
      recordedRound('implementer', { version: 2 }),
      recordedRound('implementer', { recordedRunId: 'some-other~evidence.reviewer.0' }),
      recordedRound('reviewer'),
      undefined,
      'unreadable',
    ]) {
      const invoke = fakeInvoke(invocationResult('implementer'));
      const outcome = createEvidenceCollectionSubTurnRunner(
        runtime({ invoke, evidenceRound: round }),
      )(request());
      expect(invoke.calls).toHaveLength(1);
      expect(outcome.status).toBe('collected');
    }
  });

  test('a deliberately bumped attempt is an explicit fresh run and reuses nothing', () => {
    const invoke = fakeInvoke(invocationResult('implementer'));
    const outcome = createEvidenceCollectionSubTurnRunner(
      runtime({ invoke, evidenceRound: recordedRound() }),
    )(request({ identityOverrides: { attempt: 1 } }));
    expect(invoke.calls).toHaveLength(1);
    expect(invoke.calls[0].run.attempt).toBe(1);
    expect(outcome.status).toBe('collected');
  });
});

describe('the whole round, end to end through the dispatch adapter (#963)', () => {
  test('two parties, two claims: resume runs only the missing party and row 22 closes on both answers', async () => {
    const { ctx, turn } = evidenceTurn();

    // Claim 1: the implementer collects.
    // The reference list must AGREE with the count it accompanies, or the
    // record refuses the run as §12 malformed output.
    const implementerInvoke = fakeInvoke((input) => invocationResult(input.party, { attachments: { [LINEAGE_A]: 2 }, references: { [LINEAGE_A]: [FILE_REF, FILE_REF_2] } }));
    const first = await dispatchDisputeSubTurn({
      turn,
      context: ctx,
      identity: identityFor(turn),
      runner: createEvidenceCollectionSubTurnRunner(runtime({ invoke: implementerInvoke })),
    });
    expect(first.disposition).toBe('collected');
    expect(implementerInvoke.calls).toHaveLength(1);
    expect(first.evidenceRound.lineages[LINEAGE_A].parties.implementer).toMatchObject({ attachments: 2 });

    // The claim is lost. Claim 2 re-dispatches the SAME party first — the
    // adapter recognizes the admitted answer and neither invokes nor overwrites.
    const duplicateInvoke = fakeInvoke((input) => invocationResult(input.party, { attachments: { [LINEAGE_A]: 9 } }));
    const duplicate = await dispatchDisputeSubTurn({
      turn,
      context: ctx,
      identity: identityFor(turn, { runId: 'run-review-2' }),
      runner: createEvidenceCollectionSubTurnRunner(
        runtime({ invoke: duplicateInvoke, evidenceRound: first.evidenceRound }),
      ),
      evidenceRound: first.evidenceRound,
    });
    expect(duplicateInvoke.calls).toHaveLength(0);
    expect(duplicate.disposition).toBe('collected');
    expect(duplicate.evidenceRound.lineages[LINEAGE_A].parties.implementer)
      .toEqual(first.evidenceRound.lineages[LINEAGE_A].parties.implementer);

    // Claim 2, missing party: the reviewer collects and the round closes.
    const reviewerInvoke = fakeInvoke((input) => invocationResult(input.party, { attachments: { [LINEAGE_A]: 1 } }));
    const closed = await dispatchDisputeSubTurn({
      turn,
      context: ctx,
      identity: identityFor(turn, { runId: 'run-review-2', party: 'reviewer' }),
      runner: createEvidenceCollectionSubTurnRunner(
        runtime({ invoke: reviewerInvoke, evidenceRound: duplicate.evidenceRound }),
      ),
      evidenceRound: duplicate.evidenceRound,
    });
    expect(reviewerInvoke.calls).toHaveLength(1);
    expect(closed.disposition).toBe('applied');
    expect(closed.transition.applied[0]).toMatchObject({
      row: 22,
      lineageId: LINEAGE_A,
      toState: 'arbitration_pending',
    });
    // 2 + 1, collected across two claims — never the duplicate's 9.
    expect(closed.result.context[REVIEW_DISPUTE_SUB_TURN_CONTEXT_KEY].evidenceRound.attachmentsRecorded).toBe(3);
  });

  test('a transient stop is delayed with the stop on record, and the retry completes the party once', async () => {
    const { ctx, turn } = evidenceTurn();
    const identity = identityFor(turn);
    const stopped = await dispatchDisputeSubTurn({
      turn,
      context: ctx,
      identity,
      runner: createEvidenceCollectionSubTurnRunner(
        runtime({ invoke: fakeInvoke(failedResult('implementer', 'transient_failure', { kind: 'agent-failed', detail: 'exit:1' })) }),
      ),
    });
    expect(stopped.disposition).toBe('delayed');
    expect(stopped.evidenceRound.lineages[LINEAGE_A].parties.implementer).toMatchObject({
      status: 'recoverable',
      reason: 'invocation_failed',
    });

    // The redelivered claim retries: the recoverable record is not an answer,
    // so the party runs — once — and its delivered answer replaces the stop.
    const retryInvoke = fakeInvoke((input) => invocationResult(input.party, { attachments: { [LINEAGE_A]: 2 }, references: { [LINEAGE_A]: [FILE_REF, FILE_REF_2] } }));
    const retried = await dispatchDisputeSubTurn({
      turn,
      context: ctx,
      identity,
      runner: createEvidenceCollectionSubTurnRunner(
        runtime({ invoke: retryInvoke, evidenceRound: stopped.evidenceRound }),
      ),
      evidenceRound: stopped.evidenceRound,
    });
    expect(retryInvoke.calls).toHaveLength(1);
    expect(retried.disposition).toBe('collected');
    expect(retried.evidenceRound.lineages[LINEAGE_A].parties.implementer).toMatchObject({ attachments: 2 });
  });
});
