/**
 * Dependency-chain registry: storage types, provider-neutral port, and the
 * pure helpers a backing store needs (issue #788).
 *
 * Scope boundary. This module owns durable chain *identity* and the shape of
 * what is persisted — stable chain IDs, membership, DAG edges, revision
 * records with fingerprints, aliases, and synchronization metadata. It owns
 * none of the policy that reads those rows:
 *
 *   - GitHub Issue Relationships remain the dependency state the runner acts
 *     on. Nothing here fetches or mutates them; the registry is a local,
 *     queryable mirror plus the operator-facing handles GitHub has no place
 *     to store.
 *   - Candidate-graph validation, cycle detection, and accepted-revision
 *     semantics belong to issue #890. This module persists an
 *     `acceptedRevision` pointer and per-revision `state` because those are
 *     storage primitives, and deliberately never decides what may be accepted.
 *     The one ownership rule it does enforce —
 *     {@link PutChainGraphInput.exclusiveMemberScope} — it enforces only when
 *     a caller asks for it, and only mechanically: whether a chain *should*
 *     claim an Issue exclusively stays #890's call, but the check-then-claim
 *     has to happen inside the write's own transaction or it is not a claim
 *     at all.
 *   - Frozen-prefix snapshots and mutation guards belong to issue #891. The one
 *     thing this module does with them is hand them to a caller's
 *     {@link AcceptedRevisionGuard} from inside the transaction that moves the
 *     accepted pointer — because a rule about rows this store owns can only be
 *     made atomic with a write by the store performing that write.
 *
 * The integrity rules enforced here are strictly *referential*: an edge may
 * only name issues that are members of the same chain, a chain's head must be
 * one of its members, and an issue may not depend on itself. Rejecting a
 * self-edge is not cycle detection — it is the one edge shape that can never
 * be repaired by any later graph policy, and storing it would contradict the
 * DAG storage model outright. Longer cycles are #890's to reject.
 */

import { createHash } from "crypto";

// Type-only, and therefore erased: the runtime dependency between these two
// modules runs the other way (#891's rules import this module's validators).
// What is borrowed here is the *shape* of the rows an implementation reads for
// {@link AcceptedRevisionGuard}, which has to be the real one — a structural
// copy would drift from the table it describes.
import type { FrozenPrefixSnapshot } from "./chain-frozen-prefix.js";

/** Prefix every default chain ID carries: `chain_777`. */
export const CHAIN_ID_PREFIX = "chain_";

/**
 * Upper bound on deterministic collision suffixes tried by
 * {@link allocateChainId} before it gives up. Reaching it means thousands of
 * distinct chains claim the same head Issue, which is a caller bug rather
 * than a state the registry should paper over with a random ID.
 */
export const MAX_CHAIN_ID_SUFFIX = 10_000;

/** Longest accepted operator alias, in characters. */
export const MAX_CHAIN_ALIAS_LENGTH = 64;

/**
 * Where a chain's persisted graph stands relative to the dependency state the
 * runner reads (GitHub Issue Relationships).
 *
 * The registry stores this verbatim: it never computes it, because computing
 * it would require reading the provider, which this layer must not do.
 *
 *   - `unknown`  — never synchronized, or the previous result was discarded.
 *   - `in_sync`  — last comparison found the persisted graph equivalent.
 *   - `stale`    — last comparison found a difference not yet reconciled.
 *   - `error`    — the last attempt failed; `syncError` carries the detail.
 */
export type ChainSyncStatus = "unknown" | "in_sync" | "stale" | "error";

/**
 * Lifecycle marker on a persisted revision record. The registry treats these
 * as opaque labels — the rules for moving between them are #890's.
 */
export type ChainRevisionState = "candidate" | "accepted" | "superseded" | "rejected";

/**
 * Descriptive role of a member within its chain. `head` marks an entry point
 * an operator navigates from; whether the roles agree with the edge topology
 * is a graph-policy question (#890), not a storage constraint.
 */
export type ChainMemberRole = "head" | "node";

const CHAIN_MEMBER_ROLES: readonly ChainMemberRole[] = ["head", "node"];
const CHAIN_SYNC_STATUSES: readonly ChainSyncStatus[] = ["unknown", "in_sync", "stale", "error"];
const CHAIN_REVISION_STATES: readonly ChainRevisionState[] = [
  "candidate",
  "accepted",
  "superseded",
  "rejected",
];

export function isChainMemberRole(value: unknown): value is ChainMemberRole {
  return typeof value === "string" && (CHAIN_MEMBER_ROLES as readonly string[]).includes(value);
}

export function isChainSyncStatus(value: unknown): value is ChainSyncStatus {
  return typeof value === "string" && (CHAIN_SYNC_STATUSES as readonly string[]).includes(value);
}

export function isChainRevisionState(value: unknown): value is ChainRevisionState {
  return typeof value === "string" && (CHAIN_REVISION_STATES as readonly string[]).includes(value);
}

/** Chain-level metadata: the stable handle plus everything not per-member. */
export interface ChainRecord {
  /**
   * Stable operator handle, allocated once at creation and never renumbered.
   * Deliberately independent of `headIssueNumber`: a chain whose head moves
   * keeps the ID an operator has already written into notes and commands.
   */
  chainId: string;
  sessionId: string;
  /**
   * The head Issue the ID was derived from. Frozen at creation — it exists so
   * the derivation stays auditable after the head moves, and is never used to
   * re-derive an ID.
   */
  originIssueNumber: number;
  /** Current head Issue. May change; see {@link ChainRecord.chainId}. */
  headIssueNumber: number;
  title?: string;
  /**
   * Revision number of the members/edges currently persisted for this chain.
   * Starts at 1 for the graph written at creation and advances on every
   * materially different {@link ChainRegistryStore.putChainGraph}.
   */
  graphRevision: number;
  /** Fingerprint of the currently persisted members/edges. */
  graphFingerprint: string;
  /**
   * Revision an accepted-revision policy (#890) has marked accepted, or
   * `undefined` while no revision has been accepted. Stored, never
   * interpreted, here.
   */
  acceptedRevision?: number;
  syncStatus: ChainSyncStatus;
  /**
   * Detail of the last failed attempt. Only ever set alongside an `error`
   * status: a later non-error result clears it.
   */
  syncError?: string;
  /** When synchronization was last *attempted*, successful or not. */
  syncCheckedAt?: string;
  /** When synchronization last *succeeded*. */
  syncedAt?: string;
  createdAt: string;
  updatedAt: string;
  /**
   * Monotonic row revision, bumped by every write that touches this chain.
   * Callers pass it back as `expectedRev` for compare-and-set updates. It is
   * deliberately not a timestamp: two writers can compute the same ISO
   * millisecond, which would let a timestamp predicate match a row that has
   * already moved on.
   */
  rev: number;
}

export interface ChainMember {
  chainId: string;
  issueNumber: number;
  role: ChainMemberRole;
  addedAt: string;
}

/**
 * A persisted dependency edge, read as "`blockedIssueNumber` depends on
 * `blockerIssueNumber`" — the blocker must land first. Fan-out is several
 * edges sharing a blocker, fan-in several edges sharing a blocked issue; the
 * storage model constrains neither.
 */
export interface ChainEdge {
  chainId: string;
  blockerIssueNumber: number;
  blockedIssueNumber: number;
  createdAt: string;
}

/** A chain and the full graph currently persisted for it. */
export interface ChainGraph {
  chain: ChainRecord;
  members: ChainMember[];
  edges: ChainEdge[];
}

export interface ChainRevisionRecord {
  chainId: string;
  revision: number;
  fingerprint: string;
  state: ChainRevisionState;
  /** Free-form provenance marker (`"intake"`, `"operator"`, ...). */
  source?: string;
  note?: string;
  createdAt: string;
}

/**
 * A second operator handle pointing at a chain — the history record that
 * keeps an older or alternative name resolvable after a rename. Aliases share
 * one namespace with chain IDs, so an alias can never shadow a real chain.
 */
export interface ChainAlias {
  alias: string;
  chainId: string;
  reason?: string;
  createdAt: string;
}

/* -------------------------------------------------------------------------
 * Chain ID allocation
 * ---------------------------------------------------------------------- */

const CHAIN_ID_PATTERN = /^chain_[1-9][0-9]*(?:_[2-9]|_[1-9][0-9]+)?$/;
const CHAIN_ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** True for a well-formed default or suffixed chain ID (`chain_777_2`). */
export function isValidChainId(value: unknown): value is string {
  return typeof value === "string" && CHAIN_ID_PATTERN.test(value);
}

/**
 * True for a well-formed operator alias. Aliases are typed by hand into
 * commands, so they are restricted to characters that survive a shell and a
 * URL unquoted, and bounded so an alias cannot become a payload.
 */
export function isValidChainAlias(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_CHAIN_ALIAS_LENGTH &&
    CHAIN_ALIAS_PATTERN.test(value)
  );
}

/** True for a usable Issue number: a positive integer. */
export function isValidIssueNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/**
 * The `ordinal`-th candidate ID for a head Issue. Ordinal 1 is the bare
 * default (`chain_777`) and every later ordinal appends it as a suffix
 * (`chain_777_2`, `chain_777_3`, ...), so the sequence a collision walks is
 * fixed by the head number alone — two operators resolving the same collision
 * on the same registry land on the same ID.
 */
export function chainIdCandidate(headIssueNumber: number, ordinal: number): string {
  if (!isValidIssueNumber(headIssueNumber)) {
    throw new RangeError(`chain id requires a positive integer issue number, got ${headIssueNumber}`);
  }
  if (!Number.isInteger(ordinal) || ordinal < 1) {
    throw new RangeError(`chain id ordinal must be a positive integer, got ${ordinal}`);
  }
  return ordinal === 1
    ? `${CHAIN_ID_PREFIX}${headIssueNumber}`
    : `${CHAIN_ID_PREFIX}${headIssueNumber}_${ordinal}`;
}

/** The bare default ID for a head Issue, before any collision handling. */
export function defaultChainId(headIssueNumber: number): string {
  return chainIdCandidate(headIssueNumber, 1);
}

/**
 * First candidate ID for `headIssueNumber` that `isTaken` rejects nothing on.
 *
 * `isTaken` is supplied by the store and must consult chain IDs *and* aliases:
 * the two share a namespace, so allocating an ID that an alias already claims
 * would make a handle ambiguous. Returns `undefined` once
 * {@link MAX_CHAIN_ID_SUFFIX} candidates are exhausted rather than inventing a
 * non-derived ID.
 */
export function allocateChainId(
  headIssueNumber: number,
  isTaken: (candidate: string) => boolean,
  maxSuffix: number = MAX_CHAIN_ID_SUFFIX,
): string | undefined {
  for (let ordinal = 1; ordinal <= maxSuffix; ordinal += 1) {
    const candidate = chainIdCandidate(headIssueNumber, ordinal);
    if (!isTaken(candidate)) return candidate;
  }
  return undefined;
}

/* -------------------------------------------------------------------------
 * Graph shape, integrity, and fingerprinting
 * ---------------------------------------------------------------------- */

/**
 * A member as supplied by a caller, before the store stamps chain and time.
 * `role` defaults to `node`.
 */
export interface ChainMemberInput {
  issueNumber: number;
  role?: ChainMemberRole;
}

/** An edge as supplied by a caller, before the store stamps chain and time. */
export interface ChainEdgeInput {
  blockerIssueNumber: number;
  blockedIssueNumber: number;
}

export type ChainGraphIntegrityError =
  | { code: "empty_members" }
  | { code: "invalid_issue_number"; issueNumber: unknown }
  | { code: "invalid_role"; issueNumber: number; role: unknown }
  | { code: "duplicate_member"; issueNumber: number }
  | { code: "head_not_member"; issueNumber: number }
  | { code: "self_edge"; issueNumber: number }
  | { code: "duplicate_edge"; blockerIssueNumber: number; blockedIssueNumber: number }
  | { code: "unknown_edge_endpoint"; issueNumber: number };

/**
 * Every referential-integrity violation in a proposed graph, in a stable
 * order (member problems before edge problems, each in input order).
 *
 * Returns all of them rather than the first: a caller repairing an
 * operator-supplied graph should see the whole list, and a store rejecting one
 * gains nothing by stopping early.
 */
export function checkChainGraphIntegrity(input: {
  headIssueNumber: number;
  members: readonly ChainMemberInput[];
  edges: readonly ChainEdgeInput[];
}): ChainGraphIntegrityError[] {
  const errors: ChainGraphIntegrityError[] = [];
  const seen = new Set<number>();

  if (input.members.length === 0) errors.push({ code: "empty_members" });

  for (const member of input.members) {
    if (!isValidIssueNumber(member.issueNumber)) {
      errors.push({ code: "invalid_issue_number", issueNumber: member.issueNumber });
      continue;
    }
    if (member.role !== undefined && !isChainMemberRole(member.role)) {
      errors.push({ code: "invalid_role", issueNumber: member.issueNumber, role: member.role });
    }
    if (seen.has(member.issueNumber)) {
      errors.push({ code: "duplicate_member", issueNumber: member.issueNumber });
      continue;
    }
    seen.add(member.issueNumber);
  }

  if (!isValidIssueNumber(input.headIssueNumber)) {
    errors.push({ code: "invalid_issue_number", issueNumber: input.headIssueNumber });
  } else if (!seen.has(input.headIssueNumber)) {
    errors.push({ code: "head_not_member", issueNumber: input.headIssueNumber });
  }

  const seenEdges = new Set<string>();
  for (const edge of input.edges) {
    let malformed = false;
    for (const endpoint of [edge.blockerIssueNumber, edge.blockedIssueNumber]) {
      if (!isValidIssueNumber(endpoint)) {
        errors.push({ code: "invalid_issue_number", issueNumber: endpoint });
        malformed = true;
      } else if (!seen.has(endpoint)) {
        errors.push({ code: "unknown_edge_endpoint", issueNumber: endpoint });
        malformed = true;
      }
    }
    if (malformed) continue;
    if (edge.blockerIssueNumber === edge.blockedIssueNumber) {
      errors.push({ code: "self_edge", issueNumber: edge.blockerIssueNumber });
      continue;
    }
    const key = `${edge.blockerIssueNumber}->${edge.blockedIssueNumber}`;
    if (seenEdges.has(key)) {
      errors.push({
        code: "duplicate_edge",
        blockerIssueNumber: edge.blockerIssueNumber,
        blockedIssueNumber: edge.blockedIssueNumber,
      });
      continue;
    }
    seenEdges.add(key);
  }

  return errors;
}

/**
 * Canonical text form of a graph: one `<issue>:<role>` line per member, then
 * one `<blocker>-><blocked>` line per edge, each group sorted.
 *
 * Sorting is what makes the form canonical — two writers that supply the same
 * graph in different input orders must fingerprint identically, otherwise a
 * re-write of an unchanged graph would look like a new revision. The sort is
 * lexicographic on the rendered lines rather than numeric on Issue numbers;
 * either is a total order over the same multiset of lines, and only
 * determinism matters here.
 */
export function canonicalChainGraphText(input: {
  members: readonly ChainMemberInput[];
  edges: readonly ChainEdgeInput[];
}): string {
  const members = [...input.members]
    .map((m) => `${m.issueNumber}:${m.role ?? "node"}`)
    .sort();
  const edges = [...input.edges]
    .map((e) => `${e.blockerIssueNumber}->${e.blockedIssueNumber}`)
    .sort();
  return `members\n${members.join("\n")}\nedges\n${edges.join("\n")}\n`;
}

/**
 * Stable fingerprint of a graph's members and edges: `sha256:<hex>` over
 * {@link canonicalChainGraphText}. Equal fingerprints mean the same
 * dependency structure, which is what lets a repeated write of an unchanged
 * graph be recognized as a no-op instead of a new revision.
 */
export function chainGraphFingerprint(input: {
  members: readonly ChainMemberInput[];
  edges: readonly ChainEdgeInput[];
}): string {
  return `sha256:${createHash("sha256").update(canonicalChainGraphText(input)).digest("hex")}`;
}

/* -------------------------------------------------------------------------
 * Store port
 * ---------------------------------------------------------------------- */

export type ChainRegistryFailureCode =
  /** No chain, revision, or alias with the given handle. */
  | "not_found"
  /** An explicitly requested chain ID or revision already exists. */
  | "already_exists"
  /**
   * An `expectedRev` compare-and-set lost to a concurrent write, or an
   * {@link PutChainGraphInput.exclusiveMemberScope} claim lost to a chain that
   * already holds one of the members. Both are the same thing from the
   * caller's side: the state the write was computed against has moved.
   */
  | "conflict"
  /** The proposed members/edges violate storage-level referential integrity. */
  | "invalid_graph"
  /** A supplied chain ID, alias, Issue number, or enum value is malformed. */
  | "invalid_input"
  /** The alias is already registered to a different chain, or shadows a chain ID. */
  | "alias_taken"
  /**
   * A caller's {@link AcceptedRevisionGuard} refused the write from inside its
   * own transaction. Distinct from `conflict`: nothing was lost to a race and a
   * retry against the same state would be refused again, so only the caller
   * that supplied the rule can say what would make it pass. `detail` carries
   * the reason it gave, verbatim.
   */
  | "guard_refused"
  /** Every deterministic ID candidate for the head Issue is already taken. */
  | "id_exhausted";

/**
 * An Issue found to be a member of some *other* chain while a write was
 * claiming it exclusively.
 *
 * Shaped to be handed straight to a graph validator as observed ownership: the
 * store reports the fact it saw, and leaves the wording of the resulting
 * operator-facing diagnostic to the policy layer that asked for the claim.
 */
export interface ChainMemberOwner {
  issueNumber: number;
  /** The other chain that already contains it. */
  chainId: string;
}

/**
 * The refusal arm every store method shares. Named so a method whose success
 * arm carries more than one value can reuse it verbatim rather than restate it.
 */
export interface ChainRegistryFailure {
  ok: false;
  code: ChainRegistryFailureCode;
  detail?: string;
  /** Present for `invalid_graph`: every violation found, not just the first. */
  errors?: ChainGraphIntegrityError[];
  /**
   * Present when a `conflict` was an
   * {@link PutChainGraphInput.exclusiveMemberScope} claim that lost: every
   * `(issue, other chain)` pair observed, in a stable order. It
   * distinguishes a lost claim from a lost compare-and-set, which need
   * different repairs.
   */
  owners?: ChainMemberOwner[];
}

export type ChainRegistryResult<T> = { ok: true; value: T } | ChainRegistryFailure;

/**
 * What {@link ChainRegistryStore.setChainRevisionState} answers: the revision
 * record as the write left it, plus the chain row's {@link ChainRecord.rev} at
 * that same instant.
 *
 * `chainRev` is reported because a revision-label write touches the chain row,
 * and a caller that needs to compare-and-set on the result of its *own* writes
 * cannot recover that number afterwards: a read taken after the write returns
 * whatever the row holds by then, which is the write's own effect plus anything
 * a concurrent writer has since added, and the two are indistinguishable. Read
 * inside the write's transaction it is exactly the revision this caller left
 * behind — which is what makes "nothing has touched this chain since I finished"
 * expressible at all.
 */
export type ChainRevisionStateResult =
  | { ok: true; value: ChainRevisionRecord; chainRev: number }
  | ChainRegistryFailure;

export interface CreateChainInput {
  sessionId: string;
  /** Head Issue; also the number the default chain ID is derived from. */
  headIssueNumber: number;
  /**
   * Explicit chain ID. Omitted, the store allocates deterministically from
   * `headIssueNumber`, walking the fixed collision sequence. Supplied and
   * already taken, the store refuses with `already_exists` rather than
   * silently allocating something else.
   */
  chainId?: string;
  title?: string;
  /**
   * Operator alias to register for the new chain, in the same transaction that
   * allocates its ID.
   *
   * Registering it afterwards through {@link ChainRegistryStore.putChainAlias}
   * cannot be made safe: IDs and aliases share one namespace, so between the
   * caller's "is this name free?" check and the registration, another creation
   * can allocate the very ID the name needs — leaving a chain that exists and is
   * accepted but can never carry the name it was created for (issue #791
   * review). Supplied here, the name is claimed by the same transaction that
   * takes the ID: it is refused with `alias_taken` if anything already holds it,
   * and no chain is created at all, so the caller's retry is a clean one.
   *
   * The allocated ID never collides with the alias — the alias counts as taken
   * while the ID is being walked — so `createChain({headIssueNumber: 11, alias:
   * "chain_11"})` yields chain `chain_11_2` aliased `chain_11` rather than a
   * chain whose own ID shadows its name.
   */
  alias?: string;
  /**
   * Initial graph. Defaults to the head as the chain's only member with no
   * edges — a one-Issue chain is a legitimate starting state.
   */
  members?: readonly ChainMemberInput[];
  edges?: readonly ChainEdgeInput[];
  /** Provenance recorded on the revision-1 record. */
  source?: string;
  now?: string;
}

export interface PutChainGraphInput {
  chainId: string;
  members: readonly ChainMemberInput[];
  edges: readonly ChainEdgeInput[];
  /** Move the head as part of the same write. Omitted, the head is unchanged. */
  headIssueNumber?: number;
  /** Compare-and-set against {@link ChainRecord.rev}. */
  expectedRev?: number;
  /**
   * Claim the written members exclusively: refuse the write if any *other*
   * chain matching this filter already contains one of them, reporting the
   * offenders as {@link ChainRegistryResult.owners}. An empty filter claims
   * them against the whole registry; omitting the field claims nothing and
   * leaves membership unconstrained, which is the pre-existing behaviour.
   *
   * The point of pushing this into the write rather than leaving it to a
   * caller's pre-check is that a pre-check is not a claim: two callers can
   * both observe an Issue as unowned and then both write it. The store
   * evaluates it inside the same transaction as the write, so exactly one of
   * two racing claims can win.
   *
   * It binds a write recognized as a no-op too. A graph already on record is
   * not a claim already held: #890 accepts an unaccepted candidate by
   * re-writing the graph it already stores, and exempting that re-write would
   * let the acceptance label and point at a revision whose members another
   * chain took after the candidate was recorded.
   */
  exclusiveMemberScope?: ChainListFilter;
  /**
   * Chains whose existing membership of the written members does NOT refuse
   * the {@link PutChainGraphInput.exclusiveMemberScope} claim. Ignored when no
   * claim is asked for.
   *
   * It exists for the one legitimate moment two chains own the same Issues: a
   * merge (#893) accepting the combined graph into the surviving chain while
   * the source chain — about to be retired — still records the members it is
   * handing over. Naming the source here keeps the claim transactional
   * ("nobody except the chains this operation names owns these members")
   * instead of forcing the caller to drop it and settle for a pre-check.
   */
  tolerateOwnerChainIds?: readonly string[];
  /**
   * Provenance recorded on the revision this write creates. Ignored when the
   * write is recognized as a no-op.
   */
  source?: string;
  note?: string;
  now?: string;
}

export interface ChainMetadataPatch {
  headIssueNumber?: number;
  /** `null` clears the title. */
  title?: string | null;
  /**
   * Register an alias for this chain as part of this same write, with exactly
   * the rules {@link ChainRegistryStore.putChainAlias} applies: re-registering
   * it to this chain is a no-op, and a name another chain holds — or that a
   * live chain ID occupies — is refused with `alias_taken`.
   *
   * It exists so a caller that must name a chain *and* go on to compare-and-set
   * on the result can do both under one `expectedRev`. Registering the alias
   * through its own call would leave a window in which another writer moves the
   * chain row, and the revision this write answers with would then describe
   * that writer's state as much as this caller's (issue #791 review).
   */
  alias?: string;
  expectedRev?: number;
  now?: string;
}

export interface ChainSyncStatePatch {
  status: ChainSyncStatus;
  /**
   * `null` clears a previously recorded error. Omitted, the recorded error is
   * carried forward only for an `error` status and cleared otherwise: a
   * successful or stale check must not keep reporting an earlier failure.
   */
  error?: string | null;
  /** Attempt timestamp; defaults to `now`. */
  checkedAt?: string;
  /**
   * Success timestamp. Omitted, it is set to `checkedAt` for an `in_sync`
   * status and left untouched otherwise — a failed attempt must not advance
   * the record of when the chain was last known good.
   */
  syncedAt?: string;
  expectedRev?: number;
  now?: string;
}

export interface ChainRevisionInput {
  chainId: string;
  revision: number;
  fingerprint: string;
  state?: ChainRevisionState;
  source?: string;
  note?: string;
  now?: string;
}

export interface ChainAliasInput {
  alias: string;
  chainId: string;
  reason?: string;
  now?: string;
}

export interface RetireChainInput {
  /** The chain being retired. */
  chainId: string;
  /** The surviving chain every retired handle is re-registered against. */
  intoChainId: string;
  /** Compare-and-set against the retired chain's {@link ChainRecord.rev}. */
  expectedRev?: number;
  /** Recorded on the alias row the retired chain ID becomes. */
  reason?: string;
  now?: string;
}

/** What one {@link ChainRegistryStore.retireChain} left behind. */
export interface ChainRetirement {
  /** The retired chain's ID — now an alias resolving to `intoChainId`. */
  chainId: string;
  intoChainId: string;
  /** Aliases that pointed at the retired chain, re-pointed. Ascending. */
  movedAliases: string[];
  /** Frozen-prefix snapshots re-recorded against `intoChainId`. */
  movedFrozenPrefixes: number;
}

export interface ChainListFilter {
  sessionId?: string;
  syncStatus?: ChainSyncStatus;
}

/** What an {@link AcceptedRevisionGuard} is handed, read in the write's transaction. */
export interface AcceptedRevisionGuardContext {
  /**
   * Every frozen prefix (#891) recorded against this chain — and against any
   * chain the caller named in `guardChainIds` — as the rows stand inside the
   * transaction about to move the pointer. Ordered by session then Issue —
   * the order #891's `listFrozenPrefixes` gives — so a guard can be handed
   * either list and behave identically.
   */
  frozenPrefixes: FrozenPrefixSnapshot[];
}

/**
 * A caller's last condition on {@link ChainRegistryStore.setAcceptedRevision},
 * evaluated *inside* the transaction that performs the write. Returning a
 * one-line reason refuses the write with `guard_refused`; returning `undefined`
 * lets it through.
 *
 * It exists because of the one constraint no compare-and-set on this store can
 * express. Freezing a dependency prefix (#891) writes no chain row, so
 * `expectedRev` cannot notice one appearing, and a caller checking the frozen
 * prefixes itself has read them by the time it asks for the pointer to move — a
 * freeze landing in between is invisible to both, and the accepted graph would
 * then drop a dependency a started task is already running against. Reading
 * those rows in the same transaction as the pointer move leaves no such window:
 * the freeze either is not there yet, in which case its own write is ordered
 * after this one and the graph it snapshots is the one this call accepted, or it
 * is there and this call is refused.
 *
 * Synchronous by necessity — a transaction cannot be held open across an
 * `await` — and pure by expectation: it is a rule applied to the context it is
 * given, not a place to perform further reads or writes. Throwing rolls the
 * transaction back, leaving the pointer where it was, and propagates to the
 * caller.
 */
export type AcceptedRevisionGuard = (
  context: AcceptedRevisionGuardContext,
) => string | undefined;

/**
 * Durable dependency-chain registry.
 *
 * Every mutating method is transaction-safe: it either applies in full or
 * leaves the registry exactly as it found it. A rejected graph, a lost
 * compare-and-set, or a mid-write failure must never leave a chain row
 * without its members, or members without the edges written alongside them.
 *
 * Where a repeat call is meaningful, it is idempotent — re-writing an
 * identical graph, re-registering an alias to the chain it already points at,
 * re-inserting a revision record with the same fingerprint, and deleting an
 * absent chain all succeed without changing anything.
 */
export interface ChainRegistryStore {
  /**
   * Opaque identity of the durable backend, matching
   * {@link import("./task-store.js").TaskStore.backendId} semantics: two
   * stores reporting the same defined value write to the same database file
   * and share one transaction domain. `undefined` when there is no shareable
   * durable backend.
   */
  readonly backendId?: string | undefined;

  createChain(input: CreateChainInput): Promise<ChainRegistryResult<ChainGraph>>;

  /** The chain and its full graph, or `undefined` if no such chain exists. */
  getChain(chainId: string): Promise<ChainGraph | undefined>;

  /** Chain metadata only, without loading members and edges. */
  getChainRecord(chainId: string): Promise<ChainRecord | undefined>;

  /**
   * The chain ID a handle refers to — the ID itself if it names a live chain,
   * otherwise the target of a matching alias. `undefined` when the handle
   * resolves to nothing.
   */
  resolveChainHandle(handle: string): Promise<string | undefined>;

  listChains(filter?: ChainListFilter): Promise<ChainRecord[]>;

  /** Every chain the Issue is a member of. Fan-in makes this a genuine list. */
  listChainsForIssue(issueNumber: number, filter?: ChainListFilter): Promise<ChainRecord[]>;

  /**
   * Replace a chain's members and edges wholesale, advancing the graph
   * revision and recording a `candidate` revision record.
   *
   * A write whose canonical fingerprint and head match what is already stored
   * is a no-op: the chain is returned unchanged, with no revision bump and no
   * new revision record.
   *
   * An implementation must evaluate
   * {@link PutChainGraphInput.exclusiveMemberScope}, when supplied, in the
   * same transaction that performs the write, and against membership as of
   * that transaction — including on the no-op path, which is a claim on the
   * stored members like any other. Evaluating it before the transaction, or
   * skipping it for a no-op, would reintroduce exactly the check-to-act gap
   * the option exists to close.
   */
  putChainGraph(input: PutChainGraphInput): Promise<ChainRegistryResult<ChainGraph>>;

  /**
   * Patch a chain's own fields — head, title, and optionally the alias of
   * {@link ChainMetadataPatch.alias} — in one transaction, bumping
   * {@link ChainRecord.rev} once. An implementation must evaluate
   * `expectedRev` and the alias claim inside that transaction, so the record it
   * answers with describes a row nothing else moved in between.
   */
  updateChainMetadata(
    chainId: string,
    patch: ChainMetadataPatch,
  ): Promise<ChainRegistryResult<ChainRecord>>;

  setChainSyncState(
    chainId: string,
    patch: ChainSyncStatePatch,
  ): Promise<ChainRegistryResult<ChainRecord>>;

  /**
   * Insert a revision record. Re-inserting `(chainId, revision)` with the same
   * fingerprint returns the stored row unchanged — including its current
   * state, which only {@link ChainRegistryStore.setChainRevisionState} moves.
   * The same revision number with a *different* fingerprint is refused with
   * `already_exists`: a revision that silently changed meaning would
   * invalidate every reference already taken to it.
   */
  putChainRevision(input: ChainRevisionInput): Promise<ChainRegistryResult<ChainRevisionRecord>>;

  /**
   * Move an existing revision record's lifecycle marker. Separated from
   * {@link ChainRegistryStore.putChainRevision} so an insert can stay
   * idempotent while a state transition (#890's decision to accept, supersede,
   * or reject) stays an explicit write.
   *
   * `unlessAcceptedRevision` applies the transition only while
   * {@link ChainRecord.acceptedRevision} does *not* name this revision; when it
   * does, nothing is written and the stored record is returned unchanged. An
   * implementation must decide it inside the write's own transaction, for the
   * same reason as {@link PutChainGraphInput.exclusiveMemberScope}: a caller
   * retracting a label it wrote can read the pointer first, but that read stops
   * being true the moment a concurrent acceptance commits the pointer onto the
   * very revision being retracted — and demoting it then would leave the
   * accepted pointer naming a revision no longer marked accepted.
   *
   * `expectedRev` compare-and-sets on {@link ChainRecord.rev}, refusing with
   * `conflict` when the chain row has moved since the caller read it. A label
   * write is bookkeeping and most callers want it applied unconditionally; it
   * matters to the ones that go on to guard a further write with the
   * `chainRev` this call answers with, because an unguarded label write folds
   * whatever a concurrent writer did before it into that number and would let
   * the follow-up overwrite a verdict newer than the caller's own. An
   * implementation must check it inside the write's own transaction, and
   * before the `unlessAcceptedRevision` no-op, so the returned `chainRev`
   * never describes a row this caller did not have pinned.
   *
   * The answer carries the chain row's revision as this write left it; see
   * {@link ChainRevisionStateResult}. It is reported even by the guarded no-op,
   * where it is simply the row as the transaction found it.
   */
  setChainRevisionState(
    chainId: string,
    revision: number,
    state: ChainRevisionState,
    options?: {
      note?: string;
      now?: string;
      unlessAcceptedRevision?: boolean;
      expectedRev?: number;
    },
  ): Promise<ChainRevisionStateResult>;

  getChainRevision(chainId: string, revision: number): Promise<ChainRevisionRecord | undefined>;

  /** Revision records for a chain, oldest first. */
  listChainRevisions(chainId: string): Promise<ChainRevisionRecord[]>;

  /**
   * Point {@link ChainRecord.acceptedRevision} at an existing revision record,
   * or clear it with `null`. Pure persistence: whether the revision *should*
   * be accepted is #890's decision, and this method does not re-check it.
   *
   * `guard` is the one exception, and it is still not this module's policy: the
   * rule is the caller's, and all an implementation does is evaluate it inside
   * the transaction that performs the write. See {@link AcceptedRevisionGuard}
   * for why a caller cannot do that for itself.
   *
   * `guardChainIds` widens what the guard is handed: frozen prefixes recorded
   * against these chains are read — in the same transaction — alongside this
   * chain's own. For the one acceptance that answers for two chains' started
   * Issues: a merge (#893) commits the combined graph into the target while a
   * freeze landing on a source Issue is still recorded against the source
   * chain, invisible to a guard handed only the target's rows. Ignored when
   * no `guard` is given.
   */
  setAcceptedRevision(
    chainId: string,
    revision: number | null,
    options?: {
      expectedRev?: number;
      now?: string;
      guard?: AcceptedRevisionGuard;
      guardChainIds?: readonly string[];
    },
  ): Promise<ChainRegistryResult<ChainRecord>>;

  /**
   * Register an alias. Re-registering it to the same chain succeeds
   * unchanged; pointing it at a different chain, or at a name a live chain ID
   * already occupies, is refused with `alias_taken`.
   */
  putChainAlias(input: ChainAliasInput): Promise<ChainRegistryResult<ChainAlias>>;

  deleteChainAlias(alias: string): Promise<ChainRegistryResult<{ alias: string; deleted: boolean }>>;

  /** Aliases for one chain, or every alias when `chainId` is omitted. */
  listChainAliases(chainId?: string): Promise<ChainAlias[]>;

  /**
   * Delete a chain and everything attached to it — members, edges, revisions,
   * aliases — in one transaction. Deleting an absent chain reports
   * `deleted: false` rather than failing.
   */
  deleteChain(
    chainId: string,
    options?: { expectedRev?: number },
  ): Promise<ChainRegistryResult<{ chainId: string; deleted: boolean }>>;

  /**
   * Retire a chain into another, in one transaction (issue #893): delete its
   * graph, members, and revision records; re-point every alias it carried at
   * the surviving chain; re-register its own ID as an alias of the survivor;
   * and re-record its frozen-prefix snapshots (#891) against the survivor,
   * contract fingerprints recomputed for the new chain handle.
   *
   * The alias is what keeps a retired chain resolvable: `resolveChainHandle`
   * answers the survivor's ID for every handle the retired chain ever had, so
   * an operator's notes and commands keep working, deterministically. The
   * pieces cannot be composed from `deleteChain` + `putChainAlias`: the ID is
   * only free to become an alias once the chain row is gone, and a failure
   * between the two would leave the retired chain's handles resolving to
   * nothing at all.
   *
   * Retiring a chain into itself or into an absent chain is refused; the
   * retired chain must exist (`not_found` otherwise — retirement is not
   * idempotent, because a second call cannot tell "already retired" from
   * "never existed", and the caller can).
   */
  retireChain(input: RetireChainInput): Promise<ChainRegistryResult<ChainRetirement>>;
}
