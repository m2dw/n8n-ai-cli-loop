/**
 * Home-directory resolution for the managed config/state roots (issue #1063).
 *
 * Every durable default this project owns — the sessions registry, the SQLite
 * databases, the repo lock dir, the per-issue worktree root and its lock dir —
 * hangs off the user's home directory. They all used to call `homedir()`
 * directly, which is *almost* right: on POSIX Node reads `$HOME` first and only
 * falls back to the passwd entry, so a real run resolves the identical path
 * either way.
 *
 * The difference is who can observe and redirect it. `homedir()` asks libuv,
 * which reads the *real* process environment; a spawned child, and a Jest test
 * sandbox, only ever see `process.env` — and Jest hands each test file a COPY of
 * it (jest-util's `createProcessObject`), so a value assigned there never
 * reaches libuv. Resolving from the variable instead keeps the home this code
 * answers with the same one anything downstream would observe: a fixture that
 * points `HOME` at its own temporary directory gets defaults under that
 * directory rather than defaults under the operator's real home, which is how
 * a test run stops depending on — and stops writing to — operator state.
 *
 * This is not a new policy; `handlers/antigravity-workspace.ts` already read
 * `$HOME` before `homedir()` for exactly this reason (issue #830) and now shares
 * this helper. Production paths are unchanged: the precedence here IS the
 * precedence Node itself applies.
 */

import { homedir } from "os";

/**
 * The environment variable the platform's own `homedir()` consults first:
 * `USERPROFILE` on Windows, `HOME` everywhere else. Reading the same one Node
 * reads is what keeps {@link resolveHomeDir} equivalent to `homedir()` rather
 * than a second, differently-behaved notion of "home".
 */
export function homeDirEnvVar(platform: NodeJS.Platform = process.platform): "USERPROFILE" | "HOME" {
  return platform === "win32" ? "USERPROFILE" : "HOME";
}

/**
 * The home directory the managed defaults hang off.
 *
 * A blank/whitespace value is treated as unset rather than collapsing the root
 * to the empty string (which would silently relocate every default to a
 * relative path under the process's cwd), mirroring how
 * `core/worktree-paths.ts` treats a blank worktree root.
 */
export function resolveHomeDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const value = env[homeDirEnvVar(platform)];
  return typeof value === "string" && value.trim().length > 0 ? value : homedir();
}
