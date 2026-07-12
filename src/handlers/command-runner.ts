import { execFileSync, spawnSync } from "child_process";

export interface CommandRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface CommandRunOptions {
  cwd: string;
  /** When provided, written to the process stdin. */
  stdin?: string;
  /** Maximum time in milliseconds the command is allowed to run. */
  timeout?: number;
  /** Maximum bytes allowed in the combined stdout+stderr buffer. */
  maxBuffer?: number;
}

export interface CommandRunner {
  run(cmd: string, args: string[], opts: CommandRunOptions): CommandRunResult;
}

export const defaultCommandRunner: CommandRunner = {
  run(cmd, args, opts) {
    try {
      const stdout = execFileSync(cmd, args, {
        cwd: opts.cwd,
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
      encoding: "utf8",
      input: opts.stdin,
      stdio: opts.stdin !== undefined ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
      timeout: opts.timeout,
      maxBuffer: opts.maxBuffer,
    });
    // A spawn-level failure (e.g. timeout, buffer overflow, ENOENT) surfaces via
    // `error`; report it as nonzero with the message on stderr so callers don't
    // mistake it for a clean success.
    if (result.error) {
      return {
        stdout: result.stdout ?? "",
        stderr: (result.stderr ? result.stderr : "") + String(result.error),
        exitCode: typeof result.status === "number" ? result.status : 1,
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
