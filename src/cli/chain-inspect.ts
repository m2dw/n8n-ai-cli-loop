/**
 * `admin chain list|show|validate` (issue #789): read-only inspection of the
 * dependency-chain registry (#788), its graph rules (#890), and its
 * frozen-prefix rules (#891).
 *
 * Every command here only reads. `list` and `show` read the registry alone.
 * `validate` additionally fetches GitHub Issue Relationships for the chain's
 * members via the session's `WorkItemProvider` and compares them with what is
 * on record — but never writes anything back: not the accepted graph, not a
 * revision or fingerprint, not `syncStatus`/`syncError`/`syncedAt`, and no
 * GitHub label, comment, or relationship. Mutating GitHub-to-registry
 * synchronization is issue #892.
 *
 * `validate` builds an "observed" candidate graph from GitHub: the same
 * members the registry declares (GitHub has no notion of chain membership),
 * with edges read fresh from `WorkItemProvider.getDependencies` for each one.
 * That candidate is judged three ways — {@link validateChainGraph} for
 * structural problems (cycles, missing members, ambiguous identity),
 * {@link compareChainGraphs} against the registry's own stored graph for
 * drift, and {@link checkFrozenPrefixes} against every frozen snapshot for
 * this chain, evaluated against both the stored graph and the observed one so
 * a conflict is visible whichever side introduced it. A per-member fetch
 * failure (an inaccessible or deleted Issue, a transient provider error) is
 * collected separately from all of that: it is not a structural finding about
 * the graph, and folding it into the diagnostics list would make a transient
 * outage indistinguishable from a real conflict.
 *
 * When any member fetch fails, the observed graph is missing every edge into
 * that member — it is not "the same graph minus one Issue," it is incomplete.
 * Comparing it against the registry or the frozen snapshots would report the
 * missing edges as drift or a frozen-prefix conflict that was never observed.
 * So the drift comparison and the observed-side frozen-prefix check are
 * skipped and reported `indeterminate` whenever `providerErrors` is
 * non-empty; the registry-side frozen-prefix check still runs, since it never
 * touches the observed graph.
 */

import type { OutputMode } from "./cli-io.js";
import { die, report } from "./cli-io.js";
import { parseCommonOptions, resolveSessionSelector } from "./admin-command.js";
import { resolveIssueWorkItemProvider } from "./issue-activation.js";
import { describeUnresolvedSessionId, JsonSessionRegistry } from "../registries/json-session-registry.js";
import { SqliteChainRegistryStore } from "../stores/sqlite-chain-registry-store.js";
import { isChainSyncStatus } from "../core/chain-registry.js";
import type { ChainAlias, ChainEdge, ChainMember, ChainRecord, ChainSyncStatus } from "../core/chain-registry.js";
import {
  chainGraphTopologicalOrder,
  compareChainGraphs,
  validateChainGraph,
} from "../core/chain-graph.js";
import type {
  ChainGraphComparison,
  ChainGraphDiagnostic,
  ChainGraphEdge,
  ChainGraphSnapshot,
  ChainGraphValidation,
} from "../core/chain-graph.js";
import { checkFrozenPrefixes } from "../core/chain-frozen-prefix.js";
import type { FrozenPrefixGuardVerdict, FrozenPrefixSnapshot } from "../core/chain-frozen-prefix.js";
import { collectChainOwnership } from "../core/chain-acceptance.js";
import type { WorkItemProvider } from "../providers/types.js";

/* -------------------------------------------------------------------------
 * `admin chain list`
 * ---------------------------------------------------------------------- */

interface ChainListArgs {
  sessionId: string | undefined;
  syncStatus: ChainSyncStatus | undefined;
  sessionsPath: string;
  dbPath: string | undefined;
}

function parseChainListArgs(argv: string[]): ChainListArgs | { error: string } {
  const parsed = parseCommonOptions(argv, {
    session: "none",
    valueFlags: ["session-id", "session-ref", "sessions-path", "sync-status"],
  });
  if ("error" in parsed) return { error: parsed.error };
  const { args } = parsed;

  let sessionId: string | undefined;
  if (args["session-id"] !== undefined || args["session-ref"] !== undefined) {
    const selector = resolveSessionSelector(args);
    if ("error" in selector) return { error: selector.error };
    sessionId = selector.sessionId;
  }

  let syncStatus: ChainSyncStatus | undefined;
  if (args["sync-status"] !== undefined) {
    if (!isChainSyncStatus(args["sync-status"])) {
      return {
        error: `--sync-status must be one of: unknown, in_sync, stale, error, got: ${args["sync-status"]}`,
      };
    }
    syncStatus = args["sync-status"];
  }

  return { sessionId, syncStatus, sessionsPath: parsed.sessionsPath, dbPath: parsed.dbPath };
}

function renderChainList(
  payload: {
    ok: true;
    sessionId?: string;
    syncStatus?: ChainSyncStatus;
    count: number;
    chains: ChainRecord[];
  },
  _mode: OutputMode,
): string {
  const scope = [
    payload.sessionId !== undefined ? `session=${payload.sessionId}` : undefined,
    payload.syncStatus !== undefined ? `sync=${payload.syncStatus}` : undefined,
  ].filter((s): s is string => s !== undefined);
  const header = `Chains${scope.length > 0 ? ` (${scope.join(", ")})` : ""}: ${payload.count} found.`;
  if (payload.chains.length === 0) return header;
  const lines = [header];
  for (const c of payload.chains) {
    const accepted = c.acceptedRevision !== undefined ? `accepted=${c.acceptedRevision}` : "accepted=none";
    lines.push(
      `  ${c.chainId}  head=#${c.headIssueNumber}  session=${c.sessionId}  rev=${c.graphRevision} ${accepted}  sync=${c.syncStatus}` +
        (c.title ? `  "${c.title}"` : ""),
    );
    if (c.syncStatus === "error" && c.syncError) lines.push(`      syncError: ${c.syncError}`);
  }
  return lines.join("\n");
}

export async function runChainList(argv: string[]): Promise<void> {
  const parsed = parseChainListArgs(argv);
  if ("error" in parsed) die(parsed.error);
  const { sessionId, syncStatus, dbPath } = parsed;

  const store = new SqliteChainRegistryStore(dbPath);
  try {
    const chains = await store.listChains({
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(syncStatus !== undefined ? { syncStatus } : {}),
    });
    const payload = {
      ok: true as const,
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(syncStatus !== undefined ? { syncStatus } : {}),
      count: chains.length,
      chains,
    };
    report(payload, (mode) => renderChainList(payload, mode));
  } finally {
    store.close();
  }
}

/* -------------------------------------------------------------------------
 * Shared: `<chain-ref>` positional parsing
 * ---------------------------------------------------------------------- */

interface ChainRefArgs {
  chainRef: string;
  sessionsPath: string;
  dbPath: string | undefined;
}

function parseChainRefArgs(argv: string[]): ChainRefArgs | { error: string } {
  const parsed = parseCommonOptions(argv, {
    session: "none",
    valueFlags: ["sessions-path"],
    allowPositionals: true,
  });
  if ("error" in parsed) return { error: parsed.error };
  if (parsed.positionals.length === 0) {
    return { error: "chain-ref is required, e.g. admin chain show chain_777" };
  }
  if (parsed.positionals.length > 1) {
    return { error: `Unexpected argument: ${parsed.positionals[1]}` };
  }
  return { chainRef: parsed.positionals[0], sessionsPath: parsed.sessionsPath, dbPath: parsed.dbPath };
}

/* -------------------------------------------------------------------------
 * `admin chain show`
 * ---------------------------------------------------------------------- */

interface ChainShowPayload {
  ok: true;
  chainRef: string;
  chainId: string;
  chain: ChainRecord;
  members: ChainMember[];
  edges: ChainEdge[];
  aliases: ChainAlias[];
  frozenPrefixes: FrozenPrefixSnapshot[];
  topologicalOrder: number[] | null;
}

function renderChainShow(payload: ChainShowPayload, _mode: OutputMode): string {
  const { chain, members, edges, aliases, frozenPrefixes, topologicalOrder } = payload;
  const lines = [
    `Chain ${chain.chainId} (session ${chain.sessionId}):`,
    `  head: #${chain.headIssueNumber}  origin: #${chain.originIssueNumber}` +
      (chain.title ? `  title: "${chain.title}"` : ""),
    `  revision: ${chain.graphRevision}  fingerprint: ${chain.graphFingerprint}`,
    `  accepted revision: ${chain.acceptedRevision ?? "(none)"}`,
    `  sync: ${chain.syncStatus}` +
      (chain.syncError ? `  error: ${chain.syncError}` : "") +
      (chain.syncCheckedAt ? `  checkedAt: ${chain.syncCheckedAt}` : "") +
      (chain.syncedAt ? `  syncedAt: ${chain.syncedAt}` : ""),
    `  members (${members.length}):`,
    ...members.map((m) => `    #${m.issueNumber} (${m.role})`),
    `  edges (${edges.length}):`,
    ...edges.map((e) => `    ${e.blockerIssueNumber} -> ${e.blockedIssueNumber}`),
    `  topological order: ${topologicalOrder ? topologicalOrder.join(", ") : "(none — graph is cyclic)"}`,
  ];
  if (aliases.length > 0) {
    lines.push("  aliases:");
    for (const a of aliases) lines.push(`    ${a.alias}` + (a.reason ? ` (${a.reason})` : ""));
  }
  if (frozenPrefixes.length > 0) {
    lines.push(`  frozen prefixes (${frozenPrefixes.length}):`);
    for (const f of frozenPrefixes) {
      lines.push(
        `    issue #${f.issueNumber}: ancestors=[${f.ancestors.join(", ")}] base=${f.base.kind} ${f.base.baseRef}` +
          (f.base.baseIssueNumber !== undefined ? ` (issue ${f.base.baseIssueNumber})` : "") +
          `  frozenAt=${f.frozenAt}`,
      );
    }
  }
  return lines.join("\n");
}

export async function runChainShow(argv: string[]): Promise<void> {
  const parsed = parseChainRefArgs(argv);
  if ("error" in parsed) die(parsed.error);
  const { chainRef, dbPath } = parsed;

  const store = new SqliteChainRegistryStore(dbPath);
  try {
    const chainId = await store.resolveChainHandle(chainRef);
    if (chainId === undefined) {
      const payload = { ok: false as const, reason: "not_found" as const, chainRef };
      report(payload, () => `No chain found for reference: ${chainRef}`);
      process.exitCode = 1;
      return;
    }
    const graph = await store.getChain(chainId);
    if (!graph) {
      // Resolved a moment ago; deleted between the two reads. Same shape as an
      // unresolved reference rather than a crash.
      const payload = { ok: false as const, reason: "not_found" as const, chainRef, chainId };
      report(payload, () => `No chain found for reference: ${chainRef}`);
      process.exitCode = 1;
      return;
    }

    const aliases = await store.listChainAliases(chainId);
    const frozenPrefixes = await store.listFrozenPrefixes({ chainId });
    const order = chainGraphTopologicalOrder(
      graph.members.map((m) => m.issueNumber),
      graph.edges.map((e) => ({
        blockerIssueNumber: e.blockerIssueNumber,
        blockedIssueNumber: e.blockedIssueNumber,
      })),
    );

    const payload: ChainShowPayload = {
      ok: true,
      chainRef,
      chainId,
      chain: graph.chain,
      members: graph.members,
      edges: graph.edges,
      aliases,
      frozenPrefixes,
      topologicalOrder: order ?? null,
    };
    report(payload as unknown as Record<string, unknown>, (mode) => renderChainShow(payload, mode));
  } finally {
    store.close();
  }
}

/* -------------------------------------------------------------------------
 * `admin chain validate`
 * ---------------------------------------------------------------------- */

export interface ProviderFetchError {
  issueNumber: number;
  error: string;
}

/**
 * Read every member's `blocked by` relationships and turn them into edges.
 *
 * Exported because `admin chain sync` (#892) has to build the *same* observed
 * graph this command validates — if the two derived it differently, a sync
 * could import a graph validation never judged. A per-member failure is
 * collected rather than thrown: one inaccessible Issue must not abort the rest
 * of the read, and both callers need to see which members went unread before
 * they can decide what the missing edges mean.
 *
 * `includeDependents` additionally reads the other end of the relationship —
 * the Issues each member BLOCKS — and folds those in as edges too. It is off by
 * default because `validate` and `sync` judge a graph whose vertex set is the
 * chain's membership, and an edge to a non-member would read as a structural
 * finding about a graph nobody declared. The linear edit commands (#791) turn it
 * on, because for them an edge OUT of the set is exactly the thing that must not
 * be missed: an Issue that blocks something unregistered looks, from its own
 * blockers alone, like a downstream end, and appending past it would draw a live
 * fork the registry does not represent (issue #791 review). An edge both reads
 * report is emitted once.
 */
export async function fetchObservedEdges(
  provider: WorkItemProvider,
  members: readonly { issueNumber: number }[],
  options: { includeDependents?: boolean } = {},
): Promise<{ edges: ChainGraphEdge[]; errors: ProviderFetchError[] }> {
  const edges: ChainGraphEdge[] = [];
  const errors: ProviderFetchError[] = [];
  const seen = new Set<string>();
  const push = (blockerIssueNumber: number, blockedIssueNumber: number): void => {
    const key = `${blockerIssueNumber}->${blockedIssueNumber}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ blockerIssueNumber, blockedIssueNumber });
  };
  for (const member of members) {
    try {
      const blockedBy = await provider.getDependencies(member.issueNumber);
      for (const dep of blockedBy) {
        push(dep.issueNumber, member.issueNumber);
      }
      if (options.includeDependents === true) {
        const blocking = await provider.getDependents(member.issueNumber);
        for (const dep of blocking) {
          push(member.issueNumber, dep.issueNumber);
        }
      }
    } catch (err) {
      // One error entry per member however many of its reads failed: the
      // callers treat any error as "this member's relationships are unknown",
      // and a doubled entry would only double the refusal's wording.
      errors.push({ issueNumber: member.issueNumber, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { edges, errors };
}

type Indeterminate = { indeterminate: true; reason: "incomplete_observed_graph" };

function renderFrozenPrefixVerdict(
  label: string,
  verdict: (FrozenPrefixGuardVerdict & { indeterminate?: false }) | Indeterminate,
): string[] {
  if (verdict.indeterminate) {
    return [
      `  frozen-prefix (${label}): indeterminate (${verdict.reason} — a member fetch failed; see provider errors)`,
    ];
  }
  if (verdict.ok) {
    return [`  frozen-prefix (${label}): ok (${verdict.evaluated} snapshot(s) evaluated)`];
  }
  const lines = [`  frozen-prefix conflicts (${label}, ${verdict.violations.length}):`];
  for (const v of verdict.violations) lines.push(`    [${v.code}] ${v.message}`);
  return lines;
}

interface ChainValidatePayload {
  ok: boolean;
  chainRef: string;
  chainId: string;
  sessionId: string;
  revision: {
    graphRevision: number;
    graphFingerprint: string;
    acceptedRevision: number | null;
    status: "current" | "stale" | "unaccepted";
  };
  structural:
    | { ok: true; diagnostics: []; fingerprint: string; topologicalOrder: number[] }
    | { ok: false; diagnostics: ChainGraphDiagnostic[] };
  drift:
    | (ChainGraphComparison & { indeterminate: false })
    | Indeterminate;
  frozenPrefix: {
    registry: FrozenPrefixGuardVerdict;
    observed: (FrozenPrefixGuardVerdict & { indeterminate: false }) | Indeterminate;
  };
  providerErrors: ProviderFetchError[];
  observed: { members: { issueNumber: number; role: string }[]; edges: ChainGraphEdge[] };
}

function renderChainValidate(payload: ChainValidatePayload, _mode: OutputMode): string {
  const lines = [
    `Validate chain ${payload.chainId} (session ${payload.sessionId}): ${payload.ok ? "OK" : "PROBLEMS FOUND"}`,
    `  revision: ${payload.revision.graphRevision} (accepted: ${payload.revision.acceptedRevision ?? "none"}, status: ${payload.revision.status})`,
  ];
  if (payload.structural.ok) {
    lines.push(`  structural: ok (observed fingerprint ${payload.structural.fingerprint})`);
  } else {
    lines.push(`  structural diagnostics (${payload.structural.diagnostics.length}):`);
    for (const d of payload.structural.diagnostics) lines.push(`    [${d.code}] ${d.message}`);
  }
  if (payload.drift.indeterminate) {
    lines.push(
      `  drift vs GitHub: indeterminate (${payload.drift.reason} — a member fetch failed; see provider errors)`,
    );
  } else if (payload.drift.equivalent) {
    lines.push(`  drift vs GitHub: none (fingerprint ${payload.drift.observedFingerprint})`);
  } else {
    lines.push(`  drift vs GitHub (${payload.drift.diagnostics.length}):`);
    for (const d of payload.drift.diagnostics) lines.push(`    [${d.code}] ${d.message}`);
  }
  lines.push(...renderFrozenPrefixVerdict("registry", payload.frozenPrefix.registry));
  lines.push(...renderFrozenPrefixVerdict("observed", payload.frozenPrefix.observed));
  if (payload.providerErrors.length > 0) {
    lines.push(
      `  provider errors (${payload.providerErrors.length}, transient — distinct from structural conflicts):`,
    );
    for (const e of payload.providerErrors) lines.push(`    #${e.issueNumber}: ${e.error}`);
  }
  return lines.join("\n");
}

export async function runChainValidate(argv: string[]): Promise<void> {
  const parsed = parseChainRefArgs(argv);
  if ("error" in parsed) die(parsed.error);
  const { chainRef, sessionsPath, dbPath } = parsed;

  // Phase 1: every registry read this command needs, all before anything that
  // can `die()` — a session lookup or provider resolution failure must not
  // leave the store connection straddling a `process.exit()` that skips the
  // `finally` below it.
  const store = new SqliteChainRegistryStore(dbPath);
  const chainId = await store.resolveChainHandle(chainRef);
  if (chainId === undefined) {
    store.close();
    const payload = { ok: false as const, reason: "not_found" as const, chainRef };
    report(payload, () => `No chain found for reference: ${chainRef}`);
    process.exitCode = 1;
    return;
  }
  const graph = await store.getChain(chainId);
  if (!graph) {
    store.close();
    const payload = { ok: false as const, reason: "not_found" as const, chainRef, chainId };
    report(payload, () => `No chain found for reference: ${chainRef}`);
    process.exitCode = 1;
    return;
  }
  const frozenSnapshots = await store.listFrozenPrefixes({ chainId });
  const ownership = await collectChainOwnership(
    store,
    graph.members.map((m) => m.issueNumber),
    { excludeChainId: chainId },
  );
  store.close();

  // Phase 2: resolve the owning session and its provider. Read-only, but can
  // legitimately `die()` on a setup problem (unknown session, unsupported or
  // misconfigured work-item provider) — the same posture `admin issue
  // activate|suspend` uses.
  let registry: JsonSessionRegistry;
  try {
    registry = new JsonSessionRegistry(sessionsPath);
  } catch (err) {
    die(`Failed to load sessions file (${sessionsPath}): ${err instanceof Error ? err.message : String(err)}`);
  }
  const session = await registry.getSessionById(graph.chain.sessionId);
  if (!session) die(describeUnresolvedSessionId(registry, graph.chain.sessionId, sessionsPath));

  let provider: WorkItemProvider;
  try {
    provider = await resolveIssueWorkItemProvider(session);
  } catch (err) {
    die(err instanceof Error ? err.message : String(err));
  }

  // Phase 3: fetch GitHub Issue Relationships for each member and judge the
  // result. A per-member fetch failure is collected, not thrown — one
  // inaccessible Issue must not abort the rest of the chain's validation.
  const observedMembers = graph.members.map((m) => ({ issueNumber: m.issueNumber, role: m.role }));
  const { edges: observedEdges, errors: providerErrors } = await fetchObservedEdges(provider, observedMembers);

  const structural: ChainGraphValidation = validateChainGraph(
    { chainId, headIssueNumber: graph.chain.headIssueNumber, members: observedMembers, edges: observedEdges },
    { ownership },
  );

  const registrySnapshot: ChainGraphSnapshot = {
    members: graph.members.map((m) => ({ issueNumber: m.issueNumber, role: m.role })),
    edges: graph.edges.map((e) => ({
      blockerIssueNumber: e.blockerIssueNumber,
      blockedIssueNumber: e.blockedIssueNumber,
    })),
  };
  const observedSnapshot: ChainGraphSnapshot = { members: observedMembers, edges: observedEdges };

  // A failed member fetch drops every edge into that member from
  // `observedEdges`, so the observed graph is incomplete rather than merely
  // "smaller." Comparing it against the registry, or checking its frozen
  // prefixes, would report the missing edges as drift or a frozen-prefix
  // conflict nobody actually observed. Both checks are skipped and marked
  // `indeterminate` until every member read succeeds.
  const hasProviderErrors = providerErrors.length > 0;
  const drift: ChainValidatePayload["drift"] = hasProviderErrors
    ? { indeterminate: true, reason: "incomplete_observed_graph" }
    : { indeterminate: false, ...compareChainGraphs(registrySnapshot, observedSnapshot) };

  const acceptedRevision = graph.chain.acceptedRevision;
  const revisionStatus: "current" | "stale" | "unaccepted" =
    acceptedRevision === undefined
      ? "unaccepted"
      : acceptedRevision === graph.chain.graphRevision
        ? "current"
        : "stale";

  const frozenRegistry = checkFrozenPrefixes({ candidate: registrySnapshot, snapshots: frozenSnapshots, chainId });
  const frozenObserved: ChainValidatePayload["frozenPrefix"]["observed"] = hasProviderErrors
    ? { indeterminate: true, reason: "incomplete_observed_graph" }
    : { indeterminate: false, ...checkFrozenPrefixes({ candidate: observedSnapshot, snapshots: frozenSnapshots, chainId }) };

  const ok =
    structural.ok &&
    !hasProviderErrors &&
    !drift.indeterminate &&
    drift.equivalent &&
    revisionStatus === "current" &&
    frozenRegistry.ok &&
    !frozenObserved.indeterminate &&
    frozenObserved.ok;

  const payload: ChainValidatePayload = {
    ok,
    chainRef,
    chainId,
    sessionId: graph.chain.sessionId,
    revision: {
      graphRevision: graph.chain.graphRevision,
      graphFingerprint: graph.chain.graphFingerprint,
      acceptedRevision: acceptedRevision ?? null,
      status: revisionStatus,
    },
    structural: structural.ok
      ? {
          ok: true,
          diagnostics: [],
          fingerprint: structural.graph.fingerprint,
          topologicalOrder: structural.graph.topologicalOrder,
        }
      : { ok: false, diagnostics: structural.diagnostics },
    drift,
    frozenPrefix: { registry: frozenRegistry, observed: frozenObserved },
    providerErrors,
    observed: { members: observedMembers, edges: observedEdges },
  };

  report(payload as unknown as Record<string, unknown>, (mode) => renderChainValidate(payload, mode));
  if (!ok) process.exitCode = 1;
}
