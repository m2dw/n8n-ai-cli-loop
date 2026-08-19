/**
 * Frozen dependency prefixes (issue #891): what a started Issue's dependency
 * contract is pinned to, and the guard that refuses any later graph edit which
 * would move it.
 *
 * The problem this exists for. A task is created against a graph — the blockers
 * it will stack on, the order they land in, and the branch its work is cut
 * from. Every one of those is a decision the run has already acted on by the
 * time anyone edits the dependencies again: a branch exists, a base was
 * resolved, a predecessor contract was published. So from the moment a task
 * successfully starts, the part of the graph *at or above* it stops being
 * editable, while everything below it stays as editable as it ever was.
 *
 * What is frozen, per the contract:
 *
 *   - every direct and transitive blocker of the started Issue;
 *   - the edges between those blockers;
 *   - the incoming edges to the started Issue;
 *   - the resolved branch ancestry / base decision;
 *   - the accepted graph revision and fingerprint that decision was made on.
 *
 * The first four are what a candidate is judged against. The fifth is
 * provenance: it records *which* accepted state the freeze was taken from, and
 * is deliberately left out of {@link FrozenPrefixSnapshot.fingerprint} — see
 * {@link canonicalFrozenPrefixText}.
 *
 * Scope boundary. Issue #788 owns storage, #890 owns whether a candidate graph
 * is well formed and which revision is accepted. This module owns only the
 * frozen-prefix rules, and owns them as *values*: nothing here reads or writes
 * GitHub Issue Relationships, posts a comment, applies a label, opens a
 * database, or decides when a task counts as started. A verdict is returned;
 * what to do with it belongs to the caller — and the GitHub intake trigger that
 * will call {@link ChainPrefixFreezeStore.freezeChainPrefix} is a later Issue's.
 *
 * Determinism, for the same reason as `chain-graph.ts`: the violations for a
 * given candidate and a given set of snapshots are always the same list in the
 * same order, so operators can diff them and tests can pin them.
 */

import { createHash } from "crypto";

import {
  MAX_DIAGNOSTIC_MESSAGE_ISSUES,
  chainGraphTopologicalOrder,
  formatChainGraphEdge,
} from "./chain-graph.js";
import type { ChainGraphEdge, ChainGraphSnapshot } from "./chain-graph.js";
import { isValidChainId, isValidIssueNumber } from "./chain-registry.js";
import type { ChainRegistryResult } from "./chain-registry.js";
import type { AiTask, TaskEvent, TaskExpected, TaskKey, TaskPatch } from "./task.js";

/* -------------------------------------------------------------------------
 * Base decision
 * ---------------------------------------------------------------------- */

/**
 * How a started Issue's base was resolved.
 *
 *   - `default`  — the session's own base branch; the Issue stacks on nothing.
 *   - `stacked`  — a predecessor's branch, so the work sits on top of another
 *                  Issue's still-unmerged commits.
 */
export type ChainBaseKind = "default" | "stacked";

const CHAIN_BASE_KINDS: readonly ChainBaseKind[] = ["default", "stacked"];

/** Longest accepted base ref, in characters. */
export const MAX_CHAIN_BASE_REF_LENGTH = 255;

/** How much of a base ref a violation message spells out before eliding. */
export const MAX_BASE_REF_MESSAGE_CHARS = 64;

/**
 * The branch-ancestry decision a task was started with.
 *
 * Provider-neutral on purpose: it names a ref and, when the base is another
 * Issue's branch, that Issue. It deliberately does not carry a PR number, a
 * URL, or anything else only GitHub can supply — a base decision has to stay
 * comparable long after the PR it was derived from has moved on.
 */
export interface ChainBaseDecision {
  kind: ChainBaseKind;
  /** The ref the started Issue's work branch is cut from. */
  baseRef: string;
  /** The predecessor whose branch `baseRef` names, on a `stacked` decision. */
  baseIssueNumber?: number;
}

export function isChainBaseKind(value: unknown): value is ChainBaseKind {
  return typeof value === "string" && (CHAIN_BASE_KINDS as readonly string[]).includes(value);
}

/**
 * True for a base decision that can be frozen: a known kind, a bounded
 * non-empty ref, and a predecessor Issue exactly when the kind implies one.
 *
 * A `stacked` decision without the Issue it stacks on cannot be compared
 * against a later candidate — the whole point of freezing it — and a `default`
 * decision carrying one is naming a predecessor it does not actually sit on.
 */
export function isChainBaseDecision(value: unknown): value is ChainBaseDecision {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<ChainBaseDecision>;
  if (!isChainBaseKind(candidate.kind)) return false;
  if (
    typeof candidate.baseRef !== "string" ||
    candidate.baseRef.length === 0 ||
    candidate.baseRef.length > MAX_CHAIN_BASE_REF_LENGTH
  ) {
    return false;
  }
  if (candidate.kind === "stacked") return isValidIssueNumber(candidate.baseIssueNumber);
  return candidate.baseIssueNumber === undefined;
}

/** Two base decisions agree in every field that was frozen. */
export function chainBaseDecisionsEqual(a: ChainBaseDecision, b: ChainBaseDecision): boolean {
  return (
    a.kind === b.kind && a.baseRef === b.baseRef && a.baseIssueNumber === b.baseIssueNumber
  );
}

/**
 * Canonical one-line form of a base decision. The ref is JSON-quoted so a ref
 * containing the separator cannot make two different decisions render — and
 * therefore fingerprint — identically.
 */
export function canonicalChainBaseDecisionText(base: ChainBaseDecision): string {
  return `${base.kind} ${JSON.stringify(base.baseRef)} ${base.baseIssueNumber ?? "-"}`;
}

/* -------------------------------------------------------------------------
 * Ordering helpers
 * ---------------------------------------------------------------------- */

function compareNumbers(a: number, b: number): number {
  return a - b;
}

function compareEdges(a: ChainGraphEdge, b: ChainGraphEdge): number {
  return a.blockerIssueNumber - b.blockerIssueNumber || a.blockedIssueNumber - b.blockedIssueNumber;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function edgeKey(edge: ChainGraphEdge): string {
  return `${edge.blockerIssueNumber}->${edge.blockedIssueNumber}`;
}

function renderIssues(issues: readonly number[]): string {
  if (issues.length <= MAX_DIAGNOSTIC_MESSAGE_ISSUES) return issues.join(", ");
  const shown = issues.slice(0, MAX_DIAGNOSTIC_MESSAGE_ISSUES).join(", ");
  return `${shown}, … (${issues.length} total)`;
}

function renderEdges(edges: readonly ChainGraphEdge[]): string {
  const rendered = edges.map(formatChainGraphEdge);
  if (rendered.length <= MAX_DIAGNOSTIC_MESSAGE_ISSUES) return rendered.join(", ");
  const shown = rendered.slice(0, MAX_DIAGNOSTIC_MESSAGE_ISSUES).join(", ");
  return `${shown}, … (${rendered.length} total)`;
}

/**
 * Bounded rendering of a base decision for a message. A base ref is
 * operator-supplied text that ends up in logs, so it is clipped rather than
 * echoed at whatever length it arrived.
 */
function describeBase(base: ChainBaseDecision): string {
  const ref =
    base.baseRef.length > MAX_BASE_REF_MESSAGE_CHARS
      ? `${base.baseRef.slice(0, MAX_BASE_REF_MESSAGE_CHARS)}…`
      : base.baseRef;
  const suffix = base.baseIssueNumber === undefined ? "" : ` (issue ${base.baseIssueNumber})`;
  return `${base.kind} ${ref}${suffix}`;
}

/* -------------------------------------------------------------------------
 * Prefix computation
 * ---------------------------------------------------------------------- */

/**
 * The part of a graph that sits at or above one Issue.
 *
 * `ancestors` is the transitive blocker closure, `predecessors` the direct
 * blockers alone, and `edges` the union of "edges between ancestors" and
 * "incoming edges to the Issue" — exactly the two edge sets the contract
 * freezes, held in one canonical list because a guard has to diff them
 * together anyway.
 *
 * `order` is the canonical topological order over `ancestors` plus the Issue
 * itself, which is what makes a *reorder* visible as its own finding rather
 * than only as a pair of edge diffs.
 */
export interface ChainPrefix {
  issueNumber: number;
  /** Every direct and transitive blocker, ascending. */
  ancestors: number[];
  /** Direct blockers only, ascending — the published predecessor contract. */
  predecessors: number[];
  /** Edges among the ancestors plus the edges into the Issue, canonical order. */
  edges: ChainGraphEdge[];
  /**
   * `ancestors` and the Issue with every blocker before what it blocks. Empty
   * when the prefix admits no such order, which only a cyclic graph can
   * produce — and a cyclic graph is refused by `validateChainGraph` long
   * before it reaches a freeze.
   */
  order: number[];
}

/**
 * The prefix of `issueNumber` within `graph`.
 *
 * Only edges whose *both* endpoints are declared members are considered. That
 * is not a convenience: dropping an Issue from `members` while leaving the
 * edges that name it is a graph `validateChainGraph` refuses, and reading those
 * orphaned edges here would report the ancestry as unchanged for a candidate
 * that has quietly deleted an ancestor. Reading membership as authoritative
 * makes that deletion visible as the `ancestor_removed` it is.
 *
 * Malformed entries — an Issue number that is not one, a self-edge, a repeated
 * edge — are skipped, for the same reason: they cannot participate in an
 * ancestry, and #890 already reports them.
 */
export function computeChainPrefix(graph: ChainGraphSnapshot, issueNumber: number): ChainPrefix {
  const members = new Set<number>();
  for (const member of graph.members ?? []) {
    if (isValidIssueNumber(member.issueNumber)) members.add(member.issueNumber);
  }

  /** blocked -> its blockers, ascending. */
  const blockersOf = new Map<number, number[]>();
  const edges = new Map<string, ChainGraphEdge>();
  for (const edge of graph.edges ?? []) {
    const blocker = edge.blockerIssueNumber;
    const blocked = edge.blockedIssueNumber;
    if (!isValidIssueNumber(blocker) || !isValidIssueNumber(blocked)) continue;
    if (blocker === blocked) continue;
    if (!members.has(blocker) || !members.has(blocked)) continue;
    const key = `${blocker}->${blocked}`;
    if (edges.has(key)) continue;
    edges.set(key, { blockerIssueNumber: blocker, blockedIssueNumber: blocked });
    const list = blockersOf.get(blocked);
    if (list) list.push(blocker);
    else blockersOf.set(blocked, [blocker]);
  }
  for (const list of blockersOf.values()) list.sort(compareNumbers);

  // Breadth-first over blockers with a visited set, so a cyclic graph — which
  // this layer must survive rather than diagnose — terminates instead of
  // walking its cycle forever.
  const seen = new Set<number>([issueNumber]);
  const queue: number[] = [issueNumber];
  const ancestors = new Set<number>();
  while (queue.length > 0) {
    const node = queue.shift()!;
    for (const blocker of blockersOf.get(node) ?? []) {
      ancestors.add(blocker);
      if (seen.has(blocker)) continue;
      seen.add(blocker);
      queue.push(blocker);
    }
  }
  // A cycle through the Issue would otherwise make it its own ancestor.
  ancestors.delete(issueNumber);

  const prefixNodes = new Set<number>(ancestors);
  if (members.has(issueNumber)) prefixNodes.add(issueNumber);

  const prefixEdges = [...edges.values()]
    .filter(
      (edge) =>
        ancestors.has(edge.blockerIssueNumber) && prefixNodes.has(edge.blockedIssueNumber),
    )
    .sort(compareEdges);

  const nodes = [...prefixNodes].sort(compareNumbers);
  return {
    issueNumber,
    ancestors: [...ancestors].sort(compareNumbers),
    predecessors: [...(blockersOf.get(issueNumber) ?? [])].sort(compareNumbers),
    edges: prefixEdges,
    order: chainGraphTopologicalOrder(nodes, prefixEdges) ?? [],
  };
}

/* -------------------------------------------------------------------------
 * Snapshots
 * ---------------------------------------------------------------------- */

/** A frozen snapshot is identified by the task it was frozen for. */
export interface FrozenPrefixKey {
  sessionId: string;
  issueNumber: number;
}

/**
 * The dependency contract a started Issue is pinned to.
 *
 * Everything in {@link ChainPrefix} plus the chain it belongs to, the base
 * decision, and the accepted revision the decision was taken from.
 */
export interface FrozenPrefixSnapshot {
  sessionId: string;
  issueNumber: number;
  chainId: string;
  /** The accepted graph revision the freeze was taken from. */
  graphRevision: number;
  /** That revision's fingerprint. */
  graphFingerprint: string;
  ancestors: number[];
  predecessors: number[];
  edges: ChainGraphEdge[];
  order: number[];
  base: ChainBaseDecision;
  /**
   * `sha256:` over {@link canonicalFrozenPrefixText} — the identity of the
   * frozen *contract*, and therefore the key a repeated freeze is recognized
   * by.
   */
  fingerprint: string;
  /** Free-form provenance marker (`"intake"`, `"operator"`, ...). */
  source?: string;
  note?: string;
  frozenAt: string;
}

/**
 * The part of a snapshot that *is* the frozen contract — everything a later
 * candidate is judged against, and nothing about when or from what the freeze
 * was taken.
 */
export interface FrozenPrefixIdentity {
  issueNumber: number;
  chainId: string;
  ancestors: readonly number[];
  predecessors: readonly number[];
  edges: readonly ChainGraphEdge[];
  order: readonly number[];
  base: ChainBaseDecision;
}

/**
 * Canonical text form of a frozen contract: the Issue, its chain, and the four
 * things a later candidate is judged against.
 *
 * `graphRevision` and `graphFingerprint` are deliberately absent. They record
 * *when* the freeze was taken, not *what* it froze, and including them would
 * make a re-freeze after some unrelated downstream acceptance look like a
 * different contract — turning the one operation that must be idempotent into
 * a conflict. The provenance is still stored; it is simply not part of the
 * identity.
 */
export function canonicalFrozenPrefixText(snapshot: FrozenPrefixIdentity): string {
  const ancestors = [...snapshot.ancestors].sort(compareNumbers).join("\n");
  const predecessors = [...snapshot.predecessors].sort(compareNumbers).join("\n");
  const edges = [...snapshot.edges].sort(compareEdges).map(edgeKey).join("\n");
  // Not sorted: an order is a sequence, and sorting it would erase the very
  // difference a reorder consists of.
  const order = snapshot.order.join("\n");
  return (
    `issue\n${snapshot.issueNumber}\n` +
    `chain\n${snapshot.chainId}\n` +
    `ancestors\n${ancestors}\n` +
    `predecessors\n${predecessors}\n` +
    `edges\n${edges}\n` +
    `order\n${order}\n` +
    `base\n${canonicalChainBaseDecisionText(snapshot.base)}\n`
  );
}

/** Stable identity of a frozen contract: `sha256:<hex>`. */
export function frozenPrefixFingerprint(snapshot: FrozenPrefixIdentity): string {
  return `sha256:${createHash("sha256").update(canonicalFrozenPrefixText(snapshot)).digest("hex")}`;
}

export interface BuildFrozenPrefixInput {
  sessionId: string;
  issueNumber: number;
  chainId: string;
  /** The accepted graph the freeze is taken from. */
  graph: ChainGraphSnapshot;
  graphRevision: number;
  graphFingerprint: string;
  base: ChainBaseDecision;
  source?: string;
  note?: string;
  frozenAt: string;
}

/**
 * Derive the snapshot a freeze would record, without writing anything.
 *
 * Split from the write so a caller can compute the contract, show it, and
 * compare it against what is already on record — and so the guard and the
 * freeze provably derive the prefix the same way, from one function.
 */
export function buildFrozenPrefix(input: BuildFrozenPrefixInput): FrozenPrefixSnapshot {
  const prefix = computeChainPrefix(input.graph, input.issueNumber);
  const identity = {
    issueNumber: input.issueNumber,
    chainId: input.chainId,
    ancestors: prefix.ancestors,
    predecessors: prefix.predecessors,
    edges: prefix.edges,
    order: prefix.order,
    base: input.base,
  };
  const snapshot: FrozenPrefixSnapshot = {
    sessionId: input.sessionId,
    issueNumber: input.issueNumber,
    chainId: input.chainId,
    graphRevision: input.graphRevision,
    graphFingerprint: input.graphFingerprint,
    ancestors: prefix.ancestors,
    predecessors: prefix.predecessors,
    edges: prefix.edges,
    order: prefix.order,
    base: { ...input.base },
    fingerprint: frozenPrefixFingerprint(identity),
    frozenAt: input.frozenAt,
  };
  if (input.source !== undefined) snapshot.source = input.source;
  if (input.note !== undefined) snapshot.note = input.note;
  return snapshot;
}

/**
 * Why a snapshot cannot be frozen, or `undefined` when it can.
 *
 * A message rather than a code: every one of these is a caller bug — a
 * malformed key, a chain handle that is not one, a fingerprint that does not
 * match the contract it claims to identify — and the repair is to fix the call,
 * not to branch on which field was wrong.
 */
export function validateFrozenPrefixSnapshot(snapshot: FrozenPrefixSnapshot): string | undefined {
  if (typeof snapshot.sessionId !== "string" || snapshot.sessionId.length === 0) {
    return "sessionId is required";
  }
  if (!isValidIssueNumber(snapshot.issueNumber)) {
    return `issueNumber must be a positive integer, got ${String(snapshot.issueNumber)}`;
  }
  if (!isValidChainId(snapshot.chainId)) {
    return `malformed chain id: ${String(snapshot.chainId)}`;
  }
  if (!Number.isInteger(snapshot.graphRevision) || snapshot.graphRevision < 1) {
    return `graphRevision must be a positive integer, got ${String(snapshot.graphRevision)}`;
  }
  if (typeof snapshot.graphFingerprint !== "string" || snapshot.graphFingerprint.length === 0) {
    return "graphFingerprint is required";
  }
  if (!isChainBaseDecision(snapshot.base)) {
    return "base must be a well-formed base decision";
  }
  if (typeof snapshot.frozenAt !== "string" || snapshot.frozenAt.length === 0) {
    return "frozenAt is required";
  }
  for (const issueNumber of [...snapshot.ancestors, ...snapshot.predecessors, ...snapshot.order]) {
    if (!isValidIssueNumber(issueNumber)) {
      return `frozen prefix names a non-issue: ${String(issueNumber)}`;
    }
  }
  for (const edge of snapshot.edges) {
    if (!isValidIssueNumber(edge.blockerIssueNumber) || !isValidIssueNumber(edge.blockedIssueNumber)) {
      return "frozen prefix carries an edge whose endpoints are not issue numbers";
    }
  }
  // The fingerprint is what a repeat freeze is recognized by, so a snapshot
  // whose fingerprint does not describe its own contents would make an
  // unrelated contract look like the same freeze.
  if (snapshot.fingerprint !== frozenPrefixFingerprint(snapshot)) {
    return "fingerprint does not match the frozen contract";
  }
  return undefined;
}

/* -------------------------------------------------------------------------
 * Mutation guard
 * ---------------------------------------------------------------------- */

/**
 * Every way a candidate graph can contradict a frozen prefix. Declared as one
 * closed list because it is also the report order: what happened to the Issue
 * itself, then its ancestry, then its incoming edges, then the prefix's own
 * edges, then ordering, then the base decision.
 */
export const FROZEN_PREFIX_VIOLATION_CODES = [
  /** The candidate no longer declares the started Issue a member at all. */
  "frozen_issue_missing",
  /** The started Issue gained a direct or transitive blocker. */
  "ancestor_added",
  /** The started Issue lost a direct or transitive blocker. */
  "ancestor_removed",
  /** An edge into the started Issue that the freeze does not have. */
  "incoming_edge_added",
  /** An edge into the started Issue that the freeze has and the candidate does not. */
  "incoming_edge_removed",
  /** An edge between frozen blockers that the freeze does not have. */
  "prefix_edge_added",
  /** An edge between frozen blockers that the freeze has and the candidate does not. */
  "prefix_edge_removed",
  /** The frozen part of the graph would land in a different order. */
  "order_changed",
  /** The started Issue would resolve a different branch base. */
  "base_changed",
] as const;

export type FrozenPrefixViolationCode = (typeof FROZEN_PREFIX_VIOLATION_CODES)[number];

export function isFrozenPrefixViolationCode(value: unknown): value is FrozenPrefixViolationCode {
  return (
    typeof value === "string" &&
    (FROZEN_PREFIX_VIOLATION_CODES as readonly string[]).includes(value)
  );
}

/**
 * One structured finding about a candidate graph and one frozen prefix.
 *
 * `expected*` is what the freeze pinned; `observed*` is what the candidate
 * holds in its place. The vocabulary matches `compareChainGraphs` on purpose —
 * an operator reading a sync diff and an operator reading a frozen-prefix
 * refusal should not have to learn two of them.
 */
export interface FrozenPrefixViolation {
  code: FrozenPrefixViolationCode;
  sessionId: string;
  /** The started Issue whose frozen prefix this is about. */
  issueNumber: number;
  chainId: string;
  /** Every Issue the finding implicates, ascending. */
  issues: number[];
  /** Edges the freeze pinned that this finding is about. */
  expectedEdges: ChainGraphEdge[];
  /** Edges the candidate holds that this finding is about. */
  observedEdges: ChainGraphEdge[];
  /** Present on `order_changed` only. */
  expectedOrder?: number[];
  observedOrder?: number[];
  /** Present on `base_changed` only. */
  expectedBase?: ChainBaseDecision;
  observedBase?: ChainBaseDecision;
  /** Deterministic one-line summary, safe to log. */
  message: string;
}

/** A base decision a candidate would resolve for one Issue. */
export interface CandidateBaseDecision {
  issueNumber: number;
  base: ChainBaseDecision;
}

export interface FrozenPrefixGuardInput {
  /** The graph proposed as the chain's next state. */
  candidate: ChainGraphSnapshot;
  /** Every frozen snapshot that could apply to it. */
  snapshots: readonly FrozenPrefixSnapshot[];
  /**
   * Restrict the evaluation to snapshots frozen against this chain. Omitted,
   * every supplied snapshot is evaluated — which is what a caller that has
   * already narrowed its own list wants.
   */
  chainId?: string;
  /**
   * The base decisions the candidate would resolve, by Issue. An Issue with no
   * entry is not checked: the caller is proposing a topology change and saying
   * nothing about bases, and inventing an answer for it would either refuse
   * every graph edit or silently bless a base move nobody declared.
   */
  baseDecisions?: readonly CandidateBaseDecision[];
}

export type FrozenPrefixGuardVerdict =
  | { ok: true; evaluated: number }
  | {
      ok: false;
      code: "frozen_prefix_conflict";
      violations: FrozenPrefixViolation[];
      evaluated: number;
    };

const VIOLATION_CODE_ORDER = new Map<FrozenPrefixViolationCode, number>(
  FROZEN_PREFIX_VIOLATION_CODES.map(
    (code, index): [FrozenPrefixViolationCode, number] => [code, index],
  ),
);

/**
 * Total order over violations: the frozen Issue first, so a candidate touching
 * several started Issues reads as one block per Issue, then the code's
 * declaration order within it.
 */
function compareViolations(a: FrozenPrefixViolation, b: FrozenPrefixViolation): number {
  return (
    a.issueNumber - b.issueNumber ||
    compareStrings(a.chainId, b.chainId) ||
    (VIOLATION_CODE_ORDER.get(a.code) ?? 0) - (VIOLATION_CODE_ORDER.get(b.code) ?? 0) ||
    compareStrings(a.message, b.message)
  );
}

function issuesOfEdges(edges: readonly ChainGraphEdge[]): number[] {
  const issues = new Set<number>();
  for (const edge of edges) {
    issues.add(edge.blockerIssueNumber);
    issues.add(edge.blockedIssueNumber);
  }
  return [...issues].sort(compareNumbers);
}

function sameOrder(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * Judge a candidate graph against every frozen prefix that applies to it.
 *
 * The rule in one line: a candidate may change anything that is wholly
 * downstream of every started Issue, and nothing at or above one. Adding an
 * Issue below a frozen prefix, re-pointing edges among Issues no started task
 * depends on, and growing the graph in directions nobody has started are all
 * ordinary edits and produce no violation.
 *
 * Every violation is reported rather than the first, for the same reason
 * `validateChainGraph` reports all of its diagnostics: an operator repairing a
 * candidate needs the whole picture, and a caller refusing one gains nothing by
 * stopping early. A candidate that contradicts several started Issues is
 * evaluated against each of them independently — one frozen prefix is never
 * allowed to excuse another.
 */
export function checkFrozenPrefixes(input: FrozenPrefixGuardInput): FrozenPrefixGuardVerdict {
  const applicable = input.snapshots
    .filter((snapshot) => input.chainId === undefined || snapshot.chainId === input.chainId)
    .sort(
      (a, b) => a.issueNumber - b.issueNumber || compareStrings(a.chainId, b.chainId),
    );

  const bases = new Map<number, ChainBaseDecision>();
  for (const entry of input.baseDecisions ?? []) {
    if (!isValidIssueNumber(entry.issueNumber)) continue;
    if (!bases.has(entry.issueNumber)) bases.set(entry.issueNumber, entry.base);
  }

  const members = new Set<number>();
  for (const member of input.candidate.members ?? []) {
    if (isValidIssueNumber(member.issueNumber)) members.add(member.issueNumber);
  }

  const violations: FrozenPrefixViolation[] = [];

  for (const snapshot of applicable) {
    const of = (
      code: FrozenPrefixViolationCode,
      message: string,
      parts?: {
        issues?: readonly number[];
        expectedEdges?: readonly ChainGraphEdge[];
        observedEdges?: readonly ChainGraphEdge[];
        expectedOrder?: readonly number[];
        observedOrder?: readonly number[];
        expectedBase?: ChainBaseDecision;
        observedBase?: ChainBaseDecision;
      },
    ): FrozenPrefixViolation => {
      const violation: FrozenPrefixViolation = {
        code,
        sessionId: snapshot.sessionId,
        issueNumber: snapshot.issueNumber,
        chainId: snapshot.chainId,
        issues: [...(parts?.issues ?? [])].sort(compareNumbers),
        expectedEdges: [...(parts?.expectedEdges ?? [])].sort(compareEdges),
        observedEdges: [...(parts?.observedEdges ?? [])].sort(compareEdges),
        message,
      };
      if (parts?.expectedOrder !== undefined) violation.expectedOrder = [...parts.expectedOrder];
      if (parts?.observedOrder !== undefined) violation.observedOrder = [...parts.observedOrder];
      if (parts?.expectedBase !== undefined) violation.expectedBase = { ...parts.expectedBase };
      if (parts?.observedBase !== undefined) violation.observedBase = { ...parts.observedBase };
      return violation;
    };

    if (!members.has(snapshot.issueNumber)) {
      // Nothing else about this snapshot is answerable: an Issue the candidate
      // does not contain has no ancestry, no incoming edges, and no base in it.
      // Reporting the removal alone is the whole finding; deriving four further
      // violations from its absence would only bury it.
      violations.push(
        of(
          "frozen_issue_missing",
          `issue ${snapshot.issueNumber} has a frozen prefix but the candidate does not declare it a member`,
          { issues: [snapshot.issueNumber] },
        ),
      );
      continue;
    }

    const observed = computeChainPrefix(input.candidate, snapshot.issueNumber);

    const frozenAncestors = new Set(snapshot.ancestors);
    const observedAncestors = new Set(observed.ancestors);
    const gained = observed.ancestors.filter((issue) => !frozenAncestors.has(issue));
    const lost = snapshot.ancestors.filter((issue) => !observedAncestors.has(issue));
    if (gained.length > 0) {
      violations.push(
        of(
          "ancestor_added",
          `issue ${snapshot.issueNumber} gained blocker(s) ${renderIssues(gained)} after its prefix was frozen`,
          { issues: gained },
        ),
      );
    }
    if (lost.length > 0) {
      violations.push(
        of(
          "ancestor_removed",
          `issue ${snapshot.issueNumber} lost blocker(s) ${renderIssues(lost)} after its prefix was frozen`,
          { issues: lost },
        ),
      );
    }

    const isIncoming = (edge: ChainGraphEdge): boolean =>
      edge.blockedIssueNumber === snapshot.issueNumber;
    const frozenEdgeKeys = new Set(snapshot.edges.map(edgeKey));
    const observedEdgeKeys = new Set(observed.edges.map(edgeKey));
    const addedEdges = observed.edges.filter((edge) => !frozenEdgeKeys.has(edgeKey(edge)));
    const removedEdges = snapshot.edges.filter((edge) => !observedEdgeKeys.has(edgeKey(edge)));

    const groups: Array<{
      code: FrozenPrefixViolationCode;
      edges: ChainGraphEdge[];
      expected: boolean;
      describe: (rendered: string) => string;
    }> = [
      {
        code: "incoming_edge_added",
        edges: addedEdges.filter(isIncoming),
        expected: false,
        describe: (rendered) =>
          `issue ${snapshot.issueNumber} gained incoming edge(s) ${rendered} after its prefix was frozen`,
      },
      {
        code: "incoming_edge_removed",
        edges: removedEdges.filter(isIncoming),
        expected: true,
        describe: (rendered) =>
          `issue ${snapshot.issueNumber} lost incoming edge(s) ${rendered} after its prefix was frozen`,
      },
      {
        code: "prefix_edge_added",
        edges: addedEdges.filter((edge) => !isIncoming(edge)),
        expected: false,
        describe: (rendered) =>
          `the frozen prefix of issue ${snapshot.issueNumber} gained edge(s) ${rendered}`,
      },
      {
        code: "prefix_edge_removed",
        edges: removedEdges.filter((edge) => !isIncoming(edge)),
        expected: true,
        describe: (rendered) =>
          `the frozen prefix of issue ${snapshot.issueNumber} lost edge(s) ${rendered}`,
      },
    ];
    for (const group of groups) {
      if (group.edges.length === 0) continue;
      violations.push(
        of(group.code, group.describe(renderEdges(group.edges)), {
          issues: issuesOfEdges(group.edges),
          // A removal is stated as what the freeze *expected*; an addition as
          // what the candidate was *observed* to hold. The empty side is the
          // claim that there is nothing to put there.
          expectedEdges: group.expected ? group.edges : [],
          observedEdges: group.expected ? [] : group.edges,
        }),
      );
    }

    if (!sameOrder(snapshot.order, observed.order)) {
      // Implied by the ancestry and edge findings above — an order over a fixed
      // node set is a function of the edges within it — and reported anyway,
      // because "the blockers land in a different order" is the consequence an
      // operator is actually looking for, and reconstructing it from an edge
      // diff is work they should not have to do.
      const rendered =
        observed.order.length === 0
          ? "no order at all (the candidate prefix is cyclic)"
          : renderIssues(observed.order);
      violations.push(
        of(
          "order_changed",
          `the frozen prefix of issue ${snapshot.issueNumber} lands in a different order: frozen ${renderIssues(snapshot.order)}, candidate ${rendered}`,
          {
            issues: [...new Set([...snapshot.order, ...observed.order])],
            expectedOrder: snapshot.order,
            observedOrder: observed.order,
          },
        ),
      );
    }

    const candidateBase = bases.get(snapshot.issueNumber);
    if (candidateBase !== undefined && !chainBaseDecisionsEqual(snapshot.base, candidateBase)) {
      violations.push(
        of(
          "base_changed",
          `issue ${snapshot.issueNumber} was frozen against base ${describeBase(snapshot.base)} but the candidate resolves ${describeBase(candidateBase)}`,
          {
            issues: [
              snapshot.issueNumber,
              ...(snapshot.base.baseIssueNumber === undefined ? [] : [snapshot.base.baseIssueNumber]),
              ...(candidateBase.baseIssueNumber === undefined ? [] : [candidateBase.baseIssueNumber]),
            ],
            expectedBase: snapshot.base,
            observedBase: candidateBase,
          },
        ),
      );
    }
  }

  if (violations.length === 0) return { ok: true, evaluated: applicable.length };
  return {
    ok: false,
    code: "frozen_prefix_conflict",
    violations: violations.sort(compareViolations),
    evaluated: applicable.length,
  };
}

/* -------------------------------------------------------------------------
 * Store ports
 * ---------------------------------------------------------------------- */

export interface FrozenPrefixListFilter {
  sessionId?: string;
  chainId?: string;
}

/**
 * Durable storage for frozen prefixes.
 *
 * Declared apart from `ChainRegistryStore` rather than bolted onto it: a
 * registry that stores chains is useful without frozen prefixes, and a caller
 * that only guards candidate graphs needs the reads here and none of the
 * chain-writing surface. `SqliteChainRegistryStore` implements both.
 */
export interface ChainFrozenPrefixStore {
  /** The snapshot frozen for a task, or `undefined` if it has never started. */
  getFrozenPrefix(key: FrozenPrefixKey): Promise<FrozenPrefixSnapshot | undefined>;

  /**
   * Every snapshot matching the filter, ordered by session then Issue — the
   * list a mutation guard is run against.
   */
  listFrozenPrefixes(filter?: FrozenPrefixListFilter): Promise<FrozenPrefixSnapshot[]>;

  /**
   * Record a snapshot. Re-recording an identical contract returns the stored
   * row unchanged, keeping the provenance of the *first* freeze; a different
   * contract at the same key is refused with `already_exists` rather than
   * overwriting the ancestry a task has already been built against.
   *
   * The plain write, without a task transition. Callers freezing at task
   * intake want {@link ChainPrefixFreezeStore.freezeChainPrefix} instead, which
   * is the only way to get the snapshot and the transition committed together.
   */
  putFrozenPrefix(
    snapshot: FrozenPrefixSnapshot,
  ): Promise<ChainRegistryResult<FrozenPrefixSnapshot>>;

  /**
   * Drop a frozen prefix. Deleting an absent one reports `deleted: false`
   * rather than failing, mirroring `deleteChain`.
   */
  deleteFrozenPrefix(
    key: FrozenPrefixKey,
  ): Promise<ChainRegistryResult<{ deleted: boolean }>>;
}

/** The task-store half of a freeze: the CAS transition and its events. */
export interface FreezeChainPrefixTransition {
  key: TaskKey;
  expected: TaskExpected;
  patch: TaskPatch;
  /** Recorded in the same transaction as the freeze, when supplied. */
  event?: TaskEvent;
  /** Further events belonging to the same freeze, in the order given. */
  extraEvents?: TaskEvent[];
}

export interface FreezeChainPrefixInput {
  snapshot: FrozenPrefixSnapshot;
  transition: FreezeChainPrefixTransition;
}

export type FreezeChainPrefixFailureCode =
  /** No such task, or no such chain to freeze against. */
  | "not_found"
  /** The task-state compare-and-set lost. */
  | "conflict"
  /** A *different* contract is already frozen for this task. */
  | "frozen_prefix_conflict"
  /** The snapshot is malformed, or disagrees with the transition's task key. */
  | "invalid_input";

export type FreezeChainPrefixResult =
  | {
      ok: true;
      /** The stored snapshot — on a repeat, the one the first freeze wrote. */
      snapshot: FrozenPrefixSnapshot;
      task: AiTask;
      /**
       * True when the contract was already on record and this call wrote
       * nothing. The transition is not re-applied in that case: it committed
       * with the snapshot, so there is nothing left for a repeat to advance.
       */
      alreadyFrozen: boolean;
    }
  | {
      ok: false;
      code: FreezeChainPrefixFailureCode;
      detail?: string;
      /** The task as found, on a lost compare-and-set. */
      current?: AiTask;
      /** The contract already on record, on `frozen_prefix_conflict`. */
      frozen?: FrozenPrefixSnapshot;
    };

/**
 * The atomic application port: freeze a task's dependency snapshot *and*
 * perform the task-state transition that starting it requires, in one
 * transaction.
 *
 * Why it has to be one write. The two halves are each other's premise — the
 * snapshot is the contract the started task runs under, and the transition is
 * what "started" means. Split across two calls, a failure between them leaves
 * either a task advanced against a prefix nothing pinned, or a prefix frozen
 * for a task that never started and whose ancestry is now needlessly immovable.
 * Neither is repairable by retrying, because a retry sees a half-applied state
 * and cannot tell which half it is looking at.
 *
 * So an implementation must apply both or neither, and must decide the
 * already-frozen case inside the same transaction: a caller that reads the
 * snapshot first and writes afterwards has exactly the check-to-act gap this
 * port exists to close.
 */
export interface ChainPrefixFreezeStore {
  freezeChainPrefix(input: FreezeChainPrefixInput): Promise<FreezeChainPrefixResult>;
}
