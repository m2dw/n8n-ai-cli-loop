/**
 * The per-party evidence-collection execution record (issue #964), as a value
 * contract: the context key, the merge, and the tolerant reads over it.
 *
 * Declared in `core/` for the reason `core/artifact-dir-contract.ts` states for
 * its own keys (issue #883; DOMAIN.md §1.2): the shared artifact-directory
 * collector in `handlers/artifact-dir.ts` has to enumerate this record's
 * directories, and it cannot import the Execution-layer sub-turn adapter that
 * writes them — `review-evidence-subturn.ts` reaches `artifact-dir.ts` through
 * `review-evidence-collection.ts`, so naming the key from there would close an
 * import cycle whose module-init order decides whether the collector sees a
 * constant or a TDZ error. `handlers/review-evidence-subturn.ts` re-exports
 * everything here unchanged for its existing consumers.
 *
 * Read TOLERANTLY throughout, unlike the round record: this key only ever
 * locates execution metadata, so an unreadable prior entry costs the audit a
 * line and can never cost a counter or a party's answer — dropping it is
 * strictly safer than refusing a run over bookkeeping.
 */

import type { EvidenceCollectionParty } from "./review-dispute-turn.js";
import { EVIDENCE_COLLECTION_PARTIES } from "./review-dispute-turn.js";

/**
 * The task-context key holding, per party, the bounded record of that party's
 * evidence-collection invocation.
 *
 * Bookkeeping BETWEEN the two runs and the re-arbitration after them, exactly
 * like the reconsideration and rebuttal records and for the same reason: the
 * §10.1 block is the debate's durable state and has no place for "where did one
 * party's run leave its §10.2 files, and under which profile did it run". The
 * ROUND state — who has answered, with how many attachments — is #956's record
 * under its own key; this one carries the execution metadata beside it: the
 * invocation summary (#962's contract — literals, counters, and safe artifact
 * references only) and the artifact directory the run's §10.2 files live in,
 * which is what the re-presented arbitration bundle resolves the admitted
 * attachments from.
 *
 * Keyed by party and merged over what the other party recorded, because task
 * context merges shallowly: a run that wrote only its own entry under a shared
 * key would drop its counterpart's (the same shape, and the same lesson, as the
 * per-lineage reconsideration record).
 */
export const REVIEW_DISPUTE_EVIDENCE_COLLECTIONS_CONTEXT_KEY = "reviewDisputeEvidenceCollections";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The record as it stands after this party's run, with the other party's entry
 * carried forward.
 */
export function mergeEvidenceCollections(
  prior: unknown,
  party: EvidenceCollectionParty,
  entry: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  if (isRecord(prior)) {
    for (const other of EVIDENCE_COLLECTION_PARTIES) {
      if (other === party) continue;
      const value = prior[other];
      if (isRecord(value)) merged[other] = value;
    }
  }
  merged[party] = entry;
  return merged;
}

/**
 * Where one party's run left its §10.2 evidence files, read back from the
 * persisted record under {@link REVIEW_DISPUTE_EVIDENCE_COLLECTIONS_CONTEXT_KEY}.
 *
 * Tolerant like every other read of this key — `null` covers an absent record,
 * an unreadable entry, and a blank directory alike — and what `null` COSTS is
 * the caller's decision. The re-presented arbitration treats it as fail-closed
 * for a party whose round admitted attachments (issue #964 review, P1), because
 * the party's own record file is the only place the admitted references survive
 * verbatim: the context round record holds an `issue_quote` as its digest.
 */
export function readEvidenceCollectionArtifactDir(
  value: unknown,
  party: EvidenceCollectionParty,
): string | null {
  if (!isRecord(value)) return null;
  const entry = value[party];
  if (!isRecord(entry)) return null;
  const dir = entry.artifactDir;
  return typeof dir === "string" && dir !== "" ? dir : null;
}

/** One party's recorded evidence-collection directory. */
export interface EvidenceCollectionArtifactDir {
  party: EvidenceCollectionParty;
  dir: string;
}

/**
 * Every artifact directory this record names, in party order — the enumeration
 * the shared artifact-directory collector walks so a live evidence-collection
 * run directory is never mistaken for an unreferenced one.
 *
 * Owned here rather than rebuilt by the collector so the party set and the
 * tolerant read stay this module's, exactly as the per-lineage records keep
 * theirs in their own parser.
 */
export function collectEvidenceCollectionArtifactDirs(value: unknown): EvidenceCollectionArtifactDir[] {
  const dirs: EvidenceCollectionArtifactDir[] = [];
  for (const party of EVIDENCE_COLLECTION_PARTIES) {
    const dir = readEvidenceCollectionArtifactDir(value, party);
    if (dir !== null) dirs.push({ party, dir });
  }
  return dirs;
}
