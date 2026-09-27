/**
 * changed-file-stage-timing.mjs — Issue #1156.
 *
 * Bounded, opt-in measurement of the two stages this repository's own
 * `stagedVerification` binding runs
 * (`docs/changed-file-verification-contract.md` §4 and §6): Stage 1 over the
 * Issue's changed and retained test files, and Stage 2 over the whole suite.
 *
 * It is a *reporting* script, not a benchmark harness. It adds no selection, no
 * statistics and no scheduling of its own: the Issue base, the cumulative
 * change, the runnable-file report and the selection all come from the shipped
 * modules the lanes call, and every command is launched through the shipped
 * `CommandRunner` exactly as `runStage1TestVerification` and `runStage2Tests`
 * launch it. What this script adds is a stopwatch, the argv of each launched
 * command, and the host conditions the numbers were taken under.
 *
 * It never runs by itself: nothing in `npm test`, `npm run package` or CI
 * invokes it, and it makes no commit, label, publication or configuration
 * change. An operator runs it by hand on a branch:
 *
 *   node scripts/changed-file-stage-timing.mjs --base-branch main
 *   node scripts/changed-file-stage-timing.mjs --base <sha> --skip-full
 *
 * Exit status is 0 whenever the measurement itself completed; a red test suite
 * is a measured result, not a script failure. It exits nonzero only when the
 * measurement could not be taken (no build, unreadable base, refused suite
 * command, a setup that failed or timed out, an unreadable runnable-file
 * report, a Stage 1 selection that executes nothing because a retained file is
 * unresolved, or a Stage 2 that never reached its tests command). When that
 * happens after the first command has been launched, the partial report — the
 * durations taken so far, the host conditions and the disqualifying reason — is
 * still printed and still written to `--json`; the nonzero status is taken after
 * it, never instead of it.
 *
 * Three rules keep the printed numbers honest:
 *
 * - an empty Stage 1 selection (§3 R10 `empty`) is a real Stage 1 that executes
 *   no test file, so its test time is recorded as zero, and the cycle total
 *   stays the setup plus the runnable-file report;
 * - a stage that executed no test file for any other reason — an unresolved
 *   retained selection in Stage 1, a failed setup or discovery in Stage 2 — is
 *   not a completed stage: the report is marked incomplete and the exit status
 *   is nonzero, so no operator reads a success out of a run that never tested;
 * - a saving is reported only from two runs that both ended on their own and
 *   accounted for every file they expected. A run that timed out, failed its
 *   setup or discovery, or left an unreadable result still has command
 *   durations, but they are not a whole-suite time.
 */

import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { cpus, loadavg, tmpdir, totalmem } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
const DIST = join(ROOT, 'dist', 'index.js');

if (!existsSync(DIST)) {
  console.error('dist/ is not built. Run `npm run build` first; this script drives the shipped modules.');
  process.exit(2);
}

// The lanes launch their commands through `defaultCommandRunner`; so does this
// script, so the numbers are of the same runner production uses.
const { defaultCommandRunner } = await import(
  pathToFileURL(join(ROOT, 'dist', 'handlers', 'command-runner.js')).href
);
const {
  discoverTestFiles,
  readCumulativeChange,
  readIssueBranchStart,
  readRetainedTestFileSet,
  resolveIssueBase,
  runTestFiles,
  runTestSuiteSetup,
  selectStage1TestFiles,
  stage1ExecutionPlan,
} = await import(pathToFileURL(DIST).href);

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

const DEFAULTS = {
  base: undefined,
  baseBranch: 'main',
  // The repository's own binding (docs/staged-verification-operations.md §6).
  suite: 'npm run test:files',
  setup: 'npm run build',
  separator: '--',
  retained: [],
  timeout: 1_800_000,
  skipFull: false,
  json: undefined,
};

function parseArguments(argv) {
  const options = { ...DEFAULTS, retained: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (next === undefined) {
        console.error(`${flag} needs a value`);
        process.exit(2);
      }
      i += 1;
      return next;
    };
    switch (flag) {
      case '--base': options.base = value(); break;
      case '--base-branch': options.baseBranch = value(); break;
      case '--suite': options.suite = value(); break;
      case '--setup': options.setup = value(); break;
      case '--separator': options.separator = value(); break;
      case '--no-setup': options.setup = undefined; break;
      case '--no-separator': options.separator = undefined; break;
      case '--retained': options.retained.push(...value().split(',').map((f) => f.trim()).filter(Boolean)); break;
      case '--timeout': options.timeout = Number(value()); break;
      case '--skip-full': options.skipFull = true; break;
      case '--json': options.json = value(); break;
      case '--help':
      case '-h':
        console.log(HELP);
        process.exit(0);
        break;
      default:
        console.error(`unknown option ${flag}`);
        process.exit(2);
    }
  }
  if (!Number.isFinite(options.timeout) || options.timeout <= 0) {
    console.error('--timeout must be a positive number of milliseconds');
    process.exit(2);
  }
  return options;
}

const HELP = `changed-file-stage-timing.mjs — measure Stage 1 against Stage 2 on this repository

  --base <sha>          Issue base commit (default: merge-base of the base branch and HEAD)
  --base-branch <name>  base branch whose remote-tracking ref the branch start is read from (default main)
  --suite <command>     suite command bytes (default "${DEFAULTS.suite}")
  --setup <command>     setup command bytes (default "${DEFAULTS.setup}"); --no-setup to omit
  --separator <token>   argument separator (default "${DEFAULTS.separator}"); --no-separator to omit
  --retained <a,b>      extra retained test files to union into the Stage 1 selection
  --timeout <ms>        per-command deadline (default ${DEFAULTS.timeout})
  --skip-full           measure Stage 1 only; report Stage 2 as not measured
  --json <path>         also write the report as JSON`;

// ---------------------------------------------------------------------------
// A tracing runner: the shipped runner, plus the argv and duration of each call
// ---------------------------------------------------------------------------

/**
 * The argv as a shell would have to be given it to reproduce the launch.
 *
 * The trace keeps `cmd` and `args` apart, because that — not a joined string —
 * is what was executed: a suite command or a generated path may carry spaces,
 * quotes or metacharacters, and joining those on spaces makes two different
 * argument vectors print identically. Quoting happens here, at the moment of
 * rendering, and only for tokens that need it.
 */
const shellQuote = (token) =>
  token.length > 0 && /^[A-Za-z0-9_@%+=:,./-]+$/.test(token)
    ? token
    : `'${token.replace(/'/g, `'\\''`)}'`;

const renderCommand = (entry) => [entry.cmd, ...entry.args].map(shellQuote).join(' ');

function tracingRunner(trace) {
  return {
    run(cmd, args, opts) {
      const result = defaultCommandRunner.run(cmd, args, opts);
      trace.push({
        cmd,
        args: [...args],
        exitCode: result.exitCode,
        durationMs: result.durationMs ?? null,
        ...(result.timedOut === true ? { timedOut: true } : {}),
        ...(result.spawnError !== undefined ? { spawnError: result.spawnError } : {}),
      });
      return result;
    },
  };
}

/** The calls a tracing window made that were not `git` bookkeeping. */
const launched = (trace, from) => trace.slice(from).filter((entry) => entry.cmd !== 'git');

const sum = (entries) => entries.reduce((total, entry) => total + (entry.durationMs ?? 0), 0);

/**
 * Whether a run's stopwatch may be compared with another's, from the shipped
 * §2 trust, completeness and termination the run already reports.
 *
 * A run that hit the deadline, was interrupted, failed its setup or discovery,
 * left an unreadable machine result or did not account for every expected file
 * still has positive command durations — but they are the durations of a suite
 * that did not finish, so they are not a whole-suite time and must not become a
 * ratio. A red suite is trusted and `process-failed`: it is a measured *result*
 * (this script exits 0 for it), and it is still excluded here, because a suite
 * that stopped on failures did not necessarily execute everything a green one
 * would.
 */
const comparable = (run) =>
  run.trust.status === 'trusted' && run.completeness.status === 'complete' && run.termination === 'confirmed';

/** Why a launched command did not end on its own, or `undefined` when it did. */
const abnormalEnd = (step) => {
  if (step.timedOut === true) return 'it hit the deadline';
  if (step.spawnErrorCode !== undefined) return `it could not be launched (${step.spawnErrorCode})`;
  if (step.signal !== undefined) return `it was killed (${step.signal})`;
  return undefined;
};

/**
 * Why a run failed *before* its tests ran, or `undefined` when it reached them.
 *
 * A red suite is a measured result: its tests command was launched, so the
 * duration is a whole-suite duration and the failures are the answer (this
 * script exits 0 for that). A run whose setup exited nonzero, whose discovery
 * failed or hit the deadline, or whose runnable-file report was unreadable or
 * named nothing, never launched a test: its durations are a build and a
 * discovery, not a suite time, so the measurement stopped short and must say so
 * instead of reporting a completed run.
 */
function preTestFailure(run) {
  const testsIndex = run.steps.findIndex((step) => step.step === 'tests');
  const beforeTests = testsIndex === -1 ? run.steps : run.steps.slice(0, testsIndex);
  for (const step of beforeTests) {
    const abnormal = abnormalEnd(step);
    if (abnormal !== undefined) return `its ${step.step} command did not end on its own: ${abnormal}`;
    if (step.exitCode !== 0) return `its ${step.step} command exited ${step.exitCode} before any test ran`;
  }
  if (testsIndex !== -1) return undefined;
  return run.trust.status === 'untrusted'
    ? `it never launched its tests command (${run.trust.reason}: ${run.trust.detail})`
    : 'it never launched its tests command: the runnable-file report named no test file';
}

/** Why a stage's duration is not comparable, in one operator-facing phrase. */
function notComparableBecause(stage) {
  if (stage.measured === false) return stage.note ?? 'it was not measured';
  if (stage.preTestFailure !== undefined) return `no test ran: ${stage.preTestFailure}`;
  if (stage.comparable === true) return 'the run completed but reported no measurable duration';
  if (stage.trust !== undefined && stage.trust.status !== 'trusted') {
    return `the run is untrusted (${stage.trust.reason}: ${stage.trust.detail})`;
  }
  if (stage.termination !== undefined && stage.termination !== 'confirmed') {
    return 'a launched process was not confirmed to have ended';
  }
  if (stage.completeness !== undefined && stage.completeness.status !== 'complete') {
    return `the run is incomplete (${stage.completeness.reason})`;
  }
  return stage.note ?? 'the run did not produce a comparable duration';
}

// ---------------------------------------------------------------------------
// Host conditions
// ---------------------------------------------------------------------------

function hostConditions() {
  const cpu = cpus();
  return {
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    cpus: cpu.length,
    cpuModel: cpu[0]?.model ?? 'unknown',
    totalMemGiB: Number((totalmem() / 1024 ** 3).toFixed(1)),
    loadavgBefore: loadavg().map((value) => Number(value.toFixed(2))),
    // Jest's worker count is whatever the suite command and the environment
    // resolve; it is recorded, never set here.
    jestWorkersEnv: process.env.JEST_WORKERS ?? null,
    maxWorkersInSuiteCommand: null,
  };
}

// ---------------------------------------------------------------------------
// The measurement
// ---------------------------------------------------------------------------

const options = parseArguments(process.argv.slice(2));
const binding = {
  adapter: 'jest',
  ...(options.setup !== undefined ? { setupCommand: options.setup } : {}),
  ...(options.separator !== undefined ? { argumentSeparator: options.separator } : {}),
};
const conditions = hostConditions();
conditions.maxWorkersInSuiteCommand = /--maxWorkers[= ]\S+/.exec(options.suite)?.[0] ?? null;

const artifactDir = mkdtempSync(join(tmpdir(), 'changed-file-stage-timing-'));
const trace = [];
const runner = tracingRunner(trace);
const commandOptions = (prefix) => ({
  cwd: ROOT,
  suiteCommand: options.suite,
  binding,
  artifactDir,
  artifactPrefix: prefix,
  timeoutMs: options.timeout,
});

/**
 * A failure before any measured command has been launched: there is no duration
 * and no host context worth printing, so the script says why and stops.
 */
const fail = (message) => {
  console.error(message);
  rmSync(artifactDir, { recursive: true, force: true });
  process.exit(1);
};

/**
 * A failure *after* measurement began — a setup that exited nonzero or hit the
 * deadline, an unreadable runnable-file report, an unavailable selection.
 *
 * Such a run has real command durations and real host conditions, and
 * `docs/changed-file-verification-validation.md` §4 promises they are still
 * reported together with the reason the comparison is disqualified. So this
 * does not exit: it records the reason, the remaining stages are skipped, and
 * the partial report is printed and written like any other before the script
 * exits nonzero at the end.
 */
let incompleteBecause;
const stop = (message) => {
  incompleteBecause ??= message;
};

function headSha() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

const report = {
  issue: 1156,
  takenAt: new Date().toISOString(),
  head: headSha(),
  suiteCommand: options.suite,
  binding,
  conditions,
};

/** A revision the operator named, resolved to the full commit SHA the selector needs. */
function resolveNamedBase(revision) {
  try {
    return execFileSync('git', ['rev-parse', '--verify', `${revision}^{commit}`], { cwd: ROOT, encoding: 'utf8' })
      .trim()
      .toLowerCase();
  } catch {
    fail(`--base ${revision} does not name a commit in this repository`);
  }
}

// 1. The Issue base (§4.1), exactly as Stage 1 resolves it.
const issueBase = options.base !== undefined
  ? resolveIssueBase({
      recorded: { sha: resolveNamedBase(options.base), source: 'branch-start' },
      dependencyBase: { missing: false },
      readBranchStart: () => ({ kind: 'unreadable', reason: 'an explicit --base was given' }),
    })
  : resolveIssueBase({
      dependencyBase: { missing: false },
      readBranchStart: () => readIssueBranchStart(runner, { cwd: ROOT, baseBranch: options.baseBranch }),
    });
if (issueBase.status !== 'resolved') {
  fail(`the Issue base is unavailable (${issueBase.reason}: ${issueBase.detail}); pass --base <sha>`);
}
report.issueBase = issueBase.base;

// 2. The cumulative net change (§4.1 rule 2).
const change = readCumulativeChange(runner, { cwd: ROOT, base: issueBase.base.sha });
if (change.kind !== 'readable') fail(`the cumulative change is unreadable: ${change.reason}`);
report.changedPaths = change.entries.length;

// 3. Setup, then the runnable-file report (§6 rule 3).
const setupStart = trace.length;
let setup;
try {
  // Refuses before anything launches when the suite command cannot carry the
  // adapter's arguments — the same refusal a real stage would make.
  setup = runTestSuiteSetup(runner, commandOptions('timing-setup'));
} catch (err) {
  fail(`the suite command was refused before launch: ${err?.message ?? String(err)}`);
}
report.setup = {
  declared: options.setup ?? null,
  succeeded: setup.succeeded,
  commands: launched(trace, setupStart),
  durationMs: sum(launched(trace, setupStart)),
};
if (!setup.succeeded) {
  stop(`the setup command did not succeed: ${options.setup ?? '(none)'}`);
}

let discovery;
if (incompleteBecause === undefined) {
  const discoveryStart = trace.length;
  discovery = discoverTestFiles(runner, commandOptions('timing-discovery'));
  report.discovery = {
    runnableFiles: discovery.inventory.kind === 'readable' ? discovery.inventory.files.length : null,
    commands: launched(trace, discoveryStart),
    durationMs: sum(launched(trace, discoveryStart)),
  };
  if (discovery.inventory.kind !== 'readable') {
    stop(`the runnable-file report is unreadable: ${discovery.inventory.reason}`);
  }
}

// 4. The Stage 1 selection (§4.2), from the shipped selector.
let plan;
if (incompleteBecause === undefined) {
  const retained = readRetainedTestFileSet({
    files: options.retained.map((file) => ({ file, addedBy: 'timing-script' })),
    overflowed: false,
  });
  const selection = selectStage1TestFiles({ issueBase, change, inventory: discovery.inventory, retained });
  if (selection.status !== 'known') {
    stop(`the Stage 1 selection is unavailable (${selection.reason}: ${selection.detail})`);
  } else {
    plan = stage1ExecutionPlan(selection);
    report.selection = {
      files: selection.files.map((entry) => ({ file: entry.file, reasons: [...entry.reasons] })),
      unresolvedRetained: [...selection.unresolvedRetained],
      selectionDigest: selection.selectionDigest,
      plan: plan.kind,
    };
  }
}

// 5. Stage 1: the selected files only. An empty selection executes nothing —
//    that is the contract's §3 R10 `empty`, not a zero-file "run".
if (incompleteBecause !== undefined) {
  report.stage1 = {
    measured: false,
    comparable: false,
    note: `it was not reached: ${incompleteBecause}`,
  };
} else if (plan.kind === 'execute') {
  const stage1Start = trace.length;
  const run = runTestFiles(runner, plan.request, commandOptions('timing-stage1'), setup);
  report.stage1 = {
    mode: run.mode,
    files: run.files.length,
    failedFiles: [...run.failedFiles],
    trust: run.trust,
    processResult: run.processResult,
    completeness: run.completeness,
    termination: run.termination,
    comparable: comparable(run),
    commands: launched(trace, stage1Start),
    // The setup is shared with discovery and is reported once, above.
    durationMs: sum(launched(trace, stage1Start)),
  };
} else if (plan.kind === 'empty') {
  // §3 R10 `empty` is a *valid* Stage 1 that executes no test file: the Issue's
  // cumulative change touched only sources or documentation and nothing is
  // retained. The setup and the runnable-file report have already run and are
  // charged to the cycle below, so this stage's own test time is zero — not
  // unknown — and the cycle total stays setup + discovery.
  report.stage1 = {
    mode: null,
    plan: plan.kind,
    files: 0,
    failedFiles: [],
    comparable: true,
    commands: [],
    durationMs: 0,
    note: 'no test file was executed: the selection is empty, which is a Stage 1 pass costing no test time',
  };
} else {
  // `retained-unresolved` (a retained file the runnable-file report does not
  // name) and `unavailable` execute nothing and are not a Stage 1 pass: there is
  // no Stage 1 duration to compare, so the measurement stopped short here and
  // says so rather than going on to time Stage 2 and exiting 0.
  const detail = plan.kind === 'retained-unresolved'
    ? `the runnable-file report names none of: ${plan.files.join(', ')}`
    : `reason: ${plan.reason}`;
  report.stage1 = {
    measured: false,
    mode: null,
    plan: plan.kind,
    comparable: false,
    note: `nothing was executed: the selection is not an executable plan (${plan.kind}; ${detail})`,
  };
  stop(`Stage 1 executed no test file: the selection is \`${plan.kind}\` (${detail})`);
}

// 6. Stage 2: the whole suite, as the final stage runs it (§6 rule 1).
if (incompleteBecause !== undefined) {
  report.stage2 = {
    measured: false,
    comparable: false,
    note: `it was not reached: ${incompleteBecause}`,
  };
} else if (options.skipFull) {
  report.stage2 = { measured: false, comparable: false, note: '--skip-full was given' };
} else {
  const stage2Start = trace.length;
  const full = runTestFiles(runner, { mode: 'full' }, commandOptions('timing-stage2'));
  report.stage2 = {
    measured: true,
    mode: full.mode,
    files: full.files.length,
    failedFiles: full.failedFiles.length,
    trust: full.trust,
    processResult: full.processResult,
    completeness: full.completeness,
    termination: full.termination,
    comparable: comparable(full),
    commands: launched(trace, stage2Start),
    durationMs: sum(launched(trace, stage2Start)),
  };
  // A red whole suite is a measured result and exits 0; a Stage 2 that never got
  // as far as its tests — its setup, its discovery or its runnable-file report
  // failed — took no suite time, so it stops the measurement like any other
  // setup or discovery failure and the partial report is still printed.
  const preTest = preTestFailure(full);
  if (preTest !== undefined) {
    report.stage2.preTestFailure = preTest;
    // Not a whole-suite time, whatever the shipped run's own trust says: a full
    // run that legitimately launched nothing because the report named no file
    // is still not a suite this Stage 1 can be divided by.
    report.stage2.comparable = false;
    stop(`Stage 2 did not run its tests: ${preTest}`);
  }
}

report.conditions.loadavgAfter = loadavg().map((value) => Number(value.toFixed(2)));
if (incompleteBecause !== undefined) report.incomplete = { reason: incompleteBecause };
rmSync(artifactDir, { recursive: true, force: true });

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

const seconds = (ms) => (typeof ms === 'number' ? `${(ms / 1000).toFixed(1)}s` : 'unknown');

console.log(`changed-file stage timing — head ${report.head ?? 'unknown'} at ${report.takenAt}`);
console.log(`  host: ${conditions.platform}, ${conditions.cpus} cpus, node ${conditions.node}, `
  + `load ${conditions.loadavgBefore.join('/')} → ${report.conditions.loadavgAfter.join('/')}`);
console.log(`  suite command: ${options.suite}`);
console.log(`  binding: ${JSON.stringify(binding)}`);
console.log(`  Issue base: ${report.issueBase.sha} (${report.issueBase.source}); `
  + `${report.changedPaths} changed paths; `
  + `${report.discovery?.runnableFiles ?? 'unknown'} runnable test files`);
if (report.incomplete !== undefined) {
  // The durations below were really taken and are printed, but the measurement
  // stopped short: say so once, at the top, before any of them.
  console.log('');
  console.log(`  INCOMPLETE — ${report.incomplete.reason}.`);
  console.log('  The durations recorded before that point are reported below; they are not a comparison.');
}
console.log('');
if (report.selection === undefined) {
  console.log('  selected test files: unknown — the selection was never taken');
} else {
  console.log(`  selected test files (${report.selection.files.length}):`);
  for (const entry of report.selection.files) console.log(`    - ${entry.file} [${entry.reasons.join(', ')}]`);
  if (report.selection.files.length === 0) console.log('    (none — Stage 1 is `empty` and executes nothing)');
}
console.log('');
console.log(`  setup     ${seconds(report.setup.durationMs)}  ${report.setup.declared ?? '(none)'}`);
for (const entry of report.setup.commands) console.log(`    $ ${renderCommand(entry)}`);
console.log(`  discovery ${seconds(report.discovery?.durationMs)}`);
for (const entry of report.discovery?.commands ?? []) console.log(`    $ ${renderCommand(entry)}`);
console.log(`  Stage 1   ${seconds(report.stage1.durationMs)}  (${report.stage1.files ?? 0} files reported)`);
if (report.stage1.note !== undefined) console.log(`    ${report.stage1.note}`);
for (const entry of report.stage1.commands ?? []) console.log(`    $ ${renderCommand(entry)}`);
console.log(`  Stage 2   ${seconds(report.stage2.durationMs)}  (${report.stage2.files ?? 0} files reported, `
  + 'including its own setup and discovery, as the final stage runs it)');
if (report.stage2.measured === false && report.stage2.note !== undefined) {
  console.log(`    ${report.stage2.note}`);
}
if (report.stage2.preTestFailure !== undefined) {
  console.log(`    no test ran: ${report.stage2.preTestFailure}`);
}
for (const entry of report.stage2.commands ?? []) console.log(`    $ ${renderCommand(entry)}`);

// A ratio is only taken from two runs that ended on their own and accounted for
// every file they expected. Command durations exist for a timed-out, refused or
// unreadable run too, and comparing those would report a saving against a
// "whole suite" that never completed.
const stage1Comparable = report.stage1.comparable === true && typeof report.stage1.durationMs === 'number';
const stage2Comparable =
  report.stage2.measured === true && report.stage2.comparable === true && report.stage2.durationMs > 0;

if (stage1Comparable && stage2Comparable) {
  // Like for like: a real Stage 1 pays for its own setup and discovery, and so
  // does a real Stage 2. Comparing the bare test runs would overstate the
  // saving by the build both of them have to do.
  const buildCostMs = report.setup.durationMs + report.discovery.durationMs;
  const stage1TotalMs = buildCostMs + report.stage1.durationMs;
  const savedMs = report.stage2.durationMs - stage1TotalMs;
  report.savings = {
    buildCostMs,
    stage1TestMs: report.stage1.durationMs,
    stage1TotalMs,
    stage2TotalMs: report.stage2.durationMs,
    savedMs,
    ratio: Number((stage1TotalMs / report.stage2.durationMs).toFixed(3)),
  };
  console.log('');
  console.log(`  a pre-approval cycle costs ${seconds(stage1TotalMs)} `
    + `(${seconds(buildCostMs)} build + discovery, ${seconds(report.stage1.durationMs)} selected files) `
    + `against ${seconds(report.stage2.durationMs)} for the whole suite — `
    + `${(report.savings.ratio * 100).toFixed(1)}%, ${seconds(savedMs)} less per cycle`);
  console.log('  Stage 2 still runs in full after approval, so this is a per-cycle saving, not a coverage reduction.');
} else {
  report.savings = {
    reported: false,
    reason: 'a saving is only reported when both stages ended on their own and accounted for every expected file',
    ...(stage1Comparable ? {} : { stage1: notComparableBecause(report.stage1) }),
    ...(stage2Comparable ? {} : { stage2: notComparableBecause(report.stage2) }),
  };
  console.log('');
  console.log('  no saving is reported: a ratio is only taken from two runs that both completed.');
  if (!stage1Comparable) console.log(`    Stage 1: ${report.savings.stage1}`);
  if (!stage2Comparable) console.log(`    Stage 2: ${report.savings.stage2}`);
  console.log('  The durations above are still printed, but they are not a whole-suite measurement.');
}

if (options.json !== undefined) {
  mkdirSync(dirname(resolve(options.json)), { recursive: true });
  writeFileSync(resolve(options.json), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`\n  JSON report: ${options.json}`);
}

// A measurement that stopped short has now been reported in full — console and
// JSON alike — so the nonzero status is taken here, at the end, and never in
// place of the report.
if (report.incomplete !== undefined) {
  console.error(`\nthe measurement could not be completed: ${report.incomplete.reason}`);
  process.exit(1);
}
