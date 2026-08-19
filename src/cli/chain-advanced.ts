/**
 * `admin chain fork|merge` (issue #893): the advanced dependency-chain
 * topology commands.
 *
 *   admin chain fork  <chain-ref> <issue> [length] [--name <alias>]
 *   admin chain merge <target-chain> <source-chain> --position append|prepend
 *
 * `core/chain-advanced.ts` owns every decision; this module owns the sequence
 * those decisions are carried out in — the same sequence as the linear
 * commands (`chain-edit.ts`), because the safety lives in the ordering and a
 * topology edit needs every step a linear one does:
 *
 *   0. Claim an exclusive scope for every Issue either operand chain holds,
 *      and for the new chain's name if one was asked for.
 *   1. Read GitHub's current relationships for every Issue involved, and the
 *      chains' accepted registry revisions alongside them.
 *   2. Suspend automation for every affected Issue before the first
 *      relationship write.
 *   3. Re-check the frozen dependency prefixes (#891) with automation
 *      quiesced, through the same rule the plan and the commit guard apply.
 *   4. Apply the planned relationship changes idempotently — additions first,
 *      so the graph GitHub holds mid-way is always a superset of the ordering
 *      constraints, then removals. A relationship already present (or already
 *      absent) is a step that already landed, not a failure.
 *   5. Read GitHub back and verify it holds exactly the planned post-state —
 *      every addition landed, every removal disappeared, nothing else moved.
 *   6. Only then update the registry, through #890's acceptance service:
 *        - `fork` accepts the shrunk graph into the forked chain, then
 *          registers the extracted segment as its own chain (unless a single
 *          Issue is being detached without a requested identity) and accepts
 *          it;
 *        - `merge` accepts the combined graph into the target — the store's
 *          exclusive member claim tolerating exactly the source chain — and
 *          then retires the source in one registry transaction: its graph
 *          deleted, its ID and every alias re-registered as aliases of the
 *          target, its frozen-prefix snapshots re-recorded against it.
 *   7. Only after that succeeds, restore the execution labels step 2 removed —
 *      and only those.
 *
 * Failure never rewinds GitHub, and never repairs it from the registry. A
 * partial operation leaves automation suspended — diagnosable, not executable
 * — and the answer carries the concrete recovery plan. The interrupted states
 * are all resumable by a command this answer names: a half-drawn relationship
 * set by re-running the same command (the plan re-reads GitHub and touches
 * only what is still missing); a fork whose chain was shrunk but whose segment
 * was never registered by `admin chain new <segment>` (whose leftover-adoption
 * machinery also finishes a segment chain created but never accepted); a merge
 * whose acceptance landed but whose source was never retired by re-running the
 * same merge, which detects the merged state and performs only the retirement.
 *
 * Preview by default, apply with `--yes` — a preview reads GitHub and the
 * registry and writes nothing at all.
 */

import { randomUUID } from "crypto";
import { hostname } from "os";
import type { OutputMode } from "./cli-io.js";
import { die, report } from "./cli-io.js";
import { parseCommonOptions, resolveSessionSelector } from "./admin-command.js";
import { fetchObservedEdges } from "./chain-inspect.js";
import { resolveIssueWorkItemProvider } from "./issue-activation.js";
import { restoreStep } from "./chain-edit.js";
import type { SuspensionAttribution } from "./chain-edit.js";
import {
  describeUnresolvedSessionId,
  JsonSessionRegistry,
} from "../registries/json-session-registry.js";
import { SqliteChainRegistryStore } from "../stores/sqlite-chain-registry-store.js";
import { SqliteIssueActivationStore } from "../stores/sqlite-issue-activation-store.js";
import type { ResolvedSession } from "../core/session.js";
import type { WorkItemProvider } from "../providers/types.js";
import {
  activateIssueAutomation,
  planSuspend,
  suspendIssueAutomation,
  suspensionLabelsOwnedBy,
} from "../core/issue-activation.js";
import type { IssueActivationOutcome, IssueActivationStore } from "../core/issue-activation.js";
import { acceptChainGraph, collectChainOwnership } from "../core/chain-acceptance.js";
import type { ChainGraphAcceptance } from "../core/chain-acceptance.js";
import { isValidChainAlias, isValidIssueNumber } from "../core/chain-registry.js";
import type { ChainEdgeInput, ChainMemberInput } from "../core/chain-registry.js";
import {
  CHAIN_EDIT_LOCK_ABANDONED_MS,
  CHAIN_EDIT_LOCK_RENEW_MS,
  CHAIN_EDIT_LOCK_STALE_MS,
  chainEditLockScopeKind,
  chainEditLockScopes,
  describeChainEditLockScope,
} from "../core/chain-edit-lock.js";
import type { ChainEditLockHolder } from "../core/chain-edit-lock.js";
import type { ChainGraphEdge } from "../core/chain-graph.js";
import type { ChainLinearTarget } from "../core/chain-linear.js";
import type { ChainSyncProviderError } from "../core/chain-sync.js";
import {
  checkForkFrozenPrefixes,
  checkMergeFrozenPrefixes,
  isChainMergePosition,
  planChainFork,
  planChainMerge,
  structuralChainAdvancedRefusal,
  verifyAdvancedChainReadBack,
} from "../core/chain-advanced.js";
import type {
  ChainAdvancedOperation,
  ChainAdvancedRefusal,
  ChainForkApply,
  ChainMergeApply,
  ChainMergePosition,
  ForkFrozenShape,
} from "../core/chain-advanced.js";

/** Provenance recorded on every revision these commands create. */
const ADVANCED_SOURCE_PREFIX = "admin chain";

/* -------------------------------------------------------------------------
 * Arguments
 * ---------------------------------------------------------------------- */

interface ChainForkArgs {
  chainRef: string;
  startIssueNumber: number;
  length: number | undefined;
  name: string | undefined;
  sessionId: string | undefined;
  apply: boolean;
  sessionsPath: string;
  dbPath: string | undefined;
}

export function parseChainForkArgs(argv: string[]): ChainForkArgs | { error: string } {
  const parsed = parseCommonOptions(argv, {
    booleanFlags: ["yes"],
    valueFlags: ["name", "session-id", "session-ref", "sessions-path"],
    allowPositionals: true,
  });
  if ("error" in parsed) return { error: parsed.error };
  const { args, flags, positionals } = parsed;

  if (positionals.length < 2) {
    return { error: "a chain reference and an issue number are required, e.g. admin chain fork <chain-ref> <issue> [length]" };
  }
  if (positionals.length > 3) {
    return { error: `Unexpected argument: ${positionals[3]}` };
  }
  const chainRef = positionals[0];
  const startIssueNumber = Number(positionals[1]);
  if (!isValidIssueNumber(startIssueNumber)) {
    return { error: `Invalid issue number: ${positionals[1]}` };
  }
  let length: number | undefined;
  if (positionals[2] !== undefined) {
    length = Number(positionals[2]);
    if (!Number.isInteger(length) || length < 1) {
      return { error: `Invalid segment length: ${positionals[2]} (a positive integer, or omit it to fork through the chain's end)` };
    }
  }
  const name = args["name"];
  if (name !== undefined && !isValidChainAlias(name)) {
    return {
      error:
        `Invalid chain name: ${name}. A name is registered as an operator alias for the new chain, so it must be ` +
        "1-64 characters of letters, digits, '.', '_' or '-', starting with a letter or digit.",
    };
  }

  let sessionId: string | undefined;
  if (args["session-id"] !== undefined || args["session-ref"] !== undefined) {
    const selector = resolveSessionSelector(args);
    if ("error" in selector) return { error: selector.error };
    sessionId = selector.sessionId;
  }

  return {
    chainRef,
    startIssueNumber,
    length,
    name,
    sessionId,
    apply: flags.has("yes"),
    sessionsPath: parsed.sessionsPath,
    dbPath: parsed.dbPath,
  };
}

interface ChainMergeArgs {
  targetRef: string;
  sourceRef: string;
  position: ChainMergePosition;
  sessionId: string | undefined;
  apply: boolean;
  sessionsPath: string;
  dbPath: string | undefined;
}

export function parseChainMergeArgs(argv: string[]): ChainMergeArgs | { error: string } {
  const parsed = parseCommonOptions(argv, {
    booleanFlags: ["yes"],
    valueFlags: ["position", "session-id", "session-ref", "sessions-path"],
    allowPositionals: true,
  });
  if ("error" in parsed) return { error: parsed.error };
  const { args, flags, positionals } = parsed;

  if (positionals.length < 2) {
    return {
      error:
        "a target and a source chain reference are required, e.g. admin chain merge <target-chain> <source-chain> --position append",
    };
  }
  if (positionals.length > 2) {
    return { error: `Unexpected argument: ${positionals[2]}` };
  }
  const position = args["position"];
  if (position === undefined) {
    return { error: "--position append|prepend is required: say where the source chain attaches to the target" };
  }
  if (!isChainMergePosition(position)) {
    return { error: `Invalid --position: ${position}. Expected append or prepend.` };
  }

  let sessionId: string | undefined;
  if (args["session-id"] !== undefined || args["session-ref"] !== undefined) {
    const selector = resolveSessionSelector(args);
    if ("error" in selector) return { error: selector.error };
    sessionId = selector.sessionId;
  }

  return {
    targetRef: positionals[0],
    sourceRef: positionals[1],
    position,
    sessionId,
    apply: flags.has("yes"),
    sessionsPath: parsed.sessionsPath,
    dbPath: parsed.dbPath,
  };
}

/* -------------------------------------------------------------------------
 * Result shape
 * ---------------------------------------------------------------------- */

type ChainAdvancedFailureKind =
  | ChainAdvancedRefusal["kind"]
  | "label_error"
  | "relationship_error"
  | "conflict"
  | "store_error"
  | "lock_contended";

interface ChainAdvancedFailure {
  kind: ChainAdvancedFailureKind;
  transient: boolean;
  message: string;
  remediation: string;
  recovery: string[];
  diagnostics?: ChainAdvancedRefusal["diagnostics"];
  violations?: ChainAdvancedRefusal["violations"];
  providerErrors?: ChainSyncProviderError[];
}

interface ChainAdvancedLabelChange {
  issueNumber: number;
  suspended: string[];
  restored: string[];
  withheld: string[];
  error?: string;
}

interface ChainAdvancedGraphOut {
  headIssueNumber: number;
  members: ChainMemberInput[];
  edges: ChainEdgeInput[];
  fingerprint: string;
}

interface ChainAdvancedRevisionOut {
  graphRevision: number;
  acceptedRevision: number | null;
  fingerprint: string;
}

interface ChainAdvancedPayload {
  ok: boolean;
  operation: ChainAdvancedOperation;
  applied: boolean;
  status: "would_apply" | "applied" | "failed";
  sessionId: string;
  chainRef?: string;
  chainId?: string;
  /** Merge only. */
  sourceChainRef?: string;
  sourceChainId?: string;
  position?: ChainMergePosition;
  /** Fork only. */
  startIssueNumber?: number;
  segmentIssues?: number[];
  detach?: boolean;
  newChainName?: string;
  newChainId?: string;
  /** Every Issue whose relationships or registration the operation touches. */
  issues: number[];
  /** GitHub relationships the operation plans to create / remove. */
  plannedAdditions: ChainGraphEdge[];
  plannedRemovals: ChainGraphEdge[];
  appliedEdges: ChainGraphEdge[];
  removedEdges: ChainGraphEdge[];
  alreadyPresentEdges: ChainGraphEdge[];
  alreadyAbsentEdges: ChainGraphEdge[];
  /** The primary chain's graph afterwards (forked chain / merge target). */
  graph?: ChainAdvancedGraphOut;
  /** The extracted segment's graph (fork). */
  segmentGraph?: ChainAdvancedGraphOut;
  revision?: ChainAdvancedRevisionOut;
  segmentRevision?: ChainAdvancedRevisionOut;
  /** What the source chain's retirement left behind (merge). */
  retirement?: { retiredChainId: string; intoChainId: string; movedAliases: string[] };
  labels: ChainAdvancedLabelChange[];
  failure?: ChainAdvancedFailure;
  followUpFailure?: { code: string; detail?: string };
}

/* -------------------------------------------------------------------------
 * Rendering
 * ---------------------------------------------------------------------- */

const FAILURE_LABELS: Record<ChainAdvancedFailureKind, string> = {
  provider_error: "provider read failed (transient)",
  structural: "structural graph problem",
  frozen_prefix: "frozen dependency-prefix conflict",
  label_error: "automation labels could not be moved",
  relationship_error: "GitHub relationship write failed",
  conflict: "chain moved during the operation (retryable)",
  store_error: "registry write failed",
  lock_contended: "another chain edit already holds this Issue or name (retryable)",
};

function formatEdges(edges: readonly ChainGraphEdge[]): string {
  if (edges.length === 0) return "(none)";
  return edges.map((e) => `${e.blockerIssueNumber}->${e.blockedIssueNumber}`).join(", ");
}

function renderChainAdvanced(payload: ChainAdvancedPayload, _mode: OutputMode): string {
  const mode = payload.applied ? "applied" : "preview (pass --yes to apply)";
  const scope =
    payload.operation === "fork"
      ? `chain ${payload.chainId ?? payload.chainRef ?? "?"}, segment ` +
        `${(payload.segmentIssues ?? []).map((n) => `#${n}`).join(" -> ") || `#${payload.startIssueNumber}`}`
      : `chain ${payload.sourceChainId ?? payload.sourceChainRef ?? "?"} into ` +
        `${payload.chainId ?? payload.chainRef ?? "?"} (${payload.position})`;
  const lines = [`Chain ${payload.operation} — ${scope}, session ${payload.sessionId}, ${mode}`];

  if (payload.operation === "fork" && payload.detach !== undefined) {
    lines.push(
      payload.detach
        ? "  segment: detached without a new chain identity (single Issue, no --name)"
        : `  segment chain: ${payload.newChainId ?? "(allocated on apply)"}${payload.newChainName === undefined ? "" : ` (name: ${payload.newChainName})`}`,
    );
  }
  if (payload.graph) {
    lines.push(`  ${payload.operation === "fork" ? "remaining" : "merged"} head: #${payload.graph.headIssueNumber}`);
    lines.push(`  ${payload.operation === "fork" ? "remaining" : "merged"} edges: ${formatEdges(payload.graph.edges as ChainGraphEdge[])}`);
  }
  if (payload.segmentGraph) {
    lines.push(`  segment head: #${payload.segmentGraph.headIssueNumber}`);
    lines.push(`  segment edges: ${formatEdges(payload.segmentGraph.edges as ChainGraphEdge[])}`);
  }
  lines.push(
    `  GitHub relationships ${payload.applied ? "created" : "to create"}: ` +
      formatEdges(payload.applied ? payload.appliedEdges : payload.plannedAdditions),
  );
  lines.push(
    `  GitHub relationships ${payload.applied ? "removed" : "to remove"}: ` +
      formatEdges(payload.applied ? payload.removedEdges : payload.plannedRemovals),
  );
  if (payload.alreadyPresentEdges.length > 0) {
    lines.push(`  already present: ${formatEdges(payload.alreadyPresentEdges)}`);
  }
  if (payload.alreadyAbsentEdges.length > 0) {
    lines.push(`  already absent: ${formatEdges(payload.alreadyAbsentEdges)}`);
  }
  if (payload.revision) {
    lines.push(
      `  registry revision: ${payload.revision.graphRevision} (accepted: ${payload.revision.acceptedRevision ?? "none"}) ${payload.revision.fingerprint}`,
    );
  }
  if (payload.segmentRevision) {
    lines.push(
      `  segment registry revision: ${payload.segmentRevision.graphRevision} (accepted: ${payload.segmentRevision.acceptedRevision ?? "none"}) ${payload.segmentRevision.fingerprint}`,
    );
  }
  if (payload.retirement) {
    const moved =
      payload.retirement.movedAliases.length === 0
        ? ""
        : `; aliases moved: ${payload.retirement.movedAliases.join(", ")}`;
    lines.push(
      `  retired: chain ${payload.retirement.retiredChainId} now resolves to ${payload.retirement.intoChainId}${moved}`,
    );
  }
  for (const label of payload.labels) {
    const parts = [
      `${payload.applied ? "suspended" : "would suspend"}: ${label.suspended.join(", ") || "none"}`,
    ];
    if (payload.applied) parts.push(`restored: ${label.restored.join(", ") || "none"}`);
    if (label.withheld.length > 0) parts.push(`STILL WITHHELD: ${label.withheld.join(", ")}`);
    if (label.error) parts.push(`error: ${label.error}`);
    lines.push(`  #${label.issueNumber} labels — ${parts.join("; ")}`);
  }

  if (payload.failure) {
    const failure = payload.failure;
    lines.push(`  error [${failure.kind}]: ${FAILURE_LABELS[failure.kind]} — ${failure.message}`);
    for (const d of failure.diagnostics ?? []) lines.push(`    [${d.code}] ${d.message}`);
    for (const v of failure.violations ?? []) lines.push(`    [${v.code}] ${v.message}`);
    for (const e of failure.providerErrors ?? []) lines.push(`    #${e.issueNumber}: ${e.error}`);
    lines.push(`  remediation: ${failure.remediation}`);
    if (failure.recovery.length > 0) {
      lines.push("  recovery:");
      for (const step of failure.recovery) lines.push(`    - ${step}`);
    }
  }
  if (payload.followUpFailure) {
    lines.push(
      `  warning: follow-up bookkeeping failed [${payload.followUpFailure.code}] ${payload.followUpFailure.detail ?? ""}`.trimEnd(),
    );
  }
  if (!payload.applied && payload.ok) lines.push("Run with --yes to apply.");
  return lines.join("\n");
}

/* -------------------------------------------------------------------------
 * Shared plumbing
 * ---------------------------------------------------------------------- */

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function issueList(issues: readonly number[]): string {
  return issues.join(",");
}

function refusalFailure(refusal: ChainAdvancedRefusal, recovery: string[]): ChainAdvancedFailure {
  return {
    kind: refusal.kind,
    transient: refusal.transient,
    message: refusal.message,
    remediation: refusal.remediation,
    recovery,
    ...(refusal.diagnostics.length > 0 ? { diagnostics: refusal.diagnostics } : {}),
    ...(refusal.violations.length > 0 ? { violations: refusal.violations } : {}),
    ...(refusal.providerErrors.length > 0 ? { providerErrors: refusal.providerErrors } : {}),
  };
}

/** See `chain-edit.ts` — the same observation, with the same both-directions contract. */
async function readObservation(
  provider: WorkItemProvider,
  issues: readonly number[],
): Promise<{ edges: ChainGraphEdge[]; errors: ChainSyncProviderError[] }> {
  const { edges, errors } = await fetchObservedEdges(
    provider,
    issues.map((issueNumber) => ({ issueNumber })),
    { includeDependents: true },
  );
  return { edges, errors };
}

/**
 * The step-0 claim's lifecycle: acquisition, heartbeat, re-assertion before
 * every mutation, and release. The rules — and the reasons — are the linear
 * commands' (see `chain-edit.ts`); only the packaging differs, so the advanced
 * commands can hold one of these without restating the machinery.
 */
interface LockRuntime {
  acquire(input: { scopes: string[]; operationId: string; now: string }): Promise<
    { ok: true } | { ok: false; scope: string; heldBy: ChainEditLockHolder }
  >;
  /** The scopes this run has stopped holding, re-asserted against the store. */
  verify(): Promise<readonly string[]>;
  release(): Promise<void>;
}

function createLockRuntime(chainStore: SqliteChainRegistryStore): LockRuntime {
  const ownerId = randomUUID();
  let heldScopes: string[] = [];
  const lostScopes: string[] = [];
  let renewTimer: ReturnType<typeof setInterval> | undefined;

  const renew = async (): Promise<void> => {
    if (heldScopes.length === 0) return;
    try {
      const { lost } = await chainStore.renewChainEditLocks({
        scopes: heldScopes,
        ownerId,
        now: new Date().toISOString(),
      });
      if (lost.length === 0) return;
      heldScopes = heldScopes.filter((s) => !lost.includes(s));
      for (const scope of lost) if (!lostScopes.includes(scope)) lostScopes.push(scope);
    } catch {
      /* a failed heartbeat is not a lost claim */
    }
  };

  return {
    async acquire(input) {
      const acquired = await chainStore.acquireChainEditLocks({
        scopes: input.scopes,
        ownerId,
        operationId: input.operationId,
        now: input.now,
        ownerPid: process.pid,
        ownerHost: hostname(),
      });
      if (!acquired.ok) return { ok: false, scope: acquired.scope, heldBy: acquired.heldBy };
      heldScopes = acquired.scopes;
      renewTimer = setInterval(() => {
        void renew();
      }, CHAIN_EDIT_LOCK_RENEW_MS);
      renewTimer.unref();
      return { ok: true };
    },
    async verify() {
      await renew();
      return lostScopes;
    },
    async release() {
      if (renewTimer !== undefined) {
        clearInterval(renewTimer);
        renewTimer = undefined;
      }
      if (heldScopes.length === 0) return;
      const scopes = heldScopes;
      heldScopes = [];
      try {
        await chainStore.releaseChainEditLocks(scopes, ownerId);
      } catch {
        /* left to the staleness takeover */
      }
    },
  };
}

/** The refusal a contended step-0 claim reports; nothing was written. */
function lockContentionFailure(
  operation: ChainAdvancedOperation,
  scope: string,
  heldBy: ChainEditLockHolder,
): ChainAdvancedFailure {
  const staleMinutes = Math.round(CHAIN_EDIT_LOCK_STALE_MS / 60_000);
  const abandonedHours = Math.round(CHAIN_EDIT_LOCK_ABANDONED_MS / (60 * 60 * 1000));
  const holder =
    heldBy.pid === undefined
      ? ""
      : ` It is held by process ${heldBy.pid}${heldBy.host === undefined ? "" : ` on ${heldBy.host}`}.`;
  const remediation =
    chainEditLockScopeKind(scope) === "alias"
      ? "A chain name is claimed from the moment an edit checks it is free until the chain that carries it is " +
        "registered. Nothing was written: choose another name, or re-run this command once the other edit finishes."
      : "Two chain edits that overlap on an Issue cannot run at once: whichever finished first would hand back " +
        "the execution labels it suspended while the other was still moving relationships. Nothing was written: " +
        "re-run this command once the other edit finishes.";
  return {
    kind: "lock_contended",
    transient: true,
    message:
      `${describeChainEditLockScope(scope)} is already claimed by the chain edit \`${heldBy.operationId}\`, ` +
      `which started at ${heldBy.acquiredAt}.${holder}`,
    remediation,
    recovery: [
      "No automation was suspended and nothing was written to GitHub or the registry, so there is no partial " +
        "state to repair.",
      `Re-run \`admin chain ${operation}\` with --yes once the other edit has finished. A claim left behind by an ` +
        `edit that crashed is taken over automatically once its process is gone and ${staleMinutes} minutes have ` +
        "passed without a heartbeat; one whose process is still running is never taken from it.",
      ...(holder === ""
        ? []
        : [
            "If the process named above is not a chain edit at all — a pid the system reassigned after the real " +
              `owner died — the claim is released anyway after ${abandonedHours} hours without a heartbeat.`,
          ]),
    ],
  };
}

/** Everything one run resolves before it can decide anything. */
interface AdvancedContext {
  session: ResolvedSession;
  provider: WorkItemProvider;
  chainStore: SqliteChainRegistryStore;
  activationStore: IssueActivationStore;
  now: string;
  /** Absent for a preview, which claims nothing. */
  locks?: LockRuntime;
}

/** The chain as the planner's `ChainLinearTarget`, plus its row revision. */
interface ResolvedChain {
  target: ChainLinearTarget;
  sessionId: string;
  rev: number;
}

async function resolveChain(
  chainStore: SqliteChainRegistryStore,
  ref: string,
): Promise<ResolvedChain | undefined> {
  const resolved = await chainStore.resolveChainHandle(ref);
  if (resolved === undefined) return undefined;
  const graph = await chainStore.getChain(resolved);
  if (!graph) return undefined;
  return {
    target: {
      chainId: resolved,
      headIssueNumber: graph.chain.headIssueNumber,
      members: graph.members.map((m) => ({ issueNumber: m.issueNumber, role: m.role })),
      edges: graph.edges.map((e) => ({
        blockerIssueNumber: e.blockerIssueNumber,
        blockedIssueNumber: e.blockedIssueNumber,
      })),
      graphRevision: graph.chain.graphRevision,
      ...(graph.chain.acceptedRevision === undefined
        ? {}
        : { acceptedRevision: graph.chain.acceptedRevision }),
    },
    sessionId: graph.chain.sessionId,
    rev: graph.chain.rev,
  };
}

async function currentRevision(
  chainStore: SqliteChainRegistryStore,
  chainId: string,
  acceptance?: Extract<ChainGraphAcceptance, { status: "accepted" | "unchanged" }>,
): Promise<ChainAdvancedRevisionOut> {
  const record = await chainStore.getChainRecord(chainId);
  return {
    graphRevision: record?.graphRevision ?? acceptance?.acceptedRevision ?? 0,
    acceptedRevision: record?.acceptedRevision ?? acceptance?.acceptedRevision ?? null,
    fingerprint: record?.graphFingerprint ?? acceptance?.fingerprint ?? "",
  };
}

/**
 * Map a non-committed acceptance onto this command's failure shape. The
 * remediation is phrased for the advanced operations, where GitHub already
 * holds the verified post-state and only the registry is behind.
 */
function acceptanceFailure(
  operation: ChainAdvancedOperation,
  chainId: string,
  acceptance: ChainGraphAcceptance,
  recovery: string[],
): ChainAdvancedFailure | undefined {
  if (acceptance.status === "accepted" || acceptance.status === "unchanged") return undefined;
  if (acceptance.status === "rejected") {
    return {
      ...refusalFailure(structuralChainAdvancedRefusal(operation, acceptance.diagnostics), recovery),
      remediation:
        "Another chain claimed one of these Issues while the relationships were being applied, so the registry " +
        "refused the graph inside its own transaction. GitHub holds the verified post-state; the registry does " +
        "not record it yet.",
    };
  }
  if (acceptance.status === "vetoed") {
    return {
      kind: "frozen_prefix",
      transient: false,
      message: acceptance.detail,
      remediation:
        "A dependency prefix was frozen at the exact moment this operation was being committed, and a started " +
        "Issue's pinned ancestry outranks an operator edit. GitHub holds the applied relationships but the " +
        "registry did not accept the graph.",
      recovery: [`Reconcile GitHub with the accepted graph using \`admin chain validate ${chainId}\`.`, ...recovery],
    };
  }
  if (acceptance.status === "conflict") {
    return {
      kind: "conflict",
      transient: true,
      message: acceptance.detail,
      remediation:
        "The chain was modified while this operation ran, so the graph was refused rather than written on top of " +
        "a state it never saw. The applied relationships stand on GitHub; re-run the command to record them.",
      recovery: [`Re-run \`admin chain ${operation}\` with --yes; it re-reads GitHub first.`, ...recovery],
    };
  }
  return {
    kind: "store_error",
    transient: false,
    message: `${acceptance.code}${acceptance.detail === undefined ? "" : `: ${acceptance.detail}`}`,
    remediation:
      "The registry refused the write, so the accepted graph is unchanged while GitHub holds the applied " +
      "relationships. Re-run the command once the registry accepts writes.",
    recovery: [`Inspect the chain with \`admin chain show ${chainId}\`.`, ...recovery],
  };
}

/* -------------------------------------------------------------------------
 * Execution skeleton — steps 2 through 7, shared by fork and merge
 * ---------------------------------------------------------------------- */

interface CommitSuccess {
  extra: Partial<ChainAdvancedPayload>;
  followUpFailure?: { code: string; detail?: string };
}

interface AdvancedExecutionSpec {
  operation: ChainAdvancedOperation;
  operationId: string;
  base: ChainAdvancedPayload;
  affectedIssues: readonly number[];
  plannedAdditions: readonly ChainGraphEdge[];
  plannedRemovals: readonly ChainGraphEdge[];
  /** Every edge the post-state should hold, across every result graph. */
  postEdges: readonly ChainEdgeInput[];
  observedIssues: readonly number[];
  /** Re-evaluate #891 with automation quiesced. `undefined` means pass. */
  frozenRecheck: () => Promise<ChainAdvancedRefusal | undefined>;
  /** Step 6: the registry commits. Runs only after a verified read-back. */
  commit: () => Promise<CommitSuccess | { failure: ChainAdvancedFailure; extra?: Partial<ChainAdvancedPayload> }>;
}

async function executeAdvancedOperation(
  context: AdvancedContext,
  spec: AdvancedExecutionSpec,
): Promise<ChainAdvancedPayload> {
  const { session, provider, activationStore, now } = context;
  const sessionId = session.sessionId;
  const { operation, base } = spec;

  const fail = (
    failure: ChainAdvancedFailure,
    extra: Partial<ChainAdvancedPayload> = {},
  ): ChainAdvancedPayload => ({ ...base, ...extra, ok: false, status: "failed", failure });

  const lostLocks = async (): Promise<string[]> => [...((await context.locks?.verify()) ?? [])];

  const lockLossFailure = (
    lost: readonly string[],
    recovery: string[],
    remediation = "A claim is this run's only for as long as it keeps renewing it, and one that has changed hands " +
      "means a second edit is already free to move these Issues, so this one stopped rather than write alongside " +
      `it. Re-run \`admin chain ${operation}\` with --yes once that edit has finished: it re-reads GitHub first ` +
      "and applies only what is still missing.",
  ): ChainAdvancedFailure => ({
    kind: "lock_contended",
    transient: true,
    message:
      `this operation no longer holds ${lost.map(describeChainEditLockScope).join(", ")}: another chain edit took ` +
      "the claim over while this one was running",
    remediation,
    recovery,
  });

  // -----------------------------------------------------------------------
  // Step 2: suspend automation for every affected Issue. The loop, the
  // per-Issue lock re-assertion, and the ownership attribution are the linear
  // commands' — see chain-edit.ts for the reasoning behind each.
  // -----------------------------------------------------------------------
  const lostBeforeSuspend = await lostLocks();
  if (lostBeforeSuspend.length > 0) {
    return fail(
      lockLossFailure(lostBeforeSuspend, [
        "No automation was suspended and nothing was written to GitHub or the registry, so there is no partial " +
          "state to repair.",
      ]),
    );
  }
  const labels: ChainAdvancedLabelChange[] = [];
  const suspended: number[] = [];
  const restoreScope = new Map<number, SuspensionAttribution>();
  for (const [index, issueNumber] of spec.affectedIssues.entries()) {
    const lostMidSuspend = index === 0 ? [] : await lostLocks();
    if (lostMidSuspend.length > 0) {
      return fail(
        lockLossFailure(lostMidSuspend, [
          "Nothing was written to GitHub or the registry: the operation stopped before its first relationship write.",
          ...restoreStep(sessionId, suspended, restoreScope),
        ]),
        { labels },
      );
    }
    let outcome: IssueActivationOutcome;
    let inherited: string[] = [];
    let standingLabels: string[] = [];
    try {
      const standing = await activationStore.getSuspension(sessionId, issueNumber);
      if (standing !== undefined) {
        standingLabels = [...standing.labels];
        inherited = suspensionLabelsOwnedBy(standing, spec.operationId);
      }
      outcome = await suspendIssueAutomation(
        session,
        provider,
        activationStore,
        issueNumber,
        spec.operationId,
        now,
      );
    } catch (err) {
      outcome = {
        issueNumber,
        ok: false,
        error: messageOf(err),
        removed: [],
        added: [],
        preserved: [],
        restorable: [],
      };
    }
    const stranded = (outcome.strandedLabels ?? []).filter((l) => !standingLabels.includes(l));
    const owned = [...new Set([...inherited, ...outcome.removed])].filter((l) => !stranded.includes(l));
    restoreScope.set(issueNumber, {
      owned,
      foreign: standingLabels.filter((l) => !owned.includes(l)),
      stranded,
    });
    labels.push({
      issueNumber,
      suspended: outcome.removed,
      restored: [],
      withheld: outcome.restorable,
      ...(outcome.error === undefined ? {} : { error: outcome.error }),
    });
    if (owned.length > 0 || stranded.length > 0) suspended.push(issueNumber);
    if (!outcome.ok) {
      return fail(
        {
          kind: "label_error",
          transient: false,
          message: `automation could not be suspended for #${issueNumber}: ${outcome.error ?? "unknown error"}`,
          remediation:
            "No GitHub relationship and no registry row was changed: the operation stopped before its first write " +
            "because an Issue could still have been picked up while the relationships were half-moved.",
          recovery: restoreStep(sessionId, suspended, restoreScope),
        },
        { labels },
      );
    }
  }

  const appliedEdges: ChainGraphEdge[] = [];
  const removedEdges: ChainGraphEdge[] = [];
  const alreadyPresentEdges: ChainGraphEdge[] = [];
  const alreadyAbsentEdges: ChainGraphEdge[] = [];
  const progress = (): Partial<ChainAdvancedPayload> => ({
    labels,
    appliedEdges,
    removedEdges,
    alreadyPresentEdges,
    alreadyAbsentEdges,
  });
  const remainingWork = (): string[] => {
    const toCreate = spec.plannedAdditions.filter(
      (e) => !appliedEdges.includes(e) && !alreadyPresentEdges.includes(e),
    );
    const toRemove = spec.plannedRemovals.filter(
      (e) => !removedEdges.includes(e) && !alreadyAbsentEdges.includes(e),
    );
    return [
      `Relationships created by this run: ${formatEdges(appliedEdges)}; removed: ${formatEdges(removedEdges)}.`,
      `Still to create: ${formatEdges(toCreate)}; still to remove: ${formatEdges(toRemove)}.`,
    ];
  };

  try {
    // ---------------------------------------------------------------------
    // Step 3: frozen prefixes again, now that no task can start from this
    // session's execution labels.
    // ---------------------------------------------------------------------
    const frozenRefusal = await spec.frozenRecheck();
    if (frozenRefusal !== undefined) {
      return fail(
        refusalFailure(frozenRefusal, [
          "A task started against a prefix this operation would rewrite, between the plan and the suspension. " +
            "Nothing was written to GitHub or the registry.",
          ...restoreStep(sessionId, suspended, restoreScope),
        ]),
        { labels },
      );
    }

    // ---------------------------------------------------------------------
    // Step 4: apply the relationship changes, idempotently. Additions before
    // removals: the graph GitHub holds part-way through is then always a
    // superset of the ordering constraints, so an interruption never leaves a
    // dependency path severed with its bridge missing.
    // ---------------------------------------------------------------------
    type EdgeWrite = { edge: ChainGraphEdge; kind: "add" | "remove" };
    const writes: EdgeWrite[] = [
      ...spec.plannedAdditions.map((edge) => ({ edge, kind: "add" as const })),
      ...spec.plannedRemovals.map((edge) => ({ edge, kind: "remove" as const })),
    ];
    for (const write of writes) {
      const lostMidWrite = await lostLocks();
      if (lostMidWrite.length > 0) {
        return fail(
          lockLossFailure(lostMidWrite, [
            ...remainingWork(),
            "The registry was NOT updated, so it still holds the graphs from before this operation.",
            ...restoreStep(sessionId, suspended, restoreScope),
          ]),
          progress(),
        );
      }
      const result =
        write.kind === "add"
          ? await provider.addDependency(write.edge.blockedIssueNumber, write.edge.blockerIssueNumber)
          : await provider.removeDependency(write.edge.blockedIssueNumber, write.edge.blockerIssueNumber);
      if (!result.ok) {
        return fail(
          {
            kind: "relationship_error",
            transient: true,
            message:
              `could not ${write.kind === "add" ? "create" : "remove"} the \`blocked by\` relationship ` +
              `${write.edge.blockerIssueNumber}->${write.edge.blockedIssueNumber}: ${result.error}`,
            remediation:
              "The registry was NOT updated, so it still holds the graphs from before this operation while GitHub " +
              "holds a partially moved one. Re-running the command re-reads GitHub and applies only what is still " +
              "missing — a change already made is left alone rather than repeated.",
            recovery: [
              ...remainingWork(),
              `Re-run \`admin chain ${operation}\` with --yes to finish the operation.`,
              ...restoreStep(sessionId, suspended, restoreScope),
            ],
          },
          progress(),
        );
      }
      if (write.kind === "add") {
        if (result.changed) appliedEdges.push(write.edge);
        else alreadyPresentEdges.push(write.edge);
      } else {
        if (result.changed) removedEdges.push(write.edge);
        else alreadyAbsentEdges.push(write.edge);
      }
    }

    // ---------------------------------------------------------------------
    // Step 5: read GitHub back and verify it holds exactly the planned
    // post-state — additions landed, removals disappeared, nothing else.
    // ---------------------------------------------------------------------
    const readBack = await readObservation(provider, spec.observedIssues);
    const verified = verifyAdvancedChainReadBack({
      operation,
      postEdges: spec.postEdges,
      removedEdges: spec.plannedRemovals,
      observedEdges: readBack.edges,
      observedIssues: spec.observedIssues,
      providerErrors: readBack.errors,
    });
    if ("action" in verified) {
      return fail(
        refusalFailure(verified, [
          "The registry was NOT updated: only a state GitHub was observed to hold is ever persisted.",
          `Compare the two with \`admin chain validate ${base.chainId ?? "<chain-ref>"}\`.`,
          ...restoreStep(sessionId, suspended, restoreScope),
        ]),
        progress(),
      );
    }

    // ---------------------------------------------------------------------
    // Step 6: the registry commits, under a claim that is still this run's.
    // ---------------------------------------------------------------------
    const lostBeforeCommit = await lostLocks();
    if (lostBeforeCommit.length > 0) {
      return fail(
        lockLossFailure(lostBeforeCommit, [
          ...remainingWork(),
          "The registry was NOT updated: a state verified before the claim changed hands is not one GitHub can " +
            "still be said to hold.",
          ...restoreStep(sessionId, suspended, restoreScope),
        ]),
        progress(),
      );
    }
    const committed = await spec.commit();
    if ("failure" in committed) {
      return fail(
        {
          ...committed.failure,
          recovery: [...committed.failure.recovery, ...restoreStep(sessionId, suspended, restoreScope)],
        },
        { ...progress(), ...committed.extra },
      );
    }

    // ---------------------------------------------------------------------
    // Step 7: restore the execution labels — and only now. Same rules as the
    // linear commands: only labels this operation's attribution owns, and only
    // while the claim still holds; the first loss ends the loop.
    // ---------------------------------------------------------------------
    let lostAtRestore = await lostLocks();
    const restoreFailures: string[] = [];
    for (const change of labels) {
      if (lostAtRestore.length > 0) break;
      const owned = restoreScope.get(change.issueNumber)?.owned ?? [];
      if (owned.length === 0) continue;
      let outcome: IssueActivationOutcome;
      try {
        outcome = await activateIssueAutomation(session, provider, activationStore, change.issueNumber, now, {
          onlyLabels: owned,
        });
      } catch (err) {
        outcome = {
          issueNumber: change.issueNumber,
          ok: false,
          error: messageOf(err),
          removed: [],
          added: [],
          preserved: [],
          restorable: [],
        };
      }
      change.restored = outcome.added;
      change.withheld = outcome.restorable;
      if (!outcome.ok) {
        change.error = outcome.error;
        restoreFailures.push(`#${change.issueNumber}: ${outcome.error ?? "unknown error"}`);
      } else {
        delete change.error;
      }
      lostAtRestore = await lostLocks();
    }

    const stillSuspended = labels
      .filter((l) =>
        l.withheld.some((label) => (restoreScope.get(l.issueNumber)?.owned ?? []).includes(label)),
      )
      .map((l) => l.issueNumber);

    const result: ChainAdvancedPayload = {
      ...base,
      ...progress(),
      ...committed.extra,
      ok: restoreFailures.length === 0 && lostAtRestore.length === 0,
      status: "applied",
      ...(committed.followUpFailure === undefined ? {} : { followUpFailure: committed.followUpFailure }),
    };

    if (lostAtRestore.length > 0) {
      const recovery = [
        "The registry holds the verified graphs, so the operation itself is complete; what is unresolved is the " +
          "execution labels.",
      ];
      if (stillSuspended.length > 0) {
        recovery.push(
          "Restore these once the other edit has finished, and only if it has not suspended them for itself:",
          ...restoreStep(sessionId, stillSuspended, restoreScope),
        );
      }
      const handedBack = labels.filter((l) => l.restored.length > 0).map((l) => l.issueNumber);
      if (handedBack.length > 0) {
        recovery.push(
          `Automation was restored for ${handedBack.map((n) => `#${n}`).join(", ")} before the claim was found to ` +
            "have changed hands. If the edit that now holds them is still running, suspend them again with " +
            `\`admin issue suspend ${issueList(handedBack)} --session-id ${sessionId} --yes\` until it finishes.`,
        );
      }
      result.failure = lockLossFailure(
        lostAtRestore,
        recovery,
        "GitHub and the registry agree and the operation is complete. Step 7 did not finish: handing these Issues " +
          "their execution labels back while another edit holds them would make them eligible in the middle of " +
          "that edit, which is exactly what the suspension exists to prevent.",
      );
      result.ok = false;
    } else if (restoreFailures.length > 0) {
      result.failure = {
        kind: "label_error",
        transient: true,
        message: `the operation was applied, but automation could not be restored for ${restoreFailures.length} Issue(s): ${restoreFailures.join("; ")}`,
        remediation:
          "GitHub and the registry agree and the operation is complete; only the execution labels are still " +
          "withheld, so the Issues stay ineligible until they are restored.",
        recovery: restoreStep(sessionId, stillSuspended, restoreScope),
      };
    }
    return result;
  } catch (err) {
    return fail(
      {
        kind: "store_error",
        transient: true,
        message: `the operation stopped unexpectedly after automation was suspended: ${messageOf(err)}`,
        remediation:
          "The failure above interrupted the sequence; whatever landed before it stands, and nothing after it was " +
          "written. Resolve the fault and re-run the command: it re-reads GitHub and the registry first and " +
          "applies only what is still missing.",
        recovery: [
          ...remainingWork(),
          `Re-run \`admin chain ${operation}\` with --yes to finish the operation.`,
          ...restoreStep(sessionId, suspended, restoreScope),
        ],
      },
      progress(),
    );
  }
}

/** The would-suspend preview for every affected Issue; writes nothing. */
function previewLabels(
  session: ResolvedSession,
  provider: WorkItemProvider,
  affectedIssues: readonly number[],
): ChainAdvancedLabelChange[] {
  const labels: ChainAdvancedLabelChange[] = [];
  for (const issueNumber of affectedIssues) {
    const read = provider.getItem(issueNumber);
    if (!read.ok) {
      labels.push({ issueNumber, suspended: [], restored: [], withheld: [], error: read.error });
      continue;
    }
    const diff = planSuspend(session, read.value.labels);
    labels.push({ issueNumber, suspended: diff.removed, restored: [], withheld: [] });
  }
  return labels;
}

/* -------------------------------------------------------------------------
 * chain fork
 * ---------------------------------------------------------------------- */

export async function runChainFork(argv: string[]): Promise<void> {
  const parsed = parseChainForkArgs(argv);
  if ("error" in parsed) die(parsed.error);
  const { chainRef, startIssueNumber, length, name, apply, sessionsPath, dbPath } = parsed;

  let registry: JsonSessionRegistry;
  try {
    registry = new JsonSessionRegistry(sessionsPath);
  } catch (err) {
    die(`Failed to load sessions file (${sessionsPath}): ${messageOf(err)}`);
  }
  const chainStore = new SqliteChainRegistryStore(dbPath);
  const activationStore = new SqliteIssueActivationStore(dbPath);
  const locks = createLockRuntime(chainStore);

  try {
    const resolved = await resolveChain(chainStore, chainRef);
    if (resolved === undefined) {
      report({ ok: false, operation: "fork", chainRef, reason: "not_found" }, () =>
        `No chain found for reference: ${chainRef}`,
      );
      process.exitCode = 1;
      return;
    }
    const { target } = resolved;
    if (parsed.sessionId !== undefined && parsed.sessionId !== resolved.sessionId) {
      die(
        `Chain ${target.chainId} belongs to session ${resolved.sessionId}, not ${parsed.sessionId}. ` +
          "Drop the session selector or name the owning session.",
      );
    }
    const session = await registry.getSessionById(resolved.sessionId);
    if (!session) die(describeUnresolvedSessionId(registry, resolved.sessionId, sessionsPath));
    let provider: WorkItemProvider;
    try {
      provider = await resolveIssueWorkItemProvider(session);
    } catch (err) {
      die(messageOf(err));
    }

    const now = new Date().toISOString();
    const operationId = [
      `${ADVANCED_SOURCE_PREFIX} fork`,
      target.chainId,
      String(startIssueNumber),
      length === undefined ? "end" : String(length),
    ].join("-");

    const base: ChainAdvancedPayload = {
      ok: false,
      operation: "fork",
      applied: apply,
      status: "failed",
      sessionId: session.sessionId,
      chainRef,
      chainId: target.chainId,
      startIssueNumber,
      ...(name === undefined ? {} : { newChainName: name }),
      issues: [],
      plannedAdditions: [],
      plannedRemovals: [],
      appliedEdges: [],
      removedEdges: [],
      alreadyPresentEdges: [],
      alreadyAbsentEdges: [],
      labels: [],
    };

    // Step 0. The segment is not known before the plan, but it is a subset of
    // the chain's members, so the members are the claim.
    if (apply) {
      const scopes = chainEditLockScopes({
        sessionId: session.sessionId,
        issueNumbers: target.members.map((m) => m.issueNumber),
        ...(name === undefined ? {} : { name }),
      });
      const acquired = await locks.acquire({ scopes, operationId, now });
      if (!acquired.ok) {
        const payload = {
          ...base,
          failure: lockContentionFailure("fork", acquired.scope, acquired.heldBy),
        };
        report(payload as unknown as Record<string, unknown>, (mode) => renderChainAdvanced(payload, mode));
        process.exitCode = 1;
        return;
      }
    }

    // The name check sits inside the claim, exactly as `chain new`'s does. A
    // taken name refuses before anything is planned; the interrupted-fork
    // leftover whose name this might be is finished through `admin chain new`,
    // whose own resumable-chain machinery recognizes it.
    if (name !== undefined) {
      const taken = await chainStore.resolveChainHandle(name);
      if (taken !== undefined) {
        await locks.release();
        die(
          `Chain name "${name}" already resolves to chain ${taken}. Choose another name, or omit it. ` +
            "(If an interrupted fork left an unregistered segment behind, finish it with `admin chain new`.)",
        );
      }
    }

    // Step 1.
    const observedIssues = [...new Set(target.members.map((m) => m.issueNumber))].sort((a, b) => a - b);
    const observation = await readObservation(provider, observedIssues);
    const ownership = await collectChainOwnership(chainStore, observedIssues, {
      filter: { sessionId: session.sessionId },
      excludeChainId: target.chainId,
    });
    const frozenSnapshots = await chainStore.listFrozenPrefixes({ chainId: target.chainId });

    const plan = planChainFork({
      target,
      startIssueNumber,
      ...(length === undefined ? {} : { length }),
      ...(name === undefined ? {} : { newChainName: name }),
      observedEdges: observation.edges,
      observedIssues,
      frozenSnapshots,
      ownership,
      providerErrors: observation.errors,
    });

    if (plan.action === "refuse") {
      const payload = { ...base, failure: refusalFailure(plan, []) };
      report(payload as unknown as Record<string, unknown>, (mode) => renderChainAdvanced(payload, mode));
      process.exitCode = 1;
      return;
    }

    const graphOut: ChainAdvancedGraphOut = {
      headIssueNumber: plan.remaining.headIssueNumber,
      members: plan.remaining.members,
      edges: plan.remaining.edges,
      fingerprint: plan.remaining.canonical.fingerprint,
    };
    const segmentOut: ChainAdvancedGraphOut = {
      headIssueNumber: plan.segment.headIssueNumber,
      members: plan.segment.members,
      edges: plan.segment.edges,
      fingerprint: plan.segment.canonical.fingerprint,
    };
    const planned: ChainAdvancedPayload = {
      ...base,
      segmentIssues: plan.segmentIssues,
      detach: plan.detach,
      issues: plan.affectedIssues,
      plannedAdditions: plan.edgeAdditions,
      plannedRemovals: plan.edgeRemovals,
      graph: graphOut,
      segmentGraph: segmentOut,
    };

    if (!apply) {
      const payload: ChainAdvancedPayload = {
        ...planned,
        ok: true,
        status: "would_apply",
        labels: previewLabels(session, provider, plan.affectedIssues),
      };
      report(payload as unknown as Record<string, unknown>, (mode) => renderChainAdvanced(payload, mode));
      return;
    }

    const context: AdvancedContext = { session, provider, chainStore, activationStore, now, locks };
    const forkShape: ForkFrozenShape = {
      chainId: target.chainId,
      segmentIssues: plan.segmentIssues,
      remaining: { members: plan.remaining.members, edges: plan.remaining.edges },
    };
    const payload = await executeAdvancedOperation(context, {
      operation: "fork",
      operationId,
      base: planned,
      affectedIssues: plan.affectedIssues,
      plannedAdditions: plan.edgeAdditions,
      plannedRemovals: plan.edgeRemovals,
      postEdges: [...plan.remaining.edges, ...plan.segment.edges],
      observedIssues,
      frozenRecheck: async () => {
        const fresh = await chainStore.listFrozenPrefixes({ chainId: target.chainId });
        return checkForkFrozenPrefixes(forkShape, fresh);
      },
      commit: () => commitFork(context, resolved, plan, name, now),
    });

    report(payload as unknown as Record<string, unknown>, (mode) => renderChainAdvanced(payload, mode));
    if (!payload.ok) process.exitCode = 1;
  } finally {
    await locks.release();
    activationStore.close();
    chainStore.close();
  }
}

/**
 * Fork's registry commits: shrink first, then register the segment. The order
 * matters — the segment's members are the forked chain's until the shrunk
 * graph is accepted, and only then are they free for a new chain to claim.
 * A failure in between leaves the segment unregistered with its relationships
 * standing, which is exactly the state `admin chain new` finishes.
 */
async function commitFork(
  context: AdvancedContext,
  resolved: ResolvedChain,
  plan: ChainForkApply,
  name: string | undefined,
  now: string,
): Promise<CommitSuccess | { failure: ChainAdvancedFailure }> {
  const { chainStore, session } = context;
  const source = `${ADVANCED_SOURCE_PREFIX} fork`;
  const forkShape: ForkFrozenShape = {
    chainId: plan.chainId,
    segmentIssues: plan.segmentIssues,
    remaining: { members: plan.remaining.members, edges: plan.remaining.edges },
  };
  const segmentRecovery = plan.detach
    ? []
    : [
        `The segment's relationships stand on GitHub; register it with \`admin chain new ` +
          `${issueList(plan.segmentIssues)}${name === undefined ? "" : ` ${name}`} --session-id ` +
          `${session.sessionId}\` — it adopts what is already ` +
          "in place, and resumes a segment chain an earlier run created but never accepted.",
      ];

  const acceptance = await acceptChainGraph(chainStore, {
    chainId: plan.chainId,
    members: plan.remaining.members,
    edges: plan.remaining.edges,
    headIssueNumber: plan.remaining.headIssueNumber,
    expectedRev: resolved.rev,
    ownershipScope: { sessionId: session.sessionId },
    commitGuard: ({ frozenPrefixes }) => checkForkFrozenPrefixes(forkShape, frozenPrefixes)?.message,
    source,
    now,
  });
  const accepted = acceptanceFailure("fork", plan.chainId, acceptance, segmentRecovery);
  if (accepted !== undefined) return { failure: accepted };
  const committedAcceptance = acceptance as Extract<
    ChainGraphAcceptance,
    { status: "accepted" | "unchanged" }
  >;

  let followUpFailure: { code: string; detail?: string } | undefined;
  if (committedAcceptance.followUpFailure !== undefined) {
    followUpFailure = {
      code: committedAcceptance.followUpFailure.code,
      ...(committedAcceptance.followUpFailure.detail === undefined
        ? {}
        : { detail: committedAcceptance.followUpFailure.detail }),
    };
  }
  const marked = await chainStore.setChainSyncState(plan.chainId, {
    status: "in_sync",
    checkedAt: now,
    syncedAt: now,
    expectedRev: committedAcceptance.committedRev,
    now,
  });
  if (!marked.ok) {
    followUpFailure = {
      code: marked.code,
      detail: `the fork was applied, but the chain's synchronization metadata was not updated${marked.detail === undefined ? "" : `: ${marked.detail}`}`,
    };
  }
  const revision = await currentRevision(chainStore, plan.chainId, committedAcceptance);

  if (plan.detach) {
    return { extra: { revision }, ...(followUpFailure === undefined ? {} : { followUpFailure }) };
  }

  // The segment chain: created unaccepted, then accepted — the same two-step
  // `chain new` performs, and the same leftover it can resume.
  const created = await chainStore.createChain({
    sessionId: session.sessionId,
    headIssueNumber: plan.segment.headIssueNumber,
    members: plan.segment.members,
    edges: plan.segment.edges,
    ...(name === undefined ? {} : { title: name, alias: name }),
    source,
    now,
  });
  if (!created.ok) {
    return {
      failure: {
        kind: "store_error",
        transient: false,
        message: `the segment chain could not be created: ${created.code}${created.detail === undefined ? "" : `: ${created.detail}`}`,
        remediation:
          `Chain ${plan.chainId} now holds the post-fork graph and GitHub agrees, but the extracted segment is ` +
          "not registered as a chain.",
        recovery: segmentRecovery,
      },
    };
  }
  const newChainId = created.value.chain.chainId;
  const segmentAcceptance = await acceptChainGraph(chainStore, {
    chainId: newChainId,
    members: plan.segment.members,
    edges: plan.segment.edges,
    headIssueNumber: plan.segment.headIssueNumber,
    expectedRev: created.value.chain.rev,
    ownershipScope: { sessionId: session.sessionId },
    source,
    now,
  });
  const segmentFailed = acceptanceFailure("fork", newChainId, segmentAcceptance, segmentRecovery);
  if (segmentFailed !== undefined) {
    return {
      failure: {
        ...segmentFailed,
        remediation:
          `Chain ${plan.chainId} holds the post-fork graph and GitHub agrees; segment chain ${newChainId} was ` +
          `created but its graph was not accepted. ${segmentFailed.remediation}`,
      },
    };
  }
  const committedSegment = segmentAcceptance as Extract<
    ChainGraphAcceptance,
    { status: "accepted" | "unchanged" }
  >;
  const markedSegment = await chainStore.setChainSyncState(newChainId, {
    status: "in_sync",
    checkedAt: now,
    syncedAt: now,
    expectedRev: committedSegment.committedRev,
    now,
  });
  if (!markedSegment.ok && followUpFailure === undefined) {
    followUpFailure = {
      code: markedSegment.code,
      detail: `the fork was applied, but the segment chain's synchronization metadata was not updated${markedSegment.detail === undefined ? "" : `: ${markedSegment.detail}`}`,
    };
  }
  const segmentRevision = await currentRevision(chainStore, newChainId, committedSegment);

  return {
    extra: { revision, newChainId, segmentRevision },
    ...(followUpFailure === undefined ? {} : { followUpFailure }),
  };
}

/* -------------------------------------------------------------------------
 * chain merge
 * ---------------------------------------------------------------------- */

export async function runChainMerge(argv: string[]): Promise<void> {
  const parsed = parseChainMergeArgs(argv);
  if ("error" in parsed) die(parsed.error);
  const { targetRef, sourceRef, position, apply, sessionsPath, dbPath } = parsed;

  let registry: JsonSessionRegistry;
  try {
    registry = new JsonSessionRegistry(sessionsPath);
  } catch (err) {
    die(`Failed to load sessions file (${sessionsPath}): ${messageOf(err)}`);
  }
  const chainStore = new SqliteChainRegistryStore(dbPath);
  const activationStore = new SqliteIssueActivationStore(dbPath);
  const locks = createLockRuntime(chainStore);

  try {
    const resolvedTarget = await resolveChain(chainStore, targetRef);
    if (resolvedTarget === undefined) {
      report({ ok: false, operation: "merge", chainRef: targetRef, reason: "not_found" }, () =>
        `No chain found for reference: ${targetRef}`,
      );
      process.exitCode = 1;
      return;
    }
    const resolvedSource = await resolveChain(chainStore, sourceRef);
    if (resolvedSource === undefined) {
      report({ ok: false, operation: "merge", chainRef: sourceRef, reason: "not_found" }, () =>
        `No chain found for reference: ${sourceRef}`,
      );
      process.exitCode = 1;
      return;
    }
    const target = resolvedTarget.target;
    const sourceChain = resolvedSource.target;

    if (target.chainId === sourceChain.chainId) {
      // The one honest way two refs collapse into one chain is a source
      // already retired into the target: its ID is an alias now. Distinguish
      // that from an operator naming the same chain twice.
      const message =
        sourceRef !== sourceChain.chainId && targetRef !== sourceRef
          ? `"${sourceRef}" already resolves to chain ${target.chainId}: the source chain appears to have been ` +
            "merged and retired. Nothing is left to do. If an interrupted run left execution labels withheld, " +
            "restore them with `admin issue activate`."
          : `Chain ${target.chainId} cannot be merged into itself. Name two different chains.`;
      die(message);
    }
    if (resolvedTarget.sessionId !== resolvedSource.sessionId) {
      die(
        `Chain ${target.chainId} belongs to session ${resolvedTarget.sessionId} but chain ` +
          `${sourceChain.chainId} belongs to ${resolvedSource.sessionId}. A merge never crosses sessions.`,
      );
    }
    if (parsed.sessionId !== undefined && parsed.sessionId !== resolvedTarget.sessionId) {
      die(
        `Chain ${target.chainId} belongs to session ${resolvedTarget.sessionId}, not ${parsed.sessionId}. ` +
          "Drop the session selector or name the owning session.",
      );
    }
    const session = await registry.getSessionById(resolvedTarget.sessionId);
    if (!session) die(describeUnresolvedSessionId(registry, resolvedTarget.sessionId, sessionsPath));
    let provider: WorkItemProvider;
    try {
      provider = await resolveIssueWorkItemProvider(session);
    } catch (err) {
      die(messageOf(err));
    }

    const now = new Date().toISOString();
    const operationId = [
      `${ADVANCED_SOURCE_PREFIX} merge`,
      target.chainId,
      sourceChain.chainId,
      position,
    ].join("-");

    const base: ChainAdvancedPayload = {
      ok: false,
      operation: "merge",
      applied: apply,
      status: "failed",
      sessionId: session.sessionId,
      chainRef: targetRef,
      chainId: target.chainId,
      sourceChainRef: sourceRef,
      sourceChainId: sourceChain.chainId,
      position,
      issues: [],
      plannedAdditions: [],
      plannedRemovals: [],
      appliedEdges: [],
      removedEdges: [],
      alreadyPresentEdges: [],
      alreadyAbsentEdges: [],
      labels: [],
    };

    // Step 0: every member of both chains.
    if (apply) {
      const scopes = chainEditLockScopes({
        sessionId: session.sessionId,
        issueNumbers: [
          ...target.members.map((m) => m.issueNumber),
          ...sourceChain.members.map((m) => m.issueNumber),
        ],
      });
      const acquired = await locks.acquire({ scopes, operationId, now });
      if (!acquired.ok) {
        const payload = {
          ...base,
          failure: lockContentionFailure("merge", acquired.scope, acquired.heldBy),
        };
        report(payload as unknown as Record<string, unknown>, (mode) => renderChainAdvanced(payload, mode));
        process.exitCode = 1;
        return;
      }
    }

    // Step 1.
    const observedIssues = [
      ...new Set([
        ...target.members.map((m) => m.issueNumber),
        ...sourceChain.members.map((m) => m.issueNumber),
      ]),
    ].sort((a, b) => a - b);
    const observation = await readObservation(provider, observedIssues);
    const ownership = (
      await collectChainOwnership(chainStore, observedIssues, {
        filter: { sessionId: session.sessionId },
        excludeChainId: target.chainId,
      })
    ).filter((entry) => entry.chainId !== sourceChain.chainId);
    const frozenSnapshots = [
      ...(await chainStore.listFrozenPrefixes({ chainId: target.chainId })),
      ...(await chainStore.listFrozenPrefixes({ chainId: sourceChain.chainId })),
    ];

    const plan = planChainMerge({
      target,
      source: sourceChain,
      position,
      observedEdges: observation.edges,
      observedIssues,
      frozenSnapshots,
      ownership,
      providerErrors: observation.errors,
    });

    if (plan.action === "refuse") {
      const payload = { ...base, failure: refusalFailure(plan, []) };
      report(payload as unknown as Record<string, unknown>, (mode) => renderChainAdvanced(payload, mode));
      process.exitCode = 1;
      return;
    }

    const graphOut: ChainAdvancedGraphOut = {
      headIssueNumber: plan.merged.headIssueNumber,
      members: plan.merged.members,
      edges: plan.merged.edges,
      fingerprint: plan.merged.canonical.fingerprint,
    };
    const planned: ChainAdvancedPayload = {
      ...base,
      issues: plan.affectedIssues,
      plannedAdditions: plan.edgeAdditions,
      plannedRemovals: [],
      graph: graphOut,
    };

    if (!apply) {
      const payload: ChainAdvancedPayload = {
        ...planned,
        ok: true,
        status: "would_apply",
        labels: previewLabels(session, provider, plan.affectedIssues),
      };
      report(payload as unknown as Record<string, unknown>, (mode) => renderChainAdvanced(payload, mode));
      return;
    }

    const context: AdvancedContext = { session, provider, chainStore, activationStore, now, locks };
    const payload = await executeAdvancedOperation(context, {
      operation: "merge",
      operationId,
      base: planned,
      affectedIssues: plan.affectedIssues,
      plannedAdditions: plan.edgeAdditions,
      plannedRemovals: [],
      postEdges: plan.merged.edges,
      observedIssues,
      frozenRecheck: async () => {
        const fresh = [
          ...(await chainStore.listFrozenPrefixes({ chainId: target.chainId })),
          ...(await chainStore.listFrozenPrefixes({ chainId: sourceChain.chainId })),
        ];
        return checkMergeFrozenPrefixes({ members: plan.merged.members, edges: plan.merged.edges }, fresh);
      },
      commit: () => commitMerge(context, resolvedTarget, resolvedSource, plan, now),
    });

    report(payload as unknown as Record<string, unknown>, (mode) => renderChainAdvanced(payload, mode));
    if (!payload.ok) process.exitCode = 1;
  } finally {
    await locks.release();
    activationStore.close();
    chainStore.close();
  }
}

/**
 * Merge's registry commits: accept the combined graph into the target — the
 * store's exclusive claim tolerating exactly the source — and then retire the
 * source in one registry transaction. Between the two, both chains record the
 * same members; the step-0 claim is what keeps any other edit off them, and a
 * failure there is retryable because the plan recognizes the merged-but-not-
 * retired state and resumes with the retirement alone.
 */
async function commitMerge(
  context: AdvancedContext,
  resolvedTarget: ResolvedChain,
  resolvedSource: ResolvedChain,
  plan: ChainMergeApply,
  now: string,
): Promise<CommitSuccess | { failure: ChainAdvancedFailure }> {
  const { chainStore, session } = context;
  const source = `${ADVANCED_SOURCE_PREFIX} merge`;
  const retirementRecovery = [
    `Chain ${plan.chainId} holds the merged graph; chain ${plan.sourceChainId} is still registered over the same ` +
      `Issues. Re-run \`admin chain merge\` with --yes: it detects the merged state and performs only the retirement.`,
  ];

  let followUpFailure: { code: string; detail?: string } | undefined;
  if (!plan.resumeRetirement) {
    const acceptance = await acceptChainGraph(chainStore, {
      chainId: plan.chainId,
      members: plan.merged.members,
      edges: plan.merged.edges,
      headIssueNumber: plan.merged.headIssueNumber,
      expectedRev: resolvedTarget.rev,
      ownershipScope: { sessionId: session.sessionId },
      // The source still records the members it is handing over; the claim
      // must bind every chain EXCEPT it.
      tolerateOwnerChainIds: [plan.sourceChainId],
      commitGuard: ({ frozenPrefixes }) =>
        checkMergeFrozenPrefixes({ members: plan.merged.members, edges: plan.merged.edges }, frozenPrefixes)
          ?.message,
      // The merged graph answers for the source chain's started Issues too,
      // and a freeze landing on one of them is recorded against the source —
      // the guard must be handed both chains' rows.
      commitGuardChainIds: [plan.sourceChainId],
      source,
      now,
    });
    const failed = acceptanceFailure("merge", plan.chainId, acceptance, []);
    if (failed !== undefined) return { failure: failed };
    const committed = acceptance as Extract<ChainGraphAcceptance, { status: "accepted" | "unchanged" }>;
    if (committed.followUpFailure !== undefined) {
      followUpFailure = {
        code: committed.followUpFailure.code,
        ...(committed.followUpFailure.detail === undefined
          ? {}
          : { detail: committed.followUpFailure.detail }),
      };
    }
    const marked = await chainStore.setChainSyncState(plan.chainId, {
      status: "in_sync",
      checkedAt: now,
      syncedAt: now,
      expectedRev: committed.committedRev,
      now,
    });
    if (!marked.ok) {
      followUpFailure = {
        code: marked.code,
        detail: `the merge was applied, but the chain's synchronization metadata was not updated${marked.detail === undefined ? "" : `: ${marked.detail}`}`,
      };
    }
  }

  const retired = await chainStore.retireChain({
    chainId: plan.sourceChainId,
    intoChainId: plan.chainId,
    expectedRev: resolvedSource.rev,
    reason: `retired by ${source} into ${plan.chainId}`,
    now,
  });
  if (!retired.ok) {
    const conflicted = retired.code === "conflict";
    return {
      failure: {
        kind: conflicted ? "conflict" : "store_error",
        transient: conflicted,
        message:
          `chain ${plan.sourceChainId} could not be retired: ${retired.code}` +
          `${retired.detail === undefined ? "" : `: ${retired.detail}`}`,
        remediation: conflicted
          ? "The source chain was modified while this merge ran, so it was not retired on top of a state this run " +
            "never saw."
          : "The registry refused the retirement; the source chain still resolves to its own graph over Issues the " +
            "target now also records.",
        recovery: retirementRecovery,
      },
    };
  }

  const revision = await currentRevision(chainStore, plan.chainId);
  return {
    extra: {
      revision,
      retirement: {
        retiredChainId: retired.value.chainId,
        intoChainId: retired.value.intoChainId,
        movedAliases: retired.value.movedAliases,
      },
    },
    ...(followUpFailure === undefined ? {} : { followUpFailure }),
  };
}
