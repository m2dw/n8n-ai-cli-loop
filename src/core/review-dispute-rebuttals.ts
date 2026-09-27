/**
 * Where each lineage's §10.2 dispute record was written, and who wrote it
 * (docs/review-dispute-contract.md §7.1, §8.2, §8.3, §10.1).
 *
 * The implementer half of `core/review-dispute-reconsiderations.ts`, on the same
 * shared shape and for the same reason (issue #955 review, P1).
 *
 * A fix run rebuts the lineages ITS response disputed, into ITS own artifact
 * directory, under ITS own resolved agent — and the protocol can advance
 * different lineages through different implementation runs. A row 11 material
 * revision sends one lineage back to the implementer at a new §2.1 version while
 * another stays `disputed`, so the two rebuttals land in two directories, minted
 * by two runs that need not share an agent assignment. Both can then be
 * arbitration-pending at once, and arbitration answers ONE of them.
 *
 * The two single-valued keys that carried this — `disputeArtifactDir` and
 * `reviewDisputeParties.implementation` — describe only the LAST fix run, so
 * without a per-lineage record the earlier lineage's turn reads its rebuttal from
 * the later run's directory (a missing or identity-mismatched artifact that parks
 * a resolvable dispute) and §8.3 measures arbiter independence against the other
 * lineage's implementer (which can reject a valid arbiter, or select one sharing
 * this lineage's actual provider).
 *
 * Written by the fix run only when a `dispute-<lineageId>.json` was really
 * written for that lineage: a run that recorded nothing is not a party to
 * anything, and it leaves an earlier fix run's entry in place for a debate that
 * is still open.
 */

import type { LineageProvenanceEntry, LineageProvenanceRecord } from "./review-dispute-lineage-provenance.js";
import {
  mergeLineageProvenanceRecord,
  parseLineageProvenanceRecord,
  readLineageProvenanceEntry,
} from "./review-dispute-lineage-provenance.js";

/** The task-context key holding the per-lineage fix-run record. */
export const REVIEW_DISPUTE_REBUTTALS_CONTEXT_FIELD = "reviewDisputeRebuttals";

/** One lineage's fix run, as far as a later sub-turn needs to know it. */
export type RebuttalLineageEntry = LineageProvenanceEntry;

export type RebuttalLineageRecord = LineageProvenanceRecord;

/** Read the fix-run record back from task context. See the shared boundary. */
export function parseRebuttalLineageRecord(value: unknown): RebuttalLineageRecord {
  return parseLineageProvenanceRecord(value);
}

/**
 * The fix-run entry a lineage's reviewer or arbitration turn may use.
 *
 * `version` is the lineage's CURRENT version, and both readers of the dispute
 * record require the artifact to name exactly that version: an entry recorded for
 * a later one cannot describe this debate, and the shared boundary drops it so
 * the caller stays on its single-valued fall-back.
 */
export function readRebuttalLineageEntry(
  value: unknown,
  lineageId: string,
  version: number,
): RebuttalLineageEntry | undefined {
  return readLineageProvenanceEntry(value, lineageId, version);
}

/** The record as it stands after one fix run, other lineages carried. */
export function mergeRebuttalLineageRecord(
  value: unknown,
  lineageId: string,
  entry: RebuttalLineageEntry,
): RebuttalLineageRecord {
  return mergeLineageProvenanceRecord(value, lineageId, entry);
}
