import { spawnSync } from "child_process";
import type { CommandRunner } from "../../handlers/command-runner.js";

// ---------------------------------------------------------------------------
// Injectable `gh` executor
//
// The single seam the gh-backed providers depend on: an executor that runs a
// `gh` invocation and returns its exit code / output. Tests inject a fake to
// assert the exact argv and to drive parsing/error branches without a live
// GitHub connection. This is the "command/API runner" injection point referenced
// by the provider interfaces.
// ---------------------------------------------------------------------------

export interface GhRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface GhRunner {
  run(args: string[], opts: { cwd: string; timeout?: number }): GhRunResult;
}

/** Default executor: shells out to the real `gh` CLI. */
export const defaultGhRunner: GhRunner = {
  run(args, opts) {
    const result = spawnSync("gh", args, {
      cwd: opts.cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: opts.timeout,
    });
    return {
      exitCode: result.status ?? 1,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  },
};

/**
 * Adapt a generic {@link CommandRunner} into a `gh` executor. Handlers already
 * inject a CommandRunner (used for git too); this wraps it so they can build a
 * gh-backed provider from the same injected runner, keeping a single test seam.
 * The forwarded argv is unchanged, so runner-level argv assertions still hold.
 */
export function ghRunnerFromCommandRunner(runner: CommandRunner): GhRunner {
  return {
    run(args, opts) {
      const r = runner.run("gh", args, { cwd: opts.cwd, timeout: opts.timeout });
      return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
    },
  };
}
