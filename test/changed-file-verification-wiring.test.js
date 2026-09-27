// Issue #1154 — changed-file / full-suite verification wired into the lanes
// (docs/changed-file-verification-contract.md §5, §6 rule 2, §7's trace).
//
// A real git repository and a fake Jest (a Node script speaking Jest's
// `--listTests --json` and `--json --outputFile` protocol) run through the real
// #1152 Jest adapter and the shipped command runner. The implementation lane's
// verification moment is `runStage1TestVerification` — the call the
// implementation handler makes — and the review lane is the real review
// handler: Step 4's non-test checks and Stage 1, the (faked) reviewer, and the
// final stage's Stage 2. Only network-facing commands (gh, fetch, pull,
// ls-remote) and the reviewer CLI are answered by the test.

import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { createReviewHandler } from '../dist/handlers/review.js';
import { createConflictResolutionHandler } from '../dist/handlers/conflict-resolution.js';
import { createImplementationHandler } from '../dist/handlers/implementation.js';
import { defaultCommandRunner } from '../dist/handlers/command-runner.js';
import { NO_DEPENDENCY_BASE, runStage1TestVerification, withStage1ContextPatch } from '../dist/handlers/test-stage-verification.js';
import { runFinalStageVerification } from '../dist/handlers/stage-verification.js';
import { decideStackReadyPublication, readFinalStageApprovalContinuation } from '../dist/core/final-stage-gate.js';
import { VERIFICATION_AMENDMENTS_CONTEXT_KEY } from '../dist/core/verification-amendment.js';
import { buildVerificationSessionBaseline, resolveEffectiveVerificationPlan } from '../dist/core/verification-plan.js';

const FAKE_JEST = String.raw`
const { readdirSync, readFileSync, writeFileSync } = require('fs');
const { join, resolve } = require('path');
const args = process.argv.slice(2);
const cwd = process.cwd();
const all = () => readdirSync(join(cwd, 'tests')).filter((f) => f.endsWith('.test.cjs')).sort().map((f) => resolve(cwd, 'tests', f));
if (args.includes('--listTests')) {
  process.stdout.write(JSON.stringify(all()) + '\n');
  process.exit(0);
}
const out = args.find((a) => a.startsWith('--outputFile=')).slice('--outputFile='.length);
const at = args.indexOf('--runTestsByPath');
const files = at === -1 ? all() : args.slice(at + 1);
// A marker a test's non-test check can read to fail only after the full suite ran.
if (at === -1) writeFileSync(join(cwd, '.git', 'full-suite-ran'), '');
const calc = readFileSync(join(cwd, 'src', 'calc.cjs'), 'utf8');
const testResults = files.map((name) => {
  const text = readFileSync(name, 'utf8');
  // A file marked SKIP reports Jest's all-pending shape: the adapter reads it as
  // a skip, which is never merged with a pass (contract §2 invariant 2).
  // (No backticks here: this script is the body of a String.raw template.)
  if (text.includes('SKIP')) return { name, status: 'skipped', assertionResults: [{ status: 'pending' }] };
  const failed = text.includes('FAIL') || (text.includes('CHECKS_CALC') && calc.includes('broken'));
  return { name, status: failed ? 'failed' : 'passed', assertionResults: [{ status: failed ? 'failed' : 'passed' }] };
});
writeFileSync(out, JSON.stringify({ numTotalTestSuites: files.length, testResults, wasInterrupted: false }));
process.exit(testResults.some((r) => r.status === 'failed') ? 1 : 0);
`;

const SESSION_ID = 'wiring';
const BRANCH = 'ai/issue-7';

let tmpDir;
let repo;
let artifactRoot;

function git(args) {
  return execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], {
    cwd: repo,
    encoding: 'utf8',
  });
}
const write = (relative, text) => writeFileSync(join(repo, relative), text);
const commit = (message) => {
  git(['add', '-A']);
  git(['commit', '-q', '-m', message]);
};
const head = () => git(['rev-parse', 'HEAD']).trim();

beforeEach(() => {
  requirementCommands = undefined;
  tmpDir = mkdtempSync(join(tmpdir(), 'changed-file-wiring-'));
  repo = join(tmpDir, 'repo');
  artifactRoot = join(tmpDir, 'artifacts');
  mkdirSync(artifactRoot, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  for (const dir of ['src', 'tests', 'tools']) mkdirSync(join(repo, dir));
  write('tools/fake-jest.cjs', FAKE_JEST);
  write('tools/lint.cjs', 'process.exit(0);\n');
  write('src/calc.cjs', 'module.exports = 1;\n');
  write('tests/a.test.cjs', '// A\n');
  write('tests/b.test.cjs', '// B CHECKS_CALC\n');
  write('tests/c.test.cjs', '// C\n');
  commit('fixture');
  // The base branch as origin knows it, without a remote: Stage 1 reads the
  // branch start from `refs/remotes/origin/main` and never fetches.
  git(['update-ref', 'refs/remotes/origin/main', head()]);
  git(['checkout', '-q', '-b', BRANCH]);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// Issue #1166: the operator's declaration that the bound entry discharges an
// Issue requirement spelled differently. Absent by default, so every test above
// runs the shipped binding; a test that needs it assigns before calling a lane.
let requirementCommands;

const session = () => ({
  sessionId: SESSION_ID,
  repoKey: 'wiring',
  repoRoot: repo,
  githubRepo: 'org/wiring',
  artifactDir: '.artifacts',
  artifactRoot,
  githubOwner: 'org',
  githubName: 'wiring',
  defaults: { implementationAgent: 'claude', reviewAgent: 'codex' },
  verification: { lint: 'node tools/lint.cjs', test: 'node tools/fake-jest.cjs' },
  stagedVerification: {
    enabled: true,
    testSuite: {
      test: {
        adapter: 'jest',
        ...(requirementCommands !== undefined ? { requirementCommands } : {}),
      },
    },
  },
  labels: { active: 'ai:active', blocked: 'ai:blocked', readyForHuman: 'ai:ready-for-human' },
});

const PR_VIEW = JSON.stringify({
  number: 9, url: 'https://github.com/org/wiring/pull/9', headRefName: BRANCH, baseRefName: 'main', state: 'OPEN', isCrossRepository: false,
});

/** Real git and node; the network and the reviewer are answered here. Every call is traced. */
function hybridRunner(trace, { reviewer = 'No P1/P2 findings.' } = {}) {
  const ok = (stdout = '') => ({ stdout, stderr: '', exitCode: 0 });
  return {
    run(cmd, args, opts) {
      const entry = { cmd, args: [...args] };
      trace.push(entry);
      // `gh pr list` answers a JSON array; every other `gh` read answers the PR itself.
      if (cmd === 'gh') return ok(args[0] === 'pr' && args[1] === 'list' ? `[${PR_VIEW}]` : PR_VIEW);
      if (cmd === 'codex') return ok(reviewer);
      if (cmd === 'git') {
        const sub = args[0];
        if (sub === 'fetch' || sub === 'pull' || sub === 'reset' || sub === 'clean') return ok();
        if (sub === 'rev-parse' && args[1] === '--verify') return ok(BRANCH);
        if (sub === 'rev-list') return ok('0');
        if (sub === 'ls-remote') return ok(`${head()}\t${args[2]}\n`);
        return defaultCommandRunner.run(cmd, args, opts);
      }
      if (cmd === 'node') return defaultCommandRunner.run(cmd, args, opts);
      return ok();
    },
  };
}

/** What each fake-Jest invocation in a trace asked for: `discovery`, `full`, or the selected basenames. */
const testRuns = (trace) =>
  trace
    .filter((call) => call.cmd === 'node' && call.args[0] === 'tools/fake-jest.cjs')
    .map((call) => {
      if (call.args.includes('--listTests')) return 'discovery';
      const at = call.args.indexOf('--runTestsByPath');
      return at === -1 ? 'full' : call.args.slice(at + 1).map((file) => file.split('/').pop()).join('+');
    });

const reviewerIndex = (trace) => trace.findIndex((call) => call.cmd === 'codex');
const fullRunIndexes = (trace) =>
  trace.flatMap((call, index) =>
    call.cmd === 'node' && call.args[0] === 'tools/fake-jest.cjs' && !call.args.includes('--listTests')
      && !call.args.includes('--runTestsByPath') ? [index] : []);

const baseTask = (context = {}) => ({
  sessionId: SESSION_ID,
  issueNumber: 7,
  revision: 0,
  status: 'running',
  phase: 'implementation',
  priority: 'normal',
  reviewAgent: 'codex',
  attempts: {},
  context: {
    title: 'wiring fixture',
    prUrl: 'https://github.com/org/wiring/pull/9',
    branch: BRANCH,
    labels: [],
    ...context,
  },
  createdAt: '2026-09-17T00:00:00.000Z',
  updatedAt: '2026-09-17T00:00:00.000Z',
});

async function implementationStage1(task, runId, trace, lane = 'implementation') {
  return runStage1TestVerification({
    runner: hybridRunner(trace),
    session: session(),
    task,
    cwd: repo,
    lane,
    taskAttempt: 0,
    runId,
    baseBranch: 'main',
    artifactDir: artifactRoot,
  });
}

async function review(task, runId, trace, options) {
  const handler = createReviewHandler(
    { session: session(), runId, workerId: 'w1' },
    hybridRunner(trace, options),
    (input) => ({ ok: true, path: repo, worktreeId: `${input.sessionId}/issue-${input.issueNumber}`, branch: input.branch, created: false, branchReused: true }),
    {
      acquire: () => ({ ok: true, locked: true, contextId: runId, sessionId: SESSION_ID }),
      release: () => ({ ok: true, released: true }),
    },
  );
  return handler({ ...task, phase: 'review' });
}

const merged = (task, result) => ({ ...task, context: { ...task.context, ...result.context } });

describe('changed A → full B failure → changed A+B → full success → stack-ready', () => {
  test('real review wiring runs the full suite only after approval, retains B, and grants on the second pass', async () => {
    // 1. Implementation: A and a source file change; Stage 1 runs exactly [A].
    write('src/calc.cjs', 'module.exports = "broken";\n');
    write('tests/a.test.cjs', '// A changed\n');
    const implTrace1 = [];
    let task = baseTask();
    const impl1 = await implementationStage1(task, 'run-impl-1', implTrace1);
    expect(impl1.route).toBe('continue');
    expect(impl1.record.result).toBe('passed');
    expect(testRuns(implTrace1)).toEqual(['discovery', 'a.test.cjs']);
    task = merged(task, { context: impl1.contextPatch });
    commit('H1');

    // 2+3. Review at H1: Stage 1 [A] passes, the reviewer approves, Stage 2 runs
    //      the full suite and B fails. B is retained; the task returns to repair.
    const reviewTrace1 = [];
    const rejected = await review(task, 'run-review-1', reviewTrace1);
    expect(rejected.result).toBe('needs_fix');
    expect(testRuns(reviewTrace1)).toEqual(['discovery', 'a.test.cjs', 'discovery', 'full']);
    expect(fullRunIndexes(reviewTrace1).every((index) => index > reviewerIndex(reviewTrace1))).toBe(true);
    expect(rejected.context.stagedVerification.retainedTestFiles.map((entry) => entry.file)).toEqual(['tests/b.test.cjs']);
    expect(rejected.context.reviewFeedback).toContain('tests/b.test.cjs');
    expect(rejected.context.finalStageGrant).toBeNull();
    task = merged(task, rejected);

    // 4. Implementation fixes the source; Stage 1 runs A (changed) and B (retained).
    write('src/calc.cjs', 'module.exports = 2;\n');
    const implTrace2 = [];
    const impl2 = await implementationStage1(task, 'run-impl-2', implTrace2);
    expect(impl2.route).toBe('continue');
    expect(testRuns(implTrace2)).toEqual(['discovery', 'a.test.cjs+b.test.cjs']);
    expect(impl2.record.selection.files).toEqual([
      { file: 'tests/a.test.cjs', reasons: ['changed'] },
      { file: 'tests/b.test.cjs', reasons: ['retained'] },
    ]);
    task = merged(task, { context: impl2.contextPatch });
    commit('H2');

    // 5+6. Review at H2: Stage 1 [A, B], approval, Stage 2 full passes, grant.
    const reviewTrace2 = [];
    const approved = await review(task, 'run-review-2', reviewTrace2);
    expect(approved.result).toBe('success');
    expect(testRuns(reviewTrace2)).toEqual(['discovery', 'a.test.cjs+b.test.cjs', 'discovery', 'full']);
    expect(fullRunIndexes(reviewTrace2).every((index) => index > reviewerIndex(reviewTrace2))).toBe(true);
    expect(approved.context.finalStageGrant).toMatchObject({ runId: 'run-review-2', headSha: head() });
    expect(
      decideStackReadyPublication({ stagedVerification: session().stagedVerification, context: merged(task, approved).context, runId: 'run-review-2' }),
    ).toMatchObject({ kind: 'grant' });
    // A retained file stays retained after it passes.
    expect(approved.context.stagedVerification.retainedTestFiles.map((entry) => entry.file)).toEqual(['tests/b.test.cjs']);
    // Stage 2 runs the suite before its non-test check, and the bundle records both in that order.
    const lintIndexes = reviewTrace2.flatMap((call, index) => (call.cmd === 'node' && call.args[0] === 'tools/lint.cjs' ? [index] : []));
    expect(lintIndexes.at(-1)).toBeGreaterThan(fullRunIndexes(reviewTrace2).at(-1));
    const grantBundle = approved.context.stagedVerification.finalBundles.at(-1);
    expect(grantBundle.checks.map((check) => check.checkId)).toEqual(['exec:test', 'exec:lint']);
    expect(grantBundle.selection.checkIds).toEqual(['exec:test', 'exec:lint']);

    // A re-delivered approval at H2 reuses the granting bundle, runs nothing, and
    // still reports the Stage 2 pass that grant stands on.
    const reuseTrace = [];
    const reused = await runFinalStageVerification({
      runner: hybridRunner(reuseTrace),
      session: session(),
      task: merged(task, approved),
      cwd: repo,
      runId: 'run-review-3',
      taskAttempt: 0,
      artifactDir: artifactRoot,
    });
    expect(reused).toMatchObject({ status: 'recorded', reused: true, granted: true, testStage: { result: 'passed' } });
    expect(reused.context.finalStageVerification.testStage).toMatchObject({ result: 'passed' });
    expect(testRuns(reuseTrace)).toEqual([]);
  }, 60_000);
});

// Issue #1165, decision D5. The predecessor's own test files must never become
// this Issue's changes, but the base may move only on an accepted, recorded
// predecessor update — never on a ref that merely moved.
describe('the Issue base after a dependency update', () => {
  const dependencyBase = (sha, acceptedSha) => ({
    dependencyBase: {
      baseIssueNumber: 5,
      basePrNumber: 6,
      baseHeadRefName: 'ai/issue-5',
      basePrUrl: 'https://github.com/org/wiring/pull/6',
      baseHeadSha: sha,
      ...(acceptedSha !== undefined ? { baseHeadAccepted: { sha: acceptedSha, evidence: 'stack-ready' } } : {}),
    },
  });

  /** Predecessor v1, predecessor v2 (each adding its own test file), then this Issue's own change. */
  function stackedHistory() {
    write('tests/pred.test.cjs', '// PRED v1\n');
    commit('predecessor v1');
    const p1 = head();
    write('tests/pred2.test.cjs', '// PRED v2\n');
    commit('predecessor v2');
    const p2 = head();
    write('tests/a.test.cjs', '// A changed\n');
    commit('this issue');
    return { p1, p2 };
  }

  test('an accepted predecessor update advances the base, keeps retained files and invalidates old evidence', async () => {
    const { p1, p2 } = stackedHistory();

    // Stage 1 at the old base: the predecessor's v2 test file is inside this
    // Issue's cumulative diff, so it is selected as one of its changes.
    const traceBefore = [];
    let task = baseTask(dependencyBase(p1, p1));
    const before = await implementationStage1(task, 'run-d5-before', traceBefore, 'review');
    expect(before.record.result).toBe('passed');
    expect(before.record.selection.issueBase).toEqual({ sha: p1, source: 'dependency-base' });
    expect(before.record.selection.files.map((entry) => entry.file))
      .toEqual(['tests/a.test.cjs', 'tests/pred2.test.cjs']);
    expect(testRuns(traceBefore)).toEqual(['discovery', 'a.test.cjs+pred2.test.cjs']);

    // An earlier Stage 2 failure left B retained; the advance must not drop it.
    const carried = {
      ...before.contextPatch.stagedVerification,
      retainedTestFiles: [{ file: 'tests/b.test.cjs', addedBy: 'review:final:0:0' }],
    };
    task = merged(task, { context: { stagedVerification: carried, ...dependencyBase(p2, p2) } });

    // The dependency flow incorporated and recorded the newly accepted head.
    const traceAfter = [];
    const after = await implementationStage1(task, 'run-d5-after', traceAfter, 'implementation');
    expect(after.record.result).toBe('passed');
    // The base moved, and the record declares exactly which base it replaced.
    expect(after.record.selection.issueBase).toEqual({
      sha: p2,
      source: 'dependency-base',
      advancedFrom: { sha: p1, source: 'dependency-base' },
    });
    // The predecessor's own test file is now below the base: not this Issue's change.
    expect(after.record.selection.files).toEqual([
      { file: 'tests/a.test.cjs', reasons: ['changed'] },
      { file: 'tests/b.test.cjs', reasons: ['retained'] },
    ]);
    expect(testRuns(traceAfter)).toEqual(['discovery', 'a.test.cjs+b.test.cjs']);

    const state = after.contextPatch.stagedVerification;
    // The persisted base is the new head, and it keeps no advance of its own.
    expect(state.issueBase).toEqual({ sha: p2, source: 'dependency-base' });
    // The obligation is the Issue's, not a revision's: it survives untouched.
    expect(state.retainedTestFiles).toEqual([{ file: 'tests/b.test.cjs', addedBy: 'review:final:0:0' }]);
    // Every stage result recorded against the old base is gone — the review
    // lane's bundle would otherwise still be held beside the new one.
    expect(state.loopBundles).toHaveLength(1);
    expect(state.loopBundles[0].stageRunId.lane).toBe('implementation');
    expect(state.grantingStageRunKey).toBeUndefined();
    expect(after.detail).toContain('The Issue base advanced to the accepted predecessor head');
  }, 60_000);

  test('a head that moved with no acceptance of that exact commit never advances the base', async () => {
    const { p1, p2 } = stackedHistory();
    const first = await implementationStage1(baseTask(dependencyBase(p1, p1)), 'run-d5-pin', [], 'review');
    expect(first.record.result).toBe('passed');
    const recorded = first.contextPatch.stagedVerification;
    expect(recorded.issueBase).toEqual({ sha: p1, source: 'dependency-base' });

    // Three ways the recorded head can differ without an accepted update: a ref
    // that moved under a stale acceptance, pre-#1165 metadata with none at all,
    // and an acceptance for a head nobody recorded.
    const cases = [
      ['a fetched ref under a stale acceptance', dependencyBase(p2, p1)],
      ['pre-#1165 metadata with no acceptance', dependencyBase(p2)],
      ['an acceptance for another commit', dependencyBase(p2, head())],
    ];
    for (const [index, [label, base]] of cases.entries()) {
      const trace = [];
      const task = merged(baseTask(), { context: { stagedVerification: recorded, ...base } });
      const blocked = await implementationStage1(task, `run-d5-moved-${index}`, trace, 'implementation');
      expect([label, blocked.record.result]).toEqual([label, 'unavailable']);
      expect([label, blocked.record.selection]).toEqual([label, { status: 'unavailable', reason: 'issue-base' }]);
      // Nothing launched, and the recorded base stands.
      expect([label, testRuns(trace)]).toEqual([label, []]);
      expect([label, blocked.contextPatch.stagedVerification.issueBase])
        .toEqual([label, { sha: p1, source: 'dependency-base' }]);
      // A non-code result re-runs under the bounded budget; it never re-bases.
      expect([label, blocked.route]).toEqual([label, 'rerun']);
    }
  }, 60_000);

  /** A durable-store stand-in: every write lands where the next read sees it. */
  const memoryStore = (task) => {
    const box = { current: task };
    return {
      box,
      getTask: async () => box.current,
      completePhaseWithEffects: async (transition) => {
        box.current = {
          ...box.current,
          revision: box.current.revision + 1,
          context: { ...(box.current.context ?? {}), ...(transition.patch.context ?? {}) },
        };
        return { ok: true, value: box.current };
      },
    };
  };

  const storedStage1 = (store, task, runId, accepted, trace = []) =>
    runStage1TestVerification({
      runner: hybridRunner(trace),
      session: session(),
      task,
      cwd: repo,
      lane: 'implementation',
      taskAttempt: 0,
      runId,
      baseBranch: 'main',
      artifactDir: artifactRoot,
      store,
      ...(accepted !== undefined ? { dependencyBase: accepted } : {}),
    });

  /** The stored row at the old base: what a run reads while it is incorporating the new one. */
  const atOldBase = async (p1, runId, extraContext = {}) => {
    const seeded = baseTask({ ...dependencyBase(p1, p1), ...extraContext });
    const seed = await implementationStage1(seeded, runId, [], 'review');
    expect(seed.record.selection.issueBase).toEqual({ sha: p1, source: 'dependency-base' });
    return merged(seeded, { context: { stagedVerification: seed.contextPatch.stagedVerification } });
  };

  // Issue #1165 review, P1. The implementation lane resolves the accepted
  // predecessor head while it materializes the branch and persists it only in
  // its final completion — Stage 1 runs in between. Reading the stored
  // `dependencyBase` there would select against the base the run has already
  // left: the predecessor test added between the two heads would count as this
  // Issue's change, and a failure in it could never clear, since the run exits
  // before the accepted head is ever written.
  test('the base the run accepted wins over the one the stored task still names', async () => {
    const { p1, p2 } = stackedHistory();
    const stored = await atOldBase(p1, 'run-d5-live-seed');
    const store = memoryStore(stored);
    const trace = [];

    const run = await storedStage1(store, stored, 'run-d5-live', dependencyBase(p2, p2).dependencyBase, trace);

    expect(run.record.result).toBe('passed');
    // The durable row still names `p1`; the run's own accepted head is the base.
    expect(store.box.current.context.dependencyBase.baseHeadSha).toBe(p1);
    expect(run.record.selection.issueBase).toEqual({
      sha: p2,
      source: 'dependency-base',
      advancedFrom: { sha: p1, source: 'dependency-base' },
    });
    // The predecessor's own test file sits below the new base: never selected,
    // never run.
    expect(run.record.selection.files).toEqual([{ file: 'tests/a.test.cjs', reasons: ['changed'] }]);
    expect(testRuns(trace)).toEqual(['discovery', 'a.test.cjs']);
    expect(store.box.current.context.stagedVerification.issueBase).toEqual({ sha: p2, source: 'dependency-base' });
  }, 60_000);

  // Issue #1165 review, P1. A non-fix rerun of an Issue whose blocker has since
  // closed resolves a plan that names no predecessor, and the same run's
  // completion clears the recorded `dependencyBase`. Falling back to the stored
  // value here would let Stage 1 pass against a predecessor the run is about to
  // erase, leaving a persisted `dependency-base` Issue base that no later run
  // can resolve — `issue_base_changed` for every review from then on. The
  // resolved absence is stated instead, so the mismatch surfaces now.
  test('a run that resolved no predecessor states that, instead of reading the stored one', async () => {
    const { p1 } = stackedHistory();
    const stored = await atOldBase(p1, 'run-d5-none-seed');

    const store = memoryStore(stored);
    const trace = [];
    const run = await storedStage1(store, stored, 'run-d5-none', NO_DEPENDENCY_BASE, trace);

    // No pass is claimed against a base this run no longer has.
    expect(run.record.result).toBe('unavailable');
    expect(run.record.selection).toEqual({ status: 'unavailable', reason: 'issue-base' });
    expect(testRuns(trace)).toEqual([]);
    expect(run.route).toBe('rerun');
    // And the recorded base is left exactly as it was: nothing re-bases here.
    expect(store.box.current.context.stagedVerification.issueBase).toEqual({ sha: p1, source: 'dependency-base' });

    // Omitting the override is the fix-mode fallback — a repair run never
    // re-resolves a plan and never clears the recorded `dependencyBase`, so it
    // keeps selecting against it.
    const fallback = memoryStore(stored);
    const repair = await storedStage1(fallback, stored, 'run-d5-none-fallback');
    expect(repair.record.result).toBe('passed');
    expect(repair.record.selection.issueBase).toEqual({ sha: p1, source: 'dependency-base' });
  }, 60_000);

  // Issue #1165 review, P1. The approval a final stage left waiting is a
  // top-level continuation bound to the approved head, outside the staged
  // block. An accepted head that was already an ancestor moves no branch head,
  // so it would still bind after the advance — and the review lane, which reads
  // it before Stage 1 and matches on the head alone, would skip the reviewer
  // and run Stage 2 under the approval of the base that no longer exists.
  test('an advance evicts the pending approval, so the review lane reviews the re-based revision again', async () => {
    const { p1, p2 } = stackedHistory();
    const approval = {
      headSha: head(),
      approval: { classification: { classification: 'success', reason: 'ok' }, findingsContext: {} },
    };
    const stored = await atOldBase(p1, 'run-d5-approval-seed', { finalStageApproval: approval });

    // No advance: the continuation is the review lane's to consume, untouched.
    const held = memoryStore(stored);
    const unchanged = await storedStage1(held, stored, 'run-d5-approval-held');
    expect(unchanged.record.result).toBe('passed');
    expect('finalStageApproval' in unchanged.contextPatch).toBe(false);
    // Still binding at the live head — which is exactly why an advance must
    // drop it rather than rely on the head having moved.
    expect(readFinalStageApprovalContinuation(held.box.current.context.finalStageApproval, head()))
      .toEqual({ headSha: head(), approval: approval.approval });

    // The same Stage 1, now incorporating the accepted predecessor update.
    const advanced = memoryStore(stored);
    const run = await storedStage1(advanced, stored, 'run-d5-approval-advance', dependencyBase(p2, p2).dependencyBase);
    expect(run.record.selection.issueBase.advancedFrom).toEqual({ sha: p1, source: 'dependency-base' });
    // Cleared by the same write that evicted the evidence, and carried by the
    // patch a lane with no durable store persists.
    expect(advanced.box.current.context.finalStageApproval).toBeNull();
    expect(run.contextPatch.finalStageApproval).toBeNull();

    // The real review lane over the re-based revision: no approval to resume,
    // so the reviewer runs again before anything can grant.
    const trace = [];
    const task = {
      ...advanced.box.current,
      context: { ...advanced.box.current.context, ...dependencyBase(p2, p2) },
    };
    const result = await review(task, 'run-d5-approval-review', trace);
    expect(result.result).toBe('success');
    expect(reviewerIndex(trace)).not.toBe(-1);
  }, 60_000);
});

describe('the full gate cannot be bypassed', () => {
  test('a review rejection never runs the full suite and never grants', async () => {
    write('tests/a.test.cjs', '// A changed\n');
    commit('H1');
    const trace = [];
    const result = await review(baseTask(), 'run-review-reject', trace, { reviewer: '[P1] Missing null check' });
    expect(result.result).toBe('needs_fix');
    expect(fullRunIndexes(trace)).toEqual([]);
    expect(result.context.finalStageGrant).toBeUndefined();
    // With no durable store the completion is the only copy of the passing Stage 1.
    expect(result.context.stagedVerification.runs.map((entry) => entry.state)).toEqual(['recorded']);
    expect(result.context.stagedVerification.loopBundles.at(-1).testFiles.result).toBe('passed');
  }, 30_000);

  test('a context-only Stage 1 patch rides every exit without overwriting a newer state', () => {
    const claimed = { runs: [] };
    const patch = { stagedVerification: { runs: [{ state: 'recorded' }] } };
    const task = baseTask({ stagedVerification: claimed, other: 1 });
    expect(withStage1ContextPatch(task, { result: 'blocked', context: { a: 1 } }, patch).context)
      .toEqual({ a: 1, ...patch });
    expect(withStage1ContextPatch(task, { result: 'delayed', context: { ...task.context } }, patch).context.stagedVerification)
      .toBe(patch.stagedVerification);
    expect(withStage1ContextPatch(task, { result: 'delayed' }, patch).context).toMatchObject({ other: 1, ...patch });
    const newer = { runs: [{ state: 'recorded' }, { state: 'allocated' }] };
    expect(withStage1ContextPatch(task, { result: 'success', context: { stagedVerification: newer } }, patch).context.stagedVerification)
      .toBe(newer);
    const untouched = { result: 'success', context: { a: 1 } };
    expect(withStage1ContextPatch(task, untouched, {})).toBe(untouched);
  });

  test('an empty Stage 1 still needs Stage 2 before the grant', async () => {
    write('src/calc.cjs', 'module.exports = 3;\n');
    commit('source only');
    const trace = [];
    const result = await review(baseTask(), 'run-review-empty', trace);
    expect(testRuns(trace)).toEqual(['discovery', 'discovery', 'full']);
    expect(result.result).toBe('success');
    expect(result.context.stagedVerification.loopBundles.at(-1).testFiles.result).toBe('empty');
  }, 30_000);

  // Issue #1165, decision D6: a complete Stage 1 that skipped every selected
  // file executed no test. It is `empty`, never `passed`, so it reaches review
  // and then MUST run Stage 2 — and Stage 2's own all-skipped run parks.
  test('a Stage 1 that skips every selected file is `empty`: review runs, then a mandatory Stage 2', async () => {
    write('tests/a.test.cjs', '// A SKIP\n');
    commit('A is skipped');
    const trace = [];
    const result = await review(baseTask(), 'run-review-skip-stage1', trace);
    expect(testRuns(trace)).toEqual(['discovery', 'a.test.cjs', 'discovery', 'full']);
    // The reviewer ran (D6 allows code review), and Stage 2 ran after it.
    expect(reviewerIndex(trace)).toBeGreaterThan(-1);
    expect(fullRunIndexes(trace).every((index) => index > reviewerIndex(trace))).toBe(true);
    const stage1 = result.context.stagedVerification.loopBundles.at(-1).testFiles;
    expect(stage1.result).toBe('empty');
    // The run really executed: the selection is non-empty and every outcome is a skip.
    expect(stage1.mode).toBe('files');
    expect(stage1.selection.files).toEqual([{ file: 'tests/a.test.cjs', reasons: ['changed'] }]);
    expect(stage1.outcomeCounts).toEqual({ passed: 0, failed: 0, skipped: 1, notRun: 0 });
    // Only Stage 2 satisfies the full suite, and it did.
    expect(result.result).toBe('success');
    expect(result.context.finalStageVerification.testStage).toMatchObject({ result: 'passed' });
  }, 30_000);

  test('a Stage 2 that skips everything is `no-evidence`: it parks and is never repeated', async () => {
    for (const name of ['a', 'b', 'c']) write(`tests/${name}.test.cjs`, `// ${name.toUpperCase()} SKIP\n`);
    commit('every test is skipped');
    const trace = [];
    const result = await review(baseTask(), 'run-review-skip-stage2', trace);
    expect(testRuns(trace)).toEqual(['discovery', 'a.test.cjs+b.test.cjs+c.test.cjs', 'discovery', 'full']);
    // Exactly one full run: a no-evidence Stage 2 is never re-run automatically.
    expect(fullRunIndexes(trace)).toHaveLength(1);
    expect(result.context.stagedVerification.loopBundles.at(-1).testFiles.result).toBe('empty');
    expect(result.context.finalStageVerification.testStage).toMatchObject({ result: 'no-evidence' });
    expect(result.result).toBe('blocked');
    expect(result.context.finalStageGrant ?? null).toBeNull();
  }, 30_000);

  test('a Stage 2 pass satisfies the full-suite requirement even when a later non-test check fails', async () => {
    // Lint passes before approval and fails only once the full suite has run.
    write('tools/lint.cjs', "process.exit(require('fs').existsSync(require('path').join(process.cwd(), '.git', 'full-suite-ran')) ? 1 : 0);\n");
    write('tests/a.test.cjs', '// A changed\n');
    commit('H1');
    const trace = [];
    const task = baseTask({ body: '## Verification\n\n- `node tools/fake-jest.cjs`\n' });
    const result = await review(task, 'run-review-lint-fail', trace);
    expect(testRuns(trace)).toEqual(['discovery', 'a.test.cjs', 'discovery', 'full']);
    expect(result.result).toBe('needs_fix');
    expect(result.context.finalStageVerification.testStage).toMatchObject({ result: 'passed' });
    expect(result.context.issueRequiredVerifications).toEqual([
      { command: 'node tools/fake-jest.cjs', status: 'passed' },
    ]);
  }, 30_000);

  // Issue #1166 — the ordinary Issue requirement. Every case below uses the
  // literal `npm test` an Issue of this project actually carries (AGENTS.md
  // §Verification), against a bound suite entry the operator spells
  // differently, so nothing here passes on a command invented to match.
  describe('an Issue requiring `npm test` against a differently spelled bound suite', () => {
    const NPM_TEST = '## Verification\n\n- `npm test`\n';

    test('undeclared, it is a required command nothing ran: the gate blocks before the reviewer', async () => {
      write('tests/a.test.cjs', '// A changed\n');
      commit('H1');
      const trace = [];
      const result = await review(baseTask({ body: NPM_TEST }), 'run-review-npm-test-undeclared', trace);
      expect(result.result).toBe('blocked');
      expect(result.context.missingVerificationCommands).toEqual(['npm test']);
      // Nothing is inferred from the command text: this is the shipped gate.
      expect(result.context.issueRequiredVerifications).toEqual([{ command: 'npm test', status: 'not_run' }]);
      expect(reviewerIndex(trace)).toBe(-1);
      expect(fullRunIndexes(trace)).toEqual([]);
    }, 30_000);

    test('declared, Stage 1 runs only the changed files, the requirement is pending, and only Stage 2 satisfies it', async () => {
      requirementCommands = ['npm test'];
      write('tests/a.test.cjs', '// A changed\n');
      commit('H1');
      const trace = [];
      const result = await review(baseTask({ body: NPM_TEST }), 'run-review-npm-test-declared', trace);
      // Stage 1 ran A alone, and the only full run sits after the reviewer.
      expect(testRuns(trace)).toEqual(['discovery', 'a.test.cjs', 'discovery', 'full']);
      expect(fullRunIndexes(trace)).toHaveLength(1);
      expect(fullRunIndexes(trace).every((index) => index > reviewerIndex(trace))).toBe(true);
      expect(result.result).toBe('success');
      expect(result.context.finalStageVerification.testStage).toMatchObject({ result: 'passed' });
      // The completed Stage 2 — and nothing before it — turned pending into passed.
      expect(result.context.issueRequiredVerifications).toEqual([{ command: 'npm test', status: 'passed' }]);
      expect(result.context.finalStageGrant).toMatchObject({ runId: 'run-review-npm-test-declared', headSha: head() });
    }, 30_000);

    test('a failing Stage 2 leaves the declared requirement pending and grants nothing', async () => {
      requirementCommands = ['npm test'];
      write('src/calc.cjs', 'module.exports = "broken";\n');
      write('tests/a.test.cjs', '// A changed\n');
      commit('H1');
      const result = await review(baseTask({ body: NPM_TEST }), 'run-review-npm-test-stage2-fail', []);
      expect(result.result).toBe('needs_fix');
      expect(result.context.issueRequiredVerifications).toEqual([
        { command: 'npm test', status: 'pending_full_suite' },
      ]);
      expect(result.context.finalStageGrant).toBeNull();
    }, 30_000);

    test('an empty Stage 1 declares nothing about it: still pending until Stage 2 records a pass', async () => {
      requirementCommands = ['npm test'];
      write('src/calc.cjs', 'module.exports = 3;\n');
      commit('source only');
      const trace = [];
      const result = await review(baseTask({ body: NPM_TEST }), 'run-review-npm-test-empty', trace);
      expect(result.context.stagedVerification.loopBundles.at(-1).testFiles.result).toBe('empty');
      // The empty Stage 1 reached review, and only the Stage 2 after it passed.
      expect(testRuns(trace)).toEqual(['discovery', 'discovery', 'full']);
      expect(result.result).toBe('success');
      expect(result.context.issueRequiredVerifications).toEqual([{ command: 'npm test', status: 'passed' }]);
    }, 30_000);

    test('an unrelated required command still blocks, and the declared one stays pending beside it', async () => {
      requirementCommands = ['npm test'];
      write('tests/a.test.cjs', '// A changed\n');
      commit('H1');
      const trace = [];
      const body = '## Verification\n\n- `npm test`\n- `npm run docs`\n';
      const result = await review(baseTask({ body }), 'run-review-npm-test-unrelated', trace);
      expect(result.result).toBe('blocked');
      expect(result.context.missingVerificationCommands).toEqual(['npm run docs']);
      expect(result.context.issueRequiredVerifications).toEqual([
        { command: 'npm test', status: 'pending_full_suite' },
        { command: 'npm run docs', status: 'not_run' },
      ]);
      expect(fullRunIndexes(trace)).toEqual([]);
    }, 30_000);

    test('the declaration never widens the suite: a differently spelled command is not the suite', async () => {
      requirementCommands = ['npm test'];
      write('tests/a.test.cjs', '// A changed\n');
      commit('H1');
      const body = '## Verification\n\n- `npm test --silent`\n';
      const result = await review(baseTask({ body }), 'run-review-npm-test-near-miss', []);
      // `npm test --silent` is not `npm test`; the shipped equivalence is exact.
      expect(result.result).toBe('blocked');
      expect(result.context.missingVerificationCommands).toEqual(['npm test --silent']);
    }, 30_000);

    // Issue #1166 (review, P1): the load-time collision check only sees the
    // static session map. An operator amendment can later point another ACTIVE
    // execution slot at a declared command — `exec:lint` becoming `npm test`
    // while the bound slot still runs the fake Jest — and that slot is not a
    // duplicate of the suite's own bytes. Admitted it would run the whole suite
    // as a non-test check, in Step 4 before the reviewer saw anything.
    test('an amendment that points another slot at the declared command runs no suite and never reaches the reviewer', async () => {
      requirementCommands = ['npm test'];
      write('tests/a.test.cjs', '// A changed\n');
      commit('H1');
      const amended = session();
      const baseline = buildVerificationSessionBaseline(amended.verification);
      const block = {
        revisions: [{
          revisionId: 'vamd-0000000000000001',
          revisionOrdinal: 1,
          requestKey: 'k1',
          scope: 'task',
          source: 'admin-cli',
          actor: { kind: 'operator', id: 'admin' },
          reason: 'pointing lint at the whole suite',
          operations: [{ kind: 'replace', commandId: 'exec:lint', command: 'npm test', reason: 'lint runs the suite' }],
          basePlanDigest: 'a'.repeat(64),
          planDigest: 'b'.repeat(64),
          sessionBaselineDigest: baseline.sessionBaselineDigest,
          continuation: 'implementation',
          createdAt: '2026-09-02T00:00:00.000Z',
          observedTaskRevision: 0,
        }],
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
        sessionVerification: amended.verification,
        issueRequirements: ['npm test'],
        amendments: block,
      });
      expect(resolved.status).toBe('resolved');
      // The amendment really did leave a second active slot running `npm test`,
      // beside a bound suite that still runs its own, differently spelled command.
      const activeCommands = Object.fromEntries(
        resolved.plan.execution.filter((slot) => slot.state === 'active').map((slot) => [slot.name, slot.command]),
      );
      expect(activeCommands).toEqual({ lint: 'npm test', test: 'node tools/fake-jest.cjs' });
      block.revisions[0].planDigest = resolved.plan.planDigest;
      block.checkpoint.planDigest = resolved.plan.planDigest;

      const trace = [];
      const result = await review(
        baseTask({ body: NPM_TEST, [VERIFICATION_AMENDMENTS_CONTEXT_KEY]: block }),
        'run-review-npm-test-alias-collision',
        trace,
      );
      // The suite is ambiguous, so Stage 1 records `unavailable` and re-runs
      // under the bounded streak — it never reaches the reviewer or Stage 2.
      expect(result.result).toBe('delayed');
      expect(result.context.stagedVerification.loopBundles.at(-1).testFiles).toMatchObject({
        result: 'unavailable',
        selection: { status: 'unavailable', reason: 'declared-requirement-collision' },
      });
      expect(reviewerIndex(trace)).toBe(-1);
      // Neither spelling of the suite ran: no fake Jest at all, and the
      // colliding `npm test` was never launched as a non-test check.
      expect(testRuns(trace)).toEqual([]);
      expect(trace.some((call) => call.cmd === 'npm')).toBe(false);
    }, 30_000);
  });

  test('a passing review Stage 1 ends a prior non-code recovery streak', async () => {
    write('tests/a.test.cjs', '// A changed\n');
    commit('H1');
    const task = baseTask({ stagedLoopRecovery: { streak: 2, lastOutcome: 'infrastructure' } });
    const result = await review(task, 'run-review-streak', []);
    expect(result.result).toBe('success');
    expect(result.context.stagedLoopRecovery).toBeNull();
  }, 30_000);

  test('a failing Stage 1 goes to repair and never reaches the reviewer or Stage 2', async () => {
    write('tests/c.test.cjs', '// C FAIL\n');
    commit('breaks C');
    const trace = [];
    const result = await review(baseTask(), 'run-review-stage1-fail', trace);
    expect(result.result).toBe('needs_fix');
    expect(reviewerIndex(trace)).toBe(-1);
    expect(testRuns(trace)).toEqual(['discovery', 'c.test.cjs']);
    expect(result.context.reviewFeedback).toContain('tests/c.test.cjs');
  }, 30_000);

  describe('a discovery that did not succeed is its process outcome, never an unavailable selection', () => {
    /** The hybrid runner, with the fake Jest's `--listTests` answered by `discovery`. */
    const discoveryRunner = (trace, discovery) => {
      const inner = hybridRunner(trace);
      return {
        run(cmd, args, opts) {
          if (cmd === 'node' && args[0] === 'tools/fake-jest.cjs' && args.includes('--listTests')) {
            trace.push({ cmd, args: [...args] });
            return discovery;
          }
          return inner.run(cmd, args, opts);
        },
      };
    };
    const stage1 = (runner, runId) => runStage1TestVerification({
      runner,
      session: session(),
      task: baseTask(),
      cwd: repo,
      lane: 'implementation',
      taskAttempt: 0,
      runId,
      baseBranch: 'main',
      artifactDir: artifactRoot,
    });

    test('a nonzero discovery exit records `failed` with its output and goes to repair', async () => {
      write('tests/a.test.cjs', '// A changed\n');
      commit('H1');
      const trace = [];
      const result = await stage1(
        discoveryRunner(trace, { stdout: '', stderr: 'SyntaxError: jest.config.cjs is broken\n', exitCode: 1 }),
        'run-impl-discovery-failed',
      );
      expect(result.classification).toEqual({ kind: 'result', result: 'failed' });
      expect(result.route).toBe('repair');
      expect(result.record).toMatchObject({
        result: 'failed',
        selection: { status: 'unavailable', reason: 'runnable-file-report' },
        mode: 'files',
        trust: 'unreadable-result',
        processResult: 'failed',
        failedFiles: [],
      });
      expect(result.record.outputTail).toContain('jest.config.cjs is broken');
      expect(result.detail).toContain('jest.config.cjs is broken');
      expect(result.contextPatch.stagedVerification.loopBundles.at(-1).testFiles.result).toBe('failed');
      expect(testRuns(trace)).toEqual(['discovery']);
    }, 30_000);

    test('a discovery that hit its deadline with confirmed cleanup records `timed-out` and goes to repair', async () => {
      write('tests/a.test.cjs', '// A changed\n');
      commit('H1');
      const trace = [];
      const result = await stage1(
        discoveryRunner(trace, {
          stdout: '',
          stderr: 'still collecting tests\n',
          exitCode: 1,
          signal: 'SIGTERM',
          timedOut: true,
          processTreeCleanup: { processGroupTerminated: true },
        }),
        'run-impl-discovery-timeout',
      );
      expect(result.classification).toEqual({ kind: 'result', result: 'timed-out' });
      expect(result.route).toBe('repair');
      expect(result.record).toMatchObject({ result: 'timed-out', trust: 'deadline', mode: 'files' });
      expect(result.record.processResult).toBeUndefined();
      expect(testRuns(trace)).toEqual(['discovery']);
    }, 30_000);

    test('a discovery that exited 0 with an unreadable report stays `unavailable`', async () => {
      write('tests/a.test.cjs', '// A changed\n');
      commit('H1');
      const trace = [];
      const result = await stage1(
        discoveryRunner(trace, { stdout: 'not json', stderr: '', exitCode: 0 }),
        'run-impl-discovery-unreadable',
      );
      expect(result.route).toBe('rerun');
      expect(result.record).toMatchObject({ result: 'unavailable', selection: { status: 'unavailable', reason: 'runnable-file-report' } });
      expect(result.record.mode).toBeUndefined();
    }, 30_000);
  });

  test('an allocated run with no recorded result parks before anything launches', async () => {
    write('tests/a.test.cjs', '// A changed\n');
    const trace = [];
    const first = await implementationStage1(baseTask(), 'run-impl-open', trace);
    // Simulate a worker that died after allocating: the record never landed.
    const state = first.contextPatch.stagedVerification;
    const open = {
      ...state,
      loopBundles: [],
      runs: state.runs.map(({ recordedAt, outcome, complete, ...entry }) => ({ ...entry, state: 'allocated' })),
    };
    const interruptedTrace = [];
    const parked = await implementationStage1(baseTask({ stagedVerification: open }), 'run-impl-after-crash', interruptedTrace);
    expect(parked.route).toBe('park');
    expect(parked.classification).toEqual({ kind: 'result', result: 'termination-unknown' });
    expect(testRuns(interruptedTrace)).toEqual([]);
    expect(parked.contextPatch.stagedVerification.runs.every((entry) => entry.state !== 'allocated')).toBe(true);
  }, 30_000);

  test('the conflict lane hands off an open allocation before the merge, the agent or any check', async () => {
    write('tests/a.test.cjs', '// A changed\n');
    const first = await implementationStage1(baseTask(), 'run-impl-open-conflict', []);
    const state = first.contextPatch.stagedVerification;
    const open = {
      ...state,
      loopBundles: [],
      runs: state.runs.map(({ recordedAt, outcome, complete, ...entry }) => ({ ...entry, state: 'allocated' })),
    };
    const trace = [];
    const handler = createConflictResolutionHandler(
      { session: session(), runId: 'run-conflict-open', workerId: 'w1' },
      hybridRunner(trace),
      (input) => ({ ok: true, path: repo, worktreeId: `${input.sessionId}/issue-${input.issueNumber}`, branch: input.branch, created: false, branchReused: true }),
      {
        acquire: () => ({ ok: true, locked: true, contextId: 'run-conflict-open', sessionId: SESSION_ID }),
        release: () => ({ ok: true, released: true }),
      },
    );
    const result = await handler({ ...baseTask({ stagedVerification: open }), phase: 'conflict_resolution' });
    expect(result.result).toBe('blocked');
    expect(result.message).toContain('termination-unknown');
    const launched = trace.filter((call) =>
      call.cmd === 'gh' || call.cmd === 'node' || call.cmd === 'claude'
      || (call.cmd === 'git' && ['fetch', 'reset', 'merge'].includes(call.args[0])));
    expect(launched).toEqual([]);
    expect(result.context.stagedVerification.runs.every((entry) => entry.state !== 'allocated')).toBe(true);
  }, 30_000);

  test('the conflict lane allocates its Stage 1 run and keeps a handoff route as a handoff', async () => {
    write('tests/a.test.cjs', '// A changed\n');
    commit('change A');
    const first = await implementationStage1(baseTask(), 'run-impl-conflict-park', []);
    const state = { ...first.contextPatch.stagedVerification, retainedTestFiles: [{ file: 'tests/gone.test.cjs', addedBy: '0/review/final/0' }] };
    // The base moves on with an unrelated commit, so the merge is clean but real.
    const branchHead = head();
    git(['checkout', '-q', 'main']);
    write('src/other.cjs', 'module.exports = 2;\n');
    commit('base moves');
    git(['update-ref', 'refs/remotes/origin/main', head()]);
    git(['checkout', '-q', BRANCH]);
    expect(head()).toBe(branchHead);
    const trace = [];
    const handler = createConflictResolutionHandler(
      { session: session(), runId: 'run-conflict-park', workerId: 'w1' },
      hybridRunner(trace),
      (input) => ({ ok: true, path: repo, worktreeId: `${input.sessionId}/issue-${input.issueNumber}`, branch: input.branch, created: false, branchReused: true }),
      {
        acquire: () => ({ ok: true, locked: true, contextId: 'run-conflict-park', sessionId: SESSION_ID }),
        release: () => ({ ok: true, released: true }),
      },
    );
    const result = await handler({ ...baseTask({ stagedVerification: state }), phase: 'conflict_resolution' });
    // `retained-unresolved` is a handoff, never a generic verification failure.
    expect(result.result).toBe('blocked');
    expect(result.context.semanticConflict).toBeUndefined();
    const conflictRuns = result.context.stagedVerification.runs.filter((entry) => entry.stageRunId.lane === 'conflict-resolution');
    expect(conflictRuns).toHaveLength(1);
    expect(conflictRuns[0].state).toBe('recorded');
    expect(testRuns(trace)).not.toContain('full');
    expect(trace.some((call) => call.cmd === 'git' && call.args[0] === 'commit')).toBe(false);
    expect(trace.some((call) => call.cmd === 'git' && call.args[0] === 'push')).toBe(false);
  }, 30_000);

  test('the conflict lane caps a Stage 1 code failure by its recorded failing files, not by output lines', async () => {
    // The fake Jest prints no `●` lines, so only the record names the failure.
    write('tests/c.test.cjs', '// C FAIL\n');
    commit('breaks C');
    const branchHead = head();
    git(['checkout', '-q', 'main']);
    write('src/other.cjs', 'module.exports = 2;\n');
    commit('base moves');
    git(['update-ref', 'refs/remotes/origin/main', head()]);
    git(['checkout', '-q', BRANCH]);
    expect(head()).toBe(branchHead);
    const trace = [];
    const handler = createConflictResolutionHandler(
      { session: { ...session(), conflictResolutionLoop: { maxAttempts: 1 } }, runId: 'run-conflict-cap', workerId: 'w1' },
      hybridRunner(trace),
      (input) => ({ ok: true, path: repo, worktreeId: `${input.sessionId}/issue-${input.issueNumber}`, branch: input.branch, created: false, branchReused: true }),
      {
        acquire: () => ({ ok: true, locked: true, contextId: 'run-conflict-cap', sessionId: SESSION_ID }),
        release: () => ({ ok: true, released: true }),
      },
    );
    const result = await handler({ ...baseTask(), phase: 'conflict_resolution' });
    expect(result.result).toBe('blocked');
    expect(result.context.conflictResolutionVerificationCapReached).toBe(true);
    expect(result.context.semanticConflict.failedTests).toEqual([expect.stringContaining('c.test.cjs')]);
    expect(testRuns(trace)).not.toContain('full');
  }, 30_000);

  test('the review lane hands off an unreadable stage state before any check launches', async () => {
    write('tests/a.test.cjs', '// A changed\n');
    commit('H1');
    const trace = [];
    const result = await review(baseTask({ stagedVerification: 'not a state' }), 'run-review-unreadable', trace);
    expect(result.result).toBe('blocked');
    expect(result.message).toContain('cannot be read');
    expect(trace.filter((call) => call.cmd === 'node')).toEqual([]);
    expect(reviewerIndex(trace)).toBe(-1);
  }, 30_000);

  test('the review lane parks an open allocation before the worktree is fetched or prepared', async () => {
    write('tests/a.test.cjs', '// A changed\n');
    commit('H1');
    const first = await implementationStage1(baseTask(), 'run-impl-open-review', []);
    const state = first.contextPatch.stagedVerification;
    const open = {
      ...state,
      loopBundles: [],
      runs: state.runs.map(({ recordedAt, outcome, complete, ...entry }) => ({ ...entry, state: 'allocated' })),
    };
    const prepared = { ...session(), environmentPrepare: { enabled: true, command: 'node tools/lint.cjs' } };
    const trace = [];
    const handler = createReviewHandler(
      { session: prepared, runId: 'run-review-open', workerId: 'w1' },
      hybridRunner(trace),
      (input) => ({ ok: true, path: repo, worktreeId: `${input.sessionId}/issue-${input.issueNumber}`, branch: input.branch, created: false, branchReused: true }),
      {
        acquire: () => ({ ok: true, locked: true, contextId: 'run-review-open', sessionId: SESSION_ID }),
        release: () => ({ ok: true, released: true }),
      },
    );
    const result = await handler({ ...baseTask({ stagedVerification: open }), phase: 'review' });
    expect(result.result).toBe('blocked');
    expect(result.message).toContain('termination-unknown');
    const launched = trace.filter((call) =>
      call.cmd === 'node' || call.cmd === 'codex'
      || (call.cmd === 'git' && ['fetch', 'pull', 'reset', 'clean'].includes(call.args[0])));
    expect(launched).toEqual([]);
    expect(result.context.stagedVerification.runs.every((entry) => entry.state !== 'allocated')).toBe(true);
  }, 30_000);

  describe('an open allocation still parks after the configuration stops applying', () => {
    // §5 rule 3: the allocation predates the configuration change, so disabling
    // staged verification or removing the suite binding before the retry never
    // lets new work overlap a possibly live run.
    const withoutStaging = () => {
      const { stagedVerification, ...rest } = session();
      return rest;
    };
    const unbound = () => ({ ...session(), stagedVerification: { enabled: true } });
    const openAllocation = async (runId) => {
      write('tests/a.test.cjs', '// A changed\n');
      commit('H1');
      const first = await implementationStage1(baseTask(), runId, []);
      const state = first.contextPatch.stagedVerification;
      return {
        ...state,
        loopBundles: [],
        runs: state.runs.map(({ recordedAt, outcome, complete, ...entry }) => ({ ...entry, state: 'allocated' })),
      };
    };

    test.each([
      ['disabled', withoutStaging],
      ['unbound', unbound],
    ])('the implementation lane (%s) parks before the worktree is materialized', async (label, configured) => {
      const open = await openAllocation(`run-impl-open-${label}`);
      const trace = [];
      const resolved = [];
      const handler = createImplementationHandler(
        { session: configured(), runId: `run-impl-${label}`, workerId: 'w1' },
        hybridRunner(trace),
        undefined,
        (input) => {
          resolved.push(input);
          return { ok: true, path: repo, worktreeId: `${input.sessionId}/issue-${input.issueNumber}`, branch: input.branch, created: false, branchReused: true };
        },
      );
      const task = baseTask({ stagedVerification: open, prUrl: undefined, branch: undefined });
      const result = await handler({ ...task, implementationAgent: 'claude', phase: 'implementation' });
      expect(result.result).toBe('failed');
      expect(result.error).toContain('termination-unknown');
      expect(resolved).toEqual([]);
      expect(trace.filter((call) => call.cmd === 'node' || call.cmd === 'claude')).toEqual([]);
      expect(result.context.stagedVerification.runs.every((entry) => entry.state !== 'allocated')).toBe(true);
    }, 30_000);

    test.each([
      ['disabled', withoutStaging],
      ['unbound', unbound],
    ])('the review lane (%s) parks before any check or reviewer launches', async (label, configured) => {
      const open = await openAllocation(`run-review-open-${label}`);
      const trace = [];
      const handler = createReviewHandler(
        { session: configured(), runId: `run-review-${label}`, workerId: 'w1' },
        hybridRunner(trace),
        (input) => ({ ok: true, path: repo, worktreeId: `${input.sessionId}/issue-${input.issueNumber}`, branch: input.branch, created: false, branchReused: true }),
        {
          acquire: () => ({ ok: true, locked: true, contextId: `run-review-${label}`, sessionId: SESSION_ID }),
          release: () => ({ ok: true, released: true }),
        },
      );
      const result = await handler({ ...baseTask({ stagedVerification: open }), phase: 'review' });
      expect(result.result).toBe('blocked');
      expect(result.message).toContain('termination-unknown');
      const launched = trace.filter((call) =>
        call.cmd === 'node' || call.cmd === 'codex'
        || (call.cmd === 'git' && ['fetch', 'pull', 'reset', 'clean'].includes(call.args[0])));
      expect(launched).toEqual([]);
      expect(result.context.stagedVerification.runs.every((entry) => entry.state !== 'allocated')).toBe(true);
    }, 30_000);

    test.each([
      ['disabled', withoutStaging],
      ['unbound', unbound],
    ])('the conflict lane (%s) hands off before the merge, the agent or any check', async (label, configured) => {
      const open = await openAllocation(`run-conflict-open-${label}`);
      const trace = [];
      const handler = createConflictResolutionHandler(
        { session: configured(), runId: `run-conflict-${label}`, workerId: 'w1' },
        hybridRunner(trace),
        (input) => ({ ok: true, path: repo, worktreeId: `${input.sessionId}/issue-${input.issueNumber}`, branch: input.branch, created: false, branchReused: true }),
        {
          acquire: () => ({ ok: true, locked: true, contextId: `run-conflict-${label}`, sessionId: SESSION_ID }),
          release: () => ({ ok: true, released: true }),
        },
      );
      const result = await handler({ ...baseTask({ stagedVerification: open }), phase: 'conflict_resolution' });
      expect(result.result).toBe('blocked');
      expect(result.message).toContain('termination-unknown');
      const launched = trace.filter((call) =>
        call.cmd === 'gh' || call.cmd === 'node' || call.cmd === 'claude'
        || (call.cmd === 'git' && ['fetch', 'reset', 'merge'].includes(call.args[0])));
      expect(launched).toEqual([]);
      expect(result.context.stagedVerification.runs.every((entry) => entry.state !== 'allocated')).toBe(true);
    }, 30_000);
  });

  test('a PR head that moves while the full suite runs records `stale` before any non-test check launches', async () => {
    write('tests/a.test.cjs', '// A changed\n');
    commit('H1');
    const stage1 = await implementationStage1(baseTask(), 'run-impl-before-stale', []);
    expect(stage1.route).toBe('continue');
    const task = merged(baseTask(), { context: stage1.contextPatch });
    const launchHead = head();
    const trace = [];
    const inner = hybridRunner(trace);
    let suiteEnded = false;
    const runner = {
      run(cmd, args, opts) {
        const outcome = inner.run(cmd, args, opts);
        if (cmd === 'node' && args[0] === 'tools/fake-jest.cjs' && !args.includes('--listTests') && !args.includes('--runTestsByPath')) {
          suiteEnded = true;
        }
        return outcome;
      },
    };
    const run = await runFinalStageVerification({
      runner,
      session: session(),
      task,
      cwd: repo,
      runId: 'run-final-stale',
      taskAttempt: 0,
      artifactDir: artifactRoot,
      // A push to the PR branch lands while the full suite runs.
      readLivePrHead: () => (suiteEnded ? 'f'.repeat(40) : launchHead),
    });
    expect(testRuns(trace)).toEqual(['discovery', 'full']);
    expect(run).toMatchObject({ granted: false, testStage: { result: 'stale' } });
    expect(trace.some((call) => call.cmd === 'node' && call.args[0] === 'tools/lint.cjs')).toBe(false);
    // The operator-facing artifact is the bundle the store recorded, Stage 2 record included.
    const artifact = JSON.parse(readFileSync(
      join(artifactRoot, `review-final-verification-stage-final-${run.bundle.stageRunId.stageOrdinal}.json`),
      'utf8',
    ));
    expect(artifact.outcome).toBe(run.bundle.outcome);
    expect(artifact.testFiles).toMatchObject({ result: 'stale' });
  }, 30_000);

  test('a retained file that is gone parks as an unresolved obligation', async () => {
    write('tests/a.test.cjs', '// A changed\n');
    const trace = [];
    const first = await implementationStage1(baseTask(), 'run-impl-retained', trace);
    const state = { ...first.contextPatch.stagedVerification, retainedTestFiles: [{ file: 'tests/gone.test.cjs', addedBy: '0/review/final/0' }] };
    const parked = await implementationStage1(baseTask({ stagedVerification: state }), 'run-impl-gone', trace);
    expect(parked.route).toBe('park');
    expect(parked.record.result).toBe('retained-unresolved');
    expect(parked.contextPatch.stagedVerification.retainedTestFiles.map((entry) => entry.file)).toEqual(['tests/gone.test.cjs']);
  }, 30_000);

  test('a suite that is unbound at launch records `unavailable` in both stages and launches no test', async () => {
    write('tests/a.test.cjs', '// A changed\n');
    commit('H1');
    // Another active slot duplicates the suite command, so the suite is ambiguous (§3 R2).
    const duplicated = { ...session(), verification: { ...session().verification, again: 'node tools/fake-jest.cjs' } };
    const trace = [];
    const stage1 = await runStage1TestVerification({
      runner: hybridRunner(trace),
      session: duplicated,
      task: baseTask(),
      cwd: repo,
      lane: 'implementation',
      taskAttempt: 0,
      runId: 'run-impl-unbound',
      baseBranch: 'main',
      artifactDir: artifactRoot,
    });
    expect(stage1.route).toBe('rerun');
    expect(stage1.record).toMatchObject({ result: 'unavailable', selection: { status: 'unavailable', reason: 'duplicate-suite-command' } });
    expect(stage1.contextPatch.stagedVerification.runs.map((entry) => entry.state)).toEqual(['recorded']);
    expect(stage1.contextPatch.stagedVerification.loopBundles.at(-1).testFiles.result).toBe('unavailable');
    expect(stage1.detail).toContain('ambiguous');

    const stage2 = await runFinalStageVerification({
      runner: hybridRunner(trace),
      session: duplicated,
      task: baseTask(),
      cwd: repo,
      runId: 'run-final-unbound',
      taskAttempt: 0,
      artifactDir: artifactRoot,
    });
    expect(stage2).toMatchObject({
      status: 'recorded',
      disposition: 'operator',
      granted: false,
      testStage: { result: 'unavailable', record: { selection: { status: 'unavailable', reason: 'duplicate-suite-command' } } },
    });
    expect(stage2.context.stagedVerification.finalBundles.at(-1).testFiles.result).toBe('unavailable');
    expect(testRuns(trace)).toEqual([]);
  }, 30_000);

  test('a retired suite slot that was the plan\'s only slot records `unavailable` in both stages', async () => {
    write('tests/a.test.cjs', '// A changed\n');
    commit('H1');
    const suiteOnly = { ...session(), verification: { test: 'node tools/fake-jest.cjs' } };
    // An applied amendment retiring `exec:test`, with digests that reconcile.
    const baseline = buildVerificationSessionBaseline(suiteOnly.verification);
    const block = {
      revisions: [{
        revisionId: 'vamd-0000000000000001',
        revisionOrdinal: 1,
        requestKey: 'k1',
        scope: 'task',
        source: 'admin-cli',
        actor: { kind: 'operator', id: 'admin' },
        reason: 'retiring the suite slot',
        operations: [{ kind: 'retire', commandId: 'exec:test', reason: 'retired' }],
        basePlanDigest: 'a'.repeat(64),
        planDigest: 'b'.repeat(64),
        sessionBaselineDigest: baseline.sessionBaselineDigest,
        continuation: 'implementation',
        createdAt: '2026-09-02T00:00:00.000Z',
        observedTaskRevision: 0,
      }],
      checkpoint: {
        planDigest: 'b'.repeat(64),
        sessionBaseline: baseline.sessionBaseline,
        sessionBaselineDigest: baseline.sessionBaselineDigest,
        appliedThroughOrdinal: 1,
        updatedAt: '2026-09-02T00:00:00.000Z',
        updatedBy: 'revision',
      },
    };
    const resolved = resolveEffectiveVerificationPlan({ sessionVerification: suiteOnly.verification, issueRequirements: [], amendments: block });
    expect(resolved.status).toBe('resolved');
    expect(resolved.plan.execution.some((slot) => slot.state === 'active')).toBe(false);
    block.revisions[0].planDigest = resolved.plan.planDigest;
    block.checkpoint.planDigest = resolved.plan.planDigest;
    const task = baseTask({ [VERIFICATION_AMENDMENTS_CONTEXT_KEY]: block });
    const trace = [];
    const stage1 = await runStage1TestVerification({
      runner: hybridRunner(trace),
      session: suiteOnly,
      task,
      cwd: repo,
      lane: 'implementation',
      taskAttempt: 0,
      runId: 'run-impl-retired',
      baseBranch: 'main',
      artifactDir: artifactRoot,
    });
    expect(stage1.record).toMatchObject({ result: 'unavailable', selection: { status: 'unavailable', reason: 'no-active-slot' } });
    expect(stage1.contextPatch.stagedVerification.runs.map((entry) => entry.state)).toEqual(['recorded']);

    const stage2 = await runFinalStageVerification({
      runner: hybridRunner(trace),
      session: suiteOnly,
      task,
      cwd: repo,
      runId: 'run-final-retired',
      taskAttempt: 0,
      artifactDir: artifactRoot,
    });
    expect(stage2).toMatchObject({
      status: 'recorded',
      disposition: 'operator',
      granted: false,
      testStage: { result: 'unavailable', record: { selection: { status: 'unavailable', reason: 'no-active-slot' } } },
    });
    expect(testRuns(trace)).toEqual([]);
  }, 30_000);

  test('an unattested Stage 1 launch records `identity-unknown`, not `unavailable`, and launches no test tooling', async () => {
    write('tests/a.test.cjs', '// A changed\n');
    commit('H1');
    // A declared environment prepare with no current stamp leaves environmentIdentity unknown.
    const unattested = { ...session(), environmentPrepare: { enabled: true, command: 'node tools/lint.cjs' } };
    const trace = [];
    const stage1 = await runStage1TestVerification({
      runner: hybridRunner(trace),
      session: unattested,
      task: baseTask(),
      cwd: repo,
      lane: 'implementation',
      taskAttempt: 0,
      runId: 'run-impl-unattested',
      baseBranch: 'main',
      artifactDir: artifactRoot,
    });
    expect(stage1.classification).toEqual({ kind: 'result', result: 'identity-unknown' });
    expect(stage1.route).toBe('rerun');
    expect(stage1.record).toMatchObject({
      result: 'identity-unknown',
      selection: { status: 'unavailable', reason: 'launch-identity-unattested' },
    });
    expect(stage1.contextPatch.stagedVerification.loopBundles.at(-1).testFiles.result).toBe('identity-unknown');
    expect(stage1.detail).toContain('environmentIdentity');
    expect(testRuns(trace)).toEqual([]);
  }, 30_000);

  test('an unattested Stage 2 launch records `identity-unknown`, re-runs under the bounded streak, then parks', async () => {
    write('tests/a.test.cjs', '// A changed\n');
    commit('H1');
    // A declared environment prepare with no current stamp leaves environmentIdentity unknown.
    const unattested = {
      ...session(),
      stagedVerification: { ...session().stagedVerification, maxStageRecoveryAttempts: 1 },
      environmentPrepare: { enabled: true, command: 'node tools/lint.cjs' },
    };
    const trace = [];
    let task = baseTask();
    const dispositions = [];
    for (const runId of ['run-final-unknown-1', 'run-final-unknown-2']) {
      const run = await runFinalStageVerification({
        runner: hybridRunner(trace),
        session: unattested,
        task,
        cwd: repo,
        runId,
        taskAttempt: 0,
        artifactDir: artifactRoot,
      });
      expect(run).toMatchObject({ status: 'recorded', granted: false, testStage: { result: 'identity-unknown' } });
      expect(run.testStage.detail).toContain('environmentIdentity');
      dispositions.push(run.disposition);
      task = merged(task, run);
    }
    expect(dispositions).toEqual(['rerun', 'operator']);
    expect(testRuns(trace)).toEqual([]);
  }, 30_000);
});
