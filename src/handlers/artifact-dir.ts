import { mkdirSync, writeFileSync, lstatSync, realpathSync } from "fs";
import { join, relative, resolve } from "path";
import { parseLineageProvenanceRecord } from "../core/review-dispute-lineage-provenance.js";
import { REVIEW_DISPUTE_REBUTTALS_CONTEXT_FIELD } from "../core/review-dispute-rebuttals.js";
import { REVIEW_DISPUTE_RECONSIDERATIONS_CONTEXT_FIELD } from "../core/review-dispute-reconsiderations.js";
import { REVIEW_DISPUTE_ARBITRATIONS_CONTEXT_FIELD } from "../core/review-dispute-arbitrations.js";
import {
  REVIEW_DISPUTE_EVIDENCE_COLLECTIONS_CONTEXT_KEY,
  collectEvidenceCollectionArtifactDirs,
} from "../core/review-dispute-evidence-collections.js";

export function runArtifactDir(artifactRoot: string, runId: string): string {
  return join(artifactRoot, "runs", runId);
}

/**
 * Re-exported from `core/artifact-dir-contract.ts`, which owns the contract
 * (issue #883): `core/transitions.ts` needs this key without depending at
 * runtime on this Execution-layer module, so the constant is declared in
 * `core/` and this module — and every other existing consumer that imports
 * it from here — re-exports it unchanged.
 */
export { ARTIFACT_DIR_PENDING_CONTEXT_FIELD } from "../core/artifact-dir-contract.js";
export { DISPUTE_ARTIFACT_DIR_CONTEXT_FIELD } from "../core/artifact-dir-contract.js";
export { RECONSIDERATION_ARTIFACT_DIR_CONTEXT_FIELD } from "../core/artifact-dir-contract.js";

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
  // The dedicated, never-overwritten reference to the review run that
  // produced `review-findings.json`, carried forward across implementation
  // retries (issue #837 review, P2) — must be validated/tracked the same as
  // every other artifact-directory reference above.
  "reviewArtifactDir",
  // The equally dedicated reference to the FIX run that wrote the §10.2 dispute
  // records the reviewer's reconsideration turn re-reads (issue #952).
  "disputeArtifactDir",
  // And to the REVIEWER sub-turn that wrote the §10.2 reconsideration records
  // the arbitration bundle re-presents a phase run later (issue #955).
  "reconsiderationArtifactDir",
] as const;

/**
 * Context fields holding a PER-LINEAGE provenance record
 * (`core/review-dispute-lineage-provenance.ts`), whose entries each name the run
 * directory that lineage's rebuttal, reconsideration, or arbitration verdict was
 * written into.
 *
 * These are artifact-directory references exactly like the scalars above, but
 * nested one level down, and they outlive them: the scalars describe only the
 * LAST run of their kind, while a task with two disputed lineages keeps an
 * earlier live lineage reachable only through its own entry here. Walking only
 * the scalars would let a restore succeed after that earlier directory is gone,
 * and would let retention treat it as unreferenced — either of which parks
 * arbitration the moment it selects that lineage (issue #955 review, P1).
 */
export const LINEAGE_ARTIFACT_DIR_CONTEXT_FIELDS = [
  REVIEW_DISPUTE_REBUTTALS_CONTEXT_FIELD,
  REVIEW_DISPUTE_RECONSIDERATIONS_CONTEXT_FIELD,
  // And the §8.1 verdict records (issue #964): the evidence turn a row-16
  // `insufficient_evidence` verdict opens re-presents the record from the
  // directory of the run that MINTED it, one or more phase runs earlier, so
  // that directory is live for exactly as long as its lineage's entry is.
  REVIEW_DISPUTE_ARBITRATIONS_CONTEXT_FIELD,
] as const;

/** One artifact-directory reference found in a task context. */
export interface ArtifactDirReference {
  /**
   * Where the directory came from, as a dotted context path
   * (`artifactDir`, `reviewDisputeRebuttals.lineages.<id>.artifactDir`, ...).
   * Reported verbatim by restore, so a rejection names the exact reference.
   */
  field: string;
  dir: string;
  /** The plain `artifactDir` scalar, which alone can be marked never-created. */
  isPendingEligible: boolean;
}

/**
 * Every artifact directory a task context references — scalar, per-lineage, and
 * the per-party evidence-collection record alike — the single enumeration
 * restore validation and retention liveness both walk, so a newly added
 * reference can never be tracked by one and not the other.
 *
 * The nested records are read through their own parser, so an entry this runner
 * could not have written is skipped here for the same reason arbitration skips
 * it: a dropped entry is one no turn will ever read a record out of, and failing
 * a restore over unreadable bookkeeping would park a debate that is still
 * resolvable from its fall-backs.
 */
export function collectArtifactDirReferences(context: unknown): ArtifactDirReference[] {
  if (typeof context !== "object" || context === null || Array.isArray(context)) return [];
  const ctx = context as Record<string, unknown>;
  const refs: ArtifactDirReference[] = [];
  for (const field of ARTIFACT_DIR_CONTEXT_FIELDS) {
    const dir = ctx[field];
    if (typeof dir !== "string" || dir.length === 0) continue;
    refs.push({ field, dir, isPendingEligible: field === "artifactDir" });
  }
  for (const field of LINEAGE_ARTIFACT_DIR_CONTEXT_FIELDS) {
    const record = parseLineageProvenanceRecord(ctx[field]);
    for (const [lineageId, entry] of Object.entries(record.lineages)) {
      refs.push({
        field: `${field}.lineages.${lineageId}.artifactDir`,
        dir: entry.artifactDir,
        isPendingEligible: false,
      });
    }
  }
  for (const { party, dir } of collectEvidenceCollectionArtifactDirs(
    ctx[REVIEW_DISPUTE_EVIDENCE_COLLECTIONS_CONTEXT_KEY],
  )) {
    refs.push({
      field: `${REVIEW_DISPUTE_EVIDENCE_COLLECTIONS_CONTEXT_KEY}.${party}.artifactDir`,
      dir,
      isPendingEligible: false,
    });
  }
  return refs;
}

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
