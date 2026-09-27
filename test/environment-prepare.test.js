import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  classifyEnvironmentPrepareStop,
  ensureEnvironmentPrepared,
  environmentPrepareFailureMessage,
  ENVIRONMENT_PREPARE_DEFAULT_TIMEOUT_MS,
  MAX_ENVIRONMENT_PREPARE_BUFFER_BYTES,
} from '../dist/handlers/environment-prepare.js';

// ---------------------------------------------------------------------------
// Sequence runner: each call to run() consumes one queued result.
// ---------------------------------------------------------------------------
function sequenceRunner(steps) {
  const calls = [];
  let i = 0;
  return {
    calls,
    run(cmd, args, opts) {
      const result = steps[i] ?? { stdout: '', stderr: 'unexpected call', exitCode: 1 };
      calls.push({ cmd, args, opts, result });
      i++;
      return result;
    },
  };
}

const CONFIG = (overrides = {}) => ({
  enabled: true,
  command: 'echo hello',
  cacheKeyFiles: ['package-lock.json'],
  timeoutMs: 5000,
  ...overrides,
});

let tmpDir, artifactRoot, artifactDir;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'env-prepare-test-'));
  artifactRoot = join(tmpDir, 'artifacts');
  artifactDir = join(artifactRoot, 'runs', 'run-1');
  mkdirSync(artifactDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Exported constants
// ---------------------------------------------------------------------------

describe('environment-prepare — exported constants', () => {
  test('ENVIRONMENT_PREPARE_DEFAULT_TIMEOUT_MS is 120000', () => {
    expect(ENVIRONMENT_PREPARE_DEFAULT_TIMEOUT_MS).toBe(120_000);
  });

  test('MAX_ENVIRONMENT_PREPARE_BUFFER_BYTES is 80 MiB', () => {
    expect(MAX_ENVIRONMENT_PREPARE_BUFFER_BYTES).toBe(80 * 1024 * 1024);
  });
});

// ---------------------------------------------------------------------------
// Disabled config — no-op
// ---------------------------------------------------------------------------

describe('ensureEnvironmentPrepared — disabled config', () => {
  test('undefined config is a no-op and runs no commands', () => {
    const runner = sequenceRunner([]);
    const out = ensureEnvironmentPrepared({
      config: undefined,
      cwd: tmpDir,
      worktreeIdentity: tmpDir,
      artifactRoot,
      artifactDir,
      runner,
    });
    expect(out.status).toBe('skipped');
    expect(runner.calls).toHaveLength(0);
  });

  test('disabled config (enabled: false) is a no-op and runs no commands', () => {
    const runner = sequenceRunner([]);
    const out = ensureEnvironmentPrepared({
      config: CONFIG({ enabled: false }),
      cwd: tmpDir,
      worktreeIdentity: tmpDir,
      artifactRoot,
      artifactDir,
      runner,
    });
    expect(out.status).toBe('skipped');
    expect(runner.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// First use — runs prepare
// ---------------------------------------------------------------------------

describe('ensureEnvironmentPrepared — first worktree use', () => {
  test('runs the configured command on first use', () => {
    const runner = sequenceRunner([{ stdout: 'deps installed', stderr: '', exitCode: 0 }]);
    const out = ensureEnvironmentPrepared({
      config: CONFIG({ command: 'echo hello' }),
      cwd: tmpDir,
      worktreeIdentity: tmpDir,
      artifactRoot,
      artifactDir,
      runner,
    });
    expect(out.status).toBe('ran');
    expect(out.exitCode).toBe(0);
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0].cmd).toBe('echo');
    expect(runner.calls[0].args).toEqual(['hello']);
  });

  test('passes timeout and maxBuffer from config to runner', () => {
    const runner = sequenceRunner([{ stdout: '', stderr: '', exitCode: 0 }]);
    ensureEnvironmentPrepared({
      config: CONFIG({ command: 'true', timeoutMs: 42000 }),
      cwd: tmpDir,
      worktreeIdentity: tmpDir,
      artifactRoot,
      artifactDir,
      runner,
    });
    expect(runner.calls[0].opts.timeout).toBe(42000);
    expect(runner.calls[0].opts.maxBuffer).toBe(MAX_ENVIRONMENT_PREPARE_BUFFER_BYTES);
  });

  test('uses default timeout when timeoutMs is absent', () => {
    const config = { enabled: true, command: 'echo x' };
    const runner = sequenceRunner([{ stdout: '', stderr: '', exitCode: 0 }]);
    ensureEnvironmentPrepared({
      config,
      cwd: tmpDir,
      worktreeIdentity: tmpDir,
      artifactRoot,
      artifactDir,
      runner,
    });
    expect(runner.calls[0].opts.timeout).toBe(ENVIRONMENT_PREPARE_DEFAULT_TIMEOUT_MS);
  });

  test('writes environment-prepare-result.json with outcome=run on success', () => {
    const runner = sequenceRunner([{ stdout: 'ok', stderr: '', exitCode: 0 }]);
    ensureEnvironmentPrepared({
      config: CONFIG({ command: 'echo ok' }),
      cwd: tmpDir,
      worktreeIdentity: tmpDir,
      artifactRoot,
      artifactDir,
      runner,
    });
    const result = JSON.parse(readFileSync(join(artifactDir, 'environment-prepare-result.json'), 'utf8'));
    expect(result.outcome).toBe('run');
    expect(result.exitCode).toBe(0);
    expect(result.stamp).toBeDefined();
    expect(result.stamp.worktreeIdentity).toBe(tmpDir);
  });
});

// ---------------------------------------------------------------------------
// Stamp caching — unchanged cache key skips prepare
// ---------------------------------------------------------------------------

describe('ensureEnvironmentPrepared — unchanged cache key skips prepare', () => {
  test('skips on second call when cacheKeyFiles are unchanged', () => {
    writeFileSync(join(tmpDir, 'package-lock.json'), '{"lockfileVersion":2}', 'utf8');
    const config = CONFIG({ command: 'echo hello', cacheKeyFiles: ['package-lock.json'] });
    const identity = tmpDir;

    // First call — should run
    const runner1 = sequenceRunner([{ stdout: '', stderr: '', exitCode: 0 }]);
    const out1 = ensureEnvironmentPrepared({ config, cwd: tmpDir, worktreeIdentity: identity, artifactRoot, artifactDir, runner: runner1 });
    expect(out1.status).toBe('ran');
    expect(runner1.calls).toHaveLength(1);

    // Second call — same lockfile, same config → should skip
    const runner2 = sequenceRunner([]);
    const out2 = ensureEnvironmentPrepared({ config, cwd: tmpDir, worktreeIdentity: identity, artifactRoot, artifactDir, runner: runner2 });
    expect(out2.status).toBe('skipped');
    expect(runner2.calls).toHaveLength(0);
  });

  test('writes environment-prepare-result.json with outcome=skip on cache hit', () => {
    writeFileSync(join(tmpDir, 'package-lock.json'), '{"lockfileVersion":2}', 'utf8');
    const config = CONFIG({ command: 'echo hello', cacheKeyFiles: ['package-lock.json'] });

    const runner1 = sequenceRunner([{ stdout: '', stderr: '', exitCode: 0 }]);
    ensureEnvironmentPrepared({ config, cwd: tmpDir, worktreeIdentity: tmpDir, artifactRoot, artifactDir, runner: runner1 });

    const runner2 = sequenceRunner([]);
    ensureEnvironmentPrepared({ config, cwd: tmpDir, worktreeIdentity: tmpDir, artifactRoot, artifactDir, runner: runner2 });

    const result = JSON.parse(readFileSync(join(artifactDir, 'environment-prepare-result.json'), 'utf8'));
    expect(result.outcome).toBe('skip');
    expect(result.stamp).toBeDefined();
  });

  test('skips when no cacheKeyFiles are configured (empty hash is stable)', () => {
    const config = CONFIG({ command: 'echo hello', cacheKeyFiles: [] });
    const identity = tmpDir;

    const runner1 = sequenceRunner([{ stdout: '', stderr: '', exitCode: 0 }]);
    ensureEnvironmentPrepared({ config, cwd: tmpDir, worktreeIdentity: identity, artifactRoot, artifactDir, runner: runner1 });
    expect(runner1.calls).toHaveLength(1);

    const runner2 = sequenceRunner([]);
    const out2 = ensureEnvironmentPrepared({ config, cwd: tmpDir, worktreeIdentity: identity, artifactRoot, artifactDir, runner: runner2 });
    expect(out2.status).toBe('skipped');
    expect(runner2.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Stamp invalidation — changed cache key re-runs prepare
// ---------------------------------------------------------------------------

describe('ensureEnvironmentPrepared — changed cache key re-runs prepare', () => {
  test('re-runs when cacheKeyFile content changes', () => {
    writeFileSync(join(tmpDir, 'package-lock.json'), '{"lockfileVersion":2}', 'utf8');
    const config = CONFIG({ command: 'echo hello', cacheKeyFiles: ['package-lock.json'] });
    const identity = tmpDir;

    // First run
    const runner1 = sequenceRunner([{ stdout: '', stderr: '', exitCode: 0 }]);
    ensureEnvironmentPrepared({ config, cwd: tmpDir, worktreeIdentity: identity, artifactRoot, artifactDir, runner: runner1 });
    expect(runner1.calls).toHaveLength(1);

    // Simulate dependency sync updating the lockfile
    writeFileSync(join(tmpDir, 'package-lock.json'), '{"lockfileVersion":3,"updated":true}', 'utf8');

    // Second run — cacheKeyFilesHash changed → must re-run
    const runner2 = sequenceRunner([{ stdout: '', stderr: '', exitCode: 0 }]);
    const out2 = ensureEnvironmentPrepared({ config, cwd: tmpDir, worktreeIdentity: identity, artifactRoot, artifactDir, runner: runner2 });
    expect(out2.status).toBe('ran');
    expect(runner2.calls).toHaveLength(1);
  });

  test('re-runs when command string changes', () => {
    const identity = tmpDir;
    const config1 = CONFIG({ command: 'echo hello', cacheKeyFiles: [] });

    const runner1 = sequenceRunner([{ stdout: '', stderr: '', exitCode: 0 }]);
    ensureEnvironmentPrepared({ config: config1, cwd: tmpDir, worktreeIdentity: identity, artifactRoot, artifactDir, runner: runner1 });
    expect(runner1.calls).toHaveLength(1);

    const config2 = CONFIG({ command: 'echo world', cacheKeyFiles: [] });
    const runner2 = sequenceRunner([{ stdout: '', stderr: '', exitCode: 0 }]);
    const out2 = ensureEnvironmentPrepared({ config: config2, cwd: tmpDir, worktreeIdentity: identity, artifactRoot, artifactDir, runner: runner2 });
    expect(out2.status).toBe('ran');
    expect(runner2.calls).toHaveLength(1);
    expect(runner2.calls[0].args).toEqual(['world']);
  });

  test('re-runs for a different worktreeIdentity (each worktree maintains its own stamp)', () => {
    const config = CONFIG({ command: 'echo hello', cacheKeyFiles: [] });

    // Worktree A runs and stamps
    const worktreeA = join(tmpDir, 'wt-a');
    mkdirSync(worktreeA);
    const runnerA = sequenceRunner([{ stdout: '', stderr: '', exitCode: 0 }]);
    ensureEnvironmentPrepared({ config, cwd: worktreeA, worktreeIdentity: worktreeA, artifactRoot, artifactDir, runner: runnerA });
    expect(runnerA.calls).toHaveLength(1);

    // Worktree B is a different identity — must run independently
    const worktreeB = join(tmpDir, 'wt-b');
    mkdirSync(worktreeB);
    const runnerB = sequenceRunner([{ stdout: '', stderr: '', exitCode: 0 }]);
    const outB = ensureEnvironmentPrepared({ config, cwd: worktreeB, worktreeIdentity: worktreeB, artifactRoot, artifactDir, runner: runnerB });
    expect(outB.status).toBe('ran');
    expect(runnerB.calls).toHaveLength(1);
  });

  test('re-runs when worktree is recreated at the same path (sentinel gone)', () => {
    // Simulate a real git worktree: create a .git file (the worktree gitfile)
    // pointing to a worktrees sub-directory, so resolveGitDir() reads the gitdir
    // from it and writes the sentinel there.
    const worktree = join(tmpDir, 'wt-recreate');
    const gitWorktreesDir = join(tmpDir, 'dot-git', 'worktrees', 'wt-recreate');
    mkdirSync(worktree, { recursive: true });
    mkdirSync(gitWorktreesDir, { recursive: true });
    writeFileSync(join(worktree, '.git'), `gitdir: ${gitWorktreesDir}`, 'utf8');

    const config = CONFIG({ command: 'echo hello', cacheKeyFiles: [] });

    // First run in the original worktree — stamps + writes sentinel in gitWorktreesDir
    const runner1 = sequenceRunner([{ stdout: '', stderr: '', exitCode: 0 }]);
    const out1 = ensureEnvironmentPrepared({ config, cwd: worktree, worktreeIdentity: worktree, artifactRoot, artifactDir, runner: runner1 });
    expect(out1.status).toBe('ran');
    expect(runner1.calls).toHaveLength(1);

    // Second call in same worktree — stamp + sentinel both present → skips
    const runner2 = sequenceRunner([]);
    const out2 = ensureEnvironmentPrepared({ config, cwd: worktree, worktreeIdentity: worktree, artifactRoot, artifactDir, runner: runner2 });
    expect(out2.status).toBe('skipped');

    // Simulate worktree recreation: rm the worktrees git dir (taking the sentinel with it),
    // then recreate it empty (as git worktree add would). The artifact-root stamp survives.
    rmSync(gitWorktreesDir, { recursive: true, force: true });
    mkdirSync(gitWorktreesDir, { recursive: true });

    // Third call — stamp survives in artifactRoot but sentinel is gone → must re-run
    const runner3 = sequenceRunner([{ stdout: '', stderr: '', exitCode: 0 }]);
    const out3 = ensureEnvironmentPrepared({ config, cwd: worktree, worktreeIdentity: worktree, artifactRoot, artifactDir, runner: runner3 });
    expect(out3.status).toBe('ran');
    expect(runner3.calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Failed prepare stops before agent execution
// ---------------------------------------------------------------------------

describe('ensureEnvironmentPrepared — unsafe command refusal', () => {
  test('refuses npm ci without --ignore-scripts in safe mode', () => {
    const runner = sequenceRunner([]);
    const out = ensureEnvironmentPrepared({
      config: CONFIG({ command: 'npm ci' }),
      cwd: tmpDir,
      worktreeIdentity: tmpDir,
      artifactRoot,
      artifactDir,
      runner,
    });
    expect(out.status).toBe('failed');
    expect(out.exitCode).toBe(0);
    expect(out.output).toContain('lifecycle scripts');
    expect(runner.calls).toHaveLength(0);
  });

  test('refuses npm install without --ignore-scripts in safe mode', () => {
    const runner = sequenceRunner([]);
    const out = ensureEnvironmentPrepared({
      config: CONFIG({ command: 'npm install' }),
      cwd: tmpDir,
      worktreeIdentity: tmpDir,
      artifactRoot,
      artifactDir,
      runner,
    });
    expect(out.status).toBe('failed');
    expect(runner.calls).toHaveLength(0);
  });

  test('refuses pnpm install without --ignore-scripts in safe mode', () => {
    const runner = sequenceRunner([]);
    const out = ensureEnvironmentPrepared({
      config: CONFIG({ command: 'pnpm install' }),
      cwd: tmpDir,
      worktreeIdentity: tmpDir,
      artifactRoot,
      artifactDir,
      runner,
    });
    expect(out.status).toBe('failed');
    expect(runner.calls).toHaveLength(0);
  });

  test('allows npm ci --ignore-scripts in safe mode', () => {
    const runner = sequenceRunner([{ stdout: 'ok', stderr: '', exitCode: 0 }]);
    const out = ensureEnvironmentPrepared({
      config: CONFIG({ command: 'npm ci --ignore-scripts' }),
      cwd: tmpDir,
      worktreeIdentity: tmpDir,
      artifactRoot,
      artifactDir,
      runner,
    });
    expect(out.status).toBe('ran');
    expect(runner.calls).toHaveLength(1);
  });

  test('allows npm ci when allowLifecycleScripts is true', () => {
    const runner = sequenceRunner([{ stdout: 'ok', stderr: '', exitCode: 0 }]);
    const out = ensureEnvironmentPrepared({
      config: CONFIG({ command: 'npm ci', allowLifecycleScripts: true }),
      cwd: tmpDir,
      worktreeIdentity: tmpDir,
      artifactRoot,
      artifactDir,
      runner,
    });
    expect(out.status).toBe('ran');
    expect(runner.calls).toHaveLength(1);
  });

  // global-option bypass (P1 fix): subcommand after package-manager global flags
  test('refuses npm --prefix frontend ci without --ignore-scripts in safe mode', () => {
    const runner = sequenceRunner([]);
    const out = ensureEnvironmentPrepared({
      config: CONFIG({ command: 'npm --prefix frontend ci' }),
      cwd: tmpDir,
      worktreeIdentity: tmpDir,
      artifactRoot,
      artifactDir,
      runner,
    });
    expect(out.status).toBe('failed');
    expect(out.output).toContain('lifecycle scripts');
    expect(runner.calls).toHaveLength(0);
  });

  test('refuses pnpm --dir app install without --ignore-scripts in safe mode', () => {
    const runner = sequenceRunner([]);
    const out = ensureEnvironmentPrepared({
      config: CONFIG({ command: 'pnpm --dir app install' }),
      cwd: tmpDir,
      worktreeIdentity: tmpDir,
      artifactRoot,
      artifactDir,
      runner,
    });
    expect(out.status).toBe('failed');
    expect(out.output).toContain('lifecycle scripts');
    expect(runner.calls).toHaveLength(0);
  });

  test('allows npm --prefix=frontend ci --ignore-scripts in safe mode', () => {
    const runner = sequenceRunner([{ stdout: 'ok', stderr: '', exitCode: 0 }]);
    const out = ensureEnvironmentPrepared({
      config: CONFIG({ command: 'npm --prefix=frontend ci --ignore-scripts' }),
      cwd: tmpDir,
      worktreeIdentity: tmpDir,
      artifactRoot,
      artifactDir,
      runner,
    });
    expect(out.status).toBe('ran');
    expect(runner.calls).toHaveLength(1);
  });

  test('writes environment-prepare-result.json with outcome=refused for unsafe command', () => {
    const runner = sequenceRunner([]);
    ensureEnvironmentPrepared({
      config: CONFIG({ command: 'npm ci' }),
      cwd: tmpDir,
      worktreeIdentity: tmpDir,
      artifactRoot,
      artifactDir,
      runner,
    });
    const result = JSON.parse(readFileSync(join(artifactDir, 'environment-prepare-result.json'), 'utf8'));
    expect(result.outcome).toBe('refused');
    expect(result.kind).toBe('unsafe-command');
  });
});

describe('ensureEnvironmentPrepared — failed prepare', () => {
  test('returns status=failed when command exits nonzero', () => {
    // allowLifecycleScripts: true so the command actually runs and the mock failure is observed
    const runner = sequenceRunner([{ stdout: '', stderr: 'npm ERR! install failed', exitCode: 1 }]);
    const out = ensureEnvironmentPrepared({
      config: CONFIG({ command: 'npm ci', allowLifecycleScripts: true }),
      cwd: tmpDir,
      worktreeIdentity: tmpDir,
      artifactRoot,
      artifactDir,
      runner,
    });
    expect(out.status).toBe('failed');
    expect(out.exitCode).toBe(1);
    expect(out.output).toContain('npm ERR!');
  });

  test('writes environment-prepare-result.json with outcome=failed', () => {
    // allowLifecycleScripts: true so the command actually runs and the mock failure is observed
    const runner = sequenceRunner([{ stdout: 'out', stderr: 'err', exitCode: 2 }]);
    ensureEnvironmentPrepared({
      config: CONFIG({ command: 'npm ci', allowLifecycleScripts: true }),
      cwd: tmpDir,
      worktreeIdentity: tmpDir,
      artifactRoot,
      artifactDir,
      runner,
    });
    const result = JSON.parse(readFileSync(join(artifactDir, 'environment-prepare-result.json'), 'utf8'));
    expect(result.outcome).toBe('failed');
    expect(result.exitCode).toBe(2);
  });

  test('does not write stamp on failure so next call retries', () => {
    const config = CONFIG({ command: 'echo hi', cacheKeyFiles: [] });
    const identity = tmpDir;

    // First call — fails
    const runner1 = sequenceRunner([{ stdout: '', stderr: 'failed', exitCode: 1 }]);
    const out1 = ensureEnvironmentPrepared({ config, cwd: tmpDir, worktreeIdentity: identity, artifactRoot, artifactDir, runner: runner1 });
    expect(out1.status).toBe('failed');

    // Second call — must retry, not skip
    const runner2 = sequenceRunner([{ stdout: '', stderr: '', exitCode: 0 }]);
    const out2 = ensureEnvironmentPrepared({ config, cwd: tmpDir, worktreeIdentity: identity, artifactRoot, artifactDir, runner: runner2 });
    expect(out2.status).toBe('ran');
    expect(runner2.calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Non-npm command — ecosystem agnostic
// ---------------------------------------------------------------------------

describe('ensureEnvironmentPrepared — non-npm command', () => {
  test('works with cargo fetch (rust ecosystem)', () => {
    const runner = sequenceRunner([{ stdout: '', stderr: '', exitCode: 0 }]);
    const out = ensureEnvironmentPrepared({
      config: CONFIG({ command: 'cargo fetch', cacheKeyFiles: ['Cargo.lock'] }),
      cwd: tmpDir,
      worktreeIdentity: tmpDir,
      artifactRoot,
      artifactDir,
      runner,
    });
    expect(out.status).toBe('ran');
    expect(runner.calls[0].cmd).toBe('cargo');
    expect(runner.calls[0].args).toEqual(['fetch']);
  });

  test('works with go mod download (go ecosystem)', () => {
    const runner = sequenceRunner([{ stdout: '', stderr: '', exitCode: 0 }]);
    const out = ensureEnvironmentPrepared({
      config: CONFIG({ command: 'go mod download', cacheKeyFiles: ['go.sum'] }),
      cwd: tmpDir,
      worktreeIdentity: tmpDir,
      artifactRoot,
      artifactDir,
      runner,
    });
    expect(out.status).toBe('ran');
    expect(runner.calls[0].cmd).toBe('go');
    expect(runner.calls[0].args).toEqual(['mod', 'download']);
  });

  test('works with uv sync --frozen (python ecosystem)', () => {
    const runner = sequenceRunner([{ stdout: '', stderr: '', exitCode: 0 }]);
    const out = ensureEnvironmentPrepared({
      config: CONFIG({ command: 'uv sync --frozen', cacheKeyFiles: ['uv.lock'] }),
      cwd: tmpDir,
      worktreeIdentity: tmpDir,
      artifactRoot,
      artifactDir,
      runner,
    });
    expect(out.status).toBe('ran');
    expect(runner.calls[0].cmd).toBe('uv');
    expect(runner.calls[0].args).toEqual(['sync', '--frozen']);
  });

  test('works with composer install (php ecosystem)', () => {
    const runner = sequenceRunner([{ stdout: '', stderr: '', exitCode: 0 }]);
    const out = ensureEnvironmentPrepared({
      config: CONFIG({ command: 'composer install --no-interaction --no-scripts', cacheKeyFiles: ['composer.lock'] }),
      cwd: tmpDir,
      worktreeIdentity: tmpDir,
      artifactRoot,
      artifactDir,
      runner,
    });
    expect(out.status).toBe('ran');
    expect(runner.calls[0].cmd).toBe('composer');
    expect(runner.calls[0].args).toEqual(['install', '--no-interaction', '--no-scripts']);
  });
});

// ---------------------------------------------------------------------------
// Stop-reason classification (issue #1060)
//
// The reproduction: a 5-minute `environmentPrepare.timeoutMs` expired three
// runs in a row and every one of them was persisted and published as
// "Environment preparation failed (exit 1)" followed by npm deprecation
// warnings — pointing the operator at the package manager instead of the
// deadline, when the same `npm ci` finished in ~10s by hand in that worktree.
// ---------------------------------------------------------------------------

/** What the real runner reports for a command killed on its deadline. */
const TIMED_OUT_RESULT = {
  stdout: '',
  stderr: 'npm warn deprecated left-pad@1.3.0: use String.prototype.padStart\n',
  exitCode: 1,
  timedOut: true,
  signal: 'SIGTERM',
  spawnErrorCode: 'ETIMEDOUT',
  durationMs: 300_134,
  pid: 4242,
  processTreeCleanup: {
    pid: 4242,
    processGroupTerminated: true,
    terminatedDescendants: [4243, 4244],
    forceKilled: [],
  },
};

function runFailingPrepare(result, configOverrides = {}) {
  const runner = sequenceRunner([result]);
  const out = ensureEnvironmentPrepared({
    config: CONFIG({ command: 'npm ci', allowLifecycleScripts: true, timeoutMs: 300_000, ...configOverrides }),
    cwd: tmpDir,
    worktreeIdentity: tmpDir,
    artifactRoot,
    artifactDir,
    runner,
  });
  const artifact = JSON.parse(readFileSync(join(artifactDir, 'environment-prepare-result.json'), 'utf8'));
  return { out, artifact, runner };
}

describe('classifyEnvironmentPrepareStop', () => {
  test('a deadline kill classifies as timeout even though it is also a signal and an errno', () => {
    expect(classifyEnvironmentPrepareStop(TIMED_OUT_RESULT)).toBe('timeout');
  });

  test('a signal kill with no errno classifies as signal', () => {
    expect(classifyEnvironmentPrepareStop({ signal: 'SIGKILL' })).toBe('signal');
  });

  test('a spawn-level errno classifies as spawn-error', () => {
    expect(classifyEnvironmentPrepareStop({ spawnErrorCode: 'ENOENT' })).toBe('spawn-error');
  });

  test('an ordinary non-zero exit classifies as command-failed', () => {
    expect(classifyEnvironmentPrepareStop({})).toBe('command-failed');
  });

  test('a watchdog escalation classifies as timeout, not as the SIGKILL it needed', () => {
    // The watchdog only fires after the deadline has demonstrably elapsed, so its
    // force-kill is evidence of a timeout — never of an external signal.
    expect(
      classifyEnvironmentPrepareStop({ deadlineEscalated: true, signal: 'SIGKILL' }),
    ).toBe('timeout');
  });
});

describe('ensureEnvironmentPrepared — timeout is not a generic exit 1', () => {
  test('reports the timeout, its deadline, and the elapsed time', () => {
    const { out } = runFailingPrepare(TIMED_OUT_RESULT);

    expect(out.status).toBe('failed');
    expect(out.stopReason).toBe('timeout');
    expect(out.timedOut).toBe(true);
    expect(out.timeoutMs).toBe(300_000);
    expect(out.durationMs).toBe(300_134);
    expect(out.signal).toBe('SIGTERM');
    expect(out.spawnErrorCode).toBe('ETIMEDOUT');
    expect(out.stopSummary).toContain('timed out after 300000 ms');
    expect(out.stopSummary).toContain('300134');
    expect(out.stopSummary).toContain('SIGTERM');
  });

  test('partial stderr printed before the deadline stays available and bounded', () => {
    const noisy = 'x'.repeat(20_000);
    const { out } = runFailingPrepare({ ...TIMED_OUT_RESULT, stderr: `npm warn deprecated\n${noisy}` });

    expect(out.output).toContain('…(truncated)');
    expect(out.output.length).toBeLessThanOrEqual(4_100);
    expect(out.stopReason).toBe('timeout');
  });

  test('the npm deprecation warning is labelled as partial output, not the cause', () => {
    const { out } = runFailingPrepare(TIMED_OUT_RESULT);
    const message = environmentPrepareFailureMessage(out);

    expect(message).toContain('Environment preparation timed out after 300000 ms');
    expect(message).toContain('not the cause');
    // The output is still there for the operator; it is just not the headline.
    expect(message).toContain('npm warn deprecated');
    expect(message).not.toContain('failed (exit 1)');
  });

  test('records the timeout and the process-tree cleanup in the run artifact', () => {
    const { artifact } = runFailingPrepare(TIMED_OUT_RESULT);

    expect(artifact.outcome).toBe('failed');
    expect(artifact.stopReason).toBe('timeout');
    expect(artifact.timedOut).toBe(true);
    expect(artifact.signal).toBe('SIGTERM');
    expect(artifact.spawnErrorCode).toBe('ETIMEDOUT');
    expect(artifact.timeoutMs).toBe(300_000);
    expect(artifact.durationMs).toBe(300_134);
    expect(artifact.processTreeCleanup.processGroupTerminated).toBe(true);
    expect(artifact.processTreeCleanup.terminatedDescendants).toEqual([4243, 4244]);
  });

  test('a command that had to be force-killed says so on every surface', () => {
    const { out, artifact } = runFailingPrepare({
      ...TIMED_OUT_RESULT,
      // What the runner reports for a command that ignored the deadline's
      // SIGTERM and had to be taken down by the external watchdog.
      deadlineEscalated: true,
      signal: 'SIGKILL',
    });

    expect(out.stopReason).toBe('timeout');
    expect(out.deadlineEscalated).toBe(true);
    expect(out.stopSummary).toContain('force-killed');
    expect(environmentPrepareFailureMessage(out)).toContain('force-killed');
    expect(artifact.deadlineEscalated).toBe(true);
  });

  test('a cleanup that could not confirm termination says so instead of claiming success', () => {
    // What the sweep records when the surviving group is not ours to signal:
    // the operator must not read "process group terminated" for processes that
    // are still holding the cache locks the next attempt will block on.
    const { out, artifact } = runFailingPrepare({
      ...TIMED_OUT_RESULT,
      processTreeCleanup: {
        pid: 4242,
        processGroupTerminated: false,
        processGroupSignalError: 'EPERM',
        terminatedDescendants: [],
        forceKilled: [],
        note: "the child's process group could not be signalled (EPERM); processes in it may still be running and holding locks",
      },
    });

    expect(out.stopSummary).toContain('could NOT be terminated (EPERM)');
    expect(out.stopSummary).not.toContain('no process group to terminate');
    expect(environmentPrepareFailureMessage(out)).toContain('could NOT be terminated');
    expect(artifact.processTreeCleanup.processGroupTerminated).toBe(false);
    expect(artifact.processTreeCleanup.processGroupSignalError).toBe('EPERM');
  });

  test('asks the runner to isolate the process group so the tree can be killed', () => {
    const { runner } = runFailingPrepare(TIMED_OUT_RESULT);
    expect(runner.calls[0].opts.isolateProcessGroup).toBe(true);
    expect(runner.calls[0].opts.timeout).toBe(300_000);
  });

  test('records runner context an operator can compare against a direct run', () => {
    const { artifact } = runFailingPrepare(TIMED_OUT_RESULT);
    const context = artifact.runnerContext;

    expect(context.command).toBe('npm ci');
    expect(context.cwd).toBe(tmpDir);
    expect(context.timeoutMs).toBe(300_000);
    expect(context.durationMs).toBe(300_134);
    expect(context.pid).toBe(4242);
    expect(context.runnerPid).toBe(process.pid);
    expect(context.runnerParentPid).toBe(process.ppid);
    expect(context.nodeVersion).toBe(process.version);
    expect(context.cpuCount).toBeGreaterThan(0);
    expect(Array.isArray(context.loadAverage)).toBe(true);
    expect(typeof context.startedAt).toBe('string');
    expect(typeof context.finishedAt).toBe('string');
  });

  test('records environment variable NAMES only, never their values', () => {
    // A package-manager env var is exactly where a registry credential lives, so
    // the artifact must carry the name and nothing else.
    const valueThatMustNotBeRecorded = ['must', 'not', 'be', 'recorded'].join('-');
    process.env.NPM_CONFIG__AUTH = valueThatMustNotBeRecorded;
    try {
      const { artifact } = runFailingPrepare(TIMED_OUT_RESULT);
      expect(artifact.runnerContext.executionEnvNames).toContain('NPM_CONFIG__AUTH');
      expect(JSON.stringify(artifact)).not.toContain(valueThatMustNotBeRecorded);
    } finally {
      delete process.env.NPM_CONFIG__AUTH;
    }
  });
});

describe('ensureEnvironmentPrepared — other stop reasons', () => {
  test('a signal kill is reported as termination, not as something the command said', () => {
    const { out, artifact } = runFailingPrepare({
      stdout: '',
      stderr: 'partial install output',
      exitCode: 1,
      signal: 'SIGKILL',
      durationMs: 8_100,
    });

    expect(out.stopReason).toBe('signal');
    expect(out.signal).toBe('SIGKILL');
    expect(out.stopSummary).toContain('terminated by signal SIGKILL');
    expect(artifact.stopReason).toBe('signal');
    expect(environmentPrepareFailureMessage(out)).toContain('not the cause');
  });

  test('a spawn failure is reported as the command never having started', () => {
    const { out, artifact } = runFailingPrepare({
      stdout: '',
      stderr: 'Error: spawnSync npm ENOENT',
      exitCode: 1,
      spawnError: 'Error: spawnSync npm ENOENT',
      spawnErrorCode: 'ENOENT',
      durationMs: 4,
    });

    expect(out.stopReason).toBe('spawn-error');
    expect(out.spawnErrorCode).toBe('ENOENT');
    expect(out.spawnError).toBe('Error: spawnSync npm ENOENT');
    expect(out.stopSummary).toContain('could not be started (ENOENT)');
    expect(artifact.stopReason).toBe('spawn-error');
  });

  test('an ordinary non-zero exit is still reported as a command failure', () => {
    const { out, artifact } = runFailingPrepare({
      stdout: '',
      stderr: 'npm ERR! code EUSAGE\nnpm ERR! lockfile out of sync',
      exitCode: 1,
      durationMs: 9_500,
    });

    expect(out.stopReason).toBe('command-failed');
    expect(out.exitCode).toBe(1);
    expect(out.timedOut).toBeUndefined();
    expect(out.signal).toBeUndefined();
    expect(artifact.stopReason).toBe('command-failed');
    const message = environmentPrepareFailureMessage(out);
    expect(message).toBe(
      'Environment preparation failed (exit 1): npm ERR! code EUSAGE\nnpm ERR! lockfile out of sync',
    );
    expect(message).not.toContain('not the cause');
  });

  test('a safe-mode refusal is reported as a refusal, not as exit 0', () => {
    const runner = sequenceRunner([]);
    const out = ensureEnvironmentPrepared({
      config: CONFIG({ command: 'npm ci' }),
      cwd: tmpDir,
      worktreeIdentity: tmpDir,
      artifactRoot,
      artifactDir,
      runner,
    });

    expect(out.status).toBe('failed');
    expect(out.stopReason).toBe('refused');
    expect(runner.calls).toHaveLength(0);
    expect(environmentPrepareFailureMessage(out)).toContain('was refused before it ran');
  });

  test('the stage is named so the four prepare call sites stay distinguishable', () => {
    const { out } = runFailingPrepare(TIMED_OUT_RESULT);
    expect(environmentPrepareFailureMessage(out, 'before review verification')).toContain(
      'Environment preparation (before review verification) timed out',
    );
  });
});

describe('ensureEnvironmentPrepared — success is unchanged', () => {
  test('a successful run still reports ran/exit 0 with its output', () => {
    const runner = sequenceRunner([{ stdout: 'added 1 package', stderr: '', exitCode: 0, durationMs: 9_800 }]);
    const out = ensureEnvironmentPrepared({
      config: CONFIG({ command: 'npm ci --ignore-scripts' }),
      cwd: tmpDir,
      worktreeIdentity: tmpDir,
      artifactRoot,
      artifactDir,
      runner,
    });

    expect(out.status).toBe('ran');
    expect(out.exitCode).toBe(0);
    expect(out.output).toBe('added 1 package');
    expect(out.stopReason).toBeUndefined();
    expect(out.stopSummary).toBeUndefined();

    const artifact = JSON.parse(readFileSync(join(artifactDir, 'environment-prepare-result.json'), 'utf8'));
    expect(artifact.outcome).toBe('run');
    expect(artifact.exitCode).toBe(0);
    expect(artifact.durationMs).toBe(9_800);
    expect(artifact.stamp).toBeDefined();
  });
});
