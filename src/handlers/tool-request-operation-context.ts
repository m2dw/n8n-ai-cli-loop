/**
 * The injected runtime halves of the two Tool Request operation cores (issue
 * #1031).
 *
 * Issues #1029 and #1030 split `tool-request.run` and `tool-request.resolve`
 * into `{ request, context } → OperationResult` cores that construct nothing
 * for themselves: stores, the repo lock, command execution, worktree
 * resolution, artifact I/O and the clock all arrive as
 * {@link ToolRequestRunContext} / {@link ToolRequestResolveContext} fields.
 * Until this module existed the only place those fields were assembled was
 * inside `src/cli/admin.ts`, which is an entrypoint: it parses argv at import
 * time and calls `process.exit`, so no other surface can import it.
 *
 * That was fine while the admin CLI was the only caller. It stopped being fine
 * the moment ChatOps registered the same two operations
 * (`src/core/chatops-operations.ts`): the alternative to this module is a second
 * copy of the assembly, and two copies is exactly how the two surfaces would
 * come to disagree about which checkout a granted command runs in or which
 * `git` seam decides that origin lacks a branch — a disagreement whose symptom
 * is a command executed against the wrong tree, not a type error.
 *
 * So the assembly lives here, once, and both surfaces call it. What stays
 * caller-owned is the part that genuinely differs: the trusted
 * {@link OperationContext} (an operator at a shell versus an allowlisted comment
 * author), which store instances to open and close, and how a result is
 * rendered.
 *
 * Nothing here decides anything. Every business rule is in the cores; this is
 * plumbing, and it is deliberately dull.
 */

import { execFileSync } from "child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { dirname } from "path";
import type { OperationContext } from "../core/operation-port.js";
import type { OutboxStore } from "../core/outbox.js";
import type { ResolvedSession } from "../core/session.js";
import type {
  ToolRequestRunContext,
  ToolRequestRunLockPort,
  ToolRequestRunTaskPort,
} from "../core/tool-request-run.js";
import type {
  ToolRequestResolveContext,
  ToolRequestResolveTaskPort,
} from "../core/tool-request-resolve.js";
import { issueWorktreePath, resolveWorktreeRoot } from "../core/worktree-paths.js";
import type { RepoLockStore } from "../stores/repo-lock-store.js";
import { runArtifactDir } from "./artifact-dir.js";
import { bothStreamsCommandRunner, probe, remoteHasBranch } from "./command-runner.js";
import { extractIssueVerificationCommands } from "./issue-verification-extractor.js";
import { canonicalizePath, listWorktrees } from "./worktree.js";

/**
 * Where an issue's repo work actually happens: the per-issue worktree when one
 * is actually registered for this issue, else the canonical checkout.
 *
 * A misconfigured worktree root fails closed rather than silently falling back
 * (issue #454 review) — the caller decides what a closed failure means. Shared
 * by the two Tool Request operation contexts below (issues #1029, #1030), which
 * must agree on this answer: the guided run leaves the command's side effects
 * in exactly the checkout the resolution then validates for cleanliness.
 */
export function resolveIssueRunCwd(
  session: ResolvedSession,
  sessionId: string,
  issueNumber: number,
): { ok: true; cwd: string } | { ok: false; error: string } {
  let worktreeRoot: string;
  try {
    worktreeRoot = resolveWorktreeRoot({ sessionRoot: session.worktrees?.root });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  const worktreePath = canonicalizePath(issueWorktreePath(worktreeRoot, sessionId, issueNumber));
  const listed = listWorktrees(session.repoRoot);
  const entry = listed.ok
    ? listed.worktrees.find((w) => canonicalizePath(w.path) === worktreePath)
    : undefined;
  if (entry && !entry.prunable && existsSync(worktreePath)) {
    return { ok: true, cwd: worktreePath };
  }
  return { ok: true, cwd: session.repoRoot };
}

/** Optional adjustments to how a surface takes the single-worker repo lock. */
export interface ToolRequestRepoLockOptions {
  /**
   * A repo-lock holder whose critical section this caller already runs *inside*.
   *
   * The lock is not reentrant: it is one file per session, and a second
   * `acquire` under a different context id gets `lock_held` no matter who the
   * holder is. That is right for the admin CLI — an operator at a shell is
   * genuinely outside any workflow execution, and a held lock means a worker is
   * live on the checkout. It is wrong for a caller the holder itself invoked.
   *
   * The generated n8n parent workflow is exactly that caller: it runs
   * `admin repo-lock acquire --context-id <ctx>` *before* it calls the child and
   * `repo-lock release` only after the child returns, so every node in the child
   * — including the ChatOps pass — executes with the session lock already held
   * under `<ctx>`. A `/grant` dispatched there would ask for the same lock under
   * `admin-tool-request-grant`, be told `lock_held` by its own parent, and refuse
   * with a `conflict` telling the operator to wait for a worker that is waiting
   * for it. Every authorized `/grant` in the normal scheduled workflow would be
   * refused, which is the one path this operation exists to serve.
   *
   * Naming that holder here makes its lock count as ours: an `acquire` that finds
   * *this exact context id* holding the lock succeeds without writing, and the
   * matching `release` leaves the holder's lock alone for the holder to release.
   * The exclusion the lock buys is unchanged — the parent still holds it against
   * every other execution for the session, and the child's nodes run one after
   * another, so no second worker can be mutating the checkout while the granted
   * command runs. A holder id that is anyone *else* still refuses, exactly as
   * before.
   *
   * Surfaces that are not invoked from inside a critical section (the admin CLI)
   * leave this unset.
   */
  ambientContextId?: string | undefined;
}

/**
 * Adapt the on-disk single-worker repo lock to the narrow port the guided run
 * takes.
 *
 * The store's `release` reports whether it owned the lock; the port returns
 * `void`, because the core has nothing to do with that answer — it releases in a
 * `finally` and a lock somebody else already took is not its problem to report.
 *
 * See {@link ToolRequestRepoLockOptions.ambientContextId} for the one case in
 * which a held lock is not contention.
 */
export function toolRequestRepoLockPort(
  store: RepoLockStore,
  options: ToolRequestRepoLockOptions = {},
): ToolRequestRunLockPort {
  const { ambientContextId } = options;
  // Per-invocation state: one port is built per operation context, and the core
  // acquires at most once and releases in a single `finally`.
  let inherited = false;
  return {
    acquire: (contextId, sessionId, now) => {
      const result = store.acquire(contextId, sessionId, now);
      // Took it outright.
      if (result.locked) return result;
      // Held by somebody who is not the caller we are running inside: contention,
      // reported unchanged.
      if (ambientContextId === undefined || result.ownerContextId !== ambientContextId) {
        return result;
      }
      // Our own caller holds it. Report the section as entered *without* touching
      // the lock file: overwriting it would make the release below (or a crash
      // here) drop a lock the caller still needs, and taking it over would let a
      // third execution in the moment the caller released.
      inherited = true;
      return { locked: true };
    },
    release: (contextId, sessionId) => {
      if (inherited) {
        // Nothing was written, so there is nothing to remove. The store would
        // answer `not_owner` anyway — this just says so out loud.
        inherited = false;
        return;
      }
      store.release(contextId, sessionId);
    },
  };
}

/** The store handles and session one surface holds for a Tool Request invocation. */
export interface ToolRequestOperationRuntime {
  /** The session the surface already resolved; never looked up ambiently. */
  session: ResolvedSession;
  outbox: OutboxStore;
}

/** {@link ToolRequestOperationRuntime} plus what only the guided run needs. */
export interface ToolRequestRunRuntime extends ToolRequestOperationRuntime {
  tasks: ToolRequestRunTaskPort;
  repoLock: RepoLockStore;
  /**
   * The repo-lock holder this surface is already running inside, if any — see
   * {@link ToolRequestRepoLockOptions.ambientContextId}. Unset for a surface an
   * operator invokes directly.
   */
  ambientLockContextId?: string | undefined;
  /**
   * How the operator-response record is tagged. `tool-request run` and the
   * ChatOps `/grant` verb — which maps to the canonical `tool-request.run`, not
   * to the deprecated `grant` alias — record `guided-run`; the deprecated
   * `tool-request grant` CLI alias records `grant` so historical continuation
   * prompts still read correctly.
   */
  responseAction: "guided-run" | "grant";
  /** Prefix for this surface's run ids, so an artifact names who produced it. */
  runIdPrefix: string;
}

/** {@link ToolRequestOperationRuntime} plus what only the resolution needs. */
export interface ToolRequestResolveRuntime extends ToolRequestOperationRuntime {
  tasks: ToolRequestResolveTaskPort;
  /** Prefix for this surface's run ids, so an artifact names who produced it. */
  runIdPrefix: string;
}

/**
 * Build the injected operation context for one guided run (issues #1029, #1031).
 *
 * `invocation` is the trusted half, already decided by the surface — the admin
 * CLI names a shell operator, ChatOps names the allowlisted comment author and
 * the issue the comment lives on. It is passed straight through: this function
 * never widens, narrows, or re-derives a single field of it.
 */
export function toolRequestRunOperationContext(
  invocation: OperationContext,
  runtime: ToolRequestRunRuntime,
): ToolRequestRunContext {
  const { session } = runtime;
  const sessionId = invocation.sessionId;
  // Checked by `runToolRequestRun` too, which refuses `invalid-context` for a
  // session-scoped invocation. Resolving the cwd needs a number, so the
  // fallback keeps this function total; the core still owns the refusal.
  const issueNumber = invocation.issueNumber ?? 0;
  return {
    invocation,
    session,
    tasks: runtime.tasks,
    outbox: runtime.outbox,
    repoLock: toolRequestRepoLockPort(runtime.repoLock, {
      ambientContextId: runtime.ambientLockContextId,
    }),
    exec: {
      probe: (cmd, args, cwd) => probe(cmd, args, cwd),
      remoteHasBranch: (repoRoot, branch) => remoteHasBranch(repoRoot, branch),
      run: (file, args, execOptions) => bothStreamsCommandRunner.run(file, args, execOptions),
      rawPorcelainStatus: (cwd) => {
        try {
          return execFileSync("git", ["status", "--porcelain"], {
            cwd,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
          }) as string;
        } catch {
          return undefined;
        }
      },
    },
    worktree: {
      resolveRunCwd: () => resolveIssueRunCwd(session, sessionId, issueNumber),
    },
    artifacts: {
      dirFor: (runId) => runArtifactDir(session.artifactRoot, runId),
      fileExists: (path) => existsSync(path),
      writeFile: (path, contents) => {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, contents, "utf8");
      },
      removeDir: (path) => rmSync(path, { recursive: true, force: true }),
    },
    now: () => new Date().toISOString(),
    runIdFor: (now) => `${runtime.runIdPrefix}-${now}`,
    responseAction: runtime.responseAction,
    extractIssueVerificationCommands,
  };
}

/**
 * Build the injected operation context for one resolution (issues #1030, #1031).
 *
 * Same contract as {@link toolRequestRunOperationContext}: the trusted half is
 * the surface's, the runtime half is this module's, and no rule lives in either.
 */
export function toolRequestResolveOperationContext(
  invocation: OperationContext,
  runtime: ToolRequestResolveRuntime,
): ToolRequestResolveContext {
  const { session } = runtime;
  const sessionId = invocation.sessionId;
  const issueNumber = invocation.issueNumber ?? 0;
  return {
    invocation,
    session,
    tasks: runtime.tasks,
    outbox: runtime.outbox,
    exec: {
      probe: (cmd, args, cwd) => probe(cmd, args, cwd),
      remoteHasBranch: (repoRoot, branch) => remoteHasBranch(repoRoot, branch),
    },
    worktree: {
      resolveDirtyCheckCwd: () => resolveIssueRunCwd(session, sessionId, issueNumber),
    },
    now: () => new Date().toISOString(),
    runIdFor: (now) => `${runtime.runIdPrefix}-${now}`,
  };
}
