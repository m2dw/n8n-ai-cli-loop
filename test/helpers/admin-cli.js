/**
 * In-process admin CLI test harness (issue #1018).
 *
 * The admin suites used to spawn a fresh `node dist/cli/admin.js` for every
 * behavioural case. That is the right shape for a handful of contract cases —
 * real argv parsing, a real exit status, real stream separation, real env
 * isolation — and pure overhead for the hundreds of cases that only care what
 * the command decided. `admin-cli.test.js` alone spent ~43s of a ~420s Jest run
 * paying Node startup over and over.
 *
 * This harness drives {@link runAdminCli} — the exact function
 * `dist/cli/admin.js` calls when it is invoked as a program — with the process
 * effects rebound:
 *
 *   - stdout/stderr go to buffers instead of the real streams;
 *   - `process.exit()` becomes a throw that unwinds back to here;
 *   - `process.env`, `process.cwd()`, `process.exitCode` and the resolved
 *     output mode are snapshotted and restored around every run.
 *
 * The returned `{ code, stdout, stderr }` is the same triple `execFileSync`
 * yields, so a migrated case keeps its original assertions verbatim.
 *
 * ## What this deliberately does NOT replace
 *
 * Keep a spawned case (see `admin-cli-subprocess.test.js`) whenever the
 * assertion IS the process boundary:
 *
 *   - that the real executable parses real `process.argv` and rejects unknown
 *     options;
 *   - that the real process exit status is what a shell/n8n caller observes;
 *   - that stdout and stderr are genuinely separate file descriptors;
 *   - that a run inherits no state from its caller (env isolation);
 *   - signals, or anything else with no in-process representation.
 *
 * ## Known divergences from a spawned run
 *
 *   1. `die()` unwinds by throwing rather than by `process.exit()`, so `finally`
 *      blocks that a real exit would skip DO run here. Every such block in
 *      admin.ts is a lock release or a store close that the die() path already
 *      performs explicitly (via `lockedDie`) and that is idempotent, so the
 *      observable outcome is unchanged. A case whose point is "this resource is
 *      still held after the command died" must stay a subprocess case.
 *   2. Module-load-time constants are captured once per worker, not per run.
 *      `DEFAULT_SESSIONS_PATH` resolves the home directory at import (issue
 *      #1063: from `$HOME`, which `setupFiles` has already pinned at the run's
 *      test-owned home), so overriding `HOME` via `env` will not move it — pass
 *      `--sessions-path` explicitly (which every migrated case already does).
 *   3. A leaked handle is not reclaimed by process death. Commands close their
 *      stores; a case that intentionally leaves one open should stay spawned.
 *   4. `env` reaches a child process only through a spawn site that passes it.
 *      Jest hands every module a COPY of `process.env` (jest-util's
 *      `createProcessObject`), so `execFileSync`/`spawnSync` called without an
 *      explicit `env` inherit the real worker environment and would resolve
 *      `PATH` against the host rather than against a stub the case installed.
 *      Every spawn site the admin CLI reaches passes `spawnEnv()`
 *      (src/handlers/command-runner.ts) for exactly this reason; a new one must
 *      do the same or its case has to stay spawned.
 */
import { runAdminCli } from '../../dist/cli/admin.js';
import {
  CliExit,
  getOutputMode,
  resetCliIoSink,
  setCliIoSink,
  setOutputMode,
} from '../../dist/cli/cli-io.js';

/**
 * Run one admin CLI invocation in this process.
 *
 * @param {string[]} args argv as the executable would receive it (no node/script).
 * @param {{env?: Record<string, string|undefined>, cwd?: string}} [options]
 *   `env` entries are applied over the current environment for the duration of
 *   the run (an `undefined` value deletes the variable); the whole environment
 *   is restored afterwards, including anything the command itself mutated.
 *   `cwd` changes the working directory for the duration of the run.
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
export async function runAdmin(args, options = {}) {
  const { env, cwd } = options;
  const stdoutChunks = [];
  const stderrChunks = [];
  let exitCode;

  const savedEnv = { ...process.env };
  const savedCwd = process.cwd();
  const savedExitCode = process.exitCode;
  const savedMode = getOutputMode();

  setCliIoSink({
    stdout(chunk) {
      stdoutChunks.push(chunk);
    },
    stderr(chunk) {
      stderrChunks.push(chunk);
    },
    exit(code) {
      exitCode = code;
      throw new CliExit(code);
    },
  });

  try {
    // Reset so a value left behind by an earlier test cannot be mistaken for
    // this run's result; restored in the finally below.
    process.exitCode = undefined;
    if (env) {
      for (const [key, value] of Object.entries(env)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    if (cwd !== undefined) process.chdir(cwd);

    // runAdminCli already owns the top-level failure contract, so the only throw
    // that can reach here is the sink's own unwind.
    await runAdminCli([...args]);
  } catch (err) {
    // runAdminCli turns any other throw into die(), which comes back as CliExit,
    // so anything else escaping is a harness bug and must surface as one.
    if (!(err instanceof CliExit)) throw err;
  } finally {
    if (cwd !== undefined) process.chdir(savedCwd);
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(savedEnv)) process.env[key] = value;

    // A handler that reported a soft failure sets process.exitCode instead of
    // dying; that is the run's exit status when nothing called exit().
    const reportedExitCode = process.exitCode;
    process.exitCode = savedExitCode;
    if (exitCode === undefined) exitCode = reportedExitCode ?? 0;

    resetCliIoSink();
    setOutputMode(savedMode);
  }

  return { code: exitCode, stdout: stdoutChunks.join(''), stderr: stderrChunks.join('') };
}

/** Path to the real executable, for the subprocess contract cases. */
export const ADMIN_CLI_PATH = new URL('../../dist/cli/admin.js', import.meta.url).pathname;
