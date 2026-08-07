/**
 * Unit tests for the material-revision decision (issue #845,
 * docs/review-dispute-contract.md §5 and §7 rows 11, 12, 26).
 *
 * The document is the authority; these tests pin the decision against it. Three
 * properties are asserted over and over, because they are the bounded-debate
 * contract itself:
 *
 *  - only a structurally MATERIAL revision with successor-version budget grants
 *    an implementation response, and it grants exactly one;
 *  - no reviewer reconsideration is ever granted again, whatever the outcome;
 *  - every stale, ambiguous, duplicated, or exhausted input fails closed —
 *    no row, no next state, no granted response.
 *
 * The materiality algorithm itself is #836's and is pinned by
 * `review-dispute.test.js`; what is pinned here is that this layer CALLS it
 * rather than re-deciding, and what it does with the answer.
 */
import { REVIEW_DISPUTE_DEFAULT_LIMITS } from '../dist/core/review-dispute.js';
import {
  checkPredecessor,
  classifyRevisionMateriality,
} from '../dist/core/review-dispute-lineage.js';
import {
  REVISION_DECISION_INTENTS,
  REVISION_DECISION_ROWS,
  REVISION_DECLARATION_DISCREPANCIES,
  decideRevision,
} from '../dist/core/review-revision-decision.js';

const LINEAGE_ID = 'ln-0123456789ab';

const REVIEWER_META = {
  agentId: 'codex',
  model: 'gpt-5-codex',
  effort: 'high',
  reviewRunId: 'run-42',
  timestamp: '2026-08-05T10:00:00.000Z',
};

const FILE_REF = { kind: 'file', path: 'src/core/outbox.ts', startLine: 10, endLine: 20 };

/** A §2.1 finding body at some version. */
function body(overrides = {}) {
  return {
    version: 1,
    severity: 'P1',
    violatedContract: 'Acceptance criterion 3: the retry cursor must rewind inside the CAS transaction.',
    preconditions: 'A retry arrives after the forward cursor advanced past the retried entry.',
    failureScenario: 'retryEntry leaves the cursor ahead, so the retried row is never rescanned.',
    affectedBoundary: 'src/core/outbox.ts',
    requiredOutcome: 'The cursor rewinds to the retried entry before the transaction commits.',
    evidenceRefs: [FILE_REF],
    ...overrides,
  };
}

/** A recorded §2.1 version of this lineage. */
function version(overrides = {}) {
  return { ...body(overrides), lineageId: LINEAGE_ID, humanGate: false, reviewerMeta: REVIEWER_META };
}

/**
 * A §4.2 revision record. `successor` overrides are merged into the version-2
 * candidate, so a test names only the field it is changing.
 */
function revision({ successor = {}, ...overrides } = {}) {
  return {
    predecessorVersion: 1,
    changedFields: ['preconditions'],
    revisionKind: 'corrected_premise',
    materialityClaim: true,
    successor: body({ version: 2, ...successor }),
    ...overrides,
  };
}

function lineage(overrides = {}) {
  const { counters: counterOverrides, ...rest } = overrides;
  return {
    lineageId: LINEAGE_ID,
    state: 'disputed',
    version: 1,
    counters: {
      rebuttals: 1,
      reconsiderations: 0,
      arbitrationPasses: 0,
      malformedArbiterAttempts: 0,
      evidenceRoundsUsed: 0,
      ...counterOverrides,
    },
    rebuttedVersions: [1],
    humanGate: false,
    severity: 'P1',
    affectedBoundary: 'src/core/outbox.ts',
    ...rest,
  };
}

/**
 * Run the decision over the default fixture: a version-1 lineage in `disputed`
 * with one recorded version, its reconsideration round still open.
 */
function decide({ record: recordOverrides = {}, lineage: lineageOverrides = {}, versions, ...rest } = {}) {
  const record = {
    lineageId: LINEAGE_ID,
    version: 1,
    reconsideration: 'revise',
    rationale: 'The premise was wrong; the corrected one still shows the defect.',
    revision: revision(),
    ...recordOverrides,
  };
  return decideRevision({
    admitted: { record, lineage: lineage(lineageOverrides) },
    versions: versions ?? [version()],
    ...rest,
  });
}

/** Every decision, whatever its outcome, must hold the bounded-debate invariants. */
function expectNoFurtherDebate(decision) {
  expect(decision.furtherReconsiderationAllowed).toBe(false);
  expect(decision.implementationResponsesGranted).toBe(0);
  expect(decision.candidateAdmitted).toBe(false);
  expect(decision.versionAfter).toBe(decision.disputedVersion);
}

function expectRejected(decision, reason, detail) {
  expect(decision.intent).toBe('rejected');
  expect(decision.failure).toEqual({ reason, detail });
  expect(decision.row).toBeNull();
  expect(decision.nextState).toBeNull();
  expect(decision.materiality).toBeNull();
  expect(decision.declaration).toBeNull();
  // §12: malformed input changes no state and wins nothing for either party.
  expect(decision.auditEvents).toEqual(['dispute.rebuttal.rejected']);
  expectNoFurtherDebate(decision);
}

// ---------------------------------------------------------------------------
// Row 11: material with version budget
// ---------------------------------------------------------------------------

describe('a material revision with version budget (§7 row 11)', () => {
  const materialRevision = revision({
    changedFields: ['preconditions'],
    successor: { preconditions: 'The maintenance lock is held by another process while the scan runs.' },
  });

  test('admits the version-2 candidate and grants exactly one final response', () => {
    const decision = decide({ record: { revision: materialRevision } });
    expect(decision.intent).toBe('final_implementation_response');
    expect(decision.row).toBe(11);
    expect(decision.nextState).toBe('open');
    expect(decision.lineageId).toBe(LINEAGE_ID);
    expect(decision.disputedVersion).toBe(1);
    expect(decision.versionAfter).toBe(2);
    expect(decision.candidateAdmitted).toBe(true);
    expect(decision.candidate).toEqual(materialRevision.successor);
    expect(decision.implementationResponsesGranted).toBe(1);
    expect(decision.failure).toBeNull();
    expect(decision.predecessorProblem).toBeNull();
    // §10.3: exactly the classification's own event, preserved verbatim.
    expect(decision.auditEvents).toEqual(['dispute.revision.material']);
    // §6.2: the response to version 2 is row 6 — arbitration, never a second
    // reviewer turn.
    expect(decision.furtherReconsiderationAllowed).toBe(false);
  });

  test('the classification is #836\'s, not a second implementation of it', () => {
    const decision = decide({ record: { revision: materialRevision } });
    expect(decision.materiality).toEqual(classifyRevisionMateriality(version(), materialRevision));
  });

  test('the decision is a pure function of its inputs', () => {
    const first = decide({ record: { revision: materialRevision } });
    const second = decide({ record: { revision: materialRevision } });
    expect(second).toEqual(first);
    // The version history is a set, not a sequence: the order it arrives in
    // cannot change the answer.
    const history = [version(), version({ version: 2 })];
    expect(decide({ versions: history })).toEqual(decide({ versions: [...history].reverse() }));
  });

  test('every §5 material field category reaches row 11', () => {
    const cases = [
      ['violatedContract', { violatedContract: 'Acceptance criterion 5: the maintenance lock is checked in-transaction.' }],
      ['preconditions', { preconditions: 'The maintenance lock is held by another process while the scan runs.' }],
      ['requiredOutcome', { requiredOutcome: 'The enqueue refuses while maintenance holds the lock.' }],
      ['affectedBoundary', { affectedBoundary: 'src/core/outbox-effects.ts' }],
    ];
    for (const [field, successor] of cases) {
      const decision = decide({ record: { revision: revision({ changedFields: [field], successor }) } });
      expect([field, decision.row]).toEqual([field, 11]);
      expect(decision.materiality.materialFields).toEqual([field]);
      expect(decision.implementationResponsesGranted).toBe(1);
    }
  });

  test('added evidence is material only when it invalidates a rebuttal premise', () => {
    const added = { kind: 'test', name: 'outbox retry rewinds the cursor' };
    const request = { record: { revision: revision({ changedFields: ['evidenceRefs'], successor: { evidenceRefs: [FILE_REF, added] } }) } };

    // Without the injected predicate the runner cannot verify the claim, so the
    // conservative answer routes to arbitration rather than granting a round.
    const unverified = decide(request);
    expect(unverified.intent).toBe('arbitration');
    expect(unverified.row).toBe(12);

    const verified = decide({
      ...request,
      materialityOptions: { addedEvidenceInvalidatesRebuttal: (refs) => refs.some((ref) => ref.kind === 'test') },
    });
    expect(verified.row).toBe(11);
    expect(verified.materiality.materialFields).toEqual(['evidenceRefs']);
  });

  test('several changed fields are decided together', () => {
    const decision = decide({
      record: {
        revision: revision({
          changedFields: ['severity', 'preconditions', 'affectedBoundary'],
          successor: {
            severity: 'P2',
            preconditions: 'The maintenance lock is held by another process while the scan runs.',
            affectedBoundary: 'src/core/outbox-effects.ts',
          },
        }),
      },
    });
    expect(decision.row).toBe(11);
    expect(decision.materiality.materialFields).toEqual(['preconditions', 'affectedBoundary']);
    // The never-material field still counts as an effective change for audit.
    expect(decision.declaration.effectiveChangedFields).toEqual([
      'severity',
      'preconditions',
      'affectedBoundary',
    ]);
    expect(decision.declaration.changedFieldsHonest).toBe(true);
    expect(decision.declaration.discrepancies).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Row 12: non-material and ambiguous
// ---------------------------------------------------------------------------

describe('a non-material or ambiguous revision (§7 row 12)', () => {
  const route = (decision) => {
    expect(decision.intent).toBe('arbitration');
    expect(decision.row).toBe(12);
    expect(decision.nextState).toBe('arbitration_pending');
    expect(decision.failure).toBeNull();
    // §4.2, §8.2: unpersisted, but it still travels to the arbiter.
    expect(decision.candidate).not.toBeNull();
    expectNoFurtherDebate(decision);
  };

  test('never grants another implementation response, for any never-material category', () => {
    const base = body();
    const cases = [
      // Wording-only edit.
      ['preconditions', { preconditions: 'after the forward cursor advanced past the retried entry, a retry arrives' }],
      // Line-number movement inside the same affectedBoundary.
      ['affectedBoundary', { affectedBoundary: 'src/core/outbox.ts:40-60' }],
      // Severity only.
      ['severity', { severity: 'P2' }],
      // Restating the same failure scenario in different words.
      ['failureScenario', { failureScenario: 'the retried row is never rescanned, so retryEntry leaves the cursor ahead' }],
      // An added example: never material, and the runner does not guess further.
      ['preconditions', { preconditions: `${base.preconditions} For example, entry 12 in the retry fixture.` }],
    ];
    for (const [field, successor] of cases) {
      const decision = decide({ record: { revision: revision({ changedFields: [field], successor }) } });
      route(decision);
      expect(decision.materiality.classification).not.toBe('material');
      expect(decision.materiality.materialFields).toEqual([]);
    }
  });

  test('an undecidable rewrite is ambiguous and goes to arbitration, not to another rebuttal', () => {
    const decision = decide({
      record: {
        revision: revision({
          changedFields: ['failureScenario'],
          successor: { failureScenario: 'The scan skips an entry whose visibility window closed mid-transaction.' },
        }),
      },
    });
    route(decision);
    expect(decision.materiality.classification).toBe('ambiguous');
    expect(decision.materiality.ambiguousFields).toEqual(['failureScenario']);
    expect(decision.auditEvents).toEqual(['dispute.revision.ambiguous']);
  });

  test('a revision that changes nothing at all is non-material, and says so', () => {
    const decision = decide({
      record: { revision: revision({ changedFields: ['violatedContract', 'preconditions'], successor: {} }) },
    });
    route(decision);
    expect(decision.auditEvents).toEqual(['dispute.revision.non_material']);
    expect(decision.declaration.ignoredDeclaredFields).toEqual(['violatedContract', 'preconditions']);
    expect(decision.declaration.effectiveChangedFields).toEqual([]);
    expect(decision.declaration.changedFieldsHonest).toBe(false);
    expect(decision.declaration.discrepancies).toEqual([
      'declared-unchanged',
      'no-effective-change',
      'overclaimed-materiality',
    ]);
  });
});

// ---------------------------------------------------------------------------
// §5, §14.2: the declaration is audited, never trusted
// ---------------------------------------------------------------------------

describe('changedFields and materialityClaim are audit input only (§5, §14.2)', () => {
  test('an undeclared change cannot hide a material revision', () => {
    // The reviewer declares only the never-material field while actually moving
    // the boundary: the decision is made on the recorded values regardless.
    const decision = decide({
      record: {
        revision: revision({
          changedFields: ['severity'],
          materialityClaim: false,
          successor: { severity: 'P2', affectedBoundary: 'src/core/session.ts' },
        }),
      },
    });
    expect(decision.row).toBe(11);
    expect(decision.materiality.materialFields).toEqual(['affectedBoundary']);
    expect(decision.declaration.declaredFields).toEqual(['severity']);
    expect(decision.declaration.undeclaredChangedFields).toEqual(['affectedBoundary']);
    expect(decision.declaration.changedFieldsHonest).toBe(false);
    expect(decision.declaration.discrepancies).toContain('undeclared-change');
    expect(decision.declaration.discrepancies).toContain('underclaimed-materiality');
  });

  test('a declared field that did not change cannot manufacture a material revision', () => {
    const decision = decide({
      record: {
        revision: revision({
          changedFields: ['violatedContract', 'affectedBoundary', 'requiredOutcome'],
          materialityClaim: true,
          successor: { severity: 'P2' },
        }),
      },
    });
    expect(decision.intent).toBe('arbitration');
    expect(decision.row).toBe(12);
    expect(decision.materiality.classification).toBe('non_material');
    expect(decision.declaration.ignoredDeclaredFields).toEqual([
      'violatedContract',
      'affectedBoundary',
      'requiredOutcome',
    ]);
    expect(decision.declaration.claimMatchedDecision).toBe(false);
    expect(decision.declaration.discrepancies).toContain('overclaimed-materiality');
    expectNoFurtherDebate(decision);
  });

  test('the claim never decides in either direction', () => {
    const claimed = decide({
      record: { revision: revision({ changedFields: ['severity'], materialityClaim: true, successor: { severity: 'P2' } }) },
    });
    expect(claimed.row).toBe(12);

    const disclaimed = decide({
      record: {
        revision: revision({
          changedFields: ['affectedBoundary'],
          materialityClaim: false,
          successor: { affectedBoundary: 'src/core/session.ts' },
        }),
      },
    });
    expect(disclaimed.row).toBe(11);
    expect(disclaimed.declaration.materialityClaim).toBe(false);
    expect(disclaimed.declaration.claimMatchedDecision).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §6.1: lowered limits and the bounded debate
// ---------------------------------------------------------------------------

describe('bounded debate (§6.1, §6.2)', () => {
  const material = revision({
    changedFields: ['affectedBoundary'],
    successor: { affectedBoundary: 'src/core/outbox-effects.ts' },
  });

  test('a material revision with no successor-version budget arbitrates unpersisted (row 26)', () => {
    const decision = decide({
      record: { revision: material },
      limits: { ...REVIEW_DISPUTE_DEFAULT_LIMITS, maxVersionsPerLineage: 1 },
    });
    expect(decision.intent).toBe('arbitration');
    expect(decision.row).toBe(26);
    expect(decision.nextState).toBe('arbitration_pending');
    // The candidate still exists — it fed the §5 check and travels to the
    // arbiter — but the lineage stays at the disputed version.
    expect(decision.candidate).toEqual(material.successor);
    expect(decision.materiality.classification).toBe('material');
    expect(decision.auditEvents).toEqual(['dispute.revision.material']);
    expectNoFurtherDebate(decision);
  });

  test('rows 11 and 26 partition the same material revision by the version budget alone', () => {
    const admitted = decide({ record: { revision: material } });
    const refused = decide({
      record: { revision: material },
      limits: { ...REVIEW_DISPUTE_DEFAULT_LIMITS, maxVersionsPerLineage: 1 },
    });
    expect(admitted.materiality).toEqual(refused.materiality);
    expect([admitted.row, refused.row]).toEqual([11, 26]);
  });

  test('a raised limit still cannot mint a third version', () => {
    // `limits` is a plain value; only the session resolver guarantees it was
    // lowered rather than raised. A raised one widens nothing, because the
    // absolute ceiling of §2.3 refuses the successor before the budget is asked.
    const decision = decide({
      record: { revision: revision({ predecessorVersion: 1, successor: { version: 3 } }) },
      limits: { ...REVIEW_DISPUTE_DEFAULT_LIMITS, maxVersionsPerLineage: 9 },
    });
    expectRejected(decision, 'invalid-version', 'revision:successor-not-incremental');
    expect(decision.predecessorProblem).toBe('successor-not-incremental');
  });

  test('a version-2 lineage never receives a second reconsideration (§6.2)', () => {
    const decision = decide({
      record: { version: 2, revision: revision({ predecessorVersion: 2, successor: { version: 3 } }) },
      lineage: { version: 2, rebuttedVersions: [1, 2], counters: { rebuttals: 2, reconsiderations: 1 } },
      versions: [version(), version({ version: 2 })],
    });
    expectRejected(decision, 'not-actionable-state', 'lineage.version:2:no-second-reconsideration');
  });

  test('a spent reconsideration budget fails closed rather than opening a round', () => {
    expectRejected(
      decide({ lineage: { counters: { reconsiderations: 1 } } }),
      'reconsideration-slot-consumed',
      'lineage.counters.reconsiderations:1',
    );
    // A session that configured the round away (row 25) has no round to re-enter.
    expectRejected(
      decide({ limits: { ...REVIEW_DISPUTE_DEFAULT_LIMITS, maxReconsiderationsPerLineage: 0 } }),
      'reconsideration-slot-consumed',
      'lineage.counters.reconsiderations:0',
    );
  });
});

// ---------------------------------------------------------------------------
// §12: fail-closed inputs
// ---------------------------------------------------------------------------

describe('fail-closed decisions (§12)', () => {
  test('a lineage that is not awaiting this decision is refused', () => {
    for (const state of ['open', 'arbitration_pending', 'binding', 'evidence_requested', 'resolved_fixed', 'escalated_human']) {
      expectRejected(decide({ lineage: { state } }), 'not-actionable-state', `lineage.state:${state}`);
    }
  });

  test('a record for another lineage or another version is refused', () => {
    expectRejected(
      decide({ record: { lineageId: 'ln-ffffffffffff' } }),
      'unknown-lineage',
      'reconsideration.lineageId:ln-ffffffffffff',
    );
    expectRejected(decide({ record: { version: 2 } }), 'stale-version', 'reconsideration.version:2');
  });

  test('a revision aimed at a version other than the disputed one is stale (§4.2)', () => {
    expectRejected(
      decide({ record: { revision: revision({ predecessorVersion: 2 }) } }),
      'stale-version',
      'revision.predecessorVersion:2',
    );
  });

  test('a predecessor that is missing, ambiguous, or already succeeded is refused (§2.3)', () => {
    // Missing: the disputed version is not in the recorded history.
    const missing = decide({ versions: [version({ version: 2 })] });
    expectRejected(missing, 'stale-version', 'revision:predecessor-not-found');
    expect(missing.predecessorProblem).toBe('predecessor-not-found');

    // Ambiguous: two records claim the disputed version, so "exactly one
    // predecessor" does not hold and no comparison can be trusted.
    const ambiguous = decide({ versions: [version(), version({ severity: 'P2' })] });
    expectRejected(ambiguous, 'duplicate-version', 'revision:predecessor-ambiguous');
    expect(ambiguous.predecessorProblem).toBe('predecessor-ambiguous');

    // Already succeeded: the successor version this revision proposes is already
    // on file, so the lineage record and the findings disagree.
    const superseded = decide({ versions: [version(), version({ version: 2 })] });
    expectRejected(superseded, 'stale-version', 'revision:predecessor-not-current');
    expect(superseded.predecessorProblem).toBe('predecessor-not-current');
  });

  test('the refusals agree field for field with #836\'s own rule', () => {
    const versions = [version(), version({ severity: 'P2' })];
    const problem = checkPredecessor(versions, revision()).problem;
    expect(decide({ versions }).failure.detail).toBe(`revision:${problem}`);
  });

  test('a skipped successor version is refused', () => {
    expectRejected(
      decide({ record: { revision: revision({ successor: { version: 3 } }) } }),
      'invalid-version',
      'revision:successor-not-incremental',
    );
  });

  test('an empty or foreign version history is refused', () => {
    expectRejected(decide({ versions: [] }), 'missing-field', 'versions:empty');
    expectRejected(
      decide({ versions: [version(), { ...version(), lineageId: 'ln-ffffffffffff', version: 2 }] }),
      'duplicate-lineage',
      'versions[1].lineageId',
    );
  });

  test('a `revise` without its revision record is malformed (§4.2)', () => {
    expectRejected(
      decide({ record: { revision: undefined } }),
      'invalid-revision',
      'reconsideration.revision:missing',
    );
  });
});

// ---------------------------------------------------------------------------
// withdraw / uphold
// ---------------------------------------------------------------------------

describe('reconsiderations that carry no revision', () => {
  test('withdraw and uphold decide nothing here (rows 9 and 10)', () => {
    for (const reconsideration of ['withdraw', 'uphold']) {
      const decision = decide({ record: { reconsideration, revision: undefined } });
      expect(decision.intent).toBe('no_revision');
      expect(decision.row).toBeNull();
      expect(decision.nextState).toBeNull();
      expect(decision.materiality).toBeNull();
      expect(decision.declaration).toBeNull();
      expect(decision.failure).toBeNull();
      // No transition is claimed, so no event is emitted for one.
      expect(decision.auditEvents).toEqual([]);
      expectNoFurtherDebate(decision);
    }
  });
});

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

describe('result vocabulary', () => {
  test('the intents, rows, and discrepancies are closed lists', () => {
    expect(REVISION_DECISION_INTENTS).toEqual([
      'final_implementation_response',
      'arbitration',
      'no_revision',
      'rejected',
    ]);
    expect(REVISION_DECISION_ROWS).toEqual([11, 12, 26]);
    expect(REVISION_DECLARATION_DISCREPANCIES).toEqual([
      'undeclared-change',
      'declared-unchanged',
      'no-effective-change',
      'overclaimed-materiality',
      'underclaimed-materiality',
    ]);
  });
});
