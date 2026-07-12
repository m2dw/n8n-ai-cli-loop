import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SqliteTaskStore } from '../dist/index.js';

const CLI = new URL('../dist/cli/enqueue-task.js', import.meta.url).pathname;

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

function baseArgs() {
  return [
    '--session-id', 'addon-dev',
    '--issue-number', '134',
    '--phase', 'implementation',
    '--sessions-path', sessionsPath,
    '--db-path', dbPath,
  ];
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'enqueue-task-test-'));
  sessionsPath = join(tmpDir, 'sessions.json');
  dbPath = join(tmpDir, 'dev_loop.db');
  writeFileSync(sessionsPath, JSON.stringify({ sessions: [SESSION] }), 'utf8');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('enqueue-task CLI — required arg validation', () => {
  test('missing --session-id exits non-zero', () => {
    const r = run('--issue-number', '1', '--phase', 'implementation', '--sessions-path', sessionsPath, '--db-path', dbPath);
    expect(r.code).not.toBe(0);
    expect(parse(r)).toMatchObject({ ok: false });
  });

  test('missing --issue-number exits non-zero', () => {
    const r = run('--session-id', 'addon-dev', '--phase', 'implementation', '--sessions-path', sessionsPath, '--db-path', dbPath);
    expect(r.code).not.toBe(0);
    expect(parse(r)).toMatchObject({ ok: false });
  });

  test('missing --phase exits non-zero', () => {
    const r = run('--session-id', 'addon-dev', '--issue-number', '1', '--sessions-path', sessionsPath, '--db-path', dbPath);
    expect(r.code).not.toBe(0);
    expect(parse(r)).toMatchObject({ ok: false });
  });

  // Operator-safety (issue #401): unknown flags must be rejected even on a command
  // that has no --dry-run, so a typo can never be silently swallowed and the task
  // enqueued anyway.
  test('--dry-ru typo is rejected and nothing is enqueued', () => {
    const r = run(...baseArgs(), '--dry-ru');
    expect(r.code).not.toBe(0);
    expect(parse(r)).toMatchObject({ ok: false, error: expect.stringContaining('dry-ru') });

    const store = new SqliteTaskStore(dbPath);
    const tasks = store.listTasks('addon-dev', 134);
    store.close();
    expect(tasks).toHaveLength(0);
  });

  test('an unknown value-style flag is rejected', () => {
    const r = run(...baseArgs(), '--bogus', 'x');
    expect(r.code).not.toBe(0);
    expect(parse(r)).toMatchObject({ ok: false, error: expect.stringContaining('bogus') });
  });
});

describe('enqueue-task CLI — validation errors', () => {
  test('non-integer issue number exits non-zero', () => {
    const r = run('--session-id', 'addon-dev', '--issue-number', 'abc', '--phase', 'implementation', '--sessions-path', sessionsPath, '--db-path', dbPath);
    expect(r.code).not.toBe(0);
    expect(parse(r)).toMatchObject({ ok: false, error: expect.stringContaining('positive integer') });
  });

  test('zero issue number exits non-zero', () => {
    const r = run('--session-id', 'addon-dev', '--issue-number', '0', '--phase', 'implementation', '--sessions-path', sessionsPath, '--db-path', dbPath);
    expect(r.code).not.toBe(0);
  });

  test('invalid phase exits non-zero', () => {
    const r = run('--session-id', 'addon-dev', '--issue-number', '1', '--phase', 'bogus', '--sessions-path', sessionsPath, '--db-path', dbPath);
    expect(r.code).not.toBe(0);
    expect(parse(r)).toMatchObject({ ok: false, error: expect.stringContaining('--phase') });
  });

  test('invalid implementation-agent exits non-zero', () => {
    const r = run(...baseArgs(), '--implementation-agent', 'chatgpt');
    expect(r.code).not.toBe(0);
    expect(parse(r)).toMatchObject({ ok: false, error: expect.stringContaining('implementation-agent') });
  });

  test('invalid review-agent exits non-zero', () => {
    const r = run(...baseArgs(), '--review-agent', 'chatgpt');
    expect(r.code).not.toBe(0);
  });

  test('invalid research-agent exits non-zero', () => {
    const r = run(...baseArgs(), '--research-agent', 'chatgpt');
    expect(r.code).not.toBe(0);
  });

  test('invalid priority exits non-zero', () => {
    const r = run(...baseArgs(), '--priority', 'urgent');
    expect(r.code).not.toBe(0);
    expect(parse(r)).toMatchObject({ ok: false, error: expect.stringContaining('--priority') });
  });

  test('invalid context JSON exits non-zero', () => {
    const r = run(...baseArgs(), '--context-json', '{not json}');
    expect(r.code).not.toBe(0);
    expect(parse(r)).toMatchObject({ ok: false, error: expect.stringContaining('context-json') });
  });

  test('context JSON that is an array exits non-zero', () => {
    const r = run(...baseArgs(), '--context-json', '[1,2,3]');
    expect(r.code).not.toBe(0);
    expect(parse(r)).toMatchObject({ ok: false, error: expect.stringContaining('context-json') });
  });
});

describe('enqueue-task CLI — config errors', () => {
  test('missing sessions file exits non-zero', () => {
    const r = run(...baseArgs().map((a, i, arr) =>
      arr[i - 1] === '--sessions-path' ? join(tmpDir, 'missing.json') : a));
    expect(r.code).not.toBe(0);
  });

  test('unknown sessionId exits non-zero', () => {
    const r = run('--session-id', 'no-such', '--issue-number', '1', '--phase', 'implementation', '--sessions-path', sessionsPath, '--db-path', dbPath);
    expect(r.code).not.toBe(0);
    expect(parse(r)).toMatchObject({ ok: false, error: expect.stringContaining('no-such') });
  });
});

describe('enqueue-task CLI — successful enqueue', () => {
  test('enqueues task and prints ok JSON, exits 0', () => {
    const r = run(...baseArgs());
    expect(r.code).toBe(0);
    expect(parse(r)).toMatchObject({
      ok: true,
      code: 'enqueued',
      task: { sessionId: 'addon-dev', issueNumber: 134, phase: 'implementation', status: 'queued' },
    });
  });

  test('applies session defaults for missing agents', async () => {
    const r = run(...baseArgs());
    expect(r.code).toBe(0);
    const store = new SqliteTaskStore(dbPath);
    const task = await store.getTask({ sessionId: 'addon-dev', issueNumber: 134 });
    store.close();
    expect(task?.implementationAgent).toBe('claude');
    expect(task?.reviewAgent).toBe('codex');
    expect(task?.researchAgent).toBe('gemini');
  });

  test('explicit agents override session defaults', () => {
    const r = run(...baseArgs(), '--implementation-agent', 'gemini', '--review-agent', 'claude');
    expect(r.code).toBe(0);
    const store = new SqliteTaskStore(dbPath);
    return store.getTask({ sessionId: 'addon-dev', issueNumber: 134 }).then((task) => {
      expect(task?.implementationAgent).toBe('gemini');
      expect(task?.reviewAgent).toBe('claude');
      store.close();
    });
  });

  test('explicit agent flags are reflected in the persisted assignment', () => {
    // Phase handlers read context.assignment, so explicit CLI overrides must be
    // mirrored into the persisted assignment, not just the agent columns (#259).
    const r = run(...baseArgs(), '--implementation-agent', 'gemini', '--review-agent', 'claude');
    expect(r.code).toBe(0);
    const store = new SqliteTaskStore(dbPath);
    return store.getTask({ sessionId: 'addon-dev', issueNumber: 134 }).then((task) => {
      expect(task?.context?.assignment).toMatchObject({
        implementationAgent: 'gemini',
        reviewAgent: 'claude',
        // conflict_resolution is NOT overridden for non-Claude agents; falls back to session default.
        conflictResolutionAgent: 'claude',
      });
      store.close();
    });
  });

  test('an explicit assignment in --context-json wins over agent flags', () => {
    const pinned = JSON.stringify({
      assignment: { flow: 'code', implementationAgent: 'codex', reviewAgent: 'codex', conflictResolutionAgent: 'codex', resolvedAt: '2026-06-17T00:00:00.000Z', source: 'session-config' },
    });
    const r = run(...baseArgs(), '--implementation-agent', 'gemini', '--context-json', pinned);
    expect(r.code).toBe(0);
    const store = new SqliteTaskStore(dbPath);
    return store.getTask({ sessionId: 'addon-dev', issueNumber: 134 }).then((task) => {
      expect(task?.context?.assignment?.implementationAgent).toBe('codex');
      store.close();
    });
  });

  test('context-json is stored on the task', () => {
    const r = run(...baseArgs(), '--context-json', '{"prNumber":42}');
    expect(r.code).toBe(0);
    const store = new SqliteTaskStore(dbPath);
    return store.getTask({ sessionId: 'addon-dev', issueNumber: 134 }).then((task) => {
      expect(task?.context).toMatchObject({ prNumber: 42 });
      store.close();
    });
  });

  test('priority flag is respected', () => {
    const r = run(...baseArgs(), '--priority', 'high');
    expect(r.code).toBe(0);
    const store = new SqliteTaskStore(dbPath);
    return store.getTask({ sessionId: 'addon-dev', issueNumber: 134 }).then((task) => {
      expect(task?.priority).toBe('high');
      store.close();
    });
  });

  test('enqueued task can be observed by SqliteTaskStore.getTask', async () => {
    run(...baseArgs());
    const store = new SqliteTaskStore(dbPath);
    const task = await store.getTask({ sessionId: 'addon-dev', issueNumber: 134 });
    store.close();
    expect(task).toMatchObject({ sessionId: 'addon-dev', issueNumber: 134, status: 'queued', phase: 'implementation' });
  });
});

describe('enqueue-task CLI — duplicate enqueue', () => {
  test('duplicate enqueue returns already_exists JSON and exits 0', () => {
    run(...baseArgs());
    const r = run(...baseArgs());
    expect(r.code).toBe(0);
    expect(parse(r)).toMatchObject({ ok: false, code: 'already_exists' });
  });
});
