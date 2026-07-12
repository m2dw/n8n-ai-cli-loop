/**
 * Per-issue git worktree manager + issue-scoped lock (issue #400).
 *
 * The session `repoRoot` stays the canonical source repository; this module
 * creates, resolves, lists, and prunes the durable per-issue worktrees that
 * isolate one issue's dirty tree / Tool Request / recovery from every other
 * issue in the session (see docs/per-issue-worktrees.md). All git side effects go
 * through an injected {@link CommandRunner} so the logic is unit-testable without
 * a real repository, mirroring the existing handler/runner pattern.
 *
 * Path math + redaction live in core/worktree-paths.ts; this module owns the
 * git-facing operations and the issue-level advisory lock.
 */

import { existsSync, mkdirSync, realpathSync } from "fs";
import { basename, dirname, isAbsolute, join, relative } from "path";
import { homedir } from "os";
import type { CommandRunner } from "./command-runner.js";
import { defaultCommandRunner } from "./command-runner.js";
import { RepoLockStore } from "../stores/repo-lock-store.js";
import type {
  AcquireResult,
  ReleaseResult,
  InspectResult,
  ForceReleaseResult,
} from "../stores/repo-lock-store.js";
import {
  issueWorktreeId,
  issueWorktreePath,
  resolveWorktreeRoot,
} from "../core/worktree-paths.js";

// ---------------------------------------------------------------------------
// Path canonicalization
//
// `git worktree` records and reports the canonical (symlink-resolved) absolute
// path of each worktree (e.g. macOS resolves `/var/...` to `/private/var/...`,
// and an operator may configure a worktree root through a symlinked directory).
// Comparing a freshly computed path against git's output therefore requires
// resolving symlinks on both sides. The leaf may not exist yet (the existence
// check runs before creation), so resolve the nearest existing ancestor and
// rejoin the remaining segments.
// ---------------------------------------------------------------------------

export function canonicalizePath(p: string): string {
  const segments: string[] = [];
  let current = p;
  for (;;) {
    try {
      const real = realpathSync(current);
      return segments.length > 0 ? join(real, ...segments) : real;
    } catch {
      const parent = dirname(current);
      if (parent === current) return p; // reached the filesystem root unresolved
      segments.unshift(basename(current));
      current = parent;
    }
  }
}

/**
 * True when `child` is `parent` itself or nested under it. Callers canonicalize
 * both sides first so symlinks/`..` segments cannot smuggle a path past the
 * check. `path.relative` returns "" for the same path and a `..`-prefixed (or,
 * on Windows, absolute) result when `child` escapes `parent`.
 */
export function isPathInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

// ---------------------------------------------------------------------------
// `git worktree list --porcelain` parsing
// ---------------------------------------------------------------------------

export interface WorktreeEntry {
  /** Absolute path of the worktree checkout. */
  path: string;
  /** Checked-out commit SHA, when reported. */
  head?: string;
  /** Branch ref (e.g. `refs/heads/ai/issue-365`), when not detached. */
  branch?: string;
  detached: boolean;
  bare: boolean;
  locked: boolean;
  prunable: boolean;
}

/**
 * Parse the output of `git worktree list --porcelain` into structured entries.
 * Each record is separated by a blank line; the first line of a record is always
 * `worktree <path>`.
 */
export function parseWorktreeList(porcelain: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let current: WorktreeEntry | undefined;
  const flush = () => {
    if (current) entries.push(current);
    current = undefined;
  };
  for (const rawLine of porcelain.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line.startsWith("worktree ")) {
      flush();
      current = {
        path: line.slice("worktree ".length),
        detached: false,
        bare: false,
        locked: false,
        prunable: false,
      };
      continue;
    }
    if (!current) continue;
    if (line.startsWith("HEAD ")) current.head = line.slice("HEAD ".length);
    else if (line.startsWith("branch ")) current.branch = line.slice("branch ".length);
    else if (line === "detached") current.detached = true;
    else if (line === "bare") current.bare = true;
    else if (line.startsWith("locked")) current.locked = true;
    else if (line.startsWith("prunable")) current.prunable = true;
  }
  flush();
  return entries;
}

/** List all worktrees registered against the canonical repo at `repoRoot`. */
export function listWorktrees(
  repoRoot: string,
  runner: CommandRunner = defaultCommandRunner,
): { ok: true; worktrees: WorktreeEntry[] } | { ok: false; error: string } {
  const r = runner.run("git", ["worktree", "list", "--porcelain"], { cwd: repoRoot });
  if (r.exitCode !== 0) {
    return { ok: false, error: `git worktree list failed (exit ${r.exitCode}): ${(r.stderr || r.stdout).slice(0, 300)}` };
  }
  return { ok: true, worktrees: parseWorktreeList(r.stdout) };
}

/** Find the registered worktree whose checkout path equals `path`, if any. */
export function findWorktreeByPath(
  repoRoot: string,
  path: string,
  runner: CommandRunner = defaultCommandRunner,
): { ok: true; worktree: WorktreeEntry | undefined } | { ok: false; error: string } {
  const listed = listWorktrees(repoRoot, runner);
  if (!listed.ok) return listed;
  const target = canonicalizePath(path);
  return { ok: true, worktree: listed.worktrees.find((w) => canonicalizePath(w.path) === target) };
}

// ---------------------------------------------------------------------------
// Resolve / create a per-issue worktree
// ---------------------------------------------------------------------------

export interface ResolveIssueWorktreeInput {
  repoRoot: string;
  sessionId: string;
  issueNumber: number;
  /** Branch the worktree is checked out on, e.g. `ai/issue-<n>`. */
  branch: string;
  /**
   * Start point used ONLY when the worktree is created fresh and the branch does
   * not already exist (e.g. `origin/main` or a fetched blocker head). Ignored
   * when reusing an existing worktree or checking out an existing branch.
   */
  baseRef: string;
  /**
   * When true, a local issue branch that is merely BEHIND origin/<branch> — i.e.
   * fast-forwardable onto the remote head — is accepted by the remote-head
   * containment guard instead of rejected. The caller takes responsibility for
   * reconciling it afterward (the fix-followup path runs `git pull --ff-only` in
   * the worktree). A genuinely DIVERGED (force-pushed, non-fast-forwardable) head
   * is still rejected. Defaults to the strict guard so the new-implementation path
   * keeps failing closed on any non-contained local ref (issue #454 review).
   */
  allowFastForward?: boolean;
  /** Override the managed state root (defaults to the session/env/global root). */
  worktreeRoot?: string;
  runner?: CommandRunner;
  env?: NodeJS.ProcessEnv;
}

export interface ResolvedIssueWorktree {
  ok: true;
  /** Absolute checkout path. */
  path: string;
  /** Stable, location-independent id recorded in task context. */
  worktreeId: string;
  branch: string;
  /** True when this call created the worktree; false when an existing one was reused. */
  created: boolean;
  /**
   * True when an existing local issue branch (`refs/heads/<branch>`) was REUSED as the
   * worktree's checkout, false when the branch was created fresh (from `baseRef` or a
   * recovered `origin/<branch>` remote head). Tracked independently of `created`: the
   * two diverge when an existing branch is checked out into a freshly created worktree
   * path — e.g. a delayed-run retry after the prior worktree dir was pruned, where the
   * branch survives but the path is recreated (`created: true`, `branchReused: true`).
   * Callers use this (not `created`) to decide whether a reused branch needs refreshing
   * onto an updated start point (issue #455).
   */
  branchReused: boolean;
}

export type ResolveIssueWorktreeResult = ResolvedIssueWorktree | { ok: false; error: string };

/**
 * True when the local `ai/issue-N` branch already contains origin's head for that
 * branch — i.e. local is equal to, or ahead of, origin and carries every pushed
 * commit. Returns true when no remote issue branch exists (there is nothing to
 * diverge from). A false result means origin advanced or was force-pushed past the
 * local ref (follow-up commits landed on the PR head from elsewhere), so building
 * on or reusing the local ref would put later phase work on the wrong PR head and
 * risk overwriting the remote work on push.
 *
 * `merge-base --is-ancestor <remote> <local>` exits 0 exactly when the remote head
 * is reachable from the local branch; any non-zero exit means divergence.
 */
function localBranchContainsRemoteHead(
  runner: CommandRunner,
  repoRoot: string,
  branch: string,
): boolean {
  const remoteRef = `refs/remotes/origin/${branch}`;
  const remoteExists =
    runner.run("git", ["rev-parse", "--verify", "--quiet", remoteRef], { cwd: repoRoot }).exitCode === 0;
  if (!remoteExists) return true;
  return (
    runner.run("git", ["merge-base", "--is-ancestor", remoteRef, `refs/heads/${branch}`], { cwd: repoRoot })
      .exitCode === 0
  );
}

/**
 * True when the local `ai/issue-N` branch can be FAST-FORWARDED onto origin's head
 * for that branch — i.e. the local ref is an ancestor of `origin/<branch>`, so origin
 * is strictly ahead with no diverging commits. This distinguishes a benign
 * behind-origin PR head (a human/admin/other clone pushed a follow-up the local ref
 * has not picked up yet), which a later `git pull --ff-only` cleanly reconciles, from
 * a genuinely diverged (force-pushed) head, which cannot fast-forward. Returns false
 * when no remote issue branch exists (there is nothing to fast-forward onto).
 *
 * `merge-base --is-ancestor <local> <remote>` exits 0 exactly when the local head is
 * reachable from origin's head — the fast-forwardable case.
 */
function localBranchFastForwardsToRemoteHead(
  runner: CommandRunner,
  repoRoot: string,
  branch: string,
): boolean {
  const remoteRef = `refs/remotes/origin/${branch}`;
  const remoteExists =
    runner.run("git", ["rev-parse", "--verify", "--quiet", remoteRef], { cwd: repoRoot }).exitCode === 0;
  if (!remoteExists) return false;
  return (
    runner.run("git", ["merge-base", "--is-ancestor", `refs/heads/${branch}`, remoteRef], { cwd: repoRoot })
      .exitCode === 0
  );
}

/**
 * Resolve the per-issue worktree, creating it on first use and reusing it on
 * every later phase. Reuse is keyed on the deterministic checkout path, so a
 * resumed phase lands in the same dirty/clean tree the prior phase left behind —
 * which is the whole point of the per-issue model.
 *
 * Creation never mutates the canonical checkout: `git worktree add` registers a
 * new working tree and checks out the issue branch there. When the branch already
 * exists locally it is checked out as-is; when only the remote issue branch
 * exists the local branch is created from that remote head (preserving the PR
 * head); otherwise it is created from `baseRef`.
 */
export function resolveIssueWorktree(input: ResolveIssueWorktreeInput): ResolveIssueWorktreeResult {
  const runner = input.runner ?? defaultCommandRunner;
  // Resolve the managed state root. A relative root (direct `worktreeRoot` or a
  // misconfigured override surfaced by `resolveWorktreeRoot`) would make the issue
  // path relative and let `git worktree add` plant it inside the canonical
  // checkout, so fail closed with a typed error rather than returning a bad path.
  let root: string;
  try {
    root = input.worktreeRoot ?? resolveWorktreeRoot({ env: input.env });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (!isAbsolute(root)) {
    return {
      ok: false,
      error: `Worktree root must be an absolute path so worktrees never resolve inside the canonical checkout, got: ${root}`,
    };
  }
  // An absolute root can still sit *inside* the canonical checkout (e.g.
  // `<repoRoot>/worktrees`). `git worktree add` would then plant the issue
  // checkout under committed source, leaving an untracked tree that can
  // dirty/block the canonical repo — the exact coupling the per-issue model
  // exists to remove. Compare canonicalized paths (symlinks resolved on both
  // sides) and fail closed before creating anything.
  const canonicalRoot = canonicalizePath(root);
  const canonicalRepoRoot = canonicalizePath(input.repoRoot);
  if (isPathInside(canonicalRoot, canonicalRepoRoot)) {
    return {
      ok: false,
      error: `Worktree root must live outside the canonical checkout, but ${canonicalRoot} is inside ${canonicalRepoRoot}`,
    };
  }
  // Canonicalize so the recorded/returned path matches what `git worktree`
  // records (and what a later `findWorktreeByPath` will compare against).
  const path = canonicalizePath(issueWorktreePath(root, input.sessionId, input.issueNumber));
  const worktreeId = issueWorktreeId(input.sessionId, input.issueNumber);

  // Remote-head containment guard, shared by the reuse and creation paths below.
  // Normally the local issue branch must already CONTAIN origin's head for that
  // branch (local equal-to/ahead-of origin) or building on it would put later work
  // on the wrong PR head. When the caller opts into `allowFastForward` (the
  // fix-followup path, which reconciles with a later `git pull --ff-only`), a branch
  // that is merely BEHIND origin — fast-forwardable onto it — is also accepted; only
  // a genuinely diverged (force-pushed, non-fast-forwardable) head is rejected. This
  // lets a behind-origin PR head that an earlier `git fetch`/status recovery already
  // advanced the remote-tracking ref past reach its `--ff-only` reconciliation
  // instead of hard-failing here (issue #454 review).
  const remoteHeadGuardRejects = (): boolean => {
    if (localBranchContainsRemoteHead(runner, input.repoRoot, input.branch)) return false;
    if (input.allowFastForward && localBranchFastForwardsToRemoteHead(runner, input.repoRoot, input.branch)) {
      return false;
    }
    return true;
  };

  const existing = findWorktreeByPath(input.repoRoot, path, runner);
  if (!existing.ok) return existing;
  if (existing.worktree) {
    // A registered worktree whose checkout directory was deleted out of band is
    // still reported by `git worktree list`, but flagged `prunable` and bound to
    // the original branch. Reusing that registration would hand the next phase a
    // checkout path that no longer exists (a false `created: false` success), so
    // drop the stale entry with `git worktree prune` and fall through to the
    // creation path below — the issue branch still carries its commits, so the
    // recreated worktree resumes the same work rather than losing it.
    if (existing.worktree.prunable || !existsSync(path)) {
      const pruned = runner.run("git", ["worktree", "prune"], { cwd: input.repoRoot });
      if (pruned.exitCode !== 0) {
        return {
          ok: false,
          error: `Worktree registration at ${path} is stale (its checkout is gone) and \`git worktree prune\` failed (exit ${pruned.exitCode}): ${(pruned.stderr || pruned.stdout).slice(0, 300)}`,
        };
      }
    } else {
      // Reuse is keyed on the deterministic path, but the worktree there must still
      // be on the intended branch. If it was left detached or checked out elsewhere
      // (e.g. a manual `git checkout` during recovery), reporting success would let
      // the next phase commit / resolve a Tool Request against the wrong branch, so
      // fail closed instead of trusting the path alone.
      const expectedRef = `refs/heads/${input.branch}`;
      if (existing.worktree.branch !== expectedRef) {
        const actual = existing.worktree.detached
          ? "a detached HEAD"
          : existing.worktree.branch
            ? `branch ${existing.worktree.branch}`
            : "an unknown ref";
        return {
          ok: false,
          error: `Worktree at ${path} is on ${actual}, expected ${expectedRef}; refusing to reuse it for ${input.branch}`,
        };
      }
      // The path-keyed worktree exists and is on the expected branch, but origin
      // may have advanced or been force-pushed since it was created (a later
      // `git fetch` updated the remote-tracking ref while the worktree's local
      // branch stayed put). Resuming on that stale local ref would run the next
      // phase on the wrong PR head and may overwrite the remote work on push, so
      // apply the same fail-closed divergence guard enforced during creation
      // before handing the worktree back.
      if (remoteHeadGuardRejects()) {
        return {
          ok: false,
          error: `Worktree at ${path} is on ${input.branch}, which has diverged from origin/${input.branch}; refusing to reuse the stale local ref. Reconcile it (e.g. \`git fetch\` then fast-forward or reset ${input.branch} to origin/${input.branch} in ${path}) before resuming.`,
        };
      }
      return { ok: true, path, worktreeId, branch: input.branch, created: false, branchReused: true };
    }
  }

  // Ensure the parent directory exists so `git worktree add` does not fail on a
  // missing `<root>/<session>/issue-<n>` ancestor.
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch (err) {
    return { ok: false, error: `Failed to create worktree parent directory: ${err instanceof Error ? err.message : String(err)}` };
  }

  // Does the branch already exist in the canonical repo? If so, check it out into
  // the new worktree; otherwise create it from baseRef. `-B` would reset an
  // existing branch, which must not silently discard prior work, so branch
  // existence drives the choice explicitly.
  //
  // Also check for a remote-tracking ref: after restoring a session in a fresh
  // clone, or after the local branch was deleted while the PR still exists, the
  // local ref may be absent while `origin/<branch>` carries all the PR commits.
  // Prefer `--track origin/<branch>` in that case to avoid diverging from or
  // losing existing PR work.
  const branchExists =
    runner.run("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${input.branch}`], { cwd: input.repoRoot }).exitCode === 0;
  const remoteRefExists = !branchExists &&
    runner.run("git", ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${input.branch}`], { cwd: input.repoRoot }).exitCode === 0;

  // If the branch exists locally, check whether it is already checked out in
  // another worktree (including the canonical checkout at repoRoot). Git refuses
  // `git worktree add <path> <branch>` when the branch is already checked out
  // elsewhere — the common migration/recovery case where `ai/issue-<n>` is still
  // the HEAD of the canonical repo. `--force` bypasses that guard and lets us
  // plant the per-issue worktree alongside the canonical checkout so the operator
  // can then switch the canonical checkout to a neutral branch.
  const branchCheckedOutElsewhere = branchExists &&
    runner.run("git", ["worktree", "list", "--porcelain"], { cwd: input.repoRoot })
      .stdout.includes(`branch refs/heads/${input.branch}`);

  // The local branch can be absent while the issue branch still exists on the
  // remote — a fresh checkout, or local branch cleanup during recovery, leaves
  // `origin/ai/issue-N` carrying the live PR head with no local `refs/heads/...`.
  // Creating a fresh branch from `baseRef` in that case would silently drop the
  // already-pushed issue commits and leave the worktree diverged from the remote
  // branch. Prefer the remote-tracking ref as the start point so the worktree
  // recovers the existing PR head; fall back to `baseRef` only when no remote
  // issue branch exists to recover.
  const remoteRef = `refs/remotes/origin/${input.branch}`;
  const remoteBranchExists =
    !branchExists &&
    runner.run("git", ["rev-parse", "--verify", "--quiet", remoteRef], { cwd: input.repoRoot }).exitCode === 0;

  // When the local `ai/issue-N` branch already exists we check it out directly,
  // but origin may have advanced or been force-pushed since this local ref was
  // last updated (follow-up commits landed on the PR head from elsewhere). Adding
  // the worktree from a stale/diverged local ref would put the next phase's commits
  // on top of the wrong PR head and risk overwriting the remote work on push. Only
  // reuse the local branch when it already contains the remote head — i.e. local is
  // equal to, or ahead of, origin. Run this BEFORE detaching the canonical checkout
  // so a divergence failure does not leave the canonical repo mutated.
  if (branchExists && remoteHeadGuardRejects()) {
    return {
      ok: false,
      error: `Local branch ${input.branch} has diverged from origin/${input.branch}; refusing to create a worktree from the stale local ref. Reconcile it (e.g. \`git fetch\` then fast-forward or reset ${input.branch} to origin/${input.branch}) in ${input.repoRoot} before retrying.`,
    };
  }

  // Git refuses `git worktree add <path> <branch>` when the branch is already
  // checked out in another working tree. The implementation success path leaves
  // the canonical `repoRoot` checked out on `ai/issue-N`, so a later per-issue
  // migration for that issue would hit exactly this refusal even though the
  // branch is valid. Find the working tree (if any) that currently holds the
  // branch and reconcile it before adding.
  // Tracks whether we detached the canonical checkout below so the `git worktree
  // add` failure path can re-attach it to the branch. Detaching frees the branch
  // ref for the add, but if the add then fails (e.g. a stale non-registered
  // directory occupies the target path) the canonical repo would otherwise be left
  // on detached HEAD — a mutation of shared state caused by a failed resolve.
  let detachedCanonicalFromBranch = false;
  if (branchExists) {
    const listedForBranch = listWorktrees(input.repoRoot, runner);
    if (!listedForBranch.ok) return listedForBranch;
    const expectedRef = `refs/heads/${input.branch}`;
    const holder = listedForBranch.worktrees.find((w) => w.branch === expectedRef);
    if (holder) {
      if (canonicalizePath(holder.path) === canonicalRepoRoot) {
        // The branch is checked out in the canonical repo itself. Detaching HEAD
        // frees the branch ref WITHOUT touching the working tree or index, but the
        // new per-issue worktree is created from the branch *ref* only — it does
        // not carry the canonical checkout's working tree/index over. So any
        // uncommitted or staged changes here would be stranded in the detached
        // canonical checkout while the next phase runs against the clean branch
        // head as if that work never existed. Fail closed on a dirty canonical
        // checkout so the operator can commit or stash before migrating, rather
        // than silently discarding pending work.
        const status = runner.run("git", ["status", "--porcelain"], { cwd: input.repoRoot });
        if (status.exitCode !== 0) {
          return {
            ok: false,
            error: `Failed to inspect the canonical checkout at ${input.repoRoot} for pending changes before migrating ${input.branch} to a worktree (exit ${status.exitCode}): ${(status.stderr || status.stdout).slice(0, 300)}`,
          };
        }
        if (status.stdout.trim() !== "") {
          return {
            ok: false,
            error: `Canonical checkout at ${input.repoRoot} has uncommitted changes on ${input.branch}; refusing to migrate it to a per-issue worktree because the new worktree is created from the branch ref only and would strand that work. Commit or stash the changes in ${input.repoRoot} before retrying.`,
          };
        }
        const detached = runner.run("git", ["checkout", "--detach", "--quiet"], { cwd: input.repoRoot });
        if (detached.exitCode !== 0) {
          return {
            ok: false,
            error: `Failed to detach the canonical checkout at ${input.repoRoot} from ${input.branch} before migrating it to a worktree (exit ${detached.exitCode}): ${(detached.stderr || detached.stdout).slice(0, 300)}`,
          };
        }
        detachedCanonicalFromBranch = true;
      } else {
        // Another per-issue worktree already owns the branch. Stealing it would
        // corrupt that worktree's HEAD, so fail closed and point at the holder.
        return {
          ok: false,
          error: `Branch ${input.branch} is already checked out at ${holder.path}; refusing to add a second worktree for it`,
        };
      }
    }
  }

  const addArgs = branchExists
    ? branchCheckedOutElsewhere
      ? ["worktree", "add", "--force", path, input.branch]
      : ["worktree", "add", path, input.branch]
    : remoteRefExists
      ? ["worktree", "add", "--track", "-b", input.branch, path, `origin/${input.branch}`]
      : ["worktree", "add", "-b", input.branch, path, input.baseRef];
  const added = runner.run("git", addArgs, { cwd: input.repoRoot });
  if (added.exitCode !== 0) {
    let error = `git ${addArgs.join(" ")} failed (exit ${added.exitCode}): ${(added.stderr || added.stdout).slice(0, 300)}`;
    // We detached the canonical checkout to free the branch for the add. The add
    // failed, so re-attach the canonical checkout to its branch rather than leaving
    // the shared repo on detached HEAD. The branch ref still points at the detached
    // HEAD commit (detach does not move it), so this restores the prior state
    // without touching the preserved working tree/index.
    if (detachedCanonicalFromBranch) {
      const restored = runner.run("git", ["checkout", "--quiet", input.branch], { cwd: input.repoRoot });
      if (restored.exitCode !== 0) {
        error += `; additionally failed to restore the canonical checkout at ${input.repoRoot} to ${input.branch} (exit ${restored.exitCode}): ${(restored.stderr || restored.stdout).slice(0, 300)} — it is left on detached HEAD`;
      }
    }
    return { ok: false, error };
  }
  // `branchExists` distinguishes the two creation sub-paths: when the local branch was
  // already present it was checked out into the new worktree (REUSED, regardless of the
  // path being freshly created here — e.g. after the prior worktree dir was pruned);
  // otherwise the branch was created fresh from `baseRef`/`origin/<branch>` (issue #455).
  return { ok: true, path, worktreeId, branch: input.branch, created: true, branchReused: branchExists };
}

/**
 * Remove a per-issue worktree. `git worktree remove` refuses a dirty or locked
 * worktree unless `force` is set, so callers must opt into discarding
 * uncommitted state — never the default (the per-issue model deliberately
 * preserves dirty state until an operator/terminal-state cleanup decides
 * otherwise).
 */
export function removeWorktree(
  repoRoot: string,
  path: string,
  opts: { force?: boolean; runner?: CommandRunner } = {},
): { ok: true } | { ok: false; error: string } {
  const runner = opts.runner ?? defaultCommandRunner;
  // Git needs `-f -f` (double force) to remove a *locked* worktree: a single
  // `-f` only overrides a dirty tree and still exits with
  // `fatal: cannot remove a locked working tree`. The prune contract promises
  // `--force` discards a dirty OR locked worktree, so map our single `force`
  // flag to double force (which also covers the dirty case).
  const args = ["worktree", "remove", ...(opts.force ? ["--force", "--force"] : []), path];
  const r = runner.run("git", args, { cwd: repoRoot });
  if (r.exitCode !== 0) {
    return { ok: false, error: `git ${args.join(" ")} failed (exit ${r.exitCode}): ${(r.stderr || r.stdout).slice(0, 300)}` };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Issue-scoped advisory lock
//
// The session repo lock is a broad, stop-the-world guard. The per-issue model
// narrows phase execution to an issue-scoped lock so two different issues can run
// concurrently while the SAME issue is still serialized (one active execution per
// worktree). It reuses the proven atomic O_EXCL file-lock primitive of
// RepoLockStore with a composite `<session>::issue-<n>` scope and a dedicated
// lock directory, so issue locks never collide with the session repo lock.
// ---------------------------------------------------------------------------

/** Default directory for per-issue worktree locks. */
export const DEFAULT_WORKTREE_LOCK_DIR = join(
  homedir(),
  ".local",
  "state",
  "n8n-ai-cli-loop",
  "worktree-locks",
);

/** Composite lock scope that serializes a single issue's worktree execution. */
export function issueLockScope(sessionId: string, issueNumber: number): string {
  return `${sessionId}::issue-${issueNumber}`;
}

/**
 * Advisory lock that serializes execution for one issue's worktree while
 * allowing different issues to proceed concurrently.
 */
export class IssueWorktreeLock {
  readonly #store: RepoLockStore;

  constructor(lockDir: string = DEFAULT_WORKTREE_LOCK_DIR, staleTtlMs?: number) {
    this.#store = new RepoLockStore(lockDir, staleTtlMs);
  }

  acquire(ownerId: string, sessionId: string, issueNumber: number, now?: string): AcquireResult {
    return this.#store.acquire(ownerId, issueLockScope(sessionId, issueNumber), now);
  }

  release(ownerId: string, sessionId: string, issueNumber: number): ReleaseResult {
    return this.#store.release(ownerId, issueLockScope(sessionId, issueNumber));
  }

  inspect(sessionId: string, issueNumber: number, now?: string): InspectResult {
    return this.#store.inspect(issueLockScope(sessionId, issueNumber), now);
  }

  /**
   * Force-remove an issue's worktree lock regardless of which context owns it.
   * Used by admin cleanup to release a stale/orphaned issue lock left behind by a
   * crashed run. When `ownerId` is supplied the lock is only removed if it
   * matches, mirroring {@link RepoLockStore.forceRelease}.
   */
  forceRelease(sessionId: string, issueNumber: number, ownerId?: string): ForceReleaseResult {
    return this.#store.forceRelease(issueLockScope(sessionId, issueNumber), ownerId);
  }
}
