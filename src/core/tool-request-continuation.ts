import type { VerificationCommands } from "./session.js";

/**
 * Continuation decision for a RESOLVED implementation Tool Request (issue #722,
 * slice V6 of `docs/unattended-tool-request-contract.md` §12).
 *
 * `docs/unattended-tool-request-contract.md` (#919) row 26 is the only
 * direct-to-review route in the system, and it defers wholesale to
 * `docs/verification-execution-contract.md` (#918) §10: a resolution may skip
 * the implementation detour ONLY when a runner-owned verification command was
 * observed succeeding and the durable/repository state proves the committed
 * issue work is already what a reviewer would fetch. Everything else — an
 * arbitrary successful command, a run that produced repository changes, a
 * missing or ambiguous piece of evidence — takes #919 row 27's shipped
 * `{queued, implementation}` continuation.
 *
 * This module is the whole decision, and it is deliberately pure: typed inputs
 * in, a deterministic destination + stable reason code + bounded evidence
 * summary out. No agent, no prose classification, and no filesystem or network
 * access — the caller collects trusted, runner-owned evidence and passes it in,
 * so the rule set stays testable in isolation and the two operator surfaces
 * (`tool-request run` and its deprecated `grant` alias) cannot diverge.
 *
 * Fail-closed is structural: every check reads a REQUIRED-true input, and any
 * input the caller could not prove arrives as `undefined`, which never passes.
 *
 * ONE RECORDED DEVIATION from #918 §10.3 step 1. That step re-runs the whole
 * resolved verification set as a runner-owned CYCLE in the
 * `tool-request-continuation` lane and admits only a `passed` cycle bundle as
 * evidence. That engine is #918's V1–V4 slices (unified set resolution,
 * lifecycle, classification, aggregation, cycle bundle) and none of it is
 * shipped: there is no cycle, no bundle, no `setFingerprint`, and no
 * per-command `requestDigest` to compare, so E7's freshness comparison has no
 * subject either. This slice therefore uses the evidence its own Issue (#722)
 * enumerates: the runner's own observation that an EXACTLY matching configured
 * `session.verification` command exited 0, plus the full state evidence below.
 * The substance of #918's rule is preserved — an arbitrary successful command
 * is never evidence (check `configured-verification-command`), and success
 * alone never routes anything (checks 3–14 are all state) — but the
 * whole-set cycle is not re-run here. When the cycle engine lands, its passed
 * bundle becomes an additional required input to `guided-run-succeeded` /
 * `configured-verification-command`; nothing below is weakened by it.
 */

// ---------------------------------------------------------------------------
// Configured-verification matching (#918 §10.2 eligibility)
// ---------------------------------------------------------------------------

/**
 * Whether a `session.verification` VALUE is the same command as `candidate`,
 * under the shipped matching semantics (`buildIssueVerificationStatus` in
 * handlers/verification.ts, pinned by `test/verification-status.test.js`):
 *
 * 1. exact match after trimming, or
 * 2. shell-wrapper equivalence — a configured `bash -lc 'cd frontend && npm
 *    test'` is a runnable form of the compound command `cd frontend && npm
 *    test`.
 *
 * Text matching decides ELIGIBILITY only, never authorization (#918 §10.2): a
 * misclassified command reaches, at worst, the evidence gate below, whose
 * failure mode is the ordinary implementation continuation. The guided run's
 * own authorization stays the scoped, exact-command-hash grant it always was.
 */
export function matchesConfiguredVerificationCommand(sessionValue: string, candidate: string): boolean {
  const sv = sessionValue.trim();
  const req = candidate.trim();
  if (sv.length === 0 || req.length === 0) return false;
  if (sv === req) return true;
  // bash/sh/zsh [-flags] '<cmd>' or "<cmd>"
  const m = /^(?:bash|sh|zsh)\s+(?:-\w+\s+)*(?:'([^']*)'|"([^"]*)")$/.exec(sv);
  if (m) {
    const inner = (m[1] ?? m[2] ?? "").trim();
    return inner === req;
  }
  return false;
}

/**
 * Resolve a command to the configured verification entry it matches, or
 * `undefined` when no `session.verification` value covers it. Entries are
 * consulted in configuration order and the first match wins, so the resolved
 * NAME is deterministic for a given session config.
 *
 * An issue-required command that no `session.verification` value covers is
 * deliberately NOT resolvable here (#918 §10.2): routing it to review would
 * trade the no-op implementation detour for a review blocked on unexecuted
 * required verification.
 */
export function resolveConfiguredVerification(
  command: string,
  verification: VerificationCommands | undefined,
): { name: string; command: string } | undefined {
  if (!verification) return undefined;
  for (const [name, value] of Object.entries(verification)) {
    if (typeof value !== "string") continue;
    if (matchesConfiguredVerificationCommand(value, command)) {
      return { name, command: value.trim() };
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Pending implementation state
// ---------------------------------------------------------------------------

/**
 * Closed set of markers that say implementation work is still owed on the task.
 * Closed by construction so the durable evidence summary can never carry
 * free-form text (and therefore never a path, an output fragment, or a secret).
 */
export const TOOL_REQUEST_PENDING_MARKERS = [
  "review-feedback",
  "fix-mode",
  "conflict-state",
  "preserved-patch",
  "partial-diff-capture-failed",
  "missing-verification",
  "unresolved-change-disposition",
] as const;

export type ToolRequestPendingMarker = (typeof TOOL_REQUEST_PENDING_MARKERS)[number];

export interface PendingMarkerInputs {
  /**
   * A preserved source-edits patch from the implementation handoff is still
   * pending application/commit (shared-checkout mode, issue #629): the issue
   * branch does not yet carry the edits a reviewer would need to see.
   */
  preservedPatchPending?: boolean;
}

/**
 * Derive the pending-implementation markers from durable task context. Pure and
 * order-stable: the returned ids follow {@link TOOL_REQUEST_PENDING_MARKERS}.
 *
 * A fix-mode task counts as pending unconditionally. A Tool Request interrupts
 * an agent mid-run, and no evidence can prove the interrupted FIX was complete
 * (#918 §10.4: state is validated, intent never is), so the review feedback it
 * was answering is treated as unanswered.
 */
export function collectPendingImplementationMarkers(
  context: unknown,
  inputs: PendingMarkerInputs = {},
): ToolRequestPendingMarker[] {
  const ctx = typeof context === "object" && context !== null ? (context as Record<string, unknown>) : {};
  const markers = new Set<ToolRequestPendingMarker>();

  const reviewFeedback = ctx["reviewFeedback"];
  if (typeof reviewFeedback === "string" && reviewFeedback.trim().length > 0) {
    markers.add("review-feedback");
  }
  if (ctx["implementationMode"] === "fix") markers.add("fix-mode");

  const conflictedFiles = ctx["conflictedFiles"];
  if (Array.isArray(conflictedFiles) && conflictedFiles.length > 0) markers.add("conflict-state");

  if (inputs.preservedPatchPending === true) markers.add("preserved-patch");

  const toolRequest = ctx["toolRequest"];
  if (typeof toolRequest === "object" && toolRequest !== null && !Array.isArray(toolRequest)) {
    const captureFailed = (toolRequest as Record<string, unknown>)["partialDiffCaptureFailed"];
    if (typeof captureFailed === "string" && captureFailed.trim().length > 0) {
      markers.add("partial-diff-capture-failed");
    }
  }

  const missingVerification = ctx["missingVerificationCommands"];
  if (Array.isArray(missingVerification) && missingVerification.length > 0) {
    markers.add("missing-verification");
  }

  // A guided repository-change disposition (#419) that was refused, failed, or
  // merely kept leaves produced changes for a human to finish; the task is not
  // implementation-complete until that is closed out.
  const changeAction = ctx["toolRequestChangeAction"];
  if (typeof changeAction === "object" && changeAction !== null && !Array.isArray(changeAction)) {
    const outcome = (changeAction as Record<string, unknown>)["outcome"];
    if (outcome !== undefined && outcome !== "committed" && outcome !== "discarded" && outcome !== "rejected") {
      markers.add("unresolved-change-disposition");
    }
  }

  return TOOL_REQUEST_PENDING_MARKERS.filter((m) => markers.has(m));
}

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

/** Destination of a resolved Tool Request's continuation (#919 §2, closed set). */
export type ToolRequestContinuationPhase = "implementation" | "review";

/**
 * The ordered evidence checks. Ids are stable, bounded, path-safe strings and
 * are persisted verbatim in durable task state and events, so renaming one is a
 * contract change.
 */
export const TOOL_REQUEST_CONTINUATION_CHECKS = [
  "guided-run-succeeded",
  "configured-verification-command",
  "no-repository-changes",
  "implementation-phase",
  "tool-request-resolved",
  "no-pending-implementation-state",
  "worktree-clean",
  "branch-recorded",
  "pr-recorded",
  "pr-head-matches-branch",
  "review-base-recorded",
  "branch-pushed",
  "committed-work-present",
  "review-admitted",
] as const;

export type ToolRequestContinuationCheck = (typeof TOOL_REQUEST_CONTINUATION_CHECKS)[number];

/** Stable reason code recorded with the selected continuation. */
export type ToolRequestContinuationReason =
  | "direct-review"
  | "guided-run-not-successful"
  | "command-not-configured-verification"
  | "repository-changes-produced"
  | "phase-not-implementation"
  | "tool-request-unresolved"
  | "pending-implementation-state"
  | "worktree-not-clean"
  | "branch-not-recorded"
  | "pr-not-recorded"
  | "pr-head-mismatch"
  | "review-base-missing"
  | "branch-not-pushed"
  | "no-committed-work"
  | "review-admission-rejected";

const CHECK_FAILURE_REASON: Record<ToolRequestContinuationCheck, ToolRequestContinuationReason> = {
  "guided-run-succeeded": "guided-run-not-successful",
  "configured-verification-command": "command-not-configured-verification",
  "no-repository-changes": "repository-changes-produced",
  "implementation-phase": "phase-not-implementation",
  "tool-request-resolved": "tool-request-unresolved",
  "no-pending-implementation-state": "pending-implementation-state",
  "worktree-clean": "worktree-not-clean",
  "branch-recorded": "branch-not-recorded",
  "pr-recorded": "pr-not-recorded",
  "pr-head-matches-branch": "pr-head-mismatch",
  "review-base-recorded": "review-base-missing",
  "branch-pushed": "branch-not-pushed",
  "committed-work-present": "no-committed-work",
  "review-admitted": "review-admission-rejected",
};

export interface ToolRequestContinuationInput {
  /** The runner-observed guided run. Never an agent's account of it. */
  guidedRun: {
    /** Exit code the runner itself observed. */
    exitCode: number;
    /** The exact command the runner executed. */
    command: string;
    /** Recorded disposition; only a `no-op` run can be direct-reviewed. */
    disposition: string;
    /** Whether the run left ANY repository change (dirty tree or new commit). */
    producedChanges: boolean;
  };
  /** `session.verification` — the operator-configured verification commands. */
  verificationCommands: VerificationCommands | undefined;
  /** Task phase the Tool Request was emitted from. */
  phase: string;
  /** True when an unresolved Tool Request remains after this resolution. */
  toolRequestUnresolved: boolean;
  /** Markers from {@link collectPendingImplementationMarkers}. */
  pendingMarkers: readonly ToolRequestPendingMarker[];
  /**
   * Repository state observed by the runner after disposition handling. Every
   * field is optional: an unprobeable value stays `undefined` and fails closed.
   */
  repository: {
    /** `git status --porcelain` was empty. */
    worktreeClean?: boolean;
    /** The issue branch this continuation is bound to. */
    branch?: string;
    /** `refs/heads/<branch>` on the local checkout. */
    localHeadSha?: string;
    /** `refs/heads/<branch>` on origin. */
    remoteHeadSha?: string;
    /** Commits on the issue branch since the recorded review base. */
    commitsSinceReviewBase?: number;
  };
  /** Evidence read from durable task context only. */
  durableContext: {
    /** A PR reference resolving to a PR number is recorded. */
    prRecorded: boolean;
    /** The recorded PR head branch. */
    prHeadBranch?: string;
    /** A usable review base is recorded (#681 check 4 / #918 E3). */
    reviewBaseRecorded: boolean;
  };
  /** Result of the existing review-admission contract (#681), unweakened. */
  reviewAdmitted: boolean;
}

/**
 * Bounded, path-safe evidence summary. Every field is a boolean, a small
 * number, or a value drawn from a closed set / bounded label — never a path, a
 * command's output, or a credential.
 */
export interface ToolRequestContinuationEvidence {
  /** `session.verification` KEY that matched, never the command text. */
  verificationName?: string;
  /** Issue branch the decision was made against. */
  branch?: string;
  producedChanges: boolean;
  worktreeClean: boolean;
  branchPushed: boolean;
  committedWork: boolean;
  prRecorded: boolean;
  prHeadMatchesBranch: boolean;
  reviewBaseRecorded: boolean;
  toolRequestResolved: boolean;
  reviewAdmitted: boolean;
  pendingMarkers: ToolRequestPendingMarker[];
  /** Checks that passed, in evaluation order. */
  checksPassed: ToolRequestContinuationCheck[];
  /** The first check that failed, when any did. */
  failedCheck?: ToolRequestContinuationCheck;
}

export interface ToolRequestContinuationDecision {
  phase: ToolRequestContinuationPhase;
  reason: ToolRequestContinuationReason;
  evidence: ToolRequestContinuationEvidence;
}

/** Maximum length of a label (branch / verification name) in the evidence record. */
export const MAX_EVIDENCE_LABEL_CHARS = 120;

/**
 * Bound a label for the durable evidence summary and drop anything that looks
 * like a local filesystem location: the evidence record reaches operator
 * surfaces and events, and #722 forbids publishing local absolute paths,
 * artifact locations, raw output, or credentials.
 */
export function boundEvidenceLabel(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.startsWith("/") || trimmed.startsWith("~") || /^[A-Za-z]:[\\/]/.test(trimmed)) return undefined;
  if (trimmed.includes("\\")) return undefined;
  return trimmed.length > MAX_EVIDENCE_LABEL_CHARS ? trimmed.slice(0, MAX_EVIDENCE_LABEL_CHARS) : trimmed;
}

/**
 * Decide where a resolved implementation Tool Request continues.
 *
 * Checks run in {@link TOOL_REQUEST_CONTINUATION_CHECKS} order and stop at the
 * first failure, so the recorded reason names the FIRST unmet precondition and
 * is stable for a given input regardless of which later evidence the caller was
 * able to collect. That ordering is what lets a caller skip the repository
 * probes entirely for a command no `session.verification` entry covers: the
 * eligibility check fails before any repository field is read.
 *
 * There is no partial credit (#918 §10.3 / R2): all checks or implementation.
 */
export function decideToolRequestContinuation(
  input: ToolRequestContinuationInput,
): ToolRequestContinuationDecision {
  const verification = resolveConfiguredVerification(input.guidedRun.command, input.verificationCommands);
  const branch = boundEvidenceLabel(input.repository.branch);
  const prHeadBranch = boundEvidenceLabel(input.durableContext.prHeadBranch);
  const branchPushed =
    typeof input.repository.localHeadSha === "string" &&
    input.repository.localHeadSha.length > 0 &&
    input.repository.localHeadSha === input.repository.remoteHeadSha;
  const committedWork =
    typeof input.repository.commitsSinceReviewBase === "number" && input.repository.commitsSinceReviewBase > 0;
  const prHeadMatchesBranch = branch !== undefined && prHeadBranch !== undefined && prHeadBranch === branch;

  const evidence: ToolRequestContinuationEvidence = {
    ...(verification ? { verificationName: boundEvidenceLabel(verification.name) } : {}),
    ...(branch !== undefined ? { branch } : {}),
    producedChanges: input.guidedRun.producedChanges,
    worktreeClean: input.repository.worktreeClean === true,
    branchPushed,
    committedWork,
    prRecorded: input.durableContext.prRecorded,
    prHeadMatchesBranch,
    reviewBaseRecorded: input.durableContext.reviewBaseRecorded,
    toolRequestResolved: !input.toolRequestUnresolved,
    reviewAdmitted: input.reviewAdmitted,
    pendingMarkers: [...input.pendingMarkers],
    checksPassed: [],
  };

  const outcomes: Record<ToolRequestContinuationCheck, boolean> = {
    "guided-run-succeeded": input.guidedRun.exitCode === 0,
    "configured-verification-command": verification !== undefined,
    // A run that produced repository changes is out of scope for #722 even when
    // the selected disposition later made the worktree clean: the committed or
    // discarded bytes are command output, not reviewed implementation work.
    "no-repository-changes": !input.guidedRun.producedChanges && input.guidedRun.disposition === "no-op",
    "implementation-phase": input.phase === "implementation",
    "tool-request-resolved": !input.toolRequestUnresolved,
    "no-pending-implementation-state": input.pendingMarkers.length === 0,
    "worktree-clean": input.repository.worktreeClean === true,
    "branch-recorded": branch !== undefined,
    "pr-recorded": input.durableContext.prRecorded,
    "pr-head-matches-branch": prHeadMatchesBranch,
    "review-base-recorded": input.durableContext.reviewBaseRecorded,
    "branch-pushed": branchPushed,
    "committed-work-present": committedWork,
    "review-admitted": input.reviewAdmitted,
  };

  for (const check of TOOL_REQUEST_CONTINUATION_CHECKS) {
    if (!outcomes[check]) {
      return {
        phase: "implementation",
        reason: CHECK_FAILURE_REASON[check],
        evidence: { ...evidence, failedCheck: check },
      };
    }
    evidence.checksPassed.push(check);
  }

  return { phase: "review", reason: "direct-review", evidence };
}

/** Durable record persisted on the task and mirrored into the routing event. */
export interface ToolRequestContinuationRecord {
  destination: ToolRequestContinuationPhase;
  reason: ToolRequestContinuationReason;
  decidedAt: string;
  /** Operator surface that produced the decision (`guided-run` or `grant`). */
  surface: string;
  evidence: ToolRequestContinuationEvidence;
}

export function buildToolRequestContinuationRecord(
  decision: ToolRequestContinuationDecision,
  surface: string,
  decidedAt: string,
): ToolRequestContinuationRecord {
  return {
    destination: decision.phase,
    reason: decision.reason,
    decidedAt,
    surface,
    evidence: decision.evidence,
  };
}
