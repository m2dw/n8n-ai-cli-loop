/**
 * Issue #954: resolve ONE arbiter execution profile for a §7.1 `runner_arbitration`
 * sub-turn and — when one is selected — run it, as VALUES
 * (docs/review-dispute-contract.md §7.1, §8.2, §8.3, §10.2).
 *
 * Everything this slice needs already existed and none of it was connected:
 *
 *  - #950 answers "which sub-turn must run next", and its arbitration variant
 *    names the `arbitration_pending` lineages the runner must advance;
 *  - #951 derives the replay-safe run coordinates every artifact and ledger entry
 *    keys on, and hands an implementation values only;
 *  - #839 decides which agent is independent enough to arbitrate, or says in a
 *    typed value why there is none;
 *  - #846 runs that agent against a bounded bundle, with no tool surface, in a
 *    throwaway cwd, under a credential-stripped environment, and returns one
 *    validated verdict without touching a store.
 *
 * This module is the seam between them, and deliberately stops one step short of
 * the seam #952 completed for the reviewer's turn. It returns neither a
 * `DisputeTransitionDecision` nor a `DisputeSubTurnResult`, and it registers
 * nothing in {@link DisputeSubTurnRegistry}: #955 owns `routeArbitrationOutcome()`,
 * the row 13/14/18/19/20/21/22 semantics it produces, and the registry entry.
 * Splitting there avoids a registered runner that can invoke an arbiter but
 * cannot legally return the shape `dispatchDisputeSubTurn()` requires — which
 * would be a turn that spends a lineage's arbitration budget and then parks.
 *
 * Three properties are the point of this file:
 *
 *  - **the ordinary review and implementation agents are never invoked.** The
 *    only agent that runs is the one #839 selected, invoked through #846 with the
 *    profile's own `cmd`/`argv`; an unresolvable, unavailable, or
 *    same-provider-disallowed candidate list produces a typed value, never a
 *    substitution. §8.3's last sentence — "absence of an arbiter never silently
 *    converts to 'reviewer wins' or 'implementer wins'" — is the whole reason the
 *    failure paths here are values rather than fallbacks.
 *  - **one call arbitrates exactly one lineage.** #846 and
 *    `ArbitrationRouteDecision` are single-lineage contracts, and a turn may carry
 *    several. The first still-`arbitration_pending` id in the selector's sorted
 *    set is taken, the rest are left for the next selector/dispatch cycle — the
 *    same rule #952 follows for a turn carrying several `disputed` lineages.
 *  - **nothing is mutated.** No TaskStore, no OutboxStore, no lineage, no counter,
 *    no transition ledger, and not the block handed in: the §10.1 context is read,
 *    the §10.2 artifacts are written by #846 into the run's OWN directory, and
 *    what travels back is a closed union of values.
 *
 * The isolation contract is #846's and is not restated here: this module supplies
 * inputs and never builds an agent invocation, so there is no second place where
 * the no-tools posture could weaken. The issue worktree is read by THIS process
 * (evidence resolution and excerpting), exactly as the fix and review runs read
 * it; the arbiter still sees only the rendered bundle.
 */

import type { CommandRunner } from "./command-runner.js";
import { runReviewArbitration } from "./review-arbitration.js";
import type {
  ArbitrationEvidenceAttachment,
  ArbitrationInvocationInput,
  ArbitrationInvocationResult,
  ArbitrationInvocationSummary,
  ArbitrationProfileSummary,
} from "./review-arbitration.js";
import { resolveArbiterExecutionProfile } from "../core/review-arbiter-profile.js";
import type {
  ArbiterCandidateRejection,
  ArbiterCandidateResolver,
  ArbiterPartyIdentity,
  ArbiterPartyInput,
  ArbiterProfileResolution,
} from "../core/review-arbiter-profile.js";
import type { ArbitrationRouteOutcome } from "../core/review-arbitration-route.js";
import type { PersistedLineage, ResolvedReviewDisputeSettings } from "../core/review-dispute.js";
import type { DisputeArtifact } from "../core/review-dispute-persistence.js";
import {
  DISPUTE_SUB_TURN_REQUIRED_STATES,
  DISPUTE_SUB_TURN_TASK_TURNS,
  disputeSubTurnRunKey,
  normalizeArbitrationFailure,
} from "../core/review-dispute-dispatch.js";
import type { DisputeSubTurnFailure, DisputeSubTurnRequest } from "../core/review-dispute-dispatch.js";
import type { DisputeTaskTurn } from "../core/review-dispute-transition.js";

/** The context key this turn's bounded summary lives under. */
export const REVIEW_DISPUTE_ARBITRATION_CONTEXT_KEY = "reviewDisputeArbitration";

/** The one sub-turn kind this adapter serves. */
const ARBITRATION_TURN = "runner_arbitration" as const;

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

/**
 * Everything the invocation needs that is NOT in the sub-turn request.
 *
 * The request carries the debate (turn, identity, validated §10.1 block, §6.1
 * limits); this carries the run — who the parties were, where the artifacts of
 * the earlier turns are, and which checkout to resolve evidence against. Both are
 * values: nothing here is a store, a task key, or a lease.
 */
export interface ArbitrationSubTurnRuntime {
  /**
   * The session's resolved §6.1/§8.3 settings. `enabled` gates the protocol and
   * `arbiter` is the ordered candidate policy #839 evaluates — passed resolved,
   * never as raw config, so an unusable configuration has already failed at the
   * session boundary.
   */
  settings: ResolvedReviewDisputeSettings;
  /**
   * The implementer, from the provenance the FIX run that rebutted recorded
   * (`task.context.reviewDisputeParties.implementation`), falling back to the
   * persisted assignment (`context.assignment.implementationAgent`) for a debate
   * older than that key — never a GitHub agent label, which is an input to
   * assignment and can disagree with what the task resolved.
   *
   * Single-valued, so it names the LAST fix run; the per-lineage
   * `reviewDisputeRebuttals` record supersedes it for the lineage actually
   * selected, since separate fix runs can rebut separate lineages under
   * different agents (issue #955 review, P1).
   */
  implementation: ArbiterPartyInput;
  /**
   * The reviewer whose record is being arbitrated: the reconsideration's own
   * resolved profile, else the review run that raised the finding — never
   * `session.defaults.reviewAgent`, and never the profile THIS later run
   * resolved. A label override, a flow profile, or an operator reconfiguring the
   * task between the reconsideration and the arbitration can all have moved the
   * review lane, and an arbiter proven independent of the CURRENT lane while
   * sharing a provider with the run that produced the finding is not independent
   * at all (§8.3; issue #955 review, P1).
   */
  review: ArbiterPartyInput;
  /**
   * Resolves one configured agent id to an invocable arbiter profile. Explicit
   * and never defaulted: it is what makes CLI availability an injected FACT
   * rather than a probe this module runs, and it keeps the selection policy
   * agent-agnostic.
   */
  resolveCandidate: ArbiterCandidateResolver;
  /** The authoritative Issue contract the finding is measured against (§4.1). */
  issueBody: string;
  /**
   * The directory holding `dispute-<lineageId>.json` — the FIX run's artifact
   * directory, carried forward as `task.context.disputeArtifactDir`.
   *
   * That key names the last fix run, which is the right directory only when one
   * run rebutted every lineage; the per-lineage `reviewDisputeRebuttals` record
   * supersedes it for the selected lineage (issue #955 review, P1).
   */
  disputeArtifactDir: string;
  /**
   * The directory holding `reconsideration-<lineageId>.json` — the REVIEWER
   * sub-turn's own run directory.
   *
   * Required even for a lineage whose reviewer round was skipped (§7 row 25,
   * `counters.reconsiderations === 0`): #846 decides whether the record is
   * expected from the block's own counter, and an empty directory string would
   * turn its read into a relative-path read of whatever the process's working
   * directory happens to be. Callers with no reviewer run to point at pass their
   * own run directory.
   */
  reconsiderationArtifactDir: string;
  /** The review run's directory, holding `review-findings.json`. Optional. */
  reviewArtifactDir?: string;
  /** THIS run's artifact directory: the bundle manifest, transcript, and verdict. */
  artifactDir: string;
  /** The session's artifact root; every read and write is bounded inside it. */
  artifactRoot: string;
  /**
   * The issue worktree, used as READ-ONLY evidence input by this process. The
   * arbiter never sees it: §8.2's boundary is #846's and is unchanged here.
   */
  repoCwd: string;
  /** ISO-8601 date-time with an explicit offset, for the §10.2 verdict record. */
  timestamp: string;
  /** Bounded diff hunks touching the finding's boundary (§8.2). Optional. */
  diffExcerpt?: string;
  /** Verification evidence the runner captured for this lineage. */
  verificationEvidence?: readonly string[];
  /** §7 row 22: the admitted attachments of the one permitted evidence round. */
  evidenceRoundAttachments?: readonly ArbitrationEvidenceAttachment[];
  /** Test seam: replaces the whole #846 invocation. */
  invoke?: typeof runReviewArbitration;
  /** Test seam for the repo reads (`git ls-files`); never reaches the agent. */
  runner?: CommandRunner;
  /** Test seam for the agent's own subprocess; see #846's own contract. */
  agentRunner?: CommandRunner;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Bounded output
// ---------------------------------------------------------------------------

/** A party's identity as the §8.3 policy saw it. Literals only. */
export interface ArbitrationPartySummary {
  role: ArbiterPartyIdentity["role"];
  agentId: string;
  provider: string;
  /** `null` means the party's run metadata carried no comparable model, not none. */
  model: string | null;
}

function summarizeParty(identity: ArbiterPartyIdentity): ArbitrationPartySummary {
  return {
    role: identity.role,
    agentId: identity.agentId,
    provider: identity.provider,
    model: identity.model,
  };
}

/**
 * The §8.3 policy this resolution was decided under.
 *
 * Recorded even when no candidate was acceptable: an operator reading "no
 * acceptable arbiter" is owed the list that was tried and the two switches that
 * decided it, and neither survives anywhere else in a rejection-only outcome.
 */
export interface ArbitrationPolicySummary {
  candidates: string[];
  allowSameProvider: boolean;
  minConfidence: number;
}

/**
 * What this call did, as one token.
 *
 * Named separately from {@link ArbitrationSubTurnOutcome} rather than indexed off
 * it: the outcome carries the summary, and a summary field that indexed the
 * outcome would close a type-level cycle for no gain.
 */
export const ARBITRATION_SUB_TURN_DISPOSITIONS = ["invoked", "not_invoked", "not_dispatched"] as const;
export type ArbitrationSubTurnDisposition = (typeof ARBITRATION_SUB_TURN_DISPOSITIONS)[number];

/**
 * What may reach task context and run metadata.
 *
 * Names, literals, and counters. The invocation half is #846's own summary, which
 * is already the bounded projection of the run — the rationale travels as a
 * character COUNT, artifacts travel as BASE names, and the profile's `cmd`/`argv`
 * are deliberately absent from it. Nothing here names a directory: the artifact
 * directories are the caller's and stay local.
 */
export interface ArbitrationSubTurnSummary {
  turn: "runner_arbitration";
  /** The §7.1 token, from `DISPUTE_SUB_TURN_TASK_TURNS` rather than restated. */
  taskTurn: DisputeTaskTurn;
  /** The lineages the turn carried, as the selector sorted them. */
  lineageIds: string[];
  /** The one lineage this call answered, or `null` when none could be chosen. */
  lineageId: string | null;
  version: number | null;
  /** `<lineageId>@<version>#<runId>` under the SUB-TURN's derived run id. */
  runKey: string | null;
  disposition: ArbitrationSubTurnDisposition;
  /** #839's answer: `selected`, `human_handoff`, `not_applicable`, or none. */
  profileResolution: ArbiterProfileResolution["kind"] | null;
  /** The handoff/not-applicable reason token; `null` for a selection. */
  profileReason: string | null;
  /** §7 row 19, present only on an unavailable-arbiter handoff. */
  row: number | null;
  policy: ArbitrationPolicySummary;
  /** Every candidate passed over, in configured order (§8.3's audit). */
  candidateRejections: ArbiterCandidateRejection[];
  /** The parties independence was measured against; `null` before selection. */
  parties: { implementation: ArbitrationPartySummary; review: ArbitrationPartySummary } | null;
  /** The selected profile's bounded facts; `null` when nothing was selected. */
  profile: ArbitrationProfileSummary | null;
  /** #846's bounded run summary; `null` when no invocation happened. */
  invocation: ArbitrationInvocationSummary | null;
  /** Why this call produced no verdict, in the sub-turn vocabulary. */
  failure: { kind: DisputeSubTurnFailure["kind"]; detail: string | null } | null;
}

/**
 * One arbitration sub-turn's typed outcome.
 *
 * Closed, and deliberately shaped around what #955 must do next: `route` is
 * already an {@link ArbitrationRouteOutcome}, so the verdict-routing slice hands
 * it to `routeArbitrationOutcome()` with the persisted lineage and gets the §7 row
 * back — nothing has to be rebuilt, re-read, or re-derived from prose.
 *
 *  - `invoked` — the selected arbiter ran and #846 returned a result. `ok: true`
 *    carries an admitted verdict (including a decisive one below `minConfidence`,
 *    which is a routing fact, not a malformed answer); `ok: false` carries a typed
 *    invocation failure. Both route, so both are this one kind.
 *  - `not_invoked` — #839 returned no profile. §8.3's `human_handoff` is row 19;
 *    `not_applicable` is a caller fault (a disabled protocol) and routes to a
 *    fail-closed non-event. No agent ran and no budget was spent.
 *  - `not_dispatched` — this call could not begin: the turn is not an arbitration
 *    turn, every lineage it named has left `arbitration_pending`, a required
 *    artifact directory is absent, or #846 threw. Nothing was resolved and
 *    nothing ran.
 */
export type ArbitrationSubTurnOutcome =
  | {
      kind: "invoked";
      lineageId: string;
      version: number;
      runKey: string;
      /** #839's selection, verbatim — the profile #846 was actually handed. */
      resolution: Extract<ArbiterProfileResolution, { kind: "selected" }>;
      result: ArbitrationInvocationResult;
      /** Ready for `routeArbitrationOutcome()`; #955 applies the row it returns. */
      route: ArbitrationRouteOutcome;
      /** §10.2 bytes #846 already wrote, passed on for a caller that re-persists. */
      artifacts: readonly DisputeArtifact[];
      /** The normalized failure of an `ok: false` result; `null` for a verdict. */
      failure: DisputeSubTurnFailure | null;
      summary: ArbitrationSubTurnSummary;
    }
  | {
      kind: "not_invoked";
      lineageId: string;
      version: number;
      runKey: string;
      resolution: Exclude<ArbiterProfileResolution, { kind: "selected" }>;
      route: ArbitrationRouteOutcome;
      artifacts: readonly [];
      failure: DisputeSubTurnFailure;
      summary: ArbitrationSubTurnSummary;
    }
  | {
      kind: "not_dispatched";
      lineageId: null;
      version: null;
      runKey: null;
      artifacts: readonly [];
      failure: DisputeSubTurnFailure;
      summary: ArbitrationSubTurnSummary;
    };

/** The adapter: values in, one typed outcome out. Never throws, never mutates. */
export type ArbitrationSubTurnAdapter = (request: DisputeSubTurnRequest) => ArbitrationSubTurnOutcome;

// ---------------------------------------------------------------------------
// One lineage
// ---------------------------------------------------------------------------

/**
 * Which `arbitration_pending` lineage this call answers.
 *
 * One per dispatch, deliberately: #846 arbitrates one lineage against one pair of
 * party identities, and #847 routes one row per verdict. A turn carrying several
 * `arbitration_pending` lineages therefore takes several cycles, and §7.1
 * re-selects the arbitration turn for the remainder each time, so nothing is lost
 * and no verdict answers two debates.
 *
 * The turn's lineage ids arrive sorted, so which one goes first is deterministic.
 * A lineage that has left the state is skipped rather than refused: the block may
 * have moved under the selector (another worker's completion, an operator action,
 * this sub-turn's own applied transition on a redelivered claim), and the
 * remaining ones are still owed a run.
 */
export function nextArbitrationLineage(request: DisputeSubTurnRequest): PersistedLineage | null {
  const required = DISPUTE_SUB_TURN_REQUIRED_STATES[ARBITRATION_TURN];
  for (const lineageId of request.turn.lineageIds) {
    const lineage = Object.prototype.hasOwnProperty.call(request.context.lineages, lineageId)
      ? request.context.lineages[lineageId]
      : undefined;
    if (lineage !== undefined && lineage.state === required) return lineage;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Summaries
// ---------------------------------------------------------------------------

function policySummary(settings: ResolvedReviewDisputeSettings): ArbitrationPolicySummary {
  return {
    candidates: [...settings.arbiter.providers],
    allowSameProvider: settings.arbiter.allowSameProvider,
    minConfidence: settings.arbiter.minConfidence,
  };
}

/** Defensive copies: a summary that shares an array with the resolution is not bounded. */
function copyRejections(rejections: readonly ArbiterCandidateRejection[]): ArbiterCandidateRejection[] {
  return rejections.map((rejection) => ({ ...rejection }));
}

function copyProfile(profile: ArbitrationProfileSummary): ArbitrationProfileSummary {
  return { ...profile, sharedProviderWith: [...profile.sharedProviderWith] };
}

function copyInvocation(summary: ArbitrationInvocationSummary): ArbitrationInvocationSummary {
  return {
    ...summary,
    profile: copyProfile(summary.profile),
    verdict:
      summary.verdict === null
        ? null
        : { ...summary.verdict, ignoredFindingShapedFields: [...summary.verdict.ignoredFindingShapedFields] },
  };
}

interface SummaryParts {
  request: DisputeSubTurnRequest;
  settings: ResolvedReviewDisputeSettings;
  lineageId: string | null;
  version: number | null;
  runKey: string | null;
  disposition: ArbitrationSubTurnDisposition;
  resolution: ArbiterProfileResolution | null;
  invocation: ArbitrationInvocationSummary | null;
  failure: DisputeSubTurnFailure | null;
}

function summarize(parts: SummaryParts): ArbitrationSubTurnSummary {
  const resolution = parts.resolution;
  const selected = resolution !== null && resolution.kind === "selected" ? resolution.profile : null;
  return {
    turn: ARBITRATION_TURN,
    taskTurn: DISPUTE_SUB_TURN_TASK_TURNS[ARBITRATION_TURN],
    lineageIds: [...parts.request.turn.lineageIds],
    lineageId: parts.lineageId,
    version: parts.version,
    runKey: parts.runKey,
    disposition: parts.disposition,
    profileResolution: resolution === null ? null : resolution.kind,
    profileReason: resolution === null || resolution.kind === "selected" ? null : resolution.reason,
    row: resolution !== null && resolution.kind === "human_handoff" ? resolution.row : null,
    policy: policySummary(parts.settings),
    candidateRejections: resolution === null ? [] : copyRejections(resolution.rejections),
    parties:
      selected === null
        ? null
        : {
            implementation: summarizeParty(selected.implementation),
            review: summarizeParty(selected.review),
          },
    // The profile the INVOCATION recorded when there was one, so the summary and
    // the §10.2 verdict record cannot disagree about which arbiter ran; #839's own
    // projection otherwise. Both are the same bounded field set, and neither
    // carries `cmd` or `argv`.
    profile:
      parts.invocation !== null
        ? copyProfile(parts.invocation.profile)
        : selected === null
          ? null
          : {
              agentId: selected.agentId,
              provider: selected.provider,
              ...(selected.model === undefined ? {} : { model: selected.model }),
              ...(selected.effort === undefined ? {} : { effort: selected.effort }),
              ...(selected.maxBudgetUsd === undefined ? {} : { maxBudgetUsd: selected.maxBudgetUsd }),
              toolPolicy: selected.toolPolicy,
              candidateIndex: selected.candidateIndex,
              minConfidence: selected.minConfidence,
              sameProviderFallback: selected.sameProviderFallback,
              sharedProviderWith: [...selected.sharedProviderWith],
            },
    invocation: parts.invocation === null ? null : copyInvocation(parts.invocation),
    failure: parts.failure === null ? null : { kind: parts.failure.kind, detail: parts.failure.detail },
  };
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

/**
 * Build the §7.1 arbitration sub-turn adapter for one run.
 *
 * The returned function resolves the arbiter, invokes it when one was selected,
 * and returns values. It applies no transition, spends no counter, and writes
 * nothing to task context — #955 does all three from the outcome it returns.
 */
export function createArbitrationSubTurnAdapter(runtime: ArbitrationSubTurnRuntime): ArbitrationSubTurnAdapter {
  const invoke = runtime.invoke ?? runReviewArbitration;
  return (request: DisputeSubTurnRequest): ArbitrationSubTurnOutcome => {
    const notDispatched = (failure: DisputeSubTurnFailure): ArbitrationSubTurnOutcome => ({
      kind: "not_dispatched",
      lineageId: null,
      version: null,
      runKey: null,
      artifacts: [],
      failure,
      summary: summarize({
        request,
        settings: runtime.settings,
        lineageId: null,
        version: null,
        runKey: null,
        disposition: "not_dispatched",
        resolution: null,
        invocation: null,
        failure,
      }),
    });

    // The dispatch layer checks this too, but this adapter is called directly by
    // #955 and by tests, and a profile resolved for one turn must never be spent
    // on another: an arbitration invocation reads the §8.3 independence proof as
    // settled, and the turn is what settled it.
    if (request.turn.kind !== ARBITRATION_TURN || request.identity.kind !== ARBITRATION_TURN) {
      return notDispatched({
        kind: "invalid_identity",
        detail: `turn.kind:${request.turn.kind}/identity.kind:${request.identity.kind}`,
      });
    }

    const lineage = nextArbitrationLineage(request);
    if (lineage === null) {
      // Every lineage the turn carries has left `arbitration_pending` since it was
      // selected. Nothing to arbitrate and nothing to invent.
      return notDispatched({ kind: "stale_lineage", detail: "turn.lineageIds:none-arbitration-pending" });
    }
    // §10.2's rebuttal and reconsideration records are the bundle's core; without
    // the directories that hold them there is no arbitration to run, and guessing
    // one would read another run's artifacts (or, for an empty string, whatever
    // the process's working directory holds).
    for (const [field, dir] of [
      ["disputeArtifactDir", runtime.disputeArtifactDir],
      ["reconsiderationArtifactDir", runtime.reconsiderationArtifactDir],
    ] as const) {
      if (dir === "") return notDispatched({ kind: "invocation_failed", detail: `${field}:absent` });
    }

    const lineageId = lineage.lineageId;
    const version = lineage.version;
    // The SUB-TURN's derived run id, not the claim's: it is what #840's ledger
    // keys a transition on, so recording it here keeps the §10.2 verdict record's
    // `runKey` and the ledger entry one value across a redelivered claim.
    const runId = request.identity.runId;
    const runKey = disputeSubTurnRunKey(request.identity, lineageId, version);

    // §8.3, decided per lineage. The intent is `arbitration` by construction and
    // not by re-deriving #845: the selector reached this turn BECAUSE the lineage
    // is persisted in `arbitration_pending`, which is the state the typed path
    // moves a lineage into when it directs it to arbitration. #839 still owns
    // every other question — the candidate order, the independence proof, the
    // same-provider opt-in, and the fail-closed handoff.
    const resolution = resolveArbiterExecutionProfile({
      decision: { intent: "arbitration", lineageId },
      settings: runtime.settings,
      implementation: runtime.implementation,
      review: runtime.review,
      resolveCandidate: runtime.resolveCandidate,
    });

    if (resolution.kind !== "selected") {
      // No agent runs, no pass is spent, and neither party wins by default: the
      // resolution travels as #847's own `profile` outcome, which turns a
      // `human_handoff` into row 19 and a `not_applicable` into a fail-closed
      // non-event. The sub-turn failure recorded alongside it is what an operator
      // reads; it is not a transition.
      const failure: DisputeSubTurnFailure = {
        kind: "profile_unavailable",
        detail: `${resolution.kind}:${resolution.reason}`,
      };
      return {
        kind: "not_invoked",
        lineageId,
        version,
        runKey,
        resolution,
        route: { kind: "profile", resolution, run: { runId } },
        artifacts: [],
        failure,
        summary: summarize({
          request,
          settings: runtime.settings,
          lineageId,
          version,
          runKey,
          disposition: "not_invoked",
          resolution,
          invocation: null,
          failure,
        }),
      };
    }

    const input: ArbitrationInvocationInput = {
      selection: resolution,
      pending: { lineageId, version },
      context: request.context,
      issueBody: runtime.issueBody,
      disputeArtifactDir: runtime.disputeArtifactDir,
      reconsiderationArtifactDir: runtime.reconsiderationArtifactDir,
      ...(runtime.reviewArtifactDir === undefined ? {} : { reviewArtifactDir: runtime.reviewArtifactDir }),
      artifactDir: runtime.artifactDir,
      artifactRoot: runtime.artifactRoot,
      repoCwd: runtime.repoCwd,
      run: {
        runId,
        // The arbiter's own id, read off the profile that was selected — never a
        // default and never the review party's: the §10.2 record names who ran.
        agentId: resolution.profile.agentId,
        timestamp: runtime.timestamp,
      },
      limits: request.limits,
      ...(runtime.diffExcerpt === undefined ? {} : { diffExcerpt: runtime.diffExcerpt }),
      ...(runtime.verificationEvidence === undefined
        ? {}
        : { verificationEvidence: runtime.verificationEvidence }),
      ...(runtime.evidenceRoundAttachments === undefined
        ? {}
        : { evidenceRoundAttachments: runtime.evidenceRoundAttachments }),
      ...(runtime.runner === undefined ? {} : { runner: runtime.runner }),
      ...(runtime.agentRunner === undefined ? {} : { agentRunner: runtime.agentRunner }),
      ...(runtime.env === undefined ? {} : { env: runtime.env }),
      ...(runtime.timeoutMs === undefined ? {} : { timeoutMs: runtime.timeoutMs }),
    };

    let result: ArbitrationInvocationResult;
    try {
      result = invoke(input);
    } catch (err) {
      // #846 promises never to throw; a build that does is still owed the typed
      // no-state-change outcome §12 defines. Only the error's NAME travels.
      return notDispatched({
        kind: "internal_error",
        detail: err instanceof Error ? err.name : typeof err,
      });
    }

    // A failed invocation is normalized for the operator record only. It still
    // routes: #847 turns malformed arbiter output into rows 20/21, and treating it
    // as a park here would drop the §12 retry budget the contract defines. The
    // deadline fact comes from the invocation's own summary rather than a detail
    // string, because a killed arbiter and one that ran and exited nonzero are
    // both reported as `agent-failed` (issue #953's lesson, on the arbiter lane).
    const failure = result.ok
      ? null
      : normalizeArbitrationFailure(result.failure, { timedOut: result.summary.timedOut });

    return {
      kind: "invoked",
      lineageId,
      version,
      runKey,
      resolution,
      result,
      route: { kind: "invocation", result },
      artifacts: result.artifacts,
      failure,
      summary: summarize({
        request,
        settings: runtime.settings,
        lineageId,
        version,
        runKey,
        disposition: "invoked",
        resolution,
        invocation: result.summary,
        failure,
      }),
    };
  };
}
