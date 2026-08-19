/**
 * Advanced dependency-chain topology operations: fork and merge (issue #893).
 *
 * The linear commands of #791 draw straight lines and refuse everything else
 * with a pointer at this module. This module owns the decision half of the two
 * commands that answer those refusals:
 *
 *   admin chain fork  <chain-ref> <issue> [length] [--name <alias>]
 *   admin chain merge <target-chain> <source-chain> --position append|prepend
 *
 * Like `chain-linear.ts`, this module decides only: it reads nothing, writes
 * nothing, and never touches GitHub or a database. The caller gathers one
 * observation and gets one verdict back, and the verdict names the graphs to
 * persist and every GitHub Issue Relationship that must be created — and, new
 * to these operations, *removed* — before it may be. The refusal shape and its
 * three kinds are shared with sync, intake, and the linear commands: the same
 * graph refused through a different door is the same finding.
 *
 * What "fork" and "merge" mean here, in the vocabulary the rest of the chain
 * modules already use (an edge is `blocker -> blocked`; a chain's head is its
 * downstream end):
 *
 *   - `fork` extracts a contiguous run of members — `length` Issues starting at
 *     `<issue>`, following the chain's own edges downstream — into a chain of
 *     its own, bridging the gap it leaves so every ordering constraint among
 *     the remaining members survives. Contiguity is a real requirement, not a
 *     convenience: an interior member with an edge the segment does not contain
 *     (a fan-in from outside, a fan-out into the rest of the chain) cannot be
 *     extracted without deciding topology the operator never spelled out, so it
 *     is refused by name. The segment's first member may have any number of
 *     predecessors and its last any number of successors — those become the
 *     boundary, every predecessor is bridged to every successor, and a fan-in
 *     or fan-out at the boundary survives the extraction intact.
 *   - `merge` attaches every member of a source chain to a target chain with
 *     one new boundary relationship — past the target's head (`append`) or
 *     ahead of its root (`prepend`) — and retires the source: the target keeps
 *     its chain ID, and the source's ID and aliases become aliases of the
 *     target so every handle an operator has written down stays resolvable.
 *
 * Frozen prefixes (#891) fall out rather than being special-cased, exactly as
 * they do for the linear commands. A fork may only extract a segment no frozen
 * prefix names — extracting a started Issue destroys the contract pinned for
 * it, and extracting one of its ancestors rewrites that contract — and both
 * readings are enforced: the segment is checked against the snapshots by name,
 * and the remaining graph is judged by `checkFrozenPrefixes`, which reports the
 * ancestry change on whichever started Issue would feel it. A merge in the
 * `append` position gives every source member new ancestors, so a frozen
 * source refuses it; `prepend` gives the *target's* members new ancestors, so
 * a frozen target refuses that — and a frozen source survives a `prepend`
 * untouched, because nothing upstream of it changes.
 */

import { validateChainGraph } from "./chain-graph.js";
import type {
  CanonicalChainGraph,
  ChainGraphDiagnostic,
  ChainGraphEdge,
  ChainGraphSnapshot,
  ChainOwnershipEntry,
} from "./chain-graph.js";
import { checkFrozenPrefixes } from "./chain-frozen-prefix.js";
import type { FrozenPrefixSnapshot } from "./chain-frozen-prefix.js";
import type { ChainEdgeInput, ChainMemberInput } from "./chain-registry.js";
import type { ChainLinearTarget } from "./chain-linear.js";
import { diagnosticRemediationHints, frozenPrefixRefusal } from "./chain-sync.js";
import type { ChainSyncProviderError, ChainSyncRefusal, ChainSyncRefusalKind } from "./chain-sync.js";

/* -------------------------------------------------------------------------
 * Inputs
 * ---------------------------------------------------------------------- */

export const CHAIN_ADVANCED_OPERATIONS = ["fork", "merge"] as const;

export type ChainAdvancedOperation = (typeof CHAIN_ADVANCED_OPERATIONS)[number];

export const CHAIN_MERGE_POSITIONS = ["append", "prepend"] as const;

export type ChainMergePosition = (typeof CHAIN_MERGE_POSITIONS)[number];

export function isChainMergePosition(value: unknown): value is ChainMergePosition {
  return typeof value === "string" && (CHAIN_MERGE_POSITIONS as readonly string[]).includes(value);
}

/**
 * The observation both planners judge: what GitHub holds for the Issues
 * involved, read in BOTH directions, with the same contract as
 * `ChainLinearPlanInput.observedEdges` — an edge out of the set is as much a
 * finding as an edge into it, and `fetchObservedEdges(..., { includeDependents:
 * true })` is what satisfies it.
 */
export interface ChainAdvancedObservation {
  observedEdges: readonly ChainGraphEdge[];
  observedIssues: readonly number[];
  /** Every frozen prefix that could apply — see each planner for the scope. */
  frozenSnapshots: readonly FrozenPrefixSnapshot[];
  /** Which OTHER chains own any involved Issue (#890), excluding the operands. */
  ownership: readonly ChainOwnershipEntry[];
  providerErrors: readonly ChainSyncProviderError[];
  /**
   * Skip the frozen-prefix checks. The caller runs them itself, after
   * suspending automation, so the snapshots it judges are the ones a quiesced
   * repository produced — the same division of labour as
   * `planLinearChainEdit`.
   */
  skipFrozenPrefixes?: boolean;
}

export interface ChainForkPlanInput extends ChainAdvancedObservation {
  /** The chain being forked, as the registry records it. */
  target: ChainLinearTarget;
  /** First member of the segment to extract. */
  startIssueNumber: number;
  /**
   * How many consecutive members the segment holds. Omitted, the segment runs
   * from `startIssueNumber` to the chain's downstream end.
   */
  length?: number;
  /**
   * Register the extracted segment as a chain carrying this alias. With
   * `length` 1 this is also what requests a chain identity at all: a single
   * detached Issue does not receive one unless the operator asks.
   */
  newChainName?: string;
}

export interface ChainMergePlanInput extends ChainAdvancedObservation {
  /** The chain that survives, keeping its ID. */
  target: ChainLinearTarget;
  /** The chain being merged in and retired. */
  source: ChainLinearTarget;
  position: ChainMergePosition;
}

/* -------------------------------------------------------------------------
 * Verdicts
 * ---------------------------------------------------------------------- */

/** One result graph, validated, as the registry should hold it afterwards. */
export interface ChainAdvancedGraph {
  headIssueNumber: number;
  members: ChainMemberInput[];
  edges: ChainEdgeInput[];
  canonical: CanonicalChainGraph;
}

export interface ChainForkApply {
  action: "apply";
  operation: "fork";
  chainId: string;
  /** The extracted members, in dependency order. */
  segmentIssues: number[];
  /**
   * True when the segment receives no chain identity: `length` 1 with no name
   * requested. The Issue is simply detached, and `segment` describes the
   * single-member graph it would have been.
   */
  detach: boolean;
  /** The forked chain afterwards. */
  remaining: ChainAdvancedGraph;
  /** The extracted segment as its own graph. */
  segment: ChainAdvancedGraph;
  /**
   * Every relationship the extraction introduces: each predecessor of the
   * segment's first member bridged to each successor of its last, so the
   * ordering constraints among the remaining members survive. Ascending.
   */
  bridgeEdges: ChainGraphEdge[];
  /** Every boundary relationship the extraction severs, ascending. */
  boundaryEdges: ChainGraphEdge[];
  /** Bridges the observation does not already hold — what is left to create. */
  edgeAdditions: ChainGraphEdge[];
  /** Boundary edges the observation still holds — what is left to remove. */
  edgeRemovals: ChainGraphEdge[];
  /** Every Issue whose GitHub relationships or chain registration this touches. */
  affectedIssues: number[];
}

export interface ChainMergeApply {
  action: "apply";
  operation: "merge";
  /** The surviving chain — the target's ID, preserved. */
  chainId: string;
  sourceChainId: string;
  position: ChainMergePosition;
  /** The merged graph the target chain holds afterwards. */
  merged: ChainAdvancedGraph;
  /**
   * The one relationship the merge introduces. Absent when the merge is
   * resuming a retirement (see {@link ChainMergeApply.resumeRetirement}).
   */
  boundaryEdge?: ChainGraphEdge;
  /** Relationships the observation is missing — normally just the boundary. */
  edgeAdditions: ChainGraphEdge[];
  /**
   * True when the target's accepted graph already contains every source member
   * and edge — the state an interrupted merge leaves after its acceptance
   * landed but before the source was retired. Nothing is left to write on
   * GitHub or into the target; only the source's retirement remains.
   */
  resumeRetirement: boolean;
  /** Every Issue whose GitHub relationships or chain registration this touches. */
  affectedIssues: number[];
}

export type ChainAdvancedRefusal = ChainSyncRefusal;

export type ChainForkPlan = ChainForkApply | ChainAdvancedRefusal;
export type ChainMergePlan = ChainMergeApply | ChainAdvancedRefusal;

/** Where an advanced command's refusals point, mirroring the linear wording. */
const ADVANCED_DIRECTION =
  "Nothing was changed on GitHub or in the registry by this refusal. Inspect the chain with `admin chain show` " +
  "and the live relationships with `admin chain validate`, then re-run the command once the conflict is resolved.";

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function refusal(
  kind: ChainSyncRefusalKind,
  transient: boolean,
  message: string,
  remediation: string,
  detail?: Partial<Pick<ChainSyncRefusal, "diagnostics" | "providerErrors" | "violations">>,
): ChainAdvancedRefusal {
  return {
    action: "refuse",
    kind,
    transient,
    message,
    remediation,
    diagnostics: detail?.diagnostics ?? [],
    violations: detail?.violations ?? [],
    providerErrors: detail?.providerErrors ?? [],
  };
}

/**
 * Word #890 findings as an advanced-operation refusal. Exported for the same
 * reason as its linear sibling: the store can surface the same findings from
 * inside its own write, and both must read identically.
 */
export function structuralChainAdvancedRefusal(
  operation: ChainAdvancedOperation,
  diagnostics: readonly ChainGraphDiagnostic[],
): ChainAdvancedRefusal {
  const hints = diagnosticRemediationHints(diagnostics);
  return refusal(
    "structural",
    false,
    `\`chain ${operation}\` would not leave a valid chain graph (${plural(diagnostics.length, "finding")})`,
    hints.length === 0 ? ADVANCED_DIRECTION : `${hints.join("; ")}. ${ADVANCED_DIRECTION}`,
    { diagnostics: [...diagnostics] },
  );
}

/** An Issue a chain outside the operation's operands already owns. */
export function ownedElsewhereChainAdvancedRefusal(
  operation: ChainAdvancedOperation,
  owners: readonly ChainOwnershipEntry[],
): ChainAdvancedRefusal {
  const sorted = [...owners].sort(
    (a, b) => a.issueNumber - b.issueNumber || (a.chainId < b.chainId ? -1 : a.chainId > b.chainId ? 1 : 0),
  );
  const rendered = sorted.map((o) => `#${o.issueNumber} (${o.chainId})`).join(", ");
  return refusal(
    "structural",
    false,
    `\`chain ${operation}\` involves ${plural(sorted.length, "Issue")} that already belong to a chain outside this ` +
      `operation: ${rendered}`,
    `An advanced operation moves Issues between exactly the chains it names; one whose Issues a third chain owns is ` +
      `a registry inconsistency to repair first (\`admin chain validate\`). ${ADVANCED_DIRECTION}`,
    {
      diagnostics: [
        {
          code: "duplicate_ownership",
          issues: [...new Set(sorted.map((o) => o.issueNumber))].sort((a, b) => a - b),
          observedEdges: [],
          expectedEdges: [],
          chains: [...new Set(sorted.map((o) => o.chainId))].sort(),
          message: `issues ${sorted.map((o) => o.issueNumber).join(", ")} already belong to another chain`,
        },
      ],
    },
  );
}

/* -------------------------------------------------------------------------
 * Shared plumbing
 * ---------------------------------------------------------------------- */

function edgeKey(edge: ChainGraphEdge): string {
  return `${edge.blockerIssueNumber}->${edge.blockedIssueNumber}`;
}

function compareEdges(a: ChainGraphEdge, b: ChainGraphEdge): number {
  return a.blockerIssueNumber - b.blockerIssueNumber || a.blockedIssueNumber - b.blockedIssueNumber;
}

function formatEdgeList(edges: readonly ChainGraphEdge[]): string {
  return edges.map((e) => `${e.blockerIssueNumber}->${e.blockedIssueNumber}`).join(", ");
}

/** Deduplicated adjacency in both directions, from a chain's recorded edges. */
function adjacency(edges: readonly ChainGraphEdge[]): {
  outgoing: Map<number, number[]>;
  incoming: Map<number, number[]>;
  keys: Set<string>;
} {
  const outgoing = new Map<number, number[]>();
  const incoming = new Map<number, number[]>();
  const keys = new Set<string>();
  for (const edge of edges) {
    const key = edgeKey(edge);
    if (keys.has(key)) continue;
    keys.add(key);
    const out = outgoing.get(edge.blockerIssueNumber) ?? [];
    out.push(edge.blockedIssueNumber);
    outgoing.set(edge.blockerIssueNumber, out);
    const into = incoming.get(edge.blockedIssueNumber) ?? [];
    into.push(edge.blockerIssueNumber);
    incoming.set(edge.blockedIssueNumber, into);
  }
  for (const list of outgoing.values()) list.sort((a, b) => a - b);
  for (const list of incoming.values()) list.sort((a, b) => a - b);
  return { outgoing, incoming, keys };
}

function providerErrorRefusal(
  operation: ChainAdvancedOperation,
  errors: readonly ChainSyncProviderError[],
): ChainAdvancedRefusal {
  const issues = [...errors].map((e) => e.issueNumber).sort((a, b) => a - b);
  return refusal(
    "provider_error",
    true,
    `could not read the GitHub relationships for ${plural(issues.length, "Issue")} ` +
      `(${issues.map((n) => `#${n}`).join(", ")}); \`chain ${operation}\` was not applied`,
    "Transient or access failure, not a graph problem: nothing was changed on GitHub or in the registry. Re-run " +
      "the command once the Issues are readable.",
    { providerErrors: [...errors] },
  );
}

function unacceptedChainRefusal(
  operation: ChainAdvancedOperation,
  chain: ChainLinearTarget,
): ChainAdvancedRefusal {
  return refusal(
    "structural",
    false,
    `chain ${chain.chainId} holds revision ${chain.graphRevision} but has accepted ` +
      `${chain.acceptedRevision === undefined ? "none" : chain.acceptedRevision}`,
    `An advanced operation reshapes a chain's last accepted graph, never an unaccepted candidate. Reconcile the ` +
      `chain first — \`admin chain validate ${chain.chainId}\`, then \`admin chain sync ${chain.chainId} --yes\` — ` +
      `and re-run. ${ADVANCED_DIRECTION}`,
  );
}

/**
 * Word GitHub relationships the operation does not account for — held now, or
 * gained while the operation ran. The planned graph and the planned removals
 * together are everything an advanced operation is allowed to know about; a
 * relationship outside both is drift `chain sync` should import, a dependency
 * on an Issue outside the chains, or another operator editing the same Issues
 * right now.
 */
function unplannedEdgesRefusal(
  operation: ChainAdvancedOperation,
  edges: readonly ChainGraphEdge[],
  phase: "observed" | "read_back",
): ChainAdvancedRefusal {
  const rendered = formatEdgeList(edges);
  const message =
    phase === "observed"
      ? `GitHub holds ${plural(edges.length, "relationship")} \`chain ${operation}\` does not account for: ${rendered}`
      : `GitHub gained ${plural(edges.length, "relationship")} while \`chain ${operation}\` was being applied: ${rendered}`;
  const remediation =
    phase === "observed"
      ? "An advanced operation touches exactly the relationships it plans, so it will not adopt one it did not. " +
        "If the extra edges are legitimate, import them into the chain with `admin chain sync` and re-run; if they " +
        "are not, remove them on GitHub."
      : "Another actor edited these Issue Relationships while the command ran, so the registry was NOT updated: it " +
        "still holds the graphs from before this operation, and GitHub now holds something neither side planned. " +
        "Reconcile the two with `admin chain validate` before re-running.";
  return refusal("structural", false, message, `${remediation} ${ADVANCED_DIRECTION}`);
}

/**
 * Word a registry-recorded relationship GitHub does not hold. Carried edges are
 * never re-created from local state — the same rule, and nearly the same
 * wording, as the linear commands' step 7.
 */
function missingCarriedEdgesRefusal(
  operation: ChainAdvancedOperation,
  chainId: string,
  edges: readonly ChainGraphEdge[],
): ChainAdvancedRefusal {
  return refusal(
    "structural",
    false,
    `chain ${chainId} records ${plural(edges.length, "relationship")} GitHub does not hold: ${formatEdgeList(edges)}`,
    "The chain's accepted graph and the live relationships disagree, and an advanced operation will not re-create " +
      "the missing ones from local state — an edge somebody removed on purpose must not come back as a side effect " +
      "of a topology edit. Reconcile them first (`admin chain validate`, then `admin chain sync --yes` to adopt " +
      `what GitHub says) and re-run. ${ADVANCED_DIRECTION}`,
  );
}

/**
 * Everything the observation holds among the observed Issues that the planned
 * post-state does not contain and the plan does not intend to remove.
 */
function findUnplannedEdges(
  observedEdges: readonly ChainGraphEdge[],
  postEdgeKeys: ReadonlySet<string>,
  plannedRemovalKeys: ReadonlySet<string>,
): ChainGraphEdge[] {
  const seen = new Set<string>();
  const unplanned: ChainGraphEdge[] = [];
  for (const edge of observedEdges) {
    const key = edgeKey(edge);
    if (seen.has(key)) continue;
    seen.add(key);
    if (!postEdgeKeys.has(key) && !plannedRemovalKeys.has(key)) unplanned.push(edge);
  }
  return unplanned.sort(compareEdges);
}

/* -------------------------------------------------------------------------
 * Fork
 * ---------------------------------------------------------------------- */

/** What the fork frozen-prefix rule needs to know about a planned extraction. */
export interface ForkFrozenShape {
  chainId: string;
  segmentIssues: readonly number[];
  remaining: ChainGraphSnapshot;
}

/**
 * The #891 rule for a fork, in one place so the plan, the caller's
 * post-suspension re-check, and the acceptance's commit guard provably apply
 * the same one. Two readings, both enforced:
 *
 *   - the segment must be unfrozen by name — extracting a started Issue would
 *     move the contract pinned for it to another chain;
 *   - the remaining graph must satisfy every snapshot, which is what reports
 *     the extraction of a started Issue's *ancestor* as the `ancestor_removed`
 *     it is.
 *
 * Returns the refusal, or `undefined` when every snapshot is satisfied.
 */
export function checkForkFrozenPrefixes(
  shape: ForkFrozenShape,
  snapshots: readonly FrozenPrefixSnapshot[],
): ChainAdvancedRefusal | undefined {
  const segmentSet = new Set(shape.segmentIssues);
  const frozenInSegment = [
    ...new Set(
      snapshots
        .filter((s) => s.chainId === shape.chainId && segmentSet.has(s.issueNumber))
        .map((s) => s.issueNumber),
    ),
  ].sort((a, b) => a - b);
  if (frozenInSegment.length > 0) {
    return refusal(
      "frozen_prefix",
      false,
      `the segment contains started Issue(s) ${frozenInSegment.map((n) => `#${n}`).join(", ")}, ` +
        "whose dependency prefixes are frozen",
      `\`chain fork\` extracts only a contiguous UNFROZEN segment: a started Issue's pinned ancestry outranks an ` +
        `operator edit, and moving it to another chain would rewrite that contract. Choose a segment wholly ` +
        `downstream of every started Issue. ${ADVANCED_DIRECTION}`,
    );
  }
  const frozen = checkFrozenPrefixes({
    candidate: shape.remaining,
    snapshots,
    chainId: shape.chainId,
  });
  return frozen.ok ? undefined : frozenPrefixRefusal(frozen);
}

/**
 * The #891 rule for a merge: the merged candidate answers for every started
 * Issue either chain holds, so the snapshots are judged with no chain filter
 * and the caller supplies both chains' lists. Shared by the plan, the
 * post-suspension re-check, and the target acceptance's commit guard.
 */
export function checkMergeFrozenPrefixes(
  merged: ChainGraphSnapshot,
  snapshots: readonly FrozenPrefixSnapshot[],
): ChainAdvancedRefusal | undefined {
  const frozen = checkFrozenPrefixes({ candidate: merged, snapshots });
  return frozen.ok ? undefined : frozenPrefixRefusal(frozen);
}

/**
 * Decide how one `chain fork` should change GitHub and the registry.
 *
 * The checks run in the linear commands' order — completeness of the
 * observation, the accepted-revision precondition, ownership, the shape of the
 * request, #890's rules over both resulting graphs, GitHub against the
 * registry, and #891's frozen prefixes last — because a refusal is cheapest to
 * act on in that order and the findings stay meaningful in it.
 */
export function planChainFork(input: ChainForkPlanInput): ChainForkPlan {
  const operation = "fork" as const;
  const { target } = input;

  if (input.providerErrors.length > 0) {
    return providerErrorRefusal(operation, input.providerErrors);
  }

  if (target.acceptedRevision !== target.graphRevision) {
    return unacceptedChainRefusal(operation, target);
  }

  const foreign = input.ownership.filter((entry) => entry.chainId !== target.chainId);
  if (foreign.length > 0) {
    return ownedElsewhereChainAdvancedRefusal(operation, foreign);
  }

  const memberSet = new Set(target.members.map((m) => m.issueNumber));
  if (!memberSet.has(input.startIssueNumber)) {
    return refusal(
      "structural",
      false,
      `#${input.startIssueNumber} is not a member of chain ${target.chainId}`,
      `\`chain fork\` extracts a segment of the chain it names, so the starting Issue must be one of its members. ` +
        `If a previous fork was interrupted after the chain was updated, the segment is no longer registered: ` +
        `finish it with \`admin chain new <segment-issues> [name]\`, which adopts the relationships already in ` +
        `place. ${ADVANCED_DIRECTION}`,
    );
  }

  if (input.length !== undefined && (!Number.isInteger(input.length) || input.length < 1)) {
    return refusal(
      "structural",
      false,
      `segment length must be a positive integer, got ${String(input.length)}`,
      `Name how many consecutive members to extract, or omit the length to extract through the chain's downstream ` +
        `end. ${ADVANCED_DIRECTION}`,
    );
  }

  // ------------------------------------------------------------------
  // Walk the segment along the chain's own edges. Contiguity is decided
  // entirely by degrees: every interior boundary of the walk must be one
  // edge wide, or the extraction would have to invent topology.
  // ------------------------------------------------------------------
  const { outgoing, incoming, keys: targetEdgeKeySet } = adjacency(
    target.edges as readonly ChainGraphEdge[],
  );
  const segment: number[] = [input.startIssueNumber];
  const segmentSet = new Set<number>(segment);
  const wantedLength = input.length;
  for (;;) {
    const last = segment[segment.length - 1];
    const outs = outgoing.get(last) ?? [];
    if (wantedLength !== undefined && segment.length === wantedLength) break;
    if (outs.length === 0) {
      if (wantedLength === undefined) break;
      return refusal(
        "structural",
        false,
        `the segment runs past the chain's downstream end: #${last} blocks nothing, but ` +
          `${wantedLength - segment.length} more member(s) were asked for`,
        `A segment is consecutive members of the chain; #${input.startIssueNumber} starts a run of only ` +
          `${segment.length}. ${ADVANCED_DIRECTION}`,
      );
    }
    if (outs.length > 1) {
      return refusal(
        "structural",
        false,
        `the segment cannot continue past #${last}, which blocks ${outs.map((n) => `#${n}`).join(", ")}: a fork ` +
          "point inside the segment has no single next member",
        `\`chain fork\` extracts one contiguous run; a member that fans out may only be the segment's LAST member. ` +
          `Shorten the length to end the segment at #${last}. ${ADVANCED_DIRECTION}`,
      );
    }
    const next = outs[0];
    if (segmentSet.has(next)) {
      // A cycle cannot survive #890 validation, but this walk must terminate
      // on whatever it is handed.
      return refusal(
        "structural",
        false,
        `the segment walk revisited #${next}; chain ${target.chainId} does not hold a valid graph`,
        `Reconcile the chain with \`admin chain validate ${target.chainId}\` before editing it. ${ADVANCED_DIRECTION}`,
      );
    }
    const intoNext = incoming.get(next) ?? [];
    if (intoNext.length > 1) {
      return refusal(
        "structural",
        false,
        `the segment cannot continue into #${next}, which is blocked by ${intoNext.map((n) => `#${n}`).join(", ")}: ` +
          "a merge point inside the segment cannot be extracted",
        `\`chain fork\` extracts one contiguous run; a member that fans in may only be the segment's FIRST member. ` +
          `Start the segment at #${next}, or end it at #${last}. ${ADVANCED_DIRECTION}`,
      );
    }
    segment.push(next);
    segmentSet.add(next);
  }

  if (segment.length === memberSet.size) {
    return refusal(
      "structural",
      false,
      `the segment is the whole of chain ${target.chainId} (${plural(segment.length, "member")})`,
      `Extracting every member is not a fork — the chain would be left empty. To rename the chain, register an ` +
        `alias; to give these Issues a different identity, that is a retirement, not an extraction. ${ADVANCED_DIRECTION}`,
    );
  }

  const first = segment[0];
  const last = segment[segment.length - 1];
  const predecessors = (incoming.get(first) ?? []).filter((n) => !segmentSet.has(n));
  const successors = (outgoing.get(last) ?? []).filter((n) => !segmentSet.has(n));

  // ------------------------------------------------------------------
  // The head. A chain's head has no outgoing edge in a graph #890 accepted
  // with matching roles, so it can only ever be the segment's last member;
  // when it is, the remaining chain needs a new head, and the only
  // deterministic candidate is the sole predecessor the bridge hangs from.
  // ------------------------------------------------------------------
  let remainingHead = target.headIssueNumber;
  if (segmentSet.has(target.headIssueNumber)) {
    if (target.headIssueNumber !== last) {
      return refusal(
        "structural",
        false,
        `chain ${target.chainId}'s head #${target.headIssueNumber} sits inside the segment but is not its last member`,
        `A head is the chain's downstream end; extracting it mid-segment would leave members downstream of it. ` +
          `Reconcile the chain with \`admin chain validate ${target.chainId}\`. ${ADVANCED_DIRECTION}`,
      );
    }
    if (predecessors.length !== 1) {
      return refusal(
        "structural",
        false,
        predecessors.length === 0
          ? `extracting the segment takes chain ${target.chainId}'s head #${target.headIssueNumber} and leaves no ` +
            "predecessor to become the new head"
          : `extracting the segment takes chain ${target.chainId}'s head #${target.headIssueNumber}, and the new ` +
            `head is ambiguous: #${first} is blocked by ${predecessors.map((n) => `#${n}`).join(", ")}`,
        `A fork that removes the head must leave exactly one Issue the head hand-off can fall to — the segment's ` +
          `single predecessor. Choose a shorter segment, or one that does not contain the head. ${ADVANCED_DIRECTION}`,
      );
    }
    remainingHead = predecessors[0];
  }

  // ------------------------------------------------------------------
  // The two result graphs, and the relationship changes between them.
  // ------------------------------------------------------------------
  const boundaryEdges: ChainGraphEdge[] = [
    ...predecessors.map((p) => ({ blockerIssueNumber: p, blockedIssueNumber: first })),
    ...successors.map((s) => ({ blockerIssueNumber: last, blockedIssueNumber: s })),
  ].sort(compareEdges);
  const bridgeEdges: ChainGraphEdge[] = [];
  for (const p of predecessors) {
    for (const s of successors) {
      const bridge = { blockerIssueNumber: p, blockedIssueNumber: s };
      // A predecessor already blocking a successor directly needs no bridge,
      // and proposing one would duplicate an edge the chain already records.
      if (!targetEdgeKeySet.has(edgeKey(bridge))) bridgeEdges.push(bridge);
    }
  }
  bridgeEdges.sort(compareEdges);

  const remainingMembers: ChainMemberInput[] = target.members
    .filter((m) => !segmentSet.has(m.issueNumber))
    .map((m) => ({
      issueNumber: m.issueNumber,
      role: m.issueNumber === remainingHead ? ("head" as const) : ("node" as const),
    }));
  const boundaryKeys = new Set(boundaryEdges.map(edgeKey));
  const segmentEdges: ChainEdgeInput[] = [];
  const remainingEdges: ChainEdgeInput[] = [];
  for (const key of targetEdgeKeySet) {
    const [blocker, blocked] = key.split("->").map(Number);
    const edge = { blockerIssueNumber: blocker, blockedIssueNumber: blocked };
    if (boundaryKeys.has(key)) continue;
    if (segmentSet.has(blocker) && segmentSet.has(blocked)) segmentEdges.push(edge);
    else remainingEdges.push(edge);
  }
  remainingEdges.push(...bridgeEdges);
  remainingEdges.sort(compareEdges);
  segmentEdges.sort(compareEdges);

  const segmentMembers: ChainMemberInput[] = segment.map((issueNumber) => ({
    issueNumber,
    role: issueNumber === last ? ("head" as const) : ("node" as const),
  }));

  const remainingValidation = validateChainGraph(
    { chainId: target.chainId, headIssueNumber: remainingHead, members: remainingMembers, edges: remainingEdges },
    { ownership: input.ownership },
  );
  if (!remainingValidation.ok) {
    return structuralChainAdvancedRefusal(operation, remainingValidation.diagnostics);
  }
  const segmentValidation = validateChainGraph(
    { headIssueNumber: last, members: segmentMembers, edges: segmentEdges },
    { ownership: [] },
  );
  if (!segmentValidation.ok) {
    return structuralChainAdvancedRefusal(operation, segmentValidation.diagnostics);
  }

  // ------------------------------------------------------------------
  // GitHub against the plan: nothing unplanned, everything carried.
  // ------------------------------------------------------------------
  const postEdgeKeys = new Set([...remainingEdges, ...segmentEdges].map((e) => edgeKey(e as ChainGraphEdge)));
  const observedKeys = new Set(input.observedEdges.map(edgeKey));
  const observedScope = new Set(input.observedIssues);

  const unplanned = findUnplannedEdges(input.observedEdges, postEdgeKeys, boundaryKeys);
  if (unplanned.length > 0) {
    return unplannedEdgesRefusal(operation, unplanned, "observed");
  }

  const missingCarried = (target.edges as readonly ChainGraphEdge[])
    .filter(
      (e) =>
        !boundaryKeys.has(edgeKey(e)) &&
        observedScope.has(e.blockedIssueNumber) &&
        !observedKeys.has(edgeKey(e)),
    )
    .sort(compareEdges);
  if (missingCarried.length > 0) {
    return missingCarriedEdgesRefusal(operation, target.chainId, missingCarried);
  }

  // ------------------------------------------------------------------
  // #891. The segment must be unfrozen by name — a started Issue's contract
  // may be neither extracted nor rewritten — and the remaining graph must
  // leave every other started Issue's ancestry exactly as pinned.
  // ------------------------------------------------------------------
  const forkShape: ForkFrozenShape = {
    chainId: target.chainId,
    segmentIssues: segment,
    remaining: { members: remainingMembers, edges: remainingEdges },
  };
  if (input.skipFrozenPrefixes !== true) {
    const frozen = checkForkFrozenPrefixes(forkShape, input.frozenSnapshots);
    if (frozen !== undefined) return frozen;
  }

  const edgeAdditions = bridgeEdges
    .filter((e) => !observedKeys.has(edgeKey(e)) && observedScope.has(e.blockedIssueNumber))
    .sort(compareEdges);
  const edgeRemovals = boundaryEdges.filter((e) => observedKeys.has(edgeKey(e))).sort(compareEdges);

  const affected = new Set<number>(segment);
  for (const edge of [...boundaryEdges, ...bridgeEdges]) {
    affected.add(edge.blockerIssueNumber);
    affected.add(edge.blockedIssueNumber);
  }

  const detach = segment.length === 1 && input.newChainName === undefined;

  return {
    action: "apply",
    operation,
    chainId: target.chainId,
    segmentIssues: segment,
    detach,
    remaining: {
      headIssueNumber: remainingHead,
      members: remainingMembers,
      edges: remainingEdges,
      canonical: remainingValidation.graph,
    },
    segment: {
      headIssueNumber: last,
      members: segmentMembers,
      edges: segmentEdges,
      canonical: segmentValidation.graph,
    },
    bridgeEdges,
    boundaryEdges,
    edgeAdditions,
    edgeRemovals,
    affectedIssues: [...affected].sort((a, b) => a - b),
  };
}

/* -------------------------------------------------------------------------
 * Merge
 * ---------------------------------------------------------------------- */

/** The one member nothing in the chain blocks, or the reason there is not one. */
function soleRoot(chain: ChainLinearTarget): { root: number } | { roots: number[] } {
  const blocked = new Set(chain.edges.map((e) => e.blockedIssueNumber));
  const roots = chain.members
    .map((m) => m.issueNumber)
    .filter((issueNumber) => !blocked.has(issueNumber))
    .sort((a, b) => a - b);
  return roots.length === 1 ? { root: roots[0] } : { roots };
}

/**
 * Decide how one `chain merge` should change GitHub and the registry.
 *
 * The verdict's `merged` graph is what the TARGET chain holds afterwards; the
 * source's retirement — its deletion, and its ID and aliases re-registered as
 * aliases of the target — is the caller's to carry out after the acceptance,
 * because only the registry can make it atomic.
 */
export function planChainMerge(input: ChainMergePlanInput): ChainMergePlan {
  const operation = "merge" as const;
  const { target, source, position } = input;

  if (input.providerErrors.length > 0) {
    return providerErrorRefusal(operation, input.providerErrors);
  }

  if (target.chainId === source.chainId) {
    return refusal(
      "structural",
      false,
      `chain ${target.chainId} cannot be merged into itself`,
      `Name two different chains. ${ADVANCED_DIRECTION}`,
    );
  }

  if (target.acceptedRevision !== target.graphRevision) {
    return unacceptedChainRefusal(operation, target);
  }

  const targetMemberSet = new Set(target.members.map((m) => m.issueNumber));
  const sourceMembers = source.members.map((m) => m.issueNumber);
  const overlap = sourceMembers.filter((n) => targetMemberSet.has(n)).sort((a, b) => a - b);

  const foreign = input.ownership.filter(
    (entry) => entry.chainId !== target.chainId && entry.chainId !== source.chainId,
  );
  if (foreign.length > 0) {
    return ownedElsewhereChainAdvancedRefusal(operation, foreign);
  }

  // ------------------------------------------------------------------
  // Resume: an interrupted merge whose acceptance landed leaves the target
  // already holding every source member and edge, and the source still
  // registered. Nothing is left to plan against GitHub — the retirement is
  // the whole remainder.
  // ------------------------------------------------------------------
  const targetEdgeKeys = new Set(target.edges.map((e) => edgeKey(e as ChainGraphEdge)));
  if (overlap.length === sourceMembers.length && sourceMembers.length > 0) {
    const missingEdges = (source.edges as readonly ChainGraphEdge[]).filter(
      (e) => !targetEdgeKeys.has(edgeKey(e)),
    );
    if (missingEdges.length > 0) {
      return refusal(
        "structural",
        false,
        `every member of chain ${source.chainId} is already in chain ${target.chainId}, but the target does not ` +
          `record ${plural(missingEdges.length, "of its relationship")}: ${formatEdgeList(missingEdges)}`,
        `The two chains overlap without agreeing, which no merge can produce. Reconcile them with \`admin chain ` +
          `validate\` before retiring either. ${ADVANCED_DIRECTION}`,
      );
    }
    const validation = validateChainGraph(
      {
        chainId: target.chainId,
        headIssueNumber: target.headIssueNumber,
        members: target.members,
        edges: target.edges,
      },
      { ownership: foreign },
    );
    if (!validation.ok) return structuralChainAdvancedRefusal(operation, validation.diagnostics);
    return {
      action: "apply",
      operation,
      chainId: target.chainId,
      sourceChainId: source.chainId,
      position,
      merged: {
        headIssueNumber: target.headIssueNumber,
        members: target.members.map((m) => ({ ...m })),
        edges: target.edges.map((e) => ({ ...e })),
        canonical: validation.graph,
      },
      edgeAdditions: [],
      resumeRetirement: true,
      affectedIssues: [...sourceMembers].sort((a, b) => a - b),
    };
  }

  if (overlap.length > 0) {
    return refusal(
      "structural",
      false,
      `${plural(overlap.length, "Issue")} belong to both chains: ${overlap.map((n) => `#${n}`).join(", ")}`,
      `Two chains sharing members is a registry inconsistency no merge can resolve; repair it with \`admin chain ` +
        `validate\` first. ${ADVANCED_DIRECTION}`,
    );
  }

  if (source.acceptedRevision !== source.graphRevision) {
    return unacceptedChainRefusal(operation, source);
  }

  // ------------------------------------------------------------------
  // The boundary. `append` extends past the target's head, so the head must
  // be a genuine downstream end and the source must have one root to attach;
  // `prepend` attaches the source's head ahead of the target's one root.
  // Both sink checks are judged against GitHub as well as the registry —
  // an outgoing relationship to an unregistered Issue is invisible to the
  // recorded edges, exactly as in `chain append` (issue #791 review). Edges
  // into the other chain's members are excluded: a boundary edge an
  // interrupted run already wrote must let the retry finish.
  // ------------------------------------------------------------------
  const sourceMemberSet = new Set(sourceMembers);
  let boundaryEdge: ChainGraphEdge;
  let mergedHead: number;
  if (position === "append") {
    const root = soleRoot(source);
    if (!("root" in root)) {
      return refusal(
        "structural",
        false,
        root.roots.length === 0
          ? `chain ${source.chainId} has no Issue that starts it, so there is nothing to attach after ` +
            `#${target.headIssueNumber}`
          : `chain ${source.chainId} has ${plural(root.roots.length, "root")} ` +
            `(${root.roots.map((n) => `#${n}`).join(", ")}), so there is no single Issue to attach after ` +
            `#${target.headIssueNumber}`,
        `\`chain merge --position append\` draws one relationship from the target's head to the source's root; a ` +
          `source with several starting Issues has no single one to attach. ${ADVANCED_DIRECTION}`,
      );
    }
    const headBlocks = [
      ...(target.edges as readonly ChainGraphEdge[]).filter(
        (e) => e.blockerIssueNumber === target.headIssueNumber,
      ),
      ...input.observedEdges.filter(
        (e) => e.blockerIssueNumber === target.headIssueNumber && !sourceMemberSet.has(e.blockedIssueNumber),
      ),
    ];
    const blockedByHead = [...new Set(headBlocks.map((e) => e.blockedIssueNumber))].sort((a, b) => a - b);
    if (blockedByHead.length > 0) {
      return refusal(
        "structural",
        false,
        `chain ${target.chainId}'s head #${target.headIssueNumber} already blocks ` +
          `${blockedByHead.map((n) => `#${n}`).join(", ")}, so it is not the chain's downstream end`,
        `\`chain merge --position append\` attaches past the head; inserting into the middle of a dependency path ` +
          `is not a merge. ${ADVANCED_DIRECTION}`,
      );
    }
    boundaryEdge = { blockerIssueNumber: target.headIssueNumber, blockedIssueNumber: root.root };
    mergedHead = source.headIssueNumber;
  } else {
    const root = soleRoot(target);
    if (!("root" in root)) {
      return refusal(
        "structural",
        false,
        root.roots.length === 0
          ? `chain ${target.chainId} has no Issue that starts it, so there is nowhere to attach chain ` +
            `${source.chainId} ahead of`
          : `chain ${target.chainId} has ${plural(root.roots.length, "root")} ` +
            `(${root.roots.map((n) => `#${n}`).join(", ")}), so there is no single place to attach chain ` +
            `${source.chainId} ahead of`,
        `\`chain merge --position prepend\` draws one relationship from the source's head to the target's root; a ` +
          `target with several starting Issues has no single one to attach ahead of. ${ADVANCED_DIRECTION}`,
      );
    }
    const headBlocks = [
      ...(source.edges as readonly ChainGraphEdge[]).filter(
        (e) => e.blockerIssueNumber === source.headIssueNumber,
      ),
      ...input.observedEdges.filter(
        (e) => e.blockerIssueNumber === source.headIssueNumber && !targetMemberSet.has(e.blockedIssueNumber),
      ),
    ];
    const blockedByHead = [...new Set(headBlocks.map((e) => e.blockedIssueNumber))].sort((a, b) => a - b);
    if (blockedByHead.length > 0) {
      return refusal(
        "structural",
        false,
        `chain ${source.chainId}'s head #${source.headIssueNumber} already blocks ` +
          `${blockedByHead.map((n) => `#${n}`).join(", ")}, so it is not the chain's downstream end`,
        `\`chain merge --position prepend\` attaches the source's head ahead of the target's root; a source whose ` +
          `head is mid-graph has no downstream end to attach from. ${ADVANCED_DIRECTION}`,
      );
    }
    boundaryEdge = { blockerIssueNumber: source.headIssueNumber, blockedIssueNumber: root.root };
    mergedHead = target.headIssueNumber;
  }

  const mergedMembers: ChainMemberInput[] = [
    ...target.members.map((m) => ({
      issueNumber: m.issueNumber,
      role: m.issueNumber === mergedHead ? ("head" as const) : ("node" as const),
    })),
    ...source.members.map((m) => ({
      issueNumber: m.issueNumber,
      role: m.issueNumber === mergedHead ? ("head" as const) : ("node" as const),
    })),
  ];
  const mergedEdges: ChainEdgeInput[] = [
    ...target.edges.map((e) => ({ ...e })),
    ...source.edges.map((e) => ({ ...e })),
    boundaryEdge,
  ];

  const validation = validateChainGraph(
    { chainId: target.chainId, headIssueNumber: mergedHead, members: mergedMembers, edges: mergedEdges },
    { ownership: foreign },
  );
  if (!validation.ok) return structuralChainAdvancedRefusal(operation, validation.diagnostics);

  // ------------------------------------------------------------------
  // GitHub against the plan.
  // ------------------------------------------------------------------
  const mergedEdgeKeys = new Set(mergedEdges.map((e) => edgeKey(e as ChainGraphEdge)));
  const observedKeys = new Set(input.observedEdges.map(edgeKey));
  const observedScope = new Set(input.observedIssues);

  const unplanned = findUnplannedEdges(input.observedEdges, mergedEdgeKeys, new Set());
  if (unplanned.length > 0) {
    return unplannedEdgesRefusal(operation, unplanned, "observed");
  }

  for (const chain of [target, source]) {
    const missingCarried = (chain.edges as readonly ChainGraphEdge[])
      .filter((e) => observedScope.has(e.blockedIssueNumber) && !observedKeys.has(edgeKey(e)))
      .sort(compareEdges);
    if (missingCarried.length > 0) {
      return missingCarriedEdgesRefusal(operation, chain.chainId, missingCarried);
    }
  }

  // ------------------------------------------------------------------
  // #891, over the union of both chains' snapshots and with no chain filter:
  // the merged candidate answers for every started Issue either chain holds.
  // `append` gives every source member new ancestors, so a frozen source
  // refuses it here; `prepend` does the same for a frozen target; a frozen
  // source under `prepend` keeps its ancestry bit-for-bit and passes.
  // ------------------------------------------------------------------
  if (input.skipFrozenPrefixes !== true) {
    const frozen = checkMergeFrozenPrefixes(
      { members: mergedMembers, edges: mergedEdges } satisfies ChainGraphSnapshot,
      input.frozenSnapshots,
    );
    if (frozen !== undefined) return frozen;
  }

  const edgeAdditions = (mergedEdges as readonly ChainGraphEdge[])
    .filter((e) => !observedKeys.has(edgeKey(e)) && observedScope.has(e.blockedIssueNumber))
    .sort(compareEdges);

  const affected = new Set<number>(sourceMembers);
  affected.add(boundaryEdge.blockerIssueNumber);
  affected.add(boundaryEdge.blockedIssueNumber);

  return {
    action: "apply",
    operation,
    chainId: target.chainId,
    sourceChainId: source.chainId,
    position,
    merged: {
      headIssueNumber: mergedHead,
      members: mergedMembers,
      edges: mergedEdges,
      canonical: validation.graph,
    },
    boundaryEdge,
    edgeAdditions,
    resumeRetirement: false,
    affectedIssues: [...affected].sort((a, b) => a - b),
  };
}

/* -------------------------------------------------------------------------
 * Read-back
 * ---------------------------------------------------------------------- */

/**
 * Judge a read-back of GitHub against the graphs an advanced operation just
 * applied. The linear read-back asks "did the additions land, and only they";
 * this one also asks whether every planned removal actually disappeared — a
 * removal reported successful that the read-back still shows means the write
 * did not take effect, and the registry must not record a graph GitHub was
 * never observed to hold.
 */
export function verifyAdvancedChainReadBack(input: {
  operation: ChainAdvancedOperation;
  /** Every edge the post-state should hold, across every result graph. */
  postEdges: readonly ChainEdgeInput[];
  /** The removals the operation planned. */
  removedEdges: readonly ChainGraphEdge[];
  observedEdges: readonly ChainGraphEdge[];
  observedIssues: readonly number[];
  providerErrors: readonly ChainSyncProviderError[];
}): { ok: true } | ChainAdvancedRefusal {
  if (input.providerErrors.length > 0) {
    const issues = [...input.providerErrors].map((e) => e.issueNumber).sort((a, b) => a - b);
    return refusal(
      "provider_error",
      true,
      `the relationships written for ${plural(issues.length, "Issue")} (${issues.map((n) => `#${n}`).join(", ")}) ` +
        "could not be read back, so the operation was not recorded in the registry",
      "The relationship writes may or may not have landed: nothing in the registry was changed, and a re-run " +
        "re-reads GitHub and applies only what is still missing. Verify with `admin chain validate` first if the " +
        "provider stays unreachable.",
      { providerErrors: [...input.providerErrors] },
    );
  }

  const scope = new Set(input.observedIssues);
  const observed = new Set(input.observedEdges.map(edgeKey));
  const postKeys = new Set(input.postEdges.map((e) => edgeKey(e as ChainGraphEdge)));
  const removalKeys = new Set(input.removedEdges.map(edgeKey));

  const missing = (input.postEdges as readonly ChainGraphEdge[])
    .filter((e) => scope.has(e.blockedIssueNumber) && !observed.has(edgeKey(e)))
    .sort(compareEdges);
  if (missing.length > 0) {
    return refusal(
      "structural",
      false,
      `GitHub does not hold ${plural(missing.length, "relationship")} this \`chain ${input.operation}\` requires: ` +
        formatEdgeList(missing),
      "The relationship writes were reported as successful but the read-back does not show them, so the registry " +
        "was NOT updated from state nobody verified. Check the Issues on GitHub and re-run the command.",
    );
  }

  const seen = new Set<string>();
  const stillPresent: ChainGraphEdge[] = [];
  const unplanned: ChainGraphEdge[] = [];
  for (const edge of input.observedEdges) {
    const key = edgeKey(edge);
    if (seen.has(key) || postKeys.has(key)) continue;
    seen.add(key);
    if (removalKeys.has(key)) stillPresent.push(edge);
    else unplanned.push(edge);
  }
  if (stillPresent.length > 0) {
    return refusal(
      "structural",
      false,
      `${plural(stillPresent.length, "relationship")} this \`chain ${input.operation}\` removed ` +
        `${stillPresent.length === 1 ? "is" : "are"} still held by GitHub: ${formatEdgeList(stillPresent.sort(compareEdges))}`,
      "A removal was reported as successful but the read-back still shows the relationship, so the registry was " +
        "NOT updated from state nobody verified. Check the Issues on GitHub (a permission that allows the write " +
        "but not the read, or a relationship re-created concurrently) and re-run the command.",
    );
  }
  if (unplanned.length > 0) {
    return unplannedEdgesRefusal(input.operation, unplanned.sort(compareEdges), "read_back");
  }

  return { ok: true };
}
