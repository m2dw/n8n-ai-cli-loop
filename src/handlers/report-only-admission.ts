import type { AiTask, TaskPhase } from "../core/task.js";
import type { ResolvedSession } from "../core/session.js";

export type ReportOnlyAdmissionResult = { ok: true } | { ok: false; result: "blocked"; message: string };

/**
 * Phases that mutate the repository — branch creation, commits, or a PR push
 * — and are therefore refused for a report-only session (issue #532). Every
 * other phase (research, content_*, and review of an already-existing PR) is
 * read/analysis-only and stays admitted.
 */
export const REPORT_ONLY_BLOCKED_PHASES: ReadonlySet<TaskPhase> = new Set(["implementation", "conflict_resolution"]);

/**
 * The report shown to operators (via the blocked-phase escalation comment, or
 * an intake deferral entry) stating what would have happened under normal
 * automation (acceptance criteria, issue #532).
 */
export function describeReportOnlyDeferral(session: ResolvedSession, issueNumber: number, phase: TaskPhase): string {
  return (
    `Session ${session.sessionId} is in report-only mode (reportOnly.enabled=true): issue #${issueNumber} would ` +
    `have proceeded to the '${phase}' phase under normal automation — creating/updating a branch, running an ` +
    `implementation-capable agent with write authority, and opening or updating a pull request. No repository ` +
    `changes were made. Set reportOnly.enabled to false (or remove the block) to resume normal implementation ` +
    `for this session.`
  );
}

/**
 * Report-only-mode admission preflight (issue #532), wired as a phase-runner
 * `admitPhase` gate alongside `checkReviewAdmission`. Runs before the issue
 * lock is acquired or the worktree is resolved/created, so a rejection here
 * never touches the issue branch or invokes a write-authority agent — the
 * same side-effect-free contract `checkReviewAdmission` promises. This is a
 * defense-in-depth backstop: the primary enforcement point is intake (see
 * `REPORT_ONLY_BLOCKED_PHASES` usage in `src/cli/github-intake.ts`), which
 * never enqueues a blocked-phase task for a report-only session in the first
 * place. This gate also catches a task that reached `implementation` or
 * `conflict_resolution` some other way — e.g. it was enqueued before the
 * session opted into report-only mode, or a review `needs_fix`/`conflict`
 * outcome requeued it into a now-report-only session.
 */
export function checkReportOnlyAdmission(session: ResolvedSession, task: AiTask): ReportOnlyAdmissionResult {
  if (!session.reportOnly?.enabled || !REPORT_ONLY_BLOCKED_PHASES.has(task.phase)) {
    return { ok: true };
  }
  return { ok: false, result: "blocked", message: describeReportOnlyDeferral(session, task.issueNumber, task.phase) };
}
