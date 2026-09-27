// Issue #1153 — Stage 1 changed-file selection, pure half
// (docs/changed-file-verification-contract.md §4.1, §4.2 and §2 invariant 1).
//
// Pins the selection law — Selected = (changed paths that are runnable test
// files) ∪ (retained files) — over hand-built reads: new, modified, renamed,
// deleted and non-test paths; a retained file that is runnable or gone; an
// Issue base resolved once and never recomputed; and every unreadable input
// (base, diff, runnable-file report, retained set) reading `unavailable`,
// never empty. The Git half is pinned in cumulative-test-change-git.test.js.
import {
  resolveIssueBase,
  selectStage1TestFiles,
  stage1ExecutionPlan,
  deriveTestFileSelectionDigest,
  deriveTestSuiteBindingDigest,
  readRetainedTestFileSet,
  nextRetainedTestFiles,
  MAX_RETAINED_TEST_FILES,
  MAX_STAGE_TEST_FILES,
  buildTestStageRecord,
  testStageRecordProblem,
} from '../dist/index.js';

const BASE = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const branchStartBase = { status: 'resolved', base: { sha: BASE, source: 'branch-start' }, firstResolution: true };

function change(entries, base = BASE) {
  return { kind: 'readable', base, entries: entries.map(([path, kind]) => ({ path, change: kind })) };
}

function inventory(files) {
  return { kind: 'readable', files };
}

function retained(files) {
  return { kind: 'readable', files: files.map((file) => ({ file, addedBy: '1/review/final/0' })) };
}

function select(overrides = {}) {
  return selectStage1TestFiles({
    issueBase: overrides.issueBase ?? branchStartBase,
    change: overrides.change ?? change([]),
    inventory: overrides.inventory ?? inventory(['test/a.test.js', 'test/b.test.js', 'test/c.test.js']),
    retained: overrides.retained ?? retained([]),
  });
}

const noBranchStart = () => {
  throw new Error('a recorded or dependency base must not read the branch start');
};

describe('resolveIssueBase — §4.1 rule 1', () => {
  test('a dependency-started Issue uses the recorded predecessor head', () => {
    const resolved = resolveIssueBase({
      dependencyBase: { base: { sha: OTHER.toUpperCase() }, missing: false },
      readBranchStart: noBranchStart,
    });
    expect(resolved).toEqual({
      status: 'resolved',
      base: { sha: OTHER, source: 'dependency-base' },
      firstResolution: true,
    });
  });

  test('without a dependency the branch start is read once, then the record wins', () => {
    const first = resolveIssueBase({
      dependencyBase: { missing: false },
      readBranchStart: () => ({ kind: 'readable', sha: BASE }),
    });
    expect(first).toEqual(branchStartBase);

    // The base branch moved and the branch start now reads differently: the
    // recorded base is never recomputed.
    const later = resolveIssueBase({
      recorded: first.base,
      dependencyBase: { missing: false },
      readBranchStart: noBranchStart,
    });
    expect(later).toEqual({ status: 'resolved', base: { sha: BASE, source: 'branch-start' }, firstResolution: false });
  });

  test('an unreadable branch start or an incomplete dependency base is unavailable', () => {
    expect(
      resolveIssueBase({
        dependencyBase: { missing: false },
        readBranchStart: () => ({ kind: 'unreadable', reason: 'no origin/main' }),
      }),
    ).toMatchObject({ status: 'unavailable', reason: 'branch_start_unreadable' });
    expect(
      resolveIssueBase({ dependencyBase: { missing: true }, readBranchStart: noBranchStart }),
    ).toMatchObject({ status: 'unavailable', reason: 'dependency_base_unresolved' });
    expect(
      resolveIssueBase({ dependencyBase: { base: { sha: 'abc123' }, missing: false }, readBranchStart: noBranchStart }),
    ).toMatchObject({ status: 'unavailable', reason: 'dependency_base_unresolved' });
  });

  test('an accepted predecessor update advances the base and declares what it replaces (D5)', () => {
    const advanced = resolveIssueBase({
      recorded: { sha: BASE, source: 'dependency-base' },
      dependencyBase: { base: { sha: OTHER, accepted: { sha: OTHER, evidence: 'stack-ready' } }, missing: false },
      readBranchStart: noBranchStart,
    });
    expect(advanced).toEqual({
      status: 'resolved',
      base: { sha: OTHER, source: 'dependency-base', advancedFrom: { sha: BASE, source: 'dependency-base' } },
      firstResolution: false,
    });

    // An unchanged head re-reports the recorded base, with no advance to apply.
    expect(
      resolveIssueBase({
        recorded: { sha: BASE, source: 'dependency-base' },
        dependencyBase: { base: { sha: BASE, accepted: { sha: BASE, evidence: 'stack-ready' } }, missing: false },
        readBranchStart: noBranchStart,
      }),
    ).toEqual({ status: 'resolved', base: { sha: BASE, source: 'dependency-base' }, firstResolution: false });
  });

  test('a head that moved without an acceptance of that exact commit never advances the base (D5)', () => {
    const unaccepted = [
      // A ref that moved, or a bare fetch: the recorded head changed, nothing accepted it.
      { base: { sha: OTHER }, missing: false },
      // An acceptance left behind by the previous head.
      { base: { sha: OTHER, accepted: { sha: BASE, evidence: 'stack-ready' } }, missing: false },
      // The dependency base disappeared entirely.
      { missing: false },
    ];
    for (const dependencyBase of unaccepted) {
      const blocked = resolveIssueBase({
        recorded: { sha: BASE, source: 'dependency-base' },
        dependencyBase,
        readBranchStart: noBranchStart,
      });
      expect(blocked).toMatchObject({ status: 'unavailable', reason: 'issue_base_changed' });
      expect(blocked.detail).toContain('only an accepted, recorded predecessor update advances the base');
    }
  });

  test('a base recorded as branch-start never advances, however well accepted the new head is (D5)', () => {
    // §4.1 rule 1: "A base this contract never resolved against a predecessor
    // never advances." Every selection so far counted the predecessor's files as
    // this Issue's own changes, so moving the base under them would silently drop
    // them from the cumulative set — the disagreement goes to an operator instead.
    const blocked = resolveIssueBase({
      recorded: { sha: BASE, source: 'branch-start' },
      dependencyBase: { base: { sha: OTHER, accepted: { sha: OTHER, evidence: 'stack-ready' } }, missing: false },
      readBranchStart: noBranchStart,
    });
    expect(blocked).toMatchObject({ status: 'unavailable', reason: 'issue_base_changed' });
    expect(blocked.detail).toContain('a base recorded as branch-start never advances onto a predecessor');
    // And a branch-start base with no dependency base at all still just stands.
    expect(
      resolveIssueBase({
        recorded: { sha: BASE, source: 'branch-start' },
        dependencyBase: { missing: false },
        readBranchStart: noBranchStart,
      }),
    ).toEqual({ status: 'resolved', base: { sha: BASE, source: 'branch-start' }, firstResolution: false });
  });

  test('an unavailable selection still carries the accepted advance, so the record can apply it', () => {
    const selection = selectStage1TestFiles({
      issueBase: resolveIssueBase({
        recorded: { sha: BASE, source: 'dependency-base' },
        dependencyBase: { base: { sha: OTHER, accepted: { sha: OTHER, evidence: 'stack-ready' } }, missing: false },
        readBranchStart: noBranchStart,
      }),
      change: { kind: 'unreadable', reason: 'no diff' },
      inventory: { kind: 'readable', files: [] },
      retained: { kind: 'readable', files: [] },
    });
    expect(selection).toMatchObject({
      status: 'unavailable',
      reason: 'cumulative-change',
      issueBase: { sha: OTHER, source: 'dependency-base', advancedFrom: { sha: BASE, source: 'dependency-base' } },
    });
  });
});

describe('selectStage1TestFiles — §4.2', () => {
  test('added, modified and untracked runnable test files are selected; source files are not', () => {
    const selection = select({
      change: change([
        ['src/x.ts', 'modified'],
        ['test/helpers/fixture.js', 'added'],
        ['test/b.test.js', 'modified'],
        ['test/a.test.js', 'added'],
      ]),
    });
    expect(selection).toMatchObject({
      status: 'known',
      issueBase: { sha: BASE, source: 'branch-start' },
      files: [
        { file: 'test/a.test.js', reasons: ['changed'] },
        { file: 'test/b.test.js', reasons: ['changed'] },
      ],
      unresolvedRetained: [],
    });
  });

  test('a rename selects only its new path, and a deletion selects nothing', () => {
    const selection = select({
      inventory: inventory(['test/renamed.test.js', 'test/c.test.js']),
      change: change([
        ['test/a.test.js', 'deleted'],
        ['test/renamed.test.js', 'added'],
        ['test/b.test.js', 'deleted'],
      ]),
    });
    expect(selection.files).toEqual([{ file: 'test/renamed.test.js', reasons: ['changed'] }]);
  });

  test('a changed test file the runnable-file report does not name is not selected', () => {
    // Incomplete inventory, as the contract reads it: the tooling is the only
    // authority on what is runnable, so an unlisted path is not a test file.
    const selection = select({
      inventory: inventory(['test/a.test.js']),
      change: change([['test/a.test.js', 'modified'], ['test/new.test.js', 'added']]),
    });
    expect(selection.files).toEqual([{ file: 'test/a.test.js', reasons: ['changed'] }]);
  });

  test('a retained file stays selected whether or not it changed', () => {
    const selection = select({
      change: change([['test/a.test.js', 'modified'], ['test/b.test.js', 'modified']]),
      retained: retained(['test/b.test.js', 'test/c.test.js']),
    });
    expect(selection.files).toEqual([
      { file: 'test/a.test.js', reasons: ['changed'] },
      { file: 'test/b.test.js', reasons: ['changed', 'retained'] },
      { file: 'test/c.test.js', reasons: ['retained'] },
    ]);
    expect(stage1ExecutionPlan(selection)).toEqual({
      kind: 'execute',
      request: { mode: 'files', files: ['test/a.test.js', 'test/b.test.js', 'test/c.test.js'] },
    });
  });

  test('a retained file that is no longer runnable is an explicit unresolved obligation that executes nothing', () => {
    const selection = select({
      inventory: inventory(['test/a.test.js', 'test/c.test.js']),
      change: change([['test/a.test.js', 'modified'], ['test/b.test.js', 'deleted']]),
      retained: retained(['test/b.test.js']),
    });
    expect(selection).toMatchObject({
      status: 'known',
      files: [{ file: 'test/a.test.js', reasons: ['changed'] }],
      unresolvedRetained: ['test/b.test.js'],
    });
    expect(stage1ExecutionPlan(selection)).toEqual({ kind: 'retained-unresolved', files: ['test/b.test.js'] });
  });

  test('an empty known selection never reaches execution', () => {
    const selection = select({ change: change([['src/x.ts', 'modified']]) });
    expect(selection).toMatchObject({ status: 'known', files: [], unresolvedRetained: [] });
    expect(stage1ExecutionPlan(selection)).toEqual({ kind: 'empty' });
  });

  test.each([
    [
      'the Issue base',
      { issueBase: { status: 'unavailable', reason: 'branch_start_unreadable', detail: 'no ref' } },
      'issue-base',
    ],
    ['the cumulative diff', { change: { kind: 'unreadable', reason: 'git diff failed' } }, 'cumulative-change'],
    ['a diff read against another base', { change: change([], OTHER) }, 'cumulative-change'],
    ['the runnable-file report', { inventory: { kind: 'unreadable', reason: 'discovery exited 1' } }, 'runnable-file-report'],
    ['a report naming a file twice', { inventory: inventory(['test/a.test.js', 'test/a.test.js']) }, 'runnable-file-report'],
    ['a report naming a non-id path', { inventory: inventory(['/abs/a.test.js']) }, 'runnable-file-report'],
    ['the retained set', { retained: { kind: 'unreadable', reason: 'overflowed' } }, 'retained-set'],
  ])('an unreadable %s is unavailable, never empty', (_label, overrides, reason) => {
    const selection = select({ change: change([['test/a.test.js', 'modified']]), ...overrides });
    expect(selection).toMatchObject({ status: 'unavailable', reason });
    expect(selection.files).toBeUndefined();
    expect(stage1ExecutionPlan(selection)).toEqual({ kind: 'unavailable', reason });
  });

  test('the selection is deterministic and its digest moves with base, membership, reason and obligation', () => {
    const inputs = {
      change: change([['test/b.test.js', 'modified'], ['test/a.test.js', 'modified']]),
      retained: retained(['test/c.test.js']),
    };
    const one = select(inputs);
    const two = select({ ...inputs, change: change([['test/a.test.js', 'modified'], ['test/b.test.js', 'modified']]) });
    expect(two).toEqual(one);
    expect(one.selectionDigest).toBe(deriveTestFileSelectionDigest(one));

    const digests = new Set([
      one.selectionDigest,
      select({ ...inputs, issueBase: { ...branchStartBase, base: { sha: OTHER, source: 'branch-start' } }, change: change([['test/b.test.js', 'modified'], ['test/a.test.js', 'modified']], OTHER) }).selectionDigest,
      select({ ...inputs, change: change([['test/a.test.js', 'modified']]) }).selectionDigest,
      select({ ...inputs, retained: retained(['test/c.test.js', 'test/a.test.js']) }).selectionDigest,
      select({ ...inputs, retained: retained(['test/c.test.js', 'test/gone.test.js']) }).selectionDigest,
    ]);
    expect(digests.size).toBe(5);
  });
});

describe('suite binding digest — §6 rule 5 configuration identity', () => {
  test('changes with the bound key, the resolved command and every adapter field', () => {
    const base = { key: 'test', command: 'npm test', adapter: 'jest' };
    const digests = new Set([
      deriveTestSuiteBindingDigest(base),
      deriveTestSuiteBindingDigest({ ...base, key: 'unit' }),
      deriveTestSuiteBindingDigest({ ...base, command: 'npm run test:ci' }),
      deriveTestSuiteBindingDigest({ ...base, setupCommand: 'npm run build' }),
      deriveTestSuiteBindingDigest({ ...base, argumentSeparator: '--' }),
      // Issue #1166: the declared Issue-requirement commands decide which
      // requirement a Stage 2 pass discharges, so they move the identity too.
      deriveTestSuiteBindingDigest({ ...base, requirementCommands: ['npm test'] }),
      deriveTestSuiteBindingDigest({ ...base, requirementCommands: ['npm test', 'make test'] }),
    ]);
    expect(digests.size).toBe(7);
    expect(deriveTestSuiteBindingDigest({ ...base })).toBe(deriveTestSuiteBindingDigest(base));
  });

  // A binding that declares nothing must keep the identity it already had, so
  // adding the field to the schema invalidates no evidence in flight.
  test('an absent declaration leaves the shipped digest untouched', () => {
    const base = { key: 'test', command: 'npm test', adapter: 'jest' };
    expect(deriveTestSuiteBindingDigest({ ...base, requirementCommands: undefined }))
      .toBe(deriveTestSuiteBindingDigest(base));
  });
});

describe('nextRetainedTestFiles — §4.3, pure', () => {
  const failedStage2 = (files, overrides = {}) => ({
    result: 'failed',
    suiteBindingDigest: 'd'.repeat(64),
    selection: { status: 'full' },
    mode: 'full',
    trust: 'trusted',
    processResult: 'failed',
    outcomeCounts: { passed: 3, failed: files.length, skipped: 0, notRun: 0 },
    failedFiles: files,
    ...overrides,
  });
  const empty = { files: [], overflowed: false };

  test('only a trusted failed Stage 2 adds, deduplicating and keeping the first run', () => {
    const once = nextRetainedTestFiles(empty, { stage: 'final', stageRunKey: 'k1', record: failedStage2(['test/b.test.js']) });
    expect(once.files).toEqual([{ file: 'test/b.test.js', addedBy: 'k1' }]);
    const twice = nextRetainedTestFiles(once, {
      stage: 'final',
      stageRunKey: 'k2',
      record: failedStage2(['test/a.test.js', 'test/b.test.js']),
    });
    expect(twice.files).toEqual([
      { file: 'test/b.test.js', addedBy: 'k1' },
      { file: 'test/a.test.js', addedBy: 'k2' },
    ]);

    expect(nextRetainedTestFiles(once, { stage: 'loop', stageRunKey: 'k3', record: failedStage2(['test/c.test.js']) })).toBe(once);
    expect(
      nextRetainedTestFiles(once, {
        stage: 'final',
        stageRunKey: 'k4',
        record: failedStage2([], { trust: 'unreadable-result', outcomeCounts: undefined }),
      }),
    ).toBe(once);
    expect(
      nextRetainedTestFiles(once, { stage: 'final', stageRunKey: 'k5', record: failedStage2(['test/c.test.js'], { result: 'stale' }) }),
    ).toBe(once);
  });

  test('past the bound nothing held is shed and the set reads unreadable for good', () => {
    const full = {
      files: Array.from({ length: MAX_RETAINED_TEST_FILES }, (_, i) => ({ file: `test/f${i}.test.js`, addedBy: 'k0' })),
      overflowed: false,
    };
    const next = nextRetainedTestFiles(full, { stage: 'final', stageRunKey: 'k1', record: failedStage2(['test/zz.test.js']) });
    expect(next.files).toHaveLength(MAX_RETAINED_TEST_FILES);
    expect(next.overflowed).toBe(true);
    expect(readRetainedTestFileSet(next)).toMatchObject({ kind: 'unreadable' });
    expect(readRetainedTestFileSet(full)).toEqual({ kind: 'readable', files: full.files });
  });

  test('a Stage 2 run failing more files than a record lists is recorded truncated and overflows the set', () => {
    const failing = Array.from({ length: MAX_STAGE_TEST_FILES + 1 }, (_, i) => `test/f${i}.test.js`).sort();
    const record = buildTestStageRecord({
      result: 'failed',
      suiteBindingDigest: 'd'.repeat(64),
      selection: { status: 'full' },
      run: {
        mode: 'full',
        trust: { status: 'trusted' },
        processResult: 'failed',
        files: failing.map((file) => ({ file, outcome: 'failed' })),
        failedFiles: failing,
        steps: [],
      },
    });
    expect(record.outcomeCounts).toEqual({ passed: 0, failed: MAX_STAGE_TEST_FILES + 1, skipped: 0, notRun: 0 });
    expect(record.failedFiles).toEqual(failing.slice(0, MAX_STAGE_TEST_FILES));
    expect(record.failedFilesTruncated).toBe(true);
    expect(testStageRecordProblem(record, 'r', 'final')).toBeUndefined();

    const next = nextRetainedTestFiles(empty, { stage: 'final', stageRunKey: 'k1', record });
    expect(next.files).toHaveLength(MAX_STAGE_TEST_FILES);
    expect(next.overflowed).toBe(true);
    expect(readRetainedTestFileSet(next)).toMatchObject({ kind: 'unreadable' });

    // The flag is honest or refused: never on a record that lists every failure.
    const listed = failedStage2(['test/b.test.js'], { failedFilesTruncated: true });
    expect(testStageRecordProblem(listed, 'r', 'final')).toMatch(/failedFilesTruncated/);
    expect(testStageRecordProblem({ ...record, failedFilesTruncated: false }, 'r', 'final')).toMatch(/failedFilesTruncated/);
    const { failedFilesTruncated: _dropped, ...unflagged } = record;
    expect(testStageRecordProblem(unflagged, 'r', 'final')).toMatch(/failed outcome/);
  });

  test('a Stage 1 whose discovery did not succeed records that process outcome, never trusted outcomes', () => {
    const unread = { status: 'unavailable', reason: 'runnable-file-report' };
    const discoveryFailed = buildTestStageRecord({
      result: 'failed',
      suiteBindingDigest: 'd'.repeat(64),
      selection: unread,
      run: {
        mode: 'files',
        trust: { status: 'untrusted', reason: 'unreadable-result', detail: 'the discovery command exited 1' },
        processResult: 'failed',
        files: [],
        failedFiles: [],
        steps: [],
        outputTail: 'config is broken',
      },
    });
    expect(testStageRecordProblem(discoveryFailed, 'r', 'loop')).toBeUndefined();
    const timedOut = { ...discoveryFailed, result: 'timed-out', trust: 'deadline' };
    delete timedOut.processResult;
    expect(testStageRecordProblem(timedOut, 'r', 'loop')).toBeUndefined();

    // No other unavailable reason, no Stage 2 and no trusted outcome carries a run.
    expect(testStageRecordProblem({ ...discoveryFailed, selection: { status: 'unavailable', reason: 'retained-set' } }, 'r', 'loop'))
      .toMatch(/a files run needs/);
    expect(testStageRecordProblem(discoveryFailed, 'r', 'final')).toMatch(/a files run needs/);
    expect(testStageRecordProblem({ ...discoveryFailed, trust: 'trusted' }, 'r', 'loop')).toMatch(/no trusted outcomes/);
    // Without the run, the unavailable selection is R2 again.
    const { mode: _mode, trust: _trust, processResult: _process, outputTail: _tail, ...noRun } = discoveryFailed;
    expect(testStageRecordProblem(noRun, 'r', 'loop')).toMatch(/for an unavailable selection/);
  });
});
