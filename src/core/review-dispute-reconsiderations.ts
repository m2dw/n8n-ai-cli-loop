/**
 * Where each lineage's reviewer sub-turn left its §10.2 record, and who wrote it
 * (docs/review-dispute-contract.md §7.1, §8.2, §8.3, §10.1).
 *
 * A reviewer sub-turn answers ONE `disputed` lineage per review run, by design
 * (`nextDisputedLineage`). A task carrying two disputed findings therefore takes
 * two review runs, each writing its `reconsideration-<lineageId>.json` into its
 * OWN run directory and each resolving its own review profile. The arbitration
 * sub-turn that follows then picks the first still-`arbitration_pending` lineage
 * — which is not, in general, the lineage the LAST reviewer run answered.
 *
 * Single-valued context keys cannot express that. `reconsiderationArtifactDir`
 * and the reviewer's own invocation summary are both rewritten by every reviewer
 * run, so after two of them the arbitration turn would read the second lineage's
 * directory looking for the first lineage's record (an operational park on a
 * record that exists, one directory over) and would measure §8.3 independence
 * against the second run's reviewer (a wrong identity whenever the review lane
 * moved between the two runs) — issue #955 review, P1.
 *
 * This is the reviewer half of that record; `core/review-dispute-rebuttals.ts`
 * is the implementer half. Both are the shared shape and boundary defined by
 * `core/review-dispute-lineage-provenance.ts`, which is where what a persisted
 * entry may claim — and what is re-derived rather than believed — is decided.
 */

import type { LineageProvenanceEntry, LineageProvenanceRecord } from "./review-dispute-lineage-provenance.js";
import {
  mergeLineageProvenanceRecord,
  parseLineageProvenanceRecord,
  readLineageProvenanceEntry,
} from "./review-dispute-lineage-provenance.js";
import { canonicalizeDisputeParty } from "./review-dispute-parties.js";
import type { ReviewDisputePartyProvenance } from "./review-dispute-parties.js";

/** The task-context key holding the per-lineage reviewer-run record. */
export const REVIEW_DISPUTE_RECONSIDERATIONS_CONTEXT_FIELD = "reviewDisputeReconsiderations";

/**
 * The task-context key holding the LAST reviewer sub-turn's bounded invocation
 * summary (issue #952), re-exported by `handlers/review-reconsideration-turn.ts`
 * where the value that lives under it is built.
 *
 * Declared here rather than there so a core reader — `readReconsiderationSummaryParty`
 * below, and the operator projection of `review-dispute-status.ts` — can name the
 * key without importing a handler value, which is a direction nothing in `core`
 * takes. The two are the same string by construction, not by convention.
 */
export const REVIEW_DISPUTE_RECONSIDERATION_CONTEXT_KEY = "reviewDisputeReconsideration";

/** One lineage's reviewer sub-turn, as far as a later run needs to know it. */
export type ReconsiderationLineageEntry = LineageProvenanceEntry;

export type ReconsiderationLineageRecord = LineageProvenanceRecord;

/** Read the reviewer record back from task context. See the shared boundary. */
export function parseReconsiderationLineageRecord(value: unknown): ReconsiderationLineageRecord {
  return parseLineageProvenanceRecord(value);
}

/** The reviewer entry a lineage's arbitration may use, or `undefined`. */
export function readReconsiderationLineageEntry(
  value: unknown,
  lineageId: string,
  version: number,
): ReconsiderationLineageEntry | undefined {
  return readLineageProvenanceEntry(value, lineageId, version);
}

/**
 * The REVIEWER of a lineage, recovered from the single-valued reviewer summary
 * — but only when that summary was written for THAT lineage.
 *
 * `task.context.reviewDisputeReconsideration` is the last reviewer sub-turn's
 * own bounded invocation summary, and it is the only place a debate that
 * started before the per-lineage record existed wrote its reviewer's identity
 * down. It is therefore worth reading — but it is single-valued, so on a task
 * that disputed two findings it describes whichever lineage the LAST reviewer
 * run answered, which is not in general the lineage arbitration selects. Using
 * it unconditionally lets §8.3 measure independence against a reviewer from an
 * unrelated debate, and a review lane reconfigured between the two runs turns
 * that into an arbiter sharing the selected finding's ACTUAL reviewer provider
 * (issue #955 review, P1).
 *
 * So the summary is admitted only against the lineage it names. `version` is
 * read like {@link readReconsiderationLineageEntry}'s: a summary recorded for a
 * LATER version describes a debate this lineage has not reached (a stale or
 * altered task, since versions only move forward), while an earlier one is the
 * ordinary case — a row 11/12 revision bumps the version the arbiter rules on
 * past the one the reviewer answered.
 *
 * What survives is an agent id and nothing else, for the reason the whole party
 * boundary exists: a persisted provider or model cannot be authenticated by the
 * run that reads it back, and an unknown model can only make §8.3 stricter.
 * Anything unreadable, or naming another lineage, returns `undefined` and the
 * caller keeps its own fall-back.
 */
export function readReconsiderationSummaryParty(
  value: unknown,
  lineageId: string,
  version: number,
): ReviewDisputePartyProvenance | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const recordedLineageId = raw.lineageId;
  if (typeof recordedLineageId !== "string" || recordedLineageId !== lineageId) return undefined;
  const recorded = raw.version;
  if (typeof recorded !== "number" || !Number.isSafeInteger(recorded) || recorded < 1 || recorded > version) {
    return undefined;
  }
  return canonicalizeDisputeParty(raw.profile);
}

/** The record as it stands after one reviewer run, other lineages carried. */
export function mergeReconsiderationLineageRecord(
  value: unknown,
  lineageId: string,
  entry: ReconsiderationLineageEntry,
): ReconsiderationLineageRecord {
  return mergeLineageProvenanceRecord(value, lineageId, entry);
}
