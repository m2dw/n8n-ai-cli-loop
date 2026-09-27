#!/usr/bin/env node
/**
 * Issue #1109 — an opt-in, reproducible test-cost baseline (Test Maintenance
 * Pilot, slice 1). Nothing in the default verification path calls this script.
 *
 * `npm test` runs `pretest` (the full build) before Jest, so its wall time mixes
 * build and test cost. This script times the two separately:
 *
 *   1. `npm run build` once, as its own timed command;
 *   2. Jest directly (`node --experimental-vm-modules node_modules/jest/bin/jest.js
 *      --json --outputFile=...`), `--repeat` times, so `pretest` never re-runs
 *      inside a test measurement.
 *
 * Per-suite durations and test counts come ONLY from the JSON file Jest writes
 * when a run finishes. A run that times out, is killed, or leaves no parseable
 * JSON is recorded as `interrupted` with every per-suite value `unknown`; the
 * last suite Jest happened to print is never charged for the timeout. Stale JSON
 * from an earlier run is deleted before each run so it cannot stand in for a
 * missing one.
 *
 * Other projects may share the host. The script records load average and free
 * memory around every command instead of assuming exclusive access, bounds its
 * own parallelism only through the optional `--max-workers` it passes to Jest
 * (capped at the process's available parallelism),
 * and on timeout signals only the process group it started.
 *
 * Raw Jest JSON stays under `--out` (default `.test-cost/`, gitignored). The
 * sanitized summary (`baseline.json`) and markdown (`report.md`) are written
 * there too; a reviewed copy of the markdown is what gets checked in.
 *
 * Run: node scripts/test-cost-baseline.mjs [--repeat <1-3>] [--max-workers <n>]
 *        [--build-timeout-min <n>] [--test-timeout-min <n>] [--top <n>]
 *        [--out <dir>] [--skip-build]
 */
import { spawn, execFileSync } from 'child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { arch, availableParallelism, cpus, freemem, homedir, loadavg, platform, release, tmpdir, totalmem } from 'os';
import { isAbsolute, join, relative, resolve, sep, win32 } from 'path';
import { pathToFileURL } from 'url';

export const MAX_REPEAT = 3;
export const DEFAULT_TOP = 20;
/**
 * Jest's JavaScript entry point. `node_modules/.bin/jest` is a shell shim on
 * Windows (`jest.cmd`/`jest` sh script), which `node` cannot execute.
 */
export const JEST_ENTRY = 'node_modules/jest/bin/jest.js';

// ---------------------------------------------------------------------------
// Pure helpers — exported for testing
// ---------------------------------------------------------------------------

/**
 * Parse and bound CLI options. Throws on anything unknown or out of range.
 * `--max-workers` is capped at the process's available parallelism (the same
 * bound Jest and `resolveJestWorkers()` use, which honours CPU affinity and
 * container quotas) so a mistyped value cannot oversubscribe a shared host.
 */
export function parseArgs(argv, { parallelism = hostParallelism() } = {}) {
  const maxWorkersLimit = Math.max(1, parallelism);
  const options = {
    repeat: 1,
    maxWorkers: undefined,
    buildTimeoutMin: 15,
    testTimeoutMin: 45,
    top: DEFAULT_TOP,
    out: '.test-cost',
    skipBuild: false,
  };
  const positiveInt = (name, value, max) => {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || (max !== undefined && n > max)) {
      throw new Error(`invalid ${name}: ${value}${max !== undefined ? ` (1-${max})` : ''}`);
    }
    return n;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--skip-build') {
      options.skipBuild = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`missing value for ${arg}`);
    i += 1;
    if (arg === '--repeat') options.repeat = positiveInt(arg, value, MAX_REPEAT);
    else if (arg === '--max-workers') options.maxWorkers = positiveInt(arg, value, maxWorkersLimit);
    else if (arg === '--build-timeout-min') options.buildTimeoutMin = positiveInt(arg, value, 120);
    else if (arg === '--test-timeout-min') options.testTimeoutMin = positiveInt(arg, value, 180);
    else if (arg === '--top') options.top = positiveInt(arg, value, 100);
    else if (arg === '--out') options.out = value;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

/**
 * Windows drive (`C:\`, `c:/`) and UNC (`\\server`) paths are case-insensitive,
 * so their prefixes must match regardless of casing; POSIX paths stay exact.
 */
function isWindowsStylePath(prefix) {
  return /^[A-Za-z]:(?:[\\/]|$)/.test(prefix) || /^[\\/]{2}[^\\/]/.test(prefix);
}

/**
 * Rewrite absolute paths so no checkout, home or temp location leaks into a
 * published report. `output` is an optional caller-chosen output root that may
 * live outside all three (an absolute `--out`); it is masked as `<out>`.
 * `outputReal` is that same root with symlinks resolved, masked as `<out>` too:
 * a process started inside it reports its canonical working directory, not the
 * symlink the caller was given.
 */
export function sanitizePath(path, { root, home, tmp, output, outputReal } = {}) {
  let out = String(path).replace(/\\/g, '/');
  const prefixes = [
    [root, ''],
    [output, '<out>/'],
    [outputReal, '<out>/'],
    [tmp, '<tmp>/'],
    [home, '<home>/'],
  ];
  for (const [prefix, replacement] of prefixes) {
    if (!prefix) continue;
    const normalized = String(prefix).replace(/\\/g, '/').replace(/\/+$/, '');
    const fold = isWindowsStylePath(String(prefix)) ? (s) => s.toLowerCase() : (s) => s;
    const candidate = fold(out);
    const target = fold(normalized);
    if (candidate === target) return replacement === '' ? '.' : replacement.slice(0, -1);
    if (candidate.startsWith(`${target}/`)) return `${replacement}${out.slice(normalized.length + 1)}`;
  }
  return out;
}

/**
 * Mask checkout, home and temp locations embedded anywhere in free text such as
 * a failed test's name, which can quote a path mid-string. `output` is masked
 * as `<out>`, and so is `outputReal`, as in `sanitizePath`.
 */
export function sanitizeText(text, { root, home, tmp, output, outputReal } = {}) {
  let out = String(text);
  const prefixes = [
    [root, '.'],
    [output, '<out>'],
    [outputReal, '<out>'],
    [tmp, '<tmp>'],
    [home, '<home>'],
  ];
  for (const [prefix, replacement] of prefixes) {
    if (!prefix) continue;
    const normalized = String(prefix).replace(/\\/g, '/').replace(/\/+$/, '');
    if (!normalized) continue;
    const flags = isWindowsStylePath(String(prefix)) ? 'gi' : 'g';
    // Every separator matches either `/` or `\`, so a mixed-separator Windows
    // path such as `C:\Work/Repo` is masked too.
    const pattern = normalized
      .split('/')
      .map((segment) => segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('[\\\\/]');
    // Only a whole path component matches: `/work/repo` must not rewrite `/work/repository`.
    out = out.replace(new RegExp(`${pattern}(?![\\w.-])`, flags), replacement);
  }
  return out;
}

/**
 * Classify one timed command. `complete` means the command ran to its own exit
 * (possibly with failures) and, for Jest, left results; anything else is
 * `interrupted` and its per-suite values stay unknown.
 *
 * A process group that outlived SIGKILL is checked first: whatever the leader's
 * exit said, part of the run is still loading the host, so the command neither
 * finished nor left a measurement that can be trusted.
 */
export function classifyRun({ exitCode, signal, timedOut, interruptedBy, groupSurvived, resultsPresent = true }) {
  if (groupSurvived) return { state: 'interrupted', reason: 'group-survived' };
  if (interruptedBy) return { state: 'interrupted', reason: `parent-signal:${interruptedBy}` };
  if (timedOut) return { state: 'interrupted', reason: 'timeout' };
  if (signal) return { state: 'interrupted', reason: `signal:${signal}` };
  if (!resultsPresent) return { state: 'interrupted', reason: 'no-results' };
  return { state: 'complete', reason: exitCode === 0 ? 'passed' : `exit:${exitCode}` };
}

/**
 * The CLI's exit status: 1 when any recorded command was interrupted (timeout,
 * direct signal, missing results or a parent signal) or the build exited nonzero
 * (its test runs were skipped), so a wrapper never accepts an incomplete baseline.
 * A complete Jest run with assertion failures still exits 0.
 */
export function exitCodeFor(commands) {
  const failed = (c) => c.state === 'interrupted' || (c.phase === 'build' && c.exitCode !== 0);
  return commands.some(failed) ? 1 : 0;
}

/**
 * Summarize one Jest `--json` result. Suite duration is Jest's per-file wall
 * time including module load — `endTime - startTime` in the `--json` output
 * (`perfStats` only in the internal result shape) — so suites overlap when more
 * than one worker runs and their sum exceeds the run's wall time. A suite that
 * failed to load reports zero timestamps; its duration is unknown, not 0.
 */
export function summarizeJestResults(results, paths = {}) {
  const suites = (results.testResults ?? []).map((suite) => {
    const assertions = suite.assertionResults ?? [];
    const count = (status) => assertions.filter((a) => a.status === status).length;
    const perf = suite.perfStats ?? {};
    const span = (start, end) => (typeof start === 'number' && typeof end === 'number' && start > 0 && end >= start ? end - start : null);
    const durationMs =
      typeof perf.runtime === 'number' ? perf.runtime : (span(perf.start, perf.end) ?? span(suite.startTime, suite.endTime));
    return {
      file: sanitizePath(suite.name ?? suite.testFilePath ?? '<unknown>', paths),
      durationMs,
      tests: assertions.length,
      failed: count('failed'),
      skipped: count('pending') + count('todo') + count('skipped'),
      // A suite failed outside its assertions — failed to load, or failed in a
      // hook such as afterAll after its assertions passed.
      suiteError: (suite.status === 'failed' && count('failed') === 0) || Boolean(suite.testExecError),
      failedTests: assertions.filter((a) => a.status === 'failed').map((a) => sanitizeText(a.fullName ?? a.title ?? '', paths)),
      // Positive evidence of execution: a test absent here was not observed passing.
      passedTests: assertions.filter((a) => a.status === 'passed').map((a) => sanitizeText(a.fullName ?? a.title ?? '', paths)),
    };
  });
  return {
    totals: {
      suites: results.numTotalTestSuites ?? suites.length,
      failedSuites: results.numFailedTestSuites ?? null,
      runtimeErrorSuites: results.numRuntimeErrorTestSuites ?? null,
      tests: results.numTotalTests ?? null,
      passed: results.numPassedTests ?? null,
      failed: results.numFailedTests ?? null,
      skipped: (results.numPendingTests ?? 0) + (results.numTodoTests ?? 0),
      // One unknown suite duration makes the sum unknown; a partial sum would understate cost.
      suiteDurationSumMs: suites.some((s) => s.durationMs === null)
        ? null
        : suites.reduce((sum, s) => sum + s.durationMs, 0),
    },
    suites,
  };
}

/**
 * Compare repeated complete runs. A test that failed in every complete run is a
 * consistent failure. A test that failed in some run and was observed PASSING in
 * another is a flake candidate. Absence is not a pass: a failure whose other runs
 * never executed the test (its suite failed to load, say) is unclassified. The
 * same rule applies to suite errors, where the counter-evidence is the suite
 * running cleanly (no suite error and no failed tests). Interrupted runs
 * contribute nothing.
 */
export function compareRuns(runs) {
  const complete = runs.filter((run) => run.state === 'complete' && run.summary);
  const failures = new Map();
  const passes = new Map();
  const suiteErrors = new Map();
  const cleanSuites = new Map();
  const bump = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);
  for (const run of complete) {
    // Count each key at most once per run: duplicate titles (repeated names,
    // duplicate test.each values) must not inflate the cross-run count.
    const runFailures = new Set();
    const runPasses = new Set();
    const runSuiteErrors = new Set();
    const runCleanSuites = new Set();
    for (const suite of run.summary.suites) {
      for (const name of suite.failedTests) runFailures.add(`${suite.file} › ${name}`);
      for (const name of suite.passedTests ?? []) runPasses.add(`${suite.file} › ${name}`);
      if (suite.suiteError) runSuiteErrors.add(suite.file);
      // A suite with failing tests is not clean evidence against a suite error elsewhere.
      else if (suite.failedTests.length === 0) runCleanSuites.add(suite.file);
    }
    for (const key of runFailures) bump(failures, key);
    // A title that both passed and failed in one run (a duplicate name) is not a clean pass.
    for (const key of runPasses) if (!runFailures.has(key)) bump(passes, key);
    for (const file of runSuiteErrors) bump(suiteErrors, file);
    for (const file of runCleanSuites) if (!runSuiteErrors.has(file)) bump(cleanSuites, file);
  }
  const split = (failed, succeeded) => {
    const out = { consistent: [], intermittent: [], unclassified: [] };
    for (const [key, n] of failed) {
      if (n === complete.length) out.consistent.push(key);
      else if ((succeeded.get(key) ?? 0) > 0) out.intermittent.push(key);
      else out.unclassified.push(key);
    }
    for (const list of Object.values(out)) list.sort();
    return out;
  };
  const tests = split(failures, passes);
  const suites = split(suiteErrors, cleanSuites);
  const suiteLabel = (f) => `${f} (suite error)`;
  return {
    completeRuns: complete.length,
    interruptedRuns: runs.length - complete.length,
    consistentFailures: [...tests.consistent, ...suites.consistent.map(suiteLabel)],
    flakeCandidates: [...tests.intermittent, ...suites.intermittent.map(suiteLabel)],
    unclassifiedFailures: [...tests.unclassified, ...suites.unclassified.map(suiteLabel)],
  };
}

/**
 * Rank suites by duration across complete runs (median of the observed values).
 * Suites never observed in a complete run are not ranked.
 */
export function rankSuites(runs, top = DEFAULT_TOP) {
  const observed = new Map();
  for (const run of runs) {
    if (run.state !== 'complete' || !run.summary) continue;
    for (const suite of run.summary.suites) {
      if (suite.durationMs === null) continue;
      const entry = observed.get(suite.file) ?? { file: suite.file, durations: [], tests: suite.tests };
      entry.durations.push(suite.durationMs);
      observed.set(suite.file, entry);
    }
  }
  const median = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
  };
  return [...observed.values()]
    .map((entry) => ({
      file: entry.file,
      tests: entry.tests,
      medianMs: median(entry.durations),
      maxMs: Math.max(...entry.durations),
      samples: entry.durations.length,
    }))
    .sort((a, b) => b.medianMs - a.medianMs || a.file.localeCompare(b.file))
    .slice(0, top);
}

/** Setup-cost indicators found by reading a test file's source (static counts, not runtime). */
export const INVENTORY_PATTERNS = {
  subprocessCalls: /\b(?:spawnSync|spawn|execFileSync|execFile|execSync|fork)\(/g,
  tempDirs: /mkdtemp/g,
  gitInits: /\['init'|'init',/g,
  sqlite: /better-sqlite3|Sqlite/g,
};

export function inventorySource(text) {
  return Object.fromEntries(
    Object.entries(INVENTORY_PATTERNS).map(([key, pattern]) => [key, (text.match(pattern) ?? []).length]),
  );
}

const seconds = (ms) => (ms === null || ms === undefined ? 'unknown' : `${(ms / 1000).toFixed(1)}s`);

/** Most failure entries listed per category in `report.md`; the rest are counted, not listed. */
export const MAX_LISTED_FAILURES = 20;

/** Join at most `limit` entries and state how many were omitted. */
export function boundedList(items, limit = MAX_LISTED_FAILURES) {
  if (items.length === 0) return 'none observed';
  const shown = items.slice(0, limit).join('; ');
  const omitted = items.length - limit;
  return omitted > 0 ? `${shown}; … (${omitted} more omitted; see baseline.json)` : shown;
}

/** Recorded when a cleanliness check did not run because no build ran. */
export const DIRTY_NOT_MEASURED = 'not measured (build skipped)';

/** The files this script writes under `--out` for a given `--repeat` count. */
export function outArtifactNames(repeat) {
  const names = ['baseline.json', 'report.md'];
  for (let index = 1; index <= repeat; index += 1) names.push(`jest-run-${index}.json`);
  return names;
}

/**
 * `git status --porcelain` arguments for the post-build cleanliness check.
 * `npm run build` regenerates the checked-in workflow JSON when it is stale, so
 * the build itself can modify tracked files after the pre-build check — which
 * would make the reported commit no longer describe what Jest then measured.
 * Only the individual files this script writes are excluded, never the whole
 * `--out` directory: pointing `--out` at an existing tracked directory such as
 * `docs/` must not hide the regenerated workflow JSON that lives beside it.
 * Each exclusion uses `literal` magic so an `--out` path containing pathspec
 * metacharacters (`*`, `?`, `[`) hides exactly that file and nothing else.
 */
export function statusArgsExcludingOut(root, out, repeat = 1) {
  const rel = relative(root, out);
  // Outside the checkout means the path escapes it (`..` itself, or a leading
  // `..` *segment*) or is unrelated. A name that merely begins with two dots,
  // such as `..cache`, is an ordinary in-tree directory.
  const escapes = rel === '..' || rel.startsWith(`..${sep}`) || rel.startsWith('../');
  if (escapes || isAbsolute(rel)) return ['status', '--porcelain'];
  const prefix = rel === '' ? '' : `${rel.split(sep).join('/')}/`;
  return [
    'status',
    '--porcelain',
    '--',
    '.',
    ...outArtifactNames(repeat).map((name) => `:(exclude,literal)${prefix}${name}`),
  ];
}

/** Porcelain output (or `'unknown'`) → the value recorded for a `worktreeDirty*` field. */
export function dirtyFlag(status) {
  return status === 'unknown' ? 'unknown' : String(status.trim().length > 0);
}

/**
 * Bounded list of the paths a porcelain status reports, with the two status
 * columns dropped so the report names the files that changed.
 */
export function dirtyPathList(status) {
  if (status === 'unknown') return 'unknown';
  const paths = status
    .split('\n')
    .map((line) => line.slice(3).trim())
    .filter((path) => path.length > 0);
  return boundedList(paths);
}

/**
 * The Jest command as recorded in the summary: the output file is shown under
 * the sanitized `--out` directory so no absolute checkout, home or temp path leaks.
 */
/**
 * How to launch npm without a shell. On Windows npm is `npm.cmd`, which
 * `spawn` cannot start without `shell: true`, so npm's own CLI script is run
 * with this Node instead: the one npm reports in `npm_execpath` when the script
 * was started through npm, otherwise the copy bundled next to `node.exe`.
 */
export function npmInvocation(args, { platform: os = platform(), execPath = process.execPath, env = process.env } = {}) {
  const execpath = env.npm_execpath;
  if (typeof execpath === 'string' && /\.c?js$/i.test(execpath)) {
    return { command: execPath, args: [execpath, ...args] };
  }
  if (os === 'win32') {
    return { command: execPath, args: [win32.join(win32.dirname(execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'), ...args] };
  }
  return { command: 'npm', args };
}

export function displayJestCommand(args, outDir, index, paths = {}) {
  const shownOut = sanitizePath(outDir, paths);
  return `node ${args
    .map((a) => (a.startsWith('--outputFile=') ? `--outputFile=${shownOut}/jest-run-${index}.json` : a))
    .map(shellQuote)
    .join(' ')}`;
}

/**
 * POSIX single-quote an argument unless it consists only of characters the
 * shell never splits or interprets, so a displayed command replays verbatim.
 */
export function shellQuote(arg) {
  const value = String(arg);
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The worker count Jest actually uses. With no `--max-workers` (and no
 * `maxWorkers` in the project's Jest config) Jest 29 runs
 * `max(availableParallelism - 1, 1)` workers outside watch mode, so the
 * resolved number is recorded to keep reports from different hosts comparable.
 */
export function resolveJestWorkers(maxWorkers, { parallelism = hostParallelism() } = {}) {
  if (maxWorkers !== undefined) return `${maxWorkers} (--maxWorkers=${maxWorkers})`;
  return `${Math.max(parallelism - 1, 1)} (jest default: max(availableParallelism ${parallelism} - 1, 1))`;
}

function hostParallelism() {
  return typeof availableParallelism === 'function' ? availableParallelism() : Math.max(1, cpus().length);
}

/**
 * Escape a value for a GFM table cell. The table parser splits rows on
 * unescaped `|` before inline parsing, so a pipe carried in by a path, command
 * or suite name has to be written as `\|`; the backslash itself is escaped
 * first so it cannot consume the marker that follows.
 */
export function mdCell(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
}

/**
 * Escape a value rendered as a code span inside a table cell. A backtick cannot
 * be escaped inside a code span, so the fence is widened past the longest
 * backtick run in the value (and padded when the value itself starts or ends
 * with one). Pipes still need `\|`, which GFM unescapes inside code spans;
 * backslashes are otherwise literal in a code span and are left alone.
 */
export function mdCodeCell(value) {
  const text = String(value).replace(/\|/g, '\\|');
  const runs = [...text.matchAll(/`+/g)].map((m) => m[0].length);
  const fence = '`'.repeat(Math.max(0, ...runs) + 1);
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}

/** Render the sanitized baseline as markdown. */
export function renderReport(baseline) {
  const lines = [];
  const env = baseline.environment;
  lines.push('# Test-cost baseline (generated)', '');
  lines.push('| Field | Value |', '|---|---|');
  for (const [key, value] of Object.entries(env)) lines.push(`| ${mdCell(key)} | ${mdCell(value)} |`);
  lines.push(
    '',
    '## Commands',
    '',
    '| Phase | Command | State | Wall time | Load before → after | Free memory after |',
    '|---|---|---|---|---|---|',
  );
  for (const cmd of baseline.commands) {
    const freeMem = typeof cmd.freeMemMbAfter === 'number' ? `${cmd.freeMemMbAfter} MB` : 'unknown';
    lines.push(
      `| ${mdCell(cmd.phase)} | ${mdCodeCell(cmd.command)} | ${mdCell(cmd.state)} (${mdCell(cmd.reason)}) | ${seconds(cmd.wallMs)} | ${mdCell(cmd.loadBefore)} → ${mdCell(cmd.loadAfter)} | ${freeMem} |`,
    );
  }
  lines.push('', '## Test totals per run', '');
  lines.push('| Run | Suites | Tests | Passed | Failed | Skipped | Sum of suite durations |', '|---|---|---|---|---|---|---|');
  for (const run of baseline.runs) {
    const t = run.summary?.totals;
    const v = (x) => (t && x !== null && x !== undefined ? x : 'unknown');
    lines.push(
      `| ${run.index} (${run.state}) | ${v(t?.suites)} | ${v(t?.tests)} | ${v(t?.passed)} | ${v(t?.failed)} | ${v(t?.skipped)} | ${t ? seconds(t.suiteDurationSumMs) : 'unknown'} |`,
    );
  }
  lines.push('', `## Top ${baseline.top.length} suites by median duration (complete runs only)`, '');
  lines.push('| Suite | Tests | Median | Max | Samples |', '|---|---|---|---|---|');
  for (const s of baseline.top)
    lines.push(`| ${mdCell(s.file)} | ${mdCell(s.tests)} | ${seconds(s.medianMs)} | ${seconds(s.maxMs)} | ${mdCell(s.samples)} |`);
  if (baseline.top.length === 0) lines.push('| unknown (no complete run) | | | | |');
  const cmp = baseline.comparison;
  lines.push('', '## Failures', '');
  lines.push(`Complete runs: ${cmp.completeRuns}; interrupted runs: ${cmp.interruptedRuns}.`, '');
  lines.push(`Consistent failures (${cmp.consistentFailures.length}): ${boundedList(cmp.consistentFailures)}`);
  lines.push(`Flake candidates (${cmp.flakeCandidates.length}): ${boundedList(cmp.flakeCandidates)}`);
  const unclassified = cmp.unclassifiedFailures ?? [];
  lines.push(
    `Unclassified failures — not executed in every other complete run (${unclassified.length}): ${boundedList(unclassified)}`,
  );
  lines.push('');
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// Process effects
// ---------------------------------------------------------------------------

const loadString = () => loadavg().map((n) => n.toFixed(2)).join('/');

/**
 * Run a command in its own process group with a deadline. On timeout only that
 * group is signalled (SIGTERM, then SIGKILL after a grace period).
 *
 * The group is detached, so an outer deadline that kills this script (for
 * example a wrapper's own timeout) would otherwise leave Jest running on a
 * shared host. SIGTERM/SIGINT/SIGHUP received by this process are therefore
 * forwarded to the group the same way, and the result records `interruptedBy`.
 */
export const PARENT_SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP'];

/**
 * Windows has no process groups: `child.kill` stops only the npm/Node leader and
 * leaves Jest workers running. `taskkill /T /F` terminates the whole tree rooted
 * at the leader; it must run while the leader is alive, since the tree is found
 * through parent process ids.
 */
export function windowsTreeKillArgs(pid) {
  return ['/pid', String(pid), '/T', '/F'];
}

/**
 * Windows does not reparent orphans: a Jest worker keeps its dead leader's pid
 * as ParentProcessId. Once the leader itself is gone (killed directly, say),
 * `taskkill /T` on its pid finds nothing, so the tree is rebuilt from a process
 * table instead. Only processes created at or after the leader's start are
 * followed, so a recycled pid cannot pull an unrelated process into the tree.
 */
export const WINDOWS_PROCESS_TABLE_SCRIPT =
  "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId) $($_.ParentProcessId) $($_.CreationDate.ToUniversalTime().ToString('o'))\" }";

/** Parse `pid ppid ISO-creation-time` lines; malformed lines are skipped. */
export function parseWindowsProcessTable(text) {
  const table = [];
  for (const line of String(text).split(/\r?\n/)) {
    const [pid, ppid, created] = line.trim().split(/\s+/);
    const createdMs = Date.parse(created);
    if (!/^\d+$/.test(pid ?? '') || !/^\d+$/.test(ppid ?? '') || Number.isNaN(createdMs)) continue;
    table.push({ pid: Number(pid), ppid: Number(ppid), createdMs });
  }
  return table;
}

/**
 * Pids of the processes descending from `rootPid` (excluding the root), limited
 * to those created no earlier than `startedMs` minus a clock tolerance.
 */
export function windowsDescendantPids(table, rootPid, startedMs, toleranceMs = 2_000) {
  const eligible = table.filter((entry) => entry.pid !== rootPid && entry.createdMs >= startedMs - toleranceMs);
  const found = new Set();
  let frontier = [rootPid];
  while (frontier.length > 0) {
    const parents = new Set(frontier);
    frontier = [];
    for (const entry of eligible) {
      if (parents.has(entry.ppid) && !found.has(entry.pid)) {
        found.add(entry.pid);
        frontier.push(entry.pid);
      }
    }
  }
  return [...found];
}

function windowsProcessTable() {
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_PROCESS_TABLE_SCRIPT], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 15_000,
    });
    return parseWindowsProcessTable(out);
  } catch {
    return undefined;
  }
}

/**
 * `env` is optional and defaults to inheriting this process's environment, the
 * behaviour every caller here relies on. `scripts/mutation-pilot.mjs` passes an
 * explicit environment so it can hand the run its spec and strip the Stryker
 * dashboard key.
 *
 * `onGroup(pid, { group })` is called synchronously in this same tick, with
 * `group: true` where the child was detached and its pid is therefore a
 * process-group id. It exists for a caller that must record what it started
 * before anything can await it: this function stops the group on every ending it
 * controls, but a caller killed outright leaves the group running, and whatever
 * has to survive that kill — an ownership lock, a report — needs the id written
 * down first. It is called last, once the timeout, signal and exit handling is
 * in place, because a failure in it is exactly the case where the group must not
 * be left running: a caller that could not record the group has nothing that
 * will stop it later, so the group is stopped here and the returned promise
 * rejects with the caller's error only once nothing of it is left.
 */
export function runTimed(command, args, { cwd, timeoutMs, graceMs = 10_000, stdio = 'inherit', env, signalSource = process, onGroup }) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const loadBefore = loadString();
    const isWindows = process.platform === 'win32';
    const child = spawn(command, args, { cwd, stdio, env, detached: !isWindows });
    let timedOut = false;
    let interruptedBy;
    const leaderRunning = () => child.exitCode === null && child.signalCode === null;
    const windowsDescendants = () => windowsDescendantPids(windowsProcessTable() ?? [], child.pid, started);
    const taskkill = (pid) => {
      try {
        execFileSync('taskkill', windowsTreeKillArgs(pid), { stdio: 'ignore' });
      } catch {
        // The tree already exited.
      }
    };
    const signalGroup = (signal) => {
      if (isWindows) {
        // Kill the leader's tree while it is still reachable, then any orphaned
        // descendants left behind by a leader that had already exited.
        if (leaderRunning()) taskkill(child.pid);
        for (const pid of windowsDescendants()) taskkill(pid);
        return;
      }
      try {
        process.kill(-child.pid, signal);
      } catch {
        // The group already exited.
      }
    };
    let killTimer;
    const stopGroup = () => {
      if (killTimer) return;
      signalGroup('SIGTERM');
      killTimer = setTimeout(() => signalGroup('SIGKILL'), graceMs);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stopGroup();
    }, timeoutMs);
    // Node does not pass the signal name to `process.on(signal, listener)`
    // listeners, so bind each name into its own listener and keep it for cleanup.
    const parentListeners = PARENT_SIGNALS.map((name) => {
      const listener = () => {
        interruptedBy ??= name;
        stopGroup();
      };
      signalSource.on(name, listener);
      return [name, listener];
    });
    const groupAlive = () => {
      if (isWindows) return leaderRunning() || windowsDescendants().length > 0;
      try {
        process.kill(-child.pid, 0);
        return true;
      } catch (error) {
        return error.code === 'EPERM';
      }
    };
    // The leader exiting on SIGTERM does not mean descendants that ignore SIGTERM
    // have exited with it. Once the group was signalled, resolve only after it is
    // gone, so a following run never overlaps with the previous run's workers.
    // After SIGKILL the wait is bounded so an unkillable process cannot hang us;
    // a group still alive at that point is reported as `groupSurvived` (and, on
    // Windows, its remaining pids as `survivingPids`).
    const waitForGroup = (done) => {
      if (!killTimer || !groupAlive()) {
        clearTimeout(killTimer);
        done(false);
        return;
      }
      const giveUpAt = Date.now() + graceMs + 5_000;
      const poll = setInterval(() => {
        const alive = groupAlive();
        if (alive && Date.now() < giveUpAt) return;
        clearInterval(poll);
        clearTimeout(killTimer);
        done(alive);
      }, isWindows ? 1_000 : 100);
    };
    // Stamped the moment the child settles, before any descendant scan runs.
    // On Windows that scan shells out to PowerShell on every exit, so reading the
    // clock inside `finish` would charge the process-table walk to the command.
    let endedAt = null;
    const cleanup = () => {
      clearTimeout(timer);
      for (const [name, listener] of parentListeners) signalSource.off(name, listener);
    };
    // A caller that could not record the group gets that error, not a result:
    // stopping the group makes the child exit, and that ending must not be
    // reported as a run the caller can read. Whichever path settles first, both
    // settle on the record failure.
    let recordError;
    // On Windows there is no group id a caller could ask about later, so a group
    // that survived is reported as the pids still left of it. Elsewhere the
    // leader's pid is the group id and names every survivor already.
    const survivingPids = () => {
      if (!isWindows) return [];
      return [...(leaderRunning() ? [child.pid] : []), ...windowsDescendants()];
    };
    const finish = (exitCode, signal, spawnError) => waitForGroup((groupSurvived) => {
      cleanup();
      if (recordError) {
        reject(recordError);
        return;
      }
      resolve({
        exitCode,
        signal: spawnError ? `spawn-error:${spawnError.code ?? spawnError.message}` : signal,
        timedOut,
        interruptedBy,
        groupSurvived,
        survivingPids: groupSurvived ? survivingPids() : [],
        wallMs: (endedAt ?? Date.now()) - started,
        loadBefore,
        loadAfter: loadString(),
        freeMemMbAfter: Math.round(freemem() / 1024 / 1024),
      });
    });
    child.once('error', (error) => {
      endedAt = Date.now();
      finish(null, null, error);
    });
    child.once('exit', (code, signal) => {
      endedAt = Date.now();
      // A leader killed directly (an operator, OOM handling) leaves its detached
      // descendants running; stop and await the group as on a timeout. So does a
      // leader that exits with an ordinary code after spawning workers — an
      // uncaught exception, say — and a Windows leader killed externally reports
      // an exit code rather than a signal, so the group is checked on every exit:
      // a result must never resolve while anything the run started is still up.
      if (groupAlive()) stopGroup();
      finish(code, signal);
    });
    // Last, and still in this tick: the caller's record of the group exists
    // before anything can await the run, and every handler above is already
    // installed — so a failure here can stop and reap what was just started
    // instead of leaving an unrecorded group behind. `finish` still runs for the
    // exit that kill produces and reaches the promise first as often as not,
    // which is why `recordError` — not this path winning a race — is what decides
    // that the run rejects.
    // A spawn that failed outright has no pid, and there is nothing to report.
    if (onGroup && child.pid) {
      try {
        onGroup(child.pid, { group: !isWindows });
      } catch (error) {
        recordError = error;
        stopGroup();
        waitForGroup(() => {
          cleanup();
          reject(error);
        });
      }
    }
  });
}

function toolVersion(root, pkg) {
  try {
    return JSON.parse(readFileSync(join(root, 'node_modules', pkg, 'package.json'), 'utf8')).version;
  } catch {
    return 'unknown';
  }
}

function captureOrUnknown(command, args, cwd) {
  try {
    return execFileSync(command, args, { cwd, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

async function main(argv) {
  const options = parseArgs(argv);
  const root = process.cwd();
  const out = resolve(root, options.out);
  // Captured before any output exists: a non-ignored `--out` inside the checkout
  // would otherwise make a clean checkout look dirty.
  const dirty = captureOrUnknown('git', ['status', '--porcelain'], root);
  mkdirSync(out, { recursive: true });
  const paths = { root, home: homedir(), tmp: tmpdir() };
  const minutes = (n) => n * 60_000;
  const npmVersion = npmInvocation(['--version']);

  const environment = {
    measuredAt: new Date().toISOString(),
    commit: captureOrUnknown('git', ['rev-parse', 'HEAD'], root),
    worktreeDirty: dirtyFlag(dirty),
    // Filled in after the build, before the measured runs (see below).
    worktreeDirtyAfterBuild: DIRTY_NOT_MEASURED,
    worktreeDirtyAfterBuildPaths: DIRTY_NOT_MEASURED,
    node: process.version,
    npm: captureOrUnknown(npmVersion.command, npmVersion.args, root),
    jest: toolVersion(root, 'jest'),
    typescript: toolVersion(root, 'typescript'),
    platform: `${platform()} ${release()} ${arch()}`,
    cpus: cpus().length,
    totalMemMb: Math.round(totalmem() / 1024 / 1024),
    jestWorkers: resolveJestWorkers(options.maxWorkers),
    repeat: options.repeat,
  };

  const commands = [];
  const record = (phase, command, result, resultsPresent) => {
    const entry = { phase, command, ...result, ...classifyRun({ ...result, resultsPresent }) };
    commands.push(entry);
    return entry;
  };

  if (!options.skipBuild) {
    const npmBuild = npmInvocation(['run', 'build']);
    const build = await runTimed(npmBuild.command, npmBuild.args, { cwd: root, timeoutMs: minutes(options.buildTimeoutMin) });
    const entry = record('build', 'npm run build', build, true);
    if (build.interruptedBy) {
      process.stderr.write(`interrupted by ${build.interruptedBy}; test runs skipped (their cost stays unknown)\n`);
    } else if (entry.state !== 'complete' || build.exitCode !== 0) {
      process.stderr.write('build did not succeed; test runs skipped (their cost stays unknown)\n');
    }
    // The build regenerates the tracked workflow JSON when the checked-in copy
    // is stale, so the pre-build check alone can report a clean, commit-identical
    // measurement of code that no longer matches that commit. Recheck here —
    // after the build, before the first measured run — ignoring only this
    // script's own output files.
    const afterBuild = captureOrUnknown('git', statusArgsExcludingOut(root, out, options.repeat), root);
    environment.worktreeDirtyAfterBuild = dirtyFlag(afterBuild);
    environment.worktreeDirtyAfterBuildPaths = dirtyPathList(afterBuild);
  }
  const buildOk = options.skipBuild || (commands[0].state === 'complete' && commands[0].exitCode === 0);

  const runs = [];
  for (let index = 1; buildOk && index <= options.repeat; index += 1) {
    const outputFile = join(out, `jest-run-${index}.json`);
    rmSync(outputFile, { force: true });
    const args = ['--experimental-vm-modules', JEST_ENTRY, '--json', `--outputFile=${outputFile}`];
    if (options.maxWorkers !== undefined) args.push(`--maxWorkers=${options.maxWorkers}`);
    const result = await runTimed(process.execPath, args, { cwd: root, timeoutMs: minutes(options.testTimeoutMin) });
    let summary = null;
    if (!result.timedOut && !result.signal && existsSync(outputFile)) {
      try {
        summary = summarizeJestResults(JSON.parse(readFileSync(outputFile, 'utf8')), paths);
      } catch {
        summary = null;
      }
    }
    const command = displayJestCommand(args, out, index, paths);
    const entry = record(`test run ${index}`, command, result, summary !== null);
    runs.push({ index, state: entry.state, reason: entry.reason, summary: entry.state === 'complete' ? summary : null });
    if (result.groupSurvived) {
      // Part of this run is still up; a next run would overlap with it.
      process.stderr.write(`test run ${index}'s process group outlived SIGKILL; remaining test runs skipped\n`);
      break;
    }
    if (result.interruptedBy) {
      process.stderr.write(`interrupted by ${result.interruptedBy}; remaining test runs skipped\n`);
      break;
    }
    if (result.signal && !result.timedOut && index < options.repeat) {
      // Killed from outside this script: whatever did it may still be loading the host.
      process.stderr.write(`test run ${index} ended by ${result.signal}; remaining test runs skipped\n`);
      break;
    }
    if (result.timedOut && index < options.repeat) {
      // Even after group cleanup, a following run would be measured on a host still
      // recovering from the timed-out one.
      process.stderr.write(`test run ${index} timed out; remaining test runs skipped\n`);
      break;
    }
  }

  const inventory = readdirSync(join(root, 'test'))
    .filter((name) => /\.test\.(?:js|mjs|cjs)$/.test(name))
    .map((name) => ({ file: `test/${name}`, ...inventorySource(readFileSync(join(root, 'test', name), 'utf8')) }));

  const baseline = {
    environment,
    commands,
    runs,
    top: rankSuites(runs, options.top),
    comparison: compareRuns(runs),
    inventory,
  };
  writeFileSync(join(out, 'baseline.json'), `${JSON.stringify(baseline, null, 2)}\n`);
  writeFileSync(join(out, 'report.md'), renderReport(baseline));
  process.stdout.write(`wrote ${sanitizePath(out, paths)}/baseline.json and ${sanitizePath(out, paths)}/report.md\n`);
  if (exitCodeFor(commands) !== 0) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
