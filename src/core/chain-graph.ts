/**
 * Dependency-chain graph domain (issue #890): the rules that decide whether a
 * candidate dependency graph is well formed, plus the canonical form and
 * fingerprint every other layer compares against.
 *
 * Scope boundary. Issue #788 owns *storage*: stable chain IDs, the rows a
 * graph is written to, revision records, aliases, and the strictly referential
 * integrity a table can enforce on its own (an edge names members of its own
 * chain, the head is a member, nothing depends on itself). This module owns
 * everything that needs to look at the graph *as a graph* or at the registry
 * as a whole:
 *
 *   - cycles of any length, which no per-row constraint can see;
 *   - Issues an edge names that the candidate never declared as members;
 *   - one Issue claimed by two chains, which is a cross-chain fact;
 *   - identities that cannot be resolved — one Issue carrying two roles, two
 *     Issues claiming the head role, a declared head the roles disagree with.
 *
 * It owns none of the policy that *acts* on the verdict. Nothing here reads or
 * writes GitHub Issue Relationships, opens a database, parses a command line,
 * or consults the frozen-prefix rules of #891. A verdict is a value: admin
 * sync, intake, and topology editing each decide for themselves what to do
 * with the same one.
 *
 * Two properties everything downstream leans on:
 *
 *   - **Canonicity.** Graphs that express the same dependency structure
 *     fingerprint identically no matter what order they arrive in, so
 *     re-writing an unchanged graph is recognizable as a no-op rather than as
 *     a new revision.
 *   - **Determinism.** The diagnostics for a given candidate are always the
 *     same list in the same order. Operators diff them, tests pin them, and a
 *     validator whose output depended on input order would make both useless.
 */

import {
  canonicalChainGraphText,
  chainGraphFingerprint,
  isChainMemberRole,
  isValidChainId,
  isValidIssueNumber,
} from "./chain-registry.js";
import type { ChainEdgeInput, ChainMemberInput, ChainMemberRole } from "./chain-registry.js";

/* -------------------------------------------------------------------------
 * Domain types
 * ---------------------------------------------------------------------- */

/**
 * A dependency edge with both endpoints resolved: `blockedIssueNumber` depends
 * on `blockerIssueNumber`, so the blocker must land first. Fan-out is several
 * edges sharing a blocker, fan-in several edges sharing a blocked Issue; both
 * are ordinary shapes here, and neither is treated as an error.
 */
export interface ChainGraphEdge {
  blockerIssueNumber: number;
  blockedIssueNumber: number;
}

/** A member with its role resolved — the input default (`node`) applied. */
export interface ChainGraphMember {
  issueNumber: number;
  role: ChainMemberRole;
}

/**
 * A graph proposed as a chain's next accepted state.
 *
 * `chainId` is optional because the same validation serves intake, which has
 * no chain yet, and admin sync, which does. When it is supplied it is checked,
 * and it is the chain whose ownership of a member is *not* a duplicate.
 */
export interface ChainGraphCandidate {
  chainId?: string;
  headIssueNumber: number;
  members: readonly ChainMemberInput[];
  edges: readonly ChainEdgeInput[];
}

/**
 * A claim that `chainId` already contains `issueNumber`. The caller collects
 * these — from the registry, from a batch it is about to write, or from both —
 * because deciding what the registry currently holds is not this layer's job.
 */
export interface ChainOwnershipEntry {
  issueNumber: number;
  chainId: string;
}

export interface ChainGraphValidationOptions {
  /**
   * Existing membership to check the candidate against. Entries naming the
   * candidate's own `chainId` are the chain re-declaring its own members and
   * are ignored; every other entry makes the Issue doubly owned.
   */
  ownership?: readonly ChainOwnershipEntry[];
}

/**
 * Every way a candidate graph can be refused, and the two ways two graphs can
 * disagree. Declared as one closed list because it is also the diagnostic sort
 * order: a caller rendering a verdict sees identity problems before membership
 * problems, membership before edges, and whole-graph findings last.
 */
export const CHAIN_GRAPH_DIAGNOSTIC_CODES = [
  /** The candidate's chain handle is not a well-formed chain ID. */
  "invalid_chain_id",
  /** A chain with no members has no graph to accept. */
  "empty_members",
  /** A member or edge endpoint is not a positive integer. */
  "invalid_issue_number",
  /** A member carries a role outside the known vocabulary. */
  "invalid_role",
  /** The same Issue is listed as a member more than once. */
  "duplicate_member",
  /** The candidate names one Issue in two irreconcilable ways. */
  "ambiguous_identity",
  /** The declared head is not among the members. */
  "head_not_member",
  /** An edge names an Issue the candidate never declared a member. */
  "missing_member",
  /** An Issue is declared to depend on itself. */
  "self_edge",
  /** The same edge is supplied more than once. */
  "duplicate_edge",
  /** A set of Issues depends on itself transitively. */
  "cycle",
  /** A member already belongs to a different chain. */
  "duplicate_ownership",
  /** Two graphs disagree about which Issues are members, or about their roles. */
  "member_mismatch",
  /** Two graphs disagree about which edges exist. */
  "edge_mismatch",
] as const;

export type ChainGraphDiagnosticCode = (typeof CHAIN_GRAPH_DIAGNOSTIC_CODES)[number];

export function isChainGraphDiagnosticCode(value: unknown): value is ChainGraphDiagnosticCode {
  return (
    typeof value === "string" &&
    (CHAIN_GRAPH_DIAGNOSTIC_CODES as readonly string[]).includes(value)
  );
}

/**
 * One structured finding about a graph.
 *
 * `issues` is what an operator needs first — which Issues to go look at — and
 * carries only well-formed Issue numbers, ascending. A rejected value that is
 * not an Issue number at all appears in `message` instead, bounded, because a
 * candidate can be operator- or provider-supplied text.
 *
 * `observedEdges` is what the graph being judged actually contains;
 * `expectedEdges` is what the rule requires in its place. An empty
 * `expectedEdges` alongside a non-empty `observedEdges` means the repair is a
 * removal — the observed edges cannot stand as they are, and no particular
 * replacement is implied.
 */
export interface ChainGraphDiagnostic {
  code: ChainGraphDiagnosticCode;
  /** Every well-formed Issue number the finding implicates, ascending. */
  issues: number[];
  /** Edges the judged graph contains that this finding is about. */
  observedEdges: ChainGraphEdge[];
  /** Edges the rule requires instead. Empty when the repair is a removal. */
  expectedEdges: ChainGraphEdge[];
  /** Other chain handles the finding implicates, ascending. */
  chains: string[];
  /** Deterministic one-line summary, safe to log. */
  message: string;
}

/**
 * The normalized form of a graph that passed validation: members ascending by
 * Issue number with roles resolved, edges ascending by blocker then blocked,
 * and the fingerprint and canonical text those produce.
 *
 * `topologicalOrder` lists every member with its blockers before it, smallest
 * Issue number first among the ones that are ready. It exists only for valid
 * graphs, which is why it lives here and not on the candidate: a cyclic graph
 * has no such order, and a graph with a non-member endpoint has no defined
 * node set.
 */
export interface CanonicalChainGraph {
  chainId?: string;
  headIssueNumber: number;
  members: ChainGraphMember[];
  edges: ChainGraphEdge[];
  fingerprint: string;
  text: string;
  topologicalOrder: number[];
}

export type ChainGraphValidation =
  | { ok: true; graph: CanonicalChainGraph }
  | { ok: false; diagnostics: ChainGraphDiagnostic[] };

/* -------------------------------------------------------------------------
 * Rendering helpers
 * ---------------------------------------------------------------------- */

/** How many Issue numbers a diagnostic message spells out before eliding. */
export const MAX_DIAGNOSTIC_MESSAGE_ISSUES = 12;

/** Longest rendering of a rejected non-Issue value, in characters. */
export const MAX_DIAGNOSTIC_TOKEN_CHARS = 32;

/**
 * A bounded, deterministic rendering of a value that was rejected for not
 * being an Issue number or a role. Candidates can carry arbitrary
 * operator-supplied text, and a diagnostic ends up in logs, so nothing
 * unbounded is ever echoed back.
 */
function describeToken(value: unknown): string {
  if (typeof value === "string") {
    const clipped =
      value.length > MAX_DIAGNOSTIC_TOKEN_CHARS
        ? `${value.slice(0, MAX_DIAGNOSTIC_TOKEN_CHARS)}…`
        : value;
    return JSON.stringify(clipped);
  }
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return Object.prototype.toString.call(value);
}

function renderIssues(issues: readonly number[]): string {
  if (issues.length <= MAX_DIAGNOSTIC_MESSAGE_ISSUES) return issues.join(", ");
  const shown = issues.slice(0, MAX_DIAGNOSTIC_MESSAGE_ISSUES).join(", ");
  return `${shown}, … (${issues.length} total)`;
}

/** `12 -> 34`, the reading direction of {@link ChainGraphEdge}. */
export function formatChainGraphEdge(edge: ChainGraphEdge): string {
  return `${edge.blockerIssueNumber} -> ${edge.blockedIssueNumber}`;
}

/** `12 -> 34 -> 12`, the canonical rendering of a dependency cycle. */
function formatCyclePath(path: readonly number[]): string {
  return path.join(" -> ");
}

/* -------------------------------------------------------------------------
 * Ordering
 * ---------------------------------------------------------------------- */

const CODE_ORDER = new Map<ChainGraphDiagnosticCode, number>(
  CHAIN_GRAPH_DIAGNOSTIC_CODES.map(
    (code, index): [ChainGraphDiagnosticCode, number] => [code, index],
  ),
);

function compareNumbers(a: number, b: number): number {
  return a - b;
}

function compareEdges(a: ChainGraphEdge, b: ChainGraphEdge): number {
  return (
    a.blockerIssueNumber - b.blockerIssueNumber || a.blockedIssueNumber - b.blockedIssueNumber
  );
}

function compareLists<T>(a: readonly T[], b: readonly T[], compare: (x: T, y: T) => number): number {
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i += 1) {
    const ordering = compare(a[i]!, b[i]!);
    if (ordering !== 0) return ordering;
  }
  return a.length - b.length;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Total order over diagnostics, so a verdict is a value an operator can diff
 * and a test can pin. Codes come first in their declaration order, and within
 * a code the affected Issues decide — everything below that is a tiebreak that
 * only has to be consistent.
 */
function compareDiagnostics(a: ChainGraphDiagnostic, b: ChainGraphDiagnostic): number {
  return (
    (CODE_ORDER.get(a.code) ?? 0) - (CODE_ORDER.get(b.code) ?? 0) ||
    compareLists(a.issues, b.issues, compareNumbers) ||
    compareLists(a.chains, b.chains, compareStrings) ||
    compareLists(a.observedEdges, b.observedEdges, compareEdges) ||
    compareLists(a.expectedEdges, b.expectedEdges, compareEdges) ||
    compareStrings(a.message, b.message)
  );
}

function diagnostic(
  code: ChainGraphDiagnosticCode,
  message: string,
  parts?: {
    issues?: readonly number[];
    observedEdges?: readonly ChainGraphEdge[];
    expectedEdges?: readonly ChainGraphEdge[];
    chains?: readonly string[];
  },
): ChainGraphDiagnostic {
  return {
    code,
    issues: [...(parts?.issues ?? [])].sort(compareNumbers),
    observedEdges: [...(parts?.observedEdges ?? [])].sort(compareEdges),
    expectedEdges: [...(parts?.expectedEdges ?? [])].sort(compareEdges),
    chains: [...(parts?.chains ?? [])].sort(compareStrings),
    message,
  };
}

/* -------------------------------------------------------------------------
 * Graph algorithms
 * ---------------------------------------------------------------------- */

/**
 * Blocker -> blocked adjacency, every list ascending. The sort is not
 * cosmetic: it is what makes the traversals below produce the same components,
 * the same cycle paths, and the same topological order for a given graph
 * however its edges were supplied.
 */
function buildAdjacency(
  nodes: readonly number[],
  edges: readonly ChainGraphEdge[],
): Map<number, number[]> {
  const adjacency = new Map<number, number[]>();
  for (const node of nodes) adjacency.set(node, []);
  for (const edge of edges) {
    const list = adjacency.get(edge.blockerIssueNumber);
    if (list) list.push(edge.blockedIssueNumber);
  }
  for (const list of adjacency.values()) list.sort(compareNumbers);
  return adjacency;
}

/**
 * Tarjan's strongly connected components, iteratively.
 *
 * Iterative rather than recursive because a chain is a user-supplied graph and
 * a long linear chain would otherwise put its whole length on the JavaScript
 * call stack. Components come back with their members ascending, in the order
 * a traversal that visits nodes ascending discovers them.
 */
function stronglyConnectedComponents(
  nodes: readonly number[],
  adjacency: ReadonlyMap<number, readonly number[]>,
): number[][] {
  const index = new Map<number, number>();
  const lowLink = new Map<number, number>();
  const onStack = new Set<number>();
  const stack: number[] = [];
  const components: number[][] = [];
  let counter = 0;

  const open = (node: number): void => {
    index.set(node, counter);
    lowLink.set(node, counter);
    counter += 1;
    stack.push(node);
    onStack.add(node);
  };

  for (const root of nodes) {
    if (index.has(root)) continue;
    open(root);
    const frames: { node: number; next: number }[] = [{ node: root, next: 0 }];

    while (frames.length > 0) {
      const frame = frames[frames.length - 1]!;
      const neighbours = adjacency.get(frame.node) ?? [];

      if (frame.next < neighbours.length) {
        const neighbour = neighbours[frame.next]!;
        frame.next += 1;
        if (!index.has(neighbour)) {
          open(neighbour);
          frames.push({ node: neighbour, next: 0 });
        } else if (onStack.has(neighbour)) {
          lowLink.set(frame.node, Math.min(lowLink.get(frame.node)!, index.get(neighbour)!));
        }
        continue;
      }

      frames.pop();
      const parent = frames[frames.length - 1];
      if (parent) {
        lowLink.set(parent.node, Math.min(lowLink.get(parent.node)!, lowLink.get(frame.node)!));
      }
      if (lowLink.get(frame.node) === index.get(frame.node)) {
        const component: number[] = [];
        for (;;) {
          const popped = stack.pop()!;
          onStack.delete(popped);
          component.push(popped);
          if (popped === frame.node) break;
        }
        components.push(component.sort(compareNumbers));
      }
    }
  }

  return components;
}

/**
 * The shortest cycle through a component's smallest Issue, as a path that
 * starts and ends on it.
 *
 * A cyclic region can contain many simple cycles and enumerating them all is
 * exponential, so the diagnostic names one — but always the same one, chosen
 * by two tiebreaks that depend on nothing but the graph: start from the
 * smallest member, and among equally short paths prefer the one that visits
 * smaller Issues earlier (breadth-first over ascending adjacency).
 */
function canonicalCyclePath(
  component: readonly number[],
  adjacency: ReadonlyMap<number, readonly number[]>,
): number[] {
  const inComponent = new Set(component);
  const start = component[0]!;
  const parent = new Map<number, number>();
  const visited = new Set<number>([start]);
  const queue: number[] = [start];

  while (queue.length > 0) {
    const node = queue.shift()!;
    for (const neighbour of adjacency.get(node) ?? []) {
      if (!inComponent.has(neighbour)) continue;
      if (neighbour === start) {
        const back: number[] = [];
        for (let cursor: number | undefined = node; cursor !== undefined && cursor !== start; ) {
          back.push(cursor);
          cursor = parent.get(cursor);
        }
        return [start, ...back.reverse(), start];
      }
      if (visited.has(neighbour)) continue;
      visited.add(neighbour);
      parent.set(neighbour, node);
      queue.push(neighbour);
    }
  }

  // Unreachable for a component of two or more nodes: every such component is
  // strongly connected, so some path returns to `start`.
  return [start];
}

function insertAscending(sorted: number[], value: number): void {
  let position = sorted.length;
  while (position > 0 && sorted[position - 1]! > value) position -= 1;
  sorted.splice(position, 0, value);
}

/**
 * Every member with its blockers before it, or `undefined` when no such order
 * exists because the graph is cyclic.
 *
 * Kahn's algorithm, always taking the smallest ready Issue, so a graph with
 * several valid orders — anything with fan-out — still has exactly one
 * canonical one. Callers rendering a chain, planning execution, or diffing two
 * orderings all need that stability.
 */
export function chainGraphTopologicalOrder(
  members: readonly number[],
  edges: readonly ChainGraphEdge[],
): number[] | undefined {
  const nodes = [...members].sort(compareNumbers);
  const adjacency = buildAdjacency(nodes, edges);
  const indegree = new Map<number, number>();
  for (const node of nodes) indegree.set(node, 0);
  for (const edge of edges) {
    if (!indegree.has(edge.blockedIssueNumber)) continue;
    indegree.set(edge.blockedIssueNumber, indegree.get(edge.blockedIssueNumber)! + 1);
  }

  const ready = nodes.filter((node) => indegree.get(node) === 0);
  const order: number[] = [];
  while (ready.length > 0) {
    const node = ready.shift()!;
    order.push(node);
    for (const neighbour of adjacency.get(node) ?? []) {
      const remaining = indegree.get(neighbour)! - 1;
      indegree.set(neighbour, remaining);
      if (remaining === 0) insertAscending(ready, neighbour);
    }
  }

  return order.length === nodes.length ? order : undefined;
}

/* -------------------------------------------------------------------------
 * Validation
 * ---------------------------------------------------------------------- */

interface MemberScan {
  /**
   * The role each well-formed member was declared with, the first declaration
   * winning where a member repeats. Which one wins only matters for a member
   * whose declarations disagree, and such a member is refused anyway.
   */
  roles: Map<number, ChainMemberRole>;
  /**
   * Members that unambiguously claim the head role, ascending. A member whose
   * declarations disagree is excluded: which role it "really" carries would
   * otherwise depend on the order the candidate happened to arrive in, and the
   * verdict on a candidate must not.
   */
  headRoleIssues: number[];
  diagnostics: ChainGraphDiagnostic[];
}

function scanMembers(members: readonly ChainMemberInput[]): MemberScan {
  const roles = new Map<number, ChainMemberRole>();
  const diagnostics: ChainGraphDiagnostic[] = [];
  const invalidNumbers = new Set<string>();
  const invalidRoles = new Map<number, Set<string>>();
  const duplicates = new Set<number>();
  const conflictingRoles = new Set<number>();
  const headRoles = new Set<number>();

  for (const member of members) {
    if (!isValidIssueNumber(member.issueNumber)) {
      invalidNumbers.add(describeToken(member.issueNumber));
      continue;
    }
    if (member.role !== undefined && !isChainMemberRole(member.role)) {
      let tokens = invalidRoles.get(member.issueNumber);
      if (!tokens) {
        tokens = new Set<string>();
        invalidRoles.set(member.issueNumber, tokens);
      }
      tokens.add(describeToken(member.role));
      continue;
    }
    const role: ChainMemberRole = member.role ?? "node";
    const existing = roles.get(member.issueNumber);
    if (existing !== undefined) {
      // A repeat that agrees is redundancy; a repeat that disagrees is an
      // identity the candidate cannot resolve. Both are refusals, but only the
      // second one leaves a caller with no defensible way to pick a winner.
      if (existing === role) duplicates.add(member.issueNumber);
      else conflictingRoles.add(member.issueNumber);
      continue;
    }
    roles.set(member.issueNumber, role);
    if (role === "head") headRoles.add(member.issueNumber);
  }

  for (const token of [...invalidNumbers].sort(compareStrings)) {
    diagnostics.push(
      diagnostic("invalid_issue_number", `member issue number is not a positive integer: ${token}`),
    );
  }
  for (const issueNumber of [...invalidRoles.keys()].sort(compareNumbers)) {
    for (const token of [...invalidRoles.get(issueNumber)!].sort(compareStrings)) {
      diagnostics.push(
        diagnostic("invalid_role", `issue ${issueNumber} carries an unknown member role: ${token}`, {
          issues: [issueNumber],
        }),
      );
    }
  }
  for (const issueNumber of [...duplicates].sort(compareNumbers)) {
    diagnostics.push(
      diagnostic("duplicate_member", `issue ${issueNumber} is listed as a member more than once`, {
        issues: [issueNumber],
      }),
    );
  }
  for (const issueNumber of [...conflictingRoles].sort(compareNumbers)) {
    diagnostics.push(
      diagnostic("ambiguous_identity", `issue ${issueNumber} is listed with conflicting roles`, {
        issues: [issueNumber],
      }),
    );
  }
  const headRoleIssues = [...headRoles]
    .filter((issueNumber) => !conflictingRoles.has(issueNumber))
    .sort(compareNumbers);
  if (headRoleIssues.length > 1) {
    diagnostics.push(
      diagnostic(
        "ambiguous_identity",
        `issues ${renderIssues(headRoleIssues)} all claim the head role`,
        { issues: headRoleIssues },
      ),
    );
  }

  return { roles, headRoleIssues, diagnostics };
}

interface EdgeScan {
  /** Well-formed, de-duplicated edges between declared members. */
  edges: ChainGraphEdge[];
  diagnostics: ChainGraphDiagnostic[];
}

function scanEdges(
  edges: readonly ChainEdgeInput[],
  members: ReadonlyMap<number, ChainMemberRole>,
): EdgeScan {
  const diagnostics: ChainGraphDiagnostic[] = [];
  const accepted: ChainGraphEdge[] = [];
  const seen = new Set<string>();
  const invalidNumbers = new Set<string>();
  const missing = new Map<number, Map<string, ChainGraphEdge>>();
  const selfEdges = new Set<number>();
  const duplicated = new Map<string, { edge: ChainGraphEdge; count: number }>();

  for (const edge of edges) {
    const blocker = edge.blockerIssueNumber;
    const blocked = edge.blockedIssueNumber;
    const wellFormed = isValidIssueNumber(blocker) && isValidIssueNumber(blocked);
    let usable = true;

    for (const endpoint of [blocker, blocked]) {
      if (!isValidIssueNumber(endpoint)) {
        invalidNumbers.add(describeToken(endpoint));
        usable = false;
      } else if (!members.has(endpoint)) {
        usable = false;
        let byKey = missing.get(endpoint);
        if (!byKey) {
          byKey = new Map<string, ChainGraphEdge>();
          missing.set(endpoint, byKey);
        }
        // Record the edges that name the non-member, not just the Issue: the
        // repair is a choice between declaring the member and dropping these
        // specific edges, and an operator cannot make it without seeing them.
        // An edge whose other endpoint is not an Issue number at all cannot be
        // rendered, and `invalid_issue_number` already carries that detail.
        if (wellFormed) {
          byKey.set(`${blocker}->${blocked}`, {
            blockerIssueNumber: blocker,
            blockedIssueNumber: blocked,
          });
        }
      }
    }
    if (!usable) continue;

    if (blocker === blocked) {
      selfEdges.add(blocker);
      continue;
    }
    const key = `${blocker}->${blocked}`;
    if (seen.has(key)) {
      const previous = duplicated.get(key);
      if (previous) previous.count += 1;
      else {
        duplicated.set(key, {
          edge: { blockerIssueNumber: blocker, blockedIssueNumber: blocked },
          count: 2,
        });
      }
      continue;
    }
    seen.add(key);
    accepted.push({ blockerIssueNumber: blocker, blockedIssueNumber: blocked });
  }

  for (const token of [...invalidNumbers].sort(compareStrings)) {
    diagnostics.push(
      diagnostic("invalid_issue_number", `edge endpoint is not a positive integer: ${token}`),
    );
  }
  for (const issueNumber of [...missing.keys()].sort(compareNumbers)) {
    const observed = [...missing.get(issueNumber)!.values()];
    const named = observed.length > 0 ? `${observed.length} edge(s)` : "a malformed edge";
    diagnostics.push(
      diagnostic(
        "missing_member",
        `issue ${issueNumber} is named by ${named} but is not a member`,
        { issues: [issueNumber], observedEdges: observed },
      ),
    );
  }
  for (const issueNumber of [...selfEdges].sort(compareNumbers)) {
    diagnostics.push(
      diagnostic("self_edge", `issue ${issueNumber} is declared to depend on itself`, {
        issues: [issueNumber],
        observedEdges: [{ blockerIssueNumber: issueNumber, blockedIssueNumber: issueNumber }],
      }),
    );
  }
  for (const key of [...duplicated.keys()].sort(compareStrings)) {
    const { edge, count } = duplicated.get(key)!;
    diagnostics.push(
      diagnostic(
        "duplicate_edge",
        `edge ${formatChainGraphEdge(edge)} is supplied ${count} times`,
        {
          issues: [edge.blockerIssueNumber, edge.blockedIssueNumber],
          observedEdges: Array.from({ length: count }, () => edge),
          expectedEdges: [edge],
        },
      ),
    );
  }

  return { edges: accepted, diagnostics };
}

function scanCycles(
  members: readonly number[],
  edges: readonly ChainGraphEdge[],
): ChainGraphDiagnostic[] {
  const adjacency = buildAdjacency(members, edges);
  const diagnostics: ChainGraphDiagnostic[] = [];

  for (const component of stronglyConnectedComponents(members, adjacency)) {
    // A single node is a component too; only a component of two or more can be
    // a cycle here, because self-edges never reach this far.
    if (component.length < 2) continue;
    const inComponent = new Set(component);
    const observed = edges.filter(
      (edge) => inComponent.has(edge.blockerIssueNumber) && inComponent.has(edge.blockedIssueNumber),
    );
    const path = canonicalCyclePath(component, adjacency);
    diagnostics.push(
      diagnostic(
        "cycle",
        `issues ${renderIssues(component)} depend on each other: ${formatCyclePath(path)}`,
        { issues: component, observedEdges: observed },
      ),
    );
  }

  return diagnostics;
}

function scanOwnership(
  members: ReadonlyMap<number, ChainMemberRole>,
  chainId: string | undefined,
  ownership: readonly ChainOwnershipEntry[],
): ChainGraphDiagnostic[] {
  const byChain = new Map<string, Set<number>>();
  for (const entry of ownership) {
    if (typeof entry.chainId !== "string" || entry.chainId.length === 0) continue;
    if (chainId !== undefined && entry.chainId === chainId) continue;
    if (!isValidIssueNumber(entry.issueNumber) || !members.has(entry.issueNumber)) continue;
    let issues = byChain.get(entry.chainId);
    if (!issues) {
      issues = new Set<number>();
      byChain.set(entry.chainId, issues);
    }
    issues.add(entry.issueNumber);
  }

  const diagnostics: ChainGraphDiagnostic[] = [];
  // Grouped by the chain that already owns them rather than per Issue: the
  // operator's next move is against that chain — release it, or merge the two —
  // and one finding per chain is what tells them how much of it is involved.
  for (const owner of [...byChain.keys()].sort(compareStrings)) {
    const issues = [...byChain.get(owner)!].sort(compareNumbers);
    diagnostics.push(
      diagnostic(
        "duplicate_ownership",
        `issues ${renderIssues(issues)} already belong to chain ${owner}`,
        { issues, chains: [owner] },
      ),
    );
  }
  return diagnostics;
}

/**
 * Judge a candidate graph. Every violation is reported, never just the first:
 * a caller repairing an operator- or provider-supplied graph should see the
 * whole list, and a caller refusing one gains nothing by stopping early.
 *
 * A valid graph comes back canonicalized, so the caller that is about to
 * persist it does not have to re-derive the fingerprint the decision was made
 * on.
 */
export function validateChainGraph(
  candidate: ChainGraphCandidate,
  options: ChainGraphValidationOptions = {},
): ChainGraphValidation {
  const diagnostics: ChainGraphDiagnostic[] = [];

  if (candidate.chainId !== undefined && !isValidChainId(candidate.chainId)) {
    diagnostics.push(
      diagnostic(
        "invalid_chain_id",
        `chain handle is not a well-formed chain id: ${describeToken(candidate.chainId)}`,
      ),
    );
  }

  const memberInputs = candidate.members ?? [];
  if (memberInputs.length === 0) {
    diagnostics.push(diagnostic("empty_members", "a chain must have at least one member"));
  }

  const memberScan = scanMembers(memberInputs);
  diagnostics.push(...memberScan.diagnostics);

  const head = candidate.headIssueNumber;
  if (!isValidIssueNumber(head)) {
    diagnostics.push(
      diagnostic(
        "invalid_issue_number",
        `head issue number is not a positive integer: ${describeToken(head)}`,
      ),
    );
  } else if (!memberScan.roles.has(head)) {
    diagnostics.push(
      diagnostic("head_not_member", `head issue ${head} is not a member of the chain`, {
        issues: [head],
      }),
    );
  } else {
    // Exactly one member may carry the head role, and it has to be the head the
    // candidate declares. #788 stores both without comparing them; deciding
    // whether they agree is this layer's job, and disagreement leaves the
    // chain's entry point genuinely undecidable. Members carrying no role at
    // all say nothing about the head, so silence is agreement.
    const [headRole] = memberScan.headRoleIssues;
    if (memberScan.headRoleIssues.length === 1 && headRole !== head) {
      diagnostics.push(
        diagnostic(
          "ambiguous_identity",
          `declared head ${head} does not carry the head role, which issue ${headRole} does`,
          { issues: [head, headRole!] },
        ),
      );
    }
  }

  const edgeScan = scanEdges(candidate.edges ?? [], memberScan.roles);
  diagnostics.push(...edgeScan.diagnostics);

  const memberNumbers = [...memberScan.roles.keys()].sort(compareNumbers);
  diagnostics.push(...scanCycles(memberNumbers, edgeScan.edges));
  diagnostics.push(...scanOwnership(memberScan.roles, candidate.chainId, options.ownership ?? []));

  if (diagnostics.length > 0) {
    return { ok: false, diagnostics: diagnostics.sort(compareDiagnostics) };
  }

  const members: ChainGraphMember[] = memberNumbers.map((issueNumber) => ({
    issueNumber,
    role: memberScan.roles.get(issueNumber)!,
  }));
  const edges = [...edgeScan.edges].sort(compareEdges);
  const order = chainGraphTopologicalOrder(memberNumbers, edges);

  return {
    ok: true,
    graph: {
      ...(candidate.chainId === undefined ? {} : { chainId: candidate.chainId }),
      headIssueNumber: head,
      members,
      edges,
      fingerprint: chainGraphFingerprint({ members, edges }),
      text: canonicalChainGraphText({ members, edges }),
      // A graph with no cycle diagnostics always has an order; the fallback is
      // only here so the type does not have to admit `undefined` downstream.
      topologicalOrder: order ?? memberNumbers,
    },
  };
}

/* -------------------------------------------------------------------------
 * Comparison
 * ---------------------------------------------------------------------- */

export interface ChainGraphSnapshot {
  members: readonly ChainMemberInput[];
  edges: readonly ChainEdgeInput[];
}

export interface ChainGraphComparison {
  /**
   * True when both graphs canonicalize to the same fingerprint and neither
   * side carried an entry that could not be read as one.
   */
  equivalent: boolean;
  /**
   * The fingerprint of the entries that could be read, so a side holding a
   * malformed entry still has a comparable value. It is not a claim that the
   * side is well formed — the diagnostics say that.
   */
  expectedFingerprint: string;
  observedFingerprint: string;
  /**
   * Empty when equivalent; otherwise the member and edge disagreements, plus
   * any entry either side supplied that a graph cannot represent.
   */
  diagnostics: ChainGraphDiagnostic[];
}

/** Which of the two graphs a snapshot finding is about. */
type SnapshotSide = "expected" | "observed";

interface SnapshotScan {
  roles: Map<number, ChainMemberRole>;
  edges: Map<string, ChainGraphEdge>;
  diagnostics: ChainGraphDiagnostic[];
}

/**
 * Read one side of a comparison into canonical maps, naming every entry that
 * cannot be carried across as it stands.
 *
 * A snapshot can be a provider read, so it can hold things a graph cannot: an
 * Issue number that is not one, a role outside the vocabulary, the same member
 * or edge twice. Normalizing those away in silence would let a malformed remote
 * graph compare equal to a well-formed persisted one — drift that matters,
 * reported as no drift at all. So an unreadable entry is left out of the maps,
 * a repeat keeps its first declaration, and either way the entry is named in a
 * diagnostic, which also denies the comparison its `equivalent` verdict.
 *
 * Every finding made here is about a single entry. Graph-level rules — cycles,
 * edges naming non-members, two Issues claiming the head — stay with
 * {@link validateChainGraph}: a comparison still judges neither side as a graph.
 */
function scanSnapshot(snapshot: ChainGraphSnapshot, side: SnapshotSide): SnapshotScan {
  const roles = new Map<number, ChainMemberRole>();
  const edges = new Map<string, ChainGraphEdge>();
  const diagnostics: ChainGraphDiagnostic[] = [];
  const invalidMemberNumbers = new Set<string>();
  const invalidRoles = new Map<number, Set<string>>();
  const duplicateMembers = new Set<number>();
  const conflictingRoles = new Set<number>();
  const invalidEdgeNumbers = new Set<string>();
  const duplicateEdges = new Map<string, { edge: ChainGraphEdge; count: number }>();

  for (const member of snapshot.members ?? []) {
    if (!isValidIssueNumber(member.issueNumber)) {
      invalidMemberNumbers.add(describeToken(member.issueNumber));
      continue;
    }
    if (member.role !== undefined && !isChainMemberRole(member.role)) {
      let tokens = invalidRoles.get(member.issueNumber);
      if (!tokens) {
        tokens = new Set<string>();
        invalidRoles.set(member.issueNumber, tokens);
      }
      tokens.add(describeToken(member.role));
      continue;
    }
    const role: ChainMemberRole = member.role ?? "node";
    const existing = roles.get(member.issueNumber);
    if (existing !== undefined) {
      if (existing === role) duplicateMembers.add(member.issueNumber);
      else conflictingRoles.add(member.issueNumber);
      continue;
    }
    roles.set(member.issueNumber, role);
  }

  for (const edge of snapshot.edges ?? []) {
    const blocker = edge.blockerIssueNumber;
    const blocked = edge.blockedIssueNumber;
    let usable = true;
    for (const endpoint of [blocker, blocked]) {
      if (!isValidIssueNumber(endpoint)) {
        invalidEdgeNumbers.add(describeToken(endpoint));
        usable = false;
      }
    }
    if (!usable) continue;

    const key = `${blocker}->${blocked}`;
    const existing = edges.get(key);
    if (existing) {
      const counted = duplicateEdges.get(key);
      if (counted) counted.count += 1;
      else duplicateEdges.set(key, { edge: existing, count: 2 });
      continue;
    }
    edges.set(key, { blockerIssueNumber: blocker, blockedIssueNumber: blocked });
  }

  for (const token of [...invalidMemberNumbers].sort(compareStrings)) {
    diagnostics.push(
      diagnostic(
        "invalid_issue_number",
        `${side} member issue number is not a positive integer: ${token}`,
      ),
    );
  }
  for (const token of [...invalidEdgeNumbers].sort(compareStrings)) {
    diagnostics.push(
      diagnostic("invalid_issue_number", `${side} edge endpoint is not a positive integer: ${token}`),
    );
  }
  for (const issueNumber of [...invalidRoles.keys()].sort(compareNumbers)) {
    for (const token of [...invalidRoles.get(issueNumber)!].sort(compareStrings)) {
      diagnostics.push(
        diagnostic(
          "invalid_role",
          `${side} member issue ${issueNumber} carries an unknown member role: ${token}`,
          { issues: [issueNumber] },
        ),
      );
    }
  }
  for (const issueNumber of [...duplicateMembers].sort(compareNumbers)) {
    diagnostics.push(
      diagnostic(
        "duplicate_member",
        `${side} graph lists issue ${issueNumber} as a member more than once`,
        { issues: [issueNumber] },
      ),
    );
  }
  for (const issueNumber of [...conflictingRoles].sort(compareNumbers)) {
    diagnostics.push(
      diagnostic(
        "ambiguous_identity",
        `${side} graph lists issue ${issueNumber} with conflicting roles`,
        { issues: [issueNumber] },
      ),
    );
  }
  for (const key of [...duplicateEdges.keys()].sort(compareStrings)) {
    const { edge, count } = duplicateEdges.get(key)!;
    diagnostics.push(
      diagnostic(
        "duplicate_edge",
        `${side} graph supplies edge ${formatChainGraphEdge(edge)} ${count} times`,
        {
          issues: [edge.blockerIssueNumber, edge.blockedIssueNumber],
          observedEdges: Array.from({ length: count }, () => edge),
          expectedEdges: [edge],
        },
      ),
    );
  }

  return { roles, edges, diagnostics };
}

/**
 * How an observed graph differs from the one that was expected — the shape
 * admin synchronization needs when it holds a persisted graph and a freshly
 * read one and has to say what moved.
 *
 * Deliberately not validation: neither side is judged *as a graph*, and a
 * difference is reported whether or not either graph is well formed — a cyclic
 * observed graph compares like any other. That separation is what lets the same
 * diagnostics describe a provider that drifted, an operator edit under review,
 * and a stale local mirror.
 *
 * What it does refuse to do is read an entry as something it is not. A snapshot
 * holding a duplicate member, a role outside the vocabulary, or a duplicate
 * edge is reported as such rather than quietly normalized into the graph it
 * resembles, because that normalization is exactly what would hide malformed
 * remote drift behind an `equivalent` verdict. See {@link scanSnapshot}.
 */
export function compareChainGraphs(
  expected: ChainGraphSnapshot,
  observed: ChainGraphSnapshot,
): ChainGraphComparison {
  const expectedScan = scanSnapshot(expected, "expected");
  const observedScan = scanSnapshot(observed, "observed");
  const expectedMembers = expectedScan.roles;
  const observedMembers = observedScan.roles;
  const expectedEdges = expectedScan.edges;
  const observedEdges = observedScan.edges;

  const diagnostics: ChainGraphDiagnostic[] = [
    ...expectedScan.diagnostics,
    ...observedScan.diagnostics,
  ];

  const memberIssues = new Set<number>([...expectedMembers.keys(), ...observedMembers.keys()]);
  const differing = [...memberIssues]
    .filter((issueNumber) => expectedMembers.get(issueNumber) !== observedMembers.get(issueNumber))
    .sort(compareNumbers);
  if (differing.length > 0) {
    diagnostics.push(
      diagnostic(
        "member_mismatch",
        `membership differs for issues ${renderIssues(differing)}`,
        { issues: differing },
      ),
    );
  }

  const onlyExpected = [...expectedEdges.entries()]
    .filter(([key]) => !observedEdges.has(key))
    .map(([, edge]) => edge);
  const onlyObserved = [...observedEdges.entries()]
    .filter(([key]) => !expectedEdges.has(key))
    .map(([, edge]) => edge);
  if (onlyExpected.length > 0 || onlyObserved.length > 0) {
    const issues = new Set<number>();
    for (const edge of [...onlyExpected, ...onlyObserved]) {
      issues.add(edge.blockerIssueNumber);
      issues.add(edge.blockedIssueNumber);
    }
    diagnostics.push(
      diagnostic(
        "edge_mismatch",
        `${onlyExpected.length} expected edge(s) absent, ${onlyObserved.length} unexpected edge(s) present`,
        {
          issues: [...issues],
          expectedEdges: onlyExpected,
          observedEdges: onlyObserved,
        },
      ),
    );
  }

  const expectedFingerprint = chainGraphFingerprint({
    members: [...expectedMembers.entries()].map(([issueNumber, role]) => ({ issueNumber, role })),
    edges: [...expectedEdges.values()],
  });
  const observedFingerprint = chainGraphFingerprint({
    members: [...observedMembers.entries()].map(([issueNumber, role]) => ({ issueNumber, role })),
    edges: [...observedEdges.values()],
  });

  return {
    equivalent: diagnostics.length === 0,
    expectedFingerprint,
    observedFingerprint,
    diagnostics: diagnostics.sort(compareDiagnostics),
  };
}
