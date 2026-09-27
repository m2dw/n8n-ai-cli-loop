/**
 * Regression coverage for the test-owned HOME/config/state/lock roots
 * (issue #1063).
 *
 * The suite used to resolve its managed defaults — the sessions registry, the
 * SQLite databases, the repo lock dir, the worktree root and the per-issue
 * worktree-lock dir — from the *operator's* home, and one fixture went as far as
 * force-releasing a real `addon-dev::issue-101` worktree lock there before every
 * run. This file pins the three properties that stop that from coming back:
 *
 *   1. every managed default resolves inside the run's test-owned home;
 *   2. what this process resolves is what a spawned child resolves;
 *   3. cleanup can only ever delete a test-owned root — a host-like home with
 *      seeded lock/config sentinels survives it untouched.
 *
 * See test/helpers/test-home.js for how the root is created and propagated.
 */
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join, sep } from 'path';

import {
  applyTestHomeEnv,
  createTestHomeRoot,
  isTestHomeRoot,
  removeTestHomeRoot,
  testHomeFromRoot,
  useOperatorEnv,
  CLEARED_CREDENTIAL_ENV_VARS,
  CLEARED_OPERATOR_ENV_VARS,
  OPERATOR_ENV_SNAPSHOT_ENV,
  TEST_HOME_DIR_PREFIX,
  TEST_HOME_ROOT_ENV,
} from './helpers/test-home.js';

import { resolveHomeDir, homeDirEnvVar } from '../dist/core/home-dir.js';
import { DEFAULT_WORKTREE_ROOT } from '../dist/core/worktree-paths.js';
import { DEFAULT_WORKTREE_LOCK_DIR, IssueWorktreeLock } from '../dist/handlers/worktree.js';
import { DEFAULT_LOCK_DIR } from '../dist/stores/repo-lock-store.js';
import { DEFAULT_SESSIONS_PATH } from '../dist/registries/json-session-registry.js';
import { DEFAULT_BACKUP_DIR } from '../dist/stores/sqlite-backup-store.js';
import { DEFAULT_DB_PATH } from '../dist/stores/sqlite-chatops-store.js';
import { DEFAULT_CHAIN_REGISTRY_DB_PATH } from '../dist/stores/sqlite-chain-registry-store.js';

const RUN_ROOT = process.env[TEST_HOME_ROOT_ENV];
const RUN_HOME = testHomeFromRoot(RUN_ROOT ?? '');

let tmpDir;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'test-home-isolation-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The run's own roots
// ---------------------------------------------------------------------------

describe('the Jest run owns its HOME', () => {
  test('HOME is a prepared, test-owned root under the system temp dir', () => {
    expect(isTestHomeRoot(RUN_ROOT)).toBe(true);
    expect(process.env.HOME).toBe(RUN_HOME);
    expect(existsSync(RUN_HOME)).toBe(true);
    // A deterministic git identity/default branch ships with it, so a fixture
    // that commits without `-c user.email` does not silently depend on the
    // operator having a global git config.
    const gitconfig = readFileSync(join(RUN_HOME, '.gitconfig'), 'utf8');
    expect(gitconfig).toContain('defaultBranch = main');
    expect(gitconfig).toContain('tests@example.invalid');
  });

  test('os.homedir() agrees with process.env.HOME', () => {
    // These must not diverge: a fixture that writes a lock through the default
    // resolved from one and reads it back through the other would be its own
    // flake. `globalSetup` pins the real environment and `setupFiles` pins the
    // sandbox copy to the same value for exactly this reason.
    expect(homedir()).toBe(RUN_HOME);
    expect(resolveHomeDir()).toBe(RUN_HOME);
  });

  test('operator overrides and service credentials are not inherited', () => {
    for (const key of [...CLEARED_OPERATOR_ENV_VARS, ...CLEARED_CREDENTIAL_ENV_VARS]) {
      expect(process.env[key]).toBeUndefined();
    }
    // GH_CONFIG_DIR is pinned rather than cleared: an operator who has it set
    // would otherwise still reach their real `gh` credentials through it.
    expect(process.env.GH_CONFIG_DIR).toBe(join(RUN_HOME, '.config', 'gh'));
    expect(process.env.XDG_CONFIG_HOME).toBe(join(RUN_HOME, '.config'));
    expect(process.env.XDG_STATE_HOME).toBe(join(RUN_HOME, '.local', 'state'));
  });

  test('the operator environment can be taken back, and is given back again', () => {
    // The escape hatch `test/antigravity-cli-smoke.test.js` uses: that opt-in
    // test drives the installed `agy` against the operator's own settings store,
    // so it needs the real locations for its duration and the isolated ones
    // back afterwards.
    const restore = useOperatorEnv();
    try {
      expect(process.env.HOME).not.toBe(RUN_HOME);
      // Secrets are never snapshotted, so taking the operator environment back
      // cannot resurrect a token.
      for (const key of CLEARED_CREDENTIAL_ENV_VARS) {
        expect(process.env[key]).toBeUndefined();
        expect(JSON.parse(process.env[OPERATOR_ENV_SNAPSHOT_ENV])).not.toHaveProperty(key);
      }
    } finally {
      restore();
    }

    expect(process.env.HOME).toBe(RUN_HOME);
    expect(process.env.GH_CONFIG_DIR).toBe(join(RUN_HOME, '.config', 'gh'));
    expect(process.env.N8N_AI_WORKTREE_ROOT).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Managed defaults
// ---------------------------------------------------------------------------

describe('managed defaults resolve inside the test-owned home', () => {
  // These are module-load-time constants, so this only holds because
  // `setupFiles` pins the environment BEFORE the test file (and with it
  // `dist/…`) is imported.
  test.each([
    ['DEFAULT_WORKTREE_LOCK_DIR', DEFAULT_WORKTREE_LOCK_DIR],
    ['DEFAULT_LOCK_DIR', DEFAULT_LOCK_DIR],
    ['DEFAULT_WORKTREE_ROOT', DEFAULT_WORKTREE_ROOT],
    ['DEFAULT_SESSIONS_PATH', DEFAULT_SESSIONS_PATH],
    ['DEFAULT_BACKUP_DIR', DEFAULT_BACKUP_DIR],
    ['DEFAULT_DB_PATH', DEFAULT_DB_PATH],
    ['DEFAULT_CHAIN_REGISTRY_DB_PATH', DEFAULT_CHAIN_REGISTRY_DB_PATH],
  ])('%s', (_name, value) => {
    expect(value.startsWith(RUN_HOME + sep)).toBe(true);
  });

  test('the production layout underneath is unchanged', () => {
    // The roots moved; the paths below them did not (the issue explicitly rules
    // out changing production lock locations).
    expect(DEFAULT_WORKTREE_LOCK_DIR).toBe(
      join(RUN_HOME, '.local', 'state', 'n8n-ai-cli-loop', 'worktree-locks'),
    );
    expect(DEFAULT_SESSIONS_PATH).toBe(
      join(RUN_HOME, '.config', 'n8n-ai-cli-loop', 'sessions.json'),
    );
  });
});

describe('resolveHomeDir', () => {
  test('prefers the environment variable the platform itself prefers', () => {
    expect(resolveHomeDir({ HOME: '/tmp/posix-home' }, 'linux')).toBe('/tmp/posix-home');
    expect(resolveHomeDir({ USERPROFILE: 'C:\\Users\\win' }, 'win32')).toBe('C:\\Users\\win');
    expect(homeDirEnvVar('darwin')).toBe('HOME');
    expect(homeDirEnvVar('win32')).toBe('USERPROFILE');
  });

  test('treats an unset or blank value as absent rather than collapsing the root', () => {
    // A blank HOME must not turn `~/.config/...` into a relative path under the
    // process cwd.
    expect(resolveHomeDir({}, 'linux')).toBe(homedir());
    expect(resolveHomeDir({ HOME: '   ' }, 'linux')).toBe(homedir());
  });
});

// ---------------------------------------------------------------------------
// Propagation to children
// ---------------------------------------------------------------------------

describe('spawned children resolve the same home', () => {
  /** The home a child process resolves under `options` (an empty object inherits). */
  const childHome = (options) =>
    execFileSync(process.execPath, ['-p', 'require("os").homedir()'], {
      encoding: 'utf8',
      ...options,
    }).trim();

  test('a child spawned without an explicit env inherits the isolated home', () => {
    // This is the case that matters most: most `git` helpers in this suite
    // spawn without an `env`, so they take the worker's REAL environment. If
    // only the Jest sandbox copy were redirected, those children would still
    // read the operator's git config and credentials.
    const raw = execFileSync(
      process.execPath,
      ['-p', 'JSON.stringify([process.env.HOME, require("os").homedir()])'],
      { encoding: 'utf8' },
    );
    expect(JSON.parse(raw.trim())).toEqual([RUN_HOME, RUN_HOME]);
  }, 30_000);

  test('a child given a fixture HOME resolves the managed defaults under it', () => {
    // The shape every CLI fixture relies on: hand the child a HOME inside the
    // fixture's own tmpDir and its DEFAULT lock dir follows, with no
    // `--lock-dir` override and no change to production wiring.
    const fixtureHome = join(tmpDir, 'fixture-home');
    mkdirSync(fixtureHome, { recursive: true });
    const script = join(tmpDir, 'print-default.mjs');
    const lockModule = new URL('../dist/handlers/worktree.js', import.meta.url).href;
    writeFileSync(
      script,
      `import { DEFAULT_WORKTREE_LOCK_DIR } from ${JSON.stringify(lockModule)};\n` +
        'process.stdout.write(DEFAULT_WORKTREE_LOCK_DIR);\n',
      'utf8',
    );
    const stdout = execFileSync(process.execPath, [script], {
      encoding: 'utf8',
      env: { ...process.env, HOME: fixtureHome, USERPROFILE: fixtureHome },
    });
    expect(stdout).toBe(join(fixtureHome, '.local', 'state', 'n8n-ai-cli-loop', 'worktree-locks'));
  }, 30_000);

  test('a child sees the operator home only when the restored env is passed to it', () => {
    // The seam the opt-in `test/antigravity-cli-smoke.test.js` depends on.
    // `useOperatorEnv()` restores the Jest sandbox's COPY of `process.env`,
    // which is what this process resolves from — but a child spawned without an
    // explicit `env` takes the worker's REAL environment, which `globalSetup`
    // pinned at the isolated home. A test that restored the operator
    // environment and then spawned the CLI bare would prepare the operator's
    // settings store and run the CLI under a different home, without those
    // settings and without the operator's HOME-backed login. Passing the
    // restored environment through is what closes that gap.
    const restore = useOperatorEnv();
    try {
      const operatorHome = resolveHomeDir(process.env);
      expect(operatorHome).not.toBe(RUN_HOME);
      expect(childHome({})).toBe(RUN_HOME);
      expect(childHome({ env: { ...process.env } })).toBe(operatorHome);
    } finally {
      restore();
    }
    // And the isolated home is back for everything after it.
    expect(childHome({})).toBe(RUN_HOME);
    expect(resolveHomeDir(process.env)).toBe(RUN_HOME);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Concurrent roots and test-owned cleanup
// ---------------------------------------------------------------------------

describe('concurrent runs get unrelated roots', () => {
  test('each created root is distinct, prepared, and independently removable', () => {
    // Two concurrently executing Jest processes each call `createTestHomeRoot`
    // once; nothing may make them collide, and tearing one down must not touch
    // the other.
    const first = createTestHomeRoot();
    const second = createTestHomeRoot();
    try {
      expect(first).not.toBe(second);
      expect(isTestHomeRoot(first)).toBe(true);
      expect(isTestHomeRoot(second)).toBe(true);
      expect(existsSync(join(testHomeFromRoot(first), '.gitconfig'))).toBe(true);
      expect(existsSync(join(testHomeFromRoot(second), '.gitconfig'))).toBe(true);

      expect(removeTestHomeRoot(first)).toEqual({ removed: true });
      expect(existsSync(first)).toBe(false);
      expect(existsSync(second)).toBe(true);
    } finally {
      removeTestHomeRoot(first);
      removeTestHomeRoot(second);
    }
  });

  test("applyTestHomeEnv redirects an environment without touching the run's own", () => {
    const root = createTestHomeRoot();
    try {
      const env = { HOME: '/operator/home', GH_TOKEN: 'secret', N8N_AI_WORKTREE_ROOT: '/operator/wt' };
      const home = applyTestHomeEnv(env, root);
      expect(home).toBe(testHomeFromRoot(root));
      expect(env.HOME).toBe(home);
      expect(env.GH_TOKEN).toBeUndefined();
      expect(env.N8N_AI_WORKTREE_ROOT).toBeUndefined();
      expect(env[TEST_HOME_ROOT_ENV]).toBe(root);
      // The run's own environment is untouched by preparing someone else's.
      expect(process.env.HOME).toBe(RUN_HOME);
    } finally {
      removeTestHomeRoot(root);
    }
  });
});

describe('cleanup is restricted to test-owned roots', () => {
  /** A directory that looks like an operator home, with the sentinels #1063 is about. */
  function seedHostLikeHome(dir) {
    const lockDir = join(dir, '.local', 'state', 'n8n-ai-cli-loop', 'worktree-locks');
    const configDir = join(dir, '.config', 'n8n-ai-cli-loop');
    mkdirSync(lockDir, { recursive: true });
    mkdirSync(configDir, { recursive: true });
    const lockFile = join(lockDir, `${encodeURIComponent('addon-dev::issue-101')}.lock`);
    writeFileSync(
      lockFile,
      JSON.stringify({ contextId: 'operator-ctx', sessionId: 'addon-dev', startedAt: '2026-09-06T00:00:00.000Z' }) + '\n',
      'utf8',
    );
    const sessionsFile = join(configDir, 'sessions.json');
    writeFileSync(sessionsFile, JSON.stringify({ sessions: [{ sessionId: 'addon-dev' }] }), 'utf8');
    return { lockFile, sessionsFile };
  }

  test.each([
    ['a host-like home outside the temp dir', '/n8n-ai-cli-loop-test-home-not-really'],
    ['a relative path', 'n8n-ai-cli-loop-test-home-relative'],
    ['an empty value', ''],
    ['a non-string', undefined],
  ])('refuses %s', (_name, candidate) => {
    expect(isTestHomeRoot(candidate)).toBe(false);
    expect(removeTestHomeRoot(candidate).removed).toBe(false);
  });

  test('refuses a directory under the temp dir that is not a test-owned root', () => {
    const hostLike = join(tmpDir, 'operator-home');
    const seeded = seedHostLikeHome(hostLike);

    const outcome = removeTestHomeRoot(hostLike);

    expect(outcome.removed).toBe(false);
    expect(outcome.reason).toContain('not a test-owned home root');
    expect(existsSync(seeded.lockFile)).toBe(true);
    expect(existsSync(seeded.sessionsFile)).toBe(true);
  });

  test('refuses the home INSIDE a root, and the temp dir above it', () => {
    const root = createTestHomeRoot();
    try {
      // Only the root itself carries the prefix; its contents and its parent
      // must not be deletable through this door.
      expect(removeTestHomeRoot(testHomeFromRoot(root)).removed).toBe(false);
      expect(removeTestHomeRoot(join(root, '..')).removed).toBe(false);
      expect(existsSync(root)).toBe(true);
    } finally {
      removeTestHomeRoot(root);
    }
  });

  test('a seeded host-like worktree lock survives a default force-release', () => {
    // The fixture this issue removed did `new IssueWorktreeLock().forceRelease(...)`
    // against the default dir, which was the operator's. The default now lands
    // in the run's own home, so the same call cannot reach a host-like home
    // even when the scope matches exactly.
    const hostLike = join(tmpDir, 'operator-home');
    const seeded = seedHostLikeHome(hostLike);

    expect(DEFAULT_WORKTREE_LOCK_DIR.startsWith(hostLike + sep)).toBe(false);
    const released = new IssueWorktreeLock().forceRelease('addon-dev', 101);

    // Whatever the run's own lock dir held, the host-like one is untouched.
    expect(released.ok).toBe(true);
    expect(existsSync(seeded.lockFile)).toBe(true);
    expect(JSON.parse(readFileSync(seeded.lockFile, 'utf8')).contextId).toBe('operator-ctx');
  });
});

// ---------------------------------------------------------------------------
// The prefix is load-bearing
// ---------------------------------------------------------------------------

test('the guard prefix is what makes a root recognizable', () => {
  const withoutPrefix = mkdtempSync(join(tmpdir(), 'unprefixed-'));
  try {
    expect(isTestHomeRoot(withoutPrefix)).toBe(false);
    expect(isTestHomeRoot(join(tmpdir(), `${TEST_HOME_DIR_PREFIX}abc`))).toBe(true);
  } finally {
    rmSync(withoutPrefix, { recursive: true, force: true });
  }
});
