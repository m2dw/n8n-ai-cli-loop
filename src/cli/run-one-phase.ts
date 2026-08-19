#!/usr/bin/env node
/**
 * run-one-phase — thin CLI entrypoint for n8n Execute Command nodes.
 *
 * n8n command shape:
 *   node /path/to/dist/cli/run-one-phase.js \
 *     --session-id "addon-dev" \
 *     --context-id "{{ $execution.id }}"
 *
 * --run-id is optional when --context-id is provided; contextId is used as
 * the run ID when --run-id is omitted.
 *
 * Exits 0 for all expected outcomes (idle, phase_missing, completed, claim_lost).
 * Exits 1 only for setup errors (bad args, missing config, unknown session).
 * Writes a single JSON object to stdout so n8n can read it as Execute Command output.
 */

import {
  JsonSessionRegistry,
  DEFAULT_SESSIONS_PATH,
  describeUnresolvedSessionId,
} from "../registries/json-session-registry.js";
import { SqliteTaskStore } from "../stores/sqlite-task-store.js";
import { SqliteOutboxStore } from "../stores/sqlite-outbox-store.js";
import { MaintenanceLockedError } from "../stores/maintenance-lock-guard.js";
import { SqliteContextStore } from "../stores/sqlite-context-store.js";
import { SqliteSessionControlStore } from "../stores/sqlite-session-control-store.js";
import { recordRunAndEvaluate, resolveCircuitBreakerPolicy } from "../core/session-control.js";
import { runNextPhase } from "../core/phase-runner.js";
import type { PhaseHandlerContext, PhaseHandlers } from "../core/phase-runner.js";
import { createResearchHandler } from "../handlers/research.js";
import { createImplementationHandler } from "../handlers/implementation.js";
import { createReviewHandler } from "../handlers/review.js";
import { checkReviewAdmission } from "../handlers/review-admission.js";
import { checkReportOnlyAdmission } from "../handlers/report-only-admission.js";
import { createConflictResolutionHandler } from "../handlers/conflict-resolution.js";
import { createContentResearchHandler } from "../handlers/content-research.js";
import { createContentDraftHandler } from "../handlers/content-draft.js";
import { createContentReviewHandler } from "../handlers/content-review.js";
import { createRefinementHandler } from "../handlers/issue-refinement-loop.js";
import {
  createGhRefinementApplyPort,
  createGhRefinementSnapshotSource,
} from "./issue-refinement-loop.js";
import { resolveWorktreeExecutionContext } from "../handlers/worktree-context.js";
import { IssueWorktreeLock } from "../handlers/worktree.js";
import type { PhaseLockAcquisition } from "../core/phase-runner.js";
import type { AiTask } from "../core/task.js";
import type { AcquireResult } from "../stores/repo-lock-store.js";
import { GraphQLDependencyChecker, runGhViaRunner } from "./github-intake.js";
import { defaultCommandRunner } from "../handlers/command-runner.js";
import { ghRunnerFromCommandRunner } from "../providers/github/gh-runner.js";
import type { GhRunner as ProviderGhRunner } from "../providers/github/gh-runner.js";
import { resolveGhRunner } from "../providers/github/github-app-auth.js";
import type { GhRunnerAuthDeps } from "../providers/github/github-app-auth.js";
import { GiteaWorkItemProvider } from "../providers/gitea/gitea-work-item-provider.js";
import {
  resolveGiteaToken,
  redactGiteaSecrets,
  defaultGiteaHttp,
} from "../providers/gitea/gitea-client.js";
import type { GiteaHttpRequest } from "../providers/gitea/gitea-client.js";
import type { DependencyChecker } from "../core/github-intake.js";
import type { TaskPhase } from "../core/task.js";
import { emit, die } from "./cli-io.js";
import { tokenizeArgs } from "./admin-command.js";
import { fileURLToPath } from "url";

const ALL_PHASES = new Set<TaskPhase>([
  "implementation", "review", "conflict_resolution", "research", "content_research", "content_draft", "content_review", "planner", "refinement",
]);
const DEFAULT_SUPPORTED_PHASES: TaskPhase[] = ["research", "content_research", "content_draft", "content_review"];

// Phases that operate inside the repository checkout and therefore run in the
// per-issue worktree unconditionally (issue #438; issue #731 dropped the
// shared-checkout mode entirely). Research/planner/refinement do not touch the
// issue branch — refinement's agents run isolated with no tools in a throwaway
// cwd (issue #869) — so they never trigger worktree (and `ai/issue-<n>`
// branch) creation.
const WORKTREE_PHASES = new Set<TaskPhase>([
  "implementation", "review", "conflict_resolution",
]);

// Phases serialized under the issue-scoped lock. Every worktree phase is, and
// so is refinement despite touching no worktree (issue #869 review follow-up):
// its loop spends multiple bounded agent invocations (up to ten minutes each)
// across rounds, retries, and malformed-output re-asks, so a single run can
// outlive the 30-minute task lease — and an expired lease lets claimNextTask
// hand the SAME issue to a second tick while the first is still mid-loop,
// doubling agent spend and racing the artifact writes and the block/result
// commit. The same `<session>::issue-<n>` lock the worktree phases use (24h
// TTL, `admin worktree release-lock` recovery) serializes refinement per issue
// while distinct issues keep running in parallel. Worktree RESOLUTION stays
// keyed to WORKTREE_PHASES, so refinement still never materializes a worktree
// or an `ai/issue-<n>` branch.
const ISSUE_LOCK_PHASES = new Set<TaskPhase>([...WORKTREE_PHASES, "refinement"]);

/**
 * Acquire the issue-scoped worktree lock around phase execution (issue #440).
 *
 * Every issue-serialized phase (`ISSUE_LOCK_PHASES` — the worktree phases plus
 * refinement) takes the `<session>::issue-<n>` lock so the SAME issue cannot
 * run concurrently while DIFFERENT issues (distinct lock scopes) proceed in
 * parallel — independent of whether n8n prevents overlapping executions. A
 * research/planner phase that never touches the issue branch gets a no-op
 * acquisition. The owner id ties the lock to this run's execution so
 * `admin worktree recovery` / `release-lock` can attribute a stale lock to its
 * origin. The session repo lock is left to canonical-repo / worktree-registry
 * mutations (admin commands) and is intentionally NOT taken here.
 *
 * Exported for tests only; `main` is the sole production caller.
 */
export function acquireIssuePhaseLock(
  lock: IssueWorktreeLock,
  ownerId: string,
  task: AiTask,
): PhaseLockAcquisition {
  if (!ISSUE_LOCK_PHASES.has(task.phase)) {
    return { ok: true, acquired: true, handle: { release() {} } };
  }
  let result: AcquireResult;
  try {
    result = lock.acquire(ownerId, task.sessionId, task.issueNumber);
  } catch (err) {
    // A filesystem fault in the lock store — fail the phase closed rather than
    // running without the guard.
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (result.locked) {
    return {
      ok: true,
      acquired: true,
      handle: {
        release() {
          // Best-effort: the 24h lock TTL and `admin worktree release-lock` are
          // the backstop if release fails (e.g. the lock was force-released).
          try {
            lock.release(ownerId, task.sessionId, task.issueNumber);
          } catch {
            /* ignore — leaked locks are recovered by TTL/admin */
          }
        },
      },
    };
  }
  return {
    ok: true,
    acquired: false,
    reason: `issue ${task.issueNumber} is already running (worktree lock held)`,
    ownerContextId: result.ownerContextId,
    ownerStartedAt: result.ownerStartedAt,
  };
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

interface CliArgs {
  sessionId: string | undefined;
  runId: string;
  sessionsPath: string;
  dbPath: string | undefined;
  workerId: string;
  supportedPhases: TaskPhase[];
  contextId: string | undefined;
}

function parseArgs(argv: string[]): CliArgs | { error: string } {
  const tokenized = tokenizeArgs(argv, {
    valueFlags: [
      "session-id",
      "run-id",
      "context-id",
      "sessions-path",
      "db-path",
      "worker-id",
      "supported-phases",
    ],
  });
  if ("error" in tokenized) return { error: tokenized.error };
  const { args } = tokenized;

  const sessionId = args["session-id"];
  const runId = args["run-id"];
  const contextId = args["context-id"];

  if (!sessionId && !contextId) return { error: "--context-id or --session-id is required" };
  if (!runId && !contextId) return { error: "--run-id is required when --context-id is not provided" };

  const supportedPhases = parseSupportedPhases(args["supported-phases"], DEFAULT_SUPPORTED_PHASES);
  if ("error" in supportedPhases) return supportedPhases;

  return {
    sessionId,
    runId: runId ?? contextId as string,
    sessionsPath: args["sessions-path"] ?? DEFAULT_SESSIONS_PATH,
    dbPath: args["db-path"],
    workerId: args["worker-id"] ?? "n8n-cli",
    supportedPhases,
    contextId,
  };
}

// ---------------------------------------------------------------------------
// Supported-phase parsing (shared shape with github-intake)
// ---------------------------------------------------------------------------

function parseSupportedPhases(
  raw: string | undefined,
  defaultPhases: TaskPhase[],
): TaskPhase[] | { error: string } {
  if (!raw) return defaultPhases;
  const phases = raw.split(",").map((p) => p.trim()).filter(Boolean) as TaskPhase[];
  const invalid = phases.filter((p) => !ALL_PHASES.has(p));
  if (invalid.length > 0) {
    return { error: `Invalid phase(s) in --supported-phases: ${invalid.join(", ")}. Valid: ${[...ALL_PHASES].join(", ")}` };
  }
  return phases;
}

// ---------------------------------------------------------------------------
// Phase handler factory
//
// Handlers are created after session resolution so they can close over
// `session.repoRoot` and other session config. Future handlers must spawn
// subprocesses with `cwd: context.session.repoRoot`.
//
// Claude / Codex / Gemini handlers are future work (#9+). The empty map
// causes runNextPhase() to move tasks to ready_for_human — no crash.
// ---------------------------------------------------------------------------

/**
 * Composition inputs that are not session config. `dbPath` is the runner's
 * SQLite file (the `--db-path` the stores in `main` open); the refinement
 * snapshot's registered-chain cross-check reads the chain registry from the
 * same file, so it sees the chains the intake that registered them wrote.
 */
export interface PhaseHandlerRuntimeOptions {
  dbPath?: string | undefined;
}

export async function createPhaseHandlers(
  context: PhaseHandlerContext,
  authDeps?: GhRunnerAuthDeps,
  giteaHttp: GiteaHttpRequest = defaultGiteaHttp,
  runtime?: PhaseHandlerRuntimeOptions,
): Promise<PhaseHandlers> {
  // Resolve the work-item provider's `gh` executor so dependency relationship
  // reads run as the session's configured identity. For `gh` mode this is the
  // operator's CLI session (unchanged); for `github-app` mode it injects a
  // refresh-aware installation token. Building the checker with the default
  // `execFileSync("gh", ...)` would route `getBlockedBy()` through the operator's
  // raw `gh` auth, which fails or reads as the wrong identity in App-only
  // deployments and causes implementation tasks to fail closed as blocked.
  // `authDeps` is a test seam (mocked env/key/HTTP); production passes none.
  //
  // Resolution is deferred until `getBlockedBy()` is actually called — i.e. only
  // when the implementation handler checks dependencies. Resolving eagerly here
  // would exchange a GitHub App token even for idle/research/review-only or
  // no-handler runs that never read dependencies, making those no-op executions
  // fail on missing credentials or a transient token-exchange outage.
  const { session } = context;
  const auth = session.workItemProvider?.auth ?? { mode: "gh" };
  let workItemRunner: Promise<ProviderGhRunner> | undefined;
  const resolveWorkItemRunner = (): Promise<ProviderGhRunner> => {
    if (!workItemRunner) {
      const cmdGhRunner = ghRunnerFromCommandRunner(defaultCommandRunner);
      workItemRunner = resolveGhRunner(auth, cmdGhRunner, authDeps);
    }
    return workItemRunner;
  };
  const workItemKind = session.workItemProvider?.provider ?? "github-issues";

  // For a `gitea-issues` session, dependency relationships are read from Gitea's
  // native issue-dependencies endpoint through the WorkItemProvider — exactly as
  // intake does (see github-intake.ts) — never from the GitHub GraphQL checker.
  // Without this the depChecker below would always throw for a Gitea session and
  // force every implementation task closed as "blocked" before it could start,
  // even an item with no open blockers. The provider (and its API-token
  // resolution) is built lazily on the first getBlockedBy() call so idle /
  // research / review-only or no-handler runs never resolve the Gitea token.
  // A token-resolution failure throws (after redaction) so the implementation
  // handler fails closed rather than proceeding without a verified read.
  let giteaProvider: GiteaWorkItemProvider | undefined;
  const resolveGiteaProvider = (): GiteaWorkItemProvider => {
    if (!giteaProvider) {
      const gitea = session.workItemProvider.gitea;
      if (!gitea) {
        throw new Error(
          `Session ${session.sessionId} selects gitea-issues but is missing the gitea connection block`,
        );
      }
      let token: string;
      try {
        token = resolveGiteaToken(session.workItemProvider.auth, {
          env: authDeps?.env,
          resolveKey: authDeps?.resolveKey,
        });
      } catch (err) {
        throw new Error(
          redactGiteaSecrets(
            `Failed to resolve Gitea provider auth: ${err instanceof Error ? err.message : String(err)}`,
            [],
          ),
        );
      }
      giteaProvider = new GiteaWorkItemProvider({
        baseUrl: gitea.baseUrl,
        owner: gitea.owner,
        repo: gitea.repo,
        token,
        ...(gitea.apiPath !== undefined ? { apiPath: gitea.apiPath } : {}),
        http: giteaHttp,
      });
    }
    return giteaProvider;
  };

  const depChecker: DependencyChecker = {
    async getBlockedBy(issueNumber) {
      // A Gitea work-item session reads `blocked by` from Gitea over its REST
      // API via the WorkItemProvider, so an unblocked Gitea item is not forced
      // closed before implementation can start.
      if (workItemKind === "gitea-issues") {
        return resolveGiteaProvider().getDependencies(issueNumber);
      }
      // The GraphQL dependency checker speaks GitHub only. For any other
      // non-GitHub work-item provider there is no wired backend, so fail closed
      // with a clear error rather than silently reading dependencies from the
      // GitHub repo under the wrong identity.
      if (workItemKind !== "github-issues") {
        throw new Error(
          `Dependency checks are not implemented for work-item provider "${workItemKind}"`,
        );
      }
      const runner = await resolveWorkItemRunner();
      const checker = new GraphQLDependencyChecker(
        session.githubRepo,
        runGhViaRunner(runner, session.repoRoot),
      );
      return checker.getBlockedBy(issueNumber);
    },
  };
  // The phase runner always acquires the issue-scoped worktree lock before
  // invoking these handlers (via acquirePhaseLock). Pass the pre-acquisition
  // owner ID so the handler skips its own acquire; without this it would see
  // the lock already held and return `blocked` (issue #515).
  const runnerLockOwnerId = context.contextId ?? context.runId;
  const reviewPhaseLockOwnerId = runnerLockOwnerId;
  const conflictPhaseLockOwnerId = runnerLockOwnerId;

  return {
    research: createResearchHandler(context),
    content_research: createContentResearchHandler(context),
    content_draft: createContentDraftHandler(context),
    content_review: createContentReviewHandler(context),
    implementation: createImplementationHandler(context, undefined, depChecker),
    review: createReviewHandler(context, undefined, undefined, undefined, undefined, reviewPhaseLockOwnerId),
    conflict_resolution: createConflictResolutionHandler(context, undefined, undefined, undefined, conflictPhaseLockOwnerId),
    // Chain-aware progressive Issue refinement (issue #869 review follow-up):
    // an intake-admitted `refinement` task is executed by the same tick as
    // every other phase instead of waiting for a manual `admin refinement run`.
    // Read-only snapshot, no worktree, no OUTBOX side effects (the runner's
    // refinement effect gate); the loop mutates nothing on GitHub, and the
    // application walk (issue #870) performs exactly the §11 step 3–5 writes
    // through the apply port below — the same gh-backed adapters the admin
    // command uses. The source is built on the first refinement claim — like every
    // other deferral in this factory — because its dependency checker
    // validates `session.githubRepo` at construction and its `gh` executor
    // resolves the session's work-item identity (a token exchange in
    // `github-app` mode); an eager build would fail the whole handler map
    // (idle/research/no-handler runs included) over a phase this run may never
    // claim. A construction failure here surfaces as that one refinement task
    // failing closed.
    refinement: (() => {
      let refinementHandler: ReturnType<typeof createRefinementHandler> | undefined;
      return async (task: AiTask) => {
        // A non-GitHub work-item provider has no gh-backed snapshot to build.
        // Not a throw: `runHandler` would turn that into a `failed` task, and
        // §17 forbids the refinement lane ending there — the marker label
        // stays on the work item with no recovery surface. A `blocked` result
        // routes to `ready_for_human` (the §13 handoff shape), parking the
        // task for an operator; the refinement effect gate keeps this from
        // touching the provider either way.
        if (workItemKind !== "github-issues") {
          return {
            result: "blocked" as const,
            message:
              `Refinement snapshot reads are not implemented for work-item provider "${workItemKind}"; `
              + "parking the task for an operator instead of failing it. Disable "
              + "issueRefinement for this session or remove the refinement marker label.",
          };
        }
        if (!refinementHandler) {
          // The snapshot's `gh` reads — and the application slice's `gh`
          // writes (issue #870) — run as the session's configured work-item
          // identity, exactly like `getBlockedBy()` above: built without a
          // runner, both fall back to raw `execFileSync("gh", ...)`, which
          // fails on a host with no interactive `gh` login or acts under an
          // unrelated local account in App-only deployments.
          const runner = await resolveWorkItemRunner();
          const runGh = runGhViaRunner(runner, session.repoRoot);
          refinementHandler = createRefinementHandler(context, {
            source: createGhRefinementSnapshotSource({
              githubRepo: session.githubRepo,
              artifactRoot: session.artifactRoot,
              runGh,
              // Registered-chain cross-check (§4 condition 5): read the chain
              // registry from the same SQLite file the runner's stores use, so
              // a registered member whose live `blocked by` set contradicts
              // its accepted chain revision takes the `chain_disagreement`
              // handoff instead of being refined against a topology the
              // registry does not accept.
              chainAgreement: { sessionId: session.sessionId, dbPath: runtime?.dbPath },
            }),
            // The §11 step 3–5 write surface for an `accepted`/`applying`
            // block: the managed-region body update, the one §16 audit
            // comment, and the labels-last transition (issue #870).
            applyPort: createGhRefinementApplyPort({
              githubRepo: session.githubRepo,
              runGh,
            }),
          });
        }
        return refinementHandler(task);
      };
    })(),
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if ("error" in parsed) die(parsed.error);

  const { runId, sessionsPath, dbPath, workerId, supportedPhases, contextId } = parsed;

  // Resolve sessionId: use --session-id directly, or look it up from the context store
  let sessionId: string;
  if (parsed.sessionId) {
    sessionId = parsed.sessionId;
  } else {
    // contextId is guaranteed truthy by parseArgs validation
    const ctxStore = new SqliteContextStore(dbPath);
    let fromStore: string | undefined;
    try {
      fromStore = ctxStore.getSessionId(contextId as string);
    } finally {
      ctxStore.close();
    }
    if (!fromStore) die(`Unknown contextId: ${contextId}`);
    sessionId = fromStore;
  }

  // Load session registry
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

  // Build handler map after session is resolved so handlers can close over
  // session.repoRoot and runId for deterministic artifact paths.
  let handlers: PhaseHandlers;
  try {
    handlers = await createPhaseHandlers(
      { session, runId, workerId, contextId },
      undefined,
      undefined,
      { dbPath },
    );
  } catch (err) {
    die(`Failed to resolve GitHub provider auth: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Open SQLite stores (outbox and session control share the same DB file as tasks)
  const store = new SqliteTaskStore(dbPath);
  const outboxStore = new SqliteOutboxStore(dbPath);
  const sessionControlStore = new SqliteSessionControlStore(dbPath);

  // Issue-scoped worktree lock taken around phase execution (issue #440). The
  // owner id ties a held lock to this run's execution (contextId when n8n supplies
  // it, else the runId) so admin recovery can attribute a stale lock to its origin.
  const issueLock = new IssueWorktreeLock();
  const lockOwnerId = contextId ?? runId;

  // Hoisted above the try so the maintenance-contention catch below can report
  // the same context envelope every outcome carries.
  const ctx = contextId !== undefined ? { contextId } : {};

  try {
    const outcome = await runNextPhase({
      store,
      request: {
        sessionId,
        workerId,
        runId,
        supportedPhases,
      },
      handlers,
      outboxStore,
      session,
      contextId,
      // Record the per-issue worktree's deterministic identity before repo-working
      // phases (issue #438). This is intentionally NON-mutating: the resolver
      // defaults to `create: false`, computing the id + path with no git side
      // effect. Non-repo phases (research/planner/content-*) never touch the
      // issue branch, so they resolve to `{ enabled: false }`.
      resolveWorktreeContext: async (task) => {
        if (!WORKTREE_PHASES.has(task.phase)) {
          return { ok: true, context: { enabled: false } };
        }
        const resolved = resolveWorktreeExecutionContext({ session, issueNumber: task.issueNumber });
        if (!resolved.ok) return resolved;
        return { ok: true, context: { enabled: true, ...resolved.context } };
      },
      // Take the issue-scoped worktree lock around phase execution (issue #440) so
      // the same issue never runs concurrently while different issues stay
      // independent. Non-repo phases get a no-op lock.
      acquirePhaseLock: (task) => acquireIssuePhaseLock(issueLock, lockOwnerId, task),
      // Review-admission preflight (issue #681) and report-only-mode admission
      // (issue #532), run before the issue lock is taken or the worktree is
      // resolved so a rejection never acquires the lock, materializes the
      // worktree, or invokes the handler. Every other phase is admitted as-is.
      admitPhase: (task) =>
        task.phase === "review" ? checkReviewAdmission(task) : checkReportOnlyAdmission(session, task),
      // Session pause gate (issue #531): a paused session claims and executes
      // nothing. Pause state lives in the runner-owned SQLite store (see
      // `admin session pause|resume|status`), never in GitHub labels.
      checkSessionPause: () => sessionControlStore.getPauseState(sessionId),
      // Per-run cost/result ledger + circuit breaker (issue #531): record every
      // executed phase and pause the session automatically after repeated
      // failed outcomes (session-wide or same-issue+phase; thresholds are
      // env-tunable, see resolveCircuitBreakerPolicy). An automatic pause never
      // overwrites an operator's pause. The breaker trip is also recorded as a
      // task event so the pause is attributable from the event log.
      recordRunResult: async (entry) => {
        const evaluation = await recordRunAndEvaluate(
          sessionControlStore, entry, resolveCircuitBreakerPolicy(),
        );
        if (evaluation.tripped && evaluation.pausedNow && evaluation.decision.trip) {
          await store.appendEvent({
            task: { sessionId: entry.sessionId, issueNumber: entry.issueNumber },
            type: "session.paused",
            runId,
            message: evaluation.decision.reason,
            data: {
              source: "circuit_breaker",
              rule: evaluation.decision.rule,
              count: evaluation.decision.count,
              threshold: evaluation.decision.threshold,
              ...(contextId !== undefined ? { contextId } : {}),
            },
            createdAt: entry.createdAt,
          });
        }
      },
    });

    switch (outcome.status) {
      case "idle":
        emit({ ok: true, outcome: "idle", sessionId, supportedPhases, repoRoot: session.repoRoot, ...ctx });
        break;

      case "paused":
        // Session pause (issue #531): no task was claimed or executed. Exit 0
        // with a clear JSON outcome — a deliberately paused session is an
        // expected state, not a workflow crash. Resume with
        // `admin session resume --session-id <id>`.
        emit({
          ok: true,
          outcome: "paused",
          sessionId,
          ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
          ...(outcome.pausedAt !== undefined ? { pausedAt: outcome.pausedAt } : {}),
          ...(outcome.pausedBy !== undefined ? { pausedBy: outcome.pausedBy } : {}),
          ...(outcome.source !== undefined ? { source: outcome.source } : {}),
          repoRoot: session.repoRoot,
          ...ctx,
        });
        break;

      case "claim_lost":
        emit({ ok: true, outcome: "claim_lost", sessionId, task: summariseTask(outcome.task), ...ctx });
        break;

      case "phase_missing":
        emit({
          ok: true,
          outcome: "phase_missing",
          sessionId,
          task: summariseTask(outcome.task),
          repoRoot: session.repoRoot,
          ...ctx,
        });
        break;

      case "completed":
        emit({
          ok: true,
          outcome: "completed",
          sessionId,
          task: summariseTask(outcome.task),
          result: outcome.result.result,
          repoRoot: session.repoRoot,
          ...ctx,
        });
        break;

      case "delayed":
        // Quota/rate-limit exhaustion (issue #25). Exit 0 with a clear JSON
        // outcome so n8n does not treat a temporary quota window as a workflow
        // crash; the task stays queued and is reclaimed after `notBefore`.
        emit({
          ok: true,
          outcome: "delayed",
          sessionId,
          task: summariseTask(outcome.task),
          notBefore: outcome.notBefore,
          repoRoot: session.repoRoot,
          ...ctx,
        });
        break;

      case "lock_contended":
        // Issue lock contention (issue #440): another live run already owns this
        // issue's worktree lock, so the phase did not run. The claim was released
        // back to `queued`; exit 0 so n8n does not treat normal serialization as a
        // crash and the task is reclaimed on the next tick.
        emit({
          ok: true,
          outcome: "lock_contended",
          sessionId,
          task: summariseTask(outcome.task),
          ...(outcome.ownerContextId !== undefined ? { ownerContextId: outcome.ownerContextId } : {}),
          repoRoot: session.repoRoot,
          ...ctx,
        });
        break;

      case "maintenance_locked":
        // Whole-file maintenance contention (issue #818): a prune/restore/rollup
        // pass holds the store's maintenance lock, so the phase completion was
        // refused in full — no transition, no event, no outbox effect. Exit 0 so
        // n8n does not treat a normal maintenance window as a workflow crash. The
        // runner also tries to hand the claim back rather than leave it leased
        // (issue #818 review follow-up), so the reported task is `queued` — and
        // the next tick re-runs the phase as soon as the lock clears — whenever
        // that requeue is not itself refused by the same lock; when it is, the
        // task stays `running` and lease expiry recovers it after maintenance.
        emit({
          ok: true,
          outcome: "maintenance_locked",
          sessionId,
          ...(outcome.task !== undefined ? { task: summariseTask(outcome.task) } : {}),
          repoRoot: session.repoRoot,
          ...ctx,
        });
        break;
    }
  } catch (err) {
    // A direct outbox enqueue met a held maintenance lock and threw (issue
    // #818) from a path outside handler execution — a handler's own throw is
    // already converted to a `failed` result by `runHandler`, whose completion
    // then reports `maintenance_locked` through the switch above. Nothing was
    // persisted either way, so report the same retryable contention at exit 0
    // rather than letting a prune/restore window surface to n8n as a crashed
    // step. Every other error propagates unchanged.
    if (!(err instanceof MaintenanceLockedError)) throw err;
    emit({ ok: true, outcome: "maintenance_locked", sessionId, repoRoot: session.repoRoot, ...ctx });
  } finally {
    store.close();
    outboxStore.close();
    sessionControlStore.close();
  }
}

function summariseTask(task: { sessionId: string; issueNumber: number; status: string; phase: string } | undefined) {
  if (!task) return undefined;
  return {
    sessionId: task.sessionId,
    issueNumber: task.issueNumber,
    status: task.status,
    phase: task.phase,
  };
}

// Entrypoint — only run when executed directly, not when imported in tests.
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    die(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
  });
}
