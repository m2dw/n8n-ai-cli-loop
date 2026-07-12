import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  ensureEnvironmentPrepared,
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
