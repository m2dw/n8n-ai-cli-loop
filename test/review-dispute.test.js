/**
 * Unit tests for the review-dispute domain contracts (issue #836,
 * docs/review-dispute-contract.md).
 *
 * The document is the authority; these tests pin the implementation against it:
 * the closed vocabularies of §1, the finding/lineage/version rules of §2, the
 * disposition and dispute schema of §3, reconsideration and revision of §4, the
 * deterministic materiality check of §5, the bounded-debate limits of §6.1, the
 * arbiter verdict of §8.1, the persisted state of §10.1, the artifact names of
 * §10.2, the fail-closed rules of §12, and the legacy compatibility path of §13.
 *
 * The governing property throughout is that nothing here decides a dispute:
 * every malformed, stale, duplicated, or oversized record is REJECTED, and a
 * rejection never consumes a bounded counter.
 */
import {
  ABSOLUTE_MAX_VERSION,
  ARBITER_VERDICTS,
  DECISIVE_ARBITER_VERDICTS,
  DEFAULT_ARBITER_MIN_CONFIDENCE,
  DISPUTE_ACTOR_ROLES,
  DISPUTE_AUDIT_EVENTS,
  EVIDENCE_REF_KINDS,
  FINDING_FIELD_NAMES,
  FINDING_SEVERITIES,
  IMPLEMENTATION_DISPOSITIONS,
  LINEAGE_STATES,
  LINEAGE_STATE_INFO,
  MATERIAL_FINDING_FIELDS,
  MAX_LINEAGES_PER_TASK,
  REBUTTAL_REASONS,
  REVIEWER_RECONSIDERATIONS,
  REVIEW_DISPUTE_CONTEXT_MAX_BYTES,
  REVIEW_DISPUTE_DEFAULT_LIMITS,
  REVIEW_DISPUTE_LIMIT_SPECS,
  REVISION_KINDS,
  REVIEW_STRUCTURE_MODES,
  TERMINAL_LINEAGE_STATES,
  ZERO_LINEAGE_COUNTERS,
  allowsZeroChangeRun,
  awaitsImplementer,
  classifyReviewStructure,
  dispositionAllowedForState,
  emptyReviewDisputeContext,
  isMaterialFindingField,
  isProgressLineageState,
  isTerminalLineageState,
  legacyFindingFromReviewFeedback,
  resolveReviewDisputeSettings,
  reviewStructureAllowsZeroChange,
} from '../dist/core/review-dispute.js';
import {
  admitArbiterVerdict,
  admitDisposition,
  admitFinding,
  admitReconsideration,
  isDisputeActorRole,
  normalizeAffectedBoundary,
  parseBoundedJson,
  parseReviewDisputeContext,
  validateArbiterVerdict,
  validateCandidateFinding,
  validateDispositionSet,
  validateEvidenceRef,
  validateFindingSet,
  validateLineageVersionHistory,
  validatePersistedLineage,
  validateReconsiderationRecord,
  validateReviewDisputeContext,
} from '../dist/core/review-dispute-validation.js';
import {
  LINEAGE_ID_RE,
  arbitrationArtifactName,
  boundaryIdentity,
  checkPredecessor,
  classifyCandidateAdmission,
  classifyRevisionMateriality,
  disputeArtifactName,
  findingIdentityHash,
  isStaleVersion,
  lineageBudgetExhausted,
  mintLineageId,
  publicLineageOutcome,
  reconsiderationArtifactName,
  serializeRecord,
  serializeReviewDisputeContext,
  stableStringify,
} from '../dist/core/review-dispute-lineage.js';

const REPO_ROOT = '/Users/tester/work/repo';

const REVIEWER_META = {
  agentId: 'codex',
  model: 'gpt-5-codex',
  effort: 'high',
  reviewRunId: 'run-42',
  timestamp: '2026-08-03T10:00:00.000Z',
};

const FILE_REF = { kind: 'file', path: 'src/core/outbox.ts', startLine: 10, endLine: 20 };

function candidate(overrides = {}) {
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

function counters(overrides = {}) {
  return {
    rebuttals: 0,
    reconsiderations: 0,
    arbitrationPasses: 0,
    malformedArbiterAttempts: 0,
    evidenceRoundsUsed: 0,
    ...overrides,
  };
}

function lineage(overrides = {}) {
  const { counters: counterOverrides, ...rest } = overrides;
  return {
    lineageId: 'ln-0123456789ab',
    state: 'open',
    version: 1,
    counters: counters(counterOverrides),
    rebuttedVersions: [],
    humanGate: false,
    severity: 'P1',
    affectedBoundary: 'src/core/outbox.ts',
    ...rest,
  };
}

function dispute(overrides = {}) {
  return {
    challenged: { lineageId: 'ln-0123456789ab', version: 1 },
    rebuttalReason: 'already_covered',
    argument: 'The rewind already happens: retryEntry runs the UPDATE inside the same CAS transaction.',
    evidenceRefs: [FILE_REF, { kind: 'test', name: 'outbox-retry-cursor-rewind rewinds on retry' }],
    whyNoChange: 'Adding a second rewind would double-apply the cursor move and skip an entry.',
    ...overrides,
  };
}

function disposition(overrides = {}) {
  return { lineageId: 'ln-0123456789ab', version: 1, disposition: 'fixed', ...overrides };
}

function reconsideration(overrides = {}) {
  return {
    lineageId: 'ln-0123456789ab',
    version: 1,
    reconsideration: 'withdraw',
    rationale: 'The cited test does cover the scenario; the finding rested on a stale reading.',
    ...overrides,
  };
}

function revision(overrides = {}) {
  return {
    predecessorVersion: 1,
    changedFields: ['preconditions'],
    revisionKind: 'narrowed_scope',
    materialityClaim: true,
    successor: candidate({ version: 2 }),
    ...overrides,
  };
}

function verdict(overrides = {}) {
  return {
    lineageId: 'ln-0123456789ab',
    version: 1,
    verdict: 'reviewer_correct',
    confidence: 0.9,
    rationale: 'The cited transaction does not include the cursor update.',
    ...overrides,
  };
}

/** Finding-admission context: a freshly minted lineage whose evidence resolves. */
function admissionCtx(overrides = {}) {
  return { admission: { kind: 'new' }, resolveEvidenceRef: () => true, ...overrides };
}

/** An already-admitted, immutable finding record (§2.1, §2.3). */
function recorded(overrides = {}) {
  return {
    ...candidate(overrides),
    lineageId: 'ln-0123456789ab',
    humanGate: false,
    reviewerMeta: REVIEWER_META,
  };
}

/** Admission context whose evidence always resolves. */
function dispositionCtx(overrides = {}) {
  return {
    lineages: { 'ln-0123456789ab': lineage() },
    runProducedFileChanges: true,
    resolveEvidenceRef: () => true,
    ...overrides,
  };
}

function expectFailure(result, reason) {
  expect(result.ok).toBe(false);
  expect(result.failure.reason).toBe(reason);
}

// ---------------------------------------------------------------------------
// §1 Canonical vocabulary
// ---------------------------------------------------------------------------

describe('canonical vocabulary (§1)', () => {
  test('every closed enum matches the contract verbatim', () => {
    expect([...IMPLEMENTATION_DISPOSITIONS]).toEqual(['fixed', 'review_disputed', 'blocked']);
    expect([...REVIEWER_RECONSIDERATIONS]).toEqual(['withdraw', 'uphold', 'revise']);
    expect([...ARBITER_VERDICTS]).toEqual([
      'reviewer_correct',
      'implementer_correct',
      'spec_ambiguous',
      'insufficient_evidence',
    ]);
    expect([...DECISIVE_ARBITER_VERDICTS]).toEqual(['reviewer_correct', 'implementer_correct']);
    expect([...LINEAGE_STATES]).toEqual([
      'open',
      'disputed',
      'arbitration_pending',
      'evidence_requested',
      'binding',
      'resolved_fixed',
      'resolved_withdrawn',
      'resolved_overruled',
      'escalated_human',
    ]);
    expect([...FINDING_SEVERITIES]).toEqual(['P1', 'P2']);
    expect([...REBUTTAL_REASONS]).toEqual([
      'false_premise',
      'contradicts_issue_contract',
      'already_covered',
      'would_reduce_correctness',
      'out_of_scope',
    ]);
    expect([...REVISION_KINDS]).toEqual(['narrowed_scope', 'corrected_premise', 'new_evidence', 'restated']);
    expect([...DISPUTE_ACTOR_ROLES]).toEqual(['implementer', 'reviewer', 'arbiter', 'runner']);
    expect([...EVIDENCE_REF_KINDS]).toEqual(['file', 'test', 'doc_section', 'issue_quote']);
    expect([...REVIEW_STRUCTURE_MODES]).toEqual(['legacy', 'mixed', 'structured']);
  });

  test('the §10.3 audit-event vocabulary is complete', () => {
    expect([...DISPUTE_AUDIT_EVENTS]).toEqual([
      'dispute.finding.opened',
      'dispute.rebuttal.recorded',
      'dispute.rebuttal.rejected',
      'dispute.reconsideration.recorded',
      'dispute.revision.material',
      'dispute.revision.non_material',
      'dispute.revision.ambiguous',
      'dispute.arbitration.verdict',
      'dispute.arbitration.malformed',
      'dispute.evidence.requested',
      'dispute.reopen.requested',
      'dispute.escalated.human',
      'dispute.resolved',
    ]);
  });

  test('the per-state table covers every state exactly once', () => {
    // The table is what keeps the compile-time type and the runtime facts from
    // drifting: a new state cannot be added without declaring its behavior.
    expect(Object.keys(LINEAGE_STATE_INFO).sort()).toEqual([...LINEAGE_STATES].sort());
  });

  test('terminal states are exactly the four outcome literals', () => {
    expect([...TERMINAL_LINEAGE_STATES]).toEqual([
      'resolved_fixed',
      'resolved_withdrawn',
      'resolved_overruled',
      'escalated_human',
    ]);
    for (const state of LINEAGE_STATES) {
      expect(isTerminalLineageState(state)).toBe(TERMINAL_LINEAGE_STATES.includes(state));
      // §11: `binding` is not a resolution and never receives its own comment.
      expect(LINEAGE_STATE_INFO[state].publishableOutcome).toBe(TERMINAL_LINEAGE_STATES.includes(state));
    }
    expect(LINEAGE_STATE_INFO.binding.publishableOutcome).toBe(false);
  });

  test('§7.1 rule 2 selects an implementer turn for open and binding only', () => {
    const waiting = LINEAGE_STATES.filter((state) => awaitsImplementer(state));
    expect(waiting).toEqual(['open', 'binding']);
  });

  test('§3.4 progress states are disputed, arbitration_pending, evidence_requested', () => {
    expect(LINEAGE_STATES.filter((state) => isProgressLineageState(state))).toEqual([
      'disputed',
      'arbitration_pending',
      'evidence_requested',
    ]);
  });

  test('§3.4 zero-change runs are valid for progress and no-change terminal states', () => {
    expect(LINEAGE_STATES.filter((state) => allowsZeroChangeRun(state))).toEqual([
      'disputed',
      'arbitration_pending',
      'evidence_requested',
      'resolved_withdrawn',
      'resolved_overruled',
    ]);
    // A `resolved_fixed` lineage always implies a diff (§7.1 rule 4).
    expect(allowsZeroChangeRun('resolved_fixed')).toBe(false);
  });

  test('the per-state table declares facts only, never reachability (#840)', () => {
    // #836 owns the vocabulary and the per-state facts; whether a state is
    // reachable under a session's configured §6.1 limits, and which counters a
    // transition requires, are questions about the §7 machine and belong to the
    // transition orchestration Issue. Pinning the field set here is what keeps a
    // reachability fact from creeping back into the schema module.
    for (const state of LINEAGE_STATES) {
      expect(Object.keys(LINEAGE_STATE_INFO[state]).sort()).toEqual([
        'awaitsImplementer',
        'noChangeRequired',
        'progress',
        'publishableOutcome',
        'terminal',
      ]);
    }
  });

  test('a binding version accepts only fixed or blocked (§3.1, row 24)', () => {
    expect(dispositionAllowedForState('binding', 'fixed')).toBe(true);
    expect(dispositionAllowedForState('binding', 'blocked')).toBe(true);
    expect(dispositionAllowedForState('binding', 'review_disputed')).toBe(false);
    for (const value of IMPLEMENTATION_DISPOSITIONS) {
      expect(dispositionAllowedForState('open', value)).toBe(true);
      expect(dispositionAllowedForState('disputed', value)).toBe(false);
    }
  });

  test('the §5 material field list excludes severity', () => {
    expect([...MATERIAL_FINDING_FIELDS]).toEqual([
      'violatedContract',
      'preconditions',
      'failureScenario',
      'affectedBoundary',
      'requiredOutcome',
      'evidenceRefs',
    ]);
    expect(MATERIAL_FINDING_FIELDS).not.toContain('severity');
    expect([...FINDING_FIELD_NAMES]).toContain('severity');
    for (const field of FINDING_FIELD_NAMES) {
      expect(isMaterialFindingField(field)).toBe(MATERIAL_FINDING_FIELDS.includes(field));
    }
  });

  test('a fresh lineage starts every §6.1 counter at zero', () => {
    expect(ZERO_LINEAGE_COUNTERS).toEqual({
      rebuttals: 0,
      reconsiderations: 0,
      arbitrationPasses: 0,
      malformedArbiterAttempts: 0,
      evidenceRoundsUsed: 0,
    });
    expect(DISPUTE_ACTOR_ROLES.every((role) => isDisputeActorRole(role))).toBe(true);
    expect(isDisputeActorRole('operator')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §6.1 Limits
// ---------------------------------------------------------------------------

describe('protocol limits (§6.1)', () => {
  test('defaults are the normative constants', () => {
    expect(REVIEW_DISPUTE_DEFAULT_LIMITS).toEqual({
      maxRebuttalsPerVersion: 1,
      maxVersionsPerLineage: 2,
      maxReconsiderationsPerLineage: 1,
      maxArbitrationPassesPerLineage: 2,
      maxMalformedArbiterAttemptsPerLineage: 2,
      maxEvidenceRoundsPerLineage: 1,
    });
    expect(ABSOLUTE_MAX_VERSION).toBe(2);
  });

  test('an absent or empty config resolves to the defaults, protocol off', () => {
    for (const cfg of [undefined, {}, { limits: {} }]) {
      const resolved = resolveReviewDisputeSettings(cfg);
      expect(resolved.ok).toBe(true);
      expect(resolved.settings.enabled).toBe(false);
      expect(resolved.settings.limits).toEqual(REVIEW_DISPUTE_DEFAULT_LIMITS);
      expect(resolved.settings.arbiter).toEqual({
        providers: [],
        allowSameProvider: false,
        minConfidence: DEFAULT_ARBITER_MIN_CONFIDENCE,
      });
    }
  });

  test('the four positive-only limits reject 0 at session load', () => {
    const positiveOnly = [
      'maxRebuttalsPerVersion',
      'maxVersionsPerLineage',
      'maxArbitrationPassesPerLineage',
      'maxMalformedArbiterAttemptsPerLineage',
    ];
    for (const key of positiveOnly) {
      expect(REVIEW_DISPUTE_LIMIT_SPECS[key].min).toBe(1);
      const resolved = resolveReviewDisputeSettings({ enabled: true, limits: { [key]: 0 } });
      expect(resolved.ok).toBe(false);
      expect(resolved.errors).toHaveLength(1);
      expect(resolved.errors[0].code).toBe('below-minimum');
      expect(resolved.errors[0].constant).toBe(REVIEW_DISPUTE_LIMIT_SPECS[key].constant);
      // Fail closed: a session that wants the protocol off says so explicitly.
      expect(resolved.errors[0].message).toContain('reviewDispute.enabled: false');
    }
  });

  test('the two zero-able limits keep their explicit fallback transitions', () => {
    // §6.1: `MAX_RECONSIDERATIONS_PER_LINEAGE = 0` fires row 25, and an
    // evidence-round budget of 0 fires row 17's unavailable-round event.
    for (const key of ['maxReconsiderationsPerLineage', 'maxEvidenceRoundsPerLineage']) {
      expect(REVIEW_DISPUTE_LIMIT_SPECS[key].min).toBe(0);
      const resolved = resolveReviewDisputeSettings({ enabled: true, limits: { [key]: 0 } });
      expect(resolved.ok).toBe(true);
      expect(resolved.settings.limits[key]).toBe(0);
    }
  });

  test('limits may be lowered but never raised', () => {
    const lowered = resolveReviewDisputeSettings({ limits: { maxVersionsPerLineage: 1 } });
    expect(lowered.ok).toBe(true);
    expect(lowered.settings.limits.maxVersionsPerLineage).toBe(1);

    const raised = resolveReviewDisputeSettings({ limits: { maxVersionsPerLineage: 3 } });
    expect(raised.ok).toBe(false);
    expect(raised.errors[0].code).toBe('above-default');

    const raisedRebuttals = resolveReviewDisputeSettings({ limits: { maxRebuttalsPerVersion: 2 } });
    expect(raisedRebuttals.ok).toBe(false);
    expect(raisedRebuttals.errors[0].code).toBe('above-default');
  });

  test('non-integer and negative limits are rejected', () => {
    expect(resolveReviewDisputeSettings({ limits: { maxVersionsPerLineage: 1.5 } }).ok).toBe(false);
    expect(resolveReviewDisputeSettings({ limits: { maxVersionsPerLineage: '1' } }).ok).toBe(false);
    const negative = resolveReviewDisputeSettings({ limits: { maxEvidenceRoundsPerLineage: -1 } });
    expect(negative.ok).toBe(false);
    expect(negative.errors[0].code).toBe('below-minimum');
  });

  test('every invalid limit is reported, not just the first', () => {
    const resolved = resolveReviewDisputeSettings({
      limits: { maxRebuttalsPerVersion: 0, maxArbitrationPassesPerLineage: 0 },
    });
    expect(resolved.ok).toBe(false);
    expect(resolved.errors.map((e) => e.constant)).toEqual([
      'MAX_REBUTTALS_PER_VERSION',
      'MAX_ARBITRATION_PASSES_PER_LINEAGE',
    ]);
  });

  test('arbiter policy validation (§8.3)', () => {
    const ok = resolveReviewDisputeSettings({
      enabled: true,
      arbiter: { providers: ['gemini', 'claude'], allowSameProvider: true, minConfidence: 0.55 },
    });
    expect(ok.ok).toBe(true);
    expect(ok.settings.arbiter).toEqual({
      providers: ['gemini', 'claude'],
      allowSameProvider: true,
      minConfidence: 0.55,
    });
    expect(resolveReviewDisputeSettings({ arbiter: { minConfidence: 1.5 } }).ok).toBe(false);
    expect(resolveReviewDisputeSettings({ arbiter: { minConfidence: -0.1 } }).ok).toBe(false);
    expect(resolveReviewDisputeSettings({ arbiter: { providers: ['', 'claude'] } }).ok).toBe(false);
    expect(resolveReviewDisputeSettings({ arbiter: { allowSameProvider: 'true' } }).ok).toBe(false);
    expect(resolveReviewDisputeSettings({ enabled: 'yes' }).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §2 Findings, evidence, admission
// ---------------------------------------------------------------------------

describe('evidence references (§3.3)', () => {
  test('accepts every reference kind', () => {
    expect(validateEvidenceRef(FILE_REF).ok).toBe(true);
    expect(validateEvidenceRef({ kind: 'test', name: 'outbox rewinds on retry' }).ok).toBe(true);
    expect(
      validateEvidenceRef({ kind: 'doc_section', path: 'docs/review-dispute-contract.md', section: '§5' }).ok,
    ).toBe(true);
    expect(validateEvidenceRef({ kind: 'issue_quote', quote: 'One rebuttal per finding version.' }).ok).toBe(true);
  });

  test('rejects malformed references', () => {
    expectFailure(validateEvidenceRef({ kind: 'url', href: 'https://example.com' }), 'unknown-enum');
    expectFailure(validateEvidenceRef({ ...FILE_REF, path: '/etc/passwd' }), 'invalid-evidence-ref');
    expectFailure(validateEvidenceRef({ ...FILE_REF, path: '../secrets.env' }), 'invalid-evidence-ref');
    expectFailure(validateEvidenceRef({ ...FILE_REF, startLine: 30 }), 'invalid-evidence-ref');
    expectFailure(validateEvidenceRef({ ...FILE_REF, startLine: 0 }), 'invalid-type');
    expectFailure(validateEvidenceRef({ ...FILE_REF, extra: 1 }), 'unknown-field');
    expectFailure(
      validateEvidenceRef({ kind: 'doc_section', path: 'src/core/outbox.ts', section: '§5' }),
      'invalid-evidence-ref',
    );
    expectFailure(validateEvidenceRef({ kind: 'test' }), 'missing-field');
  });
});

describe('candidate findings (§2.1)', () => {
  test('accepts a well-formed candidate', () => {
    const result = validateCandidateFinding(candidate());
    expect(result.ok).toBe(true);
    expect(result.value.candidate.version).toBe(1);
    expect(result.value.ignoredRunnerOwnedFields).toEqual([]);
  });

  test('runner-owned fields supplied by the agent are ignored, never admitted', () => {
    const result = validateCandidateFinding(
      candidate({ humanGate: true, reviewerMeta: { agentId: 'impostor' } }),
    );
    expect(result.ok).toBe(true);
    expect(result.value.ignoredRunnerOwnedFields).toEqual(['humanGate', 'reviewerMeta']);
    expect(result.value.candidate.humanGate).toBeUndefined();
    expect(result.value.candidate.reviewerMeta).toBeUndefined();
  });

  test('an echoed lineageId is preserved (§2.2: echoed to attach, never minted)', () => {
    const result = validateCandidateFinding(candidate({ lineageId: 'ln-0123456789ab' }));
    expect(result.value.candidate.lineageId).toBe('ln-0123456789ab');
  });

  test('rejects unknown fields, missing fields, and unknown enum tokens', () => {
    expectFailure(validateCandidateFinding(candidate({ notAField: 'x' })), 'unknown-field');
    const missing = candidate();
    delete missing.requiredOutcome;
    expectFailure(validateCandidateFinding(missing), 'missing-field');
    expectFailure(validateCandidateFinding(candidate({ severity: 'P3' })), 'unknown-enum');
    expectFailure(validateCandidateFinding(candidate({ evidenceRefs: [] })), 'missing-field');
    expectFailure(validateCandidateFinding(candidate({ version: 0 })), 'invalid-type');
    expectFailure(validateCandidateFinding(candidate({ version: 3 })), 'invalid-type');
  });

  test('rejects oversized fields and unencodable text', () => {
    expectFailure(validateCandidateFinding(candidate({ preconditions: 'x'.repeat(2001) })), 'field-too-long');
    expectFailure(
      validateCandidateFinding(candidate({ preconditions: `bad\u0000value` })),
      'malformed-encoding',
    );
    expectFailure(
      validateCandidateFinding(candidate({ evidenceRefs: Array.from({ length: 11 }, () => FILE_REF) })),
      'too-many-items',
    );
  });

  test('normalizes an absolute affectedBoundary under the execution root (§2.1)', () => {
    const normalized = normalizeAffectedBoundary(`${REPO_ROOT}/src/core/outbox.ts`, REPO_ROOT);
    expect(normalized).toEqual({ ok: true, value: 'src/core/outbox.ts' });

    const result = validateCandidateFinding(candidate({ affectedBoundary: `${REPO_ROOT}/src/core/outbox.ts` }), {
      repoRoot: REPO_ROOT,
    });
    expect(result.value.candidate.affectedBoundary).toBe('src/core/outbox.ts');
  });

  test('a boundary outside the repository is malformed after normalization (§2.1, §11)', () => {
    for (const value of ['/etc/passwd', '../../elsewhere/file.ts', '~/notes.md', 'C:\\repo\\file.ts']) {
      expectFailure(normalizeAffectedBoundary(value, REPO_ROOT), 'boundary-outside-repository');
      expectFailure(validateCandidateFinding(candidate({ affectedBoundary: value }), { repoRoot: REPO_ROOT }),
        'boundary-outside-repository');
    }
    // Absolute but outside the execution root: still a local path, still refused.
    expectFailure(normalizeAffectedBoundary('/other/repo/src/a.ts', REPO_ROOT), 'boundary-outside-repository');
    // Without a root there is nothing to normalize against.
    expectFailure(normalizeAffectedBoundary(`${REPO_ROOT}/src/a.ts`), 'boundary-outside-repository');
  });

  test('a path hidden behind a clean leading token is malformed too (§2.1, §11)', () => {
    // §11 publishes the whole value, so checking only the first token would let
    // a local path ride along in the member/qualifier tail.
    const smuggled = [
      'src/core/outbox.ts ../../secret.txt',
      'src/core/outbox.ts#/etc/passwd',
      'src/core/outbox.ts#../../secret.txt',
      'src/core/outbox.ts ~/notes.md',
      `src/core/outbox.ts ${REPO_ROOT}/src/a.ts`,
      'file:///etc/passwd',
      'src/core/outbox.ts#a\\b',
    ];
    for (const value of smuggled) {
      expectFailure(normalizeAffectedBoundary(value, REPO_ROOT), 'boundary-outside-repository');
      expectFailure(
        validateCandidateFinding(candidate({ affectedBoundary: value }), { repoRoot: REPO_ROOT }),
        'boundary-outside-repository',
      );
    }
    // A member or line range that names no location is still a valid boundary.
    for (const value of ['src/core/outbox.ts#enqueue', 'src/core/outbox.ts:10-20', 'docs/x.md#Section 2']) {
      expect(normalizeAffectedBoundary(value, REPO_ROOT)).toEqual({ ok: true, value });
    }
  });

  test('admission stamps the runner-owned fields and overrides agent claims', () => {
    const admitted = admitFinding(
      candidate({ humanGate: true }),
      { lineageId: 'ln-0123456789ab', humanGate: false, reviewerMeta: REVIEWER_META },
      admissionCtx(),
    );
    expect(admitted.ok).toBe(true);
    expect(admitted.value.finding.lineageId).toBe('ln-0123456789ab');
    expect(admitted.value.finding.humanGate).toBe(false);
    expect(admitted.value.finding.reviewerMeta).toEqual(REVIEWER_META);
    expect(admitted.value.discardedChangedFields).toEqual([]);
  });

  test('admission re-validates the candidate and rejects a bad reviewerMeta', () => {
    const bad = admitFinding(
      candidate(),
      { lineageId: 'ln-0123456789ab', humanGate: false, reviewerMeta: { ...REVIEWER_META, timestamp: 'yesterday' } },
      admissionCtx(),
    );
    expectFailure(bad, 'invalid-type');
  });

  test('reviewerMeta requires an ISO-8601 timestamp with an explicit offset', () => {
    const stamp = (timestamp) => ({
      lineageId: 'ln-0123456789ab',
      humanGate: false,
      reviewerMeta: { ...REVIEWER_META, timestamp },
    });
    // `Date.parse` accepts all of these; none is the ISO-8601 form the record
    // contract advertises, so none may reach persisted audit data.
    const rejected = [
      'December 17, 1995 03:24:00',
      '2026',
      '2026-08-03',
      '2026-08-03T10:00:00',
      '2026-08-03 10:00:00Z',
      'Mon, 03 Aug 2026 10:00:00 GMT',
      '2026-13-03T10:00:00Z',
      '2026-08-03T25:00:00Z',
    ];
    for (const timestamp of rejected) {
      expectFailure(admitFinding(candidate(), stamp(timestamp), admissionCtx()), 'invalid-type');
    }
    for (const timestamp of ['2026-08-03T10:00:00Z', '2026-08-03T10:00:00.000Z', '2026-08-03T19:00:00+09:00']) {
      const admitted = admitFinding(candidate(), stamp(timestamp), admissionCtx());
      expect(admitted.ok).toBe(true);
      expect(admitted.value.finding.reviewerMeta.timestamp).toBe(timestamp);
    }
  });

  test('reviewerMeta rejects a calendar date that never occurred', () => {
    const stamp = (timestamp) => ({
      lineageId: 'ln-0123456789ab',
      humanGate: false,
      reviewerMeta: { ...REVIEWER_META, timestamp },
    });
    // These match the ISO shape and `Date.parse` silently rolls each one into
    // the following month, so admitting them would persist audit metadata
    // claiming a day that never happened.
    const impossible = [
      '2026-02-29T12:00:00Z',
      '2026-02-30T12:00:00Z',
      '2026-04-31T12:00:00Z',
      '2026-06-31T12:00:00.000Z',
      '2026-09-31T12:00:00+09:00',
      '2026-11-31T12:00:00Z',
      '1900-02-29T12:00:00Z',
      '2100-02-29T12:00:00Z',
    ];
    for (const timestamp of impossible) {
      expectFailure(admitFinding(candidate(), stamp(timestamp), admissionCtx()), 'invalid-type');
    }
    // Real month ends, including a leap day, stay admissible.
    for (const timestamp of [
      '2024-02-29T12:00:00Z',
      '2000-02-29T12:00:00Z',
      '2026-02-28T12:00:00Z',
      '2026-04-30T12:00:00Z',
      '2026-12-31T23:59:59.999Z',
      '2026-01-31T12:00:00+09:00',
    ]) {
      const admitted = admitFinding(candidate(), stamp(timestamp), admissionCtx());
      expect(admitted.ok).toBe(true);
      expect(admitted.value.finding.reviewerMeta.timestamp).toBe(timestamp);
    }
  });

  test('admission resolves every evidence reference read-only (§2.1, §3.3, §12)', () => {
    const stamp = { lineageId: 'ln-0123456789ab', humanGate: false, reviewerMeta: REVIEWER_META };
    // A finding citing a file, test, or doc section that does not exist is
    // ungrounded and never opens a lineage.
    expectFailure(
      admitFinding(candidate(), stamp, admissionCtx({ resolveEvidenceRef: () => false })),
      'unresolvable-evidence',
    );
    // The check is per reference: one unresolvable ref rejects the finding.
    const refs = [FILE_REF, { kind: 'test', name: 'a test that was deleted' }];
    expectFailure(
      admitFinding(
        candidate({ evidenceRefs: refs }),
        stamp,
        admissionCtx({ resolveEvidenceRef: (ref) => ref.kind === 'file' }),
      ),
      'unresolvable-evidence',
    );
    expect(admitFinding(candidate({ evidenceRefs: refs }), stamp, admissionCtx()).ok).toBe(true);
  });

  test('the admitted version is the one the admission decision allows (§2.2, §2.3)', () => {
    const stamp = { lineageId: 'ln-0123456789ab', humanGate: false, reviewerMeta: REVIEWER_META };
    // A new lineage always begins at version 1: an initial finding may not enter
    // as version 2 and take version 2's routing without ever being revised.
    expectFailure(admitFinding(candidate({ version: 2 }), stamp, admissionCtx()), 'invalid-version');
    expect(admitFinding(candidate(), stamp, admissionCtx()).ok).toBe(true);
    // A re-raise attaches at the lineage's CURRENT version, never past it.
    const attach = { kind: 'attach', current: recorded({ version: 2 }) };
    expect(admitFinding(candidate({ version: 2 }), stamp, admissionCtx({ admission: attach })).ok).toBe(true);
    expectFailure(admitFinding(candidate(), stamp, admissionCtx({ admission: attach })), 'invalid-version');
    // A §4.2 successor sits at exactly predecessorVersion + 1.
    const revise = { kind: 'revision', predecessorVersion: 1 };
    expect(admitFinding(candidate({ version: 2 }), stamp, admissionCtx({ admission: revise })).ok).toBe(true);
    expectFailure(admitFinding(candidate(), stamp, admissionCtx({ admission: revise })), 'invalid-version');
    // A successor beyond the absolute ceiling has no admissible version at all.
    expectFailure(
      admitFinding(candidate({ version: 2 }), stamp, admissionCtx({ admission: { kind: 'revision', predecessorVersion: 2 } })),
      'invalid-type',
    );
  });

  test('an attach never rewrites the version it attaches to (§2.2, §2.3)', () => {
    const stamp = { lineageId: 'ln-0123456789ab', humanGate: false, reviewerMeta: REVIEWER_META };
    const current = recorded();
    const attachCtx = (overrides = {}) =>
      admissionCtx({ admission: { kind: 'attach', current }, ...overrides });

    // An identical re-raise attaches to the recorded version and changes nothing.
    const same = admitFinding(candidate(), stamp, attachCtx());
    expect(same.ok).toBe(true);
    expect(same.value.finding).toEqual(current);
    expect(same.value.discardedChangedFields).toEqual([]);

    // A re-raise that alters the body is DISCARDED, not admitted: only a §4.2
    // `revise` may change a field, so the record of the current version stands
    // and the attempted changes are reported for the audit log.
    const rewritten = admitFinding(
      candidate({
        preconditions: 'Any retry at all, whatever the cursor position.',
        requiredOutcome: 'The whole retry path is rewritten to drop the cursor.',
        evidenceRefs: [{ kind: 'test', name: 'some other test entirely' }],
      }),
      stamp,
      attachCtx(),
    );
    expect(rewritten.ok).toBe(true);
    expect(rewritten.value.finding).toEqual(current);
    expect(rewritten.value.discardedChangedFields).toEqual([
      'preconditions',
      'requiredOutcome',
      'evidenceRefs',
    ]);

    // A severity-only re-raise is discarded on the same rule.
    const reSeverity = admitFinding(candidate({ severity: 'P2' }), stamp, attachCtx());
    expect(reSeverity.value.finding.severity).toBe('P1');
    expect(reSeverity.value.discardedChangedFields).toEqual(['severity']);

    // The stamp must name the lineage the attach targets.
    expectFailure(
      admitFinding(candidate(), { ...stamp, lineageId: 'ln-ffffffffffff' }, attachCtx()),
      'invalid-state-record',
    );
  });

  test('duplicate ids and versions inside one admitted set are rejected (§2.2, §2.3)', () => {
    const base = admitFinding(
      candidate(),
      { lineageId: 'ln-0123456789ab', humanGate: false, reviewerMeta: REVIEWER_META },
      admissionCtx(),
    ).value.finding;
    expect(validateFindingSet([base]).ok).toBe(true);
    expectFailure(validateFindingSet([base, base]), 'duplicate-version');
    expectFailure(validateFindingSet([base, { ...base, version: 2 }]), 'duplicate-lineage');
    expectFailure(
      validateFindingSet(Array.from({ length: 13 }, (_, i) => ({ ...base, lineageId: `ln-00000000000${i}` }))),
      'too-many-items',
    );
  });

  test('a version history must be a contiguous 1..n run (§2.3)', () => {
    const v1 = { ...candidate(), lineageId: 'ln-0123456789ab', humanGate: false, reviewerMeta: REVIEWER_META };
    const v2 = { ...v1, version: 2 };
    expect(validateLineageVersionHistory([v2, v1]).ok).toBe(true);
    expectFailure(validateLineageVersionHistory([v2]), 'duplicate-version');
    expectFailure(validateLineageVersionHistory([v1, v1]), 'duplicate-version');
    expectFailure(validateLineageVersionHistory([]), 'missing-field');
  });
});

// ---------------------------------------------------------------------------
// §3 Dispositions and disputes
// ---------------------------------------------------------------------------

describe('dispositions (§3.1, §3.4, §12)', () => {
  test('a fixed disposition needs a diff', () => {
    expect(admitDisposition(disposition(), dispositionCtx()).ok).toBe(true);
    expectFailure(
      admitDisposition(disposition(), dispositionCtx({ runProducedFileChanges: false })),
      'fixed-without-diff',
    );
  });

  test('a valid dispute is admitted and consumes the rebuttal slot', () => {
    const result = admitDisposition(
      disposition({ disposition: 'review_disputed', dispute: dispute() }),
      dispositionCtx({ runProducedFileChanges: false }),
    );
    expect(result.ok).toBe(true);
    expect(result.value.consumesRebuttal).toBe(true);
  });

  test('a dispute without a dispute record, or with a mismatched target, is malformed', () => {
    expectFailure(admitDisposition(disposition({ disposition: 'review_disputed' }), dispositionCtx()), 'missing-field');
    expectFailure(
      admitDisposition(
        disposition({ disposition: 'review_disputed', dispute: dispute({ challenged: { lineageId: 'ln-0123456789ab', version: 2 } }) }),
        dispositionCtx(),
      ),
      'invalid-type',
    );
    expectFailure(
      admitDisposition(disposition({ disposition: 'blocked', dispute: dispute() }), dispositionCtx()),
      'unknown-field',
    );
  });

  test('an unsupported assertion is not a dispute (§3.2, §3.3)', () => {
    const noEvidence = dispute();
    delete noEvidence.evidenceRefs;
    expectFailure(
      admitDisposition(disposition({ disposition: 'review_disputed', dispute: noEvidence }), dispositionCtx()),
      'missing-field',
    );
    // Unresolvable evidence fails closed and consumes nothing.
    const unresolvable = admitDisposition(
      disposition({ disposition: 'review_disputed', dispute: dispute() }),
      dispositionCtx({ resolveEvidenceRef: () => false }),
    );
    expectFailure(unresolvable, 'unresolvable-evidence');
  });

  test('the version-scoped rebuttal budget is spent by #840, not checked here', () => {
    // §6.1 `MAX_REBUTTALS_PER_VERSION` weighed against a lineage's spent counters
    // is a transition prerequisite, so #840 owns it. What #836 keeps is the
    // record-level half of the same rule — a persisted lineage may never list one
    // version twice, and its `rebuttals` counter must equal that list's length,
    // pinned under "rejects invalid state records" below — so no stored record
    // can present one version's slot as free and spent at once.
    const spent = dispositionCtx({
      lineages: { 'ln-0123456789ab': lineage({ rebuttedVersions: [1], counters: { rebuttals: 1 } }) },
    });
    expect(admitDisposition(disposition({ disposition: 'review_disputed', dispute: dispute() }), spent).ok).toBe(true);
  });

  test('state gating is deferred to #840; the record itself still has to fit (§12)', () => {
    // Row 24 (`review_disputed` on a `binding` finding) and §7.1 rule 2 (only an
    // `open`/`binding` lineage awaits a disposition) are transition rules. Their
    // vocabulary lives here — `dispositionAllowedForState` above — but applying
    // it against persisted state reads the §7 machine, so this layer admits the
    // record on state alone and leaves the routing to #840.
    for (const state of LINEAGE_STATES) {
      const ctx = dispositionCtx({
        lineages: {
          'ln-0123456789ab': lineage({ state, outcome: isTerminalLineageState(state) ? state : undefined }),
        },
      });
      expect(admitDisposition(disposition(), ctx).ok).toBe(true);
      expect(admitDisposition(disposition({ disposition: 'review_disputed', dispute: dispute() }), ctx).ok).toBe(true);
    }
    // What does not change: the record must name a known lineage and address that
    // lineage's current version (§2.3 makes every older one immutable).
    expectFailure(admitDisposition(disposition({ lineageId: 'ln-ffffffffffff' }), dispositionCtx()), 'unknown-lineage');
    expectFailure(
      admitDisposition(
        disposition({ version: 1 }),
        dispositionCtx({ lineages: { 'ln-0123456789ab': lineage({ version: 2 }) } }),
      ),
      'stale-version',
    );
  });

  test('a run carries at most one disposition per lineage, bounded in count', () => {
    expect(validateDispositionSet([disposition()]).ok).toBe(true);
    expectFailure(validateDispositionSet([disposition(), disposition()]), 'duplicate-lineage');
    expectFailure(
      validateDispositionSet(
        Array.from({ length: MAX_LINEAGES_PER_TASK + 1 }, (_, i) => disposition({ lineageId: `ln-${String(i).padStart(12, '0')}` })),
      ),
      'too-many-items',
    );
  });
});

// ---------------------------------------------------------------------------
// §4 Reconsideration and revision
// ---------------------------------------------------------------------------

describe('reconsideration (§4, §7.1)', () => {
  const disputedCtx = (overrides = {}) => ({
    lineages: { 'ln-0123456789ab': lineage({ state: 'disputed', rebuttedVersions: [1], counters: { rebuttals: 1 } }) },
    resolveEvidenceRef: () => true,
    ...overrides,
  });

  test('accepts withdraw, uphold, and revise on a disputed lineage', () => {
    for (const token of REVIEWER_RECONSIDERATIONS) {
      const record = reconsideration({
        reconsideration: token,
        ...(token === 'revise' ? { revision: revision() } : {}),
      });
      expect(admitReconsideration(record, disputedCtx()).ok).toBe(true);
    }
  });

  test('a reconsideration must name a known lineage at its current version (§2.3, §12)', () => {
    expectFailure(
      admitReconsideration(reconsideration({ version: 2 }), disputedCtx()),
      'stale-version',
    );
    expectFailure(
      admitReconsideration(reconsideration({ lineageId: 'ln-ffffffffffff' }), disputedCtx()),
      'unknown-lineage',
    );
  });

  test('the reviewer-turn prerequisites are deferred to #840', () => {
    // Whether the lineage is in the state that awaits a reviewer turn (§7.1 rule
    // 2) and whether a §6.1 reconsideration round is still available (row 25's
    // fallback when it is not) are both answered from the transition table and
    // the counters it spends — #840's step, not this module's. Here a
    // well-formed record about an existing lineage's current version is admitted
    // whatever the lineage has already spent.
    const spent = {
      lineages: {
        'ln-0123456789ab': lineage({
          state: 'disputed',
          rebuttedVersions: [1],
          counters: { rebuttals: 1, reconsiderations: 1 },
        }),
      },
      resolveEvidenceRef: () => true,
    };
    expect(admitReconsideration(reconsideration(), spent).ok).toBe(true);
    expect(admitReconsideration(reconsideration(), dispositionCtx()).ok).toBe(true);
  });

  test('a revise without predecessor or changed fields is malformed (§4.2, §12)', () => {
    expectFailure(validateReconsiderationRecord(reconsideration({ reconsideration: 'revise' })), 'missing-field');
    const noFields = revision({ changedFields: [] });
    expectFailure(
      validateReconsiderationRecord(reconsideration({ reconsideration: 'revise', revision: noFields })),
      'missing-field',
    );
    const noPredecessor = revision();
    delete noPredecessor.predecessorVersion;
    expectFailure(
      validateReconsiderationRecord(reconsideration({ reconsideration: 'revise', revision: noPredecessor })),
      'missing-field',
    );
    expectFailure(
      validateReconsiderationRecord(
        reconsideration({ reconsideration: 'revise', revision: revision({ predecessorVersion: 2 }) }),
      ),
      'invalid-revision',
    );
    expectFailure(
      validateReconsiderationRecord(
        reconsideration({ reconsideration: 'revise', revision: revision({ successor: candidate({ version: 1 }) }) }),
      ),
      'invalid-revision',
    );
    expectFailure(
      validateReconsiderationRecord(reconsideration({ revision: revision() })),
      'unknown-field',
    );
    expectFailure(
      validateReconsiderationRecord(
        reconsideration({ reconsideration: 'revise', revision: revision({ changedFields: ['nonsense'] }) }),
      ),
      'unknown-enum',
    );
  });

  test('the successor candidate is required even when no version budget remains (§4.2, row 26)', () => {
    // Under `MAX_VERSIONS_PER_LINEAGE = 1` the successor is never persisted, but
    // it still has to validate at `predecessorVersion + 1` because the §5 check
    // compares its fields and the arbiter receives it inside the record. So the
    // successor is bounded by the ABSOLUTE ceiling and never by a session's
    // version budget — the record validates the same whatever that budget is.
    const record = reconsideration({ reconsideration: 'revise', revision: revision() });
    const admitted = admitReconsideration(record, {
      lineages: { 'ln-0123456789ab': lineage({ state: 'disputed', rebuttedVersions: [1], counters: { rebuttals: 1 } }) },
      resolveEvidenceRef: () => true,
    });
    expect(admitted.ok).toBe(true);
    expect(admitted.value.record.revision.successor.version).toBe(2);
  });

  test('a revise onto unresolvable successor evidence is malformed (§3.3, §12)', () => {
    const record = reconsideration({ reconsideration: 'revise', revision: revision() });
    // The successor is a §2.1 finding: an evidence reference that resolves to
    // nothing is malformed for it too, whether it becomes version 2 (row 11) or
    // is only shown to the arbiter (rows 12, 26).
    expectFailure(
      admitReconsideration(record, disputedCtx({ resolveEvidenceRef: () => false })),
      'unresolvable-evidence',
    );
    expectFailure(
      admitReconsideration(
        reconsideration({
          reconsideration: 'revise',
          revision: revision({
            successor: candidate({ version: 2, evidenceRefs: [FILE_REF, { kind: 'test', name: 'a deleted test' }] }),
          }),
        }),
        disputedCtx({ resolveEvidenceRef: (ref) => ref.kind === 'file' }),
      ),
      'unresolvable-evidence',
    );
    // A rejection changes nothing: withdraw/uphold carry no successor to resolve.
    expect(admitReconsideration(reconsideration(), disputedCtx({ resolveEvidenceRef: () => false })).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §8.1 Arbiter verdicts
// ---------------------------------------------------------------------------

describe('arbiter verdicts (§8.1, §8.3, §12)', () => {
  const arbitratingCtx = (overrides = {}) => ({
    lineages: { 'ln-0123456789ab': lineage({ state: 'arbitration_pending' }) },
    ...overrides,
  });

  test('every verdict token is representable with a confidence', () => {
    for (const token of ARBITER_VERDICTS) {
      const result = admitArbiterVerdict(verdict({ verdict: token, confidence: 0 }), arbitratingCtx());
      expect(result.ok).toBe(true);
      expect(result.value.record.verdict).toBe(token);
    }
  });

  test('a verdict outside the four tokens or without a confidence is malformed', () => {
    expectFailure(validateArbiterVerdict(verdict({ verdict: 'reviewer_mostly_correct' })), 'unknown-enum');
    const noConfidence = verdict();
    delete noConfidence.confidence;
    expectFailure(validateArbiterVerdict(noConfidence), 'missing-field');
    expectFailure(validateArbiterVerdict(verdict({ confidence: 1.1 })), 'invalid-type');
    expectFailure(validateArbiterVerdict(verdict({ confidence: '0.9' })), 'invalid-type');
    // Any other unknown field is still malformed.
    expectFailure(validateArbiterVerdict(verdict({ escalate: true })), 'unknown-field');
  });

  test('extra finding-shaped content is ignored and logged, not rejected (§8.1)', () => {
    // §8.1: "any additional finding-shaped content in arbiter output is ignored
    // and logged, never admitted". Ignored — so the verdict itself still stands
    // and the lineage is not pushed toward escalation by a malformed attempt.
    const shapes = {
      newFinding: { severity: 'P1', violatedContract: 'something else entirely' },
      findings: [{ failureScenario: 'an unrelated defect' }],
      severity: 'P2',
      // Buried under a wrapper, the finding is no less finding-shaped: the scan
      // recurses, so the wrapper is ignored rather than counted as a malformed
      // attempt that spends a §6.1 pass on an otherwise decisive verdict.
      analysis: { newFinding: { severity: 'P1' } },
      appendix: { sections: [{ body: { evidenceRefs: [FILE_REF] } }] },
    };
    for (const [key, value] of Object.entries(shapes)) {
      const result = validateArbiterVerdict(verdict({ [key]: value }));
      expect(result.ok).toBe(true);
      expect(result.value.record.verdict).toBe('reviewer_correct');
      expect(result.value.ignoredFindingShapedFields).toEqual([key]);
      expect(result.value.record[key]).toBeUndefined();
    }

    const admitted = admitArbiterVerdict(verdict({ newFinding: { severity: 'P1' } }), arbitratingCtx());
    expect(admitted.ok).toBe(true);
    expect(admitted.value.ignoredFindingShapedFields).toEqual(['newFinding']);
    expect(admitted.value.record.verdict).toBe('reviewer_correct');
    // Nothing else is loosened: a malformed verdict beside ignored content is
    // still malformed.
    expectFailure(
      validateArbiterVerdict(verdict({ verdict: 'reviewer_mostly_correct', newFinding: { severity: 'P1' } })),
      'unknown-enum',
    );
    // Nor is the recursion a licence for arbitrary nested output: a wrapper that
    // names no finding and carries no §2.1 field is an unknown field.
    expectFailure(
      validateArbiterVerdict(verdict({ analysis: { note: 'unrelated commentary', depth: 2 } })),
      'unknown-field',
    );
  });

  test('a verdict must name a known lineage at its current version (§2.3, §12)', () => {
    expectFailure(
      admitArbiterVerdict(verdict({ version: 2 }), arbitratingCtx()),
      'stale-version',
    );
    expectFailure(
      admitArbiterVerdict(verdict({ lineageId: 'ln-ffffffffffff' }), arbitratingCtx()),
      'unknown-lineage',
    );
  });

  test('the arbitration prerequisites are deferred to #840 (§8.3)', () => {
    // Whether the lineage is actually awaiting arbitration, and whether a §6.1
    // pass remains to spend, are both read off the transition table's counters.
    // #840 owns those; this module returns a verdict about the record.
    expect(admitArbiterVerdict(verdict(), dispositionCtx()).ok).toBe(true);
    expect(
      admitArbiterVerdict(verdict(), {
        lineages: {
          'ln-0123456789ab': lineage({ state: 'arbitration_pending', counters: { arbitrationPasses: 2 } }),
        },
      }).ok,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §2.2 Lineage identity, minting, races
// ---------------------------------------------------------------------------

describe('lineage identity and admission classification (§2.2, §6.4)', () => {
  const entry = (overrides = {}) => ({
    lineageId: 'ln-aaaaaaaaaaaa',
    identityHash: findingIdentityHash(candidate()),
    state: 'open',
    rebuttalConsumed: false,
    ...overrides,
  });

  test('a minted id is stable for an identity and filename-safe', () => {
    const first = mintLineageId(candidate());
    expect(first).toBe(mintLineageId(candidate()));
    expect(LINEAGE_ID_RE.test(first)).toBe(true);
    // Wording of the identity tuple is normalized, so the same defect described
    // with different spacing/case mints the same lineage.
    expect(mintLineageId(candidate({ violatedContract: candidate().violatedContract.toUpperCase() }))).toBe(first);
    expect(mintLineageId(candidate({ affectedBoundary: 'src/core/task.ts' }))).not.toBe(first);
    // Severity is not part of the identity tuple.
    expect(mintLineageId(candidate({ severity: 'P2' }))).toBe(first);
    // …but the BOUNDARY's case is: on a case-sensitive checkout `src/core/Outbox.ts`
    // is a different file, and a case-distinct member is a different API surface.
    // Folding case here would attach a finding about one to the live lineage of
    // the other, and disagree with §5, which calls that change material.
    const cased = candidate({ affectedBoundary: 'src/core/Outbox.ts' });
    expect(mintLineageId(cased)).not.toBe(first);
    expect(mintLineageId(candidate({ affectedBoundary: 'src/core/outbox.ts#retryEntry' }))).not.toBe(
      mintLineageId(candidate({ affectedBoundary: 'src/core/outbox.ts#RetryEntry' })),
    );
    expect(
      classifyRevisionMateriality(candidate(), {
        changedFields: ['affectedBoundary'],
        successor: { ...cased, version: 2 },
      }).classification,
    ).toBe('material');
    // Line-number movement within the same boundary still mints the same lineage.
    expect(mintLineageId(candidate({ affectedBoundary: 'src/core/outbox.ts:40-60' }))).toBe(first);
  });

  test('non-ASCII findings keep distinct identities (no script restriction in the protocol)', () => {
    const jp = candidate({
      violatedContract: '受入基準: リトライ用カーソルは同一トランザクション内で巻き戻すこと。',
      failureScenario: 'カーソルが先へ進んだままとなり、再試行対象の行が二度と走査されない。',
    });
    const other = candidate({
      violatedContract: '受入基準: 送信箱の保守ロックはトランザクション内で確認すること。',
      failureScenario: 'ロックを確認せずに追加が実行され、保守中に行が増える。',
    });
    expect(findingIdentityHash(jp)).not.toBe(findingIdentityHash(other));
    expect(findingIdentityHash(jp)).not.toBe(findingIdentityHash(candidate()));
    // Same text, compatibility/whitespace differences only: still one identity.
    expect(
      findingIdentityHash(candidate({ ...jp, violatedContract: `  ${jp.violatedContract}  ` })),
    ).toBe(findingIdentityHash(jp));
    // Two different non-ASCII findings on the same boundary are not "reworded".
    const materiality = classifyRevisionMateriality(jp, {
      changedFields: ['violatedContract'],
      successor: { ...other, version: 2 },
    });
    expect(materiality.classification).not.toBe('non_material');
    expect(materiality.changes.find((c) => c.field === 'violatedContract').classification).not.toBe('reworded');
  });

  test('a taken id gets a distinguishable successor id', () => {
    const first = mintLineageId(candidate());
    const second = mintLineageId(candidate(), [first]);
    expect(second).toBe(`${first}-2`);
    expect(LINEAGE_ID_RE.test(second)).toBe(true);
  });

  test('a structural duplicate of a live lineage attaches instead of opening a second debate', () => {
    expect(classifyCandidateAdmission(candidate(), [entry()])).toEqual({
      kind: 'attach',
      lineageId: 'ln-aaaaaaaaaaaa',
    });
    // Race: the same defect re-raised while the lineage is mid-arbitration.
    expect(
      classifyCandidateAdmission(candidate(), [entry({ state: 'arbitration_pending' })]).kind,
    ).toBe('attach');
  });

  test('an echoed lineage id attaches; an unknown one is rejected (agents never mint)', () => {
    expect(
      classifyCandidateAdmission(candidate({ lineageId: 'ln-aaaaaaaaaaaa', failureScenario: 'Reworded entirely.' }), [entry()]),
    ).toEqual({ kind: 'attach', lineageId: 'ln-aaaaaaaaaaaa' });
    expect(classifyCandidateAdmission(candidate({ lineageId: 'ln-ffffffffffff' }), [entry()])).toEqual({
      kind: 'reject',
      reason: 'unknown-lineage-echo',
    });
  });

  test('a new defect mints a new lineage', () => {
    const fresh = candidate({ affectedBoundary: 'src/core/session.ts' });
    expect(classifyCandidateAdmission(fresh, [entry()])).toEqual({
      kind: 'new',
      lineageId: mintLineageId(fresh, ['ln-aaaaaaaaaaaa']),
    });
  });

  test('a duplicate of a resolved_fixed lineage that never rebutted is superseded (§7 note on rows 1/5/23)', () => {
    const result = classifyCandidateAdmission(
      candidate(),
      [entry({ state: 'resolved_fixed', rebuttalConsumed: false })],
    );
    expect(result.kind).toBe('supersedes');
    expect(result.predecessorLineageId).toBe('ln-aaaaaaaaaaaa');
    expect(LINEAGE_ID_RE.test(result.lineageId)).toBe(true);
    expect(result.lineageId).not.toBe('ln-aaaaaaaaaaaa');
  });

  test('the successor of a superseded lineage is the one consulted, not its predecessor (§2.2)', () => {
    // The original resolved_fixed lineage never consumed a rebuttal, so it was
    // superseded once; its successor then resolved AFTER consuming one. The
    // single successor path is spent, so a further duplicate is dropped rather
    // than minting a second successor of the same identity.
    const predecessor = entry({ lineageId: 'ln-aaaaaaaaaaaa', state: 'resolved_fixed', rebuttalConsumed: false });
    const successor = entry({
      lineageId: 'ln-aaaaaaaaaaaa-2',
      state: 'resolved_fixed',
      rebuttalConsumed: true,
      supersedes: 'ln-aaaaaaaaaaaa',
    });
    expect(classifyCandidateAdmission(candidate(), [predecessor, successor])).toEqual({
      kind: 'drop',
      reason: 'terminal-duplicate',
      lineageId: 'ln-aaaaaaaaaaaa-2',
    });
    // Echoing the predecessor's id follows the same chain.
    expect(
      classifyCandidateAdmission(candidate({ lineageId: 'ln-aaaaaaaaaaaa' }), [predecessor, successor]).lineageId,
    ).toBe('ln-aaaaaaaaaaaa-2');
    // A live successor takes the attach path, even when the predecessor matched first.
    expect(
      classifyCandidateAdmission(candidate(), [predecessor, { ...successor, state: 'disputed', rebuttalConsumed: true }]),
    ).toEqual({ kind: 'attach', lineageId: 'ln-aaaaaaaaaaaa-2' });
    // A successor that is itself supersedable keeps the successor path open once more.
    expect(
      classifyCandidateAdmission(candidate(), [predecessor, { ...successor, rebuttalConsumed: false }]).kind,
    ).toBe('supersedes');
    // A corrupted cyclic record terminates instead of hanging.
    expect(
      classifyCandidateAdmission(candidate(), [
        { ...predecessor, supersedes: 'ln-aaaaaaaaaaaa-2' },
        successor,
      ]).kind,
    ).toBe('drop');
  });

  test('every other terminal duplicate is dropped from blocking consideration (§6.4)', () => {
    expect(
      classifyCandidateAdmission(candidate(), [entry({ state: 'resolved_fixed', rebuttalConsumed: true })]),
    ).toEqual({ kind: 'drop', reason: 'terminal-duplicate', lineageId: 'ln-aaaaaaaaaaaa' });
    for (const state of ['resolved_withdrawn', 'resolved_overruled', 'escalated_human']) {
      expect(classifyCandidateAdmission(candidate(), [entry({ state })]).kind).toBe('drop');
    }
  });

  test('stale-version detection is version equality against the lineage (§2.3)', () => {
    expect(isStaleVersion({ version: 2 }, 1)).toBe(true);
    expect(isStaleVersion({ version: 2 }, 2)).toBe(false);
  });

  test('a revision names exactly one existing, current predecessor (§4.2)', () => {
    const v1 = { ...candidate(), lineageId: 'ln-0123456789ab', humanGate: false, reviewerMeta: REVIEWER_META };
    const v2 = { ...v1, version: 2 };
    expect(checkPredecessor([v1], revision())).toEqual({ ok: true, predecessor: v1 });
    expect(checkPredecessor([v1, v2], revision()).problem).toBe('predecessor-not-current');
    expect(checkPredecessor([v2], revision()).problem).toBe('predecessor-not-found');
    expect(checkPredecessor([v1, v1], revision()).problem).toBe('predecessor-ambiguous');
    expect(
      checkPredecessor([v1], { predecessorVersion: 1, successor: candidate({ version: 3 }) }).problem,
    ).toBe('successor-not-incremental');
    expect(
      checkPredecessor([v1, { ...v2, version: 2 }], { predecessorVersion: 2, successor: candidate({ version: 3 }) })
        .problem,
    ).toBe('successor-not-incremental');
  });
});

// ---------------------------------------------------------------------------
// §5 Material-revision rules
// ---------------------------------------------------------------------------

describe('material-revision classification (§5)', () => {
  const classify = (changedFields, successorOverrides, opts) =>
    classifyRevisionMateriality(
      candidate(),
      { changedFields, successor: candidate({ version: 2, ...successorOverrides }) },
      opts,
    );

  test('a changed affectedBoundary is material', () => {
    const result = classify(['affectedBoundary'], { affectedBoundary: 'src/core/outbox-effects.ts' });
    expect(result.classification).toBe('material');
    expect(result.materialFields).toEqual(['affectedBoundary']);
    expect(result.auditEvent).toBe('dispute.revision.material');
  });

  test('line-number movement within the same boundary is never material', () => {
    const before = candidate({ affectedBoundary: 'src/core/outbox.ts:10-20' });
    const result = classifyRevisionMateriality(before, {
      changedFields: ['affectedBoundary'],
      successor: candidate({ version: 2, affectedBoundary: 'src/core/outbox.ts:40-60' }),
    });
    expect(result.classification).toBe('non_material');
    expect(boundaryIdentity('src/core/outbox.ts:40-60')).toBe('src/core/outbox.ts');
  });

  test('line-number movement is non-material behind a member selector too', () => {
    // The finding this guards: with the range cut only from the END of the
    // string, a boundary that also names a member keeps its line numbers, so
    // moving them alone would read as a different boundary — material under §5
    // and a second identity (and lineage) for one alleged defect under §2.2.
    for (const [before, after] of [
      ['src/core/outbox.ts:10-20#retryEntry', 'src/core/outbox.ts:40-60#retryEntry'],
      ['src/core/outbox.ts:10 retryEntry', 'src/core/outbox.ts:42 retryEntry'],
    ]) {
      expect(boundaryIdentity(before)).toBe(boundaryIdentity(after));
      expect(
        classifyRevisionMateriality(candidate({ affectedBoundary: before }), {
          changedFields: ['affectedBoundary'],
          successor: candidate({ version: 2, affectedBoundary: after }),
        }).classification,
      ).toBe('non_material');
    }
    // The member selector itself is still part of the identity: a different
    // member is a different API surface, which §5 does classify as material.
    expect(boundaryIdentity('src/core/outbox.ts:10-20#retryEntry')).toBe('src/core/outbox.ts#retryEntry');
    expect(
      classifyRevisionMateriality(candidate({ affectedBoundary: 'src/core/outbox.ts:10-20#retryEntry' }), {
        changedFields: ['affectedBoundary'],
        successor: candidate({ version: 2, affectedBoundary: 'src/core/outbox.ts:10-20#scanForward' }),
      }).classification,
    ).toBe('material');
  });

  test('a severity-only change is never material', () => {
    const result = classify(['severity'], { severity: 'P2' });
    expect(result.classification).toBe('non_material');
    expect(result.auditEvent).toBe('dispute.revision.non_material');
  });

  test('a wording-only edit is never material', () => {
    const before = candidate({ preconditions: 'A retry arrives after the cursor advanced.' });
    const result = classifyRevisionMateriality(before, {
      changedFields: ['preconditions'],
      successor: candidate({ version: 2, preconditions: 'after the cursor advanced, a retry arrives' }),
    });
    expect(result.classification).toBe('non_material');
    expect(result.changes.find((c) => c.field === 'preconditions').classification).toBe('reworded');
  });

  test('a changed claim in a listed prose field is material', () => {
    const result = classify(['preconditions'], {
      preconditions: 'The maintenance lock is held by another process while the scan runs.',
    });
    expect(result.classification).toBe('material');
    expect(result.materialFields).toEqual(['preconditions']);
  });

  test('a rewritten failureScenario is ambiguous, and ambiguity goes to arbitration', () => {
    const result = classify(['failureScenario'], {
      failureScenario: 'The scan skips an entry whose visibility window closed mid-transaction.',
    });
    expect(result.classification).toBe('ambiguous');
    expect(result.ambiguousFields).toEqual(['failureScenario']);
    expect(result.auditEvent).toBe('dispute.revision.ambiguous');
    expect(result.materialFields).toEqual([]);
  });

  test('a pure addition (an added example) is ambiguous, never material', () => {
    const base = candidate();
    const result = classify(['preconditions'], {
      preconditions: `${base.preconditions} For example, entry 12 in the retry fixture.`,
    });
    expect(result.classification).toBe('ambiguous');
  });

  test('a declared field whose values compare equal is ignored', () => {
    const result = classify(['violatedContract', 'preconditions'], {});
    expect(result.classification).toBe('non_material');
    expect(result.ignoredDeclaredFields).toEqual(['violatedContract', 'preconditions']);
    expect(result.materialFields).toEqual([]);
  });

  test('whitespace-only differences are unchanged', () => {
    const base = candidate();
    const result = classify(['requiredOutcome'], {
      requiredOutcome: `  ${base.requiredOutcome.replace(/ /g, '   ')}  `,
    });
    expect(result.classification).toBe('non_material');
    expect(result.changes.find((c) => c.field === 'requiredOutcome').classification).toBe('unchanged');
  });

  test('an undeclared change still decides, and is reported for audit', () => {
    // Materiality is decided on recorded VALUES, so omitting a field from
    // `changedFields` cannot hide it.
    const result = classify(['severity'], {
      severity: 'P2',
      affectedBoundary: 'src/core/session.ts',
    });
    expect(result.classification).toBe('material');
    expect(result.undeclaredChangedFields).toEqual(['affectedBoundary']);
  });

  test('added evidence is material only when it invalidates a rebuttal premise', () => {
    const added = { kind: 'test', name: 'new failing test' };
    const withoutPredicate = classify(['evidenceRefs'], { evidenceRefs: [FILE_REF, added] });
    expect(withoutPredicate.classification).toBe('non_material');

    const withPredicate = classify(['evidenceRefs'], { evidenceRefs: [FILE_REF, added] }, {
      addedEvidenceInvalidatesRebuttal: (refs) => refs.some((ref) => ref.kind === 'test'),
    });
    expect(withPredicate.classification).toBe('material');
    expect(withPredicate.materialFields).toEqual(['evidenceRefs']);
  });

  test('materialityClaim never decides (§5, §14.2)', () => {
    const claimed = classifyRevisionMateriality(candidate(), {
      changedFields: ['severity'],
      materialityClaim: true,
      successor: candidate({ version: 2, severity: 'P2' }),
    });
    expect(claimed.classification).toBe('non_material');

    const disclaimed = classifyRevisionMateriality(candidate(), {
      changedFields: ['affectedBoundary'],
      materialityClaim: false,
      successor: candidate({ version: 2, affectedBoundary: 'src/core/session.ts' }),
    });
    expect(disclaimed.classification).toBe('material');
  });
});

// ---------------------------------------------------------------------------
// §10.1 Persisted state and serialization
// ---------------------------------------------------------------------------

describe('persisted context (§10.1)', () => {
  const context = (overrides = {}) => ({
    version: 1,
    reviewStructure: 'structured',
    lineages: { 'ln-0123456789ab': lineage() },
    ...overrides,
  });

  test('accepts a well-formed context and an empty one', () => {
    expect(validateReviewDisputeContext(context()).ok).toBe(true);
    expect(validateReviewDisputeContext(emptyReviewDisputeContext('structured')).ok).toBe(true);
    expect(emptyReviewDisputeContext()).toEqual({ version: 1, reviewStructure: 'legacy', lineages: {} });
  });

  test('rejects invalid state records', () => {
    expectFailure(validateReviewDisputeContext(context({ version: 2 })), 'invalid-state-record');
    expectFailure(validateReviewDisputeContext(context({ extra: true })), 'unknown-field');
    expectFailure(validateReviewDisputeContext(context({ reviewStructure: 'partial' })), 'unknown-enum');
    expectFailure(
      validateReviewDisputeContext(context({ lineages: { 'ln-0123456789ab': lineage({ state: 'settled' }) } })),
      'unknown-enum',
    );
    expectFailure(
      validateReviewDisputeContext(context({ lineages: { other: lineage() } })),
      'invalid-state-record',
    );
    // A terminal lineage must carry its outcome literal, and it must agree.
    expectFailure(
      validateReviewDisputeContext(context({ lineages: { 'ln-0123456789ab': lineage({ state: 'resolved_withdrawn' }) } })),
      'missing-field',
    );
    expectFailure(
      validateReviewDisputeContext(
        context({ lineages: { 'ln-0123456789ab': lineage({ state: 'resolved_withdrawn', outcome: 'resolved_fixed' }) } }),
      ),
      'invalid-state-record',
    );
    expectFailure(
      validateReviewDisputeContext(context({ lineages: { 'ln-0123456789ab': lineage({ outcome: 'binding' }) } })),
      'unknown-enum',
    );
    // The rebuttal counter and the rebutted-version list may never disagree.
    expectFailure(
      validateReviewDisputeContext(
        context({ lineages: { 'ln-0123456789ab': lineage({ rebuttedVersions: [1] }) } }),
      ),
      'invalid-state-record',
    );
    expectFailure(
      validateReviewDisputeContext(
        context({ lineages: { 'ln-0123456789ab': lineage({ rebuttedVersions: [1, 1], counters: { rebuttals: 2 } }) } }),
      ),
      'invalid-state-record',
    );
    // A rebuttal recorded against a version the lineage has not reached would
    // silently spend that version's single §4.1 slot the moment it is minted.
    expectFailure(
      validateReviewDisputeContext(
        context({ lineages: { 'ln-0123456789ab': lineage({ rebuttedVersions: [2], counters: { rebuttals: 1 } }) } }),
      ),
      'invalid-state-record',
    );
    // Row 11 is the only version-minting transition, so version 2 exists only
    // once version 1 was rebutted and the reconsideration that revised it was
    // recorded. That is the shape §7 can produce; the version-2 rebuttal below
    // is not.
    expect(
      validateReviewDisputeContext(
        context({
          lineages: {
            'ln-0123456789ab': lineage({
              version: 2,
              rebuttedVersions: [1],
              counters: { rebuttals: 1, reconsiderations: 1 },
            }),
          },
        }),
      ).ok,
    ).toBe(true);
    // §6.4: a reopen request lives on a terminal lineage only.
    expectFailure(
      validateReviewDisputeContext(context({ lineages: { 'ln-0123456789ab': lineage({ reopenRequested: true }) } })),
      'invalid-state-record',
    );
    expect(
      validateReviewDisputeContext(
        context({
          lineages: {
            'ln-0123456789ab': lineage({
              state: 'resolved_withdrawn',
              outcome: 'resolved_withdrawn',
              rebuttedVersions: [1],
              counters: { rebuttals: 1, reconsiderations: 1 },
              reopenRequested: true,
            }),
          },
        }),
      ).ok,
    ).toBe(true);
  });

  test('§7 reachability of a persisted record is #840, not this schema (§10.1)', () => {
    const withLimits = (overrides, limits) =>
      validateReviewDisputeContext(
        context({ lineages: { 'ln-0123456789ab': lineage(overrides) } }),
        'reviewDispute',
        limits,
      );
    // Each record below is internally consistent — every field in range, the
    // rebuttal counter equal to its list — while the COMBINATION of state,
    // counters, and version is one the §7 rows may or may not be able to produce
    // under a given session's limits. Answering that reads the transition table
    // and the counters it spends, which is #840's step; this layer must not
    // pre-empt it, so each of these is admitted here.
    for (const overrides of [
      // A debate state with no rebuttal recorded for the current version.
      { state: 'disputed' },
      { state: 'binding' },
      { state: 'evidence_requested' },
      { state: 'resolved_overruled', outcome: 'resolved_overruled' },
      // An arbiter counter on a lineage that never left `open`.
      { counters: { arbitrationPasses: 1 } },
      { counters: { reconsiderations: 1 } },
      // Evidence rounds without the pass that would have opened them.
      { state: 'arbitration_pending', rebuttedVersions: [1], counters: { rebuttals: 1, evidenceRoundsUsed: 1 } },
      // A human-gated lineage in a debate state (rows 3/7 escalate instead).
      { state: 'arbitration_pending', humanGate: true, rebuttedVersions: [1], counters: { rebuttals: 1 } },
      // An `open` version 2 whose current version is already rebutted.
      { version: 2, rebuttedVersions: [1, 2], counters: { rebuttals: 2, reconsiderations: 1 } },
    ]) {
      expect(withLimits(overrides).ok).toBe(true);
    }
    // The same for a LOWERED limit closing the row that reaches a state: at
    // `maxReconsiderationsPerLineage: 0` row 25 replaces row 2, and at
    // `maxEvidenceRoundsPerLineage: 0` row 17 replaces row 16 — both are
    // statements about which rows fire, so both belong to #840.
    const lowered = (overrides) => ({ ...REVIEW_DISPUTE_DEFAULT_LIMITS, ...overrides });
    const disputed = { state: 'disputed', rebuttedVersions: [1], counters: { rebuttals: 1 } };
    expect(withLimits(disputed, lowered({ maxReconsiderationsPerLineage: 0 })).ok).toBe(true);
    const evidence = {
      state: 'evidence_requested',
      rebuttedVersions: [1],
      counters: { rebuttals: 1, arbitrationPasses: 1 },
    };
    expect(withLimits(evidence, lowered({ maxEvidenceRoundsPerLineage: 0 })).ok).toBe(true);
    // What this layer does still refuse is a record that contradicts ITSELF or
    // exceeds a configured bound — the checks above and below this one.
    expectFailure(
      withLimits({ version: 2, rebuttedVersions: [1], counters: { rebuttals: 1, reconsiderations: 2 } }),
      'invalid-type',
    );
  });

  test('a persisted version is bounded by the session version budget (§6.1, §10.1)', () => {
    const withLimits = (overrides, limits) =>
      validateReviewDisputeContext(
        context({ lineages: { 'ln-0123456789ab': lineage(overrides) } }),
        'reviewDispute',
        limits,
      );
    const oneVersion = { ...REVIEW_DISPUTE_DEFAULT_LIMITS, maxVersionsPerLineage: 1 };
    const finalResponse = {
      version: 2,
      rebuttedVersions: [1],
      counters: { rebuttals: 1, reconsiderations: 1 },
    };
    // The finding this guards: at `maxVersionsPerLineage: 1` row 11 never fires
    // — row 26 sends the material revision to arbitration instead — so version 2
    // is a final-response version this session explicitly disabled. Bounding the
    // persisted version only by the ABSOLUTE ceiling would resume the debate one
    // round past where the operator closed it.
    expect(withLimits(finalResponse).ok).toBe(true);
    expectFailure(withLimits(finalResponse, oneVersion), 'invalid-type');
    // The rebutted-version list is bounded the same way, so the disabled version
    // cannot come back in through a version-1 record's rebuttals either.
    expectFailure(
      withLimits({ rebuttedVersions: [2], counters: { rebuttals: 1 } }, oneVersion),
      'invalid-type',
    );
    // The same bound applies to a serialized block.
    const serialized = JSON.stringify(context({ lineages: { 'ln-0123456789ab': lineage(finalResponse) } }));
    expectFailure(parseReviewDisputeContext(serialized, oneVersion), 'invalid-type');
    expect(parseReviewDisputeContext(serialized).ok).toBe(true);
  });

  test('persisted counters are bounded by the session limits (§6.1, §10.1)', () => {
    const withCounters = (overrides) =>
      context({ lineages: { 'ln-0123456789ab': lineage(overrides) } });
    const arbitrating = (counterOverrides) =>
      withCounters({
        state: 'arbitration_pending',
        rebuttedVersions: [1],
        counters: { rebuttals: 1, ...counterOverrides },
      });
    // The finding this guards: a counter accepted above its §6.1 maximum is a
    // budget the protocol never had. Restoring one resumes — or audits — a run
    // that spent more of the debate than any sequence of rows could spend.
    expect(validateReviewDisputeContext(arbitrating({ arbitrationPasses: 2 })).ok).toBe(true);
    expectFailure(validateReviewDisputeContext(arbitrating({ arbitrationPasses: 3 })), 'invalid-type');
    expectFailure(validateReviewDisputeContext(arbitrating({ malformedArbiterAttempts: 3 })), 'invalid-type');
    expectFailure(
      validateReviewDisputeContext(
        withCounters({
          state: 'evidence_requested',
          rebuttedVersions: [1],
          counters: { rebuttals: 1, evidenceRoundsUsed: 2 },
        }),
      ),
      'invalid-type',
    );
    // Reconsiderations are capped per LINEAGE at 1, below what the version
    // ceiling alone would allow a version-2 record to claim.
    expectFailure(
      validateReviewDisputeContext(
        withCounters({
          state: 'resolved_withdrawn',
          outcome: 'resolved_withdrawn',
          version: 2,
          rebuttedVersions: [1, 2],
          counters: { rebuttals: 2, reconsiderations: 2 },
        }),
      ),
      'invalid-type',
    );
    // Rebuttals are the one per-VERSION limit (§4.1), so the per-lineage ceiling
    // is one for each version the lineage could mint.
    expectFailure(
      validateReviewDisputeContext(
        withCounters({ version: 2, rebuttedVersions: [1, 2], counters: { rebuttals: 3 } }),
      ),
      'invalid-type',
    );
    // A session may only LOWER a limit, and the lowered value is what the
    // restored record is held to.
    const lowered = (overrides) => ({ ...REVIEW_DISPUTE_DEFAULT_LIMITS, ...overrides });
    const onePass = lowered({ maxArbitrationPassesPerLineage: 1 });
    expectFailure(
      validateReviewDisputeContext(arbitrating({ arbitrationPasses: 2 }), 'reviewDispute', onePass),
      'invalid-type',
    );
    expect(
      validateReviewDisputeContext(arbitrating({ arbitrationPasses: 1 }), 'reviewDispute', onePass).ok,
    ).toBe(true);
    expectFailure(
      validateReviewDisputeContext(
        withCounters({
          state: 'resolved_withdrawn',
          outcome: 'resolved_withdrawn',
          rebuttedVersions: [1],
          counters: { rebuttals: 1, reconsiderations: 1 },
        }),
        'reviewDispute',
        lowered({ maxReconsiderationsPerLineage: 0 }),
      ),
      'invalid-type',
    );
    // The same bound applies to a serialized block.
    const serialized = JSON.stringify(arbitrating({ arbitrationPasses: 2 }));
    expectFailure(parseReviewDisputeContext(serialized, onePass), 'invalid-type');
    expect(parseReviewDisputeContext(serialized).ok).toBe(true);
  });

  test('the run-level flags are checked against each other and the review shape (§13)', () => {
    const withdrawn = (overrides = {}) =>
      lineage({
        state: 'resolved_withdrawn',
        outcome: 'resolved_withdrawn',
        rebuttedVersions: [1],
        counters: { rebuttals: 1, reconsiderations: 1 },
        ...overrides,
      });
    const resolved = (overrides = {}) =>
      context({
        lineages: { 'ln-0123456789ab': withdrawn() },
        resolvedWithoutChanges: true,
        ...overrides,
      });
    expect(validateReviewDisputeContext(resolved()).ok).toBe(true);
    // Whether the flag agrees with the LINEAGE MAP is §7.1 rule 4 — "every
    // lineage terminal in a no-change-required outcome", evaluated in rule order
    // across every lineage — so #840 owns it, and a live lineage beside the flag
    // is admitted here.
    expect(validateReviewDisputeContext(resolved({ lineages: { 'ln-0123456789ab': lineage() } })).ok).toBe(true);
    expect(
      validateReviewDisputeContext(
        resolved({ lineages: { 'ln-0123456789ab': withdrawn({ reopenRequested: true }) } }),
      ).ok,
    ).toBe(true);
    // The block's own three fields still have to agree: an unreviewed diff is
    // never a no-change resolution.
    expectFailure(validateReviewDisputeContext(resolved({ pendingReReview: true })), 'invalid-state-record');
    // §13: a legacy or mixed review's prose keeps its blocking force, so neither
    // shape may claim a no-change resolution.
    for (const reviewStructure of ['legacy', 'mixed']) {
      expectFailure(validateReviewDisputeContext(resolved({ reviewStructure })), 'invalid-state-record');
    }
    // `pendingReReview` alone stays valid in both shapes rules 2 and 3 produce:
    // beside a live lineage, and beside all-terminal ones before routing to
    // review clears it.
    expect(validateReviewDisputeContext(context({ pendingReReview: true })).ok).toBe(true);
    expect(
      validateReviewDisputeContext(
        context({ lineages: { 'ln-0123456789ab': withdrawn() }, pendingReReview: true }),
      ).ok,
    ).toBe(true);
    expect(validateReviewDisputeContext(resolved({ pendingReReview: false })).ok).toBe(true);
  });

  test('a persisted supersedes link is validated against the map (§2.2)', () => {
    const PRED = 'ln-0123456789ab';
    const SUCC = 'ln-0123456789ab-2';
    const resolvedFixed = (overrides = {}) =>
      lineage({ state: 'resolved_fixed', outcome: 'resolved_fixed', ...overrides });
    const linked = (successorOverrides = {}, predecessorOverrides = {}) =>
      context({
        lineages: {
          [PRED]: resolvedFixed({ lineageId: PRED, ...predecessorOverrides }),
          [SUCC]: lineage({ lineageId: SUCC, supersedes: PRED, ...successorOverrides }),
        },
      });

    // A well-formed link: a fresh version-1 successor naming a predecessor the
    // map actually holds.
    expect(validateReviewDisputeContext(linked()).ok).toBe(true);

    // §2.2 constrains the successor at CREATION — the runner mints it at version
    // 1 (`classifyCandidateAdmission`). The link is persisted for the rest of the
    // lineage's life, so the successor then runs its own debate: rows 2 and 11
    // take it to version 2 exactly as they would any other lineage, and the link
    // never pins a successor at version 1.
    expect(
      validateReviewDisputeContext(
        linked({ version: 2, rebuttedVersions: [1], counters: { rebuttals: 1, reconsiderations: 1 } }),
      ).ok,
    ).toBe(true);

    // The finding this guards: admission WALKS these links to decide which
    // lineage currently represents an identity, so a link that names nothing —
    // or names the record itself — would attach, drop, or supersede a candidate
    // against the wrong lineage instead of failing closed.
    for (const bad of ['ln-nothex000000', '__proto__', 'lineage-1', 'ln-0123456789ab/x', SUCC]) {
      expectFailure(validateReviewDisputeContext(linked({ supersedes: bad })), 'invalid-state-record');
    }
    // Well formed, but dangling: a link that resolves to no record in the map.
    expectFailure(
      validateReviewDisputeContext(linked({ supersedes: 'ln-ffffffffffff' })),
      'invalid-state-record',
    );

    // WHICH lineage may be superseded — §7's note on rows 1/5/23 reserves the
    // path for a `resolved_fixed` predecessor that never consumed a rebuttal —
    // is a transition rule about how the link came to exist, so #840 owns it.
    // The structure of the link is all this layer decides.
    expect(
      validateReviewDisputeContext(
        context({
          lineages: {
            [PRED]: lineage({ lineageId: PRED }),
            [SUCC]: lineage({ lineageId: SUCC, supersedes: PRED }),
          },
        }),
      ).ok,
    ).toBe(true);
    expect(
      validateReviewDisputeContext(
        linked({}, { version: 2, rebuttedVersions: [1], counters: { rebuttals: 1, reconsiderations: 1 } }),
      ).ok,
    ).toBe(true);

    // Exactly one successor path: two successors is that path spent twice.
    expectFailure(
      validateReviewDisputeContext(
        context({
          lineages: {
            [PRED]: resolvedFixed({ lineageId: PRED }),
            [SUCC]: lineage({ lineageId: SUCC, supersedes: PRED }),
            'ln-0123456789ab-3': lineage({ lineageId: 'ln-0123456789ab-3', supersedes: PRED }),
          },
        }),
      ),
      'invalid-state-record',
    );

    // A cycle has no oldest lineage and no current one, so the forward walk
    // resolves the identity to whichever entry it happened to start from.
    expectFailure(
      validateReviewDisputeContext(
        context({
          lineages: {
            [PRED]: resolvedFixed({ lineageId: PRED, supersedes: SUCC }),
            [SUCC]: resolvedFixed({ lineageId: SUCC, supersedes: PRED }),
          },
        }),
      ),
      'invalid-state-record',
    );
  });

  test('a single lineage record validates on its own, keyed by its id', () => {
    expect(validatePersistedLineage(lineage(), 'ln-0123456789ab').ok).toBe(true);
    expectFailure(validatePersistedLineage(lineage(), 'ln-ffffffffffff'), 'invalid-state-record');
    expectFailure(validatePersistedLineage(lineage({ unexpected: 1 }), 'ln-0123456789ab'), 'unknown-field');
    // §2.2: the id is runner-minted, so a record carrying anything else — a
    // prototype key above all — is corrupted, not a lineage.
    for (const id of ['__proto__', 'constructor', 'ln-nothex000000', 'lineage-1']) {
      expectFailure(validatePersistedLineage(lineage({ lineageId: id }), id), 'invalid-state-record');
    }
  });

  test('the run identity behind a consumed rebuttal slot must agree with the slot (§10.1, issue #844)', () => {
    const rebutted = { rebuttedVersions: [1], counters: { rebuttals: 1 } };
    // Absent: every block written before dispute persistence existed.
    expect(validatePersistedLineage(lineage(rebutted), 'ln-0123456789ab').ok).toBe(true);
    expect(
      validatePersistedLineage(
        lineage({ ...rebutted, disputeRuns: [{ version: 1, runId: 'run-impl-1' }] }),
        'ln-0123456789ab',
      ).ok,
    ).toBe(true);
    // A run entry for a version whose slot is NOT consumed claims a rebuttal the
    // counters deny, and two entries for one version make the idempotency key
    // ambiguous — a corrupted record must never decide whether a retried
    // delivery is a replay or a second rebuttal.
    expectFailure(
      validatePersistedLineage(lineage({ disputeRuns: [{ version: 1, runId: 'run-impl-1' }] }), 'ln-0123456789ab'),
      'too-many-items',
    );
    expectFailure(
      validatePersistedLineage(
        lineage({ ...rebutted, disputeRuns: [{ version: 2, runId: 'run-impl-1' }] }),
        'ln-0123456789ab',
      ),
      'invalid-state-record',
    );
    expectFailure(
      validatePersistedLineage(
        lineage({
          rebuttedVersions: [1, 2],
          version: 2,
          counters: { rebuttals: 2 },
          disputeRuns: [{ version: 1, runId: 'run-impl-1' }, { version: 1, runId: 'run-impl-2' }],
        }),
        'ln-0123456789ab',
      ),
      'invalid-state-record',
    );
    expectFailure(
      validatePersistedLineage(
        lineage({ ...rebutted, disputeRuns: [{ version: 1, runId: 'r'.repeat(121) }] }),
        'ln-0123456789ab',
      ),
      'field-too-long',
    );
    expectFailure(
      validatePersistedLineage(
        lineage({ ...rebutted, disputeRuns: [{ version: 1, runId: 'run-impl-1', extra: true }] }),
        'ln-0123456789ab',
      ),
      'unknown-field',
    );
  });

  test('the applied-transition ledger is a bounded list of opaque digests (§10.1, issue #840)', () => {
    // Absent: every block written before the transition layer existed.
    expect(validatePersistedLineage(lineage(), 'ln-0123456789ab').ok).toBe(true);
    expect(validatePersistedLineage(lineage({ appliedTransitions: ['0123456789ab'] }), 'ln-0123456789ab').ok).toBe(true);
    // The entries are digests, not run keys: anything else would carry a run id
    // — or a path — into the bounded context block.
    for (const entry of ['run-1', '0123456789AB', 'ln-0123456789ab@1#run-1', '0123456789a']) {
      expectFailure(
        validatePersistedLineage(lineage({ appliedTransitions: [entry] }), 'ln-0123456789ab'),
        entry.length > 12 ? 'field-too-long' : 'invalid-state-record',
      );
    }
    // A duplicate entry is a ledger that records one delivery twice, which says
    // nothing more than one entry does and consumes the bounded list.
    expectFailure(
      validatePersistedLineage(lineage({ appliedTransitions: ['0123456789ab', '0123456789ab'] }), 'ln-0123456789ab'),
      'invalid-state-record',
    );
    expectFailure(
      validatePersistedLineage(
        lineage({ appliedTransitions: Array.from({ length: 13 }, (_, i) => i.toString(16).padStart(12, '0')) }),
        'ln-0123456789ab',
      ),
      'too-many-items',
    );
  });

  test('a prototype key in a persisted lineage map fails closed (§10.1)', () => {
    // Parsed from JSON, `__proto__` is an ordinary own key. Admitting it would
    // give a context whose lineage never serializes yet still answers a direct
    // lookup — an attacker-controlled record hiding behind the prototype.
    // Written as JSON text on purpose: in an object literal `__proto__` sets the
    // prototype, while `JSON.parse` makes it an ordinary own key — which is the
    // shape a persisted context is actually read back in.
    const record = JSON.stringify({ ...lineage(), lineageId: '__proto__' });
    const payload = `{"version":1,"reviewStructure":"structured","lineages":{"__proto__":${record}}}`;
    expectFailure(parseReviewDisputeContext(payload), 'invalid-state-record');
    expectFailure(
      validateReviewDisputeContext(context({ lineages: JSON.parse(payload).lineages })),
      'invalid-state-record',
    );

    // And an admitted map carries no prototype at all, so a record naming an
    // inherited member resolves to no lineage.
    const parsed = parseReviewDisputeContext(
      JSON.stringify({ version: 1, reviewStructure: 'structured', lineages: {} }),
    );
    expect(parsed.ok).toBe(true);
    expect(Object.getPrototypeOf(parsed.value.lineages)).toBe(null);
    for (const id of ['__proto__', 'constructor', 'toString']) {
      expectFailure(
        admitDisposition(disposition({ lineageId: id }), dispositionCtx({ lineages: { 'ln-0123456789ab': lineage() } })),
        'unknown-lineage',
      );
    }
  });

  test('the lineage count is bounded, which bounds the whole block', () => {
    const many = {};
    for (let i = 0; i < MAX_LINEAGES_PER_TASK; i++) {
      const id = `ln-${String(i).padStart(12, '0')}`;
      many[id] = lineage({ lineageId: id });
    }
    const full = context({ lineages: many });
    expect(validateReviewDisputeContext(full).ok).toBe(true);

    const serialized = serializeReviewDisputeContext(full);
    expect(serialized.ok).toBe(true);
    // The deterministic bound: a full task's protocol state stays far below the
    // context budget, so bounded cycles cannot grow it without limit.
    expect(Buffer.byteLength(serialized.value, 'utf8')).toBeLessThan(REVIEW_DISPUTE_CONTEXT_MAX_BYTES);

    expect(lineageBudgetExhausted(full)).toBe(true);
    expect(lineageBudgetExhausted(emptyReviewDisputeContext())).toBe(false);

    const overflowId = `ln-${String(MAX_LINEAGES_PER_TASK).padStart(12, '0')}`;
    many[overflowId] = lineage({ lineageId: overflowId });
    expectFailure(validateReviewDisputeContext(context({ lineages: many })), 'too-many-items');
  });

  test('serialization is stable and round-trippable', () => {
    const forward = stableStringify({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } });
    const reversed = stableStringify({ a: { c: [3, { e: 5, f: 4 }], d: 2 }, b: 1 });
    expect(forward).toBe(reversed);
    expect(JSON.parse(forward)).toEqual({ a: { c: [3, { e: 5, f: 4 }], d: 2 }, b: 1 });
    // `undefined` members are dropped rather than serialized as null.
    expect(stableStringify({ a: undefined, b: 1 })).toBe('{"b":1}');

    const ctx = context();
    const serialized = serializeReviewDisputeContext(ctx);
    const parsed = parseReviewDisputeContext(serialized.value);
    expect(parsed.ok).toBe(true);
    expect(parsed.value).toEqual(ctx);
    expect(serializeReviewDisputeContext(parsed.value).value).toBe(serialized.value);
  });

  test('oversized and unparseable payloads fail closed', () => {
    expectFailure(serializeRecord({ blob: 'x'.repeat(100_000) }), 'payload-too-large');
    expectFailure(parseBoundedJson('{"a":1}', 3), 'payload-too-large');
    expectFailure(parseBoundedJson('{not json'), 'unparseable');
    expectFailure(parseReviewDisputeContext(`{"pad":"${'x'.repeat(40_000)}"}`), 'payload-too-large');
    expectFailure(parseReviewDisputeContext('[]'), 'not-an-object');
  });

  test('artifact names are derived from a validated lineage id (§10.2)', () => {
    expect(disputeArtifactName('ln-0123456789ab')).toBe('dispute-ln-0123456789ab.json');
    expect(reconsiderationArtifactName('ln-0123456789ab')).toBe('reconsideration-ln-0123456789ab.json');
    expect(arbitrationArtifactName('ln-0123456789ab')).toBe('arbitration-ln-0123456789ab.json');
    for (const bad of ['../escape', 'ln-nothex000000', 'ln-0123456789ab/x']) {
      expect(() => disputeArtifactName(bad)).toThrow();
    }
  });

  test('the §11 projection carries literals and counts only', () => {
    expect(publicLineageOutcome(lineage())).toBeNull();
    expect(publicLineageOutcome(lineage({ state: 'binding' }))).toBeNull();
    const resolved = lineage({
      state: 'resolved_overruled',
      outcome: 'resolved_overruled',
      version: 2,
      counters: { arbitrationPasses: 1 },
    });
    expect(publicLineageOutcome(resolved)).toEqual({
      lineageId: 'ln-0123456789ab',
      severity: 'P1',
      affectedBoundary: 'src/core/outbox.ts',
      outcome: 'resolved_overruled',
      versions: 2,
      arbitrationPasses: 1,
    });
  });
});

// ---------------------------------------------------------------------------
// §13 Legacy compatibility
// ---------------------------------------------------------------------------

describe('legacy free-form reviewFeedback (§13)', () => {
  test('legacy feedback is a non-disputable finding', () => {
    const legacy = legacyFindingFromReviewFeedback('Please rename the helper and add a test.');
    expect(legacy).toEqual({
      kind: 'legacy_free_form',
      disputable: false,
      feedback: 'Please rename the helper and add a test.',
      truncated: false,
    });
  });

  test('absent or whitespace-only feedback has no legacy finding', () => {
    for (const value of [undefined, null, '', '   \n\t ']) {
      expect(legacyFindingFromReviewFeedback(value)).toBeNull();
    }
  });

  test('feedback stays bounded exactly as reviewFeedback is today', () => {
    const legacy = legacyFindingFromReviewFeedback('x'.repeat(30_000));
    expect(legacy.truncated).toBe(true);
    expect(legacy.feedback).toHaveLength(20_000);
    const custom = legacyFindingFromReviewFeedback('abcdef', 3);
    expect(custom).toEqual({ kind: 'legacy_free_form', disputable: false, feedback: 'abc', truncated: true });
  });

  test('a review with no structured block is legacy and cannot resolve without changes', () => {
    const classified = classifyReviewStructure({ structuredFindingCount: 0, residualFeedback: 'Fix the parser.' });
    expect(classified.mode).toBe('legacy');
    expect(classified.legacyFinding.disputable).toBe(false);
    expect(classified.zeroChangeValid).toBe(false);
  });

  test('a fully structured review is the only one that permits a zero-change run', () => {
    const structured = classifyReviewStructure({ structuredFindingCount: 2, residualFeedback: '  \n ' });
    expect(structured.mode).toBe('structured');
    expect(structured.legacyFinding).toBeNull();
    expect(structured.zeroChangeValid).toBe(true);

    const mixed = classifyReviewStructure({
      structuredFindingCount: 2,
      residualFeedback: 'Also: the docs example is stale.',
    });
    expect(mixed.mode).toBe('mixed');
    // §13: the prose keeps its legacy blocking force, so a mixed review fails
    // closed even when every lineage ends in a no-change terminal state.
    expect(mixed.zeroChangeValid).toBe(false);
    expect(mixed.legacyFinding.disputable).toBe(false);

    for (const mode of REVIEW_STRUCTURE_MODES) {
      expect(reviewStructureAllowsZeroChange(mode)).toBe(mode === 'structured');
    }
  });
});
