/**
 * `tool-request.resolve` — the callable operator-resolution core (issue #1030).
 *
 * `docs/operation-dispatch-port-contract.md` §11.2 admits an operation into a
 * registry only once its decision-and-action body is a
 * `{ request, context } → OperationResult` function that parses no argv, writes
 * no output, never calls `die()`/`process.exit`, and takes every store,
 * provider and clock by injection. Until this module existed, the operator
 * resolution was only reachable as `runToolRequestResolve(argv)` inside
 * `src/cli/admin.ts`: it parsed its own flags, printed through the
 * process-global output mode, and reported failure by exiting the process.
 * That is the shape §11.1 describes as *not* callable, and it is the reason
 * `tool-request.resolve` — one of the two verbs
 * `docs/chatops-operation-mapping-contract.md` §7 maps — could not be
 * registered.
 *
 * This module is the extracted core, following the pattern
 * `src/core/tool-request-run.ts` established for `tool-request.run` (#1029). It
 * owns every business rule the CLI handler owned — the unresolved /
 * already-resolved / active-task guards, the one-shot post-rejection recovery
 * (#674), the requeue safety guards (dirty checkout, unpushed base, unpushed or
 * missing issue branch, no usable continuation point), the resolution record
 * that becomes the next implementation prompt's continuation context, the task
 * transition, and the label/comment publication — and returns a typed
 * {@link OperationResult} instead of printing and exiting. `src/cli/admin.ts`
 * keeps argv parsing, session resolution, store construction, JSON/human
 * rendering, and exit-code mapping.
 *
 * Registration is deliberately NOT done here.
 * `createToolRequestResolveDescriptor` exists so a composition root (and this
 * repository's tests) can reach the core through `invokeOperation`; an
 * operation module never reaches back into a registry to register itself
 * (§3.2). `src/core/chatops-operations.ts` is the ChatOps collection point, and
 * issue #1031 named this operation there.
 *
 * ## Result vocabulary
 *
 * The mapping is retry-safety, not severity (contract §7, §9.2):
 *
 *   - `rejected` — nothing durable changed. Either a precondition refused the
 *     resolution before the transition, or the transition itself did not
 *     commit; the same invocation may be retried once the named precondition is
 *     fixed.
 *   - `executed` — the operator's decision was persisted (or, for an
 *     unconfirmed invocation, previewed with `effect: "none"`). `data` carries
 *     the structured payload the admin CLI prints verbatim.
 *   - `failed` / `effect: "unknown"` — the decision was persisted and a later
 *     step (label/comment publication, the audit event) could not be completed.
 *     The task has already moved, so a retry would be refused by the
 *     already-resolved guard and an operator must look at what was published.
 *
 * A replay cannot apply the same decision twice: the persisted request carries
 * `resolved: true`, which refuses every later invocation except the single,
 * one-shot post-rejection recovery (#674) — and that one stamps
 * `rejectRecoveryConsumed` so it cannot fire again either. The transition is a
 * compare-and-swap on the task's observed status, so a concurrent writer loses
 * the race rather than double-applying it.
 *
 * Summaries are returned at full length rather than pre-truncated: the admin
 * CLI uses one as its `die()` message and must keep the exact operator guidance
 * the handler has always printed, and `invokeOperation` bounds every summary to
 * `OPERATION_SUMMARY_MAX_CHARS` at the port boundary for the surfaces that need
 * it (contract §12).
 */

import type { TaskPhase } from "./task.js";
import type { TaskStore } from "./task-store.js";
import type { OutboxStore } from "./outbox.js";
import { makeOutboxKey } from "./outbox.js";
import type { ResolvedSession } from "./session.js";
import type {
  OperationContext,
  OperationDescriptor,
  OperationParams,
  OperationParamSpec,
  OperationRejectionReason,
  OperationResult,
} from "./operation-port.js";
import { agentForPhase } from "./assignment.js";
import { sessionRedactionPaths, workItemOutbox } from "./outbox-effects.js";
import { boundedExcerpt, sanitizeBody } from "./text-sanitize.js";
import { redactCommand } from "./tool-request.js";
// The two task-derived readers the whole Tool Request operator surface shares.
// They live in the guided-run core because #1029 extracted them there first;
// both are pure functions of a task, and duplicating either here would be a
// second definition of what "the stored request" and "the work branch" mean.
import { readStoredToolRequest, resolveToolRequestWorkBranch } from "./tool-request-run.js";
import type { ToolRequestRunProbeResult } from "./tool-request-run.js";

// ---------------------------------------------------------------------------
// Identity and typed request (contract §4)
// ---------------------------------------------------------------------------

/** The canonical operation id `docs/chatops-operation-mapping-contract.md` §7 binds `/resolve` to. */
export const TOOL_REQUEST_RESOLVE_OPERATION_ID = "tool-request.resolve";

/** The two decisions an operator may record. The requested command is never run. */
export const TOOL_REQUEST_RESOLVE_ACTIONS = ["manual-done", "reject"] as const;
export type ToolRequestResolveAction = (typeof TOOL_REQUEST_RESOLVE_ACTIONS)[number];

/**
 * Bounded storage for an operator-supplied resolution note. Operator-typed text
 * is trusted, but the note is still surfaced in a public work-item comment, so
 * it is bounded and path-sanitized like any other comment content.
 */
export const MAX_TOOL_REQUEST_MESSAGE_CHARS = 1_000;

/**
 * The untrusted half of a resolution, already typed.
 *
 * Deliberately free of `sessionId`, `issueNumber`, and any confirmation flag:
 * each of those is trusted authority and lives in the invocation context
 * (contract §5.1). `--dry-run` is likewise absent — preview is
 * `OperationContext.confirmed === false`.
 */
export interface ToolRequestResolveRequest {
  action: ToolRequestResolveAction;
  /**
   * Operator note. Required for `reject` (the rejection's reason is the
   * continuation context the agent is given), optional for `manual-done`.
   * Bounded and sanitized by the core before it is stored or published.
   */
  message?: string | undefined;
}

/** The parameters an adapter may set, in the flag spelling the CLI uses. */
export const TOOL_REQUEST_RESOLVE_PARAM_SPECS: readonly OperationParamSpec[] = Object.freeze([
  Object.freeze({ name: "action", type: "string" as const, required: true }),
  Object.freeze({ name: "message", type: "string" as const }),
]);

// ---------------------------------------------------------------------------
// Injected operation context (contract §11.2 point 5)
// ---------------------------------------------------------------------------

/** The `{ ok, output }` pair every git probe in this operation reads. */
export type ToolRequestResolveProbeResult = ToolRequestRunProbeResult;

/** The read-only git calls the requeue guards make. No command is ever run. */
export interface ToolRequestResolveExecPort {
  /** Run a git command, returning success plus its trimmed stdout (or the error detail). */
  probe(cmd: string, args: string[], cwd?: string): ToolRequestResolveProbeResult;
  /**
   * Whether origin has `branch`, keeping an ambiguous lookup failure
   * (`unknown`) distinct from a positively-absent branch (`no`).
   */
  remoteHasBranch(repoRoot: string, branch: string): "yes" | "no" | "unknown";
}

/** Where the requeue's cleanliness check must run. */
export interface ToolRequestResolveWorktreePort {
  /**
   * The per-issue worktree when one is registered for this issue, else the
   * canonical checkout. Fails closed: an unresolvable worktree root is an
   * error, never a silent fallback.
   */
  resolveDirtyCheckCwd(): { ok: true; cwd: string } | { ok: false; error: string };
}

/**
 * The task state this operation reads and writes.
 *
 * Narrowed to the three methods it uses rather than the whole {@link TaskStore}:
 * the transition is a compare-and-swap and the event is the audit record, and
 * nothing else about a store is this operation's business.
 */
export type ToolRequestResolveTaskPort = Pick<
  TaskStore,
  "getTask" | "transitionTask" | "appendEvent"
>;

/**
 * Everything the core needs and does not construct.
 *
 * Nothing here is read from a module-level singleton and nothing is built
 * inside the core, so the admin CLI, a test, and (later) ChatOps can each
 * supply their own (contract §11.2 point 5).
 */
export interface ToolRequestResolveContext {
  /** The trusted half of the invocation (contract §5). */
  invocation: OperationContext;
  /** The session the adapter resolved; never looked up ambiently by the core. */
  session: ResolvedSession;
  tasks: ToolRequestResolveTaskPort;
  outbox: OutboxStore;
  exec: ToolRequestResolveExecPort;
  worktree: ToolRequestResolveWorktreePort;
  /** Wall clock, as an ISO-8601 instant. */
  now(): string;
  /** Run identity, derived from `now` so one invocation has exactly one id. */
  runIdFor(now: string): string;
}

// ---------------------------------------------------------------------------
// Result constructors
// ---------------------------------------------------------------------------

/**
 * A definite, effect-free refusal: the operator's decision provably was not
 * recorded.
 *
 * Built as a literal rather than through `operationRejected` so the summary
 * keeps its full length — see the module header.
 */
function refuse(reason: OperationRejectionReason, summary: string): OperationResult {
  return { status: "rejected", reason, summary, effect: "none" };
}

/**
 * An indeterminate failure: the resolution is already persisted, so whatever
 * went wrong afterwards leaves publication state this operation cannot
 * characterize. Retry is unsafe — the already-resolved guard would refuse it —
 * and contract §9.2 keeps such a row `dispatching` for an operator.
 */
function failAfterResolution(summary: string): OperationResult {
  return { status: "failed", reason: "internal", effect: "unknown", summary };
}

/** A completed outcome, carrying the structured payload the CLI renders. */
function completed(
  summary: string,
  data: Record<string, unknown>,
  effect: "applied" | "none" = "applied",
): OperationResult {
  return { status: "executed", effect, summary, data };
}

/**
 * A precondition refusal raised from deep inside the requeue guards.
 *
 * The guards are a long, deliberately linear stretch of checks that the
 * pre-#1030 handler ended with `die()`. `die()` never returns, so the handler
 * could call it from anywhere; a core must *return* instead, and threading a
 * result back out of every nested branch would restructure logic whose exact
 * order is the contract. Throwing and catching once at the top keeps the order
 * identical and the returned refusal definite: nothing durable has happened at
 * any site that raises this.
 */
class ResolveRefused extends Error {
  readonly reason: OperationRejectionReason;
  constructor(reason: OperationRejectionReason, message: string) {
    super(message);
    this.name = "ResolveRefused";
    this.reason = reason;
  }
}

/** A guard that blocks the *requeue* without blocking the resolution itself. */
class RequeueGuardBlocked extends Error {
  readonly publicReason: string;
  constructor(message: string, publicReason: string) {
    super(message);
    this.name = "RequeueGuardBlocked";
    this.publicReason = publicReason;
  }
}

// ---------------------------------------------------------------------------
// Request validation
// ---------------------------------------------------------------------------

/**
 * Check the typed request's own value vocabulary, returning a defect message or
 * `null`.
 *
 * The port has already checked names and scalar types by the time a registered
 * invocation reaches the core, and the CLI parser checks the same rules while
 * turning argv into a typed request — but the core is callable directly by
 * ordinary JavaScript, and an unrecognized action would otherwise fall through
 * every `action === ...` branch below and resolve the request as neither.
 */
export function validateToolRequestResolveRequest(
  request: ToolRequestResolveRequest,
): string | null {
  const action: unknown = request?.action;
  if (action === undefined) return "--action is required";
  if (!(TOOL_REQUEST_RESOLVE_ACTIONS as readonly unknown[]).includes(action)) {
    return `--action must be one of: ${TOOL_REQUEST_RESOLVE_ACTIONS.join(", ")}, got: ${String(action)}`;
  }
  const message: unknown = request.message;
  if (message !== undefined && typeof message !== "string") {
    return `--message must be a string, got: ${String(message)}`;
  }
  if (action === "reject" && (message === undefined || (message as string).trim().length === 0)) {
    return "--message is required when --action reject is used";
  }
  return null;
}

// ---------------------------------------------------------------------------
// The core
// ---------------------------------------------------------------------------

/**
 * Resolve one Tool Request handoff.
 *
 * Every rule the admin CLI handler enforced is enforced here, in the same order
 * and with the same messages; the only change is that an outcome is *returned*
 * rather than printed and exited.
 */
export async function runToolRequestResolve(invocation: {
  request: ToolRequestResolveRequest;
  context: ToolRequestResolveContext;
}): Promise<OperationResult> {
  const { request, context } = invocation;
  const { session, tasks: store, outbox: outboxStore, exec } = context;
  const sessionId = context.invocation.sessionId;
  const issueNumber = context.invocation.issueNumber;
  if (issueNumber === null) {
    return refuse(
      "invalid-context",
      `${TOOL_REQUEST_RESOLVE_OPERATION_ID} requires a work item in context.`,
    );
  }
  const defect = validateToolRequestResolveRequest(request);
  if (defect !== null) return refuse("invalid-request", defect);
  const action = request.action;
  const message = request.message;
  // Preview is trusted context, never a parameter (contract §5.2). It maps onto
  // the CLI's long-standing `--dry-run`.
  const dryRun = !context.invocation.confirmed;

  const now = context.now();
  const boundedMessage =
    message !== undefined
      ? sanitizeBody(
          boundedExcerpt(message.trim(), MAX_TOOL_REQUEST_MESSAGE_CHARS),
          sessionRedactionPaths(session),
        )
      : undefined;

  try {
    const task = await store.getTask({ sessionId, issueNumber });
    if (!task) {
      return refuse(
        "precondition-failed",
        `Task not found: session "${sessionId}", issue #${issueNumber}`,
      );
    }

    const existing = readStoredToolRequest(task);
    if (!existing) {
      return refuse(
        "precondition-failed",
        `Issue #${issueNumber} in session "${sessionId}" has no Tool Request to resolve.`,
      );
    }
    // issue #674: a plain `reject` only records the decision — it never runs a
    // command, requeues the task, or touches the repo, so nothing about the
    // task's recoverability is consumed. Exactly one subsequent `manual-done`
    // may resume it (e.g. an operator rejected a Tool Request raised before the
    // issue had a PR, not realizing rejection alone leaves the task parked at
    // ready_for_human with no path back to implementation). Any other prior
    // resolution (an earlier manual-done, or a grant's guided-run/grant outcome)
    // already executed or requeued and must not be replayed — and once this
    // exemption itself has been used, it must not fire again either, or the
    // same stale rejected request could requeue an issue back into
    // implementation after it has already reached done (issue #674 review).
    // Computed ahead of the `resolved` gate below so it is also available to
    // preserve the prior rejection when building `resolvedToolRequest` further
    // down.
    const priorResolution = existing["resolution"] as { action?: unknown } | undefined;
    // The exemption below is one-shot: once a reject has already been resumed
    // via manual-done, `existing["rejectRecoveryConsumed"]` is set (further
    // down) so a second manual-done — or the same stale Tool Request
    // requeuing a later, already-completed issue back into implementation —
    // is refused instead of replayed indefinitely (issue #674 review).
    // It also requires the task to still be parked at the original
    // `ready_for_human` handoff: if the task has since progressed through
    // any other recovery path (e.g. reached `done`), a stale rejected
    // request must not be allowed to requeue completed work back to
    // `queued` (issue #674 review follow-up).
    // Status alone is not enough: a task can reach `ready_for_human` again
    // later in a completely different phase (e.g. a review-phase human
    // handoff) while the stale rejected toolRequest is still sitting in its
    // context untouched. Requiring `task.phase === "implementation"` — the
    // only phase that ever produces a Tool Request handoff — pins this
    // exemption to the original handoff, so a later review-phase
    // `ready_for_human` cannot be requeued into implementation by replaying
    // it (issue #674 review, round 2).
    const priorWasPlainReject =
      existing["resolved"] === true &&
      priorResolution?.action === "reject" &&
      existing["rejectRecoveryConsumed"] !== true &&
      task.status === "ready_for_human" &&
      task.phase === "implementation";
    if (existing["resolved"] === true) {
      if (!(action === "manual-done" && priorWasPlainReject)) {
        return refuse(
          "precondition-failed",
          `Tool Request for issue #${issueNumber} in session "${sessionId}" is already resolved.`,
        );
      }
    }
    if (task.status === "claimed" || task.status === "running") {
      return refuse(
        "conflict",
        `Task #${issueNumber} in session "${sessionId}" is currently ${task.status}` +
          (task.ownerRunId ? ` (owner: ${task.ownerRunId})` : "") +
          `. Refusing to resolve an active task. Wait for it to complete or recover it first.`,
      );
    }

    // issue #674 review: resuming a rejected pre-PR handoff via `manual-done` did
    // not actually run the command or change the repository — only the task's
    // requeue-eligibility is being consumed here. Replacing the stored `reject`
    // resolution with a fresh `manual-done` one would misrepresent that history to
    // the resumed implementation prompt: toolRequestResolutionPromptSection reads
    // `resolution.action`, and for anything other than `reject` it tells the agent
    // "the command has been run ... its effects are in the repository", which is
    // false here and would make the agent trust repo state that was never
    // produced. Preserve the original rejection (and its reason/message) as
    // continuation context instead of overwriting it, but stamp
    // `rejectRecoveryConsumed` so this same stored request cannot grant the
    // exemption a second time (see `priorWasPlainReject` above).
    const resumingAfterPlainReject = action === "manual-done" && priorWasPlainReject;
    const resolvedToolRequest = resumingAfterPlainReject
      ? { ...existing, rejectRecoveryConsumed: true }
      : {
          ...existing,
          resolved: true,
          resolution: {
            action,
            ...(boundedMessage !== undefined ? { message: boundedMessage } : {}),
            resolvedAt: now,
          },
        };

    // manual-done requeues the task to implementation so the agent retries now
    // that the operator has performed the requested command externally. reject
    // also requeues (issue #678): the operator's decision not to run the command
    // is itself the continuation context — toolRequestResolutionPromptSection's
    // "reject" branch delivers it to the agent as human feedback, so there is
    // nothing further for a human to decide. A human handoff remains only when
    // the safety guards below (dirty tree, unpushed base, no usable continuation
    // point) refuse the requeue.
    //
    // manual-done and reject differ in what a blocked guard means, though: for
    // manual-done the operator asserts real repo changes are waiting to be picked
    // up, so a guard failure refuses the whole resolution (unchanged from before
    // #678) — silently recording "resolved" against a dirty/unsafe tree would
    // strand the task. For reject nothing ever touched the repo, so the rejection
    // itself is always safe to record; only the *requeue* is conditional.
    // `requeueGuardFail` embodies that split: a blocked guard downgrades
    // `requeue` to false for reject (the task simply stays a human handoff,
    // exactly as it did before #678) instead of aborting the whole resolve.
    let requeue = action === "manual-done" || action === "reject";
    // `message` may embed raw probe() output (e.g. git fetch/remote stderr),
    // which can carry credential-bearing remote URLs or other remote-provided
    // diagnostics that `sanitizeBody` does not scrub (it only strips filesystem
    // paths). `publicReason` is what is safe to post in the public work-item
    // comment; it defaults to `message` for guard sites whose text never embeds
    // raw command output, and is overridden with a controlled generic reason at
    // any call site that does (issue #678 review).
    const requeueGuardFail = (message: string, publicReason?: string): never => {
      if (action === "manual-done") throw new ResolveRefused("precondition-failed", message);
      throw new RequeueGuardBlocked(message, publicReason ?? message);
    };
    // Captured from a blocked reject's guard (dirty checkout, ahead base, or no
    // usable continuation point) so it can be surfaced in the comment/result below
    // instead of discarded — the public comment tells the operator that a
    // blocking reason exists, so that must actually be present there (issue #678
    // review). `requeueGuardBlockedMessage` (the full, possibly diagnostic-bearing
    // text) is for CLI/audit surfaces only (the returned payload, the appended
    // event); `requeueGuardPublicReason` (never contains raw probe output) is the
    // only one that reaches the public work-item comment.
    let requeueGuardBlockedMessage: string | undefined;
    let requeueGuardPublicReason: string | undefined;

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
      try {
        const expectedFiles = Array.isArray(existing["expectedFiles"])
          ? (existing["expectedFiles"] as unknown[]).filter((f): f is string => typeof f === "string")
          : [];
        // The work branch the side effects must live on (issue #316): the existing
        // PR head branch, else the conventional issue branch. Tool Request changes
        // belong here, never on the session base branch.
        const workBranch = resolveToolRequestWorkBranch(task, issueNumber);
        const baseBranch = session.baseBranch ?? "main";

        // Where the working-tree cleanliness check must run. The implementation phase
        // (issue #732) checks `ai/issue-<n>` out in its own per-issue worktree
        // UNCONDITIONALLY, and a Tool Request handoff (grant or manual run) left the
        // command's side effects there, never in the canonical checkout. The requeued
        // implementation run's dirty preflight runs in that same worktree (issue #454),
        // so manual-done must validate cleanliness against it too: probing only
        // `session.repoRoot` would pass a dirty issue worktree and requeue the task
        // straight into a worktree-dirty preflight failure — resolved request, stuck
        // task. The injected port resolves the per-issue worktree whenever one is
        // actually registered for this issue and falls back to the canonical checkout
        // only when no worktree entry exists yet (e.g. the run failed before Step 0.6
        // materialized one); a misconfigured worktree root fails closed here rather
        // than silently falling back.
        let dirtyCheckCwd = session.repoRoot;
        const resolvedCwd = context.worktree.resolveDirtyCheckCwd();
        if (!resolvedCwd.ok) {
          requeueGuardFail(
            `Refusing to resolve Tool Request for issue #${issueNumber} in session "${sessionId}": the session ` +
              `enables per-issue worktrees but its worktree root is misconfigured: ` +
              `${resolvedCwd.error}`,
          );
        } else {
          dirtyCheckCwd = resolvedCwd.cwd;
        }
        const inWorktree = dirtyCheckCwd !== session.repoRoot;

        const statusProbe = exec.probe("git", ["status", "--porcelain"], dirtyCheckCwd);
        if (statusProbe.ok && statusProbe.output.length > 0) {
          requeueGuardFail(
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
          const aheadProbe = exec.probe(
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
              requeueGuardFail(
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
        const localBranchExists = exec.probe(
          "git",
          ["rev-parse", "--verify", "--quiet", `refs/heads/${workBranch}`],
          session.repoRoot,
        ).ok;
        const hasOrigin = exec.probe("git", ["remote", "get-url", "origin"], session.repoRoot).ok;
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
          const remote = exec.remoteHasBranch(session.repoRoot, workBranch);
          if (remote === "unknown") {
            requeueGuardFail(
              `Refusing to resolve Tool Request for issue #${issueNumber} in session "${sessionId}": could not ` +
                `determine whether origin has the issue branch '${workBranch}' (lookup failed). The local branch ` +
                `must be confirmed pushed before requeueing, since a later Tool Request handoff deletes it with ` +
                `'git branch -D' and would lose any commits that live only in this checkout. Restore connectivity ` +
                `to origin and re-run this resolve.`,
            );
          }
          if (remote === "no") {
            requeueGuardFail(
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
          // must not run on the preview path, which is advertised as non-persisting
          // (issue #316 review). Defer the push-confirmation to the real resolve; the
          // preview still records the resume branch from the read-only origin-presence
          // check above.
          if (!dryRun) {
            const fetchedWorkBranch = exec.probe(
              "git",
              ["fetch", "origin", workBranch],
              session.repoRoot,
            );
            if (!fetchedWorkBranch.ok) {
              // fetchedWorkBranch.output is raw `git fetch` stderr and may carry a
              // credential-bearing remote URL or other remote-provided diagnostics —
              // keep it in the detailed message (CLI/audit only) and give the public
              // comment a controlled generic reason instead (issue #678 review).
              requeueGuardFail(
                `Refusing to resolve Tool Request for issue #${issueNumber} in session "${sessionId}": could not fetch ` +
                  `origin '${workBranch}' to confirm the local issue branch's commits are pushed ` +
                  `(git fetch origin ${workBranch} failed: ${fetchedWorkBranch.output}). Restore connectivity to origin ` +
                  `in ${session.repoRoot}, then re-run this resolve.`,
                `Refusing to resolve Tool Request for issue #${issueNumber} in session "${sessionId}": could not fetch ` +
                  `origin '${workBranch}' to confirm the local issue branch's commits are pushed. Restore connectivity ` +
                  `to origin, then re-run this resolve.`,
              );
            }
            const aheadOfOrigin = exec.probe(
              "git",
              ["rev-list", "--count", `FETCH_HEAD..${workBranch}`],
              session.repoRoot,
            );
            if (!aheadOfOrigin.ok) {
              // The fetch above succeeded but the local branch cannot be compared
              // against the fetched origin tip (FETCH_HEAD) — we cannot prove the local
              // branch is not ahead. Fail closed rather than record a possibly
              // local-ahead branch (issue #316 review).
              requeueGuardFail(
                `Refusing to resolve Tool Request for issue #${issueNumber} in session "${sessionId}": cannot compare the ` +
                  `local issue branch '${workBranch}' against the fetched origin tip (FETCH_HEAD), so its commits cannot ` +
                  `be confirmed pushed. Resolve the repository state in ${session.repoRoot}, then re-run this resolve.`,
              );
            }
            const aheadCount = Number.parseInt(aheadOfOrigin.output.trim(), 10);
            if (Number.isFinite(aheadCount) && aheadCount > 0) {
              requeueGuardFail(
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
          const remote = exec.remoteHasBranch(session.repoRoot, workBranch);
          if (remote === "unknown") {
            requeueGuardFail(
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
        // For reject, no command ever ran, so there is nothing at risk when the
        // prior implementation attempt had no diff to preserve in the first place
        // (issue #678) — requeueing branches a fresh implementation run from base,
        // which is exactly the normal starting point. The guard below still applies
        // to reject when a patch/preserved branch exists (or capture failed): that
        // prior implementation work predates and is independent of the rejected
        // command, and still needs a usable continuation point to resume from.
        const rejectWithNothingAtRisk = action === "reject" && existing["noPriorDiff"] === true;
        if (statusProbe.ok && toolRequestResumeBranch === undefined && !rejectWithNothingAtRisk) {
          // Tailor the recovery guidance to what the handoff actually preserved
          // (issue #390), so operators are not told to look for a patch that was
          // never produced. Three cases, distinguished by the stored request:
          //   - a patch was captured  → reapply it, run the command, commit & push
          //   - no diff was produced  → there is NO patch; just run the command on
          //                             a fresh issue branch, commit & push
          //   - capture failed        → a diff may have existed but no patch exists;
          //                             rebuild from the artifacts, commit & push
          // For `reject` the command was never approved to run at all (issue #678),
          // so the "run the requested command" step is dropped from each case below.
          const hasPatch = typeof existing["partialDiffArtifact"] === "string";
          const noPriorDiff = existing["noPriorDiff"] === true;
          const captureFailed = typeof existing["partialDiffCaptureFailed"] === "string";
          const runCommandStep = action === "reject" ? "" : "run the requested command, then ";
          const recovery = hasPatch
            ? `apply the preserved partial-implementation patch from the failed run's artifact dir ` +
              `(${String(existing["partialDiffArtifact"])}), ${runCommandStep}commit AND push `
            : noPriorDiff
              ? `the prior attempt produced no implementation diff, so there is NO partial-implementation ` +
                `patch to apply — simply ${runCommandStep}commit AND push `
              : captureFailed
                ? `the prior attempt's partial-diff capture failed so no patch was written ` +
                  `(${String(existing["partialDiffCaptureFailed"]).slice(0, 200)}); reconstruct the change from ` +
                  `the failed run's artifacts, ${runCommandStep}commit AND push `
                : `apply the preserved partial-implementation patch from the failed run's artifact dir ` +
                  `(partial-implementation.patch) if present, ${runCommandStep}commit AND push `;
          const sideEffectsPhrase =
            action === "reject"
              ? `the command was rejected and never ran, and the prior implementation attempt's edits`
              : `the requested command's side effects`;
          requeueGuardFail(
            `Refusing to requeue issue #${issueNumber} in session "${sessionId}": the previous Tool ` +
              `Request attempt left no usable continuation point. The issue branch '${workBranch}' is ` +
              `absent both locally and on origin, there is no PR to resume from, and ${sideEffectsPhrase}` +
              (expectedFiles.length > 0 ? ` (expected: ${expectedFiles.join(", ")})` : "") +
              ` are not committed anywhere reachable. Requeueing now would branch a fresh implementation ` +
              `run from the base branch '${baseBranch}' with none of the prior work, so the agent would ` +
              `hit the same blocker and re-request the same command — a Tool Request loop.\n` +
              `Recover by landing the change on the issue branch '${workBranch}': in ${session.repoRoot}, ` +
              recovery +
              `'${workBranch}' to origin (never the base branch '${baseBranch}'). Re-run this resolve once ` +
              `that branch exists.` +
              (action === "reject" ? "" : ` If the request should not proceed, use 'tool-request resolve --action reject' instead.`),
          );
        }
      } catch (err) {
        // A blocked reject does not abort the resolve (see requeueGuardFail above):
        // the rejection is still recorded below, just without an automatic requeue.
        if (!(err instanceof RequeueGuardBlocked)) throw err;
        requeue = false;
        requeueGuardBlockedMessage = err.message;
        requeueGuardPublicReason = err.publicReason;
      }
    }

    const targetStatus = requeue ? "queued" : task.status;
    const targetPhase: TaskPhase = requeue ? "implementation" : task.phase;

    if (dryRun) {
      return completed(
        `Would resolve the Tool Request for issue #${issueNumber} in session "${sessionId}" ` +
          `(action: ${action})` +
          (requeue ? `, re-queueing it for implementation` : `, leaving it a human handoff`) +
          `. Preview only — nothing was written.`,
        {
          ok: true,
          dryRun: true,
          sessionId,
          issueNumber,
          action,
          previousStatus: task.status,
          previousPhase: task.phase,
          wouldRequeue: requeue ? { status: targetStatus, phase: targetPhase } : null,
          message: boundedMessage ?? null,
        },
        // A preview changes nothing outside the process (contract §5.2).
        "none",
      );
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
      // The transition is a compare-and-swap on the status this invocation read,
      // so a failure means nothing was written: the refusal is definite and the
      // same invocation may be retried against the task's current state.
      return refuse(
        "conflict",
        `Failed to resolve Tool Request: ${result.code}` +
          (result.current ? ` (current status: ${result.current.status})` : ""),
      );
    }

    const transitioned = result.value;

    // Past this point the operator's decision is durable. Anything that fails
    // below leaves publication incomplete against an already-resolved request,
    // which a retry cannot repair (the already-resolved guard would refuse it) —
    // so it is reported as an indeterminate failure for an operator to inspect,
    // never as a definite, retry-safe refusal.
    try {
      const runId = context.runIdFor(now);
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
      // issue #674 review: `resumingAfterPlainReject` requeues the task, but the
      // rejected command was never run and no side effects were ever produced or
      // pushed — only the rejection's requeue-eligibility is being consumed (see
      // the `resolvedToolRequest` comment above). Reporting this the same way as a
      // real manual-done would falsely tell readers the operator ran the command
      // and pushed its effects. Give it its own outcome label so the public
      // comment, audit event, and machine-readable output all describe what
      // actually happened: the branch is being resumed, not the command.
      const resolutionOutcome = resumingAfterPlainReject
        ? "requeued_after_rejection"
        : action === "manual-done"
          ? "manual_done"
          : "rejected";
      let commentBody = resumingAfterPlainReject
        ? `🔁 **Tool Request rejection requeued for implementation.**\n\n` +
          `Requested command: \`${displayCommand}\`\n\n` +
          `The command was rejected and was never run — no side effects were produced. The existing pushed issue branch is being resumed as pre-PR implementation work, and the task has been re-queued for implementation.`
        : action === "manual-done"
          ? `✅ **Tool Request marked as manually completed by operator.**\n\n` +
            `Requested command: \`${displayCommand}\`\n\n` +
            `This does not approve the command for future automated runs. It signals that the operator has already run the command externally and made the side effects visible to the repository (committed and pushed). The task has been re-queued for implementation.\n\n` +
            `If the agent re-requests the same command, the repository state still appears unchanged — verify that the expected changed files were committed and pushed before this resolve.`
          : requeue
            ? `🚫 **Tool Request rejected by operator — result returned to the agent.**\n\n` +
              `Requested command: \`${displayCommand}\`\n\n` +
              `The command will not be actioned automatically. The rejection has been delivered to the ` +
              `requesting agent as continuation context and the task has been re-queued for implementation.`
            : `🚫 **Tool Request rejected by operator — task remains parked for human review.**\n\n` +
              `Requested command: \`${displayCommand}\`\n\n` +
              `The command will not be actioned automatically. The rejection was recorded, but the task ` +
              `could not be safely requeued for implementation and remains a human handoff.` +
              (requeueGuardPublicReason !== undefined
                ? `\n\n**Blocking reason:**\n\n> ${requeueGuardPublicReason.replace(/\n/g, "\n> ")}`
                : "");
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
        message: `Operator resolved Tool Request for issue #${issueNumber} (action: ${action}, outcome: ${resolutionOutcome})`,
        data: {
          action,
          outcome: resolutionOutcome,
          requeued: requeue,
          previousStatus: task.status,
          previousPhase: task.phase,
          hasMessage: boundedMessage !== undefined,
          ...(requeueGuardBlockedMessage !== undefined ? { requeueBlockedReason: requeueGuardBlockedMessage } : {}),
        },
        createdAt: now,
      });

      return completed(
        `Tool Request for issue #${issueNumber} in session "${sessionId}" resolved ` +
          `(action: ${action}, outcome: ${resolutionOutcome})` +
          (requeue
            ? `; the task is re-queued for implementation.`
            : `; the task remains a human handoff.`),
        {
          ok: true,
          sessionId,
          issueNumber,
          action,
          outcome: resolutionOutcome,
          status: transitioned.status,
          phase: transitioned.phase,
          previousStatus: task.status,
          previousPhase: task.phase,
          requeued: requeue,
          message: boundedMessage ?? null,
          ...(requeueGuardBlockedMessage !== undefined ? { requeueBlockedReason: requeueGuardBlockedMessage } : {}),
        },
      );
    } catch (err) {
      return failAfterResolution(
        `Tool Request for issue #${issueNumber} in session "${sessionId}" was resolved (action: ${action}) ` +
          `and the task is now ${transitioned.status}/${transitioned.phase}, but publishing the outcome failed: ` +
          `${err instanceof Error ? err.message : String(err)}. The resolution is already durable, so re-running ` +
          `this resolve will be refused as already resolved — inspect the outbox for issue #${issueNumber} and ` +
          `publish the missing labels/comment by hand if needed.`,
      );
    }
  } catch (err) {
    // The only refusal raised as an exception: a manual-done requeue guard deep
    // inside the checks above (see `ResolveRefused`). Nothing durable has
    // happened on any of those paths, so it stays a definite, retry-safe
    // rejection.
    if (err instanceof ResolveRefused) return refuse(err.reason, err.message);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Port binding (contract §4.2) — deliberately not registered anywhere
// ---------------------------------------------------------------------------

/**
 * Convert already-validated port parameters into the typed request.
 *
 * The port has checked names and scalar types by the time this runs; what is
 * left is the operation's own value vocabulary, which is refused as
 * `invalid-request` exactly the way the CLI refuses the same flag values. The
 * admin CLI parser calls this too, so both surfaces produce byte-identical
 * messages for the same bad value.
 */
export function parseToolRequestResolveParams(
  params: OperationParams,
): { request: ToolRequestResolveRequest } | { error: string } {
  const read = (name: string): unknown =>
    Object.prototype.hasOwnProperty.call(params, name)
      ? (params as Record<string, unknown>)[name]
      : undefined;

  const rawAction = read("action");
  const rawMessage = read("message");
  const candidate = {
    action: rawAction as ToolRequestResolveAction,
    ...(rawMessage === undefined ? {} : { message: rawMessage as string }),
  };
  const defect = validateToolRequestResolveRequest(candidate);
  if (defect !== null) return { error: defect };
  return { request: candidate };
}

/**
 * Build the `tool-request.resolve` descriptor over an injected context resolver.
 *
 * A registry is a *collection point*, so this module never reaches back into
 * one (contract §3.2): `CHATOPS_OPERATION_DESCRIPTORS` calls this factory, not
 * the other way round. It exists so a composition root, `admin ui`, and this
 * repository's tests can each drive the same core through `invokeOperation`
 * with their own injected context.
 */
export function createToolRequestResolveDescriptor(
  resolveContext: (
    invocation: OperationContext,
  ) => ToolRequestResolveContext | Promise<ToolRequestResolveContext>,
): OperationDescriptor {
  return {
    id: TOOL_REQUEST_RESOLVE_OPERATION_ID,
    // Verbatim from `CHATOPS_OPERATION_MAPPINGS`' `/resolve` row: the mapping
    // declares `operationId`/`scope`/`mutating`/`summary` ahead of any
    // registration, and `docs/chatops-operation-mapping-contract.md` §12 leaves
    // checking that declaration against a real descriptor to whichever issue
    // registers it. Matching it here means that check has nothing to reconcile.
    summary: "Resolve this issue's Tool Request handoff without running its command.",
    mutating: true,
    scope: "issue",
    params: TOOL_REQUEST_RESOLVE_PARAM_SPECS,
    run: async ({ request, context }) => {
      const parsed = parseToolRequestResolveParams(request.params);
      if ("error" in parsed) {
        return { status: "rejected", reason: "invalid-request", summary: parsed.error, effect: "none" };
      }
      const resolved = await resolveContext(context);
      return runToolRequestResolve({ request: parsed.request, context: resolved });
    },
  };
}
