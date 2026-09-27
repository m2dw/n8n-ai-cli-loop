// Issue #1109 — the opt-in test-cost baseline helpers in
// `scripts/test-cost-baseline.mjs`. Only the pure summarizers and the timed
// runner are exercised; the suite never runs the build or Jest itself.

import { EventEmitter } from 'events';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { availableParallelism, tmpdir } from 'os';
import { join } from 'path';

import {
  boundedList,
  classifyRun,
  compareRuns,
  DIRTY_NOT_MEASURED,
  dirtyFlag,
  dirtyPathList,
  displayJestCommand,
  exitCodeFor,
  inventorySource,
  JEST_ENTRY,
  MAX_LISTED_FAILURES,
  mdCell,
  mdCodeCell,
  npmInvocation,
  MAX_REPEAT,
  PARENT_SIGNALS,
  parseArgs,
  parseWindowsProcessTable,
  rankSuites,
  renderReport,
  resolveJestWorkers,
  runTimed,
  sanitizePath,
  sanitizeText,
  shellQuote,
  statusArgsExcludingOut,
  summarizeJestResults,
  windowsDescendantPids,
  windowsTreeKillArgs,
} from '../scripts/test-cost-baseline.mjs';

const ROOT = '/work/repo';

function suite(name, runtime, assertions, extra = {}) {
  return {
    name: `${ROOT}/test/${name}`,
    status: assertions.some((a) => a.status === 'failed') ? 'failed' : 'passed',
    perfStats: { start: 1000, end: 1000 + runtime, runtime },
    assertionResults: assertions,
    ...extra,
  };
}

const pass = (fullName) => ({ status: 'passed', fullName });
const fail = (fullName) => ({ status: 'failed', fullName });

function jestJson(testResults) {
  const all = testResults.flatMap((s) => s.assertionResults);
  return {
    numTotalTestSuites: testResults.length,
    numFailedTestSuites: testResults.filter((s) => s.status === 'failed').length,
    numRuntimeErrorTestSuites: 0,
    numTotalTests: all.length,
    numPassedTests: all.filter((a) => a.status === 'passed').length,
    numFailedTests: all.filter((a) => a.status === 'failed').length,
    numPendingTests: all.filter((a) => a.status === 'pending').length,
    numTodoTests: 0,
    testResults,
  };
}

describe('parseArgs', () => {
  test('defaults leave Jest workers unset and run once', () => {
    const options = parseArgs([]);
    expect(options.repeat).toBe(1);
    expect(options.maxWorkers).toBeUndefined();
    expect(options.out).toBe('.test-cost');
    expect(options.skipBuild).toBe(false);
  });

  test('bounds repetitions and rejects unknown or invalid arguments', () => {
    expect(parseArgs(['--repeat', String(MAX_REPEAT), '--max-workers', '2', '--skip-build'], { parallelism: 8 })).toMatchObject({
      repeat: MAX_REPEAT,
      maxWorkers: 2,
      skipBuild: true,
    });
    expect(() => parseArgs(['--repeat', String(MAX_REPEAT + 1)])).toThrow(/invalid --repeat/);
    expect(() => parseArgs(['--repeat', '0'])).toThrow(/invalid --repeat/);
    expect(() => parseArgs(['--max-workers', '1.5'])).toThrow(/invalid --max-workers/);
    expect(() => parseArgs(['--top'])).toThrow(/missing value/);
    expect(() => parseArgs(['--bogus', '1'])).toThrow(/unknown argument/);
  });

  test('caps --max-workers at the available parallelism', () => {
    expect(parseArgs(['--max-workers', '8'], { parallelism: 8 }).maxWorkers).toBe(8);
    expect(() => parseArgs(['--max-workers', '9'], { parallelism: 8 })).toThrow(/invalid --max-workers: 9 \(1-8\)/);
    expect(() => parseArgs(['--max-workers', '4000'], { parallelism: 8 })).toThrow(/invalid --max-workers/);
    expect(parseArgs(['--max-workers', '1'], { parallelism: 0 }).maxWorkers).toBe(1);
  });

  test('defaults the --max-workers cap to os.availableParallelism(), not the CPU count', () => {
    const limit = Math.max(1, availableParallelism());
    expect(parseArgs(['--max-workers', String(limit)]).maxWorkers).toBe(limit);
    expect(() => parseArgs(['--max-workers', String(limit + 1)])).toThrow(
      new RegExp(`invalid --max-workers: ${limit + 1} \\(1-${limit}\\)`),
    );
  });
});

describe('sanitizePath', () => {
  test('strips the checkout root and masks home and temp locations', () => {
    const paths = { root: ROOT, home: '/Users/someone', tmp: '/var/tmp' };
    expect(sanitizePath(`${ROOT}/test/a.test.js`, paths)).toBe('test/a.test.js');
    expect(sanitizePath('/var/tmp/x/y.js', paths)).toBe('<tmp>/x/y.js');
    expect(sanitizePath('/Users/someone/other/z.js', paths)).toBe('<home>/other/z.js');
    expect(sanitizePath('/work/repository/test/a.test.js', paths)).toBe('/work/repository/test/a.test.js');
  });

  test('matches Windows-style prefixes case-insensitively, POSIX prefixes exactly', () => {
    const win = { root: 'C:\\Work\\Repo', home: 'C:\\Users\\Someone' };
    expect(sanitizePath('c:\\work\\repo\\test\\A.test.js', win)).toBe('test/A.test.js');
    expect(sanitizePath('C:/WORK/REPO', win)).toBe('.');
    expect(sanitizePath('c:\\users\\someone\\x.js', win)).toBe('<home>/x.js');
    expect(sanitizePath('c:\\work\\repository\\a.js', win)).toBe('c:/work/repository/a.js');
    expect(sanitizePath('\\\\SERVER\\Share\\repo\\a.js', { root: '\\\\server\\share\\repo' })).toBe('a.js');
    expect(sanitizePath('/users/someone/z.js', { home: '/Users/someone' })).toBe('/users/someone/z.js');
  });

  test('masks a caller-chosen output root outside the checkout, home and temp', () => {
    const paths = { root: ROOT, home: '/Users/someone', tmp: '/var/tmp', output: '/mnt/private/reports' };
    expect(sanitizePath('/mnt/private/reports/dry-run/run.log', paths)).toBe('<out>/dry-run/run.log');
    expect(sanitizePath('/mnt/private/reports', paths)).toBe('<out>');
    expect(sanitizePath('/mnt/private/reportsx/a', paths)).toBe('/mnt/private/reportsx/a');
    // An in-tree output root is still reported relative to the checkout.
    expect(sanitizePath(`${ROOT}/.mutation/x`, { ...paths, output: `${ROOT}/.mutation` })).toBe('.mutation/x');
  });
});

describe('sanitizeText', () => {
  test('masks path prefixes anywhere in text, only at component boundaries', () => {
    const paths = { root: ROOT, home: '/Users/someone', tmp: '/var/tmp' };
    expect(sanitizeText(`fails in ${ROOT}/src/a.ts (${ROOT})`, paths)).toBe('fails in ./src/a.ts (.)');
    expect(sanitizeText('C:\\Users\\someone\\x and /Users/someone/y', { home: 'C:\\Users\\someone' })).toBe(
      '<home>\\x and /Users/someone/y',
    );
    expect(sanitizeText('/var/tmp/j, /Users/someone/k', paths)).toBe('<tmp>/j, <home>/k');
    expect(sanitizeText('/work/repository/a', paths)).toBe('/work/repository/a');
  });

  test('masks a caller-chosen output root anywhere in text', () => {
    const paths = { root: ROOT, home: '/Users/someone', tmp: '/var/tmp', output: '/mnt/private/reports' };
    expect(sanitizeText('cannot remove /mnt/private/reports/stryker-tmp/sandbox-1/a.js', paths)).toBe(
      'cannot remove <out>/stryker-tmp/sandbox-1/a.js',
    );
    expect(sanitizeText('/mnt/private/reportsx/a', paths)).toBe('/mnt/private/reportsx/a');
  });

  test('masks the physical target of a symlinked output root too', () => {
    // A symlinked `--out` keeps its lexical path in `output`, but processes run
    // inside it report their canonical working directory.
    const paths = { root: ROOT, home: '/Users/someone', tmp: '/var/tmp', output: '/opt/out-link', outputReal: '/srv/disk2/reports' };
    expect(sanitizeText('ENOENT: /srv/disk2/reports/stryker-tmp/sandbox-1/a.js', paths)).toBe(
      'ENOENT: <out>/stryker-tmp/sandbox-1/a.js',
    );
    expect(sanitizeText('/opt/out-link/x', paths)).toBe('<out>/x');
    expect(sanitizePath('/srv/disk2/reports/dry-run/run.log', paths)).toBe('<out>/dry-run/run.log');
    expect(sanitizePath('/srv/disk2/reportsx/a', paths)).toBe('/srv/disk2/reportsx/a');
  });

  test('matches Windows-style prefixes case-insensitively, POSIX prefixes exactly', () => {
    const win = { root: 'C:\\Work\\Repo', home: 'C:\\Users\\Someone' };
    expect(sanitizeText('fails in c:\\work\\repo\\src\\a.ts and C:/WORK/REPO/b.ts', win)).toBe(
      'fails in .\\src\\a.ts and ./b.ts',
    );
    expect(sanitizeText('see c:\\USERS\\someone\\k', win)).toBe('see <home>\\k');
    expect(sanitizeText('c:\\work\\repository\\a', win)).toBe('c:\\work\\repository\\a');
    expect(sanitizeText('/users/someone/k', { home: '/Users/someone' })).toBe('/users/someone/k');
  });

  test('masks Windows paths that mix both separators', () => {
    const win = { root: 'C:\\Work\\Repo', home: 'C:\\Users\\Someone' };
    expect(sanitizeText('fails in C:\\Work/Repo\\test.js', win)).toBe('fails in .\\test.js');
    expect(sanitizeText('fails in c:/work\\repo/test.js', win)).toBe('fails in ./test.js');
    expect(sanitizeText('see C:/Users\\Someone/k', win)).toBe('see <home>/k');
    expect(sanitizeText('C:\\Work/Repository\\a', win)).toBe('C:\\Work/Repository\\a');
  });
});

describe('classifyRun', () => {
  test('a timeout, signal or missing result file is interrupted, never complete', () => {
    expect(classifyRun({ exitCode: null, signal: 'SIGTERM', timedOut: true })).toEqual({
      state: 'interrupted',
      reason: 'timeout',
    });
    expect(classifyRun({ exitCode: null, signal: 'SIGKILL', timedOut: false })).toEqual({
      state: 'interrupted',
      reason: 'signal:SIGKILL',
    });
    expect(classifyRun({ exitCode: 1, signal: null, timedOut: false, resultsPresent: false })).toEqual({
      state: 'interrupted',
      reason: 'no-results',
    });
  });

  test('a run that exits on its own is complete, with or without failures', () => {
    expect(classifyRun({ exitCode: 0, signal: null, timedOut: false })).toEqual({ state: 'complete', reason: 'passed' });
    expect(classifyRun({ exitCode: 1, signal: null, timedOut: false })).toEqual({ state: 'complete', reason: 'exit:1' });
  });

  test('a process group that outlived SIGKILL is interrupted even when its leader exited zero', () => {
    const survived = { exitCode: 0, signal: null, timedOut: false, groupSurvived: true };
    expect(classifyRun(survived)).toEqual({ state: 'interrupted', reason: 'group-survived' });
    expect(classifyRun({ ...survived, timedOut: true, signal: 'SIGTERM' }).reason).toBe('group-survived');
    expect(exitCodeFor([{ phase: 'test run 1', ...survived, ...classifyRun(survived) }])).toBe(1);
  });
});

describe('exitCodeFor', () => {
  const entry = (result, resultsPresent = true, phase = 'test run 1') => ({
    phase,
    ...result,
    ...classifyRun({ ...result, resultsPresent }),
  });

  test('any interrupted command fails the CLI, not only parent signals', () => {
    const build = entry({ exitCode: 0, signal: null, timedOut: false }, true, 'build');
    expect(exitCodeFor([build, entry({ exitCode: null, signal: 'SIGTERM', timedOut: true })])).toBe(1);
    expect(exitCodeFor([entry({ exitCode: null, signal: 'SIGTERM', timedOut: true })])).toBe(1);
    expect(exitCodeFor([build, entry({ exitCode: null, signal: 'SIGKILL', timedOut: false })])).toBe(1);
    expect(exitCodeFor([build, entry({ exitCode: 1, signal: null, timedOut: false }, false)])).toBe(1);
    expect(exitCodeFor([build, entry({ exitCode: null, signal: 'SIGINT', timedOut: false, interruptedBy: 'SIGINT' })])).toBe(1);
  });

  test('a build that exits nonzero fails the CLI even though it is complete', () => {
    const failedBuild = entry({ exitCode: 2, signal: null, timedOut: false }, true, 'build');
    expect(failedBuild.state).toBe('complete');
    expect(exitCodeFor([failedBuild])).toBe(1);
  });

  test('complete runs exit 0 even when Jest reports assertion failures', () => {
    const build = entry({ exitCode: 0, signal: null, timedOut: false }, true, 'build');
    expect(exitCodeFor([build, entry({ exitCode: 1, signal: null, timedOut: false })])).toBe(0);
    expect(exitCodeFor([build, entry({ exitCode: 0, signal: null, timedOut: false })])).toBe(0);
  });
});

describe('summarizeJestResults', () => {
  test('reports per-suite durations and counts from Jest perfStats', () => {
    const summary = summarizeJestResults(
      jestJson([
        suite('slow.test.js', 9000, [pass('a'), fail('b'), { status: 'pending', fullName: 'c' }]),
        suite('fast.test.js', 100, [pass('d')]),
      ]),
      { root: ROOT },
    );
    expect(summary.totals).toMatchObject({ suites: 2, tests: 4, passed: 2, failed: 1, skipped: 1, suiteDurationSumMs: 9100 });
    expect(summary.suites[0]).toEqual({
      file: 'test/slow.test.js',
      durationMs: 9000,
      tests: 3,
      failed: 1,
      skipped: 1,
      suiteError: false,
      failedTests: ['b'],
      passedTests: ['a'],
    });
  });

  test('reads suite durations from the startTime/endTime fields Jest --json actually writes', () => {
    const summary = summarizeJestResults(
      jestJson([
        { name: `${ROOT}/test/cli.test.js`, status: 'passed', startTime: 1_700_000_000_000, endTime: 1_700_000_045_000, assertionResults: [pass('a')] },
        { name: `${ROOT}/test/skipped.test.js`, status: 'skipped', startTime: 1_700_000_000_500, endTime: 1_700_000_000_500, assertionResults: [] },
      ]),
      { root: ROOT },
    );
    expect(summary.suites.map((s) => s.durationMs)).toEqual([45_000, 0]);
    expect(summary.totals.suiteDurationSumMs).toBe(45_000);
  });

  test('masks checkout, home and temp paths embedded in failed test names', () => {
    const paths = { root: ROOT, home: '/Users/someone', tmp: '/var/tmp' };
    const summary = summarizeJestResults(
      jestJson([
        suite('p.test.js', 10, [
          fail(`reads ${ROOT}/config.json and /var/tmp/x/repo`),
          { status: 'failed', title: 'writes /Users/someone/.cache/y' },
        ]),
      ]),
      paths,
    );
    expect(summary.suites[0].failedTests).toEqual(['reads ./config.json and <tmp>/x/repo', 'writes <home>/.cache/y']);
    expect(JSON.stringify(summary)).not.toMatch(/\/work\/repo|\/Users\/someone|\/var\/tmp/);
  });

  test('zero timestamps from a suite that failed to load are an unknown duration, not 0', () => {
    const summary = summarizeJestResults(
      jestJson([{ name: `${ROOT}/test/broken.test.js`, status: 'failed', startTime: 0, endTime: 0, testExecError: { message: 'x' }, assertionResults: [] }]),
      { root: ROOT },
    );
    expect(summary.suites[0]).toMatchObject({ durationMs: null, suiteError: true });
    expect(summary.totals.suiteDurationSumMs).toBeNull();
  });

  test('a suite that failed to load is a suite error, and missing perfStats stay unknown', () => {
    const summary = summarizeJestResults(
      jestJson([{ name: `${ROOT}/test/broken.test.js`, status: 'failed', testExecError: { message: 'x' }, assertionResults: [] }]),
      { root: ROOT },
    );
    expect(summary.suites[0]).toMatchObject({ file: 'test/broken.test.js', durationMs: null, tests: 0, suiteError: true });
  });

  test('a suite that failed after its assertions passed (e.g. in afterAll) is a suite error', () => {
    const summary = summarizeJestResults(
      jestJson([suite('hook.test.js', 300, [pass('a'), pass('b')], { status: 'failed', failureMessage: 'afterAll threw' })]),
      { root: ROOT },
    );
    expect(summary.suites[0]).toMatchObject({ tests: 2, failed: 0, suiteError: true });
    const runs = [{ state: 'complete', summary }, { state: 'complete', summary }];
    expect(compareRuns(runs).consistentFailures).toEqual(['test/hook.test.js (suite error)']);
  });

  test('one unknown suite duration makes the duration sum unknown, not a partial sum', () => {
    const summary = summarizeJestResults(
      jestJson([
        suite('ok.test.js', 4000, [pass('a')]),
        { name: `${ROOT}/test/broken.test.js`, status: 'failed', testExecError: { message: 'x' }, assertionResults: [] },
      ]),
      { root: ROOT },
    );
    expect(summary.totals.suiteDurationSumMs).toBeNull();
    const report = renderReport({
      environment: {},
      commands: [],
      runs: [{ index: 1, state: 'complete', summary }],
      top: [],
      comparison: { completeRuns: 1, interruptedRuns: 0, consistentFailures: [], flakeCandidates: [] },
    });
    expect(report).toContain('| 1 (complete) | 2 | 1 | 1 | 0 | 0 | unknown |');
  });
});

describe('displayJestCommand', () => {
  test('shows the output file under the sanitized --out directory', () => {
    const args = ['--experimental-vm-modules', 'node_modules/.bin/jest', '--json', '--outputFile=/Users/someone/x/jest-run-1.json'];
    const paths = { root: ROOT, home: '/Users/someone', tmp: '/var/tmp' };
    expect(displayJestCommand(args, `${ROOT}/.test-cost`, 1, paths)).toBe(
      'node --experimental-vm-modules node_modules/.bin/jest --json --outputFile=.test-cost/jest-run-1.json',
    );
    expect(displayJestCommand(args, '/Users/someone/x', 1, paths)).toContain('--outputFile=<home>/x/jest-run-1.json');
    expect(displayJestCommand(args, '/var/tmp/out', 2, paths)).toContain('--outputFile=<tmp>/out/jest-run-2.json');
    expect(displayJestCommand(args, '/Users/someone/x', 1, paths)).not.toContain('/Users/someone');
  });

  test('quotes an output path with spaces or shell metacharacters so the command replays', () => {
    const args = ['--experimental-vm-modules', 'node_modules/.bin/jest', '--json', '--outputFile=ignored'];
    const paths = { root: ROOT, home: '/Users/someone', tmp: '/var/tmp' };
    expect(displayJestCommand(args, `${ROOT}/cost out;$(x)`, 1, paths)).toBe(
      "node --experimental-vm-modules node_modules/.bin/jest --json '--outputFile=cost out;$(x)/jest-run-1.json'",
    );
    expect(displayJestCommand(args, `${ROOT}/it's`, 2, paths)).toContain(`'--outputFile=it'\\''s/jest-run-2.json'`);
  });
});

describe('npmInvocation', () => {
  test('runs plain npm on POSIX when npm did not start the script', () => {
    expect(npmInvocation(['run', 'build'], { platform: 'darwin', execPath: '/usr/bin/node', env: {} })).toEqual({
      command: 'npm',
      args: ['run', 'build'],
    });
  });

  test('never spawns npm.cmd on Windows: runs the bundled npm-cli.js with node', () => {
    expect(
      npmInvocation(['run', 'build'], { platform: 'win32', execPath: 'C:\\Program Files\\nodejs\\node.exe', env: {} }),
    ).toEqual({
      command: 'C:\\Program Files\\nodejs\\node.exe',
      args: ['C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js', 'run', 'build'],
    });
  });

  test('prefers the npm CLI script npm reports in npm_execpath', () => {
    const env = { npm_execpath: 'C:\\nvm\\npm\\bin\\npm-cli.js' };
    expect(npmInvocation(['--version'], { platform: 'win32', execPath: 'node.exe', env })).toEqual({
      command: 'node.exe',
      args: ['C:\\nvm\\npm\\bin\\npm-cli.js', '--version'],
    });
    // A non-JS execpath (e.g. a shim) is not handed to node.
    expect(npmInvocation(['--version'], { platform: 'linux', execPath: 'node', env: { npm_execpath: '/x/npm' } })).toEqual({
      command: 'npm',
      args: ['--version'],
    });
  });
});

describe('JEST_ENTRY', () => {
  test("is Jest's JavaScript bin, not the .bin shell shim", () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'node_modules/jest/package.json'), 'utf8'));
    expect(JEST_ENTRY).toBe(join('node_modules/jest', pkg.bin).split('\\').join('/'));
    expect(JEST_ENTRY).not.toContain('.bin');
  });
});

describe('shellQuote', () => {
  test('leaves plain arguments bare and single-quotes everything else', () => {
    expect(shellQuote('--maxWorkers=4')).toBe('--maxWorkers=4');
    expect(shellQuote('a b')).toBe("'a b'");
    expect(shellQuote('<home>/x')).toBe("'<home>/x'");
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    expect(shellQuote('')).toBe("''");
  });
});

describe('resolveJestWorkers', () => {
  test('records the explicit count or the count Jest derives by default', () => {
    expect(resolveJestWorkers(4, { parallelism: 10 })).toBe('4 (--maxWorkers=4)');
    expect(resolveJestWorkers(undefined, { parallelism: 10 })).toBe(
      '9 (jest default: max(availableParallelism 10 - 1, 1))',
    );
    expect(resolveJestWorkers(undefined, { parallelism: 1 })).toMatch(/^1 \(jest default/);
  });
});

describe('compareRuns and rankSuites', () => {
  const summaryOf = (results) => summarizeJestResults(jestJson(results), { root: ROOT });

  test('intermittent failures are flake candidates; interrupted runs contribute nothing', () => {
    const runs = [
      { state: 'complete', summary: summaryOf([suite('a.test.js', 500, [fail('x'), fail('y')])]) },
      { state: 'complete', summary: summaryOf([suite('a.test.js', 700, [fail('x'), pass('y')])]) },
      { state: 'interrupted', summary: null },
    ];
    expect(compareRuns(runs)).toEqual({
      completeRuns: 2,
      interruptedRuns: 1,
      consistentFailures: ['test/a.test.js › x'],
      flakeCandidates: ['test/a.test.js › y'],
      unclassifiedFailures: [],
    });
  });

  test('a failure whose other run never executed the test is unclassified, not a flake', () => {
    const broken = { name: `${ROOT}/test/a.test.js`, status: 'failed', testExecError: { message: 'x' }, assertionResults: [] };
    const runs = [
      { state: 'complete', summary: summaryOf([suite('a.test.js', 500, [fail('x')]), suite('b.test.js', 100, [pass('z')])]) },
      { state: 'complete', summary: summaryOf([broken]) },
    ];
    expect(compareRuns(runs)).toEqual({
      completeRuns: 2,
      interruptedRuns: 0,
      consistentFailures: [],
      flakeCandidates: [],
      unclassifiedFailures: ['test/a.test.js › x', 'test/a.test.js (suite error)'],
    });
    const report = renderReport({ environment: {}, commands: [], runs: [], top: [], comparison: compareRuns(runs) });
    expect(report).toContain('Flake candidates (0): none observed');
    expect(report).toContain('(2): test/a.test.js › x; test/a.test.js (suite error)');
  });

  test('a suite error is a flake candidate only when the suite ran cleanly in another run', () => {
    const broken = { name: `${ROOT}/test/a.test.js`, status: 'failed', testExecError: { message: 'x' }, assertionResults: [] };
    const runs = [
      { state: 'complete', summary: summaryOf([broken]) },
      { state: 'complete', summary: summaryOf([suite('a.test.js', 500, [pass('x')])]) },
    ];
    expect(compareRuns(runs)).toMatchObject({ flakeCandidates: ['test/a.test.js (suite error)'], unclassifiedFailures: [] });
  });

  test('ranks by median over complete runs only and never ranks suites from an interrupted run', () => {
    const runs = [
      { state: 'complete', summary: summaryOf([suite('a.test.js', 100, [pass('1')]), suite('b.test.js', 300, [pass('2')])]) },
      { state: 'complete', summary: summaryOf([suite('a.test.js', 900, [pass('1')]), suite('b.test.js', 400, [pass('2')])]) },
      { state: 'complete', summary: summaryOf([suite('a.test.js', 800, [pass('1')])]) },
      // An interrupted run keeps no summary, so its last-printed suite is not charged.
      { state: 'interrupted', summary: summaryOf([suite('last-printed.test.js', 999_999, [pass('3')])]) },
    ];
    expect(rankSuites(runs, 5)).toEqual([
      { file: 'test/a.test.js', tests: 1, medianMs: 800, maxMs: 900, samples: 3 },
      { file: 'test/b.test.js', tests: 1, medianMs: 350, maxMs: 400, samples: 2 },
    ]);
    expect(rankSuites(runs, 1)).toHaveLength(1);
  });

  test('duplicate failing names within one run count once per run', () => {
    const runs = [
      { state: 'complete', summary: summaryOf([suite('a.test.js', 500, [fail('dup'), fail('dup'), fail('once')])]) },
      { state: 'complete', summary: summaryOf([suite('a.test.js', 500, [fail('dup'), pass('once')])]) },
      { state: 'complete', summary: summaryOf([suite('a.test.js', 500, [pass('dup'), fail('once'), fail('once')])]) },
    ];
    expect(compareRuns(runs)).toMatchObject({
      consistentFailures: [],
      flakeCandidates: ['test/a.test.js › dup', 'test/a.test.js › once'],
    });
  });
});

describe('inventorySource', () => {
  test('counts static setup-cost indicators', () => {
    const text = "execFileSync('git', ['init', dir]); spawn('node'); mkdtempSync(p); new Sqlite();";
    expect(inventorySource(text)).toEqual({ subprocessCalls: 2, tempDirs: 1, gitInits: 1, sqlite: 1 });
  });
});

describe('renderReport', () => {
  test('keeps build and test phases separate and prints unknown for interrupted runs', () => {
    const report = renderReport({
      environment: { commit: 'abc123', jestWorkers: 'jest default' },
      commands: [
        { phase: 'build', command: 'npm run build', state: 'complete', reason: 'passed', wallMs: 60_000, loadBefore: '1', loadAfter: '2', freeMemMbAfter: 855 },
        { phase: 'test run 1', command: 'node jest', state: 'interrupted', reason: 'timeout', wallMs: 120_000, loadBefore: '2', loadAfter: '3' },
      ],
      runs: [{ index: 1, state: 'interrupted', summary: null }],
      top: [],
      comparison: { completeRuns: 0, interruptedRuns: 1, consistentFailures: [], flakeCandidates: [] },
    });
    expect(report).toContain('| Load before → after | Free memory after |');
    expect(report).toContain('| build | `npm run build` | complete (passed) | 60.0s | 1 → 2 | 855 MB |');
    expect(report).toContain('| test run 1 | `node jest` | interrupted (timeout) | 120.0s | 2 → 3 | unknown |');
    expect(report).toContain('| 1 (interrupted) | unknown | unknown | unknown | unknown | unknown | unknown |');
    expect(report).toContain('unknown (no complete run)');
  });

  test('failure lists are capped and the omitted count is reported', () => {
    const many = Array.from({ length: MAX_LISTED_FAILURES + 5 }, (_, i) => `test/a.test.js › t${i}`);
    expect(boundedList([])).toBe('none observed');
    expect(boundedList(['x', 'y'])).toBe('x; y');
    const report = renderReport({
      environment: {},
      commands: [],
      runs: [],
      top: [],
      comparison: { completeRuns: 1, interruptedRuns: 0, consistentFailures: many, flakeCandidates: [] },
    });
    expect(report).toContain(`Consistent failures (${many.length}): `);
    expect(report).toContain(`t${MAX_LISTED_FAILURES - 1}; … (5 more omitted; see baseline.json)`);
    expect(report).not.toContain(`t${MAX_LISTED_FAILURES};`);
    expect(report).toContain('Flake candidates (0): none observed');
  });

  test('table cells keep pipes and backticks from breaking the table', () => {
    expect(mdCell('a|b')).toBe('a\\|b');
    expect(mdCell('a\\b')).toBe('a\\\\b');
    expect(mdCodeCell('node --outputFile=/tmp/o|ut/jest-run-1.json')).toBe('`node --outputFile=/tmp/o\\|ut/jest-run-1.json`');
    // The fence has to outgrow the longest backtick run in the value, and a
    // value that starts or ends with a backtick needs a pad so the fence ends.
    expect(mdCodeCell('a`b')).toBe('``a`b``');
    expect(mdCodeCell('a```b')).toBe('````a```b````');
    expect(mdCodeCell('`a`')).toBe('`` `a` ``');
  });

  test('backslash runs before pipes and embedded backticks stay in one code cell and read back verbatim', () => {
    // A GFM row splits on every `|` with no backslash directly before it, then
    // each `\|` becomes `|` before the code span is read (cmark-gfm's
    // `unescape_pipes`). A code span strips one pad space from each side.
    const cells = (row) =>
      row
        .replace(/^\|/, '')
        .replace(/(?<!\\)\|$/, '')
        .split(/(?<!\\)\|/)
        .map((cell) => cell.trim().replace(/\\\|/g, '|'));
    const spanText = (cell) => {
      const fence = cell.match(/^`+/)[0];
      const inner = cell.slice(fence.length, -fence.length);
      return inner.startsWith(' ') && inner.endsWith(' ') && inner.trim() !== '' ? inner.slice(1, -1) : inner;
    };
    expect(mdCodeCell('a\\|b')).toBe('`a\\\\|b`');
    for (const value of ['a\\|b', 'a\\\\|b', '\\\\\\|', '||', 'C:\\out\\', '`\\|`', 'a ``\\|`` b', '`', 'x\\`|']) {
      const row = cells(`| ${mdCodeCell(value)} |`);
      expect(row).toHaveLength(1);
      expect(spanText(row[0])).toBe(value);
      expect(cells(`| ${mdCell(value)} |`)).toHaveLength(1);
    }
  });

  test('metacharacters in a path do not add or break table columns', () => {
    const report = renderReport({
      environment: { out: '/tmp/o|ut' },
      commands: [
        { phase: 'test run 1', command: "node jest '--outputFile=/tmp/o|ut/`x`.json'", state: 'complete', reason: 'exit:0', wallMs: 1_000, loadBefore: '1', loadAfter: '1' },
      ],
      runs: [],
      top: [{ file: 'test/a|b.test.js', tests: 1, medianMs: 1_000, maxMs: 1_000, samples: 1 }],
      comparison: { completeRuns: 1, interruptedRuns: 0, consistentFailures: [], flakeCandidates: [] },
    });
    // Unescaped pipes are the column separators; the data rows must have the
    // same count as the header row of their own table.
    const columns = (line) => line.split(/(?<!\\)\|/).length;
    const rows = report.split('\n');
    const commandHeader = rows.findIndex((l) => l.startsWith('| Phase |'));
    expect(columns(rows[commandHeader + 2])).toBe(columns(rows[commandHeader]));
    const topHeader = rows.findIndex((l) => l.startsWith('| Suite |'));
    expect(columns(rows[topHeader + 2])).toBe(columns(rows[topHeader]));
    expect(report).toContain('| out | /tmp/o\\|ut |');
    expect(report).toContain('| test/a\\|b.test.js | 1 |');
    expect(report).toContain("| test run 1 | ``node jest '--outputFile=/tmp/o\\|ut/`x`.json'`` | complete (exit:0) |");
  });
});

describe('post-build worktree cleanliness', () => {
  test('excludes only this script’s own artifacts when --out sits inside the checkout', () => {
    expect(statusArgsExcludingOut(join('a', 'b'), join('a', 'b', '.test-cost'), 2)).toEqual([
      'status',
      '--porcelain',
      '--',
      '.',
      ':(exclude,literal).test-cost/baseline.json',
      ':(exclude,literal).test-cost/report.md',
      ':(exclude,literal).test-cost/jest-run-1.json',
      ':(exclude,literal).test-cost/jest-run-2.json',
    ]);
    expect(statusArgsExcludingOut(join('a', 'b'), join('a', 'b', 'tmp', 'cost'), 1)).toEqual([
      'status',
      '--porcelain',
      '--',
      '.',
      ':(exclude,literal)tmp/cost/baseline.json',
      ':(exclude,literal)tmp/cost/report.md',
      ':(exclude,literal)tmp/cost/jest-run-1.json',
    ]);
  });

  test('a tracked --out directory keeps its other files visible', () => {
    const args = statusArgsExcludingOut(join('a', 'b'), join('a', 'b', 'docs'), 1);
    expect(args).toEqual([
      'status',
      '--porcelain',
      '--',
      '.',
      ':(exclude,literal)docs/baseline.json',
      ':(exclude,literal)docs/report.md',
      ':(exclude,literal)docs/jest-run-1.json',
    ]);
    expect(args).not.toContain(':(exclude,literal)docs');
  });

  test('keeps pathspec metacharacters in --out literal so unrelated paths stay visible', () => {
    expect(statusArgsExcludingOut(join('a', 'b'), join('a', 'b', 'cost*'), 1)).toEqual([
      'status',
      '--porcelain',
      '--',
      '.',
      ':(exclude,literal)cost*/baseline.json',
      ':(exclude,literal)cost*/report.md',
      ':(exclude,literal)cost*/jest-run-1.json',
    ]);
  });

  test('excludes bare artifact names when --out is the checkout itself', () => {
    expect(statusArgsExcludingOut(join('a', 'b'), join('a', 'b'), 1)).toEqual([
      'status',
      '--porcelain',
      '--',
      '.',
      ':(exclude,literal)baseline.json',
      ':(exclude,literal)report.md',
      ':(exclude,literal)jest-run-1.json',
    ]);
  });

  test('checks the whole worktree when --out is outside it', () => {
    expect(statusArgsExcludingOut(join('a', 'b'), join('a', 'c'), 1)).toEqual(['status', '--porcelain']);
    expect(statusArgsExcludingOut(join('a', 'b'), join('a', 'b', '..', '..', 'x'), 1)).toEqual([
      'status',
      '--porcelain',
    ]);
  });

  test('treats an in-tree name beginning with two dots as inside the checkout', () => {
    expect(statusArgsExcludingOut(join('a', 'b'), join('a', 'b', '..cache'), 1)).toEqual([
      'status',
      '--porcelain',
      '--',
      '.',
      ':(exclude,literal)..cache/baseline.json',
      ':(exclude,literal)..cache/report.md',
      ':(exclude,literal)..cache/jest-run-1.json',
    ]);
  });

  test('dirtyFlag reports a build that modified tracked files, and keeps unknown unknown', () => {
    expect(dirtyFlag('unknown')).toBe('unknown');
    expect(dirtyFlag('')).toBe('false');
    expect(dirtyFlag('\n')).toBe('false');
    expect(dirtyFlag(' M workflows/main.json')).toBe('true');
  });

  test('dirtyPathList names the changed files without their status columns', () => {
    expect(dirtyPathList('unknown')).toBe('unknown');
    expect(dirtyPathList('')).toBe('none observed');
    expect(dirtyPathList(' M workflows/main.json\n?? extra.txt')).toBe('workflows/main.json; extra.txt');
    const many = Array.from({ length: MAX_LISTED_FAILURES + 2 }, (_, i) => ` M f${i}.json`).join('\n');
    expect(dirtyPathList(many)).toContain('… (2 more omitted; see baseline.json)');
  });

  test('the environment placeholder states that no build ran', () => {
    expect(DIRTY_NOT_MEASURED).toBe('not measured (build skipped)');
    expect(renderReport({
      environment: { worktreeDirty: 'false', worktreeDirtyAfterBuild: DIRTY_NOT_MEASURED },
      commands: [],
      runs: [],
      top: [],
      comparison: { completeRuns: 0, interruptedRuns: 0, consistentFailures: [], flakeCandidates: [] },
    })).toContain(`| worktreeDirtyAfterBuild | ${DIRTY_NOT_MEASURED} |`);
  });
});

describe('windowsTreeKillArgs', () => {
  test('terminates the whole process tree, not only the leader', () => {
    expect(windowsTreeKillArgs(4321)).toEqual(['/pid', '4321', '/T', '/F']);
  });
});

describe('Windows orphaned-descendant tracking', () => {
  const started = Date.parse('2026-09-14T10:00:00.000Z');

  test('parseWindowsProcessTable reads pid, parent pid and creation time, skipping malformed lines', () => {
    const text = [
      '100 4 2026-09-14T10:00:00.5000000Z',
      '',
      'garbage line',
      '101 100 not-a-date',
      '102 100 2026-09-14T10:00:01.0000000Z\r',
    ].join('\n');
    expect(parseWindowsProcessTable(text)).toEqual([
      { pid: 100, ppid: 4, createdMs: Date.parse('2026-09-14T10:00:00.500Z') },
      { pid: 102, ppid: 100, createdMs: Date.parse('2026-09-14T10:00:01.000Z') },
    ]);
  });

  test('windowsDescendantPids follows orphans of an exited leader through every generation', () => {
    // Leader 100 is gone from the table; its children still name it as parent.
    const table = [
      { pid: 200, ppid: 100, createdMs: started + 1_000 },
      { pid: 300, ppid: 200, createdMs: started + 2_000 },
      { pid: 301, ppid: 200, createdMs: started + 2_000 },
      { pid: 400, ppid: 300, createdMs: started + 3_000 },
      { pid: 999, ppid: 1, createdMs: started + 1_000 },
    ];
    expect(windowsDescendantPids(table, 100, started).sort()).toEqual([200, 300, 301, 400]);
  });

  test('windowsDescendantPids ignores processes older than the leader, so a recycled pid is not followed', () => {
    const table = [
      { pid: 200, ppid: 100, createdMs: started - 60_000 },
      { pid: 300, ppid: 200, createdMs: started + 1_000 },
    ];
    expect(windowsDescendantPids(table, 100, started)).toEqual([]);
  });
});

describe('runTimed', () => {
  test('a command past its deadline is reported as timed out', async () => {
    const result = await runTimed(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
      cwd: process.cwd(),
      timeoutMs: 500,
      graceMs: 2_000,
      stdio: 'ignore',
    });
    expect(result.timedOut).toBe(true);
    expect(classifyRun(result).state).toBe('interrupted');
  }, 30_000);

  test('the group is reported to the caller before the run can be awaited', async () => {
    // `scripts/mutation-pilot.mjs` writes this pid into its ownership lock: the
    // group outlives a driver killed outright, so the id has to be recorded
    // before anything awaits the run, not once it resolves.
    const seen = [];
    const run = runTimed(process.execPath, ['-e', ''], {
      cwd: process.cwd(),
      timeoutMs: 10_000,
      stdio: 'ignore',
      onGroup: (pid, meta) => seen.push([pid, meta]),
    });
    // Checked before the first await: this is the contract under test, and it
    // cannot depend on how quickly the host gets round to running the child.
    expect(seen).toHaveLength(1);
    expect(seen[0][0]).toBeGreaterThan(0);
    // The pid is a process-group id only where the child was detached.
    expect(seen[0][1]).toEqual({ group: process.platform !== 'win32' });
    const result = await run;
    // The reported group is reaped however the run ended.
    expect(result.groupSurvived).toBe(false);
    if (result.timedOut) {
      // A starved host (full `npm test` beside other runs) can fail to schedule
      // even an empty `node -e ''` inside the deadline. That ending says nothing
      // about the callback's timing, which was asserted above.
      console.warn('runTimed onGroup case: the empty child timed out on a starved host; exit code not asserted');
      return;
    }
    expect(result.exitCode).toBe(0);
  }, 30_000);

  test('a caller that cannot record the group does not leave it running', async () => {
    if (process.platform === 'win32') return;
    // `scripts/mutation-pilot.mjs` writes the group into its ownership lock here,
    // and that write can fail. Rejecting while the group runs on would leave a
    // Stryker nobody recorded: once the driver is gone, the next invocation's
    // stale-lock recovery sees an abandoned lock and admits a second run beside
    // it. So the group is stopped and reaped before the error surfaces.
    const failure = new Error('lock write failed');
    let group;
    await expect(
      runTimed(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
        cwd: process.cwd(),
        timeoutMs: 60_000,
        graceMs: 1_000,
        stdio: 'ignore',
        onGroup: (pid) => {
          group = pid;
          throw failure;
        },
      }),
    ).rejects.toBe(failure);
    expect(group).toBeGreaterThan(0);
    // No polling: the group must already be gone when the rejection arrives.
    const alive = () => {
      try {
        process.kill(-group, 0);
        return true;
      } catch (error) {
        return error.code === 'EPERM';
      }
    };
    expect(alive()).toBe(false);
  }, 30_000);

  test('a descendant that ignores SIGTERM is killed before the result resolves', async () => {
    if (process.platform === 'win32') return;
    const dir = mkdtempSync(join(tmpdir(), 'test-cost-grace-'));
    const pidFile = join(dir, 'pid');
    let pid;
    try {
      // The leader exits on SIGTERM; its background child ignores SIGTERM.
      const script = `(trap '' TERM; while :; do sleep 1; done) & echo $! > '${pidFile}'; wait`;
      const result = await runTimed('/bin/sh', ['-c', script], {
        cwd: process.cwd(),
        timeoutMs: 1_500,
        graceMs: 1_000,
        stdio: 'ignore',
      });
      expect(result.timedOut).toBe(true);
      expect(result.groupSurvived).toBe(false);
      pid = Number(readFileSync(pidFile, 'utf8').trim());
      const alive = () => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      // No polling here: the next repetition starts as soon as runTimed resolves,
      // so the SIGTERM-ignoring descendant must already be gone.
      expect(alive()).toBe(false);
    } finally {
      try {
        if (pid) process.kill(pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test('a leader that exits with an ordinary code still has its detached group stopped before the result resolves', async () => {
    if (process.platform === 'win32') return;
    const dir = mkdtempSync(join(tmpdir(), 'test-cost-exit-'));
    const pidFile = join(dir, 'pid');
    let pid;
    try {
      // The leader exits 3 — no signal — once its SIGTERM-ignoring child is recorded.
      const script = `(trap '' TERM; while :; do sleep 1; done) & echo $! > '${pidFile}'; exit 3`;
      const result = await runTimed('/bin/sh', ['-c', script], {
        cwd: process.cwd(),
        timeoutMs: 25_000,
        graceMs: 1_000,
        stdio: 'ignore',
      });
      expect(result).toMatchObject({ exitCode: 3, signal: null, timedOut: false, groupSurvived: false });
      pid = Number(readFileSync(pidFile, 'utf8').trim());
      let alive = true;
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
      }
      expect(alive).toBe(false);
    } finally {
      try {
        if (pid) process.kill(pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test('a leader killed directly still has its detached group stopped before the result resolves', async () => {
    if (process.platform === 'win32') return;
    const dir = mkdtempSync(join(tmpdir(), 'test-cost-leader-'));
    const pidFile = join(dir, 'pid');
    let pid;
    try {
      // The leader SIGKILLs itself once its SIGTERM-ignoring child is recorded.
      const script = `(trap '' TERM; while :; do sleep 1; done) & echo $! > '${pidFile}'; kill -KILL $$`;
      const result = await runTimed('/bin/sh', ['-c', script], {
        cwd: process.cwd(),
        timeoutMs: 25_000,
        graceMs: 1_000,
        stdio: 'ignore',
      });
      expect(result).toMatchObject({ signal: 'SIGKILL', timedOut: false, groupSurvived: false });
      expect(classifyRun(result).state).toBe('interrupted');
      pid = Number(readFileSync(pidFile, 'utf8').trim());
      let alive = true;
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
      }
      expect(alive).toBe(false);
    } finally {
      try {
        if (pid) process.kill(pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test('a command that exits on its own reports its exit code', async () => {
    // A shell rather than a Node child: under full-suite host load a cold Node
    // start can exceed the deadline, turning an exit-code check into a timeout.
    // This case is not POSIX-specific, so Windows uses its own shell instead of
    // spawning an absent /bin/sh.
    const [shell, shellArgs] =
      process.platform === 'win32' ? [process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'exit 3']] : ['/bin/sh', ['-c', 'exit 3']];
    const result = await runTimed(shell, shellArgs, {
      cwd: process.cwd(),
      timeoutMs: 25_000,
      stdio: 'ignore',
    });
    expect(result).toMatchObject({ exitCode: 3, timedOut: false });
    expect(classifyRun(result)).toEqual({ state: 'complete', reason: 'exit:3' });
  }, 30_000);

  test('a signal to the script stops the child group and is recorded as interrupted', async () => {
    const signalSource = new EventEmitter();
    // The child handles the forwarded SIGTERM and exits 0, so only the recorded
    // parent signal keeps the run from being classified as complete.
    const pending = runTimed(
      process.execPath,
      ['-e', "process.on('SIGTERM', () => process.exit(0)); setTimeout(() => {}, 60000)"],
      {
        cwd: process.cwd(),
        timeoutMs: 20_000,
        graceMs: 2_000,
        stdio: 'ignore',
        signalSource,
      },
    );
    for (const name of PARENT_SIGNALS) expect(signalSource.listenerCount(name)).toBe(1);
    // Real `process` signal events carry no arguments; emit the same way.
    setTimeout(() => signalSource.emit('SIGTERM'), 1_000);
    const result = await pending;
    expect(result).toMatchObject({ timedOut: false, interruptedBy: 'SIGTERM' });
    expect(classifyRun(result)).toEqual({ state: 'interrupted', reason: 'parent-signal:SIGTERM' });
    for (const name of PARENT_SIGNALS) expect(signalSource.listenerCount(name)).toBe(0);
  }, 30_000);
});
