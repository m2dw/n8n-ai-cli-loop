/**
 * `tool-request.run` — the callable guided-run operation core (issue #1029).
 *
 * `docs/operation-dispatch-port-contract.md` §11.2 admits an operation into a
 * registry only once its decision-and-action body is a
 * `{ request, context } → OperationResult` function that parses no argv, writes
 * no output, never calls `die()`/`process.exit`, and takes every store, lock,
 * provider and clock by injection. Until this module existed, the guided run was
 * only reachable as `runToolRequestGrant(argv)` inside `src/cli/admin.ts`: it
 * parsed its own flags, printed through the process-global output mode, and
 * reported failure by exiting the process. That is exactly the shape §11.1
 * describes as *not* callable, and it is why `CHATOPS_OPERATION_DESCRIPTORS`
 * could not name this operation.
 *
 * This module is the extracted core. It owns every business rule the CLI
 * handler owned — single-use grant semantics, Tool Request instance identity,
 * exact-command normalization, expected-file classification, dirty-worktree
 * handling, the three dispositions, artifact recording, and continuation
 * routing — and returns a typed {@link OperationResult} instead of printing and
 * exiting. `src/cli/admin.ts` keeps argv parsing, session resolution, store
 * construction, JSON/human rendering, and exit-code mapping; it is now a shell
 * over this core and its observable behavior is unchanged.
 *
 * Registration is deliberately NOT done here.
 * `createToolRequestRunDescriptor` exists so a composition root (and this
 * repository's tests) can reach the core through `invokeOperation`; an
 * operation module never reaches back into a registry to register itself
 * (§3.2). `src/core/chatops-operations.ts` is the ChatOps collection point, and
 * issue #1031 named this operation there.
 *
 * ## Result vocabulary
 *
 * The mapping is retry-safety, not severity (contract §7, §9.2):
 *
 *   - `rejected` — the approved command provably did not run. Nothing durable
 *     changed, so the caller may retry the same invocation once the named
 *     precondition is fixed.
 *   - `failed` / `effect: "unknown"` — the approved command already ran and a
 *     later step could not be completed. Its side effects are on disk (and the
 *     one-shot grant may already be recorded as consumed), so a retry is NOT
 *     safe and an operator must look.
 *   - `executed` — the operation reached one of its documented outcomes. `data`
 *     carries the structured payload the admin CLI prints verbatim.
 *
 * Summaries are returned at full length rather than pre-truncated: the admin CLI
 * uses one as its `die()` message and must keep the exact operator guidance the
 * handler has always printed, and `invokeOperation` bounds every summary to
 * `OPERATION_SUMMARY_MAX_CHARS` at the port boundary for the surfaces that need
 * it (contract §12).
 */

import { isAbsolute, join, relative } from "path";
import type { AiTask, StoreResult, TaskExpected, TaskKey, TaskPatch } from "./task.js";
import type { OutboxEffect, TaskStore } from "./task-store.js";
import type { OutboxStore } from "./outbox.js";
import { makeOutboxKey } from "./outbox.js";
import type { ResolvedSession } from "./session.js";
import type {
  OperationContext,
  OperationDescriptor,
  OperationParamSpec,
  OperationParams,
  OperationRejectionReason,
  OperationResult,
} from "./operation-port.js";
import { applyTaskPatch } from "./transitions.js";
import { agentForPhase } from "./assignment.js";
import { enqueueStatusLabelEffects, sessionRedactionPaths, workItemOutbox } from "./outbox-effects.js";
import { OutboxEffectCollector } from "./phase-runner.js";
import { sanitizeBody } from "./text-sanitize.js";
import { hasUnresolvedToolRequest, redactCommand } from "./tool-request.js";
import {
  createToolRequestGrant,
  grantMatches,
  grantStatus,
  normalizeCommand,
} from "./tool-request-grant.js";
import type { GrantCandidate, ToolRequestGrant } from "./tool-request-grant.js";
import {
  classifyChangedFiles,
  parsePorcelainStatus,
  parseRepoChangeAction,
  planRepoChange,
  summarizeClassification,
} from "./tool-request-changes.js";
import type { RepoChangeAction } from "./tool-request-changes.js";
import {
  buildToolRequestContinuationRecord,
  collectPendingImplementationMarkers,
  decideToolRequestContinuation,
  resolveConfiguredVerification,
} from "./tool-request-continuation.js";
import { toolRequestTestSuiteKey } from "./test-stage-routing.js";
import { checkReviewAdmission, resolveDependencyReviewBase } from "./review-admission.js";
import { boundVerificationOutput } from "./verification-output.js";
import { branchName, extractPrNumber, resolvePrContext } from "./pr-context.js";
import type { CommandRunResult } from "../handlers/command-runner.js";

// ---------------------------------------------------------------------------
// Identity and typed request (contract §4)
// ---------------------------------------------------------------------------

/** The canonical operation id `docs/chatops-operation-mapping-contract.md` §7 binds `/grant` to. */
export const TOOL_REQUEST_RUN_OPERATION_ID = "tool-request.run";

/** Wall-clock ceiling for one approved command. */
export const GRANT_EXEC_DEFAULT_TIMEOUT_MS = 120_000;
/** Output ceiling for one approved command's captured streams. */
export const GRANT_EXEC_MAX_BUFFER_BYTES = 80 * 1024 * 1024;

/** The lock context id the guided run takes the session's repo lock under. */
export const TOOL_REQUEST_RUN_LOCK_CONTEXT_ID = "admin-tool-request-grant";

export const GUIDED_RUN_DISPOSITIONS = ["keep", "commit", "discard"] as const;
export type GuidedRunDisposition = (typeof GUIDED_RUN_DISPOSITIONS)[number];

/**
 * The untrusted half of a guided run, already typed.
 *
 * Deliberately free of `sessionId`, `issueNumber`, and any confirmation flag:
 * each of those is trusted authority and lives in the invocation context
 * (contract §5.1). `--dry-run` is likewise absent — preview is
 * `OperationContext.confirmed === false`.
 */
export interface ToolRequestRunRequest {
  /** Must equal the recorded request's command; grants are exact-command only. */
  command?: string | undefined;
  ttlSeconds?: number | undefined;
  maxUses?: number | undefined;
  /** Disposition for changes the approved command leaves behind (issue #430). */
  disposition: GuidedRunDisposition;
  /** Guided change handling for a dirty tree (issue #419). */
  onChanges?: RepoChangeAction | undefined;
  /** Required to proceed with the destructive `on-changes: discard`. */
  confirmDiscard: boolean;
  /** Allow `on-changes: commit` to include files outside the expected set. */
  allowUnexpected: boolean;
}

/** The parameters an adapter may set, in the flag spelling the CLI uses. */
export const TOOL_REQUEST_RUN_PARAM_SPECS: readonly OperationParamSpec[] = Object.freeze([
  Object.freeze({ name: "command", type: "string" as const }),
  Object.freeze({ name: "ttl-seconds", type: "number" as const }),
  Object.freeze({ name: "max-uses", type: "number" as const }),
  Object.freeze({ name: "disposition", type: "string" as const }),
  Object.freeze({ name: "on-changes", type: "string" as const }),
  Object.freeze({ name: "confirm-discard", type: "boolean" as const }),
  Object.freeze({ name: "allow-unexpected", type: "boolean" as const }),
]);

// ---------------------------------------------------------------------------
// Injected operation context (contract §11.2 point 5)
// ---------------------------------------------------------------------------

/** The `{ ok, output }` pair every git probe in this operation reads. */
export interface ToolRequestRunProbeResult {
  ok: boolean;
  output: string;
}

/** Command execution — the approved command itself and every git call. */
export interface ToolRequestRunExecPort {
  /** Run a command, returning success plus its trimmed stdout (or the error detail). */
  probe(cmd: string, args: string[], cwd?: string): ToolRequestRunProbeResult;
  /**
   * Whether origin has `branch`, keeping an ambiguous lookup failure
   * (`unknown`) distinct from a positively-absent branch (`no`).
   */
  remoteHasBranch(repoRoot: string, branch: string): "yes" | "no" | "unknown";
  /** Both-streams runner: stderr is captured even on a zero exit. */
  run(
    file: string,
    args: string[],
    options: { cwd: string; timeout?: number; maxBuffer?: number },
  ): CommandRunResult;
  /**
   * `git status --porcelain` with its status columns intact (never trimmed),
   * or `undefined` when it cannot be read.
   */
  rawPorcelainStatus(cwd: string): string | undefined;
}

/**
 * Task state, plus the one atomic transition-with-effects the direct-review
 * continuation needs.
 *
 * `transitionTaskWithEffects` is deliberately not on `TaskStore` — it exists for
 * callers that already hold a store with its own transaction, rather than as a
 * contract every implementation must satisfy (see `SqliteTaskStore`). The core
 * needs it on the #722 direct-review edge, where the transition and its label
 * effects must commit together or not at all, so the port asks for it explicitly
 * instead of narrowing to a concrete store class.
 */
export type ToolRequestRunTaskPort = TaskStore & {
  transitionTaskWithEffects(
    key: TaskKey,
    expected: TaskExpected,
    patch: TaskPatch,
    effects: OutboxEffect[],
  ): Promise<StoreResult<AiTask>>;
};

/** The single-worker repo lock the guided run's critical section runs under. */
export interface ToolRequestRunLockPort {
  acquire(
    contextId: string,
    sessionId: string,
    now: string,
  ): { locked: boolean; ownerContextId?: string; ownerStartedAt?: string };
  release(contextId: string, sessionId: string): void;
}

/** Where the approved command and its git operations run. */
export interface ToolRequestRunWorktreePort {
  /**
   * The per-issue worktree when one is registered for this issue, else the
   * canonical checkout. Fails closed: an unresolvable worktree root is an
   * error, never a silent fallback.
   */
  resolveRunCwd(): { ok: true; cwd: string } | { ok: false; error: string };
}

/** Local (never public) run artifacts. */
export interface ToolRequestRunArtifactPort {
  /** The directory this run's artifacts belong in. */
  dirFor(runId: string): string;
  fileExists(path: string): boolean;
  /** Write `contents` at `path`, creating parent directories. May throw. */
  writeFile(path: string, contents: string): void;
  /** Remove a directory subtree. May throw. */
  removeDir(path: string): void;
}

/**
 * Everything the core needs and does not construct.
 *
 * Nothing here is read from a module-level singleton and nothing is built
 * inside the core, so the admin CLI, a test, and (later) ChatOps can each
 * supply their own (contract §11.2 point 5).
 */
export interface ToolRequestRunContext {
  /** The trusted half of the invocation (contract §5). */
  invocation: OperationContext;
  /** The session the adapter resolved; never looked up ambiently by the core. */
  session: ResolvedSession;
  tasks: ToolRequestRunTaskPort;
  outbox: OutboxStore;
  repoLock: ToolRequestRunLockPort;
  exec: ToolRequestRunExecPort;
  worktree: ToolRequestRunWorktreePort;
  artifacts: ToolRequestRunArtifactPort;
  /** Wall clock, as an ISO-8601 instant. */
  now(): string;
  /** Run identity, derived from `now` so one invocation has exactly one id. */
  runIdFor(now: string): string;
  /**
   * How the operator-response record is tagged. `tool-request run` records
   * `guided-run`; the deprecated `tool-request grant` alias records `grant` so
   * historical continuation prompts still read correctly. Adapter-owned, never
   * a request parameter.
   */
  responseAction: "guided-run" | "grant";
  /**
   * The Issue-body verification-command extractor (issue #1154), used to
   * resolve the task's effective plan when matching a granted command against
   * the bound test suite. Injected because the extractor lives in the
   * Execution layer.
   */
  extractIssueVerificationCommands(body: string): readonly string[];
}

// ---------------------------------------------------------------------------
// Task-derived helpers shared with the rest of the Tool Request surface
// ---------------------------------------------------------------------------

/** The stored Tool Request block on a task, when it is a plain object. */
export function readStoredToolRequest(task: {
  context: Record<string, unknown>;
}): Record<string, unknown> | undefined {
  const tr = task.context["toolRequest"];
  if (tr && typeof tr === "object" && !Array.isArray(tr)) return tr as Record<string, unknown>;
  return undefined;
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
export function resolveToolRequestWorkBranch(task: AiTask, issueNumber: number): string {
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
export function resolveToolRequestDependencyHead(task: AiTask): string | undefined {
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
export function moveToToolRequestBranch(
  exec: ToolRequestRunExecPort,
  repoRoot: string,
  workBranch: string,
  baseBranch: string,
  depStartPoint?: string,
  fromRecordedPr = false,
): { ok: true; created: boolean; resumeSafe: boolean } | { ok: false; error: string } {
  const current = exec.probe("git", ["rev-parse", "--abbrev-ref", "HEAD"], repoRoot);
  const hasOrigin = exec.probe("git", ["remote", "get-url", "origin"], repoRoot).ok;

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
    const remoteHas = exec.remoteHasBranch(repoRoot, workBranch);
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
    const pull = exec.probe("git", ["pull", "origin", workBranch, "--ff-only"], repoRoot);
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
    const ahead = exec.probe("git", ["rev-list", "--count", `FETCH_HEAD..${workBranch}`], repoRoot);
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

  const localExists = exec.probe(
    "git",
    ["rev-parse", "--verify", "--quiet", `refs/heads/${workBranch}`],
    repoRoot,
  ).ok;
  if (localExists) {
    const co = exec.probe("git", ["checkout", workBranch], repoRoot);
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
    const remote = exec.remoteHasBranch(repoRoot, workBranch);
    if (remote === "unknown") {
      return {
        ok: false,
        error:
          `could not determine whether origin has '${workBranch}' (lookup failed); refusing to create a ` +
          `base-derived branch that could miss existing PR changes`,
      };
    }
    if (remote === "yes") {
      const fetched = exec.probe("git", ["fetch", "origin", workBranch], repoRoot);
      if (!fetched.ok) {
        return { ok: false, error: `git fetch origin ${workBranch} failed: ${fetched.output}` };
      }
      const co = exec.probe("git", ["checkout", "-B", workBranch, "FETCH_HEAD"], repoRoot);
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
    const fetched = exec.probe("git", ["fetch", "origin", depStartPoint], repoRoot);
    if (!fetched.ok) {
      return {
        ok: false,
        error:
          `git fetch origin ${depStartPoint} (dependency start point for '${workBranch}') failed: ${fetched.output}; ` +
          `refusing to create the branch from the base branch '${baseBranch}', which would miss the blocker's changes`,
      };
    }
    const create = exec.probe("git", ["checkout", "-b", workBranch, "FETCH_HEAD"], repoRoot);
    if (!create.ok) {
      return {
        ok: false,
        error: `git checkout -b ${workBranch} FETCH_HEAD (dependency start point) failed: ${create.output}`,
      };
    }
    return { ok: true, created: true, resumeSafe: false };
  }

  // Not dependency-started: create it from the configured base branch after
  // updating the base safely (fetch/ff-only pull when a remote exists).
  const coBase = exec.probe("git", ["checkout", baseBranch], repoRoot);
  if (!coBase.ok) return { ok: false, error: `git checkout ${baseBranch} failed: ${coBase.output}` };
  if (hasOrigin) {
    const pull = exec.probe("git", ["pull", "--ff-only"], repoRoot);
    if (!pull.ok) return { ok: false, error: `git pull --ff-only on ${baseBranch} failed: ${pull.output}` };
  }
  const create = exec.probe("git", ["checkout", "-b", workBranch, baseBranch], repoRoot);
  if (!create.ok) {
    return { ok: false, error: `git checkout -b ${workBranch} ${baseBranch} failed: ${create.output}` };
  }
  return { ok: true, created: true, resumeSafe: false };
}

// ---------------------------------------------------------------------------
// Result constructors
// ---------------------------------------------------------------------------

/**
 * A definite, effect-free refusal: the approved command provably did not run.
 *
 * Built as a literal rather than through `operationRejected` so the summary
 * keeps its full length — see the module header.
 */
function refuse(reason: OperationRejectionReason, summary: string): OperationResult {
  return { status: "rejected", reason, summary, effect: "none" };
}

/**
 * An indeterminate failure: the approved command already ran, so whatever went
 * wrong afterwards leaves side effects this operation cannot characterize.
 * Retry is unsafe; contract §9.2 keeps such a row `dispatching` for an operator.
 */
function failAfterExecution(summary: string): OperationResult {
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

// ---------------------------------------------------------------------------
// The core
// ---------------------------------------------------------------------------

/**
 * Execute one guided Tool Request run.
 *
 * Every rule the admin CLI handler enforced is enforced here, in the same order
 * and with the same messages; the only change is that an outcome is *returned*
 * rather than printed and exited.
 */
export async function runToolRequestRun(invocation: {
  request: ToolRequestRunRequest;
  context: ToolRequestRunContext;
}): Promise<OperationResult> {
  const { request, context } = invocation;
  const { session, tasks: store, outbox: outboxStore, exec, artifacts } = context;
  const sessionId = context.invocation.sessionId;
  const issueNumber = context.invocation.issueNumber;
  if (issueNumber === null) {
    return refuse("invalid-context", `${TOOL_REQUEST_RUN_OPERATION_ID} requires a work item in context.`);
  }
  // Preview is trusted context, never a parameter (contract §5.2). It maps onto
  // the CLI's long-standing `--dry-run`.
  const dryRun = !context.invocation.confirmed;
  const { command, ttlSeconds, maxUses, disposition, onChanges, confirmDiscard, allowUnexpected } = request;

  // The redesigned operator surface is the "guided run" (`tool-request run`,
  // issue #430); `tool-request grant` is retained as a deprecated alias. The two
  // share this engine but tag their operator-response record differently so the
  // continuation prompt reads naturally ("guided-run (changes committed)" vs the
  // legacy "grant"). The grant scope/hash authorization primitive is unchanged.
  const actionLabel = context.responseAction;

  const now = context.now();

  // Granted commands mutate the shared checkout, so they must respect the same
  // single-worker concurrency control as workflow executions. The lock is
  // acquired below (after validation, before the preflight) and held across the
  // preflight, command execution, and post-probe. Unlike the pre-#1029 handler —
  // which had to release it before every `die()`, since `process.exit` bypasses
  // `finally` — this core returns on every path, so one `finally` covers them all.
  let lockHeld = false;
  const releaseLock = (): void => {
    if (lockHeld) {
      context.repoLock.release(TOOL_REQUEST_RUN_LOCK_CONTEXT_ID, sessionId);
      lockHeld = false;
    }
  };

  try {
    const task = await store.getTask({ sessionId, issueNumber });
    if (!task) {
      return refuse("precondition-failed", `Task not found: session "${sessionId}", issue #${issueNumber}`);
    }

    const existing = readStoredToolRequest(task);
    if (!existing) {
      return refuse(
        "precondition-failed",
        `Issue #${issueNumber} in session "${sessionId}" has no Tool Request to grant.`,
      );
    }
    if (existing["resolved"] === true) {
      return refuse(
        "precondition-failed",
        `Tool Request for issue #${issueNumber} in session "${sessionId}" is already resolved.`,
      );
    }
    if (task.status === "claimed" || task.status === "running") {
      return refuse(
        "conflict",
        `Task #${issueNumber} in session "${sessionId}" is currently ${task.status}` +
          (task.ownerRunId ? ` (owner: ${task.ownerRunId})` : "") +
          `. Refusing to grant against an active task. Wait for it to complete or recover it first.`,
      );
    }

    const requestedCommand = typeof existing["command"] === "string" ? existing["command"].trim() : "";
    if (requestedCommand.length === 0) {
      return refuse(
        "precondition-failed",
        `Tool Request for issue #${issueNumber} has no recorded command to grant.`,
      );
    }

    // The granted command defaults to the exact requested command. Grants are
    // exact-command only (a non-goal of this feature is broad/wildcard approval),
    // so an operator-supplied --command must be the SAME command (ignoring only
    // insignificant whitespace) — never a different or broadened one.
    const grantedCommand = (command ?? requestedCommand).trim();
    if (grantedCommand.length === 0) {
      return refuse("invalid-request", `--command must not be empty.`);
    }
    if (normalizeCommand(grantedCommand) !== normalizeCommand(requestedCommand)) {
      return refuse(
        "invalid-request",
        `Grants are exact-command only: --command must equal the requested command for issue #${issueNumber}. ` +
          `Requested (redacted): \`${redactCommand(requestedCommand)}\`. ` +
          `If a different command is needed, reject this request and have the agent re-request it.`,
      );
    }

    // Issue #1154 (docs/changed-file-verification-contract.md §6 rule 2): with a
    // suite binding the test suite runs only through the stages — Stage 1's
    // changed and retained test files in the implementation lane, the full
    // suite after review approval. Executing it verbatim here would run the
    // whole suite before approval and, on the direct-review edge, have review
    // run Stage 1 and Stage 2 again. Refuse before anything touches the
    // repository (retry-safe, no effect); resolving the request requeues
    // implementation, whose Stage 1 runs the Issue's test files.
    const boundSuiteKey = toolRequestTestSuiteKey(
      session,
      task,
      grantedCommand,
      context.extractIssueVerificationCommands,
    );
    if (boundSuiteKey !== undefined) {
      return refuse(
        "precondition-failed",
        `Refusing to execute the guided command for issue #${issueNumber}: it runs the bound test suite ` +
          `\`${boundSuiteKey}\`, which staged verification runs only through Stage 1 (the Issue's changed and ` +
          `retained test files, in the implementation lane) and Stage 2 (the full suite, after review approval). ` +
          `Resolve this Tool Request instead (\`tool-request resolve --action manual-done\` or \`--action reject\`) ` +
          `so implementation requeues and its Stage 1 runs the tests.`,
      );
    }

    // Fail-closed: if the pre-request partial-diff capture failed during the
    // implementation handoff, the source edits that prompted this Tool Request
    // were NOT preserved on the issue branch or in a reappliable patch. Running
    // the command now would execute against old source, and requeueing would
    // cause the next implementation run to repeat the same edits and the same
    // Tool Request indefinitely — exactly the loop observed in issue #629.
    // The operator must recover the source edits (from any preserved branch or
    // run artifacts), apply them to the issue branch, and re-request the command.
    const pendingCaptureFailed =
      typeof existing["partialDiffCaptureFailed"] === "string"
        ? (existing["partialDiffCaptureFailed"] as string)
        : null;
    // A `partialDiffCaptureFailed` marker does not always mean the edits are
    // lost: new-impl and worktree handoffs commit and push the staged work to
    // `preservedBranch` even when the later diff/write step fails. When a
    // preserved branch exists the subsequent grant path will check out that
    // branch, so the command runs against the correct source. Only block when no
    // usable preserved branch exists and the patch-capture path would therefore
    // be the sole recovery mechanism.
    const preservedBranchForGrant =
      typeof existing["preservedBranch"] === "string" ? (existing["preservedBranch"] as string) : null;
    if (pendingCaptureFailed !== null && preservedBranchForGrant === null) {
      return refuse(
        "precondition-failed",
        `Refusing to execute the guided command for issue #${issueNumber}: the ` +
          `pre-request partial-diff capture failed during the implementation handoff, ` +
          `so the source edits that require this command were not preserved. Executing ` +
          `the command without them would run against old source and re-queuing would ` +
          `cause the next implementation to repeat the same work (issue #629).\n` +
          `Capture failure: ${pendingCaptureFailed.slice(0, 300)}\n` +
          `Recover the source edits from any preserved branch or run artifacts, apply ` +
          `them to the issue branch, then re-request the command.`,
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
            return refuse(
              "not-permitted",
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
        return {
          status: "failed",
          reason: "internal",
          effect: "none",
          summary: `Internal error: freshly created grant does not authorize the command (${auth.detail}).`,
        };
      }
    }

    // Take the repo lock before the preflight so the dirty-tree/base-ahead probes,
    // the command execution, and the post-probe all run as one critical section.
    // Refuse if another workflow execution for this session already holds it:
    // running a checkout-mutating command alongside an active worker would race
    // with its branch/dirty-tree operations and bypass single-worker concurrency.
    const acquired = context.repoLock.acquire(TOOL_REQUEST_RUN_LOCK_CONTEXT_ID, sessionId, now);
    if (!acquired.locked) {
      return refuse(
        "conflict",
        `Refusing to execute the granted command for issue #${issueNumber}: the repo lock for session ` +
          `'${sessionId}' is held by context '${acquired.ownerContextId}' (since ${acquired.ownerStartedAt}). ` +
          `A worker is active on this checkout; wait for it to finish, then re-run this grant.`,
      );
    }
    lockHeld = true;

    // Where the granted command and all its working-tree git operations run. The
    // implementation phase (issue #732) checks `ai/issue-<n>` out in its own
    // per-issue worktree UNCONDITIONALLY, and a Tool Request handoff committed the
    // partial work there, so the issue branch is ALREADY checked out away from the
    // canonical checkout. Running the grant in `session.repoRoot` would make
    // `moveToToolRequestBranch`'s `git checkout ai/issue-<n>` fail — git refuses to
    // check a branch out in two worktrees — and the command's side effects belong on
    // the issue branch beside the agent's edits, not the canonical tree (issue #454
    // review). The injected resolver returns the per-issue worktree whenever one is
    // actually registered for this issue, and the canonical checkout only when no
    // worktree entry exists yet (e.g. the run failed before Step 0.6 materialized one).
    const resolvedCwd = context.worktree.resolveRunCwd();
    if (!resolvedCwd.ok) {
      return refuse(
        "precondition-failed",
        `Refusing to execute the granted command for issue #${issueNumber}: the session enables per-issue ` +
          `worktrees but its worktree root is misconfigured: ${resolvedCwd.error}`,
      );
    }
    const grantRepoCwd = resolvedCwd.cwd;
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
    const statusProbe = exec.probe("git", ["status", "--porcelain"], grantRepoCwd);
    if (!dispositionRetry && statusProbe.ok && statusProbe.output.length > 0) {
      return refuse(
        "precondition-failed",
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
      const aheadProbe = exec.probe(
        "git",
        ["rev-list", "--count", `origin/${baseBranch}..${baseBranch}`],
        grantRepoCwd,
      );
      if (aheadProbe.ok) {
        const aheadCount = Number.parseInt(aheadProbe.output.trim(), 10);
        if (Number.isFinite(aheadCount) && aheadCount > 0) {
          // Never tell the operator to push the base branch: committing Tool Request
          // side effects to the base is exactly the error this guard prevents (issue
          // #316). Direct them to move the commits onto the issue branch, or drop them.
          return refuse(
            "precondition-failed",
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
      // A preview changes nothing, so it reports `effect: "none"` (contract §5.2).
      return completed(
        `Would guided-run the approved command for issue #${issueNumber} on branch ${workBranch}.`,
        {
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
        },
        "none",
      );
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
      exec,
      grantRepoCwd,
      workBranch,
      baseBranch,
      depStartPoint,
      fromRecordedPr,
    );
    if (!moved.ok) {
      return refuse(
        "precondition-failed",
        `Refusing to execute the granted command for issue #${issueNumber}: could not move the checkout ` +
          `to the issue branch '${workBranch}' (so the command never runs on the base branch '${baseBranch}'). ` +
          `${moved.error}`,
      );
    }
    // HEAD on the work branch before the command runs, so we can tell afterwards
    // whether the command committed onto the issue branch (clean tree but advanced
    // HEAD) versus left only uncommitted changes versus was a true no-op.
    const headBeforeProbe = exec.probe("git", ["rev-parse", "HEAD"], grantRepoCwd);
    // Base branch SHA before the command runs. The post-failure safety check
    // (issue #678 review) cannot rely solely on `origin/<base>..<base>` being 0:
    // a command that checks out the base, commits, pushes, then returns to the
    // issue branch leaves that ahead-count at 0 because origin now includes the
    // pushed commit, even though the base ref itself moved. Comparing against
    // this snapshot catches that case regardless of origin's sync state.
    // Captured by ref name, so it resolves correctly even though `grantRepoCwd`
    // is not currently checked out onto `baseBranch`.
    const baseShaBeforeProbe = exec.probe("git", ["rev-parse", baseBranch], grantRepoCwd);
    // Remote-tracking snapshot of the base branch before the command runs.
    // Captured unconditionally, including in worktree mode: a command can move
    // the remote base directly via a refspec push (e.g. `git push origin
    // ai/issue-<n>:main`) without ever checking out or moving the *local* base
    // branch, so it never needs the canonical checkout the worktree-mode skips
    // above assume. After such a push Git updates the local `origin/<base>`
    // tracking ref to match, while `origin/<base>..<base>` reads 0 (origin now
    // contains the pushed commit) and the local base SHA is untouched — missing
    // both existing safety checks entirely (issue #678 review). Comparing this
    // snapshot against the post-command ref catches it.
    const baseRemoteShaBeforeProbe = exec.probe("git", ["rev-parse", `origin/${baseBranch}`], grantRepoCwd);

    // Apply the preserved source-edit patch from the implementation handoff,
    // if one was captured (shared-checkout mode, issue #629).
    //
    // In shared-checkout mode the handoff restores the worktree to base and
    // deletes the issue branch after writing a patch; the source edits exist
    // ONLY in that patch. The command may depend on those edits (e.g.
    // `node gen-workbook.mjs` where gen-workbook.mjs was edited), so the patch
    // must be applied — and staged — BEFORE the command runs so the command sees
    // the edited source, and `--disposition commit` captures both source edits
    // and command output in a single commit on the issue branch (criterion 4,
    // issue #629).
    //
    // In worktree mode (`preservedBranch` is set) the WIP commit on the issue
    // branch already carries the source edits, so no patch application is needed.
    // A disposition-only retry skips the apply: the command already ran in the
    // prior attempt and the edits are on disk.
    // Hoist patchPath outside the dispositionRetry guard so the guided discard
    // path (P1) and classification path (P2) below can reference it (issue #629).
    const patchFilename =
      typeof existing["partialDiffArtifact"] === "string"
        ? (existing["partialDiffArtifact"] as string)
        : null;
    const handoffArtifactDir =
      typeof task.context["artifactDir"] === "string" ? (task.context["artifactDir"] as string) : null;
    const alreadyOnBranch = typeof existing["preservedBranch"] === "string";
    const patchPath =
      patchFilename !== null && handoffArtifactDir !== null && !alreadyOnBranch
        ? join(handoffArtifactDir, patchFilename)
        : null;
    // Files the patch staged — used to classify them as pre-existing/known (P2)
    // and to re-apply them after a discard removes command output (P1).
    let appliedPatchFiles: string[] = [];
    if (!dispositionRetry) {
      if (patchPath !== null) {
        if (!artifacts.fileExists(patchPath)) {
          return refuse(
            "precondition-failed",
            `Refusing to execute the guided command for issue #${issueNumber}: the ` +
              `preserved source-edits patch (${patchPath}) does not exist. ` +
              `Apply it manually before re-running this grant.`,
          );
        }
        const patched = exec.probe("git", ["apply", "--index", patchPath], grantRepoCwd);
        if (!patched.ok) {
          return refuse(
            "precondition-failed",
            `Refusing to execute the guided command for issue #${issueNumber}: ` +
              `'git apply --index' of the source-edits patch failed: ${patched.output.slice(0, 300)}. ` +
              `Apply the patch manually at ${patchPath} before re-running.`,
          );
        }
        // Record which files the patch staged so guided change handling can
        // treat them as known (not unexpected) and discard can re-apply them.
        const patchedNamesProbe = exec.probe("git", ["diff", "--cached", "--name-only"], grantRepoCwd);
        if (patchedNamesProbe.ok && patchedNamesProbe.output.length > 0) {
          appliedPatchFiles = patchedNamesProbe.output.split("\n").filter(Boolean);
        }
      }
    }

    // Execute the EXACT granted command — handler-owned, outside the agent tool
    // surface. Run it through a shell so the operator's approved command is
    // interpreted with normal shell semantics: leading environment assignments
    // (e.g. `NPM_TOKEN=... npm install`), operators like `&&`/`|`, and quoting all
    // behave as written. Tokenizing into an argv and running with execFileSync
    // would instead try to exec a binary literally named `NPM_TOKEN=...` or pass
    // `&&` as an argument, so the granted command would fail or behave differently
    // from the request the operator approved.
    const executedAt = context.now();
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
      : exec.run("/bin/sh", ["-c", grantedCommand], {
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
    const runId = context.runIdFor(now);
    const artifactDir = artifacts.dirFor(runId);
    try {
      artifacts.writeFile(
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
      const artifactStatus = exec.probe(
        "git",
        ["status", "--porcelain", "--", artifactDir],
        session.repoRoot,
      );
      if (artifactStatus.ok && artifactStatus.output.length > 0) {
        try {
          artifacts.removeDir(artifactDir);
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
      const afterProbe = exec.probe(
        "git",
        ["status", "--porcelain", "--", ".", `:(exclude)${session.artifactDir}`],
        grantRepoCwd,
      );
      const dirtyAfter = afterProbe.ok && afterProbe.output.length > 0;
      // Did the command commit onto the issue branch (clean tree but HEAD moved)?
      const headAfterProbe = exec.probe("git", ["rev-parse", "HEAD"], grantRepoCwd);
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
        const aheadAfterProbe = exec.probe(
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
      const currentBranchAfterProbe = exec.probe("git", ["rev-parse", "--abbrev-ref", "HEAD"], grantRepoCwd);
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
          return failAfterExecution(
            `Failed to record grant: ${result.code}` +
              (result.current ? ` (current status: ${result.current.status})` : ""),
          );
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
          idempotencyKey: makeOutboxKey(
            sessionId,
            issueNumber,
            runId,
            "gh:comment",
            "tool-request-grant",
            "success-off-branch-changes",
          ),
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

        return completed(
          `Guided run for issue #${issueNumber} succeeded but left changes off the issue branch ${workBranch}; not re-queued.`,
          {
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
          },
        );
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
        // Applied patch files are pre-existing known edits (preserved implementation
        // work from the handoff), not command output. Add them to the expected set so
        // classifyChangedFiles treats them as known rather than unexpected, preventing
        // a spurious "unexpected-files" refusal for the operator (issue #629 P2).
        const expectedFilesWithPatch =
          appliedPatchFiles.length > 0 ? [...expectedFiles, ...appliedPatchFiles] : expectedFiles;
        // Artifact files are local audit records, never issue work: keep them out
        // of any commit or discard. `.n8n-artifacts` is the conventional name; add
        // the session's configured artifact dir too when it lives inside the repo.
        const relArtifact = relative(session.repoRoot, session.artifactRoot);
        const artifactInsideRepo =
          relArtifact.length > 0 && !relArtifact.startsWith("..") && !isAbsolute(relArtifact);
        const ignoredPrefixes = [".n8n-artifacts"];
        if (artifactInsideRepo) ignoredPrefixes.push(relArtifact);

        // Re-read the porcelain status WITHOUT trimming: the probe helper returns
        // `stdout.trim()`, which strips the first line's leading status column
        // (e.g. ` M package.json` → `M package.json`) and would corrupt that
        // file's parsed path. The status columns are significant here, so parse
        // the raw output.
        const rawRead = exec.rawPorcelainStatus(grantRepoCwd);
        // Fall back to the (trimmed) probe output if the fresh read fails.
        const rawPorcelain = rawRead ?? (afterProbe.ok ? afterProbe.output : "");
        const changedFiles = parsePorcelainStatus(rawPorcelain);
        const classification = classifyChangedFiles(changedFiles, expectedFilesWithPatch, ignoredPrefixes);
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
        // append an event, and return. Keeps the task a human handoff unless a
        // `resolution` is supplied (reject), which closes the request.
        const finishGuided = async (
          changeOutcome: string,
          commentBody: string,
          extraEventData: Record<string, unknown>,
          resolution?: { action: "reject"; resolvedAt: string; message: string },
        ): Promise<OperationResult> => {
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
          const changeContext: Record<string, unknown> = {
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
            changeContext["toolRequest"] = { ...existing, resolved: true, resolution };
          }
          const result = await store.transitionTask(
            { sessionId, issueNumber },
            { status: task.status },
            { status: task.status, phase: task.phase, context: changeContext, now },
          );
          if (!result.ok) {
            return failAfterExecution(
              `Failed to record grant: ${result.code}` +
                (result.current ? ` (current status: ${result.current.status})` : ""),
            );
          }
          const body = sanitizeBody(commentBody, sessionRedactionPaths(session));
          await workItemStore.enqueue({
            idempotencyKey: makeOutboxKey(
              sessionId,
              issueNumber,
              runId,
              "gh:comment",
              "tool-request-grant",
              `changes-${changeOutcome}`,
            ),
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
          return completed(
            `Guided run for issue #${issueNumber}: produced changes ${changeOutcome} on branch ${workBranch}.`,
            {
              ok: true,
              sessionId,
              issueNumber,
              // Historically tagged `grant` on this path regardless of which
              // operator surface invoked it; preserved verbatim so the emitted
              // payload does not change (issue #1029).
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
            },
          );
        };

        if (!plan.ok) {
          // Refused plan: nothing changed on disk. Surface WHY (e.g. unexpected
          // files, missing confirmation, wrong branch) so the operator can correct
          // course. The request stays open.
          return await finishGuided(
            "refused",
            `🛠️ **Tool Request granted command executed by operator — changes need attention.**\n\n` +
              `Approved command: \`${displayCommand}\`\n\n` +
              `The command completed successfully and produced changes (${summary}) on the issue branch ` +
              `\`${workBranch}\`. The requested \`${onChanges}\` action was not applied: ${plan.reason}`,
            { refusalCode: plan.code },
          );
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
          // `git add`/`commit` failure must NOT short-circuit before `finishGuided`
          // records `consumedGrant`: that would leave the one-shot grant unconsumed
          // and re-issuable, letting the same command run again and duplicate its
          // side effects. Instead, persist the grant as consumed, leave the changes
          // in place for recovery, and surface the failure (no raw output in the
          // public comment).
          //
          // First reset the index to HEAD so nothing the granted command may have
          // pre-staged (e.g. `git add .n8n-artifacts/run.json`) survives into the
          // commit. Without this, those staged paths would be committed even though
          // `filesToStage` excludes them, violating the guarantee that artifacts and
          // unrelated dirty files are never committed. `git reset` is mixed by
          // default: it unstages without touching the working tree, so the changes
          // remain on disk for recovery.
          const unstaged = exec.run("git", ["reset", "--", "."], { cwd: grantRepoCwd });
          if (unstaged.exitCode !== 0) {
            return await finishGuided(
              "commit-failed",
              `🛠️ **Tool Request granted command executed by operator — commit failed.**\n\n` +
                `Approved command: \`${displayCommand}\`\n\n` +
                `The command completed successfully and produced changes (${summary}) on the issue branch ` +
                `\`${workBranch}\`, but preparing them for commit failed. The changes are left in place for ` +
                `recovery; commit and push \`${workBranch}\` manually, then run ` +
                `\`tool-request resolve --action manual-done\` to re-queue.`,
              { committed: false, commitFailed: true, failedStep: "unstage" },
            );
          }
          const added = exec.run("git", ["add", "--", ...filesToStage], { cwd: grantRepoCwd });
          if (added.exitCode !== 0) {
            return await finishGuided(
              "commit-failed",
              `🛠️ **Tool Request granted command executed by operator — commit failed.**\n\n` +
                `Approved command: \`${displayCommand}\`\n\n` +
                `The command completed successfully and produced changes (${summary}) on the issue branch ` +
                `\`${workBranch}\`, but staging them for commit failed. The changes are left in place for ` +
                `recovery; commit and push \`${workBranch}\` manually, then run ` +
                `\`tool-request resolve --action manual-done\` to re-queue.`,
              { committed: false, commitFailed: true, failedStep: "stage" },
            );
          }
          const commitMsg = `chore: apply Tool Request command output for issue #${issueNumber}`;
          const committed = exec.run("git", ["commit", "--no-verify", "-m", commitMsg], { cwd: grantRepoCwd });
          if (committed.exitCode !== 0) {
            return await finishGuided(
              "commit-failed",
              `🛠️ **Tool Request granted command executed by operator — commit failed.**\n\n` +
                `Approved command: \`${displayCommand}\`\n\n` +
                `The command completed successfully and produced changes (${summary}) on the issue branch ` +
                `\`${workBranch}\`, but committing them failed. The changes are left staged in place for ` +
                `recovery; commit and push \`${workBranch}\` manually, then run ` +
                `\`tool-request resolve --action manual-done\` to re-queue.`,
              { committed: false, commitFailed: true, failedStep: "commit" },
            );
          }
          // Push best-effort. On failure the commit is kept locally on the issue
          // branch so the operator can recover — never reset/discard it.
          const pushed = exec.run("git", ["push", "origin", workBranch], { cwd: grantRepoCwd });
          const pushFailed = pushed.exitCode !== 0;
          if (pushFailed) {
            return await finishGuided(
              "committed-push-failed",
              `🛠️ **Tool Request granted command executed by operator — committed, push failed.**\n\n` +
                `Approved command: \`${displayCommand}\`\n\n` +
                `The command's expected changes (${summary}) were committed to the issue branch ` +
                `\`${workBranch}\`, but pushing to origin failed. The commit is kept locally for recovery. ` +
                `Push \`${workBranch}\` to origin, then run \`tool-request resolve --action manual-done\` ` +
                `to re-queue.`,
              { pushed: false },
            );
          }
          return await finishGuided(
            "committed",
            `✅ **Tool Request granted command executed by operator — changes committed.**\n\n` +
              `Approved command: \`${displayCommand}\`\n\n` +
              `The command's expected changes (${summary}) were committed to the issue branch ` +
              `\`${workBranch}\` and pushed to origin. Run \`tool-request resolve --action manual-done\` ` +
              `to re-queue for implementation.`,
            { pushed: true },
          );
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
              ? exec.run("git", ["reset", "-q", "--", ...artifactPaths], { cwd: grantRepoCwd })
              : ({ exitCode: 0, stdout: "", stderr: "" } as CommandRunResult);
          const reset =
            unstagedArtifacts.exitCode === 0
              ? exec.run("git", ["reset", "--hard", "HEAD"], { cwd: grantRepoCwd })
              : unstagedArtifacts;
          const cleanArgs = ["clean", "-fd"];
          for (const prefix of ignoredPrefixes) cleanArgs.push("-e", prefix);
          // Only attempt the untracked-file clean if the reset succeeded.
          const cleaned =
            reset.exitCode === 0 ? exec.run("git", cleanArgs, { cwd: grantRepoCwd }) : undefined;
          if (reset.exitCode !== 0 || (cleaned !== undefined && cleaned.exitCode !== 0)) {
            // Fail closed: a failed reset/clean means generated changes may remain,
            // so do NOT claim the branch is clean. The command already ran, so still
            // record the grant as consumed (one-shot) — but report the failure and
            // leave recovery to the operator.
            return await finishGuided(
              "discard-failed",
              `🛠️ **Tool Request granted command executed by operator — discard failed.**\n\n` +
                `Approved command: \`${displayCommand}\`\n\n` +
                `The command produced changes (${summary}) on the issue branch \`${workBranch}\`, but ` +
                `discarding them failed and the working tree may still contain changes. Inspect and clean ` +
                `\`${workBranch}\` manually before re-requesting or rejecting this Tool Request.`,
              { discarded: false, discardFailed: true },
            );
          }
          // Command output was discarded. Now restore the pre-command source edits
          // from the implementation patch so they survive the discard and are present
          // for the next implementation run (issue #629 P1).
          let sourceEditsCommitted = false;
          if (patchPath !== null && artifacts.fileExists(patchPath)) {
            const reapplied = exec.probe("git", ["apply", "--index", patchPath], grantRepoCwd);
            if (!reapplied.ok) {
              return await finishGuided(
                "discard-failed",
                `🛠️ **Tool Request granted command executed by operator — discard failed.**\n\n` +
                  `Approved command: \`${displayCommand}\`\n\n` +
                  `The command's generated changes were removed from the issue branch \`${workBranch}\`, but ` +
                  `restoring the preserved source edits (implementation patch) afterwards failed. The tree is ` +
                  `clean but the source edits are missing. Apply the patch manually before re-requesting this ` +
                  `Tool Request.`,
                { discarded: false, discardFailed: true, failedStep: "patch-reapply" },
              );
            }
            // Commit the restored edits so the branch is left clean — staged changes
            // block the next resolution or implementation preflight (issue #629 P1).
            const patchCommitted = exec.run(
              "git",
              [
                "commit",
                "--no-verify",
                "-m",
                `chore: restore source edits for issue #${issueNumber} before Tool Request discard`,
              ],
              { cwd: grantRepoCwd },
            );
            if (patchCommitted.exitCode !== 0) {
              return await finishGuided(
                "discard-failed",
                `🛠️ **Tool Request granted command executed by operator — discard failed.**\n\n` +
                  `Approved command: \`${displayCommand}\`\n\n` +
                  `The command's generated changes were removed from the issue branch \`${workBranch}\` and ` +
                  `the preserved source edits were re-applied, but committing them failed. Commit the staged ` +
                  `source edits and push \`${workBranch}\` manually before re-requesting this Tool Request.`,
                { discarded: false, discardFailed: true, failedStep: "patch-commit" },
              );
            }
            const patchPushed = exec.run("git", ["push", "origin", workBranch], { cwd: grantRepoCwd });
            if (patchPushed.exitCode !== 0) {
              return await finishGuided(
                "discard-failed",
                `🛠️ **Tool Request granted command executed by operator — discard failed.**\n\n` +
                  `Approved command: \`${displayCommand}\`\n\n` +
                  `The command's generated changes were removed from the issue branch \`${workBranch}\`, ` +
                  `the preserved source edits were committed, but pushing to origin failed. Push ` +
                  `\`${workBranch}\` manually before re-requesting this Tool Request.`,
                { discarded: false, discardFailed: true, failedStep: "patch-push" },
              );
            }
            sourceEditsCommitted = true;
          }
          return await finishGuided(
            "discarded",
            `🗑️ **Tool Request granted command executed by operator — changes discarded.**\n\n` +
              `Approved command: \`${displayCommand}\`\n\n` +
              `The command's generated changes (${summary}) were discarded` +
              (sourceEditsCommitted
                ? ` and the preserved source edits were committed to the issue branch \`${workBranch}\`.`
                : `. The issue branch \`${workBranch}\` is clean again.`) +
              ` Re-request or reject this Tool Request as appropriate.`,
            {},
          );
        }

        if (onChanges === "reject") {
          // Close the request as rejected and leave the changes in place for the
          // operator to handle. Mirrors `tool-request resolve --action reject`:
          // the task stays a human handoff and is not re-queued.
          return await finishGuided(
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
        }

        if (onChanges === "abort") {
          return await finishGuided(
            "aborted",
            `⏸️ **Tool Request granted command executed by operator — no further action.**\n\n` +
              `Approved command: \`${displayCommand}\`\n\n` +
              `The command ran and produced changes (${summary}) on the issue branch \`${workBranch}\`. ` +
              `No commit, push, or discard was performed; the changes are left exactly as the command ` +
              `produced them.`,
            {},
          );
        }

        // keep: leave the changes on the issue branch, explicitly recorded.
        return await finishGuided(
          "kept",
          `📌 **Tool Request granted command executed by operator — changes kept.**\n\n` +
            `Approved command: \`${displayCommand}\`\n\n` +
            `The command's changes (${summary}) were kept on the issue branch \`${workBranch}\`. ` +
            `Commit and push them there (never the base branch \`${baseBranch}\`), then run ` +
            `\`tool-request resolve --action manual-done\` to re-queue from a clean tree.`,
          {},
        );
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
          const failAfterRecordingConsumedGrant = async (message: string): Promise<OperationResult> => {
            await store.transitionTask(
              { sessionId, issueNumber },
              { status: task.status },
              { status: task.status, phase: task.phase, context: { toolRequestGrant: consumedGrant }, now },
            );
            return failAfterExecution(message);
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
            const added = exec.probe("git", ["add", "-A"], grantRepoCwd);
            if (!added.ok) {
              return await failAfterRecordingConsumedGrant(
                `Refusing to commit the guided-run changes for issue #${issueNumber}: 'git add -A' failed ` +
                  `in ${grantRepoCwd}: ${added.output}`,
              );
            }
            exec.probe("git", ["reset", "-q", "--", session.artifactDir], grantRepoCwd);
            const committed = exec.probe(
              "git",
              ["commit", "--no-verify", "-m", `Tool Request guided run: ${displayCommand}`],
              grantRepoCwd,
            );
            if (!committed.ok) {
              return await failAfterRecordingConsumedGrant(
                `Refusing to requeue issue #${issueNumber}: 'git commit' of the guided-run changes failed ` +
                  `in ${grantRepoCwd}: ${committed.output}`,
              );
            }
          }
          // Push so the committed side effects survive a later Tool Request
          // handoff's `git branch -D`, mirroring the manual-done resume-branch
          // contract (issue #316). When no origin is configured there is nothing
          // to push to; the local branch is then the resume point as-is.
          const hasOrigin = exec.probe("git", ["remote", "get-url", "origin"], grantRepoCwd).ok;
          if (hasOrigin) {
            const pushed = exec.probe("git", ["push", "origin", workBranch], grantRepoCwd);
            if (!pushed.ok) {
              return await failAfterRecordingConsumedGrant(
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
              context: {
                toolRequest: resolvedToolRequest,
                toolRequestGrant: consumedGrant,
                toolRequestResumeBranch: workBranch,
              },
              now,
            },
          );
          if (!result.ok) {
            return failAfterExecution(
              `Failed to record guided run: ${result.code}` +
                (result.current ? ` (current status: ${result.current.status})` : ""),
            );
          }

          // Relabel back into the implementation lane (mirrors the no-op success
          // path and manual-done).
          const readyForHumanLabel = session.labels["readyForHuman"] as string | undefined;
          const isFixModeRequest =
            existing["mode"] === "fix" ||
            (typeof task.context["reviewFeedback"] === "string" &&
              (task.context["reviewFeedback"] as string).trim().length > 0);
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
            idempotencyKey: makeOutboxKey(
              sessionId,
              issueNumber,
              runId,
              "gh:comment",
              "tool-request-grant",
              "success-committed",
            ),
            topic: "gh:comment",
            payload: { topic: "gh:comment", owner, repo, issueNumber, body: commentBody },
            now,
          });

          await store.appendEvent({
            task: { sessionId, issueNumber },
            type: "tool_request_grant_executed",
            runId,
            message: `Operator guided run for issue #${issueNumber} committed changes on ${workBranch} (exit 0)`,
            data: {
              exitCode: 0,
              success: true,
              commandHash: grant.commandHash,
              requeued: true,
              disposition: "committed",
              branch: workBranch,
              grantedBy: grant.grantedBy,
            },
            createdAt: now,
          });

          return completed(
            `Guided run for issue #${issueNumber} committed its changes on ${workBranch} and re-queued for implementation.`,
            {
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
            },
          );
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
          let sourceEditsCommitted2 = false;
          if (headBeforeProbe.ok) {
            // Stage all produced changes, then unstage the session artifact
            // directory so the snapshot diff is a faithful partial-diff of just
            // the command's produced changes, never the local run artifact (which
            // embeds the exact command + full output) when the repo does not
            // ignore it. The plain `git add -A` captures the changes regardless of
            // ignore rules; the follow-up `git reset` drops the artifact dir from
            // the index (a silent no-op when it is gitignored and never staged).
            const staged = exec.probe("git", ["add", "-A"], grantRepoCwd);
            if (staged.ok) {
              exec.probe("git", ["reset", "-q", "--", session.artifactDir], grantRepoCwd);
              const diff = exec.probe("git", ["diff", "--cached", headBeforeProbe.output], grantRepoCwd);
              if (diff.ok && diff.output.length > 0) {
                try {
                  artifacts.writeFile(join(artifactDir, "discarded-changes.patch"), diff.output);
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
            const resetProbe = exec.probe("git", ["reset", "--hard", headBeforeProbe.output], grantRepoCwd);
            // Exclude the session artifact directory from the sweep: the
            // `discarded-changes.patch` snapshot above lives under it, and when
            // the repo does not gitignore that directory `git clean -fd` would
            // delete the snapshot we just wrote — reporting `discardPatch` while
            // the partial-diff safeguard is silently lost.
            const cleanProbe = exec.probe(
              "git",
              ["clean", "-fd", `--exclude=/${session.artifactDir}`],
              grantRepoCwd,
            );
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
            const verifyProbe = exec.probe(
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
              return failAfterExecution(
                `Refusing to record discard for issue #${issueNumber}: the approved command's changes could ` +
                  `not be fully reverted on branch ${workBranch}. The grant was NOT consumed and remains ` +
                  `available. Manually restore the checkout to its pre-run state ` +
                  `(${headBeforeProbe.output}) before retrying.\n${reasons.join("\n")}`,
              );
            }
            // Command output was discarded. Now restore the pre-command source edits
            // from the implementation patch so they survive the discard and are
            // present for the next implementation run (issue #629 P1).
            if (patchPath !== null && artifacts.fileExists(patchPath)) {
              const reapplied = exec.probe("git", ["apply", "--index", patchPath], grantRepoCwd);
              if (!reapplied.ok) {
                return failAfterExecution(
                  `Refusing to record discard for issue #${issueNumber}: the command's changes were ` +
                    `reverted on branch ${workBranch} but re-applying the preserved source-edits patch ` +
                    `afterwards failed. The tree is clean but the source edits are missing. ` +
                    `The grant was NOT consumed and remains available. Apply the patch manually ` +
                    `before retrying.`,
                );
              }
              // Commit the restored edits so the branch is left clean — staged changes
              // block the next resolution or implementation preflight (issue #629 P1).
              const patchCommitted = exec.probe(
                "git",
                [
                  "commit",
                  "--no-verify",
                  "-m",
                  `chore: restore source edits for issue #${issueNumber} before Tool Request discard`,
                ],
                grantRepoCwd,
              );
              if (!patchCommitted.ok) {
                return failAfterExecution(
                  `Refusing to record discard for issue #${issueNumber}: the command's changes were ` +
                    `reverted on branch ${workBranch}, the source-edits patch was re-applied, but ` +
                    `committing the restored edits failed. Commit the staged source edits and push ` +
                    `\`${workBranch}\` manually before retrying.`,
                );
              }
              const patchPushed = exec.probe("git", ["push", "origin", workBranch], grantRepoCwd);
              if (!patchPushed.ok) {
                return failAfterExecution(
                  `Refusing to record discard for issue #${issueNumber}: the source-edits patch was ` +
                    `re-applied and committed on branch ${workBranch}, but pushing to origin failed. ` +
                    `Push \`${workBranch}\` manually before retrying.`,
                );
              }
              sourceEditsCommitted2 = true;
            }
          } else {
            // No known-good pre-run revision to revert to, and nothing was
            // reverted — the command's changes are still in the checkout. Fail
            // closed rather than claim a discard that did not happen (issue #430
            // review). The grant stays unconsumed so the operator can retry once
            // the tree is restored manually.
            return failAfterExecution(
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
            return failAfterExecution(
              `Failed to record guided run: ${result.code}` +
                (result.current ? ` (current status: ${result.current.status})` : ""),
            );
          }

          let commentBody =
            `↩️ **Tool Request guided run changes discarded by operator.**\n\n` +
            `Approved command: \`${displayCommand}\`\n\n` +
            `The command ran successfully but the operator discarded the changes it produced; the issue ` +
            `branch \`${workBranch}\` was reverted to its pre-run state` +
            (sourceEditsCommitted2 ? ` and the preserved source edits were committed to the branch` : ``) +
            `. The task remains a human handoff.`;
          commentBody = sanitizeBody(commentBody, sessionRedactionPaths(session));
          await workItemStore.enqueue({
            idempotencyKey: makeOutboxKey(
              sessionId,
              issueNumber,
              runId2,
              "gh:comment",
              "tool-request-grant",
              "success-discarded",
            ),
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

          return completed(
            `Guided run for issue #${issueNumber} discarded the changes it produced on ${workBranch}.`,
            {
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
            },
          );
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
          return failAfterExecution(
            `Failed to record grant: ${result.code}` +
              (result.current ? ` (current status: ${result.current.status})` : ""),
          );
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
          idempotencyKey: makeOutboxKey(
            sessionId,
            issueNumber,
            runId,
            "gh:comment",
            "tool-request-grant",
            "success-branch-changes",
          ),
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

        return completed(
          `Guided run for issue #${issueNumber} left its changes on ${workBranch} for the operator to land.`,
          {
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
          },
        );
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
          return failAfterExecution(
            `Failed to record grant: ${result.code}` +
              (result.current ? ` (current status: ${result.current.status})` : ""),
          );
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
          idempotencyKey: makeOutboxKey(
            sessionId,
            issueNumber,
            runId,
            "gh:comment",
            "tool-request-grant",
            "success-base-ahead",
          ),
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

        return completed(
          `Guided run for issue #${issueNumber} advanced the local base branch ${baseBranch}; not re-queued.`,
          {
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
          },
        );
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
          exec.probe("git", ["checkout", baseBranch], session.repoRoot);
          if (moved.created) {
            exec.probe("git", ["branch", "-D", workBranch], session.repoRoot);
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
            const pushed = exec.probe("git", ["push", "origin", workBranch], grantRepoCwd);
            worktreeResumePushed = pushed.ok && exec.remoteHasBranch(grantRepoCwd, workBranch) === "yes";
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

        // ── CONTINUATION ROUTING (issue #722) ────────────────────────────────
        // `docs/unattended-tool-request-contract.md` rows 26–27: a resolution
        // that left the task re-queueable goes to `implementation` — UNLESS
        // `docs/verification-execution-contract.md` §10's evidence gate holds,
        // in which case it goes straight to `review` and the no-op
        // implementation pass (#404's survivable detour) is skipped entirely.
        // All of the policy is the pure core helper's; everything here is
        // evidence collection. Only this true-no-op path is a candidate: a
        // guided run that produced repository changes is out of scope for #722
        // even when its disposition later left the tree clean.
        //
        // Always write `toolRequestResumeBranch` so applyTaskPatch's context
        // merge does not preserve a stale resume branch from an earlier Tool
        // Request; JSON.stringify drops the undefined value, removing the key
        // (matches manual-done; issue #316).
        const continuationContext: Record<string, unknown> = {
          toolRequest: resolvedToolRequest,
          toolRequestGrant: consumedGrant,
          toolRequestResumeBranch,
        };
        // Previewed so the review-admission check and the decision read exactly
        // the state the transition below is about to persist — in particular a
        // Tool Request that this resolution has just closed.
        const continuationPreview = applyTaskPatch(task, { context: continuationContext, now });

        // Eligibility first (#918 §10.2): a command no `session.verification`
        // value covers is never direct-reviewed, so the repository probes below
        // are skipped for it. The decision helper evaluates its checks in a
        // fixed order, so an unprobed field can never change the recorded
        // reason — the eligibility miss is reported before any of them is read.
        const configuredVerification = resolveConfiguredVerification(grantedCommand, session.verification);
        const { base: recordedReviewBase, missing: reviewBaseMissing } = resolveDependencyReviewBase(
          task.context,
        );
        let worktreeCleanAfterRun: boolean | undefined;
        let issueBranchLocalSha: string | undefined;
        let issueBranchRemoteSha: string | undefined;
        let commitsSinceReviewBase: number | undefined;
        if (configuredVerification !== undefined) {
          // Clean worktree AFTER disposition handling and the artifact cleanup
          // above, using the same plain porcelain the implementation preflight
          // uses — never the `:(exclude)` relaxation the dirtiness probe needs.
          const cleanProbe = exec.probe("git", ["status", "--porcelain"], grantRepoCwd);
          worktreeCleanAfterRun = cleanProbe.ok ? cleanProbe.output.length === 0 : undefined;
          // Read the BRANCH ref rather than HEAD: the shared-checkout tidy-up
          // above may have moved HEAD back to the base branch, and an invented
          // branch it deleted simply fails to resolve here (fail closed).
          const localShaProbe = exec.probe(
            "git",
            ["rev-parse", "--verify", `refs/heads/${workBranch}`],
            grantRepoCwd,
          );
          const localSha = localShaProbe.ok ? localShaProbe.output.trim() : "";
          issueBranchLocalSha = /^[0-9a-f]{7,64}$/.test(localSha) ? localSha : undefined;
          // Origin's own view of the branch, read straight from the remote so a
          // stale remote-tracking ref can never stand in for an actual push.
          const lsRemoteProbe = exec.probe("git", ["ls-remote", "--heads", "origin", workBranch], grantRepoCwd);
          if (lsRemoteProbe.ok) {
            const remoteSha = ((lsRemoteProbe.output.split("\n")[0] ?? "").trim().split(/\s+/)[0] ?? "").trim();
            issueBranchRemoteSha = /^[0-9a-f]{7,64}$/.test(remoteSha) ? remoteSha : undefined;
          }
          // Committed issue work relative to the RECORDED review base: the
          // predecessor head for a dependency-started task (#667, #681 check 4),
          // else the session base branch on origin.
          if (issueBranchLocalSha !== undefined) {
            const reviewBaseRef = recordedReviewBase?.sha ?? `origin/${baseBranch}`;
            const countProbe = exec.probe(
              "git",
              ["rev-list", "--count", `${reviewBaseRef}..refs/heads/${workBranch}`],
              grantRepoCwd,
            );
            if (countProbe.ok) {
              const parsedCount = Number.parseInt(countProbe.output.trim(), 10);
              if (Number.isFinite(parsedCount)) commitsSinceReviewBase = parsedCount;
            }
          }
        }

        // The existing #681 admission contract decides admissibility; #722 never
        // weakens it and adds no verification evidence to it (#918 §10.3 step 4).
        const continuationAdmission = checkReviewAdmission(continuationPreview);
        const { prUrl: recordedPrUrlForContinuation } = resolvePrContext(task);
        const recordedPrNumber =
          recordedPrUrlForContinuation !== undefined
            ? extractPrNumber(recordedPrUrlForContinuation)
            : undefined;
        const continuationDecision = decideToolRequestContinuation({
          guidedRun: {
            exitCode: runResult.exitCode,
            command: grantedCommand,
            disposition: resolution.disposition,
            producedChanges,
          },
          verificationCommands: session.verification,
          phase: task.phase,
          toolRequestUnresolved: hasUnresolvedToolRequest(continuationPreview.context),
          pendingMarkers: collectPendingImplementationMarkers(task.context, {
            preservedPatchPending: patchPath !== null,
          }),
          repository: {
            worktreeClean: worktreeCleanAfterRun,
            branch: workBranch,
            localHeadSha: issueBranchLocalSha,
            remoteHeadSha: issueBranchRemoteSha,
            commitsSinceReviewBase,
          },
          durableContext: {
            prRecorded: recordedPrNumber !== undefined && recordedPrNumber > 0,
            prHeadBranch: recordedPrBranch,
            reviewBaseRecorded: !reviewBaseMissing,
          },
          reviewAdmitted: continuationAdmission.ok,
        });
        const continuationRecord = buildToolRequestContinuationRecord(continuationDecision, actionLabel, now);
        // Durable on BOTH routes: the selected phase, the stable reason code,
        // and the bounded evidence summary (#919 §10.2).
        continuationContext["toolRequestContinuation"] = continuationRecord;

        if (continuationDecision.phase === "review") {
          // Direct review (#919 row 26 / #918 §10.3 step 4): the exact
          // `{queued, review}` vocabulary the shipped implementation→review
          // success edge uses, with the normal implementation→review label
          // effects. Transition and effects commit in ONE transaction so a
          // maintenance lock (or any other failure) takes both or neither and
          // the operator command stays safely repeatable.
          const reviewPatch: TaskPatch = {
            status: "queued",
            phase: "review",
            ownerRunId: undefined,
            leaseExpiresAt: undefined,
            lastError: undefined,
            // Branch, PR, review-base and every other implementation-complete
            // key survive untouched: the patch only merges the resolution,
            // the consumed grant, the resume point, and the decision record.
            context: continuationContext,
            now,
          };
          const reviewPreview = applyTaskPatch(task, reviewPatch);
          const effects = new OutboxEffectCollector();
          await enqueueStatusLabelEffects(
            effects,
            session,
            reviewPreview,
            "queued",
            "review",
            runId,
            now,
            "implementation",
            {
              result: "success",
              context: {
                branch: workBranch,
                ...(recordedPrUrlForContinuation !== undefined
                  ? { prUrl: recordedPrUrlForContinuation }
                  : {}),
              },
            },
          );
          // `queued` has no coarse-label entry, so the shared helper never drops
          // the ready-for-human marker this park left on the issue; remove it
          // explicitly, exactly as the implementation requeue below does.
          const reviewEffectStore = workItemOutbox(effects, session);
          const readyForHumanOnReview = session.labels["readyForHuman"] as string | undefined;
          if (readyForHumanOnReview) {
            await reviewEffectStore.enqueue({
              idempotencyKey: makeOutboxKey(
                sessionId,
                issueNumber,
                runId,
                "gh:label:remove",
                readyForHumanOnReview,
              ),
              topic: "gh:label:remove",
              payload: {
                topic: "gh:label:remove",
                owner,
                repo,
                issueNumber,
                label: readyForHumanOnReview,
              },
              now,
            });
          }

          // Public surface stays bounded and redacted: the display command and
          // the high-level outcome only — never output, paths, or evidence
          // detail beyond the branch already named by every other comment here.
          let reviewCommentBody =
            `✅ **Tool Request guided run completed — queued for review.**\n\n` +
            `Approved command: \`${displayCommand}\`\n\n` +
            `The command is a configured verification command and completed successfully; the issue branch ` +
            `\`${workBranch}\` is pushed with its work committed and no changes left behind, so the task was ` +
            `queued directly for review instead of another implementation pass.`;
          reviewCommentBody = sanitizeBody(reviewCommentBody, sessionRedactionPaths(session));
          await reviewEffectStore.enqueue({
            idempotencyKey: makeOutboxKey(
              sessionId,
              issueNumber,
              runId,
              "gh:comment",
              "tool-request-grant",
              "success-review",
            ),
            topic: "gh:comment",
            payload: { topic: "gh:comment", owner, repo, issueNumber, body: reviewCommentBody },
            now,
          });

          const reviewResult = await store.transitionTaskWithEffects(
            { sessionId, issueNumber },
            { status: task.status },
            reviewPatch,
            effects.effects,
          );
          if (!reviewResult.ok) {
            return failAfterExecution(
              `Failed to record guided run: ${reviewResult.code}` +
                (reviewResult.current ? ` (current status: ${reviewResult.current.status})` : ""),
            );
          }

          await store.appendEvent({
            task: { sessionId, issueNumber },
            type: "tool_request_grant_executed",
            runId,
            message: `Operator granted and executed Tool Request command for issue #${issueNumber} (exit 0, queued for review)`,
            data: {
              exitCode: 0,
              success: true,
              commandHash: grant.commandHash,
              requeued: true,
              dirtyAfter: false,
              branch: workBranch,
              continuationPhase: "review",
              grantedBy: grant.grantedBy,
            },
            createdAt: now,
          });
          await store.appendEvent({
            task: { sessionId, issueNumber },
            type: "tool_request_continuation_routed",
            runId,
            message: `Tool Request continuation for issue #${issueNumber} routed to review (${continuationDecision.reason})`,
            data: {
              destination: continuationRecord.destination,
              reason: continuationRecord.reason,
              surface: continuationRecord.surface,
              resolutionAction: actionLabel,
              evidence: continuationRecord.evidence,
            },
            createdAt: now,
          });

          return completed(
            `Guided run for issue #${issueNumber} completed with no changes and was queued directly for review.`,
            {
              ok: true,
              sessionId,
              issueNumber,
              action: actionLabel,
              executed: true,
              exitCode: 0,
              success: true,
              status: reviewResult.value.status,
              phase: reviewResult.value.phase,
              requeued: true,
              dirtyAfter: false,
              branch: workBranch,
              commandHash: grant.commandHash,
              continuation: {
                destination: continuationRecord.destination,
                reason: continuationRecord.reason,
              },
            },
          );
        }

        const result = await store.transitionTask(
          { sessionId, issueNumber },
          { status: task.status },
          {
            status: "queued",
            phase: "implementation",
            ownerRunId: undefined,
            leaseExpiresAt: undefined,
            lastError: undefined,
            context: continuationContext,
            now,
          },
        );
        if (!result.ok) {
          return failAfterExecution(
            `Failed to record grant: ${result.code}` +
              (result.current ? ` (current status: ${result.current.status})` : ""),
          );
        }

        // Swap public labels back to the implementation lane (mirrors tool-request
        // resolve manual-done): drop ready-for-human, re-advertise the queue status
        // (needs-fix for a fix-mode request, else needs-implementation) + the
        // resolved implementation agent.
        const readyForHumanLabel = session.labels["readyForHuman"] as string | undefined;
        const isFixModeRequest =
          existing["mode"] === "fix" ||
          (typeof task.context["reviewFeedback"] === "string" &&
            (task.context["reviewFeedback"] as string).trim().length > 0);
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
          idempotencyKey: makeOutboxKey(
            sessionId,
            issueNumber,
            runId,
            "gh:comment",
            "tool-request-grant",
            "success",
          ),
          topic: "gh:comment",
          payload: { topic: "gh:comment", owner, repo, issueNumber, body: commentBody },
          now,
        });

        await store.appendEvent({
          task: { sessionId, issueNumber },
          type: "tool_request_grant_executed",
          runId,
          message: `Operator granted and executed Tool Request command for issue #${issueNumber} (exit 0)`,
          data: {
            exitCode: 0,
            success: true,
            commandHash: grant.commandHash,
            requeued: true,
            dirtyAfter: false,
            branch: workBranch,
            grantedBy: grant.grantedBy,
          },
          createdAt: now,
        });

        // The same routing event the direct-review branch records, naming the
        // check that sent this resolution back to implementation (#919 §10.2).
        await store.appendEvent({
          task: { sessionId, issueNumber },
          type: "tool_request_continuation_routed",
          runId,
          message: `Tool Request continuation for issue #${issueNumber} routed to implementation (${continuationDecision.reason})`,
          data: {
            destination: continuationRecord.destination,
            reason: continuationRecord.reason,
            surface: continuationRecord.surface,
            resolutionAction: actionLabel,
            evidence: continuationRecord.evidence,
          },
          createdAt: now,
        });

        return completed(
          `Guided run for issue #${issueNumber} completed with no changes and was re-queued for implementation.`,
          {
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
            continuation: {
              destination: continuationRecord.destination,
              reason: continuationRecord.reason,
            },
          },
        );
      }
    }

    // FAILURE: a non-zero exit is diagnostic information for the implementation
    // agent, not by itself a reason to stop at a human handoff (issue #678) — the
    // motivating case is a verification command (e.g. `npm test`) that fails
    // without touching any files. Whether the failure can be delivered
    // automatically depends on what it left behind: a clean tree, with HEAD
    // unmoved and still on the issue branch, means nothing is at risk, so the
    // captured output is folded into the resolution and the task is re-queued
    // exactly like a true no-op. When the command left changes behind, requeueing
    // immediately would fail the implementation preflight's dirty-tree check —
    // repository state genuinely cannot be preserved safely, so that case stays a
    // human handoff, unchanged from before.
    const afterFailureProbe = exec.probe(
      "git",
      ["status", "--porcelain", "--", ".", `:(exclude)${session.artifactDir}`],
      grantRepoCwd,
    );
    const dirtyAfterFailure = afterFailureProbe.ok && afterFailureProbe.output.length > 0;
    const headAfterFailureProbe = exec.probe("git", ["rev-parse", "HEAD"], grantRepoCwd);
    const committedOnBranchAfterFailure =
      headBeforeProbe.ok &&
      headAfterFailureProbe.ok &&
      headBeforeProbe.output !== headAfterFailureProbe.output;
    const currentBranchAfterFailureProbe = exec.probe(
      "git",
      ["rev-parse", "--abbrev-ref", "HEAD"],
      grantRepoCwd,
    );
    const onWorkBranchAfterFailure =
      currentBranchAfterFailureProbe.ok && currentBranchAfterFailureProbe.output === workBranch;
    // A failing command can still commit to the base branch before checking back
    // out onto the issue branch, leaving HEAD unmoved and the tree clean by the
    // probes above while the local base sits ahead of origin. Repeat the success
    // path's `origin/<base>..<base>` check (issue #678 review) so that
    // contamination is caught here too — otherwise the cleanup below checks out
    // the now-ahead base branch and the next implementation run branches off it,
    // propagating the unintended base commit. Skipped in worktree mode for the
    // same reason as the success path: the base branch cannot be checked out from
    // the per-issue worktree, so the command cannot have advanced it.
    let baseAheadCountAfterFailure = 0;
    // The ahead-count probe alone is not sufficient: a command that checks out
    // the base, commits, *pushes* it to origin, then returns to the issue branch
    // leaves `origin/<base>..<base>` at 0 — origin now includes the pushed
    // commit, so the pair reads as "in sync" even though the base moved. Compare
    // against the SHA captured before the command ran to catch that case too;
    // this check runs unconditionally (not skipped when origin happens to be in
    // sync) because being in sync is exactly the state the pushed-mutation case
    // produces (issue #678 review).
    let baseMovedAfterFailure = false;
    if (!worktreeGrant) {
      const baseAheadAfterFailureProbe = exec.probe(
        "git",
        ["rev-list", "--count", `origin/${baseBranch}..${baseBranch}`],
        grantRepoCwd,
      );
      if (baseAheadAfterFailureProbe.ok) {
        const parsed = Number.parseInt(baseAheadAfterFailureProbe.output.trim(), 10);
        if (Number.isFinite(parsed) && parsed > 0) {
          baseAheadCountAfterFailure = parsed;
        }
      }
      const baseShaAfterFailureProbe = exec.probe("git", ["rev-parse", baseBranch], grantRepoCwd);
      baseMovedAfterFailure =
        baseShaBeforeProbe.ok &&
        baseShaAfterFailureProbe.ok &&
        baseShaBeforeProbe.output !== baseShaAfterFailureProbe.output;
    }
    // A direct refspec push to the remote base (e.g. `git push origin
    // ai/issue-<n>:main`) never touches the local base branch or requires
    // checking it out, so it is invisible to both checks above — and can be run
    // from inside a per-issue worktree just as easily as the canonical checkout
    // (refs/remotes/* is shared across worktrees), so this check is not skipped
    // for `worktreeGrant`. Comparing the `origin/<base>` tracking ref itself
    // (updated locally by Git after a successful push, even a refspec-only one)
    // catches it (issue #678 review).
    const baseRemoteShaAfterFailureProbe = exec.probe("git", ["rev-parse", `origin/${baseBranch}`], grantRepoCwd);
    const baseRemoteMovedAfterFailure =
      baseRemoteShaBeforeProbe.ok &&
      baseRemoteShaAfterFailureProbe.ok &&
      baseRemoteShaBeforeProbe.output !== baseRemoteShaAfterFailureProbe.output;
    const safeToAutoResumeFailure =
      !dirtyAfterFailure &&
      !committedOnBranchAfterFailure &&
      onWorkBranchAfterFailure &&
      baseAheadCountAfterFailure === 0 &&
      !baseMovedAfterFailure &&
      !baseRemoteMovedAfterFailure;

    if (baseAheadCountAfterFailure > 0 || baseMovedAfterFailure || baseRemoteMovedAfterFailure) {
      const result = await store.transitionTask(
        { sessionId, issueNumber },
        { status: task.status },
        { status: task.status, phase: task.phase, context: { toolRequestGrant: consumedGrant }, now },
      );
      if (!result.ok) {
        return failAfterExecution(
          `Failed to record grant: ${result.code}` +
            (result.current ? ` (current status: ${result.current.status})` : ""),
        );
      }

      const baseMutationDescription =
        baseAheadCountAfterFailure > 0
          ? `advanced the local base branch \`${baseBranch}\` ahead of origin`
          : baseMovedAfterFailure
            ? `moved the local base branch \`${baseBranch}\` (and pushed it to origin)`
            : `pushed the remote base branch \`${baseBranch}\` directly (e.g. via a refspec push) without moving the local branch`;
      let commentBody =
        `🛠️ **Tool Request granted command failed** for issue #${issueNumber} — left for human review.\n\n` +
        `Approved command: \`${displayCommand}\`\n\n` +
        `The command exited with a non-zero status (exit ${runResult.exitCode}) but ${baseMutationDescription}. ` +
        `The task was **not** re-queued automatically to avoid propagating an unintended base branch change ` +
        `into later issue branches. Move the commit onto the issue branch \`${workBranch}\` (or drop/revert it) ` +
        `— do NOT push further changes to \`${baseBranch}\` — then resolve with ` +
        `\`tool-request resolve --action manual-done\` or reject/re-request this Tool Request.`;
      commentBody = sanitizeBody(commentBody, sessionRedactionPaths(session));
      await workItemStore.enqueue({
        idempotencyKey: makeOutboxKey(
          sessionId,
          issueNumber,
          runId,
          "gh:comment",
          "tool-request-grant",
          "failed-base-ahead",
        ),
        topic: "gh:comment",
        payload: { topic: "gh:comment", owner, repo, issueNumber, body: commentBody },
        now,
      });

      await store.appendEvent({
        task: { sessionId, issueNumber },
        type: "tool_request_grant_failed",
        runId,
        message: `Operator-granted Tool Request command for issue #${issueNumber} failed (exit ${runResult.exitCode}, base branch mutated)`,
        data: {
          exitCode: runResult.exitCode,
          success: false,
          commandHash: grant.commandHash,
          requeued: false,
          dirtyAfter: dirtyAfterFailure,
          baseAheadAfter: baseAheadCountAfterFailure,
          baseMovedAfter: baseMovedAfterFailure,
          baseRemoteMovedAfter: baseRemoteMovedAfterFailure,
          grantedBy: grant.grantedBy,
        },
        createdAt: now,
      });

      return completed(
        `Guided run for issue #${issueNumber} failed (exit ${runResult.exitCode}) and mutated the base branch; not re-queued.`,
        {
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
          dirtyAfter: dirtyAfterFailure,
          baseAheadAfter: baseAheadCountAfterFailure,
          baseMovedAfter: baseMovedAfterFailure,
          baseRemoteMovedAfter: baseRemoteMovedAfterFailure,
          branch: workBranch,
          commandHash: grant.commandHash,
        },
      );
    }

    if (safeToAutoResumeFailure) {
      if (!worktreeGrant) {
        exec.probe("git", ["checkout", baseBranch], session.repoRoot);
        if (moved.created) {
          exec.probe("git", ["branch", "-D", workBranch], session.repoRoot);
        }
      }
      let worktreeResumePushedAfterFailure = false;
      if (worktreeGrant) {
        if (moved.resumeSafe) {
          worktreeResumePushedAfterFailure = true;
        } else {
          const pushed = exec.probe("git", ["push", "origin", workBranch], grantRepoCwd);
          worktreeResumePushedAfterFailure =
            pushed.ok && exec.remoteHasBranch(grantRepoCwd, workBranch) === "yes";
        }
      }
      const toolRequestResumeBranch = worktreeGrant
        ? worktreeResumePushedAfterFailure
          ? workBranch
          : undefined
        : !moved.created && moved.resumeSafe
          ? workBranch
          : undefined;

      cleanArtifactBeforeRequeue();

      // The failed command's captured output IS the deliverable (issue #678):
      // the agent needs the exit code and stdout/stderr to diagnose the failure,
      // the same way a no-op's captured output answers a verification request.
      const resolution = {
        action: actionLabel,
        resolvedAt: executedAt,
        commandHash: grant.commandHash,
        disposition: "failed",
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
          context: {
            toolRequest: resolvedToolRequest,
            toolRequestGrant: consumedGrant,
            toolRequestResumeBranch,
          },
          now,
        },
      );
      if (!result.ok) {
        return failAfterExecution(
          `Failed to record grant: ${result.code}` +
            (result.current ? ` (current status: ${result.current.status})` : ""),
        );
      }

      const readyForHumanLabel = session.labels["readyForHuman"] as string | undefined;
      const isFixModeRequest =
        existing["mode"] === "fix" ||
        (typeof task.context["reviewFeedback"] === "string" &&
          (task.context["reviewFeedback"] as string).trim().length > 0);
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
        `🛠️ **Tool Request granted command failed — result returned to the agent.**\n\n` +
        `Approved command: \`${displayCommand}\`\n\n` +
        `The command exited with a non-zero status (exit ${runResult.exitCode}) and left no repository changes. ` +
        `The failure output has been delivered to the requesting agent as continuation context and the task ` +
        `has been re-queued for implementation to diagnose and continue.`;
      commentBody = sanitizeBody(commentBody, sessionRedactionPaths(session));
      await workItemStore.enqueue({
        idempotencyKey: makeOutboxKey(
          sessionId,
          issueNumber,
          runId,
          "gh:comment",
          "tool-request-grant",
          "failed-requeued",
        ),
        topic: "gh:comment",
        payload: { topic: "gh:comment", owner, repo, issueNumber, body: commentBody },
        now,
      });

      await store.appendEvent({
        task: { sessionId, issueNumber },
        type: "tool_request_grant_failed",
        runId,
        message: `Operator-granted Tool Request command for issue #${issueNumber} failed (exit ${runResult.exitCode}) and was returned to the agent`,
        data: {
          exitCode: runResult.exitCode,
          success: false,
          commandHash: grant.commandHash,
          requeued: true,
          grantedBy: grant.grantedBy,
        },
        createdAt: now,
      });

      return completed(
        `Guided run for issue #${issueNumber} failed (exit ${runResult.exitCode}) with a clean tree; output returned to the agent and re-queued.`,
        {
          ok: true,
          sessionId,
          issueNumber,
          action: actionLabel,
          executed: true,
          exitCode: runResult.exitCode,
          success: false,
          status: result.value.status,
          phase: result.value.phase,
          requeued: true,
          dirtyAfter: false,
          branch: workBranch,
          commandHash: grant.commandHash,
        },
      );
    }

    // FAILURE, and the command left repository state that cannot be preserved
    // safely (uncommitted changes, an advanced HEAD, or HEAD off the issue
    // branch): surface a clear handoff state and do NOT requeue, so a failing
    // granted command never loops silently against a dirty tree. The request is
    // left UNRESOLVED, but the consumed grant is persisted so the same exact
    // command cannot be re-run by another grant. Recovery is NOT "grant a
    // corrected command": `--command` is rejected unless it equals the stored
    // requested command, and re-granting that exact command is what the consumed
    // grant now blocks. The operator must instead reject/re-request the Tool
    // Request, or run a corrected command themselves and resolve it with
    // `tool-request resolve --action manual-done`.
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
      return failAfterExecution(
        `Failed to record grant: ${result.code}` +
          (result.current ? ` (current status: ${result.current.status})` : ""),
      );
    }

    let commentBody =
      `🛠️ **Tool Request granted command failed** for issue #${issueNumber} — left for human review.\n\n` +
      `Approved command: \`${displayCommand}\`\n\n` +
      `The command exited with a non-zero status (exit ${runResult.exitCode}) and left repository changes ` +
      `behind, so the result could not be safely returned to the agent automatically. The task was **not** ` +
      `re-queued. Review the local run artifact, then either reject/re-request this Tool Request, or run a ` +
      `corrected command manually and resolve it as \`manual-done\`.`;
    commentBody = sanitizeBody(commentBody, sessionRedactionPaths(session));
    await workItemStore.enqueue({
      idempotencyKey: makeOutboxKey(
        sessionId,
        issueNumber,
        runId,
        "gh:comment",
        "tool-request-grant",
        "failed",
      ),
      topic: "gh:comment",
      payload: { topic: "gh:comment", owner, repo, issueNumber, body: commentBody },
      now,
    });

    await store.appendEvent({
      task: { sessionId, issueNumber },
      type: "tool_request_grant_failed",
      runId,
      message: `Operator-granted Tool Request command for issue #${issueNumber} failed (exit ${runResult.exitCode})`,
      data: {
        exitCode: runResult.exitCode,
        success: false,
        commandHash: grant.commandHash,
        requeued: false,
        dirtyAfter: dirtyAfterFailure,
        grantedBy: grant.grantedBy,
      },
      createdAt: now,
    });

    return completed(
      `Guided run for issue #${issueNumber} failed (exit ${runResult.exitCode}) and left repository changes; not re-queued.`,
      {
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
        dirtyAfter: dirtyAfterFailure,
        commandHash: grant.commandHash,
      },
    );
  } finally {
    // One release covers every path — the pre-#1029 handler needed a second
    // release before each `die()` because `process.exit` bypasses `finally`.
    releaseLock();
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
 * `invalid-request` exactly the way the CLI refuses the same flag values.
 */
export function parseToolRequestRunParams(
  params: OperationParams,
): { request: ToolRequestRunRequest } | { error: string } {
  const read = (name: string): unknown =>
    Object.prototype.hasOwnProperty.call(params, name)
      ? (params as Record<string, unknown>)[name]
      : undefined;

  const rawDisposition = read("disposition");
  let disposition: GuidedRunDisposition = "keep";
  if (rawDisposition !== undefined) {
    if (!(GUIDED_RUN_DISPOSITIONS as readonly string[]).includes(rawDisposition as string)) {
      return {
        error: `--disposition must be one of: ${GUIDED_RUN_DISPOSITIONS.join(", ")}, got: ${String(rawDisposition)}`,
      };
    }
    disposition = rawDisposition as GuidedRunDisposition;
  }

  const rawOnChanges = read("on-changes");
  let onChanges: RepoChangeAction | undefined;
  if (rawOnChanges !== undefined) {
    const parsed = parseRepoChangeAction(String(rawOnChanges));
    if (parsed === undefined) {
      return {
        error: `--on-changes must be one of: commit | keep | discard | reject | abort, got: ${String(rawOnChanges)}`,
      };
    }
    onChanges = parsed;
  }

  const rawTtl = read("ttl-seconds");
  let ttlSeconds: number | undefined;
  if (rawTtl !== undefined) {
    const t = Number(rawTtl);
    if (!Number.isFinite(t) || t <= 0) {
      return { error: `--ttl-seconds must be a positive number, got: ${String(rawTtl)}` };
    }
    ttlSeconds = t;
  }

  const rawMaxUses = read("max-uses");
  let maxUses: number | undefined;
  if (rawMaxUses !== undefined) {
    const m = Number(rawMaxUses);
    if (!Number.isInteger(m) || m <= 0) {
      return { error: `--max-uses must be a positive integer, got: ${String(rawMaxUses)}` };
    }
    maxUses = m;
  }

  const confirmDiscard = read("confirm-discard") === true;
  const allowUnexpected = read("allow-unexpected") === true;
  // The confirmation/opt-in flags only mean something alongside the action they
  // guard; a stray one fails fast rather than being silently ignored (issue
  // #419 safety), exactly as the CLI parser does.
  if (confirmDiscard && onChanges !== "discard") {
    return { error: "--confirm-discard is only valid with --on-changes discard." };
  }
  if (allowUnexpected && onChanges !== "commit") {
    return { error: "--allow-unexpected is only valid with --on-changes commit." };
  }

  const rawCommand = read("command");
  return {
    request: {
      command: rawCommand === undefined ? undefined : String(rawCommand),
      ttlSeconds,
      maxUses,
      disposition,
      onChanges,
      confirmDiscard,
      allowUnexpected,
    },
  };
}

/**
 * Build the `tool-request.run` descriptor over an injected context resolver.
 *
 * A registry is a *collection point*, so this module never reaches back into
 * one (contract §3.2): `CHATOPS_OPERATION_DESCRIPTORS` calls this factory, not
 * the other way round. It exists so a composition root, `admin ui`, and this
 * repository's tests can each drive the same core through `invokeOperation`
 * with their own injected context.
 */
export function createToolRequestRunDescriptor(
  resolveContext: (invocation: OperationContext) => ToolRequestRunContext | Promise<ToolRequestRunContext>,
): OperationDescriptor {
  return {
    id: TOOL_REQUEST_RUN_OPERATION_ID,
    summary: "Guided-run the approved command for this issue's Tool Request handoff.",
    mutating: true,
    scope: "issue",
    params: TOOL_REQUEST_RUN_PARAM_SPECS,
    run: async ({ request, context }) => {
      const parsed = parseToolRequestRunParams(request.params);
      if ("error" in parsed) {
        return { status: "rejected", reason: "invalid-request", summary: parsed.error, effect: "none" };
      }
      const resolved = await resolveContext(context);
      return runToolRequestRun({ request: parsed.request, context: resolved });
    },
  };
}
