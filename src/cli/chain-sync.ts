/**
 * `admin chain sync` (issue #892): the mutating half of the chain operator
 * surface, split out of #789's read-only inspection.
 *
 * GitHub is the runner-visible dependency truth; SQLite holds the last graph
 * that was accepted plus the frozen snapshots started Issues depend on. This
 * command is the one explicit way an operator moves the first into the second.
 * It reads the Issue Relationships for a chain's registered members, builds the
 * observed graph exactly as `chain validate` does, asks {@link planChainSync}
 * whether that graph may be accepted, and — only then, and only with `--yes` —
 * hands it to {@link acceptChainGraph}, which advances the graph, its revision,
 * its fingerprint, and the accepted pointer as one atomic step.
 *
 * Preview by default, apply with `--yes`, like every other state-changing
 * operator command in this CLI (`issue activate|suspend`, `dispute reopen`,
 * `n8n deploy`). A preview writes nothing at all — not the graph, not sync
 * metadata — so the plan it prints is exactly what `--yes` would carry out
 * against an unchanged registry.
 *
 * What a failed import must *not* do is the reason the ordering below is what
 * it is. Validation happens before the first write, so a refused graph never
 * reaches the store and the previously accepted revision stands untouched; and
 * because acceptance itself moves the pointer last, even a mid-write failure
 * leaves the last-known-good graph in place (see chain-acceptance.ts).
 *
 * One check cannot be left where the plan makes it. Freezing a dependency
 * prefix (#891) writes no chain row, so the row-revision compare-and-set that
 * pins every other part of this decision cannot notice a task starting after
 * the plan read the snapshots — and the prefix that task is now running against
 * would be overwritten by an import planned before it existed. So the
 * frozen-prefix check is re-run as the acceptance's commit guard, evaluated
 * inside the transaction that moves the accepted pointer. Running it merely
 * *late* would not be enough: any read taken before that write can be
 * invalidated by a freeze landing after it, and the freeze bumps nothing for a
 * compare-and-set to catch. Inside the write there is no such gap — a freeze is
 * either already visible to the guard, and refuses the import, or is ordered
 * after a pointer move it therefore snapshots. Either way the observed graph is
 * left on record as a candidate revision, which is what a graph that never
 * reached the pointer always is.
 *
 * Nothing here posts a GitHub comment, moves a label, or writes an Issue
 * Relationship in either direction: synchronization is one-way by construction.
 *
 * Sync metadata follows the same distinction the plan draws. A completed import
 * or an already-current chain records `in_sync` with a fresh `syncedAt`. A
 * structural or frozen-prefix refusal records `error` with the one-line reason,
 * so `admin chain list --sync-status error` surfaces chains that need an
 * operator — that is a durable fact about the observed graph, and it changes no
 * accepted graph. A provider outage, a session-configuration problem, a lost
 * compare-and-set, or a store failure records *nothing*: none of them learned
 * anything about the chain, and marking a chain `error` for a network blip
 * would bury the chains that genuinely are.
 *
 * Every one of those writes is itself a claim about a particular graph, so it
 * carries the row revision the claim was reached about. Two overlapping runs
 * reach their verdicts at different speeds, and an unguarded write would let
 * the slower one stamp `in_sync` over the structural `error` the faster one
 * recorded about the graph that replaced what it saw — leaving
 * `chain list --sync-status` reporting a state nobody checked. A run that loses
 * that compare-and-set keeps its outcome and reports the lost write as
 * follow-up bookkeeping.
 *
 * `--all` treats each chain independently. One chain's failure — for any of the
 * reasons above, including a provider it shares with the others — never stops
 * the rest from being checked, and every failure is reported in the same run.
 */

import type { OutputMode } from "./cli-io.js";
import { die, report } from "./cli-io.js";
import { parseCommonOptions, resolveSessionSelector } from "./admin-command.js";
import { fetchObservedEdges } from "./chain-inspect.js";
import type { ProviderFetchError } from "./chain-inspect.js";
import { resolveIssueWorkItemProvider } from "./issue-activation.js";
import { describeUnresolvedSessionId, JsonSessionRegistry } from "../registries/json-session-registry.js";
import { SqliteChainRegistryStore } from "../stores/sqlite-chain-registry-store.js";
import type {
  ChainGraph,
  ChainMemberInput,
  ChainRecord,
  ChainSyncStatePatch,
} from "../core/chain-registry.js";
import type { ChainGraphDiagnostic, ChainGraphEdge, ChainGraphSnapshot } from "../core/chain-graph.js";
import { checkFrozenPrefixes } from "../core/chain-frozen-prefix.js";
import type { FrozenPrefixViolation } from "../core/chain-frozen-prefix.js";
import { acceptChainGraph, collectChainOwnership } from "../core/chain-acceptance.js";
import { frozenPrefixRefusal, planChainSync } from "../core/chain-sync.js";
import type { ChainSyncPlan, ChainSyncRefusal, ChainSyncRefusalKind } from "../core/chain-sync.js";
import type { WorkItemProvider } from "../providers/types.js";

/** Provenance recorded on every revision this command creates. */
const SYNC_SOURCE = "admin chain sync";

/* -------------------------------------------------------------------------
 * Arguments
 * ---------------------------------------------------------------------- */

interface ChainSyncArgs {
  /** Exactly one of `chainRef` / `all` is set. */
  chainRef: string | undefined;
  all: boolean;
  sessionId: string | undefined;
  apply: boolean;
  sessionsPath: string;
  dbPath: string | undefined;
}

export function parseChainSyncArgs(argv: string[]): ChainSyncArgs | { error: string } {
  const parsed = parseCommonOptions(argv, {
    session: "none",
    booleanFlags: ["all", "yes"],
    valueFlags: ["session-id", "session-ref", "sessions-path"],
    allowPositionals: true,
  });
  if ("error" in parsed) return { error: parsed.error };
  const { args, flags, positionals } = parsed;

  const all = flags.has("all");
  if (positionals.length > 1) {
    return { error: `Unexpected argument: ${positionals[1]}` };
  }
  if (all && positionals.length > 0) {
    return { error: "Provide either <chain-ref> or --all, not both" };
  }
  if (!all && positionals.length === 0) {
    return { error: "chain-ref is required, e.g. admin chain sync chain_777 (or --all for every chain)" };
  }

  let sessionId: string | undefined;
  if (args["session-id"] !== undefined || args["session-ref"] !== undefined) {
    if (!all) {
      // A chain-ref already names exactly one chain, so a session filter can
      // only ever contradict it or be redundant. Refuse rather than pick.
      return { error: "--session-id/--session-ref only apply with --all" };
    }
    const selector = resolveSessionSelector(args);
    if ("error" in selector) return { error: selector.error };
    sessionId = selector.sessionId;
  }

  return {
    chainRef: all ? undefined : positionals[0],
    all,
    sessionId,
    apply: flags.has("yes"),
    sessionsPath: parsed.sessionsPath,
    dbPath: parsed.dbPath,
  };
}

/* -------------------------------------------------------------------------
 * Result shape
 * ---------------------------------------------------------------------- */

/**
 * Every way one chain's synchronization can fail. The three that come from
 * {@link planChainSync} describe the observed graph; the rest describe the
 * attempt itself, and only the plan's own kinds ever record `error` sync state.
 */
export type ChainSyncFailureKind = ChainSyncRefusalKind | "session_error" | "conflict" | "store_error";

interface ChainSyncFailure {
  kind: ChainSyncFailureKind;
  /** True when an unchanged re-run could succeed. */
  transient: boolean;
  message: string;
  /** Which side has to move, and how. Never empty. */
  remediation: string;
  diagnostics?: ChainGraphDiagnostic[];
  violations?: FrozenPrefixViolation[];
  providerErrors?: ProviderFetchError[];
}

/**
 * One chain's outcome.
 *
 * `imported` / `in_sync` are apply-mode results; `would_import` /
 * `would_remain_in_sync` are their preview counterparts, spelled differently on
 * purpose so a preview payload can never be mistaken for a record of a write
 * that happened.
 */
type ChainSyncOutcome = "imported" | "in_sync" | "would_import" | "would_remain_in_sync" | "failed";

interface ChainSyncResult {
  chainId: string;
  sessionId: string;
  status: ChainSyncOutcome;
  /** The graph on record when the observation was taken. */
  expectedEdges: ChainGraphEdge[];
  /** The graph GitHub reported. Empty when it could not be read. */
  observedEdges: ChainGraphEdge[];
  revision: {
    graphRevision: number;
    acceptedRevision: number | null;
    fingerprint: string;
  };
  /** Present once an import has landed (or would): the revision it produced. */
  importedRevision?: number;
  importedFingerprint?: string;
  /** Present when the observed graph differs from the one on record. */
  driftDiagnostics?: ChainGraphDiagnostic[];
  failure?: ChainSyncFailure;
  /**
   * A bookkeeping write that failed after the outcome above was decided (a
   * predecessor left unlabelled, a sync-state row left stale). The outcome
   * stands; the label is repaired by the next run.
   */
  followUpFailure?: { code: string; detail?: string };
}

interface ChainSyncPayload {
  ok: boolean;
  applied: boolean;
  scope: { chainRef?: string; all: boolean; sessionId?: string };
  count: number;
  imported: number;
  inSync: number;
  failed: number;
  chains: ChainSyncResult[];
}

/* -------------------------------------------------------------------------
 * Rendering
 * ---------------------------------------------------------------------- */

const FAILURE_LABELS: Record<ChainSyncFailureKind, string> = {
  provider_error: "provider read failed (transient)",
  session_error: "session/provider configuration",
  structural: "structural graph problem",
  frozen_prefix: "frozen dependency-prefix conflict",
  conflict: "chain moved during sync (retryable)",
  store_error: "registry write failed",
};

function formatEdges(edges: readonly ChainGraphEdge[]): string {
  if (edges.length === 0) return "(none)";
  return edges.map((e) => `${e.blockerIssueNumber}->${e.blockedIssueNumber}`).join(", ");
}

function renderChainResult(result: ChainSyncResult): string[] {
  const lines = [`  ${result.chainId} (session ${result.sessionId}): ${result.status}`];
  lines.push(
    `    revision ${result.revision.graphRevision} (accepted: ${result.revision.acceptedRevision ?? "none"})` +
      (result.importedRevision !== undefined
        ? ` -> ${result.importedRevision}${result.importedFingerprint ? ` ${result.importedFingerprint}` : ""}`
        : ""),
  );
  if (result.status === "failed" && result.failure) {
    const failure = result.failure;
    lines.push(`    error [${failure.kind}]: ${FAILURE_LABELS[failure.kind]} — ${failure.message}`);
    lines.push(`    expected edges (registry): ${formatEdges(result.expectedEdges)}`);
    lines.push(`    observed edges (GitHub):   ${formatEdges(result.observedEdges)}`);
    for (const d of failure.diagnostics ?? []) {
      lines.push(`      [${d.code}] ${d.message}`);
      lines.push(`        expected: ${formatEdges(d.expectedEdges)}  observed: ${formatEdges(d.observedEdges)}`);
    }
    for (const v of failure.violations ?? []) {
      lines.push(`      [${v.code}] ${v.message}`);
      lines.push(`        expected: ${formatEdges(v.expectedEdges)}  observed: ${formatEdges(v.observedEdges)}`);
    }
    for (const e of failure.providerErrors ?? []) {
      lines.push(`      #${e.issueNumber}: ${e.error}`);
    }
    lines.push(`    remediation: ${failure.remediation}`);
  } else if (result.driftDiagnostics && result.driftDiagnostics.length > 0) {
    lines.push(`    drift vs GitHub, imported by this sync (${result.driftDiagnostics.length}):`);
    for (const d of result.driftDiagnostics) {
      lines.push(`      [${d.code}] ${d.message}`);
      lines.push(`        expected: ${formatEdges(d.expectedEdges)}  observed: ${formatEdges(d.observedEdges)}`);
    }
  }
  if (result.followUpFailure) {
    lines.push(`    warning: follow-up bookkeeping failed [${result.followUpFailure.code}] ${result.followUpFailure.detail ?? ""}`.trimEnd());
  }
  return lines;
}

function renderChainSync(payload: ChainSyncPayload, _mode: OutputMode): string {
  const scope = payload.scope.all
    ? `all chains${payload.scope.sessionId !== undefined ? ` in session ${payload.scope.sessionId}` : ""}`
    : `chain ${payload.scope.chainRef}`;
  const mode = payload.applied ? "applied" : "preview (pass --yes to apply)";
  const lines = [
    `Chain sync — ${scope}, ${mode}: ${payload.count} checked, ${payload.imported} ${payload.applied ? "imported" : "to import"}, ${payload.inSync} already in sync, ${payload.failed} failed.`,
  ];
  for (const result of payload.chains) lines.push(...renderChainResult(result));
  if (payload.failed > 0) {
    lines.push(
      "No accepted graph was changed for a failed chain: GitHub remains the dependency truth, and the registry keeps its last accepted graph until the observed one passes.",
    );
  }
  return lines.join("\n");
}

/* -------------------------------------------------------------------------
 * Execution
 * ---------------------------------------------------------------------- */

type ProviderEntry = { provider: WorkItemProvider } | { error: string };

function snapshotOf(graph: ChainGraph): ChainGraphSnapshot {
  return {
    members: graph.members.map((m) => ({ issueNumber: m.issueNumber, role: m.role })),
    edges: graph.edges.map((e) => ({
      blockerIssueNumber: e.blockerIssueNumber,
      blockedIssueNumber: e.blockedIssueNumber,
    })),
  };
}

function failedResult(
  chain: ChainRecord,
  expectedEdges: ChainGraphEdge[],
  observedEdges: ChainGraphEdge[],
  failure: ChainSyncFailure,
): ChainSyncResult {
  return {
    chainId: chain.chainId,
    sessionId: chain.sessionId,
    status: "failed",
    expectedEdges,
    observedEdges,
    revision: {
      graphRevision: chain.graphRevision,
      acceptedRevision: chain.acceptedRevision ?? null,
      fingerprint: chain.graphFingerprint,
    },
    failure,
  };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Record what this run learned about a chain, guarded by the row revision it
 * learned it from.
 *
 * The guard is the point. Sync metadata is a statement about a particular
 * graph, and two overlapping runs reach their verdicts at different speeds: a
 * slow one that observed an older graph would otherwise stamp `in_sync` over
 * the structural `error` a faster run has already recorded about the graph that
 * replaced it, and `chain list --sync-status` would then hide exactly the chain
 * an operator is looking for. So the write carries the revision the verdict was
 * reached about, and a run whose chain has moved on loses it.
 *
 * Losing it is bookkeeping, not an outcome: the import (or the refusal to
 * import) already happened and stands. It is reported as a follow-up failure
 * and repaired by the next run, which observes the current graph and records a
 * verdict that is actually about it.
 */
async function recordSyncState(
  store: SqliteChainRegistryStore,
  chainId: string,
  patch: ChainSyncStatePatch,
  result: ChainSyncResult,
): Promise<void> {
  const marked = await store.setChainSyncState(chainId, patch);
  if (marked.ok || result.followUpFailure !== undefined) return;
  result.followUpFailure = {
    code: marked.code,
    ...(marked.detail === undefined ? {} : { detail: marked.detail }),
  };
}

function refusalFailure(refusal: ChainSyncRefusal): ChainSyncFailure {
  return {
    kind: refusal.kind,
    transient: refusal.transient,
    message: refusal.message,
    remediation: refusal.remediation,
    ...(refusal.diagnostics.length > 0 ? { diagnostics: refusal.diagnostics } : {}),
    ...(refusal.violations.length > 0 ? { violations: refusal.violations } : {}),
    ...(refusal.providerErrors.length > 0 ? { providerErrors: refusal.providerErrors } : {}),
  };
}

/**
 * Synchronize one chain. Never throws for a per-chain problem: every failure
 * mode becomes a `failed` result so `--all` can carry on with the next chain.
 */
async function syncOneChain(
  store: SqliteChainRegistryStore,
  providerFor: (sessionId: string) => Promise<ProviderEntry>,
  chainId: string,
  apply: boolean,
  now: string,
): Promise<ChainSyncResult | undefined> {
  const graph = await store.getChain(chainId);
  // Deleted between the listing and this read. Nothing to report about a chain
  // that no longer exists; `--all` simply has one fewer.
  if (!graph) return undefined;

  const registrySnapshot = snapshotOf(graph);
  const expectedEdges: ChainGraphEdge[] = [...registrySnapshot.edges];
  const chain = graph.chain;

  const entry = await providerFor(chain.sessionId);
  if ("error" in entry) {
    return failedResult(chain, expectedEdges, [], {
      kind: "session_error",
      transient: false,
      message: entry.error,
      remediation:
        "The chain's owning session could not supply a work-item provider, so GitHub was never read. Fix the session " +
        "entry in sessions.json (or its provider credentials) and re-run `admin chain sync`. Nothing was changed.",
    });
  }

  const members: ChainMemberInput[] = graph.members.map((m) => ({ issueNumber: m.issueNumber, role: m.role }));
  // Read alongside the graph it belongs to, before the network call: this copy
  // is what the *plan* judges, and a plan is a statement about the registry as
  // it stood when the observation was taken. The copy that decides whether an
  // import may land is the commit guard's, read inside the pointer move — so
  // pulling this one earlier costs nothing but makes the two roles distinct.
  const frozenSnapshots = await store.listFrozenPrefixes({ chainId });

  const { edges: observedEdges, errors: providerErrors } = await fetchObservedEdges(entry.provider, members);
  const observedSnapshot: ChainGraphSnapshot = { members, edges: observedEdges };

  const ownership = await collectChainOwnership(
    store,
    members.map((m) => m.issueNumber),
    { filter: { sessionId: chain.sessionId }, excludeChainId: chainId },
  );

  const plan: ChainSyncPlan = planChainSync({
    chainId,
    headIssueNumber: chain.headIssueNumber,
    registry: registrySnapshot,
    observed: observedSnapshot,
    providerErrors,
    frozenSnapshots,
    ownership,
  });

  if (plan.action === "refuse") {
    const result = failedResult(chain, expectedEdges, observedEdges, refusalFailure(plan));
    // A refusal that judged the graph is a durable fact about it, so it is
    // recorded where `chain list --sync-status error` can find it. A refusal
    // that never got to judge the graph (a provider outage) records nothing:
    // it says as much about this chain as it does about every other chain the
    // same outage touched.
    if (apply && plan.kind !== "provider_error") {
      // Nothing was written for this chain, so the row is still the one the
      // observation — and therefore this verdict — was taken from.
      await recordSyncState(
        store,
        chainId,
        { status: "error", error: plan.message, checkedAt: now, expectedRev: chain.rev, now },
        result,
      );
    }
    return result;
  }

  const driftDiagnostics = plan.drift.equivalent ? [] : plan.drift.diagnostics;
  const alreadyCurrent = plan.drift.equivalent && chain.acceptedRevision === chain.graphRevision;

  if (!apply) {
    return {
      chainId,
      sessionId: chain.sessionId,
      status: alreadyCurrent ? "would_remain_in_sync" : "would_import",
      expectedEdges,
      observedEdges,
      revision: {
        graphRevision: chain.graphRevision,
        acceptedRevision: chain.acceptedRevision ?? null,
        fingerprint: chain.graphFingerprint,
      },
      ...(alreadyCurrent ? {} : { importedFingerprint: plan.canonical.fingerprint }),
      ...(driftDiagnostics.length > 0 ? { driftDiagnostics } : {}),
    };
  }

  // The graph, its revision, its fingerprint, and the accepted pointer move as
  // one step here — and only here. `expectedRev` pins the whole decision to the
  // row this observation was taken from: a chain that moved while GitHub was
  // being read is refused rather than overwritten with a verdict reached about
  // a state that no longer exists.
  //
  // Frozen prefixes need more than that, because freezing one writes no chain
  // row: a task that starts after the plan's snapshot read leaves `chain.rev`
  // untouched, so neither the compare-and-set above nor the plan itself can
  // see it, and the import would drop a dependency that task is now running
  // against. Re-checking as the acceptance's commit guard puts that read inside
  // the transaction that moves the pointer, where a freeze cannot interleave
  // with it: the snapshots the guard is handed are the ones the pointer move
  // commits against. The violations are kept here rather than squeezed into the
  // veto string: the operator needs the same edge-level detail a planned
  // refusal gives.
  const late: { refusal?: ChainSyncRefusal } = {};
  const acceptance = await acceptChainGraph(store, {
    chainId,
    members,
    edges: observedEdges,
    expectedRev: chain.rev,
    ownershipScope: { sessionId: chain.sessionId },
    commitGuard: ({ frozenPrefixes }) => {
      const frozen = checkFrozenPrefixes({
        candidate: observedSnapshot,
        snapshots: frozenPrefixes,
        chainId,
      });
      if (frozen.ok) return undefined;
      late.refusal = frozenPrefixRefusal(frozen);
      return late.refusal.message;
    },
    source: SYNC_SOURCE,
    now,
  });

  const followUpFailure =
    acceptance.followUpFailure === undefined
      ? undefined
      : {
          code: acceptance.followUpFailure.code,
          ...(acceptance.followUpFailure.detail === undefined
            ? {}
            : { detail: acceptance.followUpFailure.detail }),
        };

  if (acceptance.status === "rejected") {
    // Ownership moved under the pre-check: the store refused the claim inside
    // its own transaction and the accepted graph never moved.
    const message = `the observed graph was refused on acceptance (${acceptance.diagnostics.length} finding(s))`;
    const result = failedResult(chain, expectedEdges, observedEdges, {
      kind: "structural",
      transient: false,
      message,
      remediation:
        "Another chain claimed one of these Issues while GitHub was being read. Release that claim, then re-run " +
        "`admin chain sync`. The accepted graph was left untouched.",
      diagnostics: acceptance.diagnostics,
    });
    if (followUpFailure) result.followUpFailure = followUpFailure;
    // A rejected acceptance is decided before its first write, so the row this
    // verdict is about is still the one the observation named.
    await recordSyncState(
      store,
      chainId,
      { status: "error", error: message, checkedAt: now, expectedRev: chain.rev, now },
      result,
    );
    return result;
  }

  if (acceptance.status === "vetoed") {
    // A prefix was frozen after the plan read the snapshots. The candidate
    // is on record, the accepted graph is not — the freeze outranks it, exactly
    // as it would have had the plan seen it — so this reports the same
    // frozen-prefix refusal a planned one does, down to the wording.
    const failure: ChainSyncFailure =
      late.refusal !== undefined
        ? refusalFailure(late.refusal)
        : {
            // Only reachable if a future veto condition is added without a
            // refusal to go with it; reported rather than assumed away.
            kind: "frozen_prefix",
            transient: false,
            message: acceptance.detail,
            remediation:
              "The import was refused at the point it would have been committed. Re-run `admin chain sync` to see " +
              "the current state; the accepted graph was left untouched.",
          };
    const result = failedResult(chain, expectedEdges, observedEdges, failure);
    if (followUpFailure) result.followUpFailure = followUpFailure;
    // This run wrote a candidate revision on its way here, so the row it
    // observed going in is gone; `observedRev` is the one its own writes left,
    // and guarding on it is what keeps this error off a chain some other run
    // has since had the last word on.
    await recordSyncState(
      store,
      chainId,
      {
        status: "error",
        error: failure.message,
        checkedAt: now,
        expectedRev: acceptance.observedRev,
        now,
      },
      result,
    );
    return result;
  }

  if (acceptance.status === "conflict") {
    // A compare-and-set the caller lost: the chain moved between the read this
    // observation was taken from and the write. Retryable, and the accepted
    // graph is whatever the winner left — never a half-applied import.
    const result = failedResult(chain, expectedEdges, observedEdges, {
      kind: "conflict",
      transient: true,
      message: acceptance.detail,
      remediation:
        "The chain was modified while GitHub was being read, so this import was refused rather than applied on top " +
        "of a state it never saw. Re-run `admin chain sync`; the accepted graph is unchanged.",
    });
    if (followUpFailure) result.followUpFailure = followUpFailure;
    return result;
  }

  if (acceptance.status === "failed") {
    const result = failedResult(chain, expectedEdges, observedEdges, {
      kind: "store_error",
      transient: false,
      message: `${acceptance.code}${acceptance.detail === undefined ? "" : `: ${acceptance.detail}`}`,
      remediation:
        "The registry refused the write, so nothing moved. Inspect the chain with `admin chain show` and re-run " +
        "`admin chain sync` once the registry accepts writes again.",
    });
    if (followUpFailure) result.followUpFailure = followUpFailure;
    return result;
  }

  // Accepted or already-accepted-and-unchanged: either way the registry now
  // reflects what GitHub says, so the sync metadata records it. `in_sync` also
  // clears any `syncError` a previous run left behind.
  const result: ChainSyncResult = {
    chainId,
    sessionId: chain.sessionId,
    status: acceptance.status === "unchanged" ? "in_sync" : "imported",
    expectedEdges,
    observedEdges,
    revision: {
      graphRevision: chain.graphRevision,
      acceptedRevision: chain.acceptedRevision ?? null,
      fingerprint: chain.graphFingerprint,
    },
    importedRevision: acceptance.acceptedRevision,
    importedFingerprint: acceptance.fingerprint,
    ...(driftDiagnostics.length > 0 ? { driftDiagnostics } : {}),
  };
  if (followUpFailure) result.followUpFailure = followUpFailure;

  // Guarded by the row the acceptance itself left behind, not the one this run
  // started from: `in_sync` is a claim about the graph that was just accepted,
  // and a chain that has moved on since has a newer graph nobody has checked.
  //
  // `committedRev` rather than the accepted graph's `rev`, because the two stop
  // agreeing exactly where it matters: another sync recording a structural
  // `error` bumps the row without touching the graph revision, so a rev taken
  // from a graph read after the commit would carry that run's write and let
  // this one overwrite its error with `in_sync`. Pinned to the acceptance's own
  // last write, the same case is a lost compare-and-set — the newer verdict
  // stands, and this run reports the refusal as a follow-up failure.
  await recordSyncState(
    store,
    chainId,
    {
      status: "in_sync",
      checkedAt: now,
      syncedAt: now,
      expectedRev: acceptance.committedRev,
      now,
    },
    result,
  );
  return result;
}

export async function runChainSync(argv: string[]): Promise<void> {
  const parsed = parseChainSyncArgs(argv);
  if ("error" in parsed) die(parsed.error);
  const { chainRef, all, sessionId, apply, sessionsPath, dbPath } = parsed;

  // Loaded before the store is opened: `die()` calls `process.exit`, which
  // skips the `finally` that closes the connection, so everything that can
  // legitimately abort the whole command happens first.
  let registry: JsonSessionRegistry;
  try {
    registry = new JsonSessionRegistry(sessionsPath);
  } catch (err) {
    die(`Failed to load sessions file (${sessionsPath}): ${messageOf(err)}`);
  }

  const providers = new Map<string, ProviderEntry>();
  const providerFor = async (chainSessionId: string): Promise<ProviderEntry> => {
    const cached = providers.get(chainSessionId);
    if (cached !== undefined) return cached;
    let entry: ProviderEntry;
    const session = await registry.getSessionById(chainSessionId);
    if (!session) {
      entry = { error: describeUnresolvedSessionId(registry, chainSessionId, sessionsPath) };
    } else {
      try {
        entry = { provider: await resolveIssueWorkItemProvider(session) };
      } catch (err) {
        entry = { error: messageOf(err) };
      }
    }
    providers.set(chainSessionId, entry);
    return entry;
  };

  const now = new Date().toISOString();
  const store = new SqliteChainRegistryStore(dbPath);
  try {
    let chainIds: string[];
    if (chainRef !== undefined) {
      // The same chain-reference resolver `chain show|validate` use: chain IDs
      // and aliases share one namespace (#788), so an alias syncs the chain it
      // names.
      const resolved = await store.resolveChainHandle(chainRef);
      if (resolved === undefined) {
        const notFound = { ok: false as const, reason: "not_found" as const, chainRef };
        report(notFound, () => `No chain found for reference: ${chainRef}`);
        process.exitCode = 1;
        return;
      }
      chainIds = [resolved];
    } else {
      const chains = await store.listChains(sessionId === undefined ? undefined : { sessionId });
      chainIds = chains.map((c) => c.chainId);
    }

    const results: ChainSyncResult[] = [];
    for (const id of chainIds) {
      try {
        const result = await syncOneChain(store, providerFor, id, apply, now);
        if (result !== undefined) results.push(result);
      } catch (err) {
        // Batch isolation: an unexpected throw for one chain (a store read that
        // failed, a provider that rejected in a way its wrapper did not catch)
        // must not deny every other chain its check.
        results.push({
          chainId: id,
          sessionId: "",
          status: "failed",
          expectedEdges: [],
          observedEdges: [],
          revision: { graphRevision: 0, acceptedRevision: null, fingerprint: "" },
          failure: {
            kind: "store_error",
            transient: false,
            message: messageOf(err),
            remediation:
              "The chain could not be read or written, so nothing was imported for it. Inspect it with `admin chain " +
              "show` and re-run `admin chain sync`. No accepted graph was changed.",
          },
        });
      }
    }

    const failed = results.filter((r) => r.status === "failed").length;
    const imported = results.filter((r) => r.status === "imported" || r.status === "would_import").length;
    const inSync = results.filter(
      (r) => r.status === "in_sync" || r.status === "would_remain_in_sync",
    ).length;
    const payload: ChainSyncPayload = {
      ok: failed === 0,
      applied: apply,
      scope: {
        ...(chainRef === undefined ? {} : { chainRef }),
        all,
        ...(sessionId === undefined ? {} : { sessionId }),
      },
      count: results.length,
      imported,
      inSync,
      failed,
      chains: results,
    };
    report(payload as unknown as Record<string, unknown>, (mode) => renderChainSync(payload, mode));
    if (!payload.ok) process.exitCode = 1;
  } finally {
    store.close();
  }
}
