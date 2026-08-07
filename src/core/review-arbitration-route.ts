/**
 * Issue #847: route ONE arbitration outcome to exactly one §7 row
 * (rows 13–21 of docs/review-dispute-contract.md).
 *
 * This is the layer between the arbiter turn and the transition owner. #839
 * decided WHICH agent may judge a lineage — or that none may; #846 invoked it and
 * returned either one admitted verdict or a typed invocation failure. Neither
 * decided what the answer MEANS for the lineage, and neither may: #846 stops at
 * "here is an admitted `implementer_correct` at confidence 0.55", because turning
 * that into `escalated_human` is a transition-table question.
 *
 * This module answers exactly that question and stops there in turn. It is a pure
 * function of already-typed values:
 *
 *  - it never re-parses arbiter output, reopens a local artifact, or recomputes
 *    the §8.3 confidence threshold — {@link ArbitrationConfidenceRouting} is
 *    #846's already-applied answer, read, not redone;
 *  - it never mutates its input, persists a state, advances a counter, changes a
 *    phase, or publishes anything. Counter DELTAS are proposed; #840 applies them
 *    atomically with the state and the audit event;
 *  - it invents no vocabulary. The verdicts, states, counters, limits, and audit
 *    events are #836's; the row numbers are the contract's; the failure kinds are
 *    #846's and #839's.
 *
 * ## The three ways an arbitration turn can end
 *
 * Every input reaching here is exactly one of:
 *
 *  1. **A verdict** (#846 `ok: true`). Rows 13–18 partition all four §8.1
 *     verdicts by the confidence routing #846 computed and by whether the
 *     evidence round is available. Exactly one arbitration pass is consumed,
 *     whatever the row — passes count RETURNED verdicts (§8.3).
 *  2. **No acceptable arbiter** (#839 `human_handoff`). Row 19: a human decides,
 *     and NO counter moves — nothing was invoked, so nothing was spent.
 *  3. **Malformed arbiter output** (#846 `empty-output` / `malformed-response`).
 *     Rows 20–21 partition it by whether the incremented
 *     `malformedArbiterAttempts` counter stays below or reaches the session cap.
 *     No arbitration pass is ever consumed, and neither party wins.
 *
 * Everything else — a subprocess that never ran, an artifact that could not be
 * read or written, a lineage that is not arbitrable — is an OPERATIONAL failure:
 * a fourth outcome that instantiates no row, changes no state, and moves no
 * counter. Keeping it out of rows 20/21 is the point: "the agent timed out" and
 * "the agent answered nonsense" are different facts, and spending the §12
 * malformed budget on the first would escalate lineages for an infrastructure
 * problem while telling the audit record the arbiter misbehaved.
 *
 * ## Why the preconditions are re-read here
 *
 * #846 already refuses to invoke a lineage that is not `arbitration_pending` or
 * whose pass budget is spent. They are re-read anyway, before any row fires,
 * because this is the layer that proposes counter movements: a decision that
 * reads counters must fail closed on the same facts it reads (the rule #845
 * follows for the reconsideration budget). The result of a run delivered twice,
 * or delivered after the lineage moved on, is an operational failure — never a
 * second pass, a second malformed attempt, or a transition out of a state the
 * lineage is no longer in.
 */
import {
  REVIEW_DISPUTE_DEFAULT_LIMITS,
  type ArbiterVerdict,
  type DisputeAuditEvent,
  type LineageCounters,
  type LineageState,
  type PersistedLineage,
  type ReviewDisputeLimits,
} from "./review-dispute.js";
import { arbitrationRunKey } from "./review-arbitration-prompt.js";
import type { ArbitrationConfidenceRouting } from "./review-arbitration-response.js";
import type {
  ArbiterCandidateRejection,
  ArbiterNotApplicableReason,
  ArbiterProfileResolution,
  ArbiterUnavailableReason,
} from "./review-arbiter-profile.js";
import type {
  ArbitrationFailureKind,
  ArbitrationInvocationResult,
  ArbitrationProfileSummary,
} from "../handlers/review-arbitration.js";

// ---------------------------------------------------------------------------
// Result vocabulary
// ---------------------------------------------------------------------------

/** What the runner should do next with this lineage. */
export const ARBITRATION_ROUTE_INTENTS = [
  /** Row 13: the finding is binding; implementation must satisfy it. */
  "implementation",
  /** Row 14: the finding is overruled; the run's review aggregation continues. */
  "review_aggregation",
  /** Row 16: one bounded evidence-collection round (§7 row 22 closes it). */
  "evidence_collection",
  /** Row 20: re-invoke arbitration under the existing selected-profile policy. */
  "arbitration_retry",
  /** Rows 15, 17, 18, 19, 21: a human decides. */
  "human_handoff",
  /** No row fired: an infrastructure or precondition fact, not a protocol event. */
  "operational_failure",
] as const;
export type ArbitrationRouteIntent = (typeof ARBITRATION_ROUTE_INTENTS)[number];

/** The §7 rows this module can instantiate. Rows 22–26 belong to other layers. */
export const ARBITRATION_ROUTE_ROWS = [13, 14, 15, 16, 17, 18, 19, 20, 21] as const;
export type ArbitrationRouteRow = (typeof ARBITRATION_ROUTE_ROWS)[number];

/**
 * The bounded reason a lineage took its route — the operator- and human-facing
 * "why", as a literal.
 *
 * One per row, plus the two non-row outcomes. It carries no rationale, no
 * evidence text, and no path: the arbiter's prose stays in the §10.2 local
 * artifact, and §11 publishes outcome literals only.
 */
export const ARBITRATION_ROUTE_REASONS = [
  /** Row 13. */
  "reviewer-correct",
  /** Row 14. */
  "implementer-correct",
  /** Row 15: the Issue contract itself does not decide the disagreement (§9). */
  "spec-ambiguous",
  /** Row 16: the bounded evidence round is available and is being requested. */
  "insufficient-evidence",
  /** Row 17: evidence remains insufficient and no round is available (§9). */
  "insufficient-evidence-round-unavailable",
  /** Row 18: a decisive verdict below §8.3's threshold decides nothing (§9). */
  "low-confidence-verdict",
  /** Row 19: no acceptable independent arbiter is configured or available (§8.3). */
  "no-acceptable-arbiter",
  /** Row 20: a below-cap malformed attempt; the arbiter is re-invoked (§12). */
  "malformed-arbiter-output",
  /** Row 21: the malformed-attempt cap is reached (§8.3, §9). */
  "malformed-arbiter-cap-reached",
  /** No row: a typed operational/invariant failure. Nothing changes. */
  "operational-failure",
  /** No row: #839 reports this input was never an arbitration turn at all. */
  "not-applicable",
] as const;
export type ArbitrationRouteReason = (typeof ARBITRATION_ROUTE_REASONS)[number];

/**
 * #846 failure kinds attributable to the ARBITER'S RESPONSE CONTENT — the only
 * ones §12's malformed-output bound may spend a `malformedArbiterAttempts`
 * attempt on.
 *
 * Both mean the agent ran to completion and what came back could not be admitted
 * as an §8.1 verdict: it produced nothing at all, or it produced something that
 * is not one. Every other failure kind says the arbiter never got the chance to
 * answer, which is not the arbiter's fault and must not shorten its budget.
 */
export const ARBITRATION_MALFORMED_FAILURE_KINDS = ["empty-output", "malformed-response"] as const;
export type ArbitrationMalformedFailureKind = (typeof ARBITRATION_MALFORMED_FAILURE_KINDS)[number];

/**
 * Which side of the §12 line each #846 failure kind falls on.
 *
 * Exhaustive over {@link ArbitrationFailureKind} BY TYPE: a kind added to #846
 * fails to compile here until this layer says whether it is the arbiter's answer
 * or the machinery around it. That is the whole safety property of this table —
 * silently defaulting a new kind to "malformed" would escalate lineages for an
 * infrastructure fault, and defaulting it to "operational" would let genuinely
 * unusable output retry without bound.
 */
const FAILURE_KIND_SOURCE: Record<ArbitrationFailureKind, "malformed" | "operational"> = {
  "empty-output": "malformed",
  "malformed-response": "malformed",
  "profile-lineage-mismatch": "operational",
  "not-arbitrable": "operational",
  "lineage-not-arbitration-pending": "operational",
  "arbitration-passes-exhausted": "operational",
  "missing-dispute-artifact": "operational",
  "malformed-dispute-artifact": "operational",
  "missing-reconsideration-artifact": "operational",
  "malformed-reconsideration-artifact": "operational",
  "unresolvable-evidence-attachment": "operational",
  "agent-failed": "operational",
  "artifact-write-failed": "operational",
  "unsafe-artifact-dir": "operational",
  "unsafe-artifact-path": "operational",
};

/**
 * Is this failure the ARBITER'S ANSWER, and therefore rows 20/21's?
 *
 * A type guard rather than a lookup, so the negative branch narrows to exactly
 * {@link ArbitrationRouteOperationalKind} and the operational path cannot be
 * handed a content-malformed kind by a later edit or a cast.
 */
export function isMalformedFailureKind(kind: ArbitrationFailureKind): kind is ArbitrationMalformedFailureKind {
  return FAILURE_KIND_SOURCE[kind] === "malformed";
}

/**
 * The one fact this module can observe that neither #839 nor #846 has a literal
 * for: a SELECTED profile handed here directly.
 *
 * A selection is not an outcome — it is the input #846 consumes — so routing one
 * would mean deciding a lineage on an arbitration that never ran.
 */
export const ARBITRATION_ROUTE_INVARIANT_KINDS = ["arbiter-selected-not-invoked"] as const;
export type ArbitrationRouteInvariantKind = (typeof ARBITRATION_ROUTE_INVARIANT_KINDS)[number];

/**
 * Everything that can end a turn without a row: #846's non-content failures,
 * #839's not-applicable reasons, and this module's own invariant.
 *
 * The malformed kinds are EXCLUDED by type, so no operational path can name one
 * and no future edit can quietly route content-malformed output through the
 * counter-free branch.
 */
export type ArbitrationRouteOperationalKind =
  | Exclude<ArbitrationFailureKind, ArbitrationMalformedFailureKind>
  | ArbiterNotApplicableReason
  | ArbitrationRouteInvariantKind;

/**
 * How an operational failure should be understood by the retry/handoff policy
 * that already exists downstream.
 *
 * Deliberately a CLASS rather than a `retryable: boolean`: retryability is a
 * runner policy question (how many attempts, under what backoff, with what
 * handoff), #840 and the phase runner own it, and this module has no business
 * pre-deciding it. What it does own is the classification the policy needs, and
 * every value here comes from a typed kind — never from an error string.
 */
export const ARBITRATION_OPERATIONAL_CLASSES = [
  /** The agent's own subprocess never delivered an answer: setup, exit, timeout. */
  "agent-unavailable",
  /** A precondition of the turn does not hold; retrying it unchanged cannot help. */
  "precondition",
  /** A record this turn had to READ is missing or no longer admissible. */
  "input-artifact",
  /** A file this turn had to WRITE was refused or failed. */
  "artifact-write",
] as const;
export type ArbitrationOperationalClass = (typeof ARBITRATION_OPERATIONAL_CLASSES)[number];

/** Exhaustive by type over {@link ArbitrationRouteOperationalKind}; see {@link FAILURE_KIND_SOURCE}. */
const OPERATIONAL_CLASS: Record<ArbitrationRouteOperationalKind, ArbitrationOperationalClass> = {
  "agent-failed": "agent-unavailable",
  "profile-lineage-mismatch": "precondition",
  "not-arbitrable": "precondition",
  "lineage-not-arbitration-pending": "precondition",
  "arbitration-passes-exhausted": "precondition",
  "dispute-disabled": "precondition",
  "not-arbitration-intent": "precondition",
  "arbiter-selected-not-invoked": "precondition",
  "missing-dispute-artifact": "input-artifact",
  "malformed-dispute-artifact": "input-artifact",
  "missing-reconsideration-artifact": "input-artifact",
  "malformed-reconsideration-artifact": "input-artifact",
  "unresolvable-evidence-attachment": "input-artifact",
  "artifact-write-failed": "artifact-write",
  "unsafe-artifact-dir": "artifact-write",
  "unsafe-artifact-path": "artifact-write",
};

export interface ArbitrationOperationalFailure {
  kind: ArbitrationRouteOperationalKind;
  failureClass: ArbitrationOperationalClass;
  /** Content-free locator: a field path, a state literal, a counter value. */
  detail: string | null;
}

/**
 * §6.1: why the one bounded evidence round is or is not available.
 *
 * Both halves of the contract's definition are computed, because both can make
 * it unavailable independently: the round budget itself, and whether an
 * arbitration pass remains AFTER this verdict to receive the re-presented case.
 * Requesting evidence nobody could then arbitrate would leave the lineage in
 * `evidence_requested` with no next action.
 */
export const EVIDENCE_ROUND_UNAVAILABLE_REASONS = [
  /** `MAX_EVIDENCE_ROUNDS_PER_LINEAGE = 0`: the session configured the round away. */
  "round-budget-zero",
  /** The round was already used (§7 row 22 marked it so). */
  "round-consumed",
  /** No arbitration pass remains to weigh the evidence once it is collected. */
  "no-remaining-arbitration-pass",
] as const;
export type EvidenceRoundUnavailableReason = (typeof EVIDENCE_ROUND_UNAVAILABLE_REASONS)[number];

export interface EvidenceRoundAvailability {
  available: boolean;
  /** `MAX_EVIDENCE_ROUNDS_PER_LINEAGE` as the session resolved it. */
  budget: number;
  used: number;
  /** Passes left AFTER the verdict being routed consumes one. */
  arbitrationPassesRemaining: number;
  /** The FIRST reason it is unavailable, in budget-then-pass order; null when available. */
  unavailableReason: EvidenceRoundUnavailableReason | null;
}

/**
 * The proposed §6.1 counter movement, as a delta #840 applies atomically.
 *
 * Every field is typed at the literal values this module can produce, so no
 * caller and no later edit can widen the movement: three counters are outside
 * this turn entirely, an arbitration pass moves by AT MOST one, and a malformed
 * attempt moves by at most one. The two that can move never move together —
 * malformed output never consumes a pass (§8.3), and a returned verdict is never
 * a malformed attempt.
 */
export interface ArbitrationCounterDelta {
  rebuttals: 0;
  reconsiderations: 0;
  arbitrationPasses: 0 | 1;
  malformedArbiterAttempts: 0 | 1;
  /**
   * Always 0. Row 16 REQUESTS the evidence round; §7 row 22 — the transition
   * that records the collected attachments — is what marks it used, so a route
   * decision that pre-consumed it here would make a requested-but-never-answered
   * round indistinguishable from a completed one.
   */
  evidenceRoundsUsed: 0;
}

const NO_COUNTER_DELTA: ArbitrationCounterDelta = {
  rebuttals: 0,
  reconsiderations: 0,
  arbitrationPasses: 0,
  malformedArbiterAttempts: 0,
  evidenceRoundsUsed: 0,
};

/**
 * One bounded, side-effect-free route decision for ONE lineage.
 *
 * Literals, counters, names, and identifiers only — no rationale, prompt,
 * transcript, absolute path, or evidence text. Deterministic: the same lineage,
 * limits, and outcome always produce the same value, field for field, including
 * {@link idempotencyKey}.
 */
export interface ArbitrationRouteDecision {
  intent: ArbitrationRouteIntent;
  lineageId: string;
  /** The version arbitrated — the lineage's current version. */
  version: number;
  /** The §7 row this decision instantiates, or null when none fires. */
  row: ArbitrationRouteRow | null;
  currentState: LineageState;
  /** The state #840 should write, or null when nothing changes. */
  nextState: LineageState | null;
  counterDelta: ArbitrationCounterDelta;
  /** The counters the delta produces, precomputed so the cap decisions are auditable. */
  countersAfter: LineageCounters;
  /** §10.3: exactly one event per transition, none for a non-transition. */
  auditEvents: DisputeAuditEvent[];
  reason: ArbitrationRouteReason;
  /**
   * `<runKey>|row:<row>`, or `<runKey>|operational:<kind>` when no row fired:
   * lineage, version, invocation, and route row, as the contract for this
   * decision requires. Stable — re-routing the same input reproduces it exactly.
   */
  idempotencyKey: string;
  /**
   * `<lineageId>@<version>#<runId>` — #846's key, or the same three literals for
   * a row-19 turn that never reached an invocation.
   *
   * This, NOT {@link idempotencyKey}, is what #840 must dedupe a re-delivered
   * result on. The row belongs in the key (a lineage can legitimately route more
   * than one arbitration turn), but it is a function of the counters this
   * decision READ: once a row-20 malformed attempt has been applied, a second
   * delivery of the SAME run reads the incremented counter and names row 21. The
   * run key does not move, so an outcome already applied for a run key is
   * recognizable as the duplicate it is.
   */
  runKey: string;
  /** #846's bundle digest, when an arbiter was actually shown a bundle. */
  bundleDigest: string | null;
  /** Artifact NAMES only; the directory is the invocation's and never travels. */
  artifactNames: string[];
  /** #846's sanitized profile summary; null when no arbiter was selected. */
  profile: ArbitrationProfileSummary | null;
  verdict: ArbiterVerdict | null;
  /** #846's already-applied §8.3 threshold. Never recomputed here. */
  confidence: ArbitrationConfidenceRouting | null;
  /** Computed for `insufficient_evidence` only — the fact rows 16/17 partition on. */
  evidence: EvidenceRoundAvailability | null;
  /** Row 19: which §8.3 unavailability #839 reported. */
  arbiterUnavailable: ArbiterUnavailableReason | null;
  /** Row 19 operator diagnostics: why each configured candidate was rejected. */
  candidateRejections: ArbiterCandidateRejection[];
  /** #846's failure verbatim whenever the invocation failed, whatever this layer routed. */
  invocationFailure: { kind: ArbitrationFailureKind; detail: string | null } | null;
  operational: ArbitrationOperationalFailure | null;
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/** The run identity of a turn that produced no #846 invocation to key on. */
export interface ArbitrationRouteRunIdentity {
  /** The run that dispatched the arbitration (the phase runner's lease id). */
  runId: string;
}

/**
 * The one arbitration outcome being routed.
 *
 * A closed union of the two typed producers, consumed as they are returned: a
 * caller cannot hand this module a hand-built verdict, a raw agent transcript,
 * or a free-form error.
 */
export type ArbitrationRouteOutcome =
  | { kind: "invocation"; result: ArbitrationInvocationResult }
  | {
      kind: "profile";
      /** #839's resolution. Only `human_handoff` routes (row 19). */
      resolution: ArbiterProfileResolution;
      run: ArbitrationRouteRunIdentity;
    };

export interface ArbitrationRouteInput {
  /**
   * The lineage as persisted in `task.context.reviewDispute` (§10.1). Read only:
   * this function never mutates it, and #840 writes the transition.
   */
  lineage: PersistedLineage;
  /** The version arbitrated. Must equal the lineage's current version. */
  version: number;
  outcome: ArbitrationRouteOutcome;
  /** The session's resolved §6.1 limits. Defaults to the normative maxima. */
  limits?: ReviewDisputeLimits;
}

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

/** Names only. A separator means it is a path, not a name, and it does not travel. */
function artifactNames(names: readonly (string | null)[]): string[] {
  return names.filter((name): name is string => typeof name === "string" && !/[\\/]/.test(name));
}

function copyProfile(profile: ArbitrationProfileSummary): ArbitrationProfileSummary {
  return { ...profile, sharedProviderWith: [...profile.sharedProviderWith] };
}

function copyRejections(rejections: readonly ArbiterCandidateRejection[]): ArbiterCandidateRejection[] {
  return rejections.map((rejection) => ({ ...rejection }));
}

function applyDelta(counters: LineageCounters, delta: ArbitrationCounterDelta): LineageCounters {
  return {
    rebuttals: counters.rebuttals + delta.rebuttals,
    reconsiderations: counters.reconsiderations + delta.reconsiderations,
    arbitrationPasses: counters.arbitrationPasses + delta.arbitrationPasses,
    malformedArbiterAttempts: counters.malformedArbiterAttempts + delta.malformedArbiterAttempts,
    evidenceRoundsUsed: counters.evidenceRoundsUsed + delta.evidenceRoundsUsed,
  };
}

/**
 * §6.1: is the one bounded evidence round available for THIS verdict?
 *
 * `passesAfter` is the pass count once the verdict being routed has consumed
 * its own — the contract's "a further arbitration pass remains after the current
 * admitted verdict". The budget question is asked first so an operator reading
 * row 17 learns the more specific fact: a session that configured the round away
 * reports `round-budget-zero`, not "no pass remains", even when both hold.
 */
function evidenceAvailability(
  counters: LineageCounters,
  limits: ReviewDisputeLimits,
  passesAfter: number,
): EvidenceRoundAvailability {
  const budget = limits.maxEvidenceRoundsPerLineage;
  const used = counters.evidenceRoundsUsed;
  const arbitrationPassesRemaining = limits.maxArbitrationPassesPerLineage - passesAfter;
  let unavailableReason: EvidenceRoundUnavailableReason | null = null;
  if (budget <= 0) unavailableReason = "round-budget-zero";
  else if (used >= budget) unavailableReason = "round-consumed";
  else if (arbitrationPassesRemaining < 1) unavailableReason = "no-remaining-arbitration-pass";
  return {
    available: unavailableReason === null,
    budget,
    used,
    arbitrationPassesRemaining,
    unavailableReason,
  };
}

interface DecisionBase {
  lineage: PersistedLineage;
  version: number;
  runKey: string;
  bundleDigest: string | null;
  artifactNames: string[];
  profile: ArbitrationProfileSummary | null;
  candidateRejections: ArbiterCandidateRejection[];
  invocationFailure: { kind: ArbitrationFailureKind; detail: string | null } | null;
}

function baseDecision(base: DecisionBase): ArbitrationRouteDecision {
  return {
    intent: "operational_failure",
    lineageId: base.lineage.lineageId,
    version: base.version,
    row: null,
    currentState: base.lineage.state,
    nextState: null,
    counterDelta: { ...NO_COUNTER_DELTA },
    countersAfter: { ...base.lineage.counters },
    auditEvents: [],
    reason: "operational-failure",
    idempotencyKey: "",
    runKey: base.runKey,
    bundleDigest: base.bundleDigest,
    artifactNames: [...base.artifactNames],
    profile: base.profile,
    verdict: null,
    confidence: null,
    evidence: null,
    arbiterUnavailable: null,
    candidateRejections: [...base.candidateRejections],
    invocationFailure: base.invocationFailure,
    operational: null,
  };
}

/**
 * A turn that instantiates no row: no state change, no counter, no audit event.
 *
 * The key names the operational kind rather than a row, so a retried delivery of
 * the same failure is recognizable as the same non-event.
 */
function operationalFailure(
  base: DecisionBase,
  kind: ArbitrationRouteOperationalKind,
  detail: string | null,
  reason: ArbitrationRouteReason = "operational-failure",
): ArbitrationRouteDecision {
  return {
    ...baseDecision(base),
    intent: "operational_failure",
    reason,
    idempotencyKey: `${base.runKey}|operational:${kind}`,
    operational: { kind, failureClass: OPERATIONAL_CLASS[kind], detail },
  };
}

interface RoutedRow {
  row: ArbitrationRouteRow;
  intent: ArbitrationRouteIntent;
  nextState: LineageState;
  reason: ArbitrationRouteReason;
  auditEvent: DisputeAuditEvent;
  counterDelta: ArbitrationCounterDelta;
}

function routed(base: DecisionBase, row: RoutedRow): ArbitrationRouteDecision {
  return {
    ...baseDecision(base),
    intent: row.intent,
    row: row.row,
    nextState: row.nextState,
    counterDelta: { ...row.counterDelta },
    countersAfter: applyDelta(base.lineage.counters, row.counterDelta),
    auditEvents: [row.auditEvent],
    reason: row.reason,
    idempotencyKey: `${base.runKey}|row:${row.row}`,
  };
}

/** Rows 13–18: one returned verdict, one consumed pass. */
const VERDICT_PASS_DELTA: ArbitrationCounterDelta = { ...NO_COUNTER_DELTA, arbitrationPasses: 1 };
/** Rows 20–21: one malformed attempt, and never a pass (§8.3). */
const MALFORMED_ATTEMPT_DELTA: ArbitrationCounterDelta = { ...NO_COUNTER_DELTA, malformedArbiterAttempts: 1 };

/**
 * The gates every row in this module sits behind, in diagnostic order.
 *
 * Returns the failing decision, or null when the lineage is arbitrable. Checked
 * before ANY row fires, because this is the layer that proposes counter
 * movements: a result delivered twice, or delivered after the lineage moved on,
 * must never become a second pass, a second malformed attempt, or a transition
 * out of a state the lineage is no longer in.
 */
function arbitrabilityFailure(
  base: DecisionBase,
  claimed: { lineageId: string; version: number },
  limits: ReviewDisputeLimits,
): ArbitrationRouteDecision | null {
  const { lineage, version } = base;
  // The one mistake this layer must never make: applying one lineage's outcome
  // to another lineage's counters.
  if (claimed.lineageId !== lineage.lineageId) {
    return operationalFailure(base, "profile-lineage-mismatch", `outcome.lineageId:${claimed.lineageId}`);
  }
  // Version next — an outcome answering a version the lineage has moved past says
  // nothing about the current one.
  if (claimed.version !== version || lineage.version !== version) {
    return operationalFailure(base, "not-arbitrable", `lineage.version:${lineage.version}:outcome:${claimed.version}`);
  }
  // §8.2: only a lineage awaiting an arbiter has one of these rows available.
  if (lineage.state !== "arbitration_pending") {
    return operationalFailure(base, "lineage-not-arbitration-pending", `lineage.state:${lineage.state}`);
  }
  // §8.3: passes count RETURNED verdicts, so an exhausted budget means the debate
  // is already over. Applied to every row this module can fire — a verdict would
  // spend a pass the lineage does not have, a row-20 retry would re-invoke an
  // arbiter that may no longer be invoked, and rows 19 and 21 presuppose a lineage
  // that was legitimately awaiting an arbitration turn.
  if (lineage.counters.arbitrationPasses >= limits.maxArbitrationPassesPerLineage) {
    return operationalFailure(
      base,
      "arbitration-passes-exhausted",
      `lineage.counters.arbitrationPasses:${lineage.counters.arbitrationPasses}`,
    );
  }
  return null;
}

/**
 * Route one arbitration outcome for one lineage.
 *
 * Never throws and never mutates: an unusable input is an outcome, not an
 * exception, because §12's effect for malformed output — and this layer's effect
 * for a stale or broken turn — is that no protocol state changes, which a caller
 * can only apply if it gets a value back.
 *
 * One lineage per call, by construction: nothing here can name, resolve, or
 * increment a lineage other than {@link ArbitrationRouteInput.lineage}, and
 * run-level aggregation across lineages is §7.1's, downstream.
 */
export function routeArbitrationOutcome(input: ArbitrationRouteInput): ArbitrationRouteDecision {
  const limits = input.limits ?? REVIEW_DISPUTE_DEFAULT_LIMITS;
  return input.outcome.kind === "profile"
    ? routeProfileResolution(input.lineage, input.version, input.outcome, limits)
    : routeInvocation(input.lineage, input.version, input.outcome.result, limits);
}

/** Row 19, or a fail-closed non-event: #839's resolution, consumed as returned. */
function routeProfileResolution(
  lineage: PersistedLineage,
  version: number,
  outcome: Extract<ArbitrationRouteOutcome, { kind: "profile" }>,
  limits: ReviewDisputeLimits,
): ArbitrationRouteDecision {
  const resolution = outcome.resolution;
  // No invocation ever ran, so there is no #846 run key to reuse; the same three
  // literals compose it, which is what makes a re-delivery of this turn key
  // identically.
  const base: DecisionBase = {
    lineage,
    version,
    runKey: arbitrationRunKey({ lineageId: lineage.lineageId, version, runId: outcome.run.runId }),
    bundleDigest: null,
    artifactNames: [],
    profile: null,
    candidateRejections: copyRejections(resolution.rejections),
    invocationFailure: null,
  };

  if (resolution.lineageId !== lineage.lineageId) {
    return operationalFailure(base, "profile-lineage-mismatch", `resolution.lineageId:${resolution.lineageId}`);
  }
  // A not-applicable resolution is answered BEFORE the lineage gates: #839 is
  // saying this was never an arbitration turn, so the lineage's state and budget
  // are not the fact an operator needs, and inventing row 19 from a disabled
  // protocol would escalate a lineage no arbiter was ever asked about.
  if (resolution.kind === "not_applicable") {
    return operationalFailure(base, resolution.reason, "resolution:not_applicable", "not-applicable");
  }
  if (resolution.kind === "selected") {
    return operationalFailure(base, "arbiter-selected-not-invoked", "resolution:selected");
  }

  const blocked = arbitrabilityFailure(base, { lineageId: resolution.lineageId, version }, limits);
  if (blocked !== null) return blocked;

  // Row 19: no acceptable independent arbiter. No pass was spent and no attempt
  // was made, so NO counter moves — the candidate rejections are the whole record
  // of what was tried, preserved for operator diagnostics.
  return {
    ...routed(base, {
      row: 19,
      intent: "human_handoff",
      nextState: "escalated_human",
      reason: "no-acceptable-arbiter",
      auditEvent: "dispute.escalated.human",
      counterDelta: NO_COUNTER_DELTA,
    }),
    arbiterUnavailable: resolution.reason,
  };
}

/** Rows 13–18 and 20–21: #846's invocation result, consumed as returned. */
function routeInvocation(
  lineage: PersistedLineage,
  version: number,
  result: ArbitrationInvocationResult,
  limits: ReviewDisputeLimits,
): ArbitrationRouteDecision {
  const summary = result.summary;
  // The run key is #846's own, never recomputed, so a retried delivery of one
  // invocation keys identically to the first.
  const base: DecisionBase = {
    lineage,
    version,
    runKey: summary.runKey,
    bundleDigest: summary.bundleDigest,
    artifactNames: artifactNames([
      summary.bundleArtifact,
      summary.rawArtifact,
      summary.stderrArtifact,
      summary.runnerErrorArtifact,
      summary.verdictArtifact,
    ]),
    profile: copyProfile(summary.profile),
    candidateRejections: [],
    invocationFailure: result.ok ? null : { kind: result.failure.kind, detail: result.failure.detail },
  };

  const blocked = arbitrabilityFailure(base, { lineageId: summary.lineageId, version: summary.version }, limits);
  if (blocked !== null) return blocked;

  if (!result.ok) return routeInvocationFailure(base, result.failure, limits);
  return routeVerdict(base, result, limits);
}

/**
 * Rows 20–21, or an operational failure.
 *
 * The split is {@link FAILURE_KIND_SOURCE}'s and nothing else's: no error string
 * is inspected, and no failure "looks malformed enough" to spend the §12 budget.
 */
function routeInvocationFailure(
  base: DecisionBase,
  failure: { kind: ArbitrationFailureKind; detail: string | null },
  limits: ReviewDisputeLimits,
): ArbitrationRouteDecision {
  if (!isMalformedFailureKind(failure.kind)) {
    return operationalFailure(base, failure.kind, failure.detail);
  }

  // §12: exactly one attempt is recorded, and never an arbitration pass. Neither
  // row awards the dispute to a party — malformed output is not an argument.
  const attemptsAfter = base.lineage.counters.malformedArbiterAttempts + 1;
  const cap = limits.maxMalformedArbiterAttemptsPerLineage;
  if (attemptsAfter < cap) {
    // Row 20: below the cap. The lineage STAYS `arbitration_pending` and the
    // arbiter is re-invoked under #839's existing selection policy — this module
    // neither selects nor substitutes one.
    return routed(base, {
      row: 20,
      intent: "arbitration_retry",
      nextState: "arbitration_pending",
      reason: "malformed-arbiter-output",
      auditEvent: "dispute.arbitration.malformed",
      counterDelta: MALFORMED_ATTEMPT_DELTA,
    });
  }
  // Row 21: the cap is reached — `>=`, not `===`, so a lineage whose counter is
  // somehow already at or above the cap escalates to a human rather than
  // retrying without bound. §10.3: the cap-reached count travels in the event's
  // counters, which is why `countersAfter` carries it.
  return routed(base, {
    row: 21,
    intent: "human_handoff",
    nextState: "escalated_human",
    reason: "malformed-arbiter-cap-reached",
    auditEvent: "dispute.escalated.human",
    counterDelta: MALFORMED_ATTEMPT_DELTA,
  });
}

/**
 * Rows 13–18: the four §8.1 verdicts, partitioned so that exactly one row fires.
 *
 * The switch is over the VERDICT literal first, because §8.3 gates only the two
 * decisive verdicts: `spec_ambiguous` and `insufficient_evidence` route by
 * verdict alone, at any confidence. Every branch consumes exactly one arbitration
 * pass — a returned verdict is a spent pass whatever it decided (§8.3).
 */
function routeVerdict(
  base: DecisionBase,
  result: Extract<ArbitrationInvocationResult, { ok: true }>,
  limits: ReviewDisputeLimits,
): ArbitrationRouteDecision {
  const record = result.admitted.record;
  // Defensive, and the reason this layer re-reads identity at all: #846 admitted
  // the record against the pending target, so these hold by construction — but a
  // record naming another lineage or version must never reach a counter.
  if (record.lineageId !== base.lineage.lineageId) {
    return operationalFailure(base, "profile-lineage-mismatch", `verdict.lineageId:${record.lineageId}`);
  }
  if (record.version !== base.version) {
    return operationalFailure(base, "not-arbitrable", `verdict.version:${record.version}`);
  }

  const verdict: ArbiterVerdict = record.verdict;
  const confidence: ArbitrationConfidenceRouting = { ...result.confidence };
  const decided = (row: RoutedRow, evidence: EvidenceRoundAvailability | null = null): ArbitrationRouteDecision => ({
    ...routed(base, row),
    verdict,
    confidence,
    evidence,
  });

  switch (verdict) {
    case "spec_ambiguous":
      // Row 15: the Issue contract itself does not decide the disagreement, so
      // neither may the arbiter. Not confidence-gated (§8.3) — a confident
      // "the spec is ambiguous" is still a question for a human.
      return decided({
        row: 15,
        intent: "human_handoff",
        nextState: "escalated_human",
        reason: "spec-ambiguous",
        auditEvent: "dispute.escalated.human",
        counterDelta: VERDICT_PASS_DELTA,
      });

    case "insufficient_evidence": {
      // Rows 16/17, also ungated by confidence. The partition is §6.1's, computed
      // over the counters AFTER this verdict's pass.
      const evidence = evidenceAvailability(
        base.lineage.counters,
        limits,
        base.lineage.counters.arbitrationPasses + VERDICT_PASS_DELTA.arbitrationPasses,
      );
      if (evidence.available) {
        return decided(
          {
            row: 16,
            intent: "evidence_collection",
            nextState: "evidence_requested",
            reason: "insufficient-evidence",
            auditEvent: "dispute.evidence.requested",
            counterDelta: VERDICT_PASS_DELTA,
          },
          evidence,
        );
      }
      return decided(
        {
          row: 17,
          intent: "human_handoff",
          nextState: "escalated_human",
          reason: "insufficient-evidence-round-unavailable",
          auditEvent: "dispute.escalated.human",
          counterDelta: VERDICT_PASS_DELTA,
        },
        evidence,
      );
    }

    case "reviewer_correct":
    case "implementer_correct":
      // Row 18 first: §8.3's threshold gates BOTH decisive verdicts, and a
      // low-confidence verdict must never decide for either party. The threshold
      // itself is #846's already-applied answer; nothing is recomputed here.
      if (!confidence.meetsMinConfidence) {
        return decided({
          row: 18,
          intent: "human_handoff",
          nextState: "escalated_human",
          reason: "low-confidence-verdict",
          auditEvent: "dispute.escalated.human",
          counterDelta: VERDICT_PASS_DELTA,
        });
      }
      // Row 13: the finding stands and becomes binding — the implementation must
      // satisfy it, and a further `review_disputed` on it is malformed (row 24).
      if (verdict === "reviewer_correct") {
        return decided({
          row: 13,
          intent: "implementation",
          nextState: "binding",
          reason: "reviewer-correct",
          auditEvent: "dispute.arbitration.verdict",
          counterDelta: VERDICT_PASS_DELTA,
        });
      }
      // Row 14: the finding is overruled and the lineage is terminal, so the one
      // event §10.3 allows this transition is the RESOLUTION — the precedent that
      // section sets for row 21, where the destination (a human handoff) names the
      // event rather than its trigger (a malformed attempt). It also matches §11,
      // which publishes exactly two outcome classes: a lineage resolution and a
      // human escalation. Row 13 is neither — `binding` is explicitly not a
      // resolution there — so it keeps `dispute.arbitration.verdict`.
      return decided({
        row: 14,
        intent: "review_aggregation",
        nextState: "resolved_overruled",
        reason: "implementer-correct",
        auditEvent: "dispute.resolved",
        counterDelta: VERDICT_PASS_DELTA,
      });
  }
}
