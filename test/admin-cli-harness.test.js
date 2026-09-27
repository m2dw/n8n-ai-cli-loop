/**
 * The in-process admin CLI harness itself (issue #1018).
 *
 * Everything that migrated off subprocesses now trusts three claims:
 *
 *   1. the harness drives the SAME dispatcher the executable drives, so a
 *      harnessed case and a spawned case cannot diverge silently;
 *   2. a run leaves no trace in the worker — env, cwd, `process.exitCode` and
 *      the resolved output mode all come back;
 *   3. the {@link CliIoSink} seam is complete: no admin CLI module writes to
 *      `process.stdout`/`process.stderr` or calls `process.exit` behind it.
 *
 * If any of these stops holding, hundreds of migrated assertions quietly stop
 * meaning what they say, so they are pinned here rather than assumed.
 */
import { jest } from '@jest/globals';
import { execFileSync, spawnSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { getOutputMode, setOutputMode } from '../dist/cli/cli-io.js';
import { ADMIN_CLI_PATH, runAdmin } from './helpers/admin-cli.js';
import { runUntilProbeAnswers } from './helpers/cli-probe.js';

// The equivalence cases fork a real Node process to compare against.
jest.setTimeout(30_000);

const ROOT = resolve(new URL('..', import.meta.url).pathname);

let tmpDir;
let dbPath;

function spawnAdmin(args) {
  const r = spawnSync(process.execPath, [ADMIN_CLI_PATH, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'admin-cli-harness-'));
  dbPath = join(tmpDir, 'dev_loop.db');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('admin CLI harness — same dispatcher as the executable', () => {
  // The equivalence claim, checked end to end rather than asserted in a comment:
  // one success path and one failure path must agree on code, stdout and stderr.
  test('a successful command matches a spawned run byte for byte', async () => {
    // Separate databases so neither run observes the other's rows (and so no
    // stale -wal/-shm sidecar is left behind by deleting one mid-test).
    const argsFor = (db) =>
      ['context', 'create', '--execution-id', 'exec-eq', '--session-id', 'addon-dev', '--db-path', db];
    const spawned = spawnAdmin(argsFor(join(tmpDir, 'spawned.db')));
    const inProcess = await runAdmin(argsFor(join(tmpDir, 'in-process.db')));

    expect(inProcess.code).toBe(spawned.code);
    expect(inProcess.stdout).toBe(spawned.stdout);
    expect(inProcess.stderr).toBe(spawned.stderr);
  });

  test('a human-mode failure matches a spawned run on both streams and the code', async () => {
    const args = ['task-status', '--db-path', dbPath];
    const spawned = spawnAdmin(args);
    const inProcess = await runAdmin(args);

    expect(inProcess.code).toBe(spawned.code);
    expect(inProcess.code).not.toBe(0);
    expect(inProcess.stdout).toBe(spawned.stdout);
    expect(inProcess.stderr).toBe(spawned.stderr);
    expect(inProcess.stderr).toContain('session-id');
  });

  test('the executable entrypoint is nothing but a call to the harnessed function', () => {
    const source = readFileSync(join(ROOT, 'src/cli/admin.ts'), 'utf8');
    expect(source).toMatch(/export async function runAdminCli\(argv: string\[\]\)/);
    expect(source).toMatch(/runAdminCli\(process\.argv\.slice\(2\)\)/);
  });
});

describe('admin CLI harness — the run leaves no trace', () => {
  test('env overrides are applied for the run and reverted after it', async () => {
    const key = 'ADMIN_HARNESS_ENV_PROBE';
    expect(process.env[key]).toBeUndefined();
    await runAdmin(['help'], { env: { [key]: 'value' } });
    expect(process.env[key]).toBeUndefined();
  });

  test('an env entry set to undefined is unset for the run and restored after', async () => {
    const key = 'ADMIN_HARNESS_ENV_EXISTING';
    process.env[key] = 'outer';
    try {
      await runAdmin(['help'], { env: { [key]: undefined } });
      expect(process.env[key]).toBe('outer');
    } finally {
      delete process.env[key];
    }
  });

  test('cwd is restored after the run', async () => {
    const before = process.cwd();
    await runAdmin(['help'], { cwd: tmpDir });
    expect(process.cwd()).toBe(before);
  });

  test('a failing run does not leave process.exitCode set on the worker', async () => {
    const before = process.exitCode;
    const r = await runAdmin(['task-status', '--db-path', dbPath, '--json']);
    expect(r.code).not.toBe(0);
    expect(process.exitCode).toBe(before);
  });

  // Handlers that report a soft failure set process.exitCode and return instead
  // of dying. That is still a non-zero run, and it must not leak either.
  test('a process.exitCode-only failure is reported as the run code and then cleared', async () => {
    const before = process.exitCode;
    const r = await runAdmin([
      'chain', 'validate', 'chain_1', '--db-path', dbPath, '--sessions-path', join(tmpDir, 'sessions.json'), '--json',
    ]);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout.trim())).toMatchObject({ ok: false, reason: 'not_found' });
    expect(process.exitCode).toBe(before);
  });

  test('the resolved output mode is restored, so a direct handler call is unaffected', async () => {
    const outer = { json: false, quiet: true, verbose: true };
    setOutputMode(outer);
    try {
      // `context create` is a machine-default command: main() resolves JSON mode.
      await runAdmin(['context', 'create', '--execution-id', 'e', '--session-id', 's', '--db-path', dbPath]);
      expect(getOutputMode()).toEqual(outer);
    } finally {
      setOutputMode({ json: true, quiet: false, verbose: false });
    }
  });

  test('runs are independent: a failure does not suppress the next run\'s output', async () => {
    const failed = await runAdmin(['task-status', '--db-path', dbPath, '--json']);
    expect(failed.code).not.toBe(0);

    const ok = await runAdmin(['help']);
    expect(ok.code).toBe(0);
    expect(ok.stdout).toContain('task-status');
  });
});

describe('admin CLI harness — env reaches the children a command spawns', () => {
  /**
   * The trap this pins (issue #1018): Jest hands every module a COPY of
   * `process.env` (jest-util's `createProcessObject`), while `execFileSync` /
   * `spawnSync` read their default `env` from the REAL process object. A spawn
   * site that omits `env` therefore resolves `PATH` against the host, silently
   * ignoring a stub the case installed — and the case still "passes" whenever
   * the host happens to agree. Every spawn site the admin CLI reaches passes
   * `spawnEnv()` so that cannot happen; this is the behavioural proof.
   */
  test('a PATH override installed by the harness is what the CLI probes resolve', async () => {
    const bin = join(tmpDir, 'bin');
    mkdirSync(bin, { recursive: true });
    // Fails loudly with a marker no real `gh` could produce, so a check that
    // reports it can only have run THIS executable.
    writeFileSync(join(bin, 'gh'), '#!/bin/sh\necho "HARNESS-PATH-MARKER" >&2\nexit 1\n', { mode: 0o755 });

    const sessionsPath = join(tmpDir, 'sessions.json');
    writeFileSync(sessionsPath, JSON.stringify({
      sessions: [{
        sessionId: 'addon-dev',
        repoKey: 'some-repo',
        repoRoot: join(tmpDir, 'repo'),
        githubRepo: 'm2dw/some-repo',
        artifactDir: '.n8n-artifacts',
        defaults: { implementationAgent: 'claude', reviewAgent: 'claude' },
        verification: {},
        labels: { active: 'ai:active', blocked: 'ai:blocked', readyForHuman: 'ai:ready-for-human' },
      }],
    }), 'utf8');

    // The claim is about which executable PATH resolved, so a run the host was
    // too loaded to complete (issue #897: the probe reports ETIMEDOUT rather than
    // the stub's own stderr) proves nothing in either direction — ask again, and
    // decline to assert if the host never answers.
    const { result: r, answered } = await runUntilProbeAnswers(
      () => runAdmin(
        ['session-doctor', '--session-id', 'addon-dev', '--sessions-path', sessionsPath],
        { env: { PATH: bin } },
      ),
      (run) => JSON.parse(run.stdout.trim()).checks
        .filter((c) => c.category === 'github')
        .map((c) => c.error ?? '')
        .join('\n'),
    );
    if (!answered) return;

    const checks = JSON.parse(r.stdout.trim()).checks;
    expect(checks.find((c) => c.name === 'ghAuth').error).toContain('HARNESS-PATH-MARKER');
    // Each attempt forks a real child under a 60s probe budget, so the retry
    // schedule needs headroom the file-wide 30s does not give it.
  }, 240_000);
});

describe('admin CLI — the io seam is complete', () => {
  // The harness can only capture what goes through the sink. A new direct write
  // or a bare process.exit would be invisible to every migrated case (and, for
  // exit, would kill the Jest worker), so the seam is pinned by construction.
  const CLI_SOURCES = ['src/cli/admin.ts', 'src/cli/admin-ui.ts', 'src/cli/admin-command.ts'];

  test.each(CLI_SOURCES)('%s writes no stream and exits no process directly', (rel) => {
    // Comment lines are stripped first: these modules explain the seam in prose
    // ("die() calls process.exit()"), and documenting it must not trip the check.
    const source = readFileSync(join(ROOT, rel), 'utf8')
      .split('\n')
      .filter((line) => {
        const t = line.trimStart();
        return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*');
      })
      .join('\n');
    expect(source).not.toMatch(/process\.stdout\.write/);
    expect(source).not.toMatch(/process\.stderr\.write/);
    expect(source).not.toMatch(/process\.exit\(/);
  });

  test('cli-io is the single place that touches the real process', () => {
    const source = readFileSync(join(ROOT, 'src/cli/cli-io.ts'), 'utf8');
    // Exactly one sink binds the real process, and it is the default.
    expect(source).toMatch(/const PROCESS_SINK: CliIoSink = \{/);
    expect(source).toMatch(/let sink: CliIoSink = PROCESS_SINK;/);
  });

  test('the real executable is unaffected by the seam', () => {
    const stdout = execFileSync(process.execPath, [ADMIN_CLI_PATH, 'help'], { encoding: 'utf8' });
    expect(stdout).toContain('Global options');
  });
});
