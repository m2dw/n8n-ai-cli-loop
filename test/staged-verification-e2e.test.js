// Issue #1108 — staged verification end to end over a non-TypeScript fixture
// (docs/staged-verification-contract.md §13 S12).
//
// A real git repository whose checks are opaque POSIX `sh` commands, so no
// language runtime beyond the shell is needed. Every command — checks and git —
// really runs through the shipped command runner; the lanes are driven through
// `runNextPhase` over a durable SQLite store, with the review agent's approval
// and the implementation agent's edits modelled by the test.
//
// Covered: a loop stage over the required set, review approval, a failing final
// stage, the return to implementation, a passing final stage and the
// stack-ready publication; the legacy (un-opted-in) path; a store restart;
// cross-Issue isolation; and an operator amendment invalidating earlier final
// evidence.
//
// Issue #1155 retired what S12 measured: the `sh` selection adapter, the
// `selectable` / `finalOnly` lists and the persisted regression set. Every
// stage run now covers the entire required set, so there is no narrowing to
// broaden and no regression to union back in — which is what the lifecycle
// below exercises instead.
//
// Issue #1156 split the trace by half rather than binding a test suite here:
// this file stays the lifecycle of the **non-test** checks, where a stage's
// commands are opaque `sh` bytes and no runtime beyond a POSIX shell is
// needed. The changed-file / full-suite trace of
// `docs/changed-file-verification-contract.md` §7 — Stage 1 over selected
// files, a failing Stage 2, the retained file on the next loop and the grant —
// needs a real test runner to mean anything, so it lives in
// `test/changed-file-verification-e2e.test.js`, which drives this repository's
// own Jest over a plain-CommonJS project. The sessions below therefore bind no
// `testSuite`, which is what keeps them on the non-test path.

import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { amendTaskVerification } from '../dist/index.js';
import { extractIssueVerificationSections } from '../dist/handlers/issue-verification-extractor.js';
import { defaultCommandRunner } from '../dist/handlers/command-runner.js';
import {
  resolveStageVerificationContext,
  runFinalStageVerification,
  runLoopStageVerification,
} from '../dist/handlers/stage-verification.js';
import { FINAL_STAGE_REPAIR_CONTEXT_KEY, planFinalStageRepair } from '../dist/core/final-stage-repair.js';
import { describeStagedVerificationStatus } from '../dist/core/staged-verification-status.js';
import { runNextPhase } from '../dist/core/phase-runner.js';
import { SqliteTaskStore } from '../dist/stores/sqlite-task-store.js';
import { SqliteOutboxStore } from '../dist/stores/sqlite-outbox-store.js';

const SESSION_ID = 'sess-polyglot';
const START_MS = Date.parse('2026-09-13T10:00:00.000Z');

const E2E_SH = String.raw`#!/bin/sh
if [ -e "$1/e2e-fails" ]; then
  echo "e2e: rounding drifted" >&2
  exit 1
fi
exit 0
`;

let tmpDir;
let repo;
let control;
let artifacts;
let dbPath;
let tick;

const at = () => new Date(START_MS + (tick += 60_000)).toISOString();

function git(args) {
  return execFileSync(
    'git',
    ['-c', 'user.name=Staged Fixture', '-c', 'user.email=fixture@example.invalid', ...args],
    { cwd: repo, encoding: 'utf8' },
  );
}

const write = (relative, text) => writeFileSync(join(repo, relative), text);
const commit = (message) => {
  git(['add', '-A']);
  git(['commit', '-q', '-m', message]);
};

beforeEach(() => {
  tick = 0;
  tmpDir = mkdtempSync(join(tmpdir(), 'staged-e2e-'));
  repo = join(tmpDir, 'repo');
  control = join(tmpDir, 'control');
  artifacts = join(tmpDir, 'artifacts');
  dbPath = join(tmpDir, 'loop.db');
  for (const dir of [control, artifacts]) mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  for (const dir of ['lib', 'checks']) mkdirSync(join(repo, dir));
  write('lib/rounding.sh', "printf '%s\\n' 1\n");
  write('checks/lint.sh', 'exit 0\n');
  write('checks/unit.sh', 'sh lib/rounding.sh >/dev/null\n');
  write('checks/e2e.sh', E2E_SH);
  commit('fixture');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const stagedSession = (staged = {}) => ({
  sessionId: SESSION_ID,
  repoKey: 'polyglot',
  repoRoot: repo,
  githubRepo: 'org/polyglot',
  artifactDir: '.artifacts',
  artifactRoot: artifacts,
  githubOwner: 'org',
  githubName: 'polyglot',
  defaults: { implementationAgent: 'claude', reviewAgent: 'codex' },
  verification: { lint: 'sh checks/lint.sh', unit: 'sh checks/unit.sh', e2e: `sh checks/e2e.sh ${control}` },
  stagedVerification: { enabled: true, ...staged },
  labels: { active: 'ai:active', blocked: 'ai:blocked', readyForHuman: 'ai:ready-for-human' },
  workItemProvider: { provider: 'github-issues', auth: { mode: 'gh' } },
  repoHostProvider: { provider: 'github', auth: { mode: 'gh' } },
});

const loop = (session, task) =>
  runLoopStageVerification({
    runner: defaultCommandRunner,
    session,
    task,
    cwd: repo,
    lane: 'implementation',
    taskAttempt: typeof task.attempts?.implementation === 'number' ? task.attempts.implementation : 0,
    stageOrdinal: 0,
    artifactDir: artifacts,
  });

const finalStage = (session, task, runId) =>
  runFinalStageVerification({
    runner: defaultCommandRunner,
    session,
    task,
    cwd: repo,
    runId,
    taskAttempt: typeof task.attempts?.review === 'number' ? task.attempts.review : 0,
    artifactDir: artifacts,
    commandTimeoutMs: 20000,
  });

const selectedNames = (run) => run.stage.assembly.bundle.checks.map((check) => check.name);

// ---------------------------------------------------------------------------
// The lanes, as the phase runner drives them
// ---------------------------------------------------------------------------

function openStores() {
  return { task: new SqliteTaskStore(dbPath), outbox: new SqliteOutboxStore(dbPath) };
}

function closeStores(stores) {
  stores.task.close();
  stores.outbox.close();
}

/** The implementation lane's verification moment: the loop stage, routed on its shipped outcome. */
const implementationHandler = (session, observed) => async (task) => {
  const run = await loop(session, task);
  observed.push(run);
  return run.verification.passed
    ? { result: 'success', context: {}, message: 'implemented' }
    : { result: 'needs_fix', context: {}, message: 'verification failed' };
};

/**
 * The review lane after its agent approved, mirroring `src/handlers/review.ts`:
 * the final stage, then row 7 publishes and rows 9/10 return the failing set to
 * implementation through `planFinalStageRepair`.
 */
const approvingReviewHandler = (session, runId, observed) => async (task) => {
  const run = await finalStage(session, task, runId);
  observed.push(run);
  if (run.status === 'recorded' && run.disposition === 'grant') {
    return { result: 'success', context: { ...run.context, [FINAL_STAGE_REPAIR_CONTEXT_KEY]: null } };
  }
  if (run.status === 'recorded' && run.disposition === 'repair') {
    const repair = planFinalStageRepair(run.bundle);
    if (repair.kind === 'refused') throw new Error(`repair refused: ${repair.reason}`);
    return {
      result: 'needs_fix',
      context: { ...run.context, [FINAL_STAGE_REPAIR_CONTEXT_KEY]: repair.record },
      message: 'final verification failed',
    };
  }
  throw new Error(`unexpected final stage: ${run.status}/${run.disposition}`);
};

async function runPhase(stores, session, runId, handlers) {
  const now = at();
  return runNextPhase({
    store: stores.task,
    request: { sessionId: SESSION_ID, workerId: 'w1', runId, now },
    handlers,
    outboxStore: stores.outbox,
    session,
    now,
  });
}

const stackReadyAdds = async (stores) =>
  (await stores.outbox.listPending()).filter(
    (entry) => entry.topic === 'gh:label:add' && entry.payload.label === 'status:stack-ready',
  );

const enqueue = (stores, issueNumber, phase) =>
  stores.task.enqueueTask({
    sessionId: SESSION_ID,
    issueNumber,
    phase,
    now: at(),
    context: {
      title: `fixture issue ${issueNumber}`,
      prUrl: 'https://github.com/org/polyglot/pull/5',
      branch: `ai/issue-${issueNumber}`,
    },
  });

const progressOf = (session, task) =>
  describeStagedVerificationStatus({
    stagedVerification: session.stagedVerification,
    context: task.context,
    plan: resolveStageVerificationContext({ session, task }).plan,
  }).progress;

const finalBundlesOf = (task) => task.context.stagedVerification?.finalBundles ?? [];

// ---------------------------------------------------------------------------
// The lifecycle
// ---------------------------------------------------------------------------

describe('the full lifecycle over a non-TypeScript fixture', () => {
  test('loop → approval → final failure → implementation → final success → stack-ready', async () => {
    const session = stagedSession();
    const key = { sessionId: SESSION_ID, issueNumber: 41 };
    let stores = openStores();
    try {
      await enqueue(stores, 41, 'implementation');

      // 1. The loop stage runs the entire required set: nothing is consulted
      //    about the change, and no check is omissible (issue #1155).
      write('lib/rounding.sh', "printf '%s\\n' 2\n");
      const loops = [];
      const implemented = await runPhase(stores, session, 'run-impl-1', { implementation: implementationHandler(session, loops) });
      expect(implemented.status).toBe('completed');
      expect(implemented.task).toMatchObject({ phase: 'review', status: 'queued' });
      expect(selectedNames(loops[0])).toEqual(['lint', 'unit', 'e2e']);
      expect(loops[0].stage.assembly.bundle.selection).toMatchObject({ full: true });
      // Nothing was omitted because nothing is omissible: the selection is the
      // required set itself, with no record of a narrowing to read.
      expect(loops[0].stage.selection.checks.map((check) => check.checkId)).toEqual(
        loops[0].stage.assembly.bundle.selection.checkIds,
      );
      expect(progressOf(session, await stores.task.getTask(key))).toBe('no-final-evidence');
      commit('round to 2');

      // 2. Review approves; the final stage runs EVERY required check at the
      //    approved head, the e2e suite fails, and nothing is published.
      writeFileSync(join(control, 'e2e-fails'), '');
      const finals = [];
      const rejected = await runPhase(stores, session, 'run-review-1', { review: approvingReviewHandler(session, 'run-review-1', finals) });
      expect(finals[0].route).toEqual({ row: 9, disposition: 'repair' });
      expect(finals[0].bundle.selection).toMatchObject({ full: true });
      expect(finals[0].bundle.checks.map((check) => [check.name, check.verdict])).toEqual([
        ['lint', 'passed'],
        ['unit', 'passed'],
        ['e2e', 'failed'],
      ]);
      expect(rejected.task).toMatchObject({ phase: 'implementation', status: 'queued' });
      expect(await stackReadyAdds(stores)).toHaveLength(0);
      const afterFailure = await stores.task.getTask(key);
      expect(afterFailure.context[FINAL_STAGE_REPAIR_CONTEXT_KEY].failing.map((check) => check.checkId)).toEqual(['exec:e2e']);
      expect(progressOf(session, afterFailure)).toBe('final-withheld');

      // 3. A restart: the failing evidence is on the task row, not in a process.
      closeStores(stores);
      stores = openStores();
      const afterRestart = await stores.task.getTask(key);
      expect(finalBundlesOf(afterRestart).map((bundle) => bundle.outcome)).toEqual(['code-failed']);
      expect(afterRestart.context[FINAL_STAGE_REPAIR_CONTEXT_KEY].failing.map((check) => check.checkId)).toEqual(['exec:e2e']);

      // 4. Back in implementation: the fix touches only `lib/`, and the loop
      //    runs `e2e` anyway — because it runs everything, every cycle.
      write('lib/rounding.sh', "printf '%s\\n' 3\n");
      rmSync(join(control, 'e2e-fails'));
      const fixed = await runPhase(stores, session, 'run-impl-2', { implementation: implementationHandler(session, loops) });
      expect(fixed.task).toMatchObject({ phase: 'review', status: 'queued' });
      expect(selectedNames(loops[1])).toEqual(['lint', 'unit', 'e2e']);
      expect(loops[1].stage.assembly.bundle.selection).toMatchObject({ full: true });
      expect(loops[1].verification.passed).toBe(true);
      // A loop pass is never a grant: only a final stage releases the marker.
      expect(await stackReadyAdds(stores)).toHaveLength(0);
      commit('round to 3');

      // 5. The second approval: a complete, passing, full-set final stage grants
      //    and publishes stack-ready in its own completion.
      const approved = await runPhase(stores, session, 'run-review-2', { review: approvingReviewHandler(session, 'run-review-2', finals) });
      expect(finals[1]).toMatchObject({ status: 'recorded', granted: true, route: { row: 7, disposition: 'grant' } });
      expect(approved.task.status).toBe('ready_for_human');
      expect(await stackReadyAdds(stores)).toHaveLength(1);
      const done = await stores.task.getTask(key);
      expect(progressOf(session, done)).toBe('final-passed');
      expect(done.context.finalStageGrant).toMatchObject({ runId: 'run-review-2', headSha: git(['rev-parse', 'HEAD']).trim() });
    } finally {
      closeStores(stores);
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// The required set, whatever changed (issue #1155)
// ---------------------------------------------------------------------------

describe('every loop stage covers the entire required set', () => {
  test('a change nothing could be mapped to still runs every required check', async () => {
    write('NOTES.txt', 'unmapped\n');
    const run = await loop(stagedSession(), { context: {} });
    expect(selectedNames(run)).toEqual(['lint', 'unit', 'e2e']);
    expect(run.stage.assembly.bundle.selection).toMatchObject({ full: true });
  }, 30_000);

  test('an untouched working tree runs every required check too', async () => {
    const run = await loop(stagedSession(), { context: {} });
    expect(selectedNames(run)).toEqual(['lint', 'unit', 'e2e']);
    expect(run.stage.assembly.bundle.selection).toMatchObject({ full: true });
  }, 30_000);
});

describe('legacy behavior', () => {
  test('an un-opted-in session runs the shipped full pass, records no stage and has no final stage', async () => {
    const session = stagedSession();
    delete session.stagedVerification;
    write('lib/rounding.sh', "printf '%s\\n' 5\n");
    writeFileSync(join(control, 'e2e-fails'), '');
    const run = await loop(session, { context: {} });
    expect(run.stage).toBeUndefined();
    expect(run.unavailable).toEqual({ status: 'unavailable', reason: 'disabled' });
    expect(run.verification.passed).toBe(false);
    expect(run.verification.results.map((result) => result.name)).toEqual(['lint', 'unit', 'e2e']);
    expect(existsSync(join(artifacts, 'verification-stage-loop-0.json'))).toBe(false);
    commit('legacy');
    const final = await finalStage(session, { sessionId: SESSION_ID, issueNumber: 1, attempts: {}, context: {} }, 'run-legacy');
    expect(final).toEqual({ status: 'disabled' });
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Isolation and operator amendment
// ---------------------------------------------------------------------------

describe('cross-Issue isolation', () => {
  test("one Issue's failing final evidence never reaches another Issue's row", async () => {
    const session = stagedSession();
    const stores = openStores();
    try {
      write('lib/rounding.sh', "printf '%s\\n' 6\n");
      commit('issue 51 change');
      writeFileSync(join(control, 'e2e-fails'), '');
      await enqueue(stores, 51, 'review');
      await runPhase(stores, session, 'run-review-51', { review: approvingReviewHandler(session, 'run-review-51', []) });
      await enqueue(stores, 52, 'implementation');

      const issue51 = await stores.task.getTask({ sessionId: SESSION_ID, issueNumber: 51 });
      const issue52 = await stores.task.getTask({ sessionId: SESSION_ID, issueNumber: 52 });
      expect(finalBundlesOf(issue51).map((bundle) => bundle.outcome)).toEqual(['code-failed']);
      expect(finalBundlesOf(issue52)).toEqual([]);
      expect(progressOf(session, issue51)).toBe('final-withheld');
      expect(progressOf(session, issue52)).toBe('no-final-evidence');

      // Both Issues run the same required set: coverage is a property of the
      // plan, not of what another Issue's final stage left behind.
      rmSync(join(control, 'e2e-fails'));
      write('lib/rounding.sh', "printf '%s\\n' 7\n");
      expect(selectedNames(await loop(session, issue52))).toEqual(['lint', 'unit', 'e2e']);
      expect(selectedNames(await loop(session, issue51))).toEqual(['lint', 'unit', 'e2e']);
    } finally {
      closeStores(stores);
    }
  }, 60_000);
});

describe('operator amendment', () => {
  test('an amendment invalidates earlier final evidence, and the next final stage grants on the amended plan', async () => {
    const session = stagedSession();
    const key = { sessionId: SESSION_ID, issueNumber: 61 };
    const stores = openStores();
    try {
      await enqueue(stores, 61, 'review');
      await runPhase(stores, session, 'run-review-61', { review: approvingReviewHandler(session, 'run-review-61', []) });
      const granted = await stores.task.getTask(key);
      expect(progressOf(session, granted)).toBe('final-passed');

      const applied = await amendTaskVerification(
        { store: stores.task, extract: extractIssueVerificationSections },
        {
          key,
          sessionVerification: session.verification,
          actorId: 'operator',
          reason: 'the unit suite must be demanded explicitly',
          operations: [{ kind: 'add', layer: 'requirement', command: 'sh checks/unit.sh', reason: 'explicit unit requirement' }],
          apply: true,
        },
      );
      expect(applied.status).toBe('applied');

      const amended = await stores.task.getTask(key);
      expect(progressOf(session, amended)).toBe('final-invalidated');

      const rerun = await finalStage(session, amended, 'run-review-61b');
      expect(rerun).toMatchObject({ status: 'recorded', reused: false, granted: true });
      expect(rerun.bundle.planDigest).toBe(resolveStageVerificationContext({ session, task: amended }).plan.planDigest);
      const requirement = rerun.bundle.checks.find((check) => check.checkId.startsWith('req:'));
      expect(requirement.verdict).toBe('passed');
    } finally {
      closeStores(stores);
    }
  }, 60_000);
});
