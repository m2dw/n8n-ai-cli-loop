import { createHash } from "crypto";
import { mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import type { CommandRunner } from "./command-runner.js";
import type { EnvironmentPrepareConfig } from "../core/session.js";
import { parseShellTokens, boundVerificationOutput } from "./verification.js";

// ---------------------------------------------------------------------------
// Runner-owned environment preparation (issue #511; docs/environment-prepare-contract.md)
//
// Before a phase's agent runs, this module materialises the full runtime
// dependency tree (e.g. `npm ci` → node_modules) using the EXACT command the
// session operator configured — never one derived from agent output, issue
// text, or repository auto-detection.
//
// A prepare stamp (keyed by worktree identity, command, config, and cacheKeyFiles
// content) prevents redundant reinstalls across retries. A failed run leaves no
// stamp so the next run re-attempts. A changed lockfile (cacheKeyFile) invalidates
// the stamp and triggers a fresh prepare so verification can execute against
// the updated dependencies.
// ---------------------------------------------------------------------------

/** Fallback execution budget when a session omits `timeoutMs`. */
export const ENVIRONMENT_PREPARE_DEFAULT_TIMEOUT_MS = 120_000;

// Aligned with dependencySync: 80 MiB captures a verbose-but-successful
// install without overflowing Node's default 1 MiB execFile buffer.
export const MAX_ENVIRONMENT_PREPARE_BUFFER_BYTES = 80 * 1024 * 1024;

function sha256(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Safe-command gating (issue #511 review, P1)
//
// When allowLifecycleScripts is false (the default), the configured command
// must not trigger npm-style postinstall/install lifecycle scripts from
// agent-influenced manifests or newly-resolved dependencies.
//
// Unlike dependencySync (which uses an allowlist of lockfile-only forms), the
// broader purpose of environmentPrepare means non-npm commands (pip, cargo,
// go, echo, custom scripts) are safe by default. Only the npm/pnpm/yarn
// install-phase subcommands specifically execute package lifecycle hooks and
// must be refused unless --ignore-scripts is effectively set or the operator
// has opted in via allowLifecycleScripts: true.
// ---------------------------------------------------------------------------

/** npm/pnpm install subcommands that trigger package postinstall hooks. */
const NPM_INSTALL_SUBCOMMANDS = new Set(["ci", "install", "i", "add"]);
/** pnpm install subcommands that trigger postinstall hooks. */
const PNPM_INSTALL_SUBCOMMANDS = new Set(["install", "i", "add"]);

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
      if (next === "true" || next === "false") { value = next === "true"; i++; }
      else { value = true; }
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
 * Scans `args` past global option flags to find the first positional argument
 * (the subcommand). Flags of the form `--flag=value` or `-f=value` are
 * consumed in-place and skipped. Bare flags without `=` (e.g. `--prefix`)
 * may consume the following argument as their value; since we cannot determine
 * this without a complete global-options table, we return `undefined`
 * conservatively so the caller can refuse the ambiguous form.
 */
function findSubcommand(args: string[]): string | undefined {
  for (const a of args) {
    if (!a.startsWith("-")) {
      return a; // first positional argument is the subcommand
    }
    if (!a.includes("=")) {
      // bare --flag: next arg could be its value; stop rather than guess
      return undefined;
    }
    // --flag=value: value is inline, safe to skip
  }
  return undefined;
}

/**
 * Returns true when `cmd`/`args` is an npm/pnpm/yarn install-phase subcommand
 * that executes package lifecycle scripts (postinstall, etc.) without an
 * effective `--ignore-scripts` flag. Other commands — including non-npm
 * package managers, project-build tools, and harmless test shims — return
 * false and are allowed in safe mode.
 *
 * When global flags appear before the subcommand (e.g. `npm --prefix frontend
 * ci` or `pnpm --dir app install`) and the subcommand cannot be resolved
 * unambiguously, the function returns true conservatively so that the safe-mode
 * gate blocks the command unless `--ignore-scripts` is present.
 */
function isLifecycleRunningNpmInstall(cmd: string, args: string[]): boolean {
  const sub = findSubcommand(args);
  if (cmd === "npm") {
    // sub===undefined means global options prevented resolution; treat as
    // potentially install-phase (conservative refusal).
    if (sub === undefined || NPM_INSTALL_SUBCOMMANDS.has(sub)) {
      return effectiveBooleanFlag(args, "--ignore-scripts") !== true;
    }
  }
  if (cmd === "pnpm") {
    if (sub === undefined || PNPM_INSTALL_SUBCOMMANDS.has(sub)) {
      return effectiveBooleanFlag(args, "--ignore-scripts") !== true;
    }
  }
  // `yarn` / `yarn install` both run lifecycle scripts; yarn has no standard
  // --ignore-scripts for the install phase that is reliably honoured.
  if (cmd === "yarn" && (sub === undefined || sub === "install")) {
    return effectiveBooleanFlag(args, "--ignore-scripts") !== true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Worktree-lifetime sentinel (issue #511 review, P2)
//
// The artifact-root stamp survives a worktree prune + recreate at the same
// path, but the prepared outputs (e.g. node_modules) are deleted with the
// worktree. A sentinel written into the worktree-specific git dir is pruned
// along with the worktree, so a recreated checkout loses its sentinel and the
// prepare re-runs even though the artifact-root stamp still matches.
//
// In a git worktree, <cwd>/.git is a file with "gitdir: <path>"; in the
// canonical repo it is a directory. Either way, reading it gives us a
// per-checkout location that is automatically cleaned up by `git worktree
// remove` / `git worktree prune`.
// ---------------------------------------------------------------------------

function resolveGitDir(cwd: string): string {
  const gitEntry = join(cwd, ".git");
  try {
    const s = statSync(gitEntry);
    if (s.isDirectory()) return gitEntry;
    const content = readFileSync(gitEntry, "utf8").trim();
    const match = /^gitdir:\s*(.+)$/.exec(content);
    if (match) {
      const resolved = match[1].trim();
      return resolved.startsWith("/") ? resolved : join(cwd, resolved);
    }
  } catch {
    // Fallback: assume canonical .git directory.
  }
  return gitEntry;
}

function sentinelPath(cwd: string): string {
  return join(resolveGitDir(cwd), "ai-env-prepared");
}

function isSentinelValid(cwd: string, stampKey: string): boolean {
  try {
    return readFileSync(sentinelPath(cwd), "utf8").trim() === stampKey;
  } catch {
    return false;
  }
}

function writeSentinel(cwd: string, stampKey: string): void {
  try {
    const p = sentinelPath(cwd);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, stampKey, "utf8");
  } catch {
    // Best-effort: a failed write means the next run will re-prepare.
  }
}

/**
 * Stable hash of the full environmentPrepare config block. Any config change
 * (e.g. adding a cacheKeyFile, toggling allowLifecycleScripts) invalidates the
 * stamp and triggers a fresh prepare on the next call.
 */
function computeConfigHash(config: EnvironmentPrepareConfig): string {
  const normalized = JSON.stringify({
    enabled: config.enabled,
    command: config.command,
    cacheKeyFiles: config.cacheKeyFiles ? [...config.cacheKeyFiles].sort() : [],
    allowLifecycleScripts: config.allowLifecycleScripts ?? false,
    timeoutMs: config.timeoutMs ?? ENVIRONMENT_PREPARE_DEFAULT_TIMEOUT_MS,
  });
  return sha256(normalized);
}

/**
 * Combined hash of all configured cacheKeyFiles content. A lockfile change
 * (e.g. package-lock.json regenerated by dependency sync) changes this hash
 * and invalidates the stamp. Missing files contribute an empty string so a
 * fresh worktree without a lockfile is still stampable.
 */
function computeCacheKeyFilesHash(cwd: string, cacheKeyFiles: string[] | undefined): string {
  if (!cacheKeyFiles || cacheKeyFiles.length === 0) return sha256("");
  const parts: string[] = [];
  for (const file of cacheKeyFiles) {
    try {
      parts.push(readFileSync(join(cwd, file), "utf8"));
    } catch {
      parts.push(""); // file absent → empty string contribution
    }
  }
  return sha256(parts.join("\0"));
}

interface PrepareStamp {
  worktreeIdentity: string;
  commandHash: string;
  configHash: string;
  cacheKeyFilesHash: string;
  succeededAt: string;
}

function stampDir(artifactRoot: string): string {
  return join(artifactRoot, "environment-prepare-stamps");
}

function stampFilePath(artifactRoot: string, identityHash: string): string {
  return join(stampDir(artifactRoot), `${identityHash}.json`);
}

function readStamp(artifactRoot: string, identityHash: string): PrepareStamp | undefined {
  try {
    return JSON.parse(readFileSync(stampFilePath(artifactRoot, identityHash), "utf8")) as PrepareStamp;
  } catch {
    return undefined;
  }
}

function writeStamp(artifactRoot: string, identityHash: string, stamp: PrepareStamp): void {
  try {
    mkdirSync(stampDir(artifactRoot), { recursive: true });
    writeFileSync(stampFilePath(artifactRoot, identityHash), JSON.stringify(stamp, null, 2), "utf8");
  } catch {
    // Best-effort: a failed stamp write means the next run will re-prepare.
  }
}

export interface EnvironmentPrepareOutcome {
  /** `skipped` = stamp matched or config disabled; `ran` = command succeeded; `failed` = command failed. */
  status: "skipped" | "ran" | "failed";
  /** Present when the command ran (ran or failed). */
  exitCode?: number;
  /** Bounded combined stdout+stderr when the command ran. */
  output?: string;
}

export interface EnsureEnvironmentPreparedOptions {
  /** Session's environmentPrepare config block; `undefined` or `enabled: false` → no-op. */
  config: EnvironmentPrepareConfig | undefined;
  /** Working directory for the prepare command (worktree path in worktree mode; canonicalRoot in shared mode). */
  cwd: string;
  /**
   * Stable identity for this execution context. In worktree mode this is the
   * worktree path (stable for the duration of the issue); in shared mode it is
   * the canonical repo root. Used as the per-identity stamp key — each worktree
   * maintains its own stamp so a new worktree always runs prepare on first use.
   */
  worktreeIdentity: string;
  /** Session-level artifact root (for persistent stamp storage, survives across runs). */
  artifactRoot: string;
  /** Run-specific artifact dir (for the per-run `environment-prepare-result.json`). */
  artifactDir: string;
  runner: CommandRunner;
}

/**
 * Run the session's `environmentPrepare` command when enabled and not already
 * stamped for this worktree + config + cacheKeyFiles combination. An `undefined`
 * or disabled config is a no-op that returns `{ status: "skipped" }`, so the
 * call site stays unconditional.
 *
 * Stamp semantics: a successful run writes a persistent stamp keyed by
 * `worktreeIdentity`, `commandHash`, `configHash`, and `cacheKeyFilesHash`.
 * Subsequent calls with the same key return `{ status: "skipped" }` without
 * spawning a process. A changed cacheKeyFile (e.g. `package-lock.json` updated
 * by dependency sync) computes a different `cacheKeyFilesHash` and causes a
 * fresh prepare run. A failed run leaves no stamp so the next attempt retries.
 *
 * Failure semantics: a nonzero exit fails closed — the outcome is returned so
 * the caller can surface it as a phase failure rather than silently continuing
 * with a broken dependency tree.
 */
export function ensureEnvironmentPrepared(
  opts: EnsureEnvironmentPreparedOptions,
): EnvironmentPrepareOutcome {
  const { config, cwd, worktreeIdentity, artifactRoot, artifactDir, runner } = opts;

  if (!config || !config.enabled) {
    return { status: "skipped" };
  }

  const identityHash = sha256(worktreeIdentity);
  const commandHash = sha256(config.command.trim().replace(/\s+/g, " "));
  const configHash = computeConfigHash(config);
  const cacheKeyFilesHash = computeCacheKeyFilesHash(cwd, config.cacheKeyFiles);

  // Combined key used for the worktree-lifetime sentinel (issue #511 review, P2).
  // The sentinel lives in the worktree-specific git dir so it is pruned when the
  // worktree is removed or recreated, forcing a fresh prepare in the new checkout.
  const stampKey = sha256([worktreeIdentity, commandHash, configHash, cacheKeyFilesHash].join("|"));

  // Check existing stamp — skip if all four key components match AND the
  // worktree-lifetime sentinel is still present (guards against worktree prune +
  // recreate at the same path, which leaves the artifact-root stamp intact but
  // deletes node_modules / the sentinel along with the old worktree directory).
  const existing = readStamp(artifactRoot, identityHash);
  if (
    existing !== undefined &&
    existing.worktreeIdentity === worktreeIdentity &&
    existing.commandHash === commandHash &&
    existing.configHash === configHash &&
    existing.cacheKeyFilesHash === cacheKeyFilesHash &&
    isSentinelValid(cwd, stampKey)
  ) {
    try {
      writeFileSync(
        join(artifactDir, "environment-prepare-result.json"),
        JSON.stringify({ outcome: "skip", stamp: existing }, null, 2),
        "utf8",
      );
    } catch {
      // Best-effort artifact write; skip outcome is still returned.
    }
    return { status: "skipped" };
  }

  const [cmd, ...args] = parseShellTokens(config.command);
  if (!cmd) {
    // Empty/whitespace-only command is treated as a no-op, not a failure.
    return { status: "skipped" };
  }

  // Safe mode (issue #511 review, P1): when allowLifecycleScripts is false (the
  // default), the command must not run npm-style postinstall/install scripts.
  // The agent may have edited manifests and dependency sync may have updated the
  // lockfile, so a lifecycle-running command (e.g. bare `npm ci`) would execute
  // install scripts from agent-influenced dependencies — re-opening the arbitrary-
  // code-execution path the narrow agent allowedTools set exists to close.
  // Non-npm commands (pip, go, cargo, echo, custom scripts) are allowed as-is.
  // Set allowLifecycleScripts: true to run npm/pnpm/yarn install without --ignore-scripts.
  if (!config.allowLifecycleScripts && isLifecycleRunningNpmInstall(cmd, args)) {
    const output =
      `Environment prepare command ${JSON.stringify(config.command)} runs npm/pnpm/yarn ` +
      `lifecycle scripts (postinstall hooks) from agent-influenced dependencies. ` +
      `In safe mode (allowLifecycleScripts unset or false) this is refused: use ` +
      `\`--ignore-scripts\` (e.g. \`npm ci --ignore-scripts\`) to suppress lifecycle ` +
      `scripts, or set environmentPrepare.allowLifecycleScripts: true to explicitly ` +
      `accept the risk.`;
    try {
      writeFileSync(
        join(artifactDir, "environment-prepare-result.json"),
        JSON.stringify({
          outcome: "refused",
          kind: "unsafe-command",
          output,
          worktreeIdentity,
          commandHash,
          configHash,
          cacheKeyFilesHash,
        }, null, 2),
        "utf8",
      );
    } catch {
      // Best-effort.
    }
    return { status: "failed", exitCode: 0, output };
  }

  const result = runner.run(cmd, args, {
    cwd,
    timeout: config.timeoutMs ?? ENVIRONMENT_PREPARE_DEFAULT_TIMEOUT_MS,
    maxBuffer: MAX_ENVIRONMENT_PREPARE_BUFFER_BYTES,
  });

  const output = boundVerificationOutput(
    [result.stdout, result.stderr].filter(Boolean).join("\n"),
  );

  if (result.exitCode !== 0) {
    try {
      writeFileSync(
        join(artifactDir, "environment-prepare-result.json"),
        JSON.stringify({
          outcome: "failed",
          exitCode: result.exitCode,
          output,
          worktreeIdentity,
          commandHash,
          configHash,
          cacheKeyFilesHash,
        }, null, 2),
        "utf8",
      );
    } catch {
      // Best-effort.
    }
    // No stamp written on failure — next run retries.
    return { status: "failed", exitCode: result.exitCode, output };
  }

  // Success: persist the stamp so the next call with the same key is a no-op.
  const stamp: PrepareStamp = {
    worktreeIdentity,
    commandHash,
    configHash,
    cacheKeyFilesHash,
    succeededAt: new Date().toISOString(),
  };
  writeStamp(artifactRoot, identityHash, stamp);
  // Write the worktree-lifetime sentinel (issue #511 review, P2). This lives in
  // the worktree-specific git dir so it is pruned when the worktree is removed or
  // recreated, ensuring the prepare re-runs in the new checkout even when the
  // artifact-root stamp still matches.
  writeSentinel(cwd, stampKey);

  try {
    writeFileSync(
      join(artifactDir, "environment-prepare-result.json"),
      JSON.stringify({ outcome: "run", exitCode: 0, output, stamp }, null, 2),
      "utf8",
    );
  } catch {
    // Best-effort.
  }

  return { status: "ran", exitCode: 0, output };
}

/**
 * Deletes the worktree-lifetime sentinel so the next `ensureEnvironmentPrepared`
 * call re-runs the prepare command regardless of the artifact-root stamp. Call
 * this after a `git clean -fd` or similar operation that may have removed
 * prepare-materialised files (e.g. node_modules) from a path not covered by
 * .gitignore, so the stamp reflects the actual state of the checkout.
 */
export function clearPrepareSentinel(cwd: string): void {
  try {
    unlinkSync(sentinelPath(cwd));
  } catch {
    // Best-effort: missing sentinel or permission error is harmless — the next
    // prepare call will re-run anyway when isSentinelValid returns false.
  }
}
