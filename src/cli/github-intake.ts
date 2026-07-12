#!/usr/bin/env node
/**
 * github-intake — discover GitHub issues by label and enqueue into SQLite.
 *
 * Command shape:
 *   node /path/to/dist/cli/github-intake.js \
 *     --session-id "addon-dev" \
 *     [--sessions-path <path>] \
 *     [--db-path <path>] \
 *     [--limit <n>] \
 *     [--dry-run]
 *
 * Exits 0 for successful sync and for no-candidates.
 * Exits 1 for setup, validation, gh failure, or unexpected errors.
 * Writes one JSON object to stdout.
 */

import { execFileSync } from "child_process";
import { JsonSessionRegistry, DEFAULT_SESSIONS_PATH } from "../registries/json-session-registry.js";
import { SqliteTaskStore } from "../stores/sqlite-task-store.js";
import { SqliteOutboxStore } from "../stores/sqlite-outbox-store.js";
import { SqliteContextStore } from "../stores/sqlite-context-store.js";
import { makeOutboxKey } from "../core/outbox.js";
import { workItemOutbox } from "../core/outbox-effects.js";
import { parseCandidates } from "../core/github-intake.js";
import { resolveAssignment } from "../core/assignment.js";
import type { GhIssue, DependencyChecker, BlockedByEntry, StackReadyResolver } from "../core/github-intake.js";
import { resolveDependencyExecutionPlan } from "../handlers/dependency-plan.js";
import { defaultCommandRunner } from "../handlers/command-runner.js";
import { ghRunnerFromCommandRunner } from "../providers/github/gh-runner.js";
import type { GhRunner as ProviderGhRunner } from "../providers/github/gh-runner.js";
import { resolveGhRunner } from "../providers/github/github-app-auth.js";
import { resolveSessionRepoHost } from "../providers/repo-host-factory.js";
import type { SessionRepoHost } from "../providers/repo-host-factory.js";
import { GiteaWorkItemProvider } from "../providers/gitea/gitea-work-item-provider.js";
import { resolveGiteaToken, redactGiteaSecrets } from "../providers/gitea/gitea-client.js";
import type { GiteaHttpRequest } from "../providers/gitea/gitea-client.js";
import type { WorkItem } from "../providers/types.js";
import type { TaskPhase } from "../core/task.js";
import { emit, die } from "./cli-io.js";
import { tokenizeArgs } from "./admin-command.js";

const ALL_PHASES = new Set<TaskPhase>([
  "implementation", "review", "conflict_resolution", "research", "planner",
]);
const DEFAULT_SUPPORTED_PHASES: TaskPhase[] = ["research"];

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

interface CliArgs {
  sessionId: string | undefined;
  sessionsPath: string;
  dbPath: string | undefined;
  limit: number;
  dryRun: boolean;
  supportedPhases: TaskPhase[];
  contextId: string | undefined;
}

function parseArgs(argv: string[]): CliArgs | { error: string } {
  const tokenized = tokenizeArgs(argv, {
    booleanFlags: ["dry-run"],
    valueFlags: [
      "session-id",
      "context-id",
      "sessions-path",
      "db-path",
      "limit",
      "supported-phases",
    ],
  });
  if ("error" in tokenized) return { error: tokenized.error };
  const { args, flags } = tokenized;

  if (!args["session-id"] && !args["context-id"]) return { error: "--context-id or --session-id is required" };

  const limitRaw = args["limit"] ?? "100";
  const limit = Number(limitRaw);
  if (!Number.isInteger(limit) || limit <= 0) {
    return { error: `--limit must be a positive integer, got: ${limitRaw}` };
  }

  const supportedPhases = parseSupportedPhases(args["supported-phases"], DEFAULT_SUPPORTED_PHASES);
  if ("error" in supportedPhases) return supportedPhases;

  return {
    sessionId: args["session-id"],
    sessionsPath: args["sessions-path"] ?? DEFAULT_SESSIONS_PATH,
    dbPath: args["db-path"],
    limit,
    dryRun: flags.has("dry-run"),
    supportedPhases,
    contextId: args["context-id"],
  };
}

// ---------------------------------------------------------------------------
// Shared helpers
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
// gh CLI wrapper
// ---------------------------------------------------------------------------

export interface GhRunner {
  listIssues(repo: string, limit: number): GhIssue[];
}

export const defaultGhRunner: GhRunner = {
  listIssues(repo, limit) {
    const out = execFileSync(
      "gh",
      [
        "issue", "list",
        "--repo", repo,
        "--state", "open",
        "--limit", String(limit),
        "--json", "number,title,url,labels,body",
      ],
      { encoding: "utf8" },
    );
    return JSON.parse(out) as GhIssue[];
  },
};

/** Adapt a provider-layer `gh` executor into a `runGh(args) => stdout` callable. */
export function runGhViaRunner(
  runner: ProviderGhRunner,
  cwd: string,
): (args: string[]) => string {
  return (args) => {
    const r = runner.run(args, { cwd });
    if (r.exitCode !== 0) {
      throw new Error(`gh ${args.join(" ")} failed (exit ${r.exitCode}): ${(r.stderr || r.stdout).slice(0, 300)}`);
    }
    return r.stdout;
  };
}

/** Build an issue lister backed by a provider-layer `gh` executor (App-aware). */
function listIssuesViaRunner(runner: ProviderGhRunner, cwd: string): GhRunner {
  const runGh = runGhViaRunner(runner, cwd);
  return {
    listIssues(repo, limit) {
      const out = runGh([
        "issue", "list",
        "--repo", repo,
        "--state", "open",
        "--limit", String(limit),
        "--json", "number,title,url,labels,body",
      ]);
      return JSON.parse(out) as GhIssue[];
    },
  };
}

// ---------------------------------------------------------------------------
// Dependency checker — GitHub Issue Relationships via GraphQL
// ---------------------------------------------------------------------------

/**
 * Checks GitHub Issue Relationships (`blocked by`) via `gh api graphql`.
 *
 * Uses the `blockedBy` field on the GraphQL Issue type.
 *
 * If the field is unavailable (older GitHub Enterprise instance, or feature
 * disabled), the GraphQL response will contain errors.  The implementation
 * propagates those as a thrown error so the caller fails closed.
 *
 * Adapter seam: if `blockedBy` is not available, replace this class
 * with an implementation backed by an alternative data source and pass the
 * replacement into runIntake() as the depChecker argument.
 */
export class GraphQLDependencyChecker implements DependencyChecker {
  private readonly owner: string;
  private readonly repo: string;

  constructor(
    githubRepo: string,
    private readonly runGh: (args: string[]) => string = (args) =>
      execFileSync("gh", args, { encoding: "utf8" }),
  ) {
    const slash = githubRepo.indexOf("/");
    if (slash < 0) throw new Error(`Invalid repo format: ${githubRepo}`);
    this.owner = githubRepo.slice(0, slash);
    this.repo = githubRepo.slice(slash + 1);
  }

  async getBlockedBy(issueNumber: number): Promise<BlockedByEntry[]> {
    const query = `
      query IssueBlockedBy($owner: String!, $name: String!, $number: Int!, $after: String) {
        repository(owner: $owner, name: $name) {
          issue(number: $number) {
            blockedBy(first: 50, after: $after) {
              nodes {
                number
                state
                stateReason
              }
              pageInfo {
                hasNextPage
                endCursor
              }
            }
          }
        }
      }
    `;

    type IssueRelationshipsPage = {
      nodes?: Array<{ number?: number; state?: string; stateReason?: string | null }>;
      pageInfo?: { hasNextPage: boolean; endCursor?: string | null };
    };
    type GraphQLResponse = {
      data?: { repository?: { issue?: { blockedBy?: IssueRelationshipsPage } } };
      errors?: Array<{ message: string }>;
    };

    const allNodes: Array<{ number?: number; state?: string; stateReason?: string | null }> = [];
    let cursor: string | null = null;

    do {
      const args = [
        "api", "graphql",
        "-f", `query=${query}`,
        "-f", `owner=${this.owner}`,
        "-f", `name=${this.repo}`,
        "-F", `number=${issueNumber}`,
      ];
      if (cursor !== null) {
        args.push("-f", `after=${cursor}`);
      }

      const out = this.runGh(args);
      const response = JSON.parse(out) as GraphQLResponse;

      if (response.errors?.length) {
        throw new Error(`GraphQL error: ${response.errors.map((e) => e.message).join("; ")}`);
      }

      const rel = response.data?.repository?.issue?.blockedBy;
      allNodes.push(...(rel?.nodes ?? []));

      const pageInfo = rel?.pageInfo;
      cursor = pageInfo?.hasNextPage ? (pageInfo.endCursor ?? null) : null;
    } while (cursor !== null);

    return allNodes
      .map((n) => {
        if (typeof n.number !== "number") return null;
        const state = n.state?.toUpperCase() === "CLOSED" ? "closed" : "open";
        const entry: BlockedByEntry = { issueNumber: n.number, state };
        if (state === "closed" && n.stateReason !== undefined) {
          const r = n.stateReason?.toLowerCase();
          entry.stateReason =
            r === "not_planned" ? "not_planned" : r === "completed" ? "completed" : null;
        }
        return entry;
      })
      .filter((e): e is BlockedByEntry => e !== null);
  }
}

// ---------------------------------------------------------------------------
// Main (exported for testing with a fake gh runner and dep checker)
// ---------------------------------------------------------------------------

/**
 * Injectable dependencies for the non-GitHub (Gitea) intake path. Tests pass a
 * fake HTTP transport and an env map so the Gitea provider can be driven without
 * a live Gitea server or a real environment variable; production passes none.
 */
export interface IntakeDeps {
  giteaHttp?: GiteaHttpRequest;
  env?: NodeJS.ProcessEnv;
  resolveKey?: (key: string) => string;
}

/** Adapt a provider {@link WorkItem} to the intake {@link GhIssue} shape. */
function workItemToGhIssue(w: WorkItem): GhIssue {
  return {
    number: w.number,
    title: w.title,
    url: w.url,
    labels: w.labels.map((name) => ({ name })),
    ...(w.body !== undefined ? { body: w.body } : {}),
  };
}

export async function runIntake(
  args: CliArgs,
  gh?: GhRunner,
  depChecker?: DependencyChecker,
  stackReadyResolver?: StackReadyResolver,
  deps?: IntakeDeps,
): Promise<void> {
  // Resolve sessionId: use --session-id directly, or look it up from the context store
  let sessionId: string;
  if (args.sessionId) {
    sessionId = args.sessionId;
  } else {
    const ctxStore = new SqliteContextStore(args.dbPath);
    let fromStore: string | undefined;
    try {
      fromStore = ctxStore.getSessionId(args.contextId as string);
    } finally {
      ctxStore.close();
    }
    if (!fromStore) die(`Unknown contextId: ${args.contextId}`);
    sessionId = fromStore;
  }

  let registry: JsonSessionRegistry;
  try {
    registry = new JsonSessionRegistry(args.sessionsPath);
  } catch (err) {
    die(`Failed to load sessions file (${args.sessionsPath}): ${err instanceof Error ? err.message : String(err)}`);
  }

  const session = await registry.getSessionById(sessionId);
  if (!session) {
    die(`Unknown sessionId: ${sessionId} (not found in ${args.sessionsPath})`);
  }

  const workItemKind = session.workItemProvider?.provider ?? "github-issues";

  let issues: GhIssue[];
  let effectiveDepChecker: DependencyChecker | undefined;
  let effectiveStackReadyResolver: StackReadyResolver | undefined;

  if (workItemKind === "gitea-issues") {
    // Gitea path: list candidates and dependency relationships through the Gitea
    // WorkItemProvider over its REST API — never GitHub. The api-token is resolved
    // by indirection (env var / credential key); a GitHub `gh` runner is never
    // resolved here (it would fail closed for api-token), so a Gitea session never
    // silently reads GitHub issues. Tests inject `deps.giteaHttp` + `deps.env`.
    const gitea = session.workItemProvider?.gitea;
    if (!gitea) {
      die(`Session ${session.sessionId} selects gitea-issues but is missing the gitea connection block`);
    }
    let provider: GiteaWorkItemProvider;
    try {
      const token = resolveGiteaToken(session.workItemProvider!.auth, {
        env: deps?.env,
        resolveKey: deps?.resolveKey,
      });
      provider = new GiteaWorkItemProvider({
        baseUrl: gitea!.baseUrl,
        owner: gitea!.owner,
        repo: gitea!.repo,
        token,
        ...(gitea!.apiPath !== undefined ? { apiPath: gitea!.apiPath } : {}),
        ...(deps?.giteaHttp ? { http: deps.giteaHttp } : {}),
      });
    } catch (err) {
      die(`Failed to resolve Gitea provider auth: ${redactGiteaSecrets(err instanceof Error ? err.message : String(err), [])}`);
    }
    try {
      issues = gh
        ? gh.listIssues(session.githubRepo, args.limit)
        : provider!.listCandidateItems(args.limit).map(workItemToGhIssue);
    } catch (err) {
      die(`Gitea issue list failed: ${redactGiteaSecrets(err instanceof Error ? err.message : String(err), [])}`);
    }
    // Honor native Gitea issue dependencies. There is no GitHub-style stack-ready
    // resolver for a Gitea session (PRs live on the repo host), so the single-open-
    // blocker stackable case stays held at intake (fail closed) unless a resolver
    // is explicitly injected.
    effectiveDepChecker = depChecker ?? { getBlockedBy: (n) => provider!.getDependencies(n) };
    effectiveStackReadyResolver = stackReadyResolver;
  } else {
    // GitHub work-item path: work items come from GitHub Issues, while the repo
    // host may still be GitHub or Gitea.
    //
    // Resolve the session's providers for the configured auth so that every intake
    // read (issue list, dependency relationships, and the dependency-plan
    // resolver's PR/issue reads) runs under the right identity. These must be
    // resolved BEFORE the first read: a `github-app` session has no authenticated
    // operator `gh`, so listing issues or checking dependencies with the raw `gh`
    // would fail or read as the wrong identity. Resolved once and reused across
    // per-issue resolver calls; the runner refreshes its token per invocation.
    //
    // The repo host routes through the session's configured provider rather than an
    // unconditional `gh` runner: a `gitea` repo host resolves to the REST-backed
    // provider and never calls `resolveGhRunner`, so the advertised GitHub
    // work-items + Gitea repo-host configuration (with `api-token` auth) no longer
    // fails intake with "unsupported GitHub auth". A `github` repo host resolves its
    // `gh`/App runner exactly as before, so GitHub behavior is unchanged.
    let sessionRepoHost: SessionRepoHost;
    let workItemRunner: ProviderGhRunner;
    try {
      const cmdGhRunner = ghRunnerFromCommandRunner(defaultCommandRunner);
      sessionRepoHost = await resolveSessionRepoHost(session.repoHostProvider, {
        githubRepo: session.githubRepo,
        cwd: session.repoRoot,
        ghRunnerFallback: cmdGhRunner,
      });
      workItemRunner = await resolveGhRunner(session.workItemProvider?.auth ?? { mode: "gh" }, cmdGhRunner);
    } catch (err) {
      die(`Failed to resolve provider auth: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Fetch open issues from GitHub. Tests may inject a `gh` lister; otherwise list
    // through the resolved work-item runner so App-auth sessions read as the App.
    const issueLister = gh ?? listIssuesViaRunner(workItemRunner, session.repoRoot);
    try {
      issues = issueLister.listIssues(session.githubRepo, args.limit);
    } catch (err) {
      die(`gh command failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Use the provided checker or default to a GraphQL-based checker backed by the
    // work-item runner, so `blocked by` relationship reads also run as the App.
    effectiveDepChecker =
      depChecker ?? new GraphQLDependencyChecker(session.githubRepo, runGhViaRunner(workItemRunner, session.repoRoot));

    // Gate 2 stack-readiness: a dependent issue with a single open blocker is only
    // enqueued once that blocker has a usable PR head to stack on. Consult the full
    // dependency-plan resolver so dependents whose blocker is still unimplemented or
    // unreviewed stay held at intake instead of being enqueued and then terminally
    // blocked by the implementation handler (issue #208 review follow-up).
    const githubDepChecker = effectiveDepChecker;
    effectiveStackReadyResolver =
      stackReadyResolver ??
      (async (issueNumber: number) => {
        const plan = await resolveDependencyExecutionPlan(issueNumber, {
          depChecker: githubDepChecker,
          runner: defaultCommandRunner,
          // Route the blocker PR lookup through the session's resolved repo host so a
          // `gitea` repo host reads blocker PRs over the Gitea REST API; for `github`
          // this is the same `gh`-backed provider the plan would build itself.
          repoHost: sessionRepoHost.provider,
          workItemRunner,
          githubRepo: session.githubRepo,
          cwd: session.repoRoot,
          readyForHumanLabel: session.labels.readyForHuman,
          stackReadyLabel: session.labels["stackReady"] ?? "status:stack-ready",
        });
        return plan.kind === "ready";
      });
  }

  const allCandidates = await parseCandidates(issues, effectiveDepChecker, effectiveStackReadyResolver);
  const effectivePhases = args.supportedPhases ?? DEFAULT_SUPPORTED_PHASES;
  const candidates = allCandidates.filter((c) => effectivePhases.includes(c.phase));
  const now = new Date().toISOString();

  const results: Array<Record<string, unknown>> = [];
  let enqueuedCount = 0;
  let alreadyExistsCount = 0;

  if (!args.dryRun) {
    const store = new SqliteTaskStore(args.dbPath);
    const outboxStore = new SqliteOutboxStore(args.dbPath);
    // Route reactivation side effects through the session's work-item provider.
    // For a GitHub session this is a no-op passthrough (legacy `gh:label:*`
    // topics, GitHub owner/repo — unchanged). For a non-GitHub provider (e.g.
    // `gitea-issues`) each `gh:label:*` enqueue is rewritten to a provider-neutral
    // `workitem:transition` row targeting the work-item repo, so the blocked label
    // is cleared on the Gitea issue at dispatch instead of being stranded behind
    // the dispatcher's failing GitHub work-item path.
    const workItemOutboxStore = workItemOutbox(outboxStore, session);
    try {
      for (const candidate of candidates) {
        const result = await store.enqueueTask({
          sessionId,
          issueNumber: candidate.issueNumber,
          phase: candidate.phase,
          implementationAgent: candidate.implementationAgent,
          reviewAgent: candidate.reviewAgent,
          researchAgent: candidate.researchAgent,
          context: {
            title: candidate.title,
            url: candidate.url,
            labels: candidate.labels,
            ...(candidate.body !== undefined ? { body: candidate.body } : {}),
            intakeAt: now,
            // trusted issue labels at intake. Label-derived agents (from labelsToPhase)
            // are passed as overrides so explicit agent labels are honored
            // over the session's built-in default (issue #260). Persisted verbatim so
            // later edits to sessions.json never change this task's agents (issue #259).
            assignment: resolveAssignment(session, candidate.labels, now, {
              ...(candidate.implementationAgent !== undefined ? { implementationAgent: candidate.implementationAgent } : {}),
              ...(candidate.reviewAgent !== undefined ? { reviewAgent: candidate.reviewAgent } : {}),
              ...(candidate.researchAgent !== undefined ? { researchAgent: candidate.researchAgent } : {}),
            }),
            ...(candidate.implementationMode !== undefined
              ? { implementationMode: candidate.implementationMode }
              : {}),
            ...(candidate.dependencyDecision
              ? { dependencyDecision: candidate.dependencyDecision }
              : {}),
          },
        });

        if (result.ok) {
          enqueuedCount++;
          results.push({ issueNumber: candidate.issueNumber, action: result.reactivated ? "reactivated" : "enqueued", phase: candidate.phase });
          // When a dependency-blocked implementation task is reactivated, clear the
          // blocked label that was added when the handler returned `blocked`. The
          // store reactivation only flips the DB row back to `queued`; without this
          // effect the issue would carry ai:blocked while implementation proceeds
          // or review runs (issue #224).
          if (result.reactivated) {
            const blockedLabel = session.labels.blocked;
            // Enqueue through the work-item-aware store so a non-GitHub session
            // (e.g. `gitea-issues`) clears the blocked label on its own work-item
            // repo. The `owner`/`repo` below are the GitHub identifiers used by the
            // unchanged GitHub path; the wrapper overrides them with the work-item
            // repo for a non-GitHub provider.
            await workItemOutboxStore.enqueue({
              idempotencyKey: makeOutboxKey(sessionId, candidate.issueNumber, "intake-reactivate", now, "gh:label:remove", blockedLabel),
              topic: "gh:label:remove",
              payload: { topic: "gh:label:remove", owner: session.githubOwner, repo: session.githubName, issueNumber: candidate.issueNumber, label: blockedLabel },
              now,
            });
          }
        } else {
          alreadyExistsCount++;
          results.push({ issueNumber: candidate.issueNumber, action: "already_exists", phase: candidate.phase });
        }
      }
    } finally {
      store.close();
      outboxStore.close();
    }
  } else {
    for (const candidate of candidates) {
      results.push({ issueNumber: candidate.issueNumber, action: "dry_run", phase: candidate.phase, title: candidate.title });
    }
  }

  const ctx = args.contextId !== undefined ? { contextId: args.contextId } : {};
  emit({
    ok: true,
    sessionId,
    ...ctx,
    repo: session.githubRepo,
    supportedPhases: effectivePhases,
    scanned: issues.length,
    candidates: candidates.length,
    enqueued: enqueuedCount,
    alreadyExists: alreadyExistsCount,
    dryRun: args.dryRun,
    results,
  });
}

// ---------------------------------------------------------------------------
// Entrypoint — only run when executed directly, not when imported in tests
// ---------------------------------------------------------------------------

import { fileURLToPath } from "url";

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const parsed = parseArgs(process.argv.slice(2));
  if ("error" in parsed) die(parsed.error);

  runIntake(parsed).catch((err) => {
    die(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
  });
}
