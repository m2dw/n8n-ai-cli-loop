/**
 * Pure classification of an implementation-phase verification failure that
 * survived the bounded inline repair attempt (issue #934).
 *
 * The default answer must be "ordinary": a misread ordinary failure only spends
 * a bounded repair cycle and still reaches a human at the cap, while a misread
 * setup failure would burn agent runs against a machine that can never pass.
 */
import {
  DEFAULT_MAX_VERIFICATION_REPAIR_CYCLES,
  VERIFICATION_REPAIR_CYCLES_CONTEXT_FIELD,
  classifyVerificationEnvironmentFailure,
  decideImplementationVerificationOutcome,
  describeVerificationEnvironmentSignal,
  verificationRepairCyclesSpent,
} from '../dist/core/implementation-verification.js';
import {
  MAX_TRANSIENT_VERIFICATION_RETRIES,
  TRANSIENT_VERIFICATION_LEDGER_KEY,
} from '../dist/core/review-classifier.js';
import { CLI_PROBE_INDETERMINATE_MARKER } from '../dist/core/cli-probe.js';

const failure = (overrides = {}) => ({
  name: 'test',
  exitCode: 1,
  output: 'FAIL: 1 test failed',
  ...overrides,
});

describe('classifyVerificationEnvironmentFailure', () => {
  test('an ordinary red suite is not an environment failure', () => {
    expect(classifyVerificationEnvironmentFailure(failure())).toBeUndefined();
  });

  test("Node's spawn diagnostic for a missing or non-executable binary is recognized", () => {
    for (const errno of ['ENOENT', 'EACCES', 'EPERM', 'ENOEXEC']) {
      expect(
        classifyVerificationEnvironmentFailure(failure({ output: `Error: spawnSync npm ${errno}` })),
      ).toBe('spawn_failed');
    }
    expect(
      classifyVerificationEnvironmentFailure(failure({ output: 'Error: spawn npm ENOENT' })),
    ).toBe('spawn_failed');
  });

  test('a saturated host reporting EAGAIN is NOT read as an operator setup failure', () => {
    // EAGAIN is a resource condition, not a configuration problem; widening the
    // errno set would turn a recoverable failure into a terminal one.
    expect(
      classifyVerificationEnvironmentFailure(failure({ output: 'Error: spawnSync npm EAGAIN' })),
    ).toBeUndefined();
  });

  test('a configured command naming an undefined script is recognized', () => {
    expect(
      classifyVerificationEnvironmentFailure(
        failure({ output: 'npm ERR! Missing script: "test"\nnpm ERR! To see a list of scripts, run:' }),
      ),
    ).toBe('missing_script');
    expect(
      classifyVerificationEnvironmentFailure(failure({ output: 'npm error Missing script: "lint"' })),
    ).toBe('missing_script');
  });

  test("the shell's not-found diagnostic counts only alongside exit 127", () => {
    const output = 'bash: line 1: pytest: command not found';
    expect(classifyVerificationEnvironmentFailure(failure({ output, exitCode: 127 }))).toBe(
      'command_not_found',
    );
    // The same words inside an ordinary failing test run must not be promoted
    // to a terminal environment failure.
    expect(classifyVerificationEnvironmentFailure(failure({ output, exitCode: 1 }))).toBeUndefined();
  });

  test('every signal has an operator-facing explanation', () => {
    for (const signal of ['spawn_failed', 'missing_script', 'command_not_found']) {
      expect(describeVerificationEnvironmentSignal(signal)).toEqual(expect.any(String));
      expect(describeVerificationEnvironmentSignal(signal).length).toBeGreaterThan(0);
    }
  });
});

describe('verificationRepairCyclesSpent', () => {
  test('reads a positive integer and ignores anything else', () => {
    expect(verificationRepairCyclesSpent(undefined)).toBe(0);
    expect(verificationRepairCyclesSpent({})).toBe(0);
    expect(verificationRepairCyclesSpent({ [VERIFICATION_REPAIR_CYCLES_CONTEXT_FIELD]: 2 })).toBe(2);
    expect(verificationRepairCyclesSpent({ [VERIFICATION_REPAIR_CYCLES_CONTEXT_FIELD]: -1 })).toBe(0);
    expect(verificationRepairCyclesSpent({ [VERIFICATION_REPAIR_CYCLES_CONTEXT_FIELD]: '3' })).toBe(0);
    expect(verificationRepairCyclesSpent({ [VERIFICATION_REPAIR_CYCLES_CONTEXT_FIELD]: 1.5 })).toBe(0);
  });
});

describe('decideImplementationVerificationOutcome', () => {
  test('an ordinary failure requeues and counts the cycle', () => {
    expect(decideImplementationVerificationOutcome({ failure: failure() })).toEqual({
      kind: 'repair_requeue',
      cycle: 1,
      maxCycles: DEFAULT_MAX_VERIFICATION_REPAIR_CYCLES,
    });
    expect(
      decideImplementationVerificationOutcome({
        failure: failure(),
        context: { [VERIFICATION_REPAIR_CYCLES_CONTEXT_FIELD]: 1 },
      }),
    ).toMatchObject({ kind: 'repair_requeue', cycle: 2 });
  });

  test('the cap is reached once every cycle is spent', () => {
    expect(
      decideImplementationVerificationOutcome({
        failure: failure(),
        context: {
          [VERIFICATION_REPAIR_CYCLES_CONTEXT_FIELD]: DEFAULT_MAX_VERIFICATION_REPAIR_CYCLES,
        },
      }),
    ).toEqual({
      kind: 'repair_cap_reached',
      cycles: DEFAULT_MAX_VERIFICATION_REPAIR_CYCLES,
      maxCycles: DEFAULT_MAX_VERIFICATION_REPAIR_CYCLES,
    });
  });

  test('the cap is configurable per call', () => {
    expect(
      decideImplementationVerificationOutcome({ failure: failure(), maxCycles: 1 }),
    ).toMatchObject({ kind: 'repair_requeue', cycle: 1, maxCycles: 1 });
    expect(
      decideImplementationVerificationOutcome({
        failure: failure(),
        context: { [VERIFICATION_REPAIR_CYCLES_CONTEXT_FIELD]: 1 },
        maxCycles: 1,
      }),
    ).toMatchObject({ kind: 'repair_cap_reached' });
  });

  test('an environment failure never becomes a repair cycle', () => {
    expect(
      decideImplementationVerificationOutcome({
        failure: failure({ output: 'Error: spawnSync npm ENOENT' }),
      }),
    ).toEqual({ kind: 'environment', signal: 'spawn_failed' });
  });

  test('an indeterminate CLI probe delays first, on the per-command budget', () => {
    const probeFailure = failure({ output: `doctor ${CLI_PROBE_INDETERMINATE_MARKER} timed out` });
    expect(decideImplementationVerificationOutcome({ failure: probeFailure })).toEqual({
      kind: 'transient',
      signal: CLI_PROBE_INDETERMINATE_MARKER,
      attempt: 1,
      maxAttempts: MAX_TRANSIENT_VERIFICATION_RETRIES,
    });
    // The budget is per verification COMMAND: another command's spent budget
    // must not deny this one its own first retry.
    expect(
      decideImplementationVerificationOutcome({
        failure: probeFailure,
        context: { [TRANSIENT_VERIFICATION_LEDGER_KEY]: { package: MAX_TRANSIENT_VERIFICATION_RETRIES } },
      }),
    ).toMatchObject({ kind: 'transient', attempt: 1 });
  });

  test('a spent transient budget falls through to the ordinary requeue', () => {
    expect(
      decideImplementationVerificationOutcome({
        failure: failure({ output: `doctor ${CLI_PROBE_INDETERMINATE_MARKER} timed out` }),
        context: { [TRANSIENT_VERIFICATION_LEDGER_KEY]: { test: MAX_TRANSIENT_VERIFICATION_RETRIES } },
      }),
    ).toMatchObject({ kind: 'repair_requeue', cycle: 1 });
  });

  test('the transient signal wins over an environment pattern in the same output', () => {
    // A probe that could not fork reports both the marker and a spawn errno;
    // the host, not the configuration, is what is wrong.
    expect(
      decideImplementationVerificationOutcome({
        failure: failure({
          output: `${CLI_PROBE_INDETERMINATE_MARKER}\nError: spawnSync claude ENOENT`,
        }),
      }),
    ).toMatchObject({ kind: 'transient' });
  });
});
