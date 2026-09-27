// Issue #1040 — verification evidence binding.
//
// Pins the admissibility rule that binds manual verification evidence to the
// plan revision/digest, the §5.1 slot identity, and the reviewed branch HEAD
// it was recorded against: legacy unbound evidence is conservatively
// rejected, stale evidence fails closed (never deleted), a removed command is
// never marked passed, and preservation across plan changes is per unchanged
// command identity only.
import {
  evaluateVerificationEvidenceBinding,
  isVerificationSlotInvalidated,
  readVerificationEvidenceEntryBinding,
  readVerificationEvidenceBindingBlock,
  normalizeCommitSha,
  buildVerificationEvidenceBindingBlock,
  resolveEffectiveVerificationPlan,
  proposeVerificationRevision,
  buildEffectiveRequirementStatus,
  deriveRequirementCommandId,
  VERIFICATION_EVIDENCE_BINDING_CONTEXT_KEY,
} from '../dist/index.js';

const HEAD = 'a'.repeat(40);
const OTHER_HEAD = 'b'.repeat(40);
const DIGEST = 'c'.repeat(64);
const E2E = 'npm run e2e';
const E2E_ID = deriveRequirementCommandId(E2E);

function boundEntry(overrides = {}) {
  return {
    command: E2E,
    exitCode: 0,
    output: 'ok',
    recordedAt: '2026-01-01T00:00:00.000Z',
    source: 'operator_input',
    headSha: HEAD,
    planDigest: DIGEST,
    planRevisionOrdinal: 0,
    commandId: E2E_ID,
    ...overrides,
  };
}

const EXPECT_ALL = { headSha: HEAD, planDigest: DIGEST, commandId: E2E_ID };

describe('normalizeCommitSha', () => {
  test('accepts full 40-hex and 64-hex SHAs, trims and lowercases', () => {
    expect(normalizeCommitSha(` ${HEAD.toUpperCase()} \n`)).toBe(HEAD);
    expect(normalizeCommitSha('d'.repeat(64))).toBe('d'.repeat(64));
  });

  test('rejects short, empty, and non-hex values', () => {
    expect(normalizeCommitSha('abc123')).toBeUndefined();
    expect(normalizeCommitSha('')).toBeUndefined();
    expect(normalizeCommitSha('g'.repeat(40))).toBeUndefined();
    expect(normalizeCommitSha(42)).toBeUndefined();
    expect(normalizeCommitSha(undefined)).toBeUndefined();
  });
});

describe('evaluateVerificationEvidenceBinding', () => {
  test('a fully bound, matching entry is admissible', () => {
    const verdict = evaluateVerificationEvidenceBinding(boundEntry(), EXPECT_ALL);
    expect(verdict).toMatchObject({ admissible: true });
    expect(verdict.binding).toMatchObject({ headSha: HEAD, commandId: E2E_ID, planDigest: DIGEST });
  });

  test('failed evidence never satisfies (failed_exit)', () => {
    expect(evaluateVerificationEvidenceBinding(boundEntry({ exitCode: 1 }), EXPECT_ALL)).toEqual({
      admissible: false,
      reason: 'failed_exit',
    });
  });

  test('legacy evidence lacking any binding field is conservatively rejected (legacy_unbound)', () => {
    for (const missing of ['headSha', 'planDigest', 'planRevisionOrdinal', 'commandId']) {
      const entry = boundEntry({ [missing]: undefined });
      expect(evaluateVerificationEvidenceBinding(entry, EXPECT_ALL)).toEqual({
        admissible: false,
        reason: 'legacy_unbound',
      });
    }
  });

  test('malformed binding fields are treated exactly like legacy evidence', () => {
    const cases = [
      boundEntry({ headSha: 'deadbeef' }),                 // truncated sha
      boundEntry({ planDigest: 'not-a-digest' }),
      boundEntry({ planRevisionOrdinal: -1 }),
      boundEntry({ planRevisionOrdinal: 1.5 }),
      boundEntry({ commandId: '   ' }),
    ];
    for (const entry of cases) {
      expect(evaluateVerificationEvidenceBinding(entry, EXPECT_ALL)).toEqual({
        admissible: false,
        reason: 'legacy_unbound',
      });
    }
  });

  test('an unresolvable current plan fails closed (plan_unresolvable)', () => {
    expect(
      evaluateVerificationEvidenceBinding(boundEntry(), { headSha: HEAD, commandId: E2E_ID }),
    ).toEqual({ admissible: false, reason: 'plan_unresolvable' });
  });

  test('a slot absent from the current plan fails closed (slot_not_in_plan)', () => {
    expect(
      evaluateVerificationEvidenceBinding(boundEntry(), { headSha: HEAD, planDigest: DIGEST }),
    ).toEqual({ admissible: false, reason: 'slot_not_in_plan' });
  });

  test('evidence recorded for a different slot identity is rejected (identity_mismatch)', () => {
    const expectations = { headSha: HEAD, planDigest: DIGEST, commandId: deriveRequirementCommandId('npm run other') };
    expect(evaluateVerificationEvidenceBinding(boundEntry(), expectations)).toEqual({
      admissible: false,
      reason: 'identity_mismatch',
    });
  });

  test('a §8.3 invalidation record naming the slot rejects the entry (slot_invalidated)', () => {
    const entry = boundEntry({
      invalidations: [{ commandId: E2E_ID, supersededByRevision: 'vamd-0000000000000001' }],
    });
    expect(evaluateVerificationEvidenceBinding(entry, EXPECT_ALL)).toEqual({
      admissible: false,
      reason: 'slot_invalidated',
    });
  });

  test('an invalidation naming a DIFFERENT slot does not reject the entry', () => {
    const entry = boundEntry({
      invalidations: [{ commandId: 'req:ffffffffffffffff', supersededByRevision: 'vamd-0000000000000001' }],
    });
    expect(evaluateVerificationEvidenceBinding(entry, EXPECT_ALL)).toMatchObject({ admissible: true });
  });

  test('malformed invalidations reject the entry (slot_invalidated) instead of throwing', () => {
    // Persisted evidence is untrusted: a hand-edited or corrupted
    // `invalidations` value must fail closed, never crash the review.
    const malformed = [
      {},                                  // not an array
      'invalidated',
      42,
      null,
      [null],                              // marks that are not objects
      ['x'],
      [{ commandId: 42 }],                 // mark without a string commandId
      [{}],
    ];
    for (const invalidations of malformed) {
      expect(evaluateVerificationEvidenceBinding(boundEntry({ invalidations }), EXPECT_ALL)).toEqual({
        admissible: false,
        reason: 'slot_invalidated',
      });
    }
  });

  test('an unresolvable reviewed HEAD fails closed (head_unresolvable)', () => {
    expect(
      evaluateVerificationEvidenceBinding(boundEntry(), { planDigest: DIGEST, commandId: E2E_ID }),
    ).toEqual({ admissible: false, reason: 'head_unresolvable' });
  });

  test('evidence from a different HEAD is stale and fails closed (head_mismatch)', () => {
    expect(
      evaluateVerificationEvidenceBinding(boundEntry(), { ...EXPECT_ALL, headSha: OTHER_HEAD }),
    ).toEqual({ admissible: false, reason: 'head_mismatch' });
  });

  test('a recorded planDigest that differs from the current one does NOT alone reject an unchanged identity', () => {
    // §8.3 preservation: an amendment elsewhere in the plan (e.g. an `add`)
    // moves the digest but invalidates nothing for this slot.
    const entry = boundEntry({ planDigest: 'd'.repeat(64) });
    expect(evaluateVerificationEvidenceBinding(entry, EXPECT_ALL)).toMatchObject({ admissible: true });
  });
});

describe('isVerificationSlotInvalidated', () => {
  test('absent means no invalidation records', () => {
    expect(isVerificationSlotInvalidated(undefined, E2E_ID)).toBe(false);
    expect(isVerificationSlotInvalidated([], E2E_ID)).toBe(false);
  });

  test('well-formed marks invalidate only the named slot', () => {
    const marks = [{ commandId: E2E_ID, supersededByRevision: 'vamd-0000000000000001' }];
    expect(isVerificationSlotInvalidated(marks, E2E_ID)).toBe(true);
    expect(isVerificationSlotInvalidated(marks, 'req:ffffffffffffffff')).toBe(false);
  });

  test('malformed shapes fail closed as invalidated', () => {
    expect(isVerificationSlotInvalidated({}, E2E_ID)).toBe(true);
    expect(isVerificationSlotInvalidated(null, E2E_ID)).toBe(true);
    expect(isVerificationSlotInvalidated([null], E2E_ID)).toBe(true);
    expect(isVerificationSlotInvalidated([{ commandId: 42 }], E2E_ID)).toBe(true);
  });
});

describe('readVerificationEvidenceEntryBinding', () => {
  test('round-trips a well-formed binding', () => {
    expect(readVerificationEvidenceEntryBinding(boundEntry())).toEqual({
      headSha: HEAD,
      planDigest: DIGEST,
      planRevisionOrdinal: 0,
      commandId: E2E_ID,
    });
  });

  test('returns undefined for a legacy entry', () => {
    expect(
      readVerificationEvidenceEntryBinding({ command: E2E, exitCode: 0 }),
    ).toBeUndefined();
  });
});

describe('readVerificationEvidenceBindingBlock', () => {
  test('exports the context key', () => {
    expect(VERIFICATION_EVIDENCE_BINDING_CONTEXT_KEY).toBe('verificationEvidenceBinding');
  });

  test('parses a full block', () => {
    const block = readVerificationEvidenceBindingBlock({
      headSha: HEAD,
      planDigest: DIGEST,
      planRevisionOrdinal: 2,
      commandIds: { [E2E]: E2E_ID },
    });
    expect(block).toEqual({
      headSha: HEAD,
      planDigest: DIGEST,
      planRevisionOrdinal: 2,
      commandIds: { [E2E]: E2E_ID },
    });
  });

  test('parses a partial block (fields optional)', () => {
    expect(readVerificationEvidenceBindingBlock({ headSha: HEAD })).toEqual({ headSha: HEAD });
    expect(readVerificationEvidenceBindingBlock({})).toEqual({});
  });

  test('rejects the whole block on any malformed field', () => {
    expect(readVerificationEvidenceBindingBlock({ headSha: 'nope' })).toBeUndefined();
    expect(readVerificationEvidenceBindingBlock({ planDigest: 'nope' })).toBeUndefined();
    expect(readVerificationEvidenceBindingBlock({ planRevisionOrdinal: -1 })).toBeUndefined();
    expect(readVerificationEvidenceBindingBlock({ commandIds: { [E2E]: '' } })).toBeUndefined();
    expect(readVerificationEvidenceBindingBlock({ commandIds: [E2E_ID] })).toBeUndefined();
    expect(readVerificationEvidenceBindingBlock('block')).toBeUndefined();
    expect(readVerificationEvidenceBindingBlock(null)).toBeUndefined();
  });

  test('parses ambiguousCommands and rejects malformed values (issue #1043 review, P2)', () => {
    expect(readVerificationEvidenceBindingBlock({ ambiguousCommands: [E2E] })).toEqual({
      ambiguousCommands: [E2E],
    });
    expect(readVerificationEvidenceBindingBlock({ ambiguousCommands: E2E })).toBeUndefined();
    expect(readVerificationEvidenceBindingBlock({ ambiguousCommands: [''] })).toBeUndefined();
    expect(readVerificationEvidenceBindingBlock({ ambiguousCommands: [42] })).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Integration with the effective plan (issue #1039 resolver)
// ---------------------------------------------------------------------------

const SESSION = { test: 'npm test' };
const REQUIREMENTS = ['npm test', E2E];

function resolvedPlan(amendmentsFreeOverrides = {}) {
  const result = resolveEffectiveVerificationPlan({
    sessionVerification: SESSION,
    issueRequirements: REQUIREMENTS,
    ...amendmentsFreeOverrides,
  });
  expect(result.status).toBe('resolved');
  return result.plan;
}

describe('buildVerificationEvidenceBindingBlock', () => {
  test('maps every ACTIVE requirement slot to its identity, with plan provenance', () => {
    const plan = resolvedPlan();
    const block = buildVerificationEvidenceBindingBlock(plan, HEAD);
    expect(block).toEqual({
      headSha: HEAD,
      planDigest: plan.planDigest,
      planRevisionOrdinal: 0,
      commandIds: {
        'npm test': deriveRequirementCommandId('npm test'),
        [E2E]: E2E_ID,
      },
    });
    // The block survives its own reader.
    expect(readVerificationEvidenceBindingBlock(block)).toEqual(block);
  });

  test('omits headSha when the reviewed HEAD is unresolvable', () => {
    const block = buildVerificationEvidenceBindingBlock(resolvedPlan(), undefined);
    expect(block.headSha).toBeUndefined();
    expect(block.planDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  test('excludes retired slots — a removed command never becomes recordable-as-passed', () => {
    const base = resolvedPlan();
    const proposed = proposeVerificationRevision({
      plan: base,
      operations: [{ kind: 'retire', commandId: E2E_ID, reason: 'not applicable here' }],
    });
    expect(proposed.status).toBe('ok');
    const block = buildVerificationEvidenceBindingBlock(proposed.plan, HEAD);
    expect(block.commandIds[E2E]).toBeUndefined();
    expect(block.commandIds['npm test']).toBe(deriveRequirementCommandId('npm test'));
  });

  test('byte-identical active slots are excluded from the map and reported ambiguous (issue #1043 review, P2)', () => {
    // A replace can leave two ACTIVE requirement slots carrying the same
    // bytes. A byte-keyed entry can hold only one of the two §5.1 identities,
    // so binding through it would clear whichever slot survived the overwrite
    // while the other rejects the evidence forever. The shared bytes are
    // excluded and reported ambiguous instead.
    const base = resolvedPlan();
    const proposed = proposeVerificationRevision({
      plan: base,
      operations: [
        { kind: 'replace', commandId: deriveRequirementCommandId('npm test'), command: E2E, reason: 'converged on one command' },
      ],
    });
    expect(proposed.status).toBe('ok');
    const block = buildVerificationEvidenceBindingBlock(proposed.plan, HEAD);
    expect(block.commandIds).toEqual({});
    expect(block.ambiguousCommands).toEqual([E2E]);
    // The block survives its own reader.
    expect(readVerificationEvidenceBindingBlock(block)).toEqual(block);
  });
});

describe('buildEffectiveRequirementStatus — evidence binding (issue #1040)', () => {
  function entryFor(plan, overrides = {}) {
    return boundEntry({ planDigest: plan.planDigest, ...overrides });
  }

  test('bound evidence at the reviewed HEAD satisfies its slot', () => {
    const plan = resolvedPlan();
    const rows = buildEffectiveRequirementStatus(plan, [entryFor(plan)], { headSha: HEAD });
    const e2e = rows.find((r) => r.command === E2E);
    expect(e2e).toMatchObject({ status: 'passed', satisfiedBy: 'manual-evidence' });
  });

  test('evidence from a different HEAD cannot produce a pass and reports why', () => {
    const plan = resolvedPlan();
    const rows = buildEffectiveRequirementStatus(
      plan,
      [entryFor(plan, { headSha: OTHER_HEAD })],
      { headSha: HEAD },
    );
    const e2e = rows.find((r) => r.command === E2E);
    expect(e2e.status).toBe('not_run');
    expect(e2e.evidenceRejections).toEqual(['head_mismatch']);
  });

  test('legacy evidence is rejected under binding enforcement but still honored without it', () => {
    const plan = resolvedPlan();
    const legacy = { command: E2E, exitCode: 0 };
    const bound = buildEffectiveRequirementStatus(plan, [legacy], { headSha: HEAD });
    expect(bound.find((r) => r.command === E2E)).toMatchObject({
      status: 'not_run',
      evidenceRejections: ['legacy_unbound'],
    });
    // Without expectations the shipped pre-#1040 semantics are unchanged.
    const unbound = buildEffectiveRequirementStatus(plan, [legacy]);
    expect(unbound.find((r) => r.command === E2E)).toMatchObject({ status: 'passed' });
  });

  test('malformed invalidations fail closed on the pre-#1040 path too, without throwing', () => {
    const plan = resolvedPlan();
    const rows = buildEffectiveRequirementStatus(plan, [entryFor(plan, { invalidations: {} })]);
    expect(rows.find((r) => r.command === E2E)).toMatchObject({ status: 'not_run' });
  });

  test('a replaced slot no longer matches evidence recorded for the old bytes', () => {
    const base = resolvedPlan();
    const proposed = proposeVerificationRevision({
      plan: base,
      operations: [{ kind: 'replace', commandId: E2E_ID, command: 'npm run e2e -- --ci', reason: 'fix flag' }],
    });
    expect(proposed.status).toBe('ok');
    const rows = buildEffectiveRequirementStatus(proposed.plan, [entryFor(base)], { headSha: HEAD });
    const replaced = rows.find((r) => r.commandId === E2E_ID);
    // The evidence's bytes no longer match the corrected slot bytes, so no
    // candidate matches at all: stale evidence cannot satisfy the changed plan.
    expect(replaced).toMatchObject({ status: 'not_run' });
    expect(replaced.evidenceRejections).toBeUndefined();
  });

  test('an added slot is not satisfied by evidence recorded for another identity', () => {
    const base = resolvedPlan();
    const proposed = proposeVerificationRevision({
      plan: base,
      operations: [{ kind: 'add', layer: 'requirement', command: 'npm run new-check', reason: 'add check' }],
    });
    expect(proposed.status).toBe('ok');
    // Evidence byte-matching the NEW command but recorded for the e2e slot.
    const rows = buildEffectiveRequirementStatus(
      proposed.plan,
      [entryFor(base, { command: 'npm run new-check' })],
      { headSha: HEAD },
    );
    const added = rows.find((r) => r.command === 'npm run new-check');
    expect(added.status).toBe('not_run');
    expect(added.evidenceRejections).toEqual(['identity_mismatch']);
    // ...while the e2e slot is not satisfied either: the entry's bytes no
    // longer match its own slot.
    expect(rows.find((r) => r.command === E2E)).toMatchObject({ status: 'not_run' });
  });

  test('a retired slot reports retired, never passed, whatever evidence exists', () => {
    const base = resolvedPlan();
    const proposed = proposeVerificationRevision({
      plan: base,
      operations: [{ kind: 'retire', commandId: E2E_ID, reason: 'not applicable' }],
    });
    expect(proposed.status).toBe('ok');
    const rows = buildEffectiveRequirementStatus(proposed.plan, [entryFor(base)], { headSha: HEAD });
    expect(rows.find((r) => r.commandId === E2E_ID)).toMatchObject({ state: 'retired', status: 'retired' });
  });

  test('partial evidence: one bound slot passes while the other stays not_run', () => {
    const plan = resolveEffectiveVerificationPlan({
      sessionVerification: {},
      issueRequirements: [E2E, 'npm run lint'],
    }).plan;
    const rows = buildEffectiveRequirementStatus(plan, [entryFor(plan)], { headSha: HEAD });
    expect(rows.find((r) => r.command === E2E)).toMatchObject({ status: 'passed' });
    expect(rows.find((r) => r.command === 'npm run lint')).toMatchObject({ status: 'not_run' });
  });

  test('failed evidence surfaces failed_exit and keeps the slot unsatisfied', () => {
    const plan = resolvedPlan();
    const rows = buildEffectiveRequirementStatus(plan, [entryFor(plan, { exitCode: 2 })], { headSha: HEAD });
    const e2e = rows.find((r) => r.command === E2E);
    expect(e2e.status).toBe('not_run');
    expect(e2e.evidenceRejections).toEqual(['failed_exit']);
  });

  test('an unresolvable reviewed HEAD fails closed for every evidence-satisfied slot', () => {
    const plan = resolvedPlan();
    const rows = buildEffectiveRequirementStatus(plan, [entryFor(plan)], {});
    const e2e = rows.find((r) => r.command === E2E);
    expect(e2e.status).toBe('not_run');
    expect(e2e.evidenceRejections).toEqual(['head_unresolvable']);
    // Execution-satisfied slots are untouched by evidence binding.
    expect(rows.find((r) => r.command === 'npm test')).toMatchObject({
      status: 'passed',
      satisfiedBy: 'execution',
    });
  });
});
