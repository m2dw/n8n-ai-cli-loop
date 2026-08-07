/**
 * Issue #840: the review-dispute transition applicator (§7 and §7.1 of
 * docs/review-dispute-contract.md).
 *
 * This is the layer that turns already-approved decisions into ONE deterministic
 * next state. Everything upstream of it decides; this module applies:
 *
 *  - #841 admits structured findings and builds the initial lineage block;
 *  - #843/#844 parse and persist a fix run's dispositions;
 *  - #845 classifies a `revise` (rows 11, 12, 26);
 *  - #847 routes an arbitration outcome (rows 13–21).
 *
 * Nothing here re-parses reviewer, implementer, reconsideration, or arbiter
 * output, and nothing here re-decides a row those modules already decided. What
 * it adds is the part none of them may own alone: the CURRENT block is the
 * compare-and-set baseline, the §6.1 counters move exactly once, the §7 rows the
 * predecessors deliberately left to the transition owner (1, 4, 5, 8, 9, 10, 22,
 * 23, 24, and the row-6/25 partition of an admitted dispute) fire here, and the
 * §7.1 run-level aggregation is derived from the resulting lineage set rather
 * than reconstructed independently by each later surface.
 *
 * Three properties hold for every value returned, including every fail-closed
 * one:
 *
 *  1. **Never partial.** A refusal leaves its lineage exactly where it was, and a
 *     block that cannot be validated or serialized after the changes is returned
 *     as a whole-operation failure so the caller keeps the stored block intact
 *     (§12).
 *  2. **Never a second application.** Every transition records a bounded digest
 *     of its `<lineageId>@<version>#<runId>` key in the lineage's
 *     `appliedTransitions` ledger, and a delivery whose digest is already on file
 *     is reported as a replay — no counter moves, no state changes, and the
 *     caller writes nothing. This is what #847's `runKey` note asks for: the ROW
 *     a re-delivered outcome names can legitimately move (a row-20 attempt reads
 *     as row 21 once its counter is applied), so the run key — not the row — is
 *     the identity a duplicate is recognized by. The ledger is also the ONLY
 *     such authority: a dispute #844 recorded before this ledger existed still
 *     owes its row here, so an empty ledger means "not yet applied" even when
 *     #844's older idempotency key already recognizes the delivery.
 *  3. **Never a silent clamp.** A delta that would push a counter past its §6.1
 *     ceiling, a decision whose `countersAfter` disagrees with the current
 *     baseline, a stale version, or a predecessor state that no longer accepts
 *     the decision is REJECTED. An invalid movement is never rounded down to a
 *     valid one.
 *
 * Out of scope, deliberately: invoking any agent, writing artifacts, rendering a
 * public comment or label (#848), and the durable write itself — that is
 * {@link ../core/review-dispute-commit.js}, which commits the patch and its one
 * bounded event in a single TaskStore transaction.
 */

import { createHash } from "crypto";
import {
  ABSOLUTE_MAX_VERSION,
  MAX_APPLIED_TRANSITIONS_PER_LINEAGE,
  MAX_LINEAGES_PER_TASK,
  REVIEW_DISPUTE_DEFAULT_LIMITS,
  ZERO_LINEAGE_COUNTERS,
  isTerminalLineageState,
  reviewStructureAllowsZeroChange,
  type DisputeActorRole,
  type DisputeAuditEvent,
  type LineageCounters,
  type LineageState,
  type PersistedLineage,
  type ReviewDisputeContext,
  type ReviewDisputeLimits,
  type TerminalLineageState,
} from "./review-dispute.js";
import { serializeReviewDisputeContext, stableStringify } from "./review-dispute-lineage.js";
import { validateReviewDisputeContext } from "./review-dispute-validation.js";
import type {
  AdmittedDisposition,
  AdmittedReconsideration,
  ReviewDisputeFailure,
  ReviewDisputeFailureReason,
} from "./review-dispute-validation.js";
import type { FixDispositionOutcome } from "./review-fix-disposition-response.js";
import type { FixDisputePersistence } from "./review-dispute-persistence.js";
import type { RevisionDecision } from "./review-revision-decision.js";
import {
  ARBITRATION_ROUTE_REASONS,
  type ArbitrationOperationalFailure,
  type ArbitrationRouteDecision,
  type ArbitrationRouteReason,
} from "./review-arbitration-route.js";
import type { TaskPhase } from "./task.js";

// ---------------------------------------------------------------------------
// Result vocabulary
// ---------------------------------------------------------------------------

/** Every §7 row. The transition layer is the one place that names all of them. */
export const DISPUTE_TRANSITION_ROWS = [
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26,
] as const;
export type DisputeTransitionRow = (typeof DISPUTE_TRANSITION_ROWS)[number];

/** Which already-approved decision is being applied. */
export const DISPUTE_TRANSITION_KINDS = [
  "finding_admission",
  "dispositions",
  "reconsideration",
  "arbitration",
  "evidence_round",
  "reopen_request",
] as const;
export type DisputeTransitionKind = (typeof DISPUTE_TRANSITION_KINDS)[number];

/**
 * The bounded reason literal a transition carries into the audit record.
 *
 * #847's row reasons are spread in rather than restated, so rows 13–21 report
 * exactly the token their own decision reported and the two vocabularies cannot
 * drift. The remaining tokens are the rows this module owns.
 */
export const DISPUTE_TRANSITION_OWN_REASONS = [
  /** A lineage opened at version 1 by an admitted structured finding (§2.2). */
  "finding-opened",
  /** Rows 1, 5, 23. */
  "fixed",
  /** Rows 4, 8, 24. */
  "blocked",
  /** Row 2: an admitted dispute awaiting the reviewer's reconsideration. */
  "dispute-admitted",
  /** Rows 3, 7: `humanGate: true` escalates AT dispute admission (§9). */
  "dispute-human-gated",
  /** Row 6: version 2's dispute skips reconsideration entirely (§6.2). */
  "dispute-final-version",
  /** Row 25: `MAX_RECONSIDERATIONS_PER_LINEAGE = 0` (§6.1). */
  "dispute-reconsideration-unavailable",
  /** Row 9. */
  "withdraw",
  /** Row 10. */
  "uphold",
  /** Row 11. */
  "revision-material",
  /** Row 12. */
  "revision-not-material",
  /** Row 26: material, but the session's version budget forbids a successor. */
  "revision-successor-unavailable",
  /** Row 22: the bounded evidence round's attachments are on file (§7.1). */
  "evidence-recorded",
  /** §6.4: a runner-recorded flag on a terminal lineage, never a §7 row. */
  "reopen-requested",
] as const;

export type DisputeTransitionReason =
  | ArbitrationRouteReason
  | (typeof DISPUTE_TRANSITION_OWN_REASONS)[number];

/** The full vocabulary, for a caller that needs it at runtime. */
export const DISPUTE_TRANSITION_REASONS: readonly DisputeTransitionReason[] = [
  ...ARBITRATION_ROUTE_REASONS,
  ...DISPUTE_TRANSITION_OWN_REASONS,
];

/**
 * One lineage's applied transition — literals and counters only (§10.3).
 *
 * Everything here is safe for a task event: no prose, no evidence content, no
 * local path. `transitionKey` is the ledger digest, which is opaque by
 * construction.
 */
export interface AppliedLineageTransition {
  lineageId: string;
  /** The version the decision addressed. */
  version: number;
  /** The version the lineage carries afterwards (row 11 is the only mover). */
  versionAfter: number;
  /** The §7 row, or null for the two events §10.3 emits without a transition. */
  row: DisputeTransitionRow | null;
  fromState: LineageState;
  toState: LineageState;
  counterDelta: LineageCounters;
  countersAfter: LineageCounters;
  auditEvent: DisputeAuditEvent;
  reason: DisputeTransitionReason;
  actor: DisputeActorRole;
  /** Opaque digest of `<lineageId>@<version>#<runId>` (the idempotency key). */
  transitionKey: string;
  /** True when this exact delivery was already on file: nothing was applied. */
  replayed: boolean;
}

/** One decision the CURRENT block refused (§12). Its lineage is untouched. */
export interface RefusedLineageTransition {
  lineageId: string;
  version: number;
  failure: ReviewDisputeFailure;
}

// ---------------------------------------------------------------------------
// §7.1 run-level aggregation
// ---------------------------------------------------------------------------

/** §7.1 rule 2: which party acts next, once the rule-2 precedence is applied. */
export const DISPUTE_TASK_TURNS = ["implementer", "reviewer", "evidence", "runner", "re_review", "none"] as const;
export type DisputeTaskTurn = (typeof DISPUTE_TASK_TURNS)[number];

/** The task-level outcome of §7.1, one per rule plus the §13 legacy path. */
export const DISPUTE_TASK_OUTCOMES = [
  /** Rule 1: a lineage escalated, or a terminal one carries `reopen_requested`. */
  "human_handoff",
  /** Rule 2: the review/fix loop continues, inside the review-loop cap. */
  "continue",
  /** Rule 3: every lineage is terminal and an unreviewed diff must go to review. */
  "re_review",
  /** Rule 4, fully structured review: the run resolved with no changes required. */
  "resolved_without_changes",
  /** Rule 4, mixed review (§13): the prose keeps its legacy blocking force. */
  "no_change_run_invalid",
  /** §13: no structured lineage exists — the legacy free-form path is unchanged. */
  "legacy",
] as const;
export type DisputeTaskOutcome = (typeof DISPUTE_TASK_OUTCOMES)[number];

/**
 * §7.1, as one deterministic value.
 *
 * Derived from the UPDATED lineage set by precedence, evaluated in rule order so
 * exactly one outcome applies, and computed over lineage ids in sorted order so
 * two runs that touched the same lineages in a different sequence aggregate
 * identically.
 */
export interface DisputeTaskRouting {
  /** The §7.1 rule that fired, or null on the §13 legacy path. */
  rule: 1 | 2 | 3 | 4 | null;
  outcome: DisputeTaskOutcome;
  turn: DisputeTaskTurn;
  /**
   * The phase the task should run next, or null when no agent run is dispatched
   * (the runner turn of rule 2, the evidence turn's two per-party runs, and the
   * two rule-4 outcomes, which route through the ordinary review result).
   */
  nextPhase: TaskPhase | null;
  /** Rule 1: automation stops and a human decides (§9). */
  readyForHuman: boolean;
  escalatedLineageIds: string[];
  /** §6.4: terminal lineages carrying the flag, escalated by rule 1. */
  reopenRequestedLineageIds: string[];
  /** The lineages the selected turn carries. */
  actionableLineageIds: string[];
  pendingReReview: boolean;
  resolvedWithoutChanges: boolean;
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/** The run applying the decision. `runId` is half of the idempotency key. */
export interface DisputeTransitionRunIdentity {
  runId: string;
  /** §10.3 actor role recorded on every transition this call applies. */
  actor: DisputeActorRole;
}

/**
 * The already-approved decisions, consumed exactly as their owners return them.
 *
 * A caller cannot hand this module a hand-built row, a raw transcript, or a
 * free-form verdict: every member is a typed predecessor output.
 */
export type DisputeTransitionDecision =
  | {
      kind: "finding_admission";
      /** #841's `buildInitialLineageContext` result, built over the CURRENT block. */
      next: ReviewDisputeContext;
    }
  | {
      kind: "dispositions";
      /** #844's persistence, computed against the CURRENT block. */
      persistence: FixDisputePersistence;
      /** #843's validated outcome: the `fixed`/`blocked` records are applied here. */
      outcome: FixDispositionOutcome;
      /** §3.4/§7.1: did the fix run leave an unreviewed diff on the branch? */
      runProducedFileChanges: boolean;
    }
  | {
      kind: "reconsideration";
      /** #838's admitted record and the lineage it was admitted against. */
      admitted: AdmittedReconsideration;
      /** #845's classification. Required for `revise`, ignored otherwise. */
      revision?: RevisionDecision;
    }
  | { kind: "arbitration"; decision: ArbitrationRouteDecision }
  | {
      kind: "evidence_round";
      lineageId: string;
      version: number;
      /** How many §3.3 attachments the round admitted; zero is a valid round. */
      attachmentsRecorded: number;
    }
  | { kind: "reopen_request"; lineageId: string };

export interface DisputeTransitionInput {
  /**
   * The task's CURRENT validated §10.1 block — the compare-and-set baseline, not
   * the snapshot the decision was made against.
   */
  context: ReviewDisputeContext;
  decision: DisputeTransitionDecision;
  run: DisputeTransitionRunIdentity;
  /** The session's resolved §6.1 limits. Defaults to the normative maxima. */
  limits?: ReviewDisputeLimits;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

/**
 * The bounded payload of the ONE task event a committed transition appends.
 *
 * A type alias rather than an interface on purpose: the durable layer hands it
 * to `TaskEvent.data` (a `Record<string, unknown>`), and only an alias carries
 * the implicit index signature that assignment needs.
 */
export type DisputeTransitionEventData = {
  decision: DisputeTransitionKind;
  runId: string;
  actor: DisputeActorRole;
  applied: AppliedLineageTransition[];
  refused: RefusedLineageTransition[];
  auditEvents: DisputeAuditEvent[];
  routing: DisputeTaskRouting;
  /** #847's typed non-row failure, when the turn ended without one. */
  operational: ArbitrationOperationalFailure | null;
}

export interface DisputeTransitionApplication {
  /** The next §10.1 block, ready to write to `task.context.reviewDispute`. */
  context: ReviewDisputeContext;
  /** Its serialized form, already bounded by `REVIEW_DISPUTE_CONTEXT_MAX_BYTES`. */
  serialized: string;
  /** True when the block is byte-identical to the one that came in. */
  unchanged: boolean;
  /**
   * True when EVERY transition this delivery carried was already on file. The
   * durable layer skips its write entirely on a replay, so no counter moves and
   * no second event is appended.
   */
  replayed: boolean;
  applied: AppliedLineageTransition[];
  refused: RefusedLineageTransition[];
  routing: DisputeTaskRouting;
  event: DisputeTransitionEventData;
  operational: ArbitrationOperationalFailure | null;
}

export type DisputeTransitionResult =
  | { ok: true; value: DisputeTransitionApplication }
  | { ok: false; failure: ReviewDisputeFailure };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Own-property lookup: an inherited `Object.prototype` member names no lineage. */
function ownLineage(
  lineages: Readonly<Record<string, PersistedLineage>>,
  lineageId: string,
): PersistedLineage | undefined {
  return Object.prototype.hasOwnProperty.call(lineages, lineageId) ? lineages[lineageId] : undefined;
}

function copyLineages(source: Readonly<Record<string, PersistedLineage>>): Record<string, PersistedLineage> {
  // Null-prototype, mirroring the #836 validator and #841's builder: lineage ids
  // are runner-minted, but on a plain object a prototype key would set the
  // prototype instead of adding an entry.
  const out = Object.create(null) as Record<string, PersistedLineage>;
  for (const [lineageId, lineage] of Object.entries(source)) out[lineageId] = lineage;
  return out;
}

/**
 * The idempotency key of one transition, as a bounded opaque digest.
 *
 * The key itself is `<lineageId>@<version>#<runId>` — #846's run key, and the
 * same three literals #838 keys a reconsideration on. Only its digest is
 * persisted: a run id is bounded by `MAX_RUN_ID_CHARS` (120), and keeping whole
 * keys for every transition of every lineage would grow the §10.1 block past its
 * own byte budget. Twelve hex characters of sha256 is the same short-digest form
 * §2.2 already mints lineage ids from.
 *
 * The ROW is deliberately absent, per #847: a re-delivered outcome can name a
 * different row than the first delivery did (a row-20 malformed attempt reads as
 * row 21 once its counter is applied), so a key carrying the row would fail to
 * recognize the duplicate it exists to catch. The consequence for the caller is
 * the other half of that contract: two DIFFERENT turns for one lineage version —
 * the row-20 retry above all — must be dispatched under distinct run ids, or the
 * second is indistinguishable from a redelivery of the first and is dropped as
 * the replay it looks like. Fail closed in the direction that never applies a
 * transition twice.
 */
export function transitionKey(lineageId: string, version: number, runId: string): string {
  return `${lineageId}@${version}#${runId}`;
}

export function transitionDigest(lineageId: string, version: number, runId: string): string {
  return createHash("sha256").update(transitionKey(lineageId, version, runId), "utf8").digest("hex").slice(0, 12);
}

function alreadyApplied(lineage: PersistedLineage, digest: string): boolean {
  return (lineage.appliedTransitions ?? []).includes(digest);
}

const NO_COUNTER_DELTA: LineageCounters = { ...ZERO_LINEAGE_COUNTERS };

function addCounters(counters: LineageCounters, delta: LineageCounters): LineageCounters {
  return {
    rebuttals: counters.rebuttals + delta.rebuttals,
    reconsiderations: counters.reconsiderations + delta.reconsiderations,
    arbitrationPasses: counters.arbitrationPasses + delta.arbitrationPasses,
    malformedArbiterAttempts: counters.malformedArbiterAttempts + delta.malformedArbiterAttempts,
    evidenceRoundsUsed: counters.evidenceRoundsUsed + delta.evidenceRoundsUsed,
  };
}

function subtractCounters(after: LineageCounters, before: LineageCounters): LineageCounters {
  return {
    rebuttals: after.rebuttals - before.rebuttals,
    reconsiderations: after.reconsiderations - before.reconsiderations,
    arbitrationPasses: after.arbitrationPasses - before.arbitrationPasses,
    malformedArbiterAttempts: after.malformedArbiterAttempts - before.malformedArbiterAttempts,
    evidenceRoundsUsed: after.evidenceRoundsUsed - before.evidenceRoundsUsed,
  };
}

const COUNTER_KEYS = Object.keys(ZERO_LINEAGE_COUNTERS) as (keyof LineageCounters)[];

/**
 * §6.1: the per-lineage ceiling of each counter, as the session resolved it.
 *
 * The same products the #836 context validator uses. Checked HERE as well, and
 * before the write rather than after it, so an impossible delta is reported as
 * the delta it is (`too-many-items` on the named counter) instead of surfacing
 * as a generic invalid record once the block is rebuilt.
 */
function counterCeilings(limits: ReviewDisputeLimits): LineageCounters {
  return {
    rebuttals: limits.maxRebuttalsPerVersion * limits.maxVersionsPerLineage,
    reconsiderations: limits.maxReconsiderationsPerLineage,
    arbitrationPasses: limits.maxArbitrationPassesPerLineage,
    malformedArbiterAttempts: limits.maxMalformedArbiterAttemptsPerLineage,
    evidenceRoundsUsed: limits.maxEvidenceRoundsPerLineage,
  };
}

/** Never silently clamp an invalid delta; reject it (§6.1, acceptance criteria). */
function counterProblem(
  lineageId: string,
  before: LineageCounters,
  after: LineageCounters,
  limits: ReviewDisputeLimits,
): ReviewDisputeFailure | null {
  const ceilings = counterCeilings(limits);
  for (const key of COUNTER_KEYS) {
    const moved = after[key] - before[key];
    if (!Number.isInteger(moved) || moved < 0) {
      return { reason: "invalid-state-record", detail: `lineages[${lineageId}].counters.${key}:${moved}` };
    }
    if (after[key] > ceilings[key]) {
      return { reason: "too-many-items", detail: `lineages[${lineageId}].counters.${key}:${after[key]}` };
    }
  }
  return null;
}

/**
 * The §2.1 finding fields the §10.1 record mirrors, as one admitted version
 * carries them. Row 11 is the only transition that writes them: admitting the
 * §4.2 successor replaces the version, so the version's own severity and
 * boundary come with it (§11 publishes exactly this `affectedBoundary`, and the
 * final implementation response is prompted against it).
 */
type LineageVersionFields = Pick<PersistedLineage, "severity" | "affectedBoundary">;

interface TransitionWrite {
  state: LineageState;
  version: number;
  counters: LineageCounters;
  /** Present only when the row admits a new version of the finding. */
  fields?: LineageVersionFields;
  digest: string;
}

/**
 * Produce the next lineage record.
 *
 * §11: the outcome literal IS a terminal lineage's state, so it is stamped by
 * the transition that made it terminal and never written by hand. A lineage that
 * is not terminal never carries one.
 */
function writeLineage(lineage: PersistedLineage, write: TransitionWrite): PersistedLineage {
  const { outcome: _outcome, ...rest } = lineage;
  const terminal = isTerminalLineageState(write.state);
  return {
    ...rest,
    ...(write.fields ?? {}),
    state: write.state,
    version: write.version,
    counters: write.counters,
    appliedTransitions: [...(lineage.appliedTransitions ?? []), write.digest],
    ...(terminal ? { outcome: write.state as TerminalLineageState } : {}),
  };
}

function failure(reason: ReviewDisputeFailureReason, detail: string): ReviewDisputeFailure {
  return { reason, detail };
}

// ---------------------------------------------------------------------------
// §7.1 aggregation
// ---------------------------------------------------------------------------

function sortedIds(lineages: Readonly<Record<string, PersistedLineage>>): string[] {
  return Object.keys(lineages).sort();
}

/**
 * Derive the one §7.1 task-level intent from the updated lineage set.
 *
 * Rule order is the contract's, evaluated so exactly one outcome applies, and
 * every scan runs over sorted ids so the result is order-independent: the same
 * lineage set always aggregates to the same value whichever order the run
 * touched it in.
 */
export function aggregateDisputeRouting(
  context: ReviewDisputeContext,
  options: { runProducedFileChanges?: boolean } = {},
): DisputeTaskRouting {
  const ids = sortedIds(context.lineages);
  const lineage = (id: string): PersistedLineage => context.lineages[id]!;
  const pendingReReview = context.pendingReReview === true;
  const runProducedFileChanges = options.runProducedFileChanges === true;

  const base = {
    escalatedLineageIds: ids.filter((id) => lineage(id).state === "escalated_human"),
    reopenRequestedLineageIds: ids.filter(
      (id) => lineage(id).reopenRequested === true && isTerminalLineageState(lineage(id).state),
    ),
  };

  // §13: no structured lineage exists, so the protocol is inert and the legacy
  // free-form review path is unchanged — never a hard error.
  if (ids.length === 0) {
    return {
      rule: null,
      outcome: "legacy",
      turn: "none",
      nextPhase: null,
      readyForHuman: false,
      ...base,
      actionableLineageIds: [],
      pendingReReview,
      resolvedWithoutChanges: context.resolvedWithoutChanges === true,
    };
  }

  // Rule 1: any `escalated_human` lineage, or a terminal one carrying the §6.4
  // `reopen_requested` flag, escalates the whole task. The flag never changes
  // the lineage's own state; the escalation happens at run level.
  if (base.escalatedLineageIds.length > 0 || base.reopenRequestedLineageIds.length > 0) {
    return {
      rule: 1,
      outcome: "human_handoff",
      turn: "none",
      nextPhase: null,
      readyForHuman: true,
      ...base,
      actionableLineageIds: [...base.escalatedLineageIds, ...base.reopenRequestedLineageIds].sort(),
      pendingReReview,
      resolvedWithoutChanges: false,
    };
  }

  // Rule 2: any non-terminal lineage keeps the loop going. Which party acts next
  // is decided by the states present, checked in the contract's order.
  const awaiting = ids.filter((id) => lineage(id).state === "open" || lineage(id).state === "binding");
  const disputed = ids.filter((id) => lineage(id).state === "disputed");
  const evidence = ids.filter((id) => lineage(id).state === "evidence_requested");
  const arbitrating = ids.filter((id) => lineage(id).state === "arbitration_pending");
  if (awaiting.length + disputed.length + evidence.length + arbitrating.length > 0) {
    const turn: DisputeTaskTurn =
      awaiting.length > 0 ? "implementer" : disputed.length > 0 ? "reviewer" : evidence.length > 0 ? "evidence" : "runner";
    const actionable =
      turn === "implementer" ? awaiting : turn === "reviewer" ? disputed : turn === "evidence" ? evidence : arbitrating;
    return {
      rule: 2,
      outcome: "continue",
      turn,
      // The implementer turn is today's `needs_fix` routing; the reviewer turn is
      // the §7.1 reconsideration run, itself a review-phase run. The evidence and
      // runner turns dispatch either two per-party runs or no agent run at all,
      // so neither names a single phase.
      nextPhase: turn === "implementer" ? "implementation" : turn === "reviewer" ? "review" : null,
      readyForHuman: false,
      ...base,
      actionableLineageIds: actionable,
      // §7.1 rule 2: a diff-bearing run whose remaining lineages continue the
      // loop records that the diff is still unreviewed, so rule 3's deferred
      // re-review cannot be lost. Intermediate runs that produce no file changes
      // leave the flag exactly as it was.
      pendingReReview: pendingReReview || runProducedFileChanges,
      resolvedWithoutChanges: false,
    };
  }

  // Rule 3: every lineage is terminal and there are unreviewed file changes —
  // this run's diff, or one an earlier run of this cycle deferred. Routing to
  // review is what clears the flag.
  if (runProducedFileChanges || pendingReReview) {
    return {
      rule: 3,
      outcome: "re_review",
      turn: "re_review",
      nextPhase: "review",
      readyForHuman: false,
      ...base,
      actionableLineageIds: [],
      pendingReReview: false,
      resolvedWithoutChanges: false,
    };
  }

  // Rule 4: every lineage is terminal with no unreviewed diff. §13 decides which
  // half applies: only a fully structured review admits the zero-change run.
  const structured = reviewStructureAllowsZeroChange(context.reviewStructure);
  return {
    rule: 4,
    outcome: structured ? "resolved_without_changes" : "no_change_run_invalid",
    turn: "none",
    nextPhase: null,
    readyForHuman: false,
    ...base,
    actionableLineageIds: [],
    pendingReReview: false,
    resolvedWithoutChanges: structured,
  };
}

// ---------------------------------------------------------------------------
// Per-decision application
// ---------------------------------------------------------------------------

interface Draft {
  lineages: Record<string, PersistedLineage>;
  /**
   * §13: the shape of the review that admitted the current lineages. Only a new
   * admission can change it — every other decision reads the block a review
   * already classified.
   */
  reviewStructure: ReviewDisputeContext["reviewStructure"];
  applied: AppliedLineageTransition[];
  refused: RefusedLineageTransition[];
  operational: ArbitrationOperationalFailure | null;
  /** Only the `dispositions` kind can leave an unreviewed diff behind. */
  runProducedFileChanges: boolean;
}

interface RowApplication {
  row: DisputeTransitionRow | null;
  nextState: LineageState;
  versionAfter?: number;
  /** Row 11 only: the admitted successor's own §2.1 fields travel with it. */
  fields?: LineageVersionFields;
  counterDelta?: Partial<LineageCounters>;
  auditEvent: DisputeAuditEvent;
  reason: DisputeTransitionReason;
}

/**
 * Apply one row to one lineage, or refuse it.
 *
 * This is the only place a lineage record changes, so it is also the only place
 * the four preconditions are checked: the ledger (a replay applies nothing), the
 * version, the predecessor state, and the counter movement. A refusal pushes a
 * `RefusedLineageTransition` and leaves the record exactly as it was.
 */
function applyRow(
  draft: Draft,
  run: DisputeTransitionRunIdentity,
  limits: ReviewDisputeLimits,
  target: { lineageId: string; version: number; expectedStates: readonly LineageState[] },
  row: RowApplication,
): void {
  const current = ownLineage(draft.lineages, target.lineageId);
  if (current === undefined) {
    draft.refused.push({
      lineageId: target.lineageId,
      version: target.version,
      failure: failure("unknown-lineage", `lineages[${target.lineageId}]`),
    });
    return;
  }
  const digest = transitionDigest(target.lineageId, target.version, run.runId);
  if (alreadyApplied(current, digest)) {
    // A retried delivery of THIS run's own transition. Reported so routing is
    // identical on a retry, but nothing is written a second time.
    draft.applied.push({
      lineageId: current.lineageId,
      version: target.version,
      versionAfter: current.version,
      row: row.row,
      fromState: current.state,
      toState: current.state,
      counterDelta: { ...NO_COUNTER_DELTA },
      countersAfter: { ...current.counters },
      auditEvent: row.auditEvent,
      reason: row.reason,
      actor: run.actor,
      transitionKey: digest,
      replayed: true,
    });
    return;
  }
  if (current.version !== target.version) {
    draft.refused.push({
      lineageId: target.lineageId,
      version: target.version,
      failure: failure("stale-version", `lineages[${target.lineageId}].version:${current.version}`),
    });
    return;
  }
  if (!target.expectedStates.includes(current.state)) {
    draft.refused.push({
      lineageId: target.lineageId,
      version: target.version,
      failure: failure("not-actionable-state", `lineages[${target.lineageId}].state:${current.state}`),
    });
    return;
  }
  if ((current.appliedTransitions ?? []).length >= MAX_APPLIED_TRANSITIONS_PER_LINEAGE) {
    // The protocol bounds a lineage to far fewer transitions than this; reaching
    // the ledger's ceiling means the record no longer describes a debate the §7
    // table could have produced, and a bounded block must not grow past it.
    draft.refused.push({
      lineageId: target.lineageId,
      version: target.version,
      failure: failure("too-many-items", `lineages[${target.lineageId}].appliedTransitions`),
    });
    return;
  }

  const delta: LineageCounters = { ...NO_COUNTER_DELTA, ...row.counterDelta };
  const countersAfter = addCounters(current.counters, delta);
  const problem = counterProblem(target.lineageId, current.counters, countersAfter, limits);
  if (problem !== null) {
    draft.refused.push({ lineageId: target.lineageId, version: target.version, failure: problem });
    return;
  }

  const versionAfter = row.versionAfter ?? current.version;
  draft.lineages[target.lineageId] = writeLineage(current, {
    state: row.nextState,
    version: versionAfter,
    counters: countersAfter,
    ...(row.fields === undefined ? {} : { fields: row.fields }),
    digest,
  });
  draft.applied.push({
    lineageId: current.lineageId,
    version: target.version,
    versionAfter,
    row: row.row,
    fromState: current.state,
    toState: row.nextState,
    counterDelta: delta,
    countersAfter,
    auditEvent: row.auditEvent,
    reason: row.reason,
    actor: run.actor,
    transitionKey: digest,
    replayed: false,
  });
}

/**
 * #841's admission, applied.
 *
 * The builder already produced the next block; what this layer adds is the
 * verification that it was built over the CURRENT one — no lineage dropped, no
 * lineage on file rewritten — and the §10.3 `dispute.finding.opened` event per
 * newly opened lineage. A lineage's own existence is its admission record, so no
 * ledger entry is needed: a re-delivered admission rebuilds over a block that
 * already carries the lineage and opens nothing.
 */
function applyFindingAdmission(
  draft: Draft,
  current: ReviewDisputeContext,
  next: ReviewDisputeContext,
  run: DisputeTransitionRunIdentity,
): ReviewDisputeFailure | null {
  for (const lineageId of sortedIds(current.lineages)) {
    const before = current.lineages[lineageId]!;
    const after = ownLineage(next.lineages, lineageId);
    if (after === undefined) {
      return failure("invalid-state-record", `lineages[${lineageId}]:dropped`);
    }
    if (stableStringify(before) !== stableStringify(after)) {
      return failure("invalid-state-record", `lineages[${lineageId}]:rewritten`);
    }
  }
  // §13: a new review run reclassifies the block it admits into, and this is the
  // only decision that may. Carried from the builder's result rather than
  // recomputed, for the same reason the lineages are.
  draft.reviewStructure = next.reviewStructure;
  for (const lineageId of sortedIds(next.lineages)) {
    if (ownLineage(current.lineages, lineageId) !== undefined) continue;
    const opened = next.lineages[lineageId]!;
    // Admission opens a lineage at version 1 with zero counters (§2.2, §6.1);
    // anything else is a record no admission could have produced.
    if (opened.state !== "open" || opened.version !== 1) {
      return failure("invalid-state-record", `lineages[${lineageId}]:not-open-at-version-1`);
    }
    if (stableStringify(opened.counters) !== stableStringify(ZERO_LINEAGE_COUNTERS)) {
      return failure("invalid-state-record", `lineages[${lineageId}].counters:not-zero`);
    }
    draft.lineages[lineageId] = opened;
    draft.applied.push({
      lineageId,
      version: opened.version,
      versionAfter: opened.version,
      row: null,
      fromState: "open",
      toState: "open",
      counterDelta: { ...NO_COUNTER_DELTA },
      countersAfter: { ...opened.counters },
      auditEvent: "dispute.finding.opened",
      reason: "finding-opened",
      actor: run.actor,
      transitionKey: transitionDigest(lineageId, opened.version, run.runId),
      replayed: false,
    });
  }
  return null;
}

/**
 * §7 rows 2, 3, 6, 7, and 25: where an ADMITTED dispute leaves its lineage.
 *
 * #844 records the rebuttal, its `disputeRuns` idempotency key, and the
 * human-gate escalation of rows 3/7. The remaining partition is the transition
 * table's and therefore this module's: version 2's dispute skips reconsideration
 * entirely (row 6, §6.2's "no third round"), and a session that configured the
 * reconsideration round away arbitrates instead of entering `disputed` (row 25,
 * §6.1). Exactly one branch holds for any dispute, so the machine stays
 * deterministic.
 */
function disputeAdmissionRow(
  lineage: PersistedLineage,
  version: number,
  limits: ReviewDisputeLimits,
): RowApplication {
  if (lineage.humanGate) {
    return {
      row: version >= ABSOLUTE_MAX_VERSION ? 7 : 3,
      nextState: "escalated_human",
      auditEvent: "dispute.escalated.human",
      reason: "dispute-human-gated",
    };
  }
  if (version >= ABSOLUTE_MAX_VERSION) {
    return {
      row: 6,
      nextState: "arbitration_pending",
      auditEvent: "dispute.rebuttal.recorded",
      reason: "dispute-final-version",
    };
  }
  if (limits.maxReconsiderationsPerLineage < 1) {
    return {
      row: 25,
      nextState: "arbitration_pending",
      auditEvent: "dispute.rebuttal.recorded",
      reason: "dispute-reconsideration-unavailable",
    };
  }
  return { row: 2, nextState: "disputed", auditEvent: "dispute.rebuttal.recorded", reason: "dispute-admitted" };
}

/**
 * A fix run's dispositions, applied.
 *
 * #844's persistence supplies the dispute half — the consumed rebuttal slots,
 * their run identities, and the block that carries them. This function verifies
 * that block was computed against the CURRENT one, then applies the two halves
 * the transition table left open: the row-2/3/6/7/25 partition of each admitted
 * dispute, and the `fixed`/`blocked` rows (1/5/23 and 4/8/24) that #844
 * deliberately does not own.
 */
function applyDispositions(
  draft: Draft,
  current: ReviewDisputeContext,
  decision: Extract<DisputeTransitionDecision, { kind: "dispositions" }>,
  run: DisputeTransitionRunIdentity,
  limits: ReviewDisputeLimits,
): ReviewDisputeFailure | null {
  const persistence = decision.persistence;
  const persistedIds = new Set(persistence.persisted.map((entry) => entry.lineageId));
  // The `fixed`/`blocked` half of the run, indexed by lineage: #844 owns none of
  // it, so these are exactly the lineages its `persisted` list leaves out. §3.1
  // admits at most one disposition per finding, so the index loses nothing.
  const answered = new Map<string, AdmittedDisposition>();
  for (const admitted of decision.outcome.admitted) {
    if (admitted.record.disposition === "review_disputed") continue;
    if (!answered.has(admitted.record.lineageId)) answered.set(admitted.record.lineageId, admitted);
  }
  const currentIds = sortedIds(current.lineages);
  const nextIds = sortedIds(persistence.context.lineages);
  if (currentIds.join(",") !== nextIds.join(",")) {
    return failure("invalid-state-record", "persistence.context.lineages:set-mismatch");
  }
  if (persistence.context.reviewStructure !== current.reviewStructure) {
    return failure("invalid-state-record", "persistence.context.reviewStructure");
  }
  // Lineages whose difference from #844's copy is THIS run's own committed
  // transition. Their current record is authoritative and is kept below.
  const replayedAnswers: string[] = [];
  for (const lineageId of currentIds) {
    if (persistedIds.has(lineageId)) continue;
    const onFile = current.lineages[lineageId]!;
    if (stableStringify(onFile) === stableStringify(persistence.context.lineages[lineageId])) continue;
    // A lineage this run did not dispute must be byte-identical on both sides,
    // with one exception: #844 carries a `fixed`/`blocked` lineage through
    // untouched because rows 1/5/23 and 4/8/24 are this layer's, so a redelivery
    // of the SAME approved persistence necessarily meets the terminal record its
    // own first delivery wrote. The transition ledger is the authority on which
    // of the two it is — a digest already on file makes this the promised
    // idempotent no-op, not a competing writer. Anything else means the
    // persistence was computed against a different block than the one being
    // written, and guessing which half is authoritative is exactly what "never
    // overwrite newer review state" forbids.
    const answer = answered.get(lineageId);
    if (
      answer === undefined
      || !alreadyApplied(onFile, transitionDigest(lineageId, answer.record.version, run.runId))
    ) {
      return failure("invalid-state-record", `lineages[${lineageId}]:cas`);
    }
    replayedAnswers.push(lineageId);
  }

  // Start from #844's block: it already carries the recorded rebuttals.
  draft.lineages = copyLineages(persistence.context.lineages);
  // ...except where this run already moved the lineage past the copy #844 holds.
  for (const lineageId of replayedAnswers) draft.lineages[lineageId] = current.lineages[lineageId]!;
  // #844 answers a redelivery from its own `disputeRuns` key, which only
  // recognizes a lineage still sitting where its rebuttal left it. Once THIS
  // layer has moved that lineage on — row 6 and row 25 arbitrate rather than
  // enter `disputed` — the same redelivery reads to #844 as a dispute against a
  // state that no longer accepts one. The transition ledger is the authority on
  // that question: a refusal whose transition is already on file is this run's
  // own work coming back, so it is reported as the replay it is instead of as a
  // refusal that would append a second audit entry for an applied transition.
  for (const entry of persistence.refused) {
    const current = ownLineage(draft.lineages, entry.lineageId);
    const digest =
      current === undefined ? null : transitionDigest(entry.lineageId, entry.version, run.runId);
    if (current === undefined || digest === null || !alreadyApplied(current, digest)) {
      draft.refused.push({ lineageId: entry.lineageId, version: entry.version, failure: entry.failure });
      continue;
    }
    const row = disputeAdmissionRow(current, entry.version, limits);
    draft.applied.push({
      lineageId: entry.lineageId,
      version: entry.version,
      versionAfter: current.version,
      row: row.row,
      fromState: current.state,
      toState: current.state,
      counterDelta: { ...NO_COUNTER_DELTA },
      countersAfter: { ...current.counters },
      auditEvent: row.auditEvent,
      reason: row.reason,
      actor: run.actor,
      transitionKey: digest,
      replayed: true,
    });
  }

  // Rows 2/3/6/7/25, in sorted order so the aggregate is order-independent.
  for (const entry of [...persistence.persisted].sort((a, b) => a.lineageId.localeCompare(b.lineageId))) {
    const recorded = ownLineage(draft.lineages, entry.lineageId);
    const before = ownLineage(current.lineages, entry.lineageId);
    if (recorded === undefined || before === undefined) {
      return failure("unknown-lineage", `lineages[${entry.lineageId}]`);
    }
    const digest = transitionDigest(entry.lineageId, entry.version, run.runId);
    const row = disputeAdmissionRow(recorded, entry.version, limits);
    // #844 recognizes its own redelivery from `disputeRuns`, a key that PREDATES
    // this ledger. A dispute recorded before this layer existed therefore carries
    // a consumed rebuttal slot and an EMPTY `appliedTransitions`: #844 left it in
    // `disputed` (or, human-gated, `escalated_human`), and its row-2/3/6/7/25
    // transition was never applied. Reading `replayed` as "already answered"
    // would strand exactly those records — rows 6 and 25 must leave `disputed`
    // for `arbitration_pending`, and the spent slot means no later run can
    // dispute the version again to push them there. So the LEDGER, not #844's
    // flag, is what decides: an empty ledger means this layer still owes the
    // transition and applies it now, over the record #844 already wrote and with
    // the zero counter delta that leaves. Once the ledger has answered for the
    // lineage, a #844 replay is the replay it says it is.
    const ledgered = (before.appliedTransitions ?? []).length > 0;
    if (alreadyApplied(before, digest) || (entry.replayed && ledgered)) {
      // Nothing is applied a second time, so the record on file stays exactly as
      // it is — #844's copy predates this run's own transition whenever the
      // persistence was computed against the pre-transition block.
      draft.lineages[entry.lineageId] = before;
      draft.applied.push({
        lineageId: entry.lineageId,
        version: entry.version,
        versionAfter: before.version,
        row: row.row,
        fromState: before.state,
        toState: before.state,
        counterDelta: { ...NO_COUNTER_DELTA },
        countersAfter: { ...before.counters },
        auditEvent: row.auditEvent,
        reason: row.reason,
        actor: run.actor,
        transitionKey: digest,
        replayed: true,
      });
      continue;
    }
    // #844 rewrites nothing for an entry it reports as replayed, so its copy of
    // that record must be the one on file. When it is not, the persistence was
    // computed against a different block, and the pre-ledger advance below would
    // be writing over newer review state rather than completing an owed
    // transition (§12).
    if (entry.replayed && stableStringify(recorded) !== stableStringify(before)) {
      draft.refused.push({
        lineageId: entry.lineageId,
        version: entry.version,
        failure: failure("invalid-state-record", `lineages[${entry.lineageId}]:cas`),
      });
      draft.lineages[entry.lineageId] = before;
      continue;
    }
    // The rebuttal counter is #844's movement, already applied to the record
    // this transition writes over; the delta is reported so the audit event
    // still shows what the run spent — zero for the pre-ledger record above,
    // whose slot an earlier delivery already charged.
    const delta = subtractCounters(recorded.counters, before.counters);
    const problem = counterProblem(entry.lineageId, before.counters, recorded.counters, limits);
    if (problem !== null) {
      draft.refused.push({ lineageId: entry.lineageId, version: entry.version, failure: problem });
      draft.lineages[entry.lineageId] = before;
      continue;
    }
    if ((recorded.appliedTransitions ?? []).length >= MAX_APPLIED_TRANSITIONS_PER_LINEAGE) {
      draft.refused.push({
        lineageId: entry.lineageId,
        version: entry.version,
        failure: failure("too-many-items", `lineages[${entry.lineageId}].appliedTransitions`),
      });
      draft.lineages[entry.lineageId] = before;
      continue;
    }
    draft.lineages[entry.lineageId] = writeLineage(recorded, {
      state: row.nextState,
      version: recorded.version,
      counters: recorded.counters,
      digest,
    });
    draft.applied.push({
      lineageId: entry.lineageId,
      version: entry.version,
      versionAfter: recorded.version,
      row: row.row,
      fromState: before.state,
      toState: row.nextState,
      counterDelta: delta,
      countersAfter: { ...recorded.counters },
      auditEvent: row.auditEvent,
      reason: row.reason,
      actor: run.actor,
      transitionKey: digest,
      replayed: false,
    });
  }

  // Rows 1/5/23 and 4/8/24: the `fixed` and `blocked` dispositions, in sorted
  // order so the aggregate is order-independent.
  const answers = [...answered.values()].sort((a, b) => a.record.lineageId.localeCompare(b.record.lineageId));
  for (const admitted of answers) {
    const record = admitted.record;
    const before = ownLineage(draft.lineages, record.lineageId);
    if (before === undefined) {
      draft.refused.push({
        lineageId: record.lineageId,
        version: record.version,
        failure: failure("unknown-lineage", `lineages[${record.lineageId}]`),
      });
      continue;
    }
    // §3.4: a `fixed` disposition requires a diff. #843 rejects one in a
    // no-change run before any transition; re-asserted here because this is the
    // layer that would otherwise write `resolved_fixed` for it.
    if (record.disposition === "fixed" && !decision.runProducedFileChanges) {
      draft.refused.push({
        lineageId: record.lineageId,
        version: record.version,
        failure: failure("fixed-without-diff", `lineages[${record.lineageId}].disposition`),
      });
      continue;
    }
    // Compare-and-set: anything that moved since #843 admitted this record fails
    // closed, exactly as it does for a dispute.
    const digest = transitionDigest(record.lineageId, record.version, run.runId);
    if (!alreadyApplied(before, digest) && stableStringify(before) !== stableStringify(admitted.lineage)) {
      draft.refused.push({
        lineageId: record.lineageId,
        version: record.version,
        failure: failure("invalid-state-record", `lineages[${record.lineageId}]:cas`),
      });
      continue;
    }
    const binding = before.state === "binding";
    const finalVersion = record.version >= ABSOLUTE_MAX_VERSION;
    const row: RowApplication =
      record.disposition === "fixed"
        ? {
            row: binding ? 23 : finalVersion ? 5 : 1,
            nextState: "resolved_fixed",
            auditEvent: "dispute.resolved",
            reason: "fixed",
          }
        : {
            row: binding ? 24 : finalVersion ? 8 : 4,
            nextState: "escalated_human",
            auditEvent: "dispute.escalated.human",
            reason: "blocked",
          };
    applyRow(draft, run, limits, { lineageId: record.lineageId, version: record.version, expectedStates: ["open", "binding"] }, row);
  }

  draft.runProducedFileChanges = decision.runProducedFileChanges;
  return null;
}

/**
 * §7 rows 9, 10, 11, 12, and 26: the reviewer's reconsideration, applied.
 *
 * `withdraw` and `uphold` are this module's rows; a `revise` is #845's decision,
 * consumed as returned — its row, next state, and successor version are used
 * verbatim, and the §5 materiality comparison is never redone here. All three
 * spend the lineage's single §6.1 reconsideration round, which is the counter
 * #845 reads and deliberately does not advance.
 */
function applyReconsideration(
  draft: Draft,
  decision: Extract<DisputeTransitionDecision, { kind: "reconsideration" }>,
  run: DisputeTransitionRunIdentity,
  limits: ReviewDisputeLimits,
): ReviewDisputeFailure | null {
  const record = decision.admitted.record;
  const current = ownLineage(draft.lineages, record.lineageId);
  if (current === undefined) {
    draft.refused.push({
      lineageId: record.lineageId,
      version: record.version,
      failure: failure("unknown-lineage", `lineages[${record.lineageId}]`),
    });
    return null;
  }
  const digest = transitionDigest(record.lineageId, record.version, run.runId);
  // Compare-and-set against the block the record was admitted against, before
  // anything reads a counter off it. Skipped for a replay, whose own ledger
  // entry is exactly the difference between the two snapshots.
  if (!alreadyApplied(current, digest) && stableStringify(current) !== stableStringify(decision.admitted.lineage)) {
    draft.refused.push({
      lineageId: record.lineageId,
      version: record.version,
      failure: failure("invalid-state-record", `lineages[${record.lineageId}]:cas`),
    });
    return null;
  }

  const target = { lineageId: record.lineageId, version: record.version, expectedStates: ["disputed"] as const };
  const spendRound: Partial<LineageCounters> = { reconsiderations: 1 };

  if (record.reconsideration === "withdraw") {
    applyRow(draft, run, limits, target, {
      row: 9,
      nextState: "resolved_withdrawn",
      counterDelta: spendRound,
      auditEvent: "dispute.resolved",
      reason: "withdraw",
    });
    return null;
  }
  if (record.reconsideration === "uphold") {
    applyRow(draft, run, limits, target, {
      row: 10,
      nextState: "arbitration_pending",
      counterDelta: spendRound,
      auditEvent: "dispute.reconsideration.recorded",
      reason: "uphold",
    });
    return null;
  }

  // `revise`: #845 owns the classification, and this layer applies exactly one
  // of its three rows. A decision that is missing, addressed to another lineage,
  // or made against another version is refused rather than reinterpreted.
  const revision = decision.revision;
  if (revision === undefined) {
    return failure("invalid-revision", "decision.revision:missing");
  }
  if (revision.lineageId !== record.lineageId) {
    return failure("unknown-lineage", `decision.revision.lineageId:${revision.lineageId}`);
  }
  if (revision.disputedVersion !== record.version) {
    return failure("stale-version", `decision.revision.disputedVersion:${revision.disputedVersion}`);
  }
  // A decision that classified nothing cannot have come from THIS record, which
  // is a `revise` by the branch above: the pair disagrees about what the reviewer
  // returned, and nothing may be applied on a disagreement.
  if (revision.intent === "no_revision") {
    return failure("invalid-revision", "decision.revision.intent:no_revision");
  }
  if (revision.intent === "rejected" || revision.nextState === null || revision.row === null) {
    // §12: no protocol state changes and no counter is consumed.
    draft.refused.push({
      lineageId: record.lineageId,
      version: record.version,
      failure: revision.failure ?? failure("invalid-revision", `decision.revision.intent:${revision.intent}`),
    });
    return null;
  }
  const auditEvent = revision.auditEvents[0];
  if (auditEvent === undefined) {
    return failure("invalid-revision", "decision.revision.auditEvents:empty");
  }
  // Row 11 admits the §4.2 candidate AS the lineage's next version, so the
  // successor's own §2.1 fields are written with it: version 2 must report the
  // severity and publish the `affectedBoundary` the reviewer revised TO, or the
  // final implementation response is prompted against version 1's surface. #845
  // decides which rows admit — `candidateAdmitted` is row 11's alone, and rows
  // 12 and 26 leave the candidate unpersisted with the recorded version intact.
  const successor = revision.candidateAdmitted ? revision.candidate : null;
  applyRow(draft, run, limits, target, {
    row: revision.row,
    nextState: revision.nextState,
    versionAfter: revision.versionAfter,
    ...(successor === null
      ? {}
      : { fields: { severity: successor.severity, affectedBoundary: successor.affectedBoundary } }),
    counterDelta: spendRound,
    auditEvent,
    reason:
      revision.row === 11
        ? "revision-material"
        : revision.row === 26
          ? "revision-successor-unavailable"
          : "revision-not-material",
  });
  return null;
}

/**
 * §7 rows 13–21: #847's arbitration route, applied.
 *
 * The row, the next state, the counter delta, and the audit event are all
 * #847's; none is recomputed. What this layer verifies is that the decision was
 * made against the block being written: the same state, the same version, and a
 * `countersAfter` that is exactly this baseline plus the proposed delta. A
 * decision made against an older snapshot is refused, so a re-delivered result
 * can never spend a second arbitration pass.
 *
 * An operational failure (§8.3, #846's non-content kinds) instantiates no row:
 * nothing changes, no counter moves, and it is reported for the retry/handoff
 * policy rather than applied.
 */
function applyArbitration(
  draft: Draft,
  decision: ArbitrationRouteDecision,
  run: DisputeTransitionRunIdentity,
  limits: ReviewDisputeLimits,
): ReviewDisputeFailure | null {
  if (decision.intent === "operational_failure" || decision.row === null || decision.nextState === null) {
    draft.operational = decision.operational;
    return null;
  }
  const current = ownLineage(draft.lineages, decision.lineageId);
  if (current === undefined) {
    draft.refused.push({
      lineageId: decision.lineageId,
      version: decision.version,
      failure: failure("unknown-lineage", `lineages[${decision.lineageId}]`),
    });
    return null;
  }
  const digest = transitionDigest(decision.lineageId, decision.version, run.runId);
  if (!alreadyApplied(current, digest)) {
    if (current.state !== decision.currentState) {
      draft.refused.push({
        lineageId: decision.lineageId,
        version: decision.version,
        failure: failure("not-actionable-state", `lineages[${decision.lineageId}].state:${current.state}`),
      });
      return null;
    }
    // The counter baseline the decision read must still be the one on file:
    // `countersAfter` is `counters + delta` by #847's construction, so comparing
    // it against this baseline's projection is what catches a decision made
    // against a stale snapshot without re-deciding anything.
    const projected = addCounters(current.counters, {
      ...NO_COUNTER_DELTA,
      arbitrationPasses: decision.counterDelta.arbitrationPasses,
      malformedArbiterAttempts: decision.counterDelta.malformedArbiterAttempts,
    });
    if (stableStringify(projected) !== stableStringify(decision.countersAfter)) {
      draft.refused.push({
        lineageId: decision.lineageId,
        version: decision.version,
        failure: failure("invalid-state-record", `lineages[${decision.lineageId}].counters:baseline`),
      });
      return null;
    }
  }
  const auditEvent = decision.auditEvents[0];
  if (auditEvent === undefined) {
    return failure("invalid-state-record", "decision.auditEvents:empty");
  }
  applyRow(
    draft,
    run,
    limits,
    { lineageId: decision.lineageId, version: decision.version, expectedStates: ["arbitration_pending"] },
    {
      row: decision.row,
      nextState: decision.nextState,
      counterDelta: {
        arbitrationPasses: decision.counterDelta.arbitrationPasses,
        malformedArbiterAttempts: decision.counterDelta.malformedArbiterAttempts,
      },
      auditEvent,
      // #847's own bounded token, carried through rather than re-derived.
      reason: decision.reason,
    },
  );
  return null;
}

/**
 * §7 row 22: the bounded evidence round's attachments are recorded.
 *
 * The round is marked used HERE and nowhere else (#847's row 16 requests it and
 * deliberately moves no counter), which is what makes a requested-but-never-
 * answered round distinguishable from a completed one. An arbitration pass must
 * still remain to receive the re-presented case; row 16's own §6.1 gate
 * guarantees it, and re-asserting it is what keeps a lineage from landing in
 * `arbitration_pending` with no next action.
 */
function applyEvidenceRound(
  draft: Draft,
  decision: Extract<DisputeTransitionDecision, { kind: "evidence_round" }>,
  run: DisputeTransitionRunIdentity,
  limits: ReviewDisputeLimits,
): void {
  const current = ownLineage(draft.lineages, decision.lineageId);
  if (current !== undefined && !alreadyApplied(current, transitionDigest(decision.lineageId, decision.version, run.runId))) {
    if (current.counters.arbitrationPasses >= limits.maxArbitrationPassesPerLineage) {
      draft.refused.push({
        lineageId: decision.lineageId,
        version: decision.version,
        failure: failure(
          "arbitration-passes-exhausted",
          `lineages[${decision.lineageId}].counters.arbitrationPasses:${current.counters.arbitrationPasses}`,
        ),
      });
      return;
    }
  }
  applyRow(
    draft,
    run,
    limits,
    { lineageId: decision.lineageId, version: decision.version, expectedStates: ["evidence_requested"] },
    {
      row: 22,
      nextState: "arbitration_pending",
      counterDelta: { evidenceRoundsUsed: 1 },
      // §10.3's vocabulary carries no evidence-COMPLETED token; the round's one
      // subject event covers both ends of it, and `row: 22` plus the incremented
      // `evidenceRoundsUsed` distinguish the close from row 16's request.
      auditEvent: "dispute.evidence.requested",
      reason: "evidence-recorded",
    },
  );
}

/**
 * §6.4: record `reopen_requested` on a terminal lineage.
 *
 * Not a §7 row and not a state change — the terminal lineage keeps its state,
 * which is what terminal immutability means. The escalation happens at run level
 * instead, where §7.1 rule 1 treats the flag exactly like `escalated_human`.
 */
function applyReopenRequest(
  draft: Draft,
  decision: Extract<DisputeTransitionDecision, { kind: "reopen_request" }>,
  run: DisputeTransitionRunIdentity,
): void {
  const current = ownLineage(draft.lineages, decision.lineageId);
  if (current === undefined) {
    draft.refused.push({
      lineageId: decision.lineageId,
      version: 0,
      failure: failure("unknown-lineage", `lineages[${decision.lineageId}]`),
    });
    return;
  }
  if (!isTerminalLineageState(current.state)) {
    draft.refused.push({
      lineageId: decision.lineageId,
      version: current.version,
      failure: failure("not-actionable-state", `lineages[${decision.lineageId}].state:${current.state}`),
    });
    return;
  }
  const digest = transitionDigest(decision.lineageId, current.version, run.runId);
  const replayed = current.reopenRequested === true || alreadyApplied(current, digest);
  if (!replayed) {
    draft.lineages[decision.lineageId] = { ...current, reopenRequested: true };
  }
  draft.applied.push({
    lineageId: decision.lineageId,
    version: current.version,
    versionAfter: current.version,
    row: null,
    fromState: current.state,
    toState: current.state,
    counterDelta: { ...NO_COUNTER_DELTA },
    countersAfter: { ...current.counters },
    auditEvent: "dispute.reopen.requested",
    reason: "reopen-requested",
    actor: run.actor,
    transitionKey: digest,
    replayed,
  });
}

// ---------------------------------------------------------------------------
// The applicator
// ---------------------------------------------------------------------------

/**
 * Apply one approved decision to the task's §10.1 block.
 *
 * Never throws, and never partially applies: a per-lineage refusal leaves that
 * lineage exactly where it was, and a whole-operation failure returns the block
 * untouched so the caller keeps what is stored (§12 fail closed).
 *
 * The returned value is everything the durable layer needs and nothing more: the
 * next block plus its serialized form, the per-lineage transitions with their
 * bounded audit data, and the §7.1 routing intent. Writing it — atomically, with
 * exactly one task event — is `commitDisputeTransition`'s job.
 */
export function applyDisputeTransition(input: DisputeTransitionInput): DisputeTransitionResult {
  const limits = input.limits ?? REVIEW_DISPUTE_DEFAULT_LIMITS;
  const run = input.run;
  if (run.runId.trim() === "") {
    return { ok: false, failure: failure("invalid-type", "run.runId:empty") };
  }
  // The baseline must be a block this session could have produced; a caller that
  // hands over an unvalidated one would have every gate below read counters the
  // §6.1 limits never allowed.
  const baseline = validateReviewDisputeContext(input.context, "reviewDispute", limits);
  if (!baseline.ok) return baseline;
  const before = stableStringify(baseline.value);

  const draft: Draft = {
    lineages: copyLineages(baseline.value.lineages),
    reviewStructure: baseline.value.reviewStructure,
    applied: [],
    refused: [],
    operational: null,
    runProducedFileChanges: false,
  };

  let fatal: ReviewDisputeFailure | null = null;
  switch (input.decision.kind) {
    case "finding_admission":
      fatal = applyFindingAdmission(draft, baseline.value, input.decision.next, run);
      break;
    case "dispositions":
      fatal = applyDispositions(draft, baseline.value, input.decision, run, limits);
      break;
    case "reconsideration":
      fatal = applyReconsideration(draft, input.decision, run, limits);
      break;
    case "arbitration":
      fatal = applyArbitration(draft, input.decision.decision, run, limits);
      break;
    case "evidence_round":
      applyEvidenceRound(draft, input.decision, run, limits);
      break;
    case "reopen_request":
      applyReopenRequest(draft, input.decision, run);
      break;
  }
  if (fatal !== null) return { ok: false, failure: fatal };

  if (Object.keys(draft.lineages).length > MAX_LINEAGES_PER_TASK) {
    return { ok: false, failure: failure("too-many-items", `lineages:${Object.keys(draft.lineages).length}`) };
  }

  // §7.1 is derived from the UPDATED set, and the two block-level flags it owns
  // are written from that derivation rather than carried forward by hand: rule 2
  // records a deferred re-review, rule 3 clears it because routing to review is
  // what answers it, and rule 4 records the zero-change outcome only for a fully
  // structured review (§13).
  const draftContext: ReviewDisputeContext = {
    version: 1,
    reviewStructure: draft.reviewStructure,
    lineages: draft.lineages,
    ...(baseline.value.pendingReReview === undefined ? {} : { pendingReReview: baseline.value.pendingReReview }),
    ...(baseline.value.resolvedWithoutChanges === undefined
      ? {}
      : { resolvedWithoutChanges: baseline.value.resolvedWithoutChanges }),
  };
  const routing = aggregateDisputeRouting(draftContext, {
    runProducedFileChanges: draft.runProducedFileChanges,
  });

  const next: ReviewDisputeContext = {
    version: 1,
    reviewStructure: draft.reviewStructure,
    lineages: draft.lineages,
    ...(routing.pendingReReview ? { pendingReReview: true } : {}),
    ...(routing.resolvedWithoutChanges ? { resolvedWithoutChanges: true } : {}),
  };
  const validated = validateReviewDisputeContext(next, "reviewDispute", limits);
  if (!validated.ok) return validated;
  const serialized = serializeReviewDisputeContext(validated.value);
  if (!serialized.ok) return serialized;

  const unchanged = stableStringify(validated.value) === before;
  // A replay is a delivery this task has already answered in full: nothing to
  // write, nothing refused, and no operational fact worth an audit entry. A
  // re-delivered finding admission lands here with an EMPTY applied list — the
  // lineage's own presence is its admission record — which is why the empty case
  // counts as a replay rather than as an application of nothing.
  const replayed =
    unchanged
    && draft.refused.length === 0
    && draft.operational === null
    && draft.applied.every((entry) => entry.replayed);
  const event: DisputeTransitionEventData = {
    decision: input.decision.kind,
    runId: run.runId,
    actor: run.actor,
    applied: draft.applied,
    refused: draft.refused,
    auditEvents: draft.applied.map((entry) => entry.auditEvent),
    routing,
    operational: draft.operational,
  };

  return {
    ok: true,
    value: {
      context: validated.value,
      serialized: serialized.value,
      unchanged,
      replayed,
      applied: draft.applied,
      refused: draft.refused,
      routing,
      event,
      operational: draft.operational,
    },
  };
}
