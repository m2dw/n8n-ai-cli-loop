/**
 * Read an Issue's cumulative net change and its branch start from Git (issue
 * #1153, `docs/changed-file-verification-contract.md` §4.1).
 *
 * Plumbing only: every command is a read-only `git` query through the shipped
 * {@link CommandRunner}, and what the reads mean — the Issue base, which changed
 * paths are runnable test files, the retained set — is decided in core by
 * `resolveIssueBase` and `selectStage1TestFiles`. Nothing here fetches, so a
 * base is never recomputed from a moved remote, and nothing here writes to the
 * repository or its index.
 */

import { lstatSync, readlinkSync, type Stats } from "fs";
import { join } from "path";

import type { CommandRunResult, CommandRunner } from "./command-runner.js";
import {
  isCommitSha,
  type CommitRead,
  type CumulativeChangeEntry,
  type CumulativeChangeRead,
  type CumulativePathChange,
} from "../core/changed-test-file-selection.js";

/** The largest Git listing read. A larger one is unreadable, never partially read. */
export const MAX_CUMULATIVE_CHANGE_OUTPUT_BYTES = 64 * 1024 * 1024;

/** The `-z` record terminator, built from its code so no raw NUL sits in this file. */
const NUL = String.fromCharCode(0);

export interface CumulativeChangeOptions {
  /** The repository root (worktree) the stage runs in. */
  readonly cwd: string;
  /** The resolved Issue base commit. */
  readonly base: string;
}

export interface IssueBranchStartOptions {
  readonly cwd: string;
  /** The session's base branch; its remote-tracking ref is read as it is, never fetched. */
  readonly baseBranch: string;
}

function git(runner: CommandRunner, cwd: string, args: string[], stdin?: string): CommandRunResult {
  return runner.run("git", args, {
    cwd,
    maxBuffer: MAX_CUMULATIVE_CHANGE_OUTPUT_BYTES,
    ...(stdin !== undefined ? { stdin } : {}),
  });
}

function failed(result: CommandRunResult): boolean {
  return result.exitCode !== 0 || result.spawnError !== undefined;
}

function failure(what: string, result: CommandRunResult): string {
  const text = (result.spawnError ?? (result.stderr || result.stdout)).trim().slice(0, 300);
  return `${what} failed (exit ${result.exitCode})${text === "" ? "" : `: ${text}`}`;
}

/**
 * The base-branch commit the Issue branch started from: the merge base of the
 * session base branch's remote-tracking ref and `HEAD`, as the local object
 * store holds them. Called only before an Issue base is recorded.
 */
export function readIssueBranchStart(runner: CommandRunner, options: IssueBranchStartOptions): CommitRead {
  const branch = options.baseBranch.trim();
  const ref = `refs/remotes/origin/${branch}`;
  // Git would read revision syntax such as `main~1` or `main@{1}` as a different
  // commit, so the value must be a well-formed ref name before it is resolved.
  const notBranch = { kind: "unreadable", reason: "the session base branch is not a branch name" } as const;
  if (branch === "" || branch.startsWith("-")) return notBranch;
  const format = git(runner, options.cwd, ["check-ref-format", ref]);
  if (format.spawnError !== undefined) return { kind: "unreadable", reason: failure("git check-ref-format", format) };
  if (format.exitCode !== 0) return notBranch;
  const result = git(runner, options.cwd, ["merge-base", ref, "HEAD"]);
  if (failed(result)) {
    return { kind: "unreadable", reason: failure(`git merge-base origin/${branch} HEAD`, result) };
  }
  const sha = result.stdout.trim().toLowerCase();
  if (!isCommitSha(sha)) {
    return { kind: "unreadable", reason: `git merge-base origin/${branch} HEAD printed no commit` };
  }
  return { kind: "readable", sha };
}

const STATUS_CHANGES: Readonly<Record<string, CumulativePathChange>> = {
  A: "added",
  M: "modified",
  T: "modified",
  D: "deleted",
};

/**
 * Parse `git diff --name-status -z --no-renames`: a status token then a path,
 * each NUL-terminated. An unmerged path, or any status this reader does not
 * know, makes the whole listing unreadable rather than partially read.
 */
function parseNameStatus(stdout: string): { entries: CumulativeChangeEntry[] } | { reason: string } {
  const tokens = stdout.split(NUL);
  if (tokens[tokens.length - 1] === "") tokens.pop();
  const entries: CumulativeChangeEntry[] = [];
  for (let i = 0; i < tokens.length; i += 2) {
    const status = tokens[i] ?? "";
    const path = tokens[i + 1];
    if (path === undefined || path === "") return { reason: "git diff printed a status with no path" };
    if (status === "U") return { reason: `${path} is unmerged, so the revision under test is not settled` };
    const change = Object.prototype.hasOwnProperty.call(STATUS_CHANGES, status) ? STATUS_CHANGES[status] : undefined;
    if (change === undefined) return { reason: `git diff printed an unrecognized status ${JSON.stringify(status)}` };
    entries.push({ path, change });
  }
  return { entries };
}

interface BaseTreeEntry {
  readonly mode: string;
  readonly type: string;
  readonly sha: string;
}

/**
 * The most pathspec bytes one `git ls-tree` is given, well under any platform's
 * argument limit, so a sparse checkout hiding many paths costs a few commands
 * rather than one per path.
 */
const MAX_LS_TREE_PATHSPEC_BYTES = 128 * 1024;

/**
 * The tree entry `base` holds at exactly each of `paths`, keyed by path; a path
 * with no key holds none there. `unreadable` when any `git ls-tree` fails, so
 * no path is ever read as absent from a failed listing.
 */
function readBaseEntries(
  runner: CommandRunner,
  cwd: string,
  base: string,
  paths: readonly string[],
): Map<string, BaseTreeEntry> | "unreadable" {
  const wanted = new Set(paths);
  const entries = new Map<string, BaseTreeEntry>();
  let batch: string[] = [];
  let bytes = 0;
  const flush = (): boolean => {
    if (batch.length === 0) return true;
    const tree = git(runner, cwd, ["--literal-pathspecs", "ls-tree", "-z", base, "--", ...batch]);
    batch = [];
    bytes = 0;
    if (failed(tree)) return false;
    for (const record of tree.stdout.split(NUL)) {
      const tab = record.indexOf("\t");
      if (tab < 0) continue;
      // Only an exact requested path counts; nothing else the listing shows does.
      const path = record.slice(tab + 1);
      if (!wanted.has(path)) continue;
      const [mode = "", type = "", sha = ""] = record.slice(0, tab).split(" ");
      entries.set(path, { mode, type, sha });
    }
    return true;
  };
  for (const path of wanted) {
    const size = Buffer.byteLength(path) + 1;
    if (bytes + size > MAX_LS_TREE_PATHSPEC_BYTES && !flush()) return "unreadable";
    batch.push(path);
    bytes += size;
  }
  return flush() ? entries : "unreadable";
}

/**
 * Does the worktree entry at `path` carry exactly `entry`? A regular file is
 * compared by mode and content, a symlink by its link target, and neither
 * consults the index. A non-blob entry, a changed entry type or a failed
 * command answers no.
 */
function worktreeMatchesEntry(runner: CommandRunner, cwd: string, path: string, entry: BaseTreeEntry): boolean {
  const { mode, type, sha } = entry;
  if (type !== "blob") return false;
  const full = join(cwd, path);
  let stat: Stats;
  try {
    stat = lstatSync(full);
  } catch {
    return false;
  }
  if (mode === "120000") {
    if (!stat.isSymbolicLink()) return false;
    let target: string;
    try {
      target = readlinkSync(full, "utf8");
    } catch {
      return false;
    }
    // Git stores a symlink as a blob of its target; `--stdin` hashes it as is.
    const hashed = git(runner, cwd, ["hash-object", "--stdin"], target);
    return !failed(hashed) && hashed.stdout.trim() === sha;
  }
  if (mode !== "100644" && mode !== "100755") return false;
  // Git records a file as executable from the owner-execute bit alone.
  if (!stat.isFile() || ((stat.mode & 0o100) !== 0 ? "100755" : "100644") !== mode) return false;
  // Hashed as `git add` would store it, so the path's attributes and filters apply.
  const hashed = git(runner, cwd, ["hash-object", "--", path]);
  return !failed(hashed) && hashed.stdout.trim() === sha;
}

/** Is there any worktree entry at `path`? Only a missing path answers no. */
function worktreeEntryExists(cwd: string, path: string): boolean {
  try {
    lstatSync(join(cwd, path));
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code !== "ENOENT" && code !== "ENOTDIR";
  }
}

/**
 * Re-read every tracked path the index hides from `git diff`: one marked
 * `assume-unchanged` or `skip-worktree` is compared through its index entry,
 * so an unstaged edit to it never shows. Each is compared with `base` from its
 * worktree entry instead. A missing worktree entry is a deletion under
 * `assume-unchanged` alone; under `skip-worktree` it is a path sparse checkout
 * did not materialize, so its index entry is compared with `base` instead —
 * never whatever the running Git's diff made of the missing file.
 */
function applyIndexHiddenPaths(
  runner: CommandRunner,
  cwd: string,
  base: string,
  changes: Map<string, CumulativePathChange>,
): { reason: string } | undefined {
  // `-v -s`: "<tag> <mode> <object> <stage>\t<path>" per index entry.
  const listing = git(runner, cwd, ["ls-files", "-v", "-s", "-z"]);
  if (failed(listing)) return { reason: failure("git ls-files -v -s", listing) };
  const hidden: { path: string; indexMode: string; indexSha: string; skipWorktree: boolean }[] = [];
  for (const record of listing.stdout.split(NUL)) {
    if (record === "") continue;
    const tab = record.indexOf("\t");
    const [indexMode, indexSha] = tab < 0 ? [] : record.slice(2, tab).split(" ");
    if (record[1] !== " " || tab < 0 || indexMode === undefined || indexSha === undefined) {
      return { reason: "git ls-files -v -s printed an unrecognized record" };
    }
    const tag = record[0] as string;
    const path = record.slice(tab + 1);
    // Lowercase marks assume-unchanged; `S`/`s` marks skip-worktree.
    const assumeUnchanged = tag !== tag.toUpperCase();
    const skipWorktree = tag === "S" || tag === "s";
    if (!assumeUnchanged && !skipWorktree) continue;
    hidden.push({ path, indexMode, indexSha, skipWorktree });
  }
  if (hidden.length === 0) return undefined;

  const baseEntries = readBaseEntries(runner, cwd, base, hidden.map((entry) => entry.path));
  if (baseEntries === "unreadable") return { reason: `git ls-tree ${base} failed for an index-hidden path` };
  for (const { path, indexMode, indexSha, skipWorktree } of hidden) {
    const entry = baseEntries.get(path) ?? "absent";
    if (!worktreeEntryExists(cwd, path)) {
      if (!skipWorktree) {
        if (entry === "absent") changes.delete(path);
        else changes.set(path, "deleted");
      } else if (entry === "absent") {
        changes.set(path, "added");
      } else if (entry.mode === indexMode && entry.sha === indexSha) {
        changes.delete(path);
      } else {
        changes.set(path, "modified");
      }
    } else if (entry === "absent") {
      changes.set(path, "added");
    } else if (worktreeMatchesEntry(runner, cwd, path, entry)) {
      changes.delete(path);
    } else {
      changes.set(path, "modified");
    }
  }
  return undefined;
}

/**
 * §4.1 rules 2 and 3: every path whose complete tree entry at the worktree
 * differs from `base` — content, mode or entry type — across committed, staged
 * and unstaged edits, plus untracked files that are not ignored.
 *
 * - `git diff <base>` compares the base tree with the working tree, so a path
 *   edited and then restored is not listed, and `--no-renames` reports a rename
 *   as a deleted old path and an added new one, whatever the user's
 *   `diff.renames` setting.
 * - `git ls-files --others --exclude-standard` adds untracked, non-ignored
 *   files. One that is also a base path the index no longer tracks exists at
 *   the revision, so it is never read as deleted: it is unchanged when its mode
 *   and blob match the base entry, and `modified` otherwise.
 * - The diff forces `core.fileMode=true`, so an executable-bit change is read
 *   in a repository configured to ignore it.
 * - A tracked path marked `assume-unchanged` or `skip-worktree` is compared
 *   from its worktree entry, never from the index the diff trusts for it.
 * - A missing or non-commit base, a command that fails, a worktree subdirectory
 *   instead of the root, or an unmerged index entry is unreadable — never empty.
 */
export function readCumulativeChange(runner: CommandRunner, options: CumulativeChangeOptions): CumulativeChangeRead {
  const base = options.base.trim().toLowerCase();
  if (!isCommitSha(base)) return { kind: "unreadable", reason: "the Issue base is not a full commit SHA" };

  const prefix = git(runner, options.cwd, ["rev-parse", "--show-prefix"]);
  if (failed(prefix)) return { kind: "unreadable", reason: failure("git rev-parse --show-prefix", prefix) };
  if (prefix.stdout.trim() !== "") {
    return { kind: "unreadable", reason: "the stage directory is not the repository root, so paths would not be file ids" };
  }

  const exists = git(runner, options.cwd, ["cat-file", "-e", `${base}^{commit}`]);
  if (failed(exists)) {
    return { kind: "unreadable", reason: `the Issue base ${base} is not a commit in the local object store` };
  }

  // `git diff <base>` lists a conflicted path as `M`, never `U`, so the index is
  // asked directly: any unmerged entry means the revision is not settled.
  const unmerged = git(runner, options.cwd, ["ls-files", "--unmerged", "-z"]);
  if (failed(unmerged)) return { kind: "unreadable", reason: failure("git ls-files --unmerged", unmerged) };
  if (unmerged.stdout !== "") {
    const record = unmerged.stdout.split(NUL)[0] ?? "";
    const tab = record.indexOf("\t");
    const path = tab < 0 ? "a path" : record.slice(tab + 1);
    return { kind: "unreadable", reason: `${path} is unmerged, so the revision under test is not settled` };
  }

  const diff = git(runner, options.cwd, [
    // A mode-only change is a modification (§4.1 rule 2) whatever the
    // repository's `core.fileMode` says.
    "-c",
    "core.fileMode=true",
    "diff",
    "--no-renames",
    "--no-ext-diff",
    "--no-textconv",
    "--name-status",
    "-z",
    base,
    "--",
  ]);
  if (failed(diff)) return { kind: "unreadable", reason: failure(`git diff ${base}`, diff) };
  const parsed = parseNameStatus(diff.stdout);
  if ("reason" in parsed) return { kind: "unreadable", reason: parsed.reason };

  const untracked = git(runner, options.cwd, ["ls-files", "--others", "--exclude-standard", "-z"]);
  if (failed(untracked)) {
    return { kind: "unreadable", reason: failure("git ls-files --others --exclude-standard", untracked) };
  }

  const changes = new Map<string, CumulativePathChange>();
  for (const entry of parsed.entries) changes.set(entry.path, entry.change);
  const hidden = applyIndexHiddenPaths(runner, options.cwd, base, changes);
  if (hidden !== undefined) return { kind: "unreadable", reason: hidden.reason };
  // An untracked path `git diff` reports as deleted is a base path the index no
  // longer tracks (`git rm --cached`), its content still in the worktree. It is
  // unchanged only when it carries exactly the base entry — same mode and blob;
  // anything this cannot establish leaves it `modified`, never silently unchanged.
  const untrackedBasePaths: string[] = [];
  for (const path of untracked.stdout.split(NUL)) {
    if (path === "") continue;
    const held = changes.get(path);
    if (held === undefined) changes.set(path, "added");
    else if (held === "deleted") untrackedBasePaths.push(path);
  }
  if (untrackedBasePaths.length > 0) {
    const baseEntries = readBaseEntries(runner, options.cwd, base, untrackedBasePaths);
    for (const path of untrackedBasePaths) {
      const entry = baseEntries === "unreadable" ? undefined : baseEntries.get(path);
      if (entry !== undefined && worktreeMatchesEntry(runner, options.cwd, path, entry)) changes.delete(path);
      else changes.set(path, "modified");
    }
  }
  const entries = [...changes.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, change]) => ({ path, change }));
  return { kind: "readable", base, entries };
}
