// Issue #1103 — the `final` stage's §7 rows 7–13 and the stack-ready grant's
// row-7 precondition (docs/staged-verification-contract.md §13 slices S9/S10).
//
// Pure: the route table and the publication gate the shipped label builder
// reads over the context of the completion transaction.

import {
  routeFinalStageBundle,
  decideStackReadyPublication,
  FINAL_STAGE_GRANT_CONTEXT_KEY,
  readFinalStageApprovalContinuation,
} from '../dist/core/final-stage-gate.js';

const HEAD = 'a'.repeat(40);
const KEY = '2/review/final/0';

const bundle = (overrides = {}) => ({
  stageRunId: { taskAttempt: 2, lane: 'review', stage: 'final', stageOrdinal: 0 },
  outcome: 'passed',
  complete: true,
  selection: { checkIds: ['exec:test'], selectionDigest: 'd', full: true },
  headSha: HEAD,
  ...overrides,
});

const context = ({ bundleOverrides = {}, marker = {}, state = {} } = {}) => ({
  stagedVerification: {
    grantingStageRunKey: KEY,
    finalBundles: [bundle(bundleOverrides)],
    ...state,
  },
  [FINAL_STAGE_GRANT_CONTEXT_KEY]: { runId: 'run-9', stageRunKey: KEY, headSha: HEAD, ...marker },
});

const ENABLED = { enabled: true };

describe('§7 rows 7–13', () => {
  test.each([
    ['code-failed', 9, 'repair'],
    ['timed-out', 10, 'repair'],
    ['interrupted', 11, 'rerun'],
    ['unknown', 12, 'operator'],
    ['infrastructure', 13, 'host-retry'],
  ])('%s routes to row %i (%s)', (outcome, row, disposition) => {
    expect(routeFinalStageBundle(bundle({ outcome, complete: false }))).toEqual({ row, disposition });
  });

  test('row 7 is the only grantable cell: passed, complete and full', () => {
    expect(routeFinalStageBundle(bundle())).toEqual({ row: 7, disposition: 'grant' });
  });

  test('passed but incomplete is row 8, routed to the operator, never to repair', () => {
    expect(routeFinalStageBundle(bundle({ complete: false }))).toEqual({ row: 8, disposition: 'operator' });
  });

  test('passed over a partial selection is not row 7', () => {
    const partial = bundle({ selection: { ...bundle().selection, full: false } });
    expect(routeFinalStageBundle(partial)).toEqual({ row: 8, disposition: 'operator' });
  });
});

describe('the publication gate', () => {
  test('an un-opted-in session keeps the shipped review-success grant', () => {
    expect(decideStackReadyPublication({ stagedVerification: undefined, context: {}, runId: 'r' }))
      .toEqual({ kind: 'legacy' });
    expect(decideStackReadyPublication({ stagedVerification: { enabled: false }, context: {}, runId: 'r' }))
      .toEqual({ kind: 'legacy' });
  });

  test('a complete, passed, full final bundle bound to the declared head grants', () => {
    expect(decideStackReadyPublication({ stagedVerification: ENABLED, context: context(), runId: 'run-9' }))
      .toEqual({ kind: 'grant', stageRunKey: KEY });
  });

  test('review OK with no final bundle withholds', () => {
    expect(decideStackReadyPublication({ stagedVerification: ENABLED, context: {}, runId: 'run-9' }))
      .toEqual({ kind: 'withhold', reason: 'no-grant-declared' });
  });

  test('a declaration an earlier run left in the context withholds', () => {
    expect(decideStackReadyPublication({ stagedVerification: ENABLED, context: context(), runId: 'run-10' }))
      .toEqual({ kind: 'withhold', reason: 'grant-declared-by-another-run' });
  });

  test('a declaration whose bundle was never recorded as the R1 bundle withholds', () => {
    const noPointer = context({ state: { grantingStageRunKey: undefined } });
    expect(decideStackReadyPublication({ stagedVerification: ENABLED, context: noPointer, runId: 'run-9' }))
      .toEqual({ kind: 'withhold', reason: 'granting-bundle-not-recorded' });
    const noBundle = context({ state: { finalBundles: [] } });
    expect(decideStackReadyPublication({ stagedVerification: ENABLED, context: noBundle, runId: 'run-9' }))
      .toEqual({ kind: 'withhold', reason: 'granting-bundle-not-recorded' });
  });

  test.each([
    ['partial', { complete: false }],
    ['failed', { outcome: 'code-failed' }],
    ['narrowed', { selection: { checkIds: [], selectionDigest: 'd', full: false } }],
    ['a loop bundle', { stageRunId: { taskAttempt: 2, lane: 'review', stage: 'loop', stageOrdinal: 0 } }],
  ])('%s evidence never grants', (_label, bundleOverrides) => {
    const stageRunId = bundleOverrides.stageRunId;
    const ctx = stageRunId
      ? context({
          bundleOverrides,
          marker: { stageRunKey: '2/review/loop/0' },
          state: { grantingStageRunKey: '2/review/loop/0' },
        })
      : context({ bundleOverrides });
    expect(decideStackReadyPublication({ stagedVerification: ENABLED, context: ctx, runId: 'run-9' }))
      .toEqual({ kind: 'withhold', reason: 'granting-bundle-not-row-7' });
  });

  test('a stale revision — bundle and declaration on different heads — withholds', () => {
    const moved = context({ marker: { headSha: 'b'.repeat(40) } });
    expect(decideStackReadyPublication({ stagedVerification: ENABLED, context: moved, runId: 'run-9' }))
      .toEqual({ kind: 'withhold', reason: 'head-unbound' });
    const unattested = context({ bundleOverrides: { headSha: undefined } });
    expect(decideStackReadyPublication({ stagedVerification: ENABLED, context: unattested, runId: 'run-9' }))
      .toEqual({ kind: 'withhold', reason: 'head-unbound' });
  });
});

describe('final-stage approval continuation (issue #1103 review, P2)', () => {
  const approval = { classification: { classification: 'success', reason: 'ok' }, findingsContext: {} };

  test('resumes only at the head the reviewer approved', () => {
    expect(readFinalStageApprovalContinuation({ headSha: HEAD, approval }, `${HEAD}\n`))
      .toEqual({ headSha: HEAD, approval });
    expect(readFinalStageApprovalContinuation({ headSha: HEAD, approval }, 'c'.repeat(40))).toBeUndefined();
  });

  test('fails closed on an absent, cleared or unattested continuation', () => {
    expect(readFinalStageApprovalContinuation(undefined, HEAD)).toBeUndefined();
    expect(readFinalStageApprovalContinuation(null, HEAD)).toBeUndefined();
    expect(readFinalStageApprovalContinuation({ headSha: HEAD }, HEAD)).toBeUndefined();
    expect(readFinalStageApprovalContinuation({ approval }, HEAD)).toBeUndefined();
    expect(readFinalStageApprovalContinuation({ headSha: HEAD, approval }, undefined)).toBeUndefined();
  });
});
