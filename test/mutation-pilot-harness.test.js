// Issue #1111 — the opt-in, scoped StrykerJS harness (Test Maintenance Pilot,
// slice 3). This suite never runs Stryker, a build or a mutation: it pins the
// bounds the harness exists to keep — the accepted #1110 scope, opt-in-only
// invocation, local-only reports — and covers the pure helpers that decide a
// run's verdict.

import { execFileSync, spawn } from 'child_process';
import { EventEmitter } from 'events';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, isAbsolute, join } from 'path';
import { createRequire } from 'module';
import { fileURLToPath, pathToFileURL } from 'url';

import {
  BUILD_COMMAND,
  DEFAULT_OUT,
  IGNORE_PATTERNS,
  INCREMENTAL_DIR,
  INCREMENTAL_IDENTITY_KEYS,
  BASELINE_MUTATE,
  INSTRUMENTATION_MARKER,
  SANDBOX_PREFIX,
  TEMP_DIR_NAME,
  TOOLCHAIN_FILES,
  TOOLCHAIN_PACKAGES,
  MUTATION_BUILD_ENTRY,
  PILOT_MUTATE,
  PILOT_TESTS,
  RUN_SPEC_KEYS,
  SMOKE_MUTATE,
  SMOKE_TESTS,
  TSC_ARGS,
  TSC_ENTRY,
  assertScope,
  buildCommandFor,
  disableTypeChecksFor,
  escapeCommandToken,
  harnessToolchain,
  ignorePatternsFor,
  incrementalFileFor,
  jestTestMatch,
  loadRunSpec,
  pilotStrykerConfig,
  projectJestConfig,
  resolveBuildEntry,
  resolveTscEntry,
} from '../stryker.pilot.config.mjs';
import {
  buildVerdict,
  boundOutput,
  countDiagnostics,
  distPathFor,
  mutatedSources,
  outputLayout,
} from '../scripts/mutation-build.mjs';
import {
  BACKGROUND_GRACE_MS,
  COVERAGE_ANALYSES,
  DASHBOARD_KEY_ENV,
  DEFAULT_SANDBOX_FILES,
  DRY_RUN_BUDGET_MIN,
  LOCK_ATTEMPTS,
  LOCK_STEAL,
  LOCK_STEAL_STALE_MS,
  LOCK_WRITE_GRACE_MS,
  MAX_LISTED_EXPOSED,
  MAX_LISTED_MUTANTS,
  MAX_LOG_TAIL_LINES,
  PROTECTED_SCRIPTS,
  RAW_ARTIFACTS,
  REPORT_LABELS,
  RUN_ID_ENV,
  RUN_LOCK,
  RUN_LOCK_DIR,
  RUN_LOCK_PATH,
  RUN_LOG,
  RUN_STATE,
  SCOPE_IDENTITY_KEYS,
  STALE_ARTIFACTS,
  STALE_SANDBOX_AGE_MS,
  STRYKER_PACKAGES,
  adoptLockInstance,
  backgroundArgs,
  backgroundRunState,
  capList,
  childEnv,
  classifyBackgroundRun,
  classifyStrykerRun,
  clearAbandonedLock,
  dryRunCost,
  formatDuration,
  gitIgnoredPaths,
  gitProbeOut,
  heartbeatLine,
  incrementalFileForMode,
  isSelfRun,
  lockBlocks,
  lockOwnerAlive,
  markdownCell,
  markdownCodeCell,
  nodeRangeVerdict,
  parseArgs,
  parseDryRunFacts,
  patchOwnRunLock,
  pathsOutsideWorktree,
  pidIdentity,
  pilotCommand,
  preflightFindings,
  processAlive,
  processGroupAlive,
  PROCESS_STAMP_ENV,
  probeConsole,
  processStampCommand,
  processStartedAt,
  projectBuildLayout,
  publishSummary,
  rawReportPaths,
  recoverRunState,
  sandboxProbeFiles,
  hostParallelism,
  INSTRUMENTER_PARSER_CHAIN,
  readResolvedPackage,
  reclaimStaleMutex,
  recordedProcessAlive,
  renderBackgroundReport,
  renderLockRefusal,
  renderLogTail,
  renderSummary,
  replaceLockRecord,
  reportsIgnoredFinding,
  sameLockInstance,
  sameMutexInstance,
  sandboxInputFiles,
  sanitizeBuildRecord,
  scopeFor,
  shellArg,
  smokeVerdict,
  staleSandboxes,
  strykerBinFromManifest,
  strykerGroupAlive,
  summarizeMutationReport,
  tailLines,
  trackedFiles,
  versionRangeVerdict,
  watchConsole,
} from '../scripts/mutation-pilot.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

/**
 * The command parser Stryker's sandbox actually hands `buildCommand` to: the
 * `execa` that `@stryker-mutator/core` resolves (its `execaCommand` is
 * `parseCommandString` followed by a shell-less spawn), not a reimplementation.
 */
async function strykerCommandParser() {
  const require = createRequire(join(ROOT, 'node_modules', '@stryker-mutator', 'core', 'package.json'));
  const { parseCommandString } = await import(pathToFileURL(require.resolve('execa')).href);
  return parseCommandString;
}

/**
 * One GFM table row as the table extension reads it: split on every `|` with no
 * backslash directly before it, then turn each `\|` into `|` before inline
 * parsing (cmark-gfm's `unescape_pipes`). A single-cell row is `| <cell> |`.
 */
function gfmRowCells(row) {
  return row
    .replace(/^\|/, '')
    .replace(/(?<!\\)\|$/, '')
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replace(/\\\|/g, '|'));
}

/** The text of a cell holding one code span (CommonMark: strip one pad space each side). */
function codeSpanText(cell) {
  const fence = cell.match(/^`+/)[0];
  expect(cell.endsWith(fence)).toBe(true);
  const inner = cell.slice(fence.length, -fence.length);
  return inner.startsWith(' ') && inner.endsWith(' ') && inner.trim() !== '' ? inner.slice(1, -1) : inner;
}

describe('pilot scope is exactly the one #1110 accepted', () => {
  test('the two mutated sources and four evidence test files are named, not globbed', () => {
    expect(PILOT_MUTATE).toEqual(['src/core/chain-linear.ts', 'src/core/tool-request-grant.ts']);
    expect(PILOT_TESTS).toEqual([
      'test/chain-linear.test.js',
      'test/admin-chain-edit.test.js',
      'test/tool-request-grant.test.js',
      'test/admin-tool-request-grant.test.js',
    ]);
    // A glob would let the scope drift silently as files are added.
    for (const entry of [...PILOT_MUTATE, ...PILOT_TESTS]) expect(entry).not.toMatch(/[*?]/);
  });

  test('every scoped file still exists on this branch', () => {
    for (const file of [...PILOT_MUTATE, ...PILOT_TESTS]) expect(existsSync(join(ROOT, file))).toBe(true);
  });

  test('the smoke scope is a line range inside one accepted source, run by one accepted suite', () => {
    expect(SMOKE_MUTATE).toEqual(['src/core/tool-request-grant.ts:73-84']);
    expect(SMOKE_TESTS).toEqual(['test/tool-request-grant.test.js']);
    // #1110 §5 allows narrowing to a range inside the same files, nothing else.
    for (const entry of SMOKE_MUTATE) expect(PILOT_MUTATE).toContain(entry.split(':')[0]);
    for (const file of SMOKE_TESTS) expect(PILOT_TESTS).toContain(file);
  });

  test('the smoke range still covers normalizeCommand, which the pure suite asserts directly', () => {
    const [file, range] = SMOKE_MUTATE[0].split(':');
    const [from, to] = range.split('-').map(Number);
    const lines = readFileSync(join(ROOT, file), 'utf8').split('\n');
    expect(lines[from - 1]).toContain('export function normalizeCommand');
    expect(lines.slice(from - 1, to).join('\n')).toContain('flushPendingSpace');
    expect(readFileSync(join(ROOT, SMOKE_TESTS[0]), 'utf8')).toContain('normalizeCommand trims and collapses internal whitespace');
  });

  test('the #1112 baseline scope is a line range inside BOTH accepted sources', () => {
    expect(BASELINE_MUTATE).toEqual(['src/core/chain-linear.ts:329-359', 'src/core/tool-request-grant.ts:237-244']);
    // The only narrowing #1110 §5 allows: same files, stated ranges, and both of
    // them — dropping one source would be a scope substitution, not a narrowing.
    expect(BASELINE_MUTATE.map((entry) => entry.split(':')[0])).toEqual(PILOT_MUTATE);
    for (const entry of BASELINE_MUTATE) expect(entry).toMatch(/:\d+-\d+$/);
    expect(() => assertScope(BASELINE_MUTATE, PILOT_TESTS)).not.toThrow();
  });

  test('each baseline range is a real, in-bounds region of the file it names', () => {
    for (const entry of BASELINE_MUTATE) {
      const [file, range] = entry.split(':');
      const [from, to] = range.split('-').map(Number);
      const lines = readFileSync(join(ROOT, file), 'utf8').split('\n');
      expect(from).toBeGreaterThan(0);
      expect(to).toBeGreaterThanOrEqual(from);
      // A range past the end of the file mutates nothing and would publish an
      // empty baseline as a passing one.
      expect(to).toBeLessThanOrEqual(lines.length);
    }
  });

  test('the baseline ranges still cover the contracts the report names them by', () => {
    const region = (entry) => {
      const [file, range] = entry.split(':');
      const [from, to] = range.split('-').map(Number);
      return readFileSync(join(ROOT, file), 'utf8').split('\n').slice(from - 1, to).join('\n');
    };
    // `docs/metrics/mutation-pilot-baseline.md` §2 names these five functions.
    // If an edit moves one out of its frozen range, the published baseline stops
    // describing what was measured, so this fails rather than drifting.
    expect(region(BASELINE_MUTATE[0])).toContain('function edgeKey(');
    expect(region(BASELINE_MUTATE[0])).toContain('function compareEdges(');
    expect(region(BASELINE_MUTATE[0])).toContain('function linkEdges(');
    expect(region(BASELINE_MUTATE[0])).toContain('function resolveRoots(');
    expect(region(BASELINE_MUTATE[1])).toContain('export function grantStatus(');
  });

  test('each baseline range holds whole functions, not a truncated one', () => {
    // A range that ended inside a function would drop that function's own
    // refusal or message mutants — the ones least likely to be killed — and so
    // would publish a score improved by where the range was cut. Every `{` a
    // declaration in the region opens must close inside the region too.
    for (const entry of BASELINE_MUTATE) {
      const [file, range] = entry.split(':');
      const [from, to] = range.split('-').map(Number);
      const lines = readFileSync(join(ROOT, file), 'utf8').split('\n');
      const region = lines.slice(from - 1, to).join('\n');
      expect(region).toMatch(/function /);
      const braces = [...region].reduce((depth, ch) => depth + (ch === '{' ? 1 : ch === '}' ? -1 : 0), 0);
      expect(braces).toBe(0);
      // And the line before the region is not itself inside a declaration.
      expect((lines[from - 2] ?? '').trim()).not.toMatch(/[({,]$/);
    }
  });

  test('the baseline is narrower than the whole-file scope that did not fit', () => {
    // #1111 §6: 742 mutants over the whole files, ≈ 37 h serial. The narrowing is
    // the reason a bounded run is possible at all, so it must stay a narrowing.
    const lineCount = (file) => readFileSync(join(ROOT, file), 'utf8').split('\n').length;
    const whole = PILOT_MUTATE.reduce((sum, file) => sum + lineCount(file), 0);
    const selected = BASELINE_MUTATE.reduce((sum, entry) => {
      const [from, to] = entry.split(':')[1].split('-').map(Number);
      return sum + (to - from + 1);
    }, 0);
    expect(selected).toBeLessThan(whole / 4);
  });

  test('assertScope refuses a source outside the accepted two', () => {
    expect(() => assertScope(['src/index.ts'], PILOT_TESTS)).toThrow(/outside the accepted #1110 scope/);
    expect(() => assertScope(['src/**/*.ts'], PILOT_TESTS)).toThrow(/outside the accepted #1110 scope/);
  });

  test('assertScope refuses a test file outside the accepted four', () => {
    // These two reach the pilot sources and are excluded from the evidence on
    // purpose (#1110 §5): spawned, and a non-candidate that would mask a loss.
    expect(() => assertScope(PILOT_MUTATE, ['test/admin-tool-request-run.test.js'])).toThrow(/outside the accepted #1110 scope/);
    expect(() => assertScope(PILOT_MUTATE, ['test/tool-request-run-operation.test.js'])).toThrow(/outside the accepted #1110 scope/);
  });

  test('assertScope allows narrowing an accepted source to a line range, and refuses an empty scope', () => {
    expect(() => assertScope(['src/core/chain-linear.ts:457-796'], ['test/chain-linear.test.js'])).not.toThrow();
    expect(() => assertScope([], PILOT_TESTS)).toThrow(/non-empty/);
    expect(() => assertScope(PILOT_MUTATE, [])).toThrow(/non-empty/);
  });
});

describe('run spec', () => {
  test('no spec means the file is the full pilot configuration on its own', () => {
    expect(loadRunSpec({}, () => '{}')).toEqual({});
  });

  test('a spec is read from the path in MUTATION_PILOT_SPEC', () => {
    const spec = loadRunSpec({ MUTATION_PILOT_SPEC: '/tmp/spec.json' }, () => JSON.stringify({ label: 'smoke', concurrency: 1 }));
    expect(spec).toEqual({ label: 'smoke', concurrency: 1 });
  });

  test('an unknown key is refused rather than silently ignored', () => {
    expect(() => loadRunSpec({ MUTATION_PILOT_SPEC: '/tmp/spec.json' }, () => JSON.stringify({ mutateAll: true }))).toThrow(
      /unknown run-spec key\(s\): mutateAll/,
    );
    expect(RUN_SPEC_KEYS).toContain('mutate');
    expect(RUN_SPEC_KEYS).not.toContain('ignorePatterns');
  });
});

describe('Stryker configuration', () => {
  const config = pilotStrykerConfig();

  test('the checkout is never mutated and every artifact stays under the ignored out dir', () => {
    expect(config.inPlace).toBe(false);
    expect(config.tempDirName).toBe('.mutation/stryker-tmp');
    expect(config.jsonReporter.fileName).toBe('.mutation/pilot/mutation.json');
    expect(config.htmlReporter.fileName).toBe('.mutation/pilot/mutation.html');
    // Inside the mode's own report directory, which is the directory the
    // preflight asks Git about. Written out twice, the two could drift and
    // `reports-ignored` would certify a path no run produces while the real
    // incremental report stayed committable.
    expect(config.incrementalFile).toMatch(new RegExp(`^\\.mutation/pilot/${INCREMENTAL_DIR}/[0-9a-f]{16}\\.json$`));
    expect(config.incrementalFile).toBe(
      incrementalFileFor({
        out: '.mutation',
        label: 'pilot',
        mutate: PILOT_MUTATE,
        testFiles: PILOT_TESTS,
        coverageAnalysis: 'off',
        timeoutMs: 60_000,
        timeoutFactor: 2,
        concurrency: 2,
        jestConfig: projectJestConfig(),
        toolchain: harnessToolchain(),
      }),
    );
  });

  test('a verdict-affecting setting left out of the identity throws instead of digesting a shorter one', () => {
    // `JSON.stringify` drops an `undefined` value, so an omitted setting would
    // silently name the state file after a run that did not declare it — and
    // hand its verdicts to a run that declares something else. The omission is
    // invisible in the output (the run just reuses state), so it has to be
    // impossible at the call rather than reported afterwards.
    expect(INCREMENTAL_IDENTITY_KEYS).toEqual([
      'mutate',
      'testFiles',
      'coverageAnalysis',
      'timeoutMs',
      'timeoutFactor',
      'concurrency',
      'jestConfig',
      'toolchain',
    ]);
    expect(() =>
      incrementalFileFor({ out: '.mutation', label: 'pilot', mutate: PILOT_MUTATE, testFiles: PILOT_TESTS, coverageAnalysis: 'off' }),
    ).toThrow(/missing verdict-affecting setting\(s\): timeoutMs, timeoutFactor, concurrency, jestConfig, toolchain/);
  });

  test('incremental state is per toolchain, so an upgrade never inherits verdicts the old tools produced', () => {
    // Stryker reuses a stored status whenever source and tests are unchanged; it
    // does not notice that Stryker, Jest, TypeScript, Node or this harness's own
    // configuration changed since. The summary records what is installed NOW,
    // so reuse across such a change would credit verdicts to tools that never
    // produced them.
    const toolchain = harnessToolchain();
    expect(Object.keys(toolchain.packages)).toEqual(TOOLCHAIN_PACKAGES);
    expect(Object.keys(toolchain.files)).toEqual(TOOLCHAIN_FILES);
    expect(TOOLCHAIN_PACKAGES).toEqual(expect.arrayContaining([...STRYKER_PACKAGES, 'jest', 'typescript']));
    expect(TOOLCHAIN_FILES).toEqual(expect.arrayContaining(['stryker.pilot.config.mjs', MUTATION_BUILD_ENTRY, 'tsconfig.json']));
    expect(pilotStrykerConfig({ toolchain }).incrementalFile).toBe(config.incrementalFile);
    const bumped = (name) => ({ ...toolchain, packages: { ...toolchain.packages, [name]: '999.0.0' } });
    for (const name of TOOLCHAIN_PACKAGES) {
      expect(pilotStrykerConfig({ toolchain: bumped(name) }).incrementalFile).not.toBe(config.incrementalFile);
    }
    expect(pilotStrykerConfig({ toolchain: { ...toolchain, node: 'v0.0.0' } }).incrementalFile).not.toBe(config.incrementalFile);
    for (const file of TOOLCHAIN_FILES) {
      const edited = { ...toolchain, files: { ...toolchain.files, [file]: 'edited' } };
      expect(pilotStrykerConfig({ toolchain: edited }).incrementalFile).not.toBe(config.incrementalFile);
    }
    // The inherited Jest configuration decides what every test does.
    expect(pilotStrykerConfig({ jestConfig: { ...projectJestConfig(), testTimeout: 1 } }).incrementalFile).not.toBe(
      config.incrementalFile,
    );
  });

  test('the toolchain is read from the checkout, content-hashed, and an unreadable part is named rather than skipped', () => {
    const files = {
      '/r/node_modules/@stryker-mutator/core/package.json': '{"version":"8.7.1"}',
      '/r/node_modules/jest/package.json': '{"version":"29.7.0"}',
      '/r/stryker.pilot.config.mjs': 'a',
    };
    const read = (path) => {
      if (!(path in files)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return files[path];
    };
    const toolchain = harnessToolchain('/r', { read, node: 'v22.6.0' });
    expect(toolchain.node).toBe('v22.6.0');
    expect(toolchain.packages['@stryker-mutator/core']).toBe('8.7.1');
    expect(toolchain.packages.jest).toBe('29.7.0');
    expect(toolchain.packages.typescript).toBe('absent');
    expect(toolchain.files['stryker.pilot.config.mjs']).toMatch(/^[0-9a-f]{64}$/);
    expect(toolchain.files['tsconfig.json']).toBe('absent');
    files['/r/stryker.pilot.config.mjs'] = 'b';
    expect(harnessToolchain('/r', { read, node: 'v22.6.0' }).files['stryker.pilot.config.mjs']).not.toBe(
      toolchain.files['stryker.pilot.config.mjs'],
    );
  });

  test('incremental state is per mode and per scope, so no run inherits another selection’s verdicts', () => {
    // Stryker reuses a stored result whenever the mutant still matches the
    // source it was made from. With `coverageAnalysis: 'off'` there is no
    // coverage matrix, so nothing in that comparison can notice that the run
    // which stored the result ran DIFFERENT tests. One file under `--out` would
    // therefore let a pilot keep a smoke survivor without running the three
    // extra suites, and let a smoke run report kills only a pilot-only test
    // made. The path is what prevents it.
    const smoke = pilotStrykerConfig({ label: 'smoke', mutate: SMOKE_MUTATE, testFiles: SMOKE_TESTS });
    expect(smoke.incrementalFile).toMatch(new RegExp(`^\\.mutation/smoke/${INCREMENTAL_DIR}/`));
    expect(smoke.incrementalFile).not.toBe(config.incrementalFile);
    // Same mode, narrower mutation scope: still not the same state.
    const narrowed = pilotStrykerConfig({ mutate: [PILOT_MUTATE[0]] });
    expect(narrowed.incrementalFile).not.toBe(config.incrementalFile);
    // Same mode and sources, fewer test files: the selection that produced a
    // verdict is part of the verdict.
    const fewerTests = pilotStrykerConfig({ testFiles: PILOT_TESTS.slice(0, 2) });
    expect(fewerTests.incrementalFile).not.toBe(config.incrementalFile);
    // `coverageAnalysis` decides how much of the selection each mutant runs, so
    // an `off` result is not a `perTest` result either.
    expect(pilotStrykerConfig({ coverageAnalysis: 'perTest' }).incrementalFile).not.toBe(config.incrementalFile);
    // The deadline decides a verdict as directly as the assertions do: Stryker
    // counts a `Timeout` as a DETECTION, so a mutant judged detected under a
    // 5 s deadline must not stay detected once the deadline is raised without
    // ever being executed again. Both halves of the deadline are identity.
    expect(pilotStrykerConfig({ timeoutMs: 5_000 }).incrementalFile).not.toBe(config.incrementalFile);
    expect(pilotStrykerConfig({ timeoutFactor: 4 }).incrementalFile).not.toBe(config.incrementalFile);
    // And the worker count the deadline is measured under is the same kind of
    // setting: contention between workers is what pushes a slow mutant past the
    // deadline, so a `Timeout` recorded at eight workers must not be inherited
    // by a one-worker run that would have let the same mutant survive.
    expect(pilotStrykerConfig({ concurrency: 1 }).incrementalFile).not.toBe(config.incrementalFile);
    expect(pilotStrykerConfig({ concurrency: 8 }).incrementalFile).not.toBe(config.incrementalFile);
    // And an identical scope IS reusable — the point of `--incremental`.
    expect(pilotStrykerConfig().incrementalFile).toBe(config.incrementalFile);
  });

  test('nothing is uploaded: no dashboard reporter is configured', () => {
    expect(config.reporters).not.toContain('dashboard');
    expect(JSON.stringify(config)).not.toMatch(/dashboard/i);
  });

  test('a mutation score is reported, never enforced', () => {
    expect(config.thresholds.break).toBeNull();
  });

  test('incremental mode is off, so a before/after run never reuses another tree’s results', () => {
    expect(config.incremental).toBe(false);
  });

  test('the sandbox builds the mutated TypeScript with the project tsconfig, overridden only on the command line', () => {
    expect(TSC_ARGS).toContain('-p');
    expect(TSC_ARGS).toContain('tsconfig.json');
    // The checked-in tsconfig keeps noEmitOnError for the real build.
    expect(TSC_ARGS.join(' ')).toContain('--noEmitOnError false');
    expect(JSON.parse(readFileSync(join(ROOT, 'tsconfig.json'), 'utf8')).compilerOptions.noEmitOnError).toBe(true);
    expect(config.buildCommand).toBe(BUILD_COMMAND);
  });

  test('type checking is disabled for the compiled sources, because instrumented TypeScript does not type-check', () => {
    // Stryker's instrumentation assigns to its own `stryNS_*`/`stryMutAct_*`
    // function declarations and calls them with arguments they do not declare,
    // so tsc reports TS2630/TS2554 for a file it instrumented — and exits 2
    // whatever `--noEmitOnError` says, which Stryker reads as a failed build.
    // `false` here is therefore a run that never tests a mutant.
    expect(config.disableTypeChecks).toBe(disableTypeChecksFor(ROOT));
    expect(config.disableTypeChecks).not.toBe(false);
    expect(isAbsolute(config.disableTypeChecks)).toBe(true);
    // Narrower than Stryker's `{test,src,lib}/**` default: exactly what the
    // project compiles, so the sandbox's test files stay byte-identical.
    expect(JSON.parse(readFileSync(join(ROOT, 'tsconfig.json'), 'utf8')).include).toEqual(['src/**/*.ts']);
    expect(config.disableTypeChecks).toBe(join(ROOT, 'src/**/*.ts'));
    // Nothing the tests execute is rewritten: no scoped test file is under it.
    for (const file of PILOT_TESTS) expect(join(ROOT, file).startsWith(join(ROOT, 'src'))).toBe(false);
  });

  test('the build wrapper and compiler are named by absolute checkout path, because the sandbox has no node_modules when the build runs', () => {
    // @stryker-mutator/core 8.7.x runs `buildCommand` BEFORE it symlinks
    // node_modules into the sandbox, and node_modules is not part of the sandbox
    // copy either. A sandbox-relative `node node_modules/...` dies with
    // MODULE_NOT_FOUND, no dist/ is emitted, and the run ends before any mutant
    // is tested — the exact failure this pins against.
    expect(isAbsolute(resolveTscEntry())).toBe(true);
    expect(resolveTscEntry()).toBe(join(ROOT, TSC_ENTRY));
    expect(resolveBuildEntry()).toBe(join(ROOT, MUTATION_BUILD_ENTRY));
    expect(BUILD_COMMAND).toBe(buildCommandFor(ROOT));
    expect(BUILD_COMMAND).toBe(`node ${escapeCommandToken(resolveBuildEntry())}`);
    // Both must be present here: the sandbox cannot supply either.
    expect(existsSync(resolveTscEntry())).toBe(true);
    expect(existsSync(resolveBuildEntry())).toBe(true);
  });

  test('a checkout path containing spaces and backslashes survives execa’s shell-less command split', async () => {
    // execa splits the command string on runs of spaces and only rejoins a token
    // whose predecessor ends in a backslash, so an unescaped path would be torn
    // into two arguments. Parse with the real parser Stryker uses rather than
    // assert a literal or a reimplementation of it.
    const parse = await strykerCommandParser();
    const roots = [
      '/checkouts/my projects/repo',
      '/checkouts/two  spaces/repo',
      '/checkouts/ leading and trailing /repo',
      // A backslash is an ordinary file-name character on POSIX, and the path
      // separator on Windows: neither may be doubled or dropped.
      '/checkouts/back\\slash/repo',
      '/checkouts/back\\ before space/repo',
      '/checkouts/back\\\\ run before space/repo',
      'C:\\Users\\A User\\repo',
      'C:\\Users\\trailing \\repo',
    ];
    for (const root of roots) {
      const entry = `${root}/${MUTATION_BUILD_ENTRY}`;
      expect(parse(`node ${escapeCommandToken(entry)}`)).toEqual(['node', entry]);
    }
    const root = join('/checkouts', 'my projects', 'repo');
    expect(parse(buildCommandFor(root))).toEqual(['node', join(root, MUTATION_BUILD_ENTRY)]);
    expect(parse(BUILD_COMMAND)).toEqual(['node', resolveBuildEntry()]);
  });

  test('a token the execa command parser cannot represent is refused, not mangled', async () => {
    const parse = await strykerCommandParser();
    // A trailing backslash swallows the delimiter after it: shown on the parser
    // itself, so the refusal is pinned to real behaviour, not to a guess.
    expect(parse('node C:\\repo\\ next')).toEqual(['node', 'C:\\repo next']);
    for (const value of ['', 'C:\\repo\\', ' leading', 'trailing ', 'tab\t', '\nnewline']) {
      expect(() => escapeCommandToken(value)).toThrow(/cannot represent/);
    }
  });

  test('the sandbox receives no dist, so a stale build cannot answer for a mutated source', () => {
    expect(IGNORE_PATTERNS).toContain('dist');
    expect(config.ignorePatterns).toContain('dist');
    expect(readFileSync(join(ROOT, '.gitignore'), 'utf8')).toMatch(/^dist\/$/m);
  });

  test('an in-tree --out is kept out of the sandbox, not copied into every one', () => {
    // Stryker excludes only this mode's own report files; the rest of `<out>` —
    // the live run.log, the run spec, earlier modes' reports — would ride along.
    expect(pilotStrykerConfig({ out: 'reports/pilot' }).ignorePatterns).toEqual([...IGNORE_PATTERNS, '/reports/pilot']);
    expect(ignorePatternsFor(join(ROOT, 'reports', 'pilot'), ROOT)).toEqual([...IGNORE_PATTERNS, '/reports/pilot']);
    // Anchored and escaped: one directory, not a glob.
    expect(ignorePatternsFor('out[1]/*', ROOT).at(-1)).toBe('/out\\[1\\]/\\*');
    // Already covered, outside the checkout, or the checkout itself: nothing added.
    expect(ignorePatternsFor(DEFAULT_OUT, ROOT)).toEqual(IGNORE_PATTERNS);
    expect(ignorePatternsFor(join(tmpdir(), 'mutation-out'), ROOT)).toEqual(IGNORE_PATTERNS);
    expect(ignorePatternsFor('../elsewhere', ROOT)).toEqual(IGNORE_PATTERNS);
    expect(ignorePatternsFor('.', ROOT)).toEqual(IGNORE_PATTERNS);
  });

  test('findRelatedTests is pinned off, because the tests import dist and never src', () => {
    // Left at its default it would relate a mutated src file to zero tests and
    // report every mutant as surviving.
    expect(config.jest.enableFindRelatedTests).toBe(false);
    for (const file of PILOT_TESTS) expect(readFileSync(join(ROOT, file), 'utf8')).toMatch(/from '\.\.\/dist\//);
  });

  test('the Jest run is the project’s own configuration plus the scope restriction', () => {
    const projectJest = projectJestConfig(manifest);
    expect(config.jest.projectType).toBe('custom');
    for (const [key, value] of Object.entries(projectJest)) expect(config.jest.config[key]).toEqual(value);
    // Without globalSetup/setupFiles the test-owned HOME (#1063) is missing.
    expect(config.jest.config.globalSetup).toBe(projectJest.globalSetup);
    expect(config.jest.config.setupFiles).toEqual(projectJest.setupFiles);
    expect(config.jest.config.testMatch).toEqual(jestTestMatch(PILOT_TESTS));
  });

  test('a sandbox an interrupted run leaves under <out> stays out of the project’s own Jest run', () => {
    // `cleanTempDir` only runs when Stryker exits normally: a timed-out or
    // killed run leaves a full copy of the checkout, instrumented tests
    // included, under `.mutation/stryker-tmp`. Jest must neither collect those
    // copies as tests nor index their package.json as a duplicate module.
    const projectJest = manifest.jest;
    const asRegex = (pattern, rootDir) => new RegExp(pattern.replace('<rootDir>', rootDir));
    const leftover = join(ROOT, DEFAULT_OUT, TEMP_DIR_NAME, `${SANDBOX_PREFIX}1`);
    expect(projectJest.testPathIgnorePatterns).toContain('/node_modules/');
    for (const key of ['testPathIgnorePatterns', 'modulePathIgnorePatterns']) {
      const patterns = projectJest[key].map((pattern) => asRegex(pattern, ROOT));
      expect(patterns.some((re) => re.test(join(leftover, 'test/chain-linear.test.js')))).toBe(true);
      expect(patterns.some((re) => re.test(join(leftover, 'package.json')))).toBe(true);
      expect(patterns.some((re) => re.test(join(ROOT, 'test/chain-linear.test.js')))).toBe(false);
      // Stryker runs Jest with the sandbox as rootDir, carrying this same
      // configuration: the rule is anchored there, so it must not hide the
      // sandbox's own tests from the mutation run.
      const inSandbox = projectJest[key].map((pattern) => asRegex(pattern, leftover));
      expect(inSandbox.some((re) => re.test(join(leftover, 'test/chain-linear.test.js')))).toBe(false);
      // `--out` moves the sandbox with it, so a leftover under a custom
      // in-tree output directory must be excluded too, not only `.mutation`.
      for (const out of ['out', 'reports/mutation', '.']) {
        const custom = join(ROOT, out, TEMP_DIR_NAME, `${SANDBOX_PREFIX}abc123`);
        expect(patterns.some((re) => re.test(join(custom, 'test/chain-linear.test.js')))).toBe(true);
        expect(patterns.some((re) => re.test(join(custom, 'package.json')))).toBe(true);
        const inCustom = projectJest[key].map((pattern) => asRegex(pattern, custom));
        expect(inCustom.some((re) => re.test(join(custom, 'test/chain-linear.test.js')))).toBe(false);
      }
    }
    expect(config.jest.config.testPathIgnorePatterns).toEqual(projectJest.testPathIgnorePatterns);
    expect(config.jest.config.modulePathIgnorePatterns).toEqual(projectJest.modulePathIgnorePatterns);
  });

  test('native-ESM Jest gets the VM-modules flag in the test-runner process', () => {
    expect(config.testRunner).toBe('jest');
    expect(config.testRunnerNodeArgs).toContain('--experimental-vm-modules');
    expect(config.plugins).toEqual(['@stryker-mutator/jest-runner']);
  });

  test('coverage analysis defaults to off, the option that needs no assumption about per-test attribution', () => {
    expect(config.coverageAnalysis).toBe('off');
    expect(COVERAGE_ANALYSES).toEqual(['off', 'all', 'perTest']);
  });

  test('a smoke configuration mutates only the smoke range and runs only the pure suite', () => {
    const smoke = pilotStrykerConfig({ mutate: SMOKE_MUTATE, testFiles: SMOKE_TESTS, label: 'smoke' });
    expect(smoke.mutate).toEqual(SMOKE_MUTATE);
    expect(smoke.jest.config.testMatch).toEqual(['<rootDir>/test/tool-request-grant.test.js']);
    expect(smoke.jsonReporter.fileName).toBe('.mutation/smoke/mutation.json');
  });

  test('a configuration cannot be built for an out-of-scope file', () => {
    expect(() => pilotStrykerConfig({ mutate: ['src/cli/admin.ts'] })).toThrow(/outside the accepted #1110 scope/);
  });
});

describe('the harness is opt-in only', () => {
  test('no default verification script reaches mutation testing', () => {
    for (const name of PROTECTED_SCRIPTS) {
      expect(manifest.scripts[name] ?? '').not.toMatch(/stryker|mutation/i);
    }
    expect(manifest.scripts.pretest).toBe('npm run build');
    expect(manifest.scripts['test:files']).toBe('node --experimental-vm-modules node_modules/.bin/jest');
  });

  test('every mutation entry point is an explicit, named script', () => {
    for (const mode of ['preflight', 'dry-run', 'smoke', 'pilot']) {
      expect(manifest.scripts[`mutation:${mode}`]).toMatch(/^node scripts\/mutation-pilot\.mjs --/);
    }
    // A detached start and its read-back are entry points too: each is one
    // command an operator types, never something this harness starts by itself.
    for (const mode of ['dry-run', 'smoke', 'pilot']) {
      expect(manifest.scripts[`mutation:${mode}:start`]).toBe(`node scripts/mutation-pilot.mjs --${mode} --background`);
      expect(manifest.scripts[`mutation:${mode}:report`]).toBe(`node scripts/mutation-pilot.mjs --${mode} --report`);
    }
    // The names `renderBackgroundReport` tells an operator to type must exist.
    for (const mode of ['dry-run', 'smoke', 'pilot']) {
      const rendered = renderBackgroundReport({ status: 'absent', elapsedMs: 0 }, {
        label: mode,
        mode,
        startCommand: `npm run mutation:${mode}:start`,
        reportCommand: `npm run mutation:${mode}:report`,
      });
      const named = rendered.line.match(/`npm run ([^`]+)`/)[1];
      expect(manifest.scripts[named]).toBeDefined();
    }
  });

  test('Stryker is pinned as a devDependency, so a run is reproducible', () => {
    for (const name of STRYKER_PACKAGES) expect(manifest.devDependencies[name]).toMatch(/^\^?\d+\./);
  });

  test('core and the Jest runner are pinned, and locked, at one version (#1185)', () => {
    // The runner is released in lockstep with core and peer-depends on it, so a
    // pin that moves one without the other describes a tree npm cannot install.
    const [core, runner] = STRYKER_PACKAGES.map((name) => manifest.devDependencies[name]);
    expect(runner).toBe(core);
    // The 8.x line pins `ajv` ~8.17 and reaches `tmp` through `external-editor`;
    // #1185 moved off it to clear those audit findings.
    expect(core).toBe('^10.0.0');
    // A lockfile left on the old pin would install the old tree whatever the
    // manifest says.
    const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8'));
    const locked = STRYKER_PACKAGES.map((name) => lock.packages[`node_modules/${name}`]?.version);
    expect(locked[1]).toBe(locked[0]);
    for (const [i, name] of STRYKER_PACKAGES.entries()) {
      expect(versionRangeVerdict(locked[i], manifest.devDependencies[name], name).verdict).toBe('ok');
    }
  });

  test('Stryker finds no configuration of its own in this checkout', () => {
    // The pilot config's name is deliberately not one Stryker discovers, so a
    // bare `npx stryker run` cannot start a whole-repository pass.
    for (const name of ['stryker.conf.json', 'stryker.conf.js', 'stryker.config.json', 'stryker.config.mjs', 'stryker.config.js']) {
      expect(existsSync(join(ROOT, name))).toBe(false);
    }
    expect(existsSync(join(ROOT, 'stryker.pilot.config.mjs'))).toBe(true);
    expect(manifest.stryker).toBeUndefined();
  });

  test('raw reports are gitignored — as Git decides it, not as a line in .gitignore reads', () => {
    // Asked of Git in this very checkout, because that is the only thing that
    // applies re-inclusion rules and the index. A `.gitignore` holding
    // `.mutation/` followed by `!.mutation/` matches a line and still leaves
    // the reports committable.
    const reportPaths = rawReportPaths('.mutation');
    const ignoredPaths = gitIgnoredPaths(reportPaths, { cwd: ROOT });
    expect(ignoredPaths).not.toBeNull();
    const finding = reportsIgnoredFinding({ out: '.mutation', reportPaths, ignoredPaths });
    expect(finding).toEqual({ check: 'reports-ignored', ok: true, detail: expect.any(String) });
    // Every mode writes a directory, and every raw artifact in it carries
    // mutated source or absolute host paths; none may be left out of the check.
    expect(REPORT_LABELS).toEqual(['dry-run', 'smoke', 'pilot']);
    for (const label of REPORT_LABELS) {
      for (const file of RAW_ARTIFACTS) expect(reportPaths).toContain(`.mutation/${label}/${file}`);
    }
    expect(RAW_ARTIFACTS).not.toContain('summary.json');
    expect(RAW_ARTIFACTS).not.toContain('summary.md');
    // The incremental state is a full mutation report and lives in a directory
    // of its own inside each mode's report directory; git decides per path, so a
    // checkout whose rules reach `.mutation/pilot/` but not that directory would
    // pass a check that left it out.
    //
    // And the path asked about is the REAL one — the digest name that mode's own
    // configuration produces — not a placeholder inside that directory.
    // `git check-ignore` answers per exact pathname, so a `.gitignore` that
    // re-included the deterministic digest name while leaving a placeholder
    // ignored would pass this check with a source-bearing report committable.
    //
    // Each mode's scope is spelled out here rather than taken from `scopeFor`,
    // and it is that scope — for `dry-run` and `pilot` the frozen #1112 ranges,
    // not the configuration's whole-file default — that names the file those
    // modes really write.
    for (const label of REPORT_LABELS) {
      const real = pilotStrykerConfig(
        label === 'smoke'
          ? { out: '.mutation', label, mutate: SMOKE_MUTATE, testFiles: SMOKE_TESTS }
          : { out: '.mutation', label, mutate: BASELINE_MUTATE, testFiles: PILOT_TESTS },
      ).incrementalFile;
      expect(real).toMatch(new RegExp(`^\\.mutation/${label}/${INCREMENTAL_DIR}/[0-9a-f]{16}\\.json$`));
      expect(reportPaths).toContain(real);
    }
    expect(reportPaths.some((path) => path.endsWith('probe.json'))).toBe(false);
    // The sandbox is a copy of the source tree and lives outside every report
    // directory, so it needs naming on its own.
    expect(reportPaths).toContain(`.mutation/${TEMP_DIR_NAME}/${SANDBOX_PREFIX}probe/package.json`);
    // The sandbox probe must carry the prefix Stryker really uses: a rule
    // written as `sandbox-*` does not match a bare `sandbox/`, so asking about
    // that name would certify a checkout that commits the copied source.
    expect(reportPaths.some((path) => path.includes(`/${SANDBOX_PREFIX}`))).toBe(true);
    expect(reportPaths).not.toContain(`.mutation/${TEMP_DIR_NAME}/sandbox/package.json`);
    // Not one representative file: every scoped source and test file is asked
    // about inside the sandbox too, so a rule that names only the manifest
    // (or a later `!*.ts`) cannot pass with the copied source committable.
    for (const file of DEFAULT_SANDBOX_FILES) {
      expect(reportPaths).toContain(`.mutation/${TEMP_DIR_NAME}/${SANDBOX_PREFIX}probe/${file}`);
    }
    expect(DEFAULT_SANDBOX_FILES).toEqual(expect.arrayContaining(['src/core/tool-request-grant.ts', ...PILOT_TESTS]));
    // The preflight passes the checkout's tracked files; each is restated.
    const tracked = trackedFiles({ cwd: ROOT });
    expect(tracked).toEqual(expect.arrayContaining(['package.json', 'src/core/chain-linear.ts']));
    const everyFile = rawReportPaths('.mutation', { sandboxFiles: tracked });
    for (const file of tracked) expect(everyFile).toContain(`.mutation/${TEMP_DIR_NAME}/${SANDBOX_PREFIX}probe/${file}`);
    expect(reportsIgnoredFinding({ out: '.mutation', reportPaths: everyFile, ignoredPaths: gitIgnoredPaths(everyFile, { cwd: ROOT }) }).ok).toBe(true);
    // A checkout that ignores the probed manifest but re-includes source files
    // fails: the exposed sandbox source is named, not certified.
    const source = `.mutation/${TEMP_DIR_NAME}/${SANDBOX_PREFIX}probe/src/core/chain-linear.ts`;
    const partial = reportsIgnoredFinding({ out: '.mutation', reportPaths, ignoredPaths: reportPaths.filter((path) => path !== source) });
    expect(partial.ok).toBe(false);
    expect(partial.detail).toContain(source);
    // Files only. A directory-only pattern matches a bare `.mutation` just when
    // git can see it IS a directory, and at preflight time it does not exist
    // yet — asking about it would fail a correctly ignored checkout.
    for (const path of reportPaths) expect(path).toMatch(/\.mutation\/.+\.[a-z]+$/);
  }, 30_000);

  test('the sandbox files asked about are the ones Stryker copies, untracked files included', async () => {
    // Stryker walks the file system, not Git's index: an untracked file lands in
    // the sandbox too, and `git ls-files` never names it. Under selective rules
    // that leave such a copy committable, a tracked-files-only probe certified
    // the checkout; the files Stryker's own reader enumerates do not.
    const dir = mkdtempSync(join(tmpdir(), 'mutation-pilot-inputs-'));
    const cwd = process.cwd();
    try {
      execFileSync('git', ['init', '-q'], { cwd: dir });
      mkdirSync(join(dir, 'src'));
      writeFileSync(join(dir, 'src', 'kept.ts'), 'export {};\n');
      writeFileSync(join(dir, 'notes.txt'), 'untracked scratch\n');
      mkdirSync(join(dir, 'node_modules'));
      writeFileSync(join(dir, 'node_modules', 'dep.js'), '\n');
      // Everything under `.mutation` is ignored except `.txt` files.
      writeFileSync(join(dir, '.gitignore'), ['node_modules/', '.mutation/**', '!.mutation/**/', '!.mutation/**/*.txt', ''].join('\n'));
      execFileSync('git', ['add', '.gitignore', 'src/kept.ts'], { cwd: dir });

      const config = pilotStrykerConfig({ out: '.mutation' });
      const inputs = await sandboxInputFiles(config, { cwd: dir });
      expect(process.cwd()).toBe(cwd);
      expect(inputs).toEqual(expect.arrayContaining(['.gitignore', 'src/kept.ts', 'notes.txt']));
      // Stryker's own ignore rules still apply.
      expect(inputs.some((file) => file.startsWith('node_modules/') || file.startsWith('.git/'))).toBe(false);

      const copied = `.mutation/${TEMP_DIR_NAME}/${SANDBOX_PREFIX}probe/notes.txt`;
      const tracked = trackedFiles({ cwd: dir });
      expect(tracked).not.toContain('notes.txt');
      const trackedOnly = rawReportPaths('.mutation', { sandboxFiles: tracked });
      expect(trackedOnly).not.toContain(copied);
      expect(reportsIgnoredFinding({ out: '.mutation', reportPaths: trackedOnly, ignoredPaths: gitIgnoredPaths(trackedOnly, { cwd: dir }) }).ok).toBe(true);

      const reportPaths = rawReportPaths('.mutation', { sandboxFiles: inputs });
      expect(reportPaths).toContain(copied);
      const finding = reportsIgnoredFinding({ out: '.mutation', reportPaths, ignoredPaths: gitIgnoredPaths(reportPaths, { cwd: dir }) });
      expect(finding.ok).toBe(false);
      expect(finding.detail).toContain(copied);

      // Without Stryker's reader there is no answer, and the working directory is restored.
      const failing = () => {
        throw new Error('not installed');
      };
      await expect(sandboxInputFiles(config, { cwd: dir, exec: failing })).resolves.toBeNull();
      expect(process.cwd()).toBe(cwd);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test('the files the sandbox build writes are asked about, not only the ones copied in', () => {
    // A stale sandbox keeps the instrumented `dist/**/*.js` the build emitted,
    // and no reader of the checkout ever lists it: the probe must name it.
    expect(projectBuildLayout(ROOT)).toEqual({ rootDir: 'src', outDir: 'dist' });
    expect(sandboxProbeFiles(['package.json', 'src/core/chain-linear.ts', 'src/types.d.ts', 'test/x.test.js'])).toEqual([
      'package.json',
      'src/core/chain-linear.ts',
      'src/types.d.ts',
      'test/x.test.js',
      'dist/core/chain-linear.js',
    ]);
    const reportPaths = rawReportPaths('.mutation');
    const emitted = `.mutation/${TEMP_DIR_NAME}/${SANDBOX_PREFIX}probe/dist/core/tool-request-grant.js`;
    expect(reportPaths).toContain(emitted);
    // A checkout whose rules re-include that emitted file fails, with it named.
    const finding = reportsIgnoredFinding({ out: '.mutation', reportPaths, ignoredPaths: reportPaths.filter((path) => path !== emitted) });
    expect(finding.ok).toBe(false);
    expect(finding.detail).toContain(emitted);
    // And this checkout's own rules do cover every emitted file.
    const tracked = rawReportPaths('.mutation', { sandboxFiles: trackedFiles({ cwd: ROOT }), buildLayout: projectBuildLayout(ROOT) });
    expect(tracked).toContain(`.mutation/${TEMP_DIR_NAME}/${SANDBOX_PREFIX}probe/dist/core/chain-linear.js`);
    expect(reportsIgnoredFinding({ out: '.mutation', reportPaths: tracked, ignoredPaths: gitIgnoredPaths(tracked, { cwd: ROOT }) }).ok).toBe(true);
  }, 30_000);

  test('the incremental path the preflight asks Git about follows the invocation’s own settings', () => {
    // The name is a digest of the run's identity, so an operator who reruns with
    // a different deadline writes a DIFFERENT file. A check pinned to one name
    // would then certify a path this invocation does not write.
    const base = parseArgs(['--pilot'], { parallelism: 8 });
    const slower = parseArgs(['--pilot', '--timeout-ms', '5000'], { parallelism: 8 });
    expect(incrementalFileForMode('pilot', { out: '.mutation', run: slower })).not.toBe(
      incrementalFileForMode('pilot', { out: '.mutation', run: base }),
    );
    expect(rawReportPaths('.mutation', { run: slower })).toContain(
      incrementalFileForMode('pilot', { out: '.mutation', run: slower }),
    );
    // Same for `--concurrency`, which the options always carry: a rerun at
    // another worker count writes a different file, and the check must ask Git
    // about that one.
    const crowded = parseArgs(['--pilot', '--concurrency', '8'], { parallelism: 8 });
    expect(incrementalFileForMode('pilot', { out: '.mutation', run: crowded })).not.toBe(
      incrementalFileForMode('pilot', { out: '.mutation', run: base }),
    );
    expect(rawReportPaths('.mutation', { run: crowded })).toContain(
      incrementalFileForMode('pilot', { out: '.mutation', run: crowded }),
    );
    // Each mode's own scope decides its digest — the smoke directory never holds
    // the pilot selection's file name.
    expect(incrementalFileForMode('smoke', { out: '.mutation', run: base })).toBe(
      pilotStrykerConfig({ out: '.mutation', label: 'smoke', mutate: SMOKE_MUTATE, testFiles: SMOKE_TESTS }).incrementalFile,
    );
    // The settings this check forwards are read from the identity itself, so a
    // verdict-affecting setting added later reaches the probed path too rather
    // than being silently left at a default the run does not use.
    for (const key of SCOPE_IDENTITY_KEYS) expect(INCREMENTAL_IDENTITY_KEYS).toContain(key);
    expect(INCREMENTAL_IDENTITY_KEYS.filter((key) => !SCOPE_IDENTITY_KEYS.includes(key))).toEqual([
      'coverageAnalysis',
      'timeoutMs',
      'timeoutFactor',
      'concurrency',
      'jestConfig',
      'toolchain',
    ]);
    // A setting the options do not carry falls through to the configuration's
    // own default, which is what the run spec leaves to it as well; one they do
    // carry — `concurrency` always resolves, even without the flag — reaches the
    // probed path instead of that default.
    expect(base.timeoutFactor).toBeUndefined();
    expect(base.concurrency).toBe(2);
    // The scope half of the identity is the pilot mode's own — the frozen #1112
    // ranges — not the whole files a bare `stryker run` would mutate.
    expect(incrementalFileForMode('pilot', { out: '.mutation', run: base })).toBe(
      pilotStrykerConfig({
        out: '.mutation',
        label: 'pilot',
        mutate: BASELINE_MUTATE,
        testFiles: PILOT_TESTS,
        concurrency: base.concurrency,
      }).incrementalFile,
    );
    expect(incrementalFileForMode('pilot', { out: '.mutation', run: crowded })).toBe(
      pilotStrykerConfig({
        out: '.mutation',
        label: 'pilot',
        mutate: BASELINE_MUTATE,
        testFiles: PILOT_TESTS,
        concurrency: 8,
      }).incrementalFile,
    );
  });

  test('a report directory belongs to one run, so nothing is read back from the previous one', () => {
    // The driver clears these before it starts Stryker. Without that, a run that
    // died early would be summarized — and given a smoke verdict — from the last
    // run's report, publishing a result this run never produced.
    expect(STALE_ARTIFACTS).toEqual(['mutation.json', 'mutation.html', 'build.json', 'summary.json', 'summary.md']);
  });
});

describe('sandbox build wrapper', () => {
  const tsconfig = JSON.parse(readFileSync(join(ROOT, 'tsconfig.json'), 'utf8'));
  const emitted = { source: 'src/core/tool-request-grant.ts', dist: 'dist/core/tool-request-grant.js', present: true, instrumented: true };

  test('the mutated sources come from the run spec, with any line range stripped', () => {
    expect(mutatedSources({ mutate: SMOKE_MUTATE })).toEqual(['src/core/tool-request-grant.ts']);
    expect(mutatedSources({ mutate: ['src/core/a.ts:1-2', 'src/core/a.ts:9-10'] })).toEqual(['src/core/a.ts']);
    // No spec at all is a bare `stryker run`, which is the full pilot scope.
    expect(mutatedSources({})).toEqual(PILOT_MUTATE);
    expect(mutatedSources(undefined)).toEqual(PILOT_MUTATE);
  });

  test('the output layout is read from tsconfig rather than guessed', () => {
    expect(outputLayout(tsconfig)).toEqual({ rootDir: 'src', outDir: 'dist' });
    // Guessing src/dist would let the check quietly inspect the wrong file.
    expect(() => outputLayout({ compilerOptions: { rootDir: 'src' } })).toThrow(/rootDir and compilerOptions\.outDir/);
    expect(() => outputLayout({})).toThrow(/rootDir and compilerOptions\.outDir/);
  });

  test('each mutated source maps to the compiled file the tests actually import', () => {
    const layout = outputLayout(tsconfig);
    expect(distPathFor('src/core/tool-request-grant.ts', layout)).toBe('dist/core/tool-request-grant.js');
    for (const source of PILOT_MUTATE) expect(distPathFor(source, layout)).toMatch(/^dist\/.+\.js$/);
    expect(() => distPathFor('scripts/mutation-build.mjs', layout)).toThrow(/not under rootDir/);
  });

  test('a mutated source that did not reach the executed JavaScript fails the build', () => {
    // Without this check the run would complete with every mutant surviving,
    // which is indistinguishable from weak tests — the misreading this pilot
    // must never publish.
    const missing = buildVerdict({ exitCode: 0, outputs: [{ ...emitted, present: false, instrumented: false }] });
    expect(missing.ok).toBe(false);
    expect(missing.reasons[0]).toMatch(/emitted no JavaScript/);
    const uninstrumented = buildVerdict({ exitCode: 0, outputs: [{ ...emitted, instrumented: false }] });
    expect(uninstrumented.ok).toBe(false);
    expect(uninstrumented.reasons[0]).toContain(INSTRUMENTATION_MARKER);
  });

  test('a type error in the instrumented tree is a warning once the emit is proven', () => {
    // Stryker's own instrumentation does not type-check, and tsc exits 2 on a
    // diagnostic whatever --noEmitOnError says.
    const verdict = buildVerdict({ exitCode: 2, outputs: [emitted] });
    expect(verdict.ok).toBe(true);
    expect(verdict.reasons).toEqual([]);
    expect(verdict.warnings[0]).toMatch(/tsc exited 2/);
    expect(buildVerdict({ exitCode: 0, outputs: [emitted] }).warnings).toEqual([]);
  });

  test('a compiler that never ran, or a build that proves nothing, is never accepted', () => {
    expect(buildVerdict({ exitCode: null, spawnError: 'spawn ENOENT', outputs: [emitted] }).ok).toBe(false);
    expect(buildVerdict({ exitCode: null, signal: 'SIGKILL', outputs: [emitted] }).ok).toBe(false);
    const nothing = buildVerdict({ exitCode: 0, outputs: [] });
    expect(nothing.ok).toBe(false);
    expect(nothing.reasons[0]).toMatch(/proves nothing/);
  });

  test('compiler output is recorded as bounded counts, never as text', () => {
    const output = [
      "src/core/tool-request-grant.ts(44,3): error TS2630: Cannot assign to 'stryNS_9fa48' because it is a function.",
      'src/core/tool-request-grant.ts(118,77): error TS2554: Expected 0 arguments, but got 1.',
      'src/core/tool-request-grant.ts(120,68): error TS2554: Expected 0 arguments, but got 1.',
      '',
    ].join('\n');
    const diagnostics = countDiagnostics(output);
    expect(diagnostics).toEqual({ lines: 3, codes: { TS2554: 2, TS2630: 1 }, omittedCodes: 0 });
    // Messages quote source text and sandbox paths; none of it may be recorded.
    expect(JSON.stringify(diagnostics)).not.toMatch(/stryNS|tool-request-grant/);
    expect(countDiagnostics('')).toEqual({ lines: 0, codes: {}, omittedCodes: 0 });
  });

  test('the build record is masked before it reaches the summary', () => {
    // The wrapper writes repo-relative paths; a spawn error's message comes
    // from the OS and can still name an absolute one.
    const masked = sanitizeBuildRecord(
      {
        tsc: { exitCode: null, signal: null, diagnostics: { lines: 0, codes: {}, omittedCodes: 0 } },
        outputs: [{ source: '/checkout/src/core/a.ts', dist: 'dist/core/a.js', present: true, instrumented: true }],
        reasons: ['spawnSync /checkout/node_modules/typescript/bin/tsc ENOENT'],
        warnings: [],
      },
      { root: '/checkout' },
    );
    expect(masked.outputs[0].source).toBe('src/core/a.ts');
    expect(masked.reasons[0]).toBe('spawnSync ./node_modules/typescript/bin/tsc ENOENT');
    expect(sanitizeBuildRecord(null)).toBeNull();
  });

  test('a long compiler dump is truncated before it reaches a log', () => {
    const dump = Array.from({ length: 30 }, (_, i) => `error line ${i}`).join('\n');
    expect(boundOutput(dump, 5).split('\n')).toHaveLength(6);
    expect(boundOutput(dump, 5)).toContain('25 more line(s) omitted');
    expect(boundOutput('one line', 5)).toBe('one line');
  });
});

describe('driver argument handling', () => {
  test('preflight is the default, and every bound has a conservative default', () => {
    const options = parseArgs([], { parallelism: 8 });
    expect(options).toEqual({
      mode: 'preflight',
      concurrency: 2,
      timeoutMs: 60_000,
      maxRuntimeMin: 180,
      coverageAnalysis: 'off',
      out: '.mutation',
      incremental: false,
      background: false,
      report: false,
    });
  });

  test('a single-core host never gets a concurrency of 2', () => {
    expect(parseArgs([], { parallelism: 1 }).concurrency).toBe(1);
  });

  test('each mode is selected by its own flag', () => {
    for (const mode of ['preflight', 'dry-run', 'smoke', 'pilot']) {
      expect(parseArgs([`--${mode}`], { parallelism: 4 }).mode).toBe(mode);
    }
  });

  test('concurrency cannot oversubscribe the host', () => {
    expect(parseArgs(['--concurrency', '3'], { parallelism: 8 }).concurrency).toBe(3);
    expect(() => parseArgs(['--concurrency', '9'], { parallelism: 8 })).toThrow(/invalid --concurrency: 9 \(1-8\)/);
    expect(() => parseArgs(['--concurrency', '0'], { parallelism: 8 })).toThrow(/invalid --concurrency/);
  });

  test('bad input is refused rather than guessed at', () => {
    expect(() => parseArgs(['--smoke', '--pilot'], { parallelism: 4 })).toThrow(/more than one mode/);
    expect(() => parseArgs(['--whole-repo'], { parallelism: 4 })).toThrow(/missing value for --whole-repo/);
    expect(() => parseArgs(['--whole-repo', 'yes'], { parallelism: 4 })).toThrow(/unknown argument: --whole-repo/);
    expect(() => parseArgs(['--coverage-analysis', 'maybe'], { parallelism: 4 })).toThrow(/invalid --coverage-analysis/);
  });

  test('a dry run gets a smaller default budget, which an explicit one overrides', () => {
    // A Stryker that did not honour `dryRunOnly` would otherwise turn a dry run
    // into a full mutation run; the budget bounds that to half an hour.
    expect(parseArgs(['--dry-run'], { parallelism: 4 }).maxRuntimeMin).toBe(DRY_RUN_BUDGET_MIN);
    expect(parseArgs(['--dry-run', '--max-runtime-min', '90'], { parallelism: 4 }).maxRuntimeMin).toBe(90);
    expect(parseArgs(['--pilot'], { parallelism: 4 }).maxRuntimeMin).toBe(180);
  });

  test('a dry run asks for one worker, because it has one test run to give out', () => {
    // Stryker starts every worker up front; for a run that activates no mutant
    // the second one is started, handed a sandbox and never used.
    expect(parseArgs(['--dry-run'], { parallelism: 8 }).concurrency).toBe(1);
    expect(parseArgs(['--dry-run', '--concurrency', '4'], { parallelism: 8 }).concurrency).toBe(4);
    expect(parseArgs(['--smoke'], { parallelism: 8 }).concurrency).toBe(2);
  });

  test('the budget and coverage analysis are explicit options', () => {
    const options = parseArgs(['--pilot', '--max-runtime-min', '45', '--coverage-analysis', 'perTest', '--incremental'], { parallelism: 4 });
    expect(options).toMatchObject({ mode: 'pilot', maxRuntimeMin: 45, coverageAnalysis: 'perTest', incremental: true });
  });

  test('a dry run estimates the scope the pilot would actually run', () => {
    expect(scopeFor('dry-run')).toEqual({ label: 'dry-run', mutate: BASELINE_MUTATE, testFiles: PILOT_TESTS });
    expect(scopeFor('smoke')).toEqual({ label: 'smoke', mutate: SMOKE_MUTATE, testFiles: SMOKE_TESTS });
    expect(scopeFor('pilot')).toEqual({ label: 'pilot', mutate: BASELINE_MUTATE, testFiles: PILOT_TESTS });
    // The dry run is what says how many mutants the pilot must test, so the two
    // scopes have to be the same one. A wider dry run projects a cost nobody
    // pays; a narrower one understates the run that is about to start.
    expect(scopeFor('dry-run').mutate).toEqual(scopeFor('pilot').mutate);
    expect(scopeFor('dry-run').testFiles).toEqual(scopeFor('pilot').testFiles);
  });

  test('a detached start and a read-back are separate, exclusive requests', () => {
    expect(parseArgs(['--dry-run', '--background'], { parallelism: 4 })).toMatchObject({ background: true, report: false });
    expect(parseArgs(['--dry-run', '--report'], { parallelism: 4 })).toMatchObject({ background: false, report: true });
    // `--report` reads a directory `--background` clears. One invocation cannot
    // be both without one of them destroying what the other is for.
    expect(() => parseArgs(['--pilot', '--background', '--report'], { parallelism: 4 })).toThrow(/cannot be combined/);
  });

  test('preflight takes neither modifier, because it runs nothing to detach from', () => {
    expect(() => parseArgs(['--preflight', '--background'], { parallelism: 4 })).toThrow(/--preflight does not support --background/);
    expect(() => parseArgs(['--preflight', '--report'], { parallelism: 4 })).toThrow(/--preflight does not support --report/);
    // The default mode is preflight, so a bare modifier is refused the same way.
    expect(() => parseArgs(['--background'], { parallelism: 4 })).toThrow(/--preflight does not support/);
  });
});

describe('a run detached from the console that started it', () => {
  const state = { mode: 'dry-run', label: 'dry-run', runId: 'r1', pid: 4242, startedAtMs: 1_000, budgetMs: 60_000, log: '.mutation/dry-run/run.log' };

  test('the detached copy is handed this run\'s resolved options, not the defaults again', () => {
    // `--dry-run` alone resolves to a 30-minute budget and one worker. If the
    // start passed only `--dry-run` those defaults would be re-derived rather
    // than carried, and an explicit `--concurrency 4` would silently become 1.
    const options = parseArgs(['--dry-run', '--concurrency', '4'], { parallelism: 8 });
    expect(backgroundArgs(options)).toEqual([
      '--dry-run',
      '--concurrency', '4',
      '--timeout-ms', '60000',
      '--max-runtime-min', String(DRY_RUN_BUDGET_MIN),
      '--coverage-analysis', 'off',
      '--out', '.mutation',
    ]);
    // Whatever it is handed must parse back to the same run.
    expect(parseArgs(backgroundArgs(options), { parallelism: 8 })).toMatchObject({ mode: 'dry-run', concurrency: 4, maxRuntimeMin: DRY_RUN_BUDGET_MIN });
  });

  test('the detached copy records its own run state, so a start killed before writing it leaves a reportable run', () => {
    // The start spawns the copy, then writes `run-state.json`. A SIGTERM/SIGKILL
    // between the two leaves a copy that adopts the lock and completes with no
    // state file — and `--report` then ignores even its matching summary. The
    // copy writing the record itself closes that window.
    const dir = mkdtempSync(join(tmpdir(), 'mutation-state-'));
    try {
      const statePath = join(dir, RUN_STATE);
      const options = parseArgs(['--dry-run'], { parallelism: 4 });
      const scope = { label: 'dry-run' };
      const own = backgroundRunState({ options, scope, runId: 'r1', pid: 4242, pidStart: 'stamp', startedAtMs: 1_000, budgetMs: 60_000 });
      expect(own).toEqual({
        mode: 'dry-run',
        label: 'dry-run',
        runId: 'r1',
        pid: 4242,
        pidStart: 'stamp',
        startedAt: new Date(1_000).toISOString(),
        startedAtMs: 1_000,
        budgetMs: 60_000,
        log: `.mutation/dry-run/${RUN_LOG}`,
        args: backgroundArgs(options),
      });
      // No record at all: the start died first. The copy writes it.
      expect(recoverRunState(statePath, own)).toBe(true);
      expect(JSON.parse(readFileSync(statePath, 'utf8'))).toEqual(own);
      const recorded = classifyBackgroundRun({ state: JSON.parse(readFileSync(statePath, 'utf8')), alive: false, summaryPresent: true, now: 2_000 });
      expect(recorded.status).toBe('finished');
      // The start's own record already landed: left as it is.
      const fromStart = { ...own, startedAtMs: 900 };
      writeFileSync(statePath, JSON.stringify(fromStart));
      expect(recoverRunState(statePath, own)).toBe(false);
      expect(JSON.parse(readFileSync(statePath, 'utf8'))).toEqual(fromStart);
      // A leftover naming another run is not this run's record: replaced.
      writeFileSync(statePath, JSON.stringify({ ...own, runId: 'older' }));
      expect(recoverRunState(statePath, own)).toBe(true);
      expect(JSON.parse(readFileSync(statePath, 'utf8')).runId).toBe('r1');
      // An unreadable one (a start killed mid-write) is replaced too.
      writeFileSync(statePath, '{"runId": "r');
      expect(recoverRunState(statePath, own)).toBe(true);
      expect(JSON.parse(readFileSync(statePath, 'utf8'))).toEqual(own);
      expect(readdirSync(dir)).toEqual([RUN_STATE]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the detached copy is never itself a start, so a start cannot recurse', () => {
    const args = backgroundArgs(parseArgs(['--pilot', '--incremental'], { parallelism: 4 }));
    expect(args).toContain('--incremental');
    expect(args).not.toContain('--background');
    expect(args).not.toContain('--report');
  });

  test('a live run inside its budget is still going, and that is not a failure', () => {
    const run = classifyBackgroundRun({ state, alive: true, summaryPresent: false, now: 61_000 });
    expect(run).toEqual({ status: 'running', elapsedMs: 60_000 });
    // Exit zero: the caller is meant to come back, not to treat this as a result.
    expect(renderBackgroundReport(run, { label: 'dry-run', mode: 'dry-run', startCommand: 's', reportCommand: 'r' }).ok).toBe(true);
  });

  test('a live run past its own budget is stuck, not merely slow', () => {
    // The driver enforces `budgetMs` on its Stryker group and then writes a
    // summary. Still alive well past that with nothing written means it is stuck
    // somewhere the budget does not cover, which must not read as progress.
    const inGrace = classifyBackgroundRun({ state, alive: true, summaryPresent: false, now: 1_000 + 60_000 + BACKGROUND_GRACE_MS });
    expect(inGrace.status).toBe('running');
    const past = classifyBackgroundRun({ state, alive: true, summaryPresent: false, now: 1_000 + 60_000 + BACKGROUND_GRACE_MS + 1 });
    expect(past.status).toBe('overdue');
    expect(renderBackgroundReport(past, { label: 'dry-run', mode: 'dry-run', startCommand: 's', reportCommand: 'r' }).ok).toBe(false);
  });

  test('a run that died leaving no summary yields no conclusion about the tests', () => {
    const run = classifyBackgroundRun({ state, alive: false, summaryPresent: false, now: 5_000 });
    expect(run.status).toBe('lost');
    const rendered = renderBackgroundReport(run, { label: 'dry-run', mode: 'dry-run', startCommand: 's', reportCommand: 'r' });
    expect(rendered.ok).toBe(false);
    // The same refusal `smokeVerdict` makes: a harness failure is never reported
    // as a statement about the pilot suites.
    expect(rendered.line).toMatch(/no conclusion about the tests/);
  });

  test('the summary a report reads as finished is the last thing written', () => {
    // `summary.json` is what makes a run `finished` above, and a report that says
    // so goes on to print `summary.md`. Written in the other order, a `:report`
    // polling between the two writes announces a finished run and prints no
    // report at all; and a Markdown write that then failed would leave the JSON
    // answering "finished, passed" for good from evidence nobody can read.
    const written = [];
    publishSummary('/reports/dry-run', { mode: 'dry-run' }, {
      write: (path, contents) => written.push([path, contents]),
      render: () => '# rendered\n',
    });
    expect(written.map(([path]) => path)).toEqual(['/reports/dry-run/summary.md', '/reports/dry-run/summary.json']);
    expect(written[0][1]).toBe('# rendered\n');
    expect(JSON.parse(written[1][1])).toEqual({ mode: 'dry-run' });
    // A render that throws must take the completion marker with it: no JSON, so
    // the run reads as one that left no summary rather than as a passing one.
    const partial = [];
    expect(() => publishSummary('/reports/dry-run', { mode: 'dry-run' }, {
      write: (path, contents) => partial.push([path, contents]),
      render: () => { throw new Error('render failed'); },
    })).toThrow('render failed');
    expect(partial).toEqual([]);
  });

  test('a summary outranks the pid, because a finished run has already exited', () => {
    // The usual finish: the driver wrote its summary and is gone. Reading the
    // pid first would report that as `lost`.
    expect(classifyBackgroundRun({ state, alive: false, summaryPresent: true, now: 9_000 }).status).toBe('finished');
    expect(classifyBackgroundRun({ state, alive: true, summaryPresent: true, now: 9_000 }).status).toBe('finished');
  });

  test('nothing started is reported as nothing started, not as a failed run', () => {
    const run = classifyBackgroundRun({ state: null, alive: false, summaryPresent: false, now: 9_000 });
    expect(run).toEqual({ status: 'absent', elapsedMs: 0 });
    const rendered = renderBackgroundReport(run, { label: 'dry-run', mode: 'dry-run', startCommand: 'npm run mutation:dry-run:start', reportCommand: 'r' });
    expect(rendered.line).toContain('npm run mutation:dry-run:start');
    expect(rendered.line).not.toMatch(/tests|mutant/);
  });

  test('a clock that went backwards never reports a negative age', () => {
    expect(classifyBackgroundRun({ state, alive: true, summaryPresent: false, now: 0 }).elapsedMs).toBe(0);
  });

  test('the run id, not the presence of a file, is what makes a summary this run\'s', () => {
    // A later foreground run overwrites `summary.json` in the same directory.
    // Matching on presence alone would relay that run's result as this one's.
    expect(RUN_ID_ENV).toBe('MUTATION_PILOT_RUN_ID');
    const summaries = [{ environment: { runId: 'r1' } }, { environment: { runId: 'r2' } }, { environment: { runId: null } }, {}];
    const matches = summaries.map((summary) => summary.environment?.runId === state.runId);
    expect(matches).toEqual([true, false, false, false]);
  });

  test('the state and log live in the run\'s own gitignored report directory', () => {
    expect(RUN_STATE).toBe('run-state.json');
    expect(RUN_LOG).toBe('run.log');
    // Both carry absolute host paths, so both are raw artifacts the preflight
    // makes Git account for before anything writes them.
    expect(RAW_ARTIFACTS).toEqual(expect.arrayContaining([RUN_STATE, RUN_LOG]));
    // The start writes both, and the detached copy then clears the previous
    // run's artifacts. Were either in that list the child would delete the
    // record of its own run before it had written anything else.
    expect(STALE_ARTIFACTS).not.toContain(RUN_STATE);
    expect(STALE_ARTIFACTS).not.toContain(RUN_LOG);
  });

  test('the log tail a report prints is bounded and trimmed', () => {
    expect(MAX_LOG_TAIL_LINES).toBe(20);
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`);
    expect(tailLines(`${lines.join('\n')}\n\n`)).toEqual(lines.slice(30));
    expect(tailLines('only\n')).toEqual(['only']);
    expect(tailLines('')).toEqual([]);
    expect(tailLines('a\nb\nc', 2)).toEqual(['b', 'c']);
  });

  test('the log tail masks the log path it names, not only the lines it quotes', () => {
    // `--out` may be absolute, and the run state then records an absolute log
    // path. `--report` is the output meant to be shared, so naming the checkout
    // above masked lines would disclose exactly what masking them prevents.
    const paths = { root: '/home/op/checkout', home: '/home/op', tmp: '/tmp' };
    const block = renderLogTail('started in /home/op/checkout\ndone\n', {
      logPath: '/home/op/checkout/.mutation/dry-run/run.log',
      paths,
    });
    expect(block).toBe('\nlast 2 line(s) of .mutation/dry-run/run.log:\nstarted in .\ndone\n');
    expect(block).not.toContain('/home/op');
    // Nothing to quote produces no block at all, rather than an empty heading.
    expect(renderLogTail('', { logPath: '/home/op/checkout/.mutation/dry-run/run.log', paths })).toBe('');
  });

  test('the log tail masks an absolute --out outside the checkout, home and temp', () => {
    const paths = { root: '/home/op/checkout', home: '/home/op', tmp: '/tmp', output: '/mnt/private/mut' };
    const block = renderLogTail('sandbox /mnt/private/mut/stryker-tmp/sandbox-1 failed\n', {
      logPath: '/mnt/private/mut/dry-run/run.log',
      paths,
    });
    expect(block).toBe('\nlast 1 line(s) of <out>/dry-run/run.log:\nsandbox <out>/stryker-tmp/sandbox-1 failed\n');
    expect(block).not.toContain('/mnt/private');
  });

  test('a live owner blocks every other run, however stuck it is', () => {
    // Every mode clears a report directory, prunes sandboxes and then competes
    // for the same host, so ownership is taken over the checkout rather than
    // over one mode's directory or one `--out`: a smoke run started during a dry
    // run is exactly the collision a per-directory check cannot see.
    const holder = { ...state, background: true };
    const other = { pid: 99, runId: 'r2' };
    // A run past its own budget is stuck, not finished — its Stryker group is
    // still on the host burning the parallelism this slice must bound.
    // `classifyBackgroundRun` draws that distinction for a reader; the lock takes
    // no notice of it, because both of them are running.
    const stuck = 1_000 + 60_000 + BACKGROUND_GRACE_MS + 1;
    expect(classifyBackgroundRun({ state, alive: true, summaryPresent: false, now: 2_000 }).status).toBe('running');
    expect(classifyBackgroundRun({ state, alive: true, summaryPresent: false, now: stuck }).status).toBe('overdue');
    expect(lockBlocks(holder, { ...other, alive: true })).toBe(true);
    // An owner that is gone left the lock behind; the caller clears it and races
    // for the exclusive create again, which is what actually decides ownership.
    expect(lockBlocks(holder, { ...other, alive: false })).toBe(false);
    // No readable record is not "free": the caller settles that one by age.
    expect(lockBlocks(null, { ...other, alive: true })).toBe(false);
    expect(LOCK_WRITE_GRACE_MS).toBe(60_000);
  });

  test('a refused start names the holder and how to look at it', () => {
    const line = renderLockRefusal({ ...state, background: true }, { now: 61_000, liveness: 'driver' });
    expect(line).toContain('`dry-run` run already owns this checkout (pid 4242, 60 s elapsed)');
    expect(line).toContain('npm run mutation:dry-run:report');
    expect(line).toContain(RUN_LOCK_PATH);
    // A foreground holder has no recorded run to read back.
    const foreground = renderLockRefusal({ ...state, background: false }, { now: 61_000, liveness: 'driver' });
    expect(foreground).toContain('wait for it to finish');
    expect(foreground).not.toContain(':report');
    // Fail closed on a lock that says nothing, but say how to clear it — and say
    // nothing about the tests, because this is a harness refusal.
    const unreadable = renderLockRefusal(null, { now: 0 });
    expect(unreadable).toContain(RUN_LOCK_PATH);
    expect(unreadable).not.toMatch(/tests|mutant/);
  });

  test('a command printed for a custom --out run names that directory', () => {
    // `--report` reads the directory its own options name. An instruction that
    // drops the `--out` the run was started with therefore sends the operator to
    // the default `.mutation/<label>`, where that run has written nothing — the
    // printed command must act on the run being talked about.
    expect(pilotCommand('pilot', 'report')).toBe('npm run mutation:pilot:report');
    expect(pilotCommand('pilot', 'report', DEFAULT_OUT)).toBe('npm run mutation:pilot:report');
    expect(pilotCommand('dry-run', 'start', undefined)).toBe('npm run mutation:dry-run:start');
    // After `--`, which is how npm forwards arguments to the script itself.
    expect(pilotCommand('pilot', 'report', '.mutation/alternate')).toBe(
      'npm run mutation:pilot:report -- --out .mutation/alternate',
    );
    const posix = { platform: 'linux' };
    expect(pilotCommand('smoke', 'start', '/tmp/elsewhere', posix)).toBe('npm run mutation:smoke:start -- --out /tmp/elsewhere');
    // A path that needs quoting stays one argument.
    expect(pilotCommand('pilot', 'report', '/tmp/two words', posix)).toBe("npm run mutation:pilot:report -- --out '/tmp/two words'");
    expect(shellArg('.mutation', posix)).toBe('.mutation');
    expect(shellArg("it's here", posix)).toBe("'it'\\''s here'");
    expect(shellArg('', posix)).toBe("''");
  });

  test('a command printed on Windows is quoted for cmd.exe and PowerShell, not a POSIX shell', () => {
    // `cmd.exe` passes single quotes through literally, so a POSIX-quoted path
    // would name a directory with quote characters in it. Backslashes are path
    // separators there, and double quotes are the delimiter both shells accept.
    const win = { platform: 'win32' };
    expect(shellArg('C:\\work\\repo\\.mutation', win)).toBe('C:\\work\\repo\\.mutation');
    expect(pilotCommand('pilot', 'report', 'C:\\work\\repo\\.mutation\\alt', win)).toBe(
      'npm run mutation:pilot:report -- --out C:\\work\\repo\\.mutation\\alt',
    );
    expect(pilotCommand('dry-run', 'start', 'C:\\Users\\Jane Doe\\out', win)).toBe(
      'npm run mutation:dry-run:start -- --out "C:\\Users\\Jane Doe\\out"',
    );
    expect(shellArg("it's here", win)).toBe('"it\'s here"');
    expect(shellArg('', win)).toBe('""');
    for (const quoted of [shellArg('C:\\a b', win), shellArg('C:\\x\\y', win)]) expect(quoted).not.toContain("'");
  });

  test('a refused start points at the holder\'s own output directory', () => {
    // The lock records the refused run's `--out` precisely so this advice names
    // the report that exists. The lock file itself never moves with `--out`.
    const elsewhere = renderLockRefusal({ ...state, background: true, out: '.mutation/alternate' }, { now: 61_000, liveness: 'driver' });
    expect(elsewhere).toContain('npm run mutation:dry-run:report -- --out .mutation/alternate');
    expect(elsewhere).toContain(RUN_LOCK_PATH);
    // A record from a default run, or one written before `out` was recorded, still
    // gets the plain command rather than a mangled one.
    expect(renderLockRefusal({ ...state, background: true, out: undefined }, { now: 61_000, liveness: 'driver' })).toContain(
      'read it with `npm run mutation:dry-run:report`',
    );
  });

  test('a report names the directory it actually read', () => {
    const finished = renderBackgroundReport({ status: 'finished', elapsedMs: 1_000 }, {
      label: 'pilot',
      mode: 'pilot',
      reportDir: '.mutation/alternate/pilot',
      startCommand: 's',
      reportCommand: 'r',
    });
    expect(finished.line).toContain('.mutation/alternate/pilot/summary.md');
    // Default: the directory the default `--out` puts that label in.
    expect(
      renderBackgroundReport({ status: 'finished', elapsedMs: 1_000 }, { label: 'pilot', mode: 'pilot', startCommand: 's', reportCommand: 'r' }).line,
    ).toContain(`${DEFAULT_OUT}/pilot/summary.md`);
  });

  test('a refusal by a surviving Stryker group names the group, not the dead driver', () => {
    // There is no console reading this run and no `:report` worth offering: the
    // driver that would have written one is gone. What the caller needs is the
    // process group that is still using the host, and the fact that the lock
    // clears itself once that group exits.
    const orphaned = { ...state, background: true, strykerPid: 5150, strykerGroup: true };
    const line = renderLockRefusal(orphaned, { now: 61_000, liveness: 'group' });
    expect(line).toContain('driver is gone');
    expect(line).toContain('pid 5150');
    expect(line).toContain(RUN_LOCK_PATH);
    expect(line).not.toContain(':report');
    expect(line).not.toMatch(/tests|mutant/);
  });

  test('a Windows refusal names the surviving workers, not a process group that does not exist', () => {
    // `taskkill` reached the leader but a worker survived: `lockOwnerAlive` says
    // `group` on the worker's account, while the leader pid is dead. Naming only
    // that pid and advising a group stop would point the caller at nothing.
    const survived = {
      ...state,
      background: true,
      strykerPid: 5150,
      strykerGroup: false,
      strykerSurvivors: [{ pid: 6001, pidStart: 'a' }, { pid: 6002, pidStart: 'b' }, null],
    };
    const line = renderLockRefusal(survived, { now: 61_000, liveness: 'group' });
    expect(line).toContain('driver is gone');
    expect(line).toContain('6001, 6002 (left running when its kill gave up)');
    expect(line).toContain('5150 (leader, may already be gone)');
    expect(line).toContain('taskkill /PID <pid> /T /F');
    expect(line).toContain('5150, 6001, 6002');
    expect(line).not.toContain('process group');
    expect(line).toContain(RUN_LOCK_PATH);
    expect(line).not.toContain(':report');
  });

  test('the lock is one fixed file in the checkout, and --out cannot move it', () => {
    expect(RUN_LOCK).toBe('pilot.lock');
    expect(RUN_LOCK_PATH).toBe(`${RUN_LOCK_DIR}/${RUN_LOCK}`);
    // `--out` is a caller's argument. Were the lock taken under it, the default
    // run and `--out .mutation/alternate` would create two different lock files
    // and both would proceed — two Stryker runs on one host, which is the bound
    // this slice exists to keep. So the path does not move with `--out`, and the
    // preflight asks Git about it where it is really written.
    for (const out of ['.mutation', '.mutation/alternate', '/tmp/elsewhere']) {
      expect(rawReportPaths(out)).toContain(RUN_LOCK_PATH);
    }
    expect(STALE_ARTIFACTS).not.toContain(RUN_LOCK);
    // Clearing an abandoned lock and creating it again is a race two callers can
    // enter at once, so one attempt is not enough: the loser of the create must
    // get another pass, on which it sees the winner's live lock and is refused.
    expect(LOCK_ATTEMPTS).toBeGreaterThan(1);
  });

  test('the detached copy is not a second run competing with itself', () => {
    // The start takes the lock on behalf of the copy it is about to spawn, and
    // that copy then runs the same guard. Without this it would refuse to start
    // itself and no background run could ever begin — and what says so is the id
    // the start passed down in `RUN_ID_ENV`.
    expect(lockBlocks(state, { pid: 99, runId: 'r1', alive: true })).toBe(false);
    expect(isSelfRun(state, { pid: 99, runId: 'r1' })).toBe(true);
    expect(isSelfRun(state, { pid: 99, runId: 'other' })).toBe(false);
    // A recorded run id is the whole answer, and pid equality is not a second,
    // equally good identifier beside it: a driver killed outright leaves its
    // record behind while the Stryker group it started runs on, and the host is
    // free to hand that pid to the next invocation of this harness. Taking that
    // for "my own lock" would adopt a live run's lock and start a second Stryker
    // beside it. Every process that legitimately meets its own record knows the
    // id, so requiring it costs nothing.
    expect(isSelfRun(state, { pid: 4242, runId: undefined })).toBe(false);
    expect(isSelfRun(state, { pid: 4242, runId: 'recycled-pid-new-run' })).toBe(false);
    expect(lockBlocks(state, { pid: 4242, runId: undefined, alive: true })).toBe(true);
    // A foreground run records no id at all, and is identified by its pid; an
    // absent id must never match an absent `runId` on some other run's record and
    // silently claim to be it.
    expect(isSelfRun({ ...state, runId: undefined }, { pid: 4242, runId: undefined })).toBe(true);
    expect(isSelfRun({ ...state, runId: undefined }, { pid: 99, runId: undefined })).toBe(false);
    expect(isSelfRun({ ...state, runId: null }, { pid: 99, runId: null })).toBe(false);
    expect(isSelfRun(null, { pid: 4242, runId: 'r1' })).toBe(false);
  });

  test('a pid check never mistakes "not mine" for "gone"', () => {
    const gone = Object.assign(new Error('no such process'), { code: 'ESRCH' });
    const notMine = Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    expect(processAlive(1, () => undefined)).toBe(true);
    expect(processAlive(1, () => { throw gone; })).toBe(false);
    // EPERM means the process exists; treating it as gone would report a live
    // run as lost and invite a second one on top of it.
    expect(processAlive(1, () => { throw notMine; })).toBe(true);
    for (const pid of [0, -1, undefined, null, NaN, 1.5]) expect(processAlive(pid, () => undefined)).toBe(false);
  });

  test('a group check asks about the whole group, not only its leader', () => {
    // A negative pid addresses the group, which is what "the run is still on the
    // host" means: the Stryker leader can be gone while the workers it forked
    // still hold the CPUs and the sandbox.
    const targets = [];
    expect(processGroupAlive(4242, (target) => targets.push(target))).toBe(true);
    expect(targets).toEqual([-4242]);
    const gone = Object.assign(new Error('no such process'), { code: 'ESRCH' });
    expect(processGroupAlive(4242, () => { throw gone; })).toBe(false);
    for (const pgid of [0, -1, undefined, null, NaN, 1.5]) expect(processGroupAlive(pgid, () => undefined)).toBe(false);
  });

  test('a lock outlives the driver that took it while its Stryker group runs on', () => {
    // The finding this closes: the driver starts Stryker in its own process
    // group, so a SIGKILL or an OOM kill of the driver leaves that group running
    // with nobody to stop it or release the lock. Judging the lock by the
    // driver's pid alone would clear it and start a second run into the same
    // `stryker-tmp` the surviving group is still copying into.
    const dead = 4242;
    const group = 5150;
    // The driver is gone; the group it started — leader and workers — is not.
    const running = new Set([group, -group]);
    const kill = (target) => {
      if (running.has(target)) return undefined;
      throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
    };
    const holder = { mode: 'pilot', pid: dead, runId: 'r1', startedAtMs: 1_000, strykerPid: group, strykerGroup: true };
    expect(lockOwnerAlive(holder, kill)).toBe('group');
    expect(lockBlocks(holder, { pid: 99, runId: 'r2', alive: lockOwnerAlive(holder, kill) !== null })).toBe(true);
    // And it blocks however much the record resembles the process reading it: the
    // dead driver's pid can be recycled onto a new invocation, and a foreground
    // record carries no id to tell the two apart. A lock in this state is never
    // one waiting to be adopted — a start records no group, only a driver that has
    // already begun a run does — so it must be neither adopted nor cleared.
    expect(lockBlocks(holder, { pid: dead, runId: undefined, alive: true, liveness: 'group' })).toBe(true);
    expect(lockBlocks({ ...holder, runId: undefined }, { pid: dead, runId: undefined, alive: true, liveness: 'group' })).toBe(true);
    // A live driver is still the holder's own copy when the id matches.
    expect(lockBlocks(holder, { pid: 99, runId: 'r1', alive: true, liveness: 'driver' })).toBe(false);
    // A live driver is reported as the driver, whatever it recorded.
    expect(lockOwnerAlive({ ...holder, pid: group }, kill)).toBe('driver');
    // Once the group is gone too, nothing of the run is left and the lock is
    // abandoned — a killed run must not wedge the harness for good.
    expect(lockOwnerAlive(holder, () => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); })).toBe(null);
    // A record written before the run started names no group at all.
    expect(lockOwnerAlive({ ...holder, strykerPid: undefined, strykerGroup: false }, kill)).toBe(null);
    // On Windows `runTimed` starts no process group, so the leader's own pid is
    // the only thing that can be asked about.
    expect(lockOwnerAlive({ ...holder, strykerGroup: false }, kill)).toBe('group');
    expect(lockOwnerAlive(null, kill)).toBe(null);
  });

  test('a lock is held by the process it recorded, not by whatever wears its pid', () => {
    // The finding this closes: `kill(pid, 0)` answers about a number, and hosts
    // recycle numbers. A driver killed outright leaves its lock behind, and once
    // an unrelated process inherits that pid the lock would go on refusing every
    // start for as long as the stranger lives — the wedge stale-lock recovery
    // (`AGENTS.md`) exists to prevent.
    const driver = 4242;
    const group = 5150;
    const gone = Object.assign(new Error('no such process'), { code: 'ESRCH' });
    const killer = (running) => (target) => {
      if (running.has(target)) return undefined;
      throw gone;
    };
    const kill = killer(new Set([driver, group, -group]));
    const holder = {
      mode: 'pilot',
      pid: driver,
      pidStart: 'Mon Sep 15 09:00:00 2026',
      runId: 'r1',
      startedAtMs: 1_000,
      strykerPid: group,
      strykerPidStart: 'Mon Sep 15 09:00:05 2026',
      strykerGroup: true,
    };
    const asRecorded = (pid) => ({ [driver]: holder.pidStart, [group]: holder.strykerPidStart })[pid] ?? null;
    expect(lockOwnerAlive(holder, kill, asRecorded)).toBe('driver');

    // Both numbers still answer, but neither process was created when this
    // record says: the run is gone and the lock is abandoned, however busy its
    // pids look.
    const afterRecycle = (pid) => ({ [driver]: 'Tue Sep 16 11:30:00 2026', [group]: 'Tue Sep 16 11:30:02 2026' })[pid] ?? null;
    expect(processAlive(driver, kill)).toBe(true);
    expect(processGroupAlive(group, kill)).toBe(true);
    expect(lockOwnerAlive(holder, kill, afterRecycle)).toBe(null);
    expect(lockBlocks(holder, { pid: 99, runId: 'r2', alive: lockOwnerAlive(holder, kill, afterRecycle) !== null })).toBe(false);

    // The leader's number is gone while the group id still answers: those are
    // its orphaned workers and only they, because a host may not recycle a pid
    // while it is still in use as a process group id. That group holds the lock.
    expect(lockOwnerAlive(holder, killer(new Set([-group])), asRecorded)).toBe('group');

    // Unknown is never a refutation. A host that cannot report creation times
    // (Windows has no `ps`) and a record written without a stamp both fall back
    // to the numeric check, so a run that may still be live keeps its lock.
    expect(lockOwnerAlive(holder, kill, () => null)).toBe('driver');
    expect(lockOwnerAlive({ ...holder, pidStart: undefined, strykerPidStart: undefined }, kill, afterRecycle)).toBe('driver');
    // And an unstamped record is not probed at all — there is nothing to compare.
    const probed = [];
    expect(lockOwnerAlive({ ...holder, pidStart: null, strykerPidStart: null }, kill, (pid) => { probed.push(pid); return null; })).toBe('driver');
    expect(probed).toEqual([]);

    // On Windows the leader's own pid is the only thing that can be asked about,
    // and it is asked about the recorded process there too.
    const single = { ...holder, pid: 77, strykerGroup: false };
    expect(lockOwnerAlive(single, kill, asRecorded)).toBe('group');
    expect(lockOwnerAlive(single, kill, afterRecycle)).toBe(null);
  });

  test('a Windows lock stays held while a descendant outlives its leader', () => {
    // The finding this closes: on Windows there is no group id, and `taskkill`
    // can reach the leader while a worker survives. `runTimed` reports those
    // survivors, and a record naming only the dead leader would release the lock
    // beside the still-running worker and its sandbox.
    const gone = Object.assign(new Error('no such process'), { code: 'ESRCH' });
    const worker = 6001;
    const kill = (target) => {
      if (target === worker) return undefined;
      throw gone;
    };
    const holder = {
      mode: 'pilot',
      pid: 4242,
      runId: 'r1',
      strykerPid: 5150,
      strykerPidStart: null,
      strykerGroup: false,
      strykerSurvivors: [{ pid: worker, pidStart: 'Mon Sep 15 09:00:07 2026' }],
    };
    const asRecorded = (pid) => (pid === worker ? 'Mon Sep 15 09:00:07 2026' : null);
    expect(strykerGroupAlive(holder, kill, asRecorded)).toBe(true);
    expect(lockOwnerAlive(holder, kill, asRecorded)).toBe('group');
    // A survivor's number handed to a stranger does not hold the lock.
    expect(strykerGroupAlive(holder, kill, () => 'Tue Sep 16 11:30:00 2026')).toBe(false);
    // Nor does a survivor that has since exited.
    expect(strykerGroupAlive(holder, () => { throw gone; }, asRecorded)).toBe(false);
    // Malformed survivor lists are ignored, not trusted.
    expect(strykerGroupAlive({ ...holder, strykerSurvivors: 'x' }, kill, asRecorded)).toBe(false);
    expect(strykerGroupAlive({ ...holder, strykerSurvivors: [null, { pid: 'x' }] }, kill, asRecorded)).toBe(false);
  });

  test('a recorded process is gone once its pid belongs to something else', () => {
    const gone = Object.assign(new Error('no such process'), { code: 'ESRCH' });
    const kill = (target) => {
      if (target === 4242) return undefined;
      throw gone;
    };
    const stamp = 'Mon Sep 15 09:00:00 2026';
    expect(recordedProcessAlive(4242, stamp, kill, () => stamp)).toBe(true);
    expect(recordedProcessAlive(4242, stamp, kill, () => 'Tue Sep 16 11:30:00 2026')).toBe(false);
    // A probe that cannot answer must not retire a lock whose run may still be
    // going, and a record with no stamp is not probed at all.
    expect(recordedProcessAlive(4242, stamp, kill, () => null)).toBe(true);
    expect(recordedProcessAlive(4242, undefined, kill, () => { throw new Error('probed'); })).toBe(true);
    // A pid that does not exist is gone whatever a stamp would say.
    expect(recordedProcessAlive(77, stamp, kill, () => { throw new Error('probed'); })).toBe(false);
    expect(pidIdentity(4242, stamp, () => stamp)).toBe('match');
    expect(pidIdentity(4242, stamp, () => 'Tue Sep 16 11:30:00 2026')).toBe('recycled');
    expect(pidIdentity(4242, stamp, () => '')).toBe('unknown');
    expect(pidIdentity(4242, null, () => stamp)).toBe('unknown');
  });

  test('the creation-time probe answers about real pids, or says it cannot', () => {
    // Nothing is asked of the host about a number that is not a pid.
    for (const pid of [0, -1, undefined, null, NaN, 1.5]) expect(processStartedAt(pid)).toBe(null);
    // This process certainly exists, so a host that can answer does, with the
    // same answer every time — that stability is what makes it an identity. One
    // that cannot answer says null rather than guessing.
    const self = processStartedAt(process.pid);
    expect(self === null || (typeof self === 'string' && self.length > 0)).toBe(true);
    expect(processStartedAt(process.pid)).toBe(self);
  });

  test('the creation stamp does not depend on the time zone or locale of the invocation reading it', async () => {
    if (process.platform === 'win32') return;
    const self = processStartedAt(process.pid);
    if (self === null) return;
    // A second invocation under another zone and locale must read this live
    // process as the same one, or it would clear a live run's lock as recycled.
    const modulePath = join(ROOT, 'scripts', 'mutation-pilot.mjs');
    const script = `import(${JSON.stringify(modulePath)}).then((m) => process.stdout.write(String(m.processStartedAt(${process.pid}))))`;
    const other = execFileSync(process.execPath, ['-e', script], {
      encoding: 'utf8',
      env: { ...process.env, TZ: 'Pacific/Kiritimati', LANG: 'fr_FR.UTF-8', LC_ALL: 'fr_FR.UTF-8' },
    });
    expect(other).toBe(self);
    expect(PROCESS_STAMP_ENV).toEqual({ TZ: 'UTC', LC_ALL: 'C', LANG: 'C' });
  }, 30_000);

  test('Windows records are stamped too, so a recycled pid there cannot hold a lock forever', () => {
    // Without `ps`, every Windows record used to be unstamped, and an unstamped
    // record can never be refuted as recycled. CIM is asked instead, in UTC.
    const [file, args] = processStampCommand(4242, { platform: 'win32' });
    expect(file).toBe('powershell.exe');
    expect(args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-Command']);
    expect(args[3]).toContain("Win32_Process -Filter 'ProcessId=4242'");
    expect(args[3]).toContain("ToUniversalTime().ToString('o')");
    expect(processStampCommand(4242, { platform: 'darwin' })).toEqual(['ps', ['-o', 'lstart=', '-p', '4242']]);

    const calls = [];
    const exec = (cmd, cmdArgs) => {
      calls.push(cmd);
      return '2026-09-20T17:08:46.0330000Z\r\n';
    };
    const stamp = processStartedAt(4242, { platform: 'win32', exec });
    expect(calls).toEqual(['powershell.exe']);
    expect(stamp).toBe('2026-09-20T17:08:46.0330000Z');
    // The stamp now refutes a stranger on the recorded number.
    const recycled = () => '2026-09-21T01:00:00.0000000Z';
    expect(recordedProcessAlive(4242, stamp, () => true, recycled)).toBe(false);
    // A process CIM does not know prints nothing: "cannot say", never a guess.
    expect(processStartedAt(4242, { platform: 'win32', exec: () => '' })).toBe(null);
    expect(
      processStartedAt(4242, {
        platform: 'win32',
        exec: () => {
          throw new Error('powershell missing');
        },
      }),
    ).toBe(null);
  });

  test('host parallelism falls back to the CPU count where os.availableParallelism is missing (Node < 18.14)', () => {
    expect(hostParallelism({ cpus: () => [{}, {}, {}] })).toBe(3);
    expect(hostParallelism({ cpus: () => [] })).toBe(1);
    expect(hostParallelism({ availableParallelism: () => 5, cpus: () => [{}] })).toBe(5);
    // And the module never names the export statically, which on those Node
    // versions fails while the module links — before any fallback can run.
    const text = readFileSync(join(ROOT, 'scripts', 'mutation-pilot.mjs'), 'utf8');
    expect(text).not.toMatch(/import\s*\{[^}]*\bavailableParallelism\b[^}]*\}\s*from\s*'os'/);
  });

  test('a lock instance is identified by the run that stamped it', () => {
    const dead = { mode: 'pilot', pid: 4242, runId: 'r1', startedAtMs: 1_000 };
    expect(sameLockInstance(dead, { ...dead })).toBe(true);
    // A replacement written at the same path is a different instance, however
    // much of the record it shares — the start time alone settles it.
    expect(sameLockInstance(dead, { ...dead, startedAtMs: 1_001 })).toBe(false);
    expect(sameLockInstance(dead, { ...dead, pid: 4243 })).toBe(false);
    expect(sameLockInstance(dead, { ...dead, runId: 'r2' })).toBe(false);
    // A foreground run carries no run id; absent and null are the same absence.
    const foreground = { pid: 7, runId: null, startedAtMs: 5 };
    expect(sameLockInstance(foreground, { pid: 7, startedAtMs: 5 })).toBe(true);
    expect(sameLockInstance(null, dead)).toBe(false);
    expect(sameLockInstance(dead, null)).toBe(false);
  });
});

describe('clearing an abandoned lock', () => {
  // Stale-lock recovery on a real directory: removing the dead owner's file and
  // racing for the create again are two steps, and what happens at the path
  // between them is the whole question. See AGENTS.md — the single-worker lock
  // and its recovery may not be weakened without tests.
  let dir;
  let lockPath;
  let stealPath;
  const dead = { mode: 'pilot', pid: 4242, runId: 'r1', startedAtMs: 1_000 };
  const live = { mode: 'smoke', pid: 4243, runId: 'r2', startedAtMs: 2_000 };
  const writeLock = (record) => writeFileSync(lockPath, `${JSON.stringify(record, null, 2)}\n`);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mutation-pilot-lock-'));
    lockPath = join(dir, RUN_LOCK);
    stealPath = join(dir, LOCK_STEAL);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test('only the instance that was judged abandoned is removed', () => {
    writeLock(dead);
    expect(clearAbandonedLock(lockPath, dead)).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
    // Caller A has now taken the lock. Caller B read the same dead owner before
    // A acted; deleting on that stale read would drop A's LIVE lock and let two
    // Stryker runs share one `--out` and one temp directory.
    writeLock(live);
    expect(clearAbandonedLock(lockPath, dead)).toBe(false);
    expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toEqual(live);
  });

  test('two callers cannot be clearing the same lock at the same moment', () => {
    writeLock(dead);
    writeFileSync(stealPath, ''); // another caller is inside the clearing step
    expect(clearAbandonedLock(lockPath, dead)).toBe(false);
    expect(existsSync(lockPath)).toBe(true);
    // Refusing is not a dead end: the caller retries the exclusive create, and
    // LOCK_ATTEMPTS > 1 is what gives it that pass.
    expect(LOCK_ATTEMPTS).toBeGreaterThan(1);
  });

  test('the clearing step releases its mutex on every ending', () => {
    writeLock(dead);
    expect(clearAbandonedLock(lockPath, dead)).toBe(true);
    expect(existsSync(stealPath)).toBe(false);
    writeLock(live);
    expect(clearAbandonedLock(lockPath, dead)).toBe(false);
    expect(existsSync(stealPath)).toBe(false);
  });

  test('a mutex left by a killed process does not wedge the harness for good', () => {
    writeLock(dead);
    writeFileSync(stealPath, '');
    // Old enough that nobody can still be inside the two operations it covers:
    // this pass drops it, and the next one clears the lock.
    expect(clearAbandonedLock(lockPath, dead, { now: Date.now() + LOCK_STEAL_STALE_MS })).toBe(false);
    expect(existsSync(stealPath)).toBe(false);
    expect(clearAbandonedLock(lockPath, dead)).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
  });

  test('reclaiming a stale mutex removes that instance and never a replacement', () => {
    // The mutex's own version of the race it exists to prevent. Two callers can
    // judge the same mutex stale; once the first has reclaimed it and taken a
    // live one in its place, a remove by path alone would drop THAT — putting an
    // adoption and a clearing on one lock file, and two Stryker runs on one
    // `--out` and one sandbox directory.
    const observed = { record: { pid: 4242, token: 'first' }, mtimeMs: 1_000 };
    writeFileSync(stealPath, `${JSON.stringify({ pid: 4243, token: 'second' })}\n`);
    expect(reclaimStaleMutex(stealPath, observed, { now: Date.now() + 2 * LOCK_STEAL_STALE_MS })).toBe(false);
    expect(JSON.parse(readFileSync(stealPath, 'utf8')).token).toBe('second');
    // The instance that really is there, and really is stale, is reclaimed.
    const current = { record: { pid: 4243, token: 'second' }, mtimeMs: 1_000 };
    expect(reclaimStaleMutex(stealPath, current, { now: Date.now() + 2 * LOCK_STEAL_STALE_MS })).toBe(true);
    expect(existsSync(stealPath)).toBe(false);
    // And nothing is left in the directory: a file moved aside to be checked is
    // either removed or put back, never abandoned under its private name.
    expect(readdirSync(dir)).toEqual([]);
  });

  test('a mutex still within the stale window is left alone, however it reads', () => {
    writeFileSync(stealPath, `${JSON.stringify({ pid: 4242, token: 'first' })}\n`);
    const fresh = { record: { pid: 4242, token: 'first' }, mtimeMs: Date.now() };
    expect(reclaimStaleMutex(stealPath, fresh, { now: Date.now() })).toBe(false);
    expect(existsSync(stealPath)).toBe(true);
    // Nothing at the path is nothing to reclaim.
    rmSync(stealPath, { force: true });
    expect(reclaimStaleMutex(stealPath, null, { now: Date.now() + 2 * LOCK_STEAL_STALE_MS })).toBe(false);
  });

  test('a mutex whose stamp is unwritten is told apart by age alone, never by content', () => {
    // Creating the mutex and stamping it are two calls, so a caller killed in
    // between leaves an empty one. Empty matches only empty: a stamp that has
    // appeared since belongs to somebody who is inside the critical section.
    expect(sameMutexInstance(null, null)).toBe(true);
    expect(sameMutexInstance(null, { token: 'a' })).toBe(false);
    expect(sameMutexInstance({ token: 'a' }, null)).toBe(false);
    expect(sameMutexInstance({ token: 'a' }, { token: 'a' })).toBe(true);
    expect(sameMutexInstance({ token: 'a' }, { token: 'b' })).toBe(false);
    // A record with no token is not an identity, so it matches nothing.
    expect(sameMutexInstance({ pid: 1 }, { pid: 1 })).toBe(false);

    writeFileSync(stealPath, ''); // killed between the create and the stamp
    const empty = { record: null, mtimeMs: 1_000 };
    writeFileSync(stealPath, `${JSON.stringify({ pid: 4243, token: 'second' })}\n`);
    expect(reclaimStaleMutex(stealPath, empty, { now: Date.now() + 2 * LOCK_STEAL_STALE_MS })).toBe(false);
    expect(existsSync(stealPath)).toBe(true);
  });

  test('an unreadable lock is re-judged inside the mutex, never on the earlier read', () => {
    writeFileSync(lockPath, ''); // a start that is writing its record right now
    expect(clearAbandonedLock(lockPath, null)).toBe(false);
    expect(existsSync(lockPath)).toBe(true);
    // A record that appeared since is somebody's lock, not the empty file that
    // was judged abandoned.
    writeLock(live);
    expect(clearAbandonedLock(lockPath, null, { now: Date.now() + LOCK_WRITE_GRACE_MS })).toBe(false);
    expect(existsSync(lockPath)).toBe(true);
    // Still empty, and now past the grace: a start that died between the create
    // and the write, which is the one case that is safe to take.
    writeFileSync(lockPath, '');
    expect(clearAbandonedLock(lockPath, null, { now: Date.now() + LOCK_WRITE_GRACE_MS })).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
  });

  test('a lock that is already gone is not an error, and leaves nothing behind', () => {
    expect(clearAbandonedLock(lockPath, dead)).toBe(false);
    expect(clearAbandonedLock(lockPath, null)).toBe(false);
    expect(existsSync(stealPath)).toBe(false);
  });

  test('a detached copy adopts the lock its start took for it, restating the pid that is running', () => {
    writeLock(dead);
    const own = { mode: 'pilot', pid: 4242, runId: 'r1', startedAtMs: 3_000 };
    expect(adoptLockInstance(lockPath, dead, own)).toBe(true);
    expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toEqual(own);
    // Only the instance that was read: a record replaced since belongs to
    // somebody else's run and must not be overwritten with this one's.
    writeLock(live);
    expect(adoptLockInstance(lockPath, dead, own)).toBe(false);
    expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toEqual(live);
  });

  test('adoption and clearing cannot both be acting on the lock at once', () => {
    // The race this serializes: a `--background` start dies after the spawn but
    // before the hand-over, leaving a record naming a pid that is gone. Another
    // caller is then entitled to clear it while the detached copy is entitled to
    // adopt it — and outside one mutex the clearer's `rmSync` lands on the LIVE
    // lock the copy just adopted, putting two Stryker runs on one `--out`.
    writeLock(dead);
    writeFileSync(stealPath, ''); // a clearer is inside its two steps
    expect(adoptLockInstance(lockPath, dead, { ...dead, pid: 5_000 })).toBe(false);
    expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toEqual(dead);
    rmSync(stealPath, { force: true });
    // ...and the same mutex the other way round: a clearer that arrives while a
    // copy is adopting is refused, and retries the exclusive create instead.
    writeFileSync(stealPath, '');
    expect(clearAbandonedLock(lockPath, dead)).toBe(false);
    expect(existsSync(lockPath)).toBe(true);
  });

  test('adoption releases the mutex on every ending, and a killed one does not wedge it', () => {
    writeLock(dead);
    expect(adoptLockInstance(lockPath, dead, { ...dead, pid: 5_000 })).toBe(true);
    expect(existsSync(stealPath)).toBe(false);
    writeFileSync(stealPath, '');
    expect(adoptLockInstance(lockPath, dead, { ...dead, pid: 5_001 }, { now: Date.now() + LOCK_STEAL_STALE_MS })).toBe(false);
    expect(existsSync(stealPath)).toBe(false);
  });

  test('a lock record is replaced by rename, so a killed writer never leaves it unreadable', () => {
    // An in-place write truncates first: a SIGKILL between the truncate and the
    // write leaves an empty record that `acquireRunLock` judges abandoned after
    // the grace, admitting a second run beside the surviving Stryker group.
    writeLock(live);
    const before = statSync(lockPath).ino;
    const patched = { ...live, strykerPid: 7_000, strykerGroup: true };
    replaceLockRecord(lockPath, patched);
    expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toEqual(patched);
    // A new file took the path whole; the old one was never opened for writing.
    expect(statSync(lockPath).ino).not.toBe(before);
    // Nothing staged is left beside the lock.
    expect(readdirSync(dir)).toEqual([RUN_LOCK]);
    // Adoption goes through the same replacement.
    writeLock(dead);
    const adoptedBefore = statSync(lockPath).ino;
    expect(adoptLockInstance(lockPath, dead, { ...dead, pid: 5_000 })).toBe(true);
    expect(statSync(lockPath).ino).not.toBe(adoptedBefore);
    expect(readdirSync(dir)).toEqual([RUN_LOCK]);
  });

  test('a start never writes its stale record over the lock its copy has adopted', () => {
    // The `--background` hand-over and the copy's adoption race on one record.
    // The patch is decided inside the mutex, against the record as it is then:
    // once the copy has adopted (and recorded its Stryker group), the start finds
    // a pid that is not its own and leaves the record — group and all — alone.
    const start = { mode: 'pilot', pid: process.pid, runId: 'r1', startedAtMs: 1_000 };
    const adopted = { ...start, pid: process.pid + 1, startedAtMs: 3_000, strykerPid: 7_000, strykerGroup: true };
    writeLock(adopted);
    expect(patchOwnRunLock({ path: lockPath, held: true }, { pid: process.pid + 2, startedAtMs: 2_000 })).toBe(false);
    expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toEqual(adopted);
    expect(existsSync(stealPath)).toBe(false);
    // Its own record is patched in place of the old one, and the mutex released.
    writeLock(start);
    expect(patchOwnRunLock({ path: lockPath, held: true }, { strykerPid: 7_001 })).toBe(true);
    expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toEqual({ ...start, strykerPid: 7_001 });
    expect(readdirSync(dir)).toEqual([RUN_LOCK]);
    // A lock this process never held is not touched.
    expect(patchOwnRunLock({ path: lockPath, held: false }, { strykerPid: 1 })).toBe(false);
    expect(patchOwnRunLock(null, { strykerPid: 1 })).toBe(false);
  });

  test('a patch waits for the mutex rather than writing past it', () => {
    // A mutex left by a holder killed inside it: the patch does not skip the
    // mutex, it waits for the reclaim and then writes under a mutex of its own.
    writeLock({ mode: 'pilot', pid: process.pid, runId: 'r1', startedAtMs: 1_000 });
    writeFileSync(stealPath, '');
    const old = (Date.now() - LOCK_STEAL_STALE_MS - 1_000) / 1_000;
    utimesSync(stealPath, old, old);
    expect(patchOwnRunLock({ path: lockPath, held: true }, { strykerPid: 7_002 })).toBe(true);
    expect(JSON.parse(readFileSync(lockPath, 'utf8')).strykerPid).toBe(7_002);
    expect(existsSync(stealPath)).toBe(false);
  });

  test('adoption never creates a lock that is not there', () => {
    // The exclusive create is what takes an absent lock, and it is the only
    // thing that may: a write here would hand ownership out without racing for
    // it. `held` comes from the create, so a false here sends the caller back.
    expect(adoptLockInstance(lockPath, dead, { ...dead, pid: 5_000 })).toBe(false);
    expect(existsSync(lockPath)).toBe(false);
    expect(existsSync(stealPath)).toBe(false);
  });
});

describe('run environment', () => {
  test('the dashboard key never reaches the run', () => {
    const env = childEnv({ PATH: '/bin', [DASHBOARD_KEY_ENV]: 'secret' }, '/out/run-spec.json');
    expect(env[DASHBOARD_KEY_ENV]).toBeUndefined();
    expect(env.MUTATION_PILOT_SPEC).toBe('/out/run-spec.json');
  });

  test('the VM-modules flag is appended to NODE_OPTIONS, never replaces it', () => {
    expect(childEnv({}, '/s').NODE_OPTIONS).toBe('--experimental-vm-modules');
    expect(childEnv({ NODE_OPTIONS: '--max-old-space-size=4096' }, '/s').NODE_OPTIONS).toBe(
      '--max-old-space-size=4096 --experimental-vm-modules',
    );
  });

  test('an operator who already set the flag does not get it twice', () => {
    expect(childEnv({ NODE_OPTIONS: '--experimental-vm-modules' }, '/s').NODE_OPTIONS).toBe('--experimental-vm-modules');
  });

  test('the executable comes from the installed package manifest', () => {
    expect(strykerBinFromManifest({ bin: { stryker: 'bin/stryker.js' } })).toBe('bin/stryker.js');
    expect(strykerBinFromManifest({ bin: 'bin/stryker.js' })).toBe('bin/stryker.js');
    expect(() => strykerBinFromManifest({})).toThrow(/declares no "stryker" bin entry/);
  });
});

describe('node compatibility check', () => {
  test('a union of caret ranges is matched on the major version', () => {
    expect(nodeRangeVerdict('v22.6.0', '^20.0.0 || ^22.0.0').verdict).toBe('ok');
    expect(nodeRangeVerdict('v21.1.0', '^20.0.0 || ^22.0.0').verdict).toBe('unsupported');
  });

  test('an open-ended range is matched on the lower bound', () => {
    expect(nodeRangeVerdict('v22.6.0', '^18.17.0 || >=20.0.0').verdict).toBe('ok');
    expect(nodeRangeVerdict('v16.0.0', '^18.17.0 || >=20.0.0').verdict).toBe('unsupported');
  });

  test('a floor below the major’s first release is honoured, not rounded to the major', () => {
    // `^18.17.0` is what a package declares when it needs something that landed
    // in 18.17. Matching on the major alone certifies Node 18.0.0 against it,
    // and the run then fails inside Stryker with this cause already ruled out.
    expect(nodeRangeVerdict('v18.0.0', '^18.17.0 || >=20.0.0').verdict).toBe('unsupported');
    expect(nodeRangeVerdict('v18.16.9', '^18.17.0 || >=20.0.0').verdict).toBe('unsupported');
    expect(nodeRangeVerdict('v18.17.0', '^18.17.0 || >=20.0.0').verdict).toBe('ok');
    expect(nodeRangeVerdict('v18.17.1', '^18.17.0 || >=20.0.0').verdict).toBe('ok');
    // The same on an open lower bound, and on its patch position.
    expect(nodeRangeVerdict('v20.11.0', '>=20.12.0').verdict).toBe('unsupported');
    expect(nodeRangeVerdict('v20.12.0', '>=20.12.0').verdict).toBe('ok');
    expect(nodeRangeVerdict('v20.12.0', '>=20.12.1').verdict).toBe('unsupported');
    // A caret still stops at the next major, and `X.x` still means the major.
    expect(nodeRangeVerdict('v19.0.0', '^18.17.0').verdict).toBe('unsupported');
    expect(nodeRangeVerdict('v20.0.0', '20.x').verdict).toBe('ok');
    expect(nodeRangeVerdict('v21.0.0', '20.x').verdict).toBe('unsupported');
  });

  test('a prerelease Node is reported as uncomparable rather than certified', () => {
    // Semver says a prerelease satisfies no release range, but calling a nightly
    // "unsupported" would refuse a host that may well work. Neither verdict is
    // honest, so the preflight reports it and does not fail the run.
    const { verdict, reason } = nodeRangeVerdict('v23.0.0-nightly20240101', '>=20.0.0');
    expect(verdict).toBe('unknown');
    expect(reason).toMatch(/prerelease/);
  });

  test('a range this checker does not understand is reported, not guessed', () => {
    const { verdict, reason } = nodeRangeVerdict('v22.6.0', '>=20 <23');
    expect(verdict).toBe('unknown');
    expect(reason).toMatch(/unparsed range clause/);
    expect(nodeRangeVerdict('v22.6.0', undefined).verdict).toBe('unknown');
  });
});

describe('preflight findings', () => {
  const healthy = {
    manifest: {
      devDependencies: { '@stryker-mutator/core': '^8.7.0', '@stryker-mutator/jest-runner': '^8.7.0' },
      scripts: { test: 'jest', pretest: 'npm run build', package: 'npm run build' },
    },
    reportPaths: rawReportPaths('.mutation'),
    ignoredPaths: rawReportPaths('.mutation'),
    installed: {
      '@stryker-mutator/core': { version: '8.7.1', engines: { node: '^18.17.0 || >=20.0.0' } },
      '@stryker-mutator/jest-runner': { version: '8.7.1', engines: { node: '^18.17.0 || >=20.0.0' } },
    },
    missingPaths: [],
    out: '.mutation',
    nodeVersion: 'v22.6.0',
    compiler: { path: '<root>/node_modules/typescript/bin/tsc', present: true },
    buildScript: { path: '<root>/scripts/mutation-build.mjs', present: true },
  };
  const failures = (input) => preflightFindings(input).filter((f) => f.ok === false).map((f) => f.check);

  test('a complete, correctly wired harness has no failing check', () => {
    expect(failures(healthy)).toEqual([]);
  });

  test("an installed Stryker whose reader gave no answer blocks the run instead of certifying tracked files", () => {
    // The tracked-file stand-in omits untracked files a sandbox copies, so a
    // passing `reports-ignored` over it proves nothing about those copies.
    const inputs = (sandboxInputs) => preflightFindings({ ...healthy, sandboxInputs }).find((f) => f.check === 'sandbox-inputs');
    expect(inputs({ enumerated: true, count: 12 })).toEqual({ check: 'sandbox-inputs', ok: true, detail: expect.stringContaining('12 file(s)') });
    expect(failures({ ...healthy, sandboxInputs: { enumerated: false, count: 0 } })).toEqual(['sandbox-inputs']);
    // Without Stryker the `installed:` check is the failure; no second one here.
    const installed = { '@stryker-mutator/jest-runner': healthy.installed['@stryker-mutator/jest-runner'] };
    expect(failures({ ...healthy, installed, sandboxInputs: { enumerated: false, count: 0 } })).toEqual(['installed:@stryker-mutator/core']);
    expect(inputs(undefined)).toBeUndefined();
  });

  test('a missing package blocks the run instead of producing an empty result', () => {
    const installed = { '@stryker-mutator/core': healthy.installed['@stryker-mutator/core'] };
    expect(failures({ ...healthy, installed })).toEqual(['installed:@stryker-mutator/jest-runner']);
  });

  test('an unsupported Node version is a failure; an unreadable range is only a note', () => {
    expect(failures({ ...healthy, nodeVersion: 'v16.0.0' })).toEqual([
      'node-range:@stryker-mutator/core',
      'node-range:@stryker-mutator/jest-runner',
    ]);
    const installed = { ...healthy.installed, '@stryker-mutator/core': { version: '8.7.1', engines: { node: '>=20 <23' } } };
    const findings = preflightFindings({ ...healthy, installed });
    expect(findings.find((f) => f.check === 'node-range:@stryker-mutator/core').ok).toBeNull();
    expect(failures({ ...healthy, installed })).toEqual([]);
  });

  test("the instrumenter's parser range is checked too, not only Stryker's own (#1185)", () => {
    // Stryker 10 declares >=22.0.0, but its instrumenter parses with Babel 8,
    // which declares a later floor. Node 22.6.0 satisfies the first and not the
    // second, so a check of Stryker's range alone would certify a host that
    // cannot instrument a single file.
    const ten = { version: '10.0.0', engines: { node: '>=22.0.0' } };
    const upgraded = {
      ...healthy,
      manifest: { ...healthy.manifest, devDependencies: { '@stryker-mutator/core': '^10.0.0', '@stryker-mutator/jest-runner': '^10.0.0' } },
      installed: { '@stryker-mutator/core': ten, '@stryker-mutator/jest-runner': ten },
      instrumenterParser: { version: '8.0.6', engines: { node: '^22.18.0 || >=24.11.0' } },
    };
    expect(failures(upgraded)).toEqual(['node-range:@babel/core']);
    const detail = preflightFindings(upgraded).find((f) => f.check === 'node-range:@babel/core').detail;
    expect(detail).toMatch(/instrumenter's @babel\/core 8\.0\.6/);
    expect(detail).toMatch(/v22\.6\.0 is outside/);
    expect(failures({ ...upgraded, nodeVersion: 'v22.18.0' })).toEqual([]);
    expect(failures({ ...upgraded, nodeVersion: 'v24.19.0' })).toEqual([]);
    expect(failures({ ...upgraded, nodeVersion: 'v24.10.0' })).toEqual(['node-range:@babel/core']);
    // Not found, or an unreadable range, is a note: the check could not be made.
    const missing = preflightFindings({ ...upgraded, instrumenterParser: undefined }).find((f) => f.check === 'node-range:@babel/core');
    expect(missing.ok).toBeNull();
    expect(missing.detail).toMatch(/not found/);
    expect(failures({ ...upgraded, instrumenterParser: { version: '8.0.6', engines: {} } })).toEqual([]);
    // Without core the `installed:` check is the failure; no parser finding at all.
    const noCore = { ...upgraded, installed: { '@stryker-mutator/jest-runner': ten } };
    expect(preflightFindings(noCore).some((f) => f.check === 'node-range:@babel/core')).toBe(false);
  });

  test('the parser is resolved the way Node resolves it, nested copy first', () => {
    // The checkout's hoisted @babel/core is Jest's 7.x; the instrumenter's own
    // nested 8.x is the one Stryker loads, and so the one whose range counts.
    const root = mkdtempSync(join(tmpdir(), 'mutation-resolve-'));
    try {
      const put = (dir, pkg) => {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg));
      };
      const modules = join(root, 'node_modules');
      put(join(modules, '@stryker-mutator', 'core'), { version: '10.0.0' });
      put(join(modules, '@stryker-mutator', 'instrumenter'), { version: '10.0.0' });
      put(join(modules, '@babel', 'core'), { version: '7.29.7' });
      expect(readResolvedPackage(root, INSTRUMENTER_PARSER_CHAIN).version).toBe('7.29.7');
      put(join(modules, '@stryker-mutator', 'instrumenter', 'node_modules', '@babel', 'core'), { version: '8.0.6' });
      expect(readResolvedPackage(root, INSTRUMENTER_PARSER_CHAIN).version).toBe('8.0.6');
      expect(readResolvedPackage(root, ['@stryker-mutator/core', '@stryker-mutator/absent'])).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('an installed package outside the pinned range blocks the run, not just a missing one', () => {
    // A stale node_modules can hold a 7.x core under the ^8.7 pin; presence
    // alone would let it start a run of hours that relies on 8.7 behavior.
    const stale = (version) => ({ ...healthy.installed, '@stryker-mutator/core': { ...healthy.installed['@stryker-mutator/core'], version } });
    expect(failures({ ...healthy, installed: stale('7.3.0') })).toEqual(['pinned:@stryker-mutator/core']);
    expect(failures({ ...healthy, installed: stale('8.6.9') })).toEqual(['pinned:@stryker-mutator/core']);
    expect(failures({ ...healthy, installed: stale('9.0.0') })).toEqual(['pinned:@stryker-mutator/core']);
    const detail = preflightFindings({ ...healthy, installed: stale('7.3.0') }).find((f) => f.check === 'pinned:@stryker-mutator/core').detail;
    expect(detail).toMatch(/installed 7\.3\.0 is outside/);
    expect(detail).toMatch(/npm install/);
    const ok = preflightFindings(healthy).find((f) => f.check === 'pinned:@stryker-mutator/jest-runner');
    expect(ok.ok).toBe(true);
    expect(ok.detail).toMatch(/8\.7\.1 satisfies \^8\.7\.0/);
    // A pin this grammar cannot read is a note, never a guess either way.
    const manifest = { ...healthy.manifest, devDependencies: { ...healthy.manifest.devDependencies, '@stryker-mutator/core': '~8.7.0' } };
    expect(preflightFindings({ ...healthy, manifest }).find((f) => f.check === 'pinned:@stryker-mutator/core').ok).toBeNull();
    // An unpinned package still fails, installed or not.
    const unpinned = { ...healthy.manifest, devDependencies: { '@stryker-mutator/jest-runner': '^8.7.0' } };
    expect(failures({ ...healthy, manifest: unpinned })).toEqual(['pinned:@stryker-mutator/core']);
  });

  test('mutation testing creeping into a default script is a failure', () => {
    const manifest = { ...healthy.manifest, scripts: { ...healthy.manifest.scripts, pretest: 'npm run mutation:pilot' } };
    expect(failures({ ...healthy, manifest })).toEqual(['not-wired-into-verification']);
  });

  test('an un-ignored report directory is a failure, so raw reports cannot be committed', () => {
    expect(failures({ ...healthy, ignoredPaths: [] })).toEqual(['reports-ignored']);
  });

  test('a report Git would commit fails the check even when the directory itself is ignored', () => {
    // `.gitignore` is a program: `.mutation/` followed by `!.mutation/` and
    // `!.mutation/**` re-includes the reports, and the directory still reads as
    // ignored. Only the per-path answer sees that, and a raw `mutation.json`
    // holds the full source of every mutated file.
    const exposed = reportsIgnoredFinding({
      out: '.mutation',
      reportPaths: ['.mutation', '.mutation/pilot/mutation.json'],
      ignoredPaths: ['.mutation'],
    });
    expect(exposed.ok).toBe(false);
    expect(exposed.detail).toContain('.mutation/pilot/mutation.json');
    // The same through the preflight, over the real path list — and the names
    // it prints are bounded like every other list here.
    expect(failures({ ...healthy, ignoredPaths: ['.mutation'] })).toEqual(['reports-ignored']);
    const detail = preflightFindings({ ...healthy, ignoredPaths: ['.mutation'] }).find((f) => f.check === 'reports-ignored').detail;
    expect(detail.split(', ').length).toBeLessThanOrEqual(MAX_LISTED_EXPOSED);
    expect(detail).toMatch(/\+\d+ more/);
  });

  test('no answer from Git fails the check instead of certifying the reports as safe', () => {
    const finding = preflightFindings({ ...healthy, ignoredPaths: null }).find((f) => f.check === 'reports-ignored');
    expect(finding.ok).toBe(false);
    expect(finding.detail).toMatch(/git could not say/);
  });

  test('a scoped file that no longer exists blocks the run', () => {
    expect(failures({ ...healthy, missingPaths: ['src/core/chain-linear.ts'] })).toEqual(['scope-files-exist']);
  });

  test('a missing compiler blocks the run here, instead of failing inside the sandbox build', () => {
    const compiler = { path: '<root>/node_modules/typescript/bin/tsc', present: false };
    expect(failures({ ...healthy, compiler })).toEqual(['sandbox-compiler']);
    const detail = preflightFindings({ ...healthy, compiler }).find((f) => f.check === 'sandbox-compiler').detail;
    expect(detail).toMatch(/npm install/);
  });

  test('a caller that cannot decide the compiler reports a note, never a silent pass', () => {
    const finding = preflightFindings({ ...healthy, compiler: undefined }).find((f) => f.check === 'sandbox-compiler');
    expect(finding.ok).toBeNull();
  });

  test('a missing build wrapper blocks the run, because buildCommand names it by absolute path', () => {
    const buildScript = { path: '<root>/scripts/mutation-build.mjs', present: false };
    expect(failures({ ...healthy, buildScript })).toEqual(['sandbox-build-script']);
    const finding = preflightFindings({ ...healthy, buildScript: undefined }).find((f) => f.check === 'sandbox-build-script');
    expect(finding.ok).toBeNull();
  });

  test('"nothing is ignored" is an answer from git; "git did not run" is not', () => {
    const rejecting = (status) => () => { throw Object.assign(new Error('git failed'), { status }); };
    const calls = [];
    const exec = (command, args, options) => {
      calls.push([command, args, options]);
      return '.mutation\0.mutation/pilot.lock\0';
    };
    expect(gitIgnoredPaths(['.mutation', '.mutation/pilot.lock'], { cwd: '/repo', exec })).toEqual(['.mutation', '.mutation/pilot.lock']);
    // `-z` so a path git would otherwise quote comes back spelled the way it
    // was asked about — and git accepts `-z` only with `--stdin`, so the paths
    // are fed in rather than passed as arguments. That is also what keeps an
    // `--out` from being read as an option.
    expect(calls[0][0]).toBe('git');
    expect(calls[0][1]).toEqual(['check-ignore', '-z', '--stdin']);
    expect(calls[0][2]).toMatchObject({ cwd: '/repo', input: '.mutation\0.mutation/pilot.lock\0' });
    // Exit 1 is check-ignore's "none of these are ignored".
    expect(gitIgnoredPaths(['.mutation'], { exec: rejecting(1) })).toEqual([]);
    // Anything else is no answer at all, and must not read as "all ignored".
    expect(gitIgnoredPaths(['.mutation'], { exec: rejecting(128) })).toBeNull();
    expect(gitIgnoredPaths(['.mutation'], { exec: () => { throw Object.assign(new Error('spawn git'), { code: 'ENOENT' }); } })).toBeNull();
  });

  test('an --out outside the work tree is not asked of git, but the in-tree lock still is', () => {
    const identity = (path) => path;
    const reportPaths = rawReportPaths('/tmp/elsewhere');
    const external = pathsOutsideWorktree(reportPaths, '/repo', { realpath: identity });
    // Every report path is external; the fixed lock is the one path left for git.
    expect(external).toEqual(reportPaths.filter((path) => path !== RUN_LOCK_PATH));
    expect(pathsOutsideWorktree(['.mutation/x', '/repo/.mutation/x', '../sibling/x', '/repo-other/x'], '/repo', { realpath: identity }))
      .toEqual(['../sibling/x', '/repo-other/x']);
    // With the lock ignored, the preflight passes and says why the rest needs no rule.
    const finding = preflightFindings({ ...healthy, out: '/tmp/elsewhere', reportPaths, externalPaths: external, ignoredPaths: [RUN_LOCK_PATH] })
      .find((f) => f.check === 'reports-ignored');
    expect(finding.ok).toBe(true);
    expect(finding.detail).toMatch(/outside this work tree/);
    // An un-ignored lock still fails, and so does no answer from git.
    expect(failures({ ...healthy, out: '/tmp/elsewhere', reportPaths, externalPaths: external, ignoredPaths: [] })).toEqual(['reports-ignored']);
    expect(failures({ ...healthy, out: '/tmp/elsewhere', reportPaths, externalPaths: external, ignoredPaths: null })).toEqual(['reports-ignored']);
  });

  test('an --out reaching the work tree through a symlink is still asked of git', () => {
    const realpath = (path) => path.replace(/^\/alias/, '/repo');
    expect(pathsOutsideWorktree(['/alias/.mutation/x'], '/repo', { realpath })).toEqual([]);
  });

  test('an --out aliased into the work tree from outside is asked of git in its in-tree spelling', () => {
    // `/tmp/alias -> /repo/.mutation`: git dies with 128 on the outside spelling,
    // which would reject a valid, ignored output directory.
    const realpath = (path) => path.replace(/^\/tmp\/alias(?=\/|$)/, '/repo/.mutation');
    expect(gitProbeOut('/tmp/alias', '/repo', { realpath })).toBe('.mutation');
    const reportPaths = rawReportPaths(gitProbeOut('/tmp/alias', '/repo', { realpath }));
    expect(reportPaths).toEqual(rawReportPaths('.mutation'));
    expect(pathsOutsideWorktree(reportPaths, '/repo', { realpath })).toEqual([]);
    // An in-tree spelling whose target is outside is left for `pathsOutsideWorktree`.
    const outward = (path) => path.replace(/^\/repo\/out(?=\/|$)/, '/elsewhere');
    expect(gitProbeOut('out', '/repo', { realpath: outward })).toBe('out');
    expect(pathsOutsideWorktree(['out/x'], '/repo', { realpath: outward })).toEqual(['out/x']);
  });

  test('an in-tree --out spelled with .. is asked of git in its resolved spelling', () => {
    // `git check-ignore` rejects `../repo/.mutation/...` for the whole batch even
    // though it lands inside the work tree, which would block every run.
    expect(gitProbeOut('../repo/.mutation', '/wt/repo')).toBe('.mutation');
    expect(gitProbeOut('./.mutation/../.mutation', '/wt/repo')).toBe('.mutation');
    expect(gitProbeOut('/wt/repo/.mutation', '/wt/repo')).toBe('.mutation');
    expect(gitProbeOut('.mutation', '/wt/repo')).toBe('.mutation');
    expect(gitProbeOut('../repo', '/wt/repo')).toBe('.');
    expect(rawReportPaths(gitProbeOut('../repo/.mutation', '/wt/repo'))).toEqual(rawReportPaths('.mutation'));
    // Outside the work tree the spelling is left for `pathsOutsideWorktree`.
    expect(gitProbeOut('../sibling/out', '/wt/repo')).toBe('../sibling/out');
    expect(gitProbeOut('/tmp/elsewhere', '/wt/repo')).toBe('/tmp/elsewhere');
  });

  test('a path is compared with git\'s answer in one spelling', () => {
    expect(reportsIgnoredFinding({ out: '.mutation', reportPaths: ['./.mutation/'], ignoredPaths: ['.mutation'] }).ok).toBe(true);
    expect(reportsIgnoredFinding({ out: '.mutation', reportPaths: [], ignoredPaths: [] }).ok).toBe(true);
  });
});

describe('report summary', () => {
  const paths = { root: '/repo', home: '/home/op', tmp: '/tmp' };
  const report = {
    schemaVersion: '2.0',
    files: {
      'src/core/tool-request-grant.ts': {
        mutants: [
          { id: '1', mutatorName: 'StringLiteral', status: 'Killed', location: { start: { line: 74 } }, killedBy: ['t1'], coveredBy: ['t1', 't2'] },
          { id: '2', mutatorName: 'BooleanLiteral', status: 'Timeout', location: { start: { line: 76 } }, killedBy: ['t2'], coveredBy: ['t2'] },
          { id: '3', mutatorName: 'EqualityOperator', status: 'Survived', location: { start: { line: 80 } }, replacement: 'result.length >= 0', coveredBy: ['t1'] },
          { id: '4', mutatorName: 'ArithmeticOperator', status: 'NoCoverage', location: { start: { line: 83 } }, replacement: 'i--' },
          { id: '5', mutatorName: 'BlockStatement', status: 'CompileError', location: { start: { line: 79 } }, statusReason: 'error at /repo/src/core/tool-request-grant.ts:79' },
        ],
      },
    },
    testFiles: {
      '/repo/test/tool-request-grant.test.js': { tests: [{ id: 't1' }, { id: 't2' }] },
    },
  };

  test('statuses are counted, and the score excludes mutants the harness could not evaluate', () => {
    const summary = summarizeMutationReport(report, paths);
    expect(summary.total).toBe(5);
    expect(summary.byStatus).toEqual({ Killed: 1, Timeout: 1, Survived: 1, NoCoverage: 1, CompileError: 1 });
    // (killed + timeout) / (killed + timeout + survived + noCoverage) — the
    // CompileError is not evidence either way.
    expect(summary.mutationScore).toBe(50);
    expect(summary.perFile).toEqual([{ file: 'src/core/tool-request-grant.ts', total: 5, byStatus: summary.byStatus }]);
  });

  test('killed and covered are kept apart per test file, as #1110 §7 item 4 requires', () => {
    const summary = summarizeMutationReport(report, paths);
    expect(summary.killedByTest).toEqual({ 'test/tool-request-grant.test.js': 2 });
    expect(summary.coveredByTest).toEqual({ 'test/tool-request-grant.test.js': 4 });
  });

  test('undetected mutants are listed with their location, and errors separately', () => {
    const summary = summarizeMutationReport(report, paths);
    expect(summary.survivors.shown.map((m) => [m.status, m.line])).toEqual([
      ['Survived', 80],
      ['NoCoverage', 83],
    ]);
    expect(summary.errors.shown).toEqual([
      {
        file: 'src/core/tool-request-grant.ts',
        line: 79,
        mutator: 'BlockStatement',
        status: 'CompileError',
        // The checkout path is masked before the summary is publishable.
        reason: 'error at ./src/core/tool-request-grant.ts:79',
      },
    ]);
  });

  test('no source text reaches the summary, and a long replacement is truncated', () => {
    const long = { files: { 'src/core/chain-linear.ts': { mutants: [{ id: '1', mutatorName: 'StringLiteral', status: 'Survived', location: { start: { line: 1 } }, replacement: 'x'.repeat(200) }] } } };
    const summary = summarizeMutationReport(long, paths);
    expect(summary.survivors.shown[0].replacement).toHaveLength(80);
    expect(summary.survivors.shown[0].replacement.endsWith('...')).toBe(true);
    // The raw report carries every mutated file's full source; the summary must not.
    expect(JSON.stringify(summary)).not.toContain('source');
  });

  test('the listed mutants are bounded', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ id: String(i), mutatorName: 'M', status: 'Survived', location: { start: { line: i } } }));
    const summary = summarizeMutationReport({ files: { 'src/core/chain-linear.ts': { mutants: many } } }, paths);
    expect(summary.survivors.shown).toHaveLength(MAX_LISTED_MUTANTS);
    expect(summary.survivors).toMatchObject({ total: 30, omitted: 10 });
    expect(capList([1, 2], 5)).toEqual({ shown: [1, 2], total: 2, omitted: 0 });
  });

  test('an empty report scores nothing rather than 100%', () => {
    expect(summarizeMutationReport({ files: {} }, paths).mutationScore).toBeNull();
  });
});

describe('smoke verdict', () => {
  const passing = { state: 'complete', reason: 'passed' };

  test('one detected mutant and no harness error is the whole bar', () => {
    const verdict = smokeVerdict(passing, { total: 12, byStatus: { Killed: 11, Survived: 1 } });
    expect(verdict).toMatchObject({ ok: true, detected: 11, errorCount: 0, reasons: [] });
  });

  test('a survivor alone does not fail the check — it is reported for judgement', () => {
    expect(smokeVerdict(passing, { total: 2, byStatus: { Killed: 1, Survived: 1 } }).ok).toBe(true);
  });

  test('no detection means mutants are not reaching the executed code', () => {
    const verdict = smokeVerdict(passing, { total: 12, byStatus: { Survived: 12 } });
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons.join(' ')).toMatch(/not reaching the code the tests execute/);
  });

  test('a compile or runtime error is a broken harness, not a weak test', () => {
    const verdict = smokeVerdict(passing, { total: 2, byStatus: { Killed: 1, CompileError: 1 } });
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons.join(' ')).toMatch(/compile or runtime error/);
  });

  test('an interrupted or failed run never reads as a pass', () => {
    expect(smokeVerdict({ state: 'interrupted', reason: 'timeout' }, { total: 0, byStatus: {} }).ok).toBe(false);
    const nonZero = smokeVerdict({ state: 'complete', reason: 'exit:1' }, { total: 2, byStatus: { Killed: 2 } });
    expect(nonZero.ok).toBe(false);
    expect(nonZero.reasons.join(' ')).toMatch(/exited non-zero/);
  });

  test('an interrupted run draws no conclusion about the tests from counts it never produced', () => {
    // A harness failure (a sandbox build that could not start, say) leaves an
    // empty report. Reading that as "no mutant was detected" would blame the
    // pilot suites for a run that never reached them.
    const verdict = smokeVerdict({ state: 'interrupted', reason: 'no-report' }, { total: 0, byStatus: {} });
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons).toEqual([
      'the Stryker run did not complete (no-report) — no conclusion about the tests can be drawn from it',
    ]);
    expect(verdict.reasons.join(' ')).not.toMatch(/not reaching the code the tests execute|no mutants were generated/);
  });

  test('a run that produced no mutants at all is a failure', () => {
    expect(smokeVerdict(passing, { total: 0, byStatus: {} }).reasons).toContain('no mutants were generated in the smoke range');
  });

  test('a missing report is classified as interrupted, never as a pass', () => {
    expect(classifyStrykerRun({ exitCode: 0, reportPresent: false })).toEqual({ state: 'interrupted', reason: 'no-report' });
    expect(classifyStrykerRun({ exitCode: 0, reportPresent: true })).toEqual({ state: 'complete', reason: 'passed' });
    expect(classifyStrykerRun({ timedOut: true, reportPresent: true })).toEqual({ state: 'interrupted', reason: 'timeout' });
    expect(classifyStrykerRun({ interruptedBy: 'SIGTERM', reportPresent: true })).toEqual({ state: 'interrupted', reason: 'parent-signal:SIGTERM' });
  });

  test('a Stryker group that outlived SIGKILL is never published as complete (passed)', () => {
    const run = classifyStrykerRun({ exitCode: 0, reportPresent: true, groupSurvived: true });
    expect(run).toEqual({ state: 'interrupted', reason: 'group-survived' });
    expect(classifyStrykerRun({ exitCode: 0, timedOut: true, reportPresent: true, groupSurvived: true }).reason).toBe('group-survived');
    expect(smokeVerdict(run, { total: 1, byStatus: { Killed: 1 } }).ok).toBe(false);
  });
});

// The failure that produced this section: `mutation:preflight && mutation:smoke
// && mutation:dry-run` was run as one command by a wrapper with its own command
// timeout. The wrapper gave up and closed the pipe; Stryker, which inherits that
// stream, died on the next write with exit 1, and the driver filed a `complete
// (exit:1)` dry run. That summary read as "the pilot suites failed" when what
// had actually happened was that nobody was listening any more.
describe('a console that goes away mid-run', () => {
  test('is an interruption, not a Stryker result', () => {
    expect(classifyStrykerRun({ exitCode: 1, reportPresent: true, consoleLost: 'EPIPE' })).toEqual({
      state: 'interrupted',
      reason: 'console-closed:EPIPE',
    });
    // Also covers the dry run, whose `reportPresent` is forced true by the
    // caller: without this it would have been filed as `complete (exit:1)`.
    expect(classifyStrykerRun({ exitCode: 1, reportPresent: false, consoleLost: 'EPIPE' }).reason).toBe('console-closed:EPIPE');
  });

  test('draws no conclusion about the tests', () => {
    const run = classifyStrykerRun({ exitCode: 1, reportPresent: true, consoleLost: 'EPIPE' });
    const verdict = smokeVerdict(run, { total: 0, byStatus: {} });
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons).toEqual([
      'the Stryker run did not complete (console-closed:EPIPE) — no conclusion about the tests can be drawn from it',
    ]);
  });

  test('does not overwrite a run that had already finished and reported', () => {
    // The pipe broke after Stryker exited zero with its report on disk. That run
    // produced its evidence; the lost console is a detail, not a retraction.
    expect(classifyStrykerRun({ exitCode: 0, reportPresent: true, consoleLost: 'EPIPE' })).toEqual({
      state: 'complete',
      reason: 'passed',
    });
  });

  test('a signal or a budget expiry still names itself first', () => {
    expect(classifyStrykerRun({ exitCode: 1, timedOut: true, consoleLost: 'EPIPE' }).reason).toBe('timeout');
    expect(classifyStrykerRun({ exitCode: 1, signal: 'SIGKILL', consoleLost: 'EPIPE' }).reason).toBe('signal:SIGKILL');
  });

  test('the watcher records the first write failure instead of letting it end the driver', () => {
    const stream = new EventEmitter();
    const state = watchConsole([stream]);
    expect(state.lost).toBeNull();
    // An `error` with no listener on `process.stdout` is fatal; this is the
    // listener, and it keeps only the first cause.
    stream.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
    stream.emit('error', Object.assign(new Error('closed'), { code: 'ERR_STREAM_DESTROYED' }));
    expect(state.lost).toBe('EPIPE');
  });

  test('the heartbeat is what discovers the loss, because nothing else writes during a run', () => {
    // A dry run spends minutes inside one silent initial test run. Without this
    // line there is no write between "running stryker" and the run's end, so a
    // broken pipe would go unnoticed — and an operator could not tell the
    // silence from a hang.
    expect(heartbeatLine('dry-run', 90_000)).toBe('  … dry-run still running — 90 s elapsed\n');
  });

  test('a probe write before classification discovers a break only Stryker wrote into', async () => {
    // The consumer went away between heartbeats and Stryker hit the break first:
    // the driver has written nothing since, so only this write can report it.
    const broken = { write: (_text, done) => setImmediate(() => done(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))) };
    await expect(probeConsole(broken, 'x\n')).resolves.toBe('EPIPE');
    // A stream already torn down throws instead of calling back.
    const destroyed = { write: () => { throw Object.assign(new Error('destroyed'), { code: 'ERR_STREAM_DESTROYED' }); } };
    await expect(probeConsole(destroyed, 'x\n')).resolves.toBe('ERR_STREAM_DESTROYED');
    const intact = { write: (_text, done) => setImmediate(() => done()) };
    await expect(probeConsole(intact, 'x\n')).resolves.toBeNull();
    // A reader that is alive but not reading never acknowledges; that is not a
    // lost console, and the wait is bounded.
    const stalled = { write: () => true };
    await expect(probeConsole(stalled, 'x\n', 20)).resolves.toBeNull();
  });

  test('a closed pipe is reported by the probe on a real stream', async () => {
    if (process.platform === 'win32') return;
    // `true` exits without reading, so the pipe's reader is gone by the time the
    // probe writes into it.
    const reader = spawn('true', [], { stdio: ['pipe', 'ignore', 'ignore'] });
    await new Promise((done) => reader.once('exit', done));
    reader.stdin.on('error', () => {});
    await expect(probeConsole(reader.stdin, 'x\n')).resolves.toMatch(/EPIPE|ERR_STREAM_DESTROYED/);
  }, 30_000);
});

describe('abandoned sandboxes', () => {
  // A run killed before Stryker's own `cleanTempDir` leaves a whole copy of the
  // checkout behind; three had accumulated under `.mutation/stryker-tmp` by the
  // time the console-loss above was diagnosed.
  const now = Date.parse('2026-09-21T04:00:00.000Z');
  const old = now - STALE_SANDBOX_AGE_MS - 1;

  test('only this harness\'s own directories, and only once nothing can still own them', () => {
    expect(
      staleSandboxes(
        [
          { name: 'sandbox-ci1tkR', directory: true, mtimeMs: old },
          { name: 'sandbox-kJeGxT', directory: true, mtimeMs: old },
          // A run in progress writes into its sandbox continuously.
          { name: 'sandbox-live00', directory: true, mtimeMs: now - 1_000 },
          // Not a sandbox, and not this harness's to delete.
          { name: 'incremental.json', directory: false, mtimeMs: old },
          { name: 'something-else', directory: true, mtimeMs: old },
        ],
        { now },
      ),
    ).toEqual(['sandbox-ci1tkR', 'sandbox-kJeGxT']);
  });

  test('a sandbox exactly at the age bound is stale', () => {
    expect(staleSandboxes([{ name: 'sandbox-a', directory: true, mtimeMs: now - STALE_SANDBOX_AGE_MS }], { now })).toEqual(['sandbox-a']);
  });
});

describe('what a dry run reports', () => {
  // The lines Stryker 8.7.1 actually printed on this branch, colouring and all,
  // taken verbatim from the completed dry run recorded in
  // `docs/metrics/mutation-pilot-harness.md` §4 (attempt 6). A dry run activates
  // no mutant and writes no `mutation.json`, so this text is the only place its
  // two numbers exist — pinning the real format is what keeps a later Stryker
  // rewording from silently turning them into nulls.
  const LOG = [
    '[32m02:08:47 (64962) INFO ProjectReader[39m Found 2 of 716 file(s) to be mutated.',
    '[32m02:08:47 (64962) INFO Instrumenter[39m Instrumented 2 source file(s) with 742 mutant(s)',
    '[32m02:08:48 (64962) INFO ConcurrencyTokenProvider[39m Creating 1 test runner process(es).',
    '[32m02:11:53 (64962) INFO DryRunExecutor[39m Initial test run succeeded. Ran 180 tests in 3 minutes 1 second (net 179927 ms, overhead 1387 ms).',
    '[32m02:11:53 (64962) INFO MutationTestExecutor[39m The dry-run has been completed successfully. No mutations have been executed.',
  ].join('\n');

  test('the mutant count and the cost of one pass are read out of Stryker’s own log', () => {
    expect(parseDryRunFacts(LOG)).toEqual({
      filesMutated: 2,
      filesConsidered: 716,
      mutants: 742,
      tests: 180,
      netMs: 179_927,
      overheadMs: 1387,
    });
  });

  test('a number Stryker never printed is null, never a default', () => {
    // The failure this guards is the quiet one: a parser that fell back to 0 or
    // to a partial count would hand slice 4 a budget for a run nobody measured.
    expect(parseDryRunFacts('')).toEqual({
      filesMutated: null,
      filesConsidered: null,
      mutants: null,
      tests: null,
      netMs: null,
      overheadMs: null,
    });
    expect(parseDryRunFacts(LOG.split('\n').slice(0, 2).join('\n'))).toMatchObject({ mutants: 742, netMs: null, tests: null });
  });

  test('a failed initial test run yields no cost, because it is a finding rather than a budget', () => {
    const failed = LOG.replace(/Initial test run succeeded\..*/, 'Initial test run failed. Tests results were: …');
    const facts = parseDryRunFacts(failed);
    expect(facts).toMatchObject({ mutants: 742, netMs: null });
    expect(dryRunCost(facts, { concurrency: 1, coverageAnalysis: 'off' })).toMatchObject({ mutants: 742, projectedMs: null });
  });

  test('the projection is one full pass per mutant, divided by the workers it names', () => {
    const facts = parseDryRunFacts(LOG);
    const serial = dryRunCost(facts, { concurrency: 1, coverageAnalysis: 'off' });
    // 179927 + 1387 ms per mutant — the pass an *undetected* mutant costs.
    expect(serial).toMatchObject({ mutants: 742, workers: 1, perMutantMs: 181_314, projectedMs: 742 * 181_314 });
    expect(serial.basis).toMatch(/undetected mutant/);
    expect(dryRunCost(facts, { concurrency: 8, coverageAnalysis: 'off' })).toMatchObject({
      workers: 8,
      projectedMs: Math.round((742 * 181_314) / 8),
    });
    // Whatever the concurrency, the pilot scope does not fit the 180-minute
    // default budget — the §6 conclusion this run exists to establish.
    expect(serial.projectedMs).toBeGreaterThan(180 * 60_000);
  });

  test('coverage analysis that runs a subset gets no projection at all', () => {
    // Under `all`/`perTest` a mutant runs some of the suites, so one full pass
    // is not its cost; stating a number anyway is how a budget goes wrong by an
    // order of magnitude.
    for (const coverageAnalysis of ['all', 'perTest']) {
      const cost = dryRunCost(parseDryRunFacts(LOG), { concurrency: 2, coverageAnalysis });
      expect(cost).toMatchObject({ mutants: 742, projectedMs: null, perMutantMs: null });
      expect(cost.basis).toContain(coverageAnalysis);
    }
  });

  test('a concurrency that makes no sense never divides by zero', () => {
    expect(dryRunCost(parseDryRunFacts(LOG), { concurrency: 0, coverageAnalysis: 'off' })).toMatchObject({ workers: 1 });
    expect(dryRunCost(null, { concurrency: 1, coverageAnalysis: 'off' })).toMatchObject({ mutants: null, projectedMs: null });
  });

  test('a duration is rendered at a scale a reader can weigh against a budget', () => {
    expect(formatDuration(75_000)).toBe('75 s');
    expect(formatDuration(181_314)).toBe('3 min');
    expect(formatDuration(742 * 181_314)).toBe('37 h 22 min');
    expect(formatDuration(Number.NaN)).toBe('unknown');
  });
});

describe('rendered summary', () => {
  const result = {
    mode: 'smoke',
    scope: { label: 'smoke', mutate: SMOKE_MUTATE, testFiles: SMOKE_TESTS },
    environment: {
      commit: 'abc1234',
      node: 'v22.6.0',
      stryker: '8.7.1',
      jestRunner: '8.7.1',
      jest: '29.7.0',
      concurrency: 2,
      parallelism: 10,
      coverageAnalysis: 'off',
      worktreeDirty: 'clean',
    },
    run: { state: 'complete', reason: 'passed', wallMs: 91_000, loadBefore: '2.10/1.90/1.80', loadAfter: '3.40/2.20/1.90' },
    summary: summarizeMutationReport(
      { files: { 'src/core/tool-request-grant.ts': { mutants: [{ id: '1', mutatorName: 'StringLiteral', status: 'Killed', location: { start: { line: 74 } }, killedBy: ['t1'], coveredBy: ['t1'] }] } }, testFiles: { 'test/tool-request-grant.test.js': { tests: [{ id: 't1' }] } } },
      {},
    ),
    verdict: { ok: true, detected: 1, errorCount: 0, reasons: [] },
  };

  test('the markdown reports the sandbox build as the link between the mutant and the tests', () => {
    const build = {
      ok: true,
      tsc: { exitCode: 0, signal: null, diagnostics: { lines: 0, codes: {}, omittedCodes: 0 } },
      outputs: [{ source: 'src/core/tool-request-grant.ts', dist: 'dist/core/tool-request-grant.js', present: true, instrumented: true, bytes: 1234 }],
      warnings: [],
      reasons: [],
    };
    const md = renderSummary({ ...result, build });
    expect(md).toContain('## Sandbox build');
    expect(md).toContain('`src/core/tool-request-grant.ts` → `dist/core/tool-request-grant.js`: emitted, instrumented');
    // A run made before the build record existed still renders.
    expect(renderSummary(result)).not.toContain('## Sandbox build');
  });

  test('the markdown states the verdict-affecting timeout and incremental settings', () => {
    // A timed-out mutant counts as detected and an incremental run reuses earlier
    // verdicts, so the published summary must say which semantics produced it.
    // `timeoutMs` is only the additive baseline of Stryker's deadline, so the
    // factor is stated with it and the line does not call `timeoutMs` the deadline.
    const md = renderSummary({ ...result, environment: { ...result.environment, timeoutMs: 5_000, timeoutFactor: 2, incremental: true } });
    expect(md).toContain('Per-mutant timeout: 2 × dry-run test time + 5000 ms + overhead (a mutant that exceeds that deadline counts as detected)');
    expect(md).toContain('incremental: yes — verdicts for unchanged mutants are reused');
    const plain = renderSummary({ ...result, environment: { ...result.environment, timeoutMs: 60_000, timeoutFactor: 4, incremental: false } });
    expect(plain).toContain('Per-mutant timeout: 4 × dry-run test time + 60000 ms + overhead');
    expect(plain).toContain('incremental: no');
    // An older summary without the fields does not pass for the defaults.
    expect(renderSummary(result)).toContain('Per-mutant timeout: factor unrecorded × dry-run test time + unrecorded + overhead');
    expect(renderSummary(result)).toContain('incremental: unrecorded');
  });

  test('the markdown states the scope, the recorded load and the verdict', () => {
    const md = renderSummary(result);
    expect(md).toContain('# Scoped mutation run — smoke');
    expect(md).toContain('mutated: `src/core/tool-request-grant.ts:73-84`');
    expect(md).toContain('tests: `test/tool-request-grant.test.js`');
    expect(md).toContain('Load average before/after: 2.10/1.90/1.80 → 3.40/2.20/1.90');
    expect(md).toContain('Concurrency: 2 of 10 available');
    expect(md).toContain('| `test/tool-request-grant.test.js` | 1 | 1 |');
    expect(md).toContain('PASS');
  });

  test('a test file that covers mutants but kills none still gets its attribution row', () => {
    // Every covered mutant survived: `killedByTest` is empty, and that
    // "covered but no longer killed" row is the evidence the table exists for.
    const summary = summarizeMutationReport(
      { files: { 'src/core/tool-request-grant.ts': { mutants: [{ id: '1', mutatorName: 'StringLiteral', status: 'Survived', location: { start: { line: 74 } }, coveredBy: ['t1'] }] } }, testFiles: { 'test/tool-request-grant.test.js': { tests: [{ id: 't1' }] } } },
      {},
    );
    expect(summary.killedByTest).toEqual({});
    const md = renderSummary({ ...result, summary });
    expect(md).toContain('### Detections per test file');
    expect(md).toContain('| `test/tool-request-grant.test.js` | 0 | 1 |');
  });

  test('a run with no report says so instead of implying a clean result', () => {
    const md = renderSummary({ ...result, mode: 'dry-run', summary: null, verdict: null });
    expect(md).toContain('No mutation report was produced');
  });

  test('a dry run renders the two numbers it exists to produce, and the basis of the projection', () => {
    const facts = { filesMutated: 2, filesConsidered: 716, mutants: 742, tests: 180, netMs: 179_927, overheadMs: 1387 };
    const md = renderSummary({
      ...result,
      mode: 'dry-run',
      environment: { ...result.environment, concurrency: 1 },
      dryRun: { facts, cost: dryRunCost(facts, { concurrency: 1, coverageAnalysis: 'off' }), source: RUN_LOG, reason: null },
      summary: null,
      verdict: null,
    });
    expect(md).toContain('## Dry run');
    expect(md).toContain('Mutants instrumented: 742 across 2 file(s) of 716 considered');
    expect(md).toContain('One pass over the scoped suites: 180 test(s)');
    expect(md).toContain('Reference cost of a full run at concurrency 1: **37 h 22 min**');
    // The arithmetic is shown so the figure can be redone at another concurrency.
    expect(md).toContain('(742 × 181.3 s ÷ 1)');
    expect(md).toMatch(/Basis: one full pass/);
  });

  test('a dry run that recorded nothing says why, and states no cost', () => {
    // The foreground case: Stryker wrote to the caller's console, so there is no
    // log this run owns. It must read as "not recorded here", never as a small
    // number or a clean result.
    const md = renderSummary({
      ...result,
      mode: 'dry-run',
      dryRun: { facts: null, cost: null, source: null, reason: 'Stryker’s output went to the caller’s console rather than to a log this run owns.' },
      summary: null,
      verdict: null,
    });
    expect(md).toContain('Mutants instrumented: not reported by this run');
    expect(md).toContain('No cost projection: Stryker’s output went to the caller’s console');
    expect(md).not.toContain('Reference cost');
  });

  test('every other mode renders no dry-run section at all', () => {
    expect(renderSummary(result)).not.toContain('## Dry run');
  });

  test('a lost console is stated in words, not only in the reason code', () => {
    // The symptom of this interruption is a non-zero Stryker exit, which is the
    // one interruption that can be mistaken for a result about the tests.
    const md = renderSummary({
      ...result,
      run: { ...result.run, state: 'interrupted', reason: 'console-closed:EPIPE', consoleLost: 'EPIPE' },
      summary: null,
      verdict: null,
    });
    expect(md).toContain("This run's console was lost (`EPIPE`) before it finished.");
    expect(md).toContain('Nothing here is');
    expect(renderSummary(result)).not.toContain('console was lost');
  });

  test('a console lost after the run finished does not contradict the result it carries', () => {
    // `classifyStrykerRun` keeps a run that exited zero with its report written
    // as `complete (passed)`: the pipe broke after Stryker was done. Saying here
    // that Stryker died and that none of this is evidence would contradict both
    // that state and the zero exit `:report` relays for it.
    const run = { ...result.run, ...classifyStrykerRun({ exitCode: 0, reportPresent: true, consoleLost: 'EPIPE' }), consoleLost: 'EPIPE' };
    expect(run).toMatchObject({ state: 'complete', reason: 'passed' });
    const md = renderSummary({ ...result, run });
    expect(md).toContain("This run's console was lost (`EPIPE`), but that is not what decided its state");
    expect(md).toContain('complete (passed)');
    expect(md).not.toContain('Nothing here is');
    expect(md).not.toContain('died on the broken pipe');
    // The result it did produce is still rendered as one.
    expect(md).toContain('## Result');
  });

  test('a table cell escapes the delimiters and fences the backticks it carries', () => {
    // Plain cells: the backslash goes first, so a backslash already in the
    // value cannot swallow the escape added to the pipe behind it.
    expect(markdownCell('a | b')).toBe('a \\| b');
    expect(markdownCell('trailing \\| pipe')).toBe('trailing \\\\\\| pipe');
    expect(markdownCell('two\nlines')).toBe('two lines');
    expect(markdownCell(undefined)).toBe('');
    // Code cells: backslash escapes do not apply inside a code span, so only
    // the pipe is escaped, and the fence grows past the longest backtick run.
    expect(markdownCodeCell('a | b')).toBe('`a \\| b`');
    expect(markdownCodeCell('a ``b`` c')).toBe('```a ``b`` c```');
    expect(markdownCodeCell('`padded`')).toBe('`` `padded` ``');
    expect(markdownCodeCell('')).toBe('');
    expect(markdownCodeCell(null)).toBe('');
  });

  test('backslash runs before pipes and embedded backticks stay in one cell and read back verbatim', () => {
    const values = [
      'a\\|b',
      'a\\\\|b',
      '\\\\\\|',
      '||',
      'a\\',
      '\\',
      '`\\|`',
      'a ``\\|`` b',
      '`',
      'x\\`|',
    ];
    for (const value of values) {
      const cells = gfmRowCells(`| ${markdownCodeCell(value)} |`);
      expect(cells).toHaveLength(1);
      expect(codeSpanText(cells[0])).toBe(value);
      // The plain-cell form stays one cell too; its backslash escapes are
      // inline syntax, so only the cell count is a parser-independent fact.
      expect(gfmRowCells(`| ${markdownCell(value)} |`)).toHaveLength(1);
    }
  });

  test('a mutant carrying table syntax is escaped rather than splitting its row', () => {
    // Stryker mutates `||` to `&&` and back, so a survivor whose replacement
    // holds `||` is ordinary output for the accepted sources — interpolated
    // raw it adds two cells to its row and the published table stops parsing.
    const md = renderSummary({
      ...result,
      summary: summarizeMutationReport(
        {
          files: {
            'src/core/chain-linear.ts': {
              mutants: [
                { id: '1', mutatorName: 'LogicalOperator', status: 'Survived', location: { start: { line: 12 } }, replacement: 'a || b' },
                { id: '2', mutatorName: 'StringLiteral', status: 'Survived', location: { start: { line: 13 } }, replacement: '`head` ?? ""' },
                { id: '3', mutatorName: 'BlockStatement', status: 'CompileError', location: { start: { line: 14 } }, statusReason: 'bad | reason \\ here' },
              ],
            },
          },
        },
        {},
      ),
    });
    const row = (needle) => md.split('\n').find((line) => line.includes(needle));
    // Five columns before and after escaping: the header's, not seven.
    const cells = (line) => line.split(/(?<!\\)\|/).length;
    expect(cells(row('LogicalOperator'))).toBe(cells('| File | Line | Mutator | Status | Replacement |'));
    expect(row('LogicalOperator')).toContain('`a \\|\\| b`');
    // A replacement containing a backtick is fenced wider so its code span closes.
    expect(row('StringLiteral')).toContain('`` `head` ?? "" ``');
    expect(cells(row('BlockStatement'))).toBe(cells('| File | Line | Mutator | Status | Reason |'));
    expect(row('BlockStatement')).toContain('bad \\| reason \\\\ here');
  });

  test('a failing verdict lists why', () => {
    const md = renderSummary({ ...result, verdict: { ok: false, detected: 0, errorCount: 0, reasons: ['no mutant was detected'] } });
    expect(md).toContain('FAIL');
    expect(md).toContain('- no mutant was detected');
  });
});
