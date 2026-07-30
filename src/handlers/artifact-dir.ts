import { mkdirSync, writeFileSync, lstatSync, realpathSync } from "fs";
import { join, relative, resolve } from "path";

export function runArtifactDir(artifactRoot: string, runId: string): string {
  return join(artifactRoot, "runs", runId);
}

/**
 * Centralized list of `task.context` fields that name a
 * `<artifactRoot>/runs/<run-id>/` directory (docs/retention-backup-contract.md
 * §8 point 5). A retention/prune pass must only ever treat these fields as
 * artifact-directory references — walking `events.run_id` instead would flag
 * entirely ordinary preflight-rejection events (which carry a `run_id` but
 * never reach a handler's own directory-creation step) as broken references.
 */
export const ARTIFACT_DIR_CONTEXT_FIELDS = [
  "artifactDir",
  "draftArtifactDir",
  "researchArtifactDir",
  "reviewRunArtifactDir",
] as const;

/**
 * Context key a handler sets to `true` alongside `artifactDir` (issue #611
 * review) whenever it returns before ever reaching its own `mkdirSync` /
 * `isSafeArtifactDirAfterRun` sequence — an admission, repo-host-resolve, or
 * agent-assignment failure, for instance. In every one of those states
 * `artifactDir` names a path that was never created, so restore's
 * artifact-reference validation (`sqlite-backup-store.ts`) must skip that
 * field instead of rejecting the snapshot for a directory that never existed
 * in the first place.
 */
export const ARTIFACT_DIR_PENDING_CONTEXT_FIELD = "artifactDirPending";

function isPathWithinRoot(root: string, dir: string): boolean {
  if (dir === root) return true;
  const rel = relative(root, dir);
  return rel.length > 0 && !rel.startsWith("..");
}

/**
 * Validate that `artifactDir` is a real (non-symlinked) directory inside
 * `artifactRoot`. A leaf-only symlink check on an individual output file (see
 * `rejectSymlink` in the content-* handlers) cannot catch a directory-level
 * symlink: `lstat` on a missing leaf reports ENOENT and a subsequent
 * `writeFileSync` then follows the symlinked parent outside the artifact
 * root. This covers both directions of that gap — a pre-planted symlink at
 * `runs/<run-id>` that lets `mkdirSync`'s recursive existence check (which
 * follows symlinks) silently succeed without creating a real directory, and
 * an agent that replaces its own run directory with a symlink to an external
 * location while it runs. Call this immediately after `mkdirSync` creates the
 * run directory (before any write or runner invocation) and again
 * immediately before any post-agent-run write.
 */
export function isSafeArtifactDirAfterRun(artifactRoot: string, artifactDir: string): boolean {
  let dirStat;
  try {
    dirStat = lstatSync(artifactDir);
  } catch {
    return false;
  }
  if (!dirStat.isDirectory()) return false;

  let realRoot: string;
  try {
    realRoot = realpathSync(resolve(artifactRoot));
  } catch {
    realRoot = resolve(artifactRoot);
  }

  let realDir: string;
  try {
    realDir = realpathSync(artifactDir);
  } catch {
    return false;
  }

  return isPathWithinRoot(realRoot, realDir);
}

/**
 * Record a fail-closed artifact when a phase is asked to run an agent it does
 * not support (e.g. a codex implementation before that agent exists). Written
 * best-effort so an artifact always accompanies the clear error returned to the
 * caller, even though the run never reached its normal result artifact.
 */
export function writeAssignmentFailureArtifact(
  artifactDir: string,
  payload: {
    phase: string;
    agentId: string | undefined;
    sessionId: string;
    issueNumber: number;
    runId: string;
    error: string;
  },
): void {
  try {
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(
      join(artifactDir, "assignment-error.json"),
      JSON.stringify({ success: false, ...payload }, null, 2),
      "utf8",
    );
  } catch {
    // Best effort: the clear error is still returned even if the artifact write fails.
  }
}
