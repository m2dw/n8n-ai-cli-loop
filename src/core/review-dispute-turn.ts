/**
 * Issue #950: which Review dispute sub-turn must run NEXT
 * (docs/review-dispute-contract.md §7.1).
 *
 * The transition layer (#840, `aggregateDisputeRouting`) answers a question
 * about a run that just finished: given the lineage set this run produced, what
 * did the run MEAN at task level. This module answers the question a dispatcher
 * asks before there is any run at all: given only what the task has persisted
 * (§10.1), which sub-turn must be taken now, and by whom.
 *
 * The two are deliberately not independent implementations of §7.1. Precedence
 * is read from `aggregateDisputeRouting`, so the rule order — rule 1 before
 * rule 2, and inside rule 2 `open`/`binding` before `disputed` before
 * `evidence_requested` before `arbitration_pending` — has exactly one
 * implementation in this codebase. What this module adds is the two things a
 * dispatcher needs and the transition layer cannot give it:
 *
 *  - **an untrusted input.** The transition layer is handed a
 *    `ReviewDisputeContext` its caller already validated against the run it is
 *    applying. A dispatcher starts from `task.context.reviewDispute` as SQLite
 *    returned it, so the block is validated here (§12 fail-closed) and any
 *    combination §7.1 could not have produced refuses rather than routes.
 *  - **a closed, dispatch-shaped result.** `DisputeTaskRouting.turn` is a
 *    string plus a `nextPhase` that names `review` for both the reconsideration
 *    turn and the ordinary re-review — a distinction that matters enormously,
 *    since dispatching a `disputed` lineage to an ordinary review run is the
 *    wrong-handler discharge the §9 park exists to prevent. Here they are
 *    different variants of a discriminated union, so a caller that adds a
 *    dispatcher for one cannot accidentally serve the other, and a caller that
 *    handles neither fails to compile rather than falling through to review.
 *
 * Purity is the point: no store, no GitHub, no agent, no worktree, no artifact,
 * no outbox. The selector says what must happen; nothing here makes it happen,
 * and in particular it neither takes nor releases the §9 `undispatched_turn`
 * park that today's commit layer applies (review-dispute-commit.ts).
 */

import type { PersistedLineage, ReviewDisputeContext, ReviewDisputeLimits } from "./review-dispute.js";
import { REVIEW_DISPUTE_DEFAULT_LIMITS, isTerminalLineageState } from "./review-dispute.js";
import type { ReviewDisputeFailure } from "./review-dispute-validation.js";
import { validateReviewDisputeContext } from "./review-dispute-validation.js";
import type { DisputeTaskRouting } from "./review-dispute-transition.js";
import { aggregateDisputeRouting } from "./review-dispute-transition.js";

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** Every sub-turn §7.1 can select, plus the two non-turn answers. */
export const DISPUTE_TURN_KINDS = [
  /** Rule 2, first branch: today's `needs_fix` fix run carries the lineages. */
  "implementer_fix",
  /** Rule 2, second branch: the reviewer's reconsideration run (NOT an ordinary review). */
  "reviewer_reconsideration",
  /** Rule 2, third branch: one bounded evidence-collection run per party. */
  "evidence_collection",
  /** Rule 2, fourth branch: the runner advances arbitration; no agent run. */
  "runner_arbitration",
  /** Rule 3: the accumulated unreviewed diff goes back to ordinary review. */
  "re_review",
  /** Rule 1: automation stops and a human decides (§9). */
  "human_handoff",
  /** Rules 4 and §13: no protocol turn exists; the ordinary result stands. */
  "no_turn",
  /** §12: the persisted state is malformed, contradictory, or unsupported. */
  "unresolvable",
] as const;
export type DisputeTurnKind = (typeof DISPUTE_TURN_KINDS)[number];

/**
 * §7.1 rule 2, evidence branch: "exactly one bounded evidence-collection run
 * per party — one implementer-side, one reviewer-side".
 *
 * Typed as a two-element tuple rather than an array so the dual-party shape is
 * a fact of the type: a caller cannot read it as "some parties" and dispatch
 * one run, and row 22 only fires once BOTH have completed.
 */
export const EVIDENCE_COLLECTION_PARTIES = ["implementer", "reviewer"] as const;
export type EvidenceCollectionParty = (typeof EVIDENCE_COLLECTION_PARTIES)[number];

/** Why no protocol turn exists. Never an error: each is a defined §7.1/§13 answer. */
export const DISPUTE_NO_TURN_REASONS = [
  /** `session.reviewDispute.enabled` is false: legacy behavior, byte for byte. */
  "protocol_disabled",
  /** The task carries no §10.1 block at all — a pre-protocol or legacy task. */
  "no_dispute_state",
  /** §13: a block with no lineage. The free-form review path is unchanged. */
  "legacy_review",
  /** Rule 4, fully structured: the run resolved with no changes required. */
  "resolved_without_changes",
  /** Rule 4, mixed review (§13): the prose keeps its legacy blocking force. */
  "no_change_run_invalid",
] as const;
export type DisputeNoTurnReason = (typeof DISPUTE_NO_TURN_REASONS)[number];

/** Rule 1's two triggers. Both may hold at once, so they are reported as a set. */
export const DISPUTE_HUMAN_HANDOFF_REASONS = ["lineage_escalated_human", "reopen_requested"] as const;
export type DisputeHumanHandoffReason = (typeof DISPUTE_HUMAN_HANDOFF_REASONS)[number];

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

/**
 * The one sub-turn that must run next, as a closed discriminated union.
 *
 * Exhaustive by construction: there is no "other" member and no optional
 * fallthrough, so a `switch` over `kind` that misses a variant is a compile
 * error in the dispatcher rather than a `disputed` lineage quietly handed to an
 * ordinary review run.
 *
 * `lineageIds` is always the sorted set the selected turn carries — the same
 * `actionableLineageIds` §7.1 aggregation computes — so two tasks whose
 * lineages were touched in a different order select identically.
 */
export type PendingDisputeTurn =
  | {
      kind: "implementer_fix";
      rule: 2;
      /** The `open`/`binding` lineages awaiting a disposition. */
      lineageIds: readonly string[];
    }
  | {
      kind: "reviewer_reconsideration";
      rule: 2;
      /**
       * The `disputed` lineages, each of which requires exactly one §4
       * reconsideration record from the reconsideration run.
       */
      lineageIds: readonly string[];
    }
  | {
      kind: "evidence_collection";
      rule: 2;
      /** Every lineage in `evidence_requested`; both runs cover all of them. */
      lineageIds: readonly string[];
      parties: readonly [EvidenceCollectionParty, EvidenceCollectionParty];
    }
  | {
      kind: "runner_arbitration";
      rule: 2;
      /** The `arbitration_pending` lineages the runner advances between runs (§8). */
      lineageIds: readonly string[];
    }
  | {
      kind: "re_review";
      rule: 3;
      /**
       * Typed as the literal `true`, because from persisted state alone it can
       * only be true: the diff was deferred by an earlier run of this cycle
       * (§7.1 rule 2's `pendingReReview`), since a run this selector cannot see
       * is the only other way rule 3 fires. Routing to review is what clears the
       * flag; the selector never clears anything.
       */
      deferred: true;
    }
  | {
      kind: "human_handoff";
      rule: 1;
      reasons: readonly DisputeHumanHandoffReason[];
      escalatedLineageIds: readonly string[];
      reopenRequestedLineageIds: readonly string[];
    }
  | {
      kind: "no_turn";
      /** Rule 4 for the two zero-change outcomes; null for the §13/disabled paths. */
      rule: 4 | null;
      reason: DisputeNoTurnReason;
    }
  | {
      kind: "unresolvable";
      rule: null;
      /** The §12 refusal, content-free: a reason token and a field locator. */
      failure: ReviewDisputeFailure;
    };

/**
 * Compile-time pin: the token list and the union's discriminants are one set.
 *
 * Type-only, so it emits nothing — its whole job is to fail the build if a
 * variant is added to `PendingDisputeTurn` without a token (a turn no caller can
 * enumerate) or a token is added without a variant (a turn no caller can
 * receive). Both drifts would quietly weaken "the result is closed".
 */
type AssertTrue<T extends true> = T;
type _EveryTokenHasAVariant = AssertTrue<DisputeTurnKind extends PendingDisputeTurn["kind"] ? true : false>;
type _EveryVariantHasAToken = AssertTrue<PendingDisputeTurn["kind"] extends DisputeTurnKind ? true : false>;

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export interface PendingDisputeTurnInput {
  /**
   * The resolved `session.reviewDispute.enabled` gate, never the raw config.
   *
   * Production routing does not call the selector at all for a disabled
   * session — a disabled session writes no §10.1 block, so there is nothing to
   * select from. Carrying the gate anyway makes that guarantee structural: even
   * a caller that reaches here with a block left over from a session that has
   * since been disabled gets `protocol_disabled`, so no protocol turn can be
   * dispatched under a session that did not opt in.
   */
  enabled: boolean;
  /**
   * `task.context.reviewDispute`, exactly as persisted — untrusted, unvalidated,
   * possibly absent. `undefined`/`null` mean the task has no block.
   */
  persisted: unknown;
  /** The session's resolved §6.1 limits the persisted counters are checked against. */
  limits?: ReviewDisputeLimits;
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

function unresolvable(reason: ReviewDisputeFailure["reason"], detail: string | null): PendingDisputeTurn {
  return { kind: "unresolvable", rule: null, failure: { reason, detail } };
}

function noTurn(reason: DisputeNoTurnReason, rule: 4 | null = null): PendingDisputeTurn {
  return { kind: "no_turn", rule, reason };
}

/**
 * Reject a persisted lineage the §7 transition table could not have produced.
 *
 * The record validator checks a lineage against ITSELF — field types, closed
 * enums, `counters.rebuttals` against `rebuttedVersions.length` — and says so
 * explicitly: whether the COMBINATION is one the table could have reached is a
 * property of the transition machine and is left to the layers that read the
 * block as a machine state. This selector is one of those layers, and it is the
 * one that would otherwise act on the answer: a structurally valid record whose
 * state, version, and counters describe a debate no sequence of §7 rows could
 * have produced is corrupted, and dispatching an agent run against it debates a
 * finding whose history the runner has misread.
 *
 * Each check below names the row that would have had to fire, and every one of
 * them is a fact of the table rather than of a session's configuration:
 *
 *  - Recording a rebuttal for a version LEAVES `open` (rows 2/3/6/7/25, and the
 *    persistence layer that writes the consumed slot), so an `open` lineage
 *    whose current version is already rebutted is unreachable.
 *  - Nothing returns from `arbitration_pending` or `evidence_requested` to
 *    `open` or `disputed`; the only row back into `open` is row 11, which mints
 *    a successor version and spends the reconsideration round.
 *  - `binding` and `resolved_overruled` are entered only by rows 13 and 14, both
 *    of which consume the returned verdict an arbitration pass counts (§8.3).
 *  - The evidence round is charged by row 22 on the way OUT of
 *    `evidence_requested`, so a lineage sitting in that state must still have a
 *    round available — and row 16 only ever put it there after a pass.
 *
 * Returns the field locator of the first violation in a fixed order, or null.
 * Content-free by construction: states, counters, and versions only.
 */
function unreachableLineage(entry: PersistedLineage, limits: ReviewDisputeLimits): string | null {
  const { state, version, counters } = entry;
  const rebutted = (target: number): boolean => entry.rebuttedVersions.includes(target);
  const arbitrated = counters.arbitrationPasses > 0;
  // Everything the protocol only ever spends INSIDE a debate, i.e. after a
  // `review_disputed` was admitted against some version of this lineage.
  const debateSpend =
    counters.reconsiderations
    + counters.arbitrationPasses
    + counters.malformedArbiterAttempts
    + counters.evidenceRoundsUsed;
  // The states no row leaves for `open` or `disputed`.
  const pastArbitration = arbitrated || counters.malformedArbiterAttempts > 0 || counters.evidenceRoundsUsed > 0;

  // Universal, whatever the state: a debate no rebuttal opened.
  if (counters.rebuttals === 0 && debateSpend > 0) {
    return ".counters:spent-without-rebuttal";
  }
  // Row 22 charges the round for a case row 16 re-presents, and row 16 fires
  // only on a RETURNED `insufficient_evidence` verdict — which is a pass.
  if (counters.evidenceRoundsUsed > 0 && !arbitrated) {
    return ".counters.evidenceRoundsUsed:without-arbitration-pass";
  }
  // Row 11 is the only version-minting row: every version below the current one
  // was disputed and then reconsidered before its successor existed.
  for (let earlier = 1; earlier < version; earlier += 1) {
    if (!rebutted(earlier)) return `.version:${version}-over-unrebutted-${earlier}`;
  }
  if (counters.reconsiderations < version - 1) {
    return `.counters.reconsiderations:${counters.reconsiderations}-below-version-${version}`;
  }

  switch (state) {
    case "open":
      if (rebutted(version)) return ".state:open-with-rebutted-version";
      if (pastArbitration) return ".state:open-after-arbitration";
      // Exactly one round per version minted (row 11); any other spend left
      // `disputed` for a state that never returns here (rows 9, 10, 12, 26).
      // Defense in depth only: under the §6.1 maximum of one reconsideration the
      // two checks above already exclude every record this one would catch. It
      // stays because it is the rule, and a raised limit must not open a hole.
      if (counters.reconsiderations !== version - 1) {
        return `.state:open-with-${counters.reconsiderations}-reconsiderations`;
      }
      return null;
    case "disputed":
      // Row 2 (and the pre-transition persistence write) enters `disputed` on
      // the rebuttal that consumed this version's slot.
      if (!rebutted(version)) return ".state:disputed-without-rebuttal";
      if (pastArbitration) return ".state:disputed-after-arbitration";
      // Spending the round IS what leaves `disputed` (rows 9–12, 26).
      if (counters.reconsiderations !== version - 1) {
        return `.state:disputed-with-${counters.reconsiderations}-reconsiderations`;
      }
      return null;
    case "arbitration_pending":
      // Rows 6, 10, 12, 22, 25, and 26 all stand behind an admitted dispute of
      // the version being arbitrated.
      if (!rebutted(version)) return ".state:arbitration_pending-without-rebuttal";
      return null;
    case "evidence_requested":
      if (!rebutted(version)) return ".state:evidence_requested-without-rebuttal";
      if (!arbitrated) return ".state:evidence_requested-without-arbitration-pass";
      // Row 16 requires an available round; row 22 marks it used on the way out,
      // so a lineage still IN the round cannot have charged it.
      if (counters.evidenceRoundsUsed >= limits.maxEvidenceRoundsPerLineage) {
        return ".state:evidence_requested-without-available-round";
      }
      return null;
    case "binding":
      if (!rebutted(version)) return ".state:binding-without-rebuttal";
      if (!arbitrated) return ".state:binding-without-arbitration-pass";
      return null;
    case "resolved_withdrawn":
      // Row 9 only: the reviewer withdrew during the reconsideration round.
      if (!rebutted(version)) return ".state:resolved_withdrawn-without-rebuttal";
      if (counters.reconsiderations < 1) return ".state:resolved_withdrawn-without-reconsideration";
      return null;
    case "resolved_overruled":
      // Row 14 only: a decisive verdict at or above the §8.3 threshold.
      if (!rebutted(version)) return ".state:resolved_overruled-without-rebuttal";
      if (!arbitrated) return ".state:resolved_overruled-without-arbitration-pass";
      return null;
    case "resolved_fixed":
      // Rows 1 and 5 fix from `open`, whose version is by definition NOT
      // rebutted; the one path that fixes a rebutted version is row 23, out of
      // the `binding` an arbitration pass produced.
      if (rebutted(version) && !arbitrated) return ".state:resolved_fixed-without-arbitration-pass";
      return null;
    case "escalated_human":
      // Reachable from every live state, including a version-1 `open` that was
      // simply reported `blocked` (row 4), so the universal checks are all this
      // state can be held to.
      return null;
    default: {
      const unexpected: never = state;
      return `.state:${String(unexpected)}`;
    }
  }
}

/**
 * Reject the combinations §7.1 could not have produced, before any turn is named.
 *
 * Two kinds of fact, in one place because they refuse the same way: whether each
 * lineage is a state the §7 table could have reached ({@link unreachableLineage})
 * and whether the block's own flags agree with the lineage set. Neither is
 * checked by the record validator, which deliberately stops at "is this record
 * internally consistent" and leaves "could the transition machine have reached
 * this whole block" to the layers that read the block as a machine state
 * (see review-dispute-validation.ts on `resolvedWithoutChanges`).
 *
 * Every one of them fails CLOSED rather than being repaired or ignored. A
 * contradictory block has two readings and no way to choose between them; the
 * one thing that must not happen is dispatching an agent run on the reading
 * that happens to be checked first.
 */
function contradiction(context: ReviewDisputeContext, limits: ReviewDisputeLimits): PendingDisputeTurn | null {
  const entries = Object.values(context.lineages) as PersistedLineage[];

  // Per-lineage reachability first: the block-level facts below are readings of
  // a set of lineage records, and a record the transition table could not have
  // written makes every one of those readings meaningless. Sorted by id so the
  // refusal a corrupted block returns does not depend on insertion order.
  for (const entry of [...entries].sort((a, b) => a.lineageId.localeCompare(b.lineageId))) {
    const locator = unreachableLineage(entry, limits);
    if (locator !== null) {
      return unresolvable("invalid-state-record", `reviewDispute.lineages[${entry.lineageId}]${locator}`);
    }
  }

  // §13: `legacy` means the admitting review emitted no structured finding, so a
  // lineage cannot exist under it. review-legacy-compat.ts tolerates this
  // combination because it only decides which PROSE to carry into a prompt and
  // ignoring the block is the conservative answer there; here the block would
  // decide whether to dispatch a debate turn, and "the review had no findings"
  // and "here are its live findings" cannot both be acted on.
  if (context.reviewStructure === "legacy" && entries.length > 0) {
    return unresolvable("invalid-state-record", `reviewDispute.reviewStructure:legacy-with-${entries.length}-lineages`);
  }

  if (context.resolvedWithoutChanges === true) {
    // Rule 4 is the ONLY writer of this flag, and it fires only when every
    // lineage is terminal with none of them escalated: rule 1 and rule 2 both
    // shadow it. Each of the three combinations below is therefore a state the
    // aggregation would have to contradict to route at all.
    if (entries.length === 0) {
      return unresolvable("invalid-state-record", "reviewDispute.resolvedWithoutChanges:no-lineages");
    }
    const live = entries.filter((entry) => !isTerminalLineageState(entry.state));
    if (live.length > 0) {
      return unresolvable("invalid-state-record", `reviewDispute.resolvedWithoutChanges:${live.length}-live-lineages`);
    }
    if (entries.some((entry) => entry.state === "escalated_human")) {
      return unresolvable("invalid-state-record", "reviewDispute.resolvedWithoutChanges:escalated");
    }
    if (entries.some((entry) => entry.reopenRequested === true)) {
      return unresolvable("invalid-state-record", "reviewDispute.resolvedWithoutChanges:reopen-requested");
    }
    // Rule 4 names `resolved_withdrawn`/`resolved_overruled` only, "since every
    // `resolved_fixed` lineage implies a diff" (§3.4) — and a diff owes an
    // ordinary review, either this run's (rule 3) or one deferred as
    // `pendingReReview`, which the record validator already refuses to pair with
    // this flag. So a `resolved_fixed` lineage under a zero-change claim with no
    // re-review pending has two readings: the fix was reviewed by an ordinary
    // review in an EARLIER cycle and the terminal lineage is merely still on file
    // (§2.2 keeps terminal lineages), or the diff was never reviewed at all.
    // Persisted state records nothing that separates them, and the second reading
    // would report a task with an unreviewed diff as resolved and send it
    // straight to a human, skipping the review §7.1 makes mandatory — so the pair
    // fails closed like every other ambiguity here. The cost is accepted
    // knowingly: a task that legitimately re-reaches rule 4 in a later cycle
    // while an old `resolved_fixed` lineage is on file refuses instead of
    // reporting `resolved_without_changes`. That refusal is a stop, not a
    // discharge — the lineages keep their state and a human sees the task with
    // its diff still unmerged, which is the recoverable direction.
    const fixed = entries.filter((entry) => entry.state === "resolved_fixed");
    if (fixed.length > 0) {
      return unresolvable("invalid-state-record", `reviewDispute.resolvedWithoutChanges:${fixed.length}-resolved-fixed`);
    }
  }

  return null;
}

/**
 * Map §7.1 aggregation onto the dispatch-shaped union.
 *
 * The `never` bindings are load-bearing rather than defensive noise: they are
 * what makes a token added to `DisputeTaskOutcome` or `DisputeTaskTurn` a
 * compile error here until it has been given a sub-turn, which is the whole
 * "cannot silently fall through to an ordinary review handler" guarantee. The
 * runtime refusal beside each of them covers the case the compiler cannot: a
 * value that reached this build from a differently-versioned one.
 */
function turnFromRouting(routing: DisputeTaskRouting): PendingDisputeTurn {
  switch (routing.outcome) {
    case "human_handoff": {
      const reasons: DisputeHumanHandoffReason[] = [];
      if (routing.escalatedLineageIds.length > 0) reasons.push("lineage_escalated_human");
      if (routing.reopenRequestedLineageIds.length > 0) reasons.push("reopen_requested");
      return {
        kind: "human_handoff",
        rule: 1,
        reasons,
        escalatedLineageIds: routing.escalatedLineageIds,
        reopenRequestedLineageIds: routing.reopenRequestedLineageIds,
      };
    }
    case "continue": {
      switch (routing.turn) {
        case "implementer":
          return { kind: "implementer_fix", rule: 2, lineageIds: routing.actionableLineageIds };
        case "reviewer":
          return { kind: "reviewer_reconsideration", rule: 2, lineageIds: routing.actionableLineageIds };
        case "evidence":
          return {
            kind: "evidence_collection",
            rule: 2,
            lineageIds: routing.actionableLineageIds,
            parties: EVIDENCE_COLLECTION_PARTIES,
          };
        case "runner":
          return { kind: "runner_arbitration", rule: 2, lineageIds: routing.actionableLineageIds };
        // `re_review` and `none` belong to rules 3 and 4; rule 2 never names
        // them. Reaching one here means the aggregation disagreed with itself,
        // so no turn is dispatched.
        case "re_review":
        case "none":
          return unresolvable("invalid-state-record", `routing.turn:${routing.turn}-under-continue`);
        default: {
          const unexpected: never = routing.turn;
          return unresolvable("invalid-state-record", `routing.turn:${String(unexpected)}`);
        }
      }
    }
    case "re_review":
      // The flag is read from the block rather than from this run, because the
      // selector has no run: a `pendingReReview` block is a diff an earlier run
      // of this cycle deferred, and that is the only way rule 3 is reachable
      // from persisted state alone.
      return { kind: "re_review", rule: 3, deferred: true };
    case "resolved_without_changes":
      return noTurn("resolved_without_changes", 4);
    case "no_change_run_invalid":
      return noTurn("no_change_run_invalid", 4);
    case "legacy":
      return noTurn("legacy_review");
    default: {
      const unexpected: never = routing.outcome;
      return unresolvable("invalid-state-record", `routing.outcome:${String(unexpected)}`);
    }
  }
}

/**
 * Select the §7.1 sub-turn a task's persisted dispute state requires next.
 *
 * Pure: the input is the stored block and the session's gate and limits, the
 * output is one value, and nothing is read or written on the way.
 *
 * The block is read as a state to ACT on, so it is validated first and any
 * refusal is returned as `unresolvable` — the selector never repairs, defaults,
 * or partially trusts a block, because every one of those would end in an agent
 * run dispatched against a debate the runner has misread. `unresolvable` is a
 * stop, not a discharge: the lineages keep their persisted state, no counter
 * moves, and the caller's existing park (§9) still applies.
 */
export function selectPendingDisputeTurn(input: PendingDisputeTurnInput): PendingDisputeTurn {
  if (!input.enabled) return noTurn("protocol_disabled");
  if (input.persisted === undefined || input.persisted === null) return noTurn("no_dispute_state");

  const limits = input.limits ?? REVIEW_DISPUTE_DEFAULT_LIMITS;
  const validated = validateReviewDisputeContext(input.persisted, "reviewDispute", limits);
  if (!validated.ok) return { kind: "unresolvable", rule: null, failure: validated.failure };

  const contradictory = contradiction(validated.value, limits);
  if (contradictory !== null) return contradictory;

  // No `runProducedFileChanges`: this selector runs BEFORE a turn, not after
  // one, so the only unreviewed diff it can know about is the one the block
  // already records. A caller that has just finished a run must aggregate that
  // run's own outcome through the transition layer, which owns the flag.
  return turnFromRouting(aggregateDisputeRouting(validated.value));
}

/**
 * Does the selected turn need a protocol-only run — one no ordinary phase
 * handler performs on its own?
 *
 * The three members are §7.1's protocol sub-turns, as opposed to the routes the
 * runner already dispatches (`implementer_fix`, `re_review`) and the answers that
 * dispatch nothing at all (`no_turn`, and the two stops). Which of them has an
 * implementation is a separate question and is not asked here: issue #952
 * registered the reviewer's reconsideration, #955 the runner's arbitration, and
 * #964 the per-party evidence collection, and this predicate stays the stable
 * answer to "is a sub-turn implementation what this turn needs" that
 * `disputeSubTurnIdentity` guards on.
 *
 * It parks nothing itself, and rule 1's handoff is excluded because that task is
 * already going to a human on its own terms.
 */
export function disputeTurnAwaitsDispatcher(turn: PendingDisputeTurn): boolean {
  return (
    turn.kind === "reviewer_reconsideration"
    || turn.kind === "evidence_collection"
    || turn.kind === "runner_arbitration"
  );
}
