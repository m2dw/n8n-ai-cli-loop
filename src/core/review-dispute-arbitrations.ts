/**
 * Where each lineage's §8.1 verdict record was written (issue #964;
 * docs/review-dispute-contract.md §7.1, §10.1, §10.2).
 *
 * The arbitration third of `core/review-dispute-rebuttals.ts` and
 * `core/review-dispute-reconsiderations.ts`, on the same shared shape and for
 * the same reason: an arbitration sub-turn answers ONE lineage per review run,
 * writing `arbitration-<lineageId>.json` — the admitted verdict record, §8.1's
 * `rationale` included — into its OWN run directory. The §7.1 evidence turn that
 * a row-16 `insufficient_evidence` verdict opens then re-presents that record to
 * both parties (#957's bundle carries "the `insufficient_evidence` verdict
 * record"), and it is one or more phase runs behind the arbitration that wrote
 * it, so the plain `artifactDir` context key has long since been rewritten by
 * runs that never held it.
 *
 * Single-valued context keys cannot carry this for the same reason they could
 * not carry the rebuttal or the reconsideration (issue #955 review, P1): a task
 * with two debates arbitrates them in two runs, and the evidence turn covers
 * every lineage in `evidence_requested` at once — each lineage's verdict must be
 * read from the directory of the run that MINTED it.
 *
 * The entry is a locator, never an authority: the record it points at is
 * re-validated on every read (`handlers/review-evidence-turn.ts` re-reads the
 * artifact under the shared bound, re-checks the verdict token and the identity
 * it names against the CURRENT block), so a stale or tampered entry costs a
 * park, never a debate decided on someone else's verdict. An absent entry is the
 * pre-#964 state and fails the evidence turn closed exactly as the missing
 * dispatcher used to — a debate whose verdict record cannot be located goes to a
 * human, not to a guessed directory.
 */

import type { LineageProvenanceEntry, LineageProvenanceRecord } from "./review-dispute-lineage-provenance.js";
import {
  mergeLineageProvenanceRecord,
  parseLineageProvenanceRecord,
  readLineageProvenanceEntry,
} from "./review-dispute-lineage-provenance.js";

/** The task-context key holding the per-lineage arbitration-run record. */
export const REVIEW_DISPUTE_ARBITRATIONS_CONTEXT_FIELD = "reviewDisputeArbitrations";

/** One lineage's arbitration run, as far as a later sub-turn needs to know it. */
export type ArbitrationLineageEntry = LineageProvenanceEntry;

export type ArbitrationLineageRecord = LineageProvenanceRecord;

/** Read the arbitration record back from task context. See the shared boundary. */
export function parseArbitrationLineageRecord(value: unknown): ArbitrationLineageRecord {
  return parseLineageProvenanceRecord(value);
}

/** The arbitration entry a lineage's evidence turn may use, or `undefined`. */
export function readArbitrationLineageEntry(
  value: unknown,
  lineageId: string,
  version: number,
): ArbitrationLineageEntry | undefined {
  return readLineageProvenanceEntry(value, lineageId, version);
}

/** The record as it stands after one arbitration run, other lineages carried. */
export function mergeArbitrationLineageRecord(
  value: unknown,
  lineageId: string,
  entry: ArbitrationLineageEntry,
): ArbitrationLineageRecord {
  return mergeLineageProvenanceRecord(value, lineageId, entry);
}
