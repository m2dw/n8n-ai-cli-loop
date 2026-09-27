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
import { randomUUID } from "crypto";
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
import { emit, die, writeOut, exitProcess } from "./cli-io.js";
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
import { resolvePrContext } from "../core/pr-context.js";
// Issue #848: the UI renders the SAME projection the non-interactive commands
// do, and routes every dispute mutation back through `admin dispute reopen`
// rather than writing protocol state itself.
import { REVIEW_DISPUTE_CONTEXT_KEY } from "../core/review-dispute-commit.js";
import { disputeReopenArgv, summarizeDisputeStatus } from "../core/review-dispute-status.js";
import { formatEvidenceParty } from "../core/review-dispute-evidence-state.js";
// Issue #977: the refinement lane's operator view. The UI renders the SAME
// normalized model `admin task-status` does, through the same core helpers —
// it maintains no interpretation of milestones, states, or deadlines of its own.
// Issue #1044: the verification-plan view runs the SAME `admin
// task-verification` commands an operator would type — it resolves no plan, and
// writes no state, of its own.
import {
  VERIFICATION_AMENDMENTS_CONTEXT_KEY,
  MAX_VERIFICATION_AMENDMENT_ACTOR_ID_CHARS,
  MAX_VERIFICATION_AMENDMENT_COMMAND_CHARS,
  MAX_VERIFICATION_AMENDMENT_NAME_CHARS,
  MAX_VERIFICATION_AMENDMENT_OPERATIONS,
  MAX_VERIFICATION_AMENDMENT_REASON_CHARS,
  MAX_VERIFICATION_AMENDMENT_REVISIONS,
  MAX_VERIFICATION_SESSION_BASELINE_ENTRIES,
} from "../core/verification-amendment.js";
import { MAX_VERIFICATION_PLAN_REQUIREMENTS } from "../core/verification-plan.js";
import { REFINEMENT_CONTEXT_KEY } from "../core/issue-refinement.js";
import {
  renderRefinementCriticBlockLine,
  summarizeRefinementStatus,
} from "../core/issue-refinement-status.js";
import { renderRefinementProgressLines } from "../core/issue-refinement-progress-status.js";

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
    !isToolRequestHandoff(task) &&
    !isRefinementRecoverable(task)
  );
}

/**
 * Whether `admin refinement recover` applies to this task (issue #980).
 *
 * A refinement handoff is `ready_for_human` like every other one, so without
 * this it would route to the generic human-handoff view — whose two commands
 * are both wrong for it. `human-review-return` records review feedback and
 * swaps the review lane's labels, and generic `recover` would requeue the row
 * with the failed attempt's rejected draft, counters, and handoff reason still
 * on the block, which §13 forbids outright ("recovery restarts the attempt from
 * `pending` or it does nothing"). The dedicated command is the only one that
 * performs row 36.
 *
 * Uses the same evaluation the command itself does, minus the parts that need
 * I/O (the live label shape, the issue lock), so the UI cannot offer an action
 * the command would refuse on task state.
 */
export function isRefinementRecoverable(task: AiTask): boolean {
  if (task.status !== "ready_for_human" || task.phase !== "refinement") return false;
  const block = task.context?.[REFINEMENT_CONTEXT_KEY];
  if (!block || typeof block !== "object" || Array.isArray(block)) return false;
  return (block as Record<string, unknown>)["state"] === "escalated_human";
}

/**
 * Statuses `admin task reconcile-merged` can write (issue #1048): the §7 rows
 * that transition to `done` plus the two terminal rows that record the merge.
 * `done` is a no-op, and `claimed`/`running` are never reconciled at all.
 */
const MERGED_PR_RECONCILABLE_STATUSES: TaskStatus[] = [
  "queued",
  "blocked",
  "ready_for_human",
  "failed",
  "cancelled",
];

/**
 * Whether `admin task reconcile-merged` could act on this task (issue #1048).
 *
 * Evaluated from task state alone — the same shape the other predicates here
 * use — so the UI never offers a dead-end action: a task with no recorded
 * `prUrl` is refused `missing-pr-identity` (the identity is never derived from
 * the Issue number), and a `claimed`/`running`/`done` row has no writing
 * outcome in the contract. Whether the recorded PR is actually MERGED is a live
 * provider question, and answering it is exactly what the command's preview is
 * for — which is why the UI surfaces the commands instead of running them.
 */
export function isMergedPrReconcilable(task: AiTask): boolean {
  if (!MERGED_PR_RECONCILABLE_STATUSES.includes(task.status)) return false;
  const { prUrl } = resolvePrContext(task);
  return prUrl !== undefined && prUrl.length > 0;
}

/**
 * Collect the tasks an operator can act on across the given sessions,
 * most-recently-updated first. Read-only: this only reads from the store and
 * never mutates task state.
 *
 * Active statuses, plus (issue #1048) a task the merged-PR reconciliation
 * command could still write. In practice that second clause admits exactly one
 * extra shape — a `cancelled` task with a recorded PR — because every other
 * reconcilable status is already active. Without it the `reconcile-merged`
 * action added to the task menu would be unreachable for the contract's
 * `recorded-terminal` cancelled case: the menu is only ever built for a task
 * this function returned. `done` is still excluded (it has no reconciliation
 * outcome either), so the list keeps its "not finished" meaning.
 */
export async function collectActiveTasks(store: TaskStore, sessionIds: string[]): Promise<AiTask[]> {
  const out: AiTask[] = [];
  for (const sid of sessionIds) {
    for (const task of await store.listSessionTasks(sid)) {
      if (isActiveStatus(task.status) || isMergedPrReconcilable(task)) out.push(task);
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
 * Argv for `admin refinement recover` for this task (issue #980).
 *
 * `--yes` is opt-in rather than baked in: the command previews by default, and
 * the preview is the step that reports the live label shape §13 requires before
 * a reset is allowed. The UI surfaces both forms and runs neither, for the same
 * reason it does not run `tool-request` — the operator may still have a label
 * to restore first.
 */
export function buildRefinementRecoverArgv(
  task: AiTask,
  dbPath?: string,
  sessionsPath?: string,
  options: { yes?: boolean } = {},
): string[] {
  const argv = [
    "refinement",
    "recover",
    "--session-id",
    task.sessionId,
    "--issue-number",
    String(task.issueNumber),
  ];
  if (options.yes) argv.push("--yes");
  if (dbPath) argv.push("--db-path", dbPath);
  // The command resolves the session (and its labels/repo) from the registry,
  // so preserve a custom one the UI was launched with.
  if (sessionsPath) argv.push("--sessions-path", sessionsPath);
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

/**
 * Argv for `admin task reconcile-merged` for this task (issue #1048).
 *
 * `--yes` is opt-in rather than baked in, for the same reason the refinement
 * builder above leaves it out: the preview is the step that performs the live
 * provider read and reports whether the recorded PR is actually MERGED. Running
 * the apply straight from a menu would ask an operator to confirm a mutation
 * whose eligibility nobody has seen yet.
 */
export function buildTaskReconcileMergedArgv(
  task: AiTask,
  dbPath?: string,
  sessionsPath?: string,
  options: { yes?: boolean } = {},
): string[] {
  const argv = [
    "task",
    "reconcile-merged",
    "--session-id",
    task.sessionId,
    "--issue-number",
    String(task.issueNumber),
  ];
  if (options.yes) argv.push("--yes");
  if (dbPath) argv.push("--db-path", dbPath);
  // The command resolves the session's repo host (and the comment's target
  // repo) from the registry, so preserve a custom one the UI was launched with.
  if (sessionsPath) argv.push("--sessions-path", sessionsPath);
  return argv;
}

// ---------------------------------------------------------------------------
// Verification plan amendment (issue #1044, docs/verification-amendment-contract.md §11)
// ---------------------------------------------------------------------------
//
// The UI adds NO capability here (§17): every argv below is a command an
// operator could type, every mutation previews before it applies, and the
// decision logic — plan resolution, the §7 refusals, the §9.2 continuation, the
// §12 audit and publication — stays in `admin task-verification`, reached
// through the same spawn as every other state change. What the UI adds is the
// part a command line cannot: the current plan in front of the operator while
// they choose a slot, the previous reason prefilled while they write the next
// one, and the plan digest they just read carried into the apply as a guard.

/** The identity flags every `task-verification` action takes. */
function taskVerificationArgv(
  action: string,
  task: AiTask,
  dbPath?: string,
  sessionsPath?: string,
): string[] {
  const argv = [
    "task-verification",
    action,
    "--session-id",
    task.sessionId,
    "--issue-number",
    String(task.issueNumber),
  ];
  if (dbPath) argv.push("--db-path", dbPath);
  // Every action resolves the session for `session.verification` — the live
  // execution layer of the plan (§6.1 step 1) — so a UI started on a custom
  // registry must hand that registry to the command it runs.
  if (sessionsPath) argv.push("--sessions-path", sessionsPath);
  return argv;
}

/** Argv for the read-only `admin task-verification show`. */
export function buildTaskVerificationShowArgv(
  task: AiTask,
  dbPath?: string,
  sessionsPath?: string,
  options: { json?: boolean } = {},
): string[] {
  const argv = taskVerificationArgv("show", task, dbPath, sessionsPath);
  if (options.json) argv.push("--json");
  return argv;
}

/**
 * One operation clause of an `amend`, in the order the CLI's grammar reads it:
 * the operation flag, then the value it names, then its `--command` and
 * `--op-reason` when it takes them (§11 rule 3's binding rule).
 */
export interface VerificationAmendOperation {
  flag:
    | "--replace"
    | "--add-execution"
    | "--add-requirement"
    | "--retire"
    | "--restore"
    | "--annotate";
  /** The `commandId` (or, for `--add-execution`, the name) the flag takes. */
  value?: string;
  /** The bytes for the operations that take a `--command`. */
  command?: string;
  /** The per-operation `--op-reason`, when the operator supplied one. */
  opReason?: string;
}

/**
 * Argv for `admin task-verification amend`.
 *
 * The clause order is the contract: each `--command`/`--op-reason` binds to the
 * operation flag it follows, so the operations are emitted in sequence and the
 * revision-level `--reason` comes after all of them, where it cannot be mistaken
 * for an operation's own.
 */
export function buildTaskVerificationAmendArgv(
  task: AiTask,
  options: {
    operations: readonly VerificationAmendOperation[];
    reason: string;
    continueMode?: "review" | "implementation" | "none";
    expectPlanDigest?: string;
    requestKey?: string;
    yes?: boolean;
    json?: boolean;
  },
  dbPath?: string,
  sessionsPath?: string,
): string[] {
  const argv = taskVerificationArgv("amend", task, dbPath, sessionsPath);
  for (const operation of options.operations) {
    argv.push(operation.flag);
    if (operation.value !== undefined) argv.push(operation.value);
    if (operation.command !== undefined) argv.push("--command", operation.command);
    if (operation.opReason !== undefined) argv.push("--op-reason", operation.opReason);
  }
  argv.push("--reason", options.reason);
  if (options.continueMode) argv.push("--continue", options.continueMode);
  // The digest the operator was shown, carried into the apply: a plan that moved
  // between the preview and the confirmation refuses (§7.3 rule 3) instead of
  // amending something nobody read.
  if (options.expectPlanDigest) argv.push("--expect-plan-digest", options.expectPlanDigest);
  if (options.requestKey) argv.push("--request-key", options.requestKey);
  if (options.yes) argv.push("--yes");
  if (options.json) argv.push("--json");
  return argv;
}

/** Argv for `admin task-verification refresh-from-issue` (§10). */
export function buildTaskVerificationRefreshArgv(
  task: AiTask,
  options: {
    reason: string;
    allowRetire?: boolean;
    expectIssueDigest?: string;
    expectPlanDigest?: string;
    requestKey?: string;
    yes?: boolean;
  },
  dbPath?: string,
  sessionsPath?: string,
): string[] {
  const argv = taskVerificationArgv("refresh-from-issue", task, dbPath, sessionsPath);
  argv.push("--reason", options.reason);
  if (options.allowRetire) argv.push("--allow-retire");
  if (options.expectIssueDigest) argv.push("--expect-issue-digest", options.expectIssueDigest);
  // The refresh's difference is derived from TWO inputs — the live Issue and the
  // task's own effective plan — so an apply guarded on the Issue alone can still
  // apply a different set of additions and retirements than the preview showed,
  // if another revision moved the plan in between (issue #1044 review).
  if (options.expectPlanDigest) argv.push("--expect-plan-digest", options.expectPlanDigest);
  // A refresh's operations are DERIVED from its own read of the Issue, so a
  // keyless one is recognized by re-deriving that key from what it recorded —
  // matching any later keyless refresh of the same body (issue #1044 review,
  // P1). An explicit key states which request this invocation IS: the apply line
  // the UI prints replays exactly, on a claimed task too, because the
  // supplied-key lookup precedes the §7.1 refusals, and a deliberate repeat of
  // the same refresh stays a separate request.
  if (options.requestKey) argv.push("--request-key", options.requestKey);
  if (options.yes) argv.push("--yes");
  return argv;
}

/**
 * A `--request-key` for ONE interactive amendment flow — generated once, named
 * on both the preview and the apply that follows it (§5.3 rule 2, issue #1044
 * review, P1).
 *
 * Omitting the key makes the core derive one from the invocation's own content,
 * which is right for a scripted caller and wrong here: an operator who retires a
 * slot, restores it, and retires it again from this UI types the same operation
 * with the same reason, so the derived key is the same key. The preview still
 * shows the retirement — previews do not look up replays — and the apply is then
 * answered as a replay of the FIRST retirement, reporting a revision that is
 * already superseded and leaving the slot active after a confirmation that said
 * otherwise.
 *
 * A fresh key per flow states the opposite: this is a deliberate repeat, not a
 * retry. Retry-safety is not given up, because the SAME key reaches the apply and
 * the UI prints the apply line it ran — re-running that exact line, which is the
 * one retry an operator has, is recognized as the §5.3 replay it is rather than
 * recording a second revision.
 *
 * Shaped to §5.3 rule 2's `/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/`: 40 characters,
 * and `ui` marks the surface it came from in the recorded chain.
 */
export function newVerificationRequestKey(): string {
  return `vreq-ui-${randomUUID().replace(/-/g, "")}`;
}

/**
 * The `live Issue body digest:` line `refresh-from-issue` prints on every
 * outcome that read the Issue.
 *
 * `refresh-from-issue` has no `--json`, so the digest an operator was shown is
 * recovered from the rendered preview — which is the same text the operator
 * reads on screen, so the value carried into the apply is literally the one they
 * confirmed.
 */
export function parseRefreshIssueBodyDigest(stdout: string): string | null {
  const match = /^\s*live Issue body digest:\s*(\S+)\s*$/m.exec(stdout);
  return match === null ? null : match[1];
}

/**
 * The BASE plan digest of a `plan digest: <base> -> <new>` preview line — the
 * plan the previewed revision was authored against, which is what
 * `--expect-plan-digest` names.
 *
 * Absent from an outcome that produced no revision (a `no_change`, a replay),
 * where there is no revision to guard; a `no_change` reports the plan it
 * resolved through {@link parsePreviewUnchangedPlanDigest} instead.
 */
export function parsePreviewBasePlanDigest(stdout: string): string | null {
  const match = /^\s*plan digest:\s*(\S+)\s*->\s*\S+\s*$/m.exec(stdout);
  return match === null ? null : match[1];
}

/**
 * The plan digest of a `plan digest: <digest> (unchanged)` line — what a
 * `no_change` preview reports in place of a `base -> new` pair.
 *
 * It is the plan THIS invocation resolved, which is the only digest an apply may
 * be guarded on (issue #1044 review, P1). The digest a plan screen printed
 * earlier is not a substitute: the plan can move between that screen and the
 * preview, and a refresh that then finds no difference against the moved plan
 * would be applied under a guard naming the plan nobody diffed — refusing when
 * the move stands, and, if the plan happens to move back, applying operations
 * against a plan the operator never previewed.
 */
export function parsePreviewUnchangedPlanDigest(stdout: string): string | null {
  const match = /^\s*plan digest:\s*(\S+)\s*\(unchanged\)\s*$/m.exec(stdout);
  return match === null ? null : match[1];
}

/**
 * The `--request-key` of a previewed revision, from the
 * `revision: <id> (request key <key>)` line.
 *
 * Only a `reset` needs it carried back (§11 rule 3): a reset derives its
 * operations from the plan, so its own success erases the content a derived key
 * would be recomputed from, and an apply whose response was lost would rerun
 * into "nothing left to undo" — reported as `no_change` — instead of being
 * recognized as the replay of the revision it already recorded.
 */
export function parsePreviewRequestKey(stdout: string): string | null {
  const match = /^\s*revision:\s*\S+\s*\(request key\s+([^\s)]+)\)\s*$/m.exec(stdout);
  return match === null ? null : match[1];
}

/**
 * The revision ordinal an apply actually consumed, from the
 * `Applied as revision ordinal <n>.` line every applying outcome prints — and
 * only an applying outcome prints (issue #1044 review, P2).
 *
 * Exit code 0 is not the same question. A `no_change` refresh or reset, and an
 * apply the core recognized as a §5.3 replay, both succeed and both write
 * nothing: no revision, no §12.1 event, no §12.2 comment. Telling those apart
 * from a recorded revision is what keeps the UI from promising an audit trail
 * that does not exist.
 */
export function parseAppliedRevisionOrdinal(stdout: string): number | null {
  const match = /^\s*Applied as revision ordinal\s+(\d+)\.\s*$/m.exec(stdout);
  return match === null ? null : Number(match[1]);
}

/**
 * Whether a command's bytes, as `task-verification show` PRINTED them, went
 * through the session's redaction (issue #1044 review, P1).
 *
 * `show` sanitizes every command it reports, so a command naming a configured
 * local path (or a secret-shaped token) reaches the UI as `<path>` /
 * `[redacted]` rather than as its real bytes. Those are display text, never
 * executable bytes: prefilling them into a replacement prompt would let an
 * operator making a small edit — or simply accepting the default — store a
 * placeholder as the command the loop runs, breaking the very verification the
 * replacement was meant to correct.
 */
export function isRedactedCommandText(command: string): boolean {
  return command.includes("<path>") || command.includes("[redacted]");
}

/** Argv for `admin task-verification reset` (§11's append-only reversal). */
export function buildTaskVerificationResetArgv(
  task: AiTask,
  options: {
    reason: string;
    allowRetire?: boolean;
    expectPlanDigest?: string;
    requestKey?: string;
    yes?: boolean;
  },
  dbPath?: string,
  sessionsPath?: string,
): string[] {
  const argv = taskVerificationArgv("reset", task, dbPath, sessionsPath);
  argv.push("--reason", options.reason);
  if (options.allowRetire) argv.push("--allow-retire");
  if (options.expectPlanDigest) argv.push("--expect-plan-digest", options.expectPlanDigest);
  // A reset derives its operations from the plan, so a key derived from them
  // cannot survive the reset's own success (§11 rule 3). Passing back the key
  // the preview named is the only way an apply whose response was lost is
  // recognized as a replay rather than reported as "nothing left to undo".
  if (options.requestKey) argv.push("--request-key", options.requestKey);
  if (options.yes) argv.push("--yes");
  return argv;
}

/** The `--json` payload of `task-verification show`, as the UI reads it. */
export interface VerificationPlanView {
  ok: boolean;
  outcome: string;
  planDigest: string;
  reconciliation: string;
  amendable: boolean;
  amendmentRefusal?: string;
  defaultContinuation: string;
  execution: VerificationPlanSlotView[];
  requirement: VerificationPlanSlotView[];
  revisions: VerificationPlanRevisionView[];
  notes: string[];
  drift?: string;
  error?: string;
}

export interface VerificationPlanSlotView {
  commandId: string;
  state: string;
  command: string;
  origin: string;
  amended: boolean;
  /** Requirement layer only: `passed` | `not_run` | `retired` (§6.2 rule 3). */
  status?: string;
  revisionOrdinals: number[];
}

export interface VerificationPlanRevisionView {
  revisionOrdinal: number;
  revisionId: string;
  source: string;
  reason: string;
  operations: string[];
  continuation: string;
  createdAt: string;
}

/**
 * Read the `task-verification show --json` payload.
 *
 * Defensive rather than trusting: the UI spawns the command and gets a string
 * back, and a refusal, a die(), or a future payload change must degrade to "no
 * view" instead of a half-rendered screen. Returns `null` when the output is
 * not a payload this build understands — the caller then shows the raw CLI
 * output, which is the honest thing to put in front of an operator.
 */
export function parseVerificationPlanView(stdout: string): VerificationPlanView | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const raw = parsed as Record<string, unknown>;
  const planDigest = raw.planDigest;
  const error = raw.error;
  if (typeof planDigest !== "string") {
    // A refusal payload still carries enough to report; anything else does not.
    if (raw.ok === false && typeof error === "string") {
      return {
        ok: false,
        outcome: typeof raw.outcome === "string" ? raw.outcome : "refused",
        planDigest: "",
        reconciliation: "",
        amendable: false,
        defaultContinuation: "none",
        execution: [],
        requirement: [],
        revisions: [],
        notes: [],
        error,
      };
    }
    return null;
  }
  const slots = (key: string): VerificationPlanSlotView[] =>
    (Array.isArray(raw[key]) ? (raw[key] as Record<string, unknown>[]) : []).map((row) => ({
      commandId: String(row.commandId ?? ""),
      state: String(row.state ?? ""),
      command: String(row.command ?? ""),
      origin: String(row.origin ?? ""),
      amended: row.amended === true,
      ...(typeof row.status === "string" ? { status: row.status } : {}),
      revisionOrdinals: Array.isArray(row.revisionOrdinals)
        ? (row.revisionOrdinals as unknown[]).filter((n): n is number => typeof n === "number")
        : [],
    }));
  const refusal = (raw.amendmentRefusal ?? {}) as Record<string, unknown>;
  const refusalDetail = refusal.detail;
  const drift = raw.drift as Record<string, unknown> | undefined;
  return {
    ok: raw.ok !== false,
    outcome: typeof raw.outcome === "string" ? raw.outcome : "ok",
    planDigest,
    reconciliation: String(raw.reconciliation ?? ""),
    amendable: raw.amendable === true,
    ...(typeof refusalDetail === "string" ? { amendmentRefusal: refusalDetail } : {}),
    defaultContinuation: String(raw.defaultContinuation ?? "none"),
    execution: slots("execution"),
    requirement: slots("requirement"),
    revisions: (Array.isArray(raw.revisions) ? (raw.revisions as Record<string, unknown>[]) : []).map(
      (row) => ({
        revisionOrdinal: typeof row.revisionOrdinal === "number" ? row.revisionOrdinal : 0,
        revisionId: String(row.revisionId ?? ""),
        source: String(row.source ?? ""),
        reason: String(row.reason ?? ""),
        operations: Array.isArray(row.operations)
          ? (row.operations as unknown[]).map((kind) => String(kind))
          : [],
        continuation: String(row.continuation ?? ""),
        createdAt: String(row.createdAt ?? ""),
      }),
    ),
    notes: Array.isArray(raw.notes) ? (raw.notes as unknown[]).map((note) => String(note)) : [],
    ...(drift !== undefined
      ? {
          drift:
            `the session defaults moved since the recorded checkpoint ` +
            `(${String(drift.previousPlanDigest)} -> ${String(drift.planDigest)})`,
        }
      : {}),
  };
}

/**
 * The plan screen: what an operator needs before they change anything —
 * every slot's identity, ORIGIN, state and (for a requirement) its current
 * EVIDENCE validity, the revisions that produced them, the digest the apply
 * will be guarded on, and the continuation an applied revision would take.
 */
export function formatVerificationPlanDetail(view: VerificationPlanView): string[] {
  if (view.error !== undefined) {
    return [`  REFUSED (${view.outcome}): ${oneLine(view.error)}`];
  }
  const lines: string[] = [];
  lines.push(
    `  plan digest: ${view.planDigest} (${view.reconciliation})`,
    `  amendable:   ${view.amendable ? "yes" : `NO — ${oneLine(view.amendmentRefusal ?? "")}`}`,
    // The row's DEFAULT: a correction may route itself elsewhere, but only
    // where this value says the §9.2 table permits a re-queue at all.
    `  default continuation an applied revision would take: ${view.defaultContinuation}`,
  );
  const slotLine = (slot: VerificationPlanSlotView): string =>
    `    - ${slot.commandId} [${slot.state}] ${truncate(oneLine(slot.command), 70)} ` +
    `(${slot.origin}${slot.amended ? ", amended" : ""}` +
    `${slot.revisionOrdinals.length > 0 ? ` rev ${slot.revisionOrdinals.join(",")}` : ""})` +
    (slot.status !== undefined ? ` — ${slot.status}` : "");
  lines.push(`  execution (${view.execution.length}):`);
  for (const slot of view.execution) lines.push(slotLine(slot));
  lines.push(`  requirement (${view.requirement.length}):`);
  for (const slot of view.requirement) lines.push(slotLine(slot));
  if (view.revisions.length > 0) {
    lines.push(`  revisions (${view.revisions.length}):`);
    for (const revision of view.revisions.slice(-5)) {
      lines.push(
        `    - ${revision.revisionOrdinal} ${revision.source} ${revision.operations.join(", ")} ` +
          `→ ${revision.continuation}: ${truncate(oneLine(revision.reason), 60)}`,
      );
    }
  }
  for (const note of view.notes) lines.push(`  note: ${oneLine(note)}`);
  if (view.drift !== undefined) {
    lines.push(
      `  DRIFT: ${view.drift}. The plan above is what resolves; the next applying`,
      "         command re-anchors the checkpoint.",
    );
  }
  return lines;
}

/** The reason of the newest revision, prefilled into the next one's prompt. */
export function previousAmendmentReason(view: VerificationPlanView): string | undefined {
  const latest = view.revisions[view.revisions.length - 1];
  return latest === undefined || latest.reason.trim().length === 0 ? undefined : latest.reason;
}

/**
 * Whether the task carries a recorded amendment chain (§5.5). Used only to
 * label the menu entry — the view itself is offered for any task, because the
 * plan exists whether or not anybody has amended it.
 */
export function hasVerificationAmendments(task: AiTask): boolean {
  const block = task.context?.[VERIFICATION_AMENDMENTS_CONTEXT_KEY];
  return typeof block === "object" && block !== null;
}

/**
 * §7.1: the statuses on which an amendment is admitted at all. A `claimed` or
 * `running` task (an owner holds a resolved plan) and a terminal task are
 * refused by the command itself; the menu still offers the READ-ONLY view for
 * them, and the view reports the refusal rather than pretending it is amendable.
 */
export function isVerificationAmendable(task: AiTask): boolean {
  return task.status === "queued" || task.status === "blocked" || task.status === "ready_for_human";
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
    // §7.1's in-flight evidence round (#956), on the same terms the CLI prints
    // it: only where one exists, and counts and party states only.
    const evidence = summary.evidenceCollection.find((e) => e.lineageId === l.lineageId);
    if (evidence) {
      lines.push(
        `      evidence round ${evidence.round}: ` +
          evidence.parties.map(formatEvidenceParty).join(" ") +
          `  recorded=${evidence.attachmentsRecorded}` +
          (evidence.complete ? " complete" : "") +
          (evidence.recorded ? " rowApplied" : ""),
      );
    }
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
 * Whether a task carries §15 refinement state worth a UI block (issue #977).
 * Every task outside the lane — and every task in a session with
 * `issueRefinement.enabled: false` — answers false and the UI is unchanged.
 */
export function hasRefinementState(task: AiTask): boolean {
  const block = task.context?.[REFINEMENT_CONTEXT_KEY];
  return typeof block === "object" && block !== null && !Array.isArray(block);
}

/** The non-interactive `admin task-status` form for a task. */
export function buildTaskStatusArgv(task: AiTask, dbPath?: string): string[] {
  const argv = [
    "task-status",
    "--session-id",
    task.sessionId,
    "--issue-number",
    String(task.issueNumber),
  ];
  if (dbPath) argv.push("--db-path", dbPath);
  return argv;
}

/**
 * The refinement-progress block of the task detail view (issue #977).
 *
 * Rendered from {@link summarizeRefinementStatus} + the shared progress
 * renderer — the same normalized model `admin task-status` prints — so the UI
 * cannot show a different disposition, round, retry deadline, or
 * human-action flag than the non-interactive command does. It reads the task
 * context and the persisted `refinement.progress.milestone` events only: no
 * GitHub comment, no outbox row, no run artifact.
 */
export function formatRefinementDetail(
  task: AiTask,
  now: string,
  events?: readonly TaskEvent[],
): string[] {
  const summary = summarizeRefinementStatus(task, events, now);
  if (summary === null) return [];
  const lines = [
    "",
    `Refinement: state=${summary.state}${summary.terminal ? " (terminal)" : ""}`
      + (summary.handoffReason ? `  handoff=${summary.handoffReason}` : ""),
    `  roles: refiner=${summary.refinerAgent ?? "-"} critic=${summary.criticAgent ?? "-"}`,
  ];
  if (summary.evidence) {
    // §5.2 (issue #1003): a handoff raised before either agent ran says nothing
    // in the progress view about WHICH declared selection stopped it. Same
    // literals the `admin task-status` renderer prints — indexes and reasons,
    // never a declared path.
    const e = summary.evidence;
    lines.push(
      `  evidence: declared=${e.declared ?? "-"} captured=${e.captured ?? "-"}`
      + ` optionalGaps=${e.optionalGaps ?? "-"} artifact=${e.artifact ?? "-"}`,
    );
    for (const gap of e.gaps) {
      lines.push(
        `    gap[${gap.index ?? "-"}]: ${gap.reason ?? "-"} (${gap.requirement ?? "-"})`
        + (gap.predecessorIssueNumber === null ? "" : ` predecessor=#${gap.predecessorIssueNumber}`),
      );
    }
  }
  if (summary.criticBlock) {
    // §15 (issue #1176): which human blocker a `critique_blocked` handoff names.
    lines.push(renderRefinementCriticBlockLine(summary.criticBlock, "  "));
  }
  if (summary.progress) {
    lines.push(...renderRefinementProgressLines(summary.progress, "  "));
  } else {
    // The caller read no events, so there is no milestone record to project.
    // Saying so beats printing a progress view derived from nothing.
    lines.push("  progress: (task events not read)");
  }
  return lines;
}

/**
 * Multi-line detail view for a selected task.
 *
 * `events` is optional and feeds the issue #848 dispute block and the issue
 * #977 refinement-progress block: without it the lineage state, counters, and
 * refinement block still render in full (they live in the task context), and
 * only the event-only facts — the §7.1 routing intent and the §15 progress
 * milestones — are reported as unavailable rather than guessed.
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
  lines.push(...formatRefinementDetail(task, now, events));
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
    "  admin task-verification show --session-id <id> --issue-number <n>",
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
 * How much a `--json` payload can grow per stored character once JSON escaping
 * is applied. Command bytes are stored verbatim (§2) and nothing refuses a
 * control character in them, so the widest escape a payload can carry is the
 * six-byte `\uXXXX` form, not the two-byte `\"`.
 */
const JSON_ESCAPE_EXPANSION = 6;

/**
 * The largest number of slots one plan can carry: the two bounded input layers
 * (§5.5 session baseline, §6.1 Issue requirements) plus every slot an
 * append-only revision chain could add on top of them.
 */
const MAX_VERIFICATION_PLAN_SLOTS =
  MAX_VERIFICATION_SESSION_BASELINE_ENTRIES +
  MAX_VERIFICATION_PLAN_REQUIREMENTS +
  MAX_VERIFICATION_AMENDMENT_REVISIONS * MAX_VERIFICATION_AMENDMENT_OPERATIONS;

/** One `execution`/`requirement` row of the show payload, at its bound. */
const MAX_VERIFICATION_PLAN_SLOT_BYTES =
  MAX_VERIFICATION_AMENDMENT_COMMAND_CHARS * JSON_ESCAPE_EXPANSION +
  MAX_VERIFICATION_AMENDMENT_NAME_CHARS +
  // `revisionOrdinals` can name every revision that touched the slot.
  MAX_VERIFICATION_AMENDMENT_REVISIONS * 8 +
  // commandId, state, origin, amended, status, satisfiedBy and their keys.
  1024;

/** One `revisions` row of the show payload, at its bound. */
const MAX_VERIFICATION_REVISION_BYTES =
  MAX_VERIFICATION_AMENDMENT_REASON_CHARS * JSON_ESCAPE_EXPANSION +
  // One operation kind per operation, plus its quoting and separator.
  MAX_VERIFICATION_AMENDMENT_OPERATIONS * 64 +
  MAX_VERIFICATION_AMENDMENT_ACTOR_ID_CHARS +
  // revisionId, source, two digests, continuation, createdAt and their keys.
  1024;

/**
 * Buffer bound for a spawned `admin` subcommand, derived from the verification
 * contract's own limits rather than left at Node's 1 MiB default (issue #1044
 * review, P2).
 *
 * `task-verification show --json` prints every slot and every revision, and a
 * plan that stays entirely within the documented bounds — 200 revisions, 50
 * operations each, 4,000-character commands — prints far more than 1 MiB. At
 * the default the spawn dies with `ENOBUFS` and hands back truncated JSON, so
 * the one task that most needs inspecting becomes the one the UI cannot show.
 * `maxBuffer` is a ceiling, not an allocation: ordinary output still costs what
 * it costs.
 */
export const ADMIN_COMMAND_MAX_BUFFER_BYTES =
  MAX_VERIFICATION_PLAN_SLOTS * MAX_VERIFICATION_PLAN_SLOT_BYTES +
  MAX_VERIFICATION_AMENDMENT_REVISIONS * MAX_VERIFICATION_REVISION_BYTES +
  // Envelope, notes, drift, checkpoint and refusal detail.
  256 * 1024;

/**
 * Run an `admin` subcommand in a child process and capture its output. State
 * changes happen exclusively through this path, so every safeguard the
 * subcommand enforces stays intact.
 */
function runAdminCommand(argv: string[]): AdminRunResult {
  try {
    const stdout = execFileSync(process.execPath, [adminEntrypoint(), ...argv], {
      encoding: "utf8",
      maxBuffer: ADMIN_COMMAND_MAX_BUFFER_BYTES,
    }) as string;
    return { code: 0, stdout };
  } catch (err: unknown) {
    const e = err as { status?: number; code?: string; stdout?: string; stderr?: string };
    // Output that overran even the derived ceiling is truncated mid-stream, so
    // the bytes below are not a payload and not a refusal — say so rather than
    // letting a parse failure read as "the command said something unparseable".
    if (e.code === "ENOBUFS") {
      return {
        code: e.status ?? 1,
        stdout:
          `The command printed more than the ${ADMIN_COMMAND_MAX_BUFFER_BYTES}-byte capture limit, ` +
          `so its output was truncated and cannot be read here. Run it directly to see it in full.\n`,
      };
    }
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
  writeOut(s);
}

function clear(): void {
  write("\x1b[2J\x1b[H");
}

/** Resolve a Clack prompt result, converting the cancel symbol into a throw. */
function unwrap<T>(value: T): Exclude<T, symbol> {
  if (isCancel(value)) throw new UiCancelled();
  return value as Exclude<T, symbol>;
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
        // Not an active status, but the list can carry a `cancelled` row while
        // it is still merged-PR reconcilable (issue #1048), so the status filter
        // has to be able to name it — otherwise those rows are unreachable
        // through every filter the menu offers.
        { value: "cancelled" as TaskStatus, label: "cancelled" },
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
  | "refinement-recover"
  | "dispute"
  | "refinement"
  | "verification"
  | "reconcile-merged"
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
 * Surface the merged-PR reconciliation commands for a task whose recorded PR may
 * have been merged outside the loop (issue #1048,
 * docs/merged-pr-reconciliation-contract.md).
 *
 * Read-only, and deliberately not auto-run. The preview is the step that reads
 * the live PR state, and the answer is frequently "not merged" — a menu that
 * jumped straight to `--yes` would ask the operator to confirm a mutation whose
 * eligibility nobody has seen. The view also states what the command will NOT
 * do, because the reason an operator arrives here is usually disk pressure, and
 * the disk part of the job belongs to `worktree cleanup`.
 */
async function showReconcileMergedCommands(
  task: AiTask,
  dbPath?: string,
  sessionsPath?: string,
): Promise<void> {
  clear();
  write(`Reconcile an externally merged PR — ${task.sessionId} #${task.issueNumber}\n\n`);
  const { prUrl } = resolvePrContext(task);
  write(`Recorded pull request: ${prUrl ?? "(none)"}\n\n`);
  write(
    "If this PR was merged by hand, the task never learned about it and still\n" +
      "carries a live status. The command below reads the live state of exactly\n" +
      "this PR (never a branch guess) and, only if it is MERGED, completes the\n" +
      "task: queued/blocked/ready_for_human become done, while failed/cancelled\n" +
      "keep their status and record the merge.\n\n",
  );
  write("Preview (every read, no write — reports the live PR state and the outcome):\n");
  write(`  ${formatAdminCommand(buildTaskReconcileMergedArgv(task, dbPath, sessionsPath))}\n\n`);
  write("Apply it, once the preview shows the PR is MERGED and the task is eligible:\n");
  write(
    `  ${formatAdminCommand(buildTaskReconcileMergedArgv(task, dbPath, sessionsPath, { yes: true }))}\n\n`,
  );
  write(
    "This writes lifecycle metadata only: the task row, one task event, and one\n" +
      "comment on the work item. It never deletes a worktree or a branch and never\n" +
      "touches a label. To reclaim disk space, run `admin worktree cleanup` first;\n" +
      "reconcile here only if more space is still needed, then run cleanup again.\n",
  );
  await pause();
}

/**
 * Surface the §13 recovery commands for a stopped Issue refinement (issue #980).
 *
 * Read-only, and deliberately not auto-run: §13 lets recovery apply only against
 * the row-1 admissible label shape, and after some handoff reasons
 * (`marker_precondition_failed` in particular) the operator has a label to
 * restore FIRST. The preview is the step that reports which — running `--yes`
 * for them would just produce a refusal they did not ask for.
 */
async function showRefinementRecoverCommands(
  task: AiTask,
  dbPath?: string,
  sessionsPath?: string,
): Promise<void> {
  clear();
  write(`Recover stopped Issue refinement — ${task.sessionId} #${task.issueNumber}\n\n`);
  const summary = summarizeRefinementStatus(task);
  write(
    "This task stopped at a refinement handoff"
      + (summary?.handoffReason ? ` (${summary.handoffReason})` : "")
      + ". §13 of the refinement contract\n"
      + "gives exactly one way back: the command below resets the attempt to `pending` and\n"
      + "re-queues the row at phase refinement. Generic recover would requeue it with the\n"
      + "failed attempt's draft and counters still on the block, which the contract forbids.\n\n",
  );
  write("Preview the reset (reports the task, the handoff reason, and the live labels):\n");
  write(`  ${formatAdminCommand(buildRefinementRecoverArgv(task, dbPath, sessionsPath))}\n\n`);
  write("Apply it, once the Issue carries status:needs-refinement and no executable status:*:\n");
  write(`  ${formatAdminCommand(buildRefinementRecoverArgv(task, dbPath, sessionsPath, { yes: true }))}\n\n`);
  write("To hand the Issue to implementation by hand instead, remove the refinement marker\n");
  write("first, then add status:needs-implementation, and dispose of this row:\n");
  const cancelArgv = [
    "task",
    "cancel",
    "--session-id",
    task.sessionId,
    "--issue-number",
    String(task.issueNumber),
    "--yes",
  ];
  if (dbPath) cancelArgv.push("--db-path", dbPath);
  if (sessionsPath) cancelArgv.push("--sessions-path", sessionsPath);
  write(`  ${formatAdminCommand(cancelArgv)}\n`);
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
 * Surface the §15 refinement progress of a task (issue #977).
 *
 * Strictly read-only, and deliberately offers no command that acts on the lane:
 * refinement advances on its own scheduler turn, and the operator questions this
 * view answers — is it moving, when does it wake up, does it need me — are all
 * answered by the normalized model itself. It prints the same projection
 * `admin task-status` prints, plus the exact non-interactive form of it.
 *
 * Nothing here reads a GitHub comment. The append-only progress notes on the
 * Issue are a one-way human-facing projection of these milestones (§16); the
 * task row and the persisted milestone events are the state.
 */
async function showRefinementProgress(
  task: AiTask,
  now: string,
  events: readonly TaskEvent[],
  dbPath?: string,
): Promise<void> {
  clear();
  write(`Issue refinement — ${task.sessionId} #${task.issueNumber}\n\n`);
  const detail = formatRefinementDetail(task, now, events);
  if (detail.length === 0) {
    write("This task carries no refinement state.\n");
    await pause();
    return;
  }
  write(detail.join("\n").trimStart() + "\n\n");
  write("Full state (same projection, non-interactive):\n");
  write(`  ${formatAdminCommand(buildTaskStatusArgv(task, dbPath))}\n`);
  write(`  ${formatAdminCommand([...buildTaskStatusArgv(task, dbPath), "--json"])}\n\n`);
  write(
    "SQLite task state and the persisted refinement.progress.milestone events are\n"
      + "authoritative; the progress comments on the Issue are a one-way projection of them.\n",
  );
  await pause();
}

// ---------------------------------------------------------------------------
// The verification plan view (issue #1044, §11 / §12)
// ---------------------------------------------------------------------------

/** Prompt for a non-empty line, refusing empty/whitespace-only input. */
async function requireText(message: string, initialValue?: string): Promise<string> {
  return unwrap(
    await clackText({
      message,
      ...(initialValue !== undefined ? { initialValue } : {}),
      validate: (value) =>
        value === undefined || value.trim().length === 0 ? "Required — cannot be empty." : undefined,
    }),
  ).trim();
}

/** Choose one slot of the plan, showing its state and origin in the label. */
async function selectSlot(
  message: string,
  slots: readonly VerificationPlanSlotView[],
): Promise<VerificationPlanSlotView | null> {
  if (slots.length === 0) return null;
  const value = unwrap(
    await clackSelect<string>({
      message,
      options: slots.map((slot) => ({
        value: slot.commandId,
        label: `${slot.commandId} [${slot.state}] ${truncate(oneLine(slot.command), 50)} (${slot.origin})`,
      })),
      maxItems: DEFAULT_PAGE_SIZE,
    }),
  );
  return slots.find((slot) => slot.commandId === value) ?? null;
}

/**
 * Run a `task-verification` mutation the way the contract expects an operator to
 * run it: preview first (no `--yes`, nothing written), show exactly what the
 * apply would do, and apply only on an explicit confirmation — with the plan
 * digest the operator just read carried into the apply, so a plan that moved
 * between the two refuses rather than amending something nobody saw (§7.3 rule
 * 3, §11 rule 1).
 */
async function previewThenApply(
  task: AiTask,
  previewArgv: string[],
  // A function when the apply has to carry something the operator was SHOWN —
  // the refresh's live Issue digest, which only the preview knows. Returning a
  // string refuses the apply with that explanation rather than falling back to
  // an unguarded invocation.
  applyArgvFor: string[] | ((previewStdout: string) => string[] | string),
): Promise<void> {
  clear();
  write(`Verification plan — ${task.sessionId} #${task.issueNumber}\n\n`);
  write("Preview (writes nothing):\n\n");
  write(`  ${formatAdminCommand(previewArgv)}\n\n`);
  const preview = runAdminCommand(previewArgv);
  write(preview.stdout.trim() + "\n\n");
  if (preview.code !== 0) {
    write(`The preview exited ${preview.code}; nothing was applied.\n`);
    await pause();
    return;
  }
  const resolved = typeof applyArgvFor === "function" ? applyArgvFor(preview.stdout) : applyArgvFor;
  if (typeof resolved === "string") {
    write(`${resolved}\n`);
    await pause();
    return;
  }
  const applyArgv = resolved;
  write("Applying would run:\n\n");
  write(`  ${formatAdminCommand(applyArgv)}\n`);
  const ok = await confirm("\nApply this revision?");
  if (!ok) {
    write("\nCancelled. No changes made.\n");
    await pause();
    return;
  }
  const applied = runAdminCommand(applyArgv);
  clear();
  write("Ran command:\n\n");
  write(`  ${formatAdminCommand(applyArgv)}\n\n`);
  write(`Exit code: ${applied.code}\n\n`);
  write("Result:\n");
  write(applied.stdout.trim() + "\n\n");
  // What the exit code alone cannot say (issue #1044 review, P2): a `no_change`
  // and a recognized replay both exit 0 having written nothing, so announcing an
  // event and a comment on every success would promise an audit trail that this
  // invocation did not produce. The ordinal is printed only by an outcome that
  // consumed one.
  if (applied.code === 0) {
    const ordinal = parseAppliedRevisionOrdinal(applied.stdout);
    write(
      ordinal !== null
        ? "That revision posts one bounded comment on the work item through the outbox\n" +
            "(keyed on the revision, so a retry never double-posts) and records one\n" +
            "verification.amendment.applied task event.\n"
        : "No revision was recorded by this run — read the result above for whether it\n" +
            "found nothing to apply or replayed a revision it had already recorded. Either\n" +
            "way this invocation wrote no task event and queued no comment.\n",
    );
  }
  await pause();
}

type VerificationMenuAction =
  | "add-requirement"
  | "add-execution"
  | "replace"
  | "retire"
  | "restore"
  | "annotate"
  | "refresh"
  | "reset"
  | "copy"
  | "back";

/**
 * The `--continue` values this task's row may be routed to (§9.2 rule 3), as
 * the menu offers them.
 *
 * The override chooses WHICH re-queueable lane an amendment returns the task
 * to; it is never a way to acquire a re-queue the table withholds. So a row
 * whose default is `none` — a `queued` task, or one parked outside the review
 * lane — offers nothing: an explicit `review` or `implementation` there refuses
 * and mutates nothing, and an explicit `none` is what the row already does. The
 * empty list is the signal to skip the prompt rather than to put three choices
 * in front of an operator of which two only produce a refusal.
 */
export function verificationContinuationChoices(
  view: Pick<VerificationPlanView, "defaultContinuation">,
): { value: "review" | "implementation" | "none"; label: string }[] {
  const fallback = view.defaultContinuation;
  if (fallback !== "review" && fallback !== "implementation") return [];
  const suffix = (mode: string): string => (mode === fallback ? " — the default for this task's row" : "");
  return [
    {
      value: "review",
      label: `review — re-queue {queued, review} so the amended plan is verified now${suffix("review")}`,
    },
    {
      value: "implementation",
      label:
        "implementation — re-queue {queued, implementation}: the code, not the requirement, is what is wrong"
        + suffix("implementation"),
    },
    {
      value: "none",
      label: "none — record the revision and route nothing; the task stays where it is",
    },
  ];
}

/**
 * Surface one task's effective verification plan and the operator corrections
 * available on it (issue #1044, docs/verification-amendment-contract.md §11).
 *
 * Everything here goes through `admin task-verification`: the view is that
 * command's own `--json` payload, and every mutation is the same command an
 * operator could type, previewed before it applies. The UI resolves no plan,
 * derives no operation, and writes no state — so the §7 refusals, the §5.3
 * replay recognition, the §9.2 continuation, the §12.1 event, and the §12.2
 * public comment are produced exactly once, by the core, whichever surface the
 * operator came from.
 */
async function showVerificationPlan(
  task: AiTask,
  dbPath?: string,
  sessionsPath?: string,
): Promise<void> {
  for (;;) {
    const showArgv = buildTaskVerificationShowArgv(task, dbPath, sessionsPath, { json: true });
    const shown = runAdminCommand(showArgv);
    const view = parseVerificationPlanView(shown.stdout);
    clear();
    write(`Verification plan — ${task.sessionId} #${task.issueNumber}\n\n`);
    if (view === null) {
      write("Could not read the effective verification plan:\n\n");
      write(shown.stdout.trim() + "\n\n");
      write("Read it non-interactively with:\n");
      write(`  ${formatAdminCommand(buildTaskVerificationShowArgv(task, dbPath, sessionsPath))}\n`);
      await pause();
      return;
    }
    write(formatVerificationPlanDetail(view).join("\n") + "\n\n");
    if (view.error !== undefined) {
      write(
        "A stored plan that reconciles against neither the live session defaults nor the\n" +
          "recorded baseline is refused rather than repaired (§11 rule 6). Inspect the\n" +
          "amendment record before acting.\n",
      );
      await pause();
      return;
    }

    const actions: { action: VerificationMenuAction; label: string }[] = [];
    if (view.amendable) {
      actions.push(
        { action: "add-requirement", label: "Add a required verification command" },
        { action: "add-execution", label: "Add a task-local execution command" },
        { action: "replace", label: "Replace a command's bytes (fix a typo — keeps its identity)" },
        { action: "retire", label: "Retire a command (removes a check — reported, never a pass)" },
        { action: "restore", label: "Restore a retired command" },
        {
          action: "annotate",
          label: "Annotate a command (records a reason against it — changes no bytes, no state)",
        },
        { action: "refresh", label: "Refresh the requirements from the live Issue" },
        { action: "reset", label: "Reset the plan to its unamended baseline" },
      );
    }
    actions.push(
      { action: "copy", label: "Show exact non-interactive task-verification commands" },
      { action: "back", label: "Back to the task menu" },
    );
    const idx = await selectMenu({
      header: view.amendable
        ? "Choose a correction (every one previews before it applies):"
        : "This task is not amendable right now; the plan above is read-only.",
      items: actions,
      render: (a) => a.label,
    });
    const choice = actions[idx].action;
    if (choice === "back") return;

    if (choice === "copy") {
      clear();
      write(`Non-interactive verification commands — ${task.sessionId} #${task.issueNumber}\n\n`);
      write("Read the effective plan:\n");
      write(`  ${formatAdminCommand(buildTaskVerificationShowArgv(task, dbPath, sessionsPath))}\n\n`);
      write("Correct a command (preview; add --yes to apply):\n");
      write(
        `  ${formatAdminCommand(
          buildTaskVerificationAmendArgv(
            task,
            {
              operations: [
                { flag: "--replace", value: "<commandId>", command: "<corrected command>" },
              ],
              reason: "<why>",
            },
            dbPath,
            sessionsPath,
          ),
        )}\n\n`,
      );
      write("Re-import the Issue's verification section:\n");
      write(
        `  ${formatAdminCommand(
          buildTaskVerificationRefreshArgv(task, { reason: "<why>" }, dbPath, sessionsPath),
        )}\n\n`,
      );
      write("Return the plan to its unamended baseline:\n");
      write(
        `  ${formatAdminCommand(
          buildTaskVerificationResetArgv(task, { reason: "<why>" }, dbPath, sessionsPath),
        )}\n`,
      );
      await pause();
      continue;
    }

    // The reason is mandatory on every applying invocation (§11 rule 3), and the
    // previous revision's reason is offered as the starting point: a correction
    // usually continues the story the last one started, and retyping it from
    // scratch is how an audit trail fills up with "fix".
    const previousReason = previousAmendmentReason(view);

    if (choice === "refresh") {
      const reason = await requireText("Why re-read the Issue's verification section?", previousReason);
      const allowRetire = await confirm(
        "Also apply retirements for requirements the live Issue no longer names?\n" +
          "(Without this they are previewed and withheld — a removal is never implicit.)",
      );
      // A refresh derives its operations from TWO inputs, so the apply carries
      // both guards. The Issue digest binds it to the text just read: without it
      // the apply re-reads the Issue and applies whatever it says now, which —
      // with `--allow-retire` — can retire a requirement the operator never saw
      // proposed. The base plan digest binds it to the plan that text was
      // diffed against (issue #1044 review): a concurrent `amend` moves the
      // difference while leaving the Issue body, and its digest, untouched.
      // Both are read back out of the preview the operator just confirmed, so
      // either one moving refuses (§10) instead of applying a different diff.
      const requestKey = newVerificationRequestKey();
      await previewThenApply(
        task,
        buildTaskVerificationRefreshArgv(
          task,
          { reason, allowRetire, requestKey },
          dbPath,
          sessionsPath,
        ),
        (previewStdout) => {
          const expectIssueDigest = parseRefreshIssueBodyDigest(previewStdout);
          if (expectIssueDigest === null) {
            return (
              "The preview did not report a live Issue body digest, so the apply cannot be bound\n"
              + "to the Issue you just read. Nothing was applied. Re-run the preview, or apply it\n"
              + "non-interactively with an explicit --expect-issue-digest."
            );
          }
          // Both digests come from THIS preview — the `base -> new` pair a
          // proposed revision prints, or the `(unchanged)` digest a `no_change`
          // prints (issue #1044 review, P1). The digest the plan screen showed
          // is never substituted: it describes the plan as of that screen, and a
          // plan another revision moved in between is exactly what this guard
          // exists to catch. A preview that reports neither is not a plan this
          // apply may be bound to, so it is refused rather than guessed at.
          const expectPlanDigest =
            parsePreviewBasePlanDigest(previewStdout)
            ?? parsePreviewUnchangedPlanDigest(previewStdout);
          if (expectPlanDigest === null) {
            return (
              "The preview did not report the plan digest it resolved, so the apply cannot be\n"
              + "bound to the plan the difference above was computed against. Nothing was applied.\n"
              + "Re-run the preview, or apply it non-interactively with an explicit\n"
              + "--expect-plan-digest."
            );
          }
          return buildTaskVerificationRefreshArgv(
            task,
            { reason, allowRetire, expectIssueDigest, expectPlanDigest, requestKey, yes: true },
            dbPath,
            sessionsPath,
          );
        },
      );
      continue;
    }

    if (choice === "reset") {
      const reason = await requireText("Why revert the amendments?", previousReason);
      const allowRetire = await confirm(
        "Also retire the task-local commands the amendments added?\n" +
          "(Without this they are previewed and withheld.)",
      );
      // The apply carries an explicit request key, named on the preview too
      // (§11 rule 3, issue #1044 review). A reset's operations are derived from
      // the plan, so a key derived from THEM is a key this reset's own success
      // erases: it identifies "undo the amendments this plan carries", which is
      // no longer true of any later invocation, and two resets separated by a
      // round of amendments would collide on it or miss each other by accident.
      // A key minted for this flow identifies the request instead of its
      // content, so the exact apply line the UI prints is replayable — re-running
      // it names the revision it already recorded rather than recording a second
      // one — while a later reset stays a separate request.
      //
      // The preview's own key still wins when it names one, so the apply carries
      // exactly what the operator was shown; they agree by construction here.
      const resetRequestKey = newVerificationRequestKey();
      await previewThenApply(
        task,
        buildTaskVerificationResetArgv(
          task,
          { reason, allowRetire, expectPlanDigest: view.planDigest, requestKey: resetRequestKey },
          dbPath,
          sessionsPath,
        ),
        (previewStdout) => {
          const requestKey = parsePreviewRequestKey(previewStdout) ?? resetRequestKey;
          return buildTaskVerificationResetArgv(
            task,
            {
              reason,
              allowRetire,
              expectPlanDigest: view.planDigest,
              requestKey,
              yes: true,
            },
            dbPath,
            sessionsPath,
          );
        },
      );
      continue;
    }

    let operation: VerificationAmendOperation | null = null;
    // Which layer the chosen slot belongs to, taken from the view's own split
    // rather than from the `exec:`/`req:` prefix, so the wording below follows
    // what the operator was shown (issue #1044 review, P1).
    const executionCommandIds = new Set(view.execution.map((slot) => slot.commandId));
    let selectedIsExecution = false;
    if (choice === "add-requirement") {
      operation = { flag: "--add-requirement", command: await requireText("Required command:") };
    } else if (choice === "add-execution") {
      const name = await requireText("Name for the execution command (e.g. lint):");
      operation = {
        flag: "--add-execution",
        value: name,
        command: await requireText(`Command bytes for \`${name}\`:`),
      };
    } else if (choice === "replace") {
      const slot = await selectSlot(
        "Which command's bytes are wrong?",
        [...view.execution, ...view.requirement],
      );
      if (slot === null) {
        clear();
        write("\nThis plan has no slot to replace.\n");
        await pause();
        continue;
      }
      // The bytes the plan screen showed came through the session's redaction,
      // so a command naming a configured local path reads `<path>` here (issue
      // #1044 review, P1). Prefilling that would store the placeholder as the
      // command the loop runs — a "correction" that breaks the check it was
      // meant to fix — so a redacted slot is retyped in full instead.
      const redacted = isRedactedCommandText(slot.command);
      if (redacted) {
        write(
          "\nThe stored bytes of this command contain a local path or a secret-shaped token,\n" +
            "which the plan view redacts before printing. The redacted text is not executable,\n" +
            "so it is not offered as a starting point: type the corrected command in full.\n\n",
        );
      }
      operation = {
        flag: "--replace",
        value: slot.commandId,
        command: await requireText(
          redacted
            ? "Corrected command (type it in full — the stored bytes are redacted above):"
            : "Corrected command:",
          redacted ? undefined : slot.command,
        ),
      };
    } else if (choice === "retire") {
      // The prompt names the RECORDED plan rather than promising that the
      // command stops being checked (issue #1044 review, P1). That promise holds
      // for a requirement slot and not for an execution one: review Step 4 still
      // executes this session's configured commands, so an execution retirement
      // changes the record and nothing about what runs. The layer-specific
      // statement is made in the confirmation below, once the slot is known.
      const slot = await selectSlot(
        "Which command should be retired from this task's recorded plan?",
        [...view.execution, ...view.requirement].filter((s) => s.state === "active"),
      );
      if (slot === null) {
        clear();
        write("\nThis plan has no active slot to retire.\n");
        await pause();
        continue;
      }
      selectedIsExecution = executionCommandIds.has(slot.commandId);
      operation = { flag: "--retire", value: slot.commandId };
    } else if (choice === "restore") {
      const slot = await selectSlot(
        "Which retired command should this task's recorded plan carry again?",
        [...view.execution, ...view.requirement].filter((s) => s.state === "retired"),
      );
      if (slot === null) {
        clear();
        write("\nThis plan carries no retired slot to restore.\n");
        await pause();
        continue;
      }
      selectedIsExecution = executionCommandIds.has(slot.commandId);
      // The symmetric half of the retirement wording (issue #1044 review, P1):
      // retiring an execution entry never stopped anything, so restoring one
      // starts nothing. An operator told they had "restored a check" would read
      // the next verification pass as evidence this restore produced.
      if (selectedIsExecution) {
        write(
          "\nThis is an execution-layer entry, so the restore changes the recorded plan only:\n" +
            "the review step runs this session's own verification configuration, which this\n" +
            "restore does not touch.\n\n",
        );
      }
      operation = { flag: "--restore", value: slot.commandId };
    } else if (choice === "annotate") {
      // An annotation is offered on every slot, retired ones included: "this
      // check stays retired because …" is exactly the note §5.2 gives the
      // operation for, and it changes neither bytes, state, nor position (§6.1
      // step 2), so no state filter and no layer wording applies.
      const slot = await selectSlot(
        "Which command should the note be recorded against?",
        [...view.execution, ...view.requirement],
      );
      if (slot === null) {
        clear();
        write("\nThis plan has no slot to annotate.\n");
        await pause();
        continue;
      }
      operation = { flag: "--annotate", value: slot.commandId };
    }
    if (operation === null) continue;

    if (choice === "retire") {
      // §8.4: a removal is the one correction a reader of the Issue must never
      // have to discover afterwards, so it is confirmed on its own terms before
      // the preview — and the published comment names it either way.
      //
      // The claim it makes follows the LAYER (issue #1044 review, P1). Retiring
      // a requirement really does remove a check the loop runs and gates on.
      // Retiring an execution entry does not: Step 4 executes this session's own
      // verification configuration and reads no amendment, so an operator told
      // they had removed "a check this task currently runs" would believe they
      // had stopped something. The prompt does not claim the reverse either —
      // that the entry keeps running — because a task-local entry this task
      // added under a name the session configuration does not hold was never
      // run by the loop at all.
      const sure = selectedIsExecution
        ? await confirm(
            "Retiring an execution-layer entry changes this task's RECORDED plan only.\n" +
              "The review step runs this session's own verification configuration, which this\n" +
              "retirement does not touch: a command that configuration names keeps running and\n" +
              "keeps being reported as run, and one it does not name was never run. The\n" +
              "retirement is published on the work item. Continue?",
          )
        : await confirm(
            "Retiring a command removes a check this task currently runs.\n" +
              "It is reported `retired` — never as a passing result — and is published on the\n" +
              "work item. Continue?",
          );
      if (!sure) continue;
    }

    // An annotation's reason IS the annotation — there is no other change to
    // explain — so the prompt asks for it in those terms rather than for the
    // "why" of a plan change that is not happening.
    const reason = await requireText(
      choice === "annotate"
        ? "The note to record against this command (recorded and published):"
        : "Reason for this revision (recorded and published):",
      previousReason,
    );
    // Which lane the applied revision returns the task to (§9.2 rule 3). The
    // choice is offered only on a row the table lets a revision re-queue: on
    // any other row the override reaches no further than the table does, so
    // `review` and `implementation` would refuse and `none` is already what
    // happens. Leaving it unanswered — or having no choice to make — sends no
    // `--continue`, so the row's own default applies exactly as before.
    const continuations = verificationContinuationChoices(view);
    let continueMode: "review" | "implementation" | "none" | undefined;
    if (continuations.length > 0) {
      const continuationIdx = await selectMenu({
        header:
          `This task's row re-queues on an applied revision (default: ${view.defaultContinuation}).\n`
          + "Where should this correction send it?",
        items: continuations,
        render: (c) => c.label,
      });
      continueMode = continuations[continuationIdx].value;
    }
    // One key for this flow, named on the preview and on the apply (issue #1044
    // review, P1). Without it the core derives the key from the invocation's own
    // content, and an operator who retires a slot, restores it, and retires it
    // again types identical content each time: the third invocation would derive
    // the first retirement's key and be answered as its replay — reporting a
    // superseded revision and leaving the slot active — while the preview, which
    // performs no replay lookup, showed the retirement going through.
    const options = {
      operations: [operation],
      reason,
      ...(continueMode !== undefined ? { continueMode } : {}),
      expectPlanDigest: view.planDigest,
      requestKey: newVerificationRequestKey(),
    } as const;
    await previewThenApply(
      task,
      buildTaskVerificationAmendArgv(task, options, dbPath, sessionsPath),
      buildTaskVerificationAmendArgv(task, { ...options, yes: true }, dbPath, sessionsPath),
    );
  }
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
  } else if (isRefinementRecoverable(task)) {
    actions.push({
      action: "refinement-recover",
      label: "Recover stopped Issue refinement (admin refinement recover)",
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
  // Issue #977, on the same terms: additive, read-only, and offered beside
  // whatever recovery action applies. It answers a different question ("where is
  // this Issue in refinement, and does it need me?") and mutates nothing, so it
  // cannot conflict with the recovery action next to it.
  if (hasRefinementState(task)) {
    actions.push({
      action: "refinement",
      label: "Issue refinement progress (admin task-status)",
    });
  }
  // Issue #1044, additive on the same terms: the verification plan is a
  // different question from recovery ("does this task check the right things,
  // and did anyone change that?"), and the entry leads with the plan — a
  // read-only view — before any correction. It is offered for a task an
  // amendment could apply to (§7.1) and for one that already carries a chain,
  // so an amended `claimed`/`running`/terminal task can still be INSPECTED,
  // with the view reporting why it is not amendable rather than hiding it.
  if (isVerificationAmendable(task) || hasVerificationAmendments(task)) {
    actions.push({
      action: "verification",
      label: hasVerificationAmendments(task)
        ? "Verification plan — AMENDED (admin task-verification)"
        : "Verification plan / corrections (admin task-verification)",
    });
  }
  // Issue #1048, additive for the same reason: a task whose recorded PR was
  // merged outside the loop needs the merged-PR reconciliation command, and
  // that question ("was this finished elsewhere?") is orthogonal to whichever
  // recovery action the row's status suggests. The entry is a read-only command
  // view — it runs nothing — so it cannot conflict with the action beside it.
  if (isMergedPrReconcilable(task)) {
    actions.push({
      action: "reconcile-merged",
      label: "Reconcile an externally merged PR (admin task reconcile-merged)",
    });
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
  // Issue #977 needs the same log for the §15 progress milestones. One read
  // serves both — a task carrying both blocks must not pay for the log twice —
  // and a task carrying neither costs no extra query and renders exactly as
  // before.
  const detailEvents = hasDisputeState(task) || hasRefinementState(task)
    ? await store.listEvents({ sessionId: task.sessionId, issueNumber: task.issueNumber })
    : undefined;

  clear();
  const header = formatTaskDetail(task, now, lockState, detailEvents) + "\n\n" + "Choose an action:";
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
    case "refinement-recover":
      await showRefinementRecoverCommands(task, dbPath, sessionsPath);
      return "back";
    case "dispute":
      await showDisputeCommands(task, detailEvents ?? [], dbPath, sessionsPath);
      return "back";
    case "refinement":
      await showRefinementProgress(task, now, detailEvents ?? [], dbPath);
      return "back";
    case "verification":
      await showVerificationPlan(task, dbPath, sessionsPath);
      return "back";
    case "reconcile-merged":
      await showReconcileMergedCommands(task, dbPath, sessionsPath);
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
    writeOut(nonTtyHelp());
    exitProcess(2);
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
      exitProcess(130);
    }
    throw err;
  }
  store.close();
  emit({ ok: true, exited: "ui" });
}
