/**
 * Test-owned HOME / config / state / lock roots (issue #1063).
 *
 * Almost every durable default this project owns hangs off the home directory:
 * `~/.config/n8n-ai-cli-loop/sessions.json`, `~/.config/n8n-ai-cli-loop/dev_loop.db`,
 * `~/.local/state/n8n-ai-cli-loop/locks`, `~/.local/state/n8n-ai-cli-loop/worktrees`
 * and — the one that actually bit — `~/.local/state/n8n-ai-cli-loop/worktree-locks`.
 * A suite that reaches any of those defaults reads, writes and force-releases
 * *operator* state: `test/implementation-handler.test.js` used to clear a real
 * `addon-dev::issue-101` worktree lock before every run, and a run-one-phase CLI
 * fixture that leaked a lock left later runs taking the contention path instead
 * of the behaviour under test.
 *
 * This module owns the run's replacement roots. `globalSetup` creates one
 * `mkdtemp` root per Jest process and pins the *real* environment at it, so:
 *
 *   - every worker inherits it (jest-worker forks with `{...process.env}`), and
 *     so does every child a test spawns — including the ones spawned without an
 *     explicit `env`, which is most of the `git` helpers in this suite;
 *   - `os.homedir()` and `process.env.HOME` agree, in the worker and in the
 *     child. They must: a fixture that writes a lock through one and reads it
 *     back through the other would be its own flake.
 *
 * `setupFiles` then re-applies the same values to the Jest sandbox's *copy* of
 * `process.env` (jest-util's `createProcessObject`) before the test file — and
 * therefore `dist/index.js` — is imported, which is what puts the module-load-time
 * constants (`DEFAULT_WORKTREE_LOCK_DIR` and friends, all resolved through
 * `core/home-dir.ts`) inside the test-owned root.
 *
 * ## What this does NOT give you
 *
 * One root per Jest *process*, not per worker: workers share it, exactly as they
 * share the operator's home today, minus the operator's state. A fixture that
 * needs a root no concurrent test can touch — anything reaching a *default* lock
 * path — must still create its own HOME inside its own `tmpDir` and pass it to
 * the CLI it spawns (see `run-one-phase CLI — implementation gating`). Two
 * concurrently executing Jest processes DO get unrelated roots, because the root
 * is an `mkdtemp`.
 */
import { existsSync, mkdtempSync, mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { basename, isAbsolute, join, resolve, sep } from 'path';

/** Carries the run's root from `globalSetup` to the workers and to `globalTeardown`. */
export const TEST_HOME_ROOT_ENV = 'N8N_AI_CLI_LOOP_TEST_HOME_ROOT';

/**
 * Leading path segment every test-owned root carries. `removeTestHomeRoot`
 * refuses to delete anything without it, so a mis-set env var can only ever fail
 * the run — never take an operator directory with it.
 */
export const TEST_HOME_DIR_PREFIX = 'n8n-ai-cli-loop-test-home-';

/**
 * Operator-settable overrides this project reads at runtime. Inherited from the
 * developer's shell they would silently redirect a test — `N8N_AI_WORKTREE_ROOT`
 * moves the worktree root out of the test's own tree; `CLAUDE_MODEL`/`CODEX_EFFORT`
 * change what a resolution test resolves; `AI_LOOP_CLI_PROBE_STUB` replaces a
 * probe wholesale. A fixture that wants one sets it explicitly on the child it
 * spawns, so clearing the inherited value costs nothing.
 */
export const CLEARED_OPERATOR_ENV_VARS = [
  'N8N_AI_WORKTREE_ROOT',
  'ANTIGRAVITY_BIN',
  'ANTIGRAVITY_CLI_SETTINGS',
  'CLI_BASE',
  'CLAUDE_MODEL',
  'CLAUDE_EFFORT',
  'CLAUDE_MAX_BUDGET_USD',
  'CODEX_MODEL',
  'CODEX_EFFORT',
  'CODEX_CONTEXT_MODE',
  'CIRCUIT_BREAKER_ISSUE_PHASE_FAILURES',
  'CIRCUIT_BREAKER_SESSION_FAILURES',
  'QUOTA_RETRY_DELAY_HOURS',
  'QUOTA_RETRY_DELAY_MS',
  'TRANSIENT_RETRY_DELAY_MS',
  'AI_LOOP_CLI_PROBE_STUB',
];

/**
 * Credentials that would let a fixture reach a real authenticated service even
 * with the home directory redirected: `gh` prefers `GH_TOKEN`/`GITHUB_TOKEN`
 * over anything in its config dir, so an inherited one turns a stray `gh` call
 * into a real GitHub request no matter where `GH_CONFIG_DIR` points. Every
 * GitHub call in this suite is faked, so an inherited token can only ever be an
 * accident.
 *
 * Unlike {@link CLEARED_OPERATOR_ENV_VARS} these are NOT snapshotted for
 * {@link useOperatorEnv} — a snapshot would put the token back in an ordinary
 * environment variable that every child inherits, which is the thing being
 * prevented. They are gone for the whole run.
 *
 * The agent CLIs' own API keys are deliberately left alone: the agents are only
 * ever reached through a faked binary, and the one test that drives a real one
 * is opt-in and asks for operator state explicitly.
 */
export const CLEARED_CREDENTIAL_ENV_VARS = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
];

/** The location variables {@link applyTestHomeEnv} pins at the isolated home. */
export const PINNED_ENV_VARS = [
  'HOME',
  'USERPROFILE',
  'XDG_CONFIG_HOME',
  'XDG_STATE_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'GH_CONFIG_DIR',
];

/** Everything {@link useOperatorEnv} can put back. */
const TRACKED_ENV_VARS = [...PINNED_ENV_VARS, ...CLEARED_OPERATOR_ENV_VARS];

/**
 * Carries the operator's values for {@link TRACKED_ENV_VARS} across the
 * isolation, so the one opt-in test that drives a REAL CLI against the
 * operator's own store can ask for them back. Secrets are never in here.
 */
export const OPERATOR_ENV_SNAPSHOT_ENV = 'N8N_AI_CLI_LOOP_OPERATOR_ENV';

/**
 * The global git config the isolated home ships with.
 *
 * Without it the suite would trade one host dependence for another: the `git`
 * helpers that commit without `-c user.email` only work today because the
 * operator has a global identity, and `git init` without `-b` picks its branch
 * from `init.defaultBranch`. Pinning both here makes the outcome the same on an
 * operator's laptop and on a CI runner with no git config at all.
 */
const TEST_GITCONFIG = `# Written by test/helpers/test-home.js (issue #1063).
[user]
\tname = n8n-ai-cli-loop tests
\temail = tests@example.invalid
[init]
\tdefaultBranch = main
[commit]
\tgpgsign = false
[tag]
\tgpgsign = false
[gc]
\tauto = 0
`;

/** The home directory inside a run root. */
export function testHomeFromRoot(root) {
  return join(root, 'home');
}

/** Every spelling of the system temp dir a root may legitimately live under. */
function tempRoots() {
  const roots = new Set([tmpdir()]);
  try {
    // macOS: tmpdir() is `/var/folders/...` while `/var` is a symlink to
    // `/private/var`, so a realpath'd root would fail a naive prefix test.
    roots.add(realpathSync(tmpdir()));
  } catch {
    // An unreadable temp dir is the caller's problem, not this guard's.
  }
  return [...roots];
}

/**
 * Whether `candidate` is a path this module is allowed to create and destroy:
 * an absolute path under the system temp dir whose OWN name carries
 * {@link TEST_HOME_DIR_PREFIX}. Anything else — a relative path, an operator
 * directory, `$HOME`, the home inside a root, a traversal out of the temp dir —
 * is rejected.
 */
export function isTestHomeRoot(candidate) {
  if (typeof candidate !== 'string' || candidate.length === 0) return false;
  if (!isAbsolute(candidate)) return false;
  const normalized = resolve(candidate);
  if (!basename(normalized).startsWith(TEST_HOME_DIR_PREFIX)) return false;
  return tempRoots().some((root) => normalized.startsWith(root.endsWith(sep) ? root : root + sep));
}

/**
 * Create the directories and the git config the isolated home needs. Idempotent:
 * `setupFiles` calls it once per test file, concurrently across workers, and a
 * test that deletes its home mid-run gets it back on the next file.
 */
export function ensureTestHome(root) {
  const home = testHomeFromRoot(root);
  for (const dir of [
    join(home, '.config', 'gh'),
    join(home, '.local', 'state'),
    join(home, '.local', 'share'),
    join(home, '.cache'),
  ]) {
    mkdirSync(dir, { recursive: true });
  }
  const gitconfig = join(home, '.gitconfig');
  if (!existsSync(gitconfig)) {
    // Write-then-rename: two workers racing here would otherwise let a third
    // read a half-written config. `rename` is atomic within the directory.
    const staging = `${gitconfig}.${process.pid}.tmp`;
    writeFileSync(staging, TEST_GITCONFIG, 'utf8');
    renameSync(staging, gitconfig);
  }
  return home;
}

/**
 * Point `env` at the run's isolated home and strip the operator state that would
 * otherwise leak past it. Applied to the real environment in `globalSetup` and
 * to the sandbox copy in `setupFiles`, so both agree.
 */
export function applyTestHomeEnv(env, root) {
  const home = testHomeFromRoot(root);
  if (env[OPERATOR_ENV_SNAPSHOT_ENV] === undefined) {
    // Taken once, in `globalSetup`, while `env` still holds the operator's
    // values; the workers inherit the snapshot rather than re-deriving one from
    // the already-isolated environment they start in.
    env[OPERATOR_ENV_SNAPSHOT_ENV] = JSON.stringify(captureEnv(env, TRACKED_ENV_VARS));
  }
  for (const key of [...CLEARED_OPERATOR_ENV_VARS, ...CLEARED_CREDENTIAL_ENV_VARS]) {
    delete env[key];
  }
  env[TEST_HOME_ROOT_ENV] = root;
  env['HOME'] = home;
  // Windows resolves the home directory from USERPROFILE; keep the two in step
  // so a run there isolates the same way rather than half of it.
  env['USERPROFILE'] = home;
  env['XDG_CONFIG_HOME'] = join(home, '.config');
  env['XDG_STATE_HOME'] = join(home, '.local', 'state');
  env['XDG_DATA_HOME'] = join(home, '.local', 'share');
  env['XDG_CACHE_HOME'] = join(home, '.cache');
  // An operator with GH_CONFIG_DIR set would still reach their real credentials
  // through it, isolated HOME or not.
  env['GH_CONFIG_DIR'] = join(home, '.config', 'gh');
  return home;
}

/** The values `env` currently holds for `keys` (absent keys stay absent). */
function captureEnv(env, keys) {
  const captured = {};
  for (const key of keys) {
    if (env[key] !== undefined) captured[key] = env[key];
  }
  return captured;
}

/** Set every key in `values` and remove every tracked key it does not mention. */
function restoreEnv(env, values) {
  for (const key of TRACKED_ENV_VARS) {
    if (values[key] === undefined) delete env[key];
    else env[key] = values[key];
  }
}

/**
 * Hand `env` back the operator's home and overrides for the duration of a test
 * that genuinely needs them — today only `test/antigravity-cli-smoke.test.js`,
 * which is opt-in behind `ANTIGRAVITY_CLI_SMOKE=1` and whose whole point is to
 * drive the INSTALLED `agy` against the global settings file that CLI actually
 * reads, i.e. the operator's.
 *
 * Returns the undo. Call it in the matching teardown so the rest of the file —
 * and, under `--runInBand`, the rest of the worker — goes back to the isolated
 * home. Secrets are not restored: {@link CLEARED_CREDENTIAL_ENV_VARS} stay
 * cleared for the whole run.
 *
 * This restores the Jest sandbox's COPY of `process.env` and nothing else. A
 * child spawned without an explicit `env` inherits the worker's REAL
 * environment, which `globalSetup` pinned at the isolated home — so a caller
 * that needs the operator's home in a subprocess has to hand the restored
 * `process.env` to it, or it will prepare operator state and then run the
 * subprocess somewhere else.
 */
export function useOperatorEnv(env = process.env) {
  const raw = env[OPERATOR_ENV_SNAPSHOT_ENV];
  if (raw === undefined) {
    throw new Error(
      `${OPERATOR_ENV_SNAPSHOT_ENV} is unset: the operator environment was never ` +
        'snapshotted, so it cannot be restored. Jest must run with the globalSetup ' +
        'in package.json (test/helpers/test-home-global-setup.cjs).',
    );
  }
  const operator = JSON.parse(raw);
  const previous = captureEnv(env, TRACKED_ENV_VARS);
  restoreEnv(env, operator);
  return () => restoreEnv(env, previous);
}

/** Create a fresh run root (unique per process) with its home already prepared. */
export function createTestHomeRoot() {
  const root = mkdtempSync(join(tmpdir(), TEST_HOME_DIR_PREFIX));
  ensureTestHome(root);
  return root;
}

/**
 * Remove a run root — and refuse anything that is not one. Cleanup is the half
 * of this that can do damage, so it is guarded by {@link isTestHomeRoot} rather
 * than by the caller's good intentions.
 */
export function removeTestHomeRoot(root) {
  if (!isTestHomeRoot(root)) {
    return {
      removed: false,
      reason:
        `refusing to remove ${String(root)}: not a test-owned home root ` +
        `(expected an absolute path under ${tmpdir()} named ${TEST_HOME_DIR_PREFIX}*)`,
    };
  }
  rmSync(root, { recursive: true, force: true });
  return { removed: true };
}
