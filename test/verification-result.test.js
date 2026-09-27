// Issue #1098 — common verification results (the result half of
// docs/staged-verification-contract.md §13's S1, specified by §6 of the
// verification contracts).
//
// Pins the one thing this slice still owns: one command execution → one
// verdict, for every way a command can end — a pass, a nonzero exit, a spawn
// failure, a timeout, and a signal kill — with the shipped #934/#897
// classifiers as the only classification path and no framework knowledge
// anywhere near it.
//
// Issue #1155 deleted the opaque-command result adapter, the structured result
// envelope and the per-check `membership` / `selectedBy` metadata with the
// group-selection policy and the project verification file that were their only
// consumers, so the coverage for those surfaces is gone rather than relaxed.
import {
  buildCheckExecutionRecord,
  classifyCheckExecution,
  deriveCheckCommandDigest,
  isExecutionCheckId,
  CHECK_NOT_RUN_KINDS,
  MAX_CHECK_TEXT_CHARS,
} from '../dist/index.js';

/** A passing run, as `CommandRunner` reports one. */
const PASSED = { exitCode: 0, stdout: 'ok\n', stderr: '', durationMs: 1200 };

const record = (overrides = {}) =>
  buildCheckExecutionRecord({
    checkId: 'exec:test',
    name: 'test',
    command: 'npm test',
    ...overrides,
  });

describe('command outcome classification (§6.3, #1094 §6.2)', () => {
  test('a clean exit 0 is passed, and carries the exit code it reported', () => {
    expect(classifyCheckExecution('test', PASSED)).toEqual({ verdict: 'passed', exitCode: 0 });
  });

  test('a nonzero exit is failed and keeps the code the command returned', () => {
    expect(
      classifyCheckExecution('test', { exitCode: 1, stdout: '1 failing\n', stderr: '' }),
    ).toEqual({ verdict: 'failed', exitCode: 1 });
  });

  test('a spawn failure is failed, reports no exit code, and names the #934 setup signal', () => {
    // The runner's `exitCode: 1` here is its own stand-in for a child that never
    // started; recording it would make a missing binary indistinguishable from a
    // suite that returned 1 (#1060).
    const classification = classifyCheckExecution('test', {
      exitCode: 1,
      stdout: '',
      stderr: 'Error: spawnSync npm ENOENT',
      spawnError: 'Error: spawnSync npm ENOENT',
      spawnErrorCode: 'ENOENT',
    });

    expect(classification.verdict).toBe('failed');
    expect(classification.exitCode).toBeUndefined();
    expect(classification.environmentSignal).toBe('spawn_failed');
  });

  test('a timeout is timed-out, not failed, and keeps the signal that delivered it', () => {
    expect(
      classifyCheckExecution('test', {
        exitCode: 1,
        stdout: '',
        stderr: 'Error: ETIMEDOUT',
        spawnErrorCode: 'ETIMEDOUT',
        timedOut: true,
        signal: 'SIGTERM',
        durationMs: 600_000,
      }),
    ).toEqual({ verdict: 'timed-out', signal: 'SIGTERM' });
  });

  test('a watchdog escalation is a timeout even with no timedOut flag on the run', () => {
    expect(
      classifyCheckExecution('test', {
        exitCode: 1,
        stdout: '',
        stderr: '',
        deadlineEscalated: true,
      }).verdict,
    ).toBe('timed-out');
  });

  test('a signal kill is failed with the signal and no exit code of its own', () => {
    const classification = classifyCheckExecution('test', {
      exitCode: 1,
      stdout: '',
      stderr: '',
      signal: 'SIGKILL',
    });

    expect(classification).toEqual({ verdict: 'failed', signal: 'SIGKILL' });
  });

  test('exit 0 alongside a signal or a spawn failure is never read as a pass', () => {
    expect(classifyCheckExecution('test', { exitCode: 0, signal: 'SIGKILL' }).verdict).toBe(
      'failed',
    );
    expect(
      classifyCheckExecution('test', { exitCode: 0, spawnErrorCode: 'ENOBUFS' }).verdict,
    ).toBe('failed');
  });

  test('a host-transient probe marker is reported beside the verdict, not as one', () => {
    const classification = classifyCheckExecution('test', {
      exitCode: 1,
      stdout: '',
      stderr: '[cli-probe-indeterminate] could not fork',
    });

    expect(classification.verdict).toBe('failed');
    expect(typeof classification.transientSignal).toBe('string');
  });

  test('an opaque non-TypeScript command classifies identically, with no project configuration', () => {
    // §5.1: "An opaque command is a complete verification unit." Neither the
    // command bytes nor the output shape reaches any decision here.
    const go = classifyCheckExecution('verify', {
      exitCode: 2,
      stdout: 'FAIL\tgithub.com/example/pkg\t0.312s\n',
      stderr: '',
    });
    const make = classifyCheckExecution('verify', {
      exitCode: 2,
      stdout: 'make: *** [verify] Error 2\n',
      stderr: '',
    });

    expect(go).toEqual({ verdict: 'failed', exitCode: 2 });
    expect(make).toEqual(go);
  });
});

describe('the per-check execution record (§6.1, §6.2)', () => {
  test('records the command by digest and never copies its bytes', () => {
    const built = record({ run: PASSED });

    expect(built.commandDigest).toBe(deriveCheckCommandDigest('npm test'));
    expect(JSON.stringify(built)).not.toContain('npm test');
  });

  test('a passing check carries the measured duration and no output tail', () => {
    const built = record({ run: PASSED, startedAtMs: 1_700_000_000_000 });

    expect(built.verdict).toBe('passed');
    expect(built.durationMs).toBe(1200);
    expect(built.startedAtMs).toBe(1_700_000_000_000);
    expect(built.outputTail).toBeUndefined();
  });

  test('a failing check carries the bounded tail of what the command wrote', () => {
    const built = record({ run: { exitCode: 1, stdout: 'first\n', stderr: 'second' } });

    expect(built.verdict).toBe('failed');
    expect(built.outputTail).toContain('first');
    expect(built.outputTail).toContain('second');
  });

  // #1155: the record has no selection metadata left to carry. A stage runs the
  // entire required set, so there is nothing to say about *why* a check was in
  // it — and an input that still names the retired fields cannot smuggle them
  // back onto the record.
  test('no selection metadata survives onto the record', () => {
    const built = record({ run: PASSED, membership: 'final-only', selectedBy: ['regression'] });

    expect(built.membership).toBeUndefined();
    expect(built.selectedBy).toBeUndefined();
    expect(Object.keys(built).sort()).toEqual([
      'checkId',
      'commandDigest',
      'durationMs',
      'exitCode',
      'name',
      'verdict',
    ]);
  });

  test('a check that never launched is not-run, with no duration at all', () => {
    const built = record({ notRunKind: 'first-failure-stop', notRunReason: 'stopped at lint' });

    expect(built.verdict).toBe('not-run');
    expect(built.notRunKind).toBe('first-failure-stop');
    expect(built.notRunReason).toBe('stopped at lint');
    // §6.2: an accounted absence is not a zero-duration run — recording it as
    // one would make "ran instantly" and "never ran" the same bytes.
    expect(built.durationMs).toBeUndefined();
    expect(built.exitCode).toBeUndefined();
  });

  test('an absence with no stated cause is evidence-lost, never a quieter member', () => {
    expect(record().notRunKind).toBe('evidence-lost');
    expect(CHECK_NOT_RUN_KINDS).toContain('evidence-lost');
    expect(CHECK_NOT_RUN_KINDS).toHaveLength(7);
  });

  test('a requirement slot carries no name of its own (§6.1 rule 3)', () => {
    const built = buildCheckExecutionRecord({
      checkId: 'req:0123456789abcdef',
      name: 'test',
      command: 'npm test',
      run: { exitCode: 1 },
    });

    expect(isExecutionCheckId(built.checkId)).toBe(false);
    expect(built.name).toBeUndefined();
  });

  test('an over-long notRunReason is bounded rather than carried whole', () => {
    const built = record({ notRunReason: 'x'.repeat(MAX_CHECK_TEXT_CHARS + 50) });

    expect(built.notRunReason.length).toBe(MAX_CHECK_TEXT_CHARS);
  });
});
