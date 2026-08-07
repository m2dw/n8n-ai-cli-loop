import { execFileSync, spawnSync } from "child_process";

export interface CommandRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /**
   * A RUNNER-synthesized diagnostic for a spawn-level failure (timeout, buffer
   * overflow, `ENOENT`) — bytes the child process never wrote.
   *
   * A runner that sets this MUST also have appended it VERBATIM to the end of
   * `stderr`, so every caller that only reads `stderr` keeps seeing the
   * diagnostic exactly as before. It exists for the callers that promise to
   * persist only child-authored output — the reviewer-reconsideration raw
   * transcript (issue #838, contract §10.2) may hold the agent's bytes and
   * nothing else — which strip precisely this suffix rather than guessing which
   * trailing bytes the child did not write.
   */
  spawnError?: string;
}

export interface CommandRunOptions {
  cwd: string;
  /** When provided, written to the process stdin. */
  stdin?: string;
  /**
   * The child's environment. Defaults to the runner's own (see {@link spawnEnv});
   * supply it only to run a command under a DIFFERENT environment than this
   * process's — e.g. the isolated, credential-stripped env the read-only
   * reviewer-reconsideration invocation spawns its agent with (issue #838).
   */
  env?: NodeJS.ProcessEnv;
  /** Maximum time in milliseconds the command is allowed to run. */
  timeout?: number;
  /** Maximum bytes allowed in the combined stdout+stderr buffer. */
  maxBuffer?: number;
}

export interface CommandRunner {
  run(cmd: string, args: string[], opts: CommandRunOptions): CommandRunResult;
}

/**
 * The environment children are spawned with. This is the same value both
 * `execFileSync` and `spawnSync` already default to, but that default is read
 * from the *real* process object, while a test sandbox hands this module a copy
 * of `process.env`: without passing it explicitly, a child (and its `PATH`
 * lookup) silently uses the real environment instead of the one the caller can
 * observe — e.g. the host's `agy` rather than the stub a test put on `PATH`.
 * Mirrors src/cli/session-audit.ts, which passes it for the same reason.
 */
function spawnEnv(): NodeJS.ProcessEnv {
  return process.env;
}

export const defaultCommandRunner: CommandRunner = {
  run(cmd, args, opts) {
    try {
      const stdout = execFileSync(cmd, args, {
        cwd: opts.cwd,
        env: opts.env ?? spawnEnv(),
        encoding: "utf8",
        input: opts.stdin,
        stdio: opts.stdin !== undefined ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
        timeout: opts.timeout,
        maxBuffer: opts.maxBuffer,
      });
      return { stdout, stderr: "", exitCode: 0 };
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; status?: number };
      return {
        stdout: e.stdout ?? "",
        stderr: e.stderr ?? String(err),
        exitCode: e.status ?? 1,
      };
    }
  },
};

/**
 * Like {@link defaultCommandRunner} but captures BOTH stdout and stderr on every
 * exit code, including success. `execFileSync` discards the stderr it buffered
 * once the command exits 0 (it only returns stdout), so a command that succeeds
 * while writing diagnostics to stderr loses them. The Tool Request grant artifact
 * contract (issue #301) records stdout/stderr/exit code for the granted command
 * regardless of outcome, so that path uses this `spawnSync`-based runner.
 */
export const bothStreamsCommandRunner: CommandRunner = {
  run(cmd, args, opts) {
    const result = spawnSync(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? spawnEnv(),
      encoding: "utf8",
      input: opts.stdin,
      stdio: opts.stdin !== undefined ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
      timeout: opts.timeout,
      maxBuffer: opts.maxBuffer,
    });
    // A spawn-level failure (e.g. timeout, buffer overflow, ENOENT) surfaces via
    // `error`; report it as nonzero with the message on stderr so callers don't
    // mistake it for a clean success. It is also reported separately, as the
    // suffix it is, for callers that must not attribute it to the child (see
    // {@link CommandRunResult.spawnError}).
    if (result.error) {
      const spawnError = String(result.error);
      return {
        stdout: result.stdout ?? "",
        stderr: (result.stderr ? result.stderr : "") + spawnError,
        exitCode: typeof result.status === "number" ? result.status : 1,
        spawnError,
      };
    }
    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      // A process killed by a signal has a null status; treat it as nonzero.
      exitCode: result.status ?? 1,
    };
  },
};
