// Issue #1103 — the per-Issue `final` stage after review approval, and the
// stack-ready grant it earns (docs/staged-verification-contract.md §13 slices
// S9 and S10).
//
// The §14 rows this file owns: "Transitions (§7)" for rows 7, 9, 10, 13 and the
// §8 head-binding re-run, "Ordering (§8)" end to end through `runNextPhase` —
// the grant and the bundle commit in one completion, partial verification never
// publishes, a moved head suppresses the grant — plus the issue's acceptance
// cases: full pass, failure, stale revision, interruption and repeated
// publication.

import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  runFinalStageVerification,
  contextOnlyStagedVerificationStore,
  readRemoteRefHead,
} from '../dist/handlers/stage-verification.js';
import { ensureEnvironmentPrepared } from '../dist/handlers/environment-prepare.js';
import { decideStackReadyPublication } from '../dist/core/final-stage-gate.js';
import { allocateStageRun } from '../dist/core/staged-verification-state.js';
import { enqueueStatusLabelEffects } from '../dist/core/outbox-effects.js';
import { runNextPhase } from '../dist/core/phase-runner.js';
import { SqliteTaskStore } from '../dist/stores/sqlite-task-store.js';
import { SqliteOutboxStore } from '../dist/stores/sqlite-outbox-store.js';

const HEAD = 'a'.repeat(40);
const MOVED = 'c'.repeat(40);
const RUN_ID = 'run-1';
const NOW = '2026-09-13T10:00:00.000Z';
const OUTPUT_TOKEN = 'FINAL-STAGE-OUTPUT-BYTES';

let tmpDir;
let artifactDir;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'final-stage-test-'));
  artifactDir = join(tmpDir, 'artifacts');
  mkdirSync(artifactDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const STAGED = { enabled: true };

const SESSION = (stagedVerification = STAGED, verification = { test: 'npm test', lint: 'npm run lint' }) => ({
  verification,
  ...(stagedVerification !== undefined ? { stagedVerification } : {}),
});

const TASK = (context = {}) => ({
  sessionId: 'sess-final',
  issueNumber: 7,
  phase: 'review',
  status: 'running',
  revision: 3,
  attempts: { review: 1 },
  context,
});

/**
 * Answers by command. `heads` is consumed one `git rev-parse HEAD` at a time,
 * so `[HEAD, MOVED]` is a head that moved under the run.
 */
function finalRunner({ results = {}, heads = [HEAD], status = '', throwOn } = {}) {
  const calls = [];
  let headIndex = 0;
  return {
    calls,
    argv: () => calls.map((call) => [call.cmd, ...call.args].join(' ')),
    run(cmd, args, opts) {
      calls.push({ cmd, args, opts });
      const argv = [cmd, ...args].join(' ');
      if (cmd === 'git' && args[0] === 'rev-parse') {
        const head = heads[Math.min(headIndex, heads.length - 1)];
        headIndex += 1;
        return { stdout: `${head}\n`, stderr: '', exitCode: 0 };
      }
      if (cmd === 'git' && args[0] === 'status') return { stdout: status, stderr: '', exitCode: 0 };
      if (cmd === 'select-checks') throw new Error('the final stage must never consult the selection adapter');
      if (throwOn === argv) throw new Error('host lost mid-run');
      return results[argv] ?? { stdout: OUTPUT_TOKEN, stderr: '', exitCode: 0 };
    },
  };
}

const finalStage = (runner, session = SESSION(), task = TASK(), extra = {}) =>
  runFinalStageVerification({
    runner,
    session,
    task,
    cwd: tmpDir,
    runId: RUN_ID,
    taskAttempt: 1,
    artifactDir,
    ...extra,
  });

const npmCalls = (runner) => runner.argv().filter((line) => line.startsWith('npm '));

const reviewAttempt = (task) =>
  typeof task.attempts?.review === 'number' ? task.attempts.review : 0;

// ---------------------------------------------------------------------------
// §10 rule 1 and the withheld cases
// ---------------------------------------------------------------------------

describe('before any stage runs', () => {
  test('an un-opted-in session runs nothing and keeps the shipped grant', async () => {
    const runner = finalRunner();
    // Not `SESSION(undefined)`: an explicit `undefined` takes the STAGED default.
    const unOptedIn = { verification: { test: 'npm test', lint: 'npm run lint' } };
    expect(await finalStage(runner, unOptedIn)).toEqual({ status: 'disabled' });
    expect(runner.calls).toHaveLength(0);
  });

  test('an opted-in session with nothing to execute withholds the grant without parking', async () => {
    const run = await finalStage(finalRunner(), SESSION(STAGED, {}));
    expect(run.status).toBe('withheld');
    expect(run.disposition).toBe('withhold-only');
    expect(run.reason).toBe('no-execution-checks');
    expect(decideStackReadyPublication({ stagedVerification: STAGED, context: run.context, runId: RUN_ID }))
      .toEqual({ kind: 'withhold', reason: 'no-grant-declared' });
  });

  test('a tracked modification in the approved worktree launches nothing and parks', async () => {
    const runner = finalRunner({ status: ' M src/foo.ts\0' });
    const run = await finalStage(runner);
    expect(run).toMatchObject({ status: 'withheld', disposition: 'operator', reason: 'worktree-not-clean' });
    expect(npmCalls(runner)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Full pass — row 7
// ---------------------------------------------------------------------------

describe('full pass (row 7)', () => {
  test('runs the entire required set, records the bundle and declares the grant', async () => {
    const runner = finalRunner();
    // Issue #1155: there is no operator setting left that could narrow a stage.
    const session = SESSION({ enabled: true });
    const run = await finalStage(runner, session, TASK(), { commandTimeoutMs: 1234 });

    expect(run.status).toBe('recorded');
    expect(run.route).toEqual({ row: 7, disposition: 'grant' });
    expect(run.granted).toBe(true);
    expect(run.reused).toBe(false);
    expect(npmCalls(runner)).toEqual(['npm test', 'npm run lint']);
    // #1090: every final check runs under the review lane's deadline.
    const npmOpts = runner.calls.filter((call) => call.cmd === 'npm').map((call) => call.opts);
    expect(npmOpts.every((opts) => opts.timeout === 1234 && opts.isolateProcessGroup === true)).toBe(true);

    expect(run.bundle.selection).toMatchObject({ full: true });
    expect(run.bundle.selection.checkIds).toEqual(['exec:test', 'exec:lint']);
    expect(run.bundle.headSha).toBe(HEAD);
    expect(run.bundle.identity.testedRevision).toEqual({ state: 'value', value: HEAD });

    const state = run.context.stagedVerification;
    expect(state.grantingStageRunKey).toBe('1/review/final/0');
    expect(state.runs.map((entry) => entry.state)).toEqual(['recorded']);
    expect(run.context.finalStageGrant).toEqual({ runId: RUN_ID, stageRunKey: '1/review/final/0', headSha: HEAD });
    expect(run.context.finalStageVerification).toMatchObject({ status: 'recorded', row: 7, granted: true });
    // §10 rule 5: the public record carries names and verdicts, never output.
    expect(JSON.stringify(run.context.finalStageVerification)).not.toContain(OUTPUT_TOKEN);

    expect(existsSync(join(artifactDir, 'review-final-verification-stage-final-0.json'))).toBe(true);
    expect(decideStackReadyPublication({ stagedVerification: STAGED, context: run.context, runId: RUN_ID }))
      .toEqual({ kind: 'grant', stageRunKey: '1/review/final/0' });
  });
});

// ---------------------------------------------------------------------------
// Failure — rows 9, 10 and 13
// ---------------------------------------------------------------------------

describe('failure', () => {
  test('a failing required check routes to repair (row 9) and never declares a grant', async () => {
    const runner = finalRunner({ results: { 'npm test': { stdout: 'boom', stderr: '', exitCode: 1 } } });
    const run = await finalStage(runner);

    expect(run.status).toBe('recorded');
    expect(run.route).toEqual({ row: 9, disposition: 'repair' });
    expect(run.disposition).toBe('repair');
    expect(run.granted).toBe(false);
    expect(run.bundle.outcome).toBe('code-failed');
    expect(run.bundle.complete).toBe(false);
    const lint = run.bundle.checks.find((check) => check.checkId === 'exec:lint');
    expect(lint).toMatchObject({ verdict: 'not-run', notRunKind: 'first-failure-stop' });

    expect(run.context.finalStageGrant).toBeNull();
    expect(run.context.stagedVerification.grantingStageRunKey).toBeUndefined();
    expect(decideStackReadyPublication({ stagedVerification: STAGED, context: run.context, runId: RUN_ID }))
      .toEqual({ kind: 'withhold', reason: 'no-grant-declared' });
  });

  test('a check that overran its deadline routes as a failure (row 10), never as a pass', async () => {
    const runner = finalRunner({
      results: { 'npm run lint': { stdout: '', stderr: '', exitCode: 1, timedOut: true } },
    });
    const run = await finalStage(runner);
    expect(run.bundle.outcome).toBe('timed-out');
    expect(run.route).toEqual({ row: 10, disposition: 'repair' });
    expect(run.granted).toBe(false);
  });

  test('an infrastructure failure re-runs (row 13), and a streak past the budget parks', async () => {
    const hostFailure = { stdout: '', stderr: 'spawn npm ENOENT', exitCode: 1 };
    let context = {};
    const outcomes = [];
    for (let i = 0; i < 3; i += 1) {
      const run = await finalStage(
        finalRunner({ results: { 'npm test': hostFailure } }),
        SESSION({ enabled: true, maxStageRecoveryAttempts: 1 }),
        TASK(context),
        { runId: `run-${i}` },
      );
      outcomes.push([run.route.row, run.disposition, run.granted]);
      context = run.context;
    }
    expect(outcomes).toEqual([
      [13, 'host-retry', false],
      [13, 'operator', false],
      [13, 'operator', false],
    ]);
  });

  test('a budget at or above the pruned ledger window still parks once the streak passes it', async () => {
    const hostFailure = { stdout: '', stderr: 'spawn npm ENOENT', exitCode: 1 };
    let context = {};
    const dispositions = [];
    for (let i = 0; i < 53; i += 1) {
      const run = await finalStage(
        finalRunner({ results: { 'npm test': hostFailure } }),
        SESSION({ enabled: true, maxStageRecoveryAttempts: 50 }),
        TASK(context),
        { runId: `run-${i}` },
      );
      dispositions.push(run.disposition);
      context = run.context;
    }
    expect(context.stagedVerification.runs.length).toBeLessThanOrEqual(50);
    expect(context.stagedVerification.finalRecoveryStreak).toBe(53);
    expect(dispositions.slice(0, 50).every((d) => d === 'host-retry')).toBe(true);
    expect(dispositions.slice(50)).toEqual(['operator', 'operator', 'operator']);
  }, 30_000);

  test('a code verdict ends the recovery streak', async () => {
    const session = SESSION({ enabled: true, maxStageRecoveryAttempts: 1 });
    const hostFailure = finalRunner({ results: { 'npm test': { stdout: '', stderr: 'spawn npm ENOENT', exitCode: 1 } } });
    const first = await finalStage(hostFailure, session, TASK(), { runId: 'run-0' });
    expect(first.context.stagedVerification.finalRecoveryStreak).toBe(1);
    const failing = finalRunner({ results: { 'npm test': { stdout: 'boom', stderr: '', exitCode: 1 } } });
    const second = await finalStage(failing, session, TASK(first.context), { runId: 'run-1' });
    expect(second.disposition).toBe('repair');
    expect(second.context.stagedVerification.finalRecoveryStreak).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Stale revision — §8 head binding at enqueue
// ---------------------------------------------------------------------------

describe('stale revision', () => {
  test('a head that moves under a passing run suppresses the grant and re-runs the stage', async () => {
    const runner = finalRunner({ heads: [HEAD, MOVED] });
    const run = await finalStage(runner);

    expect(run.status).toBe('recorded');
    expect(run.route.row).toBe(7);
    expect(run.granted).toBe(false);
    expect(run.disposition).toBe('rerun');
    const reasons = run.bindingRefusals.map((refusal) => refusal.reason);
    expect(reasons).toEqual(expect.arrayContaining(['head-mismatch', 'identity-recheck-mismatch']));
    expect(run.context.finalStageGrant).toBeNull();
    expect(run.context.stagedVerification.grantingStageRunKey).toBeUndefined();
  });

  // Issue #1103 review, P1: an untracked path does not block the launch, but its
  // content is part of `workingTreeState` at the end-of-run re-check too.
  const untrackedInputRunner = (rewriteDuringTest) => {
    writeFileSync(join(tmpDir, 'input.txt'), 'before');
    const runner = finalRunner({ status: '?? input.txt\0' });
    const run = runner.run.bind(runner);
    runner.run = (cmd, args, opts) => {
      if (rewriteDuringTest && cmd === 'npm' && args[0] === 'test') {
        writeFileSync(join(tmpDir, 'input.txt'), 'after');
      }
      return run(cmd, args, opts);
    };
    return runner;
  };

  test('an untracked input rewritten under a passing run suppresses the grant', async () => {
    const run = await finalStage(untrackedInputRunner(true));

    expect(run.status).toBe('recorded');
    expect(run.route.row).toBe(7);
    expect(run.granted).toBe(false);
    expect(run.disposition).toBe('rerun');
    expect(run.bindingRefusals.map((refusal) => refusal.reason)).toContain('identity-recheck-mismatch');
    expect(run.context.finalStageGrant).toBeNull();
    expect(run.context.stagedVerification.grantingStageRunKey).toBeUndefined();
  });

  test('an unchanged untracked path neither blocks the launch nor the grant', async () => {
    const run = await finalStage(untrackedInputRunner(false));
    expect(run.status).toBe('recorded');
    expect(run.granted).toBe(true);
    expect(run.bundle.identity.workingTreeState.state).toBe('value');
    expect(run.bundle.identity.workingTreeState.value).not.toBe('clean');
  });

  // Issue #1103 review, P1: the end-of-run re-check reads the session live.
  test('a sessions.json edit that lands during a passing run suppresses the grant', async () => {
    const run = await finalStage(finalRunner(), SESSION(), TASK(), {
      readLiveSession: async () => SESSION(STAGED, { test: 'npm test', lint: 'npm run lint -- --fix' }),
    });
    expect(run.status).toBe('recorded');
    expect(run.route.row).toBe(7);
    expect(run.granted).toBe(false);
    expect(run.disposition).toBe('rerun');
    expect(run.bindingRefusals.length).toBeGreaterThan(0);
    expect(run.context.finalStageGrant).toBeNull();
    expect(run.context.stagedVerification.grantingStageRunKey).toBeUndefined();
  });

  test('a live session that cannot be read or no longer resolves never grants', async () => {
    const unreadable = await finalStage(finalRunner(), SESSION(), TASK(), {
      readLiveSession: async () => { throw new Error('sessions.json is mid-write'); },
    });
    expect(unreadable.granted).toBe(false);
    expect(unreadable.context.finalStageGrant).toBeNull();

    const gone = await finalStage(finalRunner(), SESSION(), TASK(), { readLiveSession: async () => undefined });
    expect(gone.granted).toBe(false);

    const disabled = await finalStage(finalRunner(), SESSION(), TASK(), {
      readLiveSession: async () => SESSION({ enabled: false }),
    });
    expect(disabled.granted).toBe(false);
  });

  test('an unchanged live session still grants', async () => {
    const run = await finalStage(finalRunner(), SESSION(), TASK(), { readLiveSession: async () => SESSION() });
    expect(run.granted).toBe(true);
    expect(run.bindingRefusals).toEqual([]);
  });

  // Issue #1103 review, P2: a declared environmentPrepare binds through its stamp.
  describe('environmentPrepare stamp', () => {
    const PREPARE = { enabled: true, command: 'echo prepared' };
    const preparedSession = () => ({ ...SESSION(), environmentPrepare: PREPARE, artifactRoot: join(tmpDir, 'root') });
    const prepare = (session) =>
      ensureEnvironmentPrepared({
        config: session.environmentPrepare,
        cwd: tmpDir,
        worktreeIdentity: tmpDir,
        artifactRoot: session.artifactRoot,
        artifactDir,
        runner: finalRunner(),
      });

    test('a declared prepare with no current stamp launches nothing and parks', async () => {
      const runner = finalRunner();
      const run = await finalStage(runner, preparedSession());
      expect(run).toMatchObject({ status: 'withheld', disposition: 'operator', reason: 'identity-unresolvable' });
      expect(run.detail).toContain('environmentIdentity');
      expect(npmCalls(runner)).toEqual([]);
    });

    test('a prepared worktree binds the stamp and grants', async () => {
      const session = preparedSession();
      expect(prepare(session).status).toBe('ran');
      const run = await finalStage(finalRunner(), session);
      expect(run.granted).toBe(true);
      expect(run.bundle.identity.environmentIdentity.state).toBe('value');
    });

    test('a stamp that goes missing during a passing run suppresses the grant', async () => {
      const session = preparedSession();
      expect(prepare(session).status).toBe('ran');
      const base = finalRunner();
      const runner = {
        ...base,
        run(cmd, args, opts) {
          if (cmd === 'npm' && args[0] === 'test') rmSync(join(tmpDir, '.git', 'ai-env-prepared'), { force: true });
          return base.run(cmd, args, opts);
        },
      };
      const run = await finalStage(runner, session);
      expect(run.status).toBe('recorded');
      expect(run.route.row).toBe(7);
      expect(run.granted).toBe(false);
      expect(run.disposition).toBe('rerun');
      expect(run.context.finalStageGrant).toBeNull();
    });
  });

  // Issue #1103 review, P1: a push to the PR branch leaves the worktree HEAD alone.
  test('a PR head pushed during a passing run suppresses the grant and re-runs the stage', async () => {
    let live = HEAD;
    const base = finalRunner();
    const runner = {
      ...base,
      run(cmd, args, opts) {
        if (cmd === 'npm' && args[0] === 'test') live = MOVED;
        return base.run(cmd, args, opts);
      },
    };
    const run = await finalStage(runner, SESSION(), TASK(), { readLivePrHead: () => live });
    expect(run.status).toBe('recorded');
    expect(run.route.row).toBe(7);
    expect(run.granted).toBe(false);
    expect(run.disposition).toBe('rerun');
    expect(run.bindingRefusals.map((refusal) => refusal.reason)).toEqual(
      expect.arrayContaining(['head-mismatch', 'identity-recheck-mismatch']),
    );
    expect(run.context.finalStageGrant).toBeNull();
    expect(run.context.stagedVerification.grantingStageRunKey).toBeUndefined();
  });

  // Issue #1103 review, P2: the production path reads the live PR head; a worktree
  // HEAD that moves while the PR head stays put must not be masked by it.
  test('a worktree head that moves under an unchanged PR head suppresses the grant', async () => {
    const runner = finalRunner({ heads: [HEAD, MOVED] });
    const run = await finalStage(runner, SESSION(), TASK(), { readLivePrHead: () => HEAD });
    expect(run.status).toBe('recorded');
    expect(run.granted).toBe(false);
    expect(run.disposition).toBe('rerun');
    expect(run.bindingRefusals.map((refusal) => refusal.reason)).toEqual(
      expect.arrayContaining(['head-mismatch', 'identity-recheck-mismatch']),
    );
    expect(run.context.finalStageGrant).toBeNull();
    expect(run.context.stagedVerification.grantingStageRunKey).toBeUndefined();
  });

  test('an unreadable live PR head never grants', async () => {
    const unresolved = await finalStage(finalRunner(), SESSION(), TASK(), { readLivePrHead: () => undefined });
    expect(unresolved.granted).toBe(false);
    expect(unresolved.context.finalStageGrant).toBeNull();
    const thrown = await finalStage(finalRunner(), SESSION(), TASK(), {
      readLivePrHead: () => { throw new Error('origin unreachable'); },
    });
    expect(thrown.granted).toBe(false);
    expect(thrown.context.finalStageGrant).toBeNull();
  });

  test('a live PR head equal to the verified head grants', async () => {
    const run = await finalStage(finalRunner(), SESSION(), TASK(), { readLivePrHead: () => HEAD });
    expect(run.granted).toBe(true);
    expect(run.context.finalStageGrant.headSha).toBe(HEAD);
  });

  test('a granting bundle is not reused once the PR head moved past it', async () => {
    const first = await finalStage(finalRunner());
    const runner = finalRunner();
    const again = await finalStage(runner, SESSION(), TASK(first.context), {
      runId: 'run-2',
      readLivePrHead: () => MOVED,
    });
    expect(again.reused).toBe(false);
    expect(again.granted).toBe(false);
    expect(again.context.finalStageGrant).toBeNull();
  });

  test('readRemoteRefHead accepts only an exact ref match', () => {
    const lsRemote = (stdout, exitCode = 0) => ({ run: () => ({ stdout, stderr: '', exitCode }) });
    const ref = 'refs/heads/ai/issue-7';
    expect(readRemoteRefHead(lsRemote(`${HEAD}\t${ref}\n`), tmpDir, 'origin', ref)).toBe(HEAD);
    expect(readRemoteRefHead(lsRemote(`${HEAD}\trefs/tags/ai/issue-7\n`), tmpDir, 'origin', ref)).toBeUndefined();
    expect(readRemoteRefHead(lsRemote(''), tmpDir, 'origin', ref)).toBeUndefined();
    expect(readRemoteRefHead(lsRemote(`${HEAD}\t${ref}\n`, 2), tmpDir, 'origin', ref)).toBeUndefined();
  });

  test('an earlier grant bound to an older head is not reused at a new head', async () => {
    const first = await finalStage(finalRunner());
    const runner = finalRunner({ heads: [MOVED] });
    const second = await finalStage(runner, SESSION(), TASK(first.context), { runId: 'run-2' });
    expect(second.reused).toBe(false);
    expect(npmCalls(runner)).toEqual(['npm test', 'npm run lint']);
    expect(second.bundle.headSha).toBe(MOVED);
    expect(second.context.finalStageGrant.headSha).toBe(MOVED);
  });
});

// ---------------------------------------------------------------------------
// Interruption — row 11
// ---------------------------------------------------------------------------

describe('interruption', () => {
  test('a run that dies mid-stage leaves nothing to resume; the next claim starts over', async () => {
    const task = TASK();
    await expect(finalStage(finalRunner({ throwOn: 'npm run lint' }), SESSION(), task)).rejects.toThrow('host lost');
    // Nothing was committed: the task context the next claim reads is untouched.
    expect(task.context.stagedVerification).toBeUndefined();

    const runner = finalRunner();
    const run = await finalStage(runner, SESSION(), task, { runId: 'run-2' });
    expect(npmCalls(runner)).toEqual(['npm test', 'npm run lint']);
    expect(run.bundle.stageRunId.stageOrdinal).toBe(0);
    expect(run.granted).toBe(true);
  });

  test('an open allocation a crashed writer persisted is marked interrupted and credits nothing', async () => {
    const seed = await finalStage(finalRunner(), SESSION(), TASK(), { runId: 'run-0' });
    const shim = contextOnlyStagedVerificationStore(TASK({ stagedVerification: seed.context.stagedVerification }));
    const open = await allocateStageRun({
      store: shim.store,
      key: { sessionId: 'sess-final', issueNumber: 7 },
      observedTaskRevision: shim.current().revision,
      requestKey: 'crashed-run',
      taskAttempt: 2,
      lane: 'review',
      stage: 'final',
      identity: seed.bundle.identity,
      now: NOW,
    });
    expect(open.status).toBe('allocated');

    const run = await finalStage(finalRunner(), SESSION(), TASK(shim.current().context), {
      runId: 'run-3',
      taskAttempt: 2,
    });
    const crashed = run.context.stagedVerification.runs.find((entry) => entry.requestKey === 'crashed-run');
    expect(crashed.state).toBe('interrupted');
    expect(run.bundle.stageRunId.stageOrdinal).toBe(1);
    expect(run.context.stagedVerification.grantingStageRunKey).toBe('2/review/final/1');
  });

  // Issue #1103 review, P2: with a durable store the allocation commits before
  // launch, so crashes are counted and exhaust the recovery budget.
  describe('with a durable store', () => {
    let store;
    const key = { sessionId: 'sess-final', issueNumber: 7 };

    beforeEach(async () => {
      store = new SqliteTaskStore(join(tmpDir, 'interrupt.db'));
      await store.enqueueTask({ ...key, phase: 'review', now: NOW, context: {} });
    });

    afterEach(() => {
      store.close();
    });

    const storedState = async () => (await store.getTask(key)).context.stagedVerification;

    test('a crash mid-stage leaves the allocation durable, and the next claim records it interrupted', async () => {
      await expect(
        finalStage(finalRunner({ throwOn: 'npm run lint' }), SESSION(), await store.getTask(key), { runId: 'run-0', store }),
      ).rejects.toThrow('host lost');
      expect((await storedState()).runs.map((entry) => entry.state)).toEqual(['allocated']);

      const run = await finalStage(finalRunner(), SESSION(), await store.getTask(key), { runId: 'run-1', store });
      expect(run.granted).toBe(true);
      expect(run.bundle.stageRunId.stageOrdinal).toBe(1);
      expect(run.context.stagedVerification.runs.map((entry) => entry.state)).toEqual(['interrupted', 'recorded']);
      // The durable store holds the allocation, never the bundle: that rides the completion.
      const durable = await storedState();
      expect(durable.runs.map((entry) => entry.state)).toEqual(['interrupted', 'allocated']);
      expect(durable.finalBundles).toEqual([]);
    });

    test('repeated crashes exhaust maxStageRecoveryAttempts and park without launching', async () => {
      const session = SESSION({ enabled: true, maxStageRecoveryAttempts: 1 });
      const crash = async (runId) =>
        finalStage(finalRunner({ throwOn: 'npm run lint' }), session, await store.getTask(key), { runId, store });

      await expect(crash('run-0')).rejects.toThrow('host lost');
      await expect(crash('run-1')).rejects.toThrow('host lost');
      expect((await storedState()).finalRecoveryStreak).toBe(1);

      const runner = finalRunner({ throwOn: 'npm run lint' });
      const parked = await finalStage(runner, session, await store.getTask(key), { runId: 'run-2', store });
      expect(parked).toMatchObject({ status: 'withheld', disposition: 'operator', reason: 'recovery-budget-exhausted' });
      expect(npmCalls(runner)).toEqual([]);
      expect(parked.context.finalStageGrant).toBeNull();
      expect(parked.context.stagedVerification.finalRecoveryStreak).toBe(2);
      expect(parked.context.stagedVerification.runs.every((entry) => entry.state === 'interrupted')).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// Repeated publication and the one-transaction grant
// ---------------------------------------------------------------------------

const OUTBOX_SESSION = {
  sessionId: 'sess-final',
  repoKey: 'test-repo',
  repoRoot: '/tmp/test-repo',
  githubRepo: 'org/repo',
  artifactDir: '.artifacts',
  artifactRoot: '/tmp/test-repo/.artifacts',
  githubOwner: 'org',
  githubName: 'repo',
  defaults: { implementationAgent: 'claude', reviewAgent: 'codex' },
  verification: { test: 'npm test' },
  stagedVerification: { enabled: true },
  labels: { active: 'ai:active', blocked: 'ai:blocked', readyForHuman: 'ai:ready-for-human' },
  workItemProvider: { provider: 'github-issues', auth: { mode: 'gh' } },
  repoHostProvider: { provider: 'github', auth: { mode: 'gh' } },
};

describe('publication through the completion transaction', () => {
  let taskStore;
  let outboxStore;

  beforeEach(() => {
    const dbPath = join(tmpDir, 'test.db');
    taskStore = new SqliteTaskStore(dbPath);
    outboxStore = new SqliteOutboxStore(dbPath);
  });

  afterEach(() => {
    taskStore.close();
    outboxStore.close();
  });

  const enqueueReview = (context = {}) =>
    taskStore.enqueueTask({
      sessionId: 'sess-final',
      issueNumber: 7,
      phase: 'review',
      now: NOW,
      context: { prUrl: 'https://github.com/org/repo/pull/5', branch: 'ai/issue-7', ...context },
    });

  const runReview = (handler, session = OUTBOX_SESSION) =>
    runNextPhase({
      store: taskStore,
      request: { sessionId: 'sess-final', workerId: 'w1', runId: RUN_ID, now: NOW },
      handlers: { review: handler },
      outboxStore,
      session,
      now: NOW,
    });

  const stackReadyRows = async (topic) =>
    (await outboxStore.listPending()).filter(
      (entry) => entry.topic === topic && entry.payload.label === 'status:stack-ready',
    );

  test('review OK without a final bundle never releases downstream Issues', async () => {
    await enqueueReview();
    const outcome = await runReview(async () => ({ result: 'success', context: {}, message: 'ok' }));
    expect(outcome.status).toBe('completed');
    expect(outcome.task.status).toBe('ready_for_human');
    expect(await stackReadyRows('gh:label:add')).toHaveLength(0);
    // §7 rule 2: the withheld grant clears a live marker instead.
    expect((await stackReadyRows('gh:label:remove')).length).toBeGreaterThan(0);
  });

  test('review OK with partial (failing) final verification never publishes', async () => {
    await enqueueReview();
    const outcome = await runReview(async (task) => {
      const run = await finalStage(
        finalRunner({ results: { 'npm test': { stdout: 'x', stderr: '', exitCode: 1 } } }),
        OUTBOX_SESSION,
        task,
        { taskAttempt: reviewAttempt(task) },
      );
      // Forcing success here models a caller that ignored the route: the gate
      // still refuses to publish over a bundle that did not earn row 7.
      return { result: 'success', context: run.context };
    });
    expect(outcome.status).toBe('completed');
    expect(await stackReadyRows('gh:label:add')).toHaveLength(0);
  });

  test('a granting final stage publishes in the same commit that records its bundle', async () => {
    await enqueueReview();
    const outcome = await runReview(async (task) => {
      const run = await finalStage(finalRunner(), OUTBOX_SESSION, task, { taskAttempt: reviewAttempt(task) });
      expect(run.granted).toBe(true);
      return { result: 'success', context: run.context };
    });
    expect(outcome.status).toBe('completed');
    expect(await stackReadyRows('gh:label:add')).toHaveLength(1);
    const stored = await taskStore.getTask({ sessionId: 'sess-final', issueNumber: 7 });
    const state = stored.context.stagedVerification;
    expect(state.grantingStageRunKey).toBeDefined();
    expect(state.finalBundles.some((bundle) => bundle.outcome === 'passed' && bundle.complete)).toBe(true);
  });

  test('a declaration left by an earlier run does not publish a later review', async () => {
    const earlier = await finalStage(finalRunner(), OUTBOX_SESSION, TASK(), { runId: 'run-0' });
    await enqueueReview(earlier.context);
    const outcome = await runReview(async () => ({ result: 'success', context: {} }));
    expect(outcome.status).toBe('completed');
    expect(await stackReadyRows('gh:label:add')).toHaveLength(0);
  });

  test('repeated publication of one completion enqueues the grant once', async () => {
    await enqueueReview();
    await runReview(async (task) => {
      const run = await finalStage(finalRunner(), OUTBOX_SESSION, task, { taskAttempt: reviewAttempt(task) });
      return { result: 'success', context: run.context };
    });
    const stored = await taskStore.getTask({ sessionId: 'sess-final', issueNumber: 7 });
    // Replay the same completion's label build (a retried delivery).
    for (let i = 0; i < 2; i += 1) {
      await enqueueStatusLabelEffects(
        outboxStore, OUTBOX_SESSION, stored, 'ready_for_human', 'review', RUN_ID, NOW, 'review',
        { result: 'success', context: {} },
      );
    }
    expect(await stackReadyRows('gh:label:add')).toHaveLength(1);
  });

  test('a delayed final-stage release withdraws a live marker in the same commit', async () => {
    await enqueueReview();
    const outcome = await runReview(async () => ({
      result: 'delayed',
      delayKind: 'transient_verification',
      withdrawStackReady: true,
      retryAfterMs: 1000,
      context: { finalStageGrant: null },
    }));
    expect(outcome.status).toBe('delayed');
    expect(outcome.task.status).toBe('queued');
    expect(await stackReadyRows('gh:label:remove')).toHaveLength(1);
    expect(await stackReadyRows('gh:label:add')).toHaveLength(0);
    const events = await taskStore.listEvents({ sessionId: 'sess-final', issueNumber: 7 });
    expect(events.map((event) => event.type)).toContain('stack_ready.withdrawn');
  });

  test('a delayed release that does not ask for withdrawal enqueues no label effect', async () => {
    await enqueueReview();
    const outcome = await runReview(async () => ({ result: 'delayed', retryAfterMs: 1000, context: {} }));
    expect(outcome.status).toBe('delayed');
    expect(await stackReadyRows('gh:label:remove')).toHaveLength(0);
  });

  test('a re-delivered approval at the same head reuses its own granting bundle without re-running', async () => {
    const first = await finalStage(finalRunner(), SESSION(), TASK());
    const runner = finalRunner();
    const again = await finalStage(runner, SESSION(), TASK(first.context), { runId: 'run-2' });
    expect(again).toMatchObject({ status: 'recorded', reused: true, granted: true });
    expect(npmCalls(runner)).toEqual([]);
    expect(decideStackReadyPublication({ stagedVerification: STAGED, context: again.context, runId: 'run-2' }))
      .toEqual({ kind: 'grant', stageRunKey: '1/review/final/0' });
  });
});
