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

import { JsonSessionRegistry, DEFAULT_SESSIONS_PATH } from "../registries/json-session-registry.js";
import { SqliteTaskStore } from "../stores/sqlite-task-store.js";
import { SqliteOutboxStore } from "../stores/sqlite-outbox-store.js";
import { SqliteContextStore } from "../stores/sqlite-context-store.js";
import { runNextPhase } from "../core/phase-runner.js";
import type { PhaseHandlerContext, PhaseHandlers } from "../core/phase-runner.js";
import { createResearchHandler } from "../handlers/research.js";
import { createImplementationHandler } from "../handlers/implementation.js";
import { createReviewHandler } from "../handlers/review.js";
import { createConflictResolutionHandler } from "../handlers/conflict-resolution.js";
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
import type { ResolvedSession } from "../core/session.js";
import type { TaskPhase } from "../core/task.js";
import { emit, die } from "./cli-io.js";
import { tokenizeArgs } from "./admin-command.js";
import { fileURLToPath } from "url";

const ALL_PHASES = new Set<TaskPhase>([
  "implementation", "review", "conflict_resolution", "research", "planner",
]);
const DEFAULT_SUPPORTED_PHASES: TaskPhase[] = ["research"];

// Phases that operate inside the repository checkout and therefore run in the
// per-issue worktree when a session opts in (issue #438). Research/planner do not
// touch the issue branch, so they keep the shared checkout and never trigger
// worktree (and `ai/issue-<n>` branch) creation prematurely.
const WORKTREE_PHASES = new Set<TaskPhase>([
  "implementation", "review", "conflict_resolution",
]);

/**
 * Acquire the issue-scoped worktree lock around phase execution (issue #440).
 *
 * For a worktree-enabled session running a repo-working phase this takes the
 * `<session>::issue-<n>` lock so the SAME issue cannot run concurrently while
 * DIFFERENT issues (distinct lock scopes) proceed in parallel — independent of
 * whether n8n prevents overlapping executions. A worktree-disabled session (or a
 * research/planner phase that never touches the issue branch) returns a no-op
 * acquisition so the handler proceeds exactly as before — preserving today's
 * shared-checkout behavior. The owner id ties the lock to this run's execution so
 * `admin worktree recovery` / `release-lock` can attribute a stale lock to its
 * origin. The session repo lock is left to canonical-repo / worktree-registry
 * mutations (admin commands) and is intentionally NOT taken here.
 */
function acquireIssuePhaseLock(
  lock: IssueWorktreeLock,
  ownerId: string,
  session: ResolvedSession,
  task: AiTask,
): PhaseLockAcquisition {
  if (session.worktrees?.enabled !== true || !WORKTREE_PHASES.has(task.phase)) {
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

export async function createPhaseHandlers(
  context: PhaseHandlerContext,
  authDeps?: GhRunnerAuthDeps,
  giteaHttp: GiteaHttpRequest = defaultGiteaHttp,
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
  // When this session uses per-issue worktrees, the phase runner acquires the
  // issue-scoped worktree lock before invoking the review handler (via acquirePhaseLock).
  // Pass the pre-acquisition owner ID so the review handler skips its own acquire;
  // without this it would see the lock already held and return `blocked` (issue #515).
  const phaseLockOwnerId = session.worktrees?.enabled ? (context.contextId ?? context.runId) : undefined;

  return {
    research: createResearchHandler(context),
    implementation: createImplementationHandler(context, undefined, depChecker),
    review: createReviewHandler(context, undefined, undefined, undefined, undefined, phaseLockOwnerId),
    conflict_resolution: createConflictResolutionHandler(context, undefined, undefined, undefined, phaseLockOwnerId),
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
    die(`Unknown sessionId: ${sessionId} (not found in ${sessionsPath})`);
  }

  // Build handler map after session is resolved so handlers can close over
  // session.repoRoot and runId for deterministic artifact paths.
  let handlers: PhaseHandlers;
  try {
    handlers = await createPhaseHandlers({ session, runId, workerId, contextId });
  } catch (err) {
    die(`Failed to resolve GitHub provider auth: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Open SQLite stores (outbox shares the same DB file as tasks)
  const store = new SqliteTaskStore(dbPath);
  const outboxStore = new SqliteOutboxStore(dbPath);

  // Issue-scoped worktree lock taken around phase execution (issue #440). The
  // owner id ties a held lock to this run's execution (contextId when n8n supplies
  // it, else the runId) so admin recovery can attribute a stale lock to its origin.
  const issueLock = new IssueWorktreeLock();
  const lockOwnerId = contextId ?? runId;

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
      // phases when the session opts in (issue #438). This is intentionally
      // NON-mutating: the handlers in this slice still run in the canonical
      // checkout (`session.repoRoot`), so creating/checking out `ai/issue-<n>` in a
      // separate worktree here would collide with the handler's own branch
      // checkout. The resolver defaults to `create: false`, computing the id +
      // path with no git side effect. Worktree-disabled sessions short-circuit to
      // `enabled: false`, so this is a no-op for them.
      resolveWorktreeContext: (task) =>
        WORKTREE_PHASES.has(task.phase)
          ? resolveWorktreeExecutionContext({ session, issueNumber: task.issueNumber })
          : { ok: true, context: { enabled: false } },
      // Take the issue-scoped worktree lock around phase execution (issue #440) so
      // the same issue never runs concurrently while different issues stay
      // independent. Worktree-disabled sessions / non-repo phases get a no-op lock,
      // preserving today's shared-checkout behavior.
      acquirePhaseLock: (task) => acquireIssuePhaseLock(issueLock, lockOwnerId, session, task),
    });

    const ctx = contextId !== undefined ? { contextId } : {};

    switch (outcome.status) {
      case "idle":
        emit({ ok: true, outcome: "idle", sessionId, supportedPhases, repoRoot: session.repoRoot, ...ctx });
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
    }
  } finally {
    store.close();
    outboxStore.close();
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
