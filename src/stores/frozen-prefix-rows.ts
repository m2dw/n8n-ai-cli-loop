/**
 * Row shape and SQL for `dependency_chain_frozen_prefix` (issue #891).
 *
 * Shared by the two stores that write the table — `SqliteChainRegistryStore`,
 * which owns the plain snapshot API, and `SqliteTaskStore`, which owns the
 * atomic freeze-with-transition port because a freeze has to commit in the same
 * transaction as the task-state transition it belongs to. One serialization in
 * one place is what keeps a snapshot written through either of them readable
 * through the other; two hand-rolled copies would drift the first time a field
 * is added.
 */

import type {
  ChainBaseDecision,
  FrozenPrefixSnapshot,
} from "../core/chain-frozen-prefix.js";
import {
  isChainBaseKind,
  validateFrozenPrefixSnapshot,
} from "../core/chain-frozen-prefix.js";
import type { ChainGraphEdge } from "../core/chain-graph.js";

export interface FrozenPrefixRow {
  session_id: string;
  issue_number: number;
  chain_id: string;
  graph_revision: number;
  graph_fingerprint: string;
  prefix_fingerprint: string;
  ancestors: string;
  predecessors: string;
  edges: string;
  prefix_order: string;
  base_kind: string;
  base_ref: string;
  base_issue_number: number | null;
  source: string | null;
  note: string | null;
  frozen_at: string;
}

export const SELECT_FROZEN_PREFIX = `
  SELECT * FROM dependency_chain_frozen_prefix
   WHERE session_id = ? AND issue_number = ?`;

export const INSERT_FROZEN_PREFIX = `
  INSERT INTO dependency_chain_frozen_prefix
    (session_id, issue_number, chain_id, graph_revision, graph_fingerprint,
     prefix_fingerprint, ancestors, predecessors, edges, prefix_order,
     base_kind, base_ref, base_issue_number, source, note, frozen_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/** Bind parameters for {@link INSERT_FROZEN_PREFIX}, in declaration order. */
export function frozenPrefixInsertValues(snapshot: FrozenPrefixSnapshot): unknown[] {
  return [
    snapshot.sessionId,
    snapshot.issueNumber,
    snapshot.chainId,
    snapshot.graphRevision,
    snapshot.graphFingerprint,
    snapshot.fingerprint,
    JSON.stringify(snapshot.ancestors),
    JSON.stringify(snapshot.predecessors),
    JSON.stringify(
      snapshot.edges.map((edge) => [edge.blockerIssueNumber, edge.blockedIssueNumber]),
    ),
    JSON.stringify(snapshot.order),
    snapshot.base.kind,
    snapshot.base.baseRef,
    snapshot.base.baseIssueNumber ?? null,
    snapshot.source ?? null,
    snapshot.note ?? null,
    snapshot.frozenAt,
  ];
}

/**
 * A stored row that cannot be read back as the snapshot it claims to be.
 *
 * Thrown rather than absorbed into an empty prefix, and thrown from the *read*
 * rather than deferred to the guard: a frozen prefix exists to refuse graph
 * edits, so a corrupt one that silently decoded to "nothing is frozen" would
 * turn the one record protecting a started task into a record that permits
 * everything. Failing the read is the fail-closed direction — the guard cannot
 * run at all, so nothing is accepted on a snapshot nobody can read.
 */
export class CorruptFrozenPrefixError extends Error {
  readonly sessionId: string;
  readonly issueNumber: number;

  constructor(sessionId: string, issueNumber: number, detail: string) {
    super(
      `frozen prefix for issue ${issueNumber} in session ${sessionId} is unreadable: ${detail}`,
    );
    this.name = "CorruptFrozenPrefixError";
    this.sessionId = sessionId;
    this.issueNumber = issueNumber;
  }
}

function parseIssueList(row: FrozenPrefixRow, field: string, raw: string): number[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CorruptFrozenPrefixError(row.session_id, row.issue_number, `${field} is not JSON`);
  }
  if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "number")) {
    throw new CorruptFrozenPrefixError(
      row.session_id,
      row.issue_number,
      `${field} is not a list of issue numbers`,
    );
  }
  return parsed as number[];
}

function parseEdges(row: FrozenPrefixRow): ChainGraphEdge[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.edges);
  } catch {
    throw new CorruptFrozenPrefixError(row.session_id, row.issue_number, "edges is not JSON");
  }
  if (!Array.isArray(parsed)) {
    throw new CorruptFrozenPrefixError(row.session_id, row.issue_number, "edges is not a list");
  }
  return parsed.map((entry) => {
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      typeof entry[0] !== "number" ||
      typeof entry[1] !== "number"
    ) {
      throw new CorruptFrozenPrefixError(
        row.session_id,
        row.issue_number,
        "edges holds an entry that is not a [blocker, blocked] pair",
      );
    }
    return { blockerIssueNumber: entry[0], blockedIssueNumber: entry[1] };
  });
}

function parseBase(row: FrozenPrefixRow): ChainBaseDecision {
  if (!isChainBaseKind(row.base_kind)) {
    throw new CorruptFrozenPrefixError(
      row.session_id,
      row.issue_number,
      `base kind is not a known kind: ${row.base_kind}`,
    );
  }
  const base: ChainBaseDecision = { kind: row.base_kind, baseRef: row.base_ref };
  if (row.base_issue_number !== null) base.baseIssueNumber = row.base_issue_number;
  return base;
}

/**
 * Decode a stored row, refusing anything that is not the snapshot it claims to
 * be.
 *
 * The per-column parsers above only establish that each cell has the *shape* a
 * snapshot column has; they cannot see that an edited row now describes a
 * different contract. So the assembled snapshot is put through the same
 * validation a caller's snapshot passes before it is written — which recomputes
 * the fingerprint over the contract's own contents, and therefore catches an
 * ancestor list, edge set, ordering, or base decision that was altered after
 * the freeze. Without it a semantically corrupt row would decode cleanly and go
 * straight into the mutation guard as the thing candidates are judged against.
 */
export function rowToFrozenPrefix(row: FrozenPrefixRow): FrozenPrefixSnapshot {
  const snapshot: FrozenPrefixSnapshot = {
    sessionId: row.session_id,
    issueNumber: row.issue_number,
    chainId: row.chain_id,
    graphRevision: row.graph_revision,
    graphFingerprint: row.graph_fingerprint,
    ancestors: parseIssueList(row, "ancestors", row.ancestors),
    predecessors: parseIssueList(row, "predecessors", row.predecessors),
    edges: parseEdges(row),
    order: parseIssueList(row, "prefix_order", row.prefix_order),
    base: parseBase(row),
    fingerprint: row.prefix_fingerprint,
    frozenAt: row.frozen_at,
  };
  if (row.source !== null) snapshot.source = row.source;
  if (row.note !== null) snapshot.note = row.note;

  const invalid = validateFrozenPrefixSnapshot(snapshot);
  if (invalid !== undefined) {
    throw new CorruptFrozenPrefixError(row.session_id, row.issue_number, invalid);
  }
  return snapshot;
}
