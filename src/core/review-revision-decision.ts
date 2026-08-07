/**
 * Issue #845: the deterministic material-revision decision (§5, §7 rows 11, 12
 * and 26 of docs/review-dispute-contract.md).
 *
 * This is the layer between #838's reviewer-reconsideration invocation and the
 * transition/routing work that follows it. #838 admits exactly one validated
 * `withdraw` / `uphold` / `revise` record and deliberately stops there: it does
 * not classify a `revise`, mutate lineage state, consume a counter, grant
 * another rebuttal, or choose a phase. This module answers exactly one further
 * question — *what does an admitted `revise` mean for the debate?* — and stops
 * there in turn.
 *
 * Everything here is a pure function of already-validated values. There is no
 * second materiality algorithm: the §5 comparison is
 * {@link classifyRevisionMateriality} and the §2.3/§4.2 predecessor rule is
 * {@link checkPredecessor}, both from #836. What this module adds is the
 * decision *around* those primitives — the version budget, the bounded-debate
 * gates, and the typed next intent.
 *
 * What it deliberately does NOT do:
 *
 *  - invoke the reviewer, or re-parse raw agent output (that is #838's boundary,
 *    and the admitted record is its only exported truth);
 *  - persist the transition, write the successor version, or touch task context;
 *  - consume a §6.1 counter — every counter here is READ, never advanced;
 *  - resolve or invoke the arbiter, or choose a phase, label, or comment.
 *
 * ## The bounded-debate contract, stated as invariants
 *
 * Three properties hold for every value this module returns, including every
 * fail-closed one:
 *
 *  1. `implementationResponsesGranted` is 1 only for a structurally MATERIAL
 *     revision that has successor-version budget (row 11). A non-material or
 *     ambiguous revision never resets or extends the rebuttal allowance (§5,
 *     §6.2) — it routes to arbitration with 0.
 *  2. `furtherReconsiderationAllowed` is the literal `false`, so no code path
 *     can widen it: §6.2's "no third implementation/reviewer debate round" means
 *     a version-2 dispute proceeds directly to arbitration (row 6), never to a
 *     second reviewer reconsideration.
 *  3. No version above the session's budget — and never above
 *     {@link ABSOLUTE_MAX_VERSION} — is ever admitted. Under the lowered
 *     `MAX_VERSIONS_PER_LINEAGE = 1` the §4.2 candidate is still required and
 *     still compared, but it stays UNPERSISTED and the lineage arbitrates at its
 *     disputed version (row 26).
 */

import {
  ABSOLUTE_MAX_VERSION,
  REVIEW_DISPUTE_DEFAULT_LIMITS,
  type CandidateFinding,
  type DisputeAuditEvent,
  type FindingFieldName,
  type PersistedLineage,
  type ReviewDisputeLimits,
  type ReviewFinding,
  type RevisionRecord,
} from "./review-dispute.js";
import {
  checkPredecessor,
  classifyRevisionMateriality,
  type MaterialityOptions,
  type MaterialityResult,
  type PredecessorProblem,
} from "./review-dispute-lineage.js";
import {
  type AdmittedReconsideration,
  type ReviewDisputeFailure,
  type ReviewDisputeFailureReason,
} from "./review-dispute-validation.js";

// ---------------------------------------------------------------------------
// Result vocabulary
// ---------------------------------------------------------------------------

export const REVISION_DECISION_INTENTS = [
  /** Row 11: a material revision with version budget; version 2 opens for ONE final response. */
  "final_implementation_response",
  /** Rows 12 and 26: the lineage proceeds to arbitration; no further debate round. */
  "arbitration",
  /** `withdraw` / `uphold`: there is no revision to classify, and rows 9/10 are not this module's. */
  "no_revision",
  /** §12: fail closed. No state changes, no counter is consumed, nobody wins. */
  "rejected",
] as const;
export type RevisionDecisionIntent = (typeof REVISION_DECISION_INTENTS)[number];

/** The §7 rows this module can instantiate. */
export const REVISION_DECISION_ROWS = [11, 12, 26] as const;
export type RevisionDecisionRow = (typeof REVISION_DECISION_ROWS)[number];

/**
 * A discrepancy between what the reviewer DECLARED about its own revision and
 * what the recorded values actually show.
 *
 * None of these changes the decision — §5 decides on values — but all of them
 * are recorded, because a declaration that disagrees with the values is exactly
 * the signal an auditor needs and exactly the thing a self-interested party
 * would use to steer the outcome if it were trusted.
 */
export const REVISION_DECLARATION_DISCREPANCIES = [
  /** A field that actually differs was left out of `changedFields`. */
  "undeclared-change",
  /** A declared field whose values compare equal (§5: the entry is ignored). */
  "declared-unchanged",
  /** Nothing differs at all: every declared field is stale. */
  "no-effective-change",
  /** `materialityClaim: true` over a revision the structural check calls non-material or ambiguous. */
  "overclaimed-materiality",
  /** `materialityClaim: false` over a revision the structural check calls material. */
  "underclaimed-materiality",
] as const;
export type RevisionDeclarationDiscrepancy = (typeof REVISION_DECLARATION_DISCREPANCIES)[number];

/** §4.2 / §5: the reviewer's own account of its revision, graded against the values. */
export interface RevisionDeclarationAudit {
  /** `changedFields` exactly as declared (§4.2). */
  declaredFields: FindingFieldName[];
  /** The fields that actually differ, declared or not — what the decision was made on. */
  effectiveChangedFields: FindingFieldName[];
  /** Declared but equal once normalized; ignored by §5. */
  ignoredDeclaredFields: FindingFieldName[];
  /** Actually changed but undeclared; still decided on, never hidden. */
  undeclaredChangedFields: FindingFieldName[];
  /**
   * Whether `changedFields` matches the values exactly. A false value never
   * changes the outcome — it neither hides a material change nor manufactures
   * one — it only tells the audit record that the declaration was unreliable.
   */
  changedFieldsHonest: boolean;
  /** §5, §14.2: audit input only. The interested party does not grade its own revision. */
  materialityClaim: boolean;
  /** Whether that claim agreed with the runner's structural classification. */
  claimMatchedDecision: boolean;
  discrepancies: RevisionDeclarationDiscrepancy[];
}

/**
 * The typed next intent. Deterministic: the same lineage, versions, admitted
 * record, and limits always produce the same value, field for field.
 */
export interface RevisionDecision {
  intent: RevisionDecisionIntent;
  lineageId: string;
  /** The §7 row this decision instantiates, or null when none fires. */
  row: RevisionDecisionRow | null;
  /**
   * The lineage state the transition owner should write, or null when nothing
   * changes (a fail-closed rejection, or a `withdraw`/`uphold` this module does
   * not route). Writing it is downstream work; naming it is the decision.
   */
  nextState: "open" | "arbitration_pending" | null;
  /** The lineage's current version — the version under dispute. */
  disputedVersion: number;
  /** The version the lineage carries afterwards: the successor on row 11, unchanged otherwise. */
  versionAfter: number;
  /** The §4.2 successor candidate, or null when no revision was classified. */
  candidate: CandidateFinding | null;
  /**
   * Row 11 only: the candidate is admitted as the lineage's next version.
   *
   * False on rows 12 and 26 — there the candidate stays UNPERSISTED and travels
   * to the arbiter inside the reconsideration record (§4.2, §8.2), which is why
   * it is still returned.
   */
  candidateAdmitted: boolean;
  /** §6.2: exactly one final implementation response on row 11, none anywhere else. */
  implementationResponsesGranted: 0 | 1;
  /** §6.2, invariant 2: never. Typed as the literal so it cannot be widened. */
  furtherReconsiderationAllowed: false;
  /** The §5 classification, or null when no revision was classified. */
  materiality: MaterialityResult | null;
  declaration: RevisionDeclarationAudit | null;
  /** §10.3: exactly the event the classification emits — one, or none. */
  auditEvents: DisputeAuditEvent[];
  /** The §2.3/§4.2 predecessor rule that failed, when one did. */
  predecessorProblem: PredecessorProblem | null;
  failure: ReviewDisputeFailure | null;
}

export interface RevisionDecisionInput {
  /**
   * #838's admitted result: the one validated reconsideration record plus the
   * persisted lineage it was admitted against. The lineage is read from here
   * rather than passed separately on purpose — admission already resolved it
   * from `task.context.reviewDispute`, and a second copy could disagree with the
   * record that was admitted against the first.
   */
  admitted: AdmittedReconsideration;
  /**
   * The lineage's recorded §2.1 finding versions (the §10.2 findings artifact),
   * in any order. These carry the predecessor's field VALUES, which the persisted
   * §10.1 record deliberately does not: it holds literals and counters only, so
   * the structural comparison of §5 cannot be made from it alone.
   */
  versions: readonly ReviewFinding[];
  /** The session's resolved §6.1 limits. Defaults to the normative maxima. */
  limits?: ReviewDisputeLimits;
  /**
   * §5 evidence predicate, passed straight through to the classifier: added
   * `evidenceRefs` are material only when the added executable evidence
   * invalidates a premise of the prior rebuttal. Resolving that is I/O, so it is
   * the caller's to inject; without it an evidence-only change is non-material,
   * which routes to arbitration (row 12) rather than ending the debate.
   */
  materialityOptions?: MaterialityOptions;
}

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

function baseDecision(lineage: PersistedLineage): RevisionDecision {
  return {
    intent: "rejected",
    lineageId: lineage.lineageId,
    row: null,
    nextState: null,
    disputedVersion: lineage.version,
    versionAfter: lineage.version,
    candidate: null,
    candidateAdmitted: false,
    implementationResponsesGranted: 0,
    furtherReconsiderationAllowed: false,
    materiality: null,
    declaration: null,
    auditEvents: [],
    predecessorProblem: null,
    failure: null,
  };
}

/**
 * §12: a rejection changes no state and consumes no counter, so it carries no
 * row, no next state, and no granted response — only the reason it failed.
 *
 * The audit event is `dispute.rebuttal.rejected`, which §10.3 names for
 * malformed output that changes no state, uniformly for implementer and
 * reviewer output (§12).
 */
function rejected(
  lineage: PersistedLineage,
  reason: ReviewDisputeFailureReason,
  detail: string,
  predecessorProblem: PredecessorProblem | null = null,
): RevisionDecision {
  return {
    ...baseDecision(lineage),
    intent: "rejected",
    auditEvents: ["dispute.rebuttal.rejected"],
    predecessorProblem,
    failure: { reason, detail },
  };
}

/** Map a §2.3/§4.2 predecessor problem to the failure vocabulary of §12. */
function predecessorFailureReason(problem: PredecessorProblem): ReviewDisputeFailureReason {
  switch (problem) {
    // The named predecessor is not on file, or the lineage has moved past it:
    // either way the revision answers a version that is not the live one.
    case "predecessor-not-found":
    case "predecessor-not-current":
      return "stale-version";
    // Two records claim the same version, so "exactly one predecessor" does not
    // hold and no comparison can be trusted.
    case "predecessor-ambiguous":
      return "duplicate-version";
    // The successor already exists: a version is immutable once recorded (§2.3).
    case "successor-version-exists":
      return "duplicate-version";
    // A skipped, repeated, or over-the-ceiling successor number.
    case "successor-not-incremental":
      return "invalid-version";
  }
}

function auditDeclaration(revision: RevisionRecord, materiality: MaterialityResult): RevisionDeclarationAudit {
  const effectiveChangedFields = materiality.changes
    .filter((change) => change.classification !== "unchanged")
    .map((change) => change.field);
  const decidedMaterial = materiality.classification === "material";
  const discrepancies: RevisionDeclarationDiscrepancy[] = [];
  if (materiality.undeclaredChangedFields.length > 0) discrepancies.push("undeclared-change");
  if (materiality.ignoredDeclaredFields.length > 0) discrepancies.push("declared-unchanged");
  if (effectiveChangedFields.length === 0) discrepancies.push("no-effective-change");
  if (revision.materialityClaim && !decidedMaterial) discrepancies.push("overclaimed-materiality");
  if (!revision.materialityClaim && decidedMaterial) discrepancies.push("underclaimed-materiality");
  return {
    declaredFields: [...revision.changedFields],
    effectiveChangedFields,
    ignoredDeclaredFields: [...materiality.ignoredDeclaredFields],
    undeclaredChangedFields: [...materiality.undeclaredChangedFields],
    changedFieldsHonest:
      materiality.undeclaredChangedFields.length === 0 && materiality.ignoredDeclaredFields.length === 0,
    materialityClaim: revision.materialityClaim,
    claimMatchedDecision: revision.materialityClaim === decidedMaterial,
    discrepancies,
  };
}

/**
 * Decide what an admitted #838 reconsideration means for the debate.
 *
 * Never throws: an unusable input is an outcome, not an exception, because §12's
 * effect for malformed input is that no protocol state changes — which a caller
 * can only apply if it gets a value back.
 *
 * Check order is the diagnostic order, and each gate is prior to the next:
 *
 *  1. is there a revision to classify at all (`withdraw`/`uphold` are rows 9/10
 *     and belong to the transition owner), and does it answer THIS lineage at
 *     the version under dispute;
 *  2. is the lineage in the state that awaits this decision;
 *  3. §6.2's no-third-round rule, checked before the §6.1 counters so a lineage
 *     that has already had its revision round reports as the exhausted debate it
 *     is, rather than as a spent counter;
 *  4. the §6.1 reconsideration budget — re-read here rather than assumed from
 *     #838, because a decision that reads counters must fail closed on the same
 *     facts it reads;
 *  5. the two facts about the recorded version history that #836's version rule
 *     cannot check for itself, because it never sees the lineage record: that
 *     the history is not empty, and that it is THIS lineage's;
 *  6. the §2.3/§4.2 predecessor and successor rules;
 *  7. the §5 structural comparison — the only step that can say `material`;
 *  8. the §6.1 version budget, which partitions a material revision into row 11
 *     or row 26.
 */
export function decideRevision(input: RevisionDecisionInput): RevisionDecision {
  const limits = input.limits ?? REVIEW_DISPUTE_DEFAULT_LIMITS;
  const { record, lineage } = input.admitted;

  // (1) Nothing to classify. Rows 9 and 10 are transitions, not revisions, and
  // this module does not own them.
  if (record.reconsideration !== "revise") {
    return { ...baseDecision(lineage), intent: "no_revision" };
  }
  const revision = record.revision;
  // Defensive: §4.2 makes the revision REQUIRED for `revise`, and #836's
  // validator enforces it. Reaching here means a hand-built record bypassed the
  // validator, which is precisely when failing closed matters.
  if (revision === undefined) {
    return rejected(lineage, "invalid-revision", "reconsideration.revision:missing");
  }

  // The record was admitted against this lineage, so these hold by construction;
  // they are re-asserted because everything below reads the lineage's counters
  // and versions, and applying a record to the wrong lineage or the wrong
  // version is the one mistake this layer must never make.
  if (record.lineageId !== lineage.lineageId) {
    return rejected(lineage, "unknown-lineage", `reconsideration.lineageId:${record.lineageId}`);
  }
  if (record.version !== lineage.version) {
    return rejected(lineage, "stale-version", `reconsideration.version:${record.version}`);
  }

  // (2) §7 rows 11/12/26 all fire from `disputed`; no other state awaits this
  // decision, and a terminal one is never reopened (§6.4).
  if (lineage.state !== "disputed") {
    return rejected(lineage, "not-actionable-state", `lineage.state:${lineage.state}`);
  }
  // (3) §6.2: "No finding lineage receives a third implementation/reviewer
  // debate round." A lineage already at the ceiling version has spent its
  // revision round; a dispute of that version goes straight to arbitration
  // (row 6), never to a second reconsideration. Checked before the counter
  // below, which such a lineage has also spent: this is the more specific fact,
  // and it holds even for a lineage whose counters were somehow not advanced.
  if (lineage.version >= ABSOLUTE_MAX_VERSION) {
    return rejected(lineage, "not-actionable-state", `lineage.version:${lineage.version}:no-second-reconsideration`);
  }

  // (4) §6.1: the reviewer turn this revision came from must have been
  // available. Compared against the limit rather than a hard-coded 1, so a
  // session that configured the round away
  // (`MAX_RECONSIDERATIONS_PER_LINEAGE = 0`, row 25) cannot have one re-entered
  // here.
  if (lineage.counters.reconsiderations >= limits.maxReconsiderationsPerLineage) {
    return rejected(
      lineage,
      "reconsideration-slot-consumed",
      `lineage.counters.reconsiderations:${lineage.counters.reconsiderations}`,
    );
  }

  // (5) The recorded history is the only place the predecessor's field VALUES
  // exist, and #836's rule reads it as one lineage's versions. Two things it
  // cannot check for itself, because it never sees the lineage record:
  if (input.versions.length === 0) {
    return rejected(lineage, "missing-field", "versions:empty");
  }
  const foreign = input.versions.findIndex((finding) => finding.lineageId !== lineage.lineageId);
  if (foreign !== -1) {
    return rejected(lineage, "duplicate-lineage", `versions[${foreign}].lineageId`);
  }

  // §4.2: the predecessor version "must equal the disputed version". Checked
  // before `checkPredecessor`, which would otherwise report a revision aimed at
  // an older version as merely "not current".
  if (revision.predecessorVersion !== record.version) {
    return rejected(lineage, "stale-version", `revision.predecessorVersion:${revision.predecessorVersion}`);
  }

  // (6) §2.3 / §4.2, via #836's rule — not a second copy of it. It answers all
  // five version questions at once: exactly one predecessor exists, it is the
  // lineage's current version, and the successor is the next one and does not
  // already exist. Because the predecessor is pinned to the lineage's disputed
  // version above, "not current" is also how a successor version that ALREADY
  // sits in the history is reported — a version is immutable once recorded
  // (§2.3), so a history holding one above the disputed version means the
  // lineage record and the findings disagree, and nothing may be decided on it.
  const predecessorCheck = checkPredecessor(input.versions, revision);
  if (!predecessorCheck.ok) {
    const problem = predecessorCheck.problem!;
    return rejected(lineage, predecessorFailureReason(problem), `revision:${problem}`, problem);
  }
  const predecessor = predecessorCheck.predecessor!;
  const successorVersion = revision.successor.version;

  // (7) §5, via #836's classifier — again, not a second copy. Every §2.1 field
  // is compared, so `changedFields` can neither hide a material change nor
  // manufacture one; the discrepancy is reported instead.
  const materiality = classifyRevisionMateriality(predecessor, revision, input.materialityOptions ?? {});
  const declaration = auditDeclaration(revision, materiality);
  const decided: RevisionDecision = {
    ...baseDecision(lineage),
    candidate: revision.successor,
    materiality,
    declaration,
    auditEvents: [materiality.auditEvent],
  };

  // Row 12: a non-material or ambiguous revision proceeds to arbitration and
  // grants nothing. The candidate is not persisted — the lineage arbitrates at
  // its disputed version — but it still travels to the arbiter (§8.2).
  if (materiality.classification !== "material") {
    return { ...decided, intent: "arbitration", row: 12, nextState: "arbitration_pending" };
  }

  // (8) §6.1 / rows 11 and 26 partition a material revision by the session's
  // version budget. The two conditions are exclusive and exhaustive, so the
  // machine stays deterministic under a lowered limit.
  //
  // Only the SESSION budget is asked about here. The absolute ceiling is not a
  // second question: #836's version rule already refuses a successor above
  // {@link ABSOLUTE_MAX_VERSION} outright (step 6), so invariant 3 holds even
  // for a hand-built `limits` that was raised rather than lowered — such a value
  // can widen nothing, because the successor never got this far.
  if (successorVersion > limits.maxVersionsPerLineage) {
    // Row 26: no successor-version budget. Nothing is admitted and the lineage
    // keeps its disputed version.
    return { ...decided, intent: "arbitration", row: 26, nextState: "arbitration_pending" };
  }

  // Row 11: the successor becomes the lineage's next version and opens for
  // EXACTLY ONE final implementation response. A `review_disputed` answer to it
  // is row 6 — arbitration, not another reconsideration.
  return {
    ...decided,
    intent: "final_implementation_response",
    row: 11,
    nextState: "open",
    versionAfter: successorVersion,
    candidateAdmitted: true,
    implementationResponsesGranted: 1,
  };
}
