/**
 * §9.1 topology-proposal normalization (issue #982).
 *
 * §9 decides whether a topology proposal is `blocking`; it never asked whether
 * the proposal would CHANGE anything. An agent that proposes adding an edge the
 * GitHub relationship graph already carries produces a no-op, and treating that
 * no-op as an unresolved topology change spends a human handoff on nothing —
 * and, in a serial chain, parks every downstream Issue behind it.
 *
 * This module is the missing step: it compares each proposal against the
 * authoritative direct relationships already captured for the §5 snapshot and
 * classifies it `already_satisfied`, `effective_change`, or
 * `invalid_or_unverifiable`. Only `already_satisfied` is excluded from the
 * handoff; everything else keeps the §9 rules verbatim.
 *
 * Design rules:
 *
 *  - **The captured graph is authoritative, and nothing else is.** The
 *    comparison reads the snapshot's direct `blocked by` set — never the Issue
 *    body, never labels, never the proposal's own prose. What the snapshot does
 *    not cover is `invalid_or_unverifiable`, not "absent".
 *  - **Unavailable beats assumed.** A graph that could not be built classifies
 *    every proposal `invalid_or_unverifiable`, so a relationship read failure
 *    can never be read as "topology already satisfied".
 *  - **Details are closed literals.** Everything this module reports is a
 *    literal (optionally with Issue numbers), safe for audit events and task
 *    context — the same discipline the rest of the lane follows.
 *  - **Duplicates collapse, fail closed.** Two proposals describing the same
 *    edge are one decision; the collapsed group blocks if ANY member blocks.
 */

import type {
  RefinementTopologyKind,
  RefinementTopologyProposal,
} from "./issue-refinement-loop.js";
import type { RefinementSnapshot } from "./issue-refinement-snapshot.js";

/** §9.1 classification of one proposal against the authoritative graph. */
export const REFINEMENT_TOPOLOGY_NORMALIZATIONS = [
  "already_satisfied",
  "effective_change",
  "invalid_or_unverifiable",
] as const;
export type RefinementTopologyNormalization =
  (typeof REFINEMENT_TOPOLOGY_NORMALIZATIONS)[number];

/**
 * §7.1 the structured edge a `dependency_*` proposal is about.
 *
 * `blockedIssue` is the Issue that would carry the `blocked by` edge and
 * `blockerIssue` is the predecessor it would point at — the same direction the
 * dependency gate reads. `previousBlockerIssue` is the edge a
 * `dependency_rewire` replaces, and is meaningless for the other kinds.
 */
export interface RefinementTopologyRelationship {
  blockedIssue: number;
  blockerIssue: number;
  previousBlockerIssue?: number;
}

/** Why no authoritative graph is available (closed literals). */
export const REFINEMENT_RELATIONSHIP_GRAPH_FAILURES = [
  /** The caller had no snapshot to reuse. */
  "snapshot_absent",
  /** A snapshot was supplied but carries no usable relationship record. */
  "snapshot_unusable",
  /** The caller's relationship read failed (fail closed, never "no edges"). */
  "read_failed",
  /** The caller did not supply a graph at all. */
  "not_supplied",
] as const;
export type RefinementRelationshipGraphFailure =
  (typeof REFINEMENT_RELATIONSHIP_GRAPH_FAILURES)[number];

/**
 * The authoritative direct relationships for ONE Issue: its complete `blocked
 * by` set. Deliberately not a whole-repo graph — §5 captures the target's
 * direct predecessors and nothing else, so a claim about any other Issue's
 * edges is unverifiable rather than false.
 */
export type RefinementRelationshipGraph =
  | { ok: true; issueNumber: number; blockedBy: readonly number[] }
  | { ok: false; reason: RefinementRelationshipGraphFailure };

/** One proposal's §9.1 classification. */
export interface NormalizedTopologyProposal {
  /** Index into the refiner's `topologyProposals`. */
  index: number;
  kind: RefinementTopologyKind;
  normalization: RefinementTopologyNormalization;
  /** Closed literal explaining the classification; never agent prose. */
  detail: string;
  /**
   * Canonical identity of the edge this proposal describes, or `null` when the
   * proposal names no comparable edge (a `split`, or a malformed one). Two
   * proposals with the same key are the same decision.
   */
  key: string | null;
  /** First index carrying the same key, or `null` when this IS the first. */
  duplicateOfIndex: number | null;
}

export interface TopologyNormalizationResult {
  entries: NormalizedTopologyProposal[];
  /** False when no authoritative graph was available (everything unverifiable). */
  graphAvailable: boolean;
  /** Per-classification counts — the audit summary operators read first. */
  counts: Record<RefinementTopologyNormalization, number>;
}

/** Kinds that describe a `blocked by` edge, and so can be compared at all. */
const RELATIONSHIP_KINDS: readonly RefinementTopologyKind[] = [
  "dependency_add",
  "dependency_remove",
  "dependency_rewire",
];

function positiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0;
}

/**
 * Validate a `relationship` object from agent output (§7.1).
 *
 * Exported so the refiner-result validator and this module agree on the shape
 * byte for byte — a relationship that parses here is one the classifier can
 * compare, and one that does not is malformed at §17 rather than silently
 * unverifiable later.
 */
export function validRefinementTopologyRelationship(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!["blockedIssue", "blockerIssue", "previousBlockerIssue"].includes(key)) return false;
  }
  if (!positiveInteger(record["blockedIssue"])) return false;
  if (!positiveInteger(record["blockerIssue"])) return false;
  if (
    record["previousBlockerIssue"] !== undefined
    && !positiveInteger(record["previousBlockerIssue"])
  ) {
    return false;
  }
  return true;
}

/**
 * Reuse the relationships already captured for the §5 snapshot.
 *
 * The snapshot's predecessor list IS the target's complete direct `blocked by`
 * set: §4 refuses to capture unless every direct predecessor read back usable,
 * so the captured set is the authoritative one, frozen at the same instant as
 * every other input the agents saw. Re-reading it here would compare the
 * proposals against a graph the agents never saw and add a provider read to a
 * step §12 gives none.
 *
 * A relationship read that FAILED never reaches this function: §4 turns it into
 * a `failed` capture, so there is no snapshot and no draft to normalize.
 */
export function refinementRelationshipGraph(
  snapshot: RefinementSnapshot | null | undefined,
): RefinementRelationshipGraph {
  if (!snapshot) return { ok: false, reason: "snapshot_absent" };
  const issueNumber = snapshot.target?.issueNumber;
  if (!positiveInteger(issueNumber) || !Array.isArray(snapshot.predecessors)) {
    return { ok: false, reason: "snapshot_unusable" };
  }
  const blockedBy = [
    ...new Set(
      snapshot.predecessors
        .map((p) => p.issueNumber)
        .filter((n): n is number => positiveInteger(n)),
    ),
  ].sort((a, b) => a - b);
  return { ok: true, issueNumber, blockedBy };
}

function relationshipKey(
  kind: RefinementTopologyKind,
  relationship: RefinementTopologyRelationship,
): string {
  const base = `${kind}:${relationship.blockedIssue}<-${relationship.blockerIssue}`;
  return relationship.previousBlockerIssue === undefined
    ? base
    : `${base}<>${relationship.previousBlockerIssue}`;
}

interface Classification {
  normalization: RefinementTopologyNormalization;
  detail: string;
}

function classify(
  proposal: RefinementTopologyProposal,
  graph: RefinementRelationshipGraph,
): Classification {
  if (!RELATIONSHIP_KINDS.includes(proposal.kind)) {
    // A split or a supersession is not an edge; it can never be "already
    // satisfied" by the relationship graph, so it keeps the §9 rules whole.
    return { normalization: "effective_change", detail: "kind-not-relationship" };
  }
  if (!graph.ok) {
    return { normalization: "invalid_or_unverifiable", detail: `graph-unavailable:${graph.reason}` };
  }
  const relationship = proposal.relationship;
  if (!relationship) {
    return { normalization: "invalid_or_unverifiable", detail: "relationship-missing" };
  }
  if (relationship.blockedIssue !== graph.issueNumber) {
    // §5 captures the target's edges and nothing else. Another Issue's graph is
    // unread, not empty.
    return { normalization: "invalid_or_unverifiable", detail: "relationship-out-of-scope" };
  }
  if (relationship.blockerIssue === relationship.blockedIssue) {
    return { normalization: "invalid_or_unverifiable", detail: "relationship-self-edge" };
  }
  const present = graph.blockedBy.includes(relationship.blockerIssue);

  if (proposal.kind === "dependency_add") {
    return present
      ? { normalization: "already_satisfied", detail: "edge-present" }
      : { normalization: "effective_change", detail: "edge-absent" };
  }
  if (proposal.kind === "dependency_remove") {
    return present
      ? { normalization: "effective_change", detail: "edge-present" }
      : { normalization: "already_satisfied", detail: "edge-absent" };
  }

  // dependency_rewire: satisfied only when BOTH halves already hold.
  const previous = relationship.previousBlockerIssue;
  if (previous === undefined) {
    return { normalization: "invalid_or_unverifiable", detail: "rewire-previous-missing" };
  }
  if (previous === relationship.blockerIssue || previous === relationship.blockedIssue) {
    return { normalization: "invalid_or_unverifiable", detail: "rewire-degenerate" };
  }
  return present && !graph.blockedBy.includes(previous)
    ? { normalization: "already_satisfied", detail: "rewire-applied" }
    : { normalization: "effective_change", detail: "rewire-pending" };
}

/**
 * Classify every proposal against the authoritative graph, collapsing
 * duplicates (§9.1).
 *
 * Classification is a pure function of the kind, the relationship, and the
 * graph, so duplicates always agree; `duplicateOfIndex` records the collapse so
 * an operator can see that two entries were one decision.
 */
export function normalizeTopologyProposals(
  proposals: readonly RefinementTopologyProposal[],
  graph: RefinementRelationshipGraph,
): TopologyNormalizationResult {
  const firstByKey = new Map<string, number>();
  const counts: Record<RefinementTopologyNormalization, number> = {
    already_satisfied: 0,
    effective_change: 0,
    invalid_or_unverifiable: 0,
  };
  const entries = proposals.map((proposal, index): NormalizedTopologyProposal => {
    const { normalization, detail } = classify(proposal, graph);
    // Only a comparable edge gets an identity: two `split` proposals with
    // different rationales are two proposals, not one repeated.
    const key =
      RELATIONSHIP_KINDS.includes(proposal.kind) && proposal.relationship
        ? relationshipKey(proposal.kind, proposal.relationship)
        : null;
    let duplicateOfIndex: number | null = null;
    if (key !== null) {
      const first = firstByKey.get(key);
      if (first === undefined) firstByKey.set(key, index);
      else duplicateOfIndex = first;
    }
    counts[normalization] += 1;
    return { index, kind: proposal.kind, normalization, detail, key, duplicateOfIndex };
  });
  return { entries, graphAvailable: graph.ok, counts };
}
