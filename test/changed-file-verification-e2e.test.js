// Issue #1156 — the §7 trace of docs/changed-file-verification-contract.md on a
// real project, end to end.
//
// What makes this different from `test/changed-file-verification-wiring.test.js`
// (#1154), which drives the same six steps against a *fake* Jest, and from
// `test/staged-verification-e2e.test.js`, which drives the non-test checks:
//
//   - The test runner is **this repository's real Jest**, over a plain-CommonJS
//     (non-TypeScript) project in a real git repository. Discovery is Jest's own
//     `--listTests --json`, the selected run is `--runTestsByPath`, and the
//     verdicts come from Jest's `--json` machine result — nothing here
//     hand-writes a report.
//   - The lanes are driven through the **real orchestration path**: the phase
//     runner claims each task from a durable SQLite store, the review lane is
//     the shipped `createReviewHandler`, and `status:stack-ready` is whatever
//     the completion actually enqueued on the outbox.
//
// Only the network (gh, fetch, pull, ls-remote) and the reviewer CLI are
// answered by the test. Every build, discovery and test command really runs.
//
// The six steps (§7), with inventory {A, B, C}:
//
//   1 implementation   Stage 1 [A]        passed   retained ∅    commit H1
//   2 review at H1     Stage 1 [A]        passed   retained ∅    reviewer approves
//   3 review approved  Stage 2 full       FAILED   retained {B}  needs_fix
//   4 implementation   Stage 1 [A, B]     passed   retained {B}  commit H2
//   5 review at H2     Stage 1 [A, B]     passed   retained {B}  reviewer approves
//   6 review approved  Stage 2 full       passed   retained {B}  GRANT

import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { createReviewHandler } from '../dist/handlers/review.js';
import { bothStreamsCommandRunner, defaultCommandRunner } from '../dist/handlers/command-runner.js';
import { runStage1TestVerification, withStage1ContextPatch } from '../dist/handlers/test-stage-verification.js';
import { runNextPhase } from '../dist/core/phase-runner.js';
import { SqliteTaskStore } from '../dist/stores/sqlite-task-store.js';
import { SqliteOutboxStore } from '../dist/stores/sqlite-outbox-store.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const JEST_BIN = join(ROOT, 'node_modules', 'jest', 'bin', 'jest.js');
const NODE = process.execPath;

const SESSION_ID = 'changed-file-e2e';
const ISSUE = 7;
const BRANCH = `ai/issue-${ISSUE}`;
const START_MS = Date.parse('2026-09-18T10:00:00.000Z');

const A = 'tests/a.test.cjs';
const B = 'tests/b.test.cjs';
const C = 'tests/c.test.cjs';

// The fixture project: `build.cjs` copies src/ into dist/, and the tests read
// dist/. `dist/` is ignored, so the build never moves the working-tree identity
// a stage run attests.
const BUILD_CJS = `const fs = require('fs');
const path = require('path');
const src = path.join(__dirname, 'src');
const dist = path.join(__dirname, 'dist');
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });
for (const name of fs.readdirSync(src)) fs.copyFileSync(path.join(src, name), path.join(dist, name));
`;

const JEST_CONFIG = `module.exports = {
  rootDir: __dirname,
  testEnvironment: 'node',
  testMatch: ['<rootDir>/tests/**/*.test.cjs'],
  transform: {},
  watchman: false,
};
`;

// A passes whatever the built value is, so the Issue's own changed test file
// stays green while the source defect is live. B is the file only the full
// suite reaches, and it is the one that fails and is retained.
const A_TEST = `test('A reads the built module', () => {
  expect(typeof require('../dist/values.cjs')).toBe('object');
});
`;
const B_TEST = `test('B checks the built answer', () => {
  expect(require('../dist/values.cjs').answer).toBe(42);
});
`;
const C_TEST = `test('C is arithmetic', () => {
  expect(1 + 1).toBe(2);
});
`;
// A file Jest reaches and reports as `skipped` — it executes no test, so it is
// never merged into a pass (contract §2 invariant 2, §3 R10).
const skipped = (name) => `test.skip('${name} is skipped', () => {
  expect(true).toBe(false);
});
`;

// Two predecessor test files, for the D5 stacked-base case. They are ordinary
// passing files: what matters is which side of the Issue base they sit on.
const PRED1 = 'tests/pred.test.cjs';
const PRED2 = 'tests/pred2.test.cjs';
const PRED_TEST = (name) => `test('${name} is the predecessor', () => {
  expect(1).toBe(1);
});
`;

let tmpDir;
let repo;
let artifactRoot;
let dbPath;
let tick;

const at = () => new Date(START_MS + (tick += 60_000)).toISOString();

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

// Issue #1166 / #1167: the operator's declaration that this bound entry
// discharges an Issue requirement spelled differently — the configuration
// `docs/staged-verification-operations.md` §6 tells an operator to write here.
// Absent by default, so every case above runs the shipped binding.
let requirementCommands;

beforeEach(() => {
  requirementCommands = undefined;
  tick = 0;
  // The real path: Jest reports and matches real paths, and the adapter turns
  // its absolute answers back into repository-relative file ids.
  tmpDir = realpathSync(mkdtempSync(join(tmpdir(), 'changed-file-e2e-')));
  repo = join(tmpDir, 'repo');
  artifactRoot = join(tmpDir, 'artifacts');
  dbPath = join(tmpDir, 'loop.db');
  mkdirSync(artifactRoot, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  for (const dir of ['src', 'tests', 'tools']) mkdirSync(join(repo, dir), { recursive: true });
  write('.gitignore', 'dist/\n');
  write('build.cjs', BUILD_CJS);
  write('jest.config.cjs', JEST_CONFIG);
  write('tools/lint.cjs', 'process.exit(0);\n');
  write('src/values.cjs', 'module.exports = { answer: 42 };\n');
  write(A, A_TEST);
  write(B, B_TEST);
  write(C, C_TEST);
  commit('fixture');
  // The base branch as origin knows it, without a remote: the Issue base is the
  // branch start read from `refs/remotes/origin/main`, and nothing fetches.
  git(['update-ref', 'refs/remotes/origin/main', head()]);
  git(['checkout', '-q', '-b', BRANCH]);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const session = () => ({
  sessionId: SESSION_ID,
  repoKey: 'changed-file-e2e',
  repoRoot: repo,
  githubRepo: 'org/changed-file-e2e',
  artifactDir: '.artifacts',
  artifactRoot,
  githubOwner: 'org',
  githubName: 'changed-file-e2e',
  workItemProvider: { provider: 'github-issues', auth: { mode: 'gh' } },
  repoHostProvider: { provider: 'github', auth: { mode: 'gh' } },
  defaults: { implementationAgent: 'claude', reviewAgent: 'codex' },
  verification: {
    lint: `"${NODE}" tools/lint.cjs`,
    test: `"${NODE}" "${JEST_BIN}"`,
  },
  stagedVerification: {
    enabled: true,
    testSuite: {
      test: {
        adapter: 'jest',
        setupCommand: `"${NODE}" build.cjs`,
        ...(requirementCommands !== undefined ? { requirementCommands } : {}),
      },
    },
  },
  labels: { active: 'ai:active', blocked: 'ai:blocked', readyForHuman: 'ai:ready-for-human' },
});

const PR_VIEW = JSON.stringify({
  number: 9,
  url: 'https://github.com/org/changed-file-e2e/pull/9',
  headRefName: BRANCH,
  baseRefName: 'main',
  state: 'OPEN',
  isCrossRepository: false,
});

/** Real git, real node (build, lint and Jest); the network and the reviewer are answered here. */
function hybridRunner(trace, { reviewer = 'No P1/P2 findings.' } = {}) {
  const ok = (stdout = '') => ({ stdout, stderr: '', exitCode: 0 });
  return {
    run(cmd, args, opts) {
      // The reviewer's own prompt rides stdin (`src/handlers/review.ts`, Codex
      // native lane), and it is the one observation point for the state the
      // lane holds *between* Stage 1 and Stage 2 — nothing is persisted at that
      // boundary — so the reviewer call carries it into the trace.
      trace.push({ cmd, args: [...args], ...(cmd === 'codex' ? { stdin: opts?.stdin ?? '' } : {}) });
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
      // Jest and the fixture's own tooling: both streams, because Jest writes
      // its report on stdout and everything else on stderr.
      if (cmd === NODE) return bothStreamsCommandRunner.run(cmd, args, opts);
      return ok();
    },
  };
}

/** What each real Jest invocation in a trace asked for: `discovery`, `full`, or the selected basenames. */
const testRuns = (trace) =>
  trace
    .filter((call) => call.cmd === NODE && call.args[0] === JEST_BIN)
    .map((call) => {
      if (call.args.includes('--listTests')) return 'discovery';
      const at_ = call.args.indexOf('--runTestsByPath');
      return at_ === -1 ? 'full' : call.args.slice(at_ + 1).map((file) => file.split('/').pop()).join('+');
    });

const reviewerIndex = (trace) => trace.findIndex((call) => call.cmd === 'codex');

/** The prompt the reviewer was actually given — the lane's state at the Stage 1/review boundary. */
const reviewerPrompt = (trace) => trace.find((call) => call.cmd === 'codex')?.stdin;

/**
 * Both halves of "review ran, and every full suite run came after it". Asserted
 * together because `reviewerIndex` is `-1` when no reviewer ran, and every
 * index compares greater than `-1`: the ordering claim is vacuous without the
 * reviewer-ran claim beside it.
 */
function expectFullRunsAfterReviewer(trace) {
  const reviewer = reviewerIndex(trace);
  expect(reviewer).toBeGreaterThanOrEqual(0);
  expect(fullRunIndexes(trace).every((index) => index > reviewer)).toBe(true);
}

const fullRunIndexes = (trace) =>
  trace.flatMap((call, index) =>
    call.cmd === NODE
    && call.args[0] === JEST_BIN
    && !call.args.includes('--listTests')
    && !call.args.includes('--runTestsByPath')
      ? [index]
      : []);

// ---------------------------------------------------------------------------
// The lanes, as the phase runner drives them over a durable store
// ---------------------------------------------------------------------------

function openStores() {
  return { task: new SqliteTaskStore(dbPath), outbox: new SqliteOutboxStore(dbPath) };
}

function closeStores(stores) {
  stores.task.close();
  stores.outbox.close();
}

/**
 * The implementation lane's verification moment, exactly as
 * `src/handlers/implementation.ts` makes it: Stage 1 in place of the bound suite
 * entry, with its state riding the completion through `withStage1ContextPatch`.
 * The agent turn itself is what the test stands in for.
 */
const implementationHandler = (runId, trace, observed) => async (task) => {
  const stage1 = await runStage1TestVerification({
    runner: hybridRunner(trace),
    session: session(),
    task,
    cwd: repo,
    lane: 'implementation',
    taskAttempt: 0,
    runId,
    baseBranch: 'main',
    artifactDir: artifactRoot,
  });
  observed.push(stage1);
  const result = stage1.route === 'continue'
    ? { result: 'success', context: {}, message: 'implemented' }
    : { result: 'needs_fix', context: {}, message: `stage 1: ${stage1.classification.result ?? 'unclassified'}` };
  return withStage1ContextPatch(task, result, stage1.contextPatch);
};

/** The shipped review handler, with only the worktree and the issue lock stubbed. */
const reviewHandler = (runId, trace, options) => {
  const handler = createReviewHandler(
    { session: session(), runId, workerId: 'w1' },
    hybridRunner(trace, options),
    (input) => ({
      ok: true,
      path: repo,
      worktreeId: `${input.sessionId}/issue-${input.issueNumber}`,
      branch: input.branch,
      created: false,
      branchReused: true,
    }),
    { acquire: () => ({ ok: true, locked: true, contextId: runId, sessionId: SESSION_ID }), release: () => ({ ok: true, released: true }) },
  );
  return handler;
};

async function runPhase(stores, runId, handlers) {
  const now = at();
  return runNextPhase({
    store: stores.task,
    request: { sessionId: SESSION_ID, workerId: 'w1', runId, now },
    handlers,
    outboxStore: stores.outbox,
    session: session(),
    now,
  });
}

const stackReadyAdds = async (stores) =>
  (await stores.outbox.listPending()).filter(
    (entry) => entry.topic === 'gh:label:add' && entry.payload.label === 'status:stack-ready',
  );

const retainedOf = (task) =>
  (task.context.stagedVerification?.retainedTestFiles ?? []).map((entry) => entry.file);

// ---------------------------------------------------------------------------
// The trace
// ---------------------------------------------------------------------------

describe("§7's six steps, with a real Jest over a non-TypeScript project", () => {
  test('selected-file pass → approval → full failure → retained file → full success → stack-ready', async () => {
    const key = { sessionId: SESSION_ID, issueNumber: ISSUE };
    let stores = openStores();
    try {
      await stores.task.enqueueTask({
        sessionId: SESSION_ID,
        issueNumber: ISSUE,
        phase: 'implementation',
        now: at(),
        context: {
          title: 'changed-file e2e',
          prUrl: 'https://github.com/org/changed-file-e2e/pull/9',
          branch: BRANCH,
          labels: [],
        },
      });

      // ---- Step 1. The agent changes A and a source file. Stage 1 runs A only.
      write('src/values.cjs', 'module.exports = { answer: 41 };\n');
      write(A, `${A_TEST}// touched by this Issue\n`);
      const implTrace1 = [];
      const stage1s = [];
      const impl1 = await runPhase(stores, 'run-impl-1', {
        implementation: implementationHandler('run-impl-1', implTrace1, stage1s),
      });
      expect(impl1.status).toBe('completed');
      expect(impl1.task).toMatchObject({ phase: 'review', status: 'queued' });
      expect(stage1s[0].record.result).toBe('passed');
      expect(stage1s[0].record.selection.files).toEqual([{ file: A, reasons: ['changed'] }]);
      // B and C were never executed, and the whole suite never ran.
      expect(testRuns(implTrace1)).toEqual(['discovery', 'a.test.cjs']);
      expect(fullRunIndexes(implTrace1)).toEqual([]);
      commit('H1');

      // ---- Steps 2 and 3. Review at H1: Stage 1 [A] passes, the reviewer
      //      approves, and only then does Stage 2 run the whole suite — where B
      //      fails on the live source defect. B is retained; nothing is granted.
      const reviewTrace1 = [];
      const rejected = await runPhase(stores, 'run-review-1', {
        review: reviewHandler('run-review-1', reviewTrace1),
      });
      expect(testRuns(reviewTrace1)).toEqual(['discovery', 'a.test.cjs', 'discovery', 'full']);
      // The full suite is the only thing that runs after the reviewer, never before.
      expect(fullRunIndexes(reviewTrace1).every((index) => index > reviewerIndex(reviewTrace1))).toBe(true);
      expect(rejected.task).toMatchObject({ phase: 'implementation', status: 'queued' });
      expect(await stackReadyAdds(stores)).toHaveLength(0);

      const afterFailure = await stores.task.getTask(key);
      expect(retainedOf(afterFailure)).toEqual([B]);
      // The failing Stage 2 clears any grant and names the failing file to the fix turn.
      expect(afterFailure.context.finalStageGrant).toBeFalsy();
      expect(afterFailure.context.reviewFeedback).toContain(B);

      // ---- A restart. The retained obligation is on the task row, not in a process.
      closeStores(stores);
      stores = openStores();
      expect(retainedOf(await stores.task.getTask(key))).toEqual([B]);

      // ---- Step 4. The fix touches the source only; Stage 1 still runs B,
      //      because a retained file stays selected until the Issue completes.
      write('src/values.cjs', 'module.exports = { answer: 42 };\n');
      const implTrace2 = [];
      const impl2 = await runPhase(stores, 'run-impl-2', {
        implementation: implementationHandler('run-impl-2', implTrace2, stage1s),
      });
      expect(impl2.task).toMatchObject({ phase: 'review', status: 'queued' });
      expect(stage1s[1].record.result).toBe('passed');
      expect(stage1s[1].record.selection.files).toEqual([
        { file: A, reasons: ['changed'] },
        { file: B, reasons: ['retained'] },
      ]);
      expect(testRuns(implTrace2)).toEqual(['discovery', 'a.test.cjs+b.test.cjs']);
      // C is still unproven by Stage 1 — that is what Stage 2 is for.
      expect(fullRunIndexes(implTrace2)).toEqual([]);
      expect(await stackReadyAdds(stores)).toHaveLength(0);
      commit('H2');

      // ---- Steps 5 and 6. Review at H2: Stage 1 [A, B], approval, a complete
      //      passing Stage 2 over the whole suite, and the grant.
      const reviewTrace2 = [];
      const approved = await runPhase(stores, 'run-review-2', {
        review: reviewHandler('run-review-2', reviewTrace2),
      });
      expect(testRuns(reviewTrace2)).toEqual(['discovery', 'a.test.cjs+b.test.cjs', 'discovery', 'full']);
      expectFullRunsAfterReviewer(reviewTrace2);
      expect(approved.task.status).toBe('ready_for_human');
      expect(await stackReadyAdds(stores)).toHaveLength(1);

      const granted = await stores.task.getTask(key);
      expect(granted.context.finalStageGrant).toMatchObject({ runId: 'run-review-2', headSha: head() });
      // A retained file stays retained after it passes, until the Issue completes.
      expect(retainedOf(granted)).toEqual([B]);
      const grantBundle = granted.context.stagedVerification.finalBundles.at(-1);
      expect(grantBundle.testFiles.result).toBe('passed');
      expect(grantBundle.testFiles.mode).toBe('full');
      // §8 invariant 4: C is reported only because the full run actually ran it.
      expect(grantBundle.testFiles.failedFiles).toEqual([]);
      expect(grantBundle.testFiles.outcomeCounts).toMatchObject({ passed: 3, failed: 0 });
    } finally {
      closeStores(stores);
    }
  }, 600_000);
});

// ---------------------------------------------------------------------------
// The measurable claim: an ordinary localized change never runs the suite
// before approval
// ---------------------------------------------------------------------------

describe('the pre-approval cycle never executes the whole suite', () => {
  test('a rejected review runs the changed file only, and no full run at all', async () => {
    write(A, `${A_TEST}// touched by this Issue\n`);
    commit('H1');
    const stores = openStores();
    try {
      await stores.task.enqueueTask({
        sessionId: SESSION_ID,
        issueNumber: ISSUE,
        phase: 'review',
        now: at(),
        context: {
          title: 'changed-file e2e',
          prUrl: 'https://github.com/org/changed-file-e2e/pull/9',
          branch: BRANCH,
          labels: [],
        },
      });
      const trace = [];
      const result = await runPhase(stores, 'run-review-reject', {
        review: reviewHandler('run-review-reject', trace, { reviewer: '[P1] Missing null check' }),
      });
      expect(result.task).toMatchObject({ phase: 'implementation', status: 'queued' });
      expect(testRuns(trace)).toEqual(['discovery', 'a.test.cjs']);
      expect(fullRunIndexes(trace)).toEqual([]);
      expect(await stackReadyAdds(stores)).toHaveLength(0);
      const task = await stores.task.getTask({ sessionId: SESSION_ID, issueNumber: ISSUE });
      expect(task.context.stagedVerification.loopBundles.at(-1).testFiles).toMatchObject({
        result: 'passed',
        mode: 'files',
      });
      // Nothing was retained: only a trusted failing Stage 2 adds an obligation.
      expect(retainedOf(task)).toEqual([]);
    } finally {
      closeStores(stores);
    }
  }, 300_000);
});

// ---------------------------------------------------------------------------
// Issue #1167 — the behaviors the operator guide's §6 configuration rests on,
// driven through the same real Jest and the same real lanes.
//
// `test/changed-file-verification-wiring.test.js` covers each of them against a
// scripted Jest. They are repeated here because a skip, a machine result and a
// discovery are exactly where a fake runner can agree with the adapter while a
// real one disagrees.
// ---------------------------------------------------------------------------

/** Enqueue the Issue straight into `phase`, with an optional Issue body. */
async function enqueue(stores, phase, context = {}) {
  await stores.task.enqueueTask({
    sessionId: SESSION_ID,
    issueNumber: ISSUE,
    phase,
    now: at(),
    context: {
      title: 'changed-file e2e',
      prUrl: 'https://github.com/org/changed-file-e2e/pull/9',
      branch: BRANCH,
      labels: [],
      ...context,
    },
  });
}

const storedTask = (stores) => stores.task.getTask({ sessionId: SESSION_ID, issueNumber: ISSUE });

describe('an Issue requiring `npm test` against the differently spelled bound suite', () => {
  // The literal requirement an ordinary Issue of this project carries
  // (AGENTS.md §Verification), against a suite command spelled otherwise —
  // here the fixture's own Jest invocation, as `npm run test:files` is there.
  const NPM_TEST = '## Verification\n\n- `npm test`\n';

  test('undeclared, the gate blocks on a command nothing ran: no reviewer, no full suite', async () => {
    write(A, `${A_TEST}// touched by this Issue\n`);
    commit('H1');
    const stores = openStores();
    try {
      await enqueue(stores, 'review', { body: NPM_TEST });
      const trace = [];
      const result = await runPhase(stores, 'run-review-npm-undeclared', {
        review: reviewHandler('run-review-npm-undeclared', trace),
      });
      expect(result.task.status).toBe('ready_for_human');
      const task = await storedTask(stores);
      expect(task.context.missingVerificationCommands).toEqual(['npm test']);
      expect(task.context.issueRequiredVerifications).toEqual([{ command: 'npm test', status: 'not_run' }]);
      // Nothing is inferred from the command text: the gate stops the lane
      // before the reviewer, so no full suite runs and nothing is granted.
      expect(reviewerIndex(trace)).toBe(-1);
      expect(fullRunIndexes(trace)).toEqual([]);
      expect(await stackReadyAdds(stores)).toHaveLength(0);
    } finally {
      closeStores(stores);
    }
  }, 300_000);

  test('declared, it is pending through review and only a complete Stage 2 passes it', async () => {
    requirementCommands = ['npm test'];
    write(A, `${A_TEST}// touched by this Issue\n`);
    commit('H1');
    const stores = openStores();
    try {
      await enqueue(stores, 'review', { body: NPM_TEST });
      const trace = [];
      const result = await runPhase(stores, 'run-review-npm-declared', {
        review: reviewHandler('run-review-npm-declared', trace),
      });
      // Stage 1 ran the changed file alone; the only full run sits after the reviewer.
      expect(testRuns(trace)).toEqual(['discovery', 'a.test.cjs', 'discovery', 'full']);
      expect(fullRunIndexes(trace)).toHaveLength(1);
      expectFullRunsAfterReviewer(trace);
      // The state at the Stage 1/review boundary, read off the prompt the
      // reviewer was handed: Stage 1 credited nothing towards `npm test`, which
      // is still pending its full-suite run when review begins.
      expect(reviewerPrompt(trace)).toContain(
        '- `npm test`: pending the full-suite run after review approval (Stage 2; not a passing result)',
      );
      expect(result.task.status).toBe('ready_for_human');
      const task = await storedTask(stores);
      // The completed Stage 2 — and nothing before it — turned pending into passed.
      expect(task.context.issueRequiredVerifications).toEqual([{ command: 'npm test', status: 'passed' }]);
      expect(task.context.finalStageGrant).toMatchObject({ runId: 'run-review-npm-declared', headSha: head() });
      expect(await stackReadyAdds(stores)).toHaveLength(1);
    } finally {
      closeStores(stores);
    }
  }, 300_000);

  test('a failing Stage 2 leaves the declared requirement pending and grants nothing', async () => {
    requirementCommands = ['npm test'];
    // The defect only B catches: Stage 1 passes, the full suite does not.
    write('src/values.cjs', 'module.exports = { answer: 41 };\n');
    write(A, `${A_TEST}// touched by this Issue\n`);
    commit('H1');
    const stores = openStores();
    try {
      await enqueue(stores, 'review', { body: NPM_TEST });
      const result = await runPhase(stores, 'run-review-npm-stage2-fail', {
        review: reviewHandler('run-review-npm-stage2-fail', []),
      });
      expect(result.task).toMatchObject({ phase: 'implementation', status: 'queued' });
      const task = await storedTask(stores);
      expect(task.context.issueRequiredVerifications).toEqual([
        { command: 'npm test', status: 'pending_full_suite' },
      ]);
      expect(task.context.finalStageGrant).toBeFalsy();
      expect(retainedOf(task)).toEqual([B]);
      expect(await stackReadyAdds(stores)).toHaveLength(0);
    } finally {
      closeStores(stores);
    }
  }, 300_000);
});

describe('D5 — the Issue base after an accepted predecessor update', () => {
  const dependencyBase = (sha, acceptedSha) => ({
    baseIssueNumber: 5,
    basePrNumber: 6,
    baseHeadRefName: 'ai/issue-5',
    basePrUrl: 'https://github.com/org/changed-file-e2e/pull/6',
    baseHeadSha: sha,
    ...(acceptedSha !== undefined ? { baseHeadAccepted: { sha: acceptedSha, evidence: 'stack-ready' } } : {}),
  });

  /** Predecessor v1, predecessor v2 (each adding a test file), then this Issue's own change. */
  function stackedHistory() {
    write(PRED1, PRED_TEST('pred'));
    commit('predecessor v1');
    const p1 = head();
    write(PRED2, PRED_TEST('pred2'));
    commit('predecessor v2');
    const p2 = head();
    write(A, `${A_TEST}// touched by this Issue\n`);
    commit('this issue');
    return { p1, p2 };
  }

  /**
   * Re-admit the Issue into the implementation lane against a new predecessor
   * head, the way intake re-queues a stacked Issue whose base moved: a real
   * compare-and-set write against the row exactly as the lanes left it, with
   * every other context key — the staged state included — carried through.
   */
  async function requeueWithBase(stores, base) {
    const current = await storedTask(stores);
    const replaced = await stores.task.replaceTask(
      {
        sessionId: SESSION_ID,
        issueNumber: ISSUE,
        phase: 'implementation',
        now: at(),
        context: { ...current.context, dependencyBase: base },
      },
      { status: current.status, phase: current.phase, revision: current.revision },
    );
    expect(replaced.ok).toBe(true);
    return replaced.value;
  }

  test('an accepted update advances the base, keeps the retained file and drops the old evidence', async () => {
    const { p1, p2 } = stackedHistory();
    const stores = openStores();
    try {
      await enqueue(stores, 'implementation', { dependencyBase: dependencyBase(p1, p1) });

      // ---- The old base, through the implementation lane. At p1 the
      //      predecessor's v2 file is inside this Issue's cumulative diff, so
      //      real Jest really runs it as one of this Issue's own changes.
      //      The source defect is the one only a full Stage 2 catches.
      write('src/values.cjs', 'module.exports = { answer: 41 };\n');
      const implTrace1 = [];
      const stage1s = [];
      const impl1 = await runPhase(stores, 'run-d5-impl-1', {
        implementation: implementationHandler('run-d5-impl-1', implTrace1, stage1s),
      });
      expect(impl1.task).toMatchObject({ phase: 'review', status: 'queued' });
      expect(stage1s[0].record.result).toBe('passed');
      expect(stage1s[0].record.selection.issueBase).toEqual({ sha: p1, source: 'dependency-base' });
      expect(stage1s[0].record.selection.files.map((entry) => entry.file)).toEqual([A, PRED2]);
      expect(testRuns(implTrace1)).toEqual(['discovery', 'a.test.cjs+pred2.test.cjs']);
      commit('H1');

      // ---- A failing Stage 2 at the old base: B becomes the Issue's retained
      //      obligation, and nothing is granted.
      const rejected = await runPhase(stores, 'run-d5-review-1', {
        review: reviewHandler('run-d5-review-1', []),
      });
      expect(rejected.task).toMatchObject({ phase: 'implementation', status: 'queued' });
      expect(retainedOf(await storedTask(stores))).toEqual([B]);
      expect(await stackReadyAdds(stores)).toHaveLength(0);

      // ---- The fix, then a complete passing Stage 2: a real grant, with real
      //      final evidence under it, recorded against the old base.
      write('src/values.cjs', 'module.exports = { answer: 42 };\n');
      const implTrace2 = [];
      const impl2 = await runPhase(stores, 'run-d5-impl-2', {
        implementation: implementationHandler('run-d5-impl-2', implTrace2, stage1s),
      });
      expect(impl2.task).toMatchObject({ phase: 'review', status: 'queued' });
      expect(stage1s[1].record.selection.files.map((entry) => entry.file)).toEqual([A, B, PRED2]);
      commit('H2');

      const approved = await runPhase(stores, 'run-d5-review-2', {
        review: reviewHandler('run-d5-review-2', []),
      });
      expect(approved.task.status).toBe('ready_for_human');
      expect(await stackReadyAdds(stores)).toHaveLength(1);

      // The granting evidence the advance has to invalidate really exists
      // before the advance — otherwise the assertions below prove nothing.
      const granted = await storedTask(stores);
      const grantedState = granted.context.stagedVerification;
      expect(granted.context.finalStageGrant).toMatchObject({ runId: 'run-d5-review-2', headSha: head() });
      expect(grantedState.issueBase).toEqual({ sha: p1, source: 'dependency-base' });
      expect(grantedState.finalBundles).toHaveLength(1);
      expect(grantedState.finalBundles.at(-1).testFiles).toMatchObject({ result: 'passed', mode: 'full' });
      expect(typeof grantedState.grantingStageRunKey).toBe('string');

      // ---- The predecessor's accepted head moves to v2, and the Issue is
      //      re-queued against it.
      await requeueWithBase(stores, dependencyBase(p2, p2));
      const afterTrace = [];
      const afterStage1s = [];
      const advanced = await runPhase(stores, 'run-d5-impl-3', {
        implementation: implementationHandler('run-d5-impl-3', afterTrace, afterStage1s),
      });
      expect(advanced.task).toMatchObject({ phase: 'review', status: 'queued' });
      const after = afterStage1s[0];
      expect(after.record.result).toBe('passed');
      expect(after.record.selection.issueBase).toEqual({
        sha: p2,
        source: 'dependency-base',
        advancedFrom: { sha: p1, source: 'dependency-base' },
      });
      // The predecessor's own file is now below the base: not this Issue's change.
      expect(after.record.selection.files).toEqual([
        { file: A, reasons: ['changed'] },
        { file: B, reasons: ['retained'] },
      ]);
      expect(testRuns(afterTrace)).toEqual(['discovery', 'a.test.cjs+b.test.cjs']);

      const state = (await storedTask(stores)).context.stagedVerification;
      expect(state.issueBase).toEqual({ sha: p2, source: 'dependency-base' });
      // The obligation is the Issue's, not a revision's.
      expect(retainedOf(await storedTask(stores))).toEqual([B]);
      // Every bundle recorded against the old base is gone — the Stage 2 the
      // grant rested on, and the pin naming it, included. Only this Stage 1 is
      // left, and no second stack-ready was published.
      expect(state.loopBundles).toHaveLength(1);
      expect(state.finalBundles).toEqual([]);
      expect(state.grantingStageRunKey).toBeUndefined();
      expect(await stackReadyAdds(stores)).toHaveLength(1);
    } finally {
      closeStores(stores);
    }
  }, 900_000);

  test('a head that moved with no acceptance of that exact commit never advances the base', async () => {
    const { p1, p2 } = stackedHistory();
    const stores = openStores();
    try {
      await enqueue(stores, 'implementation', { dependencyBase: dependencyBase(p1, p1) });
      const seeded = [];
      await runPhase(stores, 'run-d5-seed', {
        implementation: implementationHandler('run-d5-seed', [], seeded),
      });
      expect(seeded[0].record.selection.issueBase).toEqual({ sha: p1, source: 'dependency-base' });

      // The predecessor's head moved to v2, but only v1 was ever accepted.
      await requeueWithBase(stores, dependencyBase(p2, p1));
      const trace = [];
      const observed = [];
      const result = await runPhase(stores, 'run-d5-moved', {
        implementation: implementationHandler('run-d5-moved', trace, observed),
      });
      const blocked = observed[0];
      expect(blocked.record.result).toBe('unavailable');
      expect(blocked.record.selection).toEqual({ status: 'unavailable', reason: 'issue-base' });
      // Nothing launched, the recorded base stands on the row, and the lane
      // re-runs rather than re-basing.
      expect(testRuns(trace)).toEqual([]);
      expect(blocked.route).toBe('rerun');
      expect(result.task).toMatchObject({ phase: 'implementation', status: 'queued' });
      const state = (await storedTask(stores)).context.stagedVerification;
      expect(state.issueBase).toEqual({ sha: p1, source: 'dependency-base' });
    } finally {
      closeStores(stores);
    }
  }, 600_000);
});

describe('D6 — a stage that executed only skipped files', () => {
  test('an all-skipped Stage 1 is `empty`: review runs, and Stage 2 is still mandatory', async () => {
    write(A, skipped('A'));
    commit('A is skipped');
    const stores = openStores();
    try {
      await enqueue(stores, 'review');
      const trace = [];
      const result = await runPhase(stores, 'run-review-skip-stage1', {
        review: reviewHandler('run-review-skip-stage1', trace),
      });
      expect(testRuns(trace)).toEqual(['discovery', 'a.test.cjs', 'discovery', 'full']);
      // The reviewer ran (D6 allows code review), and the full suite after it.
      expect(reviewerIndex(trace)).toBeGreaterThan(-1);
      expect(fullRunIndexes(trace).every((index) => index > reviewerIndex(trace))).toBe(true);
      const task = await storedTask(stores);
      const stage1 = task.context.stagedVerification.loopBundles.at(-1).testFiles;
      // The run really executed: a non-empty selection, every outcome a skip.
      expect(stage1).toMatchObject({ result: 'empty', mode: 'files' });
      expect(stage1.selection.files).toEqual([{ file: A, reasons: ['changed'] }]);
      expect(stage1.outcomeCounts).toMatchObject({ passed: 0, failed: 0, skipped: 1 });
      // Only Stage 2 satisfies the full suite, and it did.
      expect(task.context.finalStageVerification.testStage).toMatchObject({ result: 'passed' });
      expect(result.task.status).toBe('ready_for_human');
      expect(await stackReadyAdds(stores)).toHaveLength(1);
    } finally {
      closeStores(stores);
    }
  }, 300_000);

  test('an all-skipped Stage 2 is `no-evidence`: it parks, grants nothing and is never repeated', async () => {
    for (const [file, name] of [[A, 'A'], [B, 'B'], [C, 'C']]) write(file, skipped(name));
    commit('every test is skipped');
    const stores = openStores();
    try {
      await enqueue(stores, 'review');
      const trace = [];
      const result = await runPhase(stores, 'run-review-skip-stage2', {
        review: reviewHandler('run-review-skip-stage2', trace),
      });
      expect(testRuns(trace)).toEqual([
        'discovery',
        'a.test.cjs+b.test.cjs+c.test.cjs',
        'discovery',
        'full',
      ]);
      // Exactly one full run: a no-evidence Stage 2 is never re-run automatically.
      expect(fullRunIndexes(trace)).toHaveLength(1);
      expect(result.task.status).toBe('ready_for_human');
      const task = await storedTask(stores);
      expect(task.context.stagedVerification.loopBundles.at(-1).testFiles.result).toBe('empty');
      expect(task.context.finalStageVerification.testStage).toMatchObject({ result: 'no-evidence' });
      expect(task.context.finalStageGrant ?? null).toBeNull();
      expect(await stackReadyAdds(stores)).toHaveLength(0);
    } finally {
      closeStores(stores);
    }
  }, 300_000);
});
