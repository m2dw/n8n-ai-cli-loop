// Issue #1100 — invalidating staged verification evidence when execution
// inputs change: docs/verification-evidence-validity-contract.md §4.
//
// Pins the matching law (§4.4: `value`/`value` on equal values, `none` matches
// `none`, `unknown` matches nothing including another `unknown`, all seven
// components always), the two uses §4.6 admits (#1094 §4.4 final-stage reuse
// and §8's grant binding, with no override and no partial validity), and the
// component derivations of §4.5 — every one of them from already-resolved,
// DECLARED inputs: no scan, no lockfile, no tool version, no path
// interpretation. The plan-side components come from the shipped #1037
// checkpoint and reconciliation, so an operator amendment and an Issue-refresh
// revision invalidate stage evidence through the record that already exists
// rather than through a second validity model.
import {
  matchIdentityComponent,
  compareStageEvidenceIdentity,
  stageEvidenceIdentityMatches,
  admitStageEvidence,
  evaluateFinalStageReuse,
  evaluateFinalGrantBinding,
  deriveTestedRevisionComponent,
  deriveWorkingTreeStateComponent,
  finalStageWorktreeIsClean,
  deriveAmendmentIdentityComponents,
  deriveTestSuitePolicyComponent,
  deriveTestSuiteBindingDigest,
  deriveEnvironmentIdentityComponent,
  legacyStageEvidenceIdentity,
  deriveStageSelectionDigest,
  deriveSessionBaselineDigest,
  resolveEffectiveVerificationPlan,
  reconcileVerificationPlan,
  STAGE_IDENTITY_COMPONENTS,
  STAGE_EVIDENCE_REFUSALS,
  STAGE_IDENTITY_MISMATCH_KINDS,
  WORKING_TREE_CLEAN_VALUE,
} from '../dist/index.js';

const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);
const digest = (ch) => ch.repeat(64);
const PLAN_DIGEST = digest('c');

const value = (v) => ({ state: 'value', value: v });
const none = (source) => ({ state: 'none', source });
const unknown = (reason) => ({ state: 'unknown', reason });

function identity(overrides = {}) {
  return {
    testedRevision: value(HEAD_A),
    workingTreeState: value(WORKING_TREE_CLEAN_VALUE),
    planDigest: value(PLAN_DIGEST),
    planRevisionOrdinal: value('0'),
    sessionBaselineDigest: value(digest('d')),
    selectionPolicyDigest: value(digest('e')),
    environmentIdentity: none('no declared environment source'),
    ...overrides,
  };
}

function bundle(overrides = {}) {
  return {
    stageRunId: { taskAttempt: 1, lane: 'review', stage: 'final', stageOrdinal: 0 },
    planDigest: PLAN_DIGEST,
    headSha: HEAD_A,
    selection: {
      checkIds: ['exec:test'],
      selectionDigest: deriveStageSelectionDigest(['exec:test']),
      full: true,
      source: 'final-total',
    },
    outcome: 'passed',
    complete: true,
    checks: [],
    identity: identity(),
    startedAt: '2026-09-12T00:00:00.000Z',
    recordedAt: '2026-09-12T00:05:00.000Z',
    ...overrides,
  };
}

function expectation(overrides = {}) {
  return {
    taskAttempt: 1,
    lane: 'review',
    planDigest: PLAN_DIGEST,
    headSha: HEAD_A,
    identity: identity(),
    ...overrides,
  };
}

const reasons = (admission) => admission.refusals.map((refusal) => refusal.reason);
const admit = (overrides = {}) =>
  admitStageEvidence({ use: 'final-reuse', bundle: bundle(), expectation: expectation(), ...overrides });

describe('the matching law (#1096 §4.4)', () => {
  test('`value` matches `value` on equal values and on nothing else', () => {
    expect(matchIdentityComponent(value(HEAD_A), value(HEAD_A))).toBe(true);
    expect(matchIdentityComponent(value(HEAD_A), value(HEAD_B))).toBe(false);
    expect(matchIdentityComponent(value(HEAD_A), none('undeclared'))).toBe(false);
  });

  test('`none` matches `none`: a stable fact about the configuration', () => {
    expect(matchIdentityComponent(none('undeclared'), none('undeclared'))).toBe(true);
    // The source text is narrative, not identity: two runs that both found
    // nothing declared ran in the same world however they say so.
    expect(matchIdentityComponent(none('undeclared'), none('no declared source'))).toBe(true);
  });

  test('`unknown` matches nothing, INCLUDING another `unknown`', () => {
    expect(matchIdentityComponent(unknown('head_unresolvable'), value(HEAD_A))).toBe(false);
    expect(matchIdentityComponent(value(HEAD_A), unknown('head_unresolvable'))).toBe(false);
    expect(matchIdentityComponent(unknown('x'), none('undeclared'))).toBe(false);
    // The deliberate divergence from #916's "unknown evaluates as absent": for
    // an identity, absent is the dangerous reading.
    expect(matchIdentityComponent(unknown('same'), unknown('same'))).toBe(false);
  });

  test('all seven components are compared and one mismatch invalidates the identity', () => {
    expect(stageEvidenceIdentityMatches(identity(), identity())).toBe(true);

    for (const component of STAGE_IDENTITY_COMPONENTS) {
      const moved = identity({ [component]: unknown('resolution failed') });
      const comparison = compareStageEvidenceIdentity(identity(), moved);
      expect(comparison.matches).toBe(false);
      expect(comparison.mismatches.map((entry) => entry.component)).toEqual([component]);
    }
  });

  test('a mismatch record names the component, the kind and both states', () => {
    const comparison = compareStageEvidenceIdentity(
      identity(),
      identity({
        testedRevision: value(HEAD_B),
        environmentIdentity: value(digest('f')),
        selectionPolicyDigest: unknown('selection_policy_unreadable:session block'),
      }),
    );

    expect(comparison.matches).toBe(false);
    expect(comparison.mismatches).toEqual([
      {
        component: 'testedRevision',
        kind: 'value-changed',
        expectedState: 'value',
        evidenceState: 'value',
        expectedValue: HEAD_A,
        evidenceValue: HEAD_B,
      },
      {
        component: 'selectionPolicyDigest',
        kind: 'evidence-unknown',
        expectedState: 'value',
        evidenceState: 'unknown',
        expectedValue: digest('e'),
        evidenceReason: 'selection_policy_unreadable:session block',
      },
      {
        component: 'environmentIdentity',
        kind: 'state-changed',
        expectedState: 'none',
        evidenceState: 'value',
        evidenceValue: digest('f'),
      },
    ]);
    expect(STAGE_IDENTITY_MISMATCH_KINDS).toContain('expected-unknown');
    expect(
      compareStageEvidenceIdentity(identity({ testedRevision: unknown('head_unresolvable') }), identity())
        .mismatches[0].kind,
    ).toBe('expected-unknown');
  });

  test('a component a record does not carry compares as `unknown`, never as absent', () => {
    const partial = { ...identity() };
    delete partial.environmentIdentity;
    const comparison = compareStageEvidenceIdentity(identity(), partial);
    expect(comparison.matches).toBe(false);
    expect(comparison.mismatches[0]).toMatchObject({
      component: 'environmentIdentity',
      kind: 'evidence-unknown',
      evidenceState: 'unknown',
      evidenceReason: 'evidence-component-absent',
    });
  });
});

describe('final-stage reuse and the grant (#1096 §4.6, #1094 §4.4 and §8)', () => {
  test('an unchanged identity reuses the bundle and grants', () => {
    const reuse = evaluateFinalStageReuse({ bundles: [bundle()], expectation: expectation() });
    expect(reuse.reusable).toBe(true);
    expect(reuse.bundle.stageRunId.stageOrdinal).toBe(0);

    const binding = evaluateFinalGrantBinding({ bundle: bundle(), expectation: expectation() });
    expect(binding).toEqual({ granted: true, bundle: bundle() });
  });

  test('evidence from another tested revision never grants final success', () => {
    // The head moved between the final stage and the enqueue: #1094 §8's head
    // binding, which #1096 §4.6 rule 2 generalizes to the whole tuple.
    const moved = expectation({
      headSha: HEAD_B,
      identity: identity({ testedRevision: value(HEAD_B) }),
    });

    const binding = evaluateFinalGrantBinding({ bundle: bundle(), expectation: moved });
    expect(binding.granted).toBe(false);
    expect(binding.requeueFinalStage).toBe(true);
    expect(binding.refusals.map((refusal) => refusal.reason)).toEqual([
      'head-mismatch',
      'identity-mismatch',
    ]);
    expect(binding.refusals[1].mismatches).toEqual([
      {
        component: 'testedRevision',
        kind: 'value-changed',
        expectedState: 'value',
        evidenceState: 'value',
        expectedValue: HEAD_B,
        evidenceValue: HEAD_A,
      },
    ]);

    expect(evaluateFinalStageReuse({ bundles: [bundle()], expectation: moved }).reusable).toBe(false);
  });

  test('a commit change invalidates a bundle even when the head field still agrees', () => {
    // A tuple mismatch alone is enough. There is no "the rest matched" path and
    // no component weighting: the shipped head field agreeing buys nothing when
    // the identity says the run happened at another revision.
    const admission = admit({
      expectation: expectation({ identity: identity({ testedRevision: value(HEAD_B) }) }),
    });
    expect(reasons(admission)).toEqual(['identity-mismatch']);
  });

  test('a `loop` bundle never satisfies a final stage, however complete and full', () => {
    const loop = bundle({
      stageRunId: { taskAttempt: 1, lane: 'review', stage: 'loop', stageOrdinal: 3 },
    });
    expect(reasons(admit({ bundle: loop }))).toEqual(['stage-not-final']);
    expect(evaluateFinalStageReuse({ bundles: [loop], expectation: expectation() })).toEqual({
      reusable: false,
      candidates: [{ stageRunKey: '1/review/loop/3', refusals: [{ reason: 'stage-not-final' }] }],
    });
  });

  test('the shipped #1094 §4.4 conditions are kept and are not weakened by the tuple', () => {
    const cases = [
      [{ stageRunId: { taskAttempt: 2, lane: 'review', stage: 'final', stageOrdinal: 0 } }, 'different-task-attempt'],
      [{ stageRunId: { taskAttempt: 1, lane: 'implementation', stage: 'final', stageOrdinal: 0 } }, 'different-lane'],
      [{ complete: false }, 'not-complete'],
      [{ outcome: 'code-failed' }, 'outcome-not-passed'],
      [
        {
          selection: {
            checkIds: ['exec:test'],
            selectionDigest: deriveStageSelectionDigest(['exec:test']),
            full: false,
            source: 'port',
          },
        },
        'selection-not-full',
      ],
      [{ headSha: undefined }, 'head-unattested'],
      [{ headSha: HEAD_B }, 'head-mismatch'],
    ];
    for (const [overrides, reason] of cases) {
      expect(reasons(admit({ bundle: bundle(overrides) }))).toContain(reason);
    }

    // The plan digest condition survives on its own field, so a bundle whose
    // recorded plan digest disagrees with the resolved plan is refused by name
    // and not only through the tuple.
    const amended = admit({
      bundle: bundle({ planDigest: digest('9'), identity: identity({ planDigest: value(digest('9')) }) }),
    });
    expect(reasons(amended)).toEqual(['plan-digest-mismatch', 'identity-mismatch']);
  });

  test('an amended command invalidates earlier evidence through the plan components', () => {
    const admission = admit({
      expectation: expectation({
        planDigest: digest('9'),
        identity: identity({
          planDigest: value(digest('9')),
          planRevisionOrdinal: value('1'),
        }),
      }),
    });
    expect(reasons(admission)).toEqual(['plan-digest-mismatch', 'identity-mismatch']);
    expect(admission.refusals[1].mismatches.map((entry) => entry.component)).toEqual([
      'planDigest',
      'planRevisionOrdinal',
    ]);
  });

  test('a mid-run change caught by the end-of-run re-check makes the bundle inadmissible', () => {
    // #1096 §4.3 rule 3, seen from the evidence alone: the bundle carries both
    // identities, so the disagreement is visible without trusting the outcome.
    const recheck = bundle({
      identityRecheck: identity({ workingTreeState: value(digest('7')) }),
    });
    const admission = admit({ bundle: recheck });
    expect(reasons(admission)).toEqual(['identity-recheck-mismatch']);
    expect(admission.refusals[0].mismatches[0].component).toBe('workingTreeState');

    // An agreeing re-check refuses nothing.
    expect(admit({ bundle: bundle({ identityRecheck: identity() }) }).admitted).toBe(true);
  });

  test('an allocation the ledger says never recorded credits nothing', () => {
    const ledger = [
      {
        stageRunId: bundle().stageRunId,
        requestKey: 'req-1',
        identity: identity(),
        allocatedAt: '2026-09-12T00:00:00.000Z',
        state: 'interrupted',
        interruptedAt: '2026-09-12T00:09:00.000Z',
      },
    ];
    expect(reasons(admit({ ledger }))).toEqual(['run-interrupted']);
    // A bounded ledger legitimately evicts an old entry; absence is not a refusal.
    expect(admit({ ledger: [] }).admitted).toBe(true);
  });

  test('a legacy all-`unknown` bundle is admissible for nothing, including against itself', () => {
    const legacy = bundle({ identity: legacyStageEvidenceIdentity() });
    expect(reasons(admit({ bundle: legacy }))).toEqual(['identity-mismatch']);
    expect(
      reasons(
        admit({ bundle: legacy, expectation: expectation({ identity: legacyStageEvidenceIdentity() }) }),
      ),
    ).toEqual(['identity-mismatch']);
    expect(
      evaluateFinalGrantBinding({ bundle: legacy, expectation: expectation() }).granted,
    ).toBe(false);
  });

  test('there is no override: no flag, session value or recovery act admits a mismatch', () => {
    const moved = expectation({ identity: identity({ testedRevision: value(HEAD_B) }) });
    const forced = admitStageEvidence({
      use: 'grant',
      bundle: bundle(),
      expectation: moved,
      force: true,
      operatorOverride: 'moto',
    });
    expect(forced.admitted).toBe(false);
    // The answer records which question was asked, and the answer is the same
    // for both: the grant is an effect of a bundle that could satisfy the stage.
    expect(forced.use).toBe('grant');
    expect(reasons(forced)).toEqual(reasons(admit({ expectation: moved })));
    expect(STAGE_EVIDENCE_REFUSALS).not.toContain('override');
  });

  test('reuse reports every candidate it refused, and the first admissible one wins', () => {
    const stale = bundle({
      stageRunId: { taskAttempt: 1, lane: 'review', stage: 'final', stageOrdinal: 0 },
      identity: identity({ testedRevision: value(HEAD_B) }),
    });
    const fresh = bundle({
      stageRunId: { taskAttempt: 1, lane: 'review', stage: 'final', stageOrdinal: 1 },
    });

    const decision = evaluateFinalStageReuse({ bundles: [stale, fresh], expectation: expectation() });
    expect(decision.reusable).toBe(true);
    expect(decision.bundle.stageRunId.stageOrdinal).toBe(1);

    const refused = evaluateFinalStageReuse({ bundles: [stale], expectation: expectation() });
    expect(refused.reusable).toBe(false);
    expect(refused.candidates).toEqual([
      { stageRunKey: '1/review/final/0', refusals: [{ reason: 'identity-mismatch', mismatches: expect.any(Array) }] },
    ]);

    expect(evaluateFinalStageReuse({ bundles: [], expectation: expectation() })).toEqual({
      reusable: false,
      candidates: [],
    });
  });
});

describe('`testedRevision` and `workingTreeState` (#1096 §4.5)', () => {
  test('the head normalizes through the shipped rule and never resolves `none`', () => {
    expect(deriveTestedRevisionComponent(`  ${HEAD_A.toUpperCase()}  `)).toEqual(value(HEAD_A));
    expect(deriveTestedRevisionComponent('not-a-sha')).toEqual(unknown('head_unresolvable'));
    expect(deriveTestedRevisionComponent(undefined)).toEqual(unknown('head_unresolvable'));
  });

  test('an empty listing is `clean` and a listed path makes it a digest', () => {
    expect(deriveWorkingTreeStateComponent({ state: 'listed', entries: [] })).toEqual(
      value(WORKING_TREE_CLEAN_VALUE),
    );

    const dirty = deriveWorkingTreeStateComponent({
      state: 'listed',
      entries: [
        { statusCode: ' M', path: 'src/a.ts', content: { state: 'fingerprint', fingerprint: digest('1') } },
      ],
    });
    expect(dirty.state).toBe('value');
    expect(dirty.value).toMatch(/^[0-9a-f]{64}$/);
  });

  test('re-editing an already-modified path moves the component, though the status entry is identical', () => {
    // #1096 §4.5 rule 5: the component is bound to CONTENT. A digest over status
    // entries alone would call two different agent diffs the same working tree.
    const first = deriveWorkingTreeStateComponent({
      state: 'listed',
      entries: [
        { statusCode: ' M', path: 'package-lock.json', content: { state: 'fingerprint', fingerprint: digest('1') } },
      ],
    });
    const second = deriveWorkingTreeStateComponent({
      state: 'listed',
      entries: [
        { statusCode: ' M', path: 'package-lock.json', content: { state: 'fingerprint', fingerprint: digest('2') } },
      ],
    });
    expect(first.value).not.toBe(second.value);
    expect(matchIdentityComponent(first, second)).toBe(false);

    // An uncommitted dependency change is therefore covered without core ever
    // knowing that this path is a lockfile.
    const untracked = deriveWorkingTreeStateComponent({
      state: 'listed',
      entries: [
        { statusCode: '??', path: 'package-lock.json', content: { state: 'fingerprint', fingerprint: digest('1') } },
      ],
    });
    expect(untracked.value).not.toBe(first.value);
  });

  test('membership, not listing order, decides the digest; a deletion takes the sentinel', () => {
    const listing = (entries) => deriveWorkingTreeStateComponent({ state: 'listed', entries });
    const a = { statusCode: ' M', path: 'a.ts', content: { state: 'fingerprint', fingerprint: digest('1') } };
    const b = { statusCode: '??', path: 'b.ts', content: { state: 'fingerprint', fingerprint: digest('2') } };
    expect(listing([a, b]).value).toBe(listing([b, a]).value);

    const deleted = listing([{ statusCode: ' D', path: 'a.ts', content: { state: 'absent' } }]);
    expect(deleted.state).toBe('value');
    expect(deleted.value).not.toBe(listing([a]).value);
  });

  test('a listed path the seam cannot fingerprint is `unknown` and is never skipped', () => {
    const component = deriveWorkingTreeStateComponent({
      state: 'listed',
      entries: [
        { statusCode: ' M', path: 'src/secret/path.ts', content: { state: 'unreadable', reason: 'EACCES' } },
      ],
    });
    expect(component).toEqual(unknown('working-tree-path-unfingerprintable'));
    // #1096 §8 rule 10: no path reaches a surface, not even inside a reason.
    expect(component.reason).not.toContain('src/secret/path.ts');

    expect(deriveWorkingTreeStateComponent({ state: 'unreadable', reason: 'status failed' })).toEqual(
      unknown('working-tree-status-unreadable:status failed'),
    );
  });

  test('a final stage launches only on a clean tree; untracked paths do not block it', () => {
    const listing = (entries) => ({ state: 'listed', entries });
    const untracked = {
      statusCode: '??',
      path: 'artifact.log',
      content: { state: 'fingerprint', fingerprint: digest('3') },
    };
    const modified = {
      statusCode: ' M',
      path: 'src/a.ts',
      content: { state: 'fingerprint', fingerprint: digest('4') },
    };

    expect(finalStageWorktreeIsClean(listing([]))).toBe(true);
    expect(finalStageWorktreeIsClean(listing([untracked]))).toBe(true);
    expect(finalStageWorktreeIsClean(listing([modified]))).toBe(false);
    expect(finalStageWorktreeIsClean(listing([{ ...modified, statusCode: 'A ' }]))).toBe(false);
    expect(finalStageWorktreeIsClean(listing([{ ...modified, statusCode: 'R ' }]))).toBe(false);
    // A tree the runner could not read is not a tree it may call clean.
    expect(finalStageWorktreeIsClean({ state: 'unreadable', reason: 'status failed' })).toBe(false);
    // The untracked artifact still moves the component, so two otherwise
    // identical final runs stay distinguishable.
    expect(deriveWorkingTreeStateComponent(listing([untracked])).value).not.toBe(
      WORKING_TREE_CLEAN_VALUE,
    );
  });
});

describe('the plan components come from the shipped amendment record (#1096 §4.5)', () => {
  const SESSION = { test: 'npm test' };
  const baseline = [{ name: 'test', command: 'npm test' }];
  const live = { state: 'declared', entries: baseline };

  function amendmentState(operations, options = {}) {
    const sessionBaseline = options.sessionBaseline ?? baseline;
    const sessionBaselineDigest = deriveSessionBaselineDigest(sessionBaseline);
    const probe = resolveEffectiveVerificationPlan({
      sessionVerification: sessionBaseline,
      amendments: {
        revisions: [revision(operations, digest('b'), sessionBaselineDigest)],
        checkpoint: {
          planDigest: digest('b'),
          sessionBaseline,
          sessionBaselineDigest,
          appliedThroughOrdinal: 1,
          updatedAt: '2026-09-12T00:00:00.000Z',
          updatedBy: 'revision',
        },
      },
    });
    expect(probe.status).toBe('resolved');
    const planDigest = options.planDigest ?? probe.plan.planDigest;
    return {
      revisions: [revision(operations, planDigest, sessionBaselineDigest)],
      checkpoint: {
        planDigest,
        sessionBaseline,
        sessionBaselineDigest,
        appliedThroughOrdinal: 1,
        updatedAt: '2026-09-12T00:00:00.000Z',
        updatedBy: 'revision',
      },
    };
  }

  function revision(operations, planDigest, sessionBaselineDigest) {
    return {
      revisionId: `vamd-${'1'.padStart(16, '0')}`,
      revisionOrdinal: 1,
      requestKey: 'key-1',
      scope: 'task',
      source: 'admin-cli',
      actor: { kind: 'operator', id: 'moto' },
      reason: 'operator correction',
      operations,
      basePlanDigest: digest('a'),
      planDigest,
      sessionBaselineDigest,
      continuation: 'review',
      createdAt: '2026-09-12T00:00:00.000Z',
      observedTaskRevision: 0,
    };
  }

  test('an unamended task carries the resolved plan digest and ordinal "0"', () => {
    const reconciliation = reconcileVerificationPlan({ sessionVerification: SESSION });
    expect(reconciliation.status).toBe('unamended');

    const components = deriveAmendmentIdentityComponents({ reconciliation, liveSessionBaseline: live });
    expect(components.planDigest).toEqual(value(reconciliation.plan.planDigest));
    expect(components.planRevisionOrdinal).toEqual(value('0'));
    expect(components.sessionBaselineDigest).toEqual(value(deriveSessionBaselineDigest(baseline)));
  });

  test('an operator amendment moves the plan components and invalidates earlier evidence', () => {
    const unamended = reconcileVerificationPlan({ sessionVerification: SESSION });
    const before = deriveAmendmentIdentityComponents({
      reconciliation: unamended,
      liveSessionBaseline: live,
    });

    const amendments = amendmentState([
      { kind: 'replace', commandId: 'exec:test', command: 'npm run test:ci', reason: 'typo' },
    ]);
    const reconciliation = reconcileVerificationPlan({ sessionVerification: SESSION, amendments });
    expect(reconciliation.status).toBe('consistent');

    const after = deriveAmendmentIdentityComponents({
      reconciliation,
      checkpoint: amendments.checkpoint,
      liveSessionBaseline: live,
    });

    // The amendment IS the invalidation: the shipped checkpoint moved, and the
    // identity moved with it. Nothing here compared command bytes.
    expect(after.planDigest).toEqual(value(amendments.checkpoint.planDigest));
    expect(matchIdentityComponent(before.planDigest, after.planDigest)).toBe(false);
    expect(after.planRevisionOrdinal).toEqual(value('1'));
    expect(matchIdentityComponent(before.planRevisionOrdinal, after.planRevisionOrdinal)).toBe(false);
    // A plan-only amendment leaves the session baseline where it was.
    expect(matchIdentityComponent(before.sessionBaselineDigest, after.sessionBaselineDigest)).toBe(true);

    const admission = admitStageEvidence({
      use: 'grant',
      bundle: bundle({
        planDigest: amendments.checkpoint.planDigest,
        identity: identity({ ...before, planDigest: before.planDigest }),
      }),
      expectation: expectation({
        planDigest: amendments.checkpoint.planDigest,
        identity: identity(after),
      }),
    });
    expect(reasons(admission)).toEqual(['identity-mismatch']);
  });

  test('a session edit under a checkpoint is `unknown` until #1037 rebases it', () => {
    const amendments = amendmentState([
      { kind: 'annotate', commandId: 'exec:test', reason: 'checked' },
    ]);
    const edited = { test: 'npm test -- --ci' };
    const reconciliation = reconcileVerificationPlan({ sessionVerification: edited, amendments });
    expect(reconciliation.status).toBe('drifted');

    const components = deriveAmendmentIdentityComponents({
      reconciliation,
      checkpoint: amendments.checkpoint,
      liveSessionBaseline: { state: 'declared', entries: [{ name: 'test', command: 'npm test -- --ci' }] },
    });
    expect(components.sessionBaselineDigest).toEqual(unknown('session_baseline_drifted'));
    // The checkpoint is read and never repaired here (#1096 §7.2 rule 2).
    expect(amendments.checkpoint.sessionBaselineDigest).toBe(deriveSessionBaselineDigest(baseline));
  });

  test('an unreconciled stored digest and an unresolvable plan are `unknown`, never a guess', () => {
    const amendments = amendmentState([{ kind: 'annotate', commandId: 'exec:test', reason: 'checked' }], {
      planDigest: digest('f'),
    });
    const unreconciled = reconcileVerificationPlan({ sessionVerification: SESSION, amendments });
    expect(unreconciled.status).toBe('unreconciled');
    expect(
      deriveAmendmentIdentityComponents({
        reconciliation: unreconciled,
        checkpoint: amendments.checkpoint,
        liveSessionBaseline: live,
      }).planDigest,
    ).toEqual(unknown('plan_unreconciled'));

    const invalid = reconcileVerificationPlan({ sessionVerification: { test: '   ' } });
    expect(invalid.status).toBe('invalid');
    expect(
      deriveAmendmentIdentityComponents({ reconciliation: invalid, liveSessionBaseline: live })
        .planDigest.state,
    ).toBe('unknown');
  });

  test('a malformed stored ordinal or baseline digest is `unknown`, never `none`', () => {
    const reconciliation = reconcileVerificationPlan({ sessionVerification: SESSION });
    const checkpoint = {
      planDigest: PLAN_DIGEST,
      sessionBaseline: baseline,
      sessionBaselineDigest: 'not-a-digest',
      appliedThroughOrdinal: 'two',
      updatedAt: '2026-09-12T00:00:00.000Z',
      updatedBy: 'revision',
    };
    const components = deriveAmendmentIdentityComponents({
      reconciliation,
      checkpoint,
      liveSessionBaseline: live,
    });
    expect(components.planRevisionOrdinal).toEqual(unknown('plan_revision_ordinal_unreadable'));
    expect(components.sessionBaselineDigest).toEqual(unknown('session_baseline_stored_malformed'));
  });

  test('an undeclared session layer with no checkpoint is `none` and matches another `none`', () => {
    const reconciliation = reconcileVerificationPlan({});
    const components = deriveAmendmentIdentityComponents({
      reconciliation,
      liveSessionBaseline: { state: 'absent' },
    });
    expect(components.sessionBaselineDigest.state).toBe('none');
    expect(matchIdentityComponent(components.sessionBaselineDigest, components.sessionBaselineDigest)).toBe(
      true,
    );

    // Unreadable is a failure, and a failure is never `none`.
    expect(
      deriveAmendmentIdentityComponents({
        reconciliation,
        liveSessionBaseline: { state: 'unreadable', reason: 'session load failed' },
      }).sessionBaselineDigest,
    ).toEqual(unknown('session_baseline_unreadable:session load failed'));
  });
});

// Issue #1155 deleted the group-selection derivation of this component —
// `appliedSelectionPolicy` / `deriveSelectionPolicyDigest` over `selectable`,
// `finalOnly`, `resultAdapters`, the effective selectable set and the project
// verification file's check → adapter mapping — with every setting it read.
// The suite binding is the only configuration that governs a stage run now, so
// `deriveTestSuitePolicyComponent` is the component's only derivation left.
describe('`selectionPolicyDigest` is the applied suite binding (#1096 §4.5 rule 2)', () => {
  const SUITE = { key: 'test', command: 'npm test', adapter: 'jest' };
  const componentFor = (configuration) =>
    deriveTestSuitePolicyComponent({ state: 'resolved', configuration });

  test('the resolved binding digests to a value, and the component is never `none`', () => {
    const component = componentFor(SUITE);
    expect(component).toEqual(value(deriveTestSuiteBindingDigest(SUITE)));
    expect(matchIdentityComponent(component, componentFor({ ...SUITE }))).toBe(true);
  });

  test('a changed binding moves the digest, so evidence taken under the old one is stale', () => {
    const base = componentFor(SUITE);
    for (const changed of [
      { ...SUITE, key: 'unit' },
      { ...SUITE, command: 'npm run test:ci' },
      { ...SUITE, setupCommand: 'npm run build' },
      { ...SUITE, argumentSeparator: '--' },
    ]) {
      expect(matchIdentityComponent(base, componentFor(changed))).toBe(false);
    }
  });

  // #1096 §4.1 rule 2: an undeclared source is a configuration fact, so it is
  // `none` and compares equal to itself across runs. Making it `unknown` would
  // leave a session that binds no suite unable to attest any run at all.
  test('a session that declares no binding is `none`, and matches another `none`', () => {
    const undeclared = deriveTestSuitePolicyComponent({ state: 'undeclared' });
    expect(undeclared).toEqual(none('no test suite binding declared'));
    expect(matchIdentityComponent(undeclared, deriveTestSuitePolicyComponent({ state: 'undeclared' })))
      .toBe(true);
    // Dropping or adding a binding still moves the component, so evidence taken
    // under one configuration never binds a run under the other.
    expect(matchIdentityComponent(undeclared, componentFor(SUITE))).toBe(false);
  });

  test('a binding the caller could not read is `unknown`, and matches nothing', () => {
    const unreadable = deriveTestSuitePolicyComponent({
      state: 'unreadable',
      reason: 'session block',
    });
    expect(unreadable).toEqual(unknown('test_suite_binding_unreadable:session block'));
    expect(matchIdentityComponent(unreadable, unreadable)).toBe(false);
    expect(matchIdentityComponent(unreadable, componentFor(SUITE))).toBe(false);
  });
});

describe('`environmentIdentity` is declared, never sniffed (#1096 §4.5 rule 1)', () => {
  test('a project that declares nothing gets a stable `none`, with no scan of any kind', () => {
    const first = deriveEnvironmentIdentityComponent();
    const second = deriveEnvironmentIdentityComponent({
      prepareStamp: { state: 'absent' },
      operatorToken: { state: 'absent' },
      capabilityReport: { state: 'absent' },
    });
    expect(first.state).toBe('none');
    expect(matchIdentityComponent(first, second)).toBe(true);
  });

  test('a dependency install that moves the prepare stamp moves the component', () => {
    // The installed state is covered by the operator-declared prepare stamp, so
    // a Tool Request that installed a package invalidates earlier evidence
    // without core reading a lockfile or knowing a package manager exists.
    const before = deriveEnvironmentIdentityComponent({
      prepareStamp: { state: 'declared', value: digest('1') },
    });
    const after = deriveEnvironmentIdentityComponent({
      prepareStamp: { state: 'declared', value: digest('2') },
    });
    expect(before.state).toBe('value');
    expect(matchIdentityComponent(before, after)).toBe(false);

    // The operator token and the #916 report are the other two declared sources.
    expect(
      matchIdentityComponent(
        before,
        deriveEnvironmentIdentityComponent({
          prepareStamp: { state: 'declared', value: digest('1') },
          operatorToken: { state: 'declared', value: 'toolchain-2026-09' },
        }),
      ),
    ).toBe(false);
  });

  test('an unreadable source and an unconfirmed process cleanup are `unknown`', () => {
    expect(
      deriveEnvironmentIdentityComponent({
        prepareStamp: { state: 'unreadable', reason: 'stamp missing' },
      }),
    ).toEqual(unknown('environment_prepareStamp_unreadable:stamp missing'));

    expect(
      deriveEnvironmentIdentityComponent({
        operatorToken: { state: 'unreadable', reason: 'malformed token' },
      }).state,
    ).toBe('unknown');

    // §4.5 rule 3: a worktree with an unaccounted process in it is one the
    // runner cannot vouch for, and that outranks every declared source.
    expect(
      deriveEnvironmentIdentityComponent({
        prepareStamp: { state: 'declared', value: digest('1') },
        processCleanup: { state: 'unconfirmed', reason: 'processGroupSignalError' },
      }),
    ).toEqual(unknown('environment_process_cleanup_unconfirmed:processGroupSignalError'));

    expect(
      deriveEnvironmentIdentityComponent({
        prepareStamp: { state: 'declared', value: digest('1') },
        processCleanup: { state: 'confirmed' },
      }).state,
    ).toBe('value');
  });
});
