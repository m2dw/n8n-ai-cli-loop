/**
 * Tests for the dispatch-outbox CLI.
 *
 * All tests use a fake GhRunner injected via the exported `main()` function
 * (or via the CLI subprocess with a fake gh binary) — no real GitHub access.
 */
import { execFileSync } from 'child_process';
import { generateKeyPairSync } from 'crypto';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SqliteOutboxStore } from '../dist/stores/sqlite-outbox-store.js';
import { SqliteContextStore } from '../dist/index.js';
import { SqliteMaintenanceLock } from '../dist/stores/sqlite-maintenance-lock.js';
import { main } from '../dist/cli/dispatch-outbox.js';

const CLI = new URL('../dist/cli/dispatch-outbox.js', import.meta.url).pathname;

// A real RSA key so the github-app JWT signing path runs before the (mocked)
// installation-token exchange — letting tests drive the exchange transport.
const { privateKey: APP_PRIVATE_KEY } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const SESSION = {
  sessionId: 'addon-dev',
  repoKey: 'test-repo',
  repoRoot: '/tmp/test-repo',
  githubRepo: 'org/repo',
  artifactDir: '.artifacts',
  defaults: { implementationAgent: 'claude', reviewAgent: 'codex' },
  verification: {},
  labels: { active: 'ai:active', blocked: 'ai:blocked', readyForHuman: 'ai:ready-for-human' },
};

let tmpDir;
let sessionsPath;
let dbPath;

function runCli(...args) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      encoding: 'utf8',
    });
    return { code: 0, stdout };
  } catch (err) {
    return { code: err.status ?? 1, stdout: err.stdout ?? '' };
  }
}

// Like runCli, but with extra env vars merged onto process.env for the child —
// used to supply env-referenced GitHub App credentials to the subprocess.
function runCliWithEnv(extraEnv, ...args) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      encoding: 'utf8',
      env: { ...process.env, ...extraEnv },
    });
    return { code: 0, stdout };
  } catch (err) {
    return { code: err.status ?? 1, stdout: err.stdout ?? '' };
  }
}

function parseOutput(result) {
  return JSON.parse(result.stdout.trim());
}

function okRunner() {
  return { run: () => ({ exitCode: 0, stdout: '', stderr: '' }) };
}

function failRunner(stderr = 'server error') {
  return { run: () => ({ exitCode: 1, stdout: '', stderr }) };
}

const COMMENT_PAYLOAD = {
  topic: 'gh:comment',
  owner: 'org',
  repo: 'repo',
  issueNumber: 1,
  body: 'test',
};

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'dispatch-outbox-test-'));
  sessionsPath = join(tmpDir, 'sessions.json');
  dbPath = join(tmpDir, 'test.db');
  // Use tmpDir as repoRoot so cwd validation passes (tmpDir always exists).
  const session = { ...SESSION, repoRoot: tmpDir };
  writeFileSync(sessionsPath, JSON.stringify({ sessions: [session] }), 'utf8');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Arg validation (subprocess)
// ---------------------------------------------------------------------------

describe('dispatch-outbox CLI arg validation', () => {
  test('invalid --limit exits 1', () => {
    const r = runCli('--db-path', dbPath, '--limit', 'abc');
    expect(r.code).toBe(1);
    expect(parseOutput(r)).toMatchObject({ ok: false, error: expect.stringContaining('--limit') });
  });

  test('--limit 0 exits 1', () => {
    const r = runCli('--db-path', dbPath, '--limit', '0');
    expect(r.code).toBe(1);
    expect(parseOutput(r)).toMatchObject({ ok: false });
  });

  test('negative --limit exits 1', () => {
    const r = runCli('--db-path', dbPath, '--limit', '-5');
    expect(r.code).toBe(1);
    expect(parseOutput(r)).toMatchObject({ ok: false });
  });

  test('unknown --session-id exits 1', () => {
    const r = runCli('--db-path', dbPath, '--sessions-path', sessionsPath, '--session-id', 'no-such-session');
    expect(r.code).toBe(1);
    expect(parseOutput(r)).toMatchObject({ ok: false, error: expect.stringContaining('no-such-session') });
  });

  test('missing sessions file with --session-id exits 1', () => {
    const r = runCli(
      '--db-path', dbPath,
      '--sessions-path', join(tmpDir, 'nonexistent.json'),
      '--session-id', 'addon-dev',
    );
    expect(r.code).toBe(1);
    expect(parseOutput(r)).toMatchObject({ ok: false });
  });

  test('non-existent --cwd exits 1', () => {
    const r = runCli(
      '--db-path', dbPath,
      '--cwd', join(tmpDir, 'no-such-dir'),
    );
    expect(r.code).toBe(1);
    expect(parseOutput(r)).toMatchObject({ ok: false, error: expect.stringContaining('--cwd') });
  });

  test('--cwd that is a file (not a directory) exits 1', () => {
    // dbPath is a file, not a directory
    const store = new SqliteOutboxStore(dbPath);
    store.close();
    const r = runCli('--db-path', dbPath, '--cwd', dbPath);
    expect(r.code).toBe(1);
    expect(parseOutput(r)).toMatchObject({ ok: false, error: expect.stringContaining('not a directory') });
  });

  test('session.repoRoot that does not exist exits 1 (setup error, not retry)', () => {
    // Use an explicit nonexistent path to be certain.
    const badSession = { ...SESSION, sessionId: 'bad-repo', repoRoot: join(tmpDir, 'no-repo') };
    writeFileSync(sessionsPath, JSON.stringify({ sessions: [badSession] }), 'utf8');

    const r = runCli(
      '--db-path', dbPath,
      '--sessions-path', sessionsPath,
      '--session-id', 'bad-repo',
    );
    expect(r.code).toBe(1);
    expect(parseOutput(r)).toMatchObject({ ok: false, error: expect.stringContaining('session.repoRoot') });
  });
});

// ---------------------------------------------------------------------------
// Empty outbox (injected runner via main())
// ---------------------------------------------------------------------------

describe('dispatch-outbox — empty outbox', () => {
  test('exits 0 with dispatched:0 when outbox is empty', async () => {
    // Initialize DB so store opens clean
    const store = new SqliteOutboxStore(dbPath);
    store.close();

    let result;
    const capturedOutput = await captureMainOutput(async () => {
      await main(['--db-path', dbPath], okRunner());
    });

    const out = JSON.parse(capturedOutput);
    expect(out).toMatchObject({ ok: true, dispatched: 0, failed: 0, errors: [] });
  });

  test('github-app session with an empty outbox exits 0 without resolving App auth (issue #217)', async () => {
    // A github-app work-item session whose credential env vars are intentionally
    // unset: resolving the App runner here would throw "environment variable is
    // not set" and exit 1. The dispatcher must defer that resolution until there
    // is pending work, so an empty outbox still exits 0 with no GitHub side effect.
    const appSession = {
      ...SESSION,
      repoRoot: tmpDir,
      workItemProvider: {
        provider: 'github-issues',
        auth: {
          mode: 'github-app',
          appIdEnv: 'DISPATCH_TEST_UNSET_APP_ID',
          installationIdEnv: 'DISPATCH_TEST_UNSET_INSTALL_ID',
          privateKeyPathEnv: 'DISPATCH_TEST_UNSET_KEY_PATH',
        },
      },
    };
    writeFileSync(sessionsPath, JSON.stringify({ sessions: [appSession] }), 'utf8');

    const store = new SqliteOutboxStore(dbPath);
    store.close();

    const capturedOutput = await captureMainOutput(async () => {
      await main(
        ['--db-path', dbPath, '--sessions-path', sessionsPath, '--session-id', 'addon-dev'],
        okRunner(),
      );
    });

    const out = JSON.parse(capturedOutput);
    expect(out).toMatchObject({ ok: true, dispatched: 0, failed: 0, errors: [] });
  });
});

// ---------------------------------------------------------------------------
// Successful dispatch (injected runner)
// ---------------------------------------------------------------------------

describe('dispatch-outbox — successful dispatch', () => {
  test('dispatches pending comment and reports dispatched:1', async () => {
    const store = new SqliteOutboxStore(dbPath);
    await store.enqueue({ idempotencyKey: 'k1', topic: 'gh:comment', payload: COMMENT_PAYLOAD });
    store.close();

    const capturedOutput = await captureMainOutput(async () => {
      await main(['--db-path', dbPath], okRunner());
    });
    const out = JSON.parse(capturedOutput);
    expect(out).toMatchObject({ ok: true, dispatched: 1, failed: 0, errors: [] });

    // Entry is now marked sent
    const store2 = new SqliteOutboxStore(dbPath);
    const pending = await store2.listPending();
    store2.close();
    expect(pending).toHaveLength(0);
  });

  test('dispatches multiple entries', async () => {
    const store = new SqliteOutboxStore(dbPath);
    await store.enqueue({ idempotencyKey: 'k1', topic: 'gh:comment', payload: COMMENT_PAYLOAD });
    await store.enqueue({ idempotencyKey: 'k2', topic: 'gh:label:add', payload: { topic: 'gh:label:add', owner: 'o', repo: 'r', issueNumber: 1, label: 'ai:active' } });
    store.close();

    const capturedOutput = await captureMainOutput(async () => {
      await main(['--db-path', dbPath], okRunner());
    });
    const out = JSON.parse(capturedOutput);
    expect(out).toMatchObject({ ok: true, dispatched: 2, failed: 0 });
  });

  test('--limit caps how many entries are dispatched', async () => {
    const store = new SqliteOutboxStore(dbPath);
    for (let i = 0; i < 5; i++) {
      await store.enqueue({ idempotencyKey: `k${i}`, topic: 'gh:comment', payload: COMMENT_PAYLOAD });
    }
    store.close();

    const capturedOutput = await captureMainOutput(async () => {
      await main(['--db-path', dbPath, '--limit', '2'], okRunner());
    });
    const out = JSON.parse(capturedOutput);
    expect(out.dispatched).toBe(2);

    const store2 = new SqliteOutboxStore(dbPath);
    expect(await store2.listPending()).toHaveLength(3);
    store2.close();
  });

  test('--session-id included in output when provided', async () => {
    const store = new SqliteOutboxStore(dbPath);
    store.close();

    const capturedOutput = await captureMainOutput(async () => {
      await main(
        ['--db-path', dbPath, '--sessions-path', sessionsPath, '--session-id', 'addon-dev'],
        okRunner(),
      );
    });
    const out = JSON.parse(capturedOutput);
    expect(out.sessionId).toBe('addon-dev');
  });
});

// ---------------------------------------------------------------------------
// Maintenance-lock contention — an expected idle outcome (issue #818)
// ---------------------------------------------------------------------------

describe('dispatch-outbox — maintenance lock', () => {
  // Seed one pending row and take the maintenance lock. The lock handle is
  // returned so the caller can release it inside its own try/finally — an
  // assertion failure must never leave a lock row (or an open connection)
  // behind for the rest of the suite.
  async function seedPendingRowAndLock() {
    const store = new SqliteOutboxStore(dbPath);
    await store.enqueue({ idempotencyKey: 'k1', topic: 'gh:comment', payload: COMMENT_PAYLOAD });
    store.close();

    const lock = new SqliteMaintenanceLock(dbPath);
    const acquired = lock.acquire('prune:1234', '2026-01-01T00:00:00.000Z');
    return { lock, acquired };
  }

  test('reports maintenance_locked without any side effect, and resumes once released', async () => {
    const { lock, acquired } = await seedPendingRowAndLock();

    // A runner that would fail the test if it were ever invoked: maintenance
    // contention must fail closed *before* any external side effect.
    let ran = false;
    const forbiddenRunner = {
      run: () => {
        ran = true;
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    };

    let capturedOutput;
    try {
      expect(acquired).toEqual({ ok: true });
      capturedOutput = await captureMainOutput(async () => {
        await main(['--db-path', dbPath, '--sessions-path', sessionsPath, '--session-id', 'addon-dev'], forbiddenRunner);
      });
    } finally {
      lock.release();
      lock.close();
    }

    const out = JSON.parse(capturedOutput);
    expect(out).toMatchObject({
      ok: true,
      outcome: 'maintenance_locked',
      dispatched: 0,
      failed: 0,
      errors: [],
      deadLettered: 0,
      sessionId: 'addon-dev',
    });
    expect(ran).toBe(false);

    // Releasing the lock restores normal processing of the very same row.
    const store2 = new SqliteOutboxStore(dbPath);
    expect(await store2.listPending()).toHaveLength(1);
    store2.close();

    const afterOutput = await captureMainOutput(async () => {
      await main(['--db-path', dbPath, '--sessions-path', sessionsPath, '--session-id', 'addon-dev'], okRunner());
    });
    const after = JSON.parse(afterOutput);
    expect(after).toMatchObject({ ok: true, dispatched: 1, failed: 0 });
    expect(after.outcome).toBeUndefined();
  });

  // Split from the test above and given an explicit timeout because it spawns a
  // real CLI process: the repo runs on jest's 5s default (no `testTimeout` in
  // package.json), which a subprocess start-up can exceed on a loaded machine.
  // Same convention as test/gh-dispatcher.test.js and the antigravity suites.
  test('exits 0 as a real process while the lock is held', async () => {
    const { lock, acquired } = await seedPendingRowAndLock();

    let subprocess;
    try {
      expect(acquired).toEqual({ ok: true });
      // Safe to use the default `gh` runner here precisely because the
      // dispatcher must not reach it while the lock is held.
      subprocess = runCli('--db-path', dbPath, '--sessions-path', sessionsPath, '--session-id', 'addon-dev');
    } finally {
      lock.release();
      lock.close();
    }

    // Contention is an expected idle outcome, not a process failure.
    expect(subprocess.code).toBe(0);
    expect(JSON.parse(subprocess.stdout.trim())).toMatchObject({ ok: true, outcome: 'maintenance_locked' });

    // Nothing was claimed or dispatched: the row is untouched and still pending.
    const store = new SqliteOutboxStore(dbPath);
    expect(await store.listPending()).toHaveLength(1);
    store.close();
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Partial / full failure — failures stay retryable, exit 0
// ---------------------------------------------------------------------------

describe('dispatch-outbox — GitHub dispatch failures are retryable', () => {
  test('failed dispatch exits 0 with failed:1 and entry still pending', async () => {
    const store = new SqliteOutboxStore(dbPath);
    await store.enqueue({ idempotencyKey: 'k1', topic: 'gh:comment', payload: COMMENT_PAYLOAD });
    store.close();

    const capturedOutput = await captureMainOutput(async () => {
      await main(['--db-path', dbPath], failRunner('503 service unavailable'));
    });
    const out = JSON.parse(capturedOutput);
    // Exit 0 (retryable failure is not a setup error)
    expect(out).toMatchObject({ ok: true, dispatched: 0, failed: 1 });
    expect(out.errors).toHaveLength(1);
    expect(out.errors[0].error).toContain('exit 1');

    // Entry remains pending
    const store2 = new SqliteOutboxStore(dbPath);
    expect(await store2.listPending()).toHaveLength(1);
    store2.close();
  });

  test('partial failure: some sent, some retryable', async () => {
    const store = new SqliteOutboxStore(dbPath);
    await store.enqueue({ idempotencyKey: 'k1', topic: 'gh:comment', payload: COMMENT_PAYLOAD });
    await store.enqueue({ idempotencyKey: 'k2', topic: 'gh:comment', payload: { ...COMMENT_PAYLOAD, body: 'b2' } });
    store.close();

    let callIdx = 0;
    const partialRunner = {
      run: () => callIdx++ === 0
        ? { exitCode: 0, stdout: '', stderr: '' }
        : { exitCode: 1, stdout: '', stderr: 'rate limited' },
    };

    const capturedOutput = await captureMainOutput(async () => {
      await main(['--db-path', dbPath], partialRunner);
    });
    const out = JSON.parse(capturedOutput);
    expect(out).toMatchObject({ ok: true, dispatched: 1, failed: 1 });

    const store2 = new SqliteOutboxStore(dbPath);
    expect(await store2.listPending()).toHaveLength(1);
    store2.close();
  });

  test('github-app token-exchange failure stays retryable: exits 0, entry pending (issue #217)', async () => {
    // A github-app session with pending rows whose installation-token exchange
    // fails transiently (network error / GitHub 5xx). This must NOT die() with a
    // setup/phase failure: dispatchOutbox should report it as a per-entry retryable
    // failure and exit 0 with failed/errors, leaving the row pending.
    const appSession = {
      ...SESSION,
      repoRoot: tmpDir,
      workItemProvider: {
        provider: 'github-issues',
        auth: {
          mode: 'github-app',
          appIdEnv: 'DISPATCH_TEST_APP_ID',
          installationIdEnv: 'DISPATCH_TEST_INSTALL_ID',
          privateKeyPathEnv: 'DISPATCH_TEST_KEY_PATH',
        },
      },
    };
    writeFileSync(sessionsPath, JSON.stringify({ sessions: [appSession] }), 'utf8');

    const store = new SqliteOutboxStore(dbPath);
    await store.enqueue({ idempotencyKey: 'k1', topic: 'gh:comment', payload: COMMENT_PAYLOAD });
    store.close();

    // Inject valid credentials but a transport that fails the token exchange.
    const authDeps = {
      env: {
        DISPATCH_TEST_APP_ID: '123456',
        DISPATCH_TEST_INSTALL_ID: '78901234',
        DISPATCH_TEST_KEY_PATH: '/fake/key.pem',
      },
      readFile: () => APP_PRIVATE_KEY,
      httpPostJson: async () => {
        throw new Error('ECONNRESET: connection reset by peer');
      },
    };

    const capturedOutput = await captureMainOutput(async () => {
      await main(
        ['--db-path', dbPath, '--sessions-path', sessionsPath, '--session-id', 'addon-dev'],
        okRunner(),
        authDeps,
      );
    });
    const out = JSON.parse(capturedOutput);
    // Exit 0 (retryable), not a setup error.
    expect(out).toMatchObject({ ok: true, dispatched: 0, failed: 1 });
    expect(out.errors).toHaveLength(1);
    expect(out.errors[0].error).toContain('GitHub App auth resolution failed');

    // Entry remains pending for the next drain.
    const store2 = new SqliteOutboxStore(dbPath);
    expect(await store2.listPending()).toHaveLength(1);
    store2.close();
  });
});

// ---------------------------------------------------------------------------
// Repo-host PR comments preserve App auth for migrated single-auth sessions
// (issue #361). A session that configured GitHub App auth only under
// workItemProvider and omitted repoHostProvider must keep posting PR comments
// under the App identity — not regress to the defaulted operator `gh`.
// ---------------------------------------------------------------------------

describe('dispatch-outbox — repohost:pr-comment preserves work-item App auth (issue #361)', () => {
  test('App-only work-item session dispatches a repohost:pr-comment row under the App runner, not operator gh', async () => {
    // App auth configured only under workItemProvider; repoHostProvider omitted,
    // so the registry defaults it to github/`gh`. Before the fix, the repo-host PR
    // comment dispatched under the operator `gh` runner (okRunner here) and would
    // have succeeded. The fix routes it through the work-item App runner instead.
    // A failing token exchange makes that routing observable: hitting the App path
    // surfaces a retryable "GitHub App auth resolution failed" per-entry error,
    // whereas the operator `gh` fallback (okRunner) would have reported dispatched:1.
    const appSession = {
      ...SESSION,
      repoRoot: tmpDir,
      workItemProvider: {
        provider: 'github-issues',
        auth: {
          mode: 'github-app',
          appIdEnv: 'DISPATCH_TEST_APP_ID',
          installationIdEnv: 'DISPATCH_TEST_INSTALL_ID',
          privateKeyPathEnv: 'DISPATCH_TEST_KEY_PATH',
        },
      },
      // repoHostProvider intentionally omitted (the migrated single-auth shape).
    };
    writeFileSync(sessionsPath, JSON.stringify({ sessions: [appSession] }), 'utf8');

    const store = new SqliteOutboxStore(dbPath);
    await store.enqueue({
      idempotencyKey: 'pr1',
      topic: 'repohost:pr-comment',
      payload: { topic: 'repohost:pr-comment', provider: 'github', owner: 'org', repo: 'repo', prNumber: 42, body: 'review passed' },
    });
    store.close();

    const authDeps = {
      env: {
        DISPATCH_TEST_APP_ID: '123456',
        DISPATCH_TEST_INSTALL_ID: '78901234',
        DISPATCH_TEST_KEY_PATH: '/fake/key.pem',
      },
      readFile: () => APP_PRIVATE_KEY,
      httpPostJson: async () => {
        throw new Error('ECONNRESET: connection reset by peer');
      },
    };

    const capturedOutput = await captureMainOutput(async () => {
      await main(
        ['--db-path', dbPath, '--sessions-path', sessionsPath, '--session-id', 'addon-dev'],
        okRunner(),
        authDeps,
      );
    });
    const out = JSON.parse(capturedOutput);
    // The App runner was selected for the repo-host row: its (failing) token
    // exchange is reported as a retryable per-entry failure, not a clean send.
    expect(out).toMatchObject({ ok: true, dispatched: 0, failed: 1 });
    expect(out.errors).toHaveLength(1);
    expect(out.errors[0].error).toContain('GitHub App auth resolution failed');

    // The row remains pending for the next drain (never sent under the wrong actor).
    const store2 = new SqliteOutboxStore(dbPath);
    expect(await store2.listPending()).toHaveLength(1);
    store2.close();
  });

  test('explicit github-app repoHostProvider dispatches repo-host rows under its own App runner, not the work-item gh runner', async () => {
    // The split-auth case the registry CAN distinguish from the omitted default:
    // an EXPLICIT repoHostProvider with App auth while work items stay on operator
    // `gh`. Repo-host PR comments must use the repo-host App identity and never
    // borrow the work-item `gh` runner. A failing App token exchange makes the App
    // path observable: reaching it surfaces a retryable resolution error, whereas
    // the operator `gh` work-item runner (okRunner) would have reported dispatched:1.
    const splitSession = {
      ...SESSION,
      repoRoot: tmpDir,
      workItemProvider: { provider: 'github-issues', auth: { mode: 'gh' } },
      repoHostProvider: {
        provider: 'github',
        auth: {
          mode: 'github-app',
          appIdEnv: 'DISPATCH_TEST_APP_ID',
          installationIdEnv: 'DISPATCH_TEST_INSTALL_ID',
          privateKeyPathEnv: 'DISPATCH_TEST_KEY_PATH',
        },
      },
    };
    writeFileSync(sessionsPath, JSON.stringify({ sessions: [splitSession] }), 'utf8');

    const store = new SqliteOutboxStore(dbPath);
    await store.enqueue({
      idempotencyKey: 'pr1',
      topic: 'repohost:pr-comment',
      payload: { topic: 'repohost:pr-comment', provider: 'github', owner: 'org', repo: 'repo', prNumber: 42, body: 'review passed' },
    });
    store.close();

    const authDeps = {
      env: {
        DISPATCH_TEST_APP_ID: '123456',
        DISPATCH_TEST_INSTALL_ID: '78901234',
        DISPATCH_TEST_KEY_PATH: '/fake/key.pem',
      },
      readFile: () => APP_PRIVATE_KEY,
      httpPostJson: async () => {
        throw new Error('ECONNRESET: connection reset by peer');
      },
    };

    const capturedOutput = await captureMainOutput(async () => {
      await main(
        ['--db-path', dbPath, '--sessions-path', sessionsPath, '--session-id', 'addon-dev'],
        okRunner(),
        authDeps,
      );
    });
    const out = JSON.parse(capturedOutput);
    // The explicit repo-host App runner was selected (and its token exchange failed
    // retryably); the work-item `gh` runner was never used for the repo-host row.
    expect(out).toMatchObject({ ok: true, dispatched: 0, failed: 1 });
    expect(out.errors[0].error).toContain('GitHub App auth resolution failed');

    const store2 = new SqliteOutboxStore(dbPath);
    expect(await store2.listPending()).toHaveLength(1);
    store2.close();
  });

  test('explicit github/gh repoHostProvider routes repo-host rows under operator gh, not the work-item App runner', async () => {
    // The split-auth case a value-only comparison gets WRONG: the operator sets an
    // EXPLICIT repoHostProvider of `{ provider: "github", auth: { mode: "gh" } }`
    // while work items use GitHub App auth. The explicit config is byte-identical
    // to the registry default, so the old shape heuristic treated it as "omitted"
    // and fell the repo-host row back to the work-item App runner — posting the PR
    // comment as the wrong actor. With the explicit-config flag the repo-host row
    // must dispatch under the operator `gh` runner (okRunner) instead. okRunner
    // succeeds, so a correctly-routed run reports dispatched:1; the App runner's
    // failing token exchange (below) would instead surface a retryable failure.
    const splitSession = {
      ...SESSION,
      repoRoot: tmpDir,
      workItemProvider: {
        provider: 'github-issues',
        auth: {
          mode: 'github-app',
          appIdEnv: 'DISPATCH_TEST_APP_ID',
          installationIdEnv: 'DISPATCH_TEST_INSTALL_ID',
          privateKeyPathEnv: 'DISPATCH_TEST_KEY_PATH',
        },
      },
      // Explicit github/`gh` repo-host config — byte-equal to the registry default.
      repoHostProvider: { provider: 'github', auth: { mode: 'gh' } },
    };
    writeFileSync(sessionsPath, JSON.stringify({ sessions: [splitSession] }), 'utf8');

    const store = new SqliteOutboxStore(dbPath);
    await store.enqueue({
      idempotencyKey: 'pr1',
      topic: 'repohost:pr-comment',
      payload: { topic: 'repohost:pr-comment', provider: 'github', owner: 'org', repo: 'repo', prNumber: 42, body: 'review passed' },
    });
    store.close();

    const authDeps = {
      env: {
        DISPATCH_TEST_APP_ID: '123456',
        DISPATCH_TEST_INSTALL_ID: '78901234',
        DISPATCH_TEST_KEY_PATH: '/fake/key.pem',
      },
      readFile: () => APP_PRIVATE_KEY,
      // The work-item App token exchange fails; if the repo-host row wrongly
      // borrowed the App runner this would make the failure observable.
      httpPostJson: async () => {
        throw new Error('ECONNRESET: connection reset by peer');
      },
    };

    const capturedOutput = await captureMainOutput(async () => {
      await main(
        ['--db-path', dbPath, '--sessions-path', sessionsPath, '--session-id', 'addon-dev'],
        okRunner(),
        authDeps,
      );
    });
    const out = JSON.parse(capturedOutput);
    // Routed under operator `gh` (okRunner): the PR comment dispatched cleanly and
    // the work-item App runner was never touched for the repo-host row.
    expect(out).toMatchObject({ ok: true, dispatched: 1, failed: 0, errors: [] });

    const store2 = new SqliteOutboxStore(dbPath);
    expect(await store2.listPending()).toHaveLength(0);
    store2.close();
  });

  test('non-GitHub work-item session with a defaulted repo host dispatches repohost:pr-comment under operator gh, not the failing work-item resolver', async () => {
    // Regression: the session's work items live on a non-GitHub provider (`jira`)
    // but repoHostProvider is omitted, so the registry defaults it to github/`gh`.
    // The work-item resolver short-circuits to a FAILING runner for `jira`, so
    // falling the repo-host row back to it (the single-auth fallback) would leave
    // the GitHub PR comment pending forever with `Unsupported work-item provider`,
    // under the wrong auth domain. Because the work-item provider is non-GitHub the
    // fix instead gives repo-host rows their own runner from the defaulted github/
    // `gh` config: okRunner dispatches the public PR comment cleanly.
    const jiraSession = {
      ...SESSION,
      repoRoot: tmpDir,
      workItemProvider: {
        provider: 'jira',
        auth: { mode: 'api-token', tokenEnv: 'DISPATCH_TEST_UNSET_TOKEN' },
      },
      // repoHostProvider intentionally omitted -> registry default github/`gh`.
    };
    writeFileSync(sessionsPath, JSON.stringify({ sessions: [jiraSession] }), 'utf8');

    const store = new SqliteOutboxStore(dbPath);
    await store.enqueue({
      idempotencyKey: 'pr1',
      topic: 'repohost:pr-comment',
      payload: { topic: 'repohost:pr-comment', provider: 'github', owner: 'org', repo: 'repo', prNumber: 42, body: 'review passed' },
    });
    store.close();

    const out = JSON.parse(await captureMainOutput(async () => {
      await main(
        ['--db-path', dbPath, '--sessions-path', sessionsPath, '--session-id', 'addon-dev'],
        okRunner(),
      );
    }));
    // Routed under operator `gh` (okRunner): the PR comment dispatched cleanly and
    // never surfaced the jira work-item resolver's unsupported-provider failure.
    expect(out).toMatchObject({ ok: true, dispatched: 1, failed: 0, errors: [] });

    const store2 = new SqliteOutboxStore(dbPath);
    expect(await store2.listPending()).toHaveLength(0);
    store2.close();
  });
});

// ---------------------------------------------------------------------------
// A `gitea` repo host resolves its API token lazily while building its REST
// client inside the provider factory. When the configured token env var is unset
// that build throws synchronously mid-dispatch. The dispatcher must convert it
// into a deterministic per-entry failure (not abort with an uncaught stack trace
// after dispatching earlier rows), keeping the single-JSON / exit-0 contract.
// ---------------------------------------------------------------------------

describe('dispatch-outbox — gitea repo-host token errors are reported deterministically (issue #365)', () => {
  const giteaSession = () => ({
    ...SESSION,
    repoRoot: tmpDir,
    repoHostProvider: {
      provider: 'gitea',
      gitea: { baseUrl: 'https://gitea.example.com', owner: 'acme', repo: 'code' },
      // tokenEnv points at a guaranteed-unset variable, so the client builder
      // throws "environment variable ... is not set" when the row is dispatched.
      auth: { mode: 'api-token', tokenEnv: 'DISPATCH_TEST_UNSET_TOKEN' },
    },
  });

  test('pending repohost:pr-comment with an unset token env var exits 0 with a retryable per-entry failure, row stays pending', async () => {
    writeFileSync(sessionsPath, JSON.stringify({ sessions: [giteaSession()] }), 'utf8');

    const store = new SqliteOutboxStore(dbPath);
    await store.enqueue({
      idempotencyKey: 'pr1',
      // The row carries the session's GitHub owner/repo for scoping/identity; the
      // PR itself lives in the Gitea repo addressed by the connection block.
      topic: 'repohost:pr-comment',
      payload: { topic: 'repohost:pr-comment', provider: 'gitea', owner: 'org', repo: 'repo', prNumber: 42, body: 'review passed' },
    });
    store.close();

    const out = JSON.parse(await captureMainOutput(async () => {
      await main(
        ['--db-path', dbPath, '--sessions-path', sessionsPath, '--session-id', 'addon-dev'],
        okRunner(),
      );
    }));
    // The token-resolution throw is caught and reported as a retryable per-entry
    // failure rather than aborting the CLI: ok stays true, exit code is 0.
    expect(out).toMatchObject({ ok: true, dispatched: 0, failed: 1 });
    expect(out.errors).toHaveLength(1);
    expect(out.errors[0].error).toContain('DISPATCH_TEST_UNSET_TOKEN');

    // The row is never marked sent, so it drains once the operator sets the token.
    const store2 = new SqliteOutboxStore(dbPath);
    expect(await store2.listPending()).toHaveLength(1);
    store2.close();
  });

  test('a successful earlier row is still dispatched and counted when a later gitea row throws on its token', async () => {
    writeFileSync(sessionsPath, JSON.stringify({ sessions: [giteaSession()] }), 'utf8');

    const store = new SqliteOutboxStore(dbPath);
    // A work-item issue comment dispatched under the operator `gh` runner (okRunner)
    // is enqueued FIRST, ahead of the failing gitea repo-host row. Before the fix,
    // the gitea row's uncaught throw aborted the drain and discarded this row's
    // dispatched count; the per-entry conversion preserves it.
    await store.enqueue({
      idempotencyKey: 'issue1',
      topic: 'gh:comment',
      payload: { ...COMMENT_PAYLOAD, issueNumber: 7, body: 'first' },
    });
    await store.enqueue({
      idempotencyKey: 'pr1',
      topic: 'repohost:pr-comment',
      payload: { topic: 'repohost:pr-comment', provider: 'gitea', owner: 'org', repo: 'repo', prNumber: 42, body: 'review passed' },
    });
    store.close();

    const out = JSON.parse(await captureMainOutput(async () => {
      await main(
        ['--db-path', dbPath, '--sessions-path', sessionsPath, '--session-id', 'addon-dev'],
        okRunner(),
      );
    }));
    // The earlier work-item row dispatched; only the gitea repo-host row failed.
    expect(out).toMatchObject({ ok: true, dispatched: 1, failed: 1 });
    expect(out.errors).toHaveLength(1);
    expect(out.errors[0].error).toContain('DISPATCH_TEST_UNSET_TOKEN');

    // Only the failing gitea row remains pending; the dispatched row was marked sent.
    const store2 = new SqliteOutboxStore(dbPath);
    const pending = await store2.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0].payload.topic).toBe('repohost:pr-comment');
    store2.close();
  });
});

// ---------------------------------------------------------------------------
// Invalid auth configuration is a fatal setup error, NOT a retryable dispatch
// failure — pending rows with a broken auth config must surface the misconfig
// (exit 1) instead of being silently downgraded to per-entry retries (issue #217)
// ---------------------------------------------------------------------------

describe('dispatch-outbox — invalid auth config is a fatal setup error (issue #217)', () => {
  test('github-app session with an unset appIdEnv and pending rows exits 1, rows stay pending', async () => {
    // Pending work exists, but the App credential env vars are unset: resolving
    // the runner throws a permanent configuration error. That must NOT be
    // downgraded to a retryable per-entry failure (which would leave the rows
    // pending forever while the CLI reports a normal run) — it must exit 1.
    const appSession = {
      ...SESSION,
      repoRoot: tmpDir,
      workItemProvider: {
        provider: 'github-issues',
        auth: {
          mode: 'github-app',
          appIdEnv: 'DISPATCH_TEST_DEFINITELY_UNSET_APP_ID',
          installationIdEnv: 'DISPATCH_TEST_DEFINITELY_UNSET_INSTALL_ID',
          privateKeyPathEnv: 'DISPATCH_TEST_DEFINITELY_UNSET_KEY_PATH',
        },
      },
    };
    writeFileSync(sessionsPath, JSON.stringify({ sessions: [appSession] }), 'utf8');

    const store = new SqliteOutboxStore(dbPath);
    await store.enqueue({ idempotencyKey: 'k1', topic: 'gh:comment', payload: COMMENT_PAYLOAD });
    store.close();

    // Subprocess (not in-process main) because a fatal setup error calls
    // process.exit(1), which would terminate the test runner in-process.
    const r = runCli('--db-path', dbPath, '--sessions-path', sessionsPath, '--session-id', 'addon-dev');
    expect(r.code).toBe(1);
    const out = JSON.parse(r.stdout.trim());
    expect(out.ok).toBe(false);
    expect(out.error).toContain('GitHub App auth');

    // The row is untouched — it stays pending for a run with a fixed config.
    const store2 = new SqliteOutboxStore(dbPath);
    expect(await store2.listPending()).toHaveLength(1);
    store2.close();
  });

  test('api-token auth on a GitHub provider with pending rows exits 1, rows stay pending', async () => {
    // `api-token` is unsupported for the GitHub provider layer: a permanent
    // configuration error, not a transient dispatch failure.
    const apiTokenSession = {
      ...SESSION,
      repoRoot: tmpDir,
      workItemProvider: {
        provider: 'github-issues',
        auth: { mode: 'api-token', tokenEnv: 'DISPATCH_TEST_UNSET_TOKEN' },
      },
    };
    writeFileSync(sessionsPath, JSON.stringify({ sessions: [apiTokenSession] }), 'utf8');

    const store = new SqliteOutboxStore(dbPath);
    await store.enqueue({ idempotencyKey: 'k1', topic: 'gh:comment', payload: COMMENT_PAYLOAD });
    store.close();

    const r = runCli('--db-path', dbPath, '--sessions-path', sessionsPath, '--session-id', 'addon-dev');
    expect(r.code).toBe(1);
    const out = JSON.parse(r.stdout.trim());
    expect(out.ok).toBe(false);
    expect(out.error).toContain('Unsupported GitHub provider auth mode');

    const store2 = new SqliteOutboxStore(dbPath);
    expect(await store2.listPending()).toHaveLength(1);
    store2.close();
  });

  test('github-app session with a malformed private key and pending rows exits 1, rows stay pending', async () => {
    // Credentials are all *present* (env vars set, key file readable) but the PEM
    // is malformed, so JWT signing fails before any HTTP exchange. That is a
    // permanent setup error: it must exit 1 (not be downgraded to a retryable
    // per-entry failure that leaves the row pending while reporting a normal run).
    const badKeyPath = join(tmpDir, 'malformed.pem');
    writeFileSync(badKeyPath, '-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----\n', 'utf8');

    const appSession = {
      ...SESSION,
      repoRoot: tmpDir,
      workItemProvider: {
        provider: 'github-issues',
        auth: {
          mode: 'github-app',
          appIdEnv: 'DISPATCH_TEST_BADPEM_APP_ID',
          installationIdEnv: 'DISPATCH_TEST_BADPEM_INSTALL_ID',
          privateKeyPathEnv: 'DISPATCH_TEST_BADPEM_KEY_PATH',
        },
      },
    };
    writeFileSync(sessionsPath, JSON.stringify({ sessions: [appSession] }), 'utf8');

    const store = new SqliteOutboxStore(dbPath);
    await store.enqueue({ idempotencyKey: 'k1', topic: 'gh:comment', payload: COMMENT_PAYLOAD });
    store.close();

    // Subprocess so the env-var-referenced credentials resolve and the fatal
    // process.exit(1) does not terminate the test runner in-process.
    const r = runCliWithEnv(
      {
        DISPATCH_TEST_BADPEM_APP_ID: '123456',
        DISPATCH_TEST_BADPEM_INSTALL_ID: '78901234',
        DISPATCH_TEST_BADPEM_KEY_PATH: badKeyPath,
      },
      '--db-path', dbPath, '--sessions-path', sessionsPath, '--session-id', 'addon-dev',
    );
    expect(r.code).toBe(1);
    const out = JSON.parse(r.stdout.trim());
    expect(out.ok).toBe(false);
    expect(out.error).toContain('GitHub App auth');
    // The key content must never leak into the emitted error.
    expect(out.error).not.toContain('not-a-real-key');

    // The row is untouched — it stays pending for a run with a fixed key.
    const store2 = new SqliteOutboxStore(dbPath);
    expect(await store2.listPending()).toHaveLength(1);
    store2.close();
  });
});

// ---------------------------------------------------------------------------
// A recognized-but-unwired non-GitHub provider must NOT resolve GitHub auth.
// Its pending rows are a retryable per-entry failure (the row stays pending
// until the provider is implemented), NOT a fatal `api-token` setup error — the
// `api-token` mode that is unsupported for the GitHub layer never reaches the
// GitHub auth resolver for a non-GitHub provider kind.
// ---------------------------------------------------------------------------

describe('dispatch-outbox — unsupported non-GitHub provider stays retryable', () => {
  test('jira workItemProvider with api-token auth and a pending workitem row exits 0, row stays pending', async () => {
    // This session is configured for a non-GitHub work-item provider ("jira")
    // that is simply not wired yet. `api-token` is unsupported for the GitHub
    // provider layer, so resolving GitHub auth for this provider would wrongly
    // raise a fatal `Unsupported GitHub provider auth mode: api-token` setup
    // error (exit 1). Instead the dispatcher must report the unsupported
    // provider as a retryable per-entry failure and leave the row pending.
    const jiraSession = {
      ...SESSION,
      repoRoot: tmpDir,
      workItemProvider: {
        provider: 'jira',
        auth: { mode: 'api-token', tokenEnv: 'DISPATCH_TEST_UNSET_TOKEN' },
      },
    };
    writeFileSync(sessionsPath, JSON.stringify({ sessions: [jiraSession] }), 'utf8');

    const store = new SqliteOutboxStore(dbPath);
    await store.enqueue({
      idempotencyKey: 'wi-jira',
      topic: 'workitem:comment',
      payload: { topic: 'workitem:comment', provider: 'jira', owner: 'org', repo: 'repo', issueNumber: 1, body: 'test' },
    });
    store.close();

    // In-process (not a subprocess): the retryable path exits 0 without ever
    // calling process.exit, so it is safe to drive through main() directly.
    const out = JSON.parse(await captureMainOutput(async () => {
      await main(
        ['--db-path', dbPath, '--sessions-path', sessionsPath, '--session-id', 'addon-dev'],
        okRunner(),
      );
    }));
    expect(out).toMatchObject({ ok: true, dispatched: 0, failed: 1 });
    expect(out.errors[0].error).toContain('Unsupported work-item provider: jira');

    // The row stays pending so enabling the provider later drains it.
    const store2 = new SqliteOutboxStore(dbPath);
    expect(await store2.listPending()).toHaveLength(1);
    store2.close();
  });

  test('jira workItemProvider with a pending LEGACY gh:comment row exits 0, row stays pending, never dispatched to GitHub', async () => {
    // The phase code still enqueues legacy `gh:comment` / `gh:label:*` rows for
    // issue-side effects. For a non-GitHub work-item provider those legacy rows
    // bypass the provider factory (which only sees provider-neutral topics) and
    // would otherwise dispatch through the operator `gh` runner — leaking private
    // work-item side effects to the public GitHub repo under operator credentials.
    // The work-item resolver must instead hand back a failing runner so the legacy
    // row stays pending (retryable), matching the provider-neutral unsupported path.
    const jiraSession = {
      ...SESSION,
      repoRoot: tmpDir,
      workItemProvider: {
        provider: 'jira',
        auth: { mode: 'api-token', tokenEnv: 'DISPATCH_TEST_UNSET_TOKEN' },
      },
    };
    writeFileSync(sessionsPath, JSON.stringify({ sessions: [jiraSession] }), 'utf8');

    const store = new SqliteOutboxStore(dbPath);
    await store.enqueue({ idempotencyKey: 'legacy-gh', topic: 'gh:comment', payload: COMMENT_PAYLOAD });
    store.close();

    // A runner that throws if it is ever invoked: any attempt to dispatch this
    // non-GitHub work-item row under the operator credentials would surface as a
    // hard failure here rather than a silent leak to GitHub.
    const leakRunner = {
      run: () => {
        throw new Error('operator gh runner must never dispatch a non-GitHub work-item row');
      },
    };

    const out = JSON.parse(await captureMainOutput(async () => {
      await main(
        ['--db-path', dbPath, '--sessions-path', sessionsPath, '--session-id', 'addon-dev'],
        leakRunner,
      );
    }));
    expect(out).toMatchObject({ ok: true, dispatched: 0, failed: 1 });
    expect(out.errors[0].error).toContain('Unsupported work-item provider: jira');

    // The legacy row stays pending; it was never published to GitHub.
    const store2 = new SqliteOutboxStore(dbPath);
    expect(await store2.listPending()).toHaveLength(1);
    store2.close();
  });
});

// ---------------------------------------------------------------------------
// Session-scoped dispatch — a session only dispatches its own repo's rows
// ---------------------------------------------------------------------------

describe('dispatch-outbox — session scoping (issue #217)', () => {
  test('a resolved session only dispatches rows for its own repo; other-repo rows stay pending', async () => {
    // SESSION.githubRepo is 'org/repo'. Enqueue one row for that repo and one
    // for a different session's repo ('other/repo'). With --session-id resolved,
    // only the matching repo row should dispatch; the foreign row stays pending
    // (retryable) so it is never sent under this session's identity/runner.
    const store = new SqliteOutboxStore(dbPath);
    await store.enqueue({ idempotencyKey: 'k-mine', topic: 'gh:comment', payload: COMMENT_PAYLOAD });
    await store.enqueue({
      idempotencyKey: 'k-other',
      topic: 'gh:comment',
      payload: { ...COMMENT_PAYLOAD, owner: 'other', repo: 'repo', body: 'foreign' },
    });
    store.close();

    // Runner that fails on any foreign-repo comment so a leak would be visible.
    const runner = {
      run: (args) => {
        const joined = args.join(' ');
        if (joined.includes('other/repo')) {
          throw new Error('runner must never touch a foreign repo');
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    };

    const out = JSON.parse(await captureMainOutput(async () => {
      await main(
        ['--db-path', dbPath, '--sessions-path', sessionsPath, '--session-id', 'addon-dev'],
        runner,
      );
    }));
    expect(out).toMatchObject({ ok: true, dispatched: 1, failed: 0, errors: [] });

    // The foreign-repo row remains pending for its owning session's dispatch run.
    const store2 = new SqliteOutboxStore(dbPath);
    const pending = await store2.listPending();
    store2.close();
    expect(pending).toHaveLength(1);
    expect(pending[0].idempotencyKey).toBe('k-other');
  });
});

// ---------------------------------------------------------------------------
// Subprocess smoke test (real node process, fake gh binary)
// ---------------------------------------------------------------------------

describe('dispatch-outbox CLI subprocess', () => {
  test('exits 0 with empty outbox when no pending entries', () => {
    // Initialize DB first
    const store = new SqliteOutboxStore(dbPath);
    store.close();

    const r = runCli('--db-path', dbPath);
    expect(r.code).toBe(0);
    const out = parseOutput(r);
    expect(out).toMatchObject({ ok: true, dispatched: 0, failed: 0 });
  });

  test('exits 0 with dispatched entries using fake gh script', () => {
    // Write a fake gh binary that always succeeds
    const fakeGh = join(tmpDir, 'gh');
    writeFileSync(fakeGh, '#!/bin/sh\nexit 0\n', 'utf8');
    chmodSync(fakeGh, 0o755);

    // Enqueue an entry
    const store = new SqliteOutboxStore(dbPath);
    store.enqueue({ idempotencyKey: 'k1', topic: 'gh:comment', payload: COMMENT_PAYLOAD });
    store.close();

    // Override PATH so our fake gh is found first
    const r = (() => {
      try {
        const stdout = execFileSync(process.execPath, [CLI, '--db-path', dbPath], {
          encoding: 'utf8',
          env: { ...process.env, PATH: `${tmpDir}:${process.env.PATH}` },
        });
        return { code: 0, stdout };
      } catch (err) {
        return { code: err.status ?? 1, stdout: err.stdout ?? '' };
      }
    })();

    expect(r.code).toBe(0);
    const out = parseOutput(r);
    expect(out).toMatchObject({ ok: true, dispatched: 1, failed: 0 });
  });
});

describe('dispatch-outbox — contextId-only resolution', () => {
  test('--context-id resolves sessionId and includes contextId in output', async () => {
    // Pre-seed context store
    const ctxStore = new SqliteContextStore(dbPath);
    ctxStore.upsert('dispatch-ctx-1', 'addon-dev');
    ctxStore.close();

    const fakeRunner = { run: async () => ({ code: 0, stdout: '', stderr: '' }) };
    // --cwd no longer waives session loading: the session is still resolved so its
    // configured provider auth applies, so the sessions file must be findable.
    const out = JSON.parse(await captureMainOutput(() =>
      main(
        ['--context-id', 'dispatch-ctx-1', '--db-path', dbPath, '--cwd', tmpDir, '--sessions-path', sessionsPath],
        fakeRunner,
      ),
    ));
    expect(out).toMatchObject({ ok: true, contextId: 'dispatch-ctx-1', sessionId: 'addon-dev' });
  });

  test('unknown --context-id exits non-zero', () => {
    const r = runCli('--context-id', 'no-such-dispatch-ctx', '--db-path', dbPath);
    expect(r.code).not.toBe(0);
    expect(JSON.parse(r.stdout.trim())).toMatchObject({ ok: false, error: expect.stringContaining('no-such-dispatch-ctx') });
  });
});

// ---------------------------------------------------------------------------
// Helper: capture stdout from main()
// ---------------------------------------------------------------------------

async function captureMainOutput(fn) {
  const chunks = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  };
  try {
    await fn();
  } finally {
    process.stdout.write = original;
  }
  return chunks.join('').trim();
}
