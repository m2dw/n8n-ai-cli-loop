/**
 * Read-only §3.3 evidence access over a checkout
 * (docs/review-dispute-contract.md).
 *
 * The review-dispute protocol resolves evidence references in two phases and
 * two handlers: the review run resolves the references a finding cites (issue
 * #841), and the fix run resolves the references a DISPUTE cites (issue #843).
 * Both must resolve them under exactly the same admission posture — bounded,
 * tracked-file scope, no symlinks, no network, nothing executed — so the pair
 * of primitives that establish that posture lives here rather than being
 * copied into each handler, where the two copies could drift into two
 * different security boundaries.
 *
 * These are the checkout-facing half only. The reference-shaped half (what a
 * `file` range or a `doc_section` heading has to satisfy) is
 * `createReviewEvidenceResolver` in `core/review-finding-envelope.ts`, which
 * takes both of these as its index.
 */
import { lstatSync, readFileSync, realpathSync } from "fs";
import { join, sep } from "path";
import type { CommandRunner } from "./command-runner.js";

/** git's index modes for a regular file; every other mode is not one. */
const TRACKED_REGULAR_FILE_MODES: ReadonlySet<string> = new Set(["100644", "100755"]);

/**
 * Build the read-only §3.3 evidence index for a checkout.
 *
 * One `git ls-files -s` capture, restricted to REGULAR files by an allow-list of
 * git's regular-file modes (`100644`, `100755`). Every other index mode names
 * something a finding cannot cite as file or document evidence: `120000` is a
 * symlink, which the repository evidence contract's admission posture excludes
 * outright, and `160000` is a gitlink — a submodule directory whose content is not
 * in this checkout's index at all. Untracked and ignored paths are absent by
 * construction — `git ls-files` lists the index. A failed capture yields an EMPTY
 * index, so every file reference fails to resolve and the citing record is rejected
 * rather than admitted on unverified evidence.
 */
export function captureTrackedFiles(runner: CommandRunner, cwd: string): Set<string> {
  const tracked = new Set<string>();
  const result = runner.run("git", ["ls-files", "-s"], { cwd, maxBuffer: 32 * 1024 * 1024 });
  if (result.exitCode !== 0) return tracked;
  for (const line of result.stdout.split("\n")) {
    if (line === "") continue;
    // `<mode> <object> <stage>\t<path>`
    const tab = line.indexOf("\t");
    if (tab === -1) continue;
    if (!TRACKED_REGULAR_FILE_MODES.has(line.slice(0, 6))) continue;
    tracked.add(line.slice(tab + 1));
  }
  return tracked;
}

/**
 * The largest evidence document this runner will read to check a reference.
 *
 * Line ranges and headings are checked on content, and a citation into a
 * multi-megabyte generated file is not the evidence §3.3 is asking for. Past this
 * bound the reader declines, the reference goes unverified, and unverified does
 * not resolve — the same fail-closed direction as an absent path.
 */
const MAX_EVIDENCE_FILE_BYTES = 4 * 1024 * 1024;

/**
 * A bounded reader for the §3.3 resolver, over paths already known to be tracked
 * regular files of this checkout.
 *
 * Anything the read cannot deliver — a vanished path, a permission error, a file
 * over the bound, something that is no longer a regular file on disk — comes back
 * as `undefined`, which the resolver treats as "not verified" rather than "fine".
 *
 * The index capture excludes symlinks by mode, but the capture and the read are
 * two moments: a verification command or any other worktree mutation can replace a
 * tracked regular file — or one of its parent directories — with a link between
 * them. So the read re-establishes the boundary on disk rather than trusting the
 * earlier capture: `lstatSync` does not follow the final component, and the
 * resolved real path must still be inside this checkout. Content from outside the
 * checkout can never satisfy a record's evidence reference.
 */
export function createTrackedFileReader(cwd: string): (path: string) => string | undefined {
  let root: string | undefined;
  try {
    root = realpathSync(cwd);
  } catch {
    root = undefined;
  }
  return (path) => {
    if (root === undefined) return undefined;
    try {
      const abs = join(cwd, path);
      // lstat, not stat: a symlink must be refused, not followed to its target.
      // (`isFile()` is already false for a link here; the explicit test states the
      // boundary rather than leaving it to a reader of `lstat` semantics.)
      const stat = lstatSync(abs);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_EVIDENCE_FILE_BYTES) return undefined;
      // The final component is not a link, so this resolves parent components only:
      // a directory swapped for a link elsewhere on the filesystem lands outside.
      const real = realpathSync(abs);
      if (!real.startsWith(root + sep)) return undefined;
      return readFileSync(real, "utf8");
    } catch {
      return undefined;
    }
  };
}
