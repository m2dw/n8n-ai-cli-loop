/**
 * copybara-export.mjs
 *
 * Reproducible, local-only wrapper around a pinned Copybara release for the
 * private-to-public SQUASH export prototype (issue #767). This script does
 * NOT talk to github.com/m2dw/n8n-ai-cli-loop and never pushes anywhere —
 * it only stages local temporary Git repositories (origin = a clone of the
 * private source-of-truth revision; destination = a **bare** repo, empty or
 * a bare clone of an existing local baseline repo, since `git.destination`
 * pushes into it over `file://` and a non-bare repo would reject that push)
 * and invokes the pinned `copybara_deploy.jar` against copybara/copy.bara.sky
 * to migrate between them, then checks out the pushed branch into a plain
 * working tree and runs scripts/copybara-validate.mjs against that checkout.
 *
 * It is intentionally NOT a Copybara reimplementation: every step that
 * changes file content is delegated to the real `java -jar` invocation.
 * This file only does argument/config plumbing, pin verification, and
 * local git staging — all things a human would otherwise type by hand.
 *
 * See docs/copybara-export-poc.md for the full reproducible command,
 * the pinning bootstrap procedure, and known limitations.
 *
 * Run: node scripts/copybara-export.mjs --source-repo <path> [options]
 */

import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { scanTree, displayMatch } from './copybara-validate.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
export const DEFAULT_CONFIG_TEMPLATE = join(REPO_ROOT, 'copybara', 'copy.bara.sky');
export const DEFAULT_PIN_PATH = join(REPO_ROOT, 'copybara', 'PIN.json');
export const MIN_JAVA_MAJOR_VERSION = 21;

// ---------------------------------------------------------------------------
// Command runner (dependency-injected; mirrors src/handlers/command-runner.ts)
// ---------------------------------------------------------------------------

/** @typedef {{ stdout: string, stderr: string, exitCode: number }} CommandRunResult */

/** Default runner: spawnSync, captures both streams on every exit code. */
export const defaultRunner = {
  run(cmd, args, opts = {}) {
    const result = spawnSync(cmd, args, {
      cwd: opts.cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: opts.timeout,
      maxBuffer: opts.maxBuffer ?? 32 * 1024 * 1024,
    });
    if (result.error) {
      return {
        stdout: result.stdout ?? '',
        stderr: (result.stderr ?? '') + String(result.error),
        exitCode: typeof result.status === 'number' ? result.status : 1,
      };
    }
    return {
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      exitCode: result.status ?? 1,
    };
  },
};

// ---------------------------------------------------------------------------
// Java gate
// ---------------------------------------------------------------------------

/**
 * Parse the major version number out of `java -version` output, e.g.
 *   openjdk version "21.0.3" 2024-04-16   -> 21
 *   java version "1.8.0_401"              -> 8   (legacy pre-JEP 223 scheme)
 * Returns null when no version string is found.
 */
export function parseJavaMajorVersion(output) {
  const m = /version\s+"(\d+)(?:\.(\d+))?/.exec(output);
  if (!m) return null;
  const first = Number(m[1]);
  if (first === 1 && m[2] !== undefined) return Number(m[2]); // 1.8.x -> 8
  return first;
}

/** Fail-closed check that a Java runtime meeting MIN_JAVA_MAJOR_VERSION is on PATH. */
export function checkJavaVersion(runner = defaultRunner, minMajor = MIN_JAVA_MAJOR_VERSION) {
  const result = runner.run('java', ['-version'], {});
  // `java -version` conventionally writes to stderr, but check both streams.
  const combined = `${result.stdout}\n${result.stderr}`;
  const major = parseJavaMajorVersion(combined);
  if (result.exitCode !== 0 || major === null) {
    return { ok: false, major: null, reason: `unable to determine Java version (exit ${result.exitCode})`, raw: combined };
  }
  if (major < minMajor) {
    return { ok: false, major, reason: `Java ${major} found, ${minMajor}+ required`, raw: combined };
  }
  return { ok: true, major, reason: null, raw: combined };
}

// ---------------------------------------------------------------------------
// Pin verification
// ---------------------------------------------------------------------------

/** SHA-256 of a local file's contents, hex-encoded. */
export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * Load and shape-validate copybara/PIN.json. Throws (fail closed) on a
 * missing file or malformed schema rather than falling back to "unpinned".
 */
export function loadPin(pinPath = DEFAULT_PIN_PATH) {
  const raw = JSON.parse(readFileSync(pinPath, 'utf8'));
  for (const field of ['release', 'jarSha256', 'javaMinVersion']) {
    if (!(field in raw)) throw new Error(`copybara pin file ${pinPath} is missing required field "${field}"`);
  }
  if (!Number.isInteger(raw.javaMinVersion) || raw.javaMinVersion < MIN_JAVA_MAJOR_VERSION) {
    throw new Error(
      `copybara pin file ${pinPath} has an invalid "javaMinVersion" (must be an integer >= ${MIN_JAVA_MAJOR_VERSION}): ${JSON.stringify(raw.javaMinVersion)}`
    );
  }
  return raw;
}

/**
 * Verify a local jar matches the pinned release before it is ever executed.
 * A placeholder/unpopulated pin (see copybara/PIN.json) fails closed rather
 * than silently trusting whatever jar is on disk — see docs/copybara-export-poc.md
 * for why this repo ships an unpopulated pin and how an operator populates it.
 */
export function verifyPin(pin, jarPath) {
  if (!pin.release || !pin.jarSha256) {
    return { ok: false, reason: 'copybara pin is not populated yet — run the pin bootstrap in docs/copybara-export-poc.md before exporting' };
  }
  if (!existsSync(jarPath)) {
    return { ok: false, reason: `pinned jar not found at ${jarPath}` };
  }
  const actual = sha256File(jarPath);
  if (actual !== pin.jarSha256) {
    return { ok: false, reason: `jar checksum mismatch: expected ${pin.jarSha256}, got ${actual}` };
  }
  return { ok: true, reason: null };
}

/**
 * Capture a trust-on-first-use pin from a jar the operator has already
 * downloaded and independently verified against the release page. This is
 * the ONLY supported way to populate copybara/PIN.json — the wrapper never
 * downloads or trusts a jar on its own.
 */
export function capturePin({ release, jarPath, javaMinVersion = MIN_JAVA_MAJOR_VERSION }) {
  return { release, jarSha256: sha256File(jarPath), javaMinVersion };
}

// ---------------------------------------------------------------------------
// Config templating
// ---------------------------------------------------------------------------

/**
 * Render copy.bara.sky by substituting __TOKEN__ placeholders. Throws if any
 * `__[A-Z_]+__`-shaped placeholder survives substitution, so a typo'd token
 * name fails the export instead of silently reaching Copybara.
 */
export function renderConfig(templatePath, tokens) {
  let text = readFileSync(templatePath, 'utf8');
  for (const [key, value] of Object.entries(tokens)) {
    text = text.split(`__${key}__`).join(value);
  }
  const leftover = text.match(/__[A-Z_]+__/g);
  if (leftover) {
    throw new Error(`copy.bara.sky template has unsubstituted placeholder(s): ${leftover.join(', ')}`);
  }
  return text;
}

// ---------------------------------------------------------------------------
// Local git staging (plain git plumbing only — no transform logic here)
// ---------------------------------------------------------------------------

export function runGit(runner, args, cwd) {
  const result = runner.run('git', args, { cwd });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} (cwd=${cwd}) failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

/** Resolve `ref` in `cwd`, or null if it does not exist (e.g. unborn branch). */
export function tryRevParse(runner, cwd, ref) {
  const result = runner.run('git', ['rev-parse', '--verify', ref], { cwd });
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

/**
 * A bare `resolve()` mangles remote URLs (`resolve('https://host/x.git')`
 * joins it onto process.cwd() as if it were a relative path fragment).
 * scripts/public-export.mjs passes real `https://`/`ssh://`/`git@host:`
 * remote URLs as sourceRepoPath/baselinePath instead of local checkout
 * paths — recognize that shape and pass it through unresolved, while local
 * paths (used throughout this file's own tests and the local-only PoC
 * command) keep going through resolve() as before.
 */
const REMOTE_URL_PATTERN = /^(?:[a-zA-Z][a-zA-Z0-9+.-]*:\/\/|[\w.-]+@[\w.-]+:)/;
export function resolveRepoLocation(value) {
  return REMOTE_URL_PATTERN.test(value) ? value : resolve(value);
}

/**
 * Clone `sourceRepoPath` at `rev` into `originDir` (a fresh local temp
 * repo) and resolve the exact revision exported — this is the value
 * recorded via Copybara's GitOrigin-RevId trailer, so it must be captured
 * up front for the caller to report.
 */
export function prepareOriginRepo({ sourceRepoPath, rev = 'HEAD', originDir }, runner = defaultRunner) {
  runGit(runner, ['clone', '--quiet', '--no-local', sourceRepoPath, originDir], REPO_ROOT);
  runGit(runner, ['checkout', '--quiet', rev], originDir);
  const resolvedRev = runGit(runner, ['rev-parse', 'HEAD'], originDir);
  return { dir: originDir, resolvedRev };
}

/**
 * Stage the destination repo as a **bare** repo — this is the actual
 * `git.destination` push target rendered into copy.bara.sky. Git's default
 * `receive.denyCurrentBranch` rejects a push that updates the branch
 * currently checked out in a non-bare repo, so the receive target must stay
 * bare; validation reads a separate checkout (see
 * `checkoutDestinationForValidation`) rather than this directory. When
 * `baselinePath` is given it is bare-cloned as-is — including its unrelated
 * public root history — to prove SQUASH can land on top of it without a
 * force-push. Otherwise a fresh empty bare repo is created.
 */
export function prepareDestinationRepo({ baselinePath, destDir, branch = 'main' }, runner = defaultRunner) {
  if (baselinePath) {
    runGit(runner, ['clone', '--quiet', '--no-local', '--bare', baselinePath, destDir], REPO_ROOT);
  } else {
    runGit(runner, ['init', '--quiet', '--bare', '-b', branch, destDir], REPO_ROOT);
  }
  return { dir: destDir };
}

/**
 * Clone the bare destination repo's branch into a normal working tree so
 * `scanTree` (a plain filesystem walk) can inspect the migrated file
 * content. This is a read-only clone taken *after* `migrate` has pushed,
 * never the push target itself.
 */
export function checkoutDestinationForValidation({ destDir, branch = 'main', checkoutDir }, runner = defaultRunner) {
  runGit(runner, ['clone', '--quiet', '--no-local', '--branch', branch, destDir, checkoutDir], REPO_ROOT);
  return { dir: checkoutDir };
}

/**
 * Undo a push that post-transform validation rejected. `migrate` already
 * pushed the unsafe commit straight into the (reusable) bare `destination`
 * repo before validation ran, so a failed validation must roll the branch
 * back there too — otherwise the unsafe commit stays live as the documented
 * input for the next run and for manual publication. The rejected commit is
 * kept reachable under `refs/quarantine/<branch>-<sha>` for forensics, and
 * the branch ref itself is restored to `preMigrateRev` (or deleted outright
 * when the branch was unborn before this run, i.e. a fresh empty bare repo).
 */
export function quarantineFailedPush({ destDir, branch = 'main', preMigrateRev = null }, runner = defaultRunner) {
  const branchRef = `refs/heads/${branch}`;
  const pushedRev = tryRevParse(runner, destDir, branchRef);
  if (pushedRev === null) return { quarantined: false, quarantineRef: null, pushedRev: null };

  const quarantineRef = `refs/quarantine/${branch}-${pushedRev}`;
  runGit(runner, ['update-ref', quarantineRef, pushedRev], destDir);
  if (preMigrateRev) {
    runGit(runner, ['update-ref', branchRef, preMigrateRev], destDir);
  } else {
    runGit(runner, ['update-ref', '-d', branchRef], destDir);
  }
  return { quarantined: true, quarantineRef, pushedRev };
}

// ---------------------------------------------------------------------------
// Migration invocation
// ---------------------------------------------------------------------------

export function buildMigrateArgs({ jarPath, configPath, workflowName, extraArgs = [] }) {
  return ['-jar', jarPath, 'migrate', configPath, workflowName, ...extraArgs];
}

/**
 * Verify that `rev` resolves to a commit reachable in the already-cloned
 * origin repo at `originDir`. Used to fail closed on a `--last-rev` (whether
 * operator-supplied or auto-derived by scripts/public-export.mjs from a
 * previously recorded export) that turns out to be stale, rather than
 * silently handing Copybara a value it will itself refuse to resolve deep
 * inside the jar invocation (issue #800).
 */
export function revResolvesInRepo(runner, originDir, rev) {
  return runner.run('git', ['cat-file', '-e', `${rev}^{commit}`], { cwd: originDir }).exitCode === 0;
}

/**
 * Verify `ancestorRev` is actually reachable from `rev` in the already-cloned
 * origin repo. `revResolvesInRepo` alone only proves the SHA exists
 * *somewhere* in the repo — after a force-push to a divergent private
 * history, a stale recorded revision can remain reachable via another
 * branch/tag while no longer being a real prior point in the exported
 * history, which would otherwise let a non-ancestral `--last-rev` slip past
 * the stale-baseline refusal (issue #800).
 */
export function revIsAncestor(runner, originDir, ancestorRev, rev) {
  return runner.run('git', ['merge-base', '--is-ancestor', ancestorRev, rev], { cwd: originDir }).exitCode === 0;
}

/**
 * Run one export: Java gate -> pin verification -> config render -> invoke
 * the pinned jar -> post-transform validation. Fails closed (throws or
 * returns ok:false) at every stage rather than proceeding on a soft error.
 *
 * `initHistory`/`lastRev` (issue #800) select the Copybara baseline
 * mechanism explicitly rather than ever letting Copybara fall back to
 * resolving a `GitOrigin-RevId` trailer off the destination baseline itself
 * — which is what produces the "Cannot resolve reference"/"Cannot find last
 * imported revision" failure when that trailer is missing or stale. Neither
 * flag is required here (the policy decision of when one is mandatory lives
 * in scripts/public-export.mjs, which knows about this tool's own dedicated
 * sync branch); this function only renders whichever one it is given into
 * the migrate invocation, and — for `lastRev` — verifies up front that the
 * revision actually resolves in the origin repo instead of deferring that
 * check to Copybara.
 */
export function runExport(opts, runner = defaultRunner) {
  const {
    rev = 'HEAD',
    destBranch = 'main',
    workflowName = 'private_to_public_squash',
    initHistory = false,
    lastRev = null,
  } = opts;

  if (initHistory && lastRev) {
    return { ok: false, stage: 'baseline', reason: '--init-history and --last-rev are mutually exclusive; choose one explicit baseline mechanism' };
  }

  // Every path below is either handed to `java`/`git` with a cwd other than
  // this process's own (workdir for java, REPO_ROOT for git), or embedded in
  // a `file://` URL — a relative value would then resolve against the wrong
  // directory (or produce a malformed URL) instead of the caller's cwd where
  // it was typed. Resolve against process.cwd() once, up front, since this
  // process never calls chdir().
  const sourceRepoPath = resolveRepoLocation(opts.sourceRepoPath);
  const workdir = resolve(opts.workdir ?? mkdtempSync(join(tmpdir(), 'copybara-poc-')));
  const baselinePath = opts.baselinePath ? resolveRepoLocation(opts.baselinePath) : null;
  const jarPath = resolve(opts.jarPath);
  const pinPath = resolve(opts.pinPath ?? DEFAULT_PIN_PATH);
  const configTemplate = resolve(opts.configTemplate ?? DEFAULT_CONFIG_TEMPLATE);

  // Load the pin before the Java gate: a populated pin can require a Java
  // version above MIN_JAVA_MAJOR_VERSION, and that requirement must be
  // enforced here rather than left to fail later inside the pinned jar.
  const pin = loadPin(pinPath);

  const java = checkJavaVersion(runner, pin.javaMinVersion);
  if (!java.ok) return { ok: false, stage: 'java', reason: java.reason };

  const pinCheck = verifyPin(pin, jarPath);
  if (!pinCheck.ok) return { ok: false, stage: 'pin', reason: pinCheck.reason };

  // The caller-supplied workdir (e.g. the documented `--workdir
  // /tmp/copybara-poc-1`) is not guaranteed to exist yet, unlike the
  // mkdtempSync default above which always creates it — create it here so
  // the subsequent `git clone ... <workdir>/origin` has a parent to clone
  // into.
  mkdirSync(workdir, { recursive: true });

  const originDir = join(workdir, 'origin');
  const destDir = join(workdir, 'destination');
  const destCheckoutDir = join(workdir, 'destination-checkout');
  const origin = prepareOriginRepo({ sourceRepoPath, rev, originDir }, runner);
  const destination = prepareDestinationRepo({ baselinePath, destDir, branch: destBranch }, runner);

  // Baseline decision (issue #800): render whichever explicit mechanism the
  // caller selected into the migrate invocation, verifying a `lastRev` up
  // front (now that origin is cloned) rather than letting Copybara discover
  // a stale value on its own. Neither flag is required at this layer — a
  // caller that passes neither gets ordinary migrate behavior, unchanged.
  let migrateExtraArgs = [];
  let baseline = null;
  if (initHistory) {
    migrateExtraArgs = ['--init-history'];
    baseline = { mode: 'init-history' };
  } else if (lastRev) {
    if (!revResolvesInRepo(runner, origin.dir, lastRev)) {
      return {
        ok: false,
        stage: 'baseline',
        reason: `--last-rev ${lastRev} does not resolve to a commit in the origin repository — this looks like a stale or incorrect baseline. Re-run with --init-history to treat the destination's current tip as the pre-Copybara baseline, or pass a --last-rev that exists in the private history. Do not retry with --force.`,
        sourceRev: origin.resolvedRev,
        baseline: { mode: 'last-rev', lastRev, resolved: false },
      };
    }
    if (!revIsAncestor(runner, origin.dir, lastRev, origin.resolvedRev)) {
      return {
        ok: false,
        stage: 'baseline',
        reason: `--last-rev ${lastRev} exists but is not an ancestor of the resolved source revision ${origin.resolvedRev} — this looks like a stale baseline left over from a rewritten/force-pushed private history. Re-run with --init-history to treat the destination's current tip as the pre-Copybara baseline, or pass a --last-rev that is actually an ancestor of the current private history. Do not retry with --force.`,
        sourceRev: origin.resolvedRev,
        baseline: { mode: 'last-rev', lastRev, resolved: false },
      };
    }
    migrateExtraArgs = ['--last-rev', lastRev];
    baseline = { mode: 'last-rev', lastRev, resolved: true };
  }

  const configPath = join(workdir, 'copy.bara.sky');
  const rendered = renderConfig(configTemplate, {
    COPYBARA_ORIGIN_URL: `file://${origin.dir}`,
    COPYBARA_ORIGIN_REF: origin.resolvedRev,
    COPYBARA_DEST_URL: `file://${destination.dir}`,
    COPYBARA_DEST_REF: destBranch,
  });
  writeFileSync(configPath, rendered);

  // Captured before `migrate` runs so a rejected push can be rolled back to
  // exactly this state — null means the branch was unborn (fresh empty bare
  // destination), in which case quarantine deletes the ref outright instead.
  const preMigrateRev = tryRevParse(runner, destination.dir, `refs/heads/${destBranch}`);

  const migrateArgs = buildMigrateArgs({ jarPath, configPath, workflowName, extraArgs: migrateExtraArgs });
  const migrateResult = runner.run('java', migrateArgs, { cwd: workdir });
  if (migrateResult.exitCode !== 0) {
    // Copybara can push the destination commit and still exit nonzero on a
    // later error (e.g. a post-push hook/step failure) — always roll back
    // whatever landed on the branch rather than only rolling back on the
    // validation-failure path below, or a bare push could survive a failed
    // export and later be reused via --dest-baseline.
    const quarantine = quarantineFailedPush({ destDir: destination.dir, branch: destBranch, preMigrateRev }, runner);
    return {
      ok: false,
      stage: 'migrate',
      reason: migrateResult.stderr || migrateResult.stdout,
      sourceRev: origin.resolvedRev,
      quarantine,
    };
  }

  // The post-migrate clone and scanTree run after Copybara has already
  // pushed, so a failure here (I/O, disk space, etc.) must be treated the
  // same as a failed validation: quarantine the pushed branch before
  // propagating, rather than leaving an unvalidated snapshot in place.
  let checkout;
  let validation;
  try {
    checkout = checkoutDestinationForValidation(
      { destDir: destination.dir, branch: destBranch, checkoutDir: destCheckoutDir },
      runner
    );
    validation = scanTree(checkout.dir);
  } catch (err) {
    const quarantine = quarantineFailedPush({ destDir: destination.dir, branch: destBranch, preMigrateRev }, runner);
    return {
      ok: false,
      stage: 'validate',
      reason: `post-migrate validation setup failed: ${err && err.message ? err.message : err}`,
      sourceRev: origin.resolvedRev,
      quarantine,
    };
  }
  if (!validation.ok) {
    const quarantine = quarantineFailedPush({ destDir: destination.dir, branch: destBranch, preMigrateRev }, runner);
    return {
      ok: false,
      stage: 'validate',
      reason: 'unsafe content in transformed tree',
      findings: validation.findings,
      sourceRev: origin.resolvedRev,
      quarantine,
    };
  }

  return {
    ok: true,
    sourceRev: origin.resolvedRev,
    originDir: origin.dir,
    destDir: destination.dir,
    destCheckoutDir: checkout.dir,
    javaMajor: java.major,
    pinRelease: pin.release,
    baseline,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--source-repo') opts.sourceRepoPath = argv[++i];
    else if (a === '--rev') opts.rev = argv[++i];
    else if (a === '--workdir') opts.workdir = argv[++i];
    else if (a === '--dest-baseline') opts.baselinePath = argv[++i];
    else if (a === '--dest-branch') opts.destBranch = argv[++i];
    else if (a === '--jar') opts.jarPath = argv[++i];
    else if (a === '--pin') opts.pinPath = argv[++i];
    else if (a === '--config') opts.configTemplate = argv[++i];
    else if (a === '--workflow') opts.workflowName = argv[++i];
    else if (a === '--init-history') opts.initHistory = true;
    else if (a === '--last-rev') {
      const value = argv[++i];
      if (value === undefined) {
        opts.lastRevMissingValue = true;
      } else {
        opts.lastRev = value;
      }
    }
  }
  return opts;
}

export function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (!opts.sourceRepoPath || !opts.jarPath) {
    console.error('Usage: node scripts/copybara-export.mjs --source-repo <path> --jar <path-to-pinned-jar> [--rev <ref>] [--workdir <dir>] [--dest-baseline <path>] [--pin <path>] [--init-history | --last-rev <sha>]');
    return 2;
  }
  // issue #800 P2: a bare trailing `--last-rev` must fail closed rather than
  // silently falling back to Copybara's own (unresolvable-destination-prone)
  // baseline behavior — this flag exists specifically to make the baseline
  // explicit, so a malformed invocation of it must never be treated as if it
  // were absent.
  if (opts.lastRevMissingValue) {
    console.error('copybara-export: option "--last-rev" requires a value (the private source SHA to use as the baseline)');
    return 2;
  }
  const result = runExport(opts);
  if (result.ok) {
    console.log(`copybara-export: OK — exported ${result.sourceRev} (Java ${result.javaMajor}, pin ${result.pinRelease})`);
    console.log(`  origin:              ${result.originDir}`);
    console.log(`  destination (bare):  ${result.destDir}`);
    console.log(`  destination checkout: ${result.destCheckoutDir}`);
    return 0;
  }
  console.error(`copybara-export: FAILED at stage "${result.stage}" — ${result.reason}`);
  if (result.findings) {
    for (const f of result.findings) {
      const loc = f.line ? `${f.file}:${f.line}` : f.file;
      console.error(`  [${f.rule}] ${loc} — ${f.description}: ${displayMatch(f)}`);
    }
  }
  if (result.quarantine?.quarantined) {
    console.error(`  quarantined rejected push: ${result.quarantine.quarantineRef} (destination branch rolled back)`);
  }
  return 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
