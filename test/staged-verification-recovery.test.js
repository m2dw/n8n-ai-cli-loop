// Issue #1106 — staged verification interruption and infrastructure recovery
// (docs/staged-verification-contract.md §7 rows 4–6 and 11–13, rule 3;
// docs/verification-evidence-validity-contract.md §4.5 rule 3, §5 rule 3,
// §7.1–§7.3).
//
// The acceptance cases this file owns: a process timeout whose cleanup could
// not confirm termination, a partial report, an OS/process interruption, stale
// evidence and a concurrent amendment — plus the bounded retries, the parks
// that preserve the worktree, and recovery of validation-only work that re-runs
// verification rather than an agent turn.

import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  LOOP_STAGE_RECOVERY_CONTEXT_KEY,
  admitVerificationOnlyResume,
  decideLoopStageRecovery,
  readLoopStageRecovery,
} from '../dist/core/stage-recovery.js';
import { aggregateStageOutcome, stageCheckTerminationUnconfirmed } from '../dist/core/stage-run.js';
import { readFinalStageApprovalContinuation } from '../dist/core/final-stage-gate.js';
import { runLoopStageVerification, runFinalStageVerification } from '../dist/handlers/stage-verification.js';
import { createImplementationHandler } from '../dist/handlers/implementation.js';
import { CLI_PROBE_INDETERMINATE_MARKER } from '../dist/core/cli-probe.js';

const KEY = LOOP_STAGE_RECOVERY_CONTEXT_KEY;
const HEAD = 'a'.repeat(40);
const MOVED = 'c'.repeat(40);
const NOW = '2026-09-13T10:00:00.000Z';

let tmpDir;
let artifactDir;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'stage-recovery-test-'));
  artifactDir = join(tmpDir, 'artifacts');
  mkdirSync(artifactDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** A deadline kill whose post-kill sweep could not signal a still-live group. */
const UNCONFIRMED_CLEANUP = {
  pid: 4242,
  processGroupTerminated: false,
  processGroupSignalError: 'EPERM',
  terminatedDescendants: [],
  forceKilled: [],
};
const CONFIRMED_CLEANUP = { pid: 4242, processGroupTerminated: true, terminatedDescendants: [], forceKilled: [] };

const timedOut = (processTreeCleanup) => ({
  stdout: 'output observed before the deadline',
  stderr: '',
  exitCode: 1,
  timedOut: true,
  signal: 'SIGTERM',
  ...(processTreeCleanup !== undefined ? { processTreeCleanup } : {}),
});

// ---------------------------------------------------------------------------
// The pure decision (#1096 §7.3)
// ---------------------------------------------------------------------------

describe('the loop-stage recovery decision', () => {
  const decide = (outcome, priorStreak, extra = {}) =>
    decideLoopStageRecovery({ outcome, priorStreak, maxAttempts: 2, ...extra });

  test('a verdict-bearing outcome resets the streak', () => {
    for (const outcome of ['passed', 'code-failed', 'timed-out']) {
      expect(decide(outcome, 2)).toEqual({ kind: 'reset' });
    }
  });

  test('infrastructure and interruption retry within the budget, then park', () => {
    expect(decide('infrastructure', 0)).toEqual({ kind: 'retry', record: { streak: 1, lastOutcome: 'infrastructure' } });
    expect(decide('interrupted', 1)).toEqual({ kind: 'retry', record: { streak: 2, lastOutcome: 'interrupted' } });
    expect(decide('infrastructure', 2)).toEqual({
      kind: 'park',
      reason: 'recovery-budget-exhausted',
      record: { streak: 3, lastOutcome: 'infrastructure' },
    });
  });

  // Issue #1155 retired #1094 §7 row 5's single re-run over the **entire**
  // required set: it existed to widen a narrowed selection on the run meant to
  // settle it, and a stage run already covers the whole required set. So
  // `unknown` now takes the same bounded retry as every other non-code
  // termination, with no inner bound of its own and no second park reason.
  test('unknown retries under the ordinary budget, with no full-set re-run of its own', () => {
    expect(decide('unknown', 0)).toEqual({ kind: 'retry', record: { streak: 1, lastOutcome: 'unknown' } });
    expect(decide('unknown', 1)).toEqual({ kind: 'retry', record: { streak: 2, lastOutcome: 'unknown' } });
    expect(decide('unknown', 2)).toEqual({
      kind: 'park',
      reason: 'recovery-budget-exhausted',
      record: { streak: 3, lastOutcome: 'unknown' },
    });
  });

  test('unknown is bounded exactly like infrastructure and interruption', () => {
    for (const priorStreak of [0, 1, 2]) {
      expect(decide('unknown', priorStreak)).toMatchObject({
        kind: decide('infrastructure', priorStreak).kind,
      });
    }
  });

  test('an unreadable record parks instead of retrying without a bound', () => {
    expect(readLoopStageRecovery({})).toEqual({ readable: true, streak: 0 });
    expect(readLoopStageRecovery({ [KEY]: null })).toEqual({ readable: true, streak: 0 });
    expect(readLoopStageRecovery({ [KEY]: 'three' }).readable).toBe(false);
    expect(readLoopStageRecovery({ [KEY]: { streak: -1, lastOutcome: 'unknown' } }).readable).toBe(false);
    // A verdict is never a recorded non-code termination.
    expect(readLoopStageRecovery({ [KEY]: { streak: 1, lastOutcome: 'passed' } }).readable).toBe(false);
    expect(decide('infrastructure', undefined)).toEqual({ kind: 'park', reason: 'recovery-state-unreadable' });
    // A verdict needs no budget, so even unreadable state resets on one.
    expect(decide('passed', undefined)).toEqual({ kind: 'reset' });
  });

  test('a verification-only resume needs every condition', () => {
    const recovery = readLoopStageRecovery({
      [KEY]: { streak: 1, lastOutcome: 'infrastructure', continuation: 'verification', runId: 'run-prev' },
    });
    const base = {
      recovery,
      activeDirtyContinuation: { runId: 'run-prev' },
      stagedVerificationEnabled: true,
      dispositionContractRendered: false,
    };
    expect(admitVerificationOnlyResume(base)).toBe(true);
    expect(admitVerificationOnlyResume({ ...base, stagedVerificationEnabled: false })).toBe(false);
    expect(admitVerificationOnlyResume({ ...base, dispositionContractRendered: true })).toBe(false);
    expect(admitVerificationOnlyResume({ ...base, activeDirtyContinuation: undefined })).toBe(false);
    // A capture from another run is not the work this continuation preserved.
    expect(admitVerificationOnlyResume({ ...base, activeDirtyContinuation: { runId: 'run-other' } })).toBe(false);
    expect(admitVerificationOnlyResume({
      ...base,
      recovery: readLoopStageRecovery({ [KEY]: { streak: 1, lastOutcome: 'infrastructure' } }),
    })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Process timeout and process-tree cleanup (#1096 §4.5 rule 3, §5 rule 3)
// ---------------------------------------------------------------------------

function commandRunner(results = {}, { onCommand = {} } = {}) {
  const calls = [];
  return {
    calls,
    argv: () => calls.map((call) => [call.cmd, ...call.args].join(' ')),
    run(cmd, args, opts) {
      calls.push({ cmd, args, opts });
      const argv = [cmd, ...args].join(' ');
      onCommand[argv]?.();
      if (cmd === 'git' && args[0] === 'rev-parse') return { stdout: `${HEAD}\n`, stderr: '', exitCode: 0 };
      if (cmd === 'git' && args[0] === 'status') return { stdout: '', stderr: '', exitCode: 0 };
      return results[argv] ?? { stdout: 'ok', stderr: '', exitCode: 0 };
    },
  };
}

describe('process timeout and process-tree cleanup', () => {
  test('only a live group the sweep could not signal is unconfirmed', () => {
    expect(stageCheckTerminationUnconfirmed({})).toBe(false);
    expect(stageCheckTerminationUnconfirmed({ processTreeCleanup: CONFIRMED_CLEANUP })).toBe(false);
    // No group was left to signal: the benign `false`.
    expect(stageCheckTerminationUnconfirmed({
      processTreeCleanup: { ...CONFIRMED_CLEANUP, processGroupTerminated: false },
    })).toBe(false);
    expect(stageCheckTerminationUnconfirmed({ processTreeCleanup: UNCONFIRMED_CLEANUP })).toBe(true);
  });

  test('a Windows taskkill that failed or was unavailable is unconfirmed, with no errno', () => {
    expect(stageCheckTerminationUnconfirmed({
      processTreeCleanup: {
        pid: 4242,
        processGroupTerminated: false,
        terminationUnconfirmed: true,
        terminatedDescendants: [],
        forceKilled: [],
        note: 'taskkill did not terminate the tree (exit 1); descendants may still be running',
      },
    })).toBe(true);
  });

  test('an unconfirmed kill outranks timed-out and infrastructure, and a pass beside it proves nothing', () => {
    const aggregation = aggregateStageOutcome({
      selectedCheckIds: ['exec:test', 'exec:lint'],
      checks: [
        { record: { checkId: 'exec:test', verdict: 'timed-out' }, terminationUnconfirmed: true },
        { record: { checkId: 'exec:lint', verdict: 'failed' }, hostFailure: true },
      ],
      runCompleted: true,
    });
    expect(aggregation.outcome).toBe('unknown');
    expect(aggregation.noVerdictCheckIds).toEqual(['exec:test']);
    expect(aggregation.unprovenCheckIds).toEqual(['exec:test', 'exec:lint']);

    const tainted = aggregateStageOutcome({
      selectedCheckIds: ['exec:test'],
      checks: [{ record: { checkId: 'exec:test', verdict: 'passed' }, terminationUnconfirmed: true }],
      runCompleted: true,
    });
    expect(tainted.outcome).toBe('unknown');
    expect(tainted.unprovenCheckIds).toEqual(['exec:test']);
  });

  test('a loop stage over an unconfirmed kill is unknown; a confirmed one stays timed-out', async () => {
    const session = { verification: { test: 'npm test' }, stagedVerification: { enabled: true } };
    const loop = (result) =>
      runLoopStageVerification({
        runner: commandRunner({ 'npm test': result }),
        session,
        task: { context: {} },
        cwd: tmpDir,
        lane: 'implementation',
        taskAttempt: 0,
        stageOrdinal: 0,
      });
    const tainted = await loop(timedOut(UNCONFIRMED_CLEANUP));
    expect(tainted.stage.assembly.bundle.outcome).toBe('unknown');
    // The shipped outcome the lane routes on is unchanged: still a failure.
    expect(tainted.verification.passed).toBe(false);
    const confirmed = await loop(timedOut(CONFIRMED_CLEANUP));
    expect(confirmed.stage.assembly.bundle.outcome).toBe('timed-out');
  });

  // Issue #1155: there is no narrowing left to widen. Every loop stage run
  // covers the entire required set, which is why row 5's full re-run is gone.
  test('every loop stage run covers the entire required set', async () => {
    const runner = commandRunner({});
    const run = await runLoopStageVerification({
      runner,
      session: {
        verification: { test: 'npm test', lint: 'npm run lint' },
        stagedVerification: { enabled: true },
      },
      task: { context: {} },
      cwd: tmpDir,
      lane: 'implementation',
      taskAttempt: 0,
      stageOrdinal: 1,
    });
    expect(runner.argv()).toEqual(expect.arrayContaining(['npm test', 'npm run lint']));
    expect(run.stage.assembly.bundle.selection.full).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The final stage: timeout, interruption, stale evidence, concurrent amendment
// ---------------------------------------------------------------------------

const STAGED = { enabled: true };
const SESSION = (stagedVerification = STAGED) => ({
  verification: { test: 'npm test', lint: 'npm run lint' },
  stagedVerification,
});
const TASK = (context = {}) => ({
  sessionId: 'sess-recovery',
  issueNumber: 9,
  phase: 'review',
  status: 'running',
  revision: 3,
  attempts: { review: 1 },
  context,
});

function finalRunner({ results = {}, throwOn, onCommand = {} } = {}) {
  const runner = commandRunner(results, { onCommand });
  const run = runner.run.bind(runner);
  return {
    ...runner,
    run(cmd, args, opts) {
      if (throwOn === [cmd, ...args].join(' ')) {
        runner.calls.push({ cmd, args, opts });
        throw new Error('host lost mid-run');
      }
      return run(cmd, args, opts);
    },
  };
}

const npmCalls = (runner) => runner.argv().filter((line) => line.startsWith('npm '));

/** A durable-store stand-in: every write lands, and a test can move the row underneath a run. */
function memoryStore(task) {
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
}

const finalStage = (runner, session = SESSION(), task = TASK(), extra = {}) =>
  runFinalStageVerification({
    runner,
    session,
    task,
    cwd: tmpDir,
    runId: 'run-final',
    taskAttempt: 1,
    artifactDir,
    now: () => NOW,
    ...extra,
  });

describe('final stage: process timeout', () => {
  test('a check killed at its deadline with unconfirmed cleanup parks (row 12) and taints the environment', async () => {
    const run = await finalStage(finalRunner({ results: { 'npm test': timedOut(UNCONFIRMED_CLEANUP) } }));
    expect(run.status).toBe('recorded');
    expect(run.bundle.outcome).toBe('unknown');
    expect(run.route).toEqual({ row: 12, disposition: 'operator' });
    expect(run.disposition).toBe('operator');
    expect(run.granted).toBe(false);
    expect(run.bundle.identityRecheck.environmentIdentity).toMatchObject({ state: 'unknown' });
    expect(run.context.finalStageGrant).toBeNull();
  });

  test('the same deadline with a confirmed cleanup is an ordinary timeout (row 10)', async () => {
    const run = await finalStage(finalRunner({ results: { 'npm test': timedOut(CONFIRMED_CLEANUP) } }));
    expect(run.bundle.outcome).toBe('timed-out');
    expect(run.route).toEqual({ row: 10, disposition: 'repair' });
    expect(run.bundle.identityRecheck.environmentIdentity.state).not.toBe('unknown');
  });
});

describe('final stage: OS/process interruption and restart', () => {
  const approval = {
    classification: { classification: 'success', reason: 'LGTM' },
    findingsContext: {},
  };

  test('a run that dies mid-stage leaves its approval durable, and the next claim re-runs only the final stage', async () => {
    const store = memoryStore(TASK());
    // A partial report: `npm test` ran and passed, then the process was lost.
    const crashing = finalRunner({ throwOn: 'npm run lint' });
    await expect(
      finalStage(crashing, SESSION(), store.box.current, { runId: 'run-0', store, approval }),
    ).rejects.toThrow('host lost');
    expect(npmCalls(crashing)).toEqual(['npm test', 'npm run lint']);

    const persisted = store.box.current.context;
    expect(persisted.stagedVerification.runs.map((entry) => entry.state)).toEqual(['allocated']);
    expect(persisted.stagedVerification.finalBundles).toEqual([]);
    // What the review lane reads before Step 4 on the next claim (#1103): the
    // approval, bound to the head it was verifying — and to nothing else.
    expect(readFinalStageApprovalContinuation(persisted.finalStageApproval, HEAD)).toEqual({ headSha: HEAD, approval });
    expect(readFinalStageApprovalContinuation(persisted.finalStageApproval, MOVED)).toBeUndefined();

    const runner = finalRunner();
    const resumed = await finalStage(runner, SESSION(), store.box.current, { runId: 'run-1', store, approval });
    // Never resumed, never partially credited: every check runs again under a fresh ordinal.
    expect(npmCalls(runner)).toEqual(['npm test', 'npm run lint']);
    expect(resumed.bundle.stageRunId.stageOrdinal).toBe(1);
    expect(resumed.context.stagedVerification.runs.map((entry) => entry.state)).toEqual(['interrupted', 'recorded']);
    expect(resumed.granted).toBe(true);
    // The completion consumes the continuation it resumed.
    expect(resumed.context.finalStageApproval).toBeNull();
  });

  test('repeated interruptions are bounded: past the budget the stage parks without launching', async () => {
    const store = memoryStore(TASK());
    const session = SESSION({ enabled: true, maxStageRecoveryAttempts: 1 });
    for (const runId of ['run-0', 'run-1']) {
      await expect(
        finalStage(finalRunner({ throwOn: 'npm test' }), session, store.box.current, { runId, store, approval }),
      ).rejects.toThrow('host lost');
    }
    const runner = finalRunner();
    const parked = await finalStage(runner, session, store.box.current, { runId: 'run-2', store, approval });
    expect(parked).toMatchObject({ status: 'withheld', disposition: 'operator', reason: 'recovery-budget-exhausted' });
    expect(npmCalls(runner)).toEqual([]);
    expect(parked.context.finalStageApproval).toBeNull();
  });

  test('without an approval nothing extra is persisted or cleared', async () => {
    const store = memoryStore(TASK());
    const run = await finalStage(finalRunner(), SESSION(), store.box.current, { store });
    expect(run.granted).toBe(true);
    expect('finalStageApproval' in run.context).toBe(false);
    expect(store.box.current.context.finalStageApproval).toBeUndefined();
  });
});

describe('final stage: stale evidence', () => {
  test('an infrastructure-failed bundle is never reused: the re-run executes every check again', async () => {
    const hostFailure = { stdout: '', stderr: 'spawn npm ENOENT', exitCode: 1 };
    const first = await finalStage(finalRunner({ results: { 'npm test': hostFailure } }), SESSION(), TASK(), { runId: 'run-0' });
    expect(first.disposition).toBe('host-retry');

    const runner = finalRunner();
    const again = await finalStage(runner, SESSION(), TASK(first.context), { runId: 'run-1' });
    expect(again.reused).toBe(false);
    expect(npmCalls(runner)).toEqual(['npm test', 'npm run lint']);
    expect(again.granted).toBe(true);
  });
});

describe('final stage: concurrent amendment', () => {
  test('a plan change that lands in the task row mid-run unbinds the grant and re-runs the stage', async () => {
    const store = memoryStore(TASK());
    const runner = finalRunner({
      onCommand: {
        // An Issue refresh written by another writer while the checks run: the
        // plan now demands a command the launch plan did not.
        'npm run lint': () => {
          store.box.current = {
            ...store.box.current,
            context: { ...store.box.current.context, body: '## Verification\n\n- `npm run lint`\n' },
          };
        },
      },
    });
    const run = await finalStage(runner, SESSION(), store.box.current, { store });
    expect(run.status).toBe('recorded');
    expect(run.route.row).toBe(7);
    expect(run.granted).toBe(false);
    expect(run.disposition).toBe('rerun');
    expect(run.bindingRefusals.length).toBeGreaterThan(0);
    expect(run.context.finalStageGrant).toBeNull();
  });

  test('an unchanged task row still grants', async () => {
    const store = memoryStore(TASK());
    const run = await finalStage(finalRunner(), SESSION(), store.box.current, { store });
    expect(run.granted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The implementation lane (§7 rows 4–6, #1096 §7.3)
// ---------------------------------------------------------------------------

describe('implementation lane recovery', () => {
  const PATCH = 'diff --git a/src/foo.ts b/src/foo.ts\n';
  let repoRoot;
  let artifactRoot;

  beforeEach(() => {
    repoRoot = join(tmpDir, 'repo');
    artifactRoot = join(tmpDir, 'run-artifacts');
  });

  const laneSession = (stagedVerification) => ({
    sessionId: 'addon-dev',
    repoKey: 'test-repo',
    repoRoot,
    githubRepo: 'm2dw/test-repo',
    artifactDir: '.n8n-artifacts',
    artifactRoot,
    githubOwner: 'm2dw',
    githubName: 'test-repo',
    defaults: { implementationAgent: 'claude', reviewAgent: 'codex', researchAgent: 'gemini' },
    verification: { test: 'npm test' },
    labels: { active: 'ai:active', blocked: 'ai:blocked', readyForHuman: 'ai:ready-for-human' },
    ...(stagedVerification !== undefined ? { stagedVerification } : {}),
  });

  const laneTask = (context = {}) => ({
    sessionId: 'addon-dev',
    issueNumber: 77,
    status: 'running',
    phase: 'implementation',
    priority: 'normal',
    implementationAgent: 'claude',
    attempts: {},
    context: {
      title: 'Add login rate limiting',
      url: 'https://github.com/m2dw/test-repo/issues/77',
      labels: ['agent:claude', 'status:needs-implementation'],
      ...context,
    },
    createdAt: '2026-09-13T00:00:00.000Z',
    updatedAt: '2026-09-13T00:00:00.000Z',
  });

  /**
   * Answers by command. `dirty` makes the issue worktree (never the canonical
   * checkout) report the preserved edit a dirty continuation carries.
   */
  function laneRunner({ testResults = [{ stdout: 'PASS', exitCode: 0 }], dirty = false } = {}) {
    const calls = [];
    let testIndex = 0;
    return {
      calls,
      argv: () => calls.map((call) => [call.cmd, ...call.args].join(' ')),
      /** Agent turns — the initial agent and any repair agent — are the calls given a prompt. */
      agentCalls: () => calls.filter((call) => call.cmd !== 'git' && typeof call.opts?.stdin === 'string'),
      run(cmd, args, opts = {}) {
        calls.push({ cmd, args, opts });
        const argv = [cmd, ...args].join(' ');
        if (argv === 'npm test') {
          const result = testResults[Math.min(testIndex, testResults.length - 1)];
          testIndex += 1;
          return { stdout: '', stderr: '', ...result };
        }
        if (cmd === 'git') {
          if (args[0] === 'status' && !args.includes('-z')) {
            return { stdout: dirty && opts.cwd !== repoRoot ? ' M src/foo.ts\n' : '', stderr: '', exitCode: 0 };
          }
          if (args[0] === 'status') return { stdout: ' M src/foo.ts\0', stderr: '', exitCode: 0 };
          if (args[0] === 'diff' && args[1] === '--stat') return { stdout: '1 file changed', stderr: '', exitCode: 0 };
          if (args[0] === 'diff') return { stdout: PATCH, stderr: '', exitCode: 0 };
          if (args[0] === 'ls-files') return { stdout: 'src/foo.ts\0', stderr: '', exitCode: 0 };
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (cmd === 'gh') {
          return args.includes('create')
            ? { stdout: 'https://github.com/m2dw/test-repo/pull/99', stderr: '', exitCode: 0 }
            : { stdout: '[]', stderr: '', exitCode: 0 };
        }
        return { stdout: 'Implemented changes.', stderr: '', exitCode: 0 };
      },
    };
  }

  const worktreeResolver = (overrides = {}) => {
    const path = join(tmpDir, 'wt', 'addon-dev', 'issue-77', 'repo');
    return (input) => ({
      ok: true,
      path,
      worktreeId: `${input.sessionId}/issue-${input.issueNumber}`,
      branch: input.branch,
      created: true,
      branchReused: false,
      startedFromRemoteHead: false,
      ...overrides,
    });
  };

  const runLane = (session, runner, task = laneTask(), resolverOverrides = {}) =>
    createImplementationHandler(
      { session, runId: 'run-stage-1', workerId: 'worker-test' },
      runner,
      undefined,
      worktreeResolver(resolverOverrides),
    )(task);

  const runArtifacts = () => join(artifactRoot, 'runs', 'run-stage-1');
  const committed = (runner) => runner.argv().some((line) => line.startsWith('git commit'));

  // Issue #1155 retired #1094 §7 row 5's re-run-the-whole-set-once path with
  // the selection policy it widened: the one run already covered the entire
  // required set. An `unknown` now takes the same bounded, agent-free retry as
  // rows 4 and 6, which is what these two pin — the phase run verifies ONCE.
  test('an unknown loop stage verifies once and delays a bounded retry, work preserved', async () => {
    const runner = laneRunner({ testResults: [timedOut(UNCONFIRMED_CLEANUP)] });
    const result = await runLane(laneSession({ enabled: true, maxStageRecoveryAttempts: 5 }), runner);

    expect(result.result).toBe('delayed');
    // The claim #1155 rests on: no second, wider run — there is no wider run.
    expect(runner.argv().filter((line) => line === 'npm test')).toHaveLength(1);
    // No repair agent: an integrity failure is never fix input (§7 rule 3).
    expect(runner.agentCalls()).toHaveLength(1);
    // No unconditional discard and nothing unproven committed.
    expect(committed(runner)).toBe(false);
    expect(result.context.dirtyContinuation).toMatchObject({
      commitSkipped: true,
      patchArtifactFile: 'implementation-dirty-patch.patch',
    });
    expect(result.context[KEY]).toEqual({
      streak: 1,
      lastOutcome: 'unknown',
      continuation: 'verification',
      runId: 'run-stage-1',
    });
    const bundle = JSON.parse(readFileSync(join(runArtifacts(), 'verification-stage-loop-0.json'), 'utf8'));
    expect(bundle.selection.full).toBe(true);
    expect(bundle.outcome).toBe('unknown');
  });

  test('the retry re-verifies the preserved worktree and continues on the shipped route', async () => {
    const session = laneSession({ enabled: true, maxStageRecoveryAttempts: 5 });
    const first = await runLane(session, laneRunner({ testResults: [timedOut(UNCONFIRMED_CLEANUP)] }));
    expect(first.result).toBe('delayed');

    const runner = laneRunner({ dirty: true });
    const result = await runLane(
      session,
      runner,
      laneTask({ dirtyContinuation: first.context.dirtyContinuation, [KEY]: first.context[KEY] }),
      { created: false, branchReused: true },
    );
    expect(result.result).toBe('success');
    // Verification only: the retry costs no agent turn (#1094 §7 rule 3).
    expect(runner.agentCalls()).toHaveLength(0);
    expect(runner.argv().filter((line) => line === 'npm test')).toHaveLength(1);
    // A verdict resets the streak.
    expect(result.context[KEY]).toBeNull();
    expect(result.context.verificationStage).toMatchObject({ outcome: 'passed', full: true });
  });

  test('consecutive unknown terminations past the budget park with the work preserved', async () => {
    const runner = laneRunner({ testResults: [timedOut(UNCONFIRMED_CLEANUP)] });
    const task = laneTask({ [KEY]: { streak: 2, lastOutcome: 'unknown' } });
    const result = await runLane(laneSession({ enabled: true, maxStageRecoveryAttempts: 2 }), runner, task);

    expect(result.result).toBe('failed');
    expect(result.error).toMatch(/recovery-budget-exhausted/);
    expect(result.error).toMatch(/no admissible verdict for: test/);
    expect(runner.argv().filter((line) => line === 'npm test')).toHaveLength(1);
    expect(runner.agentCalls()).toHaveLength(1);
    expect(committed(runner)).toBe(false);
    expect(result.context.dirtyContinuation).toMatchObject({ commitSkipped: true });
    expect(result.context[KEY]).toBeNull();
  });

  test('a transient host failure delays without an agent turn and preserves the work for verification', async () => {
    const runner = laneRunner({
      testResults: [{ stdout: `doctor ${CLI_PROBE_INDETERMINATE_MARKER} timed out`, exitCode: 1 }],
    });
    const result = await runLane(laneSession({ enabled: true, maxStageRecoveryAttempts: 3 }), runner);
    expect(result.result).toBe('delayed');
    expect(runner.agentCalls()).toHaveLength(1);
    expect(committed(runner)).toBe(false);
    expect(result.context[KEY]).toEqual({
      streak: 1,
      lastOutcome: 'infrastructure',
      continuation: 'verification',
      runId: 'run-stage-1',
    });
    expect(result.context.dirtyContinuation).toMatchObject({ runId: 'run-stage-1', commitSkipped: true });
  });

  test('a stage retry after the legacy transient budget is spent still delays without a repair cycle', async () => {
    const runner = laneRunner({
      testResults: [{ stdout: `doctor ${CLI_PROBE_INDETERMINATE_MARKER} timed out`, exitCode: 1 }],
    });
    // Two prior probe failures: #934's transient budget (2) is spent, the stage's (3) is not.
    const task = laneTask({
      [KEY]: { streak: 2, lastOutcome: 'infrastructure' },
      verificationTransientRetriesByStep: { test: 2 },
    });
    const result = await runLane(laneSession({ enabled: true, maxStageRecoveryAttempts: 3 }), runner, task);
    expect(result.result).toBe('delayed');
    expect(runner.agentCalls()).toHaveLength(1);
    expect(committed(runner)).toBe(false);
    expect(result.context.verificationRepairCycles).toBeUndefined();
    expect(result.context[KEY]).toEqual({
      streak: 3,
      lastOutcome: 'infrastructure',
      continuation: 'verification',
      runId: 'run-stage-1',
    });
    expect(result.context.dirtyContinuation).toMatchObject({ runId: 'run-stage-1', commitSkipped: true });
  });

  test('consecutive non-code terminations past the budget park instead of retrying', async () => {
    const runner = laneRunner({
      testResults: [{ stdout: `doctor ${CLI_PROBE_INDETERMINATE_MARKER} timed out`, exitCode: 1 }],
    });
    const task = laneTask({ [KEY]: { streak: 2, lastOutcome: 'infrastructure' } });
    const result = await runLane(laneSession({ enabled: true, maxStageRecoveryAttempts: 2 }), runner, task);
    expect(result.result).toBe('failed');
    expect(result.error).toMatch(/recovery-budget-exhausted/);
    expect(result.error).toMatch(/3 consecutive non-code loop-stage termination/);
    expect(runner.agentCalls()).toHaveLength(1);
    expect(committed(runner)).toBe(false);
    expect(result.context.dirtyContinuation).toMatchObject({ commitSkipped: true });
    // Reset on the way out, as #934 resets its repair budget: a requeue starts fresh.
    expect(result.context[KEY]).toBeNull();
  });

  describe('recovering validation-only work', () => {
    const marker = {
      issueNumber: 77,
      phase: 'implementation',
      runId: 'run-prev-1',
      branch: 'ai/issue-77',
      worktreeId: 'addon-dev/issue-77',
      verificationName: 'test',
      verificationExitCode: 1,
      dirtyFiles: ['src/foo.ts'],
      patchArtifactFile: 'implementation-dirty-patch.patch',
      timestamp: NOW,
      commitSkipped: true,
    };
    const continuation = { streak: 1, lastOutcome: 'infrastructure', continuation: 'verification', runId: 'run-prev-1' };

    beforeEach(() => {
      const priorDir = join(artifactRoot, 'runs', 'run-prev-1');
      mkdirSync(priorDir, { recursive: true });
      writeFileSync(join(priorDir, 'implementation-dirty-patch.patch'), PATCH, 'utf8');
    });

    test('re-verifies the preserved worktree without an implementation agent turn', async () => {
      const runner = laneRunner({ dirty: true });
      const result = await runLane(
        laneSession({ enabled: true }),
        runner,
        laneTask({ dirtyContinuation: marker, [KEY]: continuation }),
        { created: false, branchReused: true },
      );
      expect(result.result).toBe('success');
      expect(runner.agentCalls()).toHaveLength(0);
      expect(runner.argv()).toContain('npm test');
      expect(result.context[KEY]).toBeNull();
      expect(existsSync(join(runArtifacts(), 'implementation-output.md'))).toBe(true);
      expect(readFileSync(join(runArtifacts(), 'implementation-output.md'), 'utf8')).toContain('Verification-only resume');
    });

    test('an un-opted-in session runs the agent exactly as before', async () => {
      const runner = laneRunner({ dirty: true });
      const result = await runLane(
        laneSession(undefined),
        runner,
        laneTask({ dirtyContinuation: marker, [KEY]: continuation }),
        { created: false, branchReused: true },
      );
      expect(result.result).toBe('success');
      expect(runner.agentCalls()).toHaveLength(1);
    });

    test('a continuation bound to another run is not honored', async () => {
      const runner = laneRunner({ dirty: true });
      const result = await runLane(
        laneSession({ enabled: true }),
        runner,
        laneTask({ dirtyContinuation: marker, [KEY]: { ...continuation, runId: 'run-elsewhere' } }),
        { created: false, branchReused: true },
      );
      expect(result.result).toBe('success');
      expect(runner.agentCalls()).toHaveLength(1);
    });
  });
});
