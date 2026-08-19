/**
 * Linear dependency-chain construction and editing (issue #791).
 *
 * `admin chain sync` (#892) imports whatever GitHub already says; intake (#790)
 * registers one candidate as it arrives. Neither *creates* a dependency
 * structure — an operator who wants "these three Issues, in this order" still
 * has to draw the relationships by hand and then import them. This module owns
 * the decision half of the three commands that close that gap:
 *
 *   admin chain new     <issue[,issue...]> [name]
 *   admin chain append  <chain-ref> <issue[,issue...]>
 *   admin chain prepend <chain-ref> <issue[,issue...]>
 *
 * They are conveniences over the DAG registry, not a restriction of its model:
 * every graph they produce is an ordinary #788 graph judged by #890's rules and
 * #891's frozen prefixes, and anything that is not a straight line — a fork, a
 * merge of two chains, an alias retirement, a reorder — is refused here and
 * belongs to the advanced operations in #893.
 *
 * Like `chain-sync.ts` and `chain-intake.ts`, this module decides only. It
 * reads nothing, writes nothing, and never touches GitHub or a database: the
 * caller gathers one observation and gets one verdict back, and the verdict
 * names both the graph to persist and the GitHub Issue Relationships that must
 * exist before it may be. The refusal shape and its three kinds are shared with
 * those modules on purpose — the same graph refused through a different door is
 * the same finding, and a caller routing on `kind`/`transient` must not need to
 * know which command produced it.
 *
 * Two orientation rules run through everything below, because a dependency edge
 * has a direction and the words for its ends are easy to swap:
 *
 *   - an edge is `blocker -> blocked`: the blocker must land first;
 *   - a chain's *head* is its downstream end — the Issue every other member is
 *     an ancestor of, and the one #788 derives the chain ID from. `append`
 *     therefore extends past the head and moves it; `prepend` extends past the
 *     chain's root (the member nothing blocks) and leaves the head alone.
 *
 * That asymmetry is what makes the frozen-prefix outcome fall out for free
 * rather than being special-cased: appending only ever adds Issues downstream
 * of every started task, which no frozen prefix can object to, while prepending
 * inserts an ancestor above the existing root and therefore rewrites the
 * ancestry of everything below it — which is exactly what #891 refuses once a
 * task has started against it.
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
import { diagnosticRemediationHints, frozenPrefixRefusal } from "./chain-sync.js";
import type { ChainSyncProviderError, ChainSyncRefusal, ChainSyncRefusalKind } from "./chain-sync.js";

/* -------------------------------------------------------------------------
 * Inputs
 * ---------------------------------------------------------------------- */

export const CHAIN_LINEAR_OPERATIONS = ["new", "append", "prepend"] as const;

export type ChainLinearOperation = (typeof CHAIN_LINEAR_OPERATIONS)[number];

export function isChainLinearOperation(value: unknown): value is ChainLinearOperation {
  return typeof value === "string" && (CHAIN_LINEAR_OPERATIONS as readonly string[]).includes(value);
}

/** The graph currently on record for the chain being extended. */
export interface ChainLinearTarget {
  chainId: string;
  headIssueNumber: number;
  members: readonly ChainMemberInput[];
  edges: readonly ChainEdgeInput[];
  /** Revision of the members/edges above. */
  graphRevision: number;
  /**
   * The revision #890 has accepted, or `undefined` while none has been. A
   * linear edit extends the last-known-good graph, so the two must agree —
   * see {@link planLinearChainEdit}.
   */
  acceptedRevision?: number;
}

export interface ChainLinearPlanInput {
  operation: ChainLinearOperation;
  /**
   * The Issues to link, in the order the operator gave them: `a,b,c` means
   * `a` blocks `b` blocks `c`. Must be non-empty and already de-duplicated;
   * a repeat is a caller-side parse error, not a graph finding.
   */
  issueNumbers: readonly number[];
  /** The chain being extended. Required for `append`/`prepend`, absent for `new`. */
  target?: ChainLinearTarget;
  /**
   * Every relationship observed on GitHub for the Issues in
   * {@link ChainLinearPlanInput.observedIssues}, as edges. This is both the
   * pre-flight read and (on a second call) the read-back: the plan's edge
   * additions are exactly what this observation is missing.
   *
   * BOTH directions, and the caller owes that: each Issue's `blocked by` set AND
   * the Issues it blocks. An observation built from incoming relationships alone
   * cannot see an edge that leaves the set, so an Issue already blocking an
   * unregistered one would look like a downstream end — and `append` would
   * extend past it and draw a live fork this module promises to refuse (issue
   * #791 review). `fetchObservedEdges(..., { includeDependents: true })` is what
   * satisfies this.
   */
  observedEdges: readonly ChainGraphEdge[];
  /**
   * The Issues the observation covers — the ones whose relationships were read,
   * in both directions. An edge is only judged as *missing* when its blocked end
   * is one of these; an edge OUT of the set is still judged as unplanned, which
   * is the whole point of reading the outgoing direction.
   */
  observedIssues: readonly number[];
  /** Every frozen prefix recorded against the target chain (#891). Empty for a `new`. */
  frozenSnapshots: readonly FrozenPrefixSnapshot[];
  /** Which OTHER chains already own any involved Issue (#890). */
  ownership: readonly ChainOwnershipEntry[];
  /** Observation failures. Any entry refuses the edit as transient. */
  providerErrors: readonly ChainSyncProviderError[];
  /**
   * Skip the frozen-prefix check. The caller runs it itself, after suspending
   * automation, so the snapshots it judges are the ones a quiesced repository
   * produced rather than the ones a task could still be adding to. See
   * {@link planLinearChainEdit}.
   */
  skipFrozenPrefixes?: boolean;
}

/* -------------------------------------------------------------------------
 * Verdict
 * ---------------------------------------------------------------------- */

/** An edit the caller may carry out. */
export interface ChainLinearApply {
  action: "apply";
  operation: ChainLinearOperation;
  /** Present for `append`/`prepend`; a `new` has no ID until the store allocates one. */
  chainId?: string;
  /** The head the edit leaves behind — moved by `append`, unchanged otherwise. */
  headIssueNumber: number;
  members: ChainMemberInput[];
  edges: ChainEdgeInput[];
  /** The validated canonical form, fingerprint included. */
  canonical: CanonicalChainGraph;
  /**
   * The GitHub Issue Relationships this edit must create: the target graph's
   * edges that the observation does not already hold, ascending. Empty when
   * GitHub already says everything the target graph does — which is what a
   * re-run after a partial failure, and the read-back of a completed one, both
   * look like.
   */
  edgeAdditions: ChainGraphEdge[];
  /**
   * Every Issue whose GitHub relationships this edit touches, ascending — the
   * endpoints of every relationship the edit introduces plus the Issues being
   * linked, whose eligibility must not survive an incomplete mutation even
   * when their edge already exists.
   *
   * Deliberately wider than {@link ChainLinearApply.edgeAdditions}: a retry of
   * an edit that wrote its boundary edge and then failed observes that edge as
   * already present, so it has no addition naming the old head/root — yet the
   * interrupted run suspended it, and only an Issue in this set is restored
   * (issue #791 review). The set is what the edit LINKS, not what is left to
   * write.
   *
   * Deliberately not "every member of the chain": an Issue whose relationships
   * do not change cannot be made eligible by this edit, and suspending a
   * finished upstream member would strip labels the edit has no business
   * touching.
   */
  affectedIssues: number[];
}

/**
 * Refusals share `ChainSyncRefusal`'s shape and kinds with `chain sync` and
 * intake: the same graph refused through a different door is the same finding.
 */
export type ChainLinearRefusal = ChainSyncRefusal;

export type ChainLinearPlan = ChainLinearApply | ChainLinearRefusal;

/**
 * Where a linear command's refusals point. Unlike sync's GitHub -> registry
 * direction, these commands write BOTH sides, so the repair is a different
 * command rather than a different repository state.
 */
const LINEAR_DIRECTION =
  "Nothing was changed on GitHub or in the registry by this refusal. Inspect the chain with `admin chain show` " +
  "and the live relationships with `admin chain validate`, then re-run the command once the conflict is resolved.";

/** The one place #893 is named, so every advanced-operation hand-off reads alike. */
const ADVANCED_OPS =
  "Fork, merge, alias retirement, and general DAG topology edits are the advanced chain operations (issue #893); " +
  "the linear commands deliberately refuse them rather than guess at a topology the operator did not spell out.";

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function refusal(
  kind: ChainSyncRefusalKind,
  transient: boolean,
  message: string,
  remediation: string,
  detail?: Partial<Pick<ChainSyncRefusal, "diagnostics" | "providerErrors">>,
): ChainLinearRefusal {
  return {
    action: "refuse",
    kind,
    transient,
    message,
    remediation,
    diagnostics: detail?.diagnostics ?? [],
    violations: [],
    providerErrors: detail?.providerErrors ?? [],
  };
}

/**
 * Word #890 findings as a linear-edit refusal. Exported because the caller can
 * learn of them twice: from {@link planLinearChainEdit}, and again from
 * `acceptChainGraph` when a concurrent claim surfaces ownership the plan-time
 * read could not see. Both are the same finding and must read identically.
 */
export function structuralChainLinearRefusal(
  operation: ChainLinearOperation,
  diagnostics: readonly ChainGraphDiagnostic[],
): ChainLinearRefusal {
  const hints = diagnosticRemediationHints(diagnostics);
  return refusal(
    "structural",
    false,
    `\`chain ${operation}\` would not leave a valid chain graph (${plural(diagnostics.length, "finding")})`,
    hints.length === 0 ? LINEAR_DIRECTION : `${hints.join("; ")}. ${LINEAR_DIRECTION}`,
    { diagnostics: [...diagnostics] },
  );
}

/**
 * Word an Issue that another chain already owns as a linear-edit refusal.
 *
 * Split out from the generic structural refusal because it is the one the Issue
 * calls out by name: an operator who appends an Issue that already belongs
 * somewhere else is asking for a merge, and the answer is #893 rather than a
 * repair to the relationships. Exported for the same reason as
 * {@link structuralChainLinearRefusal} — the store can surface the same
 * ownership from inside its own write.
 */
export function ownedElsewhereChainLinearRefusal(
  operation: ChainLinearOperation,
  owners: readonly ChainOwnershipEntry[],
): ChainLinearRefusal {
  const sorted = [...owners].sort(
    (a, b) => a.issueNumber - b.issueNumber || (a.chainId < b.chainId ? -1 : a.chainId > b.chainId ? 1 : 0),
  );
  const rendered = sorted.map((o) => `#${o.issueNumber} (${o.chainId})`).join(", ");
  return refusal(
    "structural",
    false,
    `\`chain ${operation}\` names ${plural(sorted.length, "Issue")} that already belong to another chain: ${rendered}`,
    `Joining two registered chains is a merge, not a linear edit. ${ADVANCED_OPS} ${LINEAR_DIRECTION}`,
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

/**
 * Word GitHub relationships that the target graph does not account for.
 *
 * A linear edit only ever ADDS relationships, so anything else the observation
 * holds among the Issues it touches is state this command did not plan and must
 * not silently adopt into the accepted graph — it is either drift `chain sync`
 * should import first, a dependency on an Issue outside the chain, or another
 * operator editing the same Issues right now. The same wording serves the
 * pre-flight read and the read-back, because the finding is identical: GitHub
 * says something the plan does not.
 */
function unplannedEdgesRefusal(
  operation: ChainLinearOperation,
  edges: readonly ChainGraphEdge[],
  phase: "observed" | "read_back",
): ChainLinearRefusal {
  const rendered = edges.map((e) => `${e.blockerIssueNumber}->${e.blockedIssueNumber}`).join(", ");
  const message =
    phase === "observed"
      ? `GitHub already holds ${plural(edges.length, "relationship")} \`chain ${operation}\` does not account for: ${rendered}`
      : `GitHub gained ${plural(edges.length, "relationship")} while \`chain ${operation}\` was being applied: ${rendered}`;
  const remediation =
    phase === "observed"
      ? "A linear edit only adds relationships, so it will not adopt one it did not plan. If the extra `blocked by` " +
        "edges are legitimate, either name the Issues they come from in the command so they become part of the line, " +
        "or import them into the chain with `admin chain sync`, and re-run; if they are not, remove them on GitHub. " +
        ADVANCED_OPS
      : "Another actor edited these Issue Relationships while the command ran, so the registry was NOT updated: it " +
        "still holds the graph from before this edit, and GitHub now holds something neither side planned. " +
        "Reconcile the two with `admin chain validate` before re-running.";
  return refusal("structural", false, message, `${remediation} ${LINEAR_DIRECTION}`);
}

/* -------------------------------------------------------------------------
 * Planning
 * ---------------------------------------------------------------------- */

function edgeKey(edge: ChainGraphEdge): string {
  return `${edge.blockerIssueNumber}->${edge.blockedIssueNumber}`;
}

function compareEdges(a: ChainGraphEdge, b: ChainGraphEdge): number {
  return a.blockerIssueNumber - b.blockerIssueNumber || a.blockedIssueNumber - b.blockedIssueNumber;
}

/** The edges linking `issues` into a straight line, in the given order. */
function linkEdges(issues: readonly number[]): ChainGraphEdge[] {
  const edges: ChainGraphEdge[] = [];
  for (let i = 1; i < issues.length; i += 1) {
    edges.push({ blockerIssueNumber: issues[i - 1], blockedIssueNumber: issues[i] });
  }
  return edges;
}

/**
 * The chain's root: the one member nothing in the chain blocks — the Issue that
 * lands first, and the only place a linear `prepend` can attach.
 *
 * A chain with several roots is a fan-in, and picking one of them would silently
 * make the operator's Issues an ancestor of part of the chain and not the rest.
 */
function resolveRoots(target: ChainLinearTarget): number[] {
  const blocked = new Set(target.edges.map((e) => e.blockedIssueNumber));
  return target.members
    .map((m) => m.issueNumber)
    .filter((issueNumber) => !blocked.has(issueNumber))
    .sort((a, b) => a - b);
}

/** One Issue in the target whose degree makes the chain something other than a line. */
interface ChainBranchPoint {
  issueNumber: number;
  /** `fork`: it blocks more than one Issue. `merge`: more than one Issue blocks it. */
  kind: "fork" | "merge";
  /** The other end of each edge, ascending. */
  others: number[];
}

/**
 * Where the target chain stops being a straight line.
 *
 * #890 accepts any DAG: a member blocking two Issues (a fork) and two members
 * blocking one (a merge) are both legitimate #788 topologies, and `chain sync`
 * imports them from GitHub whether or not a linear command could have drawn
 * them. So passing acceptance says nothing about linearity, and the degrees
 * have to be counted here — the head having no outgoing edge only proves the
 * head is a downstream end, not that it is the only one.
 */
function findBranchPoints(target: ChainLinearTarget): ChainBranchPoint[] {
  const seen = new Set<string>();
  const blocks = new Map<number, number[]>();
  const blockedBy = new Map<number, number[]>();
  for (const edge of target.edges as readonly ChainGraphEdge[]) {
    const key = edgeKey(edge);
    if (seen.has(key)) continue;
    seen.add(key);
    const out = blocks.get(edge.blockerIssueNumber) ?? [];
    out.push(edge.blockedIssueNumber);
    blocks.set(edge.blockerIssueNumber, out);
    const incoming = blockedBy.get(edge.blockedIssueNumber) ?? [];
    incoming.push(edge.blockerIssueNumber);
    blockedBy.set(edge.blockedIssueNumber, incoming);
  }
  const points: ChainBranchPoint[] = [];
  for (const [issueNumber, others] of blocks) {
    if (others.length > 1) {
      points.push({ issueNumber, kind: "fork", others: [...others].sort((a, b) => a - b) });
    }
  }
  for (const [issueNumber, others] of blockedBy) {
    if (others.length > 1) {
      points.push({ issueNumber, kind: "merge", others: [...others].sort((a, b) => a - b) });
    }
  }
  return points.sort((a, b) => a.issueNumber - b.issueNumber || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
}

/**
 * Word a branched target as a linear-edit refusal.
 *
 * Extending a branch through a linear command would grow a topology the command
 * cannot express and the operator did not spell out: `append` would hang the new
 * Issues off one arm of a fork, `prepend` would make them an ancestor of every
 * arm at once. Both are DAG edits, so both are #893.
 */
function branchedTargetRefusal(
  operation: ChainLinearOperation,
  chainId: string,
  points: readonly ChainBranchPoint[],
): ChainLinearRefusal {
  const rendered = points
    .map((p) =>
      p.kind === "fork"
        ? `#${p.issueNumber} blocks ${p.others.map((n) => `#${n}`).join(", ")}`
        : `#${p.issueNumber} is blocked by ${p.others.map((n) => `#${n}`).join(", ")}`,
    )
    .join("; ");
  return refusal(
    "structural",
    false,
    `chain ${chainId} is not a straight line (${rendered}), so \`chain ${operation}\` cannot extend it`,
    `The linear commands extend a chain that runs in one line; a fork or a merge already in the chain has no single ` +
      `end to extend, and attaching to one arm of it is a topology edit. ${ADVANCED_OPS} ${LINEAR_DIRECTION}`,
  );
}

/**
 * Decide how one linear command should change GitHub and the registry.
 *
 * A verdict of `apply` is not a promise the write will land: ownership and the
 * chain's row revision are re-decided inside the store's transaction by
 * `acceptChainGraph`, and the frozen prefixes are re-read by its commit guard.
 * It is the statement that nothing observable from here refuses the edit.
 *
 * The checks run in the order a refusal is cheapest to act on and the order
 * their findings stay meaningful in: completeness of the observation, then
 * whether the chain on record is the accepted one, then ownership, then the
 * shape of the request, then #890's rules over the resulting graph, then what
 * GitHub already holds against what the chain already records, and last #891's
 * frozen prefixes. The frozen-prefix check is also the one a caller may take over with
 * {@link ChainLinearPlanInput.skipFrozenPrefixes}: the authoritative evaluation
 * happens after automation is suspended (and again inside the transaction that
 * moves the accepted pointer), because a task starting between the plan's read
 * and the suspension would otherwise freeze a prefix this plan never saw.
 */
export function planLinearChainEdit(input: ChainLinearPlanInput): ChainLinearPlan {
  const { operation } = input;

  // 1. Completeness, for the same reason as `planChainSync`: a half-read
  //    observation is not a smaller graph, it is no graph. Judging it would let
  //    a provider hiccup look like a missing relationship this command should
  //    create — and creating it is a write, not a refusal.
  if (input.providerErrors.length > 0) {
    const issues = [...input.providerErrors].map((e) => e.issueNumber).sort((a, b) => a - b);
    return refusal(
      "provider_error",
      true,
      `could not read the GitHub relationships for ${plural(issues.length, "Issue")} ` +
        `(${issues.map((n) => `#${n}`).join(", ")}); \`chain ${operation}\` was not applied`,
      "Transient or access failure, not a graph problem: nothing was changed on GitHub or in the registry. Re-run " +
        "the command once the Issues are readable.",
      { providerErrors: [...input.providerErrors] },
    );
  }

  const linked = [...input.issueNumbers];
  if (linked.length === 0) {
    return refusal(
      "structural",
      false,
      `\`chain ${operation}\` needs at least one Issue`,
      `Name the Issues to link, in dependency order. ${LINEAR_DIRECTION}`,
    );
  }

  const target = input.target;
  if (operation !== "new" && target === undefined) {
    return refusal(
      "structural",
      false,
      `\`chain ${operation}\` needs a registered chain to extend`,
      `Create one first with \`admin chain new\`. ${LINEAR_DIRECTION}`,
    );
  }

  // 2. The chain on record must be the one that was accepted. `getChain`
  //    returns whatever graph is persisted, and that can be a candidate #890
  //    never accepted — extending it would build on a graph nobody approved,
  //    and worse, its unaccepted edges would be created on GitHub as part of
  //    "the edges the observation is missing". Refusing here is what keeps the
  //    command from repairing GitHub out of local state.
  if (target !== undefined && target.acceptedRevision !== target.graphRevision) {
    return refusal(
      "structural",
      false,
      `chain ${target.chainId} holds revision ${target.graphRevision} but has accepted ` +
        `${target.acceptedRevision === undefined ? "none" : target.acceptedRevision}`,
      "A linear edit extends the chain's last accepted graph, never an unaccepted candidate. Reconcile the chain " +
        `first — \`admin chain validate ${target.chainId}\`, then \`admin chain sync ${target.chainId} --yes\` — and ` +
        `re-run. ${LINEAR_DIRECTION}`,
    );
  }

  // 3. Ownership by another chain, before anything else about the graph. The
  //    same Issues would also fail #890's `duplicate_ownership` rule, but the
  //    answer an operator needs here is not "repair the graph" — it is "this is
  //    a merge, and merges are #893".
  const foreign = input.ownership.filter((entry) => entry.chainId !== target?.chainId);
  if (foreign.length > 0) {
    return ownedElsewhereChainLinearRefusal(operation, foreign);
  }

  // 4. The shape of the request against the chain on record.
  let headIssueNumber: number;
  let members: ChainMemberInput[];
  let edges: ChainEdgeInput[];
  /**
   * The relationships this edit introduces — the run through the new Issues
   * plus, for an extension, the one edge that attaches it to the chain. Tracked
   * apart from {@link edges} (which carries the chain's existing edges through
   * unchanged) because it is what decides the suspension scope, and unlike the
   * additions below it does not shrink when a retry finds an edge already
   * written.
   */
  let linkage: ChainEdgeInput[];

  if (target === undefined) {
    // A `new` chain is exactly the Issues named, linked in order, with the last
    // as the head: the head is a chain's downstream end, and the last Issue in
    // `a,b,c` is the one everything else has to land before.
    headIssueNumber = linked[linked.length - 1];
    members = linked.map((issueNumber) => ({
      issueNumber,
      role: issueNumber === headIssueNumber ? ("head" as const) : ("node" as const),
    }));
    linkage = linkEdges(linked);
    edges = linkage;
  } else {
    const known = new Set(target.members.map((m) => m.issueNumber));
    const already = linked.filter((issueNumber) => known.has(issueNumber));
    if (already.length > 0) {
      return refusal(
        "structural",
        false,
        `\`chain ${operation}\` names ${plural(already.length, "Issue")} already in ${target.chainId}: ` +
          already.map((n) => `#${n}`).join(", "),
        `Moving an Issue that is already a member is a reorder, not a linear extension. ${ADVANCED_OPS} ${LINEAR_DIRECTION}`,
      );
    }

    if (operation === "append") {
      // The chain being extended has to be a line before its downstream end
      // means anything. Checked BEFORE the head, and before the appended graph
      // is constructed: a branched chain can perfectly well have a head with no
      // outgoing edge (`1->2, 1->3, 2->4, 3->4` with head #4), and appending to
      // it would extend a fork the linear commands never claimed to handle.
      const branches = findBranchPoints(target);
      if (branches.length > 0) {
        return branchedTargetRefusal(operation, target.chainId, branches);
      }

      // Degrees alone do not make a line. A chain whose members fall into two
      // disconnected runs (`20->21` and `22->23`) has no fork, no merge, and a
      // head that blocks nothing, yet appending to it would extend one run and
      // leave the other dangling. `prepend` counts roots because it needs one
      // place to attach; `append` counts them because a line has one start.
      const appendRoots = resolveRoots(target);
      if (appendRoots.length !== 1) {
        return refusal(
          "structural",
          false,
          appendRoots.length === 0
            ? `chain ${target.chainId} has no Issue that starts it, so it is not a line`
            : `chain ${target.chainId} runs in ${plural(appendRoots.length, "separate line")} ` +
              `(starting at ${appendRoots.map((n) => `#${n}`).join(", ")})`,
          `\`chain append\` extends the one line a chain runs in. ${ADVANCED_OPS} ${LINEAR_DIRECTION}`,
        );
      }

      // Append extends past the head, so the head has to actually be the
      // chain's downstream end. A head that already blocks something is a chain
      // whose head is mid-graph — appending there would insert the new Issues
      // into the middle of an existing dependency path, which is a topology
      // edit rather than an extension.
      //
      // Judged against GitHub as well as the registry, not the registry alone.
      // An outgoing relationship to an Issue no chain has registered is absent
      // from `target.edges` by definition, and it is invisible to a read of the
      // members' `blocked by` sets — so a head that blocks #99 would pass a
      // registry-only check and the append would leave a live fork behind
      // (issue #791 review). Edges into the Issues being linked are excluded:
      // those are this edit's own, already written by an interrupted run, and a
      // retry must be able to finish rather than refuse itself. Anything else
      // the observation holds and the target graph does not is still refused by
      // the unplanned-edge check below; this one exists to name the finding as
      // what it is.
      const linkedSet = new Set(linked);
      const headBlocks = [
        ...target.edges.filter((e) => e.blockerIssueNumber === target.headIssueNumber),
        ...input.observedEdges.filter(
          (e) => e.blockerIssueNumber === target.headIssueNumber && !linkedSet.has(e.blockedIssueNumber),
        ),
      ];
      const blockedByHead = [...new Set(headBlocks.map((e) => e.blockedIssueNumber))].sort((a, b) => a - b);
      if (blockedByHead.length > 0) {
        const rendered = blockedByHead.map((n) => `#${n}`).join(", ");
        return refusal(
          "structural",
          false,
          `chain ${target.chainId}'s head #${target.headIssueNumber} already blocks ${rendered}, so it is not the ` +
            "chain's downstream end",
          `\`chain append\` extends past the head; inserting into the middle of a dependency path is a topology ` +
            `edit. ${ADVANCED_OPS} ${LINEAR_DIRECTION}`,
        );
      }
      headIssueNumber = linked[linked.length - 1];
      members = [
        // The old head keeps its membership and loses its role: #890 admits
        // exactly one head, and it must be the head the graph declares.
        ...target.members.map((m) => ({ issueNumber: m.issueNumber, role: "node" as const })),
        ...linked.map((issueNumber) => ({
          issueNumber,
          role: issueNumber === headIssueNumber ? ("head" as const) : ("node" as const),
        })),
      ];
      linkage = [
        { blockerIssueNumber: target.headIssueNumber, blockedIssueNumber: linked[0] },
        ...linkEdges(linked),
      ];
      edges = [...target.edges.map((e) => ({ ...e })), ...linkage];
    } else {
      const roots = resolveRoots(target);
      if (roots.length !== 1) {
        return refusal(
          "structural",
          false,
          roots.length === 0
            ? `chain ${target.chainId} has no root to prepend to`
            : `chain ${target.chainId} has ${plural(roots.length, "root")} (${roots.map((n) => `#${n}`).join(", ")}), ` +
              "so there is no single place to prepend",
          `\`chain prepend\` attaches ahead of the one Issue the chain starts with. ${ADVANCED_OPS} ${LINEAR_DIRECTION}`,
        );
      }
      // Same linearity requirement as `append`, checked after the root count
      // because "there is nowhere to attach" is the more specific finding when
      // both apply — a chain with several roots is refused as such rather than
      // as a merge somewhere below them. A single-rooted chain can still branch
      // further down (`1->2, 1->3, 2->4, 3->4`), and prepending to its root
      // would make the new Issues an ancestor of every arm at once.
      const branches = findBranchPoints(target);
      if (branches.length > 0) {
        return branchedTargetRefusal(operation, target.chainId, branches);
      }
      // Prepend leaves the head where it is: the chain's downstream end does
      // not move when ancestors are added above its root.
      headIssueNumber = target.headIssueNumber;
      members = [
        ...target.members.map((m) => ({
          issueNumber: m.issueNumber,
          role: m.issueNumber === headIssueNumber ? ("head" as const) : ("node" as const),
        })),
        ...linked.map((issueNumber) => ({ issueNumber, role: "node" as const })),
      ];
      linkage = [
        ...linkEdges(linked),
        { blockerIssueNumber: linked[linked.length - 1], blockedIssueNumber: roots[0] },
      ];
      edges = [...target.edges.map((e) => ({ ...e })), ...linkage];
    }
  }

  // 5. #890's rules over the resulting graph, ownership included. Everything
  //    above is about the request; this is about what the request produces.
  const validation = validateChainGraph(
    {
      ...(target === undefined ? {} : { chainId: target.chainId }),
      headIssueNumber,
      members,
      edges,
    },
    { ownership: input.ownership },
  );
  if (!validation.ok) {
    return structuralChainLinearRefusal(operation, validation.diagnostics);
  }

  // 6. What GitHub already holds. The plan's additions are the target edges the
  //    observation is missing; anything the observation holds that the target
  //    graph does not is unplanned state this command refuses to adopt.
  const targetEdgeKeys = new Set(edges.map((e) => edgeKey(e as ChainGraphEdge)));
  const observedKeys = new Set<string>();
  const unplanned: ChainGraphEdge[] = [];
  for (const edge of input.observedEdges) {
    const key = edgeKey(edge);
    if (observedKeys.has(key)) continue;
    observedKeys.add(key);
    if (!targetEdgeKeys.has(key)) unplanned.push(edge);
  }
  if (unplanned.length > 0) {
    return unplannedEdgesRefusal(operation, [...unplanned].sort(compareEdges), "observed");
  }

  // 7. The edges the chain ALREADY records must be the ones GitHub holds. They
  //    are carried into the target graph verbatim, so without this check a
  //    dependency that exists only in SQLite would be indistinguishable from
  //    one this command is introducing — and step 4 would create it on GitHub.
  //    That is the optimistic repair from stale local state the whole sequence
  //    exists to prevent: a relationship an operator deliberately removed would
  //    come back as a side effect of appending something unrelated.
  const observedScope = new Set(input.observedIssues);
  if (target !== undefined) {
    const missingCarried = (target.edges as readonly ChainGraphEdge[])
      .filter((e) => observedScope.has(e.blockedIssueNumber) && !observedKeys.has(edgeKey(e)))
      .sort(compareEdges);
    if (missingCarried.length > 0) {
      const rendered = missingCarried.map((e) => `${e.blockerIssueNumber}->${e.blockedIssueNumber}`).join(", ");
      return refusal(
        "structural",
        false,
        `chain ${target.chainId} records ${plural(missingCarried.length, "relationship")} GitHub does not hold: ${rendered}`,
        "The chain's accepted graph and the live relationships disagree, and a linear edit will not re-create the " +
          "missing ones from local state — an edge somebody removed on purpose must not come back as a side effect " +
          "of an unrelated extension. Reconcile them first (`admin chain validate`, then `admin chain sync --yes` to " +
          `adopt what GitHub says) and re-run. ${LINEAR_DIRECTION}`,
      );
    }
  }

  // An edge the observation could not have seen is not an addition this command
  // can claim to have verified, so the plan only proposes edges whose blocked
  // end was actually read.
  const edgeAdditions = (edges as readonly ChainGraphEdge[])
    .filter((e) => !observedKeys.has(edgeKey(e)) && observedScope.has(e.blockedIssueNumber))
    .sort(compareEdges);

  // 8. #891's frozen prefixes, unless the caller is taking the check over. A
  //    started Issue's pinned ancestry outranks any edit: appending below it is
  //    fine, prepending above it is not.
  if (input.skipFrozenPrefixes !== true) {
    const frozen = checkFrozenPrefixes({
      candidate: { members, edges } satisfies ChainGraphSnapshot,
      snapshots: input.frozenSnapshots,
      ...(target === undefined ? {} : { chainId: target.chainId }),
    });
    if (!frozen.ok) return frozenPrefixRefusal(frozen);
  }

  // The suspension scope is taken from the linkage, not from the additions: an
  // append or prepend whose boundary edge landed before the run failed leaves
  // nothing to add for the old head/root, and scoping to the additions would
  // drop the very Issue the interrupted run suspended — the retry would then
  // succeed and leave it ineligible forever (issue #791 review). Every addition
  // is a linkage edge (step 7 refuses a carried edge GitHub does not hold), so
  // this is a superset in every case.
  const affected = new Set<number>(linked);
  for (const edge of linkage) {
    affected.add(edge.blockerIssueNumber);
    affected.add(edge.blockedIssueNumber);
  }

  return {
    action: "apply",
    operation,
    ...(target === undefined ? {} : { chainId: target.chainId }),
    headIssueNumber,
    members,
    edges,
    canonical: validation.graph,
    edgeAdditions,
    affectedIssues: [...affected].sort((a, b) => a - b),
  };
}

/**
 * Judge a read-back of GitHub against the graph an edit just applied.
 *
 * Separate from {@link planLinearChainEdit} because it answers a different
 * question with the same data: the plan asks "may this edit be applied", the
 * read-back asks "did it land, and only it". A missing edge means a relationship
 * write reported success without taking effect; an extra one means another actor
 * edited the same Issues while the command ran. Either way the registry must not
 * be updated — the whole point of reading back is that the graph persisted is
 * one GitHub was observed to hold, never one SQLite merely expected.
 */
export function verifyLinearChainReadBack(input: {
  operation: ChainLinearOperation;
  /** The graph the edit set out to create. */
  edges: readonly ChainEdgeInput[];
  /**
   * Every relationship read back for {@link input.observedIssues}, in both
   * directions — see {@link ChainLinearPlanInput.observedEdges}. Reading only
   * the incoming direction here would let a concurrent editor attach something
   * downstream of the graph this edit just drew and have it recorded as clean.
   */
  observedEdges: readonly ChainGraphEdge[];
  observedIssues: readonly number[];
  providerErrors: readonly ChainSyncProviderError[];
}): { ok: true } | ChainLinearRefusal {
  if (input.providerErrors.length > 0) {
    const issues = [...input.providerErrors].map((e) => e.issueNumber).sort((a, b) => a - b);
    return refusal(
      "provider_error",
      true,
      `the relationships written for ${plural(issues.length, "Issue")} (${issues.map((n) => `#${n}`).join(", ")}) ` +
        "could not be read back, so the edit was not recorded in the registry",
      "The relationship writes may or may not have landed: nothing in the registry was changed, and a re-run " +
        "re-reads GitHub and applies only what is still missing. Verify with `admin chain validate` first if the " +
        "provider stays unreachable.",
      { providerErrors: [...input.providerErrors] },
    );
  }

  const scope = new Set(input.observedIssues);
  const observed = new Set(input.observedEdges.map(edgeKey));
  const expected = new Set(
    (input.edges as readonly ChainGraphEdge[]).filter((e) => scope.has(e.blockedIssueNumber)).map(edgeKey),
  );

  const missing = (input.edges as readonly ChainGraphEdge[])
    .filter((e) => scope.has(e.blockedIssueNumber) && !observed.has(edgeKey(e)))
    .sort(compareEdges);
  if (missing.length > 0) {
    const rendered = missing.map((e) => `${e.blockerIssueNumber}->${e.blockedIssueNumber}`).join(", ");
    return refusal(
      "structural",
      false,
      `GitHub does not hold ${plural(missing.length, "relationship")} this \`chain ${input.operation}\` wrote: ${rendered}`,
      "The relationship writes were reported as successful but the read-back does not show them, so the registry " +
        "was NOT updated from state nobody verified. Check the Issues on GitHub (a deleted or transferred Issue, or " +
        "a permission that allows the write but not the read) and re-run the command.",
    );
  }

  const extra = input.observedEdges.filter((e) => !expected.has(edgeKey(e))).sort(compareEdges);
  if (extra.length > 0) {
    const deduped: ChainGraphEdge[] = [];
    const seen = new Set<string>();
    for (const edge of extra) {
      const key = edgeKey(edge);
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(edge);
    }
    return unplannedEdgesRefusal(input.operation, deduped, "read_back");
  }

  return { ok: true };
}
