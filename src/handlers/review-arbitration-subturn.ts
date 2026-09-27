/**
 * Issue #955: apply ONE arbiter answer to ONE lineage, exactly once
 * (docs/review-dispute-contract.md §7, rows 13–21; §7.1, §8.3, §9, §12).
 *
 * #954 stopped one step short of a registrable turn on purpose: it resolves the
 * arbiter, invokes it, and hands back an {@link ArbitrationRouteOutcome} — the
 * exact value #847 consumes — without deciding what the answer MEANS. This module
 * is the missing step and nothing more:
 *
 *  - it routes that outcome through `routeArbitrationOutcome()`, which partitions
 *    the four §8.1 verdicts across rows 13–18, an unavailable arbiter to row 19,
 *    and malformed output to rows 20/21 by the §12 attempt cap;
 *  - it returns the row as a {@link DisputeSubTurnResult} `completed` decision, so
 *    #951 applies it through #840 and the phase runner commits it atomically with
 *    the completion it was already issuing;
 *  - it records what it applied, so a re-delivered claim converges on the
 *    committed answer instead of buying a second verdict.
 *
 * Nothing here decides a row, a counter, or a state of its own: every one of those
 * is #847's, and every write is #840's. What this module owns is the seam and the
 * three properties that make the seam safe.
 *
 * ## One logical answer, one transition, one counter movement
 *
 * Three independent guards have to agree before a counter moves, and each of them
 * fails closed on its own:
 *
 *  - **#847's arbitrability gate** re-reads the lineage's state and its
 *    `arbitrationPasses` budget before any row fires, so an outcome delivered
 *    after the lineage moved on instantiates no row at all;
 *  - **#840's counter baseline check** compares the decision's `countersAfter`
 *    against the block being written, so a decision computed from a stale
 *    snapshot is refused rather than applied;
 *  - **#840's transition ledger** is keyed on
 *    `<lineageId>@<version>#<runId>` under the SUB-TURN's derived run id (#951),
 *    so a redelivered attempt hashes to a digest already on file and applies
 *    nothing whatever it computed.
 *
 * The third is the one this module can reach BEFORE spending money: an arbiter
 * invocation costs a real agent run, and the ledger alone cannot say which row was
 * committed — only that one was. So the row itself is recorded, per lineage, under
 * {@link REVIEW_DISPUTE_ARBITRATION_APPLIED_CONTEXT_KEY}, in the same completion
 * transaction as the transition; a delivery whose recorded run id matches this
 * sub-turn's own AND whose digest is on the lineage's ledger replays that row
 * without invoking anything.
 *
 * The record is a cache over the ledger, never a substitute for it. It is written
 * from the decision this run produced, which means a run whose transition was then
 * REFUSED leaves an entry describing a row that never applied — so the ledger,
 * which only ever names committed transitions, is what admits it. An unreadable or
 * absent record therefore costs an invocation and never a counter: without it the
 * lineage has left `arbitration_pending` for every row but 20, and #847 refuses;
 * for row 20 the ledger recognizes the digest and #840 applies nothing.
 *
 * ## What is deliberately NOT here
 *
 *  - **the evidence turn.** Row 16 moves the lineage to `evidence_requested` and
 *    stops; the two per-party collection runs and row 22 are a separate slice, so
 *    §7.1 parks that turn exactly as it does today.
 *  - **G1.** `escalated_human` stays terminal: rows 15/17/18/19/21 are ends of the
 *    automation, not states this module knows a way out of.
 *  - **a second arbiter.** §8.3's "absence of an arbiter never silently converts
 *    to 'reviewer wins' or 'implementer wins'" is #839's, and an unavailable
 *    candidate list reaches row 19 as a value — never a substitution.
 */

import { createHash } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";
import {
  createArbitrationSubTurnAdapter,
  nextArbitrationLineage,
  REVIEW_DISPUTE_ARBITRATION_CONTEXT_KEY,
} from "./review-arbitration-turn.js";
import type {
  ArbitrationSubTurnOutcome,
  ArbitrationSubTurnRuntime,
  ArbitrationSubTurnSummary,
} from "./review-arbitration-turn.js";
import { isArbiterAgentId } from "../core/review-arbiter-profile.js";
import {
  REVIEW_DISPUTE_ARBITRATIONS_CONTEXT_FIELD,
  mergeArbitrationLineageRecord,
} from "../core/review-dispute-arbitrations.js";
import type { ArbitrationLineageRecord } from "../core/review-dispute-arbitrations.js";
import {
  readReconsiderationLineageEntry,
  readReconsiderationSummaryParty,
} from "../core/review-dispute-reconsiderations.js";
import { readRebuttalLineageEntry } from "../core/review-dispute-rebuttals.js";
import { routeArbitrationOutcome } from "../core/review-arbitration-route.js";
import type {
  ArbitrationOperationalClass,
  ArbitrationRouteDecision,
  ArbitrationRouteIntent,
  ArbitrationRouteReason,
  ArbitrationRouteRow,
} from "../core/review-arbitration-route.js";
import {
  ARBITRATION_ROUTE_INTENTS,
  ARBITRATION_ROUTE_REASONS,
  ARBITRATION_ROUTE_ROWS,
} from "../core/review-arbitration-route.js";
import { DISPUTE_AUDIT_EVENTS, LINEAGE_STATES, MAX_LINEAGES_PER_TASK } from "../core/review-dispute.js";
import type {
  DisputeAuditEvent,
  LineageState,
  PersistedLineage,
  ReviewDisputeLimits,
} from "../core/review-dispute.js";
import { transitionDigest } from "../core/review-dispute-transition.js";
import { disputeSubTurnRunKey } from "../core/review-dispute-dispatch.js";
import type {
  DisputeSubTurnFailure,
  DisputeSubTurnRequest,
  DisputeSubTurnResult,
  DisputeSubTurnRunner,
} from "../core/review-dispute-dispatch.js";
import {
  disputeEvidencePartyRun,
  disputeEvidenceRoundComplete,
  disputeEvidenceRoundEntry,
  evidenceArtifactName,
  parseDisputeEvidenceRoundState,
  persistedEvidenceRefDigest,
  toPersistedEvidenceRef,
} from "../core/review-dispute-evidence-state.js";
import { EVIDENCE_COLLECTION_PARTIES } from "../core/review-dispute-turn.js";
import { validateEvidenceRef } from "../core/review-dispute-validation.js";
import { isSafeArtifactDirAfterRun } from "./artifact-dir.js";
import type { ArbitrationEvidenceAttachment } from "./review-arbitration.js";
import { MAX_EVIDENCE_COLLECTION_RAW_BYTES } from "./review-evidence-collection.js";
import { readEvidenceCollectionArtifactDir } from "./review-evidence-subturn.js";

// ---------------------------------------------------------------------------
// The applied-row record
// ---------------------------------------------------------------------------

/**
 * The task-context key holding, per lineage, the §7 row this protocol last
 * applied from an arbitration sub-turn.
 *
 * Bookkeeping BETWEEN runs, exactly like #951's evidence-round record and for the
 * same reason: §10.1 is the debate's durable state and has no place for "which
 * row did the run that just committed instantiate". It is written by the same
 * completion transaction as the transition it describes, so it can never name a
 * run the task did not make — and it is admitted against #840's ledger before it
 * is believed, so it can never name a row the task did not commit.
 */
export const REVIEW_DISPUTE_ARBITRATION_APPLIED_CONTEXT_KEY = "reviewDisputeArbitrationApplied";

/** One lineage's last applied arbitration row. Literals and counters only. */
export interface ArbitrationAppliedEntry {
  /** The SUB-TURN's derived run id — what #840's ledger keys the digest on. */
  runId: string;
  /** The version the row addressed; the digest is keyed on it too. */
  version: number;
  row: ArbitrationRouteRow;
  intent: ArbitrationRouteIntent;
  reason: ArbitrationRouteReason;
  auditEvent: DisputeAuditEvent;
  nextState: LineageState;
  /** #847's proposed movement, so a replay reproduces the same decision value. */
  arbitrationPasses: 0 | 1;
  malformedArbiterAttempts: 0 | 1;
}

export interface ArbitrationAppliedRecord {
  lineages: Record<string, ArbitrationAppliedEntry>;
}

function emptyAppliedRecord(): ArbitrationAppliedRecord {
  // Null-prototype for the reason #840's `copyLineages` uses one: lineage ids are
  // runner-minted, but on a plain object a prototype key would set the prototype
  // instead of adding an entry.
  return { lineages: Object.create(null) as Record<string, ArbitrationAppliedEntry> };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function member<T extends string>(tokens: readonly T[], value: unknown): T | null {
  return typeof value === "string" && (tokens as readonly string[]).includes(value) ? (value as T) : null;
}

/** §6.1: a counter this turn proposes moves by at most one, or not at all. */
function bit(value: unknown): 0 | 1 | null {
  if (value === 0) return 0;
  if (value === 1) return 1;
  return null;
}

/**
 * Read the applied-row record back from task context, dropping anything this
 * module could not have written.
 *
 * Fail-SOFT per entry, unlike #951's evidence round, and the asymmetry is
 * deliberate. The evidence record decides whether one party's run may close a
 * two-party round, so an unreadable one has to refuse. This record only ever
 * decides whether an invocation can be SKIPPED: dropping an entry costs an agent
 * run and can never cost a counter, because the ledger — not the record — is what
 * admits the replay (see the module header). Refusing the whole dispatch over a
 * malformed entry would park a debate on bookkeeping the protocol does not need.
 */
export function parseArbitrationAppliedRecord(value: unknown): ArbitrationAppliedRecord {
  const state = emptyAppliedRecord();
  if (!isRecord(value) || !isRecord(value.lineages)) return state;
  for (const [lineageId, raw] of Object.entries(value.lineages)) {
    if (Object.keys(state.lineages).length >= MAX_LINEAGES_PER_TASK) break;
    if (!isRecord(raw)) continue;
    const runId = typeof raw.runId === "string" && raw.runId.trim() !== "" ? raw.runId : null;
    const version =
      typeof raw.version === "number" && Number.isSafeInteger(raw.version) && raw.version >= 1 ? raw.version : null;
    const rawRow = raw.row;
    const row =
      typeof rawRow === "number" ? ARBITRATION_ROUTE_ROWS.find((candidate) => candidate === rawRow) ?? null : null;
    const intent = member(ARBITRATION_ROUTE_INTENTS, raw.intent);
    const reason = member(ARBITRATION_ROUTE_REASONS, raw.reason);
    const auditEvent = member(DISPUTE_AUDIT_EVENTS, raw.auditEvent);
    const nextState = member(LINEAGE_STATES, raw.nextState);
    const arbitrationPasses = bit(raw.arbitrationPasses);
    const malformedArbiterAttempts = bit(raw.malformedArbiterAttempts);
    if (
      runId === null
      || version === null
      || row === null
      || intent === null
      || reason === null
      || auditEvent === null
      || nextState === null
      || arbitrationPasses === null
      || malformedArbiterAttempts === null
    ) {
      continue;
    }
    state.lineages[lineageId] = {
      runId,
      version,
      row,
      intent,
      reason,
      auditEvent,
      nextState,
      arbitrationPasses,
      malformedArbiterAttempts,
    };
  }
  return state;
}

function appliedEntry(record: ArbitrationAppliedRecord, lineageId: string): ArbitrationAppliedEntry | undefined {
  return Object.prototype.hasOwnProperty.call(record.lineages, lineageId) ? record.lineages[lineageId] : undefined;
}

/** The record as it stands after this run, with the older entries carried forward. */
function withEntry(
  record: ArbitrationAppliedRecord,
  lineageId: string,
  entry: ArbitrationAppliedEntry,
): ArbitrationAppliedRecord {
  const next = emptyAppliedRecord();
  for (const [id, value] of Object.entries(record.lineages)) next.lineages[id] = value;
  next.lineages[lineageId] = entry;
  return next;
}

function entryOf(decision: ArbitrationRouteDecision, runId: string): ArbitrationAppliedEntry | null {
  // Only a routed row is recorded. An operational failure instantiates none, so
  // there is nothing to replay and nothing that could be double-spent.
  if (decision.row === null || decision.nextState === null) return null;
  const auditEvent = decision.auditEvents[0];
  if (auditEvent === undefined) return null;
  return {
    runId,
    version: decision.version,
    row: decision.row,
    intent: decision.intent,
    reason: decision.reason,
    auditEvent,
    nextState: decision.nextState,
    arbitrationPasses: decision.counterDelta.arbitrationPasses,
    malformedArbiterAttempts: decision.counterDelta.malformedArbiterAttempts,
  };
}

/**
 * Rebuild the decision a recorded row applied, for a redelivery of the run that
 * applied it.
 *
 * Every field #840 reads on an already-applied transition comes from the record:
 * the lineage, the version the digest is keyed on, the row, its audit event, and
 * its bounded reason. The counters come from the block as it stands NOW — the
 * baseline check is skipped for a transition the ledger already holds, and
 * reporting a projection over counters that have since moved would be a fiction
 * either way.
 *
 * The `intent` and `nextState` are the recorded ones because they are what the
 * decision MEANT, and #951's summary republishes them; the lineage's actual state
 * is already whatever the committed row made it.
 */
function replayDecision(
  entry: ArbitrationAppliedEntry,
  lineage: PersistedLineage,
  runKey: string,
): ArbitrationRouteDecision {
  return {
    intent: entry.intent,
    lineageId: lineage.lineageId,
    version: entry.version,
    row: entry.row,
    currentState: lineage.state,
    nextState: entry.nextState,
    counterDelta: {
      rebuttals: 0,
      reconsiderations: 0,
      arbitrationPasses: entry.arbitrationPasses,
      malformedArbiterAttempts: entry.malformedArbiterAttempts,
      evidenceRoundsUsed: 0,
    },
    countersAfter: { ...lineage.counters },
    auditEvents: [entry.auditEvent],
    reason: entry.reason,
    idempotencyKey: `${runKey}|row:${entry.row}`,
    runKey,
    bundleDigest: null,
    artifactNames: [],
    profile: null,
    verdict: null,
    confidence: null,
    evidence: null,
    arbiterUnavailable: null,
    candidateRejections: [],
    invocationFailure: null,
    operational: null,
  };
}

/**
 * Has THIS sub-turn already committed the recorded row for this lineage?
 *
 * Both halves are required. The record names the run and the version; #840's
 * ledger is the proof that the transition keyed on them actually committed. A
 * record without a matching ledger entry is a run whose transition was refused or
 * whose completion never landed — which is a run still owed an answer, not a
 * replay.
 */
function recordedReplay(
  lineage: PersistedLineage,
  entry: ArbitrationAppliedEntry | undefined,
  runId: string,
): boolean {
  if (entry === undefined || entry.runId !== runId) return false;
  const ledger = lineage.appliedTransitions ?? [];
  return ledger.includes(transitionDigest(lineage.lineageId, entry.version, runId));
}

// ---------------------------------------------------------------------------
// Failure normalization
// ---------------------------------------------------------------------------

/**
 * #847's operational classes in the sub-turn vocabulary.
 *
 * Exhaustive by type. None of these is a transition: §7 has rows for the failures
 * it defines (19, 20, 21) and everything else is a run that did not happen, which
 * parks with the debate state untouched (§9, §12).
 */
const OPERATIONAL_FAILURE_KINDS: Record<ArbitrationOperationalClass, DisputeSubTurnFailure["kind"]> = {
  "agent-unavailable": "invocation_failed",
  precondition: "stale_lineage",
  "input-artifact": "invocation_failed",
  "artifact-write": "artifact_failed",
};

/**
 * The failure a non-routing outcome parks with.
 *
 * The adapter's own normalization wins where it has one: it carries the §12
 * protocol failure verbatim and — the reason #953 exists — it is the only layer
 * that knows whether the agent was killed by the deadline or ran and refused, a
 * distinction #846 reports as `agent-failed` either way.
 */
function operationalFailure(
  decision: ArbitrationRouteDecision,
  adapterFailure: DisputeSubTurnFailure | null,
): DisputeSubTurnFailure {
  if (adapterFailure !== null) return adapterFailure;
  const operational = decision.operational;
  if (operational === null) {
    return { kind: "internal_error", detail: `route.intent:${decision.intent}` };
  }
  return {
    kind: OPERATIONAL_FAILURE_KINDS[operational.failureClass],
    detail: `${operational.kind}${operational.detail === null ? "" : `:${operational.detail}`}`,
  };
}

// ---------------------------------------------------------------------------
// Bounded summary
// ---------------------------------------------------------------------------

/**
 * #847's decision, reduced to what §10.3 admits.
 *
 * Every field here is already a literal, a counter, an id, or a bounded token by
 * #847's own contract — the arbiter's rationale never leaves the §10.2 artifact,
 * and the artifact NAMES travel while the directory holding them does not.
 */
export interface ArbitrationRouteSummary {
  intent: ArbitrationRouteIntent;
  lineageId: string;
  version: number;
  row: number | null;
  currentState: LineageState;
  nextState: LineageState | null;
  reason: ArbitrationRouteReason;
  runKey: string;
  idempotencyKey: string;
  counterDelta: ArbitrationRouteDecision["counterDelta"];
  countersAfter: ArbitrationRouteDecision["countersAfter"];
  auditEvents: DisputeAuditEvent[];
  verdict: ArbitrationRouteDecision["verdict"];
  confidence: ArbitrationRouteDecision["confidence"];
  evidence: ArbitrationRouteDecision["evidence"];
  arbiterUnavailable: ArbitrationRouteDecision["arbiterUnavailable"];
  invocationFailure: ArbitrationRouteDecision["invocationFailure"];
  operational: ArbitrationRouteDecision["operational"];
  artifactNames: string[];
  bundleDigest: string | null;
  /** True when the row was replayed from the applied-row record, not decided. */
  replayed: boolean;
}

function summarizeRoute(decision: ArbitrationRouteDecision, replayed: boolean): ArbitrationRouteSummary {
  return {
    intent: decision.intent,
    lineageId: decision.lineageId,
    version: decision.version,
    row: decision.row,
    currentState: decision.currentState,
    nextState: decision.nextState,
    reason: decision.reason,
    runKey: decision.runKey,
    idempotencyKey: decision.idempotencyKey,
    counterDelta: { ...decision.counterDelta },
    countersAfter: { ...decision.countersAfter },
    auditEvents: [...decision.auditEvents],
    verdict: decision.verdict,
    confidence: decision.confidence === null ? null : { ...decision.confidence },
    evidence: decision.evidence === null ? null : { ...decision.evidence },
    arbiterUnavailable: decision.arbiterUnavailable,
    invocationFailure: decision.invocationFailure === null ? null : { ...decision.invocationFailure },
    operational: decision.operational === null ? null : { ...decision.operational },
    artifactNames: [...decision.artifactNames],
    bundleDigest: decision.bundleDigest,
    replayed,
  };
}

/** The context patch one arbitration sub-turn writes. Bounded literals only. */
function contextPatch(
  summary: ArbitrationSubTurnSummary | null,
  route: ArbitrationRouteSummary | null,
  applied: ArbitrationAppliedRecord | null,
  arbitrations: ArbitrationLineageRecord | null = null,
): Record<string, unknown> {
  return {
    [REVIEW_DISPUTE_ARBITRATION_CONTEXT_KEY]: {
      ...(summary === null ? {} : { ...summary }),
      ...(route === null ? {} : { route }),
    },
    ...(applied === null ? {} : { [REVIEW_DISPUTE_ARBITRATION_APPLIED_CONTEXT_KEY]: applied }),
    // Task context merges shallowly, so the key is written only when this run
    // has an entry to add — a park or a replay leaves the persisted record
    // untouched rather than overwriting it with an empty one (issue #964).
    ...(arbitrations === null ? {} : { [REVIEW_DISPUTE_ARBITRATIONS_CONTEXT_FIELD]: arbitrations }),
  };
}

// ---------------------------------------------------------------------------
// The sub-turn implementation
// ---------------------------------------------------------------------------

/** Everything the arbitration sub-turn needs, as values. */
export interface ArbitrationSubTurnRunnerRuntime extends ArbitrationSubTurnRuntime {
  /**
   * `task.context.reviewDisputeArbitrationApplied`, exactly as persisted and
   * therefore untrusted — parsed here, never believed on its own (see
   * {@link recordedReplay}). Absent is an empty record, which is the conservative
   * direction: no replay is recognized and the arbiter runs.
   */
  applied?: unknown;
  /**
   * `task.context.reviewDisputeReconsiderations`, exactly as persisted and
   * therefore untrusted: where each lineage's reviewer sub-turn left its §10.2
   * record, and which agent wrote it.
   *
   * The two runtime fields it supersedes — `reconsiderationArtifactDir` and
   * `review` — are single-valued, but a reviewer turn answers ONE lineage per
   * review run. With two disputed findings the caller's values necessarily
   * describe the LAST reviewer run, while this turn arbitrates the FIRST
   * still-`arbitration_pending` lineage: without a per-lineage lookup the bundle
   * reads the wrong directory (an operational park on a record one directory
   * over) and §8.3 measures independence against the wrong reviewer (issue #955
   * review, P1).
   *
   * Absent, unreadable, or naming another lineage, the caller's own values stand
   * — which is the pre-record behavior and the right answer for a debate that
   * started before this key existed.
   */
  reconsiderations?: unknown;
  /**
   * `task.context.reviewDisputeRebuttals`, exactly as persisted and therefore
   * untrusted: where each lineage's §10.2 dispute record was written, and which
   * agent wrote it.
   *
   * The implementer half of {@link reconsiderations}, superseding the two
   * runtime fields that describe the LAST fix run — `disputeArtifactDir` and
   * `implementation`. A fix run rebuts only the lineages its own response
   * disputed, and the protocol advances lineages independently: a row 11
   * material revision sends one lineage back to the implementer while another
   * stays disputed, so two arbitration-pending lineages can have their rebuttals
   * in two directories, minted by two runs that need not share an agent. Without
   * a per-lineage lookup, arbitrating the earlier one reads `dispute-<id>.json`
   * from the later run's directory — a missing or identity-mismatched artifact
   * that parks a resolvable dispute — and §8.3 measures independence against the
   * other lineage's implementer, which can reject a valid arbiter or select one
   * sharing this lineage's actual provider (issue #955 review, P1).
   *
   * Absent, unreadable, or naming another lineage, the caller's own values stand.
   */
  rebuttals?: unknown;
  /**
   * `task.context.reviewDisputeArbitrations`, exactly as persisted and
   * therefore untrusted: where each lineage's §8.1 verdict record was written
   * (issue #964). This run's own entry is MERGED over it on a completed,
   * verdict-carrying outcome, so a shallow context merge cannot drop the other
   * lineages' — the same shape, and the same lesson, as the rebuttal and
   * reconsideration records. Never read back on this turn's own paths: the
   * evidence turn is the reader, and it re-validates the located record.
   */
  arbitrations?: unknown;
  /**
   * `task.context.reviewDisputeEvidenceRound`, exactly as persisted and
   * therefore untrusted: #963's round record, naming — per lineage — which
   * §7 row 22 evidence round closed, what each party admitted, and the safe
   * references to the §10.2 record files that hold the admitted references
   * verbatim.
   *
   * What it supplies is `evidenceRoundAttachments` for the ONE lineage this
   * dispatch arbitrates (issue #964 review, P1): a re-presented arbitration that
   * ran without it would decide the same dispute without the evidence the round
   * was opened to collect. A caller that set `evidenceRoundAttachments` itself
   * keeps its own value; absent both, the arbiter runs with no round — which is
   * the right answer for a lineage that never had one, and the pre-#964 answer
   * for every other.
   */
  evidenceRound?: unknown;
  /**
   * `task.context.reviewDisputeEvidenceCollections`, exactly as persisted and
   * therefore untrusted: where each party's collection run left its §10.2
   * files. The round record deliberately holds base NAMES and digests only, so
   * this is the one source for the directory each record file is resolved
   * from — bounded inside `artifactRoot` before it is read, like every other
   * cross-run artifact directory this protocol reads back.
   */
  evidenceCollections?: unknown;
  /**
   * `task.context.reviewDisputeReconsideration`, exactly as persisted and
   * therefore untrusted: the LAST reviewer sub-turn's own bounded invocation
   * summary, which records the lineage and version it answered alongside the
   * profile it resolved.
   *
   * A second-choice source for the same identity {@link reconsiderations}
   * carries, kept because it is the only place a debate that predates the
   * per-lineage record wrote its reviewer down. Being single-valued it is read
   * ONLY when it names the selected lineage: an unmatched summary belongs to
   * another debate, and believing it would let §8.3 measure independence
   * against a reviewer this finding never had — which, on a lane reconfigured
   * between the two runs, selects an arbiter sharing the selected finding's
   * actual reviewer provider (issue #955 review, P1).
   */
  reconsiderationSummary?: unknown;
}

/**
 * The runtime as it applies to the ONE lineage this dispatch will arbitrate.
 *
 * Resolved here rather than by the caller because the caller cannot know it: the
 * lineage is chosen from the persisted block by {@link nextArbitrationLineage},
 * which is also what the adapter chooses with — the same function over the same
 * request, so the directory and the party this override installs are always the
 * ones the invocation is then made for.
 *
 * Only what the record actually names is overridden — plus, for the reviewer's
 * identity alone, what the single-valued reviewer summary names WHEN it named
 * this same lineage. A missing entry, an entry for a version this lineage has
 * not reached, or one naming an agent id this runner does not recognise all
 * leave the caller's value in place rather than substituting a fall-back of this
 * module's own invention.
 */
function forSelectedLineage(
  runtime: ArbitrationSubTurnRunnerRuntime,
  request: DisputeSubTurnRequest,
): ArbitrationSubTurnRuntime {
  if (
    runtime.reconsiderations === undefined
    && runtime.rebuttals === undefined
    && runtime.reconsiderationSummary === undefined
  ) {
    return runtime;
  }
  const lineage = nextArbitrationLineage(request);
  if (lineage === null) return runtime;
  const reviewer =
    runtime.reconsiderations === undefined
      ? undefined
      : readReconsiderationLineageEntry(runtime.reconsiderations, lineage.lineageId, lineage.version);
  const implementer =
    runtime.rebuttals === undefined
      ? undefined
      : readRebuttalLineageEntry(runtime.rebuttals, lineage.lineageId, lineage.version);
  // An id and nothing else, on both halves: a persisted provider or model cannot
  // be authenticated by the run that reads it back, and §8.3 is stricter without
  // them — every same-provider candidate is rejected as
  // `same-provider-model-unknown` (core/review-dispute-parties.ts).
  //
  // The reviewer half has one more source than the implementer's: the reviewer
  // sub-turn's single-valued invocation summary, which a debate older than the
  // per-lineage record is the only carrier of. It is admitted only when it names
  // THIS lineage, so it can supply the identity the record is missing without
  // ever supplying another debate's reviewer (issue #955 review, P1).
  const reviewAgentId =
    reviewer?.agentId
    ?? readReconsiderationSummaryParty(runtime.reconsiderationSummary, lineage.lineageId, lineage.version)?.agentId;
  const implementationAgentId = implementer?.agentId;
  return {
    ...runtime,
    ...(reviewer === undefined ? {} : { reconsiderationArtifactDir: reviewer.artifactDir }),
    ...(isArbiterAgentId(reviewAgentId) ? { review: { agentId: reviewAgentId } } : {}),
    ...(implementer === undefined ? {} : { disputeArtifactDir: implementer.artifactDir }),
    ...(isArbiterAgentId(implementationAgentId) ? { implementation: { agentId: implementationAgentId } } : {}),
  };
}

// ---------------------------------------------------------------------------
// §7 row 22: the admitted evidence round, resolved for the selected lineage
// ---------------------------------------------------------------------------

/** What resolving the round produced: nothing owed, values, or a typed park. */
type EvidenceRoundResolution =
  | { kind: "none" }
  | { kind: "resolved"; attachments: ArbitrationEvidenceAttachment[] }
  | { kind: "failed"; failure: DisputeSubTurnFailure };

function unresolvableEvidence(detail: string): EvidenceRoundResolution {
  return { kind: "failed", failure: { kind: "invocation_failed", detail } };
}

/** The twelve-hex content digest #956's artifact references are recorded in. */
function evidenceContentDigest(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex").slice(0, 12);
}

/**
 * Reconstruct `evidenceRoundAttachments` for the lineage this dispatch will
 * arbitrate, from the persisted round record and the party record files it
 * names (issue #964 review, P1).
 *
 * The round record is the authority for WHAT was admitted — which parties
 * completed, how many references each recorded, and the digest of the §10.2
 * record file that holds them — but it deliberately does not hold every
 * reference verbatim: an `issue_quote` is persisted as its digest, and the
 * span itself lives only in the party's own record file. So each party that
 * admitted anything has its record file read back — from the directory the
 * per-party execution record names, bounded inside `artifactRoot`, and
 * admitted only when its bytes hash to the digest the round recorded — and the
 * references inside it are re-validated by §3.3's own validator, then checked
 * against the persisted projections one by one.
 *
 * Fail-CLOSED per party, and the asymmetry with the reconsideration/rebuttal
 * lookups above is deliberate: those records only ever relocate a directory,
 * so dropping one costs the caller's fallback value; this one supplies the
 * evidence the round was opened to collect, and arbitrating without it would
 * spend the lineage's pass on exactly the gap the round answered — the quiet
 * form of the bug this resolution exists to fix. A round that never happened
 * (`none`), or one recorded against a version this lineage has since left
 * (§2.2: a material revision mints a successor identity, so the stale round
 * describes a different finding), arbitrates without attachments exactly as
 * before.
 */
function resolveEvidenceRoundAttachments(
  runtime: ArbitrationSubTurnRunnerRuntime,
  request: DisputeSubTurnRequest,
): EvidenceRoundResolution {
  // A caller-supplied value is a decision already made (and the test seam).
  if (runtime.evidenceRoundAttachments !== undefined) return { kind: "none" };
  if (runtime.evidenceRound === undefined) return { kind: "none" };
  const lineage = nextArbitrationLineage(request);
  // No arbitrable lineage: the adapter's own stale-turn park answers, not this.
  if (lineage === null) return { kind: "none" };

  const parsed = parseDisputeEvidenceRoundState(runtime.evidenceRound);
  if (!parsed.ok) {
    return { kind: "failed", failure: { kind: "invalid_context", detail: `evidenceRound:${parsed.failure.reason}` } };
  }
  const entry = disputeEvidenceRoundEntry(parsed.value, lineage.lineageId);
  if (entry === undefined) return { kind: "none" };
  if (entry.version !== lineage.version) return { kind: "none" };
  if (!disputeEvidenceRoundComplete(entry)) {
    // `arbitration_pending` at a version whose round is still open is a state
    // this protocol cannot have written: row 16 opened the round for this very
    // version, and only row 22 — which requires both parties — leads back here.
    // Arbitrating anyway would silently drop a party's answer.
    return {
      kind: "failed",
      failure: { kind: "invalid_context", detail: `evidenceRound:${lineage.lineageId}:incomplete` },
    };
  }

  const attachments: ArbitrationEvidenceAttachment[] = [];
  for (const party of EVIDENCE_COLLECTION_PARTIES) {
    const run = disputeEvidencePartyRun(entry, party);
    // §7.1: zero admitted attachments is a valid completed party, and it has
    // nothing to resolve — the record file is never needed to attach nothing.
    if (run === undefined || run.attachments === 0) continue;
    const name = evidenceArtifactName(party, lineage.lineageId, "record");
    const recordRef = (run.artifacts ?? []).find((artifact) => artifact.name === name);
    if (recordRef === undefined) return unresolvableEvidence(`evidenceRound:${party}:record-ref-absent`);
    if (recordRef.bytes > MAX_EVIDENCE_COLLECTION_RAW_BYTES) {
      return unresolvableEvidence(`evidenceRound:${party}:record-bytes:${recordRef.bytes}`);
    }
    const dir = readEvidenceCollectionArtifactDir(runtime.evidenceCollections, party);
    if (dir === null) return unresolvableEvidence(`evidenceRound:${party}:artifact-dir-absent`);
    if (!isSafeArtifactDirAfterRun(runtime.artifactRoot, dir)) {
      return unresolvableEvidence(`evidenceRound:${party}:artifact-dir-unsafe`);
    }
    let content: string;
    try {
      content = readFileSync(join(dir, name), "utf8");
    } catch {
      return unresolvableEvidence(`evidenceRound:${party}:record-unreadable`);
    }
    if (Buffer.byteLength(content, "utf8") !== recordRef.bytes || evidenceContentDigest(content) !== recordRef.digest) {
      return unresolvableEvidence(`evidenceRound:${party}:record-digest`);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(content) as unknown;
    } catch {
      return unresolvableEvidence(`evidenceRound:${party}:record-unparsable`);
    }
    // The digest already proves these bytes are the ones the round recorded;
    // the identity check below is the cheap guard against the round record and
    // the collections record having been written by two different runs.
    if (!isRecord(raw)) return unresolvableEvidence(`evidenceRound:${party}:record-shape`);
    if (raw.party !== party || raw.lineageId !== lineage.lineageId || raw.version !== entry.version) {
      return unresolvableEvidence(`evidenceRound:${party}:record-identity`);
    }
    const references = raw.references;
    if (!Array.isArray(references) || references.length !== run.attachments) {
      return unresolvableEvidence(`evidenceRound:${party}:record-references`);
    }
    for (const [index, value] of references.entries()) {
      const validated = validateEvidenceRef(value, `evidenceRound.${party}[${index}]`);
      if (!validated.ok) return unresolvableEvidence(`evidenceRound:${party}:reference:${index}`);
      const persisted = run.references?.[index];
      if (
        persisted !== undefined
        && persistedEvidenceRefDigest(toPersistedEvidenceRef(validated.value)) !== persistedEvidenceRefDigest(persisted)
      ) {
        return unresolvableEvidence(`evidenceRound:${party}:reference-digest:${index}`);
      }
      attachments.push({ party, ref: validated.value });
    }
  }
  return { kind: "resolved", attachments };
}

/**
 * Build the §7.1 `runner_arbitration` sub-turn implementation.
 *
 * Values in, one typed outcome out. No store, no task key, no CAS, and no write:
 * a `completed` result carries #847's routed row and #951 is what applies it,
 * every other path is a typed `failed` that parks the task with the debate state
 * exactly as it was.
 */
export function createArbitrationSubTurnRunner(runtime: ArbitrationSubTurnRunnerRuntime): DisputeSubTurnRunner {
  const record = parseArbitrationAppliedRecord(runtime.applied);

  return (request: DisputeSubTurnRequest): DisputeSubTurnResult => {
    const limits: ReviewDisputeLimits = request.limits;
    const runId = request.identity.runId;

    // Replay first, and deliberately before anything that could invoke an agent:
    // a re-delivered claim must converge on the row it already committed rather
    // than buy a second verdict. The turn's lineage ids arrive sorted, so which
    // one answers is deterministic here exactly as it is in the adapter.
    for (const lineageId of request.turn.lineageIds) {
      const lineage = Object.prototype.hasOwnProperty.call(request.context.lineages, lineageId)
        ? request.context.lineages[lineageId]
        : undefined;
      if (lineage === undefined) continue;
      const entry = appliedEntry(record, lineageId);
      if (!recordedReplay(lineage, entry, runId)) continue;
      const committed = entry as ArbitrationAppliedEntry;
      const decision = replayDecision(
        committed,
        lineage,
        disputeSubTurnRunKey(request.identity, lineageId, committed.version),
      );
      return {
        status: "completed",
        // #840 recognizes the digest, writes nothing, and reports the same
        // routing — which is what makes this a `replayed` disposition rather
        // than a second application.
        decision: { kind: "arbitration", decision },
        actor: "arbiter",
        context: contextPatch(null, summarizeRoute(decision, true), record),
      };
    }

    // Row 22's admitted attachments, resolved BEFORE anything can invoke an
    // agent: a park here costs no counter and no invocation, while discovering
    // the same unresolvable round after the arbiter ran would have spent the
    // lineage's pass on a verdict decided without the round's evidence
    // (issue #964 review, P1).
    const evidence = resolveEvidenceRoundAttachments(runtime, request);
    if (evidence.kind === "failed") {
      return { status: "failed", failure: evidence.failure };
    }
    // Built per request, not per runner: the reviewer run this turn arbitrates
    // is a property of the LINEAGE the request selects, and only the request
    // names it.
    const adapter = createArbitrationSubTurnAdapter(
      forSelectedLineage(
        evidence.kind === "resolved" ? { ...runtime, evidenceRoundAttachments: evidence.attachments } : runtime,
        request,
      ),
    );
    const outcome: ArbitrationSubTurnOutcome = adapter(request);
    if (outcome.kind === "not_dispatched") {
      // No lineage was chosen, so nothing was resolved and nothing ran.
      return { status: "failed", failure: outcome.failure, context: contextPatch(outcome.summary, null, null) };
    }

    const lineage = request.context.lineages[outcome.lineageId];
    const decision = routeArbitrationOutcome({
      lineage,
      version: outcome.version,
      outcome: outcome.route,
      limits,
    });

    const artifacts = outcome.artifacts;
    if (decision.intent === "operational_failure" || decision.row === null || decision.nextState === null) {
      // §12: no row fires, no counter moves, and the lineage keeps its state.
      // The task parks and the debate resumes exactly where it stopped — for a
      // malformed-attempt cap or an exhausted pass budget this is the difference
      // between an audited stop and a debate that quietly re-runs forever.
      return {
        status: "failed",
        failure: operationalFailure(decision, outcome.failure),
        artifacts,
        context: contextPatch(outcome.summary, summarizeRoute(decision, false), null),
      };
    }

    const entry = entryOf(decision, runId);
    const nextRecord = entry === null ? record : withEntry(record, outcome.lineageId, entry);
    // Where this lineage's §8.1 verdict record now lives (issue #964): recorded
    // exactly when a verdict was admitted — #846 writes
    // `arbitration-<lineageId>.json` beside the bundle only then — so a row-19
    // unavailable arbiter, which has no verdict artifact, records no locator for
    // a file that does not exist. The row-16 evidence turn resolves the verdict
    // it re-presents from this entry.
    const arbitrations =
      decision.verdict === null
        ? null
        : mergeArbitrationLineageRecord(runtime.arbitrations, outcome.lineageId, {
            version: outcome.version,
            artifactDir: runtime.artifactDir,
          });
    return {
      status: "completed",
      decision: { kind: "arbitration", decision },
      // §10.3: the arbiter is the actor of its own verdict — including row 19,
      // where the arbiter is the party that could not be found.
      actor: "arbiter",
      artifacts,
      context: contextPatch(outcome.summary, summarizeRoute(decision, false), nextRecord, arbitrations),
    };
  };
}
