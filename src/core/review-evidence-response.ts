/**
 * Issue #957: admit one party's answer to the §7.1 evidence-collection prompt
 * (docs/review-dispute-contract.md §3.3, §7.1, §7 row 22, §12).
 *
 * The response half of `review-evidence-prompt.ts`. It consumes exactly the
 * contract that prompt states — a single fenced JSON array of
 * `{ lineageId, evidenceRefs }` records — and turns it into the three per-lineage
 * maps #955's `collected` sub-turn result carries: what was admitted, what was
 * admitted in detail, and how much was dropped.
 *
 * Pure and side-effect-free: every check is a transform over already-validated
 * #836 types plus an injected read-only evidence resolver. It admits or drops; it
 * persists nothing, dispatches nothing, and selects no transition. Recording the
 * round and firing row 22 are #956's and #840's.
 *
 * ## Why this parser fails DIFFERENTLY from every other one in the protocol
 *
 * A disposition, a reconsideration, and a verdict each MOVE a lineage, so §12
 * holds them to "malformed input changes nothing": an ambiguous answer is
 * rejected whole, because applying half of it would move a lineage on a record
 * nobody can read. An evidence attachment moves nothing. §7.1 is explicit about
 * both halves of that:
 *
 *  - "Anything else in the output — argument prose, dispositions, new findings —
 *    is ignored and logged." So a field outside the two-field schema does not
 *    make the record malformed; it is dropped, counted, and named in the audit.
 *    A record cannot mutate a finding, a disposition, a verdict, or a lineage
 *    state, because the only thing this module reads out of one is a list of
 *    §3.3 references.
 *  - "Each returned reference is resolved read-only under §3.3; an unresolvable
 *    reference is dropped and logged, never a run failure." So an unresolvable —
 *    or invalid, or duplicated, or over-limit — reference costs its own slot and
 *    nothing else.
 *
 * Fail-closed still applies where it can actually decide something: a record
 * naming a lineage this run did not ask about, a lineage that is not in
 * `evidence_requested`, a lineage whose §6.1 evidence budget is already spent, or
 * the same lineage twice is REJECTED rather than admitted against whatever it
 * happens to match. Row 22 admits the round's own attachments; an unrelated
 * lineage must never acquire evidence through this door.
 *
 * And an unreadable envelope is not a run failure either: §7 row 22 fires on
 * "evidence attachments recorded (or the round's runs complete with none)", so a
 * prose-only reply, two arrays, or an oversized fence yields an outcome that
 * admits nothing and names the reason in {@link EvidenceCollectionOutcome.envelopeFailure}.
 * The caller decides whether that is a completed party run with zero attachments
 * or a retry; what it cannot be is a lineage moved on an answer nobody read.
 */
import {
  MAX_LINEAGES_PER_TASK,
  REVIEW_DISPUTE_DEFAULT_LIMITS,
  REVIEW_DISPUTE_RECORD_MAX_BYTES,
  type EvidenceRef,
  type PersistedLineage,
  type ReviewDisputeLimits,
} from "./review-dispute.js";
import {
  validateEvidenceRef,
  type EvidenceRefResolver,
  type ReviewDisputeFailure,
  type ReviewDisputeFailureReason,
} from "./review-dispute-validation.js";
import {
  MAX_EVIDENCE_ATTACHMENTS_PER_PARTY,
  MAX_EVIDENCE_DROPPED_PER_PARTY,
  persistedEvidenceRefDigest,
  toPersistedEvidenceRef,
} from "./review-dispute-evidence-state.js";
import type { EvidenceCollectionParty } from "./review-dispute-turn.js";

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/**
 * How many attachment records one response may carry.
 *
 * One per lineage the turn covers, and a turn covers at most the task's lineages
 * (§10.1's `MAX_LINEAGES_PER_TASK`). A longer array is not a longer answer to
 * this question — it is an answer to a different one — so it fails the envelope
 * rather than being read to the bound.
 */
export const MAX_EVIDENCE_ATTACHMENT_RECORDS = MAX_LINEAGES_PER_TASK;

/**
 * How many references one record is examined for.
 *
 * Deliberately larger than {@link MAX_EVIDENCE_ATTACHMENTS_PER_PARTY}: a party
 * that returns twelve good references for a ten-slot lineage should have ten
 * admitted and two dropped, not the whole record refused. Past this bound the
 * entries are not read at all — they are counted as dropped and never validated,
 * so an enormous list costs a length check rather than a thousand resolutions.
 */
export const MAX_EVIDENCE_REFS_EXAMINED_PER_RECORD = 40;

/** The two fields §7 row 22 admits. Everything else is ignored and logged. */
export const EVIDENCE_ATTACHMENT_FIELDS: readonly string[] = ["lineageId", "evidenceRefs"];

// ---------------------------------------------------------------------------
// Extracting the response's attachment block
// ---------------------------------------------------------------------------

/**
 * The fenced block the prompt asks for: ```` ```json ```` on its own line, then
 * the JSON array, then a closing fence ON ITS OWN LINE. Built fresh per call — a
 * module-level global regex carries `lastIndex` between calls and would make this
 * module's answer depend on how often it had been asked before.
 *
 * The closing fence is anchored to a line of its own for the reason #838 anchors
 * its own: a value inside the block may legitimately contain a triple backtick (a
 * `doc_section` heading, an Issue quote), and a delimiter that accepted any
 * triple backtick would cut the record off mid-string. JSON escapes every newline
 * inside a string, so a fence appearing in a value always shares its line with at
 * least the quote that opens or closes that string.
 */
function evidenceBlockPattern(): RegExp {
  return /```[ \t]*json[ \t]*\r?\n([\s\S]*?)^[ \t]*```[ \t]*(?=\r?\n|$)/gim;
}

export type EvidenceBlockExtraction =
  | { ok: true; records: unknown[] }
  | { ok: false; failure: ReviewDisputeFailure };

/**
 * Extract the single JSON array of attachment records.
 *
 * The ambiguity rules are #843's, because the ambiguities are the same ones:
 *
 *  - no fenced `json` block at all (a prose-only reply, a bare "I have nothing to
 *    add", an empty response) is `unparseable`. Prose cannot be matched back to a
 *    lineage — and note that "I have nothing to add" and an empty array reach the
 *    same place through {@link parseEvidenceCollectionResponse}: nothing admitted;
 *  - a `json` fence this function cannot read AT ALL — invalid JSON, or a body
 *    past the #836 byte bound — is fatal for the whole envelope even when another
 *    fence carries a clean array. Such a fence may well BE the answer, and
 *    skipping it to accept a neighbour would silently choose between two
 *    candidate sets;
 *  - TWO array blocks are `too-many-items`. The prompt asks for exactly one.
 *
 * Readable NON-array blocks (an object, a string, a number) are ignored rather
 * than fatal: a party may legitimately quote a JSON object from the code it is
 * citing, and such a block is recognizably not an attachment set.
 */
export function extractEvidenceAttachmentRecords(response: string): EvidenceBlockExtraction {
  const pattern = evidenceBlockPattern();
  const arrays: unknown[][] = [];
  let blocks = 0;
  // The first unreadable fence, kept rather than counted: it fails the whole
  // envelope, so what matters is which one and why, not how many.
  let unreadable: ReviewDisputeFailure | null = null;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(response)) !== null) {
    blocks++;
    const body = match[1]!;
    // Measured in UTF-8 bytes like every other #836 bound: `body.length` counts
    // UTF-16 code units, so a block of non-ASCII prose would clear a byte limit
    // it exceeds by up to 3x.
    if (Buffer.byteLength(body, "utf8") > REVIEW_DISPUTE_RECORD_MAX_BYTES) {
      unreadable ??= { reason: "payload-too-large", detail: "evidence-block" };
      continue;
    }
    let data: unknown;
    try {
      data = JSON.parse(body);
    } catch {
      // The fence index is the only locator an unparseable body has, and it
      // carries none of the body's content.
      unreadable ??= { reason: "unparseable", detail: `evidence-block:${blocks}:invalid-json` };
      continue;
    }
    if (Array.isArray(data)) arrays.push(data);
  }

  if (unreadable !== null) return { ok: false, failure: unreadable };
  if (arrays.length > 1) {
    return { ok: false, failure: { reason: "too-many-items", detail: `evidence-blocks:${arrays.length}` } };
  }
  if (arrays.length === 1) {
    const records = arrays[0]!;
    if (records.length > MAX_EVIDENCE_ATTACHMENT_RECORDS) {
      return { ok: false, failure: { reason: "too-many-items", detail: `evidence-records:${records.length}` } };
    }
    return { ok: true, records };
  }
  return {
    ok: false,
    failure: {
      reason: "unparseable",
      detail: blocks === 0 ? "response:no-evidence-block" : "response:no-evidence-array",
    },
  };
}

// ---------------------------------------------------------------------------
// The audit vocabulary (§7.1: "ignored and logged")
// ---------------------------------------------------------------------------

/**
 * What kind of thing an ignored field was trying to be.
 *
 * A closed vocabulary, because it is logged: §10.3 admits literals only, and the
 * question an auditor asks of this list is not "what did the agent write" but
 * "did a party try to argue, decide, or re-open something through the evidence
 * door". The four named classes are exactly §7.1's examples plus the lineage
 * state the round cannot move; everything else is `unrelated`.
 */
export const EVIDENCE_IGNORED_CONTENT_CATEGORIES = [
  "argument",
  "disposition",
  "finding",
  "verdict",
  "lineage_state",
  "unrelated",
] as const;
export type EvidenceIgnoredContentCategory = (typeof EVIDENCE_IGNORED_CONTENT_CATEGORIES)[number];

const IGNORED_FIELD_CATEGORIES: Readonly<Record<string, EvidenceIgnoredContentCategory>> = {
  argument: "argument",
  rationale: "argument",
  reasoning: "argument",
  explanation: "argument",
  note: "argument",
  comment: "argument",
  whyNoChange: "argument",
  testEvidence: "argument",
  disposition: "disposition",
  dispute: "disposition",
  rebuttalReason: "disposition",
  challenged: "disposition",
  reconsideration: "disposition",
  revision: "finding",
  successor: "finding",
  finding: "finding",
  findings: "finding",
  newFinding: "finding",
  severity: "finding",
  violatedContract: "finding",
  preconditions: "finding",
  failureScenario: "finding",
  affectedBoundary: "finding",
  requiredOutcome: "finding",
  humanGate: "finding",
  verdict: "verdict",
  confidence: "verdict",
  arbitration: "verdict",
  state: "lineage_state",
  lineageState: "lineage_state",
  nextState: "lineage_state",
  transition: "lineage_state",
  resolved: "lineage_state",
};

/** Classify one ignored field name. Names only — never the value. */
export function classifyIgnoredEvidenceField(field: string): EvidenceIgnoredContentCategory {
  return Object.prototype.hasOwnProperty.call(IGNORED_FIELD_CATEGORIES, field)
    ? IGNORED_FIELD_CATEGORIES[field]!
    : "unrelated";
}

/** One field the response carried that this module ignored (§7.1). */
export interface IgnoredEvidenceContent {
  /** Position in the response array — the only locator an ignored field has. */
  index: number;
  /** The lineage the record named, when it named a structurally valid one. */
  lineageId: string | null;
  /** The field NAME. Never its value: §10.3 keeps evidence content out of events. */
  field: string;
  category: EvidenceIgnoredContentCategory;
}

/** One record the response carried that could not be admitted at all (§12). */
export interface RejectedEvidenceAttachment {
  index: number;
  lineageId: string | null;
  failure: ReviewDisputeFailure;
}

/** Why one returned reference did not become an attachment. */
export const EVIDENCE_DROP_REASONS = [
  /** Not a §3.3 reference at all: wrong shape, absolute path, `..` escape. */
  "invalid-ref",
  /** A well-formed reference that does not resolve read-only in this checkout. */
  "unresolvable",
  /** The same reference twice in one lineage's list. */
  "duplicate",
  /** Past {@link MAX_EVIDENCE_ATTACHMENTS_PER_PARTY} for this lineage. */
  "over-limit",
] as const;
export type EvidenceDropReason = (typeof EVIDENCE_DROP_REASONS)[number];

/** One dropped reference, located by position and named by reason only. */
export interface DroppedEvidenceRef {
  lineageId: string;
  /** Position within the record's `evidenceRefs`, or null past the examine bound. */
  refIndex: number | null;
  reason: EvidenceDropReason;
  /** The §836 failure locator for an `invalid-ref`; null otherwise. */
  detail: string | null;
}

// ---------------------------------------------------------------------------
// Input and outcome
// ---------------------------------------------------------------------------

export interface EvidenceCollectionResponseInput {
  /** The party agent's final response text. */
  response: string;
  /** Which of §7.1's two runs this is. */
  party: EvidenceCollectionParty;
  /**
   * The lineages this run's prompt asked about
   * (`EvidencePromptSection.askedLineageIds`). Authoritative: row 22 records the
   * round's own attachments, so a record for a lineage outside this set is out of
   * contract even when that lineage exists and is itself in `evidence_requested`.
   */
  askedLineageIds: readonly string[];
  /** The §10.1 persisted lineages of `task.context.reviewDispute`. */
  lineages: Readonly<Record<string, PersistedLineage>>;
  /**
   * §3.3: read-only resolution against the tracked checkout, under the same
   * posture the finding and the dispute were held to. Injected because resolution
   * needs I/O; what belongs here is only the rule that an unresolved reference is
   * not admitted.
   */
  resolveEvidenceRef: EvidenceRefResolver;
  /** The session's resolved §6.1 limits. */
  limits?: ReviewDisputeLimits;
}

/** Literals and counters only — safe to persist in task context (§10.1). */
export interface EvidenceCollectionSummary {
  party: EvidenceCollectionParty;
  /** How many lineages the run was asked about. */
  asked: number;
  /** How many of them this response answered with an admissible record. */
  answered: number;
  /** Total §3.3 references admitted across every lineage. */
  admitted: number;
  /** Total references returned and not admitted, for any reason. */
  dropped: number;
  /** How many out-of-schema fields were ignored (§7.1). */
  ignoredFields: number;
  /** How many records could not be admitted at all (§12). */
  rejectedRecords: number;
  /** Asked lineages this response carried no admissible record for. */
  unansweredLineageIds: string[];
  /** The envelope-level failure, when the response could not be read at all. */
  failure: { reason: ReviewDisputeFailureReason; detail: string | null } | null;
}

export interface EvidenceCollectionOutcome {
  party: EvidenceCollectionParty;
  /**
   * How many §3.3 attachments were admitted, per lineage — exactly the map
   * #955's `collected` sub-turn result carries. A lineage this response did not
   * answer is ABSENT rather than zero: §7.1 lets a run complete with none, and
   * "answered with nothing" and "did not answer" are both zero attachments but
   * are not the same audit fact.
   */
  attachments: Readonly<Record<string, number>>;
  /**
   * The admitted references themselves, per lineage. Present for exactly the
   * lineages `attachments` names, with exactly that many entries — the two halves
   * of one answer may not disagree (#956).
   */
  references: Readonly<Record<string, EvidenceRef[]>>;
  /** §7.1: how many returned references were dropped, per lineage. */
  dropped: Readonly<Record<string, number>>;
  /** Every ignored out-of-schema field, in response order (§7.1: "and logged"). */
  ignored: readonly IgnoredEvidenceContent[];
  /** Every record that could not be admitted, in response order. */
  rejected: readonly RejectedEvidenceAttachment[];
  /** Every dropped reference, in response order. */
  droppedRefs: readonly DroppedEvidenceRef[];
  /**
   * Why the response could not be read as an attachment set, or null.
   *
   * Advisory, not a run failure: §7 row 22 fires when "the round's runs complete
   * with none", so a caller may record this party as completed with zero
   * attachments. It is reported so the reason survives into the audit rather than
   * looking like a party that had nothing to add.
   */
  envelopeFailure: ReviewDisputeFailure | null;
  summary: EvidenceCollectionSummary;
}

/*
 * The three maps above ARE the seam between admission (here) and persistence
 * (#956's `completeEvidencePartyRun`, through #955's `collected` sub-turn
 * result): per-lineage counts, the references behind those counts, and the drop
 * tally. They are deliberately restated rather than imported from
 * `review-dispute-dispatch.ts`: #952's route pin keeps that module's importer set
 * closed to the three handlers that dispatch or borrow its tables, and a
 * type-only edge from core would widen that set for a check the wiring issue can
 * make where the two shapes actually meet.
 */

// ---------------------------------------------------------------------------
// Admission
// ---------------------------------------------------------------------------

/** Own-property lookup: an inherited `Object.prototype` member names no lineage. */
function ownLineage(
  lineages: Readonly<Record<string, PersistedLineage>>,
  lineageId: string,
): PersistedLineage | undefined {
  return Object.prototype.hasOwnProperty.call(lineages, lineageId) ? lineages[lineageId] : undefined;
}

/**
 * §6.1: has this lineage already spent its evidence round?
 *
 * `evidenceRoundsUsed` is incremented by row 22 — the CLOSE of the round, not
 * row 16's request — so a lineage legitimately awaiting this run still reads
 * below the limit. A lineage at or past it has had its round recorded, and a
 * second collection would widen a bundle the protocol already closed.
 */
function evidenceRoundConsumed(lineage: PersistedLineage, limits: ReviewDisputeLimits): boolean {
  return lineage.counters.evidenceRoundsUsed >= limits.maxEvidenceRoundsPerLineage;
}

interface AdmittedRefs {
  references: EvidenceRef[];
  dropped: DroppedEvidenceRef[];
}

/**
 * Resolve one record's references and keep the ones §3.3 admits.
 *
 * Every drop is per-reference and per-reason: an invalid shape, a reference that
 * does not resolve read-only in this checkout, the same reference twice, and one
 * past the per-lineage ceiling each cost their own slot and nothing else. §7.1:
 * "an unresolvable reference is dropped and logged, never a run failure".
 */
function admitRefs(
  raw: unknown,
  lineageId: string,
  resolve: EvidenceRefResolver,
): AdmittedRefs {
  const references: EvidenceRef[] = [];
  const dropped: DroppedEvidenceRef[] = [];
  const items = raw as unknown[];
  const seen = new Set<string>();
  const examined = Math.min(items.length, MAX_EVIDENCE_REFS_EXAMINED_PER_RECORD);
  for (let i = 0; i < examined; i++) {
    const validated = validateEvidenceRef(items[i], `evidenceRefs[${i}]`);
    if (!validated.ok) {
      dropped.push({ lineageId, refIndex: i, reason: "invalid-ref", detail: validated.failure.detail });
      continue;
    }
    const ref = validated.value;
    // Identity before resolution: a duplicate costs no I/O, and its drop reason
    // is what it is regardless of whether the reference resolves.
    const identity = persistedEvidenceRefDigest(toPersistedEvidenceRef(ref));
    if (seen.has(identity)) {
      dropped.push({ lineageId, refIndex: i, reason: "duplicate", detail: null });
      continue;
    }
    if (!resolve(ref)) {
      dropped.push({ lineageId, refIndex: i, reason: "unresolvable", detail: null });
      continue;
    }
    if (references.length >= MAX_EVIDENCE_ATTACHMENTS_PER_PARTY) {
      dropped.push({ lineageId, refIndex: i, reason: "over-limit", detail: null });
      continue;
    }
    seen.add(identity);
    references.push(ref);
  }
  for (let i = examined; i < items.length; i++) {
    // Past the examine bound: counted, never read. `refIndex` is null because the
    // entry was not looked at, and reporting a position for it would suggest it
    // was.
    dropped.push({ lineageId, refIndex: null, reason: "over-limit", detail: null });
  }
  return { references, dropped };
}

/**
 * Parse and admit one party's evidence-collection response.
 *
 * Never throws, and never fails the run: the worst outcome is "nothing was
 * admitted, and here is why", which is what §7 row 22's "(or the round's runs
 * complete with none)" is written to accept.
 *
 * Per-record check order is the diagnostic order:
 *
 *  1. the record is an object (an array or a scalar names no lineage);
 *  2. `lineageId` is a string this run ASKED about — before any lineage state is
 *     read, because a record for another lineage must never be judged against a
 *     lineage of this round;
 *  3. it is the first record for that lineage;
 *  4. the lineage exists, is in `evidence_requested`, and its §6.1 evidence
 *     budget is unspent;
 *  5. out-of-schema fields are ignored and logged, never fatal (§7.1);
 *  6. `evidenceRefs` is a list, and each entry is validated, de-duplicated, and
 *     resolved read-only (§3.3).
 */
export function parseEvidenceCollectionResponse(
  input: EvidenceCollectionResponseInput,
): EvidenceCollectionOutcome {
  const limits = input.limits ?? REVIEW_DISPUTE_DEFAULT_LIMITS;
  // Null-prototype maps: lineage ids are runner-minted, but on a plain object a
  // prototype key would set the prototype instead of adding an entry.
  const attachments = Object.create(null) as Record<string, number>;
  const references = Object.create(null) as Record<string, EvidenceRef[]>;
  const dropped = Object.create(null) as Record<string, number>;
  const ignored: IgnoredEvidenceContent[] = [];
  const rejected: RejectedEvidenceAttachment[] = [];
  const droppedRefs: DroppedEvidenceRef[] = [];
  const asked = new Set(input.askedLineageIds);

  const finish = (envelopeFailure: ReviewDisputeFailure | null): EvidenceCollectionOutcome => {
    const answered = Object.keys(attachments);
    const admitted = answered.reduce((total, id) => total + attachments[id]!, 0);
    return {
      party: input.party,
      attachments,
      references,
      dropped,
      ignored,
      rejected,
      droppedRefs,
      envelopeFailure,
      summary: {
        party: input.party,
        asked: asked.size,
        answered: answered.length,
        admitted,
        dropped: droppedRefs.length,
        ignoredFields: ignored.length,
        rejectedRecords: rejected.length,
        // Render order, not insertion order: the audit line reads the same for
        // two runs that answered the same lineages in a different sequence.
        unansweredLineageIds: input.askedLineageIds.filter(
          (id) => !Object.prototype.hasOwnProperty.call(attachments, id),
        ),
        failure: envelopeFailure
          ? { reason: envelopeFailure.reason, detail: envelopeFailure.detail }
          : null,
      },
    };
  };

  const extraction = extractEvidenceAttachmentRecords(input.response);
  if (!extraction.ok) return finish(extraction.failure);

  for (const [index, raw] of extraction.records.entries()) {
    const reject = (failure: ReviewDisputeFailure, lineageId: string | null = null): void => {
      rejected.push({ index, lineageId, failure });
    };
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      reject({ reason: "not-an-object", detail: `evidence[${index}]` });
      continue;
    }
    const record = raw as Record<string, unknown>;
    const lineageId = record["lineageId"];
    if (typeof lineageId !== "string") {
      reject({ reason: "invalid-type", detail: `evidence[${index}].lineageId` });
      continue;
    }
    if (!asked.has(lineageId)) {
      reject({ reason: "unknown-lineage", detail: `evidence[${index}].lineageId:not-requested` }, lineageId);
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(attachments, lineageId)) {
      reject({ reason: "duplicate-lineage", detail: `evidence[${index}].lineageId` }, lineageId);
      continue;
    }
    const lineage = ownLineage(input.lineages, lineageId);
    if (lineage === undefined) {
      reject({ reason: "unknown-lineage", detail: `lineages[${lineageId}]` }, lineageId);
      continue;
    }
    if (lineage.state !== "evidence_requested") {
      reject({ reason: "not-actionable-state", detail: `lineages[${lineageId}].state:${lineage.state}` }, lineageId);
      continue;
    }
    if (evidenceRoundConsumed(lineage, limits)) {
      reject(
        {
          reason: "not-actionable-state",
          detail: `lineages[${lineageId}].counters.evidenceRoundsUsed:${lineage.counters.evidenceRoundsUsed}`,
        },
        lineageId,
      );
      continue;
    }

    // (5) §7.1: everything outside the two-field schema is ignored and logged.
    // Sorted so the audit reads identically for two responses that carried the
    // same extra fields in a different key order.
    for (const field of Object.keys(record).sort()) {
      if (EVIDENCE_ATTACHMENT_FIELDS.includes(field)) continue;
      ignored.push({ index, lineageId, field, category: classifyIgnoredEvidenceField(field) });
    }

    const refs = record["evidenceRefs"];
    if (!Array.isArray(refs)) {
      // Not "attached nothing": a record whose only admissible field is unusable
      // answered nothing at all, and recording it as a zero-attachment answer
      // would put a completed lineage on file for a record nobody could read.
      reject({ reason: "invalid-type", detail: `evidence[${index}].evidenceRefs` }, lineageId);
      continue;
    }
    const admitted = admitRefs(refs, lineageId, input.resolveEvidenceRef);
    droppedRefs.push(...admitted.dropped);
    attachments[lineageId] = admitted.references.length;
    references[lineageId] = admitted.references;
    // §7.1's drop count is what reaches the persisted round record, whose own
    // ceiling is `MAX_EVIDENCE_DROPPED_PER_PARTY`; the full list is still on the
    // outcome for the audit.
    dropped[lineageId] = Math.min(admitted.dropped.length, MAX_EVIDENCE_DROPPED_PER_PARTY);
  }

  return finish(null);
}
