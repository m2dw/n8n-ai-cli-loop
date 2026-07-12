import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SqliteTaskStore, SqliteOutboxStore } from '../dist/index.js';

// Exercises the shared admin command framework (issue #309): the common
// option-parsing / session-resolution layer (src/cli/admin-command.ts) and the
// shared output helpers (src/cli/cli-io.ts), verified end-to-end through the
// migrated commands (task-status, recover-cap-handoff, tool-request *).

const CLI = new URL('../dist/cli/admin.js', import.meta.url).pathname;

let tmpDir;
let dbPath;
let sessionsPath;
let repoRoot;

function run(...args) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
    return { code: 0, stdout };
  } catch (err) {
    return { code: err.status ?? 1, stdout: err.stdout ?? '' };
  }
}

function parse(result) {
  return JSON.parse(result.stdout.trim());
}

// A session with both a sessionNo and an alias so every session-reference form
// (sessionId, sessionNo, alias) can be resolved through the shared selector.
function writeSession() {
  const session = {
    sessionId: 'addon-dev',
    sessionNo: 7,
    aliases: ['addon'],
    repoKey: 'some-repo',
    repoRoot,
    githubRepo: 'm2dw/some-repo',
    artifactDir: '.n8n-artifacts',
    defaults: { implementationAgent: 'claude', reviewAgent: 'codex' },
    verification: {},
    labels: { active: 'ai:active', blocked: 'ai:blocked', readyForHuman: 'ai:ready-for-human' },
  };
  writeFileSync(sessionsPath, JSON.stringify({ sessions: [session] }), 'utf8');
  return session;
}

async function seedToolRequestTask(issueNumber) {
  const store = new SqliteTaskStore(dbPath);
  await store.enqueueTask({ sessionId: 'addon-dev', issueNumber, phase: 'implementation', implementationAgent: 'claude' });
  await store.transitionTask(
    { sessionId: 'addon-dev', issueNumber },
    { status: 'queued' },
    {
      status: 'ready_for_human',
      phase: 'implementation',
      context: {
        labels: ['ai:ready-for-human', 'status:needs-implementation', 'agent:claude'],
        toolRequest: {
          command: 'npm install left-pad --token=SECRET123',
          displayCommand: 'npm install left-pad --token=***',
          reason: 'The fix depends on left-pad which is not a dependency yet.',
          expectedFiles: ['package.json', 'package-lock.json'],
          necessity: 'required',
          suggestedAction: 'dependencySync',
          requestedBy: 'claude',
          mode: 'new',
          requestedAt: '2026-06-07T00:00:00.000Z',
          resolved: false,
        },
      },
    },
  );
  store.close();
}

// A clean git checkout at repoRoot so the manual-done requeue preflight
// (`git status --porcelain`) sees a clean worktree.
function initCleanRepo() {
  mkdirSync(repoRoot, { recursive: true });
  const git = (...a) => execFileSync('git', a, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  writeFileSync(join(repoRoot, 'package.json'), '{"name":"x"}\n', 'utf8');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
}

async function getTask(issueNumber) {
  const store = new SqliteTaskStore(dbPath);
  const tasks = store.listTasks('addon-dev', issueNumber);
  store.close();
  return tasks[0];
}

async function getOutbox() {
  const store = new SqliteOutboxStore(dbPath);
  const entries = await store.listPending();
  store.close();
  return entries;
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'admin-framework-test-'));
  dbPath = join(tmpDir, 'dev_loop.db');
  sessionsPath = join(tmpDir, 'sessions.json');
  repoRoot = join(tmpDir, 'repo');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Shared session resolution: --session-ref works the same for every command.
// ---------------------------------------------------------------------------

describe('shared framework — session reference resolution', () => {
  test('tool-request list resolves --session-ref by alias to the canonical session', async () => {
    writeSession();
    await seedToolRequestTask(123);
    const r = run('tool-request', 'list', '--session-ref', 'addon', '--sessions-path', sessionsPath, '--db-path', dbPath);
    expect(r.code).toBe(0);
    const out = parse(r);
    expect(out).toMatchObject({ ok: true, sessionId: 'addon-dev', count: 1 });
    expect(out.toolRequests[0].issueNumber).toBe(123);
  });

  test('tool-request list resolves --session-ref by sessionNo', async () => {
    writeSession();
    await seedToolRequestTask(123);
    const r = run('tool-request', 'list', '--session-ref', '7', '--sessions-path', sessionsPath, '--db-path', dbPath);
    expect(r.code).toBe(0);
    expect(parse(r)).toMatchObject({ ok: true, sessionId: 'addon-dev', count: 1 });
  });

  test('tool-request list still accepts the canonical --session-id', async () => {
    writeSession();
    await seedToolRequestTask(123);
    const r = run('tool-request', 'list', '--session-id', 'addon-dev', '--db-path', dbPath);
    expect(r.code).toBe(0);
    expect(parse(r)).toMatchObject({ ok: true, sessionId: 'addon-dev', count: 1 });
  });

  test('unknown --session-ref exits non-zero with a clear error', () => {
    writeSession();
    const r = run('tool-request', 'list', '--session-ref', 'no-such-ref', '--sessions-path', sessionsPath, '--db-path', dbPath);
    expect(r.code).not.toBe(0);
    expect(parse(r)).toMatchObject({ ok: false, error: expect.stringContaining('Unknown session reference') });
  });

  test('providing both --session-id and --session-ref exits non-zero', () => {
    writeSession();
    const r = run('tool-request', 'list', '--session-id', 'addon-dev', '--session-ref', 'addon', '--sessions-path', sessionsPath, '--db-path', dbPath);
    expect(r.code).not.toBe(0);
    expect(parse(r)).toMatchObject({ ok: false, error: expect.stringContaining('only one') });
  });
});

// ---------------------------------------------------------------------------
// Missing required options surface through the shared parser.
// ---------------------------------------------------------------------------

describe('shared framework — missing required options', () => {
  test('tool-request list without a session selector errors on session-id', () => {
    const r = run('tool-request', 'list', '--db-path', dbPath);
    expect(r.code).not.toBe(0);
    expect(parse(r)).toMatchObject({ ok: false, error: expect.stringContaining('session-id') });
  });

  test('tool-request resolve without --issue-number errors on issue-number', () => {
    const r = run('tool-request', 'resolve', '--session-id', 'addon-dev', '--action', 'manual-done', '--db-path', dbPath);
    expect(r.code).not.toBe(0);
    expect(parse(r)).toMatchObject({ ok: false, error: expect.stringContaining('issue-number') });
  });

  test('tool-request grant rejects an invalid --issue-number', () => {
    const r = run('tool-request', 'grant', '--session-id', 'addon-dev', '--issue-number', 'abc', '--db-path', dbPath);
    expect(r.code).not.toBe(0);
    expect(parse(r)).toMatchObject({ ok: false, error: expect.stringContaining('issue-number') });
  });

  test('recover-cap-handoff rejects an invalid --phase via the shared parser', () => {
    const r = run('recover-cap-handoff', '--session-id', 'addon-dev', '--phase', 'bogus', '--db-path', dbPath, '--json');
    expect(r.code).not.toBe(0);
    expect(parse(r)).toMatchObject({ ok: false, error: expect.stringContaining('phase') });
  });
});

// ---------------------------------------------------------------------------
// Shared output helpers: human-readable default vs JSON via --json.
// ---------------------------------------------------------------------------

describe('shared framework — JSON/human output selection', () => {
  test('task-status defaults to human-readable text and is not JSON', async () => {
    writeSession();
    await seedToolRequestTask(123);
    const r = run('task-status', '--session-ref', 'addon', '--sessions-path', sessionsPath, '--db-path', dbPath);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('#123');
    expect(() => JSON.parse(r.stdout.trim())).toThrow();
  });

  test('task-status with --json emits a structured object', async () => {
    writeSession();
    await seedToolRequestTask(123);
    const r = run('task-status', '--session-ref', 'addon', '--sessions-path', sessionsPath, '--db-path', dbPath, '--json');
    expect(r.code).toBe(0);
    const out = parse(r);
    expect(out).toMatchObject({ ok: true, sessionId: 'addon-dev' });
    expect(out.tasks[0].issueNumber).toBe(123);
  });

  test('recover-cap-handoff defaults to human-readable text for the no-op case', () => {
    writeSession();
    const r = run('recover-cap-handoff', '--session-ref', 'addon', '--sessions-path', sessionsPath, '--db-path', dbPath);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('No recoverable tasks');
    expect(() => JSON.parse(r.stdout.trim())).toThrow();
  });
});

// ---------------------------------------------------------------------------
// A Tool Request command driven entirely through --session-ref.
// ---------------------------------------------------------------------------

describe('shared framework — Tool Request command via --session-ref', () => {
  test('tool-request resolve manual-done resolves and requeues using --session-ref', async () => {
    writeSession();
    initCleanRepo();
    // Issue #379: a usable continuation point must exist to requeue. With no origin
    // configured, a local issue branch carrying the landed side effects suffices.
    const git = (...a) => execFileSync('git', a, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    git('checkout', '-q', '-b', 'ai/issue-123');
    writeFileSync(join(repoRoot, 'package.json'), '{"name":"x","dependencies":{"left-pad":"^1.3.0"}}\n', 'utf8');
    git('commit', '-q', '-am', 'land tool request change');
    git('checkout', '-q', '-');
    await seedToolRequestTask(123);
    const r = run(
      'tool-request', 'resolve',
      '--session-ref', 'addon',
      '--issue-number', '123',
      '--action', 'manual-done',
      '--sessions-path', sessionsPath,
      '--db-path', dbPath,
    );
    expect(r.code).toBe(0);
    expect(parse(r)).toMatchObject({ ok: true, action: 'manual-done', status: 'queued', phase: 'implementation' });

    const task = await getTask(123);
    expect(task.status).toBe('queued');
    expect(task.phase).toBe('implementation');
    expect(task.context.toolRequest.resolved).toBe(true);

    const outbox = await getOutbox();
    const comment = outbox.find((e) => e.topic === 'gh:comment');
    expect(comment.payload.body).not.toContain('SECRET123');
  });
});
