/**
 * Per-lineage bookkeeping about the RUN that produced one half of a debate
 * (docs/review-dispute-contract.md §7.1, §8.2, §8.3, §10.1).
 *
 * Two sub-turns each answer ONE lineage per phase run: the fix run rebuts the
 * lineages it disputes into its own directory, and the reviewer sub-turn answers
 * a single `disputed` lineage per review run. The arbitration sub-turn that
 * follows selects the first still-`arbitration_pending` lineage — which is not,
 * in general, the lineage the LAST run of either kind answered.
 *
 * Single-valued context keys cannot express that. `disputeArtifactDir`,
 * `reconsiderationArtifactDir`, and each party's recorded identity are all
 * rewritten by every later run of their kind, so after two of them a turn would
 * read the second lineage's directory looking for the first lineage's record (an
 * operational park on a record that exists, one directory over) and would measure
 * §8.3 independence against the second run's agent (a wrong identity whenever the
 * lane moved between the two runs) — issue #955 review, P1.
 *
 * So both values are recorded per lineage, in exactly the shape #955's
 * applied-row record uses and for the same reason: this is bookkeeping BETWEEN
 * runs, and §10.1 — the debate's durable state — has no place for "which
 * directory holds the record" or "which agent wrote it".
 *
 * This module is the shape and the boundary; the two context keys that use it
 * (`core/review-dispute-reconsiderations.ts` for the reviewer half,
 * `core/review-dispute-rebuttals.ts` for the implementer half) are thin named
 * wrappers over it, so a change to how these records are believed lands on both
 * halves at once.
 *
 * Everything read back is untrusted, and the two fields fail closed differently:
 *
 *  - `artifactDir` is a path the invocation re-checks against the session's
 *    artifact root before it reads anything (`review-arbitration.ts` step 3), so
 *    a crafted directory becomes an `unsafe-artifact-dir` failure rather than a
 *    read outside the session. What this module enforces is only that the value
 *    is a bounded, non-empty string — an empty one would turn the record read
 *    into a relative-path read of the process's working directory;
 *  - `agentId` passes {@link canonicalizeDisputeParty}, so the recorded provider
 *    and model are dropped rather than believed and an id outside this runner's
 *    closed tuple names no party at all. An unknown model can only make §8.3
 *    stricter (see `core/review-dispute-parties.ts`).
 */

import { canonicalizeDisputeParty } from "./review-dispute-parties.js";
import { MAX_LINEAGES_PER_TASK } from "./review-dispute.js";

/**
 * Longest artifact directory these keys will carry.
 *
 * Generous next to any real `<artifactRoot>/runs/<run-id>` and still a bound:
 * task context is a §10.1 budget these keys share, and a path longer than this is
 * not a directory this runner created.
 */
const MAX_ARTIFACT_DIR_CHARS = 1024;

/**
 * Longest execution-posture literal this record will carry.
 *
 * The values that reach it are closed vocabularies minted by this runner
 * (`no-tools`, `read-bounded`, `tool-capable`), so anything near this length is
 * not one of them — and the field is carried VERBATIM rather than mapped onto
 * today's set, so the bound is what keeps an unrecognised value from growing the
 * §10.1 context budget.
 */
const MAX_TOOL_POLICY_CHARS = 64;

/** One lineage's run, as far as a later sub-turn needs to know it. */
export interface LineageProvenanceEntry {
  /** The §2.1 version the run answered; the record it wrote names it too. */
  version: number;
  /** That run's own directory, holding its `<kind>-<lineageId>.json` record. */
  artifactDir: string;
  /** The agent that ran it. Absent when the invocation resolved no profile. */
  agentId?: string;
  /**
   * The execution posture that run ENFORCED, verbatim (issue #1085; contract
   * §17.6 D2, §17.16).
   *
   * Per lineage because the posture is per RUN and a task may debate two
   * findings: the single-valued reviewer summary describes whichever lineage the
   * LAST reviewer run answered, so on a two-lineage task it overwrites the
   * earlier lineage's posture and D2's "a lineage decided under it stays
   * distinguishable, forever" would hold only for the newest one (issue #1085
   * review, P2).
   *
   * Absent means the run recorded no posture — a debate that predates this
   * field, or a run that resolved no profile. It is never DEFAULTED on read:
   * supplying `no-tools` for a record that does not state it is exactly the
   * misreading the separate literal exists to prevent. Only the reviewer half
   * writes it today; the rebuttal half leaves it absent, which reads the same
   * way.
   */
  toolPolicy?: string;
}

export interface LineageProvenanceRecord {
  lineages: Record<string, LineageProvenanceEntry>;
}

function emptyRecord(): LineageProvenanceRecord {
  // Null-prototype for the reason #840's `copyLineages` uses one: lineage ids are
  // runner-minted, but on a plain object a prototype key would set the prototype
  // instead of adding an entry.
  return { lineages: Object.create(null) as Record<string, LineageProvenanceEntry> };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * One entry, normalized, or `null` for anything this module could not have
 * written. Used on the way IN as well as on the way out: an entry a run records
 * about itself passes exactly the checks a persisted one does, so the key can
 * never hold a shape its own reader would drop.
 */
function normalizeEntry(raw: unknown): LineageProvenanceEntry | null {
  if (!isRecord(raw)) return null;
  const version = raw.version;
  if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1) return null;
  const artifactDir = raw.artifactDir;
  if (typeof artifactDir !== "string" || artifactDir.trim() === "" || artifactDir.length > MAX_ARTIFACT_DIR_CHARS) {
    return null;
  }
  // The party boundary reads `agentId`/`provider`/`model` off whatever record it
  // is handed and keeps only a recognised id, which is exactly the projection
  // wanted here — the other fields of this entry are not party fields and are
  // ignored by it.
  const party = canonicalizeDisputeParty(raw);
  // Fail-soft and never defaulted, like `agentId`: a posture that is not a
  // bounded non-empty string is DROPPED, so the reader reports "no posture on
  // record" rather than inventing one. Kept verbatim — this module does not know
  // the closed set, and normalizing an unrecognised literal onto a known one is
  // how a `read-bounded` lineage would come to read as `no-tools`.
  const rawToolPolicy = raw.toolPolicy;
  const toolPolicy =
    typeof rawToolPolicy === "string" && rawToolPolicy.trim() !== "" && rawToolPolicy.length <= MAX_TOOL_POLICY_CHARS
      ? rawToolPolicy
      : undefined;
  return {
    version,
    artifactDir,
    ...(party === undefined ? {} : { agentId: party.agentId }),
    ...(toolPolicy === undefined ? {} : { toolPolicy }),
  };
}

/**
 * Read the per-lineage record back from task context, dropping anything this
 * module could not have written.
 *
 * Fail-SOFT per entry, like #955's applied-row record: a dropped entry costs the
 * fall-back the caller already has (the single-valued keys, or its own resolved
 * profile), never a counter and never a transition. Refusing the whole key over
 * one malformed entry would park a debate on bookkeeping.
 */
export function parseLineageProvenanceRecord(value: unknown): LineageProvenanceRecord {
  const state = emptyRecord();
  if (!isRecord(value) || !isRecord(value.lineages)) return state;
  for (const [lineageId, raw] of Object.entries(value.lineages)) {
    if (Object.keys(state.lineages).length >= MAX_LINEAGES_PER_TASK) break;
    const entry = normalizeEntry(raw);
    if (entry === null) continue;
    state.lineages[lineageId] = entry;
  }
  return state;
}

/**
 * The entry a lineage's later sub-turn may use, or `undefined`.
 *
 * `version` is the lineage's CURRENT §2.1 version. An entry recorded for a LATER
 * version describes a debate this lineage has not reached — a stale or altered
 * task, since a version only ever moves forward — and #846 refuses such a record
 * as an identity mismatch anyway; dropping it here keeps the caller on its
 * fall-back instead of pointing the bundle at a directory it will then refuse.
 * An entry recorded for an EARLIER version is the ordinary case for the reviewer
 * half: a row 11/12 revision bumps the version the arbiter rules on past the one
 * the reviewer answered.
 */
export function readLineageProvenanceEntry(
  value: unknown,
  lineageId: string,
  version: number,
): LineageProvenanceEntry | undefined {
  const record = parseLineageProvenanceRecord(value);
  const entry = Object.prototype.hasOwnProperty.call(record.lineages, lineageId)
    ? record.lineages[lineageId]
    : undefined;
  if (entry === undefined || entry.version > version) return undefined;
  return entry;
}

/**
 * The record as it stands after one run recorded ITS lineage, with the other
 * lineages' own entries carried forward.
 *
 * Task context merges SHALLOWLY, so a run returning only its own entry would
 * replace the whole key and drop every other lineage's — which is precisely the
 * loss this key exists to prevent (issue #955 review, P1).
 *
 * Bounded at {@link MAX_LINEAGES_PER_TASK}, the same cap the §10.1 block itself
 * carries: entries past it can only name lineages the block no longer has, so the
 * oldest carried-forward ones give way and THIS run's entry is always kept —
 * dropping the entry a run just wrote would reintroduce the very gap it closes.
 */
export function mergeLineageProvenanceRecord(
  value: unknown,
  lineageId: string,
  entry: LineageProvenanceEntry,
): LineageProvenanceRecord {
  const normalized = normalizeEntry(entry);
  const carried = parseLineageProvenanceRecord(value);
  const next = emptyRecord();
  if (normalized === null) {
    for (const [id, existing] of Object.entries(carried.lineages)) next.lineages[id] = existing;
    return next;
  }
  const room = MAX_LINEAGES_PER_TASK - 1;
  for (const [id, existing] of Object.entries(carried.lineages)) {
    if (id === lineageId) continue;
    if (Object.keys(next.lineages).length >= room) break;
    next.lineages[id] = existing;
  }
  next.lineages[lineageId] = normalized;
  return next;
}
