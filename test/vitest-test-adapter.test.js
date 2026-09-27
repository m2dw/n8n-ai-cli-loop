// Issue #1174 — the Vitest test-file adapter's pure surface
// (docs/changed-file-verification-contract.md §6 rule 6).
//
// These pin how the adapter asks and reads Vitest 3.2: the subcommand it
// supplies, the suite commands it refuses before anything launches, the
// runnable-file report (including a file two project instances list), and the
// JSON reporter's per-file outcomes — where a pending test, a file with no test
// result or a count that disagrees credits nothing.
import {
  VITEST_SUPPORTED_RANGE,
  readVitestDiscovery,
  readVitestRunResult,
  testFileAdapterFor,
  vitestSuiteCommandRefusal,
  vitestTestFileAdapter,
} from '../dist/index.js';

const ROOT = { directories: ['/repo'] };

function fileResult(name, status, tests) {
  return {
    assertionResults: tests.map((test, i) => ({ status: test, title: `t${i}` })),
    startTime: 0,
    endTime: 1,
    status,
    message: '',
    name: `/repo/${name}`,
  };
}

function report(files) {
  const numTotalTests = files.reduce((sum, entry) => sum + entry.assertionResults.length, 0);
  return JSON.stringify({ numTotalTestSuites: files.length, numTotalTests, success: true, testResults: files });
}

describe('vitest adapter arguments', () => {
  test('is dispatched for adapter: vitest and names its supported range', () => {
    expect(testFileAdapterFor('vitest')).toBe(vitestTestFileAdapter);
    expect(VITEST_SUPPORTED_RANGE).toBe('>=3.2.0 <4.0.0');
    expect(vitestTestFileAdapter.discoveryReport).toBe('file');
  });

  test('discovery and the selection check list files without running a test', () => {
    expect(vitestTestFileAdapter.discoveryArguments('/out/d.json')).toEqual([
      'list', '--filesOnly', '--json=/out/d.json',
    ]);
    expect(
      vitestTestFileAdapter.selectionCheckArguments(
        { mode: 'files', files: ['test/sub dir/a.test.mjs'] },
        '/out/s.json',
        ROOT,
      ),
    ).toEqual(['list', '--filesOnly', '--json=/out/s.json', '/repo/test/sub dir/a.test.mjs']);
  });

  test('a run is `vitest run` with the JSON reporter, and full mode passes no file', () => {
    const output = ['run', '--reporter=default', '--reporter=json', '--outputFile.json=/out/r.json'];
    expect(vitestTestFileAdapter.runArguments({ mode: 'full' }, '/out/r.json', ROOT)).toEqual(output);
    expect(
      vitestTestFileAdapter.runArguments({ mode: 'files', files: ['test/a.test.mjs'] }, '/out/r.json', ROOT),
    ).toEqual([...output, '/repo/test/a.test.mjs']);
  });

  test('an empty file list is refused, never turned into a full run', () => {
    expect(() => vitestTestFileAdapter.runArguments({ mode: 'files', files: [] }, '/out/r.json', ROOT)).toThrow(
      /empty file list/,
    );
    expect(() =>
      vitestTestFileAdapter.selectionCheckArguments({ mode: 'files', files: [] }, '/out/s.json', ROOT),
    ).toThrow(/empty file list/);
  });
});

describe('vitestSuiteCommandRefusal', () => {
  const words = (command) => command.split(' ');

  test.each([
    'vitest',
    './node_modules/.bin/vitest',
    'npx vitest',
    'pnpm exec vitest',
    'npm exec -- vitest --config=vitest.unit.mjs',
    'node node_modules/vitest/vitest.mjs',
    'node --max-old-space-size=4096 node_modules/vitest/vitest.mjs',
    'npx vitest --config=vitest.unit.mjs --no-color --project=unit',
    'env NODE_ENV=test npx vitest',
  ])('accepts %s', (command) => {
    expect(vitestSuiteCommandRefusal(words(command), undefined, false)).toBeUndefined();
  });

  test.each(['cd pkg && NODE_ENV=test npx vitest', 'NODE_ENV=test npx vitest', 'cd pkg && npx vitest'])(
    'accepts %s in a wrapper command string only, since the runner launches anything else without a shell',
    (command) => {
      expect(vitestSuiteCommandRefusal(words(command), undefined, true)).toBeUndefined();
      expect(vitestSuiteCommandRefusal(words(command), undefined, false)).toMatch(/shell syntax/);
    },
  );

  test('npm exec without its own "--" needs the separator and takes no options', () => {
    expect(vitestSuiteCommandRefusal(words('npm exec vitest'), '--', false)).toBeUndefined();
    expect(vitestSuiteCommandRefusal(words('npm exec vitest'), undefined, false)).toMatch(/argumentSeparator/);
    expect(vitestSuiteCommandRefusal(words('npm exec vitest --config=x.mjs'), '--', false)).toMatch(
      /own configuration/,
    );
  });

  test.each([
    ['npm test', /package script/],
    ['npm run test:unit --', /package script/],
    ['npx vitest run', /not a --name=value/],
    ['npx vitest --silent', /not a --name=value/],
    ['npx vitest --watch=true', /refused/],
    ['npx vitest --changed=HEAD', /refused/],
    ['npx vitest --shard=1/2', /refused/],
    ['npx vitest --reporter=dot', /refused/],
    ['npx vitest --outputFile.json=x.json', /refused/],
    ['npx vitest --testNamePattern=foo', /refused/],
    ['node scripts/test.mjs', /node command must run/],
  ])('refuses %s', (command, reason) => {
    expect(vitestSuiteCommandRefusal(words(command), undefined, false)).toMatch(reason);
  });

  test('a separator outside npm exec would reach Vitest itself', () => {
    expect(vitestSuiteCommandRefusal(words('npx vitest'), '--', false)).toMatch(/reach Vitest itself/);
  });
});

describe('readVitestDiscovery', () => {
  test('reads every listed file, sorted, including paths with spaces', () => {
    const text = JSON.stringify([
      { file: '/repo/test/sub dir/b.test.mjs' },
      { file: '/repo/test/a.test.mjs', projectName: 'unit' },
    ]);
    expect(readVitestDiscovery(text, ROOT)).toEqual({
      kind: 'readable',
      files: ['test/a.test.mjs', 'test/sub dir/b.test.mjs'],
    });
  });

  test('an empty list is a readable, empty inventory', () => {
    expect(readVitestDiscovery('[]', ROOT)).toEqual({ kind: 'readable', files: [] });
  });

  test('a file two project instances list is refused with the file and the projects named', () => {
    const text = JSON.stringify([
      { file: '/repo/test/a.test.mjs', projectName: 'node' },
      { file: '/repo/test/a.test.mjs', projectName: 'browser' },
    ]);
    const read = readVitestDiscovery(text, ROOT);
    expect(read.kind).toBe('unreadable');
    expect(read.reason).toContain('test/a.test.mjs');
    expect(read.reason).toContain('node, browser');
  });

  test.each([
    ['not JSON', 'Found 2 files'],
    ['not an array', '{"file":"/repo/a.test.mjs"}'],
    ['an entry with no file', '[{"projectName":"x"}]'],
    ['a file outside the repository', '[{"file":"/elsewhere/a.test.mjs"}]'],
  ])('%s is unreadable', (_label, text) => {
    expect(readVitestDiscovery(text, ROOT).kind).toBe('unreadable');
  });
});

describe('readVitestRunResult', () => {
  test('reads per-file passed, failed and skipped outcomes', () => {
    const text = report([
      fileResult('test/a.test.mjs', 'passed', ['passed', 'skipped']),
      fileResult('test/b.test.mjs', 'failed', ['passed', 'failed']),
      fileResult('test/c.test.mjs', 'passed', ['skipped', 'todo']),
      fileResult('test/d.test.mjs', 'failed', []),
    ]);
    expect(readVitestRunResult(text, ROOT)).toEqual({
      kind: 'readable',
      files: [
        { file: 'test/a.test.mjs', outcome: 'passed' },
        { file: 'test/b.test.mjs', outcome: 'failed' },
        { file: 'test/c.test.mjs', outcome: 'skipped' },
        { file: 'test/d.test.mjs', outcome: 'failed' },
      ],
      totalFiles: 4,
      interrupted: false,
    });
  });

  test('a file whose suite hook failed is failed even with no failing test', () => {
    const text = report([fileResult('test/hook.test.mjs', 'failed', ['skipped'])]);
    expect(readVitestRunResult(text, ROOT).files).toEqual([{ file: 'test/hook.test.mjs', outcome: 'failed' }]);
  });

  test('one path reported twice is not collapsed', () => {
    const text = report([
      fileResult('test/a.test.mjs', 'passed', ['passed']),
      fileResult('test/a.test.mjs', 'failed', ['failed']),
    ]);
    const read = readVitestRunResult(text, ROOT);
    expect(read.files).toHaveLength(2);
    expect(read.totalFiles).toBe(2);
  });

  test.each([
    ['not JSON', 'JSON report written'],
    ['not an object', '[]'],
    ['no numTotalTests', JSON.stringify({ testResults: [] })],
    ['no testResults', JSON.stringify({ numTotalTests: 0 })],
    ['a pending test', report([fileResult('test/a.test.mjs', 'passed', ['passed', 'pending'])])],
    ['a passed file with no test result', report([fileResult('test/a.test.mjs', 'passed', [])])],
    ['an unrecognized file status', report([fileResult('test/a.test.mjs', 'skipped', ['skipped'])])],
    ['an unrecognized test status', report([fileResult('test/a.test.mjs', 'passed', ['focused'])])],
    [
      'a count that disagrees with numTotalTests',
      JSON.stringify({ numTotalTests: 3, testResults: [fileResult('test/a.test.mjs', 'passed', ['passed'])] }),
    ],
    [
      'a file outside the repository',
      JSON.stringify({
        numTotalTests: 1,
        testResults: [{ ...fileResult('x.test.mjs', 'passed', ['passed']), name: '/elsewhere/x.test.mjs' }],
      }),
    ],
  ])('%s credits nothing', (_label, text) => {
    expect(readVitestRunResult(text, ROOT).kind).toBe('unreadable');
  });
});
