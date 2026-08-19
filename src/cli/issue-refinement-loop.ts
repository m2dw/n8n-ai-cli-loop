/**
 * `admin refinement run` — one bounded two-agent refinement attempt for one
 * Issue (issue #869, docs/issue-refinement-contract.md §7, §8, §12 rows 8–21).
 *
 * The CLI is the thin shell around
 * `src/handlers/issue-refinement-loop.ts` (and, for an `accepted`/`applying`
 * block, `src/handlers/issue-refinement-apply.ts`): it loads the session and
 * the refinement task row, refuses a disabled lane, hands the §15 context
 * block to the matching walk, and commits what comes back — the updated
 * block, the audit events, and the status the phase runner's own refinement
 * routing would apply (`ready_for_human` on an escalation, `queued` on
 * acceptance and on the row-22 commit point, the row-45 park on activation).
 * The whole run holds the same issue-scoped
 * `<session>::issue-<n>` worktree lock `run-one-phase` serializes refinement
 * under, so a direct run and a normal tick can never double-run the agents
 * for one issue. The `TaskStore` is injected
 * by the admin composition root (issue #613/P1 confinement — this module never
 * imports the concrete `SqliteTaskStore`). Like `issue-plan ai-preview`
 * it runs the agents through the isolated no-tools invocation and emits one
 * machine-readable JSON summary.
 *
 * Write surface, stated once. On the LOOP path (a block at `pending`,
 * `eligible`, or a resumable mid-round state) the only writes are the local
 * artifact directory, the shared issue-lock file, and the task row in SQLite:
 * the snapshot source is read-only by construction (#868), the agents run
 * with no tools in a throwaway cwd with credentials stripped, and no GitHub
 * mutation exists on that path. A block at `accepted` or `applying`
 * dispatches instead to the APPLICATION walk (issue #870,
 * `src/handlers/issue-refinement-apply.ts`), whose write surface is exactly
 * the §11 step 3–5 mutations — the managed-region body update, the one §16
 * audit comment, and the two-label transition — performed through
 * {@link createGhRefinementApplyPort} against the target Issue only.
 */

import { execFileSync } from "child_process";
import { randomBytes } from "crypto";
import { existsSync, readFileSync, statSync } from "fs";
import { join } from "path";

import {
  DEFAULT_SESSIONS_PATH,
  describeUnresolvedSessionId,
  JsonSessionRegistry,
} from "../registries/json-session-registry.js";
import type { TaskStore } from "../core/task-store.js";
import type { ChainGraph, ChainListFilter, ChainRecord } from "../core/chain-registry.js";
import { SqliteChainRegistryStore } from "../stores/sqlite-chain-registry-store.js";
import type { TaskEvent } from "../core/task.js";
import type {
  IssueRefinementConfig,
  ResolvedSession,
  SessionLabels,
  WorkItemProviderConfig,
} from "../core/session.js";
import {
  readRefinementContextBlock,
  resolveIssueRefinementSettings,
} from "../core/issue-refinement.js";
import { leaseExpiry } from "../core/transitions.js";
import { resolveQuotaRetryDelayMs } from "../core/quota-classifier.js";
import type { OutboxEffect } from "../core/task-store.js";
import { OutboxEffectCollector } from "../core/phase-runner.js";
import { enqueueRefinementHandoffEffects } from "../core/outbox-effects.js";
import type {
  RefinementChainAgreement,
  RefinementChangedPathListing,
  RefinementChangedPathRead,
  RefinementCommentRead,
  RefinementIssueRead,
  RefinementPullRequestLookup,
  RefinementSnapshotSource,
} from "../core/issue-refinement-snapshot.js";
import type { RefinementLoopContextBlock } from "../core/issue-refinement-loop.js";
import type {
  RefinementApplyContextBlock,
  RefinementApplyPort,
} from "../core/issue-refinement-apply.js";
import { REFINEMENT_COMMENT_SCAN_ALL } from "../core/issue-refinement-apply.js";
import type {
  RefinementAgentRunner,
  RefinementFailureClassifier,
  RefinementRoleProfileResolver,
} from "../handlers/issue-refinement-loop.js";
import { executeRefinementLoop, REFINEMENT_RETRY_DELAY_MS } from "../handlers/issue-refinement-loop.js";
import { executeRefinementApply } from "../handlers/issue-refinement-apply.js";
import type { CommandRunner } from "../handlers/command-runner.js";
import { defaultCommandRunner } from "../handlers/command-runner.js";
import { IssueWorktreeLock } from "../handlers/worktree.js";
import type { AcquireResult } from "../stores/repo-lock-store.js";
import { ghRunnerFromCommandRunner } from "../providers/github/gh-runner.js";
import type { GhRunner as ProviderGhRunner } from "../providers/github/gh-runner.js";
import { resolveGhRunner } from "../providers/github/github-app-auth.js";
import { GraphQLDependencyChecker, runGhViaRunner } from "./github-intake.js";
import { tokenizeArgs } from "./admin-command.js";
import { die, emit } from "./cli-io.js";

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_TIMEOUT_MS = 60 * 60 * 1000;
const GH_MAX_BUFFER = 64 * 1024 * 1024;
/** Bound on the local `issue-plan` artifact handed into the snapshot (§5). */
const MAX_ISSUE_PLAN_BYTES = 256 * 1024;
/** REST page size for the PR file listing (the endpoint's own maximum). */
const GH_PR_FILES_PAGE_SIZE = 100;
/** REST page size for the Issue comment listing (the endpoint's own maximum). */
const GH_ISSUE_COMMENTS_PAGE_SIZE = 100;
/**
 * GitHub's PR file listing stops at 3000 files; a listing still returning full
 * pages here can never honestly be called complete, so pagination stops.
 */
const GH_PR_FILES_MAX = 3000;

export interface RefinementRunArgs {
  sessionId: string;
  issueNumber: number;
  sessionsPath: string;
  dbPath: string | undefined;
  /** Issue-lock directory override; default is the runner's shared lock dir. */
  lockDir: string | undefined;
  timeoutMs: number;
}

export function parseRefinementRunArgs(argv: string[]): RefinementRunArgs | { error: string } {
  const tokenized = tokenizeArgs(argv, {
    valueFlags: ["session-id", "issue-number", "sessions-path", "db-path", "lock-dir", "timeout"],
  });
  if ("error" in tokenized) return tokenized;
  const args = tokenized.args;
  const sessionId = args["session-id"];
  if (!sessionId) return { error: "Missing required --session-id" };
  const issueRaw = args["issue-number"];
  if (!issueRaw) return { error: "Missing required --issue-number" };
  const issueNumber = Number(issueRaw);
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    return { error: `Invalid --issue-number: ${issueRaw}` };
  }
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (args["timeout"] !== undefined) {
    timeoutMs = Number(args["timeout"]);
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
      return { error: `Invalid --timeout: ${args["timeout"]} (1..${MAX_TIMEOUT_MS} ms)` };
    }
  }
  return {
    sessionId,
    issueNumber,
    sessionsPath: args["sessions-path"] ?? DEFAULT_SESSIONS_PATH,
    dbPath: args["db-path"],
    lockDir: args["lock-dir"],
    timeoutMs,
  };
}

// ---------------------------------------------------------------------------
// Default read-only snapshot source (gh-backed)
//
// The port has no write method to implement, and this adapter adds none: every
// call shells out to a `gh` READ, reads a local artifact, or reads the chain
// registry. One §5 input is still resolved as its documented degraded literal
// — `readReviewSummary` returns `null` (no terminal review outcome captured);
// wiring it to its store is follow-up work, and it degrades fail-closed in
// #868. `readChainAgreement` is implemented against the persistent chain
// registry whenever the caller supplies {@link GhSnapshotSourceOptions.chainAgreement};
// without it the method stays absent and reads as `unregistered`, which is the
// test-seam shape, not the production one.
// ---------------------------------------------------------------------------

type GhRunner = (args: string[]) => string;

/**
 * The two chain-registry reads the §4 condition-5 cross-check needs.
 * `SqliteChainRegistryStore` satisfies it structurally.
 */
export interface ChainAgreementRegistryReader {
  listChainsForIssue(issueNumber: number, filter?: ChainListFilter): Promise<ChainRecord[]>;
  getChain(chainId: string): Promise<ChainGraph | undefined>;
}

/**
 * Wiring for the registered-chain cross-check (§4 condition 5, §12 row 6).
 *
 * `sessionId` scopes membership to this session's chains — the registry file is
 * shared across sessions. `dbPath` must be the same SQLite file the runner's
 * other stores use, so the cross-check reads the registry the intake that
 * registered the chain wrote (the concrete store is constructed here exactly as
 * `github-intake`/`chain sync` construct theirs; the #613/P1 confinement is
 * specific to the `TaskStore`). `openRegistry` is a test seam replacing the
 * SQLite adapter.
 */
export interface GhChainAgreementOptions {
  sessionId: string;
  dbPath?: string | undefined;
  openRegistry?: () => ChainAgreementRegistryReader & { close(): void };
}

export interface GhSnapshotSourceOptions {
  githubRepo: string;
  artifactRoot: string;
  runGh?: GhRunner;
  /** Present in production; absent keeps `readChainAgreement` unimplemented. */
  chainAgreement?: GhChainAgreementOptions;
}

function ghJson(runGh: GhRunner, args: string[]): unknown {
  return JSON.parse(runGh(args));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * §4 condition 5 against the persistent chain registry (#788/#890): does the
 * observed direct-predecessor set agree with the accepted revision of the
 * chain the target Issue is registered in?
 *
 * The scoping and the fail-closed choices, stated once:
 *
 *  - An Issue in NO chain of this session is `unregistered` — not a
 *    disagreement; §4 scopes the cross-check to registered members.
 *  - Membership in MORE than one chain is a disagreement: the cross-check
 *    refuses to pick which chain to believe, matching contract gap G3's
 *    refusal of cross-chain refinement.
 *  - A member chain with no accepted revision, or whose accepted revision is
 *    no longer the stored graph (the store persists members/edges for the
 *    CURRENT graph revision only), has no reconstructible accepted edge set to
 *    compare against. Both read as disagreement rather than agreement — the
 *    contract's registry clause has disagreement escalate rather than choose a
 *    side, and §4 orders structural conditions ahead of holds precisely so a
 *    state that needs a human is not buried under retries.
 *  - Agreement itself is set equality between the observed predecessors and
 *    the accepted graph's direct `blocked by` edges into the target,
 *    deduplicated; both directions of a mismatch are named in the detail.
 *
 * A registry read that throws propagates: the snapshot builder records it as a
 * `chain_agreement` stage failure and fails closed like any other provider
 * error.
 */
export async function readChainAgreementFromRegistry(
  registry: ChainAgreementRegistryReader,
  sessionId: string,
  issueNumber: number,
  observedPredecessors: readonly number[],
): Promise<RefinementChainAgreement> {
  const chains = await registry.listChainsForIssue(issueNumber, { sessionId });
  if (chains.length === 0) return { kind: "unregistered" };
  if (chains.length > 1) {
    const ids = chains.map((c) => c.chainId).sort().join(", ");
    return {
      kind: "disagrees",
      detail: `member of ${chains.length} registered chains (${ids}); the cross-check refuses multi-chain membership`,
    };
  }
  const chain = chains[0];
  if (chain.acceptedRevision === undefined) {
    return {
      kind: "disagrees",
      detail: `chain ${chain.chainId} has no accepted revision to check the observed predecessor set against`,
    };
  }
  if (chain.acceptedRevision !== chain.graphRevision) {
    return {
      kind: "disagrees",
      detail:
        `chain ${chain.chainId} accepted revision ${chain.acceptedRevision} is not the stored graph `
        + `(revision ${chain.graphRevision}), so the accepted edge set cannot be read`,
    };
  }
  const graph = await registry.getChain(chain.chainId);
  if (!graph) {
    // Listed as a member moments ago; the chain vanished between the two
    // reads. A half-observed registry is a provider failure, not a verdict.
    throw new Error(`chain ${chain.chainId} disappeared between membership and graph reads`);
  }
  const expected = [
    ...new Set(
      graph.edges
        .filter((e) => e.blockedIssueNumber === issueNumber)
        .map((e) => e.blockerIssueNumber),
    ),
  ].sort((a, b) => a - b);
  const observed = [...new Set(observedPredecessors)].sort((a, b) => a - b);
  const expectedSet = new Set(expected);
  const observedSet = new Set(observed);
  const missing = expected.filter((n) => !observedSet.has(n));
  const unexpected = observed.filter((n) => !expectedSet.has(n));
  if (missing.length === 0 && unexpected.length === 0) return { kind: "agrees" };
  const parts: string[] = [];
  if (missing.length > 0) {
    parts.push(`accepted predecessors missing on GitHub: ${missing.map((n) => `#${n}`).join(", ")}`);
  }
  if (unexpected.length > 0) {
    parts.push(
      `observed predecessors outside the accepted revision: ${unexpected.map((n) => `#${n}`).join(", ")}`,
    );
  }
  return { kind: "disagrees", detail: `chain ${chain.chainId}: ${parts.join("; ")}` };
}

export function createGhRefinementSnapshotSource(
  options: GhSnapshotSourceOptions,
): RefinementSnapshotSource {
  const runGh: GhRunner =
    options.runGh
    ?? ((args) => execFileSync("gh", args, { encoding: "utf8", maxBuffer: GH_MAX_BUFFER }));
  const repo = options.githubRepo;
  const chainAgreement = options.chainAgreement;
  const dependencyChecker = new GraphQLDependencyChecker(repo, runGh);

  return {
    getBlockedBy: (issueNumber) => dependencyChecker.getBlockedBy(issueNumber),

    readIssue: async (issueNumber): Promise<RefinementIssueRead> => {
      const raw = asRecord(
        ghJson(runGh, [
          "issue", "view", String(issueNumber),
          "--repo", repo,
          "--json", "number,state,title,body,labels",
        ]),
      );
      const labels = Array.isArray(raw["labels"])
        ? (raw["labels"] as unknown[]).map((l) => str(asRecord(l)["name"])).filter((n) => n !== "")
        : [];
      return {
        number: typeof raw["number"] === "number" ? (raw["number"] as number) : issueNumber,
        state: str(raw["state"]).toLowerCase() === "closed" ? "closed" : "open",
        title: str(raw["title"]),
        body: str(raw["body"]),
        labels,
      };
    },

    readPullRequest: async (issueNumber): Promise<RefinementPullRequestLookup> => {
      // The session's own head-branch convention: `ai/issue-<n>`. A transient
      // lookup failure THROWS (the port forbids reading it as "no PR").
      const raw = ghJson(runGh, [
        "pr", "list",
        "--repo", repo,
        "--state", "all",
        "--head", `ai/issue-${issueNumber}`,
        "--json", "number,state,headRefName,headRefOid,mergeCommit,title,body",
      ]);
      const rows = Array.isArray(raw) ? raw.map(asRecord) : [];
      if (rows.length === 0) return { kind: "none" };
      if (rows.length > 1) return { kind: "ambiguous", detail: `matches:${rows.length}` };
      const pr = rows[0];
      const state = str(pr["state"]).toLowerCase();
      const mergeCommit = asRecord(pr["mergeCommit"]);
      return {
        kind: "found",
        pullRequest: {
          number: typeof pr["number"] === "number" ? (pr["number"] as number) : 0,
          state: state === "merged" ? "merged" : state === "open" ? "open" : "closed",
          headRefName: str(pr["headRefName"]),
          headSha: str(pr["headRefOid"]) || undefined,
          mergeCommitSha: str(mergeCommit["oid"]) || undefined,
          title: str(pr["title"]),
          body: str(pr["body"]),
        },
      };
    },

    readChangedPaths: async (
      prNumber,
    ): Promise<readonly RefinementChangedPathRead[] | RefinementChangedPathListing> => {
      // The port's truncation probe asks for one more path than the cap, and
      // `gh pr view --json files` is itself provider-capped, so a bare page from
      // it is indistinguishable from a complete listing. Page the REST file
      // listing to its end instead: a drained listing is returned as an explicit
      // `complete: true` (whatever its length), and a PR still reporting full
      // pages at the provider's own file ceiling is returned as a bare
      // provider-ordered array, which the core refuses past the cap rather than
      // capturing a subset chosen by listing order.
      const paths: RefinementChangedPathRead[] = [];
      for (let page = 1; paths.length < GH_PR_FILES_MAX; page++) {
        const raw = ghJson(runGh, [
          "api",
          `repos/${repo}/pulls/${prNumber}/files?per_page=${GH_PR_FILES_PAGE_SIZE}&page=${page}`,
        ]);
        const files = Array.isArray(raw) ? raw.map(asRecord) : [];
        for (const f of files) {
          paths.push({
            path: str(f["filename"]),
            added: typeof f["additions"] === "number" ? (f["additions"] as number) : 0,
            removed: typeof f["deletions"] === "number" ? (f["deletions"] as number) : 0,
          });
        }
        if (files.length < GH_PR_FILES_PAGE_SIZE) return { paths, complete: true };
      }
      return paths;
    },

    readIssueComments: async (issueNumber, limit): Promise<readonly RefinementCommentRead[]> => {
      // Two callers, two shapes. The §16 idempotency scan passes an
      // effectively unbounded limit: a crash after the audit-comment POST can
      // park the attempt while any number of newer comments land, so the
      // retry must see the FULL history or it posts a duplicate — that scan
      // pages the REST listing to its end (`gh issue view --json comments`
      // returns a single GraphQL page and cannot honor it). A FINITE limit
      // is the snapshot's bounded most-recent window (§5), and draining a
      // long discussion just to discard everything but its tail would make
      // every bounded capture and re-verification unbounded in API work —
      // the per-issue listing has no descending order, so the Issue record's
      // own comment count is read once instead and only the pages covering
      // the tail are fetched. Count drift while those pages are read (a
      // comment landing or vanishing mid-capture) resolves to the live
      // listing — the same point-in-time approximation a full drain has —
      // and the core re-applies the window it asked for either way.
      if (limit <= 0) return [];
      const comments: RefinementCommentRead[] = [];
      const fetchPage = (page: number): number => {
        const raw = ghJson(runGh, [
          "api",
          `repos/${repo}/issues/${issueNumber}/comments?per_page=${GH_ISSUE_COMMENTS_PAGE_SIZE}&page=${page}`,
        ]);
        const rows = Array.isArray(raw) ? raw.map(asRecord) : [];
        for (const c of rows) {
          const createdAt = str(c["created_at"]);
          comments.push({
            // §6 hashes the id: REST's `node_id` is the same GraphQL
            // identifier the previous single-page read returned, so recorded
            // fingerprints stay stable across the pagination change.
            id: str(c["node_id"]) || String(c["id"] ?? ""),
            createdAt,
            updatedAt: str(c["updated_at"]) || createdAt,
            body: str(c["body"]),
          });
        }
        return rows.length;
      };
      let page = 1;
      if (limit < REFINEMENT_COMMENT_SCAN_ALL) {
        const meta = asRecord(ghJson(runGh, ["api", `repos/${repo}/issues/${issueNumber}`]));
        const total =
          typeof meta["comments"] === "number" && meta["comments"] > 0
            ? (meta["comments"] as number)
            : 0;
        page = Math.floor(Math.max(0, total - limit) / GH_ISSUE_COMMENTS_PAGE_SIZE) + 1;
      }
      while (fetchPage(page) === GH_ISSUE_COMMENTS_PAGE_SIZE) page += 1;
      return comments.slice(Math.max(0, comments.length - limit));
    },

    readReviewSummary: async () => null,

    readIssuePlan: async (issueNumber) => {
      const path = join(
        options.artifactRoot,
        "issue-plan",
        `issue-${issueNumber}`,
        "ai-planner-result.json",
      );
      if (!existsSync(path)) return null;
      if (statSync(path).size > MAX_ISSUE_PLAN_BYTES) return null;
      return readFileSync(path, "utf8");
    },

    ...(chainAgreement
      ? {
          readChainAgreement: async (
            issueNumber: number,
            observedPredecessors: readonly number[],
          ): Promise<RefinementChainAgreement> => {
            // One registry handle per read, closed before answering: the source
            // has no lifecycle of its own to hang a long-lived connection on,
            // and §4 runs the cross-check twice per capture (once deciding, once
            // re-verifying before sealing).
            const registry = chainAgreement.openRegistry
              ? chainAgreement.openRegistry()
              : new SqliteChainRegistryStore(chainAgreement.dbPath);
            try {
              return await readChainAgreementFromRegistry(
                registry,
                chainAgreement.sessionId,
                issueNumber,
                observedPredecessors,
              );
            } finally {
              registry.close();
            }
          },
        }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Default apply port (gh-backed, issue #870)
//
// The §11 step 3–5 write surface, and nothing else: one body PATCH, one
// comment POST, one label POST, one label DELETE — all against the target
// Issue. The same REST shapes `gh-work-item-provider` uses, including its
// 404-tolerant label removal (§6: a marker already absent is the end state,
// not a failure). Every other failure propagates as a throw, which the apply
// walk classifies as a bounded transient (row 32).
// ---------------------------------------------------------------------------

export interface GhApplyPortOptions {
  githubRepo: string;
  runGh?: GhRunner;
}

export function createGhRefinementApplyPort(options: GhApplyPortOptions): RefinementApplyPort {
  const runGh: GhRunner =
    options.runGh
    ?? ((args) => execFileSync("gh", args, { encoding: "utf8", maxBuffer: GH_MAX_BUFFER }));
  const repo = options.githubRepo;
  return {
    updateIssueBody: async (issueNumber, body) => {
      // --raw-field: a body starting with "@" must stay a literal value, not a
      // gh --field file reference.
      runGh([
        "api",
        `repos/${repo}/issues/${issueNumber}`,
        "--method", "PATCH",
        "--raw-field", `body=${body}`,
      ]);
    },
    postIssueComment: async (issueNumber, body) => {
      runGh([
        "api",
        `repos/${repo}/issues/${issueNumber}/comments`,
        "--method", "POST",
        "--raw-field", `body=${body}`,
      ]);
    },
    addIssueLabel: async (issueNumber, label) => {
      runGh([
        "api",
        `repos/${repo}/issues/${issueNumber}/labels`,
        "--method", "POST",
        "--field", `labels[]=${label}`,
      ]);
    },
    removeIssueLabel: async (issueNumber, label) => {
      try {
        runGh([
          "api",
          `repos/${repo}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`,
          "--method", "DELETE",
        ]);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // A label already gone is the removal's own end state (§6).
        if (!/\b404\b|Not Found/i.test(message)) throw err;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Session resolution (same validation contract as issue-plan / issue-discuss)
// ---------------------------------------------------------------------------

interface ResolvedRefinementSession {
  sessionId: string;
  githubRepo: string;
  repoRoot: string;
  artifactRoot: string;
  labels: SessionLabels;
  issueRefinement: IssueRefinementConfig | undefined;
  workItemProvider: WorkItemProviderConfig | undefined;
  /**
   * The whole session record, carried for ONE purpose: the §13 handoff effect
   * builder (issue #936) is shared with the phase runner and addresses a
   * work-item row from the session's provider, owner/repo, and label config.
   * Re-narrowing those fields here would fork the addressing rules between the
   * two entries into the same escalation, which is exactly what this command
   * must not do. Nothing else in this module reads it.
   */
  outboxSession: ResolvedSession;
}

async function resolveSession(
  sessionId: string,
  sessionsPath: string,
): Promise<ResolvedRefinementSession | { error: string }> {
  let registry: JsonSessionRegistry;
  try {
    registry = new JsonSessionRegistry(sessionsPath);
  } catch (err) {
    return {
      error: `Failed to load sessions file (${sessionsPath}): ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const session = await registry.getSessionById(sessionId);
  if (!session) {
    return { error: describeUnresolvedSessionId(registry, sessionId, sessionsPath) };
  }
  return {
    sessionId: session.sessionId,
    githubRepo: session.githubRepo,
    repoRoot: session.repoRoot,
    artifactRoot: session.artifactRoot,
    labels: session.labels,
    issueRefinement: session.issueRefinement,
    workItemProvider: session.workItemProvider,
    outboxSession: session,
  };
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

/**
 * The §13 handoff effects for a commit this command is about to make (issue
 * #936), or an empty list when the outcome is not a terminal handoff.
 *
 * `admin refinement run` is the second entry into the same escalation the phase
 * runner reaches on an ordinary tick, so it must leave the same public trace:
 * an operator who runs the lane by hand and an unattended tick that runs it must
 * not produce differently-visible Issues. The effects ride in the SAME
 * `completePhaseWithEffects` call as the escalated block, so the store commits
 * both together (or neither) exactly as it does for a phase completion.
 */
async function refinementHandoffEffects(
  session: ResolvedSession,
  issueNumber: number,
  context: Record<string, unknown> | undefined,
  now: string,
): Promise<OutboxEffect[]> {
  const collector = new OutboxEffectCollector();
  await enqueueRefinementHandoffEffects(collector, session, { issueNumber }, context, now);
  return collector.effects;
}

/**
 * Injection seams; every default is the production path except `store`, which
 * has no default here — the admin composition root constructs the concrete
 * adapter (issue #613/P1 confinement).
 */
export interface RefinementRunDeps {
  store: TaskStore;
  source?: RefinementSnapshotSource;
  /** §11 step 3–5 write port (issue #870); defaults to the gh-backed adapter. */
  applyPort?: RefinementApplyPort;
  /**
   * Issue-scoped execution lock; defaults to the SAME shared-directory
   * `IssueWorktreeLock` `run-one-phase` serializes refinement under (override
   * the directory with `--lock-dir`). Injectable for tests only.
   */
  issueLock?: IssueWorktreeLock;
  refinerAgent?: RefinementAgentRunner;
  criticAgent?: RefinementAgentRunner;
  agentRunner?: CommandRunner;
  resolveRoleProfile?: RefinementRoleProfileResolver;
  classifyFailure?: RefinementFailureClassifier;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  runId?: string;
}

export async function runRefinementRun(
  args: RefinementRunArgs,
  deps: RefinementRunDeps,
): Promise<void> {
  const session = await resolveSession(args.sessionId, args.sessionsPath);
  if ("error" in session) {
    die(session.error);
    return;
  }

  const settings = resolveIssueRefinementSettings(session.issueRefinement);
  if (!settings.ok) {
    die(
      `Invalid issueRefinement configuration: ${settings.errors
        .map((e) => `${e.path}: ${e.message}`)
        .join("; ")}`,
    );
    return;
  }
  if (!settings.settings.enabled) {
    die(
      "issueRefinement is disabled for this session (issueRefinement.enabled is not true); " +
        "the refinement lane is off and this command refuses to run it.",
    );
    return;
  }

  const store = deps.store;
  const key = { sessionId: session.sessionId, issueNumber: args.issueNumber };
  const runId = deps.runId ?? `refine-${randomBytes(6).toString("hex")}`;

  // Serialize with the normal refinement lane (issue #869 review follow-up):
  // `run-one-phase` executes refinement under the issue-scoped
  // `<session>::issue-<n>` worktree lock, so this direct path takes the SAME
  // lock — before even reading the row. A tick that owns the issue is refused
  // here, and a tick that claims the queued row while this run holds the lock
  // takes its `lock_contended` outcome and releases the task back to `queued`
  // instead of double-running the agents against the same artifact directory.
  const issueLock = deps.issueLock ?? new IssueWorktreeLock(args.lockDir);
  let acquisition: AcquireResult;
  try {
    acquisition = issueLock.acquire(runId, session.sessionId, args.issueNumber);
  } catch (err) {
    // A filesystem fault in the lock store — refuse to run without the guard.
    die(
      `Failed to acquire the issue lock for issue #${args.issueNumber}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }
  if (!acquisition.locked) {
    die(
      `issue #${args.issueNumber} is already running (worktree lock held by ` +
        `${acquisition.ownerContextId} since ${acquisition.ownerStartedAt}); ` +
        "wait for that run to finish, or release a stale lock with `admin worktree release-lock`.",
    );
    return;
  }
  const releaseLock = (): void => {
    // Best-effort: the lock TTL and `admin worktree release-lock` are the
    // backstop if release fails (e.g. the lock was force-released).
    try {
      issueLock.release(runId, session.sessionId, args.issueNumber);
    } catch {
      /* ignore — leaked locks are recovered by TTL/admin */
    }
  };
  // `die` exits the process without unwinding the stack, so the `finally`
  // below never runs on a refusal path: release explicitly first.
  const dieLocked = (message: string): never => {
    releaseLock();
    die(message);
  };

  try {
    const task = await store.getTask(key);
    if (!task) {
      dieLocked(`No task found for session ${session.sessionId} issue #${args.issueNumber}`);
      return;
    }
    if (task.phase !== "refinement") {
      dieLocked(
        `Task for issue #${args.issueNumber} is at phase '${task.phase}', not 'refinement'; ` +
          "this command only runs refinement-phase tasks admitted by intake.",
      );
      return;
    }
    const block = readRefinementContextBlock(task.context);
    if (!block) {
      dieLocked(
        `Task for issue #${args.issueNumber} carries no context.refinement block; ` +
          "re-run intake to admit it into the refinement lane.",
      );
      return;
    }

    const artifactDir = join(
      session.artifactRoot,
      "issue-refinement",
      `issue-${args.issueNumber}`,
      runId,
    );
    // Issue #870: a block already at `accepted`/`applying` continues into the
    // application walk instead of the loop, under the same issue lock.
    const dispatchApply = block.state === "accepted" || block.state === "applying";
    let source = deps.source;
    let applyPort = deps.applyPort;
    if (!source || (dispatchApply && !applyPort)) {
      // The snapshot's `gh` reads — and the application's `gh` writes — run as
      // the session's configured work-item identity, exactly as the normal
      // phase handler builds its source (run-one-phase): built without a
      // runner, both fall back to raw `execFileSync("gh", ...)`, which fails
      // on a host with no interactive `gh` login or acts under an unrelated
      // local account in `github-app` deployments. A non-GitHub work-item
      // provider has no gh-backed adapter to build, so it fails closed rather
      // than shelling `gh` against a repo it does not serve.
      const workItemKind = session.workItemProvider?.provider ?? "github-issues";
      if (workItemKind !== "github-issues") {
        dieLocked(
          `Refinement ${!source ? "snapshot reads" : "application writes"} are not implemented `
            + `for work-item provider "${workItemKind}"`,
        );
        return;
      }
      let runner: ProviderGhRunner;
      try {
        runner = await resolveGhRunner(
          session.workItemProvider?.auth ?? { mode: "gh" },
          ghRunnerFromCommandRunner(defaultCommandRunner),
        );
      } catch (err) {
        dieLocked(
          `Failed to resolve GitHub provider auth: ${err instanceof Error ? err.message : String(err)}`,
        );
        return;
      }
      const runGh = runGhViaRunner(runner, session.repoRoot);
      if (!source) {
        source = createGhRefinementSnapshotSource({
          githubRepo: session.githubRepo,
          artifactRoot: session.artifactRoot,
          runGh,
          // Registered-chain cross-check (§4 condition 5): read the chain registry
          // from the same SQLite file the task store uses, so a registered member
          // whose live `blocked by` set contradicts its accepted chain revision
          // takes the `chain_disagreement` handoff instead of being refined
          // against a topology the registry does not accept.
          chainAgreement: { sessionId: session.sessionId, dbPath: args.dbPath },
        });
      }
      if (dispatchApply && !applyPort) {
        applyPort = createGhRefinementApplyPort({ githubRepo: session.githubRepo, runGh });
      }
    }

    if (dispatchApply && applyPort) {
      const result = await executeRefinementApply(
        {
          issueNumber: args.issueNumber,
          block: block as RefinementApplyContextBlock,
          stackReadyLabel: session.labels["stackReady"] ?? "status:stack-ready",
          artifactDir,
          runId,
        },
        {
          source,
          applyPort,
          ...(deps.now ? { now: deps.now } : {}),
        },
      );
      if (result.outcome.kind === "refused") {
        dieLocked(`Refinement application is not runnable (${result.outcome.detail})`);
        return;
      }

      // Commit exactly as the phase runner routes the same outcomes: a
      // committed row-22 checkpoint stays `queued` for the next run, a
      // stale/transient outcome stays `queued` behind the short refinement
      // re-poll window, an escalation parks `ready_for_human`, and the
      // activated outcome performs the row-45 park — status/phase from the
      // activation plan persisted at admission, `context.assignment`
      // untouched — in the SAME transaction as the `activated` block.
      const activated = result.outcome.kind === "activated";
      const plan = result.block.activationPlan;
      const applyRetryDelayMs: number | null =
        result.outcome.kind === "stale_restart"
        || result.outcome.kind === "verify_failed"
        || result.outcome.kind === "write_failed"
          ? REFINEMENT_RETRY_DELAY_MS
          : null;
      const createdAt = new Date(deps.now ? deps.now() : Date.now()).toISOString();
      const applyNotBefore = applyRetryDelayMs !== null ? leaseExpiry(createdAt, applyRetryDelayMs) : null;
      const patch = {
        context: { ...(task.context ?? {}), refinement: result.block },
        ...(result.taskStatus ? { status: result.taskStatus } : {}),
        ...(activated ? { status: plan.targetStatus, phase: plan.targetPhase } : {}),
        ...(applyNotBefore !== null ? { notBefore: applyNotBefore } : {}),
      };
      const [event, ...extraEvents] = result.events.map(
        (e): TaskEvent => ({ task: key, type: e.type, runId, data: e.data, createdAt }),
      );
      // §13 items 3–4 (issue #936): an escalation raised here is the same
      // handoff the phase runner publishes, so it carries the same two effects,
      // in the same transaction as the block that escalated. Every other apply
      // outcome contributes nothing — the gate is the builder's.
      const applyEffects = await refinementHandoffEffects(
        session.outboxSession, args.issueNumber, patch.context, createdAt,
      );
      const committed = event
        ? await store.completePhaseWithEffects(
            { key, expected: { revision: task.revision }, patch, event, extraEvents },
            applyEffects,
          )
        : // A verify/write failure that emitted nothing still needs its
          // progress counters persisted.
          await store.transitionTask(key, { revision: task.revision }, patch);
      if (!committed.ok) {
        dieLocked(
          `Refinement application finished (${result.outcome.kind}) but the commit was refused ` +
            `(store said: ${committed.code}); nothing was persisted — re-run against the current row.`,
        );
        return;
      }

      emit({
        command: "refinement-apply",
        sessionId: session.sessionId,
        issueNumber: args.issueNumber,
        runId,
        outcome: result.outcome,
        state: result.block.state,
        handoffReason: result.block.handoffReason,
        taskStatus: activated ? plan.targetStatus : result.taskStatus,
        taskPhase: activated ? plan.targetPhase : "refinement",
        notBefore: applyNotBefore,
        counters: result.block.counters,
        apply: result.block.apply ?? null,
        events: result.events.map((e) => e.type),
        artifactDir,
        artifacts: result.artifacts,
      });
      return;
    }

    const result = await executeRefinementLoop(
      {
        issueNumber: args.issueNumber,
        block: block as RefinementLoopContextBlock,
        stackReadyLabel: session.labels["stackReady"] ?? "status:stack-ready",
        artifactDir,
        runId,
        timeoutMs: args.timeoutMs,
      },
      {
        source,
        ...(deps.refinerAgent ? { refinerAgent: deps.refinerAgent } : {}),
        ...(deps.criticAgent ? { criticAgent: deps.criticAgent } : {}),
        ...(deps.agentRunner ? { agentRunner: deps.agentRunner } : {}),
        ...(deps.resolveRoleProfile ? { resolveRoleProfile: deps.resolveRoleProfile } : {}),
        ...(deps.classifyFailure ? { classifyFailure: deps.classifyFailure } : {}),
        ...(deps.env ? { env: deps.env } : {}),
        ...(deps.now ? { now: deps.now } : {}),
      },
    );

    // §13 sets `ready_for_human` on every escalation. An ACCEPTED run stays
    // `queued`, mirroring the phase runner's routing of a refinement
    // `success` (issue #870: `nextPhaseAfter` keeps it at this phase), so the
    // next normal tick — or a re-run of this command — continues into the
    // application walk on the same block.
    const taskStatus: "ready_for_human" | null = result.taskStatus;

    // Commit: the updated §15 block, the status, and the audit events — in ONE
    // store transaction, through the same boundary a phase completion uses
    // (issue #701; the dispute layer draws the identical line and issues no
    // separate `transitionTask` + `appendEvent` pair, issue #844). An append
    // after a committed CAS could fail and leave a refined/escalated block
    // persisted without its required events — unrepairable here, because a
    // re-run refuses the terminal block. The CAS on `revision` refuses to
    // overwrite a row another execution moved while the agents were running.
    // A retryable outcome (hold / snapshot_failed / agent_retry) leaves the
    // row `queued`; committed without a cool-down, the next workflow tick would
    // claim it immediately and re-run an agent that just failed on quota or
    // timeout (issue #869 review follow-up). Mirror `createRefinementHandler`'s
    // delayed mapping exactly: the short refinement re-poll window for an
    // eligibility hold or a transient snapshot failure, the runner's default
    // quota cool-down — the §17 phase-level delay — for an agent process
    // failure.
    const retryDelayMs: number | null =
      result.outcome.kind === "agent_retry"
        ? resolveQuotaRetryDelayMs(deps.env)
        : result.outcome.kind === "hold" || result.outcome.kind === "snapshot_failed"
          ? REFINEMENT_RETRY_DELAY_MS
          : null;
    let notBefore: string | null = null;

    if (result.outcome.kind !== "refused") {
      const createdAt = new Date(deps.now ? deps.now() : Date.now()).toISOString();
      notBefore = retryDelayMs !== null ? leaseExpiry(createdAt, retryDelayMs) : null;
      const patch = {
        context: { ...(task.context ?? {}), refinement: result.block },
        ...(taskStatus ? { status: taskStatus } : {}),
        ...(notBefore !== null ? { notBefore } : {}),
      };
      const [event, ...extraEvents] = result.events.map(
        (e): TaskEvent => ({ task: key, type: e.type, runId, data: e.data, createdAt }),
      );
      // §13 items 3–4 (issue #936): the ready-for-human label and the one
      // handoff comment, committed with the escalation rather than left to the
      // operator to notice. An accepted/held/retrying run enqueues nothing.
      const loopEffects = await refinementHandoffEffects(
        session.outboxSession, args.issueNumber, patch.context, createdAt,
      );
      const committed = event
        ? await store.completePhaseWithEffects(
            { key, expected: { revision: task.revision }, patch, event, extraEvents },
            loopEffects,
          )
        : // Every non-refused loop outcome emits at least one event today; with
          // nothing to keep atomic, a plain transition stays correct if one ever
          // did not.
          await store.transitionTask(key, { revision: task.revision }, patch);
      if (!committed.ok) {
        dieLocked(
          `Refinement run finished (${result.outcome.kind}) but the commit was refused ` +
            `(store said: ${committed.code}); nothing was persisted — the block and its audit ` +
            "events land together or not at all. Re-run against the current row.",
        );
        return;
      }
    }

    emit({
      command: "refinement-run",
      sessionId: session.sessionId,
      issueNumber: args.issueNumber,
      runId,
      outcome: result.outcome,
      state: result.block.state,
      handoffReason: result.block.handoffReason,
      taskStatus,
      notBefore,
      counters: result.block.counters,
      roles: result.block.execution ?? null,
      rounds: result.block.counters.rounds,
      events: result.events.map((e) => e.type),
      artifactDir,
      artifacts: result.artifacts,
    });
  } finally {
    releaseLock();
  }
}
