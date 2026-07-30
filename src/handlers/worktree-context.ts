/**
 * Per-issue worktree execution-context resolver (issue #438).
 *
 * A thin layer between the phase runner and the worktree manager
 * (handlers/worktree.ts). Before a phase runs, the runner asks this resolver
 * to resolve or create the deterministic issue worktree and report its stable
 * identity (worktreeId + checkout path) so the runner can record it in task
 * context.
 */

import type { ResolvedSession } from "../core/session.js";
import type { CommandRunner } from "./command-runner.js";
import { defaultCommandRunner } from "./command-runner.js";
import {
  resolveWorktreeRoot,
  issueWorktreeId,
  issueWorktreePath,
} from "../core/worktree-paths.js";
import { resolveIssueWorktree, canonicalizePath, isPathInside } from "./worktree.js";
import { branchName } from "./pr-helpers.js";

export interface WorktreeExecutionContextInput {
  session: ResolvedSession;
  issueNumber: number;
  /**
   * Branch the worktree is checked out on. Defaults to the canonical
   * `ai/issue-<n>` name; callers may override (e.g. a future stacked-branch flow).
   */
  branch?: string;
  /**
   * Start point used ONLY when the worktree/branch is created fresh. Defaults to
   * the session base branch (`baseBranch`, falling back to `main`). Ignored when
   * an existing worktree or branch is reused (see {@link resolveIssueWorktree}).
   */
  baseRef?: string;
  /**
   * Whether to actually create/check out the issue worktree (a git side effect),
   * versus only computing its deterministic identity.
   *
   * Defaults to `false`: the resolver reports the stable `<root>/<session>/
   * issue-<n>/repo` path + id WITHOUT any `git worktree add` or branch checkout.
   * A caller that is about to run a handler inside the worktree passes
   * `create: true` to materialize it.
   */
  create?: boolean;
  runner?: CommandRunner;
  env?: NodeJS.ProcessEnv;
}

/** The resolved execution context for one phase run. */
export interface WorktreeExecutionContext {
  /** Stable, location-independent identity recorded in task context. */
  worktreeId: string;
  /** Absolute checkout path (local-only; never published to public comments). */
  worktreePath: string;
  branch: string;
  /**
   * True when this run created the worktree. Always `false` in the default
   * non-mutating mode (`create: false`), which records the deterministic
   * identity without materializing the worktree.
   */
  created: boolean;
}

export type ResolveWorktreeExecutionContextResult =
  | { ok: true; context: WorktreeExecutionContext }
  | { ok: false; error: string };

/**
 * Resolve the per-issue worktree execution context for a phase run.
 *
 * - Default (`create: false`) → compute the deterministic
 *   `<root>/<session>/issue-<n>/repo` identity (id + path) with NO git side
 *   effect.
 * - `create: true` → resolve/create that worktree on the `ai/issue-<n>`
 *   branch via the existing worktree manager.
 */
export function resolveWorktreeExecutionContext(
  input: WorktreeExecutionContextInput,
): ResolveWorktreeExecutionContextResult {
  const { session, issueNumber } = input;

  // Resolve the managed state root honoring session → env → default order, so the
  // session's `worktrees.root` override is respected (resolveIssueWorktree alone
  // would only consult env/default). An absolute-path violation throws here and is
  // surfaced as a typed error rather than crashing the run.
  let worktreeRoot: string;
  try {
    worktreeRoot = resolveWorktreeRoot({ sessionRoot: session.worktrees?.root, env: input.env });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  const branch = input.branch ?? branchName(issueNumber);
  const baseRef = input.baseRef ?? session.baseBranch ?? "main";

  // Default (non-mutating): report only the deterministic identity. No
  // `git worktree add` / branch checkout runs.
  if (input.create !== true) {
    // An absolute root can still sit *inside* the canonical checkout (e.g.
    // `<repoRoot>/worktrees`), where any later materialization would plant the
    // issue checkout under committed source. `resolveIssueWorktree` fails closed
    // on exactly this, but that guard only runs on the mutating (`create: true`)
    // path — so apply the same outside-checkout validation here before reporting
    // an in-repo worktree path the runner would persist as a valid identity. Skip
    // reporting an unusable worktree context rather than letting a repo-working
    // phase proceed against a path that can never be materialized.
    const canonicalRoot = canonicalizePath(worktreeRoot);
    const canonicalRepoRoot = canonicalizePath(session.repoRoot);
    if (isPathInside(canonicalRoot, canonicalRepoRoot)) {
      return {
        ok: false,
        error: `Worktree root must live outside the canonical checkout, but ${canonicalRoot} is inside ${canonicalRepoRoot}`,
      };
    }
    return {
      ok: true,
      context: {
        worktreeId: issueWorktreeId(session.sessionId, issueNumber),
        worktreePath: issueWorktreePath(worktreeRoot, session.sessionId, issueNumber),
        branch,
        created: false,
      },
    };
  }

  const resolved = resolveIssueWorktree({
    repoRoot: session.repoRoot,
    sessionId: session.sessionId,
    issueNumber,
    branch,
    baseRef,
    worktreeRoot,
    runner: input.runner ?? defaultCommandRunner,
    ...(input.env !== undefined ? { env: input.env } : {}),
  });
  if (!resolved.ok) return resolved;

  return {
    ok: true,
    context: {
      worktreeId: resolved.worktreeId,
      worktreePath: resolved.path,
      branch: resolved.branch,
      created: resolved.created,
    },
  };
}
