/**
 * Issue #951: the runtime seam between the §7.1 sub-turn SELECTOR and the phase
 * runner's existing completion contract
 * (docs/review-dispute-contract.md §7.1, §9, §10.1–§10.3, §12).
 *
 * #950 answers "which sub-turn must run next" as a closed value. #840 answers
 * "what does an already-approved decision do to the lineage set", and the phase
 * runner already commits that answer atomically with the completion it was going
 * to issue anyway. Between the two sits the thing this module is: the one place
 * that turns ONE selected sub-turn into ONE `PhaseHandlerResult`.
 *
 * It exists so the three missing turns — reconsideration, evidence collection,
 * arbitration — can be implemented as plain functions that compute a typed
 * decision and nothing else:
 *
 *  - **no store reaches them.** A {@link DisputeSubTurnRunner} is handed a
 *    request and returns a value. It has no `TaskStore`, no `OutboxStore`, no
 *    task key and no CAS guard, so "sub-turn implementations perform no direct
 *    store writes" is a property of the type rather than a rule to remember.
 *    Persistence stays where it already is: the runner's one
 *    `completePhaseWithEffects` transaction (phase-runner.ts, issue #701/#840).
 *  - **no transition is invented here.** A sub-turn returns a
 *    {@link DisputeTransitionDecision} — the same closed union #840 consumes from
 *    every other producer — and this module applies it through
 *    `applyDisputeTransition`. A sub-turn that could not produce one returns a
 *    typed failure instead, and a failure moves nothing: no row, no counter, no
 *    lineage state, no §10.1 flag. That is the whole of "failed or delayed
 *    outcomes cannot consume counters or partially update lineage state".
 *  - **a delivered value is admitted, never assumed.** The type says what an
 *    implementation returns; the value that actually arrives is checked against
 *    it ({@link DISPUTE_SUB_TURN_DECISION_KINDS} and the shape guards below)
 *    before a single field of it is read. An implementation is code this module
 *    does not own — and one built against another version of this contract, or
 *    returning a decision belonging to a DIFFERENT turn, is §12 malformed output
 *    that parks, not a shape to reinterpret or to crash on.
 *  - **the evidence round is the exception that proves it.** §7.1's evidence turn
 *    is two runs, one per party, and they "change no lineage state themselves":
 *    row 22 is the RUNNER's, applied once "when both have completed". So an
 *    evidence implementation cannot return a decision at all — it returns
 *    {@link DisputeSubTurnResult} `collected`, per-lineage attachment counts and
 *    nothing else — and this module accumulates the two parties in a bounded
 *    task-context record ({@link REVIEW_DISPUTE_EVIDENCE_ROUND_CONTEXT_KEY})
 *    until the round is complete, only then synthesizing row 22. A first party's
 *    run therefore moves no lineage, which is what leaves the second party a
 *    lineage still in `evidence_requested` to be dispatched against.
 *  - **replay is recognized from identity, never from prose.** Every transition
 *    #840 records is keyed on `<lineageId>@<version>#<runId>`, so the run id a
 *    sub-turn transitions under decides whether a re-delivery is a duplicate or a
 *    second debate. {@link disputeSubTurnIdentity} derives that id
 *    deterministically from the claim's run id and the sub-turn's own coordinates
 *    (kind, party, attempt, lineage set), which makes a retried delivery of one
 *    attempt converge and a genuinely new attempt — #847's row-20 retry above
 *    all — a distinct run the ledger cannot mistake for the first. The evidence
 *    turn has no ledger entry until row 22 fires, so its round record answers the
 *    same question for it: a party whose collection is already recorded, and a
 *    deferred lineage whose round is already complete, are replayed FROM the
 *    record rather than collected again, because a second run would duplicate the
 *    work and then overwrite the very attachments row 22 goes on to record.
 *
 * One caller exists: the review phase's sub-turn gate
 * (`handlers/review-reconsideration-turn.ts`) dispatches the reviewer's
 * reconsideration (issue #952), the runner's arbitration (issue #955), and —
 * since issue #964 — the per-party evidence collection (#963's implementation,
 * `handlers/review-evidence-subturn.ts`, behind the runtime assembly in
 * `handlers/review-evidence-turn.ts`) through here as internal sub-turns. A
 * dispatch that reaches this module without a registered runner still fails
 * closed as `no_implementation`. Nothing changes for
 * `session.reviewDispute.enabled` false, which writes no §10.1 block and
 * therefore selects no turn at all.
 *
 * Purity: no store, no filesystem, no GitHub, no agent, no clock. Artifacts
 * travel OUT as bytes for the caller to write under its own run directory, the
 * way #838/#846 already hand them back.
 */

import { createHash } from "crypto";
import type { AgentFailureKind } from "./agent-diagnostics.js";
import type { PhaseDelayKind, PhaseHandlerEvent, PhaseHandlerResult } from "./phase-runner.js";
import type { DisputeArtifact } from "./review-dispute-persistence.js";
import { REVIEW_DISPUTE_CONTEXT_KEY } from "./review-dispute-commit.js";
import type {
  DisputeActorRole,
  EvidenceRef,
  LineageState,
  PersistedLineage,
  ReviewDisputeContext,
  ReviewDisputeLimits,
} from "./review-dispute.js";
import {
  DISPUTE_ACTOR_ROLES,
  MAX_DISPUTE_SUB_TURN_ATTEMPT,
  MAX_RUN_ID_CHARS,
  REVIEW_DISPUTE_DEFAULT_LIMITS,
} from "./review-dispute.js";
import type { ReviewDisputeFailure } from "./review-dispute-validation.js";
import { REVIEW_DISPUTE_FAILURE_REASONS, validateReviewDisputeContext } from "./review-dispute-validation.js";
import type {
  DisputeTaskTurn,
  DisputeTransitionApplication,
  DisputeTransitionDecision,
} from "./review-dispute-transition.js";
import {
  aggregateDisputeRouting,
  applyDisputeTransition,
  transitionDigest,
  transitionKey,
} from "./review-dispute-transition.js";
import { serializeReviewDisputeContext } from "./review-dispute-lineage.js";
import type { EvidenceCollectionParty, PendingDisputeTurn } from "./review-dispute-turn.js";
import { EVIDENCE_COLLECTION_PARTIES, disputeTurnAwaitsDispatcher } from "./review-dispute-turn.js";
// Issue #956 owns the persisted evidence-round record this adapter accumulates
// into. It is imported rather than declared here — and re-exported below under
// the names #955 published — so there is one source of truth for what a round
// IS, and this module keeps only what it does with one.
import type {
  DisputeEvidenceArtifactRef,
  DisputeEvidenceRoundState,
  EvidencePartyRunCoordinates,
} from "./review-dispute-evidence-state.js";
import {
  DEFAULT_EVIDENCE_ROUND,
  MAX_EVIDENCE_ATTACHMENTS_PER_PARTY,
  MAX_EVIDENCE_DROPPED_PER_PARTY,
  REVIEW_DISPUTE_EVIDENCE_ROUND_CONTEXT_KEY,
  completeEvidencePartyRun,
  disputeEvidenceAttachmentsRecorded,
  disputeEvidencePartyState,
  disputeEvidenceRoundComplete,
  disputeEvidenceRoundEntry,
  disputeEvidenceRunStatus,
  evidenceArtifactRef,
  isEvidenceArtifactName,
  markEvidencePartyRunRecoverable,
  markEvidenceRoundRecorded,
  parseDisputeEvidenceRoundState,
  summarizeEvidenceRound,
} from "./review-dispute-evidence-state.js";
// Type-only, and only for the two failure vocabularies this module normalizes —
// the same direction `review-arbitration-route.ts` already reads #846's tokens
// in. Nothing runtime crosses the boundary: a sub-turn implementation, not this
// module, invokes an agent.
import type {
  ReconsiderationFailureKind,
  ReconsiderationInvocationFailure,
} from "../handlers/review-reconsideration.js";
import type {
  ArbitrationFailureKind,
  ArbitrationInvocationFailure,
} from "../handlers/review-arbitration.js";

// ---------------------------------------------------------------------------
// Which turns this adapter owns
// ---------------------------------------------------------------------------

/**
 * The §7.1 turns that need a sub-turn implementation — exactly the set
 * `disputeTurnAwaitsDispatcher` identifies, restated as a token list because a
 * predicate cannot be used as a type.
 *
 * The other five members of `PendingDisputeTurn` are deliberately absent and are
 * not this module's business: `implementer_fix` and `re_review` are the routes
 * the runner already dispatches, `no_turn` is the ordinary result standing, and
 * `human_handoff` and `unresolvable` are stops the selector's own caller applies.
 * Narrowing the INPUT type rather than adding a "not for me" outcome keeps the
 * selector's fail-closed boundary exactly where #950 drew it: a caller has to
 * consume the selector's closed union first, and only a turn that survived that
 * `switch` can reach here at all.
 */
export const DISPUTE_SUB_TURN_KINDS = [
  "reviewer_reconsideration",
  "evidence_collection",
  "runner_arbitration",
] as const;
export type DisputeSubTurnKind = (typeof DISPUTE_SUB_TURN_KINDS)[number];

/** The selector's own variants for those turns, consumed verbatim. */
export type DispatchableDisputeTurn = Extract<PendingDisputeTurn, { kind: DisputeSubTurnKind }>;

/**
 * Compile-time pin: every token above names a real selector variant.
 *
 * The reverse direction — that no dispatchable variant is missing from the list —
 * cannot be stated as a type (the selector's union is deliberately wider), so
 * it is pinned at runtime against `disputeTurnAwaitsDispatcher` instead, both in
 * {@link disputeSubTurnIdentity}'s guard and in this slice's tests.
 */
type AssertTrue<T extends true> = T;
type _EverySubTurnTokenIsASelectorVariant = AssertTrue<
  DisputeSubTurnKind extends PendingDisputeTurn["kind"] ? true : false
>;

/**
 * The §7.1 turn token each sub-turn corresponds to, so the two vocabularies stay
 * one mapping instead of two parallel lists a reader has to align by hand.
 */
export const DISPUTE_SUB_TURN_TASK_TURNS: Readonly<Record<DisputeSubTurnKind, DisputeTaskTurn>> = {
  reviewer_reconsideration: "reviewer",
  evidence_collection: "evidence",
  runner_arbitration: "runner",
};

/**
 * The lineage state a turn's lineages must still be in when the run starts.
 *
 * §7.1 rule 2 selects a turn FROM these states, so a lineage that has left one
 * between selection and dispatch is a block that moved under the run — another
 * worker's completion, an operator action, a resumed stale claim. Dispatching
 * anyway would debate a finding whose history the runner has misread, so the
 * check runs before the implementation is called at all (see
 * {@link dispatchDisputeSubTurn}).
 */
export const DISPUTE_SUB_TURN_REQUIRED_STATES: Readonly<Record<DisputeSubTurnKind, LineageState>> = {
  reviewer_reconsideration: "disputed",
  evidence_collection: "evidence_requested",
  runner_arbitration: "arbitration_pending",
};

/**
 * The ONE #840 decision each sub-turn may transition under.
 *
 * §7.1 gives every turn a single row family: the reviewer's reconsideration
 * answers rows 9–12, the arbiter's verdict is routed by #847, and row 22 is the
 * runner's own — synthesized here, never returned by an evidence run. So a
 * decision of any other kind is not this turn's decision, however well-formed it
 * is, and applying it would let one turn take another's: a reconsideration
 * implementation returning a `finding_admission` would ADD lineages to the block
 * while the disputed lineage it was dispatched for never moved, and the routing
 * would report a debate that did not happen. The kind is checked against this
 * mapping — and the lineages the decision addresses against the turn's own set —
 * before `applyDisputeTransition` is called (see {@link dispatchDisputeSubTurn}).
 */
export const DISPUTE_SUB_TURN_DECISION_KINDS: Readonly<
  Record<DisputeSubTurnKind, DisputeTransitionDecision["kind"]>
> = {
  reviewer_reconsideration: "reconsideration",
  evidence_collection: "evidence_round",
  runner_arbitration: "arbitration",
};

/**
 * Who the §10.3 audit record names when the implementation does not say.
 *
 * The reviewer answers a reconsideration and the arbiter returns a verdict, so
 * both are the actor of their own turn. Row 22 is different: an
 * evidence-collection run collects references, but the row that RECORDS them and
 * returns the lineage to `arbitration_pending` is applied by the runner between
 * runs, and it is the row — not the collection — that this adapter transitions.
 * The two decision turns may override their default (a reconsideration the
 * protocol later wants attributed elsewhere); row 22 may not, because neither
 * party's run is the one that applies it.
 */
export const DISPUTE_SUB_TURN_DEFAULT_ACTORS: Readonly<Record<DisputeSubTurnKind, DisputeActorRole>> = {
  reviewer_reconsideration: "reviewer",
  evidence_collection: "runner",
  runner_arbitration: "arbiter",
};

// ---------------------------------------------------------------------------
// The bounded evidence round (§7.1, row 22)
// ---------------------------------------------------------------------------

/**
 * #955's round record, published from where it has always been published.
 *
 * The declarations moved to `review-dispute-evidence-state.ts` (issue #956),
 * which extended them with the collection LIFECYCLE — a party that is running, a
 * party whose run may be retried, and what a completed party actually admitted —
 * and with the safe artifact references those admissions travel by. What did not
 * move is the meaning of any of it: a record written before that module existed
 * reads as exactly what it meant, and this adapter's completion, replay, and
 * row-22 semantics are unchanged.
 */
export type {
  DisputeEvidenceLineageRound,
  DisputeEvidencePartyRun,
  DisputeEvidenceRoundState,
  DisputeEvidenceRoundStateResult,
} from "./review-dispute-evidence-state.js";
export {
  REVIEW_DISPUTE_EVIDENCE_ROUND_CONTEXT_KEY,
  disputeEvidenceRoundComplete,
  parseDisputeEvidenceRoundState,
  readDisputeEvidenceRoundState,
} from "./review-dispute-evidence-state.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedInteger(value: unknown, max: number): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max ? value : null;
}

/**
 * Why an evidence dispatch needs no run at all.
 *
 *  - `party_redelivery` — this exact run id's collection is already recorded for
 *    every lineage the turn covers. A re-delivered claim (a resumed lease, a
 *    retried delivery) must converge on what it collected the first time rather
 *    than collect it again: a second invocation would duplicate the run's work
 *    and artifacts and then OVERWRITE the counts already on file, which is the
 *    evidence row 22 eventually records.
 *  - `round_complete` — both parties have answered for every lineage the turn
 *    covers and no run has spent the round yet. This is the deferred remainder
 *    of a multi-lineage round: only one row 22 is synthesized per completion, so
 *    the lineages the closing dispatch left behind keep a COMPLETE record and
 *    are re-selected under a different identity. Their answers exist; running a
 *    party again to re-derive them is the same overwrite by another route.
 *  - `party_admitted` — this party's collection is completed on the current
 *    round identity for every lineage the turn covers, but under a DIFFERENT
 *    derived run id: a fresh claim after a lost lease or a restart re-derives a
 *    new identity, and before issue #963 that new identity re-ran the party and
 *    overwrote the admitted result with the retry's. The admitted answer is
 *    reused instead — same counts, same record, no invocation — because the
 *    round identity (lineage, version, round) is what a party answers, not the
 *    claim that happened to carry it. The one exception is #840's escape hatch:
 *    an identity whose `attempt` was deliberately bumped past the recorded one
 *    is an explicit request for a fresh run, and it still runs.
 *
 * In all cases the recorded party runs stand exactly as they are — nothing is
 * re-keyed on the current identity — and only row 22, which is the runner's own
 * and is keyed through #840's ledger, may still fire.
 */
type DisputeEvidenceReplayKind = "party_redelivery" | "round_complete" | "party_admitted";

interface DisputeEvidenceReplay {
  kind: DisputeEvidenceReplayKind;
  /** This party's already-recorded counts, per lineage; the run's own answer. */
  attachments: Record<string, number>;
}

/**
 * Is this evidence delivery already on the round record?
 *
 * Read off the durable record only — run ids, versions, and which parties have
 * entries — so the answer never depends on an agent's account of what it did.
 * Anything less than "every covered lineage's record is usable AND already
 * answers this dispatch" returns null and the implementation runs: a record
 * collected against a version the lineage has left, or one a different run has
 * already spent, is a PREVIOUS round that must be replaced rather than replayed.
 */
function disputeEvidenceReplay(
  state: DisputeEvidenceRoundState,
  selected: readonly string[],
  context: ReviewDisputeContext,
  identity: DisputeSubTurnIdentity,
  party: EvidenceCollectionParty,
): DisputeEvidenceReplay | null {
  const attachments: Record<string, number> = Object.create(null) as Record<string, number>;
  let everyPartyRunOnFile = true;
  let everyPartyAdmitted = true;
  let everyRoundComplete = true;

  for (const lineageId of selected) {
    const entry = disputeEvidenceRoundEntry(state, lineageId);
    // Present and current: the stale-lineage guard has already run, so a lineage
    // the turn covers is in the block.
    const lineage = context.lineages[lineageId];
    if (entry === undefined || entry.version !== lineage.version) return null;
    if (entry.recordedRunId !== undefined && entry.recordedRunId !== identity.runId) return null;

    // A record this party has not COMPLETED is not an answer to replay: a run
    // that is still going, or one whose attempt stopped recoverably (#956),
    // admitted nothing and left the party exactly where a dispatcher found it.
    const own = disputeEvidencePartyState(entry, party) === "completed" ? entry.parties[party] : undefined;
    if (own === undefined) {
      everyPartyRunOnFile = false;
      everyPartyAdmitted = false;
    } else {
      // A record under a DIFFERENT run id is a different attempt's answer, not
      // this delivery's. It still counts toward a complete round — it is the
      // other lineage's deferred answer — and, since #963, it is still THIS
      // party's admitted answer for this round identity, so it is reused rather
      // than collected again. The one record that is not reused is one an
      // identity with a deliberately HIGHER attempt is dispatched over: bumping
      // the attempt is #840's explicit "do not read this as a replay" escape
      // hatch, and honoring the old answer would make a forced fresh run
      // impossible to ask for.
      if (own.runId !== identity.runId) {
        everyPartyRunOnFile = false;
        if (own.attempt < identity.attempt) everyPartyAdmitted = false;
      }
      attachments[lineageId] = own.attachments;
    }
    if (!disputeEvidenceRoundComplete(entry)) everyRoundComplete = false;
  }

  if (everyPartyRunOnFile) return { kind: "party_redelivery", attachments };
  if (everyRoundComplete) return { kind: "round_complete", attachments };
  if (everyPartyAdmitted) return { kind: "party_admitted", attachments };
  return null;
}

/**
 * A party run was invoked and delivered no admissible collection: record the
 * stop on the round (issue #963, #956's `recoverable` state).
 *
 * The marker is what lets a resumed phase tell "this party never ran" from
 * "this party ran and stopped" — the attempt that stopped and, in one bounded
 * token, why. It is an invocation fact, never an answer: the party stays owed a
 * run, the round stays incomplete, and no §6.1 counter moves. Two writes it
 * deliberately never makes:
 *
 *  - **it never downgrades an admitted answer.** A completed record for the
 *    current version is a result on file — the very thing a failed retry (a
 *    deliberately bumped attempt included) must not overwrite — so a lineage
 *    whose party already completed keeps its record byte for byte.
 *  - **it never turns a park into a different park.** The marker is
 *    bookkeeping, not a gate; a coordinate the record refuses leaves the round
 *    exactly as the run found it, which still resumes correctly — an absent
 *    party entry reads as `not_started`, and both read as "still owed".
 */
function recoverableEvidenceRound(
  round: DisputeEvidenceRoundState | null,
  selected: readonly string[],
  context: ReviewDisputeContext,
  identity: DisputeSubTurnIdentity,
  reason: DisputeSubTurnFailureKind,
): DisputeEvidenceRoundState | null {
  const party = identity.party;
  if (round === null || party === null) return round;
  let next = round;
  for (const lineageId of selected) {
    const lineage = Object.prototype.hasOwnProperty.call(context.lineages, lineageId)
      ? context.lineages[lineageId]
      : undefined;
    if (lineage === undefined) continue;
    const entry = disputeEvidenceRoundEntry(next, lineageId);
    const existing = entry?.parties[party];
    if (
      entry !== undefined
      && entry.version === lineage.version
      && existing !== undefined
      && disputeEvidenceRunStatus(existing) === "completed"
    ) {
      continue;
    }
    const written = markEvidencePartyRunRecoverable(
      next,
      {
        lineageId,
        version: lineage.version,
        round: DEFAULT_EVIDENCE_ROUND,
        party,
        attempt: identity.attempt,
        runId: identity.runId,
      },
      // Every DisputeSubTurnFailureKind is already a bounded lowercase token in
      // the record's own reason grammar; the record re-validates it anyway.
      reason,
    );
    if (!written.ok) return round;
    next = written.value;
  }
  return next;
}

// ---------------------------------------------------------------------------
// Identity and replay
// ---------------------------------------------------------------------------

/**
 * The highest `attempt` an identity may carry.
 *
 * Declared with the other §6.1 bounds (`review-dispute.ts`) and republished here,
 * where it has always been imported from: the persisted evidence-round record
 * (#956) bounds an attempt it reads back WITHOUT this adapter, and a second copy
 * of the number is a record that can disagree with the identities it describes.
 */
export { MAX_DISPUTE_SUB_TURN_ATTEMPT } from "./review-dispute.js";

export interface DisputeSubTurnIdentityInput {
  /**
   * The phase run's own id — the value the runner leased the task with, and the
   * one #838/#846 already treat as the retry key: a re-delivery of one claim
   * carries it unchanged, while a fresh claim after a lost lease carries a new
   * one and is legitimately a new attempt.
   */
  runId: string;
  /** The selected turn, exactly as the selector returned it. */
  turn: DispatchableDisputeTurn;
  /**
   * Which party's run this is. Required for the evidence turn — §7.1 dispatches
   * ONE run per party, and two runs sharing a run id would make the second
   * indistinguishable from a redelivery of the first — and refused for the other
   * two, which have a single actor.
   */
  party?: EvidenceCollectionParty;
  /**
   * Which attempt inside this claim, starting at 0.
   *
   * The escape hatch #840's key contract requires: a re-run that must NOT be read
   * as a replay — #847's row-20 malformed arbiter attempt retried inside the same
   * claim is the motivating case — bumps this, and the transition ledger sees a
   * different run. Leaving it at its default is the conservative direction: the
   * ledger recognizes the duplicate and nothing is applied twice.
   */
  attempt?: number;
}

/**
 * One sub-turn's deterministic coordinates.
 *
 * Everything here is derived — no clock, no counter, no random — so a caller that
 * re-derives the identity for a redelivered claim gets byte-identical values and
 * the transition ledger recognizes the duplicate without reading a word of agent
 * output.
 */
export interface DisputeSubTurnIdentity {
  kind: DisputeSubTurnKind;
  /** The §7.1 token, from {@link DISPUTE_SUB_TURN_TASK_TURNS}. */
  taskTurn: DisputeTaskTurn;
  party: EvidenceCollectionParty | null;
  attempt: number;
  /** The claim's run id this sub-turn belongs to. */
  claimRunId: string;
  /**
   * The run id every transition of this sub-turn is applied under — the value
   * that becomes `<lineageId>@<version>#<runId>` in #840's ledger. Bounded by
   * `MAX_RUN_ID_CHARS`, and distinct for every (claim, kind, party, attempt).
   */
  runId: string;
  /** Content-free digest of the whole tuple, for audit records and logs. */
  digest: string;
  /** The lineages the turn carries, sorted, exactly as the selector reported. */
  lineageIds: readonly string[];
}

export type DisputeSubTurnIdentityResult =
  | { ok: true; value: DisputeSubTurnIdentity }
  | { ok: false; failure: ReviewDisputeFailure };

function fail(reason: ReviewDisputeFailure["reason"], detail: string): { ok: false; failure: ReviewDisputeFailure } {
  return { ok: false, failure: { reason, detail } };
}

function digestOf(parts: readonly string[]): string {
  // The same short-digest form §2.2 mints lineage ids and #840 mints transition
  // keys in: twelve hex characters of sha256 over a delimited join, so two
  // different tuples cannot collide by concatenation. The delimiter is the one
  // byte no runner-minted id can contain, written as an ESCAPE so the source
  // stays text: a literal NUL in the file makes git treat this whole module as
  // binary, and a module that cannot be diffed cannot be reviewed.
  return createHash("sha256").update(parts.join("\0"), "utf8").digest("hex").slice(0, 12);
}

/**
 * Derive one sub-turn's identity, or say why the request could not have one.
 *
 * Fail-closed like every other surface in this protocol: an identity that cannot
 * be derived is a refusal a caller must act on, never a fallback id. A random or
 * time-based fallback would be worse than no dispatch at all — it would make
 * every redelivery look like a fresh debate, and the ledger that stops a
 * transition being applied twice keys on exactly this value.
 */
export function disputeSubTurnIdentity(input: DisputeSubTurnIdentityInput): DisputeSubTurnIdentityResult {
  const { turn } = input;
  // Defense in depth against a value that reached this build from a
  // differently-versioned one: the type already restricts the input, and the
  // predicate is #950's own answer to "does this turn await a dispatcher".
  if (!disputeTurnAwaitsDispatcher(turn) || !DISPUTE_SUB_TURN_KINDS.includes(turn.kind)) {
    return fail("unknown-enum", `turn.kind:${String((turn as PendingDisputeTurn).kind)}`);
  }
  const runId = input.runId;
  if (typeof runId !== "string" || runId.trim() === "") return fail("invalid-type", "run.runId:empty");
  if (runId.length > MAX_RUN_ID_CHARS) return fail("field-too-long", `run.runId:${runId.length}`);

  const attempt = input.attempt ?? 0;
  if (!Number.isInteger(attempt) || attempt < 0 || attempt > MAX_DISPUTE_SUB_TURN_ATTEMPT) {
    return fail("invalid-type", `run.attempt:${String(attempt)}`);
  }

  const partyRequired = turn.kind === "evidence_collection";
  if (partyRequired && input.party === undefined) return fail("missing-field", "run.party");
  if (!partyRequired && input.party !== undefined) return fail("unknown-field", `run.party:${turn.kind}`);
  if (input.party !== undefined && !EVIDENCE_COLLECTION_PARTIES.includes(input.party)) {
    return fail("unknown-enum", `run.party:${String(input.party)}`);
  }

  // A turn that names no lineage names no debate to run. §7.1 rule 2 only selects
  // a turn BECAUSE a lineage is in its state, so an empty set is a contradiction
  // rather than a no-op run.
  const lineageIds = [...turn.lineageIds];
  if (lineageIds.length === 0) return fail("missing-field", `turn.lineageIds:${turn.kind}`);

  const party = input.party ?? null;
  const digest = digestOf([turn.kind, party ?? "", String(attempt), runId, ...lineageIds]);
  // Readable first, hashed only when it would not fit: an operator reading a run
  // id in a log can see which turn it belonged to without resolving a digest,
  // and the digest suffix keeps the bounded form unique when the claim's own id
  // is already close to the ceiling.
  const composed = `${runId}~${DISPUTE_SUB_TURN_TASK_TURNS[turn.kind]}${party === null ? "" : `.${party}`}.${attempt}`;
  const derivedRunId =
    composed.length <= MAX_RUN_ID_CHARS
      ? composed
      : `${composed.slice(0, MAX_RUN_ID_CHARS - digest.length - 1)}#${digest}`;

  return {
    ok: true,
    value: {
      kind: turn.kind,
      taskTurn: DISPUTE_SUB_TURN_TASK_TURNS[turn.kind],
      party,
      attempt,
      claimRunId: runId,
      runId: derivedRunId,
      digest,
      lineageIds,
    },
  };
}

/**
 * The per-lineage replay key of one sub-turn, in #840's own form.
 *
 * Exported so a sub-turn implementation can name the key it is about to
 * transition under — an arbitration bundle manifest, a reconsideration record's
 * `runKey` — without re-deriving the string and drifting from the ledger.
 */
export function disputeSubTurnRunKey(identity: DisputeSubTurnIdentity, lineageId: string, version: number): string {
  return transitionKey(lineageId, version, identity.runId);
}

/**
 * Has this exact sub-turn already transitioned this lineage?
 *
 * Read off #840's own `appliedTransitions` ledger — a list of
 * `transitionDigest(lineageId, version, runId)` values — so the answer comes from
 * the durable record of what was applied, never from an agent's account of what
 * it did. That is the whole of "duplicate delivery can be recognized without
 * relying on agent prose": the sub-turn's run id is derived, the ledger is
 * keyed on it, and a redelivery of the same attempt hashes to a digest already
 * on file.
 *
 * Every version from 1 to the lineage's current one is checked, because the row
 * a redelivery re-applies may have MINTED the version the lineage now carries
 * (row 11), and its ledger entry is keyed on the version it addressed.
 */
export function disputeSubTurnAlreadyApplied(
  lineage: PersistedLineage,
  identity: DisputeSubTurnIdentity,
): boolean {
  const ledger = lineage.appliedTransitions ?? [];
  if (ledger.length === 0) return false;
  for (let version = 1; version <= lineage.version; version += 1) {
    if (ledger.includes(transitionDigest(lineage.lineageId, version, identity.runId))) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// The sub-turn implementation interface
// ---------------------------------------------------------------------------

/**
 * Why a sub-turn ended without a decision.
 *
 * Deliberately a NORMALIZATION rather than a union of the invocation modules'
 * own vocabularies (#838's `ReconsiderationFailureKind`, #846's
 * `ArbitrationFailureKind`): what this adapter does with a failure is identical
 * for all of them — commit nothing, park for a human, record the token — so the
 * distinctions those vocabularies draw belong in the implementation's own bounded
 * summary, not in the runner's routing.
 *
 * None of these is a transition. §7 has rows for the failures it defines (row 19
 * for an unavailable arbiter, rows 20/21 for malformed verdicts), and a sub-turn
 * that can reach one returns it as a `completed` decision through #847 instead of
 * failing here. Everything left is a run that did not happen.
 */
export const DISPUTE_SUB_TURN_FAILURE_KINDS = [
  /** The agent exceeded its deadline; nothing was returned to admit. */
  "timeout",
  /** §12: output that could not be admitted as the record the turn required. */
  "malformed_output",
  /** No execution profile could be resolved for this turn's agent (§8.3). */
  "profile_unavailable",
  /** The block moved under the run: a lineage left the state the turn selected. */
  "stale_lineage",
  /** The agent never ran, or exited nonzero, or its artifacts could not be read. */
  "invocation_failed",
  /** The §10.2 record could not be preserved locally. */
  "artifact_failed",
  /** The §10.1 block handed to this adapter is not one this session could hold. */
  "invalid_context",
  /** The identity or the request contradicts the turn it claims to serve. */
  "invalid_identity",
  /** No implementation is registered for the selected turn. */
  "no_implementation",
  /** The CURRENT block refused every decision the sub-turn returned (§12). */
  "transition_refused",
  /** The implementation threw. Reported as a name, never as a message. */
  "internal_error",
] as const;
export type DisputeSubTurnFailureKind = (typeof DISPUTE_SUB_TURN_FAILURE_KINDS)[number];

export interface DisputeSubTurnFailure {
  kind: DisputeSubTurnFailureKind;
  /** Content-free locator: a field path, a count, an exit code. Never prose. */
  detail: string | null;
  /** The §12 failure behind a `malformed_output`/`transition_refused`, verbatim. */
  protocol?: ReviewDisputeFailure;
}

/**
 * #838's invocation failures, in this adapter's vocabulary.
 *
 * Exhaustive by type: the `Record` must name every `ReconsiderationFailureKind`,
 * so a token added upstream is a compile error here rather than a failure that
 * silently normalizes to nothing. The groupings are the ones routing cares about
 * — could the run have happened (`profile_unavailable`), did the block move under
 * it (`stale_lineage`), did the agent produce something inadmissible
 * (`malformed_output`), or did the machinery around it fail.
 *
 * `agent-failed` is the one token that is not self-describing: it covers a
 * nonzero exit AND a subprocess that never completed, which is why
 * {@link normalizeReconsiderationFailure} takes the timeout fact separately
 * instead of guessing it from a detail string.
 */
export const RECONSIDERATION_FAILURE_NORMALIZATION: Readonly<
  Record<ReconsiderationFailureKind, DisputeSubTurnFailureKind>
> = {
  "not-pending": "stale_lineage",
  "lineage-not-disputed": "stale_lineage",
  "reconsideration-slot-consumed": "stale_lineage",
  "missing-dispute-artifact": "invocation_failed",
  "malformed-dispute-artifact": "invocation_failed",
  "unsupported-agent": "profile_unavailable",
  // The build in front of us does not accept the argv this contract pins, so the
  // invocation the profile named is not one this host can make: that is the same
  // operational answer as "no profile", not a turn that ran and failed, and it
  // must never be reported as a reviewer's silence (issue #1085).
  "unsupported-capability": "profile_unavailable",
  "agent-failed": "invocation_failed",
  // The run produced no admissible answer where its argv said to. Grouped with
  // the empty and malformed answers rather than with the machinery failures: a
  // reviewer that finished and said nothing usable is a §12 outcome, and §12's
  // effect — no protocol state changes — is what both need.
  "missing-output": "malformed_output",
  "oversized-output": "malformed_output",
  // Not the agent's fault and not the agent's answer: the runner's own
  // output-file handshake found a file that predates this run, so nothing about
  // this invocation can be believed. An invocation fault, and never a timeout —
  // the check happens before the process is spawned.
  "stale-output": "invocation_failed",
  "empty-output": "malformed_output",
  "malformed-response": "malformed_output",
  "artifact-write-failed": "artifact_failed",
  "unsafe-artifact-dir": "artifact_failed",
  "unsafe-artifact-path": "artifact_failed",
};

/** #846's invocation failures, in this adapter's vocabulary. Exhaustive by type. */
export const ARBITRATION_FAILURE_NORMALIZATION: Readonly<
  Record<ArbitrationFailureKind, DisputeSubTurnFailureKind>
> = {
  // #839 resolved a profile for a DIFFERENT lineage: the run's coordinates and
  // its selection disagree, which is an identity fault, not a debate fact.
  "profile-lineage-mismatch": "invalid_identity",
  "not-arbitrable": "stale_lineage",
  "lineage-not-arbitration-pending": "stale_lineage",
  "arbitration-passes-exhausted": "stale_lineage",
  "missing-dispute-artifact": "invocation_failed",
  "malformed-dispute-artifact": "invocation_failed",
  "missing-reconsideration-artifact": "invocation_failed",
  "malformed-reconsideration-artifact": "invocation_failed",
  "unresolvable-evidence-attachment": "invocation_failed",
  "agent-failed": "invocation_failed",
  "empty-output": "malformed_output",
  "malformed-response": "malformed_output",
  "artifact-write-failed": "artifact_failed",
  "unsafe-artifact-dir": "artifact_failed",
  "unsafe-artifact-path": "artifact_failed",
};

/**
 * The §12 failure an invocation carried, preserved verbatim.
 *
 * Nothing upstream is translated away: the normalized kind is what this adapter
 * routes on, and the original protocol failure — when there was one — still
 * travels for the audit record.
 */
function normalized(
  kind: DisputeSubTurnFailureKind,
  detail: string | null,
  protocol: ReviewDisputeFailure | undefined,
  timedOut: boolean,
): DisputeSubTurnFailure {
  return {
    // A deadline the runner enforced is a different operational fact from an
    // agent that ran and refused, and only the caller knows which happened.
    kind: timedOut && kind === "invocation_failed" ? "timeout" : kind,
    detail,
    ...(protocol === undefined ? {} : { protocol }),
  };
}

export function normalizeReconsiderationFailure(
  failure: ReconsiderationInvocationFailure,
  options: { timedOut?: boolean } = {},
): DisputeSubTurnFailure {
  return normalized(
    RECONSIDERATION_FAILURE_NORMALIZATION[failure.kind],
    failure.detail,
    failure.protocol,
    options.timedOut === true,
  );
}

export function normalizeArbitrationFailure(
  failure: ArbitrationInvocationFailure,
  options: { timedOut?: boolean } = {},
): DisputeSubTurnFailure {
  return normalized(
    ARBITRATION_FAILURE_NORMALIZATION[failure.kind],
    failure.detail,
    failure.protocol,
    options.timedOut === true,
  );
}

/** What an implementation is handed. Values only — no store, no key, no CAS. */
export interface DisputeSubTurnRequest {
  /** The selected turn, exactly as the selector returned it. */
  turn: DispatchableDisputeTurn;
  /** This run's deterministic coordinates; the source of every replay key. */
  identity: DisputeSubTurnIdentity;
  /** The task's CURRENT §10.1 block, already validated by the adapter. */
  context: ReviewDisputeContext;
  /** The session's resolved §6.1 limits. */
  limits: ReviewDisputeLimits;
}

/**
 * What an implementation returns.
 *
 * `completed` carries a typed decision and nothing else that could move state:
 * the adapter applies it, so an implementation cannot half-apply a row, spend a
 * counter, or write a §10.1 flag of its own.
 *
 * `collected` is the evidence turn's only delivered outcome, and the two are
 * mutually exclusive by turn: §7.1's evidence-collection runs "carry no
 * dispositions, change no lineage state themselves", so an evidence
 * implementation has no decision to return, and an implementation of either
 * other turn has no round to collect. Each returning the other's shape is a §12
 * malformed outcome rather than a shape this adapter reinterprets.
 *
 * No variant carries completion TEXT. A `PhaseHandlerResult.message` is not an
 * internal field: on a `blocked` completion the review phase publishes it to
 * GitHub as the handoff comment's `Reason:`, so a message an implementation
 * chose would be a publication channel for exactly the rebuttal and rationale
 * prose §11 forbids — and the likeliest value for an agent-backed runner to put
 * there is its raw response. Every message this adapter emits is therefore
 * generated here from the bounded tokens the summary already publishes
 * (turn label, failure kind, counts); a `message` on a returned value is
 * ignored rather than refused, so a runner compiled against an older shape still
 * runs, it just cannot speak.
 *
 * `toolPolicy` is the one field a run may state about ITSELF that this adapter
 * republishes (issue #1085 review, P2). It is the execution posture the run
 * enforced, verbatim, and it reaches the `review.dispute.subturn` event beside
 * the lineage ids that event already carries — which is what makes the posture
 * a PER-LINEAGE fact in event history rather than a single-valued task field
 * that the next reviewer run overwrites. §17.6's D2 row requires a lineage
 * decided under `read-bounded` to stay distinguishable forever, and a task that
 * debates two findings takes two reviewer runs; without this, the earlier
 * lineage's posture would be readable only from the run directory an operator
 * reading `dispute status` does not have. Optional and never defaulted: a run
 * that resolved no profile enforced no posture and states none, and this adapter
 * does not supply the stricter literal on its behalf.
 */
export type DisputeSubTurnResult =
  | {
      status: "completed";
      /** The already-approved decision, in #840's closed union. */
      decision: DisputeTransitionDecision;
      /** Defaults to {@link DISPUTE_SUB_TURN_DEFAULT_ACTORS}. */
      actor?: DisputeActorRole;
      /** The posture this run ENFORCED. See {@link DisputeSubTurnResult}. */
      toolPolicy?: string;
      /** §10.2 bytes for the CALLER to write; this module writes nothing. */
      artifacts?: readonly DisputeArtifact[];
      /** Bounded literals for task context, merged under the reserved key. */
      context?: Record<string, unknown>;
    }
  | {
      status: "collected";
      /**
       * How many §3.3 attachments this party's run admitted, per lineage.
       *
       * Counts, not references: what the round's OUTPUT is — the resolved
       * excerpts an arbitration bundle re-presents — travels as §10.2 artifacts
       * for the caller to write, the way #846 already hands a bundle back. What
       * the adapter needs is only the fact of the run and the size of its
       * contribution, because that is all row 22 records.
       *
       * A lineage the turn covers and this map omits is a run that admitted none
       * for it, which §7.1 explicitly allows; a lineage the turn does NOT cover
       * is a §12 malformed outcome.
       */
      attachments: Readonly<Record<string, number>>;
      /**
       * The admitted §3.3 references themselves, per lineage (issue #956).
       *
       * Optional, and the round is complete and correct without it: `attachments`
       * is what row 22 records and has been since #955. What this adds is the
       * ability to RE-PRESENT the round — §7.1 collects evidence so the arbiter
       * sees it on the re-presented case, and a count cannot be shown to an
       * arbiter. A lineage named here must also be one the turn covers, and its
       * list must have exactly as many entries as its count: the two halves of
       * one answer may not disagree.
       *
       * References travel as values and are persisted in their bounded form
       * ({@link PersistedEvidenceRef}) — an `issue_quote` as a digest and a
       * length, never its span. The excerpt itself belongs in the §10.2 artifact
       * this run also returns.
       */
      references?: Readonly<Record<string, readonly EvidenceRef[]>>;
      /**
       * §7.1: how many references this run returned that did not resolve and
       * were dropped, per lineage. A log entry, never a run failure.
       */
      dropped?: Readonly<Record<string, number>>;
      /** §10.2 bytes for the CALLER to write; this module writes nothing. */
      artifacts?: readonly DisputeArtifact[];
      context?: Record<string, unknown>;
    }
  | {
      status: "failed";
      failure: DisputeSubTurnFailure;
      /** The posture this run ENFORCED. See {@link DisputeSubTurnResult}. */
      toolPolicy?: string;
      /** A failed run's transcript is still worth preserving (§10.2). */
      artifacts?: readonly DisputeArtifact[];
      context?: Record<string, unknown>;
    }
  | {
      status: "delayed";
      /** Why the run could not proceed NOW — a quota window, typically. */
      failure: DisputeSubTurnFailure;
      /** The posture this run ENFORCED. See {@link DisputeSubTurnResult}. */
      toolPolicy?: string;
      retryAfterMs?: number;
      category?: AgentFailureKind;
      /** Defaults to `agent_failure`, the reading every sub-turn run implies. */
      delayKind?: PhaseDelayKind;
      artifacts?: readonly DisputeArtifact[];
      context?: Record<string, unknown>;
    };

/** One sub-turn implementation. Async so a real one may spawn an agent. */
export type DisputeSubTurnRunner = (request: DisputeSubTurnRequest) => Promise<DisputeSubTurnResult> | DisputeSubTurnResult;

/** The dispatch table a caller assembles once and dispatches from. */
export type DisputeSubTurnRegistry = Partial<Record<DisputeSubTurnKind, DisputeSubTurnRunner>>;

// ---------------------------------------------------------------------------
// Adapter output
// ---------------------------------------------------------------------------

/** The task-context key the sub-turn's bounded summary lives under. */
export const REVIEW_DISPUTE_SUB_TURN_CONTEXT_KEY = "reviewDisputeSubTurn";

/**
 * The one task event a dispatched sub-turn appends.
 *
 * A TASK event, in the same namespace as #840's `review.dispute.transition` — not
 * a §10.3 audit event, whose `dispute.<subject>.<action>` vocabulary is closed and
 * is emitted by the transition itself. It exists because the outcomes that emit
 * NO transition (every failure and every delay) would otherwise leave no audit
 * trace at all: a task parked for a human with an unchanged block and no event is
 * indistinguishable from a task nothing ever tried to run.
 */
export const REVIEW_DISPUTE_SUB_TURN_EVENT = "review.dispute.subturn";

/** What the adapter did, as one token. */
export const DISPUTE_SUB_TURN_DISPOSITIONS = [
  /** A transition was computed and travels on the result for the runner to commit. */
  "applied",
  /** The delivery was already on file: the same routing, nothing to write. */
  "replayed",
  /**
   * §7.1: one party's evidence run is on file and the round is not complete, so
   * row 22 has not fired. Nothing moved — deliberately: the lineage stays in
   * `evidence_requested`, which is the only state the OTHER party's run can be
   * dispatched against, and the completion requeues the review phase for that
   * remaining run (issue #964).
   */
  "collected",
  /** §9: nothing moved and the task goes to a human. */
  "parked",
  /** The run may be retried later; nothing moved. */
  "delayed",
] as const;
export type DisputeSubTurnDisposition = (typeof DISPUTE_SUB_TURN_DISPOSITIONS)[number];

export interface DisputeSubTurnCompletion {
  /**
   * Exactly what the phase handler returns to `runNextPhase`. A `success` here
   * carries the `disputeTransition` the runner folds into its own
   * `completePhaseWithEffects` transaction, so the §10.1 block, the §10.3 audit
   * event, the §11 effects, and the completion commit together or not at all.
   */
  result: PhaseHandlerResult;
  disposition: DisputeSubTurnDisposition;
  identity: DisputeSubTurnIdentity;
  /** The applied transition, or null when nothing moved. */
  transition: DisputeTransitionApplication | null;
  /** §10.2 bytes for the caller to write under its own run directory. */
  artifacts: readonly DisputeArtifact[];
  failure: DisputeSubTurnFailure | null;
  /**
   * The evidence round as it stands after this run, or null when the turn was
   * not an evidence one. Already folded into `result.context` under
   * {@link REVIEW_DISPUTE_EVIDENCE_ROUND_CONTEXT_KEY}, so a caller that commits
   * the completion has nothing else to persist; it travels here as well because
   * the caller — not this module — decides what the NEXT dispatch is handed.
   */
  evidenceRound: DisputeEvidenceRoundState | null;
}

export interface DisputeSubTurnDispatchInput {
  /** The selected turn, exactly as the selector returned it. */
  turn: DispatchableDisputeTurn;
  /** The task's CURRENT §10.1 block — the compare-and-set baseline. */
  context: ReviewDisputeContext;
  /** {@link disputeSubTurnIdentity}'s value for this run. */
  identity: DisputeSubTurnIdentity;
  /**
   * The implementation, or the whole table. A table with no entry for the
   * selected turn fails closed as `no_implementation` — which is the state this
   * codebase is actually in today, and the reason nothing dispatches yet.
   */
  runner?: DisputeSubTurnRunner;
  registry?: DisputeSubTurnRegistry;
  limits?: ReviewDisputeLimits;
  /**
   * The in-flight evidence round, as the task carries it
   * ({@link readDisputeEvidenceRoundState}). Absent is an empty round, which is
   * the conservative direction: a first party's run closes nothing, so a caller
   * that forgets to hand the record over collects a party again rather than
   * spending the round on one side of the argument. Ignored for the turns that
   * have no round.
   */
  evidenceRound?: DisputeEvidenceRoundState;
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

function turnLabel(identity: DisputeSubTurnIdentity): string {
  return identity.party === null ? identity.taskTurn : `${identity.taskTurn} (${identity.party})`;
}

/**
 * The bounded summary both the context patch and the audit event carry.
 *
 * Literals, counters, ids, and bounded reason tokens only (§10.3). Artifact NAMES
 * are included and artifact bytes are not: the names are runner-minted and the
 * directory holding them is the caller's, so nothing here locates a local path.
 */
function summarize(
  identity: DisputeSubTurnIdentity,
  disposition: DisputeSubTurnDisposition,
  transition: DisputeTransitionApplication | null,
  failure: DisputeSubTurnFailure | null,
  artifacts: readonly DisputeArtifact[],
  evidence?: Record<string, unknown>,
  toolPolicy?: string,
): Record<string, unknown> {
  return {
    turn: identity.kind,
    taskTurn: identity.taskTurn,
    ...(identity.party === null ? {} : { party: identity.party }),
    attempt: identity.attempt,
    runId: identity.runId,
    digest: identity.digest,
    lineageIds: identity.lineageIds,
    disposition,
    // The posture the run enforced, next to the lineage ids it enforced it over
    // (§17.6 D2). Omitted — never defaulted — when the run stated none, so an
    // event from before this field, and an event for a run that resolved no
    // profile, are both "no posture on record" rather than `no-tools`.
    ...(toolPolicy === undefined ? {} : { toolPolicy }),
    ...(transition === null
      ? {}
      : {
          applied: transition.applied.length,
          refused: transition.refused.length,
          replayed: transition.replayed,
          routing: {
            rule: transition.routing.rule,
            outcome: transition.routing.outcome,
            turn: transition.routing.turn,
            readyForHuman: transition.routing.readyForHuman,
          },
        }),
    ...(failure === null
      ? {}
      : {
          failure: failure.kind,
          failureDetail: failure.detail,
          ...(failure.protocol === undefined
            ? {}
            : { protocolReason: failure.protocol.reason, protocolDetail: failure.protocol.detail }),
        }),
    ...(artifacts.length === 0 ? {} : { artifacts: artifacts.map((artifact) => artifact.name) }),
    // Counts and lineage ids only — never a §3.3 reference, a path, or an
    // excerpt: what the round collected is §10.2 artifact bytes, and those do not
    // reach a task event.
    ...(evidence === undefined ? {} : { evidenceRound: evidence }),
  };
}

function auditEvent(summary: Record<string, unknown>): PhaseHandlerEvent {
  return { type: REVIEW_DISPUTE_SUB_TURN_EVENT, data: summary };
}

/**
 * The task-context keys this protocol owns, which an implementation's own
 * `context` may not write.
 *
 * The §10.1 block is the load-bearing one. Every non-transition path here
 * promises that the debate state is UNCHANGED — a park keeps the lineages where
 * they stopped, a delay writes nothing, a first party's evidence run moves no
 * lineage — and none of them carries a `disputeTransition` for the runner to
 * rebuild the block from. So a `reviewDispute` key arriving on an
 * implementation's context patch would be persisted verbatim over the block this
 * adapter validated, which is the one write those paths must not make. The
 * round record and the sub-turn summary are reserved for the same reason in the
 * smaller: both describe what THIS dispatch did, and an implementation that
 * hand-built either would let the context and the event describing it disagree.
 */
const RESERVED_DISPUTE_CONTEXT_KEYS: readonly string[] = [
  REVIEW_DISPUTE_CONTEXT_KEY,
  REVIEW_DISPUTE_SUB_TURN_CONTEXT_KEY,
  REVIEW_DISPUTE_EVIDENCE_ROUND_CONTEXT_KEY,
];

/**
 * Merge the implementation's own context under the reserved key.
 *
 * The reserved keys always win, for the same reason #840's block does in
 * `disputeContextPatch` — dropped rather than overwritten where this dispatch
 * has nothing of its own to write, because "the caller's value loses" and "the
 * caller's value is persisted whenever we are silent" are different guarantees
 * and only the first is the one the non-transition paths promise.
 */
function contextPatch(
  summary: Record<string, unknown>,
  callerContext: Record<string, unknown> | undefined,
  evidenceRound: DisputeEvidenceRoundState | null,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(callerContext ?? {})) {
    if (RESERVED_DISPUTE_CONTEXT_KEYS.includes(key)) continue;
    patch[key] = value;
  }
  patch[REVIEW_DISPUTE_SUB_TURN_CONTEXT_KEY] = summary;
  // Rewritten unchanged on the paths that collected nothing, so a park or a
  // delay cannot lose the party run that already answered.
  if (evidenceRound !== null) patch[REVIEW_DISPUTE_EVIDENCE_ROUND_CONTEXT_KEY] = evidenceRound;
  return patch;
}

function parked(
  identity: DisputeSubTurnIdentity,
  failure: DisputeSubTurnFailure,
  artifacts: readonly DisputeArtifact[] = [],
  callerContext?: Record<string, unknown>,
  evidenceRound: DisputeEvidenceRoundState | null = null,
  // Only the parks that follow a DELIVERED result can name one; the parks taken
  // before the runner ran leave it undefined, which is the truth about them.
  toolPolicy?: string,
): DisputeSubTurnCompletion {
  const summary = summarize(identity, "parked", null, failure, artifacts, undefined, toolPolicy);
  return {
    // §9's park, expressed the way every other handler expresses it: `blocked`
    // becomes `ready_for_human` on the phase that ran (transitions.ts), which is
    // where an operator resumes. No `disputeTransition` travels, so the runner
    // commits the completion and NOTHING of the protocol state — the lineages
    // keep their persisted states, no counter moves, and the debate resumes
    // exactly where it stopped.
    result: {
      result: "blocked",
      context: contextPatch(summary, callerContext, evidenceRound),
      // Generated here, from bounded tokens only. A `blocked` review completion
      // publishes this text as the handoff comment's `Reason:`, so nothing an
      // implementation returned may reach it (§11).
      message:
        `Review dispute ${turnLabel(identity)} sub-turn did not complete (${failure.kind}); `
        + `the debate state is unchanged and the task is parked for a human.`,
      extraEvents: [auditEvent(summary)],
    },
    disposition: "parked",
    identity,
    transition: null,
    artifacts,
    failure,
    evidenceRound,
  };
}

/** The delivered/undelivered statuses a result may carry. */
const DISPUTE_SUB_TURN_RESULT_STATUSES = ["completed", "collected", "failed", "delayed"] as const;

/**
 * A {@link DisputeArtifact} name is a BASE name, and this is the check that a
 * returned one is.
 *
 * The directory these bytes are written under is the caller's, so a writer
 * resolving the obvious `join(runDir, artifact.name)` would follow a name
 * carrying a separator, a traversal segment, or an absolute prefix straight out
 * of that directory. The same name is what the bounded summary publishes, so a
 * name that could not have been minted for this run is refused here — before it
 * reaches either surface — rather than left for each writer to re-check.
 */
function isArtifactBaseName(name: string): boolean {
  if (name === "" || name === "." || name === "..") return false;
  if (name.includes("/") || name.includes("\\")) return false;
  // A Windows drive-relative name (`C:record.json`) and an alternate-data-stream
  // name carry no separator at all, and a NUL truncates a path at the syscall
  // boundary — so what the writer opens would not be the name that was audited.
  if (name.includes(":") || name.includes("\0")) return false;
  return true;
}

/**
 * How deep a returned context patch may nest.
 *
 * The walk below recurses, and so does the `JSON.stringify` that persists the
 * merged context: a structure nested past the engine's own limit makes THAT call
 * throw, which is the same skipped-park fault a cycle causes. A bounded §10.3
 * patch has no reason to nest anywhere near this far, so the refusal happens at
 * a depth both this walk and the serializer can still reach.
 */
const MAX_CONTEXT_PATCH_DEPTH = 32;

/**
 * Longest execution-posture literal a returned result may carry.
 *
 * The same bound the per-lineage provenance record uses, for the same reason:
 * the value is republished verbatim rather than mapped onto a known literal, so
 * the length is what keeps an unrecognised one out of the §10.3 event budget.
 */
const MAX_TOOL_POLICY_CHARS = 64;

/**
 * Admit a value an implementation asked to have persisted, or name what makes it
 * unserializable.
 *
 * `contextPatch` copies these values VERBATIM into the completion, and the task
 * store writes the merged context by `JSON.stringify`ing it. A value that call
 * cannot serialize — a cycle, a bigint, a structure nested past the recursion
 * limit, a property whose getter throws — would throw at PERSISTENCE time, long
 * after this adapter reported a controlled park: the claimed task is then left to
 * lease recovery, and the §12 outcome the park exists to record becomes the one
 * outcome with no record at all. So only JSON values are admitted, which also
 * means the context read back is the context the implementation returned — a
 * `Map`, a `Date`, or a class instance survives `JSON.stringify` as something
 * else entirely, which is a silent rewrite rather than a refusal.
 *
 * `undefined` is admitted wherever the serializer itself drops it: an optional
 * field left unset is not a malformed patch, and the value that reaches the store
 * is the same either way.
 */
function contextValueProblem(value: unknown): string | null {
  // Ancestors only, not every node seen: a value referenced twice from different
  // branches serializes fine, and it is a CYCLE — an ancestor reached again —
  // that throws.
  const ancestors = new Set<object>();
  const walk = (node: unknown, depth: number): string | null => {
    if (node === null || node === undefined) return null;
    switch (typeof node) {
      case "string":
      case "boolean":
        return null;
      case "number":
        // `NaN` and the infinities serialize as `null`, so the number read back
        // is not the number written.
        return Number.isFinite(node) ? null : "non-finite";
      case "object":
        break;
      default:
        // `bigint` throws outright; a function or a symbol is dropped silently.
        return typeof node;
    }
    if (depth > MAX_CONTEXT_PATCH_DEPTH) return "too-deep";
    const object = node as object;
    if (ancestors.has(object)) return "cyclic";
    ancestors.add(object);
    let problem: string | null = null;
    if (Array.isArray(object)) {
      for (const entry of object) {
        problem = walk(entry, depth + 1);
        if (problem !== null) break;
      }
    } else if (Object.getPrototypeOf(object) !== null && Object.getPrototypeOf(object) !== Object.prototype) {
      problem = "non-plain-object";
    } else {
      for (const entry of Object.values(object as Record<string, unknown>)) {
        problem = walk(entry, depth + 1);
        if (problem !== null) break;
      }
    }
    ancestors.delete(object);
    return problem;
  };
  try {
    return walk(value, 0);
  } catch {
    // The walk reads exactly the properties the serializer would, so a read that
    // throws here — a throwing getter, a proxy trap — is a write that throws
    // there. Nothing of the error travels; it is the implementation's value.
    return "unreadable";
  }
}

/**
 * Admit a returned value as a {@link DisputeSubTurnResult}, or name the field
 * that made it inadmissible.
 *
 * The type is a promise the IMPLEMENTATION makes; this is the check that it kept
 * it. A registered runner is code this module does not own — plausibly compiled
 * against another version of this contract, plausibly returning a half-built
 * value on a path its own author did not expect — and §12 says output that
 * cannot be admitted as the record the turn required is a refusal. Reading a
 * field off it first is how a `{ status: "completed" }` with no decision becomes
 * a thrown `TypeError` instead: the throw escapes this adapter's own audit event
 * and its controlled park, so the very outcome §12 defines would be the one
 * outcome that leaves no trace.
 *
 * Only fields this adapter itself goes on to READ are checked, and only for the
 * shape it reads them in — a bounded, content-free check that never inspects a
 * decision's payload beyond its kind, because what a decision MEANS is #840's
 * question and it already refuses what it cannot apply.
 */
function subTurnResultProblem(value: unknown): string | null {
  if (!isRecord(value)) return `result:${value === null ? "null" : typeof value}`;

  const status = value.status;
  const known: readonly string[] = DISPUTE_SUB_TURN_RESULT_STATUSES;
  if (typeof status !== "string" || !known.includes(status)) {
    return `result.status:${typeof status === "string" ? status : typeof status}`;
  }
  // No check for a `message`: the field is not part of the result shape and this
  // adapter never reads one, so a value carrying it is admitted and the text is
  // dropped rather than published (see {@link DisputeSubTurnResult}).
  if (value.context !== undefined) {
    if (!isRecord(value.context)) return "result.context";
    const problem = contextValueProblem(value.context);
    if (problem !== null) return `result.context:${problem}`;
  }
  // Republished verbatim into the §10.3 event, so it is checked here for the one
  // property that surface requires: a bounded, non-empty string. Deliberately NOT
  // checked against today's closed set — a posture this build does not know is
  // still what the run says it enforced, and mapping it onto a known literal is
  // how a lineage would come to read as a posture nothing took (issue #1085).
  if (value.toolPolicy !== undefined) {
    const policy = value.toolPolicy;
    if (typeof policy !== "string" || policy.trim() === "" || policy.length > MAX_TOOL_POLICY_CHARS) {
      return "result.toolPolicy";
    }
  }
  if (value.artifacts !== undefined) {
    if (!Array.isArray(value.artifacts)) return "result.artifacts";
    // Every artifact's NAME reaches the bounded summary, so an entry that is not
    // one would throw there — after the completion had already been built.
    const artifacts = value.artifacts as readonly unknown[];
    for (let index = 0; index < artifacts.length; index += 1) {
      const artifact = artifacts[index];
      if (!isRecord(artifact) || typeof artifact.name !== "string" || typeof artifact.content !== "string") {
        return `result.artifacts[${index}]`;
      }
      // Content-free locator: the index and the rule it broke, never the name —
      // an escaping name is precisely the value that must not be republished.
      if (!isArtifactBaseName(artifact.name)) return `result.artifacts[${index}].name`;
    }
  }

  if (status === "completed") {
    const decision = value.decision;
    if (!isRecord(decision) || typeof decision.kind !== "string") return "result.decision";
    // The actor is recorded on every row the decision applies (§10.3), so a
    // token outside the closed set would be persisted as a role that does not
    // exist rather than refused.
    if (value.actor !== undefined && !DISPUTE_ACTOR_ROLES.includes(value.actor as DisputeActorRole)) {
      return `result.actor:${typeof value.actor === "string" ? value.actor : typeof value.actor}`;
    }
    return null;
  }

  if (status === "collected") {
    return isRecord(value.attachments) ? null : "result.attachments";
  }

  // `failed` and `delayed`: both carry the failure this adapter routes and
  // records on, and a delay additionally carries the runner's retry hint.
  const failure = value.failure;
  if (!isRecord(failure)) return "result.failure";
  if (
    typeof failure.kind !== "string"
    || !DISPUTE_SUB_TURN_FAILURE_KINDS.includes(failure.kind as DisputeSubTurnFailureKind)
  ) {
    return `result.failure.kind:${typeof failure.kind === "string" ? failure.kind : typeof failure.kind}`;
  }
  if (failure.detail !== null && typeof failure.detail !== "string") return "result.failure.detail";
  // Both protocol fields are copied verbatim into the task context and the audit
  // event, so checking only that the container is an object admits the two ways
  // that copy goes wrong: a non-primitive value violates §10.3's bounded payload,
  // and a cyclic one makes the completion's serialization THROW — turning the
  // controlled park this path promises into the one outcome that leaves no trace.
  // The reason is a closed vocabulary (`REVIEW_DISPUTE_FAILURE_REASONS`), so a
  // token outside it is recorded as a §12 reason that does not exist.
  const protocol = failure.protocol;
  if (protocol !== undefined) {
    if (!isRecord(protocol)) return "result.failure.protocol";
    const reasons: readonly string[] = REVIEW_DISPUTE_FAILURE_REASONS;
    const reason = protocol.reason;
    if (typeof reason !== "string" || !reasons.includes(reason)) {
      return `result.failure.protocol.reason:${typeof reason === "string" ? reason : typeof reason}`;
    }
    if (protocol.detail !== null && typeof protocol.detail !== "string") return "result.failure.protocol.detail";
  }
  if (status === "delayed") {
    if (value.retryAfterMs !== undefined && boundedInteger(value.retryAfterMs, Number.MAX_SAFE_INTEGER) === null) {
      return "result.retryAfterMs";
    }
    if (value.delayKind !== undefined && typeof value.delayKind !== "string") return "result.delayKind";
    if (value.category !== undefined && typeof value.category !== "string") return "result.category";
  }
  return null;
}

/**
 * The lineages a decision addresses, or null when it does not name one this
 * adapter can check.
 *
 * Only the three kinds a sub-turn may own are answered — everything else is
 * refused by kind before this is asked — and each is read from the field #840
 * itself keys the row on, so "the decision moved the lineage the turn was
 * dispatched for" is decided against the same value the transition will use.
 */
function decisionLineageIds(decision: DisputeTransitionDecision): readonly string[] | null {
  // Read as data, not as the typed decision it claims to be: the value arrived
  // from an implementation this module does not own, so the field may be missing
  // however well the type describes it.
  const raw = decision as unknown as Record<string, unknown>;
  const named = (value: unknown): readonly string[] | null => (typeof value === "string" ? [value] : null);
  switch (decision.kind) {
    case "reconsideration": {
      const admitted = raw.admitted;
      const record = isRecord(admitted) ? admitted.record : undefined;
      return isRecord(record) ? named(record.lineageId) : null;
    }
    case "arbitration": {
      const routed = raw.decision;
      return isRecord(routed) ? named(routed.lineageId) : null;
    }
    case "evidence_round":
      return named(raw.lineageId);
    default:
      return null;
  }
}

/**
 * Is this decision the one the selected turn was dispatched to produce?
 *
 * Two questions, and a `no` to either is §12 malformed output rather than a
 * transition:
 *
 *  - **the kind.** {@link DISPUTE_SUB_TURN_DECISION_KINDS} gives each turn its
 *    one row family. A structurally valid decision of another kind is still not
 *    this turn's: a reconsideration implementation returning a
 *    `finding_admission` would open lineages #840 accepts while the disputed
 *    lineage the turn was selected for never moved — a debate reported as taken
 *    and not taken at once.
 *  - **the lineages.** A decision addressed to a lineage the turn does not cover
 *    is the same fault at finer grain: the stale-state and replay guards above
 *    are computed over the TURN's lineage set, so a row landing outside it was
 *    checked against nothing.
 */
function subTurnDecisionProblem(
  kind: DisputeSubTurnKind,
  decision: DisputeTransitionDecision,
  selected: readonly string[],
): string | null {
  const expected = DISPUTE_SUB_TURN_DECISION_KINDS[kind];
  if (decision.kind !== expected) return `result.decision.kind:${String(decision.kind)}:${kind}`;
  const addressed = decisionLineageIds(decision);
  if (addressed === null) return `result.decision.lineageId:${expected}`;
  const foreign = addressed.find((lineageId) => !selected.includes(lineageId));
  return foreign === undefined ? null : `result.decision.lineageId:${foreign}:unselected`;
}

/**
 * Read the optional detail an evidence run returned beside its counts (#956),
 * or name the field that made it inadmissible.
 *
 * Admitted on exactly the terms the counts are: a lineage the turn does not
 * cover is a run answering a question it was not asked, and a value of the wrong
 * shape is §12 malformed output. Nothing is inspected beyond that — whether a
 * given reference RESOLVES is §3.3's question and was answered before this
 * outcome was returned, and whether it can be persisted is the record's, which
 * validates every entry on the way in.
 */
function readEvidenceDetail(
  outcome: Extract<DisputeSubTurnResult, { status: "collected" }>,
  selected: readonly string[],
  references: Record<string, readonly EvidenceRef[]>,
  dropped: Record<string, number>,
): string | null {
  if (outcome.references !== undefined) {
    if (!isRecord(outcome.references)) return "result.references";
    for (const [lineageId, refs] of Object.entries(outcome.references)) {
      if (!selected.includes(lineageId)) return `references.${lineageId}:unknown`;
      if (!Array.isArray(refs)) return `references.${lineageId}:invalid`;
      references[lineageId] = refs as readonly EvidenceRef[];
    }
  }
  if (outcome.dropped !== undefined) {
    if (!isRecord(outcome.dropped)) return "result.dropped";
    for (const [lineageId, count] of Object.entries(outcome.dropped)) {
      if (!selected.includes(lineageId)) return `dropped.${lineageId}:unknown`;
      const value = boundedInteger(count, MAX_EVIDENCE_DROPPED_PER_PARTY);
      if (value === null) return `dropped.${lineageId}:invalid`;
      dropped[lineageId] = value;
    }
  }
  return null;
}

/**
 * The safe references (#956) to the §10.2 artifacts this run produced for ONE
 * lineage's party, or nothing when it produced none.
 *
 * Attribution by minted NAME: `evidence-<party>-<lineageId>.json` and its three
 * transcript siblings are the only files a party's collection for a lineage may
 * write, so a returned artifact matching one of them is that run's and every
 * other artifact belongs to whatever named it. Guessing by prefix would let one
 * lineage's record be filed under another's.
 */
function evidenceArtifactRefs(
  artifacts: readonly DisputeArtifact[],
  party: EvidenceCollectionParty,
  lineageId: string,
): { artifacts: readonly DisputeEvidenceArtifactRef[] } | null {
  const owned = artifacts.filter((artifact) => isEvidenceArtifactName(artifact.name, party, lineageId));
  return owned.length === 0 ? null : { artifacts: owned.map((artifact) => evidenceArtifactRef(artifact)) };
}

/**
 * Dispatch one selected sub-turn and normalize its outcome into a phase
 * completion.
 *
 * The order of the guards is the contract. Everything that can refuse WITHOUT
 * running the implementation is checked first — the registry entry, the identity
 * agreeing with the turn, the block validating, every lineage still in the state
 * the turn was selected from — because a run that should not have started is
 * cheaper and safer to refuse than one whose output has to be thrown away. Only
 * then is the implementation called, and only a delivered outcome that was
 * ADMITTED — a well-formed value, of the shape its turn delivers, carrying a
 * decision that turn owns — reaches `applyDisputeTransition`: a `completed`
 * decision directly, and a `collected` evidence round only once BOTH parties
 * have answered — a first party's run is recorded and moves nothing, or the
 * second party would find a lineage that had already left `evidence_requested`
 * and could never contribute (§7.1, row 22).
 */
export async function dispatchDisputeSubTurn(
  input: DisputeSubTurnDispatchInput,
): Promise<DisputeSubTurnCompletion> {
  const { turn, identity } = input;
  const limits = input.limits ?? REVIEW_DISPUTE_DEFAULT_LIMITS;

  // The identity must describe THIS turn. A mismatch means the caller derived it
  // from a different selection — a stale one, most plausibly — and every replay
  // key below would then be keyed on the wrong debate.
  if (identity.kind !== turn.kind) {
    return parked(identity, { kind: "invalid_identity", detail: `identity.kind:${identity.kind}` });
  }
  const selected = [...turn.lineageIds];
  if (
    identity.lineageIds.length !== selected.length
    || identity.lineageIds.some((lineageId, index) => lineageId !== selected[index])
  ) {
    return parked(identity, { kind: "invalid_identity", detail: `identity.lineageIds:${identity.lineageIds.length}` });
  }
  // §7.1 dispatches one evidence run PER PARTY, so a party-less evidence
  // identity would make the two runs one run, and the second indistinguishable
  // from a redelivery of the first. `disputeSubTurnIdentity` already refuses to
  // derive one; this is the guard for an identity that reached here another way.
  //
  // An evidence identity's party has to be a MEMBER of §7.1's two, not merely
  // present: the value is what the round record is keyed on, so an absent one
  // (an identity rebuilt across a serialization boundary with the field lost) or
  // a token outside the set would be written as a party that does not exist —
  // and the next dispatch would then refuse the record this one wrote as an
  // unknown enum, parking a debate on a fault that belonged to the identity.
  const evidenceTurn = turn.kind === "evidence_collection";
  const party = identity.party;
  const partyKnown =
    typeof party === "string" && EVIDENCE_COLLECTION_PARTIES.includes(party as EvidenceCollectionParty);
  if (evidenceTurn ? !partyKnown : party !== null) {
    return parked(identity, { kind: "invalid_identity", detail: `identity.party:${party ?? "absent"}` });
  }

  const runner = input.runner ?? input.registry?.[turn.kind];
  if (runner === undefined) {
    // Every §7.1 sub-turn has a registered runner today — the evidence turn
    // gained its registration in issue #964 — so this is the standing guard for
    // a caller that could not assemble one (the gate parks an evidence turn
    // whose runtime it cannot build) or for a turn added before its dispatcher.
    return parked(identity, { kind: "no_implementation", detail: turn.kind });
  }

  // The block is read as a state to ACT on, so it is validated rather than
  // trusted — the same posture the selector takes with `task.context`.
  const validated = validateReviewDisputeContext(input.context, "reviewDispute", limits);
  if (!validated.ok) {
    return parked(identity, {
      kind: "invalid_context",
      detail: validated.failure.detail,
      protocol: validated.failure,
    });
  }
  const context = validated.value;

  // The round record is read before the implementation runs, for the same reason
  // the block is: a record that cannot be admitted means this adapter cannot tell
  // whether the other party has already answered, and guessing in either
  // direction is worse than not running — guessing "not yet" collects a party
  // twice, guessing "yes" spends the round on one side of the argument.
  const priorRound = parseDisputeEvidenceRoundState(evidenceTurn ? input.evidenceRound : undefined);
  if (!priorRound.ok) {
    return parked(identity, {
      kind: "invalid_context",
      detail: priorRound.failure.detail,
      protocol: priorRound.failure,
    });
  }
  const round: DisputeEvidenceRoundState | null = evidenceTurn ? priorRound.value : null;

  // Stale-lineage guard: the turn was selected from a block, and this is the
  // block NOW. A lineage that is absent, or has left the state its turn serves,
  // means the debate moved between selection and dispatch.
  const required = DISPUTE_SUB_TURN_REQUIRED_STATES[turn.kind];
  for (const lineageId of selected) {
    const lineage = Object.prototype.hasOwnProperty.call(context.lineages, lineageId)
      ? context.lineages[lineageId]
      : undefined;
    if (lineage === undefined) {
      return parked(
        identity,
        { kind: "stale_lineage", detail: `lineages.${lineageId}:absent` },
        [],
        undefined,
        round,
      );
    }
    // The one exception, and the reason the ledger is consulted here at all: a
    // lineage this exact sub-turn has ALREADY transitioned is not stale, it is a
    // redelivery — and the state it is no longer in is the state this sub-turn
    // moved it out of. Parking it would refuse a duplicate the protocol is
    // designed to absorb, and route the retry differently from the delivery that
    // landed. Letting it through reaches `applyDisputeTransition`, which
    // recognizes the digest, writes nothing, and reports the same routing.
    if (lineage.state !== required && !disputeSubTurnAlreadyApplied(lineage, identity)) {
      return parked(
        identity,
        { kind: "stale_lineage", detail: `lineages.${lineageId}.state:${lineage.state}` },
        [],
        undefined,
        round,
      );
    }
  }

  // An evidence delivery whose collection is already on the round record runs
  // nothing: the record IS the answer, and re-running the party would duplicate
  // its work and artifacts and then overwrite the counts row 22 records. The
  // check is deliberately last among the pre-run guards — a stale block or an
  // inadmissible record still refuses first — and deliberately before the
  // implementation, because a replay that ran the agent anyway would already have
  // spent the very work this recognizes.
  const replay =
    round === null ? null : disputeEvidenceReplay(round, selected, context, identity, party as EvidenceCollectionParty);

  let outcome: DisputeSubTurnResult;
  if (replay !== null) {
    // Synthesized from the record rather than delivered: it carries no artifacts
    // and no context of its own, because those were the FIRST delivery's and are
    // already wherever that completion put them.
    outcome = { status: "collected", attachments: replay.attachments };
  } else {
    let delivered: unknown;
    try {
      delivered = await runner({ turn, identity, context, limits });
    } catch (err) {
      // A thrown implementation is a run that did not happen. Only the error's
      // NAME travels: a message could carry agent prose, a local path, or an
      // evidence excerpt, none of which may reach a task event (§10.3).
      // An evidence party that was invoked and stopped is recorded as
      // `recoverable` on the round it did not answer (#963), so a resumed phase
      // can tell a party that never ran from one whose attempt stopped.
      return parked(
        identity,
        { kind: "internal_error", detail: err instanceof Error ? err.name : typeof err },
        [],
        undefined,
        recoverableEvidenceRound(round, selected, context, identity, "internal_error"),
      );
    }
    // Admitted before a single field is read (§12). Nothing of the value travels
    // on this park — not its artifacts, not its context — because a value this
    // adapter could not admit is one whose OTHER fields it has no reason to
    // trust either; what it did produce is still the implementation's to have
    // written under its own run directory.
    const problem = subTurnResultProblem(delivered);
    if (problem !== null) {
      return parked(
        identity,
        { kind: "malformed_output", detail: problem },
        [],
        undefined,
        recoverableEvidenceRound(round, selected, context, identity, "malformed_output"),
      );
    }
    outcome = delivered as DisputeSubTurnResult;
  }

  const artifacts = outcome.artifacts ?? [];
  // The posture the delivered run enforced, carried onto every event this
  // dispatch can still emit for it — a park and a delay included, because "the
  // run that could not answer was the read-bounded one" is exactly the fact an
  // operator reading event history needs (issue #1085 review, P2). A
  // replay-synthesized `collected` outcome states none: that posture belonged to
  // the FIRST delivery and is already on that delivery's own event.
  const enforcedToolPolicy = outcome.status === "collected" ? undefined : outcome.toolPolicy;

  if (outcome.status === "failed") {
    // The party was invoked and delivered no answer: its stop is recorded as
    // `recoverable` on the round (#963), while the OTHER party's admitted record
    // — and this party's own, if a bumped-attempt retry failed over one — stands
    // byte for byte. A replay-synthesized outcome can never reach here: it is
    // always `collected`.
    return parked(
      identity,
      outcome.failure,
      artifacts,
      outcome.context,
      recoverableEvidenceRound(round, selected, context, identity, outcome.failure.kind),
      enforcedToolPolicy,
    );
  }

  if (outcome.status === "delayed") {
    const summary = summarize(identity, "delayed", null, outcome.failure, artifacts, undefined, enforcedToolPolicy);
    // A delayed evidence party carries the same recoverable marker a failed one
    // does (#963): the retry the delay asks for is a later attempt, and the
    // record is what tells it the earlier one stopped without answering.
    const stopped = recoverableEvidenceRound(round, selected, context, identity, outcome.failure.kind);
    return {
      // A delay is not a completion: the runner releases the claim back to
      // `queued` with a future `notBefore` and nothing about the task's protocol
      // state is written, so no counter is spent on a run that never produced a
      // decision.
      result: {
        result: "delayed",
        context: contextPatch(summary, outcome.context, stopped),
        message:
          `Review dispute ${turnLabel(identity)} sub-turn was delayed (${outcome.failure.kind}); `
          + `the debate state is unchanged.`,
        ...(outcome.retryAfterMs === undefined ? {} : { retryAfterMs: outcome.retryAfterMs }),
        ...(outcome.category === undefined ? {} : { category: outcome.category }),
        delayKind: outcome.delayKind ?? "agent_failure",
        extraEvents: [auditEvent(summary)],
      },
      disposition: "delayed",
      identity,
      transition: null,
      artifacts,
      failure: outcome.failure,
      evidenceRound: stopped,
    };
  }

  // A delivered outcome has to be the one its turn defines. The evidence turn's
  // runs produce attachments and no decision (§7.1); the other two produce a
  // decision and have no round to collect. Either returning the other's shape is
  // §12 malformed output, not a shape to reinterpret — reinterpreting is how one
  // party's run would end up closing a two-party round.
  if ((outcome.status === "collected") !== evidenceTurn) {
    return parked(
      identity,
      { kind: "malformed_output", detail: `result.status:${outcome.status}:${turn.kind}` },
      artifacts,
      outcome.context,
      // For an evidence turn this is a delivered run whose answer could not be
      // admitted, so the party's stop is recorded like every other one (#963);
      // for the other turns the round is null and travels unchanged.
      recoverableEvidenceRound(round, selected, context, identity, "malformed_output"),
      enforcedToolPolicy,
    );
  }

  let decision: DisputeTransitionDecision;
  let nextRound: DisputeEvidenceRoundState | null = round;
  let evidenceSummary: Record<string, unknown> | undefined;
  /** The lineage row 22 closes on this run, once both parties have answered. */
  let closingLineageId: string | null = null;

  if (outcome.status === "collected") {
    // Every guard above has run, so: the turn is the evidence turn, the party is
    // named, the round record admitted, and every covered lineage is present and
    // still in `evidence_requested` (or is this run's own redelivery).
    const collecting = party as EvidenceCollectionParty;
    const state = round as DisputeEvidenceRoundState;

    // Counts only, and only for lineages this turn covers. A count for a lineage
    // outside the turn is a run that answered a question it was not asked.
    const admitted: Record<string, number> = Object.create(null) as Record<string, number>;
    // A run that named no counts at all admitted none for every lineage it
    // covered, which is the same answer as naming zeros.
    const counts: Record<string, unknown> = isRecord(outcome.attachments) ? outcome.attachments : {};
    for (const [lineageId, count] of Object.entries(counts)) {
      if (!selected.includes(lineageId)) {
        return parked(
          identity,
          { kind: "malformed_output", detail: `attachments.${lineageId}:unknown` },
          artifacts,
          outcome.context,
          // A delivered collection this adapter cannot admit is still a run that
          // happened: the stop is recorded like every other malformed output
          // (#963), so a resumed phase can tell it from a party that never ran.
          recoverableEvidenceRound(state, selected, context, identity, "malformed_output"),
        );
      }
      // Bounded by the ceiling a §2.1/§3.2 record's own evidence carries (#956):
      // an evidence round may not put a larger set in front of the arbiter than
      // the dispute that asked for it could.
      const value = boundedInteger(count, MAX_EVIDENCE_ATTACHMENTS_PER_PARTY);
      if (value === null) {
        return parked(
          identity,
          { kind: "malformed_output", detail: `attachments.${lineageId}:invalid` },
          artifacts,
          outcome.context,
          recoverableEvidenceRound(state, selected, context, identity, "malformed_output"),
        );
      }
      admitted[lineageId] = value;
    }

    // The admitted references and the dropped counts beside them (#956), read on
    // the same terms as the counts: only for lineages the turn covers, and only
    // as values this module can persist. What the record does with them —
    // projecting an `issue_quote` to a digest, refusing a list that disagrees
    // with its count — belongs to the record, not to this adapter.
    const references: Record<string, readonly EvidenceRef[]> = Object.create(null) as Record<
      string,
      readonly EvidenceRef[]
    >;
    const dropped: Record<string, number> = Object.create(null) as Record<string, number>;
    const detailProblem = readEvidenceDetail(outcome, selected, references, dropped);
    if (detailProblem !== null) {
      return parked(
        identity,
        { kind: "malformed_output", detail: detailProblem },
        artifacts,
        outcome.context,
        recoverableEvidenceRound(state, selected, context, identity, "malformed_output"),
      );
    }

    // Record this party's run against every lineage the turn covers, carrying the
    // other party's record forward. A round collected against a version the
    // lineage has since left, or already closed by a DIFFERENT run, is a previous
    // round: it is replaced rather than completed, so a spent round can never
    // close a new one on its predecessor's parties.
    //
    // A replayed delivery writes NOTHING here. Its answers are the records this
    // outcome was synthesized from, and rewriting them — re-keying a deferred
    // lineage's party run on the current identity, or replacing a redelivered
    // one's counts — would let a retry change the evidence row 22 records.
    let merged = state;
    /** Lineages whose admitted answer was already on file and kept (#963). */
    const reusedOnFile: string[] = [];
    if (replay === null) {
      for (const lineageId of selected) {
        // A lineage THIS party has already answered for this round identity is
        // reused per lineage, on the same terms the whole-run replay above
        // reuses a run (#963): a partially admitted earlier attempt — one
        // lineage admitted, the next refused — left the admitted answer on
        // file, this retry runs the party for the whole bundle, and what it
        // returned for an answered lineage is discarded in favor of the
        // record. Without this, one lineage's malformed output would let the
        // retry overwrite another lineage's admitted answer. The one record
        // not reused is one an identity with a deliberately HIGHER attempt is
        // dispatched over — #840's escape hatch, read exactly as the replay
        // reads it — and a spent or re-versioned entry stays a previous
        // round, replaced as before.
        const prior = disputeEvidenceRoundEntry(merged, lineageId);
        const own =
          prior !== undefined
          && prior.version === context.lineages[lineageId].version
          && (prior.recordedRunId === undefined || prior.recordedRunId === identity.runId)
          && disputeEvidencePartyState(prior, collecting) === "completed"
            ? prior.parties[collecting]
            : undefined;
        if (own !== undefined && (own.runId === identity.runId || own.attempt >= identity.attempt)) {
          // The audit summary reports the round as it stands: the on-file
          // count, and none of this delivery's discarded detail.
          admitted[lineageId] = own.attachments;
          delete references[lineageId];
          delete dropped[lineageId];
          reusedOnFile.push(lineageId);
          continue;
        }
        const coordinates: EvidencePartyRunCoordinates = {
          lineageId,
          version: context.lineages[lineageId].version,
          round: DEFAULT_EVIDENCE_ROUND,
          party: collecting,
          attempt: identity.attempt,
          runId: identity.runId,
        };
        const written = completeEvidencePartyRun(merged, coordinates, {
          // A lineage the run did not mention is a lineage it admitted none for,
          // which §7.1 allows; it is still an answer, and the round needs it to be.
          attachments: admitted[lineageId] ?? 0,
          ...(Object.prototype.hasOwnProperty.call(references, lineageId)
            ? { references: references[lineageId] }
            : {}),
          ...(Object.prototype.hasOwnProperty.call(dropped, lineageId) ? { dropped: dropped[lineageId] } : {}),
          // The §10.2 files this run produced FOR THIS LINEAGE, by name and
          // digest. Matched against the names this protocol mints rather than
          // guessed from a prefix: an artifact the run named itself belongs to
          // whatever wrote it, and only a name this module could have minted can
          // be attributed to a lineage's party run.
          ...(evidenceArtifactRefs(artifacts, collecting, lineageId) ?? {}),
        });
        if (!written.ok) {
          return parked(
            identity,
            { kind: "malformed_output", detail: written.failure.detail ?? "evidenceRound", protocol: written.failure },
            artifacts,
            outcome.context,
            // A delivery the record itself refuses is still a run that happened:
            // its stop is marked recoverable like every other malformed output
            // (#963), on top of whatever this run already admitted — which the
            // retry reuses per lineage above rather than buying again, so a
            // partial admission is never overwritten by the re-run it causes.
            recoverableEvidenceRound(merged, selected, context, identity, "malformed_output"),
          );
        }
        merged = written.value;
      }
    }

    // §7.1: "when both have completed, the runner records the admitted
    // attachments … and row 22 returns the lineage to `arbitration_pending`".
    // Until then this run closes nothing, which is precisely what leaves the
    // other party a lineage in `evidence_requested` to be dispatched against.
    const complete = selected.filter((lineageId) => disputeEvidenceRoundComplete(merged.lineages[lineageId]));
    const closing =
      complete.find((lineageId) => merged.lineages[lineageId].recordedRunId === undefined)
      // A redelivery of the run that closed the round re-derives the same row and
      // #840's ledger recognizes it; nothing is charged twice.
      ?? complete.find((lineageId) => merged.lineages[lineageId].recordedRunId === identity.runId);

    const collectedSummary = {
      party: collecting,
      collected: selected.length,
      attachments: selected.reduce((total, lineageId) => total + (admitted[lineageId] ?? 0), 0),
      // Counts of what the round RETAINED and what §3.3 resolution dropped
      // (#956). Numbers, never a reference: an audit event carries no evidence
      // content, and a §3.3 reference is evidence content.
      references: selected.reduce((total, lineageId) => total + (references[lineageId]?.length ?? 0), 0),
      dropped: selected.reduce((total, lineageId) => total + (dropped[lineageId] ?? 0), 0),
      complete,
      awaiting: selected.filter((lineageId) => !complete.includes(lineageId)),
      // Which of §7.1's two "already on file" readings skipped the run, so an
      // operator reading the audit record can tell a collection that HAPPENED
      // from one this dispatch recognized. A bounded token, like every other
      // field here.
      ...(replay === null ? {} : { replayedCollection: replay.kind }),
      // The lineages whose admitted answer was kept from the record over this
      // delivery's fresh output (#963) — the per-lineage sibling of
      // `replayedCollection`, bounded the same way `complete` is.
      ...(reusedOnFile.length === 0 ? {} : { reused: reusedOnFile }),
    };

    if (closing === undefined) {
      const summary = summarize(identity, "collected", null, null, artifacts, collectedSummary);
      // Not a completion of the debate and not a failure of the run: the party
      // answered, its answer is on file, and the round is still open. Since the
      // other party's run has a dispatcher too (issue #964), the task returns to
      // the review phase for the remaining internal turn — expressed through the
      // §7.1 routing the runner already folds into its completion, computed over
      // the UNCHANGED block, so the lineage keeps the state that run will be
      // dispatched against and the round finishes where it stopped. A `blocked`
      // would park a round the protocol can finish; a `delayed` would report an
      // agent condition to a run that succeeded; and a bare `success` would take
      // the ordinary `nextPhaseAfter` destination and route the task OUT of the
      // debate with a round still open. The application is routing-only:
      // `replayed` is true so neither the durable layer nor the folded phase
      // completion writes a §10.3 transition event for it — nothing transitioned
      // — while the routing still decides the completion's destination.
      const serialized = serializeReviewDisputeContext(context);
      if (!serialized.ok) {
        return parked(
          identity,
          { kind: "invalid_context", detail: serialized.failure.detail, protocol: serialized.failure },
          artifacts,
          outcome.context,
          merged,
        );
      }
      const routing = aggregateDisputeRouting(context);
      const actor = DISPUTE_SUB_TURN_DEFAULT_ACTORS[turn.kind];
      const continuation: DisputeTransitionApplication = {
        context,
        serialized: serialized.value,
        unchanged: true,
        replayed: true,
        applied: [],
        refused: [],
        routing,
        event: {
          decision: "evidence_round",
          runId: identity.runId,
          actor,
          applied: [],
          refused: [],
          auditEvents: [],
          routing,
          operational: null,
        },
        operational: null,
      };
      return {
        result: {
          result: "success",
          disputeTransition: continuation,
          context: contextPatch(summary, outcome.context, merged),
          message:
            `Review dispute ${turnLabel(identity)} evidence run `
            + `${replay === null ? "recorded" : "was already on file with"} `
            + `${collectedSummary.attachments} attachment(s) for ${selected.length} lineage(s); `
            + `the bounded round awaits the other party and no lineage moved.`,
          extraEvents: [auditEvent(summary)],
        },
        disposition: "collected",
        identity,
        transition: null,
        artifacts,
        failure: null,
        evidenceRound: merged,
      };
    }

    // Row 22 is the RUNNER's row, synthesized here from what the two runs
    // recorded rather than returned by either of them — an evidence run that
    // could name its own transition could close the round alone.
    const closingEntry = merged.lineages[closing];
    decision = {
      kind: "evidence_round",
      lineageId: closing,
      version: context.lineages[closing].version,
      attachmentsRecorded: disputeEvidenceAttachmentsRecorded(closingEntry),
    };
    nextRound = merged;
    closingLineageId = closing;
    evidenceSummary = {
      ...collectedSummary,
      closing,
      attachmentsRecorded: decision.attachmentsRecorded,
      // The closed round's own bounded record (#956): both parties' states,
      // attempts and counts, so the audit event says what row 22 was built from
      // and not merely what it totalled.
      record: summarizeEvidenceRound(closingEntry),
      // One row per completion, because the runner folds exactly one application
      // into the transaction it commits. A round covering several lineages closes
      // them one dispatch at a time; the rest keep their records and stay in
      // `evidence_requested` for the next.
      deferred: complete.filter((lineageId) => lineageId !== closing),
    };
  } else {
    decision = outcome.decision;
  }

  // A decision that is well-formed is not yet a decision this turn may take. The
  // kind and the lineages it addresses are checked against the SELECTED turn
  // before anything is applied, so an implementation cannot take another turn's
  // row — row 22 synthesized above trivially passes its own check, which is the
  // point: the same rule holds for the decision this module builds and for the
  // decision an implementation returns.
  const mismatch = subTurnDecisionProblem(turn.kind, decision, selected);
  if (mismatch !== null) {
    return parked(
      identity,
      { kind: "malformed_output", detail: mismatch },
      artifacts,
      outcome.context,
      // The party records survive: this refusal charges nothing, so the round is
      // still the one those runs collected.
      nextRound,
    );
  }

  // The one path that moves state, and it moves it through #840 alone: the
  // decision is applied against the CURRENT block, under this sub-turn's derived
  // run id, so the ledger — not this module — decides what is new and what is a
  // redelivery.
  const applied = applyDisputeTransition({
    context,
    decision,
    run: {
      runId: identity.runId,
      actor: (outcome.status === "completed" ? outcome.actor : undefined) ?? DISPUTE_SUB_TURN_DEFAULT_ACTORS[turn.kind],
    },
    limits,
  });
  if (!applied.ok) {
    return parked(
      identity,
      { kind: "transition_refused", detail: applied.failure.detail, protocol: applied.failure },
      artifacts,
      outcome.context,
      // The party records survive a row the block refused: nothing was charged,
      // so the round is still the one those runs collected.
      nextRound,
    );
  }
  const transition = applied.value;

  // A decision that moved NOTHING and was refused is a decision the current block
  // rejected in full (§12) — a stale version, a consumed slot, an unknown lineage.
  // Carrying its application would commit a block that is byte-identical to the
  // one on file while routing the task as though a turn had been taken, so it
  // parks instead. A redelivery is the deliberate exception below: it is
  // `replayed`, refuses nothing, and must route exactly as its first delivery did.
  if (transition.applied.length === 0 && transition.refused.length > 0) {
    const first = transition.refused[0];
    return parked(
      identity,
      { kind: "stale_lineage", detail: `refused:${transition.refused.length}`, protocol: first.failure },
      artifacts,
      outcome.context,
      nextRound,
      enforcedToolPolicy,
    );
  }

  // The round is spent only now, and only for the lineage the row actually moved:
  // the record keeps the run id that closed it so a redelivery re-derives the same
  // row, while a later round for that lineage starts from an empty record.
  if (nextRound !== null && closingLineageId !== null) {
    nextRound = markEvidenceRoundRecorded(nextRound, closingLineageId, identity.runId);
  }

  const disposition: DisputeSubTurnDisposition = transition.replayed ? "replayed" : "applied";
  const summary = summarize(identity, disposition, transition, null, artifacts, evidenceSummary, enforcedToolPolicy);
  return {
    result: {
      result: "success",
      // Carried OUTSIDE `context`: the runner writes the §10.1 block from the
      // application itself, appends its one §10.3 event in the same transaction,
      // and lets §7.1 routing decide where the task goes — including parking it
      // when the routing names a turn nothing dispatches yet.
      disputeTransition: transition,
      context: contextPatch(summary, outcome.context, nextRound),
      message:
        `Review dispute ${turnLabel(identity)} sub-turn ${transition.replayed ? "was already on file" : "applied"} `
        + `${transition.applied.length} lineage transition(s).`,
      extraEvents: [auditEvent(summary)],
    },
    disposition,
    identity,
    transition,
    artifacts,
    failure: null,
    evidenceRound: nextRound,
  };
}
