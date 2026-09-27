/**
 * The admin CLI's real-executable contract (issue #1018).
 *
 * Every other admin suite now drives the dispatcher in-process through
 * `test/helpers/admin-cli.js`, which is faster but simulates three things it
 * cannot observe: the argv Node actually hands the program, the exit status a
 * shell or an n8n `Execute Command` node actually reads, and the two genuinely
 * distinct file descriptors stdout and stderr actually are.
 *
 * This suite is the smoke/contract set that keeps those real. It is deliberately
 * small — it spawns one process per case, so a case belongs here only when the
 * PROCESS BOUNDARY is the thing under assertion:
 *
 *   1. argv — the real executable parses real `process.argv` and rejects an
 *      unknown option instead of silently dropping it.
 *   2. exit codes — success is 0, a validation failure is non-zero, and the
 *      non-TTY `ui` refusal keeps its distinct code.
 *   3. streams — human-mode errors are on fd 2 and JSON stays on fd 1, verified
 *      with the descriptors separately piped.
 *   4. environment isolation — a fresh process reads the environment it was
 *      given, and the harness's env overrides do not leak into the parent.
 *
 * A behavioural case about what a command DECIDED does not belong here; add it
 * to the matching in-process suite instead.
 */
import { jest } from '@jest/globals';
import { execFileSync, spawnSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CLI_PROBE_STUB_ENV } from '../dist/core/cli-probe.js';
import { ADMIN_CLI_PATH, runAdmin } from './helpers/admin-cli.js';

// Every case here forks a real Node process; the default 5s is tight on a loaded
// runner (see the same allowance in the other spawn-touching suites).
jest.setTimeout(30_000);

let tmpDir;
let dbPath;

/** Spawn the real executable with stdout and stderr on separate pipes. */
function spawnAdmin(args, options = {}) {
  const r = spawnSync(process.execPath, [ADMIN_CLI_PATH, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'admin-cli-subprocess-'));
  dbPath = join(tmpDir, 'dev_loop.db');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('admin CLI executable — argv parsing', () => {
  test('the real executable parses real process.argv and exits 0 on help', () => {
    const r = spawnAdmin(['help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('task-status');
  });

  test('an unknown subcommand is rejected by the real executable', () => {
    const r = spawnAdmin(['bogus-command', '--json']);
    expect(r.code).not.toBe(0);
    expect(JSON.parse(r.stdout.trim())).toMatchObject({
      ok: false,
      error: expect.stringContaining('bogus-command'),
    });
  });

  // Operator safety (issue #401): a misspelled flag must never be swallowed by
  // the real argv path either, or a preview silently becomes a mutation.
  test('an unknown option is rejected rather than dropped', () => {
    const r = spawnAdmin([
      'recover', '--session-id', 'addon-dev', '--db-path', dbPath, '--dry-ru', '--json',
    ]);
    expect(r.code).not.toBe(0);
    expect(JSON.parse(r.stdout.trim())).toMatchObject({
      ok: false,
      error: expect.stringContaining('dry-ru'),
    });
  });

  test('an argument containing spaces survives argv without being re-split', () => {
    const r = spawnAdmin([
      'context', 'create', '--execution-id', 'exec with spaces',
      '--session-id', 'addon-dev', '--db-path', dbPath,
    ]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout.trim())).toMatchObject({ ok: true, contextId: 'exec with spaces' });
  });
});

describe('admin CLI executable — exit status', () => {
  test('a successful command exits 0', () => {
    const r = spawnAdmin(['task-status', '--session-id', 'addon-dev', '--db-path', dbPath]);
    expect(r.code).toBe(0);
  });

  test('a validation failure exits 1', () => {
    const r = spawnAdmin(['task-status', '--db-path', dbPath]);
    expect(r.code).toBe(1);
  });

  // `admin ui` degrades with its own code rather than the generic failure code,
  // so a wrapper can tell "cannot interact" apart from "the command failed".
  test('a non-TTY `ui` invocation exits with its own code, not the generic 1', () => {
    const r = spawnAdmin(['ui', '--db-path', dbPath]);
    expect(r.code).toBe(2);
    expect(r.stdout).not.toBe('');
  });
});

describe('admin CLI executable — stream separation', () => {
  test('human-mode errors are written to fd 2 and nothing lands on fd 1', () => {
    const r = spawnAdmin(['task-status', '--db-path', dbPath]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('session-id');
    expect(r.stdout.trim()).toBe('');
  });

  test('JSON-mode errors stay on fd 1 for machine callers, with fd 2 clean', () => {
    const r = spawnAdmin(['task-status', '--db-path', dbPath, '--json']);
    expect(r.code).not.toBe(0);
    expect(JSON.parse(r.stdout.trim())).toMatchObject({ ok: false });
    expect(r.stderr).toBe('');
  });

  test('a successful JSON command writes exactly one parseable line to fd 1', () => {
    const r = spawnAdmin([
      'context', 'create', '--execution-id', 'exec-fd', '--session-id', 'addon-dev', '--db-path', dbPath,
    ]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(r.stdout.trim())).toMatchObject({ ok: true, contextId: 'exec-fd' });
  });
});

describe('admin CLI executable — environment isolation', () => {
  test('the child reads the environment it was given, not this process\'s', () => {
    // A malformed probe stub is an unambiguous signal that the child read the
    // supplied environment: this process has no such variable, so the refusal
    // can only have come from the env handed to the spawn.
    expect(process.env[CLI_PROBE_STUB_ENV]).toBeUndefined();

    const sessionsPath = join(tmpDir, 'sessions.json');
    writeFileSync(sessionsPath, JSON.stringify({
      sessions: [{
        sessionId: 'addon-dev',
        repoKey: 'some-repo',
        repoRoot: tmpDir,
        githubRepo: 'm2dw/some-repo',
        artifactDir: '.n8n-artifacts',
        defaults: { implementationAgent: 'claude', reviewAgent: 'claude' },
        verification: {},
        labels: { active: 'ai:active', blocked: 'ai:blocked', readyForHuman: 'ai:ready-for-human' },
      }],
    }), 'utf8');

    const r = spawnAdmin(
      ['session-doctor', '--session-id', 'addon-dev', '--sessions-path', sessionsPath],
      { env: { ...process.env, [CLI_PROBE_STUB_ENV]: '{not json' } },
    );
    expect(r.code).not.toBe(0);
    expect(JSON.parse(r.stdout.trim())).toMatchObject({
      ok: false,
      error: expect.stringContaining(CLI_PROBE_STUB_ENV),
    });
    // And the spawn left nothing behind in this process.
    expect(process.env[CLI_PROBE_STUB_ENV]).toBeUndefined();
  });

  // The in-process harness mutates process.env for the duration of a run. This
  // pins that a spawned run is unaffected by that mechanism at all: the same
  // command in a fresh process sees only what the parent's environment holds.
  test('a spawned run is unaffected by in-process env overrides', async () => {
    const sentinel = 'ADMIN_CLI_HARNESS_SENTINEL';
    expect(process.env[sentinel]).toBeUndefined();
    await runAdmin(['help'], { env: { [sentinel]: 'set-during-run' } });
    expect(process.env[sentinel]).toBeUndefined();

    const r = spawnAdmin(['help']);
    expect(r.code).toBe(0);
  });

  test('the executable resolves its own path without a shell wrapper', () => {
    // execFileSync (no shell) is the shape n8n's Execute Command node uses.
    const stdout = execFileSync(process.execPath, [ADMIN_CLI_PATH, 'help'], { encoding: 'utf8' });
    expect(stdout).toContain('Global options');
  });
});
