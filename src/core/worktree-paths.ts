/**
 * Per-issue worktree path + identity helpers (issue #400).
 *
 * Pure, dependency-free path math for the per-issue git worktree model described
 * in docs/per-issue-worktrees.md. The git-side operations (create / list / prune)
 * and the issue-scoped lock live in src/handlers/worktree.ts; this module owns
 * only the deterministic layout so that both the handler/runtime side and the
 * outbox visibility redaction can agree on where worktrees live WITHOUT importing
 * any command-runner / store machinery.
 *
 * Layout (mirrors the issue's proposed model):
 *
 *   <root>/<session>/issue-<n>/repo/
 *
 * `<root>` defaults to the XDG-style state dir
 * `~/.local/state/n8n-ai-cli-loop/worktrees`, is overridable per-process via the
 * `N8N_AI_WORKTREE_ROOT` environment variable, and per-session via
 * `session.worktrees.root`. The session segment is URL-encoded so a sessionId
 * containing `/` (or any other path-special character) can never traverse out of
 * `<root>`.
 */

import { homedir } from "os";
import { isAbsolute, join } from "path";

/** Environment variable that overrides the managed worktree state root. */
export const WORKTREE_ROOT_ENV = "N8N_AI_WORKTREE_ROOT";

/**
 * Default managed state root for per-issue worktrees. Mirrors the lock store's
 * `~/.local/state/n8n-ai-cli-loop/...` convention so all durable workflow state
 * lives under one predictable tree.
 */
export const DEFAULT_WORKTREE_ROOT = join(
  homedir(),
  ".local",
  "state",
  "n8n-ai-cli-loop",
  "worktrees",
);

/**
 * Resolve the worktree state root, honoring (in order): an explicit per-session
 * `root`, the `N8N_AI_WORKTREE_ROOT` env override, then {@link DEFAULT_WORKTREE_ROOT}.
 * A blank/whitespace value is treated as unset so it never collapses the root to
 * the empty string.
 *
 * A provided root (session or env) MUST be absolute. A relative root would make
 * {@link issueWorktreePath} relative too, so `git worktree add` would resolve it
 * against `repoRoot` and create an untracked `worktrees/` tree inside the
 * canonical checkout — breaking the documented guarantee that worktrees live
 * outside committed source. Reject it loudly, mirroring the session-file
 * validator (`validateWorktreeConfig`), rather than silently returning a relative
 * value. The {@link DEFAULT_WORKTREE_ROOT} fallback is always absolute.
 */
export function resolveWorktreeRoot(
  opts: { sessionRoot?: string; env?: NodeJS.ProcessEnv } = {},
): string {
  const sessionRoot = opts.sessionRoot;
  if (typeof sessionRoot === "string" && sessionRoot.trim().length > 0) {
    return requireAbsoluteRoot(sessionRoot, "session worktrees.root");
  }
  const env = opts.env ?? process.env;
  const override = env[WORKTREE_ROOT_ENV];
  if (typeof override === "string" && override.trim().length > 0) {
    return requireAbsoluteRoot(override, WORKTREE_ROOT_ENV);
  }
  return DEFAULT_WORKTREE_ROOT;
}

/**
 * Guard that a configured worktree root is absolute, throwing a descriptive error
 * (naming its source) otherwise. Keeps the per-issue worktree layout anchored
 * outside the canonical checkout regardless of which override supplied the root.
 */
function requireAbsoluteRoot(root: string, source: string): string {
  if (!isAbsolute(root)) {
    throw new Error(`${source} must be an absolute path, got: ${root}`);
  }
  return root;
}

/**
 * Encode a single path segment so values containing `/` or other path-special
 * characters cannot escape the parent directory via `path.join` traversal. Uses
 * the same `encodeURIComponent` strategy as the repo-lock store's lock-file
 * naming so identical IDs map to identical on-disk names across the two systems.
 *
 * `encodeURIComponent` leaves `.` unescaped, so a dot-only segment (`.` or `..`)
 * survives unchanged and `path.join` would then resolve it as a current/parent
 * directory reference rather than a literal directory name — letting a sessionId
 * of `.` or `..` traverse out of the managed worktree root and break the
 * isolation guarantee. Percent-encode the dots in any dot-only segment so it maps
 * to a literal on-disk name (`.` → `%2E`, `..` → `%2E%2E`) that cannot traverse.
 */
function encodeSegment(value: string): string {
  const encoded = encodeURIComponent(value);
  if (/^\.+$/.test(encoded)) {
    return encoded.replace(/\./g, "%2E");
  }
  return encoded;
}

/**
 * Stable, human-readable identifier for an issue's worktree, independent of the
 * absolute filesystem location. Recorded in task context so a later phase (or an
 * admin command) can re-resolve the same worktree even if the state root moved.
 */
export function issueWorktreeId(sessionId: string, issueNumber: number): string {
  return `${sessionId}/issue-${issueNumber}`;
}

/** Directory that holds all of a session's per-issue worktrees. */
export function sessionWorktreeDir(root: string, sessionId: string): string {
  return join(root, encodeSegment(sessionId));
}

/**
 * Absolute path to the git checkout for a single issue's worktree:
 * `<root>/<session>/issue-<n>/repo`.
 */
export function issueWorktreePath(
  root: string,
  sessionId: string,
  issueNumber: number,
): string {
  return join(sessionWorktreeDir(root, sessionId), `issue-${issueNumber}`, "repo");
}

/**
 * Replace any reference to the managed worktree root (and its sub-paths) with a
 * `<worktree>` placeholder so a local worktree path is never surfaced in a public
 * comment (issue #400 acceptance: "Public GitHub/Gitea comments never include
 * local worktree paths"). This is a targeted complement to the generic absolute-
 * path stripping in {@link sanitizeBody}; it guarantees coverage even when the
 * root lives under a non-standard top-level directory that the generic heuristic
 * does not recognize.
 */
export function redactWorktreePaths(text: string, root: string): string {
  if (!root || !root.startsWith("/")) return text;
  const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(
    new RegExp(`(?<![:/\\w])${escaped}(?:/[^\\s<>"'\`\\]})]*)?`, "g"),
    "<worktree>",
  );
}
