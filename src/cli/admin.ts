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

import { execFileSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "fs";
import { dirname, isAbsolute, join, relative, resolve } from "path";
import { SqliteTaskStore } from "../stores/sqlite-task-store.js";
import { SqliteContextStore } from "../stores/sqlite-context-store.js";
import Database from "better-sqlite3";
import { SqliteOutboxStore, DEFAULT_DB_PATH } from "../stores/sqlite-outbox-store.js";
import {
  aggregateL3Interventions,
  UNOBSERVABLE_L3_SIGNALS,
} from "../core/l3-intervention-aggregation.js";
import type { L3AggregationResult } from "../core/l3-intervention-aggregation.js";
import { RepoLockStore } from "../stores/repo-lock-store.js";
import type { AgentId, AiTask, TaskAttempts, TaskPhase, TaskStatus } from "../core/task.js";
import type { ResolvedSession } from "../core/session.js";
import { isClaimExpired } from "../core/transitions.js";
import {
  selectChangesRequestedFeedback,
  type ReviewFeedbackSelection,
} from "../core/github-app-review.js";
import { DEFAULT_SESSIONS_PATH, JsonSessionRegistry } from "../registries/json-session-registry.js";
import { agentForPhase, ASSIGNMENT_CONTEXT_KEY, DEFAULT_FLOW, readResolvedAssignment } from "../core/assignment.js";
import type { ResolvedAssignment } from "../core/assignment.js";
import { enqueueStatusLabelEffects, sanitizeBody, boundedExcerpt, workItemOutbox, sessionRedactionPaths } from "../core/outbox-effects.js";
import { redactCommand } from "../core/tool-request.js";
import {
  createToolRequestGrant,
  grantMatches,
  grantStatus,
  normalizeCommand,
  GRANT_DEFAULT_MAX_USES,
  GRANT_DEFAULT_TTL_MS,
} from "../core/tool-request-grant.js";
import type { ToolRequestGrant, GrantCandidate } from "../core/tool-request-grant.js";
import {
  parseRepoChangeAction,
  parsePorcelainStatus,
  classifyChangedFiles,
  planRepoChange,
  summarizeClassification,
} from "../core/tool-request-changes.js";
import type { RepoChangeAction } from "../core/tool-request-changes.js";
import { bothStreamsCommandRunner, defaultCommandRunner, type CommandRunResult } from "../handlers/command-runner.js";
import { listWorktrees, removeWorktree, canonicalizePath, IssueWorktreeLock, issueLockScope, DEFAULT_WORKTREE_LOCK_DIR } from "../handlers/worktree.js";
import {
  resolveWorktreeRoot,
  issueWorktreePath,
  issueWorktreeId,
  sessionWorktreeDir,
} from "../core/worktree-paths.js";
import { assessWorktreeRecovery } from "../core/worktree-recovery.js";
import type { WorktreeRecoveryAssessment } from "../core/worktree-recovery.js";
import { boundVerificationOutput } from "../handlers/verification.js";
import { runArtifactDir } from "../handlers/artifact-dir.js";
import { makeOutboxKey } from "../core/outbox.js";
import { branchName, resolvePrContext } from "../handlers/pr-helpers.js";
import { fileURLToPath } from "url";
import {
  emit,
  die,
  report,
  setOutputMode,
  extractOutputFlags,
  resolveOutputMode,
} from "./cli-io.js";
import type { OutputMode } from "./cli-io.js";
import {
  VALID_PHASES,
  parseCommonOptions,
  resolveSessionSelector,
  tokenizeArgs,
} from "./admin-command.js";
import { runAdminUi } from "./admin-ui.js";
import { ECOSYSTEM_PRESETS, PRESET_NAMES, findPreset } from "../core/presets.js";
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
import { parseIssuePlanArgs, runIssuePlanPreview } from "./issue-plan.js";
import { parseIssuePlanAiArgs, runIssuePlanAiPreview } from "./issue-plan-ai.js";
import { parseEvaluateHistoryArgs, runEvaluateHistory } from "./issue-plan-history.js";
import { prReviewReaderFromGhRunner } from "./pr-review-reader.js";
import type { PrReviewReader } from "./pr-review-reader.js";
import { defaultGhRunner } from "../providers/github/gh-runner.js";
import { resolveGhRunner } from "../providers/github/github-app-auth.js";
import type { GhRunnerAuthDeps } from "../providers/github/github-app-auth.js";
import { buildUntrackedPatch } from "../handlers/implementation.js";

// ---------------------------------------------------------------------------
// Subcommand: help
// ---------------------------------------------------------------------------

interface CommandOption {
  flag: string;
  description: string;
}

interface CommandInfo {
  name: string;
  description: string;
  entrypoint?: string;
  options: CommandOption[];
}

const COMMANDS: CommandInfo[] = [
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
      { flag: "--sessions-path <path>", description: "Path to sessions.json (optional)." },
      { flag: "--db-path <path>", description: "Path to SQLite database (optional)." },
      { flag: "--dry-run", description: "Preview the action without writing to the database or outbox." },
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
    description: "Resolve a Tool Request handoff. 'manual-done' signals that the operator has already run the requested command externally and committed/pushed the side effects ON THE ISSUE BRANCH (the open PR head branch, or ai/issue-<n>) — never on the base branch. It does NOT approve the command for future automated runs — if the agent re-requests the same command on the next run, the repository state still appears unchanged. Refused if the session checkout is dirty (first commit and push the changes the requested command produced to the issue branch, or use 'reject' if they should not land; do not stash them, as the requeued run would not see them) or if the local base branch is ahead of origin (move those commits to the issue branch or drop them — do not push the base branch). Also refused when no usable continuation point exists (issue #379): if the issue branch is absent both locally and on origin and there is no PR to resume, requeueing would branch a fresh run from the base with none of the prior work and loop on the same request — land the change on the issue branch first (the failed run's artifact dir preserves a 'partial-implementation.patch' you can reapply), then re-run this resolve, or use 'reject'. 'reject' records the decision and leaves the task as a human handoff. Never runs the requested command.",
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
    name: "session-doctor",
    description: "Check repo, GitHub, and AI CLI health for a configured session.",
    options: [
      { flag: "--session-id <id>", description: "Canonical session ID to check (required unless --session-ref is given)." },
      { flag: "--session-ref <ref>", description: "Short session reference (sessionId, sessionNo, or alias) resolved to the canonical sessionId. Mutually exclusive with --session-id." },
      { flag: "--sessions-path <path>", description: "Path to sessions.json (optional; also used to resolve --session-ref)." },
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
    name: "quarantine status",
    description: "Show implementation quarantine state for a session (marker, git branch, worktree cleanliness).",
    options: [
      { flag: "--session-id <id>", description: "Session ID to inspect (required)." },
      { flag: "--sessions-path <path>", description: "Path to sessions.json (optional)." },
      { flag: "--lock-dir <path>", description: "Directory for lock files (optional)." },
    ],
  },
  {
    name: "quarantine clear",
    description: "Clear an implementation quarantine and restore the checkout to the session base branch.",
    options: [
      { flag: "--session-id <id>", description: "Session ID to recover (required)." },
      { flag: "--yes", description: "Required confirmation flag; refuses without it." },
      { flag: "--sessions-path <path>", description: "Path to sessions.json (optional)." },
      { flag: "--lock-dir <path>", description: "Directory for lock files (optional)." },
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
    description: "Remove a single issue's per-issue git worktree (issue #400). Previews by default; pass --yes to remove. Refuses a dirty/locked worktree unless --force is given. A missing worktree is a safe no-op. Does not delete branches or touch the canonical checkout.",
    options: [
      { flag: "--session-id <id>", description: "Session ID that owns the worktree (required)." },
      { flag: "--issue-number <n>", description: "Issue number whose worktree to prune (required)." },
      { flag: "--yes", description: "Actually remove the worktree (without it, the command only previews)." },
      { flag: "--force", description: "Discard a dirty or locked worktree (git worktree remove --force)." },
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
      "Inspect and bulk-prune stale per-issue worktrees for a session (issue #407). Classifies every managed worktree as active (an in-flight/awaiting-human task or a live issue lock — never pruned), terminal (issue task done), or orphaned (no task row), then prunes the terminal/orphaned ones. Previews by default (changes nothing) so candidates can be reviewed; pass --yes to remove. Refuses to remove a dirty worktree or one whose branch has commits not pushed to origin unless --force is given, and reports every skip with its reason. Never deletes branches or touches the canonical checkout. Worktree paths are local-only and never published. Unknown flags fail fast.",
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
    process.stdout.write(formatHelpOne(cmd));
  } else {
    process.stdout.write(formatHelpAll());
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
  }
  return lines.join("\n");
}

function runTaskStatus(argv: string[]): void {
  const parsed = parseTaskStatusArgs(argv);
  if ("error" in parsed) die(parsed.error);

  const { sessionId, issueNumber, dbPath } = parsed;

  const store = new SqliteTaskStore(dbPath);
  try {
    const tasks = store.listTasks(sessionId, issueNumber);
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

function runListStuck(argv: string[]): void {
  const parsed = parseListStuckArgs(argv);
  if ("error" in parsed) die(parsed.error);

  const { sessionId, dbPath } = parsed;
  const now = new Date().toISOString();

  const store = new SqliteTaskStore(dbPath);
  try {
    const all = store.listTasks(sessionId);

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

function recoverItemLine(it: RecoverItem, target: string): string {
  let line = `  #${it.issueNumber}  ${it.previousStatus} → ${target}  (phase ${it.phase})`;
  if (typeof it.reviewCycles === "number") line += `  reviewCycles=${it.reviewCycles}`;
  return line;
}

function renderRecoverDryRun(
  payload: { sessionId: string; issueNumber?: number; wouldRecover: RecoverItem[] },
  mode: OutputMode,
): string {
  const scope = sessionScope(payload.sessionId, payload.issueNumber);
  if (payload.wouldRecover.length === 0) {
    return `Dry run: no recoverable tasks for ${scope}.`;
  }
  const lines: string[] = [];
  if (!mode.quiet) {
    lines.push(`Dry run — would recover ${payload.wouldRecover.length} task(s) for ${scope}:`);
  }
  for (const it of payload.wouldRecover) {
    lines.push(recoverItemLine(it, "queued"));
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

function runRecover(argv: string[]): void {
  const parsed = parseRecoverArgs(argv);
  if ("error" in parsed) die(parsed.error);

  const { sessionId, issueNumber, phase, from, dbPath, dryRun } = parsed;
  const now = new Date().toISOString();

  const store = new SqliteTaskStore(dbPath);
  try {
    if (from === "ready_for_human") {
      const candidates = store
        .listTasks(sessionId, issueNumber)
        .filter((t) => t.status === "ready_for_human");

      if (dryRun) {
        const result = {
          ok: true,
          dryRun: true,
          sessionId,
          ...(issueNumber !== undefined ? { issueNumber } : {}),
          wouldRecover: candidates.map((t) => ({
            issueNumber: t.issueNumber,
            status: "queued",
            phase: phase!,
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
        const result = store.recoverHandoff(
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
            reason: result.code,
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

    const candidates = store
      .listTasks(sessionId, issueNumber)
      .filter(
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
      const result = store.recoverTask(
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

function runRecoverCapHandoff(argv: string[]): void {
  const parsed = parseRecoverCapHandoffArgs(argv);
  if ("error" in parsed) die(parsed.error);

  const { sessionId, issueNumber, phase, dbPath, dryRun } = parsed;

  const store = new SqliteTaskStore(dbPath);
  try {
    const candidates = store
      .listTasks(sessionId, issueNumber)
      .filter(
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
      const result = store.recoverCapHandoff(
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

function runTaskClearDelay(argv: string[]): void {
  const parsed = parseTaskClearDelayArgs(argv);
  if ("error" in parsed) die(parsed.error);

  const { sessionId, issueNumber, dbPath, yes } = parsed;

  const store = new SqliteTaskStore(dbPath);
  try {
    const tasks = store.listTasks(sessionId, issueNumber);
    const task = tasks[0];

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

    const storeResult = store.clearTaskDelay({ sessionId, issueNumber });
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
// Subcommand: session-doctor
// ---------------------------------------------------------------------------

interface CheckResult {
  name: string;
  category: "repo" | "github" | "aiCli";
  ok: boolean;
  detail?: string;
  error?: string;
}

interface SessionDoctorArgs {
  sessionId: string;
  sessionsPath: string;
}

function parseSessionDoctorArgs(argv: string[]): SessionDoctorArgs | { error: string } {
  const tokenized = tokenizeArgs(argv, {
    valueFlags: ["session-id", "session-ref", "sessions-path"],
  });
  if ("error" in tokenized) return { error: tokenized.error };
  const { args } = tokenized;
  const selector = resolveSessionSelector(args);
  if ("error" in selector) return { error: selector.error };
  return {
    sessionId: selector.sessionId,
    sessionsPath: args["sessions-path"] ?? DEFAULT_SESSIONS_PATH,
  };
}

function probe(cmd: string, args: string[], cwd?: string): { ok: boolean; output: string } {
  try {
    const stdout = execFileSync(cmd, args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
    }) as string;
    return { ok: true, output: stdout.trim() };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string };
    const msg = (e.stderr ?? e.stdout ?? String(err)).slice(0, 300);
    return { ok: false, output: msg };
  }
}

/**
 * Determine whether origin has `branch`, distinguishing a positively-absent
 * branch from an ambiguous lookup failure (issue #316 review). `git ls-remote
 * --exit-code` exits 2 only when the lookup succeeded but matched no ref; any
 * other non-zero status (network, auth, timeout) is ambiguous and must NOT be
 * read as "branch absent" — doing so could create a base-derived branch that
 * misses the existing PR head's changes.
 */
function remoteHasBranch(repoRoot: string, branch: string): "yes" | "no" | "unknown" {
  // With no `origin` remote configured the branch is definitively local-only: the
  // remote cannot hold it, so this is a determinate "no", not the ambiguous
  // "unknown" reserved for a configured remote whose lookup failed (network/auth).
  // Conflating the two would steer a genuinely local-only stale branch away from
  // cleanup and toward recreate.
  try {
    execFileSync("git", ["remote", "get-url", "origin"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return "no";
  }
  try {
    execFileSync("git", ["ls-remote", "--exit-code", "--heads", "origin", branch], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
    });
    return "yes";
  } catch (err: unknown) {
    return (err as { status?: number }).status === 2 ? "no" : "unknown";
  }
}

/**
 * Resolve the work branch a Tool Request's side effects must land on (issue
 * #316). Tool Request recovery follows the same branch discipline as
 * implementation work: dependency/Tool Request changes belong on the issue's
 * branch, never the session base branch (e.g. `main`). Prefer the PR head branch
 * recorded on the task (set once an open PR exists for the issue); otherwise fall
 * back to the conventional `ai/issue-<n>` branch — the initial-implementation
 * case where no PR exists yet.
 */
function resolveToolRequestWorkBranch(task: AiTask, issueNumber: number): string {
  const { branch } = resolvePrContext(task);
  return branch && branch.trim().length > 0 ? branch.trim() : branchName(issueNumber);
}

/**
 * The dependency start point a Tool Request work branch must be built on when it
 * has to be created from scratch (issue #316 review). In dependency-start-point
 * mode the implementation handler creates `ai/issue-<n>` from the blocker PR head
 * and then DELETES that temporary branch when it hands off a Tool Request — so a
 * later grant finds the branch nowhere and would otherwise create it from the
 * session base, missing the blocker's changes. The handler records `dependencyBase`
 * on the task so the grant can rebuild the branch on the blocker head instead.
 * Returns the blocker PR head ref name, or undefined when the issue is not
 * dependency-started.
 */
function resolveToolRequestDependencyHead(task: AiTask): string | undefined {
  const dep = task.context["dependencyBase"];
  if (dep && typeof dep === "object" && !Array.isArray(dep)) {
    const head = (dep as Record<string, unknown>)["baseHeadRefName"];
    if (typeof head === "string" && head.trim().length > 0) return head.trim();
  }
  return undefined;
}

/**
 * Move the checkout onto `workBranch` so a granted Tool Request command runs on
 * the issue branch, never the base branch (issue #316). Assumes a clean tree —
 * the caller's preflight has already verified it.
 *
 *   - already on the work branch         → nothing to do (`created: false`).
 *   - the branch exists locally          → check it out (`created: false`).
 *   - it exists on origin (PR branch)    → fetch + check it out (`created: false`).
 *   - it exists nowhere                  → safely update the base, then create the
 *                                          branch from it (`created: true`).
 *
 * `created` lets a clean no-op grant tidy up a branch it had to invent. Fails
 * closed (returns an error) rather than running the command on the wrong branch.
 * Origin is only consulted when one is configured, so a checkout without a remote
 * still creates the branch from the local base.
 *
 * `depStartPoint`, when set, is the blocker PR head a dependency-started issue
 * branch must be built on (issue #316 review). When the branch exists nowhere and
 * a dependency start point is given, the branch is created from the fetched blocker
 * head instead of the session base — and we fail closed rather than fall back to
 * the base, since a base-derived branch would miss the blocker's changes.
 *
 * `fromRecordedPr` marks a `workBranch` that came from the task's recorded PR head
 * rather than the conventional `ai/issue-<n>` name (issue #316 review). When the
 * branch exists nowhere we only create it from the base for the conventional
 * no-PR case: a recorded PR head that is missing both locally and on origin (the
 * head was deleted, lives in a fork, or is otherwise unavailable) must NOT be
 * rebuilt from the base, which would run the grant on a branch lacking the PR's
 * current changes. Fail closed instead.
 *
 * `resumeSafe` (on success) reports whether a resolved — not freshly created —
 * branch is a *known* resume point: the recorded PR head, or a branch that exists
 * on origin (pushed). It is false for an arbitrary pre-existing local conventional
 * branch, which on a clean no-op grant is most likely a stale leftover from a
 * prior failed run rather than intentional work. The no-op-grant caller uses this
 * to avoid silently adopting such a leftover as the requeue resume point — letting
 * the implementation run's new-branch preflight fail loudly instead (issue #316
 * review). Always false when `created` is true (the caller checks `created` first).
 */
function moveToToolRequestBranch(
  repoRoot: string,
  workBranch: string,
  baseBranch: string,
  depStartPoint?: string,
  fromRecordedPr = false,
): { ok: true; created: boolean; resumeSafe: boolean } | { ok: false; error: string } {
  const current = probe("git", ["rev-parse", "--abbrev-ref", "HEAD"], repoRoot);
  const hasOrigin = probe("git", ["remote", "get-url", "origin"], repoRoot).ok;

  // Fast-forward the checked-out work branch from origin so the granted command
  // runs against current files, mirroring fix-mode branch setup (issue #316
  // review). The local branch may be behind the open PR head after another
  // operator or worker pushed updates. Fail closed if the branch diverged rather
  // than run the grant on stale state. A grant-created branch never pushed has no
  // origin counterpart, so only pull when origin actually has the branch.
  // `onOrigin` lets the caller tell a pushed/PR branch (a known resume point)
  // from an arbitrary local-only branch (issue #316 review).
  const fastForwardFromOrigin = (): { ok: true; onOrigin: boolean } | { ok: false; error: string } => {
    if (!hasOrigin) return { ok: true, onOrigin: false };
    const remoteHas = remoteHasBranch(repoRoot, workBranch);
    if (remoteHas === "unknown") {
      // A transient ls-remote failure must NOT be read as "origin lacks this
      // branch": collapsing unknown→false would skip the pull and run the grant
      // on a stale local PR branch even though origin/<workBranch> may have
      // advanced. Fail closed so the operator reconciles instead (issue #316
      // review).
      return {
        ok: false,
        error:
          `could not determine whether origin has '${workBranch}' (lookup failed); refusing to run the ` +
          `granted command on a possibly-stale '${workBranch}' without reconciling with origin`,
      };
    }
    if (remoteHas === "no") {
      // A recorded PR head that origin positively lacks is a stale local copy of
      // a deleted/unavailable PR branch (issue #316 review). Running the grant on
      // it would apply Tool Request side effects to a branch that is no longer the
      // PR head — the same hazard the no-PR fail-closed check below guards, which
      // is otherwise bypassed because the branch happens to still exist locally.
      // Fail closed so the operator restores the PR head before granting.
      if (fromRecordedPr) {
        return {
          ok: false,
          error:
            `the recorded PR head branch '${workBranch}' exists locally but not on origin (the head was ` +
            `deleted or is otherwise unavailable); refusing to run the granted command on a stale local ` +
            `copy that is no longer the PR head. Restore the PR head branch (or its origin ref) before granting`,
        };
      }
      return { ok: true, onOrigin: false };
    }
    const pull = probe("git", ["pull", "origin", workBranch, "--ff-only"], repoRoot);
    if (!pull.ok) {
      return { ok: false, error: `git pull origin ${workBranch} --ff-only failed: ${pull.output}` };
    }
    // `git pull --ff-only` succeeds as a no-op when the local branch is *ahead* of
    // origin (origin is already an ancestor), leaving unpushed local commits in
    // place. Returning onOrigin:true here would let a clean/no-op grant treat such
    // a branch as a known resume point, record it as `toolRequestResumeBranch`, and
    // bypass the manual-done pushed-branch guard — resuming the next run from commits
    // that exist only in this checkout (issue #316 review). Fail closed so the
    // operator pushes or drops the local-only commits before the branch is adopted.
    // Compare the local branch against the just-fetched origin tip via FETCH_HEAD,
    // not the remote-tracking ref origin/<workBranch>: a fresh/single-branch clone
    // that pulls `origin <workBranch>` updates only FETCH_HEAD and never creates
    // refs/remotes/origin/<workBranch>, so `rev-list origin/<workBranch>..` would
    // fail and refuse a valid local PR branch (issue #316 review). The
    // `git pull origin <workBranch> --ff-only` above wrote FETCH_HEAD to the
    // fetched tip.
    const ahead = probe("git", ["rev-list", "--count", `FETCH_HEAD..${workBranch}`], repoRoot);
    if (!ahead.ok) {
      return {
        ok: false,
        error: `git rev-list --count FETCH_HEAD..${workBranch} (origin/${workBranch} tip) failed: ${ahead.output}`,
      };
    }
    if (ahead.output.trim() !== "0") {
      return {
        ok: false,
        error:
          `local '${workBranch}' is ahead of origin/${workBranch} by ${ahead.output.trim()} commit(s); refusing ` +
          `to run the granted command on a branch with unpushed commits. Push or drop the local-only commits on ` +
          `'${workBranch}' before granting`,
      };
    }
    return { ok: true, onOrigin: true };
  };

  // Already on the work branch: still reconcile with origin. Skipping the
  // fast-forward here (the prior early return) would run the grant against a
  // stale PR branch when origin/<workBranch> has advanced (issue #316 review).
  if (current.ok && current.output === workBranch) {
    const ff = fastForwardFromOrigin();
    if (!ff.ok) return ff;
    return { ok: true, created: false, resumeSafe: ff.onOrigin || fromRecordedPr };
  }

  const localExists = probe("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${workBranch}`], repoRoot).ok;
  if (localExists) {
    const co = probe("git", ["checkout", workBranch], repoRoot);
    if (!co.ok) return { ok: false, error: `git checkout ${workBranch} failed: ${co.output}` };
    const ff = fastForwardFromOrigin();
    if (!ff.ok) return ff;
    return { ok: true, created: false, resumeSafe: ff.onOrigin || fromRecordedPr };
  }

  // Not local — does origin have it (an existing PR branch)? Only consult origin
  // when one is configured. Positively prove the branch's presence/absence first
  // (issue #316 review): a transient fetch failure must NOT be treated the same as
  // "branch does not exist", or a granted command for an existing PR head could be
  // run on a base-derived branch missing the PR's current changes. Only fall
  // through to base-branch creation when origin genuinely lacks the branch.
  if (hasOrigin) {
    const remote = remoteHasBranch(repoRoot, workBranch);
    if (remote === "unknown") {
      return {
        ok: false,
        error:
          `could not determine whether origin has '${workBranch}' (lookup failed); refusing to create a ` +
          `base-derived branch that could miss existing PR changes`,
      };
    }
    if (remote === "yes") {
      const fetched = probe("git", ["fetch", "origin", workBranch], repoRoot);
      if (!fetched.ok) {
        return { ok: false, error: `git fetch origin ${workBranch} failed: ${fetched.output}` };
      }
      const co = probe("git", ["checkout", "-B", workBranch, "FETCH_HEAD"], repoRoot);
      if (!co.ok) return { ok: false, error: `git checkout ${workBranch} (from origin) failed: ${co.output}` };
      // Resolved from origin — a pushed/PR branch is a known, safe resume point.
      return { ok: true, created: false, resumeSafe: true };
    }
    // remote === "no": origin positively lacks the branch — safe to create it
    // from the base branch below.
  }

  // The branch exists nowhere. A recorded PR head must be resolved before the
  // dependency start point (issue #316 review): when the task carries both a
  // recorded PR head and a `dependencyBase`, rebuilding the PR head from the
  // blocker head here would run the grant on a branch missing the PR's current
  // commits — the same fail-closed case as below. The recorded PR head wins, so
  // we fail closed rather than recreate it from the dependency start point.
  if (fromRecordedPr) {
    return {
      ok: false,
      error:
        `the recorded PR head branch '${workBranch}' exists neither locally nor on origin; refusing to ` +
        `recreate it from the base branch '${baseBranch}', which would miss the PR's current changes. ` +
        `Restore the PR head branch (or its origin ref) before granting`,
    };
  }

  // In dependency-start-point mode the branch must be built on the blocker PR
  // head, not the session base (issue #316 review): the implementation handler
  // deleted the temporary `ai/issue-<n>` branch at handoff, so creating it from
  // the base here would miss the blocker's changes and the requeued dependency
  // implementation would later collide with this branch or recreate from the
  // blocker and lose the granted side effects. Fetch the blocker head and branch
  // from it; fail closed rather than fall back to the base.
  if (depStartPoint) {
    if (!hasOrigin) {
      return {
        ok: false,
        error:
          `'${workBranch}' must be created from the dependency start point '${depStartPoint}' (the blocker PR ` +
          `head), but this checkout has no 'origin' remote to fetch it from; refusing to create the branch ` +
          `from the base branch '${baseBranch}', which would miss the blocker's changes`,
      };
    }
    const fetched = probe("git", ["fetch", "origin", depStartPoint], repoRoot);
    if (!fetched.ok) {
      return {
        ok: false,
        error:
          `git fetch origin ${depStartPoint} (dependency start point for '${workBranch}') failed: ${fetched.output}; ` +
          `refusing to create the branch from the base branch '${baseBranch}', which would miss the blocker's changes`,
      };
    }
    const create = probe("git", ["checkout", "-b", workBranch, "FETCH_HEAD"], repoRoot);
    if (!create.ok) {
      return { ok: false, error: `git checkout -b ${workBranch} FETCH_HEAD (dependency start point) failed: ${create.output}` };
    }
    return { ok: true, created: true, resumeSafe: false };
  }

  // Not dependency-started: create it from the configured base branch after
  // updating the base safely (fetch/ff-only pull when a remote exists).
  const coBase = probe("git", ["checkout", baseBranch], repoRoot);
  if (!coBase.ok) return { ok: false, error: `git checkout ${baseBranch} failed: ${coBase.output}` };
  if (hasOrigin) {
    const pull = probe("git", ["pull", "--ff-only"], repoRoot);
    if (!pull.ok) return { ok: false, error: `git pull --ff-only on ${baseBranch} failed: ${pull.output}` };
  }
  const create = probe("git", ["checkout", "-b", workBranch, baseBranch], repoRoot);
  if (!create.ok) return { ok: false, error: `git checkout -b ${workBranch} ${baseBranch} failed: ${create.output}` };
  return { ok: true, created: true, resumeSafe: false };
}

function runSessionDoctor(argv: string[]): void {
  const parsed = parseSessionDoctorArgs(argv);
  if ("error" in parsed) die(parsed.error);

  const { sessionId, sessionsPath } = parsed;

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
  const session = sessions.find((s) => s["sessionId"] === sessionId);
  if (!session) {
    die(`Unknown sessionId: ${sessionId} (not found in ${sessionsPath})`);
  }

  const repoRoot = typeof session["repoRoot"] === "string" ? session["repoRoot"] : "";
  const githubRepo = typeof session["githubRepo"] === "string" ? session["githubRepo"] : "";
  const defaults = (typeof session["defaults"] === "object" && session["defaults"] !== null
    ? session["defaults"]
    : {}) as Record<string, string>;

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

  if (repoRootOk) {
    const gitCheck = probe("git", ["rev-parse", "--git-dir"], repoRoot);
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
  } else {
    checks.push({
      name: "ghRepoAccess",
      category: "github",
      ok: false,
      error: "githubRepo not configured",
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

  for (const agent of agentSet) {
    const bin = agent === "gemini" ? (process.env["ANTIGRAVITY_BIN"] ?? "agy") : agent;
    const cliCheck = probe(bin, ["--version"]);
    checks.push({
      name: `${agent}Cli`,
      category: "aiCli",
      ok: cliCheck.ok,
      ...(cliCheck.ok
        ? { detail: cliCheck.output.split("\n")[0] }
        : { error: cliCheck.output }),
    });
  }

  if (reviewAgent === "gemini" && VALID_AGENTS.includes(reviewAgent as AgentId)) {
    const reviewBin = process.env["ANTIGRAVITY_BIN"] ?? "agy";
    const cliCheck = probe(reviewBin, ["--version"]);
    checks.push({
      name: "geminiReviewCli",
      category: "aiCli",
      ok: cliCheck.ok,
      ...(cliCheck.ok
        ? { detail: cliCheck.output.split("\n")[0] }
        : { error: cliCheck.output }),
    });
  }

  // NOTE (issue #292): the research agent's CLI probe is emitted by the shared
  // agentSet loop above (researchAgent is added to agentSet under the same guard
  // used here). A separate `${researchAgent}Cli` check here would duplicate that
  // probe — e.g. a Gemini research agent already yields one `geminiCli` check —
  // so no research-specific probe is emitted.

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

// ---------------------------------------------------------------------------
// Subcommand: quarantine status / clear
// ---------------------------------------------------------------------------

const QUARANTINE_FILENAME = "implementation-quarantine.json";

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
   * (e.g. `quarantine status|clear`) never touch worktrees. Worktree
   * subcommands resolve it lazily via {@link resolveSessionWorktreeRoot} so that
   * configuration error only surfaces for callers that actually need it.
   */
  sessionWorktreeRoot: string | undefined;
  /** True only when the session explicitly sets worktrees.enabled = true. */
  worktreesEnabled: boolean;
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
  const session = sessions.find((s) => s["sessionId"] === sessionId);
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
  const worktreesEnabled = worktrees?.["enabled"] === true;
  return {
    sessionId,
    repoRoot,
    artifactRoot: resolve(repoRoot, artifactDir),
    artifactDir,
    baseBranch,
    sessionWorktreeRoot,
    worktreesEnabled,
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

interface QuarantineStatusArgs {
  sessionId: string;
  sessionsPath: string;
  lockDir: string | undefined;
}

function parseQuarantineStatusArgs(argv: string[]): QuarantineStatusArgs | { error: string } {
  const tokenized = tokenizeArgs(argv, {
    valueFlags: ["session-id", "sessions-path", "lock-dir"],
  });
  if ("error" in tokenized) return { error: tokenized.error };
  const { args } = tokenized;
  if (!args["session-id"]) return { error: "--session-id is required" };
  return {
    sessionId: args["session-id"],
    sessionsPath: args["sessions-path"] ?? DEFAULT_SESSIONS_PATH,
    lockDir: args["lock-dir"],
  };
}

function runQuarantineStatus(argv: string[]): void {
  const parsed = parseQuarantineStatusArgs(argv);
  if ("error" in parsed) die(parsed.error);

  const { sessionId, sessionsPath, lockDir } = parsed;
  const sessionInfo = loadSessionInfo(sessionId, sessionsPath);
  if ("error" in sessionInfo) die(sessionInfo.error);

  const { repoRoot, artifactRoot } = sessionInfo;
  const markerPath = join(artifactRoot, QUARANTINE_FILENAME);
  const quarantineExists = existsSync(markerPath);

  let marker: Record<string, unknown> | null = null;
  if (quarantineExists) {
    try {
      marker = JSON.parse(readFileSync(markerPath, "utf8")) as Record<string, unknown>;
    } catch {
      marker = null;
    }
  }

  const branchProbe = probe("git", ["rev-parse", "--abbrev-ref", "HEAD"], repoRoot);
  const statusProbe = probe("git", ["status", "--porcelain"], repoRoot);

  const lockStore = new RepoLockStore(lockDir);
  let repoLock: { held: true; contextId: string; startedAt: string } | { held: false };
  try {
    repoLock = lockStore.peek(sessionId);
  } catch {
    repoLock = { held: false };
  }

  emit({
    ok: true,
    sessionId,
    quarantineExists,
    markerPath,
    marker,
    currentBranch: branchProbe.ok ? branchProbe.output : null,
    worktreeClean: statusProbe.ok ? statusProbe.output === "" : null,
    worktreeSummary: statusProbe.ok ? statusProbe.output : null,
    repoLock,
  });
}

interface QuarantineClearArgs {
  sessionId: string;
  sessionsPath: string;
  lockDir: string | undefined;
  yes: boolean;
}

function parseQuarantineClearArgs(argv: string[]): QuarantineClearArgs | { error: string } {
  const tokenized = tokenizeArgs(argv, {
    booleanFlags: ["yes"],
    valueFlags: ["session-id", "sessions-path", "lock-dir"],
  });
  if ("error" in tokenized) return { error: tokenized.error };
  const { args, flags } = tokenized;
  if (!args["session-id"]) return { error: "--session-id is required" };
  return {
    sessionId: args["session-id"],
    sessionsPath: args["sessions-path"] ?? DEFAULT_SESSIONS_PATH,
    lockDir: args["lock-dir"],
    yes: flags.has("yes"),
  };
}

function runQuarantineClear(argv: string[]): void {
  const parsed = parseQuarantineClearArgs(argv);
  if ("error" in parsed) die(parsed.error);

  const { sessionId, sessionsPath, lockDir, yes } = parsed;

  if (!yes) {
    die("--yes is required to clear quarantine. Inspect with 'quarantine status' first.");
  }

  const sessionInfo = loadSessionInfo(sessionId, sessionsPath);
  if ("error" in sessionInfo) die(sessionInfo.error);

  const { repoRoot, artifactRoot, artifactDir, baseBranch } = sessionInfo;
  const markerPath = join(artifactRoot, QUARANTINE_FILENAME);

  if (!existsSync(markerPath)) {
    die(`No quarantine marker found for session ${sessionId}. Nothing to clear.`);
  }

  // Acquire the repo lock for the duration of the clear to prevent a concurrent
  // context from mutating the checkout at the same time.
  const lockStore = new RepoLockStore(lockDir);
  const CLEAR_CONTEXT_ID = "admin-quarantine-clear";
  const acquireResult = lockStore.acquire(CLEAR_CONTEXT_ID, sessionId);
  if (!acquireResult.locked) {
    die(
      `Repo lock is held by context '${acquireResult.ownerContextId}' (started ${acquireResult.ownerStartedAt}). ` +
        `Cannot clear quarantine while another context holds the lock.`,
    );
  }

  // Perform all mutations with the lock held. Accumulate any failure reason so
  // the lock can be released before calling die() (process.exit() does not run
  // finally blocks, so we avoid die() inside the critical section).
  let failureReason: string | null = null;

  // Read marker before making any changes for the audit record.
  let previousMarker: Record<string, unknown> | null = null;
  try {
    previousMarker = JSON.parse(readFileSync(markerPath, "utf8")) as Record<string, unknown>;
  } catch {
    // Unreadable marker; proceed with recovery anyway.
  }

  // Restore the checkout to the base branch, discarding local tracked-file changes.
  const checkoutResult = probe("git", ["checkout", "-f", baseBranch], repoRoot);
  if (!checkoutResult.ok) {
    failureReason = `git checkout -f ${baseBranch} failed: ${checkoutResult.output}`;
  }

  // Remove untracked residue left by the failed implementation run, but
  // preserve the session artifact directory so run logs and the marker itself
  // (deleted below) are not accidentally swept up.
  let cleanResult: { ok: boolean; output: string } | null = null;
  if (!failureReason) {
    cleanResult = probe("git", ["clean", "-fd", `--exclude=/${artifactDir}`], repoRoot);
    if (!cleanResult.ok) {
      // Leave the marker in place so the next clear attempt can retry.
      failureReason = `git clean failed: ${cleanResult.output}. Quarantine marker left in place.`;
    }
  }

  // Delete the quarantine marker last so a crash before this point leaves the
  // marker in place and another clear attempt is still possible.
  let markerDeleted = false;
  if (!failureReason) {
    try {
      unlinkSync(markerPath);
      markerDeleted = true;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== "ENOENT") {
        failureReason = `Failed to delete quarantine marker: ${err instanceof Error ? err.message : String(err)}`;
      } else {
        // ENOENT means the marker was already removed (e.g., by a concurrent clear
        // or a clean step that ran without the exclude). Either way the quarantine
        // is gone, which is the goal.
        markerDeleted = true;
      }
    }
  }

  // Release lock before emitting or dying so it is always freed.
  lockStore.release(CLEAR_CONTEXT_ID, sessionId);

  if (failureReason) {
    die(failureReason);
  }

  emit({
    ok: true,
    sessionId,
    checkedOutBranch: baseBranch,
    worktreeClean: cleanResult?.ok ?? false,
    cleanOutput: cleanResult?.output ?? "",
    markerDeleted,
    previousMarker,
  });

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
}

function parseWorktreePruneArgs(argv: string[]): WorktreePruneArgs | { error: string } {
  const args: Record<string, string> = {};
  let yes = false;
  let force = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--yes") {
      yes = true;
    } else if (argv[i] === "--force") {
      force = true;
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
  };
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
}

function parseStatusArgs(argv: string[]): StatusArgs | { error: string } {
  const opts = parseCommonOptions(argv, {
    session: "required",
    issueNumber: "optional",
    booleanFlags: ["all"],
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
  worktree: StatusWorktree;
  /** True when the canonical checkout has uncommitted changes; null when git could not be queried. */
  canonicalDirty: boolean | null;
  issueLock: StatusLock;
  suggestedAction: string;
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
    case "needs_human":
      return "Awaiting a human review/decision.";
    case "failed":
      return orphanLocalBranch
        ? `Local branch ${entry.branch.name} exists but was never pushed (no remote branch or PR) and has no worktree — the run failed before publishing the branch. Inspect lastError, then requeue with \`${recover}\`.`
        : `Inspect lastError, then requeue with \`${recover}\`.`;
    case "done":
      return "Completed; no action needed.";
    case "no_task":
      return orphanLocalBranch
        ? `No task is queued, but local branch ${entry.branch.name} exists with no remote branch, PR, or worktree — likely an interrupted run. Enqueue a task or clean up the branch.`
        : "No task in the queue for this issue.";
  }
}

function shellQuotePath(p: string): string {
  return /^[A-Za-z0-9_./:@-]+$/.test(p) ? p : `'${p.replace(/'/g, "'\\''")}'`;
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
    /** True only when the session has worktrees.enabled = true. Continuation categories are suppressed otherwise. */
    worktreesEnabled: boolean;
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
    if (hasValidDirtyContinuation && ctx.worktreesEnabled) {
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
  repoLock: StatusLock;
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

function runStatus(argv: string[]): void {
  const parsed = parseStatusArgs(argv);
  if ("error" in parsed) die(parsed.error);

  const { sessionId, issueNumber, sessionsPath, dbPath, lockDir, worktreeLockDir, all } = parsed;
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
    worktreesEnabled: sessionInfo.worktreesEnabled,
    worktreeLockDir: hintWorktreeLockDir,
    sessionsPath: hintSessionsPath,
    dbPath: hintDbPath,
    now,
  };

  const store = new SqliteTaskStore(dbPath);
  let entries: StatusEntry[];
  try {
    const tasks = store.listTasks(sessionId, issueNumber);
    if (issueNumber !== undefined) {
      // An explicit issue is always shown, even when done or with no task.
      entries =
        tasks.length > 0
          ? tasks.map((t) => buildStatusEntry(t, t.issueNumber, buildCtx))
          : [buildStatusEntry(null, issueNumber, buildCtx)];
    } else {
      // Hide closed/completed tasks unless --all was requested.
      const visible = all ? tasks : tasks.filter((t) => t.status !== "done");
      entries = visible
        .slice()
        .sort((a, b) => a.issueNumber - b.issueNumber)
        .map((t) => buildStatusEntry(t, t.issueNumber, buildCtx));
    }
  } finally {
    store.close();
  }

  const payload = {
    ok: true as const,
    sessionId,
    ...(issueNumber !== undefined ? { issueNumber } : {}),
    generatedAt: now,
    repoLock,
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
  /** active | terminal | orphaned | <other task status, e.g. failed>. */
  classification: string;
  dirty: boolean;
  unpushedCommits: boolean;
  lockHeld: boolean;
  /** "remove" when it is a prune candidate that passes all safety checks. */
  decision: "remove" | "skip";
  reason?: string;
}

function runWorktreeCleanup(argv: string[]): void {
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
      const m = /^issue-(\d+)(?:\/|$)/.exec(rel);
      if (!m) continue; // not a recognized per-issue worktree layout
      const issueNumber = Number(m[1]);
      const branch = w.branch ? w.branch.replace(/^refs\/heads\//, "") : null;

      const task = store.listTasks(sessionId, issueNumber)[0];
      const lockHeld = lock.inspect(sessionId, issueNumber).locked;

      let classification: string;
      let candidate: boolean;
      if (!task) {
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
    const result = removeWorktree(repoRoot, item.path, { force });
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

function runWorktreeDiscard(argv: string[]): void {
  const parsed = parseWorktreeDiscardArgs(argv);
  if ("error" in parsed) die(parsed.error);

  const { sessionId, issueNumber, sessionsPath, dbPath, lockDir, yes, force } = parsed;
  const sessionInfo = loadSessionInfo(sessionId, sessionsPath);
  if ("error" in sessionInfo) die(sessionInfo.error);

  if (!sessionInfo.worktreesEnabled) {
    die("Refusing: per-issue worktrees are not enabled for this session (worktrees.enabled is not true). Cannot safely discard a shared checkout.");
  }

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
      const tasks = store.listTasks(sessionId, issueNumber);
      const task = tasks[0];
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

// Terminal statuses whose worktree was legitimately pruned once the work landed.
// These tasks keep `prUrl`/`branch` in their context as the normal end state, so
// that PR context must NOT be trusted as evidence of expected-but-missing drift.
const WORKTREE_TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>(["done"]);

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

function runWorktreeRecovery(argv: string[]): void {
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
        ? store.listTasks(sessionId, issueNumber)
        : store.listTasks(sessionId);
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
    die(`Unknown sessionId: ${sessionId} (not found in ${sessionsPath})`);
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
    const tasks = store.listTasks(sessionId, issueNumber);
    if (tasks.length === 0) {
      die(`Task not found: session "${sessionId}", issue #${issueNumber}`);
    }
    const task = tasks[0];

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
}): Promise<
  | { ok: true; task: AiTask; prUrl?: string; branch: string }
  | { ok: false; code: string; current?: AiTask }
> {
  const { store, outboxStore, session, task, now, runId } = args;
  const sessionId = session.sessionId;
  const issueNumber = task.issueNumber;

  const { prUrl, branch } = resolvePrContext(task);
  const resolvedBranch = branch ?? branchName(issueNumber);

  const newContext: Record<string, unknown> = {
    reviewFeedback: args.reviewFeedback,
    reviewFeedbackSource: args.reviewFeedbackSource,
    reviewFeedbackRecordedAt: now,
    reviewFeedbackMeta: args.reviewFeedbackMeta,
    implementationMode: "fix",
    branch: resolvedBranch,
    ...(prUrl !== undefined ? { prUrl } : {}),
    // Clear stale review-loop cap state so an intentional return starts the
    // review loop fresh. Without this, the merge-patch preserves a prior
    // reviewLoopCapReached / escalatedEffort handoff and a non-zero reviewCycles,
    // which would make a subsequent review look like a cap handoff or escalate
    // immediately. Keys set to undefined are dropped when JSON-serialized.
    reviewLoopCapReached: undefined,
    escalatedEffort: undefined,
    reviewCycles: 0,
    manualVerificationEvidence: undefined,
    missingVerificationCommands: undefined,
  };

  const result = await store.transitionTask(
    { sessionId, issueNumber },
    { status: task.status },
    {
      status: "queued",
      phase: "implementation",
      ownerRunId: undefined,
      leaseExpiresAt: undefined,
      lastError: undefined,
      context: newContext,
      now,
    },
  );
  if (!result.ok) {
    return { ok: false, code: result.code, current: result.current };
  }

  // Swap GitHub labels to the fix lane via the shared outbox logic: add
  // status:needs-fix + the implementation agent label and remove the
  // ready-for-human + review-lane labels. Modeled as a review→needs_fix requeue
  // so the ready-for-human / review-lane cleanup path is reached.
  await enqueueStatusLabelEffects(
    outboxStore,
    session,
    result.value,
    "queued",
    "implementation",
    runId,
    now,
    "review",
    { result: "needs_fix", context: { reviewFeedback: args.reviewFeedback, prUrl, branch: resolvedBranch } },
  );

  // The shared helper only removes the review-lane labels when the optional
  // needsReview / agentReview session keys are configured. Sessions relying on
  // the default review labels would otherwise stay tagged in both the review and
  // the fix lane. Explicitly remove them too, falling back to the same defaults
  // intake uses. Idempotent with the helper's own removals (same runId + label).
  // Route through the work-item provider so a non-GitHub session's label removals
  // reach the work-item repo instead of stranding behind the dispatcher's failing
  // GitHub runner; no-op passthrough for a GitHub session.
  const workItemStore = workItemOutbox(outboxStore, session);
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

  return { ok: true, task: result.value, prUrl, branch: resolvedBranch };
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
    die(`Unknown sessionId: ${sessionId} (not found in ${sessionsPath})`);
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
    const tasks = store.listTasks(sessionId, issueNumber);
    if (tasks.length === 0) {
      die(`Task not found: session "${sessionId}", issue #${issueNumber}`);
    }
    const task = tasks[0];

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
        prUrl: prUrl ?? null,
        branch: resolvedBranch,
      });
      return;
    }

    const runId = `admin-human-review-return-${now}`;

    // Requeue to queued/implementation in fix mode and swap labels to the fix lane
    // via the shared helper (same context contract + label routing as the GitHub
    // App path). Expecting the current status detects a concurrent claim.
    const requeue = await enqueueFixModeRequeue({
      store,
      outboxStore,
      session,
      task,
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
    });
    if (!requeue.ok) {
      die(
        `Failed to requeue task: ${requeue.code}` +
          (requeue.current ? ` (current status: ${requeue.current.status})` : ""),
      );
    }
    const result = { value: requeue.task };

    // Public status comment: announce the operator action with metadata only.
    // The feedback text is forwarded to the fix agent privately via task context
    // and is NOT echoed back to GitHub unless it originated from a comment that is
    // already public on this issue. Operator-provided feedback (--feedback /
    // --feedback-file) may carry credentials or private context that sanitizeBody
    // (paths only) would not redact, so the public comment stays metadata-only for
    // that source.
    let commentBody =
      `🔧 **Returned to implementation fix mode by operator.**\n\n` +
      `Feedback source: ${reviewFeedbackSource === "human_comment" ? "latest human issue comment" : "operator input"}.`;
    if (reviewFeedbackSource === "human_comment") {
      const excerpt = boundedExcerpt(sanitizedFeedback, 1500);
      commentBody +=
        `\n\n<details>\n<summary>Review feedback excerpt (sanitized)</summary>\n\n${fenceUntrusted(excerpt)}\n</details>`;
    }
    commentBody = sanitizeBody(commentBody, sessionRedactionPaths(session));
    // Route the status comment through the session's work-item provider so a
    // non-GitHub session posts it to the work-item repo instead of stranding the
    // legacy `gh:comment` row behind the dispatcher's failing GitHub runner;
    // no-op passthrough for a GitHub session.
    await workItemOutbox(outboxStore, session).enqueue({
      idempotencyKey: makeOutboxKey(sessionId, issueNumber, runId, "gh:comment", "human-review-return"),
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
        hasPrUrl: prUrl !== undefined,
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
      prUrl: prUrl ?? null,
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
//     `manualVerificationEvidence` and requeues to review. The next review run
//     reads the evidence and treats the command as "passed", so the same missing
//     command escalation does not repeat.
//
//   - Exit non-zero (failure): routes directly to implementation fix mode with
//     the failure output as feedback. Does not mark review as passed.
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

  return {
    sessionId: args["session-id"],
    issueNumber: n,
    command: args["command"],
    exitCode: ec,
    output: args["output"],
    outputFile: args["output-file"],
    sessionsPath: args["sessions-path"] ?? DEFAULT_SESSIONS_PATH,
    dbPath: args["db-path"],
    dryRun,
  };
}

export async function runReviewVerificationResolve(argv: string[]): Promise<void> {
  const parsed = parseReviewVerificationResolveArgs(argv);
  if ("error" in parsed) die(parsed.error);

  const { sessionId, issueNumber, command, exitCode, output, outputFile, sessionsPath, dbPath, dryRun } = parsed;

  let registry: JsonSessionRegistry;
  try {
    registry = new JsonSessionRegistry(sessionsPath);
  } catch (err) {
    die(`Failed to load sessions file (${sessionsPath}): ${err instanceof Error ? err.message : String(err)}`);
  }

  const session = await registry.getSessionById(sessionId);
  if (!session) {
    die(`Unknown sessionId: ${sessionId} (not found in ${sessionsPath})`);
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
    const tasks = store.listTasks(sessionId, issueNumber);
    if (tasks.length === 0) {
      die(`Task not found: session "${sessionId}", issue #${issueNumber}`);
    }
    const task = tasks[0];

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
      });
      if (!requeue.ok) {
        die(
          `Failed to requeue task: ${requeue.code}` +
            (requeue.current ? ` (current status: ${requeue.current.status})` : ""),
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
        prUrl: prUrl ?? null,
        branch: resolvedBranch,
      });
      return;
    }

    // Exit 0: store passing evidence and requeue to review.
    // Merge with any existing evidence, replacing an entry for the same command.
    const existingEvidence = Array.isArray(ctx.manualVerificationEvidence) ? ctx.manualVerificationEvidence : [];
    const updatedEvidence = [
      ...existingEvidence.filter(
        (e: unknown) =>
          !(typeof e === "object" && e !== null && (e as Record<string, unknown>)["command"] === command),
      ),
      { command, exitCode: 0, output: sanitizedOutput, recordedAt: now, source: "operator_input" },
    ];

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
        wouldRequeue: { status: "queued", phase: "review" },
        action: "requeue_review",
        evidenceCount: updatedEvidence.length,
        outputChars: sanitizedOutput.length,
        prUrl: prUrl ?? null,
        branch: resolvedBranch,
      });
      return;
    }

    const remainingMissingCmds = missingCmds.filter((c) => c !== command);
    const newContext: Record<string, unknown> = {
      manualVerificationEvidence: updatedEvidence,
      branch: resolvedBranch,
      ...(prUrl !== undefined ? { prUrl } : {}),
      // Remove the resolved command from the missing list; keep others so
      // subsequent resolve calls can still satisfy them.
      missingVerificationCommands: remainingMissingCmds.length > 0 ? remainingMissingCmds : undefined,
    };

    const result = await store.transitionTask(
      { sessionId, issueNumber },
      { status: task.status },
      {
        status: "queued",
        phase: "review",
        ownerRunId: undefined,
        leaseExpiresAt: undefined,
        lastError: undefined,
        context: newContext,
        now,
      },
    );
    if (!result.ok) {
      die(
        `Failed to requeue task: ${result.code}` +
          (result.current ? ` (current status: ${result.current.status})` : ""),
      );
    }

    // Remove the ready-for-human label and restore the review-lane labels so
    // github-intake can discover the re-queued review task. The blocked-review
    // transition that set ready-for-human already removed status:needs-review
    // and the reviewer agent label, so we must add them back here.
    const workItemStore = workItemOutbox(outboxStore, session);
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

    // Public status comment (metadata only — no command output in the public comment).
    const commentBody = sanitizeBody(
      `🔍 **Manual verification recorded by operator.**\n\n` +
        `Command \`${command}\` — exit 0 (success). Task re-queued for automated review.`,
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

    await store.appendEvent({
      task: { sessionId, issueNumber },
      type: "review_verification_resolve",
      runId,
      message: `Operator supplied passing manual verification for issue #${issueNumber}: \`${command}\` (exit 0). Requeued to review.`,
      data: {
        command,
        exitCode: 0,
        previousStatus: task.status,
        previousPhase: task.phase,
        action: "requeue_review",
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
    die(`Unknown sessionId: ${sessionId} (not found in ${sessionsPath})`);
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
    const tasks = store.listTasks(sessionId, issueNumber);
    if (tasks.length === 0) {
      die(`Task not found: session "${sessionId}", issue #${issueNumber}`);
    }
    const task = tasks[0];

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
    });
    if (!requeue.ok) {
      die(
        `Failed to requeue task: ${requeue.code}` +
          (requeue.current ? ` (current status: ${requeue.current.status})` : ""),
      );
    }

    // Public status comment: metadata ONLY. The review feedback content is
    // forwarded to the fix agent privately via task context and is never echoed
    // back to the PR thread by the automation (the review itself is already on the
    // PR under the human's identity; the bot must not re-post it).
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
    // Route the status comment through the session's work-item provider so a
    // non-GitHub session posts it to the work-item repo instead of stranding the
    // legacy `gh:comment` row behind the dispatcher's failing GitHub runner;
    // no-op passthrough for a GitHub session.
    await workItemOutbox(outboxStore, session).enqueue({
      idempotencyKey: makeOutboxKey(sessionId, issueNumber, runId, "gh:comment", "github-app-review-return"),
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

function readStoredToolRequest(task: { context: Record<string, unknown> }): Record<string, unknown> | undefined {
  const tr = task.context["toolRequest"];
  if (tr && typeof tr === "object" && !Array.isArray(tr)) return tr as Record<string, unknown>;
  return undefined;
}

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

function runToolRequestList(argv: string[]): void {
  const parsed = parseToolRequestListArgs(argv);
  if ("error" in parsed) die(parsed.error);

  const { sessionId, issueNumber, all, dbPath } = parsed;

  const store = new SqliteTaskStore(dbPath);
  try {
    const candidates = store
      .listTasks(sessionId, issueNumber)
      .filter((t) => {
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

const TOOL_REQUEST_ACTIONS = ["manual-done", "reject"] as const;
type ToolRequestAction = (typeof TOOL_REQUEST_ACTIONS)[number];

interface ToolRequestResolveArgs {
  sessionId: string;
  issueNumber: number;
  action: ToolRequestAction;
  message: string | undefined;
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

  if (args["action"] === undefined) return { error: "--action is required" };
  if (!TOOL_REQUEST_ACTIONS.includes(args["action"] as ToolRequestAction)) {
    return { error: `--action must be one of: ${TOOL_REQUEST_ACTIONS.join(", ")}, got: ${args["action"]}` };
  }
  const action = args["action"] as ToolRequestAction;

  const message = args["message"];
  if (action === "reject" && (message === undefined || message.trim().length === 0)) {
    return { error: "--message is required when --action reject is used" };
  }

  return {
    sessionId: opts.sessionId,
    issueNumber: opts.issueNumber!,
    action,
    message,
    sessionsPath: opts.sessionsPath,
    dbPath: opts.dbPath,
    dryRun: opts.dryRun,
  };
}

// Bounded storage for an operator-supplied resolution note. Operator-typed text
// is trusted, but the note is still surfaced in a public GitHub comment, so it
// is bounded and path-sanitized like any other comment content.
const MAX_TOOL_REQUEST_MESSAGE_CHARS = 1_000;

async function runToolRequestResolve(argv: string[]): Promise<void> {
  const parsed = parseToolRequestResolveArgs(argv);
  if ("error" in parsed) die(parsed.error);

  const { sessionId, issueNumber, action, message, sessionsPath, dbPath, dryRun } = parsed;

  let registry: JsonSessionRegistry;
  try {
    registry = new JsonSessionRegistry(sessionsPath);
  } catch (err) {
    die(`Failed to load sessions file (${sessionsPath}): ${err instanceof Error ? err.message : String(err)}`);
  }

  const session = await registry.getSessionById(sessionId);
  if (!session) {
    die(`Unknown sessionId: ${sessionId} (not found in ${sessionsPath})`);
  }

  const now = new Date().toISOString();
  const boundedMessage = message !== undefined
    ? sanitizeBody(boundedExcerpt(message.trim(), MAX_TOOL_REQUEST_MESSAGE_CHARS), sessionRedactionPaths(session))
    : undefined;

  const store = new SqliteTaskStore(dbPath);
  const outboxStore = new SqliteOutboxStore(dbPath);
  try {
    const tasks = store.listTasks(sessionId, issueNumber);
    if (tasks.length === 0) {
      die(`Task not found: session "${sessionId}", issue #${issueNumber}`);
    }
    const task = tasks[0];

    const existing = readStoredToolRequest(task);
    if (!existing) {
      die(`Issue #${issueNumber} in session "${sessionId}" has no Tool Request to resolve.`);
    }
    if (existing["resolved"] === true) {
      die(`Tool Request for issue #${issueNumber} in session "${sessionId}" is already resolved.`);
    }
    if (task.status === "claimed" || task.status === "running") {
      die(
        `Task #${issueNumber} in session "${sessionId}" is currently ${task.status}` +
          (task.ownerRunId ? ` (owner: ${task.ownerRunId})` : "") +
          `. Refusing to resolve an active task. Wait for it to complete or recover it first.`,
      );
    }

    const resolution = {
      action,
      ...(boundedMessage !== undefined ? { message: boundedMessage } : {}),
      resolvedAt: now,
    };
    const resolvedToolRequest = { ...existing, resolved: true, resolution };

    // manual-done requeues the task to implementation so the agent retries now
    // that the operator has performed the requested command externally. reject
    // records the decision and leaves the task in its human-handoff state.
    const requeue = action === "manual-done";
    const targetStatus = requeue ? "queued" : task.status;
    const targetPhase: TaskPhase = requeue ? "implementation" : task.phase;

    // When the requeued implementation run is an initial implementation (no PR yet),
    // its branch setup would `git checkout -b ai/issue-<n>` from the base. If the
    // Tool Request side effects already live on that branch — created by the grant,
    // or by the operator moving the changes there — recreating it collides and
    // strands the work (issue #316 review). Record the work branch as the resume
    // point, but only when it actually exists locally, so the implementation handler
    // continues from it; a dropped/never-created branch stays unset and the run
    // branches fresh from base as usual.
    let toolRequestResumeBranch: string | undefined;

    // A manual-done requeue drops the task straight back into the implementation
    // lane, whose first step is a `git status --porcelain` preflight that aborts
    // the run on a dirty worktree. The common Tool Request command mutates repo
    // files (e.g. `npm install` rewriting package.json/lockfiles); if the operator
    // ran it and left those edits uncommitted, requeueing here would mark the
    // request resolved while every implementation retry immediately fails dirty —
    // resolved request, stuck task (issue #291 review follow-up). Refuse up front
    // and tell the operator to land the expected changed files so the requeued run
    // starts clean. Only block on a positive dirty signal; if git can't be probed
    // (e.g. repoRoot is not a checkout) proceed rather than guess.
    if (requeue) {
      const expectedFiles = Array.isArray(existing["expectedFiles"])
        ? (existing["expectedFiles"] as unknown[]).filter((f): f is string => typeof f === "string")
        : [];
      // The work branch the side effects must live on (issue #316): the existing
      // PR head branch, else the conventional issue branch. Tool Request changes
      // belong here, never on the session base branch.
      const workBranch = resolveToolRequestWorkBranch(task, issueNumber);
      const baseBranch = session.baseBranch ?? "main";

      // Where the working-tree cleanliness check must run. For a worktree-enabled
      // session the implementation phase checked `ai/issue-<n>` out in its own
      // per-issue worktree, and a Tool Request handoff (grant or manual run) left
      // the command's side effects there — never in the canonical checkout. The
      // requeued implementation run's dirty preflight runs in that same worktree
      // (issue #454), so manual-done must validate cleanliness against it too:
      // probing only `session.repoRoot` would pass a dirty issue worktree and
      // requeue the task straight into a worktree-dirty preflight failure — resolved
      // request, stuck task. Resolve the per-issue worktree and check there when one
      // exists; fall back to the canonical checkout when worktrees are disabled, or
      // for issues that still run on the shared checkout (fix-mode / dependency-stack)
      // where no managed worktree is registered (issue #454 review).
      let dirtyCheckCwd = session.repoRoot;
      if (session.worktrees?.enabled === true) {
        let worktreeRoot: string;
        try {
          worktreeRoot = resolveWorktreeRoot({ sessionRoot: session.worktrees.root });
        } catch (err) {
          die(
            `Refusing to resolve Tool Request for issue #${issueNumber} in session "${sessionId}": the session ` +
              `enables per-issue worktrees but its worktree root is misconfigured: ` +
              `${err instanceof Error ? err.message : String(err)}`,
          );
        }
        const worktreePath = canonicalizePath(issueWorktreePath(worktreeRoot, sessionId, issueNumber));
        const listed = listWorktrees(session.repoRoot);
        const entry = listed.ok
          ? listed.worktrees.find((w) => canonicalizePath(w.path) === worktreePath)
          : undefined;
        if (entry && !entry.prunable && existsSync(worktreePath)) {
          dirtyCheckCwd = worktreePath;
        }
      }
      const inWorktree = dirtyCheckCwd !== session.repoRoot;

      const statusProbe = probe("git", ["status", "--porcelain"], dirtyCheckCwd);
      if (statusProbe.ok && statusProbe.output.length > 0) {
        die(
          `Refusing to requeue issue #${issueNumber} in session "${sessionId}": the ${inWorktree ? "issue worktree" : "session checkout"} ` +
            `(${dirtyCheckCwd}) is dirty, so the implementation preflight would immediately abort it ` +
            `as dirty and leave the request resolved but the task stuck.\n` +
            `Commit the changes the requested command produced` +
            (expectedFiles.length > 0 ? ` (expected: ${expectedFiles.join(", ")})` : "") +
            ` on the issue branch '${workBranch}' and push that branch (never the base branch '${baseBranch}') so the ${inWorktree ? "worktree" : "checkout"} is clean, then re-run ` +
            `this resolve. Do not stash them — the requeued run would not see them.\nWorktree:\n${statusProbe.output.slice(0, 300)}`,
        );
      }

      // A clean worktree is not sufficient. An operator following the guidance to
      // commit the requested changes can leave `git status --porcelain` empty while
      // the session's local base branch sits ahead of origin. The implementation
      // preflight checks out the base branch and `git pull --ff-only` (which a
      // local-ahead branch passes cleanly), then branches each issue off that local
      // base — so an unpushed base commit would leak into this and every later issue
      // branch (issue #291 review follow-up). Refuse until the base is pushed. Only
      // block on a positive signal; if the comparison can't be made (e.g. no
      // origin/<base> tracking ref) proceed rather than guess.
      //
      // This guard only applies to the shared-checkout path. When the requeue
      // resolves to a per-issue worktree (issue #454/#455), the implementation run
      // executes in that worktree and starts from `origin/<base>` or the recorded
      // resume branch — it never branches off the canonical checkout's local base —
      // so an unrelated local commit on the canonical `main` cannot leak into the
      // issue branch. Refusing here would block valid worktree sessions on unrelated
      // canonical checkout state (issue #455 review).
      if (!inWorktree) {
        const aheadProbe = probe(
          "git",
          ["rev-list", "--count", `origin/${baseBranch}..${baseBranch}`],
          session.repoRoot,
        );
        if (aheadProbe.ok) {
          const aheadCount = Number.parseInt(aheadProbe.output.trim(), 10);
          if (Number.isFinite(aheadCount) && aheadCount > 0) {
            // The recovery is NEVER to push the base branch: committing Tool Request
            // side effects to the base branch is the version-control error this guard
            // exists to prevent (issue #316). Tell the operator to move those commits
            // onto the issue branch, or drop them.
            die(
              `Refusing to requeue issue #${issueNumber} in session "${sessionId}": the session's local base ` +
                `branch '${baseBranch}' is ${aheadCount} commit(s) ahead of origin/${baseBranch}. The ` +
                `implementation preflight branches each issue off this local base, so an unpushed base commit ` +
                `would leak into this and later issue branches.\n` +
                `Move those commit(s)` +
                (expectedFiles.length > 0 ? ` (covering ${expectedFiles.join(", ")})` : "") +
                ` onto the issue branch '${workBranch}', or drop them — do NOT push '${baseBranch}' — so the ` +
                `requeued run branches from a clean base, then re-run this resolve.`,
            );
          }
        }
      }

      // Worktree is clean and the base is not ahead. If the work branch exists
      // the side effects are landed on it, so hand the implementation run a resume
      // point instead of letting it collide on `git checkout -b` (issue #316). The
      // new manual-done guidance tells operators to commit/push the issue branch,
      // which they may do from another clone — leaving `ai/issue-<n>` on origin but
      // absent from this checkout. Probe origin as well as local refs so a pushed
      // issue branch still requeues with a resume point; missing it would branch a
      // fresh run from base and discard the pushed side effects (issue #316 review).
      const localBranchExists = probe(
        "git",
        ["rev-parse", "--verify", "--quiet", `refs/heads/${workBranch}`],
        session.repoRoot,
      ).ok;
      const hasOrigin = probe("git", ["remote", "get-url", "origin"], session.repoRoot).ok;
      if (localBranchExists && hasOrigin) {
        // A local issue branch is only a safe resume point once its commits are
        // on origin. The requeued implementation run can later hit ANOTHER Tool
        // Request, whose non-fix cleanup deletes the issue branch with
        // `git branch -D` (handlers/implementation.ts discardEditsToBase). If the
        // operator committed the side effects locally but forgot to push, that
        // local branch is the only ref to those commits and the drop would lose
        // them (issue #316 review). The command help/docs require committed AND
        // pushed side effects, so refuse a local-only or ahead branch here rather
        // than record it as the resume point.
        const remote = remoteHasBranch(session.repoRoot, workBranch);
        if (remote === "unknown") {
          die(
            `Refusing to resolve Tool Request for issue #${issueNumber} in session "${sessionId}": could not ` +
              `determine whether origin has the issue branch '${workBranch}' (lookup failed). The local branch ` +
              `must be confirmed pushed before requeueing, since a later Tool Request handoff deletes it with ` +
              `'git branch -D' and would lose any commits that live only in this checkout. Restore connectivity ` +
              `to origin and re-run this resolve.`,
          );
        }
        if (remote === "no") {
          die(
            `Refusing to resolve Tool Request for issue #${issueNumber} in session "${sessionId}": the issue branch ` +
              `'${workBranch}' exists only in this checkout (${session.repoRoot}) — origin has no '${workBranch}'. A ` +
              `later Tool Request handoff deletes the issue branch with 'git branch -D', so its Tool Request ` +
              `side-effect commits would be lost. Push '${workBranch}' to origin (never the base branch ` +
              `'${baseBranch}'), then re-run this resolve.`,
          );
        }
        // origin has the branch; require the local branch not to be ahead of its
        // pushed counterpart, so every side-effect commit is already on origin and
        // survives a later `git branch -D`. Fetch the branch explicitly and compare
        // against FETCH_HEAD rather than the remote-tracking ref origin/<workBranch>:
        // fresh/single-branch clones never create refs/remotes/origin/<workBranch>
        // (the fetch updates only FETCH_HEAD), so a tracking-ref compare would wrongly
        // block manual-done even though the side-effect commits are pushed (issue #316
        // review).
        //
        // This fetch writes .git/FETCH_HEAD and reaches the network/auth layer, so it
        // must not run on the --dry-run preview path, which is advertised as
        // non-persisting (issue #316 review). Defer the push-confirmation to the real
        // resolve; the preview still records the resume branch from the read-only
        // origin-presence check above.
        if (!dryRun) {
          const fetchedWorkBranch = probe("git", ["fetch", "origin", workBranch], session.repoRoot);
          if (!fetchedWorkBranch.ok) {
            die(
              `Refusing to resolve Tool Request for issue #${issueNumber} in session "${sessionId}": could not fetch ` +
                `origin '${workBranch}' to confirm the local issue branch's commits are pushed ` +
                `(git fetch origin ${workBranch} failed: ${fetchedWorkBranch.output}). Restore connectivity to origin ` +
                `in ${session.repoRoot}, then re-run this resolve.`,
            );
          }
          const aheadOfOrigin = probe(
            "git",
            ["rev-list", "--count", `FETCH_HEAD..${workBranch}`],
            session.repoRoot,
          );
          if (!aheadOfOrigin.ok) {
            // The fetch above succeeded but the local branch cannot be compared
            // against the fetched origin tip (FETCH_HEAD) — we cannot prove the local
            // branch is not ahead. Fail closed rather than record a possibly
            // local-ahead branch (issue #316 review).
            die(
              `Refusing to resolve Tool Request for issue #${issueNumber} in session "${sessionId}": cannot compare the ` +
                `local issue branch '${workBranch}' against the fetched origin tip (FETCH_HEAD), so its commits cannot ` +
                `be confirmed pushed. Resolve the repository state in ${session.repoRoot}, then re-run this resolve.`,
            );
          }
          const aheadCount = Number.parseInt(aheadOfOrigin.output.trim(), 10);
          if (Number.isFinite(aheadCount) && aheadCount > 0) {
            die(
              `Refusing to resolve Tool Request for issue #${issueNumber} in session "${sessionId}": the local issue ` +
                `branch '${workBranch}' is ${aheadCount} commit(s) ahead of origin/${workBranch}, so its Tool Request ` +
                `side-effect commits are not yet pushed. A later Tool Request handoff deletes the issue branch with ` +
                `'git branch -D' and would lose them. Push '${workBranch}' to origin (never the base branch ` +
                `'${baseBranch}'), then re-run this resolve.`,
            );
          }
        }
        toolRequestResumeBranch = workBranch;
      } else if (localBranchExists) {
        // No origin is configured, so there is no push target to reconcile
        // against and the pushed-state check does not apply. Record the local
        // branch as the resume point so the requeued run continues from the
        // landed side effects rather than branching fresh from base.
        toolRequestResumeBranch = workBranch;
      } else if (hasOrigin) {
        // Branch absent locally: it may live on origin because the operator
        // committed/pushed it from another clone (the manual-done guidance allows
        // that). Probe origin with the tri-state check: a transient ls-remote
        // failure must NOT be collapsed to "branch absent" (issue #316 review). If it
        // were, this resolve would leave `toolRequestResumeBranch` unset, the
        // requeued implementation run would branch from the base, and the side
        // effects the operator pushed from another clone would be discarded.
        // Distinguish a definite no-match (leave the resume branch unset) from a
        // lookup failure (refuse so the operator retries) instead.
        const remote = remoteHasBranch(session.repoRoot, workBranch);
        if (remote === "unknown") {
          die(
            `Refusing to resolve Tool Request for issue #${issueNumber} in session "${sessionId}": could not ` +
              `determine whether origin has the issue branch '${workBranch}' (lookup failed). Treating this as ` +
              `"branch absent" would requeue the implementation run from the base branch and discard any Tool ` +
              `Request side effects committed/pushed onto '${workBranch}' from another clone. Restore connectivity ` +
              `to origin and re-run this resolve.`,
          );
        }
        if (remote === "yes") {
          toolRequestResumeBranch = workBranch;
        }
      }

      // Issue #379: fail closed when the requested manual action left no usable
      // continuation point. If the resolution above found no resume branch — the
      // issue branch is absent both locally and on origin, and a fix-mode request
      // has no PR head to resume — then requeueing would branch a fresh
      // implementation run from the base with NONE of the prior attempt's state.
      // The agent re-derives the same missing tool/dependency state and re-emits
      // the SAME Tool Request, looping while the partial work stays discarded
      // (the exact failure issue #379 fixes). Refuse and explain the recovery
      // requirement instead of resolving the request into a dead loop. Only act on
      // a positive git signal: when the session checkout cannot be probed
      // (statusProbe not ok — e.g. repoRoot is not a checkout) we cannot prove the
      // absence of state, so proceed rather than guess, mirroring the dirty/base
      // guards above.
      if (statusProbe.ok && toolRequestResumeBranch === undefined) {
        // Tailor the recovery guidance to what the handoff actually preserved
        // (issue #390), so operators are not told to look for a patch that was
        // never produced. Three cases, distinguished by the stored request:
        //   - a patch was captured  → reapply it, run the command, commit & push
        //   - no diff was produced  → there is NO patch; just run the command on
        //                             a fresh issue branch, commit & push
        //   - capture failed        → a diff may have existed but no patch exists;
        //                             rebuild from the artifacts, commit & push
        const hasPatch = typeof existing["partialDiffArtifact"] === "string";
        const noPriorDiff = existing["noPriorDiff"] === true;
        const captureFailed = typeof existing["partialDiffCaptureFailed"] === "string";
        const recovery = hasPatch
          ? `apply the preserved partial-implementation patch from the failed run's artifact dir ` +
            `(${String(existing["partialDiffArtifact"])}), run the requested command, then commit AND push `
          : noPriorDiff
            ? `the prior attempt produced no implementation diff, so there is NO partial-implementation ` +
              `patch to apply — simply run the requested command, then commit AND push `
            : captureFailed
              ? `the prior attempt's partial-diff capture failed so no patch was written ` +
                `(${String(existing["partialDiffCaptureFailed"]).slice(0, 200)}); reconstruct the change from ` +
                `the failed run's artifacts, run the requested command, then commit AND push `
              : `apply the preserved partial-implementation patch from the failed run's artifact dir ` +
                `(partial-implementation.patch) if present, run the requested command, then commit AND push `;
        die(
          `Refusing to requeue issue #${issueNumber} in session "${sessionId}": the previous Tool ` +
            `Request attempt left no usable continuation point. The issue branch '${workBranch}' is ` +
            `absent both locally and on origin, there is no PR to resume from, and the requested ` +
            `command's side effects` +
            (expectedFiles.length > 0 ? ` (expected: ${expectedFiles.join(", ")})` : "") +
            ` are not committed anywhere reachable. Requeueing now would branch a fresh implementation ` +
            `run from the base branch '${baseBranch}' with none of the prior work, so the agent would ` +
            `hit the same blocker and re-request the same command — a Tool Request loop.\n` +
            `Recover by landing the change on the issue branch '${workBranch}': in ${session.repoRoot}, ` +
            recovery +
            `'${workBranch}' to origin (never the base branch '${baseBranch}'). Re-run this resolve once ` +
            `that branch exists. If the request should not proceed, use ` +
            `'tool-request resolve --action reject' instead.`,
        );
      }
    }

    if (dryRun) {
      emit({
        ok: true,
        dryRun: true,
        sessionId,
        issueNumber,
        action,
        previousStatus: task.status,
        previousPhase: task.phase,
        wouldRequeue: requeue ? { status: targetStatus, phase: targetPhase } : null,
        message: boundedMessage ?? null,
      });
      return;
    }

    const result = await store.transitionTask(
      { sessionId, issueNumber },
      { status: task.status },
      {
        status: targetStatus,
        phase: targetPhase,
        ...(requeue ? { ownerRunId: undefined, leaseExpiresAt: undefined, lastError: undefined } : {}),
        context: {
          toolRequest: resolvedToolRequest,
          // Always write the key, clearing it (undefined) when this resolve found
          // no issue branch to resume from. Omitting it would let applyTaskPatch's
          // context merge preserve a stale toolRequestResumeBranch from an earlier
          // Tool Request, so the next implementation run would fetch/continue from
          // the wrong branch (issue #316 review). JSON.stringify drops the
          // undefined value, removing the key from the persisted context.
          toolRequestResumeBranch,
        },
        now,
      },
    );
    if (!result.ok) {
      die(
        `Failed to resolve Tool Request: ${result.code}` +
          (result.current ? ` (current status: ${result.current.status})` : ""),
      );
    }

    const runId = `admin-tool-request-resolve-${now}`;
    const owner = session.githubOwner;
    const repo = session.githubName;
    // Route the label transitions and status comment below through the session's
    // work-item provider so a non-GitHub session posts them to the work-item repo
    // instead of stranding the legacy `gh:*` rows behind the dispatcher's failing
    // GitHub runner; no-op passthrough for a GitHub session.
    const workItemStore = workItemOutbox(outboxStore, session);

    // On manual-done, swap the public labels back to the implementation lane:
    // drop the ready-for-human marker and re-advertise the queue status (needs-fix
    // for a fix-mode request, otherwise needs-implementation) + the implementation
    // agent so a label-driven recovery/intake scan stays consistent with the
    // requeued DB task. On reject the task stays a human handoff, so its
    // ready-for-human labelling is left untouched.
    if (requeue) {
      const readyForHumanLabel = session.labels["readyForHuman"] as string | undefined;
      // A Tool Request recorded from fix mode (mode: "fix", or with preserved
      // review feedback on the task) must requeue under the fix-lane status label,
      // not the implementation one. Re-advertising status:needs-implementation
      // would present the resolved request as fresh implementation work — or, if a
      // stale status:needs-fix lingered, leave both implementation statuses on the
      // issue (issue #291 review follow-up). Mirrors handler fix-mode detection.
      const isFixModeRequest =
        existing["mode"] === "fix" ||
        (typeof task.context["reviewFeedback"] === "string" &&
          (task.context["reviewFeedback"] as string).trim().length > 0);
      const queueStatusLabel = isFixModeRequest
        ? ((session.labels["needsFix"] as string | undefined) ?? "status:needs-fix")
        : ((session.labels["needsImplementation"] as string | undefined) ?? "status:needs-implementation");
      // Resolve the implementation agent the same way phase handling does
      // (assignment profile → task column → session default) so a legacy or manually
      // enqueued task with no persisted assignment relabels with the session default
      // implementation agent (e.g. codex/gemini) rather than always advertising
      // agent:claude, which would misroute label-driven recovery/intake (issue #291
      // review follow-up).
      const resolvedImplAgentId = agentForPhase(task, session, "implementation");
      const implAgentLabel = resolvedImplAgentId ? `agent:${resolvedImplAgentId}` : ((session.labels["agentImplementation"] as string | undefined) ?? "agent:claude");
      const removeLabels = readyForHumanLabel ? [readyForHumanLabel] : [];
      for (const label of removeLabels) {
        await workItemStore.enqueue({
          idempotencyKey: makeOutboxKey(sessionId, issueNumber, runId, "gh:label:remove", label),
          topic: "gh:label:remove",
          payload: { topic: "gh:label:remove", owner, repo, issueNumber, label },
          now,
        });
      }
      for (const label of [queueStatusLabel, implAgentLabel]) {
        await workItemStore.enqueue({
          idempotencyKey: makeOutboxKey(sessionId, issueNumber, runId, "gh:label:add", label),
          topic: "gh:label:add",
          payload: { topic: "gh:label:add", owner, repo, issueNumber, label },
          now,
        });
      }
    }

    // Public status comment: announce the operator's decision. Uses the REDACTED
    // display command (never the exact command — docs §2.4); the operator note is
    // bounded and path-sanitized above. If no display form was stored (e.g. a
    // legacy/manual DB row — readStoredToolRequest accepts any object), re-redact
    // the exact command rather than posting it verbatim, since the later
    // sanitizeBody only strips paths and would let token/secret flag values leak.
    const displayCommand =
      typeof existing["displayCommand"] === "string" && existing["displayCommand"].trim().length > 0
        ? existing["displayCommand"]
        : typeof existing["command"] === "string" && existing["command"].trim().length > 0
          ? redactCommand(existing["command"])
          : "(unspecified)";
    let commentBody = action === "manual-done"
      ? `✅ **Tool Request marked as manually completed by operator.**\n\n` +
        `Requested command: \`${displayCommand}\`\n\n` +
        `This does not approve the command for future automated runs. It signals that the operator has already run the command externally and made the side effects visible to the repository (committed and pushed). The task has been re-queued for implementation.\n\n` +
        `If the agent re-requests the same command, the repository state still appears unchanged — verify that the expected changed files were committed and pushed before this resolve.`
      : `🚫 **Tool Request rejected by operator.**\n\n` +
        `Requested command: \`${displayCommand}\`\n\n` +
        `The request will not be actioned automatically.`;
    if (boundedMessage !== undefined) {
      commentBody += `\n\n> ${boundedMessage.replace(/\n/g, "\n> ")}`;
    }
    commentBody = sanitizeBody(commentBody, sessionRedactionPaths(session));
    await workItemStore.enqueue({
      idempotencyKey: makeOutboxKey(sessionId, issueNumber, runId, "gh:comment", "tool-request-resolve", action),
      topic: "gh:comment",
      payload: { topic: "gh:comment", owner, repo, issueNumber, body: commentBody },
      now,
    });

    await store.appendEvent({
      task: { sessionId, issueNumber },
      type: "tool_request_resolved",
      runId,
      message: `Operator resolved Tool Request for issue #${issueNumber} (action: ${action})`,
      data: {
        action,
        requeued: requeue,
        previousStatus: task.status,
        previousPhase: task.phase,
        hasMessage: boundedMessage !== undefined,
      },
      createdAt: now,
    });

    emit({
      ok: true,
      sessionId,
      issueNumber,
      action,
      status: result.value.status,
      phase: result.value.phase,
      previousStatus: task.status,
      previousPhase: task.phase,
      requeued: requeue,
      message: boundedMessage ?? null,
    });
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

// Execution budget and capture buffer for a granted command. The buffer matches
// the verification/dependency-sync ceilings so a verbose-but-successful command
// is not misreported as a failure by overflowing Node's default exec buffer.
const GRANT_EXEC_DEFAULT_TIMEOUT_MS = 120_000;
const GRANT_EXEC_MAX_BUFFER_BYTES = 80 * 1024 * 1024;

/** Disposition for the changes a guided run produces (issue #430, redesign §4.3).
 *   - `keep`  : leave produced changes on the issue branch for the operator to
 *               handle (the pre-redesign behavior; the safe default).
 *   - `commit`: the orchestrator commits and pushes them on the issue branch and
 *               re-queues — the central improvement over the old `grant`.
 *   - `discard`: revert the produced changes (partial-diff snapshot preserved). */
const GUIDED_RUN_DISPOSITIONS = ["keep", "commit", "discard"] as const;
type GuidedRunDisposition = (typeof GUIDED_RUN_DISPOSITIONS)[number];

interface ToolRequestGrantArgs {
  sessionId: string;
  issueNumber: number;
  command: string | undefined;
  ttlSeconds: number | undefined;
  maxUses: number | undefined;
  disposition: GuidedRunDisposition;
  sessionsPath: string;
  dbPath: string | undefined;
  lockDir: string | undefined;
  dryRun: boolean;
  /** Operator-chosen outcome for changes the granted command leaves behind
   * (issue #419). Undefined preserves the legacy behavior: changes are left on
   * the issue branch for the operator to commit/push manually. */
  onChanges: RepoChangeAction | undefined;
  /** Required to proceed with the destructive `--on-changes discard`. */
  confirmDiscard: boolean;
  /** Allow `--on-changes commit` to include files outside the request's
   * expected files (they are surfaced and refused without this). */
  allowUnexpected: boolean;
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
    command: args["command"],
    ttlSeconds,
    maxUses,
    disposition,
    sessionsPath: opts.sessionsPath,
    dbPath: opts.dbPath,
    lockDir: args["lock-dir"],
    dryRun: opts.dryRun,
    onChanges,
    confirmDiscard: opts.flags.has("confirm-discard"),
    allowUnexpected: opts.flags.has("allow-unexpected"),
  };
}

async function runToolRequestGrant(argv: string[], surface: "grant" | "run" = "grant"): Promise<void> {
  const parsed = parseToolRequestGrantArgs(argv);
  if ("error" in parsed) die(parsed.error);

  const { sessionId, issueNumber, command, ttlSeconds, maxUses, disposition, sessionsPath, dbPath, lockDir, dryRun, onChanges, confirmDiscard, allowUnexpected } = parsed;

  // The redesigned operator surface is the "guided run" (`tool-request run`,
  // issue #430); `tool-request grant` is retained as a deprecated alias. The two
  // share this engine but tag their operator-response record differently so the
  // continuation prompt reads naturally ("guided-run (changes committed)" vs the
  // legacy "grant"). The grant scope/hash authorization primitive is unchanged.
  const actionLabel = surface === "run" ? "guided-run" : "grant";

  let registry: JsonSessionRegistry;
  try {
    registry = new JsonSessionRegistry(sessionsPath);
  } catch (err) {
    die(`Failed to load sessions file (${sessionsPath}): ${err instanceof Error ? err.message : String(err)}`);
  }

  const session = await registry.getSessionById(sessionId);
  if (!session) {
    die(`Unknown sessionId: ${sessionId} (not found in ${sessionsPath})`);
  }

  const now = new Date().toISOString();
  const store = new SqliteTaskStore(dbPath);
  const outboxStore = new SqliteOutboxStore(dbPath);

  // Granted commands mutate the shared checkout, so they must respect the same
  // single-worker concurrency control as workflow executions. The lock is
  // acquired below (after validation, before the preflight) and held across the
  // preflight, command execution, and post-probe. `releaseLock` is invoked both
  // on the normal-completion paths (via the finally below) and before every
  // die() inside the critical section (via `lockedDie`), since die() calls
  // process.exit() which bypasses finally.
  const lockStore = new RepoLockStore(lockDir);
  const GRANT_LOCK_CONTEXT_ID = "admin-tool-request-grant";
  let lockHeld = false;
  const releaseLock = (): void => {
    if (lockHeld) {
      lockStore.release(GRANT_LOCK_CONTEXT_ID, sessionId);
      lockHeld = false;
    }
  };
  // Declared as a function (not a const arrow) so TypeScript's never-return
  // control-flow analysis narrows unions after `lockedDie(...)` calls the same
  // way the imported `die` does (e.g. `if (!result.ok) lockedDie(...)` leaves
  // `result` narrowed to the success branch below).
  function lockedDie(message: string): never {
    releaseLock();
    die(message);
  }

  try {
    const tasks = store.listTasks(sessionId, issueNumber);
    if (tasks.length === 0) {
      die(`Task not found: session "${sessionId}", issue #${issueNumber}`);
    }
    const task = tasks[0];

    const existing = readStoredToolRequest(task);
    if (!existing) {
      die(`Issue #${issueNumber} in session "${sessionId}" has no Tool Request to grant.`);
    }
    if (existing["resolved"] === true) {
      die(`Tool Request for issue #${issueNumber} in session "${sessionId}" is already resolved.`);
    }
    if (task.status === "claimed" || task.status === "running") {
      die(
        `Task #${issueNumber} in session "${sessionId}" is currently ${task.status}` +
          (task.ownerRunId ? ` (owner: ${task.ownerRunId})` : "") +
          `. Refusing to grant against an active task. Wait for it to complete or recover it first.`,
      );
    }

    const requestedCommand = typeof existing["command"] === "string" ? existing["command"].trim() : "";
    if (requestedCommand.length === 0) {
      die(`Tool Request for issue #${issueNumber} has no recorded command to grant.`);
    }

    // The granted command defaults to the exact requested command. Grants are
    // exact-command only (a non-goal of this feature is broad/wildcard approval),
    // so an operator-supplied --command must be the SAME command (ignoring only
    // insignificant whitespace) — never a different or broadened one.
    const grantedCommand = (command ?? requestedCommand).trim();
    if (grantedCommand.length === 0) {
      die(`--command must not be empty.`);
    }
    if (normalizeCommand(grantedCommand) !== normalizeCommand(requestedCommand)) {
      die(
        `Grants are exact-command only: --command must equal the requested command for issue #${issueNumber}. ` +
          `Requested (redacted): \`${redactCommand(requestedCommand)}\`. ` +
          `If a different command is needed, reject this request and have the agent re-request it.`,
      );
    }

    const candidate: GrantCandidate = {
      sessionId,
      issueNumber,
      phase: task.phase,
      repoRoot: session.repoRoot,
      command: grantedCommand,
    };

    // Reuse guard: a grant for this exact command may already exist on the task
    // (e.g. a prior grant whose execution failed left the request unresolved).
    // Grants are one-shot, so a previously-issued grant for the same scoped
    // command is never silently re-run — refuse and tell the operator to grant a
    // corrected command or reject. A stored grant for a DIFFERENT command does
    // not match (scope-mismatch) and does not block a fresh grant.
    //
    // Exception 1 (issue #419 review): a disposition-only retry. When the
    // prior grant's command already ran and produced changes, but the guided
    // `--on-changes` disposition was refused for a CORRECTABLE reason (a discard
    // without `--confirm-discard`, or a commit with unexpected files but no
    // `--allow-unexpected`), the side effects are already on disk and the operator
    // just needs to re-pick/authorize the disposition. Re-running the command
    // would duplicate its side effects and violate one-shot, so instead reuse the
    // consumed grant and apply the freshly-supplied disposition to the existing
    // changes WITHOUT re-executing — see `dispositionRetry` below.
    //
    // Exception 2 (issue #490): a fresh Tool Request instance with the same
    // command. After a successful guided-run the task is requeued; the agent may
    // then emit a new Tool Request for the same command after another fix pass.
    // The stored grant was for the EARLIER request. If the current Tool Request's
    // `requestedAt` is after the stored grant's `grantedAt`, it must be a new
    // instance — the operator should be allowed to approve it with a fresh grant.
    let dispositionRetry = false;
    let reusableGrant: ToolRequestGrant | undefined;
    const storedGrantRaw = task.context["toolRequestGrant"];
    if (storedGrantRaw && typeof storedGrantRaw === "object" && !Array.isArray(storedGrantRaw)) {
      const prior = storedGrantRaw as unknown as ToolRequestGrant;
      const priorMatch = grantMatches(prior, candidate, now);
      if (priorMatch.ok || priorMatch.reason !== "scope-mismatch") {
        // Exception 2: the current Tool Request was submitted AFTER the stored
        // grant was issued — it is a distinct instance, not a reuse attempt.
        const currentRequestedAt =
          typeof existing["requestedAt"] === "string" ? existing["requestedAt"] : "";
        const isFreshToolRequest =
          currentRequestedAt.length > 0 &&
          new Date(currentRequestedAt).getTime() > new Date(prior.grantedAt).getTime();
        if (!isFreshToolRequest) {
          const priorChange = task.context["toolRequestChangeAction"];
          const correctableRefusal =
            priorChange !== null &&
            typeof priorChange === "object" &&
            !Array.isArray(priorChange) &&
            (priorChange as Record<string, unknown>)["outcome"] === "refused" &&
            (priorChange as Record<string, unknown>)["correctable"] === true;
          if (onChanges !== undefined && correctableRefusal) {
            dispositionRetry = true;
            reusableGrant = prior;
          } else {
            die(
              `A grant for this exact command was already issued for issue #${issueNumber} ` +
                `(status: ${grantStatus(prior, now)}). Grants are one-shot and cannot be reused. ` +
                `Grant a corrected command, or use 'tool-request resolve --action reject'.`,
            );
          }
        }
      }
    }

    const displayCommand =
      typeof existing["displayCommand"] === "string" && existing["displayCommand"].trim().length > 0
        ? existing["displayCommand"].trim()
        : redactCommand(grantedCommand);

    // A disposition-only retry reuses the already-consumed prior grant (the
    // command is not re-run), so it must NOT mint a fresh grant.
    const grant =
      dispositionRetry && reusableGrant
        ? reusableGrant
        : createToolRequestGrant({
            sessionId,
            issueNumber,
            phase: task.phase,
            repoRoot: session.repoRoot,
            command: grantedCommand,
            displayCommand,
            grantedBy: "admin",
            ...(ttlSeconds !== undefined ? { ttlMs: ttlSeconds * 1000 } : {}),
            ...(maxUses !== undefined ? { maxUses } : {}),
            now,
          });

    // Sanity: the grant we just minted must authorize the candidate. (A failure
    // here would indicate a hashing/scoping bug, not operator error.) Skipped for
    // a disposition-only retry, which deliberately reuses an already-consumed (and
    // possibly expired) grant — authorization to RUN the command is not required
    // because the command is not re-run.
    if (!dispositionRetry) {
      const auth = grantMatches(grant, candidate, now);
      if (!auth.ok) {
        die(`Internal error: freshly created grant does not authorize the command (${auth.detail}).`);
      }
    }

    // Take the repo lock before the preflight so the dirty-tree/base-ahead probes,
    // the command execution, and the post-probe all run as one critical section.
    // Refuse if another workflow execution for this session already holds it:
    // running a checkout-mutating command alongside an active worker would race
    // with its branch/dirty-tree operations and bypass single-worker concurrency.
    const acquired = lockStore.acquire(GRANT_LOCK_CONTEXT_ID, sessionId, now);
    if (!acquired.locked) {
      die(
        `Refusing to execute the granted command for issue #${issueNumber}: the repo lock for session ` +
          `'${sessionId}' is held by context '${acquired.ownerContextId}' (since ${acquired.ownerStartedAt}). ` +
          `A worker is active on this checkout; wait for it to finish, then re-run this grant.`,
      );
    }
    lockHeld = true;

    // Where the granted command and all its working-tree git operations run. For a
    // worktree-enabled session the implementation phase for this issue checked
    // `ai/issue-<n>` out in its own per-issue worktree (and a Tool Request handoff
    // committed the partial work there), so the issue branch is ALREADY checked out
    // away from the canonical checkout. Running the grant in `session.repoRoot` would
    // make `moveToToolRequestBranch`'s `git checkout ai/issue-<n>` fail — git refuses
    // to check a branch out in two worktrees — and the command's side effects belong
    // on the issue branch beside the agent's edits, not the canonical tree (issue
    // #454 review). Resolve the per-issue worktree and run there when one exists; fall
    // back to the shared checkout when worktrees are disabled, or for the issues that
    // still run on the shared checkout (fix-mode / dependency-stack), where no managed
    // worktree is registered for this issue.
    let grantRepoCwd = session.repoRoot;
    if (session.worktrees?.enabled === true) {
      let worktreeRoot: string;
      try {
        worktreeRoot = resolveWorktreeRoot({ sessionRoot: session.worktrees.root });
      } catch (err) {
        lockedDie(
          `Refusing to execute the granted command for issue #${issueNumber}: the session enables per-issue ` +
            `worktrees but its worktree root is misconfigured: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      const worktreePath = canonicalizePath(issueWorktreePath(worktreeRoot, sessionId, issueNumber));
      const listed = listWorktrees(session.repoRoot);
      const entry = listed.ok
        ? listed.worktrees.find((w) => canonicalizePath(w.path) === worktreePath)
        : undefined;
      if (entry && !entry.prunable && existsSync(worktreePath)) {
        grantRepoCwd = worktreePath;
      }
    }
    // True when the grant runs in a per-issue worktree rather than the canonical
    // checkout — used to skip shared-checkout-only tidy-up (e.g. checking the base
    // branch back out) that would fail or move the worktree off its issue branch.
    const worktreeGrant = grantRepoCwd !== session.repoRoot;

    // A clean worktree is required before execution: the granted command commonly
    // mutates the repo (e.g. `npm install` rewriting lockfiles), and on success
    // the task is re-queued into the implementation lane whose preflight aborts a
    // dirty tree. Running on a dirty tree would also mix unrelated local edits
    // into whatever the command produces. Only block on a positive dirty signal;
    // if git can't be probed (repoRoot is not a checkout) proceed rather than guess.
    // A disposition-only retry expects a dirty tree — it is the prior command's
    // output that we are now dispositioning — so the clean-tree precondition does
    // not apply (the command is not re-run on it).
    const statusProbe = probe("git", ["status", "--porcelain"], grantRepoCwd);
    if (!dispositionRetry && statusProbe.ok && statusProbe.output.length > 0) {
      lockedDie(
        `Refusing to execute the granted command for issue #${issueNumber}: the ${worktreeGrant ? "issue worktree" : "session checkout"} ` +
          `(${grantRepoCwd}) is dirty. Commit or discard local changes so the command runs from a ` +
          `clean tree, then re-run this grant.\nWorktree:\n${statusProbe.output.slice(0, 300)}`,
      );
    }
    // A clean worktree is not sufficient when we will requeue on success: a local
    // base branch ahead of origin would leak unpushed commits into later issue
    // branches via the implementation preflight (mirrors tool-request resolve).
    //
    // Only on the shared-checkout path. When the grant runs in a per-issue worktree
    // (issue #454/#455), the requeued implementation executes in that worktree and
    // starts from `origin/<base>` or the recorded resume branch — it never branches
    // off the canonical checkout's local base — so an unrelated commit on the
    // canonical `main` cannot leak into the issue branch. The base-ahead comparison
    // here reads the shared `main` ref (`origin/main..main`) regardless of
    // `grantRepoCwd`, so leaving it active would refuse valid worktree grants solely
    // because the canonical checkout's base is ahead (issue #455 review).
    const baseBranch = session.baseBranch ?? "main";
    if (!worktreeGrant) {
      const aheadProbe = probe("git", ["rev-list", "--count", `origin/${baseBranch}..${baseBranch}`], grantRepoCwd);
      if (aheadProbe.ok) {
        const aheadCount = Number.parseInt(aheadProbe.output.trim(), 10);
        if (Number.isFinite(aheadCount) && aheadCount > 0) {
          // Never tell the operator to push the base branch: committing Tool Request
          // side effects to the base is exactly the error this guard prevents (issue
          // #316). Direct them to move the commits onto the issue branch, or drop them.
          lockedDie(
            `Refusing to execute the granted command for issue #${issueNumber}: the session's local base ` +
              `branch '${baseBranch}' is ${aheadCount} commit(s) ahead of origin/${baseBranch}. A successful ` +
              `grant re-queues the task and the implementation preflight branches each issue off this local ` +
              `base, so an unpushed base commit would leak into later issue branches. Move those commit(s) ` +
              `onto the issue branch, or drop them — do NOT push '${baseBranch}' — then re-run this grant.`,
          );
        }
      }
    }

    // The granted command's side effects must land on the issue branch, never the
    // base branch (issue #316): the existing PR head branch when one exists, else
    // the conventional `ai/issue-<n>` branch (created from the base in the
    // initial-implementation case where no PR exists yet).
    const workBranch = resolveToolRequestWorkBranch(task, issueNumber);

    if (dryRun) {
      emit({
        ok: true,
        dryRun: true,
        sessionId,
        issueNumber,
        action: actionLabel,
        branch: workBranch,
        grant: {
          phase: grant.phase,
          repoRoot: grant.repoRoot,
          commandHash: grant.commandHash,
          displayCommand: grant.displayCommand,
          expiresAt: grant.expiresAt,
          maxUses: grant.maxUses,
        },
        disposition,
        wouldExecute: true,
      });
      return;
    }

    // Move the checkout onto the issue branch before running anything, inside this
    // same locked critical section. Creating/checking out the branch here is what
    // keeps the side effects off the base branch (issue #316). Fail closed if the
    // checkout cannot safely move there.
    // In dependency-start-point mode the issue branch must be rebuilt on the
    // blocker PR head, not the base branch (issue #316 review) — the implementation
    // handler deleted the temporary branch at handoff and recorded the blocker head.
    const depStartPoint = resolveToolRequestDependencyHead(task);
    // Whether `workBranch` is the task's recorded PR head (vs the conventional
    // `ai/issue-<n>` name). A recorded PR head that exists nowhere must fail
    // closed rather than be rebuilt from the base (issue #316 review).
    const { branch: recordedPrBranch } = resolvePrContext(task);
    const fromRecordedPr = !!recordedPrBranch && recordedPrBranch.trim() === workBranch;
    const moved = moveToToolRequestBranch(
      grantRepoCwd,
      workBranch,
      baseBranch,
      depStartPoint,
      fromRecordedPr,
    );
    if (!moved.ok) {
      lockedDie(
        `Refusing to execute the granted command for issue #${issueNumber}: could not move the checkout ` +
          `to the issue branch '${workBranch}' (so the command never runs on the base branch '${baseBranch}'). ` +
          `${moved.error}`,
      );
    }
    // HEAD on the work branch before the command runs, so we can tell afterwards
    // whether the command committed onto the issue branch (clean tree but advanced
    // HEAD) versus left only uncommitted changes versus was a true no-op.
    const headBeforeProbe = probe("git", ["rev-parse", "HEAD"], grantRepoCwd);

    // Execute the EXACT granted command — handler-owned, outside the agent tool
    // surface. Run it through a shell so the operator's approved command is
    // interpreted with normal shell semantics: leading environment assignments
    // (e.g. `NPM_TOKEN=... npm install`), operators like `&&`/`|`, and quoting all
    // behave as written. Tokenizing into an argv and running with execFileSync
    // would instead try to exec a binary literally named `NPM_TOKEN=...` or pass
    // `&&` as an argument, so the granted command would fail or behave differently
    // from the request the operator approved.
    const executedAt = new Date().toISOString();
    // Use the both-streams runner so the artifact captures stderr even when the
    // command exits 0 (the grant contract records stdout/stderr/exit code for the
    // exact command regardless of outcome); execFileSync drops success stderr.
    //
    // A disposition-only retry must NOT re-run the command (one-shot): the prior
    // grant already ran it and left the changes on disk. Synthesize a successful
    // no-op result so the flow proceeds straight to guided change handling, and
    // reuse the already-consumed grant unchanged (`uses` is not incremented).
    const runResult: CommandRunResult = dispositionRetry
      ? { exitCode: 0, stdout: "", stderr: "" }
      : bothStreamsCommandRunner.run("/bin/sh", ["-c", grantedCommand], {
          cwd: grantRepoCwd,
          timeout: GRANT_EXEC_DEFAULT_TIMEOUT_MS,
          maxBuffer: GRANT_EXEC_MAX_BUFFER_BYTES,
        });
    const consumedGrant: ToolRequestGrant = dispositionRetry
      ? grant
      : {
          ...grant,
          uses: grant.uses + 1,
          lastResult: { exitCode: runResult.exitCode, executedAt },
        };
    const success = runResult.exitCode === 0;
    // Captured execution result folded into the operator-response record so the
    // next implementation prompt replays what the command produced (issue #430,
    // redesign §7). For a no-op verification command this captured output is the
    // deliverable the agent was missing. Bounded like the local artifact above.
    const capturedResult = {
      exitCode: runResult.exitCode,
      stdout: boundVerificationOutput(runResult.stdout),
      stderr: boundVerificationOutput(runResult.stderr),
    };

    // Capture stdout/stderr/exit code in a LOCAL artifact (never public). The
    // exact command and full output stay here; only the redacted command and the
    // exit code reach the task event / public comment.
    const runId = `admin-tool-request-grant-${now}`;
    const artifactDir = runArtifactDir(session.artifactRoot, runId);
    try {
      mkdirSync(artifactDir, { recursive: true });
      writeFileSync(
        join(artifactDir, "tool-request-grant.json"),
        JSON.stringify(
          {
            sessionId,
            issueNumber,
            runId,
            phase: grant.phase,
            command: grantedCommand,
            displayCommand,
            commandHash: grant.commandHash,
            // A disposition-only retry reuses the prior run's output without
            // re-executing the command; mark it so the artifact is not misread as
            // a second execution (its stdout/stderr are empty by construction).
            dispositionRetry,
            exitCode: runResult.exitCode,
            success,
            executedAt,
            stdout: boundVerificationOutput(runResult.stdout),
            stderr: boundVerificationOutput(runResult.stderr),
            grant: consumedGrant,
          },
          null,
          2,
        ),
        "utf8",
      );
    } catch {
      // Best-effort: the outcome is still recorded in the DB event below.
    }

    // Drop this run's local artifact from the working tree before requeueing.
    // The success paths that re-queue (true no-op, `--disposition commit`) hand
    // the task back to the implementation lane, whose preflight runs a PLAIN
    // `git status --porcelain` (it does NOT share the `:(exclude)` pathspec used
    // for the dirtiness probe below). The artifact (`tool-request-grant.json`)
    // was just written under `session.artifactDir`; when the target repo does not
    // gitignore that directory it sits in the tree as an untracked file, so the
    // requeued preflight would abort as dirty and strand the just-requeued Tool
    // Request (issue #430 review). Remove this run's artifact subtree only when
    // git reports it as a working-tree change — i.e. the dir is NOT gitignored;
    // when it is gitignored the probe is empty, nothing is removed, and the local
    // record is preserved as before. The pre-run preflight required a fully clean
    // tree, so this run's artifact is the only untracked artifact to clear.
    const cleanArtifactBeforeRequeue = (): void => {
      const artifactStatus = probe("git", ["status", "--porcelain", "--", artifactDir], session.repoRoot);
      if (artifactStatus.ok && artifactStatus.output.length > 0) {
        try {
          rmSync(artifactDir, { recursive: true, force: true });
        } catch {
          // Best-effort: the outcome is already recorded in the DB event and the
          // resolution context, so continuation context survives even if the
          // artifact lingers and the next preflight has to be re-run.
        }
      }
    };

    const owner = session.githubOwner;
    const repo = session.githubName;
    // Route the label transitions and status comments below through the session's
    // work-item provider so a non-GitHub session posts them to the work-item repo
    // instead of stranding the legacy `gh:*` rows behind the dispatcher's failing
    // GitHub runner; no-op passthrough for a GitHub session.
    const workItemStore = workItemOutbox(outboxStore, session);

    if (success) {
      // The command succeeded, and (issue #316) it ran on the issue branch
      // `workBranch`, not the base branch. Whether we can safely re-queue now
      // depends on what it left behind on that branch:
      //   - true no-op (clean tree, HEAD unmoved) → resolve as a grant and
      //     re-queue, mirroring manual-done.
      //   - changes on the issue branch (dirty tree OR a new commit on the branch)
      //     → keep the request open and hand back to the operator: the changes are
      //     already on the issue branch and must be committed + pushed THERE (never
      //     the base branch). `tool-request resolve --action manual-done` re-queues
      //     once they are landed.
      // Exclude the session artifact directory from the dirtiness check. The
      // local run artifact (`tool-request-grant.json`) was just written under
      // `session.artifactDir`; when the target repo does not gitignore that
      // directory, a bare `git status --porcelain` would report it and make a
      // genuine no-op command look like it produced changes — routing it off the
      // documented no-op requeue path and (under `--disposition commit`) into an
      // artifact-only commit that fails for having no real changes (issue #430
      // review). The `:(exclude)` pathspec drops the artifact subtree; it is a
      // silent no-op when the dir is gitignored and so never appears anyway.
      const afterProbe = probe(
        "git",
        ["status", "--porcelain", "--", ".", `:(exclude)${session.artifactDir}`],
        grantRepoCwd,
      );
      const dirtyAfter = afterProbe.ok && afterProbe.output.length > 0;
      // Did the command commit onto the issue branch (clean tree but HEAD moved)?
      const headAfterProbe = probe("git", ["rev-parse", "HEAD"], grantRepoCwd);
      const committedOnBranch =
        headBeforeProbe.ok && headAfterProbe.ok && headBeforeProbe.output !== headAfterProbe.output;
      const producedChanges = dirtyAfter || committedOnBranch;

      // Defense-in-depth: even though the command ran on the issue branch, it
      // could have checked out the base and committed to it directly (e.g.
      // `git checkout main && git commit ...`), advancing the local base past
      // origin. That also moves HEAD, so `producedChanges` is true — re-probe the
      // base UNCONDITIONALLY (not only for the true-no-op case) so the base-ahead
      // handoff below still fires. Otherwise the "changes on issue branch" path
      // would mislabel a base commit as issue work and release the repo lock with
      // the local base ahead of origin, leaking the unpushed commit into later
      // issue branches via the implementation preflight (issue #316 review).
      //
      // Shared-checkout path only. In worktree mode (issue #454/#455) this probe
      // reads the shared `origin/<base>..<base>` ref — which reflects the canonical
      // checkout's local base regardless of `grantRepoCwd` — so an unrelated commit
      // on the canonical `main` would be misread as command-induced base
      // contamination and route this clean no-op into the base-ahead handoff,
      // refusing a valid requeue. The requeued implementation runs in the worktree
      // and starts from `origin/<base>` or the recorded resume branch, never the
      // canonical local base, so no unpushed canonical commit can leak into the
      // issue branch; and the command cannot itself advance the base in the worktree
      // (the base branch is checked out in the canonical worktree, so `git checkout
      // <base>` there fails). Treat the base as not ahead (issue #455 review).
      let baseAheadCountAfter = 0;
      if (!worktreeGrant) {
        const aheadAfterProbe = probe(
          "git",
          ["rev-list", "--count", `origin/${baseBranch}..${baseBranch}`],
          grantRepoCwd,
        );
        if (aheadAfterProbe.ok) {
          const parsed = Number.parseInt(aheadAfterProbe.output.trim(), 10);
          if (Number.isFinite(parsed) && parsed > 0) {
            baseAheadCountAfter = parsed;
          }
        }
      }

      // Defense-in-depth (2): a dirty worktree only counts as issue-branch work
      // when HEAD is still on the issue branch. A command that ran
      // `git checkout <base> && <edit>` (without committing) leaves `dirtyAfter`
      // true while `baseAheadCountAfter` stays 0 — no commit advanced the base — so
      // the changes-on-issue-branch path below would mislabel base contamination as
      // issue work and release the repo lock with the dirty tree sitting on the base
      // branch. Probe HEAD and, when it is no longer `workBranch`, fail closed via an
      // operator handoff that says to move/drop the changes, never push the base
      // (issue #316 review). Fail closed too when HEAD cannot be determined. A
      // command that also *committed* onto the base advances the count, so leave
      // those to the base-ahead handoff below (`baseAheadCountAfter === 0` here).
      const currentBranchAfterProbe = probe("git", ["rev-parse", "--abbrev-ref", "HEAD"], grantRepoCwd);
      const onWorkBranchAfter = currentBranchAfterProbe.ok && currentBranchAfterProbe.output === workBranch;
      if (producedChanges && baseAheadCountAfter === 0 && !onWorkBranchAfter) {
        const headLabel = currentBranchAfterProbe.ok
          ? `\`${currentBranchAfterProbe.output}\``
          : "an undetermined branch (could not read HEAD)";
        const result = await store.transitionTask(
          { sessionId, issueNumber },
          { status: task.status },
          { status: task.status, phase: task.phase, context: { toolRequestGrant: consumedGrant }, now },
        );
        if (!result.ok) {
          lockedDie(`Failed to record grant: ${result.code}` + (result.current ? ` (current status: ${result.current.status})` : ""));
        }

        let commentBody =
          `✅ **Tool Request granted command executed by operator.**\n\n` +
          `Approved command: \`${displayCommand}\`\n\n` +
          `The command completed successfully but left changes while HEAD was on ${headLabel}, ` +
          `not the issue branch \`${workBranch}\`. The task was **not** re-queued automatically to ` +
          `avoid recording base-branch contamination as issue work. Move the changes onto the issue ` +
          `branch \`${workBranch}\` (or drop them) — do NOT push \`${baseBranch}\` — then run ` +
          `\`tool-request resolve --action manual-done\` to re-queue from a clean tree.`;
        commentBody = sanitizeBody(commentBody, sessionRedactionPaths(session));
        await workItemStore.enqueue({
          idempotencyKey: makeOutboxKey(sessionId, issueNumber, runId, "gh:comment", "tool-request-grant", "success-off-branch-changes"),
          topic: "gh:comment",
          payload: { topic: "gh:comment", owner, repo, issueNumber, body: commentBody },
          now,
        });

        await store.appendEvent({
          task: { sessionId, issueNumber },
          type: "tool_request_grant_executed",
          runId,
          message: `Operator granted and executed Tool Request command for issue #${issueNumber} (exit 0, changes left off issue branch ${workBranch})`,
          data: {
            exitCode: 0,
            success: true,
            commandHash: grant.commandHash,
            requeued: false,
            dirtyAfter,
            committedOnBranch,
            branch: workBranch,
            headAfter: currentBranchAfterProbe.ok ? currentBranchAfterProbe.output : undefined,
            grantedBy: grant.grantedBy,
          },
          createdAt: now,
        });

        emit({
          ok: true,
          sessionId,
          issueNumber,
          action: actionLabel,
          executed: true,
          exitCode: 0,
          success: true,
          status: result.value.status,
          phase: result.value.phase,
          requeued: false,
          dirtyAfter,
          committedOnBranch,
          branch: workBranch,
          commandHash: grant.commandHash,
        });
        return;
      }

      // GUIDED REPOSITORY-CHANGE HANDLING (issue #419). When the operator passed
      // `--on-changes`, take the explicit outcome they chose for the changes the
      // command left in the working tree, instead of always handing back the
      // legacy "commit/push it yourself" instructions. Scoped to the dirty
      // working-tree case (the common Tool Request shape: `npm install` and
      // friends leave uncommitted lockfile/artifact edits). A command that
      // self-committed onto the issue branch (`committedOnBranch` with a clean
      // tree) still falls through to the legacy handoff below. All guided outcomes
      // keep the task a human handoff and defer the re-queue to `tool-request
      // resolve`, which enforces the clean-tree/pushed-branch contract. Guarded by
      // `baseAheadCountAfter === 0` so a base-contaminating command falls through to
      // the base-ahead handoff below instead (reaching here past the off-branch
      // guard with the base clean also guarantees HEAD is on the issue branch).
      if (onChanges !== undefined && dirtyAfter && baseAheadCountAfter === 0) {
        const expectedFiles = Array.isArray(existing["expectedFiles"])
          ? (existing["expectedFiles"] as unknown[]).filter((f): f is string => typeof f === "string")
          : [];
        // Artifact files are local audit records, never issue work: keep them out
        // of any commit or discard. `.n8n-artifacts` is the conventional name; add
        // the session's configured artifact dir too when it lives inside the repo.
        const relArtifact = relative(session.repoRoot, session.artifactRoot);
        const artifactInsideRepo = relArtifact.length > 0 && !relArtifact.startsWith("..") && !isAbsolute(relArtifact);
        const ignoredPrefixes = [".n8n-artifacts"];
        if (artifactInsideRepo) ignoredPrefixes.push(relArtifact);

        // Re-read the porcelain status WITHOUT trimming: `probe` returns
        // `stdout.trim()`, which strips the first line's leading status column
        // (e.g. ` M package.json` → `M package.json`) and would corrupt that
        // file's parsed path. The status columns are significant here, so parse
        // the raw output.
        let rawPorcelain = "";
        try {
          rawPorcelain = execFileSync("git", ["status", "--porcelain"], {
            cwd: grantRepoCwd,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
          }) as string;
        } catch {
          // Fall back to the (trimmed) probe output if the fresh read fails.
          rawPorcelain = afterProbe.ok ? afterProbe.output : "";
        }
        const changedFiles = parsePorcelainStatus(rawPorcelain);
        const classification = classifyChangedFiles(changedFiles, expectedFiles, ignoredPrefixes);
        const currentBranch = currentBranchAfterProbe.ok ? currentBranchAfterProbe.output : "";
        const plan = planRepoChange({
          action: onChanges,
          classification,
          currentBranch,
          expectedBranch: workBranch,
          baseBranch,
          confirmDiscard,
          allowUnexpected,
        });
        const summary = summarizeClassification(classification);

        // Shared finisher: record the consumed grant, post a sanitized public
        // comment (counts + redacted command only — never paths or raw output),
        // append an event, and emit. Keeps the task a human handoff unless a
        // `resolution` is supplied (reject), which closes the request.
        const finishGuided = async (
          changeOutcome: string,
          commentBody: string,
          extraEventData: Record<string, unknown>,
          resolution?: { action: "reject"; resolvedAt: string; message: string },
        ): Promise<void> => {
          // A refusal whose cause the operator can fix by re-running with an extra
          // flag (`--confirm-discard` for a destructive discard, `--allow-unexpected`
          // for a commit with unexpected files) is CORRECTABLE: the command already
          // ran and left its changes on disk, so the disposition can be retried
          // without re-executing (see the disposition-only retry guard above). A
          // wrong-branch/base-branch/nothing-to-do refusal is not flagged, so the
          // one-shot grant stays terminal for those.
          const refusalCode = extraEventData["refusalCode"];
          const correctable =
            changeOutcome === "refused" &&
            (refusalCode === "needs-confirmation" || refusalCode === "unexpected-files");
          const context: Record<string, unknown> = {
            toolRequestGrant: consumedGrant,
            // Durable record of the operator's guided disposition (issue #419) so
            // it is auditable from task context, not just the event log.
            toolRequestChangeAction: {
              action: onChanges,
              outcome: changeOutcome,
              decidedAt: now,
              ...(changeOutcome === "refused" && refusalCode !== undefined ? { refusalCode } : {}),
              ...(correctable ? { correctable: true } : {}),
            },
          };
          if (resolution) {
            context["toolRequest"] = { ...existing, resolved: true, resolution };
          }
          const result = await store.transitionTask(
            { sessionId, issueNumber },
            { status: task.status },
            { status: task.status, phase: task.phase, context, now },
          );
          if (!result.ok) {
            lockedDie(
              `Failed to record grant: ${result.code}` +
                (result.current ? ` (current status: ${result.current.status})` : ""),
            );
          }
          const body = sanitizeBody(commentBody, sessionRedactionPaths(session));
          await workItemStore.enqueue({
            idempotencyKey: makeOutboxKey(sessionId, issueNumber, runId, "gh:comment", "tool-request-grant", `changes-${changeOutcome}`),
            topic: "gh:comment",
            payload: { topic: "gh:comment", owner, repo, issueNumber, body },
            now,
          });
          await store.appendEvent({
            task: { sessionId, issueNumber },
            type: "tool_request_grant_executed",
            runId,
            message: `Operator granted Tool Request command for issue #${issueNumber} (exit 0, changes ${changeOutcome})`,
            data: {
              exitCode: 0,
              success: true,
              commandHash: grant.commandHash,
              requeued: false,
              branch: workBranch,
              changeAction: onChanges,
              changeOutcome,
              expectedFileCount: classification.expected.length,
              unexpectedFileCount: classification.unexpected.length,
              artifactFileCount: classification.ignored.length,
              grantedBy: grant.grantedBy,
              ...extraEventData,
            },
            createdAt: now,
          });
          emit({
            ok: true,
            sessionId,
            issueNumber,
            action: "grant",
            executed: true,
            exitCode: 0,
            success: true,
            status: result.value.status,
            phase: result.value.phase,
            requeued: false,
            branch: workBranch,
            changeAction: onChanges,
            changeOutcome,
            commandHash: grant.commandHash,
            ...extraEventData,
          });
        };

        if (!plan.ok) {
          // Refused plan: nothing changed on disk. Surface WHY (e.g. unexpected
          // files, missing confirmation, wrong branch) so the operator can correct
          // course. The request stays open.
          await finishGuided(
            "refused",
            `🛠️ **Tool Request granted command executed by operator — changes need attention.**\n\n` +
              `Approved command: \`${displayCommand}\`\n\n` +
              `The command completed successfully and produced changes (${summary}) on the issue branch ` +
              `\`${workBranch}\`. The requested \`${onChanges}\` action was not applied: ${plan.reason}`,
            { refusalCode: plan.code },
          );
          return;
        }

        if (plan.commit) {
          // Stage EXACTLY the classified non-artifact files (never `git add -A`) so
          // artifacts and any not-included unexpected files stay out of the commit.
          // For a rename, stage BOTH the destination (`path`) and the source
          // (`origPath`): staging only the destination would commit the new file
          // but leave the source deletion dirty, partially landing the change while
          // reporting success (issue #419 review).
          const filesToStage = [
            ...classification.expected,
            ...(allowUnexpected ? classification.unexpected : []),
          ].flatMap((f) => (f.origPath ? [f.path, f.origPath] : [f.path]));
          // The approved command has already run and succeeded by this point, so a
          // `git add`/`commit` failure must NOT exit via `lockedDie` before
          // `finishGuided` records `consumedGrant`: that would leave the one-shot
          // grant unconsumed and re-issuable, letting the same command run again and
          // duplicate its side effects. Instead, persist the grant as consumed, leave
          // the changes in place for recovery, and surface the failure (no raw output
          // in the public comment).
          //
          // First reset the index to HEAD so nothing the granted command may have
          // pre-staged (e.g. `git add .n8n-artifacts/run.json`) survives into the
          // commit. Without this, those staged paths would be committed even though
          // `filesToStage` excludes them, violating the guarantee that artifacts and
          // unrelated dirty files are never committed. `git reset` is mixed by
          // default: it unstages without touching the working tree, so the changes
          // remain on disk for recovery.
          const unstaged = bothStreamsCommandRunner.run("git", ["reset", "--", "."], { cwd: grantRepoCwd });
          if (unstaged.exitCode !== 0) {
            await finishGuided(
              "commit-failed",
              `🛠️ **Tool Request granted command executed by operator — commit failed.**\n\n` +
                `Approved command: \`${displayCommand}\`\n\n` +
                `The command completed successfully and produced changes (${summary}) on the issue branch ` +
                `\`${workBranch}\`, but preparing them for commit failed. The changes are left in place for ` +
                `recovery; commit and push \`${workBranch}\` manually, then run ` +
                `\`tool-request resolve --action manual-done\` to re-queue.`,
              { committed: false, commitFailed: true, failedStep: "unstage" },
            );
            return;
          }
          const added = bothStreamsCommandRunner.run("git", ["add", "--", ...filesToStage], { cwd: grantRepoCwd });
          if (added.exitCode !== 0) {
            await finishGuided(
              "commit-failed",
              `🛠️ **Tool Request granted command executed by operator — commit failed.**\n\n` +
                `Approved command: \`${displayCommand}\`\n\n` +
                `The command completed successfully and produced changes (${summary}) on the issue branch ` +
                `\`${workBranch}\`, but staging them for commit failed. The changes are left in place for ` +
                `recovery; commit and push \`${workBranch}\` manually, then run ` +
                `\`tool-request resolve --action manual-done\` to re-queue.`,
              { committed: false, commitFailed: true, failedStep: "stage" },
            );
            return;
          }
          const commitMsg = `chore: apply Tool Request command output for issue #${issueNumber}`;
          const committed = bothStreamsCommandRunner.run("git", ["commit", "--no-verify", "-m", commitMsg], { cwd: grantRepoCwd });
          if (committed.exitCode !== 0) {
            await finishGuided(
              "commit-failed",
              `🛠️ **Tool Request granted command executed by operator — commit failed.**\n\n` +
                `Approved command: \`${displayCommand}\`\n\n` +
                `The command completed successfully and produced changes (${summary}) on the issue branch ` +
                `\`${workBranch}\`, but committing them failed. The changes are left staged in place for ` +
                `recovery; commit and push \`${workBranch}\` manually, then run ` +
                `\`tool-request resolve --action manual-done\` to re-queue.`,
              { committed: false, commitFailed: true, failedStep: "commit" },
            );
            return;
          }
          // Push best-effort. On failure the commit is kept locally on the issue
          // branch so the operator can recover — never reset/discard it.
          const pushed = bothStreamsCommandRunner.run("git", ["push", "origin", workBranch], { cwd: grantRepoCwd });
          const pushFailed = pushed.exitCode !== 0;
          if (pushFailed) {
            await finishGuided(
              "committed-push-failed",
              `🛠️ **Tool Request granted command executed by operator — committed, push failed.**\n\n` +
                `Approved command: \`${displayCommand}\`\n\n` +
                `The command's expected changes (${summary}) were committed to the issue branch ` +
                `\`${workBranch}\`, but pushing to origin failed. The commit is kept locally for recovery. ` +
                `Push \`${workBranch}\` to origin, then run \`tool-request resolve --action manual-done\` ` +
                `to re-queue.`,
              { pushed: false },
            );
            return;
          }
          await finishGuided(
            "committed",
            `✅ **Tool Request granted command executed by operator — changes committed.**\n\n` +
              `Approved command: \`${displayCommand}\`\n\n` +
              `The command's expected changes (${summary}) were committed to the issue branch ` +
              `\`${workBranch}\` and pushed to origin. Run \`tool-request resolve --action manual-done\` ` +
              `to re-queue for implementation.`,
            { pushed: true },
          );
          return;
        }

        if (plan.discard) {
          // Destructive (confirmation already enforced by planRepoChange): reset
          // tracked files (staged or not) back to the issue branch tip and remove
          // untracked ones, except the artifact dir (this run's local records).
          //
          // Artifacts are local audit records and must survive a discard (issue
          // #419 review): a command may stage/force-add a file under the artifact
          // dir, and a bare `git reset --hard HEAD` would delete that staged
          // artifact before the `git clean -e` exclusion below could protect it.
          // First unstage any classified artifact paths so the hard reset (which
          // never touches untracked files) leaves them on disk, then exclude every
          // ignored prefix from the clean so they are preserved there too.
          const artifactPaths = classification.ignored.map((f) => f.path);
          const unstagedArtifacts =
            artifactPaths.length > 0
              ? bothStreamsCommandRunner.run("git", ["reset", "-q", "--", ...artifactPaths], { cwd: grantRepoCwd })
              : ({ exitCode: 0, stdout: "", stderr: "" } as CommandRunResult);
          const reset =
            unstagedArtifacts.exitCode === 0
              ? bothStreamsCommandRunner.run("git", ["reset", "--hard", "HEAD"], { cwd: grantRepoCwd })
              : unstagedArtifacts;
          const cleanArgs = ["clean", "-fd"];
          for (const prefix of ignoredPrefixes) cleanArgs.push("-e", prefix);
          // Only attempt the untracked-file clean if the reset succeeded.
          const cleaned =
            reset.exitCode === 0
              ? bothStreamsCommandRunner.run("git", cleanArgs, { cwd: grantRepoCwd })
              : undefined;
          if (reset.exitCode !== 0 || (cleaned !== undefined && cleaned.exitCode !== 0)) {
            // Fail closed: a failed reset/clean means generated changes may remain,
            // so do NOT claim the branch is clean. The command already ran, so still
            // record the grant as consumed (one-shot) — but report the failure and
            // leave recovery to the operator.
            await finishGuided(
              "discard-failed",
              `🛠️ **Tool Request granted command executed by operator — discard failed.**\n\n` +
                `Approved command: \`${displayCommand}\`\n\n` +
                `The command produced changes (${summary}) on the issue branch \`${workBranch}\`, but ` +
                `discarding them failed and the working tree may still contain changes. Inspect and clean ` +
                `\`${workBranch}\` manually before re-requesting or rejecting this Tool Request.`,
              { discarded: false, discardFailed: true },
            );
            return;
          }
          await finishGuided(
            "discarded",
            `🗑️ **Tool Request granted command executed by operator — changes discarded.**\n\n` +
              `Approved command: \`${displayCommand}\`\n\n` +
              `The command's generated changes (${summary}) were discarded and the issue branch ` +
              `\`${workBranch}\` is clean again. Re-request or reject this Tool Request as appropriate.`,
            {},
          );
          return;
        }

        if (onChanges === "reject") {
          // Close the request as rejected and leave the changes in place for the
          // operator to handle. Mirrors `tool-request resolve --action reject`:
          // the task stays a human handoff and is not re-queued.
          await finishGuided(
            "rejected",
            `🚫 **Tool Request rejected by operator.**\n\n` +
              `Approved command: \`${displayCommand}\`\n\n` +
              `The command ran and produced changes (${summary}) on the issue branch \`${workBranch}\`, ` +
              `but the Tool Request was rejected. The changes are left in place for you to commit or ` +
              `discard manually.`,
            {},
            {
              action: "reject",
              resolvedAt: executedAt,
              message: "Rejected via guided Tool Request change handling.",
            },
          );
          return;
        }

        if (onChanges === "abort") {
          await finishGuided(
            "aborted",
            `⏸️ **Tool Request granted command executed by operator — no further action.**\n\n` +
              `Approved command: \`${displayCommand}\`\n\n` +
              `The command ran and produced changes (${summary}) on the issue branch \`${workBranch}\`. ` +
              `No commit, push, or discard was performed; the changes are left exactly as the command ` +
              `produced them.`,
            {},
          );
          return;
        }

        // keep: leave the changes on the issue branch, explicitly recorded.
        await finishGuided(
          "kept",
          `📌 **Tool Request granted command executed by operator — changes kept.**\n\n` +
            `Approved command: \`${displayCommand}\`\n\n` +
            `The command's changes (${summary}) were kept on the issue branch \`${workBranch}\`. ` +
            `Commit and push them there (never the base branch \`${baseBranch}\`), then run ` +
            `\`tool-request resolve --action manual-done\` to re-queue from a clean tree.`,
          {},
        );
        return;
      }

      // Handle a contaminated base FIRST: when the command advanced the local base
      // past origin, fall through to the base-ahead handoff below regardless of
      // whether it also moved HEAD or dirtied the issue branch. Only treat changes
      // as issue-branch work when the base is clean (issue #316 review).
      if (producedChanges && baseAheadCountAfter === 0) {
        // SUCCESS + CHANGES ON ISSUE BRANCH. Reaching here means HEAD is still on
        // the issue branch and the base was not contaminated (the off-branch and
        // base-ahead guards above already failed those closed). The redesign
        // (issue #430, §4.3) lets the operator drive the disposition explicitly
        // instead of being handed raw git steps:
        //   - commit  → orchestrator commits + pushes on the issue branch, then
        //               re-queues (the central improvement over the old grant);
        //   - discard → revert the produced changes (partial-diff snapshot kept);
        //   - keep    → the pre-redesign behavior (operator commits by hand).
        if (disposition === "commit") {
          // Every failure exit below happens AFTER the approved command has
          // already run (and may have created a local commit). Persist the
          // consumed one-shot grant on the task before failing so the
          // authorization is recorded as used and the operator has task context
          // showing the execution happened — otherwise the task would look as if
          // the grant was never consumed and the same exact command could be
          // granted and run again, violating the one-shot grant contract (issue
          // #430 review). Mirrors the off-branch handoff above.
          const dieAfterRecordingConsumedGrant = async (message: string): Promise<never> => {
            await store.transitionTask(
              { sessionId, issueNumber },
              { status: task.status },
              { status: task.status, phase: task.phase, context: { toolRequestGrant: consumedGrant }, now },
            );
            lockedDie(message);
          };
          // Stage + commit any uncommitted changes; a command that already
          // committed onto the branch (committedOnBranch) leaves a clean tree, so
          // only commit when the tree is dirty. The commit message uses the
          // redacted display command so no secret embedded in the exact command
          // leaks into git history.
          if (dirtyAfter) {
            // Stage all produced changes, then unstage the session artifact
            // directory. The local run artifact (under `session.artifactDir`)
            // holds the exact command plus full stdout/stderr; when the target
            // repo does not gitignore that directory, a bare `git add -A` would
            // stage it and the commit + push below would leak it onto the issue
            // branch — or turn a no-op command into an artifact-only commit. We
            // stage with a plain `git add -A` (so produced changes are captured
            // regardless of the repo's ignore rules) and then `git reset` the
            // artifact dir out of the index; the reset is a silent no-op when the
            // dir is gitignored and so was never staged.
            const added = probe("git", ["add", "-A"], grantRepoCwd);
            if (!added.ok) {
              await dieAfterRecordingConsumedGrant(
                `Refusing to commit the guided-run changes for issue #${issueNumber}: 'git add -A' failed ` +
                  `in ${grantRepoCwd}: ${added.output}`,
              );
            }
            probe("git", ["reset", "-q", "--", session.artifactDir], grantRepoCwd);
            const committed = probe(
              "git",
              ["commit", "--no-verify", "-m", `Tool Request guided run: ${displayCommand}`],
              grantRepoCwd,
            );
            if (!committed.ok) {
              await dieAfterRecordingConsumedGrant(
                `Refusing to requeue issue #${issueNumber}: 'git commit' of the guided-run changes failed ` +
                  `in ${grantRepoCwd}: ${committed.output}`,
              );
            }
          }
          // Push so the committed side effects survive a later Tool Request
          // handoff's `git branch -D`, mirroring the manual-done resume-branch
          // contract (issue #316). When no origin is configured there is nothing
          // to push to; the local branch is then the resume point as-is.
          const hasOrigin = probe("git", ["remote", "get-url", "origin"], grantRepoCwd).ok;
          if (hasOrigin) {
            const pushed = probe("git", ["push", "origin", workBranch], grantRepoCwd);
            if (!pushed.ok) {
              await dieAfterRecordingConsumedGrant(
                `The guided-run changes for issue #${issueNumber} were committed on '${workBranch}' but ` +
                  `'git push origin ${workBranch}' failed: ${pushed.output}. The task was NOT re-queued (a ` +
                  `later handoff could delete the unpushed branch). Push '${workBranch}' (never '${baseBranch}'), ` +
                  `then run 'tool-request resolve --action manual-done'.`,
              );
            }
          }

          // The produced changes are committed (and pushed); clear this run's
          // local artifact so the requeued implementation preflight sees a clean
          // tree (issue #430 review).
          cleanArtifactBeforeRequeue();

          const resolution = {
            action: actionLabel,
            resolvedAt: executedAt,
            commandHash: grant.commandHash,
            disposition: "committed",
            capturedResult,
          };
          const resolvedToolRequest = { ...existing, resolved: true, resolution };

          const result = await store.transitionTask(
            { sessionId, issueNumber },
            { status: task.status },
            {
              status: "queued",
              phase: "implementation",
              ownerRunId: undefined,
              leaseExpiresAt: undefined,
              lastError: undefined,
              // The committed (and, when origin exists, pushed) issue branch is the
              // resume point so the requeued run continues from the landed changes
              // rather than branching fresh from base (issue #316).
              context: { toolRequest: resolvedToolRequest, toolRequestGrant: consumedGrant, toolRequestResumeBranch: workBranch },
              now,
            },
          );
          if (!result.ok) {
            lockedDie(`Failed to record guided run: ${result.code}` + (result.current ? ` (current status: ${result.current.status})` : ""));
          }

          // Relabel back into the implementation lane (mirrors the no-op success
          // path and manual-done).
          const readyForHumanLabel = session.labels["readyForHuman"] as string | undefined;
          const isFixModeRequest =
            existing["mode"] === "fix" ||
            (typeof task.context["reviewFeedback"] === "string" && (task.context["reviewFeedback"] as string).trim().length > 0);
          const queueStatusLabel = isFixModeRequest
            ? ((session.labels["needsFix"] as string | undefined) ?? "status:needs-fix")
            : ((session.labels["needsImplementation"] as string | undefined) ?? "status:needs-implementation");
          const resolvedImplAgentId = agentForPhase(task, session, "implementation");
          const implAgentLabel = resolvedImplAgentId
            ? `agent:${resolvedImplAgentId}`
            : ((session.labels["agentImplementation"] as string | undefined) ?? "agent:claude");
          for (const label of readyForHumanLabel ? [readyForHumanLabel] : []) {
            await workItemStore.enqueue({
              idempotencyKey: makeOutboxKey(sessionId, issueNumber, runId, "gh:label:remove", label),
              topic: "gh:label:remove",
              payload: { topic: "gh:label:remove", owner, repo, issueNumber, label },
              now,
            });
          }
          for (const label of [queueStatusLabel, implAgentLabel]) {
            await workItemStore.enqueue({
              idempotencyKey: makeOutboxKey(sessionId, issueNumber, runId, "gh:label:add", label),
              topic: "gh:label:add",
              payload: { topic: "gh:label:add", owner, repo, issueNumber, label },
              now,
            });
          }

          let commentBody =
            `✅ **Tool Request guided run committed by operator.**\n\n` +
            `Approved command: \`${displayCommand}\`\n\n` +
            `The command completed successfully; its changes were committed on the issue branch ` +
            `\`${workBranch}\` and the task has been re-queued for implementation.`;
          commentBody = sanitizeBody(commentBody, sessionRedactionPaths(session));
          await workItemStore.enqueue({
            idempotencyKey: makeOutboxKey(sessionId, issueNumber, runId, "gh:comment", "tool-request-grant", "success-committed"),
            topic: "gh:comment",
            payload: { topic: "gh:comment", owner, repo, issueNumber, body: commentBody },
            now,
          });

          await store.appendEvent({
            task: { sessionId, issueNumber },
            type: "tool_request_grant_executed",
            runId,
            message: `Operator guided run for issue #${issueNumber} committed changes on ${workBranch} (exit 0)`,
            data: { exitCode: 0, success: true, commandHash: grant.commandHash, requeued: true, disposition: "committed", branch: workBranch, grantedBy: grant.grantedBy },
            createdAt: now,
          });

          emit({
            ok: true,
            sessionId,
            issueNumber,
            action: actionLabel,
            executed: true,
            exitCode: 0,
            success: true,
            status: result.value.status,
            phase: result.value.phase,
            requeued: true,
            disposition: "committed",
            branch: workBranch,
            commandHash: grant.commandHash,
          });
          return;
        }

        if (disposition === "discard") {
          // Snapshot the produced changes before reverting so nothing is lost
          // irrecoverably (issue #379/#430 §4.3 partial-diff safeguard). Stage
          // everything, then diff against the pre-run HEAD so newly added files
          // are captured too. Best-effort: a capture failure still proceeds to
          // revert, but is reported so the operator knows no patch was written.
          const runId2 = runId;
          let discardPatch: string | undefined;
          let discardCaptureError: string | undefined;
          if (headBeforeProbe.ok) {
            // Stage all produced changes, then unstage the session artifact
            // directory so the snapshot diff is a faithful partial-diff of just
            // the command's produced changes, never the local run artifact (which
            // embeds the exact command + full output) when the repo does not
            // ignore it. The plain `git add -A` captures the changes regardless of
            // ignore rules; the follow-up `git reset` drops the artifact dir from
            // the index (a silent no-op when it is gitignored and never staged).
            const staged = probe("git", ["add", "-A"], grantRepoCwd);
            if (staged.ok) {
              probe("git", ["reset", "-q", "--", session.artifactDir], grantRepoCwd);
              const diff = probe("git", ["diff", "--cached", headBeforeProbe.output], grantRepoCwd);
              if (diff.ok && diff.output.length > 0) {
                try {
                  mkdirSync(artifactDir, { recursive: true });
                  writeFileSync(join(artifactDir, "discarded-changes.patch"), diff.output, "utf8");
                  discardPatch = "discarded-changes.patch";
                } catch (err) {
                  discardCaptureError = err instanceof Error ? err.message : String(err);
                }
              }
            } else {
              discardCaptureError = staged.output;
            }
            // Revert to the pre-run state: drop commits + staged/unstaged tracked
            // changes, then remove untracked files/dirs the command created.
            const resetProbe = probe("git", ["reset", "--hard", headBeforeProbe.output], grantRepoCwd);
            // Exclude the session artifact directory from the sweep: the
            // `discarded-changes.patch` snapshot above lives under it, and when
            // the repo does not gitignore that directory `git clean -fd` would
            // delete the snapshot we just wrote — reporting `discardPatch` while
            // the partial-diff safeguard is silently lost.
            const cleanProbe = probe("git", ["clean", "-fd", `--exclude=/${session.artifactDir}`], grantRepoCwd);
            // Fail closed: a `reset --hard`/`clean` failure, or a tree that is
            // still dirty after the sweep (e.g. a nested git repository that
            // `git clean -fd` will not recurse into), means command-produced
            // changes are still in the checkout. Recording `disposition:
            // discarded` and telling the operator the branch was reverted would
            // be a false claim — verify the tree is genuinely clean before
            // proceeding, and bail otherwise so the operator handles it (issue
            // #430 review). The artifact subtree is excluded to match the sweep:
            // the `discarded-changes.patch` snapshot lives there by design and is
            // not a leftover command change.
            const verifyProbe = probe(
              "git",
              ["status", "--porcelain", "--", ".", `:(exclude)${session.artifactDir}`],
              grantRepoCwd,
            );
            if (!resetProbe.ok || !cleanProbe.ok || !verifyProbe.ok || verifyProbe.output.length > 0) {
              const reasons: string[] = [];
              if (!resetProbe.ok) reasons.push(`git reset --hard failed: ${resetProbe.output.trim()}`);
              if (!cleanProbe.ok) reasons.push(`git clean failed: ${cleanProbe.output.trim()}`);
              if (verifyProbe.ok && verifyProbe.output.length > 0) {
                reasons.push(`working tree still dirty after revert:\n${verifyProbe.output.trim()}`);
              } else if (!verifyProbe.ok) {
                reasons.push(`could not verify working tree is clean: ${verifyProbe.output.trim()}`);
              }
              lockedDie(
                `Refusing to record discard for issue #${issueNumber}: the approved command's changes could ` +
                  `not be fully reverted on branch ${workBranch}. The grant was NOT consumed and remains ` +
                  `available. Manually restore the checkout to its pre-run state ` +
                  `(${headBeforeProbe.output}) before retrying.\n${reasons.join("\n")}`,
              );
            }
          } else {
            // No known-good pre-run revision to revert to, and nothing was
            // reverted — the command's changes are still in the checkout. Fail
            // closed rather than claim a discard that did not happen (issue #430
            // review). The grant stays unconsumed so the operator can retry once
            // the tree is restored manually.
            lockedDie(
              `Refusing to record discard for issue #${issueNumber}: could not read the pre-run HEAD on ` +
                `branch ${workBranch}, so the approved command's changes were left in place and cannot be ` +
                `safely reverted. The grant was NOT consumed and remains available. Manually restore the ` +
                `checkout to its pre-run state before retrying.`,
            );
          }

          // Discard leaves the request a human handoff (not re-queued; redesign
          // §8): the produced changes were rejected, so there is nothing to land.
          // Record the consumed grant so the same command cannot be silently re-run.
          const result = await store.transitionTask(
            { sessionId, issueNumber },
            { status: task.status },
            { status: task.status, phase: task.phase, context: { toolRequestGrant: consumedGrant }, now },
          );
          if (!result.ok) {
            lockedDie(`Failed to record guided run: ${result.code}` + (result.current ? ` (current status: ${result.current.status})` : ""));
          }

          let commentBody =
            `↩️ **Tool Request guided run changes discarded by operator.**\n\n` +
            `Approved command: \`${displayCommand}\`\n\n` +
            `The command ran successfully but the operator discarded the changes it produced; the issue ` +
            `branch \`${workBranch}\` was reverted to its pre-run state. The task remains a human handoff.`;
          commentBody = sanitizeBody(commentBody, sessionRedactionPaths(session));
          await workItemStore.enqueue({
            idempotencyKey: makeOutboxKey(sessionId, issueNumber, runId2, "gh:comment", "tool-request-grant", "success-discarded"),
            topic: "gh:comment",
            payload: { topic: "gh:comment", owner, repo, issueNumber, body: commentBody },
            now,
          });

          await store.appendEvent({
            task: { sessionId, issueNumber },
            type: "tool_request_grant_executed",
            runId: runId2,
            message: `Operator guided run for issue #${issueNumber} discarded its changes on ${workBranch} (exit 0)`,
            data: {
              exitCode: 0,
              success: true,
              commandHash: grant.commandHash,
              requeued: false,
              disposition: "discarded",
              branch: workBranch,
              ...(discardPatch ? { discardPatch } : {}),
              ...(discardCaptureError ? { discardCaptureError } : {}),
              grantedBy: grant.grantedBy,
            },
            createdAt: now,
          });

          emit({
            ok: true,
            sessionId,
            issueNumber,
            action: actionLabel,
            executed: true,
            exitCode: 0,
            success: true,
            status: result.value.status,
            phase: result.value.phase,
            requeued: false,
            disposition: "discarded",
            branch: workBranch,
            ...(discardPatch ? { discardPatch } : {}),
            commandHash: grant.commandHash,
          });
          return;
        }

        // disposition === "keep" (default): the pre-redesign behavior.
        // SUCCESS + CHANGES ON ISSUE BRANCH: the command produced uncommitted
        // changes and/or a commit on the issue branch. Record the consumed grant
        // but keep the request open and the task a human handoff — the operator
        // must commit/push the changes on the ISSUE branch (never the base branch),
        // then resolve with manual-done to re-queue from a clean tree.
        const result = await store.transitionTask(
          { sessionId, issueNumber },
          { status: task.status },
          { status: task.status, phase: task.phase, context: { toolRequestGrant: consumedGrant }, now },
        );
        if (!result.ok) {
          lockedDie(`Failed to record grant: ${result.code}` + (result.current ? ` (current status: ${result.current.status})` : ""));
        }

        const changeDescription = dirtyAfter
          ? `modified the working tree on the issue branch \`${workBranch}\``
          : `committed changes onto the issue branch \`${workBranch}\``;
        let commentBody =
          `✅ **Tool Request granted command executed by operator.**\n\n` +
          `Approved command: \`${displayCommand}\`\n\n` +
          `The command completed successfully and ${changeDescription}. The task was **not** ` +
          `re-queued automatically. Commit and push the produced changes on the issue branch ` +
          `\`${workBranch}\` (never the base branch \`${baseBranch}\`), then run ` +
          `\`tool-request resolve --action manual-done\` to re-queue from a clean tree.`;
        commentBody = sanitizeBody(commentBody, sessionRedactionPaths(session));
        await workItemStore.enqueue({
          idempotencyKey: makeOutboxKey(sessionId, issueNumber, runId, "gh:comment", "tool-request-grant", "success-branch-changes"),
          topic: "gh:comment",
          payload: { topic: "gh:comment", owner, repo, issueNumber, body: commentBody },
          now,
        });

        await store.appendEvent({
          task: { sessionId, issueNumber },
          type: "tool_request_grant_executed",
          runId,
          message: `Operator granted and executed Tool Request command for issue #${issueNumber} (exit 0, changes on issue branch ${workBranch})`,
          data: {
            exitCode: 0,
            success: true,
            commandHash: grant.commandHash,
            requeued: false,
            dirtyAfter,
            committedOnBranch,
            branch: workBranch,
            grantedBy: grant.grantedBy,
          },
          createdAt: now,
        });

        emit({
          ok: true,
          sessionId,
          issueNumber,
          action: actionLabel,
          executed: true,
          exitCode: 0,
          success: true,
          status: result.value.status,
          phase: result.value.phase,
          requeued: false,
          dirtyAfter,
          committedOnBranch,
          branch: workBranch,
          commandHash: grant.commandHash,
        });
        return;
      }

      if (baseAheadCountAfter > 0) {
        // SUCCESS + BASE AHEAD: the tree is clean and the issue branch unchanged,
        // but the command advanced the local base branch past origin. Record the
        // consumed grant but keep the request open and the task a human handoff —
        // requeueing now would leak the unpushed base commit into later issue
        // branches. The operator must move the commit onto the issue branch (or
        // drop it), then resolve with manual-done.
        const result = await store.transitionTask(
          { sessionId, issueNumber },
          { status: task.status },
          { status: task.status, phase: task.phase, context: { toolRequestGrant: consumedGrant }, now },
        );
        if (!result.ok) {
          lockedDie(`Failed to record grant: ${result.code}` + (result.current ? ` (current status: ${result.current.status})` : ""));
        }

        let commentBody =
          `✅ **Tool Request granted command executed by operator.**\n\n` +
          `Approved command: \`${displayCommand}\`\n\n` +
          `The command completed successfully but advanced the local base branch ` +
          `\`${baseBranch}\` ahead of origin. The task was **not** re-queued automatically to ` +
          `avoid leaking an unpushed base commit into later issue branches. Move the commit onto ` +
          `the issue branch \`${workBranch}\` (or drop it) — do NOT push \`${baseBranch}\` — then ` +
          `run \`tool-request resolve --action manual-done\` to re-queue from a clean base.`;
        commentBody = sanitizeBody(commentBody, sessionRedactionPaths(session));
        await workItemStore.enqueue({
          idempotencyKey: makeOutboxKey(sessionId, issueNumber, runId, "gh:comment", "tool-request-grant", "success-base-ahead"),
          topic: "gh:comment",
          payload: { topic: "gh:comment", owner, repo, issueNumber, body: commentBody },
          now,
        });

        await store.appendEvent({
          task: { sessionId, issueNumber },
          type: "tool_request_grant_executed",
          runId,
          message: `Operator granted and executed Tool Request command for issue #${issueNumber} (exit 0, base ahead of origin)`,
          data: {
            exitCode: 0,
            success: true,
            commandHash: grant.commandHash,
            requeued: false,
            dirtyAfter: false,
            baseAheadAfter: baseAheadCountAfter,
            branch: workBranch,
            grantedBy: grant.grantedBy,
          },
          createdAt: now,
        });

        emit({
          ok: true,
          sessionId,
          issueNumber,
          action: actionLabel,
          executed: true,
          exitCode: 0,
          success: true,
          status: result.value.status,
          phase: result.value.phase,
          requeued: false,
          dirtyAfter: false,
          baseAheadAfter: baseAheadCountAfter,
          branch: workBranch,
          commandHash: grant.commandHash,
        });
        return;
      }

      {
        // SUCCESS + TRUE NO-OP: clean tree, no commit on the issue branch, base not
        // advanced. The command produced nothing, so where it ran does not matter
        // for version control. Tidy up: return to the base branch and, if we had to
        // invent the issue branch for this run, delete the now-empty branch so the
        // requeued implementation run's new-branch preflight does not collide with
        // it. If the branch pre-existed (we did not invent it), it stays in place.
        // Skip this tidy-up entirely in worktree mode: the per-issue worktree is a
        // durable checkout that stays on `ai/issue-<n>`, the canonical repo already
        // holds the base branch (so `git checkout <base>` here would fail), and the
        // issue branch is the worktree's resume point — never delete it (issue #454
        // review). `moved.created` is already false there (the branch pre-existed,
        // checked out in the worktree), so no invented branch needs cleanup.
        if (!worktreeGrant) {
          probe("git", ["checkout", baseBranch], session.repoRoot);
          if (moved.created) {
            probe("git", ["branch", "-D", workBranch], session.repoRoot);
          }
        }
        // Hand the implementation run a resume point ONLY when the surviving branch
        // is a *known* one — the recorded PR head or a branch on origin (pushed).
        // A no-op grant produced no changes, so an arbitrary pre-existing local
        // `ai/issue-<n>` branch is most likely a stale leftover from a prior failed
        // run; adopting it as the resume point would silently fold its contents into
        // the next PR. Leave the resume branch unset for that case so the
        // implementation run's new-branch preflight collides and fails loudly on the
        // unexpected leftover instead of trusting it (issue #316 review). When we
        // deleted an invented branch, it is likewise unset so the requeue branches
        // fresh from base. Then resolve as a grant and re-queue to implementation,
        // exactly as a manual-done requeue would (labels included).
        //
        // Worktree mode (issue #454 review): the per-issue worktree is a durable
        // checkout that stays on `ai/issue-<n>`, so the branch is the deliberate
        // continuation point — not a stale leftover (`moved.created` is false there,
        // the branch pre-existed in the worktree). The requeued implementation must
        // resume from it so a valid no-op over the already-committed work continues
        // instead of failing the diff check. But that resume only works when origin
        // has the branch: the implementation run finds nothing to stage (the work is
        // already committed), skips the push, and then `gh pr create --head
        // ai/issue-<n>` fails if the branch is local-only — e.g. a prior handoff
        // committed partial work but its best-effort push failed, leaving
        // `moved.resumeSafe` false because origin lacks the branch. So before
        // adopting the branch, make sure it is on origin: `moved.resumeSafe` already
        // proves a pushed/PR branch; otherwise push it now. Record the resume branch
        // only when the branch is confirmed on origin afterward — when the push
        // cannot land it there (no origin, or the push failed), leave it unset so the
        // requeued implementation fails loudly instead of stranding at PR creation,
        // matching the shared-checkout gate that never resumes from an unpushed local
        // branch.
        let worktreeResumePushed = false;
        if (worktreeGrant) {
          if (moved.resumeSafe) {
            worktreeResumePushed = true;
          } else {
            const pushed = probe("git", ["push", "origin", workBranch], grantRepoCwd);
            worktreeResumePushed = pushed.ok && remoteHasBranch(grantRepoCwd, workBranch) === "yes";
          }
        }
        const toolRequestResumeBranch = worktreeGrant
          ? worktreeResumePushed
            ? workBranch
            : undefined
          : !moved.created && moved.resumeSafe
            ? workBranch
            : undefined;

        // The command produced nothing to commit; clear this run's local artifact
        // so the requeued implementation preflight sees a clean tree (issue #430
        // review). Done after the checkout/branch tidy-up above so it runs against
        // the final working tree.
        cleanArtifactBeforeRequeue();

        // SUCCESS + TRUE NO-OP is the verification-command case (issue #430,
        // redesign §4.3): there is nothing to commit, so the captured output is
        // the deliverable. Record it on the resolution as continuation context so
        // the requeued implementation pass has the answer the agent was missing.
        const resolution = {
          action: actionLabel,
          resolvedAt: executedAt,
          commandHash: grant.commandHash,
          disposition: "no-op",
          capturedResult,
        };
        const resolvedToolRequest = { ...existing, resolved: true, resolution };

        const result = await store.transitionTask(
          { sessionId, issueNumber },
          { status: task.status },
          {
            status: "queued",
            phase: "implementation",
            ownerRunId: undefined,
            leaseExpiresAt: undefined,
            lastError: undefined,
            // Always write the key so applyTaskPatch's context merge does not preserve
            // a stale resume branch from an earlier Tool Request; JSON.stringify drops
            // the undefined value, removing the key (matches manual-done; issue #316).
            context: { toolRequest: resolvedToolRequest, toolRequestGrant: consumedGrant, toolRequestResumeBranch },
            now,
          },
        );
        if (!result.ok) {
          lockedDie(`Failed to record grant: ${result.code}` + (result.current ? ` (current status: ${result.current.status})` : ""));
        }

        // Swap public labels back to the implementation lane (mirrors tool-request
        // resolve manual-done): drop ready-for-human, re-advertise the queue status
        // (needs-fix for a fix-mode request, else needs-implementation) + the
        // resolved implementation agent.
        const readyForHumanLabel = session.labels["readyForHuman"] as string | undefined;
        const isFixModeRequest =
          existing["mode"] === "fix" ||
          (typeof task.context["reviewFeedback"] === "string" && (task.context["reviewFeedback"] as string).trim().length > 0);
        const queueStatusLabel = isFixModeRequest
          ? ((session.labels["needsFix"] as string | undefined) ?? "status:needs-fix")
          : ((session.labels["needsImplementation"] as string | undefined) ?? "status:needs-implementation");
        const resolvedImplAgentId = agentForPhase(task, session, "implementation");
        const implAgentLabel = resolvedImplAgentId
          ? `agent:${resolvedImplAgentId}`
          : ((session.labels["agentImplementation"] as string | undefined) ?? "agent:claude");
        const removeLabels = readyForHumanLabel ? [readyForHumanLabel] : [];
        for (const label of removeLabels) {
          await workItemStore.enqueue({
            idempotencyKey: makeOutboxKey(sessionId, issueNumber, runId, "gh:label:remove", label),
            topic: "gh:label:remove",
            payload: { topic: "gh:label:remove", owner, repo, issueNumber, label },
            now,
          });
        }
        for (const label of [queueStatusLabel, implAgentLabel]) {
          await workItemStore.enqueue({
            idempotencyKey: makeOutboxKey(sessionId, issueNumber, runId, "gh:label:add", label),
            topic: "gh:label:add",
            payload: { topic: "gh:label:add", owner, repo, issueNumber, label },
            now,
          });
        }

        let commentBody =
          `✅ **Tool Request granted and executed by operator.**\n\n` +
          `Approved command: \`${displayCommand}\`\n\n` +
          `The command completed successfully and the task has been re-queued for implementation.`;
        commentBody = sanitizeBody(commentBody, sessionRedactionPaths(session));
        await workItemStore.enqueue({
          idempotencyKey: makeOutboxKey(sessionId, issueNumber, runId, "gh:comment", "tool-request-grant", "success"),
          topic: "gh:comment",
          payload: { topic: "gh:comment", owner, repo, issueNumber, body: commentBody },
          now,
        });

        await store.appendEvent({
          task: { sessionId, issueNumber },
          type: "tool_request_grant_executed",
          runId,
          message: `Operator granted and executed Tool Request command for issue #${issueNumber} (exit 0)`,
          data: { exitCode: 0, success: true, commandHash: grant.commandHash, requeued: true, dirtyAfter: false, branch: workBranch, grantedBy: grant.grantedBy },
          createdAt: now,
        });

        emit({
          ok: true,
          sessionId,
          issueNumber,
          action: actionLabel,
          executed: true,
          exitCode: 0,
          success: true,
          status: result.value.status,
          phase: result.value.phase,
          requeued: true,
          dirtyAfter: false,
          branch: workBranch,
          commandHash: grant.commandHash,
        });
        return;
      }

    }

    // FAILURE: surface a clear handoff state and do NOT requeue, so a failing
    // granted command never loops silently. The request is left UNRESOLVED, but
    // the consumed grant is persisted so the same exact command cannot be re-run
    // by another grant. Recovery is NOT "grant a corrected command": `--command`
    // is rejected unless it equals the stored requested command, and re-granting
    // that exact command is what the consumed grant now blocks. The operator must
    // instead reject/re-request the Tool Request, or run a corrected command
    // themselves and resolve it with `tool-request resolve --action manual-done`.
    const result = await store.transitionTask(
      { sessionId, issueNumber },
      { status: task.status },
      {
        status: task.status,
        phase: task.phase,
        context: { toolRequestGrant: consumedGrant },
        now,
      },
    );
    if (!result.ok) {
      lockedDie(`Failed to record grant: ${result.code}` + (result.current ? ` (current status: ${result.current.status})` : ""));
    }

    let commentBody =
      `🛠️ **Tool Request granted command failed** for issue #${issueNumber} — left for human review.\n\n` +
      `Approved command: \`${displayCommand}\`\n\n` +
      `The command exited with a non-zero status (exit ${runResult.exitCode}). The task was **not** re-queued. ` +
      `Review the local run artifact, then either reject/re-request this Tool Request, or run a corrected ` +
      `command manually and resolve it as \`manual-done\`.`;
    commentBody = sanitizeBody(commentBody, sessionRedactionPaths(session));
    await workItemStore.enqueue({
      idempotencyKey: makeOutboxKey(sessionId, issueNumber, runId, "gh:comment", "tool-request-grant", "failed"),
      topic: "gh:comment",
      payload: { topic: "gh:comment", owner, repo, issueNumber, body: commentBody },
      now,
    });

    await store.appendEvent({
      task: { sessionId, issueNumber },
      type: "tool_request_grant_failed",
      runId,
      message: `Operator-granted Tool Request command for issue #${issueNumber} failed (exit ${runResult.exitCode})`,
      data: { exitCode: runResult.exitCode, success: false, commandHash: grant.commandHash, requeued: false, grantedBy: grant.grantedBy },
      createdAt: now,
    });

    emit({
      ok: true,
      sessionId,
      issueNumber,
      action: actionLabel,
      executed: true,
      exitCode: runResult.exitCode,
      success: false,
      status: result.value.status,
      phase: result.value.phase,
      requeued: false,
      commandHash: grant.commandHash,
    });
  } finally {
    // Release on every normal-completion path (dry-run, success, failure). die()
    // paths inside the critical section release via lockedDie() since
    // process.exit() bypasses finally.
    releaseLock();
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
    const result = aggregateL3Interventions(db, sessionId, { issueNumber, since, until });
    report(result as unknown as Record<string, unknown>, (mode) => renderInterventions(result, mode, issueNumber));
  } finally {
    db.close();
  }
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
  // Preset list/show commands are operator-facing (issue #513).
  "session preset",
  // Delay-clear is operator-facing (issue #584); preview output should be
  // readable without --json.
  "task clear-delay",
  // L3 intervention aggregation (issue #588): operator-facing diagnostic,
  // human-readable by default; --json for machine consumption.
  "interventions",
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
    runStatus(argv.slice(1));
    return;
  }

  if (subcommand === "task-status") {
    runTaskStatus(argv.slice(1));
    return;
  }

  if (subcommand === "list-stuck") {
    runListStuck(argv.slice(1));
    return;
  }

  if (subcommand === "recover") {
    runRecover(argv.slice(1));
    return;
  }

  if (subcommand === "recover-cap-handoff") {
    runRecoverCapHandoff(argv.slice(1));
    return;
  }

  if (subcommand === "task") {
    const action = argv[1];
    if (action === "clear-delay") {
      runTaskClearDelay(argv.slice(2));
      return;
    }
    die(`Unknown task action: ${action ?? "(none)"}. Expected: clear-delay`);
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

  if (subcommand === "review-verification") {
    const action = argv[1];
    if (action === "resolve") {
      await runReviewVerificationResolve(argv.slice(2));
      return;
    }
    die(`Unknown review-verification action: ${action ?? "(none)"}. Expected: resolve`);
  }

  if (subcommand === "tool-request") {
    const action = argv[1];
    if (action === "list") {
      runToolRequestList(argv.slice(2));
      return;
    }
    if (action === "resolve") {
      await runToolRequestResolve(argv.slice(2));
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

  if (subcommand === "quarantine") {
    const action = argv[1];
    if (action === "status") {
      runQuarantineStatus(argv.slice(2));
      return;
    }
    if (action === "clear") {
      runQuarantineClear(argv.slice(2));
      return;
    }
    die(`Unknown quarantine action: ${action ?? "(none)"}. Expected: status | clear`);
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
      runWorktreeRecovery(argv.slice(2));
      return;
    }
    if (action === "cleanup") {
      runWorktreeCleanup(argv.slice(2));
      return;
    }
    if (action === "release-lock") {
      runWorktreeReleaseLock(argv.slice(2));
      return;
    }
    if (action === "discard") {
      runWorktreeDiscard(argv.slice(2));
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
    die(`Unknown session action: ${action ?? "(none)"}. Expected: preset`);
  }

  if (subcommand === "session-doctor") {
    runSessionDoctor(argv.slice(1));
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

  if (subcommand === "interventions") {
    runInterventions(argv.slice(1));
    return;
  }

  die(`Unknown command: ${subcommand}. Run "admin help" to see available commands.`);
}

const isMain =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  main(process.argv.slice(2)).catch((err) => {
    die(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
  });
}
