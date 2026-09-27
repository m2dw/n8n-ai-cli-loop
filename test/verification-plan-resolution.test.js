// Issue #1039 — effective verification plan resolution
// (docs/verification-amendment-contract.md §6, §15 slice A1).
//
// Pins the resolver contract the later slices build on: §6.1/§6.2 layering and
// ordering, §5.1 stable slot identity with origin and amendment metadata, the
// §5.4 plan digest, the §5.2/§5.3 rule 7 authoring refusals and sequential
// composition, the §6.4 three-way reconciliation with its rule 4 dispositions,
// and §6.2 rule 3 satisfaction on the shipped equivalence semantics —
// including the promise that a task with no amendments resolves to current
// behavior.
import {
  resolveEffectiveVerificationPlan,
  proposeVerificationRevision,
  reconcileVerificationPlan,
  buildEffectiveRequirementStatus,
  buildVerificationSessionBaseline,
  effectiveVerificationCommands,
  verificationPlanSlotCounts,
  verificationPlanDispositions,
  deriveRequirementCommandId,
  deriveSessionBaselineDigest,
} from '../dist/index.js';
import { buildIssueVerificationStatus } from '../dist/handlers/verification.js';

const SESSION = { test: 'npm test', lint: 'npm run lint' };
const REQUIREMENTS = ['npm test', 'npm run e2e'];

const digest = (ch) => ch.repeat(64);
const revisionId = (n) => `vamd-${n.toString(16).padStart(16, '0')}`;
const REQ = (command) => deriveRequirementCommandId(command);

/**
 * Build a chain + checkpoint block that `validateVerificationAmendmentState`
 * accepts: contiguous ordinals, unique keys and ids, a checkpoint whose
 * `appliedThroughOrdinal` matches the chain and whose `planDigest` matches the
 * final revision's under `updatedBy: "revision"` (§5.5 rule 3).
 */
function makeState(revisions, options = {}) {
  const sessionBaseline = options.sessionBaseline ?? [{ name: 'test', command: 'npm test' }];
  const sessionBaselineDigest = deriveSessionBaselineDigest(sessionBaseline);
  const planDigest = options.planDigest ?? digest('b');
  return {
    revisions: revisions.map((revision, index) => ({
      revisionId: revision.revisionId ?? revisionId(index + 1),
      revisionOrdinal: index + 1,
      requestKey: revision.requestKey ?? `key-${index + 1}`,
      scope: 'task',
      source: 'admin-cli',
      actor: { kind: 'operator', id: 'moto' },
      reason: revision.reason ?? 'operator correction',
      operations: revision.operations,
      basePlanDigest: digest('a'),
      planDigest,
      sessionBaselineDigest,
      continuation: 'review',
      createdAt: '2026-09-02T00:00:00.000Z',
      observedTaskRevision: index,
    })),
    checkpoint: {
      planDigest,
      sessionBaseline,
      sessionBaselineDigest,
      appliedThroughOrdinal: revisions.length,
      updatedAt: '2026-09-02T00:00:00.000Z',
      updatedBy: options.updatedBy ?? 'revision',
    },
  };
}

function resolved(input) {
  const result = resolveEffectiveVerificationPlan(input);
  expect(result.status).toBe('resolved');
  return result.plan;
}

const notesOfKind = (plan, kind) => plan.notes.filter((note) => note.kind === kind);

describe('resolveEffectiveVerificationPlan — layers, ordering, identity (§6.1–§6.3)', () => {
  test('an unamended task resolves the live session map and the pinned requirements', () => {
    const plan = resolved({ sessionVerification: SESSION, issueRequirements: REQUIREMENTS });

    expect(plan.execution.map((slot) => slot.commandId)).toEqual(['exec:test', 'exec:lint']);
    expect(plan.execution.map((slot) => slot.command)).toEqual(['npm test', 'npm run lint']);
    expect(plan.execution.every((slot) => slot.origin === 'session-default')).toBe(true);
    expect(plan.execution.every((slot) => slot.state === 'active' && !slot.amended)).toBe(true);

    expect(plan.requirement.map((slot) => slot.commandId)).toEqual([
      REQ('npm test'),
      REQ('npm run e2e'),
    ]);
    expect(plan.requirement.every((slot) => slot.origin === 'issue-requirement')).toBe(true);
    expect(plan.appliedThroughOrdinal).toBe(0);
    expect(plan.notes).toEqual([]);
  });

  test('identical inputs produce the same ordered plan and the same digest', () => {
    const a = resolved({ sessionVerification: SESSION, issueRequirements: REQUIREMENTS });
    const b = resolved({ sessionVerification: { ...SESSION }, issueRequirements: [...REQUIREMENTS] });
    expect(b.planDigest).toBe(a.planDigest);
    expect(b.execution).toEqual(a.execution);
    expect(b.requirement).toEqual(a.requirement);
  });

  test('the digest is order-sensitive and state-sensitive', () => {
    const base = resolved({ sessionVerification: SESSION, issueRequirements: REQUIREMENTS });
    const reordered = resolved({
      sessionVerification: { lint: 'npm run lint', test: 'npm test' },
      issueRequirements: REQUIREMENTS,
    });
    expect(reordered.planDigest).not.toBe(base.planDigest);

    const retired = resolved({
      sessionVerification: SESSION,
      issueRequirements: REQUIREMENTS,
      amendments: makeState([
        { operations: [{ kind: 'retire', commandId: 'exec:lint', reason: 'not configured here' }] },
      ]),
    });
    expect(retired.planDigest).not.toBe(base.planDigest);
  });

  test('empty inputs resolve to an empty plan with a digest, not an error', () => {
    const plan = resolved({});
    expect(plan.execution).toEqual([]);
    expect(plan.requirement).toEqual([]);
    expect(plan.planDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  test('identity is byte-preserving: interior whitespace takes two slots', () => {
    const plan = resolved({ issueRequirements: ["printf 'a  b'", "printf 'a b'"] });
    expect(plan.requirement).toHaveLength(2);
    expect(plan.requirement[0].commandId).not.toBe(plan.requirement[1].commandId);
    expect(plan.requirement.map((slot) => slot.command)).toEqual(["printf 'a  b'", "printf 'a b'"]);
  });

  test('two byte-identical source commands collapse to one slot, and the collapse is reported', () => {
    const plan = resolved({ issueRequirements: ['npm test', ' npm test ', 'npm run lint'] });
    expect(plan.requirement.map((slot) => slot.commandId)).toEqual([REQ('npm test'), REQ('npm run lint')]);
    expect(notesOfKind(plan, 'duplicate_command')).toEqual([
      { kind: 'duplicate_command', commandId: REQ('npm test'), layer: 'requirement', occurrences: 2 },
    ]);
  });
});

describe('resolveEffectiveVerificationPlan — the amendment overlay (§3.2, §6.1 step 2)', () => {
  test('a replace substitutes bytes in place, keeps the identity, position, and origin', () => {
    const amendments = makeState([
      {
        operations: [
          { kind: 'replace', commandId: 'exec:test', command: 'npm run test:ci', reason: 'typo' },
        ],
      },
    ]);
    const plan = resolved({ sessionVerification: SESSION, issueRequirements: REQUIREMENTS, amendments });

    expect(plan.execution[0]).toMatchObject({
      commandId: 'exec:test',
      name: 'test',
      command: 'npm run test:ci',
      originCommand: 'npm test',
      origin: 'session-default',
      state: 'active',
      amended: true,
    });
    expect(plan.execution[0].amendments).toEqual([
      { revisionId: revisionId(1), revisionOrdinal: 1, operationIndex: 0, kind: 'replace' },
    ]);
    // The overlay never rewrites its origin: the input map is untouched.
    expect(SESSION.test).toBe('npm test');
  });

  test('an execution add appends after every session slot and resolves as a runnable command', () => {
    const amendments = makeState([
      {
        operations: [
          { kind: 'add', layer: 'execution', name: 'e2e', command: 'npm run e2e', reason: 'issue requires it' },
        ],
      },
    ]);
    const plan = resolved({ sessionVerification: SESSION, issueRequirements: REQUIREMENTS, amendments });

    expect(plan.execution.map((slot) => slot.commandId)).toEqual(['exec:test', 'exec:lint', 'exec:e2e']);
    expect(plan.execution[2]).toMatchObject({ origin: 'task-amendment', name: 'e2e', amended: true });
    expect(effectiveVerificationCommands(plan)).toEqual({
      test: 'npm test',
      lint: 'npm run lint',
      e2e: 'npm run e2e',
    });
  });

  test('adds accumulate in revision-then-operation order', () => {
    const amendments = makeState([
      {
        operations: [
          { kind: 'add', layer: 'execution', name: 'e2e', command: 'npm run e2e', reason: 'first' },
          { kind: 'add', layer: 'execution', name: 'smoke', command: 'npm run smoke', reason: 'first' },
        ],
      },
      {
        operations: [
          { kind: 'add', layer: 'execution', name: 'perf', command: 'npm run perf', reason: 'second' },
        ],
      },
    ]);
    const plan = resolved({ sessionVerification: SESSION, amendments });
    expect(plan.execution.map((slot) => slot.name)).toEqual(['test', 'lint', 'e2e', 'smoke', 'perf']);
  });

  test('last write wins per slot, not per plan', () => {
    const amendments = makeState([
      { operations: [{ kind: 'replace', commandId: 'exec:test', command: 'npm run test:ci', reason: 'one' }] },
      { operations: [{ kind: 'replace', commandId: 'exec:lint', command: 'npm run lint:all', reason: 'two' }] },
    ]);
    const plan = resolved({ sessionVerification: SESSION, amendments });
    expect(plan.execution.map((slot) => slot.command)).toEqual(['npm run test:ci', 'npm run lint:all']);
  });

  test('a retired slot stays in the plan and in the digest, and is excluded from execution', () => {
    const amendments = makeState([
      { operations: [{ kind: 'retire', commandId: 'exec:lint', reason: 'no linter in this repo' }] },
    ]);
    const plan = resolved({ sessionVerification: SESSION, amendments });

    expect(plan.execution.map((slot) => [slot.commandId, slot.state])).toEqual([
      ['exec:test', 'active'],
      ['exec:lint', 'retired'],
    ]);
    expect(effectiveVerificationCommands(plan)).toEqual({ test: 'npm test' });
    expect(verificationPlanSlotCounts(plan)).toEqual({
      execution: { active: 1, retired: 1 },
      requirement: { active: 0, retired: 0 },
    });
  });

  test('a retirement followed by a restoration leaves the digest equal to the pre-retirement one', () => {
    const base = resolved({ sessionVerification: SESSION, issueRequirements: REQUIREMENTS });
    const restored = resolved({
      sessionVerification: SESSION,
      issueRequirements: REQUIREMENTS,
      amendments: makeState([
        {
          operations: [
            { kind: 'retire', commandId: 'exec:lint', reason: 'mistake' },
            { kind: 'restore', commandId: 'exec:lint', reason: 'reinstated' },
          ],
        },
      ]),
    });
    expect(restored.planDigest).toBe(base.planDigest);
    expect(restored.execution[1]).toMatchObject({ state: 'active', command: 'npm run lint', amended: true });
  });

  test('an operation whose target slot is absent is inert and reports the slot orphaned', () => {
    const amendments = makeState([
      {
        operations: [
          { kind: 'replace', commandId: 'exec:gone', command: 'npm run gone', reason: 'was a session key' },
          { kind: 'retire', commandId: 'exec:gone', reason: 'and retired' },
        ],
      },
    ]);
    const plan = resolved({ sessionVerification: SESSION, amendments });

    expect(plan.execution.map((slot) => slot.commandId)).toEqual(['exec:test', 'exec:lint']);
    expect(notesOfKind(plan, 'orphaned_slot')).toEqual([
      {
        kind: 'orphaned_slot',
        commandId: 'exec:gone',
        layer: 'execution',
        operations: [
          { revisionId: revisionId(1), revisionOrdinal: 1, operationIndex: 0, kind: 'replace' },
          { revisionId: revisionId(1), revisionOrdinal: 1, operationIndex: 1, kind: 'retire' },
        ],
      },
    ]);
    expect(verificationPlanDispositions(plan).orphaned).toEqual(['exec:gone']);
  });

  test('an orphaned slot replays onto the key when it returns, bytes and state intact', () => {
    const amendments = makeState([
      {
        operations: [
          { kind: 'replace', commandId: 'exec:gone', command: 'npm run gone', reason: 'corrected' },
          { kind: 'retire', commandId: 'exec:gone', reason: 'and retired' },
        ],
      },
    ]);
    const plan = resolved({ sessionVerification: { ...SESSION, gone: 'npm run stale' }, amendments });
    expect(plan.execution[2]).toMatchObject({
      commandId: 'exec:gone',
      command: 'npm run gone',
      state: 'retired',
    });
    expect(notesOfKind(plan, 'orphaned_slot')).toEqual([]);
  });

  test('a session key colliding with a task-local add is masked, never a second slot', () => {
    const amendments = makeState([
      {
        operations: [
          { kind: 'add', layer: 'execution', name: 'e2e', command: 'npm run e2e -- --ci', reason: 'task-local' },
        ],
      },
    ]);
    const plan = resolved({ sessionVerification: { test: 'npm test', e2e: 'npm run e2e' }, amendments });

    expect(plan.execution.map((slot) => slot.commandId)).toEqual(['exec:test', 'exec:e2e']);
    expect(plan.execution[1]).toMatchObject({ command: 'npm run e2e -- --ci', origin: 'task-amendment' });
    expect(notesOfKind(plan, 'masked_session_entry')).toEqual([
      { kind: 'masked_session_entry', commandId: 'exec:e2e', name: 'e2e', maskedByRevisionId: revisionId(1) },
    ]);
    expect(verificationPlanDispositions(plan).masked).toEqual(['exec:e2e']);
  });

  test('retiring the task-local slot does not unmask the session entry', () => {
    const amendments = makeState([
      {
        operations: [
          { kind: 'add', layer: 'execution', name: 'e2e', command: 'npm run e2e -- --ci', reason: 'task-local' },
        ],
      },
      { operations: [{ kind: 'retire', commandId: 'exec:e2e', reason: 'not needed after all' }] },
    ]);
    const plan = resolved({ sessionVerification: { test: 'npm test', e2e: 'npm run e2e' }, amendments });

    expect(plan.execution.map((slot) => [slot.commandId, slot.state, slot.command])).toEqual([
      ['exec:test', 'active', 'npm test'],
      ['exec:e2e', 'retired', 'npm run e2e -- --ci'],
    ]);
    expect(notesOfKind(plan, 'masked_session_entry')).toHaveLength(1);
  });

  test('a replayed add whose identity a slot already holds materializes no second slot', () => {
    const amendments = makeState([
      { operations: [{ kind: 'add', layer: 'requirement', command: 'npm test', reason: 'duplicate of the pinned one' }] },
    ]);
    const plan = resolved({ issueRequirements: ['npm test'], amendments });

    expect(plan.requirement).toHaveLength(1);
    expect(notesOfKind(plan, 'colliding_add')).toEqual([
      {
        kind: 'colliding_add',
        commandId: REQ('npm test'),
        layer: 'requirement',
        revisionId: revisionId(1),
        operationIndex: 0,
      },
    ]);
  });

  test('same-layer wrapper equivalence is reported as an ambiguity, never a refusal', () => {
    const plan = resolved({ sessionVerification: { test: 'npm test', wrapped: "bash -lc 'npm test'" } });
    expect(notesOfKind(plan, 'ambiguous_equivalence')).toEqual([
      { kind: 'ambiguous_equivalence', layer: 'execution', commandIds: ['exec:test', 'exec:wrapped'] },
    ]);
    // Cross-layer equivalence is the designed satisfaction path, not ambiguity.
    const crossLayer = resolved({
      sessionVerification: { test: "bash -lc 'npm test'" },
      issueRequirements: ['npm test'],
    });
    expect(notesOfKind(crossLayer, 'ambiguous_equivalence')).toEqual([]);
  });
});

describe('resolveEffectiveVerificationPlan — explicit validation failures', () => {
  test('an empty session command is refused, not dropped', () => {
    expect(resolveEffectiveVerificationPlan({ sessionVerification: { test: '  ' } })).toEqual({
      status: 'invalid',
      reason: 'session_verification',
      detail: 'sessionVerification["test"]: empty command',
    });
  });

  test('a session name no exec identity can be formed from is refused', () => {
    const result = resolveEffectiveVerificationPlan({ sessionVerification: { 'unit test': 'npm test' } });
    expect(result.status).toBe('invalid');
    expect(result.reason).toBe('session_verification');
    expect(result.detail).toContain('§5.1 character rule');
  });

  test('an empty issue requirement is refused', () => {
    const result = resolveEffectiveVerificationPlan({ issueRequirements: ['npm test', '   '] });
    expect(result).toEqual({
      status: 'invalid',
      reason: 'issue_requirements',
      detail: 'issueRequirements[1]: empty command',
    });
  });

  test('malformed persisted amendment state fails closed', () => {
    const state = makeState([
      { operations: [{ kind: 'retire', commandId: 'exec:lint', reason: 'x' }] },
    ]);
    state.checkpoint.appliedThroughOrdinal = 7;
    const result = resolveEffectiveVerificationPlan({ sessionVerification: SESSION, amendments: state });
    expect(result.status).toBe('invalid');
    expect(result.reason).toBe('amendment_state');
    expect(result.detail).toContain('appliedThroughOrdinal');
  });

  test('a chain with no checkpoint beside it fails closed', () => {
    const state = makeState([
      { operations: [{ kind: 'retire', commandId: 'exec:lint', reason: 'x' }] },
    ]);
    delete state.checkpoint;
    const result = resolveEffectiveVerificationPlan({ sessionVerification: SESSION, amendments: state });
    expect(result.status).toBe('invalid');
    expect(result.reason).toBe('amendment_state');
  });
});

describe('proposeVerificationRevision — the §5.2 table and §5.3 rule 7 composition', () => {
  const basePlan = () => resolved({ sessionVerification: SESSION, issueRequirements: REQUIREMENTS });

  test('a valid revision returns the produced plan, its digest, and the base digest', () => {
    const base = basePlan();
    const result = proposeVerificationRevision({
      plan: base,
      operations: [
        { kind: 'replace', commandId: 'exec:test', command: 'npm run test:ci', reason: 'typo' },
        { kind: 'add', layer: 'execution', name: 'e2e', command: 'npm run e2e', reason: 'issue requires it' },
      ],
      revisionId: revisionId(1),
    });

    expect(result.status).toBe('ok');
    expect(result.basePlanDigest).toBe(base.planDigest);
    expect(result.planDigest).not.toBe(base.planDigest);
    expect(result.plan.execution.map((slot) => slot.command)).toEqual([
      'npm run test:ci',
      'npm run lint',
      'npm run e2e',
    ]);
    expect(result.plan.appliedThroughOrdinal).toBe(1);
    // The base plan the caller read is untouched — resolution is pure.
    expect(base.execution[0].command).toBe('npm test');
  });

  test('two different revision paths to the same plan produce the same digest', () => {
    const base = basePlan();
    const direct = proposeVerificationRevision({
      plan: base,
      operations: [{ kind: 'replace', commandId: 'exec:test', command: 'npm run test:ci', reason: 'once' }],
    });
    const roundabout = proposeVerificationRevision({
      plan: proposeVerificationRevision({
        plan: base,
        operations: [{ kind: 'replace', commandId: 'exec:test', command: 'npm run wrong', reason: 'first try' }],
      }).plan,
      operations: [{ kind: 'replace', commandId: 'exec:test', command: 'npm run test:ci', reason: 'second try' }],
    });
    expect(roundabout.planDigest).toBe(direct.planDigest);
  });

  test('an operation naming no slot refuses the whole revision', () => {
    const result = proposeVerificationRevision({
      plan: basePlan(),
      operations: [
        { kind: 'replace', commandId: 'exec:test', command: 'npm run test:ci', reason: 'fine' },
        { kind: 'retire', commandId: 'exec:missing', reason: 'not there' },
      ],
    });
    expect(result).toMatchObject({ status: 'refused', reason: 'unknown_slot', operationIndex: 1 });
  });

  test('a no-op replace is not a revision', () => {
    const result = proposeVerificationRevision({
      plan: basePlan(),
      operations: [{ kind: 'replace', commandId: 'exec:test', command: 'npm test', reason: 'same bytes' }],
    });
    expect(result).toMatchObject({ status: 'refused', reason: 'no_op', operationIndex: 0 });
  });

  test('an add colliding with an active or a retired slot refuses, and the retired one points at restore', () => {
    const base = basePlan();
    expect(
      proposeVerificationRevision({
        plan: base,
        operations: [{ kind: 'add', layer: 'execution', name: 'lint', command: 'npm run lint:all', reason: 'x' }],
      }),
    ).toMatchObject({ status: 'refused', reason: 'duplicate_slot' });

    const retired = proposeVerificationRevision({
      plan: base,
      operations: [{ kind: 'retire', commandId: 'exec:lint', reason: 'gone' }],
    }).plan;
    const collision = proposeVerificationRevision({
      plan: retired,
      operations: [{ kind: 'add', layer: 'execution', name: 'lint', command: 'npm run lint', reason: 'back' }],
    });
    expect(collision.reason).toBe('duplicate_slot');
    expect(collision.detail).toContain('restore');
  });

  test('double retire, double restore, and restoring an active slot each refuse', () => {
    const base = basePlan();
    expect(
      proposeVerificationRevision({
        plan: base,
        operations: [
          { kind: 'retire', commandId: 'exec:lint', reason: 'once' },
          { kind: 'retire', commandId: 'exec:lint', reason: 'twice' },
        ],
      }),
    ).toMatchObject({ status: 'refused', reason: 'slot_retired', operationIndex: 1 });

    expect(
      proposeVerificationRevision({
        plan: base,
        operations: [{ kind: 'restore', commandId: 'exec:lint', reason: 'already active' }],
      }),
    ).toMatchObject({ status: 'refused', reason: 'slot_active' });
  });

  test('composition is sequential: restore then replace applies, retire then replace refuses', () => {
    const retiredPlan = proposeVerificationRevision({
      plan: basePlan(),
      operations: [{ kind: 'retire', commandId: 'exec:lint', reason: 'mistake' }],
    }).plan;

    const corrected = proposeVerificationRevision({
      plan: retiredPlan,
      operations: [
        { kind: 'restore', commandId: 'exec:lint', reason: 'reinstated' },
        { kind: 'replace', commandId: 'exec:lint', command: 'npm run lint:all', reason: 'and corrected' },
      ],
    });
    expect(corrected.status).toBe('ok');
    expect(corrected.plan.execution[1]).toMatchObject({ state: 'active', command: 'npm run lint:all' });

    expect(
      proposeVerificationRevision({
        plan: basePlan(),
        operations: [
          { kind: 'retire', commandId: 'exec:lint', reason: 'first' },
          { kind: 'replace', commandId: 'exec:lint', command: 'npm run lint:all', reason: 'then' },
        ],
      }),
    ).toMatchObject({ status: 'refused', reason: 'slot_retired', operationIndex: 1 });
  });

  test('replace then retire of one slot applies, leaving the replaced bytes retired', () => {
    const result = proposeVerificationRevision({
      plan: basePlan(),
      operations: [
        { kind: 'replace', commandId: 'exec:lint', command: 'npm run lint:all', reason: 'corrected' },
        { kind: 'retire', commandId: 'exec:lint', reason: 'and dropped' },
      ],
    });
    expect(result.status).toBe('ok');
    expect(result.plan.execution[1]).toMatchObject({ command: 'npm run lint:all', state: 'retired' });
    expect(result.plan.execution[1].amendments.map((record) => record.kind)).toEqual(['replace', 'retire']);
  });

  test('a second add of an identity an earlier add in the same revision created refuses', () => {
    const result = proposeVerificationRevision({
      plan: basePlan(),
      operations: [
        { kind: 'add', layer: 'execution', name: 'e2e', command: 'npm run e2e', reason: 'first' },
        { kind: 'add', layer: 'execution', name: 'e2e', command: 'npm run e2e:ci', reason: 'second' },
      ],
    });
    expect(result).toMatchObject({ status: 'refused', reason: 'duplicate_slot', operationIndex: 1 });
  });

  test('a malformed operation refuses the revision and names the field', () => {
    for (const operations of [
      [{ kind: 'reorder', commandId: 'exec:test', reason: 'no such kind' }],
      [{ kind: 'add', layer: 'workflow', command: 'npm test', reason: 'no such layer' }],
      [{ kind: 'retire', commandId: 'exec:test' }],
      [{ kind: 'retire', commandId: 'exec:test', reason: '   ' }],
      [{ kind: 'replace', commandId: 'exec:test', command: 'npm test', reason: 'x', scope: 'task' }],
      [{ kind: 'add', layer: 'requirement', name: 'nope', command: 'npm test', reason: 'x' }],
    ]) {
      const result = proposeVerificationRevision({ plan: basePlan(), operations });
      expect(result.status).toBe('refused');
      expect(result.reason).toBe('invalid_operation');
    }
  });

  test('an empty operation list refuses', () => {
    expect(proposeVerificationRevision({ plan: basePlan(), operations: [] })).toMatchObject({
      status: 'refused',
      reason: 'invalid_operation',
    });
  });

  test('an operation naming a pinned entry refuses the revision', () => {
    const result = proposeVerificationRevision({
      plan: basePlan(),
      operations: [{ kind: 'retire', commandId: 'exec:test', reason: 'approved plan entry' }],
      pinnedCommandIds: ['exec:test'],
    });
    expect(result).toMatchObject({ status: 'refused', reason: 'pinned_entry' });
  });

  test('a requirement-layer add derives its identity from its bytes', () => {
    const result = proposeVerificationRevision({
      plan: basePlan(),
      operations: [{ kind: 'add', layer: 'requirement', command: 'npm run smoke', reason: 'issue demands it' }],
    });
    expect(result.status).toBe('ok');
    expect(result.plan.requirement.at(-1)).toMatchObject({
      commandId: REQ('npm run smoke'),
      origin: 'task-amendment',
      state: 'active',
    });
  });
});

describe('buildEffectiveRequirementStatus — §6.2 rule 3 satisfaction', () => {
  test('an unamended plan reproduces the shipped buildIssueVerificationStatus statuses', () => {
    const session = { test: 'npm test', wrapped: "bash -lc 'cd frontend && npm test'" };
    const required = ['npm test', 'cd frontend && npm test', 'npm run e2e'];
    const plan = resolved({ sessionVerification: session, issueRequirements: required });

    const shipped = buildIssueVerificationStatus(required, session);
    const effective = buildEffectiveRequirementStatus(plan);
    expect(effective.map((entry) => [entry.command, entry.status])).toEqual(
      shipped.map((entry) => [entry.command, entry.status]),
    );
    expect(effective.map((entry) => entry.status)).toEqual(['passed', 'passed', 'not_run']);
  });

  test('an execution-layer add satisfies the requirement that blocked the gate', () => {
    const amendments = makeState([
      {
        operations: [
          { kind: 'add', layer: 'execution', name: 'e2e', command: 'npm run e2e', reason: 'issue requires it' },
        ],
      },
    ]);
    const plan = resolved({ sessionVerification: SESSION, issueRequirements: REQUIREMENTS, amendments });
    expect(buildEffectiveRequirementStatus(plan).map((entry) => entry.status)).toEqual(['passed', 'passed']);
  });

  test('a retired requirement is reported retired, never passed and never not_run', () => {
    const amendments = makeState([
      { operations: [{ kind: 'retire', commandId: REQ('npm run e2e'), reason: 'copied from a sibling issue' }] },
    ]);
    const plan = resolved({ sessionVerification: SESSION, issueRequirements: REQUIREMENTS, amendments });
    const status = buildEffectiveRequirementStatus(plan);
    expect(status.map((entry) => entry.status)).toEqual(['passed', 'retired']);
    expect(status[1]).toMatchObject({ state: 'retired', commandId: REQ('npm run e2e') });
    expect(status[1].satisfiedBy).toBeUndefined();
  });

  test('passing manual evidence satisfies a slot unless a §8.3 record names it', () => {
    const plan = resolved({ issueRequirements: ['npm run e2e', 'npm run smoke'] });
    const entry = { command: 'npm run e2e', exitCode: 0, output: '', recordedAt: '2026-09-02T00:00:00.000Z', source: 'operator_input' };

    expect(buildEffectiveRequirementStatus(plan, [entry])[0]).toMatchObject({
      status: 'passed',
      satisfiedBy: 'manual-evidence',
    });

    const superseded = {
      ...entry,
      invalidations: [{ commandId: REQ('npm run e2e'), supersededByRevision: revisionId(1) }],
    };
    expect(buildEffectiveRequirementStatus(plan, [superseded])[0].status).toBe('not_run');

    // The mark is per slot: an entry invalidated for one slot stays admissible
    // for every other slot it satisfies.
    const other = {
      ...entry,
      command: 'npm run smoke',
      invalidations: [{ commandId: REQ('npm run e2e'), supersededByRevision: revisionId(1) }],
    };
    expect(buildEffectiveRequirementStatus(plan, [other])[1].status).toBe('passed');
  });

  test('failing manual evidence never satisfies a slot', () => {
    const plan = resolved({ issueRequirements: ['npm run e2e'] });
    const failing = [{ command: 'npm run e2e', exitCode: 1 }];
    expect(buildEffectiveRequirementStatus(plan, failing)[0].status).toBe('not_run');
  });
});

describe('reconcileVerificationPlan — §6.4 drift and the task baseline', () => {
  const baseline = [{ name: 'test', command: 'npm test' }];

  function stateFor(operations, options = {}) {
    const sessionBaseline = options.sessionBaseline ?? baseline;
    const probe = resolveEffectiveVerificationPlan({
      sessionVerification: sessionBaseline,
      issueRequirements: options.issueRequirements,
      amendments: makeState([{ operations }], { sessionBaseline, planDigest: digest('b') }),
    });
    expect(probe.status).toBe('resolved');
    return makeState([{ operations }], {
      sessionBaseline,
      planDigest: options.planDigest ?? probe.plan.planDigest,
    });
  }

  test('a task with no revision needs no reconciliation', () => {
    const result = reconcileVerificationPlan({ sessionVerification: { test: 'npm test' } });
    expect(result.status).toBe('unamended');
    expect(result.plan.execution).toHaveLength(1);
  });

  test('an unmoved session layer whose recomputation reproduces the digest is consistent', () => {
    const amendments = stateFor([{ kind: 'annotate', commandId: 'exec:test', reason: 'checked' }]);
    const result = reconcileVerificationPlan({ sessionVerification: { test: 'npm test' }, amendments });
    expect(result.status).toBe('consistent');
  });

  test('a session-default edit after an amendment drifts, resolves live, and is not refused', () => {
    const amendments = stateFor([{ kind: 'annotate', commandId: 'exec:test', reason: 'checked' }]);
    const live = { test: 'npm test -- --ci' };
    const result = reconcileVerificationPlan({ sessionVerification: live, amendments });

    expect(result.status).toBe('drifted');
    expect(result.plan.execution[0].command).toBe('npm test -- --ci');
    expect(result.previousPlanDigest).toBe(amendments.checkpoint.planDigest);
    expect(result.previousSessionBaselineDigest).toBe(amendments.checkpoint.sessionBaselineDigest);
    expect(result.checkpoint).toEqual({
      planDigest: result.plan.planDigest,
      sessionBaseline: [{ name: 'test', command: 'npm test -- --ci' }],
      sessionBaselineDigest: deriveSessionBaselineDigest([{ name: 'test', command: 'npm test -- --ci' }]),
    });
    expect(result.checkpoint.planDigest).not.toBe(result.previousPlanDigest);
  });

  test('a plan-neutral drift still drifts, with equal plan digests and different baselines', () => {
    const amendments = stateFor(
      [{ kind: 'add', layer: 'execution', name: 'e2e', command: 'npm run e2e -- --ci', reason: 'task-local' }],
      { sessionBaseline: [] },
    );
    const result = reconcileVerificationPlan({ sessionVerification: { e2e: 'npm run e2e' }, amendments });

    expect(result.status).toBe('drifted');
    expect(result.checkpoint.planDigest).toBe(result.previousPlanDigest);
    expect(result.checkpoint.sessionBaselineDigest).not.toBe(result.previousSessionBaselineDigest);
    expect(result.dispositions).toEqual({ masked: ['exec:e2e'], orphaned: [] });
  });

  test('a stored digest no recorded input derives is unreconciled and repairs nothing', () => {
    const amendments = stateFor([{ kind: 'annotate', commandId: 'exec:test', reason: 'checked' }], {
      planDigest: digest('f'),
    });
    const result = reconcileVerificationPlan({ sessionVerification: { test: 'npm test' }, amendments });
    expect(result.status).toBe('unreconciled');
    expect(result.detail).toContain(digest('f'));
    expect(amendments.checkpoint.planDigest).toBe(digest('f'));
  });

  test('a session entry changed under a replaced slot stays overridden and is reported masked', () => {
    const amendments = stateFor([
      { kind: 'replace', commandId: 'exec:test', command: 'npm run test:ci', reason: 'typo' },
    ]);
    const result = reconcileVerificationPlan({ sessionVerification: { test: 'npm test -- --ci' }, amendments });

    expect(result.status).toBe('drifted');
    // The amendment still wins (§3.2): the live session bytes never reach the plan.
    expect(result.plan.execution[0]).toMatchObject({
      commandId: 'exec:test',
      command: 'npm run test:ci',
      origin: 'session-default',
    });
    expect(result.dispositions).toEqual({ masked: ['exec:test'], orphaned: [] });
    // Plan-neutral: only the baseline moved, so the rebase re-anchors and the
    // event is the only record the session layer moved under this task.
    expect(result.checkpoint.planDigest).toBe(result.previousPlanDigest);
    expect(result.checkpoint.sessionBaselineDigest).not.toBe(result.previousSessionBaselineDigest);
    // The mask is what resolution alone cannot see — the plan carries no note.
    expect(notesOfKind(result.plan, 'masked_session_entry')).toEqual([]);
  });

  test('a session change under a slot no amendment gave bytes to is not masked', () => {
    // §6.4 rule 4 bullet 1: the live bytes win, so there is nothing masked —
    // `annotate` touches the slot without giving it bytes.
    const amendments = stateFor([{ kind: 'annotate', commandId: 'exec:test', reason: 'checked' }]);
    const result = reconcileVerificationPlan({ sessionVerification: { test: 'npm test -- --ci' }, amendments });

    expect(result.status).toBe('drifted');
    expect(result.plan.execution[0].command).toBe('npm test -- --ci');
    expect(result.dispositions).toEqual({ masked: [], orphaned: [] });
  });

  test('an unchanged session entry under a replaced slot masks nothing when another key drifts', () => {
    const amendments = stateFor(
      [{ kind: 'replace', commandId: 'exec:test', command: 'npm run test:ci', reason: 'typo' }],
      { sessionBaseline: [{ name: 'test', command: 'npm test' }, { name: 'lint', command: 'npm run lint' }] },
    );
    const result = reconcileVerificationPlan({
      sessionVerification: { test: 'npm test', lint: 'npm run lint -- --fix' },
      amendments,
    });

    expect(result.status).toBe('drifted');
    expect(result.dispositions).toEqual({ masked: [], orphaned: [] });
  });

  test('a session entry edited onto the replacement bytes is effective, not masked', () => {
    // The slot has a `replace` in its history, but the operator's edit landed
    // on exactly those bytes: the live value IS what resolves, so reporting it
    // masked would send the operator reversing an amendment that hides nothing.
    const amendments = stateFor([
      { kind: 'replace', commandId: 'exec:test', command: 'npm test -- --ci', reason: 'typo' },
    ]);
    const result = reconcileVerificationPlan({ sessionVerification: { test: 'npm test -- --ci' }, amendments });

    expect(result.status).toBe('drifted');
    expect(result.plan.execution[0].command).toBe('npm test -- --ci');
    expect(result.dispositions).toEqual({ masked: [], orphaned: [] });
  });

  test('a session key that returns with new bytes under a replayed replace is masked', () => {
    // The slot was replaced, the session key removed, and the checkpoint
    // rebased onto that removal — so the recorded baseline has no `before` for
    // this name. The key is back with different bytes, the replace replays over
    // it, and the audit has to say the returning session command lost.
    const amendments = stateFor(
      [{ kind: 'replace', commandId: 'exec:test', command: 'npm run test:ci', reason: 'typo' }],
      { sessionBaseline: [] },
    );
    const result = reconcileVerificationPlan({ sessionVerification: { test: 'npm test -- --ci' }, amendments });

    expect(result.status).toBe('drifted');
    expect(result.plan.execution[0]).toMatchObject({ commandId: 'exec:test', command: 'npm run test:ci' });
    expect(result.dispositions).toEqual({ masked: ['exec:test'], orphaned: [] });
  });

  test('a removed session key orphans its slot and still reconciles as drift', () => {
    const amendments = stateFor([
      { kind: 'replace', commandId: 'exec:test', command: 'npm run test:ci', reason: 'typo' },
    ]);
    const result = reconcileVerificationPlan({ sessionVerification: { lint: 'npm run lint' }, amendments });

    expect(result.status).toBe('drifted');
    expect(result.plan.execution.map((slot) => slot.commandId)).toEqual(['exec:lint']);
    expect(result.dispositions.orphaned).toEqual(['exec:test']);
    // Never resurrected from the recorded baseline.
    expect(result.plan.execution.some((slot) => slot.commandId === 'exec:test')).toBe(false);
  });
});

describe('buildVerificationSessionBaseline', () => {
  test('normalizes to ordered {name, command} pairs with the digest resolution compares', () => {
    const result = buildVerificationSessionBaseline({ test: ' npm test ', lint: 'npm run lint' });
    expect(result).toEqual({
      status: 'ok',
      sessionBaseline: [
        { name: 'test', command: 'npm test' },
        { name: 'lint', command: 'npm run lint' },
      ],
      sessionBaselineDigest: deriveSessionBaselineDigest([
        { name: 'test', command: 'npm test' },
        { name: 'lint', command: 'npm run lint' },
      ]),
    });
  });

  test('an unrepresentable session map is refused, not silently normalized', () => {
    expect(buildVerificationSessionBaseline({ test: '' })).toEqual({
      status: 'invalid',
      detail: 'sessionVerification["test"]: empty command',
    });
  });
});
