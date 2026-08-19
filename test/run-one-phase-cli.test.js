import { jest } from '@jest/globals';
import { execFileSync } from 'child_process';
import { generateKeyPairSync } from 'crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SqliteTaskStore, SqliteOutboxStore, SqliteContextStore, JsonSessionRegistry } from '../dist/index.js';
import { acquireIssuePhaseLock, createPhaseHandlers } from '../dist/cli/run-one-phase.js';
import { IssueWorktreeLock } from '../dist/handlers/worktree.js';

const CLI = new URL('../dist/cli/run-one-phase.js', import.meta.url).pathname;

// The fixture now builds a real repository with a real `origin` and research
// materializes a worktree from it (issue #855), so each case spawns more
// subprocesses than the 5s default comfortably covers under the parallel run.
jest.setTimeout(30_000);

const SESSION = {
  sessionId: 'addon-dev',
  repoKey: 'thunderbird-auth-results-filter',
  repoRoot: '/Users/moto/git/thunderbird-auth-results-filter',
  githubRepo: 'm2dw/thunderbird-auth-results-filter',
  artifactDir: '.n8n-artifacts',
  defaults: { implementationAgent: 'claude', reviewAgent: 'codex', researchAgent: 'gemini' },
  verification: { test: 'npm test' },
  labels: { active: 'ai:active', blocked: 'ai:blocked', readyForHuman: 'ai:ready-for-human' },
};

let tmpDir;
let sessionsPath;
let dbPath;
let repoRoot;
let artifactRoot;
let fakeAgyPath;
let worktreeRoot;

function git(args, cwd) {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' });
}

function run(...args) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      encoding: 'utf8',
      env: { ...process.env, ANTIGRAVITY_BIN: fakeAgyPath, N8N_AI_WORKTREE_ROOT: worktreeRoot },
    });
    return { code: 0, stdout };
  } catch (err) {
    return { code: err.status ?? 1, stdout: err.stdout ?? '' };
  }
}

// Runs with the fake agy resolved via PATH under its real name instead of an
// ANTIGRAVITY_BIN override, so cmdSource is "cli-default" — quota/rate-limit
// classification only trusts stderr from that path (issue #672 review; an
// ANTIGRAVITY_BIN-overridden binary's stderr cannot be shown to originate
// from the vetted CLI, so it is withheld from automatic retry classification).
function runWithAgyOnPath(binDir, ...args) {
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}`, N8N_AI_WORKTREE_ROOT: worktreeRoot };
  delete env.ANTIGRAVITY_BIN;
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env });
    return { code: 0, stdout };
  } catch (err) {
    return { code: err.status ?? 1, stdout: err.stdout ?? '' };
  }
}

function parseOutput(result) {
  return JSON.parse(result.stdout.trim());
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'run-one-phase-test-'));
  sessionsPath = join(tmpDir, 'sessions.json');
  dbPath = join(tmpDir, 'dev_loop.db');
  repoRoot = join(tmpDir, 'repo');
  artifactRoot = join(tmpDir, 'artifacts');
  worktreeRoot = join(tmpDir, 'state', 'worktrees');

  // A real repository with a real `origin` (issue #855): the research phase now
  // fetches the base branch and creates a detached per-run worktree from the
  // resolved commit before invoking the agent, so an end-to-end CLI run needs a
  // fetchable remote. `N8N_AI_WORKTREE_ROOT` (set in `run`/`runWithAgyOnPath`)
  // keeps those worktrees inside the test's temporary directory.
  const originPath = join(tmpDir, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', originPath]);
  execFileSync('git', ['init', '-q', '-b', 'main', repoRoot]);
  writeFileSync(join(repoRoot, 'README.md'), '# repo\n', 'utf8');
  git(['add', '-A'], repoRoot);
  git(['commit', '-q', '-m', 'initial'], repoRoot);
  git(['remote', 'add', 'origin', originPath], repoRoot);
  git(['push', '-q', 'origin', 'main'], repoRoot);

  // Fake agy: exits 0 and prints a stub research output.
  fakeAgyPath = join(tmpDir, 'fake-agy');
  writeFileSync(fakeAgyPath, '#!/bin/sh\necho "stub research output"\nexit 0\n', 'utf8');
  chmodSync(fakeAgyPath, 0o755);

  const session = { ...SESSION, repoRoot, artifactDir: '.n8n-artifacts' };
  writeFileSync(sessionsPath, JSON.stringify({ sessions: [session] }), 'utf8');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('run-one-phase CLI arg validation', () => {
  test('missing --session-id and --context-id exits non-zero', () => {
    const result = run('--run-id', 'run-1', '--sessions-path', sessionsPath, '--db-path', dbPath);
    expect(result.code).not.toBe(0);
    expect(parseOutput(result)).toMatchObject({ ok: false, error: expect.stringContaining('--context-id or --session-id is required') });
  });

  test('missing --run-id and --context-id exits non-zero', () => {
    const result = run('--session-id', 'addon-dev', '--sessions-path', sessionsPath, '--db-path', dbPath);
    expect(result.code).not.toBe(0);
    expect(parseOutput(result)).toMatchObject({ ok: false });
  });

  test('--context-id without --run-id exits 0 (uses contextId as runId)', () => {
    const result = run(
      '--session-id', 'addon-dev',
      '--context-id', 'ctx-only-42',
      '--sessions-path', sessionsPath,
      '--db-path', dbPath,
    );
    expect(result.code).toBe(0);
    expect(parseOutput(result)).toMatchObject({ ok: true, outcome: 'idle', contextId: 'ctx-only-42' });
  });
});

describe('run-one-phase CLI config errors', () => {
  test('missing sessions file exits non-zero', () => {
    const result = run(
      '--session-id', 'addon-dev',
      '--run-id', 'run-1',
      '--sessions-path', join(tmpDir, 'nonexistent.json'),
      '--db-path', dbPath,
    );
    expect(result.code).not.toBe(0);
    expect(parseOutput(result)).toMatchObject({ ok: false, error: expect.stringContaining('sessions') });
  });

  test('unknown sessionId exits non-zero', () => {
    const result = run(
      '--session-id', 'no-such-session',
      '--run-id', 'run-1',
      '--sessions-path', sessionsPath,
      '--db-path', dbPath,
    );
    expect(result.code).not.toBe(0);
    expect(parseOutput(result)).toMatchObject({ ok: false, error: expect.stringContaining('no-such-session') });
  });
});

describe('createPhaseHandlers — dependency checker auth wiring (issue #217)', () => {
  // RSA keypair used to satisfy the GitHub App JWT signing path.
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  // Mocked HTTP transport that records calls and returns a queued response.
  function mockHttp(responses) {
    const calls = [];
    let i = 0;
    const fn = async (url, opts) => {
      calls.push({ url, opts });
      return responses[i++] ?? { status: 500, statusText: 'unexpected', body: '' };
    };
    fn.calls = calls;
    return fn;
  }

  const tokenResponse = {
    status: 201,
    statusText: 'Created',
    body: JSON.stringify({ token: 'ghs_inst00000000000000000000000', expires_at: '2030-01-01T00:00:00Z' }),
  };

  function resolvedSession(auth) {
    return {
      ...SESSION,
      repoRoot,
      artifactRoot: join(repoRoot, '.n8n-artifacts'),
      githubOwner: 'm2dw',
      githubName: 'thunderbird-auth-results-filter',
      workItemProvider: { provider: 'github-issues', auth },
      repoHostProvider: { provider: 'github', auth: { mode: 'gh' } },
    };
  }

  test('github-app session defers the dependency-checker token exchange until getBlockedBy()', async () => {
    const http = mockHttp([tokenResponse]);
    const context = {
      session: resolvedSession({
        mode: 'github-app',
        appIdEnv: 'APP_ID',
        installationIdEnv: 'INST_ID',
        privateKeyPathEnv: 'KEY_PATH',
      }),
      runId: 'run-app',
      workerId: 'test',
    };

    const handlers = await createPhaseHandlers(context, {
      env: { APP_ID: '123456', INST_ID: '789', KEY_PATH: '/key.pem' },
      readFile: () => privateKey,
      httpPostJson: http,
    });

    // Building handlers must NOT resolve/exchange a GitHub App token: the
    // dependency checker is only needed once implementation calls getBlockedBy(),
    // so idle/research/review-only or no-handler runs never touch GitHub. (Earlier
    // this eagerly exchanged a token here, failing those no-op runs on a missing
    // credential or a transient token-exchange outage.)
    expect(typeof handlers.implementation).toBe('function');
    expect(http.calls).toHaveLength(0);
  });

  test('gh-mode session builds handlers without any token exchange', async () => {
    const http = mockHttp([]);
    const context = {
      session: resolvedSession({ mode: 'gh' }),
      runId: 'run-gh',
      workerId: 'test',
    };

    const handlers = await createPhaseHandlers(context, { httpPostJson: http });

    expect(typeof handlers.implementation).toBe('function');
    expect(http.calls).toHaveLength(0);
  });

  test('registers the refinement phase handler so admitted refinement tasks run on the normal tick (issue #869)', async () => {
    const context = {
      session: resolvedSession({ mode: 'gh' }),
      runId: 'run-refine',
      workerId: 'test',
    };

    const handlers = await createPhaseHandlers(context, {});

    expect(typeof handlers.refinement).toBe('function');
  });

  test('github-app refinement resolves the app-aware runner before any snapshot read and fails closed on exchange failure (issue #869 review)', async () => {
    // The token exchange is mocked to FAIL. The pin is twofold: invoking the
    // refinement handler attempts the App token exchange at all (before the
    // fix the snapshot source was built without a runner and fell back to raw
    // `execFileSync("gh", ...)`, bypassing github-app auth entirely), and the
    // exchange failure fails the task closed instead of letting the snapshot
    // read under an unrelated local `gh` account.
    const http = mockHttp([{ status: 500, statusText: 'exchange down', body: '' }]);
    const context = {
      session: resolvedSession({
        mode: 'github-app',
        appIdEnv: 'APP_ID',
        installationIdEnv: 'INST_ID',
        privateKeyPathEnv: 'KEY_PATH',
      }),
      runId: 'run-app-refine',
      workerId: 'test',
    };
    const handlers = await createPhaseHandlers(context, {
      env: { APP_ID: '123456', INST_ID: '789', KEY_PATH: '/key.pem' },
      readFile: () => privateKey,
      httpPostJson: http,
    });
    // Building the handler map still exchanges nothing (deferral pinned above).
    expect(http.calls).toHaveLength(0);

    const task = { sessionId: 'addon-dev', issueNumber: 500, phase: 'refinement', status: 'running', context: {} };
    await expect(handlers.refinement(task)).rejects.toThrow();
    expect(http.calls.length).toBeGreaterThan(0);
  });

  test('a non-GitHub work-item session parks refinement for an operator instead of failing it (issue #869 review)', async () => {
    // A throw here would become a `failed` task via runHandler, which §17
    // forbids for the refinement lane: the marker label stays on the work item
    // with no ready_for_human recovery surface. `blocked` routes to
    // `ready_for_human` (transitions.ts) without shelling raw gh.
    const context = {
      session: {
        ...resolvedSession({ mode: 'gh' }),
        workItemProvider: {
          provider: 'gitea-issues',
          auth: { mode: 'api-token', tokenEnv: 'GITEA_TOKEN' },
          gitea: { baseUrl: 'https://gitea.example.com', owner: 'ai-private', repo: 'work-items' },
        },
      },
      runId: 'run-gitea-refine',
      workerId: 'test',
    };
    const handlers = await createPhaseHandlers(context, { env: { GITEA_TOKEN: 'tok-secret' } });

    const task = { sessionId: 'addon-dev', issueNumber: 500, phase: 'refinement', status: 'running', context: {} };
    const result = await handlers.refinement(task);
    expect(result.result).toBe('blocked');
    expect(result.message).toMatch(/gitea-issues/);
  });

  test('gitea-issues session builds handlers and defers Gitea provider/token resolution (issue #382)', async () => {
    // The dependency checker for a Gitea session reads `blocked by` from Gitea
    // over its REST API (not the GitHub GraphQL checker, which would always throw
    // for a non-GitHub provider and force every Gitea implementation closed). The
    // Gitea provider — and its API-token resolution — must be built lazily, only
    // when getBlockedBy() actually runs, so building handlers performs no Gitea
    // HTTP or token resolution (mirroring the github-app deferral above).
    const calls = [];
    const giteaHttp = (req) => {
      calls.push(req);
      return { status: 200, statusText: 'OK', body: '[]' };
    };
    const context = {
      session: {
        ...resolvedSession({ mode: 'gh' }),
        workItemProvider: {
          provider: 'gitea-issues',
          auth: { mode: 'api-token', tokenEnv: 'GITEA_TOKEN' },
          gitea: { baseUrl: 'https://gitea.example.com', owner: 'ai-private', repo: 'work-items' },
        },
      },
      runId: 'run-gitea',
      workerId: 'test',
    };

    const handlers = await createPhaseHandlers(context, { env: { GITEA_TOKEN: 'tok-secret' } }, giteaHttp);

    expect(typeof handlers.implementation).toBe('function');
    // No eager Gitea HTTP request and no token resolution at construction time.
    expect(calls).toHaveLength(0);
  });
});

describe('acquireIssuePhaseLock — refinement serialization (issue #869 review)', () => {
  const task = (overrides = {}) => ({
    sessionId: 'addon-dev',
    issueNumber: 500,
    phase: 'refinement',
    status: 'running',
    ...overrides,
  });

  test('refinement takes the per-issue lock, so a second run for the same issue contends instead of double-running', () => {
    // The refinement loop can outlive the 30-minute task lease (multiple
    // bounded agent invocations across rounds and retries); once the lease
    // expires, claimNextTask would hand the same issue to a second tick. The
    // issue-scoped lock is what serializes them.
    const lock = new IssueWorktreeLock(mkdtempSync(join(tmpdir(), 'issue-lock-')));

    const first = acquireIssuePhaseLock(lock, 'ctx-a', task());
    expect(first).toMatchObject({ ok: true, acquired: true });

    const second = acquireIssuePhaseLock(lock, 'ctx-b', task());
    expect(second).toMatchObject({ ok: true, acquired: false, ownerContextId: 'ctx-a' });
    expect(second.reason).toContain('already running');

    // A different issue is a different lock scope and stays parallel.
    const otherIssue = acquireIssuePhaseLock(lock, 'ctx-b', task({ issueNumber: 501 }));
    expect(otherIssue).toMatchObject({ ok: true, acquired: true });

    // Release frees the scope for the next refinement run.
    first.handle.release();
    const third = acquireIssuePhaseLock(lock, 'ctx-b', task());
    expect(third).toMatchObject({ ok: true, acquired: true });
  });

  test('research keeps its no-op acquisition — never serialized, never blocked by a held refinement lock', () => {
    const lock = new IssueWorktreeLock(mkdtempSync(join(tmpdir(), 'issue-lock-')));
    expect(acquireIssuePhaseLock(lock, 'ctx-a', task()).acquired).toBe(true);

    const research = acquireIssuePhaseLock(lock, 'ctx-b', task({ phase: 'research' }));
    expect(research).toMatchObject({ ok: true, acquired: true });
  });
});

describe('PhaseHandlerContext shape', () => {
  test('createPhaseHandlers receives session with repoRoot after session resolution', async () => {
    // Verify the factory extension point: a future handler implementation
    // should be able to access session.repoRoot as execution cwd.
    // We test this by confirming the resolved session carries the field
    // and that the registry/CLI wiring is in place.
    writeFileSync(sessionsPath, JSON.stringify({ sessions: [SESSION] }), 'utf8');
    const registry = new JsonSessionRegistry(sessionsPath);
    const session = await registry.getSessionById('addon-dev');

    expect(session).toBeDefined();
    expect(session.repoRoot).toBe('/Users/moto/git/thunderbird-auth-results-filter');
    expect(session.artifactRoot).toBe('/Users/moto/git/thunderbird-auth-results-filter/.n8n-artifacts');
    expect(session.githubOwner).toBe('m2dw');
    expect(session.githubName).toBe('thunderbird-auth-results-filter');
  });
});

describe('run-one-phase CLI task outcomes', () => {
  test('idle when no tasks are queued — exits 0', () => {
    const result = run(
      '--session-id', 'addon-dev',
      '--run-id', 'run-1',
      '--sessions-path', sessionsPath,
      '--db-path', dbPath,
    );
    expect(result.code).toBe(0);
    expect(parseOutput(result)).toMatchObject({ ok: true, outcome: 'idle', sessionId: 'addon-dev' });
  });

  test('queued task with no handler moves to ready_for_human — exits 0', async () => {
    // Use 'planner' phase — no handler registered, so the missing-handler path fires.
    const store = new SqliteTaskStore(dbPath);
    await store.enqueueTask({
      sessionId: 'addon-dev',
      issueNumber: 134,
      phase: 'planner',
      now: '2026-06-07T00:00:00.000Z',
    });
    store.close();

    const result = run(
      '--session-id', 'addon-dev',
      '--run-id', 'run-1',
      '--sessions-path', sessionsPath,
      '--db-path', dbPath,
      '--supported-phases', 'planner',
    );
    expect(result.code).toBe(0);
    const out = parseOutput(result);
    expect(out).toMatchObject({
      ok: true,
      outcome: 'phase_missing',
      task: { issueNumber: 134, status: 'ready_for_human' },
    });

    // Verify task is persisted to ready_for_human in the DB.
    const store2 = new SqliteTaskStore(dbPath);
    const task = await store2.getTask({ sessionId: 'addon-dev', issueNumber: 134 });
    store2.close();
    expect(task?.status).toBe('ready_for_human');
  });
});

describe('run-one-phase CLI — supported phase gating', () => {
  test('leaves unsupported queued task untouched and exits 0 with idle', async () => {
    const store = new SqliteTaskStore(dbPath);
    await store.enqueueTask({ sessionId: 'addon-dev', issueNumber: 200, phase: 'implementation', now: '2026-06-07T00:00:00.000Z' });
    store.close();

    const result = run(
      '--session-id', 'addon-dev', '--run-id', 'run-gating',
      '--sessions-path', sessionsPath, '--db-path', dbPath,
      '--supported-phases', 'research',
    );
    expect(result.code).toBe(0);
    const out = parseOutput(result);
    expect(out).toMatchObject({ ok: true, outcome: 'idle' });

    const store2 = new SqliteTaskStore(dbPath);
    const task = await store2.getTask({ sessionId: 'addon-dev', issueNumber: 200 });
    store2.close();
    expect(task?.status).toBe('queued');
  });

  test('processes supported research when unsupported tasks also exist', async () => {
    const store = new SqliteTaskStore(dbPath);
    // Mix: one unsupported (implementation) and one supported (research)
    await store.enqueueTask({ sessionId: 'addon-dev', issueNumber: 201, phase: 'implementation', now: '2026-06-07T00:00:00.000Z' });
    await store.enqueueTask({ sessionId: 'addon-dev', issueNumber: 202, phase: 'research', now: '2026-06-07T00:00:01.000Z' });
    store.close();

    const result = run(
      '--session-id', 'addon-dev', '--run-id', 'run-gating2',
      '--sessions-path', sessionsPath, '--db-path', dbPath,
      '--supported-phases', 'research',
    );
    expect(result.code).toBe(0);
    // Research task is claimed and processed
    expect(parseOutput(result)).toMatchObject({ ok: true, outcome: 'completed', task: { issueNumber: 202 } });

    const store2 = new SqliteTaskStore(dbPath);
    const t201 = await store2.getTask({ sessionId: 'addon-dev', issueNumber: 201 });
    const t202 = await store2.getTask({ sessionId: 'addon-dev', issueNumber: 202 });
    store2.close();
    // Unsupported implementation task must remain queued
    expect(t201?.status).toBe('queued');
    // Research task moved to ready_for_human (research success transition)
    expect(t202?.status).toBe('ready_for_human');
  });

  test('quota/rate-limit research failure exits 0 with delayed outcome and notBefore', async () => {
    // The repo cwd must exist so the (failing) agy actually runs and emits its
    // quota message rather than a spawn ENOENT.
    mkdirSync(repoRoot, { recursive: true });
    // Fake agy simulating quota exhaustion: nonzero exit + a rate-limit message.
    // Resolved via PATH under its real name (cmdSource "cli-default"), not
    // ANTIGRAVITY_BIN — see runWithAgyOnPath.
    const binDir = join(tmpDir, 'bin');
    mkdirSync(binDir, { recursive: true });
    const agyPath = join(binDir, 'agy');
    writeFileSync(agyPath, '#!/bin/sh\necho "Error: HTTP 429 rate limit exceeded, try again later" 1>&2\nexit 1\n', 'utf8');
    chmodSync(agyPath, 0o755);

    const store = new SqliteTaskStore(dbPath);
    await store.enqueueTask({ sessionId: 'addon-dev', issueNumber: 250, phase: 'research', now: '2026-06-07T00:00:00.000Z' });
    store.close();

    const result = runWithAgyOnPath(
      binDir,
      '--session-id', 'addon-dev', '--run-id', 'run-delayed',
      '--sessions-path', sessionsPath, '--db-path', dbPath,
      '--supported-phases', 'research',
    );
    // Exit 0 so n8n does not treat temporary quota exhaustion as a workflow crash.
    expect(result.code).toBe(0);
    const out = parseOutput(result);
    expect(out).toMatchObject({ ok: true, outcome: 'delayed', task: { issueNumber: 250, status: 'queued' } });
    expect(typeof out.notBefore).toBe('string');

    const store2 = new SqliteTaskStore(dbPath);
    const t = await store2.getTask({ sessionId: 'addon-dev', issueNumber: 250 });
    store2.close();
    // Task is held queued with the delay window recorded in SQLite (source of truth).
    expect(t.status).toBe('queued');
    expect(t.notBefore).toBe(out.notBefore);
    expect(Date.parse(t.notBefore)).toBeGreaterThan(Date.parse('2026-06-07T00:00:00.000Z'));
  });

  test('invalid --supported-phases exits non-zero', () => {
    const result = run(
      '--session-id', 'addon-dev', '--run-id', 'r',
      '--sessions-path', sessionsPath, '--db-path', dbPath,
      '--supported-phases', 'bogus',
    );
    expect(result.code).not.toBe(0);
    expect(parseOutput(result)).toMatchObject({ ok: false, error: expect.stringContaining('bogus') });
  });

  test('idle output includes supportedPhases', async () => {
    const result = run(
      '--session-id', 'addon-dev', '--run-id', 'r',
      '--sessions-path', sessionsPath, '--db-path', dbPath,
      '--supported-phases', 'research',
    );
    expect(result.code).toBe(0);
    expect(parseOutput(result)).toMatchObject({ ok: true, outcome: 'idle', supportedPhases: ['research'] });
  });
});

describe('run-one-phase CLI — contextId', () => {
  test('idle output includes contextId when --context-id is provided', () => {
    const result = run(
      '--session-id', 'addon-dev',
      '--run-id', 'run-ctx-1',
      '--context-id', 'parent-exec-42',
      '--sessions-path', sessionsPath,
      '--db-path', dbPath,
      '--supported-phases', 'research',
    );
    expect(result.code).toBe(0);
    expect(parseOutput(result)).toMatchObject({
      ok: true,
      outcome: 'idle',
      contextId: 'parent-exec-42',
    });
  });

  test('idle output omits contextId when --context-id is not provided', () => {
    const result = run(
      '--session-id', 'addon-dev',
      '--run-id', 'run-ctx-2',
      '--sessions-path', sessionsPath,
      '--db-path', dbPath,
      '--supported-phases', 'research',
    );
    expect(result.code).toBe(0);
    const out = parseOutput(result);
    expect(out).toMatchObject({ ok: true, outcome: 'idle' });
    expect(out).not.toHaveProperty('contextId');
  });

  test('completed output includes contextId when --context-id is provided', async () => {
    const store = new SqliteTaskStore(dbPath);
    await store.enqueueTask({
      sessionId: 'addon-dev',
      issueNumber: 400,
      phase: 'research',
      now: '2026-06-08T00:00:00.000Z',
    });
    store.close();

    const result = run(
      '--session-id', 'addon-dev',
      '--run-id', 'run-ctx-3',
      '--context-id', 'parent-exec-99',
      '--sessions-path', sessionsPath,
      '--db-path', dbPath,
      '--supported-phases', 'research',
    );
    expect(result.code).toBe(0);
    expect(parseOutput(result)).toMatchObject({
      ok: true,
      outcome: 'completed',
      contextId: 'parent-exec-99',
    });
  });
});

describe('run-one-phase CLI — outbox wiring', () => {
  test('research task completion enqueues outbox entries in the DB', async () => {
    // Enqueue a research task
    const store = new SqliteTaskStore(dbPath);
    await store.enqueueTask({
      sessionId: 'addon-dev',
      issueNumber: 300,
      phase: 'research',
      now: '2026-06-07T00:00:00.000Z',
    });
    store.close();

    // Run the CLI with fake agy (exits 0, prints stub output)
    const result = run(
      '--session-id', 'addon-dev',
      '--run-id', 'run-outbox-test',
      '--sessions-path', sessionsPath,
      '--db-path', dbPath,
      '--supported-phases', 'research',
    );
    expect(result.code).toBe(0);
    expect(parseOutput(result)).toMatchObject({ ok: true, outcome: 'completed' });

    // Verify outbox entries were written to the same DB
    const outbox = new SqliteOutboxStore(dbPath);
    const pending = await outbox.listPending();
    outbox.close();

    // research success → ready_for_human → label effects should be enqueued.
    // (research is not in the comment-effect list, but label effects always fire)
    expect(pending.length).toBeGreaterThan(0);
    const topics = pending.map(e => e.topic);
    expect(topics).toContain('gh:label:add');
  });

  test('CLI still exits 0 even when outbox entries already present (idempotency)', async () => {
    // Pre-seed the DB with the outbox store so migration runs
    const outbox = new SqliteOutboxStore(dbPath);
    outbox.close();

    const store = new SqliteTaskStore(dbPath);
    await store.enqueueTask({
      sessionId: 'addon-dev',
      issueNumber: 301,
      phase: 'research',
      now: '2026-06-07T00:00:00.000Z',
    });
    store.close();

    const result = run(
      '--session-id', 'addon-dev',
      '--run-id', 'run-outbox-idem',
      '--sessions-path', sessionsPath,
      '--db-path', dbPath,
      '--supported-phases', 'research',
    );
    expect(result.code).toBe(0);
    expect(parseOutput(result)).toMatchObject({ ok: true, outcome: 'completed' });
  });
});

describe('run-one-phase CLI — contextId-only resolution (no --session-id)', () => {
  test('--context-id alone resolves sessionId from context store (idle path)', () => {
    // Pre-seed the context store with contextId → sessionId mapping
    const ctxStore = new SqliteContextStore(dbPath);
    ctxStore.upsert('exec-standalone-1', 'addon-dev');
    ctxStore.close();

    const result = run(
      '--context-id', 'exec-standalone-1',
      '--sessions-path', sessionsPath,
      '--db-path', dbPath,
    );
    expect(result.code).toBe(0);
    expect(parseOutput(result)).toMatchObject({
      ok: true,
      outcome: 'idle',
      sessionId: 'addon-dev',
      contextId: 'exec-standalone-1',
    });
  });

  test('--context-id alone with unknown contextId exits non-zero', () => {
    const result = run(
      '--context-id', 'no-such-context',
      '--sessions-path', sessionsPath,
      '--db-path', dbPath,
    );
    expect(result.code).not.toBe(0);
    expect(parseOutput(result)).toMatchObject({ ok: false, error: expect.stringContaining('no-such-context') });
  });

  test('--context-id alone processes a task (completed path)', async () => {
    // Pre-seed context store
    const ctxStore = new SqliteContextStore(dbPath);
    ctxStore.upsert('exec-standalone-2', 'addon-dev');
    ctxStore.close();

    // Enqueue a research task
    const store = new SqliteTaskStore(dbPath);
    await store.enqueueTask({
      sessionId: 'addon-dev',
      issueNumber: 500,
      phase: 'research',
      now: '2026-06-11T00:00:00.000Z',
    });
    store.close();

    const result = run(
      '--context-id', 'exec-standalone-2',
      '--sessions-path', sessionsPath,
      '--db-path', dbPath,
      '--supported-phases', 'research',
    );
    expect(result.code).toBe(0);
    expect(parseOutput(result)).toMatchObject({
      ok: true,
      outcome: 'completed',
      sessionId: 'addon-dev',
      contextId: 'exec-standalone-2',
      task: { issueNumber: 500 },
    });
  });
});

describe('run-one-phase CLI — report-only mode admission (issue #532)', () => {
  function writeReportOnlySession() {
    const session = { ...SESSION, repoRoot, artifactDir: '.n8n-artifacts', reportOnly: { enabled: true } };
    writeFileSync(sessionsPath, JSON.stringify({ sessions: [session] }), 'utf8');
  }

  test('blocks a queued implementation task before any lock/worktree/handler side effect', async () => {
    writeReportOnlySession();
    const store = new SqliteTaskStore(dbPath);
    await store.enqueueTask({ sessionId: 'addon-dev', issueNumber: 600, phase: 'implementation', now: '2026-07-28T00:00:00.000Z' });
    store.close();

    const result = run(
      '--session-id', 'addon-dev', '--run-id', 'run-report-only-1',
      '--sessions-path', sessionsPath, '--db-path', dbPath,
      '--supported-phases', 'implementation',
    );
    expect(result.code).toBe(0);
    const out = parseOutput(result);
    expect(out).toMatchObject({ ok: true, outcome: 'completed', result: 'blocked', task: { issueNumber: 600 } });

    const store2 = new SqliteTaskStore(dbPath);
    const task = await store2.getTask({ sessionId: 'addon-dev', issueNumber: 600 });
    store2.close();
    // Dependency-blocked-style hold (transitions.ts): eligible for re-enqueue,
    // never touched the branch/worktree/agent.
    expect(task?.status).toBe('blocked');
    expect(task?.context.worktreeId).toBeUndefined();
    expect(task?.context.worktreePath).toBeUndefined();
    expect(task?.context.branch).toBeUndefined();
    expect(task?.context.prUrl).toBeUndefined();
  });

  test('blocks a queued conflict_resolution task', async () => {
    writeReportOnlySession();
    const store = new SqliteTaskStore(dbPath);
    await store.enqueueTask({ sessionId: 'addon-dev', issueNumber: 601, phase: 'conflict_resolution', now: '2026-07-28T00:00:00.000Z' });
    store.close();

    const result = run(
      '--session-id', 'addon-dev', '--run-id', 'run-report-only-2',
      '--sessions-path', sessionsPath, '--db-path', dbPath,
      '--supported-phases', 'conflict_resolution',
    );
    expect(result.code).toBe(0);
    const out = parseOutput(result);
    expect(out).toMatchObject({ ok: true, outcome: 'completed', result: 'blocked', task: { issueNumber: 601 } });

    const store2 = new SqliteTaskStore(dbPath);
    const task = await store2.getTask({ sessionId: 'addon-dev', issueNumber: 601 });
    store2.close();
    // Dependency-blocked-style hold (transitions.ts, issue #532 review): stays
    // resumable so intake can reactivate it once report-only mode is disabled,
    // instead of a terminal ready_for_human handoff that would strand it.
    expect(task?.status).toBe('blocked');
  });

  test('does not block research when the session is in report-only mode', async () => {
    writeReportOnlySession();
    const store = new SqliteTaskStore(dbPath);
    await store.enqueueTask({ sessionId: 'addon-dev', issueNumber: 602, phase: 'research', now: '2026-07-28T00:00:00.000Z' });
    store.close();

    const result = run(
      '--session-id', 'addon-dev', '--run-id', 'run-report-only-3',
      '--sessions-path', sessionsPath, '--db-path', dbPath,
      '--supported-phases', 'research',
    );
    expect(result.code).toBe(0);
    expect(parseOutput(result)).toMatchObject({ ok: true, outcome: 'completed', result: 'success', task: { issueNumber: 602 } });
  });
});
