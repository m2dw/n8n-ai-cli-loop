/**
 * Entry conditions of the ChatOps CLI entrypoints (issue #1024).
 *
 * `chatops-runtime.test.js` covers what one pass *does*; this file covers what
 * has to be true before a pass may start at all, which is where the surface
 * touches configuration it does not own:
 *
 *   - a session with ChatOps switched off must be a total no-op, including not
 *     creating the database (docs/chatops-operations.md §3, §8);
 *   - each supported work-item provider must be scanned through *its own*
 *     adapter — a `gitea-issues` session runs the identical pass over Gitea
 *     (#1032) and is never scanned through the GitHub adapter under its own
 *     owner/repo — and a provider with no comment port at all must fail closed;
 *   - the session's configured work-item credentials must be the ones used, so a
 *     `github-app` session never falls back to the ambient `gh` login and a
 *     `gitea-issues` session never runs without its configured API token;
 *   - `chatops-status` must stay strictly read-only, which for a session that has
 *     never run a pass means refusing rather than creating the database it was
 *     asked to describe (docs/chatops-operations.md §6);
 *   - a `prune`/`restore` maintenance lock must exclude every ChatOps write, and
 *     be reported as retryable rather than crashing the scheduled step (issue
 *     #818, docs/retention-backup-contract.md §9);
 *   - automatic work-item selection must stop at the terminal-task boundary, so
 *     a finished issue is not scanned — and commanded — for the life of the
 *     session merely because it once had ChatOps state;
 *   - a database whose shared `outbox` predates `idempotency_key` must be
 *     upgraded when this store opens it, because `chatops-scan` reaches the
 *     outbox without opening `SqliteTaskStore` or `SqliteOutboxStore` first.
 *
 * Everything runs in-process against the exported `main()` with the CLI's IO
 * sink rebound, so no `gh` subprocess and no GitHub or Gitea connection is
 * involved — the Gitea cases drive a fake synchronous HTTP transport. The
 * cases that resolve App auth drive the token exchange through an injected
 * transport and scan zero work items, so nothing ever reaches a spawn.
 */
import { generateKeyPairSync } from 'crypto';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import { main, selectRotatedIssues } from '../dist/cli/chatops-scan.js';
import { main as statusMain } from '../dist/cli/chatops-status.js';
import { SqliteChatOpsStore } from '../dist/stores/sqlite-chatops-store.js';
import { SqliteContextStore } from '../dist/stores/sqlite-context-store.js';
import { SqliteTaskStore } from '../dist/stores/sqlite-task-store.js';
import { seedMaintenanceLock } from '../dist/stores/sqlite-maintenance-lock.js';
import { applyChatOpsLedgerEvent } from '../dist/core/chatops-execution-ledger.js';
import { createOperationRegistry, operationExecuted } from '../dist/core/operation-port.js';
import { CliExit, resetCliIoSink, setCliIoSink } from '../dist/cli/cli-io.js';

// A real RSA key so the App JWT actually signs before the mocked token exchange.
const { privateKey: APP_PRIVATE_KEY } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const CHATOPS_ON = {
  enabled: true,
  authorAllowlist: ['alice'],
  automationLogins: ['demo-bot'],
};

let tmpDir;
let sessionsPath;
let dbPath;
let keyPath;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'chatops-scan-cli-'));
  sessionsPath = join(tmpDir, 'sessions.json');
  // Deliberately never created by the test: several cases assert the CLI did
  // not open (and therefore did not create) the database.
  dbPath = join(tmpDir, 'dev_loop.db');
  keyPath = join(tmpDir, 'app-key.pem');
  writeFileSync(keyPath, APP_PRIVATE_KEY, 'utf8');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeSession(overrides) {
  const session = {
    sessionId: 'chatops-cli',
    repoKey: 'demo',
    repoRoot: tmpDir,
    githubRepo: 'm2dw/demo',
    artifactDir: '.artifacts',
    defaults: { implementationAgent: 'claude', reviewAgent: 'codex' },
    verification: {},
    labels: { active: 'ai:active', blocked: 'ai:blocked', readyForHuman: 'ai:ready-for-human' },
    ...overrides,
  };
  writeFileSync(sessionsPath, JSON.stringify({ sessions: [session] }), 'utf8');
}

/** A `gh` executor that records its argv; several cases assert it stayed unused. */
function recordingRunner() {
  const runner = { calls: [], run(args) { runner.calls.push(args); return { exitCode: 0, stdout: '[]', stderr: '' }; } };
  return runner;
}

/** Mocked installation-token exchange (mirrors github-app-auth.test.js). */
function mockTokenExchange(responses) {
  const calls = [];
  let i = 0;
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    return responses[i++] ?? { status: 500, statusText: 'unexpected', body: '' };
  };
  fn.calls = calls;
  return fn;
}

const TOKEN_OK = {
  status: 201,
  statusText: 'Created',
  body: JSON.stringify({ token: 'ghs_installationtoken0000000000000000', expires_at: '2099-01-01T00:00:00Z' }),
};

async function runScan(args, deps = {}) {
  const stdout = [];
  const stderr = [];
  let exitCode;
  setCliIoSink({
    stdout: (chunk) => stdout.push(chunk),
    stderr: (chunk) => stderr.push(chunk),
    exit(code) {
      exitCode = code;
      throw new CliExit(code);
    },
  });
  try {
    await main([...args], deps);
  } catch (err) {
    if (!(err instanceof CliExit)) throw err;
  } finally {
    resetCliIoSink();
  }
  return { code: exitCode ?? 0, json: JSON.parse(stdout.join('')), stderr: stderr.join('') };
}

const BASE_ARGS = () => ['--session-id', 'chatops-cli', '--sessions-path', sessionsPath, '--db-path', dbPath];

// ---------------------------------------------------------------------------
// Disabled: a total no-op, before anything is opened
// ---------------------------------------------------------------------------

describe('chatops-scan — disabled sessions', () => {
  test('reports disabled without creating the database', async () => {
    writeSession({});
    const runner = recordingRunner();

    const { code, json } = await runScan(BASE_ARGS(), { runner });

    expect(code).toBe(0);
    expect(json).toMatchObject({
      ok: true,
      outcome: 'disabled',
      sessionId: 'chatops-cli',
      identity: { provider: 'github-issues', providerOwner: 'm2dw', providerRepo: 'demo' },
      issues: [],
    });
    // The documented rollback promise: no provider read, no database write.
    expect(existsSync(dbPath)).toBe(false);
    expect(runner.calls).toHaveLength(0);
  });

  test('reports disabled — not a setup error — for a provider with no ChatOps identity', async () => {
    // A `jira` session has no defined identity tuple (identity contract §3).
    // With ChatOps off that is irrelevant: there is nothing to scope.
    writeSession({
      workItemProvider: { provider: 'jira', auth: { mode: 'api-token', tokenEnv: 'CHATOPS_TEST_JIRA_TOKEN' } },
      chatOps: { enabled: false },
    });

    const { code, json } = await runScan(BASE_ARGS());

    expect(code).toBe(0);
    expect(json).toMatchObject({ ok: true, outcome: 'disabled', identity: null });
    expect(existsSync(dbPath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// --context-id: the form the generated n8n child workflow invokes
//
// The child workflow passes only contextId — sessionId never crosses the
// workflow boundary — so the ChatOps Scan node is only reachable if this CLI
// resolves a session from the context store exactly like its sibling nodes do.
// ---------------------------------------------------------------------------

describe('chatops-scan — --context-id resolution', () => {
  function writeContext(contextId, sessionId) {
    const store = new SqliteContextStore(dbPath);
    try {
      store.upsert(contextId, sessionId);
    } finally {
      store.close();
    }
  }

  test('resolves the session from the context store and echoes the contextId', async () => {
    writeSession({});
    writeContext('ctx-workflow-1', 'chatops-cli');
    const runner = recordingRunner();

    const { code, json } = await runScan(
      ['--context-id', 'ctx-workflow-1', '--sessions-path', sessionsPath, '--db-path', dbPath],
      { runner },
    );

    expect(code).toBe(0);
    expect(json).toMatchObject({
      ok: true,
      outcome: 'disabled',
      sessionId: 'chatops-cli',
      contextId: 'ctx-workflow-1',
    });
    expect(runner.calls).toHaveLength(0);
  });

  test('an unknown contextId is a setup error, not a pass outcome', async () => {
    writeSession({ chatOps: CHATOPS_ON });
    writeContext('ctx-workflow-1', 'chatops-cli');
    const runner = recordingRunner();

    const { code, json } = await runScan(
      ['--context-id', 'ctx-missing', '--sessions-path', sessionsPath, '--db-path', dbPath],
      { runner },
    );

    expect(code).toBe(1);
    expect(json.ok).toBe(false);
    expect(json.error).toMatch(/Unknown contextId: ctx-missing/);
    expect(runner.calls).toHaveLength(0);
  });

  test('requires one of --session-id or --context-id', async () => {
    writeSession({});

    const { code, json } = await runScan(['--sessions-path', sessionsPath, '--db-path', dbPath]);

    expect(code).toBe(1);
    expect(json.ok).toBe(false);
    expect(json.error).toMatch(/--session-id or --context-id is required/);
  });

  // Both selectors is the case where the caller believes it named one session
  // and the CLI would act on another: a context row that has drifted resolves to
  // a different session than the explicit flag, and a precedence rule would send
  // the scan, the dispatch, and the posted markers there without saying so.
  test('rejects --session-id together with --context-id instead of preferring one', async () => {
    writeSession({ chatOps: CHATOPS_ON });
    writeContext('ctx-other-session', 'some-other-session');
    const runner = recordingRunner();

    const { code, json } = await runScan(
      [
        '--session-id',
        'chatops-cli',
        '--context-id',
        'ctx-other-session',
        '--sessions-path',
        sessionsPath,
        '--db-path',
        dbPath,
      ],
      { runner },
    );

    expect(code).toBe(1);
    expect(json.ok).toBe(false);
    expect(json.error).toMatch(/mutually exclusive/);
    expect(runner.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Enabled: the provider must actually have a port
// ---------------------------------------------------------------------------

describe('chatops-scan — provider support', () => {
  const GITEA_TOKEN = '0123456789abcdef0123456789abcdef01234567';

  const giteaSession = (overrides = {}) => ({
    workItemProvider: {
      provider: 'gitea-issues',
      auth: { mode: 'api-token', tokenEnv: 'CHATOPS_TEST_GITEA_TOKEN' },
      gitea: { baseUrl: 'https://gitea.example.com', owner: 'm2dw', repo: 'demo' },
      ...overrides,
    },
    chatOps: CHATOPS_ON,
  });

  /** A fake Gitea transport that records requests and answers with queued responses. */
  function fakeGiteaHttp(responses) {
    const calls = [];
    let i = 0;
    const fn = (req) => {
      calls.push(req);
      return responses[i++] ?? { status: 200, statusText: 'OK', body: '[]' };
    };
    fn.calls = calls;
    return fn;
  }

  test('scans a gitea-issues session through the Gitea comment port, never through gh', async () => {
    writeSession(giteaSession());
    const runner = recordingRunner();
    const giteaHttp = fakeGiteaHttp([
      {
        status: 200,
        statusText: 'OK',
        body: JSON.stringify([
          {
            id: 31,
            body: '/grant --disposition commit',
            user: { login: 'alice' },
            created_at: '2026-03-01T10:00:00Z',
            updated_at: '2026-03-01T10:00:00Z',
          },
        ]),
      },
      // Only an empty page proves the list end on a page-size-clamping instance.
      { status: 200, statusText: 'OK', body: '[]' },
    ]);

    const { code, json } = await runScan([...BASE_ARGS(), '--issue-number', '4'], {
      runner,
      giteaHttp,
      authDeps: { env: { CHATOPS_TEST_GITEA_TOKEN: GITEA_TOKEN } },
    });

    expect(code).toBe(0);
    expect(json.ok).toBe(true);
    // The scope is keyed by the Gitea identity, with the canonicalized endpoint.
    expect(json.identity).toEqual({
      provider: 'gitea-issues',
      providerEndpoint: 'https://gitea.example.com',
      providerOwner: 'm2dw',
      providerRepo: 'demo',
    });
    // A bootstrap: the pre-existing `/grant` is recorded and deliberately not
    // run, exactly as it would be on GitHub. Nothing here is provider-specific.
    expect(json.issues).toHaveLength(1);
    expect(json.issues[0].bootstrapped).toBe(true);
    expect(json.issues[0].bootstrapSkipped).toBe(1);
    expect(json.issues[0].outcome).toBe('refused');

    // The bug this pins: a `gh api` port built from Gitea owner/repo would have
    // scanned github.com/m2dw/demo and posted markers there.
    expect(runner.calls).toHaveLength(0);
    expect(giteaHttp.calls).toHaveLength(2);
    for (const call of giteaHttp.calls) {
      expect(call.method).toBe('GET');
      expect(call.url).toContain('/api/v1/repos/m2dw/demo/issues/4/comments');
      expect(call.headers.Authorization).toBe(`token ${GITEA_TOKEN}`);
    }
  });

  test('a Gitea credential that cannot be resolved refuses to start, before anything is opened', async () => {
    writeSession(giteaSession());
    const runner = recordingRunner();
    const giteaHttp = fakeGiteaHttp([]);

    // The env var the session names is simply absent.
    const { code, json } = await runScan(BASE_ARGS(), {
      runner,
      giteaHttp,
      authDeps: { env: {} },
    });

    expect(code).toBe(1);
    expect(json.ok).toBe(false);
    expect(json.error).toMatch(/could not resolve the work-item credentials for provider "gitea-issues"/);
    expect(json.error).toMatch(/auth mode "api-token"/);
    // The env var an operator has to go set must survive redaction, or the
    // message names nothing actionable.
    expect(json.error).toMatch(/CHATOPS_TEST_GITEA_TOKEN/);
    // No ambient fallback of any kind, and no state left behind for a pass that
    // never ran.
    expect(runner.calls).toHaveLength(0);
    expect(giteaHttp.calls).toHaveLength(0);
    expect(existsSync(dbPath)).toBe(false);
  });

  test('bootstraps, recognizes, dispatches and publishes a Gitea /grant in one pass chain', async () => {
    // The acceptance criterion this pins: an enabled `gitea-issues` session runs
    // the *same* pass GitHub does — nothing below the port knows the difference.
    writeSession(giteaSession());
    const grant = {
      id: 31,
      body: '/grant --disposition commit',
      user: { login: 'alice' },
      created_at: '2026-03-01T10:00:00Z',
      updated_at: '2026-03-01T10:00:00Z',
    };
    const listed = (comments) => ({
      status: 200,
      statusText: 'OK',
      body: JSON.stringify(comments),
    });
    const empty = listed([]);
    const created = { status: 201, statusText: 'Created', body: '{"id":99}' };
    const authDeps = { env: { CHATOPS_TEST_GITEA_TOKEN: GITEA_TOKEN } };

    // Pass 1 bootstraps an issue with no comments yet: one GET, nothing posted.
    const bootstrapHttp = fakeGiteaHttp([empty]);
    const first = await runScan([...BASE_ARGS(), '--issue-number', '4'], {
      giteaHttp: bootstrapHttp,
      authDeps,
    });
    expect(first.json.issues[0]).toMatchObject({ bootstrapped: true, bootstrapSkipped: 0 });
    expect(bootstrapHttp.calls.filter((c) => c.method === 'POST')).toHaveLength(0);

    // Pass 2 sees the `/grant` as genuinely new: claim marker, operation, ack.
    const ran = [];
    const scanHttp = fakeGiteaHttp([listed([grant]), empty, created, created]);
    const second = await runScan([...BASE_ARGS(), '--issue-number', '4'], {
      giteaHttp: scanHttp,
      authDeps,
      registry: createOperationRegistry([
        {
          id: 'tool-request.run',
          summary: 'Guided-run the approved command for this issue.',
          mutating: true,
          scope: 'issue',
          params: [{ name: 'disposition', type: 'string' }],
          run: (invocation) => {
            ran.push(invocation.request.params.disposition);
            return operationExecuted('ran the approved command');
          },
        },
      ]),
    });

    expect(second.code).toBe(0);
    expect(second.json.issues[0]).toMatchObject({
      outcome: 'processed',
      claimed: 1,
      dispatchAttempts: 1,
      dispatchResults: 1,
      acknowledged: 1,
      fenced: null,
    });
    expect(ran).toEqual(['commit']);

    // Claim marker before the operation, acknowledgement after it — both posted
    // verbatim through the Gitea port, both on the Gitea repository.
    const posts = scanHttp.calls.filter((c) => c.method === 'POST');
    expect(posts).toHaveLength(2);
    for (const post of posts) {
      expect(post.url).toContain('/api/v1/repos/m2dw/demo/issues/4/comments');
      expect(post.headers.Authorization).toBe(`token ${GITEA_TOKEN}`);
    }
    expect(JSON.parse(posts[0].body).body).toBe('<!-- chatops-claimed:31 -->');
    expect(JSON.parse(posts[1].body).body).toBe('<!-- chatops-ack:31:executed -->');

    // The human-readable summary is not posted by the port: it is an outbox
    // effect committed with the outcome, addressed to the Gitea work item.
    const db = new Database(dbPath, { readonly: true });
    let rows;
    try {
      rows = db.prepare('SELECT topic, payload FROM outbox').all();
    } finally {
      db.close();
    }
    const summaries = rows
      .filter((row) => row.topic === 'workitem:comment')
      .map((row) => JSON.parse(row.payload));
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      topic: 'workitem:comment',
      provider: 'gitea-issues',
      owner: 'm2dw',
      repo: 'demo',
      issueNumber: 4,
    });

    // A repeated scan runs nothing a second time and posts no second terminal
    // comment — the ledger, not the provider, is what makes that true, and it
    // must stay true on Gitea. The window now also carries the two markers the
    // previous pass posted, exactly as the instance would return them: they are
    // above the cursor, so they are discovered, authenticated against
    // `automationLogins`, and refused as marker comments rather than commanded.
    const marker = (id, body, minute) => ({
      id,
      body,
      user: { login: 'demo-bot' },
      created_at: `2026-03-01T10:0${minute}:00Z`,
      updated_at: `2026-03-01T10:0${minute}:00Z`,
    });
    const replayHttp = fakeGiteaHttp([
      listed([
        grant,
        marker(32, JSON.parse(posts[0].body).body, 1),
        marker(33, JSON.parse(posts[1].body).body, 2),
      ]),
      empty,
    ]);
    const third = await runScan([...BASE_ARGS(), '--issue-number', '4'], {
      giteaHttp: replayHttp,
      authDeps,
      registry: createOperationRegistry([
        {
          id: 'tool-request.run',
          summary: 'Guided-run the approved command for this issue.',
          mutating: true,
          scope: 'issue',
          params: [{ name: 'disposition', type: 'string' }],
          run: () => {
            throw new Error('a replayed scan must never re-invoke the operation');
          },
        },
      ]),
    });

    expect(third.code).toBe(0);
    expect(ran).toEqual(['commit']);
    expect(replayHttp.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    expect(third.json.issues[0]).toMatchObject({
      outcome: 'refused',
      claimed: 0,
      dispatchAttempts: 0,
      refused: 2,
      fenced: null,
    });
  }, 30_000);

  test('a work-item provider with no ChatOps identity is still refused', async () => {
    writeSession({
      workItemProvider: { provider: 'jira', auth: { mode: 'api-token', tokenEnv: 'JIRA_TOKEN' } },
      chatOps: CHATOPS_ON,
    });
    const runner = recordingRunner();

    const { code, json } = await runScan(BASE_ARGS(), { runner });

    expect(code).toBe(1);
    expect(json.ok).toBe(false);
    expect(json.error).toMatch(/ChatOps identity is undefined for work-item provider "jira"/);
    expect(runner.calls).toHaveLength(0);
    expect(existsSync(dbPath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Enabled: the session's configured credentials, not the ambient ones
// ---------------------------------------------------------------------------

describe('chatops-scan — work-item credentials', () => {
  const appSession = (envPrefix) => ({
    workItemProvider: {
      provider: 'github-issues',
      auth: {
        mode: 'github-app',
        appIdEnv: `${envPrefix}_APP_ID`,
        installationIdEnv: `${envPrefix}_INSTALL_ID`,
        privateKeyPathEnv: `${envPrefix}_KEY_PATH`,
      },
    },
    chatOps: CHATOPS_ON,
  });

  test('resolves github-app auth rather than using the ambient gh login', async () => {
    writeSession(appSession('CHATOPS_TEST_APP'));
    process.env.CHATOPS_TEST_APP_APP_ID = '12345';
    process.env.CHATOPS_TEST_APP_INSTALL_ID = '67890';
    process.env.CHATOPS_TEST_APP_KEY_PATH = keyPath;
    const runner = recordingRunner();
    const httpPostJson = mockTokenExchange([TOKEN_OK]);

    try {
      // No work items are in scope (no ChatOps state, no live tasks), so the
      // pass is idle and the resolved runner is never actually spawned.
      const { code, json } = await runScan(BASE_ARGS(), { runner, authDeps: { httpPostJson } });

      expect(code).toBe(0);
      expect(json).toMatchObject({ ok: true, outcome: 'idle' });
      // The App's installation token was exchanged...
      expect(httpPostJson.calls).toHaveLength(1);
      expect(httpPostJson.calls[0].url).toBe(
        'https://api.github.com/app/installations/67890/access_tokens',
      );
      // ...and the ambient/injected `gh` executor was not substituted for it.
      expect(runner.calls).toHaveLength(0);
    } finally {
      delete process.env.CHATOPS_TEST_APP_APP_ID;
      delete process.env.CHATOPS_TEST_APP_INSTALL_ID;
      delete process.env.CHATOPS_TEST_APP_KEY_PATH;
    }
  }, 30_000);

  test('fails closed when configured github-app credentials cannot be resolved', async () => {
    // The credential env vars are intentionally unset. Falling back to the
    // operator's `gh` session here would post markers under a human login that
    // is absent from `automationLogins`, so they would never authenticate as
    // ChatOps evidence.
    writeSession(appSession('CHATOPS_TEST_UNSET'));
    const runner = recordingRunner();

    const { code, json } = await runScan(BASE_ARGS(), { runner });

    expect(code).toBe(1);
    expect(json.ok).toBe(false);
    expect(json.error).toMatch(/could not resolve github-app credentials/);
    expect(json.error).toMatch(/CHATOPS_TEST_UNSET_APP_ID/);
    expect(runner.calls).toHaveLength(0);
    expect(existsSync(dbPath)).toBe(false);
  });

  test('uses the injected gh executor for a plain gh-auth session', async () => {
    writeSession({
      workItemProvider: { provider: 'github-issues', auth: { mode: 'gh' } },
      chatOps: CHATOPS_ON,
    });
    const runner = recordingRunner();

    // Scanning one named work item forces the port into use; the injected
    // executor answers with an empty comment list, so the scope bootstraps.
    const { code, json } = await runScan([...BASE_ARGS(), '--issue-number', '42'], { runner });

    expect(code).toBe(0);
    expect(json.ok).toBe(true);
    expect(runner.calls.length).toBeGreaterThan(0);
    expect(runner.calls[0].join(' ')).toContain('repos/m2dw/demo/issues/42/comments');
  }, 30_000);
});

// ---------------------------------------------------------------------------
// The per-pass work-item cap is a window, not a selection
//
// A cap that always took the same ascending prefix would permanently exclude
// every work item past it: on a session with more than `--max-issues`
// candidates, comments on the higher-numbered ones would never be read at all,
// so no command on them could ever run and nothing in the output would say so.
// ---------------------------------------------------------------------------

describe('chatops-scan — capped work-item selection', () => {
  /** A comment port that answers every work item with an empty, complete list. */
  function fakePort() {
    const port = {
      seen: [],
      async listComments({ issueNumber }) {
        port.seen.push(issueNumber);
        return { ok: true, page: { comments: [], hasMore: false } };
      },
      async postComment() {
        return { ok: true };
      },
    };
    return port;
  }

  const enabled = () => ({
    workItemProvider: { provider: 'github-issues', auth: { mode: 'gh' } },
    chatOps: CHATOPS_ON,
  });

  const scanned = (result) => result.json.issues.map((issue) => issue.issueNumber);

  test('rotates the window so every work item is covered across passes', async () => {
    writeSession(enabled());
    const port = fakePort();

    // Five work items with ChatOps state — more than the cap used below. Naming
    // them explicitly bypasses the cap, which is what makes them candidates.
    const seeded = await runScan([...BASE_ARGS(), '--issue-number', '1,2,3,4,5'], { port });
    expect(scanned(seeded)).toEqual([1, 2, 3, 4, 5]);
    expect(seeded.json.issuesTruncated).toBeUndefined();

    const first = await runScan([...BASE_ARGS(), '--max-issues', '2'], { port });
    const second = await runScan([...BASE_ARGS(), '--max-issues', '2'], { port });
    const third = await runScan([...BASE_ARGS(), '--max-issues', '2'], { port });

    expect(scanned(first)).toEqual([1, 2]);
    // The bug this pins: without a rotating cursor this pass — and every
    // scheduled one after it — would scan [1, 2] again forever.
    expect(scanned(second)).toEqual([3, 4]);
    // The window wraps, and a wrapped pass runs from its resume position rather
    // than re-sorting ascending: the shared per-pass dispatch budget is spent in
    // the order the window is handed, so re-sorting would let the lowest-numbered
    // member of every window take it first and starve the rest.
    expect(scanned(third)).toEqual([5, 1]);

    expect(first.json).toMatchObject({ issuesTruncated: true, maxIssues: 2, nextIssueCursor: 3 });
    expect(second.json.nextIssueCursor).toBe(5);
    expect(third.json.nextIssueCursor).toBe(2);

    // What rotation is actually for: the provider's comment list is *read* for
    // every work item within ceil(5 / 2) passes, not only for the first two.
    expect(port.seen.slice(5).sort((a, b) => a - b)).toEqual([1, 1, 2, 3, 4, 5]);
  }, 30_000);

  // A window is executed in the order it is returned, and every work item in it
  // draws on one shared `maxDispatchesPerPass` budget. So the *order* is what
  // decides who gets to dispatch when the budget is smaller than the window —
  // rotating which work items are scanned is not enough on its own.
  test('gives every candidate first call on the dispatch budget within one rotation', () => {
    const candidates = [1, 2, 3, 4, 5];
    const maxIssues = 3;
    const firstRun = [];
    let cursor = null;
    for (let pass = 0; pass < candidates.length; pass += 1) {
      const selection = selectRotatedIssues(candidates, maxIssues, cursor);
      firstRun.push(selection.issueNumbers[0]);
      cursor = selection.nextCursor;
    }
    // Sorting each window ascending instead would make this [1, 1, 2, 1, 3]:
    // 4 and 5 are scanned but, with a budget of one dispatch per pass, never
    // reach the front and so never run a command.
    expect(firstRun).toEqual([1, 4, 2, 5, 3]);
    expect([...firstRun].sort((a, b) => a - b)).toEqual(candidates);
  });

  test('covers everything, and reports no truncation, when the cap is not reached', async () => {
    writeSession(enabled());
    const port = fakePort();

    await runScan([...BASE_ARGS(), '--issue-number', '7,9'], { port });
    const pass = await runScan([...BASE_ARGS(), '--max-issues', '5'], { port });

    expect(scanned(pass)).toEqual([7, 9]);
    expect(pass.json.issuesTruncated).toBeUndefined();
    expect(pass.json.nextIssueCursor).toBeUndefined();
  }, 30_000);

  // -------------------------------------------------------------------------
  // The terminal-task boundary
  //
  // Excluding terminal tasks from the *live-task* source alone does nothing:
  // a scope keeps its cursor row forever, so a task that finishes after its
  // first scan is handed straight back by the known-scope source and every
  // later scheduled pass goes on reading — and dispatching for — an issue the
  // session is done with.
  // -------------------------------------------------------------------------

  /** The identity key the CLI recorded, read back the way `chatops-status` would. */
  function seededIdentityKey() {
    const db = new Database(dbPath);
    try {
      return db.prepare('SELECT DISTINCT identity_key FROM chatops_cursor').get().identity_key;
    } finally {
      db.close();
    }
  }

  async function seedTask(issueNumber, status) {
    const store = new SqliteTaskStore(dbPath);
    try {
      await store.enqueueTask({
        sessionId: 'chatops-cli',
        issueNumber,
        phase: 'implementation',
        now: '2026-06-07T00:00:00.000Z',
      });
      if (status !== 'queued') {
        const moved = await store.transitionTask(
          { sessionId: 'chatops-cli', issueNumber },
          { status: 'queued' },
          { status, now: '2026-06-07T00:01:00.000Z' },
        );
        expect(moved.ok).toBe(true);
      }
    } finally {
      store.close();
    }
  }

  /** Persist one ledger row for a scope, built through the state machine. */
  async function seedLedgerRow(issueNumber, events) {
    const store = new SqliteChatOpsStore(dbPath);
    try {
      let row = null;
      for (const event of events) {
        const transition = applyChatOpsLedgerEvent(row, event, '10');
        expect(transition.applied).toBe(true);
        row = transition.next;
      }
      await store.commit({ identityKey: seededIdentityKey(), issueNumber }, { rows: [row] });
      return row;
    } finally {
      store.close();
    }
  }

  test.each(['done', 'failed', 'cancelled'])(
    'drops an already-scanned work item from automatic scope once its task is %s',
    async (status) => {
      writeSession(enabled());
      const port = fakePort();

      // Both scopes exist and have cursor state, which is exactly the condition
      // that used to make a finished work item permanent.
      await runScan([...BASE_ARGS(), '--issue-number', '11,12'], { port });
      await seedTask(11, status);
      await seedTask(12, 'queued');

      const seenBefore = port.seen.length;
      const pass = await runScan([...BASE_ARGS()], { port });

      expect(scanned(pass)).toEqual([12]);
      // Not merely absent from the result: the provider was never asked about it.
      expect(port.seen.slice(seenBefore)).toEqual([12]);
    },
    30_000,
  );

  test('an operator can still scan a finished work item by naming it', async () => {
    writeSession(enabled());
    const port = fakePort();

    await runScan([...BASE_ARGS(), '--issue-number', '11'], { port });
    await seedTask(11, 'done');

    expect(scanned(await runScan([...BASE_ARGS(), '--issue-number', '11'], { port }))).toEqual([11]);
  }, 30_000);

  test('keeps a finished work item in scope only while its acknowledgement is still owed', async () => {
    writeSession(enabled());
    const port = fakePort();

    await runScan([...BASE_ARGS(), '--issue-number', '11'], { port });
    await seedTask(11, 'done');
    // The outcome is durable locally but its marker has not landed: dropping
    // this scope now would leave the command half-published with no automatic
    // path left to finish it.
    await seedLedgerRow(11, [
      { kind: 'claim' },
      { kind: 'begin-dispatch', epoch: 1, nowMs: 1_700_000_000_000 },
      { kind: 'dispatch-result', outcome: 'executed' },
    ]);

    expect(scanned(await runScan([...BASE_ARGS()], { port }))).toEqual([11]);

    // Once the marker is published the row owes nothing, and the scope leaves
    // the automatic set for good.
    await seedLedgerRow(11, [
      { kind: 'claim' },
      { kind: 'begin-dispatch', epoch: 1, nowMs: 1_700_000_000_000 },
      { kind: 'dispatch-result', outcome: 'executed' },
      { kind: 'ack-published' },
    ]);

    const settled = await runScan([...BASE_ARGS()], { port });
    expect(scanned(settled)).toEqual([]);
    expect(settled.json.outcome).toBe('idle');
  }, 30_000);

  test('a scope parked for a human is not kept alive by the exception', async () => {
    writeSession(enabled());
    const port = fakePort();

    await runScan([...BASE_ARGS(), '--issue-number', '11'], { port });
    await seedTask(11, 'done');
    // `ambiguous` moves only through `chatops-recover` plus an explicit
    // `--issue-number` pass, so scanning it every pass would be provider work
    // that can never conclude anything.
    await seedLedgerRow(11, [
      { kind: 'claim' },
      { kind: 'escalate', reason: 'dispatch-crash-unresolved' },
    ]);

    expect(scanned(await runScan([...BASE_ARGS()], { port }))).toEqual([]);
  }, 30_000);

  test('a re-queued work item comes back into automatic scope', async () => {
    writeSession(enabled());
    const port = fakePort();

    await runScan([...BASE_ARGS(), '--issue-number', '11'], { port });
    await seedTask(11, 'done');
    expect(scanned(await runScan([...BASE_ARGS()], { port }))).toEqual([]);

    // Reopened work — a fix round after a run that closed — is live again, so
    // the exclusion has to follow the task's current status, not its history.
    const store = new SqliteTaskStore(dbPath);
    try {
      const revived = await store.transitionTask(
        { sessionId: 'chatops-cli', issueNumber: 11 },
        { status: 'done' },
        { status: 'queued', now: '2026-06-07T00:02:00.000Z' },
      );
      expect(revived.ok).toBe(true);
    } finally {
      store.close();
    }

    expect(scanned(await runScan([...BASE_ARGS()], { port }))).toEqual([11]);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// chatops-status: read-only means it does not bring state into existence
// ---------------------------------------------------------------------------

describe('chatops-status — strictly read-only', () => {
  async function runStatus(args) {
    const stdout = [];
    const stderr = [];
    let exitCode;
    setCliIoSink({
      stdout: (chunk) => stdout.push(chunk),
      stderr: (chunk) => stderr.push(chunk),
      exit(code) {
        exitCode = code;
        throw new CliExit(code);
      },
    });
    try {
      await statusMain([...args]);
    } catch (err) {
      if (!(err instanceof CliExit)) throw err;
    } finally {
      resetCliIoSink();
    }
    return { code: exitCode ?? 0, json: JSON.parse(stdout.join('')), stderr: stderr.join('') };
  }

  test('refuses a session with no ChatOps database instead of creating one', async () => {
    writeSession({ chatOps: CHATOPS_ON });

    const { code, json } = await runStatus(BASE_ARGS());

    expect(code).toBe(1);
    expect(json.error).toMatch(/does not exist/);
    // The whole promise of a diagnostic command: it did not create the state it
    // was asked to report on.
    expect(existsSync(dbPath)).toBe(false);
  });

  test('refuses a database that has no ChatOps tables rather than adding them', async () => {
    writeSession({ chatOps: CHATOPS_ON });
    // A zero-byte file is a valid, empty SQLite database — the shape a sibling
    // store could leave behind before ChatOps ever ran.
    writeFileSync(dbPath, '');

    const { code, json } = await runStatus(BASE_ARGS());

    expect(code).toBe(1);
    expect(json.error).toMatch(/no ChatOps tables/);
    expect(statSync(dbPath).size).toBe(0);
  });

  test('reports an existing database', async () => {
    writeSession({ chatOps: CHATOPS_ON });
    // The database as a completed pass would have left it.
    new SqliteChatOpsStore(dbPath).close();

    const { code, json } = await runStatus(BASE_ARGS());

    expect(code).toBe(0);
    expect(json).toMatchObject({
      ok: true,
      sessionId: 'chatops-cli',
      enabled: true,
      identity: { provider: 'github-issues', providerOwner: 'm2dw', providerRepo: 'demo' },
      issues: [],
    });
  });

  test('a read-only store refuses to commit rather than writing through', async () => {
    new SqliteChatOpsStore(dbPath).close();
    const store = SqliteChatOpsStore.openReadOnly(dbPath);
    try {
      await expect(
        store.commit({ identityKey: '["a","b","c","d","e"]', issueNumber: 42 }, { rows: [] }),
      ).rejects.toThrow(/read-only/);
    } finally {
      store.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Maintenance lock: the file-level exclusion a prune/restore holds
//
// ChatOps runs ahead of the outbox dispatcher in the scheduled child workflow,
// so it is the first thing that could write into a database `restore` is
// replacing. The guard has to be a *write* guard, not a pass-entry guard: a lock
// acquired mid-pass must still stop the next write, and it must do so without
// executing an operation whose ledger row is then lost.
// ---------------------------------------------------------------------------

describe('chatops-scan — maintenance lock exclusion', () => {
  const SCOPE = { identityKey: '["a","b","c","d","e"]', issueNumber: 42 };
  const ROW = applyChatOpsLedgerEvent(null, { kind: 'claim' }, '10').next;

  /** Seed the lock row on a separate connection, the way `restore` writes it. */
  function holdMaintenanceLock() {
    const db = new Database(dbPath);
    try {
      seedMaintenanceLock(db, 'prune run', '2026-01-01T00:00:00Z');
    } finally {
      db.close();
    }
  }

  test('reports delayed without opening a provider connection', async () => {
    writeSession({ chatOps: CHATOPS_ON });
    new SqliteChatOpsStore(dbPath).close();
    holdMaintenanceLock();
    const runner = recordingRunner();
    // Every ChatOps write refuses under the lock, so reading comments could only
    // spend provider quota to reach the same answer.
    const port = {
      async listComments() { throw new Error('provider must not be read under a maintenance lock'); },
      async postComment() { throw new Error('provider must not be posted to under a maintenance lock'); },
    };

    const { code, json } = await runScan(BASE_ARGS(), { runner, port });

    expect(code).toBe(0);
    expect(json).toMatchObject({
      ok: true,
      outcome: 'delayed',
      sessionId: 'chatops-cli',
      identity: { provider: 'github-issues', providerOwner: 'm2dw', providerRepo: 'demo' },
      issues: [],
    });
    expect(json.notes.join(' ')).toMatch(/maintenance lock/);
    expect(runner.calls).toHaveLength(0);
  });

  test('a lock acquired after the preflight check is a delayed pass, not a crashed step', async () => {
    writeSession({ chatOps: CHATOPS_ON });
    const port = {
      seen: [],
      async listComments({ issueNumber }) {
        port.seen.push(issueNumber);
        return { ok: true, page: { comments: [], hasMore: false } };
      },
      async postComment() { return { ok: true }; },
    };

    // Five candidates seeded while nothing is locked — more than the cap below,
    // which is what makes the pass write a rotation position at all.
    await runScan([...BASE_ARGS(), '--issue-number', '1,2,3,4,5'], { port });
    const seenBefore = port.seen.length;

    holdMaintenanceLock();
    // The race the preflight cannot close: `prune` acquired the lock in the
    // window between that read and the rotation write, so the check saw an
    // unlocked database and the write meets the real guard. Stubbing only the
    // check reproduces that ordering deterministically; the refusal below comes
    // from the store's own in-transaction guard.
    const proto = SqliteChatOpsStore.prototype;
    const realCheck = proto.isMaintenanceLocked;
    proto.isMaintenanceLocked = async () => false;
    let capped;
    try {
      capped = await runScan([...BASE_ARGS(), '--max-issues', '2'], { port });
    } finally {
      proto.isMaintenanceLocked = realCheck;
    }

    // Exit 0 with the contracted retryable outcome: n8n retries a `delayed`
    // pass normally, where an exit-1 setup failure would need a human.
    expect(capped.code).toBe(0);
    expect(capped.json).toMatchObject({
      ok: true,
      outcome: 'delayed',
      sessionId: 'chatops-cli',
      identity: { provider: 'github-issues', providerOwner: 'm2dw', providerRepo: 'demo' },
      issues: [],
    });
    expect(capped.json.notes.join(' ')).toMatch(/maintenance lock/);
    // The refusal stopped the pass before it read anything from the provider.
    expect(port.seen).toHaveLength(seenBefore);

    const db = new Database(dbPath);
    try {
      db.prepare('DELETE FROM maintenance_lock WHERE id = 1').run();
    } finally {
      db.close();
    }

    // Nothing was consumed: the rotation position never advanced, so the retry
    // covers the window the refused pass would have taken.
    const retry = await runScan([...BASE_ARGS(), '--max-issues', '2'], { port });
    expect(retry.json.issues.map((issue) => issue.issueNumber)).toEqual([1, 2]);
    expect(retry.json).toMatchObject({ issuesTruncated: true, nextIssueCursor: 3 });
  }, 30_000);

  test('every ChatOps write refuses while the lock is held, and persists nothing', async () => {
    new SqliteChatOpsStore(dbPath).close();
    holdMaintenanceLock();
    const store = new SqliteChatOpsStore(dbPath);
    try {
      // Not a falsy return: `commitWithEpoch`'s null and `commitCompareAndSwap`'s
      // false already mean "decided to write nothing", which a caller treats as a
      // settled outcome. A refusal is the opposite — nothing has been decided yet.
      const refused = (promise) =>
        expect(promise).rejects.toMatchObject({ code: 'maintenance_locked' });

      await refused(store.commit(SCOPE, { rows: [ROW] }));
      await refused(store.commitCompareAndSwap(SCOPE, () => ({ rows: [ROW] })));
      await refused(store.commitWithEpoch(SCOPE, () => ({ rows: [ROW] })));
      await refused(store.reserveAckPublication(SCOPE, '10', () => true));
      await refused(store.setScanRotation(SCOPE.identityKey, 7));

      const state = await store.loadScope(SCOPE);
      expect(state.rows).toEqual([]);
      expect(state.ackReservations).toEqual([]);
      // The epoch is read and bumped inside the same transaction as the
      // write-ahead, so a refusal must not consume one.
      expect(await store.getEpoch(SCOPE.identityKey)).toBe(0);
      expect(await store.getScanRotation(SCOPE.identityKey)).toBeNull();
    } finally {
      store.close();
    }
  });

  test('writes resume once the lock is released', async () => {
    new SqliteChatOpsStore(dbPath).close();
    holdMaintenanceLock();
    const store = new SqliteChatOpsStore(dbPath);
    try {
      await expect(store.commit(SCOPE, { rows: [ROW] })).rejects.toMatchObject({
        code: 'maintenance_locked',
      });

      const db = new Database(dbPath);
      try {
        db.prepare('DELETE FROM maintenance_lock WHERE id = 1').run();
      } finally {
        db.close();
      }

      await store.commit(SCOPE, { rows: [ROW] });
      expect((await store.loadScope(SCOPE)).rows).toHaveLength(1);
    } finally {
      store.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Legacy shared `outbox` schema
//
// `chatops-scan` opens this store and never `SqliteTaskStore`/`SqliteOutboxStore`
// on the summary-effect path, so it is the only thing that can upgrade a
// pre-`idempotency_key` `outbox` before a transition tries to enqueue into it —
// which happens *after* the command has been claimed.
// ---------------------------------------------------------------------------

describe('chatops-scan — legacy outbox migration', () => {
  const SCOPE = { identityKey: '["a","b","c","d","e"]', issueNumber: 42 };

  test('upgrades a pre-idempotency-key outbox so a summary effect can be enqueued', async () => {
    const legacy = new Database(dbPath);
    try {
      legacy.exec(`
        CREATE TABLE outbox (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          topic       TEXT NOT NULL,
          payload     TEXT NOT NULL,
          created_at  TEXT NOT NULL,
          sent_at     TEXT
        );
      `);
      legacy
        .prepare('INSERT INTO outbox (topic, payload, created_at) VALUES (?, ?, ?)')
        .run('workitem:comment', '{}', '2026-01-01T00:00:00Z');
    } finally {
      legacy.close();
    }

    const store = new SqliteChatOpsStore(dbPath);
    try {
      await store.commit(SCOPE, {
        effects: [
          {
            idempotencyKey: 'chatops-summary-1',
            topic: 'workitem:comment',
            payload: {
              topic: 'workitem:comment',
              provider: 'github-issues',
              owner: 'm2dw',
              repo: 'demo',
              issueNumber: 42,
              body: 'ChatOps automated comment — not a command',
            },
          },
        ],
      });
    } finally {
      store.close();
    }

    const check = new Database(dbPath, { readonly: true });
    try {
      const columns = check.prepare('PRAGMA table_info(outbox)').all().map((c) => c.name);
      expect(columns).toEqual(
        expect.arrayContaining([
          'idempotency_key',
          'attempt_count',
          'last_error',
          'next_attempt_at',
          'dead_letter_at',
          'cancelled_at',
          'claimed_at',
        ]),
      );
      // The pre-existing row keeps its payload under a synthesized key, and the
      // ChatOps effect lands beside it rather than failing the transition.
      const keys = check
        .prepare('SELECT idempotency_key FROM outbox ORDER BY id')
        .all()
        .map((r) => r.idempotency_key);
      expect(keys).toEqual(['legacy-1', 'chatops-summary-1']);
    } finally {
      check.close();
    }
  });
});
