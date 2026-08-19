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
import {
  JsonSessionRegistry,
  DEFAULT_SESSIONS_PATH,
  describeUnresolvedSessionId,
} from "../registries/json-session-registry.js";
import { SqliteTaskStore } from "../stores/sqlite-task-store.js";
import { SqliteOutboxStore } from "../stores/sqlite-outbox-store.js";
import { SqliteContextStore } from "../stores/sqlite-context-store.js";
import { makeOutboxKey } from "../core/outbox.js";
import type { OutboxStore } from "../core/outbox.js";
import { workItemOutbox } from "../core/outbox-effects.js";
import { parseCandidates } from "../core/github-intake.js";
import { resolveAssignment } from "../core/assignment.js";
import type { ResolvedAssignment } from "../core/assignment.js";
import type { GhIssue, DependencyChecker, BlockedByEntry, StackReadyResolver, IssueCandidateWithDecision, DependencyDecision, RefinementIntakeRefusal } from "../core/github-intake.js";
import {
  REFINEMENT_CONTEXT_KEY,
  REFINEMENT_EXECUTION_CONFLICT_KEY,
  REFINEMENT_EXECUTION_SUSPENDED_EVENT,
  buildRefinementContextBlock,
  buildRefinementExecutionConflict,
  describeRefinementExecutionConflict,
  implementationLaneAgentLabel,
  isSuspendableForRefinement,
  resolveIssueRefinementSettings,
  resolveRefinementLabels,
} from "../core/issue-refinement.js";
import { SqliteChainRegistryStore } from "../stores/sqlite-chain-registry-store.js";
import { acceptChainGraph, collectChainOwnership } from "../core/chain-acceptance.js";
import { buildFrozenPrefix, checkFrozenPrefixes } from "../core/chain-frozen-prefix.js";
import type { ChainBaseDecision, FrozenPrefixSnapshot } from "../core/chain-frozen-prefix.js";
import type { ChainGraph } from "../core/chain-registry.js";
import type { ChainOwnershipEntry } from "../core/chain-graph.js";
import type { ChainSyncRefusalKind } from "../core/chain-sync.js";
import {
  chainIntakeRefusalFingerprint,
  formatChainIntakeErrorComment,
  frozenPrefixChainIntakeRefusal,
  planChainIntake,
  resolveChainIntakeTarget,
  structuralChainIntakeRefusal,
} from "../core/chain-intake.js";
import type { ChainIntakeRefusal } from "../core/chain-intake.js";
import type { ResolvedSession } from "../core/session.js";
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
import { REPORT_ONLY_BLOCKED_PHASES, describeReportOnlyDeferral } from "../handlers/report-only-admission.js";
import { emit, die } from "./cli-io.js";
import { tokenizeArgs } from "./admin-command.js";

// `refinement` is accepted here so the generated child workflow can pass ONE
// phase list to both intake and run-one-phase (issue #869). Admission of
// refinement candidates does not depend on it — they are exempt from the
// supported-phase filter below — but a list containing it must not be refused.
const ALL_PHASES = new Set<TaskPhase>([
  "implementation", "review", "conflict_resolution", "research", "content_research", "content_draft", "content_review", "planner", "refinement",
]);
const DEFAULT_SUPPORTED_PHASES: TaskPhase[] = ["research", "content_research"];

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
// Incremental chain registration (issue #790)
// ---------------------------------------------------------------------------

/**
 * The stacked-base facts captured while Gate 2 resolved a candidate's blocker,
 * keyed by the candidate's Issue number. Recorded by the default stack-ready
 * resolver so the frozen base decision names the blocker PR's real head ref;
 * an injected test resolver records nothing and the base falls back to the
 * conventional `ai/issue-<blocker>` branch name.
 */
type StackBaseFacts = ReadonlyMap<number, { baseIssueNumber: number; baseHeadRefName: string }>;

interface ChainIntakeCtx {
  sessionId: string;
  session: ResolvedSession;
  registry: SqliteChainRegistryStore;
  /** Work-item-aware outbox: effects land on the session's work-item repo. */
  outbox: OutboxStore;
  now: string;
  stackBases: StackBaseFacts;
}

type ChainRegistrationOutcome =
  /** The registry reflects the candidate; freeze-and-enqueue may proceed. */
  | { kind: "registered"; snapshot: FrozenPrefixSnapshot }
  /** Nothing was learned; nothing was changed or published. Retried next poll. */
  | { kind: "transient"; message: string }
  /** A durable refusal: no enqueue, prior graph preserved, effects published once. */
  | { kind: "blocked"; refusalKind: ChainSyncRefusalKind; message: string; fingerprint: string; commented: boolean };

/** Observed blockers that count as ancestry: everything not abandoned as `not_planned`. */
function observedAncestryBlockers(decision: DependencyDecision): number[] {
  return decision.blockedBy
    .filter((b) => !(b.state === "closed" && b.stateReason === "not_planned"))
    .map((b) => b.issueNumber);
}

/**
 * The base decision the candidate's task will start under. A candidate that
 * passed the dependency gate while still blocked did so through Gate 2 —
 * exactly one open, stack-ready blocker — so its work stacks on that blocker's
 * PR head; every other candidate branches from the session base.
 */
function resolveIntakeBaseDecision(
  candidate: IssueCandidateWithDecision,
  decision: DependencyDecision,
  ctx: ChainIntakeCtx,
): ChainBaseDecision {
  const openBlockers = decision.blockedBy.filter((b) => b.state === "open");
  if (decision.blocked && openBlockers.length === 1) {
    const stack = ctx.stackBases.get(candidate.issueNumber);
    return {
      kind: "stacked",
      baseRef: stack?.baseHeadRefName ?? `ai/issue-${openBlockers[0].issueNumber}`,
      baseIssueNumber: stack?.baseIssueNumber ?? openBlockers[0].issueNumber,
    };
  }
  return { kind: "default", baseRef: ctx.session.baseBranch ?? "main" };
}

/**
 * Publish a durable refusal exactly once per distinct failure.
 *
 * Idempotency is layered: the outbox rows are keyed on the refusal
 * fingerprint (a repeated enqueue is INSERT OR IGNORE), and the persisted
 * error record short-circuits the whole publication when the stored
 * fingerprint matches — so a poll that recomputes the same failure enqueues
 * nothing and the Issue receives one `blocked` label and one comment. The
 * record is written LAST: a crash after the effects but before the record
 * re-enqueues the same idempotency keys next poll (harmless), while the
 * reverse order could record a failure whose explanation never got out.
 */
async function publishChainIntakeRefusal(
  candidate: IssueCandidateWithDecision,
  observedBlockers: readonly number[],
  expectedBlockers: readonly number[] | undefined,
  refusal: ChainIntakeRefusal,
  ctx: ChainIntakeCtx,
): Promise<ChainRegistrationOutcome> {
  if (refusal.transient) return { kind: "transient", message: refusal.message };

  const fingerprint = chainIntakeRefusalFingerprint({
    issueNumber: candidate.issueNumber,
    observedBlockers,
    refusal,
  });
  let commented = false;
  try {
    const stored = await ctx.registry.getChainIntakeError({
      sessionId: ctx.sessionId,
      issueNumber: candidate.issueNumber,
    });
    if (stored?.fingerprint !== fingerprint) {
      const blockedLabel = ctx.session.labels.blocked;
      await ctx.outbox.enqueue({
        idempotencyKey: makeOutboxKey(
          ctx.sessionId, candidate.issueNumber, "chain-intake", fingerprint, "gh:label:add", blockedLabel,
        ),
        topic: "gh:label:add",
        payload: {
          topic: "gh:label:add",
          owner: ctx.session.githubOwner,
          repo: ctx.session.githubName,
          issueNumber: candidate.issueNumber,
          label: blockedLabel,
        },
        now: ctx.now,
      });
      await ctx.outbox.enqueue({
        idempotencyKey: makeOutboxKey(
          ctx.sessionId, candidate.issueNumber, "chain-intake", fingerprint, "gh:comment",
        ),
        topic: "gh:comment",
        payload: {
          topic: "gh:comment",
          owner: ctx.session.githubOwner,
          repo: ctx.session.githubName,
          issueNumber: candidate.issueNumber,
          body: formatChainIntakeErrorComment({
            issueNumber: candidate.issueNumber,
            observedBlockers,
            ...(expectedBlockers !== undefined ? { expectedBlockers } : {}),
            refusal,
            fingerprint,
          }),
        },
        now: ctx.now,
      });
      await ctx.registry.putChainIntakeError({
        sessionId: ctx.sessionId,
        issueNumber: candidate.issueNumber,
        fingerprint,
        kind: refusal.kind,
        message: refusal.message,
        createdAt: ctx.now,
      });
      commented = true;
    }
  } catch {
    // Publication is best-effort: the refusal itself already holds the task
    // back, and the next poll retries with the same idempotency keys.
  }
  return { kind: "blocked", refusalKind: refusal.kind, message: refusal.message, fingerprint, commented };
}

/**
 * Clear a previously published chain-intake error once the candidate
 * registers cleanly again. The `blocked` label is removed only when nothing
 * else still requires it: a reactivated task already gets the issue-#224
 * removal, and a task sitting in `blocked` status still owns the label.
 */
async function clearResolvedChainIntakeError(
  issueNumber: number,
  ctx: ChainIntakeCtx,
  skipLabelRemove: boolean,
): Promise<void> {
  try {
    const key = { sessionId: ctx.sessionId, issueNumber };
    const stored = await ctx.registry.getChainIntakeError(key);
    if (!stored) return;
    if (!skipLabelRemove) {
      // Queue the removal before deleting the record: outbox.enqueue throws
      // under a maintenance lock, and once the record is gone no later poll
      // would retry the removal. A retained record retries with the same
      // idempotency key, so a delete failure after enqueue cannot duplicate.
      const blockedLabel = ctx.session.labels.blocked;
      await ctx.outbox.enqueue({
        idempotencyKey: makeOutboxKey(
          ctx.sessionId, issueNumber, "chain-intake-resolved", stored.fingerprint, "gh:label:remove", blockedLabel,
        ),
        topic: "gh:label:remove",
        payload: {
          topic: "gh:label:remove",
          owner: ctx.session.githubOwner,
          repo: ctx.session.githubName,
          issueNumber,
          label: blockedLabel,
        },
        now: ctx.now,
      });
    }
    await ctx.registry.deleteChainIntakeError(key);
  } catch {
    // Cleanup is best-effort: a leftover record only suppresses a comment the
    // Issue has already received, and the next successful poll retries.
  }
}

/**
 * Candidate-scoped chain registration (issue #790): resolve the candidate's
 * observed direct blockers against the registry, decide new-chain / extend /
 * refuse through the #890 and #891 layers, apply the acceptance, and derive
 * the frozen-prefix snapshot the enqueue will commit with.
 *
 * Every failure is routed one of two ways. Transient (registry unreadable, a
 * lost compare-and-set, a store error) → nothing written, nothing published,
 * the candidate is skipped this poll — the poll cadence IS the retry/delay
 * behavior. Durable (structural or frozen-prefix) → the last-known-good graph
 * is preserved, no task is enqueued, and the refusal is published once.
 */
async function registerCandidateChain(
  candidate: IssueCandidateWithDecision,
  decision: DependencyDecision,
  ctx: ChainIntakeCtx,
): Promise<ChainRegistrationOutcome> {
  const issueNumber = candidate.issueNumber;
  const observedBlockers = observedAncestryBlockers(decision);

  // Gather: candidate-scoped registry reads only. Failures here say nothing
  // about the graph, so they stay transient.
  let target: ReturnType<typeof resolveChainIntakeTarget>;
  let targetGraph: ChainGraph | undefined;
  let frozenSnapshots: FrozenPrefixSnapshot[];
  let ownership: ChainOwnershipEntry[];
  try {
    const candidateChains = await ctx.registry.listChainsForIssue(issueNumber, { sessionId: ctx.sessionId });
    const blockerChainIds: Array<{ issueNumber: number; chainIds: string[] }> = [];
    for (const blocker of [...new Set(observedBlockers)]) {
      const chains = await ctx.registry.listChainsForIssue(blocker, { sessionId: ctx.sessionId });
      blockerChainIds.push({ issueNumber: blocker, chainIds: chains.map((c) => c.chainId) });
    }
    target = resolveChainIntakeTarget({
      issueNumber,
      candidateChainIds: candidateChains.map((c) => c.chainId),
      blockerChainIds,
    });
    if (target.kind === "extend") {
      targetGraph = await ctx.registry.getChain(target.chainId);
      if (!targetGraph) {
        return { kind: "transient", message: `chain ${target.chainId} disappeared mid-intake` };
      }
      frozenSnapshots = await ctx.registry.listFrozenPrefixes({ chainId: target.chainId });
    } else {
      frozenSnapshots = [];
    }
    const involved = [
      ...new Set([issueNumber, ...observedBlockers, ...(targetGraph?.members.map((m) => m.issueNumber) ?? [])]),
    ];
    ownership = await collectChainOwnership(ctx.registry, involved, {
      filter: { sessionId: ctx.sessionId },
      ...(target.kind === "extend" ? { excludeChainId: target.chainId } : {}),
    });
  } catch (err) {
    return { kind: "transient", message: err instanceof Error ? err.message : String(err) };
  }

  const expectedBlockers = targetGraph?.edges
    .filter((e) => e.blockedIssueNumber === issueNumber)
    .map((e) => e.blockerIssueNumber);

  const plan = planChainIntake({
    issueNumber,
    observedBlockers,
    target:
      target.kind === "extend"
        ? {
            kind: "extend",
            chainId: target.chainId,
            headIssueNumber: targetGraph!.chain.headIssueNumber,
            members: targetGraph!.members.map((m) => ({ issueNumber: m.issueNumber, role: m.role })),
            edges: targetGraph!.edges.map((e) => ({
              blockerIssueNumber: e.blockerIssueNumber,
              blockedIssueNumber: e.blockedIssueNumber,
            })),
          }
        : target,
    frozenSnapshots,
    ownership,
    providerErrors: [],
  });
  if (plan.action === "refuse") {
    return publishChainIntakeRefusal(candidate, observedBlockers, expectedBlockers, plan, ctx);
  }

  // Apply. A create allocates the chain first; acceptance then validates and
  // commits the pointer under the store's own ownership claim and frozen-
  // prefix commit guard, so plan-time reads going stale loses the CAS instead
  // of corrupting the graph.
  let chainId: string;
  let expectedRev: number;
  try {
    if (plan.mode === "create") {
      const created = await ctx.registry.createChain({
        sessionId: ctx.sessionId,
        headIssueNumber: plan.headIssueNumber,
        members: plan.members,
        edges: plan.edges,
        source: "github-intake",
        now: ctx.now,
      });
      if (!created.ok) {
        return {
          kind: "transient",
          message: `chain create refused (${created.code})${created.detail ? `: ${created.detail}` : ""}`,
        };
      }
      chainId = created.value.chain.chainId;
      expectedRev = created.value.chain.rev;
    } else {
      chainId = plan.chainId!;
      expectedRev = targetGraph!.chain.rev;
    }

    const candidateSnapshot = { members: plan.members, edges: plan.edges };
    const acceptance = await acceptChainGraph(ctx.registry, {
      chainId,
      members: plan.members,
      edges: plan.edges,
      expectedRev,
      ownershipScope: { sessionId: ctx.sessionId },
      commitGuard: (guardCtx) => {
        const verdict = checkFrozenPrefixes({
          candidate: candidateSnapshot,
          snapshots: guardCtx.frozenPrefixes,
          chainId,
        });
        if (verdict.ok) return undefined;
        return `a frozen dependency prefix refuses the candidate graph (${verdict.violations.length} finding(s))`;
      },
      source: "github-intake",
      now: ctx.now,
    });

    switch (acceptance.status) {
      case "accepted":
      case "unchanged": {
        const snapshot = buildFrozenPrefix({
          sessionId: ctx.sessionId,
          issueNumber,
          chainId,
          graph: candidateSnapshot,
          graphRevision: acceptance.acceptedRevision,
          graphFingerprint: acceptance.fingerprint,
          base: resolveIntakeBaseDecision(candidate, decision, ctx),
          source: "github-intake",
          frozenAt: ctx.now,
        });
        return { kind: "registered", snapshot };
      }
      case "rejected":
        return publishChainIntakeRefusal(
          candidate,
          observedBlockers,
          expectedBlockers,
          structuralChainIntakeRefusal(issueNumber, acceptance.diagnostics),
          ctx,
        );
      case "vetoed":
        return publishChainIntakeRefusal(
          candidate,
          observedBlockers,
          expectedBlockers,
          frozenPrefixChainIntakeRefusal(issueNumber, { message: acceptance.detail }),
          ctx,
        );
      case "conflict":
        return { kind: "transient", message: `chain ${chainId} moved mid-intake: ${acceptance.detail}` };
      case "failed":
        return {
          kind: "transient",
          message: `chain acceptance failed (${acceptance.code})${acceptance.detail ? `: ${acceptance.detail}` : ""}`,
        };
    }
  } catch (err) {
    return { kind: "transient", message: err instanceof Error ? err.message : String(err) };
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
    die(describeUnresolvedSessionId(registry, sessionId, args.sessionsPath));
  }

  const workItemKind = session.workItemProvider?.provider ?? "github-issues";

  let issues: GhIssue[];
  let effectiveDepChecker: DependencyChecker | undefined;
  let effectiveStackReadyResolver: StackReadyResolver | undefined;
  // Stacked-base facts observed by the default Gate-2 resolver, consumed by
  // chain registration so the frozen base decision names the blocker PR's
  // real head ref (issue #790).
  const stackBases = new Map<number, { baseIssueNumber: number; baseHeadRefName: string }>();

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
        if (plan.kind === "ready") {
          stackBases.set(issueNumber, {
            baseIssueNumber: plan.baseIssueNumber,
            baseHeadRefName: plan.baseHeadRefName,
          });
        }
        return plan.kind === "ready";
      });
  }

  // Chain-aware progressive Issue refinement (issue #867). Resolved once per
  // poll: `enabled: false` (the default) makes `status:needs-refinement` inert
  // and leaves every routing decision below byte-identical to today.
  const refinementResolution = resolveIssueRefinementSettings(session.issueRefinement);
  if (!refinementResolution.ok) {
    die(
      `Invalid issueRefinement configuration for session ${session.sessionId}: `
      + refinementResolution.errors.map((e) => e.message).join("; "),
    );
  }
  const refinementSettings = refinementResolution.settings;
  const refinementLabels = resolveRefinementLabels(session.labels);
  const refinementRefusals: RefinementIntakeRefusal[] = [];

  const allCandidates = await parseCandidates(
    issues,
    effectiveDepChecker,
    effectiveStackReadyResolver,
    {
      enabled: refinementSettings.enabled,
      markerLabel: refinementLabels.marker,
      onRefusal: (refusal) => refinementRefusals.push(refusal),
    },
  );
  const effectivePhases = args.supportedPhases ?? DEFAULT_SUPPORTED_PHASES;
  // A refinement candidate is exempt from the supported-phase filter. That
  // filter answers "can THIS runner execute the phase?", and the refinement
  // admission of §12 row 1 is a property of the poll, not of the runner: it
  // creates the task row that carries the lane's state and never runs anything.
  // `issueRefinement.enabled` is the lane's single gate (§19), and requiring a
  // second one here would leave an enabled lane silently doing nothing.
  const candidates = allCandidates.filter(
    (c) => c.phase === "refinement" || effectivePhases.includes(c.phase),
  );
  const now = new Date().toISOString();

  const results: Array<Record<string, unknown>> = [];
  let enqueuedCount = 0;
  let alreadyExistsCount = 0;
  let reportOnlyDeferredCount = 0;
  let chainBlockedCount = 0;
  let chainDeferredCount = 0;
  let refinementAdmittedCount = 0;
  let refinementSuspendedCount = 0;
  const reportOnlyEnabled = session.reportOnly?.enabled === true;

  if (!args.dryRun) {
    const store = new SqliteTaskStore(args.dbPath);
    const outboxStore = new SqliteOutboxStore(args.dbPath);
    // Same file as the task store: chain registration (issue #790) and the
    // task/outbox writes share one durable backend, which is what lets the
    // enqueue-with-freeze commit atomically against the chain tables.
    const chainRegistry = new SqliteChainRegistryStore(args.dbPath);
    // Route reactivation side effects through the session's work-item provider.
    // For a GitHub session this is a no-op passthrough (legacy `gh:label:*`
    // topics, GitHub owner/repo — unchanged). For a non-GitHub provider (e.g.
    // `gitea-issues`) each `gh:label:*` enqueue is rewritten to a provider-neutral
    // `workitem:transition` row targeting the work-item repo, so the blocked label
    // is cleared on the Gitea issue at dispatch instead of being stranded behind
    // the dispatcher's failing GitHub work-item path.
    const workItemOutboxStore = workItemOutbox(outboxStore, session);
    const chainCtx: ChainIntakeCtx = {
      sessionId,
      session,
      registry: chainRegistry,
      outbox: workItemOutboxStore,
      now,
      stackBases,
    };
    // §3.1 — the marker also stops a task that ALREADY exists.
    //
    // Refusing admission decides only whether a NEW task is created; it does
    // nothing to the task an Issue already had when a human applied the marker,
    // and that is the ordinary case. Nothing downstream re-reads the Issue's
    // labels before a phase runs, so without this the runner would claim that
    // task and execute — and publish — against the rough contract the marker
    // exists to block, leaving the fail-closed guarantee holding for every Issue
    // except the half-transitioned ones it is for.
    //
    // The stop is the §13 handoff shape on a task that never entered the §12
    // state machine: `ready_for_human`, the `execution_marker_conflict` reason
    // persisted on the row, and `refinement.execution.suspended` — committed
    // together (`completePhaseWithEffects` with no effects) so the task can
    // never be parked with no record of why. No label is touched: the executable
    // `status:*` and the marker were both applied by an operator, and deciding
    // which wins is the human decision this handoff requests.
    //
    // A task already `claimed`/`running` is stopped cooperatively, exactly as
    // cancellation is: this transition wins the CAS, so the in-flight run's own
    // completion loses it and no-ops as `claim_lost` — and because a completion
    // commits its transition and its outbound effects in ONE transaction, that
    // run's comments, labels, and PR summaries roll back with it rather than
    // publishing. What it already pushed directly before the marker appeared is
    // out of scope (§3.1); the marker then simply blocks the next phase.
    //
    // This is the durable half of the guard, not all of it: the poll is the
    // first place the live labels are read, so a run that starts in the window
    // between an operator applying the marker and the next poll is stopped at
    // its completion boundary rather than before it starts. Closing that window
    // needs the runner's own pre-claim label re-read (§3.1, first bullet), which
    // belongs to the phase-runner slice; nothing here depends on it, and the
    // suspension is idempotent when both eventually run.
    const suspendLiveExecution = async (
      issueNumber: number,
      conflictingLabels: readonly string[],
    ): Promise<"suspended" | "not_applicable" | "deferred"> => {
      const key = { sessionId, issueNumber };
      const existing = await store.getTask(key);
      // Absent, already parked, or this lane's own row: nothing to stop. An
      // already-suspended row lands here on every later poll, which is what
      // makes the guard idempotent without a second marker of its own.
      if (!existing || !isSuspendableForRefinement(existing)) return "not_applicable";
      const conflict = buildRefinementExecutionConflict({
        markerLabel: refinementLabels.marker,
        conflictingLabels,
        previousStatus: existing.status,
        previousPhase: existing.phase,
        now,
      });
      const description = describeRefinementExecutionConflict(conflict);
      const suspended = await store.completePhaseWithEffects(
        {
          key,
          // Full CAS on what was just read: a claim, completion, or
          // cancellation landing in this window moves the revision, and the
          // refusal simply re-evaluates on the next poll against the row that
          // won.
          expected: {
            status: existing.status,
            phase: existing.phase,
            revision: existing.revision,
          },
          patch: {
            status: "ready_for_human",
            ownerRunId: undefined,
            leaseExpiresAt: undefined,
            notBefore: undefined,
            lastError: description,
            context: { [REFINEMENT_EXECUTION_CONFLICT_KEY]: conflict },
            now,
          },
          event: {
            task: key,
            type: REFINEMENT_EXECUTION_SUSPENDED_EVENT,
            message: description,
            data: {
              reason: conflict.reason,
              markerLabel: conflict.markerLabel,
              conflictingLabels: conflict.conflictingLabels,
              previousStatus: conflict.previousStatus,
              previousPhase: conflict.previousPhase,
              suspendedAt: conflict.suspendedAt,
            },
            createdAt: now,
          },
        },
        [],
      );
      if (suspended.ok) {
        refinementSuspendedCount++;
        results.push({
          issueNumber,
          action: "refinement_execution_suspended",
          phase: existing.phase,
          previousStatus: existing.status,
          markerLabel: refinementLabels.marker,
          reason: conflict.reason,
          ...(conflictingLabels.length > 0 ? { conflictingLabels: [...conflictingLabels] } : {}),
        });
        return "suspended";
      }
      // A raced transition or a held maintenance lock: nothing was written, and
      // the identical guard runs again on the next poll.
      results.push({
        issueNumber,
        action: "refinement_suspend_deferred",
        phase: existing.phase,
        reason: suspended.code,
      });
      return "deferred";
    };

    try {
      // Row 2 refusals first: those Issues produce no candidate at all, so this
      // is the only place their pre-existing task is reachable.
      for (const refusal of refinementRefusals) {
        if (refusal.reason !== "conflicting_markers") continue;
        await suspendLiveExecution(refusal.issueNumber, refusal.conflictingLabels);
      }

      for (const candidate of candidates) {
        // Resolve the assignment before any report-only deferral so an invalid
        // assignment profile (e.g. an unsupported conflict_resolution agent)
        // still fails intake the same way normal (non-report-only) intake does,
        // rather than being silently skipped by the deferral below (issue #532
        // review follow-up).
        let assignment: ResolvedAssignment;
        try {
          assignment = resolveAssignment(session, candidate.labels, now, {
            ...(candidate.implementationAgent !== undefined ? { implementationAgent: candidate.implementationAgent } : {}),
            ...(candidate.reviewAgent !== undefined ? { reviewAgent: candidate.reviewAgent } : {}),
            ...(candidate.researchAgent !== undefined ? { researchAgent: candidate.researchAgent } : {}),
          });
        } catch (err) {
          // Fail closed for the refinement lane specifically: an assignment the
          // session cannot resolve means the deferred implementation owner is
          // unknown, and admitting the Issue anyway would run the whole lane and
          // then activate implementation against an assignment nobody chose
          // (§14). It is reported as `no_implementation_agent` — the closed-set
          // refusal for "this Issue has no resolvable implementation owner" —
          // and repaired by fixing the session config, exactly like the label
          // shape row 47 covers. Every other phase keeps today's behavior: the
          // error propagates and fails the whole intake run.
          if (candidate.phase !== "refinement") throw err;
          refinementRefusals.push({
            issueNumber: candidate.issueNumber,
            title: candidate.title,
            reason: "no_implementation_agent",
            markerLabel: refinementLabels.marker,
            conflictingLabels: [],
          });
          continue;
        }

        // Refinement admission (§12 row 1). The task row is created with the
        // §15 state block and the §14 activation plan; nothing else in this
        // slice touches it. Chain registration is skipped deliberately: §18
        // makes the chain registry read-only from this lane, so refinement never
        // registers a member, adds an edge, or touches a frozen prefix.
        if (candidate.phase === "refinement") {
          const agentLabel = implementationLaneAgentLabel(candidate.labels)?.label;
          if (agentLabel === undefined) {
            // Admission already required one; refuse rather than persist an
            // activation plan that names a label the Issue does not carry.
            refinementRefusals.push({
              issueNumber: candidate.issueNumber,
              title: candidate.title,
              reason: "no_implementation_agent",
              markerLabel: refinementLabels.marker,
              conflictingLabels: [],
            });
            continue;
          }
          const refinementInput = {
            sessionId,
            issueNumber: candidate.issueNumber,
            phase: "refinement" as const,
            ...(candidate.implementationAgent !== undefined
              ? { implementationAgent: candidate.implementationAgent }
              : {}),
            context: {
              title: candidate.title,
              url: candidate.url,
              labels: candidate.labels,
              ...(candidate.body !== undefined ? { body: candidate.body } : {}),
              intakeAt: now,
              assignment,
              [REFINEMENT_CONTEXT_KEY]: buildRefinementContextBlock({
                issueNumber: candidate.issueNumber,
                title: candidate.title,
                ...(candidate.body !== undefined ? { body: candidate.body } : {}),
                labels: candidate.labels,
                agentLabel,
                // §14: the plan records the PINNED owner — the one persisted in
                // `context.assignment` — rather than re-reading the label. The
                // `agent:*` label seeded that assignment, so the two agree here;
                // recording the assignment's value is what keeps them from
                // diverging if an operator edits the label mid-lane, where §14
                // makes the label decide only THAT the row is picked up.
                implementationAgent: assignment.implementationAgent,
                ...(assignment.refinementAgent !== undefined
                  ? { refinerAgent: assignment.refinementAgent }
                  : {}),
                ...(assignment.refinementCriticAgent !== undefined
                  ? { criticAgent: assignment.refinementCriticAgent }
                  : {}),
                settings: refinementSettings,
                laneLabels: refinementLabels,
                now,
              }),
            },
          };

          // The Issue is cleanly marked, but it may still own a row from the
          // lane it just left. The three shapes are decided here rather than
          // left to `enqueueTask`, whose answers are wrong for all of them: it
          // would reactivate a `blocked` implementation/conflict_resolution row
          // in place — merging this lane's context over the old lane's keys and
          // RESTORING that row's pinned assignment, so the activation plan and
          // `context.assignment` would name different owners — and it answers
          // `already_exists` for every other row, which for a disposed one is a
          // dead end: rows are unique per (session, Issue) and a
          // cancelled/done/failed row is never reactivated, so the Issue could
          // never start this lane no matter how clean its labels became.
          const refinementKey = { sessionId, issueNumber: candidate.issueNumber };
          const existing = await store.getTask(refinementKey);

          if (existing !== undefined && isSuspendableForRefinement(existing)) {
            // Still live at an executable phase: stop it first (§3.1) and admit
            // nothing this poll. The row now belongs to a human, and the next
            // poll finds it parked and replaces it below — so the lane still
            // starts on its own, without this pass overwriting the handoff in
            // the same breath as raising it.
            const outcome = await suspendLiveExecution(candidate.issueNumber, []);
            if (outcome !== "not_applicable") continue;
          }

          if (existing !== undefined && existing.phase !== "refinement") {
            // Disposed of, parked, or finished under the OLD lane. Replace it
            // wholesale — a fresh `refinement` row with only this lane's
            // context — under a compare-and-set on what was just read, so a
            // concurrent claim or requeue is refused rather than overwritten.
            const replaced = await store.replaceTask(
              refinementInput,
              {
                status: existing.status,
                phase: existing.phase,
                revision: existing.revision,
              },
              {
                event: {
                  task: refinementKey,
                  type: "task.replaced",
                  message:
                    `Replaced ${existing.phase} task (${existing.status}) with a refinement task ` +
                    `for ${refinementLabels.marker}.`,
                  data: {
                    previousPhase: existing.phase,
                    previousStatus: existing.status,
                    phase: "refinement",
                    markerLabel: refinementLabels.marker,
                  },
                  createdAt: now,
                },
              },
            );
            if (replaced.ok) {
              enqueuedCount++;
              refinementAdmittedCount++;
              results.push({
                issueNumber: candidate.issueNumber,
                action: "replaced",
                phase: "refinement",
                previousPhase: existing.phase,
                previousStatus: existing.status,
              });
            } else {
              // Raced (or absent — the row was pruned since the read). Nothing
              // was written; the next poll re-observes and admits.
              results.push({
                issueNumber: candidate.issueNumber,
                action: "refinement_replace_deferred",
                phase: "refinement",
                reason: replaced.code,
              });
            }
            continue;
          }

          const admissionResult = await store.enqueueTask(refinementInput);
          if (admissionResult.ok) {
            enqueuedCount++;
            refinementAdmittedCount++;
            results.push({
              issueNumber: candidate.issueNumber,
              action: admissionResult.reactivated ? "reactivated" : "enqueued",
              phase: "refinement",
            });
          } else {
            // Idempotent intake: a repeated poll finds the refinement row and
            // leaves its persisted state untouched.
            alreadyExistsCount++;
            results.push({ issueNumber: candidate.issueNumber, action: "already_exists", phase: "refinement" });
          }
          continue;
        }
        // Report-only rollout mode (issue #532): a candidate that would run a
        // repo-mutating phase is never enqueued as that phase — intake still
        // found and analyzed the issue, but no implementation task, branch, or
        // PR is created. The candidate's message states what would have
        // happened under normal automation so the operator has a clear report.
        if (reportOnlyEnabled && REPORT_ONLY_BLOCKED_PHASES.has(candidate.phase)) {
          reportOnlyDeferredCount++;
          results.push({
            issueNumber: candidate.issueNumber,
            action: "report_only_deferred",
            phase: candidate.phase,
            title: candidate.title,
            message: describeReportOnlyDeferral(session, candidate.issueNumber, candidate.phase),
          });
          continue;
        }
        const enqueueInput = {
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
            assignment,
            ...(candidate.implementationMode !== undefined
              ? { implementationMode: candidate.implementationMode }
              : {}),
            ...(candidate.dependencyDecision
              ? { dependencyDecision: candidate.dependencyDecision }
              : {}),
          },
        };

        // Incremental chain registration (issue #790). Only a candidate whose
        // relationships were actually observed (a dependency checker ran) can
        // be registered — with no decision there is nothing to resolve against
        // the registry, so the pre-#790 enqueue path applies unchanged.
        if (candidate.dependencyDecision) {
          let registration: ChainRegistrationOutcome;
          try {
            registration = await registerCandidateChain(candidate, candidate.dependencyDecision, chainCtx);
          } catch (err) {
            registration = { kind: "transient", message: err instanceof Error ? err.message : String(err) };
          }
          if (registration.kind === "transient") {
            chainDeferredCount++;
            results.push({
              issueNumber: candidate.issueNumber,
              action: "chain_deferred",
              phase: candidate.phase,
              message: registration.message,
            });
            continue;
          }
          if (registration.kind === "blocked") {
            chainBlockedCount++;
            results.push({
              issueNumber: candidate.issueNumber,
              action: "chain_blocked",
              phase: candidate.phase,
              kind: registration.refusalKind,
              message: registration.message,
              commented: registration.commented,
            });
            continue;
          }

          const result = await store.enqueueTaskWithChainFreeze(enqueueInput, registration.snapshot);
          if (result.ok) {
            enqueuedCount++;
            results.push({
              issueNumber: candidate.issueNumber,
              action: result.reactivated ? "reactivated" : "enqueued",
              phase: candidate.phase,
            });
            if (result.reactivated) {
              // Same effect as the pre-#790 path below (issue #224): clear the
              // dependency-blocked label the terminal handoff applied.
              const blockedLabel = session.labels.blocked;
              await workItemOutboxStore.enqueue({
                idempotencyKey: makeOutboxKey(sessionId, candidate.issueNumber, "intake-reactivate", now, "gh:label:remove", blockedLabel),
                topic: "gh:label:remove",
                payload: { topic: "gh:label:remove", owner: session.githubOwner, repo: session.githubName, issueNumber: candidate.issueNumber, label: blockedLabel },
                now,
              });
            }
            await clearResolvedChainIntakeError(candidate.issueNumber, chainCtx, result.reactivated);
          } else if (result.code === "already_exists") {
            alreadyExistsCount++;
            results.push({ issueNumber: candidate.issueNumber, action: "already_exists", phase: candidate.phase });
            // A resolved chain error must not strand the blocked label — but
            // must not remove it either while the existing task's own state
            // still requires it.
            await clearResolvedChainIntakeError(
              candidate.issueNumber,
              chainCtx,
              result.current.status === "blocked",
            );
          } else if (result.code === "frozen_prefix_conflict") {
            const refusal = frozenPrefixChainIntakeRefusal(candidate.issueNumber, { message: result.detail });
            const published = await publishChainIntakeRefusal(
              candidate,
              observedAncestryBlockers(candidate.dependencyDecision),
              undefined,
              refusal,
              chainCtx,
            );
            chainBlockedCount++;
            results.push({
              issueNumber: candidate.issueNumber,
              action: "chain_blocked",
              phase: candidate.phase,
              kind: "frozen_prefix",
              message: refusal.message,
              commented: published.kind === "blocked" ? published.commented : false,
            });
          } else {
            chainDeferredCount++;
            results.push({
              issueNumber: candidate.issueNumber,
              action: "chain_deferred",
              phase: candidate.phase,
              message: result.detail ?? result.code,
            });
          }
          continue;
        }

        const result = await store.enqueueTask(enqueueInput);

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
      chainRegistry.close();
    }
  } else {
    for (const candidate of candidates) {
      // Mirror the report-only deferral classification used in the write path
      // above so `--dry-run` accurately previews what a live intake run would
      // do: a candidate whose phase would be blocked by report-only mode is
      // reported as `report_only_deferred` (not `dry_run`), with the same
      // count and message an operator would see without --dry-run (issue #532
      // review follow-up).
      if (reportOnlyEnabled && REPORT_ONLY_BLOCKED_PHASES.has(candidate.phase)) {
        reportOnlyDeferredCount++;
        results.push({
          issueNumber: candidate.issueNumber,
          action: "report_only_deferred",
          phase: candidate.phase,
          title: candidate.title,
          message: describeReportOnlyDeferral(session, candidate.issueNumber, candidate.phase),
        });
        continue;
      }
      results.push({ issueNumber: candidate.issueNumber, action: "dry_run", phase: candidate.phase, title: candidate.title });
    }
  }

  // §12 rows 2 and 47: an admission refusal creates no task, so the poll's own
  // output is where an operator sees it. The reason literal is the contract's,
  // verbatim, and the two are never merged: they are repaired by opposite label
  // edits (remove the executable status, or add an `agent:*` label).
  for (const refusal of refinementRefusals) {
    results.push({
      issueNumber: refusal.issueNumber,
      action: "refinement_refused",
      phase: "refinement",
      title: refusal.title,
      reason: refusal.reason,
      markerLabel: refusal.markerLabel,
      ...(refusal.conflictingLabels.length > 0 ? { conflictingLabels: refusal.conflictingLabels } : {}),
    });
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
    reportOnly: reportOnlyEnabled,
    reportOnlyDeferred: reportOnlyDeferredCount,
    chainBlocked: chainBlockedCount,
    chainDeferred: chainDeferredCount,
    refinementEnabled: refinementSettings.enabled,
    refinementAdmitted: refinementAdmittedCount,
    refinementRefused: refinementRefusals.length,
    refinementSuspended: refinementSuspendedCount,
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
