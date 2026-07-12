/**
 * Per-issue worktree execution-context resolver (issue #438).
 *
 * A thin layer between the phase runner and the worktree manager
 * (handlers/worktree.ts). Before a phase runs, the runner asks this resolver
 * whether the session opts into per-issue worktrees and, when it does, resolves
 * or creates the deterministic issue worktree and reports its stable identity
 * (worktreeId + checkout path) so the runner can record it in task context.
 *
 * It deliberately does NOT change any handler cwd: handlers still operate in the
 * shared session checkout (`session.repoRoot`) in this slice. Threading the issue
 * worktree as the execution cwd is the explicit follow-up in
 * docs/per-issue-worktrees.md ("Scope"/deferred list). This module only resolves
 * and records the stable context that later slices will consume.
 *
 * A worktree-disabled session short-circuits BEFORE any git side effect, so its
 * behavior is byte-for-byte unchanged.
 */

import type { ResolvedSession } from "../core/session.js";
import type { TaskContext } from "../core/task.js";
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
   * The phase runner uses this default before repo-working phases because those
   * handlers still execute in the canonical checkout (`session.repoRoot`) in this
   * slice — eagerly creating/checking out `ai/issue-<n>` in a separate worktree
   * would collide with the handler's own `git checkout -b ai/issue-<n>` (branch
   * already exists) and with fix/review checkouts (branch already checked out
   * elsewhere). A future slice that runs handlers *inside* the worktree passes
   * `create: true` to materialize it.
   */
  create?: boolean;
  runner?: CommandRunner;
  env?: NodeJS.ProcessEnv;
}

/**
 * The resolved execution context for one phase run. `enabled: false` is the
 * shared-checkout case (worktrees off) and carries no worktree identity.
 */
export type WorktreeExecutionContext =
  | { enabled: false }
  | {
      enabled: true;
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
    };

export type ResolveWorktreeExecutionContextResult =
  | { ok: true; context: WorktreeExecutionContext }
  | { ok: false; error: string };

/**
 * Resolve the per-issue worktree execution context for a phase run.
 *
 * - Worktrees disabled (or no `worktrees` block) → `{ enabled: false }` with NO
 *   git side effect, preserving today's shared-`repoRoot` behavior.
 * - Worktrees enabled, default (`create: false`) → compute the deterministic
 *   `<root>/<session>/issue-<n>/repo` identity (id + path) with NO git side
 *   effect, so the runner can record stable context while repo-working handlers
 *   still run in the canonical checkout without a branch/worktree collision.
 * - Worktrees enabled, `create: true` → resolve/create that worktree on the
 *   `ai/issue-<n>` branch via the existing worktree manager (for a future slice
 *   that actually runs handlers inside the worktree).
 */
export function resolveWorktreeExecutionContext(
  input: WorktreeExecutionContextInput,
): ResolveWorktreeExecutionContextResult {
  const { session, issueNumber } = input;

  // Opt-in: a session without the block (or with `enabled !== true`) keeps
  // today's shared-`repoRoot` behavior. Short-circuit BEFORE any git side effect
  // so a disabled session is byte-for-byte unchanged.
  if (session.worktrees?.enabled !== true) {
    return { ok: true, context: { enabled: false } };
  }

  // Resolve the managed state root honoring session → env → default order, so the
  // session's `worktrees.root` override is respected (resolveIssueWorktree alone
  // would only consult env/default). An absolute-path violation throws here and is
  // surfaced as a typed error rather than crashing the run.
  let worktreeRoot: string;
  try {
    worktreeRoot = resolveWorktreeRoot({ sessionRoot: session.worktrees.root, env: input.env });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  const branch = input.branch ?? branchName(issueNumber);
  const baseRef = input.baseRef ?? session.baseBranch ?? "main";

  // Default (non-mutating): report only the deterministic identity. No
  // `git worktree add` / branch checkout runs, so this never collides with a
  // repo-working handler that still operates in the canonical checkout.
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
        enabled: true,
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
      enabled: true,
      worktreeId: resolved.worktreeId,
      worktreePath: resolved.path,
      branch: resolved.branch,
      created: resolved.created,
    },
  };
}

// ---------------------------------------------------------------------------
// Mid-flight enablement migration (issue #439)
// ---------------------------------------------------------------------------

/**
 * True when a task's recorded context already carries a per-issue worktree path.
 * A task created (or last run) before `session.worktrees.enabled` was turned on
 * has no recorded `worktreePath`; its next phase under a worktree-enabled session
 * is a mid-flight migration that triggers first-use creation.
 *
 * Only the PATH is consulted (not `worktreeId`): the id is recomputable from
 * session + issue and is recorded alongside the path. A blank string is treated
 * as absent.
 *
 * NOTE: a recorded path is NOT by itself proof that a worktree was materialized —
 * the non-mutating resolver (`create: false`) persists the deterministic path for
 * future use without ever running `git worktree add`. So callers deciding whether
 * a mid-flight migration just happened must combine this with the materialization
 * signal (`created`); see {@link resolveWorktreeMigration}.
 */
function hasRecordedWorktree(context: TaskContext | undefined | null): boolean {
  if (!context) return false;
  const path = context.worktreePath;
  return typeof path === "string" && path.trim() !== "";
}

export interface WorktreeMigrationInput {
  session: ResolvedSession;
  issueNumber: number;
  /**
   * The existing task's recorded context. Consulted ONLY to report whether this
   * is a mid-flight migration of a pre-existing active task (no recorded
   * `worktreePath`) versus a task that already runs on a worktree. The resolved
   * id/path are always RECOMPUTED from session + issue (never read back from this
   * context), which is exactly why mid-flight enablement needs no DB migration: a
   * task that predates the opt-in carries no worktree fields and still resolves
   * the deterministic worktree on its next phase.
   */
  recordedContext?: TaskContext | null;
  /** See {@link WorktreeExecutionContextInput.branch}. */
  branch?: string;
  /** See {@link WorktreeExecutionContextInput.baseRef}. */
  baseRef?: string;
  runner?: CommandRunner;
  env?: NodeJS.ProcessEnv;
}

export type WorktreeMigrationResult =
  | { ok: true; context: { enabled: false } }
  | {
      ok: true;
      context: {
        enabled: true;
        worktreeId: string;
        worktreePath: string;
        branch: string;
        /** True when this call materialized the worktree (vs reused an existing one). */
        created: boolean;
        /**
         * True when this call materialized a worktree for a task that was not
         * already running on one — a pre-existing active task migrating onto a
         * worktree because the session opted in mid-flight. False only on the
         * steady-state reuse path, where an existing worktree was reused for a task
         * that already recorded its materialized path.
         *
         * Derived from the materialization signal (`created`) first, not the
         * recorded path alone: the non-mutating resolver persists a `worktreePath`
         * for future use WITHOUT materializing it, so a recorded path cannot prove
         * migration already happened. A freshly created worktree (`created: true`)
         * is therefore always a migration regardless of any recorded path.
         */
        migrated: boolean;
      };
    }
  | { ok: false; error: string };

/**
 * Resolve (creating on first use) the per-issue worktree for an EXISTING active
 * task after `session.worktrees.enabled` is turned on mid-flight (issue #439).
 *
 * This is the explicit, tested migration path the per-issue design promised: an
 * active task that predates the opt-in keeps no worktree fields, and its next
 * phase under a worktree-enabled session materializes the deterministic worktree
 * with NO DB migration — `worktreeId`/`worktreePath` are recomputed from session
 * + issue, so absence of a recorded path simply means "first use".
 *
 * Continuation points and fail-closed cases are owned by the worktree manager
 * (`resolveIssueWorktree`, reached via `create: true`) and reused here verbatim:
 *  - an existing local `ai/issue-<n>` branch is checked out as the continuation
 *    point (its commits are preserved, never reset);
 *  - if the local branch is absent but `origin/ai/issue-<n>` exists, the worktree
 *    tracks that remote head so an existing PR's branch is preserved;
 *  - if neither exists, the branch is created from `baseRef`;
 *  - if `ai/issue-<n>` is currently checked out in the canonical checkout, that
 *    checkout is detached and the worktree is added with `--force`, BUT only after
 *    a uncommitted-changes guard — a dirty canonical checkout fails closed with an
 *    actionable commit/stash message rather than stranding pending work;
 *  - if the branch is held by another (non-canonical) worktree, it fails closed
 *    pointing at the holder.
 *
 * A worktree-disabled session short-circuits to `{ enabled: false }` with no git
 * side effect, so this is a no-op for sessions that never opted in.
 *
 * NOTE: this performs git side effects (`create: true`) and is therefore NOT the
 * per-phase resolver wired into the runner today — that one stays non-mutating
 * (`create: false`) because handlers still execute in the canonical checkout in
 * this slice (see {@link resolveWorktreeExecutionContext}). Threading the worktree
 * as the handler cwd and invoking this migration from the runner is the deferred
 * follow-up; landing the migration here makes it explicit and testable first.
 */
export function resolveWorktreeMigration(input: WorktreeMigrationInput): WorktreeMigrationResult {
  // A session that never opted in keeps today's shared-checkout behavior with no
  // git side effect. Short-circuit before any worktree resolution.
  if (input.session.worktrees?.enabled !== true) {
    return { ok: true, context: { enabled: false } };
  }

  const resolved = resolveWorktreeExecutionContext({
    session: input.session,
    issueNumber: input.issueNumber,
    create: true,
    ...(input.branch !== undefined ? { branch: input.branch } : {}),
    ...(input.baseRef !== undefined ? { baseRef: input.baseRef } : {}),
    ...(input.runner !== undefined ? { runner: input.runner } : {}),
    ...(input.env !== undefined ? { env: input.env } : {}),
  });
  if (!resolved.ok) return resolved;
  // `enabled: false` cannot occur here (the session is enabled and we passed
  // `create: true`), but narrow defensively so the typed result stays honest.
  if (!resolved.context.enabled) return { ok: true, context: { enabled: false } };

  return {
    ok: true,
    context: {
      enabled: true,
      worktreeId: resolved.context.worktreeId,
      worktreePath: resolved.context.worktreePath,
      branch: resolved.context.branch,
      created: resolved.context.created,
      // A freshly created worktree proves no materialized checkout existed before
      // this call, so it is always a first-use migration even if the non-mutating
      // resolver recorded a `worktreePath` for future use. Only when an existing
      // worktree was reused (`created: false`) does the recorded path distinguish
      // steady-state reuse from a task adopting a pre-existing worktree.
      migrated: resolved.context.created || !hasRecordedWorktree(input.recordedContext),
    },
  };
}
