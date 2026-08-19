/**
 * admin ui — an interactive, usability-first CUI layered over the existing
 * `admin` subcommands (issue #307).
 *
 * The UI is a thin presentation layer. It NEVER mutates the database directly:
 * read-only views query the TaskStore port, and every state-changing action is
 * executed by spawning the exact same non-interactive `admin` subcommand the
 * operator could copy/paste (e.g. `admin recover ...`). This guarantees the
 * dirty-worktree, lease, lock and cap safeguards in those commands are never
 * bypassed, and that the command shown to the operator is the command that runs.
 *
 * In non-TTY environments the UI degrades gracefully: it prints the equivalent
 * non-interactive commands and exits non-zero instead of blocking on input.
 *
 * The pure helpers below (selection of active tasks, column/command formatting)
 * are exported so they can be unit-tested without a real terminal.
 */

import { execFileSync } from "child_process";
import { existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import {
  select as clackSelect,
  text as clackText,
  confirm as clackConfirm,
  cancel as clackCancel,
  isCancel,
} from "@clack/prompts";
import { emit, die } from "./cli-io.js";
import { SqliteTaskStore } from "../stores/sqlite-task-store.js";
import type { TaskStore } from "../core/task-store.js";
import { isClaimExpired } from "../core/transitions.js";
import type { AiTask, TaskEvent, TaskStatus } from "../core/task.js";
import {
  DEFAULT_SESSIONS_PATH,
  JsonSessionRegistry,
  resolveSessionRef,
} from "../registries/json-session-registry.js";
import { resolveGhRunner } from "../providers/github/github-app-auth.js";
import { defaultGhRunner } from "../providers/github/gh-runner.js";
import type { GhRunner } from "../providers/github/gh-runner.js";
import { tokenizeArgs } from "./admin-command.js";
import { IssueWorktreeLock } from "../handlers/worktree.js";
import { hasUnresolvedToolRequest } from "../core/tool-request.js";
// Issue #848: the UI renders the SAME projection the non-interactive commands
// do, and routes every dispute mutation back through `admin dispute reopen`
// rather than writing protocol state itself.
import { REVIEW_DISPUTE_CONTEXT_KEY } from "../core/review-dispute-commit.js";
import { disputeReopenArgv, summarizeDisputeStatus } from "../core/review-dispute-status.js";

// ---------------------------------------------------------------------------
// Pure helpers (unit-testable without a TTY)
// ---------------------------------------------------------------------------

/**
 * Statuses considered "active" for the operator list. A task is active while it
 * is anywhere in the workflow except a terminal `done` — including failed and
 * human-handoff states, which are exactly the ones an operator recovers.
 */
export const ACTIVE_STATUSES: TaskStatus[] = [
  "queued",
  "claimed",
  "running",
  "blocked",
  "ready_for_human",
  "failed",
];

export function isActiveStatus(status: string): boolean {
  return (ACTIVE_STATUSES as string[]).includes(status);
}

export type LeaseState = "none" | "active" | "expired";

export type IssueState = "open" | "closed" | "unknown";

/**
 * Injectable: given (sessionId, issueNumber) returns the GitHub open/closed state.
 * Returns "unknown" when the state cannot be determined (network failure, no auth, etc.).
 */
export type IssueStateReader = (sessionId: string, issueNumber: number) => IssueState;

/** Snapshot of the per-issue worktree lock state. */
export interface WorktreeLockState {
  held: boolean;
  stale: boolean | null;
}

/** Injectable: given (sessionId, issueNumber) returns the current worktree lock state. */
export type IssueLockReader = (sessionId: string, issueNumber: number) => WorktreeLockState;

export interface GitHubFilterResult {
  /** Tasks whose GitHub issues are open (or whose state could not be verified). */
  active: AiTask[];
  /** Tasks whose GitHub issues are confirmed closed — local DB residue. */
  closedResidual: AiTask[];
  /** Warning when some states could not be verified; null when all known. */
  warning: string | null;
}

/** Lease state for a task: only claimed/running tasks hold a lease. */
export function leaseState(task: AiTask, now: string): LeaseState {
  if (task.status !== "claimed" && task.status !== "running") return "none";
  if (!task.leaseExpiresAt) return "none";
  return isClaimExpired(task, now) ? "expired" : "active";
}

/** Compact attempts/cap indicator for the current phase, e.g. "2" or "3 CAP". */
export function attemptsCapState(task: AiTask): string {
  const n = task.attempts[task.phase] ?? 0;
  const cap = task.context["reviewLoopCapReached"] ? " CAP" : "";
  return `${n}${cap}`;
}

/** Issue title from intake context, or "" when unknown. */
export function issueTitle(task: AiTask): string {
  const t = task.context["title"];
  return typeof t === "string" ? t : "";
}

/** Short, single-line blocker/error summary for the list and detail views. */
export function blockerSummary(task: AiTask): string {
  if (typeof task.lastError === "string" && task.lastError.length > 0) {
    return oneLine(task.lastError);
  }
  if (task.context["reviewLoopCapReached"]) return "review-loop cap reached";
  if (task.context["toolRequest"]) return "tool-request handoff";
  return "";
}

/** Operator-safe artifact directory for the task's latest run, or null. */
export function artifactPathForTask(task: AiTask): string | null {
  const a = task.context["artifactDir"];
  return typeof a === "string" && a.length > 0 ? a : null;
}

/** Whether `admin recover` can move this task back to queued. */
export function isRecoverable(task: AiTask, now: string): boolean {
  if (task.status === "failed") return true;
  if (task.status === "claimed" || task.status === "running") {
    return isClaimExpired(task, now);
  }
  return false;
}

/** Whether `admin recover-cap-handoff` applies to this task. */
export function isCapRecoverable(task: AiTask): boolean {
  return task.status === "ready_for_human" && Boolean(task.context["reviewLoopCapReached"]);
}

/**
 * Whether this task is a disallowed-command Tool Request human handoff
 * (issues #291/#301). Such tasks carry structured metadata in
 * `task.context.toolRequest` and must be resolved through the dedicated
 * `tool-request resolve` / `tool-request grant` flows — not generic `recover`,
 * which would re-queue the task with the request unresolved and trip the same
 * handoff (or an immediate repeat/failure loop) again, bypassing the
 * Tool Request-specific dirty/ahead-of-origin safeguards and outbox/metadata
 * updates.
 *
 * A *resolved* Tool Request (`context.toolRequest.resolved === true`, e.g. after
 * `tool-request resolve --action reject`) is not a live handoff: `tool-request
 * list` omits it and resolve/grant fail as already-resolved. Routing it into the
 * Tool Request menu would only offer dead-end commands, so resolved requests are
 * not treated as Tool Request handoffs here.
 */
export function isToolRequestHandoff(task: AiTask): boolean {
  return task.status === "ready_for_human" && hasUnresolvedToolRequest(task.context);
}

/**
 * Whether this task is a plain human handoff: `ready_for_human` but neither a
 * review-loop cap handoff nor a live Tool Request handoff (which have their own
 * dedicated recovery flows). These are the ordinary human-review / conflict
 * returns. They must NOT be requeued via generic `recover` at the current phase:
 * a review return belongs in `human-review-return` (which records the review
 * feedback and swaps GitHub labels via the outbox), and other handoffs may need
 * a different lane (e.g. `conflict_resolution`). The operator chooses the path,
 * so the UI routes these to a read-only command view instead of auto-running a
 * guessed `recover`.
 */
export function isHumanReviewHandoff(task: AiTask): boolean {
  return (
    task.status === "ready_for_human" &&
    !isCapRecoverable(task) &&
    !isToolRequestHandoff(task)
  );
}

/**
 * Collect active tasks across the given sessions, most-recently-updated first.
 * Read-only: this only reads from the store and never mutates task state.
 */
export async function collectActiveTasks(store: TaskStore, sessionIds: string[]): Promise<AiTask[]> {
  const out: AiTask[] = [];
  for (const sid of sessionIds) {
    for (const task of await store.listSessionTasks(sid)) {
      if (isActiveStatus(task.status)) out.push(task);
    }
  }
  out.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  return out;
}

/**
 * Partition locally-active tasks by their GitHub issue open/closed state using
 * the supplied reader. Tasks with confirmed-closed issues move to `closedResidual`;
 * open or unverified tasks stay in `active` (fail-safe: no work item silently hidden).
 * A warning string is returned when any state is unknown so the operator can
 * assess the situation before taking recovery actions.
 */
export function partitionByGitHubState(
  tasks: AiTask[],
  reader: IssueStateReader,
): GitHubFilterResult {
  const active: AiTask[] = [];
  const closedResidual: AiTask[] = [];
  let unknownCount = 0;

  for (const task of tasks) {
    const state = reader(task.sessionId, task.issueNumber);
    if (state === "closed") {
      closedResidual.push(task);
    } else {
      if (state === "unknown") unknownCount++;
      active.push(task);
    }
  }

  let warning: string | null = null;
  if (unknownCount > 0) {
    if (unknownCount === tasks.length) {
      warning =
        "GitHub open/closed state could not be checked (network error or missing gh auth). " +
        "This list is DB-local only — verify issue state before taking recovery actions.";
    } else {
      warning =
        `GitHub state unverified for ${unknownCount} of ${tasks.length} task(s). ` +
        "They appear in the active list as fail-safe; verify state before acting.";
    }
  }

  return { active, closedResidual, warning };
}

/**
 * Build an IssueStateReader backed by `gh issue view`. Each call runs one
 * `gh` subprocess (5-second timeout); results are not cached so the UI sees
 * fresh state on each list refresh. Returns "unknown" on any failure.
 *
 * @param sessionMap maps sessionId → { githubRepo, repoRoot, runner? }. When a
 *   sessionId is absent the reader returns "unknown". When `runner` is set it
 *   is used instead of the default `_runner`, so sessions configured with
 *   `github-app` auth use a token-injecting executor rather than the operator's
 *   raw `gh` credentials.
 */
export function buildGhIssueStateReader(
  sessionMap: ReadonlyMap<string, { githubRepo: string; repoRoot: string; runner?: GhRunner | null }>,
  _runner: (cmd: string, args: string[], opts: { encoding: "utf8"; cwd: string; timeout: number }) => string = execFileSync as (cmd: string, args: string[], opts: { encoding: "utf8"; cwd: string; timeout: number }) => string,
): IssueStateReader {
  return (sessionId: string, issueNumber: number): IssueState => {
    const session = sessionMap.get(sessionId);
    if (!session) return "unknown";
    // runner === null means App auth was configured but failed to resolve — do
    // not fall back to raw gh credentials; treat the state as unverified.
    if (session.runner === null) return "unknown";
    try {
      const args = ["issue", "view", String(issueNumber), "--repo", session.githubRepo, "--json", "state"];
      let stdout: string;
      if (session.runner) {
        const result = session.runner.run(args, { cwd: session.repoRoot, timeout: 5000 });
        if (result.exitCode !== 0) return "unknown";
        stdout = result.stdout;
      } else {
        stdout = _runner(
          "gh",
          args,
          { encoding: "utf8", cwd: session.repoRoot, timeout: 5000 },
        );
      }
      const data = JSON.parse(stdout) as { state?: string };
      const upper = data.state?.toUpperCase();
      if (upper === "CLOSED") return "closed";
      if (upper === "OPEN") return "open";
      return "unknown";
    } catch {
      return "unknown";
    }
  };
}

/**
 * Build a reader backed by a mutable cache. Returns "unknown" for any task
 * whose state is not yet in the cache. Use with populateStateCache to fill
 * the cache on operator-triggered refresh so startup is instant.
 */
export function buildCachingReader(cache: Map<string, IssueState>): IssueStateReader {
  return (sessionId: string, issueNumber: number): IssueState =>
    cache.get(`${sessionId}:${issueNumber}`) ?? "unknown";
}

/**
 * Populate cache by invoking reader for every task. Call this when the
 * operator explicitly requests a GitHub state refresh; the caching reader
 * returned by buildCachingReader will reflect the updated states on the next
 * list render.
 */
export function populateStateCache(
  tasks: AiTask[],
  reader: IssueStateReader,
  cache: Map<string, IssueState>,
): void {
  for (const task of tasks) {
    cache.set(`${task.sessionId}:${task.issueNumber}`, reader(task.sessionId, task.issueNumber));
  }
}

/** Argv for the non-interactive `admin recover` equivalent of a UI recover. */
export function buildRecoverArgv(task: AiTask, dbPath?: string): string[] {
  const argv = [
    "recover",
    "--session-id",
    task.sessionId,
    "--issue-number",
    String(task.issueNumber),
  ];
  // `admin recover` only re-queues a `ready_for_human` handoff when
  // `--from ready_for_human --phase <phase>` is supplied; without these flags
  // it falls through to the failed/expired-lease branch and recovers nothing.
  //
  // The target phase is deliberately a `<phase>` placeholder, NOT the task's
  // current phase: a human handoff is not always re-queued into the lane it left
  // (e.g. a conflict return goes to `conflict_resolution`), and a plain human
  // review return should normally go through `human-review-return` so the review
  // feedback and label/outbox transitions are recorded. The operator must pick
  // the lane, so for a `ready_for_human` task this argv is surfaced for copy/paste
  // only (see showHumanReviewReturnCommands) and is never auto-executed.
  if (task.status === "ready_for_human") {
    argv.push("--from", "ready_for_human", "--phase", "<phase>");
  }
  if (dbPath) argv.push("--db-path", dbPath);
  return argv;
}

/**
 * Argv for the non-interactive `admin recover-cap-handoff` equivalent.
 *
 * `phase` defaults to `review` to match the CLI/store contract that
 * `recover-cap-handoff` restarts the review lane when no `--phase` is given. The
 * interactive cap-reset action passes the operator-selected phase explicitly
 * (defaulting to `implementation` in the picker, per issue #409), so this
 * default only governs the read-only copyable-command view where no phase was
 * selected — emitting `--phase implementation` there would silently override the
 * documented review restart path.
 */
export function buildCapResetArgv(
  task: AiTask,
  dbPath?: string,
  phase: string = "review",
): string[] {
  const argv = [
    "recover-cap-handoff",
    "--session-id",
    task.sessionId,
    "--issue-number",
    String(task.issueNumber),
    "--phase",
    phase,
  ];
  if (dbPath) argv.push("--db-path", dbPath);
  return argv;
}

/** Argv for `admin tool-request list` scoped to this task's handoff. */
export function buildToolRequestListArgv(task: AiTask, dbPath?: string): string[] {
  const argv = [
    "tool-request",
    "list",
    "--session-id",
    task.sessionId,
    "--issue-number",
    String(task.issueNumber),
  ];
  if (dbPath) argv.push("--db-path", dbPath);
  return argv;
}

/**
 * Argv for `admin tool-request resolve` for this task. `reject` requires an
 * operator note, so a placeholder is surfaced for the operator to fill in.
 */
export function buildToolRequestResolveArgv(
  task: AiTask,
  action: "manual-done" | "reject",
  dbPath?: string,
  sessionsPath?: string,
): string[] {
  const argv = [
    "tool-request",
    "resolve",
    "--session-id",
    task.sessionId,
    "--issue-number",
    String(task.issueNumber),
    "--action",
    action,
  ];
  if (action === "reject") argv.push("--message", "<operator note>");
  if (dbPath) argv.push("--db-path", dbPath);
  // `tool-request resolve` loads repo metadata from DEFAULT_SESSIONS_PATH unless
  // told otherwise, so preserve a custom registry the UI was launched with.
  if (sessionsPath) argv.push("--sessions-path", sessionsPath);
  return argv;
}

/** Argv for `admin tool-request grant` for this task's handoff. */
export function buildToolRequestGrantArgv(
  task: AiTask,
  dbPath?: string,
  sessionsPath?: string,
): string[] {
  const argv = [
    "tool-request",
    "grant",
    "--session-id",
    task.sessionId,
    "--issue-number",
    String(task.issueNumber),
  ];
  if (dbPath) argv.push("--db-path", dbPath);
  // `tool-request grant` resolves the repo root from DEFAULT_SESSIONS_PATH
  // unless told otherwise, so preserve a custom registry the UI was launched
  // with — otherwise the grant targets the wrong (or an unknown) session.
  if (sessionsPath) argv.push("--sessions-path", sessionsPath);
  return argv;
}

/**
 * Argv for `admin human-review-return` for this task — the correct path for
 * returning a human-reviewed PR to fix mode. Unlike generic `recover`, it stores
 * the (sanitized) review feedback the fix agent requires and swaps the GitHub
 * labels via the outbox. The feedback source is an operator decision and
 * `--feedback` carries operator-supplied text, so the caller passes the feedback
 * flags (a placeholder is surfaced for the operator to fill in).
 */
export function buildHumanReviewReturnArgv(
  task: AiTask,
  feedbackArgs: string[],
  dbPath?: string,
  sessionsPath?: string,
): string[] {
  const argv = [
    "human-review-return",
    "--session-id",
    task.sessionId,
    "--issue-number",
    String(task.issueNumber),
    ...feedbackArgs,
  ];
  if (dbPath) argv.push("--db-path", dbPath);
  // human-review-return resolves the repo and labels from DEFAULT_SESSIONS_PATH
  // unless told otherwise, so preserve a custom registry the UI was launched with.
  if (sessionsPath) argv.push("--sessions-path", sessionsPath);
  return argv;
}

/** Argv for `admin worktree release-lock` to free a per-issue worktree lock. */
export function buildLockReleaseArgv(task: AiTask, opts: { force?: boolean } = {}): string[] {
  // `worktree release-lock` previews by default; the UI already confirms this
  // state-changing action, so pass --yes to actually release the lock. A live
  // (within-TTL) lock is additionally refused unless --force is given, so pass
  // that too once the operator has confirmed a live-lock force-release.
  const argv = [
    "worktree",
    "release-lock",
    "--session-id",
    task.sessionId,
    "--issue-number",
    String(task.issueNumber),
    "--yes",
  ];
  if (opts.force) argv.push("--force");
  return argv;
}

/** Argv for `admin status` scoped to this task (worktree-aware inspect). */
export function buildStatusArgv(task: AiTask, dbPath?: string, sessionsPath?: string): string[] {
  const argv = [
    "status",
    "--session-id",
    task.sessionId,
    "--issue-number",
    String(task.issueNumber),
  ];
  if (dbPath) argv.push("--db-path", dbPath);
  if (sessionsPath) argv.push("--sessions-path", sessionsPath);
  return argv;
}

/** Render an `admin <argv...>` command string with minimal shell quoting. */
export function formatAdminCommand(argv: string[]): string {
  return "admin " + argv.map(shellQuote).join(" ");
}

/** One-line table columns for a task. */
export interface TaskColumns {
  session: string;
  issue: string;
  title: string;
  status: string;
  phase: string;
  attempts: string;
  lease: string;
  updated: string;
  blocker: string;
}

export function taskColumns(task: AiTask, now: string): TaskColumns {
  return {
    session: task.sessionId,
    issue: String(task.issueNumber),
    title: issueTitle(task),
    status: task.status,
    phase: task.phase,
    attempts: attemptsCapState(task),
    lease: leaseState(task, now),
    updated: task.updatedAt,
    blocker: blockerSummary(task),
  };
}

/** Compact single-line summary used as a selectable list row. */
export function formatTaskLine(task: AiTask, now: string): string {
  const c = taskColumns(task, now);
  const title = c.title ? truncate(c.title, 28) : "(no title)";
  const parts = [
    `#${c.issue}`.padEnd(6),
    pad(c.session, 12),
    pad(title, 28),
    pad(c.status, 16),
    pad(c.phase, 14),
    `att ${c.attempts}`.padEnd(9),
    pad(`lease ${c.lease}`, 14),
  ];
  let line = parts.join(" ");
  if (c.blocker) line += `  ⚠ ${truncate(c.blocker, 40)}`;
  return line;
}

/**
 * Whether a task carries review-dispute protocol state worth a UI action
 * (issue #848). A task without a §10.1 block — every legacy task, and every task
 * in a session with `reviewDispute.enabled: false` — answers false and the UI is
 * unchanged for it.
 */
export function hasDisputeState(task: AiTask): boolean {
  const block = task.context?.[REVIEW_DISPUTE_CONTEXT_KEY];
  return typeof block === "object" && block !== null && !Array.isArray(block);
}

/** The non-interactive `admin dispute status` form for a task. */
export function buildDisputeStatusArgv(task: AiTask, dbPath?: string, sessionsPath?: string): string[] {
  const argv = [
    "dispute",
    "status",
    "--session-id",
    task.sessionId,
    "--issue-number",
    String(task.issueNumber),
  ];
  if (dbPath) argv.push("--db-path", dbPath);
  if (sessionsPath) argv.push("--sessions-path", sessionsPath);
  return argv;
}

/**
 * The dispute block of the task detail view (issue #848).
 *
 * Rendered from {@link summarizeDisputeStatus} — the same projection `admin
 * task-status` and `admin dispute status` render — so the UI cannot show a
 * different lineage state, a different counter, or a different "next action"
 * than the non-interactive commands do. It reads persisted context and bounded
 * task events only; nothing here opens a run artifact.
 */
export function formatDisputeDetail(task: AiTask, events?: readonly TaskEvent[]): string[] {
  const summary = summarizeDisputeStatus(task, events);
  if (summary === null) return [];
  const lines = [
    "",
    `Dispute:    ${summary.lineages.length} lineage(s)` +
      (summary.reviewStructure ? `  review=${summary.reviewStructure}` : "") +
      (summary.pendingReReview ? "  pendingReReview" : "") +
      (summary.resolvedWithoutChanges ? "  resolvedWithoutChanges" : ""),
  ];
  for (const l of summary.lineages) {
    const c = l.counters;
    lines.push(
      `  ${l.lineageId}  v${l.version}  ${l.state ?? "(unreadable state)"}` +
        (l.outcome ? ` → ${l.outcome}` : "") +
        `  ${l.severity ?? "?"}  ${l.affectedBoundary ?? "(no boundary)"}`,
    );
    lines.push(
      `      reb=${c.rebuttals} recon=${c.reconsiderations} arb=${c.arbitrationPasses} ` +
        `malformedArb=${c.malformedArbiterAttempts} evidence=${c.evidenceRoundsUsed}` +
        (l.humanGate ? " humanGate" : "") +
        (l.reopenRequested ? " reopenRequested" : ""),
    );
  }
  const r = summary.routing;
  lines.push(
    r
      ? `  routing: rule=${r.rule ?? "-"} outcome=${r.outcome ?? "-"} turn=${r.turn ?? "-"} ` +
        `nextPhase=${r.nextPhase ?? "-"}` +
        (r.undispatchedTurn ? `  undispatchedTurn=${r.undispatchedTurn}` : "")
      : "  routing: (no recorded transition event)",
  );
  const action = summary.nextAction;
  lines.push(`  next action: ${action.authorized ? action.action : `none (${action.reason})`}`);
  lines.push(`    ${oneLine(action.description)}`);
  return lines;
}

/**
 * Multi-line detail view for a selected task.
 *
 * `events` is optional and only feeds the issue #848 dispute block: without it
 * the lineage state and counters still render in full (they live in the task
 * context), and only the §7.1 routing intent — an event-only fact — is reported
 * as unavailable rather than guessed.
 */
export function formatTaskDetail(
  task: AiTask,
  now: string,
  lockState?: WorktreeLockState,
  events?: readonly TaskEvent[],
): string {
  const c = taskColumns(task, now);
  const lines = [
    `Session:    ${c.session}`,
    `Issue:      #${c.issue}${c.title ? `  ${c.title}` : ""}`,
    `Status:     ${c.status}`,
    `Phase:      ${c.phase}`,
    `Priority:   ${task.priority}`,
    `Attempts:   ${c.attempts}`,
    `Lease:      ${c.lease}${task.leaseExpiresAt ? ` (expires ${task.leaseExpiresAt})` : ""}`,
    `Owner run:  ${task.ownerRunId ?? "(none)"}`,
    `Updated:    ${c.updated}`,
    `Created:    ${task.createdAt}`,
  ];
  const artifacts = artifactPathForTask(task);
  if (artifacts) lines.push(`Artifacts:  ${artifacts}`);
  if (lockState) {
    const lockStr = lockState.held
      ? lockState.stale ? "held (STALE)" : "held"
      : lockState.stale
        ? "free (stale file)"
        : "free";
    lines.push(`Wt lock:    ${lockStr}`);
  }
  if (c.blocker) lines.push(`Blocker:    ${c.blocker}`);
  lines.push(...formatDisputeDetail(task, events));
  return lines.join("\n");
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, Math.max(0, max - 1)) + "…";
}

function pad(s: string, width: number): string {
  return truncate(s, width).padEnd(width);
}

function shellQuote(arg: string): string {
  return /^[A-Za-z0-9_./:@-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, "'\\''")}'`;
}

// ---------------------------------------------------------------------------
// Session selection (pure, unit-testable without a TTY)
// ---------------------------------------------------------------------------

/**
 * A selected session scope for the interactive UI. "all" shows tasks from
 * every available session; a specific id narrows to one session.
 */
export type SessionScope = { kind: "all" } | { kind: "one"; sessionId: string };

/** Human-readable label for the active session scope. */
export function formatSessionScope(scope: SessionScope, totalSessions: number): string {
  if (scope.kind === "all") return `all sessions (${totalSessions})`;
  return scope.sessionId;
}

/**
 * Session IDs visible under a given scope. When the scope is "all", every id
 * in `allSessionIds` is returned; when narrowed, only the selected one.
 */
export function sessionIdsForScope(scope: SessionScope, allSessionIds: string[]): string[] {
  if (scope.kind === "all") return allSessionIds;
  return [scope.sessionId];
}

// ---------------------------------------------------------------------------
// Pagination (pure, unit-testable without a TTY)
// ---------------------------------------------------------------------------

/**
 * Default rows per page for the task list. Bounded so the list stays readable
 * and renders instantly even when a session has hundreds of historical tasks.
 */
export const DEFAULT_PAGE_SIZE = 20;

/** Number of pages needed to show `total` items at `pageSize` rows each (min 1). */
export function pageCount(total: number, pageSize: number): number {
  if (pageSize <= 0) return 1;
  return Math.max(1, Math.ceil(total / pageSize));
}

/** Clamp a (possibly out-of-range) page index into [0, pageCount-1]. */
export function clampPage(page: number, total: number, pageSize: number): number {
  const last = pageCount(total, pageSize) - 1;
  if (page < 0) return 0;
  if (page > last) return last;
  return page;
}

/** Zero-based page that contains the item at global `index`. */
export function pageForIndex(index: number, pageSize: number): number {
  if (pageSize <= 0 || index <= 0) return 0;
  return Math.floor(index / pageSize);
}

/** The slice of items visible on `page`. Page is clamped before slicing. */
export function pageSlice<T>(items: T[], page: number, pageSize: number): T[] {
  const clamped = clampPage(page, items.length, pageSize);
  const start = clamped * pageSize;
  return items.slice(start, start + pageSize);
}

/**
 * Move the global selection by whole pages while preserving the row offset
 * within the page where possible, then clamp to the valid item range. This is
 * what keeps the highlighted row "in the same place" as the operator pages
 * through the list (e.g. row 3 of page 1 → row 3 of page 2).
 */
export function moveSelectionByPage(
  index: number,
  delta: number,
  total: number,
  pageSize: number,
): number {
  if (total <= 0) return 0;
  const curPage = pageForIndex(index, pageSize);
  const offset = index - curPage * pageSize;
  const targetPage = clampPage(curPage + delta, total, pageSize);
  const target = targetPage * pageSize + offset;
  return Math.min(target, total - 1);
}

/** Step the global selection by one row, clamped to the valid item range. */
export function moveSelectionByRow(index: number, delta: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(total - 1, Math.max(0, index + delta));
}

/** Human-readable page indicator, e.g. "Page 2/9 · tasks 21-40 of 174". */
export function formatPageStatus(page: number, total: number, pageSize: number): string {
  if (total === 0) return "Page 0/0 · 0 tasks";
  const clamped = clampPage(page, total, pageSize);
  const start = clamped * pageSize + 1;
  const end = Math.min(total, (clamped + 1) * pageSize);
  return `Page ${clamped + 1}/${pageCount(total, pageSize)} · tasks ${start}-${end} of ${total}`;
}

// ---------------------------------------------------------------------------
// Filtering (pure, unit-testable without a TTY)
// ---------------------------------------------------------------------------

/**
 * Active filter state. All fields are optional; only set fields narrow the
 * list. Multiple filters compose (AND): a task must pass every set filter.
 */
export interface UiFilter {
  issueNumber?: number;
  status?: TaskStatus;
  phase?: string;
  /** Case-insensitive substring match over issue title and blocker summary. */
  text?: string;
}

/** Return only the tasks that pass every active filter. */
export function applyFilter(tasks: AiTask[], filter: UiFilter): AiTask[] {
  return tasks.filter((task) => {
    if (filter.issueNumber !== undefined && task.issueNumber !== filter.issueNumber) return false;
    if (filter.status !== undefined && task.status !== filter.status) return false;
    if (filter.phase !== undefined && task.phase !== filter.phase) return false;
    if (filter.text !== undefined && filter.text.length > 0) {
      const needle = filter.text.toLowerCase();
      const title = issueTitle(task).toLowerCase();
      const blocker = blockerSummary(task).toLowerCase();
      if (!title.includes(needle) && !blocker.includes(needle)) return false;
    }
    return true;
  });
}

/** True when at least one filter field is set to a non-empty value. */
export function isFilterActive(filter: UiFilter): boolean {
  return (
    filter.issueNumber !== undefined ||
    filter.status !== undefined ||
    filter.phase !== undefined ||
    (filter.text !== undefined && filter.text.length > 0)
  );
}

/**
 * Human-readable summary of the active filter, e.g.
 * "issue:#42 · status:failed · search:\"auth\"".
 * Returns an empty string when no filter is active.
 */
export function formatFilterStatus(filter: UiFilter): string {
  const parts: string[] = [];
  if (filter.issueNumber !== undefined) parts.push(`issue:#${filter.issueNumber}`);
  if (filter.status !== undefined) parts.push(`status:${filter.status}`);
  if (filter.phase !== undefined) parts.push(`phase:${filter.phase}`);
  if (filter.text !== undefined && filter.text.length > 0) parts.push(`search:"${filter.text}"`);
  return parts.join(" · ");
}

// ---------------------------------------------------------------------------
// Argument parsing & session resolution
// ---------------------------------------------------------------------------

export interface UiArgs {
  sessionId?: string;
  sessionRef?: string;
  dbPath?: string;
  sessionsPath: string;
}

export function parseUiArgs(argv: string[]): UiArgs | { error: string } {
  const tokenized = tokenizeArgs(argv, {
    valueFlags: ["session-id", "session-ref", "db-path", "sessions-path"],
  });
  if ("error" in tokenized) return { error: tokenized.error };
  const { args } = tokenized;
  if (args["session-id"] !== undefined && args["session-ref"] !== undefined) {
    return { error: "Provide only one of --session-id or --session-ref, not both" };
  }
  return {
    sessionId: args["session-id"],
    sessionRef: args["session-ref"],
    dbPath: args["db-path"],
    sessionsPath: args["sessions-path"] ?? DEFAULT_SESSIONS_PATH,
  };
}

/**
 * Resolve the set of sessionIds the UI should list. A `--session-id` or
 * `--session-ref` filter narrows to one session; otherwise every session in
 * sessions.json is listed.
 */
export async function resolveSessionIds(args: UiArgs): Promise<string[]> {
  if (args.sessionId !== undefined) {
    if (args.sessionId === "") throw new Error("--session-id must not be empty");
    return [args.sessionId];
  }
  if (args.sessionRef !== undefined) {
    return [resolveSessionRef(args.sessionsPath, args.sessionRef)];
  }
  if (!existsSync(args.sessionsPath)) {
    throw new Error(
      `Sessions file not found: ${args.sessionsPath}. Pass --session-id to inspect a single session.`,
    );
  }
  const registry = new JsonSessionRegistry(args.sessionsPath);
  const sessions = await registry.listSessions();
  return sessions.map((s) => s.sessionId);
}

// ---------------------------------------------------------------------------
// Non-TTY degradation
// ---------------------------------------------------------------------------

export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

export function nonTtyHelp(): string {
  return [
    "admin ui requires an interactive terminal (TTY).",
    "",
    "It was started without a TTY, so there is nothing to interact with.",
    "Use these non-interactive admin commands instead:",
    "",
    "  admin list-stuck             --session-id <id>",
    "  admin task-status            --session-id <id> [--issue-number <n>]",
    "  admin status                 --session-id <id> [--issue-number <n>]",
    "  admin recover                --session-id <id> [--issue-number <n>] [--dry-run]",
    "  admin recover-cap-handoff    --session-id <id> [--issue-number <n>] [--dry-run]",
    "  admin human-review-return    --session-id <id> --issue-number <n> --feedback-source issue-comment",
    "  admin worktree release-lock  --session-id <id> --issue-number <n>",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Command execution (reuses the non-interactive admin subcommands)
// ---------------------------------------------------------------------------

function adminEntrypoint(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "admin.js");
}

export interface AdminRunResult {
  code: number;
  stdout: string;
}

/**
 * Run an `admin` subcommand in a child process and capture its output. State
 * changes happen exclusively through this path, so every safeguard the
 * subcommand enforces stays intact.
 */
function runAdminCommand(argv: string[]): AdminRunResult {
  try {
    const stdout = execFileSync(process.execPath, [adminEntrypoint(), ...argv], {
      encoding: "utf8",
    }) as string;
    return { code: 0, stdout };
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, stdout: (e.stdout ?? "") + (e.stderr ?? "") };
  }
}

// ---------------------------------------------------------------------------
// Clack-backed interactive primitives
// ---------------------------------------------------------------------------
//
// Interaction now runs through @clack/prompts. Clack owns the terminal (raw
// mode, redraw, scroll window) for the duration of each prompt, so this module
// no longer hand-rolls a keypress loop. Two things are preserved deliberately:
//
//  * Ctrl-C / Escape — Clack resolves a cancelled prompt to a cancel symbol.
//    `unwrap` converts that into a `UiCancelled` throw, which `runAdminUi`
//    catches to close the store and exit 130 (the Ctrl-C cleanup contract).
//  * The bounded, paged listing model from #325 — Clack's `select` renders a
//    scrolling window of `DEFAULT_PAGE_SIZE` rows (see `maxItems`), so a session
//    with hundreds of tasks stays readable and navigable without paging keys.
//    The pure pagination helpers remain exported for callers and tests.

/**
 * Thrown when the operator cancels a Clack prompt (Ctrl-C or Escape). Caught at
 * the entry point so the store is closed before exiting with the interrupt code.
 */
class UiCancelled extends Error {}

function write(s: string): void {
  process.stdout.write(s);
}

function clear(): void {
  write("\x1b[2J\x1b[H");
}

/** Resolve a Clack prompt result, converting the cancel symbol into a throw. */
function unwrap<T>(value: T | symbol): T {
  if (isCancel(value)) throw new UiCancelled();
  return value as T;
}

/**
 * Single-select menu over a list of items, backed by Clack. Returns the chosen
 * item's index. The caller's item list is expected to carry its own Back/Quit
 * entries (see buildTaskMenuActions / buildClosedTaskMenuActions); Ctrl-C and
 * Escape cancel the whole UI rather than acting as an implicit back.
 */
async function selectMenu<T>(opts: {
  header: string;
  items: T[];
  render: (item: T) => string;
}): Promise<number> {
  const value = unwrap(
    await clackSelect<string>({
      message: opts.header,
      options: opts.items.map((item, i) => ({
        value: String(i),
        label: opts.render(item),
      })),
    }),
  );
  return Number(value);
}

/**
 * Single-select over the active task list. Clack renders a bounded scrolling
 * window (`maxItems: pageSize`) so the list stays readable with hundreds of
 * tasks — the same bounded-listing goal as the #325 pagination model, now
 * handled by the prompt instead of hand-rolled paging keys. The GitHub-state
 * refresh and the closed-residual view are appended as dedicated options so
 * they remain reachable without scrolling past every task.
 *
 * Returns the global task index on selection, or a sentinel action otherwise.
 */
type TaskListResult =
  | { kind: "select"; index: number }
  | { kind: "refresh" }
  | { kind: "closed" }
  | { kind: "filter" }
  | { kind: "clear-filter" }
  | { kind: "switch-session" }
  | { kind: "back" };

async function selectTaskFromList(opts: {
  header: string;
  tasks: AiTask[];
  now: string;
  pageSize: number;
  hasClosed: boolean;
  initialIndex?: number;
  filter: UiFilter;
  /** When true, a "Switch session" option is appended to the menu. */
  multiSession?: boolean;
}): Promise<TaskListResult> {
  const total = opts.tasks.length;
  const options: { value: string; label: string }[] = opts.tasks.map((task, i) => ({
    value: `idx:${i}`,
    label: formatTaskLine(task, opts.now),
  }));
  options.push({ value: "refresh", label: "↻  Refresh GitHub issue states" });
  if (opts.hasClosed) options.push({ value: "closed", label: "📁  Closed/stale local tasks" });
  options.push({ value: "filter", label: "⚙  Filter / Search" });
  if (isFilterActive(opts.filter)) {
    options.push({ value: "clear-filter", label: "✕  Clear filters" });
  }
  if (opts.multiSession) {
    options.push({ value: "switch-session", label: "⇄  Switch session" });
  }
  options.push({ value: "quit", label: "Quit" });

  const initialValue =
    total > 0 ? `idx:${Math.min(Math.max(0, opts.initialIndex ?? 0), total - 1)}` : "filter";

  // A static one-line summary in the message header keeps the at-a-glance sense
  // of the old page indicator; the scroll window itself is what bounds the view.
  const totalLabel = total > 0
    ? `${total} task(s) · ${pageCount(total, opts.pageSize)} window(s) of ${opts.pageSize}`
    : "(no tasks match)";
  const filterLabel = isFilterActive(opts.filter)
    ? `  [filter: ${formatFilterStatus(opts.filter)}]`
    : "";
  const summary = totalLabel + filterLabel;

  const value = unwrap(
    await clackSelect<string>({
      message: `${opts.header}\n${summary}`,
      options,
      initialValue,
      maxItems: opts.pageSize,
    }),
  );

  if (value === "refresh") return { kind: "refresh" };
  if (value === "closed") return { kind: "closed" };
  if (value === "filter") return { kind: "filter" };
  if (value === "clear-filter") return { kind: "clear-filter" };
  if (value === "switch-session") return { kind: "switch-session" };
  if (value === "quit") return { kind: "back" };
  if (value.startsWith("idx:")) return { kind: "select", index: Number(value.slice(4)) };
  return { kind: "back" };
}

/**
 * Interactive filter builder. Presents a sub-menu where the operator can set or
 * clear individual filter fields. Returns the updated filter (never mutates the
 * input). The operator stays in the sub-menu until they choose "Done" or "Back".
 */
async function runFilterMenu(current: UiFilter): Promise<UiFilter> {
  let filter = { ...current };
  for (;;) {
    const statusLabel = filter.status ? `Status: ${filter.status}` : "Set status filter";
    const phaseLabel = filter.phase ? `Phase: ${filter.phase}` : "Set phase filter";
    const issueLabel =
      filter.issueNumber !== undefined ? `Issue: #${filter.issueNumber}` : "Set issue number filter";
    const textLabel = filter.text ? `Search: "${filter.text}"` : "Set text search";
    const activeDesc = isFilterActive(filter)
      ? `Active: ${formatFilterStatus(filter)}`
      : "No filters active";

    const choice = unwrap(
      await clackSelect<string>({
        message: `Filter / Search\n${activeDesc}`,
        options: [
          { value: "issue", label: issueLabel },
          { value: "status", label: statusLabel },
          { value: "phase", label: phaseLabel },
          { value: "text", label: textLabel },
          ...(isFilterActive(filter)
            ? [{ value: "clear", label: "✕  Clear all filters" }]
            : []),
          { value: "done", label: "Done — apply filters" },
        ],
      }),
    );

    if (choice === "done") return filter;
    if (choice === "clear") {
      filter = {};
      continue;
    }

    if (choice === "issue") {
      const val = unwrap(
        await clackText({
          message: "Filter by issue number (leave blank to clear)",
          placeholder: filter.issueNumber !== undefined ? String(filter.issueNumber) : "",
          validate: (v) => {
            if (v === "" || v === undefined) return undefined;
            if (!/^\d+$/.test(v)) return "Enter a positive integer or leave blank";
            return undefined;
          },
        }),
      );
      if (val === "") {
        const { issueNumber: _removed, ...rest } = filter;
        filter = rest;
      } else {
        filter = { ...filter, issueNumber: Number(val) };
      }
      continue;
    }

    if (choice === "status") {
      const statusOptions = [
        { value: "", label: "(clear status filter)" },
        ...ACTIVE_STATUSES.map((s) => ({ value: s, label: s })),
      ];
      const val = unwrap(
        await clackSelect<string>({
          message: "Filter by status",
          options: statusOptions,
          initialValue: filter.status ?? "",
        }),
      );
      if (val === "") {
        const { status: _removed, ...rest } = filter;
        filter = rest;
      } else {
        filter = { ...filter, status: val as TaskStatus };
      }
      continue;
    }

    if (choice === "phase") {
      const phases = [
        "implementation",
        "review",
        "conflict_resolution",
        "research",
        "content_research",
        "content_draft",
        "content_review",
        "planner",
        "refinement",
      ] as const;
      const phaseOptions = [
        { value: "", label: "(clear phase filter)" },
        ...phases.map((p) => ({ value: p, label: p })),
      ];
      const val = unwrap(
        await clackSelect<string>({
          message: "Filter by phase",
          options: phaseOptions,
          initialValue: filter.phase ?? "",
        }),
      );
      if (val === "") {
        const { phase: _removed, ...rest } = filter;
        filter = rest;
      } else {
        filter = { ...filter, phase: val };
      }
      continue;
    }

    if (choice === "text") {
      const val = unwrap(
        await clackText({
          message: "Text search (title and blocker summary, case-insensitive; blank to clear)",
          placeholder: filter.text ?? "",
        }),
      );
      if (val.trim() === "") {
        const { text: _removed, ...rest } = filter;
        filter = rest;
      } else {
        filter = { ...filter, text: val.trim() };
      }
      continue;
    }
  }
}

async function confirm(message: string): Promise<boolean> {
  return unwrap(await clackConfirm({ message, initialValue: false }));
}

/**
 * "Press to continue" gate after a read-only info screen. Clack has no
 * any-key pause, so this is a single-option select the operator confirms with
 * Enter — equivalent intent, and Ctrl-C still cancels the UI.
 */
async function pause(message = "Continue"): Promise<void> {
  unwrap(
    await clackSelect<string>({
      message,
      options: [{ value: "ok", label: "↵  Continue" }],
    }),
  );
}

// ---------------------------------------------------------------------------
// Interactive flows
// ---------------------------------------------------------------------------

type MenuAction =
  | "recover"
  | "cap-reset"
  | "tool-request"
  | "human-review"
  | "dispute"
  | "lock-release"
  | "lock-force-release"
  | "status"
  | "events"
  | "artifacts"
  | "copy"
  | "back"
  | "quit";

/** Actions available for a task whose GitHub issue is confirmed closed. */
export type ClosedMenuAction = "events" | "artifacts" | "inspect" | "back" | "quit";

/**
 * Inspect-only actions for closed-issue residual tasks. State-changing actions
 * (recover, cap-reset, tool-request, human-review) are intentionally absent:
 * a closed issue has no valid active-workflow story — reopen the issue first.
 */
export function buildClosedTaskMenuActions(): { action: ClosedMenuAction; label: string }[] {
  return [
    { action: "events", label: "Show recent task events" },
    { action: "artifacts", label: "Show latest run artifacts path" },
    { action: "inspect", label: "Show task-status inspect command" },
    { action: "back", label: "Back to closed list" },
    { action: "quit", label: "Quit" },
  ];
}

async function runStateChange(task: AiTask, argv: string[]): Promise<void> {
  const command = formatAdminCommand(argv);
  clear();
  write(`Selected task: ${task.sessionId} #${task.issueNumber}\n\n`);
  write("This will run the non-interactive command:\n\n");
  write(`  ${command}\n`);

  const ok = await confirm("\nProceed?");
  if (!ok) {
    write("\nCancelled. No changes made.\n");
    await pause();
    return;
  }

  const result = runAdminCommand(argv);
  clear();
  write("Ran command:\n\n");
  write(`  ${command}\n\n`);
  write(`Exit code: ${result.code}\n\n`);
  write("Result:\n");
  write(result.stdout.trim() + "\n");
  await pause();
}

async function showEvents(store: TaskStore, task: AiTask): Promise<void> {
  const events = await store.listEvents({
    sessionId: task.sessionId,
    issueNumber: task.issueNumber,
  });
  clear();
  write(`Recent events — ${task.sessionId} #${task.issueNumber}\n\n`);
  const recent = events.slice(-15);
  if (recent.length === 0) {
    write("(no events recorded)\n");
  } else {
    for (const ev of recent) {
      const msg = ev.message ? ` — ${oneLine(ev.message)}` : "";
      write(`${ev.createdAt}  ${ev.type}${msg}\n`);
    }
  }
  await pause();
}

async function showArtifacts(task: AiTask): Promise<void> {
  clear();
  write(`Latest run artifacts — ${task.sessionId} #${task.issueNumber}\n\n`);
  const path = artifactPathForTask(task);
  if (path) {
    write(`  ${path}\n`);
  } else {
    write("(no artifact directory recorded for this task yet)\n");
  }
  await pause();
}

async function showCopyableCommands(
  task: AiTask,
  now: string,
  dbPath?: string,
  sessionsPath?: string,
): Promise<void> {
  clear();
  write(`Non-interactive admin commands — ${task.sessionId} #${task.issueNumber}\n\n`);
  // For a review-loop cap handoff, the correct requeue is `recover-cap-handoff`;
  // surfacing the generic `recover` here would invite copy/pasting the command
  // that leaves stale cap metadata behind.
  if (isCapRecoverable(task)) {
    write("Recover review-loop cap handoff:\n");
    write(`  ${formatAdminCommand(buildCapResetArgv(task, dbPath))}\n\n`);
  } else if (isToolRequestHandoff(task)) {
    // A Tool Request handoff must be resolved through the dedicated
    // tool-request flows; generic `recover` would requeue it unresolved.
    write("Resolve Tool Request handoff (do NOT use generic recover):\n");
    write(`  ${formatAdminCommand(buildToolRequestListArgv(task, dbPath))}\n`);
    write(`  ${formatAdminCommand(buildToolRequestResolveArgv(task, "manual-done", dbPath, sessionsPath))}\n`);
    write(`  ${formatAdminCommand(buildToolRequestGrantArgv(task, dbPath, sessionsPath))}\n`);
    write(`  ${formatAdminCommand(buildToolRequestResolveArgv(task, "reject", dbPath, sessionsPath))}\n\n`);
  } else if (isHumanReviewHandoff(task)) {
    // A plain human handoff. Prefer `human-review-return` for review returns: it
    // records the review feedback and swaps GitHub labels via the outbox, which
    // generic `recover` does not. Generic recover is offered only for re-queuing
    // into a specific lane, with `<phase>` as an operator choice — never the
    // task's current phase, which could put a review return in the wrong lane.
    write("Return human-reviewed PR to fix mode (records feedback + swaps labels):\n");
    write(`  ${formatAdminCommand(buildHumanReviewReturnArgv(task, ["--feedback-source", "issue-comment"], dbPath, sessionsPath))}\n`);
    write(`  ${formatAdminCommand(buildHumanReviewReturnArgv(task, ["--feedback", "<operator note>"], dbPath, sessionsPath))}\n\n`);
    write("Or re-queue into a specific lane (pick <phase>, e.g. conflict_resolution):\n");
    write(`  ${formatAdminCommand(buildRecoverArgv(task, dbPath))}\n\n`);
  } else if (isRecoverable(task, now)) {
    // Only surface `recover` when it can actually move the task (the same gate
    // the action menu uses). For statuses `admin recover` cannot move — e.g.
    // `queued` or `blocked` — it reports success with an empty recovery set, so
    // printing it here would let an operator copy a misleading no-op.
    write("Recover / requeue:\n");
    write(`  ${formatAdminCommand(buildRecoverArgv(task, dbPath))}\n\n`);
  } else {
    write(
      "This task's status is not recoverable via `admin recover`; inspect it\n" +
        "with the command below before acting.\n\n",
    );
  }
  write("Inspect:\n");
  write(`  ${formatAdminCommand([
    "task-status",
    "--session-id",
    task.sessionId,
    "--issue-number",
    String(task.issueNumber),
    ...(dbPath ? ["--db-path", dbPath] : []),
  ])}\n`);
  await pause();
}

/**
 * Surface the dedicated Tool Request resolution commands for a handoff. The UI
 * does not run these directly: choosing between manual-done, grant, and reject
 * (and supplying the reject note) is an operator decision, and each command
 * runs its own dirty/ahead-of-origin preflight. Routing here instead of generic
 * recover keeps those Tool Request-specific safeguards in the loop. This is a
 * read-only view — it never mutates DB state.
 */
async function showToolRequestCommands(
  task: AiTask,
  dbPath?: string,
  sessionsPath?: string,
): Promise<void> {
  clear();
  write(`Resolve Tool Request handoff — ${task.sessionId} #${task.issueNumber}\n\n`);
  write(
    "This task is a disallowed-command Tool Request handoff. Resolve it through\n" +
      "the dedicated tool-request commands below — not generic recover, which\n" +
      "would requeue it with the request unresolved and trip the same handoff\n" +
      "(or an immediate repeat/failure loop) again.\n\n",
  );
  write("Inspect the request:\n");
  write(`  ${formatAdminCommand(buildToolRequestListArgv(task, dbPath))}\n\n`);
  write("If you already ran the command externally and committed+pushed the result:\n");
  write(`  ${formatAdminCommand(buildToolRequestResolveArgv(task, "manual-done", dbPath, sessionsPath))}\n\n`);
  write("To have the orchestrator run the approved command for you:\n");
  write(`  ${formatAdminCommand(buildToolRequestGrantArgv(task, dbPath, sessionsPath))}\n\n`);
  write("To reject the request and leave it as a human handoff:\n");
  write(`  ${formatAdminCommand(buildToolRequestResolveArgv(task, "reject", dbPath, sessionsPath))}\n`);
  await pause();
}

/**
 * Surface the safe commands for returning a plain `ready_for_human` handoff. The
 * UI does not run these directly: a review return needs operator-supplied
 * feedback, and the target lane is an operator decision — so this is a read-only
 * view that prints exact copy/paste commands and never mutates DB state.
 *
 * For an ordinary human-review return, `human-review-return` is the correct
 * path: it records the (sanitized) review feedback the fix agent needs and swaps
 * the GitHub labels via the outbox — neither of which generic `recover` does.
 * Generic `recover --from ready_for_human --phase <phase>` is offered only for
 * handoffs that must re-queue into a specific lane (e.g. `conflict_resolution`);
 * the operator chooses the phase rather than defaulting to the task's current
 * phase, which could put a review return back in the wrong lane.
 */
async function showHumanReviewReturnCommands(
  task: AiTask,
  dbPath?: string,
  sessionsPath?: string,
): Promise<void> {
  clear();
  write(`Return human handoff — ${task.sessionId} #${task.issueNumber}\n\n`);
  write(
    "This task is a human handoff (ready_for_human). Choose the correct path —\n" +
      "do NOT blindly requeue it into its current phase. A human-review return\n" +
      "belongs in human-review-return so the review feedback and labels are\n" +
      "recorded; other handoffs may need a specific lane.\n\n",
  );
  write("Return a human-reviewed PR to fix mode (records feedback + swaps labels):\n");
  write(
    `  ${formatAdminCommand(buildHumanReviewReturnArgv(task, ["--feedback-source", "issue-comment"], dbPath, sessionsPath))}\n`,
  );
  write(
    `  ${formatAdminCommand(buildHumanReviewReturnArgv(task, ["--feedback", "<operator note>"], dbPath, sessionsPath))}\n\n`,
  );
  write("Re-queue into a specific lane (pick <phase>, e.g. conflict_resolution):\n");
  write(`  ${formatAdminCommand(buildRecoverArgv(task, dbPath))}\n\n`);
  write("Inspect:\n");
  write(`  ${formatAdminCommand([
    "task-status",
    "--session-id",
    task.sessionId,
    "--issue-number",
    String(task.issueNumber),
    ...(dbPath ? ["--db-path", dbPath] : []),
  ])}\n`);
  await pause();
}

/**
 * Surface the review-dispute protocol state and the commands that may act on it
 * (issue #848). Read-only: like the Tool Request and human-handoff views, this
 * prints exact copy/paste commands and never mutates DB state itself, so every
 * safeguard `admin dispute reopen` enforces — exact lineage/version CAS, the
 * terminal-state gate, the claimed/running refusal, the preview default — stays
 * in the loop.
 *
 * The detail rendered above this view already carries the lineage/counter state
 * and the supported next action; what this adds is the exact command form, plus
 * the reason there is no command for an escalated lineage.
 */
async function showDisputeCommands(
  task: AiTask,
  events: readonly TaskEvent[],
  dbPath?: string,
  sessionsPath?: string,
): Promise<void> {
  clear();
  write(`Review dispute — ${task.sessionId} #${task.issueNumber}\n\n`);
  const summary = summarizeDisputeStatus(task, events);
  if (summary === null) {
    write("This task carries no review-dispute state.\n");
    await pause();
    return;
  }

  write(formatDisputeDetail(task, events).join("\n").trimStart() + "\n\n");

  write("Full state (same projection, non-interactive):\n");
  write(`  ${formatAdminCommand(buildDisputeStatusArgv(task, dbPath, sessionsPath))}\n\n`);

  if (summary.reopenEligibleLineageIds.length > 0) {
    write(
      "Flag a RESOLVED lineage for human attention (§6.4). This records a request and parks\n" +
        "the task at ready_for_human; it does not overturn the resolution, move the lineage out\n" +
        "of its terminal state, or reset any counter. Previews without --yes:\n",
    );
    for (const lineageId of summary.reopenEligibleLineageIds) {
      const version = summary.lineages.find((l) => l.lineageId === lineageId)?.version ?? 1;
      write(
        `  ${formatAdminCommand(
          disputeReopenArgv({
            sessionId: task.sessionId,
            issueNumber: task.issueNumber,
            lineageId,
            version,
            dbPath,
            // `dispute reopen` resolves the session for its §6.1 limits, so a UI
            // started on a custom registry must hand that registry to the command
            // it prints — the default one may not hold this session at all.
            sessionsPath,
          }),
        )}\n`,
      );
    }
    write("\n");
  }

  if (!summary.nextAction.authorized) {
    write("No automated continuation is authorized:\n");
    write(`  ${summary.nextAction.reason}: ${oneLine(summary.nextAction.description)}\n`);
  }
  await pause();
}

/**
 * The action menu for a task. A `ready_for_human` task whose handoff is a
 * review-loop cap is requeued via `recover-cap-handoff`, which clears
 * `reviewLoopCapReached`/`reviewCycles`. The generic `recover` path would
 * requeue it with stale cap metadata and trip the cap again immediately, so for
 * cap handoffs the generic recover action is hidden and the operator is routed
 * to cap-reset instead.
 *
 * Likewise, a Tool Request handoff (`context.toolRequest`) must be resolved via
 * the dedicated `tool-request resolve`/`tool-request grant` flows, which carry
 * their own dirty/ahead-of-origin safeguards and outbox/metadata updates.
 * Generic `recover` would requeue it with the request unresolved, so for these
 * handoffs generic recover is hidden and the operator is routed to the
 * tool-request action instead.
 *
 * Any remaining `ready_for_human` task is a plain human handoff (ordinary review
 * or conflict return). It is routed to the `human-review` action — a read-only
 * command view — rather than auto-running generic `recover` at the task's current
 * phase: a review return belongs in `human-review-return` (which records the
 * review feedback and swaps labels via the outbox), and other handoffs may need a
 * different lane (e.g. `conflict_resolution`). Requeuing at the current phase
 * could put the task back in the wrong lane with missing feedback/label state.
 *
 * For any other task, generic `recover` only requeues a `failed` task or an
 * expired `claimed`/`running` lease. For states it cannot move — e.g. `blocked`,
 * or a `claimed`/`running` task whose lease is still active — recover is a
 * documented no-op, so it is hidden rather than offering a dead-end action.
 *
 * Issue #848 adds one more action, and it is additive rather than exclusive: a
 * task carrying review-dispute state gets a `dispute` entry ALONGSIDE whatever
 * recovery action applies, because the protocol view answers a different
 * question ("what does the debate hold, and may I act on it?") than the recovery
 * actions do. It is a read-only command view, so offering it next to a recovery
 * action cannot produce a conflicting mutation.
 */
export function buildTaskMenuActions(
  task: AiTask,
  now: string,
  lockState?: WorktreeLockState,
): { action: MenuAction; label: string }[] {
  const actions: { action: MenuAction; label: string }[] = [];
  if (isCapRecoverable(task)) {
    actions.push({
      action: "cap-reset",
      label: "Recover review-loop cap handoff (admin recover-cap-handoff)",
    });
  } else if (isToolRequestHandoff(task)) {
    actions.push({
      action: "tool-request",
      label: "Resolve Tool Request handoff (admin tool-request resolve/grant)",
    });
  } else if (isHumanReviewHandoff(task)) {
    actions.push({
      action: "human-review",
      label: "Return human handoff (admin human-review-return / recover)",
    });
  } else if (isRecoverable(task, now)) {
    actions.push({ action: "recover", label: "Recover / requeue (admin recover)" });
  }
  if (hasDisputeState(task)) {
    actions.push({ action: "dispute", label: "Review dispute state / actions (admin dispute)" });
  }
  // `held` and `stale` are mutually exclusive (IssueLockReader reports a lock as
  // `locked = !stale`). A stale lock (past its TTL) releases with `--yes`, but a
  // live held lock is refused by `worktree release-lock` unless `--force` is also
  // given — so a plain `--yes` release action would silently no-op for it. Route
  // a live lock to a distinct force-release action that collects an extra
  // confirmation before passing `--force`, rather than offer a dead-end command.
  if (lockState?.stale) {
    actions.push({
      action: "lock-release",
      label: "Release stale worktree lock (admin worktree release-lock)",
    });
  } else if (lockState?.held) {
    actions.push({
      action: "lock-force-release",
      label: "Force-release LIVE worktree lock (admin worktree release-lock --force)",
    });
  }
  actions.push(
    { action: "status", label: "Show worktree & lock status (admin status)" },
    { action: "events", label: "Show recent task events" },
    { action: "artifacts", label: "Show latest run artifacts path" },
    { action: "copy", label: "Show exact non-interactive admin commands" },
    { action: "back", label: "Back to list" },
    { action: "quit", label: "Quit" },
  );
  return actions;
}

const CAP_RESET_PHASES = ["implementation", "review", "conflict_resolution", "research", "planner"] as const;

async function selectCapResetPhase(): Promise<string> {
  return unwrap(
    await clackSelect<string>({
      message: "Select target phase for recover-cap-handoff:",
      options: CAP_RESET_PHASES.map((p) => ({ value: p, label: p })),
      initialValue: "implementation",
    }),
  );
}

async function taskMenu(
  store: TaskStore,
  task: AiTask,
  now: string,
  dbPath: string | undefined,
  sessionsPath: string | undefined,
  lockState?: WorktreeLockState,
): Promise<MenuAction> {
  const actions = buildTaskMenuActions(task, now, lockState);

  // Issue #848: the §7.1 routing intent and the undispatched-turn stop reason are
  // event-only facts, so the detail view needs the task's events to report them.
  // Read only for a task that actually carries protocol state — a legacy task
  // costs no extra query and renders exactly as before.
  const disputeEvents = hasDisputeState(task)
    ? await store.listEvents({ sessionId: task.sessionId, issueNumber: task.issueNumber })
    : undefined;

  clear();
  const header = formatTaskDetail(task, now, lockState, disputeEvents) + "\n\n" + "Choose an action:";
  const idx = await selectMenu({
    header,
    items: actions,
    render: (a) => a.label,
  });
  const choice = actions[idx].action;

  switch (choice) {
    case "recover":
      await runStateChange(task, buildRecoverArgv(task, dbPath));
      return "back";
    case "cap-reset": {
      const capPhase = await selectCapResetPhase();
      await runStateChange(task, buildCapResetArgv(task, dbPath, capPhase));
      return "back";
    }
    case "tool-request":
      await showToolRequestCommands(task, dbPath, sessionsPath);
      return "back";
    case "human-review":
      await showHumanReviewReturnCommands(task, dbPath, sessionsPath);
      return "back";
    case "dispute":
      await showDisputeCommands(task, disputeEvents ?? [], dbPath, sessionsPath);
      return "back";
    case "lock-release":
      await runStateChange(task, buildLockReleaseArgv(task));
      return "back";
    case "lock-force-release": {
      // The lock is live (within its TTL); force-releasing it while a run may
      // still hold the worktree could let two runs touch it concurrently. Gate the
      // `--force` behind an explicit extra confirmation before running the command
      // (runStateChange then previews and confirms the command itself).
      clear();
      const forced = await confirm(
        "The worktree lock is LIVE (within its TTL) — a run may still be active.\n" +
          "Force-release it anyway? Only do this if you are certain no run is active.",
      );
      if (!forced) {
        clear();
        write("\nCancelled. No changes made.\n");
        await pause();
        return "back";
      }
      await runStateChange(task, buildLockReleaseArgv(task, { force: true }));
      return "back";
    }
    case "status": {
      const statusArgv = buildStatusArgv(task, dbPath, sessionsPath);
      const result = runAdminCommand(statusArgv);
      clear();
      write(`Worktree & lock status — ${task.sessionId} #${task.issueNumber}\n\n`);
      write(result.stdout.trim() + "\n");
      await pause();
      return "back";
    }
    case "events":
      await showEvents(store, task);
      return "back";
    case "artifacts":
      await showArtifacts(task);
      return "back";
    case "copy":
      await showCopyableCommands(task, now, dbPath, sessionsPath);
      return "back";
    default:
      return choice;
  }
}

async function showInspectCommand(task: AiTask, dbPath?: string): Promise<void> {
  clear();
  write(`Inspect — ${task.sessionId} #${task.issueNumber}\n\n`);
  write(
    "This issue is closed on GitHub. State-changing actions are disabled.\n" +
      "To act on this task, reopen the GitHub issue first.\n\n",
  );
  write("Inspect:\n");
  write(
    `  ${formatAdminCommand([
      "task-status",
      "--session-id",
      task.sessionId,
      "--issue-number",
      String(task.issueNumber),
      ...(dbPath ? ["--db-path", dbPath] : []),
    ])}\n`,
  );
  await pause();
}

async function closedTaskMenu(
  store: TaskStore,
  task: AiTask,
  now: string,
  dbPath: string | undefined,
): Promise<ClosedMenuAction> {
  const actions = buildClosedTaskMenuActions();
  clear();
  const header =
    formatTaskDetail(task, now) +
    "\n\n[Closed GitHub issue — inspect/cleanup only]\n\nChoose an action:";

  const idx = await selectMenu({
    header,
    items: actions,
    render: (a) => a.label,
  });
  const choice = actions[idx].action;

  switch (choice) {
    case "events":
      await showEvents(store, task);
      return "back";
    case "artifacts":
      await showArtifacts(task);
      return "back";
    case "inspect":
      await showInspectCommand(task, dbPath);
      return "back";
    default:
      return choice;
  }
}

/**
 * Secondary list showing confirmed-closed-issue residual tasks with inspect-only
 * actions. Returns "quit" when the operator selects quit, or "back" when they
 * exit the list (q / escape).
 */
async function closedTaskList(
  store: TaskStore,
  tasks: AiTask[],
  now: string,
  dbPath: string | undefined,
): Promise<"quit" | "back"> {
  for (;;) {
    clear();
    const header =
      `Closed/stale local tasks (${tasks.length}) — inspect/cleanup only\n` +
      `These issues are closed on GitHub. Reopen an issue to enable recovery actions.\n` +
      `as of ${now}`;

    const value = unwrap(
      await clackSelect<string>({
        message: header,
        options: [
          ...tasks.map((t, i) => ({ value: `idx:${i}`, label: formatTaskLine(t, now) })),
          { value: "back", label: "←  Back to active list" },
        ],
        maxItems: DEFAULT_PAGE_SIZE,
      }),
    );
    if (value === "back") return "back";

    const selected = tasks[Number(value.slice(4))];
    const fresh =
      (await store.getTask({
        sessionId: selected.sessionId,
        issueNumber: selected.issueNumber,
      })) ?? selected;

    const action = await closedTaskMenu(store, fresh, now, dbPath);
    if (action === "quit") return "quit";
  }
}

/**
 * Present a Clack select for the operator to pick a session scope. Returns the
 * chosen scope: either one specific session or "all sessions".
 */
async function runSessionSelector(
  sessionIds: string[],
  current: SessionScope,
): Promise<SessionScope> {
  const options: { value: string; label: string }[] = [
    { value: "all", label: `All sessions (${sessionIds.length})` },
    ...sessionIds.map((id) => ({ value: id, label: id })),
  ];
  const initialValue = current.kind === "all" ? "all" : current.sessionId;
  const value = unwrap(
    await clackSelect<string>({
      message: "Select session to view",
      options,
      initialValue,
    }),
  );
  if (value === "all") return { kind: "all" };
  return { kind: "one", sessionId: value };
}

async function interactiveLoop(
  store: TaskStore,
  sessionIds: string[],
  dbPath: string | undefined,
  sessionsPath: string | undefined,
  issueStateReader: IssueStateReader,
  lockReader?: IssueLockReader,
): Promise<void> {
  // Cache starts empty so the initial render is instant — all states return
  // "unknown" and the operator sees a DB-local warning. GitHub state is only
  // verified when the operator explicitly selects "Refresh GitHub issue states".
  const stateCache = new Map<string, IssueState>();
  const cachedReader = buildCachingReader(stateCache);

  // Preserve the operator's place in the (paged) list across renders so that
  // returning from a task menu does not jump back to the top of page 1.
  let selectedIndex = 0;

  // Active filter; starts empty (all tasks shown).
  let filter: UiFilter = {};

  // In multi-session mode (no --session-id / --session-ref), start with an
  // explicit session selector so the operator knows which session they are
  // operating on. Single-session mode (locked) skips the selector entirely.
  const multiSessionMode = sessionIds.length > 1;
  let scope: SessionScope = multiSessionMode
    ? { kind: "one", sessionId: sessionIds[0] }
    : { kind: "all" };

  // On first entry in multi-session mode, present the session picker.
  if (multiSessionMode) {
    scope = await runSessionSelector(sessionIds, scope);
  }

  for (;;) {
    const scopedIds = sessionIdsForScope(scope, sessionIds);
    const now = new Date().toISOString();
    const allActiveTasks = await collectActiveTasks(store, scopedIds);
    const { active: allActive, closedResidual, warning } = partitionByGitHubState(
      allActiveTasks,
      cachedReader,
    );

    // Apply filter to the partitioned active set; closed residual is unaffected.
    const active = isFilterActive(filter) ? applyFilter(allActive, filter) : allActive;

    if (allActive.length === 0 && closedResidual.length === 0) {
      clear();
      const sessionLabel = formatSessionScope(scope, sessionIds.length);
      write(`No active tasks for session: ${sessionLabel}.\n`);
      if (multiSessionMode) {
        const switchNow = unwrap(
          await clackSelect<string>({
            message: "What would you like to do?",
            options: [
              { value: "switch", label: "Switch to another session" },
              { value: "quit", label: "Quit" },
            ],
          }),
        );
        if (switchNow === "switch") {
          scope = await runSessionSelector(sessionIds, scope);
          selectedIndex = 0;
          filter = {};
          continue;
        }
      } else {
        await pause("Press any key to exit…");
      }
      return;
    }

    const sessionLabel = formatSessionScope(scope, sessionIds.length);
    let header =
      `Active tasks (${allActive.length})  Session: ${sessionLabel}` +
      `\nas of ${now}`;
    if (warning) header += `\n\n⚠ ${warning}`;

    // Clamp selectedIndex when the filtered set is smaller than before.
    if (active.length > 0) {
      selectedIndex = Math.min(selectedIndex, active.length - 1);
    }

    const result = await selectTaskFromList({
      header,
      tasks: active,
      now,
      pageSize: DEFAULT_PAGE_SIZE,
      hasClosed: closedResidual.length > 0,
      initialIndex: selectedIndex,
      filter,
      multiSession: multiSessionMode,
    });

    if (result.kind === "back") return;

    if (result.kind === "switch-session") {
      scope = await runSessionSelector(sessionIds, scope);
      selectedIndex = 0;
      filter = {};
      continue;
    }

    if (result.kind === "filter") {
      filter = await runFilterMenu(filter);
      selectedIndex = 0;
      continue;
    }

    if (result.kind === "clear-filter") {
      filter = {};
      selectedIndex = 0;
      continue;
    }

    if (result.kind === "refresh") {
      clear();
      write(`Verifying GitHub issue states for ${allActiveTasks.length} task(s)…\n`);
      write("This may take a moment. Press Ctrl-C to abort.\n");
      populateStateCache(allActiveTasks, issueStateReader, stateCache);
      write("\nDone.\n");
      await pause();
      continue;
    }

    if (result.kind === "closed") {
      const closedResult = await closedTaskList(store, closedResidual, now, dbPath);
      if (closedResult === "quit") return;
      continue;
    }

    // Remember the selected row so the list reopens in the same place.
    selectedIndex = result.index;

    // Re-read the selected task so the detail view reflects the latest state.
    const task = active[result.index];
    const fresh =
      (await store.getTask({
        sessionId: task.sessionId,
        issueNumber: task.issueNumber,
      })) ?? task;

    // Per-task guard: verify state now (one gh call) before showing the menu.
    // The main list uses the cache which starts empty, so tasks with closed
    // issues would otherwise reach taskMenu without the closed-issue safeguard.
    const liveState = issueStateReader(fresh.sessionId, fresh.issueNumber);
    stateCache.set(`${fresh.sessionId}:${fresh.issueNumber}`, liveState);
    if (liveState === "closed") {
      const closedAction = await closedTaskMenu(store, fresh, now, dbPath);
      if (closedAction === "quit") return;
      continue;
    }

    const lockState = lockReader ? lockReader(fresh.sessionId, fresh.issueNumber) : undefined;
    const action = await taskMenu(store, fresh, now, dbPath, sessionsPath, lockState);
    if (action === "quit") return;
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function runAdminUi(argv: string[]): Promise<void> {
  const parsed = parseUiArgs(argv);
  if ("error" in parsed) die(parsed.error);

  // Degrade gracefully before touching sessions or the DB: a non-TTY caller can
  // never interact, so print the equivalent commands and exit non-zero.
  if (!isInteractive()) {
    process.stdout.write(nonTtyHelp());
    process.exit(2);
  }

  let sessionIds: string[];
  try {
    sessionIds = await resolveSessionIds(parsed);
  } catch (err) {
    die(err instanceof Error ? err.message : String(err));
  }

  // Build a session map for GitHub issue state lookups. Load the registry if
  // available; if not (e.g. --session-id without sessions.json), the map is
  // empty and all lookups return "unknown", which triggers a warning in the UI.
  // For sessions with non-gh auth (e.g. github-app), resolve a token-injecting
  // GhRunner so the issue state check uses the session's configured credentials.
  const sessionMap = new Map<string, { githubRepo: string; repoRoot: string; runner?: GhRunner | null }>();
  if (existsSync(parsed.sessionsPath)) {
    try {
      const registry = new JsonSessionRegistry(parsed.sessionsPath);
      const sessionIdSet = new Set(sessionIds);
      for (const s of (await registry.listSessions()).filter(s => sessionIdSet.has(s.sessionId))) {
        const auth = s.workItemProvider.auth;
        let runner: GhRunner | null | undefined;
        if (auth.mode !== "gh") {
          try {
            runner = await resolveGhRunner(auth, defaultGhRunner);
          } catch {
            // App auth resolution failed (e.g. bad credentials). Set runner to
            // null so buildGhIssueStateReader returns "unknown" instead of
            // silently falling back to the operator's raw gh credentials.
            runner = null;
          }
        }
        sessionMap.set(s.sessionId, { githubRepo: s.githubRepo, repoRoot: s.repoRoot, runner });
      }
    } catch {
      // Registry error → reader returns "unknown" for all tasks → warning shown
    }
  }
  const issueStateReader = buildGhIssueStateReader(sessionMap);

  // Only thread the sessions path through to the printed commands when it
  // differs from the default registry. A custom `--sessions-path` must be
  // preserved on the tool-request commands (they default to
  // DEFAULT_SESSIONS_PATH), but emitting it for the default keeps the
  // copy/paste commands needlessly verbose.
  const sessionsPath =
    parsed.sessionsPath !== DEFAULT_SESSIONS_PATH ? parsed.sessionsPath : undefined;

  const issueLock = new IssueWorktreeLock();
  const lockReader: IssueLockReader = (sessionId, issueNumber) => {
    const result = issueLock.inspect(sessionId, issueNumber);
    return { held: result.locked, stale: result.stale };
  };

  const store = new SqliteTaskStore(parsed.dbPath);
  try {
    await interactiveLoop(store, sessionIds, parsed.dbPath, sessionsPath, issueStateReader, lockReader);
  } catch (err) {
    // Clack manages raw mode itself, so there is no terminal state to restore
    // here. A cancelled prompt (Ctrl-C / Escape) surfaces as UiCancelled: close
    // the store and exit with the interrupt code, preserving the Ctrl-C cleanup
    // contract without mutating any task state.
    store.close();
    if (err instanceof UiCancelled) {
      clackCancel("Interrupted — no changes made.");
      process.stdin.pause();
      process.exit(130);
    }
    throw err;
  }
  store.close();
  emit({ ok: true, exited: "ui" });
}
