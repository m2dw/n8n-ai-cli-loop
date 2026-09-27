// Issue #1102 — the `loop` stage at the shipped implementation-lane execution
// site (docs/staged-verification-contract.md §13 slices S3 and S7).
//
// The §14 rows this file owns: the required set as the execution site consumes
// it, the fail-fast half of "Evidence (§6.2)", and "Compatibility (§10)" —
// flag-off byte-equivalence at the shipped site, preserved log-file names, and
// a public summary that carries no output bytes.
//
// Issue #1155 retired the group-selection policy this file used to exercise:
// the selection port and its deadline, the `selectable` / `finalOnly` lists,
// the change descriptor the port was fed, the regression and pin floors, and
// the `.ai-cli-loop/verification.json` project pin. A loop stage now runs the
// **entire required set**, minus only the suite entry a changed-file Stage 1
// replaces (#1154). The coverage for those surfaces is gone rather than
// relaxed; what replaces it is the pins below that nothing is consulted at all.

import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { runLoopStageVerification, resolveStageVerificationContext } from '../dist/handlers/stage-verification.js';
import { runVerification } from '../dist/handlers/verification.js';
import {
  nonTestVerificationCommands,
  resolveTestStageContext,
  testStageReplacedCheck,
} from '../dist/handlers/test-stage-verification.js';
import {
  buildVerificationEvidenceBindingBlock,
  buildVerificationSessionBaseline,
  resolveEffectiveVerificationPlan,
} from '../dist/core/verification-plan.js';
import { VERIFICATION_AMENDMENTS_CONTEXT_KEY } from '../dist/core/verification-amendment.js';
import { createImplementationHandler as _createImplementationHandler } from '../dist/handlers/implementation.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmpDir;
let artifactDir;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'stage-verification-test-'));
  artifactDir = join(tmpDir, 'artifacts');
  mkdirSync(artifactDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const SESSION = (overrides = {}) => ({
  verification: { test: 'npm test', lint: 'npm run lint' },
  ...overrides,
});

const TASK = (context = {}) => ({ context });

/**
 * A command runner that answers by command rather than by position, so a test
 * asserts on WHICH commands ran instead of on a queue index.
 */
function stageRunner({ results = {}, statusExit = 0 } = {}) {
  const calls = [];
  return {
    calls,
    argv: () => calls.map((call) => [call.cmd, ...call.args].join(' ')),
    run(cmd, args, opts) {
      calls.push({ cmd, args, opts });
      const argv = [cmd, ...args].join(' ');
      if (cmd === 'git' && args[0] === 'status') {
        return { stdout: ' M src/foo.ts\0?? src/new.ts\0', stderr: '', exitCode: statusExit };
      }
      return results[argv] ?? { stdout: 'ok', stderr: '', exitCode: 0 };
    },
  };
}

const loopStage = (runner, session, task = TASK(), extra = {}) =>
  runLoopStageVerification({
    runner,
    session,
    task,
    cwd: tmpDir,
    lane: 'implementation',
    taskAttempt: 0,
    stageOrdinal: 0,
    artifactDir,
    ...extra,
  });

// ---------------------------------------------------------------------------
// §10 rule 1 — the legacy path
// ---------------------------------------------------------------------------

describe('legacy mode (§10 rule 1)', () => {
  test('an un-opted-in session runs the shipped full pass and no stage', async () => {
    const runner = stageRunner();
    const run = await loopStage(runner, SESSION());
    expect(run.stage).toBeUndefined();
    expect(run.unavailable).toEqual({ status: 'unavailable', reason: 'disabled' });
    expect(run.verification).toEqual({
      passed: true,
      results: [{ name: 'test', passed: true }, { name: 'lint', passed: true }],
    });
    // No `stageChecks`, and — the byte-equivalence that matters at this site —
    // no change-describing git call at all.
    expect(run.verification.stageChecks).toBeUndefined();
    expect(runner.argv()).toEqual(['npm test', 'npm run lint']);
  });

  test('`runVerification` without a stage is unchanged, artifacts included', () => {
    const runner = stageRunner();
    const outcome = runVerification(runner, { test: 'npm test' }, tmpDir, artifactDir);
    expect(outcome).toEqual({ passed: true, results: [{ name: 'test', passed: true }] });
    expect(existsSync(join(artifactDir, 'verification-test.log'))).toBe(true);
  });

  test('a plan that will not resolve falls back to the full pass, not to less', async () => {
    const runner = stageRunner();
    const session = SESSION({
      verification: { test: 'npm test', broken: '   ' },
      stagedVerification: { enabled: true },
    });
    const run = await loopStage(runner, session);
    expect(run.stage).toBeUndefined();
    expect(run.unavailable.reason).toBe('plan-unresolvable');
    expect(run.verification.passed).toBe(true);
    expect(runner.argv()).toEqual(['npm test']);
  });

  test('an enabled session with no execution slot has no stage to run', () => {
    const context = resolveStageVerificationContext({
      session: { verification: {}, stagedVerification: { enabled: true } },
      task: TASK(),
    });
    expect(context).toEqual({ status: 'unavailable', reason: 'no-execution-checks' });
  });
});

// ---------------------------------------------------------------------------
// Enabled, passing
// ---------------------------------------------------------------------------

describe('a passing loop stage', () => {
  test('enabled runs the whole required set and records it', async () => {
    const runner = stageRunner();
    const run = await loopStage(runner, SESSION({ stagedVerification: { enabled: true } }));
    expect(run.verification.passed).toBe(true);
    const bundle = run.stage.assembly.bundle;
    expect(bundle.outcome).toBe('passed');
    expect(bundle.complete).toBe(true);
    expect(bundle.selection.full).toBe(true);
    // #1155: the record says what ran, and has no `source` to say why.
    expect(Object.keys(bundle.selection).sort()).toEqual(['checkIds', 'full', 'selectionDigest']);
    expect(bundle.checks.map((check) => check.name)).toEqual(['test', 'lint']);
    expect(run.stage.assembly.aggregation.unprovenCheckIds).toEqual([]);
    // The shipped artifact names are preserved verbatim (§10 rule 4).
    expect(existsSync(join(artifactDir, 'verification-test.log'))).toBe(true);
    expect(existsSync(join(artifactDir, 'verification-lint.log'))).toBe(true);
  });

  test('the bundle artifact lands beside the logs and carries no output bytes', async () => {
    const runner = stageRunner();
    await loopStage(runner, SESSION({ stagedVerification: { enabled: true } }));
    const file = join(artifactDir, 'verification-stage-loop-0.json');
    expect(existsSync(file)).toBe(true);
    const bundle = JSON.parse(readFileSync(file, 'utf8'));
    expect(bundle.stageRunId).toEqual({
      taskAttempt: 0,
      lane: 'implementation',
      stage: 'loop',
      stageOrdinal: 0,
    });
    expect(bundle.checks.every((check) => check.logArtifact.startsWith('verification-'))).toBe(true);
    // The identity and both timestamps are the store write's to stamp, not this
    // artifact's to invent.
    expect(bundle.identity).toBeUndefined();
    expect(bundle.recordedAt).toBeUndefined();
    // Command bytes never leave the plan: the record binds by digest.
    expect(readFileSync(file, 'utf8')).not.toContain('npm test');
  });

  test('a repair re-run cannot rewrite the log an earlier bundle links', async () => {
    const results = { 'npm test': { stdout: 'FIRST RUN FAILED', stderr: '', exitCode: 1 } };
    const runner = stageRunner({ results });
    const session = SESSION({ stagedVerification: { enabled: true } });
    await loopStage(runner, session, TASK(), { stageOrdinal: 0 });
    results['npm test'] = { stdout: 'SECOND RUN PASSED', stderr: '', exitCode: 0 };
    await loopStage(runner, session, TASK(), { stageOrdinal: 1 });

    const bundleLog = (ordinal) => {
      const bundle = JSON.parse(readFileSync(join(artifactDir, `verification-stage-loop-${ordinal}.json`), 'utf8'));
      const check = bundle.checks.find((entry) => entry.name === 'test');
      return { outcome: bundle.outcome, logArtifact: check.logArtifact };
    };
    const first = bundleLog(0);
    const second = bundleLog(1);
    expect(first.logArtifact).toBe('verification-stage-loop-0-test.log');
    expect(second.logArtifact).toBe('verification-stage-loop-1-test.log');
    expect(first.outcome).not.toBe('passed');
    expect(readFileSync(join(artifactDir, first.logArtifact), 'utf8')).toBe('FIRST RUN FAILED');
    expect(readFileSync(join(artifactDir, second.logArtifact), 'utf8')).toBe('SECOND RUN PASSED');
    // The shipped filename is still written, and holds the latest run.
    expect(readFileSync(join(artifactDir, 'verification-test.log'), 'utf8')).toBe('SECOND RUN PASSED');
  });

  // Issue #1155: nothing outside the plan decides what a stage runs, so nothing
  // outside the plan is read. An unreadable working tree cannot narrow a run
  // because there is no run for it to narrow — which is why the stage describes
  // no change at all any more.
  test('the stage describes no change and consults nothing to decide its scope', async () => {
    const runner = stageRunner({ statusExit: 1 });
    const run = await loopStage(runner, SESSION({ stagedVerification: { enabled: true } }));
    expect(run.stage.assembly.bundle.selection.full).toBe(true);
    expect(runner.argv()).toEqual(['npm test', 'npm run lint']);
  });

  test('a project verification file in the worktree is not read at all', async () => {
    mkdirSync(join(tmpDir, '.ai-cli-loop'), { recursive: true });
    writeFileSync(
      join(tmpDir, '.ai-cli-loop', 'verification.json'),
      JSON.stringify({ version: 1, checks: { lint: { alwaysRequired: true } } }),
    );
    const runner = stageRunner();
    const run = await loopStage(runner, SESSION({ stagedVerification: { enabled: true } }));
    // Every required check runs whatever the file says, so the file can neither
    // pin nor omit anything — it is no longer part of the contract.
    expect(run.stage.assembly.bundle.checks.map((check) => check.name)).toEqual(['test', 'lint']);
    expect(run.stage.assembly.bundle.selection.full).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The required set (issue #1155), and the one thing that still leaves it
// ---------------------------------------------------------------------------

describe('the required set a loop stage runs (#1155)', () => {
  test('no check is omissible, and no operator setting can make one so', async () => {
    const runner = stageRunner();
    const run = await loopStage(runner, SESSION({ stagedVerification: { enabled: true } }));
    expect(run.stage.assembly.bundle.checks.map((check) => check.name)).toEqual(['test', 'lint']);
    // There is no omission record to read any more: the selection IS the
    // required set, and the only shape it can take is the whole of it.
    expect(run.stage.selection.checks.map((check) => check.checkId)).toEqual(
      run.stage.assembly.bundle.selection.checkIds,
    );
    expect(run.stage.assembly.bundle.selection.full).toBe(true);
  });

  test('an Issue-required command and its execution check both run', async () => {
    const runner = stageRunner();
    const session = SESSION({
      verification: { lint: 'npm run lint' },
      stagedVerification: { enabled: true },
    });
    const run = await loopStage(runner, session, TASK({
      body: '## Verification\n\n- `npm run lint`\n',
    }));
    expect(runner.argv()).toContain('npm run lint');
    const requirement = run.stage.assembly.bundle.checks.find((check) => check.checkId.startsWith('req:'));
    expect(requirement.verdict).toBe('passed');
  });

  describe('a test stage replacing the bound suite (issue #1154)', () => {
    const replacedSession = () => SESSION({
      verification: { test: 'npm test', lint: 'npm run lint', typecheck: 'npm run typecheck' },
      stagedVerification: { enabled: true, testSuite: { test: { adapter: 'jest' } } },
    });
    const replacedByTestStage = (slot) => slot.name === 'test';

    // The suite entry is the ONLY thing that leaves the required set, and a
    // selection without it is never reported as the whole set.
    test('only the suite leaves; every other required check still runs', async () => {
      const runner = stageRunner();
      const run = await loopStage(runner, replacedSession(), TASK(), { replacedByTestStage });
      expect(runner.argv()).toEqual(['npm run lint', 'npm run typecheck']);
      const bundle = run.stage.assembly.bundle;
      expect(bundle.selection.full).toBe(false);
      expect(bundle.checks.map((check) => check.name)).toEqual(['lint', 'typecheck']);
      expect(bundle.outcome).toBe('passed');
      // The suite entry is gone from the selection itself, not omitted from a
      // run over it: what is left is the rest of the required set, in order.
      expect(run.stage.selection.checks.map((check) => check.checkId)).toEqual(['exec:lint', 'exec:typecheck']);
    });

    test('a plan whose only entry is the suite runs no non-test check', async () => {
      const runner = stageRunner();
      const run = await loopStage(
        runner,
        SESSION({
          verification: { test: 'npm test' },
          stagedVerification: { enabled: true, testSuite: { test: { adapter: 'jest' } } },
        }),
        TASK(),
        { replacedByTestStage },
      );
      expect(runner.argv()).not.toContain('npm test');
      expect(run.verification.passed).toBe(true);
      expect(run.stage.assembly.bundle.checks).toEqual([]);
    });

    test('a requirement the suite satisfies leaves with it, and never runs the suite', async () => {
      const runner = stageRunner();
      const run = await loopStage(runner, replacedSession(), TASK({
        body: '## Verification\n\n- `npm test`\n',
      }), { replacedByTestStage });
      expect(runner.argv()).not.toContain('npm test');
      const bundle = run.stage.assembly.bundle;
      expect(bundle.checks.some((check) => check.checkId.startsWith('req:'))).toBe(false);
      expect(bundle.outcome).toBe('passed');
    });

    test('an unresolvable plan still never runs the suite', async () => {
      const runner = stageRunner();
      const run = await loopStage(runner, SESSION({
        verification: { test: 'npm test', lint: 'npm run lint', broken: '   ' },
        stagedVerification: { enabled: true },
      }), TASK(), { replacedByTestStage });
      expect(run.unavailable.reason).toBe('plan-unresolvable');
      expect(runner.argv()).toEqual(['npm run lint']);
    });

    // Issue #1166: the bound entry runs `npm run test:files`, while the Issue
    // requires the `npm test` this project's Issues actually carry.
    // `null` is the undeclared session: the field is absent, which is what an
    // operator who declares nothing actually writes.
    const declaredSession = (requirementCommands = ['npm test']) => SESSION({
      verification: { test: 'npm run test:files', lint: 'npm run lint' },
      stagedVerification: {
        enabled: true,
        testSuite: {
          test: {
            adapter: 'jest',
            ...(requirementCommands === null ? {} : { requirementCommands }),
          },
        },
      },
    });
    const NPM_TEST_BODY = { body: '## Verification\n\n- `npm test`\n' };

    test('a declared requirement leaves the loop selection with the suite it names', async () => {
      const runner = stageRunner();
      const run = await loopStage(runner, declaredSession(), TASK(NPM_TEST_BODY), { replacedByTestStage });
      // Neither spelling of the suite runs before approval.
      expect(runner.argv()).toEqual(['npm run lint']);
      const bundle = run.stage.assembly.bundle;
      expect(bundle.checks.some((check) => check.checkId.startsWith('req:'))).toBe(false);
      expect(bundle.outcome).toBe('passed');
    });

    // Without the declaration the requirement is one no configured command
    // covers, so it stays selected and the loop bundle cannot call it proven.
    test('undeclared, the same requirement stays selected and is not credited', async () => {
      const runner = stageRunner();
      const run = await loopStage(runner, declaredSession(null), TASK(NPM_TEST_BODY), { replacedByTestStage });
      const requirement = run.stage.assembly.bundle.checks.find((check) => check.checkId.startsWith('req:'));
      expect(requirement.verdict).toBe('not-run');
      expect(run.stage.assembly.bundle.outcome).not.toBe('passed');
    });

    // The declaration is about the BOUND entry and nothing else: an unrelated
    // required command keeps its own selected check and its own verdict.
    test('an unrelated requirement is untouched by the declaration', async () => {
      const runner = stageRunner();
      const run = await loopStage(runner, declaredSession(), TASK({
        body: '## Verification\n\n- `npm test`\n- `npm run lint`\n',
      }), { replacedByTestStage });
      const requirements = run.stage.assembly.bundle.checks.filter((check) => check.checkId.startsWith('req:'));
      // Only the lint requirement survived selection, proven by the lint check.
      expect(requirements).toHaveLength(1);
      expect(requirements[0].verdict).toBe('passed');
    });

    // Issue #1166 (review): an operator amendment retired the bound slot. There
    // is then no ACTIVE slot for this stage to replace, but the requirement the
    // bound entry discharges is still the suite's — it leaves the loop
    // selection with the retired slot, so the run reaches Stage 1 and records
    // the `unavailable` the retired-slot path hands to an operator (§6 rule 5).
    // Kept here it would be `evidence-lost` and end the run before that.
    describe('a retired bound slot keeps its requirement closure (§6 rule 5)', () => {
      // A task carrying an applied amendment that retires `exec:test`, with the
      // digests recomputed over the same inputs the stage resolves the plan
      // from — the session bytes and the `npm test` the body requires.
      const retiredSuiteTask = (session) => {
        const baseline = buildVerificationSessionBaseline(session.verification);
        const block = {
          revisions: [{
            revisionId: 'vamd-0000000000000001',
            revisionOrdinal: 1,
            requestKey: 'k1',
            scope: 'task',
            source: 'admin-cli',
            actor: { kind: 'operator', id: 'admin' },
            reason: 'retiring the bound suite slot',
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
        const resolved = resolveEffectiveVerificationPlan({
          sessionVerification: session.verification,
          issueRequirements: ['npm test'],
          amendments: block,
        });
        expect(resolved.status).toBe('resolved');
        expect(resolved.plan.execution.some((slot) => slot.name === 'test' && slot.state === 'active')).toBe(false);
        block.revisions[0].planDigest = resolved.plan.planDigest;
        block.checkpoint.planDigest = resolved.plan.planDigest;
        return TASK({ ...NPM_TEST_BODY, [VERIFICATION_AMENDMENTS_CONTEXT_KEY]: block });
      };

      // The lane's own predicate, not a hand-written one: it is what decides
      // which slots a test stage replaces when the suite cannot be resolved.
      const lanePredicate = (session, task) => {
        const context = resolveTestStageContext({ session, task });
        expect(context.status).toBe('ready');
        return testStageReplacedCheck(context);
      };

      const runRetired = async (session) => {
        const task = retiredSuiteTask(session);
        const runner = stageRunner();
        const run = await loopStage(runner, session, task, {
          replacedByTestStage: lanePredicate(session, task),
        });
        return { runner, run };
      };

      test('a declared requirement leaves with the retired suite it names', async () => {
        const { runner, run } = await runRetired(declaredSession());
        // Only the non-test check runs; no spelling of the suite does.
        expect(runner.argv()).toEqual(['npm run lint']);
        const bundle = run.stage.assembly.bundle;
        expect(bundle.checks.some((check) => check.checkId.startsWith('req:'))).toBe(false);
        // The stage reached a verdict, so the lane goes on to Stage 1 — which
        // is where a retired bound slot is recorded `unavailable`.
        expect(bundle.outcome).toBe('passed');
        expect(run.verification.passed).toBe(true);
      });

      // Undeclared, with the suite bound to the very command the Issue
      // requires: the closure is the shipped one, and it follows the slot too.
      test('a requirement spelled as the retired suite itself leaves too', async () => {
        const { runner, run } = await runRetired(SESSION({
          verification: { test: 'npm test', lint: 'npm run lint' },
          stagedVerification: { enabled: true, testSuite: { test: { adapter: 'jest' } } },
        }));
        expect(runner.argv()).toEqual(['npm run lint']);
        const bundle = run.stage.assembly.bundle;
        expect(bundle.checks.some((check) => check.checkId.startsWith('req:'))).toBe(false);
        expect(bundle.outcome).toBe('passed');
      });
    });

    // Issue #1166 (review, P1): the load-time collision check sees only the
    // STATIC session map. A task amendment can later give another ACTIVE
    // execution slot a declared command — `exec:lint` becoming the `npm test`
    // this binding declares, while the bound slot still runs
    // `npm run test:files` — and such a slot is not a duplicate of the suite's
    // own bytes, so neither the load-time refusal nor the duplicate rule sees
    // it. Admitted, it would run the full suite as a non-test check before the
    // reviewer approved anything.
    describe('an amendment that gives another slot a declared command (§6 rule 5)', () => {
      // `retireSuite` retires the bound entry in the SAME revision that points
      // another slot at a declared command: the plan then holds no active slot
      // for the bound key, so there is nothing for the duplicate rule to
      // compare the colliding slot against.
      const collidedTask = (session, { retireSuite = false } = {}) => {
        const baseline = buildVerificationSessionBaseline(session.verification);
        const block = {
          revisions: [{
            revisionId: 'vamd-0000000000000001',
            revisionOrdinal: 1,
            requestKey: 'k1',
            scope: 'task',
            source: 'admin-cli',
            actor: { kind: 'operator', id: 'admin' },
            reason: 'pointing lint at the whole suite',
            operations: [
              ...(retireSuite ? [{ kind: 'retire', commandId: 'exec:test', reason: 'retiring the bound suite slot' }] : []),
              { kind: 'replace', commandId: 'exec:lint', command: 'npm test', reason: 'lint runs the suite' },
            ],
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
          sessionVerification: session.verification,
          issueRequirements: ['npm test'],
          amendments: block,
        });
        expect(resolved.status).toBe('resolved');
        // The amendment really did leave an active slot running `npm test`,
        // beside the bound slot or — retired — with the bound key gone.
        expect(Object.fromEntries(
          resolved.plan.execution.filter((slot) => slot.state === 'active').map((slot) => [slot.name, slot.command]),
        )).toEqual(retireSuite ? { lint: 'npm test' } : { test: 'npm run test:files', lint: 'npm test' });
        block.revisions[0].planDigest = resolved.plan.planDigest;
        block.checkpoint.planDigest = resolved.plan.planDigest;
        return TASK({ ...NPM_TEST_BODY, [VERIFICATION_AMENDMENTS_CONTEXT_KEY]: block });
      };

      test('the colliding slot is replaced, the suite is ambiguous, and no spelling of it runs', async () => {
        const session = declaredSession();
        const task = collidedTask(session);
        const context = resolveTestStageContext({ session, task });
        expect(context.status).toBe('ready');
        // Routed as ambiguous, so Stage 1 and Stage 2 record `unavailable`.
        expect(context.suite).toMatchObject({ status: 'unbound', reason: 'declared-requirement-collision' });
        const replaced = testStageReplacedCheck(context);
        expect(context.plan.execution.filter(replaced).map((slot) => slot.name).sort()).toEqual(['lint', 'test']);
        const runner = stageRunner();
        const run = await loopStage(runner, session, task, { replacedByTestStage: replaced });
        // Neither spelling of the suite ran, and nothing was left to check.
        expect(runner.argv()).not.toContain('npm test');
        expect(runner.argv()).not.toContain('npm run test:files');
        expect(run.stage.assembly.bundle.checks).toEqual([]);
      });

      // Issue #1166 (review, P1): the collision must be detected from the
      // declaration alone. With the bound slot retired in the same revision the
      // suite is `no-active-slot`, so a rule that compares the colliding slot
      // against the bound slot's bytes has nothing to compare and would admit
      // `npm test` as an ordinary non-test check — the whole suite running in
      // Stage 1, before review.
      test('a retirement in the same revision still excludes the colliding slot', async () => {
        const session = declaredSession();
        const task = collidedTask(session, { retireSuite: true });
        const context = resolveTestStageContext({ session, task });
        expect(context.status).toBe('ready');
        expect(context.suite).toMatchObject({ status: 'unbound', reason: 'no-active-slot' });
        // Both surfaces of the exclusion: the commands a lane would run directly
        // and the predicate that leaves slots out of the loop selection.
        expect(nonTestVerificationCommands(context)).toEqual({});
        const replaced = testStageReplacedCheck(context);
        expect(context.plan.execution.filter(replaced).map((slot) => slot.name).sort()).toEqual(['lint', 'test']);
        const runner = stageRunner();
        const run = await loopStage(runner, session, task, { replacedByTestStage: replaced });
        expect(runner.argv()).not.toContain('npm test');
        expect(runner.argv()).not.toContain('npm run test:files');
        expect(run.stage.assembly.bundle.checks).toEqual([]);
      });

      // The declaration is what makes the slot a full-suite run: without it the
      // same amendment is an ordinary operator decision and keeps its check.
      test('undeclared, the same amendment leaves that slot an ordinary non-test check', async () => {
        const session = declaredSession(null);
        const task = collidedTask(session);
        const context = resolveTestStageContext({ session, task });
        expect(context.suite.status).toBe('bound');
        const runner = stageRunner();
        await loopStage(runner, session, task, { replacedByTestStage: testStageReplacedCheck(context) });
        expect(runner.argv()).toContain('npm test');
        expect(runner.argv()).not.toContain('npm run test:files');
      });
    });

    test('the lane predicate replaces the bound suite and its duplicates only', () => {
      const context = resolveTestStageContext({
        session: {
          verification: { test: 'npm test', unit: 'npm test', lint: 'npm run lint' },
          stagedVerification: { enabled: true, testSuite: { test: { adapter: 'jest' } } },
        },
        task: TASK(),
      });
      expect(context.status).toBe('ready');
      const replaced = testStageReplacedCheck(context);
      expect(context.plan.execution.filter(replaced).map((slot) => slot.name)).toEqual(['test', 'unit']);
    });
  });
});

// ---------------------------------------------------------------------------
// Manual evidence on the live path (#1040 binding)
// ---------------------------------------------------------------------------

describe('manual evidence at the execution site', () => {
  const HEAD = 'a'.repeat(40);
  const session = SESSION({ verification: { test: 'npm test' }, stagedVerification: { enabled: true } });
  const body = '## Verification\n\n- `npm run e2e`\n';

  function boundEvidence(overrides = {}) {
    const context = resolveStageVerificationContext({ session, task: TASK({ body }) });
    const block = buildVerificationEvidenceBindingBlock(context.plan, HEAD);
    return {
      command: 'npm run e2e',
      exitCode: 0,
      output: 'ok',
      recordedAt: '2026-09-13T00:00:00.000Z',
      source: 'operator_input',
      headSha: HEAD,
      planDigest: block.planDigest,
      planRevisionOrdinal: block.planRevisionOrdinal,
      commandId: block.commandIds['npm run e2e'],
      ...overrides,
    };
  }

  const headRunner = (head = `${HEAD}\n`) => stageRunner({
    results: { 'git rev-parse HEAD': { stdout: head, stderr: '', exitCode: 0 } },
  });

  const requirementOf = (run) =>
    run.stage.assembly.bundle.checks.find((check) => check.checkId.startsWith('req:'));

  test('a bound operator attestation satisfies a requirement no execution check covers', async () => {
    const runner = headRunner();
    const run = await loopStage(runner, session, TASK({ body, manualVerificationEvidence: [boundEvidence()] }));
    expect(requirementOf(run).verdict).toBe('passed');
    expect(run.stage.assembly.bundle.outcome).toBe('passed');
    expect(runner.argv()).toContain('git rev-parse HEAD');
  });

  test('evidence recorded against another HEAD is not admitted', async () => {
    const runner = headRunner(`${'b'.repeat(40)}\n`);
    const run = await loopStage(runner, session, TASK({ body, manualVerificationEvidence: [boundEvidence()] }));
    expect(requirementOf(run).verdict).toBe('not-run');
  });

  test('no evidence, no HEAD probe', async () => {
    const runner = headRunner();
    const run = await loopStage(runner, session, TASK({ body }));
    expect(requirementOf(run).verdict).toBe('not-run');
    expect(runner.argv()).not.toContain('git rev-parse HEAD');
  });
});

// ---------------------------------------------------------------------------
// Code failure
// ---------------------------------------------------------------------------

describe('a failing loop stage', () => {
  test('routes by the failure and records the unreached remainder', async () => {
    const runner = stageRunner({ results: { 'npm test': { stdout: '1 failing', stderr: '', exitCode: 1 } } });
    const run = await loopStage(runner, SESSION({ stagedVerification: { enabled: true } }));
    // The shipped outcome the lane routes on is unchanged in shape.
    expect(run.verification.passed).toBe(false);
    expect(run.verification.failure).toMatchObject({ name: 'test', exitCode: 1 });
    const bundle = run.stage.assembly.bundle;
    expect(bundle.outcome).toBe('code-failed');
    expect(bundle.complete).toBe(false);
    expect(bundle.checks).toEqual([
      expect.objectContaining({ name: 'test', verdict: 'failed', exitCode: 1 }),
      expect.objectContaining({ name: 'lint', verdict: 'not-run', notRunKind: 'first-failure-stop' }),
    ]);
    // The skip is never a pass: both ids stay unproven and are pinned.
    expect(run.stage.assembly.aggregation.unprovenCheckIds).toEqual(['exec:test', 'exec:lint']);
    expect(runner.argv()).not.toContain('npm run lint');
  });

  test('a failing Issue-required command stays `code-failed`, never `unknown`', async () => {
    const runner = stageRunner({ results: { 'npm test': { stdout: '1 failing', stderr: '', exitCode: 1 } } });
    const run = await loopStage(
      runner,
      SESSION({ verification: { test: 'npm test' }, stagedVerification: { enabled: true } }),
      TASK({ body: '## Verification\n\n- `npm test`\n' }),
    );
    const bundle = run.stage.assembly.bundle;
    expect(bundle.outcome).toBe('code-failed');
    const requirement = bundle.checks.find((check) => check.checkId.startsWith('req:'));
    expect(requirement).toMatchObject({ verdict: 'not-run', notRunKind: 'requirement-unproven' });
  });

  test('a host failure is infrastructure, not a statement about the change', async () => {
    const runner = stageRunner({
      results: { 'npm test': { stdout: '', stderr: 'npm ERR! Missing script: "test"', exitCode: 1 } },
    });
    const run = await loopStage(runner, SESSION({ stagedVerification: { enabled: true } }));
    expect(run.stage.assembly.bundle.outcome).toBe('infrastructure');
  });
});

// ---------------------------------------------------------------------------
// The implementation lane, end to end (§13 S7)
// ---------------------------------------------------------------------------

describe('implementation lane integration', () => {
  let repoRoot;
  let artifactRoot;

  beforeEach(() => {
    repoRoot = join(tmpDir, 'repo');
    artifactRoot = join(tmpDir, 'run-artifacts');
  });

  const laneSession = (overrides = {}) => ({
    sessionId: 'addon-dev',
    repoKey: 'test-repo',
    repoRoot,
    githubRepo: 'm2dw/test-repo',
    artifactDir: '.n8n-artifacts',
    artifactRoot,
    githubOwner: 'm2dw',
    githubName: 'test-repo',
    defaults: { implementationAgent: 'claude', reviewAgent: 'codex', researchAgent: 'gemini' },
    verification: { test: 'npm test', lint: 'npm run lint' },
    labels: { active: 'ai:active', blocked: 'ai:blocked', readyForHuman: 'ai:ready-for-human' },
    ...overrides,
  });

  const laneTask = () => ({
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
    },
    createdAt: '2026-09-13T00:00:00.000Z',
    updatedAt: '2026-09-13T00:00:00.000Z',
  });

  /** Answers by command, so an added or removed git call cannot desync a queue. */
  function laneRunner({ testResults = [{ stdout: 'PASS', exitCode: 0 }] } = {}) {
    const calls = [];
    let testIndex = 0;
    /** The last entry repeats, so a one-entry queue is "always this answer". */
    const nextOf = (queue, index) => queue[Math.min(index, queue.length - 1)];
    return {
      calls,
      argv: () => calls.map((call) => [call.cmd, ...call.args].join(' ')),
      run(cmd, args) {
        calls.push({ cmd, args });
        const argv = [cmd, ...args].join(' ');
        if (argv === 'npm test') {
          const result = nextOf(testResults, testIndex);
          testIndex += 1;
          return { stdout: '', stderr: '', ...result };
        }
        if (argv === 'npm run lint') return { stdout: 'LINT PASS', stderr: '', exitCode: 0 };
        if (cmd === 'git') {
          if (args[0] === 'diff' && args[1] === '--stat') return { stdout: '2 files changed', stderr: '', exitCode: 0 };
          if (args[0] === 'diff') return { stdout: 'diff --git a/src/foo.ts b/src/foo.ts\n', stderr: '', exitCode: 0 };
          if (args[0] === 'ls-files') return { stdout: 'src/foo.ts\0', stderr: '', exitCode: 0 };
          if (args[0] === 'status' && args.includes('-z')) return { stdout: ' M src/foo.ts\0', stderr: '', exitCode: 0 };
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (cmd === 'gh') {
          return args.includes('create')
            ? { stdout: 'https://github.com/m2dw/test-repo/pull/99', stderr: '', exitCode: 0 }
            : { stdout: '[]', stderr: '', exitCode: 0 };
        }
        // Anything else is the agent invocation.
        return { stdout: 'Implemented changes.', stderr: '', exitCode: 0 };
      },
    };
  }

  function fakeWorktreeResolver() {
    const path = join(tmpDir, 'wt', 'addon-dev', 'issue-77', 'repo');
    return (input) => ({
      ok: true,
      path,
      worktreeId: `${input.sessionId}/issue-${input.issueNumber}`,
      branch: input.branch,
      created: true,
      branchReused: false,
      startedFromRemoteHead: false,
    });
  }

  const runLane = (session, runner) =>
    _createImplementationHandler(
      { session, runId: 'run-stage-1', workerId: 'worker-test' },
      runner,
      undefined,
      fakeWorktreeResolver(),
    )(laneTask());

  const runArtifacts = () => join(artifactRoot, 'runs', 'run-stage-1');

  test('legacy mode: the lane runs the full configured set and records no stage', async () => {
    const runner = laneRunner();
    const result = await runLane(laneSession(), runner);
    expect(result.result).toBe('success');
    expect(result.context.verificationStage).toBeUndefined();
    expect(runner.argv()).toContain('npm test');
    expect(runner.argv()).toContain('npm run lint');
    expect(readdirSync(runArtifacts()).some((f) => f.includes('stage'))).toBe(false);
  });

  test('an enabled stage records the full required set and keeps the shipped PR line', async () => {
    const runner = laneRunner();
    const result = await runLane(laneSession({ stagedVerification: { enabled: true } }), runner);
    expect(result.result).toBe('success');
    expect(result.context.verificationStage).toMatchObject({
      stage: 'loop',
      outcome: 'passed',
      full: true,
      complete: true,
      counts: { selected: 2, passed: 2 },
    });
    expect(runner.argv()).toContain('npm test');
    expect(runner.argv()).toContain('npm run lint');
    const prCall = runner.calls.find((call) => call.cmd === 'gh' && call.args.includes('create'));
    const body = prCall.args[prCall.args.indexOf('--body') + 1];
    expect(body).toContain('**Verification**: test, lint ✓');
    // #1155: a full-set run has no narrowed scope to declare.
    expect(body).not.toContain('**Verification scope**');
    expect(existsSync(join(runArtifacts(), 'verification-stage-loop-0.json'))).toBe(true);
  });

  test('a code failure keeps the shipped #934 route and tells the repair agent the scope', async () => {
    const runner = laneRunner({ testResults: [{ stdout: '1 failing', exitCode: 1 }] });
    const session = laneSession({ stagedVerification: { enabled: true } });
    const result = await runLane(session, runner);
    // Unchanged routing: an ordinary red suite requeues the same task (#934).
    expect(result.result).toBe('needs_fix');
    expect(result.context.verificationFailure).toMatchObject({ name: 'test', exitCode: 1 });
    expect(result.context.verificationStage).toMatchObject({
      outcome: 'code-failed',
      complete: false,
      full: true,
    });
    const repairPrompt = readFileSync(join(runArtifacts(), 'implementation-repair-prompt-1.md'), 'utf8');
    expect(repairPrompt).toContain('## Verification Scope (loop stage)');
    expect(repairPrompt).toContain('This cycle ran the full required set.');
    expect(repairPrompt).toContain('- `test`: failed');
    // The check the first-failure stop never reached is reported as not run,
    // never as passing.
    expect(repairPrompt).toContain('- `lint`: not-run');
    // Each launched stage run gets its own ordinal and its own bundle.
    expect(existsSync(join(runArtifacts(), 'verification-stage-loop-0.json'))).toBe(true);
    expect(existsSync(join(runArtifacts(), 'verification-stage-loop-1.json'))).toBe(true);
  });

  // Issue #1155 retired §4.2 step 4's pin set with the selection it was unioned
  // into: a check left unproven by one cycle is run again by the next because
  // every cycle runs the entire required set, not because it was pinned.
  test('a check left unproven by one cycle is run again by the next', async () => {
    const runner = laneRunner({
      testResults: [{ stdout: '1 failing', exitCode: 1 }, { stdout: 'PASS', exitCode: 0 }],
    });
    const result = await runLane(laneSession({ stagedVerification: { enabled: true } }), runner);
    expect(result.result).toBe('success');
    const second = JSON.parse(readFileSync(join(runArtifacts(), 'verification-stage-loop-1.json'), 'utf8'));
    expect(second.selection.checkIds).toContain('exec:test');
    expect(second.selection.full).toBe(true);
    const test = second.checks.find((check) => check.name === 'test');
    expect(test.verdict).toBe('passed');
    // Nothing records *why* a check is in the set any more.
    expect(test.selectedBy).toBeUndefined();
    expect(test.membership).toBeUndefined();
  });
});
