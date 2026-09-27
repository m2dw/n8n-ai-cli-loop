/**
 * Issue #952: the §7.1 reviewer turn, dispatched as an internal sub-turn of the
 * review phase (docs/review-dispute-contract.md §7.1, §8.2, §9, §10.1–§10.3).
 *
 * Everything this slice needs already existed and none of it was connected:
 *
 *  - #950 answers "which sub-turn must run next" from persisted state alone;
 *  - #951 turns ONE selected sub-turn into ONE `PhaseHandlerResult`, applying the
 *    decision through #840 and refusing anything it cannot admit;
 *  - #838 runs the reviewer's reconsideration against a bounded bundle, with no
 *    tool surface, in a throwaway cwd, under a credential-stripped environment;
 *  - #845 classifies a `revise` into the one §7 row it instantiates.
 *
 * What was missing is the seam between them and the real `run-one-phase`
 * runtime, and that is all this module is. It adds no TaskPhase and no workflow
 * lane: §7.1's reviewer turn names the `review` phase, so the reconsideration
 * runs where an ordinary review would have run, as a branch taken BEFORE the
 * ordinary review prompt is built (handlers/review.ts).
 *
 * Three properties are the point of putting it here rather than inside
 * `review.ts`:
 *
 *  - **the ordinary review cannot discharge a `disputed` lineage.** The gate is
 *    a single call that returns either "this is an ordinary review" or a
 *    finished `PhaseHandlerResult`; there is no third answer and no path from a
 *    `disputed` lineage to the generic review prompt. §9's park is the fallback
 *    for every turn this phase cannot ANSWER — a caller that could not supply a
 *    turn's runtime, an unreadable block, an unlocatable §10.2 record. Since
 *    issue #964 all three agent-backed turns have a dispatcher, so that park is
 *    a fail-closed stop rather than the ordinary end of a dispute.
 *  - **no transition is committed here.** The reconsideration returns #838's
 *    admitted record; #951 applies it through #840 and hands back an
 *    application the phase runner folds into the completion transaction it was
 *    already issuing. Nothing in this file touches a store.
 *  - **the isolation boundary is #838's, unchanged.** The issue worktree is used
 *    as read-only evidence input by THIS process — the same way the fix and
 *    review runs read it — and the agent still sees only the rendered bundle.
 *
 * The gate at the bottom of this file is the review phase's ONE entry into the
 * sub-turn layer. Issue #955 added the second turn behind it — the runner's
 * arbitration (`handlers/review-arbitration-subturn.ts`) — and issue #964 the
 * third: the per-party evidence collection (`handlers/review-evidence-turn.ts`),
 * each dispatched when its caller supplied the runtime it needs and parked when
 * it did not. Keeping all three behind one call is deliberate — a second
 * `dispatchDisputeSubTurn` caller would be a second, unreviewed route into the
 * protocol.
 *
 * What travels back into task context is bounded on purpose: literals, counters,
 * artifact BASE names, and the agent's identity/model/effort/tool policy. The
 * resolved profile's `cmd`/`argv` deliberately do not, matching the §10.2 record
 * artifact's own profile projection — a local command line is not protocol state,
 * and the artifact bytes stay in the run directory where #838 wrote them.
 */

import { join } from "path";
import type { CommandRunner } from "./command-runner.js";
import { createArbitrationSubTurnRunner } from "./review-arbitration-subturn.js";
import type { ArbitrationSubTurnRunnerRuntime } from "./review-arbitration-subturn.js";
import { createEvidenceTurnRunner, selectEvidenceTurnParty } from "./review-evidence-turn.js";
import type { EvidenceTurnGateRuntime } from "./review-evidence-turn.js";
import { readBoundedArtifact as readArtifactUnderBound } from "./agent-isolation.js";
import { isSafeArtifactDirAfterRun, RECONSIDERATION_ARTIFACT_DIR_CONTEXT_FIELD } from "./artifact-dir.js";
import { runReviewReconsideration } from "./review-reconsideration.js";
import type {
  ReconsiderationInvocationInput,
  ReconsiderationInvocationResult,
  ReconsiderationInvocationSummary,
  ReconsiderationToolPolicy,
  ResolvedReconsiderationProfile,
} from "./review-reconsideration.js";
import type { CodexConfig } from "../core/session.js";
import type { PhaseHandlerEvent, PhaseHandlerResult } from "../core/phase-runner.js";
import { REVIEW_DISPUTE_RECORD_MAX_BYTES } from "../core/review-dispute.js";
import type { PersistedLineage, ReviewDisputeLimits, ReviewFinding } from "../core/review-dispute.js";
import { REVIEW_FINDINGS_ARTIFACT } from "../core/review-dispute-lineage.js";
import { parseFindingsArtifact } from "../core/review-fix-disposition-prompt.js";
import type { DisputeRoutingState } from "../core/review-dispute-persistence.js";
import {
  REVIEW_DISPUTE_RECONSIDERATION_CONTEXT_KEY,
  REVIEW_DISPUTE_RECONSIDERATIONS_CONTEXT_FIELD,
  mergeReconsiderationLineageRecord,
} from "../core/review-dispute-reconsiderations.js";
import { readRebuttalLineageEntry } from "../core/review-dispute-rebuttals.js";
import { validateReviewDisputeContext } from "../core/review-dispute-validation.js";
import { decideRevision } from "../core/review-revision-decision.js";
import type { RevisionDecision } from "../core/review-revision-decision.js";
import {
  DISPUTE_SUB_TURN_TASK_TURNS,
  REVIEW_DISPUTE_SUB_TURN_CONTEXT_KEY,
  REVIEW_DISPUTE_SUB_TURN_EVENT,
  dispatchDisputeSubTurn,
  disputeSubTurnIdentity,
  normalizeReconsiderationFailure,
} from "../core/review-dispute-dispatch.js";
import type {
  DispatchableDisputeTurn,
  DisputeEvidenceRoundState,
  DisputeSubTurnFailure,
  DisputeSubTurnRequest,
  DisputeSubTurnResult,
  DisputeSubTurnRunner,
} from "../core/review-dispute-dispatch.js";
import { selectPendingDisputeTurn } from "../core/review-dispute-turn.js";
import type { EvidenceCollectionParty } from "../core/review-dispute-turn.js";

// ---------------------------------------------------------------------------
// The §10.2 findings artifact
// ---------------------------------------------------------------------------

/**
 * The recorded §2.1 versions of one lineage, ascending.
 *
 * #845 compares the reviewer's §4.2 successor candidate against the version it
 * revises, and the persisted §10.1 record deliberately holds literals and
 * counters only — the field VALUES live in the review run's
 * `review-findings.json`. One review cycle records at most one version per
 * lineage (§2.2, `validateFindingSet`), so in practice this is the disputed
 * version itself; it is returned as a sorted list because that is the shape
 * `decideRevision` takes, and sorting keeps the answer independent of artifact
 * order.
 *
 * Bounded and fail-soft on the same terms every other cross-run artifact read in
 * this protocol is: an absent, unreadable, oversized, or malformed artifact —
 * including one whose finding SET the §10.2 parser refuses — yields no versions,
 * which #845 reads as "no predecessor on file" and refuses the revision on
 * rather than deciding it against a half-parsed set.
 *
 * `reviewArtifactDir` is task context and therefore untrusted: a stale, escaping,
 * or symlink-traversing directory is dropped BEFORE the read, on exactly the
 * terms #838 drops it for the prompt bundle. Without that gate a crafted external
 * artifact would reach `decideRevision` and could transition a disputed lineage
 * on findings this session never recorded, so an unsafe directory yields no
 * versions rather than someone else's.
 */
export function readLineageFindingVersions(
  artifactRoot: string,
  reviewArtifactDir: string | undefined,
  lineageId: string,
): ReviewFinding[] {
  if (reviewArtifactDir === undefined || reviewArtifactDir === "") return [];
  if (!isSafeArtifactDirAfterRun(artifactRoot, reviewArtifactDir)) return [];
  const read = readArtifactUnderBound(join(reviewArtifactDir, REVIEW_FINDINGS_ARTIFACT), REVIEW_DISPUTE_RECORD_MAX_BYTES);
  if (!read.ok) return [];
  const findings = parseFindingsArtifact(read.raw);
  if (findings === null) return [];
  return findings.filter((finding) => finding.lineageId === lineageId).sort((a, b) => a.version - b.version);
}

// ---------------------------------------------------------------------------
// Bounded projections
// ---------------------------------------------------------------------------

/**
 * The agent's identity as task context may carry it (§10.3).
 *
 * Exactly the fields #838 writes into the §10.2 record's own `profile` block —
 * who ran, under which provider, at which model and effort, and the enforced
 * tool policy. The resolved `cmd`/`argv` are omitted deliberately: they are a
 * local command line, they carry the whole no-tools denylist, and neither is a
 * fact about the debate.
 *
 * `toolPolicy` is the one field here that is a protocol fact rather than a
 * provenance detail (issue #1085): a lineage decided under `read-bounded` was
 * decided by an agent that could read outside the bundle, and §17.6's D2 row
 * requires that to stay visible forever. It is carried verbatim from the resolved
 * profile — never defaulted, never normalized — so a historical `no-tools` record
 * cannot be re-read as `read-bounded`, or the reverse.
 */
export interface ReconsiderationProfileSummary {
  agentId: string;
  provider: string;
  model?: string;
  modelSource: ResolvedReconsiderationProfile["modelSource"];
  effort?: string;
  effortSource: "env" | "default";
  toolPolicy: ReconsiderationToolPolicy;
  role: "reconsideration";
}

function summarizeProfile(summary: ReconsiderationInvocationSummary): ReconsiderationProfileSummary | null {
  const profile = summary.profile;
  if (profile === null) return null;
  return {
    agentId: profile.agentId,
    provider: profile.provider,
    ...(profile.model === undefined ? {} : { model: profile.model }),
    modelSource: profile.modelSource,
    ...(profile.effort === undefined ? {} : { effort: profile.effort }),
    effortSource: profile.effortSource,
    toolPolicy: profile.toolPolicy,
    role: profile.role,
  };
}

/**
 * #845's classification, reduced to the literals an audit record may hold.
 *
 * `candidate` and `declaration` are omitted: both carry the reviewer's §2.1
 * prose, which §11 keeps out of every published surface and §10.3 keeps out of
 * every event. `materiality` keeps its classification and its FIELD NAMES —
 * `changes` carries the compared values and does not travel.
 */
export interface RevisionDecisionSummary {
  intent: RevisionDecision["intent"];
  row: number | null;
  nextState: RevisionDecision["nextState"];
  disputedVersion: number;
  versionAfter: number;
  candidateAdmitted: boolean;
  implementationResponsesGranted: 0 | 1;
  auditEvents: readonly string[];
  materiality: {
    classification: string;
    materialFields: readonly string[];
    ambiguousFields: readonly string[];
    auditEvent: string;
  } | null;
  failure: { reason: string; detail: string | null } | null;
}

function summarizeRevision(decision: RevisionDecision): RevisionDecisionSummary {
  return {
    intent: decision.intent,
    row: decision.row,
    nextState: decision.nextState,
    disputedVersion: decision.disputedVersion,
    versionAfter: decision.versionAfter,
    candidateAdmitted: decision.candidateAdmitted,
    implementationResponsesGranted: decision.implementationResponsesGranted,
    auditEvents: [...decision.auditEvents],
    materiality:
      decision.materiality === null
        ? null
        : {
            classification: decision.materiality.classification,
            materialFields: [...decision.materiality.materialFields],
            ambiguousFields: [...decision.materiality.ambiguousFields],
            auditEvent: decision.materiality.auditEvent,
          },
    failure:
      decision.failure === null ? null : { reason: decision.failure.reason, detail: decision.failure.detail },
  };
}

/**
 * The invocation's own bounded summary: counters, ids, and artifact BASE names.
 *
 * `summary.record` is #838's `ReconsiderationSummary`, which is already the
 * literals-only projection of the admitted record (the rationale travels as a
 * character COUNT). Nothing here names a directory — the artifact directory is
 * the run's and stays local.
 */
function summarizeInvocation(
  summary: ReconsiderationInvocationSummary,
  revision: RevisionDecision | null,
): Record<string, unknown> {
  return {
    lineageId: summary.lineageId,
    version: summary.version,
    runKey: summary.runKey,
    bundleDigest: summary.bundleDigest,
    promptBytes: summary.promptBytes,
    rawOutputBytes: summary.rawOutputBytes,
    excerpts: summary.excerpts,
    unresolvedExcerpts: summary.unresolvedExcerpts,
    exitCode: summary.exitCode,
    timedOut: summary.timedOut,
    artifacts: {
      raw: summary.rawArtifact,
      stderr: summary.stderrArtifact,
      // Only a lane that actually wrote a progress stream names one, so a
      // `no-tools` run's artifact map is the same shape it was before the field
      // existed (issue #1085) rather than gaining a permanently-null key.
      ...(summary.eventsArtifact ? { events: summary.eventsArtifact } : {}),
      runnerError: summary.runnerErrorArtifact,
      record: summary.recordArtifact,
    },
    profile: summarizeProfile(summary),
    record: summary.record,
    failure: summary.failure,
    ...(revision === null ? {} : { revision: summarizeRevision(revision) }),
  };
}

/**
 * The context key the reconsideration's own bounded summary lives under.
 *
 * Declared in `core/review-dispute-reconsiderations.ts` and re-exported here, so
 * the core readers of the value — the §8.3 party recovery and the operator
 * projection — can name the key without importing a handler (issue #1085). Every
 * existing importer of this name is unaffected.
 */
export { REVIEW_DISPUTE_RECONSIDERATION_CONTEXT_KEY };

// The REVIEWER identity this summary carries is read back by the arbitration
// sub-turn through `core/review-dispute-reconsiderations.ts`
// (`readReconsiderationSummaryParty`), which admits it only for the lineage and
// version recorded here — this key is single-valued, and a task with two debates
// would otherwise hand §8.3 the last reviewer run's identity for a lineage that
// run never answered (issue #955 review, P1).

// ---------------------------------------------------------------------------
// The sub-turn implementation
// ---------------------------------------------------------------------------

export interface ReconsiderationSubTurnRuntime {
  /** The authoritative Issue contract the finding is measured against (§4.1). */
  issueBody: string;
  /**
   * The directory holding `dispute-<lineageId>.json` — the FIX run's artifact
   * directory, carried forward as `task.context.disputeArtifactDir`.
   *
   * The LAST fix run's, and therefore a fall-back: see {@link rebuttals}, which
   * supersedes it for the lineage this turn actually answers.
   */
  disputeArtifactDir: string;
  /** The review run's directory, holding `review-findings.json`. Optional. */
  reviewArtifactDir?: string;
  /** THIS run's artifact directory: the raw transcript and the §10.2 record. */
  artifactDir: string;
  /** The session's artifact root; every read and write is bounded inside it. */
  artifactRoot: string;
  /**
   * The issue worktree, used as READ-ONLY evidence input by this process. The
   * agent never sees it: §8.2's boundary is #838's and is unchanged here.
   */
  repoCwd: string;
  /**
   * The original review party — the agent that RAISED the finding, resolved by
   * the caller. Passed explicitly and never defaulted, so an agent with no
   * no-tools invocation fails closed as `profile_unavailable` instead of silently
   * substituting another provider.
   *
   * "Original" is the load-bearing word and it is the CALLER's obligation (issue
   * #1071): §4.1's reconsideration belongs to the reviewer whose finding is
   * disputed, and a whole implementation phase runs in between, so the review
   * phase reads the identity that run recorded (`reviewDisputeParties.review`)
   * before falling back to the lane it resolves today. Handing this the current
   * lane would let a reconfigured session answer for prose it never wrote — the
   * same fault #955 fixed for the arbiter and #962 for the evidence parties.
   */
  agentId: string;
  /**
   * The §17.6 D2 opt-in, resolved from
   * `session.reviewDispute.reconsideration.readBounded` (issue #1085).
   *
   * Absent is false and false is the §17.12 refusal unchanged, so a caller that
   * has not been taught about this setting cannot admit the weaker posture by
   * omission. It decides only whether an agent with no no-tools invocation gets
   * a turn at all; it never changes how a `claude` reviewer is invoked, and it
   * never relabels a posture.
   */
  readBounded?: boolean;
  /** `session.codex`, for the read-bounded lane's §17.7 model row. */
  codex?: CodexConfig;
  /** ISO-8601 date-time with an explicit offset, for the §10.2 record. */
  timestamp: string;
  /**
   * `task.context.reviewDisputeReconsiderations`, exactly as persisted and
   * therefore untrusted: the per-lineage record of every reviewer run this task
   * has taken. Read only to be MERGED with this run's own entry — task context
   * merges shallowly, so a run returning only its own lineage would drop the
   * others' (issue #955 review, P1). Absent is an empty record.
   */
  reconsiderations?: unknown;
  /**
   * `task.context.reviewDisputeRebuttals`, exactly as persisted and therefore
   * untrusted: where each lineage's §10.2 dispute record was written.
   *
   * {@link disputeArtifactDir} is single-valued and names the LAST fix run, but a
   * fix run rebuts only the lineages its own response disputed. With two disputed
   * lineages rebutted in different implementation runs — a row 11 material
   * revision sends one lineage back to the implementer while the other stays
   * disputed — this turn would read `dispute-<lineageId>.json` from a directory
   * that never held it and park a resolvable dispute (issue #955 review, P1).
   *
   * Absent, unreadable, or naming another lineage, the single-valued field
   * stands: that is the pre-record behavior and the right answer for a debate
   * that started before this key existed.
   */
  rebuttals?: unknown;
  /** Test seam: replaces the whole #838 invocation. */
  invoke?: typeof runReviewReconsideration;
  /** Test seam for the repo reads (`git ls-files`); never reaches the agent. */
  runner?: CommandRunner;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

/**
 * Which `disputed` lineage this dispatch answers.
 *
 * One per dispatch, deliberately: #838 runs one reconsideration for one finding,
 * and #840 applies one row per completion — the same "one row per completion"
 * rule the evidence round follows. A turn carrying several `disputed` lineages
 * therefore takes several review runs, and §7.1 re-selects the reviewer turn for
 * the remainder each time, so nothing is lost and no run answers two debates.
 *
 * The turn's lineage ids arrive sorted, so which one goes first is deterministic.
 * A lineage that is no longer `disputed` is skipped rather than refused: the
 * dispatch layer already admitted it (a redelivery this sub-turn's own identity
 * transitioned), and the remaining ones are still owed a run.
 */
function nextDisputedLineage(request: DisputeSubTurnRequest): PersistedLineage | null {
  for (const lineageId of request.turn.lineageIds) {
    const lineage = Object.prototype.hasOwnProperty.call(request.context.lineages, lineageId)
      ? request.context.lineages[lineageId]
      : undefined;
    if (lineage !== undefined && lineage.state === "disputed") return lineage;
  }
  return null;
}

/**
 * The #838 invocation, as a {@link DisputeSubTurnRunner}.
 *
 * Values in, one typed outcome out. No store, no task key, no CAS and no
 * transition: a `completed` result carries #838's admitted record and #845's
 * classification, and #951 is what applies them. Every failure path returns a
 * typed `failed` — normalized from #838's own vocabulary — which parks the task
 * with the debate state untouched.
 */
export function createReconsiderationSubTurnRunner(runtime: ReconsiderationSubTurnRuntime): DisputeSubTurnRunner {
  const invoke = runtime.invoke ?? runReviewReconsideration;
  return (request: DisputeSubTurnRequest): DisputeSubTurnResult => {
    const lineage = nextDisputedLineage(request);
    if (lineage === null) {
      // Every lineage the turn carries has left `disputed` since it was selected.
      // Nothing to reconsider and nothing to invent: the park keeps them where
      // they are.
      return { status: "failed", failure: { kind: "stale_lineage", detail: "turn.lineageIds:none-disputed" } };
    }
    // The fix run that rebutted THIS lineage, when the per-lineage record names
    // one; the single-valued field otherwise. Resolved after the lineage is
    // selected because only the selection makes the question answerable.
    const rebuttal =
      runtime.rebuttals === undefined
        ? undefined
        : readRebuttalLineageEntry(runtime.rebuttals, lineage.lineageId, lineage.version);
    const disputeArtifactDir = rebuttal?.artifactDir ?? runtime.disputeArtifactDir;
    if (disputeArtifactDir === "") {
      // §10.2's rebuttal record is the bundle's core; without the directory that
      // holds it there is no reconsideration to run, and guessing a directory
      // would read another run's artifacts.
      return { status: "failed", failure: { kind: "invocation_failed", detail: "disputeArtifactDir:absent" } };
    }

    // §7.1's reviewer turn, restated in #844's typed routing shape. The lineages
    // are the selector's own answer over the persisted block — not prose, and not
    // a lineage that merely looks disputable — so the turn #950 selected and the
    // turn #838 is asked to run are the same turn by construction.
    const routing: DisputeRoutingState = {
      kind: "pending_reconsideration",
      lineages: [{ lineageId: lineage.lineageId, version: lineage.version }],
      escalatedLineageIds: [],
      pendingReReview: request.context.pendingReReview === true,
    };

    const input: ReconsiderationInvocationInput = {
      routing,
      pending: { lineageId: lineage.lineageId, version: lineage.version },
      context: request.context,
      issueBody: runtime.issueBody,
      disputeArtifactDir,
      ...(runtime.reviewArtifactDir === undefined ? {} : { reviewArtifactDir: runtime.reviewArtifactDir }),
      artifactDir: runtime.artifactDir,
      artifactRoot: runtime.artifactRoot,
      repoCwd: runtime.repoCwd,
      // The reconsideration is applied under the SUB-TURN's derived run id, which
      // is what #840's ledger keys the transition on. Recording the same id here
      // keeps the §10.2 record's `runKey` and the ledger entry one value.
      run: {
        runId: request.identity.runId,
        agentId: runtime.agentId,
        timestamp: runtime.timestamp,
      },
      limits: request.limits,
      agentId: runtime.agentId,
      // The session's D2 posture opt-in, passed through unchanged. #838 resolves
      // the profile from it; nothing here decides which posture applies.
      ...(runtime.readBounded === undefined ? {} : { readBounded: runtime.readBounded }),
      ...(runtime.codex === undefined ? {} : { codex: runtime.codex }),
      ...(runtime.runner === undefined ? {} : { runner: runtime.runner }),
      ...(runtime.env === undefined ? {} : { env: runtime.env }),
      ...(runtime.timeoutMs === undefined ? {} : { timeoutMs: runtime.timeoutMs }),
    };

    let outcome: ReconsiderationInvocationResult;
    try {
      outcome = invoke(input);
    } catch (err) {
      // #838 promises never to throw; a build that does is still owed the typed
      // no-state-change outcome §12 defines. Only the error's NAME travels.
      return {
        status: "failed",
        failure: { kind: "internal_error", detail: err instanceof Error ? err.name : typeof err },
      };
    }

    // The posture THIS run enforced, as the sub-turn audit event may state it
    // (issue #1085 review, P2). Taken off the profile #838 resolved rather than
    // from any session setting: a run that resolved no profile enforced no
    // posture, and the field is then absent — never defaulted to the stricter
    // literal. It travels on the result so `review.dispute.subturn` records it
    // beside the lineage ids the same event already carries, which is what lets
    // an operator read an EARLIER lineage's posture out of event history rather
    // than only the newest one out of the single-valued summary.
    const enforcedToolPolicy = outcome.summary.profile?.toolPolicy;

    if (!outcome.ok) {
      return {
        status: "failed",
        ...(enforcedToolPolicy === undefined ? {} : { toolPolicy: enforcedToolPolicy }),
        // The deadline fact is the invocation's, and only it held the deadline:
        // `normalizeReconsiderationFailure` deliberately takes it as an argument
        // rather than guessing it from a detail string, because #838 reports a
        // killed agent as `agent-failed` exactly like one that ran and exited
        // nonzero. Without it every timeout reached an operator as a run that
        // failed, which is a different thing to go looking for (issue #953).
        failure: normalizeReconsiderationFailure(outcome.failure, { timedOut: outcome.summary.timedOut }),
        artifacts: outcome.artifacts,
        context: { [REVIEW_DISPUTE_RECONSIDERATION_CONTEXT_KEY]: summarizeInvocation(outcome.summary, null) },
      };
    }

    // A `revise` instantiates one of #845's three rows and #840 refuses the
    // decision without it; `withdraw` and `uphold` are rows 9 and 10 and carry
    // none. The classification is computed here — not inside #838, which owns the
    // invocation only — from the recorded §2.1 versions the review run wrote.
    const revision =
      outcome.admitted.record.reconsideration === "revise"
        ? decideRevision({
            admitted: outcome.admitted,
            versions: readLineageFindingVersions(runtime.artifactRoot, runtime.reviewArtifactDir, lineage.lineageId),
            limits: request.limits,
          })
        : null;

    return {
      status: "completed",
      decision: {
        kind: "reconsideration",
        admitted: outcome.admitted,
        ...(revision === null ? {} : { revision }),
      },
      actor: "reviewer",
      ...(enforcedToolPolicy === undefined ? {} : { toolPolicy: enforcedToolPolicy }),
      artifacts: outcome.artifacts,
      context: {
        [REVIEW_DISPUTE_RECONSIDERATION_CONTEXT_KEY]: summarizeInvocation(outcome.summary, revision),
        // The arbitration bundle re-presents this run's §10.2 record
        // (`reconsideration-<lineageId>.json`), and the arbitration sub-turn is a
        // LATER phase run whose own `artifactDir` is a different directory. A
        // dedicated, never-overwritten reference is the same shape
        // `disputeArtifactDir` uses and for the same reason (issue #952): the
        // plain `artifactDir` key is rewritten by every run that touches the
        // task, including one that blocks before reaching its own agent.
        //
        // Never-overwritten by an unrelated run, but still SINGLE-valued, and
        // this turn answers one lineage per review run: a task with two disputed
        // findings takes two reviewer runs, and the second's directory and
        // reviewer identity are not the first's. Both therefore travel per
        // lineage as well, merged over what the earlier runs recorded, and the
        // arbitration turn looks up the lineage it actually selected (issue #955
        // review, P1). The two single-valued keys stay exactly as they were: they
        // are what a debate that started before this record — and every existing
        // reader — still resolves against.
        [RECONSIDERATION_ARTIFACT_DIR_CONTEXT_FIELD]: runtime.artifactDir,
        [REVIEW_DISPUTE_RECONSIDERATIONS_CONTEXT_FIELD]: mergeReconsiderationLineageRecord(
          runtime.reconsiderations,
          lineage.lineageId,
          {
            version: lineage.version,
            artifactDir: runtime.artifactDir,
            // The agent that actually ran, off the profile #838 resolved in THIS
            // run — a first-hand fact here, canonicalized back down to an id
            // alone by every later reader.
            ...(outcome.summary.profile === null ? {} : { agentId: outcome.summary.profile.agentId }),
            // And the posture it enforced, for the same per-lineage reason the
            // directory and the agent id are here: the single-valued summary is
            // rewritten by the next reviewer run, so without this the FIRST
            // lineage's posture would be unreadable from persisted state once a
            // second debate took a turn (issue #1085 review, P2). Verbatim from
            // the resolved profile; absent when there was none.
            ...(enforcedToolPolicy === undefined ? {} : { toolPolicy: enforcedToolPolicy }),
          },
        ),
      },
    };
  };
}

// ---------------------------------------------------------------------------
// The review-phase gate
// ---------------------------------------------------------------------------

/**
 * What the review phase must do with this task's persisted debate state.
 *
 * Two answers and no third: either this is an ordinary review, or the sub-turn
 * layer has already produced the completion. A caller that receives `handled`
 * cannot fall through to the generic review prompt, which is what keeps an
 * ordinary review from discharging a `disputed` lineage.
 */
export type ReviewDisputeSubTurnGate =
  | { kind: "ordinary_review" }
  | { kind: "handled"; result: PhaseHandlerResult };

export interface ReviewDisputeSubTurnInput {
  /** The resolved `session.reviewDispute.enabled` gate, never the raw config. */
  enabled: boolean;
  limits: ReviewDisputeLimits;
  /** `task.context.reviewDispute`, exactly as persisted — untrusted. */
  persisted: unknown;
  /** The phase run's own id; the sub-turn's replay identity derives from it. */
  runId: string;
  /**
   * Bounded task context every returned completion carries — the review phase's
   * own `artifactDir`/`prUrl`/`branch` bookkeeping. The sub-turn's reserved keys
   * always win over it (see `contextPatch` in review-dispute-dispatch.ts).
   */
  baseContext?: Record<string, unknown>;
  /** The invocation runtime; unused on the paths that dispatch nothing. */
  runtime: ReconsiderationSubTurnRuntime;
  /**
   * The §7.1 runner turn's own runtime (issue #955). Optional, and its absence is
   * what decides whether the arbitration turn is DISPATCHED or parked: a caller
   * that cannot name the two parties §8.3 measures independence against, or the
   * directories §8.2's bundle is assembled from, has no arbitration to run — and
   * inventing either would either substitute an arbiter or arbitrate on another
   * run's artifacts. The park is unchanged from before this turn had a
   * dispatcher: nothing moves and a human decides.
   */
  arbitration?: ArbitrationSubTurnRunnerRuntime;
  /**
   * The §7.1 evidence turn's own runtime (issue #964), on exactly the same
   * optional-and-fail-closed terms: a caller that cannot supply the record
   * locators, the checkout, and the party-agent sources #963's per-party run
   * needs has no evidence collection to dispatch, and the turn parks as it did
   * before it had a dispatcher. Which PARTY runs is not the caller's to say —
   * it is selected from the persisted round record at dispatch time
   * (`selectEvidenceTurnParty`), which is what makes a partial round resume
   * with the missing party rather than whichever one the caller assumed.
   */
  evidence?: EvidenceTurnGateRuntime;
}

/**
 * A park this module applies before {@link dispatchDisputeSubTurn} could.
 *
 * Deliberately the SAME summary vocabulary the adapter's own park writes —
 * `turn`/`taskTurn`/`lineageIds`/`disposition`/`failure`/`failureDetail` under
 * the same reserved context key, with the failure kind drawn from
 * `DisputeSubTurnFailureKind`. One key with two shapes would make an operator
 * (and every later reader) parse the key before knowing what it holds.
 */
function parkedTurn(
  turn: DispatchableDisputeTurn | null,
  failure: DisputeSubTurnFailure,
  message: string,
  base: Record<string, unknown> | undefined,
): PhaseHandlerResult {
  const summary: Record<string, unknown> = {
    // `null` only for the §12 refusal below, where the block could not be read
    // well enough to name a turn at all.
    turn: turn === null ? null : turn.kind,
    taskTurn: turn === null ? null : DISPUTE_SUB_TURN_TASK_TURNS[turn.kind],
    lineageIds: turn === null ? [] : [...turn.lineageIds],
    disposition: "parked",
    failure: failure.kind,
    failureDetail: failure.detail,
    ...(failure.protocol === undefined
      ? {}
      : { protocolReason: failure.protocol.reason, protocolDetail: failure.protocol.detail }),
  };
  const event: PhaseHandlerEvent = { type: REVIEW_DISPUTE_SUB_TURN_EVENT, data: summary };
  return {
    result: "blocked",
    context: { ...base, [REVIEW_DISPUTE_SUB_TURN_CONTEXT_KEY]: summary },
    message,
    extraEvents: [event],
  };
}

/** Merge the review phase's own bookkeeping UNDER whatever the sub-turn wrote. */
function withBaseContext(
  result: PhaseHandlerResult,
  base: Record<string, unknown> | undefined,
): PhaseHandlerResult {
  if (base === undefined) return result;
  const context = { ...base, ...(result.context ?? {}) };
  if (result.result === "failed") return { ...result, context };
  if (result.result === "delayed") return { ...result, context };
  return { ...result, context };
}

/**
 * Decide — and, when it is an internal sub-turn's, TAKE — the §7.1 sub-turn
 * this task's persisted state requires, before an ordinary review is built.
 *
 * Three of §7.1's turns dispatch here. `reviewer_reconsideration` is the turn
 * issue #952 wired; `runner_arbitration` is issue #955's; `evidence_collection`
 * is issue #964's, dispatched one PARTY per phase run with the party selected
 * from the persisted round record. Each of the latter two dispatches only when
 * the caller supplied the runtime it needs and parks (§9) otherwise, rather
 * than falling through to a review run that would finish the task with the
 * debate still open.
 *
 * A §12 `unresolvable` block parks for the same reason: it may be hiding a
 * `disputed` lineage, and a review run that reported a clean success over it
 * would discharge a debate nobody answered.
 *
 * Everything else — a disabled session, a task with no block, the §13 legacy
 * path, the two rule-4 zero-change outcomes, the fix turn's own lineages, a
 * deferred re-review — is an ordinary review, byte for byte as before.
 */
export async function runReviewDisputeSubTurn(
  input: ReviewDisputeSubTurnInput,
): Promise<ReviewDisputeSubTurnGate> {
  const turn = selectPendingDisputeTurn({
    enabled: input.enabled,
    persisted: input.persisted,
    limits: input.limits,
  });

  // §12: the persisted block is malformed, contradictory, or unsupported, so
  // which turn is owed cannot be answered — and a `disputed` lineage may be
  // sitting inside it. An ordinary review would then be free to report a clean
  // success and finish the task with that debate still open, which is exactly
  // the wrong-handler discharge §9's park exists to prevent. The park changes
  // nothing: the block stays byte-identical on file for an operator to inspect.
  if (turn.kind === "unresolvable") {
    return {
      kind: "handled",
      result: parkedTurn(
        null,
        { kind: "invalid_context", detail: turn.failure.detail, protocol: turn.failure },
        `Review dispute state could not be read (${turn.failure.reason}); the review phase cannot tell `
          + "which §7.1 turn is owed, so the debate state is unchanged and the task is parked for a human.",
        input.baseContext,
      ),
    };
  }

  // Each agent-backed turn is dispatched only when the caller supplied the
  // runtime it needs; without one there is no run to make and no value to
  // invent, so the turn parks exactly as it did before it had a dispatcher.
  // For the arbitration turn that runtime is §8.2/§8.3's (issue #955); for the
  // evidence turn it is the record locators, checkout, and party-agent sources
  // #963's per-party collection resolves against (issue #964).
  if (
    (turn.kind === "evidence_collection" && input.evidence === undefined)
    || (turn.kind === "runner_arbitration" && input.arbitration === undefined)
  ) {
    return {
      kind: "handled",
      result: parkedTurn(
        turn,
        { kind: "no_implementation", detail: turn.kind },
        `Review dispute ${turn.kind} sub-turn has no dispatcher in the review phase; `
          + "the debate state is unchanged and the task is parked for a human.",
        input.baseContext,
      ),
    };
  }

  if (
    turn.kind !== "reviewer_reconsideration"
    && turn.kind !== "runner_arbitration"
    && turn.kind !== "evidence_collection"
  ) {
    return { kind: "ordinary_review" };
  }

  // Which turn's vocabulary the two park messages below speak. The §7.1 token
  // rather than a hand-written label, so the message and the summary agree.
  const label = DISPUTE_SUB_TURN_TASK_TURNS[turn.kind];

  // The selector validated the block to reach this turn; it returns the turn and
  // not the block, so it is re-validated here for the value #951 compares against.
  // A refusal at this point is unreachable in practice and still fails closed.
  const validated = validateReviewDisputeContext(input.persisted, "reviewDispute", input.limits);
  if (!validated.ok) {
    return {
      kind: "handled",
      result: parkedTurn(
        turn,
        { kind: "invalid_context", detail: validated.failure.detail, protocol: validated.failure },
        `Review dispute ${label} sub-turn could not read the persisted debate state (${validated.failure.reason}); `
          + "the debate state is unchanged and the task is parked for a human.",
        input.baseContext,
      ),
    };
  }

  // §7.1 dispatches one evidence run PER PARTY, and which party this run
  // collects for is the persisted round record's answer, not the caller's: a
  // fresh round starts with the implementer, a partial round resumes with the
  // one party still owed, and a completed-but-unspent round dispatches a party
  // whose delivery the adapter replays into row 22 (issue #964). Selected
  // BEFORE the identity is derived, because the identity — and with it every
  // replay key #951 recognizes — is per-party. A round record that cannot be
  // read parks here rather than restarting a round whose answers it hides.
  let evidenceParty: EvidenceCollectionParty | undefined;
  let evidenceRound: DisputeEvidenceRoundState | undefined;
  if (turn.kind === "evidence_collection" && input.evidence !== undefined) {
    const selection = selectEvidenceTurnParty(turn, validated.value, input.evidence.evidenceRound);
    if (!selection.ok) {
      return {
        kind: "handled",
        result: parkedTurn(
          turn,
          selection.failure,
          `Review dispute ${label} sub-turn could not select a collection party (${selection.failure.kind}); `
            + "the debate state is unchanged and the task is parked for a human.",
          input.baseContext,
        ),
      };
    }
    evidenceParty = selection.party;
    evidenceRound = selection.round;
  }

  const identity = disputeSubTurnIdentity({
    runId: input.runId,
    turn,
    ...(evidenceParty === undefined ? {} : { party: evidenceParty }),
  });
  if (!identity.ok) {
    return {
      kind: "handled",
      result: parkedTurn(
        turn,
        { kind: "invalid_identity", detail: identity.failure.detail, protocol: identity.failure },
        `Review dispute ${label} sub-turn has no derivable run identity (${identity.failure.reason}); `
          + "the debate state is unchanged and the task is parked for a human.",
        input.baseContext,
      ),
    };
  }

  const completion = await dispatchDisputeSubTurn({
    turn,
    context: validated.value,
    identity: identity.value,
    limits: input.limits,
    // One entry per selected turn rather than a table built for all three: the
    // arbitration and evidence runtimes are optional, and a registry carrying
    // an entry the caller could not supply would fail closed one layer later
    // with a less specific reason than the park above.
    runner:
      turn.kind === "evidence_collection" && input.evidence !== undefined
        ? createEvidenceTurnRunner(input.evidence)
        : turn.kind === "runner_arbitration" && input.arbitration !== undefined
          ? createArbitrationSubTurnRunner(input.arbitration)
          : createReconsiderationSubTurnRunner(input.runtime),
    // The round as this run read it, so the adapter's replay and row-22
    // aggregation see the same record the party selection above decided on.
    ...(evidenceRound === undefined ? {} : { evidenceRound }),
  });

  return { kind: "handled", result: withBaseContext(completion.result, input.baseContext) };
}
