/**
 * Repository-change handling for the guided Tool Request flow (issue #419).
 *
 * After an operator-granted Tool Request command runs (see `admin tool-request
 * grant` in cli/admin.ts), it frequently leaves changes behind — a dependency
 * install rewrites a lockfile, a codegen step emits artifacts, and so on. Rather
 * than make the operator remember the exact git incantations to land or drop
 * those changes safely, the flow inspects the resulting working tree and guides
 * them through the small set of valid outcomes.
 *
 * This module is PURE: it classifies changed files against the request's
 * `expectedFiles`, and decides — given the chosen action and the current repo
 * state — whether that action is safe and what git steps it implies. It never
 * shells out. The orchestrator caller (admin.ts) owns running git, recording
 * events/artifacts, and posting the public (redacted) outcome.
 *
 * Safety properties enforced here:
 *   - `commit` is refused unless HEAD is on the expected issue branch and that
 *     branch is not the base branch — so generated changes can never be committed
 *     to `main` (issue #316 carried forward).
 *   - `commit` is refused when changed files fall outside `expectedFiles` unless
 *     the operator explicitly opts in, so unexpected files are surfaced first.
 *   - artifact files (`.n8n-artifacts`, the session artifact dir) are never part
 *     of a commit or discard set — they are local audit records, not issue work.
 *   - `discard` is destructive and is refused without explicit confirmation.
 */

/**
 * Operator-chosen outcome for repository changes left by a granted command:
 *   - `commit`:  commit the expected generated changes to the issue branch and push.
 *   - `keep`:    leave the changes in the issue worktree for the next phase.
 *   - `discard`: discard the generated changes (destructive; needs confirmation).
 *   - `reject`:  reject the Tool Request and return feedback to implementation.
 *   - `abort`:   do nothing and exit, leaving the worktree untouched.
 */
export type RepoChangeAction = "commit" | "keep" | "discard" | "reject" | "abort";

const REPO_CHANGE_ACTIONS: readonly RepoChangeAction[] = [
  "commit",
  "keep",
  "discard",
  "reject",
  "abort",
];

/**
 * Parse an operator-supplied `--on-changes` value into a {@link RepoChangeAction}.
 * Returns `undefined` for an unknown action so the caller can fail fast (unknown
 * flags/values must never be silently coerced to a default — issue #419 safety).
 */
export function parseRepoChangeAction(value: string): RepoChangeAction | undefined {
  const v = value.trim().toLowerCase();
  return (REPO_CHANGE_ACTIONS as readonly string[]).includes(v)
    ? (v as RepoChangeAction)
    : undefined;
}

/** A single changed path parsed from `git status --porcelain`. */
export interface ChangedFile {
  /** Repository-relative path. For a rename/copy, the destination path. */
  path: string;
  /**
   * For a rename/copy (`R`/`C`), the source path that the change moved/copied
   * from; `undefined` otherwise. The caller must stage BOTH sides of a rename —
   * staging only `path` lands the new file but leaves the source deletion dirty.
   */
  origPath?: string;
  /** Index (staged) status char from porcelain XY, or " " when none. */
  index: string;
  /** Worktree (unstaged) status char from porcelain XY, or " " when none. */
  worktree: string;
}

/**
 * Decode a single porcelain v1 path. Git wraps a path in double quotes and
 * C-escapes it (`\t`, `\n`, `\"`, `\\`, and — with `core.quotePath` on, the
 * default — `\NNN` octal per UTF-8 byte) whenever it contains "unusual"
 * characters such as control bytes, quotes, backslashes, or non-ASCII bytes.
 * Left undecoded, those quotes/escapes become part of the path, so expected-file
 * matching refuses legitimate changes and a later `git add -- "<quoted>"` targets
 * a filename that does not exist. A path that is not double-quoted is returned
 * unchanged (git does not quote ordinary paths, including ones with spaces).
 */
function unquotePorcelainPath(raw: string): string {
  if (raw.length < 2 || !raw.startsWith('"') || !raw.endsWith('"')) return raw;
  const body = raw.slice(1, -1);
  // Octal escapes encode individual UTF-8 bytes, so accumulate bytes and decode
  // the whole sequence at the end rather than char-by-char.
  const bytes: number[] = [];
  const pushUtf8 = (ch: string): void => {
    for (const b of Buffer.from(ch, "utf8")) bytes.push(b);
  };
  const simple: Record<string, number> = {
    a: 0x07, b: 0x08, f: 0x0c, n: 0x0a, r: 0x0d, t: 0x09, v: 0x0b, '"': 0x22, "\\": 0x5c,
  };
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== "\\") {
      pushUtf8(ch);
      continue;
    }
    if (i + 1 >= body.length) {
      // Trailing backslash with nothing to escape; keep it literally.
      bytes.push(0x5c);
      break;
    }
    const next = body[i + 1];
    if (next >= "0" && next <= "7") {
      let oct = "";
      while (i + 1 < body.length && oct.length < 3 && body[i + 1] >= "0" && body[i + 1] <= "7") {
        oct += body[i + 1];
        i++;
      }
      bytes.push(parseInt(oct, 8) & 0xff);
      continue;
    }
    if (next in simple) {
      bytes.push(simple[next]);
      i++;
      continue;
    }
    // Unknown escape: keep the escaped character literally.
    pushUtf8(next);
    i++;
  }
  return Buffer.from(bytes).toString("utf8");
}

/**
 * Parse `git status --porcelain` (v1) output into changed files. Each line is
 * `XY <path>` where X is the index status and Y the worktree status; a rename is
 * `R  <old> -> <new>`. We keep the destination path (what now exists on disk) as
 * `path` and the source as `origPath` so the caller can stage BOTH sides — a
 * commit that stages only the destination leaves the source deletion dirty.
 * Blank lines are ignored. Quoted paths (see {@link unquotePorcelainPath}) are
 * decoded back to the real on-disk path before classification/staging.
 */
export function parsePorcelainStatus(output: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  for (const rawLine of output.split("\n")) {
    if (rawLine.length === 0) continue;
    // Porcelain v1: two status chars then a space, then the path. A line shorter
    // than that is malformed; skip it rather than emit a bogus empty path.
    if (rawLine.length < 4) continue;
    const index = rawLine[0];
    const worktree = rawLine[1];
    // Strip a trailing CR (CRLF output) but keep the rest verbatim so a path is
    // only unquoted, never trimmed in a way that would corrupt it.
    const rest = rawLine.slice(3).replace(/\r$/, "");
    // Renames/copies render as "old -> new"; the new path is what exists now and
    // the old path is staged for deletion. Each side may be C-quoted
    // independently, so split before unquoting.
    const arrow = rest.indexOf(" -> ");
    let origPath: string | undefined;
    let pathRaw = rest;
    if (arrow !== -1) {
      origPath = unquotePorcelainPath(rest.slice(0, arrow).trim());
      pathRaw = rest.slice(arrow + 4);
      if (origPath.length === 0) origPath = undefined;
    }
    const path = unquotePorcelainPath(pathRaw.trim());
    if (path.length === 0) continue;
    files.push({ path, ...(origPath ? { origPath } : {}), index, worktree });
  }
  return files;
}

/** Normalize a path for comparison: trim and strip a leading `./`. */
function normalizePath(p: string): string {
  let s = p.trim();
  while (s.startsWith("./")) s = s.slice(2);
  return s;
}

/**
 * Whether `path` lives under one of `prefixes` (e.g. the artifact dir). A prefix
 * matches the path itself or any descendant, compared on path segment boundaries
 * so `.n8n-artifacts` does not spuriously match `.n8n-artifacts-backup/x`.
 */
export function isIgnoredPath(path: string, prefixes: readonly string[]): boolean {
  const p = normalizePath(path);
  for (const rawPrefix of prefixes) {
    const prefix = normalizePath(rawPrefix).replace(/\/+$/, "");
    if (prefix.length === 0) continue;
    if (p === prefix || p.startsWith(prefix + "/")) return true;
  }
  return false;
}

/**
 * Whether a changed `path` matches one of the request's `expectedFiles`. The
 * agent typically lists expected files by name (`package-lock.json`) or relative
 * path, so a path is "expected" when it equals an expected entry, ends with
 * `/<expected>`, or shares its basename with an expected entry's basename.
 */
export function matchesExpected(path: string, expectedFiles: readonly string[]): boolean {
  // Strip trailing slashes before deriving the basename. Git reports an untracked
  // directory as `tmp/`; without stripping, its basename is "" and would match the
  // (also empty) basename of any directory-style expected entry like `dist/`,
  // silently classifying unrelated generated dirs as expected (issue #419 review).
  const p = normalizePath(path).replace(/\/+$/, "");
  const base = p.slice(p.lastIndexOf("/") + 1);
  for (const rawExpected of expectedFiles) {
    const expected = normalizePath(rawExpected).replace(/\/+$/, "");
    if (expected.length === 0) continue;
    if (p === expected || p.endsWith("/" + expected)) return true;
    const expectedBase = expected.slice(expected.lastIndexOf("/") + 1);
    // Never match on empty basenames — that would equate any two directories.
    if (base.length > 0 && base === expectedBase) return true;
  }
  return false;
}

export interface ChangeClassification {
  /** Changed files matching {@link ToolRequest.expectedFiles}. */
  expected: ChangedFile[];
  /** Changed files NOT matched by expectedFiles (surfaced before commit). */
  unexpected: ChangedFile[];
  /** Changed files under an ignored prefix (artifacts); never committed/discarded. */
  ignored: ChangedFile[];
}

/**
 * Split changed files into expected / unexpected / ignored. Ignored (artifact)
 * files are removed first so they never count as expected or unexpected — they
 * are local audit records, not part of the issue's change set. When
 * `expectedFiles` is empty (the agent gave none), every non-ignored file is
 * treated as unexpected so the operator must consciously opt in before a commit.
 */
export function classifyChangedFiles(
  files: readonly ChangedFile[],
  expectedFiles: readonly string[],
  ignoredPrefixes: readonly string[],
): ChangeClassification {
  const expected: ChangedFile[] = [];
  const unexpected: ChangedFile[] = [];
  const ignored: ChangedFile[] = [];
  for (const file of files) {
    if (isIgnoredPath(file.path, ignoredPrefixes)) {
      ignored.push(file);
    } else if (matchesExpected(file.path, expectedFiles)) {
      expected.push(file);
    } else {
      unexpected.push(file);
    }
  }
  return { expected, unexpected, ignored };
}

export interface RepoChangePlanInput {
  action: RepoChangeAction;
  classification: ChangeClassification;
  /** Branch HEAD is on after the command ran. */
  currentBranch: string;
  /** The issue branch the changes must land on. */
  expectedBranch: string;
  /** The session base branch — generated changes must never be committed here. */
  baseBranch: string;
  /** Operator confirmed the destructive discard (`--confirm-discard`/`--yes`). */
  confirmDiscard: boolean;
  /** Operator opted into committing despite unexpected files (`--allow-unexpected`). */
  allowUnexpected: boolean;
}

export type RepoChangePlanRefusalCode =
  | "wrong-branch"
  | "base-branch"
  | "needs-confirmation"
  | "unexpected-files"
  | "nothing-to-do";

export type RepoChangePlan =
  | { ok: false; code: RepoChangePlanRefusalCode; reason: string }
  | {
      ok: true;
      action: RepoChangeAction;
      /** Whether the caller should `git add`+`commit` the expected files. */
      commit: boolean;
      /** Whether the caller should `git push` the issue branch after commit. */
      push: boolean;
      /** Whether the caller should discard (checkout -f + clean) the changes. */
      discard: boolean;
    };

/** Whether the classification has any non-artifact (committable/discardable) change. */
function hasCommittableChanges(c: ChangeClassification): boolean {
  return c.expected.length > 0 || c.unexpected.length > 0;
}

/**
 * Decide whether `action` is safe given the current repo state and what git
 * steps it implies. Pure: the caller executes the returned plan.
 *
 * - `commit`: requires committable (non-artifact) changes, HEAD on the expected
 *   issue branch (never the base branch), and — unless `allowUnexpected` — no
 *   unexpected files. Implies commit + push.
 * - `discard`: requires explicit confirmation. Implies a destructive restore.
 * - `keep` / `reject` / `abort`: always safe here; they imply no git mutation in
 *   this module (the caller records the chosen outcome and, for `reject`, routes
 *   the request back to implementation).
 */
export function planRepoChange(input: RepoChangePlanInput): RepoChangePlan {
  const { action, classification, currentBranch, expectedBranch, baseBranch } = input;

  switch (action) {
    case "commit": {
      if (!hasCommittableChanges(classification)) {
        return {
          ok: false,
          code: "nothing-to-do",
          reason:
            "Nothing to commit: the command left no changes outside the artifact directory.",
        };
      }
      // Never commit onto the base branch, and only commit when HEAD is actually
      // on the expected issue branch (a command may have switched branches).
      if (currentBranch === baseBranch) {
        return {
          ok: false,
          code: "base-branch",
          reason:
            `Refusing to commit: HEAD is on the base branch '${baseBranch}'. Generated changes ` +
            `must land on the issue branch '${expectedBranch}', never the base branch.`,
        };
      }
      if (currentBranch !== expectedBranch) {
        return {
          ok: false,
          code: "wrong-branch",
          reason:
            `Refusing to commit: HEAD is on '${currentBranch}', not the expected issue branch ` +
            `'${expectedBranch}'. Restore the issue branch before committing.`,
        };
      }
      if (classification.unexpected.length > 0 && !input.allowUnexpected) {
        return {
          ok: false,
          code: "unexpected-files",
          reason:
            `Refusing to commit: ${classification.unexpected.length} changed file(s) are not in the ` +
            `Tool Request's expected files. Review them, then re-run with --allow-unexpected to ` +
            `include them, or discard/keep instead.`,
        };
      }
      return { ok: true, action, commit: true, push: true, discard: false };
    }

    case "discard": {
      if (!hasCommittableChanges(classification)) {
        return {
          ok: false,
          code: "nothing-to-do",
          reason:
            "Nothing to discard: the command left no changes outside the artifact directory.",
        };
      }
      if (!input.confirmDiscard) {
        return {
          ok: false,
          code: "needs-confirmation",
          reason:
            "Discard is destructive and permanently drops the generated changes. Re-run with " +
            "--confirm-discard to proceed.",
        };
      }
      return { ok: true, action, commit: false, push: false, discard: true };
    }

    case "keep":
      return { ok: true, action, commit: false, push: false, discard: false };

    case "reject":
      return { ok: true, action, commit: false, push: false, discard: false };

    case "abort":
      return { ok: true, action, commit: false, push: false, discard: false };
  }
}

/**
 * Build a public-safe one-line summary of a change set: counts only, never paths,
 * never command output. Suitable for embedding in a public comment alongside the
 * already-redacted command.
 */
export function summarizeClassification(c: ChangeClassification): string {
  const parts = [
    `${c.expected.length} expected`,
    `${c.unexpected.length} unexpected`,
    `${c.ignored.length} artifact`,
  ];
  return parts.join(", ") + " file(s)";
}
