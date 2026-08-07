/**
 * Review-dispute domain contracts (issue #836, docs/review-dispute-contract.md).
 *
 * This module is the single source of the protocol's closed vocabularies, its
 * record shapes, its bounded-debate constants, and the persisted per-lineage
 * state. Runtime validation lives in `review-dispute-validation.ts` and the
 * structural lineage/materiality checks in `review-dispute-lineage.ts`; both
 * import their vocabularies from here, so a compile-time type and the runtime
 * check that guards it can never drift apart:
 *
 *  - every enum is declared once as an `as const` tuple, and its TypeScript type
 *    is derived from that tuple (`(typeof T)[number]`), so adding or removing a
 *    token changes both halves at once;
 *  - every per-state fact lives in a `Record<LineageState, …>` table, so a new
 *    state fails to compile until its behavior is declared.
 *
 * Nothing here performs I/O, decides a transition, or renders a prompt. The
 * transition table (§7), the arbiter invocation (§8), the publication path
 * (§11), and the pipeline integration are downstream issues (#837–#849); this
 * module only supplies the contracts they share.
 */

import type { AgentId } from "./task.js";
import type { ReviewDisputeConfig, ReviewDisputeLimitsConfig } from "./session.js";

// ---------------------------------------------------------------------------
// §1 Canonical vocabulary
//
// The tokens below are the ONLY valid names for these concepts, in code, JSON
// output, audit events, and operator text (§1).
// ---------------------------------------------------------------------------

/** §1 Implementation dispositions — the per-finding value returned in fix mode. */
export const IMPLEMENTATION_DISPOSITIONS = ["fixed", "review_disputed", "blocked"] as const;
export type ImplementationDisposition = (typeof IMPLEMENTATION_DISPOSITIONS)[number];

/** §1 Reviewer reconsiderations — the per-dispute value returned by the reviewer. */
export const REVIEWER_RECONSIDERATIONS = ["withdraw", "uphold", "revise"] as const;
export type ReviewerReconsideration = (typeof REVIEWER_RECONSIDERATIONS)[number];

/** §1 Arbiter verdicts. */
export const ARBITER_VERDICTS = [
  "reviewer_correct",
  "implementer_correct",
  "spec_ambiguous",
  "insufficient_evidence",
] as const;
export type ArbiterVerdict = (typeof ARBITER_VERDICTS)[number];

/**
 * §7 rows 13–14 and 18 gate only the decisive verdicts by the confidence
 * threshold; `spec_ambiguous` and `insufficient_evidence` route regardless of
 * confidence (§8.3).
 */
export const DECISIVE_ARBITER_VERDICTS = ["reviewer_correct", "implementer_correct"] as const;
export type DecisiveArbiterVerdict = (typeof DECISIVE_ARBITER_VERDICTS)[number];

/** §1 Lineage states — the value of `reviewDispute.lineages[<lineageId>].state`. */
export const LINEAGE_STATES = [
  "open",
  "disputed",
  "arbitration_pending",
  "evidence_requested",
  "binding",
  "resolved_fixed",
  "resolved_withdrawn",
  "resolved_overruled",
  "escalated_human",
] as const;
export type LineageState = (typeof LINEAGE_STATES)[number];

/** §2.1 Only blocking severities enter the protocol; cosmetic nits never do. */
export const FINDING_SEVERITIES = ["P1", "P2"] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

/** §3.2 Closed rebuttal-reason enum. */
export const REBUTTAL_REASONS = [
  "false_premise",
  "contradicts_issue_contract",
  "already_covered",
  "would_reduce_correctness",
  "out_of_scope",
] as const;
export type RebuttalReason = (typeof REBUTTAL_REASONS)[number];

/** §4.2 Closed revision-kind enum. */
export const REVISION_KINDS = ["narrowed_scope", "corrected_premise", "new_evidence", "restated"] as const;
export type RevisionKind = (typeof REVISION_KINDS)[number];

/** §10.3 Actor roles carried by audit events. */
export const DISPUTE_ACTOR_ROLES = ["implementer", "reviewer", "arbiter", "runner"] as const;
export type DisputeActorRole = (typeof DISPUTE_ACTOR_ROLES)[number];

/** §10.3 The full audit-event vocabulary. Events carry literals and counters only. */
export const DISPUTE_AUDIT_EVENTS = [
  "dispute.finding.opened",
  "dispute.rebuttal.recorded",
  "dispute.rebuttal.rejected",
  "dispute.reconsideration.recorded",
  "dispute.revision.material",
  "dispute.revision.non_material",
  "dispute.revision.ambiguous",
  "dispute.arbitration.verdict",
  "dispute.arbitration.malformed",
  "dispute.evidence.requested",
  "dispute.reopen.requested",
  "dispute.escalated.human",
  "dispute.resolved",
] as const;
export type DisputeAuditEvent = (typeof DISPUTE_AUDIT_EVENTS)[number];

/** §3.3 Evidence reference kinds. */
export const EVIDENCE_REF_KINDS = ["file", "test", "doc_section", "issue_quote"] as const;
export type EvidenceRefKind = (typeof EVIDENCE_REF_KINDS)[number];

// ---------------------------------------------------------------------------
// §1 Per-state facts
//
// One table, keyed by every lineage state. `Record<LineageState, …>` is what
// keeps this exhaustive: a token added to LINEAGE_STATES fails to compile until
// its terminality and its run-level meaning are declared here.
//
// These are per-state FACTS only. Whether a given state is reachable under a
// session's configured §6.1 limits, which counters a transition requires, and
// whether a persisted combination of state, counters, and versions is one the §7
// table could have produced are all questions about the transition machine, and
// they belong to the transition orchestration Issue (#840) — not to this
// module's schemas. #836 checks a record against itself; #840 checks a record
// against the run that must have produced it.
// ---------------------------------------------------------------------------

export interface LineageStateInfo {
  /** §1, §6.4: terminal states are immutable audit records; automation never reopens them. */
  terminal: boolean;
  /** §7.1 rule 2: `open`/`binding` select an implementer turn. */
  awaitsImplementer: boolean;
  /** §3.4 protocol-progress states: `disputed`, `arbitration_pending`, `evidence_requested`. */
  progress: boolean;
  /** §3.4 no-change-required terminal states. */
  noChangeRequired: boolean;
  /**
   * §11: a public comment is posted only on lineage resolution or human
   * escalation, and its outcome literal is the lineage's terminal state.
   * `binding` is not a resolution and never receives its own comment.
   */
  publishableOutcome: boolean;
}

export const LINEAGE_STATE_INFO: Record<LineageState, LineageStateInfo> = {
  open: {
    terminal: false, awaitsImplementer: true, progress: false, noChangeRequired: false, publishableOutcome: false,
  },
  disputed: {
    terminal: false, awaitsImplementer: false, progress: true, noChangeRequired: false, publishableOutcome: false,
  },
  arbitration_pending: {
    terminal: false, awaitsImplementer: false, progress: true, noChangeRequired: false, publishableOutcome: false,
  },
  evidence_requested: {
    terminal: false, awaitsImplementer: false, progress: true, noChangeRequired: false, publishableOutcome: false,
  },
  binding: {
    terminal: false, awaitsImplementer: true, progress: false, noChangeRequired: false, publishableOutcome: false,
  },
  resolved_fixed: {
    terminal: true, awaitsImplementer: false, progress: false, noChangeRequired: false, publishableOutcome: true,
  },
  resolved_withdrawn: {
    terminal: true, awaitsImplementer: false, progress: false, noChangeRequired: true, publishableOutcome: true,
  },
  resolved_overruled: {
    terminal: true, awaitsImplementer: false, progress: false, noChangeRequired: true, publishableOutcome: true,
  },
  escalated_human: {
    terminal: true, awaitsImplementer: false, progress: false, noChangeRequired: false, publishableOutcome: true,
  },
};

export type TerminalLineageState = "resolved_fixed" | "resolved_withdrawn" | "resolved_overruled" | "escalated_human";

/** The §11 outcome literals, derived from the table rather than restated. */
export const TERMINAL_LINEAGE_STATES: readonly LineageState[] = LINEAGE_STATES.filter(
  (state) => LINEAGE_STATE_INFO[state].terminal,
);

export function isLineageState(value: unknown): value is LineageState {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(LINEAGE_STATE_INFO, value);
}

export function isTerminalLineageState(state: LineageState): state is TerminalLineageState {
  return LINEAGE_STATE_INFO[state].terminal;
}

/** §7.1 rule 2: `open` or `binding` — the lineage is waiting for a disposition. */
export function awaitsImplementer(state: LineageState): boolean {
  return LINEAGE_STATE_INFO[state].awaitsImplementer;
}

/** §3.4 protocol-progress state. */
export function isProgressLineageState(state: LineageState): boolean {
  return LINEAGE_STATE_INFO[state].progress;
}

/**
 * §3.4: a lineage that ends the run in a no-change-required terminal state or a
 * protocol-progress state does not require a diff from that run.
 *
 * Whether the *run* is valid additionally depends on the admitting review being
 * fully structured (§13) — see {@link reviewStructureAllowsZeroChange}.
 */
export function allowsZeroChangeRun(state: LineageState): boolean {
  const info = LINEAGE_STATE_INFO[state];
  return info.noChangeRequired || info.progress;
}

/**
 * §3.1: a `binding` version accepts only `fixed` or `blocked`; its debate is
 * exhausted and a `review_disputed` on it is malformed (§12, row 24).
 */
export function dispositionAllowedForState(
  state: LineageState,
  disposition: ImplementationDisposition,
): boolean {
  if (!LINEAGE_STATE_INFO[state].awaitsImplementer) return false;
  if (state === "binding") return disposition !== "review_disputed";
  return true;
}

// ---------------------------------------------------------------------------
// §6.1 Bounded debate: normative constants and session limits
// ---------------------------------------------------------------------------

export interface ReviewDisputeLimits {
  /** `MAX_REBUTTALS_PER_VERSION` */
  maxRebuttalsPerVersion: number;
  /** `MAX_VERSIONS_PER_LINEAGE` */
  maxVersionsPerLineage: number;
  /** `MAX_RECONSIDERATIONS_PER_LINEAGE` */
  maxReconsiderationsPerLineage: number;
  /** `MAX_ARBITRATION_PASSES_PER_LINEAGE` */
  maxArbitrationPassesPerLineage: number;
  /** `MAX_MALFORMED_ARBITER_ATTEMPTS_PER_LINEAGE` */
  maxMalformedArbiterAttemptsPerLineage: number;
  /** `MAX_EVIDENCE_ROUNDS_PER_LINEAGE` */
  maxEvidenceRoundsPerLineage: number;
}

export type ReviewDisputeLimitKey = keyof ReviewDisputeLimits;

/**
 * The normative §6.1 table.
 *
 * `min` is the floor a session may configure, and it is the whole of the
 * positive-only rule: `maxRebuttalsPerVersion`, `maxVersionsPerLineage`,
 * `maxArbitrationPassesPerLineage`, and
 * `maxMalformedArbiterAttemptsPerLineage` reject 0 because at 0 the protocol
 * has a state with no next action — no dispute could ever be admitted, no
 * lineage could hold its own initial version, `arbitration_pending` could never
 * invoke the arbiter, and the first malformed arbiter attempt would satisfy
 * neither row 20 nor row 21. §6.1 makes each of those a session-load rejection,
 * fail closed: the protocol never starts half-enabled. The two remaining limits
 * may be lowered to 0 because §6.1 gives each an explicit fallback transition
 * (row 25 for the skipped reconsideration round, row 17's unavailable-round
 * event for the skipped evidence round).
 *
 * `max` is the default: session config may only LOWER a limit, never raise it.
 */
export const REVIEW_DISPUTE_LIMIT_SPECS: Record<
  ReviewDisputeLimitKey,
  { constant: string; default: number; min: number }
> = {
  maxRebuttalsPerVersion: { constant: "MAX_REBUTTALS_PER_VERSION", default: 1, min: 1 },
  maxVersionsPerLineage: { constant: "MAX_VERSIONS_PER_LINEAGE", default: 2, min: 1 },
  maxReconsiderationsPerLineage: { constant: "MAX_RECONSIDERATIONS_PER_LINEAGE", default: 1, min: 0 },
  maxArbitrationPassesPerLineage: { constant: "MAX_ARBITRATION_PASSES_PER_LINEAGE", default: 2, min: 1 },
  maxMalformedArbiterAttemptsPerLineage: {
    constant: "MAX_MALFORMED_ARBITER_ATTEMPTS_PER_LINEAGE", default: 2, min: 1,
  },
  maxEvidenceRoundsPerLineage: { constant: "MAX_EVIDENCE_ROUNDS_PER_LINEAGE", default: 1, min: 0 },
};

export const REVIEW_DISPUTE_LIMIT_KEYS = Object.keys(REVIEW_DISPUTE_LIMIT_SPECS) as ReviewDisputeLimitKey[];

/** The §6.1 defaults, derived from the spec table so the two cannot disagree. */
export const REVIEW_DISPUTE_DEFAULT_LIMITS: ReviewDisputeLimits = REVIEW_DISPUTE_LIMIT_KEYS.reduce(
  (acc, key) => {
    acc[key] = REVIEW_DISPUTE_LIMIT_SPECS[key].default;
    return acc;
  },
  {} as ReviewDisputeLimits,
);

/**
 * The absolute version ceiling, independent of session config.
 *
 * §4.2 and row 26: under `MAX_VERSIONS_PER_LINEAGE = 1` the successor record is
 * still REQUIRED and still validated at `predecessorVersion + 1`, because the §5
 * structural check compares its fields — it is simply never persisted as a
 * version. So successor validation is bounded by this constant, never by the
 * session's (possibly lowered) version budget.
 */
export const ABSOLUTE_MAX_VERSION = REVIEW_DISPUTE_LIMIT_SPECS.maxVersionsPerLineage.default;

/** §8.3 confidence threshold for the decisive verdicts of rows 13–14 and 18. */
export const DEFAULT_ARBITER_MIN_CONFIDENCE = 0.7;

/**
 * The agent ids `reviewDispute.arbiter.providers` may name.
 *
 * Declared as its own tuple rather than derived from {@link AgentId} so the
 * runtime check below and the compile-time type cannot drift apart. Despite the
 * config field's name, its entries are AGENT ids (`claude`, `codex`, `gemini`),
 * not provider display names — §8.3 selects an agent and reads its provider off
 * the resolved execution profile, never the other way round.
 */
export const ARBITER_CANDIDATE_AGENT_IDS: readonly AgentId[] = ["claude", "codex", "gemini"];

export interface ResolvedArbiterPolicy {
  /**
   * Ordered candidate agent ids (§8.3), validated at this boundary so selection
   * (issue #839) and invocation (#846) never see an arbitrary string.
   */
  providers: AgentId[];
  /** §8.3: a same-provider candidate is allowed only by explicit opt-in. */
  allowSameProvider: boolean;
  /** §8.3 confidence threshold. */
  minConfidence: number;
}

export interface ResolvedReviewDisputeSettings {
  /** §0: the protocol is gated behind this flag, which defaults to false. */
  enabled: boolean;
  limits: ReviewDisputeLimits;
  arbiter: ResolvedArbiterPolicy;
}

export type ReviewDisputeConfigErrorCode =
  | "not-an-integer"
  | "below-minimum"
  | "above-default"
  | "not-a-number"
  | "out-of-range"
  | "not-a-boolean"
  | "not-a-string-array"
  | "not-an-agent-id";

export interface ReviewDisputeConfigError {
  /** Config path, e.g. `reviewDispute.limits.maxVersionsPerLineage`. */
  path: string;
  /** The §6.1 constant name, when the error is about a protocol limit. */
  constant: string | null;
  code: ReviewDisputeConfigErrorCode;
  /** Operator-facing message; carries only literals and numbers. */
  message: string;
}

export type ReviewDisputeSettingsResolution =
  | { ok: true; settings: ResolvedReviewDisputeSettings }
  | { ok: false; errors: ReviewDisputeConfigError[] };

function limitErrors(
  cfg: ReviewDisputeLimitsConfig | undefined,
  basePath: string,
): { limits: ReviewDisputeLimits; errors: ReviewDisputeConfigError[] } {
  const limits: ReviewDisputeLimits = { ...REVIEW_DISPUTE_DEFAULT_LIMITS };
  const errors: ReviewDisputeConfigError[] = [];
  if (cfg === undefined) return { limits, errors };
  // Read through an untyped view: the config reaches this function from JSON, so
  // a declared `number` may still be a string at runtime and must be rejected
  // rather than trusted.
  const raw: Record<string, unknown> = { ...cfg };
  for (const key of REVIEW_DISPUTE_LIMIT_KEYS) {
    const configured = raw[key];
    if (configured === undefined) continue;
    const spec = REVIEW_DISPUTE_LIMIT_SPECS[key];
    const path = `${basePath}.${key}`;
    if (typeof configured !== "number" || !Number.isInteger(configured)) {
      errors.push({
        path,
        constant: spec.constant,
        code: "not-an-integer",
        message: `${path} (${spec.constant}) must be an integer`,
      });
      continue;
    }
    if (configured < spec.min) {
      errors.push({
        path,
        constant: spec.constant,
        code: "below-minimum",
        message:
          `${path} (${spec.constant}) must not be lower than ${spec.min}`
          + (spec.min > 0
            ? "; a session that wants the protocol off sets reviewDispute.enabled: false"
            : ""),
      });
      continue;
    }
    if (configured > spec.default) {
      errors.push({
        path,
        constant: spec.constant,
        code: "above-default",
        message: `${path} (${spec.constant}) may only be lowered; the contract maximum is ${spec.default}`,
      });
      continue;
    }
    limits[key] = configured;
  }
  return { limits, errors };
}

/**
 * Resolve and validate `session.reviewDispute`, failing closed (§6.1).
 *
 * Every problem is reported rather than clamped: a limit that would leave a
 * state without a next action must stop session load, not silently become the
 * default, because an operator who lowered it meant something by it.
 */
export function resolveReviewDisputeSettings(
  cfg: ReviewDisputeConfig | undefined,
  basePath = "reviewDispute",
): ReviewDisputeSettingsResolution {
  const errors: ReviewDisputeConfigError[] = [];

  if (cfg?.enabled !== undefined && typeof cfg.enabled !== "boolean") {
    errors.push({
      path: `${basePath}.enabled`,
      constant: null,
      code: "not-a-boolean",
      message: `${basePath}.enabled must be a boolean`,
    });
  }
  const enabled = cfg?.enabled === true;

  const { limits, errors: limitProblems } = limitErrors(cfg?.limits, `${basePath}.limits`);
  errors.push(...limitProblems);

  const arbiterCfg = cfg?.arbiter;
  const providers: AgentId[] = [];
  if (arbiterCfg?.providers !== undefined) {
    if (
      !Array.isArray(arbiterCfg.providers)
      || arbiterCfg.providers.some((p) => typeof p !== "string" || p.trim() === "")
    ) {
      errors.push({
        path: `${basePath}.arbiter.providers`,
        constant: null,
        code: "not-a-string-array",
        message: `${basePath}.arbiter.providers must be an array of non-empty agent ids`,
      });
    } else {
      // §8.3 names AGENT ids, and an entry this runner cannot resolve to one is
      // a candidate that could never be selected — so it is refused at load
      // rather than left to fail per-arbitration, where it would look like an
      // unavailable arbiter (row 19) instead of the typo it is. Reported per
      // entry, with the index, because a long list needs to say WHICH one.
      for (const [index, entry] of arbiterCfg.providers.entries()) {
        if ((ARBITER_CANDIDATE_AGENT_IDS as readonly string[]).includes(entry)) {
          providers.push(entry as AgentId);
          continue;
        }
        errors.push({
          path: `${basePath}.arbiter.providers[${index}]`,
          constant: null,
          code: "not-an-agent-id",
          message:
            `${basePath}.arbiter.providers[${index}] must be one of: `
            + `${ARBITER_CANDIDATE_AGENT_IDS.join(", ")} (agent ids, not provider names)`,
        });
      }
    }
  }
  if (arbiterCfg?.allowSameProvider !== undefined && typeof arbiterCfg.allowSameProvider !== "boolean") {
    errors.push({
      path: `${basePath}.arbiter.allowSameProvider`,
      constant: null,
      code: "not-a-boolean",
      message: `${basePath}.arbiter.allowSameProvider must be a boolean`,
    });
  }
  let minConfidence = DEFAULT_ARBITER_MIN_CONFIDENCE;
  if (arbiterCfg?.minConfidence !== undefined) {
    const value = arbiterCfg.minConfidence;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      errors.push({
        path: `${basePath}.arbiter.minConfidence`,
        constant: null,
        code: "not-a-number",
        message: `${basePath}.arbiter.minConfidence must be a finite number`,
      });
    } else if (value < 0 || value > 1) {
      errors.push({
        path: `${basePath}.arbiter.minConfidence`,
        constant: null,
        code: "out-of-range",
        message: `${basePath}.arbiter.minConfidence must be within [0, 1]`,
      });
    } else {
      minConfidence = value;
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    settings: {
      enabled,
      limits,
      arbiter: { providers, allowSameProvider: arbiterCfg?.allowSameProvider === true, minConfidence },
    },
  };
}

// ---------------------------------------------------------------------------
// Deterministic size and count bounds
//
// The protocol must not grow task context across bounded cycles. Every bound
// below is a fixed constant — none depends on agent output — so the worst-case
// serialized context is a product of constants:
//
//   MAX_LINEAGES_PER_TASK (24) × (bounded per-lineage record, < 768 bytes)
//     ≈ 18 KB < REVIEW_DISPUTE_CONTEXT_MAX_BYTES (32 KB)
//
// and the per-lineage record itself is bounded because every counter is capped
// by §6.1, its two ledgers are capped by `maxRebuttalsPerVersion ×
// maxVersionsPerLineage` (`disputeRuns`) and by
// {@link MAX_APPLIED_TRANSITIONS_PER_LINEAGE} (`appliedTransitions`, whose
// entries are fixed-width digests), and the only variable-length fields it keeps
// are the lineage id, the severity literal, and the bounded `affectedBoundary`.
// Full records (arguments, rationales, evidence) live in run artifacts (§10.1,
// §10.2), never in context.
// ---------------------------------------------------------------------------

export const MAX_LINEAGES_PER_TASK = 24;
export const MAX_FINDINGS_PER_REVIEW = 12;
export const MAX_DISPOSITIONS_PER_RUN = MAX_LINEAGES_PER_TASK;

export const MAX_FINDING_TEXT_CHARS = 2_000;
export const MAX_AFFECTED_BOUNDARY_CHARS = 200;
export const MAX_ARGUMENT_CHARS = 4_000;
export const MAX_WHY_NO_CHANGE_CHARS = 2_000;
export const MAX_RATIONALE_CHARS = 2_000;
export const MAX_NOTE_CHARS = 1_000;

export const MAX_EVIDENCE_REFS_PER_RECORD = 10;
export const MAX_TEST_EVIDENCE_ITEMS = 10;
export const MAX_TEST_NAME_CHARS = 200;
export const MAX_EVIDENCE_PATH_CHARS = 200;
export const MAX_DOC_SECTION_CHARS = 200;
export const MAX_EVIDENCE_QUOTE_CHARS = 1_000;
export const MAX_EVIDENCE_LINE = 1_000_000;

export const MAX_AGENT_ID_CHARS = 80;
export const MAX_RUN_ID_CHARS = 120;
export const MAX_MODEL_CHARS = 120;

/** Upper bound on a single serialized record payload handed to a validator. */
export const REVIEW_DISPUTE_RECORD_MAX_BYTES = 64 * 1024;

/** Upper bound on the serialized `task.context.reviewDispute` value (§10.1). */
export const REVIEW_DISPUTE_CONTEXT_MAX_BYTES = 32 * 1024;

/**
 * §13 / §10.1: free prose in the protocol is bounded exactly the way
 * `reviewFeedback` already is, so the legacy representation cannot grow the
 * context column beyond today's ceiling.
 */
export const MAX_LEGACY_FEEDBACK_CHARS = 20_000;

// ---------------------------------------------------------------------------
// §2 Finding schema, lineage, and versions
// ---------------------------------------------------------------------------

/** §3.3 evidence references. Resolution is read-only and runner-owned. */
export type EvidenceRef =
  | { kind: "file"; path: string; startLine: number; endLine: number }
  | { kind: "test"; name: string }
  | { kind: "doc_section"; path: string; section: string }
  | { kind: "issue_quote"; quote: string };

/**
 * §2.1 `reviewerMeta`: recorded from the review run's own metadata, never from
 * agent output.
 */
export interface ReviewerMeta {
  agentId: string;
  model?: string;
  effort?: string;
  reviewRunId: string;
  /** ISO-8601 date-time with an explicit offset, e.g. `new Date().toISOString()`. */
  timestamp: string;
}

/** The agent-authored half of a §2.1 finding record. */
export interface FindingBody {
  severity: FindingSeverity;
  violatedContract: string;
  preconditions: string;
  failureScenario: string;
  /** Repository-relative after the §2.1 admission normalization. */
  affectedBoundary: string;
  requiredOutcome: string;
  evidenceRefs: EvidenceRef[];
}

/**
 * §2.1: what a review run emits — the finding record minus the runner-owned
 * fields. `lineageId` may be echoed to attach to a live lineage, never minted.
 */
export interface CandidateFinding extends FindingBody {
  version: number;
  lineageId?: string;
}

/** §2.1: the admitted record, after the runner stamped its own fields. */
export interface ReviewFinding extends FindingBody {
  lineageId: string;
  version: number;
  /** Runner-stamped; a reviewer-supplied value is ignored and logged (§2.1). */
  humanGate: boolean;
  reviewerMeta: ReviewerMeta;
}

/** The three §2.1 fields only the runner may populate. */
export const RUNNER_OWNED_FINDING_FIELDS = ["lineageId", "humanGate", "reviewerMeta"] as const;
export type RunnerOwnedFindingField = (typeof RUNNER_OWNED_FINDING_FIELDS)[number];

/** Every §2.1 field name, used by `changedFields` (§4.2) and the §5 check. */
export const FINDING_FIELD_NAMES = [
  "severity",
  "violatedContract",
  "preconditions",
  "failureScenario",
  "affectedBoundary",
  "requiredOutcome",
  "evidenceRefs",
] as const;
export type FindingFieldName = (typeof FINDING_FIELD_NAMES)[number];

/**
 * §5: the fields whose change can make a revision material. Everything absent
 * from this list — `severity` above all — is never material on its own.
 */
export const MATERIAL_FINDING_FIELDS = [
  "violatedContract",
  "preconditions",
  "failureScenario",
  "affectedBoundary",
  "requiredOutcome",
  "evidenceRefs",
] as const;
export type MaterialFindingField = (typeof MATERIAL_FINDING_FIELDS)[number];

export function isMaterialFindingField(field: FindingFieldName): field is MaterialFindingField {
  return (MATERIAL_FINDING_FIELDS as readonly string[]).includes(field);
}

/** The stamp the runner applies to a candidate at admission (§2.1). */
export interface FindingAdmissionStamp {
  lineageId: string;
  humanGate: boolean;
  reviewerMeta: ReviewerMeta;
}

// ---------------------------------------------------------------------------
// §3 Implementation disposition and dispute schema
// ---------------------------------------------------------------------------

/** §3.2 dispute record, embedded in a `review_disputed` disposition. */
export interface DisputeRecord {
  challenged: { lineageId: string; version: number };
  rebuttalReason: RebuttalReason;
  argument: string;
  evidenceRefs: EvidenceRef[];
  testEvidence?: string[];
  whyNoChange: string;
}

/** §3.1 disposition record. */
export interface DispositionRecord {
  lineageId: string;
  version: number;
  disposition: ImplementationDisposition;
  note?: string;
  /** REQUIRED for `review_disputed`, forbidden otherwise (§3.2). */
  dispute?: DisputeRecord;
}

// ---------------------------------------------------------------------------
// §4 Reviewer reconsideration
// ---------------------------------------------------------------------------

/** §4.2 revision record, embedded in a `revise` reconsideration. */
export interface RevisionRecord {
  predecessorVersion: number;
  changedFields: FindingFieldName[];
  revisionKind: RevisionKind;
  /** §5: an input to audit, never to the materiality decision. */
  materialityClaim: boolean;
  /** The successor §2.1 record, a candidate until row 11 persists it. */
  successor: CandidateFinding;
}

/** §4.1 reconsideration record. */
export interface ReconsiderationRecord {
  lineageId: string;
  version: number;
  reconsideration: ReviewerReconsideration;
  rationale: string;
  /** REQUIRED for `revise`, forbidden otherwise (§4.2). */
  revision?: RevisionRecord;
}

// ---------------------------------------------------------------------------
// §8.1 Arbiter verdict
// ---------------------------------------------------------------------------

export interface ArbiterVerdictRecord {
  lineageId: string;
  version: number;
  verdict: ArbiterVerdict;
  /** Number in [0, 1]; a verdict without one is malformed (§12). */
  confidence: number;
  /** Bounded prose, local-only — never published (§11). */
  rationale: string;
}

/**
 * §8.2 arbiter bundle manifest: what the runner included, by reference and
 * hash, never duplicated content (§10.2).
 */
export interface ArbiterBundleEntry {
  /**
   * What the entry is: the lineage's own literals, a finding version, a record,
   * an evidence ref, the issue body, a diff hunk.
   *
   * `lineage` covers the header the bundle renders for the disputed lineage —
   * its state, severity, boundary, human gate, and §6.1 counters. Those are
   * bundle content like any other: two arbitrations of the same records differ
   * when the counters differ, and a manifest that could not name them would
   * attest to less than the arbiter was shown.
   */
  kind:
    | "lineage"
    | "finding_version"
    | "dispute"
    | "reconsideration"
    | "evidence"
    | "issue_body"
    | "diff_hunk"
    | "verdict";
  /** Content-free locator (a repository-relative path, a record id, a version). */
  ref: string;
  /** sha256 of the included content, so the manifest need not duplicate it. */
  sha256: string;
  bytes: number;
}

export interface ArbiterBundleManifest {
  lineageId: string;
  version: number;
  entries: ArbiterBundleEntry[];
}

// ---------------------------------------------------------------------------
// §10.1 Persisted task-context state
// ---------------------------------------------------------------------------

/** §6.1 counters, all runner-owned and all bounded by the resolved limits. */
export interface LineageCounters {
  /** Total admitted rebuttals; equals `rebuttedVersions.length` (§6.1). */
  rebuttals: number;
  reconsiderations: number;
  /** §8.3: passes count RETURNED verdicts; malformed output never consumes one. */
  arbitrationPasses: number;
  /** §12: runner-owned, bounds arbiter retries only. */
  malformedArbiterAttempts: number;
  evidenceRoundsUsed: number;
}

export const ZERO_LINEAGE_COUNTERS: LineageCounters = {
  rebuttals: 0,
  reconsiderations: 0,
  arbitrationPasses: 0,
  malformedArbiterAttempts: 0,
  evidenceRoundsUsed: 0,
};

/**
 * §10.1 / #844: which implementation run consumed a version's rebuttal slot.
 *
 * The pair is the idempotency key of dispute persistence: a retried delivery of
 * the SAME run's disposition set finds its own entry already on file and stores
 * nothing a second time, while a DIFFERENT run addressing the same version finds
 * the slot consumed and is refused (§6.1). Literals only — a run id, a version —
 * so the record stays free of prose and bounded: at most one entry per
 * version per rebuttal slot, i.e. `maxRebuttalsPerVersion × maxVersionsPerLineage`
 * entries, each with a `MAX_RUN_ID_CHARS`-bounded id.
 */
export interface LineageDisputeRun {
  /** The finding version whose §6.1 rebuttal slot this run consumed. */
  version: number;
  /** The implementation run's id (`runId`), bounded by `MAX_RUN_ID_CHARS`. */
  runId: string;
}

/**
 * #840: how many applied-transition digests one lineage may carry.
 *
 * The protocol bounds a lineage to at most ten transitions — one admission, one
 * rebuttal per version (2), one reconsideration, two arbitration passes, two
 * malformed-arbiter attempts, one evidence round, and one terminal disposition —
 * so this ceiling is headroom over a bound the §6.1 counters already enforce,
 * not a budget of its own. A record that reaches it describes a debate the §7
 * table could not have produced, and the transition layer refuses to grow it
 * further rather than dropping the oldest key: an idempotency ledger that
 * forgets is one that applies a delivery twice.
 */
export const MAX_APPLIED_TRANSITIONS_PER_LINEAGE = 12;

/**
 * The digest length of one applied-transition key.
 *
 * The key itself is `<lineageId>@<version>#<runId>`; only this short sha256
 * prefix is persisted, in the same form §2.2 mints lineage ids from, so the
 * ledger stays inside the §10.1 byte budget and carries no run identifier,
 * prose, or path into task context.
 */
export const APPLIED_TRANSITION_DIGEST_CHARS = 12;
export const APPLIED_TRANSITION_DIGEST_RE = /^[0-9a-f]{12}$/;

/**
 * The bounded per-lineage record kept in `task.context.reviewDispute` (§10.1):
 * literals and counters only. Argument and rationale prose lives in artifacts.
 */
export interface PersistedLineage {
  lineageId: string;
  state: LineageState;
  /** The lineage's current finding version. */
  version: number;
  counters: LineageCounters;
  /**
   * The versions whose single rebuttal slot has been consumed (§6.1). Distinct,
   * and never above `version` — a version cannot be rebutted before it exists.
   */
  rebuttedVersions: number[];
  /**
   * #844: the implementation run behind each consumed rebuttal slot, one entry
   * per member of {@link rebuttedVersions}. Absent on records written before
   * dispute persistence existed — such a record still bounds the debate through
   * `rebuttedVersions`, it simply cannot recognize a retried delivery as its own
   * and refuses it as a second rebuttal instead (fail closed, never a duplicate).
   */
  disputeRuns?: LineageDisputeRun[];
  /**
   * #840: the §7 transitions already applied to this lineage, as opaque digests
   * of their `<lineageId>@<version>#<runId>` keys.
   *
   * This is the idempotency ledger of the transition layer, and it is a ledger
   * rather than a derived fact because the ROW a re-delivered outcome names can
   * legitimately move: once a below-cap malformed arbiter attempt (row 20) has
   * been applied, a second delivery of the SAME arbitration run reads the
   * incremented counter and names row 21. The run key does not move, so an
   * outcome already applied for one is recognizable as the duplicate it is.
   * Absent on records written before the transition layer existed; such a record
   * recognizes no replay and fails closed on the state and counter gates
   * instead, never applying a delivery twice.
   */
  appliedTransitions?: string[];
  /** Runner-stamped at admission of each version (§2.1). */
  humanGate: boolean;
  severity: FindingSeverity;
  /** Admission-normalized repository-relative value; §11 publishes exactly this. */
  affectedBoundary: string;
  /** §11 outcome literal — present only once the lineage is terminal. */
  outcome?: TerminalLineageState;
  /** §2.2 / §7 note on rows 1/5/23: the `resolved_fixed` lineage this one succeeds. */
  supersedes?: string;
  /** §6.4: routes to human escalation only; never changes the lineage's state. */
  reopenRequested?: boolean;
}

/** §13 how the admitting review was shaped. */
export const REVIEW_STRUCTURE_MODES = ["legacy", "mixed", "structured"] as const;
export type ReviewStructureMode = (typeof REVIEW_STRUCTURE_MODES)[number];

/** `task.context.reviewDispute` (§10.1). */
export interface ReviewDisputeContext {
  /** Schema version of this context block; only `1` exists. */
  version: 1;
  /** §13: the shape of the review that admitted the current lineages. */
  reviewStructure: ReviewStructureMode;
  lineages: Record<string, PersistedLineage>;
  /** §7.1 rules 2–4: an unreviewed diff is on the branch. */
  pendingReReview?: boolean;
  /** §7.1 rule 4. */
  resolvedWithoutChanges?: boolean;
}

export function emptyReviewDisputeContext(reviewStructure: ReviewStructureMode = "legacy"): ReviewDisputeContext {
  return { version: 1, reviewStructure, lineages: {} };
}

// ---------------------------------------------------------------------------
// §13 Backward compatibility: legacy free-form `reviewFeedback`
// ---------------------------------------------------------------------------

/**
 * The contract-defined representation of legacy free-form review output.
 *
 * §13: with the protocol enabled, a review that emits no structured finding
 * block is handled exactly as today — the free-form feedback routes to fix mode,
 * no lineage exists, and therefore no dispute is possible. That "no lineage,
 * not disputable" fact is a first-class value here rather than an absence, so a
 * caller cannot accidentally treat legacy feedback as a disputable finding: the
 * `disputable` field is typed `false`, so no code path can widen it.
 */
export interface LegacyReviewFinding {
  kind: "legacy_free_form";
  /** §13: prose cannot be disputed. Typed as the literal `false`. */
  disputable: false;
  /** The bounded `reviewFeedback` text, unchanged from today's payload. */
  feedback: string;
  /** Whether the bound truncated the feedback. */
  truncated: boolean;
}

/**
 * Represent `task.context.reviewFeedback` as the non-disputable legacy finding.
 *
 * Returns `null` for absent or whitespace-only feedback: there is nothing to
 * carry, and an empty legacy finding would misreport a fully structured review
 * (§13) as mixed.
 */
export function legacyFindingFromReviewFeedback(
  feedback: string | undefined | null,
  maxChars: number = MAX_LEGACY_FEEDBACK_CHARS,
): LegacyReviewFinding | null {
  if (typeof feedback !== "string" || feedback.trim() === "") return null;
  const truncated = feedback.length > maxChars;
  return {
    kind: "legacy_free_form",
    disputable: false,
    feedback: truncated ? feedback.slice(0, maxChars) : feedback,
    truncated,
  };
}

export interface ReviewStructureInput {
  /** How many structured finding blocks the runner extracted (issue #841). */
  structuredFindingCount: number;
  /** What remained of the review output after extraction. */
  residualFeedback: string | undefined | null;
}

export interface ReviewStructureClassification {
  mode: ReviewStructureMode;
  /** The legacy representation of the residual prose, when there is any. */
  legacyFinding: LegacyReviewFinding | null;
  /**
   * §13: the zero-change validity of §3.4 and the `resolvedWithoutChanges`
   * outcome of §7.1 rule 4 apply only to a fully structured review. A mixed
   * review's prose keeps its legacy blocking force, so it fails closed.
   */
  zeroChangeValid: boolean;
}

/**
 * §13: classify a review run as `legacy`, `mixed`, or `structured`.
 *
 * A review is **fully structured** when, after the structured blocks are
 * extracted, the remaining free-form feedback is empty or whitespace-only.
 */
export function classifyReviewStructure(input: ReviewStructureInput): ReviewStructureClassification {
  const legacyFinding = legacyFindingFromReviewFeedback(input.residualFeedback);
  if (input.structuredFindingCount <= 0) {
    return { mode: "legacy", legacyFinding, zeroChangeValid: false };
  }
  if (legacyFinding === null) {
    return { mode: "structured", legacyFinding: null, zeroChangeValid: true };
  }
  return { mode: "mixed", legacyFinding, zeroChangeValid: false };
}

/** §13: only a fully structured review permits the §3.4 zero-change run. */
export function reviewStructureAllowsZeroChange(mode: ReviewStructureMode): boolean {
  return mode === "structured";
}
