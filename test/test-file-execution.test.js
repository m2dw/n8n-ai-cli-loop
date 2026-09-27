// Issue #1152 — the language-neutral test-file execution boundary and the Jest
// adapter, driven through a scripted CommandRunner
// (docs/changed-file-verification-contract.md §2 and §6).
//
// These pin the facts a stage run records: an empty selection never becomes a
// full run, per-file outcomes are credited only when trusted, and a timeout, an
// interruption, a missing or malformed machine result, or a partial full run can
// never read as an all-pass. The real-Jest fixture lives in
// test/jest-test-file-adapter-fixture.test.js.
import { mkdtempSync, realpathSync, rmSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  TestExecutionRequestError,
  validateTestExecutionRequest,
  isTestFileId,
  toTestFileId,
  assembleTestFileRun,
  jestTestFileAdapter,
  readJestDiscovery,
  readJestRunResult,
  runTestFiles,
  discoverTestFiles,
  runTestSuiteSetup,
  testFileAdapterFor,
} from '../dist/index.js';

let cwd;
let real;
let artifactDir;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'test-file-execution-'));
  real = realpathSync(cwd);
  artifactDir = mkdtempSync(join(cwd, 'artifacts-'));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

const root = () => ({ directories: [real, cwd] });
const abs = (file) => join(real, file);

/** Jest's formatted result, reduced to what the adapter reads. */
function jestResult(files, { total = files.length, wasInterrupted = false } = {}) {
  return JSON.stringify({
    numTotalTestSuites: total,
    wasInterrupted,
    testResults: files.map(([file, status, assertions = ['passed']]) => ({
      name: abs(file),
      status,
      assertionResults: assertions.map((s) => ({ status: s })),
    })),
  });
}

/**
 * A CommandRunner whose steps are scripted in order. A step is a function of
 * `{ cmd, args, resultPath }` returning a partial CommandRunResult; it may write
 * the machine result itself.
 */
function scriptedRunner(...steps) {
  const calls = [];
  return {
    calls,
    run(cmd, args, opts) {
      const outputFlag = args.find((a) => a.startsWith('--outputFile='));
      const resultPath = outputFlag?.slice('--outputFile='.length);
      calls.push({ cmd, args, opts });
      const step = steps[calls.length - 1];
      if (step === undefined) throw new Error(`unexpected command ${cmd} ${args.join(' ')}`);
      return { stdout: '', stderr: '', exitCode: 0, ...step({ cmd, args, resultPath }) };
    },
  };
}

const writes = (text, extra = {}) => ({ resultPath }) => {
  writeFileSync(resultPath, text, 'utf8');
  return extra;
};

const JEST = { adapter: 'jest' };
const options = (overrides = {}) => ({ cwd, suiteCommand: 'npx jest', binding: JEST, artifactDir, ...overrides });

describe('the request guard (§6 rule 1)', () => {
  test('an empty selection is refused, never read as the full suite', () => {
    for (const request of [{ mode: 'files', files: [] }, { mode: 'files' }, { mode: 'files', files: 'a' }]) {
      let thrown;
      try {
        validateTestExecutionRequest(request);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(TestExecutionRequestError);
      expect(thrown.refusal).toBe('empty_selection');
    }
  });

  test('full mode carries no list, and an unknown mode refuses', () => {
    expect(validateTestExecutionRequest({ mode: 'full' })).toEqual({ mode: 'full' });
    expect(() => validateTestExecutionRequest({ mode: 'full', files: [] })).toThrow(/carries no file list/);
    expect(() => validateTestExecutionRequest({ mode: 'all' })).toThrow(TestExecutionRequestError);
    expect(() => validateTestExecutionRequest(undefined)).toThrow(TestExecutionRequestError);
  });

  test('files must be distinct repository-relative ids', () => {
    expect(validateTestExecutionRequest({ mode: 'files', files: ['test/a.test.js'] }))
      .toEqual({ mode: 'files', files: ['test/a.test.js'] });
    for (const bad of ['/abs/a.test.js', '../a.test.js', 'test/./a.test.js', 'test//a.test.js', 'test\\a.test.js', '']) {
      expect(isTestFileId(bad)).toBe(false);
      expect(() => validateTestExecutionRequest({ mode: 'files', files: [bad] })).toThrow(TestExecutionRequestError);
    }
    expect(() => validateTestExecutionRequest({ mode: 'files', files: ['a.test.js', 'a.test.js'] }))
      .toThrow(/selected twice/);
  });

  test('runTestFiles refuses an empty selection before launching anything', () => {
    const runner = scriptedRunner();
    expect(() => runTestFiles(runner, { mode: 'files', files: [] }, options())).toThrow(TestExecutionRequestError);
    expect(runner.calls).toEqual([]);
  });

  test('the Jest adapter refuses an empty list on its own too', () => {
    expect(() => jestTestFileAdapter.runArguments({ mode: 'files', files: [] }, '/tmp/r.json', root()))
      .toThrow(/refuses an empty file list/);
  });

  test('an unimplemented adapter is not guessed', () => {
    expect(testFileAdapterFor('jest')).toBe(jestTestFileAdapter);
    expect(testFileAdapterFor('mocha')).toBeUndefined();
    expect(testFileAdapterFor('toString')).toBeUndefined();
  });
});

describe('Jest adapter arguments and machine results', () => {
  test('explicit files use the exact-path facility with absolute paths; full mode passes none', () => {
    const files = jestTestFileAdapter.runArguments(
      { mode: 'files', files: ['test/a.test.js', 'test/[b].test.js'] },
      '/out/r.json',
      root(),
    );
    // No `--reporters`: that flag replaces the project's configured reporters.
    // No `--no-bail`: a configured bail is kept.
    const output = ['--json', '--outputFile=/out/r.json'];
    expect(files).toEqual([...output, '--runTestsByPath', abs('test/a.test.js'), abs('test/[b].test.js')]);
    expect(jestTestFileAdapter.runArguments({ mode: 'full' }, '/out/r.json', root())).toEqual(output);
    expect(jestTestFileAdapter.discoveryArguments()).toEqual(['--listTests', '--json']);
  });

  test('discovery reads the JSON array line wherever lifecycle output surrounds it', () => {
    const report = JSON.stringify([abs('test/b.test.js'), abs('test/a.test.js')]);
    const expected = { kind: 'readable', files: ['test/a.test.js', 'test/b.test.js'] };
    const pretest = `> pkg@1.0.0 pretest\n> tsc\n\n${report}\n`;
    expect(readJestDiscovery(pretest, root())).toEqual(expected);
    // A successful npm `posttest` prints its banner and output after Jest's report.
    const posttest = `> pkg@1.0.0 test\n> jest --listTests --json\n\n${report}\n\n> pkg@1.0.0 posttest\n> echo done\n\n[done] cleanup {ok}\n`;
    expect(readJestDiscovery(posttest, root())).toEqual(expected);

    expect(readJestDiscovery('', root()).kind).toBe('unreadable');
    expect(readJestDiscovery('not json', root()).kind).toBe('unreadable');
    expect(readJestDiscovery('{"a": 1}', root()).kind).toBe('unreadable');
    expect(readJestDiscovery(`${report}\n[]\n`, root()).kind).toBe('unreadable');
    expect(readJestDiscovery(JSON.stringify(['/elsewhere/a.test.js']), root()).kind).toBe('unreadable');
  });

  test('per-file statuses map to passed, failed and skipped; skipped is never passed', () => {
    const report = readJestRunResult(
      jestResult([
        ['a.test.js', 'passed'],
        ['b.test.js', 'failed', ['passed', 'failed']],
        ['c.test.js', 'skipped', ['pending']],
        ['d.test.js', 'focused', ['passed', 'pending']],
        ['e.test.js', 'focused', ['pending', 'todo']],
        ['f.test.js', 'failed', []],
      ]),
      root(),
    );
    expect(report).toEqual({
      kind: 'readable',
      totalFiles: 6,
      interrupted: false,
      files: [
        { file: 'a.test.js', outcome: 'passed' },
        { file: 'b.test.js', outcome: 'failed' },
        { file: 'c.test.js', outcome: 'skipped' },
        { file: 'd.test.js', outcome: 'passed' },
        { file: 'e.test.js', outcome: 'skipped' },
        { file: 'f.test.js', outcome: 'failed' },
      ],
    });
    expect(toTestFileId(abs('x/y.test.js'), root())).toBe('x/y.test.js');
  });

  test('a path several Jest projects ran is one file, failed if any instance failed', () => {
    const report = readJestRunResult(
      jestResult([
        ['a.test.js', 'passed'],
        ['b.test.js', 'passed'],
        ['a.test.js', 'failed', ['failed']],
        ['b.test.js', 'skipped', ['pending']],
        ['c.test.js', 'skipped', ['pending']],
        ['c.test.js', 'skipped', ['pending']],
      ]),
      root(),
    );
    expect(report).toEqual({
      kind: 'readable',
      totalFiles: 3,
      interrupted: false,
      files: [
        { file: 'a.test.js', outcome: 'failed' },
        { file: 'b.test.js', outcome: 'passed' },
        { file: 'c.test.js', outcome: 'skipped' },
      ],
    });
  });

  test('a malformed machine result is unreadable, never partially read', () => {
    for (const text of [
      '{not json',
      '[]',
      JSON.stringify({ testResults: [], wasInterrupted: false }),
      JSON.stringify({ numTotalTestSuites: 1, wasInterrupted: false }),
      JSON.stringify({ numTotalTestSuites: 1, testResults: [] }),
      jestResult([['a.test.js', 'mystery']]),
      jestResult([['a.test.js', 'passed'], ['a.test.js', 'passed']], { total: 1 }),
      JSON.stringify({ numTotalTestSuites: 1, wasInterrupted: false, testResults: [{ name: '/elsewhere/a.test.js', status: 'passed' }] }),
    ]) {
      expect(readJestRunResult(text, root()).kind).toBe('unreadable');
    }
  });
});

describe('runTestFiles — outcomes that can and cannot pass', () => {
  test('a complete trusted run passes and names every requested file', () => {
    const runner = scriptedRunner(writes(jestResult([['test/a.test.js', 'passed']])));
    const result = runTestFiles(runner, { mode: 'files', files: ['test/a.test.js'] }, options());
    expect(result).toMatchObject({
      mode: 'files',
      expectedFiles: ['test/a.test.js'],
      files: [{ file: 'test/a.test.js', outcome: 'passed' }],
      failedFiles: [],
      trust: { status: 'trusted' },
      processResult: 'succeeded',
      completeness: { status: 'complete' },
      termination: 'confirmed',
      resultArtifact: 'test-files-result.json',
    });
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0].cmd).toBe('npx');
    expect(runner.calls[0].args.slice(0, 1)).toEqual(['jest']);
    expect(runner.calls[0].opts).toMatchObject({ cwd, isolateProcessGroup: true });
    expect(existsSync(join(artifactDir, 'test-files-tests.log'))).toBe(true);
  });

  test('genuine failing files are the trusted failed outcomes only', () => {
    const runner = scriptedRunner(writes(
      jestResult([['test/a.test.js', 'failed', ['failed']], ['test/b.test.js', 'passed']]),
      { exitCode: 1 },
    ));
    const result = runTestFiles(runner, { mode: 'files', files: ['test/a.test.js', 'test/b.test.js'] }, options());
    expect(result.failedFiles).toEqual(['test/a.test.js']);
    expect(result.processResult).toBe('failed');
    expect(result.trust).toEqual({ status: 'trusted' });
    expect(result.completeness).toEqual({ status: 'incomplete', reason: 'process-failed' });
  });

  test('a deadline overrun is never read, even when a passing result exists', () => {
    const runner = scriptedRunner(writes(jestResult([['test/a.test.js', 'passed']]), {
      exitCode: 1,
      timedOut: true,
      signal: 'SIGTERM',
      spawnErrorCode: 'ETIMEDOUT',
    }));
    const result = runTestFiles(runner, { mode: 'files', files: ['test/a.test.js'] }, options({ timeoutMs: 50 }));
    expect(runner.calls[0].opts.timeout).toBe(50);
    expect(result.trust).toMatchObject({ status: 'untrusted', reason: 'deadline' });
    expect(result.processResult).toBeUndefined();
    expect(result.files).toEqual([]);
    expect(result.failedFiles).toEqual([]);
    expect(result.completeness).toEqual({ status: 'incomplete', reason: 'untrusted' });
  });

  test('an interrupted process is untrusted, and unconfirmed cleanup is reported', () => {
    const runner = scriptedRunner(writes(jestResult([['test/a.test.js', 'passed']]), {
      exitCode: 1,
      signal: 'SIGINT',
      processTreeCleanup: { pid: 1, processGroupTerminated: false, terminationUnconfirmed: true, terminatedDescendants: [], forceKilled: [] },
    }));
    const result = runTestFiles(runner, { mode: 'files', files: ['test/a.test.js'] }, options());
    expect(result.trust).toMatchObject({ status: 'untrusted', reason: 'interrupted' });
    expect(result.termination).toBe('unconfirmed');
    expect(result.completeness.status).toBe('incomplete');
  });

  test('a spawn failure is untrusted with no process result', () => {
    const runner = scriptedRunner(() => ({ exitCode: 1, spawnErrorCode: 'ENOENT', spawnError: 'Error: spawn npx ENOENT' }));
    const result = runTestFiles(runner, { mode: 'files', files: ['test/a.test.js'] }, options());
    expect(result.trust).toMatchObject({ status: 'untrusted', reason: 'spawn-failure' });
    expect(result.processResult).toBeUndefined();
  });

  test('the tooling reporting its own interruption is untrusted even at exit 0', () => {
    const runner = scriptedRunner(writes(jestResult([['test/a.test.js', 'passed']], { wasInterrupted: true })));
    const result = runTestFiles(runner, { mode: 'files', files: ['test/a.test.js'] }, options());
    expect(result.trust).toMatchObject({ status: 'untrusted', reason: 'interrupted' });
    expect(result.completeness.status).toBe('incomplete');
  });

  test('a missing or malformed machine result cannot pass', () => {
    for (const step of [() => ({}), writes('{"numTotalTestSuites": 1, "testResults": [')]) {
      const result = runTestFiles(scriptedRunner(step), { mode: 'files', files: ['test/a.test.js'] }, options());
      expect(result.trust).toMatchObject({ status: 'untrusted', reason: 'unreadable-result' });
      expect(result.processResult).toBe('succeeded');
      expect(result.completeness).toEqual({ status: 'incomplete', reason: 'untrusted' });
    }
  });

  test('a stale result left by an earlier run is removed before launch, never read', () => {
    writeFileSync(join(artifactDir, 'test-files-result.json'), jestResult([['test/a.test.js', 'passed']]));
    const result = runTestFiles(scriptedRunner(() => ({})), { mode: 'files', files: ['test/a.test.js'] }, options());
    expect(result.trust).toMatchObject({ status: 'untrusted', reason: 'unreadable-result' });
    expect(result.resultArtifact).toBeUndefined();
  });

  test('a result naming another file, or a dropped literal path, is mismatched', () => {
    const extra = runTestFiles(
      scriptedRunner(writes(jestResult([['test/a.test.js', 'passed'], ['test/b.test.js', 'failed']]))),
      { mode: 'files', files: ['test/a.test.js'] },
      options(),
    );
    expect(extra.trust).toMatchObject({ status: 'untrusted', reason: 'mismatched-files' });
    expect(extra.failedFiles).toEqual([]);

    // Jest drops a requested path it does not treat as a test file: its total
    // then disagrees with the request.
    const dropped = runTestFiles(
      scriptedRunner(writes(jestResult([['test/a.test.js', 'passed']]))),
      { mode: 'files', files: ['test/a.test.js', 'src/helper.js'] },
      options(),
    );
    expect(dropped.trust).toMatchObject({ status: 'untrusted', reason: 'mismatched-files' });
    expect(dropped.completeness.status).toBe('incomplete');
  });

  test('an incomplete full run leaves the unreached files not-run and never complete', () => {
    const inventory = JSON.stringify([abs('test/a.test.js'), abs('test/b.test.js'), abs('test/c.test.js')]);
    const runner = scriptedRunner(
      () => ({ stdout: inventory }),
      writes(jestResult([['test/a.test.js', 'failed', ['failed']]], { total: 3 }), { exitCode: 1 }),
    );
    const result = runTestFiles(runner, { mode: 'full' }, options());
    expect(runner.calls.map((c) => c.args)).toEqual([
      ['jest', '--listTests', '--json'],
      ['jest', '--json', expect.stringMatching(/^--outputFile=/)],
    ]);
    expect(result.expectedFiles).toEqual(['test/a.test.js', 'test/b.test.js', 'test/c.test.js']);
    expect(result.files).toEqual([
      { file: 'test/a.test.js', outcome: 'failed' },
      { file: 'test/b.test.js', outcome: 'not-run' },
      { file: 'test/c.test.js', outcome: 'not-run' },
    ]);
    expect(result.failedFiles).toEqual(['test/a.test.js']);

    const zeroExit = runTestFiles(
      scriptedRunner(() => ({ stdout: inventory }), writes(jestResult([['test/a.test.js', 'passed']], { total: 3 }))),
      { mode: 'full' },
      options(),
    );
    expect(zeroExit.completeness).toEqual({ status: 'incomplete', reason: 'not-run' });
  });

  test('a full run whose tooling total disagrees with the runnable-file report is mismatched', () => {
    const inventory = JSON.stringify([abs('test/a.test.js'), abs('test/b.test.js')]);
    const result = runTestFiles(
      scriptedRunner(() => ({ stdout: inventory }), writes(jestResult([['test/a.test.js', 'passed']]))),
      { mode: 'full' },
      options(),
    );
    expect(result.trust).toMatchObject({ status: 'untrusted', reason: 'mismatched-files' });
  });

  test('overlapping Jest projects complete a full run, and an unreached project instance cannot', () => {
    // --listTests names a path once; the machine result has one entry per project.
    const inventory = JSON.stringify([abs('test/a.test.js'), abs('test/b.test.js')]);
    const complete = runTestFiles(
      scriptedRunner(
        () => ({ stdout: inventory }),
        writes(jestResult([['test/a.test.js', 'passed'], ['test/b.test.js', 'passed'], ['test/a.test.js', 'passed']])),
      ),
      { mode: 'full' },
      options(),
    );
    expect(complete).toMatchObject({
      trust: { status: 'trusted' },
      completeness: { status: 'complete' },
      files: [
        { file: 'test/a.test.js', outcome: 'passed' },
        { file: 'test/b.test.js', outcome: 'passed' },
      ],
    });

    // The second project's instance of a.test.js never ran: Jest's total still
    // counts it, so the run cannot read as complete.
    const partial = runTestFiles(
      scriptedRunner(
        () => ({ stdout: inventory }),
        writes(jestResult([['test/a.test.js', 'passed'], ['test/b.test.js', 'passed']], { total: 3 })),
      ),
      { mode: 'full' },
      options(),
    );
    expect(partial.trust).toMatchObject({ status: 'untrusted', reason: 'mismatched-files' });
    expect(partial.completeness.status).toBe('incomplete');
  });

  test('an empty runnable-file report launches no tests and is complete with no files', () => {
    const runner = scriptedRunner(() => ({ stdout: '[]' }));
    const result = runTestFiles(runner, { mode: 'full' }, options());
    expect(runner.calls).toHaveLength(1);
    expect(result).toMatchObject({ files: [], expectedFiles: [], completeness: { status: 'complete' } });
  });

  test('an unreadable runnable-file report launches no tests and cannot pass', () => {
    const runner = scriptedRunner(() => ({ stdout: 'garbage' }));
    const result = runTestFiles(runner, { mode: 'full' }, options());
    expect(runner.calls).toHaveLength(1);
    expect(result.trust).toMatchObject({ status: 'untrusted', reason: 'unreadable-result' });
    expect(result.completeness.status).toBe('incomplete');
  });

  test('setup is its own step before the tests, and a failed setup launches nothing else', () => {
    const ok = scriptedRunner(() => ({}), writes(jestResult([['test/a.test.js', 'passed']])));
    const passed = runTestFiles(
      ok,
      { mode: 'files', files: ['test/a.test.js'] },
      options({ binding: { adapter: 'jest', setupCommand: 'npm run build' } }),
    );
    expect(ok.calls.map((c) => [c.cmd, ...c.args].slice(0, 3))).toEqual([
      ['npm', 'run', 'build'],
      ['npx', 'jest', '--json'],
    ]);
    // The build never receives the selection.
    expect(ok.calls[0].args).toEqual(['run', 'build']);
    expect(passed.steps.map((s) => s.step)).toEqual(['setup', 'tests']);
    expect(passed.completeness.status).toBe('complete');

    const broken = scriptedRunner(() => ({ exitCode: 2, stderr: 'tsc: error' }));
    const failed = runTestFiles(
      broken,
      { mode: 'files', files: ['test/a.test.js'] },
      options({ binding: { adapter: 'jest', setupCommand: 'npm run build' } }),
    );
    expect(broken.calls).toHaveLength(1);
    expect(failed.processResult).toBe('failed');
    expect(failed.trust).toMatchObject({ status: 'untrusted', reason: 'unreadable-result' });
    expect(failed.failedFiles).toEqual([]);
    expect(failed.outputTail).toContain('tsc: error');
  });

  test('the argument separator sits between the suite command and the adapter arguments', () => {
    const runner = scriptedRunner(writes(jestResult([['test/a.test.js', 'passed']])));
    runTestFiles(
      runner,
      { mode: 'files', files: ['test/a.test.js'] },
      options({ suiteCommand: 'npm test', binding: { adapter: 'jest', argumentSeparator: '--' } }),
    );
    expect(runner.calls[0].cmd).toBe('npm');
    expect(runner.calls[0].args.slice(0, 3)).toEqual(['test', '--', '--json']);
  });

  test('an npm command that would consume the adapter arguments is refused before anything launches', () => {
    // npm takes `--listTests --json` as its own options and runs the whole suite.
    for (const suiteCommand of [
      'npm test',
      'npm run test:unit',
      'npm exec jest',
      '/usr/local/bin/npm test',
      'env CI=1 npm test',
      "bash -lc 'npm test'",
      "bash -lc 'cd app && npm run test:unit'",
    ]) {
      const runner = scriptedRunner();
      const binding = { adapter: 'jest', setupCommand: 'npm run build' };
      expect(() => runTestFiles(runner, { mode: 'full' }, options({ suiteCommand, binding })))
        .toThrow(/cannot forward/);
      expect(() => runTestFiles(runner, { mode: 'files', files: ['test/a.test.js'] }, options({ suiteCommand, binding })))
        .toThrow(/cannot forward/);
      expect(() => discoverTestFiles(runner, options({ suiteCommand }))).toThrow(/cannot forward/);
      expect(runner.calls).toEqual([]);
    }

    // A `--` in the command itself, or as the separator, forwards them.
    const inventory = JSON.stringify([abs('test/a.test.js')]);
    for (const [suiteCommand, binding, argv] of [
      ['npm test --', JEST, ['npm', 'test', '--', '--listTests', '--json']],
      ['npm test -- --ci', JEST, ['npm', 'test', '--', '--ci', '--listTests', '--json']],
      ['env CI=1 npm test', { adapter: 'jest', argumentSeparator: '--' }, ['env', 'CI=1', 'npm', 'test', '--', '--listTests', '--json']],
      ["bash -lc 'npm test'", { adapter: 'jest', argumentSeparator: '--' }, ['bash', '-lc', 'npm test -- --listTests --json']],
    ]) {
      const runner = scriptedRunner(() => ({ stdout: inventory }));
      discoverTestFiles(runner, options({ suiteCommand, binding }));
      expect([runner.calls[0].cmd, ...runner.calls[0].args]).toEqual(argv);
    }
  });

  test('a -c shell wrapper receives the adapter arguments inside its command string', () => {
    const inventory = JSON.stringify([abs('test/a.test.js')]);
    const runner = scriptedRunner(() => ({ stdout: inventory }), ({ args }) => {
      const resultPath = /'?--outputFile=([^' ]+)'?/.exec(args[args.length - 1])[1];
      writeFileSync(resultPath, jestResult([['test/a.test.js', 'passed']]), 'utf8');
      return {};
    });
    const result = runTestFiles(
      runner,
      { mode: 'full' },
      options({ suiteCommand: "bash -lc 'cd app && npm test'", binding: { adapter: 'jest', argumentSeparator: '--' } }),
    );
    expect(runner.calls[0].cmd).toBe('bash');
    // Nothing follows the command string, so no argument becomes a positional parameter.
    expect(runner.calls[0].args).toEqual(['-lc', 'cd app && npm test -- --listTests --json']);
    expect(runner.calls[1].args).toHaveLength(2);
    expect(runner.calls[1].args[1]).toMatch(/^cd app && npm test -- --json --outputFile=\S+$/);
    expect(result.completeness.status).toBe('complete');

    const quoted = scriptedRunner(() => ({}));
    runTestFiles(quoted, { mode: 'files', files: ["test/it's a.test.js"] }, options({ suiteCommand: 'sh -c "npx jest"' }));
    expect(quoted.calls[0].args[1]).toContain(`'${abs("test/it'\\''s a.test.js")}'`);

    const clustered = scriptedRunner(() => ({ stdout: inventory }));
    discoverTestFiles(clustered, options({ suiteCommand: "bash -euo pipefail -c 'npx jest'" }));
    expect(clustered.calls[0].args).toEqual(['-euo', 'pipefail', '-c', 'npx jest --listTests --json']);

    // Options that take an operand are consumed before the command string is located.
    for (const [suiteCommand, head] of [
      ["bash -O extglob -c 'npx jest'", ['-O', 'extglob', '-c']],
      ["bash +O extglob -c 'npx jest'", ['+O', 'extglob', '-c']],
      ["bash --rcfile ci.rc -c 'npx jest'", ['--rcfile', 'ci.rc', '-c']],
      ["bash --init-file ci.rc -c 'npx jest'", ['--init-file', 'ci.rc', '-c']],
    ]) {
      const consumed = scriptedRunner(() => ({ stdout: inventory }));
      discoverTestFiles(consumed, options({ suiteCommand }));
      expect(consumed.calls[0].args).toEqual([...head, 'npx jest --listTests --json']);
    }
  });

  test('a shell wrapper that cannot forward the arguments is refused before anything launches', () => {
    for (const suiteCommand of [
      "bash -c 'npm test \"$@\"' bash",
      "bash -c 'npm test;'",
      "bash -c 'npm test # all'",
      "bash -c ''",
      // A -c shell behind a launcher, or inside the command string, would take
      // the arguments as positional parameters and run the whole suite.
      "env NODE_ENV=test sh -c 'jest'",
      "/usr/bin/env bash -euo pipefail -c 'npx jest'",
      "nice -n 5 /bin/sh -c 'npx jest'",
      "sh -c 'env CI=1 bash -lc \"npx jest\"'",
      // A command after the suite in a list or pipeline would receive the arguments.
      "bash -c 'npm test | tee test.log'",
      "bash -c 'npm test && echo done'",
      "bash -c 'npm test || true'",
      "bash -c 'npm test & wait'",
      "bash -c 'npm test 2>&1'",
      "bash -c 'npm test > test.log'",
      "bash -c '(npm test)'",
      "bash -c 'npm test $(echo --ci)'",
      "bash -c 'npm run build && cd app && npm test'",
      "bash -c 'cd app &&'",
      "bash -c 'npm test \"--ci'",
      // A layout whose options are not recognized is refused, not treated as a plain command.
      "bash --unknown-option value -c 'npx jest'",
    ]) {
      const runner = scriptedRunner();
      const binding = { adapter: 'jest', setupCommand: 'npm run build' };
      expect(() => runTestFiles(runner, { mode: 'full' }, options({ suiteCommand, binding })))
        .toThrow(/cannot forward/);
      expect(() => discoverTestFiles(runner, options({ suiteCommand }))).toThrow(/cannot forward/);
      expect(runner.calls).toEqual([]);
    }
  });

  test('without an artifact directory the machine result is private and removed', () => {
    const runner = scriptedRunner(writes(jestResult([['test/a.test.js', 'passed']])));
    const result = runTestFiles(runner, { mode: 'files', files: ['test/a.test.js'] }, options({ artifactDir: undefined }));
    expect(result.completeness.status).toBe('complete');
    expect(result.resultArtifact).toBeUndefined();
    const resultPath = runner.calls[0].args.find((a) => a.startsWith('--outputFile=')).slice('--outputFile='.length);
    expect(existsSync(resultPath)).toBe(false);
  });
});

describe('discoverTestFiles', () => {
  test('reports the runnable files, or unreadable when discovery did not exit 0', () => {
    const inventory = JSON.stringify([abs('test/a.test.js')]);
    expect(discoverTestFiles(scriptedRunner(() => ({ stdout: inventory })), options()).inventory)
      .toEqual({ kind: 'readable', files: ['test/a.test.js'] });
    const failed = discoverTestFiles(scriptedRunner(() => ({ stdout: inventory, exitCode: 1 })), options());
    expect(failed.inventory.kind).toBe('unreadable');
    const timedOut = discoverTestFiles(scriptedRunner(() => ({ exitCode: 1, timedOut: true })), options());
    expect(timedOut.inventory).toMatchObject({ kind: 'unreadable', reason: expect.stringContaining('deadline') });
  });
});

describe('runTestSuiteSetup (setup ahead of discovery, issue #1154)', () => {
  const withSetup = () => options({ binding: { adapter: 'jest', setupCommand: 'npm run build' } });

  test('setup runs before discovery and the selected run does not launch it again', () => {
    const inventory = JSON.stringify([abs('test/a.test.js')]);
    const runner = scriptedRunner(
      () => ({}),
      () => ({ stdout: inventory }),
      writes(jestResult([['test/a.test.js', 'passed']])),
    );
    const setup = runTestSuiteSetup(runner, withSetup());
    expect(setup).toMatchObject({ succeeded: true, termination: 'confirmed' });
    expect(discoverTestFiles(runner, withSetup()).inventory).toEqual({ kind: 'readable', files: ['test/a.test.js'] });
    const result = runTestFiles(runner, { mode: 'files', files: ['test/a.test.js'] }, withSetup(), setup);
    expect(runner.calls.map((c) => [c.cmd, ...c.args].slice(0, 3))).toEqual([
      ['npm', 'run', 'build'],
      ['npx', 'jest', '--listTests'],
      ['npx', 'jest', '--json'],
    ]);
    expect(result.steps.map((s) => s.step)).toEqual(['setup', 'tests']);
    expect(result.completeness.status).toBe('complete');
  });

  test('a failed setup handed to the run launches nothing and records its nonzero exit', () => {
    const runner = scriptedRunner(() => ({ exitCode: 2, stderr: 'tsc: error' }));
    const setup = runTestSuiteSetup(runner, withSetup());
    expect(setup.succeeded).toBe(false);
    const result = runTestFiles(runner, { mode: 'files', files: ['test/a.test.js'] }, withSetup(), setup);
    expect(runner.calls).toHaveLength(1);
    expect(result.processResult).toBe('failed');
    expect(result.outputTail).toContain('tsc: error');
  });

  test('no declared setup launches nothing and succeeds', () => {
    const runner = scriptedRunner();
    expect(runTestSuiteSetup(runner, options())).toEqual({ steps: [], succeeded: true, termination: 'confirmed' });
    expect(runner.calls).toHaveLength(0);
  });
});

describe('assembleTestFileRun', () => {
  test('no launched command is never a pass', () => {
    const result = assembleTestFileRun({ request: { mode: 'files', files: ['a.test.js'] }, steps: [] });
    expect(result.trust).toMatchObject({ status: 'untrusted', reason: 'unreadable-result' });
    expect(result.completeness.status).toBe('incomplete');
  });
});
