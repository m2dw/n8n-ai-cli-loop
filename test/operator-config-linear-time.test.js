// Issue #1200 — operator/session configuration string checks run in linear time.
//
// Each case feeds a long adversarial value shaped for the regex it replaced
// (CodeQL polynomial-regex alerts #27, #28, #31, #32): at ADVERSARIAL_LENGTH
// the old patterns take seconds to minutes, a linear scan a few milliseconds.
// The budget is deliberately far from both, so a starved host cannot turn a
// linear run into a failure and a quadratic one cannot pass. The behavior
// tables next to each timing case pin that the rewrite changed nothing else.
import { mkdtempSync, realpathSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parseAntigravityPrintTimeout } from '../dist/core/antigravity-print-timeout.js';
import { sameGiteaInstance } from '../dist/core/outbox-effects.js';
import { discoverTestFiles } from '../dist/index.js';

const ADVERSARIAL_LENGTH = 200_000;
const BUDGET_MS = 2_000;

function elapsedMs(fn) {
  const start = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - start) / 1e6;
}

function errorOf(fn) {
  try {
    fn();
  } catch (err) {
    return err.message;
  }
  throw new Error('expected a throw');
}

describe('parseAntigravityPrintTimeout (alerts on the duration segment regex)', () => {
  test('a long digit run without a unit is rejected in linear time', () => {
    const digits = '1'.repeat(ADVERSARIAL_LENGTH);
    for (const [raw, message] of [
      [`${digits}x`, /is not a valid duration \(expected/],
      [`${digits}x5m`, /unexpected characters at position 0/],
      [`5m${digits}`, /is not a valid duration \(expected/],
      [`1.${digits}x`, /is not a valid duration \(expected/],
    ]) {
      let actual;
      const ms = elapsedMs(() => { actual = errorOf(() => parseAntigravityPrintTimeout(raw)); });
      expect(actual).toMatch(message);
      expect(ms).toBeLessThan(BUDGET_MS);
    }
  });

  test('a long zero-padded valid value is still accepted in linear time', () => {
    const raw = `${'0'.repeat(ADVERSARIAL_LENGTH)}1m`;
    let resolved;
    const ms = elapsedMs(() => { resolved = parseAntigravityPrintTimeout(raw); });
    expect(resolved).toEqual({ raw, ms: 60_000 });
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  test('accepted units, bounds and error messages are unchanged', () => {
    for (const [raw, ms] of [
      ['15m', 900_000],
      ['90s', 90_000],
      ['1h', 3_600_000],
      ['45m20s', 2_720_000],
      ['1.5m', 90_000],
      ['  20m  ', 1_200_000],
      ['0h15m', 900_000],
      ['30s10m', 630_000],
    ]) {
      expect(parseAntigravityPrintTimeout(raw)).toEqual({ raw: raw.trim(), ms });
    }
    for (const [raw, message] of [
      ['', /must be a non-empty duration string/],
      ['   ', /must be a non-empty duration string/],
      ['1h30m', /must not exceed 60 minutes/],
      ['10h', /must not exceed 60 minutes/],
      ['0m', /must be greater than zero/],
      ['0m0s', /must be greater than zero/],
      ['900', /^is not a valid duration \(expected a value like "15m", "90s", or "1h30m"\)$/],
      ['fifteen minutes', /^is not a valid duration \(expected a value like "15m", "90s", or "1h30m"\)$/],
      ['15mx', /^is not a valid duration \(expected a value like "15m", "90s", or "1h30m"\)$/],
      ['-15m', /unexpected characters at position 0$/],
      ['x15m', /unexpected characters at position 0$/],
      ['15m x5s', /unexpected characters at position 3$/],
      ['1.m', /^is not a valid duration \(expected a value like "15m", "90s", or "1h30m"\)$/],
      ['.5m', /unexpected characters at position 0$/],
      ['1.5.5m', /unexpected characters at position 0$/],
      ['5m5m', /unit "m" is repeated/],
      ['1H', /^is not a valid duration \(expected/],
    ]) {
      expect(errorOf(() => parseAntigravityPrintTimeout(raw))).toMatch(message);
    }
  });
});

describe('sameGiteaInstance (alert on the trailing-slash regex)', () => {
  test('a long run of slashes is normalized in linear time', () => {
    const slashes = '/'.repeat(ADVERSARIAL_LENGTH);
    for (const [a, b, same] of [
      [`https://gitea.example${slashes}`, 'https://gitea.example', true],
      [`https://gitea.example${slashes}x`, 'https://gitea.example', false],
      [`a${slashes}a`, 'a/a', false],
    ]) {
      let result;
      const ms = elapsedMs(() => { result = sameGiteaInstance(a, b); });
      expect(result).toBe(same);
      expect(ms).toBeLessThan(BUDGET_MS);
    }
  });

  test('the comparison contract is unchanged', () => {
    for (const [a, b, same] of [
      ['https://gitea.example', 'https://gitea.example/', true],
      ['https://gitea.example///', 'https://gitea.example', true],
      ['  https://gitea.example/  ', 'https://gitea.example', true],
      ['HTTPS://Gitea.Example/gitea', 'https://gitea.example/gitea/', true],
      ['https://gitea.example/gitea', 'https://gitea.example/Gitea', false],
      ['https://gitea.example/a', 'https://gitea.example/b', false],
      ['https://gitea.example', 'http://gitea.example', false],
      ['/', '', true],
    ]) {
      expect(sameGiteaInstance(a, b)).toBe(same);
      expect(sameGiteaInstance(b, a)).toBe(same);
    }
  });
});

describe('suite command -c option recognition (alerts at both call sites)', () => {
  let cwd;
  let real;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'operator-config-linear-'));
    real = realpathSync(cwd);
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  const options = (suiteCommand) => ({ cwd, suiteCommand, binding: { adapter: 'jest' } });

  function discoveryArgv(suiteCommand) {
    const calls = [];
    const runner = {
      run(cmd, args) {
        calls.push([cmd, ...args]);
        return { stdout: JSON.stringify([join(real, 'test/a.test.js')]), stderr: '', exitCode: 0 };
      },
    };
    discoverTestFiles(runner, options(suiteCommand));
    return calls[0];
  }

  // A long cluster of `c` letters ending in a non-letter drove the old pattern's
  // two ambiguous letter runs quadratic.
  const cluster = `-${'c'.repeat(ADVERSARIAL_LENGTH)}`;

  test('a long option before a -c behind a launcher is refused in linear time (hasCommandStringShell)', () => {
    let message;
    const ms = elapsedMs(() => {
      message = errorOf(() => discoverTestFiles({ run: () => { throw new Error('launched'); } },
        options(`env sh ${cluster}1 -c 'npx jest'`)));
    });
    expect(message).toMatch(/cannot forward/);
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  test('a long option that is not a -c cluster is not read as one in linear time (wrappedScriptIndex)', () => {
    let argv;
    const ms = elapsedMs(() => { argv = discoveryArgv(`sh ${cluster}1 npx`); });
    expect(argv.slice(0, 3)).toEqual(['sh', `${cluster}1`, 'npx']);
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  test('a long -c cluster is still recognized as a wrapper in linear time', () => {
    let argv;
    const ms = elapsedMs(() => { argv = discoveryArgv(`bash ${cluster} 'npx jest'`); });
    expect(argv).toEqual(['bash', cluster, 'npx jest --listTests --json']);
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  test('wrapper recognition and fail-closed refusal are unchanged', () => {
    for (const suiteCommand of ["bash -c 'npx jest'", "bash -lc 'npx jest'", "sh -euc 'npx jest'", "bash -e -c 'npx jest'"]) {
      expect(discoveryArgv(suiteCommand).at(-1)).toBe('npx jest --listTests --json');
    }
    for (const suiteCommand of [
      "env sh -c 'npx jest'",
      "env sh -lc 'npx jest'",
      "nice bash -xc 'npx jest'",
    ]) {
      expect(errorOf(() => discoverTestFiles({ run: () => { throw new Error('launched'); } }, options(suiteCommand))))
        .toMatch(/cannot forward/);
    }
    // Not a -c cluster: a digit, a double dash, or no `c` at all.
    for (const [suiteCommand, argv] of [
      ['sh -c1 npx', ['sh', '-c1', 'npx', '--listTests', '--json']],
      ['sh --c npx', ['sh', '--c', 'npx', '--listTests', '--json']],
      ['sh -x npx', ['sh', '-x', 'npx', '--listTests', '--json']],
    ]) {
      expect(discoveryArgv(suiteCommand)).toEqual(argv);
    }
  });
});
