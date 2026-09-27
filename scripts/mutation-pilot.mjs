#!/usr/bin/env node
/**
 * Issue #1111 — the opt-in driver for the scoped StrykerJS harness (Test
 * Maintenance Pilot, slice 3/8). Nothing in the default verification path calls
 * this script: `npm test`, `pretest`, `npm run package` and per-PR CI never
 * reference it, and it starts no background scheduler.
 *
 * Four modes, in the order they are meant to be used:
 *
 *   --preflight   (default) Check the harness without running anything: are the
 *                 pinned Stryker packages installed, does this Node satisfy the
 *                 range they declare, do the scoped files still exist, is the
 *                 report directory ignored by Git, and is mutation testing
 *                 still absent from `test`/`pretest`/`package`/`typecheck`?
 *   --dry-run     Stryker's own dry run over the pilot scope, with no mutants
 *                 activated. Proves the sandbox builds and the scoped tests
 *                 pass unchanged, and reports how many mutants a full run would
 *                 have to test — the number slice 4 needs to decide whether the
 *                 run fits a bounded budget. Those numbers are only in the text
 *                 Stryker prints, so they are recorded in the summary only when
 *                 the run is detached and owns the log it wrote; see
 *                 `readDryRunFacts`.
 *   --smoke       A minimal known-detectable mutation check over
 *                 `src/core/tool-request-grant.ts:73-84` with the pure suite
 *                 only. Fails unless the dry run succeeded, at least one mutant
 *                 was killed, and no mutant ended in a compile or runtime
 *                 error. That is the check that mutants reach the code the
 *                 tests actually execute (`dist/`), rather than an unused `src`
 *                 tree or a stale build.
 *   --pilot       The full accepted scope from #1110 §5. Run only after the
 *                 smoke check passes and the dry run's estimate fits a budget.
 *
 * Resource use is bounded and recorded, never enforced on anything else: one
 * run at a time owns this checkout (an exclusive-create lock at the fixed
 * `.mutation/pilot.lock`, held across every mode and never moved by `--out`, so
 * neither a smoke run beside a dry run nor a second run pointed at another
 * output directory can start, and a lock outlives a killed driver while the
 * Stryker group it recorded is still on the host), the
 * run is one detached process group with a wall-clock budget, `--concurrency`
 * is capped at the host's available parallelism, and load average is recorded
 * around the run instead of assuming the host is idle. Other projects' processes
 * are never signalled — only the group this script started. Sandbox copies that
 * a killed run left behind are pruned on the next run, and only after they have
 * been untouched long enough that no run can still own them.
 *
 * Each mode is a command to run **on its own**. A run prints a heartbeat while
 * Stryker is silent, and if the console it writes to goes away mid-run — a
 * wrapper's command timeout, a closed terminal — the run is recorded as
 * `interrupted (console-closed:…)` rather than as the non-zero exit Stryker dies
 * with when its inherited pipe breaks. A broken pipe is never a finding about
 * the tests.
 *
 * Two modifiers exist because a caller's console budget is not the run's budget.
 * The pilot scope's own suites take longer to execute once than some callers
 * will wait — an automated command wrapper here stops reading after two minutes
 * — and a run killed at that point produces no evidence at all:
 *
 *   --background  Start the same run detached, in its own session, with output
 *                 redirected to `<out>/<label>/run.log`, and exit immediately.
 *                 The caller's console going away can no longer reach it. This
 *                 is one run started by one explicit command; nothing is
 *                 scheduled, repeated or started on this script's own initiative.
 *   --report      Read back what a `--background` run recorded, and exit 0 while
 *                 it is still going. It reads only — a report never prunes,
 *                 clears or writes, because doing so would destroy the artifacts
 *                 of the run it is reporting on.
 *
 * The sandbox build itself is `scripts/mutation-build.mjs`, which compiles the
 * instrumented sources and records — in `build.json`, folded into this run's
 * summary — that every mutated source reached the `dist/` JavaScript the tests
 * import. A report directory belongs to one run: the previous run's artifacts
 * are cleared before Stryker starts, so a run that dies early is never
 * summarized from the last one's report.
 *
 * Artifacts stay local. Raw Stryker output (which embeds full source lines and
 * absolute sandbox paths) is written under `--out` (default `.mutation/`,
 * gitignored); the sanitized, bounded `summary.json` / `summary.md` written
 * beside it are the only things meant to be quoted in a report. No reporter
 * uploads anything, and `STRYKER_DASHBOARD_API_KEY` is stripped from the run's
 * environment so a host-level key cannot turn a local run into a publication.
 *
 * Run: node scripts/mutation-pilot.mjs [--preflight|--dry-run|--smoke|--pilot]
 *        [--concurrency <n>] [--timeout-ms <n>] [--max-runtime-min <n>]
 *        [--coverage-analysis off|all|perTest] [--out <dir>] [--incremental]
 *        [--background|--report]
 */
import { execFileSync, spawn } from 'child_process';
import { randomUUID } from 'crypto';
import {
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { createRequire } from 'module';
// A namespace import, not a named one: `os.availableParallelism` only exists
// from Node 18.14, and a named ESM import of a missing export fails while the
// module is linked — before `hostParallelism` or the preflight could fall back.
import * as os from 'os';
import { homedir, loadavg, tmpdir } from 'os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

import {
  BASELINE_MUTATE,
  ERROR_STATUSES,
  PILOT_MUTATE,
  PILOT_TESTS,
  SANDBOX_PREFIX,
  SMOKE_MUTATE,
  SMOKE_TESTS,
  DEFAULT_OUT,
  DEFAULT_TIMEOUT_FACTOR,
  INCREMENTAL_IDENTITY_KEYS,
  TEMP_DIR_NAME,
  assertScope,
  pilotStrykerConfig,
  resolveBuildEntry,
  resolveTscEntry,
} from '../stryker.pilot.config.mjs';
import { distPathFor, outputLayout } from './mutation-build.mjs';
import { runTimed, sanitizePath, sanitizeText, windowsTreeKillArgs } from './test-cost-baseline.mjs';

/** The two packages this harness pins. Both must be installed for a run. */
export const STRYKER_PACKAGES = ['@stryker-mutator/core', '@stryker-mutator/jest-runner'];
/**
 * The parser Stryker's instrumenter loads, resolved link by link from the
 * checkout. From 10.x (#1185) it is Babel 8, whose declared Node floor
 * (`^22.18.0 || >=24.11.0`) sits above the `>=22.0.0` Stryker declares, so
 * checking Stryker's own range alone would certify a Node that cannot run it.
 */
export const INSTRUMENTER_PARSER_CHAIN = ['@stryker-mutator/core', '@stryker-mutator/instrumenter', '@babel/core'];
/** Only the dashboard reporter uploads, and only with this key. It never reaches a run. */
export const DASHBOARD_KEY_ENV = 'STRYKER_DASHBOARD_API_KEY';
/** npm scripts that must never grow a mutation step. */
export const PROTECTED_SCRIPTS = ['test', 'test:files', 'pretest', 'package', 'typecheck', 'build'];
export const MODES = ['preflight', 'dry-run', 'smoke', 'pilot'];
export const COVERAGE_ANALYSES = ['off', 'all', 'perTest'];
/** Bound on every list that reaches the sanitized summary. */
export const MAX_LISTED_MUTANTS = 20;
/** Bound on the paths a failing `reports-ignored` names; the rest are counted. */
export const MAX_LISTED_EXPOSED = 5;
/**
 * The half of a run's incremental identity that `scopeFor` decides rather than
 * the command line — see `INCREMENTAL_IDENTITY_KEYS`. Everything else in that
 * identity is a setting an invocation may carry, and `incrementalFileForMode`
 * forwards it.
 */
export const SCOPE_IDENTITY_KEYS = ['mutate', 'testFiles'];
/**
 * Every mode that writes a report directory. `preflight` writes nothing, and
 * for the rest `scopeFor(mode).label` is the mode's own name.
 */
export const REPORT_LABELS = MODES.filter((mode) => mode !== 'preflight');
/** Files one run owns in its report directory, cleared before the next run writes there. */
export const STALE_ARTIFACTS = ['mutation.json', 'mutation.html', 'build.json', 'summary.json', 'summary.md'];
/** Where a `--background` run's console output goes, and where `--report` finds the run it describes. */
export const RUN_LOG = 'run.log';
export const RUN_STATE = 'run-state.json';
/**
 * The unsanitized artifacts a run leaves in its report directory: the Stryker
 * reports embed the full source of every mutated file, and the spec, log and
 * state carry absolute host paths. Only the `summary.*` pair is sanitized and
 * publishable, so these are what `reports-ignored` must prove Git excludes.
 */
export const RAW_ARTIFACTS = ['mutation.json', 'mutation.html', 'build.json', 'run-spec.json', RUN_LOG, RUN_STATE];
/**
 * The sandbox files `reports-ignored` asks about even without a tracked-file
 * list: the copied manifest and every file a mode's scope names — the source a
 * sandbox holds mutated, and the tests it runs against it.
 */
export const DEFAULT_SANDBOX_FILES = [
  ...new Set([
    'package.json',
    ...[...PILOT_MUTATE, ...BASELINE_MUTATE, ...SMOKE_MUTATE].map((entry) => entry.split(':')[0]),
    ...PILOT_TESTS,
    ...SMOKE_TESTS,
  ]),
];
/** `tsconfig.json`'s layout, used when the preflight cannot read the project's own. */
export const DEFAULT_BUILD_LAYOUT = { rootDir: 'src', outDir: 'dist' };
/**
 * Correlates a `--background` start with the summary its detached copy writes.
 * Without it a `--report` would accept whichever summary happens to be in the
 * directory — including one a later foreground run left there — and present
 * another invocation's result as this run's. The token is generated per start
 * and carried to the detached run in its environment.
 */
export const RUN_ID_ENV = 'MUTATION_PILOT_RUN_ID';
/** How many trailing log lines a `--report` prints. Bounded like every other list here. */
export const MAX_LOG_TAIL_LINES = 20;
/**
 * How far past its own wall-clock budget a background run may still be reported
 * as running. Past that the driver should already have stopped its Stryker group
 * and written a summary, so a live pid with nothing written is reported as
 * `overdue` rather than as healthy progress — a stuck run must not read as one
 * that simply needs more time.
 */
export const BACKGROUND_GRACE_MS = 5 * 60_000;
/** Default wall-clock budget for `--dry-run`, which runs no mutant. */
export const DRY_RUN_BUDGET_MIN = 30;
/** How often the driver says the run is still alive — see `heartbeatLine`. */
export const HEARTBEAT_MS = 30_000;
/**
 * How long a leftover sandbox must have been untouched before this driver
 * removes it. A run that is still going writes into its sandbox continuously, so
 * the age is what keeps a second pilot run on the same host from deleting the
 * first one's working copy.
 */
export const STALE_SANDBOX_AGE_MS = 60 * 60_000;
/**
 * The file one run holds while it runs, and the fixed directory it lives in.
 *
 * The lock is `<checkout>/.mutation/pilot.lock` whatever `--out` says, and that
 * is the point: what a run owns is this checkout and the host it runs on, not
 * one output directory. A lock kept under `--out` would only be as exclusive as
 * the argument that names it — the default run and `--out .mutation/alternate`
 * would create two different lock files, both pass the preflight, and both go
 * on to build, test and prune at once, which is exactly the resource bound this
 * slice is required to keep. `--out` still decides where reports, logs and
 * sandboxes are written; it never decides who may run.
 *
 * Nor is the lock inside a mode's report directory, for the same reason one
 * level down: every mode shares one host, one `<out>/stryker-tmp` and one
 * sandbox-pruning pass, so a smoke run started during a dry run is a collision
 * a per-directory check cannot see.
 */
export const RUN_LOCK_DIR = DEFAULT_OUT;
export const RUN_LOCK = 'pilot.lock';
/** How the lock is named on a console and in the preflight: relative to the checkout. */
export const RUN_LOCK_PATH = `${RUN_LOCK_DIR}/${RUN_LOCK}`;
/**
 * How many times an acquisition may find the lock taken by an owner that turns
 * out to be gone, clear it, and try the exclusive create again. More than one
 * because two callers can clear the same abandoned lock at the same moment; the
 * loser of the ensuing create sees the winner's live lock on its next pass and
 * is refused, which is the answer it should have.
 */
export const LOCK_ATTEMPTS = 3;
/**
 * How long a lock whose record cannot be read is presumed to be one a start is
 * writing right now. Creating the file and writing the record are two calls, so
 * a start killed between them leaves an empty lock; below this age that is
 * indistinguishable from a healthy start mid-write, and the safe reading of
 * "somebody may be running" is to refuse.
 */
export const LOCK_WRITE_GRACE_MS = 60_000;
/**
 * The mutex that serializes every modification of an existing lock file, taken
 * by exclusive create like the lock itself. Two operations take it: clearing an
 * abandoned lock, and a detached run adopting the one its start created for it.
 *
 * Clearing is two steps — remove the dead owner's file, then race for the
 * create — and between them the winner's brand new lock sits at the same path
 * the loser already judged abandoned. An unconditional remove there deletes a
 * LIVE lock, and both callers then run Stryker at once over one `<out>` and one
 * shared temp directory. Only the holder of this file may remove the lock, and
 * only after re-reading it and finding the very instance it judged abandoned.
 *
 * Adoption takes it for the mirror image of that reason. A `--background` start
 * that dies after the spawn but before the hand-over leaves a lock naming a pid
 * that is gone, so another caller is entitled to clear it — while the detached
 * copy is entitled to adopt it. Outside a shared mutex those two interleave: the
 * clearer re-reads the old record, the copy writes its own over it, and the
 * `rmSync` then deletes a lock that is live. One mutex makes the two orderings
 * the only two, and both are safe.
 *
 * The mutex file is stamped with the instance that created it, for the same
 * reason the lock record is: reclaiming one left by a killed process must remove
 * that instance and not whatever is at the path by then. See `takeFileInstance`.
 */
export const LOCK_STEAL = 'pilot.lock.steal';
/**
 * How long the clearing mutex may be held before it is itself presumed
 * abandoned. It is held across two file operations, so any real age is a
 * process killed inside them, and a kill must not wedge the harness for good.
 *
 * Reclaiming one at that age is the mutex's own version of the race it exists to
 * prevent, and is handled the same way: see `reclaimStaleMutex`.
 */
export const LOCK_STEAL_STALE_MS = 60_000;
/**
 * How long the host is given to say when a process was created before the answer
 * is taken to be "cannot say". The probe runs a `ps`, from the lock check and
 * from this process's own exit handler, so it has to be bounded: a probe that
 * hung on a loaded host would hang those instead, and "cannot say" is a case the
 * callers already handle — see `processStartedAt`.
 */
export const PROCESS_PROBE_TIMEOUT_MS = 5_000;

export function hostParallelism(osModule = os) {
  return typeof osModule.availableParallelism === 'function' ? osModule.availableParallelism() : Math.max(1, osModule.cpus().length);
}

// ---------------------------------------------------------------------------
// Pure helpers — exported for testing
// ---------------------------------------------------------------------------

/**
 * Parse and bound CLI options. Throws on anything unknown or out of range.
 * `--concurrency` is capped at the host's available parallelism (which honours
 * CPU affinity and container quotas) so a mistyped value cannot oversubscribe a
 * shared host.
 */
export function parseArgs(argv, { parallelism = hostParallelism() } = {}) {
  const concurrencyLimit = Math.max(1, parallelism);
  const options = {
    mode: 'preflight',
    concurrency: Math.min(2, concurrencyLimit),
    timeoutMs: 60_000,
    maxRuntimeMin: 180,
    coverageAnalysis: 'off',
    out: DEFAULT_OUT,
    incremental: false,
    background: false,
    report: false,
  };
  let modeSeen = false;
  let budgetGiven = false;
  let concurrencyGiven = false;
  const positiveInt = (name, value, max) => {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || (max !== undefined && n > max)) {
      throw new Error(`invalid ${name}: ${value}${max !== undefined ? ` (1-${max})` : ''}`);
    }
    return n;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const mode = arg.startsWith('--') ? arg.slice(2) : null;
    if (mode && MODES.includes(mode)) {
      if (modeSeen) throw new Error(`more than one mode given: ${arg}`);
      options.mode = mode;
      modeSeen = true;
      continue;
    }
    if (arg === '--incremental') {
      options.incremental = true;
      continue;
    }
    if (arg === '--background' || arg === '--report') {
      options[arg.slice(2)] = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`missing value for ${arg}`);
    i += 1;
    if (arg === '--concurrency') {
      options.concurrency = positiveInt('--concurrency', value, concurrencyLimit);
      concurrencyGiven = true;
    }
    else if (arg === '--timeout-ms') options.timeoutMs = positiveInt('--timeout-ms', value);
    else if (arg === '--max-runtime-min') {
      options.maxRuntimeMin = positiveInt('--max-runtime-min', value);
      budgetGiven = true;
    }
    else if (arg === '--out') options.out = String(value);
    else if (arg === '--coverage-analysis') {
      if (!COVERAGE_ANALYSES.includes(value)) throw new Error(`invalid --coverage-analysis: ${value}`);
      options.coverageAnalysis = value;
    } else throw new Error(`unknown argument: ${arg}`);
  }
  // A dry run is one build plus one pass of the scoped tests, so it gets a much
  // smaller default budget than a mutation run. That bound is also what keeps a
  // Stryker version that does not honour `dryRunOnly` from quietly turning
  // `--dry-run` into a full run: it would be stopped after 30 minutes.
  if (options.mode === 'dry-run' && !budgetGiven) options.maxRuntimeMin = DRY_RUN_BUDGET_MIN;
  // A dry run activates no mutant, so it has exactly one test run to give out
  // however many workers it is allowed. The extra worker processes Stryker
  // creates up front are started, fed a sandbox and then left idle — pure setup
  // cost and load on a host this pilot shares with other projects.
  if (options.mode === 'dry-run' && !concurrencyGiven) options.concurrency = 1;
  // Starting a run and reading one back are opposite actions on the same
  // directory: `--report` must not clear the artifacts it exists to read. Asking
  // for both at once has no defensible meaning, so it is refused rather than
  // silently resolved to one of them.
  if (options.background && options.report) throw new Error('--background and --report cannot be combined');
  // Preflight runs no process to detach from and produces no artifact to read
  // back; it already fits any console budget.
  if (options.mode === 'preflight' && (options.background || options.report)) {
    throw new Error(`--preflight does not support ${options.background ? '--background' : '--report'}`);
  }
  return options;
}

/**
 * The arguments a `--background` start hands its detached copy: this run's
 * already-resolved options, stated explicitly. Passing the resolved values
 * rather than re-deriving them is what makes the detached run the same run —
 * the mode-specific defaults (`--dry-run`'s budget and worker count) were
 * applied by the parent's `parseArgs` and are not left to be applied again.
 */
export function backgroundArgs(options) {
  return [
    `--${options.mode}`,
    '--concurrency', String(options.concurrency),
    '--timeout-ms', String(options.timeoutMs),
    '--max-runtime-min', String(options.maxRuntimeMin),
    '--coverage-analysis', options.coverageAnalysis,
    '--out', options.out,
    ...(options.incremental ? ['--incremental'] : []),
  ];
}

/**
 * The scope one mode runs. `dry-run` uses the pilot scope on purpose: its
 * estimate is only useful for the run that would actually be made.
 *
 * Since #1112 that scope is `BASELINE_MUTATE` — the frozen line ranges inside the
 * same two accepted sources — rather than the whole files. The whole-file scope
 * was measured and does not fit a bounded run (742 mutants, ≈ 37 h serial;
 * `docs/metrics/mutation-pilot-harness.md` §6), and the two modes must stay in
 * step: a dry run is what says how many mutants the pilot will have to test, so a
 * dry run over a wider scope than the pilot would project a cost nobody is going
 * to pay, and a narrower one would understate it. `PILOT_MUTATE` stays the
 * accepted *file* bound that `assertScope` enforces on both.
 */
export function scopeFor(mode) {
  const scope =
    mode === 'smoke'
      ? { label: 'smoke', mutate: SMOKE_MUTATE, testFiles: SMOKE_TESTS }
      : { label: mode === 'dry-run' ? 'dry-run' : 'pilot', mutate: BASELINE_MUTATE, testFiles: PILOT_TESTS };
  assertScope(scope.mutate, scope.testFiles);
  return scope;
}

/**
 * Stryker's executable, read from the installed package's own manifest rather
 * than assumed, so a layout change surfaces as a clear preflight failure.
 */
export function strykerBinFromManifest(manifest) {
  const bin = manifest?.bin;
  const entry = typeof bin === 'string' ? bin : bin?.stryker;
  if (!entry) throw new Error('@stryker-mutator/core declares no "stryker" bin entry');
  return entry;
}

/**
 * The environment the Stryker process gets: this process's, plus the run spec,
 * plus the VM-modules flag Jest's native-ESM mode needs in every descendant,
 * minus the dashboard key. `NODE_OPTIONS` is appended to rather than replaced
 * so an operator's existing options survive.
 */
export function childEnv(env, specPath) {
  const next = { ...env };
  delete next[DASHBOARD_KEY_ENV];
  next.MUTATION_PILOT_SPEC = specPath;
  const existing = String(env.NODE_OPTIONS ?? '').trim();
  next.NODE_OPTIONS = existing.includes('--experimental-vm-modules')
    ? existing
    : `${existing} --experimental-vm-modules`.trim();
  return next;
}

/**
 * `X`, `X.Y` or `X.Y.Z` as a comparable `[major, minor, patch]`, with the
 * omitted positions read as zero the way semver reads a range bound. Null for
 * anything else, which every caller reports rather than guesses at.
 */
function semverTriple(text) {
  const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(String(text).trim());
  return match ? [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)] : null;
}

/** Semver's ordering for releases: major, then minor, then patch. */
function compareTriples(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

/**
 * Compare the running Node version against a package's declared `engines.node`.
 * Only the forms StrykerJS actually publishes are understood (`^20.0.0`,
 * `>=22`, `20.x`, joined by `||`); anything else answers `unknown` rather than
 * guessing, because a wrong "unsupported" would block a usable harness and a
 * wrong "ok" would hide the real cause of a failed run.
 *
 * Every bound is compared as a full `major.minor.patch`, not on the major alone.
 * A floor below the major's first release is the common case — `^18.17.0` is
 * what a package declares when it needs a feature that landed in 18.17 — and
 * comparing majors would certify Node 18.0.0 against it. A preflight that says
 * `ok` there is worse than one that says nothing: the run fails later, inside
 * Stryker, with the cause already ruled out.
 */
export function nodeRangeVerdict(version, range) {
  if (!range) return { verdict: 'unknown', reason: 'no engines.node declared' };
  return versionRangeVerdict(version, range, 'node');
}

/**
 * Does `version` of `subject` fall inside `range`? The same restricted range
 * grammar `nodeRangeVerdict` documents, and the same three answers: a form this
 * does not understand is `unknown`, never a guess in either direction. It also
 * answers whether an installed package matches the range package.json pins, so
 * a stale `node_modules` is refused before a long run rather than inside it.
 */
export function versionRangeVerdict(version, range, subject) {
  const text = String(version).replace(/^v/, '').trim();
  // A prerelease (`23.0.0-nightly...`) does not satisfy a release range under
  // semver's own rules, but calling it `unsupported` would refuse a nightly that
  // may well work. Neither verdict is honest, so neither is given.
  if (/[-+]/.test(text)) {
    return { verdict: 'unknown', reason: `prerelease ${subject} version is not comparable to a release range: ${version}` };
  }
  const current = semverTriple(text);
  if (!current) return { verdict: 'unknown', reason: `unparsed ${subject} version: ${version}` };
  const clauses = String(range)
    .split('||')
    .map((clause) => clause.trim())
    .filter(Boolean);
  if (clauses.length === 0) return { verdict: 'unknown', reason: `unparsed range: ${range}` };
  let matched = false;
  for (const clause of clauses) {
    const caret = /^\^(\d+(?:\.\d+){0,2})$/.exec(clause);
    const wildcard = /^(\d+)\.(?:x|\*)$/.exec(clause);
    const atLeast = /^>=\s*(\d+(?:\.\d+){0,2})$/.exec(clause);
    if (caret) {
      const floor = semverTriple(caret[1]);
      // `^X.Y.Z` is `>=X.Y.Z <(X+1).0.0`, except at major 0, where the caret
      // pins the minor too and the ceiling is `0.(Y+1).0`.
      const ceiling = floor[0] > 0 ? [floor[0] + 1, 0, 0] : [0, floor[1] + 1, 0];
      if (compareTriples(current, floor) >= 0 && compareTriples(current, ceiling) < 0) matched = true;
    } else if (wildcard) {
      if (current[0] === Number(wildcard[1])) matched = true;
    } else if (atLeast) {
      if (compareTriples(current, semverTriple(atLeast[1])) >= 0) matched = true;
    } else {
      return { verdict: 'unknown', reason: `unparsed range clause: ${clause}` };
    }
  }
  return matched
    ? { verdict: 'ok', reason: `${subject} ${version} satisfies ${range}` }
    : { verdict: 'unsupported', reason: `${subject} ${version} is outside ${range}` };
}

/**
 * Everything the preflight can decide from data, so it is testable without a
 * checkout. Each finding is `{ check, ok, detail }`; `ok: null` means
 * "could not be decided here", which is reported but does not fail the run.
 */
export function preflightFindings({ manifest, reportPaths, ignoredPaths, externalPaths = [], installed, instrumenterParser, missingPaths, out, nodeVersion, compiler, buildScript, sandboxInputs }) {
  const findings = [];
  // The sandbox build is the only thing that turns a mutated `src/*.ts` into the
  // `dist/` the tests import, and Stryker runs it before it links `node_modules`
  // into the sandbox — so the compiler must already exist in THIS checkout, at
  // the absolute path `buildCommandFor()` bakes into the build command. Checking
  // it here turns what was an opaque MODULE_NOT_FOUND inside Stryker's sandbox
  // into a named preflight failure with the fix in it.
  findings.push(
    compiler
      ? {
          check: 'sandbox-compiler',
          ok: compiler.present,
          detail: compiler.present
            ? `the sandbox build will run ${compiler.path}`
            : `${compiler.path} is missing — the sandbox build cannot compile the mutated TypeScript; run \`npm install\` in this worktree`,
        }
      : { check: 'sandbox-compiler', ok: null, detail: 'not checked here' },
  );
  // Stryker's `buildCommand` names this wrapper by absolute checkout path for
  // the same reason, and a missing one would fail inside the sandbox instead.
  findings.push(
    buildScript
      ? {
          check: 'sandbox-build-script',
          ok: buildScript.present,
          detail: buildScript.present
            ? `the sandbox build will run ${buildScript.path}`
            : `${buildScript.path} is missing — Stryker's buildCommand names it by absolute path and the sandbox cannot supply it`,
        }
      : { check: 'sandbox-build-script', ok: null, detail: 'not checked here' },
  );
  for (const name of STRYKER_PACKAGES) {
    const pkg = installed[name];
    if (!pkg) {
      // Deliberately explicit about WHY a pinned package can still be absent:
      // the loop's own dependency sync runs `npm install --package-lock-only
      // --ignore-scripts`, which regenerates the lockfile and never populates
      // `node_modules/`. Pinning these two in package.json therefore does not
      // make them installed; an operator install in this worktree does.
      findings.push({
        check: `installed:${name}`,
        ok: false,
        detail: 'not installed — pinned in package.json, but the loop dependency sync is lockfile-only; run `npm install` in this worktree',
      });
      continue;
    }
    findings.push({ check: `installed:${name}`, ok: true, detail: `version ${pkg.version}` });
    const { verdict, reason } = nodeRangeVerdict(nodeVersion, pkg.engines?.node);
    findings.push({
      check: `node-range:${name}`,
      ok: verdict === 'ok' ? true : verdict === 'unsupported' ? false : null,
      detail: reason,
    });
  }
  // Stryker's own range is not the whole Node requirement: the instrumenter's
  // parser declares its own, and from 10.x that one is the stricter (#1185).
  // Without core the `installed:` check is already the failure.
  if (installed['@stryker-mutator/core']) {
    const parser = INSTRUMENTER_PARSER_CHAIN.at(-1);
    if (!instrumenterParser) {
      findings.push({
        check: `node-range:${parser}`,
        ok: null,
        detail: `the instrumenter's ${parser} was not found, so Node was not checked against its range`,
      });
    } else {
      const { verdict, reason } = nodeRangeVerdict(nodeVersion, instrumenterParser.engines?.node);
      findings.push({
        check: `node-range:${parser}`,
        ok: verdict === 'ok' ? true : verdict === 'unsupported' ? false : null,
        detail:
          verdict === 'unsupported'
            ? `the instrumenter's ${parser} ${instrumenterParser.version}: ${reason} — run the harness on a Node inside that range`
            : `the instrumenter's ${parser} ${instrumenterParser.version}: ${reason}`,
      });
    }
  }
  const pinned = { ...manifest.devDependencies, ...manifest.dependencies };
  for (const name of STRYKER_PACKAGES) {
    const range = pinned[name];
    const version = installed[name]?.version;
    if (!range) {
      findings.push({ check: `pinned:${name}`, ok: false, detail: 'not pinned in package.json' });
    } else if (!installed[name]) {
      // Already a failure under `installed:*`; the pin itself is present.
      findings.push({ check: `pinned:${name}`, ok: true, detail: `package.json pins ${range}` });
    } else {
      // Present is not the same as matching: a `node_modules` left over from an
      // older checkout can hold an 8.x core under the ^10 pin (#1185), and the
      // harness relies on the pinned major's behavior. Refuse that here, before
      // a run of hours.
      const { verdict, reason } = versionRangeVerdict(version, range, name);
      findings.push({
        check: `pinned:${name}`,
        ok: verdict === 'ok' ? true : verdict === 'unsupported' ? false : null,
        detail:
          verdict === 'unsupported'
            ? `package.json pins ${range}, but installed ${version} is outside it — run \`npm install\` in this worktree`
            : `package.json pins ${range}; ${reason}`,
      });
    }
  }
  findings.push({
    check: 'scope-files-exist',
    ok: missingPaths.length === 0,
    detail: missingPaths.length === 0 ? 'every scoped source and test file is present' : `missing: ${missingPaths.join(', ')}`,
  });
  // With Stryker installed, its reader must have named the sandbox's files: the
  // tracked-file fallback omits untracked copies, so `reports-ignored` alone
  // could certify a checkout whose sandbox would hold a committable file.
  if (sandboxInputs && installed['@stryker-mutator/core']) {
    findings.push({
      check: 'sandbox-inputs',
      ok: sandboxInputs.enumerated,
      detail: sandboxInputs.enumerated
        ? `Stryker's reader named the ${sandboxInputs.count} file(s) a sandbox would copy`
        : "Stryker's reader could not enumerate the files a sandbox would copy, so untracked copies were not checked against git",
    });
  }
  findings.push(reportsIgnoredFinding({ out, reportPaths, ignoredPaths, externalPaths }));
  const wired = PROTECTED_SCRIPTS.filter((name) => /stryker|mutation/i.test(String(manifest.scripts?.[name] ?? '')));
  findings.push({
    check: 'not-wired-into-verification',
    ok: wired.length === 0,
    detail: wired.length === 0 ? 'no default script runs mutation testing' : `mutation testing reached from: ${wired.join(', ')}`,
  });
  return findings;
}

/**
 * Cap a list that reaches the summary, keeping the count that was dropped.
 * `scripts/test-cost-baseline.mjs` bounds free text the same way; this one
 * keeps the entries as records so the markdown can table them.
 */
export function capList(items, limit = MAX_LISTED_MUTANTS) {
  return { shown: items.slice(0, limit), total: items.length, omitted: Math.max(0, items.length - limit) };
}

/**
 * The exact paths a preflight asks Git about before it certifies that raw
 * reports stay out of the repository.
 *
 * `<out>` alone is not the question. Git decides per path: a re-inclusion rule
 * can expose files inside a directory that is itself reported as ignored, and a
 * path already in the index is not ignored at all. So the check names the files
 * a run really writes — every mode's directory, because every mode writes one.
 *
 * Only files, and deliberately so: a directory-only pattern (`.mutation/`)
 * matches a bare `.mutation` only when Git can see it IS a directory, and at
 * preflight time nothing has been created yet. Asking about a file inside it
 * has no such ambiguity — Git tests the leading directories as directories —
 * and a file is what would actually be committed.
 *
 * Every path a run can write is named, including the ones only some invocations
 * produce. `--incremental` writes a full mutation report into a directory of its
 * own inside each mode's report directory, and leaving it out would let a
 * checkout whose rules reach the report files but not that directory pass this
 * check while the file it missed carries the same mutated source.
 *
 * `run` is this invocation's resolved options. It decides the incremental file
 * names, which are not placeholders: see `incrementalFileForMode`.
 *
 * The sandbox is a whole copy of the checkout, so it is asked about file by
 * file: `sandboxFiles` are checkout-relative paths, each restated inside the
 * sandbox. One representative file is not enough — a rule naming that file, or
 * a later re-inclusion of `*.ts`, leaves the rest of the copy committable while
 * the representative reads as ignored. When the sandbox directory itself is
 * excluded, Git tests it as a leading directory of every one of these paths and
 * they all pass together; otherwise each must be excluded on its own. The
 * preflight passes the files Stryker would copy, untracked ones included (see
 * `sandboxInputFiles`); the default is the files every mode's scope names, plus
 * `package.json`.
 *
 * Those are only the files copied IN. The sandbox build then writes the
 * compiled — and, for a mutated source, instrumented — JavaScript beside them,
 * and a stale sandbox keeps it; so the build's outputs are asked about too (see
 * `sandboxProbeFiles`). `buildLayout` is the project's `rootDir`/`outDir`.
 */
export function rawReportPaths(
  out,
  { labels = REPORT_LABELS, run = {}, config, sandboxFiles = DEFAULT_SANDBOX_FILES, buildLayout = DEFAULT_BUILD_LAYOUT } = {},
) {
  const base = String(out).replace(/^\.\//, '').replace(/\/+$/, '');
  return [
    // The lock is the one path here that `--out` does not move: it is taken at
    // the fixed `RUN_LOCK_PATH` so that a second `--out` cannot start a second
    // run, and Git must account for it where it is actually written.
    RUN_LOCK_PATH,
    // Stryker names each sandbox `<SANDBOX_PREFIX><something>`, never a bare
    // `sandbox`, so the probe must carry the prefix: a rule written as
    // `sandbox-*` would not match the name this check used to ask about, and
    // the check would certify a checkout that commits the copied source.
    ...sandboxProbeFiles([...DEFAULT_SANDBOX_FILES, ...sandboxFiles], buildLayout).map((file) =>
      join(base, TEMP_DIR_NAME, `${SANDBOX_PREFIX}probe`, file),
    ),
    ...labels.flatMap((label) => [
      ...RAW_ARTIFACTS.map((file) => join(base, label, file)),
      // Written only under `--incremental`, and a whole mutation report when it
      // is — so the path asked about is the real one, not a stand-in.
      incrementalFileForMode(label, { out: base, run, config }),
    ]),
  ];
}

/**
 * The checkout-relative files a sandbox holds: the ones copied in, plus the
 * JavaScript the sandbox build (`scripts/mutation-build.mjs`, `TSC_ARGS`) emits
 * for every TypeScript source under `rootDir` — the `dist/**` files the tests
 * import, which carry the instrumented code. `TSC_ARGS` turns declarations and
 * source maps off, so `.js` is all the build writes per source.
 */
export function sandboxProbeFiles(files, buildLayout = DEFAULT_BUILD_LAYOUT) {
  const probe = new Set(files);
  for (const file of files) {
    const normalized = String(file).replace(/\\/g, '/');
    if (!normalized.startsWith(`${buildLayout.rootDir}/`) || !/\.tsx?$/.test(normalized) || /\.d\.tsx?$/.test(normalized)) continue;
    probe.add(distPathFor(normalized, buildLayout));
  }
  return [...probe];
}

/** The project's build layout for `sandboxProbeFiles`, or the default when `tsconfig.json` cannot be read. */
export function projectBuildLayout(root) {
  try {
    return outputLayout(JSON.parse(readFileSync(join(root, 'tsconfig.json'), 'utf8')));
  } catch {
    return DEFAULT_BUILD_LAYOUT;
  }
}

/**
 * The exact incremental-state file a run of `mode` under these settings would
 * write, taken from that run's OWN Stryker configuration rather than from a name
 * rebuilt here.
 *
 * That indirection is the whole point. `git check-ignore` answers about an exact
 * pathname, and `--incremental` names its file for a digest of the run's
 * identity, so a placeholder like `incremental/probe.json` asks Git about a path
 * no run ever writes: a `.gitignore` that re-includes the deterministic digest
 * name while leaving the placeholder ignored passes this check with a
 * source-bearing report still committable. A digest recomputed here from a
 * second list of inputs is the same bug one step later — it would drift from
 * `incrementalFileFor` the moment either list changed.
 *
 * `run` is the invocation's resolved options. The settings it may carry are read
 * from `INCREMENTAL_IDENTITY_KEYS` rather than listed again here, so a setting
 * added to the identity later is forwarded by this check too; the scope half of
 * the identity comes from the mode. A setting the options do not carry falls
 * through to the configuration's own default, which is exactly what the run spec
 * leaves to it. For the mode being run the result is that run's file; for the
 * other modes it is the file they would write under these settings, which is
 * what exercises their directory's ignore rules.
 */
export function incrementalFileForMode(mode, { out, run = {}, config = pilotStrykerConfig } = {}) {
  const scope = scopeFor(mode);
  const settings = {};
  for (const key of INCREMENTAL_IDENTITY_KEYS) {
    if (!SCOPE_IDENTITY_KEYS.includes(key) && run[key] !== undefined) settings[key] = run[key];
  }
  return config({ out, label: scope.label, mutate: scope.mutate, testFiles: scope.testFiles, ...settings }).incrementalFile;
}

/**
 * Which of these paths Git's ignore rules actually exclude, or null when Git
 * gave no usable answer.
 *
 * Exit 1 means "none of them", which IS an answer. No git, or a path outside a
 * work tree, is not one, and the caller must not read silence as safe. `-z`
 * keeps the echoed paths unquoted so they match the ones that were asked about.
 *
 * The paths go in on stdin, not on the command line: `git check-ignore` accepts
 * `-z` only together with `--stdin` and dies otherwise, and a fatal error there
 * would read as "git gave no answer" on a checkout that is in fact ignoring
 * everything. Feeding them in also keeps an `--out` from being read as an
 * option and puts no bound on how many paths may be asked about.
 */
export function gitIgnoredPaths(paths, { cwd, exec = execFileSync } = {}) {
  if (paths.length === 0) return [];
  try {
    // stderr is captured rather than inherited: "not a git repository" is an
    // answer this function reports, not noise to print over a preflight.
    const stdout = exec('git', ['check-ignore', '-z', '--stdin'], {
      cwd,
      input: paths.map((path) => `${path}\0`).join(''),
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return String(stdout).split('\0').filter(Boolean);
  } catch (error) {
    if (error?.status === 1) return [];
    return null;
  }
}

/**
 * The checkout's tracked files, or null when Git gave no answer. Only a fallback
 * for `sandboxInputFiles`: a sandbox copies untracked files too, which Git does
 * not list here.
 */
export function trackedFiles({ cwd, exec = execFileSync } = {}) {
  try {
    const stdout = exec('git', ['ls-files', '-z'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
    return String(stdout).split('\0').filter(Boolean);
  } catch {
    return null;
  }
}

/**
 * The files Stryker itself copies into a sandbox for a run with these Stryker
 * options, as checkout-relative `/`-separated paths, or null when Stryker's own
 * reader cannot be loaded or fails.
 *
 * A sandbox is not a copy of what Git tracks. Stryker walks the file system and
 * copies everything its ignore rules leave — an untracked scratch file, a report
 * an operator redirected next to the checkout — and `git ls-files` names none of
 * those. A preflight that restated only tracked files inside the sandbox would
 * never ask Git about such a copy, and would certify `reports-ignored` while it
 * stayed committable. So the list comes from Stryker's own `ProjectReader`, the
 * code that decides what a run copies, rather than from a second set of rules
 * kept here that would drift from it.
 *
 * The reader walks `process.cwd()`, as Stryker does, so it runs in a child
 * `node` whose working directory is `cwd`: this process never changes its own,
 * and Stryker's modules load the way a run loads them rather than through
 * whatever module loader hosts this script (Jest's VM modules, in the tests).
 * The child reports paths relative to its own working directory, so a symlinked
 * `cwd` (macOS's `/var` → `/private/var`) cannot skew them. `exec` is injected
 * for tests.
 */
export async function sandboxInputFiles(strykerOptions, { cwd = process.cwd(), exec = execFileSync } = {}) {
  try {
    const stdout = exec(process.execPath, ['--input-type=module', '-e', SANDBOX_INPUT_READER], {
      cwd,
      input: JSON.stringify({ ...strykerReaderUrls(), options: strykerOptions }),
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
    const files = JSON.parse(String(stdout));
    return Array.isArray(files) ? files : null;
  } catch {
    return null;
  }
}

/**
 * The child `sandboxInputFiles` runs: read `{ entryUrl, readerUrl, options }`
 * from stdin, enumerate with Stryker's `ProjectReader`, print the relative paths
 * as JSON.
 *
 * The package entry is loaded first, on purpose. `project-reader.js` and
 * Stryker's options validator import each other, and the validator computes its
 * defaults at load time using `MUTATION_RANGE_REGEX` from the reader. Entered at
 * the reader, that constant is still uninitialised when the validator runs, the
 * import throws, and the preflight would silently fall back to tracked files.
 * Loading the entry evaluates the graph in the order a real run does.
 */
const SANDBOX_INPUT_READER = `
import fsPromises from 'fs/promises';
import { relative, sep } from 'path';
let raw = '';
for await (const chunk of process.stdin) raw += chunk;
const { entryUrl, readerUrl, options } = JSON.parse(raw);
await import(entryUrl);
const { ProjectReader } = await import(readerUrl);
const silent = { debug() {}, info() {}, warn() {}, error() {}, isDebugEnabled: () => false };
const files = await new ProjectReader(fsPromises, silent, options).resolveInputFileNames();
const here = process.cwd();
process.stdout.write(JSON.stringify(files.map((file) => relative(here, file).split(sep).join('/'))));
`;

/**
 * This checkout's installed `@stryker-mutator/core`: its entry point and its
 * `ProjectReader`. The package exports only its entry point, so the reader is
 * named by file.
 */
function strykerReaderUrls() {
  const root = dirname(createRequire(import.meta.url).resolve('@stryker-mutator/core/package.json'));
  return {
    entryUrl: pathToFileURL(join(root, 'dist', 'src', 'index.js')).href,
    readerUrl: pathToFileURL(join(root, 'dist', 'src', 'fs', 'project-reader.js')).href,
  };
}

/**
 * The run spec an invocation hands the Stryker configuration. The preflight
 * builds the same one, so the files it asks about are the ones this run copies.
 */
export function runSpecFor(options, scope) {
  return {
    mutate: scope.mutate,
    testFiles: scope.testFiles,
    out: options.out,
    label: scope.label,
    concurrency: options.concurrency,
    timeoutMs: options.timeoutMs,
    coverageAnalysis: options.coverageAnalysis,
    incremental: options.incremental,
    dryRunOnly: options.mode === 'dry-run',
  };
}

/**
 * The report paths that land outside this checkout's work tree, which Git
 * cannot be asked about: `git check-ignore` dies with 128 on a path outside the
 * repository, for the whole batch, and that reads as "no answer". A file there
 * cannot be committed to this repository either, so it needs no ignore rule —
 * but it must be told apart honestly, not by swallowing Git's error.
 *
 * Symlinks are resolved on both sides (as far as the path exists yet), so an
 * `--out` that reaches the checkout through an alias is still asked of Git
 * rather than waved through as external. `realpath` is injected for tests.
 */
export function pathsOutsideWorktree(paths, root, { realpath = realpathOfNearest } = {}) {
  const base = realpath(resolve(root));
  return paths.filter((path) => {
    const rel = relative(base, realpath(resolve(root, path)));
    return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
  });
}

/**
 * The spelling of `--out` to build the Git probe paths from.
 *
 * `git check-ignore` rejects a pathname that climbs out with `..`, even one that
 * lands back inside the work tree, and dies for the whole batch — so an
 * `--out ../repo/.mutation` naming the ordinary ignored directory would fail
 * `reports-ignored` and block every run. An `--out` that resolves inside `root`
 * is therefore restated relative to it; one that resolves outside is returned
 * as given, for `pathsOutsideWorktree` to classify.
 *
 * "Resolves" includes symlinks, on both sides, exactly as `pathsOutsideWorktree`
 * decides it: an alias outside the checkout that points back into it (say
 * `/tmp/alias -> <root>/.mutation`) is in-tree there, so it must reach Git in
 * its in-tree spelling too — Git dies with 128 on the outside one. `realpath`
 * is injected for tests.
 */
export function gitProbeOut(out, root, { realpath = realpathOfNearest } = {}) {
  const rel = relative(realpath(resolve(root)), realpath(resolve(root, String(out))));
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return out;
  return rel === '' ? '.' : rel;
}

/** `realpathSync` of the nearest existing ancestor, with the rest re-appended. */
function realpathOfNearest(path) {
  const rest = [];
  let current = path;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return path;
    rest.unshift(basename(current));
    current = parent;
  }
  return join(realpathSync(current), ...rest);
}

/**
 * Does Git actually refuse to commit every raw artifact a run writes?
 *
 * `.gitignore` is evaluated as a program, not read as a list: a later `!` rule
 * re-includes what an earlier one excluded, and a tracked path is never
 * ignored. Matching a single line against `<out>` sees neither, and reports
 * that carry the full source of every mutated file are the wrong thing to be
 * optimistic about — so the verdict is Git's, and this only relays it. No
 * answer fails the check rather than passing it.
 *
 * `externalPaths` are the report paths outside the work tree (see
 * `pathsOutsideWorktree`): they were never asked of Git and cannot be committed
 * here, so they count as covered. The in-tree ones, the lock always among them,
 * still need Git's answer.
 */
export function reportsIgnoredFinding({ out, reportPaths, ignoredPaths, externalPaths = [] }) {
  if (!ignoredPaths) {
    return {
      check: 'reports-ignored',
      ok: false,
      detail: `git could not say whether ${out} is ignored — run this inside the checkout's work tree with git available`,
    };
  }
  const covered = new Set([...ignoredPaths, ...externalPaths].map(normalizeIgnorePath));
  const exposed = reportPaths.filter((path) => !covered.has(normalizeIgnorePath(path)));
  const listed = capList(exposed, MAX_LISTED_EXPOSED);
  const external = new Set(externalPaths.map(normalizeIgnorePath));
  const externalCount = reportPaths.filter((path) => external.has(normalizeIgnorePath(path))).length;
  return {
    check: 'reports-ignored',
    ok: exposed.length === 0,
    detail:
      exposed.length === 0
        ? externalCount > 0
          ? `${out} is outside this work tree, so its ${externalCount} raw artifact path(s) cannot be committed here; git ignores the run lock at ${RUN_LOCK_PATH} (${reportPaths.length - externalCount} in-tree path(s) checked)`
          : `git ignores every raw artifact under ${out}, and the run lock at ${RUN_LOCK_PATH} (${reportPaths.length} paths checked)`
        : `git would commit ${listed.shown.join(', ')}${listed.omitted > 0 ? ` (+${listed.omitted} more)` : ''} — raw reports carry mutated source and must stay out of the repository`,
  };
}

/** One spelling for a path on both sides of the comparison with Git's answer. */
function normalizeIgnorePath(path) {
  return String(path).replace(/^\.\//, '').replace(/\/+$/, '');
}

/**
 * Reduce a mutation-testing report to a bounded, publishable summary. The raw
 * report holds the full source of every mutated file and absolute sandbox
 * paths; nothing of either reaches this object. Replacements are truncated and
 * sanitized, and the mutant lists are capped.
 *
 * `killedByTest` and `coveredByTest` are kept as SEPARATE per-test-file counts
 * on purpose: #1110 §7 item 4 requires a mutant a suite killed before to still
 * be killed by it, and treats "now only covered" as a lost detection. Merging
 * the two would hide exactly that.
 */
export function summarizeMutationReport(report, paths = {}) {
  const testIdToFile = new Map();
  for (const [file, entry] of Object.entries(report?.testFiles ?? {})) {
    for (const test of entry?.tests ?? []) testIdToFile.set(test.id, sanitizePath(file, paths));
  }
  const byStatus = {};
  const perFile = [];
  const killedByTest = {};
  const coveredByTest = {};
  const survivors = [];
  const errors = [];
  const truncate = (text) => {
    const clean = sanitizeText(String(text ?? ''), paths).replace(/\s+/g, ' ').trim();
    return clean.length > 80 ? `${clean.slice(0, 77)}...` : clean;
  };
  for (const [file, entry] of Object.entries(report?.files ?? {})) {
    const safeFile = sanitizePath(file, paths);
    const fileStatuses = {};
    for (const mutant of entry?.mutants ?? []) {
      const status = mutant.status ?? 'Pending';
      byStatus[status] = (byStatus[status] ?? 0) + 1;
      fileStatuses[status] = (fileStatuses[status] ?? 0) + 1;
      const where = { file: safeFile, line: mutant.location?.start?.line ?? null, mutator: mutant.mutatorName };
      if (status === 'Survived' || status === 'NoCoverage') survivors.push({ ...where, status, replacement: truncate(mutant.replacement) });
      if (ERROR_STATUSES.includes(status)) errors.push({ ...where, status, reason: truncate(mutant.statusReason) });
      for (const id of mutant.killedBy ?? []) {
        const test = testIdToFile.get(id) ?? '<unknown test file>';
        killedByTest[test] = (killedByTest[test] ?? 0) + 1;
      }
      for (const id of mutant.coveredBy ?? []) {
        const test = testIdToFile.get(id) ?? '<unknown test file>';
        coveredByTest[test] = (coveredByTest[test] ?? 0) + 1;
      }
    }
    perFile.push({ file: safeFile, total: (entry?.mutants ?? []).length, byStatus: fileStatuses });
  }
  const count = (status) => byStatus[status] ?? 0;
  const detected = count('Killed') + count('Timeout');
  const valid = detected + count('Survived') + count('NoCoverage');
  return {
    schemaVersion: report?.schemaVersion ?? 'unknown',
    total: Object.values(byStatus).reduce((sum, n) => sum + n, 0),
    byStatus,
    perFile,
    mutationScore: valid > 0 ? Number(((detected / valid) * 100).toFixed(2)) : null,
    killedByTest,
    coveredByTest,
    survivors: capList(survivors),
    errors: capList(errors),
  };
}

/**
 * The sandbox build record, masked the same way everything else that may be
 * quoted from a run is. The wrapper writes repo-relative paths and bounded
 * diagnostic counts already; this closes the one gap it cannot — a spawn
 * error's message, which comes from the OS and may name an absolute path.
 */
export function sanitizeBuildRecord(record, paths = {}) {
  if (!record) return null;
  const text = (value) => sanitizeText(String(value), paths);
  return {
    ...record,
    outputs: (record.outputs ?? []).map((output) => ({
      ...output,
      source: sanitizePath(output.source, paths),
      dist: sanitizePath(output.dist, paths),
    })),
    reasons: (record.reasons ?? []).map(text),
    warnings: (record.warnings ?? []).map(text),
  };
}

/**
 * The numbers a dry run exists to produce, read out of the lines Stryker printed.
 *
 * A dry run activates no mutant and so writes no `mutation.json`; the mutant
 * count and the cost of one pass over the scoped suites — the two figures §6 of
 * the harness document owes slice 4 — exist nowhere else. Every capture is a
 * plain integer, so nothing here needs sanitizing, and a line that is absent
 * yields `null` rather than a default: a number that was never reported must
 * never be relayed as a small one. The patterns tolerate the ANSI colouring and
 * the `HH:MM:SS (pid) INFO Category` prefix Stryker writes around them.
 */
export function parseDryRunFacts(log) {
  const text = String(log ?? '');
  const found = /Found (\d+) of (\d+) file\(s\) to be mutated/.exec(text);
  const instrumented = /Instrumented (\d+) source file\(s\) with (\d+) mutant\(s\)/.exec(text);
  // Only the *succeeded* form is matched. A failed initial test run means the
  // scoped suites do not pass unchanged, which is a finding rather than a cost.
  const initial = /Initial test run succeeded\. Ran (\d+) tests? in [^(]*\(net (\d+) ms, overhead (\d+) ms\)/.exec(text);
  return {
    filesMutated: instrumented ? Number(instrumented[1]) : found ? Number(found[1]) : null,
    filesConsidered: found ? Number(found[2]) : null,
    mutants: instrumented ? Number(instrumented[2]) : null,
    tests: initial ? Number(initial[1]) : null,
    netMs: initial ? Number(initial[2]) : null,
    overheadMs: initial ? Number(initial[3]) : null,
  };
}

/**
 * What a full run over the same scope would cost, projected from the dry run.
 *
 * Deliberately a *reference* figure and labelled as one. With `coverageAnalysis:
 * off` every mutant runs the whole scoped selection, so one dry-run pass is what
 * an **undetected** mutant costs; a detected one usually costs less, because
 * Stryker stops a test run at the first failure, and a timed-out one costs more.
 * Under `all` or `perTest` a mutant runs a subset, so one full pass is not its
 * cost at all and no projection is offered — an unstated assumption is how a
 * budget becomes wrong by an order of magnitude.
 */
export function dryRunCost(facts, { concurrency, coverageAnalysis } = {}) {
  const workers = Math.max(1, Number(concurrency) || 1);
  const none = (basis) => ({ mutants: facts?.mutants ?? null, workers, perMutantMs: null, projectedMs: null, basis });
  if (!facts || facts.mutants === null || facts.netMs === null || facts.overheadMs === null) {
    return none('Stryker reported no mutant count, or no completed initial test run, so no projection is possible.');
  }
  if (coverageAnalysis !== 'off') {
    return none(`coverage analysis is \`${coverageAnalysis}\`, under which a mutant runs a subset of the suites, so one full pass is not its cost.`);
  }
  const perMutantMs = facts.netMs + facts.overheadMs;
  return {
    mutants: facts.mutants,
    workers,
    perMutantMs,
    projectedMs: Math.round((facts.mutants * perMutantMs) / workers),
    basis:
      'one full pass over the scoped suites per mutant, which is what an undetected mutant costs under `coverageAnalysis: off`. ' +
      'A detected mutant usually costs less (Stryker stops at the first failing test) and a timed-out one costs more, so this is a reference figure, not a measurement.',
  };
}

/** A duration a reader can weigh against a budget, rather than a count of milliseconds. */
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'unknown';
  const seconds = Math.round(ms / 1000);
  if (seconds < 90) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${minutes % 60} min`;
}

/**
 * The smoke check's verdict. It asks the two questions the harness itself is on
 * trial for — did the unchanged sandbox build and pass, and did a deliberate
 * mutation actually change what the tests observed — and deliberately does NOT
 * require every mutant to die. A surviving mutant is reported for judgement,
 * not silently treated as a harness failure.
 */
export function smokeVerdict(run, summary) {
  const errorCount = ERROR_STATUSES.reduce((sum, status) => sum + (summary.byStatus?.[status] ?? 0), 0);
  const detected = (summary.byStatus?.Killed ?? 0) + (summary.byStatus?.Timeout ?? 0);
  // A run that never completed produced no evidence about the tests, so it is
  // reported as exactly that and nothing else. Falling through to the counts
  // below would state "no mutant was detected" and "no mutants were generated"
  // about a run that never reached the mutants — a conclusion about the pilot
  // scope drawn from a harness failure, which is the misreading this pilot must
  // never publish.
  if (run.state !== 'complete') {
    return {
      ok: false,
      detected,
      errorCount,
      reasons: [`the Stryker run did not complete (${run.reason}) — no conclusion about the tests can be drawn from it`],
    };
  }
  const reasons = [];
  if (run.reason !== 'passed') reasons.push(`the Stryker run exited non-zero (${run.reason})`);
  if (errorCount > 0) {
    reasons.push(`${errorCount} mutant(s) ended in a compile or runtime error — the sandbox build or the test run is broken, not the tests`);
  }
  if (summary.total === 0) reasons.push('no mutants were generated in the smoke range');
  if (detected === 0) {
    reasons.push('no mutant was detected — mutants are not reaching the code the tests execute (check the sandbox build and jest.enableFindRelatedTests)');
  }
  return { ok: reasons.length === 0, detected, errorCount, reasons };
}

/** Classify the Stryker process the same way the cost baseline classifies its commands. */
export function classifyStrykerRun({ exitCode, signal, timedOut, interruptedBy, groupSurvived, reportPresent, consoleLost }) {
  // Part of the run outlived SIGKILL and still holds `pilot.lock` (see
  // `recordStrykerSurvivors`), so a leader that exited zero is not a finished
  // run: publishing `complete (passed)` beside a lock that refuses the next one
  // would be a contradiction, and the survivor may still be mutating the sandbox.
  if (groupSurvived) return { state: 'interrupted', reason: 'group-survived' };
  if (interruptedBy) return { state: 'interrupted', reason: `parent-signal:${interruptedBy}` };
  if (timedOut) return { state: 'interrupted', reason: 'timeout' };
  if (signal) return { state: 'interrupted', reason: `signal:${signal}` };
  // The console this run was writing to went away mid-run — whoever started this
  // command stopped reading (a wrapper's own command timeout, a closed terminal,
  // a severed ssh session). Stryker inherits that same stream, so its next write
  // fails with EPIPE and it dies with a non-zero exit that is about the broken
  // pipe and not about the mutants. Reporting that as `exit:N` would publish a
  // harness failure as a statement about the pilot suites, which is exactly the
  // misreading this pilot must never make; it is an interruption, and
  // `smokeVerdict` already refuses to conclude anything from one. A run that
  // still exited zero with its report written finished before the pipe broke,
  // and is reported on that evidence rather than on the pipe.
  if (consoleLost && !(exitCode === 0 && reportPresent)) {
    return { state: 'interrupted', reason: `console-closed:${consoleLost}` };
  }
  if (!reportPresent) return { state: 'interrupted', reason: 'no-report' };
  return { state: 'complete', reason: exitCode === 0 ? 'passed' : `exit:${exitCode}` };
}

/**
 * Record the first write failure on the streams Stryker inherits, and keep it
 * from killing this process: an unhandled `error` on `process.stdout` would end
 * the driver before it could write `summary.json`, losing the record of a run
 * that had already done its work. Returns the mutable `{ lost }` state the
 * classifier reads.
 */
export function watchConsole(streams) {
  const state = { lost: null };
  for (const stream of streams) stream.on('error', (error) => { state.lost ??= error?.code ?? 'EPIPE'; });
  return state;
}

/** How long `probeConsole` waits for a write to be acknowledged. */
export const CONSOLE_PROBE_TIMEOUT_MS = 2_000;

/**
 * Write `text` and resolve with the code of the failure it met, or null when it
 * landed. The heartbeat alone cannot be relied on to discover a closed console:
 * a consumer that goes away between two heartbeats and a Stryker that writes
 * into the break first means only the child sees EPIPE, dies of it, and the
 * driver has written nothing since — so, asked right away, the console would
 * look intact and the run would read as an ordinary nonzero exit. This write is
 * the one the classifier can count on having happened.
 *
 * A write that is never acknowledged — a live reader that is simply not reading
 * — is not a lost console, so the wait is bounded and ends in null.
 */
export function probeConsole(stream, text, timeoutMs = CONSOLE_PROBE_TIMEOUT_MS) {
  return new Promise((done) => {
    let settled = false;
    const settle = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done(error ? (error.code ?? 'EPIPE') : null);
    };
    const timer = setTimeout(() => settle(null), timeoutMs);
    try {
      stream.write(text, settle);
    } catch (error) {
      settle(error);
    }
  });
}

/**
 * One line while Stryker is otherwise silent. Two jobs: a dry run spends minutes
 * inside a single initial test run with no output at all, and an operator should
 * be able to tell that from a hang; and the write itself is what discovers a
 * console that went away, because nothing else here writes during the run.
 */
export function heartbeatLine(mode, elapsedMs) {
  return `  … ${mode} still running — ${Math.round(elapsedMs / 1000)} s elapsed\n`;
}

/**
 * What a `--background` run is doing, from the state file the start wrote and
 * two facts the caller looks up: is that pid still alive, and did the run write
 * its summary. The four answers are deliberately distinct, because the one thing
 * this harness must never do is report a run that produced no evidence as though
 * it had produced some:
 *
 *   absent    nothing was ever started here — not a statement about any run.
 *   running   alive and inside its own budget; poll again.
 *   overdue   alive but past the budget its own driver enforces, so it is stuck
 *             somewhere that budget does not cover, not making progress.
 *   lost      gone without a summary — killed, or it crashed before writing one.
 *   finished  a summary exists; the summary, not this classification, is the
 *             result.
 *
 * `summaryPresent` means a summary carrying THIS run's id — see `RUN_ID_ENV`.
 * Any other summary in the directory belongs to a different invocation and says
 * nothing about this one.
 */
export function classifyBackgroundRun({ state, alive, summaryPresent, now, graceMs = BACKGROUND_GRACE_MS }) {
  if (!state) return { status: 'absent', elapsedMs: 0 };
  const elapsedMs = Math.max(0, now - state.startedAtMs);
  if (summaryPresent) return { status: 'finished', elapsedMs };
  if (!alive) return { status: 'lost', elapsedMs };
  return { status: elapsedMs > state.budgetMs + graceMs ? 'overdue' : 'running', elapsedMs };
}

/** The last `limit` lines of a log, for a report that must stay bounded. */
export function tailLines(text, limit = MAX_LOG_TAIL_LINES) {
  const lines = String(text).split('\n');
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.slice(Math.max(0, lines.length - limit));
}

/**
 * The log tail `--report` prints when a run left no summary to relay.
 *
 * Both halves are masked, not just the contents: `--out` may be given as an
 * absolute path, and the run state then records an absolute log path. Naming it
 * verbatim above sanitized lines would disclose the checkout and the username
 * through the one part of this output that is meant to be shareable.
 */
export function renderLogTail(log, { logPath, paths } = {}) {
  const tail = tailLines(sanitizeText(String(log ?? ''), paths));
  if (tail.length === 0) return '';
  return `\nlast ${tail.length} line(s) of ${sanitizePath(logPath ?? '<unknown log>', paths)}:\n${tail.join('\n')}\n`;
}

/**
 * Quote a path for the shell only where it needs it, so the common case stays
 * readable and a path with a space or a quote in it is still one argument.
 * The result is a line for a human to read and re-type, not something this
 * harness ever executes — so it is quoted for the shell that human is in.
 *
 * On Windows that is `cmd.exe` or PowerShell, and neither treats a single quote
 * the way a POSIX shell does: `cmd.exe` passes it through literally, so a
 * POSIX-quoted `C:\…` path would name a directory with quote characters in it.
 * Both shells accept double quotes as argument delimiters, and a backslash is an
 * ordinary path separator there rather than an escape, so an absolute path needs
 * no quoting at all unless it contains a space. A Windows file name cannot
 * contain `"`; one that somehow arrives is doubled, the form both shells read
 * as a literal quote inside a quoted argument.
 */
export function shellArg(value, { platform = process.platform } = {}) {
  const text = String(value);
  if (platform === 'win32') {
    if (text !== '' && /^[A-Za-z0-9_@+=:,.\\/-]+$/.test(text)) return text;
    return `"${text.replace(/"/g, '""')}"`;
  }
  if (text !== '' && /^[A-Za-z0-9_@%+=:,./-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, "'\\''")}'`;
}

/**
 * The `npm run` invocation that acts on THIS run's output directory: `action` is
 * `start` or `report`.
 *
 * `--out` moves the report directory, and both a start and a `--report` act on
 * the directory their own options name — so an instruction that drops the option
 * sends the operator to the default `.mutation/<label>`, which holds either
 * nothing or an unrelated invocation's evidence. A non-default path is therefore
 * restated, after the `--` npm uses to forward arguments to the script.
 *
 * The path is the operator's own argument echoed back on their own console, so it
 * is not masked: `sanitizePath` exists for the summary and the log tail, the
 * parts meant to be shareable, and a masked path here would name no directory
 * this command could act on — which is the whole point of printing it.
 */
export function pilotCommand(mode, action, out = DEFAULT_OUT, { platform = process.platform } = {}) {
  const script = `npm run mutation:${mode}:${action}`;
  if (out === undefined || out === null || out === DEFAULT_OUT) return script;
  return `${script} -- --out ${shellArg(out, { platform })}`;
}

/**
 * The one-line status a `--report` leads with, and whether it is a failure.
 *
 * `reportDir` is the directory being read, in the form it should be displayed —
 * the caller masks it, as it does every other path it prints. It is a parameter
 * because `--out` moves that directory, and a line naming the default one while
 * reading another is a report about a directory nobody asked about.
 */
export function renderBackgroundReport(classification, { label, mode, startCommand, reportCommand, reportDir = `${DEFAULT_OUT}/${label}` }) {
  const seconds = Math.round(classification.elapsedMs / 1000);
  switch (classification.status) {
    case 'absent':
      return { ok: false, line: `no background ${mode} run has been started — start one with \`${startCommand}\`` };
    case 'running':
      return { ok: true, line: `background ${mode} run still going — ${seconds} s elapsed; read it again with \`${reportCommand}\`` };
    case 'overdue':
      return { ok: false, line: `background ${mode} run is ${seconds} s old, past its own budget, and has written no summary — it is stuck` };
    case 'lost':
      return { ok: false, line: `background ${mode} run ended after ${seconds} s leaving no summary of its own — no conclusion about the tests can be drawn from it` };
    default:
      return { ok: true, line: `background ${mode} run finished; reading ${reportDir}/summary.md` };
  }
}

/**
 * Does this recorded state describe the process asking about it? A `--background`
 * start writes the state file naming its detached copy, and that copy then runs
 * the very guard that refuses to start while another run owns the directory — so
 * without this it would refuse to start itself, and no background run could ever
 * begin.
 *
 * A record that carries a run id is answered by that id alone. The pid is not a
 * second, equally good identifier there: a driver killed outright can leave its
 * record behind while the Stryker group it started runs on, and the host is free
 * to recycle that pid onto an unrelated later invocation of this harness. Pid
 * equality would then make the new run "itself", let it adopt the lock, overwrite
 * the surviving group's identity and run beside it — the one thing this lock
 * exists to prevent. Every process that legitimately meets its own recorded run
 * knows that id: the start generates it, and the detached copy receives it in
 * `RUN_ID_ENV`. Only a record with no id at all — a foreground run's — is
 * identified by pid.
 */
export function isSelfRun(state, { pid, runId }) {
  if (!state) return false;
  if (state.runId) return Boolean(runId) && state.runId === runId;
  return state.pid === pid;
}

/** Is this pid still running? `EPERM` means it exists and is not ours, which is still alive. */
export function processAlive(pid, kill = process.kill.bind(process)) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/**
 * Is any process of this group still running? A negative pid addresses the whole
 * group, so this answers for the Stryker leader AND the workers it forked, which
 * is what "the run is still on the host" means — the leader can be gone while
 * its workers still hold the CPUs and the sandbox.
 */
export function processGroupAlive(pgid, kill = process.kill.bind(process)) {
  if (!Number.isInteger(pgid) || pgid <= 0) return false;
  try {
    kill(-pgid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/**
 * When the host says the process now on this pid was created, or null when it
 * cannot say — a pid already gone, or no `ps` to ask (Windows).
 *
 * This is the one fact that tells a recorded process apart from a later,
 * unrelated one wearing its number. `kill(pid, 0)` answers about the number
 * only, and a host recycles numbers: without a creation time a lock left by a
 * killed driver keeps refusing every run for as long as whatever inherited its
 * pid happens to live, which is precisely the wedge stale-lock recovery exists
 * to prevent.
 *
 * Second granularity is as fine as the question needs: pids are handed out
 * across the whole pid space before wrapping, so the process that ends up on a
 * recycled number is not one started in the same second as the process that had
 * it before.
 *
 * `ps` renders `lstart` in the caller's time zone and locale, and the stamp is
 * compared as a string by whichever invocation reads the lock next — which may
 * run under a different `TZ` or `LANG` than the one that wrote it. Rendered in
 * each one's own zone, the same instant would compare unequal and a live run
 * would read as recycled. So `ps` is always asked in UTC and the C locale, which
 * makes the stamp a function of the process alone.
 *
 * Windows has no `ps`, and a host that cannot stamp its records leaves every
 * lock it writes unrefutable: a killed run's pid, once recycled, would hold the
 * lock for as long as the stranger lives. So on Windows the creation time is
 * asked of CIM through PowerShell instead (`processStampCommand`), rendered as a
 * round-trip UTC timestamp for the same reason `ps` is asked in UTC.
 */
export const PROCESS_STAMP_ENV = { TZ: 'UTC', LC_ALL: 'C', LANG: 'C' };

/** The command that reports when `pid` was created on `platform`, as `[file, args]`. */
export function processStampCommand(pid, { platform = process.platform } = {}) {
  if (platform === 'win32') {
    // `pid` is a validated positive integer, so interpolating it cannot inject.
    const script =
      `$p = Get-CimInstance -ClassName Win32_Process -Filter 'ProcessId=${pid}'; ` +
      `if ($p) { $p.CreationDate.ToUniversalTime().ToString('o') }`;
    return ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]];
  }
  return ['ps', ['-o', 'lstart=', '-p', String(pid)]];
}

export function processStartedAt(pid, { platform = process.platform, exec = execFileSync } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    // stderr is discarded: a pid that has exited makes `ps` exit non-zero, which
    // is an answer here and not a fault worth printing over the run's output.
    const [file, args] = processStampCommand(pid, { platform });
    const started = String(
      exec(file, args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        env: { ...process.env, ...PROCESS_STAMP_ENV },
        windowsHide: true,
        // Bounded, because this is called from the lock check and from a process
        // exit handler: a probe that hung on a loaded host would hang those
        // instead of answering "cannot say", which the caller already handles.
        timeout: PROCESS_PROBE_TIMEOUT_MS,
      }) ?? '',
    ).trim();
    return started === '' ? null : started;
  } catch {
    return null;
  }
}

/**
 * How the process now on `pid` relates to the record that named it:
 *
 *   match     created when the record says, so it IS the recorded process.
 *   recycled  created at some other time: the host has put an unrelated process
 *             on that number, and the recorded one is gone.
 *   unknown   nothing to compare — a record written without a creation stamp, or
 *             a host that cannot report one. Never a refutation: a run that may
 *             still be live keeps its lock, which is the safe direction.
 */
export function pidIdentity(pid, expected, startedAt = processStartedAt) {
  if (!expected) return 'unknown';
  const actual = startedAt(pid);
  if (!actual) return 'unknown';
  return actual === expected ? 'match' : 'recycled';
}

/**
 * Is the process a record named still running — that process, and not merely its
 * number? Existence is asked first because it is free; the creation time is only
 * consulted for a pid that exists, which is the only case a recycled number can
 * hide in.
 */
export function recordedProcessAlive(pid, expected, kill = process.kill.bind(process), startedAt = processStartedAt) {
  if (!processAlive(pid, kill)) return false;
  return pidIdentity(pid, expected, startedAt) !== 'recycled';
}

/**
 * Which part of the run a lock record names is still on the host: `'driver'`,
 * `'group'`, or null when nothing of it is left.
 *
 * The driver's own pid is not the whole run. `runTimed` starts Stryker in its
 * own process group precisely so the driver can stop the group as a unit — and
 * the same detachment means a driver killed outright (SIGKILL, an OOM kill)
 * leaves that group running with nobody to stop it or to release the lock. A
 * check that asked only about the driver would call such a lock abandoned, clear
 * it, and start a second run into the same `stryker-tmp` the surviving group is
 * still copying into and deleting from. So the group the driver recorded in its
 * own lock record is checked too, and a live group holds the lock exactly as a
 * live driver does.
 *
 * `strykerGroup` is false on Windows, where `runTimed` starts no process group;
 * there the leader's pid is asked about, together with `strykerSurvivors` — the
 * descendants `runTimed` reported still running after its own kill gave up.
 *
 * Both halves are asked about the recorded PROCESS, not about the number it ran
 * on: a lock is read long after its run was killed, and by then the host may
 * have handed that pid to something else entirely. See `processStartedAt` for
 * the stamp that settles it, and `pidStart` / `strykerPidStart` in the record
 * for where the stamps come from.
 */
export function lockOwnerAlive(holder, kill = process.kill.bind(process), startedAt = processStartedAt) {
  if (!holder) return null;
  if (recordedProcessAlive(holder.pid, holder.pidStart, kill, startedAt)) return 'driver';
  return strykerGroupAlive(holder, kill, startedAt) ? 'group' : null;
}

/**
 * Is the Stryker run this lock record names still on the host? See
 * `lockOwnerAlive`.
 *
 * A group is judged through its leader first, because the leader is the only
 * member the record can name individually:
 *
 *   leader still there, stamp matches   the run is live; nothing else to ask.
 *   leader still there, stamp differs   the pid was recycled — and a host may
 *                                       only recycle a pid once it is free as a
 *                                       process group id too (POSIX), so no
 *                                       member of the recorded group is left.
 *                                       The group id now answers for a stranger's
 *                                       group, and asking it would report that
 *                                       stranger as this run.
 *   leader gone, group answers          the leader's orphaned workers, and only
 *                                       they: while they hold the pgid the host
 *                                       cannot have given the number away.
 */
export function strykerGroupAlive(holder, kill = process.kill.bind(process), startedAt = processStartedAt) {
  const child = holder?.strykerPid;
  const stamp = holder?.strykerPidStart;
  if (!holder?.strykerGroup) {
    // Without a group id the leader cannot answer for its workers, and on
    // Windows it is often the first thing gone: `taskkill` reaches the leader
    // while a worker it spawned survives. So the pids `runTimed` found still
    // running after it gave up are asked about too, each as its recorded process.
    if (recordedProcessAlive(child, stamp, kill, startedAt)) return true;
    const survivors = Array.isArray(holder?.strykerSurvivors) ? holder.strykerSurvivors : [];
    return survivors.some((s) => recordedProcessAlive(s?.pid, s?.pidStart, kill, startedAt));
  }
  if (processAlive(child, kill)) return pidIdentity(child, stamp, startedAt) !== 'recycled';
  return processGroupAlive(child, kill);
}

/**
 * Does a lock already on disk stop this process from starting?
 *
 * Every live owner blocks, whatever state it is in. This is deliberately a
 * coarser question than `classifyBackgroundRun` asks: a run past its budget with
 * nothing written is *stuck*, not finished, and its Stryker group is still on the
 * host burning the parallelism this slice is required to bound. Reading
 * "overdue" as "free to start on top of" is how two runs end up sharing
 * `<out>/stryker-tmp`. A record the owner of which is gone does not block —
 * that is a lock nobody released, and the caller clears it.
 *
 * `alive` is the answer `lockOwnerAlive` gives, so "the owner is gone" means the
 * driver AND the Stryker process group it recorded are gone, not just the
 * driver.
 *
 * `liveness` is that same answer unreduced, and `'group'` — the driver gone while
 * the Stryker group it recorded runs on — blocks whatever the record looks like.
 * No lock in that state is ever waiting for the process reading it: a start
 * records no group, only a driver that has already begun a run does. So such a
 * record belongs to a run still on the host, even where a recycled pid makes it
 * resemble this process, and a self-match there would let the caller adopt a live
 * run's lock and put a second Stryker beside it.
 *
 * `holder: null` means a lock file exists whose record could not be read. The
 * caller decides that case by age; this function only answers for a record it
 * has.
 */
export function lockBlocks(holder, { pid, runId, alive, liveness }) {
  if (!holder) return false;
  if (liveness === 'group') return true;
  if (isSelfRun(holder, { pid, runId })) return false;
  return alive;
}

/**
 * What a refused start prints: who holds the lock, and how to look at it.
 *
 * `liveness` is what `lockOwnerAlive` found, because the two cases need
 * different advice. A live driver can be read back or waited for; a lock whose
 * driver is gone while its Stryker group survives has no console and no
 * `:report` to offer — the only useful thing to say is which process group is
 * still running and that the lock clears itself once it exits.
 */
export function renderLockRefusal(holder, { now, liveness, lock = RUN_LOCK_PATH }) {
  if (!holder) {
    return (
      `another mutation run may own this checkout: its lock (${lock}) names no readable run.\n` +
      `if no run is live, delete ${lock} and start again`
    );
  }
  const seconds = Math.round(Math.max(0, now - (holder.startedAtMs ?? now)) / 1000);
  if (liveness === 'group' && !holder.strykerGroup) {
    // Windows: `runTimed` starts no process group, so there is none to stop.
    // `lockOwnerAlive` answered for the leader or for a worker `runTimed` found
    // still running after `taskkill` gave up — and the leader is often the
    // first thing gone — so every recorded pid is named, not just the leader.
    const survivors = (Array.isArray(holder.strykerSurvivors) ? holder.strykerSurvivors : [])
      .map((s) => s?.pid)
      .filter((pid) => Number.isInteger(pid));
    const pids = [...new Set([holder.strykerPid, ...survivors].filter((pid) => Number.isInteger(pid)))];
    return (
      `a \`${holder.mode}\` run's driver is gone, but Stryker processes it started are still running ` +
      `(${seconds} s since the run began).\n` +
      `recorded Stryker pid(s): ${holder.strykerPid ?? 'none'} (leader, may already be gone)` +
      `${survivors.length ? `; ${survivors.join(', ')} (left running when its kill gave up)` : ''}.\n` +
      `they still hold the host and ${TEMP_DIR_NAME}, so ${lock} stays held.\n` +
      `stop whichever are still running (\`taskkill /PID <pid> /T /F\` for each of ${pids.join(', ') || 'them'}), ` +
      'or wait for them to exit — the next start clears the lock by itself once nothing of the run is left'
    );
  }
  if (liveness === 'group') {
    return (
      `a \`${holder.mode}\` run's driver is gone, but the Stryker process group it started ` +
      `(pid ${holder.strykerPid}, ${seconds} s since the run began) is still running.\n` +
      `that group still holds the host and ${TEMP_DIR_NAME}, so ${lock} stays held.\n` +
      'stop that process group, or wait for it to exit — the next start clears the lock by itself ' +
      'once nothing of the run is left'
    );
  }
  // `holder.out` is the refused run's own `--out`, recorded in its lock: the
  // report worth reading is the one in ITS directory, not in this caller's.
  const next = holder.background
    ? `read it with \`${pilotCommand(holder.mode, 'report', holder.out)}\`, or wait for it to finish`
    : 'wait for it to finish — it is writing to the console that started it';
  return (
    `a \`${holder.mode}\` run already owns this checkout (pid ${holder.pid}, ${seconds} s elapsed).\n` +
    `mutation runs here are serialized: they share the host, one ${TEMP_DIR_NAME} and ${lock}.\n` +
    next
  );
}

/**
 * Sandbox copies left behind by a run that was killed before Stryker could clean
 * up. Each is a full copy of the checkout, so they are worth removing — but only
 * once untouched for `maxAgeMs`, so a run in progress is never disturbed.
 */
export function staleSandboxes(entries, { now, maxAgeMs = STALE_SANDBOX_AGE_MS }) {
  return entries
    .filter((entry) => entry.directory && entry.name.startsWith(SANDBOX_PREFIX) && now - entry.mtimeMs >= maxAgeMs)
    .map((entry) => entry.name);
}

/**
 * One value rendered into a Markdown table cell as plain text.
 *
 * A mutant's replacement and a status reason are source text and tool output:
 * Stryker emits replacements containing `|` (it mutates `||` to `&&` and back),
 * and either can hold a backslash. Interpolated raw, one such value splits its
 * row into extra cells and the published table stops being readable. The
 * backslash is escaped first so that a backslash already in the value cannot
 * consume the escape this adds to the pipe behind it.
 */
export function markdownCell(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|');
}

/**
 * The same, for a cell rendered as a code span. Backslash escapes do not apply
 * inside a code span, so only the pipe is escaped — GFM honours `\|` there —
 * and a value containing backticks is fenced with one more backtick than its
 * longest run, which is how CommonMark says to put a backtick in a code span.
 */
export function markdownCodeCell(value) {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\|/g, '\\|');
  if (text === '') return '';
  const fence = '`'.repeat(Math.max(0, ...[...text.matchAll(/`+/g)].map((run) => run[0].length)) + 1);
  // A code span whose content starts or ends with a backtick needs the padding
  // space the renderer strips back off.
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}

/** Render the sanitized summary as markdown — the only shape meant to be quoted in a report. */
export function renderSummary(result) {
  const { mode, scope, environment, build, run, dryRun, summary, verdict } = result;
  // Only the interruption itself invalidates the run. `classifyStrykerRun` lets a
  // console lost *after* Stryker exited zero with its report written stand as
  // `complete (passed)`, and a summary that both carries that state and declares
  // its own evidence worthless is a contradiction a reader cannot resolve.
  const consoleClosed = run.state === 'interrupted' && String(run.reason ?? '').startsWith('console-closed:');
  const lines = [
    `# Scoped mutation run — ${mode}`,
    '',
    `- Mode: \`${mode}\``,
    `- Commit: \`${environment.commit}\``,
    `- Node: ${environment.node}; Stryker: ${environment.stryker}; jest-runner: ${environment.jestRunner}; Jest: ${environment.jest}`,
    `- Concurrency: ${environment.concurrency} of ${environment.parallelism} available; coverage analysis: \`${environment.coverageAnalysis}\``,
    // A summary that does not record either setting says so, rather than
    // implying the defaults it cannot vouch for.
    // `timeoutMs` is not the deadline itself: Stryker gives each mutant
    // `timeoutFactor × netTime + timeoutMs + overhead`, `netTime` being its
    // covering tests' dry-run time, and a mutant past THAT counts as detected.
    `- Per-mutant timeout: ${
      environment.timeoutFactor === undefined ? 'factor unrecorded' : `${environment.timeoutFactor}`
    } × dry-run test time + ${environment.timeoutMs === undefined ? 'unrecorded' : `${environment.timeoutMs} ms`} ` +
      '+ overhead (a mutant that exceeds that deadline counts as detected); ' +
      `incremental: ${
        environment.incremental === undefined
          ? 'unrecorded'
          : environment.incremental
            ? 'yes — verdicts for unchanged mutants are reused from an earlier run, not re-tested'
            : 'no'
      }`,
    `- Load average before/after: ${run.loadBefore} → ${run.loadAfter}`,
    `- Wall time: ${(run.wallMs / 1000).toFixed(1)} s; state: ${run.state} (${run.reason})`,
    `- Worktree dirty before the run: ${environment.worktreeDirty}`,
    // Stated in the artifact and not only in the reason code, because this is
    // the one interruption whose symptom (a non-zero Stryker exit) looks like a
    // result. A reader must not take anything below it as a finding.
    ...(consoleClosed
      ? [
          `- **This run's console was lost (\`${run.consoleLost}\`) before it finished.** Whatever started this`,
          '  command stopped reading its output, so Stryker died on the broken pipe. Nothing here is',
          '  evidence about the tests — re-run the command on its own.',
        ]
      : run.consoleLost
        ? [
            // Not an interruption: the state below was decided by Stryker's own
            // exit and report, so it stands. Said anyway, because console output
            // written after the loss is missing from `run.log` and a reader
            // comparing the two should know why.
            `- This run's console was lost (\`${run.consoleLost}\`), but that is not what decided its state:`,
            `  \`${run.state} (${run.reason})\` comes from Stryker's own exit and its report, not from what`,
            '  reached the console. Output written after the loss is missing from the log; nothing else here',
            '  depends on it.',
          ]
        : []),
    '',
    '## Scope',
    '',
    ...scope.mutate.map((file) => `- mutated: \`${file}\``),
    ...scope.testFiles.map((file) => `- tests: \`${file}\``),
    '',
  ];
  if (build) {
    // The link the pilot has to prove: the tests import the compiled output, so
    // a mutant only reaches them if the mutated source emitted instrumented
    // JavaScript into `dist/`.
    lines.push(
      '## Sandbox build',
      '',
      `- Result: ${build.ok ? 'ok' : 'FAILED'}; tsc exit ${build.tsc.exitCode}; ${build.tsc.diagnostics.lines} diagnostic line(s)`,
      ...build.outputs.map(
        (output) =>
          `- \`${output.source}\` → \`${output.dist}\`: ${
            !output.present ? 'NOT EMITTED' : output.instrumented ? 'emitted, instrumented' : 'emitted, NOT instrumented'
          }`,
      ),
      ...(build.warnings ?? []).map((warning) => `- warning: ${warning}`),
      ...(build.reasons ?? []).map((reason) => `- ${reason}`),
      '',
    );
  }
  if (dryRun) {
    // The dry run's whole output. It activates no mutant, so without this the
    // section below would correctly report "no mutation report" and the run
    // would have produced no readable evidence at all.
    lines.push('## Dry run', '');
    const { facts, cost } = dryRun;
    if (facts && facts.mutants !== null) {
      lines.push(
        `- Mutants instrumented: ${facts.mutants} across ${facts.filesMutated} file(s)` +
          `${facts.filesConsidered === null ? '' : ` of ${facts.filesConsidered} considered`}`,
      );
    } else {
      lines.push('- Mutants instrumented: not reported by this run');
    }
    if (facts && facts.netMs !== null) {
      lines.push(
        `- One pass over the scoped suites: ${facts.tests} test(s), ` +
          `${formatDuration(facts.netMs + facts.overheadMs)} (net ${facts.netMs} ms + overhead ${facts.overheadMs} ms)`,
      );
    } else {
      lines.push('- One pass over the scoped suites: no completed initial test run was reported');
    }
    if (cost && cost.projectedMs !== null) {
      // The arithmetic is shown so a reader can redo it against a different
      // concurrency rather than trusting the single number.
      lines.push(
        `- Reference cost of a full run at concurrency ${cost.workers}: **${formatDuration(cost.projectedMs)}** ` +
          `(${cost.mutants} × ${(cost.perMutantMs / 1000).toFixed(1)} s ÷ ${cost.workers})`,
        `- Basis: ${cost.basis}`,
      );
    } else {
      // One line, and it is the specific reason — a generic basis printed beside
      // a specific reason reads as though two different things went wrong.
      lines.push(`- No cost projection: ${dryRun.reason ?? cost?.basis ?? 'none recorded'}`);
    }
    lines.push('');
  }
  if (!summary) {
    lines.push('No mutation report was produced (a dry run, or an interrupted run).', '');
  } else {
    lines.push(
      '## Result',
      '',
      `- Mutants: ${summary.total}${summary.mutationScore === null ? '' : `; score ${summary.mutationScore}%`}`,
      ...Object.entries(summary.byStatus).map(([status, n]) => `- ${status}: ${n}`),
      '',
    );
    // Either map alone is evidence: a test that only covers mutants it no
    // longer kills is exactly the "covered but not killed" row to keep.
    const files = new Set([...Object.keys(summary.killedByTest), ...Object.keys(summary.coveredByTest)]);
    if (files.size > 0) {
      lines.push('### Detections per test file', '', '| Test file | killed | covered |', '|---|---|---|');
      for (const file of [...files].sort()) {
        lines.push(`| ${markdownCodeCell(file)} | ${summary.killedByTest[file] ?? 0} | ${summary.coveredByTest[file] ?? 0} |`);
      }
      lines.push('');
    }
    if (summary.survivors.total > 0) {
      lines.push('### Undetected mutants', '', '| File | Line | Mutator | Status | Replacement |', '|---|---|---|---|---|');
      for (const m of summary.survivors.shown)
        lines.push(
          `| ${markdownCodeCell(m.file)} | ${m.line} | ${markdownCell(m.mutator)} | ${markdownCell(m.status)} | ${markdownCodeCell(m.replacement)} |`,
        );
      if (summary.survivors.omitted > 0) lines.push(`| … | | | | ${summary.survivors.omitted} more omitted; see mutation.json |`);
      lines.push('');
    }
    if (summary.errors.total > 0) {
      lines.push('### Mutants the harness could not evaluate', '', '| File | Line | Mutator | Status | Reason |', '|---|---|---|---|---|');
      for (const m of summary.errors.shown)
        lines.push(`| ${markdownCodeCell(m.file)} | ${m.line} | ${markdownCell(m.mutator)} | ${markdownCell(m.status)} | ${markdownCell(m.reason)} |`);
      if (summary.errors.omitted > 0) lines.push(`| … | | | | ${summary.errors.omitted} more omitted; see mutation.json |`);
      lines.push('');
    }
  }
  if (verdict) {
    lines.push('## Verdict', '', verdict.ok ? 'PASS' : 'FAIL', '');
    for (const reason of verdict.reasons) lines.push(`- ${reason}`);
    if (verdict.reasons.length > 0) lines.push('');
  }
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

function captureOrUnknown(command, args, cwd) {
  try {
    return execFileSync(command, args, { cwd, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

function readPackage(root, name) {
  try {
    return JSON.parse(readFileSync(join(root, 'node_modules', name, 'package.json'), 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * The `package.json` of the last package in `chain`, each link resolved from
 * the directory of the one before it the way Node walks `node_modules` upward,
 * never above `root`. A nested copy therefore wins over a hoisted one: the
 * checkout's own `node_modules/@babel/core` is Jest's 7.x, not the
 * instrumenter's. Undefined when any link is missing.
 */
export function readResolvedPackage(root, chain) {
  let from = root;
  let pkg;
  for (const name of chain) {
    let dir = from;
    let found;
    for (;;) {
      if (basename(dir) !== 'node_modules') {
        const candidate = readPackage(dir, name);
        if (candidate) {
          found = { dir: join(dir, 'node_modules', name), pkg: candidate };
          break;
        }
      }
      const parent = dirname(dir);
      if (dir === root || parent === dir) break;
      dir = parent;
    }
    if (!found) return undefined;
    from = found.dir;
    pkg = found.pkg;
  }
  return pkg;
}

/**
 * The console the driver reports through, watched for the write failure that
 * means nobody is reading any more. `main` installs the watch before anything is
 * written, so the driver survives losing it and still writes its artifacts and
 * its summary; importing this module for its pure helpers touches no stream.
 */
let consoleState = { lost: null };
/**
 * Every message this driver prints. A stream already torn down throws on write
 * rather than emitting, and a message is never worth ending the run over — the
 * loss is recorded in `consoleState` and reported in `summary.json` instead.
 */
function say(text, stream = process.stdout) {
  try {
    stream.write(text);
  } catch (error) {
    consoleState.lost ??= error?.code ?? 'EPIPE';
  }
}

/**
 * Start this same run detached and return the state written for `--report`.
 *
 * Two things make the detached copy outlive the caller. `detached` puts it in a
 * new session, so the SIGTERM a command wrapper sends its own process group on
 * timeout never reaches it; and its output goes to a file rather than to an
 * inherited pipe, so there is no pipe left to break when the caller stops
 * reading. `unref` is what lets this process exit while it keeps running.
 *
 * `runId` is generated by the caller, before it takes the lock, because the lock
 * this start holds is taken on behalf of the copy it is about to spawn: that
 * copy recognizes the lock as its own by this id, whatever order the two
 * processes reach it in.
 *
 * The copy is not let go until the handoff has succeeded. Until `unref`, this
 * process still tracks it, and every failure between the spawn and the end of
 * the handoff — an asynchronous spawn error, a state file that cannot be
 * written, a lock rename that fails — stops the copy and waits for it to exit
 * before the error propagates. Otherwise the caller would be told the start
 * failed while a detached run went on without it: adopting the lock by its run
 * id, and invisible to a `--report` that finds no state file.
 */
async function startBackgroundRun({ root, options, reportDir, scope, budgetMs, runId, lock }) {
  const logPath = join(reportDir, RUN_LOG);
  const statePath = join(reportDir, RUN_STATE);
  // The previous start's state goes first and the new one is written only after
  // the spawn succeeds, so a spawn that fails leaves no state file claiming a
  // run exists — which `--report` would otherwise read as a run that was lost.
  rmSync(statePath, { force: true });
  const args = backgroundArgs(options);
  const fd = openSync(logPath, 'w');
  let child;
  try {
    child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...args], {
      cwd: root,
      // On every platform: on Windows `detached` is what takes the copy out of
      // the initiating console, so closing that console or a wrapper killing its
      // tree does not take the run with it. `windowsHide` keeps the console
      // Windows gives a detached process from opening a window.
      detached: true,
      windowsHide: true,
      stdio: ['ignore', fd, fd],
      env: { ...process.env, [RUN_ID_ENV]: runId },
    });
  } finally {
    // The child holds its own duplicate of the descriptor.
    closeSync(fd);
  }
  // A spawn failure (EAGAIN, ENOMEM, …) arrives as an `error` event, not a
  // throw; left unhandled it would crash this process after it had already
  // reported a start. Nothing was created, so there is nothing to reap.
  await new Promise((resolveSpawn, rejectSpawn) => {
    child.once('spawn', resolveSpawn);
    child.once('error', rejectSpawn);
  });
  // An error after the spawn (a failed signal while reaping, say) must not be
  // an unhandled event either; the failure it belongs to is reported below.
  child.on('error', () => {});
  let state;
  try {
    const startedAtMs = Date.now();
    // Taken here, while the copy is certainly alive, because it is what lets every
    // later reader tell that copy from whatever the host may put on its pid once it
    // is gone — see `processStartedAt`. It goes into both records that name the
    // copy: the state a `--report` reads, and the lock handed over below.
    const pidStart = processStartedAt(child.pid);
    state = backgroundRunState({ options, scope, runId, pid: child.pid, pidStart, startedAtMs, budgetMs });
    // The copy writes this same record itself once it holds the lock (see
    // `recoverRunState`), so a start killed before reaching this line still
    // leaves a run `--report` can read. Both writes describe the same process
    // under the same id, so whichever lands last is equally correct.
    replaceLockRecord(statePath, state);
    // Hand the lock to the detached copy before this process exits. From here on
    // it must name the process that is actually running: this one is about to be
    // gone, and a lock naming a dead pid is one the next caller clears and starts
    // a second run on top of. `releaseRunLock` then sees a pid that is not this
    // one and leaves it alone.
    patchOwnRunLock(lock, { pid: child.pid, pidStart, startedAt: state.startedAt, startedAtMs });
  } catch (error) {
    await reapStartedChild(child);
    // A state file written before the lock handoff failed names a run that no
    // longer exists. The lock still names this process when the handoff did not
    // complete, so the `exit` handler releases it.
    rmSync(statePath, { force: true });
    throw error;
  }
  child.unref();
  return state;
}

/**
 * The `run-state.json` record naming one detached run: what `--report` reads to
 * find it, judge its liveness and bound its budget. Built in one place because
 * two processes write it — the start, and the detached copy itself.
 */
export function backgroundRunState({ options, scope, runId, pid, pidStart, startedAtMs, budgetMs }) {
  return {
    mode: options.mode,
    label: scope.label,
    runId,
    pid,
    pidStart,
    startedAt: new Date(startedAtMs).toISOString(),
    startedAtMs,
    budgetMs,
    log: `${options.out}/${scope.label}/${RUN_LOG}`,
    args: backgroundArgs(options),
  };
}

/**
 * The detached copy's own guarantee that it is reportable.
 *
 * The start writes `run-state.json` only after the spawn, so a start killed by
 * SIGTERM/SIGKILL in between leaves a copy that survives (it is in its own
 * session), recognizes the lock by its run id, adopts it and completes — with
 * no state file, which `--report` reads as "no run here" and so ignores even the
 * summary that copy writes. Called by the copy once it holds the lock, this
 * writes the record when the directory has none for this run id, and leaves the
 * start's record alone when it already landed. Returns true when it wrote.
 *
 * Only this run's id is checked, never the file's age or pid: the start removed
 * any previous record before spawning, and holding the lock means no other run
 * can be writing one, so a record with a different id is a leftover to replace.
 */
export function recoverRunState(statePath, state, { read = readJsonOrNull, write = replaceLockRecord } = {}) {
  if (read(statePath)?.runId === state.runId) return false;
  write(statePath, state);
  return true;
}

/** How long a copy stopped after a failed handoff gets to exit before SIGKILL. */
const REAP_GRACE_MS = 5_000;

/**
 * Stop a detached copy whose start failed, and wait until it has exited.
 *
 * SIGTERM first, to its whole group (`detached` made it the leader of one), so
 * that a copy which already reached its own Stryker run stops that group and
 * releases what it holds; SIGKILL if it has not exited within `REAP_GRACE_MS`.
 * Windows has no groups, so its tree is ended with `taskkill /T /F` instead.
 */
async function reapStartedChild(child) {
  const running = () => child.exitCode === null && child.signalCode === null;
  if (!running()) return;
  const exited = new Promise((resolveExit) => child.once('exit', resolveExit));
  const signal = (name) => {
    if (!running()) return;
    try {
      if (process.platform === 'win32') execFileSync('taskkill', windowsTreeKillArgs(child.pid), { stdio: 'ignore' });
      else process.kill(-child.pid, name);
    } catch {
      try {
        child.kill(name);
      } catch {
        // Already gone.
      }
    }
  };
  signal('SIGTERM');
  let timer;
  const graceOver = new Promise((resolveGrace) => {
    timer = setTimeout(resolveGrace, REAP_GRACE_MS);
  });
  await Promise.race([exited, graceOver]);
  clearTimeout(timer);
  if (running()) {
    signal('SIGKILL');
    await exited;
  }
}

/**
 * Take the one lock that serializes mutation runs on this host, by exclusive
 * create: `wx` fails when the file already exists, and the check and the create
 * are one operation, so two starts racing here cannot both win.
 *
 * `lockDir` is fixed — see `RUN_LOCK_DIR`. It is deliberately not derived from
 * `--out`: the lock is what serializes runs in this checkout, and a caller must
 * not be able to pick a different one by naming a different output directory.
 *
 * Returns `{ held: true }` when this process owns the checkout, and otherwise
 * the holder that refused it (`holder: null` when the lock says nothing
 * readable) with the `liveness` that refused it. A lock left by a run that is
 * entirely gone — driver and Stryker group both — is cleared and the create
 * retried: releasing on exit covers every ending except a kill, and a kill must
 * not wedge the harness permanently.
 */
function acquireRunLock(lockDir, record, { now = Date.now() } = {}) {
  mkdirSync(lockDir, { recursive: true });
  const path = join(lockDir, RUN_LOCK);
  const self = { pid: record.pid, runId: record.runId };
  let holder = null;
  let liveness = null;
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    try {
      const fd = openSync(path, 'wx');
      try {
        writeFileSync(fd, `${JSON.stringify(record, null, 2)}\n`);
      } finally {
        closeSync(fd);
      }
      return { path, held: true, holder: null };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    holder = readJsonOrNull(path);
    // Asked once per pass, about the whole run: the driver, and the Stryker
    // process group the driver recorded before it started it.
    liveness = lockOwnerAlive(holder);
    if (holder === null) {
      // A lock with no readable record: either one being written right now, or
      // one whose start died between the create and the write. Only age tells
      // them apart, and only the second is safe to take.
      const mtimeMs = mtimeMsOrNull(path) ?? now;
      if (now - mtimeMs < LOCK_WRITE_GRACE_MS) return { path, held: false, holder: null, liveness: null };
    } else if (lockBlocks(holder, { ...self, alive: liveness !== null, liveness })) {
      // Including every record whose driver is gone while the Stryker group it
      // recorded runs on: that one is neither adopted below nor cleared at the
      // foot of the loop, however much it resembles this process. See
      // `lockBlocks`.
      return { path, held: false, holder, liveness };
    } else if (isSelfRun(holder, self)) {
      // The detached copy meeting the lock its own start took for it. Adopt it,
      // and restate it with this process's own pid so the next caller checks
      // liveness against the process that is actually running.
      //
      // Adoption goes through the same mutex as clearing, and for the same
      // reason. The start that took this lock may have died between the spawn
      // and the hand-over, leaving a record naming a dead pid — which another
      // caller is then entitled to judge abandoned and remove. Writing here
      // without the mutex lets that removal land between the clearer's re-read
      // and its `rmSync`, deleting the adopted, LIVE lock and putting two
      // Stryker runs on one `<out>` and one temp directory. Holding it makes the
      // two orderings the only two: adopt-then-refuse, or clear-then-recreate.
      if (adoptLockInstance(path, holder, record, { now })) return { path, held: true, holder: null };
      // Somebody else is inside the mutex, or the record at the path is no
      // longer the one just read. Neither is decided here: go round and let the
      // exclusive create settle it, as every other path through this loop does.
      continue;
    }
    // Nothing of the run is left — neither the driver nor the Stryker group it
    // recorded — so this is an abandoned lock. Clear THAT instance, never
    // whatever happens to be at the path by the time the remove runs, and race
    // for the create again rather than trusting this read: the create is the
    // decision. A caller that does not get to do the clearing simply retries;
    // the lock it then meets is the clearer's live one, and being refused by it
    // is the correct answer.
    clearAbandonedLock(path, holder, { now });
  }
  // Every attempt was beaten to the create by another caller: somebody else owns
  // it, which is the same answer as being refused by a live holder.
  return { path, held: false, holder, liveness };
}

/**
 * Is this the same lock instance that was read a moment ago, rather than a new
 * one written at the same path since? A lock record is stamped by the run that
 * wrote it, so the three fields that identify the run identify the instance:
 * a replacement always carries a different `startedAtMs`, and usually a
 * different pid and run id too.
 */
export function sameLockInstance(a, b) {
  if (!a || !b) return false;
  return a.pid === b.pid && (a.runId ?? null) === (b.runId ?? null) && (a.startedAtMs ?? null) === (b.startedAtMs ?? null);
}

/**
 * Remove the abandoned lock instance `observed` — and nothing else.
 *
 * Returns true when this call removed that instance. False means it did not,
 * either because another caller is clearing the same lock right now or because
 * the file at the path is no longer the one that was judged abandoned; the
 * caller retries the exclusive create either way, which is what decides
 * ownership. `observed` is null for a lock whose record could not be read: its
 * identity is "still unreadable, still older than the write grace", which is
 * re-established here rather than trusted from the earlier read.
 *
 * Exported for the tests: this is the stale-lock recovery itself, and it is
 * only meaningful against a real directory.
 */
export function clearAbandonedLock(path, observed, { now = Date.now() } = {}) {
  return withLockMutex(
    path,
    () => {
      const current = readJsonOrNull(path);
      if (observed === null) {
        const mtimeMs = mtimeMsOrNull(path);
        if (current !== null || mtimeMs === null || now - mtimeMs < LOCK_WRITE_GRACE_MS) return false;
      } else if (!sameLockInstance(current, observed)) {
        return false;
      }
      rmSync(path, { force: true });
      return true;
    },
    { now },
  );
}

/**
 * Restate the lock instance `observed` in this process's name — and only that
 * instance.
 *
 * This is the detached copy taking over the lock its own `--background` start
 * created for it. The write is not a new lock: the record at the path must
 * still be the very one just read, because between the read and this call the
 * start's pid may have died and another caller may already be removing it as
 * abandoned. Sharing `LOCK_STEAL` with `clearAbandonedLock` is what makes those
 * two mutually exclusive — see the comment on the constant. Returns false when
 * the adoption did not happen; the caller retries the exclusive create, which
 * is what decides ownership.
 *
 * Exported for the tests, alongside the clearing it is serialized against.
 */
export function adoptLockInstance(path, observed, record, { now = Date.now() } = {}) {
  return withLockMutex(
    path,
    () => {
      const current = readJsonOrNull(path);
      if (!sameLockInstance(current, observed)) return false;
      replaceLockRecord(path, { ...current, ...record });
      return true;
    },
    { now },
  );
}

/**
 * Run `fn` holding `LOCK_STEAL`, the one mutex that serializes every write to an
 * existing lock file. Returns false without running `fn` when another caller
 * holds it — a mutex that has been held past `LOCK_STEAL_STALE_MS` belongs to a
 * process killed inside it and is reclaimed on the way out, so a kill costs one
 * pass rather than wedging the harness. Released on every ending, including a
 * throw.
 *
 * The mutex carries a stamp naming the instance that created it. Neither the
 * reclaim nor the release may remove a file by path alone: both go through
 * `takeFileInstance`, which removes only the instance it was given.
 */
function withLockMutex(path, fn, { now = Date.now() } = {}) {
  const stealPath = join(dirname(path), LOCK_STEAL);
  const stamp = { pid: process.pid, token: randomUUID(), takenAtMs: now };
  let fd;
  try {
    fd = openSync(stealPath, 'wx');
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    reclaimStaleMutex(stealPath, readFileInstance(stealPath), { now });
    return false;
  }
  try {
    writeFileSync(fd, `${JSON.stringify(stamp)}\n`);
  } catch (error) {
    // Brand new and unstamped: no other caller can have judged it stale yet, so
    // removing it by path is safe here and leaving it would wedge the harness
    // for a whole `LOCK_STEAL_STALE_MS`.
    rmSync(stealPath, { force: true });
    throw error;
  } finally {
    closeSync(fd);
  }
  try {
    return fn();
  } finally {
    // Only this instance. A process suspended past `LOCK_STEAL_STALE_MS` has had
    // its mutex reclaimed, and the file at the path is then the reclaimer's.
    takeFileInstance(stealPath, (record) => sameMutexInstance(record, stamp));
  }
}

/**
 * The record and mtime of one file, read together, or null when it is not there.
 * This pair IS the identity of a mutex instance: a stamped one is told apart by
 * its token, and one whose stamp has not been written yet only by its age.
 */
function readFileInstance(path) {
  const mtimeMs = mtimeMsOrNull(path);
  if (mtimeMs === null) return null;
  return { record: readJsonOrNull(path), mtimeMs };
}

/**
 * Is this the same mutex instance? A stamped mutex is identified by its token.
 * A mutex with no readable stamp is one created microseconds ago whose stamp is
 * still being written, or one whose creator was killed in between; those are
 * told apart by age, never by content, so "no stamp" matches only "no stamp" and
 * the caller must check the age itself.
 */
export function sameMutexInstance(a, b) {
  if (!a || !b) return !a && !b;
  return typeof a.token === 'string' && a.token === b.token;
}

/**
 * Reclaim the mutex instance `observed`, which was found held past
 * `LOCK_STEAL_STALE_MS` — and only that instance.
 *
 * An unconditional `rmSync` here would reintroduce, one level down, the very
 * race the mutex exists to prevent: two callers can judge the same mutex stale,
 * and once the first has removed it and some operation has created a live one in
 * its place, the second's remove deletes THAT. Both callers then run their
 * critical section at once — an adoption and a clearing on one lock file, or two
 * Stryker runs over one `<out>` and one sandbox directory.
 *
 * `takeFileInstance` is what closes it: the rename is the atomic step, so of any
 * number of callers racing here exactly one moves a given file, and the stamp
 * proves the file it moved is the one it judged stale.
 *
 * Returns true when this call reclaimed it. The caller retries the exclusive
 * create either way; that create, not this, is what grants the mutex.
 *
 * Exported for the tests: this is the mutex's own stale recovery, and it is only
 * meaningful against a real directory.
 */
export function reclaimStaleMutex(stealPath, observed, { now = Date.now() } = {}) {
  if (!observed || now - observed.mtimeMs < LOCK_STEAL_STALE_MS) return false;
  return takeFileInstance(
    stealPath,
    (record, mtimeMs) => now - mtimeMs >= LOCK_STEAL_STALE_MS && sameMutexInstance(record, observed.record),
  );
}

/**
 * Remove the file at `path`, but only while it is still the instance `accepts`
 * recognizes.
 *
 * `rmSync` cannot express that: reading the file and removing it are two calls,
 * and anything that replaces it in between is removed instead. `renameSync` can.
 * It is atomic, so of N callers racing here exactly one moves a given file and
 * the rest get ENOENT; and once the file is moved to a private name, what it
 * contains can be checked without anything else being able to touch it.
 *
 * A file that turns out NOT to be the wanted instance is put back with
 * `linkSync`, which refuses to overwrite: whatever was created at `path` in the
 * meantime is newer and wins, and the one moved aside is dropped rather than
 * clobbering it.
 *
 * `accepts` receives the moved file's record and mtime, so an instance with no
 * readable record — one whose stamp was never written — can still be recognized
 * by its age, and recognized from the file itself rather than an earlier read.
 */
function takeFileInstance(path, accepts) {
  const away = `${path}.taken.${process.pid}.${randomUUID()}`;
  try {
    renameSync(path, away);
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  let wanted = false;
  try {
    wanted = accepts(readJsonOrNull(away), mtimeMsOrNull(away) ?? 0);
  } catch (error) {
    restoreFileInstance(away, path);
    throw error;
  }
  if (!wanted) {
    restoreFileInstance(away, path);
    return false;
  }
  rmSync(away, { force: true });
  return true;
}

/** Put a file moved by `takeFileInstance` back, unless something newer holds the path. */
function restoreFileInstance(away, path) {
  try {
    linkSync(away, path);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  rmSync(away, { force: true });
}

/**
 * Update the lock this process holds — to point it at the detached copy a
 * `--background` start spawned (see `startBackgroundRun`), or to record the
 * Stryker process group the run has just started (see `recordStrykerGroup`).
 *
 * Inside `LOCK_STEAL`, like every other write to an existing lock. A live owner
 * is never judged abandoned, so no clearer races this; the detached copy's
 * adoption does. Outside the mutex a start could read its own record, lose the
 * processor while the copy adopts it and records its Stryker group, and then
 * rename its stale copy over the lock — erasing the group, so that once the copy
 * is killed the lock names nothing alive and a second run is admitted while
 * Stryker keeps going. Holding the mutex makes the read and the replace one
 * step: either the start hands over first and the copy then adopts the updated
 * record, or the copy has adopted and the start finds a pid that is not its own.
 *
 * That pid check is the instance check. It is what keeps a start from writing
 * over the lock it has already handed to its detached copy. Returns true when
 * this call wrote the patch.
 *
 * Exported for the tests, alongside the adoption it is serialized against.
 */
export function patchOwnRunLock(lock, patch) {
  if (!lock?.held) return false;
  // A contended mutex is normally held for one read and one rename; a stale one
  // (its holder killed inside it) is reclaimed by `withLockMutex` itself once it
  // is `LOCK_STEAL_STALE_MS` old. Waiting that long is the bound; past it
  // something is wrong, and the caller's failure path is the answer.
  const deadline = Date.now() + LOCK_STEAL_STALE_MS + LOCK_PATCH_RETRY_MS * 10;
  for (;;) {
    let patched = false;
    const entered = withLockMutex(lock.path, () => {
      const holder = readJsonOrNull(lock.path);
      if (!holder || holder.pid !== process.pid) return true;
      replaceLockRecord(lock.path, { ...holder, ...patch });
      patched = true;
      return true;
    });
    if (entered) return patched;
    if (Date.now() >= deadline) throw new Error(`could not update ${lock.path}: its mutex stayed held`);
    sleepSync(LOCK_PATCH_RETRY_MS);
  }
}

/** Pause between attempts to enter a contended lock mutex from `patchOwnRunLock`. */
const LOCK_PATCH_RETRY_MS = 25;

/** Block this thread for `ms` — the lock paths are synchronous by design. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Replace an existing lock record atomically: write a sibling file, then rename
 * it over the lock.
 *
 * An in-place write truncates first, so a SIGKILL or OOM kill between the
 * truncate and the write leaves an empty or partial record — which
 * `acquireRunLock` treats as abandoned once `LOCK_WRITE_GRACE_MS` has passed,
 * admitting a second run while the Stryker group this record was naming keeps
 * going. A rename is all-or-nothing: whatever kills the writer, the path holds
 * either the old readable record or the new one. A killed writer can leave the
 * sibling behind; it sits under the ignored `<out>` and holds no lock.
 *
 * Exported for the tests.
 */
export function replaceLockRecord(path, record) {
  const staging = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(staging, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' });
    renameSync(staging, path);
  } catch (error) {
    rmSync(staging, { force: true });
    throw error;
  }
}

/**
 * Record, in this run's own lock, the Stryker process group it is about to wait
 * on — and clear it again once that group is gone.
 *
 * This is what makes the lock survive the death of the process holding it. The
 * driver starts Stryker detached, in its own group; killed with SIGTERM or an
 * unhandled error it stops that group on the way out, but SIGKILL and an OOM
 * kill leave it running with no chance to release anything. Without the group in
 * the record, the next invocation sees a lock naming a dead driver, judges it
 * abandoned, clears it, and starts a second run into the `stryker-tmp` the
 * surviving group is still using. With it, the lock keeps refusing until the
 * last of the run is actually gone.
 *
 * Written before the run and cleared after it, never left to linger: a pid the
 * host has since recycled onto an unrelated process would refuse every later
 * run. Clearing is skipped only when `runTimed` reports the group outlived its
 * own SIGKILL — the one case where the pid still names this run.
 */
function recordStrykerGroup(lock, strykerPid, { group }) {
  // Stamped while the leader is certainly alive — this runs at the moment the
  // group is created — so a later reader can tell the recorded group from a
  // stranger's that has since been given its number. See `strykerGroupAlive`.
  patchOwnRunLock(lock, { strykerPid, strykerPidStart: strykerPid === null ? null : processStartedAt(strykerPid), strykerGroup: group });
}

/**
 * Record, in this run's own lock, the pids `runTimed` found still running after
 * its kill gave up (Windows only — elsewhere the group id already names them).
 *
 * Without them a Windows record names only the leader, which `taskkill` usually
 * does reach; releasing the lock on that leader's death would admit a second run
 * beside the worker that survived, in the same sandbox. Each pid is stamped now,
 * while it is known to be this run's, so a later reader is not held by a
 * stranger that inherits the number. See `strykerGroupAlive`.
 */
function recordStrykerSurvivors(lock, pids) {
  if (!Array.isArray(pids) || pids.length === 0) return;
  patchOwnRunLock(lock, { strykerSurvivors: pids.map((pid) => ({ pid, pidStart: processStartedAt(pid) })) });
}

/**
 * Give up the lock — but only while it still names this process, and only once
 * nothing of the run is left.
 *
 * A `--background` start has already handed its lock to the copy it spawned, and
 * removing that one on the way out would leave the detached run unprotected. A
 * Stryker group that outlived even SIGKILL is the same situation from the other
 * end: the driver is done, but that group is still on the host and in the
 * sandbox directory, so the lock stays. It is not left for good — the next
 * invocation clears it as abandoned as soon as the group is gone.
 */
function releaseRunLock(lockPath) {
  const holder = readJsonOrNull(lockPath);
  if (!holder || holder.pid !== process.pid) return;
  if (strykerGroupAlive(holder)) return;
  rmSync(lockPath, { force: true });
}

/** A JSON file, or null when it is absent, unreadable or half-written. */
function readJsonOrNull(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * A file's modification time in whole milliseconds, or null when it cannot be
 * read.
 *
 * Floored, and that is the point. Every age in this harness is `now - mtimeMs`
 * measured against a `Date.now()`, which is a whole number of milliseconds,
 * while a filesystem timestamp carries a sub-millisecond fraction. Compared
 * unfloored, a file written at `T` reads as younger than `now - T` by that
 * fraction, so an age bound these comparisons mean to include — "at the bound
 * is stale" — is missed by less than a millisecond, and a lock or a clearing
 * mutex left by a killed process stays uncleanable for one tick longer than the
 * bound it is judged against.
 */
function mtimeMsOrNull(path) {
  try {
    return Math.floor(statSync(path).mtimeMs);
  } catch {
    return null;
  }
}

/**
 * This dry run's own numbers, or an explicit statement that it did not record any.
 *
 * Only a detached run may read `run.log`, and the reason is the misreading this
 * harness exists to prevent. A `--background` start truncates that file and then
 * spawns the run with its stdout pointing at it, so for the detached copy — the
 * one carrying `runId` — the log is definitionally its own output and nothing
 * else's. A foreground run wrote to the caller's console instead, and any
 * `run.log` sitting in the directory belongs to some earlier background run;
 * parsing it would publish another invocation's mutant count as this run's.
 */
function readDryRunFacts(reportDir, options, runId) {
  // No `cost` at all rather than one whose basis blames Stryker: nothing was read
  // here, so there is no run to make a statement about.
  const unavailable = (reason) => ({ facts: null, cost: null, source: null, reason });
  if (!runId) {
    return unavailable(
      "Stryker's output went to the caller's console rather than to a log this run owns, so no numbers were " +
        'recorded here — start the dry run with `npm run mutation:dry-run:start` to have them captured.',
    );
  }
  let log;
  try {
    log = readFileSync(join(reportDir, RUN_LOG), 'utf8');
  } catch {
    return unavailable("this run's own log could not be read, so no numbers were recorded here.");
  }
  const facts = parseDryRunFacts(log);
  return { facts, cost: dryRunCost(facts, options), source: RUN_LOG, reason: null };
}

/**
 * Publish a finished run's evidence: the Markdown first, the JSON last.
 *
 * The order is the contract, not a detail. `summary.json` is the only artifact
 * carrying this run's id, so it — and nothing else — is what a `--report` poll
 * reads as "this run has finished"; see `reportBackgroundRun`. Written before
 * the Markdown it promises to print, it lets a poll landing between the two
 * writes announce a finished run and then print no report at all, and a
 * Markdown write that then failed would leave the JSON behind answering
 * "finished, passed" for good from evidence nobody can read.
 *
 * So the JSON write is this run's completion marker, and nothing about the run
 * may be written after it.
 *
 * Exported for the tests: the ordering is the whole point, and only a caller
 * that can watch the writes can hold it to it.
 */
export function publishSummary(reportDir, result, { write = writeFileSync, render = renderSummary } = {}) {
  write(join(reportDir, 'summary.md'), render(result));
  write(join(reportDir, 'summary.json'), `${JSON.stringify(result, null, 2)}\n`);
}

/**
 * The state file in this report directory, or null if there is none to read —
 * no state file, or one left unreadable by a start that died mid-write: either
 * way no run is recorded here.
 */
function readRunState(reportDir) {
  return readJsonOrNull(join(reportDir, RUN_STATE));
}

/**
 * Read back a `--background` run. This path writes nothing and removes nothing:
 * clearing stale artifacts or pruning sandboxes here would destroy the very run
 * being reported on, and a report is asked for precisely while one may be live.
 */
function reportBackgroundRun({ mode, out, reportDir, scope, paths }) {
  // No state file means no run is recorded here, which `classifyBackgroundRun`
  // reports as `absent` rather than as a failed run.
  const state = readRunState(reportDir);
  // Read once, and only accept it as this run's evidence if it carries this
  // run's id; a summary from any other invocation is not a result here.
  let result = null;
  try {
    const parsed = JSON.parse(readFileSync(join(reportDir, 'summary.json'), 'utf8'));
    if (state && parsed?.environment?.runId === state.runId) result = parsed;
  } catch {
    // No summary yet, or one still being written: not this run's evidence.
  }
  const classification = classifyBackgroundRun({
    state,
    // About the recorded process, not about its number: a pid the host has
    // recycled onto something unrelated would otherwise keep this report saying
    // "still going" about a run that died long ago. See `processStartedAt`.
    alive: state ? recordedProcessAlive(state.pid, state.pidStart) : false,
    summaryPresent: result !== null,
    now: Date.now(),
  });
  // Both commands carry this invocation's `--out`, so following either of them
  // acts on the directory just read rather than on the default one.
  const rendered = renderBackgroundReport(classification, {
    label: scope.label,
    mode,
    reportDir: sanitizePath(reportDir, paths),
    startCommand: pilotCommand(mode, 'start', out),
    reportCommand: pilotCommand(mode, 'report', out),
  });
  say(`${rendered.line}\n`);

  if (classification.status === 'finished') {
    const summaryMd = join(reportDir, 'summary.md');
    // The run writes this file before the `summary.json` that made the run
    // `finished` above, so by here it exists — unless something outside this
    // harness removed it. Said out loud rather than passed over in silence: the
    // line already printed promised this report, and a reader must not be left
    // to conclude the run produced none. The JSON's own judgements are still
    // relayed below, so the exit code stays the run's own.
    if (existsSync(summaryMd)) say(`\n${readFileSync(summaryMd, 'utf8')}`);
    else say(`${sanitizePath(summaryMd, paths)} is missing, so only this run's own judgements can be relayed\n`, process.stderr);
    // The background run already made every judgement; this path only relays
    // it, so that `--report`'s exit code means what the foreground run's would.
    if (result.build && !result.build.ok) for (const reason of result.build.reasons) say(`sandbox build failed: ${reason}\n`, process.stderr);
    if (result.verdict && !result.verdict.ok) {
      for (const reason of result.verdict.reasons) say(`smoke check failed: ${reason}\n`, process.stderr);
      process.exitCode = 1;
      return;
    }
    if (result.run.state !== 'complete' || result.run.reason !== 'passed') {
      say(`stryker run ${result.run.state}: ${result.run.reason}\n`, process.stderr);
      process.exitCode = 1;
    }
    return;
  }

  // No summary to relay, so the log tail is the only thing that can say where
  // the run got to. Bounded and masked like everything else this harness prints.
  if (state) {
    let log = '';
    try {
      log = readFileSync(join(reportDir, RUN_LOG), 'utf8');
    } catch {
      log = '';
    }
    const block = renderLogTail(log, { logPath: state.log, paths });
    if (block !== '') say(block);
  }
  if (!rendered.ok) process.exitCode = 1;
}

/** Remove this harness's abandoned sandboxes. Returns the names removed. */
function pruneStaleSandboxes(tempDir, now) {
  let entries;
  try {
    entries = readdirSync(tempDir, { withFileTypes: true }).map((entry) => ({
      name: entry.name,
      directory: entry.isDirectory(),
      mtimeMs: Math.floor(statSync(join(tempDir, entry.name)).mtimeMs),
    }));
  } catch {
    // No temp directory yet, or one this process may not read: nothing to prune.
    return [];
  }
  const stale = staleSandboxes(entries, { now });
  for (const name of stale) rmSync(join(tempDir, name), { recursive: true, force: true });
  return stale;
}

async function main(argv) {
  consoleState = watchConsole([process.stdout, process.stderr]);
  const options = parseArgs(argv);
  const root = process.cwd();
  const parallelism = hostParallelism();
  const scope = scopeFor(options.mode);
  const out = resolve(root, options.out);
  const reportDir = join(out, scope.label);
  // `output` masks an absolute `--out` outside the checkout, home and temp
  // directories, whose sandboxes and logs every artifact here would otherwise
  // name verbatim; an in-tree `--out` is still reported relative to the root.
  // `outputReal` is the same directory with symlinks resolved: Stryker and Jest
  // run from a canonicalized sandbox working directory, so an `--out` that is a
  // symlink reaches their messages as its physical target.
  const paths = { root, home: homedir(), tmp: tmpdir(), output: out, outputReal: realpathOfNearest(out) };

  // Before the preflight, and before anything that writes: a report is a read of
  // a directory that may belong to a run happening right now.
  if (options.report) {
    reportBackgroundRun({ mode: options.mode, out: options.out, reportDir, scope, paths });
    return;
  }

  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  // Asked of Git itself, not of `.gitignore`'s text: only Git applies the
  // re-inclusion rules and the index, and this check is what stands between a
  // source-bearing raw report and a commit.
  // The options go in because they decide the incremental file's name: the check
  // must ask Git about the path THIS invocation would write, not a stand-in.
  // Built from the resolved destination, not the lexical `--out`: see `gitProbeOut`.
  // Every file this run's sandbox would hold is asked about inside it — as
  // Stryker enumerates them, untracked files included (see `sandboxInputFiles`).
  // Only without an answer from Stryker's reader do Git's tracked files or the
  // scoped files stand in — and with Stryker installed, `sandbox-inputs` then
  // fails, because that stand-in omits untracked copies.
  const enumerated = await sandboxInputFiles(pilotStrykerConfig(runSpecFor(options, scope)), { cwd: root });
  const sandboxFiles = enumerated ?? trackedFiles({ cwd: root }) ?? DEFAULT_SANDBOX_FILES;
  const reportPaths = rawReportPaths(gitProbeOut(options.out, root), {
    run: options,
    sandboxFiles,
    buildLayout: projectBuildLayout(root),
  });
  // An `--out` outside the checkout cannot be asked of Git (the whole batch
  // would die with 128) and cannot be committed here; only the in-tree paths —
  // the fixed run lock always among them — go to `git check-ignore`.
  const externalPaths = pathsOutsideWorktree(reportPaths, root);
  const ignoredPaths = gitIgnoredPaths(
    reportPaths.filter((path) => !externalPaths.includes(path)),
    { cwd: root },
  );
  const installed = Object.fromEntries(STRYKER_PACKAGES.map((name) => [name, readPackage(root, name)]).filter(([, pkg]) => pkg));
  const scopePaths = [...scope.mutate.map((entry) => entry.split(':')[0]), ...scope.testFiles];
  const missingPaths = scopePaths.filter((file) => !existsSync(join(root, file)));
  // No argument: check the exact paths the build command names, which are
  // derived from the configuration file's own location rather than from this cwd.
  const tscEntry = resolveTscEntry();
  const buildEntry = resolveBuildEntry();

  const findings = preflightFindings({
    manifest,
    reportPaths,
    ignoredPaths,
    externalPaths,
    installed,
    instrumenterParser: readResolvedPackage(root, INSTRUMENTER_PARSER_CHAIN),
    missingPaths,
    out: options.out,
    nodeVersion: process.version,
    compiler: { path: sanitizePath(tscEntry, paths), present: existsSync(tscEntry) },
    buildScript: { path: sanitizePath(buildEntry, paths), present: existsSync(buildEntry) },
    sandboxInputs: { enumerated: enumerated !== null, count: enumerated?.length ?? 0 },
  });
  for (const finding of findings) {
    const mark = finding.ok === true ? 'ok  ' : finding.ok === false ? 'FAIL' : 'note';
    say(`${mark} ${finding.check}: ${finding.detail}\n`);
  }
  const blocked = findings.filter((f) => f.ok === false);
  if (options.mode === 'preflight') {
    say(`\nscope: ${scope.mutate.join(', ')}\ntests: ${scope.testFiles.join(', ')}\n`);
    if (blocked.length > 0) process.exitCode = 1;
    return;
  }
  if (blocked.length > 0) {
    say(`\n${blocked.length} preflight check(s) failed; not running Stryker\n`, process.stderr);
    process.exitCode = 1;
    return;
  }

  // Everything below this point clears a report directory, prunes sandboxes and
  // then competes for the same host, so one run at a time owns this checkout —
  // not just its own mode's directory, and not just its own `--out`. A run
  // already going is reported and left alone, never signalled and never
  // clobbered: taking its directory would land its summary where a state file
  // names a different run, and two Stryker runs at once would double exactly the
  // load this slice is required to bound and let the later one prune a sandbox
  // the earlier one is working in.
  //
  // A `--background` start takes the lock for the copy it is about to spawn, so
  // that copy's id has to exist before the lock is written; the detached run
  // itself arrives with that id already in its environment.
  const runId = process.env[RUN_ID_ENV] ?? (options.background ? randomUUID() : null);
  const startedAtMs = Date.now();
  // The fixed lock directory, never `out`: see `RUN_LOCK_DIR`.
  const lock = acquireRunLock(join(root, RUN_LOCK_DIR), {
    mode: options.mode,
    label: scope.label,
    // Derived from the id rather than from `--background`, because the detached
    // copy carries the id but not the flag: a run with an id is one whose output
    // a refused caller can go and read with `:report`.
    background: runId !== null,
    runId,
    // Recorded so a refused caller is told to read this run's own output
    // directory. The lock itself never moves with `--out` (see `RUN_LOCK_DIR`).
    out: options.out,
    pid: process.pid,
    // The pid alone is a number the host reuses. Stamped with when this process
    // was created, the record names a process: a later invocation that finds
    // this lock can tell "the run is still going" from "something unrelated
    // inherited its pid", and only the first of those may refuse it. See
    // `lockOwnerAlive`.
    pidStart: processStartedAt(process.pid),
    startedAt: new Date(startedAtMs).toISOString(),
    startedAtMs,
  });
  if (!lock.held) {
    say(`\n${renderLockRefusal(lock.holder, { now: Date.now(), liveness: lock.liveness })}\n`, process.stderr);
    process.exitCode = 1;
    return;
  }
  // Released on every ending this process controls, including a thrown error.
  // A kill leaves the file behind, which the next acquisition clears once it can
  // see that nothing of the run is left — neither this process nor the Stryker
  // group it recorded. A lock is never allowed to outlive its run for good.
  process.on('exit', () => releaseRunLock(lock.path));

  // A sandbox is a whole copy of the checkout. Stryker removes its own
  // (`cleanTempDir`), but a run killed mid-flight never gets to, and the copies
  // accumulate under this harness's own directory. Holding the lock is what
  // makes this safe: no other run of this harness is in one right now. Only this
  // harness's sandboxes are ever considered, and only ones untouched long enough
  // that no run can still own them.
  const pruned = pruneStaleSandboxes(join(out, TEMP_DIR_NAME), Date.now());
  if (pruned.length > 0) say(`pruned ${pruned.length} abandoned sandbox(es) from a previous run\n`);

  mkdirSync(reportDir, { recursive: true });
  // Everything in this directory belongs to ONE run. Clearing it first is what
  // keeps a run that dies early from being summarized — or given a verdict —
  // from the previous run's report, which would read as a result this run never
  // produced. The directory is `.mutation/<label>/`, created by this script.
  for (const stale of STALE_ARTIFACTS) rmSync(join(reportDir, stale), { force: true });
  const specPath = join(reportDir, 'run-spec.json');
  const spec = runSpecFor(options, scope);
  writeFileSync(specPath, `${JSON.stringify(spec, null, 2)}\n`);

  // The detached copy of a `--background` start: it carries the run id but not
  // the flag. Holding the lock, it makes sure the run it is about to do is
  // recorded for `--report` even if its start died before writing the record.
  if (runId !== null && !options.background) {
    recoverRunState(
      join(reportDir, RUN_STATE),
      backgroundRunState({
        options,
        scope,
        runId,
        pid: process.pid,
        pidStart: processStartedAt(process.pid),
        startedAtMs,
        budgetMs: options.maxRuntimeMin * 60_000,
      }),
    );
  }

  // After the preflight, so a start that cannot possibly work fails here with
  // its reasons on the caller's console rather than in a log file nobody is
  // watching yet; and after the artifacts above are cleared, so that a summary
  // found later belongs to the run this start is about to begin.
  if (options.background) {
    const state = await startBackgroundRun({
      root,
      options,
      reportDir,
      scope,
      budgetMs: options.maxRuntimeMin * 60_000,
      runId,
      lock,
    });
    say(
      `\nstarted ${options.mode} detached — pid ${state.pid}, budget ${options.maxRuntimeMin} min, ` +
        `output in ${sanitizePath(state.log, paths)}\n` +
        // With the `--out` this run was started with: a `:report` without it reads
        // the default directory, where this run has written nothing.
        `read it with \`${pilotCommand(options.mode, 'report', options.out)}\`\n`,
    );
    return;
  }

  const core = installed['@stryker-mutator/core'];
  const strykerBin = join(root, 'node_modules', '@stryker-mutator/core', strykerBinFromManifest(core));
  // Recorded, not acted on: the run mutates a sandbox copy, so dirty work in the
  // checkout is never at risk — but a reader of the summary should know the tree
  // was not pristine. A `git` that could not be read says so rather than
  // reporting a clean tree.
  const status = captureOrUnknown('git', ['status', '--porcelain'], root);
  const environment = {
    startedAt: new Date().toISOString(),
    // Set only when a `--background` start spawned this process. It is what lets
    // a later `--report` prove the summary it reads came from the run it names,
    // rather than from whatever ran in this directory afterwards.
    runId: process.env[RUN_ID_ENV] ?? null,
    commit: captureOrUnknown('git', ['rev-parse', 'HEAD'], root),
    worktreeDirty: status === 'unknown' ? 'unknown' : status === '' ? 'clean' : 'dirty',
    node: process.version,
    stryker: core.version,
    jestRunner: installed['@stryker-mutator/jest-runner'].version,
    jest: readPackage(root, 'jest')?.version ?? 'unknown',
    concurrency: options.concurrency,
    parallelism,
    coverageAnalysis: options.coverageAnalysis,
    // Both change what a verdict means, so the published summary must carry
    // them: a mutant that exceeds its deadline — `timeoutFactor` × its tests'
    // dry-run time + `timeoutMs` + overhead — counts as detected, and an
    // incremental run reuses earlier verdicts rather than re-testing every mutant.
    timeoutMs: options.timeoutMs,
    timeoutFactor: DEFAULT_TIMEOUT_FACTOR,
    incremental: options.incremental,
    maxRuntimeMin: options.maxRuntimeMin,
    loadAtStart: loadavg().map((n) => n.toFixed(2)).join('/'),
  };

  say(`\nrunning stryker (${options.mode}) — budget ${options.maxRuntimeMin} min, concurrency ${options.concurrency}\n`);
  const runStartedAt = Date.now();
  // Only when the output is not a terminal, which is exactly when it is needed:
  // Stryker downgrades to its append-only progress reporter off a TTY and goes
  // quiet for minutes, and a pipe is the thing that can break underneath both of
  // us. On a TTY its live progress bar already shows liveness, a heartbeat would
  // mangle the redraw, and a terminal that goes away arrives as SIGHUP instead.
  const heartbeat = process.stdout.isTTY
    ? null
    : setInterval(() => say(heartbeatLine(options.mode, Date.now() - runStartedAt)), HEARTBEAT_MS);
  let timed;
  try {
    timed = await runTimed(process.execPath, [strykerBin, 'run', 'stryker.pilot.config.mjs'], {
      cwd: root,
      timeoutMs: options.maxRuntimeMin * 60_000,
      env: childEnv(process.env, specPath),
      // Synchronous, and before anything can await the run: from the moment this
      // group exists, a kill of this driver must not leave the next invocation
      // thinking the lock is free. See `recordStrykerGroup`.
      onGroup: (pid, { group }) => recordStrykerGroup(lock, pid, { group }),
    });
  } finally {
    // In a `finally`, because a lock write that fails inside `onGroup` makes this
    // reject — with the group already stopped — and an interval left running would
    // keep the process alive after the error was reported.
    if (heartbeat) clearInterval(heartbeat);
  }
  // `runTimed` checks the group on every leader exit — signalled or not — and
  // does not resolve until one it had to stop is gone, so unless it says the
  // group outlived SIGKILL there is nothing of this run left to name — and a pid
  // kept past that point could be recycled onto an unrelated process and refuse
  // every later run.
  if (!timed.groupSurvived) recordStrykerGroup(lock, null, { group: false });
  else recordStrykerSurvivors(lock, timed.survivingPids);
  // Ask the console directly before the classifier asks whether it is still
  // there: the last heartbeat may be up to `HEARTBEAT_MS` old, and a break that
  // only Stryker wrote into would otherwise go unrecorded — see `probeConsole`.
  // Waiting on it also gives an earlier failed write, which reaches the watcher
  // asynchronously, time to land.
  const probed = await probeConsole(process.stdout, `stryker (${options.mode}) ended after ${Math.round(timed.wallMs / 1000)} s\n`);
  consoleState.lost ??= probed;

  const reportPath = join(reportDir, 'mutation.json');
  const reportPresent = existsSync(reportPath);
  // A dry run activates no mutant, so it is not expected to leave a report; for
  // every other mode a missing report means the run did not get far enough to
  // say anything, which must never read as success.
  const run = {
    ...timed,
    consoleLost: consoleState.lost,
    ...classifyStrykerRun({
      ...timed,
      consoleLost: consoleState.lost,
      reportPresent: reportPresent || options.mode === 'dry-run',
    }),
  };
  const summary = reportPresent ? summarizeMutationReport(JSON.parse(readFileSync(reportPath, 'utf8')), paths) : null;
  // A dry run's evidence is text, not a report, so it is read back here from the
  // log this run itself wrote — see `readDryRunFacts` for why only a detached run
  // may do so.
  const dryRun = options.mode === 'dry-run' ? readDryRunFacts(reportDir, options, environment.runId) : null;
  const verdict = options.mode === 'smoke' ? smokeVerdict(run, summary ?? { total: 0, byStatus: {} }) : null;
  // Written by `scripts/mutation-build.mjs` inside the sandbox: the record that
  // each mutated source compiled into the `dist/` file the tests import.
  const buildPath = join(reportDir, 'build.json');
  const build = existsSync(buildPath) ? sanitizeBuildRecord(JSON.parse(readFileSync(buildPath, 'utf8')), paths) : null;

  const result = { mode: options.mode, scope, environment, build, run, dryRun, summary, verdict };
  // Markdown first, JSON last, because the JSON is what a `--report` reads as
  // "finished" — see `publishSummary`.
  publishSummary(reportDir, result);
  say(`\nwrote ${sanitizePath(reportDir, paths)}/summary.md and ${sanitizePath(reportDir, paths)}/summary.json\n`);

  // A failed sandbox build is the cause of every other symptom below it, so it
  // is stated first and by name rather than left inside Stryker's own log.
  if (build && !build.ok) for (const reason of build.reasons) say(`sandbox build failed: ${reason}\n`, process.stderr);
  if (verdict && !verdict.ok) {
    for (const reason of verdict.reasons) say(`smoke check failed: ${reason}\n`, process.stderr);
    process.exitCode = 1;
    return;
  }
  if (run.state !== 'complete' || run.reason !== 'passed') {
    say(`stryker run ${run.state}: ${run.reason}\n`, process.stderr);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    say(`${error.message}\n`, process.stderr);
    process.exitCode = 1;
  });
}
