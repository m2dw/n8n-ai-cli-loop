/**
 * `admin session pause|resume|status` (issue #531): session-level pause /
 * circuit-breaker operator surface, plus the run-one-phase pause gate
 * end-to-end (a paused session claims nothing; no GitHub label involved).
 */
import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SqliteTaskStore, SqliteSessionControlStore } from '../dist/index.js';

const CLI = new URL('../dist/cli/admin.js', import.meta.url).pathname;
const RUN_ONE_PHASE_CLI = new URL('../dist/cli/run-one-phase.js', import.meta.url).pathname;

const NOW = '2026-07-28T10:00:00.000Z';

let tmpDir;
let dbPath;
let sessionsPath;

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

function writeSession() {
  const session = {
    sessionId: 'addon-dev',
    repoKey: 'some-repo',
    repoRoot: join(tmpDir, 'repo'),
    githubRepo: 'm2dw/some-repo',
    artifactDir: '.n8n-artifacts',
    defaults: { implementationAgent: 'claude', reviewAgent: 'codex' },
    verification: {},
    labels: { active: 'ai:active', blocked: 'ai:blocked', readyForHuman: 'ai:ready-for-human' },
  };
  writeFileSync(sessionsPath, JSON.stringify({ sessions: [session] }), 'utf8');
}

const common = () => ['--session-id', 'addon-dev', '--sessions-path', sessionsPath, '--db-path', dbPath];

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'admin-session-pause-'));
  dbPath = join(tmpDir, 'dev_loop.db');
  sessionsPath = join(tmpDir, 'sessions.json');
  writeSession();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('session pause', () => {
  test('pauses a session with a reason', () => {
    const result = run('session', 'pause', ...common(), '--reason', 'quota abuse', '--json');
    expect(result.code).toBe(0);
    const payload = parse(result);
    expect(payload).toMatchObject({ ok: true, sessionId: 'addon-dev', paused: true, alreadyPaused: false, reason: 'quota abuse' });

    const store = new SqliteSessionControlStore(dbPath);
    return store
      .getPauseState('addon-dev')
      .then((state) => {
        expect(state).toMatchObject({ paused: true, reason: 'quota abuse', source: 'operator', pausedBy: 'operator' });
      })
      .finally(() => store.close());
  });

  test('repeat pause reports alreadyPaused and updates the reason', () => {
    run('session', 'pause', ...common(), '--reason', 'first', '--json');
    const payload = parse(run('session', 'pause', ...common(), '--reason', 'second', '--json'));
    expect(payload).toMatchObject({ ok: true, alreadyPaused: true, reason: 'second' });
  });

  test('rejects an unknown session', () => {
    const result = run('session', 'pause', '--session-id', 'nope', '--sessions-path', sessionsPath, '--db-path', dbPath, '--json');
    expect(result.code).toBe(1);
    expect(parse(result).ok).toBe(false);
  });

  test('human output is readable by default', () => {
    const result = run('session', 'pause', ...common(), '--reason', 'stop');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Paused session addon-dev');
    expect(result.stdout).toContain('stop');
  });
});

describe('session resume', () => {
  test('resumes a paused session', () => {
    run('session', 'pause', ...common(), '--reason', 'hold', '--json');
    const payload = parse(run('session', 'resume', ...common(), '--json'));
    expect(payload).toMatchObject({ ok: true, resumed: true, previous: { reason: 'hold', source: 'operator' } });
  });

  test('resume on an unpaused session is a safe no-op (exit 0)', () => {
    const result = run('session', 'resume', ...common(), '--json');
    expect(result.code).toBe(0);
    expect(parse(result)).toMatchObject({ ok: true, resumed: false });
  });
});

describe('session status', () => {
  test('shows unpaused state with no runs', () => {
    const payload = parse(run('session', 'status', ...common(), '--json'));
    expect(payload).toMatchObject({ ok: true, sessionId: 'addon-dev', paused: false });
    expect(payload.circuitBreaker).toMatchObject({ consecutiveFailures: 0, wouldPauseNow: false });
    expect(payload.recentRuns).toEqual([]);
  });

  test('is read-only: an absent DB is reported as empty, never created', () => {
    const missingDb = join(tmpDir, 'no-such-dir', 'missing.db');
    const result = run('session', 'status', '--session-id', 'addon-dev', '--sessions-path', sessionsPath, '--db-path', missingDb, '--json');
    expect(result.code).toBe(0);
    const payload = parse(result);
    expect(payload).toMatchObject({ ok: true, sessionId: 'addon-dev', paused: false });
    expect(payload.recentRuns).toEqual([]);
    expect(existsSync(missingDb)).toBe(false);
    expect(existsSync(join(tmpDir, 'no-such-dir'))).toBe(false);

    const human = run('session', 'status', '--session-id', 'addon-dev', '--sessions-path', sessionsPath, '--db-path', missingDb);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain('active (not paused)');
    expect(human.stdout).toContain('Recent runs: none recorded');
    expect(existsSync(missingDb)).toBe(false);
  });

  test('shows pause reason and source', () => {
    run('session', 'pause', ...common(), '--reason', 'investigating lock bug', '--json');
    const payload = parse(run('session', 'status', ...common(), '--json'));
    expect(payload).toMatchObject({ paused: true, reason: 'investigating lock bug', source: 'operator' });

    const human = run('session', 'status', ...common());
    expect(human.stdout).toContain('PAUSED');
    expect(human.stdout).toContain('investigating lock bug');
    expect(human.stdout).toContain('admin session resume');
  });

  test('reports circuit-breaker standing and recent runs from the ledger', async () => {
    const store = new SqliteSessionControlStore(dbPath);
    try {
      for (let i = 0; i < 5; i++) {
        await store.recordRun({
          sessionId: 'addon-dev',
          issueNumber: 100 + i,
          phase: 'implementation',
          outcome: 'failed',
          durationMs: 1000,
          agent: 'claude',
          createdAt: NOW,
        });
      }
    } finally {
      store.close();
    }

    const payload = parse(run('session', 'status', ...common(), '--json'));
    expect(payload.circuitBreaker).toMatchObject({
      consecutiveFailures: 5,
      wouldPauseNow: true,
      rule: 'session_consecutive_failures',
    });
    expect(payload.recentRuns).toHaveLength(5);
    expect(payload.recentRuns[0]).toMatchObject({ issueNumber: 104, outcome: 'failed', agent: 'claude' });

    const human = run('session', 'status', ...common());
    expect(human.stdout).toContain('Would pause now: yes');
  });

  test('honors --limit for recent runs', async () => {
    const store = new SqliteSessionControlStore(dbPath);
    try {
      for (let i = 0; i < 4; i++) {
        await store.recordRun({
          sessionId: 'addon-dev', issueNumber: i, phase: 'research', outcome: 'success', createdAt: NOW,
        });
      }
    } finally {
      store.close();
    }
    const payload = parse(run('session', 'status', ...common(), '--limit', '2', '--json'));
    expect(payload.recentRuns).toHaveLength(2);
  });

  test('rejects an invalid --limit', () => {
    const result = run('session', 'status', ...common(), '--limit', '0', '--json');
    expect(result.code).toBe(1);
  });
});

describe('run-one-phase pause gate (end-to-end)', () => {
  function runPhase(...args) {
    try {
      const stdout = execFileSync(process.execPath, [RUN_ONE_PHASE_CLI, ...args], { encoding: 'utf8' });
      return { code: 0, stdout };
    } catch (err) {
      return { code: err.status ?? 1, stdout: err.stdout ?? '' };
    }
  }

  test('a paused session claims and executes no work', async () => {
    const tasks = new SqliteTaskStore(dbPath);
    try {
      await tasks.enqueueTask({ sessionId: 'addon-dev', issueNumber: 55, phase: 'research', now: NOW });
    } finally {
      tasks.close();
    }
    run('session', 'pause', ...common(), '--reason', 'maintenance window', '--json');

    const result = runPhase(
      '--session-id', 'addon-dev',
      '--run-id', 'run-paused-1',
      '--sessions-path', sessionsPath,
      '--db-path', dbPath,
    );
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout.trim());
    expect(payload).toMatchObject({
      ok: true,
      outcome: 'paused',
      sessionId: 'addon-dev',
      reason: 'maintenance window',
      source: 'operator',
    });

    // The queued task was never claimed.
    const verify = new SqliteTaskStore(dbPath);
    try {
      const task = await verify.getTask({ sessionId: 'addon-dev', issueNumber: 55 });
      expect(task.status).toBe('queued');
      expect(task.ownerRunId).toBeUndefined();
      expect(await verify.listEvents({ sessionId: 'addon-dev', issueNumber: 55 })).toEqual([]);
    } finally {
      verify.close();
    }
  });

  test('the gate lifts after resume', () => {
    // Empty queue: a paused session reports `paused` BEFORE looking at the
    // queue, while a resumed one falls through to the normal `idle`.
    run('session', 'pause', ...common(), '--json');
    const whilePaused = runPhase(
      '--session-id', 'addon-dev', '--run-id', 'r1',
      '--sessions-path', sessionsPath, '--db-path', dbPath,
    );
    expect(JSON.parse(whilePaused.stdout.trim()).outcome).toBe('paused');

    run('session', 'resume', ...common(), '--json');
    const afterResume = runPhase(
      '--session-id', 'addon-dev', '--run-id', 'r2',
      '--sessions-path', sessionsPath, '--db-path', dbPath,
    );
    expect(afterResume.code).toBe(0);
    expect(JSON.parse(afterResume.stdout.trim()).outcome).toBe('idle');
  });
});
