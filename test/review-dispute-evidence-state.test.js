/**
 * The issue #956 persisted evidence-collection state
 * (src/core/review-dispute-evidence-state.ts,
 * docs/review-dispute-contract.md §3.3, §7.1, §10.1–§10.3, §12).
 *
 * The module under test is pure state: it invokes nothing, dispatches nothing,
 * and reads no store. So every test below is a value in and a value out, and the
 * four properties they carry are the four the slice promises:
 *
 *  - **the #955 record is the record.** A count-only block parses to itself,
 *    keeps its meaning (a completed party, round 1, no reference detail), and a
 *    count-only completion written today is byte-identical to one written then.
 *    Nothing about a task mid-round changes across the upgrade.
 *  - **presence is not completion.** A party that is running or waiting on a
 *    retry HAS a record and has not answered, so row 22's "when both have
 *    completed" cannot fire on it — and the party that already completed is
 *    never collected again when its counterpart resumes.
 *  - **an admitted result may be empty and still be a result.** Zero attachments
 *    with an empty reference list is a completed party, and it stays
 *    distinguishable from a record that carries no reference detail at all.
 *  - **nothing unsafe is persisted.** No absolute path, no prompt, no agent
 *    output, no artifact bytes, and no quoted span reaches the record, the
 *    audit summary, or the operator projection.
 */
import {
  ABSOLUTE_MAX_EVIDENCE_ROUNDS,
  DEFAULT_EVIDENCE_ROUND,
  DEFAULT_EVIDENCE_RUN_STATUS,
  DISPUTE_EVIDENCE_PARTY_STATES,
  DISPUTE_EVIDENCE_RUN_STATUSES,
  MAX_EVIDENCE_ARTIFACT_REFS_PER_PARTY,
  MAX_EVIDENCE_ATTACHMENTS_PER_PARTY,
  REVIEW_DISPUTE_EVIDENCE_ROUND_CONTEXT_KEY,
  REVIEW_DISPUTE_EVIDENCE_ROUND_MAX_BYTES,
  beginEvidencePartyRun,
  completeEvidencePartyRun,
  disputeEvidenceAttachmentsRecorded,
  disputeEvidencePartyAnswered,
  disputeEvidencePartyState,
  disputeEvidenceReferences,
  disputeEvidenceRoundComplete,
  disputeEvidenceRoundEntry,
  disputeEvidenceRoundNumber,
  disputeEvidenceRunStatus,
  emptyEvidenceRound,
  evidenceArtifactName,
  evidenceArtifactNames,
  evidenceArtifactRef,
  evidencePartyRunDigest,
  evidencePartyRunKey,
  evidenceRoundDigest,
  evidenceRoundKey,
  isEvidenceArtifactName,
  markEvidencePartyRunRecoverable,
  markEvidenceRoundRecorded,
  parseDisputeEvidenceRoundState,
  persistedEvidenceRefDigest,
  projectEvidenceRoundStatus,
  readDisputeEvidenceRoundState,
  selectEvidenceCollectionParty,
  serializeEvidenceRoundState,
  summarizeEvidenceRound,
  toPersistedEvidenceRef,
} from '../dist/core/review-dispute-evidence-state.js';
import { MAX_DISPUTE_SUB_TURN_ATTEMPT, MAX_LINEAGES_PER_TASK } from '../dist/core/review-dispute.js';

const LINEAGE_A = 'ln-aaaaaaaaaaaa';
const LINEAGE_B = 'ln-bbbbbbbbbbbb';
const RUN_IMPLEMENTER = 'run-review-1~evidence.implementer.0';
const RUN_REVIEWER = 'run-review-1~evidence.reviewer.0';

/** The record shape #955 wrote, and the one every pre-#956 block carries. */
function countOnlyRound(overrides = {}) {
  const {
    lineageId = LINEAGE_A,
    version = 1,
    party = 'implementer',
    runId = RUN_IMPLEMENTER,
    attempt = 0,
    attachments = 2,
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

function coordinates(overrides = {}) {
  return {
    lineageId: LINEAGE_A,
    version: 1,
    party: 'reviewer',
    attempt: 0,
    runId: RUN_REVIEWER,
    ...overrides,
  };
}

function write(result) {
  if (!result.ok) throw new Error(`write refused: ${JSON.stringify(result.failure)}`);
  return result.value;
}

function parsed(value) {
  const result = parseDisputeEvidenceRoundState(value);
  if (!result.ok) throw new Error(`parse refused: ${JSON.stringify(result.failure)}`);
  return result.value;
}

const FILE_REF = { kind: 'file', path: 'src/auth/handler.ts', startLine: 10, endLine: 20 };
const TEST_REF = { kind: 'test', name: 'auth handler rejects an expired token' };
const DOC_REF = { kind: 'doc_section', path: 'docs/review-dispute-contract.md', section: '3.3' };
const QUOTE_REF = { kind: 'issue_quote', quote: 'the handler must reject an expired token' };

// ---------------------------------------------------------------------------
// Migration: every shape a task may already carry
// ---------------------------------------------------------------------------

describe('evidence round — the #955 record migrates by being read (#956)', () => {
  test('a task with no record at all has two parties that have not started', () => {
    expect(readDisputeEvidenceRoundState(undefined)).toEqual({ ok: true, value: { lineages: {} } });
    expect(readDisputeEvidenceRoundState({})).toEqual({ ok: true, value: { lineages: {} } });
    expect(readDisputeEvidenceRoundState({ other: 1 })).toEqual({ ok: true, value: { lineages: {} } });

    const state = emptyEvidenceRound();
    const entry = disputeEvidenceRoundEntry(state, LINEAGE_A);
    expect(entry).toBeUndefined();
    expect(disputeEvidencePartyState(entry, 'implementer')).toBe('not_started');
    expect(disputeEvidencePartyState(entry, 'reviewer')).toBe('not_started');
    expect(disputeEvidenceRoundComplete(entry)).toBe(false);
  });

  test('a count-only record parses to itself and still means a completed party', () => {
    const record = countOnlyRound();
    // Round-tripped through JSON the way task context stores it, and nothing is
    // materialized on the way in: the value read back IS the value written.
    const state = parsed(JSON.parse(JSON.stringify(record)));
    expect(state).toEqual(record);
    expect(JSON.stringify(state)).toBe(JSON.stringify(record));

    const entry = disputeEvidenceRoundEntry(state, LINEAGE_A);
    expect(disputeEvidenceRunStatus(entry.parties.implementer)).toBe('completed');
    expect(disputeEvidencePartyState(entry, 'implementer')).toBe('completed');
    expect(disputeEvidencePartyState(entry, 'reviewer')).toBe('not_started');
    expect(disputeEvidenceRoundNumber(entry)).toBe(DEFAULT_EVIDENCE_ROUND);
    // The count survives untouched — it is what row 22 records — and there is no
    // reference detail to report, which is not the same as an empty result.
    expect(disputeEvidenceAttachmentsRecorded(entry)).toBe(2);
    expect(entry.parties.implementer.references).toBeUndefined();
    expect(disputeEvidenceReferences(entry)).toEqual([]);
  });

  test('a partially completed dual-party round is not complete', () => {
    const entry = disputeEvidenceRoundEntry(parsed(countOnlyRound()), LINEAGE_A);
    expect(disputeEvidenceRoundComplete(entry)).toBe(false);
    const both = disputeEvidenceRoundEntry(
      write(completeEvidencePartyRun(parsed(countOnlyRound()), coordinates(), { attachments: 1 })),
      LINEAGE_A,
    );
    expect(disputeEvidenceRoundComplete(both)).toBe(true);
    expect(disputeEvidenceAttachmentsRecorded(both)).toBe(3);
  });

  test('a completed and replayed round keeps the run id that spent it', () => {
    const record = countOnlyRound({ recordedRunId: RUN_REVIEWER });
    const state = parsed(record);
    expect(state).toEqual(record);
    expect(disputeEvidenceRoundEntry(state, LINEAGE_A).recordedRunId).toBe(RUN_REVIEWER);
    // Marking a round recorded is idempotent for the run that recorded it.
    const again = markEvidenceRoundRecorded(state, LINEAGE_A, RUN_REVIEWER);
    expect(again).toEqual(state);
  });

  test('a count-only completion written today is the record #955 wrote', () => {
    const state = write(
      completeEvidencePartyRun(emptyEvidenceRound(), coordinates({ party: 'implementer', runId: RUN_IMPLEMENTER }), {
        attachments: 2,
      }),
    );
    // No `status`, no `round`, no empty lists: the default IS the absence, so a
    // block written by this module can be read by the runner that wrote #955's.
    expect(JSON.parse(JSON.stringify(state))).toEqual(countOnlyRound());
  });
});

// ---------------------------------------------------------------------------
// The lifecycle
// ---------------------------------------------------------------------------

describe('evidence round — the collection lifecycle (#956)', () => {
  test('the party states are the four the record can express', () => {
    expect([...DISPUTE_EVIDENCE_PARTY_STATES]).toEqual(['not_started', 'running', 'recoverable', 'completed']);
    // `not_started` is the absence of a record, so it is the one state a
    // persisted run may not claim.
    expect([...DISPUTE_EVIDENCE_RUN_STATUSES]).toEqual(['running', 'recoverable', 'completed']);
    expect(DEFAULT_EVIDENCE_RUN_STATUS).toBe('completed');
  });

  test('a running party has a record and has NOT answered', () => {
    const state = write(beginEvidencePartyRun(emptyEvidenceRound(), coordinates()));
    const entry = disputeEvidenceRoundEntry(state, LINEAGE_A);
    expect(disputeEvidencePartyState(entry, 'reviewer')).toBe('running');
    expect(entry.parties.reviewer.attachments).toBe(0);
    // The load-bearing property: row 22 fires "when both have completed", and a
    // record that merely EXISTS would close the round on a run still going.
    expect(disputeEvidenceRoundComplete(entry)).toBe(false);
    expect(disputeEvidenceAttachmentsRecorded(entry)).toBe(0);
  });

  test('a recoverable party records which attempt stopped, in one bounded token', () => {
    const state = write(markEvidencePartyRunRecoverable(emptyEvidenceRound(), coordinates(), 'timeout'));
    const entry = disputeEvidenceRoundEntry(state, LINEAGE_A);
    expect(entry.parties.reviewer).toMatchObject({ status: 'recoverable', attempt: 0, reason: 'timeout' });
    expect(disputeEvidenceRoundComplete(entry)).toBe(false);

    // A reason is a token, never prose, a path, or a detail locator: the value is
    // persisted and reaches the operator projection.
    for (const bad of ['agent timed out', 'ms:600000', '/tmp/run-1', 'x'.repeat(64)]) {
      expect(markEvidencePartyRunRecoverable(emptyEvidenceRound(), coordinates(), bad).ok).toBe(false);
    }
  });

  test('one party resumes without rerunning the party that already completed', () => {
    // The implementer answered, the reviewer's run was interrupted, and the
    // phase resumed under a new attempt.
    let state = parsed(countOnlyRound());
    state = write(beginEvidencePartyRun(state, coordinates()));
    state = write(markEvidencePartyRunRecoverable(state, coordinates(), 'invocation_failed'));
    let entry = disputeEvidenceRoundEntry(state, LINEAGE_A);
    expect(disputeEvidencePartyState(entry, 'implementer')).toBe('completed');
    expect(entry.parties.implementer.attachments).toBe(2);

    state = write(
      completeEvidencePartyRun(state, coordinates({ attempt: 1, runId: 'run-review-1~evidence.reviewer.1' }), {
        attachments: 1,
      }),
    );
    entry = disputeEvidenceRoundEntry(state, LINEAGE_A);
    // The completed party is untouched — same run id, same attempt, same count —
    // and the round closes on both answers.
    expect(entry.parties.implementer).toEqual({ runId: RUN_IMPLEMENTER, attempt: 0, attachments: 2 });
    expect(entry.parties.reviewer).toMatchObject({ attempt: 1, attachments: 1 });
    expect(disputeEvidenceRoundComplete(entry)).toBe(true);
    expect(disputeEvidenceAttachmentsRecorded(entry)).toBe(3);
  });

  test('a round collected against a version the lineage has left is replaced', () => {
    const state = write(completeEvidencePartyRun(parsed(countOnlyRound({ version: 1 })), coordinates({ version: 2 })));
    const entry = disputeEvidenceRoundEntry(state, LINEAGE_A);
    expect(entry.version).toBe(2);
    expect(entry.parties.implementer).toBeUndefined();
    expect(disputeEvidenceRoundComplete(entry)).toBe(false);
  });

  test('a round another run has spent never closes on its predecessor\'s parties', () => {
    const spent = parsed(countOnlyRound({ recordedRunId: 'run-review-0~evidence.reviewer.0' }));
    const state = write(completeEvidencePartyRun(spent, coordinates()));
    const entry = disputeEvidenceRoundEntry(state, LINEAGE_A);
    expect(entry.parties.implementer).toBeUndefined();
    expect(entry.recordedRunId).toBeUndefined();
  });

  test('a write leaves the state it was handed exactly as it was', () => {
    const before = parsed(countOnlyRound());
    const snapshot = JSON.stringify(before);
    write(completeEvidencePartyRun(before, coordinates(), { attachments: 1 }));
    write(beginEvidencePartyRun(before, coordinates()));
    markEvidenceRoundRecorded(before, LINEAGE_A, RUN_REVIEWER);
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  test('entries for lineages outside the write are carried forward untouched', () => {
    let state = write(completeEvidencePartyRun(emptyEvidenceRound(), coordinates({ lineageId: LINEAGE_B })));
    state = write(completeEvidencePartyRun(state, coordinates({ lineageId: LINEAGE_A })));
    expect(Object.keys(state.lineages).sort()).toEqual([LINEAGE_A, LINEAGE_B]);
  });
});

// ---------------------------------------------------------------------------
// Admitted results
// ---------------------------------------------------------------------------

describe('evidence round — admitted §3.3 references (#956)', () => {
  test('an empty result is a valid completed party, and is not a count-only record', () => {
    const state = write(completeEvidencePartyRun(emptyEvidenceRound(), coordinates(), { references: [] }));
    const run = disputeEvidenceRoundEntry(state, LINEAGE_A).parties.reviewer;
    // §7.1: "the runner records the admitted attachments (possibly none)".
    expect(run.attachments).toBe(0);
    expect(run.references).toEqual([]);
    expect(disputeEvidencePartyState(disputeEvidenceRoundEntry(state, LINEAGE_A), 'reviewer')).toBe('completed');
    // A record that recorded no DETAIL is a different thing from one that
    // recorded an empty result, and the two must stay distinguishable.
    const countOnly = write(completeEvidencePartyRun(emptyEvidenceRound(), coordinates(), { attachments: 0 }));
    expect(disputeEvidenceRoundEntry(countOnly, LINEAGE_A).parties.reviewer.references).toBeUndefined();
  });

  test('references are retained per lineage and party, and the count stays derivable', () => {
    let state = write(
      completeEvidencePartyRun(emptyEvidenceRound(), coordinates({ party: 'implementer', runId: RUN_IMPLEMENTER }), {
        references: [FILE_REF, TEST_REF],
        dropped: 1,
      }),
    );
    state = write(completeEvidencePartyRun(state, coordinates(), { references: [DOC_REF] }));
    const entry = disputeEvidenceRoundEntry(state, LINEAGE_A);

    expect(entry.parties.implementer).toMatchObject({ attachments: 2, dropped: 1 });
    expect(entry.parties.reviewer.attachments).toBe(1);
    expect(disputeEvidenceAttachmentsRecorded(entry)).toBe(3);
    expect(disputeEvidenceReferences(entry)).toEqual([FILE_REF, TEST_REF, DOC_REF]);
    // Persisted and read back unchanged.
    expect(parsed(JSON.parse(JSON.stringify(state)))).toEqual(state);
  });

  test('a quoted span of the Issue body is persisted as a digest, never as the span', () => {
    const persisted = toPersistedEvidenceRef(QUOTE_REF);
    expect(persisted).toEqual({
      kind: 'issue_quote',
      quoteDigest: expect.stringMatching(/^[0-9a-f]{12}$/),
      quoteChars: QUOTE_REF.quote.length,
    });
    // Two runs quoting the same span produce the same reference, which is what a
    // replay comparison needs; a different span is a different reference.
    expect(persistedEvidenceRefDigest(persisted)).toBe(persistedEvidenceRefDigest(toPersistedEvidenceRef(QUOTE_REF)));
    expect(persistedEvidenceRefDigest(persisted)).not.toBe(
      persistedEvidenceRefDigest(toPersistedEvidenceRef({ kind: 'issue_quote', quote: 'something else entirely' })),
    );

    const state = write(completeEvidencePartyRun(emptyEvidenceRound(), coordinates(), { references: [QUOTE_REF] }));
    expect(JSON.stringify(state)).not.toContain('expired token');
    // And a record that smuggled the span back in is refused rather than
    // silently stripped.
    const smuggled = JSON.parse(JSON.stringify(state));
    smuggled.lineages[LINEAGE_A].parties.reviewer.references[0].quote = QUOTE_REF.quote;
    expect(parseDisputeEvidenceRoundState(smuggled).ok).toBe(false);
  });

  test('a list that disagrees with its count is refused in both directions', () => {
    expect(
      completeEvidencePartyRun(emptyEvidenceRound(), coordinates(), { attachments: 2, references: [FILE_REF] }).ok,
    ).toBe(false);
    const record = JSON.parse(
      JSON.stringify(write(completeEvidencePartyRun(emptyEvidenceRound(), coordinates(), { references: [FILE_REF] }))),
    );
    record.lineages[LINEAGE_A].parties.reviewer.attachments = 3;
    expect(parseDisputeEvidenceRoundState(record).failure).toMatchObject({ reason: 'invalid-state-record' });
  });

  test('a reference that is not a §3.3 reference never reaches the record', () => {
    for (const bad of [
      { kind: 'file', path: '/etc/passwd', startLine: 1, endLine: 2 },
      { kind: 'file', path: '../secrets.env', startLine: 1, endLine: 2 },
      { kind: 'doc_section', path: 'src/index.ts', section: '1' },
      { kind: 'wormhole', path: 'src/index.ts' },
    ]) {
      expect(completeEvidencePartyRun(emptyEvidenceRound(), coordinates(), { references: [bad] }).ok).toBe(false);
    }
  });

  test('every count the record holds is bounded', () => {
    const many = Array.from({ length: MAX_EVIDENCE_ATTACHMENTS_PER_PARTY + 1 }, () => FILE_REF);
    expect(completeEvidencePartyRun(emptyEvidenceRound(), coordinates(), { references: many }).ok).toBe(false);
    expect(
      completeEvidencePartyRun(emptyEvidenceRound(), coordinates(), {
        attachments: MAX_EVIDENCE_ATTACHMENTS_PER_PARTY + 1,
      }).ok,
    ).toBe(false);
    expect(completeEvidencePartyRun(emptyEvidenceRound(), coordinates(), { dropped: 999 }).ok).toBe(false);
    expect(
      completeEvidencePartyRun(emptyEvidenceRound(), coordinates(), {
        artifacts: Array.from({ length: MAX_EVIDENCE_ARTIFACT_REFS_PER_PARTY + 1 }, () =>
          evidenceArtifactRef({ name: evidenceArtifactName('reviewer', LINEAGE_A), content: '{}' }),
        ),
      }).ok,
    ).toBe(false);
    // And the coordinates are bounded on the same terms.
    expect(completeEvidencePartyRun(emptyEvidenceRound(), coordinates({ attempt: MAX_DISPUTE_SUB_TURN_ATTEMPT + 1 })).ok)
      .toBe(false);
    expect(completeEvidencePartyRun(emptyEvidenceRound(), coordinates({ runId: 'x'.repeat(200) })).ok).toBe(false);
    expect(completeEvidencePartyRun(emptyEvidenceRound(), coordinates({ party: 'arbiter' })).ok).toBe(false);
    expect(completeEvidencePartyRun(emptyEvidenceRound(), coordinates({ version: 0 })).ok).toBe(false);
    expect(
      completeEvidencePartyRun(emptyEvidenceRound(), coordinates({ round: ABSOLUTE_MAX_EVIDENCE_ROUNDS + 1 })).ok,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Keys and artifact references
// ---------------------------------------------------------------------------

describe('evidence round — deterministic keys and safe artifact references (#956)', () => {
  test('a party run key is derived from every coordinate that distinguishes it', () => {
    const base = { lineageId: LINEAGE_A, version: 1, party: 'reviewer', attempt: 0, runId: RUN_REVIEWER };
    expect(evidencePartyRunKey(base)).toBe(`${LINEAGE_A}@1/e1:reviewer.0#${RUN_REVIEWER}`);
    // Derived, so a redelivered claim re-derives it byte for byte.
    expect(evidencePartyRunKey({ ...base })).toBe(evidencePartyRunKey(base));
    expect(evidencePartyRunKey({ ...base, round: DEFAULT_EVIDENCE_ROUND })).toBe(evidencePartyRunKey(base));

    const keys = new Set([
      evidencePartyRunKey(base),
      evidencePartyRunKey({ ...base, lineageId: LINEAGE_B }),
      evidencePartyRunKey({ ...base, version: 2 }),
      evidencePartyRunKey({ ...base, party: 'implementer' }),
      evidencePartyRunKey({ ...base, attempt: 1 }),
      evidencePartyRunKey({ ...base, runId: RUN_IMPLEMENTER }),
    ]);
    expect(keys.size).toBe(6);
    expect(evidencePartyRunDigest(base)).toMatch(/^[0-9a-f]{12}$/);
    expect(evidencePartyRunDigest(base)).not.toBe(evidencePartyRunDigest({ ...base, party: 'implementer' }));
  });

  test('artifact names are runner-minted, party-scoped, and refused for anything else', () => {
    expect(evidenceArtifactName('reviewer', LINEAGE_A)).toBe(`evidence-reviewer-${LINEAGE_A}.json`);
    expect(evidenceArtifactName('implementer', LINEAGE_A, 'raw')).toBe(`evidence-raw-implementer-${LINEAGE_A}.txt`);
    expect(evidenceArtifactNames('reviewer', LINEAGE_A)).toEqual([
      `evidence-reviewer-${LINEAGE_A}.json`,
      `evidence-raw-reviewer-${LINEAGE_A}.txt`,
      `evidence-stderr-reviewer-${LINEAGE_A}.txt`,
      `evidence-runner-error-reviewer-${LINEAGE_A}.txt`,
    ]);
    // Two runs for one lineage, two sets of files: neither may overwrite the
    // other's record or transcript.
    expect(evidenceArtifactNames('reviewer', LINEAGE_A)).not.toEqual(evidenceArtifactNames('implementer', LINEAGE_A));

    expect(() => evidenceArtifactName('reviewer', '../../etc/passwd')).toThrow();
    expect(() => evidenceArtifactName('arbiter', LINEAGE_A)).toThrow();
    expect(isEvidenceArtifactName(`evidence-reviewer-${LINEAGE_A}.json`, 'reviewer', LINEAGE_A)).toBe(true);
    // Another lineage's record is not this lineage's, however plausible the name.
    expect(isEvidenceArtifactName(`evidence-reviewer-${LINEAGE_B}.json`, 'reviewer', LINEAGE_A)).toBe(false);
    expect(isEvidenceArtifactName(`../evidence-reviewer-${LINEAGE_A}.json`, 'reviewer', LINEAGE_A)).toBe(false);
  });

  test('an artifact reference carries a name, a digest and a length — never bytes or a path', () => {
    const artifact = { name: evidenceArtifactName('reviewer', LINEAGE_A), content: '{"refs":["secret bytes"]}' };
    const ref = evidenceArtifactRef(artifact);
    expect(ref).toEqual({
      name: artifact.name,
      digest: expect.stringMatching(/^[0-9a-f]{12}$/),
      bytes: Buffer.byteLength(artifact.content, 'utf8'),
    });
    expect(JSON.stringify(ref)).not.toContain('secret bytes');
    // The digest identifies the bytes: a file that changed is a different one.
    expect(evidenceArtifactRef({ ...artifact, content: '{}' }).digest).not.toBe(ref.digest);

    const state = write(completeEvidencePartyRun(emptyEvidenceRound(), coordinates(), { artifacts: [ref] }));
    expect(disputeEvidenceRoundEntry(state, LINEAGE_A).parties.reviewer.artifacts).toEqual([ref]);
    expect(parsed(JSON.parse(JSON.stringify(state)))).toEqual(state);

    // A reference naming a path rather than a base name is refused on both the
    // write and the read: the directory it would resolve under is the caller's.
    for (const name of ['/tmp/run-1/evidence-reviewer.json', 'sub/evidence-reviewer.json', 'reconsideration-x.json']) {
      expect(completeEvidencePartyRun(emptyEvidenceRound(), coordinates(), {
        artifacts: [{ ...ref, name }],
      }).ok).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Fail-closed reading
// ---------------------------------------------------------------------------

describe('evidence round — a record that cannot be admitted fails closed (#956, §12)', () => {
  test('the #955 refusals still refuse', () => {
    expect(parseDisputeEvidenceRoundState({ lineages: [] }).ok).toBe(false);
    expect(parseDisputeEvidenceRoundState({ lineages: { [LINEAGE_A]: { version: 0, parties: {} } } }).ok).toBe(false);
    expect(
      parseDisputeEvidenceRoundState({
        lineages: { [LINEAGE_A]: { version: 1, parties: { arbiter: { runId: 'r', attempt: 0, attachments: 1 } } } },
      }).failure,
    ).toMatchObject({ reason: 'unknown-enum' });
    expect(
      parseDisputeEvidenceRoundState({
        lineages: { [LINEAGE_A]: { version: 1, parties: { reviewer: { runId: '', attempt: 0, attachments: 1 } } } },
      }).ok,
    ).toBe(false);
  });

  test('a lifecycle record that contradicts itself is refused', () => {
    const cases = [
      // A run that has not delivered has admitted nothing.
      [{ status: 'running', attachments: 2 }, 'invalid-state-record'],
      [{ status: 'recoverable', references: [FILE_REF] }, 'invalid-state-record'],
      // A completed run's outcome is its attachments, not a stop reason.
      [{ status: 'completed', reason: 'timeout' }, 'invalid-state-record'],
      [{ reason: 'timeout' }, 'invalid-state-record'],
      // Tokens outside the closed sets, and counts outside the bounds.
      [{ status: 'not_started' }, 'unknown-enum'],
      [{ status: 'finished' }, 'unknown-enum'],
      [{ attachments: MAX_EVIDENCE_ATTACHMENTS_PER_PARTY + 1 }, 'invalid-type'],
      [{ attempt: MAX_DISPUTE_SUB_TURN_ATTEMPT + 1 }, 'invalid-type'],
      [{ artifacts: [{ name: '/tmp/x.json', digest: 'a'.repeat(12), bytes: 2 }] }, 'invalid-type'],
      [{ artifacts: [{ name: `evidence-reviewer-${LINEAGE_A}.json`, digest: 'nope', bytes: 2 }] }, 'invalid-type'],
    ];
    for (const [patch, reason] of cases) {
      const record = {
        lineages: {
          [LINEAGE_A]: {
            version: 1,
            parties: { reviewer: { runId: RUN_REVIEWER, attempt: 0, attachments: 0, ...patch } },
          },
        },
      };
      const result = parseDisputeEvidenceRoundState(record);
      expect(result.ok).toBe(false);
      expect(result.failure.reason).toBe(reason);
      // Content-free locators only: a field path, never a value.
      expect(result.failure.detail).toContain('evidenceRound.lineages');
    }
  });

  test('the record is bounded in every dimension a task may grow', () => {
    // More lineages than a task may hold is a debate this protocol could not
    // have had — and it is the one dimension the record is otherwise open in.
    const many = { lineages: {} };
    for (let i = 0; i < MAX_LINEAGES_PER_TASK + 1; i += 1) {
      many.lineages[`ln-${String(i).padStart(12, '0')}`] = {
        version: 1,
        parties: { reviewer: { runId: RUN_REVIEWER, attempt: 0, attachments: 0 } },
      };
    }
    expect(parseDisputeEvidenceRoundState(many).failure).toMatchObject({ reason: 'too-many-items' });

    // And what the bounds add up to still fits a context column.
    const serialized = serializeEvidenceRoundState(parsed(countOnlyRound()));
    expect(serialized.ok).toBe(true);
    expect(Buffer.byteLength(serialized.value, 'utf8')).toBeLessThanOrEqual(REVIEW_DISPUTE_EVIDENCE_ROUND_MAX_BYTES);
    expect(parsed(JSON.parse(serialized.value))).toEqual(parsed(countOnlyRound()));
  });

  test('a round number the §6.1 limit cannot authorize is refused', () => {
    expect(ABSOLUTE_MAX_EVIDENCE_ROUNDS).toBe(1);
    const record = countOnlyRound();
    record.lineages[LINEAGE_A].round = ABSOLUTE_MAX_EVIDENCE_ROUNDS + 1;
    expect(parseDisputeEvidenceRoundState(record).ok).toBe(false);
    record.lineages[LINEAGE_A].round = ABSOLUTE_MAX_EVIDENCE_ROUNDS;
    expect(parseDisputeEvidenceRoundState(record).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Projections
// ---------------------------------------------------------------------------

describe('evidence round — the projections publish literals only (#956, §10.3/§11)', () => {
  function populated() {
    let state = write(
      completeEvidencePartyRun(emptyEvidenceRound(), coordinates({ party: 'implementer', runId: RUN_IMPLEMENTER }), {
        references: [FILE_REF, QUOTE_REF],
        dropped: 2,
        artifacts: [
          evidenceArtifactRef({ name: evidenceArtifactName('implementer', LINEAGE_A), content: '{"raw":"bytes"}' }),
        ],
      }),
    );
    state = write(completeEvidencePartyRun(state, coordinates(), { references: [DOC_REF] }));
    return markEvidenceRoundRecorded(state, LINEAGE_A, RUN_REVIEWER);
  }

  test('the audit summary is counts, states and nothing else', () => {
    const summary = summarizeEvidenceRound(disputeEvidenceRoundEntry(populated(), LINEAGE_A));
    expect(summary).toEqual({
      version: 1,
      round: 1,
      complete: true,
      recorded: true,
      attachmentsRecorded: 3,
      parties: {
        implementer: { state: 'completed', attempt: 0, attachments: 2, references: 2, dropped: 2, artifacts: 1 },
        reviewer: { state: 'completed', attempt: 0, attachments: 1, references: 1 },
      },
    });
    const serialized = JSON.stringify(summary);
    for (const forbidden of ['src/auth/handler.ts', 'expired token', 'raw', 'evidence-', '/tmp']) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  test('the operator projection reads tolerantly and invents nothing', () => {
    const projected = projectEvidenceRoundStatus(populated());
    expect(projected).toEqual([
      {
        lineageId: LINEAGE_A,
        version: 1,
        round: 1,
        complete: true,
        recorded: true,
        attachmentsRecorded: 3,
        parties: [
          {
            party: 'implementer',
            state: 'completed',
            attempt: 0,
            attachments: 2,
            references: 2,
            dropped: 2,
            artifacts: 1,
            reason: null,
          },
          {
            party: 'reviewer',
            state: 'completed',
            attempt: 0,
            attachments: 1,
            references: 1,
            dropped: 0,
            artifacts: 0,
            reason: null,
          },
        ],
      },
    ]);
    expect(JSON.stringify(projected)).not.toContain('src/auth/handler.ts');

    // No record, an unreadable record, and a record whose fields are the wrong
    // type all project without throwing — and none of them reports a party as
    // having answered.
    expect(projectEvidenceRoundStatus(undefined)).toEqual([]);
    expect(projectEvidenceRoundStatus({ lineages: 'nonsense' })).toEqual([]);
    const [broken] = projectEvidenceRoundStatus({
      lineages: { [LINEAGE_A]: { version: 'one', parties: { reviewer: { status: 'finished', attachments: 'many' } } } },
    });
    expect(broken).toMatchObject({ version: null, round: 1, complete: false, recorded: false });
    expect(broken.parties[0]).toMatchObject({ party: 'implementer', state: 'not_started', attempt: null });
    expect(broken.parties[1]).toMatchObject({ party: 'reviewer', state: 'unreadable', attachments: 0 });

    // The count-only record an older block carries projects as what it means.
    const [legacy] = projectEvidenceRoundStatus(countOnlyRound());
    expect(legacy.parties.find((p) => p.party === 'implementer')).toMatchObject({
      state: 'completed',
      attachments: 2,
      references: 0,
    });
    expect(legacy.complete).toBe(false);
  });

  test('the whole persisted record carries nothing that may not be persisted', () => {
    const serialized = JSON.stringify({ [REVIEW_DISPUTE_EVIDENCE_ROUND_CONTEXT_KEY]: populated() });
    for (const forbidden of ['/tmp', 'C:\\', 'raw":"bytes', 'expired token', 'Bearer ', 'prompt']) {
      expect(serialized).not.toContain(forbidden);
    }
    // What it DOES carry: repo-relative references, bounded ids, and counts.
    expect(serialized).toContain('src/auth/handler.ts');
    expect(serialized).toContain(`evidence-implementer-${LINEAGE_A}.json`);
  });
});

// ---------------------------------------------------------------------------
// Resuming a round (#963)
// ---------------------------------------------------------------------------

describe('evidence round — stable identity and resumable selection (#963)', () => {
  test('the round key is the party-free prefix of every party-run key, and it is stable', () => {
    const round = { lineageId: LINEAGE_A, version: 2, round: 1 };
    expect(evidenceRoundKey(round)).toBe(`${LINEAGE_A}@2/e1`);
    // Absent round is §7.1's single round, exactly as the record reads it.
    expect(evidenceRoundKey({ lineageId: LINEAGE_A, version: 2 })).toBe(`${LINEAGE_A}@2/e1`);
    expect(evidenceRoundDigest(round)).toMatch(/^[0-9a-f]{12}$/);
    expect(evidenceRoundDigest(round)).toBe(evidenceRoundDigest({ lineageId: LINEAGE_A, version: 2 }));
    // Derived, not parallel: the party-run key extends the round key, so the two
    // cannot drift.
    for (const party of ['implementer', 'reviewer']) {
      const key = evidencePartyRunKey(coordinates({ version: 2, party, runId: `r-${party}` }));
      expect(key.startsWith(`${evidenceRoundKey(round)}:${party}.`)).toBe(true);
    }
    // A material revision IS a different identity; so is a later round.
    expect(evidenceRoundKey({ lineageId: LINEAGE_A, version: 3 })).not.toBe(evidenceRoundKey(round));
    expect(evidenceRoundKey({ lineageId: LINEAGE_A, version: 2, round: 1 }))
      .not.toBe(`${LINEAGE_A}@2/e2`);
  });

  test('an answer is on file only for the exact round identity that recorded it', () => {
    const state = parsed(countOnlyRound());
    const entry = disputeEvidenceRoundEntry(state, LINEAGE_A);
    // The #955 count-only record is a completed implementer for round 1 of
    // version 1 — and for nothing else.
    expect(disputeEvidencePartyAnswered(entry, 'implementer', { lineageId: LINEAGE_A, version: 1 })).toBe(true);
    expect(disputeEvidencePartyAnswered(entry, 'reviewer', { lineageId: LINEAGE_A, version: 1 })).toBe(false);
    expect(disputeEvidencePartyAnswered(entry, 'implementer', { lineageId: LINEAGE_A, version: 2 })).toBe(false);
    expect(disputeEvidencePartyAnswered(undefined, 'implementer', { lineageId: LINEAGE_A, version: 1 })).toBe(false);

    // A running or recoverable record is an invocation fact, not an answer.
    const running = write(beginEvidencePartyRun(state, coordinates()));
    expect(disputeEvidencePartyAnswered(disputeEvidenceRoundEntry(running, LINEAGE_A), 'reviewer', {
      lineageId: LINEAGE_A,
      version: 1,
    })).toBe(false);

    // A spent round answers nothing: a later round starts from an empty record.
    const spent = markEvidenceRoundRecorded(state, LINEAGE_A, RUN_IMPLEMENTER);
    expect(disputeEvidencePartyAnswered(disputeEvidenceRoundEntry(spent, LINEAGE_A), 'implementer', {
      lineageId: LINEAGE_A,
      version: 1,
    })).toBe(false);
  });

  test('selection resumes from the missing party, deterministically', () => {
    const round = [{ lineageId: LINEAGE_A, version: 1 }];

    // Zero parties on file: a fresh round starts with the implementer.
    expect(selectEvidenceCollectionParty(emptyEvidenceRound(), round)).toEqual({
      kind: 'collect',
      party: 'implementer',
    });
    // One party on file: only the missing one is selected — never the one whose
    // admitted answer is already on the record, whatever claim recorded it.
    expect(selectEvidenceCollectionParty(parsed(countOnlyRound()), round)).toEqual({
      kind: 'collect',
      party: 'reviewer',
    });
    // A recoverable stop is not an answer: the same party is selected again.
    const stopped = write(markEvidencePartyRunRecoverable(parsed(countOnlyRound()), coordinates(), 'timeout'));
    expect(selectEvidenceCollectionParty(stopped, round)).toEqual({ kind: 'collect', party: 'reviewer' });

    // Both on file: nothing is owed an invocation; a dispatch replays the
    // record and row 22 closes the round.
    const complete = write(completeEvidencePartyRun(parsed(countOnlyRound()), coordinates(), { attachments: 1 }));
    expect(selectEvidenceCollectionParty(complete, round)).toEqual({ kind: 'record' });

    // No lineage, nothing to do.
    expect(selectEvidenceCollectionParty(complete, [])).toEqual({ kind: 'none' });
  });

  test('a materially revised finding restarts the round from the implementer', () => {
    // Both parties answered version 1; the finding is at version 2 now. Nothing
    // of the old round is an answer to the new identity, so selection restarts
    // from the implementer — and the spent flag has the same effect for a round
    // row 22 already closed.
    const complete = write(completeEvidencePartyRun(parsed(countOnlyRound()), coordinates(), { attachments: 1 }));
    expect(selectEvidenceCollectionParty(complete, [{ lineageId: LINEAGE_A, version: 2 }])).toEqual({
      kind: 'collect',
      party: 'implementer',
    });
    const spent = markEvidenceRoundRecorded(complete, LINEAGE_A, RUN_REVIEWER);
    expect(selectEvidenceCollectionParty(spent, [{ lineageId: LINEAGE_A, version: 1 }])).toEqual({
      kind: 'collect',
      party: 'implementer',
    });
  });

  test('a multi-lineage round owes a party as a whole', () => {
    // The implementer answered lineage A but not B (a revision dropped B's
    // record, say): §7.1 dispatches one run per party covering every lineage, so
    // the implementer is still the party owed a run.
    const partial = parsed(countOnlyRound());
    const both = [
      { lineageId: LINEAGE_A, version: 1 },
      { lineageId: LINEAGE_B, version: 1 },
    ];
    expect(selectEvidenceCollectionParty(partial, both)).toEqual({ kind: 'collect', party: 'implementer' });
  });
});
