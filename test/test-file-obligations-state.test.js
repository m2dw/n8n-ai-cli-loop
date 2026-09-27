// Issue #1153 — the Issue's retained failing test files and test-stage evidence,
// persisted through the shipped stage state (docs/changed-file-verification-contract.md
// §2, §3, §4.3 and §8 invariants 1 and 2).
//
// Pins the obligations end to end through `allocateStageRun` / `recordStageRun`
// on the existing task store: a failed Stage 2 adds exactly its trusted failed
// files; a repeated failure deduplicates; a later Stage 1 or Stage 2 pass — and
// a grant — never removes one; another Issue is unaffected; untrusted,
// suite-level, host, deadline and stale runs retain nothing; the set and the
// Issue base survive a requeue and a store restart and feed the next Stage 1
// selection. Records that claim more than their facts carry are refused, the
// block fails closed on read, and recorded Stage 1 evidence is reusable only
// for the same identity, suite binding and selection.
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  MemoryTaskStore,
  SqliteTaskStore,
  allocateStageRun,
  recordStageRun,
  readStagedVerificationState,
  validateStagedVerificationState,
  retainedTestFilesRead,
  grantingFinalBundle,
  deriveStageSelectionDigest,
  selectStage1TestFiles,
  buildTestStageRecord,
  deriveTestSuiteBindingDigest,
  deriveTestSuitePolicyComponent,
  evaluateStage1TestEvidenceReuse,
  evaluateFinalGrantBinding,
  stageRunKey,
  STAGED_VERIFICATION_CONTEXT_KEY,
  STAGED_VERIFICATION_STATE_VERSION,
  STAGED_VERIFICATION_LEGACY_STATE_VERSION,
} from '../dist/index.js';

const SESSION = 'sess-test-file-obligations';
const HEAD = 'a'.repeat(40);
const BASE = 'e'.repeat(40);
const PLAN_DIGEST = 'b'.repeat(64);
const SUITE = { key: 'test', command: 'npm test', adapter: 'jest', argumentSeparator: '--' };
const SUITE_DIGEST = deriveTestSuiteBindingDigest(SUITE);
const A = 'test/a.test.js';
const B = 'test/b.test.js';
const C = 'test/c.test.js';
const INVENTORY = { kind: 'readable', files: [A, B, C] };
const BRANCH_START = { status: 'resolved', base: { sha: BASE, source: 'branch-start' }, firstResolution: true };

let issueCounter = 0;
let requestCounter = 0;

function identity(overrides = {}) {
  return {
    testedRevision: { state: 'value', value: HEAD },
    workingTreeState: { state: 'value', value: 'clean' },
    planDigest: { state: 'value', value: PLAN_DIGEST },
    planRevisionOrdinal: { state: 'value', value: '0' },
    sessionBaselineDigest: { state: 'value', value: 's'.repeat(64) },
    selectionPolicyDigest: deriveTestSuitePolicyComponent({ state: 'resolved', configuration: SUITE }),
    environmentIdentity: { state: 'none', source: 'no-environment-sources-declared' },
    ...overrides,
  };
}

async function freshTask(store, context = {}) {
  const key = { sessionId: SESSION, issueNumber: (issueCounter += 1) };
  const enqueued = await store.enqueueTask({
    sessionId: key.sessionId,
    issueNumber: key.issueNumber,
    phase: 'implementation',
    context,
  });
  expect(enqueued.ok).toBe(true);
  return key;
}

async function stateOf(store, key) {
  const read = await readStagedVerificationState(store, key);
  expect(read.status).toBe('ok');
  return read.state;
}

/** A trusted, ended-on-its-own run with the given per-file outcomes. */
function run(mode, outcomes, overrides = {}) {
  const files = Object.entries(outcomes)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([file, outcome]) => ({ file, outcome }));
  return {
    mode,
    expectedFiles: files.map((entry) => entry.file),
    files,
    failedFiles: files.filter((entry) => entry.outcome === 'failed').map((entry) => entry.file),
    trust: { status: 'trusted' },
    processResult: files.some((entry) => entry.outcome === 'failed') ? 'failed' : 'succeeded',
    completeness: { status: 'complete' },
    termination: 'confirmed',
    steps: [],
    ...overrides,
  };
}

/** The Stage 1 selection for this task as the stored state feeds it. */
async function stage1Selection(store, key, changed = [A]) {
  const state = await stateOf(store, key);
  return selectStage1TestFiles({
    issueBase: state?.issueBase
      ? { status: 'resolved', base: state.issueBase, firstResolution: false }
      : BRANCH_START,
    change: { kind: 'readable', base: BASE, entries: changed.map((path) => ({ path, change: 'modified' })) },
    inventory: INVENTORY,
    retained: retainedTestFilesRead(state),
  });
}

function bundleFor(stageRunId, testFiles, overrides = {}) {
  return {
    stageRunId,
    planDigest: PLAN_DIGEST,
    headSha: HEAD,
    // The check half carries no checks here; its digest is the shipped derivation over no ids.
    selection: { checkIds: [], selectionDigest: deriveStageSelectionDigest([]), full: true },
    outcome: overrides.outcome ?? (testFiles.result === 'passed' || testFiles.result === 'empty' ? 'passed' : 'code-failed'),
    complete: true,
    checks: [],
    ...(testFiles !== undefined ? { testFiles } : {}),
    ...(overrides.identityRecheck !== undefined ? { identityRecheck: overrides.identityRecheck } : {}),
  };
}

async function recordRun(store, key, stage, testFiles, options = {}) {
  const task = await store.getTask(key);
  const allocated = await allocateStageRun({
    store,
    key,
    observedTaskRevision: task.revision,
    requestKey: `req-${(requestCounter += 1)}`,
    taskAttempt: 1,
    lane: stage === 'final' ? 'review' : 'implementation',
    stage,
    identity: options.identity ?? identity(),
  });
  expect(allocated.status).toBe('allocated');
  const current = await store.getTask(key);
  const bundle = bundleFor(allocated.entry.stageRunId, testFiles, options);
  return recordStageRun({
    store,
    key,
    observedTaskRevision: current.revision,
    bundle,
    ...(options.grantsStackReady ? { grantsStackReady: true } : {}),
  });
}

async function passStage1(store, key, changed = [A], options = {}) {
  const selection = await stage1Selection(store, key, changed);
  expect(selection.status).toBe('known');
  const outcomes = Object.fromEntries(selection.files.map((entry) => [entry.file, 'passed']));
  const recorded = await recordRun(
    store,
    key,
    'loop',
    buildTestStageRecord({ result: 'passed', suiteBindingDigest: SUITE_DIGEST, selection, run: run('files', outcomes) }),
    { identityRecheck: identity(), ...options },
  );
  expect(recorded.status).toBe('recorded');
  return { selection, recorded };
}

async function stage2(store, key, result, outcomes, runOverrides = {}, options = {}) {
  const testFiles = buildTestStageRecord({
    result,
    suiteBindingDigest: SUITE_DIGEST,
    selection: { status: 'full' },
    run: run('full', outcomes, runOverrides),
  });
  return recordRun(store, key, 'final', testFiles, options);
}

// ---------------------------------------------------------------------------

describe('retained failing test files — §4.3 through recordStageRun', () => {
  let store;

  beforeEach(() => {
    store = new MemoryTaskStore();
  });

  test('full failure B adds B; a repeat deduplicates; passes and a grant keep it; another Issue is unaffected', async () => {
    const issue = await freshTask(store);
    const other = await freshTask(store);

    const first = await passStage1(store, issue);
    expect(first.selection.files).toEqual([{ file: A, reasons: ['changed'] }]);
    await passStage1(store, other);

    const failed = await stage2(store, issue, 'failed', { [A]: 'passed', [B]: 'failed', [C]: 'passed' });
    expect(failed.status).toBe('recorded');
    const addedBy = '1/review/final/0';
    expect((await stateOf(store, issue)).retainedTestFiles).toEqual([{ file: B, addedBy }]);
    expect(failed.event.data.testFiles).toEqual({
      result: 'failed',
      selection: 'full',
      failedFileCount: 1,
      retainedTestFileCount: 1,
      retainedTestFilesAdded: 1,
    });

    // The next Stage 1 runs A and B; B passing does not remove it.
    const next = await passStage1(store, issue);
    expect(next.selection.files).toEqual([
      { file: A, reasons: ['changed'] },
      { file: B, reasons: ['retained'] },
    ]);
    expect((await stateOf(store, issue)).retainedTestFiles).toEqual([{ file: B, addedBy }]);

    // The same failure again deduplicates and keeps the run that first added it.
    expect((await stage2(store, issue, 'failed', { [A]: 'passed', [B]: 'failed', [C]: 'passed' })).status).toBe('recorded');
    expect((await stateOf(store, issue)).retainedTestFiles).toEqual([{ file: B, addedBy }]);

    // A full pass that grants stack-ready keeps it too.
    const granted = await stage2(store, issue, 'passed', { [A]: 'passed', [B]: 'passed', [C]: 'skipped' }, {}, { grantsStackReady: true, identityRecheck: identity() });
    expect(granted.status).toBe('recorded');
    const after = await stateOf(store, issue);
    expect(after.retainedTestFiles).toEqual([{ file: B, addedBy }]);
    expect(after.grantingStageRunKey).toBe('1/review/final/2');
    expect((await passStage1(store, issue, [])).selection.files).toEqual([{ file: B, reasons: ['retained'] }]);

    // The other Issue's row never saw any of it.
    const otherState = await stateOf(store, other);
    expect(otherState.retainedTestFiles).toBeUndefined();
    expect(retainedTestFilesRead(otherState)).toEqual({ kind: 'readable', files: [] });
    expect((await stage1Selection(store, other)).files).toEqual([{ file: A, reasons: ['changed'] }]);
  });

  test('untrusted, suite-level, host, deadline and stale Stage 2 runs retain nothing', async () => {
    const issue = await freshTask(store);
    const cases = [
      // An unreadable adapter result on a nonzero exit is still `failed`, and retains nothing.
      ['failed', { [B]: 'failed' }, { trust: { status: 'untrusted', reason: 'unreadable-result', detail: 'x' }, files: [], failedFiles: [], processResult: 'failed' }],
      // A suite-level failure: nonzero exit, no failed file.
      ['failed', { [A]: 'passed', [B]: 'not-run' }, { processResult: 'failed' }],
      ['infrastructure', { [A]: 'passed', [B]: 'failed' }, {}],
      ['timed-out', {}, { trust: { status: 'untrusted', reason: 'deadline', detail: 'x' }, files: [], failedFiles: [], processResult: undefined }],
      ['stale', { [A]: 'passed', [B]: 'failed' }, {}],
    ];
    for (const [result, outcomes, overrides] of cases) {
      const recorded = await stage2(store, issue, result, outcomes, overrides);
      expect(recorded.status).toBe('recorded');
    }
    const state = await stateOf(store, issue);
    expect(state.retainedTestFiles).toBeUndefined();
    // A fail-fast stop retains only the file that genuinely failed.
    await stage2(store, issue, 'failed', { [A]: 'passed', [B]: 'failed', [C]: 'not-run' });
    expect((await stateOf(store, issue)).retainedTestFiles).toEqual([{ file: B, addedBy: '1/review/final/5' }]);
  });

  test('the Issue base is recorded by the first known Stage 1 selection and never rewritten', async () => {
    const issue = await freshTask(store);
    await passStage1(store, issue);
    expect((await stateOf(store, issue)).issueBase).toEqual({ sha: BASE, source: 'branch-start' });

    const moved = selectStage1TestFiles({
      issueBase: { status: 'resolved', base: { sha: 'f'.repeat(40), source: 'branch-start' }, firstResolution: true },
      change: { kind: 'readable', base: 'f'.repeat(40), entries: [{ path: A, change: 'modified' }] },
      inventory: INVENTORY,
      retained: { kind: 'readable', files: [] },
    });
    const refused = await recordRun(
      store,
      issue,
      'loop',
      buildTestStageRecord({ result: 'passed', suiteBindingDigest: SUITE_DIGEST, selection: moved, run: run('files', { [A]: 'passed' }) }),
    );
    expect(refused).toMatchObject({ status: 'refused', reason: 'invalid_input' });
    expect(refused.detail).toContain('declares the accepted predecessor update it replaces');
    expect((await stateOf(store, issue)).issueBase).toEqual({ sha: BASE, source: 'branch-start' });
  });

  // Issue #1165, decision D5. Only a base this contract resolved against a
  // predecessor can advance, so the Issue starts from a recorded dependency base.
  const DEPENDENCY_START = { status: 'resolved', base: { sha: BASE, source: 'dependency-base' }, firstResolution: true };

  /** The first Stage 1 of a dependency-started Issue: records `dependency-base`. */
  async function passStage1FromDependencyBase(store_, key, changed = [A]) {
    const selection = selectStage1TestFiles({
      issueBase: DEPENDENCY_START,
      change: { kind: 'readable', base: BASE, entries: changed.map((path) => ({ path, change: 'modified' })) },
      inventory: INVENTORY,
      retained: { kind: 'readable', files: [] },
    });
    expect(selection.status).toBe('known');
    const recorded = await recordRun(
      store_,
      key,
      'loop',
      buildTestStageRecord({
        result: 'passed',
        suiteBindingDigest: SUITE_DIGEST,
        selection,
        run: run('files', Object.fromEntries(selection.files.map((entry) => [entry.file, 'passed']))),
      }),
      { identityRecheck: identity() },
    );
    expect(recorded.status).toBe('recorded');
    return recorded;
  }

  test('a declared, accepted predecessor update advances the base, keeps obligations and invalidates earlier evidence', async () => {
    const issue = await freshTask(store);
    const NEW_BASE = 'd'.repeat(40);
    await passStage1FromDependencyBase(store, issue);
    const failed = await stage2(store, issue, 'failed', { [A]: 'passed', [B]: 'failed', [C]: 'passed' });
    expect(failed.status).toBe('recorded');
    const before = await stateOf(store, issue);
    expect(before.issueBase).toEqual({ sha: BASE, source: 'dependency-base' });
    expect(before.retainedTestFiles).toEqual([{ file: B, addedBy: stageRunKey(failed.bundle.stageRunId) }]);
    expect(before.finalBundles).toHaveLength(1);

    const advanced = { sha: NEW_BASE, source: 'dependency-base', advancedFrom: { sha: BASE, source: 'dependency-base' } };
    const selection = selectStage1TestFiles({
      issueBase: { status: 'resolved', base: advanced, firstResolution: false },
      change: { kind: 'readable', base: NEW_BASE, entries: [{ path: A, change: 'modified' }] },
      inventory: INVENTORY,
      retained: retainedTestFilesRead(before),
    });
    expect(selection.status).toBe('known');
    const recorded = await recordRun(
      store,
      issue,
      'loop',
      buildTestStageRecord({
        result: 'passed',
        suiteBindingDigest: SUITE_DIGEST,
        selection,
        run: run('files', { [A]: 'passed', [B]: 'passed' }),
      }),
      { identityRecheck: identity() },
    );
    expect(recorded.status).toBe('recorded');

    const after = await stateOf(store, issue);
    // The base moved, and the persisted base keeps no advance of its own.
    expect(after.issueBase).toEqual({ sha: NEW_BASE, source: 'dependency-base' });
    // The obligation is the Issue's, not a revision's: a re-base leaves it alone.
    expect(after.retainedTestFiles).toEqual(before.retainedTestFiles);
    // Stage 2 evidence taken against the old base is unusable, so it is gone.
    expect(after.finalBundles).toEqual([]);
    expect(after.grantingStageRunKey).toBeUndefined();
    expect(after.loopBundles.at(-1).testFiles.selection.issueBase).toEqual(advanced);

    // The persisted block still round trips, advance stripped.
    const task = await store.getTask(issue);
    const reread = validateStagedVerificationState(task.context[STAGED_VERIFICATION_CONTEXT_KEY]);
    expect(reread.valid).toBe(true);
    expect(reread.state.issueBase).toEqual({ sha: NEW_BASE, source: 'dependency-base' });
  });

  // Issue #1165 review, P1: the granting bundle is not an exception to D5.
  test('an advance drops even the bundle a live grant rested on, and unpins the grant', async () => {
    const issue = await freshTask(store);
    const NEW_BASE = 'd'.repeat(40);
    await passStage1FromDependencyBase(store, issue);
    const granted = await stage2(
      store,
      issue,
      'passed',
      { [A]: 'passed', [B]: 'passed', [C]: 'passed' },
      {},
      { grantsStackReady: true, identityRecheck: identity() },
    );
    expect(granted.status).toBe('recorded');
    const before = await stateOf(store, issue);
    expect(before.grantingStageRunKey).toBe(stageRunKey(granted.bundle.stageRunId));
    expect(before.finalBundles).toHaveLength(1);

    const advanced = { sha: NEW_BASE, source: 'dependency-base', advancedFrom: { sha: BASE, source: 'dependency-base' } };
    const selection = selectStage1TestFiles({
      issueBase: { status: 'resolved', base: advanced, firstResolution: false },
      change: { kind: 'readable', base: NEW_BASE, entries: [{ path: A, change: 'modified' }] },
      inventory: INVENTORY,
      retained: retainedTestFilesRead(before),
    });
    const recorded = await recordRun(
      store,
      issue,
      'loop',
      buildTestStageRecord({ result: 'passed', suiteBindingDigest: SUITE_DIGEST, selection, run: run('files', { [A]: 'passed' }) }),
      { identityRecheck: identity() },
    );
    expect(recorded.status).toBe('recorded');

    const after = await stateOf(store, issue);
    expect(after.issueBase).toEqual({ sha: NEW_BASE, source: 'dependency-base' });
    // Keeping the granting bundle would leave a head and identity a post-advance
    // reuse check could still match — publishing a grant with no Stage 2 run at
    // the new base. Nothing survives, and nothing stays pinned.
    expect(after.finalBundles).toEqual([]);
    expect(after.grantingStageRunKey).toBeUndefined();
    expect(grantingFinalBundle(after)).toBeUndefined();
    // A fresh Stage 2 at the new base grants again, and pins its own bundle.
    const regranted = await stage2(
      store,
      issue,
      'passed',
      { [A]: 'passed' },
      {},
      { grantsStackReady: true, identityRecheck: identity() },
    );
    expect(regranted.status).toBe('recorded');
    const regrantedState = await stateOf(store, issue);
    expect(regrantedState.grantingStageRunKey).toBe(stageRunKey(regranted.bundle.stageRunId));
    expect(regrantedState.finalBundles).toHaveLength(1);
  });

  // Issue #1165 review, P1: the approval a final stage left waiting is not part
  // of the staged block, so evicting the bundles does not reach it. An already
  // -ancestor predecessor head leaves the branch head untouched, which is
  // exactly the case where it would still bind — and the review lane would then
  // resume on it, skip its reviewer and run Stage 2 under an approval of the
  // base the Issue has left.
  test('an advance evicts the approval waiting on its own final stage; a record that moves no base leaves it alone', async () => {
    const APPROVAL = { headSha: HEAD, approval: { classification: { classification: 'success' }, findingsContext: {} } };
    const issue = await freshTask(store, { finalStageApproval: APPROVAL });
    const NEW_BASE = 'd'.repeat(40);
    const first = await passStage1FromDependencyBase(store, issue);
    // The base was written, not advanced: the continuation is untouched, and
    // the write says so by carrying the staged block alone.
    expect(Object.keys(first.contextPatch)).toEqual([STAGED_VERIFICATION_CONTEXT_KEY]);
    expect((await store.getTask(issue)).context.finalStageApproval).toEqual(APPROVAL);

    const advanced = { sha: NEW_BASE, source: 'dependency-base', advancedFrom: { sha: BASE, source: 'dependency-base' } };
    const selection = selectStage1TestFiles({
      issueBase: { status: 'resolved', base: advanced, firstResolution: false },
      change: { kind: 'readable', base: NEW_BASE, entries: [{ path: A, change: 'modified' }] },
      inventory: INVENTORY,
      retained: retainedTestFilesRead(await stateOf(store, issue)),
    });
    const recorded = await recordRun(
      store,
      issue,
      'loop',
      buildTestStageRecord({ result: 'passed', suiteBindingDigest: SUITE_DIGEST, selection, run: run('files', { [A]: 'passed' }) }),
      { identityRecheck: identity() },
    );
    expect(recorded.status).toBe('recorded');
    // One write: the base advanced and the approval went with the evidence.
    expect(recorded.contextPatch.finalStageApproval).toBeNull();
    expect((await stateOf(store, issue)).issueBase).toEqual({ sha: NEW_BASE, source: 'dependency-base' });
    expect((await store.getTask(issue)).context.finalStageApproval ?? null).toBeNull();
  });

  test('an advance that declares nothing, or declares a base that is not the recorded one, is refused', async () => {
    const issue = await freshTask(store);
    const NEW_BASE = 'd'.repeat(40);
    await passStage1(store, issue);

    const attempt = async (base) => {
      const selection = selectStage1TestFiles({
        issueBase: { status: 'resolved', base, firstResolution: false },
        change: { kind: 'readable', base: base.sha, entries: [{ path: A, change: 'modified' }] },
        inventory: INVENTORY,
        retained: { kind: 'readable', files: [] },
      });
      return recordRun(
        store,
        issue,
        'loop',
        buildTestStageRecord({ result: 'passed', suiteBindingDigest: SUITE_DIGEST, selection, run: run('files', { [A]: 'passed' }) }),
        { identityRecheck: identity() },
      );
    };

    // A silent rewrite — all a moved ref or a bare fetch can produce.
    expect(await attempt({ sha: NEW_BASE, source: 'dependency-base' }))
      .toMatchObject({ status: 'refused', reason: 'invalid_input' });
    // An advance off a base this task never recorded.
    expect(await attempt({
      sha: NEW_BASE,
      source: 'dependency-base',
      advancedFrom: { sha: 'c'.repeat(40), source: 'dependency-base' },
    })).toMatchObject({ status: 'refused', reason: 'invalid_input' });
    // Only a predecessor head advances a base; a branch start never does.
    const branchStart = await attempt({
      sha: NEW_BASE,
      source: 'branch-start',
      advancedFrom: { sha: BASE, source: 'branch-start' },
    });
    expect(branchStart).toMatchObject({ status: 'refused', reason: 'invalid_input' });
    expect(branchStart.detail).toContain('advancedFrom');
    // And a base this contract never resolved against a predecessor never
    // advances onto one, however exactly the advance is declared (§4.1 rule 1).
    const fromBranchStart = await attempt({
      sha: NEW_BASE,
      source: 'dependency-base',
      advancedFrom: { sha: BASE, source: 'branch-start' },
    });
    expect(fromBranchStart).toMatchObject({ status: 'refused', reason: 'invalid_input' });
    expect(fromBranchStart.detail).toContain('never resolved against a predecessor never advances');
    expect((await stateOf(store, issue)).issueBase).toEqual({ sha: BASE, source: 'branch-start' });
  });

  // Issue #1165 review, P2. A declaration on the base that is already recorded
  // — a stale advance computed before another run moved the base onto this very
  // commit — must not slip past the advance validation just because the base
  // itself agrees: it would persist a selection claiming a re-base while the
  // evidence and the approval that re-base invalidates stay valid.
  test('a bundle that names the recorded base while declaring an advance is refused', async () => {
    const APPROVAL = { headSha: HEAD, approval: { classification: { classification: 'success' }, findingsContext: {} } };
    const issue = await freshTask(store, { finalStageApproval: APPROVAL });
    await passStage1FromDependencyBase(store, issue);
    const failed = await stage2(store, issue, 'failed', { [A]: 'passed', [B]: 'failed', [C]: 'passed' });
    expect(failed.status).toBe('recorded');
    const before = await stateOf(store, issue);
    expect(before.issueBase).toEqual({ sha: BASE, source: 'dependency-base' });

    const selection = selectStage1TestFiles({
      issueBase: {
        status: 'resolved',
        base: { sha: BASE, source: 'dependency-base', advancedFrom: { sha: 'c'.repeat(40), source: 'dependency-base' } },
        firstResolution: false,
      },
      change: { kind: 'readable', base: BASE, entries: [{ path: A, change: 'modified' }] },
      inventory: INVENTORY,
      retained: retainedTestFilesRead(before),
    });
    const refused = await recordRun(
      store,
      issue,
      'loop',
      buildTestStageRecord({
        result: 'passed',
        suiteBindingDigest: SUITE_DIGEST,
        selection,
        run: run('files', { [A]: 'passed', [B]: 'passed' }),
      }),
      { identityRecheck: identity() },
    );
    expect(refused).toMatchObject({ status: 'refused', reason: 'invalid_input' });
    expect(refused.detail).toContain('advancedFrom');
    expect(refused.detail).toContain('is unchanged at');

    // Nothing was recorded, and nothing the declaration claimed to replace was
    // invalidated behind it.
    const after = await stateOf(store, issue);
    expect(after.issueBase).toEqual({ sha: BASE, source: 'dependency-base' });
    expect(after.finalBundles).toHaveLength(1);
    expect(after.retainedTestFiles).toEqual(before.retainedTestFiles);
    expect((await store.getTask(issue)).context.finalStageApproval).toEqual(APPROVAL);
  });

  test('a base that resolved before a later selection input failed is persisted, and a retry never re-resolves it', async () => {
    const issue = await freshTask(store);
    const selection = selectStage1TestFiles({
      issueBase: BRANCH_START,
      change: { kind: 'readable', base: BASE, entries: [{ path: A, change: 'modified' }] },
      inventory: { kind: 'unreadable', reason: 'the runner crashed' },
      retained: { kind: 'readable', files: [] },
    });
    expect(selection).toMatchObject({ status: 'unavailable', reason: 'runnable-file-report', issueBase: { sha: BASE, source: 'branch-start' } });
    const unavailable = await recordRun(
      store,
      issue,
      'loop',
      buildTestStageRecord({ result: 'unavailable', suiteBindingDigest: SUITE_DIGEST, selection }),
      { outcome: 'unknown' },
    );
    expect(unavailable.status).toBe('recorded');
    expect((await stateOf(store, issue)).issueBase).toEqual({ sha: BASE, source: 'branch-start' });

    // The branch moved between attempts: a selection against the recomputed base is refused.
    const recomputed = selectStage1TestFiles({
      issueBase: { status: 'resolved', base: { sha: 'f'.repeat(40), source: 'branch-start' }, firstResolution: true },
      change: { kind: 'readable', base: 'f'.repeat(40), entries: [{ path: A, change: 'modified' }] },
      inventory: INVENTORY,
      retained: { kind: 'readable', files: [] },
    });
    const refused = await recordRun(
      store,
      issue,
      'loop',
      buildTestStageRecord({ result: 'passed', suiteBindingDigest: SUITE_DIGEST, selection: recomputed, run: run('files', { [A]: 'passed' }) }),
      { identityRecheck: identity() },
    );
    expect(refused).toMatchObject({ status: 'refused', reason: 'invalid_input' });
    expect(refused.detail).toContain('declares the accepted predecessor update it replaces');
    // The next selection reads the recorded base.
    expect((await passStage1(store, issue)).selection.issueBase).toEqual({ sha: BASE, source: 'branch-start' });
  });

  test('an unavailable Issue base carries no base, and a base on a Stage 2 or issue-base unavailable record is refused', async () => {
    const issue = await freshTask(store);
    const selection = selectStage1TestFiles({
      issueBase: { status: 'unavailable', reason: 'branch_start_unreadable', detail: 'no ref' },
      change: { kind: 'readable', base: BASE, entries: [] },
      inventory: INVENTORY,
      retained: { kind: 'readable', files: [] },
    });
    expect(selection.issueBase).toBeUndefined();

    const base = { sha: BASE, source: 'branch-start' };
    for (const [stage, record] of [
      ['loop', { result: 'unavailable', suiteBindingDigest: SUITE_DIGEST, selection: { status: 'unavailable', reason: 'issue-base', issueBase: base }, failedFiles: [] }],
      ['final', { result: 'unavailable', suiteBindingDigest: SUITE_DIGEST, selection: { status: 'unavailable', reason: 'retained-set', issueBase: base }, failedFiles: [] }],
    ]) {
      const refused = await recordRun(store, issue, stage, record, { outcome: 'unknown' });
      expect(refused).toMatchObject({ status: 'refused', reason: 'invalid_input' });
      expect(refused.detail).toContain('selection.issueBase');
    }
    expect((await stateOf(store, issue))?.issueBase).toBeUndefined();
  });
});

describe('restart and requeue — SqliteTaskStore', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'test-file-obligations-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('a reopened store reads the obligations and the base, and the next Stage 1 selects them', async () => {
    const dbPath = join(tmpDir, 'tasks.db');
    const first = new SqliteTaskStore(dbPath);
    const issue = await freshTask(first);
    await passStage1(first, issue);
    await stage2(first, issue, 'failed', { [A]: 'passed', [B]: 'failed', [C]: 'failed' });
    // The shipped `needs_fix` requeue patches no staged-verification context.
    const requeued = await first.transitionTask(issue, {}, { status: 'queued', phase: 'implementation' });
    expect(requeued.ok).toBe(true);
    first.close();

    const reopened = new SqliteTaskStore(dbPath);
    try {
      const task = await reopened.getTask(issue);
      const block = task.context[STAGED_VERIFICATION_CONTEXT_KEY];
      expect(block.version).toBe(STAGED_VERIFICATION_STATE_VERSION);
      expect(block.issueBase).toEqual({ sha: BASE, source: 'branch-start' });
      expect(block.retainedTestFiles).toEqual([
        { file: B, addedBy: '1/review/final/0' },
        { file: C, addedBy: '1/review/final/0' },
      ]);
      const { selection } = await passStage1(reopened, issue, []);
      expect(selection.files).toEqual([
        { file: B, reasons: ['retained'] },
        { file: C, reasons: ['retained'] },
      ]);
    } finally {
      reopened.close();
    }
  });

  test('a reopened store keeps the failure evidence of a failed and a timed-out Stage 2 run (§2)', async () => {
    const dbPath = join(tmpDir, 'tasks.db');
    const first = new SqliteTaskStore(dbPath);
    // One Issue per run: a later non-granting final bundle replaces the earlier one.
    const failedIssue = await freshTask(first);
    const timedOutIssue = await freshTask(first);
    const steps = (testsStep) => [
      { step: 'discovery', exitCode: 0, logArtifact: 'final-discovery.log' },
      { ...testsStep, step: 'tests', logArtifact: 'final-tests.log' },
    ];
    const failed = await stage2(first, failedIssue, 'failed', { [A]: 'passed', [B]: 'failed' }, {
      steps: steps({ exitCode: 1 }),
      resultArtifact: 'final-result.json',
    });
    expect(failed.status).toBe('recorded');
    const timedOut = await stage2(first, timedOutIssue, 'timed-out', {}, {
      trust: { status: 'untrusted', reason: 'deadline', detail: 'x' },
      files: [],
      failedFiles: [],
      processResult: undefined,
      steps: steps({ timedOut: true }),
      outputTail: 'RUNS test/c.test.js',
    });
    expect(timedOut.status).toBe('recorded');
    first.close();

    const reopened = new SqliteTaskStore(dbPath);
    try {
      const logArtifacts = [
        { step: 'discovery', artifact: 'final-discovery.log' },
        { step: 'tests', artifact: 'final-tests.log' },
      ];
      const [failedRecord] = (await stateOf(reopened, failedIssue)).finalBundles.map((bundle) => bundle.testFiles);
      expect(failedRecord).toMatchObject({ result: 'failed', resultArtifact: 'final-result.json', logArtifacts });
      const [timedOutRecord] = (await stateOf(reopened, timedOutIssue)).finalBundles.map((bundle) => bundle.testFiles);
      expect(timedOutRecord).toMatchObject({ result: 'timed-out', outputTail: 'RUNS test/c.test.js', logArtifacts });
    } finally {
      reopened.close();
    }
  });
});

describe('write refusals — a record never claims more than its facts', () => {
  let store;
  let issue;

  beforeEach(async () => {
    store = new MemoryTaskStore();
    issue = await freshTask(store);
  });

  test('only a Stage 2 passed result may grant', async () => {
    const refused = await stage2(store, issue, 'no-evidence', { [A]: 'skipped' }, {}, { grantsStackReady: true, outcome: 'passed' });
    expect(refused).toMatchObject({ status: 'refused', reason: 'invalid_input' });
    expect(refused.detail).toContain('"passed" beside a "no-evidence" test-file result');
  });

  test('a bundle whose test-file result is not a pass never records a passed outcome', async () => {
    const failed = await stage2(store, issue, 'failed', { [A]: 'passed', [B]: 'failed' }, {}, { outcome: 'passed' });
    expect(failed).toMatchObject({ status: 'refused', reason: 'invalid_input' });
    expect(failed.detail).toContain('"passed" beside a "failed" test-file result');
    const state = await stateOf(store, issue);
    expect(state?.finalBundles ?? []).toEqual([]);
    expect(state?.retainedTestFiles).toBeUndefined();

    const unavailable = await recordRun(
      store,
      issue,
      'loop',
      buildTestStageRecord({
        result: 'unavailable',
        suiteBindingDigest: SUITE_DIGEST,
        selection: { status: 'unavailable', reason: 'cumulative-change' },
      }),
      { outcome: 'passed' },
    );
    expect(unavailable).toMatchObject({ status: 'refused', reason: 'invalid_input' });
    expect(unavailable.detail).toContain('"passed" beside a "unavailable" test-file result');
  });

  test('a Stage 2 pass grants only with a present, matching end-of-run identity recheck', async () => {
    const outcomes = { [A]: 'passed', [B]: 'passed' };
    const missing = await stage2(store, issue, 'passed', outcomes, {}, { grantsStackReady: true });
    expect(missing).toMatchObject({ status: 'refused', reason: 'invalid_input' });
    expect(missing.detail).toContain('no end-of-run identity recheck');

    // The revision moved mid-run and came back: launch and publication agree, the recheck does not.
    const moved = await stage2(store, issue, 'passed', outcomes, {}, {
      grantsStackReady: true,
      identityRecheck: identity({ testedRevision: { state: 'value', value: 'c'.repeat(40) } }),
    });
    expect(moved).toMatchObject({ status: 'refused', reason: 'invalid_input' });
    expect(moved.detail).toContain('a mismatched end-of-run identity recheck');
    expect((await stateOf(store, issue)).grantingStageRunKey).toBeUndefined();

    // The grant binding refuses the missing recheck too, and admits the attested run.
    const recorded = await stage2(store, issue, 'passed', outcomes);
    expect(recorded.status).toBe('recorded');
    const expectation = {
      taskAttempt: 1,
      lane: 'review',
      planDigest: PLAN_DIGEST,
      headSha: HEAD,
      identity: identity(),
    };
    const binding = evaluateFinalGrantBinding({ bundle: recorded.bundle, expectation });
    expect(binding.granted).toBe(false);
    expect(binding.refusals.map((refusal) => refusal.reason)).toEqual(['identity-recheck-missing']);
    expect(
      evaluateFinalGrantBinding({ bundle: { ...recorded.bundle, identityRecheck: identity() }, expectation }).granted,
    ).toBe(true);

    const granted = await stage2(store, issue, 'passed', outcomes, {}, { grantsStackReady: true, identityRecheck: identity() });
    expect(granted.status).toBe('recorded');
    expect((await stateOf(store, issue)).grantingStageRunKey).toBe(stageRunKey(granted.bundle.stageRunId));
  });

  test('an unavailable result never carries run facts, so a trusted Stage 2 failure cannot hide under it', async () => {
    const trustedFailure = buildTestStageRecord({
      result: 'unavailable',
      suiteBindingDigest: SUITE_DIGEST,
      selection: { status: 'full' },
      run: run('full', { [A]: 'passed', [B]: 'failed' }),
    });
    const refused = await recordRun(store, issue, 'final', trustedFailure, { outcome: 'unknown' });
    expect(refused).toMatchObject({ status: 'refused', reason: 'invalid_input' });
    expect(refused.detail).toContain('requested a run (§3 R2)');

    const selection = await stage1Selection(store, issue);
    const stage1 = buildTestStageRecord({
      result: 'unavailable',
      suiteBindingDigest: SUITE_DIGEST,
      selection,
      run: run('files', { [A]: 'passed' }),
    });
    expect(await recordRun(store, issue, 'loop', stage1, { outcome: 'unknown' })).toMatchObject({ status: 'refused', reason: 'invalid_input' });

    // A launch-time plan refusal requested no run and is still recorded.
    const planRefusal = await recordRun(
      store,
      issue,
      'final',
      buildTestStageRecord({ result: 'unavailable', suiteBindingDigest: SUITE_DIGEST, selection: { status: 'full' } }),
      { outcome: 'unknown' },
    );
    expect(planRefusal.status).toBe('recorded');
    expect((await stateOf(store, issue)).retainedTestFiles).toBeUndefined();
  });

  test('once the task uses test-file verification, a final bundle with no Stage 2 test result never grants', async () => {
    await passStage1(store, issue);
    const refused = await recordRun(store, issue, 'final', undefined, { grantsStackReady: true, outcome: 'passed' });
    expect(refused).toMatchObject({ status: 'refused', reason: 'invalid_input' });
    expect(refused.detail).toContain('no Stage 2 test result never grants');
    expect((await stateOf(store, issue)).grantingStageRunKey).toBeUndefined();
  });

  test('entering the flow is sticky: an evicted unavailable Stage 1 bundle still blocks a check-only grant', async () => {
    // An unavailable Stage 1 sets no base and retains nothing; only its bundle marks the flow.
    const unavailable = await recordRun(
      store,
      issue,
      'loop',
      buildTestStageRecord({
        result: 'unavailable',
        suiteBindingDigest: SUITE_DIGEST,
        selection: { status: 'unavailable', reason: 'cumulative-change' },
      }),
      { outcome: 'unknown' },
    );
    expect(unavailable.status).toBe('recorded');
    expect(unavailable.state.version).toBe(STAGED_VERIFICATION_STATE_VERSION);

    // A check-only loop bundle in the same lane evicts it; the block stays version 2.
    const checkOnly = await recordRun(store, issue, 'loop', undefined, { outcome: 'passed' });
    expect(checkOnly.status).toBe('recorded');
    const state = await stateOf(store, issue);
    expect(state.loopBundles.some((bundle) => bundle.testFiles !== undefined)).toBe(false);
    expect(state.issueBase).toBeUndefined();
    expect(state.version).toBe(STAGED_VERIFICATION_STATE_VERSION);

    const refused = await recordRun(store, issue, 'final', undefined, { grantsStackReady: true, outcome: 'passed' });
    expect(refused).toMatchObject({ status: 'refused', reason: 'invalid_input' });
    expect(refused.detail).toContain('no Stage 2 test result never grants');
    expect((await stateOf(store, issue)).grantingStageRunKey).toBeUndefined();
  });

  test('a suite binding digest that is not the run identity\'s is refused', async () => {
    const other = deriveTestSuiteBindingDigest({ ...SUITE, command: 'npm run test:all' });
    const testFiles = buildTestStageRecord({
      result: 'failed',
      suiteBindingDigest: other,
      selection: { status: 'full' },
      run: run('full', { [B]: 'failed' }),
    });
    const refused = await recordRun(store, issue, 'final', testFiles);
    expect(refused).toMatchObject({ status: 'refused', reason: 'invalid_input' });
    expect(refused.detail).toContain('suiteBindingDigest');
    expect((await stateOf(store, issue)).retainedTestFiles).toBeUndefined();
  });

  test('a complete all-skipped Stage 1 records `empty`, never a pass or an incomplete run (D6)', async () => {
    const selection = await stage1Selection(store, issue);
    const skipped = run('files', { [A]: 'skipped' });
    const recorded = await recordRun(
      store,
      issue,
      'loop',
      buildTestStageRecord({ result: 'empty', suiteBindingDigest: SUITE_DIGEST, selection, run: skipped }),
      { identityRecheck: identity() },
    );
    expect(recorded.status).toBe('recorded');
    // The run really executed the selected file and credited nothing.
    expect(recorded.state.loopBundles.at(-1).testFiles).toMatchObject({
      result: 'empty',
      mode: 'files',
      outcomeCounts: { passed: 0, failed: 0, skipped: 1, notRun: 0 },
    });
    expect((await stateOf(store, issue)).retainedTestFiles).toBeUndefined();

    // Every other row its facts contradict stays refused.
    for (const result of ['passed', 'incomplete', 'no-evidence']) {
      const refused = await recordRun(
        store,
        issue,
        'loop',
        buildTestStageRecord({ result, suiteBindingDigest: SUITE_DIGEST, selection, run: skipped }),
      );
      expect([result, refused.status, refused.reason]).toEqual([result, 'refused', 'invalid_input']);
    }
  });

  test.each([
    ['failed files on untrusted outcomes', 'final', (record) => ({ ...record, trust: 'mismatched-files', outcomeCounts: undefined })],
    ['a Stage 1 selection on a Stage 2 run', 'final', (record, selection) => ({ ...record, selection })],
    ['a passed result with a failed file', 'final', (record) => ({ ...record, result: 'passed', processResult: 'succeeded' })],
    ['an empty result for Stage 2', 'final', (record) => ({ ...record, result: 'empty' })],
    ['a retained-unresolved result with nothing unresolved', 'loop', (record, selection) => ({ ...record, selection, mode: 'files', outcomeCounts: { passed: 0, failed: 1, skipped: 0, notRun: 0 }, failedFiles: [A], result: 'retained-unresolved' })],
    ['a failed file that was not selected', 'loop', (record, selection) => ({ ...record, selection, mode: 'files', outcomeCounts: { passed: 0, failed: 1, skipped: 0, notRun: 0 } })],
    ['an unsorted failed file list', 'final', (record) => ({ ...record, failedFiles: [C, B], outcomeCounts: { passed: 0, failed: 2, skipped: 0, notRun: 0 } })],
    // §2 failure evidence: bounded, run-artifact-relative, and only beside the run it describes.
    ['an output tail past the shipped bound', 'final', (record) => ({ ...record, outputTail: 'x'.repeat(5000) })],
    ['an empty output tail', 'final', (record) => ({ ...record, outputTail: '' })],
    ['a result artifact outside the run artifact directory', 'final', (record) => ({ ...record, resultArtifact: '../result.json' })],
    ['an absolute log artifact', 'final', (record) => ({ ...record, logArtifacts: [{ step: 'tests', artifact: '/tmp/tests.log' }] })],
    ['a log artifact recorded twice for one step', 'final', (record) => ({ ...record, logArtifacts: [{ step: 'tests', artifact: 'a.log' }, { step: 'tests', artifact: 'b.log' }] })],
    ['run evidence on a record that requested no run', 'final', (record) => ({ ...record, result: 'unavailable', mode: undefined, trust: undefined, processResult: undefined, outcomeCounts: undefined, failedFiles: [], resultArtifact: 'result.json' })],
    // R7 wins over R9: a trusted failed file beside a not-run one on a zero exit is `failed`.
    ['an incomplete result with a trusted failed file', 'final', (record) => ({ ...record, result: 'incomplete', processResult: 'succeeded', outcomeCounts: { passed: 0, failed: 1, skipped: 0, notRun: 1 } })],
    // §2: a run that did not end on its own has no process result, so none can route it as R6/R7.
    ...['deadline', 'interrupted', 'spawn-failure'].map((reason) => [
      `a failed process result under a ${reason}`,
      'final',
      (record) => ({ ...record, trust: reason, outcomeCounts: undefined, failedFiles: [] }),
    ]),
    // ...and a run that did end on its own must record one, or it would read as R9.
    ['trusted outcomes with no process result', 'final', (record) => ({ ...record, result: 'incomplete', processResult: undefined, outcomeCounts: { passed: 1, failed: 0, skipped: 0, notRun: 0 }, failedFiles: [] })],
    ['mismatched outcomes with no process result', 'final', (record) => ({ ...record, result: 'incomplete', trust: 'mismatched-files', processResult: undefined, outcomeCounts: undefined, failedFiles: [] })],
    // R8: a confirmed deadline is always `timed-out`, never an R9 run to recover automatically.
    ...['loop', 'final'].map((stage) => [
      `a deadline run recorded as incomplete (${stage})`,
      stage,
      (record, selection) => ({
        ...record,
        ...(stage === 'loop' ? { selection, mode: 'files' } : {}),
        result: 'incomplete',
        trust: 'deadline',
        processResult: undefined,
        outcomeCounts: undefined,
        failedFiles: [],
      }),
    ]),
  ])('refuses %s', async (_label, stage, mutate) => {
    const selection = await stage1Selection(store, issue);
    const base = buildTestStageRecord({
      result: 'failed',
      suiteBindingDigest: SUITE_DIGEST,
      selection: { status: 'full' },
      run: run('full', { [B]: 'failed' }),
    });
    const refused = await recordRun(store, issue, stage, mutate(base, selection));
    expect(refused).toMatchObject({ status: 'refused', reason: 'invalid_input' });
    expect((await stateOf(store, issue))?.retainedTestFiles).toBeUndefined();
  });
});

describe('read side — the block fails closed and the version guards a rollback', () => {
  test('obligations a reader cannot read refuse the read rather than reading as none', () => {
    const cases = [
      { version: 2, retainedTestFiles: [{ file: '/abs/b.test.js', addedBy: 'k' }] },
      { version: 2, retainedTestFiles: [{ file: B, addedBy: 'k' }, { file: B, addedBy: 'k2' }] },
      { version: 2, retainedTestFiles: [{ file: B }] },
      { version: 2, retainedTestFilesOverflowed: 'yes' },
      { version: 2, issueBase: { sha: 'abc', source: 'branch-start' } },
      { version: 2, issueBase: { sha: BASE, source: 'guess' } },
      { version: STAGED_VERIFICATION_STATE_VERSION + 1 },
    ];
    for (const block of cases) {
      expect(validateStagedVerificationState(block).valid).toBe(false);
    }
    const overflowed = validateStagedVerificationState({ version: 2, retainedTestFilesOverflowed: true });
    expect(overflowed.valid).toBe(true);
    expect(retainedTestFilesRead(overflowed.state)).toMatchObject({ kind: 'unreadable' });
  });

  test('a write stamps version 2 only once the block carries test-file state', async () => {
    const store = new MemoryTaskStore();
    const issue = await freshTask(store);
    const task = await store.getTask(issue);
    const allocated = await allocateStageRun({
      store,
      key: issue,
      observedTaskRevision: task.revision,
      requestKey: 'legacy-alloc',
      taskAttempt: 1,
      lane: 'implementation',
      stage: 'loop',
      identity: identity(),
    });
    expect(allocated.state.version).toBe(STAGED_VERIFICATION_LEGACY_STATE_VERSION);
    expect(allocated.state.issueBase).toBeUndefined();

    await passStage1(store, issue);
    expect((await store.getTask(issue)).context[STAGED_VERIFICATION_CONTEXT_KEY].version).toBe(
      STAGED_VERIFICATION_STATE_VERSION,
    );
  });
});

describe('Stage 1 evidence reuse — §8 invariant 1', () => {
  test('reusable only for the same identity, suite binding and selection', async () => {
    const store = new MemoryTaskStore();
    const issue = await freshTask(store);
    const { selection, recorded } = await passStage1(store, issue);
    const bundle = recorded.bundle;

    expect(
      evaluateStage1TestEvidenceReuse({ bundle, identity: identity(), suiteBindingDigest: SUITE_DIGEST, selection }),
    ).toEqual({ reusable: true, bundle });

    // A retained file joined the selection: the digest moved.
    const widened = selectStage1TestFiles({
      issueBase: { status: 'resolved', base: selection.issueBase, firstResolution: false },
      change: { kind: 'readable', base: BASE, entries: [{ path: A, change: 'modified' }] },
      inventory: INVENTORY,
      retained: { kind: 'readable', files: [{ file: B, addedBy: '1/review/final/0' }] },
    });
    const reasons = (decision) => decision.refusals.map((refusal) => refusal.reason);
    expect(reasons(evaluateStage1TestEvidenceReuse({ bundle, identity: identity(), suiteBindingDigest: SUITE_DIGEST, selection: widened }))).toEqual(['selection-changed']);

    // A new revision.
    expect(
      reasons(
        evaluateStage1TestEvidenceReuse({
          bundle,
          identity: identity({ testedRevision: { state: 'value', value: 'c'.repeat(40) } }),
          suiteBindingDigest: SUITE_DIGEST,
          selection,
        }),
      ),
    ).toEqual(['identity-mismatch']);

    // A changed suite binding, and an unavailable live selection.
    const otherSuite = deriveTestSuiteBindingDigest({ ...SUITE, setupCommand: 'npm run build' });
    expect(
      reasons(
        evaluateStage1TestEvidenceReuse({
          bundle,
          identity: identity({ selectionPolicyDigest: { state: 'value', value: otherSuite } }),
          suiteBindingDigest: otherSuite,
          selection: { status: 'unavailable', reason: 'runnable-file-report', detail: 'x' },
        }),
      ),
    ).toEqual(['suite-binding-changed', 'live-selection-unavailable', 'identity-mismatch']);
  });

  test('a bundle with no end-of-run identity recheck, or a moved one, is never reusable', async () => {
    const store = new MemoryTaskStore();
    const reasons = (decision) => decision.refusals.map((refusal) => refusal.reason);

    const unchecked = await freshTask(store);
    const missing = await passStage1(store, unchecked, [A], { identityRecheck: undefined });
    expect(missing.recorded.bundle.identityRecheck).toBeUndefined();
    expect(
      reasons(
        evaluateStage1TestEvidenceReuse({
          bundle: missing.recorded.bundle,
          identity: identity(),
          suiteBindingDigest: SUITE_DIGEST,
          selection: missing.selection,
        }),
      ),
    ).toEqual(['identity-recheck-missing']);

    // The revision moved during the run and came back: launch and live identities agree, the recheck does not.
    const moved = await freshTask(store);
    const drifted = await passStage1(store, moved, [A], {
      identityRecheck: identity({ testedRevision: { state: 'value', value: 'c'.repeat(40) } }),
    });
    expect(
      reasons(
        evaluateStage1TestEvidenceReuse({
          bundle: drifted.recorded.bundle,
          identity: identity(),
          suiteBindingDigest: SUITE_DIGEST,
          selection: drifted.selection,
        }),
      ),
    ).toEqual(['identity-recheck-mismatch']);
  });
});
