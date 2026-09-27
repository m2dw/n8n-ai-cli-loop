// Issue #1152 — the Jest test-file adapter against a real Jest run
// (docs/changed-file-verification-contract.md §6).
//
// The fixture (test/fixtures/jest-test-file-adapter) is a plain-CommonJS Jest
// project that needs only Node: `build.cjs` copies src/ into dist/, and its
// tests read dist/ and leave a marker when reached. Each test copies it to a
// private directory and runs this repository's installed Jest through the
// shipped CommandRunner, so every assertion below is about Jest's actual
// discovery and machine results rather than a hand-written JSON.
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
  TestExecutionRequestError,
  discoverTestFiles,
  runTestFiles,
} from '../dist/index.js';
import { bothStreamsCommandRunner } from '../dist/handlers/command-runner.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = join(ROOT, 'test', 'fixtures', 'jest-test-file-adapter');
const JEST_BIN = join(ROOT, 'node_modules', 'jest', 'bin', 'jest.js');

const A = 'tests/a.test.cjs';
const B = 'tests/b.test.cjs';
const C = 'tests/c.test.cjs';

let project;
let artifactDir;

beforeEach(() => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'jest-test-file-adapter-')));
  project = join(parent, 'project');
  cpSync(FIXTURE, project, { recursive: true });
  artifactDir = join(parent, 'artifacts');
  mkdirSync(artifactDir);
});

afterEach(() => {
  rmSync(dirname(project), { recursive: true, force: true });
});

const binding = { adapter: 'jest', setupCommand: `"${process.execPath}" build.cjs` };
const options = (overrides = {}) => ({
  cwd: project,
  suiteCommand: `"${process.execPath}" "${JEST_BIN}"`,
  binding,
  artifactDir,
  timeoutMs: 60_000,
  ...overrides,
});
const ran = (name) => existsSync(join(project, 'ran', name));
const resetMarkers = () => rmSync(join(project, 'ran'), { recursive: true, force: true });

// Every case here spawns a real Jest, and the full `npm test` runs it beside
// hundreds of other suites, so a cold Jest can miss its deadline on a starved
// host (a 60s discovery deadline was once exceeded that way). A command that
// hit its deadline says nothing about the adapter either way: retry it from
// fresh markers, loudly, within a wall-clock budget. When every attempt is
// starved the last result is returned, so its assertions still fail — a Jest
// that never answers stays a failure, it just is not the first starved one.
const STARVED_ATTEMPTS = 3;
const STARVED_BUDGET_MS = 150_000;
function untilHostAnswers(label, attempt) {
  const started = Date.now();
  for (let n = 1; ; n += 1) {
    resetMarkers();
    const result = attempt();
    const starved = result.steps.some((s) => s.timedOut === true);
    if (!starved || n === STARVED_ATTEMPTS || Date.now() - started > STARVED_BUDGET_MS) return result;
    console.warn(
      `${label}: a Jest command hit its deadline on attempt ${n}/${STARVED_ATTEMPTS} ` +
        `(${Date.now() - started}ms so far) — treating it as host starvation and retrying`,
    );
  }
}

test('discovery reports the runnable files from the Jest configuration', () => {
  const discovery = untilHostAnswers('discovery', () => discoverTestFiles(bothStreamsCommandRunner, options()));
  expect(discovery.inventory).toEqual({ kind: 'readable', files: [A, B, C] });
  expect(discovery.termination).toBe('confirmed');
  // Discovery runs no test.
  expect(ran('a') || ran('b') || ran('c')).toBe(false);
}, 240_000);

test('explicit A runs A and not B; full mode then runs both', () => {
  const selected = untilHostAnswers('explicit A', () =>
    runTestFiles(bothStreamsCommandRunner, { mode: 'files', files: [A] }, options()));
  expect(selected).toMatchObject({
    mode: 'files',
    expectedFiles: [A],
    files: [{ file: A, outcome: 'passed' }],
    failedFiles: [],
    trust: { status: 'trusted' },
    processResult: 'succeeded',
    completeness: { status: 'complete' },
    termination: 'confirmed',
  });
  expect(selected.steps.map((s) => s.step)).toEqual(['setup', 'tests']);
  expect(ran('a')).toBe(true);
  expect(ran('b')).toBe(false);
  expect(ran('c')).toBe(false);

  const full = untilHostAnswers('full after explicit A', () =>
    runTestFiles(bothStreamsCommandRunner, { mode: 'full' }, options()));
  expect(full.steps.map((s) => s.step)).toEqual(['setup', 'discovery', 'tests']);
  expect(full.expectedFiles).toEqual([A, B, C]);
  expect(full.files).toEqual([
    { file: A, outcome: 'passed' },
    { file: B, outcome: 'passed' },
    { file: C, outcome: 'skipped' },
  ]);
  expect(full.completeness).toEqual({ status: 'complete' });
  expect(ran('a') && ran('b') && ran('c')).toBe(true);
  expect(existsSync(join(artifactDir, full.resultArtifact))).toBe(true);
}, 480_000);

test('an empty selection is refused and runs nothing, never the full suite', () => {
  expect(() => runTestFiles(bothStreamsCommandRunner, { mode: 'files', files: [] }, options()))
    .toThrow(TestExecutionRequestError);
  expect(existsSync(join(project, 'dist'))).toBe(false);
  expect(ran('a') || ran('b') || ran('c')).toBe(false);
});

test('setup compiles src into dist before the tests consume the change', () => {
  expect(existsSync(join(project, 'dist'))).toBe(false);
  const first = untilHostAnswers('build before change', () =>
    runTestFiles(bothStreamsCommandRunner, { mode: 'files', files: [A] }, options()));
  expect(first.completeness).toEqual({ status: 'complete' });

  // Change the source only. A passes solely against the old build, so a
  // failure here proves the run rebuilt dist before A read it.
  writeFileSync(join(project, 'src', 'values.cjs'), 'module.exports = { answer: 41 };\n');
  const changed = untilHostAnswers('build after change', () =>
    runTestFiles(bothStreamsCommandRunner, { mode: 'files', files: [A] }, options()));
  expect(changed.failedFiles).toEqual([A]);
  expect(changed.trust).toEqual({ status: 'trusted' });
  expect(changed.processResult).toBe('failed');
}, 480_000);

test('failed files come from the actual Jest machine result of a full run', () => {
  writeFileSync(join(project, 'src', 'values.cjs'), 'module.exports = { answer: 41 };\n');
  const full = untilHostAnswers('failing full run', () =>
    runTestFiles(bothStreamsCommandRunner, { mode: 'full' }, options()));
  expect(full.files).toEqual([
    { file: A, outcome: 'failed' },
    { file: B, outcome: 'passed' },
    { file: C, outcome: 'skipped' },
  ]);
  expect(full.failedFiles).toEqual([A]);
  expect(full.processResult).toBe('failed');
  expect(full.completeness).toEqual({ status: 'incomplete', reason: 'process-failed' });
}, 240_000);

test('a -c shell wrapper forwards discovery into the wrapped Jest instead of running the suite', () => {
  const discovery = untilHostAnswers('wrapped discovery', () =>
    discoverTestFiles(bothStreamsCommandRunner, options({ suiteCommand: `sh -c '"${process.execPath}" "${JEST_BIN}"'` })));
  expect(discovery.inventory).toEqual({ kind: 'readable', files: [A, B, C] });
  expect(ran('a') || ran('b') || ran('c')).toBe(false);
}, 240_000);

test("a suite command's bail is kept, and the bailed run it leaves without a machine result never passes", () => {
  writeFileSync(join(project, 'src', 'values.cjs'), 'module.exports = { answer: 41 };\n');
  const full = untilHostAnswers('bailing full run', () =>
    runTestFiles(
      bothStreamsCommandRunner,
      { mode: 'full' },
      options({ suiteCommand: `"${process.execPath}" "${JEST_BIN}" --bail --runInBand` }),
    ));
  // Jest exits on bail before it writes the --outputFile report, which a
  // --no-bail override would have written.
  expect(ran('a')).toBe(true);
  expect(full.trust).toMatchObject({ status: 'untrusted', reason: 'unreadable-result' });
  expect(full.processResult).toBe('failed');
  expect(full.files).toEqual([]);
  expect(full.failedFiles).toEqual([]);
  expect(full.completeness).toEqual({ status: 'incomplete', reason: 'untrusted' });
  expect(full.resultArtifact).toBeUndefined();
}, 240_000);

test("the project's configured reporters are kept, so a reporter error still fails the run", () => {
  // A reporter whose getLastError fails Jest's run even though every test passes.
  writeFileSync(
    join(project, 'failing-reporter.cjs'),
    "module.exports = class { getLastError() { return new Error('the project reporter failed'); } };\n",
  );
  writeFileSync(
    join(project, 'jest.reporting.config.cjs'),
    "module.exports = { ...require('./jest.config.cjs'), reporters: ['default', '<rootDir>/failing-reporter.cjs'] };\n",
  );
  const suiteCommand = `"${process.execPath}" "${JEST_BIN}" --config jest.reporting.config.cjs`;
  for (const request of [{ mode: 'files', files: [A] }, { mode: 'full' }]) {
    const result = untilHostAnswers(`reporter error (${request.mode})`, () =>
      runTestFiles(bothStreamsCommandRunner, request, options({ suiteCommand })));
    expect(result.failedFiles).toEqual([]);
    expect(result.processResult).toBe('failed');
    expect(result.completeness).toEqual({ status: 'incomplete', reason: 'process-failed' });
  }
}, 480_000);

test('a -c shell behind a launcher is refused rather than running the whole suite', () => {
  const suiteCommand = `env NODE_ENV=test sh -c '"${process.execPath}" "${JEST_BIN}"'`;
  expect(() => discoverTestFiles(bothStreamsCommandRunner, options({ suiteCommand }))).toThrow(/cannot forward/);
  expect(() => runTestFiles(bothStreamsCommandRunner, { mode: 'files', files: [A] }, options({ suiteCommand })))
    .toThrow(/cannot forward/);
  expect(existsSync(join(project, 'dist'))).toBe(false);
  expect(ran('a') || ran('b') || ran('c')).toBe(false);
});

test('a literal path Jest does not run is never silently dropped into a pass', () => {
  const result = untilHostAnswers('literal non-test path', () =>
    runTestFiles(bothStreamsCommandRunner, { mode: 'files', files: [A, 'src/values.cjs'] }, options()));
  expect(ran('a')).toBe(true);
  expect(result.trust.status).toBe('untrusted');
  expect(result.files).toEqual([]);
  expect(result.failedFiles).toEqual([]);
  expect(result.completeness.status).toBe('incomplete');
}, 240_000);
