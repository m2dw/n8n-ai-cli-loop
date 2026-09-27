// Issue #1154 — the pure routing of changed-file / full-suite verification
// (docs/changed-file-verification-contract.md §3, §5 and §6 rules 2 and 5).

import {
  classifyTestStageResult,
  describeTestStageRecord,
  fullSuiteRequirementDeclaration,
  openStageRunGuard,
  resolveTestSuiteSlot,
  routeStage1TestResult,
  routeStage2TestResult,
  stage1RecoveryOutcome,
  toolRequestTestSuiteKey,
} from '../dist/core/test-stage-routing.js';
import { extractIssueVerificationCommands } from '../dist/handlers/issue-verification-extractor.js';
import { VERIFICATION_AMENDMENTS_CONTEXT_KEY } from '../dist/core/verification-amendment.js';
import { buildVerificationSessionBaseline, resolveEffectiveVerificationPlan } from '../dist/core/verification-plan.js';

const COMPONENTS = [
  'testedRevision',
  'workingTreeState',
  'planDigest',
  'planRevisionOrdinal',
  'sessionBaselineDigest',
  'selectionPolicyDigest',
  'environmentIdentity',
];

const identity = (overrides = {}) => ({
  ...Object.fromEntries(COMPONENTS.map((name) => [name, { state: 'value', value: `${name}-1` }])),
  ...overrides,
});
const attested = { launch: identity(), end: identity(), recheck: identity() };

const run = (overrides = {}) => ({
  mode: 'files',
  expectedFiles: ['tests/a.test.js'],
  files: [{ file: 'tests/a.test.js', outcome: 'passed' }],
  failedFiles: [],
  trust: { status: 'trusted' },
  processResult: 'succeeded',
  completeness: { status: 'complete' },
  termination: 'confirmed',
  steps: [{ step: 'tests', exitCode: 0 }],
  ...overrides,
});

const classify = (overrides) =>
  classifyTestStageResult({ stage: 'loop', plan: 'execute', run: run(), identity: attested, hostFailure: false, ...overrides });
const resultOf = (overrides) => classify(overrides).result;

describe('§3 — first row wins', () => {
  test('unconfirmed termination outranks everything, including a failure', () => {
    expect(resultOf({ run: run({ termination: 'unconfirmed', processResult: 'failed' }) })).toBe('termination-unknown');
  });

  test('an unavailable plan is R2, before identity', () => {
    expect(resultOf({ plan: 'unavailable', run: undefined, identity: { ...attested, end: identity({ testedRevision: { state: 'unknown', reason: 'x' } }) } }))
      .toBe('unavailable');
  });

  test('identity rows pre-empt a nonzero exit, and R3 needs attested, unchanged identity', () => {
    const failing = run({ processResult: 'failed', trust: { status: 'untrusted', reason: 'unreadable-result', detail: 'x' }, files: [] });
    expect(resultOf({ run: failing, identity: { ...attested, recheck: identity({ planDigest: { state: 'unknown', reason: 'x' } }) } }))
      .toBe('identity-unknown');
    expect(resultOf({ run: failing, identity: { ...attested, end: identity({ testedRevision: { state: 'value', value: 'moved' } }) } }))
      .toBe('stale');
    expect(resultOf({ plan: 'retained-unresolved', run: undefined, identity: { ...attested, recheck: identity({ workingTreeState: { state: 'value', value: 'moved' } }) } }))
      .toBe('stale');
    expect(resultOf({ plan: 'retained-unresolved', run: undefined })).toBe('retained-unresolved');
  });

  test('an empty selection is `empty`; nothing executed is never passed', () => {
    expect(resultOf({ plan: 'empty', run: undefined })).toBe('empty');
    expect(resultOf({ plan: 'execute', run: undefined })).toBe('termination-unknown');
  });

  test('a known nonzero exit is infrastructure or failed whatever the trust', () => {
    const failing = run({ processResult: 'failed', trust: { status: 'untrusted', reason: 'mismatched-files', detail: 'x' }, files: [] });
    expect(resultOf({ run: failing })).toBe('failed');
    expect(resultOf({ run: failing, hostFailure: true })).toBe('infrastructure');
  });

  test('a deadline is timed-out; other untrusted or partial runs are incomplete', () => {
    expect(resultOf({ run: run({ processResult: undefined, trust: { status: 'untrusted', reason: 'deadline', detail: 'x' }, files: [] }) })).toBe('timed-out');
    expect(resultOf({ run: run({ processResult: undefined, trust: { status: 'untrusted', reason: 'interrupted', detail: 'x' }, files: [] }) })).toBe('incomplete');
    expect(resultOf({ run: run({ files: [{ file: 'tests/a.test.js', outcome: 'not-run' }], completeness: { status: 'incomplete', reason: 'not-run' } }) }))
      .toBe('incomplete');
  });

  test('passes need a passed file; an all-skipped Stage 1 is `empty` (D6) and Stage 2 is no-evidence', () => {
    expect(resultOf({})).toBe('passed');
    const skipped = run({ files: [{ file: 'tests/a.test.js', outcome: 'skipped' }] });
    // Decision D6: the run executed no test, so it is R10 — never a pass, and
    // every run now classifies, so there is no unclassified shape left.
    expect(classify({ run: skipped })).toEqual({ kind: 'result', result: 'empty' });
    expect(resultOf({ stage: 'final', run: skipped })).toBe('no-evidence');
    // A mixed pass/skip run is untouched: one passed file still makes it `passed`.
    const mixed = run({ files: [{ file: 'tests/a.test.js', outcome: 'skipped' }, { file: 'tests/b.test.js', outcome: 'passed' }] });
    expect(resultOf({ run: mixed })).toBe('passed');
    expect(resultOf({ stage: 'final', run: mixed })).toBe('passed');
  });

  test('Stage 2 at a revision other than the approved one is stale', () => {
    expect(resultOf({ stage: 'final', approvedRevisionDiffers: true })).toBe('stale');
  });
});

describe('§5 — routes', () => {
  const r = (result) => ({ kind: 'result', result });

  test('Stage 1', () => {
    expect(['passed', 'empty'].map((x) => routeStage1TestResult(r(x)))).toEqual(['continue', 'continue']);
    expect(['failed', 'timed-out'].map((x) => routeStage1TestResult(r(x)))).toEqual(['repair', 'repair']);
    expect(['incomplete', 'unavailable', 'identity-unknown', 'stale'].map((x) => routeStage1TestResult(r(x))))
      .toEqual(['rerun', 'rerun', 'rerun', 'rerun']);
    expect(routeStage1TestResult(r('infrastructure'))).toBe('host-retry');
    expect(['retained-unresolved', 'termination-unknown'].map((x) => routeStage1TestResult(r(x)))).toEqual(['park', 'park']);
  });

  test('Stage 2: only `passed` reaches the non-test checks and the grant', () => {
    expect(routeStage2TestResult(r('passed'))).toBe('checks');
    expect(['failed', 'timed-out'].map((x) => routeStage2TestResult(r(x)))).toEqual(['repair', 'repair']);
    expect(['incomplete', 'identity-unknown'].map((x) => routeStage2TestResult(r(x)))).toEqual(['rerun', 'rerun']);
    expect(routeStage2TestResult(r('infrastructure'))).toBe('host-retry');
    expect(routeStage2TestResult(r('stale'))).toBe('review-again');
    expect(['no-evidence', 'unavailable', 'termination-unknown'].map((x) => routeStage2TestResult(r(x))))
      .toEqual(['park', 'park', 'park']);
  });

  test('non-code Stage 1 routes count toward the shipped recovery streak', () => {
    expect(stage1RecoveryOutcome('rerun')).toBe('interrupted');
    expect(stage1RecoveryOutcome('host-retry')).toBe('infrastructure');
    expect(stage1RecoveryOutcome('repair')).toBe('code-failed');
    expect(stage1RecoveryOutcome('continue')).toBe('passed');
  });
});

describe('§6 rules 2 and 5 — the suite slot', () => {
  const slot = (name, command, state = 'active') => ({ commandId: `exec:${name}`, layer: 'execution', name, state, command });
  const plan = (execution) => ({ execution, requirement: [], planDigest: 'd', appliedThroughOrdinal: 0, notes: [] });

  test('the bound key resolves to its active slot; every other active slot is a non-test check', () => {
    const resolved = resolveTestSuiteSlot(plan([slot('lint', 'npm run lint'), slot('test', 'npm test')]), 'test');
    expect(resolved.status).toBe('bound');
    expect(resolved.slot.command).toBe('npm test');
    expect(resolved.nonTestSlots.map((entry) => entry.name)).toEqual(['lint']);
  });

  test('a retired or absent bound slot, or a duplicate suite command, refuses the stage', () => {
    expect(resolveTestSuiteSlot(plan([slot('test', 'npm test', 'retired')]), 'test')).toMatchObject({ status: 'unbound', reason: 'no-active-slot' });
    expect(resolveTestSuiteSlot(plan([slot('test', 'npm test'), slot('ci', 'npm test')]), 'test'))
      .toMatchObject({ status: 'unbound', reason: 'duplicate-suite-command' });
    expect(resolveTestSuiteSlot(plan([slot('test', 'npm test'), slot('ci', "bash -lc 'npm test'")]), 'test'))
      .toMatchObject({ status: 'unbound', reason: 'duplicate-suite-command' });
  });

  // Issue #1166 review, P1: the load-time collision check sees only the static
  // session map. An amendment can give another ACTIVE slot a declared command,
  // and that slot is not a duplicate of the suite's own bytes.
  test('another active slot carrying a declared requirement command refuses the stage', () => {
    const declaration = { boundKey: 'test', requirementCommands: ['npm test'] };
    const collided = plan([slot('test', 'npm run test:files'), slot('lint', 'npm test')]);
    expect(resolveTestSuiteSlot(collided, 'test', declaration))
      .toMatchObject({ status: 'unbound', reason: 'declared-requirement-collision' });
    // The shell-wrapper form of the equivalence, in both directions.
    expect(resolveTestSuiteSlot(plan([slot('test', 'npm run test:files'), slot('lint', "bash -lc 'npm test'")]), 'test', declaration))
      .toMatchObject({ status: 'unbound', reason: 'declared-requirement-collision' });
    expect(resolveTestSuiteSlot(plan([slot('test', 'npm run test:files'), slot('lint', 'npm test')]), 'test', {
      boundKey: 'test',
      requirementCommands: ["bash -lc 'npm test'"],
    })).toMatchObject({ status: 'unbound', reason: 'declared-requirement-collision' });
    // The detail names the colliding check, never a value the operator cannot act on.
    expect(resolveTestSuiteSlot(collided, 'test', declaration).detail).toContain('"lint"');
  });

  test('a declaration bound to another key, or none, leaves the suite bound', () => {
    const collided = plan([slot('test', 'npm run test:files'), slot('lint', 'npm test')]);
    // Without the declaration `npm test` is just another non-test check.
    expect(resolveTestSuiteSlot(collided, 'test')).toMatchObject({ status: 'bound' });
    // §6 rule 5: a declaration applies ONLY to the entry it was written for.
    expect(resolveTestSuiteSlot(collided, 'test', { boundKey: 'other', requirementCommands: ['npm test'] }))
      .toMatchObject({ status: 'bound' });
    // A declaration equal to the bound entry's own command is redundant, not a collision.
    const resolved = resolveTestSuiteSlot(
      plan([slot('test', 'npm run test:files'), slot('lint', 'npm run lint')]),
      'test',
      { boundKey: 'test', requirementCommands: ['npm test', 'npm run test:files'] },
    );
    expect(resolved.status).toBe('bound');
    expect(resolved.nonTestSlots.map((entry) => entry.name)).toEqual(['lint']);
  });

  test('a duplicate of the suite command is still reported as the duplicate it is', () => {
    // Both rules fire; the shipped reason wins so the existing handoff text stands.
    expect(resolveTestSuiteSlot(plan([slot('test', 'npm test'), slot('ci', 'npm test')]), 'test', {
      boundKey: 'test',
      requirementCommands: ['npm test'],
    })).toMatchObject({ status: 'unbound', reason: 'duplicate-suite-command' });
  });
});

describe('§5 rule 3 — the unconfirmed-termination guard (D1)', () => {
  const entry = (state, ordinal) => ({
    stageRunId: { taskAttempt: 0, lane: 'implementation', stage: 'loop', stageOrdinal: ordinal },
    requestKey: `k${ordinal}`,
    identity: identity(),
    allocatedAt: '2026-09-17T00:00:00.000Z',
    state,
  });
  const state = (runs) => ({ version: 2, ordinals: [], runs, loopBundles: [], finalBundles: [] });

  test('an allocated run with no result parks and is closed for the parking completion', () => {
    const guard = openStageRunGuard(state([entry('interrupted', 0), entry('allocated', 1)]), '2026-09-17T01:00:00.000Z');
    expect(guard.kind).toBe('park');
    expect(guard.stageRunKey).toBe('0/implementation/loop/1');
    expect(guard.closedState.runs.map((run) => run.state)).toEqual(['interrupted', 'interrupted']);
    expect(guard.closedState.runs[1].interruptedAt).toBe('2026-09-17T01:00:00.000Z');
  });

  test('no open allocation is clear', () => {
    expect(openStageRunGuard(state([entry('interrupted', 0)]), 'now')).toEqual({ kind: 'clear' });
    expect(openStageRunGuard(undefined, 'now')).toEqual({ kind: 'clear' });
  });
});

describe('fix input', () => {
  test('names failing files and never calls Stage 1 a suite pass', () => {
    const text = describeTestStageRecord(
      {
        result: 'failed',
        suiteBindingDigest: 'a'.repeat(64),
        selection: { status: 'full' },
        mode: 'full',
        trust: 'trusted',
        processResult: 'failed',
        outcomeCounts: { passed: 2, failed: 1, skipped: 0, notRun: 0 },
        failedFiles: ['tests/b.test.js'],
        outputTail: 'b failed',
      },
      'final',
      'test',
    );
    expect(text).toContain('Stage 2 (full test suite)');
    expect(text).toContain('Failing test files: tests/b.test.js');
    const suiteLevel = describeTestStageRecord(
      { result: 'failed', suiteBindingDigest: 'a'.repeat(64), selection: { status: 'full' }, mode: 'full', trust: 'unreadable-result', processResult: 'failed', failedFiles: [] },
      'final',
      'test',
    );
    expect(suiteLevel).toContain('suite-level failure');
    expect(suiteLevel).toContain('untrusted (unreadable-result)');
  });

  test('an all-skipped Stage 1 reports that no test ran, and an advanced base that old evidence is dead', () => {
    const text = describeTestStageRecord(
      {
        result: 'empty',
        suiteBindingDigest: 'a'.repeat(64),
        selection: {
          status: 'known',
          issueBase: {
            sha: 'a'.repeat(40),
            source: 'dependency-base',
            advancedFrom: { sha: 'b'.repeat(40), source: 'dependency-base' },
          },
          files: [{ file: 'tests/a.test.js', reasons: ['changed'] }],
          unresolvedRetained: [],
          selectionDigest: 'c'.repeat(64),
        },
        mode: 'files',
        trust: 'trusted',
        processResult: 'succeeded',
        outcomeCounts: { passed: 0, failed: 0, skipped: 1, notRun: 0 },
        failedFiles: [],
      },
      'loop',
      'test',
    );
    // D6: the run executed, credited nothing, and is not described as a pass.
    expect(text).toContain('Every selected test file was reached and skipped, so no test executed');
    expect(text).toContain('it never counts as a suite pass');
    // D5: the advance, and what it costs.
    expect(text).toContain(`The Issue base advanced to the accepted predecessor head ${'a'.repeat(40)}`);
    expect(text).toContain('earlier stage and review evidence no longer applies');
  });
});

// Issue #1166 — one place turns the session's staged block into the plain
// declaration the plan-level relation consumes, so every surface asks about
// the same one.
describe('fullSuiteRequirementDeclaration (§6 rule 5)', () => {
  const declaring = (testSuite, enabled = true) =>
    fullSuiteRequirementDeclaration({ stagedVerification: { enabled, testSuite } });

  test('a declared binding becomes the boundKey plus the declared commands', () => {
    expect(declaring({ test: { adapter: 'jest', requirementCommands: ['npm test'] } }))
      .toEqual({ boundKey: 'test', requirementCommands: ['npm test'] });
  });

  test('absence in any form declares nothing', () => {
    expect(fullSuiteRequirementDeclaration({})).toBeUndefined();
    expect(fullSuiteRequirementDeclaration({ stagedVerification: { enabled: true } })).toBeUndefined();
    expect(declaring({ test: { adapter: 'jest' } })).toBeUndefined();
    // A disabled session declares nothing even with the field written.
    expect(declaring({ test: { adapter: 'jest', requirementCommands: ['npm test'] } }, false)).toBeUndefined();
  });
});

describe('toolRequestTestSuiteKey (§6 rule 2 on the tool-request continuation lane)', () => {
  const bound = {
    verification: { test: 'npm test', typecheck: 'npm run typecheck' },
    stagedVerification: { enabled: true, testSuite: { test: { adapter: 'jest' } } },
  };

  const task = { context: {} };
  const suiteKey = (session, forTask, command) =>
    toolRequestTestSuiteKey(session, forTask, command, extractIssueVerificationCommands);

  test('a granted command that runs the bound suite names its key', () => {
    expect(suiteKey(bound, task, 'npm test')).toBe('test');
    expect(suiteKey(bound, task, '  npm test  ')).toBe('test');
  });

  test('a non-test check, a different command, or no binding is not the suite', () => {
    expect(suiteKey(bound, task, 'npm run typecheck')).toBeUndefined();
    expect(suiteKey(bound, task, 'npm install left-pad@1.3.0')).toBeUndefined();
    expect(suiteKey({ ...bound, stagedVerification: undefined }, task, 'npm test')).toBeUndefined();
    expect(suiteKey({ ...bound, stagedVerification: { enabled: false } }, task, 'npm test')).toBeUndefined();
  });

  // Issue #1166: a command the operator declared to BE this entry's Issue
  // requirement is the full suite by that declaration, so granting it verbatim
  // would be the pre-approval full run rule 2 forbids.
  test('a declared Issue-requirement command is the bound suite too', () => {
    const declared = {
      verification: { test: 'npm run test:files', typecheck: 'npm run typecheck' },
      stagedVerification: {
        enabled: true,
        testSuite: { test: { adapter: 'jest', requirementCommands: ['npm test'] } },
      },
    };
    expect(suiteKey(declared, task, 'npm run test:files')).toBe('test');
    expect(suiteKey(declared, task, 'npm test')).toBe('test');
    // Undeclared, the same command is not the suite — nothing is inferred.
    expect(suiteKey({ ...declared, stagedVerification: { enabled: true, testSuite: { test: { adapter: 'jest' } } } }, task, 'npm test'))
      .toBeUndefined();
    // And the declaration never covers another check.
    expect(suiteKey(declared, task, 'npm run typecheck')).toBeUndefined();
  });

  // An applied amendment block in the shape `applyVerificationAmendmentRevision`
  // persists, with the digests recomputed from its own inputs so it reconciles.
  function amendedTask(operations) {
    const baseline = buildVerificationSessionBaseline(bound.verification);
    const block = {
      revisions: [
        {
          revisionId: 'vamd-0000000000000001',
          revisionOrdinal: 1,
          requestKey: 'k1',
          scope: 'task',
          source: 'admin-cli',
          actor: { kind: 'operator', id: 'admin' },
          reason: 'correcting the suite command after intake',
          operations,
          basePlanDigest: 'a'.repeat(64),
          planDigest: 'b'.repeat(64),
          sessionBaselineDigest: baseline.sessionBaselineDigest,
          continuation: 'implementation',
          createdAt: '2026-09-02T00:00:00.000Z',
          observedTaskRevision: 0,
        },
      ],
      checkpoint: {
        planDigest: 'b'.repeat(64),
        sessionBaseline: baseline.sessionBaseline,
        sessionBaselineDigest: baseline.sessionBaselineDigest,
        appliedThroughOrdinal: 1,
        updatedAt: '2026-09-02T00:00:00.000Z',
        updatedBy: 'revision',
      },
    };
    const resolved = resolveEffectiveVerificationPlan({
      sessionVerification: bound.verification,
      issueRequirements: [],
      amendments: block,
    });
    expect(resolved.status).toBe('resolved');
    block.revisions[0].planDigest = resolved.plan.planDigest;
    block.checkpoint.planDigest = resolved.plan.planDigest;
    return { context: { [VERIFICATION_AMENDMENTS_CONTEXT_KEY]: block } };
  }

  test('an amended suite slot is matched by its effective command, not the superseded session bytes', () => {
    const amended = amendedTask([
      { kind: 'replace', commandId: 'exec:test', command: 'npx jest --ci', reason: 'run jest directly' },
    ]);
    expect(suiteKey(bound, amended, 'npx jest --ci')).toBe('test');
    expect(suiteKey(bound, amended, 'npm test')).toBeUndefined();
  });

  test('a retired suite slot runs no suite, so its command is not refused as one', () => {
    const retired = amendedTask([{ kind: 'retire', commandId: 'exec:test', reason: 'retired' }]);
    expect(suiteKey(bound, retired, 'npm test')).toBeUndefined();
  });
});
