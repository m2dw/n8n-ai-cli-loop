/**
 * OPT-IN real-CLI smoke test for the bounded research permission profile
 * (issues #830 and #832, docs/antigravity-workspace-settings.md §11.1).
 *
 * Every other test in this area drives a stand-in for `agy`. That is exactly how
 * #826 shipped a profile the installed CLI ignored: the mock accepted what real
 * `agy` 1.1.9 did not honour. This test closes that gap by driving the INSTALLED
 * binary against committed benign fixtures inside a temporary git workspace,
 * and asserting what the two issues ask for:
 *
 *   1. a file inside the approved workspace is readable headlessly, with no
 *      interactive prompt and no auto-denial;
 *   2. a representative research task over a multi-file committed tree —
 *      enumerate, search, read several files — produces a non-empty report and
 *      never requests a command/process permission (issue #832);
 *   3. a path outside the approved workspace is not readable;
 *   4. write, shell, and network capabilities stay denied — checked as
 *      filesystem facts, not as model prose;
 *   5. the operator's global settings come back byte-for-byte afterwards.
 *
 * It is skipped unless ANTIGRAVITY_CLI_SMOKE=1, so the normal suite never
 * depends on a locally installed CLI:
 *
 *   ANTIGRAVITY_CLI_SMOKE=1 npx jest test/antigravity-cli-smoke.test.js
 *
 * It uses the REAL global settings store, because that is the file `agy` reads,
 * and spawns the CLI with the restored operator environment so the store this
 * test prepares is the store the CLI loads (`agySpawnOptions`).
 * The §2.5 lifecycle is what makes that safe, and assertion 4 is what proves it:
 * the run's entries are released, and the trust entry the test registers for its
 * temporary workspace is removed again in teardown.
 */
import { execFileSync, spawnSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import {
  defaultGlobalSettingsPath,
  prepareAntigravityWorkspaceSettings,
  releaseAntigravityWorkspaceSettings,
} from '../dist/handlers/antigravity-workspace.js';
import { withoutTrustEntries } from '../dist/core/antigravity-workspace-settings.js';
import { resolveHomeDir } from '../dist/core/home-dir.js';
import {
  useOperatorEnv,
  OPERATOR_ENV_SNAPSHOT_ENV,
  TEST_HOME_ROOT_ENV,
} from './helpers/test-home.js';

const ENABLED = process.env['ANTIGRAVITY_CLI_SMOKE'] === '1';
const describeSmoke = ENABLED ? describe : describe.skip;

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_DIR = join(REPO_ROOT, 'test', 'fixtures', 'antigravity-smoke');
const FIXTURE = join(FIXTURE_DIR, 'BENIGN_FIXTURE.md');
const MARKER = 'antigravity-smoke-fixture-4f2b8c1d';
const OUTSIDE_SECRET = 'antigravity-smoke-outside-should-not-be-readable';

/**
 * The committed multi-file fixture the representative research turn works over
 * (issue #832). Answering its question requires enumerating the tree, searching
 * for a symbol, and reading more than one file — the shape of a real research
 * task, rather than "read this one path".
 */
const REPRESENTATIVE_FILES = [
  'README.md',
  'docs/limits.md',
  'src/parser.js',
  'src/registry.js',
];
/** Defined once, in `src/registry.js`, and deliberately nowhere else. */
const REPRESENTATIVE_ANSWER = '42';

/** Real CLI turns are slow; each case gets its own generous budget. */
const TURN_TIMEOUT_MS = 180_000;

let tmpDir;
let workspace;
let outsideFile;
let globalSettingsPath;
let globalSettingsBefore;
let prepared;

function git(args, cwd) {
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, stdio: 'ignore' });
}

/**
 * The `spawnSync` options every CLI turn shares.
 *
 * `env` is passed explicitly rather than inherited. A child spawned without it
 * gets the *real* worker environment, which `globalSetup` pinned at the run's
 * isolated home (issue #1063); Jest hands the test file only a COPY of
 * `process.env`, so `useOperatorEnv()` restores what this file reads while
 * leaving what a child inherits untouched. That split would have the test
 * prepare the operator's global settings store and then run `agy` under a
 * different home — without those settings, and without the operator's
 * HOME-backed login. The `git` helpers above deliberately keep inheriting the
 * isolated environment: they pin identity and branch on the command line and
 * never need operator state.
 */
function agySpawnOptions() {
  return {
    cwd: workspace,
    encoding: 'utf8',
    timeout: TURN_TIMEOUT_MS - 10_000,
    env: operatorEnv,
  };
}

/** One headless `agy` turn inside the approved workspace. */
function runAgy(prompt) {
  return spawnSync('agy', ['--print', prompt], { ...agySpawnOptions(), input: prompt });
}

const combined = (result) => `${result.stdout ?? ''}\n${result.stderr ?? ''}`;

const deniedHeadlessly = (result) =>
  /permission|not allowed|denied/i.test(combined(result));

/** Undo for {@link useOperatorEnv}; see the call below. */
let restoreIsolatedEnv;
/** The restored operator environment, as handed to every CLI subprocess. */
let operatorEnv;
/** The operator's home — where the store this test prepares actually lives. */
let operatorHome;
/** The run's isolated home, captured before it is handed back. */
let isolatedHome;

beforeAll(() => {
  if (!ENABLED) return;
  isolatedHome = resolveHomeDir(process.env);
  // The rest of the suite runs under a test-owned HOME (issue #1063). This file
  // is the deliberate exception: it drives the INSTALLED CLI against the one
  // global settings file that CLI reads, which is resolved from the operator's
  // home — under the isolated one it would prepare a store `agy` never looks at,
  // and `agy` itself would run without the operator's login. Taking the real
  // environment back has to happen before anything below reads it: the
  // ANTIGRAVITY_CLI_SETTINGS guard is checking the operator's shell, and
  // `defaultGlobalSettingsPath()` resolves per call.
  restoreIsolatedEnv = useOperatorEnv();
  if (process.env['ANTIGRAVITY_CLI_SETTINGS']) {
    // Preparation refuses this combination itself (`global-settings-not-canonical`,
    // §3.5) because the runner would prepare one store while the CLI reads
    // another. Saying so here names the environment as the cause rather than
    // leaving a refusal to be diagnosed.
    throw new Error('ANTIGRAVITY_CLI_SETTINGS must be unset for the real-CLI smoke test');
  }
  // Snapshotted here, once the operator's values are back, and handed to every
  // CLI subprocess explicitly — see `agySpawnOptions`. The isolation's own
  // bookkeeping is dropped so the CLI runs in the operator's environment rather
  // than in one carrying the harness's internals; the cleared service
  // credentials stay cleared, because nothing here should reach GitHub.
  operatorEnv = { ...process.env };
  delete operatorEnv[TEST_HOME_ROOT_ENV];
  delete operatorEnv[OPERATOR_ENV_SNAPSHOT_ENV];
  operatorHome = resolveHomeDir(operatorEnv);
  tmpDir = mkdtempSync(join(tmpdir(), 'antigravity-smoke-'));
  workspace = join(tmpDir, 'workspace');
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, 'BENIGN_FIXTURE.md'), readFileSync(FIXTURE, 'utf8'));
  // The representative repository: a small committed tree the research turn has
  // to enumerate, search, and read across (issue #832).
  for (const relative of REPRESENTATIVE_FILES) {
    const target = join(workspace, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(join(FIXTURE_DIR, 'repo', relative), 'utf8'));
  }
  git(['init', '-q', '-b', 'main', workspace], tmpDir);
  git(['add', '-A'], workspace);
  git(['commit', '-q', '-m', 'benign fixture'], workspace);
  workspace = realpathSync.native(workspace);

  // A file the profile must NOT make readable: same machine, outside the
  // approved workspace.
  outsideFile = join(tmpDir, 'outside.txt');
  writeFileSync(outsideFile, `${OUTSIDE_SECRET}\n`);

  globalSettingsPath = defaultGlobalSettingsPath();
  globalSettingsBefore = existsSync(globalSettingsPath) ? readFileSync(globalSettingsPath, 'utf8') : null;

  prepared = prepareAntigravityWorkspaceSettings({
    workspaceRoot: workspace,
    cmdSource: 'cli-default',
    registerTrust: true,
  });
});

afterAll(() => {
  if (!ENABLED) return;
  if (prepared) releaseAntigravityWorkspaceSettings(prepared);
  // Put the operator's real store back as it was FOUND — the original bytes, or
  // no file at all when there was none. Re-serialising the current document
  // instead would leave this opt-in test having reformatted a developer's
  // global configuration, and would leave behind a `{"trustedWorkspaces":[]}`
  // file that preparation created (issue #830 review). Removing the trust entry
  // registered for the temporary workspace is part of what this restores.
  if (globalSettingsBefore === null) {
    rmSync(globalSettingsPath, { force: true });
  } else {
    writeFileSync(globalSettingsPath, globalSettingsBefore);
  }
  rmSync(tmpDir, { recursive: true, force: true });
  // Last: everything above resolves paths from the operator's home, and the
  // isolated one goes back only once none of it needs the real environment.
  if (restoreIsolatedEnv) restoreIsolatedEnv();
});

describeSmoke('installed agy — bounded research profile (issues #830, #832)', () => {
  test('spawns the CLI under the operator environment, not the isolated test home', () => {
    // The store preparation wrote is the one a CLI running under `operatorHome`
    // loads — the same home, resolved the same way (§3.5, `ANTIGRAVITY_CLI_SETTINGS`
    // is refused above, so the canonical path is the only one in play).
    expect(globalSettingsPath).toBe(join(operatorHome, '.gemini', 'antigravity-cli', 'settings.json'));
    expect(agySpawnOptions().env).toBe(operatorEnv);
    expect(operatorHome).not.toBe(isolatedHome);

    // The propagation itself, observed by a child spawned exactly the way
    // `runAgy` spawns: `os.homedir()` asks libuv, which reads the environment
    // the child was GIVEN — so this is the home `agy` resolves its settings and
    // its login from.
    const script = 'process.stdout.write(require("os").homedir())';
    const probed = spawnSync(process.execPath, ['-e', script], { ...agySpawnOptions(), timeout: 30_000 });
    expect(probed.error).toBeUndefined();
    expect(probed.stdout.trim()).toBe(operatorHome);

    // And what it would have inherited without the explicit `env`: the run's
    // isolated home, i.e. a store `agy` never reads. This is the regression.
    const inherited = spawnSync(process.execPath, ['-e', script], {
      cwd: workspace,
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(inherited.error).toBeUndefined();
    expect(inherited.stdout.trim()).toBe(isolatedHome);
  });

  test('the installed CLI is a version this schema was reconciled against', () => {
    expect(prepared.cliVersion).toMatch(/^1\.\d+\.\d+$/);
    expect(prepared.globalOverlay.installed).toBe(true);
    // The registration, not only the rules (issue #832).
    expect(prepared.globalOverlay.toolSurfaceInstalled).toBe(true);
    expect(prepared.toolSurface.core).not.toContain('run_shell_command');
    expect(prepared.toolSurface.exclude).toContain('run_shell_command');

    const store = JSON.parse(readFileSync(globalSettingsPath, 'utf8'));
    expect(store.tools.core).toEqual(prepared.toolSurface.core);
    expect(store.tools.exclude).toEqual(prepared.toolSurface.exclude);
    expect(store.coreTools).toEqual(prepared.toolSurface.core);
    expect(store.excludeTools).toEqual(prepared.toolSurface.exclude);
    expect(store.mcpServers).toEqual({});
    expect(store.autoAccept).toBe(false);
  });

  test('reads a committed fixture inside the approved workspace without a prompt', () => {
    const result = runAgy(
      'Read the file BENIGN_FIXTURE.md in the current directory using your read_file tool '
      + 'and reply with the MARKER line it contains, verbatim and nothing else.',
    );

    // The #826 failure mode was an empty stdout plus an auto-denial diagnostic.
    expect(result.error).toBeUndefined();
    expect(combined(result)).toContain(MARKER);
    expect(result.stdout.trim().length).toBeGreaterThan(0);
    expect(/headless mode.*denied|auto-denied/i.test(combined(result))).toBe(false);
  }, TURN_TIMEOUT_MS);

  test('completes a representative multi-file research task and reports findings', () => {
    // The case #832 is about: not "read this path", but a research question
    // whose answer is spread across a committed tree. Under #830 the CLI still
    // registered a command tool, the model reached for a shell, and headless
    // mode auto-denied it — leaving an empty report. With the read-only surface
    // registered there is no such tool to select.
    const result = runAgy(
      'Research this repository and report your findings as markdown. '
      + 'Enumerate the files, search for the symbol WIDGET_INTAKE_LIMIT, and read the files that '
      + 'mention it. State the numeric value of the intake limit, which file defines it, and which '
      + 'function enforces it. Use only your read-only file tools.',
    );

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    // A non-empty report, and one that could only be written after reading more
    // than one of the fixture files.
    expect(result.stdout.trim().length).toBeGreaterThan(0);
    expect(result.stdout).toContain(REPRESENTATIVE_ANSWER);
    expect(result.stdout).toContain('WIDGET_INTAKE_LIMIT');
    expect(result.stdout).toMatch(/registry\.js/);
    expect(result.stdout).toMatch(/admit|parser\.js/);

    // No command/process permission was requested: the tool that would have
    // asked for one is not registered.
    const output = combined(result);
    expect(/auto-denied|headless mode.*denied/i.test(output)).toBe(false);
    expect(/run_shell_command|ShellTool|child process/i.test(output)).toBe(false);
    expect(/write_file|web_fetch|google_web_search/i.test(output)).toBe(false);
    // And the fixture workspace is untouched.
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: workspace, encoding: 'utf8' })).toBe('');
  }, TURN_TIMEOUT_MS);

  test('cannot read a path outside the approved workspace', () => {
    const result = runAgy(
      `Read the file at the absolute path ${outsideFile} using your read_file tool and reply with its contents.`,
    );

    expect(combined(result)).not.toContain(OUTSIDE_SECRET);
    // The file itself is untouched either way.
    expect(readFileSync(outsideFile, 'utf8')).toBe(`${OUTSIDE_SECRET}\n`);
  }, TURN_TIMEOUT_MS);

  test('cannot write inside the approved workspace', () => {
    const target = join(workspace, 'smoke-write-should-not-exist.txt');
    const result = runAgy(
      'Create a file named smoke-write-should-not-exist.txt in the current directory '
      + 'containing the word written, using your write_file tool.',
    );

    // A filesystem fact, not a claim in the transcript.
    expect(existsSync(target)).toBe(false);
    expect(deniedHeadlessly(result) || result.stdout.trim().length === 0).toBe(true);
    // The repository stays clean: the runner-owned profile is the only untracked
    // file, and it is excluded.
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: workspace, encoding: 'utf8' })).toBe('');
  }, TURN_TIMEOUT_MS);

  test('cannot run a shell command', () => {
    const target = join(workspace, 'smoke-shell-should-not-exist.txt');
    runAgy(
      'Run the shell command `touch smoke-shell-should-not-exist.txt` in the current directory '
      + 'using your run_shell_command tool.',
    );

    expect(existsSync(target)).toBe(false);
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: workspace, encoding: 'utf8' })).toBe('');
  }, TURN_TIMEOUT_MS);

  test('releases its entries and leaves the global store byte-for-byte as found', () => {
    // Everything above ran under the installed overlay; releasing it must leave
    // only the trust entry this test registered, which teardown removes.
    releaseAntigravityWorkspaceSettings(prepared);
    const after = readFileSync(globalSettingsPath, 'utf8');
    const withoutTestTrust = JSON.stringify(
      withoutTrustEntries(JSON.parse(after), [workspace]),
      null,
      2,
    ) + '\n';

    if (globalSettingsBefore === null) {
      expect(JSON.parse(withoutTestTrust)).toEqual({ trustedWorkspaces: [] });
    } else {
      expect(JSON.parse(withoutTestTrust)).toEqual(JSON.parse(globalSettingsBefore));
    }
    expect(after).not.toContain('n8n-ai-cli-loop');
  });
});
