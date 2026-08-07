/**
 * Issue #844: persist the disputes an implementation run produced, idempotently.
 *
 * This module is the write half of the #843 read half. #843 parses the fix run's
 * response and decides, per record, what may be admitted; this module takes that
 * already-validated outcome and answers one question — what does the task's
 * §10.1 block look like after it? Nothing here re-reads agent prose, re-admits a
 * rejected record, or infers a dispute from a run that produced no diff: only
 * `FixDispositionOutcome.admitted` is ever consulted, and only its
 * `review_disputed` members, because those are the sole records that move a
 * lineage in this Issue's scope.
 *
 * It is pure and side-effect-free. The next context block, the §10.2 artifact
 * bytes, and the typed routing state all come back as values; writing them to
 * SQLite and to disk is the handler's job. That is what makes the operation
 * testable as compare-and-set: a caller can hand the same outcome to the same
 * function twice and observe that the second call stores nothing new.
 *
 * The three guarantees it exists for:
 *
 *  - **Idempotent for one run identity.** A retried worker delivery of the same
 *    run's disposition set recognizes its own `disputeRuns` entry and records a
 *    replay, not a second rebuttal. The artifact bytes it re-emits are identical
 *    (deterministic serialization), so a crash between the context write and the
 *    artifact write heals on retry instead of leaving a lineage without records.
 *  - **Compare-and-set against the CURRENT block, never the snapshot the parse
 *    used.** A version the reviewer has since revised, a state that no longer
 *    accepts a dispute, a rebuttal slot another run consumed, or a lineage record
 *    that moved in any other way is refused (§12) and leaves the lineage exactly
 *    where it is. Newer review state is never overwritten by an older run.
 *  - **Bounded task context.** What travels in context is literals and counters:
 *    the lineage's state, its counters, the consumed slots and the run ids behind
 *    them, plus a per-run summary bounded by `MAX_DISPOSITIONS_PER_RUN`. Every
 *    argument, rationale, and evidence reference lives in the local artifact.
 *
 * It selects NO transition beyond recording the dispute itself: §7 rows 1/5/23
 * (`fixed`), rows 4/8/24 (`blocked`), the reviewer's reconsideration, and the
 * run-level routing decision are #840's. What this module returns instead is the
 * typed pending-reconsideration state #840 routes on.
 */
import {
  awaitsImplementer,
  dispositionAllowedForState,
  isProgressLineageState,
  MAX_AGENT_ID_CHARS,
  MAX_RUN_ID_CHARS,
  REVIEW_DISPUTE_DEFAULT_LIMITS,
  type ImplementationDisposition,
  type LineageDisputeRun,
  type PersistedLineage,
  type ReviewDisputeContext,
  type ReviewDisputeLimits,
} from "./review-dispute.js";
import {
  disputeArtifactName,
  serializeRecord,
  serializeReviewDisputeContext,
  stableStringify,
} from "./review-dispute-lineage.js";
import { validateReviewDisputeContext } from "./review-dispute-validation.js";
import type {
  AdmittedDisposition,
  ReviewDisputeFailure,
  ReviewDisputeFailureReason,
  ReviewDisputeResult,
} from "./review-dispute-validation.js";
import type { FixDispositionOutcome } from "./review-fix-disposition-response.js";

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/**
 * The implementation run that produced the dispositions.
 *
 * `runId` is the idempotency key — the same value the phase runner leases the
 * task with, so a retried delivery of one run carries it unchanged while a fresh
 * claim after a lost lease carries a different one. `agentId` and `timestamp`
 * are audit provenance for the §10.2 artifact and never reach a public comment.
 */
export interface DisputeRunIdentity {
  runId: string;
  agentId: string;
  /** ISO-8601 date-time with an explicit offset, e.g. `new Date().toISOString()`. */
  timestamp: string;
}

export interface PersistFixDisputesInput {
  /**
   * The task's CURRENT validated §10.1 block — the compare-and-set baseline.
   * Not the snapshot `outcome` was parsed against: between the two a reviewer
   * may have revised a finding or another worker may have recorded a dispute,
   * and it is exactly that difference this function must refuse to overwrite.
   */
  context: ReviewDisputeContext;
  /** #843's validated outcome. Only `admitted` disputes are ever persisted. */
  outcome: FixDispositionOutcome;
  run: DisputeRunIdentity;
  /**
   * §7.1 rule 2: did this run leave an unreviewed diff on the branch? True for
   * the mixed case — one finding fixed with a diff while another is disputed —
   * where the diff's ordinary re-review is deferred, never skipped.
   */
  runProducedFileChanges: boolean;
  /** The session's resolved §6.1 limits. */
  limits?: ReviewDisputeLimits;
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

/** The lineage state a recorded dispute leaves behind (§7 rows 2/3/6/7). */
export type DisputedLineageState = "disputed" | "escalated_human";

export interface PersistedDisputeEntry {
  lineageId: string;
  version: number;
  /** Where the lineage stands once this dispute is on file. */
  state: DisputedLineageState;
  /**
   * True when this exact run had already recorded it: the entry is reported so
   * routing is identical on a retry, but nothing was written a second time.
   */
  replayed: boolean;
}

/** One admitted dispute the current block refused (§12). */
export interface RefusedDispute {
  lineageId: string;
  version: number;
  failure: ReviewDisputeFailure;
}

/**
 * §7.1 rule 2's reviewer turn, as a value.
 *
 * Which run the runner dispatches next, and whether the review-loop cap still
 * allows one, is #840's decision; this is the state that decision reads.
 */
export interface PendingReconsiderationState {
  kind: "pending_reconsideration";
  /** Lineages now `disputed`, awaiting the reviewer's §4 reconsideration. */
  lineages: { lineageId: string; version: number }[];
  /** Lineages a `humanGate` dispute escalated at admission (rows 3/7). */
  escalatedLineageIds: string[];
  /** §7.1 rule 2: an unreviewed diff of this cycle is on the branch. */
  pendingReReview: boolean;
}

export type DisputeRoutingState = { kind: "none" } | PendingReconsiderationState;

/** Literals and counters only — safe to persist in task context (§10.1). */
export interface DisputePersistenceSummary {
  runId: string;
  agentId: string;
  /** Disputes newly written by this call. */
  persisted: number;
  /** Disputes this run had already written and did not write again. */
  replayed: number;
  refused: number;
  disputedLineageIds: string[];
  escalatedLineageIds: string[];
  refusals: { lineageId: string; version: number; reason: ReviewDisputeFailureReason; detail: string | null }[];
  pendingReReview: boolean;
  routing: DisputeRoutingState["kind"];
}

/** A §10.2 local artifact: a file name and the exact bytes to write. */
export interface DisputeArtifact {
  /** Base name only — the artifact directory is the caller's, and stays local. */
  name: string;
  content: string;
}

export interface FixDisputePersistence {
  /** The next §10.1 block, ready to write to `task.context.reviewDispute`. */
  context: ReviewDisputeContext;
  /** Its serialized form, already bounded by `REVIEW_DISPUTE_CONTEXT_MAX_BYTES`. */
  serialized: string;
  /** True when the block is byte-identical to the one that came in. */
  unchanged: boolean;
  persisted: PersistedDisputeEntry[];
  refused: RefusedDispute[];
  artifacts: DisputeArtifact[];
  routing: DisputeRoutingState;
  summary: DisputePersistenceSummary;
}

export type PersistFixDisputesResult =
  | { ok: true; value: FixDisputePersistence }
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

/**
 * §7 rows 2/3/6/7: where an admitted dispute leaves its lineage.
 *
 * A `humanGate` version escalates AT dispute admission and never enters
 * `disputed` — the human the gate exists to involve must not be routed around by
 * an automated reviewer turn. Every other dispute becomes `disputed` and waits
 * for the reviewer.
 */
function disputedState(lineage: PersistedLineage): DisputedLineageState {
  return lineage.humanGate ? "escalated_human" : "disputed";
}

/** §6.1: is this version's rebuttal budget already spent? */
function rebuttalSlotConsumed(lineage: PersistedLineage, version: number, limits: ReviewDisputeLimits): boolean {
  return lineage.rebuttedVersions.filter((v) => v === version).length >= limits.maxRebuttalsPerVersion;
}

/** #844: did THIS run already consume the version's slot on this lineage? */
function recordedByRun(lineage: PersistedLineage, version: number, runId: string): boolean {
  return (lineage.disputeRuns ?? []).some((entry) => entry.version === version && entry.runId === runId);
}

function byVersion(a: LineageDisputeRun, b: LineageDisputeRun): number {
  return a.version - b.version;
}

/**
 * The §10.2 dispute record: the complete admitted record plus the run that
 * produced it.
 *
 * Local-only by construction — the caller supplies the directory, so no
 * filesystem path is inside the bytes, and everything that IS inside is either a
 * runner-owned literal or a §3.3 evidence reference already normalized to a
 * repository-relative location at admission. Serialized deterministically, so a
 * replayed run rewrites byte-identical content.
 */
function disputeArtifactContent(
  admitted: AdmittedDisposition,
  lineage: PersistedLineage,
  state: DisputedLineageState,
  run: DisputeRunIdentity,
): ReviewDisputeResult<string> {
  return serializeRecord({
    lineageId: lineage.lineageId,
    version: admitted.record.version,
    severity: lineage.severity,
    affectedBoundary: lineage.affectedBoundary,
    humanGate: lineage.humanGate,
    state,
    disposition: "review_disputed" satisfies ImplementationDisposition,
    run: { runId: run.runId, agentId: run.agentId, timestamp: run.timestamp },
    record: admitted.record,
  });
}

/** The refusal reason for a state that will not take a dispute (§3.1, §12). */
function stateRefusal(lineage: PersistedLineage): ReviewDisputeFailure {
  return lineage.state === "binding"
    ? { reason: "dispute-on-binding", detail: `lineages[${lineage.lineageId}].state` }
    : { reason: "not-actionable-state", detail: `lineages[${lineage.lineageId}].state:${lineage.state}` };
}

// ---------------------------------------------------------------------------
// The write
// ---------------------------------------------------------------------------

/**
 * Record this run's admitted disputes on the task's §10.1 block.
 *
 * Never throws, and never partially applies: every refusal leaves its lineage
 * untouched, and a block that cannot be validated or serialized after the
 * changes is returned as a whole-operation failure so the caller keeps the
 * stored block exactly as it was (§12 fail closed).
 *
 * Check order per record is the diagnostic order, and it is deliberate:
 *
 *  1. the lineage must still exist — a block that no longer carries it is not
 *     one this dispute can address;
 *  2. THIS run's own entry is looked for BEFORE the eligibility gates, because a
 *     retry of a delivered run legitimately finds the slot it consumed itself
 *     and must read as a replay rather than as a second rebuttal;
 *  3. the version must still be current (§2.3 makes older ones immutable), its
 *     §6.1 rebuttal slot must still be free, and the state must still accept a
 *     dispute (§3.1) — these three are the compare-and-set, evaluated against
 *     the CURRENT record;
 *  4. any other difference between the current record and the snapshot #843
 *     admitted against fails closed too: the block moved for a reason this
 *     function cannot see, and guessing which half is authoritative is exactly
 *     what "never overwrite newer review state" forbids;
 *  5. the artifact is serialized before the lineage is moved, so a record too
 *     large to write never leaves a persisted dispute without its evidence.
 */
export function persistFixDisputes(input: PersistFixDisputesInput): PersistFixDisputesResult {
  const limits = input.limits ?? REVIEW_DISPUTE_DEFAULT_LIMITS;
  const run = input.run;
  // The run identity travels in task context — the id as an idempotency key, the
  // agent id in the summary — so both are bounded by the same #836 constants
  // that bound every other persisted literal. A runner-supplied value past them
  // is a caller bug, and a caller bug must not be the thing that grows the
  // context column.
  if (run.runId.trim() === "" || run.runId.length > MAX_RUN_ID_CHARS) {
    return { ok: false, failure: { reason: "invalid-type", detail: `run.runId:${run.runId.length}` } };
  }
  if (run.agentId.trim() === "" || run.agentId.length > MAX_AGENT_ID_CHARS) {
    return { ok: false, failure: { reason: "invalid-type", detail: `run.agentId:${run.agentId.length}` } };
  }

  const before = stableStringify(input.context);
  // Null-prototype, mirroring the #836 context validator and #841's builder: a
  // lineage id is always runner-minted, but on a plain object a prototype key
  // would set the prototype instead of adding an entry.
  const lineages = Object.create(null) as Record<string, PersistedLineage>;
  for (const [lineageId, lineage] of Object.entries(input.context.lineages)) {
    lineages[lineageId] = lineage;
  }

  const persisted: PersistedDisputeEntry[] = [];
  const refused: RefusedDispute[] = [];
  const artifacts: DisputeArtifact[] = [];

  for (const admitted of input.outcome.admitted) {
    const record = admitted.record;
    // #840 owns the `fixed` and `blocked` rows; this Issue persists disputes.
    if (record.disposition !== "review_disputed") continue;

    const refuse = (failure: ReviewDisputeFailure): void => {
      refused.push({ lineageId: record.lineageId, version: record.version, failure });
    };
    const current = ownLineage(lineages, record.lineageId);
    if (current === undefined) {
      refuse({ reason: "unknown-lineage", detail: `lineages[${record.lineageId}]` });
      continue;
    }

    // (2) Replay: this run's own entry is already on file.
    if (recordedByRun(current, record.version, run.runId)) {
      if (current.version !== record.version) {
        // The lineage moved past the version this run rebutted; its dispute is
        // history, not a pending one, and re-reporting it as pending would route
        // a reviewer turn for a version the reviewer already answered.
        refuse({ reason: "stale-version", detail: `lineages[${record.lineageId}].version:${record.version}` });
        continue;
      }
      if (current.state !== "disputed" && current.state !== "escalated_human") {
        // The dispute is on file but the lineage has already moved past it — a
        // reviewer withdrew or upheld it while this delivery was in flight. The
        // debate is answered, so the retry neither rewrites it nor re-reports it
        // as pending; that would route a second reviewer turn for a settled one.
        refuse(stateRefusal(current));
        continue;
      }
      const artifact = disputeArtifactContent(admitted, current, current.state, run);
      if (!artifact.ok) {
        refuse(artifact.failure);
        continue;
      }
      artifacts.push({ name: disputeArtifactName(current.lineageId), content: artifact.value });
      persisted.push({
        lineageId: current.lineageId,
        version: record.version,
        state: current.state,
        replayed: true,
      });
      continue;
    }

    // (3) Compare-and-set against the current record. The slot is checked before
    // the state because when both fail the slot is the CAUSE: a lineage that is
    // `disputed` rather than `open` is exactly what a consumed slot leaves
    // behind, and "another run already rebutted this version" is what the
    // operator needs to read.
    if (current.version !== record.version) {
      refuse({ reason: "stale-version", detail: `lineages[${record.lineageId}].version:${record.version}` });
      continue;
    }
    if (rebuttalSlotConsumed(current, record.version, limits)) {
      refuse({ reason: "rebuttal-slot-consumed", detail: `lineages[${record.lineageId}].version:${record.version}` });
      continue;
    }
    if (!dispositionAllowedForState(current.state, "review_disputed")) {
      refuse(stateRefusal(current));
      continue;
    }
    // (4) Anything else that moved since #843 admitted this record.
    if (stableStringify(current) !== stableStringify(admitted.lineage)) {
      refuse({ reason: "invalid-state-record", detail: `lineages[${record.lineageId}]:cas` });
      continue;
    }

    // (5) Records before state.
    const state = disputedState(current);
    const artifact = disputeArtifactContent(admitted, current, state, run);
    if (!artifact.ok) {
      refuse(artifact.failure);
      continue;
    }

    lineages[current.lineageId] = {
      ...current,
      state,
      counters: { ...current.counters, rebuttals: current.counters.rebuttals + 1 },
      rebuttedVersions: [...current.rebuttedVersions, record.version].sort((a, b) => a - b),
      disputeRuns: [...(current.disputeRuns ?? []), { version: record.version, runId: run.runId }].sort(byVersion),
      // §11: the outcome literal IS a terminal lineage's state, and rows 3/7 make
      // a human-gated dispute terminal the moment it is admitted.
      ...(state === "escalated_human" ? { outcome: "escalated_human" as const } : {}),
    };
    artifacts.push({ name: disputeArtifactName(current.lineageId), content: artifact.value });
    persisted.push({ lineageId: current.lineageId, version: record.version, state, replayed: false });
  }

  // §7.1 rule 2: a diff-bearing run whose remaining lineages continue the loop
  // records that the diff is still unreviewed, so the deferred re-review of
  // rule 3 cannot be lost. Never cleared here — clearing it is the review
  // routing's job once the diff has actually been reviewed.
  //
  // Gated on this run having actually recorded a dispute, so the flag is part of
  // the dispute it describes: a run that recorded none changed no lineage, and
  // whether ITS diff defers a re-review is a §7.1 question about rows this
  // module does not own.
  const loopContinues = Object.values(lineages).some(
    (lineage) => awaitsImplementer(lineage.state) || isProgressLineageState(lineage.state),
  );
  const pendingReReview =
    input.runProducedFileChanges && persisted.length > 0 && loopContinues
      ? true
      : input.context.pendingReReview;

  const draft: ReviewDisputeContext = {
    version: 1,
    reviewStructure: input.context.reviewStructure,
    lineages,
    ...(pendingReReview === undefined ? {} : { pendingReReview }),
    ...(input.context.resolvedWithoutChanges === undefined
      ? {}
      : { resolvedWithoutChanges: input.context.resolvedWithoutChanges }),
  };
  const validated = validateReviewDisputeContext(draft, "reviewDispute", limits);
  if (!validated.ok) return validated;
  const serialized = serializeReviewDisputeContext(validated.value);
  if (!serialized.ok) return serialized;

  const disputedLineageIds = persisted.filter((e) => e.state === "disputed").map((e) => e.lineageId);
  const escalatedLineageIds = persisted.filter((e) => e.state === "escalated_human").map((e) => e.lineageId);
  const routing: DisputeRoutingState =
    persisted.length === 0
      ? { kind: "none" }
      : {
          kind: "pending_reconsideration",
          lineages: persisted
            .filter((e) => e.state === "disputed")
            .map((e) => ({ lineageId: e.lineageId, version: e.version })),
          escalatedLineageIds,
          pendingReReview: validated.value.pendingReReview === true,
        };

  return {
    ok: true,
    value: {
      context: validated.value,
      serialized: serialized.value,
      unchanged: stableStringify(validated.value) === before,
      persisted,
      refused,
      artifacts,
      routing,
      summary: {
        runId: run.runId,
        agentId: run.agentId,
        persisted: persisted.filter((e) => !e.replayed).length,
        replayed: persisted.filter((e) => e.replayed).length,
        refused: refused.length,
        disputedLineageIds,
        escalatedLineageIds,
        // Reason and detail are the #836 content-free locators; no agent prose
        // and no local path ever reaches task context through this summary.
        refusals: refused.map((r) => ({
          lineageId: r.lineageId,
          version: r.version,
          reason: r.failure.reason,
          detail: r.failure.detail,
        })),
        pendingReReview: validated.value.pendingReReview === true,
        routing: routing.kind,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// §10.2 cleanup and retention
// ---------------------------------------------------------------------------

/**
 * The events after which a dispute's persisted state may be cleaned up: the
 * three §4.1 reconsiderations, the §8 arbitration verdict, and the end of the
 * task itself.
 */
export const DISPUTE_LIFECYCLE_EVENTS = ["withdraw", "uphold", "revise", "arbitration", "task_complete"] as const;
export type DisputeLifecycleEvent = (typeof DISPUTE_LIFECYCLE_EVENTS)[number];

export interface DisputeRetentionInput {
  context: ReviewDisputeContext;
  event: DisputeLifecycleEvent;
  /** The lineage the event resolved; ignored for `task_complete`. */
  lineageId?: string;
}

export interface DisputeRetentionPlan {
  event: DisputeLifecycleEvent;
  /** Lineages whose pending-reconsideration routing entry this event clears. */
  clearedLineageIds: string[];
  /** §10.2 artifacts that must survive the event. */
  retainedArtifacts: string[];
  /** §10.2 artifacts the event releases to the session's ordinary retention. */
  removableArtifacts: string[];
  /**
   * Whether the bounded per-lineage bookkeeping — counters, `rebuttedVersions`,
   * and the `disputeRuns` idempotency keys — survives the event.
   */
  retainsContextBookkeeping: boolean;
}

/**
 * Decide what a dispute leaves behind after it is answered.
 *
 * The policy is one sentence, and it is the same for all four in-protocol
 * events: the debate's ROUTING is cleared, its RECORD is not.
 *
 *  - `withdraw`, `uphold`, `revise`, `arbitration` clear the lineage's pending
 *    reviewer turn — it is answered, so it must not be routed a second time —
 *    and retain every artifact. Those artifacts are the arbiter's bundle input
 *    (§8.2), the human's audit trail (§9), and, for `revise`, the predecessor
 *    half of the §5 materiality comparison; deleting them at the moment the
 *    debate becomes interesting is exactly backwards.
 *  - The per-lineage context bookkeeping is retained by all four as well. The
 *    §6.1 budget is what bounds the debate and the `disputeRuns` keys are what
 *    make a retried delivery idempotent; dropping either would let an answered
 *    version be rebutted again. `revise` mints a NEW version, whose slot is free
 *    precisely because the consumed one still names the old version.
 *  - `task_complete` is the only event that releases artifacts. The protocol is
 *    over, so the per-lineage records are ordinary run artifacts from then on
 *    and the session's configured artifact retention owns them — this function
 *    only says which files that policy is now free to remove, and never deletes
 *    anything itself.
 *
 * A `lineageId` that names no lineage in the block clears nothing and retains
 * nothing: an event for a lineage this task does not carry is not this task's to
 * clean up.
 */
export function planDisputeRetention(input: DisputeRetentionInput): DisputeRetentionPlan {
  const lineageIds = Object.keys(input.context.lineages);
  if (input.event === "task_complete") {
    return {
      event: input.event,
      clearedLineageIds: lineageIds,
      retainedArtifacts: [],
      removableArtifacts: lineageIds.map((id) => disputeArtifactName(id)),
      retainsContextBookkeeping: true,
    };
  }
  const lineage = input.lineageId !== undefined ? ownLineage(input.context.lineages, input.lineageId) : undefined;
  if (lineage === undefined) {
    return {
      event: input.event,
      clearedLineageIds: [],
      retainedArtifacts: [],
      removableArtifacts: [],
      retainsContextBookkeeping: true,
    };
  }
  return {
    event: input.event,
    clearedLineageIds: [lineage.lineageId],
    retainedArtifacts: [disputeArtifactName(lineage.lineageId)],
    removableArtifacts: [],
    retainsContextBookkeeping: true,
  };
}
