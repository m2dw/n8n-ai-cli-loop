/**
 * Structured review finding envelope (issue #841, docs/review-dispute-contract.md).
 *
 * A normal review run emits its verdict twice: as the free-form report it has
 * always produced, and — when the protocol is enabled — as a single closed
 * envelope this module extracts, parses, and admits. The envelope is the only
 * part of the output that can become a disputable §2.1 finding; §13 makes
 * everything else legacy prose, which keeps its blocking force but is never
 * actionable inside the protocol.
 *
 * Everything schema-shaped here is DELEGATED to the #836 contract modules
 * (`review-dispute.ts`, `review-dispute-validation.ts`, `review-dispute-lineage.ts`):
 * the finding schema, the evidence rules, lineage minting, the duplicate/version
 * invariants, the persisted §10.1 record, and the bounded serializations. This
 * module owns only what #836 deliberately left to the pipeline — the wire format
 * of the review turn, and the decision to admit a review's candidates as fresh
 * version-1 lineages.
 *
 * What this module deliberately does NOT do (issue #840 and its upstream routing
 * Issues own all of it): decide a transition, read or write a counter, check a
 * §6.1 cap, judge whether a persisted combination is reachable, route
 * arbitration, or make an idempotent state-machine decision. Every lineage it
 * OPENS is `open` at version 1 with zero counters — the admission FACT of a
 * first structured finding, and an input to that later state machine rather than
 * a second implementation of it. A lineage an earlier review already persisted
 * is carried through untouched for the same reason: preserving it is not a
 * decision about it, and neither is recognizing that a re-raised finding belongs
 * to it (§2.2) rather than to a second debate about the same alleged defect.
 */

import {
  MAX_EVIDENCE_REFS_PER_RECORD,
  MAX_FINDINGS_PER_REVIEW,
  REVIEW_DISPUTE_RECORD_MAX_BYTES,
  ZERO_LINEAGE_COUNTERS,
  classifyReviewStructure,
  isTerminalLineageState,
  reviewStructureAllowsZeroChange,
  type CandidateFinding,
  type FindingSeverity,
  type PersistedLineage,
  type ReviewDisputeContext,
  type ReviewDisputeLimits,
  type ReviewFinding,
  type ReviewStructureClassification,
  type ReviewerMeta,
} from "./review-dispute.js";
import {
  admitFinding,
  parseBoundedJson,
  validateCandidateFinding,
  validateFindingSet,
  validateReviewDisputeContext,
  type EvidenceRefResolver,
  type ReviewDisputeFailure,
  type ReviewDisputeResult,
} from "./review-dispute-validation.js";
import {
  classifyCandidateAdmission,
  isStaleVersion,
  lineageIdentityHash,
  serializeRecord,
  serializeReviewDisputeContext,
  type LineageIdentityEntry,
} from "./review-dispute-lineage.js";

// ---------------------------------------------------------------------------
// Wire format
//
// Whole-line markers rather than a Markdown fence: a reviewer's own report
// routinely contains fenced JSON (a suggested patch, a config snippet), and a
// fence-delimited envelope would be indistinguishable from it. The markers are
// recognized ONLY as whole lines, so no field value can spell one — JSON strings
// cannot contain a raw newline, which is what makes "on its own line" a property
// the payload itself cannot forge.
// ---------------------------------------------------------------------------

export const REVIEW_FINDINGS_MARKER = "<<<REVIEW_FINDINGS>>>";
export const REVIEW_FINDINGS_END_MARKER = "<<<END_REVIEW_FINDINGS>>>";

/** Only schema version `1` of the envelope exists. */
export const REVIEW_FINDINGS_ENVELOPE_VERSION = 1;

/**
 * Worst-case bytes that ADMISSION adds to one finding — the three runner-owned
 * §2.1 fields, with their keys and separators:
 *
 *   `"lineageId":"ln-<12 hex>[-<3 digits>]"`  ≈  35
 *   `"humanGate":false`                       ≈  18
 *   `"reviewerMeta":{…}`                      ≈ 470  (agentId ≤80, model ≤120,
 *                                                    reviewRunId ≤120, effort,
 *                                                    timestamp, and their keys)
 *
 * Rounded well up, so the budget below never depends on the arithmetic being
 * exact — only on it being an over-estimate.
 */
export const REVIEW_FINDING_ADMISSION_OVERHEAD_BYTES = 768;

/**
 * Upper bound on the payload between the markers, checked on the raw bytes
 * before `JSON.parse` allocates an object graph.
 *
 * Deliberately SMALLER than the #836 per-record bound rather than equal to it.
 * What the agent writes here is not what gets persisted: the §10.2 artifact is
 * these same findings PLUS the runner-owned fields stamped at admission, and it
 * is bounded by {@link REVIEW_DISPUTE_RECORD_MAX_BYTES}. Were both bounds 64 KB,
 * an envelope just under the limit would be admitted and then produce records
 * too large to serialize — accepted on the way in, unwritable on the way out,
 * with the lineages already minted. Reserving the admission overhead for every
 * finding a review may carry keeps the two bounds consistent, so an over-budget
 * envelope is refused as agent output rather than discovered as a missing
 * artifact.
 */
export const REVIEW_FINDINGS_ENVELOPE_MAX_BYTES =
  REVIEW_DISPUTE_RECORD_MAX_BYTES - MAX_FINDINGS_PER_REVIEW * REVIEW_FINDING_ADMISSION_OVERHEAD_BYTES;

/** The closed envelope statuses (§13: success, blocked execution, findings). */
export const REVIEW_ENVELOPE_STATUSES = ["success", "blocked", "findings"] as const;
export type ReviewEnvelopeStatus = (typeof REVIEW_ENVELOPE_STATUSES)[number];

/**
 * The closed reason vocabulary for a `blocked` envelope.
 *
 * A literal rather than prose: the reason is the one envelope field that reaches
 * task context without passing through the §2.1 finding schema, and a closed
 * token needs no length bound, no encoding scan, and no sanitization before an
 * operator reads it. The reviewer's explanation stays in the raw output artifact.
 */
export const REVIEW_BLOCKED_REASONS = [
  "insufficient_context",
  "diff_not_reviewable",
  "tooling_unavailable",
  "requires_human_judgment",
] as const;
export type ReviewBlockedReason = (typeof REVIEW_BLOCKED_REASONS)[number];

const ENVELOPE_FIELDS: readonly string[] = ["version", "status", "findings", "blockedReason"];

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

export type EnvelopeExtraction =
  /** §13: a legacy-format review. Not an error — the protocol is inert for it. */
  | { kind: "absent"; residual: string }
  | { kind: "payload"; payload: string; residual: string }
  | { kind: "failure"; failure: ReviewDisputeFailure };

/** Markers are recognized only as whole lines; a CRLF-producing CLI is tolerated. */
function isMarkerLine(line: string, marker: string): boolean {
  const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
  return trimmed === marker;
}

/**
 * Extract the single structured envelope from a review run's output.
 *
 * A second envelope is a hard failure rather than a last-one-wins: two envelopes
 * can disagree about whether the diff passes, and picking either would let
 * trailing chatter that merely looks like an envelope displace the real verdict.
 * Exactly one, or nothing is admitted.
 *
 * `residual` is what remains of the output once the block and its markers are
 * removed — the §13 free prose, which decides whether the review was fully
 * structured or mixed. It is computed for the `absent` case too, where it is the
 * whole output.
 */
export function extractReviewFindingsEnvelope(output: string): EnvelopeExtraction {
  const lines = output.split("\n");
  const payloads: string[] = [];
  const residualLines: string[] = [];
  let open: string[] | null = null;
  for (const line of lines) {
    if (open === null) {
      if (isMarkerLine(line, REVIEW_FINDINGS_MARKER)) {
        open = [];
        continue;
      }
      // A stray end marker outside a block is chatter, not a block.
      residualLines.push(line);
      continue;
    }
    if (isMarkerLine(line, REVIEW_FINDINGS_END_MARKER)) {
      payloads.push(open.join("\n"));
      open = null;
      continue;
    }
    // A second opening marker inside an open block cannot be a nested block —
    // the first block was never terminated.
    if (isMarkerLine(line, REVIEW_FINDINGS_MARKER)) {
      return { kind: "failure", failure: { reason: "unparseable", detail: "envelope:unterminated-block" } };
    }
    open.push(line);
  }
  if (open !== null) {
    return { kind: "failure", failure: { reason: "unparseable", detail: "envelope:unterminated-block" } };
  }
  const residual = residualLines.join("\n");
  if (payloads.length === 0) return { kind: "absent", residual };
  if (payloads.length > 1) {
    return { kind: "failure", failure: { reason: "unparseable", detail: `envelope:duplicate-block:${payloads.length}` } };
  }
  const payload = payloads[0]!;
  const bytes = Buffer.byteLength(payload, "utf8");
  if (bytes > REVIEW_FINDINGS_ENVELOPE_MAX_BYTES) {
    return { kind: "failure", failure: { reason: "payload-too-large", detail: `envelope:${bytes}` } };
  }
  return { kind: "payload", payload, residual };
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export interface ParsedReviewEnvelope {
  status: ReviewEnvelopeStatus;
  /** Present exactly when `status` is `blocked`. */
  blockedReason?: ReviewBlockedReason;
  /** Non-empty exactly when `status` is `findings`. */
  candidates: CandidateFinding[];
  /**
   * §2.1: runner-owned fields the reviewer supplied, path-qualified. They are
   * dropped, never admitted; the caller logs them.
   */
  ignoredRunnerOwnedFields: string[];
}

/**
 * Parse and schema-check an extracted envelope payload.
 *
 * Every per-finding rule — required fields, unknown fields, closed enums, field
 * lengths, evidence-reference shape and count, the `affectedBoundary`
 * normalization, the version bound — is the #836 candidate validator's, called
 * once per element. This function owns only the envelope wrapper: its closed
 * field set, its schema version, and the status/payload agreement that makes a
 * truncated or self-contradicting envelope fail closed.
 */
export function parseReviewFindingsEnvelope(
  payload: string,
  opts: { repoRoot?: string } = {},
): ReviewDisputeResult<ParsedReviewEnvelope> {
  const parsed = parseBoundedJson(payload, REVIEW_FINDINGS_ENVELOPE_MAX_BYTES, "envelope");
  if (!parsed.ok) return parsed;
  const raw = parsed.value;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, failure: { reason: "not-an-object", detail: "envelope" } };
  }
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    // The unknown key is agent-chosen text, so only its position is recorded.
    if (!ENVELOPE_FIELDS.includes(key)) {
      return { ok: false, failure: { reason: "unknown-field", detail: "envelope" } };
    }
  }
  if (obj["version"] !== REVIEW_FINDINGS_ENVELOPE_VERSION) {
    return { ok: false, failure: { reason: "invalid-version", detail: "envelope.version" } };
  }
  const statusRaw = obj["status"];
  if (statusRaw === undefined) {
    return { ok: false, failure: { reason: "missing-field", detail: "envelope.status" } };
  }
  if (typeof statusRaw !== "string" || !(REVIEW_ENVELOPE_STATUSES as readonly string[]).includes(statusRaw)) {
    return { ok: false, failure: { reason: "unknown-enum", detail: "envelope.status" } };
  }
  const status = statusRaw as ReviewEnvelopeStatus;

  // §12 fail-closed: the payload must AGREE with the status it declares. A
  // `success` carrying findings, or a `findings` carrying none, is a
  // self-contradicting verdict — most often a truncated or half-rewritten
  // envelope — and there is no safe way to pick which half was meant.
  const blockedRaw = obj["blockedReason"];
  if (status === "blocked") {
    if (blockedRaw === undefined) {
      return { ok: false, failure: { reason: "missing-field", detail: "envelope.blockedReason" } };
    }
    if (typeof blockedRaw !== "string" || !(REVIEW_BLOCKED_REASONS as readonly string[]).includes(blockedRaw)) {
      return { ok: false, failure: { reason: "unknown-enum", detail: "envelope.blockedReason" } };
    }
  } else if (blockedRaw !== undefined) {
    return { ok: false, failure: { reason: "unknown-field", detail: "envelope.blockedReason" } };
  }

  const findingsRaw = obj["findings"];
  if (status !== "findings") {
    if (findingsRaw !== undefined) {
      return { ok: false, failure: { reason: "unknown-field", detail: "envelope.findings" } };
    }
    return {
      ok: true,
      value: {
        status,
        ...(status === "blocked" ? { blockedReason: blockedRaw as ReviewBlockedReason } : {}),
        candidates: [],
        ignoredRunnerOwnedFields: [],
      },
    };
  }
  if (findingsRaw === undefined) {
    return { ok: false, failure: { reason: "missing-field", detail: "envelope.findings" } };
  }
  if (!Array.isArray(findingsRaw)) {
    return { ok: false, failure: { reason: "invalid-type", detail: "envelope.findings:not-an-array" } };
  }
  if (findingsRaw.length === 0) {
    return { ok: false, failure: { reason: "missing-field", detail: "envelope.findings:0" } };
  }
  if (findingsRaw.length > MAX_FINDINGS_PER_REVIEW) {
    return { ok: false, failure: { reason: "too-many-items", detail: `envelope.findings:${findingsRaw.length}` } };
  }

  const candidates: CandidateFinding[] = [];
  const ignoredRunnerOwnedFields: string[] = [];
  for (const [i, item] of findingsRaw.entries()) {
    const path = `envelope.findings[${i}]`;
    const checked = validateCandidateFinding(item, {
      path,
      ...(opts.repoRoot !== undefined ? { repoRoot: opts.repoRoot } : {}),
    });
    if (!checked.ok) return checked;
    candidates.push(checked.value.candidate);
    for (const field of checked.value.ignoredRunnerOwnedFields) {
      ignoredRunnerOwnedFields.push(`${path}.${field}`);
    }
  }
  return { ok: true, value: { status, candidates, ignoredRunnerOwnedFields } };
}

// ---------------------------------------------------------------------------
// Admission
// ---------------------------------------------------------------------------

export interface AdmitReviewFindingsInput {
  candidates: readonly CandidateFinding[];
  /** §2.1: recorded from the review run's own metadata, never from agent output. */
  reviewerMeta: ReviewerMeta;
  /** §2.1: runner-stamped; a reviewer-supplied value never survives admission. */
  humanGate: boolean;
  /** §3.3: read-only reference resolution, injected by the pipeline. */
  resolveEvidenceRef: EvidenceRefResolver;
  repoRoot?: string;
  /**
   * The lineages an earlier review of this task persisted, ALREADY validated
   * through the #836 context validator — {@link processReviewFindings} does that
   * before calling here, so nothing agent-shaped reaches the classifier.
   *
   * Absent (or empty) means the classifier sees no known lineage, which is the
   * first review of a task and the only shape this function had before.
   */
  priorLineages?: Readonly<Record<string, PersistedLineage>>;
}

/** §2.2: a re-raise that attached to a lineage already on file. */
export interface ReviewFindingAttachment {
  lineageId: string;
  /** The lineage's recorded version, which the attach does not advance (§2.3). */
  version: number;
  /** The lineage's recorded severity — the candidate's is discarded (§2.3). */
  severity: FindingSeverity;
  /** Position of the re-raise inside the envelope, for the audit log. */
  path: string;
}

export interface AdmittedReviewFindings {
  /** Records this run WRITES: one per newly opened lineage, at version 1. */
  findings: ReviewFinding[];
  /**
   * Candidates that named a lineage already on file. They are blocking exactly
   * as an admitted finding is, but nothing new is recorded for them.
   */
  attachments: ReviewFindingAttachment[];
}

/**
 * The #836 classifier's view of the lineages an earlier review persisted.
 *
 * A §10.1 record carries no finding prose, so its identity hash is recovered
 * from its id — the id is that hash by construction (§2.2). An id that cannot be
 * inverted is kept with its own literal standing in for the hash rather than
 * dropped: a 12-hex hash can never equal it, so it matches no candidate, while
 * still occupying the taken-id set so a mint cannot land on top of it.
 * `validateReviewDisputeContext` already rejects such an id, so this is the
 * unreachable branch behaving conservatively rather than a supported input.
 */
function priorLineageEntries(lineages: Readonly<Record<string, PersistedLineage>>): LineageIdentityEntry[] {
  return Object.values(lineages).map((lineage) => ({
    lineageId: lineage.lineageId,
    identityHash: lineageIdentityHash(lineage.lineageId) ?? lineage.lineageId,
    state: lineage.state,
    // §7 (rows 1/5/23): a lineage that ever consumed a rebuttal may not be
    // superseded. The persisted record names the versions that did.
    rebuttalConsumed: lineage.rebuttedVersions.length > 0,
    ...(lineage.supersedes !== undefined ? { supersedes: lineage.supersedes } : {}),
  }));
}

/**
 * Admit a review run's candidates against the lineages already on file.
 *
 * The classifier is the #836 one, and only two of its outcomes are this Issue's
 * to act on — both of them admission FACTS rather than transitions:
 *
 *  - `new` — a defect no lineage on file describes. A lineage is minted and the
 *    finding is written at version 1 with zero counters.
 *  - `attach` — the §2.2 re-raise: the candidate names, or structurally
 *    duplicates, a live lineage. Nothing is written. §2.3 makes the version it
 *    attaches to immutable, so the candidate's own body is discarded and the
 *    persisted record keeps its version, state, and counters untouched; its §10.2
 *    record stays in the earlier run's artifact directory. Recognizing that the
 *    re-raise belongs to an existing debate is not a decision ABOUT that debate.
 *    Its evidence is resolved all the same: an attachment blocks the diff, and
 *    §3.3 admits no blocking output on references that do not resolve.
 *
 * Passing the prior lineages in rather than `[]` is what makes both correct. With
 * an empty set a reviewer that follows the contract and echoes an id it was shown
 * is rejected as `unknown-lineage` — its whole (valid) envelope blocked — while
 * an unlabelled duplicate is admitted as a fresh version-1 record whose minted id
 * then collides with the persisted one and is silently dropped at persistence.
 *
 * `supersedes` and `drop` stay outside the boundary: both turn on a TERMINAL
 * persisted state, and #841 never writes one — every lineage it opens is `open`.
 * They are unreachable against what this Issue can persist, so they fail closed
 * here and reach #840 as an explicit gap rather than as a guess.
 *
 * Two candidates with the same §2.2 identity tuple mint the SAME id —
 * deliberately. Within one review they are one alleged defect emitted twice, and
 * the #836 set check rejects the pair rather than silently splitting it into two
 * debates behind a disambiguating suffix. Two candidates attaching to the same
 * lineage are rejected for the same reason.
 */
export function admitReviewFindings(input: AdmitReviewFindingsInput): ReviewDisputeResult<AdmittedReviewFindings> {
  const priorLineages = input.priorLineages ?? {};
  const known = priorLineageEntries(priorLineages);
  const admitted: ReviewFinding[] = [];
  const attachments: ReviewFindingAttachment[] = [];
  const attached = new Set<string>();
  for (const [i, candidate] of input.candidates.entries()) {
    const path = `envelope.findings[${i}]`;
    const admission = classifyCandidateAdmission(candidate, known);
    if (admission.kind === "reject") {
      // §2.2: agents only ECHO lineage ids. One that names no lineage this task
      // has on file cannot attach, and minting from agent output is exactly what
      // the contract forbids.
      return { ok: false, failure: { reason: "unknown-lineage", detail: `${path}.lineageId` } };
    }
    if (admission.kind === "attach") {
      const lineage = priorLineages[admission.lineageId];
      if (lineage === undefined) {
        // The classifier only names ids it was given; a miss means the two views
        // disagree, which is never something to admit on.
        return { ok: false, failure: { reason: "invalid-state-record", detail: `${path}.lineageId` } };
      }
      // §2.3: the version an attach lands on is immutable and is the lineage's
      // current one, so a candidate that REFERENCES another one is stale — the
      // only way to advance a version is a §4.2 revise. Checked only when the
      // reviewer echoed an id: without one the candidate is a structural
      // duplicate the reviewer did not know it was raising, and its `version` is
      // the contract's default for a first finding rather than a claim about
      // which version of a debate it means.
      if (candidate.lineageId !== undefined && isStaleVersion(lineage, candidate.version)) {
        return { ok: false, failure: { reason: "stale-version", detail: `${path}.version:${candidate.version}` } };
      }
      if (attached.has(lineage.lineageId)) {
        return { ok: false, failure: { reason: "duplicate-lineage", detail: `${path}.lineageId` } };
      }
      // §3.3/§12: every reference a review emits must resolve, and an attachment
      // is blocking output — it is what routes this diff back to `needs_fix`.
      // #836's `admitFinding` skips resolution on an attach because nothing of
      // the candidate enters the persisted RECORD (the version it lands on is
      // immutable and its own references resolved when it was admitted); that
      // says nothing about whether the envelope citing them is admissible. Left
      // unchecked, a re-raise citing a file that does not exist would block the
      // diff on evidence nobody could read, while the identical citation on a
      // fresh finding rejects the whole envelope — the one asymmetry a reviewer
      // could exploit by echoing an id instead of describing a defect.
      for (const [j, ref] of candidate.evidenceRefs.entries()) {
        if (!input.resolveEvidenceRef(ref)) {
          return { ok: false, failure: { reason: "unresolvable-evidence", detail: `${path}.evidenceRefs[${j}]` } };
        }
      }
      attached.add(lineage.lineageId);
      attachments.push({
        lineageId: lineage.lineageId,
        version: lineage.version,
        severity: lineage.severity,
        path,
      });
      continue;
    }
    if (admission.kind !== "new") {
      // `supersedes` / `drop`: a terminal-state decision this Issue does not own.
      return { ok: false, failure: { reason: "invalid-state-record", detail: `${path}:${admission.kind}` } };
    }
    const result = admitFinding(
      candidate,
      { lineageId: admission.lineageId, humanGate: input.humanGate, reviewerMeta: input.reviewerMeta },
      {
        admission: { kind: "new" },
        resolveEvidenceRef: input.resolveEvidenceRef,
        path,
        ...(input.repoRoot !== undefined ? { repoRoot: input.repoRoot } : {}),
      },
    );
    if (!result.ok) return result;
    admitted.push(result.value.finding);
  }
  const set = validateFindingSet(admitted);
  if (!set.ok) return set;
  return { ok: true, value: { findings: set.value, attachments } };
}

// ---------------------------------------------------------------------------
// Bounded persistence (§10.1)
// ---------------------------------------------------------------------------

/**
 * Build the §10.1 context block for a review that admitted `findings`.
 *
 * Every lineage this review opens is `open` at version 1 with zero counters: the
 * admission fact of a first structured finding and nothing more. The block is
 * validated through the #836 context validator and then serialized under its own
 * 32 KB bound, so a block that cannot be persisted is reported as a failure
 * rather than written half-formed.
 *
 * `prior` is the validated §10.1 block a previous review of the same task
 * persisted. The written block REPLACES the stored one (task context is merged
 * shallowly), so its lineages are carried through VERBATIM — dropping them would
 * erase an open lineage on the ordinary `needs_fix` → implementation → review
 * loop, and rewriting one would be a §7 transition this Issue does not own.
 *
 * Its two run-level flags are carried for the same reason. `pendingReReview`
 * records that some earlier fix's diff still owes an ordinary review; clearing it
 * here would let a later aggregation treat that diff as reviewed, so it is
 * carried unconditionally — and safely, because the #836 validator's only
 * cross-field rule pairs it with a `resolvedWithoutChanges` that a validated
 * prior block can never have set alongside it. `resolvedWithoutChanges` is
 * carried too, except onto a block §13 forbids to hold it: that flag asserts a
 * no-diff-required run, which only a fully structured review may claim, and a
 * mixed run's own prose blocks regardless — so the carry is dropped there rather
 * than rejecting an otherwise valid envelope into a loop no later review could
 * escape. Neither flag is ever set, cleared, or reinterpreted here; consuming
 * them is a §7 transition and #840 owns it.
 *
 * A re-raise of one of them never reaches here as a finding — admission attaches
 * it to the persisted lineage instead — so the id guard below is defense in
 * depth: whatever state and counters #840 wrote on a lineage are not this
 * Issue's to reset, so an id already on file keeps its record whatever produced
 * the collision.
 */
export function buildInitialLineageContext(
  findings: readonly ReviewFinding[],
  reviewStructure: ReviewDisputeContext["reviewStructure"],
  limits?: ReviewDisputeLimits,
  prior?: Readonly<Pick<ReviewDisputeContext, "lineages" | "pendingReReview" | "resolvedWithoutChanges">>,
): ReviewDisputeResult<{ context: ReviewDisputeContext; serialized: string }> {
  // Null-prototype, mirroring the #836 context validator: a lineage id is always
  // runner-minted and could never be `__proto__`, but on a plain object such a
  // key would set the prototype instead of adding an entry — the lineage would
  // silently vanish rather than be rejected below.
  const lineages = Object.create(null) as Record<string, PersistedLineage>;
  if (prior !== undefined) {
    for (const [lineageId, lineage] of Object.entries(prior.lineages)) {
      lineages[lineageId] = lineage;
    }
  }
  for (const finding of findings) {
    if (lineages[finding.lineageId] !== undefined) continue;
    lineages[finding.lineageId] = {
      lineageId: finding.lineageId,
      state: "open",
      version: finding.version,
      counters: { ...ZERO_LINEAGE_COUNTERS },
      rebuttedVersions: [],
      humanGate: finding.humanGate,
      severity: finding.severity,
      affectedBoundary: finding.affectedBoundary,
    };
  }
  // The carry is dropped in exactly one case: a `true` flag on a block §13
  // denies the zero-change claim. An explicit `false` says the same thing as the
  // field's absence and is representable under every structure, so it rides
  // along like any other prior fact.
  const pendingReReview = prior?.pendingReReview;
  const priorResolved = prior?.resolvedWithoutChanges;
  const resolvedWithoutChanges =
    priorResolved === true && !reviewStructureAllowsZeroChange(reviewStructure) ? undefined : priorResolved;
  const draft = {
    version: 1 as const,
    reviewStructure,
    lineages,
    ...(pendingReReview === undefined ? {} : { pendingReReview }),
    ...(resolvedWithoutChanges === undefined ? {} : { resolvedWithoutChanges }),
  };
  const validated = validateReviewDisputeContext(draft, "reviewDispute", limits);
  if (!validated.ok) return validated;
  const serialized = serializeReviewDisputeContext(validated.value);
  if (!serialized.ok) return serialized;
  return { ok: true, value: { context: validated.value, serialized: serialized.value } };
}

// ---------------------------------------------------------------------------
// Read-only evidence resolution (§3.3)
// ---------------------------------------------------------------------------

export interface ReviewEvidenceIndex {
  /**
   * Repository-relative paths of the tracked regular files of the reviewed
   * checkout — the §3.3 admission posture's whole scope. Built by the caller from
   * one `git ls-files` capture, so the membership half of resolution costs no
   * further I/O and is deterministic for a given tree.
   */
  trackedFiles: ReadonlySet<string>;
  /**
   * Reads the text of one tracked file, or returns `undefined` when its content
   * cannot be read within the caller's bounds (unreadable, oversized, binary).
   *
   * A `file` or `doc_section` reference names a location INSIDE a document, so
   * membership in {@link trackedFiles} cannot settle it on its own: the content is
   * what says whether the cited lines or heading are there. Reads are lazy and
   * cached per path for the resolver's lifetime, so an envelope citing one file
   * ten times reads it once and every repeat resolution answers identically.
   *
   * Omitting the reader leaves `file` and `doc_section` unverifiable, and an
   * unverifiable reference does not resolve.
   */
  readTrackedFile?: (path: string) => string | undefined;
  /** The Issue body, when available, so an `issue_quote` can be checked against it. */
  issueBody?: string;
}

function normalizeQuote(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/** What a cited document has to offer a §3.3 reference: extent, and named parts. */
interface TrackedFileFacts {
  /** Lines in the file, ignoring a single trailing newline. */
  lineCount: number;
  /** Normalized text of every ATX markdown heading, in document order. */
  headings: readonly string[];
}

/** `## §7.1 Diff-bearing runs` → `§7.1 Diff-bearing runs`, closing hashes dropped. */
const ATX_HEADING = /^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/;

/**
 * Derive the checkable facts of one document, or `null` when it has none.
 *
 * A NUL byte means the "file" is binary, so neither a line range nor a heading is
 * a meaningful claim about it — the reference is declined rather than resolved
 * against byte noise that happens to contain newlines.
 */
function trackedFileFacts(content: string): TrackedFileFacts | null {
  if (content.includes("\0")) return null;
  const lines = content.split("\n");
  // A file ending in a newline has no line after it; `split` reports an empty one.
  if (lines[lines.length - 1] === "") lines.pop();
  const headings: string[] = [];
  for (const line of lines) {
    const match = ATX_HEADING.exec(line);
    if (match) headings.push(normalizeQuote(match[1]!));
  }
  return { lineCount: lines.length, headings };
}

/**
 * A bounded, read-only §3.3 resolver over one checkout.
 *
 * §3.3 admits a finding only when EVERY one of its references resolves, so this
 * resolver answers `true` for exactly the references it has actually checked and
 * `false` for everything else — including a reference it merely cannot check.
 * "Unverified" and "verified present" are the same admission here, and the
 * unverified one is the one that mints an open lineage and routes the diff to
 * `needs_fix` on evidence nobody confirmed exists.
 *
 * `file` and `doc_section` references name repository locations, so they resolve
 * against the tracked-file set first: an untracked, ignored, symlinked, or
 * gitlinked path resolves to nothing, which is the posture the repository
 * evidence contract already holds research to. A tracked path is only half the
 * claim, though — both forms cite a place INSIDE the document, so the cited place
 * is checked too:
 *  - a `file` range must lie within the file's actual extent, so a citation of
 *    lines past the end of a real file is a failed resolution rather than a
 *    blocking finding admitted on a range nobody could read;
 *  - a `doc_section` must name a heading the document actually carries, matched on
 *    whitespace- and case-normalized heading text so `§7.1` resolves against
 *    `## §7.1 Diff-bearing runs` but an invented section resolves against nothing.
 *
 * Both checks need the file's content, which arrives through
 * {@link ReviewEvidenceIndex.readTrackedFile}. With no reader, or for content the
 * reader declines to hand over (oversized, unreadable, binary), the reference is
 * unchecked — and unchecked does not resolve.
 *
 * An `issue_quote` resolves against the Issue body — and only against a body
 * this run actually captured. With no body, there is nothing to compare the
 * quote to, and an unavailable comparison is a failed one.
 *
 * A `test` reference never resolves here. Deciding whether a named test exists
 * means running or parsing the suite, which #836 assigns to the pipeline
 * resolver of #842 (§3.3) — until that lands, this runner cannot tell a real
 * test name from an invented one, so it declines the reference rather than
 * admitting it unchecked. {@link reviewResolvableEvidenceKinds} keeps the prompt
 * from asking reviewers for evidence this resolver would refuse.
 */
export function createReviewEvidenceResolver(index: ReviewEvidenceIndex): EvidenceRefResolver {
  const body = index.issueBody === undefined ? undefined : normalizeQuote(index.issueBody);
  const read = index.readTrackedFile;
  const facts = new Map<string, TrackedFileFacts | null>();
  const factsFor = (path: string): TrackedFileFacts | null => {
    if (!index.trackedFiles.has(path) || read === undefined) return null;
    if (!facts.has(path)) {
      const content = read(path);
      facts.set(path, content === undefined ? null : trackedFileFacts(content));
    }
    return facts.get(path) ?? null;
  };
  return (ref) => {
    switch (ref.kind) {
      case "file": {
        const file = factsFor(ref.path);
        if (file === null) return false;
        // The #836 validator already bounds these, but the resolver is exported on
        // its own: a range that is inverted or starts before line 1 names no lines
        // at all, so it cannot resolve regardless of the file.
        if (ref.startLine < 1 || ref.endLine < ref.startLine) return false;
        return ref.endLine <= file.lineCount;
      }
      case "doc_section": {
        const doc = factsFor(ref.path);
        if (doc === null) return false;
        const section = normalizeQuote(ref.section);
        if (section === "") return false;
        return doc.headings.some((heading) => heading.includes(section));
      }
      case "issue_quote":
        return body !== undefined && body.includes(normalizeQuote(ref.quote));
      case "test":
        return false;
    }
  };
}

/**
 * The evidence kinds {@link createReviewEvidenceResolver} can verify read-only,
 * given whether this run captured the Issue body.
 *
 * The prompt is generated from this, so the instruction the reviewer reads and
 * the resolver the runner applies cannot drift: a kind absent here is a kind the
 * reviewer is told not to use, rather than one it emits in good faith and has
 * its whole review rejected for.
 */
export function reviewResolvableEvidenceKinds(opts: { issueBodyAvailable: boolean }): readonly string[] {
  return opts.issueBodyAvailable ? ["file", "doc_section", "issue_quote"] : ["file", "doc_section"];
}

// ---------------------------------------------------------------------------
// Review-agent compatibility (§13)
// ---------------------------------------------------------------------------

export type StructuredFindingsSupport =
  | { supported: true }
  | { supported: false; reason: "prompt-not-agent-authored" };

/**
 * Agents whose review output format this runner does not author, and which
 * therefore cannot be asked for the envelope.
 *
 * `codex review` is its own subcommand: the runner hands it a `--title` brief and
 * a `--base`, and Codex composes the report itself. There is no place to put an
 * output contract that Codex is obliged to honor, so requiring one would produce
 * a permanently malformed envelope rather than a structured review.
 */
export const STRUCTURED_FINDINGS_UNSUPPORTED_AGENTS: readonly string[] = ["codex"];

/**
 * The explicit compatibility path for a review agent that cannot emit the schema.
 *
 * §13 makes this a recorded, inert outcome rather than a hard error: the run
 * keeps today's free-form semantics end to end, the envelope instruction is never
 * added to the prompt, and no parse is attempted — so the reason an operator sees
 * is the configured agent, not a phantom malformed envelope from an agent that
 * was never asked for one.
 */
export function structuredFindingsSupport(agentId: string): StructuredFindingsSupport {
  return STRUCTURED_FINDINGS_UNSUPPORTED_AGENTS.includes(agentId)
    ? { supported: false, reason: "prompt-not-agent-authored" }
    : { supported: true };
}

/**
 * §2.1: stamp `humanGate` from the runner's own state, never from agent output.
 *
 * The existing human-gate mechanism in this repository is the task-level gate
 * record (`task.context.humanGate`, docs/human-gate-no-go-flow.md). A LIVE gate
 * — one an operator opened and has not resolved — is the recorded statement that
 * this task's behavior currently requires human approval, so findings admitted
 * while it is live are stamped `true` and §7 rows 3/7 route a dispute on them to
 * a human instead of to automation. A resolved gate is a closed audit record and
 * stamps nothing.
 *
 * This is the single seam: when a per-finding human-approval flag lands, it
 * replaces this function's body and no admission code changes.
 */
export function resolveFindingHumanGate(taskContext: Record<string, unknown> | undefined): boolean {
  const gate = taskContext?.["humanGate"];
  if (gate === null || typeof gate !== "object" || Array.isArray(gate)) return false;
  const state = (gate as Record<string, unknown>)["state"];
  return state === "open" || state === "applying" || state === "apply_failed" || state === "held";
}

// ---------------------------------------------------------------------------
// The review turn, end to end
// ---------------------------------------------------------------------------

export interface ProcessReviewFindingsInput {
  /** The review run's raw stdout/stderr, exactly as captured to the artifact. */
  output: string;
  reviewerMeta: ReviewerMeta;
  humanGate: boolean;
  resolveEvidenceRef: EvidenceRefResolver;
  repoRoot?: string;
  limits?: ReviewDisputeLimits;
  /**
   * The `task.context.reviewDispute` block a previous review of this task
   * persisted, exactly as stored. Validated through the #836 contract before any
   * of it is carried forward, so a tampered or unreadable block fails the whole
   * review closed rather than being partially trusted or silently discarded.
   */
  priorContext?: unknown;
}

export type ReviewFindingsOutcome =
  /** §13: no envelope. The protocol is inert; today's routing is unchanged. */
  | { kind: "legacy"; structure: ReviewStructureClassification; residual: string }
  /** §12: an envelope was emitted and could not be admitted. Nothing is persisted. */
  | { kind: "rejected"; failure: ReviewDisputeFailure }
  | {
      kind: "admitted";
      status: ReviewEnvelopeStatus;
      blockedReason?: ReviewBlockedReason;
      findings: ReviewFinding[];
      /**
       * §2.2 re-raises of lineages an earlier review opened. They record nothing
       * new, but they are blocking exactly as `findings` are — a caller that
       * counts only `findings` would pass a review that re-asserted every one of
       * its predecessor's open defects.
       */
      attachments: ReviewFindingAttachment[];
      context: ReviewDisputeContext;
      /**
       * §10.2: the serialized full records, ready to write to the local artifact.
       * Produced here rather than by the caller so an artifact that cannot be
       * serialized rejects the whole envelope instead of leaving the persisted
       * lineages without the records later protocol handling reads.
       */
      findingsArtifact: string;
      structure: ReviewStructureClassification;
      residual: string;
      ignoredRunnerOwnedFields: string[];
      /** How many lineages of a previous review were carried into `context`. */
      retainedLineages: number;
    };

/**
 * Extract, parse, admit, and bound one review run's structured output.
 *
 * Deterministic by construction: every step is a pure function of `output`, the
 * validated prior block, and the injected run metadata; the only identifier it
 * creates is derived from
 * the finding's own §2.2 identity tuple. Parsing the same output twice therefore
 * yields byte-identical lineage ids, versions, and persisted block.
 *
 * Fail-closed by construction too: the persisted block and the §10.2 artifact
 * are both produced before anything is returned, so a rejection at any step —
 * including a record too large to serialize — leaves no lineage behind and never
 * a lineage without its records.
 */
export function processReviewFindings(input: ProcessReviewFindingsInput): ReviewFindingsOutcome {
  const extracted = extractReviewFindingsEnvelope(input.output);
  if (extracted.kind === "failure") return { kind: "rejected", failure: extracted.failure };
  if (extracted.kind === "absent") {
    return {
      kind: "legacy",
      structure: classifyReviewStructure({ structuredFindingCount: 0, residualFeedback: extracted.residual }),
      residual: extracted.residual,
    };
  }

  const parsed = parseReviewFindingsEnvelope(
    extracted.payload,
    input.repoRoot !== undefined ? { repoRoot: input.repoRoot } : {},
  );
  if (!parsed.ok) return { kind: "rejected", failure: parsed.failure };

  // A task re-enters review after every implementation fix, and the block this
  // run writes replaces the stored one wholesale. What an earlier review
  // persisted is therefore re-validated FIRST — before admission, because a
  // candidate that re-raises one of those lineages attaches to it rather than
  // opening a second debate (§2.2) — and carried forward afterwards, so the
  // ordinary loop does not lose the lineages it opened. Failing closed here
  // rather than dropping the block keeps a corrupt one from being overwritten by
  // this run's partial view.
  let priorBlock: ReviewDisputeContext | undefined;
  if (input.priorContext !== undefined && input.priorContext !== null) {
    const prior = validateReviewDisputeContext(input.priorContext, "priorReviewDispute", input.limits);
    if (!prior.ok) return { kind: "rejected", failure: prior.failure };
    priorBlock = prior.value;
  }
  const priorLineages = priorBlock?.lineages;

  const admitted = admitReviewFindings({
    candidates: parsed.value.candidates,
    reviewerMeta: input.reviewerMeta,
    humanGate: input.humanGate,
    resolveEvidenceRef: input.resolveEvidenceRef,
    ...(input.repoRoot !== undefined ? { repoRoot: input.repoRoot } : {}),
    ...(priorLineages !== undefined ? { priorLineages } : {}),
  });
  if (!admitted.ok) return { kind: "rejected", failure: admitted.failure };

  // §10.2: the full records are a local artifact, but they are serialized HERE,
  // as part of admission. A finding whose record cannot be written is a finding
  // whose persisted lineage would point at nothing, so the whole envelope is
  // refused rather than persisted without the records it refers to. A re-raise
  // records no new version, so only the lineage it attached to is noted — its
  // record lives in the artifact directory of the run that admitted it.
  const artifact = serializeRecord({
    findings: admitted.value.findings,
    ...(admitted.value.attachments.length > 0 ? { attachments: admitted.value.attachments } : {}),
  });
  if (!artifact.ok) {
    return {
      kind: "rejected",
      failure: {
        reason: artifact.failure.reason,
        detail: `findingsArtifact:${artifact.failure.detail ?? "unserializable"}`,
      },
    };
  }

  // §13 counts BLOCKS, not findings: a `success` envelope with no findings is a
  // fully structured review, and classifying it as legacy would deny it the
  // zero-change validity §3.4 grants exactly that shape.
  const structure = classifyReviewStructure({
    structuredFindingCount: 1,
    residualFeedback: extracted.residual,
  });

  // The whole prior block is carried — lineages and both run-level flags —
  // including on a plain `success` envelope, whose own lineage map is empty.
  // `pendingReReview` and `resolvedWithoutChanges` describe the outcome of one
  // particular run (§7.1), so whether this review clears or re-asserts them is a
  // transition decision and #840 owns every one of those; until it does, this
  // run's block preserves them rather than silently dropping them by replacing
  // the stored context (see {@link buildInitialLineageContext}).
  const built = buildInitialLineageContext(admitted.value.findings, structure.mode, input.limits, priorBlock);
  if (!built.ok) return { kind: "rejected", failure: built.failure };

  return {
    kind: "admitted",
    retainedLineages: priorLineages === undefined ? 0 : Object.keys(priorLineages).length,
    status: parsed.value.status,
    ...(parsed.value.blockedReason !== undefined ? { blockedReason: parsed.value.blockedReason } : {}),
    findings: admitted.value.findings,
    attachments: admitted.value.attachments,
    context: built.value.context,
    findingsArtifact: artifact.value,
    structure,
    residual: extracted.residual,
    ignoredRunnerOwnedFields: parsed.value.ignoredRunnerOwnedFields,
  };
}

// ---------------------------------------------------------------------------
// Prompt contract
// ---------------------------------------------------------------------------

/** The bounded, literals-only view of an open lineage the prompt may show. */
export interface ReviewPromptLineage {
  lineageId: string;
  /**
   * The lineage's recorded version. Shown because §2.3 makes an attach land on
   * exactly that version, so a reviewer told only "use version 1" would emit a
   * stale reference the moment #840 can advance a lineage past its first.
   */
  version: number;
  severity: FindingSeverity;
  affectedBoundary: string;
}

/**
 * The open lineages of a persisted §10.1 block, in the order the prompt lists
 * them.
 *
 * Only these four fields, and only for non-terminal lineages: every one of them
 * is already §11-publishable, so nothing an earlier reviewer wrote as prose is
 * replayed into a later reviewer's prompt. Sorted by id so the same block always
 * renders the same brief.
 */
export function openLineagePrompts(context: ReviewDisputeContext): ReviewPromptLineage[] {
  return Object.values(context.lineages)
    .filter((lineage) => !isTerminalLineageState(lineage.state))
    .map((lineage) => ({
      lineageId: lineage.lineageId,
      version: lineage.version,
      severity: lineage.severity,
      affectedBoundary: lineage.affectedBoundary,
    }))
    .sort((a, b) => (a.lineageId < b.lineageId ? -1 : a.lineageId > b.lineageId ? 1 : 0));
}

/**
 * The output contract appended to the review brief when the protocol is enabled
 * and the configured agent can honor it.
 *
 * Written as a closed instruction: the reviewer chooses one status, and the
 * fields it may use are enumerated. Prose is not forbidden — §13 keeps it
 * blocking — but the instruction states plainly that prose is not actionable
 * inside the protocol, so a reviewer who wants a finding disputed emits it here.
 *
 * The evidence kinds offered are exactly the ones this run can verify read-only
 * (§3.3). Anything else would be refused at admission, taking the whole envelope
 * with it, so the reviewer is told up front to cite what can be checked.
 *
 * `liveLineages` follows the same rule for the one runner-owned field an agent
 * may echo. §2.2 lets a re-raise name the lineage it belongs to, and admission
 * rejects an id this task has no lineage for — so the reviewer is shown exactly
 * the ids that will attach, and is told not to invent one. A run with none says
 * nothing about lineage ids at all, which is the first review of a task and the
 * brief this function has always produced.
 */
export function reviewFindingsInstructions(
  opts: { issueBodyAvailable?: boolean; liveLineages?: readonly ReviewPromptLineage[] } = {},
): string {
  const resolvable = reviewResolvableEvidenceKinds({ issueBodyAvailable: opts.issueBodyAvailable === true });
  const liveLineages = opts.liveLineages ?? [];
  const evidenceForms = [
    '  `{"kind": "file", "path": "<repo-relative>", "startLine": <n>, "endLine": <n>}`',
    '  `{"kind": "doc_section", "path": "docs/<file>", "section": "<section>"}`',
    ...(resolvable.includes("issue_quote")
      ? ['  `{"kind": "issue_quote", "quote": "<verbatim span of the issue body>"}`']
      : []),
  ].map((form, i, all) => `${form}${i === all.length - 1 ? "." : ","}`);
  return [
    "## Structured Finding Output (required)",
    "",
    `After your review report, emit EXACTLY ONE structured envelope between \`${REVIEW_FINDINGS_MARKER}\``,
    `and \`${REVIEW_FINDINGS_END_MARKER}\`, each marker alone on its own line. The content between the`,
    "markers must be a single JSON object and nothing else — no code fence, no commentary.",
    "",
    "Choose exactly one status:",
    "",
    `- \`success\` — no blocking finding. Emit \`{"version": 1, "status": "success"}\`.`,
    "- `blocked` — you could not complete the review. Emit `{\"version\": 1, \"status\": \"blocked\", \"blockedReason\": \"<reason>\"}`",
    `  where \`<reason>\` is one of: ${REVIEW_BLOCKED_REASONS.map((r) => `\`${r}\``).join(", ")}.`,
    `- \`findings\` — one or more blocking findings. Emit \`{"version": 1, "status": "findings", "findings": [ … ]}\``,
    `  with 1–${MAX_FINDINGS_PER_REVIEW} finding objects.`,
    "",
    "Each finding object has exactly these fields, all required:",
    "",
    liveLineages.length > 0
      ? "- `version`: the number `1`, unless you are re-raising one of the open findings listed below."
      : "- `version`: the number `1`.",
    '- `severity`: `"P1"` or `"P2"`. Only blocking severities belong here; never emit a cosmetic nit.',
    "- `violatedContract`: the invariant, issue requirement, or acceptance criterion the diff violates, quoted or precisely named.",
    "- `preconditions`: the state or input assumptions under which the violation occurs.",
    "- `failureScenario`: concrete inputs/state → wrong output, crash, or contract breach.",
    "- `affectedBoundary`: the file, module, or API surface, named repository-relative (never an absolute path).",
    "- `requiredOutcome`: what a correct implementation must observably do.",
    `- \`evidenceRefs\`: 1–${MAX_EVIDENCE_REFS_PER_RECORD} references, each one of:`,
    ...evidenceForms,
    "",
    "Every reference is resolved against this checkout before the finding is accepted, and a finding carrying one",
    "that does not resolve is DISCARDED along with the rest of the envelope. Cite tracked files that exist at the",
    "paths you give, with a line range that lies inside the file; for `doc_section`, `section` must match a heading",
    `the document actually carries. Use only the reference forms listed above (${resolvable.join(", ")}) — no other`,
    "kind can be verified on this run. Name a test in `failureScenario` prose instead of citing it as evidence.",
    "",
    ...(liveLineages.length > 0
      ? [
          "An earlier review of this branch opened the findings below, and they are still open:",
          "",
          ...liveLineages.map(
            (l) => `- \`${l.lineageId}\` (version ${l.version}) — ${l.severity} at \`${l.affectedBoundary}\``,
          ),
          "",
          "If one of your findings is the SAME defect as one of these, set its `lineageId` to that id and its `version` to",
          "the version shown for it, so the re-raise attaches to the existing finding instead of opening a second one about",
          "the same defect. An attached finding keeps its recorded wording — the rest of your text for it is ignored. Use an",
          "id ONLY from the list above; any other value is rejected and takes the whole envelope with it. Omit `lineageId`",
          "entirely (and give `version` as the number `1`) for a defect that is not on the list.",
          "",
          "Do not set `humanGate` or `reviewerMeta` — those are runner-owned and any value you supply is discarded.",
        ]
      : [
          "Do not set `lineageId`, `humanGate`, or `reviewerMeta` — those are runner-owned and any value you supply is discarded.",
        ]),
    "",
    "Prose outside the envelope is read as free-form review feedback and is not actionable inside the finding protocol;",
    "emit anything you want tracked as a blocking finding inside the envelope.",
  ].join("\n");
}
