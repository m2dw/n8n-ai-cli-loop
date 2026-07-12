import { writeFileSync } from "fs";
import { join } from "path";
import type { CommandRunner } from "./command-runner.js";
import { parseShellTokens, boundVerificationOutput } from "./verification.js";
import type { DependencySyncConfig } from "../core/session.js";

// ---------------------------------------------------------------------------
// Handler-owned dependency sync (issue #290; docs/tool-request-and-dependency-sync.md §3)
//
// After the implementation agent edits a manifest such as `package.json`, the
// lockfile must be regenerated. The mutating dependency command is a
// handler-owned, session-pinned operation that runs OUTSIDE the agent permission
// surface — it is never added to the Claude `allowedTools` set. The handler runs
// the EXACT configured command, only when a configured trigger path actually
// changed in this run, with a bounded time budget and captured output.
// ---------------------------------------------------------------------------

/** Fallback execution budget when a session omits `timeoutMs`. */
export const DEPENDENCY_SYNC_DEFAULT_TIMEOUT_MS = 120_000;

// Capture buffer for the sync command's combined stdout+stderr. Kept aligned
// with the verification buffer (80 MiB) so a verbose-but-successful resolve does
// not overflow Node's default 1 MiB execFile buffer and get misreported as a
// failure before the output is bounded.
export const MAX_DEPENDENCY_SYNC_BUFFER_BYTES = 80 * 1024 * 1024;

export interface DependencySyncFailure {
  /** `exit` = the command exited non-zero (covers timeouts, which surface as a
   * non-zero/killed exit). `unsafe-command` = the configured command would run
   * package-manager lifecycle scripts but the session did not opt in via
   * `allowLifecycleScripts`, so the handler refused to run it (no process ran;
   * `exitCode` is 0). `missing-outputs` is reserved but not currently used as a
   * failure trigger (see runDependencySync). */
  kind: "exit" | "unsafe-command";
  exitCode: number;
  /** Bounded combined stdout+stderr from the command. */
  output: string;
}

export interface DependencySyncOutcome {
  /** Whether the sync command was actually executed. */
  ran: boolean;
  /** Whether the sync succeeded. Only meaningful when `ran` is true. */
  passed: boolean;
  /** The exact command string, when a command ran (for metadata/artifacts). */
  command?: string;
  /** Trigger paths that changed in this run — the reason the sync ran. */
  changedTriggerPaths: string[];
  /**
   * Of the configured `expectedOutputs`, the ones whose working-tree state
   * changed after the sync. Informational: a no-op (already-synced) lockfile is
   * a legitimate success, so empty does NOT mean failure.
   */
  producedExpectedOutputs: string[];
  /**
   * True when this run was a forced resync triggered NOT by a fresh manifest
   * change but because a previous sync in this run had already regenerated an
   * expected output and a later repair reverted/removed the manifest edit,
   * leaving that output stale. The resync brings the output back into sync with
   * the current manifest state so a stale lockfile is never committed
   * (issue #290 review).
   */
  resyncedStaleOutputs?: boolean;
  /** Present only when `ran` is true and `passed` is false. */
  failure?: DependencySyncFailure;
}

/**
 * Parse `git status --porcelain` output into the set of changed repo-relative
 * paths. Handles the rename form `XY old -> new` by taking the new path.
 */
/**
 * Known lockfile-only command shapes: forms that resolve dependencies and write
 * a lockfile WITHOUT executing project or dependency lifecycle scripts and
 * WITHOUT materialising `node_modules` / a full dependency tree. Each entry pins
 * the package-manager binary, the leading subcommand token(s) (matched in order
 * at the start of the args), and any flags that must ALL be present for the form
 * to stay lockfile-only.
 *
 * Recognising specific shapes — rather than merely scanning the args for an
 * `--ignore-scripts` token — is what keeps safe mode safe. A bare token scan
 * would accept `npm run build --ignore-scripts` (which still runs the
 * agent-editable `build` script from `package.json`; `--ignore-scripts` only
 * suppresses npm's own pre/post hooks, not the named script) and a shell wrapper
 * such as `./wrapper.sh --ignore-scripts` that carries the flag as a dummy arg
 * while executing arbitrary code. Both re-open the handler-side execution path
 * the dependency-sync boundary exists to close. Anything not matched here must
 * opt in via `allowLifecycleScripts`
 * (docs/tool-request-and-dependency-sync.md §3.2a).
 */
const LOCKFILE_ONLY_COMMAND_SHAPES: ReadonlyArray<{
  bin: string;
  subcommand: readonly string[];
  requiredFlags?: readonly string[];
}> = [
  { bin: "npm", subcommand: ["install"], requiredFlags: ["--package-lock-only", "--ignore-scripts"] },
  { bin: "npm", subcommand: ["i"], requiredFlags: ["--package-lock-only", "--ignore-scripts"] },
  { bin: "pnpm", subcommand: ["install"], requiredFlags: ["--lockfile-only", "--ignore-scripts"] },
  { bin: "pnpm", subcommand: ["i"], requiredFlags: ["--lockfile-only", "--ignore-scripts"] },
  { bin: "cargo", subcommand: ["generate-lockfile"] },
  { bin: "poetry", subcommand: ["lock"] },
  { bin: "go", subcommand: ["mod", "tidy"] },
  { bin: "go", subcommand: ["mod", "download"] },
];

/**
 * Resolve the EFFECTIVE boolean value of a package-manager boolean flag such as
 * `--ignore-scripts`, mirroring how npm/pnpm (nopt) collapse repeated/negated
 * occurrences to the LAST one. Returns `undefined` when the flag is absent.
 *
 * A presence-only scan is unsafe here: a configured command may carry the
 * required flag and a later negation, e.g.
 * `npm install --package-lock-only --ignore-scripts --ignore-scripts=false`,
 * which the package manager evaluates as `--ignore-scripts=false` and so runs
 * lifecycle scripts from the agent-edited manifest outside the permission
 * boundary (issue #290 review). Recognized negation forms: `--no-<flag>`,
 * `--<flag>=false|0|""`, and the separate-token `--<flag> false` shape nopt
 * accepts. Truthy forms: bare `--<flag>`, `--<flag>=true|1|<other>`, and
 * `--<flag> true`.
 */
function effectiveBooleanFlag(args: string[], flag: string): boolean | undefined {
  const name = flag.replace(/^--/, "");
  const negFlag = `--no-${name}`;
  const parseVal = (v: string): boolean => {
    const t = v.toLowerCase();
    return !(t === "false" || t === "0" || t === "");
  };
  let value: boolean | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === flag) {
      const next = args[i + 1];
      if (next === "true" || next === "false") {
        value = next === "true";
        i++;
      } else {
        value = true;
      }
    } else if (a.startsWith(`${flag}=`)) {
      value = parseVal(a.slice(flag.length + 1));
    } else if (a === negFlag) {
      value = false;
    } else if (a.startsWith(`${negFlag}=`)) {
      value = !parseVal(a.slice(negFlag.length + 1));
    }
  }
  return value;
}

/**
 * True when `cmd`/`args` match one of the recognized lockfile-only shapes above.
 * The binary must match exactly (so a shell wrapper cannot pose as a package
 * manager), the shape's subcommand token(s) must lead the args in order (so
 * `npm run …` is rejected because its first token is `run`, not `install`), and
 * every required flag must be EFFECTIVELY enabled — a later negation/duplicate
 * that flips a required boolean off (see `effectiveBooleanFlag`) disqualifies the
 * command rather than being silently accepted.
 */
function isLockfileOnlyCommand(cmd: string, args: string[]): boolean {
  return LOCKFILE_ONLY_COMMAND_SHAPES.some((shape) => {
    if (cmd !== shape.bin) return false;
    if (shape.subcommand.some((tok, i) => args[i] !== tok)) return false;
    if (
      shape.requiredFlags &&
      !shape.requiredFlags.every((flag) => effectiveBooleanFlag(args, flag) === true)
    ) {
      return false;
    }
    return true;
  });
}

function changedPaths(runner: CommandRunner, cwd: string): Set<string> {
  const status = runner.run("git", ["status", "--porcelain"], { cwd });
  const paths = new Set<string>();
  for (const line of status.stdout.split("\n")) {
    if (line.length <= 3) continue;
    let path = line.slice(3).trim();
    const arrow = path.indexOf(" -> ");
    if (arrow !== -1) path = path.slice(arrow + 4).trim();
    if (path.length > 0) paths.add(path);
  }
  return paths;
}

/**
 * Run the session's dependency-sync command when enabled and a trigger path
 * changed. A `undefined` or disabled config is a no-op that returns
 * `{ ran: false, passed: true }`, so the call site stays unconditional.
 *
 * The handler runs the EXACT configured command (never one derived from agent
 * output), bounds its runtime and output, and writes the bounded stdout/stderr
 * as a local run artifact. A non-zero exit (which also covers a timeout, killed
 * mid-run) is surfaced as a failure for the caller to convert into actionable
 * feedback / a handoff — never a silent pass.
 *
 * `previousOutcome` carries the result of an earlier sync in the SAME run (the
 * verification repair loop calls this once per repair). It lets the handler
 * detect a stale expected output: if a previous sync already regenerated the
 * lockfile and a repair then reverted the manifest so no trigger path is dirty
 * now, the lockfile diff would otherwise be staged with no matching manifest
 * change. In that case the handler forces a resync (issue #290 review).
 */
export function runDependencySync(
  runner: CommandRunner,
  config: DependencySyncConfig | undefined,
  cwd: string,
  artifactDir?: string,
  previousOutcome?: DependencySyncOutcome,
): DependencySyncOutcome {
  const noop: DependencySyncOutcome = {
    ran: false,
    passed: true,
    changedTriggerPaths: [],
    producedExpectedOutputs: [],
  };

  if (!config || !config.enabled) return noop;

  const changedBefore = changedPaths(runner, cwd);
  const changedTriggerPaths = config.triggerPaths.filter((p) => changedBefore.has(p));

  // A previous sync in this run already regenerated an expected output (e.g.
  // package-lock.json). If a later repair reverted/removed the manifest edit so
  // no trigger path is dirty now, that output is stale — it no longer matches
  // the manifest, yet the staging step would still commit it. The lockfile is
  // only ever written by this handler (the agent edits manifests, not
  // lockfiles), so a dirty expected output with no trigger change after a prior
  // sync is unambiguously stale. Force a resync to regenerate it against the
  // current manifest state, restoring consistency (issue #290 review).
  const resyncStaleOutputs =
    changedTriggerPaths.length === 0 &&
    previousOutcome?.ran === true &&
    config.expectedOutputs.some((p) => changedBefore.has(p));

  if (changedTriggerPaths.length === 0 && !resyncStaleOutputs) return noop;

  const [cmd, ...args] = parseShellTokens(config.command);
  if (!cmd) {
    // A configured-but-empty command cannot regenerate anything; treat as a no-op
    // rather than spawning an empty process.
    return { ...noop, changedTriggerPaths };
  }

  // Safe mode (docs §3.2a): a fixed `command` string pins WHICH command runs but
  // not WHAT code runs. The agent edits package.json via an allowed Edit, so a
  // lifecycle-running form such as `npm install` would then execute install
  // scripts from the agent-influenced manifest and every newly resolved
  // dependency — re-opening the arbitrary-code-execution path the narrow agent
  // allowedTools set exists to close. Only a recognized lockfile-only shape (see
  // LOCKFILE_ONLY_COMMAND_SHAPES) is allowed to run without an explicit opt-in;
  // any other command — including project-script runners like `npm run …` and
  // shell wrappers that merely carry a dummy `--ignore-scripts` arg — is refused
  // unless the session has accepted the risk via `allowLifecycleScripts`.
  if (!config.allowLifecycleScripts && !isLockfileOnlyCommand(cmd, args)) {
    return {
      ran: false,
      passed: false,
      command: config.command,
      changedTriggerPaths,
      producedExpectedOutputs: [],
      ...(resyncStaleOutputs ? { resyncedStaleOutputs: true } : {}),
      failure: {
        kind: "unsafe-command",
        exitCode: 0,
        output:
          `Dependency sync command ${JSON.stringify(config.command)} is not a recognized ` +
          `lockfile-only form, so it could execute project or lifecycle scripts (e.g. via ` +
          `\`npm run …\` or a shell wrapper) influenced by the agent-edited manifest, outside the ` +
          `agent permission boundary. Use a recognized lockfile-only command (for npm: ` +
          `"npm install --package-lock-only --ignore-scripts"), or set ` +
          `dependencySync.allowLifecycleScripts: true to explicitly accept that risk.`,
      },
    };
  }

  const result = runner.run(cmd, args, {
    cwd,
    timeout: config.timeoutMs ?? DEPENDENCY_SYNC_DEFAULT_TIMEOUT_MS,
    maxBuffer: MAX_DEPENDENCY_SYNC_BUFFER_BYTES,
  });

  if (artifactDir) {
    writeFileSync(
      join(artifactDir, "dependency-sync.log"),
      result.stdout + result.stderr,
      "utf8",
    );
  }

  if (result.exitCode !== 0) {
    return {
      ran: true,
      passed: false,
      command: config.command,
      changedTriggerPaths,
      producedExpectedOutputs: [],
      ...(resyncStaleOutputs ? { resyncedStaleOutputs: true } : {}),
      failure: {
        kind: "exit",
        exitCode: result.exitCode,
        output: boundVerificationOutput([result.stdout, result.stderr].filter(Boolean).join("\n")),
      },
    };
  }

  // Confirm what the sync touched (informational). expectedOutputs that now show
  // as changed in the working tree are the evidence the sync did something; an
  // already-in-sync lockfile legitimately produces none and is still a success.
  const changedAfter = changedPaths(runner, cwd);
  const producedExpectedOutputs = config.expectedOutputs.filter((p) => changedAfter.has(p));

  return {
    ran: true,
    passed: true,
    command: config.command,
    changedTriggerPaths,
    producedExpectedOutputs,
    ...(resyncStaleOutputs ? { resyncedStaleOutputs: true } : {}),
  };
}
