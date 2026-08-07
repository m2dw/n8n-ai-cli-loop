/**
 * Issue #846: parse the arbiter's answer to the §8.1 verdict contract
 * (docs/review-dispute-contract.md).
 *
 * The response half of `review-arbitration-prompt.ts`, and the arbiter-side
 * mirror of #838's reviewer parser. It consumes exactly the contract the prompt
 * states — a single fenced JSON object naming ONE lineage version — and nothing
 * else.
 *
 * Pure and side-effect-free: every check is a transform over already-validated
 * #836 types. It admits or rejects; it persists nothing, consumes no §6.1
 * counter, and selects no transition. Rows 13–19, the confidence routing they
 * apply, and the malformed-attempt counter of rows 20–21 are #847's.
 *
 * ## Low confidence is not malformed output
 *
 * The one place this parser deliberately does NOT fail closed. §8.3 makes
 * `minConfidence` a ROUTING threshold for the two decisive verdicts, not an
 * admission rule: a `reviewer_correct` at 0.4 is a verdict the arbiter actually
 * returned, and it consumes an arbitration pass exactly as a confident one does.
 * Rejecting it here would recycle it as a malformed attempt — spending the §12
 * budget on well-formed output, and inviting an arbiter to inflate its own
 * confidence to be heard. So the threshold is REPORTED
 * ({@link ArbitrationConfidenceRouting}) and applied by the transition owner,
 * which is where "route to a human instead" actually lives (rows 13–14, 18).
 *
 * `spec_ambiguous` and `insufficient_evidence` are never gated by it at all:
 * §8.3 routes them via rows 15–17 regardless of confidence, so no returned
 * verdict matches more than one row.
 *
 * ## Why no unrelated finding can enter through this door
 *
 * §8.1 says additional finding-shaped content is "ignored and logged, never
 * admitted". The #836 validator implements exactly that: finding-shaped extra
 * fields are dropped into `ignoredFindingShapedFields` while any OTHER unknown
 * field is malformed, and the admitted record has a closed five-field shape with
 * no place to put a finding. Anything else the arbiter wrote — prose, a second
 * fenced array of "additional findings" — is never read by this module, so it is
 * not admitted, changes nothing, and survives only in the run's raw local
 * artifact where an auditor can see it.
 */
import {
  DECISIVE_ARBITER_VERDICTS,
  MAX_RATIONALE_CHARS,
  REVIEW_DISPUTE_DEFAULT_LIMITS,
  REVIEW_DISPUTE_RECORD_MAX_BYTES,
  type ArbiterVerdict,
  type ArbiterVerdictRecord,
  type PersistedLineage,
  type ReviewDisputeLimits,
} from "./review-dispute.js";
import {
  admitArbiterVerdict,
  validateArbiterVerdict,
  type AdmittedVerdict,
  type ReviewDisputeFailure,
  type ReviewDisputeFailureReason,
} from "./review-dispute-validation.js";

// ---------------------------------------------------------------------------
// Extracting the response's verdict block
// ---------------------------------------------------------------------------

/**
 * The fenced block the prompt asks for: ```` ```json ```` on its own line, then
 * the JSON object, then a closing fence ON ITS OWN LINE. Built fresh per call — a
 * module-level global regex carries `lastIndex` between calls and would make this
 * module's answer depend on how often it had been asked before.
 *
 * The closing fence is anchored to a line of its own because a rationale may
 * legitimately QUOTE a Markdown fence, and a delimiter that accepted any triple
 * backtick would cut the record off mid-string and reject a valid answer as
 * invalid JSON. The anchor is exact rather than merely safer: JSON escapes every
 * newline inside a string, so a fence appearing in a rationale always shares its
 * line with at least the quote that opens or closes that string.
 */
function verdictBlockPattern(): RegExp {
  return /```[ \t]*json[ \t]*\r?\n([\s\S]*?)^[ \t]*```[ \t]*(?=\r?\n|$)/gim;
}

export type ArbiterVerdictExtraction =
  | { ok: true; record: unknown }
  | { ok: false; failure: ReviewDisputeFailure };

/**
 * Extract the single JSON object of the verdict record.
 *
 * The rules are #838's, for the same reasons: a response with no fenced `json`
 * block is `unparseable`; a fence this function cannot read AT ALL (invalid JSON,
 * or a body past the #836 byte bound) is fatal for the whole response even when
 * another fence carries a clean object, because that fence may well BE the answer
 * and skipping it would silently choose between two candidate verdicts; and TWO
 * object blocks are `too-many-items`, since §8.1 asks for exactly one record.
 *
 * Readable NON-object blocks (an array, a string, a number) are ignored rather
 * than fatal: an arbiter may legitimately quote a JSON array from the code it is
 * reasoning about, and such a block is recognizably not a verdict.
 */
export function extractArbiterVerdictRecord(response: string): ArbiterVerdictExtraction {
  const pattern = verdictBlockPattern();
  const objects: unknown[] = [];
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
      unreadable ??= { reason: "payload-too-large", detail: "verdict-block" };
      continue;
    }
    let data: unknown;
    try {
      data = JSON.parse(body);
    } catch {
      unreadable ??= { reason: "unparseable", detail: `verdict-block:${blocks}:invalid-json` };
      continue;
    }
    if (typeof data === "object" && data !== null && !Array.isArray(data)) objects.push(data);
  }

  // Checked before the object count: an unreadable fence makes the response
  // ambiguous no matter what the readable fences hold.
  if (unreadable !== null) return { ok: false, failure: unreadable };
  if (objects.length > 1) {
    return { ok: false, failure: { reason: "too-many-items", detail: `verdict-blocks:${objects.length}` } };
  }
  if (objects.length === 1) return { ok: true, record: objects[0] };
  return {
    ok: false,
    failure: {
      reason: "unparseable",
      detail: blocks === 0 ? "response:no-verdict-block" : "response:no-verdict-object",
    },
  };
}

// ---------------------------------------------------------------------------
// Admission
// ---------------------------------------------------------------------------

/** The lineage this arbitration was invoked for. */
export interface PendingArbitrationTarget {
  lineageId: string;
  version: number;
}

export interface ArbitrationResponseInput {
  /** The arbiter agent's final response text. */
  response: string;
  /**
   * The lineage/version this invocation asked about. Authoritative: the prompt
   * names exactly one, so a record addressed to anything else is out of contract
   * even when the lineage it names exists and is itself awaiting arbitration.
   */
  pending: PendingArbitrationTarget;
  /** The §10.1 persisted lineages of `task.context.reviewDispute`. */
  lineages: Readonly<Record<string, PersistedLineage>>;
  /** §8.3's resolved threshold, reported for the decisive verdicts. */
  minConfidence: number;
  /** The session's resolved §6.1 limits. */
  limits?: ReviewDisputeLimits;
}

/**
 * What #847 needs to route a verdict's confidence, computed once here so the
 * threshold is applied to the same number the artifact records.
 */
export interface ArbitrationConfidenceRouting {
  /** §8.3: only `reviewer_correct` and `implementer_correct` are gated. */
  decisive: boolean;
  minConfidence: number;
  confidence: number;
  /** False only for a DECISIVE verdict below the threshold (rows 13–14, 18). */
  meetsMinConfidence: boolean;
}

/** Literals and counters only — safe to persist in task context (§10.1). */
export interface ArbitrationSummary {
  lineageId: string;
  version: number;
  verdict: ArbiterVerdict | null;
  confidence: number | null;
  decisive: boolean;
  minConfidence: number;
  meetsMinConfidence: boolean;
  /** Length only — the prose itself stays in the local artifact (§10.2, §11). */
  rationaleChars: number;
  /** §8.1: the NAMES of finding-shaped fields that were ignored, never their content. */
  ignoredFindingShapedFields: string[];
  failure: { reason: ReviewDisputeFailureReason; detail: string | null } | null;
}

export interface ArbitrationOutcome {
  /** The one admitted verdict, or `null` when the response failed closed. */
  admitted: AdmittedVerdict | null;
  /** Present exactly when `admitted` is. */
  confidence: ArbitrationConfidenceRouting | null;
  failure: ReviewDisputeFailure | null;
  summary: ArbitrationSummary;
}

/** Own-property lookup: an inherited `Object.prototype` member names no lineage. */
function ownLineage(
  lineages: Readonly<Record<string, PersistedLineage>>,
  lineageId: string,
): PersistedLineage | undefined {
  return Object.prototype.hasOwnProperty.call(lineages, lineageId) ? lineages[lineageId] : undefined;
}

export function isDecisiveVerdict(verdict: ArbiterVerdict): boolean {
  return (DECISIVE_ARBITER_VERDICTS as readonly string[]).includes(verdict);
}

/**
 * §8.3: has this lineage already returned every verdict its budget allows?
 *
 * Passes count RETURNED verdicts, so an exhausted budget means the debate is
 * over — admitting one more would let a re-invocation extend it past the bound
 * the session configured.
 */
function arbitrationPassesExhausted(lineage: PersistedLineage, limits: ReviewDisputeLimits): boolean {
  return lineage.counters.arbitrationPasses >= limits.maxArbitrationPassesPerLineage;
}

function routing(record: ArbiterVerdictRecord, minConfidence: number): ArbitrationConfidenceRouting {
  const decisive = isDecisiveVerdict(record.verdict);
  return {
    decisive,
    minConfidence,
    confidence: record.confidence,
    // A non-decisive verdict is never gated, so it "meets" the threshold by
    // construction: rows 15–17 route it on the verdict alone.
    meetsMinConfidence: !decisive || record.confidence >= minConfidence,
  };
}

function summarize(
  input: ArbitrationResponseInput,
  record: ArbiterVerdictRecord | null,
  ignoredFindingShapedFields: readonly string[],
  failure: ReviewDisputeFailure | null,
): ArbitrationSummary {
  const route = record === null ? null : routing(record, input.minConfidence);
  return {
    lineageId: input.pending.lineageId,
    version: input.pending.version,
    verdict: record?.verdict ?? null,
    confidence: record?.confidence ?? null,
    decisive: route?.decisive ?? false,
    minConfidence: input.minConfidence,
    meetsMinConfidence: route?.meetsMinConfidence ?? false,
    rationaleChars: record?.rationale.length ?? 0,
    ignoredFindingShapedFields: [...ignoredFindingShapedFields],
    failure: failure ? { reason: failure.reason, detail: failure.detail } : null,
  };
}

/**
 * Parse and validate the arbiter's verdict response.
 *
 * Never throws: an unusable response is an outcome, not an exception, because
 * §12's effect for malformed output is that no protocol state changes — which the
 * caller can only apply if it gets a value back.
 *
 * Check order is deliberate, and it is the diagnostic order:
 *
 *  1. the envelope (one readable fenced object);
 *  2. the record's own shape, so a malformed record is reported as malformed
 *     rather than as "for the wrong lineage" when it is both;
 *  3. identity — the pending lineage and version — before any lineage state is
 *     read, because a record for another lineage must never be judged against
 *     the pending one's state;
 *  4. the eligibility gates (§8.2's `arbitration_pending`, §8.3's pass budget),
 *     so a verdict that could never be admitted is reported as the ineligible
 *     turn it is;
 *  5. the full #836 admission, which re-validates and re-checks the lineage's
 *     CURRENT version.
 */
export function parseArbitrationResponse(input: ArbitrationResponseInput): ArbitrationOutcome {
  const limits = input.limits ?? REVIEW_DISPUTE_DEFAULT_LIMITS;
  const reject = (failure: ReviewDisputeFailure, ignored: readonly string[] = []): ArbitrationOutcome => ({
    admitted: null,
    confidence: null,
    failure,
    summary: summarize(input, null, ignored, failure),
  });

  const extraction = extractArbiterVerdictRecord(input.response);
  if (!extraction.ok) return reject(extraction.failure);

  const structural = validateArbiterVerdict(extraction.record, "verdict");
  if (!structural.ok) return reject(structural.failure);
  const record = structural.value.record;
  // Carried through every rejection below: §8.1 has finding-shaped content
  // "ignored and logged", and a verdict rejected for an unrelated reason still
  // needs its volunteered findings visible in the audit rather than dropped
  // along with the record.
  const ignored = structural.value.ignoredFindingShapedFields;

  // (3) Identity. `unknown-lineage` for a name that is not the one asked about,
  // `stale-version` for the right lineage at the wrong version — distinct
  // failures because they mean different things: the first is an answer to a
  // question nobody asked, the second an answer to one that has moved on.
  if (record.lineageId !== input.pending.lineageId) {
    return reject({ reason: "unknown-lineage", detail: "verdict.lineageId:not-pending" }, ignored);
  }
  if (record.version !== input.pending.version) {
    return reject({ reason: "stale-version", detail: `verdict.version:${record.version}` }, ignored);
  }

  const lineage = ownLineage(input.lineages, record.lineageId);
  if (lineage === undefined) {
    return reject({ reason: "unknown-lineage", detail: `lineages[${record.lineageId}]` }, ignored);
  }
  // (4) Eligibility. State first: a lineage that is not `arbitration_pending` was
  // never awaiting this turn, and that is the fact an operator needs to read even
  // when its budget is also spent.
  if (lineage.state !== "arbitration_pending") {
    return reject(
      { reason: "not-actionable-state", detail: `lineages[${record.lineageId}].state:${lineage.state}` },
      ignored,
    );
  }
  if (arbitrationPassesExhausted(lineage, limits)) {
    return reject(
      {
        reason: "arbitration-passes-exhausted",
        detail: `lineages[${record.lineageId}].counters.arbitrationPasses:${lineage.counters.arbitrationPasses}`,
      },
      ignored,
    );
  }

  // (5) The #836 admission is what actually admits: it re-validates the record
  // and checks it against the lineage's CURRENT version.
  const admission = admitArbiterVerdict(extraction.record, { lineages: input.lineages }, "verdict");
  if (!admission.ok) return reject(admission.failure, ignored);

  // Defensive, and cheap: the #836 validator bounds `rationale` to the same
  // constant the prompt states, so this can only fire if the two drift apart.
  if (admission.value.record.rationale.length > MAX_RATIONALE_CHARS) {
    return reject(
      { reason: "field-too-long", detail: `verdict.rationale:${admission.value.record.rationale.length}` },
      admission.value.ignoredFindingShapedFields,
    );
  }

  return {
    admitted: admission.value,
    confidence: routing(admission.value.record, input.minConfidence),
    failure: null,
    summary: summarize(input, admission.value.record, admission.value.ignoredFindingShapedFields, null),
  };
}
