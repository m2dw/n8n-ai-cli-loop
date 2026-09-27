/**
 * The durable ChatOps state port (issue #1024).
 *
 * The component contracts deliberately define no schema — each says so
 * explicitly and defers to "the successor that adds `chatops_*` tables"
 * (`docs/chatops-comment-cursor-contract.md` §12,
 * `docs/chatops-execution-ledger-contract.md` §15). This module is that
 * successor's *port*: the shape a store must offer for the runtime to satisfy
 * the four transaction boundaries the ledger contract fixes (§8), stated
 * independently of SQLite so the runtime can be driven by an in-memory fake.
 *
 * The one property the whole chain rests on is atomicity, and it is expressed
 * here rather than left to a caller's ordering discipline:
 *
 * - **T1** — first-seen inserts, the cursor advance, and *one ledger row per
 *   candidate* commit together. Committing the cursor without the rows would
 *   leave a comment that is neither a candidate nor tracked — a permanently
 *   invisible command.
 * - **T2** — the dispatch epoch bump and the `→ dispatching` write-ahead commit
 *   together, before any external call. {@link ChatOpsStore.commitWithEpoch} is
 *   the only way to read a new epoch, so an epoch can never be allocated
 *   without the row that spends it.
 * - **T3/T4** — the outcome commit (and the summary outbox effect and audit
 *   record it carries) commit together, so a restart replays byte-identical
 *   text rather than re-deriving it (`docs/chatops-result-contract.md` §10.1).
 *
 * Everything is keyed by the opaque identity key
 * (`docs/chatops-identity-contract.md` §6) plus the work item — never by a
 * session alias, a `sessionNo`, or a local path.
 */

import type { OutboxEnqueueInput } from "./outbox.js";
import type {
  ChatOpsCursorState,
  ChatOpsFirstSeenRecord,
} from "./chatops-comment-cursor.js";
import type {
  ChatOpsLedgerHandoffReason,
  ChatOpsLedgerRow,
} from "./chatops-execution-ledger.js";
import type { ChatOpsAuditRecord } from "./chatops-result.js";

/** One cursor/ledger scope: an identity plus the work item it applies to. */
export interface ChatOpsScope {
  /** `chatOpsIdentityKey(identity)` — the joined, injective scope key. */
  identityKey: string;
  issueNumber: number;
}

/**
 * A durable fence (`docs/chatops-execution-ledger-contract.md` §12).
 *
 * Session-grain fences come from the epoch witness (§9.2); issue-grain fences
 * come from §11's regression predicate. Both are stored, because a fence is
 * cleared "only by an explicit operator action that names the scope and is
 * recorded durably" — a fence that evaporated because the next pass happened
 * not to re-derive it would be a silent replay path with a delay.
 */
export interface ChatOpsFenceRecord {
  reason: ChatOpsLedgerHandoffReason;
  /** Bounded operator-facing detail. Never a comment body. */
  detail: string | null;
  fencedAt: string;
}

/** Which grain a fence write addresses. */
export type ChatOpsFenceGrain = "session" | "issue";

/**
 * One in-flight acknowledgement publication (T4).
 *
 * `docs/chatops-execution-ledger-contract.md` §15 requires every transition to
 * be a guarded compare-and-set, but T4's external half — the marker post —
 * happens *between* two transactions, and the ledger row does not move until
 * after it returns (§8). Two overlapping passes can therefore both load the
 * same `awaiting_ack`/`pending` row and both post, producing two markers for
 * one command. This record is the pre-post reservation that closes that
 * window: it is taken in its own transaction before the post and released in
 * the transaction that records the result, so exactly one pass owns a
 * publication attempt.
 *
 * It carries no policy — rows 17-19 still decide what a post's result means,
 * and `ackAttempts` is still the only publication counter (§10.1 of
 * `docs/chatops-result-contract.md`: this adds no new attempt counter and no
 * new bound). A reservation that outlives its pass means the post is
 * *unconfirmed*, exactly like a dropped claim-marker post, and the next pass
 * settles it as one failed attempt rather than assuming either outcome.
 */
export interface ChatOpsAckReservation {
  commentId: string;
  /** The row's `ackAttempts` when the reservation was taken — diagnostic only. */
  ackAttempts: number;
  reservedAt: string;
}

export interface ChatOpsFenceWrite {
  grain: ChatOpsFenceGrain;
  /** `null` clears the fence — only ever written by an explicit operator action. */
  record: ChatOpsFenceRecord | null;
}

/**
 * Both fence grains as one transaction sees them.
 *
 * A fence bars *new execution* (§12), and the moment a dispatch becomes new
 * execution is the write-ahead — so the fence has to be read by the same
 * transaction that writes it, not by the pass that opened long before. An
 * overlapping pass's reconciliation can commit an issue fence at any point
 * after this pass reconciled, and a write-ahead decided from the pre-fence
 * snapshot would invoke the operation the fence exists to stop.
 */
export interface ChatOpsPersistedFences {
  issue: ChatOpsFenceRecord | null;
  session: ChatOpsFenceRecord | null;
}

/** Everything one pass needs to know about a scope before it decides anything. */
export interface ChatOpsScopeState {
  cursor: ChatOpsCursorState;
  rows: readonly ChatOpsLedgerRow[];
  /**
   * First-seen records for comments that have **no ledger row**.
   *
   * Normally empty: T1 writes a row for every candidate in the same
   * transaction. It is non-empty exactly when a fenced scope recorded discovery
   * but could not write a claim (`docs/chatops-execution-ledger-contract.md`
   * §7 row 3, §12 — a fenced scope "writes no new claims" yet "keeps recording
   * first-seen rows and cursor progress"). Those comments have fallen below the
   * cursor and will never appear in a scan window again, so without this list
   * clearing the fence would leave them permanently un-dispatched — the exact
   * skip `docs/chatops-comment-cursor-contract.md` I1 forbids.
   */
  pendingFirstSeen: readonly ChatOpsFirstSeenRecord[];
  /**
   * Acknowledgement publications reserved but not yet settled.
   *
   * Normally empty: a pass releases its reservation in the same transaction
   * that records the post's result. A non-empty entry means a pass died between
   * the two, so the marker may or may not be on the provider — see
   * {@link ChatOpsAckReservation}.
   */
  ackReservations: readonly ChatOpsAckReservation[];
  /** The issue-grain fence, or `null`. */
  issueFence: ChatOpsFenceRecord | null;
  /** The session-grain fence, or `null`. */
  sessionFence: ChatOpsFenceRecord | null;
  /**
   * When this scope was last written, or `null` when it has never been.
   *
   * Diagnostic only — nothing decides anything from it. It exists so an
   * operator can answer "when did the last bounded run touch this scope" from
   * the read-only status surface instead of opening the database, which is the
   * one question the ledger row's own fields cannot answer.
   */
  lastActivityAt: string | null;
}

/** One atomic write. Every field is optional; whatever is present commits together. */
export interface ChatOpsCommitInput {
  /** The whole §4.1 cursor row (position *and* initialization sentinel). */
  cursor?: ChatOpsCursorState;
  /** Insert-only; a collision with an existing record is a re-observation, never an overwrite. */
  firstSeen?: readonly ChatOpsFirstSeenRecord[];
  /** Ledger rows to upsert, keyed by `commentId` within the scope. */
  rows?: readonly ChatOpsLedgerRow[];
  /** Append-only audit records (`docs/chatops-result-contract.md` §9.1). */
  audit?: readonly ChatOpsAuditRecord[];
  /** Outbox effects enqueued in this same transaction (§10.1). */
  effects?: readonly OutboxEnqueueInput[];
  fence?: ChatOpsFenceWrite;
  /**
   * Acknowledgement-publication reservations to release, by `commentId`.
   *
   * Released in the same transaction that records what the post did, so a
   * reservation outlives its pass exactly when the result was never recorded.
   * Releasing one that is not held is a no-op, never an error: the settlement
   * of a reservation another pass has already settled must still commit.
   */
  releaseAckReservations?: readonly string[];
}

/**
 * The durable ChatOps state a bounded pass reads and writes.
 *
 * Implementations own their transactions; the runtime never opens one. Reads
 * are deliberately whole-scope rather than row-at-a-time: reconciliation (§11)
 * compares every row in a fence scope against one window's evidence, so a
 * partial read could fence on a sample rather than the extent of the damage.
 *
 * A write may refuse because the backing store is under maintenance — a
 * `prune`/`restore` holding the file-level exclusion lock (issue #818,
 * `docs/retention-backup-contract.md` §9). Implementations signal that by
 * **throwing** an error carrying `code: "maintenance_locked"`, checked inside
 * the same transaction as the write it guards. It is deliberately not one of the
 * falsy returns below: those mean "this build decided to commit nothing", which
 * a caller treats as a settled, correct outcome, whereas a refusal means the
 * decision has not been made yet and the pass must be re-run. `runChatOpsPass`
 * translates it into the `delayed` disposition rather than propagating it, so a
 * maintenance window is a retryable no-op and never a partially-executed pass.
 */
export interface ChatOpsStore {
  /** See {@link OutboxStore.backendId}: equal, defined ids mean effects commit with the rows. */
  readonly backendId?: string | undefined;

  /** The session's dispatch epoch (`docs/chatops-execution-ledger-contract.md` §9.2). */
  getEpoch(identityKey: string): Promise<number>;

  /** Everything one pass needs about one scope. */
  loadScope(scope: ChatOpsScope): Promise<ChatOpsScopeState>;

  /**
   * One comment's immutable first-seen record — the input recognition is a
   * deterministic function of (#777 §6, #781 §9).
   */
  getFirstSeen(scope: ChatOpsScope, commentId: string): Promise<ChatOpsFirstSeenRecord | undefined>;

  /** Work items this identity already has ChatOps state for, ascending. */
  listIssueNumbers(identityKey: string): Promise<number[]>;

  /** Commit one atomic write. */
  commit(scope: ChatOpsScope, input: ChatOpsCommitInput): Promise<void>;

  /**
   * Commit one atomic write decided from the rows the transaction itself reads.
   *
   * The same serialization {@link ChatOpsStore.commitWithEpoch} provides, minus
   * the epoch bump: `build` receives the scope's ledger rows **as the
   * transaction sees them**, re-read after the write lock was taken, and returns
   * the write to apply or `null` to commit nothing.
   *
   * Reconciliation (§11) needs this for the same reason dispatch does. Its
   * verdicts are a function of the ledger rows, and a pass that decided them
   * from its own scan snapshot would upsert that snapshot over whatever an
   * overlapping pass committed in between — turning a row another pass had
   * already dispatched and completed back into `ambiguous`, which later
   * reconciliation skips, parking a finished command for manual recovery.
   * Deciding inside the transaction means a verdict is always applied to the
   * state it was derived from.
   *
   * `fences` is re-read the same way, so a build that may begin execution can
   * see a fence an overlapping pass committed after its caller's `loadScope`
   * (§12).
   *
   * `build` is synchronous and must not perform I/O — it runs inside the
   * transaction. Resolves to whether anything was committed.
   */
  commitCompareAndSwap(
    scope: ChatOpsScope,
    build: (
      persisted: readonly ChatOpsLedgerRow[],
      fences: ChatOpsPersistedFences,
    ) => ChatOpsCommitInput | null,
  ): Promise<boolean>;

  /**
   * T2's write-ahead: bump the session dispatch epoch and commit whatever
   * `build` produces from the new value, in one transaction.
   *
   * `build` is synchronous and must not perform I/O — it runs inside the
   * transaction. Returning `null` aborts the write (nothing is committed and
   * the epoch is not consumed), which is how a caller declines a dispatch after
   * seeing the row the transaction actually read.
   *
   * That last clause is the whole point of `persisted`: it is the scope's ledger
   * rows **as the transaction sees them**, re-read after the write lock was
   * taken, not the copy the caller loaded at the top of its pass. Two overlapping
   * passes both load a `claimed` row; without a re-read each would apply
   * `begin-dispatch` to its own stale copy and invoke the operation, which is
   * exactly the double execution `docs/chatops-execution-ledger-contract.md` §8
   * forbids. Implementations must therefore serialize these transactions and
   * pass the post-serialization rows, so a caller can compare and decline.
   *
   * `fences` is re-read the same way and for the same reason: a fence commits in
   * an ordinary transaction like any other write, so an overlapping pass can
   * fence the scope between this pass's reconciliation and its write-ahead. A
   * write-ahead decided from the caller's pre-fence snapshot would begin exactly
   * the new execution a fence forbids (§12).
   */
  commitWithEpoch(
    scope: ChatOpsScope,
    build: (
      epoch: number,
      persisted: readonly ChatOpsLedgerRow[],
      fences: ChatOpsPersistedFences,
    ) => ChatOpsCommitInput | null,
  ): Promise<number | null>;

  /**
   * Take the acknowledgement-publication reservation for one comment, or
   * decline — T4's pre-post compare-and-set.
   *
   * In one transaction: re-read the reservation and the ledger row, refuse if a
   * reservation is already held, otherwise ask `accept` — which receives the
   * row **as the transaction sees it**, or `undefined` when there is none —
   * whether this publication is still the caller's to make. Resolves to whether
   * the reservation was taken; only the caller that got `true` may post.
   *
   * `accept` is synchronous and must not perform I/O — it runs inside the
   * transaction. It holds the policy (which states may publish, and whether the
   * row is still the version the caller read) so this port keeps none: the same
   * split `commitCompareAndSwap` uses.
   */
  reserveAckPublication(
    scope: ChatOpsScope,
    commentId: string,
    accept: (persisted: ChatOpsLedgerRow | undefined) => boolean,
  ): Promise<boolean>;

  /** Audit records for a scope, in emission order (§9.1's "most recently emitted" rule). */
  listAudit(scope: ChatOpsScope, commentId?: string): Promise<ChatOpsAuditRecord[]>;

  close(): void;
}
