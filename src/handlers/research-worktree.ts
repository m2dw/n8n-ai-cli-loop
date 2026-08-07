/**
 * Detached, per-run research worktree lifecycle (issue #855).
 *
 * Research used to invoke its agent directly in `session.repoRoot`. The
 * canonical checkout is a SHARED operator resource: it may be behind the remote,
 * dirty, on a locally managed branch, or in use by unrelated work — so a research
 * run could read stale repository contents, conclude that a dependency's data was
 * still missing, exit 0, and be recorded as a valid completion (the incident in
 * the issue). Freshness is not something the agent can be asked to check; it has
 * to be a property of the workspace it is handed.
 *
 * So repository-backed research runs in its own worktree, materialized here:
 *
 *   1. fetch the configured base branch into `refs/remotes/origin/<base>`,
 *   2. resolve that ref to an immutable commit SHA,
 *   3. `git worktree add --detach <issue-run-path> <sha>`.
 *
 * Read-only research needs no branch, so none is created: an `ai/issue-<n>`
 * branch is implementation's to create when implementation is actually
 * requested. Detaching at a resolved SHA also makes the run's input auditable —
 * the exact commit is recorded in the research context/result artifacts.
 *
 * Every step is fail-closed. There is no fallback to the local checkout: a
 * failed fetch or SHA resolution ends the run before the agent is invoked,
 * because "ran against whatever `main` happened to be" is precisely the outcome
 * this module exists to make impossible.
 *
 * Only the canonical repository's shared git metadata is touched (a remote
 * tracking ref, the worktree registry) — never its working tree, index, or
 * checked-out branch. Path math lives in core/worktree-paths.ts and the git
 * primitives in handlers/worktree.ts; this module owns only the sequencing.
 */

import { existsSync, mkdirSync } from "fs";
import { dirname, isAbsolute } from "path";
import type { CommandRunner } from "./command-runner.js";
import { defaultCommandRunner } from "./command-runner.js";
import {
  canonicalizePath,
  findWorktreeByPath,
  isPathInside,
  removeWorktree,
} from "./worktree.js";
import {
  researchWorktreeId,
  researchWorktreePath,
  resolveWorktreeRoot,
} from "../core/worktree-paths.js";

/**
 * Which step failed, as a closed vocabulary. Recorded in the local failure
 * artifact and carried in the handler's public message — every value is a fixed
 * literal, so it is publishable while the underlying git text (which can carry
 * absolute paths or remote URLs) stays local.
 */
export type ResearchWorkspaceStage =
  /** The managed worktree root could not be resolved or is unusable. */
  | "worktree-root"
  /** `git fetch` of the configured base branch failed. */
  | "fetch-base"
  /** The fetched `origin/<base>` did not resolve to a commit SHA. */
  | "resolve-base"
  /** `git worktree add --detach` failed (or the target path could not be cleared). */
  | "worktree-create";

/** A materialized research checkout, detached at an immutable base commit. */
export interface ResearchWorkspace {
  /** Absolute checkout path (local-only; never published). */
  path: string;
  /** Stable identity label recorded in artifacts in place of the path. */
  worktreeId: string;
  /** Base branch name as configured on the session, e.g. `main`. */
  baseBranch: string;
  /** The fully qualified remote-tracking ref that was fetched and resolved. */
  baseRef: string;
  /** The immutable commit the worktree is detached at. */
  baseSha: string;
}

export interface PrepareResearchWorkspaceInput {
  /** The canonical checkout, used ONLY as the git command cwd (never mutated). */
  repoRoot: string;
  sessionId: string;
  issueNumber: number;
  /** Makes the checkout path unique per run so retries never collide. */
  runId: string;
  baseBranch: string;
  /** Override the managed state root (defaults to session/env/global order). */
  worktreeRoot?: string;
  runner?: CommandRunner;
  env?: NodeJS.ProcessEnv;
}

export type PrepareResearchWorkspaceResult =
  | { ok: true; workspace: ResearchWorkspace }
  | { ok: false; stage: ResearchWorkspaceStage; error: string };

export interface ReleaseResearchWorkspaceInput {
  repoRoot: string;
  workspace: ResearchWorkspace;
  /**
   * Paths that MUST survive the removal — the run's artifact directory and
   * artifact root. A session may configure `artifactRoot` inside the managed
   * worktree tree (issue #629), and removing the checkout would then delete the
   * very diagnostics the run exists to leave behind, so the worktree is retained
   * instead of removed in that case.
   */
  preservePaths?: string[];
  runner?: CommandRunner;
}

export type ReleaseResearchWorkspaceResult =
  | { ok: true; removed: true }
  | { ok: true; removed: false; retained: "artifacts-inside" }
  | { ok: false; error: string };

/** Injectable lifecycle so handler tests can run without a real repository. */
export interface ResearchWorktreeRuntime {
  prepare(input: PrepareResearchWorkspaceInput): PrepareResearchWorkspaceResult;
  release(input: ReleaseResearchWorkspaceInput): ReleaseResearchWorkspaceResult;
}

/** A resolved commit id: 40 hex chars (sha1) or 64 (sha256 repositories). */
const COMMIT_SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/**
 * Total attempts at the base fetch, and the first backoff between them (it
 * doubles: 100ms, 200ms, 400ms — under a second in the worst case).
 *
 * Bounded on purpose. The race being retried is resolved by whichever fetch
 * wins, so a contended attempt is expected to succeed on the next try; a failure
 * that survives every attempt is not contention that needs more patience, it is
 * a broken remote, and this phase must fail closed rather than wait.
 */
const FETCH_ATTEMPTS = 4;
const FETCH_RETRY_BASE_DELAY_MS = 100;

/**
 * Git's vocabulary for "someone else moved this ref while I was updating it".
 *
 * Covers both shapes: the compare-and-swap rejection
 * (`cannot lock ref 'refs/remotes/origin/main': is at <a> but expected <b>`,
 * reported per-ref alongside `unable to update local ref`) and the `.lock` file
 * collision when two fetches reach the ref at the same instant.
 */
const REF_LOCK_RACE =
  /(cannot lock ref|unable to update local ref|unable to create (?:lock file|'[^']*\.lock')|\.lock'?: file exists)/i;

function isRefLockRace(result: { stdout: string; stderr: string }): boolean {
  return REF_LOCK_RACE.test(`${result.stderr}\n${result.stdout}`);
}

/**
 * Block the current thread briefly. Preparation is synchronous by design — the
 * whole module runs on `CommandRunner.run`, which is `execFileSync`-shaped — so
 * the backoff is too. Same helper as the Antigravity settings lock wait.
 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Materialize the detached research checkout for one run.
 *
 * Returns a typed failure — never a partially-usable workspace — so the caller
 * can refuse to invoke the agent. The fetch and the SHA resolution run in the
 * canonical repository because that is where the object store and the remote
 * configuration live; both are metadata-only operations (`git fetch` writing a
 * remote-tracking ref, `git rev-parse` reading one) and neither touches the
 * canonical working tree, index, or HEAD.
 */
export function prepareResearchWorkspace(
  input: PrepareResearchWorkspaceInput,
): PrepareResearchWorkspaceResult {
  const runner = input.runner ?? defaultCommandRunner;

  let root: string;
  try {
    root = input.worktreeRoot ?? resolveWorktreeRoot({ env: input.env });
  } catch (err) {
    return { ok: false, stage: "worktree-root", error: err instanceof Error ? err.message : String(err) };
  }
  // Same fail-closed guards as `resolveIssueWorktree`: a relative root, or an
  // absolute one nested inside the canonical checkout, would plant the research
  // checkout under committed source and dirty the shared repository — the exact
  // coupling this phase is being moved out of.
  //
  // The relative check must come first and must not be folded into the
  // canonicalization below: canonicalizing a relative root silently resolves it
  // against the process cwd, which would turn a caller-supplied `worktreeRoot`
  // into some unrelated absolute location (possibly outside `repoRoot`, so the
  // containment check would pass) instead of failing closed.
  if (!isAbsolute(root)) {
    return {
      ok: false,
      stage: "worktree-root",
      error: `Worktree root must be an absolute path so worktrees never resolve inside the canonical checkout, got: ${root}`,
    };
  }
  const canonicalRoot = canonicalizePath(root);
  const canonicalRepoRoot = canonicalizePath(input.repoRoot);
  if (isPathInside(canonicalRoot, canonicalRepoRoot)) {
    return {
      ok: false,
      stage: "worktree-root",
      error: `Worktree root must live outside the canonical checkout, but ${canonicalRoot} is inside ${canonicalRepoRoot}`,
    };
  }

  const path = canonicalizePath(
    researchWorktreePath(root, input.sessionId, input.issueNumber, input.runId),
  );
  const worktreeId = researchWorktreeId(input.sessionId, input.issueNumber, input.runId);
  const baseRef = `refs/remotes/origin/${input.baseBranch}`;

  // Refresh the remote base. The explicit `+<base>:refs/remotes/origin/<base>`
  // refspec (mirroring the review handler) is required, not cosmetic: a bare
  // `git fetch origin <base>` only writes `FETCH_HEAD` when the clone's
  // `remote.origin.fetch` does not track `<base>` (e.g. a single-branch clone),
  // which would report success while leaving `origin/<base>` stale — the stale
  // read this whole change exists to prevent.
  //
  // Retried on a ref-update race. `refs/remotes/origin/<base>` is SHARED across
  // issues, while the lock this phase takes is issue-scoped — so two research
  // runs for different issues are entitled to overlap, and if `origin/<base>`
  // advances between them git rejects one updater outright ("cannot lock ref …:
  // is at X but expected Y"). That is not a fetch failure: the winner has
  // already written the very ref this run wants, so simply repeating the fetch
  // succeeds. Treating it as a hard failure would refuse legitimate concurrent
  // research before the agent ever ran. Retrying rather than serializing is
  // deliberate — a repository-wide fetch lock would be a new lock class (which
  // this phase's design rules out) and would hold a shared lock across a network
  // round trip for every issue in the session.
  const fetchArgs = ["fetch", "origin", `+${input.baseBranch}:${baseRef}`];
  let fetched = runner.run("git", fetchArgs, { cwd: input.repoRoot });
  let attempts = 1;
  while (fetched.exitCode !== 0 && attempts < FETCH_ATTEMPTS && isRefLockRace(fetched)) {
    sleepSync(FETCH_RETRY_BASE_DELAY_MS * 2 ** (attempts - 1));
    fetched = runner.run("git", fetchArgs, { cwd: input.repoRoot });
    attempts += 1;
  }
  if (fetched.exitCode !== 0) {
    const tried = attempts > 1 ? `, ${attempts} attempts` : "";
    return {
      ok: false,
      stage: "fetch-base",
      error: `git fetch origin ${input.baseBranch} failed (exit ${fetched.exitCode}${tried}): ${(fetched.stderr || fetched.stdout).slice(0, 300)}`,
    };
  }

  // Pin the fetched tip to an immutable commit. `^{commit}` peels an annotated
  // tag or any other non-commit object, so a non-commit ref fails here rather
  // than becoming an unusable checkout target. A concurrent run advancing
  // `origin/<base>` again between the fetch and this read is harmless: the SHA
  // read here is still a freshly fetched remote commit — never the stale local
  // branch — and it is the one recorded in the artifacts and checked out below.
  const resolved = runner.run(
    "git",
    ["rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`],
    { cwd: input.repoRoot },
  );
  const baseSha = resolved.stdout.trim();
  if (resolved.exitCode !== 0 || !COMMIT_SHA.test(baseSha)) {
    return {
      ok: false,
      stage: "resolve-base",
      error: `git rev-parse ${baseRef} did not resolve to a commit (exit ${resolved.exitCode}): ${(resolved.stderr || resolved.stdout).slice(0, 300)}`,
    };
  }

  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch (err) {
    return {
      ok: false,
      stage: "worktree-create",
      error: `Failed to create research worktree parent directory: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Clear anything a crashed earlier run with this same run id left behind:
  // `git worktree add` refuses an existing non-empty target, and a registration
  // whose directory is gone keeps the path reserved. Prune first (the same
  // recovery `resolveIssueWorktree` performs), then remove a live registration,
  // then fail closed if a foreign directory still occupies the path — never
  // delete a directory git does not know about.
  const pruned = runner.run("git", ["worktree", "prune"], { cwd: input.repoRoot });
  if (pruned.exitCode !== 0) {
    return {
      ok: false,
      stage: "worktree-create",
      error: `git worktree prune failed (exit ${pruned.exitCode}): ${(pruned.stderr || pruned.stdout).slice(0, 300)}`,
    };
  }
  const existing = findWorktreeByPath(input.repoRoot, path, runner);
  if (!existing.ok) return { ok: false, stage: "worktree-create", error: existing.error };
  if (existing.worktree) {
    const removed = removeWorktree(input.repoRoot, path, { force: true, runner });
    if (!removed.ok) return { ok: false, stage: "worktree-create", error: removed.error };
  } else if (existsSync(path)) {
    return {
      ok: false,
      stage: "worktree-create",
      error: `Research worktree path ${path} already exists but is not a registered worktree; refusing to overwrite it`,
    };
  }

  // `--detach` is the point: research reads a commit, it does not own a branch.
  // Creating `ai/issue-<n>` here would claim the implementation phase's branch
  // for a read-only run and leave a branch behind for an issue nobody has
  // decided to implement yet.
  const addArgs = ["worktree", "add", "--detach", path, baseSha];
  const added = runner.run("git", addArgs, { cwd: input.repoRoot });
  if (added.exitCode !== 0) {
    return {
      ok: false,
      stage: "worktree-create",
      error: `git ${addArgs.join(" ")} failed (exit ${added.exitCode}): ${(added.stderr || added.stdout).slice(0, 300)}`,
    };
  }

  return {
    ok: true,
    workspace: { path, worktreeId, baseBranch: input.baseBranch, baseRef, baseSha },
  };
}

/**
 * Remove the research checkout once the run is over.
 *
 * `force` because the checkout is disposable by construction: research is
 * read-only, so anything left in the tree is agent scratch, and the base commit
 * it was detached at lives on in the object store. Run artifacts are written
 * OUTSIDE the worktree, so removal never touches them — except when an operator
 * configured the artifact root inside the managed tree, which is why the
 * `preservePaths` check retains the worktree instead.
 */
export function releaseResearchWorkspace(
  input: ReleaseResearchWorkspaceInput,
): ReleaseResearchWorkspaceResult {
  const worktreePath = canonicalizePath(input.workspace.path);
  for (const preserve of (input.preservePaths ?? []).filter((p) => typeof p === "string" && p.length > 0)) {
    if (isPathInside(canonicalizePath(preserve), worktreePath)) {
      return { ok: true, removed: false, retained: "artifacts-inside" };
    }
  }
  const removed = removeWorktree(input.repoRoot, input.workspace.path, {
    force: true,
    ...(input.runner ? { runner: input.runner } : {}),
  });
  if (!removed.ok) return { ok: false, error: removed.error };
  return { ok: true, removed: true };
}

export const defaultResearchWorktreeRuntime: ResearchWorktreeRuntime = {
  prepare: prepareResearchWorkspace,
  release: releaseResearchWorkspace,
};

/**
 * Public-safe statement of a workspace-preparation failure.
 *
 * Fixed literals only — the stage, the base branch name, and the issue-level
 * fact that the agent was never invoked. The git text behind the failure can
 * carry absolute paths and remote URLs, so it stays in the local artifact; this
 * string is what the research-failure GitHub comment and Slack notification
 * republish verbatim.
 */
export function publicResearchWorkspaceMessage(
  stage: ResearchWorkspaceStage,
  baseBranch: string,
): string {
  const detail =
    stage === "fetch-base"
      ? `the base branch '${baseBranch}' could not be fetched from origin`
      : stage === "resolve-base"
        ? `the fetched base branch '${baseBranch}' could not be resolved to a commit`
        : stage === "worktree-create"
          ? "the isolated research worktree could not be created"
          : "the managed worktree root is not usable";
  return (
    `Research could not start: ${detail}, so no research workspace was prepared and the agent was `
    + `not invoked (stage: ${stage}). Research never falls back to the shared local checkout, whose `
    + `contents may be stale. Bounded diagnostics were recorded in the local run artifacts.`
  );
}
