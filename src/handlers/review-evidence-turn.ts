/**
 * Issue #964: assemble the runtime one party's evidence run needs, from the
 * task's own §10.2 records, and hand the run to #963's sub-turn implementation
 * (docs/review-dispute-contract.md §3.3, §7 row 22, §7.1, §8.2, §9, §10.1–§10.3).
 *
 * The predecessor stack finished everything below this seam. #957 renders the
 * bounded per-party prompt from an already-assembled bundle; #962 resolves the
 * party's agent and runs it with no tools; #963 makes the round resumable and
 * each party exactly-once (`createEvidenceCollectionSubTurnRunner`); #951's
 * dispatch adapter aggregates the two parties and synthesizes row 22. What none
 * of them owns — deliberately — is where the bundle's CONTENT comes from: §7.1
 * says each run's prompt carries "the lineage's finding versions, the admitted
 * dispute and reconsideration records, and the `insufficient_evidence` verdict
 * record", and those live in three different runs' §10.2 artifact directories.
 * This module is that assembly and nothing more:
 *
 *  - **which party runs is the record's answer, not this run's.** #956's
 *    `selectEvidenceCollectionParty` reads the persisted round: a fresh round
 *    starts with the implementer, a partial round resumes with the one party
 *    still owed, and a round both parties have answered dispatches either —
 *    the dispatch adapter recognizes `round_complete` and closes row 22 without
 *    invoking anyone. An unreadable round record refuses BEFORE a party is
 *    named, because guessing either way reuses or re-buys evidence.
 *  - **every record is located per lineage and re-validated on read.** The
 *    rebuttal comes from the fix run #843 recorded (`reviewDisputeRebuttals`),
 *    the reconsideration from the reviewer run #952 recorded, and the verdict
 *    from the arbitration run #964 records (`reviewDisputeArbitrations`) — each
 *    a dedicated per-lineage locator, each untrusted: the artifact is re-read
 *    under the shared bound and re-checked against the CURRENT block, so a
 *    stale locator parks the turn rather than debating someone else's record.
 *  - **the verdict must be the one that opened the round.** §7 row 16 routes
 *    exactly one verdict token to `evidence_requested`; a located record whose
 *    verdict is decisive, or whose version the lineage has left, is a stale or
 *    foreign record and refuses rather than rendering a prompt around a settled
 *    disagreement (#957 types the brief on exactly these terms).
 *  - **excerpts are this process's reads.** The cited references are resolved
 *    and excerpted with the same primitives every other dispute lane uses
 *    (`evidence-checkout.ts`, `evidence-excerpt.ts`); the party's agent sees
 *    the rendered bundle only, never the checkout.
 *
 * Fail-closed like its #954/#955 siblings: every path that cannot assemble the
 * bundle returns a typed {@link DisputeSubTurnFailure} for the dispatch adapter
 * to park on, with the debate state untouched. Nothing here writes a store, a
 * task key, or a §10.1 flag; the runner it builds returns values and #951
 * persists them inside the completion transaction it was already issuing.
 */

import { join } from "path";
import type { ArbiterAgentConfig, ArbiterCandidateResolver } from "../core/review-arbiter-profile.js";
import { readArbitrationLineageEntry } from "../core/review-dispute-arbitrations.js";
import type {
  DisputeSubTurnFailure,
  DisputeSubTurnRequest,
  DisputeSubTurnResult,
  DisputeSubTurnRunner,
} from "../core/review-dispute-dispatch.js";
import type { DisputeEvidenceRoundState, EvidenceRoundCoordinates } from "../core/review-dispute-evidence-state.js";
import {
  parseDisputeEvidenceRoundState,
  selectEvidenceCollectionParty,
} from "../core/review-dispute-evidence-state.js";
import {
  REVIEW_FINDINGS_ARTIFACT,
  arbitrationArtifactName,
  disputeArtifactName,
  reconsiderationArtifactName,
} from "../core/review-dispute-lineage.js";
import { parseFindingsArtifact } from "../core/review-fix-disposition-prompt.js";
import { readReconsiderationLineageEntry } from "../core/review-dispute-reconsiderations.js";
import { readRebuttalLineageEntry } from "../core/review-dispute-rebuttals.js";
import type { EvidenceCollectionParty } from "../core/review-dispute-turn.js";
import { EVIDENCE_COLLECTION_PARTIES } from "../core/review-dispute-turn.js";
import type {
  DisputeRecord,
  EvidenceRef,
  PersistedLineage,
  ReconsiderationRecord,
  ReviewDisputeContext,
  ReviewFinding,
} from "../core/review-dispute.js";
import { MAX_EVIDENCE_REFS_PER_RECORD, REVIEW_DISPUTE_RECORD_MAX_BYTES } from "../core/review-dispute.js";
import type { EvidenceRefResolver } from "../core/review-dispute-validation.js";
import {
  validateArbiterVerdict,
  validateDispositionRecord,
  validateReconsiderationRecord,
} from "../core/review-dispute-validation.js";
import type {
  EvidenceFindingVersion,
  EvidenceInsufficiencyVerdict,
  EvidenceLineageBrief,
  EvidencePromptExcerpt,
  EvidencePromptInput,
} from "../core/review-evidence-prompt.js";
import { createReviewEvidenceResolver, reviewResolvableEvidenceKinds } from "../core/review-finding-envelope.js";
import { readBoundedArtifact } from "./agent-isolation.js";
import { isSafeArtifactDirAfterRun } from "./artifact-dir.js";
import type { CommandRunner } from "./command-runner.js";
import { defaultCommandRunner } from "./command-runner.js";
import { captureTrackedFiles, createTrackedFileReader } from "./evidence-checkout.js";
import { evidenceRefKey, excerptEvidenceRef } from "./evidence-excerpt.js";
import type { EvidenceCollectionAgentRunner, EvidencePartyAgentSources } from "./review-evidence-collection.js";
import { runEvidenceCollection } from "./review-evidence-collection.js";
import { createEvidenceCollectionSubTurnRunner } from "./review-evidence-subturn.js";

// ---------------------------------------------------------------------------
// Party selection
// ---------------------------------------------------------------------------

export type EvidenceTurnPartySelection =
  | { ok: true; party: EvidenceCollectionParty; round: DisputeEvidenceRoundState }
  | { ok: false; failure: DisputeSubTurnFailure };

/**
 * Which party this review run collects for, from the persisted round alone.
 *
 * Decided BEFORE the sub-turn identity is derived, because the identity is
 * per-party (§7.1 dispatches one run per party and #951 keys the round record
 * on it). #956's selection rule is the whole of the answer: a fresh round
 * starts with the implementer, a partial round resumes with the first party
 * still owed, and a round both parties have answered for every covered lineage
 * selects the implementer only so the dispatch adapter can recognize
 * `round_complete` and close row 22 from the record without invoking anyone.
 *
 * A round record that cannot be parsed refuses — the same fail-closed reading
 * the dispatch adapter applies, one layer earlier, so a malformed or truncated
 * record never silently restarts a round whose answers it can no longer see.
 */
export function selectEvidenceTurnParty(
  turn: { lineageIds: readonly string[] },
  context: ReviewDisputeContext,
  evidenceRound: unknown,
): EvidenceTurnPartySelection {
  const parsed = parseDisputeEvidenceRoundState(evidenceRound);
  if (!parsed.ok) {
    return {
      ok: false,
      failure: { kind: "invalid_context", detail: parsed.failure.detail, protocol: parsed.failure },
    };
  }
  const coordinates: EvidenceRoundCoordinates[] = [];
  for (const lineageId of turn.lineageIds) {
    const lineage = ownLineage(context.lineages, lineageId);
    // The selector only names lineages the validated block holds; a turn that
    // names one it does not is a stale selection, refused before a party is.
    if (lineage === undefined) {
      return { ok: false, failure: { kind: "stale_lineage", detail: `lineages.${lineageId}:absent` } };
    }
    coordinates.push({ lineageId, version: lineage.version });
  }
  const selection = selectEvidenceCollectionParty(parsed.value, coordinates);
  if (selection.kind === "collect") return { ok: true, party: selection.party, round: parsed.value };
  if (selection.kind === "record") {
    // Both parties are on file and unspent: any party's dispatch replays from
    // the record (`round_complete`) and row 22 fires. §7.1's declared order
    // makes the choice deterministic.
    return { ok: true, party: EVIDENCE_COLLECTION_PARTIES[0], round: parsed.value };
  }
  return { ok: false, failure: { kind: "invalid_identity", detail: "turn.lineageIds:none" } };
}

// ---------------------------------------------------------------------------
// Record reads
// ---------------------------------------------------------------------------

function ownLineage(
  lineages: Readonly<Record<string, PersistedLineage>>,
  lineageId: string,
): PersistedLineage | undefined {
  return Object.prototype.hasOwnProperty.call(lineages, lineageId) ? lineages[lineageId] : undefined;
}

type BriefFailure = { ok: false; failure: DisputeSubTurnFailure };

function refuse(kind: DisputeSubTurnFailure["kind"], detail: string): BriefFailure {
  return { ok: false, failure: { kind, detail } };
}

/**
 * The envelope every §10.2 record artifact shares (`{ ..., record: <record> }`),
 * read under the protocol's own bound — the same read #846 applies, for the
 * same reason: these files sit on disk between runs, so a corrupted or replaced
 * one can be arbitrarily large and must fail closed before it is in memory.
 */
function readRecordEnvelope(
  dir: string,
  artifactName: string,
): { ok: true; record: unknown } | { ok: false; missing: boolean; detail: string } {
  const read = readBoundedArtifact(join(dir, artifactName), REVIEW_DISPUTE_RECORD_MAX_BYTES);
  if (!read.ok) {
    return read.reason === "missing"
      ? { ok: false, missing: true, detail: artifactName }
      : { ok: false, missing: false, detail: read.detail };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.raw);
  } catch {
    return { ok: false, missing: false, detail: "invalid-json" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, missing: false, detail: "not-an-object" };
  }
  return { ok: true, record: (parsed as Record<string, unknown>)["record"] };
}

/**
 * A directory a persisted locator names, admitted only inside the session's
 * artifact root — the same gate `readLineageFindingVersions` and the prompt
 * bundles apply to every context-carried directory, because a crafted or stale
 * locator must never make this process read records outside the session's tree.
 */
function safeDir(artifactRoot: string, dir: string | undefined): string | undefined {
  if (dir === undefined || dir === "") return undefined;
  return isSafeArtifactDirAfterRun(artifactRoot, dir) ? dir : undefined;
}

/**
 * The §3.2 rebuttal the round re-presents (§7.1: "the admitted dispute
 * record"). Structural validation plus the identity check: the record must be
 * this lineage's, at its CURRENT version — every §7 path into
 * `evidence_requested` keeps the version the rebuttal challenged — and its two
 * halves must agree about what they challenge. Full §3.3 re-admission is the
 * arbitration bundle's business (#846); a brief shows the record, it does not
 * transition on it, and its citations are resolved individually below with
 * unresolvable ones REPORTED to the parties rather than hidden.
 */
function readDisputeBrief(
  dir: string,
  lineage: PersistedLineage,
): { ok: true; dispute: DisputeRecord } | BriefFailure {
  const lineageId = lineage.lineageId;
  const envelope = readRecordEnvelope(dir, disputeArtifactName(lineageId));
  if (!envelope.ok) {
    return refuse("invocation_failed", `dispute:${lineageId}:${envelope.missing ? "missing" : envelope.detail}`);
  }
  const validated = validateDispositionRecord(envelope.record, "disputeArtifact.record");
  if (!validated.ok) return refuse("invocation_failed", `dispute:${lineageId}:${validated.failure.reason}`);
  const record = validated.value;
  const dispute = record.dispute;
  if (record.disposition !== "review_disputed" || dispute === undefined) {
    return refuse("invocation_failed", `dispute:${lineageId}:disposition:${record.disposition}`);
  }
  if (record.lineageId !== lineageId || record.version !== lineage.version) {
    return refuse("stale_lineage", `dispute:${lineageId}:identity-mismatch`);
  }
  if (dispute.challenged.lineageId !== lineageId || dispute.challenged.version !== lineage.version) {
    return refuse("stale_lineage", `dispute:${lineageId}:challenged-mismatch`);
  }
  return { ok: true, dispute };
}

/**
 * The §4.1 reconsideration, when the lineage took one (§7.1 renders its absence
 * as a stated fact, so `null` is protocol-legal). §6.1's own counter decides
 * whether an absent file is the expected state or a record the runner cannot
 * account for — the same rule #846 applies, because "the reviewer said nothing"
 * and "the reviewer's record is lost" must not read the same to the parties.
 */
function readReconsiderationBrief(
  dir: string | undefined,
  lineage: PersistedLineage,
  repoRoot: string,
): { ok: true; reconsideration: ReconsiderationRecord | null } | BriefFailure {
  const lineageId = lineage.lineageId;
  const expected = lineage.counters.reconsiderations > 0;
  if (dir === undefined) {
    if (!expected) return { ok: true, reconsideration: null };
    return refuse("invocation_failed", `reconsideration:${lineageId}:unlocated`);
  }
  const envelope = readRecordEnvelope(dir, reconsiderationArtifactName(lineageId));
  if (!envelope.ok) {
    if (envelope.missing && !expected) return { ok: true, reconsideration: null };
    return refuse(
      "invocation_failed",
      `reconsideration:${lineageId}:${envelope.missing ? "missing" : envelope.detail}`,
    );
  }
  const validated = validateReconsiderationRecord(envelope.record, {
    path: "reconsiderationArtifact.record",
    repoRoot,
  });
  if (!validated.ok) return refuse("invocation_failed", `reconsideration:${lineageId}:${validated.failure.reason}`);
  const record = validated.value;
  // An EARLIER version's record is the ordinary case after a revision; a LATER
  // one describes a debate this lineage has not reached and is refused.
  if (record.lineageId !== lineageId || record.version > lineage.version) {
    return refuse("stale_lineage", `reconsideration:${lineageId}:identity-mismatch`);
  }
  return { ok: true, reconsideration: record };
}

/**
 * The `insufficient_evidence` verdict that opened this round (§7.1). Required:
 * a round with no locatable verdict record has nothing to put the §7.1 gap in
 * front of the parties, so it refuses — the same park the missing dispatcher
 * used to produce for every evidence turn, now narrowed to debates whose
 * arbitration predates the per-lineage locator (issue #964). A located record
 * carrying a DECISIVE verdict, or answering a version the lineage has left, is
 * a stale or foreign record: #957 types the brief on the one row-16 token
 * exactly so this cannot be rendered around a settled disagreement.
 */
function readVerdictBrief(
  arbitrations: unknown,
  artifactRoot: string,
  lineage: PersistedLineage,
): { ok: true; verdict: EvidenceInsufficiencyVerdict } | BriefFailure {
  const lineageId = lineage.lineageId;
  const located = readArbitrationLineageEntry(arbitrations, lineageId, lineage.version);
  const dir = safeDir(artifactRoot, located?.artifactDir);
  if (dir === undefined) return refuse("invocation_failed", `verdict:${lineageId}:unlocated`);
  const envelope = readRecordEnvelope(dir, arbitrationArtifactName(lineageId));
  if (!envelope.ok) {
    return refuse("invocation_failed", `verdict:${lineageId}:${envelope.missing ? "missing" : envelope.detail}`);
  }
  const validated = validateArbiterVerdict(envelope.record, "arbitrationArtifact.record");
  if (!validated.ok) return refuse("invocation_failed", `verdict:${lineageId}:${validated.failure.reason}`);
  const record = validated.value.record;
  if (record.lineageId !== lineageId || record.version !== lineage.version) {
    return refuse("stale_lineage", `verdict:${lineageId}:identity-mismatch`);
  }
  if (record.verdict !== "insufficient_evidence") {
    return refuse("stale_lineage", `verdict:${lineageId}:verdict:${record.verdict}`);
  }
  return { ok: true, verdict: { ...record, verdict: "insufficient_evidence" } };
}

/**
 * Every recorded §2.1 version of the lineage, ascending, with the CURRENT
 * version guaranteed present. The artifact read degrades exactly as the fix,
 * reconsideration, and arbitration prompts degrade — an absent or unreadable
 * `review-findings.json` yields literal-only entries — and the persisted
 * lineage itself supplies the current version's literals then, the same facts
 * §11 already publishes for it. A brief could not honestly omit the version
 * under debate.
 */
function recordedFindingVersions(reviewArtifactDir: string | undefined, lineageId: string): ReviewFinding[] {
  // The same bounded, fail-soft read the reviewer and arbitration turns apply
  // to `review-findings.json` (readLineageFindingVersions, #846's
  // readFindingVersions): absent, unreadable, oversized, or malformed yields no
  // versions, and the caller degrades to the persisted lineage's own literals.
  if (reviewArtifactDir === undefined) return [];
  const read = readBoundedArtifact(join(reviewArtifactDir, REVIEW_FINDINGS_ARTIFACT), REVIEW_DISPUTE_RECORD_MAX_BYTES);
  if (!read.ok) return [];
  const findings = parseFindingsArtifact(read.raw);
  if (findings === null) return [];
  return findings.filter((finding) => finding.lineageId === lineageId).sort((a, b) => a.version - b.version);
}

function findingVersionBriefs(
  reviewArtifactDir: string | undefined,
  lineage: PersistedLineage,
): EvidenceFindingVersion[] {
  const recorded: ReviewFinding[] = recordedFindingVersions(reviewArtifactDir, lineage.lineageId);
  const versions: EvidenceFindingVersion[] = recorded
    .filter((finding) => finding.version <= lineage.version)
    .map((finding) => ({
      version: finding.version,
      severity: finding.severity,
      affectedBoundary: finding.affectedBoundary,
      humanGate: finding.humanGate,
      body: {
        severity: finding.severity,
        violatedContract: finding.violatedContract,
        preconditions: finding.preconditions,
        failureScenario: finding.failureScenario,
        affectedBoundary: finding.affectedBoundary,
        requiredOutcome: finding.requiredOutcome,
        evidenceRefs: finding.evidenceRefs,
      },
    }));
  if (!versions.some((version) => version.version === lineage.version)) {
    versions.push({
      version: lineage.version,
      severity: lineage.severity,
      affectedBoundary: lineage.affectedBoundary,
      humanGate: lineage.humanGate,
    });
  }
  return versions.sort((a, b) => a.version - b.version);
}

/**
 * Resolve and excerpt every reference the brief's records cite, on #846's
 * exact terms: citing-record order, duplicates collapsed on first appearance,
 * per-record §3.3 bound applied before resolution. An unresolvable citation is
 * REPORTED to the parties rather than dropped — a party weighing what evidence
 * is missing must see that a reference the other side leaned on resolves
 * against nothing.
 */
function collectBriefExcerpts(
  versions: readonly EvidenceFindingVersion[],
  dispute: DisputeRecord,
  reconsideration: ReconsiderationRecord | null,
  resolve: EvidenceRefResolver,
  readFile: (path: string) => string | undefined,
): EvidencePromptExcerpt[] {
  const cited: { citedBy: EvidencePromptExcerpt["citedBy"]; refs: readonly EvidenceRef[] }[] = [
    ...versions.map((version) => ({ citedBy: "finding" as const, refs: version.body?.evidenceRefs ?? [] })),
    { citedBy: "rebuttal" as const, refs: dispute.evidenceRefs },
    {
      citedBy: "reconsideration" as const,
      refs: reconsideration?.revision?.successor.evidenceRefs ?? [],
    },
  ];
  const seen = new Set<string>();
  const out: EvidencePromptExcerpt[] = [];
  for (const group of cited) {
    for (const ref of group.refs.slice(0, MAX_EVIDENCE_REFS_PER_RECORD)) {
      const key = evidenceRefKey(ref);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ref, citedBy: group.citedBy, ...excerptEvidenceRef(ref, resolve, readFile) });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The runtime
// ---------------------------------------------------------------------------

/** Everything the review gate can supply before a turn is selected, as values. */
export interface EvidenceTurnGateRuntime {
  /** The authoritative Issue contract the findings are measured against (§4.1). */
  issueBody: string;
  /**
   * The LAST fix run's directory, carried as `task.context.disputeArtifactDir` —
   * the fall-back {@link rebuttals} supersedes per lineage, exactly as the
   * reconsideration and arbitration turns fall back (issue #955 review, P1).
   */
  disputeArtifactDir: string;
  /** The LAST reviewer run's directory; {@link reconsiderations} supersedes it. */
  reconsiderationArtifactDir?: string;
  /** The review run's directory, holding `review-findings.json`. Optional. */
  reviewArtifactDir?: string;
  /** THIS run's artifact directory: the party's transcripts and §10.2 records. */
  artifactDir: string;
  /** The session's artifact root; every locator and write is bounded inside it. */
  artifactRoot: string;
  /**
   * The issue worktree, used as READ-ONLY evidence input by this process for
   * §3.3 resolution and excerpting. The party's agent never sees it (§8.2).
   */
  repoCwd: string;
  /** ISO-8601 date-time with an explicit offset, for the §10.2 records. */
  timestamp: string;
  /** Where each party's agent id may be resolved from (#962). Never a label. */
  agent: EvidencePartyAgentSources;
  /** `task.context.reviewDisputeRebuttals`, as persisted and untrusted. */
  rebuttals?: unknown;
  /** `task.context.reviewDisputeReconsiderations`, as persisted and untrusted. */
  reconsiderations?: unknown;
  /** `task.context.reviewDisputeArbitrations`, as persisted and untrusted. */
  arbitrations?: unknown;
  /** `task.context.reviewDisputeEvidenceRound`, as persisted and untrusted. */
  evidenceRound?: unknown;
  /** `task.context.reviewDisputeEvidenceCollections`, equally untrusted. */
  collections?: unknown;
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
// The sub-turn implementation
// ---------------------------------------------------------------------------

/**
 * Build the §7.1 `evidence_collection` runner the review gate registers: the
 * bundle assembly above, then #963's per-party sub-turn over it.
 *
 * The bundle is assembled PER REQUEST, not per runner, because it is a property
 * of the selected turn — which lineages, at which versions — and only the
 * request names them. Assembly runs before #963's own guards, so a bundle this
 * module could not build parks the task through the same typed failure path a
 * failed invocation uses, with the debate state untouched; and it runs on every
 * dispatch even when the answer will be replayed from the record, which costs a
 * few artifact reads and buys the invariant that a round whose records have
 * gone unreadable is parked for a human instead of silently replayed forward.
 */
export function createEvidenceTurnRunner(runtime: EvidenceTurnGateRuntime): DisputeSubTurnRunner {
  return async (request: DisputeSubTurnRequest): Promise<DisputeSubTurnResult> => {
    // The §3.3 resolver over the read-only checkout, shared by the brief's own
    // excerpting here and by #957's response admission inside the invocation:
    // one resolver, so what the bundle showed and what the answer is admitted
    // against cannot drift within a run.
    const commandRunner = runtime.runner ?? defaultCommandRunner;
    const issueBodyAvailable = runtime.issueBody.trim() !== "";
    const resolveEvidenceRef: EvidenceRefResolver =
      runtime.resolveEvidenceRef
      ?? createReviewEvidenceResolver({
        trackedFiles: captureTrackedFiles(commandRunner, runtime.repoCwd),
        readTrackedFile: createTrackedFileReader(runtime.repoCwd),
        ...(issueBodyAvailable ? { issueBody: runtime.issueBody } : {}),
      });
    const readTrackedFile = createTrackedFileReader(runtime.repoCwd);

    const briefs: EvidenceLineageBrief[] = [];
    for (const lineageId of request.turn.lineageIds) {
      const lineage = ownLineage(request.context.lineages, lineageId);
      if (lineage === undefined) {
        return { status: "failed", failure: { kind: "stale_lineage", detail: `lineages.${lineageId}:absent` } };
      }
      // The fix run that rebutted THIS lineage, when the per-lineage record
      // names one; the single-valued field otherwise (issue #955 review, P1).
      const rebuttal = readRebuttalLineageEntry(runtime.rebuttals, lineageId, lineage.version);
      const disputeDir =
        safeDir(runtime.artifactRoot, rebuttal?.artifactDir)
        ?? safeDir(runtime.artifactRoot, runtime.disputeArtifactDir);
      if (disputeDir === undefined) {
        return { status: "failed", failure: { kind: "invocation_failed", detail: `dispute:${lineageId}:unlocated` } };
      }
      const dispute = readDisputeBrief(disputeDir, lineage);
      if (!dispute.ok) return { status: "failed", failure: dispute.failure };

      const reviewerRun = readReconsiderationLineageEntry(runtime.reconsiderations, lineageId, lineage.version);
      const reconsiderationDir =
        safeDir(runtime.artifactRoot, reviewerRun?.artifactDir)
        ?? safeDir(runtime.artifactRoot, runtime.reconsiderationArtifactDir);
      const reconsideration = readReconsiderationBrief(reconsiderationDir, lineage, runtime.repoCwd);
      if (!reconsideration.ok) return { status: "failed", failure: reconsideration.failure };

      const verdict = readVerdictBrief(runtime.arbitrations, runtime.artifactRoot, lineage);
      if (!verdict.ok) return { status: "failed", failure: verdict.failure };

      const versions = findingVersionBriefs(safeDir(runtime.artifactRoot, runtime.reviewArtifactDir), lineage);
      briefs.push({
        lineageId,
        version: lineage.version,
        severity: lineage.severity,
        affectedBoundary: lineage.affectedBoundary,
        humanGate: lineage.humanGate,
        counters: { ...lineage.counters },
        versions,
        dispute: dispute.dispute,
        ...(reconsideration.reconsideration === null ? {} : { reconsideration: reconsideration.reconsideration }),
        verdict: verdict.verdict,
        evidence: collectBriefExcerpts(
          versions,
          dispute.dispute,
          reconsideration.reconsideration,
          resolveEvidenceRef,
          readTrackedFile,
        ),
      });
    }

    const bundle: Omit<EvidencePromptInput, "party"> = {
      lineages: briefs,
      issueContract: runtime.issueBody,
      resolvableEvidenceKinds: reviewResolvableEvidenceKinds({ issueBodyAvailable }),
    };

    const run = createEvidenceCollectionSubTurnRunner({
      bundle,
      agent: runtime.agent,
      ...(runtime.evidenceRound === undefined ? {} : { evidenceRound: runtime.evidenceRound }),
      ...(runtime.collections === undefined ? {} : { collections: runtime.collections }),
      artifactDir: runtime.artifactDir,
      artifactRoot: runtime.artifactRoot,
      repoCwd: runtime.repoCwd,
      timestamp: runtime.timestamp,
      ...(runtime.config === undefined ? {} : { config: runtime.config }),
      ...(runtime.invoke === undefined ? {} : { invoke: runtime.invoke }),
      ...(runtime.resolveProfile === undefined ? {} : { resolveProfile: runtime.resolveProfile }),
      resolveEvidenceRef,
      ...(runtime.runner === undefined ? {} : { runner: runtime.runner }),
      ...(runtime.agentRunner === undefined ? {} : { agentRunner: runtime.agentRunner }),
      ...(runtime.agentInvoke === undefined ? {} : { agentInvoke: runtime.agentInvoke }),
      ...(runtime.env === undefined ? {} : { env: runtime.env }),
      ...(runtime.timeoutMs === undefined ? {} : { timeoutMs: runtime.timeoutMs }),
      ...(runtime.now === undefined ? {} : { now: runtime.now }),
    });
    return run(request);
  };
}
