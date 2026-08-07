/**
 * Issue #843: parse the implementation agent's answer to the #837 fix-mode
 * disposition prompt, and decide whether the run may legitimately have
 * produced no file changes (§3.4 of docs/review-dispute-contract.md).
 *
 * This module is the response half of #837's request half. #837 renders which
 * lineages await a disposition and the exact JSON-array contract the answer
 * must follow; this module consumes that contract and nothing else. It is pure
 * and side-effect-free: every check is a transform over already-validated #836
 * types plus an injected read-only evidence resolver. Reading the agent's
 * output off disk, resolving evidence against a checkout, persisting the
 * result, and selecting the task's next phase are the caller's job
 * (`src/handlers/implementation.ts`) and #840's, respectively.
 *
 * What it decides, and what it deliberately does not:
 *
 *  - It ADMITS or REJECTS each disposition record, per record, using the #836
 *    admission (`admitDisposition`) plus the two eligibility gates §3 states
 *    but #836 left to the transition owner: a `binding` version accepts no
 *    `review_disputed` (§3.1, row 24), and a version whose single §6.1
 *    rebuttal slot is already consumed accepts no second one.
 *  - It answers ONE run-level question: may this run end with zero file
 *    changes? §3.4 admits that only for a complete, valid set of dispositions
 *    over a fully structured review (§13) — anything less falls back to
 *    today's "produced no file changes" failure, which is exactly §12's
 *    fail-closed direction.
 *  - It selects NO transition, writes nothing, and consumes no counter. A
 *    rejected record leaves its lineage exactly where it was (§12), which is
 *    why a rejection is reported per record rather than thrown.
 */
import {
  allowsZeroChangeRun,
  dispositionAllowedForState,
  reviewStructureAllowsZeroChange,
  IMPLEMENTATION_DISPOSITIONS,
  MAX_DISPOSITIONS_PER_RUN,
  REVIEW_DISPUTE_RECORD_MAX_BYTES,
  type DispositionRecord,
  type ImplementationDisposition,
  type LineageState,
  type PersistedLineage,
  type ReviewDisputeLimits,
  type ReviewStructureMode,
} from "./review-dispute.js";
import {
  admitDisposition,
  validateDispositionRecord,
  validateDispositionSet,
  type AdmittedDisposition,
  type EvidenceRefResolver,
  type ReviewDisputeFailure,
  type ReviewDisputeFailureReason,
} from "./review-dispute-validation.js";
import type { FixPromptFinding } from "./review-fix-disposition-prompt.js";

// ---------------------------------------------------------------------------
// Extracting the response's disposition block
// ---------------------------------------------------------------------------

/**
 * The fenced block #837 asks for: ```` ```json ```` on its own line, then the
 * JSON array, then a closing fence. Built fresh per call — a module-level
 * global regex carries `lastIndex` between calls and would make this module's
 * answer depend on how often it had been asked before.
 */
function dispositionBlockPattern(): RegExp {
  return /```[ \t]*json[ \t]*\r?\n([\s\S]*?)```/gi;
}

export type DispositionBlockExtraction =
  | { ok: true; records: unknown[] }
  | { ok: false; failure: ReviewDisputeFailure };

/**
 * Extract the single JSON array of disposition records from an agent response.
 *
 * §12 fail-closed on every ambiguity, because the alternative to a clean
 * answer is not a guess — it is today's behavior, which is already correct:
 *
 *  - no fenced `json` block at all (a bare refusal, a prose-only objection, an
 *    empty response) is `unparseable`: prose cannot be matched back to a
 *    finding, and §3.3 says an unsupported assertion is not a dispute;
 *  - a block that is not valid JSON, or holds something other than an array,
 *    is `unparseable` too — the contract's example is an array and only an
 *    array can carry one record per finding;
 *  - TWO array blocks are `too-many-items`, not "use the last one". #837 asks
 *    for exactly one block; picking a winner between two would silently drop
 *    whichever the agent did not mean, and the drop is invisible to everyone.
 *
 * A `json` fence this function cannot read AT ALL — invalid JSON, or a body
 * past the #836 byte bound — is fatal for the whole response, even when some
 * other fence does carry a clean array. Such a fence may well BE the agent's
 * disposition set (a truncated first attempt, an over-long one), and skipping
 * it to accept a neighbouring array would silently pick a winner between two
 * candidate sets — the same invisible drop the two-array rule refuses, only
 * worse, because the discarded one is the one nobody can read.
 *
 * Non-array `json` blocks that DO parse are still ignored rather than fatal:
 * an implementer may legitimately quote a config object or a test fixture in
 * its write-up, and a readable object is recognizably not a disposition set.
 */
export function extractDispositionRecords(response: string): DispositionBlockExtraction {
  const pattern = dispositionBlockPattern();
  const arrays: unknown[][] = [];
  let blocks = 0;
  // The first unreadable fence, kept rather than counted: it fails the whole
  // envelope, so what matters is which one and why, not how many.
  let unreadable: ReviewDisputeFailure | null = null;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(response)) !== null) {
    blocks++;
    const body = match[1]!;
    // A record payload is bounded by #836; a "block" past that bound is not a
    // disposition set this runner will parse, and it must not be spent on
    // `JSON.parse` either. Measured in UTF-8 bytes like every other #836 bound:
    // `body.length` counts UTF-16 code units, so a block of non-ASCII prose
    // would clear a byte limit it exceeds by up to 3x.
    if (Buffer.byteLength(body, "utf8") > REVIEW_DISPUTE_RECORD_MAX_BYTES) {
      unreadable ??= { reason: "payload-too-large", detail: "disposition-block" };
      continue;
    }
    let data: unknown;
    try {
      data = JSON.parse(body);
    } catch {
      // The fence index is the only locator an unparseable body has, and it
      // carries none of the body's content.
      unreadable ??= { reason: "unparseable", detail: `disposition-block:${blocks}:invalid-json` };
      continue;
    }
    if (Array.isArray(data)) arrays.push(data);
  }

  // Checked before the array count: an unreadable fence makes the response
  // ambiguous no matter what the readable fences hold, so it is reported as
  // itself rather than as "no array" or "too many arrays".
  if (unreadable !== null) {
    return { ok: false, failure: unreadable };
  }
  if (arrays.length > 1) {
    return { ok: false, failure: { reason: "too-many-items", detail: `disposition-blocks:${arrays.length}` } };
  }
  if (arrays.length === 1) {
    const records = arrays[0]!;
    if (records.length > MAX_DISPOSITIONS_PER_RUN) {
      return { ok: false, failure: { reason: "too-many-items", detail: `dispositions:${records.length}` } };
    }
    return { ok: true, records };
  }
  return {
    ok: false,
    failure: {
      reason: "unparseable",
      detail: blocks === 0 ? "response:no-disposition-block" : "response:no-disposition-array",
    },
  };
}

// ---------------------------------------------------------------------------
// Per-record admission and the §3.4 zero-change question
// ---------------------------------------------------------------------------

/**
 * The lineage state one admitted disposition leaves behind in a run that
 * produced NO file changes, so §3.4's question ("does every addressed lineage
 * end the run in a no-change-required terminal state or a protocol-progress
 * state?") is answered by the §1 state table rather than restated here.
 *
 * Only the zero-change half of the §7 rows is expressed: which row actually
 * fires also depends on counters and limits, and #840 owns that. What matters
 * here is only whether the row's target state can end a run without a diff, and
 * the rows that differ on that point are exactly the ones this function splits:
 *  - `fixed` (§7 rows 1/5/23) needs a diff and never survives admission in a
 *    no-diff run (§3.4), so its branch is unreachable by construction;
 *  - `review_disputed` on a finding that is NOT human-gated (rows 2/6, and
 *    rows 25/26 under lowered limits) leaves the lineage `disputed` or
 *    `arbitration_pending` — both protocol-progress states, and this is the
 *    case §3.4 exists for;
 *  - `review_disputed` on a `humanGate: true` version is rows 3/7: escalation
 *    happens AT dispute admission and the lineage goes straight to
 *    `escalated_human`, never entering `disputed`. That is terminal but not a
 *    no-change-required state, so an all-disputed no-diff run over a
 *    human-gated finding keeps today's failure instead of reporting success
 *    and quietly skipping the human the gate exists to involve;
 *  - `blocked` (rows 4/8/24) leaves it `escalated_human` too, so a no-diff run
 *    of `blocked`-only dispositions keeps today's failure.
 */
function noDiffResultState(disposition: ImplementationDisposition, lineage: PersistedLineage): LineageState {
  switch (disposition) {
    case "fixed":
      return "resolved_fixed";
    case "review_disputed":
      return lineage.humanGate ? "escalated_human" : "disputed";
    case "blocked":
      return "escalated_human";
  }
}

/** A finding from the prompt that this response left without a valid answer. */
export interface UnansweredFinding {
  lineageId: string;
  version: number;
  state: LineageState;
}

/** One record the response carried that failed closed (§12). */
export interface RejectedFixDisposition {
  /** Position in the response array — the only locator a malformed record has. */
  index: number;
  /** The lineage the record named, when it named a structurally valid one. */
  lineageId: string | null;
  failure: ReviewDisputeFailure;
}

export interface FixDispositionResponseInput {
  /** The implementation agent's final response text. */
  response: string;
  /**
   * The lineages this run's fix prompt asked for a disposition on (#837's
   * `resolveFixPromptFindings`). This is the authoritative set: the prompt
   * says "and only those findings", so a record addressed to anything else is
   * out of contract even when that lineage exists.
   */
  findings: readonly FixPromptFinding[];
  /** The §10.1 persisted lineages of `task.context.reviewDispute`. */
  lineages: Readonly<Record<string, PersistedLineage>>;
  /** §13: how the admitting review was shaped. */
  reviewStructure: ReviewStructureMode;
  /** §3.4: whether this run left a diff on the branch. */
  runProducedFileChanges: boolean;
  /**
   * §3.3: read-only resolution of every dispute evidence reference.
   *
   * Injected, not performed here — resolution needs I/O and a checkout. What
   * the runner's resolver can actually verify today is
   * `reviewResolvableEvidenceKinds`: `file`, `doc_section`, and (only when the
   * run captured an Issue body) `issue_quote`. A `test` reference does not
   * resolve for anyone yet — deciding whether a named test exists means running
   * or parsing the suite, which #836 assigns to the pipeline resolver — so a
   * dispute whose ONLY evidence is a test name fails closed here, exactly as
   * the same reference would in a review finding.
   */
  resolveEvidenceRef: EvidenceRefResolver;
  /** The session's resolved §6.1 limits. */
  limits: ReviewDisputeLimits;
}

/** Literals and counters only — safe to persist in task context (§10.1). */
export interface FixDispositionSummary {
  /** How many findings the prompt asked about. */
  findings: number;
  admitted: number;
  rejected: number;
  unanswered: number;
  counts: Record<ImplementationDisposition, number>;
  dispositions: { lineageId: string; version: number; disposition: ImplementationDisposition }[];
  rejections: { index: number; lineageId: string | null; reason: ReviewDisputeFailureReason; detail: string | null }[];
  unansweredLineageIds: string[];
  zeroChangeAdmissible: boolean;
  responseFailure: { reason: ReviewDisputeFailureReason; detail: string | null } | null;
}

export interface FixDispositionOutcome {
  /** Every admitted record, with the lineage it addresses (§3). */
  admitted: AdmittedDisposition[];
  /** Every record that failed closed, in response order (§12). */
  rejected: RejectedFixDisposition[];
  /** Prompt findings left unanswered — they stay `open`/`binding` (§12). */
  unanswered: UnansweredFinding[];
  /** Set when the whole response envelope was rejected, not one record. */
  responseFailure: ReviewDisputeFailure | null;
  /**
   * §3.4 + §13: may this run end with no file changes? When false, a run with
   * no diff keeps today's "produced no file changes" failure.
   */
  zeroChangeAdmissible: boolean;
  summary: FixDispositionSummary;
}

/** Own-property lookup: an inherited `Object.prototype` member names no lineage. */
function ownLineage(
  lineages: Readonly<Record<string, PersistedLineage>>,
  lineageId: string,
): PersistedLineage | undefined {
  return Object.prototype.hasOwnProperty.call(lineages, lineageId) ? lineages[lineageId] : undefined;
}

/**
 * §6.1: has this version already spent its rebuttal budget?
 *
 * `rebuttedVersions` holds the versions whose slot is consumed, distinct by
 * §10.1, so the comparison against `MAX_REBUTTALS_PER_VERSION` is what makes
 * the one-rebuttal rule the limit's rule rather than a hard-coded `1` here.
 */
function rebuttalSlotConsumed(
  lineage: PersistedLineage,
  version: number,
  limits: ReviewDisputeLimits,
): boolean {
  const spent = lineage.rebuttedVersions.filter((v) => v === version).length;
  return spent >= limits.maxRebuttalsPerVersion;
}

function emptyCounts(): Record<ImplementationDisposition, number> {
  const counts = {} as Record<ImplementationDisposition, number>;
  for (const d of IMPLEMENTATION_DISPOSITIONS) counts[d] = 0;
  return counts;
}

function summarize(
  input: FixDispositionResponseInput,
  admitted: readonly AdmittedDisposition[],
  rejected: readonly RejectedFixDisposition[],
  unanswered: readonly UnansweredFinding[],
  responseFailure: ReviewDisputeFailure | null,
  zeroChangeAdmissible: boolean,
): FixDispositionSummary {
  const counts = emptyCounts();
  for (const a of admitted) counts[a.record.disposition]++;
  return {
    findings: input.findings.length,
    admitted: admitted.length,
    rejected: rejected.length,
    unanswered: unanswered.length,
    counts,
    dispositions: admitted.map((a) => ({
      lineageId: a.record.lineageId,
      version: a.record.version,
      disposition: a.record.disposition,
    })),
    // Reason and detail are the #836 content-free locators (a field path plus a
    // length/count/version); no agent prose is carried into a summary.
    rejections: rejected.map((r) => ({
      index: r.index,
      lineageId: r.lineageId,
      reason: r.failure.reason,
      detail: r.failure.detail,
    })),
    unansweredLineageIds: unanswered.map((f) => f.lineageId),
    zeroChangeAdmissible,
    responseFailure: responseFailure
      ? { reason: responseFailure.reason, detail: responseFailure.detail }
      : null,
  };
}

/**
 * Parse and validate the fix run's disposition response.
 *
 * Never throws: an unusable response is an outcome, not an exception, because
 * §12's effect for malformed output is a run outcome ("falls back to today's
 * semantics") rather than an error condition.
 *
 * Admission order per record is deliberate. Structural validation comes first
 * for the whole set, so a duplicate can be seen across records before any
 * lineage is touched; the two eligibility gates (§3.1 `binding`, §6.1 rebuttal
 * slot) come next, so a record that could never be admitted does not spend a
 * read-only evidence resolution on the way to being rejected; the full #836
 * admission — which re-validates, resolves the lineage and version, applies
 * §3.4's `fixed`-needs-a-diff rule, and resolves every evidence reference —
 * comes last and is what actually admits.
 */
export function parseFixDispositionResponse(input: FixDispositionResponseInput): FixDispositionOutcome {
  const admitted: AdmittedDisposition[] = [];
  const rejected: RejectedFixDisposition[] = [];
  let responseFailure: ReviewDisputeFailure | null = null;

  // Nothing awaits a disposition: there is no disposition contract in this
  // run's prompt, so there is nothing to parse and nothing §3.4 could admit.
  if (input.findings.length === 0) {
    const summary = summarize(input, admitted, rejected, [], null, false);
    return { admitted, rejected, unanswered: [], responseFailure: null, zeroChangeAdmissible: false, summary };
  }

  const prompted = new Set(input.findings.map((f) => f.lineageId));
  const extraction = extractDispositionRecords(input.response);
  if (!extraction.ok) {
    responseFailure = extraction.failure;
  } else {
    const raw = extraction.records;
    const structural = raw.map((element, index) => ({
      index,
      path: `dispositions[${index}]`,
      result: validateDispositionRecord(element, `dispositions[${index}]`),
    }));
    // §3.1: exactly one disposition per finding. Two records naming the same
    // lineage make BOTH ambiguous, so both are rejected and the finding counts
    // as unanswered — never "the last one wins".
    const perLineage = new Map<string, number>();
    for (const entry of structural) {
      if (!entry.result.ok) continue;
      const id = entry.result.value.lineageId;
      perLineage.set(id, (perLineage.get(id) ?? 0) + 1);
    }

    for (const entry of structural) {
      if (!entry.result.ok) {
        rejected.push({ index: entry.index, lineageId: null, failure: entry.result.failure });
        continue;
      }
      const record: DispositionRecord = entry.result.value;
      const reject = (reason: ReviewDisputeFailureReason, detail: string): void => {
        rejected.push({ index: entry.index, lineageId: record.lineageId, failure: { reason, detail } });
      };
      if ((perLineage.get(record.lineageId) ?? 0) > 1) {
        reject("duplicate-lineage", `${entry.path}.lineageId`);
        continue;
      }
      const lineage = ownLineage(input.lineages, record.lineageId);
      if (lineage !== undefined) {
        // §3.1 / §7 rows 23–24 and §6.1. #836 admits a record against its
        // lineage's identity and version; whether that lineage's STATE and
        // remaining budget accept this disposition is the gate #843 adds.
        if (!dispositionAllowedForState(lineage.state, record.disposition)) {
          if (lineage.state === "binding" && record.disposition === "review_disputed") {
            reject("dispute-on-binding", `${entry.path}.disposition`);
          } else {
            reject("not-actionable-state", `${entry.path}.disposition:${lineage.state}`);
          }
          continue;
        }
        if (record.disposition === "review_disputed" && rebuttalSlotConsumed(lineage, record.version, input.limits)) {
          reject("rebuttal-slot-consumed", `${entry.path}.version:${record.version}`);
          continue;
        }
        // Defensive: the prompt is authoritative about which findings this run
        // may answer, and `findings` is derived from the same lineages, so this
        // only fires if a caller narrows one without the other.
        if (!prompted.has(record.lineageId)) {
          reject("not-actionable-state", `${entry.path}:not-prompted`);
          continue;
        }
      }
      const admission = admitDisposition(
        raw[entry.index],
        {
          lineages: input.lineages,
          runProducedFileChanges: input.runProducedFileChanges,
          resolveEvidenceRef: input.resolveEvidenceRef,
        },
        entry.path,
      );
      if (!admission.ok) {
        rejected.push({ index: entry.index, lineageId: record.lineageId, failure: admission.failure });
        continue;
      }
      admitted.push(admission.value);
    }

    // Run-level bound and uniqueness, from #836 rather than restated here. The
    // loop above already guarantees both; keeping the check makes #836 the one
    // place either rule can change.
    const set = validateDispositionSet(admitted.map((a) => a.record));
    if (!set.ok) {
      responseFailure = set.failure;
      admitted.length = 0;
    }
  }

  const answered = new Set(admitted.map((a) => a.record.lineageId));
  const unanswered: UnansweredFinding[] = input.findings
    .filter((f) => !answered.has(f.lineageId))
    .map((f) => ({ lineageId: f.lineageId, version: f.version, state: f.state }));

  // §3.4 + §13. Every clause is a fail-closed condition on the WHOLE run, not
  // on one record: a zero-change run is admitted only when the review that
  // admitted these findings was fully structured, the response parsed as one
  // clean disposition set, every prompted finding got an answer, nothing was
  // rejected, and every answer is one that leaves its lineage in a state §3.4
  // allows to end a run without a diff. Anything else falls back to today's
  // "produced no file changes" failure.
  const zeroChangeAdmissible =
    responseFailure === null
    && reviewStructureAllowsZeroChange(input.reviewStructure)
    && rejected.length === 0
    && unanswered.length === 0
    && admitted.length > 0
    && admitted.every((a) => allowsZeroChangeRun(noDiffResultState(a.record.disposition, a.lineage)));

  return {
    admitted,
    rejected,
    unanswered,
    responseFailure,
    zeroChangeAdmissible,
    summary: summarize(input, admitted, rejected, unanswered, responseFailure, zeroChangeAdmissible),
  };
}
