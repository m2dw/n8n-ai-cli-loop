#!/usr/bin/env node
/**
 * admin — inspect task state and show CLI help.
 *
 * Command shape:
 *   node /path/to/dist/cli/admin.js help
 *   node /path/to/dist/cli/admin.js task-status \
 *     --session-id "addon-dev" \
 *     [--issue-number 123] \
 *     [--db-path /path/to/dev_loop.db]
 *
 * Output contract (issue #308, see docs/admin-cli-contract.md):
 *   - Operator-facing commands (task-status, list-stuck, recover,
 *     recover-cap-handoff) print human-readable text by default and emit
 *     structured JSON when --json is passed.
 *   - Machine/structured commands (context create, repo-lock, ...) default to
 *     JSON so existing n8n workflow / script callers keep parsing stdout.
 *   - Global flags: --json, --quiet, --verbose.
 *   - stdout carries results; stderr carries warnings/progress and human-mode
 *     errors. In JSON mode errors stay on stdout as { ok: false, error }.
 *
 * Exits 0 on success or safe no-op.
 * Exits 1 for validation or setup errors.
 */

import { execFileSync, spawnSync } from "child_process";
import { randomBytes } from "crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statfsSync, statSync, writeFileSync } from "fs";
import { dirname, isAbsolute, join, relative, resolve } from "path";
import { SqliteTaskStore } from "../stores/sqlite-task-store.js";
import { SqliteContextStore } from "../stores/sqlite-context-store.js";
import { SqliteSessionControlStore } from "../stores/sqlite-session-control-store.js";
import {
  countConsecutiveFailures,
  evaluateCircuitBreaker,
  fetchCircuitBreakerWindows,
  resolveCircuitBreakerPolicy,
} from "../core/session-control.js";
import type { RunLedgerEntry, SessionPauseState } from "../core/session-control.js";
import Database from "better-sqlite3";
import { SqliteOutboxStore, DEFAULT_DB_PATH } from "../stores/sqlite-outbox-store.js";
import { UNOBSERVABLE_L3_SIGNALS } from "../core/l3-intervention-aggregation.js";
import type { L3AggregationResult } from "../core/l3-intervention-aggregation.js";
import { listMergedL3Entries, aggregateL3EntriesForWindow } from "../core/l3-intervention-entries.js";
import {
  createBackup,
  listBackups,
  restoreBackup,
  verifyBackupEntry,
  pinBackup,
  unpinBackup,
  DEFAULT_BACKUP_DIR,
} from "../stores/sqlite-backup-store.js";
import { SqliteMaintenanceLock, seedMaintenanceLock } from "../stores/sqlite-maintenance-lock.js";
import { SqliteRetentionStore } from "../stores/sqlite-retention-store.js";
import type { PreviewResult, PruneRunResult } from "../stores/sqlite-retention-store.js";
import { RepoLockStore } from "../stores/repo-lock-store.js";
import type { AgentId, AiTask, TaskAttempts, TaskPatch, TaskPhase, TaskStatus } from "../core/task.js";
import type { ResolvedSession } from "../core/session.js";
import { applyTaskPatch, isClaimExpired } from "../core/transitions.js";
import {
  selectChangesRequestedFeedback,
  type ReviewFeedbackSelection,
} from "../core/github-app-review.js";
import {
  DEFAULT_SESSIONS_PATH,
  describeUnresolvedSessionId,
  JsonSessionRegistry,
} from "../registries/json-session-registry.js";
import { agentForPhase, ASSIGNMENT_CONTEXT_KEY, DEFAULT_FLOW, readResolvedAssignment } from "../core/assignment.js";
import type { ResolvedAssignment } from "../core/assignment.js";
import {
  enqueueStatusLabelEffects,
  recordRefinementHandoffCommentUndeliverable,
  workItemOutbox,
  sessionRedactionPaths,
} from "../core/outbox-effects.js";
import { OutboxEffectCollector } from "../core/phase-runner.js";
import { sanitizeBody, boundedExcerpt } from "../core/text-sanitize.js";
import { hasUnresolvedToolRequest } from "../core/tool-request.js";
import { GRANT_DEFAULT_MAX_USES, GRANT_DEFAULT_TTL_MS } from "../core/tool-request-grant.js";
import { parseRepoChangeAction } from "../core/tool-request-changes.js";
import type { RepoChangeAction } from "../core/tool-request-changes.js";
// Issue #1029: the guided run is a callable `{ request, context } →
// OperationResult` core (docs/operation-dispatch-port-contract.md §11.2). Every
// business rule it used to hold — one-shot grants, exact-command matching,
// dirty-worktree handling, the dispositions, artifact recording, continuation
// routing — now lives there; this module keeps only the shell around it: argv
// parsing, session resolution, store construction, rendering, and exit codes.
import {
  GUIDED_RUN_DISPOSITIONS,
  readStoredToolRequest,
  runToolRequestRun,
} from "../core/tool-request-run.js";
import type {
  GuidedRunDisposition,
  ToolRequestRunContext,
  ToolRequestRunRequest,
  ToolRequestRunTaskPort,
} from "../core/tool-request-run.js";
// Issue #1030: the operator resolution is a callable core for the same reason,
// and by the same split — `src/core/tool-request-resolve.ts` owns the guards,
// the resolution record, the transition and the publication; this module keeps
// argv, session resolution, rendering and exit codes.
import {
  parseToolRequestResolveParams,
  runToolRequestResolve,
} from "../core/tool-request-resolve.js";
import type {
  ToolRequestResolveContext,
  ToolRequestResolveRequest,
  ToolRequestResolveTaskPort,
} from "../core/tool-request-resolve.js";
import type { OutboxStore } from "../core/outbox.js";
// `probe`/`remoteHasBranch`/`sleepSync` used to be defined in this file. They
// moved to the shared spawn module in issue #1031: they are the git seam the two
// Tool Request operation cores take by injection, and the ChatOps composition
// root now builds those same contexts, which it could not do from an entrypoint
// module. Same functions, same behavior, one definition.
import {
  defaultCommandRunner,
  probe,
  remoteHasBranch,
  sleepSync,
} from "../handlers/command-runner.js";
import { listWorktrees, removeWorktree, canonicalizePath, IssueWorktreeLock, issueLockScope, DEFAULT_WORKTREE_LOCK_DIR } from "../handlers/worktree.js";
import {
  resolveWorktreeRoot,
  issueWorktreePath,
  issueWorktreeId,
  sessionWorktreeDir,
  classifyManagedWorktree,
  WORKTREE_ROOT_ENV,
} from "../core/worktree-paths.js";
import { assessWorktreeRecovery } from "../core/worktree-recovery.js";
import type { WorktreeRecoveryAssessment } from "../core/worktree-recovery.js";
import { boundVerificationOutput } from "../handlers/verification.js";
import {
  extractIssueVerificationCommands,
  extractIssueVerificationSections,
} from "../handlers/issue-verification-extractor.js";
import {
  deriveRequirementCommandId,
  validateVerificationAmendmentState,
  VERIFICATION_AMENDMENTS_CONTEXT_KEY,
} from "../core/verification-amendment.js";
import type {
  VerificationAmendmentContinuation,
  VerificationAmendmentOperation,
} from "../core/verification-amendment.js";
import { resolveEffectiveVerificationPlan } from "../core/verification-plan.js";
import type { EffectiveVerificationPlan } from "../core/verification-plan.js";
// The §13.2 equivalence the requirement gate itself applies; the resolve path
// decides which slot a displayed command addresses under the same rule.
import { matchesConfiguredVerificationCommand } from "../core/tool-request-continuation.js";
// Issue #1166: the operator's declared full-suite requirement alias, read for
// the read-only plan view so it reports what the lanes gate on.
import { fullSuiteRequirementDeclaration } from "../core/test-stage-routing.js";
import { refreshIssueVerification } from "../core/verification-refresh.js";
import type {
  IssueVerificationRefreshOutcome,
  VerificationRefreshIssueSource,
} from "../core/verification-refresh.js";
import {
  amendTaskVerification,
  describeTaskVerificationPlan,
  resetTaskVerification,
} from "../core/verification-amend.js";
import {
  describeStagedVerificationStatus,
  hasStagedVerificationSurface,
  type StageBundleView,
  type StagedVerificationStatusView,
} from "../core/staged-verification-status.js";
import type { StagedVerificationConfig } from "../core/staged-verification-config.js";
import type {
  TaskVerificationAmendOutcome,
  TaskVerificationPlanView,
  TaskVerificationResetDiff,
  TaskVerificationResetOutcome,
} from "../core/verification-amend.js";
import {
  normalizeCommitSha,
  readVerificationEvidenceBindingBlock,
  VERIFICATION_EVIDENCE_BINDING_CONTEXT_KEY,
} from "../core/verification-evidence.js";
import { runArtifactDir } from "../handlers/artifact-dir.js";
import {
  toolRequestResolveOperationContext,
  toolRequestRunOperationContext,
} from "../handlers/tool-request-operation-context.js";
import { makeOutboxKey, categorizeOutboxEntry, isOutboxClaimActive } from "../core/outbox.js";
import type { OutboxEntry, OutboxDeliveryStatus } from "../core/outbox.js";
import {
  deriveOwnershipScanCursorKey,
  planScanCursorRewind,
  scanCursorKeysFor,
  OUTBOX_SCAN_CURSOR_ROLES,
  type OutboxScanCursorAfterIds,
  type OutboxScanCursorRewindPlan,
} from "../core/outbox-scan-cursor.js";
import { adoptExistingPrForHead, branchName, extractPrNumber, resolvePrContext } from "../handlers/pr-helpers.js";
import type { PrReconciliationRefusal } from "../core/pr-reconciliation.js";
import {
  assessMergedPrProviderSupport,
  reconcileMergedPrTask,
} from "../core/merged-pr-reconciliation.js";
import type {
  MergedPrReconciliationOutcome,
  MergedPrReconciliationRefusal,
  MergedPrTaskReconciliationResult,
} from "../core/merged-pr-reconciliation.js";
import { fileURLToPath, pathToFileURL } from "url";
// Issue #822: `admin n8n deploy`. All ordering, verification, and publish
// policy is pure and lives in core/n8n-deploy.ts; this module only resolves the
// local facts (paths, derived workflow identity) and supplies the two side
// effects (a command runner and an artifact reader).
import {
  N8N_DEPLOY_LOCK_STALE_TTL_MS,
  N8N_RESTART_NOTICE,
  collectN8nDeployLocalPaths,
  executeN8nDeploy,
  formatCommandLine,
  n8nDeployChildLockScope,
  n8nDeployLockScope,
  planN8nDeploy,
  sanitizeDeployText,
} from "../core/n8n-deploy.js";
import type {
  N8nDeployCommand,
  N8nDeployExecution,
  N8nDeployLockAcquisition,
  N8nDeployPlan,
  N8nDeployStepResult,
} from "../core/n8n-deploy.js";
import {
  emit,
  die,
  report,
  writeOut,
  setOutputMode,
  extractOutputFlags,
  resolveOutputMode,
  CliExit,
} from "./cli-io.js";
import type { OutputMode } from "./cli-io.js";
import {
  VALID_PHASES,
  parseCommonOptions,
  resolveSessionSelector,
  tokenizeArgs,
} from "./admin-command.js";
import { runAdminUi, formatAdminCommand } from "./admin-ui.js";
import { ECOSYSTEM_PRESETS, PRESET_NAMES, findPreset } from "../core/presets.js";
import { resolveReviewDisputeSettings, isTerminalLineageState } from "../core/review-dispute.js";
// Issue #867: the operator surface of the chain-aware refinement lane. Same
// posture as the dispute projection below — a pure read of the §15 task-context
// block, shared with any other surface that needs it.
import { renderRefinementLines, summarizeRefinementStatus } from "../core/issue-refinement-status.js";
import type { RefinementTaskStatus } from "../core/issue-refinement-status.js";
// Issue #977: the §15 progress milestones live in the task EVENT log, so the
// operator view of "where is this Issue now" needs the key that says whether a
// task is in the lane at all before it pays for that read.
import { REFINEMENT_CONTEXT_KEY } from "../core/issue-refinement.js";
// Issue #848: the operator surface of the review-dispute protocol. The
// projection is shared with the admin UI so the two cannot disagree; the
// transition/commit path is #840's, reused rather than reimplemented, so an
// operator action is bound by the same CAS, caps, and audit record a run is.
import { isLineageId } from "../core/review-dispute-lineage.js";
import { validateReviewDisputeContext } from "../core/review-dispute-validation.js";
import type { ReviewDisputeFailure } from "../core/review-dispute-validation.js";
import { applyDisputeTransition } from "../core/review-dispute-transition.js";
import {
  REVIEW_DISPUTE_CONTEXT_KEY,
  REVIEW_DISPUTE_TRANSITION_EVENT,
  commitDisputeTransition,
} from "../core/review-dispute-commit.js";
import { disputeReopenArgv, summarizeDisputeStatus } from "../core/review-dispute-status.js";
import type { DisputeTaskStatus } from "../core/review-dispute-status.js";
import { formatEvidenceParty } from "../core/review-dispute-evidence-state.js";
// Issue #1073: the same capability answer the reviewer's own reconsideration
// turn reads (contract §17.12/§8.2) — doctor reports it rather than inferring
// support from CLI availability alone, since a Codex reviewer's binary is
// available while its reconsideration turn is not.
import { reconsiderationAgentSupport } from "../handlers/review-reconsideration.js";
// Issue #849: the read-only, event-derived operator report. Pure aggregation
// lives in core; this file only resolves the session's tasks and renders.
import { aggregateDisputeMetrics } from "../core/review-dispute-metrics.js";
import type { DisputeMetrics } from "../core/review-dispute-metrics.js";
import type { AntigravityResearchConfig, CodexConfig, ReviewDisputeConfig } from "../core/session.js";
import {
  createArbiterCandidateResolver,
  evaluateArbiterCandidates,
  type ArbiterCandidateRejection,
} from "../core/review-arbiter-profile.js";
import type { ArbiterCliAvailability } from "../core/review-arbiter-profile.js";
import {
  CLI_PROBE_STUB_ENV,
  TRANSIENT_SPAWN_ERROR_CODES,
  TRANSIENT_SPAWN_RETRY_BACKOFF_MS,
  describeProbeOutcome,
  parseCliProbeStub,
} from "../core/cli-probe.js";
import type { CliProbeOutcome } from "../core/cli-probe.js";
import type { EcosystemPreset } from "../core/presets.js";
import {
  parseIssueDiscussArgs,
  runIssueDiscussPreview,
  parseIssueDiscussPostArgs,
  runIssueDiscussPost,
  defaultIssueDiscussReader,
} from "./issue-discuss.js";
import type { IssueDiscussReader } from "./issue-discuss.js";
import { runContextModeStatus } from "./context-mode-status.js";
import { runSessionAudit } from "./session-audit.js";
import { parseIssuePlanArgs, runIssuePlanPreview } from "./issue-plan.js";
import { parseIssuePlanAiArgs, runIssuePlanAiPreview } from "./issue-plan-ai.js";
import { parseEvaluateHistoryArgs, runEvaluateHistory } from "./issue-plan-history.js";
import { parseRefinementRunArgs, runRefinementRun } from "./issue-refinement-loop.js";
import {
  parseRefinementRecoverArgs,
  runRefinementRecover,
} from "./issue-refinement-recover.js";
import { runIssueActivate, runIssueSuspend } from "./issue-activation.js";
import { runChainList, runChainShow, runChainValidate } from "./chain-inspect.js";
import {
  runAgentProfileList,
  runAgentProfileRefresh,
  runAgentProfileShow,
  runAgentProfileValidate,
} from "./agent-profile.js";
import { runChainSync } from "./chain-sync.js";
import { runChainAppend, runChainNew, runChainPrepend } from "./chain-edit.js";
import { runChainFork, runChainMerge } from "./chain-advanced.js";
import { prReviewReaderFromGhRunner } from "./pr-review-reader.js";
import type { PrReviewReader } from "./pr-review-reader.js";
import { defaultGhRunner, ghRunnerFromCommandRunner } from "../providers/github/gh-runner.js";
// The gh-backed live work-item read the §10 refresh uses (issue #1041). Reused
// from the refinement lane rather than re-derived: one `gh issue view` shape,
// so a refresh and a refinement snapshot can never read an Issue differently.
import { createGhRefinementReads, runGhViaRunner } from "./github-intake.js";
import { resolveGhRunner } from "../providers/github/github-app-auth.js";
import type { GhRunnerAuthDeps } from "../providers/github/github-app-auth.js";
import { resolveSessionRepoHost } from "../providers/repo-host-factory.js";
import type { SessionRepoHost } from "../providers/repo-host-factory.js";
import { buildUntrackedPatch } from "../handlers/implementation.js";

// ---------------------------------------------------------------------------
// Subcommand: help
// ---------------------------------------------------------------------------

export interface CommandOption {
  flag: string;
  description: string;
}

export interface CommandInfo {
  name: string;
  description: string;
  entrypoint?: string;
  options: CommandOption[];
}

/**
 * The command registry, exported so a documentation test can check a document's
 * claims against the CLI itself (issue #849) rather than against a second copy
 * of the command list written in the test. Read-only for every caller: `help`
 * renders it, and nothing mutates it.
 */
export const COMMANDS: CommandInfo[] = [
  {
    name: "help",
    description: "Show this help message.",
    options: [],
  },
  {
    name: "ui",
    description:
      "Launch an interactive terminal UI for operational recovery: list active tasks across sessions, inspect a selected task, and run safe recovery actions (recover, review-loop cap reset) through the existing admin commands. State-changing actions are confirmed and print the exact non-interactive command. Requires a TTY; in non-TTY environments it prints the equivalent commands and exits non-zero.",
    options: [
      { flag: "--session-id <id>", description: "Restrict the list to a single canonical session ID (optional; default lists all sessions in sessions.json)." },
      { flag: "--session-ref <ref>", description: "Restrict the list to a single session by short reference (sessionId, sessionNo, or alias). Mutually exclusive with --session-id." },
      { flag: "--sessions-path <path>", description: "Path to sessions.json, used to enumerate sessions and resolve --session-ref (optional)." },
      { flag: "--db-path <path>", description: "Path to SQLite database (optional)." },
    ],
  },
  {
    name: "task-status",
    description: "Show task status for a session. Filters to a single task when --issue-number is provided.",
    options: [
      { flag: "--session-id <id>", description: "Canonical session ID to query (required unless --session-ref is given)." },
      { flag: "--session-ref <ref>", description: "Short session reference (sessionId, sessionNo, or alias) resolved to the canonical sessionId. Mutually exclusive with --session-id." },
      { flag: "--issue-number <n>", description: "Filter to a specific issue number (optional)." },
      { flag: "--sessions-path <path>", description: "Path to sessions.json, used to resolve --session-ref (optional)." },
      { flag: "--db-path <path>", description: "Path to SQLite database (optional)." },
    ],
  },
  {
    name: "status",
    description:
      "Worktree-aware operator status (issue #406). For a session — and optionally one issue — combines the SQLite task state with the live local/remote branch, PR, repo + per-issue lock, and per-issue worktree state, classifies whether each issue is runnable, blocked, waiting on a Tool Request, failed, capped, stale, or needs human review, and suggests the next operator action. Human-readable by default; pass --json for machine/admin-UI output. Closed/completed (done) tasks are hidden unless --all or an explicit --issue-number is given. Public output never includes absolute local paths: worktrees are identified by their stable id / root-relative path and lock file paths are omitted.",
    options: [
      { flag: "--session-id <id>", description: "Canonical session ID to query (required unless --session-ref is given)." },
      { flag: "--session-ref <ref>", description: "Short session reference (sessionId, sessionNo, or alias) resolved to the canonical sessionId. Mutually exclusive with --session-id." },
      { flag: "--issue-number <n>", description: "Restrict the view to one issue (optional). An explicit issue is always shown, even when done or with no task." },
      { flag: "--all", description: "Include closed/completed (done) tasks (default: hidden)." },
      { flag: "--discover-pr", description: "With --issue-number, and only when that task's context has no persisted PR URL: live-query the repo host for a matching open PR on the expected head branch and report it separately as `discoveredPr`, without recording it in task context (issue #1002). Opt-in; default off." },
      { flag: "--sessions-path <path>", description: "Path to sessions.json, used to resolve the repo/worktree roots and --session-ref (optional)." },
      { flag: "--db-path <path>", description: "Path to SQLite database (optional)." },
      { flag: "--lock-dir <path>", description: "Directory holding the per-session repo lock (optional)." },
      { flag: "--worktree-lock-dir <path>", description: "Directory holding the per-issue worktree locks (optional)." },
    ],
  },
  {
    name: "github-intake",
    description: "Scan GitHub for labelled issues and enqueue them into SQLite.",
    entrypoint: "dist/cli/github-intake.js",
    options: [
      { flag: "--context-id <id>", description: "Context ID (resolves sessionId; required when --session-id is omitted)." },
      { flag: "--session-id <id>", description: "Session ID (required when --context-id is not provided)." },
      { flag: "--sessions-path <path>", description: "Path to sessions.json (optional)." },
      { flag: "--db-path <path>", description: "Path to SQLite database (optional)." },
      { flag: "--limit <n>", description: "Maximum issues to scan (default: 100)." },
      { flag: "--supported-phases <csv>", description: "Comma-separated phases to enqueue (default: research)." },
      { flag: "--dry-run", description: "Scan without writing to the database." },
    ],
  },
  {
    name: "enqueue-task",
    description: "Insert a queued task directly into SqliteTaskStore.",
    entrypoint: "dist/cli/enqueue-task.js",
    options: [
      { flag: "--session-id <id>", description: "Session ID (required)." },
      { flag: "--issue-number <n>", description: "Issue number to enqueue (required)." },
      { flag: "--phase <phase>", description: "Task phase: implementation | review | conflict_resolution | research | planner (required)." },
      { flag: "--priority <p>", description: "Task priority: high | normal | low (default: normal)." },
      { flag: "--implementation-agent <agent>", description: "Override implementation agent: claude | codex | gemini." },
      { flag: "--review-agent <agent>", description: "Override review agent: claude | codex | gemini." },
      { flag: "--research-agent <agent>", description: "Override research agent: claude | codex | gemini." },
      { flag: "--context-json <json>", description: "Extra context object merged into the task (JSON object string)." },
      { flag: "--sessions-path <path>", description: "Path to sessions.json (optional)." },
      { flag: "--db-path <path>", description: "Path to SQLite database (optional)." },
    ],
  },
  {
    name: "run-one-phase",
    description: "Claim one task from the queue and execute its phase handler.",
    entrypoint: "dist/cli/run-one-phase.js",
    options: [
      { flag: "--context-id <id>", description: "Context ID (resolves sessionId and runId; required when --session-id is omitted)." },
      { flag: "--session-id <id>", description: "Session ID (required when --context-id is not provided)." },
      { flag: "--run-id <id>", description: "Unique run identifier, e.g. n8n execution ID (optional when --context-id is provided; defaults to contextId)." },
      { flag: "--supported-phases <csv>", description: "Comma-separated phases this worker handles (default: research)." },
      { flag: "--worker-id <id>", description: "Worker identifier (default: n8n-cli)." },
      { flag: "--sessions-path <path>", description: "Path to sessions.json (optional)." },
      { flag: "--db-path <path>", description: "Path to SQLite database (optional)." },
    ],
  },
  {
    name: "dispatch-outbox",
    description: "Flush pending GitHub side effects (comments, labels) from the SQLite outbox.",
    entrypoint: "dist/cli/dispatch-outbox.js",
    options: [
      { flag: "--session-id <id>", description: "Session ID (optional; resolves cwd from sessions.json)." },
      { flag: "--context-id <id>", description: "Context ID (optional; resolves sessionId from context store)." },
      { flag: "--db-path <path>", description: "Path to SQLite database (optional)." },
      { flag: "--limit <n>", description: "Maximum outbox entries to dispatch per run (default: 50)." },
      { flag: "--cwd <path>", description: "Working directory for gh commands (optional)." },
      { flag: "--sessions-path <path>", description: "Path to sessions.json (optional)." },
    ],
  },
  {
    name: "outbox list",
    description:
      "List outbox rows for a session's repo(s), classified as pending (eligible now), delayed (backing off after a failed attempt), in_flight (a dispatch attempt currently holds the row's claim), or dead (exhausted retries or operator-cancelled) (issue #607). Never prints raw comment bodies, secrets, tokens, or local paths — only a safe summary (id, topic, owner/repo, issue/PR number, attempt count, sanitized last error, timestamps). Human-readable by default; --json emits a stable machine payload.",
    options: [
      { flag: "--session-id <id>", description: "Canonical session ID to scope the listing to (required unless --session-ref is given)." },
      { flag: "--session-ref <ref>", description: "Short session reference (sessionId, sessionNo, or alias) resolved to the canonical sessionId. Mutually exclusive with --session-id." },
      { flag: "--status <status>", description: "Filter to one delivery status: pending | delayed | in_flight | dead (optional; omit to show all)." },
      { flag: "--limit <n>", description: "Maximum rows to display (default: 50). Counts in the summary always reflect the full matching set, not just the displayed page." },
      { flag: "--sessions-path <path>", description: "Path to sessions.json, used to resolve --session-ref and the session's repo(s) (optional)." },
      { flag: "--db-path <path>", description: "Path to SQLite database (optional)." },
    ],
  },
  {
    name: "outbox retry",
    description:
      "Recover a single outbox row for another dispatch attempt (issue #607): clears its delayed/dead-letter/cancelled state and resets its attempt count, so the next `dispatch-outbox` run treats it as freshly eligible. When the session's persisted scan cursors have already advanced past the row, they are rewound to just before it in the same transaction so the revived row is actually re-scanned instead of stranded below the scan window (issue #820); a cursor that does not exist is never created. Refuses a row that does not belong to the given session's repo(s). Previews by default (the preview reports which cursor roles would be rewound); pass --yes to apply. A row already sent, or already immediately eligible with nothing to recover, is a safe no-op.",
    options: [
      { flag: "--session-id <id>", description: "Canonical session ID that owns the row (required unless --session-ref is given)." },
      { flag: "--session-ref <ref>", description: "Short session reference (sessionId, sessionNo, or alias) resolved to the canonical sessionId. Mutually exclusive with --session-id." },
      { flag: "--id <n>", description: "The outbox row id to retry, from `outbox list` (required)." },
      { flag: "--yes", description: "Actually retry the row (without it, the command only previews)." },
      { flag: "--sessions-path <path>", description: "Path to sessions.json, used to resolve --session-ref and validate row ownership (optional)." },
      { flag: "--db-path <path>", description: "Path to SQLite database (optional)." },
    ],
  },
  {
    name: "outbox cancel",
    description:
      "Permanently exclude a single outbox row from dispatch (issue #607): marks it cancelled and dead-lettered so it is never retried, without deleting its history. Refuses a row that does not belong to the given session's repo(s). Previews by default; pass --yes to apply. A row already sent, or already cancelled, is a safe no-op. A cancelled row can still be recovered later with `outbox retry`.",
    options: [
      { flag: "--session-id <id>", description: "Canonical session ID that owns the row (required unless --session-ref is given)." },
      { flag: "--session-ref <ref>", description: "Short session reference (sessionId, sessionNo, or alias) resolved to the canonical sessionId. Mutually exclusive with --session-id." },
      { flag: "--id <n>", description: "The outbox row id to cancel, from `outbox list` (required)." },
      { flag: "--yes", description: "Actually cancel the row (without it, the command only previews)." },
      { flag: "--sessions-path <path>", description: "Path to sessions.json, used to resolve --session-ref and validate row ownership (optional)." },
      { flag: "--db-path <path>", description: "Path to SQLite database (optional)." },
    ],
  },
  {
    name: "list-stuck",
    description: "List failed, stale, and mismatched tasks in one view. Stale = claimed/running with an expired lease. Mismatched = ownerRunId/status inconsistency.",
    options: [
      { flag: "--session-id <id>", description: "Session ID to query (required)." },
      { flag: "--db-path <path>", description: "Path to SQLite database (optional)." },
    ],
  },
  {
    name: "recover",
    description: "Reset failed or stuck tasks back to queued so they can be retried. Recovers tasks with status failed, claimed, or running.",
    options: [
      { flag: "--session-id <id>", description: "Canonical session ID to query (required unless --session-ref is given)." },
      { flag: "--session-ref <ref>", description: "Short session reference (sessionId, sessionNo, or alias) resolved to the canonical sessionId. Mutually exclusive with --session-id." },
      { flag: "--issue-number <n>", description: "Recover a single task by issue number (optional; omit to recover all recoverable tasks)." },
      { flag: "--phase <phase>", description: "Override the phase when re-queuing (optional; defaults to the task's current phase). Required when --from is provided." },
      { flag: "--from <status>", description: "Recover from a specific human-handoff status. Only 'ready_for_human' is accepted. When provided, --phase is required." },
      { flag: "--sessions-path <path>", description: "Path to sessions.json, used to resolve --session-ref (optional)." },
      { flag: "--db-path <path>", description: "Path to SQLite database (optional)." },
      { flag: "--dry-run", description: "Preview which tasks would be recovered without making changes." },
    ],
  },
  {
    name: "recover-cap-handoff",
    description: "Recover tasks blocked by the review-loop cap back to queued so the review cycle can restart. Only targets tasks with status ready_for_human where reviewLoopCapReached is set in context.",
    options: [
      { flag: "--session-id <id>", description: "Canonical session ID to query (required unless --session-ref is given)." },
      { flag: "--session-ref <ref>", description: "Short session reference (sessionId, sessionNo, or alias) resolved to the canonical sessionId. Mutually exclusive with --session-id." },
      { flag: "--issue-number <n>", description: "Recover a single task by issue number (optional; omit to recover all cap-handoff tasks)." },
      { flag: "--phase <phase>", description: "Override the phase when re-queuing (optional; defaults to review)." },
      { flag: "--sessions-path <path>", description: "Path to sessions.json, used to resolve --session-ref (optional)." },
      { flag: "--db-path <path>", description: "Path to SQLite database (optional)." },
      { flag: "--dry-run", description: "Preview which tasks would be recovered without making changes." },
    ],
  },
  {
    name: "dispute status",
    description:
      "Show the persisted review-dispute state for one task (issue #848, docs/review-dispute-contract.md): every structured lineage with its version, severity, repository-relative affected boundary, current state and terminal outcome, the rebuttal/reconsideration/arbitration-pass/malformed-arbiter/evidence-round counters, humanGate and reopenRequested flags, the task-level pendingReReview and resolvedWithoutChanges flags, the §7.1 routing intent recorded by the last transition event, the last reviewer reconsideration run with the tool policy it actually enforced (`no-tools` or `read-bounded`, contract §17.6 D2), and the one supported next action — or an explicit statement that no automated action is authorized, with the exact stop reason. Read-only. Reads persisted task context and bounded task events only; arbiter reasoning, confidence, and evidence content are not persisted state and are never shown. A task with no reviewDispute block reports that and exits cleanly.",
    options: [
      { flag: "--session-id <id>", description: "Canonical session ID (required unless --session-ref is given)." },
      { flag: "--session-ref <ref>", description: "Short session reference (sessionId, sessionNo, or alias) resolved to the canonical sessionId. Mutually exclusive with --session-id." },
      { flag: "--issue-number <n>", description: "Issue number whose dispute state to show (required)." },
      { flag: "--sessions-path <path>", description: "Path to sessions.json, used to resolve --session-ref (optional)." },
      { flag: "--db-path <path>", description: "Path to SQLite database (optional)." },
    ],
  },
  {
    name: "dispute reopen",
    description:
      "Record a §6.4 reopen request on a TERMINAL review-dispute lineage (issue #848). This is the only operator-initiated transition the contract defines: it flags a resolution for human attention and parks the task at ready_for_human under §7.1 rule 1. It does NOT overturn the resolution, change the lineage's state (terminal states are immutable audit records), reset any counter, or bypass any §6.1 cap, and it posts no public comment (§11 publishes resolutions and escalations, not requests). Requires the exact lineage ID and its current version: a lineage at a different version, in a non-terminal state, or on a claimed/running task is refused. Preview by default; pass --yes to apply. A request already on file is an informative no-op that exits 0. There is no command to resolve an escalated_human lineage back into automation — the contract defines no such transition; see §15 of docs/review-dispute-contract.md.",
    options: [
      { flag: "--session-id <id>", description: "Canonical session ID (required unless --session-ref is given)." },
      { flag: "--session-ref <ref>", description: "Short session reference (sessionId, sessionNo, or alias) resolved to the canonical sessionId. Mutually exclusive with --session-id." },
      { flag: "--issue-number <n>", description: "Issue number whose lineage to flag (required)." },
      { flag: "--lineage-id <id>", description: "Exact runner-minted lineage ID to flag, e.g. ln-0123456789ab (required). List them with `admin dispute status`." },
      { flag: "--version <n>", description: "The lineage's CURRENT version (required). A mismatch is refused rather than applied, so a revised finding cannot be flagged by a stale command." },
      { flag: "--yes", description: "Actually record the request (without it, the command only previews)." },
      { flag: "--sessions-path <path>", description: "Path to sessions.json, used to resolve --session-ref and the session's §6.1 limits (optional)." },
      { flag: "--db-path <path>", description: "Path to SQLite database (optional)." },
    ],
  },
  {
    name: "dispute metrics",
    description:
      "Report review-dispute activity for one session, derived entirely from the persisted review.dispute.transition task events (issue #849, docs/review-dispute-operations.md). Counts findings opened, rebuttals recorded and rejected, reconsiderations, material/non-material/ambiguous revisions, arbitration verdicts and malformed attempts, evidence rounds requested and recorded, terminal outcomes by literal, human escalations, and §6.4 reopen requests. Read-only and offline: it makes no GitHub or network call, mutates nothing, opens no §10.2 artifact, and reads no public comment. Duplicate deliveries are deduplicated by transition key, so a retried worker or a replayed outbox row cannot inflate a count. lineagesResolvedWithoutHuman is an observable proxy — lineages that reached a non-escalated terminal state inside the window — not a claim about review loops that would otherwise have happened.",
    options: [
      { flag: "--session-id <id>", description: "Canonical session ID to report on (required unless --session-ref is given)." },
      { flag: "--session-ref <ref>", description: "Short session reference (sessionId, sessionNo, or alias) resolved to the canonical sessionId. Mutually exclusive with --session-id." },
      { flag: "--issue-number <n>", description: "Restrict the report to one task (optional; omit to cover every task in the session)." },
      { flag: "--since <iso>", description: "Only count transition events at or after this ISO-8601 timestamp (optional). Applied to the event's createdAt; no schema change and no new index." },
      { flag: "--until <iso>", description: "Only count transition events at or before this ISO-8601 timestamp (optional)." },
      { flag: "--sessions-path <path>", description: "Path to sessions.json, used to resolve --session-ref (optional)." },
      { flag: "--db-path <path>", description: "Path to SQLite database (optional)." },
    ],
  },
  {
    name: "task clear-delay",
    description:
      "Clear the retry backoff delay (not_before) on a queued task, making it immediately eligible for the next worker run (issue #584). Preview by default; pass --yes to apply. Refuses claimed, running, or otherwise non-queued tasks. If the delay is already absent the command exits cleanly without mutating anything.",
    options: [
      { flag: "--session-id <id>", description: "Canonical session ID (required unless --session-ref is given)." },
      { flag: "--session-ref <ref>", description: "Short session reference (sessionId, sessionNo, or alias) resolved to the canonical sessionId. Mutually exclusive with --session-id." },
      { flag: "--issue-number <n>", description: "Issue number whose retry delay to clear (required)." },
      { flag: "--yes", description: "Actually clear the delay (without it, the command only previews)." },
      { flag: "--sessions-path <path>", description: "Path to sessions.json, used to resolve --session-ref (optional)." },
      { flag: "--db-path <path>", description: "Path to SQLite database (optional)." },
    ],
  },
  {
    name: "task cancel",
    description:
      "Terminally cancel a task (issue #608). Available from any non-terminal status (queued, claimed, running, blocked, ready_for_human); refuses a task already cancelled (informative no-op) or one that reached a different terminal status (done/failed). A claimed/running task is not force-stopped — cancellation takes effect at the run's next safe phase boundary. Preview by default; pass --yes to apply. Posts a bounded, path-safe comment to the backing work item; does not touch labels.",
    options: [
      { flag: "--session-id <id>", description: "Canonical session ID (required unless --session-ref is given)." },
      { flag: "--session-ref <ref>", description: "Short session reference (sessionId, sessionNo, or alias) resolved to the canonical sessionId. Mutually exclusive with --session-id." },
      { flag: "--issue-number <n>", description: "Issue number of the task to cancel (required)." },
      { flag: "--reason <text>", description: "Free-text reason recorded on the task event and included in the operator-visible comment (optional)." },
      { flag: "--yes", description: "Actually cancel the task (without it, the command only previews)." },
      { flag: "--sessions-path <path>", description: "Path to sessions.json, used to resolve --session-ref (optional)." },
      { flag: "--db-path <path>", description: "Path to SQLite database (optional)." },
    ],
  },
  {
    name: "task reconcile-closed",
    description:
      "Cancel queued/blocked/claimed/running/ready_for_human tasks whose backing GitHub Issue has been closed as not_planned (issue #608), so an abandoned Issue can never resurface as later implementation. GitHub work items only. Preview by default; pass --yes to apply. Omit --issue-number to scan every non-terminal task in the session.",
    options: [
      { flag: "--session-id <id>", description: "Canonical session ID (required unless --session-ref is given)." },
      { flag: "--session-ref <ref>", description: "Short session reference (sessionId, sessionNo, or alias) resolved to the canonical sessionId. Mutually exclusive with --session-id." },
      { flag: "--issue-number <n>", description: "Scan only this issue's task (optional; omit to scan every non-terminal task in the session)." },
      { flag: "--yes", description: "Actually cancel eligible tasks (without it, the command only previews)." },
      { flag: "--sessions-path <path>", description: "Path to sessions.json, used to resolve --session-ref (optional)." },
      { flag: "--db-path <path>", description: "Path to SQLite database (optional)." },
    ],
  },
  {
    name: "task reconcile-merged",
    description:
      "Reconcile tasks whose exact recorded pull request was merged outside the loop (issue #1048, docs/merged-pr-reconciliation-contract.md). Reads the live PR state for the task's recorded prUrl — never a branch guess, never a search for merged PRs — and completes the ones the contract makes eligible: queued/blocked/ready_for_human become done, failed/cancelled keep their status and record the merge. Lifecycle metadata only: it writes the task row, one task event, and one bounded work-item comment, and never deletes a worktree or a branch, never touches a label, and never edits the work item. Preview by default (every read, no write); pass --yes to apply. Omit --issue-number to scan every non-`done` task in the session. Refuses, without writing, on: an active claim or live Issue lock, an expired claim that `admin recover` owns, unusable claim metadata, an unresolved Tool Request, a missing or mismatched PR identity, a PR that is open or closed-unmerged, a malformed reconciliation history, a provider read failure, or a task that changed mid-run. There is no --force. GitHub repo hosts only: Gitea reports PR state as open/closed, so a merged PR is indistinguishable from a closed-unmerged one. Disk-space workflow: run `admin worktree cleanup` first, use this command only if more space must be reclaimed, then run the unchanged `worktree cleanup` again (a reconciled task is `done`, which cleanup already prunes).",
    options: [
      { flag: "--session-id <id>", description: "Canonical session ID (required unless --session-ref is given)." },
      { flag: "--session-ref <ref>", description: "Short session reference (sessionId, sessionNo, or alias) resolved to the canonical sessionId. Mutually exclusive with --session-id." },
      { flag: "--issue-number <n>", description: "Reconcile only this issue's task (optional; omit to scan every non-`done` task in the session)." },
      { flag: "--yes", description: "Actually apply the reconciliation (without it, the command only previews). Confirms task-state mutation only; it never overrides a refusal." },
      { flag: "--worktree-lock-dir <path>", description: "Directory holding the per-issue worktree locks, read to detect an in-flight run (optional)." },
      { flag: "--sessions-path <path>", description: "Path to sessions.json, used to resolve --session-ref and the session's repo host (optional)." },
      { flag: "--db-path <path>", description: "Path to SQLite database (optional)." },
    ],
  },
  {
    name: "issue suspend",
    description:
      "Suspend automation for one or more Issues by removing their currently-present execution labels — the status:*/agent:* labels core/github-intake.ts reads to pick up an Issue — while preserving every other label (issue #787). Resolves the execution-label vocabulary from session/flow configuration, never a hard-coded agent or phase. Records exactly which labels were removed so a later `admin issue activate` restores only what THIS operation suspended. Repeated calls are idempotent; a partial per-Issue failure never blocks the rest of the batch. Preview by default; pass --yes to apply.",
    options: [
      { flag: "<issue[,issue...]>", description: "One or more Issue numbers, comma-separated (required positional argument)." },
      { flag: "--session-id <id>", description: "Canonical session ID (required unless --session-ref is given)." },
      { flag: "--session-ref <ref>", description: "Short session reference (sessionId, sessionNo, or alias) resolved to the canonical sessionId. Mutually exclusive with --session-id." },
      { flag: "--yes", description: "Actually remove the labels (without it, the command only previews)." },
      { flag: "--sessions-path <path>", description: "Path to sessions.json, used to resolve --session-ref (optional)." },
      { flag: "--db-path <path>", description: "Path to SQLite database (optional)." },
    ],
  },
  {
    name: "issue activate",
    description:
      "Restore automation for one or more Issues by re-adding exactly the execution labels a prior `admin issue suspend` recorded for each Issue (issue #787). Never restores optimistically: an Issue with no standing suspension is a safe no-op, and a partial per-Issue failure leaves only the still-missing labels on record for a retry. Run this only after verifying the intended GitHub Issue Relationship state — this command does not check relationships itself. Preview by default; pass --yes to apply.",
    options: [
      { flag: "<issue[,issue...]>", description: "One or more Issue numbers, comma-separated (required positional argument)." },
      { flag: "--session-id <id>", description: "Canonical session ID (required unless --session-ref is given)." },
      { flag: "--session-ref <ref>", description: "Short session reference (sessionId, sessionNo, or alias) resolved to the canonical sessionId. Mutually exclusive with --session-id." },
      { flag: "--yes", description: "Actually restore the labels (without it, the command only previews)." },
      { flag: "--sessions-path <path>", description: "Path to sessions.json, used to resolve --session-ref (optional)." },
      { flag: "--db-path <path>", description: "Path to SQLite database (optional)." },
    ],
  },
  {
    name: "agent-profile list",
    description:
      "Show the effective agent runtime profile catalog (issue #913, docs/agent-runtime-profiles-contract.md §11.4): the `agent-profiles.json` overlay merged over the built-in catalog, per provider — its capability descriptors, every declared runtime profile with each setting's concrete value, all four quality bindings with the profile they name, and which agents resolve through that provider. Every value is labelled built-in or overridden, so an overlay's effect is visible without diffing a file against a compiled-in constant. Works with no catalog file present, in which case the built-in defaults are what is shown. Read-only; runs no agent and spawns nothing.",
    options: [
      { flag: "--session-id <id>", description: "Read `session.agentRuntime.profilesPath` from this session when resolving which catalog file applies (optional; omit to use AGENT_PROFILES_FILE or the default location beside sessions.json)." },
      { flag: "--session-ref <ref>", description: "Short session reference (sessionId, sessionNo, or alias) resolved to the canonical sessionId. Mutually exclusive with --session-id." },
      { flag: "--sessions-path <path>", description: "Path to sessions.json, which also fixes the default catalog location (agent-profiles.json beside it) and resolves --session-ref (optional)." },
    ],
  },
  {
    name: "agent-profile show",
    description:
      "Show what one agent would actually run (issue #913). Resolves the agent's provider through the same fail-closed runtime registry a phase uses, then reports all four quality levels: the profile each level binds (and the other levels sharing it), and the concrete model, reasoning effort, budget, binary, and provider options the §8.1 precedence ladder resolves for it — each value labelled with the layer that supplied it (an env break-glass override, an operator pin, the overlay file, or the built-in catalog). An unset value is reported as an absence with its reason, never as a model named \"default\". Answers \"which model and effort will this agent use at this quality?\" without spending a token. Addresses a catalog and a session, never one task: a task-level quality or profile pin is not consulted. Exits non-zero when a level cannot resolve, reporting the refusal reason against that level while still showing the ones that do. Read-only; never prints an environment variable's name-value pairs beyond the settings themselves, and never a credential.",
    options: [
      { flag: "<agent>", description: "Agent id to resolve: claude | codex | gemini (required positional argument)." },
      { flag: "--quality <level>", description: "Which of light | normal | strong | maximum to mark as selected (optional; defaults to the session's agentRuntime.defaultQuality, else normal). All four levels are reported either way." },
      { flag: "--session-id <id>", description: "Apply this session's `agentRuntime` selection: its catalog path, its default quality, and its per-agent profile pin (optional)." },
      { flag: "--session-ref <ref>", description: "Short session reference (sessionId, sessionNo, or alias) resolved to the canonical sessionId. Mutually exclusive with --session-id." },
      { flag: "--sessions-path <path>", description: "Path to sessions.json, which also fixes the default catalog location and resolves --session-ref (optional)." },
    ],
  },
  {
    name: "agent-profile validate",
    description:
      "Validate the effective (or a candidate) agent runtime profile catalog before adopting it (issue #913). Runs the same load-time gate a phase run does — schema version, closed schema, forbidden keys, every quality binding naming a declared profile, every profile conforming to its provider's capability descriptor — and then the resolution-time gate for every agent at every quality level under this environment and this session's pins, so an invalid break-glass override or a pin naming an undeclared profile is reported here instead of failing a phase mid-run. Findings carry the contract's own refusal reason (catalog-invalid, unknown-profile, unsupported-value, invalid-override, ...). A catalog provider that no runtime adapter serves is a warning, not an error. Exits non-zero when any error-severity finding is reported. Read-only.",
    options: [
      { flag: "--file <path>", description: "Validate this candidate catalog file instead of the configured one, merged over the built-in catalog exactly as the loader would merge it (optional)." },
      { flag: "--probe", description: "Also run each provider's declared version probe against the binary that resolved, and report available | unavailable | indeterminate. Informational only: capability discovery never invalidates a profile and never feeds the catalog (§11.3). Off by default, because it spawns each provider CLI." },
      { flag: "--session-id <id>", description: "Validate against this session's `agentRuntime` selection: its catalog path, its default quality, and its per-agent profile pins (optional)." },
      { flag: "--session-ref <ref>", description: "Short session reference (sessionId, sessionNo, or alias) resolved to the canonical sessionId. Mutually exclusive with --session-id." },
      { flag: "--sessions-path <path>", description: "Path to sessions.json, which also fixes the default catalog location and resolves --session-ref (optional)." },
    ],
  },
  {
    name: "agent-profile refresh",
    description:
      "Compare the configured agent-profiles.json overlay against this release's recommended (built-in) catalog and the installed provider CLIs, and propose the safe cleanup (issue #914, docs/agent-runtime-profiles-contract.md §11.6). Detects removed/no-longer-recommended models, effort tiers the release does not declare, overrides identical to the recommendation (redundant), and overrides shadowing a different recommendation (stale). Uses a provider's bounded non-interactive model listing when one exists (today: the Antigravity CLI's `models` subcommand) and falls back to the bundled recommended catalog otherwise, reporting the source either way; it never assumes the newest model is the preferred choice and never proposes a discovered name as a value. Previews by default; --yes applies. Applying removes ONLY tool-managed values — overrides identical to the recommendation, whose removal provably changes no resolved setting (the current and proposed effective catalogs must produce the same digest) — records the refresh provenance (timestamp, comparison source, recommended catalog version) in the file, and backs the previous file up beside it first. Operator-created profiles, custom bindings, and any value that differs from the recommendation are preserved and reported as findings; there is no force/replace mode. With no catalog file present nothing is written and the built-in defaults continue to apply. Rollback: restore the printed backup over the catalog path.",
    options: [
      { flag: "--yes", description: "Actually apply the previewed changes (without it, the command only previews). Writes a timestamped backup of the previous file before replacing it." },
      { flag: "--offline", description: "Skip every provider CLI probe (version and model listing); the bundled recommended catalog is the only comparison source, and the output says so. For hosts without the CLIs installed or without network access." },
      { flag: "--session-id <id>", description: "Read `session.agentRuntime.profilesPath` from this session when resolving which catalog file applies (optional)." },
      { flag: "--session-ref <ref>", description: "Short session reference (sessionId, sessionNo, or alias) resolved to the canonical sessionId. Mutually exclusive with --session-id." },
      { flag: "--sessions-path <path>", description: "Path to sessions.json, which also fixes the default catalog location (agent-profiles.json beside it) and resolves --session-ref (optional)." },
    ],
  },
  {
    name: "chain list",
    description:
      "List dependency chains from the registry (issue #789/#788): stable chain ID, session, head Issue, graph revision, accepted revision, and synchronization status for each. Read-only. Optionally scoped to a session and/or a synchronization status.",
    options: [
      { flag: "--session-id <id>", description: "Restrict to one session's chains (optional; omit to list every session's)." },
      { flag: "--session-ref <ref>", description: "Short session reference (sessionId, sessionNo, or alias) resolved to the canonical sessionId. Mutually exclusive with --session-id." },
      { flag: "--sync-status <status>", description: "Restrict to chains with this synchronization status: unknown | in_sync | stale | error (optional)." },
      { flag: "--sessions-path <path>", description: "Path to sessions.json, used to resolve --session-ref (optional)." },
      { flag: "--db-path <path>", description: "Path to SQLite database (optional)." },
    ],
  },
  {
    name: "chain show",
    description:
      "Show one chain's full registered state (issue #789/#788/#891): members with roles, edges, graph revision and fingerprint, accepted revision, aliases, every frozen dependency-prefix snapshot recorded against it, and last synchronization/error metadata. Read-only. Resolves <chain-ref> by stable chain ID or alias — the two share one namespace.",
    options: [
      { flag: "<chain-ref>", description: "Chain ID or alias to show (required positional argument)." },
      { flag: "--sessions-path <path>", description: "Path to sessions.json (accepted for parser parity with chain validate; unused by chain show)." },
      { flag: "--db-path <path>", description: "Path to SQLite database (optional)." },
    ],
  },
  {
    name: "chain validate",
    description:
      "Validate one chain against live GitHub Issue Relationships (issue #789/#890/#891) without mutating either system. Fetches `blocked by` relationships for every registered member via the owning session's work-item provider, builds the observed dependency graph, and reports: structural problems in the observed graph (cycles, missing members, ambiguous identity — #890's rules), drift between the observed graph and the graph currently on record, whether the registry's accepted revision is current, and frozen dependency-prefix conflicts (#891) evaluated against both the recorded graph and the observed one. Per-member provider fetch failures (an inaccessible or deleted Issue, a transient error) are reported separately from structural findings. Read-only: never updates the accepted graph, a revision, a fingerprint, a sync timestamp, or anything on GitHub.",
    options: [
      { flag: "<chain-ref>", description: "Chain ID or alias to validate (required positional argument)." },
      { flag: "--sessions-path <path>", description: "Path to sessions.json, used to load the owning session's work-item provider configuration (optional)." },
      { flag: "--db-path <path>", description: "Path to SQLite database (optional)." },
    ],
  },
  {
    name: "chain sync",
    description:
      "Import valid GitHub Issue Relationship changes into the chain registry (issue #892). Fetches `blocked by` relationships for every registered member of the chain, builds the observed graph the same way `chain validate` does, and — if that graph passes #890's rules and does not contradict any frozen dependency prefix (#891) — makes it the chain's accepted graph, advancing the graph, its revision, its fingerprint, and the accepted-revision pointer as one atomic step, then recording `in_sync` sync metadata. Previews by default; pass --yes to apply. An import problem (a cycle, an inaccessible member, an ambiguous identity, a frozen-prefix conflict, a chain that moved mid-run) is refused with the expected and observed edges and a remediation direction, exits nonzero, and leaves the previously accepted graph exactly as it was. Transient provider failures are reported separately from structural graph failures. One-way: never writes a GitHub comment, label, or relationship. With --all, every chain is checked independently and every failure is reported.",
    options: [
      { flag: "<chain-ref>", description: "Chain ID or alias to synchronize (required unless --all is given)." },
      { flag: "--all", description: "Synchronize every chain instead of one. Mutually exclusive with <chain-ref>." },
      { flag: "--session-id <id>", description: "With --all, restrict to one session's chains (optional)." },
      { flag: "--session-ref <ref>", description: "Short session reference (sessionId, sessionNo, or alias) resolved to the canonical sessionId. With --all only; mutually exclusive with --session-id." },
      { flag: "--yes", description: "Actually import (without it, the command only previews what it would import)." },
      { flag: "--sessions-path <path>", description: "Path to sessions.json, used to load each owning session's work-item provider configuration (optional)." },
      { flag: "--db-path <path>", description: "Path to SQLite database (optional)." },
    ],
  },
  {
    name: "chain new",
    description:
      "Create a dependency chain from Issues that are not yet registered (issue #791). `<issue[,issue...]>` is read in dependency order: `admin chain new 10,11,12` means #10 blocks #11 blocks #12, and #12 — the downstream end — becomes the chain's head, which is also the Issue the stable chain ID is derived from. The optional [name] is registered as an operator alias for the chain (aliases share one namespace with chain IDs, so a name a chain or alias already occupies is refused before anything is created) and recorded as its title; the alias is taken by the same registry transaction that allocates the chain ID, so the chain is created with its name or not created at all. The command writes both sides: it creates the `blocked by` GitHub Issue Relationships and registers the verified graph as the chain's accepted revision. Previews by default; pass --yes to apply. An apply suspends the execution labels of every affected Issue before the first relationship write, re-checks the frozen dependency prefixes (#891) with automation quiesced, applies the relationships idempotently, reads GitHub back and verifies it holds exactly the planned graph, updates the registry only from that verified read, and restores the labels only after all of it succeeded. Any failure leaves automation suspended, never repairs GitHub from the registry, and reports the concrete recovery steps.",
    options: [
      { flag: "<issue[,issue...]>", description: "Issue numbers in dependency order (required positional argument)." },
      { flag: "[name]", description: "Optional operator alias for the new chain (letters, digits, '.', '_', '-'; max 64 characters)." },
      { flag: "--session-id <id>", description: "Canonical session ID (required unless --session-ref is given)." },
      { flag: "--session-ref <ref>", description: "Short session reference (sessionId, sessionNo, or alias) resolved to the canonical sessionId. Mutually exclusive with --session-id." },
      { flag: "--yes", description: "Actually create the relationships and the chain (without it, the command only previews)." },
      { flag: "--sessions-path <path>", description: "Path to sessions.json, used to load the session's work-item provider configuration (optional)." },
      { flag: "--db-path <path>", description: "Path to SQLite database (optional)." },
    ],
  },
  {
    name: "chain append",
    description:
      "Extend a chain past its head (issue #791): `admin chain append chain_777 13,14` makes the chain's head block #13, #13 block #14, and #14 the chain's new head. Accepts Issues that are not registered anywhere; an Issue that already belongs to another chain is refused with a pointer to the advanced merge operation (issue #893), and so is an Issue already in this chain (a reorder) or a head that already blocks something (an insert into the middle of a dependency path). Appending is downstream-only, so it stays valid after an upstream Issue has started and its dependency prefix has been frozen. Two preconditions keep the edit from repairing GitHub out of local state: the chain's persisted graph must be the revision #890 has accepted (an unaccepted candidate is refused with a pointer at `chain validate`/`chain sync`), and every relationship the chain already records must be one GitHub actually holds — only the edges this command introduces are ever written. Same mutation sequence, preview/--yes convention, and failure posture as `chain new`.",
    options: [
      { flag: "<chain-ref>", description: "Chain ID or alias to extend (required positional argument)." },
      { flag: "<issue[,issue...]>", description: "Issue numbers in dependency order, appended after the current head (required positional argument)." },
      { flag: "--session-id <id>", description: "Assert which session owns the chain; the command refuses a chain owned by a different one (optional — the chain-ref already resolves the session)." },
      { flag: "--session-ref <ref>", description: "Short session reference resolved to the canonical sessionId, asserted the same way. Mutually exclusive with --session-id." },
      { flag: "--yes", description: "Actually apply the relationships and the registry update (without it, the command only previews)." },
      { flag: "--sessions-path <path>", description: "Path to sessions.json, used to load the owning session's work-item provider configuration (optional)." },
      { flag: "--db-path <path>", description: "Path to SQLite database (optional)." },
    ],
  },
  {
    name: "chain prepend",
    description:
      "Extend a chain ahead of its root (issue #791): `admin chain prepend chain_777 8,9` makes #8 block #9 and #9 block the Issue the chain currently starts with, leaving the head where it is. Requires the chain to have exactly one root — a fan-in has no single place to prepend, and picking one would silently make the new Issues an ancestor of only part of the chain (issue #893 owns those topologies). Because prepending rewrites the ancestry of everything below the root, it is refused outright once any Issue in the chain has started and frozen its dependency prefix (#891). Same preconditions (accepted graph current, recorded relationships actually present on GitHub), mutation sequence, preview/--yes convention, and failure posture as `chain append`.",
    options: [
      { flag: "<chain-ref>", description: "Chain ID or alias to extend (required positional argument)." },
      { flag: "<issue[,issue...]>", description: "Issue numbers in dependency order, prepended ahead of the chain's root (required positional argument)." },
      { flag: "--session-id <id>", description: "Assert which session owns the chain; the command refuses a chain owned by a different one (optional — the chain-ref already resolves the session)." },
      { flag: "--session-ref <ref>", description: "Short session reference resolved to the canonical sessionId, asserted the same way. Mutually exclusive with --session-id." },
      { flag: "--yes", description: "Actually apply the relationships and the registry update (without it, the command only previews)." },
      { flag: "--sessions-path <path>", description: "Path to sessions.json, used to load the owning session's work-item provider configuration (optional)." },
      { flag: "--db-path <path>", description: "Path to SQLite database (optional)." },
    ],
  },
  {
    name: "chain fork",
    description:
      "Extract a contiguous segment of a chain into a chain of its own (issue #893): `admin chain fork chain_777 13 2` extracts #13 and the member it blocks into a new chain, removes the boundary relationships that attached the segment, and bridges every predecessor of the segment's first member to every successor of its last so the ordering constraints among the remaining members survive. Omit [length] to fork from <issue> through the chain's downstream end. With length 1 and no --name, the Issue is simply detached and receives no new chain identity; pass --name (or a length above 1) to register the segment as a chain, optionally aliased. The segment must be contiguous — a fan-in or fan-out strictly inside it is refused by name, while one at its boundary survives the extraction — and unfrozen: a started Issue's pinned dependency prefix (#891) can be neither extracted nor rewritten, so the segment must sit wholly downstream of every started Issue. Both operand graphs must be the accepted revision, and GitHub must agree with the registry before anything is touched. Same mutation sequence as the linear commands (issue #791): previews by default, applies with --yes, suspends execution labels before the first relationship write, applies additions before removals so a partial state never severs an ordering constraint, reads GitHub back and verifies the exact post-state, updates the registry only from that verified read (the shrunk chain first, then the new segment chain), and restores labels last. Any failure leaves automation suspended and reports concrete recovery steps; a fork interrupted after the chain was shrunk is finished with `admin chain new <segment-issues>`, which adopts the relationships already in place.",
    options: [
      { flag: "<chain-ref>", description: "Chain ID or alias to fork (required positional argument)." },
      { flag: "<issue>", description: "First member of the segment to extract (required positional argument)." },
      { flag: "[length]", description: "How many consecutive members the segment holds (optional; omit to fork through the chain's end)." },
      { flag: "--name <alias>", description: "Register the extracted segment as a chain carrying this operator alias; with length 1 this is also what requests a chain identity at all (optional)." },
      { flag: "--session-id <id>", description: "Assert which session owns the chain; the command refuses a chain owned by a different one (optional — the chain-ref already resolves the session)." },
      { flag: "--session-ref <ref>", description: "Short session reference resolved to the canonical sessionId, asserted the same way. Mutually exclusive with --session-id." },
      { flag: "--yes", description: "Actually apply the relationship changes and the registry updates (without it, the command only previews)." },
      { flag: "--sessions-path <path>", description: "Path to sessions.json, used to load the owning session's work-item provider configuration (optional)." },
      { flag: "--db-path <path>", description: "Path to SQLite database (optional)." },
    ],
  },
  {
    name: "chain merge",
    description:
      "Merge one chain into another and retire the source (issue #893): `admin chain merge chain_777 chain_555 --position append` draws one relationship from chain_777's head to chain_555's root (with --position prepend, from chain_555's head to chain_777's root), makes every member of the source a member of the target, and retires the source in one registry transaction — the target keeps its chain ID, and the source's ID and every alias it carried become aliases of the target, so every handle an operator has written down stays resolvable, deterministically. Its frozen-prefix snapshots are re-recorded against the target. Append moves the target's head to the source's head; prepend leaves it in place. The attachment ends must be real: append requires the target's head to be a genuine downstream end (checked against GitHub as well as the registry) and the source to have exactly one root; prepend requires the reverse. Frozen prefixes (#891) rule out whichever direction would rewrite a started Issue's ancestry: a frozen source refuses append, a frozen target refuses prepend, and a frozen source survives prepend untouched. Both chains must belong to one session and hold their accepted revisions. Same mutation sequence, preview/--yes convention, and failure posture as `chain fork`; a merge interrupted after the target accepted the combined graph is finished by re-running the same command, which detects the merged state and performs only the retirement.",
    options: [
      { flag: "<target-chain>", description: "Chain ID or alias of the surviving chain — its ID is preserved (required positional argument)." },
      { flag: "<source-chain>", description: "Chain ID or alias of the chain to merge in and retire (required positional argument)." },
      { flag: "--position append|prepend", description: "Where the source attaches: append past the target's head, or prepend ahead of its root (required)." },
      { flag: "--session-id <id>", description: "Assert which session owns the chains; the command refuses chains owned by a different one (optional — the chain refs already resolve the session)." },
      { flag: "--session-ref <ref>", description: "Short session reference resolved to the canonical sessionId, asserted the same way. Mutually exclusive with --session-id." },
      { flag: "--yes", description: "Actually apply the relationship, the registry update, and the retirement (without it, the command only previews)." },
      { flag: "--sessions-path <path>", description: "Path to sessions.json, used to load the owning session's work-item provider configuration (optional)." },
      { flag: "--db-path <path>", description: "Path to SQLite database (optional)." },
    ],
  },
  {
    name: "task-assign",
    description: "Reassign an existing task to a different assignment profile or explicit agent pairing. Refuses to modify claimed or running tasks.",
    options: [
      { flag: "--session-id <id>", description: "Session ID (required)." },
      { flag: "--issue-number <n>", description: "Issue number of the task to reassign (required)." },
      { flag: "--profile <name>", description: "Named assignment profile from session config (optional)." },
      { flag: "--implementation-agent <agent>", description: "Override implementation agent: claude | codex | gemini (optional)." },
      { flag: "--review-agent <agent>", description: "Override review agent: claude | codex | gemini (optional)." },
      { flag: "--research-agent <agent>", description: "Override research agent: claude | codex | gemini (optional)." },
      { flag: "--sessions-path <path>", description: "Path to sessions.json (optional)." },
      { flag: "--db-path <path>", description: "Path to SQLite database (optional)." },
      { flag: "--dry-run", description: "Preview the new assignment without persisting changes." },
    ],
  },
  {
    name: "human-review-return",
    description:
      "Return a human-reviewed task to implementation fix mode by storing operator-provided review feedback in the task context and requeuing it. Use when GitHub App automation is unavailable. Treats all forwarded GitHub text as untrusted input: feedback is bounded and sanitized before storage.",
    options: [
      { flag: "--session-id <id>", description: "Session ID to resolve repo and labels (required)." },
      { flag: "--issue-number <n>", description: "Issue number whose task to return to fix mode (required)." },
      { flag: "--feedback <text>", description: "Operator-supplied feedback text. Mutually exclusive with the other feedback sources." },
      { flag: "--feedback-file <path>", description: "Read feedback text from a local file. Mutually exclusive with the other feedback sources." },
      { flag: "--feedback-source <source>", description: "Derive feedback from a GitHub source. Only 'issue-comment' (latest human issue comment) is supported. Mutually exclusive with --feedback/--feedback-file." },
      { flag: "--sessions-path <path>", description: "Path to sessions.json (optional)." },
      { flag: "--db-path <path>", description: "Path to SQLite database (optional)." },
      { flag: "--dry-run", description: "Preview the resolved feedback and target without writing to the database or outbox." },
    ],
  },
  {
    name: "github-app-review-return",
    description:
      "Automatically detect a human CHANGES_REQUESTED review on a task's PR and return the task to implementation fix mode. Only enabled for sessions whose repo-host provider uses GitHub App (identity-separated) auth. Ignores the automation's own (bot) reviews/comments. Review text is untrusted: feedback is bounded and sanitized before storage and is never echoed back to the PR.",
    options: [
      { flag: "--session-id <id>", description: "Session ID to resolve repo and labels (required)." },
      { flag: "--issue-number <n>", description: "Issue number whose PR to inspect (required)." },
      { flag: "--sessions-path <path>", description: "Path to sessions.json (optional)." },
      { flag: "--db-path <path>", description: "Path to SQLite database (optional)." },
      { flag: "--dry-run", description: "Preview the detected review and target without writing to the database or outbox." },
    ],
  },
  {
    name: "review-verification resolve",
    description:
      "Record an operator-supplied manual verification result for a verification command that the automated review runner did not execute. " +
      "If the command exited 0 (success), stores the result as review evidence and requeues the task to review so the same command is not re-reported as missing. " +
      "If the command exited non-zero (failure), routes the task to implementation fix mode with the failure as feedback. " +
      "The command output is bounded and sanitized before storage.",
    options: [
      { flag: "--session-id <id>", description: "Session ID (required)." },
      { flag: "--issue-number <n>", description: "Issue number whose task to update (required)." },
      { flag: "--command <cmd>", description: "The verification command that was run manually (required)." },
      { flag: "--exit-code <n>", description: "Exit code from running the command (required). 0 = success; non-zero routes to implementation fix mode." },
      { flag: "--output <text>", description: "Command output (stdout+stderr). Mutually exclusive with --output-file." },
      { flag: "--output-file <path>", description: "Read command output from a local file. Mutually exclusive with --output." },
      { flag: "--head-sha <sha>", description: "Reviewed branch HEAD the command was run against (full 40/64-hex commit SHA). Required only when the escalation predates evidence binding (issue #1040) and recorded no reviewed HEAD; otherwise the recorded value is authoritative and a differing --head-sha is refused." },
      { flag: "--sessions-path <path>", description: "Path to sessions.json (optional)." },
      { flag: "--db-path <path>", description: "Path to SQLite database (optional)." },
      { flag: "--dry-run", description: "Preview the action without writing to the database or outbox." },
    ],
  },
  {
    name: "review-verification refresh",
    description:
      "Re-read the live Issue and import ONLY its verification section into an existing task as a new task-scoped verification revision (docs/verification-amendment-contract.md §10). " +
      "The intake-time title, goal, body, implementation instructions, and every other task field are left untouched — a refresh never refreshes the task body. " +
      "Previews by default and applies nothing without --yes. Proposed retirements are reported but withheld unless --allow-retire is passed, and a replacement is never proposed: correcting a requirement's bytes in place stays an explicit operator amendment. " +
      "A provider without a work-item body adapter, a missing Issue, a body with no supported verification section, and a diff the §10 matcher cannot map each refuse the whole refresh without writing anything.",
    options: [
      { flag: "--session-id <id>", description: "Session ID (required)." },
      { flag: "--issue-number <n>", description: "Issue number whose task to refresh (required)." },
      { flag: "--reason <text>", description: "Why this refresh is being applied (required, non-empty). Recorded on the revision and on every operation it applies." },
      { flag: "--allow-retire", description: "Also apply the proposed retirements for requirements the live Issue no longer names. Without it they are previewed and withheld." },
      { flag: "--expect-issue-digest <digest>", description: "Refuse unless the live Issue body still hashes to this digest — the concurrent-edit guard between a preview and the apply that follows it." },
      { flag: "--expect-plan-digest <digest>", description: "Refuse unless the task's effective verification plan still hashes to this digest — the concurrent-AMENDMENT guard. A refresh diffs the live Issue against the task's own plan, so a plan another revision moved changes the difference applied even when the Issue body did not." },
      { flag: "--request-key <token>", description: "Stable idempotency handle for this invocation. Omit it to derive one from the invocation's own content; supply a distinct token to ask for a deliberate repeat." },
      { flag: "--yes", description: "Apply the previewed difference. Without it nothing is written." },
      { flag: "--sessions-path <path>", description: "Path to sessions.json (optional)." },
      { flag: "--db-path <path>", description: "Path to SQLite database (optional)." },
    ],
  },
  {
    name: "task-verification show",
    description:
      "Show one task's EFFECTIVE verification plan (docs/verification-amendment-contract.md §6/§11): the ordered execution and requirement slots with their stable command identity, origin (session default, Issue requirement, or task amendment), state (active/retired), the revisions that touched them, each requirement's evidence status, and the plan digest. " +
      "Read-only: it resolves the plan, reports session-default drift, and writes nothing — not even the drift re-anchor, which belongs to the applying commands. " +
      "For a session with stagedVerification enabled, or a task that retains stage state, it also shows the stage view (docs/staged-verification-operations.md): progress (review approved vs pending final verification vs completed final evidence), the last loop and final bundles with selected/required checks, verdicts and durations, evidence invalidation reasons, the regression set with pin reasons, and the recovery counters. " +
      "A stored plan digest that reconciles against neither the live inputs nor the recorded session baseline is refused rather than shown, and never repaired.",
    options: [
      { flag: "--session-id <id>", description: "Session ID (required)." },
      { flag: "--issue-number <n>", description: "Issue number whose task to show (required)." },
      { flag: "--sessions-path <path>", description: "Path to sessions.json (optional)." },
      { flag: "--db-path <path>", description: "Path to SQLite database (optional)." },
    ],
  },
  {
    name: "task-verification amend",
    description:
      "Amend one task's verification plan as a single append-only revision (docs/verification-amendment-contract.md §5/§11): add, replace, retire, restore, or annotate a command, with a mandatory operator-authored reason. " +
      "Previews by default and applies nothing without --yes; a preview and an apply both report the old and new plan digests and the resulting plan. " +
      "Operations compose in the order they are typed and the whole revision is refused if any one of them is invalid — nothing partial is ever applied. " +
      "Claimed/running tasks, terminal tasks, a stale plan, and a #915 pinned entry each refuse without writing anything. Editing sessions.json, the task row, or SQLite by hand is not the supported flow and is detected: a hand-edited chain that neither the live inputs nor the recorded session baseline explains fails closed.",
    options: [
      { flag: "--session-id <id>", description: "Session ID (required)." },
      { flag: "--issue-number <n>", description: "Issue number whose task to amend (required)." },
      { flag: "--reason <text>", description: "Why this revision is being made (required, non-empty). Recorded on the revision and on every operation that carries no --op-reason of its own." },
      { flag: "--replace <commandId>", description: "Replace the bytes of an existing slot, keeping its identity and position. Requires a following --command. Repeatable." },
      { flag: "--add-execution <name>", description: "Add a task-local execution-layer command under this name. Requires a following --command. Repeatable." },
      { flag: "--add-requirement", description: "Add a task-local requirement-layer command. Requires a following --command. Repeatable." },
      { flag: "--retire <commandId>", description: "Retire a slot: it stops being executed and is reported `retired`, which is never a passing result. Never deleted; reversible with --restore. Repeatable." },
      { flag: "--restore <commandId>", description: "Return a retired slot to active at its original position with its original bytes. Repeatable." },
      { flag: "--annotate <commandId>", description: "Record a reason against a slot without changing its bytes, state, or position. Repeatable." },
      { flag: "--command <bytes>", description: "The command bytes for the operation flag it follows (--replace / --add-execution / --add-requirement). Stored, digested, and executed verbatim apart from end trimming." },
      { flag: "--op-reason <text>", description: "Operation-level reason, binding to the operation flag it follows and overriding --reason for that operation alone. Repeatable; a leading, doubled, or empty one is refused." },
      { flag: "--continue <mode>", description: "review | implementation | none. The route an applied revision takes; omitted, the §9.2 default applies — review for a review-lane park (ready_for_human/blocked + review), none everywhere else. review/implementation re-queue the task {queued, <mode>} in the same transaction that persists the amended plan, clearing the stale missing-command state; none records the revision and routes nothing. Rejected when the task's row parks the task outside review (no continuation unparks one)." },
      { flag: "--expect-plan-digest <digest>", description: "Refuse unless the effective plan still hashes to this digest — the concurrent-amendment guard between a preview and the apply that follows it." },
      { flag: "--request-key <token>", description: "Stable idempotency handle for this invocation. Omit it to derive one from the invocation's own content; supply a distinct token to ask for a deliberate repeat of the same operations." },
      { flag: "--yes", description: "Apply the previewed revision. Without it nothing is written." },
      { flag: "--sessions-path <path>", description: "Path to sessions.json (optional)." },
      { flag: "--db-path <path>", description: "Path to SQLite database (optional)." },
    ],
  },
  {
    name: "task-verification refresh-from-issue",
    description:
      "Re-read the live Issue and import ONLY its verification section into an existing task as a new task-scoped verification revision (docs/verification-amendment-contract.md §10). The resource-oriented spelling of `review-verification refresh`: same flags, same outcomes, same exit codes. " +
      "The intake-time title, goal, body, implementation instructions, and every other task field are left untouched. " +
      "Previews by default and applies nothing without --yes. Proposed retirements are reported but withheld unless --allow-retire is passed, and a replacement is never proposed: correcting a requirement's bytes in place stays an explicit `task-verification amend`.",
    options: [
      { flag: "--session-id <id>", description: "Session ID (required)." },
      { flag: "--issue-number <n>", description: "Issue number whose task to refresh (required)." },
      { flag: "--reason <text>", description: "Why this refresh is being applied (required, non-empty). Recorded on the revision and on every operation it applies." },
      { flag: "--allow-retire", description: "Also apply the proposed retirements for requirements the live Issue no longer names. Without it they are previewed and withheld." },
      { flag: "--expect-issue-digest <digest>", description: "Refuse unless the live Issue body still hashes to this digest — the concurrent-edit guard between a preview and the apply that follows it." },
      { flag: "--expect-plan-digest <digest>", description: "Refuse unless the task's effective verification plan still hashes to this digest — the concurrent-AMENDMENT guard. A refresh diffs the live Issue against the task's own plan, so a plan another revision moved changes the difference applied even when the Issue body did not." },
      { flag: "--request-key <token>", description: "Stable idempotency handle for this invocation. Omit it to derive one from the invocation's own content; supply a distinct token to ask for a deliberate repeat." },
      { flag: "--yes", description: "Apply the previewed difference. Without it nothing is written." },
      { flag: "--sessions-path <path>", description: "Path to sessions.json (optional)." },
      { flag: "--db-path <path>", description: "Path to SQLite database (optional)." },
    ],
  },
  {
    name: "task-verification reset",
    description:
      "Return one task's verification plan to its unamended baseline — the session defaults plus the Issue-derived requirements — as one ordinary append-only revision (docs/verification-amendment-contract.md §5.3 rule 6). " +
      "Retired slots are restored, replaced slots are reverted to the bytes they entered the plan with, and task-local additions are retired. Nothing is deleted and no recorded revision is rewritten: a reset is a reversal, and reversals are revisions. " +
      "Previews by default and applies nothing without --yes. Retiring a task-local addition removes a check the task currently runs, so it is withheld unless --allow-retire is passed. " +
      "A plan that already matches its baseline reports no change, records no revision, and exits zero.",
    options: [
      { flag: "--session-id <id>", description: "Session ID (required)." },
      { flag: "--issue-number <n>", description: "Issue number whose task to reset (required)." },
      { flag: "--reason <text>", description: "Why the amendments are being reverted (required, non-empty). Recorded on the revision and on every operation it applies." },
      { flag: "--allow-retire", description: "Also retire the task-local additions the amendments created. Without it they are previewed and withheld." },
      { flag: "--expect-plan-digest <digest>", description: "Refuse unless the effective plan still hashes to this digest — the concurrent-amendment guard between a preview and the apply that follows it." },
      { flag: "--request-key <token>", description: "Stable idempotency handle for this invocation; the preview names the one to pass back. Supply it so an apply whose response was lost is recognized as a replay of the revision it already recorded — a reset derives its operations from the plan, so a key derived from them cannot survive the reset's own success." },
      { flag: "--yes", description: "Apply the previewed reset. Without it nothing is written." },
      { flag: "--sessions-path <path>", description: "Path to sessions.json (optional)." },
      { flag: "--db-path <path>", description: "Path to SQLite database (optional)." },
    ],
  },
  {
    name: "tool-request list",
    description: "List disallowed-command Tool Requests handed off by implementation agents (issue #291). Defaults to unresolved requests; pass --all to include resolved ones.",
    options: [
      { flag: "--session-id <id>", description: "Canonical session ID to query (required unless --session-ref is given)." },
      { flag: "--session-ref <ref>", description: "Short session reference (sessionId, sessionNo, or alias) resolved to the canonical sessionId. Mutually exclusive with --session-id." },
      { flag: "--issue-number <n>", description: "Filter to a specific issue number (optional)." },
      { flag: "--all", description: "Include already-resolved Tool Requests (default: unresolved only)." },
      { flag: "--sessions-path <path>", description: "Path to sessions.json, used to resolve --session-ref (optional)." },
      { flag: "--db-path <path>", description: "Path to SQLite database (optional)." },
    ],
  },
  {
    name: "tool-request resolve",
    description: "Resolve a Tool Request handoff. 'manual-done' signals that the operator has already run the requested command externally and committed/pushed the side effects ON THE ISSUE BRANCH (the open PR head branch, or ai/issue-<n>) — never on the base branch. It does NOT approve the command for future automated runs — if the agent re-requests the same command on the next run, the repository state still appears unchanged. Refused if the session checkout is dirty (first commit and push the changes the requested command produced to the issue branch, or use 'reject' if they should not land; do not stash them, as the requeued run would not see them) or if the local base branch is ahead of origin (move those commits to the issue branch or drop them — do not push the base branch). Also refused when no usable continuation point exists (issue #379): if the issue branch is absent both locally and on origin and there is no PR to resume, requeueing would branch a fresh run from the base with none of the prior work and loop on the same request — land the change on the issue branch first (the failed run's artifact dir preserves a 'partial-implementation.patch' you can reapply), then re-run this resolve, or use 'reject'. 'reject' records the decision and leaves the task as a human handoff. Never runs the requested command. A plain 'reject' does not consume the recovery: 'manual-done' may still be run afterward (e.g. to resume a pre-PR implementation whose Tool Request was rejected) as long as the same preconditions above are met.",
    options: [
      { flag: "--session-id <id>", description: "Canonical session ID (required unless --session-ref is given)." },
      { flag: "--session-ref <ref>", description: "Short session reference (sessionId, sessionNo, or alias) resolved to the canonical sessionId. Mutually exclusive with --session-id." },
      { flag: "--issue-number <n>", description: "Issue number of the Tool Request to resolve (required)." },
      { flag: "--action <action>", description: "Resolution action: manual-done | reject (required)." },
      { flag: "--message <text>", description: "Operator note. Required for --action reject; optional for manual-done." },
      { flag: "--sessions-path <path>", description: "Path to sessions.json (optional)." },
      { flag: "--db-path <path>", description: "Path to SQLite database (optional)." },
      { flag: "--dry-run", description: "Preview the resolution without writing to the database or outbox." },
    ],
  },
  {
    name: "tool-request run",
    description:
      "Guided run of a Tool Request handoff (issue #430): the orchestrator runs the exact approved command on your behalf — OUTSIDE the agent's tool surface — in the low-impact execution environment, captures the result, and takes an explicit disposition for any changes it produced. This is the redesigned successor to 'tool-request grant'. The authorization remains tightly scoped (session + issue + phase + repo root + exact normalized command hash), one-shot, and short-lived. The exact command must match the requested command (exact-command only). A clean worktree is required before execution. The command runs on the ISSUE BRANCH (the open PR head branch, or ai/issue-<n> created from the base when no PR exists yet) — never on the base branch (issue #316). A no-op verification command (exit 0, no changes) re-queues with its captured output folded into the next implementation prompt as continuation context, so a verification-only request gets the answer instead of looping. When the command produces changes the disposition decides what happens: --disposition commit (the orchestrator commits + pushes on the issue branch and re-queues), --disposition discard (the changes are reverted; a snapshot patch is kept), or --disposition keep (left on the issue branch for you to handle by hand). A non-zero exit stays a human handoff (it does not loop). stdout/stderr/exit code are captured in local artifacts; public comments show only the redacted command and the high-level outcome.",
    options: [
      { flag: "--session-id <id>", description: "Canonical session ID (required unless --session-ref is given)." },
      { flag: "--session-ref <ref>", description: "Short session reference (sessionId, sessionNo, or alias) resolved to the canonical sessionId. Mutually exclusive with --session-id." },
      { flag: "--issue-number <n>", description: "Issue number of the Tool Request to run (required)." },
      { flag: "--command <cmd>", description: "Exact command to run. Must equal the requested command (optional; defaults to the stored requested command)." },
      { flag: "--disposition <kind>", description: "What to do with changes the command produces: commit | discard | keep (optional; default keep)." },
      { flag: "--ttl-seconds <n>", description: `Authorization time-to-live in seconds (optional; default ${Math.round(GRANT_DEFAULT_TTL_MS / 1000)}).` },
      { flag: "--max-uses <n>", description: `Maximum executions the authorization permits (optional; default ${GRANT_DEFAULT_MAX_USES}).` },
      { flag: "--sessions-path <path>", description: "Path to sessions.json (optional)." },
      { flag: "--db-path <path>", description: "Path to SQLite database (optional)." },
      { flag: "--lock-dir <path>", description: "Directory holding the per-session repo lock (optional; the lock is taken around preflight + execution)." },
      { flag: "--dry-run", description: "Preview the guided run (scope, redacted command, expiry, disposition) without executing or writing anything." },
    ],
  },
  {
    name: "tool-request grant",
    description:
      "DEPRECATED alias for 'tool-request run' (issue #430 retired 'grant' from the operator surface in favor of the guided run). Grant the orchestrator permission to run ONE exact, approved command for a Tool Request handoff, then execute it (issue #301). Unlike 'manual-done' (which assumes you already ran the command), a grant has the orchestrator run the command on your behalf — OUTSIDE the agent's tool surface. The grant is tightly scoped (session + issue + phase + repo root + exact normalized command hash), one-shot, and short-lived, so it can never become a standing/wildcard approval. The exact command must match the requested command (exact-command only). A clean worktree is required before execution. The command runs on the ISSUE BRANCH (the open PR head branch, or ai/issue-<n> created from the base when no PR exists yet) — never on the base branch (issue #316). On a clean no-op success the request is resolved and the task is re-queued; if the command produced changes they are left on the issue branch for the operator to commit/push THERE (never the base branch) then 'resolve --action manual-done' — or use 'tool-request run --disposition commit' to have the orchestrator do that plumbing; on a non-zero exit the task stays a human handoff (it does not loop). The command's stdout/stderr/exit code are captured in local artifacts; public comments show only the redacted command and the high-level outcome.",
    options: [
      { flag: "--session-id <id>", description: "Canonical session ID (required unless --session-ref is given)." },
      { flag: "--session-ref <ref>", description: "Short session reference (sessionId, sessionNo, or alias) resolved to the canonical sessionId. Mutually exclusive with --session-id." },
      { flag: "--issue-number <n>", description: "Issue number of the Tool Request to grant (required)." },
      { flag: "--command <cmd>", description: "Exact command to grant. Must equal the requested command (optional; defaults to the stored requested command)." },
      { flag: "--disposition <kind>", description: "What to do with changes the command produces: commit | discard | keep (optional; default keep)." },
      { flag: "--ttl-seconds <n>", description: `Grant time-to-live in seconds (optional; default ${Math.round(GRANT_DEFAULT_TTL_MS / 1000)}).` },
      { flag: "--max-uses <n>", description: `Maximum executions the grant authorizes (optional; default ${GRANT_DEFAULT_MAX_USES}).` },
      { flag: "--sessions-path <path>", description: "Path to sessions.json (optional)." },
      { flag: "--db-path <path>", description: "Path to SQLite database (optional)." },
      { flag: "--lock-dir <path>", description: "Directory holding the per-session repo lock (optional; the lock is taken around preflight + execution)." },
      { flag: "--on-changes <action>", description: "Guided handling for changes the command leaves in the working tree (issue #419): commit (stage the expected files, commit to the issue branch, and push) | keep (leave the changes for the operator) | discard (drop the changes; requires --confirm-discard) | reject (close the Tool Request, leaving changes in place) | abort (do nothing). Optional; omitting it preserves the legacy behavior of leaving changes for a manual commit/push. Changed files are compared against the request's expected files and unexpected files are surfaced before any commit." },
      { flag: "--confirm-discard", description: "Required to proceed with --on-changes discard (the discard is destructive)." },
      { flag: "--allow-unexpected", description: "Allow --on-changes commit to include changed files outside the request's expected files (refused without it)." },
      { flag: "--dry-run", description: "Preview the grant (scope, redacted command, expiry) without executing or writing anything." },
    ],
  },
  {
    name: "context create",
    description: "Create a context record and emit its contextId as JSON. Stores the canonical sessionId resolved from --session-id or --session-ref.",
    options: [
      { flag: "--execution-id <id>", description: "Execution ID to use as contextId (required)." },
      { flag: "--session-id <id>", description: "Canonical session ID to associate with the context record (required unless --session-ref is given)." },
      { flag: "--session-ref <ref>", description: "Short session reference (sessionId, sessionNo, or alias) resolved to the canonical sessionId before storing. Mutually exclusive with --session-id." },
      { flag: "--sessions-path <path>", description: "Path to sessions.json, used to resolve --session-ref (optional)." },
      { flag: "--db-path <path>", description: "Path to SQLite database (optional)." },
    ],
  },
  {
    name: "session pause",
    description:
      "Pause a session (issue #531): run-one-phase claims and executes NO new work for it until resumed. Pause state lives in the runner-owned SQLite store — no GitHub label is involved. Running phases are not force-stopped; they finish and the session stays quiet afterwards. Task-level recover/cancel flows remain available while paused. Repeating the command updates the stored reason. Resume with 'session resume'.",
    options: [
      { flag: "--session-id <id>", description: "Canonical session ID to pause (required unless --session-ref is given)." },
      { flag: "--session-ref <ref>", description: "Short session reference resolved to the canonical sessionId. Mutually exclusive with --session-id." },
      { flag: "--reason <text>", description: "Why the session is paused; shown by 'session status' and in the paused run-one-phase outcome (optional)." },
      { flag: "--sessions-path <path>", description: "Path to sessions.json (optional; also used to resolve --session-ref)." },
      { flag: "--db-path <path>", description: "Path to SQLite database (optional)." },
    ],
  },
  {
    name: "session resume",
    description:
      "Resume a paused session (issue #531) so run-one-phase claims work again. Clears the stored pause (operator- or circuit-breaker-initiated). A session that is not paused is a safe no-op. Resuming does not reset the run ledger; if the failing condition persists, the circuit breaker can pause the session again on the next failed run.",
    options: [
      { flag: "--session-id <id>", description: "Canonical session ID to resume (required unless --session-ref is given)." },
      { flag: "--session-ref <ref>", description: "Short session reference resolved to the canonical sessionId. Mutually exclusive with --session-id." },
      { flag: "--sessions-path <path>", description: "Path to sessions.json (optional; also used to resolve --session-ref)." },
      { flag: "--db-path <path>", description: "Path to SQLite database (optional)." },
    ],
  },
  {
    name: "session status",
    description:
      "Show a session's pause state (with reason/source) and circuit-breaker standing (issue #531): consecutive failed runs, the active thresholds, whether the breaker would pause the session now, and the most recent run-ledger entries (phase, outcome, duration, agent/model and cost metadata when recorded). Read-only. Human-readable by default; --json emits a stable machine payload.",
    options: [
      { flag: "--session-id <id>", description: "Canonical session ID to inspect (required unless --session-ref is given)." },
      { flag: "--session-ref <ref>", description: "Short session reference resolved to the canonical sessionId. Mutually exclusive with --session-id." },
      { flag: "--limit <n>", description: "Recent run-ledger entries to include (default: 10, max: 50)." },
      { flag: "--sessions-path <path>", description: "Path to sessions.json (optional; also used to resolve --session-ref)." },
      { flag: "--db-path <path>", description: "Path to SQLite database (optional)." },
    ],
  },
  {
    name: "session-doctor",
    description:
      "Check repo, GitHub (including required labels), AI CLI, SQLite storage, and worktree state-root health for a configured session.",
    options: [
      { flag: "--session-id <id>", description: "Canonical session ID to check (required unless --session-ref is given)." },
      { flag: "--session-ref <ref>", description: "Short session reference (sessionId, sessionNo, or alias) resolved to the canonical sessionId. Mutually exclusive with --session-id." },
      { flag: "--sessions-path <path>", description: "Path to sessions.json (optional; also used to resolve --session-ref)." },
      { flag: "--db-path <path>", description: "Path to the SQLite database to health-check (optional; defaults to the standard DB path)." },
    ],
  },
  {
    name: "session-audit",
    description:
      "Audit a session's loop design readiness (issue #533): required work-item labels, artifact hygiene, verification commands, handoff notifications, worktree/environment coherence, circuit-breaker kill switch, explicit assignment, and the public/private boundary. Complements session-doctor, which checks the environment rather than the design. Read-only: it never runs a project command and never mutates GitHub or the SQLite store. Each finding is graded error / warning / suggestion with a concrete remedy; a session can record an accepted trade-off in its `audit.acknowledge` block. Human-readable by default; --json emits a stable machine payload.",
    options: [
      { flag: "--session-id <id>", description: "Canonical session ID to audit (required unless --session-ref is given)." },
      { flag: "--session-ref <ref>", description: "Short session reference (sessionId, sessionNo, or alias) resolved to the canonical sessionId. Mutually exclusive with --session-id." },
      { flag: "--sessions-path <path>", description: "Path to sessions.json (optional; also used to resolve --session-ref)." },
      { flag: "--offline", description: "Skip the read-only tracker probes (label list, repository visibility) and report those checks as skipped. Use when auditing from a host without tracker credentials (gh auth, or the session's Gitea API token)." },
    ],
  },
  {
    name: "context-mode status",
    description:
      "Report Codex context-mode readiness for a session: which agents are assigned to implementation/review/research/conflict-resolution, whether each can use context-mode (only Codex can; Claude/Gemini are n/a), the configured codex.contextMode and effective CODEX_CONTEXT_MODE override, the exact Codex argv additions, and whether the setup is enabled, disabled, invalid, or not applicable. Human-readable by default; --json emits a stable machine payload.",
    options: [
      { flag: "--session-id <id>", description: "Canonical session ID to inspect (required unless --session-ref is given)." },
      { flag: "--session-ref <ref>", description: "Short session reference (sessionId, sessionNo, or alias) resolved to the canonical sessionId. Mutually exclusive with --session-id." },
      { flag: "--sessions-path <path>", description: "Path to sessions.json (optional; also used to resolve --session-ref)." },
      { flag: "--probe-cli", description: "Also run a safe, non-billable `codex --version` check to confirm the Codex CLI is installed. Does not verify Codex accepts the configured context-mode form." },
    ],
  },
  {
    name: "repo-lock acquire",
    description: "Acquire a repo-scoped lock for a session. Emits JSON with locked:true on success or locked:false when another context holds the lock.",
    options: [
      { flag: "--context-id <id>", description: "Context ID used to resolve sessionId and as the lock owner (required)." },
      { flag: "--db-path <path>", description: "Path to SQLite database (optional)." },
      { flag: "--lock-dir <path>", description: "Directory for lock files (optional; defaults to ~/.local/state/n8n-ai-cli-loop/locks)." },
    ],
  },
  {
    name: "repo-lock release",
    description: "Release a repo-scoped lock. Only releases if the contextId matches the lock owner.",
    options: [
      { flag: "--context-id <id>", description: "Context ID that owns the lock (required)." },
      { flag: "--db-path <path>", description: "Path to SQLite database (optional)." },
      { flag: "--lock-dir <path>", description: "Directory for lock files (optional; defaults to ~/.local/state/n8n-ai-cli-loop/locks)." },
    ],
  },
  {
    name: "repo-lock status",
    description: "Inspect the current repo-scoped lock state for a session. Prints JSON with lock details.",
    options: [
      { flag: "--session-id <id>", description: "Canonical session ID to inspect (required unless --session-ref is given)." },
      { flag: "--session-ref <ref>", description: "Short session reference (sessionId, sessionNo, or alias) resolved to the canonical sessionId. Mutually exclusive with --session-id." },
      { flag: "--sessions-path <path>", description: "Path to sessions.json, used to resolve --session-ref (optional)." },
      { flag: "--lock-dir <path>", description: "Directory for lock files (optional; defaults to ~/.local/state/n8n-ai-cli-loop/locks)." },
    ],
  },
  {
    name: "repo-lock force-release",
    description: "Force-remove a repo-scoped lock. Requires --yes. If --context-id is supplied, only removes if the lock is owned by that context.",
    options: [
      { flag: "--session-id <id>", description: "Session ID whose lock to release (required)." },
      { flag: "--context-id <id>", description: "If supplied, only release the lock when the owner matches this context ID (optional)." },
      { flag: "--yes", description: "Required confirmation flag; refuses without it." },
      { flag: "--lock-dir <path>", description: "Directory for lock files (optional; defaults to ~/.local/state/n8n-ai-cli-loop/locks)." },
    ],
  },
  {
    name: "worktree list",
    description: "List the git worktrees registered against a session's canonical repo (issue #400). Flags which worktrees are managed per-issue worktrees under the session's worktree state root vs. the canonical checkout. Local-only: worktree paths are printed to the operator and never published.",
    options: [
      { flag: "--session-id <id>", description: "Session ID whose repo to inspect (required)." },
      { flag: "--sessions-path <path>", description: "Path to sessions.json (optional)." },
    ],
  },
  {
    name: "worktree prune",
    description: "Remove a single issue's per-issue git worktree (issue #400). Previews by default; pass --yes to remove. Refuses a dirty/locked worktree unless --force is given. A missing worktree is a safe no-op. Does not delete branches or touch the canonical checkout. With --research it instead removes the issue's leaked per-run research checkouts (issue #855), which a crashed research run can leave behind and no retry can reclaim.",
    options: [
      { flag: "--session-id <id>", description: "Session ID that owns the worktree (required)." },
      { flag: "--issue-number <n>", description: "Issue number whose worktree to prune (required)." },
      { flag: "--yes", description: "Actually remove the worktree (without it, the command only previews)." },
      { flag: "--force", description: "Discard a dirty or locked worktree (git worktree remove --force); with --research, proceed despite a live issue lock." },
      { flag: "--research", description: "Target the issue's leaked per-run research checkouts (issue-<n>/research-<runId>) instead of the durable worktree. Refuses a live issue lock unless --force; removal always forces, since the detached research checkout is disposable." },
      { flag: "--lock-dir <path>", description: "Directory holding per-issue worktree locks (optional; used by --research to skip an issue with a live lock)." },
      { flag: "--sessions-path <path>", description: "Path to sessions.json (optional)." },
    ],
  },
  {
    name: "worktree recovery",
    description:
      "Diagnose drift between task context, branch refs, the per-issue worktree registry, the issue lock, and PR state, and recommend a recovery action for each affected issue (issue #408). Read-only: it inspects state and explains whether to resume, recreate the worktree (from the local branch or remote), clean up a stale branch-only artifact, or skip an issue under active execution. It never deletes branches, removes worktrees, or mutates tasks — follow the printed guidance (e.g. 'recover', 'worktree prune', 'worktree release-lock'). Worktree paths are local-only and never published.",
    options: [
      { flag: "--session-id <id>", description: "Session ID whose drift to diagnose (required)." },
      { flag: "--issue-number <n>", description: "Diagnose a single issue (optional; omit to diagnose every issue with a task or local ai/issue-* branch)." },
      { flag: "--sessions-path <path>", description: "Path to sessions.json (optional)." },
      { flag: "--db-path <path>", description: "Path to SQLite database (optional)." },
      { flag: "--lock-dir <path>", description: "Directory holding per-issue worktree locks (optional; defaults to the managed worktree-locks dir)." },
    ],
  },
  {
    name: "worktree cleanup",
    description:
      "Inspect and bulk-prune stale per-issue worktrees for a session (issue #407). Classifies every managed worktree as active (an in-flight/awaiting-human task or a live issue lock — never pruned), terminal (issue task done), orphaned (no task row), or research-leaked (a per-run research checkout left by a crashed run — a candidate regardless of task status, since no retry can reclaim it, but still never removed under a live issue lock), then prunes the terminal/orphaned/research-leaked ones. Previews by default (changes nothing) so candidates can be reviewed; pass --yes to remove. Refuses to remove a dirty worktree or one whose branch has commits not pushed to origin unless --force is given, and reports every skip with its reason. Never deletes branches or touches the canonical checkout. Worktree paths are local-only and never published. Unknown flags fail fast.",
    options: [
      { flag: "--session-id <id>", description: "Session ID whose worktrees to clean up (required)." },
      { flag: "--yes", description: "Actually remove prune candidates (without it, the command only previews)." },
      { flag: "--force", description: "Also remove candidates that are dirty or have unpushed commits (clearly reported)." },
      { flag: "--lock-dir <path>", description: "Directory holding per-issue worktree locks (optional; used to skip worktrees with a live lock)." },
      { flag: "--sessions-path <path>", description: "Path to sessions.json (optional)." },
      { flag: "--db-path <path>", description: "Path to SQLite database (optional)." },
    ],
  },
  {
    name: "worktree release-lock",
    description:
      "Release a stale per-issue worktree lock left behind by a crashed run (issue #407). Previews by default; pass --yes to release. A missing lock is a safe no-op. A live (non-stale) lock is refused unless --force is given, since releasing it could let two runs touch the same worktree concurrently. Does not touch the worktree itself.",
    options: [
      { flag: "--session-id <id>", description: "Session ID that owns the lock (required)." },
      { flag: "--issue-number <n>", description: "Issue number whose worktree lock to release (required)." },
      { flag: "--yes", description: "Actually release the lock (without it, the command only previews)." },
      { flag: "--force", description: "Release even a live (non-stale) lock (use only when certain no run is active)." },
      { flag: "--lock-dir <path>", description: "Directory holding per-issue worktree locks (optional)." },
    ],
  },
  {
    name: "worktree discard",
    description:
      "Discard dirty changes in a managed per-issue worktree, restoring it to a clean state (issue #570). Previews by default — shows tracked and untracked files that would be reverted or removed; pass --yes to actually restore. Refuses to operate on the canonical checkout or non-managed worktrees. Refuses a live (non-stale) issue lock unless --force is given. Does not delete branches, close PRs, or modify the task row. Human-readable by default; --json emits a stable machine payload.",
    options: [
      { flag: "--session-id <id>", description: "Session ID that owns the worktree (required)." },
      { flag: "--issue-number <n>", description: "Issue number whose worktree to restore to a clean state (required)." },
      { flag: "--yes", description: "Actually restore the worktree (without it, the command only previews)." },
      { flag: "--force", description: "Operate even when the worktree has a live (non-stale) issue lock (use only when certain no run is active)." },
      { flag: "--lock-dir <path>", description: "Directory holding per-issue worktree locks (optional)." },
      { flag: "--sessions-path <path>", description: "Path to sessions.json (optional)." },
    ],
  },
  {
    name: "review-lock status",
    description:
      "Inspect the lock a worktree-enabled review holds for one issue (issue #459). Worktree-safe review (issue #456) serializes on the per-issue worktree lock (scope <session>::issue-<n>) and runs inside that issue's worktree; there is no separate canonical/session-wide review lock, so an orphaned review lock only blocks that one issue's later reviews. Read-only: prints the lock scope, owner, staleness, and lock path. The same lock is reported by 'worktree release-lock' (preview) — this is the review-named view.",
    options: [
      { flag: "--session-id <id>", description: "Session ID that owns the review lock (required)." },
      { flag: "--issue-number <n>", description: "Issue number whose review lock to inspect (required)." },
      { flag: "--lock-dir <path>", description: "Directory holding per-issue worktree locks (optional)." },
    ],
  },
  {
    name: "review-lock release",
    description:
      "Force-release an orphaned worktree-enabled review lock for one issue (issue #459). Recovers a review lock left behind by a crashed run so later reviews for that issue are not blocked until the 24h stale TTL expires. Operates on the SAME per-issue worktree lock as 'worktree release-lock' (which stays the generic recovery path and is unchanged); this is the review-named entry point. Previews by default; pass --yes to release. A missing lock is a safe no-op. A live (non-stale) lock is refused unless --force is given, since releasing it could let two runs touch the same worktree concurrently. Does not touch the worktree itself.",
    options: [
      { flag: "--session-id <id>", description: "Session ID that owns the review lock (required)." },
      { flag: "--issue-number <n>", description: "Issue number whose review lock to release (required)." },
      { flag: "--yes", description: "Actually release the lock (without it, the command only previews)." },
      { flag: "--force", description: "Release even a live (non-stale) lock (use only when certain no run is active)." },
      { flag: "--lock-dir <path>", description: "Directory holding per-issue worktree locks (optional)." },
    ],
  },
  {
    name: "maintenance-lock status",
    description:
      "Inspect the whole-file maintenance lock (issue #817, docs/retention-backup-contract.md §9). A maintenance process (prune/archive rollup/restore) killed before its finally/close() path runs can leave `maintenance_lock` populated with no live holder, stalling later task claims and maintenance runs. Read-only (issue #817 review: never creates the table or migrates the database, so it can inspect a legacy or filesystem-read-only database without mutating or failing against it): reports whether the lock is held, its holder, acquisition time, age, whether it was acquired via skipActivityChecks (e.g. `admin archive rollup` — activityExempt), the count of task phases still claimed/running with an unexpired lease, and the count of outbox rows with a non-stale dispatch claim. Never includes the local database path.",
    options: [
      { flag: "--session-id <id>", description: "Session ID (mutually exclusive with --session-ref)." },
      { flag: "--session-ref <ref>", description: "Session ID, session number, or alias (mutually exclusive with --session-id)." },
      { flag: "--db-path <path>", description: "Path to the SQLite database (optional; defaults to the standard location)." },
      { flag: "--json", description: "Emit structured JSON instead of human-readable text." },
    ],
  },
  {
    name: "maintenance-lock release",
    description:
      "Force-release the whole-file maintenance lock (issue #817), recovering from a maintenance process killed before its finally/close() path ran. Ignores the recorded holder, unlike the lock's own release(), but refuses while any task phase is still claimed/running with an unexpired lease or any outbox row has a non-stale dispatch claim — the same activity checks acquire() itself refuses on — so it can never clear a lock while the work it protects is genuinely still in flight. Also requires --confirm-stranded (P1 review follow-up) before releasing any lock, of any holder kind: zero of the two activity counts above is not by itself evidence a holder has finished, since prune/restore do their own destructive work — a delete batch, a file rename — without ever creating a task lease or outbox claim for it, so a live one of either shows zero of both for its entire run, indistinguishable from a genuinely stranded lock (the same is true of a skipActivityChecks holder, e.g. `admin archive rollup`) — releasing without confirmation could let a second `prune run --yes`/`restore` start concurrently against a live one. Deliberately no TTL-based auto-recovery and no PID-liveness check: this guarded action (plus the explicit --confirm-stranded override, itself an operator confirmation rather than a liveness check this command performs) is the only supported recovery path. Previews by default; pass --yes to release. A database with no lock held is a safe no-op. Read-only until --yes is given (issue #817 review): preview never creates the table or migrates the database.",
    options: [
      { flag: "--session-id <id>", description: "Session ID (mutually exclusive with --session-ref)." },
      { flag: "--session-ref <ref>", description: "Session ID, session number, or alias (mutually exclusive with --session-id)." },
      { flag: "--db-path <path>", description: "Path to the SQLite database (optional; defaults to the standard location)." },
      { flag: "--yes", description: "Actually release the lock (without it, the command only previews)." },
      {
        flag: "--confirm-stranded",
        description:
          "Required alongside --yes to release any held lock — confirm out-of-band first that no maintenance process (prune, restore, archive rollup) is still running against this database.",
      },
      { flag: "--json", description: "Emit structured JSON instead of human-readable text." },
    ],
  },
  {
    name: "session-init",
    description: "Create or add a session entry to sessions.json. Errors if the session ID or repo key already exists.",
    options: [
      { flag: "--session-id <id>", description: "Unique session identifier (required)." },
      { flag: "--repo-key <key>", description: "Unique repository key (required)." },
      { flag: "--repo-root <path>", description: "Absolute path to the repository root (required)." },
      { flag: "--github-repo <owner/name>", description: "GitHub repository in owner/name format (required)." },
      { flag: "--artifact-dir <dir>", description: "Artifact directory relative to repoRoot (required)." },
      { flag: "--implementation-agent <agent>", description: "Default implementation agent: claude | codex | gemini (required)." },
      { flag: "--review-agent <agent>", description: "Default review agent: claude | codex | gemini (required)." },
      { flag: "--research-agent <agent>", description: "Default research agent: claude | codex | gemini (optional)." },
      { flag: "--verification-json <json>", description: "Verification commands as a JSON object, e.g. '{\"test\":\"npm test\"}' (optional)." },
      { flag: "--labels-active <label>", description: "GitHub label for active tasks (default: ai:active)." },
      { flag: "--labels-blocked <label>", description: "GitHub label for blocked tasks (default: ai:blocked)." },
      { flag: "--labels-ready-for-human <label>", description: "GitHub label for tasks ready for human review (default: ai:ready-for-human)." },
      { flag: "--sessions-path <path>", description: "Path to sessions.json (optional)." },
    ],
  },
  {
    name: "issue-discuss preview",
    description: "Read an issue and write a local refinement-prompt preview artifact. Read-only: never posts to GitHub or mutates labels/state/tasks.",
    options: [
      { flag: "--session-id <id>", description: "Session ID to resolve repo and artifact dir (required)." },
      { flag: "--issue-number <n>", description: "Issue number to read (required)." },
      { flag: "--comment-limit <n>", description: `Most recent comments to include (default: 10, max: 50).` },
      { flag: "--sessions-path <path>", description: "Path to sessions.json (optional)." },
    ],
  },
  {
    name: "issue-plan preview",
    description: "Analyze an issue before implementation and write a structured planning artifact (decision, complexity, implementation/review effort, recommended flow, risks, split recommendation, acceptance criteria). Read-only: never posts to GitHub or mutates labels/state/tasks. Treats issue body/comments as untrusted input and derives the result deterministically (no AI agent).",
    options: [
      { flag: "--session-id <id>", description: "Session ID to resolve repo and artifact dir (required)." },
      { flag: "--issue-number <n>", description: "Issue number to analyze (required)." },
      { flag: "--comment-limit <n>", description: `Most recent comments to include in analysis (default: 10, max: 50).` },
      { flag: "--sessions-path <path>", description: "Path to sessions.json (optional)." },
    ],
  },
  {
    name: "issue-plan ai-preview",
    description: "Read an issue and ask a configured AI Planner agent for a structured planning proposal, then compare it with the deterministic issue-plan heuristic baseline. Read-only: never posts to GitHub or mutates labels/state/tasks/branches. Treats issue body/comments as untrusted input, runs the planner with write-enabling env vars stripped in an isolated working directory, validates the planner JSON against the #357 schema, and writes local artifacts only (prompt, raw output, parsed result, context with execution metadata). Invalid planner output is recorded as an error and never trusted.",
    options: [
      { flag: "--session-id <id>", description: "Session ID to resolve repo and artifact dir (required)." },
      { flag: "--issue-number <n>", description: "Issue number to analyze (required)." },
      { flag: "--planner-agent <agent>", description: "Planner provider to invoke (default: claude)." },
      { flag: "--model <model>", description: "Model to request from the planner agent (optional)." },
      { flag: "--effort <effort>", description: "Reasoning/effort level recorded in artifact metadata (optional)." },
      { flag: "--timeout <ms>", description: "Hard timeout for the planner agent in milliseconds (default: 120000, max: 600000)." },
      { flag: "--comment-limit <n>", description: `Most recent comments to include (default: 10, max: 50).` },
      { flag: "--sessions-path <path>", description: "Path to sessions.json (optional)." },
    ],
  },
  {
    name: "issue-plan evaluate-history",
    description: "Run the current issue-plan heuristic over an explicit list of historical issues and join each prediction with local SQLite workflow outcomes (task attempts, phase events, generated comment bodies). Optionally compare AI Planner predictions side by side via --planner-mode: `artifact` consumes the read-only ai-preview artifacts (preferred), `live` runs the planner per issue under the same no-tools isolation (explicit opt-in). Read-only with respect to GitHub and SQLite (the database is opened read-only). Writes local calibration artifacts only — a JSONL dataset, a Markdown summary, and a Gemini/Codex-ready calibration prompt — under <artifactRoot>/issue-plan/evaluate-history/<timestamp>/. Never posts to GitHub, mutates state, or creates child issues. Missing AI Planner artifacts are reported explicitly, never treated as a successful prediction.",
    options: [
      { flag: "--session-id <id>", description: "Session ID to resolve repo and artifact dir (required)." },
      { flag: "--issues <csv>", description: "Comma-separated issue numbers to evaluate, e.g. 342,343,349,350,338 (required)." },
      { flag: "--format <fmt>", description: "Alternate machine serialization to also emit: jsonl | json | csv | markdown (default: jsonl). JSONL, summary Markdown, and the calibration prompt are always written." },
      { flag: "--comment-limit <n>", description: `Most recent comments to include in the heuristic analysis (default: 10, max: 50).` },
      { flag: "--planner-mode <mode>", description: "Whether/how to include AI Planner predictions: off | artifact | live (default: off). `artifact` consumes existing ai-preview artifacts; `live` runs the planner per issue (opt-in)." },
      { flag: "--planner-agent <name>", description: "Planner provider for --planner-mode live (default: claude)." },
      { flag: "--model <model>", description: "Model override for --planner-mode live (optional)." },
      { flag: "--effort <level>", description: "Reasoning/effort override for --planner-mode live (optional)." },
      { flag: "--timeout <ms>", description: "Per-issue planner timeout for --planner-mode live (default: 120000, max: 600000)." },
      { flag: "--sessions-path <path>", description: "Path to sessions.json (optional)." },
      { flag: "--db-path <path>", description: "Path to SQLite database (optional)." },
    ],
  },
  {
    name: "issue-discuss post",
    description: "Post a previously reviewed discussion draft to GitHub. Verifies the artifact fingerprint and re-checks live issue state before posting. Never re-runs any AI agent.",
    options: [
      { flag: "--session-id <id>", description: "Session ID to resolve repo and artifact dir (required)." },
      { flag: "--issue-number <n>", description: "Issue number to post to (required)." },
      { flag: "--artifact <path>", description: "Path to the issue-discuss-context.json produced by the preview command (required)." },
      { flag: "--approve <token>", description: "Fingerprint emitted by the preview command confirming the artifact has been reviewed (required)." },
      { flag: "--sessions-path <path>", description: "Path to sessions.json (optional)." },
    ],
  },
  {
    name: "refinement run",
    description: "Run one bounded two-agent Issue refinement attempt (issue #869, docs/issue-refinement-contract.md): resolve the refiner and critic as two independent no-tools agents, capture the bounded predecessor snapshot, and run the refiner/critic exchange up to the configured round cap. Both agents run isolated — write-enabling env vars stripped, throwaway working directory, no tool surface — and treat Issue/PR/comment text as untrusted data. Never mutates GitHub: no Issue body, label, dependency, comment, branch, or PR is touched; a critic pass persists the accepted refined contract locally (task context + artifact directory) and every cap, malformed output, blocking topology proposal, or persistent disagreement stops at a ready_for_human handoff with the reason recorded. Requires issueRefinement.enabled and a refinement-phase task admitted by intake.",
    options: [
      { flag: "--session-id <id>", description: "Session ID to resolve repo, artifact dir, and issueRefinement config (required)." },
      { flag: "--issue-number <n>", description: "Issue number whose refinement-phase task to run (required)." },
      { flag: "--timeout <ms>", description: "Per-agent-invocation timeout in milliseconds (default: 600000, max: 3600000)." },
      { flag: "--sessions-path <path>", description: "Path to sessions.json (optional)." },
      { flag: "--db-path <path>", description: "Path to SQLite database (optional)." },
      { flag: "--lock-dir <path>", description: "Directory for lock files (optional; defaults to ~/.local/state/n8n-ai-cli-loop/locks — the run holds the same per-issue worktree lock the phase runner uses)." },
    ],
  },
  {
    name: "refinement recover",
    description: "Recover an Issue whose refinement stopped at a ready_for_human handoff (issue #980, docs/issue-refinement-contract.md §13, §12 row 36). The only supported transition out of ready_for_human / phase refinement / escalated_human: it clears the handoff reason, the rejected draft, the predecessor snapshot and fingerprint, and the round/malformed/agent-failure/stale counters, drops the previous attempt's execution metadata and the task's delay/lease/owner/last error, and re-queues the row at phase refinement with the refinement state back at pending — so the next run captures a fresh snapshot and starts with the refiner. context.assignment, the applied-refinement record §10 needs to trust an existing managed region, and the status:needs-refinement marker are preserved. Previews by default and mutates nothing; --yes applies the reset, its refinement.recovery.applied event, and the ready-for-human label removal in one guarded transaction. Refuses any other status, phase, or refinement state, a claimed task, and any Issue whose labels are not the admissible shape (status:needs-refinement present, no executable status:* label). Holds the same per-issue worktree lock the phase runner uses.",
    options: [
      { flag: "--session-ref <ref>", description: "Session holding the task: sessionId, sessionNo, or alias (required, or use --session-id)." },
      { flag: "--session-id <id>", description: "Canonical session ID, as an alternative to --session-ref." },
      { flag: "--issue-number <n>", description: "Issue number whose escalated refinement task to recover (required, exactly one)." },
      { flag: "--yes", description: "Apply the recovery. Without it nothing is written: the command previews the task, its handoff reason, the observed labels, and the planned reset." },
      { flag: "--sessions-path <path>", description: "Path to sessions.json, used to resolve --session-ref (optional)." },
      { flag: "--db-path <path>", description: "Path to SQLite database (optional)." },
      { flag: "--lock-dir <path>", description: "Directory for lock files (optional; defaults to ~/.local/state/n8n-ai-cli-loop/locks — the command holds the same per-issue worktree lock the phase runner uses)." },
    ],
  },
  {
    name: "n8n deploy",
    description: "Generate the deployment artifacts for one session and import the shared child plus that session's parent workflow into a local n8n (issue #822). Previews by default and imports nothing; --yes applies. Imports the child before the parent (the parent references the child by its stable ID), verifies the imported IDs/names with `n8n list:workflow` and the parent's Config sessionId and child reference, and refuses to publish when verification fails. A parent that was already active is re-activated after the import, so a re-deploy never silently deactivates a running workflow; an apply holds a lock scoped to that parent workflow, so two concurrent deploys of the same session cannot lose each other's activation. Local/same-host n8n CLI v1 only — no REST API or remote Docker deployment. Local filesystem paths are redacted from the output.",
    options: [
      { flag: "--session-ref <ref>", description: "Session to deploy the parent workflow for: sessionId, sessionNo, or alias (required, or use --session-id)." },
      { flag: "--session-id <id>", description: "Canonical session ID, as an alternative to --session-ref." },
      { flag: "--project-id <id>", description: "n8n project to import both workflows into (optional; n8n's default project otherwise)." },
      { flag: "--n8n-bin <path>", description: "Path to the n8n binary (default: n8n from PATH)." },
      { flag: "--yes", description: "Apply the deployment. Without it nothing is generated, imported, or published." },
      { flag: "--publish", description: "Activate the parent workflow after verification passes. Requires --yes. Not needed to keep an already active parent active — that is restored automatically." },
      { flag: "--lock-dir <path>", description: "Directory holding the per-parent-workflow deployment lock that serializes concurrent deploys of the same session (optional; defaults to ~/.local/state/n8n-ai-cli-loop/locks)." },
      { flag: "--sessions-path <path>", description: "Path to sessions.json (optional)." },
    ],
  },
  {
    name: "interventions",
    description: "Aggregate L3 human-rescue intervention signals from local SQLite events and task context for a session (issue #588). Counts human_review_return and tool_request_resolution events per issue and in aggregate. Read-only: never mutates the database. Output can be consumed by later admin report commands.",
    options: [
      { flag: "--session-id <id>", description: "Session ID to query (required)." },
      { flag: "--issue-number <n>", description: "Restrict to a single issue (optional)." },
      { flag: "--since <iso>", description: "Include only events at or after this ISO timestamp (optional)." },
      { flag: "--until <iso>", description: "Include only events before this ISO timestamp (optional)." },
      { flag: "--db-path <path>", description: "Path to SQLite database (optional)." },
    ],
  },
];

function formatHelpAll(): string {
  const lines: string[] = [
    "Usage: admin <subcommand> [options]",
    "",
    "Available commands:",
    "",
  ];
  const maxName = Math.max(...COMMANDS.map((c) => c.name.length));
  for (const cmd of COMMANDS) {
    lines.push(`  ${cmd.name.padEnd(maxName + 2)}${cmd.description}`);
  }
  lines.push("");
  lines.push("Global options (accepted by every command):");
  lines.push("  --json     Emit stable structured JSON on stdout.");
  lines.push("  --quiet    Suppress nonessential human text.");
  lines.push("  --verbose  Include extra diagnostics in human output.");
  lines.push("");
  lines.push(
    "Operator commands (task-status, list-stuck, recover, recover-cap-handoff)",
  );
  lines.push(
    "print human-readable text by default; pass --json for machine-readable output.",
  );
  lines.push(
    "Other commands default to JSON so existing n8n workflow/script callers keep working.",
  );
  lines.push("stdout carries results; warnings and errors go to stderr (JSON-mode");
  lines.push("errors stay on stdout as { ok: false, error }).");
  lines.push("");
  lines.push('Run "admin help <command>" for detailed options.');
  lines.push("");
  return lines.join("\n");
}

function formatHelpOne(cmd: CommandInfo): string {
  const lines: string[] = [
    `admin ${cmd.name} [options]`,
    "",
    `  ${cmd.description}`,
  ];
  if (cmd.entrypoint) {
    lines.push("");
    lines.push(`  Entrypoint: ${cmd.entrypoint}`);
  }
  if (cmd.options.length > 0) {
    lines.push("");
    lines.push("Options:");
    const maxFlag = Math.max(...cmd.options.map((o) => o.flag.length));
    for (const opt of cmd.options) {
      lines.push(`  ${opt.flag.padEnd(maxFlag + 2)}${opt.description}`);
    }
  }
  lines.push("");
  lines.push("Global options: --json (structured JSON), --quiet, --verbose.");
  if (HUMAN_DEFAULT_COMMANDS.has(cmd.name)) {
    lines.push("Output: human-readable by default; pass --json for structured JSON.");
  } else {
    lines.push("Output: structured JSON (stable for machine callers).");
  }
  lines.push("");
  return lines.join("\n");
}

function runHelp(argv: string[]): void {
  const target = argv.join(" ").trim();
  if (target) {
    const cmd = COMMANDS.find((c) => c.name === target);
    if (!cmd) {
      die(`Unknown command: ${target}. Run "admin help" to see available commands.`);
    }
    writeOut(formatHelpOne(cmd));
  } else {
    writeOut(formatHelpAll());
  }
}

// ---------------------------------------------------------------------------
// Subcommand: task-status
//
// The shared session selector (--session-id / --session-ref), common option
// parsing, and output helpers live in ./admin-command and ./cli-io so every
// command behaves consistently (issue #309).
// ---------------------------------------------------------------------------

interface TaskStatusArgs {
  sessionId: string;
  issueNumber: number | undefined;
  dbPath: string | undefined;
}

function parseTaskStatusArgs(argv: string[]): TaskStatusArgs | { error: string } {
  const opts = parseCommonOptions(argv, { session: "required", issueNumber: "optional" });
  if ("error" in opts) return { error: opts.error };
  return {
    sessionId: opts.sessionId,
    issueNumber: opts.issueNumber,
    dbPath: opts.dbPath,
  };
}

function sessionScope(sessionId: string, issueNumber: number | undefined): string {
  return issueNumber !== undefined
    ? `session ${sessionId}, issue #${issueNumber}`
    : `session ${sessionId}`;
}

function renderTaskStatus(
  payload: {
    sessionId: string;
    issueNumber?: number;
    tasks: Array<{
      issueNumber: number;
      status: string;
      phase: string;
      priority: string;
      implementationAgent?: string;
      reviewAgent?: string;
      researchAgent?: string;
      ownerRunId?: string;
      leaseExpiresAt?: string;
      attempts?: unknown;
      lastError?: string;
      missingVerificationCommands?: string[] | null;
      /**
       * Issue #848: the persisted §10.1 protocol state, or null for a task that
       * carries none. Null is the legacy answer — a task from before the
       * protocol, or from a session with `reviewDispute.enabled: false`, which
       * never writes a block — and it renders nothing at all, so existing output
       * is byte-identical for every such task.
       */
      reviewDispute?: DisputeTaskStatus | null;
      /**
       * Issue #867: the persisted §15 refinement block, or null for a task that
       * carries none — every task outside the refinement lane, and every task in
       * a session with `issueRefinement.enabled: false`. Null renders nothing at
       * all, so existing output is byte-identical for every such task.
       */
      refinement?: RefinementTaskStatus | null;
      updatedAt: string;
    }>;
  },
  mode: OutputMode,
): string {
  const scope = sessionScope(payload.sessionId, payload.issueNumber);
  if (payload.tasks.length === 0) {
    return `No tasks found for ${scope}.`;
  }
  const lines: string[] = [];
  if (!mode.quiet) {
    lines.push(`${payload.tasks.length} task(s) for ${scope}:`);
  }
  for (const t of payload.tasks) {
    lines.push(`  #${t.issueNumber}  ${t.status}  phase=${t.phase}  priority=${t.priority}`);
    if (mode.verbose) {
      lines.push(
        `        agents: impl=${t.implementationAgent ?? "-"} review=${t.reviewAgent ?? "-"} research=${t.researchAgent ?? "-"}`,
      );
      const attempts =
        t.attempts && typeof t.attempts === "object" ? JSON.stringify(t.attempts) : String(t.attempts ?? 0);
      lines.push(
        `        owner=${t.ownerRunId ?? "-"} lease=${t.leaseExpiresAt ?? "-"} attempts=${attempts} updated=${t.updatedAt}`,
      );
    }
    if (t.lastError) {
      lines.push(`        lastError: ${t.lastError}`);
    }
    if (t.missingVerificationCommands && t.missingVerificationCommands.length > 0) {
      lines.push(`        missing verification: ${t.missingVerificationCommands.join(", ")}`);
    }
    // Issue #848. Rendered through the same helper `admin dispute status` and
    // the admin UI use, so the three surfaces show one projection rather than
    // three that happen to agree today.
    if (t.reviewDispute) {
      lines.push(...renderDisputeLines(t.reviewDispute, "        "));
    }
    // Issue #867. Same posture as the dispute block above: a pure projection of
    // what the task already carries, rendered through the shared core helper.
    if (t.refinement) {
      lines.push(...renderRefinementLines(t.refinement, "        "));
    }
  }
  return lines.join("\n");
}

async function runTaskStatus(argv: string[]): Promise<void> {
  const parsed = parseTaskStatusArgs(argv);
  if ("error" in parsed) die(parsed.error);

  const { sessionId, issueNumber, dbPath } = parsed;

  const store = new SqliteTaskStore(dbPath);
  try {
    const tasks =
      issueNumber !== undefined
        ? await store.getTask({ sessionId, issueNumber }).then((t) => (t ? [t] : []))
        : await store.listSessionTasks(sessionId);
    // Issue #848: the §10.3 routing/stop reason lives on a task event, not in the
    // context block, so it needs a per-task event read — taken ONLY for a task
    // that actually carries a protocol block. A session that never enabled the
    // protocol therefore does exactly the queries it did before, and a listing of
    // many legacy tasks costs nothing extra.
    //
    // Issue #977 needs the same read for a refinement task: the §15 progress
    // milestones are persisted as task events, so the operator view of "where is
    // this Issue now" cannot be answered from the context block alone. The two
    // lanes share ONE event read per task — a task carrying both blocks must not
    // pay for the log twice — and a task carrying neither still does exactly the
    // queries it did before.
    const disputeSummaries = new Map<number, DisputeTaskStatus | null>();
    const refinementSummaries = new Map<number, RefinementTaskStatus | null>();
    // One clock read for the whole listing: whether a committed delay is still
    // in force is a comparison against a single instant, and taking it per task
    // would let two rows in one report be classified against different "now"s.
    const now = new Date().toISOString();
    for (const t of tasks) {
      const hasDispute = t.context?.[REVIEW_DISPUTE_CONTEXT_KEY] !== undefined;
      const hasRefinement = t.context?.[REFINEMENT_CONTEXT_KEY] !== undefined;
      if (!hasDispute && !hasRefinement) {
        disputeSummaries.set(t.issueNumber, null);
        refinementSummaries.set(t.issueNumber, summarizeRefinementStatus(t));
        continue;
      }
      const events = await store.listEvents({ sessionId: t.sessionId, issueNumber: t.issueNumber });
      disputeSummaries.set(t.issueNumber, hasDispute ? summarizeDisputeStatus(t, events) : null);
      refinementSummaries.set(
        t.issueNumber,
        summarizeRefinementStatus(t, hasRefinement ? events : undefined, now),
      );
    }
    const result = {
      ok: true,
      sessionId,
      ...(issueNumber !== undefined ? { issueNumber } : {}),
      tasks: tasks.map((t) => ({
        sessionId: t.sessionId,
        issueNumber: t.issueNumber,
        status: t.status,
        phase: t.phase,
        priority: t.priority,
        implementationAgent: t.implementationAgent,
        reviewAgent: t.reviewAgent,
        researchAgent: t.researchAgent,
        ownerRunId: t.ownerRunId,
        leaseExpiresAt: t.leaseExpiresAt,
        attempts: t.attempts,
        lastError: t.lastError,
        missingVerificationCommands: Array.isArray(t.context?.["missingVerificationCommands"])
          ? (t.context["missingVerificationCommands"] as unknown[]).filter((c): c is string => typeof c === "string")
          : null,
        reviewDispute: disputeSummaries.get(t.issueNumber) ?? null,
        // Issue #867/#977: the §15 block plus, for a refinement task, the
        // normalized progress view derived from its persisted milestone events.
        refinement: refinementSummaries.get(t.issueNumber) ?? null,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
      })),
    };
    report(result, (mode) => renderTaskStatus(result, mode));
  } finally {
    store.close();
  }
}

// ---------------------------------------------------------------------------
// Subcommand: list-stuck
// ---------------------------------------------------------------------------

interface ListStuckArgs {
  sessionId: string;
  dbPath: string | undefined;
}

function parseListStuckArgs(argv: string[]): ListStuckArgs | { error: string } {
  const tokenized = tokenizeArgs(argv, {
    valueFlags: ["session-id", "db-path"],
  });
  if ("error" in tokenized) return { error: tokenized.error };
  const { args } = tokenized;

  if (!args["session-id"]) return { error: "--session-id is required" };

  return {
    sessionId: args["session-id"],
    dbPath: args["db-path"],
  };
}

function taskRow(t: { issueNumber: number; status: string; phase: string; ownerRunId?: string; leaseExpiresAt?: string; lastError?: string; updatedAt: string }) {
  return {
    issueNumber: t.issueNumber,
    status: t.status,
    phase: t.phase,
    ownerRunId: t.ownerRunId ?? null,
    leaseExpiresAt: t.leaseExpiresAt ?? null,
    lastError: t.lastError ?? null,
    updatedAt: t.updatedAt,
  };
}

type StuckRow = ReturnType<typeof taskRow>;

function renderStuckRows(label: string, rows: StuckRow[], verbose: boolean): string[] {
  if (rows.length === 0) return [];
  const lines = [`${label} (${rows.length}):`];
  for (const t of rows) {
    lines.push(`  #${t.issueNumber}  ${t.status}  phase=${t.phase}`);
    if (verbose) {
      lines.push(
        `        owner=${t.ownerRunId ?? "-"} lease=${t.leaseExpiresAt ?? "-"} updated=${t.updatedAt}`,
      );
    }
    if (t.lastError) {
      lines.push(`        lastError: ${t.lastError}`);
    }
  }
  return lines;
}

function renderListStuck(
  payload: {
    sessionId: string;
    now: string;
    summary: { failed: number; stale: number; mismatched: number; noLease: number; total: number };
    failed: StuckRow[];
    stale: StuckRow[];
    mismatched: StuckRow[];
    noLease: StuckRow[];
  },
  mode: OutputMode,
): string {
  const s = payload.summary;
  if (s.total === 0) {
    return `No stuck tasks for session ${payload.sessionId}.`;
  }
  const lines: string[] = [];
  if (!mode.quiet) {
    lines.push(`Stuck tasks for session ${payload.sessionId} (as of ${payload.now}):`);
    lines.push(
      `  failed=${s.failed} stale=${s.stale} mismatched=${s.mismatched} noLease=${s.noLease} (total ${s.total})`,
    );
    lines.push("");
  }
  lines.push(...renderStuckRows("failed", payload.failed, mode.verbose));
  lines.push(...renderStuckRows("stale", payload.stale, mode.verbose));
  lines.push(...renderStuckRows("mismatched", payload.mismatched, mode.verbose));
  lines.push(...renderStuckRows("noLease", payload.noLease, mode.verbose));
  return lines.join("\n").replace(/\n+$/, "");
}

async function runListStuck(argv: string[]): Promise<void> {
  const parsed = parseListStuckArgs(argv);
  if ("error" in parsed) die(parsed.error);

  const { sessionId, dbPath } = parsed;
  const now = new Date().toISOString();

  const store = new SqliteTaskStore(dbPath);
  try {
    const all = await store.listSessionTasks(sessionId);

    const failed = all.filter((t) => t.status === "failed");

    const stale = all.filter(
      (t) =>
        (t.status === "claimed" || t.status === "running") &&
        isClaimExpired(t, now),
    );

    // Mismatched: ownerRunId set on a non-claimed/non-running task, or
    // claimed/running task with no ownerRunId.
    const mismatched = all.filter((t) => {
      const activeStatus = t.status === "claimed" || t.status === "running";
      const hasOwner = Boolean(t.ownerRunId);
      return (activeStatus && !hasOwner) || (!activeStatus && hasOwner);
    });

    // Active tasks with an owner but no lease cannot be recovered by normal
    // reclaim or recoverTask paths until a lease exists and expires.
    const noLease = all.filter(
      (t) =>
        (t.status === "claimed" || t.status === "running") &&
        Boolean(t.ownerRunId) &&
        !t.leaseExpiresAt,
    );

    const result = {
      ok: true,
      sessionId,
      now,
      summary: {
        failed: failed.length,
        stale: stale.length,
        mismatched: mismatched.length,
        noLease: noLease.length,
        total: failed.length + stale.length + mismatched.length + noLease.length,
      },
      failed: failed.map(taskRow),
      stale: stale.map(taskRow),
      mismatched: mismatched.map(taskRow),
      noLease: noLease.map(taskRow),
    };
    report(result, (mode) => renderListStuck(result, mode));
  } finally {
    store.close();
  }
}

// ---------------------------------------------------------------------------
// Subcommand: recover
// ---------------------------------------------------------------------------

interface RecoverArgs {
  sessionId: string;
  issueNumber: number | undefined;
  phase: TaskPhase | undefined;
  from: "ready_for_human" | undefined;
  dbPath: string | undefined;
  dryRun: boolean;
}

function parseRecoverArgs(argv: string[]): RecoverArgs | { error: string } {
  const tokenized = tokenizeArgs(argv, {
    booleanFlags: ["dry-run"],
    valueFlags: ["session-id", "session-ref", "sessions-path", "issue-number", "phase", "from", "db-path"],
  });
  if ("error" in tokenized) return { error: tokenized.error };
  const { args, flags } = tokenized;
  const dryRun = flags.has("dry-run");

  const selector = resolveSessionSelector(args);
  if ("error" in selector) return { error: selector.error };

  let issueNumber: number | undefined;
  if (args["issue-number"] !== undefined) {
    const n = Number(args["issue-number"]);
    if (!Number.isInteger(n) || n <= 0) {
      return { error: `--issue-number must be a positive integer, got: ${args["issue-number"]}` };
    }
    issueNumber = n;
  }

  let phase: TaskPhase | undefined;
  if (args["phase"] !== undefined) {
    if (!VALID_PHASES.includes(args["phase"] as TaskPhase)) {
      return { error: `--phase must be one of: ${VALID_PHASES.join(", ")}, got: ${args["phase"]}` };
    }
    phase = args["phase"] as TaskPhase;
  }

  let from: "ready_for_human" | undefined;
  if (args["from"] !== undefined) {
    if (args["from"] !== "ready_for_human") {
      return { error: `--from must be 'ready_for_human', got: ${args["from"]}` };
    }
    from = "ready_for_human";
    if (!phase) {
      return { error: "--phase is required when --from ready_for_human is used" };
    }
  }

  return {
    sessionId: selector.sessionId,
    issueNumber,
    phase,
    from,
    dbPath: args["db-path"],
    dryRun,
  };
}

const RECOVERABLE_STATUSES = ["failed", "claimed", "running"] as const;

// Shared human renderers for recover / recover-cap-handoff. Both commands always
// re-queue tasks, so the human text frames every entry as "<previous> → queued".
interface RecoverItem {
  issueNumber: number;
  status?: string;
  phase: string;
  previousStatus: string;
  previousPhase?: string;
  reviewCycles?: number;
}

interface SkippedRecoverItem {
  issueNumber: number;
  reason: string;
}

// issue #677: `store.recoverHandoff` refuses to move a `ready_for_human` task with
// a live (unresolved) implementation Tool Request into another phase — including
// review — because the SQLite Tool Request state is authoritative over whatever
// prompted the recover (a mistaken operator command, a stale/conflicting GitHub
// review label, etc.). Expand its terse `tool_request_unresolved` code into the
// actionable message the operator needs here, rather than in the store layer.
function recoverSkipReason(code: string): string {
  if (code === "tool_request_unresolved") {
    return (
      "tool_request_unresolved: issue has an unresolved implementation Tool Request; " +
      "resolve it first with 'admin tool-request resolve' or 'admin tool-request grant' " +
      "before this task can be requeued into another phase"
    );
  }
  return code;
}

function recoverItemLine(it: RecoverItem, target: string): string {
  let line = `  #${it.issueNumber}  ${it.previousStatus} → ${target}  (phase ${it.phase})`;
  if (typeof it.reviewCycles === "number") line += `  reviewCycles=${it.reviewCycles}`;
  return line;
}

function renderRecoverDryRun(
  payload: {
    sessionId: string;
    issueNumber?: number;
    wouldRecover: RecoverItem[];
    wouldSkip?: SkippedRecoverItem[];
  },
  mode: OutputMode,
): string {
  const scope = sessionScope(payload.sessionId, payload.issueNumber);
  const wouldSkip = payload.wouldSkip ?? [];
  if (payload.wouldRecover.length === 0 && wouldSkip.length === 0) {
    return `Dry run: no recoverable tasks for ${scope}.`;
  }
  const lines: string[] = [];
  if (!mode.quiet) {
    const tail = wouldSkip.length > 0 ? `, would skip ${wouldSkip.length}:` : ":";
    lines.push(`Dry run — would recover ${payload.wouldRecover.length} task(s) for ${scope}${tail}`);
  }
  for (const it of payload.wouldRecover) {
    lines.push(recoverItemLine(it, "queued"));
  }
  for (const it of wouldSkip) {
    lines.push(`  #${it.issueNumber}  skipped: ${it.reason}`);
  }
  return lines.join("\n");
}

function renderRecoverResult(
  payload: {
    sessionId: string;
    issueNumber?: number;
    recovered: RecoverItem[];
    skipped: SkippedRecoverItem[];
  },
  mode: OutputMode,
): string {
  const scope = sessionScope(payload.sessionId, payload.issueNumber);
  if (payload.recovered.length === 0 && payload.skipped.length === 0) {
    return `No recoverable tasks for ${scope}.`;
  }
  const lines: string[] = [];
  if (!mode.quiet) {
    const tail = payload.skipped.length > 0 ? `, skipped ${payload.skipped.length}:` : ":";
    lines.push(`Recovered ${payload.recovered.length} task(s) for ${scope}${tail}`);
  }
  for (const it of payload.recovered) {
    lines.push(recoverItemLine(it, it.status ?? "queued"));
  }
  for (const it of payload.skipped) {
    lines.push(`  #${it.issueNumber}  skipped: ${it.reason}`);
  }
  return lines.join("\n");
}

async function runRecover(argv: string[]): Promise<void> {
  const parsed = parseRecoverArgs(argv);
  if ("error" in parsed) die(parsed.error);

  const { sessionId, issueNumber, phase, from, dbPath, dryRun } = parsed;
  const now = new Date().toISOString();

  const store = new SqliteTaskStore(dbPath);
  try {
    if (from === "ready_for_human") {
      const sessionTasks =
        issueNumber !== undefined
          ? await store.getTask({ sessionId, issueNumber }).then((t) => (t ? [t] : []))
          : await store.listSessionTasks(sessionId);
      const candidates = sessionTasks.filter((t) => t.status === "ready_for_human");

      if (dryRun) {
        // issue #677: preview the same tool_request_unresolved refusal
        // `store.recoverHandoff` enforces below, so a dry run does not promise a
        // recovery that the live run would then refuse.
        const wouldRecover: RecoverItem[] = [];
        const wouldSkip: SkippedRecoverItem[] = [];
        for (const t of candidates) {
          if (hasUnresolvedToolRequest(t.context)) {
            wouldSkip.push({ issueNumber: t.issueNumber, reason: recoverSkipReason("tool_request_unresolved") });
            continue;
          }
          wouldRecover.push({
            issueNumber: t.issueNumber,
            status: "queued",
            phase: phase!,
            previousPhase: t.phase,
            previousStatus: t.status,
          });
        }
        const result = {
          ok: true,
          dryRun: true,
          sessionId,
          ...(issueNumber !== undefined ? { issueNumber } : {}),
          wouldRecover,
          ...(wouldSkip.length > 0 ? { wouldSkip } : {}),
        };
        report(result, (mode) => renderRecoverDryRun(result, mode));
        return;
      }

      const recovered: RecoverItem[] = [];
      const skipped: SkippedRecoverItem[] = [];

      for (const task of candidates) {
        const result = await store.recoverHandoff(
          { sessionId: task.sessionId, issueNumber: task.issueNumber },
          { fromStatus: "ready_for_human", phase: phase!, now },
        );
        if (result.ok) {
          recovered.push({
            issueNumber: result.value.issueNumber,
            status: result.value.status,
            phase: result.value.phase,
            previousStatus: task.status,
            previousPhase: task.phase,
          });
        } else {
          skipped.push({
            issueNumber: task.issueNumber,
            reason: recoverSkipReason(result.code),
          });
        }
      }

      const handoffResult = {
        ok: true,
        sessionId,
        ...(issueNumber !== undefined ? { issueNumber } : {}),
        recovered,
        skipped,
      };
      report(handoffResult, (mode) => renderRecoverResult(handoffResult, mode));
      return;
    }

    const generalSessionTasks =
      issueNumber !== undefined
        ? await store.getTask({ sessionId, issueNumber }).then((t) => (t ? [t] : []))
        : await store.listSessionTasks(sessionId);
    const candidates = generalSessionTasks.filter(
      (t) =>
        (RECOVERABLE_STATUSES as readonly string[]).includes(t.status) &&
        (t.status === "failed" || isClaimExpired(t, now)),
    );

    if (dryRun) {
      const result = {
        ok: true,
        dryRun: true,
        sessionId,
        ...(issueNumber !== undefined ? { issueNumber } : {}),
        wouldRecover: candidates.map((t) => ({
          issueNumber: t.issueNumber,
          status: t.status,
          phase: phase ?? t.phase,
          previousPhase: t.phase,
          previousStatus: t.status,
        })),
      };
      report(result, (mode) => renderRecoverDryRun(result, mode));
      return;
    }

    const recovered: RecoverItem[] = [];
    const skipped: SkippedRecoverItem[] = [];

    for (const task of candidates) {
      const result = await store.recoverTask(
        { sessionId: task.sessionId, issueNumber: task.issueNumber },
        { phase, now },
      );
      if (result.ok) {
        recovered.push({
          issueNumber: result.value.issueNumber,
          status: result.value.status,
          phase: result.value.phase,
          previousStatus: task.status,
          previousPhase: task.phase,
        });
      } else {
        skipped.push({
          issueNumber: task.issueNumber,
          reason: result.code,
        });
      }
    }

    const result = {
      ok: true,
      sessionId,
      ...(issueNumber !== undefined ? { issueNumber } : {}),
      recovered,
      skipped,
    };
    report(result, (mode) => renderRecoverResult(result, mode));
  } finally {
    store.close();
  }
}

// ---------------------------------------------------------------------------
// Subcommand: recover-cap-handoff
// ---------------------------------------------------------------------------

interface RecoverCapHandoffArgs {
  sessionId: string;
  issueNumber: number | undefined;
  phase: TaskPhase | undefined;
  dbPath: string | undefined;
  dryRun: boolean;
}

function parseRecoverCapHandoffArgs(argv: string[]): RecoverCapHandoffArgs | { error: string } {
  const opts = parseCommonOptions(argv, {
    session: "required",
    issueNumber: "optional",
    phase: "optional",
    dryRun: true,
  });
  if ("error" in opts) return { error: opts.error };
  return {
    sessionId: opts.sessionId,
    issueNumber: opts.issueNumber,
    phase: opts.phase,
    dbPath: opts.dbPath,
    dryRun: opts.dryRun,
  };
}

async function runRecoverCapHandoff(argv: string[]): Promise<void> {
  const parsed = parseRecoverCapHandoffArgs(argv);
  if ("error" in parsed) die(parsed.error);

  const { sessionId, issueNumber, phase, dbPath, dryRun } = parsed;

  const store = new SqliteTaskStore(dbPath);
  try {
    const sessionTasks =
      issueNumber !== undefined
        ? await store.getTask({ sessionId, issueNumber }).then((t) => (t ? [t] : []))
        : await store.listSessionTasks(sessionId);
    const candidates = sessionTasks.filter(
      (t) =>
        t.status === "ready_for_human" &&
        Boolean(t.context["reviewLoopCapReached"]),
    );

    if (dryRun) {
      const result = {
        ok: true,
        dryRun: true,
        sessionId,
        ...(issueNumber !== undefined ? { issueNumber } : {}),
        wouldRecover: candidates.map((t) => ({
          issueNumber: t.issueNumber,
          status: "queued",
          phase: phase ?? "review",
          previousPhase: t.phase,
          previousStatus: t.status,
          reviewCycles: typeof t.context["reviewCycles"] === "number" ? t.context["reviewCycles"] : 0,
        })),
      };
      report(result, (mode) => renderRecoverDryRun(result, mode));
      return;
    }

    const recovered: RecoverItem[] = [];
    const skipped: SkippedRecoverItem[] = [];

    for (const task of candidates) {
      const result = await store.recoverCapHandoff(
        { sessionId: task.sessionId, issueNumber: task.issueNumber },
        { phase, now: new Date().toISOString() },
      );
      if (result.ok) {
        recovered.push({
          issueNumber: result.value.issueNumber,
          status: result.value.status,
          phase: result.value.phase,
          previousStatus: task.status,
          previousPhase: task.phase,
          reviewCycles: typeof task.context["reviewCycles"] === "number" ? task.context["reviewCycles"] : 0,
        });
      } else {
        skipped.push({
          issueNumber: task.issueNumber,
          reason: result.code,
        });
      }
    }

    const result = {
      ok: true,
      sessionId,
      ...(issueNumber !== undefined ? { issueNumber } : {}),
      recovered,
      skipped,
    };
    report(result, (mode) => renderRecoverResult(result, mode));
  } finally {
    store.close();
  }
}

// ---------------------------------------------------------------------------
// Subcommand: dispute status / dispute reopen (issue #848)
//
// The operator surface of the review-dispute protocol
// (docs/review-dispute-contract.md). Both actions read the SAME projection
// `task-status` and the admin UI use (`summarizeDisputeStatus`), so the three
// surfaces cannot disagree about what the task holds, and neither one opens a
// §10.2 artifact: arbiter reasoning, confidence, and evidence content are not
// persisted state and are therefore not shown.
//
// `dispute reopen` is the ONLY mutating dispute action, and it is deliberately
// the narrowest one the contract defines: §6.4's `reopen_requested` flag on a
// terminal lineage. It records that a human wants a resolution revisited — it
// does not overturn it, does not reset a counter, and does not move the lineage
// out of its terminal state (§6.4: terminal states are immutable audit records).
// Everything else an operator might want here is a specification gap, recorded
// in §15 of the contract rather than invented locally; `dispute status` prints
// the exact stop reason for those instead of offering a command.
// ---------------------------------------------------------------------------

/**
 * A §12 failure as operator-facing text. `detail` is a content-free locator by
 * construction (a field path plus a length/count/version), so it is safe to
 * print; `null` means the reason alone located it.
 */
function disputeFailureText(failure: ReviewDisputeFailure): string {
  return failure.detail === null ? failure.reason : `${failure.reason} at ${failure.detail}`;
}

interface DisputeStatusArgs {
  sessionId: string;
  issueNumber: number;
  sessionsPath: string;
  dbPath: string | undefined;
}

function parseDisputeStatusArgs(argv: string[]): DisputeStatusArgs | { error: string } {
  const opts = parseCommonOptions(argv, { session: "required", issueNumber: "required" });
  if ("error" in opts) return { error: opts.error };
  return {
    sessionId: opts.sessionId,
    issueNumber: opts.issueNumber!,
    // Not used to read anything here — this command touches only the task store —
    // but the `dispute reopen` line it prints DOES resolve the session, so the
    // registry the operator is inspecting under has to reach that command.
    sessionsPath: opts.sessionsPath,
    dbPath: opts.dbPath,
  };
}

/**
 * The shared human rendering of one task's dispute state.
 *
 * Used by `dispute status`, by `task-status --verbose`, and (via the UI's task
 * detail) by the interactive surface, so "UI/JSON parity" is a property of there
 * being one renderer rather than of three of them agreeing.
 */
function renderDisputeLines(summary: DisputeTaskStatus, indent = ""): string[] {
  const lines: string[] = [];
  const flags: string[] = [];
  if (summary.pendingReReview) flags.push("pendingReReview");
  if (summary.resolvedWithoutChanges) flags.push("resolvedWithoutChanges");
  lines.push(
    `${indent}review dispute: ${summary.lineages.length} lineage(s)` +
      (summary.reviewStructure ? `  review=${summary.reviewStructure}` : "") +
      (flags.length > 0 ? `  ${flags.join(" ")}` : ""),
  );
  for (const l of summary.lineages) {
    const c = l.counters;
    lines.push(
      `${indent}  ${l.lineageId}  v${l.version}  ${l.state ?? "(unreadable state)"}` +
        (l.outcome ? ` → ${l.outcome}` : "") +
        `  ${l.severity ?? "?"}  ${l.affectedBoundary ?? "(no boundary)"}`,
    );
    lines.push(
      `${indent}      rebuttals=${c.rebuttals} reconsiderations=${c.reconsiderations} ` +
        `arbitrationPasses=${c.arbitrationPasses} malformedArbiter=${c.malformedArbiterAttempts} ` +
        `evidenceRounds=${c.evidenceRoundsUsed}` +
        (l.humanGate ? " humanGate" : "") +
        (l.reopenRequested ? " reopenRequested" : ""),
    );
    // §7.1's bounded evidence round, when this lineage has one (#956). Printed
    // only where it exists, so nothing changes for the tasks — almost all of
    // them — that never entered a round: counts and party states, never a
    // reference, a digest, or an artifact name.
    const evidence = summary.evidenceCollection.find((e) => e.lineageId === l.lineageId);
    if (evidence) {
      lines.push(
        `${indent}      evidence round ${evidence.round}: ` +
          evidence.parties.map(formatEvidenceParty).join(" ") +
          `  recorded=${evidence.attachmentsRecorded}` +
          (evidence.complete ? " complete" : "") +
          (evidence.recorded ? " rowApplied" : ""),
      );
    }
    // THIS lineage's own reviewer run and the posture it enforced (issue #1085
    // review, P2). Printed beside the lineage rather than only as the task's
    // last run, because a task that disputed two findings takes two reviewer
    // runs and the single-valued summary below then describes only the newer
    // one — leaving the older lineage's posture, which §17.6 D2 requires to
    // stay distinguishable, unstated. `(unrecorded)` for an entry that carries
    // none; never a supplied default.
    const rc = summary.reconsiderationsByLineage.find((e) => e.lineageId === l.lineageId);
    if (rc) {
      lines.push(
        `${indent}      reconsideration: v${rc.version} agent=${rc.agentId ?? "?"} ` +
          `toolPolicy=${rc.toolPolicy ?? "(unrecorded)"}`,
      );
    }
  }
  // The posture the last §4.1 reviewer run enforced (issue #1085). Printed only
  // where a reviewer run is on record, so nothing changes for a task that has
  // taken none — and `toolPolicy` is printed exactly as recorded, including
  // `(unrecorded)` for a run whose summary predates the field: an operator must
  // never read a supplied default as an enforced boundary.
  const lr = summary.lastReconsideration;
  if (lr) {
    lines.push(
      `${indent}  last reconsideration: ${lr.lineageId ?? "(unknown lineage)"} v${lr.version} ` +
        `agent=${lr.agentId ?? "?"} toolPolicy=${lr.toolPolicy ?? "(unrecorded)"}` +
        (lr.timedOut ? " timedOut" : "") +
        (lr.failure ? ` failure=${lr.failure}` : ""),
    );
  }
  // The D2 caveat, once, if ANY run on record took the weaker posture — the last
  // one or an earlier lineage's. Keyed on the per-lineage record as well as the
  // summary so a task whose newest run was `no-tools` still carries the warning
  // for the lineage that was actually decided read-bounded.
  if (
    lr?.toolPolicy === "read-bounded"
    || summary.reconsiderationsByLineage.some((e) => e.toolPolicy === "read-bounded")
  ) {
    lines.push(
      `${indent}    read-bounded (contract §17.6 D2): writes, network and operator agent config were refused, ` +
        `but reads outside the bundle were NOT bounded.`,
    );
  }
  const r = summary.routing;
  if (r) {
    lines.push(
      `${indent}  routing: rule=${r.rule ?? "-"} outcome=${r.outcome ?? "-"} turn=${r.turn ?? "-"} ` +
        `nextPhase=${r.nextPhase ?? "-"}` +
        (r.undispatchedTurn ? `  undispatchedTurn=${r.undispatchedTurn}` : ""),
    );
  } else {
    lines.push(`${indent}  routing: (no recorded ${REVIEW_DISPUTE_TRANSITION_EVENT} event)`);
  }
  const action = summary.nextAction;
  lines.push(`${indent}  next action: ${action.authorized ? action.action : `none (${action.reason})`}`);
  lines.push(`${indent}    ${action.description}`);
  if (action.authorized && action.command) {
    lines.push(`${indent}    ${formatAdminCommand(action.command)}`);
  }
  return lines;
}

/**
 * `scope` carries the flags the printed `dispute reopen` line must repeat so it
 * acts on the same registry and store this command read. They are PLACEHOLDERS
 * rather than the real values, for the same reason `worktreeDirtyHint` uses
 * them: this output is forwarded and recorded, and it carries no absolute local
 * path. The flag is still shown, so an operator on a custom registry is told to
 * supply it rather than silently running against the default one.
 */
function renderDisputeStatus(
  payload: { sessionId: string; issueNumber: number; reason?: string; dispute: DisputeTaskStatus | null },
  _mode: OutputMode,
  scope: { sessionsPath?: string; dbPath?: string } = {},
): string {
  if (payload.reason === "not_found") {
    return `No task found for issue #${payload.issueNumber} in session ${payload.sessionId}.`;
  }
  if (payload.dispute === null) {
    return (
      `No review-dispute state for issue #${payload.issueNumber} (session ${payload.sessionId}).\n` +
      `The task carries no reviewDispute block — either the session has not enabled the protocol ` +
      `(session.reviewDispute.enabled defaults to false) or no structured review has run for it yet.`
    );
  }
  return [
    `Review dispute — issue #${payload.issueNumber} (session ${payload.sessionId}):`,
    ...renderDisputeLines(payload.dispute, "  "),
    ...(payload.dispute.reopenEligibleLineageIds.length > 0
      ? [
          `  §6.4 reopen request available for: ${payload.dispute.reopenEligibleLineageIds.join(", ")}`,
          `    ${formatAdminCommand(
            disputeReopenArgv({
              sessionId: payload.sessionId,
              issueNumber: payload.issueNumber,
              lineageId: payload.dispute.reopenEligibleLineageIds[0],
              version:
                payload.dispute.lineages.find(
                  (l) => l.lineageId === payload.dispute!.reopenEligibleLineageIds[0],
                )?.version ?? 1,
              dbPath: scope.dbPath,
              sessionsPath: scope.sessionsPath,
            }),
          )}`,
        ]
      : []),
  ].join("\n");
}

async function runDisputeStatus(argv: string[]): Promise<void> {
  const parsed = parseDisputeStatusArgs(argv);
  if ("error" in parsed) die(parsed.error);
  const { sessionId, issueNumber, sessionsPath, dbPath } = parsed;

  // Placeholders, not the values themselves: the flags belong in the suggested
  // command (see `renderDisputeStatus`), the local paths do not — and they stay
  // out of the `--json` payload for the same reason.
  const scope = {
    sessionsPath: sessionsPath !== DEFAULT_SESSIONS_PATH ? "<SESSIONS_PATH>" : undefined,
    dbPath: dbPath !== undefined && dbPath !== DEFAULT_DB_PATH ? "<DB_PATH>" : undefined,
  };

  const store = new SqliteTaskStore(dbPath);
  try {
    const task = await store.getTask({ sessionId, issueNumber });
    if (!task) {
      const result = { ok: false, sessionId, issueNumber, reason: "not_found", dispute: null };
      report(result, (mode) => renderDisputeStatus(result, mode, scope));
      process.exitCode = 1;
      return;
    }
    const dispute = summarizeDisputeStatus(task, await store.listEvents({ sessionId, issueNumber }));
    const result = { ok: true, sessionId, issueNumber, taskStatus: task.status, phase: task.phase, dispute };
    report(result, (mode) => renderDisputeStatus(result, mode, scope));
  } finally {
    store.close();
  }
}

interface DisputeReopenArgs {
  sessionId: string;
  issueNumber: number;
  lineageId: string;
  version: number;
  sessionsPath: string;
  dbPath: string | undefined;
  yes: boolean;
}

function parseDisputeReopenArgs(argv: string[]): DisputeReopenArgs | { error: string } {
  const opts = parseCommonOptions(argv, {
    session: "required",
    issueNumber: "required",
    booleanFlags: ["yes"],
    valueFlags: ["lineage-id", "version"],
  });
  if ("error" in opts) return { error: opts.error };

  const lineageId = opts.args["lineage-id"];
  if (lineageId === undefined) return { error: "--lineage-id is required" };
  // Validated against the minting rule rather than merely non-empty: a lineage
  // id is the only operator-supplied value that is interpolated into a §10.2
  // artifact name elsewhere, and accepting an arbitrary string here would be the
  // one place a path could be smuggled into that.
  if (!isLineageId(lineageId)) {
    return { error: `--lineage-id must be a runner-minted lineage id (e.g. ln-0123456789ab), got: ${lineageId}` };
  }
  const rawVersion = opts.args["version"];
  if (rawVersion === undefined) return { error: "--version is required" };
  const version = Number(rawVersion);
  if (!Number.isInteger(version) || version <= 0) {
    return { error: `--version must be a positive integer, got: ${rawVersion}` };
  }

  return {
    sessionId: opts.sessionId,
    issueNumber: opts.issueNumber!,
    lineageId,
    version,
    sessionsPath: opts.sessionsPath,
    dbPath: opts.dbPath,
    yes: opts.flags.has("yes"),
  };
}

function renderDisputeReopen(
  payload: {
    ok: boolean;
    sessionId: string;
    issueNumber: number;
    lineageId: string;
    version: number;
    reason?: string;
    detail?: string;
    wouldRecord?: boolean;
    recorded?: boolean;
    taskStatus?: string;
    lineageState?: string;
  },
  _mode: OutputMode,
): string {
  const scope = `lineage ${payload.lineageId} v${payload.version} (issue #${payload.issueNumber}, session ${payload.sessionId})`;
  if (payload.reason !== undefined) {
    return [`Refusing to record a §6.4 reopen request for ${scope}.`, `  ${payload.detail ?? payload.reason}`].join("\n");
  }
  if (payload.wouldRecord) {
    return [
      `Preview: would record a §6.4 reopen request on ${scope}.`,
      `  Current lineage state: ${payload.lineageState} (unchanged by this action — terminal states are immutable).`,
      `  Effect: the task parks at ready_for_human under §7.1 rule 1 so a human decides. No counter is spent,`,
      `          no cap is bypassed, and no public comment is posted (§11 publishes resolutions, not requests).`,
      `Run with --yes to apply.`,
    ].join("\n");
  }
  if (payload.recorded) {
    return [
      `Recorded a §6.4 reopen request on ${scope}.`,
      `  Task status is now ready_for_human; the lineage keeps state ${payload.lineageState}.`,
    ].join("\n");
  }
  return `Unexpected state for ${scope}.`;
}

async function runDisputeReopen(argv: string[]): Promise<void> {
  const parsed = parseDisputeReopenArgs(argv);
  if ("error" in parsed) die(parsed.error);
  const { sessionId, issueNumber, lineageId, version, sessionsPath, dbPath, yes } = parsed;

  // The session supplies the §6.1 limits the applicator validates the stored
  // block against. A session that is not in the registry is a hard error rather
  // than a default-limits fallback: validating a lowered-limit block against the
  // normative maxima would accept counters that session could never have
  // produced.
  let registry: JsonSessionRegistry;
  try {
    registry = new JsonSessionRegistry(sessionsPath);
  } catch (err) {
    die(`Failed to load sessions file (${sessionsPath}): ${err instanceof Error ? err.message : String(err)}`);
  }
  const session = await registry.getSessionById(sessionId);
  if (!session) die(describeUnresolvedSessionId(registry, sessionId, sessionsPath));
  const settings = resolveReviewDisputeSettings(session.reviewDispute);
  if (!settings.ok) {
    die(
      `Session ${sessionId} has an invalid reviewDispute configuration; fix it before acting on protocol state: ` +
        settings.errors.map((e) => e.message).join("; "),
    );
  }

  const refuse = (
    reason: string,
    detail: string,
    extra: { taskStatus?: string; lineageState?: string } = {},
  ): void => {
    const result = { ok: false, sessionId, issueNumber, lineageId, version, reason, detail, ...extra };
    report(result, (mode) => renderDisputeReopen(result, mode));
    process.exitCode = 1;
  };

  // A session with `reviewDispute.enabled: false` runs the legacy flow and
  // ignores structured dispute state entirely, so a block left on an older task
  // by a previously-enabled session is inert history, not live protocol state.
  // Writing to it here would move the task to `ready_for_human` and record a
  // §6.4 request that nothing in this session can ever act on — and the
  // publication path already refuses to publish for a disabled session, so the
  // resulting state would be invisible as well as unreachable. Refuse before
  // opening the store: a disabled session should not be reading protocol state
  // to decide anything.
  if (!settings.settings.enabled) {
    refuse(
      "protocol_disabled",
      `Session ${sessionId} has reviewDispute.enabled: false, so it runs the legacy review flow and ignores ` +
        `any structured dispute state left on its tasks. Re-enable the protocol for this session before acting ` +
        `on protocol state, or use \`admin recover\` for an ordinary handoff.`,
    );
    return;
  }

  const now = new Date().toISOString();
  const store = new SqliteTaskStore(dbPath);

  try {
    const task = await store.getTask({ sessionId, issueNumber });
    if (!task) {
      refuse("not_found", `No task found for issue #${issueNumber} in session ${sessionId}.`);
      return;
    }
    // A claimed/running task has a live run that may be applying its own
    // transition against the same block. Writing here would either lose the CAS
    // below or land between that run's read and its write, so refuse before
    // either can happen.
    if (task.status === "claimed" || task.status === "running") {
      refuse(
        "active_task",
        `Task is ${task.status}${task.ownerRunId ? ` (owner: ${task.ownerRunId})` : ""}; a run may be applying its ` +
          `own transition to the same lineage. Wait for it to finish or recover the task first.`,
        { taskStatus: task.status },
      );
      return;
    }

    const rawBlock = task.context?.[REVIEW_DISPUTE_CONTEXT_KEY];
    if (rawBlock === undefined) {
      refuse(
        "no_dispute_state",
        `Task carries no reviewDispute block. There is no protocol state to act on; ` +
          `use \`admin recover\` for an ordinary handoff.`,
        { taskStatus: task.status },
      );
      return;
    }
    const validated = validateReviewDisputeContext(rawBlock, "reviewDispute", settings.settings.limits);
    if (!validated.ok) {
      refuse(
        "invalid_block",
        `The stored reviewDispute block is not one this session's §6.1 limits could have produced ` +
          `(${disputeFailureText(validated.failure)}); refusing to write against it. ` +
          `Inspect it with \`admin dispute status\`.`,
        { taskStatus: task.status },
      );
      return;
    }

    const lineage = Object.prototype.hasOwnProperty.call(validated.value.lineages, lineageId)
      ? validated.value.lineages[lineageId]
      : undefined;
    if (lineage === undefined) {
      refuse("unknown_lineage", `Task has no lineage ${lineageId}. Run \`admin dispute status\` to list them.`, {
        taskStatus: task.status,
      });
      return;
    }
    // Exact-version CAS, checked here as well as inside the transaction: an
    // operator naming a version the reviewer has since revised is acting on a
    // finding that no longer exists, and the preview must refuse it for the same
    // reason the write would.
    if (lineage.version !== version) {
      refuse(
        "stale_version",
        `Lineage ${lineageId} is at version ${lineage.version}, not ${version}. Re-read the current state ` +
          `with \`admin dispute status\` before acting — a newer version means the finding was revised.`,
        { taskStatus: task.status, lineageState: lineage.state },
      );
      return;
    }
    if (!isTerminalLineageState(lineage.state)) {
      refuse(
        "not_terminal",
        `§6.4 applies only to a terminal lineage; ${lineageId} is \`${lineage.state}\` and the debate is still ` +
          `running. Nothing to reopen.`,
        { taskStatus: task.status, lineageState: lineage.state },
      );
      return;
    }
    // `escalated_human` is terminal but is NOT a resolution: §6.4 lets a human
    // ask for a RESOLUTION to be revisited, and an escalated lineage is already
    // with a human. Recording the flag here would re-escalate what is already
    // escalated — a second §7.1 rule 1 park and an audit event that says a
    // decision was requested when none was made — so it is refused rather than
    // applied. `summarizeDisputeStatus` reaches the same answer (it never lists
    // an escalated lineage as reopen-eligible, and reports
    // `lineage_escalated_human` as a stop reason with no authorized action);
    // this keeps the command from accepting what the status surface says is
    // unavailable. The way out of an escalation is the human decision on the PR
    // itself — the contract defines no transition back into automation (§15/G1).
    if (lineage.state === "escalated_human") {
      refuse(
        "escalated_lineage",
        `§6.4 applies to a RESOLVED lineage; ${lineageId} is \`escalated_human\` and is already with a human. ` +
          `Recording a reopen request would not change its state or authorize any automated continuation — the ` +
          `contract defines no transition that returns an escalated lineage to the debate (§15/G1). Decide it on ` +
          `the PR; \`admin dispute status\` shows the exact stop reason and the lineage record behind it.`,
        { taskStatus: task.status, lineageState: lineage.state },
      );
      return;
    }
    if (lineage.reopenRequested === true) {
      // Already on file: an informative no-op that exits 0, per the admin CLI
      // contract's treatment of safe no-ops.
      const result = {
        ok: true,
        sessionId,
        issueNumber,
        lineageId,
        version,
        recorded: false,
        alreadyRequested: true,
        taskStatus: task.status,
        lineageState: lineage.state,
      };
      report(result, () =>
        `A §6.4 reopen request is already recorded on lineage ${lineageId} v${version} ` +
        `(issue #${issueNumber}, session ${sessionId}); nothing to do.`,
      );
      return;
    }

    if (!yes) {
      const result = {
        ok: true,
        sessionId,
        issueNumber,
        lineageId,
        version,
        wouldRecord: true,
        taskStatus: task.status,
        lineageState: lineage.state,
      };
      report(result, (mode) => renderDisputeReopen(result, mode));
      return;
    }

    // The run id is derived from the lineage and version rather than minted
    // fresh, so a re-run of this exact command produces the SAME `<lineageId>@
    // <version>#<runId>` digest and is recognized as the replay it is. (The flag
    // check above already makes it idempotent; this makes the ledger agree.)
    const runId = `admin-dispute-reopen-${lineageId}-v${version}`;
    const application = applyDisputeTransition({
      context: validated.value,
      decision: { kind: "reopen_request", lineageId },
      run: { runId, actor: "runner" },
      limits: settings.settings.limits,
    });
    if (!application.ok) {
      refuse(
        "transition_refused",
        `The transition layer refused the request (${disputeFailureText(application.failure)}).`,
        { taskStatus: task.status, lineageState: lineage.state },
      );
      return;
    }
    if (application.value.refused.length > 0) {
      const first = application.value.refused[0];
      refuse(
        "transition_refused",
        `The transition layer refused the request for ${first.lineageId} (${disputeFailureText(first.failure)}).`,
        { taskStatus: task.status, lineageState: lineage.state },
      );
      return;
    }

    const committed = await commitDisputeTransition({
      store,
      key: { sessionId, issueNumber },
      // The CAS guard. `revision` is what makes it exact: it moves on every write,
      // so any write to this task between the read above and this call — a
      // competing operator, a run that claimed it, a cancellation — loses the
      // completion rather than overwriting newer state. `updatedAt` alone is not
      // enough: two reopens racing on a `ready_for_human` task leave status and
      // phase unchanged and can share a millisecond timestamp, which would let the
      // stale second write through to duplicate the transition and audit events.
      expected: {
        status: task.status,
        phase: task.phase,
        updatedAt: task.updatedAt,
        revision: task.revision,
      },
      application: application.value,
      runId,
      now,
      // A bounded operator audit record alongside the mandatory §10.3 transition
      // event: literals and counts only, and no operator prose field exists to
      // carry a free-form human verdict (§15/G1 — the contract defines none).
      extraEvents: [
        {
          task: { sessionId, issueNumber },
          type: "review.dispute.operator",
          runId,
          data: {
            action: "reopen_request",
            lineageId,
            version,
            lineageState: lineage.state,
            taskStatusBefore: task.status,
          },
          createdAt: now,
        },
      ],
      // No effects: §11 publishes resolutions and escalations, and a reopen
      // REQUEST is neither — the lineage keeps the terminal state it was already
      // published under. `publishableDisputeOutcomes` reaches the same answer for
      // the phase-runner path; stating it here keeps the two from drifting.
      effects: [],
    });

    if (committed.status === "duplicate") {
      const result = {
        ok: true,
        sessionId,
        issueNumber,
        lineageId,
        version,
        recorded: false,
        alreadyRequested: true,
        taskStatus: task.status,
        lineageState: lineage.state,
      };
      report(result, () =>
        `A §6.4 reopen request is already recorded on lineage ${lineageId} v${version} ` +
        `(issue #${issueNumber}, session ${sessionId}); nothing to do.`,
      );
      return;
    }
    if (committed.status === "maintenance_locked") {
      refuse(
        "maintenance_locked",
        `The database is under a maintenance lock; nothing was written. Retry once maintenance completes.`,
        { taskStatus: task.status, lineageState: lineage.state },
      );
      return;
    }
    if (committed.status === "claim_lost") {
      refuse(
        "stale_task",
        `The task changed between reading it and writing (now ${committed.current?.status ?? "unknown"}); ` +
          `nothing was written. Re-read it with \`admin dispute status\` and retry.`,
        { taskStatus: committed.current?.status, lineageState: lineage.state },
      );
      return;
    }

    const result = {
      ok: true,
      sessionId,
      issueNumber,
      lineageId,
      version,
      recorded: true,
      taskStatus: committed.task.status,
      lineageState: lineage.state,
    };
    report(result, (mode) => renderDisputeReopen(result, mode));
  } finally {
    store.close();
  }
}

// ---------------------------------------------------------------------------
// Subcommand: dispute metrics (issue #849)
//
// The read-only operator report over the protocol's own audit events. It is a
// sibling of `dispute status`, not a replacement: status answers "what is this
// ONE task waiting on", metrics answers "what did the protocol DO across this
// session". Both read persisted state only — no GitHub call, no §10.2 artifact,
// no public comment — and neither writes anything.
//
// Everything countable is decided in `core/review-dispute-metrics.ts`. This
// layer resolves the session's tasks, hands their event streams over, and
// renders. That split is what keeps the report testable without a CLI and
// deterministic with one.
// ---------------------------------------------------------------------------

interface DisputeMetricsArgs {
  sessionId: string;
  issueNumber: number | undefined;
  since: string | undefined;
  until: string | undefined;
  dbPath: string | undefined;
}

/**
 * ISO-8601 with an explicit UTC `Z`, which is what the stores write and what
 * the string comparison in the aggregator assumes. A local-time or offset form
 * is REFUSED rather than silently converted: an operator who passes
 * `2026-08-01T00:00+09:00` and gets a UTC-shifted window back has been given a
 * wrong answer that looks right.
 */
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

function parseWindowBound(flag: string, raw: string | undefined): { value: string | undefined } | { error: string } {
  if (raw === undefined) return { value: undefined };
  const parsed = Date.parse(raw);
  if (!ISO_UTC_RE.test(raw) || Number.isNaN(parsed)) {
    return {
      error:
        `${flag} must be an ISO-8601 UTC timestamp ending in Z, e.g. 2026-08-01T00:00:00Z, got: ${raw}`,
    };
  }
  const normalized = new Date(parsed).toISOString();
  // A date that is well-formed but does not exist — `2026-02-31T00:00:00Z` — is
  // not rejected by `Date.parse`: it rolls the overflow forward to March 3 and
  // would hand the operator a report for a window they never asked for. Round
  // the parse back to a string and require it to name the same calendar
  // instant. `toISOString` always renders a 4-digit year here because the regex
  // above admits nothing else, so the seconds-precision prefixes are comparable.
  if (normalized.slice(0, 19) !== raw.slice(0, 19)) {
    return {
      error:
        `${flag} is not a real calendar date: ${raw} would be read as ${normalized}`,
    };
  }
  // Normalized to the store's own millisecond form before it is compared. The
  // aggregator compares timestamps as strings, and `2026-08-04T00:00:00Z` sorts
  // BELOW `2026-08-04T00:00:00.000Z` ('.' < 'Z') — so an un-normalized bound
  // would silently exclude an event that landed on exactly that second.
  return { value: normalized };
}

function parseDisputeMetricsArgs(argv: string[]): DisputeMetricsArgs | { error: string } {
  const opts = parseCommonOptions(argv, {
    session: "required",
    issueNumber: "optional",
    valueFlags: ["since", "until"],
  });
  if ("error" in opts) return { error: opts.error };

  const since = parseWindowBound("--since", opts.args["since"]);
  if ("error" in since) return { error: since.error };
  const until = parseWindowBound("--until", opts.args["until"]);
  if ("error" in until) return { error: until.error };
  if (since.value !== undefined && until.value !== undefined && since.value > until.value) {
    return { error: `--since (${since.value}) must not be later than --until (${until.value})` };
  }

  return {
    sessionId: opts.sessionId,
    issueNumber: opts.issueNumber,
    since: since.value,
    until: until.value,
    dbPath: opts.dbPath,
  };
}

/**
 * The human rendering.
 *
 * Grouped the way the lifecycle runs — findings, then the debate, then how it
 * ended — rather than alphabetically, so an operator reading top to bottom sees
 * the protocol's shape. Zero-valued lines are kept: "0 escalations" is the
 * answer most operators are looking for, and a report that omitted it would be
 * indistinguishable from one that never looked.
 */
function renderDisputeMetrics(
  payload: { sessionId: string; issueNumber: number | undefined; metrics: DisputeMetrics },
  _mode: OutputMode,
): string {
  const m = payload.metrics;
  const scope = payload.issueNumber === undefined
    ? `session ${payload.sessionId}`
    : `session ${payload.sessionId}, issue #${payload.issueNumber}`;
  const window = m.window.from === null && m.window.to === null
    ? "all recorded events"
    : `${m.window.from ?? "(open)"} .. ${m.window.to ?? "(open)"}`;

  const lines = [
    `Review-dispute metrics — ${scope}`,
    `  window: ${window}`,
    `  tasks scanned: ${m.tasksScanned}  with dispute activity: ${m.tasksWithDisputeActivity}`,
    `  transition events: ${m.transitionEvents}  applied: ${m.transitionsApplied}` +
      `  deduplicated: ${m.transitionsDeduplicated}  refused: ${m.decisionsRefused}` +
      `  operational failures: ${m.operationalFailures}`,
    `  findings opened: ${m.findingsOpened}`,
    `  rebuttals: recorded=${m.rebuttalsRecorded} rejected=${m.rebuttalsRejected}`,
    `  reconsiderations: ${m.reconsiderations}`,
    `  revisions: material=${m.revisions.material} non-material=${m.revisions.nonMaterial}` +
      ` ambiguous=${m.revisions.ambiguous}`,
    `  arbitration: verdicts=${m.arbitration.verdicts} malformed=${m.arbitration.malformedAttempts}`,
    `  evidence rounds: requested=${m.evidence.requested} recorded=${m.evidence.recorded}`,
    `  terminal outcomes:`,
  ];
  for (const [outcome, count] of Object.entries(m.terminalOutcomes)) {
    lines.push(`    ${outcome}: ${count}`);
  }
  lines.push(
    `  human escalations: ${m.humanEscalations}  §6.4 reopen requests: ${m.reopenRequests}`,
    `  lineages reaching a terminal state: ${m.lineagesReachedTerminal}`,
    `  lineagesResolvedWithoutHuman: ${m.lineagesResolvedWithoutHuman}` +
      `  tasksResolvedWithoutHuman: ${m.tasksResolvedWithoutHuman}` +
      `  tasksEscalatedToHuman: ${m.tasksEscalatedToHuman}`,
    // Said in the output, not only in the docs: this number is what was
    // observed in the window, never a claim about a loop that did not happen.
    `    (observed in this window; not a claim about review loops that would otherwise have run)`,
  );
  if (m.transitionEvents === 0) {
    lines.push(
      `  No ${REVIEW_DISPUTE_TRANSITION_EVENT} events in scope. Either the session has not enabled the`,
      `  protocol (session.reviewDispute.enabled defaults to false), no structured review has run, or the`,
      `  window excludes every recorded transition.`,
    );
  }
  return lines.join("\n");
}

async function runDisputeMetrics(argv: string[]): Promise<void> {
  const parsed = parseDisputeMetricsArgs(argv);
  if ("error" in parsed) die(parsed.error);
  const { sessionId, issueNumber, since, until, dbPath } = parsed;

  const store = new SqliteTaskStore(dbPath);
  try {
    // One task or the whole session, read through the ordinary store ports. A
    // task with no dispute block contributes zero events and still counts
    // towards `tasksScanned`, which is the denominator an operator needs.
    let tasks;
    if (issueNumber === undefined) {
      tasks = await store.listSessionTasks(sessionId);
    } else {
      const one = await store.getTask({ sessionId, issueNumber });
      tasks = one ? [one] : [];
    }
    // One read for the whole session, then grouped by issue in memory (issue
    // #849 review). Reading per task meant one events query per task; for a
    // session-wide report that is O(tasks x events) of work in a command whose
    // whole job is to be a cheap read. The aggregator folds exactly one event
    // type, so the filter belongs in the query rather than in the fold.
    const events = issueNumber === undefined
      ? await store.listSessionEventsByType(sessionId, REVIEW_DISPUTE_TRANSITION_EVENT)
      : await store.listEvents({ sessionId, issueNumber });
    const byIssue = new Map<number, typeof events>();
    for (const event of events) {
      const bucket = byIssue.get(event.task.issueNumber);
      if (bucket) bucket.push(event);
      else byIssue.set(event.task.issueNumber, [event]);
    }
    // Every scanned task appears, including one with no events at all: the
    // report's denominator is tasks scanned, not tasks that had activity.
    const withEvents = tasks.map((task) => ({
      issueNumber: task.issueNumber,
      events: byIssue.get(task.issueNumber) ?? [],
    }));
    // Sorted by issue number so two runs over the same data produce byte-identical
    // output regardless of the order the store happened to return rows in.
    withEvents.sort((a, b) => a.issueNumber - b.issueNumber);

    const metrics = aggregateDisputeMetrics({
      sessionId,
      tasks: withEvents,
      window: { from: since, to: until },
    });
    const result = {
      ok: true,
      sessionId,
      ...(issueNumber === undefined ? {} : { issueNumber }),
      metrics,
    };
    report(result, (mode) => renderDisputeMetrics({ sessionId, issueNumber, metrics }, mode));
  } finally {
    store.close();
  }
}

// ---------------------------------------------------------------------------
// Subcommand: task clear-delay (issue #584)
//
// Clear the not_before delay on a queued task so it becomes immediately
// eligible for the next worker run. Preview by default; require --yes for
// the actual mutation. Refuses non-queued (active/stale/done) tasks.
// Human-readable by default; --json for machine output.
// ---------------------------------------------------------------------------

interface TaskClearDelayArgs {
  sessionId: string;
  issueNumber: number;
  dbPath: string | undefined;
  yes: boolean;
}

function parseTaskClearDelayArgs(argv: string[]): TaskClearDelayArgs | { error: string } {
  const opts = parseCommonOptions(argv, {
    session: "required",
    issueNumber: "required",
    booleanFlags: ["yes"],
  });
  if ("error" in opts) return { error: opts.error };
  return {
    sessionId: opts.sessionId,
    issueNumber: opts.issueNumber!,
    dbPath: opts.dbPath,
    yes: opts.flags.has("yes"),
  };
}

function renderTaskClearDelay(
  payload: {
    ok: boolean;
    sessionId: string;
    issueNumber: number;
    cleared?: boolean;
    wouldClear?: boolean;
    previousNotBefore?: string | null;
    taskStatus?: string;
    reason?: string;
    hint?: string;
  },
  _mode: OutputMode,
): string {
  const { sessionId, issueNumber, cleared, wouldClear, previousNotBefore, taskStatus, reason, hint } = payload;

  if (reason === "not_found") {
    return `No task found for issue #${issueNumber} in session ${sessionId}.`;
  }

  if (reason === "active_task") {
    const lines = [
      `Refusing: task for issue #${issueNumber} (session ${sessionId}) is not queued (status: ${taskStatus ?? "unknown"}).`,
      `Only queued tasks can have their delay cleared.`,
    ];
    if (hint) lines.push(`Hint: ${hint}`);
    return lines.join("\n");
  }

  if (reason === "already_clear") {
    return `No delay set for issue #${issueNumber} (session ${sessionId}); nothing to clear.`;
  }

  if (wouldClear) {
    return [
      `Preview: would clear retry delay for issue #${issueNumber} (session ${sessionId}):`,
      `  Delay until: ${previousNotBefore}`,
      `Run with --yes to apply.`,
    ].join("\n");
  }

  if (cleared) {
    return `Cleared retry delay for issue #${issueNumber} (session ${sessionId}); task is now immediately runnable.`;
  }

  return `Unexpected state for issue #${issueNumber} (session ${sessionId}).`;
}

async function runTaskClearDelay(argv: string[]): Promise<void> {
  const parsed = parseTaskClearDelayArgs(argv);
  if ("error" in parsed) die(parsed.error);

  const { sessionId, issueNumber, dbPath, yes } = parsed;

  const store = new SqliteTaskStore(dbPath);
  try {
    const task = await store.getTask({ sessionId, issueNumber });

    if (!task) {
      const result = { ok: false, sessionId, issueNumber, reason: "not_found" };
      report(result, (mode) => renderTaskClearDelay(result, mode));
      process.exitCode = 1;
      return;
    }

    if (task.status !== "queued") {
      const result = {
        ok: false,
        sessionId,
        issueNumber,
        reason: "active_task",
        taskStatus: task.status,
        hint: `Wait for the task to complete or use 'admin recover' if it is stuck.`,
      };
      report(result, (mode) => renderTaskClearDelay(result, mode));
      process.exitCode = 1;
      return;
    }

    if (!task.notBefore) {
      const result = {
        ok: true,
        sessionId,
        issueNumber,
        cleared: false,
        reason: "already_clear",
        previousNotBefore: null,
      };
      report(result, (mode) => renderTaskClearDelay(result, mode));
      return;
    }

    if (!yes) {
      const result = {
        ok: true,
        sessionId,
        issueNumber,
        cleared: false,
        wouldClear: true,
        previousNotBefore: task.notBefore,
      };
      report(result, (mode) => renderTaskClearDelay(result, mode));
      return;
    }

    const storeResult = await store.clearTaskDelay({ sessionId, issueNumber });
    if (!storeResult.ok) {
      if (storeResult.code === "not_found") {
        die(`No task found for issue #${issueNumber} in session ${sessionId}.`);
      }
      die(
        `Could not clear delay: task for issue #${issueNumber} is no longer queued` +
          (storeResult.current ? ` (status: ${storeResult.current.status})` : "") +
          `. Inspect with 'admin task-status --session-id ${sessionId} --issue-number ${issueNumber}' and retry.`,
      );
    }

    const result = {
      ok: true,
      sessionId,
      issueNumber,
      cleared: true,
      previousNotBefore: task.notBefore,
      notBefore: storeResult.value.notBefore ?? null,
    };
    report(result, (mode) => renderTaskClearDelay(result, mode));
  } finally {
    store.close();
  }
}

// ---------------------------------------------------------------------------
// Subcommand: task cancel (issue #608)
//
// First-class, terminal task cancellation with session/issue selection.
// Available from any non-terminal status (queued, claimed, running, blocked,
// ready_for_human); refuses a task already `cancelled` (informative no-op,
// not an error) or one that reached a different terminal status (done/failed
// — finished work is not retroactively cancellable). Preview by default;
// --yes required to mutate.
//
// A claimed/running task is NOT force-stopped: TaskStore.cancelTask flips
// `status` to `cancelled` and the active run's own eventual completion
// transition then loses its CAS and safely no-ops as `claim_lost` — the
// preview surfaces this so an operator cancelling a live run understands it
// takes effect at the run's next safe phase boundary rather than immediately.
//
// A bounded, path-safe comment is posted to the backing work item so the
// cancellation is operator-visible without leaking local paths (issue #608
// scope). No label mutation is performed: cancellation is a local
// orchestration decision and must never look like a GitHub Issue Relationship
// signal (a `not_planned` blocker must not become "satisfied" merely because
// its dependent's local task was cancelled — dependency-plan.ts/github-
// intake.ts read GitHub issue state only, never local task status, so this
// holds automatically as long as no label is touched here).
// ---------------------------------------------------------------------------

interface TaskCancelArgs {
  sessionId: string;
  issueNumber: number;
  cancelReason: string | undefined;
  sessionsPath: string;
  dbPath: string | undefined;
  yes: boolean;
}

function parseTaskCancelArgs(argv: string[]): TaskCancelArgs | { error: string } {
  const opts = parseCommonOptions(argv, {
    session: "required",
    issueNumber: "required",
    booleanFlags: ["yes"],
    valueFlags: ["reason"],
  });
  if ("error" in opts) return { error: opts.error };
  return {
    sessionId: opts.sessionId,
    issueNumber: opts.issueNumber!,
    cancelReason: opts.args["reason"],
    sessionsPath: opts.sessionsPath,
    dbPath: opts.dbPath,
    yes: opts.flags.has("yes"),
  };
}

function renderTaskCancel(
  payload: {
    ok: boolean;
    sessionId: string;
    issueNumber: number;
    reasonCode?: string;
    taskStatus?: string;
    ownerRunId?: string;
    cancelled?: boolean;
    wouldCancel?: boolean;
  },
  _mode: OutputMode,
): string {
  const { sessionId, issueNumber, reasonCode, taskStatus, ownerRunId, cancelled, wouldCancel } = payload;

  if (reasonCode === "not_found") {
    return `No task found for issue #${issueNumber} in session ${sessionId}.`;
  }
  if (reasonCode === "already_cancelled") {
    return `Task for issue #${issueNumber} (session ${sessionId}) is already cancelled; nothing to do.`;
  }
  if (reasonCode === "maintenance_locked") {
    return (
      `Refusing: a maintenance lock is held on this database, so cancelling issue #${issueNumber} ` +
      `(session ${sessionId}) would have written its cancellation comment into a database under ` +
      `maintenance. Nothing was changed — re-run once \`admin maintenance-lock status\` reports the ` +
      `lock released.`
    );
  }
  if (reasonCode === "terminal") {
    return (
      `Refusing: task for issue #${issueNumber} (session ${sessionId}) already reached a terminal ` +
      `status (${taskStatus}) and cannot be cancelled.`
    );
  }
  if (wouldCancel) {
    const lines = [
      `Preview: would cancel task for issue #${issueNumber} (session ${sessionId}):`,
      `  Current status: ${taskStatus}`,
    ];
    if (taskStatus === "claimed" || taskStatus === "running") {
      lines.push(
        `  This task is currently ${taskStatus}${ownerRunId ? ` (owner: ${ownerRunId})` : ""}. Cancellation ` +
          `will NOT force-stop the active run; it takes effect at the run's next safe phase boundary.`,
      );
    }
    lines.push(`Run with --yes to apply.`);
    return lines.join("\n");
  }
  if (cancelled) {
    return `Cancelled task for issue #${issueNumber} (session ${sessionId}) (previous status: ${taskStatus}).`;
  }
  return `Unexpected state for issue #${issueNumber} (session ${sessionId}).`;
}

async function runTaskCancel(argv: string[]): Promise<void> {
  const parsed = parseTaskCancelArgs(argv);
  if ("error" in parsed) die(parsed.error);
  const { sessionId, issueNumber, cancelReason, sessionsPath, dbPath, yes } = parsed;

  let registry: JsonSessionRegistry;
  try {
    registry = new JsonSessionRegistry(sessionsPath);
  } catch (err) {
    die(`Failed to load sessions file (${sessionsPath}): ${err instanceof Error ? err.message : String(err)}`);
  }
  const session = await registry.getSessionById(sessionId);
  if (!session) {
    die(describeUnresolvedSessionId(registry, sessionId, sessionsPath));
  }

  const store = new SqliteTaskStore(dbPath);
  try {
    const task = await store.getTask({ sessionId, issueNumber });
    if (!task) {
      const result = { ok: false, sessionId, issueNumber, reasonCode: "not_found" };
      report(result, (mode) => renderTaskCancel(result, mode));
      process.exitCode = 1;
      return;
    }

    if (task.status === "cancelled") {
      const result = { ok: false, sessionId, issueNumber, reasonCode: "already_cancelled", taskStatus: task.status };
      report(result, (mode) => renderTaskCancel(result, mode));
      process.exitCode = 1;
      return;
    }
    if (task.status === "done" || task.status === "failed") {
      const result = { ok: false, sessionId, issueNumber, reasonCode: "terminal", taskStatus: task.status };
      report(result, (mode) => renderTaskCancel(result, mode));
      process.exitCode = 1;
      return;
    }

    if (!yes) {
      const result = {
        ok: true,
        sessionId,
        issueNumber,
        wouldCancel: true,
        taskStatus: task.status,
        ...(task.ownerRunId ? { ownerRunId: task.ownerRunId } : {}),
      };
      report(result, (mode) => renderTaskCancel(result, mode));
      return;
    }

    const now = new Date().toISOString();
    const runId = `admin-task-cancel-${now}`;

    // Bounded, path-safe operator-visible comment (issue #608). No label
    // mutation — see the header comment above for why. The operator-provided
    // `--reason` is unbounded input; excerpt it before embedding so a very
    // large reason can't produce a comment that exceeds the provider's limit
    // (issue #608 review, P2).
    let commentBody =
      `🛑 **Task cancelled by operator.**\n\n` +
      `Previous status: \`${task.status}\` (phase: \`${task.phase}\`).`;
    if (cancelReason) commentBody += `\n\nReason: ${boundedExcerpt(cancelReason, 500)}`;
    commentBody = sanitizeBody(commentBody, sessionRedactionPaths(session));
    const effectCollector = new OutboxEffectCollector();
    await workItemOutbox(effectCollector, session).enqueue({
      idempotencyKey: makeOutboxKey(sessionId, issueNumber, runId, "gh:comment", "task-cancel"),
      topic: "gh:comment",
      payload: {
        topic: "gh:comment",
        owner: session.githubOwner,
        repo: session.githubName,
        issueNumber,
        body: commentBody,
      },
      now,
    });

    // Transition, event, and comment commit atomically (issue #608 review,
    // P2): a crash or failed write between them must never leave the task
    // cancelled with no event/comment, and a retry after such a gap would
    // otherwise no-op as `already_cancelled` and never repair it.
    const storeResult = await store.cancelTaskWithEffects(
      { sessionId, issueNumber },
      { reason: cancelReason, now },
      {
        task: { sessionId, issueNumber },
        type: "task.cancelled",
        runId,
        message: cancelReason,
        data: { previousStatus: task.status, previousPhase: task.phase },
        createdAt: now,
      },
      effectCollector.effects,
    );
    if (!storeResult.ok) {
      // A concurrent transition landed between our read above and now (a raced
      // claim/requeue/completion, or a repeated cancellation) — report the
      // now-current state deterministically rather than crashing.
      if (storeResult.code === "already_cancelled") {
        const result = {
          ok: false,
          sessionId,
          issueNumber,
          reasonCode: "already_cancelled",
          taskStatus: storeResult.current?.status,
        };
        report(result, (mode) => renderTaskCancel(result, mode));
        process.exitCode = 1;
        return;
      }
      // Maintenance contention (issue #818): the whole call — transition, event,
      // and the cancellation comment — was refused, so the task is untouched and
      // re-running this command once the lock clears cancels cleanly. Reported as
      // its own reason code rather than the terminal-status die() below, which
      // would claim a task state that is not what actually happened.
      if (storeResult.code === "maintenance_locked") {
        const result = {
          ok: false,
          sessionId,
          issueNumber,
          reasonCode: "maintenance_locked",
          taskStatus: task.status,
        };
        report(result, (mode) => renderTaskCancel(result, mode));
        process.exitCode = 1;
        return;
      }
      die(
        `Could not cancel: task for issue #${issueNumber} (session ${sessionId}) already reached a terminal ` +
          `status` + (storeResult.current ? ` (${storeResult.current.status})` : "") + `.`,
      );
    }

    const result = { ok: true, sessionId, issueNumber, cancelled: true, taskStatus: task.status };
    report(result, (mode) => renderTaskCancel(result, mode));
  } finally {
    store.close();
  }
}

// ---------------------------------------------------------------------------
// Subcommand: task reconcile-closed (issue #608)
//
// Closed-Issue reconciliation: a queued/blocked/claimed/running/ready_for_human
// task whose backing GitHub Issue has since been closed as `not_planned` is
// cancelled so it can never be claimed/implemented later. This is the gap
// named in #608 — removing labels or closing an Issue does not by itself
// touch the SQLite task row, so without this scan `run-one-phase` could still
// claim a queued task the operator has abandoned via GitHub.
//
// GitHub-only: `not_planned` is a GitHub Issue `state_reason` with no
// equivalent on other work-item providers (mirrors the existing fail-closed
// precedent in dependency-plan.ts for non-`github-issues` sessions). Preview
// by default; --yes required to mutate. Cancelling reuses `TaskStore.cancelTask`
// (the same race-safe, safe-phase-boundary semantics as `task cancel`), so a
// task claimed/running mid-scan is not force-stopped either.
// ---------------------------------------------------------------------------

const RECONCILABLE_STATUSES: TaskStatus[] = ["queued", "claimed", "running", "blocked", "ready_for_human"];

/** Read a single GitHub Issue's close state via `gh issue view --json state,stateReason`. */
function readGithubIssueCloseState(
  githubRepo: string,
  issueNumber: number,
):
  | { ok: true; state: "open" | "closed"; stateReason: "not_planned" | "completed" | null }
  | { ok: false; error: string } {
  const probed = probe("gh", [
    "issue", "view", String(issueNumber),
    "--repo", githubRepo,
    "--json", "state,stateReason",
  ]);
  if (!probed.ok) return { ok: false, error: probed.output };

  let parsed: { state?: string; stateReason?: string | null };
  try {
    parsed = JSON.parse(probed.output);
  } catch (err) {
    return { ok: false, error: `Failed to parse gh issue view output: ${err instanceof Error ? err.message : String(err)}` };
  }

  const state: "open" | "closed" = parsed.state?.toUpperCase() === "CLOSED" ? "closed" : "open";
  let stateReason: "not_planned" | "completed" | null = null;
  if (state === "closed" && parsed.stateReason) {
    const r = parsed.stateReason.toLowerCase();
    stateReason = r === "not_planned" ? "not_planned" : r === "completed" ? "completed" : null;
  }
  return { ok: true, state, stateReason };
}

type ReconcileClosedResult =
  | { issueNumber: number; action: "would_cancel"; taskStatus: TaskStatus }
  | { issueNumber: number; action: "cancelled"; taskStatus: TaskStatus }
  | {
      issueNumber: number;
      action: "not_eligible";
      issueState: "open" | "closed";
      stateReason: "not_planned" | "completed" | null;
    }
  | { issueNumber: number; action: "check_failed"; error: string }
  | { issueNumber: number; action: "cancel_failed"; reasonCode: string };

interface TaskReconcileClosedArgs {
  sessionId: string;
  issueNumber: number | undefined;
  sessionsPath: string;
  dbPath: string | undefined;
  yes: boolean;
}

function parseTaskReconcileClosedArgs(argv: string[]): TaskReconcileClosedArgs | { error: string } {
  const opts = parseCommonOptions(argv, {
    session: "required",
    issueNumber: "optional",
    booleanFlags: ["yes"],
  });
  if ("error" in opts) return { error: opts.error };
  return {
    sessionId: opts.sessionId,
    issueNumber: opts.issueNumber,
    sessionsPath: opts.sessionsPath,
    dbPath: opts.dbPath,
    yes: opts.flags.has("yes"),
  };
}

function renderTaskReconcileClosed(
  payload: {
    ok: boolean;
    sessionId: string;
    scanned: number;
    cancelled: number;
    dryRun: boolean;
    results: ReconcileClosedResult[];
  },
  _mode: OutputMode,
): string {
  const { sessionId, scanned, cancelled, dryRun, results } = payload;
  const wouldCancel = results.filter((r) => r.action === "would_cancel").length;
  const lines = [
    `Reconcile not_planned closed issues for session ${sessionId}: scanned ${scanned}, ` +
      (dryRun ? `would cancel ${wouldCancel}.` : `cancelled ${cancelled}.`),
  ];
  for (const r of results) {
    if (r.action === "would_cancel") lines.push(`  #${r.issueNumber}: would cancel (status: ${r.taskStatus})`);
    else if (r.action === "cancelled") lines.push(`  #${r.issueNumber}: cancelled (was: ${r.taskStatus})`);
    else if (r.action === "not_eligible") {
      lines.push(`  #${r.issueNumber}: not eligible (issue state: ${r.issueState}${r.stateReason ? `/${r.stateReason}` : ""})`);
    } else if (r.action === "check_failed") lines.push(`  #${r.issueNumber}: could not check issue state (${r.error})`);
    else if (r.action === "cancel_failed") lines.push(`  #${r.issueNumber}: cancel failed (${r.reasonCode})`);
  }
  if (dryRun) lines.push(`Run with --yes to apply.`);
  return lines.join("\n");
}

async function runTaskReconcileClosed(argv: string[]): Promise<void> {
  const parsed = parseTaskReconcileClosedArgs(argv);
  if ("error" in parsed) die(parsed.error);
  const { sessionId, issueNumber, sessionsPath, dbPath, yes } = parsed;

  let registry: JsonSessionRegistry;
  try {
    registry = new JsonSessionRegistry(sessionsPath);
  } catch (err) {
    die(`Failed to load sessions file (${sessionsPath}): ${err instanceof Error ? err.message : String(err)}`);
  }
  const session = await registry.getSessionById(sessionId);
  if (!session) {
    die(describeUnresolvedSessionId(registry, sessionId, sessionsPath));
  }
  const workItemKind = session.workItemProvider?.provider ?? "github-issues";
  if (workItemKind !== "github-issues") {
    const message =
      `task reconcile-closed only supports GitHub work items (session "${sessionId}" uses "${workItemKind}"); ` +
      `not_planned is a GitHub Issue state_reason with no equivalent on this provider.`;
    const result = { ok: false, sessionId, reasonCode: "unsupported_provider", workItemKind, error: message };
    report(result, () => message);
    process.exitCode = 1;
    return;
  }

  const store = new SqliteTaskStore(dbPath);
  try {
    let candidates: AiTask[];
    if (issueNumber !== undefined) {
      const task = await store.getTask({ sessionId, issueNumber });
      if (!task) die(`No task found for issue #${issueNumber} in session ${sessionId}.`);
      candidates = RECONCILABLE_STATUSES.includes(task.status) ? [task] : [];
    } else {
      const all = await store.listSessionTasks(sessionId);
      candidates = all.filter((t) => RECONCILABLE_STATUSES.includes(t.status));
    }

    const results: ReconcileClosedResult[] = [];
    let cancelledCount = 0;

    for (const task of candidates) {
      const state = readGithubIssueCloseState(session.githubRepo, task.issueNumber);
      if (!state.ok) {
        results.push({ issueNumber: task.issueNumber, action: "check_failed", error: state.error });
        continue;
      }
      if (state.state !== "closed" || state.stateReason !== "not_planned") {
        results.push({
          issueNumber: task.issueNumber,
          action: "not_eligible",
          issueState: state.state,
          stateReason: state.stateReason,
        });
        continue;
      }

      if (!yes) {
        results.push({ issueNumber: task.issueNumber, action: "would_cancel", taskStatus: task.status });
        continue;
      }

      const now = new Date().toISOString();
      const runId = `admin-task-reconcile-closed-${now}-${task.issueNumber}`;
      const cancelReason = "GitHub issue closed as not_planned";

      // Bounded, path-safe operator-visible comment (issue #608). No label
      // mutation — see the `task cancel` header comment for why.
      let commentBody =
        `🛑 **Task cancelled — backing Issue closed as not planned.**\n\n` +
        `Previous status: \`${task.status}\` (phase: \`${task.phase}\`).\n\n` +
        `This issue was closed as not planned; the queued automation for it has been cancelled and will not run.`;
      commentBody = sanitizeBody(commentBody, sessionRedactionPaths(session));
      const effectCollector = new OutboxEffectCollector();
      await workItemOutbox(effectCollector, session).enqueue({
        idempotencyKey: makeOutboxKey(sessionId, task.issueNumber, runId, "gh:comment", "task-reconcile-closed"),
        topic: "gh:comment",
        payload: {
          topic: "gh:comment",
          owner: session.githubOwner,
          repo: session.githubName,
          issueNumber: task.issueNumber,
          body: commentBody,
        },
        now,
      });

      // Transition, event, and comment commit atomically (issue #608 review, P2).
      const cancelled = await store.cancelTaskWithEffects(
        { sessionId, issueNumber: task.issueNumber },
        { reason: cancelReason, now },
        {
          task: { sessionId, issueNumber: task.issueNumber },
          type: "task.cancelled",
          runId,
          message: cancelReason,
          data: { previousStatus: task.status, previousPhase: task.phase, trigger: "reconcile-closed" },
          createdAt: now,
        },
        effectCollector.effects,
      );
      if (!cancelled.ok) {
        results.push({ issueNumber: task.issueNumber, action: "cancel_failed", reasonCode: cancelled.code });
        continue;
      }

      cancelledCount++;
      results.push({ issueNumber: task.issueNumber, action: "cancelled", taskStatus: task.status });
    }

    const hasFailures = results.some((r) => r.action === "check_failed" || r.action === "cancel_failed");
    const result = {
      ok: !hasFailures,
      sessionId,
      scanned: candidates.length,
      cancelled: cancelledCount,
      dryRun: !yes,
      results,
    };
    report(result, (mode) => renderTaskReconcileClosed(result, mode));
    if (hasFailures) process.exitCode = 1;
  } finally {
    store.close();
  }
}

// ---------------------------------------------------------------------------
// Subcommand: task reconcile-merged (issue #1048)
//
// The operator surface over docs/merged-pr-reconciliation-contract.md: a task
// whose recorded pull request an operator merged by hand is still carrying a
// live lifecycle status, so nothing ever finishes it. This command previews and
// (with --yes) applies the contract's §7 decision for one Issue or for a whole
// session, delegating every decision to `core/merged-pr-reconciliation.ts` —
// no provider read, no eligibility rule, and no transition is re-implemented
// here. This layer only addresses tasks, renders, and maps outcomes to an exit
// status.
//
// Deliberately NOT a cleanup feature (§14). It never removes a worktree, never
// deletes a branch, never touches a file: it writes lifecycle metadata only.
// The disk-space workflow is two-stage and one-directional — run the ordinary
// `worktree cleanup`, and only if more space must be reclaimed, preview and
// apply this command, then run the unchanged `worktree cleanup` again (a
// reconciled task is `done`, which cleanup already classifies as a prune
// candidate). There is no `--include-merged` on cleanup and no `--force` here:
// §12.7 gives no flag that overrides a refusal.
// ---------------------------------------------------------------------------

/**
 * Statuses a §7 evaluation can act on. `done` is row 11 — an informative no-op
 * that consumes no provider call — so a bulk scan skips it rather than emitting
 * one line per historical task. Asking about a specific `done` task with
 * `--issue-number` still reports its `noop-done` outcome.
 */
const MERGED_RECONCILE_SCAN_STATUSES: TaskStatus[] = [
  "queued",
  "claimed",
  "running",
  "blocked",
  "ready_for_human",
  "failed",
  "cancelled",
];

/**
 * The refusals that mean "this run could not complete", as opposed to "this
 * task is not eligible". Only these (plus an unresolvable single-Issue target
 * and the §12.4 command-level provider refusal) produce a non-zero exit status:
 * a session scan normally finds many tasks whose recorded PR is simply still
 * open, and failing the command for that would make it unusable from n8n.
 */
const MERGED_RECONCILE_FAILURE_REFUSALS = new Set<MergedPrReconciliationRefusal>([
  "pr-lookup-failed",
  "store-refused",
  "stale-state",
]);

/**
 * One row of the stable machine payload. Every key is always present (null when
 * unknown) so a consumer never has to branch on shape, and no field carries a
 * local path: every message AND the reported PR identity pass through
 * `sanitizeBody` with the session redaction paths first. The identity needs that
 * as much as the messages do — `context.prUrl` is arbitrary task context, so a
 * malformed row can hold an absolute local path rather than a URL.
 */
interface ReconcileMergedRow {
  issueNumber: number;
  /** Task status/phase as observed BEFORE this row was acted on. */
  taskStatus: TaskStatus | null;
  taskPhase: TaskPhase | null;
  /**
   * The recorded PR identity (§4) — never inferred from the Issue number —
   * redacted for reporting. The unredacted value is what the core compares
   * against the provider, so redaction here cannot affect any decision.
   */
  prUrl: string | null;
  prNumber: number | null;
  /** The §3 outcome, plus `task-not-found` for an unresolvable `--issue-number`. */
  outcome: MergedPrReconciliationOutcome | "task-not-found";
  /** True for the two writing outcomes — what an apply would change / changed. */
  eligible: boolean;
  /** True only when this invocation actually wrote (apply mode). */
  applied: boolean;
  /** Refusal code, or the `active` reason; null when neither applies. */
  reason: string | null;
  /** The live provider `state` for the recorded PR, when one was read. */
  providerState: string | null;
  /** Sanitized human explanation; null when the outcome needs none. */
  message: string | null;
}

interface TaskReconcileMergedArgs {
  sessionId: string;
  issueNumber: number | undefined;
  sessionsPath: string;
  dbPath: string | undefined;
  worktreeLockDir: string | undefined;
  yes: boolean;
}

function parseTaskReconcileMergedArgs(argv: string[]): TaskReconcileMergedArgs | { error: string } {
  const opts = parseCommonOptions(argv, {
    session: "required",
    issueNumber: "optional",
    // No `--force`: §12.7 defines no flag that overrides a refusal, so an
    // operator who types one gets the unknown-option error rather than a
    // silently ignored token.
    booleanFlags: ["yes"],
    valueFlags: ["worktree-lock-dir"],
  });
  if ("error" in opts) return { error: opts.error };
  return {
    sessionId: opts.sessionId,
    issueNumber: opts.issueNumber,
    sessionsPath: opts.sessionsPath,
    dbPath: opts.dbPath,
    worktreeLockDir: opts.args["worktree-lock-dir"],
    yes: opts.flags.has("yes"),
  };
}

/** The §14 sequence, printed with every human-readable run so it is never folklore. */
const MERGED_RECONCILE_WORKFLOW_NOTE =
  "Disk-space workflow, in order: 1) run `admin worktree cleanup`; " +
  "2) only if more space must still be reclaimed, preview and then apply this command; " +
  "3) run `admin worktree cleanup` again. This command never deletes a worktree or a branch.";

function describeReconcileMergedRow(row: ReconcileMergedRow, dryRun: boolean): string {
  const where =
    row.taskStatus === null ? "" : ` — ${row.taskStatus}/${row.taskPhase ?? "?"}`;
  const pr =
    row.prNumber === null
      ? ""
      : `, PR #${row.prNumber}${row.providerState ? ` ${row.providerState}` : ""}` +
        (row.prUrl ? ` (${row.prUrl})` : "");
  const detail = row.message ? `: ${row.message}` : "";
  switch (row.outcome) {
    case "reconciled":
      return dryRun ? `would reconcile${where}${pr}` : `reconciled -> done${where}${pr}`;
    case "recorded-terminal":
      return dryRun
        ? `would record merge, status preserved${where}${pr}`
        : `merge recorded, status preserved${where}${pr}`;
    case "already-reconciled":
      return `already reconciled${where}${pr}`;
    case "noop-done":
      return `no-op, task already done${where}`;
    case "active":
      return `active (${row.reason ?? "unknown"})${where}${pr}${detail}`;
    case "task-not-found":
      return `no task found${detail}`;
    case "refused":
    default: {
      const failed =
        row.reason !== null &&
        MERGED_RECONCILE_FAILURE_REFUSALS.has(row.reason as MergedPrReconciliationRefusal);
      const label = failed ? "failed" : "not eligible";
      return `${label} (${row.reason ?? "unknown"})${where}${pr}${detail}`;
    }
  }
}

function renderTaskReconcileMerged(
  payload: {
    ok: boolean;
    sessionId: string;
    dryRun: boolean;
    scanned: number;
    reconciled: number;
    recordedTerminal: number;
    results: ReconcileMergedRow[];
    reasonCode?: string;
    error?: string;
  },
  _mode: OutputMode,
): string {
  if (payload.error !== undefined) return payload.error;
  const { sessionId, dryRun, scanned, reconciled, recordedTerminal, results } = payload;
  const lines = [
    `Reconcile externally merged PRs for session ${sessionId}: scanned ${scanned}, ` +
      (dryRun
        ? `would reconcile ${reconciled}, would record ${recordedTerminal} (preview).`
        : `reconciled ${reconciled}, recorded ${recordedTerminal}.`),
  ];
  for (const row of results) {
    lines.push(`  #${row.issueNumber}: ${describeReconcileMergedRow(row, dryRun)}`);
  }
  if (dryRun) lines.push("Run with --yes to apply.");
  lines.push(MERGED_RECONCILE_WORKFLOW_NOTE);
  return lines.join("\n");
}

async function runTaskReconcileMerged(argv: string[]): Promise<void> {
  const parsed = parseTaskReconcileMergedArgs(argv);
  if ("error" in parsed) die(parsed.error);
  const { sessionId, issueNumber, sessionsPath, dbPath, worktreeLockDir, yes } = parsed;

  let registry: JsonSessionRegistry;
  try {
    registry = new JsonSessionRegistry(sessionsPath);
  } catch (err) {
    die(`Failed to load sessions file (${sessionsPath}): ${err instanceof Error ? err.message : String(err)}`);
  }
  const session = await registry.getSessionById(sessionId);
  if (!session) {
    die(describeUnresolvedSessionId(registry, sessionId, sessionsPath));
  }

  const mode = yes ? "apply" : "preview";
  const base = { sessionId, issueNumber: issueNumber ?? null, mode, dryRun: !yes };

  // §12.4 — decided from the session's configured repo host BEFORE the store is
  // opened and before any task is read. Resolving the provider first would make
  // an unsupported host fail as a setup error (or, for gitea, as a missing
  // token) instead of the contract's own refusal.
  const repoHostKind = session.repoHostProvider?.provider ?? "github";
  const support = assessMergedPrProviderSupport(repoHostKind);
  if (!support.supported) {
    const result = {
      ok: false,
      ...base,
      scanned: 0,
      reconciled: 0,
      recordedTerminal: 0,
      alreadyReconciled: 0,
      noopDone: 0,
      active: 0,
      refused: 0,
      notFound: 0,
      results: [] as ReconcileMergedRow[],
      reasonCode: "unsupported_provider",
      repoHost: repoHostKind,
      error: `task reconcile-merged cannot run for session "${sessionId}": ${support.message}`,
    };
    report(result, (m) => renderTaskReconcileMerged(result, m));
    process.exitCode = 1;
    return;
  }

  let sessionRepoHost: SessionRepoHost;
  try {
    sessionRepoHost = await resolveSessionRepoHost(session.repoHostProvider, {
      githubRepo: session.githubRepo,
      cwd: session.repoRoot,
      ghRunnerFallback: defaultGhRunner,
    });
  } catch (err) {
    die(
      `Failed to resolve the repo-host provider for session "${sessionId}": ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const redactionPaths = sessionRedactionPaths(session);
  const clean = (text: string): string => sanitizeBody(text, redactionPaths);
  // The recorded PR identity is task context, so it is arbitrary text: a
  // malformed row can carry an absolute local path (and one with no extractable
  // PR number never reaches the provider, so nothing else would ever reject it).
  // Reporting it verbatim would put that path in both the JSON payload and the
  // human render, past the redaction every message already gets — so the
  // reported identity is redacted the same way. The DECISION still uses the raw
  // recorded value, which the core re-reads from the store itself.
  const cleanPrUrl = (value: string | null | undefined): string | null =>
    value === undefined || value === null ? null : clean(value);
  const issueLock = new IssueWorktreeLock(worktreeLockDir);
  const store = new SqliteTaskStore(dbPath);
  try {
    const rows: ReconcileMergedRow[] = [];
    let candidates: AiTask[];
    if (issueNumber !== undefined) {
      const task = await store.getTask({ sessionId, issueNumber });
      candidates = task ? [task] : [];
      if (!task) {
        rows.push({
          issueNumber,
          taskStatus: null,
          taskPhase: null,
          prUrl: null,
          prNumber: null,
          outcome: "task-not-found",
          eligible: false,
          applied: false,
          reason: null,
          providerState: null,
          message: `no task exists for issue #${issueNumber} in session "${sessionId}"`,
        });
      }
    } else {
      const all = await store.listSessionTasks(sessionId);
      candidates = all
        .filter((t) => MERGED_RECONCILE_SCAN_STATUSES.includes(t.status))
        .sort((a, b) => a.issueNumber - b.issueNumber);
    }

    for (const task of candidates) {
      // The identity shown in the report comes from the task row this layer
      // already read; the DECISION still re-reads the row inside the core, which
      // is what §11.3/§11.4 require (a preview is not a promise, and the write
      // CAS-es on the core's own read).
      const ctx = resolvePrContext(task);
      const recordedPrNumber = ctx.prUrl === undefined ? undefined : extractPrNumber(ctx.prUrl);
      const now = new Date().toISOString();
      const result: MergedPrTaskReconciliationResult = await reconcileMergedPrTask(
        {
          sessionId,
          issueNumber: task.issueNumber,
          mode,
          runId: `admin-task-reconcile-merged-${now}-${task.issueNumber}`,
          now,
        },
        {
          store,
          repoHost: {
            kind: sessionRepoHost.kind,
            getPullRequest: (selector) => sessionRepoHost.provider.getPullRequest(selector),
          },
          issueLock,
          session,
        },
      );

      const row: ReconcileMergedRow = {
        issueNumber: task.issueNumber,
        taskStatus: task.status,
        taskPhase: task.phase,
        prUrl: cleanPrUrl(ctx.prUrl),
        prNumber: recordedPrNumber ?? null,
        outcome: "refused",
        eligible: false,
        applied: false,
        reason: null,
        providerState: null,
        message: null,
      };
      switch (result.outcome) {
        case "unsupported-provider":
          // Unreachable: the same assessment already ran above, before the store
          // was opened. Surfaced rather than swallowed if the core ever widens.
          row.outcome = "refused";
          row.reason = "unsupported-provider";
          row.message = clean(result.message);
          break;
        case "task-not-found":
          row.outcome = "task-not-found";
          row.message = clean(result.message);
          break;
        case "noop-done":
          row.outcome = "noop-done";
          break;
        case "already-reconciled":
          row.outcome = "already-reconciled";
          row.prUrl = cleanPrUrl(result.prUrl);
          row.prNumber = result.prNumber;
          row.message = `PR #${result.prNumber} is already recorded in this task's reconciliation history`;
          break;
        case "active":
          row.outcome = "active";
          row.reason = result.reason;
          row.message = clean(result.message);
          break;
        case "refused":
          row.outcome = "refused";
          row.reason = result.refusal;
          row.providerState = result.providerState ?? null;
          row.message = clean(result.message);
          break;
        case "reconciled":
        case "recorded-terminal":
          row.outcome = result.outcome;
          row.eligible = true;
          row.applied = result.applied;
          row.prUrl = cleanPrUrl(result.record.prUrl);
          row.prNumber = result.record.prNumber;
          row.providerState =
            typeof result.record.providerState === "string" ? result.record.providerState : null;
          row.message =
            result.outcome === "reconciled"
              ? `merged PR #${result.record.prNumber} ${result.applied ? "reconciled" : "would reconcile"}: ` +
                `${task.status} -> done`
              : `external merge of PR #${result.record.prNumber} ` +
                `${result.applied ? "recorded" : "would be recorded"}; terminal status ${task.status} preserved`;
          break;
      }
      rows.push(row);
    }

    const count = (predicate: (row: ReconcileMergedRow) => boolean): number =>
      rows.filter(predicate).length;
    const hasFailures = rows.some(
      (row) =>
        row.outcome === "task-not-found" ||
        (row.outcome === "refused" &&
          row.reason !== null &&
          MERGED_RECONCILE_FAILURE_REFUSALS.has(row.reason as MergedPrReconciliationRefusal)),
    );
    const result = {
      ok: !hasFailures,
      ...base,
      scanned: rows.length,
      reconciled: count((row) => row.outcome === "reconciled"),
      recordedTerminal: count((row) => row.outcome === "recorded-terminal"),
      alreadyReconciled: count((row) => row.outcome === "already-reconciled"),
      noopDone: count((row) => row.outcome === "noop-done"),
      active: count((row) => row.outcome === "active"),
      refused: count((row) => row.outcome === "refused"),
      notFound: count((row) => row.outcome === "task-not-found"),
      results: rows,
    };
    report(result, (m) => renderTaskReconcileMerged(result, m));
    if (hasFailures) process.exitCode = 1;
  } finally {
    store.close();
  }
}

// ---------------------------------------------------------------------------
// Subcommand: context create
// ---------------------------------------------------------------------------

interface ContextCreateArgs {
  executionId: string;
  sessionId: string;
  dbPath: string | undefined;
}

function parseContextCreateArgs(argv: string[]): ContextCreateArgs | { error: string } {
  const tokenized = tokenizeArgs(argv, {
    valueFlags: ["execution-id", "session-id", "session-ref", "sessions-path", "db-path"],
  });
  if ("error" in tokenized) return { error: tokenized.error };
  const { args } = tokenized;

  if (!args["execution-id"]) return { error: "--execution-id is required" };

  const selector = resolveSessionSelector(args);
  if ("error" in selector) return { error: selector.error };

  return {
    executionId: args["execution-id"],
    sessionId: selector.sessionId,
    dbPath: args["db-path"],
  };
}

function runContextCreate(argv: string[]): void {
  const parsed = parseContextCreateArgs(argv);
  if ("error" in parsed) die(parsed.error);

  const { executionId, sessionId, dbPath } = parsed;
  const store = new SqliteContextStore(dbPath);
  try {
    store.upsert(executionId, sessionId);
  } finally {
    store.close();
  }
  emit({ ok: true, contextId: executionId });
}

// ---------------------------------------------------------------------------
// Subcommand: session preset list | show  (issue #513)
// ---------------------------------------------------------------------------

function runSessionPresetList(): void {
  const presets = ECOSYSTEM_PRESETS.map((p) => ({ name: p.name, description: p.description }));
  emit({ ok: true, presets });
}

function runSessionPresetShow(argv: string[]): void {
  const tokenized = tokenizeArgs(argv, { allowPositionals: true });
  if ("error" in tokenized) die(tokenized.error);
  const { positionals } = tokenized;
  if (positionals.length === 0) {
    die("preset name is required (e.g. admin session preset show javascript-npm)");
  }
  if (positionals.length > 1) {
    die(`Unexpected argument: ${positionals[1]}`);
  }
  const name = positionals[0];
  const preset = findPreset(name);
  if (!preset) {
    die(`Unknown preset: ${name}. Available presets: ${PRESET_NAMES.join(", ")}`);
  }
  emit({ ok: true, preset });
}

// ---------------------------------------------------------------------------
// Subcommand: session pause | resume | status  (issue #531)
//
// Session-level pause / circuit-breaker surface. Pause state and the per-run
// result ledger live in the runner-owned SQLite store
// (stores/sqlite-session-control-store.ts) — never in GitHub labels — and
// run-one-phase checks the pause BEFORE claiming work, so a paused session
// claims and executes nothing until resumed. Task-level recover flows are
// unaffected: recovery mutates task rows, not the session gate.
// ---------------------------------------------------------------------------

/** Resolve and validate the session, mirroring the other session-scoped
 * commands: a typo'd --session-id must die loudly, not silently pause a
 * session no runner will ever read. */
async function requireKnownSession(sessionId: string, sessionsPath: string): Promise<void> {
  let registry: JsonSessionRegistry;
  try {
    registry = new JsonSessionRegistry(sessionsPath);
  } catch (err) {
    die(`Failed to load sessions file (${sessionsPath}): ${err instanceof Error ? err.message : String(err)}`);
  }
  const session = await registry.getSessionById(sessionId);
  if (!session) {
    die(describeUnresolvedSessionId(registry, sessionId, sessionsPath));
  }
}

async function runSessionPause(argv: string[]): Promise<void> {
  const opts = parseCommonOptions(argv, { session: "required", valueFlags: ["reason"] });
  if ("error" in opts) die(opts.error);
  const { sessionId, sessionsPath, dbPath } = opts;
  const reason = opts.args["reason"];
  await requireKnownSession(sessionId, sessionsPath);

  const control = new SqliteSessionControlStore(dbPath);
  try {
    // An operator pause overwrites an existing pause (including a
    // circuit-breaker one) so the stored reason always reflects the latest
    // explicit operator intent.
    const result = await control.pauseSession(sessionId, {
      ...(reason !== undefined ? { reason } : {}),
      pausedBy: "operator",
      source: "operator",
    });
    const payload = {
      ok: true,
      sessionId,
      paused: true,
      alreadyPaused: result.alreadyPaused,
      ...(result.state.reason !== undefined ? { reason: result.state.reason } : {}),
      ...(result.state.pausedAt !== undefined ? { pausedAt: result.state.pausedAt } : {}),
    };
    report(payload, () => {
      const lines = [
        result.alreadyPaused
          ? `Session ${sessionId} was already paused; pause updated.`
          : `Paused session ${sessionId}.`,
      ];
      if (result.state.reason !== undefined) lines.push(`  Reason: ${result.state.reason}`);
      lines.push(`  run-one-phase will claim no new work for this session until 'admin session resume'.`);
      return lines.join("\n");
    });
  } finally {
    control.close();
  }
}

async function runSessionResume(argv: string[]): Promise<void> {
  const opts = parseCommonOptions(argv, { session: "required" });
  if ("error" in opts) die(opts.error);
  const { sessionId, sessionsPath, dbPath } = opts;
  await requireKnownSession(sessionId, sessionsPath);

  const control = new SqliteSessionControlStore(dbPath);
  try {
    const result = await control.resumeSession(sessionId);
    const payload = {
      ok: true,
      sessionId,
      resumed: result.changed,
      ...(result.previous
        ? {
            previous: {
              ...(result.previous.reason !== undefined ? { reason: result.previous.reason } : {}),
              ...(result.previous.pausedAt !== undefined ? { pausedAt: result.previous.pausedAt } : {}),
              ...(result.previous.pausedBy !== undefined ? { pausedBy: result.previous.pausedBy } : {}),
              ...(result.previous.source !== undefined ? { source: result.previous.source } : {}),
            },
          }
        : {}),
    };
    report(payload, () => {
      if (!result.changed) return `Session ${sessionId} is not paused; nothing to do.`;
      const lines = [`Resumed session ${sessionId}.`];
      if (result.previous?.reason !== undefined) lines.push(`  Cleared pause reason: ${result.previous.reason}`);
      if (result.previous?.source === "circuit_breaker") {
        lines.push(
          `  The pause came from the circuit breaker; if the failing condition persists, the next failed run can pause the session again.`,
        );
      }
      return lines.join("\n");
    });
  } finally {
    control.close();
  }
}

function formatLedgerDuration(durationMs: number | undefined): string {
  if (durationMs === undefined) return "-";
  return `${(durationMs / 1000).toFixed(1)}s`;
}

function renderSessionStatus(payload: {
  sessionId: string;
  pause: SessionPauseState;
  policy: { maxConsecutiveFailures: number; maxIssuePhaseFailures: number };
  consecutiveFailures: number;
  wouldPauseNow: boolean;
  tripReason?: string;
  recentRuns: RunLedgerEntry[];
}): string {
  const { sessionId, pause, policy, consecutiveFailures, wouldPauseNow, tripReason, recentRuns } = payload;
  const lines: string[] = [];
  if (pause.paused) {
    lines.push(`Session ${sessionId}: PAUSED${pause.source !== undefined ? ` (${pause.source})` : ""}`);
    if (pause.reason !== undefined) lines.push(`  Reason: ${pause.reason}`);
    const meta = [
      ...(pause.pausedAt !== undefined ? [`at ${pause.pausedAt}`] : []),
      ...(pause.pausedBy !== undefined ? [`by ${pause.pausedBy}`] : []),
    ];
    if (meta.length > 0) lines.push(`  Paused ${meta.join(" ")}`);
    lines.push(`  Resume with: admin session resume --session-id ${sessionId}`);
  } else {
    lines.push(`Session ${sessionId}: active (not paused)`);
  }
  lines.push(
    `Circuit breaker: ${consecutiveFailures} consecutive failed run(s); thresholds: ` +
      `${policy.maxConsecutiveFailures === 0 ? "disabled" : policy.maxConsecutiveFailures} per session, ` +
      `${policy.maxIssuePhaseFailures === 0 ? "disabled" : policy.maxIssuePhaseFailures} per issue+phase`,
  );
  lines.push(
    wouldPauseNow
      ? `  Would pause now: yes — ${tripReason ?? "threshold reached"}`
      : `  Would pause now: no`,
  );
  if (recentRuns.length === 0) {
    lines.push("Recent runs: none recorded");
  } else {
    lines.push(`Recent runs (newest first):`);
    for (const run of recentRuns) {
      const extras = [
        ...(run.agent !== undefined ? [run.agent] : []),
        ...(run.model !== undefined ? [run.model] : []),
        ...(run.costUsd !== undefined ? [`$${run.costUsd}`] : []),
      ];
      lines.push(
        `  #${run.issueNumber} ${run.phase} ${run.outcome} (${formatLedgerDuration(run.durationMs)})` +
          `${extras.length > 0 ? ` [${extras.join(", ")}]` : ""} at ${run.createdAt}`,
      );
    }
  }
  return lines.join("\n");
}

async function runSessionStatus(argv: string[]): Promise<void> {
  const opts = parseCommonOptions(argv, { session: "required", valueFlags: ["limit"] });
  if ("error" in opts) die(opts.error);
  const { sessionId, sessionsPath, dbPath } = opts;
  let limit = 10;
  if (opts.args["limit"] !== undefined) {
    const n = Number(opts.args["limit"]);
    if (!Number.isInteger(n) || n < 1 || n > 50) {
      die(`--limit must be an integer between 1 and 50, got: ${opts.args["limit"]}`);
    }
    limit = n;
  }
  await requireKnownSession(sessionId, sessionsPath);

  // `session status` is documented as read-only, but the store constructor
  // creates the parent directory, the SQLite file, and the schema when the DB
  // does not exist yet (fresh session, or a typo'd --db-path). Report the
  // absent DB as an empty pause/ledger state instead of materialising one as
  // a side effect of inspection (same pattern as runInterventions).
  const resolvedDbPath = dbPath ?? DEFAULT_DB_PATH;
  if (!existsSync(resolvedDbPath)) {
    const policy = resolveCircuitBreakerPolicy();
    const payload = {
      ok: true,
      sessionId,
      paused: false,
      circuitBreaker: {
        policy,
        consecutiveFailures: 0,
        wouldPauseNow: false,
      },
      recentRuns: [],
    };
    report(payload, () =>
      renderSessionStatus({
        sessionId,
        pause: { paused: false },
        policy,
        consecutiveFailures: 0,
        wouldPauseNow: false,
        recentRuns: [],
      }),
    );
    return;
  }

  const control = new SqliteSessionControlStore(dbPath);
  try {
    const pause = await control.getPauseState(sessionId);
    // Evaluate over the breaker's own windows (not the display limit) so the
    // reported standing matches what the runner would decide.
    const policy = resolveCircuitBreakerPolicy();
    const { recent: window, issuePhaseRuns } = await fetchCircuitBreakerWindows(
      control,
      sessionId,
      policy,
    );
    const decision = evaluateCircuitBreaker(window, policy, issuePhaseRuns);
    const consecutiveFailures = countConsecutiveFailures(window);
    const recentRuns = window.slice(0, limit);
    const payload = {
      ok: true,
      sessionId,
      paused: pause.paused,
      ...(pause.paused
        ? {
            ...(pause.reason !== undefined ? { reason: pause.reason } : {}),
            ...(pause.pausedAt !== undefined ? { pausedAt: pause.pausedAt } : {}),
            ...(pause.pausedBy !== undefined ? { pausedBy: pause.pausedBy } : {}),
            ...(pause.source !== undefined ? { source: pause.source } : {}),
          }
        : {}),
      circuitBreaker: {
        policy,
        consecutiveFailures,
        wouldPauseNow: decision.trip,
        ...(decision.trip
          ? { rule: decision.rule, count: decision.count, threshold: decision.threshold, reason: decision.reason }
          : {}),
      },
      recentRuns,
    };
    report(payload, () =>
      renderSessionStatus({
        sessionId,
        pause,
        policy,
        consecutiveFailures,
        wouldPauseNow: decision.trip,
        ...(decision.trip ? { tripReason: decision.reason } : {}),
        recentRuns,
      }),
    );
  } finally {
    control.close();
  }
}

// ---------------------------------------------------------------------------
// Subcommand: session-doctor
// ---------------------------------------------------------------------------

interface CheckResult {
  name: string;
  category: "repo" | "github" | "aiCli" | "storage" | "worktree" | "registry";
  ok: boolean;
  detail?: string;
  error?: string;
  /**
   * The check did not fail — it failed to ANSWER (issue #897). Present only on
   * indeterminate CLI probes (timeout, refused fork), whose `ok: false` must not
   * be read as a finding about the thing probed.
   */
  transient?: boolean;
}

interface SessionDoctorArgs {
  sessionId: string;
  sessionsPath: string;
  dbPath: string;
}

function parseSessionDoctorArgs(argv: string[]): SessionDoctorArgs | { error: string } {
  const tokenized = tokenizeArgs(argv, {
    valueFlags: ["session-id", "session-ref", "sessions-path", "db-path"],
  });
  if ("error" in tokenized) return { error: tokenized.error };
  const { args } = tokenized;
  const selector = resolveSessionSelector(args);
  if ("error" in selector) return { error: selector.error };
  return {
    sessionId: selector.sessionId,
    sessionsPath: args["sessions-path"] ?? DEFAULT_SESSIONS_PATH,
    dbPath: args["db-path"] ?? DEFAULT_DB_PATH,
  };
}

/**
 * GitHub labels the workflow's intake/outbox routing depends on (docs/install.md
 * §5.3). `src/core/github-intake.ts` matches these as literal strings regardless
 * of any per-session `labels` override, so session-doctor checks for the literal
 * names actually consumed by intake routing rather than resolving per-session
 * label overrides (which only rename *outbound* label application).
 */
const REQUIRED_GITHUB_LABELS: readonly string[] = [
  "agent:claude",
  "agent:codex",
  "agent:gemini",
  "status:needs-implementation",
  "status:needs-fix",
  "status:needs-review",
  "status:research-needed",
  "status:needs-conflict-resolution",
  "status:backlog",
  "ai:active",
  "ai:blocked",
  "ai:ready-for-human",
];

/** Read a target repo's label names via `gh label list --json name`. */
function readGithubRepoLabels(
  githubRepo: string,
  cwd?: string,
): { ok: true; names: string[] } | { ok: false; error: string } {
  const probed = probe("gh", ["label", "list", "--repo", githubRepo, "--json", "name", "--limit", "200"], cwd);
  if (!probed.ok) return { ok: false, error: probed.output };
  let parsed: unknown;
  try {
    parsed = JSON.parse(probed.output || "[]");
  } catch (err) {
    return {
      ok: false,
      error: `Failed to parse gh label list output: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!Array.isArray(parsed)) return { ok: false, error: "gh label list did not return a JSON array" };
  const names = (parsed as Array<{ name?: unknown }>)
    .map((l) => (typeof l.name === "string" ? l.name : ""))
    .filter((n) => n.length > 0);
  return { ok: true, names };
}

/**
 * Determine whether `relPath` (relative to `repoRoot`) is excluded by the repo's
 * `.gitignore` (or any other git exclude source), distinguishing a positive
 * "not ignored" (`git check-ignore` exits 1) from an ambiguous lookup failure
 * (exits >1, e.g. run outside a git repo) — mirrors the tri-state pattern used by
 * {@link remoteHasBranch} so a lookup failure is never misread as "not ignored".
 *
 * A trailing slash is appended (unless already present) before the lookup:
 * `artifactDir` is typically checked before it has ever been created on disk
 * (a fresh session that has not run yet), and without an existing directory to
 * `lstat`, git cannot tell the query path is a directory and would otherwise
 * fail to match a directory-only pattern like `.n8n-artifacts/` — the
 * documented workaround is to make the directory-ness explicit in the query
 * path itself rather than relying on the filesystem.
 */
function checkGitIgnored(repoRoot: string, relPath: string): "ignored" | "not-ignored" | "unknown" {
  const dirPath = relPath.endsWith("/") ? relPath : `${relPath}/`;
  try {
    execFileSync("git", ["check-ignore", "-q", "--", dirPath], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
    });
    return "ignored";
  } catch (err: unknown) {
    return (err as { status?: number }).status === 1 ? "not-ignored" : "unknown";
  }
}

/**
 * Best-effort SQLite write/WAL health probe (issue #695). Opens the store DB
 * read-write and runs a passive WAL checkpoint — a real write-lock operation
 * that surfaces a read-only filesystem, a corrupted file, or a journal mode
 * that silently reverted to non-WAL, without mutating any task/context row (a
 * passive checkpoint only folds already-committed WAL frames into the main
 * file, which SQLite does on its own during normal operation). A DB that has
 * never been created — no session has run yet — is not a failure.
 */
function checkSqliteHealth(dbPath: string): CheckResult {
  const name = "sqliteDbHealth";
  const category = "storage" as const;
  if (!existsSync(dbPath)) {
    return { name, category, ok: true, detail: `${dbPath} (not yet created)` };
  }
  let db: Database.Database | undefined;
  try {
    db = new Database(dbPath, { fileMustExist: true });
    const integrity = db.pragma("integrity_check") as Array<{ integrity_check: string }>;
    const integrityOk = integrity.length === 1 && integrity[0].integrity_check === "ok";
    if (!integrityOk) {
      return {
        name,
        category,
        ok: false,
        error: `${dbPath} failed PRAGMA integrity_check: ${JSON.stringify(integrity)}. The DB may be corrupt — restore from a backup`,
      };
    }
    const journalRows = db.pragma("journal_mode") as Array<{ journal_mode: string }>;
    const journalMode = journalRows[0]?.journal_mode?.toLowerCase();
    if (journalMode !== "wal") {
      return {
        name,
        category,
        ok: false,
        error: `${dbPath} is in '${journalMode ?? "unknown"}' journal mode, expected 'wal'. This can happen when the DB lives on a filesystem that silently rejects WAL (e.g. some network/NFS mounts) — move it to local disk`,
      };
    }
    db.pragma("wal_checkpoint(PASSIVE)");
    return { name, category, ok: true, detail: dbPath };
  } catch (err) {
    return {
      name,
      category,
      ok: false,
      error: `${dbPath} write/WAL health check failed: ${err instanceof Error ? err.message : String(err)}. Check file/directory permissions and available disk space`,
    };
  } finally {
    db?.close();
  }
}

/**
 * Heuristic low-disk gate (bytes) for the filesystem hosting the managed
 * worktree state root (issue #695). Per-issue worktrees are full repo
 * checkouts whose eventual size is unknown ahead of time, so this only flags a
 * host that is already critically low rather than sizing against any specific
 * repo — mirrors {@link checkBackupDiskSpace}'s best-effort, feature-detected
 * `statfsSync` use in sqlite-backup-store.ts.
 */
const MIN_WORKTREE_FREE_BYTES = 1_073_741_824; // 1 GiB

/**
 * Sanity-check the managed worktree state root: that it resolves to a valid
 * absolute path, that an existing root is actually a directory, and that its
 * filesystem has more than a critically low amount of free space. Never
 * blocks on an unsupported Node/platform (statfsSync feature-detected) or on a
 * root that has not been created yet (no issue has run in this session yet).
 */
function checkWorktreeStateRoot(sessionWorktreeRootOverride: string | undefined): CheckResult {
  const name = "worktreeStateRoot";
  const category = "worktree" as const;
  let root: string;
  try {
    root = resolveWorktreeRoot({ sessionRoot: sessionWorktreeRootOverride });
  } catch (err) {
    return { name, category, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (existsSync(root) && !statSync(root).isDirectory()) {
    return { name, category, ok: false, error: `Worktree state root exists but is not a directory: ${root}` };
  }
  if (typeof statfsSync !== "function") {
    return { name, category, ok: true, detail: root };
  }
  // Walk up to the nearest existing ancestor so a not-yet-created state root
  // still yields a meaningful disk reading instead of statfsSync throwing on a
  // missing path.
  let probeDir = root;
  while (!existsSync(probeDir)) {
    const parent = dirname(probeDir);
    if (parent === probeDir) break;
    probeDir = parent;
  }
  try {
    const stat = statfsSync(probeDir);
    const available = Number(stat.bavail) * Number(stat.bsize);
    if (available < MIN_WORKTREE_FREE_BYTES) {
      return {
        name,
        category,
        ok: false,
        error: `Only ~${Math.floor(available / 1e6)}MB free on the filesystem hosting the worktree state root (${root}); per-issue worktrees are full repo checkouts and can exhaust this quickly. Free disk space or relocate via session.worktrees.root / ${WORKTREE_ROOT_ENV}`,
      };
    }
    return { name, category, ok: true, detail: root };
  } catch {
    return { name, category, ok: true, detail: root };
  }
}

/** A plain JSON object — the shape every optional session block must have. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Rejection reasons that mean a candidate could not become an invocable arbiter
 * profile AT ALL (issue #839). Provider overlap and the same-model refusals are
 * deliberately absent: those candidates resolved fine and were refused by §8.3's
 * independence policy, which is the `arbiterSelection` check's subject.
 */
const UNUSABLE_ARBITER_REASONS: ReadonlySet<string> = new Set([
  "not-an-agent-id",
  "unsupported-role",
  "candidate-not-found",
  "cli-unavailable",
  // An indeterminate probe (#897) did not make the candidate usable either, so
  // it belongs in this check rather than being silently dropped. Its own reason
  // code keeps it readable as "ask again", not "install something" — and
  // `arbiterCandidates` appends the re-run advice when one is present.
  "cli-probe-indeterminate",
  "profile-error",
  "candidate-limit-exceeded",
]);

/** Render bounded arbiter rejections as one operator-readable line. */
function describeArbiterRejections(rejections: readonly ArbiterCandidateRejection[]): string {
  return rejections
    .map(
      (r) =>
        `${r.candidate ?? "<not a string>"}[${r.index}]: ${r.reason}`
        + `${r.detail === null ? "" : ` (${r.detail})`}`,
    )
    .join("; ");
}

function runSessionDoctor(argv: string[]): void {
  const parsed = parseSessionDoctorArgs(argv);
  if ("error" in parsed) die(parsed.error);

  const { sessionId, sessionsPath, dbPath } = parsed;

  if (!existsSync(sessionsPath)) {
    die(`Sessions file not found: ${sessionsPath}`);
  }

  let fileContent: { sessions?: unknown };
  try {
    fileContent = JSON.parse(readFileSync(sessionsPath, "utf8")) as { sessions?: unknown };
  } catch {
    die(`Failed to parse sessions file: ${sessionsPath}`);
  }

  if (!Array.isArray(fileContent.sessions)) {
    die(`sessions.json does not contain a sessions array`);
  }

  const sessions = fileContent.sessions as Array<Record<string, unknown>>;
  const sessionIndex = sessions.findIndex(
    (s) => s !== null && typeof s === "object" && s["sessionId"] === sessionId,
  );
  const session = sessionIndex === -1 ? undefined : sessions[sessionIndex];
  if (!session) {
    die(`Unknown sessionId: ${sessionId} (not found in ${sessionsPath})`);
  }

  const worktreesBlock =
    typeof session["worktrees"] === "object" && session["worktrees"] !== null
      ? (session["worktrees"] as Record<string, unknown>)
      : undefined;
  if (worktreesBlock?.["enabled"] !== undefined) {
    die(
      `sessions[].worktrees.enabled is no longer supported — worktrees are always enabled and there is no ` +
        `shared-checkout mode to opt out of. Remove "enabled" from session "${sessionId}"'s worktrees block ` +
        `(see docs/worktree-only-migration-contract.md).`,
    );
  }

  const repoRoot = typeof session["repoRoot"] === "string" ? session["repoRoot"] : "";
  const githubRepo = typeof session["githubRepo"] === "string" ? session["githubRepo"] : "";
  const artifactDir = typeof session["artifactDir"] === "string" ? session["artifactDir"] : "";
  const sessionWorktreeRootOverride =
    worktreesBlock && typeof worktreesBlock["root"] === "string" ? (worktreesBlock["root"] as string) : undefined;
  const defaults = (typeof session["defaults"] === "object" && session["defaults"] !== null
    ? session["defaults"]
    : {}) as Record<string, string>;

  // Deterministic seam (issue #897): with the stub set, agent-CLI availability
  // is read from it instead of from a spawn, so selection-policy assertions do
  // not ride on whether this host can fork a throwaway script promptly. A
  // stubbed outcome is always rendered with "[stubbed probe]" so it can never be
  // read as a real availability fact. Only agent CLIs are stubbable — the git
  // and gh probes below are untouched. Parsed here, before any check runs, so a
  // malformed stub costs nothing and cannot be mistaken for a diagnosis.
  const probeStubParse = parseCliProbeStub(process.env[CLI_PROBE_STUB_ENV]);
  if (!probeStubParse.ok) die(probeStubParse.error);
  const probeStub = probeStubParse.stub;

  const checks: CheckResult[] = [];

  // ---- Repo checks ----

  const repoRootOk = repoRoot !== "" && existsSync(repoRoot);
  checks.push({
    name: "repoRootExists",
    category: "repo",
    ok: repoRootOk,
    detail: repoRoot || "(not configured)",
    ...(repoRootOk ? {} : { error: `Directory does not exist: ${repoRoot || "(not configured)"}` }),
  });

  let repoIsGitOk = false;
  if (repoRootOk) {
    const gitCheck = probe("git", ["rev-parse", "--git-dir"], repoRoot);
    repoIsGitOk = gitCheck.ok;
    checks.push({
      name: "repoIsGit",
      category: "repo",
      ok: gitCheck.ok,
      detail: repoRoot,
      ...(gitCheck.ok ? {} : { error: gitCheck.output }),
    });
  } else {
    checks.push({
      name: "repoIsGit",
      category: "repo",
      ok: false,
      error: "Skipped: repoRoot does not exist",
    });
  }

  if (!repoRootOk) {
    checks.push({
      name: "artifactDirGitignored",
      category: "repo",
      ok: false,
      error: "Skipped: repoRoot does not exist",
    });
  } else if (!repoIsGitOk) {
    checks.push({
      name: "artifactDirGitignored",
      category: "repo",
      ok: false,
      error: "Skipped: repoRoot is not a git repository",
    });
  } else if (!artifactDir) {
    checks.push({
      name: "artifactDirGitignored",
      category: "repo",
      ok: false,
      error: "artifactDir not configured in session",
    });
  } else {
    const ignoredState = checkGitIgnored(repoRoot, artifactDir);
    if (ignoredState === "ignored") {
      checks.push({ name: "artifactDirGitignored", category: "repo", ok: true, detail: artifactDir });
    } else if (ignoredState === "not-ignored") {
      checks.push({
        name: "artifactDirGitignored",
        category: "repo",
        ok: false,
        error:
          `'${artifactDir}' is not ignored by ${repoRoot}'s .gitignore; run artifacts and lock files under it ` +
          `could be committed by accident. Fix with: echo '${artifactDir}/' >> ${repoRoot}/.gitignore && ` +
          `git -C ${repoRoot} add .gitignore && git -C ${repoRoot} commit -m "chore: gitignore n8n-ai-cli-loop artifacts"`,
      });
    } else {
      checks.push({
        name: "artifactDirGitignored",
        category: "repo",
        ok: false,
        error: `Could not determine whether '${artifactDir}' is gitignored in ${repoRoot} (git check-ignore lookup failed)`,
      });
    }
  }

  // ---- GitHub checks ----

  const ghAuthCheck = probe("gh", ["auth", "status"]);
  checks.push({
    name: "ghAuth",
    category: "github",
    ok: ghAuthCheck.ok,
    ...(ghAuthCheck.ok ? { detail: "authenticated" } : { error: ghAuthCheck.output }),
  });

  if (githubRepo) {
    const ghRepoCheck = probe(
      "gh",
      ["repo", "view", githubRepo, "--json", "nameWithOwner"],
      repoRootOk ? repoRoot : undefined,
    );
    checks.push({
      name: "ghRepoAccess",
      category: "github",
      ok: ghRepoCheck.ok,
      detail: githubRepo,
      ...(ghRepoCheck.ok ? {} : { error: ghRepoCheck.output }),
    });

    if (!ghRepoCheck.ok) {
      checks.push({
        name: "ghRequiredLabels",
        category: "github",
        ok: false,
        error: "Skipped: githubRepo is not accessible (see ghRepoAccess)",
      });
    } else {
      const labelsResult = readGithubRepoLabels(githubRepo, repoRootOk ? repoRoot : undefined);
      if (!labelsResult.ok) {
        checks.push({ name: "ghRequiredLabels", category: "github", ok: false, error: labelsResult.error });
      } else {
        const have = new Set(labelsResult.names);
        const missing = REQUIRED_GITHUB_LABELS.filter((l) => !have.has(l));
        if (missing.length > 0) {
          checks.push({
            name: "ghRequiredLabels",
            category: "github",
            ok: false,
            error:
              `Missing required GitHub label(s) on ${githubRepo}: ${missing.join(", ")}. Create with: ` +
              missing.map((l) => `gh label create "${l}" --repo ${githubRepo}`).join("; "),
          });
        } else {
          checks.push({
            name: "ghRequiredLabels",
            category: "github",
            ok: true,
            detail: `${REQUIRED_GITHUB_LABELS.length} required labels present`,
          });
        }
      }
    }
  } else {
    checks.push({
      name: "ghRepoAccess",
      category: "github",
      ok: false,
      error: "githubRepo not configured",
    });
    checks.push({
      name: "ghRequiredLabels",
      category: "github",
      ok: false,
      error: "Skipped: githubRepo not configured",
    });
  }

  // ---- AI CLI checks ----

  const implementationAgent = defaults["implementationAgent"];
  const reviewAgent = defaults["reviewAgent"];
  const researchAgent = defaults["researchAgent"];

  const IMPLEMENTATION_SUPPORTED: AgentId[] = ["claude", "codex", "gemini"];
  const REVIEW_SUPPORTED: AgentId[] = ["codex", "claude", "gemini"];
  const RESEARCH_SUPPORTED: AgentId[] = ["gemini"];

  if (!implementationAgent) {
    checks.push({
      name: "implementationAgentCli",
      category: "aiCli",
      ok: false,
      error: "implementationAgent not configured in session defaults",
    });
  } else if (!VALID_AGENTS.includes(implementationAgent as AgentId)) {
    checks.push({
      name: "implementationAgentCli",
      category: "aiCli",
      ok: false,
      error: `implementationAgent "${implementationAgent}" is not a recognised agent. Must be one of: ${VALID_AGENTS.join(", ")}`,
    });
  } else if (!IMPLEMENTATION_SUPPORTED.includes(implementationAgent as AgentId)) {
    checks.push({
      name: "implementationAgentCli",
      category: "aiCli",
      ok: false,
      error: `implementationAgent "${implementationAgent}" is not supported for the implementation role. Supported: ${IMPLEMENTATION_SUPPORTED.join(", ")}`,
    });
  }

  if (!reviewAgent) {
    checks.push({
      name: "reviewAgentCli",
      category: "aiCli",
      ok: false,
      error: "reviewAgent not configured in session defaults",
    });
  } else if (!VALID_AGENTS.includes(reviewAgent as AgentId)) {
    checks.push({
      name: "reviewAgentCli",
      category: "aiCli",
      ok: false,
      error: `reviewAgent "${reviewAgent}" is not a recognised agent. Must be one of: ${VALID_AGENTS.join(", ")}`,
    });
  } else if (!REVIEW_SUPPORTED.includes(reviewAgent as AgentId)) {
    checks.push({
      name: "reviewAgentCli",
      category: "aiCli",
      ok: false,
      error: `reviewAgent "${reviewAgent}" is not supported for the review role. Supported: ${REVIEW_SUPPORTED.join(", ")}`,
    });
  }

  if (researchAgent && !VALID_AGENTS.includes(researchAgent as AgentId)) {
    checks.push({
      name: "researchAgentCli",
      category: "aiCli",
      ok: false,
      error: `researchAgent "${researchAgent}" is not a recognised agent. Must be one of: ${VALID_AGENTS.join(", ")}`,
    });
  } else if (researchAgent && !RESEARCH_SUPPORTED.includes(researchAgent as AgentId)) {
    checks.push({
      name: "researchAgentCli",
      category: "aiCli",
      ok: false,
      error: `researchAgent "${researchAgent}" is not supported for the research role. Supported: ${RESEARCH_SUPPORTED.join(", ")}`,
    });
  }

  const agentSet = new Set<AgentId>();
  if (implementationAgent && VALID_AGENTS.includes(implementationAgent as AgentId) && IMPLEMENTATION_SUPPORTED.includes(implementationAgent as AgentId)) {
    agentSet.add(implementationAgent as AgentId);
  }
  if (reviewAgent && VALID_AGENTS.includes(reviewAgent as AgentId) && REVIEW_SUPPORTED.includes(reviewAgent as AgentId) && reviewAgent !== "gemini") {
    agentSet.add(reviewAgent as AgentId);
  }
  // Include research agent in the shared set so the loop below emits exactly one
  // CLI probe per distinct agent binary, even when researchAgent and
  // implementationAgent resolve to the same agent (e.g. both "gemini").
  if (researchAgent && VALID_AGENTS.includes(researchAgent as AgentId) && RESEARCH_SUPPORTED.includes(researchAgent as AgentId)) {
    agentSet.add(researchAgent as AgentId);
  }
  // Conflict resolution always uses Claude regardless of implementationAgent.
  // When implementationAgent is not Claude (e.g. "gemini"), intake explicitly
  // persists conflictResolutionAgent: "claude" for those tasks so the first
  // merge-conflict requeue goes to Claude. Probe Claude here so doctor catches
  // a missing claude binary before that requeue fails at runtime.
  if (
    implementationAgent &&
    VALID_AGENTS.includes(implementationAgent as AgentId) &&
    IMPLEMENTATION_SUPPORTED.includes(implementationAgent as AgentId) &&
    implementationAgent !== "claude"
  ) {
    agentSet.add("claude" as AgentId);
  }

  /**
   * One `--version` spawn per distinct agent binary, memoized (issue #839).
   *
   * The arbiter-candidate diagnostics below ask about the same agents the role
   * checks above already probed, and §8.3's candidate list can name every one of
   * them; without memoization an enabled dispute config would re-spawn each CLI
   * once per candidate. Several checks may still REPORT the same probe — that is
   * a reporting choice — but the process is only ever run once per agent.
   */
  const cliProbes = new Map<AgentId, CliProbeOutcome>();
  const probeAgentCli = (agent: AgentId): CliProbeOutcome => {
    const cached = cliProbes.get(agent);
    if (cached) return cached;
    const bin = agent === "gemini" ? (process.env["ANTIGRAVITY_BIN"] ?? "agy") : agent;
    const result = probeStub.get(agent) ?? probe(bin, ["--version"]);
    cliProbes.set(agent, result);
    return result;
  };

  /**
   * Report one agent-CLI probe (issue #897).
   *
   * A transient outcome is still `ok: false` — doctor did not manage to verify
   * the CLI, and saying otherwise would be its own lie — but it is labelled
   * `transient` and its message says the probe, not the CLI, is what failed.
   * That is the difference between "install claude" and "re-run when the box is
   * quieter", and getting it wrong is what #897 exists to fix.
   */
  const pushCliCheck = (name: string, agent: AgentId, outcome: CliProbeOutcome): void => {
    const bin = agent === "gemini" ? (process.env["ANTIGRAVITY_BIN"] ?? "agy") : agent;
    checks.push({
      name,
      category: "aiCli",
      ok: outcome.ok,
      ...(outcome.transient ? { transient: true } : {}),
      ...(outcome.ok
        ? { detail: `${outcome.output.split("\n")[0]}${outcome.stubbed ? " [stubbed probe]" : ""}` }
        : { error: describeProbeOutcome(bin, outcome) }),
    });
  };

  for (const agent of agentSet) {
    pushCliCheck(`${agent}Cli`, agent, probeAgentCli(agent));
  }

  if (reviewAgent === "gemini" && VALID_AGENTS.includes(reviewAgent as AgentId)) {
    pushCliCheck("geminiReviewCli", "gemini", probeAgentCli("gemini"));
  }

  // NOTE (issue #292): the research agent's CLI probe is emitted by the shared
  // agentSet loop above (researchAgent is added to agentSet under the same guard
  // used here). A separate `${researchAgent}Cli` check here would duplicate that
  // probe — e.g. a Gemini research agent already yields one `geminiCli` check —
  // so no research-specific probe is emitted.

  // ---- Review-dispute arbiter checks (issue #839, contract §8.3) ----
  //
  // Diagnosed only for an ENABLED dispute configuration: with the protocol off no
  // lineage can ever reach arbitration, so an unconfigured arbiter is not a
  // finding. Read-only throughout — the candidate resolver is handed the
  // availability facts `probeAgentCli` already produced and never spawns
  // anything of its own, and nothing here resolves an actual task.
  const disputeRaw = session["reviewDispute"];
  const disputeEnabled =
    typeof disputeRaw === "object"
    && disputeRaw !== null
    && !Array.isArray(disputeRaw)
    && (disputeRaw as Record<string, unknown>)["enabled"] === true;
  if (disputeEnabled) {
    const skip = (name: string, why: string): void => {
      checks.push({ name, category: "aiCli", ok: false, error: `Skipped: ${why}` });
    };

    // ---- Reviewer reconsideration capability (issues #1073, #1085) ----
    //
    // Independent of the arbiter's own configuration: whether the reviewer can
    // take the §4.1 reconsideration turn is a property of `reviewAgent` and this
    // session's §17.6 D2 opt-in (contract §8.2, §17.5 B2, §17.16), so it is
    // reported before arbiter resolution and never folded into it.
    // `reviewAgentCli`'s absence above already means this reviewer can run the
    // structured review turn (D1, §17.11) — that is NOT evidence it can also
    // reconsider a disputed finding it raised: a Codex reviewer passes the first
    // and, without the opt-in, fails the second. Reported only when `reviewAgent`
    // itself resolves, the same guard the arbiter checks below use.
    //
    // The opt-in is read from the RAW session object rather than from the
    // resolved settings below, because this check is emitted even when the rest
    // of the reviewDispute configuration does not resolve — and an unreadable or
    // non-boolean value reads as absent here, which is the same fail-closed
    // direction `resolveReviewDisputeSettings` takes before refusing it outright.
    const disputeReconsideration = (disputeRaw as Record<string, unknown>)["reconsideration"];
    const readBoundedOptIn =
      typeof disputeReconsideration === "object"
      && disputeReconsideration !== null
      && !Array.isArray(disputeReconsideration)
      && (disputeReconsideration as Record<string, unknown>)["readBounded"] === true;
    const reviewRoleOk =
      !!reviewAgent
      && VALID_AGENTS.includes(reviewAgent as AgentId)
      && REVIEW_SUPPORTED.includes(reviewAgent as AgentId);
    if (!reviewRoleOk) {
      skip("reviewerReconsiderationCapability", "the session's default review agent is unusable (see reviewAgentCli above)");
    } else {
      const support = reconsiderationAgentSupport(reviewAgent, { readBounded: readBoundedOptIn });
      checks.push({
        name: "reviewerReconsiderationCapability",
        category: "aiCli",
        ok: support.supported,
        ...(support.supported
          ? {
              detail:
                `${reviewAgent} may take the reviewer's §4.1 reconsideration turn under the `
                + `\`${support.toolPolicy ?? "no-tools"}\` posture (contract §8.2, §17.16): ${support.reason}`
                + (support.toolPolicy === "read-bounded"
                  ? " Every lineage this reviewer decides records that posture permanently; to roll it back, set "
                    + "reviewDispute.reconsideration.readBounded to false, which restores the fail-closed park "
                    + "without touching any recorded lineage."
                  : ""),
            }
          : {
              error:
                `${support.reason} A finding this reviewer raises can still be disputed and rebutted; only the `
                + "reconsideration turn itself is affected, and it fails closed as `profile_unavailable` and parks "
                + "the task at `ready_for_human` (contract §15 G2; docs/review-dispute-operations.md §8, §10.1) "
                + "rather than running. That is a different stop from an unavailable independent arbiter "
                + "(`arbiterSelection` below, contract §7 row 19): configuring an arbiter does not change this "
                + "answer, and this answer does not mean arbitration is unavailable for a different reviewer."
                + (support.optIn === undefined
                  ? ""
                  : ` The one setting that would change this answer is \`${support.optIn}: true\`, and what it `
                    + "admits is the weaker read-bounded posture, not the §8.2 one."),
            }),
      });
    }

    const resolvedDispute = resolveReviewDisputeSettings(disputeRaw as ReviewDisputeConfig);
    if (!resolvedDispute.ok) {
      checks.push({
        name: "arbiterConfig",
        category: "aiCli",
        ok: false,
        error:
          `reviewDispute configuration is invalid: ${resolvedDispute.errors.map((e) => e.message).join("; ")}`,
      });
      skip("arbiterCandidates", "reviewDispute configuration is invalid (see arbiterConfig)");
      skip("arbiterSelection", "reviewDispute configuration is invalid (see arbiterConfig)");
    } else {
      const policy = resolvedDispute.settings.arbiter;
      if (policy.providers.length === 0) {
        checks.push({
          name: "arbiterConfig",
          category: "aiCli",
          ok: false,
          error:
            "reviewDispute.enabled is true but reviewDispute.arbiter.providers is empty; with no candidate "
            + "every arbitration escalates to a human (contract §8.3, §7 row 19). List the agent ids that may "
            + `arbitrate, e.g. "arbiter": { "providers": ["claude", "codex"] }`,
        });
      } else {
        checks.push({
          name: "arbiterConfig",
          category: "aiCli",
          ok: true,
          detail:
            `${policy.providers.length} candidate(s) in order: ${policy.providers.join(", ")}; `
            + `allowSameProvider: ${policy.allowSameProvider}; minConfidence: ${policy.minConfidence}`,
        });
      }
      // §8.3 measures a candidate against the IMPLEMENTER and the REVIEWER. A
      // doctor run has no task, so it answers the question for the session's
      // configured/default parties; a task whose assignment or review run
      // resolved elsewhere is measured against those at arbitration time.
      const implOk =
        !!implementationAgent
        && VALID_AGENTS.includes(implementationAgent as AgentId)
        && IMPLEMENTATION_SUPPORTED.includes(implementationAgent as AgentId);
      const reviewOk =
        !!reviewAgent
        && VALID_AGENTS.includes(reviewAgent as AgentId)
        && REVIEW_SUPPORTED.includes(reviewAgent as AgentId);
      if (!implOk || !reviewOk) {
        const why = "the session's default implementation/review agents are unusable (see the role checks above)";
        skip("arbiterCandidates", why);
        skip("arbiterSelection", why);
      } else {
        const evaluation = evaluateArbiterCandidates({
          policy,
          implementation: { agentId: implementationAgent as AgentId },
          review: { agentId: reviewAgent as AgentId },
          resolveCandidate: createArbiterCandidateResolver({
            config: {
              ...(isRecord(session["codex"]) ? { codex: session["codex"] as CodexConfig } : {}),
              ...(isRecord(session["research"]) && isRecord((session["research"] as Record<string, unknown>)["antigravity"])
                ? {
                    antigravity: (session["research"] as Record<string, unknown>)[
                      "antigravity"
                    ] as AntigravityResearchConfig,
                  }
                : {}),
            },
            // A probe that never answered is reported as `indeterminate`, not as
            // a negative answer (issue #897): the candidate is still refused —
            // doctor cannot promise an arbiter it could not verify — but under a
            // reason code that says "ask again", not "this CLI is missing".
            cliAvailable: (agent): ArbiterCliAvailability => {
              const outcome = probeAgentCli(agent);
              if (outcome.ok) return "available";
              return outcome.transient ? "indeterminate" : "unavailable";
            },
          }),
        });
        // Resolution-level problems: the candidate could not become an invocable
        // profile at all. Provider overlap is deliberately NOT one of them — a
        // candidate rejected for sharing a provider is correctly configured and
        // correctly refused, and it belongs in the selection check below.
        const unusable = evaluation.rejections.filter((r) => UNUSABLE_ARBITER_REASONS.has(r.reason));
        const tried = evaluation.rejections.filter((r) => r.reason !== "candidate-limit-exceeded").length
          + (evaluation.selected === null ? 0 : 1);
        if (unusable.length > 0) {
          // An indeterminate probe (#897) is not a diagnosis, so the finding says
          // so and marks the whole check transient — an operator (or an automated
          // reader) must not act on it as if a CLI were missing.
          const indeterminate = unusable.some((r) => r.reason === "cli-probe-indeterminate");
          checks.push({
            name: "arbiterCandidates",
            category: "aiCli",
            ok: false,
            ...(indeterminate ? { transient: true } : {}),
            error:
              `Unusable arbiter candidate(s): ${describeArbiterRejections(unusable)}`
              + (indeterminate
                ? ". `cli-probe-indeterminate` means the availability probe never answered (timeout or refused "
                  + "fork) — it is NOT evidence that the CLI is missing. Re-run session-doctor when the host is "
                  + "less loaded before changing any configuration."
                : ""),
          });
        } else {
          checks.push({
            name: "arbiterCandidates",
            category: "aiCli",
            ok: true,
            detail:
              `${tried} of ${policy.providers.length} candidate(s) evaluated; none unusable`
              + " (evaluation stops at the first acceptable candidate)",
          });
        }
        const impl = evaluation.implementation;
        const rev = evaluation.review;
        const parties = `implementation ${impl.agentId}/${impl.provider}, review ${rev.agentId}/${rev.provider}`;
        if (evaluation.selected !== null) {
          const selected = evaluation.selected;
          checks.push({
            name: "arbiterSelection",
            category: "aiCli",
            ok: true,
            detail:
              `${selected.agentId}/${selected.provider}`
              + `${selected.model === undefined ? "" : ` model ${selected.model}`}`
              + `${selected.effort === undefined ? "" : ` effort ${selected.effort}`}`
              + `${selected.maxBudgetUsd === undefined ? "" : ` budget ${selected.maxBudgetUsd}`}`
              + ` for ${parties}; sameProviderFallback: ${selected.sameProviderFallback}`,
          });
        } else {
          checks.push({
            name: "arbiterSelection",
            category: "aiCli",
            ok: false,
            error:
              `No acceptable independent arbiter for ${parties}: `
              + `${describeArbiterRejections(evaluation.rejections) || "no candidates configured"}. `
              + "Every arbitration would escalate to a human (contract §8.3, §7 row 19). Add a candidate whose "
              + "provider differs from both parties, or set reviewDispute.arbiter.allowSameProvider to true with "
              + "a candidate whose model is provably different from both."
              // A doctor run has no task, so it holds no resolved implementation
              // or review profile to read a model off. Said plainly rather than
              // left to look like a configuration defect: at arbitration time the
              // parties' actual models ARE known, and the same candidate may well
              // be accepted then.
              + (evaluation.rejections.some((r) => r.reason === "same-provider-model-unknown")
                ? " Note: a session-level check cannot prove a same-provider candidate differs by model, because"
                  + " the parties' resolved models are only known once the implementation and review runs exist."
                : "")
              // Issue #965: without this, the two remedies above read as things
              // an operator can do, and for the commonest configuration neither
              // is. §8.2 makes this runner the enforcement point of the arbiter's
              // no-tool boundary, so a candidate it has no verified read-only
              // invocation for is refused before independence is even measured —
              // and it has one for `claude` alone. Naming that turns "add another
              // provider" (which will be refused the same way) into the real
              // answer: this needs a runner change, or the session accepts row 19.
              + (evaluation.rejections.some((r) => r.reason === "unsupported-role")
                ? " Note: `unsupported-role` means this runner has no VERIFIED no-tools invocation for that agent"
                  + " (contract §8.2), which is checked before independence is. Today that invocation is defined"
                  + " for `claude` only, so a session whose parties are both Anthropic has no acceptable candidate"
                  + " at all and every arbitration escalates through row 19 until a verified invocation for"
                  + " another CLI is added to this runner."
                : ""),
          });
        }
      }
    }
  }

  // ---- Storage checks ----

  checks.push(checkSqliteHealth(dbPath));

  // ---- Worktree checks ----
  //
  // The worktree-disabled/shared-checkout warning belongs to the worktree-only
  // migration ramp (a separate concern — see the `worktrees.enabled` die() above,
  // which already hard-fails that case post-migration) and is deliberately not
  // duplicated here (issue #695).

  checks.push(checkWorktreeStateRoot(sessionWorktreeRootOverride));

  // ---- Registry checks (issue #823) ----
  //
  // The registry independently validates every entry in sessions.json and
  // quarantines invalid/ambiguous ones without failing the whole file. Surface
  // that here: whether THIS session loads cleanly (affects allPassed, since it
  // directly determines whether the loop can run it) versus whether OTHER
  // entries elsewhere in the file have diagnostics (informational only — a
  // problem confined to an unrelated session must not fail this session's
  // doctor run).
  {
    let registry: JsonSessionRegistry | undefined;
    let registryError: string | undefined;
    try {
      registry = new JsonSessionRegistry(sessionsPath);
    } catch (err) {
      registryError = err instanceof Error ? err.message : String(err);
    }

    if (registry) {
      const diagnostics = registry.getDiagnostics();
      const ownDiagnostics = diagnostics.filter((d) => d.indices.includes(sessionIndex));
      const otherDiagnostics = diagnostics.filter((d) => !d.indices.includes(sessionIndex));
      checks.push({
        name: "registryEntryValid",
        category: "registry",
        ok: ownDiagnostics.length === 0,
        ...(ownDiagnostics.length === 0
          ? { detail: `session "${sessionId}" loads cleanly in the session registry` }
          : { error: ownDiagnostics.map((d) => d.message).join(" ") }),
      });
      checks.push({
        name: "registryDiagnostics",
        category: "registry",
        // Never fails allPassed: a diagnostic on a different session entry is
        // that session's problem, not this one's (issue #823).
        ok: true,
        detail:
          otherDiagnostics.length === 0
            ? "no other session registry entries have diagnostics"
            : `${otherDiagnostics.length} other session registry entr${otherDiagnostics.length === 1 ? "y has" : "ies have"} ` +
              `a diagnostic: ${otherDiagnostics.map((d) => d.message).join(" | ")}`,
      });
    } else {
      checks.push({
        name: "registryEntryValid",
        category: "registry",
        ok: false,
        error: registryError ?? "Failed to load the session registry",
      });
    }
  }

  const allPassed = checks.every((c) => c.ok);

  const suggestions: string[] = [];
  const envPrepare = session["environmentPrepare"];
  if (!envPrepare || typeof envPrepare !== "object") {
    suggestions.push(
      "environmentPrepare is not configured. Use `admin session preset list` to see available ecosystem presets, or add an environmentPrepare block manually.",
    );
  }
  const verificationCmds = session["verification"];
  if (
    !verificationCmds ||
    typeof verificationCmds !== "object" ||
    Object.keys(verificationCmds).length === 0
  ) {
    suggestions.push(
      "No verification commands are configured. Consider adding verification commands or applying a preset with `admin session preset show <name>`.",
    );
  }

  emit({ ok: true, sessionId, checks, allPassed, suggestions });
}

// ---------------------------------------------------------------------------
// Subcommand: repo-lock acquire / release
// ---------------------------------------------------------------------------

interface RepoLockArgs {
  contextId: string;
  dbPath: string | undefined;
  lockDir: string | undefined;
}

function parseRepoLockArgs(argv: string[]): RepoLockArgs | { error: string } {
  const tokenized = tokenizeArgs(argv, {
    valueFlags: ["context-id", "db-path", "lock-dir"],
  });
  if ("error" in tokenized) return { error: tokenized.error };
  const { args } = tokenized;
  if (!args["context-id"]) return { error: "--context-id is required" };
  return {
    contextId: args["context-id"],
    dbPath: args["db-path"],
    lockDir: args["lock-dir"],
  };
}

function resolveSessionIdFromContext(contextId: string, dbPath: string | undefined): string {
  const ctxStore = new SqliteContextStore(dbPath);
  const sessionId = ctxStore.getSessionId(contextId);
  ctxStore.close();
  if (!sessionId) die(`Context not found: ${contextId}`);
  return sessionId;
}

function runRepoLockAcquire(argv: string[]): void {
  const parsed = parseRepoLockArgs(argv);
  if ("error" in parsed) die(parsed.error);

  const { contextId, dbPath, lockDir } = parsed;
  const sessionId = resolveSessionIdFromContext(contextId, dbPath);
  const lockStore = new RepoLockStore(lockDir);
  const result = lockStore.acquire(contextId, sessionId);
  emit(result as unknown as Record<string, unknown>);
}

function runRepoLockRelease(argv: string[]): void {
  const parsed = parseRepoLockArgs(argv);
  if ("error" in parsed) die(parsed.error);

  const { contextId, dbPath, lockDir } = parsed;
  const sessionId = resolveSessionIdFromContext(contextId, dbPath);
  const lockStore = new RepoLockStore(lockDir);
  const result = lockStore.release(contextId, sessionId);
  emit(result as unknown as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// Subcommand: repo-lock status / force-release
// ---------------------------------------------------------------------------

interface RepoLockStatusArgs {
  sessionId: string;
  lockDir: string | undefined;
}

function parseRepoLockStatusArgs(argv: string[]): RepoLockStatusArgs | { error: string } {
  const tokenized = tokenizeArgs(argv, {
    valueFlags: ["session-id", "session-ref", "sessions-path", "lock-dir"],
  });
  if ("error" in tokenized) return { error: tokenized.error };
  const { args } = tokenized;
  const selector = resolveSessionSelector(args);
  if ("error" in selector) return { error: selector.error };
  return {
    sessionId: selector.sessionId,
    lockDir: args["lock-dir"],
  };
}

function runRepoLockStatus(argv: string[]): void {
  const parsed = parseRepoLockStatusArgs(argv);
  if ("error" in parsed) die(parsed.error);

  const { sessionId, lockDir } = parsed;
  const lockStore = new RepoLockStore(lockDir);
  const result = lockStore.inspect(sessionId);
  emit({
    ok: true,
    sessionId,
    locked: result.locked,
    contextId: result.contextId,
    startedAt: result.startedAt,
    ageMs: result.ageMs,
    stale: result.stale,
    lockPath: result.lockPath,
  });
}

interface RepoLockForceReleaseArgs {
  sessionId: string;
  contextId: string | undefined;
  lockDir: string | undefined;
  yes: boolean;
}

function parseRepoLockForceReleaseArgs(argv: string[]): RepoLockForceReleaseArgs | { error: string } {
  const tokenized = tokenizeArgs(argv, {
    booleanFlags: ["yes"],
    valueFlags: ["session-id", "context-id", "lock-dir"],
  });
  if ("error" in tokenized) return { error: tokenized.error };
  const { args, flags } = tokenized;
  if (!args["session-id"]) return { error: "--session-id is required" };
  return {
    sessionId: args["session-id"],
    contextId: args["context-id"],
    lockDir: args["lock-dir"],
    yes: flags.has("yes"),
  };
}

function runRepoLockForceRelease(argv: string[]): void {
  const parsed = parseRepoLockForceReleaseArgs(argv);
  if ("error" in parsed) die(parsed.error);

  const { sessionId, contextId, lockDir, yes } = parsed;

  if (!yes) {
    die("--yes is required to force-release a lock. Inspect with 'repo-lock status' first.");
  }

  const lockStore = new RepoLockStore(lockDir);
  const result = lockStore.forceRelease(sessionId, contextId);
  emit({
    ok: true,
    sessionId,
    released: result.released,
    ...(result.released
      ? { wasStale: result.wasStale, ownerContextId: result.ownerContextId }
      : {
          reason: result.reason,
          ...(result.ownerContextId !== undefined ? { ownerContextId: result.ownerContextId } : {}),
        }),
  });
}

interface LoadedSessionInfo {
  sessionId: string;
  repoRoot: string;
  artifactRoot: string;
  artifactDir: string;
  baseBranch: string;
  /**
   * Raw per-session worktree root override from the session file (if any).
   * Deliberately left UNresolved here: {@link resolveWorktreeRoot} throws on a
   * misconfigured (relative) session/env override, and most admin commands
   * never touch worktrees. Worktree subcommands resolve it lazily via
   * {@link resolveSessionWorktreeRoot} so that configuration error only
   * surfaces for callers that actually need it.
   */
  sessionWorktreeRoot: string | undefined;
}

function loadSessionInfo(
  sessionId: string,
  sessionsPath: string,
): LoadedSessionInfo | { error: string } {
  if (!existsSync(sessionsPath)) {
    return { error: `Sessions file not found: ${sessionsPath}` };
  }
  let fileContent: { sessions?: unknown };
  try {
    fileContent = JSON.parse(readFileSync(sessionsPath, "utf8")) as { sessions?: unknown };
  } catch {
    return { error: `Failed to parse sessions file: ${sessionsPath}` };
  }
  if (!Array.isArray(fileContent.sessions)) {
    return { error: "sessions.json does not contain a sessions array" };
  }
  const sessions = fileContent.sessions as Array<Record<string, unknown>>;
  const session = sessions.find((s) => s !== null && typeof s === "object" && s["sessionId"] === sessionId);
  if (!session) {
    return { error: `Unknown sessionId: ${sessionId}` };
  }
  const repoRoot = typeof session["repoRoot"] === "string" ? session["repoRoot"] : "";
  if (!repoRoot) {
    return { error: `Session ${sessionId} has no repoRoot configured` };
  }
  const artifactDir = typeof session["artifactDir"] === "string" ? session["artifactDir"] : "";
  if (!artifactDir) {
    return { error: `Session ${sessionId} has no artifactDir configured` };
  }
  const baseBranch = typeof session["baseBranch"] === "string" ? session["baseBranch"] : "main";
  const worktrees =
    session["worktrees"] && typeof session["worktrees"] === "object"
      ? (session["worktrees"] as Record<string, unknown>)
      : undefined;
  const sessionWorktreeRoot =
    worktrees && typeof worktrees["root"] === "string" ? (worktrees["root"] as string) : undefined;
  return {
    sessionId,
    repoRoot,
    artifactRoot: resolve(repoRoot, artifactDir),
    artifactDir,
    baseBranch,
    sessionWorktreeRoot,
  };
}

/**
 * Resolve the managed worktree state root for worktree subcommands, honoring the
 * per-session override (then env/global default). Kept separate from
 * {@link loadSessionInfo} so the relative-root validation error only fails
 * commands that actually use worktrees.
 */
function resolveSessionWorktreeRoot(info: LoadedSessionInfo): string {
  return resolveWorktreeRoot({ sessionRoot: info.sessionWorktreeRoot });
}

// ---------------------------------------------------------------------------
// Subcommand: worktree list / worktree prune (issue #400)
//
// Inspect and clean up the per-issue git worktrees that isolate one issue's
// working tree from the rest of the session. `list` reports every worktree
// registered against the session's canonical repo, flagging which belong to this
// session's managed state root. `prune` removes a single issue's worktree; it
// refuses a dirty worktree unless `--force` is given and requires `--yes` to
// actually remove (otherwise it previews). Worktree paths are local-only and
// never published — these commands print them to the operator's stdout only.
// ---------------------------------------------------------------------------

interface WorktreeListArgs {
  sessionId: string;
  sessionsPath: string;
}

function parseWorktreeListArgs(argv: string[]): WorktreeListArgs | { error: string } {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i].startsWith("--")) {
      args[argv[i].slice(2)] = argv[i + 1];
      i++;
    }
  }
  if (!args["session-id"]) return { error: "--session-id is required" };
  return {
    sessionId: args["session-id"],
    sessionsPath: args["sessions-path"] ?? DEFAULT_SESSIONS_PATH,
  };
}

function runWorktreeList(argv: string[]): void {
  const parsed = parseWorktreeListArgs(argv);
  if ("error" in parsed) die(parsed.error);

  const { sessionId, sessionsPath } = parsed;
  const sessionInfo = loadSessionInfo(sessionId, sessionsPath);
  if ("error" in sessionInfo) die(sessionInfo.error);

  const { repoRoot } = sessionInfo;
  let worktreeRoot: string;
  try {
    worktreeRoot = resolveSessionWorktreeRoot(sessionInfo);
  } catch (err) {
    die(err instanceof Error ? err.message : String(err));
  }
  // git reports canonical (symlink-resolved) worktree paths, so canonicalize the
  // configured roots before comparing to flag managed/canonical worktrees.
  const canonicalRepoRoot = canonicalizePath(repoRoot);
  // Build the prefix with the same segment-encoding helper used by
  // `issueWorktreePath` so dot-only session IDs (`.`/`..`, encoded as
  // `%2E`/`%2E%2E`) match the real on-disk worktree directory instead of a raw
  // `encodeURIComponent` form that leaves the dots intact.
  const sessionPrefix = canonicalizePath(sessionWorktreeDir(worktreeRoot, sessionId)) + "/";

  const listed = listWorktrees(repoRoot);
  if (!listed.ok) die(listed.error);

  const worktrees = listed.worktrees.map((w) => ({
    path: w.path,
    branch: w.branch ?? null,
    head: w.head ?? null,
    detached: w.detached,
    locked: w.locked,
    prunable: w.prunable,
    // Managed = lives under this session's worktree state root (a per-issue
    // worktree this workflow created), vs. the canonical checkout or an
    // unrelated worktree the operator added by hand.
    managed: w.path === canonicalRepoRoot ? false : canonicalizePath(w.path).startsWith(sessionPrefix),
    isCanonical: canonicalizePath(w.path) === canonicalRepoRoot,
  }));

  emit({
    ok: true,
    sessionId,
    repoRoot,
    worktreeRoot,
    count: worktrees.length,
    worktrees,
  });
}

interface WorktreePruneArgs {
  sessionId: string;
  issueNumber: number;
  sessionsPath: string;
  yes: boolean;
  force: boolean;
  /** Target the issue's leaked per-run research checkouts instead of `issue-<n>/repo`. */
  research: boolean;
  lockDir?: string;
}

function parseWorktreePruneArgs(argv: string[]): WorktreePruneArgs | { error: string } {
  const args: Record<string, string> = {};
  let yes = false;
  let force = false;
  let research = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--yes") {
      yes = true;
    } else if (argv[i] === "--force") {
      force = true;
    } else if (argv[i] === "--research") {
      research = true;
    } else if (argv[i].startsWith("--") && i + 1 < argv.length) {
      args[argv[i].slice(2)] = argv[i + 1];
      i++;
    }
  }
  if (!args["session-id"]) return { error: "--session-id is required" };
  if (args["issue-number"] === undefined) return { error: "--issue-number is required" };
  const n = Number(args["issue-number"]);
  if (!Number.isInteger(n) || n <= 0) {
    return { error: `--issue-number must be a positive integer, got: ${args["issue-number"]}` };
  }
  return {
    sessionId: args["session-id"],
    issueNumber: n,
    sessionsPath: args["sessions-path"] ?? DEFAULT_SESSIONS_PATH,
    yes,
    force,
    research,
    lockDir: args["lock-dir"],
  };
}

/**
 * `worktree prune --research`: remove the leaked per-run research checkouts
 * (`issue-<n>/research-<runId>`) for ONE issue (issue #855).
 *
 * Research runs in a throwaway detached checkout that its own handler removes on
 * every normal exit path. A process killed mid-run leaks that directory, and
 * nothing else can reclaim it: a retry allocates a fresh run id, so it creates a
 * new path rather than reusing the abandoned one. The durable-worktree prune
 * above cannot help — it addresses exactly `issue-<n>/repo` — so this is the
 * targeted per-issue route, complementing the session-wide sweep in
 * `worktree cleanup`.
 *
 * Lock-aware, unlike the durable prune: the issue lock is the one interlock that
 * distinguishes "a research run is in flight right now" from "a research run
 * died here", and removing a live run's checkout out from under it would break
 * the run. A live lock is therefore refused (reported, exit 0) unless `--force`.
 * Removal itself always forces, because the checkout is disposable by
 * construction — detached at a fetched base commit, owning no branch, so
 * anything in the tree is agent scratch.
 */
function runResearchWorktreePrune(
  parsed: WorktreePruneArgs,
  ctx: { repoRoot: string; worktreeRoot: string },
): void {
  const { sessionId, issueNumber, yes, force, lockDir } = parsed;
  const { repoRoot, worktreeRoot } = ctx;

  const sessionPrefix = canonicalizePath(sessionWorktreeDir(worktreeRoot, sessionId)) + "/";
  const listed = listWorktrees(repoRoot);
  if (!listed.ok) die(listed.error);

  const matches = listed.worktrees
    .map((w) => {
      const cp = canonicalizePath(w.path);
      if (!cp.startsWith(sessionPrefix)) return null;
      const classified = classifyManagedWorktree(cp.slice(sessionPrefix.length));
      if (!classified || classified.kind !== "research") return null;
      if (classified.issueNumber !== issueNumber) return null;
      return { path: cp, runId: classified.runId };
    })
    .filter((m): m is { path: string; runId: string } => m !== null);

  // Checked before the lock so an issue with nothing leaked reports the plain
  // no-op rather than a lock refusal that implies something was left alone.
  if (matches.length === 0) {
    // Safe no-op: nothing to remove. Exit 0 per the admin contract.
    emit({
      ok: true,
      sessionId,
      issueNumber,
      research: true,
      dryRun: !yes,
      examined: 0,
      removed: [],
      skipped: [],
      reason: "not_found",
    });
    return;
  }

  const lockHeld = new IssueWorktreeLock(lockDir).inspect(sessionId, issueNumber).locked;
  if (lockHeld && !force) {
    emit({
      ok: true,
      sessionId,
      issueNumber,
      research: true,
      dryRun: !yes,
      examined: matches.length,
      removed: [],
      skipped: matches.map((m) => ({
        ...m,
        reason: "locked (live issue lock — a research run may be active)",
      })),
      hint: "A live issue lock is held; re-run with --force only when certain no research run is active.",
    });
    return;
  }

  if (!yes) {
    emit({
      ok: true,
      sessionId,
      issueNumber,
      research: true,
      dryRun: true,
      examined: matches.length,
      wouldRemove: matches,
      removed: [],
      skipped: [],
      hint: "Re-run with --yes to remove these leaked research checkouts.",
    });
    return;
  }

  const removed: Array<{ path: string; runId: string }> = [];
  const errors: Array<{ path: string; runId: string; error: string }> = [];
  for (const match of matches) {
    const result = removeWorktree(repoRoot, match.path, { force: true });
    if (result.ok) removed.push(match);
    else errors.push({ ...match, error: result.error });
  }

  emit({
    ok: errors.length === 0,
    sessionId,
    issueNumber,
    research: true,
    dryRun: false,
    examined: matches.length,
    removed,
    skipped: [],
    ...(errors.length > 0 ? { errors } : {}),
  });
  if (errors.length > 0) process.exitCode = 1;
}

function runWorktreePrune(argv: string[]): void {
  const parsed = parseWorktreePruneArgs(argv);
  if ("error" in parsed) die(parsed.error);

  const { sessionId, issueNumber, sessionsPath, yes, force } = parsed;
  const sessionInfo = loadSessionInfo(sessionId, sessionsPath);
  if ("error" in sessionInfo) die(sessionInfo.error);

  const { repoRoot } = sessionInfo;
  let worktreeRoot: string;
  try {
    worktreeRoot = resolveSessionWorktreeRoot(sessionInfo);
  } catch (err) {
    die(err instanceof Error ? err.message : String(err));
  }

  if (parsed.research) {
    runResearchWorktreePrune(parsed, { repoRoot, worktreeRoot });
    return;
  }

  // Canonicalize to match git's symlink-resolved worktree paths.
  const path = canonicalizePath(issueWorktreePath(worktreeRoot, sessionId, issueNumber));

  const listed = listWorktrees(repoRoot);
  if (!listed.ok) die(listed.error);
  const entry = listed.worktrees.find((w) => canonicalizePath(w.path) === path);

  if (!entry) {
    // Safe no-op: nothing to remove. Exit 0 per the admin contract.
    emit({ ok: true, sessionId, issueNumber, path, removed: false, reason: "not_found" });
    return;
  }

  if (!yes) {
    emit({
      ok: true,
      sessionId,
      issueNumber,
      path,
      removed: false,
      wouldRemove: true,
      branch: entry.branch ?? null,
      hint: "Re-run with --yes to remove this worktree (add --force to discard a dirty/locked worktree).",
    });
    return;
  }

  const result = removeWorktree(repoRoot, path, { force });
  if (!result.ok) die(result.error);
  emit({ ok: true, sessionId, issueNumber, path, removed: true, forced: force });
}

// ---------------------------------------------------------------------------
// Subcommand: status (issue #406)
//
// A single worktree-aware status surface for an operator. For a session (and
// optionally a single issue) it joins the SQLite task state with the live branch
// (local + remote-tracking), PR, repo + per-issue lock, and per-issue worktree
// state, then classifies each issue (runnable / blocked / waiting on a Tool
// Request / failed / capped / stale / needs human / done / no task) and suggests
// the obvious next operator action — including the #404 class of failure where a
// local branch exists with no remote branch, PR, or worktree.
//
// Output is human-readable by default and structured JSON with --json. Done
// tasks are hidden unless --all or an explicit --issue-number is given. Public
// output never carries absolute local paths: worktrees are identified by their
// stable id / root-relative path, and lock file paths are omitted.
// ---------------------------------------------------------------------------

type StatusClassification =
  | "runnable"
  | "waiting_retry"
  | "running"
  | "stale"
  | "blocked"
  | "waiting_for_tool_request"
  | "capped"
  | "needs_human"
  | "failed"
  | "done"
  | "cancelled"
  | "no_task";

const STATUS_LABELS: Record<StatusClassification, string> = {
  runnable: "RUNNABLE",
  waiting_retry: "WAITING (retry backoff)",
  running: "RUNNING",
  stale: "STALE",
  blocked: "BLOCKED (dependency)",
  waiting_for_tool_request: "WAITING (tool request)",
  capped: "CAPPED (review loop)",
  needs_human: "NEEDS HUMAN",
  failed: "FAILED",
  done: "DONE",
  cancelled: "CANCELLED",
  no_task: "NO TASK",
};

interface StatusArgs {
  sessionId: string;
  issueNumber: number | undefined;
  sessionsPath: string;
  dbPath: string | undefined;
  lockDir: string | undefined;
  worktreeLockDir: string | undefined;
  all: boolean;
  /**
   * Live-query the repo host for a matching open PR when a single issue's task
   * context lacks a persisted `prUrl` (issue #1002). Opt-in and restricted to an
   * explicit `--issue-number`: unlike every other field on `StatusEntry`, this
   * one reaches an external service, so it must never fire as a side effect of a
   * routine bulk `status` call.
   */
  discoverPr: boolean;
}

function parseStatusArgs(argv: string[]): StatusArgs | { error: string } {
  const opts = parseCommonOptions(argv, {
    session: "required",
    issueNumber: "optional",
    booleanFlags: ["all", "discover-pr"],
    valueFlags: ["lock-dir", "worktree-lock-dir"],
  });
  if ("error" in opts) return { error: opts.error };
  return {
    sessionId: opts.sessionId,
    issueNumber: opts.issueNumber,
    sessionsPath: opts.sessionsPath,
    dbPath: opts.dbPath,
    lockDir: opts.args["lock-dir"],
    worktreeLockDir: opts.args["worktree-lock-dir"],
    all: opts.flags.has("all"),
    discoverPr: opts.flags.has("discover-pr"),
  };
}

/** True when the issue branch ref resolves in the canonical repo. */
function gitRefExists(repoRoot: string, ref: string): boolean {
  return probe("git", ["rev-parse", "--verify", "--quiet", ref], repoRoot).ok;
}

/** Open dependency issue numbers recorded on a blocked task, if any. */
function openBlockerNumbers(task: AiTask | null): number[] {
  if (!task) return [];
  const candidates: unknown[] = [
    (task.context["dependencyRecheck"] as Record<string, unknown> | undefined)?.["blockedBy"],
    task.context["blockedBy"],
  ];
  for (const list of candidates) {
    if (Array.isArray(list)) {
      // Blocked tasks store the `BlockedByEntry` shape (`issueNumber`, `state`)
      // recorded by the dependency recheck. Fall back to `number` only for any
      // legacy/alternate snapshot that used the GraphQL node field name.
      return list
        .filter(
          (b): b is Record<string, unknown> =>
            Boolean(b) &&
            typeof b === "object" &&
            (b as Record<string, unknown>)["state"] === "open",
        )
        .map((b) => {
          const n = b["issueNumber"] ?? b["number"];
          return typeof n === "number" ? n : NaN;
        })
        .filter((n) => Number.isFinite(n));
    }
  }
  return [];
}

function classifyStatus(task: AiTask | null, now: string): StatusClassification {
  if (!task) return "no_task";
  const tr = readStoredToolRequest(task);
  const hasOpenToolRequest = Boolean(tr) && tr!["resolved"] !== true;
  switch (task.status) {
    case "done":
      return "done";
    case "cancelled":
      return "cancelled";
    case "failed":
      return "failed";
    case "blocked":
      return "blocked";
    case "queued":
      return task.notBefore && now < task.notBefore ? "waiting_retry" : "runnable";
    case "claimed":
    case "running":
      return isClaimExpired(task, now) ? "stale" : "running";
    case "ready_for_human":
      if (hasOpenToolRequest) return "waiting_for_tool_request";
      if (task.context["reviewLoopCapReached"] === true) return "capped";
      return "needs_human";
    default:
      return "needs_human";
  }
}

interface StatusBranch {
  name: string;
  localExists: boolean;
  remoteTrackingExists: boolean;
}

interface StatusWorktree {
  id: string;
  relativePath: string;
  exists: boolean;
  registered: boolean;
  clean: boolean | null;
  /**
   * When the worktree is dirty (`clean === false`), classifies the dirty state:
   * - `continuation_candidate`: a `dirtyContinuation` marker is recorded in
   *   task context (from a prior verification failure) and the task is not
   *   currently running — the next run will attempt to continue from this state.
   * - `continuation_active`: same marker present and the task is currently
   *   running (the active phase is using the dirty worktree).
   * - `action_required`: worktree is dirty but no continuation marker exists —
   *   operator must inspect and either clean up or discard.
   * - `null`: worktree is absent, clean, or cleanliness is unknown.
   */
  dirtyCategory: "continuation_candidate" | "continuation_active" | "action_required" | null;
}

interface StatusLock {
  held: boolean;
  contextId: string | null;
  startedAt: string | null;
  ageMs: number | null;
  stale: boolean | null;
}

interface StatusEntry {
  issueNumber: number;
  classification: StatusClassification;
  task: {
    status: string;
    phase: string;
    priority: string;
    attempts: TaskAttempts;
    ownerRunId: string | null;
    leaseExpiresAt: string | null;
    notBefore: string | null;
    lastError: string | null;
    updatedAt: string;
  } | null;
  branch: StatusBranch;
  pr: { url: string | null; exists: boolean };
  /**
   * Result of a live repo-host lookup for a PR matching the expected head branch,
   * run only when `--discover-pr` was requested AND `pr.exists` is false — i.e.
   * task context carries no persisted PR identity (issue #1002). `undefined` when
   * discovery was not attempted (the default), so this never appears for a task
   * with complete persisted PR context and existing consumers of `pr` are
   * unaffected.
   */
  discoveredPr?: StatusPrDiscovery;
  worktree: StatusWorktree;
  /** True when the canonical checkout has uncommitted changes; null when git could not be queried. */
  canonicalDirty: boolean | null;
  issueLock: StatusLock;
  suggestedAction: string;
}

/**
 * Outcome of the live PR-discovery lookup (issue #1002). Deliberately separate
 * from `pr` (which reflects ONLY persisted task context): an operator must be
 * able to tell "no PR is recorded" apart from "no PR is recorded, and the repo
 * host confirms none is live either" or "...and one IS live but not recorded".
 *
 * `found` mirrors the same fail-closed reconciliation #998 uses to adopt a PR at
 * implementation time (repository, open state, exact head, configured base, and
 * uniqueness all validated) — this command only ever reports it, never records
 * it. `not-found` covers every refusal reason (`no-match`, `ambiguous`,
 * `head-mismatch`, `not-open`, `cross-repository`, `repository-mismatch`,
 * `base-mismatch`, `unusable-url`, and a raw `lookup-failed`), so a closed,
 * wrong-base, forked, or ambiguous PR is surfaced with an actionable reason
 * rather than silently treated as absent. `error` covers a failure to even
 * resolve the session or repo-host provider needed to ask.
 */
type StatusPrDiscovery =
  | { attempted: true; outcome: "found"; url: string; headRefName: string; number?: number; recommendation: string }
  | { attempted: true; outcome: "not-found"; reason: PrReconciliationRefusal | "lookup-failed"; message: string }
  | { attempted: true; outcome: "error"; message: string };

/**
 * Live-query the repo host for an open PR on the expected head branch of an
 * issue whose task context has no persisted `prUrl` (issue #1002 — the
 * `admin status --issue-number 975` gap where PR #997 existed but was invisible
 * to the operator). Read-only: this never writes task context, labels, or the
 * PR itself — see {@link adoptExistingPrForHead}, which this reuses for the SAME
 * fail-closed reconciliation #998 applies at implementation time, so a status
 * "found" and an implementation-time adoption never disagree.
 */
async function discoverLivePrForStatus(
  sessionId: string,
  sessionsPath: string,
  issueNumber: number,
  head: string,
): Promise<StatusPrDiscovery> {
  let session: ResolvedSession | undefined;
  try {
    session = await new JsonSessionRegistry(sessionsPath).getSessionById(sessionId);
  } catch (err) {
    return {
      attempted: true,
      outcome: "error",
      message: `failed to resolve session '${sessionId}' for PR discovery: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!session) {
    return {
      attempted: true,
      outcome: "error",
      message: `session '${sessionId}' could not be resolved for PR discovery`,
    };
  }

  let sessionRepoHost: SessionRepoHost;
  try {
    sessionRepoHost = await resolveSessionRepoHost(session.repoHostProvider, {
      githubRepo: session.githubRepo,
      cwd: session.repoRoot,
      ghRunnerFallback: defaultGhRunner,
    });
  } catch (err) {
    return {
      attempted: true,
      outcome: "error",
      message: `failed to resolve the repo-host provider for PR discovery: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const base = session.baseBranch ?? "main";
  const adoption = adoptExistingPrForHead(sessionRepoHost.provider, {
    issueNumber,
    head,
    base,
    repo: sessionRepoHost.repoSlug,
  });

  if (adoption.kind === "adopted") {
    return {
      attempted: true,
      outcome: "found",
      url: adoption.url,
      headRefName: adoption.headRefName,
      ...(adoption.number !== undefined ? { number: adoption.number } : {}),
      recommendation:
        `This PR is not recorded in issue #${issueNumber}'s task context. Do not edit task context directly — if the ` +
        `task's current state supports it, retry the implementation phase (e.g. \`admin recover --session-id ${sessionId} ` +
        `--issue-number ${issueNumber}\`) so the run adopts this PR automatically via the same reconciliation issue #998 added.`,
    };
  }
  return { attempted: true, outcome: "not-found", reason: adoption.reason, message: adoption.error };
}

function lockSummary(result: {
  locked: boolean;
  contextId: string | null;
  startedAt: string | null;
  ageMs: number | null;
  stale: boolean | null;
}): StatusLock {
  return {
    held: result.locked,
    contextId: result.contextId,
    startedAt: result.startedAt,
    ageMs: result.ageMs,
    stale: result.stale,
  };
}

function suggestedStatusAction(
  c: StatusClassification,
  entry: { issueNumber: number; branch: StatusBranch; pr: { exists: boolean }; worktree: StatusWorktree; canonicalDirty: boolean | null; task: AiTask | null; issueLock: StatusLock },
  sessionId: string,
  worktreeLockDir?: string,
): string {
  const issueNumber = entry.issueNumber;
  const recover = `admin recover --session-id ${sessionId} --issue-number ${issueNumber}`;
  // `status` inspected a non-default worktree lock dir (`--worktree-lock-dir`), so any
  // `worktree release-lock` we suggest must carry the matching `--lock-dir`; otherwise the
  // follow-up command inspects the default lock dir and leaves the reported lock untouched.
  const lockDirFlag = worktreeLockDir ? ` --lock-dir ${worktreeLockDir}` : "";
  // The #404 fingerprint: a local branch with nothing published and no worktree.
  const orphanLocalBranch =
    entry.branch.localExists &&
    !entry.branch.remoteTrackingExists &&
    !entry.pr.exists &&
    !entry.worktree.exists;
  switch (c) {
    case "runnable":
      return "Queued and ready; the next worker run will claim it.";
    case "waiting_retry":
      return (
        `Delayed after a rate-limit/quota backoff until ${entry.task?.notBefore ?? "(unknown)"}; it will be claimed automatically afterward.` +
        ` To clear the delay immediately: \`admin task clear-delay --session-id ${sessionId} --issue-number ${issueNumber} --yes\`.`
      );
    case "running": {
      const owner = entry.task?.ownerRunId ? ` by ${entry.task.ownerRunId}` : "";
      const lease = entry.task?.leaseExpiresAt ? ` (lease until ${entry.task.leaseExpiresAt})` : "";
      return `Claimed/running${owner}${lease}; no action needed unless the lease expires.`;
    }
    case "stale": {
      // The lease expired, but the per-issue worktree lock may still be present.
      // `worktree release-lock` previews by default and only mutates with `--yes`,
      // so every suggested command must carry it — otherwise the operator copies a
      // command that exits 0 without releasing the lock we just detected. A live
      // (within-TTL) lock is additionally refused unless `--force` is passed, so
      // hint that too rather than suggest a command that no-ops for that state.
      const releaseLock = `admin worktree release-lock --session-id ${sessionId} --issue-number ${issueNumber}${lockDirFlag}`;
      let lockHint = "";
      if (entry.issueLock.stale) {
        lockHint = ` Also release the stale worktree lock: \`${releaseLock} --yes\`.`;
      } else if (entry.issueLock.held) {
        lockHint = ` The worktree lock is still live (within its TTL); if you are certain no run is active, force-release it with \`${releaseLock} --force --yes\`.`;
      }
      return `Lease expired while ${entry.task?.status ?? "active"}; requeue with \`${recover}\`.${lockHint}`;
    }
    case "blocked": {
      const blockers = openBlockerNumbers(entry.task);
      return blockers.length > 0
        ? `Blocked by open dependency issue(s) ${blockers.map((n) => `#${n}`).join(", ")}; resolve them first.`
        : "Blocked by an open dependency; resolve it before the task can run.";
    }
    case "waiting_for_tool_request":
      return `Operator action required: a disallowed-command Tool Request is pending. Inspect with \`admin tool-request list --session-id ${sessionId} --issue-number ${issueNumber}\`, then resolve or grant it.`;
    case "capped":
      return `Review-loop cap reached; restart the review cycle with \`admin recover-cap-handoff --session-id ${sessionId} --issue-number ${issueNumber}\`.`;
    case "needs_human": {
      const missing = Array.isArray(entry.task?.context?.["missingVerificationCommands"])
        ? (entry.task!.context["missingVerificationCommands"] as unknown[]).filter(
            (c): c is string => typeof c === "string",
          )
        : [];
      return missing.length > 0
        ? `Awaiting a human to resolve missing verification command(s): ${missing.join(", ")}. Run \`admin review-verification resolve --session-id ${sessionId} --issue-number ${issueNumber} --command <cmd> --exit-code <n>\` for each.`
        : "Awaiting a human review/decision.";
    }
    case "failed":
      return orphanLocalBranch
        ? `Local branch ${entry.branch.name} exists but was never pushed (no remote branch or PR) and has no worktree — the run failed before publishing the branch. Inspect lastError, then requeue with \`${recover}\`.`
        : `Inspect lastError, then requeue with \`${recover}\`.`;
    case "done":
      return "Completed; no action needed.";
    case "cancelled":
      return "Cancelled by operator; no action needed. It will not be reclaimed or resurrected by intake.";
    case "no_task":
      return orphanLocalBranch
        ? `No task is queued, but local branch ${entry.branch.name} exists with no remote branch, PR, or worktree — likely an interrupted run. Enqueue a task or clean up the branch.`
        : "No task in the queue for this issue.";
  }
}

function worktreeDirtyHint(
  entry: { issueNumber: number; worktree: StatusWorktree; canonicalDirty: boolean | null; discardSafe?: boolean },
  sessionId: string,
  classification?: StatusClassification,
  worktreeLockDir?: string,
  sessionsPath?: string,
  dbPath?: string,
): string {
  let hint = "";
  if (entry.canonicalDirty) {
    hint += ` Canonical checkout is DIRTY — the implementation phase will abort until the canonical repo is clean (commit or stash those changes outside the automation).`;
  }
  // Use the lock-aware `worktree discard` command so that following the hint
  // on a live worktree is safe (the command refuses without --force when the
  // issue lock is held).
  //
  // Use placeholders rather than actual paths for --lock-dir, --sessions-path, and
  // --db-path: the real values are absolute local paths that would violate the status
  // command's no-absolute-local-paths contract when output is forwarded or recorded
  // (e.g. posted to GitHub). Placeholders signal to the operator that they must supply
  // the matching flag when running the command; omitting --sessions-path entirely
  // would silently route the command through the default registry, which may not
  // contain the session or use the same worktree roots; omitting --db-path would cause
  // `worktree discard` to fall back to the default database and potentially fail to
  // resolve the recorded branch context for non-conventional PR branches.
  const lockDirFlag = worktreeLockDir ? ` --lock-dir <LOCK_DIR>` : "";
  const sessionsPathFlag =
    sessionsPath && sessionsPath !== DEFAULT_SESSIONS_PATH ? ` --sessions-path <SESSIONS_PATH>` : "";
  const dbPathFlag = dbPath && dbPath !== DEFAULT_DB_PATH ? ` --db-path <DB_PATH>` : "";
  const discardCmd = `admin worktree discard --session-id ${sessionId} --issue-number ${entry.issueNumber}${lockDirFlag}${sessionsPathFlag}${dbPathFlag} --yes`;
  switch (entry.worktree.dirtyCategory) {
    case "continuation_candidate": {
      // A failed task is not picked up by a worker until an operator requeues it,
      // so "the next run will continue automatically" would be misleading.
      const requeueSuffix = classification === "failed" ? " and the task is requeued" : "";
      if (entry.canonicalDirty) {
        hint += ` The issue worktree is dirty from a prior verification failure and would resume automatically once the canonical checkout above is cleaned${requeueSuffix}. To discard the uncommitted changes instead, use \`${discardCmd}\`.`;
      } else if (classification === "failed") {
        hint += ` The issue worktree is dirty from a prior verification failure; requeue the task to continue automatically from this state. To discard the uncommitted changes instead, use \`${discardCmd}\`.`;
      } else {
        hint += ` The issue worktree is dirty from a prior verification failure; the next run will continue automatically from this state. To discard the uncommitted changes instead, use \`${discardCmd}\`.`;
      }
      break;
    }
    case "action_required":
      if (entry.discardSafe !== false) {
        hint += ` The issue worktree is dirty with no valid continuation record (the record is absent, incomplete, or failed its safety checks) — inspect the working tree, then discard with \`${discardCmd}\` if the changes are not needed.`;
      } else {
        // Non-conventional worktree head: `worktree discard` validates the branch and
        // refuses when the worktree is not on the expected ai/issue-<n> name, so the
        // standard command would fail. Guide the operator toward prune with --force,
        // which can remove the dirty worktree immediately and preserves all status overrides.
        const pruneCmd = `admin worktree prune --session-id ${sessionId} --issue-number ${entry.issueNumber}${lockDirFlag}${sessionsPathFlag} --force --yes`;
        hint += ` The issue worktree (${entry.worktree.id}) is dirty with no recorded continuation state and is on a non-conventional head — inspect the working tree, then use \`${pruneCmd}\` to discard the changes and remove the worktree.`;
      }
      break;
  }
  return hint;
}

function buildStatusEntry(
  task: AiTask | null,
  issueNumber: number,
  ctx: {
    sessionId: string;
    repoRoot: string;
    artifactRoot: string;
    worktreeRoot: string;
    worktrees: ReturnType<typeof listWorktrees>;
    issueLock: IssueWorktreeLock;
    /** Non-default `--worktree-lock-dir` the status inspected, so recovery hints can echo it. */
    worktreeLockDir?: string;
    /** Non-default `--sessions-path` the status inspected, so recovery hints can echo it. */
    sessionsPath?: string;
    /** Non-default `--db-path` the status inspected, so recovery hints can echo it. */
    dbPath?: string;
    now: string;
  },
): StatusEntry {
  const prCtx = task ? resolvePrContext(task) : {};
  // Existing-PR tasks may operate on a non-conventional head branch recorded by
  // resolvePrContext; probe that ref rather than always assuming `ai/issue-N`.
  const name = prCtx.branch ?? branchName(issueNumber);
  const branch: StatusBranch = {
    name,
    localExists: gitRefExists(ctx.repoRoot, `refs/heads/${name}`),
    // Local remote-tracking ref: an offline proxy for "the branch was pushed".
    remoteTrackingExists: gitRefExists(ctx.repoRoot, `refs/remotes/origin/${name}`),
  };

  const pr = { url: prCtx.prUrl ?? null, exists: Boolean(prCtx.prUrl) };

  // Classify task state early: dirtyCategory (below) uses classification to
  // distinguish an active run from a queued continuation candidate.
  const classification = classifyStatus(task, ctx.now);

  const wtPath = canonicalizePath(issueWorktreePath(ctx.worktreeRoot, ctx.sessionId, issueNumber));
  const registered =
    ctx.worktrees.ok && ctx.worktrees.worktrees.some((w) => canonicalizePath(w.path) === wtPath);
  const exists = existsSync(wtPath);
  let clean: boolean | null = null;
  if (exists) {
    const st = probe("git", ["status", "--porcelain"], wtPath);
    clean = st.ok ? st.output === "" : null;
  }
  // When the worktree is dirty, classify the dirty state so operators can tell
  // whether the next run will continue automatically or manual action is needed.
  // Apply the same structural validity checks as the implementation preflight
  // (isValidDirtyContinuation) so that partial/stale markers are classified as
  // action_required rather than misleading operators into expecting auto-continuation.
  // Hoist the registered-worktree lookup so both the continuation-validity closure and
  // the discardSafe check below can share the same resolved entry without a second find().
  const registeredWt = registered && ctx.worktrees.ok
    ? ctx.worktrees.worktrees.find((w) => canonicalizePath(w.path) === wtPath)
    : undefined;
  let dirtyCategory: StatusWorktree["dirtyCategory"] = null;
  if (exists && clean === false) {
    const savedDirtyCtx = task?.context?.["dirtyContinuation"];
    const hasValidDirtyContinuation = ((): boolean => {
      if (typeof savedDirtyCtx !== "object" || savedDirtyCtx === null) return false;
      const dc = savedDirtyCtx as Record<string, unknown>;
      if (dc["phase"] !== "implementation") return false;
      if (dc["issueNumber"] !== issueNumber) return false;
      // Verify the worktree is registered in git worktree list AND is checked out on a
      // named branch. resolveIssueWorktree rejects unregistered paths and detached/wrong-branch
      // states before continuation, so advertising auto-continuation for those cases is incorrect.
      if (!registered) return false;
      // Detached HEAD or missing worktree → cannot verify branch alignment.
      if (!registeredWt || !registeredWt.branch?.startsWith("refs/heads/")) return false;
      // Prefer the live target branch recorded in the task context over the worktree's
      // current checkout. If the PR branch changed after the dirty marker was written
      // the implementation handler validates against its own resolved worktreeBranch and
      // rejects the stale marker; advertising continuation here would be incorrect.
      // Fall back to the worktree's current branch only for the PR-URL-only case where
      // no branch is recorded in the task context.
      const targetBranch = prCtx.branch ?? registeredWt.branch.slice("refs/heads/".length);
      if (dc["branch"] !== targetBranch) return false;
      if (dc["commitSkipped"] !== true) return false;
      if (typeof dc["patchArtifactFile"] !== "string") return false;
      // dirtyFiles must be recorded — the preflight fails closed if missing.
      if (!Array.isArray(dc["dirtyFiles"])) return false;
      // runId is required to locate the patch artifact for content-drift checking;
      // preflight fails closed when patchArtifactFile is present but runId is absent.
      if (typeof dc["runId"] !== "string") return false;
      const wtId = issueWorktreeId(ctx.sessionId, issueNumber);
      if (dc["worktreeId"] !== undefined && dc["worktreeId"] !== null && dc["worktreeId"] !== wtId) return false;
      // Verify the patch artifact is actually readable on disk. If it has been
      // cleaned up the implementation preflight will fail closed, so we must
      // classify this as action_required rather than advertising auto-continuation.
      const artifactPath = join(runArtifactDir(ctx.artifactRoot, dc["runId"] as string), dc["patchArtifactFile"] as string);
      if (!existsSync(artifactPath)) return false;
      // File-set drift check: verify the current dirty file set exactly matches
      // what was recorded in the marker. Mirror the same parsing logic used in
      // the implementation preflight so that a file added or removed since the
      // marker was written causes action_required rather than advertising
      // continuation to the operator.
      let statusRaw: string;
      try {
        statusRaw = execFileSync("git", ["status", "--porcelain", "-z", "--untracked-files=all"], {
          cwd: wtPath, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000,
        }) as string;
      } catch { return false; }
      const statusEntries = statusRaw.split("\0").filter(Boolean);
      const currentFiles: string[] = [];
      {
        let idx = 0;
        while (idx < statusEntries.length) {
          const entry = statusEntries[idx++];
          if (entry.length < 3) continue;
          const xy = entry.slice(0, 2);
          currentFiles.push(entry.slice(3));
          if (xy[0] === "R" || xy[0] === "C" || xy[1] === "R" || xy[1] === "C") idx++;
        }
      }
      currentFiles.sort();
      const recordedFiles = (dc["dirtyFiles"] as string[]).slice().sort();
      // When the task is already running, the worker owns the worktree and may
      // add or remove files after the preflight accepted the marker. Skip the
      // file-set comparison so an active worker is not reclassified as action_required.
      if (classification !== "running" && (currentFiles.length !== recordedFiles.length || currentFiles.some((f, i) => f !== recordedFiles[i]))) return false;
      // Content-drift check: verify the current dirty state byte-for-byte matches
      // the stored patch artifact. Mirrors the implementation preflight so that a
      // file edited after the marker was written, or an untracked file that cannot
      // be content-verified (binary, oversized, non-regular), causes action_required
      // rather than advertising continuation to the operator.
      let storedPatch: string;
      try {
        storedPatch = readFileSync(artifactPath, "utf8");
      } catch { return false; }
      let currentTrackedDiff: string;
      try {
        currentTrackedDiff = execFileSync("git", ["diff", "HEAD"], {
          cwd: wtPath, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
          maxBuffer: 64 * 1024 * 1024, timeout: 30_000,
        }) as string;
      } catch { return false; }
      const untrackedFiles = statusEntries
        .filter((e) => e.length >= 3 && e.slice(0, 2) === "??")
        .map((e) => e.slice(3));
      const { patch: currentUntrackedPatch, skipped: skippedUntracked } = buildUntrackedPatch(wtPath, untrackedFiles);
      if (skippedUntracked.length > 0) return false;
      const currentPatch = currentTrackedDiff + currentUntrackedPatch;
      // When the task is already running, the agent owns the worktree and is
      // expected to modify files after the preflight check. Skip the byte-for-byte
      // comparison so an active worker is not reclassified as action_required.
      if (currentPatch !== storedPatch && classification !== "running") return false;
      return true;
    })();
    // The implementation phase materializes the per-issue worktree
    // UNCONDITIONALLY (issue #732), so a valid dirty continuation marker there
    // is real implementation-created state.
    if (hasValidDirtyContinuation) {
      dirtyCategory = classification === "running" ? "continuation_active" : "continuation_candidate";
    } else {
      // Do not classify an active worker's normal uncommitted edits as action_required:
      // when the task is running the worker owns the worktree and dirty state is expected.
      dirtyCategory = classification !== "running" ? "action_required" : null;
    }
  }
  // Whether `worktree discard` can safely be offered: the registered worktree's
  // current branch must match what runWorktreeDiscard resolves as expectedBranch.
  // Mirror the same fallback ordering as runWorktreeDiscard:
  //   prCtx.branch ?? dirtyContinuation.branch ?? resolveResumeBranch ?? branchName(issueNumber)
  // Without the dirtyContinuation.branch fallback, a prUrl-only fix where the
  // implementation handler recorded only the non-conventional head there would
  // resolve to false here even though discard accepts it, sending the operator
  // toward prune/force-remove instead of the lock-aware discard command.
  const discardSafe = ((): boolean => {
    if (!registeredWt || !registeredWt.branch?.startsWith("refs/heads/")) return false;
    const wtBranch = registeredWt.branch.slice("refs/heads/".length);
    const dc = task?.context?.["dirtyContinuation"];
    const dcBranch =
      typeof dc === "object" && dc !== null && typeof (dc as Record<string, unknown>)["branch"] === "string"
        ? ((dc as Record<string, unknown>)["branch"] as string)
        : undefined;
    const resumeBranch = task ? resolveResumeBranch(task) : undefined;
    return wtBranch === (prCtx.branch ?? dcBranch ?? resumeBranch ?? branchName(issueNumber));
  })();
  // Relativize against the canonicalized root so the public path never carries
  // the absolute (and possibly symlink-resolved, e.g. /private/var) prefix.
  const worktree: StatusWorktree = {
    id: issueWorktreeId(ctx.sessionId, issueNumber),
    relativePath: relative(canonicalizePath(ctx.worktreeRoot), wtPath),
    exists,
    registered,
    clean,
    dirtyCategory,
  };

  const issueLock = lockSummary(ctx.issueLock.inspect(ctx.sessionId, issueNumber, ctx.now));

  const canonicalSt = probe("git", ["status", "--porcelain"], ctx.repoRoot);
  const canonicalDirty: boolean | null = canonicalSt.ok ? canonicalSt.output !== "" : null;
  const suggestedAction =
    suggestedStatusAction(
      classification,
      { issueNumber, branch, pr, worktree, canonicalDirty, task, issueLock },
      ctx.sessionId,
      ctx.worktreeLockDir,
    ) + worktreeDirtyHint({ issueNumber, worktree, canonicalDirty, discardSafe }, ctx.sessionId, classification, ctx.worktreeLockDir, ctx.sessionsPath, ctx.dbPath);

  // git reports the symlink-resolved checkout path, so when a configured root is
  // a symlink, `task.lastError` can carry the canonical (real) absolute path that
  // the configured root alone would not redact. This is not unique to the worktree
  // root: a symlinked `repoRoot` or `artifactRoot` under a non-standard top-level
  // directory leaks the same way. Redact every configured root and its canonical
  // form so `status` honors its no-absolute-paths contract for all of them.
  const redactPaths = [ctx.repoRoot, ctx.artifactRoot, ctx.worktreeRoot];
  for (const root of [ctx.repoRoot, ctx.artifactRoot, ctx.worktreeRoot]) {
    const canonical = canonicalizePath(root);
    if (canonical !== root && !redactPaths.includes(canonical)) redactPaths.push(canonical);
  }
  return {
    issueNumber,
    classification,
    task: task
      ? {
          status: task.status,
          phase: task.phase,
          priority: task.priority,
          attempts: task.attempts,
          ownerRunId: task.ownerRunId ?? null,
          leaseExpiresAt: task.leaseExpiresAt ?? null,
          notBefore: task.notBefore ?? null,
          lastError: task.lastError ? sanitizeBody(task.lastError, redactPaths) : null,
          updatedAt: task.updatedAt,
        }
      : null,
    branch,
    pr,
    worktree,
    canonicalDirty,
    issueLock,
    suggestedAction,
  };
}

interface StatusPayload {
  ok: true;
  sessionId: string;
  issueNumber?: number;
  generatedAt: string;
  /** Session-level pause state (issue #531): a paused session claims no new
   * work, and the reason must be visible from the default status view. */
  sessionPause: SessionPauseState;
  repoLock: StatusLock;
  /** Set when the session registry (issue #823) independently flagged THIS
   * session as invalid or ambiguous — the loop cannot run it even though the
   * hand-parsed session info above resolved. `null` when the registry loads
   * this session cleanly or could not be consulted. */
  registryDiagnostic: string | null;
  count: number;
  entries: StatusEntry[];
}

function renderLockLine(label: string, lock: StatusLock): string {
  // A stale lock reports held=false (RepoLockStore.inspect treats an expired lock
  // file as not locking), but it still carries owner metadata and a leftover file
  // an operator must clean up. Surface it explicitly instead of collapsing it into
  // the `free` case, which would hide the stale owner from the default human view.
  if (!lock.held) {
    if (!lock.stale) return `${label}: free`;
    const staleOwner = lock.contextId ? ` left by ${lock.contextId}` : "";
    const staleStarted = lock.startedAt ? ` since ${lock.startedAt}` : "";
    return `${label}: free (stale lock${staleOwner}${staleStarted})`;
  }
  const owner = lock.contextId ? ` held by ${lock.contextId}` : " held";
  const started = lock.startedAt ? ` since ${lock.startedAt}` : "";
  const stale = lock.stale ? " (stale)" : "";
  return `${label}:${owner}${started}${stale}`;
}

function renderStatus(payload: StatusPayload, mode: OutputMode): string {
  const scope = sessionScope(payload.sessionId, payload.issueNumber);
  const lines: string[] = [];
  if (!mode.quiet) {
    lines.push(`Status for ${scope} (as of ${payload.generatedAt}):`);
    lines.push("");
  }
  if (payload.registryDiagnostic) {
    lines.push(`  SESSION REGISTRY DIAGNOSTIC: ${payload.registryDiagnostic}`);
    lines.push("");
  }
  if (payload.sessionPause.paused) {
    const pause = payload.sessionPause;
    lines.push(
      `  SESSION PAUSED${pause.source !== undefined ? ` (${pause.source})` : ""}` +
        `${pause.reason !== undefined ? `: ${pause.reason}` : ""}`,
    );
    lines.push(
      `      no new work is claimed; resume with: admin session resume --session-id ${payload.sessionId}`,
    );
    lines.push("");
  }
  if (payload.entries.length === 0) {
    lines.push(`  No tasks found for ${scope}.`);
  }
  for (const e of payload.entries) {
    const phase = e.task ? `  phase=${e.task.phase}` : "";
    lines.push(`  #${e.issueNumber}  ${STATUS_LABELS[e.classification]}${phase}`);
    const remote = e.branch.remoteTrackingExists ? "yes" : "no";
    const local = e.branch.localExists ? "yes" : "no";
    lines.push(`      branch ${e.branch.name}: local=${local} remote=${remote}`);
    lines.push(`      pr: ${e.pr.url ?? "none"}`);
    if (e.discoveredPr) {
      const d = e.discoveredPr;
      if (d.outcome === "found") {
        lines.push(`      pr discovery: LIVE PR FOUND (not persisted in task context): ${d.url}`);
        lines.push(`        ${d.recommendation}`);
      } else {
        const label = d.outcome === "error" ? "error" : d.reason;
        lines.push(`      pr discovery: no live PR adopted (${label}): ${d.message}`);
      }
    }
    let wtState: string;
    if (!e.worktree.exists) {
      wtState = "missing";
    } else if (e.worktree.clean === null) {
      wtState = "present (cleanliness unknown)";
    } else if (e.worktree.clean) {
      wtState = "present, clean";
    } else {
      switch (e.worktree.dirtyCategory) {
        case "continuation_candidate":
          wtState = "present, DIRTY (continuation candidate — prior verification failure recorded)";
          break;
        case "continuation_active":
          wtState = "present, DIRTY (continuation in progress)";
          break;
        case "action_required":
          wtState = "present, DIRTY (operator action required — no continuation record)";
          break;
        default:
          wtState = "present, DIRTY";
      }
    }
    lines.push(`      worktree ${e.worktree.id}: ${wtState}`);
    const canonicalState = e.canonicalDirty === null
      ? "unknown"
      : e.canonicalDirty
        ? "DIRTY (fatal — implementation aborts; review and conflict-resolution run in the issue worktree)"
        : "clean";
    lines.push(`      canonical checkout: ${canonicalState}`);
    lines.push(`      ${renderLockLine("issue lock", e.issueLock)}`);
    if (mode.verbose && e.task) {
      const attempts = JSON.stringify(e.task.attempts ?? {});
      lines.push(
        `      owner=${e.task.ownerRunId ?? "-"} lease=${e.task.leaseExpiresAt ?? "-"} attempts=${attempts} updated=${e.task.updatedAt}`,
      );
    }
    if (e.task?.lastError) {
      lines.push(`      lastError: ${e.task.lastError}`);
    }
    lines.push(`      next: ${e.suggestedAction}`);
  }
  lines.push("");
  lines.push(renderLockLine("Repo lock", payload.repoLock));
  return lines.join("\n").replace(/\n+$/, "");
}

async function runStatus(argv: string[]): Promise<void> {
  const parsed = parseStatusArgs(argv);
  if ("error" in parsed) die(parsed.error);

  const { sessionId, issueNumber, sessionsPath, dbPath, lockDir, worktreeLockDir, all, discoverPr } = parsed;
  const sessionInfo = loadSessionInfo(sessionId, sessionsPath);
  if ("error" in sessionInfo) die(sessionInfo.error);

  const { repoRoot, artifactRoot } = sessionInfo;
  let worktreeRoot: string;
  try {
    worktreeRoot = resolveSessionWorktreeRoot(sessionInfo);
  } catch (err) {
    die(err instanceof Error ? err.message : String(err));
  }

  const now = new Date().toISOString();
  const worktrees = listWorktrees(repoRoot);
  // If the repo can't be inspected (missing repoRoot, not a Git checkout, or
  // `git worktree list` failed), every branch/worktree probe below would
  // silently collapse to "no branch / missing worktree" and hand the operator
  // incorrect guidance. Fail loudly instead of reporting a misleading status.
  if (!worktrees.ok) {
    die(`Cannot inspect repository worktree state: ${worktrees.error}`);
  }
  const issueLock = new IssueWorktreeLock(worktreeLockDir);
  const repoLock = lockSummary(new RepoLockStore(lockDir).inspect(sessionId, now));

  // Only echo an explicit, non-default worktree lock dir into recovery hints: when the
  // default dir is used (flag omitted, or passed the default path) `admin worktree
  // release-lock` already targets it, so a redundant `--lock-dir` would only add noise.
  const hintWorktreeLockDir =
    worktreeLockDir !== undefined && worktreeLockDir !== DEFAULT_WORKTREE_LOCK_DIR
      ? worktreeLockDir
      : undefined;

  // Only echo a non-default sessions path into recovery hints so the suggested
  // `worktree prune` command targets the same registry the status command used.
  const hintSessionsPath = sessionsPath !== DEFAULT_SESSIONS_PATH ? sessionsPath : undefined;

  // Only echo a non-default db path into recovery hints so `worktree discard`
  // resolves branch context from the same database the status command used.
  const hintDbPath = dbPath !== undefined && dbPath !== DEFAULT_DB_PATH ? dbPath : undefined;

  const buildCtx = {
    sessionId,
    repoRoot,
    artifactRoot,
    worktreeRoot,
    worktrees,
    issueLock,
    worktreeLockDir: hintWorktreeLockDir,
    sessionsPath: hintSessionsPath,
    dbPath: hintDbPath,
    now,
  };

  const store = new SqliteTaskStore(dbPath);
  let entries: StatusEntry[];
  try {
    const tasks =
      issueNumber !== undefined
        ? await store.getTask({ sessionId, issueNumber }).then((t) => (t ? [t] : []))
        : await store.listSessionTasks(sessionId);
    if (issueNumber !== undefined) {
      // An explicit issue is always shown, even when done or with no task.
      entries =
        tasks.length > 0
          ? tasks.map((t) => buildStatusEntry(t, t.issueNumber, buildCtx))
          : [buildStatusEntry(null, issueNumber, buildCtx)];
    } else {
      // Hide closed/completed/cancelled tasks unless --all was requested (issue
      // #608: `cancelled` is a terminal status alongside `done` and must not
      // clutter the default operator view forever).
      const visible = all ? tasks : tasks.filter((t) => t.status !== "done" && t.status !== "cancelled");
      entries = visible
        .slice()
        .sort((a, b) => a.issueNumber - b.issueNumber)
        .map((t) => buildStatusEntry(t, t.issueNumber, buildCtx));
    }
  } finally {
    store.close();
  }

  // Live PR discovery (issue #1002): opt-in and restricted to a single explicit
  // issue, and only attempted when persisted task context carries no `prUrl` —
  // a task with complete persisted PR context is left byte-for-byte unchanged.
  if (discoverPr && issueNumber !== undefined && entries.length === 1 && !entries[0].pr.exists) {
    entries[0].discoveredPr = await discoverLivePrForStatus(
      sessionId,
      sessionsPath,
      issueNumber,
      entries[0].branch.name,
    );
  }

  // Surface the session-level pause (issue #531) in the default status view so
  // an operator investigating a quiet session sees the pause reason without
  // needing to know about `session status`.
  const controlStore = new SqliteSessionControlStore(dbPath);
  let sessionPause: SessionPauseState;
  try {
    sessionPause = await controlStore.getPauseState(sessionId);
  } finally {
    controlStore.close();
  }

  // Cross-check against the session registry (issue #823): `loadSessionInfo`
  // above is a lenient hand-parse that only reads the fields status needs, so
  // it can succeed for a session the stricter registry would quarantine as
  // invalid or ambiguous — exactly the case the loop itself cannot run.
  // Defensive: never let a registry-load problem hide the status this command
  // exists to show.
  let registryDiagnostic: string | null = null;
  try {
    const registry = new JsonSessionRegistry(sessionsPath);
    const own = registry.getDiagnostics().find((d) => d.sessionIds.includes(sessionId));
    if (own) registryDiagnostic = own.message;
  } catch {
    // Ignored: loadSessionInfo already validated the same file above, so a
    // fatal registry error here would be surprising; status still has real
    // task data to show and should not fail on this best-effort cross-check.
  }

  const payload = {
    ok: true as const,
    sessionId,
    ...(issueNumber !== undefined ? { issueNumber } : {}),
    generatedAt: now,
    sessionPause,
    repoLock,
    registryDiagnostic,
    count: entries.length,
    entries,
  };
  report(payload, (mode) => renderStatus(payload, mode));
}

// ---------------------------------------------------------------------------
// Subcommand: worktree cleanup / worktree release-lock (issue #407)
//
// `cleanup` bulk-classifies every managed per-issue worktree for a session and
// prunes the ones that are safe to remove. `release-lock` frees a stale issue
// worktree lock. Both default to a non-destructive preview and require an
// explicit --yes to mutate state, and both reject unknown flags so a typoed
// safety flag (e.g. `--forse`) can never silently fall through to a destructive
// default. Worktree paths are local-only and never published.
// ---------------------------------------------------------------------------

/**
 * Strict argv parser for the cleanup commands. Unlike the historical per-command
 * loops (which silently ignore unrecognized `--flags`), this rejects any flag not
 * declared in `spec` so a typoed option fails fast instead of being dropped — a
 * #407 safety requirement, since a dropped `--force`/`--yes` would change whether
 * a destructive action runs.
 */
function parseStrictArgs(
  argv: string[],
  spec: { value: readonly string[]; boolean: readonly string[] },
): { args: Record<string, string>; flags: Set<string> } | { error: string } {
  const valueSet = new Set(spec.value);
  const boolSet = new Set(spec.boolean);
  const args: Record<string, string> = {};
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok.startsWith("--")) {
      return { error: `Unexpected argument: ${tok}` };
    }
    const name = tok.slice(2);
    if (boolSet.has(name)) {
      flags.add(name);
      continue;
    }
    if (valueSet.has(name)) {
      if (i + 1 >= argv.length) return { error: `--${name} requires a value` };
      args[name] = argv[i + 1];
      i++;
      continue;
    }
    return { error: `Unknown option: --${name}` };
  }
  return { args, flags };
}

/**
 * Task statuses that mean the issue is still in flight or awaiting human action,
 * so its per-issue worktree must be preserved. The per-issue model deliberately
 * keeps a worktree (and any dirty/recovery state) until the work truly ends, so
 * cleanup never touches a worktree backing one of these statuses.
 */
const ACTIVE_TASK_STATUSES: ReadonlySet<string> = new Set([
  "queued",
  "claimed",
  "running",
  "blocked",
  "ready_for_human",
]);

/**
 * True when the worktree's branch has commits that are not on origin. Prefers the
 * pushed remote-tracking branch when it exists; otherwise any commit beyond the
 * base branch is local-only. Fails safe (treats an unresolvable comparison as
 * unpushed) so cleanup never silently discards commits it could not account for.
 */
function worktreeHasUnpushedCommits(
  worktreePath: string,
  branch: string | undefined,
  baseBranch: string,
): boolean {
  if (branch) {
    const originRef = `refs/remotes/origin/${branch}`;
    const hasOrigin = probe("git", ["rev-parse", "--verify", "--quiet", originRef], worktreePath).ok;
    if (hasOrigin) {
      const count = probe("git", ["rev-list", "--count", `origin/${branch}..HEAD`], worktreePath);
      return count.ok ? Number(count.output) > 0 : true;
    }
  }
  const count = probe("git", ["rev-list", "--count", `${baseBranch}..HEAD`], worktreePath);
  return count.ok ? Number(count.output) > 0 : true;
}

interface CleanupItem {
  issueNumber: number;
  path: string;
  branch: string | null;
  /** Which managed checkout this is: the durable issue worktree or a research run. */
  kind: "issue" | "research";
  /** Run id of a `research` checkout (absent for the durable issue worktree). */
  runId?: string;
  /** active | terminal | orphaned | research-leaked | <other task status, e.g. failed>. */
  classification: string;
  dirty: boolean;
  unpushedCommits: boolean;
  lockHeld: boolean;
  /** "remove" when it is a prune candidate that passes all safety checks. */
  decision: "remove" | "skip";
  reason?: string;
}

async function runWorktreeCleanup(argv: string[]): Promise<void> {
  const parsed = parseStrictArgs(argv, {
    value: ["session-id", "sessions-path", "db-path", "lock-dir"],
    boolean: ["yes", "force"],
  });
  if ("error" in parsed) die(parsed.error);
  const { args, flags } = parsed;
  if (!args["session-id"]) die("--session-id is required");
  const sessionId = args["session-id"];
  const sessionsPath = args["sessions-path"] ?? DEFAULT_SESSIONS_PATH;
  const yes = flags.has("yes");
  const force = flags.has("force");

  const sessionInfo = loadSessionInfo(sessionId, sessionsPath);
  if ("error" in sessionInfo) die(sessionInfo.error);
  const { repoRoot, baseBranch } = sessionInfo;

  let worktreeRoot: string;
  try {
    worktreeRoot = resolveSessionWorktreeRoot(sessionInfo);
  } catch (err) {
    die(err instanceof Error ? err.message : String(err));
  }

  const canonicalRepoRoot = canonicalizePath(repoRoot);
  // Use the same session-directory helper as worktree creation so cleanup slices
  // the correct prefix for dot-only session IDs (percent-encoded on disk) instead
  // of skipping the real worktree or matching paths under the parent directory.
  const sessionPrefix = canonicalizePath(sessionWorktreeDir(worktreeRoot, sessionId)) + "/";

  const listed = listWorktrees(repoRoot);
  if (!listed.ok) die(listed.error);

  const store = new SqliteTaskStore(args["db-path"]);
  const lock = new IssueWorktreeLock(args["lock-dir"]);
  const items: CleanupItem[] = [];
  try {
    for (const w of listed.worktrees) {
      const cp = canonicalizePath(w.path);
      // Only consider this session's managed per-issue worktrees; never the
      // canonical checkout or an unrelated worktree the operator added by hand.
      if (cp === canonicalRepoRoot || !cp.startsWith(sessionPrefix)) continue;
      const rel = cp.slice(sessionPrefix.length);
      const classified = classifyManagedWorktree(rel);
      if (!classified) continue; // not a recognized per-issue worktree layout
      const { issueNumber } = classified;
      const branch = w.branch ? w.branch.replace(/^refs\/heads\//, "") : null;

      const task = await store.getTask({ sessionId, issueNumber });
      const lockHeld = lock.inspect(sessionId, issueNumber).locked;

      // A per-run research checkout (issue #855) is disposable by construction:
      // it is detached at a fetched base commit, owns no branch, and belongs to
      // exactly ONE process. If that process dies before its `finally` removes
      // the checkout, nothing can ever reclaim it — a retry gets a new run id and
      // therefore a new path — so its issue's task status says nothing about
      // whether the directory is still in use. Gating it on `active` (as the
      // durable `issue-<n>/repo` worktree must be) would leak the checkout until
      // the task went terminal, which is exactly the accumulation this branch of
      // the classifier exists to prevent. The live issue lock below remains the
      // interlock: a research run that is genuinely in flight holds it.
      const isResearch = classified.kind === "research";

      let classification: string;
      let candidate: boolean;
      if (isResearch) {
        classification = "research-leaked";
        candidate = true;
      } else if (!task) {
        classification = "orphaned";
        candidate = true;
      } else if (ACTIVE_TASK_STATUSES.has(task.status)) {
        classification = "active";
        candidate = false;
      } else if (task.status === "done") {
        classification = "terminal";
        candidate = true;
      } else {
        // failed (or any other terminal-ish status): a prune candidate, but the
        // dirty / unpushed guards below still protect any preserved work.
        classification = task.status;
        candidate = true;
      }

      const statusProbe = probe("git", ["status", "--porcelain"], cp);
      const dirty = !statusProbe.ok || statusProbe.output !== "";
      const unpushedCommits = worktreeHasUnpushedCommits(cp, branch ?? undefined, baseBranch);

      let decision: "remove" | "skip" = "skip";
      let reason: string | undefined;
      if (lockHeld) {
        reason = "locked (live issue lock — a run may be active)";
      } else if (!candidate) {
        reason = `active task (status=${task!.status})`;
      } else if (isResearch) {
        // The dirty / unpushed facts are still reported for the operator, but
        // they cannot gate the decision here: read-only research is detached at a
        // base commit with no branch to push, so leftover files are agent scratch
        // and the "commits not on origin" comparison is meaningless. The in-run
        // release path force-removes this same checkout on every normal exit.
        decision = "remove";
      } else if (dirty && !force) {
        reason = "dirty (re-run with --force to discard uncommitted changes)";
      } else if (unpushedCommits && !force) {
        reason = "unpushed_commits (re-run with --force to discard commits not on origin)";
      } else {
        decision = "remove";
      }

      items.push({
        issueNumber,
        path: cp,
        branch,
        kind: classified.kind,
        ...(classified.kind === "research" ? { runId: classified.runId } : {}),
        classification,
        dirty,
        unpushedCommits,
        lockHeld,
        decision,
        reason,
      });
    }
  } finally {
    store.close();
  }

  const toRemove = items.filter((i) => i.decision === "remove");
  const skipped = items.filter((i) => i.decision === "skip");

  if (!yes) {
    emit({
      ok: true,
      dryRun: true,
      sessionId,
      repoRoot,
      worktreeRoot,
      force,
      examined: items.length,
      wouldRemove: toRemove,
      skipped,
      hint: "Re-run with --yes to remove the listed candidates.",
    });
    return;
  }

  const removed: CleanupItem[] = [];
  const errors: Array<CleanupItem & { error: string }> = [];
  for (const item of toRemove) {
    // A leaked research checkout is removed with force regardless of the flag:
    // it was admitted as a candidate without the dirty/unpushed guards, so a
    // plain `git worktree remove` would refuse the very scratch state that made
    // those guards inapplicable, and the operator would be told to re-run with
    // `--force` for a checkout that is disposable by construction.
    const result = removeWorktree(repoRoot, item.path, { force: force || item.kind === "research" });
    if (result.ok) {
      removed.push(item);
    } else {
      errors.push({ ...item, error: result.error });
    }
  }

  emit({
    ok: errors.length === 0,
    dryRun: false,
    sessionId,
    repoRoot,
    worktreeRoot,
    force,
    examined: items.length,
    removed,
    skipped,
    errors,
  });

  // A state-changing cleanup that left one or more worktrees unremoved (locked,
  // dirty, or permission change after classification) must not exit 0, or scripts
  // would treat the prune as fully successful. Fail the command after reporting
  // the per-item errors above; the detailed payload is already on stdout.
  if (errors.length > 0) {
    process.exitCode = 1;
  }
}

interface IssueLockReleaseArgs {
  sessionId: string;
  issueNumber: number;
  lockDir: string | undefined;
  yes: boolean;
  force: boolean;
}

/**
 * Strict argv parser shared by `worktree release-lock` and `review-lock release`
 * (issue #459). Both operate on the same per-issue worktree lock scope, so they
 * accept the same flags and reject anything else fail-fast.
 */
function parseIssueLockReleaseArgs(argv: string[]): IssueLockReleaseArgs | { error: string } {
  const parsed = parseStrictArgs(argv, {
    value: ["session-id", "issue-number", "lock-dir"],
    boolean: ["yes", "force"],
  });
  if ("error" in parsed) return { error: parsed.error };
  const { args, flags } = parsed;
  if (!args["session-id"]) return { error: "--session-id is required" };
  if (args["issue-number"] === undefined) return { error: "--issue-number is required" };
  const issueNumber = Number(args["issue-number"]);
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    return { error: `--issue-number must be a positive integer, got: ${args["issue-number"]}` };
  }
  return {
    sessionId: args["session-id"],
    issueNumber,
    lockDir: args["lock-dir"],
    yes: flags.has("yes"),
    force: flags.has("force"),
  };
}

/**
 * Inspect a per-issue worktree lock and resolve the release outcome, honoring the
 * preview / --yes / --force protocol shared by `worktree release-lock` and
 * `review-lock release` (issue #459). Returns the JSON payload fields the caller
 * emits (the caller adds `ok`, `sessionId`, `issueNumber`, and any lock-kind
 * labels). A missing lock is a safe no-op; a live (non-stale) lock is refused
 * without --force; a release is previewed unless --yes is passed.
 */
function resolveIssueLockRelease(
  lock: IssueWorktreeLock,
  sessionId: string,
  issueNumber: number,
  opts: { yes: boolean; force: boolean },
): Record<string, unknown> {
  const state = lock.inspect(sessionId, issueNumber);

  // No lock file at all: safe no-op.
  if (state.contextId === null) {
    return { released: false, reason: "no_lock", lockPath: state.lockPath };
  }

  // A live (non-stale) lock means a run may still be using the worktree.
  if (!state.stale && !opts.force) {
    return {
      released: false,
      reason: "lock_held",
      stale: false,
      ownerContextId: state.contextId,
      startedAt: state.startedAt,
      ageMs: state.ageMs,
      lockPath: state.lockPath,
      hint: "Lock is live; re-run with --force only if you are certain no run is active.",
    };
  }

  if (!opts.yes) {
    return {
      released: false,
      wouldRelease: true,
      stale: state.stale,
      forced: !state.stale,
      ownerContextId: state.contextId,
      startedAt: state.startedAt,
      ageMs: state.ageMs,
      lockPath: state.lockPath,
      hint: "Re-run with --yes to release this lock.",
    };
  }

  const result = lock.forceRelease(sessionId, issueNumber);
  return {
    released: result.released,
    ...(result.released
      ? { wasStale: result.wasStale, ownerContextId: result.ownerContextId }
      : { reason: result.reason }),
    lockPath: state.lockPath,
  };
}

function runWorktreeReleaseLock(argv: string[]): void {
  const parsed = parseIssueLockReleaseArgs(argv);
  if ("error" in parsed) die(parsed.error);
  const { sessionId, issueNumber, lockDir, yes, force } = parsed;
  const lock = new IssueWorktreeLock(lockDir);
  const outcome = resolveIssueLockRelease(lock, sessionId, issueNumber, { yes, force });
  emit({ ok: true, sessionId, issueNumber, ...outcome });
}

// ---------------------------------------------------------------------------
// Subcommand: worktree discard (issue #570)
//
// Discard dirty changes in a managed per-issue worktree, restoring it to a
// clean state. Preview by default; require --yes to actually mutate. Refuses
// the canonical checkout, non-managed worktrees, and live issue locks (unless
// --force). Does not delete branches, close PRs, or touch the task row.
// Human-readable by default; --json for machine output.
// ---------------------------------------------------------------------------

interface WorktreeDiscardArgs {
  sessionId: string;
  issueNumber: number;
  sessionsPath: string;
  dbPath: string | undefined;
  lockDir: string | undefined;
  yes: boolean;
  force: boolean;
}

function parseWorktreeDiscardArgs(argv: string[]): WorktreeDiscardArgs | { error: string } {
  const parsed = parseStrictArgs(argv, {
    value: ["session-id", "issue-number", "sessions-path", "db-path", "lock-dir"],
    boolean: ["yes", "force"],
  });
  if ("error" in parsed) return { error: parsed.error };
  const { args, flags } = parsed;
  if (!args["session-id"]) return { error: "--session-id is required" };
  if (args["issue-number"] === undefined) return { error: "--issue-number is required" };
  const issueNumber = Number(args["issue-number"]);
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    return { error: `--issue-number must be a positive integer, got: ${args["issue-number"]}` };
  }
  return {
    sessionId: args["session-id"],
    issueNumber,
    sessionsPath: args["sessions-path"] ?? DEFAULT_SESSIONS_PATH,
    dbPath: args["db-path"],
    lockDir: args["lock-dir"],
    yes: flags.has("yes"),
    force: flags.has("force"),
  };
}

function renderWorktreeDiscard(
  payload: {
    sessionId: string;
    issueNumber: number;
    path: string;
    branch?: string | null;
    reason?: string;
    discarded?: boolean;
    wouldDiscard?: boolean;
    dirty?: boolean;
    trackedChanges?: string[];
    untrackedFiles?: string[];
    lockForced?: boolean;
    ownerContextId?: string | null;
    hint?: string;
  },
  _mode: OutputMode,
): string {
  const {
    sessionId,
    issueNumber,
    path,
    branch,
    reason,
    discarded,
    wouldDiscard,
    dirty,
    trackedChanges,
    untrackedFiles,
    lockForced,
    ownerContextId,
    hint,
  } = payload;

  if (reason === "not_found") {
    return `Worktree for issue #${issueNumber} (session ${sessionId}) is not registered; nothing to discard.`;
  }

  if (reason === "lock_held") {
    const lines = [
      `Refusing: worktree for issue #${issueNumber} is locked by an active run (${ownerContextId}).`,
    ];
    if (hint) lines.push(`Hint: ${hint}`);
    return lines.join("\n");
  }

  if (wouldDiscard) {
    if (!dirty) {
      return `Worktree for issue #${issueNumber} (${path}) is already clean; --yes is a no-op.`;
    }
    const lines = [
      `Preview: would discard dirty changes in worktree for issue #${issueNumber}:`,
      `  Path:   ${path}`,
      `  Branch: ${branch ?? "(detached)"}`,
    ];
    if (trackedChanges?.length) {
      lines.push(`  Tracked changes (${trackedChanges.length}):`);
      for (const f of trackedChanges) lines.push(`    ${f}`);
    }
    if (untrackedFiles?.length) {
      lines.push(`  Untracked files (${untrackedFiles.length}):`);
      for (const f of untrackedFiles) lines.push(`    ${f}`);
    }
    if (lockForced) lines.push("  Warning: lock was forced.");
    if (hint) lines.push(`Hint: ${hint}`);
    return lines.join("\n");
  }

  if (reason === "already_clean") {
    return `Worktree for issue #${issueNumber} (${path}) is already clean; nothing to do.`;
  }

  if (discarded) {
    const lines = [
      `Discarded dirty changes in worktree for issue #${issueNumber}:`,
      `  Path:   ${path}`,
      `  Branch: ${branch ?? "(detached)"}`,
    ];
    if (trackedChanges?.length) {
      lines.push(`  Reverted (${trackedChanges.length} tracked change(s)):`);
      for (const f of trackedChanges) lines.push(`    ${f}`);
    }
    if (untrackedFiles?.length) {
      lines.push(`  Removed (${untrackedFiles.length} untracked file(s)):`);
      for (const f of untrackedFiles) lines.push(`    ${f}`);
    }
    if (lockForced) lines.push("  Warning: lock was forced.");
    return lines.join("\n");
  }

  return `Worktree for issue #${issueNumber}: no action taken.`;
}

async function runWorktreeDiscard(argv: string[]): Promise<void> {
  const parsed = parseWorktreeDiscardArgs(argv);
  if ("error" in parsed) die(parsed.error);

  const { sessionId, issueNumber, sessionsPath, dbPath, lockDir, yes, force } = parsed;
  const sessionInfo = loadSessionInfo(sessionId, sessionsPath);
  if ("error" in sessionInfo) die(sessionInfo.error);

  const { repoRoot } = sessionInfo;
  let worktreeRoot: string;
  try {
    worktreeRoot = resolveSessionWorktreeRoot(sessionInfo);
  } catch (err) {
    die(err instanceof Error ? err.message : String(err));
  }

  const canonicalRepoRoot = canonicalizePath(repoRoot);
  const sessionPrefix = canonicalizePath(sessionWorktreeDir(worktreeRoot!, sessionId)) + "/";
  const expectedPath = canonicalizePath(issueWorktreePath(worktreeRoot!, sessionId, issueNumber));

  // Safety guards: refuse the canonical checkout and non-managed worktrees.
  if (expectedPath === canonicalRepoRoot) {
    die("Refusing: the resolved path is the canonical checkout, not a managed per-issue worktree.");
    return;
  }
  if (expectedPath.startsWith(canonicalRepoRoot + "/")) {
    die("Refusing: the resolved path is inside the canonical repository root; cannot safely discard.");
    return;
  }
  if (!expectedPath.startsWith(sessionPrefix)) {
    die("Refusing: the resolved path is not a managed per-issue worktree for this session.");
    return;
  }

  const listed = listWorktrees(repoRoot);
  if (!listed.ok) die(listed.error);
  const entry = listed.worktrees.find((w) => canonicalizePath(w.path) === expectedPath);

  if (!entry) {
    // Worktree not registered: safe no-op.
    const result = { ok: true, sessionId, issueNumber, path: expectedPath, discarded: false, reason: "not_found" };
    report(result, (mode) => renderWorktreeDiscard(result, mode));
    return;
  }

  const branch = entry.branch ? entry.branch.replace(/^refs\/heads\//, "") : null;

  // Refuse if the worktree is not on the expected issue branch: discard must
  // not silently operate on a manually-switched or detached-HEAD worktree.
  // Prefer the branch recorded in task context (fix flows may check out a live
  // PR head that differs from the conventional ai/issue-<n> name); fall back to
  // the conventional name when no task row exists.
  let expectedBranch: string = branchName(issueNumber);
  {
    const store = new SqliteTaskStore(dbPath);
    try {
      const task = await store.getTask({ sessionId, issueNumber });
      if (task) {
        const ctx = resolvePrContext(task);
        // Also check dirtyContinuation.branch: the implementation handler records
        // fixPr.headRefName ?? conventionalBranch there, so a prUrl-only handoff on
        // a non-conventional PR head is covered even when ctx.branch is absent.
        const dc = task.context?.["dirtyContinuation"];
        const dcBranch =
          typeof dc === "object" && dc !== null && typeof (dc as Record<string, unknown>)["branch"] === "string"
            ? ((dc as Record<string, unknown>)["branch"] as string)
            : undefined;
        const recordedBranch = ctx.branch ?? dcBranch ?? resolveResumeBranch(task);
        if (recordedBranch) expectedBranch = recordedBranch;
      }
    } finally {
      store.close();
    }
  }
  if (branch !== expectedBranch) {
    die(
      `Refusing: worktree at ${expectedPath} is on branch "${branch ?? "(detached)"}" not "${expectedBranch}"; cannot safely discard.`,
    );
    return;
  }

  // Inspect lock state. A live lock means a run may still be using the worktree.
  const lock = new IssueWorktreeLock(lockDir);
  const lockState = lock.inspect(sessionId, issueNumber);
  if (lockState.locked && !lockState.stale && !force) {
    const result = {
      ok: !yes,
      sessionId,
      issueNumber,
      path: expectedPath,
      branch,
      discarded: false,
      reason: "lock_held",
      stale: false,
      ownerContextId: lockState.contextId,
      startedAt: lockState.startedAt,
      ageMs: lockState.ageMs,
      lockPath: lockState.lockPath,
      hint: "Worktree lock is live; re-run with --force only if you are certain no run is active.",
    };
    report(result, (mode) => renderWorktreeDiscard(result, mode));
    if (yes) process.exitCode = 1;
    return;
  }

  // Acquire the lock before snapshotting when mutating, so that no concurrent
  // run can modify the worktree between inspection and reset/clean. Preview
  // mode (!yes) does not mutate, so lock-free inspection is acceptable there.
  // --force bypasses an already-held live lock but must not disable locking
  // when the lock is free or stale — a free lock must still be acquired to
  // prevent a concurrent worker from racing reset/clean.
  const DISCARD_CONTEXT_ID = "admin-worktree-discard";
  const isLiveLock = lockState.locked && !lockState.stale;
  let lockAcquired = false;
  if (yes && !(force && isLiveLock)) {
    const acquireResult = lock.acquire(DISCARD_CONTEXT_ID, sessionId, issueNumber);
    if (!acquireResult.locked) {
      die(
        `Cannot acquire issue lock: another process (${acquireResult.ownerContextId}) now holds it. ` +
          `Re-run with --force to bypass, or wait for the active run to complete.`,
      );
      return;
    }
    lockAcquired = true;
  }

  // Enumerate dirty files for preview and audit.
  const statusResult = probe("git", ["status", "--porcelain"], expectedPath);
  if (!statusResult.ok) {
    if (lockAcquired) {
      lock.release(DISCARD_CONTEXT_ID, sessionId, issueNumber);
    }
    die(`Failed to inspect worktree status at ${expectedPath}: ${statusResult.output}`);
    return;
  }
  const statusLines = statusResult.output.split("\n").filter(Boolean);
  const trackedChanges = statusLines.filter((l) => !l.startsWith("??")).map((l) => l.trim());
  const untrackedFiles = statusLines.filter((l) => l.startsWith("??")).map((l) => l.slice(3).trim());
  const dirty = statusLines.length > 0;

  if (!yes) {
    const result = {
      ok: true,
      sessionId,
      issueNumber,
      path: expectedPath,
      branch,
      discarded: false,
      wouldDiscard: true,
      dirty,
      trackedChanges,
      untrackedFiles,
      lockForced: lockState.locked ? true : undefined,
      hint: dirty
        ? "Re-run with --yes to restore this worktree to a clean state."
        : "Worktree is already clean; --yes is a no-op.",
    };
    report(result, (mode) => renderWorktreeDiscard(result, mode));
    return;
  }

  // Accumulate any failure reason so the lock can be released before calling
  // die() (process.exit() does not run finally blocks).
  let failureReason: string | null = null;

  try {
    if (!dirty) {
      const result = {
        ok: true,
        sessionId,
        issueNumber,
        path: expectedPath,
        branch,
        discarded: false,
        reason: "already_clean",
      };
      report(result, (mode) => renderWorktreeDiscard(result, mode));
      return;
    }

    // Revert tracked changes (stays on current branch; does not touch untracked files).
    const resetResult = probe("git", ["reset", "--hard", "HEAD"], expectedPath);
    if (!resetResult.ok) {
      failureReason = `git reset --hard HEAD failed: ${resetResult.output}`;
    }

    // Remove untracked files and directories. Double -f is required to also
    // remove nested git repositories that a single -f would skip.
    if (!failureReason) {
      const cleanResult = probe("git", ["clean", "-ffd"], expectedPath);
      if (!cleanResult.ok) {
        failureReason = `git clean -ffd failed: ${cleanResult.output}`;
      }
    }

    // Verify the worktree is actually clean; nested repos skipped by clean
    // would leave porcelain output behind and must be caught here. Treat an
    // unsuccessful status check as an error to fail closed.
    if (!failureReason) {
      const verifyResult = probe("git", ["status", "--porcelain"], expectedPath);
      if (!verifyResult.ok || verifyResult.output.trim().length > 0) {
        failureReason = `Worktree still has dirty state after reset+clean:\n${verifyResult.output}`;
      }
    }

    if (!failureReason) {
      const result = {
        ok: true,
        sessionId,
        issueNumber,
        path: expectedPath,
        branch,
        discarded: true,
        lockForced: lockState.locked ? true : undefined,
        trackedChanges,
        untrackedFiles,
      };
      report(result, (mode) => renderWorktreeDiscard(result, mode));
    }
  } finally {
    if (lockAcquired) {
      lock.release(DISCARD_CONTEXT_ID, sessionId, issueNumber);
    }
  }

  if (failureReason) {
    die(failureReason);
  }
}

// ---------------------------------------------------------------------------
// Subcommand: outbox list / outbox retry / outbox cancel (issue #607)
//
// Operator visibility and recovery for outbox delivery state, without raw
// SQLite editing. `list` is read-only and session-scoped by matching payload
// owner/repo against the session's configured GitHub repo (and, for a
// split-provider Gitea session, its Gitea work-item repo too) — the same
// ownership rule dispatch-outbox.ts uses to scope dispatch, so a shared DB
// with pending rows from more than one session never leaks another session's
// rows into this view. `retry`/`cancel` mutate a single explicitly-selected
// row, follow the standard preview/--yes contract, and both refuse a row that
// does not belong to the given session's repo(s). Every human/JSON view is
// built from a safe summary (id, topic, owner/repo, issue/PR number, attempt
// count, already-sanitized last error, timestamps) — never the raw payload
// body, so no comment text, secret, token, or local path can leak through.
// ---------------------------------------------------------------------------

interface OutboxSessionScope {
  belongsToSession(entry: OutboxEntry): boolean;
  /**
   * Absolute filesystem roots to strip from any outbox field before display
   * (issue #607 review follow-up): `sanitizeBody`'s generic heuristic only
   * recognizes a fixed set of Unix root names, so a session whose checkout
   * lives under a nonstandard top-level directory (e.g. `/company/internal/repo`)
   * needs these session-specific roots re-applied, or a path embedded in a
   * persisted `lastError` would leak through `outbox list`.
   */
  redactionPaths: string[];
  /**
   * The dispatch-identity key whose persisted scan cursors govern this
   * session's rows (issue #820), derived from the session config by the one
   * shared derivation `dispatch-outbox.ts` uses — so an `outbox retry` rewinds
   * exactly the cursors a later dispatch of this session will read, and cannot
   * drift from them. See `docs/outbox-scan-cursor-contract.md` §13.
   */
  cursorIdentityKey: string;
}

/**
 * Resolve the session's repo-ownership filter for outbox rows. Mirrors the
 * `entryFilter` dispatch-outbox.ts builds for session-scoped dispatch: a
 * legacy/GitHub row matches `githubOwner`/`githubName`; a split-provider Gitea
 * work-item row also matches the session's configured Gitea owner/repo. Dies
 * (never returns) when the sessions file or sessionId cannot be resolved.
 */
async function resolveOutboxSessionScope(
  sessionId: string,
  sessionsPath: string,
): Promise<OutboxSessionScope> {
  let registry: JsonSessionRegistry;
  try {
    registry = new JsonSessionRegistry(sessionsPath);
  } catch (err) {
    die(
      `Failed to load sessions file (${sessionsPath}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const session = await registry.getSessionById(sessionId);
  if (!session) {
    die(describeUnresolvedSessionId(registry, sessionId, sessionsPath));
  }
  const { githubOwner, githubName } = session;
  const gitea =
    session.workItemProvider?.provider === "gitea-issues" ? session.workItemProvider.gitea : undefined;
  return {
    belongsToSession(entry: OutboxEntry): boolean {
      const { owner, repo } = entry.payload;
      if (owner === githubOwner && repo === githubName) return true;
      if (gitea && owner === gitea.owner && repo === gitea.repo) return true;
      return false;
    },
    redactionPaths: sessionRedactionPaths(session),
    // Same tuple, same derivation as `dispatch-outbox.ts` builds for the
    // dispatcher (issue #820): session id plus the full repository/provider
    // ownership tuple, including the Gitea instance when the session is
    // split-provider. Deriving it from the session config — never from an
    // operator-supplied flag — is what guarantees the retry rewinds the same
    // cursor rows the next dispatch of this session will consult.
    cursorIdentityKey: deriveOwnershipScanCursorKey({
      sessionId,
      githubOwner,
      githubName,
      ...(gitea ? { gitea: { owner: gitea.owner, repo: gitea.repo, baseUrl: gitea.baseUrl } } : {}),
    }),
  };
}

interface OutboxSummaryEntry {
  id: number;
  topic: string;
  status: OutboxDeliveryStatus;
  owner: string;
  repo: string;
  issueNumber?: number;
  prNumber?: number;
  createdAt: string;
  attemptCount: number;
  lastError?: string;
  nextAttemptAt?: string;
  deadLetterAt?: string;
  cancelledAt?: string;
  claimedAt?: string;
}

/**
 * Build the safe, public-view summary of an outbox row: never the raw payload
 * body (which may carry agent-composed prose) — only fields that are already
 * safe to show an operator (issue #607). `redactPaths` re-sanitizes `lastError`
 * with the session's own filesystem roots: persistence already ran
 * `sanitizeBody` with no configured paths, so a checkout under a nonstandard
 * top-level directory would otherwise survive into this view (issue #607
 * review follow-up).
 */
function summarizeOutboxEntry(
  entry: OutboxEntry,
  status: OutboxDeliveryStatus,
  redactPaths: string[],
): OutboxSummaryEntry {
  const payload = entry.payload as unknown as Record<string, unknown>;
  const issueNumber = typeof payload["issueNumber"] === "number" ? (payload["issueNumber"] as number) : undefined;
  const prNumber = typeof payload["prNumber"] === "number" ? (payload["prNumber"] as number) : undefined;
  return {
    id: entry.id,
    topic: entry.topic,
    status,
    owner: entry.payload.owner,
    repo: entry.payload.repo,
    ...(issueNumber !== undefined ? { issueNumber } : {}),
    ...(prNumber !== undefined ? { prNumber } : {}),
    createdAt: entry.createdAt,
    attemptCount: entry.attemptCount,
    ...(entry.lastError !== undefined ? { lastError: sanitizeBody(entry.lastError, redactPaths) } : {}),
    ...(entry.nextAttemptAt !== undefined ? { nextAttemptAt: entry.nextAttemptAt } : {}),
    ...(entry.deadLetterAt !== undefined ? { deadLetterAt: entry.deadLetterAt } : {}),
    ...(entry.cancelledAt !== undefined ? { cancelledAt: entry.cancelledAt } : {}),
    ...(status === "in_flight" && entry.claimedAt !== undefined ? { claimedAt: entry.claimedAt } : {}),
  };
}

interface OutboxListArgs {
  sessionId: string;
  sessionsPath: string;
  dbPath: string | undefined;
  status: OutboxDeliveryStatus | undefined;
  limit: number;
}

function parseOutboxListArgs(argv: string[]): OutboxListArgs | { error: string } {
  const parsed = parseCommonOptions(argv, {
    session: "required",
    issueNumber: "none",
    valueFlags: ["status", "limit"],
  });
  if ("error" in parsed) return { error: parsed.error };
  const { args } = parsed;

  let status: OutboxDeliveryStatus | undefined;
  const rawStatus = args["status"];
  if (rawStatus !== undefined) {
    if (
      rawStatus !== "pending" &&
      rawStatus !== "delayed" &&
      rawStatus !== "in_flight" &&
      rawStatus !== "dead"
    ) {
      return { error: `--status must be one of: pending, delayed, in_flight, dead, got: ${rawStatus}` };
    }
    status = rawStatus;
  }

  let limit = 50;
  if (args["limit"] !== undefined) {
    const n = Number(args["limit"]);
    if (!Number.isInteger(n) || n <= 0) {
      return { error: `--limit must be a positive integer, got: ${args["limit"]}` };
    }
    limit = n;
  }

  return {
    sessionId: parsed.sessionId,
    sessionsPath: parsed.sessionsPath,
    dbPath: parsed.dbPath,
    status,
    limit,
  };
}

function renderOutboxList(
  payload: {
    sessionId: string;
    status?: OutboxDeliveryStatus;
    counts: { pending: number; delayed: number; in_flight: number; dead: number };
    totalMatching: number;
    limit: number;
    entries: OutboxSummaryEntry[];
  },
  _mode: OutputMode,
): string {
  const { sessionId, status, counts, totalMatching, limit, entries } = payload;
  const lines = [
    `Outbox for session ${sessionId}: ${counts.pending} pending, ${counts.delayed} delayed, ` +
      `${counts.in_flight} in-flight, ${counts.dead} dead` +
      (status ? ` (showing: ${status})` : ""),
  ];
  if (entries.length === 0) {
    lines.push("  (no matching rows)");
    return lines.join("\n");
  }
  for (const e of entries) {
    const target =
      e.issueNumber !== undefined ? `issue #${e.issueNumber}` : e.prNumber !== undefined ? `PR #${e.prNumber}` : "";
    const parts = [`#${e.id}`, `[${e.status}]`, e.topic, `${e.owner}/${e.repo}`];
    if (target) parts.push(target);
    parts.push(`attempts=${e.attemptCount}`);
    lines.push(`  ${parts.join(" ")}`);
    if (e.claimedAt) lines.push(`      claimedAt: ${e.claimedAt}`);
    if (e.lastError) lines.push(`      lastError: ${e.lastError}`);
  }
  if (totalMatching > entries.length) {
    lines.push(`  ... ${totalMatching - entries.length} more not shown (--limit ${limit})`);
  }
  return lines.join("\n");
}

async function runOutboxList(argv: string[]): Promise<void> {
  const parsed = parseOutboxListArgs(argv);
  if ("error" in parsed) die(parsed.error);
  const { sessionId, sessionsPath, dbPath, status, limit } = parsed;

  const scope = await resolveOutboxSessionScope(sessionId, sessionsPath);

  const outboxStore = new SqliteOutboxStore(dbPath ?? DEFAULT_DB_PATH);
  let owned: OutboxEntry[];
  try {
    const all = await outboxStore.listUnsent();
    owned = all.filter((entry) => scope.belongsToSession(entry));
  } finally {
    outboxStore.close();
  }

  const now = new Date().toISOString();
  const categorized = owned.map((entry) => ({ entry, status: categorizeOutboxEntry(entry, now) }));
  const counts = { pending: 0, delayed: 0, in_flight: 0, dead: 0 };
  for (const c of categorized) counts[c.status]++;

  const matching = status ? categorized.filter((c) => c.status === status) : categorized;
  const displayed = matching
    .slice(0, limit)
    .map((c) => summarizeOutboxEntry(c.entry, c.status, scope.redactionPaths));

  const result = {
    ok: true as const,
    sessionId,
    ...(status ? { status } : {}),
    counts,
    totalMatching: matching.length,
    limit,
    entries: displayed,
  };
  report(result, (mode) => renderOutboxList(result, mode));
}

interface OutboxRowActionArgs {
  sessionId: string;
  sessionsPath: string;
  dbPath: string | undefined;
  id: number;
  yes: boolean;
}

function parseOutboxRowActionArgs(argv: string[]): OutboxRowActionArgs | { error: string } {
  const parsed = parseCommonOptions(argv, {
    session: "required",
    issueNumber: "none",
    booleanFlags: ["yes"],
    valueFlags: ["id"],
  });
  if ("error" in parsed) return { error: parsed.error };
  const { args, flags } = parsed;
  if (args["id"] === undefined) return { error: "--id is required" };
  const id = Number(args["id"]);
  if (!Number.isInteger(id) || id <= 0) {
    return { error: `--id must be a positive integer, got: ${args["id"]}` };
  }
  return {
    sessionId: parsed.sessionId,
    sessionsPath: parsed.sessionsPath,
    dbPath: parsed.dbPath,
    id,
    yes: flags.has("yes"),
  };
}

/**
 * Mirror `SqliteOutboxStore#retryEntry`'s eligibility check (issue #607 review
 * follow-up) so the no-`--yes` preview never promises a recovery the mutation
 * itself would refuse: a sent row can never be retried, and a row that is
 * neither delayed nor dead-lettered is already immediately dispatch-eligible
 * with nothing to recover.
 */
function previewOutboxRetry(
  entry: OutboxEntry,
  nowIso: string,
  maintenanceLocked = false,
): { wouldRetry: boolean; reason?: string } {
  if (entry.sentAt !== undefined) return { wouldRetry: false, reason: "already_sent" };
  const isDelayed = entry.nextAttemptAt !== undefined && entry.nextAttemptAt > nowIso;
  const isDead = entry.deadLetterAt !== undefined;
  if (!isDelayed && !isDead) return { wouldRetry: false, reason: "already_pending" };
  // Checked last (issue #818), mirroring `retryEntry`'s own order: it evaluates
  // eligibility before reaching the guarded write, so an already-sent row
  // reports `already_sent` under maintenance too, not `maintenance_locked`.
  if (maintenanceLocked) return { wouldRetry: false, reason: "maintenance_locked" };
  return { wouldRetry: true };
}

/**
 * Read the session identity's three persisted cursors and decide what an
 * `outbox retry` of row `id` would have to rewind (issue #820).
 *
 * Read-only — three `SELECT`s and one pure function — so the preview stays
 * non-mutating while still reporting the rewind by the *same* rule the store's
 * transactional `UPDATE ... WHERE after_id >= ?` applies. Absent cursor rows
 * are reported as absent (never as `0`), which is what makes "absent stays
 * absent" visible to the operator before they pass `--yes`.
 */
async function previewOutboxCursorRewind(
  outboxStore: { getScanCursor(key: string): Promise<number | undefined> },
  cursorIdentityKey: string,
  id: number,
): Promise<OutboxScanCursorRewindPlan & { cursors: OutboxScanCursorAfterIds }> {
  const keys = scanCursorKeysFor(cursorIdentityKey);
  const cursors: OutboxScanCursorAfterIds = {};
  for (const role of OUTBOX_SCAN_CURSOR_ROLES) {
    const afterId = await outboxStore.getScanCursor(keys[role]);
    if (afterId !== undefined) cursors[role] = afterId;
  }
  return { ...planScanCursorRewind(cursors, id), cursors };
}

/**
 * Mirror `SqliteOutboxStore#cancelEntry`'s eligibility check (issue #607
 * review follow-up): a sent or already-cancelled row cannot be cancelled
 * again, and a row a dispatch attempt currently holds a claim on cannot be
 * safely reported as cancelled (that attempt may already have performed the
 * external side effect) — so the preview must not claim otherwise.
 */
function previewOutboxCancel(
  entry: OutboxEntry,
  nowIso: string,
  maintenanceLocked = false,
): { wouldCancel: boolean; reason?: string } {
  // Checked first (issue #818), mirroring `cancelEntry`'s own order: its
  // maintenance guard sits ahead of the single conditional UPDATE that
  // evaluates every other reason, so a held lock is what it reports for any row.
  if (maintenanceLocked) return { wouldCancel: false, reason: "maintenance_locked" };
  if (entry.sentAt !== undefined) return { wouldCancel: false, reason: "already_sent" };
  if (entry.cancelledAt !== undefined) return { wouldCancel: false, reason: "already_cancelled" };
  if (isOutboxClaimActive(entry.claimedAt, nowIso)) return { wouldCancel: false, reason: "dispatch_in_progress" };
  return { wouldCancel: true };
}

async function runOutboxRetry(argv: string[]): Promise<void> {
  const parsed = parseOutboxRowActionArgs(argv);
  if ("error" in parsed) die(parsed.error);
  const { sessionId, sessionsPath, dbPath, id, yes } = parsed;

  const scope = await resolveOutboxSessionScope(sessionId, sessionsPath);
  const outboxStore = new SqliteOutboxStore(dbPath ?? DEFAULT_DB_PATH);
  try {
    const entry = await outboxStore.getById(id);
    if (!entry) die(`Unknown outbox row id: ${id}`);
    if (!scope.belongsToSession(entry)) {
      die(`Outbox row ${id} does not belong to session ${sessionId}`);
    }
    if (!yes) {
      const now = new Date().toISOString();
      const status = categorizeOutboxEntry(entry, now);
      const { wouldRetry, reason } = previewOutboxRetry(entry, now, await outboxStore.isMaintenanceLocked());
      // Reported on every preview, eligible or not (issue #820): whether the
      // recovery also has to move a cursor is the part an operator cannot see
      // from the row itself, and it is exactly what decides whether the row
      // becomes discoverable again or silently stays stranded.
      const rewind = await previewOutboxCursorRewind(outboxStore, scope.cursorIdentityKey, id);
      emit({
        ok: true,
        sessionId,
        id,
        retried: false,
        wouldRetry,
        status,
        ...(reason !== undefined ? { reason } : {}),
        cursorRewind: {
          required: rewind.required,
          targetAfterId: rewind.targetAfterId,
          roles: rewind.roles,
          cursors: rewind.cursors,
        },
        hint: wouldRetry
          ? rewind.required
            ? `Re-run with --yes to retry this row (also rewinds scan cursor(s) ${rewind.roles.join(", ")} to ${rewind.targetAfterId}, atomically).`
            : "Re-run with --yes to retry this row."
          : reason === "maintenance_locked"
            ? "Refused: a maintenance lock is held on this database; retry once it is released."
            : `No-op: this row is ${reason === "already_sent" ? "already sent" : "already pending"}.`,
      });
      return;
    }
    // The cursor scope resolved from the session config travels with the
    // mutation (issue #820) so the row update and every required rewind commit
    // in one transaction — a retry that revived the row but left the cursors
    // ahead of it would leave the row pending yet permanently unscanned.
    const result = await outboxStore.retryEntry(id, undefined, { cursorIdentityKey: scope.cursorIdentityKey });
    emit({ ok: true, sessionId, id, ...result });
  } finally {
    outboxStore.close();
  }
}

async function runOutboxCancel(argv: string[]): Promise<void> {
  const parsed = parseOutboxRowActionArgs(argv);
  if ("error" in parsed) die(parsed.error);
  const { sessionId, sessionsPath, dbPath, id, yes } = parsed;

  const scope = await resolveOutboxSessionScope(sessionId, sessionsPath);
  const outboxStore = new SqliteOutboxStore(dbPath ?? DEFAULT_DB_PATH);
  try {
    const entry = await outboxStore.getById(id);
    if (!entry) die(`Unknown outbox row id: ${id}`);
    if (!scope.belongsToSession(entry)) {
      die(`Outbox row ${id} does not belong to session ${sessionId}`);
    }
    if (!yes) {
      const now = new Date().toISOString();
      const status = categorizeOutboxEntry(entry, now);
      const { wouldCancel, reason } = previewOutboxCancel(entry, now, await outboxStore.isMaintenanceLocked());
      emit({
        ok: true,
        sessionId,
        id,
        cancelled: false,
        wouldCancel,
        status,
        ...(reason !== undefined ? { reason } : {}),
        hint: wouldCancel
          ? "Re-run with --yes to cancel this row."
          : reason === "maintenance_locked"
            ? "Refused: a maintenance lock is held on this database; retry once it is released."
            : reason === "already_sent"
              ? "No-op: this row is already sent."
              : reason === "dispatch_in_progress"
                ? "No-op: a dispatch attempt is currently in flight for this row; retry the cancel shortly."
                : "No-op: this row is already cancelled.",
      });
      return;
    }
    const result = await outboxStore.cancelEntry(id);
    // A cancelled row is dead-lettered too, so for a terminal refinement
    // handoff's comment this is §12 row 46 by operator decision rather than by
    // exhausted retries (issue #936): the Issue will never carry the notice, and
    // the task is the only surface left that can say so.
    //
    // The condition is "the row IS cancelled", not "this invocation cancelled
    // it" (P2 review follow-up). `cancelEntry` and this append are two writes
    // that cannot be made atomic, so the append can fail on its own — and a
    // re-run would then report `already_cancelled` and, gated on
    // `result.cancelled`, skip the very repair it was run for, leaving the
    // handoff permanently without its audit record. Recording on the state
    // instead makes the command idempotent AND repairing; the recorder is a
    // no-op once the event exists, and for every other row shape. (The
    // dispatcher's own sweep repairs it too, on its next run.)
    if (result.cancelled || entry.cancelledAt !== undefined) {
      const taskStore = new SqliteTaskStore(dbPath ?? DEFAULT_DB_PATH);
      try {
        await recordRefinementHandoffCommentUndeliverable(
          taskStore, entry, "cancelled", new Date().toISOString(),
        );
      } catch (err) {
        // The cancel itself already committed, so this cannot be reported as a
        // failed cancel: say precisely what is missing and that re-running is
        // how to repair it.
        die(
          `Outbox row ${id} is cancelled, but recording its undeliverable-handoff audit event failed: ` +
            `${err instanceof Error ? err.message : String(err)}. Re-run this command to record it.`,
        );
      } finally {
        taskStore.close();
      }
    }
    emit({ ok: true, sessionId, id, ...result });
  } finally {
    outboxStore.close();
  }
}

// ---------------------------------------------------------------------------
// Subcommand: review-lock status / review-lock release (issue #459)
//
// Operator recovery for the lock a worktree-enabled review holds. The
// worktree-safe review (issue #456) serializes on the per-issue worktree lock
// (scope `<session>::issue-<n>`) and runs inside that issue's worktree — there
// is no separate canonical/session-wide review lock, so an orphaned review lock
// only blocks the SAME issue's later reviews, not every review. These commands
// are the review-named entry point to inspect and force-release that lock; they
// operate on the exact same lock as `worktree release-lock` (which stays the
// generic per-issue recovery surface and is unchanged). `release` previews by
// default, requires --yes to act, and refuses a live lock without --force, so a
// recovery can never silently race a live run. The lock store's stale window is
// 24h with no heartbeat, so a leaked lock is not self-healing in any practical
// time — hence the explicit operator path.
// ---------------------------------------------------------------------------

function runReviewLockStatus(argv: string[]): void {
  const parsed = parseStrictArgs(argv, {
    value: ["session-id", "issue-number", "lock-dir"],
    boolean: [],
  });
  if ("error" in parsed) die(parsed.error);
  const { args } = parsed;
  if (!args["session-id"]) die("--session-id is required");
  if (args["issue-number"] === undefined) die("--issue-number is required");
  const issueNumber = Number(args["issue-number"]);
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    die(`--issue-number must be a positive integer, got: ${args["issue-number"]}`);
  }
  const sessionId = args["session-id"];

  const lock = new IssueWorktreeLock(args["lock-dir"]);
  const state = lock.inspect(sessionId, issueNumber);
  emit({
    ok: true,
    sessionId,
    issueNumber,
    lockKind: "review",
    reviewLockScope: issueLockScope(sessionId, issueNumber),
    held: state.contextId !== null,
    locked: state.locked,
    stale: state.stale,
    ownerContextId: state.contextId,
    startedAt: state.startedAt,
    ageMs: state.ageMs,
    lockPath: state.lockPath,
  });
}

function runReviewLockRelease(argv: string[]): void {
  const parsed = parseIssueLockReleaseArgs(argv);
  if ("error" in parsed) die(parsed.error);
  const { sessionId, issueNumber, lockDir, yes, force } = parsed;
  const lock = new IssueWorktreeLock(lockDir);
  const outcome = resolveIssueLockRelease(lock, sessionId, issueNumber, { yes, force });
  emit({
    ok: true,
    sessionId,
    issueNumber,
    lockKind: "review",
    reviewLockScope: issueLockScope(sessionId, issueNumber),
    ...outcome,
  });
}

// ---------------------------------------------------------------------------
// Subcommand: worktree recovery (issue #408)
//
// Gather the drift signals for one issue (or every issue with a task or local
// ai/issue-* branch) and classify each with the pure core in
// core/worktree-recovery.ts. Read-only: it inspects git/lock/PR/task state and
// prints a recommendation (resume / recreate / cleanup / report-drift /
// skip-locked) plus the concrete follow-up command, but performs no mutation.
// Worktree paths are surfaced to the operator only (local-only, never published).
// ---------------------------------------------------------------------------

interface WorktreeRecoveryArgs {
  sessionId: string;
  issueNumber: number | undefined;
  sessionsPath: string;
  dbPath: string | undefined;
  lockDir: string | undefined;
}

function parseWorktreeRecoveryArgs(argv: string[]): WorktreeRecoveryArgs | { error: string } {
  const opts = parseCommonOptions(argv, {
    session: "required",
    issueNumber: "optional",
    valueFlags: ["lock-dir"],
  });
  if ("error" in opts) return { error: opts.error };
  return {
    sessionId: opts.sessionId,
    issueNumber: opts.issueNumber,
    sessionsPath: opts.sessionsPath,
    dbPath: opts.dbPath,
    lockDir: opts.args["lock-dir"],
  };
}

/** Local `ai/issue-<n>` branches in the canonical repo, as issue numbers. */
function localIssueBranches(repoRoot: string): number[] {
  const probed = probe(
    "git",
    ["for-each-ref", "--format=%(refname:short)", "refs/heads/ai/issue-*"],
    repoRoot,
  );
  if (!probed.ok || probed.output === "") return [];
  const numbers: number[] = [];
  for (const ref of probed.output.split("\n")) {
    const m = ref.trim().match(/^ai\/issue-(\d+)$/);
    if (m) numbers.push(Number(m[1]));
  }
  return numbers;
}

/** Count of commits `branch` is ahead of `baseBranch`, or null when not computable. */
function commitsAheadOfBase(repoRoot: string, baseBranch: string, branch: string): number | null {
  const probed = probe("git", ["rev-list", "--count", `${baseBranch}..${branch}`], repoRoot);
  if (!probed.ok) return null;
  const n = Number(probed.output.trim());
  return Number.isInteger(n) ? n : null;
}

// Statuses whose task context implies a worktree should already exist: the task
// was claimed and actively executed (or failed mid-flight), so a missing worktree
// is genuine drift. A fresh `queued` first-run task never created one, and a
// `done` task's worktree was legitimately pruned — neither is drift. `blocked`
// (dependency holds) and `ready_for_human` (Tool Request handoffs) are excluded:
// both can be produced before any resumable worktree exists, so treating them as
// status-implied drift would surface normal waits as `report-drift` and wrongly
// advise re-queueing. A blocked/ready_for_human task that DID establish a worktree
// is still caught via its recorded branch/prUrl in taskExpectsWorktree.
const WORKTREE_RECOVERY_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  "claimed",
  "running",
  "failed",
]);

// Terminal statuses whose worktree was legitimately pruned once the work landed
// (or was abandoned). These tasks keep `prUrl`/`branch` in their context as the
// normal end state, so that PR context must NOT be trusted as evidence of
// expected-but-missing drift. `cancelled` (issue #608) is terminal exactly like
// `done` for this purpose: a cancelled task's worktree is a valid `worktree
// cleanup` prune candidate, so its absence is never drift either.
const WORKTREE_TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>(["done", "cancelled"]);

/**
 * True when a task's context expects an existing worktree, so a missing one is
 * recoverable drift rather than a healthy fresh/terminal state. A task qualifies
 * when it records worktree context (a branch/PR established by a prior run, even
 * if later re-queued) or sits in a recovery-relevant status. Filtering on this
 * keeps the classifier from reporting `report-drift` (and advising operators to
 * re-queue) for normal queued first-run tasks or completed tasks whose worktree
 * was pruned.
 *
 * Terminal `done` tasks are excluded first: they normally retain `prUrl`/`branch`
 * after their PR was created, so trusting that PR context would wrongly flag a
 * completed issue whose worktree was legitimately pruned as recoverable drift.
 */
function taskExpectsWorktree(task: AiTask): boolean {
  if (WORKTREE_TERMINAL_STATUSES.has(task.status)) return false;
  const { prUrl, branch } = resolvePrContext(task);
  if (prUrl !== undefined || branch !== undefined) return true;
  // A Tool Request resolved before a PR exists re-queues the implementation task
  // with only `toolRequestResumeBranch` as its continuation point. That branch is
  // expected-but-possibly-missing worktree context (e.g. pushed from another clone
  // with no local branch/worktree here), so treat it like recorded branch context.
  if (resolveResumeBranch(task) !== undefined) return true;
  return WORKTREE_RECOVERY_STATUSES.has(task.status);
}

/**
 * The branch a Tool Request resolution recorded as the requeued implementation
 * task's resume point (`context.toolRequestResumeBranch`), or undefined. This is
 * a worktree-context signal distinct from the PR head branch (`context.branch`):
 * it can be the sole continuation marker for a task whose Tool Request was
 * resolved before any PR existed.
 */
function resolveResumeBranch(task: AiTask): string | undefined {
  const ctx = task.context as Record<string, unknown>;
  return typeof ctx.toolRequestResumeBranch === "string" ? ctx.toolRequestResumeBranch : undefined;
}

function renderWorktreeRecovery(
  payload: {
    sessionId: string;
    baseBranch: string;
    assessments: Array<
      WorktreeRecoveryAssessment & { worktreePath: string; holderPath?: string }
    >;
  },
  mode: OutputMode,
): string {
  if (payload.assessments.length === 0) {
    return `No worktree drift to assess for session ${payload.sessionId}.`;
  }
  const lines: string[] = [];
  if (!mode.quiet) {
    lines.push(
      `Worktree recovery for session ${payload.sessionId} (base ${payload.baseBranch}), ${payload.assessments.length} issue(s):`,
    );
  }
  for (const a of payload.assessments) {
    const tags = [a.resume ? "resume" : null, a.stale ? "stale" : null, a.staleLock ? "stale-lock" : null]
      .filter(Boolean)
      .join(",");
    lines.push(`  #${a.issueNumber}  ${a.action}${tags ? `  [${tags}]` : ""}`);
    lines.push(`        ${a.guidance}`);
    if (mode.verbose) {
      lines.push(`        worktreePath: ${a.worktreePath}`);
      if (a.holderPath) {
        lines.push(`        branch checked out at: ${a.holderPath}`);
      }
    }
  }
  return lines.join("\n");
}

async function runWorktreeRecovery(argv: string[]): Promise<void> {
  const parsed = parseWorktreeRecoveryArgs(argv);
  if ("error" in parsed) die(parsed.error);

  const { sessionId, issueNumber, sessionsPath, dbPath, lockDir } = parsed;
  const sessionInfo = loadSessionInfo(sessionId, sessionsPath);
  if ("error" in sessionInfo) die(sessionInfo.error);

  const { repoRoot, baseBranch } = sessionInfo;
  let worktreeRoot: string;
  try {
    worktreeRoot = resolveSessionWorktreeRoot(sessionInfo);
  } catch (err) {
    die(err instanceof Error ? err.message : String(err));
  }

  const listed = listWorktrees(repoRoot);
  if (!listed.ok) die(listed.error);

  // Determine which issues to assess: the explicit one, or the union of issues
  // whose task expects a worktree (see taskExpectsWorktree — fresh queued and
  // terminal `done` rows are excluded so they are not reported as drift) and
  // issues that have a local ai/issue-* branch (so a branch-only drift with no
  // task — the #404 class — is still surfaced). PR state is read from recorded
  // task context only (no network/gh call) so the diagnosis stays offline and
  // fast; a recorded prUrl marks an open PR.
  const store = new SqliteTaskStore(dbPath);
  const prByIssue = new Map<number, boolean>();
  // Records the PR head branch a task's context preserves when it is not the
  // conventional `ai/issue-<n>` (fix/review/conflict flows keep `context.branch`).
  // Recovery must probe and compare against that recorded branch, not a
  // synthesized one, or it would inspect the wrong local/remote ref and report a
  // valid worktree as a path conflict / recreate it from the wrong branch.
  const branchByIssue = new Map<number, string>();
  // Issues whose only task is terminal `done`: their worktree was legitimately
  // pruned, but worktree cleanup does not always remove the local `ai/issue-<n>`
  // branch. That leftover branch must not re-enter the scan via
  // localIssueBranches() and steer a completed issue toward recreate/cleanup
  // guidance, so it is subtracted from the local-branch union below. An issue
  // that also has a non-terminal task is re-added through taskIssueSet.
  const terminalIssueSet = new Set<number>();
  // Issues with a live (non-terminal) task row, regardless of whether that task
  // expects a worktree yet. taskIssueSet is the narrower expects-a-worktree set
  // used to drive the broad scan; this wider set answers "does any task still
  // reference the issue?" so an explicitly-requested healthy queued/blocked/
  // handoff task is reported as recoverable drift rather than misclassified as a
  // stale cleanup candidate ("no task references the issue").
  const liveTaskIssueSet = new Set<number>();
  let issueNumbers: number[];
  let taskIssueSet: Set<number>;
  try {
    const tasks =
      issueNumber !== undefined
        ? await store.getTask({ sessionId, issueNumber }).then((t) => (t ? [t] : []))
        : await store.listSessionTasks(sessionId);
    taskIssueSet = new Set(tasks.filter(taskExpectsWorktree).map((t) => t.issueNumber));
    for (const t of tasks) {
      // Skip terminal `done` tasks: their retained prUrl is the normal end state,
      // not evidence of an open PR whose worktree should be recreated. Trusting it
      // would steer a legitimately-pruned completed issue toward recreate guidance.
      if (WORKTREE_TERMINAL_STATUSES.has(t.status)) {
        terminalIssueSet.add(t.issueNumber);
        continue;
      }
      liveTaskIssueSet.add(t.issueNumber);
      const ctx = resolvePrContext(t);
      if (ctx.prUrl) prByIssue.set(t.issueNumber, true);
      // Prefer the recorded PR head branch; fall back to a Tool Request resume
      // branch so a requeued task whose only continuation point is
      // `toolRequestResumeBranch` (no `context.branch`, possibly origin-only) is
      // probed against that ref instead of a synthesized `ai/issue-<n>` name.
      const recordedBranch = ctx.branch ?? resolveResumeBranch(t);
      if (recordedBranch) branchByIssue.set(t.issueNumber, recordedBranch);
    }
    issueNumbers =
      issueNumber !== undefined
        ? [issueNumber]
        : Array.from(
            new Set([
              ...taskIssueSet,
              // Suppress local branches whose only task is terminal `done` so a
              // completed issue's leftover branch is not re-surfaced as drift.
              // taskIssueSet still re-adds any such issue that also has a live task.
              ...localIssueBranches(repoRoot).filter((n) => !terminalIssueSet.has(n)),
            ]),
          ).sort((a, b) => a - b);
  } finally {
    store.close();
  }

  const lock = new IssueWorktreeLock(lockDir);

  const assessments = issueNumbers.map((n) => {
    // Prefer the PR head branch recorded in the task context (fix/review/conflict
    // flows preserve a non-`ai/issue-<n>` `context.branch`); fall back to the
    // conventional name for branch-only drift discovered with no task.
    const branch = branchByIssue.get(n) ?? branchName(n);
    const localBranchExists =
      probe("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], repoRoot).ok;
    const remoteBranch = remoteHasBranch(repoRoot, branch);
    const expectedPath = canonicalizePath(issueWorktreePath(worktreeRoot, sessionId, n));
    const entry = listed.worktrees.find((w) => canonicalizePath(w.path) === expectedPath);
    // A prunable entry means git still lists the registration but the checkout
    // directory is gone (deleted out of band). It must not count as a resumable
    // worktree: the path no longer exists, so a resume follow-up would fail.
    const worktreeRegistered = Boolean(
      entry && entry.branch === `refs/heads/${branch}` && !entry.prunable,
    );
    // A prunable registration at the managed path cannot simply be recreated: a
    // plain `git worktree add <managedPath> <branch>` fails with "missing but
    // already registered worktree" until the stale registration is pruned. Surface
    // it so the classifier recommends prune-then-recreate (executable) rather than a
    // plain recreate that fails closed. Checked ahead of the path-conflict signal so
    // a prunable entry on a different branch still routes to the prune path.
    const worktreePrunable = Boolean(entry && entry.prunable);
    // A registered (non-prunable) entry that is detached or on a different branch
    // occupies the managed path without matching `branch`. This is distinct from a
    // missing worktree: `git worktree add` cannot recreate into it and a resume
    // would fail closed on the mismatch, so the classifier must steer to
    // path-conflict cleanup. Prunable entries are excluded — they route to the
    // prune-then-recreate path above regardless of their recorded branch.
    const worktreePathConflict = Boolean(
      entry && !entry.prunable && entry.branch !== `refs/heads/${branch}`,
    );
    // The issue branch may be checked out in a worktree at a path other than the
    // managed one — a legacy/shared checkout, a moved worktree root, or the
    // canonical repo. `git worktree add <managedPath> <branch>` refuses to add a
    // branch already checked out elsewhere, so scan every registered worktree (not
    // just the managed path) and surface the holder rather than a recreate that
    // would fail closed.
    const elsewhereEntry = listed.worktrees.find(
      (w) => w.branch === `refs/heads/${branch}` && canonicalizePath(w.path) !== expectedPath,
    );
    const branchCheckedOutElsewhere = Boolean(elsewhereEntry);
    const prOpen = prByIssue.get(n) ?? false;

    // inspect() reports `locked: !stale`, so a stale lock has locked=false; a
    // lock record is present whenever contextId is set. Treat a present record as
    // held and carry the stale flag through so the classifier surfaces a stale
    // lock (recoverable) and skips only on an active one.
    const inspect = lock.inspect(sessionId, n);
    const lockPresent = inspect.contextId !== null;

    const assessment = assessWorktreeRecovery({
      issueNumber: n,
      branch,
      localBranchExists,
      remoteBranch,
      prOpen,
      worktreeRegistered,
      worktreePrunable,
      worktreePathConflict,
      branchCheckedOutElsewhere,
      commitsAheadOfBase: localBranchExists ? commitsAheadOfBase(repoRoot, baseBranch, branch) : null,
      taskExists: liveTaskIssueSet.has(n),
      lock: lockPresent ? { held: true, stale: Boolean(inspect.stale) } : null,
    });

    return {
      ...assessment,
      worktreePath: expectedPath,
      holderPath: elsewhereEntry ? canonicalizePath(elsewhereEntry.path) : undefined,
    };
  });

  const result = {
    ok: true,
    sessionId,
    baseBranch,
    count: assessments.length,
    assessments,
  };
  report(result, (mode) => renderWorktreeRecovery(result, mode));
}

// ---------------------------------------------------------------------------
// Subcommand: task-assign
// ---------------------------------------------------------------------------

const CONFLICT_RESOLUTION_SUPPORTED: ReadonlySet<AgentId> = new Set<AgentId>(["claude"]);

interface TaskAssignArgs {
  sessionId: string;
  issueNumber: number;
  profile: string | undefined;
  implementationAgent: AgentId | undefined;
  reviewAgent: AgentId | undefined;
  researchAgent: AgentId | undefined;
  sessionsPath: string;
  dbPath: string | undefined;
  dryRun: boolean;
}

function parseTaskAssignArgs(argv: string[]): TaskAssignArgs | { error: string } {
  const tokenized = tokenizeArgs(argv, {
    booleanFlags: ["dry-run"],
    valueFlags: [
      "session-id",
      "issue-number",
      "profile",
      "implementation-agent",
      "review-agent",
      "research-agent",
      "sessions-path",
      "db-path",
    ],
  });
  if ("error" in tokenized) return { error: tokenized.error };
  const { args, flags } = tokenized;
  const dryRun = flags.has("dry-run");

  if (!args["session-id"]) return { error: "--session-id is required" };
  if (!args["issue-number"]) return { error: "--issue-number is required" };

  const n = Number(args["issue-number"]);
  if (!Number.isInteger(n) || n <= 0) {
    return { error: `--issue-number must be a positive integer, got: ${args["issue-number"]}` };
  }

  const knownAgents: AgentId[] = ["claude", "codex", "gemini"];
  for (const flag of ["implementation-agent", "review-agent", "research-agent"] as const) {
    const val = args[flag];
    if (val !== undefined && !knownAgents.includes(val as AgentId)) {
      return { error: `--${flag} must be one of: ${knownAgents.join(", ")}, got: ${val}` };
    }
  }

  const profile = args["profile"];
  const implementationAgent = args["implementation-agent"] as AgentId | undefined;
  const reviewAgent = args["review-agent"] as AgentId | undefined;
  const researchAgent = args["research-agent"] as AgentId | undefined;

  if (!profile && !implementationAgent && !reviewAgent && !researchAgent) {
    return {
      error:
        "At least one of --profile, --implementation-agent, --review-agent, or --research-agent is required",
    };
  }

  return {
    sessionId: args["session-id"],
    issueNumber: n,
    profile,
    implementationAgent,
    reviewAgent,
    researchAgent,
    sessionsPath: args["sessions-path"] ?? DEFAULT_SESSIONS_PATH,
    dbPath: args["db-path"],
    dryRun,
  };
}

async function runTaskAssign(argv: string[]): Promise<void> {
  const parsed = parseTaskAssignArgs(argv);
  if ("error" in parsed) die(parsed.error);

  const {
    sessionId,
    issueNumber,
    profile,
    implementationAgent,
    reviewAgent,
    researchAgent,
    sessionsPath,
    dbPath,
    dryRun,
  } = parsed;

  let registry: JsonSessionRegistry;
  try {
    registry = new JsonSessionRegistry(sessionsPath);
  } catch (err) {
    die(
      `Failed to load sessions file (${sessionsPath}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const session = await registry.getSessionById(sessionId);
  if (!session) {
    die(describeUnresolvedSessionId(registry, sessionId, sessionsPath));
  }

  if (profile !== undefined && profile !== DEFAULT_FLOW) {
    const profiles = session.assignmentProfiles ?? {};
    if (!(profile in profiles)) {
      const known = [DEFAULT_FLOW, ...Object.keys(profiles)];
      die(`Unknown profile: "${profile}". Known profiles: ${known.join(", ")}`);
    }
  }

  const store = new SqliteTaskStore(dbPath);
  try {
    const task = await store.getTask({ sessionId, issueNumber });
    if (!task) {
      die(`Task not found: session "${sessionId}", issue #${issueNumber}`);
    }

    if (task.status === "claimed" || task.status === "running") {
      die(
        `Task #${issueNumber} in session "${sessionId}" is currently ${task.status}` +
          (task.ownerRunId ? ` (owner: ${task.ownerRunId})` : "") +
          `. Refusing to modify an active task. Wait for it to complete or recover it first.`,
      );
    }

    const now = new Date().toISOString();

    // Determine base agents from the named profile or the existing task assignment.
    let baseImplAgent: AgentId;
    let baseReviewAgent: AgentId;
    let baseConflictAgent: AgentId;
    let baseResearchAgent: AgentId | undefined;
    let flow: string;
    let source: "session-config" | "default";

    if (profile !== undefined) {
      const profileEntry = session.assignmentProfiles?.[profile];
      if (profileEntry) {
        if (
          profileEntry.conflict_resolution !== undefined &&
          !CONFLICT_RESOLUTION_SUPPORTED.has(profileEntry.conflict_resolution)
        ) {
          die(
            `Profile "${profile}" sets conflict_resolution to "${profileEntry.conflict_resolution}", ` +
              `which is not a supported agent for conflict resolution. ` +
              `Supported: ${[...CONFLICT_RESOLUTION_SUPPORTED].join(", ")}`,
          );
        }
        baseImplAgent = profileEntry.implementation;
        baseReviewAgent = profileEntry.review;
        const rawConflict = profileEntry.conflict_resolution ?? profileEntry.implementation;
        baseConflictAgent = CONFLICT_RESOLUTION_SUPPORTED.has(rawConflict) ? rawConflict : "claude";
        baseResearchAgent = profileEntry.research ?? session.defaults.researchAgent;
        flow = profile;
        source = "session-config";
      } else {
        // Built-in 'code' flow derived from session defaults.
        baseImplAgent = session.defaults.implementationAgent;
        baseReviewAgent = session.defaults.reviewAgent;
        baseConflictAgent = CONFLICT_RESOLUTION_SUPPORTED.has(session.defaults.implementationAgent)
          ? session.defaults.implementationAgent
          : "claude";
        baseResearchAgent = session.defaults.researchAgent;
        flow = DEFAULT_FLOW;
        source = "default";
      }
    } else {
      // No profile: base on the existing task assignment, then fall back to legacy per-column
      // agent overrides (the same priority order agentForPhase uses), then session defaults.
      const existing = readResolvedAssignment(task);
      baseImplAgent =
        existing?.implementationAgent ?? task.implementationAgent ?? session.defaults.implementationAgent;
      baseReviewAgent =
        existing?.reviewAgent ?? task.reviewAgent ?? session.defaults.reviewAgent;
      const legacyConflictBase = task.implementationAgent ?? session.defaults.implementationAgent;
      baseConflictAgent =
        existing?.conflictResolutionAgent ??
        (CONFLICT_RESOLUTION_SUPPORTED.has(legacyConflictBase)
          ? legacyConflictBase
          : "claude");
      baseResearchAgent =
        existing?.researchAgent ?? task.researchAgent ?? session.defaults.researchAgent;
      flow = existing?.flow ?? DEFAULT_FLOW;
      source = existing?.source ?? "default";
    }

    // Apply explicit per-slot overrides on top of the profile base.
    const newImplAgent = implementationAgent ?? baseImplAgent;
    const newReviewAgent = reviewAgent ?? baseReviewAgent;
    const newResearchAgent = researchAgent ?? baseResearchAgent;

    // Conflict resolution: follow the profile's explicit setting when present; otherwise
    // follow the (possibly overridden) implementation agent, clamped to supported agents.
    const profileHasExplicitConflict =
      profile !== undefined &&
      session.assignmentProfiles?.[profile]?.conflict_resolution !== undefined;
    const newConflictAgent: AgentId = profileHasExplicitConflict
      ? baseConflictAgent
      : CONFLICT_RESOLUTION_SUPPORTED.has(newImplAgent)
        ? newImplAgent
        : "claude";

    const newAssignment: ResolvedAssignment = {
      flow,
      implementationAgent: newImplAgent,
      reviewAgent: newReviewAgent,
      conflictResolutionAgent: newConflictAgent,
      ...(newResearchAgent !== undefined ? { researchAgent: newResearchAgent } : {}),
      resolvedAt: now,
      source,
    };

    const previousAssignment = readResolvedAssignment(task);

    if (dryRun) {
      emit({
        ok: true,
        dryRun: true,
        sessionId,
        issueNumber,
        previous: previousAssignment ?? null,
        new: newAssignment,
      });
      return;
    }

    // Update context.assignment and the per-phase agent columns atomically.
    // We check the current status to detect a race where the task was claimed
    // between our read above and now.
    const result = await store.transitionTask(
      { sessionId, issueNumber },
      { status: task.status },
      {
        implementationAgent: newImplAgent,
        reviewAgent: newReviewAgent,
        researchAgent: newResearchAgent,
        context: { [ASSIGNMENT_CONTEXT_KEY]: newAssignment },
        now,
      },
    );

    if (!result.ok) {
      die(
        `Failed to update task: ${result.code}` +
          (result.current ? ` (current status: ${result.current.status})` : ""),
      );
    }

    await store.appendEvent({
      task: { sessionId, issueNumber },
      type: "assignment_changed",
      message: `Assignment changed by admin task-assign${profile !== undefined ? ` --profile ${profile}` : ""}`,
      data: {
        previous: previousAssignment ?? null,
        new: newAssignment,
        ...(profile !== undefined ? { profile } : {}),
        ...(implementationAgent !== undefined ? { implementationAgentOverride: implementationAgent } : {}),
        ...(reviewAgent !== undefined ? { reviewAgentOverride: reviewAgent } : {}),
        ...(researchAgent !== undefined ? { researchAgentOverride: researchAgent } : {}),
      },
      createdAt: now,
    });

    emit({
      ok: true,
      sessionId,
      issueNumber,
      previous: previousAssignment ?? null,
      new: newAssignment,
    });
  } finally {
    store.close();
  }
}

// ---------------------------------------------------------------------------
// Subcommand: session-init
// ---------------------------------------------------------------------------

const VALID_AGENTS: AgentId[] = ["claude", "codex", "gemini"];

interface RawSessionEntry {
  sessionId: string;
  [key: string]: unknown;
}

interface SessionsFileShape {
  sessions: RawSessionEntry[];
}

interface SessionInitArgs {
  sessionsPath: string;
  sessionId: string;
  repoKey: string;
  repoRoot: string;
  githubRepo: string;
  artifactDir: string;
  implementationAgent: AgentId;
  reviewAgent: AgentId;
  researchAgent: AgentId | undefined;
  verification: Record<string, string>;
  labelsActive: string;
  labelsBlocked: string;
  labelsReadyForHuman: string;
  preset: EcosystemPreset | undefined;
}

function parseSessionInitArgs(argv: string[]): SessionInitArgs | { error: string } {
  const tokenized = tokenizeArgs(argv, {
    valueFlags: [
      "sessions-path",
      "session-id",
      "repo-key",
      "repo-root",
      "github-repo",
      "artifact-dir",
      "implementation-agent",
      "review-agent",
      "research-agent",
      "verification-json",
      "labels-active",
      "labels-blocked",
      "labels-ready-for-human",
      "preset",
    ],
  });
  if ("error" in tokenized) return { error: tokenized.error };
  const { args } = tokenized;

  if (!args["session-id"]) return { error: "--session-id is required" };
  if (!args["repo-key"]) return { error: "--repo-key is required" };
  if (!args["repo-root"]) return { error: "--repo-root is required" };
  if (!args["github-repo"]) return { error: "--github-repo is required" };
  if (!args["artifact-dir"]) return { error: "--artifact-dir is required" };
  if (!args["implementation-agent"]) return { error: "--implementation-agent is required" };
  if (!args["review-agent"]) return { error: "--review-agent is required" };

  const implementationAgent = args["implementation-agent"] as AgentId;
  if (!VALID_AGENTS.includes(implementationAgent)) {
    return { error: `--implementation-agent must be one of: ${VALID_AGENTS.join(", ")}, got: ${args["implementation-agent"]}` };
  }

  const reviewAgent = args["review-agent"] as AgentId;
  if (!VALID_AGENTS.includes(reviewAgent)) {
    return { error: `--review-agent must be one of: ${VALID_AGENTS.join(", ")}, got: ${args["review-agent"]}` };
  }

  let researchAgent: AgentId | undefined;
  if (args["research-agent"] !== undefined) {
    const id = args["research-agent"] as AgentId;
    if (!VALID_AGENTS.includes(id)) {
      return { error: `--research-agent must be one of: ${VALID_AGENTS.join(", ")}, got: ${args["research-agent"]}` };
    }
    researchAgent = id;
  }

  let verification: Record<string, string> = {};
  if (args["verification-json"] !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(args["verification-json"]);
    } catch {
      return { error: "--verification-json must be valid JSON" };
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { error: "--verification-json must be a JSON object" };
    }
    const entries = parsed as Record<string, unknown>;
    for (const [key, value] of Object.entries(entries)) {
      if (typeof value !== "string") {
        return { error: `--verification-json values must be strings, got non-string at key: ${key}` };
      }
    }
    verification = entries as Record<string, string>;
  }

  const repoRoot = args["repo-root"] as string;
  if (!isAbsolute(repoRoot)) {
    return { error: "--repo-root must be an absolute path" };
  }

  const artifactDir = args["artifact-dir"] as string;
  if (isAbsolute(artifactDir)) {
    return { error: "--artifact-dir must be a relative path (relative to repo-root)" };
  }

  const githubRepo = args["github-repo"] as string;
  if (!/^[^/]+\/[^/]+$/.test(githubRepo)) {
    return { error: "--github-repo must use owner/name format" };
  }

  let preset: EcosystemPreset | undefined;
  if (args["preset"] !== undefined) {
    preset = findPreset(args["preset"]);
    if (!preset) {
      return { error: `Unknown preset: ${args["preset"]}. Available presets: ${PRESET_NAMES.join(", ")}` };
    }
  }

  return {
    sessionsPath: args["sessions-path"] ?? DEFAULT_SESSIONS_PATH,
    sessionId: args["session-id"],
    repoKey: args["repo-key"],
    repoRoot,
    githubRepo,
    artifactDir,
    implementationAgent,
    reviewAgent,
    researchAgent,
    verification,
    labelsActive: args["labels-active"] ?? "ai:active",
    labelsBlocked: args["labels-blocked"] ?? "ai:blocked",
    labelsReadyForHuman: args["labels-ready-for-human"] ?? "ai:ready-for-human",
    preset,
  };
}

function runSessionInit(argv: string[]): void {
  const parsed = parseSessionInitArgs(argv);
  if ("error" in parsed) die(parsed.error);

  const {
    sessionsPath,
    sessionId,
    repoKey,
    repoRoot,
    githubRepo,
    artifactDir,
    implementationAgent,
    reviewAgent,
    researchAgent,
    verification,
    labelsActive,
    labelsBlocked,
    labelsReadyForHuman,
    preset,
  } = parsed;

  let file: SessionsFileShape = { sessions: [] };
  if (existsSync(sessionsPath)) {
    const raw = JSON.parse(readFileSync(sessionsPath, "utf8")) as { sessions?: unknown };
    if (!Array.isArray(raw.sessions)) {
      die(`sessions.json at ${sessionsPath} does not contain a sessions array`);
    }
    file = raw as SessionsFileShape;
  }

  const duplicate = file.sessions.find((s) => s.sessionId === sessionId);
  if (duplicate) {
    die(`Session with id "${sessionId}" already exists in ${sessionsPath}`);
  }

  const duplicateRepo = file.sessions.find((s) => s.repoKey === repoKey);
  if (duplicateRepo) {
    die(`Session with repoKey "${repoKey}" already exists in ${sessionsPath} (sessionId: "${duplicateRepo.sessionId}")`);
  }

  const defaults: Record<string, string> = { implementationAgent, reviewAgent };
  if (researchAgent !== undefined) defaults["researchAgent"] = researchAgent;

  // When a preset is given, its verificationSuggestions are the base; any
  // explicit --verification-json entries override preset suggestions.
  const effectiveVerification = preset
    ? { ...preset.verificationSuggestions, ...verification }
    : verification;

  // environmentPrepare is populated from the preset when one is provided.
  const environmentPrepare = preset
    ? { enabled: true, command: preset.environmentPrepare.command, cacheKeyFiles: preset.environmentPrepare.cacheKeyFiles }
    : undefined;

  const newSession: Record<string, unknown> = {
    sessionId,
    repoKey,
    repoRoot,
    githubRepo,
    artifactDir,
    defaults,
    verification: effectiveVerification,
    labels: {
      active: labelsActive,
      blocked: labelsBlocked,
      readyForHuman: labelsReadyForHuman,
    },
  };
  if (environmentPrepare !== undefined) {
    newSession["environmentPrepare"] = environmentPrepare;
  }

  file.sessions.push(newSession as RawSessionEntry);

  mkdirSync(dirname(sessionsPath), { recursive: true });
  writeFileSync(sessionsPath, JSON.stringify(file, null, 2) + "\n", "utf8");

  emit({ ok: true, sessionsPath, session: newSession });
}

// ---------------------------------------------------------------------------
// Subcommand: human-review-return
//
// Operator fallback (Path A in docs/human-review-return-flow.md) for returning a
// human-reviewed PR to implementation fix mode when GitHub App automation is not
// available. Populates task.context.reviewFeedback — the field the implementation
// fix handler requires — from an explicit operator-chosen source, requeues the
// task to queued/implementation in fix mode, and swaps GitHub labels to the fix
// lane via the outbox (reusing the same label logic as the automatic review→fix
// requeue). GitHub comment/review text is untrusted: feedback is bounded and
// sanitized (local/artifact paths redacted) before it is stored or surfaced, and
// is never echoed verbatim into a public comment.
// ---------------------------------------------------------------------------

// Bounded storage size for operator-forwarded feedback. Mirrors the recommended
// maximum in docs/human-review-return-flow.md (4 000 chars; hard ceiling 8 000).
const MAX_HUMAN_REVIEW_FEEDBACK_CHARS = 4_000;

const HUMAN_REVIEW_FEEDBACK_SOURCES = ["issue-comment"] as const;
type HumanReviewFeedbackSourceFlag = (typeof HUMAN_REVIEW_FEEDBACK_SOURCES)[number];

interface HumanReviewReturnArgs {
  sessionId: string;
  issueNumber: number;
  feedback: string | undefined;
  feedbackFile: string | undefined;
  feedbackSource: HumanReviewFeedbackSourceFlag | undefined;
  sessionsPath: string;
  dbPath: string | undefined;
  dryRun: boolean;
}

function parseHumanReviewReturnArgs(argv: string[]): HumanReviewReturnArgs | { error: string } {
  const tokenized = tokenizeArgs(argv, {
    booleanFlags: ["dry-run"],
    valueFlags: [
      "session-id",
      "issue-number",
      "feedback",
      "feedback-file",
      "feedback-source",
      "sessions-path",
      "db-path",
    ],
  });
  if ("error" in tokenized) return { error: tokenized.error };
  const { args, flags } = tokenized;
  const dryRun = flags.has("dry-run");

  if (!args["session-id"]) return { error: "--session-id is required" };
  if (args["issue-number"] === undefined) return { error: "--issue-number is required" };

  const n = Number(args["issue-number"]);
  if (!Number.isInteger(n) || n <= 0) {
    return { error: `--issue-number must be a positive integer, got: ${args["issue-number"]}` };
  }

  // Require exactly one feedback source so the operator explicitly chooses which
  // untrusted text is forwarded (no ambiguous comment polling).
  const provided = [
    args["feedback"] !== undefined ? "--feedback" : undefined,
    args["feedback-file"] !== undefined ? "--feedback-file" : undefined,
    args["feedback-source"] !== undefined ? "--feedback-source" : undefined,
  ].filter((v): v is string => v !== undefined);
  if (provided.length === 0) {
    return {
      error:
        "A feedback source is required: provide exactly one of --feedback, --feedback-file, or --feedback-source issue-comment",
    };
  }
  if (provided.length > 1) {
    return { error: `Only one feedback source may be provided; got: ${provided.join(", ")}` };
  }

  let feedbackSource: HumanReviewFeedbackSourceFlag | undefined;
  if (args["feedback-source"] !== undefined) {
    if (!HUMAN_REVIEW_FEEDBACK_SOURCES.includes(args["feedback-source"] as HumanReviewFeedbackSourceFlag)) {
      return {
        error: `--feedback-source must be one of: ${HUMAN_REVIEW_FEEDBACK_SOURCES.join(", ")}, got: ${args["feedback-source"]}`,
      };
    }
    feedbackSource = args["feedback-source"] as HumanReviewFeedbackSourceFlag;
  }

  return {
    sessionId: args["session-id"],
    issueNumber: n,
    feedback: args["feedback"],
    feedbackFile: args["feedback-file"],
    feedbackSource,
    sessionsPath: args["sessions-path"] ?? DEFAULT_SESSIONS_PATH,
    dbPath: args["db-path"],
    dryRun,
  };
}

function boundHumanReviewFeedback(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_HUMAN_REVIEW_FEEDBACK_CHARS) return { text, truncated: false };
  return { text: text.slice(0, MAX_HUMAN_REVIEW_FEEDBACK_CHARS) + "\n\n…(truncated)", truncated: true };
}

/**
 * Wrap untrusted text in a fenced code block that the content cannot break out
 * of. GitHub renders a code fence as closed only by a backtick run at least as
 * long as the opening one, so we pick an opening fence one backtick longer than
 * the longest backtick run inside the content. This keeps the (already public
 * but still untrusted) review excerpt from closing the fence and rendering
 * arbitrary markdown / @mentions as the automation bot.
 */
function fenceUntrusted(text: string): string {
  let longestRun = 0;
  for (const match of text.matchAll(/`+/g)) {
    if (match[0].length > longestRun) longestRun = match[0].length;
  }
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${fence}\n${text}\n${fence}`;
}

// Marker substituted for neutralized prompt-injection content so the operator
// can still see that something was stripped from the stored feedback.
const INJECTION_REDACTION = "[redacted-injection]";

/**
 * Neutralize prompt-injection / role-impersonation vectors in untrusted GitHub
 * comment text before it is stored as `reviewFeedback` and later embedded
 * verbatim in the implementation fix agent's prompt (see buildPrompt in
 * src/handlers/implementation.ts). sanitizeBody only redacts filesystem paths;
 * this additionally strips the markers a malicious or copied comment could use
 * to impersonate the harness/system, override the fix instructions, or smuggle
 * its own prompt sections. Content is redacted (not dropped) so the change is
 * visible. Operator-typed text (--feedback / --feedback-file) is trusted and is
 * NOT passed through this.
 */
export function hardenUntrustedFeedback(text: string): string {
  return (
    text
      // LLM control / role-delimiter tokens: ChatML (<|im_start|>, <|im_end|>),
      // Llama-style ([INST]/[/INST], <<SYS>>/<</SYS>>) and any generic <|…|>.
      .replace(/<\|[^|>]*\|>/g, INJECTION_REDACTION)
      .replace(/\[\/?INST\]/gi, INJECTION_REDACTION)
      .replace(/<<\/?SYS>>/gi, INJECTION_REDACTION)
      // Role-impersonation line prefixes (e.g. "System:", "Assistant:",
      // "Developer:") that try to open a fake turn. Quote/list/emphasis prefixes
      // are tolerated before the role token.
      .replace(/^[ \t>*_-]*(system|assistant|developer)\b[ \t]*:/gim, `${INJECTION_REDACTION}:`)
      // Instruction-override directives ("ignore/disregard/forget the previous
      // instructions", etc.).
      .replace(
        /\b(ignore|disregard|forget|override)\b[^\n]*\b(previous|above|prior|earlier|all|the|these|those|system)\b[^\n]*\b(instructions?|prompts?|rules?|directions?|guidelines?|context|messages?)\b/gi,
        INJECTION_REDACTION,
      )
      // Demote markdown headings to plain text so injected text cannot forge a
      // new prompt section boundary (e.g. a fake "## Instructions" header).
      .replace(/^[ \t>]*#{1,6}[ \t]+/gm, "")
  );
}

/**
 * The single feedback trust-boundary shared by both human-review-return paths
 * (the operator `human-review-return` fallback and the GitHub App automatic
 * `github-app-review-return` path). Bounds the raw text, then sanitizes it
 * (redacts local/artifact paths via {@link sanitizeBody}), then hardens it
 * (neutralizes prompt-injection / role-impersonation markers via
 * {@link hardenUntrustedFeedback}), then RE-bounds — hardening can expand short
 * control tokens into the longer redaction marker and push a bounded input past
 * the cap. Keeping one implementation guarantees identical bounds + sanitization
 * for both paths, as docs/human-review-return-flow.md requires.
 */
export function sanitizeReviewFeedback(
  rawFeedback: string,
  paths: string[],
): { text: string; truncated: boolean } {
  const bounded = boundHumanReviewFeedback(rawFeedback.trim());
  let cleaned = sanitizeBody(bounded.text, paths);
  cleaned = hardenUntrustedFeedback(cleaned);
  const reBounded = boundHumanReviewFeedback(cleaned);
  return {
    text: reBounded.text.trim(),
    truncated: bounded.truncated || reBounded.truncated,
  };
}

/**
 * Live-validate a recorded (but `prUrl`-less) branch against the repo host before
 * a fix-mode requeue refuses it for "no open PR" (issue #674 review, P1).
 *
 * A ready_for_human task may record only `context.branch` — a supported state
 * for a branch-selected or non-conventional PR handoff (see review.ts's
 * branch-only worktree path, and {@link resolveFixPr}'s non-conventional
 * fallback) — whose branch can still carry a genuinely open PR even though no
 * `prUrl` was captured. Treating the missing `prUrl` alone as proof no PR exists
 * would wrongly refuse those valid tasks, so ask the repo host directly.
 *
 * `getPullRequest(selector)` is NOT a safe way to look up a PR by branch name
 * across backends (issue #674 review, P1 follow-up): `gh pr view <branch>`
 * accepts a branch, but Gitea's provider builds `/pulls/${selector}` — a PR
 * INDEX endpoint — so handing it a branch name 404s and a genuinely open
 * branch-only PR is misreported as absent. The conventional `ai/issue-<n>`
 * branch is resolved instead through `findPullRequestForWorkItem`, which both
 * providers already implement in a branch-aware, backend-neutral way (`gh pr
 * list --head` / Gitea's paginated `head.ref` scan). A non-conventional branch
 * has no such backend-neutral lookup: only `gh pr view <branch>` supports it, so
 * that path is restricted to `gh`-backed sessions and fails closed on Gitea.
 */
async function resolveOpenPrForFixModeRecovery(
  session: ResolvedSession,
  issueNumber: number,
  branch: string,
): Promise<{ ok: true; prUrl: string } | { ok: false; error: string }> {
  let sessionRepoHost: SessionRepoHost;
  try {
    sessionRepoHost = await resolveSessionRepoHost(session.repoHostProvider, {
      githubRepo: session.githubRepo,
      cwd: session.repoRoot,
      ghRunnerFallback: defaultGhRunner,
    });
  } catch (err) {
    return {
      ok: false,
      error:
        `failed to resolve the repo-host provider to confirm whether branch '${branch}' has an open PR: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (branch === branchName(issueNumber)) {
    const result = sessionRepoHost.provider.findPullRequestForWorkItem(issueNumber);
    if (result.kind === "failed") {
      return {
        ok: false,
        error: `could not confirm whether branch '${branch}' has an open PR (lookup failed: ${result.error})`,
      };
    }
    if (result.kind === "none") {
      return { ok: false, error: `branch '${branch}' has no open PR` };
    }
    return { ok: true, prUrl: result.pullRequest.url };
  }

  // Non-conventional (or stale) recorded branch. `resolveFixPr` checks the
  // conventional `ai/issue-<n>` PR FIRST regardless of what branch is recorded
  // (see pr-helpers.ts), so a recorded branch that no longer matches reality must
  // not short-circuit straight to the branch-based lookup below: try the
  // conventional, backend-neutral lookup first (issue #674 review follow-up).
  // A "failed" conventional lookup (as opposed to a clean "none") does NOT fail
  // closed here: it only means the backend-neutral list query errored, not that
  // no PR exists, and the branch-specific lookup below is still a valid way to
  // confirm one — falling through preserves that fallback instead of masking it
  // behind an unrelated conventional-lookup error.
  const conventionalResult = sessionRepoHost.provider.findPullRequestForWorkItem(issueNumber);
  if (conventionalResult.kind === "found") {
    return { ok: true, prUrl: conventionalResult.pullRequest.url };
  }

  // No conventional PR either: only a `gh`-backed session can resolve the
  // non-conventional branch itself (`gh pr view <branch>`); Gitea has no
  // branch-based lookup for a branch outside the head-branch convention, so fail
  // closed rather than silently skip the check.
  if (!sessionRepoHost.ghRunner) {
    return {
      ok: false,
      error:
        `cannot confirm whether non-conventional branch '${branch}' has an open PR on this repo host ` +
        `(no branch-based PR lookup available outside the '${branchName(issueNumber)}' convention)`,
    };
  }
  const read = sessionRepoHost.provider.getPullRequest(branch);
  if (!read.ok) {
    return {
      ok: false,
      error: `could not confirm whether branch '${branch}' has an open PR (lookup failed: ${read.error})`,
    };
  }
  if (read.value.state !== undefined && read.value.state.toLowerCase() !== "open") {
    return {
      ok: false,
      error: `branch '${branch}' has a ${read.value.state.toLowerCase()} PR, not an open one`,
    };
  }
  return { ok: true, prUrl: read.value.url };
}

/**
 * Operator-facing suffix for a task-and-effect write a held maintenance lock
 * refused (issue #818 review follow-up). Those writes are all-or-nothing, so
 * the message's job is to say that nothing changed and the command is simply
 * repeatable — not to describe a task state that never happened.
 */
function maintenanceRefusalHint(code: string): string {
  return code === "maintenance_locked"
    ? ". A maintenance lock is held on this database (see `admin maintenance-lock status`); " +
        "nothing was changed — re-run once it is released."
    : "";
}

/**
 * Requeue a task to `queued` / `implementation` in fix mode with the given
 * (already sanitized) review feedback, and swap GitHub labels to the fix lane via
 * the outbox. Shared by the operator and GitHub App human-review-return paths so
 * the context contract and label routing stay identical.
 *
 * Preserves the existing PR/branch context (falling back to the conventional
 * `ai/issue-<n>` branch) so the fix run updates the same PR, and clears stale
 * review-loop cap state so an intentional return starts the review loop fresh.
 * The `reviewFeedbackSource` / `reviewFeedbackMeta` shape is supplied by the
 * caller. Expects the task's current status so a concurrent claim is detected.
 *
 * The transition and its label effects are committed together (issue #818
 * review follow-up), so a held maintenance lock comes back as
 * `code: "maintenance_locked"` with nothing applied — never a task moved into
 * the fix lane whose lane labels were refused a moment later.
 */
async function enqueueFixModeRequeue(args: {
  store: SqliteTaskStore;
  outboxStore: SqliteOutboxStore;
  session: ResolvedSession;
  task: AiTask;
  reviewFeedback: string;
  reviewFeedbackSource: string;
  reviewFeedbackMeta: Record<string, unknown>;
  now: string;
  runId: string;
  // "preserveMissingOnly": used by the review-verification-resolve failure path
  // (issue #622): a single failed command among several still-missing ones is a
  // partial result, not a fresh review cycle, so the other commands' outstanding
  // `missingVerificationCommands` must survive the fix-mode round trip. Passing
  // `manualVerificationEvidence` is still cleared even in this mode: the fix that
  // follows can change code covered by an earlier passing command, so stale exit-0
  // evidence must not be trusted without rerunning it (issue #622 review, P1).
  // Default ("clear") wipes both, matching the pre-#622 behavior for every other
  // caller of this helper.
  verificationStateOnFix?: "clear" | "preserveMissingOnly";
  // Optimistic-concurrency guard: when set, the requeue only commits if the task's
  // `revision` still matches this value, so a write built from a stale context
  // snapshot (e.g. two operators resolving different missing commands at once)
  // fails closed instead of clobbering a concurrent update. A monotonic counter is
  // used rather than `updatedAt` because two writers whose clocks land in the same
  // millisecond can read (and even write) an identical timestamp, letting a stale
  // timestamp-only CAS check pass (issue #622 review, P2).
  expectedRevision?: number;
  // Public status comment announcing this requeue, committed in the SAME
  // transaction as the transition and the lane labels (issue #818 review
  // follow-up). Callers that post such a comment MUST pass it here rather than
  // enqueueing it after this helper returns: once the task has left its
  // human-handoff status, a maintenance lock (or any other failure) met on a
  // separate enqueue can no longer be repaired by re-running the command, since
  // the task is no longer in the state that command accepts. `keySuffix`
  // distinguishes the comment from the caller's other effects for this runId.
  statusComment?: { body: string; keySuffix: string };
}): Promise<
  | { ok: true; task: AiTask; prUrl?: string; branch: string }
  | { ok: false; code: string; current?: AiTask }
> {
  const { store, outboxStore, session, task, now, runId } = args;
  const sessionId = session.sessionId;
  const issueNumber = task.issueNumber;

  // Refuse the whole requeue up front while a maintenance lock is held (issue
  // #818 review follow-up), BEFORE the live PR lookup and the transition below.
  // This helper is a compound task-and-effect operation: without this check it
  // would transition the task into the fix lane and only then meet the held
  // lock on its outbox enqueue, aborting with the task already moved but its
  // lane labels never queued. The commit below is additionally atomic against a
  // lock acquired after this read (`transitionTaskWithEffects` re-checks inside
  // its own transaction); this early read is what keeps the operator's command
  // a clean, repeatable no-op rather than a mid-sequence abort.
  if (await outboxStore.isMaintenanceLocked()) {
    return { ok: false, code: "maintenance_locked" };
  }

  const { prUrl, branch } = resolvePrContext(task);
  const resolvedBranch = branch ?? branchName(issueNumber);

  // issue #674: defense in depth alongside the caller-level checks in
  // runHumanReviewReturn/runGithubAppReviewReturn — fix mode requires an existing
  // open PR, and this helper is the single place both paths requeue through. A
  // missing `prUrl` alone is not proof no PR exists (issue #674 review, P1): a
  // task recording only `context.branch` may still have a genuinely open PR, so
  // live-validate that branch via resolveOpenPrForFixModeRecovery before
  // refusing. A task with NEITHER `prUrl` NOR `branch` recorded is not proof
  // either (issue #674 review, P1 follow-up): a legacy task or an externally
  // created PR can still have a genuinely open conventional `ai/issue-<n>` PR, so
  // always live-check `resolvedBranch` (which falls back to the conventional
  // branch name) rather than short-circuiting on missing context.
  let effectivePrUrl = prUrl;
  if (effectivePrUrl === undefined) {
    const liveCheck = await resolveOpenPrForFixModeRecovery(session, issueNumber, resolvedBranch);
    if (!liveCheck.ok) {
      return { ok: false, code: "no_open_pr" };
    }
    effectivePrUrl = liveCheck.prUrl;
  }

  const newContext: Record<string, unknown> = {
    reviewFeedback: args.reviewFeedback,
    reviewFeedbackSource: args.reviewFeedbackSource,
    reviewFeedbackRecordedAt: now,
    reviewFeedbackMeta: args.reviewFeedbackMeta,
    implementationMode: "fix",
    branch: resolvedBranch,
    prUrl: effectivePrUrl,
    // Clear stale review-loop cap state so an intentional return starts the
    // review loop fresh. Without this, the merge-patch preserves a prior
    // reviewLoopCapReached / escalatedEffort handoff and a non-zero reviewCycles,
    // which would make a subsequent review look like a cap handoff or escalate
    // immediately. Keys set to undefined are dropped when JSON-serialized.
    reviewLoopCapReached: undefined,
    escalatedEffort: undefined,
    reviewCycles: 0,
    // Passing evidence never survives a fix-mode transition: the fix that
    // follows can change code covered by an earlier passing command, so a
    // stale exit-0 result must not be trusted without rerunning it (issue
    // #622 review, P1).
    manualVerificationEvidence: undefined,
    ...(args.verificationStateOnFix === "preserveMissingOnly" ? {} : { missingVerificationCommands: undefined }),
  };

  const patch: TaskPatch = {
    status: "queued",
    phase: "implementation",
    ownerRunId: undefined,
    leaseExpiresAt: undefined,
    lastError: undefined,
    context: newContext,
    now,
  };

  // Collect the label effects instead of writing them through the live outbox
  // store, then commit them in the SAME transaction as the transition (issue
  // #818 review follow-up), exactly as a phase completion does (issue #701) and
  // as `admin task cancel` already does for its cancellation comment. The task
  // moving into the fix lane and the labels announcing that move are one
  // operator action; a maintenance lock (or any other failure) must take both
  // or neither, never leave the human-handoff lane half-applied.
  //
  // The builders read the POST-transition task, so they run against the same
  // `applyTaskPatch` preview `transitionTaskWithEffects` is about to persist —
  // the identical shape phase-runner uses for the same reason.
  const preview = applyTaskPatch(task, patch);
  const effects = new OutboxEffectCollector();

  // Swap GitHub labels to the fix lane via the shared outbox logic: add
  // status:needs-fix + the implementation agent label and remove the
  // ready-for-human + review-lane labels. Modeled as a review→needs_fix requeue
  // so the ready-for-human / review-lane cleanup path is reached.
  await enqueueStatusLabelEffects(
    effects,
    session,
    preview,
    "queued",
    "implementation",
    runId,
    now,
    "review",
    { result: "needs_fix", context: { reviewFeedback: args.reviewFeedback, prUrl: effectivePrUrl, branch: resolvedBranch } },
  );

  // The shared helper only removes the review-lane labels when the optional
  // needsReview / agentReview session keys are configured. Sessions relying on
  // the default review labels would otherwise stay tagged in both the review and
  // the fix lane. Explicitly remove them too, falling back to the same defaults
  // intake uses. Idempotent with the helper's own removals (same runId + label).
  // Route through the work-item provider so a non-GitHub session's label removals
  // reach the work-item repo instead of stranding behind the dispatcher's failing
  // GitHub runner; no-op passthrough for a GitHub session.
  const workItemStore = workItemOutbox(effects, session);
  for (const label of [
    (session.labels["needsReview"] as string | undefined) ?? "status:needs-review",
    (session.labels["agentReview"] as string | undefined) ?? "agent:codex",
  ]) {
    await workItemStore.enqueue({
      idempotencyKey: makeOutboxKey(sessionId, issueNumber, runId, "gh:label:remove", label),
      topic: "gh:label:remove",
      payload: {
        topic: "gh:label:remove",
        owner: session.githubOwner,
        repo: session.githubName,
        issueNumber,
        label,
      },
      now,
    });
  }

  // The caller's public status comment joins the same effect set (issue #818
  // review follow-up). Enqueued separately after the transaction, it would be
  // the one part of the operator action that a lock acquired mid-sequence can
  // still strand: the task has already left `ready_for_human`, so re-running the
  // command is refused and the announcement can never be posted.
  if (args.statusComment) {
    await workItemStore.enqueue({
      idempotencyKey: makeOutboxKey(sessionId, issueNumber, runId, "gh:comment", args.statusComment.keySuffix),
      topic: "gh:comment",
      payload: {
        topic: "gh:comment",
        owner: session.githubOwner,
        repo: session.githubName,
        issueNumber,
        body: args.statusComment.body,
      },
      now,
    });
  }

  // One transaction: the fix-lane transition plus every label effect above, or
  // nothing at all. A held maintenance lock (checked again inside that
  // transaction) comes back as `maintenance_locked` with the task untouched.
  const result = await store.transitionTaskWithEffects(
    { sessionId, issueNumber },
    {
      status: task.status,
      ...(args.expectedRevision !== undefined ? { revision: args.expectedRevision } : {}),
    },
    patch,
    effects.effects,
  );
  if (!result.ok) {
    return { ok: false, code: result.code, current: result.current };
  }

  return { ok: true, task: result.value, prUrl: effectivePrUrl, branch: resolvedBranch };
}

export async function runHumanReviewReturn(
  argv: string[],
  reader: IssueDiscussReader = defaultIssueDiscussReader,
): Promise<void> {
  const parsed = parseHumanReviewReturnArgs(argv);
  if ("error" in parsed) die(parsed.error);

  const { sessionId, issueNumber, feedback, feedbackFile, feedbackSource, sessionsPath, dbPath, dryRun } = parsed;

  let registry: JsonSessionRegistry;
  try {
    registry = new JsonSessionRegistry(sessionsPath);
  } catch (err) {
    die(`Failed to load sessions file (${sessionsPath}): ${err instanceof Error ? err.message : String(err)}`);
  }

  const session = await registry.getSessionById(sessionId);
  if (!session) {
    die(describeUnresolvedSessionId(registry, sessionId, sessionsPath));
  }

  // Resolve the raw feedback text + machine-readable source token from exactly
  // one operator-chosen channel.
  let rawFeedback: string;
  let reviewFeedbackSource: "human_comment" | "operator_input";
  const sourceMeta: Record<string, unknown> = {};

  if (feedbackSource === "issue-comment") {
    reviewFeedbackSource = "human_comment";
    let issue: { comments: { author: string; body: string; createdAt: string }[] };
    try {
      issue = reader.readIssue(session.githubRepo, issueNumber, 50);
    } catch (err) {
      die(
        `Failed to read issue ${session.githubRepo}#${issueNumber}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    // Most recent comment NOT authored by a bot. GitHub App / bot logins carry
    // the "[bot]" suffix; skipping them keeps the forwarded text a human's
    // request rather than this system's own prior automation comments.
    const humanComments = issue.comments.filter(
      (c) => c.author && !c.author.endsWith("[bot]") && c.body.trim().length > 0,
    );
    const latest = humanComments[humanComments.length - 1];
    if (!latest) {
      die(
        `No human issue comment found on ${session.githubRepo}#${issueNumber} to use as review feedback. ` +
          `Post the requested changes as an issue comment, or pass --feedback / --feedback-file.`,
      );
    }
    rawFeedback = latest.body;
    sourceMeta["channel"] = "issue-comment";
    sourceMeta["author"] = latest.author;
    if (latest.createdAt) sourceMeta["commentCreatedAt"] = latest.createdAt;
  } else if (feedbackFile !== undefined) {
    reviewFeedbackSource = "operator_input";
    try {
      rawFeedback = readFileSync(feedbackFile, "utf8");
    } catch (err) {
      die(`Failed to read --feedback-file: ${err instanceof Error ? err.message : String(err)}`);
    }
    sourceMeta["channel"] = "operator-file";
  } else {
    reviewFeedbackSource = "operator_input";
    rawFeedback = feedback ?? "";
    sourceMeta["channel"] = "operator-flag";
  }

  // Missing/empty feedback must fail clearly and must NOT requeue.
  if (rawFeedback.trim().length === 0) {
    die("Resolved feedback is empty. Fix mode requires non-empty review feedback; nothing was requeued.");
  }

  // Bound + sanitize + harden the untrusted GitHub text via the shared trust
  // boundary (identical bounds/sanitization to the GitHub App path). The resolved
  // feedback is later embedded verbatim in the fix agent's prompt (see buildPrompt
  // in src/handlers/implementation.ts); hardening neutralizes prompt-injection /
  // role-impersonation markers and applies to operator-supplied feedback too,
  // since operators routinely paste a human reviewer's requested changes which
  // carry the same untrusted markers. Hardening only redacts control markers, so
  // legitimate feedback is unaffected.
  const { text: sanitizedFeedback, truncated: feedbackTruncated } = sanitizeReviewFeedback(
    rawFeedback,
    [session.repoRoot, session.artifactRoot],
  );
  if (sanitizedFeedback.length === 0) {
    die("Resolved feedback is empty after sanitization; nothing was requeued.");
  }

  const now = new Date().toISOString();

  const store = new SqliteTaskStore(dbPath);
  const outboxStore = new SqliteOutboxStore(dbPath);
  try {
    const task = await store.getTask({ sessionId, issueNumber });
    if (!task) {
      die(`Task not found: session "${sessionId}", issue #${issueNumber}`);
    }

    if (task.status === "claimed" || task.status === "running") {
      die(
        `Task #${issueNumber} in session "${sessionId}" is currently ${task.status}` +
          (task.ownerRunId ? ` (owner: ${task.ownerRunId})` : "") +
          `. Refusing to return an active task to fix mode. Wait for it to complete or recover it first.`,
      );
    }

    // Preview the target the same way the requeue helper resolves it.
    const { prUrl, branch } = resolvePrContext(task);
    const resolvedBranch = branch ?? branchName(issueNumber);

    // issue #674: fix mode requires an existing open PR — the implementation
    // handler's fix path looks one up and fails hard ("No open PR found for issue
    // #N ... Cannot apply fix — create a PR first") when none exists. No `prUrl`
    // recorded on the task means the issue never reached PR creation (a Tool
    // Request raised during INITIAL implementation leaves the task ready_for_human
    // with no prUrl in context). Requeueing into fix mode here would create a task
    // guaranteed to fail on the next worker run instead of failing fast now, at the
    // operator command, with an actionable alternative. A missing `prUrl` alone is
    // not proof no PR exists (issue #674 review, P1): a recorded `branch` (a
    // supported branch-selected / non-conventional PR state) may still carry a
    // genuinely open PR, so live-validate it before refusing. Neither `prUrl` nor
    // `branch` recorded is not proof either (issue #674 review, P1 follow-up): a
    // legacy task or an externally created conventional `ai/issue-<n>` PR can
    // still be open, so always live-check `resolvedBranch` (which falls back to
    // the conventional branch name) instead of refusing on missing context alone.
    let effectivePrUrl = prUrl;
    if (effectivePrUrl === undefined) {
      const liveCheck = await resolveOpenPrForFixModeRecovery(session, issueNumber, resolvedBranch);
      if (!liveCheck.ok) {
        die(
          `Refusing to return issue #${issueNumber} in session "${sessionId}" to implementation fix mode: ` +
            `${liveCheck.error}. Fix mode requires an existing open PR to edit. If the branch truly has no open ` +
            `PR yet, resume the pre-PR implementation instead: 'admin tool-request resolve --action manual-done ` +
            `--session-id ${sessionId} --issue-number ${issueNumber}' (this is allowed even if the Tool Request ` +
            `was already rejected) preserves the pushed issue branch '${resolvedBranch}' and requeues the task so ` +
            `the run reaches normal PR creation.`,
        );
      }
      effectivePrUrl = liveCheck.prUrl;
    }

    if (dryRun) {
      emit({
        ok: true,
        dryRun: true,
        sessionId,
        issueNumber,
        previousStatus: task.status,
        previousPhase: task.phase,
        wouldRequeue: { status: "queued", phase: "implementation" },
        reviewFeedbackSource,
        feedbackChars: sanitizedFeedback.length,
        feedbackTruncated,
        prUrl: effectivePrUrl ?? null,
        branch: resolvedBranch,
      });
      return;
    }

    const runId = `admin-human-review-return-${now}`;

    // Record the live-discovered PR url when the task did not already carry one
    // (issue #674 review, P1), so the fix run keeps the PR association without
    // re-querying the repo host.
    const taskForRequeue: AiTask =
      prUrl === undefined && effectivePrUrl !== undefined
        ? { ...task, context: { ...task.context, prUrl: effectivePrUrl } }
        : task;

    // Public status comment: announce the operator action with metadata only.
    // The feedback text is forwarded to the fix agent privately via task context
    // and is NOT echoed back to GitHub unless it originated from a comment that is
    // already public on this issue. Operator-provided feedback (--feedback /
    // --feedback-file) may carry credentials or private context that sanitizeBody
    // (paths only) would not redact, so the public comment stays metadata-only for
    // that source.
    //
    // Built BEFORE the requeue and handed to it (issue #818 review follow-up) so
    // it is committed in the same transaction as the transition and the lane
    // labels. Enqueued afterwards it could be refused on its own — by a
    // maintenance lock taken in between, say — after the task had already left
    // `ready_for_human`, and no re-run could then restore it.
    let commentBody =
      `🔧 **Returned to implementation fix mode by operator.**\n\n` +
      `Feedback source: ${reviewFeedbackSource === "human_comment" ? "latest human issue comment" : "operator input"}.`;
    if (reviewFeedbackSource === "human_comment") {
      const excerpt = boundedExcerpt(sanitizedFeedback, 1500);
      commentBody +=
        `\n\n<details>\n<summary>Review feedback excerpt (sanitized)</summary>\n\n${fenceUntrusted(excerpt)}\n</details>`;
    }
    commentBody = sanitizeBody(commentBody, sessionRedactionPaths(session));

    // Requeue to queued/implementation in fix mode and swap labels to the fix lane
    // via the shared helper (same context contract + label routing as the GitHub
    // App path). Expecting the current status detects a concurrent claim.
    const requeue = await enqueueFixModeRequeue({
      store,
      outboxStore,
      session,
      task: taskForRequeue,
      reviewFeedback: sanitizedFeedback,
      reviewFeedbackSource,
      reviewFeedbackMeta: {
        source: reviewFeedbackSource,
        recordedAt: now,
        feedbackChars: sanitizedFeedback.length,
        truncated: feedbackTruncated,
        ...sourceMeta,
      },
      now,
      runId,
      statusComment: { body: commentBody, keySuffix: "human-review-return" },
    });
    if (!requeue.ok) {
      die(
        `Failed to requeue task: ${requeue.code}` +
          (requeue.current ? ` (current status: ${requeue.current.status})` : "") +
          maintenanceRefusalHint(requeue.code),
      );
    }
    const result = { value: requeue.task };

    // Audit event — describes the operator action without leaking local paths or
    // the full raw feedback artifact.
    await store.appendEvent({
      task: { sessionId, issueNumber },
      type: "human_review_return",
      runId,
      message: `Operator returned issue #${issueNumber} to implementation fix mode (source: ${reviewFeedbackSource})`,
      data: {
        reviewFeedbackSource,
        feedbackChars: sanitizedFeedback.length,
        truncated: feedbackTruncated,
        previousStatus: task.status,
        previousPhase: task.phase,
        hasPrUrl: effectivePrUrl !== undefined,
        branch: resolvedBranch,
        ...sourceMeta,
      },
      createdAt: now,
    });

    emit({
      ok: true,
      sessionId,
      issueNumber,
      status: result.value.status,
      phase: result.value.phase,
      previousStatus: task.status,
      previousPhase: task.phase,
      reviewFeedbackSource,
      feedbackChars: sanitizedFeedback.length,
      feedbackTruncated,
      // issue #674 review: for a branch-only task (no prUrl recorded), `prUrl`
      // above is undefined even though enqueueFixModeRequeue live-discovered and
      // persisted a real PR url as `requeue.prUrl`. Report that discovered url,
      // not the pre-requeue local variable, so the output doesn't falsely claim
      // no PR exists.
      prUrl: requeue.prUrl ?? null,
      branch: resolvedBranch,
    });
  } finally {
    store.close();
    outboxStore.close();
  }
}

// ---------------------------------------------------------------------------
// Subcommand: review-verification resolve
//
// Operator path for resolving a review escalation caused by a missing
// verification command (see issue #593). The review phase escalates to human
// when an issue-required verification command was not run by the automated
// runner. This command lets the operator supply the result of running it
// manually:
//
//   - Exit 0 (success): stores passing evidence in task context as
//     `manualVerificationEvidence` and removes the resolved command from
//     `missingVerificationCommands`. If other required commands are still
//     missing, the task stays `ready_for_human`/`review` — the handoff is not
//     resolved yet, so no requeue and no new public comment (issue #622: one
//     handoff per escalation, not one per command). Only when the last
//     required command succeeds does this requeue to review and post a single
//     public comment. The next review run reads the evidence and treats every
//     recorded command as "passed", so the same missing-command escalation
//     does not repeat. Since issue #1040 the stored entry is BOUND to the
//     plan revision/digest, the §5.1 slot identity, and the reviewed branch
//     HEAD the escalating review recorded (or, only for a legacy escalation
//     that recorded none, an explicit --head-sha): a later review admits it
//     only while those identities still hold, so a plan correction or a new
//     commit makes the evidence inadmissible (fail closed) instead of
//     producing a stale pass.
//
//   - Exit non-zero (failure): routes directly to implementation fix mode with
//     the failure output as feedback. Does not mark review as passed and does
//     not touch the missing-command state for other commands. Any already-
//     recorded passing `manualVerificationEvidence` is cleared on this
//     transition (issue #622 review, P1): the fix that follows can change code
//     covered by an earlier passing command, so its stale exit-0 result must
//     not be trusted without rerunning it once the fix lands.
//
// Command output is bounded (via boundVerificationOutput) and sanitized (local
// paths redacted) before storage. For failed evidence, the full feedback string
// is additionally hardened against prompt-injection via sanitizeReviewFeedback.
// ---------------------------------------------------------------------------

interface ReviewVerificationResolveArgs {
  sessionId: string;
  issueNumber: number;
  command: string;
  exitCode: number;
  output: string | undefined;
  outputFile: string | undefined;
  /** Issue #1040: operator-attested reviewed HEAD for a legacy escalation. */
  headSha: string | undefined;
  sessionsPath: string;
  dbPath: string | undefined;
  dryRun: boolean;
}

function parseReviewVerificationResolveArgs(argv: string[]): ReviewVerificationResolveArgs | { error: string } {
  const tokenized = tokenizeArgs(argv, {
    booleanFlags: ["dry-run"],
    valueFlags: [
      "session-id",
      "issue-number",
      "command",
      "exit-code",
      "output",
      "output-file",
      "head-sha",
      "sessions-path",
      "db-path",
    ],
  });
  if ("error" in tokenized) return { error: tokenized.error };
  const { args, flags } = tokenized;
  const dryRun = flags.has("dry-run");

  if (!args["session-id"]) return { error: "--session-id is required" };
  if (args["issue-number"] === undefined) return { error: "--issue-number is required" };
  if (!args["command"]) return { error: "--command is required" };
  if (args["exit-code"] === undefined) return { error: "--exit-code is required" };

  const n = Number(args["issue-number"]);
  if (!Number.isInteger(n) || n <= 0) {
    return { error: `--issue-number must be a positive integer, got: ${args["issue-number"]}` };
  }

  const ec = Number(args["exit-code"]);
  if (!Number.isInteger(ec) || ec < 0) {
    return { error: `--exit-code must be a non-negative integer, got: ${args["exit-code"]}` };
  }

  if (args["output"] !== undefined && args["output-file"] !== undefined) {
    return { error: "Only one of --output or --output-file may be provided" };
  }

  let headSha: string | undefined;
  if (args["head-sha"] !== undefined) {
    headSha = normalizeCommitSha(args["head-sha"]);
    if (headSha === undefined) {
      return { error: `--head-sha must be a full commit SHA (40 or 64 hex characters), got: ${args["head-sha"]}` };
    }
  }

  return {
    sessionId: args["session-id"],
    issueNumber: n,
    command: args["command"],
    exitCode: ec,
    output: args["output"],
    outputFile: args["output-file"],
    headSha,
    sessionsPath: args["sessions-path"] ?? DEFAULT_SESSIONS_PATH,
    dbPath: args["db-path"],
    dryRun,
  };
}

export async function runReviewVerificationResolve(argv: string[]): Promise<void> {
  const parsed = parseReviewVerificationResolveArgs(argv);
  if ("error" in parsed) die(parsed.error);

  const { sessionId, issueNumber, command, exitCode, output, outputFile, headSha, sessionsPath, dbPath, dryRun } = parsed;

  let registry: JsonSessionRegistry;
  try {
    registry = new JsonSessionRegistry(sessionsPath);
  } catch (err) {
    die(`Failed to load sessions file (${sessionsPath}): ${err instanceof Error ? err.message : String(err)}`);
  }

  const session = await registry.getSessionById(sessionId);
  if (!session) {
    die(describeUnresolvedSessionId(registry, sessionId, sessionsPath));
  }

  // Resolve the raw output text from exactly one source
  let rawOutput = "";
  if (outputFile !== undefined) {
    try {
      rawOutput = readFileSync(outputFile, "utf8");
    } catch (err) {
      die(`Failed to read --output-file: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else if (output !== undefined) {
    rawOutput = output;
  }

  // Bound + sanitize the output: it may contain local paths or large logs.
  // boundVerificationOutput keeps the tail (where test runners print failures).
  const boundedOutput = boundVerificationOutput(rawOutput);
  const sanitizedOutput = sanitizeBody(boundedOutput, sessionRedactionPaths(session));

  const now = new Date().toISOString();
  const runId = `admin-review-verification-resolve-${now}`;

  const store = new SqliteTaskStore(dbPath);
  const outboxStore = new SqliteOutboxStore(dbPath);
  try {
    const task = await store.getTask({ sessionId, issueNumber });
    if (!task) {
      die(`Task not found: session "${sessionId}", issue #${issueNumber}`);
    }

    if (task.status === "claimed" || task.status === "running") {
      die(
        `Task #${issueNumber} in session "${sessionId}" is currently ${task.status}` +
          (task.ownerRunId ? ` (owner: ${task.ownerRunId})` : "") +
          `. Refusing to modify an active task. Wait for it to complete or recover it first.`,
      );
    }

    const { prUrl, branch } = resolvePrContext(task);
    const resolvedBranch = branch ?? branchName(issueNumber);
    const ctx = task.context as Record<string, unknown>;

    if (task.status !== "ready_for_human" || task.phase !== "review") {
      die(
        `Task #${issueNumber} in session "${sessionId}" is not a ready_for_human review task ` +
          `(status: ${task.status}, phase: ${task.phase}). ` +
          `review-verification-resolve only applies to review handoffs.`,
      );
    }
    const missingCmds = Array.isArray(ctx.missingVerificationCommands)
      ? (ctx.missingVerificationCommands as unknown[]).filter((c): c is string => typeof c === "string")
      : [];
    if (!missingCmds.includes(command)) {
      die(
        `Command \`${command}\` is not listed as a missing verification command for task #${issueNumber}.` +
          (missingCmds.length > 0
            ? ` Missing commands: ${missingCmds.join(", ")}.`
            : " No missing commands are recorded for this task."),
      );
    }

    // Issue #1040: the block the escalation recorded, binding each displayed
    // command to the §5.1 slot identity the review actually gated on. Read here
    // rather than at its first use below because the §13.1 refusal needs the
    // same binding: it is the only place a displayed command's STABLE slot id
    // survives (issue #1044 review, P2).
    const bindingBlock = readVerificationEvidenceBindingBlock(ctx[VERIFICATION_EVIDENCE_BINDING_CONTEXT_KEY]);

    // §13.1 (issue #1044): the recorded missing list predates any amendment
    // applied since the escalation, so a command it still names may address a
    // slot the effective plan no longer carries — replaced, retired, or
    // orphaned by a session-key removal. Recording evidence against it would
    // attest a requirement that is gone, and for a replaced slot it would read
    // as a pass of bytes nobody ran. Refuse, naming the revision that moved it,
    // rather than storing orphan evidence. Only an AMENDED task can reach this
    // check: without a chain the effective requirement layer is exactly the
    // shipped extraction, and the behavior is unchanged.
    const amendmentChain = ctx[VERIFICATION_AMENDMENTS_CONTEXT_KEY];
    // Resolved once and kept: §13.1 below refuses on it, and the evidence
    // binding is re-verified against it before anything is recorded (issue
    // #1044 review, P2). Left `undefined` on an unamended task, where the
    // effective requirement layer is exactly the shipped extraction and the
    // escalation's block cannot have gone stale under an amendment.
    let amendedEffectivePlan: EffectiveVerificationPlan | undefined;
    if (amendmentChain !== undefined) {
      const amendedPlan = resolveEffectiveVerificationPlan({
        sessionVerification: session.verification,
        issueRequirements: typeof ctx.body === "string" ? extractIssueVerificationCommands(ctx.body) : [],
        amendments: amendmentChain,
      });
      if (amendedPlan.status === "invalid") {
        die(
          `Cannot resolve the effective verification plan for task #${issueNumber}: the task carries ` +
            `verification amendments that do not form a readable record ` +
            `(${amendedPlan.reason}: ${amendedPlan.detail}). Recording evidence would attest a plan nobody ` +
            `can resolve. Inspect the amendment record with \`admin task-verification show\` first.`,
        );
      }
      amendedEffectivePlan = amendedPlan.plan;
      const trimmedForPlan = command.trim();
      // Issue #1044 review (P2): decided under the requirement gate's OWN
      // admission rule rather than on raw bytes. `buildIssueVerificationStatus`
      // credits an evidence entry to a requirement when
      // `matchesConfiguredVerificationCommand` holds with the EVIDENCE bytes on
      // the left, so an escalation displaying `bash -lc 'npm test'` still
      // addresses a slot an amendment replaced with `npm test`: the next review
      // would admit that evidence, and refusing to record it would send the
      // operator to requeue a review that has nothing to fix.
      //
      // The direction is the gate's, deliberately not a symmetric widening: the
      // reverse pairing (bare bytes offered against a wrapped requirement) is
      // NOT admitted there, so accepting it here would store evidence the next
      // review rejects forever — the deadlock this refusal exists to avoid.
      //
      // Slot IDENTITY is not what this test decides; it is verified where the
      // evidence is actually stamped, below: the binding is re-resolved against
      // this same plan and must land on the escalation's `commandId`, and an
      // amended task whose escalation carries no usable binding block refuses
      // outright rather than deriving one.
      const stillRequired = amendedPlan.plan.requirement.some(
        (slot) => slot.state === "active" && matchesConfiguredVerificationCommand(trimmedForPlan, slot.command),
      );
      if (!stillRequired) {
        const stored = validateVerificationAmendmentState(amendmentChain);
        // The identity of the slot these bytes address is RECOVERED, never
        // re-derived from them (issue #1044 review, P2). A slot a `replace`
        // already moved keeps the `req:<hash>` identity derived from its
        // ORIGINAL bytes while the escalation displays — and the missing list
        // records — the replacement bytes. Hashing those again mints an
        // identity no revision ever names, so the reverse search below would
        // find nothing and the refusal would omit the very revision §13.1
        // requires it to name. Three sources, most authoritative first:
        //
        //  1. the escalation's own binding block, which recorded the identity
        //     the gating review resolved for exactly these displayed bytes;
        //  2. the effective slot the plan still carries under that identity,
        //     matched on either its current or its origin bytes (this is the
        //     replaced-then-retired case, where the slot survives);
        //  3. the chain's `replace` operations, which record the identity the
        //     bytes were installed under even when no slot survives at all
        //     (a session-key removal orphaned it, §6.4 rule 4).
        //
        // Deriving from the displayed bytes stays the last resort: for an
        // unreplaced slot it is the correct identity, and for anything else it
        // is only ever the id the message prints.
        const recordedBindingId =
          bindingBlock?.commandIds?.[trimmedForPlan] ?? bindingBlock?.commandIds?.[command];
        const boundSlot = amendedPlan.plan.requirement.find(
          (slot) =>
            slot.command.trim() === trimmedForPlan || slot.originCommand.trim() === trimmedForPlan,
        );
        let replacedIntoId: string | undefined;
        if (recordedBindingId === undefined && boundSlot === undefined && stored.valid && stored.state) {
          for (const revision of [...stored.state.revisions].reverse()) {
            for (const operation of [...revision.operations].reverse()) {
              if (operation.kind === "replace" && operation.command.trim() === trimmedForPlan) {
                replacedIntoId = operation.commandId;
                break;
              }
            }
            if (replacedIntoId !== undefined) break;
          }
        }
        const orphanedId =
          recordedBindingId
          ?? boundSlot?.commandId
          ?? replacedIntoId
          ?? deriveRequirementCommandId(trimmedForPlan);
        // Only an operation that actually MOVED the slot can name the revision
        // this refusal is about (issue #1044 review, P2): `replace` changed its
        // bytes and `retire` made it inactive, while `annotate` only recorded a
        // note against it and `restore` put it back. Accepting every operation
        // carrying the id would let a later annotation win the reverse search
        // and send the operator to an audit record that changed nothing — and an
        // orphan the search cannot explain at all (a session-key removal, §6.4
        // rule 4) is better reported without a revision than with the wrong one.
        const naming =
          stored.valid && stored.state
            ? [...stored.state.revisions]
                .reverse()
                .find((revision) =>
                  revision.operations.some(
                    (operation) =>
                      (operation.kind === "replace" || operation.kind === "retire") &&
                      operation.commandId === orphanedId,
                  ),
                )
            : undefined;
        die(
          `Command \`${command}\` is no longer an active requirement of task #${issueNumber}'s effective ` +
            `verification plan: a verification amendment replaced, retired, or orphaned its slot ` +
            `(${orphanedId})` +
            (naming !== undefined
              ? `, most recently revision ${naming.revisionOrdinal} (${naming.revisionId}): ` +
                // §11 rule 7: the operator's reason is free text and can name a
                // local path, so it is redacted like every other reported string.
                sanitizeBody(naming.reason, sessionRedactionPaths(session))
              : "") +
            `. Recording evidence for it would attest a requirement the plan does not carry. ` +
            `Inspect the plan with \`admin task-verification show\`, then resolve the command the ` +
            `amended plan actually requires (requeue the review to refresh the missing-command list).`,
        );
      }
    }

    if (exitCode !== 0) {
      // Failed verification → route to implementation fix mode with failure feedback.
      const rawFailureFeedback = `Manual verification of \`${command}\` failed (exit ${exitCode}):\n${sanitizedOutput}`;
      const { text: failureFeedback, truncated: feedbackTruncated } = sanitizeReviewFeedback(
        rawFailureFeedback,
        sessionRedactionPaths(session),
      );
      if (failureFeedback.length === 0) {
        die("Failure feedback is empty after sanitization; nothing was requeued.");
      }

      if (dryRun) {
        emit({
          ok: true,
          dryRun: true,
          sessionId,
          issueNumber,
          command,
          exitCode,
          previousStatus: task.status,
          previousPhase: task.phase,
          wouldRequeue: { status: "queued", phase: "implementation" },
          action: "fix_mode",
          feedbackChars: failureFeedback.length,
          prUrl: prUrl ?? null,
          branch: resolvedBranch,
        });
        return;
      }

      const requeue = await enqueueFixModeRequeue({
        store,
        outboxStore,
        session,
        task,
        reviewFeedback: failureFeedback,
        reviewFeedbackSource: "operator_input",
        reviewFeedbackMeta: {
          source: "operator_input",
          recordedAt: now,
          feedbackChars: failureFeedback.length,
          truncated: feedbackTruncated,
          channel: "review-verification-resolve",
          manualVerificationCommand: command,
          manualVerificationExitCode: exitCode,
        },
        now,
        runId,
        verificationStateOnFix: "preserveMissingOnly",
        expectedRevision: task.revision,
      });
      if (!requeue.ok) {
        die(
          `Failed to requeue task: ${requeue.code}` +
            (requeue.current ? ` (current status: ${requeue.current.status})` : "") +
            maintenanceRefusalHint(requeue.code),
        );
      }

      await store.appendEvent({
        task: { sessionId, issueNumber },
        type: "review_verification_resolve",
        runId,
        message: `Operator supplied failed manual verification for issue #${issueNumber}: \`${command}\` (exit ${exitCode}). Routed to implementation fix mode.`,
        data: { command, exitCode, previousStatus: task.status, previousPhase: task.phase, action: "fix_mode" },
        createdAt: now,
      });

      emit({
        ok: true,
        sessionId,
        issueNumber,
        command,
        exitCode,
        previousStatus: task.status,
        previousPhase: task.phase,
        status: requeue.task.status,
        phase: requeue.task.phase,
        action: "fix_mode",
        // issue #674 review: for a branch-only task, `prUrl` above is undefined
        // even though enqueueFixModeRequeue live-discovered and persisted a real
        // PR url as `requeue.prUrl`. Report that discovered url so the failure
        // response doesn't falsely claim no PR exists.
        prUrl: requeue.prUrl ?? null,
        branch: resolvedBranch,
      });
      return;
    }

    // Issue #1040: bind the passing evidence to the plan revision, the §5.1
    // slot identity, and the reviewed commit it attests, so a later review
    // admits it only for exactly what it tested. The review escalation
    // records the binding block (`verificationEvidenceBinding`); a legacy
    // escalation lacks it, in which case the reviewed HEAD must be supplied
    // explicitly via --head-sha and the remaining identities are derived from
    // the task's own durable inputs — or the resolve refuses rather than
    // recording evidence a bound review could never admit. A recorded HEAD is
    // authoritative: --head-sha may restate it but never replace it, because
    // an override would stamp the evidence with a commit the escalating
    // review never examined and let the next review admit it as a clean pass.
    // (`bindingBlock` is read above, where §13.1's refusal also consults it.)
    if (headSha !== undefined && bindingBlock?.headSha !== undefined && headSha !== bindingBlock.headSha) {
      die(
        `--head-sha ${headSha} does not match the reviewed HEAD this escalation recorded (${bindingBlock.headSha}). ` +
          `The recorded value is authoritative — evidence bound to a different commit could pass a review that never ` +
          `examined it. Omit --head-sha (the recorded value is used), or pass the recorded value.`,
      );
    }
    const boundHeadSha = bindingBlock?.headSha ?? headSha;
    if (boundHeadSha === undefined) {
      die(
        `Cannot bind manual verification evidence to a reviewed commit: the escalation recorded no reviewed HEAD ` +
          `(it predates the evidence-binding contract, issue #1040) and no --head-sha was supplied. ` +
          `Pass --head-sha <sha> naming the commit the command was run against, or requeue the review once so the ` +
          `next escalation records it.`,
      );
    }
    const trimmedCommand = command.trim();
    // Issue #1043 review (P2): bytes carried by more than one active
    // requirement slot are excluded from the byte-keyed map and listed as
    // ambiguous — a single evidence entry binds ONE §5.1 identity, so binding
    // here would clear whichever slot the map happened to keep while the
    // other rejects the evidence forever. Refuse with the repair instead.
    if (
      bindingBlock?.ambiguousCommands !== undefined &&
      (bindingBlock.ambiguousCommands.includes(trimmedCommand) ||
        bindingBlock.ambiguousCommands.includes(command))
    ) {
      die(
        `Cannot bind manual verification evidence for \`${command}\`: more than one active requirement slot in the ` +
          `effective verification plan carries exactly these command bytes, so a single evidence entry cannot name ` +
          `which slot it attests. Disambiguate the requirement first with \`admin task-verification amend\` ` +
          `(retire or replace one of the duplicate slots), requeue the review, then re-run this resolve.`,
      );
    }
    let boundCommandId = bindingBlock?.commandIds?.[trimmedCommand] ?? bindingBlock?.commandIds?.[command];
    let boundPlanDigest = bindingBlock?.planDigest;
    let boundPlanRevisionOrdinal = bindingBlock?.planRevisionOrdinal;
    if (boundCommandId === undefined || boundPlanDigest === undefined || boundPlanRevisionOrdinal === undefined) {
      if (ctx[VERIFICATION_AMENDMENTS_CONTEXT_KEY] !== undefined) {
        // Under an amendment chain a slot's identity can differ from its raw
        // command bytes (a replaced slot keeps its original commandId), so
        // deriving the identity here would guess — exactly what the binding
        // contract forbids. Fail closed; a fresh review escalation records
        // the authoritative block.
        die(
          `Cannot bind manual verification evidence for \`${command}\`: the task carries verification amendments ` +
            `but the escalation recorded no usable evidence-binding block. Requeue the review so the escalation ` +
            `records the effective plan's identities, then re-run this resolve.`,
        );
      }
      const planResult = resolveEffectiveVerificationPlan({
        sessionVerification: session.verification,
        issueRequirements: typeof ctx.body === "string" ? extractIssueVerificationCommands(ctx.body) : [],
      });
      if (planResult.status === "invalid") {
        die(
          `Cannot resolve the effective verification plan to bind evidence (${planResult.reason}): ${planResult.detail}`,
        );
      }
      boundCommandId ??= deriveRequirementCommandId(trimmedCommand);
      boundPlanDigest ??= planResult.plan.planDigest;
      boundPlanRevisionOrdinal ??= planResult.plan.appliedThroughOrdinal;
    }
    // Issue #1044 review (P2): the block above is the ESCALATION's, resolved
    // before any amendment applied since. §13.1 only proved the displayed bytes
    // still name an ACTIVE requirement — it says nothing about which slot
    // carries them now, nor about the plan they belong to. An amendment that
    // leaves those bytes required can still have moved the slot under them (a
    // retire plus a re-add, a restore that re-materializes the identity), and
    // stamping the escalation's identity would bind evidence to a slot the
    // amended plan no longer evaluates: the next review rejects it
    // `identity_mismatch` forever while still reporting the command as missing,
    // which is the manual-evidence deadlock the binding rule exists to avoid.
    // So under an amendment chain the binding is verified against the CURRENT
    // effective plan and its provenance rebuilt from it. The recorded HEAD is
    // untouched — the evidence attests a commit, and no amendment changes which.
    if (amendedEffectivePlan !== undefined) {
      // Candidates are the slots this evidence would be CREDITED to by the
      // requirement gate — the same `matchesConfiguredVerificationCommand`
      // direction §13.1 used above, so a slot an amendment unwrapped out of
      // `bash -lc '<cmd>'` is still the slot these bytes address (issue #1044
      // review, P2).
      const currentSlots = amendedEffectivePlan.requirement.filter(
        (slot) => slot.state === "active" && matchesConfiguredVerificationCommand(trimmedCommand, slot.command),
      );
      // Matching under the equivalence rule can also admit a pair the rule
      // itself cannot tell apart — a bare command and its own `bash -lc`
      // wrapper, the §13.2 ambiguity. That is the same refusal as byte-equal
      // duplicates and for the same reason: the review resolves a requirement's
      // expected identity through a BYTE-keyed map, so whichever slot the map
      // does not keep would reject this entry forever. The escalation's
      // recorded identity is deliberately not used to pick between them.
      if (currentSlots.length > 1) {
        // The §1043-P2 refusal, decided on the plan as it stands rather than on
        // the escalation's `ambiguousCommands`: an amendment applied since can
        // have created the duplicate the escalation never saw.
        die(
          `Cannot bind manual verification evidence for \`${command}\`: more than one active requirement slot in the ` +
            `effective verification plan is satisfied by these command bytes, so a single evidence entry cannot name ` +
            `which slot it attests. Disambiguate the requirement first with \`admin task-verification amend\` ` +
            `(retire or replace one of the duplicate slots), requeue the review, then re-run this resolve.`,
        );
      }
      const currentSlot = currentSlots[0];
      if (currentSlot === undefined || currentSlot.commandId !== boundCommandId) {
        die(
          `Cannot bind manual verification evidence for \`${command}\`: a verification amendment moved the ` +
            `requirement slot these bytes address since the review escalation recorded its binding ` +
            `(escalation: ${boundCommandId ?? "none"}, effective plan: ${currentSlot?.commandId ?? "none"}). ` +
            `Evidence stamped with the escalation's identity would be rejected by the next review as bound to a ` +
            `slot the amended plan no longer evaluates. Requeue the review so a fresh escalation records the ` +
            `effective plan's identities, then re-run this resolve.`,
        );
      }
      // Provenance follows the plan the evidence is actually recorded under.
      boundPlanDigest = amendedEffectivePlan.planDigest;
      boundPlanRevisionOrdinal = amendedEffectivePlan.appliedThroughOrdinal;
    }
    const evidenceBinding = {
      headSha: boundHeadSha,
      commandId: boundCommandId,
      planDigest: boundPlanDigest,
      planRevisionOrdinal: boundPlanRevisionOrdinal,
    };

    // Exit 0: store passing evidence. Merge with any existing evidence,
    // replacing an entry for the same command.
    const existingEvidence = Array.isArray(ctx.manualVerificationEvidence) ? ctx.manualVerificationEvidence : [];
    const updatedEvidence = [
      ...existingEvidence.filter(
        (e: unknown) =>
          !(typeof e === "object" && e !== null && (e as Record<string, unknown>)["command"] === command),
      ),
      {
        command,
        exitCode: 0,
        output: sanitizedOutput,
        recordedAt: now,
        source: "operator_input",
        ...evidenceBinding,
      },
    ];

    const remainingMissingCmds = missingCmds.filter((c) => c !== command);
    // Only the last remaining required command should requeue review and post a
    // public handoff comment (issue #622): while other commands are still
    // missing, the task stays a ready_for_human/review handoff so the operator
    // can resolve the rest without tripping a fresh escalation per command.
    const isFinalCommand = remainingMissingCmds.length === 0;

    if (dryRun) {
      emit({
        ok: true,
        dryRun: true,
        sessionId,
        issueNumber,
        command,
        exitCode,
        previousStatus: task.status,
        previousPhase: task.phase,
        ...(isFinalCommand
          ? { wouldRequeue: { status: "queued", phase: "review" }, action: "requeue_review" }
          : {
              action: "recorded",
              remainingCommands: remainingMissingCmds,
              remainingCount: remainingMissingCmds.length,
            }),
        binding: evidenceBinding,
        evidenceCount: updatedEvidence.length,
        outputChars: sanitizedOutput.length,
        prUrl: prUrl ?? null,
        branch: resolvedBranch,
      });
      return;
    }

    const newContext: Record<string, unknown> = {
      manualVerificationEvidence: updatedEvidence,
      branch: resolvedBranch,
      ...(prUrl !== undefined ? { prUrl } : {}),
      // Remove the resolved command from the missing list; keep others so
      // subsequent resolve calls can still satisfy them.
      missingVerificationCommands: remainingMissingCmds.length > 0 ? remainingMissingCmds : undefined,
    };

    if (!isFinalCommand) {
      // Other required commands remain missing: retain ready_for_human/review,
      // persist the accumulated evidence and shrunk missing list, and report
      // locally. Do not requeue review, touch GitHub labels, or post a new
      // public handoff comment — the handoff is not resolved yet.
      const recordResult = await store.transitionTask(
        { sessionId, issueNumber },
        // `revision` pins this write to the exact context snapshot `newContext`
        // was computed from, so a concurrent resolve of a different missing
        // command (which also passes only `status`) cannot land in between and
        // get silently clobbered by this stale-snapshot write (issue #622
        // review, P2). A monotonic counter is used instead of `updatedAt`
        // because two writers whose clocks land in the same millisecond can
        // read (and even write) an identical timestamp, letting a stale
        // timestamp-only CAS check pass; `revision` only ever advances by
        // exactly 1 per write, so it cannot collide that way. A conflict here
        // fails closed with a clear error instead of losing the other
        // operator's recorded evidence.
        { status: task.status, revision: task.revision },
        { status: task.status, context: newContext, now },
      );
      if (!recordResult.ok) {
        die(
          `Failed to record manual verification: ${recordResult.code}` +
            (recordResult.current ? ` (current status: ${recordResult.current.status})` : "") +
            (recordResult.code === "conflict"
              ? ". Another resolve may have run concurrently; re-check missing commands and retry."
              : ""),
        );
      }

      await store.appendEvent({
        task: { sessionId, issueNumber },
        type: "review_verification_resolve",
        runId,
        message:
          `Operator supplied passing manual verification for issue #${issueNumber}: \`${command}\` (exit 0). ` +
          `${remainingMissingCmds.length} command(s) still missing: ${remainingMissingCmds.join(", ")}.`,
        data: {
          command,
          exitCode: 0,
          previousStatus: task.status,
          previousPhase: task.phase,
          action: "recorded",
          binding: evidenceBinding,
          evidenceCount: updatedEvidence.length,
          remainingCommands: remainingMissingCmds,
        },
        createdAt: now,
      });

      emit({
        ok: true,
        sessionId,
        issueNumber,
        command,
        exitCode,
        previousStatus: task.status,
        previousPhase: task.phase,
        status: recordResult.value.status,
        phase: recordResult.value.phase,
        action: "recorded",
        binding: evidenceBinding,
        remainingCommands: remainingMissingCmds,
        remainingCount: remainingMissingCmds.length,
        evidenceCount: updatedEvidence.length,
        outputChars: sanitizedOutput.length,
        prUrl: prUrl ?? null,
        branch: resolvedBranch,
      });
      return;
    }

    // Collect this requeue's label + comment effects first and commit them in
    // the SAME transaction as the transition below (issue #818 review
    // follow-up). Enqueueing them afterwards, through the separate outbox
    // connection, meant a maintenance lock acquired in between would throw with
    // the task already back in the review lane but nothing telling GitHub about
    // it — the half-applied human-handoff state the maintenance guard exists to
    // prevent. None of these effects depends on the transition's result, so
    // ordering them first costs nothing.
    const effects = new OutboxEffectCollector();

    // Remove the ready-for-human label and restore the review-lane labels so
    // github-intake can discover the re-queued review task. The blocked-review
    // transition that set ready-for-human already removed status:needs-review
    // and the reviewer agent label, so we must add them back here.
    const workItemStore = workItemOutbox(effects, session);
    const readyForHumanLabel = (session.labels["readyForHuman"] as string | undefined) ?? "status:ready-for-human";
    await workItemStore.enqueue({
      idempotencyKey: makeOutboxKey(sessionId, issueNumber, runId, "gh:label:remove", readyForHumanLabel),
      topic: "gh:label:remove",
      payload: {
        topic: "gh:label:remove",
        owner: session.githubOwner,
        repo: session.githubName,
        issueNumber,
        label: readyForHumanLabel,
      },
      now,
    });
    const resolvedReviewAgentId = agentForPhase(task, session, "review");
    const taskAssignedReviewAgent = readResolvedAssignment(task)?.reviewAgent ?? task.reviewAgent;
    const agentReviewLabel: string = taskAssignedReviewAgent
      ? `agent:${taskAssignedReviewAgent}`
      : (session.labels["agentReview"] as string | undefined) ??
        (resolvedReviewAgentId ? `agent:${resolvedReviewAgentId}` : "agent:codex");
    for (const label of [
      (session.labels["needsReview"] as string | undefined) ?? "status:needs-review",
      agentReviewLabel,
    ]) {
      await workItemStore.enqueue({
        idempotencyKey: makeOutboxKey(sessionId, issueNumber, runId, "gh:label:add", label),
        topic: "gh:label:add",
        payload: {
          topic: "gh:label:add",
          owner: session.githubOwner,
          repo: session.githubName,
          issueNumber,
          label,
        },
        now,
      });
    }

    // Public status comment (metadata only — no command output or local paths).
    // This is the single handoff-closing comment: it fires only once, when the
    // last required command succeeds (issue #622), so it summarizes every
    // command verified rather than just the one that just resolved.
    const verifiedCommands = updatedEvidence
      .map((e) => (typeof e === "object" && e !== null ? (e as Record<string, unknown>)["command"] : undefined))
      .filter((c): c is string => typeof c === "string");
    const commentBody = sanitizeBody(
      `🔍 **Manual verification complete.**\n\n` +
        `All required verification command(s) passed:\n` +
        verifiedCommands.map((c) => `- \`${c}\``).join("\n") +
        `\n\nTask re-queued for automated review.`,
      sessionRedactionPaths(session),
    );
    await workItemStore.enqueue({
      idempotencyKey: makeOutboxKey(sessionId, issueNumber, runId, "gh:comment", "review-verification-resolve"),
      topic: "gh:comment",
      payload: {
        topic: "gh:comment",
        owner: session.githubOwner,
        repo: session.githubName,
        issueNumber,
        body: commentBody,
      },
      now,
    });

    // One transaction: the review requeue plus every effect collected above, or
    // nothing at all. A held maintenance lock is refused here with
    // `maintenance_locked` and the task left untouched, so the command is simply
    // re-runnable once maintenance releases the lock.
    const result = await store.transitionTaskWithEffects(
      { sessionId, issueNumber },
      // See the P2 comment on the partial-record transitionTask above: pin to
      // the exact snapshot this final-command context was built from so a
      // last-second concurrent resolve can't be silently overwritten.
      { status: task.status, revision: task.revision },
      {
        status: "queued",
        phase: "review",
        ownerRunId: undefined,
        leaseExpiresAt: undefined,
        lastError: undefined,
        context: newContext,
        now,
      },
      effects.effects,
    );
    if (!result.ok) {
      die(
        `Failed to requeue task: ${result.code}` +
          (result.current ? ` (current status: ${result.current.status})` : "") +
          (result.code === "conflict"
            ? ". Another resolve may have run concurrently; re-check missing commands and retry."
            : "") +
          maintenanceRefusalHint(result.code),
      );
    }

    await store.appendEvent({
      task: { sessionId, issueNumber },
      type: "review_verification_resolve",
      runId,
      message: `Operator supplied passing manual verification for issue #${issueNumber}: \`${command}\` (exit 0). All required commands verified. Requeued to review.`,
      data: {
        command,
        exitCode: 0,
        previousStatus: task.status,
        previousPhase: task.phase,
        action: "requeue_review",
        binding: evidenceBinding,
        evidenceCount: updatedEvidence.length,
      },
      createdAt: now,
    });

    emit({
      ok: true,
      sessionId,
      issueNumber,
      command,
      exitCode,
      previousStatus: task.status,
      previousPhase: task.phase,
      status: result.value.status,
      phase: result.value.phase,
      action: "requeue_review",
      binding: evidenceBinding,
      evidenceCount: updatedEvidence.length,
      outputChars: sanitizedOutput.length,
      prUrl: prUrl ?? null,
      branch: resolvedBranch,
    });
  } finally {
    store.close();
    outboxStore.close();
  }
}

// ---------------------------------------------------------------------------
// Subcommand: review-verification refresh (issue #1041)
//
// docs/verification-amendment-contract.md §10 / §15 slice A6: re-read the live
// Issue, project ONLY its verification section through the shipped extractor,
// diff that against the task's effective requirement layer, and record the
// difference as one task-scoped `issue-refresh` revision.
//
// Preview by default (§11 rule 1); `--yes` applies. `--reason` is mandatory on
// an applying invocation and becomes the reason of every operation it records
// (§5.2 rule 1). Retirements are proposed, never applied, without
// `--allow-retire` (§10 rule 4), and no `replace` is ever emitted (§10 rule 3)
// — correcting a requirement's bytes in place stays an explicit operator
// judgment. `--expect-issue-digest` is the concurrent-edit guard between a
// preview and the apply that follows it.
//
// What it never touches: `context.body`, the title, labels, the phase, the
// dependencies, or any implementation-scope field (§10 rule 1). The intake
// snapshot stays pinned; the amendment layer is what makes the corrected
// requirement effective.
// ---------------------------------------------------------------------------

interface ReviewVerificationRefreshArgs {
  sessionId: string;
  issueNumber: number;
  reason: string;
  allowRetire: boolean;
  yes: boolean;
  requestKey: string | undefined;
  expectIssueDigest: string | undefined;
  /** The concurrent-amendment guard (issue #1044 review): the base plan digest. */
  expectPlanDigest: string | undefined;
  sessionsPath: string;
  dbPath: string | undefined;
}

function parseReviewVerificationRefreshArgs(
  argv: string[],
): ReviewVerificationRefreshArgs | { error: string } {
  // §11 rule 2: the shared tokenizer, never a hand-rolled scan, so unknown and
  // abbreviated flags (`--ye`, `--allow-retir`, `--reaso`) inherit the
  // fail-closed bar instead of reimplementing it.
  const tokenized = tokenizeArgs(argv, {
    booleanFlags: ["yes", "allow-retire"],
    valueFlags: [
      "session-id",
      "issue-number",
      "reason",
      "request-key",
      "expect-issue-digest",
      "expect-plan-digest",
      "sessions-path",
      "db-path",
    ],
  });
  if ("error" in tokenized) return { error: tokenized.error };
  const { args, flags } = tokenized;

  if (!args["session-id"]) return { error: "--session-id is required" };
  if (args["issue-number"] === undefined) return { error: "--issue-number is required" };
  const n = Number(args["issue-number"]);
  if (!Number.isInteger(n) || n <= 0) {
    return { error: `--issue-number must be a positive integer, got: ${args["issue-number"]}` };
  }
  if (args["reason"] === undefined || args["reason"].trim() === "") {
    return { error: "--reason is required and must not be empty or whitespace-only" };
  }

  return {
    sessionId: args["session-id"],
    issueNumber: n,
    reason: args["reason"],
    allowRetire: flags.has("allow-retire"),
    yes: flags.has("yes"),
    requestKey: args["request-key"],
    expectIssueDigest: args["expect-issue-digest"],
    expectPlanDigest: args["expect-plan-digest"],
    sessionsPath: args["sessions-path"] ?? DEFAULT_SESSIONS_PATH,
    dbPath: args["db-path"],
  };
}

/** Exit-code mapping (§11 rule 5): only operational refusals exit non-zero. */
function reviewVerificationRefreshFailed(outcome: IssueVerificationRefreshOutcome): boolean {
  return outcome.status === "refused" || outcome.status === "stale" || outcome.status === "maintenance_locked";
}

function renderReviewVerificationRefresh(payload: Record<string, unknown>): string {
  const lines: string[] = [];
  const text = (key: string): string => (payload[key] === undefined ? "" : String(payload[key]));
  const list = (key: string): string[] => (Array.isArray(payload[key]) ? (payload[key] as string[]) : []);
  const outcome = text("outcome");
  lines.push(`${text("command")} — issue #${text("issueNumber")} (session ${text("sessionId")})`);
  if (payload.issueBodyDigest !== undefined) {
    lines.push(`  live Issue body digest: ${text("issueBodyDigest")}`);
  }
  if (outcome === "refused" || outcome === "stale" || outcome === "maintenance_locked") {
    lines.push(`  REFUSED (${text("reasonCode") || outcome}): ${text("error")}`.trimEnd());
    lines.push(`  Nothing was written; no revision ordinal was consumed.`);
    return lines.join("\n");
  }
  if (outcome === "replay") {
    lines.push(
      `  Replay: the request key already names revision ${text("revisionId")} ` +
        `(ordinal ${text("revisionOrdinal")}). Nothing was written.`,
    );
    return lines.join("\n");
  }
  const section = (title: string, entries: readonly string[]): void => {
    lines.push(`  ${title}: ${entries.length}`);
    for (const entry of entries) lines.push(`    - ${entry}`);
  };
  section("unchanged", list("unchanged"));
  section("restore", list("restores"));
  section("add", list("adds"));
  // §10 rule 3: stated explicitly rather than omitted — a refresh never
  // proposes a replacement, and the preview should say so.
  section("replace (never proposed by a refresh)", list("replacements"));
  section(
    payload.allowRetire === true ? "retire" : "retire (withheld — pass --allow-retire to apply)",
    list("retirements"),
  );
  if (outcome === "no_change") {
    // The plan this refresh actually diffed the Issue against, reported in the
    // same words the amend/reset renderer uses for the same outcome (issue #1044
    // review, P1). A `no_change` names no revision, so without this line the
    // only plan digest a reader — or a caller carrying the preview into an
    // apply — could pin is one read from somewhere else, before this invocation
    // resolved the plan. That plan may already have moved.
    lines.push(`  plan digest: ${text("planDigest")} (unchanged)`);
    lines.push(
      list("withheldRetirements").length > 0
        ? `  Nothing to apply: the only difference is a retirement, which is withheld without --allow-retire. No revision was recorded.`
        : `  No difference to apply. No revision was recorded.`,
    );
    return lines.join("\n");
  }
  lines.push(`  plan digest: ${text("basePlanDigest")} -> ${text("planDigest")}`);
  lines.push(`  revision: ${text("revisionId")} (request key ${text("requestKey")})`);
  lines.push(taskVerificationContinuationLine(payload));
  if (outcome === "preview") {
    // Both guards, because a refresh's difference is a function of two inputs:
    // the live Issue AND the task's own plan. Naming only the Issue digest would
    // leave a concurrent `amend` free to change what the apply applies (issue
    // #1044 review).
    lines.push(
      `  Preview only. Re-run with --yes --expect-issue-digest ${text("issueBodyDigest")}` +
        ` --expect-plan-digest ${text("basePlanDigest")} to apply exactly this.`,
    );
  } else {
    lines.push(`  Applied as revision ordinal ${text("revisionOrdinal")}.`);
  }
  return lines.join("\n");
}

export async function runReviewVerificationRefresh(
  argv: string[],
  // `commandName` is how `task-verification refresh-from-issue` (issue #1042)
  // reports itself through this exact runner: the two spellings are one
  // command, so they must not become two implementations.
  deps?: { source?: VerificationRefreshIssueSource; commandName?: string },
): Promise<void> {
  const parsed = parseReviewVerificationRefreshArgs(argv);
  if ("error" in parsed) die(parsed.error);
  const {
    sessionId,
    issueNumber,
    reason,
    allowRetire,
    yes,
    requestKey,
    expectIssueDigest,
    expectPlanDigest,
    sessionsPath,
    dbPath,
  } = parsed;

  let registry: JsonSessionRegistry;
  try {
    registry = new JsonSessionRegistry(sessionsPath);
  } catch (err) {
    die(`Failed to load sessions file (${sessionsPath}): ${err instanceof Error ? err.message : String(err)}`);
  }
  const session = await registry.getSessionById(sessionId);
  if (!session) {
    die(describeUnresolvedSessionId(registry, sessionId, sessionsPath));
  }

  // The provider gate reads the CONFIGURED kind before any adapter is built, so
  // an unsupported provider refuses with its own message rather than with an
  // auth or transport failure from a host it should never have contacted.
  const workItemKind = session.workItemProvider?.provider ?? "github-issues";
  let source: VerificationRefreshIssueSource | undefined = deps?.source;
  if (!source && workItemKind === "github-issues") {
    try {
      const runner = await resolveGhRunner(
        session.workItemProvider?.auth ?? { mode: "gh" },
        ghRunnerFromCommandRunner(defaultCommandRunner),
      );
      source = createGhRefinementReads({
        githubRepo: session.githubRepo,
        runGh: runGhViaRunner(runner, session.repoRoot),
      });
    } catch (err) {
      die(
        `Failed to resolve GitHub work-item provider auth: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const redactionPaths = sessionRedactionPaths(session);
  const clean = (text: string): string => sanitizeBody(text, redactionPaths);

  const store = new SqliteTaskStore(dbPath);
  try {
    const now = new Date().toISOString();
    const outcome = await refreshIssueVerification(
      { store, source, extract: extractIssueVerificationSections },
      {
        key: { sessionId, issueNumber },
        sessionVerification: session.verification,
        actorId: "admin",
        reason,
        allowRetire,
        apply: yes,
        requestKey,
        expectedIssueBodyDigest: expectIssueDigest,
        expectedPlanDigest: expectPlanDigest,
        providerKind: workItemKind,
        session,
        runId: `admin-review-verification-refresh-${now}`,
        now,
      },
    );

    const payload = reviewVerificationRefreshPayload(outcome, {
      sessionId,
      issueNumber,
      allowRetire,
      clean,
      command: deps?.commandName ?? "review-verification refresh",
    });
    report(payload, () => renderReviewVerificationRefresh(payload));
    if (reviewVerificationRefreshFailed(outcome)) process.exitCode = 1;
  } finally {
    store.close();
  }
}

/**
 * The reported payload. Every human-facing string — refusal detail and command
 * bytes alike — goes through the session redaction the shipped
 * `review-verification resolve` output uses (§11 rule 7): a verification
 * command is Issue text and can carry a local path.
 */
function reviewVerificationRefreshPayload(
  outcome: IssueVerificationRefreshOutcome,
  ctx: {
    sessionId: string;
    issueNumber: number;
    allowRetire: boolean;
    clean: (text: string) => string;
    command: string;
  },
): Record<string, unknown> {
  const base = {
    command: ctx.command,
    sessionId: ctx.sessionId,
    issueNumber: ctx.issueNumber,
    allowRetire: ctx.allowRetire,
    outcome: outcome.status,
  };
  if (outcome.status === "refused") {
    return {
      ok: false,
      ...base,
      reasonCode: outcome.reason,
      ...(outcome.issueBodyDigest !== undefined ? { issueBodyDigest: outcome.issueBodyDigest } : {}),
      error: ctx.clean(outcome.detail),
    };
  }
  if (outcome.status === "stale") {
    return {
      ok: false,
      ...base,
      reasonCode: "stale",
      observedTaskRevision: outcome.observedTaskRevision,
      currentTaskRevision: outcome.currentTaskRevision ?? null,
      observedPlanDigest: outcome.observedPlanDigest,
      currentPlanDigest: outcome.currentPlanDigest ?? null,
      error:
        `the task moved while this refresh was being prepared; nothing was written. ` +
        `Re-run the preview and apply again.`,
    };
  }
  if (outcome.status === "maintenance_locked") {
    return {
      ok: false,
      ...base,
      reasonCode: "maintenance_locked",
      error: "the task store is under maintenance; nothing was written. Retry shortly.",
    };
  }
  if (outcome.status === "replay") {
    return {
      ok: true,
      ...base,
      revisionId: outcome.revision.revisionId,
      revisionOrdinal: outcome.revision.revisionOrdinal,
      requestKey: outcome.revision.requestKey,
      planDigest: outcome.revision.planDigest,
      applied: false,
    };
  }

  const diff = outcome.status === "no_change" ? outcome.diff : outcome.report.diff;
  const shared = {
    ...base,
    issueBodyDigest: outcome.status === "no_change" ? outcome.issueBodyDigest : outcome.report.issueBodyDigest,
    liveCommands: (outcome.status === "no_change" ? outcome.liveCommands : outcome.report.liveCommands).map(ctx.clean),
    unchanged: diff.unchanged.map((entry) => `${entry.commandId} ${ctx.clean(entry.planCommand)}`),
    restores: diff.restores.map(
      (entry) =>
        `${entry.commandId} ${ctx.clean(entry.reinstatedCommand)}` +
        (entry.reinstatedBytesDiffer ? ` (reinstated bytes differ from the live text \`${ctx.clean(entry.liveCommand)}\`)` : ""),
    ),
    adds: diff.adds.map((entry) => `${entry.commandId} ${ctx.clean(entry.command)}`),
    // §10 rule 3: a refresh never emits a `replace`. Reported as an empty set
    // rather than omitted, so the preview answers the question explicitly.
    replacements: [] as string[],
    retirements: diff.proposedRetirements.map((entry) => `${entry.commandId} ${ctx.clean(entry.command)}`),
    withheldRetirements: (outcome.status === "no_change"
      ? outcome.withheldRetirements
      : outcome.report.withheldRetirements
    ).map((entry) => entry.commandId),
    defaultContinuation:
      outcome.status === "no_change" ? outcome.defaultContinuation : outcome.report.defaultContinuation,
  };

  if (outcome.status === "no_change") {
    return { ok: true, ...shared, planDigest: outcome.planDigest, applied: false };
  }
  const refreshReport = outcome.report;
  return {
    ok: true,
    ...shared,
    operations: refreshReport.operations.map((operation) => operation.kind),
    basePlanDigest: refreshReport.basePlanDigest,
    planDigest: refreshReport.planDigest,
    continuation: refreshReport.continuation,
    requestKey: refreshReport.requestKey,
    revisionId: refreshReport.revisionId,
    applied: outcome.status === "applied",
    ...(outcome.status === "applied"
      ? {
          revisionOrdinal: outcome.revision.revisionOrdinal,
          // §9.2 (issue #1043): the explicit routing outcome of the apply.
          taskStatus: outcome.task.status,
          taskPhase: outcome.task.phase,
          requeued:
            refreshReport.continuation === "none"
              ? null
              : { status: outcome.task.status, phase: outcome.task.phase },
        }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Subcommand family: task-verification (issue #1042)
//
// The operator surface of docs/verification-amendment-contract.md §11 (§15
// slice A4), spelled as the resource it addresses: one TASK's verification
// plan.
//
//   admin task-verification show               — the effective plan, read-only
//   admin task-verification amend              — one operator-typed revision
//   admin task-verification refresh-from-issue — the §10 live-Issue import
//   admin task-verification reset              — back to the unamended plan
//
// `review-verification resolve` stays exactly where it is: it records EVIDENCE
// for a command, and these commands change which commands there are. Neither is
// a spelling of the other. `review-verification refresh` (issue #1041) also
// stays, with `refresh-from-issue` as its resource-oriented entry to the same
// runner — same flags, same outcomes, same exit codes.
//
// Every mutation previews by default and applies only under `--yes` (§11 rule
// 1), takes a mandatory `--reason` (§11 rule 3), refuses on a claimed/running
// or terminal task and on a stale plan (§7), reports both plan digests, and
// goes through the shared tokenizer so an unknown or abbreviated flag fails
// closed (§11 rule 2). None of them opens `sessions.json` for writing (§4 rule
// 3), and none re-implements plan resolution: the effective plan, the digest,
// the composition, and the write all come from the shipped core modules.
// ---------------------------------------------------------------------------

interface TaskVerificationTarget {
  sessionId: string;
  issueNumber: number;
  sessionsPath: string;
  dbPath: string | undefined;
}

/** The identity every `task-verification` action takes: a session and an Issue. */
function taskVerificationTarget(args: Record<string, string>): TaskVerificationTarget | { error: string } {
  if (!args["session-id"]) return { error: "--session-id is required" };
  if (args["issue-number"] === undefined) return { error: "--issue-number is required" };
  const n = Number(args["issue-number"]);
  if (!Number.isInteger(n) || n <= 0) {
    return { error: `--issue-number must be a positive integer, got: ${args["issue-number"]}` };
  }
  return {
    sessionId: args["session-id"],
    issueNumber: n,
    sessionsPath: args["sessions-path"] ?? DEFAULT_SESSIONS_PATH,
    dbPath: args["db-path"],
  };
}

/**
 * Resolve the session and its redaction closure. `session.verification` is the
 * LIVE execution layer every one of these commands resolves against (§6.1 step
 * 1); it is read and never written (§4 rule 3, §17).
 */
async function loadTaskVerificationSession(
  target: TaskVerificationTarget,
): Promise<{
  session: ResolvedSession;
  verification: Record<string, string> | undefined;
  clean: (text: string) => string;
}> {
  let registry: JsonSessionRegistry;
  try {
    registry = new JsonSessionRegistry(target.sessionsPath);
  } catch (err) {
    die(
      `Failed to load sessions file (${target.sessionsPath}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const session = await registry.getSessionById(target.sessionId);
  if (!session) {
    die(describeUnresolvedSessionId(registry, target.sessionId, target.sessionsPath));
  }
  const redactionPaths = sessionRedactionPaths(session);
  return {
    // The full resolved session rides along (issue #1043 review): an applying
    // amend/reset whose continuation routes needs it to enqueue the
    // stack-ready removal and lane-label swap atomically with the re-queue.
    session,
    verification: session.verification,
    // §11 rule 7: every human-facing string — command bytes and operator prose
    // alike — goes through the same bounding and sanitization the shipped
    // `review-verification resolve` output uses. A verification command is
    // Issue text and can carry a local path.
    clean: (text: string): string => sanitizeBody(text, redactionPaths),
  };
}

/** One plan slot as the preview and the applied report list it. */
function taskVerificationSlotLine(
  slot: { commandId: string; state: string; command: string; origin: string; amended: boolean },
  clean: (text: string) => string,
): string {
  return (
    `${slot.commandId} [${slot.state}] ${clean(slot.command)} ` +
    `(${slot.origin}${slot.amended ? ", amended" : ""})`
  );
}

// ---------------------------------------------------------------------------
// task-verification show
// ---------------------------------------------------------------------------

function parseTaskVerificationShowArgs(argv: string[]): TaskVerificationTarget | { error: string } {
  const tokenized = tokenizeArgs(argv, {
    valueFlags: ["session-id", "issue-number", "sessions-path", "db-path"],
  });
  if ("error" in tokenized) return { error: tokenized.error };
  return taskVerificationTarget(tokenized.args);
}

/**
 * The #1094 §10 rule 6 stage view as it rides the `show` payload (issue #1107).
 *
 * Additive: present only for an opted-in session or a task that retains stage
 * state, so every other `show --json` payload is byte-identical to before.
 * Every field is an id, a name, a verdict, a count, a duration, a digest, a SHA
 * or a fixed code; the free-text fields still go through `clean`.
 */
function taskVerificationStagedPayload(
  view: TaskVerificationPlanView,
  stagedVerification: StagedVerificationConfig | undefined,
  clean: (text: string) => string,
): StagedVerificationStatusView | undefined {
  if (!hasStagedVerificationSurface(stagedVerification, view.taskContext)) return undefined;
  const status = describeStagedVerificationStatus({
    stagedVerification,
    context: view.taskContext,
    plan: view.plan,
  });
  const cleanBundle = (bundle: StageBundleView): StageBundleView => ({
    ...bundle,
    checks: bundle.checks.map((check) => (check.name !== undefined ? { ...check, name: clean(check.name) } : check)),
    invalidations: bundle.invalidations.map(clean),
  });
  return {
    ...status,
    ...(status.stateDetail !== undefined ? { stateDetail: clean(status.stateDetail) } : {}),
    loop: status.loop.map(cleanBundle),
    ...(status.lastFinal !== undefined ? { lastFinal: cleanBundle(status.lastFinal) } : {}),
  };
}

function stageBundleLines(title: string, bundle: StageBundleView): string[] {
  // Issue #1155: a stage covers the entire required set, so "without the test
  // suite" is the only scope that is not the full set — the suite is Stage 1's.
  const scope = bundle.full ? "full set" : "without the test suite";
  const required = bundle.required !== undefined ? `/${bundle.required} required` : "";
  const duration = bundle.durationMs !== undefined ? `, ${bundle.durationMs}ms` : "";
  const row = bundle.row !== undefined
    ? ` — row ${bundle.row} routes ${bundle.routedDisposition}; runner ${bundle.disposition ?? "unrecorded"}` +
      `${bundle.granting === true ? " (granting)" : ""}`
    : "";
  const lines = [
    `    ${title} ${bundle.stageRunKey}: ${bundle.outcome}, ${bundle.complete ? "complete" : "INCOMPLETE"}, ` +
      `${bundle.selected}${required} selected (${scope})${duration}${row}`,
    `      passed ${bundle.counts.passed}, failed ${bundle.counts.failed}, timed-out ${bundle.counts.timedOut}, ` +
      `not-run ${bundle.counts.notRun}, unknown ${bundle.counts.unknown}; head ${bundle.headSha ?? "unknown"}, ` +
      `plan ${bundle.planDigest}`,
  ];
  for (const check of bundle.checks) {
    const label = check.name !== undefined ? `${check.checkId} (${check.name})` : check.checkId;
    const extra = [
      check.notRunKind !== undefined ? check.notRunKind : undefined,
      check.exitCode !== undefined ? `exit ${check.exitCode}` : undefined,
      check.durationMs !== undefined ? `${check.durationMs}ms` : undefined,
    ].filter((part): part is string => part !== undefined);
    lines.push(`      - ${label}: ${check.verdict}${extra.length > 0 ? ` (${extra.join(", ")})` : ""}`);
  }
  if (bundle.notSelected !== undefined && bundle.notSelected.length > 0) {
    lines.push(`      not selected (not known to pass): ${bundle.notSelected.join(", ")}`);
  }
  if (bundle.invalidations.length > 0) {
    lines.push(`      invalidated by: ${bundle.invalidations.join(", ")}`);
  }
  // Issue #1154: the test-file half — Stage 1 for a loop bundle, Stage 2 for a final one.
  const tests = bundle.testFiles;
  if (tests !== undefined) {
    const counts = tests.outcomeCounts;
    lines.push(
      `      tests (${bundle.stage === "loop" ? "Stage 1" : "Stage 2"}): ${tests.result}, selection ${tests.selection}` +
        (tests.selectionReason !== undefined ? ` (${tests.selectionReason})` : "") +
        (tests.mode !== undefined ? `, mode ${tests.mode}` : "") +
        (tests.trust !== undefined && tests.trust !== "trusted" ? `, outcomes untrusted (${tests.trust})` : "") +
        (counts !== undefined
          ? `; passed ${counts.passed}, failed ${counts.failed}, skipped ${counts.skipped}, not-run ${counts.notRun}`
          : ""),
    );
    for (const selected of tests.selectedFiles ?? []) {
      lines.push(`        - ${selected.file} (${selected.reasons.join(", ")})`);
    }
    if ((tests.unresolvedRetained ?? []).length > 0) {
      lines.push(`        unresolved retained: ${(tests.unresolvedRetained ?? []).join(", ")}`);
    }
    if (tests.failedFiles.length > 0) lines.push(`        failed: ${tests.failedFiles.join(", ")}`);
  }
  return lines;
}

function renderTaskVerificationStaged(staged: StagedVerificationStatusView): string[] {
  const lines = [
    `  staged verification: ${staged.enabled ? "enabled" : "DISABLED (retained state shown)"} — ` +
      `${staged.progress}: ${staged.meaning}`,
  ];
  if (staged.state === "unreadable") {
    lines.push(`    stage state UNREADABLE: ${staged.stateDetail ?? ""} — nothing is credited`);
  }
  if (staged.requiredChecks !== undefined) {
    lines.push(`    required checks (what a final stage runs): ${staged.requiredChecks}`);
  }
  if (staged.pendingApprovalHeadSha !== undefined) {
    lines.push(`    pending final verification of approved head ${staged.pendingApprovalHeadSha}`);
  }
  if (staged.openRun !== undefined) {
    lines.push(`    open run ${staged.openRun.stageRunKey} allocated at ${staged.openRun.allocatedAt} (no bundle)`);
  }
  for (const bundle of staged.loop) lines.push(...stageBundleLines("last loop", bundle));
  if (staged.lastFinal !== undefined) lines.push(...stageBundleLines("last final", staged.lastFinal));
  if (staged.lastFinalRecord !== undefined) {
    const record = staged.lastFinalRecord;
    lines.push(
      `    last final record: ${record.status}` +
        (record.reason !== undefined ? ` (${record.reason})` : "") +
        (record.reused === true ? ", satisfied by reuse" : "") +
        (record.bindingRefusals !== undefined ? `; binding refused: ${record.bindingRefusals.join(", ")}` : ""),
    );
  }
  if (staged.issueBase !== undefined) {
    lines.push(`    Issue base: ${staged.issueBase.sha} (${staged.issueBase.source})`);
  }
  lines.push(
    `    retained test files: ${staged.retainedTestFiles.length}` +
      (staged.retainedTestFilesOverflowed ? " (OVERFLOWED — Stage 1 selection is unavailable)" : ""),
  );
  for (const retained of staged.retainedTestFiles) lines.push(`      - ${retained.file} (added by ${retained.addedBy})`);
  const recovery = staged.recovery;
  lines.push(
    `    recovery: final streak ${recovery.finalStreak}/${recovery.maxStageRecoveryAttempts}, ` +
      (recovery.loopUnreadable === true
        ? "loop streak UNREADABLE"
        : `loop streak ${recovery.loopStreak ?? 0}/${recovery.maxStageRecoveryAttempts}` +
          (recovery.loopLastOutcome !== undefined ? ` (last ${recovery.loopLastOutcome})` : "")),
  );
  return lines;
}

function taskVerificationShowPayload(
  view: TaskVerificationPlanView,
  ctx: {
    target: TaskVerificationTarget;
    clean: (text: string) => string;
    stagedVerification?: StagedVerificationConfig;
  },
): Record<string, unknown> {
  const { clean } = ctx;
  const staged = taskVerificationStagedPayload(view, ctx.stagedVerification, clean);
  const statusOf = new Map(view.requirementStatus.map((entry) => [entry.commandId, entry] as const));
  const ordinals = (slot: { amendments: readonly { revisionOrdinal: number }[] }): number[] => [
    ...new Set(slot.amendments.map((record) => record.revisionOrdinal)),
  ];
  return {
    ok: true,
    sessionId: ctx.target.sessionId,
    issueNumber: ctx.target.issueNumber,
    outcome: "ok",
    taskStatus: view.taskStatus,
    taskPhase: view.taskPhase,
    reconciliation: view.reconciliation,
    planDigest: view.plan.planDigest,
    appliedThroughOrdinal: view.plan.appliedThroughOrdinal,
    amendable: view.amendable,
    ...(view.amendmentRefusal !== undefined
      ? { amendmentRefusal: { reason: view.amendmentRefusal.reason, detail: clean(view.amendmentRefusal.detail) } }
      : {}),
    defaultContinuation: view.defaultContinuation,
    execution: view.plan.execution.map((slot) => ({
      commandId: slot.commandId,
      ...(slot.name !== undefined ? { name: slot.name } : {}),
      state: slot.state,
      command: clean(slot.command),
      origin: slot.origin,
      amended: slot.amended,
      revisionOrdinals: ordinals(slot),
    })),
    requirement: view.plan.requirement.map((slot) => ({
      commandId: slot.commandId,
      state: slot.state,
      command: clean(slot.command),
      origin: slot.origin,
      amended: slot.amended,
      revisionOrdinals: ordinals(slot),
      // §6.2 rule 3 / §8.4 rule 1: `retired` is a state of its own and is
      // never reported as a pass.
      status: statusOf.get(slot.commandId)?.status ?? "not_run",
      ...(statusOf.get(slot.commandId)?.satisfiedBy !== undefined
        ? { satisfiedBy: statusOf.get(slot.commandId)?.satisfiedBy }
        : {}),
    })),
    revisions: view.revisions.map((revision) => ({
      revisionId: revision.revisionId,
      revisionOrdinal: revision.revisionOrdinal,
      source: revision.source,
      actorId: revision.actor.id,
      reason: clean(revision.reason),
      operations: revision.operations.map((operation) => operation.kind),
      basePlanDigest: revision.basePlanDigest,
      planDigest: revision.planDigest,
      continuation: revision.continuation,
      createdAt: revision.createdAt,
    })),
    ...(view.checkpoint !== undefined
      ? {
          checkpoint: {
            planDigest: view.checkpoint.planDigest,
            sessionBaselineDigest: view.checkpoint.sessionBaselineDigest,
            appliedThroughOrdinal: view.checkpoint.appliedThroughOrdinal,
            updatedAt: view.checkpoint.updatedAt,
            updatedBy: view.checkpoint.updatedBy,
          },
        }
      : {}),
    ...(view.drift !== undefined ? { drift: view.drift } : {}),
    notes: view.plan.notes.map((note) =>
      note.kind === "masked_session_entry"
        ? `masked session entry ${note.commandId} (a task-local add claims it)`
        : note.kind === "orphaned_slot"
          ? `orphaned slot ${note.commandId} — its session key is gone; its operations are inert`
          : note.kind === "duplicate_command"
            ? `duplicate command collapsed into ${note.commandId} (${note.occurrences} occurrences)`
            : note.kind === "colliding_add"
              ? `colliding add of ${note.commandId} in revision ${note.revisionId} materialized no second slot`
              : `ambiguous equivalence between ${note.commandIds[0]} and ${note.commandIds[1]}`,
    ),
    ...(staged !== undefined ? { stagedVerification: staged } : {}),
  };
}

function renderTaskVerificationShow(payload: Record<string, unknown>): string {
  const text = (key: string): string => (payload[key] === undefined ? "" : String(payload[key]));
  const rows = (key: string): Record<string, unknown>[] =>
    Array.isArray(payload[key]) ? (payload[key] as Record<string, unknown>[]) : [];
  const lines: string[] = [];
  lines.push(`task-verification show — issue #${text("issueNumber")} (session ${text("sessionId")})`);
  lines.push(
    `  task: ${text("taskStatus")} / ${text("taskPhase")} — ` +
      (payload.amendable === true
        ? "amendable"
        : `NOT amendable: ${String((payload.amendmentRefusal as Record<string, unknown> | undefined)?.detail ?? "")}`),
  );
  lines.push(
    `  plan digest: ${text("planDigest")} (through revision ordinal ${text("appliedThroughOrdinal")}, ${text("reconciliation")})`,
  );
  const section = (title: string, entries: Record<string, unknown>[], render: (row: Record<string, unknown>) => string): void => {
    lines.push(`  ${title}: ${entries.length}`);
    for (const entry of entries) lines.push(`    - ${render(entry)}`);
  };
  // The payload strings are already redacted, so the renderer only arranges
  // them — it never reaches back to the plan for bytes of its own.
  const slotText = (row: Record<string, unknown>): string =>
    `${String(row.commandId)} [${String(row.state)}] ${String(row.command)} ` +
    `(${String(row.origin)}${row.amended === true ? ", amended" : ""})`;
  section("execution", rows("execution"), (row) => {
    const ordinals = Array.isArray(row.revisionOrdinals) ? (row.revisionOrdinals as number[]) : [];
    return slotText(row) + (ordinals.length > 0 ? ` revisions ${ordinals.join(", ")}` : "");
  });
  section("requirement", rows("requirement"), (row) => `${slotText(row)} — ${String(row.status)}`);
  section("revisions", rows("revisions"), (row) => {
    const kinds = Array.isArray(row.operations) ? (row.operations as string[]) : [];
    return (
      `${String(row.revisionOrdinal)} ${String(row.revisionId)} ${String(row.source)} ` +
      `by ${String(row.actorId)} at ${String(row.createdAt)}: ${kinds.join(", ")} — ${String(row.reason)}`
    );
  });
  const notes = Array.isArray(payload.notes) ? (payload.notes as string[]) : [];
  if (notes.length > 0) {
    lines.push(`  notes: ${notes.length}`);
    for (const note of notes) lines.push(`    - ${note}`);
  }
  if (payload.drift !== undefined) {
    const drift = payload.drift as Record<string, unknown>;
    lines.push(
      `  DRIFT: the session defaults moved since the recorded checkpoint ` +
        `(${String(drift.previousPlanDigest)} -> ${String(drift.planDigest)}). ` +
        `The live plan above is what resolves; the next applying command re-anchors the checkpoint.`,
    );
  }
  lines.push(`  continuation default for this row: ${text("defaultContinuation")}`);
  if (payload.stagedVerification !== undefined) {
    lines.push(...renderTaskVerificationStaged(payload.stagedVerification as StagedVerificationStatusView));
  }
  return lines.join("\n");
}

export async function runTaskVerificationShow(argv: string[]): Promise<void> {
  const parsed = parseTaskVerificationShowArgs(argv);
  if ("error" in parsed) die(parsed.error);
  const { session, verification, clean } = await loadTaskVerificationSession(parsed);

  const store = new SqliteTaskStore(parsed.dbPath);
  // Issue #1166: report the requirement status the lanes gate on, so a
  // requirement the bound suite discharges by the operator's declaration is not
  // shown here as one no configured command covers.
  const fullSuite = fullSuiteRequirementDeclaration(session);
  try {
    const outcome = await describeTaskVerificationPlan(
      { store, extract: extractIssueVerificationSections },
      {
        key: { sessionId: parsed.sessionId, issueNumber: parsed.issueNumber },
        ...(verification !== undefined ? { sessionVerification: verification } : {}),
        ...(fullSuite !== undefined ? { fullSuite } : {}),
      },
    );
    if (outcome.status === "refused") {
      // A read that cannot produce a plan refuses rather than showing a
      // plausible-looking one (§11 rule 6); nothing is repaired.
      const payload = {
        ok: false,
        sessionId: parsed.sessionId,
        issueNumber: parsed.issueNumber,
        outcome: "refused",
        reasonCode: outcome.reason,
        error: clean(outcome.detail),
      };
      report(payload, () =>
        `task-verification show — issue #${parsed.issueNumber} (session ${parsed.sessionId})\n` +
        `  REFUSED (${outcome.reason}): ${clean(outcome.detail)}`,
      );
      process.exitCode = 1;
      return;
    }
    const payload = taskVerificationShowPayload(outcome.view, {
      target: parsed,
      clean,
      ...(session.stagedVerification !== undefined ? { stagedVerification: session.stagedVerification } : {}),
    });
    report(payload, () => renderTaskVerificationShow(payload));
  } finally {
    store.close();
  }
}

// ---------------------------------------------------------------------------
// task-verification amend
// ---------------------------------------------------------------------------

/** One operation clause, open from its operation flag to the next one. */
interface TaskVerificationOperationClause {
  flag: string;
  commandId?: string;
  name?: string;
  command?: string;
  reason?: string;
}

const TASK_VERIFICATION_OPERATION_FLAGS = ["replace", "add-execution", "add-requirement", "retire", "restore", "annotate"] as const;
/** The clauses that take a `--command`; the others refuse one. */
const TASK_VERIFICATION_COMMAND_FLAGS = new Set(["replace", "add-execution", "add-requirement"]);
const TASK_VERIFICATION_CONTINUATIONS: readonly VerificationAmendmentContinuation[] = ["review", "implementation", "none"];

interface TaskVerificationAmendArgs extends TaskVerificationTarget {
  reason: string;
  operations: VerificationAmendmentOperation[];
  requestedContinuation: VerificationAmendmentContinuation | null;
  yes: boolean;
  requestKey: string | undefined;
  expectPlanDigest: string | undefined;
}

/**
 * Parse an `amend` invocation into the §5.2 operation list.
 *
 * The shared tokenizer does the validating — unknown and abbreviated flags are
 * already rejected before this function sees a token (§11 rule 2) — and this
 * function only reads the SEQUENCE it recorded, because the grammar is
 * order-sensitive: `--command` and `--op-reason` bind to the operation flag
 * they follow, an operation flag closes the previous clause, and each of the
 * six operation flags may appear more than once in one revision.
 */
function parseTaskVerificationAmendArgs(argv: string[]): TaskVerificationAmendArgs | { error: string } {
  const tokenized = tokenizeArgs(argv, {
    booleanFlags: ["yes", "add-requirement"],
    valueFlags: [
      "session-id",
      "issue-number",
      "reason",
      "op-reason",
      "continue",
      "expect-plan-digest",
      "request-key",
      "replace",
      "add-execution",
      "retire",
      "restore",
      "annotate",
      "command",
      "sessions-path",
      "db-path",
    ],
  });
  if ("error" in tokenized) return { error: tokenized.error };
  const target = taskVerificationTarget(tokenized.args);
  if ("error" in target) return { error: target.error };

  const reason = tokenized.args["reason"];
  if (reason === undefined || reason.trim() === "") {
    return { error: "--reason is required and must not be empty or whitespace-only" };
  }

  let requestedContinuation: VerificationAmendmentContinuation | null = null;
  if (tokenized.args["continue"] !== undefined) {
    const value = tokenized.args["continue"];
    if (!TASK_VERIFICATION_CONTINUATIONS.includes(value as VerificationAmendmentContinuation)) {
      return {
        error: `--continue must be one of: ${TASK_VERIFICATION_CONTINUATIONS.join(" | ")}, got: ${value}`,
      };
    }
    requestedContinuation = value as VerificationAmendmentContinuation;
  }

  const clauses: TaskVerificationOperationClause[] = [];
  let current: TaskVerificationOperationClause | undefined;
  for (const occurrence of tokenized.occurrences) {
    if ((TASK_VERIFICATION_OPERATION_FLAGS as readonly string[]).includes(occurrence.name)) {
      current = { flag: occurrence.name };
      if (occurrence.name === "add-execution") current.name = occurrence.value;
      else if (occurrence.name !== "add-requirement") current.commandId = occurrence.value;
      clauses.push(current);
      continue;
    }
    if (occurrence.name === "command") {
      if (!current) {
        return { error: "--command must follow an operation flag (--replace, --add-execution, or --add-requirement)" };
      }
      if (!TASK_VERIFICATION_COMMAND_FLAGS.has(current.flag)) {
        return { error: `--command is not accepted by --${current.flag}` };
      }
      if (current.command !== undefined) return { error: `--${current.flag} already carries a --command` };
      // §2: the CLI is an authoring surface, so command bytes are trimmed at
      // the ends here — before the request and revision identities are derived
      // from them — and otherwise passed through verbatim. Interior whitespace
      // is data and stays untouched.
      const command = (occurrence.value ?? "").trim();
      if (command === "") return { error: "--command must not be empty or whitespace-only" };
      current.command = command;
      continue;
    }
    if (occurrence.name === "op-reason") {
      // §11 rule 3: an `--op-reason` binds to the one open operation clause. One
      // that precedes every operation flag, or follows an already-reasoned
      // clause, or is empty, refuses the whole invocation.
      if (!current) {
        return { error: "--op-reason must follow the operation flag it binds to (§11 rule 3)" };
      }
      if (current.reason !== undefined) {
        return { error: `--${current.flag} already carries an --op-reason` };
      }
      if ((occurrence.value ?? "").trim() === "") {
        return { error: "--op-reason must not be empty or whitespace-only" };
      }
      current.reason = occurrence.value;
      continue;
    }
  }

  if (clauses.length === 0) {
    return {
      error:
        "at least one operation is required: --replace <commandId> --command <bytes> | " +
        "--add-execution <name> --command <bytes> | --add-requirement --command <bytes> | " +
        "--retire <commandId> | --restore <commandId> | --annotate <commandId>",
    };
  }

  const operations: VerificationAmendmentOperation[] = [];
  for (const clause of clauses) {
    // §5.2 rule 1: the revision-level `--reason` is the reason of every
    // operation that carries none of its own, materialized onto it here so the
    // persisted operation always states why it happened.
    const operationReason = clause.reason ?? reason;
    if (TASK_VERIFICATION_COMMAND_FLAGS.has(clause.flag) && clause.command === undefined) {
      return { error: `--${clause.flag} requires a following --command <bytes>` };
    }
    if (clause.flag === "replace") {
      operations.push({
        kind: "replace",
        commandId: clause.commandId as string,
        command: clause.command as string,
        reason: operationReason,
      });
    } else if (clause.flag === "add-execution") {
      operations.push({
        kind: "add",
        layer: "execution",
        name: clause.name as string,
        command: clause.command as string,
        reason: operationReason,
      });
    } else if (clause.flag === "add-requirement") {
      operations.push({
        kind: "add",
        layer: "requirement",
        command: clause.command as string,
        reason: operationReason,
      });
    } else {
      operations.push({
        kind: clause.flag as "retire" | "restore" | "annotate",
        commandId: clause.commandId as string,
        reason: operationReason,
      });
    }
  }

  return {
    ...target,
    reason,
    operations,
    requestedContinuation,
    yes: tokenized.flags.has("yes"),
    requestKey: tokenized.args["request-key"],
    expectPlanDigest: tokenized.args["expect-plan-digest"],
  };
}

/** §11 rule 5: only operational refusals exit non-zero. */
function taskVerificationAmendFailed(outcome: TaskVerificationAmendOutcome | TaskVerificationResetOutcome): boolean {
  return outcome.status === "refused" || outcome.status === "stale" || outcome.status === "maintenance_locked";
}

/** How one proposed operation reads in the preview, bytes redacted. */
function taskVerificationOperationLine(
  operation: VerificationAmendmentOperation,
  clean: (text: string) => string,
): string {
  if (operation.kind === "add") {
    return operation.layer === "execution"
      ? `add execution "${operation.name}": ${clean(operation.command)}`
      : `add requirement: ${clean(operation.command)}`;
  }
  if (operation.kind === "replace") {
    return `replace ${operation.commandId}: ${clean(operation.command)}`;
  }
  return `${operation.kind} ${operation.commandId}`;
}

function taskVerificationMutationPayload(
  outcome: TaskVerificationAmendOutcome,
  ctx: { target: TaskVerificationTarget; clean: (text: string) => string },
): Record<string, unknown> {
  const base = {
    sessionId: ctx.target.sessionId,
    issueNumber: ctx.target.issueNumber,
    outcome: outcome.status,
  };
  if (outcome.status === "refused") {
    return { ok: false, ...base, reasonCode: outcome.reason, applied: false, error: ctx.clean(outcome.detail) };
  }
  if (outcome.status === "stale") {
    return {
      ok: false,
      ...base,
      reasonCode: "stale",
      applied: false,
      observedTaskRevision: outcome.observedTaskRevision,
      currentTaskRevision: outcome.currentTaskRevision ?? null,
      observedPlanDigest: outcome.observedPlanDigest,
      currentPlanDigest: outcome.currentPlanDigest ?? null,
      error:
        `the task moved while this amendment was being prepared; nothing was written. ` +
        `Re-read the plan with \`task-verification show\` and re-issue.`,
    };
  }
  if (outcome.status === "maintenance_locked") {
    return {
      ok: false,
      ...base,
      reasonCode: "maintenance_locked",
      applied: false,
      error: "the task store is under maintenance; nothing was written. Retry shortly.",
    };
  }
  if (outcome.status === "replay") {
    return {
      ok: true,
      ...base,
      applied: false,
      revisionId: outcome.revision.revisionId,
      revisionOrdinal: outcome.revision.revisionOrdinal,
      requestKey: outcome.revision.requestKey,
      basePlanDigest: outcome.revision.basePlanDigest,
      planDigest: outcome.revision.planDigest,
    };
  }
  const { report: amendReport, basePlan, plan } = outcome;
  const slotLines = (target: typeof plan): string[] => [
    ...target.execution.map((slot) => taskVerificationSlotLine(slot, ctx.clean)),
    ...target.requirement.map((slot) => taskVerificationSlotLine(slot, ctx.clean)),
  ];
  return {
    ok: true,
    ...base,
    applied: outcome.status === "applied",
    operations: amendReport.operations.map((operation) => taskVerificationOperationLine(operation, ctx.clean)),
    operationKinds: amendReport.operations.map((operation) => operation.kind),
    basePlanDigest: amendReport.basePlanDigest,
    planDigest: amendReport.planDigest,
    currentPlan: slotLines(basePlan),
    resultingPlan: slotLines(plan),
    requestKey: amendReport.requestKey,
    revisionId: amendReport.revisionId,
    continuation: amendReport.continuation,
    requestedContinuation: amendReport.requestedContinuation,
    defaultContinuation: amendReport.defaultContinuation,
    ...(outcome.status === "applied"
      ? {
          revisionOrdinal: outcome.revision.revisionOrdinal,
          // §9.2 (issue #1043): the explicit routing outcome — the re-queue
          // the apply committed, or the statement that the accepted revision
          // was recorded only and the task stays where its row keeps it.
          taskStatus: outcome.task.status,
          taskPhase: outcome.task.phase,
          requeued:
            amendReport.continuation === "none"
              ? null
              : { status: outcome.task.status, phase: outcome.task.phase },
        }
      : {}),
  };
}

function renderTaskVerificationMutation(
  command: string,
  payload: Record<string, unknown>,
  extraSections: Array<{ title: string; entries: readonly string[] }> = [],
  // A reset derives its operations from the plan, so its own success erases the
  // content its request key would be derived from: the apply it suggests names
  // the key explicitly, which is what makes a lost-response retry a §5.3 rule 3
  // replay rather than a stale refusal or a silent `no_change`.
  options: { suggestRequestKey?: boolean } = {},
): string {
  const text = (key: string): string => (payload[key] === undefined ? "" : String(payload[key]));
  const list = (key: string): string[] => (Array.isArray(payload[key]) ? (payload[key] as string[]) : []);
  const outcome = text("outcome");
  const lines: string[] = [
    `${command} — issue #${text("issueNumber")} (session ${text("sessionId")})`,
  ];
  if (outcome === "refused" || outcome === "stale" || outcome === "maintenance_locked") {
    lines.push(`  REFUSED (${text("reasonCode")}): ${text("error")}`);
    lines.push("  Nothing was written; no revision ordinal was consumed.");
    return lines.join("\n");
  }
  if (outcome === "replay") {
    lines.push(
      `  Replay: the request key already names revision ${text("revisionId")} ` +
        `(ordinal ${text("revisionOrdinal")}). Nothing was written.`,
    );
    return lines.join("\n");
  }
  const section = (title: string, entries: readonly string[]): void => {
    lines.push(`  ${title}: ${entries.length}`);
    for (const entry of entries) lines.push(`    - ${entry}`);
  };
  for (const extra of extraSections) section(extra.title, extra.entries);
  if (outcome === "no_change") {
    lines.push(`  plan digest: ${text("planDigest")} (unchanged)`);
    lines.push(`  ${text("message")}`);
    return lines.join("\n");
  }
  section("current plan", list("currentPlan"));
  section("operations", list("operations"));
  section("resulting plan", list("resultingPlan"));
  lines.push(`  plan digest: ${text("basePlanDigest")} -> ${text("planDigest")}`);
  lines.push(`  revision: ${text("revisionId")} (request key ${text("requestKey")})`);
  lines.push(taskVerificationContinuationLine(payload));
  if (outcome === "preview") {
    lines.push(
      `  Preview only. Re-run with --yes --expect-plan-digest ${text("basePlanDigest")}` +
        (options.suggestRequestKey === true ? ` --request-key ${text("requestKey")}` : "") +
        ` to apply exactly this.`,
    );
  } else {
    lines.push(`  Applied as revision ordinal ${text("revisionOrdinal")}.`);
  }
  return lines.join("\n");
}

/**
 * The §9.2 routing line of an amend/reset/refresh report (issue #1043): the
 * continuation taken (or, on a preview, the one `--yes` would take) and the
 * explicit re-queue-or-recorded-only outcome, so an accepted revision whose
 * row withholds the re-queue is never mistaken for a routed one.
 */
function taskVerificationContinuationLine(payload: Record<string, unknown>): string {
  const continuation = String(payload["continuation"] ?? "none");
  const defaultContinuation = String(payload["defaultContinuation"] ?? "none");
  const applied = payload["applied"] === true;
  if (continuation === "none") {
    const detail =
      defaultContinuation === "none"
        ? "the §9.2 row for this task takes no re-queue; it stays where its owning surface put it"
        : "recorded only, by explicit --continue none";
    return applied
      ? `  continuation: none — revision recorded, task not re-queued (${detail})`
      : `  continuation (on --yes): none — the revision would be recorded and the task not re-queued (${detail})`;
  }
  if (applied) {
    const status = String(payload["taskStatus"] ?? "queued");
    const phase = String(payload["taskPhase"] ?? continuation);
    return `  continuation: ${continuation} — task re-queued {${status}, ${phase}}; stale missing-command state cleared, next claim resolves the amended plan`;
  }
  return `  continuation (on --yes): ${continuation} — would re-queue {queued, ${continuation}} in the same transaction that persists the plan`;
}

export async function runTaskVerificationAmend(argv: string[]): Promise<void> {
  const parsed = parseTaskVerificationAmendArgs(argv);
  if ("error" in parsed) die(parsed.error);
  const { session, verification, clean } = await loadTaskVerificationSession(parsed);

  const store = new SqliteTaskStore(parsed.dbPath);
  try {
    const now = new Date().toISOString();
    const outcome = await amendTaskVerification(
      { store, extract: extractIssueVerificationSections },
      {
        key: { sessionId: parsed.sessionId, issueNumber: parsed.issueNumber },
        ...(verification !== undefined ? { sessionVerification: verification } : {}),
        actorId: "admin",
        reason: parsed.reason,
        operations: parsed.operations,
        requestedContinuation: parsed.requestedContinuation,
        apply: parsed.yes,
        requestKey: parsed.requestKey,
        expectedPlanDigest: parsed.expectPlanDigest,
        session,
        runId: `admin-task-verification-amend-${now}`,
        now,
      },
    );
    const payload = taskVerificationMutationPayload(outcome, { target: parsed, clean });
    report(payload, () => renderTaskVerificationMutation("task-verification amend", payload));
    if (taskVerificationAmendFailed(outcome)) process.exitCode = 1;
  } finally {
    store.close();
  }
}

// ---------------------------------------------------------------------------
// task-verification reset
// ---------------------------------------------------------------------------

interface TaskVerificationResetArgs extends TaskVerificationTarget {
  reason: string;
  allowRetire: boolean;
  yes: boolean;
  requestKey: string | undefined;
  expectPlanDigest: string | undefined;
}

function parseTaskVerificationResetArgs(argv: string[]): TaskVerificationResetArgs | { error: string } {
  const tokenized = tokenizeArgs(argv, {
    booleanFlags: ["yes", "allow-retire"],
    valueFlags: [
      "session-id",
      "issue-number",
      "reason",
      "request-key",
      "expect-plan-digest",
      "sessions-path",
      "db-path",
    ],
  });
  if ("error" in tokenized) return { error: tokenized.error };
  const target = taskVerificationTarget(tokenized.args);
  if ("error" in target) return { error: target.error };
  const reason = tokenized.args["reason"];
  if (reason === undefined || reason.trim() === "") {
    return { error: "--reason is required and must not be empty or whitespace-only" };
  }
  return {
    ...target,
    reason,
    allowRetire: tokenized.flags.has("allow-retire"),
    yes: tokenized.flags.has("yes"),
    requestKey: tokenized.args["request-key"],
    expectPlanDigest: tokenized.args["expect-plan-digest"],
  };
}

/** The three reset sections, rendered by identity and bytes. */
function taskVerificationResetSections(
  diff: TaskVerificationResetDiff,
  withheld: readonly { commandId: string }[],
  clean: (text: string) => string,
  allowRetire: boolean,
): Array<{ title: string; entries: string[] }> {
  return [
    { title: "restore", entries: diff.restores.map((entry) => `${entry.commandId} ${clean(entry.command)}`) },
    {
      title: "revert to origin bytes",
      entries: diff.reverts.map(
        (entry) => `${entry.commandId} ${clean(entry.command)} -> ${clean(entry.originCommand)}`,
      ),
    },
    {
      title:
        allowRetire && withheld.length === 0
          ? "retire (task-local additions)"
          : "retire (task-local additions — withheld; pass --allow-retire to apply)",
      entries: diff.retirements.map((entry) => `${entry.commandId} ${clean(entry.command)}`),
    },
  ];
}

export async function runTaskVerificationReset(argv: string[]): Promise<void> {
  const parsed = parseTaskVerificationResetArgs(argv);
  if ("error" in parsed) die(parsed.error);
  const { session, verification, clean } = await loadTaskVerificationSession(parsed);

  const store = new SqliteTaskStore(parsed.dbPath);
  try {
    const now = new Date().toISOString();
    const result = await resetTaskVerification(
      { store, extract: extractIssueVerificationSections },
      {
        key: { sessionId: parsed.sessionId, issueNumber: parsed.issueNumber },
        ...(verification !== undefined ? { sessionVerification: verification } : {}),
        actorId: "admin",
        reason: parsed.reason,
        allowRetire: parsed.allowRetire,
        apply: parsed.yes,
        requestKey: parsed.requestKey,
        expectedPlanDigest: parsed.expectPlanDigest,
        session,
        runId: `admin-task-verification-reset-${now}`,
        now,
      },
    );
    const { outcome } = result;
    const withheld: readonly { commandId: string }[] = result.withheldRetirements ?? [];
    // The reset reports what it read for every outcome that resolved a plan, so
    // the removals it is withholding are visible on a preview, on an apply, and
    // on a no-change alike — never dropped from the output (§8.4).
    const sections =
      result.diff !== undefined
        ? taskVerificationResetSections(result.diff, withheld, clean, parsed.allowRetire)
        : [];
    const resetFields =
      result.diff !== undefined
        ? {
            restores: sections[0].entries,
            reverts: sections[1].entries,
            retirements: sections[2].entries,
            withheldRetirements: withheld.map((entry) => entry.commandId),
          }
        : {};

    const payload: Record<string, unknown> =
      outcome.status === "no_change"
        ? {
            ok: true,
            sessionId: parsed.sessionId,
            issueNumber: parsed.issueNumber,
            outcome: "no_change",
            applied: false,
            planDigest: outcome.planDigest,
            ...resetFields,
            message:
              withheld.length > 0
                ? "Nothing to apply: the only difference is a retirement of a task-local addition, which is withheld without --allow-retire. No revision was recorded."
                : "The effective plan already matches its unamended baseline. No revision was recorded.",
          }
        : { ...taskVerificationMutationPayload(outcome, { target: parsed, clean }), ...resetFields };

    report(payload, () =>
      renderTaskVerificationMutation("task-verification reset", payload, sections, { suggestRequestKey: true }),
    );
    if (outcome.status !== "no_change" && taskVerificationAmendFailed(outcome)) process.exitCode = 1;
  } finally {
    store.close();
  }
}

// ---------------------------------------------------------------------------
// task-verification refresh-from-issue
// ---------------------------------------------------------------------------

/**
 * The resource-oriented entry to the §10 refresh shipped by issue #1041. Same
 * parser, same runner, same outcomes and exit codes — only the reported command
 * name differs, so an operator who found the plan through `task-verification
 * show` never has to switch nouns to correct it from the Issue.
 */
export async function runTaskVerificationRefreshFromIssue(
  argv: string[],
  deps?: { source?: VerificationRefreshIssueSource },
): Promise<void> {
  await runReviewVerificationRefresh(argv, { ...deps, commandName: "task-verification refresh-from-issue" });
}

// ---------------------------------------------------------------------------
// Subcommand: github-app-review-return
//
// Path B in docs/human-review-return-flow.md — the automatic counterpart to the
// operator `human-review-return` fallback. Detects a human CHANGES_REQUESTED
// review on the task's PR and returns the task to implementation fix mode, using
// the review feedback as task.context.reviewFeedback.
//
// This path is ONLY enabled when the session's repo-host provider uses GitHub App
// (identity-separated) auth. Identity separation is what makes it safe: the
// automation (the GitHub App) and human maintainers carry distinct GitHub
// identities, so human reviews can be treated as feedback while the automation's
// own (bot) reviews/comments are ignored. Sessions on the default `gh` auth keep
// using the explicit `human-review-return` fallback instead.
//
// Review text is untrusted regardless of author role: feedback is bounded and
// sanitized via the SAME shared trust boundary as the operator path
// (sanitizeReviewFeedback) before storage, and is NEVER echoed back to the PR —
// only a metadata-only status comment is posted.
// ---------------------------------------------------------------------------

interface GithubAppReviewReturnArgs {
  sessionId: string;
  issueNumber: number;
  sessionsPath: string;
  dbPath: string | undefined;
  dryRun: boolean;
}

function parseGithubAppReviewReturnArgs(argv: string[]): GithubAppReviewReturnArgs | { error: string } {
  const tokenized = tokenizeArgs(argv, {
    booleanFlags: ["dry-run"],
    valueFlags: ["session-id", "issue-number", "sessions-path", "db-path"],
  });
  if ("error" in tokenized) return { error: tokenized.error };
  const { args, flags } = tokenized;
  const dryRun = flags.has("dry-run");

  if (!args["session-id"]) return { error: "--session-id is required" };
  if (args["issue-number"] === undefined) return { error: "--issue-number is required" };

  const n = Number(args["issue-number"]);
  if (!Number.isInteger(n) || n <= 0) {
    return { error: `--issue-number must be a positive integer, got: ${args["issue-number"]}` };
  }

  return {
    sessionId: args["session-id"],
    issueNumber: n,
    sessionsPath: args["sessions-path"] ?? DEFAULT_SESSIONS_PATH,
    dbPath: args["db-path"],
    dryRun,
  };
}

/** The subset of a prior github-app-review requeue's stored metadata used to
 * decide whether a freshly selected review has already been processed. */
interface PriorReviewMeta {
  /** Ids of EVERY review aggregated into the prior requeue. Newer metadata records
   * the full set; older metadata recorded only the representative `reviewId`. */
  reviewIds?: string[];
  reviewId?: string;
  reviewSubmittedAt?: string;
}

/**
 * Read the metadata recorded by the previous github-app-review requeue, if any.
 * Only metadata from this same source is honored — feedback recorded by the
 * operator path (a different `source`) must not suppress an automatic return.
 */
function readPriorGithubAppReviewMeta(task: AiTask): PriorReviewMeta | undefined {
  const meta = task.context["reviewFeedbackMeta"];
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return undefined;
  const m = meta as Record<string, unknown>;
  if (m["source"] !== "github-app-review") return undefined;
  const rawIds = m["reviewIds"];
  const reviewIds = Array.isArray(rawIds)
    ? rawIds.filter((x): x is string => typeof x === "string" && x !== "")
    : undefined;
  return {
    reviewIds: reviewIds && reviewIds.length > 0 ? reviewIds : undefined,
    reviewId: typeof m["reviewId"] === "string" ? m["reviewId"] : undefined,
    reviewSubmittedAt: typeof m["reviewSubmittedAt"] === "string" ? m["reviewSubmittedAt"] : undefined,
  };
}

/**
 * True when the freshly selected feedback was already forwarded by a prior
 * github-app-review requeue. A single CHANGES_REQUESTED review aggregates several
 * reviewers, so dedup must compare the whole SET of contributed review ids, not
 * just the newest representative. When every currently-active review id was part
 * of the prior requeue, all of this feedback was already surfaced — including the
 * case where a newer reviewer has since cleared their request, leaving an older,
 * already-forwarded request as the active one (the set shrinks but stays a
 * subset). A review id absent from the prior set is genuinely new feedback and
 * must requeue. The submit-timestamp comparison is only a fallback for the rare
 * case where an id was unavailable.
 */
function isAlreadyProcessedReview(selection: ReviewFeedbackSelection, prior: PriorReviewMeta): boolean {
  const selected = selection.review!;
  const priorIds = new Set<string>([
    ...(prior.reviewIds ?? []),
    ...(prior.reviewId ? [prior.reviewId] : []),
  ]);
  const currentIds =
    selection.reviewIds && selection.reviewIds.length > 0
      ? selection.reviewIds
      : selected.id
        ? [selected.id]
        : [];

  // Id-based dedup is authoritative when we have non-empty ids on both sides: the
  // selection is already processed iff EVERY currently-active review id was part of
  // the prior requeue. Two distinct ids are two distinct reviews, so the timestamp
  // fallback must not run and suppress a still-active request that was never
  // processed.
  if (priorIds.size > 0 && currentIds.length > 0 && currentIds.every((id) => id !== "")) {
    return currentIds.every((id) => priorIds.has(id));
  }

  if (prior.reviewSubmittedAt && selected.submittedAt) {
    const priorTs = Date.parse(prior.reviewSubmittedAt);
    const selTs = Date.parse(selected.submittedAt);
    if (!Number.isNaN(priorTs) && !Number.isNaN(selTs) && selTs <= priorTs) return true;
  }
  return false;
}

export async function runGithubAppReviewReturn(
  argv: string[],
  reader?: PrReviewReader,
  authDeps: GhRunnerAuthDeps = {},
): Promise<void> {
  const parsed = parseGithubAppReviewReturnArgs(argv);
  if ("error" in parsed) die(parsed.error);

  const { sessionId, issueNumber, sessionsPath, dbPath, dryRun } = parsed;

  let registry: JsonSessionRegistry;
  try {
    registry = new JsonSessionRegistry(sessionsPath);
  } catch (err) {
    die(`Failed to load sessions file (${sessionsPath}): ${err instanceof Error ? err.message : String(err)}`);
  }

  const session = await registry.getSessionById(sessionId);
  if (!session) {
    die(describeUnresolvedSessionId(registry, sessionId, sessionsPath));
  }

  // Gate: only identity-separated (GitHub App) repo-host providers may use this
  // automatic path. Sessions on the default `gh` auth keep the explicit
  // human-review-return fallback so the AI actor's own comments can never be
  // mistaken for human feedback.
  if (session.repoHostProvider.auth.mode !== "github-app") {
    die(
      `github-app-review-return requires a GitHub App (identity-separated) repo-host provider, ` +
        `but session "${sessionId}" uses auth mode "${session.repoHostProvider.auth.mode}". ` +
        `Use "human-review-return" instead, or configure repoHostProvider.auth.mode = "github-app".`,
    );
  }

  const store = new SqliteTaskStore(dbPath);
  const outboxStore = new SqliteOutboxStore(dbPath);
  try {
    const task = await store.getTask({ sessionId, issueNumber });
    if (!task) {
      die(`Task not found: session "${sessionId}", issue #${issueNumber}`);
    }

    if (task.status === "claimed" || task.status === "running") {
      die(
        `Task #${issueNumber} in session "${sessionId}" is currently ${task.status}` +
          (task.ownerRunId ? ` (owner: ${task.ownerRunId})` : "") +
          `. Refusing to return an active task to fix mode. Wait for it to complete or recover it first.`,
      );
    }

    // Resolve the PR selector: prefer the PR number from a recorded prUrl, then a
    // recorded branch, then the conventional head branch.
    const { prUrl: ctxPrUrl, branch } = resolvePrContext(task);
    const prNumberFromUrl = ctxPrUrl ? ctxPrUrl.match(/\/pull\/(\d+)/)?.[1] : undefined;
    const selector = prNumberFromUrl ?? branch ?? branchName(issueNumber);

    // Resolve the PR-review reader. Tests inject a fake reader; production resolves
    // the same configured GitHub App `GhRunner` the rest of the repo-host
    // operations use (via resolveGhRunner) so the read runs under the App
    // installation token and not an unrelated operator `gh` identity (or no `gh`
    // auth at all in an App-only deployment). Resolution is deferred to here — past
    // the task-existence and active-claim early exits — so a run that bails before
    // reading a PR does not needlessly exchange a GitHub App token.
    let effectiveReader: PrReviewReader;
    if (reader) {
      effectiveReader = reader;
    } else {
      try {
        const runner = await resolveGhRunner(session.repoHostProvider.auth, defaultGhRunner, authDeps);
        effectiveReader = prReviewReaderFromGhRunner(runner);
      } catch (err) {
        die(
          `Failed to resolve GitHub App auth for review reads: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    let reviewData;
    try {
      reviewData = effectiveReader.readPrReviews(session.githubRepo, selector);
    } catch (err) {
      die(
        `Failed to read PR reviews for ${session.githubRepo} (selector "${selector}"): ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const selection: ReviewFeedbackSelection = selectChangesRequestedFeedback(
      reviewData.reviews,
      reviewData.comments,
    );

    // No qualifying human CHANGES_REQUESTED review (approvals, comment-only, bot
    // reviews, or superseded change requests) → do NOT requeue. This is a normal
    // poll outcome, not an error, so exit 0 with a clear reason.
    if (!selection.found) {
      emit({
        ok: true,
        requeued: false,
        sessionId,
        issueNumber,
        prNumber: reviewData.prNumber,
        reason: selection.reason,
      });
      return;
    }

    // Skip a review we have already processed. GitHub keeps reporting the same
    // CHANGES_REQUESTED review as the reviewer's latest active state until they
    // submit a newer review, so after a fix cycle returns the task to
    // ready_for_human a re-poll would otherwise requeue the identical stale review
    // — duplicating comments and risking an endless fix loop. The prior requeue
    // recorded the review's id/timestamp in task.context.reviewFeedbackMeta;
    // ignore any selection that does not advance past it.
    const priorMeta = readPriorGithubAppReviewMeta(task);
    if (priorMeta && isAlreadyProcessedReview(selection, priorMeta)) {
      emit({
        ok: true,
        requeued: false,
        sessionId,
        issueNumber,
        prNumber: reviewData.prNumber,
        reviewId: selection.review!.id || null,
        reason:
          "Latest human CHANGES_REQUESTED review was already processed (same review as the prior return); nothing was requeued.",
      });
      return;
    }

    // Bound + sanitize + harden the untrusted review text via the shared trust
    // boundary (identical to the operator path).
    const { text: sanitizedFeedback, truncated: feedbackTruncated } = sanitizeReviewFeedback(
      selection.feedback ?? "",
      [session.repoRoot, session.artifactRoot],
    );
    if (sanitizedFeedback.length === 0) {
      emit({
        ok: true,
        requeued: false,
        sessionId,
        issueNumber,
        prNumber: reviewData.prNumber,
        reason: "Review feedback was empty after sanitization; nothing was requeued.",
      });
      return;
    }

    const review = selection.review!;
    const now = new Date().toISOString();
    const resolvedBranch = branch ?? branchName(issueNumber);
    const effectivePrUrl = ctxPrUrl ?? (reviewData.prUrl || undefined);

    if (dryRun) {
      emit({
        ok: true,
        dryRun: true,
        requeued: false,
        sessionId,
        issueNumber,
        prNumber: reviewData.prNumber,
        previousStatus: task.status,
        previousPhase: task.phase,
        wouldRequeue: { status: "queued", phase: "implementation" },
        reviewFeedbackSource: "github-app-review",
        feedbackChars: sanitizedFeedback.length,
        feedbackTruncated,
        reviewCount: selection.reviewCount ?? 1,
        inlineComments: selection.inlineCommentCount ?? 0,
        reviewAuthor: review.author,
        reviewUrl: review.url ?? null,
        branch: resolvedBranch,
      });
      return;
    }

    const runId = `admin-github-app-review-return-${now}`;

    // Record the discovered PR url when the task did not already carry one, so the
    // fix run keeps the PR association.
    const taskForRequeue: AiTask =
      ctxPrUrl === undefined && effectivePrUrl !== undefined
        ? { ...task, context: { ...task.context, prUrl: effectivePrUrl } }
        : task;

    // Public status comment: metadata ONLY. The review feedback content is
    // forwarded to the fix agent privately via task context and is never echoed
    // back to the PR thread by the automation (the review itself is already on the
    // PR under the human's identity; the bot must not re-post it).
    //
    // Built BEFORE the requeue and committed with it (issue #818 review
    // follow-up), for the same reason as the operator path above: a separate
    // enqueue can be refused after the task has already left `ready_for_human`,
    // and the announcement is then unrecoverable.
    const reviewCount = selection.reviewCount ?? 1;
    const otherReviewers = reviewCount - 1;
    const attribution =
      (review.author ? ` by @${review.author}` : "") +
      (otherReviewers > 0 ? ` and ${otherReviewers} other reviewer${otherReviewers > 1 ? "s" : ""}` : "");
    const commentBody = sanitizeBody(
      `🔧 **Returned to implementation fix mode** after ` +
        (reviewCount > 1 ? `human \`CHANGES_REQUESTED\` reviews` : `a human \`CHANGES_REQUESTED\` review`) +
        attribution +
        `.\n\nThe requested changes are being addressed; see the review${reviewCount > 1 ? "s" : ""} above for details.`,
      sessionRedactionPaths(session),
    );

    const requeue = await enqueueFixModeRequeue({
      store,
      outboxStore,
      session,
      task: taskForRequeue,
      reviewFeedback: sanitizedFeedback,
      reviewFeedbackSource: "github-app-review",
      reviewFeedbackMeta: {
        source: "github-app-review",
        channel: "github-app-review",
        recordedAt: now,
        feedbackChars: sanitizedFeedback.length,
        truncated: feedbackTruncated,
        reviewCount: selection.reviewCount ?? 1,
        inlineComments: selection.inlineCommentCount ?? 0,
        reviewId: review.id || undefined,
        // Record the full aggregated set so a later poll can tell already-forwarded
        // feedback from a genuinely new review even after a reviewer clears theirs.
        reviewIds: selection.reviewIds && selection.reviewIds.length > 0 ? selection.reviewIds : undefined,
        reviewUrl: review.url,
        reviewAuthor: review.author || undefined,
        reviewSubmittedAt: review.submittedAt || undefined,
      },
      now,
      runId,
      statusComment: { body: commentBody, keySuffix: "github-app-review-return" },
    });
    if (!requeue.ok) {
      die(
        `Failed to requeue task: ${requeue.code}` +
          (requeue.current ? ` (current status: ${requeue.current.status})` : "") +
          maintenanceRefusalHint(requeue.code),
      );
    }

    // Audit event — metadata only, no raw feedback or local paths.
    await store.appendEvent({
      task: { sessionId, issueNumber },
      type: "github_app_review_return",
      runId,
      message: `Returned issue #${issueNumber} to implementation fix mode from a human CHANGES_REQUESTED review`,
      data: {
        reviewFeedbackSource: "github-app-review",
        feedbackChars: sanitizedFeedback.length,
        truncated: feedbackTruncated,
        reviewCount: selection.reviewCount ?? 1,
        inlineComments: selection.inlineCommentCount ?? 0,
        prNumber: reviewData.prNumber,
        reviewId: review.id || undefined,
        reviewAuthor: review.author || undefined,
        reviewSubmittedAt: review.submittedAt || undefined,
        previousStatus: task.status,
        previousPhase: task.phase,
        hasPrUrl: effectivePrUrl !== undefined,
        branch: requeue.branch,
      },
      createdAt: now,
    });

    emit({
      ok: true,
      requeued: true,
      sessionId,
      issueNumber,
      prNumber: reviewData.prNumber,
      status: requeue.task.status,
      phase: requeue.task.phase,
      previousStatus: task.status,
      previousPhase: task.phase,
      reviewFeedbackSource: "github-app-review",
      feedbackChars: sanitizedFeedback.length,
      feedbackTruncated,
      reviewCount: selection.reviewCount ?? 1,
      inlineComments: selection.inlineCommentCount ?? 0,
      reviewAuthor: review.author || null,
      reviewUrl: review.url ?? null,
      branch: requeue.branch,
    });
  } finally {
    store.close();
    outboxStore.close();
  }
}

// ---------------------------------------------------------------------------
// Subcommand: tool-request list / resolve
//
// Operator path for the disallowed-command Tool Request handoff (issue #291).
// When an implementation agent needs a command outside its allowed tool set it
// emits a structured Tool Request block and stops; the implementation handler
// hands the task to ready_for_human and stores the structured request under
// task.context.toolRequest. These commands let an operator inspect those
// requests and resolve them — either marking the work manually done (which
// requeues the task to implementation) or rejecting it. The requested command
// is never executed by this tooling.
// ---------------------------------------------------------------------------

interface ToolRequestListArgs {
  sessionId: string;
  issueNumber: number | undefined;
  all: boolean;
  dbPath: string | undefined;
}

function parseToolRequestListArgs(argv: string[]): ToolRequestListArgs | { error: string } {
  const opts = parseCommonOptions(argv, {
    session: "required",
    issueNumber: "optional",
    booleanFlags: ["all"],
  });
  if ("error" in opts) return { error: opts.error };
  return {
    sessionId: opts.sessionId,
    issueNumber: opts.issueNumber,
    all: opts.flags.has("all"),
    dbPath: opts.dbPath,
  };
}

function toolRequestRow(t: { issueNumber: number; status: string; phase: string; context: Record<string, unknown>; updatedAt: string }) {
  const tr = readStoredToolRequest(t) ?? {};
  // Surface the preserved partial-work patch (issue #379) so an operator can
  // actually find it. The handoff snapshots the agent's uncommitted diff to
  // `partial-implementation.patch` inside the run's artifact dir before cleanup;
  // the manual-done refusal recovery tells the operator to reapply it. Without
  // exposing both the artifact filename and the run directory that holds it
  // here, the saved work is not reliably discoverable through the documented
  // CLI path. `artifactDir` is the handoff run's directory recorded in context.
  const partialDiffArtifact =
    typeof tr["partialDiffArtifact"] === "string" ? tr["partialDiffArtifact"] : null;
  const artifactDir = typeof t.context["artifactDir"] === "string" ? t.context["artifactDir"] : null;
  // Issue #390: surface WHY a patch is absent and where the work went, so an
  // operator can tell "no diff was produced" (no patch to look for) apart from
  // "capture failed, the work was preserved on the issue branch instead".
  const noPriorDiff = tr["noPriorDiff"] === true;
  const partialDiffCaptureFailed =
    typeof tr["partialDiffCaptureFailed"] === "string" ? tr["partialDiffCaptureFailed"] : null;
  const preservedBranch =
    typeof tr["preservedBranch"] === "string" ? tr["preservedBranch"] : null;
  const preservedBranchPushed =
    typeof tr["preservedBranchPushed"] === "boolean" ? tr["preservedBranchPushed"] : null;
  return {
    issueNumber: t.issueNumber,
    status: t.status,
    phase: t.phase,
    command: typeof tr["command"] === "string" ? tr["command"] : null,
    displayCommand: typeof tr["displayCommand"] === "string" ? tr["displayCommand"] : null,
    reason: typeof tr["reason"] === "string" ? tr["reason"] : null,
    expectedFiles: Array.isArray(tr["expectedFiles"]) ? tr["expectedFiles"] : [],
    necessity: typeof tr["necessity"] === "string" ? tr["necessity"] : null,
    suggestedAction: typeof tr["suggestedAction"] === "string" ? tr["suggestedAction"] : null,
    requestedBy: typeof tr["requestedBy"] === "string" ? tr["requestedBy"] : null,
    mode: typeof tr["mode"] === "string" ? tr["mode"] : null,
    requestedAt: typeof tr["requestedAt"] === "string" ? tr["requestedAt"] : null,
    resolved: tr["resolved"] === true,
    resolution: (tr["resolution"] && typeof tr["resolution"] === "object") ? tr["resolution"] : null,
    partialDiffArtifact,
    noPriorDiff,
    partialDiffCaptureFailed,
    preservedBranch,
    preservedBranchPushed,
    artifactDir,
    updatedAt: t.updatedAt,
  };
}

async function runToolRequestList(argv: string[]): Promise<void> {
  const parsed = parseToolRequestListArgs(argv);
  if ("error" in parsed) die(parsed.error);

  const { sessionId, issueNumber, all, dbPath } = parsed;

  const store = new SqliteTaskStore(dbPath);
  try {
    const sessionTasks =
      issueNumber !== undefined
        ? await store.getTask({ sessionId, issueNumber }).then((t) => (t ? [t] : []))
        : await store.listSessionTasks(sessionId);
    const candidates = sessionTasks.filter((t) => {
      const tr = readStoredToolRequest(t);
      if (!tr) return false;
      return all || tr["resolved"] !== true;
    });

    emit({
      ok: true,
      sessionId,
      ...(issueNumber !== undefined ? { issueNumber } : {}),
      count: candidates.length,
      toolRequests: candidates.map(toolRequestRow),
    });
  } finally {
    store.close();
  }
}

/**
 * Argv-shaped arguments for `admin tool-request resolve`.
 *
 * Split in two on purpose (issue #1030): {@link ToolRequestResolveArgs.request}
 * is the typed operation request `runToolRequestResolve` takes, and everything
 * beside it is shell-only — where the session file and the database live, plus
 * the preview flag that becomes `OperationContext.confirmed`. None of the
 * shell-only fields is a parameter the core (or any other surface) can set.
 */
interface ToolRequestResolveArgs {
  sessionId: string;
  issueNumber: number;
  request: ToolRequestResolveRequest;
  sessionsPath: string;
  dbPath: string | undefined;
  dryRun: boolean;
}

function parseToolRequestResolveArgs(argv: string[]): ToolRequestResolveArgs | { error: string } {
  const opts = parseCommonOptions(argv, {
    session: "required",
    issueNumber: "required",
    dryRun: true,
    valueFlags: ["action", "message"],
  });
  if ("error" in opts) return { error: opts.error };
  const { args } = opts;

  // The action/message vocabulary is the operation's, not the shell's, so it is
  // checked by the core's own parser — one definition, byte-identical messages
  // on both surfaces (issue #1030).
  const params: Record<string, string> = {};
  if (args["action"] !== undefined) params["action"] = args["action"];
  if (args["message"] !== undefined) params["message"] = args["message"];
  const parsedRequest = parseToolRequestResolveParams(params);
  if ("error" in parsedRequest) return { error: parsedRequest.error };

  return {
    sessionId: opts.sessionId,
    issueNumber: opts.issueNumber!,
    request: parsedRequest.request,
    sessionsPath: opts.sessionsPath,
    dbPath: opts.dbPath,
    dryRun: opts.dryRun,
  };
}

/**
 * Build the injected operation context for one resolution (issue #1030).
 *
 * Everything the core is not allowed to construct for itself — stores, git
 * probes, worktree resolution, the clock, the run id — is assembled by the
 * shared runtime builder (issue #1031), so this surface and ChatOps drive the
 * same core over the same seams. What stays here is the *trusted* half: an
 * `admin-cli` invocation by the shell operator.
 */
function toolRequestResolveContext(options: {
  session: ResolvedSession;
  sessionId: string;
  issueNumber: number;
  confirmed: boolean;
  requestId: string;
  store: ToolRequestResolveTaskPort;
  outboxStore: OutboxStore;
}): ToolRequestResolveContext {
  return toolRequestResolveOperationContext(
    {
      surface: "admin-cli",
      actor: { kind: "human", id: "admin" },
      sessionId: options.sessionId,
      issueNumber: options.issueNumber,
      requestId: options.requestId,
      confirmed: options.confirmed,
      deadlineMs: null,
    },
    {
      session: options.session,
      tasks: options.store,
      outbox: options.outboxStore,
      runIdPrefix: "admin-tool-request-resolve",
    },
  );
}

/**
 * `admin tool-request resolve` — the CLI shell over the callable
 * `tool-request.resolve` core (issue #1030).
 *
 * Argv parsing, session resolution, store construction, rendering and exit-code
 * mapping live here; every business rule lives in `runToolRequestResolve`. A
 * `rejected` or `failed` result becomes the same `die()` message (and the same
 * exit code) the pre-extraction handler printed, and an `executed` result's
 * `data` is the payload it emitted verbatim.
 */
async function runToolRequestResolveCommand(argv: string[]): Promise<void> {
  const parsed = parseToolRequestResolveArgs(argv);
  if ("error" in parsed) die(parsed.error);

  const { sessionId, issueNumber, request, sessionsPath, dbPath, dryRun } = parsed;

  let registry: JsonSessionRegistry;
  try {
    registry = new JsonSessionRegistry(sessionsPath);
  } catch (err) {
    die(`Failed to load sessions file (${sessionsPath}): ${err instanceof Error ? err.message : String(err)}`);
  }

  const session = await registry.getSessionById(sessionId);
  if (!session) {
    die(describeUnresolvedSessionId(registry, sessionId, sessionsPath));
  }

  const store = new SqliteTaskStore(dbPath);
  const outboxStore = new SqliteOutboxStore(dbPath);
  try {
    const result = await runToolRequestResolve({
      request,
      context: toolRequestResolveContext({
        session,
        sessionId,
        issueNumber,
        // Preview is trusted context, not a parameter: `--dry-run` is the CLI
        // spelling of an unconfirmed invocation (contract §5.2).
        confirmed: !dryRun,
        requestId: `admin-cli:${sessionId}:${issueNumber}:tool-request-resolve`,
        store,
        outboxStore,
      }),
    });

    if (result.status === "executed") {
      emit((result.data ?? {}) as Record<string, unknown>);
      return;
    }
    // Both a definite refusal and an indeterminate post-resolution failure are
    // exit-1 operator errors on this surface, exactly as they were when the
    // handler called `die()` in place (the result's `reason`/`effect` split
    // exists for the callers that must decide whether a retry is safe).
    die(result.summary);
  } finally {
    store.close();
    outboxStore.close();
  }
}

// ---------------------------------------------------------------------------
// Subcommand: tool-request grant (issue #301)
//
// A scoped, one-shot grant: the operator approves the orchestrator running ONE
// exact, approved command for a Tool Request handoff, and the command is then
// executed here — handler-owned, OUTSIDE the agent permission surface (the
// command is never added to any agent's allowedTools). This is distinct from
// `manual-done`, which assumes the operator already ran the command.
//
// The grant is tightly scoped (session + issue + phase + repo root + exact
// normalized command hash), exact-command only, one-shot (maxUses, default 1),
// and short-lived (TTL). A clean worktree is required before execution. The
// command runs on the ISSUE BRANCH — the open PR head branch, or ai/issue-<n>
// created from the base branch when no PR exists yet — never on the base branch,
// so dependency/Tool Request side effects can never land on `main` (issue #316).
// On a clean no-op the request is resolved and the task re-queued to
// implementation (mirroring manual-done); when the command produces changes they
// are left on the issue branch for the operator to commit/push there; on a
// non-zero exit the task is left a human handoff and is NOT requeued, so a
// failing granted command never loops silently. The
// command's stdout/stderr/exit code are captured in a local artifact and a task
// event; public comments expose only the redacted command and the outcome.
// ---------------------------------------------------------------------------

/**
 * Argv-shaped arguments for `admin tool-request run` / `grant`.
 *
 * Split in two on purpose (issue #1029): {@link ToolRequestGrantArgs.request} is
 * the typed operation request `runToolRequestRun` takes, and everything beside
 * it is shell-only — where the session file, the database, and the repo lock
 * live, plus the preview flag that becomes `OperationContext.confirmed`. None of
 * the shell-only fields is a parameter the core (or any other surface) can set.
 */
interface ToolRequestGrantArgs {
  sessionId: string;
  issueNumber: number;
  request: ToolRequestRunRequest;
  sessionsPath: string;
  dbPath: string | undefined;
  lockDir: string | undefined;
  dryRun: boolean;
}

function parseToolRequestGrantArgs(argv: string[]): ToolRequestGrantArgs | { error: string } {
  const opts = parseCommonOptions(argv, {
    session: "required",
    issueNumber: "required",
    dryRun: true,
    valueFlags: ["command", "ttl-seconds", "max-uses", "lock-dir", "disposition", "on-changes"],
    booleanFlags: ["confirm-discard", "allow-unexpected"],
  });
  if ("error" in opts) return { error: opts.error };
  const { args } = opts;

  // Default `keep` preserves the pre-redesign behavior (operator handles any
  // produced changes by hand) so existing callers are unaffected; commit/discard
  // are the redesigned operator-guided dispositions (issue #430, redesign §4.3).
  let disposition: GuidedRunDisposition = "keep";
  if (args["disposition"] !== undefined) {
    if (!(GUIDED_RUN_DISPOSITIONS as readonly string[]).includes(args["disposition"])) {
      return {
        error: `--disposition must be one of: ${GUIDED_RUN_DISPOSITIONS.join(", ")}, got: ${args["disposition"]}`,
      };
    }
    disposition = args["disposition"] as GuidedRunDisposition;
  }

  let onChanges: RepoChangeAction | undefined;
  if (args["on-changes"] !== undefined) {
    const parsed = parseRepoChangeAction(args["on-changes"]);
    if (parsed === undefined) {
      return {
        error: `--on-changes must be one of: commit | keep | discard | reject | abort, got: ${args["on-changes"]}`,
      };
    }
    onChanges = parsed;
  }

  let ttlSeconds: number | undefined;
  if (args["ttl-seconds"] !== undefined) {
    const t = Number(args["ttl-seconds"]);
    if (!Number.isFinite(t) || t <= 0) {
      return { error: `--ttl-seconds must be a positive number, got: ${args["ttl-seconds"]}` };
    }
    ttlSeconds = t;
  }

  let maxUses: number | undefined;
  if (args["max-uses"] !== undefined) {
    const m = Number(args["max-uses"]);
    if (!Number.isInteger(m) || m <= 0) {
      return { error: `--max-uses must be a positive integer, got: ${args["max-uses"]}` };
    }
    maxUses = m;
  }

  // Confirmation/opt-in flags are only meaningful alongside the action they
  // guard; reject them otherwise so a stray flag fails fast (issue #419 safety).
  if (opts.flags.has("confirm-discard") && onChanges !== "discard") {
    return { error: "--confirm-discard is only valid with --on-changes discard." };
  }
  if (opts.flags.has("allow-unexpected") && onChanges !== "commit") {
    return { error: "--allow-unexpected is only valid with --on-changes commit." };
  }

  return {
    sessionId: opts.sessionId,
    issueNumber: opts.issueNumber!,
    request: {
      command: args["command"],
      ttlSeconds,
      maxUses,
      disposition,
      onChanges,
      confirmDiscard: opts.flags.has("confirm-discard"),
      allowUnexpected: opts.flags.has("allow-unexpected"),
    },
    sessionsPath: opts.sessionsPath,
    dbPath: opts.dbPath,
    lockDir: args["lock-dir"],
    dryRun: opts.dryRun,
  };
}

/**
 * Build the injected operation context for one guided run (issue #1029).
 *
 * Everything the core is not allowed to construct for itself — stores, the repo
 * lock, command execution, worktree resolution, artifact I/O, the clock — is
 * assembled by the shared runtime builder (issue #1031), so this surface and
 * ChatOps drive the same core over the same seams. What stays here is the
 * *trusted* half: an `admin-cli` invocation by the shell operator.
 */
function toolRequestRunContext(options: {
  session: ResolvedSession;
  sessionId: string;
  issueNumber: number;
  confirmed: boolean;
  requestId: string;
  store: ToolRequestRunTaskPort;
  outboxStore: OutboxStore;
  lockStore: RepoLockStore;
  responseAction: "guided-run" | "grant";
}): ToolRequestRunContext {
  return toolRequestRunOperationContext(
    {
      surface: "admin-cli",
      actor: { kind: "human", id: "admin" },
      sessionId: options.sessionId,
      issueNumber: options.issueNumber,
      requestId: options.requestId,
      confirmed: options.confirmed,
      deadlineMs: null,
    },
    {
      session: options.session,
      tasks: options.store,
      outbox: options.outboxStore,
      repoLock: options.lockStore,
      responseAction: options.responseAction,
      runIdPrefix: "admin-tool-request-grant",
    },
  );
}

/**
 * `admin tool-request run` / `tool-request grant` — the CLI shell over the
 * callable `tool-request.run` core (issue #1029).
 *
 * Argv parsing, session resolution, store construction, rendering and exit-code
 * mapping live here; every business rule lives in `runToolRequestRun`. A
 * `rejected` or `failed` result becomes the same `die()` message (and the same
 * exit code) the pre-extraction handler printed, and an `executed` result's
 * `data` is the payload it emitted verbatim.
 */
async function runToolRequestGrant(argv: string[], surface: "grant" | "run" = "grant"): Promise<void> {
  const parsed = parseToolRequestGrantArgs(argv);
  if ("error" in parsed) die(parsed.error);

  const { sessionId, issueNumber, request, sessionsPath, dbPath, lockDir, dryRun } = parsed;

  // The redesigned operator surface is the "guided run" (`tool-request run`,
  // issue #430); `tool-request grant` is retained as a deprecated alias. The two
  // share one core but tag their operator-response record differently so the
  // continuation prompt reads naturally ("guided-run (changes committed)" vs the
  // legacy "grant"). The grant scope/hash authorization primitive is unchanged.
  const responseAction = surface === "run" ? "guided-run" : "grant";

  let registry: JsonSessionRegistry;
  try {
    registry = new JsonSessionRegistry(sessionsPath);
  } catch (err) {
    die(`Failed to load sessions file (${sessionsPath}): ${err instanceof Error ? err.message : String(err)}`);
  }

  const session = await registry.getSessionById(sessionId);
  if (!session) {
    die(describeUnresolvedSessionId(registry, sessionId, sessionsPath));
  }

  const store = new SqliteTaskStore(dbPath);
  const outboxStore = new SqliteOutboxStore(dbPath);
  const lockStore = new RepoLockStore(lockDir);

  try {
    const result = await runToolRequestRun({
      request,
      context: toolRequestRunContext({
        session,
        sessionId,
        issueNumber,
        // Preview is trusted context, not a parameter: `--dry-run` is the CLI
        // spelling of an unconfirmed invocation (contract §5.2).
        confirmed: !dryRun,
        requestId: `admin-cli:${sessionId}:${issueNumber}:${responseAction}`,
        store,
        outboxStore,
        lockStore,
        responseAction,
      }),
    });

    if (result.status === "executed") {
      emit((result.data ?? {}) as Record<string, unknown>);
      return;
    }
    // Both a definite refusal and an indeterminate post-execution failure are
    // exit-1 operator errors on this surface, exactly as they were when the
    // handler called `die()` in place (the result's `reason`/`effect` split
    // exists for the callers that must decide whether a retry is safe).
    die(result.summary);
  } finally {
    store.close();
    outboxStore.close();
  }
}

// ---------------------------------------------------------------------------
// Subcommand: interventions (issue #588)
// ---------------------------------------------------------------------------

interface InterventionsArgs {
  sessionId: string;
  issueNumber?: number;
  since?: string;
  until?: string;
  dbPath?: string;
}

function parseInterventionsArgs(argv: string[]): InterventionsArgs | { error: string } {
  const tokenized = tokenizeArgs(argv, {
    valueFlags: ["session-id", "issue-number", "since", "until", "db-path"],
  });
  if ("error" in tokenized) return { error: tokenized.error };
  const { args } = tokenized;

  if (!args["session-id"]) return { error: "--session-id is required" };

  let issueNumber: number | undefined;
  if (args["issue-number"] !== undefined) {
    const n = Number(args["issue-number"]);
    if (!Number.isInteger(n) || n <= 0) {
      return { error: `--issue-number must be a positive integer, got: ${args["issue-number"]}` };
    }
    issueNumber = n;
  }

  return {
    sessionId: args["session-id"],
    issueNumber,
    since: args["since"],
    until: args["until"],
    dbPath: args["db-path"],
  };
}

function renderInterventions(
  result: L3AggregationResult,
  mode: OutputMode,
  issueNumber?: number,
): string {
  const lines: string[] = [];

  if (!mode.quiet) {
    const parts = [
      `L3 Interventions — session: ${result.sessionId}`,
      ...(issueNumber !== undefined ? [`issue: #${issueNumber}`] : []),
      ...(result.since ? [`since: ${result.since}`] : []),
      ...(result.until ? [`until: ${result.until}`] : []),
    ];
    lines.push(parts.join("  "));
    lines.push("");
  }

  if (result.total === 0) {
    if (!mode.quiet) lines.push("No observable L3 interventions in this scope.");
  } else {
    if (!mode.quiet) lines.push("By signal:");
    for (const [sig, count] of Object.entries(result.bySignal).sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`  ${sig.padEnd(30)} ${count}`);
    }
    lines.push("");

    if (!mode.quiet) lines.push("By issue:");
    for (const issue of result.byIssue) {
      const sigParts = Object.entries(issue.bySignal)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([s, c]) => `${s}: ${c}`)
        .join(", ");
      lines.push(`  #${issue.issueNumber}  total: ${issue.total}  (${sigParts})`);
    }
    lines.push("");
    lines.push(`Total: ${result.total}`);
  }

  if (!mode.quiet && result.unobservableSignals.length > 0) {
    lines.push("");
    lines.push(
      "Note: the following L3 signal kinds have no SQLite event source (not counted here):",
    );
    lines.push(`  ${result.unobservableSignals.join(", ")}`);
  }

  return lines.join("\n");
}

function runInterventions(argv: string[]): void {
  const parsed = parseInterventionsArgs(argv);
  if ("error" in parsed) die(parsed.error);

  const { sessionId, issueNumber, since, until, dbPath } = parsed;
  const resolvedDbPath = dbPath ?? DEFAULT_DB_PATH;

  // When no explicit --db-path was given and the default file does not exist
  // yet (e.g. no events have been written on a fresh install), return an empty
  // report instead of failing. better-sqlite3 opened with { readonly: true }
  // throws SQLITE_CANTOPEN (not ENOENT), so we must test existence up-front.
  if (!dbPath && !existsSync(resolvedDbPath)) {
    const result: L3AggregationResult = {
      sessionId,
      byIssue: [],
      bySignal: {},
      total: 0,
      unobservableSignals: UNOBSERVABLE_L3_SIGNALS,
    };
    report(result as unknown as Record<string, unknown>, (mode) => renderInterventions(result, mode, issueNumber));
    return;
  }

  let db: Database.Database;
  try {
    db = new Database(resolvedDbPath, { readonly: true });
  } catch (err) {
    die(`Cannot open database at ${resolvedDbPath}: ${(err as Error).message}`);
    return; // unreachable; satisfies control-flow analysis
  }

  try {
    // Read raw (surviving) entries merged with any persisted retention rollup
    // (issue #611, docs/retention-backup-contract.md §6) so counts for a
    // pruned window keep coming from the rollup once the raw rows are gone,
    // rather than silently dropping to zero. Degrades to the raw-only result
    // when no rollup has ever been generated for this session (the merge
    // reader reproduces `aggregateL3Interventions`'s own output exactly in
    // that case).
    const merged = listMergedL3Entries(db, sessionId, { issueNumber });
    const aggregated = aggregateL3EntriesForWindow(merged, sessionId, since, until);
    const result: L3AggregationResult = { ...aggregated, unobservableSignals: UNOBSERVABLE_L3_SIGNALS };
    report(result as unknown as Record<string, unknown>, (mode) => renderInterventions(result, mode, issueNumber));
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Subcommand: backup create / list / restore (issue #611)
// ---------------------------------------------------------------------------

interface BackupCommonArgs {
  dbPath: string;
  backupDir: string;
}

function parseBackupCommonArgs(
  argv: string[],
  extra: { booleanFlags?: readonly string[]; valueFlags?: readonly string[] } = {},
): (BackupCommonArgs & { args: Record<string, string>; flags: Set<string> }) | { error: string } {
  const tokenized = tokenizeArgs(argv, {
    booleanFlags: extra.booleanFlags,
    valueFlags: ["db-path", "backup-dir", ...(extra.valueFlags ?? [])],
  });
  if ("error" in tokenized) return { error: tokenized.error };
  const { args, flags } = tokenized;
  return {
    dbPath: args["db-path"] ?? DEFAULT_DB_PATH,
    backupDir: args["backup-dir"] ?? DEFAULT_BACKUP_DIR,
    args,
    flags,
  };
}

async function runBackupCreate(argv: string[]): Promise<void> {
  const parsed = parseBackupCommonArgs(argv);
  if ("error" in parsed) die(parsed.error);
  const { dbPath, backupDir } = parsed;

  const result = await createBackup(dbPath, backupDir);
  if (!result.ok) {
    emit({ ok: false, dbPath, backupDir, error: result.error });
    process.exitCode = 1;
    return;
  }
  emit({ ok: true, dbPath, backupDir, entry: result.entry, rotatedOut: result.rotatedOut ?? [] });
}

function runBackupList(argv: string[]): void {
  const parsed = parseBackupCommonArgs(argv);
  if ("error" in parsed) die(parsed.error);
  const { dbPath, backupDir } = parsed;
  const entries = listBackups(dbPath, backupDir);
  emit({ ok: true, dbPath, backupDir, entries });
}

async function runBackupRestore(argv: string[]): Promise<void> {
  const parsed = parseBackupCommonArgs(argv, {
    booleanFlags: ["yes"],
    valueFlags: ["id", "artifact-root", "session-id", "sessions-path"],
  });
  if ("error" in parsed) die(parsed.error);
  const { dbPath, backupDir, args, flags } = parsed;
  if (!args["id"]) die("--id is required (see `admin backup list` for available backup ids)");
  const id = args["id"];
  const yes = flags.has("yes");

  // Artifact-reference validation (§8 point 5, issue #611 review) needs an
  // `artifactRoot` to resolve context fields like `artifactDir` against.
  // Accept it directly, or best-effort resolve it from a session id — the
  // same "config may be stale/retired, never hard-fail on it" posture
  // `prune run` already uses. Neither is required: omitting both simply
  // skips the check (surfaced in the report below), matching this command's
  // pre-existing behavior.
  let artifactRoot: string | undefined = args["artifact-root"];
  if (!artifactRoot && args["session-id"]) {
    try {
      const registry = new JsonSessionRegistry(args["sessions-path"] ?? DEFAULT_SESSIONS_PATH);
      const session = await registry.getSessionById(args["session-id"]);
      artifactRoot = session?.artifactRoot;
    } catch {
      artifactRoot = undefined;
    }
  }

  const entry = listBackups(dbPath, backupDir).find((e) => e.id === id);
  if (!entry) {
    emit({ ok: false, dbPath, error: `Unknown backup id "${id}" for ${dbPath}` });
    process.exitCode = 1;
    return;
  }

  if (!yes) {
    emit({
      ok: true,
      dbPath,
      wouldRestore: true,
      entry,
      hint:
        "Re-run with --yes to restore. This replaces the live database; the file it replaces is preserved with a " +
        ".pre-restore-<timestamp> suffix, never deleted.",
    });
    return;
  }

  const holder = `restore:${process.pid}:${new Date().toISOString()}`;
  const acquiredAt = new Date().toISOString();
  let oldLock: SqliteMaintenanceLock | undefined;
  let liveLock: SqliteMaintenanceLock | undefined;
  try {
    if (existsSync(dbPath)) {
      oldLock = new SqliteMaintenanceLock(dbPath);
      const oldLockAdopted = oldLock.adopt(holder);
      if (!oldLockAdopted.ok) {
        const acquired = oldLock.acquire(holder);
        if (!acquired.ok) {
          emit({ ok: false, dbPath, reason: "lock_contended", detail: acquired });
          process.exitCode = 1;
          return;
        }
      }
    } else {
      // Fail closed on a missing live DB (issue #611 review): without this,
      // a worker could create a fresh dbPath (e.g. SqliteTaskStore's
      // constructor) and start writing between this check and restore's
      // final rename, and that write would be silently overwritten when the
      // restored backup lands. Creating the file now — with this
      // invocation's lock already seeded into it — closes that window:
      // `claimNextTask` refuses to claim once the `maintenance_lock` row is
      // present, exactly as it would against a pre-existing live DB. There is
      // nothing to adopt back into an `oldLock` here: this invocation is the
      // sole writer of that row, the stub is about to be superseded by the
      // restored file anyway (preserved, unread, at `preRestorePath`), and
      // `restoreBackup`'s `carryLock` below is what actually matters — the
      // lock this invocation holds on the *live* file after restore.
      const stub = new Database(dbPath);
      try {
        seedMaintenanceLock(stub, holder, acquiredAt);
      } finally {
        stub.close();
      }
    }

    // Carry this invocation's own lock into the replacement file (issue #611
    // review): `restoreBackup` writes `{ holder, acquiredAt }` into the
    // temporary DB before renaming it into place, so the live file never has
    // a moment without this invocation's lock for a worker to race into.
    const result = await restoreBackup(dbPath, id, backupDir, undefined, {
      carryLock: { holder, acquiredAt },
      artifactRoot,
      // A shared database can hold multiple sessions with different
      // artifact roots; `artifactRoot` above only ever resolves to one
      // session's root, so scope the artifact-reference check to that same
      // session rather than validating every row in the database against
      // it (issue #611 review).
      artifactRootSessionId: args["session-id"],
    });
    if (!result.ok) {
      emit({ ok: false, dbPath, error: result.error });
      process.exitCode = 1;
      return;
    }

    // Adopt (never re-acquire) the lock already carried into the now-live
    // restored file. `adopt` only marks it held when the row's holder still
    // matches this invocation's — if something else has since claimed the
    // row, `liveLock` stays undefined and `release()` below is skipped
    // entirely, so a lock this invocation does not own is never deleted.
    liveLock = new SqliteMaintenanceLock(dbPath);
    const adopted = liveLock.adopt(holder);
    if (!adopted.ok) {
      liveLock.close();
      liveLock = undefined;
    }

    emit({
      ok: true,
      dbPath,
      restoredFrom: result.restoredFrom,
      preRestorePath: result.preRestorePath,
      ...(artifactRoot ? { artifactRootChecked: artifactRoot } : { artifactCheckSkipped: true }),
    });
  } finally {
    oldLock?.close();
    liveLock?.release();
    liveLock?.close();
  }
}

// ---------------------------------------------------------------------------
// Subcommand: maintenance preview (issue #611)
// ---------------------------------------------------------------------------

function renderMaintenancePreview(result: PreviewResult, mode: OutputMode): string {
  const lines: string[] = [];
  if (!mode.quiet) lines.push(`Maintenance preview — session: ${result.sessionId}`, "");
  lines.push(`Eligible for prune: ${result.eligible.length}`);
  for (const c of result.eligible.slice(0, 50)) {
    lines.push(`  #${c.issueNumber}  ${c.bucket}  updatedAt: ${c.updatedAt}  age: ${Math.floor(c.ageMs / 86400000)}d`);
  }
  if (result.eligible.length > 50) lines.push(`  ... ${result.eligible.length - 50} more not shown`);
  lines.push("");
  lines.push("Excluded:");
  const excludedEntries = Object.entries(result.excluded);
  if (excludedEntries.length === 0) {
    lines.push("  (none)");
  } else {
    for (const [reason, count] of excludedEntries) lines.push(`  ${reason.padEnd(24)} ${count}`);
  }
  lines.push("");
  lines.push(`Rollup coverage: ${result.rollupCovered ? "ok" : `missing — ${result.rollupCoverageReason}`}`);
  return lines.join("\n");
}

async function runMaintenancePreview(argv: string[]): Promise<void> {
  const parsed = parseCommonOptions(argv, { session: "required", issueNumber: "none" });
  if ("error" in parsed) die(parsed.error);
  const { sessionId, dbPath } = parsed;
  const resolvedDbPath = dbPath ?? DEFAULT_DB_PATH;

  if (!existsSync(resolvedDbPath)) {
    const result: PreviewResult = {
      sessionId,
      now: new Date().toISOString(),
      eligible: [],
      excluded: {},
      rollupCovered: true,
    };
    report(result as unknown as Record<string, unknown>, (mode) => renderMaintenancePreview(result, mode));
    return;
  }

  const store = new SqliteRetentionStore(resolvedDbPath, { readonly: true });
  try {
    const result = store.previewTaskPruneCandidates(sessionId);
    report(result as unknown as Record<string, unknown>, (mode) => renderMaintenancePreview(result, mode));
  } finally {
    store.close();
  }
}

// ---------------------------------------------------------------------------
// Subcommand: archive rollup (issue #611)
// ---------------------------------------------------------------------------

async function runArchiveRollup(argv: string[]): Promise<void> {
  const parsed = parseCommonOptions(argv, { session: "required", issueNumber: "none", valueFlags: ["since"] });
  if ("error" in parsed) die(parsed.error);
  const { sessionId, dbPath, args } = parsed;
  const resolvedDbPath = dbPath ?? DEFAULT_DB_PATH;

  if (!existsSync(resolvedDbPath)) {
    die(`No database found at ${resolvedDbPath} — nothing to archive yet`);
  }

  // issue #611 review: serialize against `prune run --yes` on the same
  // maintenance lock. Without this, a rollup read can observe a partial
  // post-prune view (rows a concurrent prune batch already deleted) yet
  // still record a coverage window claiming to cover all history up to
  // `now` — a later prune batch then trusts that window and deletes rows
  // whose events were never actually captured in any rollup.
  // `skipActivityChecks` because rollup only needs exclusion against
  // another maintenance-lock holder, not the phase/outbox-activity guards
  // that exist to protect `prune`/`restore`'s own destructive work.
  const lock = new SqliteMaintenanceLock(resolvedDbPath);
  const holder = `archive-rollup:${process.pid}:${randomBytes(8).toString("hex")}`;
  const acquired = lock.acquire(holder, new Date().toISOString(), { skipActivityChecks: true });
  if (!acquired.ok) {
    lock.close();
    emit({ ok: false, sessionId, reason: "lock_contended", detail: acquired });
    process.exitCode = 1;
    return;
  }

  const store = new SqliteRetentionStore(resolvedDbPath);
  try {
    const result = store.generateInterventionRollup(sessionId, { since: args["since"] });
    report(result as unknown as Record<string, unknown>, (mode) =>
      mode.quiet
        ? ""
        : [
            `Rollup generated — session: ${sessionId}`,
            `  coverage: [${result.since ?? "-∞"}, ${result.until})`,
            `  entries written: ${result.entriesWritten}`,
          ].join("\n"),
    );
  } finally {
    store.close();
    lock.release();
    lock.close();
  }
}

// ---------------------------------------------------------------------------
// Subcommand: prune run / prune status (issue #611)
// ---------------------------------------------------------------------------

async function runPruneRun(argv: string[]): Promise<void> {
  const parsed = parseCommonOptions(argv, {
    session: "required",
    issueNumber: "none",
    booleanFlags: ["yes"],
    valueFlags: ["backup-dir", "batch-size", "max-backup-age-minutes"],
  });
  if ("error" in parsed) die(parsed.error);
  const { sessionId, sessionsPath, dbPath, args, flags } = parsed;
  const resolvedDbPath = dbPath ?? DEFAULT_DB_PATH;
  const backupDir = args["backup-dir"] ?? DEFAULT_BACKUP_DIR;
  const batchSize = args["batch-size"] !== undefined ? Number(args["batch-size"]) : 200;
  const maxBackupAgeMinutes = args["max-backup-age-minutes"] !== undefined ? Number(args["max-backup-age-minutes"]) : 60;
  const yes = flags.has("yes");

  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    die(`--batch-size must be a positive integer, got: ${args["batch-size"]}`);
  }
  if (!Number.isInteger(maxBackupAgeMinutes) || maxBackupAgeMinutes <= 0) {
    die(`--max-backup-age-minutes must be a positive integer, got: ${args["max-backup-age-minutes"]}`);
  }

  // The session's configured `artifactRoot` is only used for the optional
  // orphaned-artifact cleanup below (§7); unlike commands that operate on
  // live session config, pruning DB rows must not hard-fail just because the
  // session was retired from (or was never in) the registry — the task rows
  // it prunes can outlive a session's config entry (docs/retention-backup-contract.md).
  let session: ResolvedSession | undefined;
  try {
    const registry = new JsonSessionRegistry(sessionsPath);
    session = await registry.getSessionById(sessionId);
  } catch {
    session = undefined;
  }

  if (!existsSync(resolvedDbPath)) {
    emit({ ok: true, sessionId, pruned: false, reason: "no_database" });
    return;
  }

  const previewStore = new SqliteRetentionStore(resolvedDbPath, { readonly: true });
  let preview: PreviewResult;
  try {
    preview = previewStore.previewTaskPruneCandidates(sessionId);
  } finally {
    previewStore.close();
  }

  if (!yes) {
    emit({
      ok: true,
      sessionId,
      wouldPrune: preview.eligible.length > 0,
      eligibleCount: preview.eligible.length,
      excluded: preview.excluded,
      rollupCovered: preview.rollupCovered,
      ...(preview.rollupCoverageReason ? { rollupCoverageReason: preview.rollupCoverageReason } : {}),
      hint:
        "Re-run with --yes to prune. Requires a fresh verified backup (`admin backup create`, within " +
        `${maxBackupAgeMinutes}m by default) and full rollup coverage (\`admin archive rollup\`) first.`,
    });
    return;
  }

  if (preview.eligible.length === 0) {
    emit({ ok: true, sessionId, pruned: false, reason: "no_candidates" });
    return;
  }

  const backups = listBackups(resolvedDbPath, backupDir);
  const maxAgeMs = maxBackupAgeMinutes * 60_000;
  const freshBackup = backups.find((b) => Date.now() - Date.parse(b.createdAt) <= maxAgeMs);
  if (!freshBackup) {
    emit({
      ok: false,
      sessionId,
      reason: "backup_precondition_failed",
      hint: `Run \`admin backup create --db-path ${resolvedDbPath}\` first — no verified backup within the last ${maxBackupAgeMinutes}m.`,
    });
    process.exitCode = 1;
    return;
  }

  // §8: the manifest's `verified: true` only reflects the check performed at
  // creation time — the file itself may since have been deleted or
  // corrupted. Re-verify the chosen backup right now so a prune never
  // proceeds on the strength of a recovery point that `restoreBackup` would
  // actually reject.
  const backupVerify = verifyBackupEntry(freshBackup);
  if (!backupVerify.ok) {
    emit({
      ok: false,
      sessionId,
      reason: "backup_precondition_failed",
      hint: `The most recent backup (${freshBackup.id}) failed re-verification: ${backupVerify.error}. Run \`admin backup create --db-path ${resolvedDbPath}\` again.`,
    });
    process.exitCode = 1;
    return;
  }

  if (!preview.rollupCovered) {
    emit({ ok: false, sessionId, reason: "rollup_coverage_missing", detail: preview.rollupCoverageReason });
    process.exitCode = 1;
    return;
  }

  // §8/issue #611 review: backup creation deliberately never takes the
  // maintenance lock, so without pinning, another process rotating in three
  // new backups for the same dbPath while this run is still deleting batches
  // could rotate `freshBackup` out from under it, leaving no recovery point
  // for rows already deleted before that rotation happened. Pin it now, for
  // the remainder of this run, so ordinary rotation cannot select it no
  // matter how many newer backups are created concurrently.
  //
  // The holder token is unique per invocation (issue #611 review, second
  // pass): two concurrent `prune run --yes` invocations can both select the
  // same fresh backup and both pin it before one of them loses the
  // maintenance-lock race below. Because each holds its own token in
  // `pinnedBy`, the loser's `unpinBackup` in the `finally` below only ever
  // removes its own token — it can never clear the winner's pin out from
  // under a prune that's still in flight.
  const pinHolder = `prune:${process.pid}:${randomBytes(8).toString("hex")}`;
  const pinResult = await pinBackup(resolvedDbPath, freshBackup.id, pinHolder, backupDir);
  if (!pinResult.ok) {
    emit({
      ok: false,
      sessionId,
      reason: "backup_precondition_failed",
      hint: `Could not pin the chosen backup (${freshBackup.id}) for this run: ${pinResult.error}. Run \`admin backup create --db-path ${resolvedDbPath}\` again.`,
    });
    process.exitCode = 1;
    return;
  }

  try {
    const lock = new SqliteMaintenanceLock(resolvedDbPath);
    const acquired = lock.acquire(`prune:${process.pid}:${new Date().toISOString()}`);
    if (!acquired.ok) {
      lock.close();
      emit({ ok: false, sessionId, reason: "lock_contended", detail: acquired });
      process.exitCode = 1;
      return;
    }

    try {
      // issue #611 review: `new SqliteRetentionStore(...)` must itself be
      // inside this `try` — if its constructor throws (schema/DDL or disk
      // error), the `finally` below still releases `lock` rather than
      // leaving the persisted `maintenance_lock` row behind, which would
      // otherwise block every future claim/maintenance run until manual
      // intervention.
      const retentionStore = new SqliteRetentionStore(resolvedDbPath);
      try {
        const result: PruneRunResult = retentionStore.pruneTasks(sessionId, new Date().toISOString(), {
          batchSize,
          artifactRoot: session?.artifactRoot,
          backupId: freshBackup.id,
          retainedBackupIds: backups.map((b) => b.id),
        });
        emit({ ok: result.status !== "rollup_coverage_missing", ...result });
        if (result.status === "rollup_coverage_missing") process.exitCode = 1;
      } finally {
        retentionStore.close();
      }
    } finally {
      lock.release();
      lock.close();
    }
  } finally {
    await unpinBackup(resolvedDbPath, freshBackup.id, pinHolder, backupDir);
  }
}

function runPruneStatus(argv: string[]): void {
  const parsed = parseCommonOptions(argv, { session: "required", issueNumber: "none" });
  if ("error" in parsed) die(parsed.error);
  const { sessionId, dbPath } = parsed;
  const resolvedDbPath = dbPath ?? DEFAULT_DB_PATH;

  if (!existsSync(resolvedDbPath)) {
    emit({ ok: true, sessionId, watermark: null, pendingArtifactDeletions: [] });
    return;
  }

  const store = new SqliteRetentionStore(resolvedDbPath);
  try {
    const watermark = store.getWatermark(sessionId);
    const pendingArtifactDeletions = store.listPendingArtifactDeletions(sessionId);
    emit({ ok: true, sessionId, watermark: watermark ?? null, pendingArtifactDeletions });
  } finally {
    store.close();
  }
}

// ---------------------------------------------------------------------------
// Subcommand: maintenance-lock status / release (issue #817)
//
// Operator recovery for the whole-file maintenance lock (issue #611,
// docs/retention-backup-contract.md §9). A maintenance process killed before
// its `finally`/`close()` path runs leaves `maintenance_lock` populated with
// no live holder able to call `release()` — later task claims and
// maintenance runs then stop indefinitely with no supported recovery path
// short of direct SQLite editing. `status` is a read-only diagnostic (issue
// #817 review: opens the database read-only and never creates the table or
// migrates it, so it can inspect a legacy or filesystem-read-only database
// safely); `release` force-releases the lock, ignoring the recorded holder,
// but reuses the exact activity predicates `SqliteMaintenanceLock.acquire`
// refuses acquisition on (a live claimed/running task phase, a non-stale
// outbox dispatch claim) so it can never clear a lock while the work it
// protects is still genuinely in flight — and also stays read-only until
// `--yes` is actually given. Passing those two predicates is never, by
// itself, sufficient evidence a holder has actually finished (P1 review
// follow-up): `prune`/`restore` do their own destructive work — a delete
// batch, a file rename — without ever creating a task lease or outbox claim
// for it, so a live one of either always shows zero of both, indistinguishable
// from a genuinely stranded lock (exactly like a `skipActivityChecks` holder,
// e.g. `admin archive rollup`, always does regardless of whether it is still
// running). `release` therefore refuses *any* held lock unless
// `--confirm-stranded` is also given — an explicit operator confirmation, not
// a liveness check this command performs itself. Deliberately no TTL-based
// auto-recovery and no PID-liveness check — either would let a still-running
// maintenance process's lock be pulled out from under it; this is an
// explicit, guarded operator action only, previewed by default and applied
// only with --yes --confirm-stranded. Output never carries the local
// `dbPath`: the holder token (e.g. `prune:<pid>:<timestamp>`) identifies a
// process/run, not a filesystem path.
// ---------------------------------------------------------------------------

function formatLockAgeMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

interface MaintenanceLockStatusResult {
  ok: true;
  sessionId: string;
  held: boolean;
  holder?: string;
  acquiredAt?: string;
  ageMs?: number;
  activityExempt?: boolean;
  phaseActiveCount: number;
  outboxClaimActiveCount: number;
}

function renderMaintenanceLockStatus(result: MaintenanceLockStatusResult, mode: OutputMode): string {
  const lines: string[] = [];
  if (!mode.quiet) lines.push("Maintenance lock status", "");
  if (result.held) {
    lines.push("Held: yes");
    lines.push(`  holder:      ${result.holder}`);
    lines.push(`  acquiredAt:  ${result.acquiredAt}`);
    lines.push(`  age:         ${formatLockAgeMs(result.ageMs ?? 0)}`);
    if (result.activityExempt) {
      lines.push(
        "  activityExempt: yes — acquired via skipActivityChecks (e.g. `admin archive rollup`); the two " +
          "counts below are not evidence this lock is stranded for this holder.",
      );
    }
  } else {
    lines.push("Held: no");
  }
  lines.push("");
  lines.push(`Live task phases:        ${result.phaseActiveCount}`);
  lines.push(`Non-stale outbox claims: ${result.outboxClaimActiveCount}`);
  return lines.join("\n");
}

function runMaintenanceLockStatus(argv: string[]): void {
  const parsed = parseCommonOptions(argv, { session: "required", issueNumber: "none" });
  if ("error" in parsed) die(parsed.error);
  const { sessionId, dbPath } = parsed;
  const resolvedDbPath = dbPath ?? DEFAULT_DB_PATH;

  if (!existsSync(resolvedDbPath)) {
    const result: MaintenanceLockStatusResult = {
      ok: true,
      sessionId,
      held: false,
      phaseActiveCount: 0,
      outboxClaimActiveCount: 0,
    };
    report(result as unknown as Record<string, unknown>, (mode) => renderMaintenanceLockStatus(result, mode));
    return;
  }

  // Read-only (issue #817 review): `status` must never create the
  // `maintenance_lock` table or run any migration, so it can inspect a
  // legacy database or a filesystem-read-only backup without mutating or
  // failing against either.
  const lock = new SqliteMaintenanceLock(resolvedDbPath, { readonly: true });
  try {
    const status = lock.status();
    const ageMs =
      status.held && status.acquiredAt ? Date.parse(status.now) - Date.parse(status.acquiredAt) : undefined;
    const result: MaintenanceLockStatusResult = {
      ok: true,
      sessionId,
      held: status.held,
      ...(status.held
        ? { holder: status.holder, acquiredAt: status.acquiredAt, ageMs, activityExempt: status.activityExempt }
        : {}),
      phaseActiveCount: status.phaseActiveCount,
      outboxClaimActiveCount: status.outboxClaimActiveCount,
    };
    report(result as unknown as Record<string, unknown>, (mode) => renderMaintenanceLockStatus(result, mode));
  } finally {
    lock.close();
  }
}

function renderMaintenanceLockRelease(result: Record<string, unknown>, _mode: OutputMode): string {
  const reason = result.reason as string | undefined;
  if (reason === "no_database") return "No database found — nothing to release.";
  if (reason === "not_held") return "No maintenance lock is held; nothing to release.";
  if (reason === "phase_active") {
    return `Refused: ${result.activeCount} task phase(s) still claimed/running with an unexpired lease.`;
  }
  if (reason === "outbox_claim_active") {
    return `Refused: ${result.activeCount} outbox dispatch claim(s) are not yet stale.`;
  }
  if (reason === "confirmation_required") {
    const exemptNote = result.activityExempt ? ", acquired via skipActivityChecks (e.g. `admin archive rollup`)" : "";
    return (
      `Refused: held by ${result.holder}${exemptNote} (acquired ${result.acquiredAt}) — a zero live-phase/` +
      `outbox count is not evidence this lock is stranded (prune/restore/archive rollup do their own ` +
      `destructive work without ever registering a task phase or outbox claim for it). Re-run with --yes ` +
      `--confirm-stranded only after confirming out-of-band that no such process is still running against ` +
      `this database.`
    );
  }
  if (result.wouldRelease !== undefined) {
    if (result.wouldRelease) {
      const exemptNote = result.activityExempt ? ", acquired via skipActivityChecks (e.g. `admin archive rollup`)" : "";
      return (
        `Would refuse to release without --confirm-stranded — held by ${result.holder}${exemptNote} (acquired ` +
        `${result.acquiredAt}). No live task phase or non-stale outbox claim, but that alone is not evidence ` +
        `this holder has finished. Re-run with --yes --confirm-stranded only after confirming out-of-band that ` +
        `no such process is still running against this database.`
      );
    }
    return (
      `Would refuse to release — held by ${result.holder} (acquired ${result.acquiredAt}): ` +
      `${result.phaseActiveCount} live task phase(s), ${result.outboxClaimActiveCount} non-stale outbox ` +
      `claim(s). Re-run once those clear.`
    );
  }
  return `Released lock held by ${result.holder} (acquired ${result.acquiredAt}).`;
}

async function runMaintenanceLockRelease(argv: string[]): Promise<void> {
  const parsed = parseCommonOptions(argv, {
    session: "required",
    issueNumber: "none",
    booleanFlags: ["yes", "confirm-stranded"],
  });
  if ("error" in parsed) die(parsed.error);
  const { sessionId, dbPath, flags } = parsed;
  const resolvedDbPath = dbPath ?? DEFAULT_DB_PATH;
  const yes = flags.has("yes");
  const confirmStranded = flags.has("confirm-stranded");

  if (!existsSync(resolvedDbPath)) {
    const result = { ok: true, sessionId, released: false, reason: "no_database" };
    report(result, (mode) => renderMaintenanceLockRelease(result, mode));
    return;
  }

  // Read-only until a release is actually attempted (issue #817 review):
  // preview (`!yes`) must never create the `maintenance_lock` table or run
  // any migration, so it can inspect a legacy database or a filesystem-
  // read-only backup without mutating or failing against either. `--yes`
  // itself is already a mutating request, so it opens normally.
  const lock = new SqliteMaintenanceLock(resolvedDbPath, { readonly: !yes });
  try {
    const now = new Date().toISOString();
    const before = lock.status(now);
    if (!before.held) {
      const result = { ok: true, sessionId, released: false, reason: "not_held" };
      report(result, (mode) => renderMaintenanceLockRelease(result, mode));
      return;
    }

    if (!yes) {
      const wouldRelease = before.phaseActiveCount === 0 && before.outboxClaimActiveCount === 0;
      const result = {
        ok: true,
        sessionId,
        wouldRelease,
        holder: before.holder,
        acquiredAt: before.acquiredAt,
        activityExempt: before.activityExempt,
        phaseActiveCount: before.phaseActiveCount,
        outboxClaimActiveCount: before.outboxClaimActiveCount,
        hint: wouldRelease
          ? "No live task phase or non-stale outbox claim, but that alone is not evidence this holder has " +
            "finished (prune/restore/archive rollup do their own destructive work without ever registering a " +
            "task phase or outbox claim for it). Re-run with --yes --confirm-stranded only after confirming " +
            "out-of-band that no such process is still running against this database."
          : "Refusing: a live task phase or non-stale outbox claim still exists. Re-run once those clear.",
      };
      report(result, (mode) => renderMaintenanceLockRelease(result, mode));
      return;
    }

    const forceResult = lock.forceRelease(now, { confirmStranded });
    if (!forceResult.ok) {
      const result =
        forceResult.reason === "confirmation_required"
          ? {
              ok: false,
              sessionId,
              reason: forceResult.reason,
              holder: forceResult.holder,
              acquiredAt: forceResult.acquiredAt,
              activityExempt: forceResult.activityExempt,
            }
          : { ok: false, sessionId, reason: forceResult.reason, activeCount: forceResult.activeCount };
      report(result, (mode) => renderMaintenanceLockRelease(result, mode));
      process.exitCode = 1;
      return;
    }

    if (!forceResult.released) {
      // A race between the `before.held` check above and this call — another
      // process released it in between. Report it the same way as the
      // up-front not_held check: a safe no-op, not an error.
      const result = { ok: true, sessionId, released: false, reason: "not_held" };
      report(result, (mode) => renderMaintenanceLockRelease(result, mode));
      return;
    }

    const result = { ok: true, sessionId, released: true, holder: forceResult.holder, acquiredAt: forceResult.acquiredAt };
    report(result, (mode) => renderMaintenanceLockRelease(result, mode));
  } finally {
    lock.close();
  }
}

// ---------------------------------------------------------------------------
// Subcommand: n8n deploy (issue #822)
//
// One supported command for getting the generated workflows into a local n8n:
// generate the artifacts, import the shared child, import this session's
// parent, verify, and — only when explicitly asked — publish.
//
// Everything decision-shaped (step order, verification rules, publish policy)
// is pure and lives in core/n8n-deploy.ts. This layer resolves the local facts
// and supplies the side effects, so the whole command is exercisable against a
// fake runner without an n8n installation.
// ---------------------------------------------------------------------------

/** Generator script, relative to the control-plane install root. */
const WORKFLOW_GENERATOR_SCRIPT = "scripts/build-parent-child-workflow.mjs";

/**
 * The parts of `scripts/build-parent-child-workflow.mjs` this command consumes.
 *
 * The derived parent identity and the shared child's ID/name/filename are read
 * from the generator itself rather than re-derived here: they are the contract
 * between what is generated and what is imported, and a second implementation
 * of the sha256/slug derivation would eventually disagree with the first.
 */
interface WorkflowGeneratorModule {
  CHILD_WORKFLOW_ID: string;
  CHILD_WORKFLOW_NAME: string;
  CHILD_ARTIFACT_FILE_NAME: string;
  LOCAL_WORKFLOW_ARTIFACT_DIR: string;
  deriveParentWorkflowId(sessionId: string): string;
  deriveParentWorkflowName(sessionId: string): string;
  parentArtifactFileName(sessionId: string): string;
}

/** Control-plane install root — the tree holding `dist/` and `scripts/`. */
function n8nInstallRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/**
 * Load the workflow generator module. Importing it is side-effect free: its own
 * CLI entrypoint is guarded by an `import.meta.url === process.argv[1]` check,
 * so nothing is written by the import itself.
 *
 * Error messages name the script by its relative path only — an absolute one
 * would be redacted by the output sanitizer anyway, and the relative path is
 * what actually tells an operator which file is missing.
 */
async function loadWorkflowGenerator(installRoot: string): Promise<WorkflowGeneratorModule> {
  const scriptPath = join(installRoot, WORKFLOW_GENERATOR_SCRIPT);
  if (!existsSync(scriptPath)) {
    die(
      `${WORKFLOW_GENERATOR_SCRIPT} is missing from this install. ` +
        "`admin n8n deploy` generates the deployment artifacts itself, so it must run from a " +
        "full control-plane checkout.",
    );
  }
  try {
    return (await import(pathToFileURL(scriptPath).href)) as WorkflowGeneratorModule;
  } catch (err) {
    die(
      `Cannot load ${WORKFLOW_GENERATOR_SCRIPT}: ` +
        sanitizeDeployText(err instanceof Error ? err.message : String(err), [installRoot]),
    );
  }
}

/**
 * Derive this session's parent workflow identity through the generator.
 *
 * `sessions.json` accepts any non-empty sessionId, but a few values (an empty
 * or control-character-bearing one) cannot survive the trip into a workflow ID
 * or an argv entry, and the generator refuses them. Failing here says so with
 * the session named, rather than letting the generation subprocess fail later
 * with the same message buried in its stderr.
 */
function deriveParentWorkflowIdentity(
  generator: WorkflowGeneratorModule,
  sessionId: string,
  artifactDir: string,
  installRoot: string,
): { workflowId: string; workflowName: string; artifactPath: string; artifactFile: string } {
  try {
    const artifactFile = generator.parentArtifactFileName(sessionId);
    return {
      workflowId: generator.deriveParentWorkflowId(sessionId),
      workflowName: generator.deriveParentWorkflowName(sessionId),
      artifactPath: join(artifactDir, artifactFile),
      artifactFile,
    };
  } catch (err) {
    die(
      `Cannot derive a parent workflow identity for session ${JSON.stringify(sessionId)}: ` +
        sanitizeDeployText(err instanceof Error ? err.message : String(err), [installRoot]),
    );
  }
}

/**
 * Backoff before re-attempting a deploy step the OS refused to spawn. Shared
 * with `probe()` (see {@link TRANSIENT_SPAWN_RETRY_BACKOFF_MS}) because both
 * wait on the same host condition and must not give up on it at different
 * points.
 */
const N8N_DEPLOY_SPAWN_RETRY_BACKOFF_MS = TRANSIENT_SPAWN_RETRY_BACKOFF_MS;

/**
 * Start one planned command once. No shell is involved: `file` and `args` are
 * passed to `spawnSync` separately, so a path or project ID containing a space
 * or a shell metacharacter is one argument and stays one argument.
 */
function spawnN8nDeployCommand(command: N8nDeployCommand) {
  return spawnSync(command.file, command.args, {
    cwd: command.cwd,
    env: command.env === undefined ? process.env : { ...process.env, ...command.env },
    encoding: "utf8",
    timeout: command.timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
  });
}

/**
 * True when the OS refused to create the process for a reason that is about the
 * HOST rather than this deploy — it ran out of process slots, descriptors, or
 * memory. A loaded machine fails this identically whether the step would have
 * succeeded or not, so reading it as a failed step sends the operator to debug a
 * generator or an n8n install that was never reached. `probe()` draws the same
 * line for CLI availability (issue #897) and shares the errno set.
 *
 * Requires the never-started shape (an error with neither an exit code nor a
 * signal), which is also what makes a retry safe: the child wrote nothing, so
 * re-running it cannot double an import or an activation.
 */
function isTransientN8nDeploySpawnRefusal(result: ReturnType<typeof spawnN8nDeployCommand>): boolean {
  if (result.error === undefined || result.status !== null || result.signal !== null) return false;
  const code = (result.error as NodeJS.ErrnoException).code;
  return code !== undefined && TRANSIENT_SPAWN_ERROR_CODES.has(code);
}

/** Run one planned command, tolerating a host that could not fork right now. */
function runN8nDeployCommand(command: N8nDeployCommand) {
  let result = spawnN8nDeployCommand(command);
  for (
    let attempt = 0;
    attempt < N8N_DEPLOY_SPAWN_RETRY_BACKOFF_MS.length && isTransientN8nDeploySpawnRefusal(result);
    attempt += 1
  ) {
    sleepSync(N8N_DEPLOY_SPAWN_RETRY_BACKOFF_MS[attempt]);
    result = spawnN8nDeployCommand(command);
  }
  // Node reports an exit code for every process that ran and a signal for every
  // process it killed (the timeout above). A spawn that failed outright — no
  // such binary, or one that could not be executed — is the only case with an
  // error and neither of those, so it is the only case treated as "never
  // started". Anything less clear-cut counts as started, which is the
  // conservative answer: it can only over-report the restart requirement, never
  // hide a write. The distinction cannot be read off the exit code, which this
  // function reports as -1 either way.
  const started = !(result.error !== undefined && result.status === null && result.signal === null);
  if (result.error) {
    // Could not be started (missing binary), was killed (timeout), or blew the
    // output buffer. A negative status distinguishes it from a command that ran
    // and reported a failure — and is forced even when the child did exit with a
    // code, because an errored spawn is a failed step whatever that code says;
    // the captured streams are not meaningful in this case either.
    return { status: -1, stdout: "", stderr: result.error.message, started };
  }
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr, started };
}

/**
 * Take one of a deploy's two locks (see `src/core/n8n-deploy.ts`).
 *
 * The per-parent scope is held for the whole apply: the activation the deploy
 * restores after its import is read *before* it, so the two must not interleave
 * with another deploy of the same parent — a `--publish` run landing between a
 * plain run's check and its import would be silently undone by that run's
 * `active: false` artifact. The child scope is install-wide and held only across
 * generation and the child import, which write and then read the one artifact
 * every session's deploy shares.
 *
 * Both use the same on-disk lock store as the repo/worktree locks, with a TTL cut
 * to the length of a deploy plus its overhead margin, since a crashed one must
 * not hold the session — or, for the child, the whole install — hostage for the
 * store's default day. The child's window is the shorter of the two, so the same
 * TTL is simply the conservative bound for it.
 */
function acquireN8nDeployLock(
  scope: string,
  lockDir: string | undefined,
): N8nDeployLockAcquisition {
  const store = new RepoLockStore(lockDir, N8N_DEPLOY_LOCK_STALE_TTL_MS);
  const ownerId = `n8n-deploy-${process.pid}`;
  const acquired = store.acquire(ownerId, scope);
  if (!acquired.locked) {
    return {
      acquired: false,
      detail:
        `held by ${acquired.ownerContextId} since ${acquired.ownerStartedAt} — ` +
        "wait for that deploy to finish, then re-run",
    };
  }
  return {
    acquired: true,
    release: () => {
      try {
        store.release(ownerId, scope);
      } catch {
        // A lock file that went missing or corrupt under us must not replace the
        // deployment's own report with a release error; the TTL clears it.
      }
    },
  };
}

function renderN8nDeployWorkflows(plan: N8nDeployPlan): string[] {
  const lines = [
    "Workflows:",
    `  child   ${plan.child.workflowId}  "${plan.child.workflowName}"  (${plan.child.artifactFile})`,
    `  parent  ${plan.parent.workflowId}  "${plan.parent.workflowName}"  (${plan.parent.artifactFile})`,
  ];
  if (plan.projectId !== undefined) lines.push(`  project ${plan.projectId}`);
  return lines;
}

function renderN8nDeployPreview(plan: N8nDeployPlan, localPaths: readonly string[]): string {
  const lines = [
    `n8n deploy preview — session ${plan.sessionId}`,
    "Nothing was generated, imported, or published.",
    "",
    ...renderN8nDeployWorkflows(plan),
    "",
    "Would run, in order:",
  ];
  plan.steps.forEach((step, index) => {
    lines.push(`  ${index + 1}. ${step.id} — ${step.label}`);
    lines.push(
      step.command === undefined
        ? "     (local check — runs no command)"
        : `     $ ${sanitizeDeployText(formatCommandLine(step.command), localPaths)}`,
    );
  });
  lines.push("");
  // A preview never publishes, so `--publish` alone is rejected before this
  // renderer is reached and the plan here never carries the publish step.
  lines.push(
    "Publish: never from a preview — pass --yes --publish to activate the parent once verification passes.",
  );
  lines.push(
    "An already active parent is re-activated after the import, so applying this plan never deactivates a running workflow.",
  );
  lines.push(N8N_RESTART_NOTICE);
  lines.push("Re-run with --yes to apply.");
  return lines.join("\n");
}

function renderN8nDeployStep(step: N8nDeployStepResult): string[] {
  const lines = [`  ${step.outcome.padEnd(8)}${step.id} — ${step.label}`];
  if (step.detail !== undefined) {
    for (const line of step.detail.split("; ")) lines.push(`             ${line}`);
  }
  return lines;
}

function renderN8nDeployApply(
  plan: N8nDeployPlan,
  execution: N8nDeployExecution,
  hint: string | undefined,
): string {
  const lines = [`n8n deploy — session ${plan.sessionId}`, ...renderN8nDeployWorkflows(plan), ""];
  for (const step of execution.steps) lines.push(...renderN8nDeployStep(step));
  lines.push("");
  if (execution.ok) {
    lines.push(
      `Imported and verified child ${plan.child.workflowId} and parent ${plan.parent.workflowId}.`,
    );
    if (execution.published) {
      // "Marked active" rather than "active": the flag is written to the n8n
      // database, and a server that was already running does not act on it
      // until it restarts (the hint below says so).
      lines.push("Parent workflow published — marked active in the n8n database.");
    } else if (execution.parentActiveRestored) {
      lines.push(
        "Parent workflow was already active and was re-activated after the import (marked active in the n8n database).",
      );
    } else {
      lines.push("Parent workflow imported but not published — pass --publish to activate it.");
    }
  } else {
    const failure = execution.failure;
    const reason = failure?.reason ?? "unknown";
    // A failure with no step is one of the two contended deployment locks (this
    // parent's, or the shared child's): the run stopped before its first step,
    // so naming one would be wrong.
    lines.push(
      failure !== undefined && failure.step === undefined
        ? `Deployment did not start: ${reason}${failure.detail === undefined ? "" : ` (${failure.detail})`}.`
        : `Deployment failed at ${failure?.step ?? "an unknown step"}: ${reason}.`,
    );
    lines.push("The parent workflow was not published.");
  }
  if (hint !== undefined) lines.push(hint);
  return lines.join("\n");
}

async function runN8nDeploy(argv: string[]): Promise<void> {
  const parsed = parseCommonOptions(argv, {
    session: "required",
    issueNumber: "none",
    booleanFlags: ["yes", "publish"],
    valueFlags: ["project-id", "n8n-bin", "lock-dir"],
  });
  if ("error" in parsed) die(parsed.error);
  const { sessionId, sessionsPath, args, flags } = parsed;
  const apply = flags.has("yes");
  const publish = flags.has("publish");

  // Publication is the one irreversible-looking effect here: an activated
  // parent starts driving its session on the schedule trigger. It is therefore
  // never implied by a preview.
  if (publish && !apply) {
    die("--publish requires --yes: a preview never imports or publishes anything.");
  }
  const projectId = args["project-id"];
  if (projectId !== undefined && projectId.trim() === "") {
    die("--project-id must not be empty");
  }
  const n8nBinArg = args["n8n-bin"];
  if (n8nBinArg !== undefined && n8nBinArg.trim() === "") {
    die("--n8n-bin must not be empty");
  }
  const lockDirArg = args["lock-dir"];
  if (lockDirArg !== undefined && lockDirArg.trim() === "") {
    die("--lock-dir must not be empty");
  }
  const lockDir = lockDirArg === undefined ? undefined : resolve(lockDirArg);
  // A bare command name (the default `n8n`) is a PATH lookup and must reach
  // spawnSync unchanged; a separator-bearing value is a local path, absolutized
  // so that the form printed is the form the sanitizer redacts. Resolution is
  // against this process's cwd, which is the cwd the n8n steps would run in
  // anyway, so the command executed is unchanged either way.
  const n8nBin =
    n8nBinArg === undefined ? "n8n" : /[/\\]/.test(n8nBinArg) ? resolve(n8nBinArg) : n8nBinArg;
  // Absolutized for the same reason, and because the generator runs with cwd
  // set to the install root rather than the operator's.
  const resolvedSessionsPath = resolve(sessionsPath);

  const installRoot = n8nInstallRoot();
  const generator = await loadWorkflowGenerator(installRoot);
  const artifactDir = join(installRoot, generator.LOCAL_WORKFLOW_ARTIFACT_DIR);
  // CLI_BASE is passed explicitly rather than left to the generator's
  // cwd-relative default, so the path baked into the Execute Command nodes is
  // the install being deployed and not wherever the operator happened to stand.
  const cliBase = process.env["CLI_BASE"] ?? join(installRoot, "dist", "cli");

  const parent = deriveParentWorkflowIdentity(generator, sessionId, artifactDir, installRoot);

  const plan = planN8nDeploy({
    sessionId,
    installRoot,
    cliBase,
    sessionsPath: resolvedSessionsPath,
    nodeBin: process.execPath,
    generatorScript: join(installRoot, WORKFLOW_GENERATOR_SCRIPT),
    n8nBin,
    ...(projectId === undefined ? {} : { projectId }),
    publish,
    parent,
    child: {
      workflowId: generator.CHILD_WORKFLOW_ID,
      workflowName: generator.CHILD_WORKFLOW_NAME,
      artifactPath: join(artifactDir, generator.CHILD_ARTIFACT_FILE_NAME),
      artifactFile: generator.CHILD_ARTIFACT_FILE_NAME,
    },
  });

  // Absolute paths are redacted from everything this command prints: deploy
  // output is exactly what an operator pastes into an issue when it goes wrong,
  // and the workflow IDs, names, and artifact filenames are what identify a
  // deployment anyway. Every path the printed command lines can name is listed,
  // including the binaries and the sessions file — an install under an
  // unconventional root is redacted only because it is named here.
  const localPaths = collectN8nDeployLocalPaths({
    installRoot,
    artifactDir,
    cliBase,
    nodeBin: process.execPath,
    sessionsPath: resolvedSessionsPath,
    n8nBin,
  });
  const workflows = {
    child: {
      workflowId: plan.child.workflowId,
      workflowName: plan.child.workflowName,
      artifactFile: plan.child.artifactFile,
    },
    parent: {
      workflowId: plan.parent.workflowId,
      workflowName: plan.parent.workflowName,
      artifactFile: plan.parent.artifactFile,
    },
  };

  if (!apply) {
    const result = {
      ok: true,
      sessionId,
      applied: false,
      published: false,
      publishRequested: publish,
      // A preview writes nothing, so nothing needs a restart yet; the hint
      // carries the requirement an apply would create.
      restartRequired: false,
      ...(plan.projectId === undefined ? {} : { projectId: plan.projectId }),
      ...workflows,
      steps: plan.steps.map((step) => ({
        id: step.id,
        label: step.label,
        ...(step.command === undefined
          ? {}
          : { commandLine: sanitizeDeployText(formatCommandLine(step.command), localPaths) }),
      })),
      hint:
        "Nothing was generated, imported, or published. Re-run with --yes to apply. " +
        N8N_RESTART_NOTICE,
    };
    report(result as unknown as Record<string, unknown>, () =>
      renderN8nDeployPreview(plan, localPaths),
    );
    return;
  }

  const execution = executeN8nDeploy(plan, {
    run: runN8nDeployCommand,
    readArtifact: (path) => readFileSync(path, "utf8"),
    // Serializes this parent workflow's check/import/restore against any other
    // deploy of the same session; released on every exit path by the executor.
    acquireLock: () => acquireN8nDeployLock(n8nDeployLockScope(plan.parent.workflowId), lockDir),
    // Serializes the shared child's generation and import against deploys of
    // every other session, which write the same artifact from their own CLI_BASE.
    acquireChildLock: () =>
      acquireN8nDeployLock(n8nDeployChildLockScope(plan.child.workflowId), lockDir),
    localPaths,
  });

  // A negative exit code means the binary never ran; for the n8n steps that is
  // almost always a missing or misnamed n8n install, which the raw spawn error
  // ("spawnSync n8n ENOENT") states far less usefully than this does.
  const failedStep = execution.steps.find((step) => step.outcome === "failed");
  const hints: string[] = [];
  if (
    !execution.ok &&
    failedStep?.exitCode !== undefined &&
    failedStep.exitCode < 0 &&
    failedStep.id !== "generate"
  ) {
    hints.push("Could not run the n8n CLI. Check that n8n is installed and on PATH, or pass --n8n-bin <path>.");
  }
  // The import upserts the parent with the artifact's `active: false`, so a run
  // that stops after the parent import leaves a previously active workflow down.
  // That is the safe outcome — it failed verification — but it is a change in
  // the deployment's behaviour and must not be discovered later, on a schedule
  // trigger that never fired.
  const parentImport = execution.steps.find((step) => step.id === "import-parent");
  if (!execution.ok && execution.parentWasActive === true && parentImport?.outcome !== "skipped") {
    hints.push(
      parentImport?.outcome === "ok"
        ? "The parent workflow was active before this deploy and is now INACTIVE: the import replaced it and the run stopped before its active state could be restored. Fix the failure and re-run with --yes, or activate it in n8n once it verifies."
        : "The parent workflow was active before this deploy and may now be INACTIVE: the import was attempted and the run stopped before its active state could be restored.",
    );
  }
  // Last, and on success too: activation is written to the database by a
  // separate CLI process, so an n8n that was already running is still serving
  // what it loaded at startup and its Schedule Trigger has not begun firing.
  if (execution.restartRequired) hints.push(N8N_RESTART_NOTICE);
  const hint = hints.length === 0 ? undefined : hints.join(" ");

  const result = {
    ok: execution.ok,
    sessionId,
    applied: true,
    published: execution.published,
    publishRequested: publish,
    ...(execution.parentWasActive === undefined ? {} : { parentWasActive: execution.parentWasActive }),
    parentActiveRestored: execution.parentActiveRestored,
    restartRequired: execution.restartRequired,
    ...(plan.projectId === undefined ? {} : { projectId: plan.projectId }),
    ...workflows,
    steps: execution.steps,
    ...(execution.verification === undefined ? {} : { verification: execution.verification }),
    ...(execution.failure === undefined ? {} : { failure: execution.failure }),
    ...(hint === undefined ? {} : { hint }),
  };
  report(result as unknown as Record<string, unknown>, () =>
    renderN8nDeployApply(plan, execution, hint),
  );
  if (!execution.ok) process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

// Operator-facing commands default to human-readable output; everything else
// (machine/structured commands such as context create and repo-lock) defaults to
// JSON so existing n8n workflow / script callers keep parsing stdout. Either way
// --json forces structured JSON.
const HUMAN_DEFAULT_COMMANDS = new Set([
  "status",
  "task-status",
  "list-stuck",
  "recover",
  "recover-cap-handoff",
  // Two-word, operator-facing diagnostic (issue #408). Keyed on "<subcommand>
  // <action>" so it defaults to human output without flipping the machine-mode
  // `worktree list`/`worktree prune` callers.
  "worktree recovery",
  // Per-issue worktree dirty-state recovery (issue #570). Operator-facing;
  // defaults to human-readable so preview output is readable without --json.
  "worktree discard",
  // Codex context-mode readiness diagnostic (issue #399). Human-readable by
  // default; `--json` gives the stable machine payload.
  "context-mode status",
  // Loop design readiness audit (issue #533): operator-facing, read-only
  // diagnostic. Human-readable by default; --json for automation.
  "session-audit",
  // Preset list/show commands are operator-facing (issue #513).
  "session preset",
  // Session pause/resume/status (issue #531) are operator-facing recovery
  // commands; readable output without --json. Machine callers pass --json.
  "session pause",
  "session resume",
  "session status",
  // Delay-clear is operator-facing (issue #584); preview output should be
  // readable without --json.
  "task clear-delay",
  // Cancellation and closed-Issue reconciliation (issue #608) are operator-
  // facing preview/--yes commands; readable preview output without --json.
  "task cancel",
  "task reconcile-closed",
  // Merged-PR reconciliation (issue #1048): the same operator-facing
  // preview/--yes posture, run by hand while looking at a merged PR.
  "task reconcile-merged",
  // L3 intervention aggregation (issue #588): operator-facing diagnostic,
  // human-readable by default; --json for machine consumption.
  "interventions",
  // Outbox delivery visibility (issue #607): operator-facing diagnostic,
  // human-readable by default; --json for machine consumption. `outbox
  // retry`/`outbox cancel` stay machine-default (JSON), like the other
  // preview/--yes mutation commands (e.g. worktree release-lock).
  "outbox list",
  // Retention/backup/prune (issue #611): preview and read-only diagnostics
  // are operator-facing, human-readable by default. `backup create/list/
  // restore` stay machine-default (JSON), like the other preview/--yes
  // mutation commands.
  "maintenance preview",
  "archive rollup",
  "prune run",
  "prune status",
  // Maintenance-lock status/force-release recovery (issue #817): operator-
  // facing status and preview/--yes mutation, human-readable by default.
  "maintenance-lock status",
  "maintenance-lock release",
  // Review-dispute operator surface (issue #848): a read-only protocol view and
  // the one §6.4 preview/--yes mutation. Both are operator-facing, so both are
  // human-readable by default; --json gives the stable machine payload.
  "dispute status",
  "dispute reopen",
  // Issue #849: the event-derived report. Read-only and operator-facing, so it
  // follows the same human-by-default posture; --json is the stable payload.
  "dispute metrics",
  // Workflow deployment (issue #822): an operator-facing preview/--yes command
  // run by hand during installation, never by the workflows themselves.
  "n8n deploy",
  // Automation-label activation/suspension (issue #787): operator-facing
  // preview/--yes commands run by hand ahead of dependency-chain repair;
  // readable preview output without --json.
  "issue activate",
  "issue suspend",
  // Read-only chain registry inspection/validation (issue #789): operator-
  // facing diagnostics over #788/#890/#891, human-readable by default; --json
  // gives the stable machine payload.
  "chain list",
  "chain show",
  "chain validate",
  // The one mutating chain command (issue #892): previews by default, applies
  // with --yes, and follows the same operator-facing posture as its read-only
  // siblings.
  "chain sync",
  // Linear chain construction and editing (issue #791): the same preview/--yes
  // posture again, and the same operator-facing default — these are run by hand
  // while looking at a dependency graph, never by a workflow.
  "chain new",
  "chain append",
  "chain prepend",
  // Advanced topology operations (issue #893): fork and merge, with the same
  // preview/--yes posture and the same operator-facing default.
  "chain fork",
  "chain merge",
  // Read-only agent runtime profile inspection/validation (issue #913): the
  // §11.4 operator commands of docs/agent-runtime-profiles-contract.md. Run by
  // hand while looking at (or about to edit) `agent-profiles.json`, so all
  // three read as text by default; --json gives the stable machine payload.
  // `refresh` (issue #914) joins them with the same preview/--yes posture the
  // other state-changing operator commands share.
  "agent-profile list",
  "agent-profile show",
  "agent-profile validate",
  "agent-profile refresh",
  // §13 refinement recovery (issue #980): an operator-facing preview/--yes
  // command run by hand while looking at a stopped Issue. `refinement run`
  // stays machine-default (JSON) — it is the lane's own execution entry.
  "refinement recover",
  // §10 verification refresh (issue #1041): the same preview/--yes posture,
  // read by an operator looking at a corrected Issue. `review-verification
  // resolve` stays machine-default (JSON) — it is called by tooling.
  "review-verification refresh",
  // The §11 task-scoped verification surface (issue #1042). All four are run by
  // hand while looking at one stuck task, so all four read as text by default;
  // --json is the stable payload n8n and scripts consume.
  "task-verification show",
  "task-verification amend",
  "task-verification refresh-from-issue",
  "task-verification reset",
]);

export async function main(rawArgv: string[]): Promise<void> {
  const flags = extractOutputFlags(rawArgv);
  const argv = flags.rest;
  const subcommand = argv[0];
  // Some commands take a two-word form ("worktree recovery"); honor a human
  // default declared for either the bare subcommand or the "<subcommand>
  // <action>" key.
  const commandKey = subcommand && argv[1] ? `${subcommand} ${argv[1]}` : subcommand;
  const defaultJson =
    subcommand === undefined
      ? true
      : !(HUMAN_DEFAULT_COMMANDS.has(subcommand) || HUMAN_DEFAULT_COMMANDS.has(commandKey ?? ""));
  setOutputMode(resolveOutputMode(flags, defaultJson));

  if (!subcommand) {
    runHelp([]);
    return;
  }

  if (subcommand === "help") {
    runHelp(argv.slice(1));
    return;
  }

  if (subcommand === "ui") {
    await runAdminUi(argv.slice(1));
    return;
  }

  if (subcommand === "status") {
    await runStatus(argv.slice(1));
    return;
  }

  if (subcommand === "task-status") {
    await runTaskStatus(argv.slice(1));
    return;
  }

  if (subcommand === "list-stuck") {
    await runListStuck(argv.slice(1));
    return;
  }

  if (subcommand === "recover") {
    await runRecover(argv.slice(1));
    return;
  }

  if (subcommand === "recover-cap-handoff") {
    await runRecoverCapHandoff(argv.slice(1));
    return;
  }

  if (subcommand === "dispute") {
    const action = argv[1];
    if (action === "status") {
      await runDisputeStatus(argv.slice(2));
      return;
    }
    if (action === "reopen") {
      await runDisputeReopen(argv.slice(2));
      return;
    }
    if (action === "metrics") {
      await runDisputeMetrics(argv.slice(2));
      return;
    }
    die(`Unknown dispute action: ${action ?? "(none)"}. Expected: status | reopen | metrics`);
  }

  if (subcommand === "task") {
    const action = argv[1];
    if (action === "clear-delay") {
      await runTaskClearDelay(argv.slice(2));
      return;
    }
    if (action === "cancel") {
      await runTaskCancel(argv.slice(2));
      return;
    }
    if (action === "reconcile-closed") {
      await runTaskReconcileClosed(argv.slice(2));
      return;
    }
    if (action === "reconcile-merged") {
      await runTaskReconcileMerged(argv.slice(2));
      return;
    }
    die(
      `Unknown task action: ${action ?? "(none)"}. ` +
        `Expected: clear-delay | cancel | reconcile-closed | reconcile-merged`,
    );
  }

  if (subcommand === "issue") {
    const action = argv[1];
    if (action === "activate") {
      await runIssueActivate(argv.slice(2));
      return;
    }
    if (action === "suspend") {
      await runIssueSuspend(argv.slice(2));
      return;
    }
    die(`Unknown issue action: ${action ?? "(none)"}. Expected: activate | suspend`);
  }

  if (subcommand === "chain") {
    const action = argv[1];
    if (action === "list") {
      await runChainList(argv.slice(2));
      return;
    }
    if (action === "show") {
      await runChainShow(argv.slice(2));
      return;
    }
    if (action === "validate") {
      await runChainValidate(argv.slice(2));
      return;
    }
    if (action === "sync") {
      await runChainSync(argv.slice(2));
      return;
    }
    if (action === "new") {
      await runChainNew(argv.slice(2));
      return;
    }
    if (action === "append") {
      await runChainAppend(argv.slice(2));
      return;
    }
    if (action === "prepend") {
      await runChainPrepend(argv.slice(2));
      return;
    }
    if (action === "fork") {
      await runChainFork(argv.slice(2));
      return;
    }
    if (action === "merge") {
      await runChainMerge(argv.slice(2));
      return;
    }
    die(
      `Unknown chain action: ${action ?? "(none)"}. Expected: list | show | validate | sync | new | append | prepend | fork | merge`,
    );
  }

  if (subcommand === "agent-profile") {
    const action = argv[1];
    if (action === "list") {
      await runAgentProfileList(argv.slice(2));
      return;
    }
    if (action === "show") {
      await runAgentProfileShow(argv.slice(2));
      return;
    }
    if (action === "validate") {
      await runAgentProfileValidate(argv.slice(2));
      return;
    }
    if (action === "refresh") {
      await runAgentProfileRefresh(argv.slice(2));
      return;
    }
    die(`Unknown agent-profile action: ${action ?? "(none)"}. Expected: list | show | validate | refresh`);
  }

  if (subcommand === "n8n") {
    const action = argv[1];
    if (action === "deploy") {
      await runN8nDeploy(argv.slice(2));
      return;
    }
    die(`Unknown n8n action: ${action ?? "(none)"}. Expected: deploy`);
  }

  if (subcommand === "task-assign") {
    await runTaskAssign(argv.slice(1));
    return;
  }

  if (subcommand === "human-review-return") {
    await runHumanReviewReturn(argv.slice(1));
    return;
  }

  if (subcommand === "github-app-review-return") {
    await runGithubAppReviewReturn(argv.slice(1));
    return;
  }

  if (subcommand === "task-verification") {
    const action = argv[1];
    if (action === "show") {
      await runTaskVerificationShow(argv.slice(2));
      return;
    }
    if (action === "amend") {
      await runTaskVerificationAmend(argv.slice(2));
      return;
    }
    if (action === "refresh-from-issue") {
      await runTaskVerificationRefreshFromIssue(argv.slice(2));
      return;
    }
    if (action === "reset") {
      await runTaskVerificationReset(argv.slice(2));
      return;
    }
    die(
      `Unknown task-verification action: ${action ?? "(none)"}. Expected: show | amend | refresh-from-issue | reset`,
    );
  }

  if (subcommand === "review-verification") {
    const action = argv[1];
    if (action === "resolve") {
      await runReviewVerificationResolve(argv.slice(2));
      return;
    }
    if (action === "refresh") {
      await runReviewVerificationRefresh(argv.slice(2));
      return;
    }
    die(`Unknown review-verification action: ${action ?? "(none)"}. Expected: resolve | refresh`);
  }

  if (subcommand === "tool-request") {
    const action = argv[1];
    if (action === "list") {
      await runToolRequestList(argv.slice(2));
      return;
    }
    if (action === "resolve") {
      await runToolRequestResolveCommand(argv.slice(2));
      return;
    }
    if (action === "run") {
      await runToolRequestGrant(argv.slice(2), "run");
      return;
    }
    if (action === "grant") {
      // Deprecated alias for the guided run (issue #430); tagged as `grant` in the
      // operator-response record so historical behavior is preserved.
      await runToolRequestGrant(argv.slice(2), "grant");
      return;
    }
    die(`Unknown tool-request action: ${action ?? "(none)"}. Expected: list | resolve | run | grant`);
  }

  if (subcommand === "context") {
    const action = argv[1];
    if (action === "create") {
      runContextCreate(argv.slice(2));
      return;
    }
    die(`Unknown context action: ${action ?? "(none)"}. Expected: create`);
  }

  if (subcommand === "repo-lock") {
    const action = argv[1];
    if (action === "acquire") {
      runRepoLockAcquire(argv.slice(2));
      return;
    }
    if (action === "release") {
      runRepoLockRelease(argv.slice(2));
      return;
    }
    if (action === "status") {
      runRepoLockStatus(argv.slice(2));
      return;
    }
    if (action === "force-release") {
      runRepoLockForceRelease(argv.slice(2));
      return;
    }
    die(`Unknown repo-lock action: ${action ?? "(none)"}. Expected: acquire | release | status | force-release`);
  }

  if (subcommand === "outbox") {
    const action = argv[1];
    if (action === "list") {
      await runOutboxList(argv.slice(2));
      return;
    }
    if (action === "retry") {
      await runOutboxRetry(argv.slice(2));
      return;
    }
    if (action === "cancel") {
      await runOutboxCancel(argv.slice(2));
      return;
    }
    die(`Unknown outbox action: ${action ?? "(none)"}. Expected: list | retry | cancel`);
  }

  if (subcommand === "review-lock") {
    const action = argv[1];
    if (action === "status") {
      runReviewLockStatus(argv.slice(2));
      return;
    }
    if (action === "release") {
      runReviewLockRelease(argv.slice(2));
      return;
    }
    die(`Unknown review-lock action: ${action ?? "(none)"}. Expected: status | release`);
  }

  if (subcommand === "worktree") {
    const action = argv[1];
    if (action === "list") {
      runWorktreeList(argv.slice(2));
      return;
    }
    if (action === "prune") {
      runWorktreePrune(argv.slice(2));
      return;
    }
    if (action === "recovery") {
      await runWorktreeRecovery(argv.slice(2));
      return;
    }
    if (action === "cleanup") {
      await runWorktreeCleanup(argv.slice(2));
      return;
    }
    if (action === "release-lock") {
      runWorktreeReleaseLock(argv.slice(2));
      return;
    }
    if (action === "discard") {
      await runWorktreeDiscard(argv.slice(2));
      return;
    }
    die(`Unknown worktree action: ${action ?? "(none)"}. Expected: list | prune | recovery | cleanup | release-lock | discard`);
  }

  if (subcommand === "session") {
    const action = argv[1];
    if (action === "preset") {
      const presetAction = argv[2];
      if (presetAction === "list") {
        runSessionPresetList();
        return;
      }
      if (presetAction === "show") {
        runSessionPresetShow(argv.slice(3));
        return;
      }
      die(`Unknown session preset action: ${presetAction ?? "(none)"}. Expected: list | show`);
    }
    if (action === "pause") {
      await runSessionPause(argv.slice(2));
      return;
    }
    if (action === "resume") {
      await runSessionResume(argv.slice(2));
      return;
    }
    if (action === "status") {
      await runSessionStatus(argv.slice(2));
      return;
    }
    die(`Unknown session action: ${action ?? "(none)"}. Expected: preset | pause | resume | status`);
  }

  if (subcommand === "session-doctor") {
    runSessionDoctor(argv.slice(1));
    return;
  }

  if (subcommand === "session-audit") {
    await runSessionAudit(argv.slice(1));
    return;
  }

  if (subcommand === "session-init") {
    runSessionInit(argv.slice(1));
    return;
  }

  if (subcommand === "context-mode") {
    const action = argv[1];
    if (action === "status") {
      await runContextModeStatus(argv.slice(2));
      return;
    }
    die(`Unknown context-mode action: ${action ?? "(none)"}. Expected: status`);
  }

  if (subcommand === "issue-plan") {
    const action = argv[1];
    if (action === "preview") {
      const parsed = parseIssuePlanArgs(argv.slice(2));
      if ("error" in parsed) die(parsed.error);
      await runIssuePlanPreview(parsed);
      return;
    }
    if (action === "ai-preview") {
      const parsed = parseIssuePlanAiArgs(argv.slice(2));
      if ("error" in parsed) die(parsed.error);
      await runIssuePlanAiPreview(parsed);
      return;
    }
    if (action === "evaluate-history") {
      const parsed = parseEvaluateHistoryArgs(argv.slice(2));
      if ("error" in parsed) die(parsed.error);
      await runEvaluateHistory(parsed);
      return;
    }
    die(`Unknown issue-plan action: ${action ?? "(none)"}. Expected: preview | ai-preview | evaluate-history`);
  }

  if (subcommand === "issue-discuss") {
    const action = argv[1];
    if (action === "preview") {
      const parsed = parseIssueDiscussArgs(argv.slice(2));
      if ("error" in parsed) die(parsed.error);
      await runIssueDiscussPreview(parsed);
      return;
    }
    if (action === "post") {
      const parsed = parseIssueDiscussPostArgs(argv.slice(2));
      if ("error" in parsed) die(parsed.error);
      await runIssueDiscussPost(parsed);
      return;
    }
    die(`Unknown issue-discuss action: ${action ?? "(none)"}. Expected: preview | post`);
  }

  if (subcommand === "refinement") {
    const action = argv[1];
    if (action === "run") {
      const parsed = parseRefinementRunArgs(argv.slice(2));
      if ("error" in parsed) die(parsed.error);
      await runRefinementRun(parsed, { store: new SqliteTaskStore(parsed.dbPath) });
      return;
    }
    // §13's operator recovery (issue #980). Same composition-root shape as
    // `run`: the concrete store is constructed here and injected, so the
    // command module itself never imports it (#613/P1).
    if (action === "recover") {
      const parsed = parseRefinementRecoverArgs(argv.slice(2));
      if ("error" in parsed) die(parsed.error);
      await runRefinementRecover(parsed, { store: new SqliteTaskStore(parsed.dbPath) });
      return;
    }
    die(`Unknown refinement action: ${action ?? "(none)"}. Expected: run | recover`);
  }

  if (subcommand === "interventions") {
    runInterventions(argv.slice(1));
    return;
  }

  if (subcommand === "backup") {
    const action = argv[1];
    if (action === "create") {
      await runBackupCreate(argv.slice(2));
      return;
    }
    if (action === "list") {
      runBackupList(argv.slice(2));
      return;
    }
    if (action === "restore") {
      await runBackupRestore(argv.slice(2));
      return;
    }
    die(`Unknown backup action: ${action ?? "(none)"}. Expected: create | list | restore`);
  }

  if (subcommand === "maintenance") {
    const action = argv[1];
    if (action === "preview") {
      await runMaintenancePreview(argv.slice(2));
      return;
    }
    die(`Unknown maintenance action: ${action ?? "(none)"}. Expected: preview`);
  }

  if (subcommand === "archive") {
    const action = argv[1];
    if (action === "rollup") {
      await runArchiveRollup(argv.slice(2));
      return;
    }
    die(`Unknown archive action: ${action ?? "(none)"}. Expected: rollup`);
  }

  if (subcommand === "prune") {
    const action = argv[1];
    if (action === "run") {
      await runPruneRun(argv.slice(2));
      return;
    }
    if (action === "status") {
      runPruneStatus(argv.slice(2));
      return;
    }
    die(`Unknown prune action: ${action ?? "(none)"}. Expected: run | status`);
  }

  if (subcommand === "maintenance-lock") {
    const action = argv[1];
    if (action === "status") {
      runMaintenanceLockStatus(argv.slice(2));
      return;
    }
    if (action === "release") {
      await runMaintenanceLockRelease(argv.slice(2));
      return;
    }
    die(`Unknown maintenance-lock action: ${action ?? "(none)"}. Expected: status | release`);
  }

  die(`Unknown command: ${subcommand}. Run "admin help" to see available commands.`);
}

/**
 * The complete admin CLI run: dispatch plus the top-level failure contract that
 * turns an unexpected throw into the same `die()` output any other failure
 * produces.
 *
 * This is the whole of the executable's behaviour — `dist/cli/admin.js` invoked
 * as a program does nothing but call this with `process.argv.slice(2)`. The
 * in-process test harness (test/helpers/admin-cli.js) calls the same function
 * with a swapped {@link CliIoSink}, so a harnessed case and a spawned case run
 * identical code and differ only in where stdout/stderr/exit land (issue #1018).
 */
export async function runAdminCli(argv: string[]): Promise<void> {
  try {
    await main(argv);
  } catch (err) {
    // A sink that unwinds by throwing has already decided the outcome; re-raise
    // it rather than relabelling a deliberate exit an unexpected error.
    if (err instanceof CliExit) throw err;
    die(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const isMain =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  // Under the process sink die() calls process.exit(), so this promise settles
  // only on the success path; the catch is a belt-and-braces net that keeps a
  // hypothetical rejection from surfacing as an unhandled-rejection crash.
  runAdminCli(process.argv.slice(2)).catch(() => {
    process.exitCode = 1;
  });
}
