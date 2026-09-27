/**
 * Issue #963: run ONE party of §7.1's dual-party evidence round, exactly once
 * (docs/review-dispute-contract.md §7 row 22, §7.1, §9, §10.1–§10.3, §12).
 *
 * #962 built the invocation — resolve the party's agent, render #957's bounded
 * prompt, run the agent with no tools, admit the answer — and deliberately
 * stopped short of protocol state: it can be re-run for the same party without
 * changing anything. This module is the step between that invocation and #951's
 * dispatch adapter: the `evidence_collection` {@link DisputeSubTurnRunner} that
 * makes the ROUND resumable and each party exactly-once.
 *
 *  - **the round identity is derived, never invented.** A party answers a round
 *    named by `(lineage, finding version, §6.1 round)` — #956's
 *    `evidenceRoundKey` — with the task as the implicit fourth coordinate. A
 *    restart, a transient retry, and a lost claim all re-derive the same
 *    identity; a §2.2 material revision mints a successor version and therefore
 *    a DISTINCT identity, so stale answers recognize nothing.
 *  - **an admitted answer is reused, never re-bought.** Before anything can
 *    invoke an agent, the persisted round record is consulted: a party whose
 *    collection is already `completed` for this round identity returns its
 *    recorded counts as a synthesized `collected` outcome, whatever claim
 *    recorded them. The dispatch adapter recognizes the same fact one layer
 *    earlier (#951's `party_redelivery`/`party_admitted` replay) and normally
 *    short-circuits before this runner is called at all — this guard is the
 *    defense in depth for a caller that reached the runner another way.
 *  - **only the missing party runs.** {@link selectEvidenceCollectionParty}
 *    (#956) is the resuming dispatcher's selection rule, and this runner serves
 *    whichever party the identity names; together they are "a partial round
 *    resumes from the missing party".
 *  - **transitions persist through one seam.** This runner writes no store and
 *    holds no CAS: the `completed` admission is persisted by #951 from the
 *    `collected` outcome it returns, the `recoverable` stop is persisted by
 *    #951 from the `failed`/`delayed` outcome it returns, and both land in the
 *    same completion transaction as everything else the sub-turn produced — so
 *    a retry can never observe a half-written round.
 *  - **bounded metadata only.** What travels in task context is #962's own
 *    bounded invocation summary — literals, counters, and safe artifact
 *    references — merged PER PARTY under one key, plus the artifact directory
 *    the §10.2 files live in (the same shape `disputeArtifactDir` and the
 *    reconsideration record use, and for the same re-presentation reason). The
 *    agent's output stays in the §10.2 artifacts #962 already wrote.
 *
 * What is deliberately NOT here: the review gate registers this runner through
 * the bundle assembly in `handlers/review-evidence-turn.ts` (issue #964), which
 * owns where the §10.2 records come from; row 22 stays #951's to synthesize
 * once both parties are on record; and the config-gated rollout is a later
 * Issue. Nothing changes for `session.reviewDispute.enabled` false.
 */

import type { ArbiterAgentConfig, ArbiterCandidateResolver } from "../core/review-arbiter-profile.js";
import type { PersistedLineage } from "../core/review-dispute.js";
import type { EvidenceRefResolver } from "../core/review-dispute-validation.js";
import type { EvidencePromptInput } from "../core/review-evidence-prompt.js";
import type {
  DisputeSubTurnFailure,
  DisputeSubTurnFailureKind,
  DisputeSubTurnRequest,
  DisputeSubTurnResult,
  DisputeSubTurnRunner,
} from "../core/review-dispute-dispatch.js";
import type { DisputeEvidenceRoundState } from "../core/review-dispute-evidence-state.js";
import {
  DEFAULT_EVIDENCE_ROUND,
  disputeEvidencePartyRun,
  disputeEvidenceRoundEntry,
  disputeEvidenceRunStatus,
  parseDisputeEvidenceRoundState,
} from "../core/review-dispute-evidence-state.js";
import type { EvidenceCollectionParty } from "../core/review-dispute-turn.js";
import { EVIDENCE_COLLECTION_PARTIES } from "../core/review-dispute-turn.js";
import {
  REVIEW_DISPUTE_EVIDENCE_COLLECTIONS_CONTEXT_KEY,
  mergeEvidenceCollections,
} from "../core/review-dispute-evidence-collections.js";
import type { CommandRunner } from "./command-runner.js";
import type {
  EvidenceCollectionAgentRunner,
  EvidenceCollectionFailure,
  EvidenceCollectionFailureKind,
  EvidenceCollectionInvocationResult,
  EvidencePartyAgentSources,
} from "./review-evidence-collection.js";
import { runEvidenceCollection } from "./review-evidence-collection.js";

// ---------------------------------------------------------------------------
// The per-party execution record
// ---------------------------------------------------------------------------

/**
 * The context key, the merge, and the tolerant directory read all live in
 * `core/review-dispute-evidence-collections.ts` and are re-exported here
 * unchanged for this module's existing consumers.
 *
 * They moved down a layer so `handlers/artifact-dir.ts` can enumerate this
 * record's directories (issue #975 review, P2) without importing this module —
 * an import this module already reaches, transitively, in the other direction.
 */
export {
  REVIEW_DISPUTE_EVIDENCE_COLLECTIONS_CONTEXT_KEY,
  readEvidenceCollectionArtifactDir,
} from "../core/review-dispute-evidence-collections.js";

// ---------------------------------------------------------------------------
// Failure normalization
// ---------------------------------------------------------------------------

/**
 * #962's invocation failures, in the sub-turn adapter's vocabulary.
 *
 * Exhaustive by type, like its #838/#846 siblings in
 * `review-dispute-dispatch.ts`: the `Record` must name every
 * `EvidenceCollectionFailureKind`, so a token added upstream is a compile error
 * here rather than a failure that silently normalizes to nothing. The groupings
 * are the ones routing cares about — could the run have happened
 * (`profile_unavailable`), did the agent produce something inadmissible
 * (`malformed_output`), did the deadline kill it (`timeout`), or did the
 * machinery around it fail.
 */
export const EVIDENCE_COLLECTION_FAILURE_NORMALIZATION: Readonly<
  Record<EvidenceCollectionFailureKind, DisputeSubTurnFailureKind>
> = {
  "party-agent-unresolved": "profile_unavailable",
  "unsupported-agent": "profile_unavailable",
  "cli-unavailable": "profile_unavailable",
  "profile-error": "profile_unavailable",
  // The caller's bundle names something no artifact can be minted for: the
  // request this runner was handed is at fault, not the agent or its profile.
  "invalid-bundle": "invocation_failed",
  "agent-setup-failed": "invocation_failed",
  "agent-failed": "invocation_failed",
  "agent-timeout": "timeout",
  "empty-output": "malformed_output",
  "invalid-response": "malformed_output",
  "artifact-write-failed": "artifact_failed",
  "unsafe-artifact-dir": "artifact_failed",
  "unsafe-artifact-path": "artifact_failed",
};

export function normalizeEvidenceCollectionFailure(
  failure: EvidenceCollectionFailure,
  options: { timedOut?: boolean } = {},
): DisputeSubTurnFailure {
  const kind = EVIDENCE_COLLECTION_FAILURE_NORMALIZATION[failure.kind];
  return {
    // The same rule the other normalizations apply (issue #953): a deadline the
    // runner enforced is a different operational fact from an agent that ran
    // and refused, and only the invocation summary knows which happened.
    kind: options.timedOut === true && kind === "invocation_failed" ? "timeout" : kind,
    detail: failure.detail,
  };
}

// ---------------------------------------------------------------------------
// The runtime
// ---------------------------------------------------------------------------

/** Everything one party's evidence sub-turn needs, as values. */
export interface EvidenceSubTurnRuntime {
  /**
   * #957's bounded prompt input, minus the party — which is the identity's, so
   * the two cannot disagree. Assembled by the caller from the task's own §10.2
   * records; this module adds no bundle content and checks only that it names
   * exactly the selected turn's lineages at their CURRENT versions.
   */
  bundle: Omit<EvidencePromptInput, "party">;
  /** Where this party's agent id may be resolved from. Never a label. */
  agent: EvidencePartyAgentSources;
  /**
   * `task.context.reviewDisputeEvidenceRound`, exactly as persisted and
   * therefore untrusted: the round record this runner's own reuse guard reads.
   * Absent recognizes no reuse, which is the conservative direction here — the
   * dispatch adapter is the enforcement point and fails an unreadable record
   * closed before this runner is called at all.
   */
  evidenceRound?: unknown;
  /**
   * `task.context.reviewDisputeEvidenceCollections`, exactly as persisted and
   * therefore untrusted: the other party's execution record, carried forward so
   * a shallow context merge cannot drop it.
   */
  collections?: unknown;
  /** This run's own artifact directory: the transcripts and the §10.2 records. */
  artifactDir: string;
  /** The session's artifact root; every write is bounded inside it. */
  artifactRoot?: string;
  /** A read-only checkout for §3.3 resolution. The agent never sees it. */
  repoCwd: string;
  /** ISO-8601 date-time with an explicit offset, for the §10.2 record. */
  timestamp: string;
  /** Provider configuration the profile rules read. */
  config?: ArbiterAgentConfig;
  /** Test seam: replaces the whole #962 invocation. */
  invoke?: typeof runEvidenceCollection;
  /** Test seam: replaces the whole agent-profile resolution. */
  resolveProfile?: ArbiterCandidateResolver;
  /** §3.3 resolution seam; resolution is I/O, the admission rule is #957's. */
  resolveEvidenceRef?: EvidenceRefResolver;
  /** Test seam for the repo reads (`git ls-files`); never reaches the agent. */
  runner?: CommandRunner;
  /** Test seam for the agent's own subprocess. */
  agentRunner?: CommandRunner;
  /** Test seam: replaces the whole isolated subprocess invocation. */
  agentInvoke?: EvidenceCollectionAgentRunner;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  now?: () => number;
}

// ---------------------------------------------------------------------------
// Reuse
// ---------------------------------------------------------------------------

function ownLineage(
  lineages: Readonly<Record<string, PersistedLineage>>,
  lineageId: string,
): PersistedLineage | undefined {
  return Object.prototype.hasOwnProperty.call(lineages, lineageId) ? lineages[lineageId] : undefined;
}

/**
 * This party's admitted answer, when the round record already holds one for
 * every lineage the turn covers — the runner-level half of "a completed party
 * is not invoked again for the same evidence-round identity" (issue #963).
 *
 * The conditions are the dispatch adapter's replay conditions restated, so the
 * two layers recognize the same answers: the entry must be the CURRENT round's
 * (same version — a §2.2 material revision is a different identity — and not
 * spent under another run), the party must have COMPLETED, and an identity
 * whose attempt was deliberately bumped past the recorded one is #840's
 * explicit request for a fresh run and reuses nothing.
 *
 * The synthesized outcome carries counts and no references: the references are
 * already persisted on the record in their bounded form, and this outcome only
 * ever reaches an adapter that had no record of its own to compare them with —
 * counts are all it can honestly re-persist. It carries no artifacts and no
 * context either, because those were the first delivery's and are already
 * wherever its completion put them.
 */
function reusableCollection(
  state: DisputeEvidenceRoundState,
  request: DisputeSubTurnRequest,
  party: EvidenceCollectionParty,
): DisputeSubTurnResult | null {
  const attachments: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const lineageId of request.turn.lineageIds) {
    const lineage = ownLineage(request.context.lineages, lineageId);
    if (lineage === undefined) return null;
    const entry = disputeEvidenceRoundEntry(state, lineageId);
    if (entry === undefined || entry.version !== lineage.version) return null;
    if (entry.recordedRunId !== undefined && entry.recordedRunId !== request.identity.runId) return null;
    const run = disputeEvidencePartyRun(entry, party);
    if (run === undefined || disputeEvidenceRunStatus(run) !== "completed") return null;
    if (run.runId !== request.identity.runId && run.attempt < request.identity.attempt) return null;
    attachments[lineageId] = run.attachments;
  }
  return { status: "collected", attachments };
}

// ---------------------------------------------------------------------------
// The sub-turn implementation
// ---------------------------------------------------------------------------

/**
 * Build the §7.1 `evidence_collection` sub-turn implementation for ONE party's
 * run — the party the dispatched identity names.
 *
 * Values in, one typed outcome out. No store, no task key, no CAS, and no
 * write of its own: a `collected` result is what #951 persists as the party's
 * admitted answer (and closes with row 22 once both parties are on record), a
 * `delayed` result releases the claim for a transient retry, and every other
 * failure parks the task with the debate state exactly as it was — in each case
 * with the party's stop recorded as `recoverable` by the adapter, so a resumed
 * phase can tell a party that never ran from one whose attempt stopped.
 */
export function createEvidenceCollectionSubTurnRunner(runtime: EvidenceSubTurnRuntime): DisputeSubTurnRunner {
  const invoke = runtime.invoke ?? runEvidenceCollection;

  return (request: DisputeSubTurnRequest): DisputeSubTurnResult => {
    // §7.1 dispatches one run PER PARTY, and the identity is where the party is
    // named. The adapter refuses a party-less evidence identity before this
    // runner exists to it; this is the guard for a caller that arrived another
    // way, because the value below keys everything the run records.
    const party = request.identity.party;
    if (party === null || !EVIDENCE_COLLECTION_PARTIES.includes(party)) {
      return {
        status: "failed",
        failure: { kind: "invalid_identity", detail: `identity.party:${party ?? "absent"}` },
      };
    }

    // (1) Reuse before anything that could invoke an agent: an answer this
    // party already delivered for this round identity is returned from the
    // record, not re-bought. An unreadable round record recognizes nothing and
    // falls through — the adapter is the layer that fails it closed.
    const prior = parseDisputeEvidenceRoundState(runtime.evidenceRound);
    if (prior.ok) {
      const reused = reusableCollection(prior.value, request, party);
      if (reused !== null) return reused;
    }

    // (2) The bundle must be THIS turn's, at the block's CURRENT versions. §7.1
    // dispatches one run covering every lineage in `evidence_requested`, so a
    // bundle naming a different lineage set answers a different question; and a
    // brief built against a version the lineage has left is the stale-evidence
    // case this issue exists to close — the finding was materially revised
    // after the bundle was assembled, and a run over it would collect evidence
    // about prose the debate has already replaced.
    const briefs = new Map(runtime.bundle.lineages.map((brief) => [brief.lineageId, brief] as const));
    if (briefs.size !== runtime.bundle.lineages.length) {
      // The Map collapses duplicates, so presence/version checks below would
      // pass while the invocation still receives the duplicated array — the
      // agent would see the finding twice and answer a non-exact bundle.
      const seen = new Set<string>();
      const duplicate = runtime.bundle.lineages.find((brief) => {
        if (seen.has(brief.lineageId)) return true;
        seen.add(brief.lineageId);
        return false;
      });
      return {
        status: "failed",
        failure: {
          kind: "invalid_identity",
          detail: `bundle.lineages:${duplicate?.lineageId}:duplicate`,
        },
      };
    }
    for (const lineageId of request.turn.lineageIds) {
      const brief = briefs.get(lineageId);
      if (brief === undefined) {
        return {
          status: "failed",
          failure: { kind: "invalid_identity", detail: `bundle.lineages:${lineageId}:absent` },
        };
      }
      const lineage = ownLineage(request.context.lineages, lineageId);
      if (lineage !== undefined && brief.version !== lineage.version) {
        return {
          status: "failed",
          failure: { kind: "stale_lineage", detail: `bundle.lineages:${lineageId}:version:${brief.version}` },
        };
      }
    }
    const foreign = runtime.bundle.lineages.find((brief) => !request.turn.lineageIds.includes(brief.lineageId));
    if (foreign !== undefined) {
      // A bundle asking about a lineage the turn does not cover would have the
      // agent answer a question §7 row 22 cannot record — the adapter would
      // refuse the count as malformed output AFTER the invocation was spent.
      return {
        status: "failed",
        failure: { kind: "invalid_identity", detail: `bundle.lineages:${foreign.lineageId}:unselected` },
      };
    }

    // (3) The invocation. #962 owns everything from here to the parsed answer,
    // and it never throws by contract; the catch is for a build that does,
    // which is still owed the typed no-state-change outcome §12 defines.
    let result: EvidenceCollectionInvocationResult;
    try {
      result = invoke({
        party,
        bundle: runtime.bundle,
        agent: runtime.agent,
        lineages: request.context.lineages,
        run: {
          // The sub-turn's derived run id and attempt, so the §10.2 records'
          // run keys and the round record #951 writes are one identity.
          runId: request.identity.runId,
          attempt: request.identity.attempt,
          round: DEFAULT_EVIDENCE_ROUND,
          timestamp: runtime.timestamp,
        },
        artifactDir: runtime.artifactDir,
        ...(runtime.artifactRoot === undefined ? {} : { artifactRoot: runtime.artifactRoot }),
        repoCwd: runtime.repoCwd,
        limits: request.limits,
        ...(runtime.config === undefined ? {} : { config: runtime.config }),
        ...(runtime.resolveProfile === undefined ? {} : { resolveProfile: runtime.resolveProfile }),
        ...(runtime.resolveEvidenceRef === undefined ? {} : { resolveEvidenceRef: runtime.resolveEvidenceRef }),
        ...(runtime.runner === undefined ? {} : { runner: runtime.runner }),
        ...(runtime.agentRunner === undefined ? {} : { agentRunner: runtime.agentRunner }),
        ...(runtime.agentInvoke === undefined ? {} : { agentInvoke: runtime.agentInvoke }),
        ...(runtime.env === undefined ? {} : { env: runtime.env }),
        ...(runtime.timeoutMs === undefined ? {} : { timeoutMs: runtime.timeoutMs }),
        ...(runtime.now === undefined ? {} : { now: runtime.now }),
      });
    } catch (err) {
      // Only the error's NAME travels (§10.3).
      return {
        status: "failed",
        failure: { kind: "internal_error", detail: err instanceof Error ? err.name : typeof err },
      };
    }

    // The bounded execution record this run leaves beside the round state:
    // #962's own summary contract plus the directory its §10.2 files live in.
    // Written on every delivered outcome — a failed run's record is exactly the
    // one an operator goes looking for.
    const context = {
      [REVIEW_DISPUTE_EVIDENCE_COLLECTIONS_CONTEXT_KEY]: mergeEvidenceCollections(runtime.collections, party, {
        artifactDir: runtime.artifactDir,
        timestamp: runtime.timestamp,
        summary: result.summary,
      }),
    };

    switch (result.outcome) {
      case "completed":
      case "invalid_response": {
        // §7 row 22 fires when "the round's runs complete with none" as well as
        // when attachments were recorded, and #957 defines the unreadable
        // envelope as advisory rather than a run failure: a party that ran and
        // answered unreadably COMPLETES with whatever was admitted (possibly
        // nothing), while "could not be read" survives into the execution
        // record instead of blocking the bounded round forever. #962's parsed
        // outcome travels verbatim where there was one.
        const collection = result.collection;
        return {
          status: "collected",
          attachments: collection === null ? {} : collection.attachments,
          ...(collection === null ? {} : { references: collection.references, dropped: collection.dropped }),
          artifacts: result.artifacts,
          context,
        };
      }
      case "transient_failure":
        // The host or the provider refused this attempt; another attempt may
        // work, so the claim is released rather than parked. The adapter
        // records the party as `recoverable` on the round in the same
        // completion, which is what the resumed selection reads.
        return {
          status: "delayed",
          failure: normalizeEvidenceCollectionFailure(result.failure ?? { kind: "agent-failed", detail: null }, {
            timedOut: result.summary.timedOut,
          }),
          artifacts: result.artifacts,
          context,
        };
      case "timeout":
      case "permanent_failure":
        return {
          status: "failed",
          failure: normalizeEvidenceCollectionFailure(result.failure ?? { kind: "agent-failed", detail: null }, {
            timedOut: result.summary.timedOut,
          }),
          artifacts: result.artifacts,
          context,
        };
      default: {
        const unexpected: never = result.outcome;
        return {
          status: "failed",
          failure: { kind: "internal_error", detail: `outcome:${String(unexpected)}` },
        };
      }
    }
  };
}
