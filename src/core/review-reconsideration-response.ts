/**
 * Issue #838: parse the reviewer's answer to the §4.1 reconsideration prompt
 * (docs/review-dispute-contract.md).
 *
 * The response half of `review-reconsideration-prompt.ts`, and the reviewer-side
 * mirror of #843's implementer-side parser. It consumes exactly the contract the
 * prompt states — a single fenced JSON object naming ONE lineage version — and
 * nothing else.
 *
 * Pure and side-effect-free: every check is a transform over already-validated
 * #836 types plus an injected read-only evidence resolver. It admits or rejects;
 * it persists nothing, consumes no §6.1 counter, and selects no transition. Row
 * 9/10/11 (`withdraw`/`uphold`/`revise`), the §5 materiality decision, and the
 * routing that follows are #840's and #839's.
 *
 * What "fails closed" means here, concretely (§12):
 *
 *  - the answer must be ONE record. Two JSON objects are `too-many-items`, not
 *    "use the last one" — picking a winner between two would silently drop the
 *    one the reviewer meant, invisibly to everyone.
 *  - the record must name the PENDING lineage and version. A record for another
 *    lineage, for a version the lineage has moved past, or for a lineage this
 *    task does not carry, is rejected rather than applied to whatever it happens
 *    to match — an unrelated finding must never enter the protocol through the
 *    reconsideration door.
 *  - the lineage must be the one actually awaiting a reviewer turn. §4.1 asks
 *    for a reconsideration "for each lineage in state `disputed`"; a lineage
 *    that is `open`, `binding`, terminal, or already escalated is not awaiting
 *    one, and answering for it would route a turn the protocol never opened.
 *  - the §6.1 reconsideration budget must still be open, so a second reviewer
 *    turn on one lineage cannot be smuggled in by re-running the invocation.
 *
 * ## Why no unrelated finding can enter through this door
 *
 * Three properties, together: the admitted record has a CLOSED field set (§4.1),
 * so a volunteered `newFinding` beside a valid answer is an unknown field and
 * makes the whole record malformed; the only finding-shaped content the schema
 * admits at all is a `revise`'s successor, which #836 binds to this same lineage
 * at exactly `predecessorVersion + 1`; and anything else the reviewer wrote —
 * prose, a second fenced array of "additional findings" — is never read by this
 * module, so it is not admitted, changes nothing, and survives only in the run's
 * raw local artifact where an auditor can see it.
 */
import {
  MAX_RATIONALE_CHARS,
  REVIEW_DISPUTE_DEFAULT_LIMITS,
  REVIEW_DISPUTE_RECORD_MAX_BYTES,
  type PersistedLineage,
  type ReconsiderationRecord,
  type ReviewDisputeLimits,
  type ReviewerReconsideration,
} from "./review-dispute.js";
import {
  admitReconsideration,
  validateReconsiderationRecord,
  type AdmittedReconsideration,
  type EvidenceRefResolver,
  type ReviewDisputeFailure,
  type ReviewDisputeFailureReason,
} from "./review-dispute-validation.js";

// ---------------------------------------------------------------------------
// Extracting the response's reconsideration block
// ---------------------------------------------------------------------------

/**
 * The fenced block the prompt asks for: ```` ```json ```` on its own line, then
 * the JSON object, then a closing fence ON ITS OWN LINE. Built fresh per call —
 * a module-level global regex carries `lastIndex` between calls and would make
 * this module's answer depend on how often it had been asked before.
 *
 * The closing fence is anchored to a line of its own (`^` under `m`, nothing but
 * horizontal space around it) because a rationale may legitimately QUOTE a
 * Markdown fence — "the finding's excerpt is wrapped in ```" — and a delimiter
 * that accepted any triple backtick would cut the record off mid-string and
 * reject a perfectly valid answer as invalid JSON. The anchor is exact rather
 * than merely safer: JSON escapes every newline inside a string, so a fence
 * appearing in a rationale ALWAYS shares its line with at least the quote that
 * opens or closes that string, and can never satisfy this pattern.
 */
function reconsiderationBlockPattern(): RegExp {
  return /```[ \t]*json[ \t]*\r?\n([\s\S]*?)^[ \t]*```[ \t]*(?=\r?\n|$)/gim;
}

export type ReconsiderationBlockExtraction =
  | { ok: true; record: unknown }
  | { ok: false; failure: ReviewDisputeFailure };

/**
 * Extract the single JSON object of the reconsideration record.
 *
 * The rules match #843's array extraction, with the object/array roles swapped,
 * because the failure modes are the same ones:
 *
 *  - no fenced `json` block at all (a prose-only reply, a bare "I still think
 *    the finding stands", an empty response) is `unparseable`: prose cannot be
 *    matched back to a lineage, and §12 makes an unparseable block malformed;
 *  - a `json` fence this function cannot read AT ALL — invalid JSON, or a body
 *    past the #836 byte bound — is fatal for the whole response even when
 *    another fence carries a clean object. Such a fence may well BE the answer
 *    (a truncated first attempt), and skipping it to accept a neighbour would
 *    silently choose between two candidate records;
 *  - TWO object blocks are `too-many-items`. §4.1 asks for exactly one record.
 *
 * Readable NON-object blocks (an array, a string, a number) are ignored rather
 * than fatal: a reviewer may legitimately quote a JSON array from the code it is
 * reasoning about, and such a block is recognizably not a reconsideration.
 */
export function extractReconsiderationRecord(response: string): ReconsiderationBlockExtraction {
  const pattern = reconsiderationBlockPattern();
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
      unreadable ??= { reason: "payload-too-large", detail: "reconsideration-block" };
      continue;
    }
    let data: unknown;
    try {
      data = JSON.parse(body);
    } catch {
      // The fence index is the only locator an unparseable body has, and it
      // carries none of the body's content.
      unreadable ??= { reason: "unparseable", detail: `reconsideration-block:${blocks}:invalid-json` };
      continue;
    }
    if (typeof data === "object" && data !== null && !Array.isArray(data)) objects.push(data);
  }

  // Checked before the object count: an unreadable fence makes the response
  // ambiguous no matter what the readable fences hold.
  if (unreadable !== null) return { ok: false, failure: unreadable };
  if (objects.length > 1) {
    return { ok: false, failure: { reason: "too-many-items", detail: `reconsideration-blocks:${objects.length}` } };
  }
  if (objects.length === 1) return { ok: true, record: objects[0] };
  return {
    ok: false,
    failure: {
      reason: "unparseable",
      detail: blocks === 0 ? "response:no-reconsideration-block" : "response:no-reconsideration-object",
    },
  };
}

// ---------------------------------------------------------------------------
// Admission
// ---------------------------------------------------------------------------

/** The pending dispute a reconsideration answers, as #844's routing state names it. */
export interface PendingReconsiderationTarget {
  lineageId: string;
  version: number;
}

export interface ReconsiderationResponseInput {
  /** The reviewer agent's final response text. */
  response: string;
  /**
   * The lineage/version this invocation asked about. Authoritative: the prompt
   * names exactly one, so a record addressed to anything else is out of contract
   * even when the lineage it names exists and is itself disputed.
   */
  pending: PendingReconsiderationTarget;
  /** The §10.1 persisted lineages of `task.context.reviewDispute`. */
  lineages: Readonly<Record<string, PersistedLineage>>;
  /**
   * §3.3: read-only resolution of a `revise` successor's evidence references,
   * under the same posture the finding and the dispute were held to.
   */
  resolveEvidenceRef: EvidenceRefResolver;
  /** The session's resolved §6.1 limits. */
  limits?: ReviewDisputeLimits;
  /** Repository root, for the §2.1 boundary normalization of a successor. */
  repoRoot?: string;
}

/** Literals and counters only — safe to persist in task context (§10.1). */
export interface ReconsiderationSummary {
  lineageId: string;
  version: number;
  reconsideration: ReviewerReconsideration | null;
  /** §4.2 revision facts. All null unless a `revise` was admitted. */
  revisionKind: string | null;
  materialityClaim: boolean | null;
  changedFields: string[];
  successorVersion: number | null;
  /** Length only — the prose itself stays in the local artifact (§10.2, §11). */
  rationaleChars: number;
  failure: { reason: ReviewDisputeFailureReason; detail: string | null } | null;
}

export interface ReconsiderationOutcome {
  /** The one admitted record, or `null` when the response failed closed. */
  admitted: AdmittedReconsideration | null;
  failure: ReviewDisputeFailure | null;
  summary: ReconsiderationSummary;
}

/** Own-property lookup: an inherited `Object.prototype` member names no lineage. */
function ownLineage(
  lineages: Readonly<Record<string, PersistedLineage>>,
  lineageId: string,
): PersistedLineage | undefined {
  return Object.prototype.hasOwnProperty.call(lineages, lineageId) ? lineages[lineageId] : undefined;
}

/**
 * §6.1: has this lineage already spent its reconsideration budget?
 *
 * Compared against the limit rather than a hard-coded `1`, so a session that
 * lowered `MAX_RECONSIDERATIONS_PER_LINEAGE` to 0 (row 25's skipped round) has
 * no reconsideration admitted at all — the round it configured away cannot be
 * re-entered by invoking the reviewer anyway.
 */
function reconsiderationSlotConsumed(lineage: PersistedLineage, limits: ReviewDisputeLimits): boolean {
  return lineage.counters.reconsiderations >= limits.maxReconsiderationsPerLineage;
}

function summarize(
  input: ReconsiderationResponseInput,
  record: ReconsiderationRecord | null,
  failure: ReviewDisputeFailure | null,
): ReconsiderationSummary {
  return {
    lineageId: input.pending.lineageId,
    version: input.pending.version,
    reconsideration: record?.reconsideration ?? null,
    revisionKind: record?.revision?.revisionKind ?? null,
    materialityClaim: record?.revision?.materialityClaim ?? null,
    // Field NAMES are §2.1 vocabulary, not content: the values they changed to
    // live in the local artifact, never in a summary.
    changedFields: record?.revision ? [...record.revision.changedFields] : [],
    successorVersion: record?.revision?.successor.version ?? null,
    rationaleChars: record?.rationale.length ?? 0,
    failure: failure ? { reason: failure.reason, detail: failure.detail } : null,
  };
}

/**
 * Parse and validate the reviewer's reconsideration response.
 *
 * Never throws: an unusable response is an outcome, not an exception, because
 * §12's effect for malformed output is that no protocol state changes — which
 * the caller can only apply if it gets a value back.
 *
 * Check order is deliberate, and it is the diagnostic order:
 *
 *  1. the envelope (one readable fenced object);
 *  2. the record's own shape, so a malformed record is reported as malformed
 *     rather than as "for the wrong lineage" when it is both;
 *  3. identity — the pending lineage and version — before any lineage state is
 *     read, because a record for another lineage must never be judged against
 *     the pending one's state;
 *  4. the eligibility gates (§4.1 `disputed`, §6.1 budget), so a record that
 *     could never be admitted does not spend an evidence resolution;
 *  5. the full #836 admission, which re-validates, re-resolves the lineage and
 *     its current version, and resolves every successor evidence reference.
 */
export function parseReconsiderationResponse(input: ReconsiderationResponseInput): ReconsiderationOutcome {
  const limits = input.limits ?? REVIEW_DISPUTE_DEFAULT_LIMITS;
  const reject = (failure: ReviewDisputeFailure): ReconsiderationOutcome => ({
    admitted: null,
    failure,
    summary: summarize(input, null, failure),
  });

  const extraction = extractReconsiderationRecord(input.response);
  if (!extraction.ok) return reject(extraction.failure);

  const structural = validateReconsiderationRecord(extraction.record, {
    path: "reconsideration",
    ...(input.repoRoot === undefined ? {} : { repoRoot: input.repoRoot }),
  });
  if (!structural.ok) return reject(structural.failure);
  const record = structural.value;

  // (3) Identity. `unknown-lineage` for a name that is not the one asked about,
  // `stale-version` for the right lineage at the wrong version — the two are
  // distinct failures because they mean different things to an operator: the
  // first is an answer to a question nobody asked, the second an answer to a
  // question that has since moved on.
  if (record.lineageId !== input.pending.lineageId) {
    return reject({ reason: "unknown-lineage", detail: "reconsideration.lineageId:not-pending" });
  }
  if (record.version !== input.pending.version) {
    return reject({ reason: "stale-version", detail: `reconsideration.version:${record.version}` });
  }

  const lineage = ownLineage(input.lineages, record.lineageId);
  if (lineage === undefined) {
    return reject({ reason: "unknown-lineage", detail: `lineages[${record.lineageId}]` });
  }
  // (4) Eligibility. State first: a lineage that is not `disputed` was never
  // awaiting this turn, and that is the fact an operator needs to read even when
  // its budget is also spent.
  if (lineage.state !== "disputed") {
    return reject({ reason: "not-actionable-state", detail: `lineages[${record.lineageId}].state:${lineage.state}` });
  }
  if (reconsiderationSlotConsumed(lineage, limits)) {
    return reject({
      reason: "reconsideration-slot-consumed",
      detail: `lineages[${record.lineageId}].counters.reconsiderations:${lineage.counters.reconsiderations}`,
    });
  }

  // (5) The #836 admission is what actually admits: it re-validates the record,
  // checks it against the lineage's CURRENT version, and resolves the successor's
  // evidence references (§3.3, §12).
  const admission = admitReconsideration(
    extraction.record,
    {
      lineages: input.lineages,
      resolveEvidenceRef: input.resolveEvidenceRef,
      ...(input.repoRoot === undefined ? {} : { repoRoot: input.repoRoot }),
    },
    "reconsideration",
  );
  if (!admission.ok) return reject(admission.failure);

  // Defensive, and cheap: the #836 validator bounds `rationale` to the same
  // constant the prompt states, so this can only fire if the two drift apart.
  if (admission.value.record.rationale.length > MAX_RATIONALE_CHARS) {
    return reject({ reason: "field-too-long", detail: `reconsideration.rationale:${admission.value.record.rationale.length}` });
  }

  return {
    admitted: admission.value,
    failure: null,
    summary: summarize(input, admission.value.record, null),
  };
}
