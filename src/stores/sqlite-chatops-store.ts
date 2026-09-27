/**
 * SQLite-backed ChatOps state (issue #1024).
 *
 * The `chatops_*` tables the component contracts deferred to a successor:
 * `docs/chatops-comment-cursor-contract.md` §12 (cursor + first-seen),
 * `docs/chatops-execution-ledger-contract.md` §15 (ledger + epoch), and
 * `docs/chatops-result-contract.md` §9.1 (the audit record that durably carries
 * the closed `reason`).
 *
 * Two schema rules both contracts state and this file implements literally:
 *
 * - **Keyed by #780 §6's columns, not an opaque joined string.** The identity
 *   tuple is stored as five separate columns plus `issue_number` (and, for the
 *   ledger and first-seen grains, `comment_id`). The joined key exists too, as
 *   a derived lookup column — it is what the runtime addresses a scope by — but
 *   the typed columns are what a future migration reads, so a field-set change
 *   orphans an old scope rather than reinterpreting it (#780 §7).
 * - **First-seen rows are insert-only.** `INSERT OR IGNORE`, never an upsert: a
 *   collision is a re-observation resolved by `reconcileChatOpsFirstSeen`, and
 *   an overwrite would convert "we saw this unedited" into a copy of an edit.
 *
 * The `outbox` table is created here as well, with the same
 * `CREATE TABLE IF NOT EXISTS` DDL every other store on this file uses, so a
 * summary effect can be enqueued **inside** the same transaction as the ledger
 * transition that produced it (`docs/chatops-result-contract.md` §10.1). That
 * is not a second outbox implementation: rows are written in exactly the shape
 * `SqliteOutboxStore.enqueue` writes, and the ordinary `dispatch-outbox` run
 * drains them — which is also why the shared outbox migrations run here. On a
 * database created by an older build, `outbox` predates `idempotency_key` and
 * the later delivery columns, and `CREATE TABLE IF NOT EXISTS` leaves such a
 * table exactly as it found it; `chatops-scan` opens this store *without*
 * opening `SqliteTaskStore` or `SqliteOutboxStore` first, so nothing else on
 * that path would upgrade it and the first summary effect would fail its INSERT
 * after the command had already been claimed.
 *
 * Every mutating path also reads the maintenance lock **inside** its own
 * transaction (issue #818, `docs/retention-backup-contract.md` §9). ChatOps runs
 * ahead of the outbox dispatcher in the scheduled child workflow, so without
 * this a pass could write ledger rows, enqueue effects, or post a claim marker
 * against a file a `prune`/`restore` is in the middle of replacing — losing the
 * state that proves the command was claimed while its external effect had
 * already happened.
 */

import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import { resolveHomeDir } from "../core/home-dir.js";
import type {
  ChatOpsCommitInput,
  ChatOpsFenceRecord,
  ChatOpsPersistedFences,
  ChatOpsScope,
  ChatOpsScopeState,
  ChatOpsStore,
} from "../core/chatops-store.js";
import type { ChatOpsCursorState, ChatOpsFirstSeenRecord } from "../core/chatops-comment-cursor.js";
import { CHATOPS_UNINITIALIZED_CURSOR_STATE } from "../core/chatops-comment-cursor.js";
import type { ChatOpsLedgerRow } from "../core/chatops-execution-ledger.js";
import type { ChatOpsAuditRecord } from "../core/chatops-result.js";
import { sqliteBackendId } from "./sqlite-backend-id.js";
import { isMaintenanceLockHeld, MaintenanceLockedError } from "./maintenance-lock-guard.js";
import {
  migrateOutboxTable,
  migrateOutboxRetryColumns,
  migrateOutboxCancelColumn,
  migrateOutboxClaimColumn,
} from "./outbox-migration.js";

export const DEFAULT_DB_PATH = join(resolveHomeDir(), ".config", "n8n-ai-cli-loop", "dev_loop.db");

/** Same 30s budget the sibling stores use; see sqlite-issue-activation-store.ts. */
const BUSY_TIMEOUT_MS = 30_000;

const PRAGMAS = `
PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};
`;

/**
 * `issue_number` for a **session-grain** fence
 * (`docs/chatops-execution-ledger-contract.md` §9.2's epoch-witness detector,
 * which fences every scope for the session).
 *
 * `-1` rather than `NULL`: the column is part of the primary key, and SQLite
 * treats `NULL`s as distinct in a unique index, so a nullable spelling would
 * silently permit two session fences. Real work-item numbers are positive
 * (`validateOperationContext` refuses anything else), so `-1` can never collide
 * with an issue-grain fence.
 */
const SESSION_FENCE_ISSUE_NUMBER = -1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS chatops_cursor (
  identity_key       TEXT NOT NULL,
  issue_number       INTEGER NOT NULL,
  session_id         TEXT NOT NULL,
  provider           TEXT NOT NULL,
  provider_endpoint  TEXT NOT NULL,
  provider_owner     TEXT NOT NULL,
  provider_repo      TEXT NOT NULL,
  initialized        INTEGER NOT NULL,
  cursor_created_at  TEXT,
  cursor_created_ms  INTEGER,
  cursor_comment_id  TEXT,
  updated_at         TEXT NOT NULL,
  PRIMARY KEY (identity_key, issue_number)
);

CREATE TABLE IF NOT EXISTS chatops_first_seen (
  identity_key   TEXT NOT NULL,
  issue_number   INTEGER NOT NULL,
  comment_id     TEXT NOT NULL,
  author         TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  body           TEXT,
  body_length    INTEGER NOT NULL,
  body_sha256    TEXT NOT NULL,
  bootstrap      INTEGER NOT NULL,
  recorded_at    TEXT NOT NULL,
  PRIMARY KEY (identity_key, issue_number, comment_id)
);

CREATE TABLE IF NOT EXISTS chatops_ledger (
  identity_key         TEXT NOT NULL,
  issue_number         INTEGER NOT NULL,
  comment_id           TEXT NOT NULL,
  state                TEXT NOT NULL,
  outcome              TEXT,
  attempts             INTEGER NOT NULL,
  epoch                INTEGER,
  attempt_started_ms   INTEGER,
  ack_publication      TEXT NOT NULL,
  ack_attempts         INTEGER NOT NULL,
  reconcile_attempts   INTEGER NOT NULL,
  evidence             TEXT NOT NULL,
  evidence_truncated   INTEGER NOT NULL,
  evidence_claims      INTEGER NOT NULL,
  evidence_acks        INTEGER NOT NULL,
  handoff              TEXT,
  detail               TEXT,
  updated_at           TEXT NOT NULL,
  PRIMARY KEY (identity_key, issue_number, comment_id)
);

-- T4's pre-post reservation (see ChatOpsAckReservation). One row per comment,
-- so the INSERT itself is the mutual exclusion: a second pass's insert conflicts
-- and it declines rather than posting a duplicate marker.
CREATE TABLE IF NOT EXISTS chatops_ack_reservation (
  identity_key  TEXT NOT NULL,
  issue_number  INTEGER NOT NULL,
  comment_id    TEXT NOT NULL,
  ack_attempts  INTEGER NOT NULL,
  reserved_at   TEXT NOT NULL,
  PRIMARY KEY (identity_key, issue_number, comment_id)
);

CREATE TABLE IF NOT EXISTS chatops_epoch (
  identity_key  TEXT NOT NULL PRIMARY KEY,
  epoch         INTEGER NOT NULL
);

-- Where the next capped scan starts (see resolveIssueNumbers in
-- cli/chatops-scan.ts). Scheduling metadata, deliberately *not* ledger state: it
-- decides nothing about what a pass may do to a command, only which scopes one
-- bounded pass looks at, so no transition ever reads it and losing it costs
-- nothing but one un-rotated pass.
CREATE TABLE IF NOT EXISTS chatops_scan_rotation (
  identity_key       TEXT NOT NULL PRIMARY KEY,
  next_issue_number  INTEGER NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chatops_fence (
  identity_key  TEXT NOT NULL,
  issue_number  INTEGER NOT NULL,
  reason        TEXT NOT NULL,
  detail        TEXT,
  fenced_at     TEXT NOT NULL,
  PRIMARY KEY (identity_key, issue_number)
);

CREATE TABLE IF NOT EXISTS chatops_audit (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  identity_key   TEXT NOT NULL,
  issue_number   INTEGER NOT NULL,
  comment_id     TEXT NOT NULL,
  request_id     TEXT,
  actor_id       TEXT NOT NULL,
  operation_id   TEXT,
  row_number     INTEGER NOT NULL,
  kind           TEXT NOT NULL,
  dispatched     INTEGER NOT NULL,
  reason         TEXT,
  recorded_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS chatops_audit_scope
  ON chatops_audit (identity_key, issue_number, comment_id, id);

-- Shared with stores/sqlite-outbox-store.ts and stores/sqlite-task-store.ts:
-- created here too so a ChatOps transition can enqueue its summary effect in
-- the same transaction, whichever store opened this file first.
CREATE TABLE IF NOT EXISTS outbox (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  idempotency_key   TEXT NOT NULL UNIQUE,
  topic             TEXT NOT NULL,
  payload           TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  sent_at           TEXT,
  attempt_count     INTEGER NOT NULL DEFAULT 0,
  last_error        TEXT,
  next_attempt_at   TEXT,
  dead_letter_at    TEXT,
  cancelled_at      TEXT,
  claimed_at        TEXT
);
`;

/** Block the calling thread; the constructor this serves is synchronous. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isBusyError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  if (typeof code === "string" && code.startsWith("SQLITE_BUSY")) return true;
  const message = (err as { message?: unknown } | null | undefined)?.message;
  return typeof message === "string" && /database is locked|SQLITE_BUSY/i.test(message);
}

const WAL_RETRY_BACKOFF_MS: readonly number[] = [10, 25, 50, 100, 200, 250];

/** See sqlite-issue-activation-store.ts for why this retries rather than relying on `busy_timeout`. */
function enableWalMode(db: Database.Database): void {
  const deadline = Date.now() + BUSY_TIMEOUT_MS;
  for (let attempt = 0; ; attempt += 1) {
    try {
      db.exec("PRAGMA journal_mode = WAL;");
      return;
    } catch (err: unknown) {
      if (!isBusyError(err) || Date.now() >= deadline) throw err;
      sleepSync(WAL_RETRY_BACKOFF_MS[Math.min(attempt, WAL_RETRY_BACKOFF_MS.length - 1)]);
    }
  }
}

/** The five identity columns, parsed back out of the injective joined key. */
interface IdentityColumns {
  sessionId: string;
  provider: string;
  providerEndpoint: string;
  providerOwner: string;
  providerRepo: string;
}

/**
 * Recover the typed columns from `chatOpsIdentityKey`'s JSON array.
 *
 * The joined key is the runtime's addressing handle; the columns are what
 * #780 §7 requires a persisted schema to key by. Deriving one from the other
 * here keeps the store's own API to a single string while still writing the
 * typed columns, so the two can never drift.
 */
function identityColumns(identityKey: string): IdentityColumns {
  let parsed: unknown;
  try {
    parsed = JSON.parse(identityKey);
  } catch {
    parsed = null;
  }
  if (!Array.isArray(parsed) || parsed.length < 5 || parsed.some((p) => typeof p !== "string")) {
    throw new Error(
      "ChatOps identity key must be the JSON array chatOpsIdentityKey() produces (five strings)",
    );
  }
  const [sessionId, provider, providerEndpoint, providerOwner, providerRepo] = parsed as string[];
  return { sessionId, provider, providerEndpoint, providerOwner, providerRepo };
}

interface CursorRow {
  initialized: number;
  cursor_created_at: string | null;
  cursor_created_ms: number | null;
  cursor_comment_id: string | null;
}

function toCursorState(row: CursorRow | undefined): ChatOpsCursorState {
  if (!row) return CHATOPS_UNINITIALIZED_CURSOR_STATE;
  const hasPosition =
    row.cursor_created_at !== null &&
    row.cursor_created_ms !== null &&
    row.cursor_comment_id !== null;
  return {
    initialized: row.initialized === 1,
    cursor: hasPosition
      ? {
          createdAtMs: row.cursor_created_ms as number,
          createdAt: row.cursor_created_at as string,
          commentId: row.cursor_comment_id as string,
        }
      : null,
  };
}

interface LedgerRawRow {
  comment_id: string;
  state: string;
  outcome: string | null;
  attempts: number;
  epoch: number | null;
  attempt_started_ms: number | null;
  ack_publication: string;
  ack_attempts: number;
  reconcile_attempts: number;
  evidence: string;
  evidence_truncated: number;
  evidence_claims: number;
  evidence_acks: number;
  handoff: string | null;
  detail: string | null;
}

function toLedgerRow(raw: LedgerRawRow): ChatOpsLedgerRow {
  return {
    commentId: raw.comment_id,
    state: raw.state as ChatOpsLedgerRow["state"],
    outcome: raw.outcome as ChatOpsLedgerRow["outcome"],
    attempts: raw.attempts,
    epoch: raw.epoch,
    attemptStartedAtMs: raw.attempt_started_ms,
    ackPublication: raw.ack_publication as ChatOpsLedgerRow["ackPublication"],
    ackAttempts: raw.ack_attempts,
    reconcileAttempts: raw.reconcile_attempts,
    evidence: JSON.parse(raw.evidence) as ChatOpsLedgerRow["evidence"],
    evidenceTruncated: raw.evidence_truncated === 1,
    evidenceClaims: raw.evidence_claims,
    evidenceAcks: raw.evidence_acks,
    handoff: raw.handoff === null ? null : (JSON.parse(raw.handoff) as ChatOpsLedgerRow["handoff"]),
    detail: raw.detail,
  };
}

interface FirstSeenRawRow {
  comment_id: string;
  author: string;
  created_at: string;
  updated_at: string;
  body: string | null;
  body_length: number;
  body_sha256: string;
  bootstrap: number;
}

function toFirstSeen(raw: FirstSeenRawRow): ChatOpsFirstSeenRecord {
  return {
    commentId: raw.comment_id,
    author: raw.author,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    body: raw.body,
    bodyLength: raw.body_length,
    bodySha256: raw.body_sha256,
    bootstrap: raw.bootstrap === 1,
  };
}

interface FenceRawRow {
  reason: string;
  detail: string | null;
  fenced_at: string;
}

function toFence(raw: FenceRawRow | undefined): ChatOpsFenceRecord | null {
  if (!raw) return null;
  return {
    reason: raw.reason as ChatOpsFenceRecord["reason"],
    detail: raw.detail,
    fencedAt: raw.fenced_at,
  };
}

/**
 * Open an existing ChatOps database without initializing anything.
 *
 * SQLite's own `readonly` flag is tried first, because it is the only way to
 * make "writes nothing" a property of the connection rather than of caller
 * discipline. It is not always available: a WAL database whose `-shm` file is
 * absent (every writer closed cleanly) cannot always be opened read-only,
 * because materializing the shared-memory index is itself a write. Rather than
 * let a diagnostic command fail on a detail of when the last writer exited, that
 * case falls back to an ordinary connection that runs **no** DDL and **no**
 * `journal_mode` change — the two things that would otherwise mutate a file the
 * caller only meant to read.
 */
function openExistingDatabase(resolved: string): Database.Database {
  if (!existsSync(resolved)) {
    throw new Error(
      `ChatOps state database does not exist: ${resolved}. Read-only inspection ` +
        `never creates one; run a ChatOps pass (chatops-scan) first, or point ` +
        `--db-path at the database this session actually uses.`,
    );
  }
  let db: Database.Database;
  try {
    db = new Database(resolved, { readonly: true, fileMustExist: true });
  } catch {
    db = new Database(resolved, { fileMustExist: true });
  }
  db.exec(PRAGMAS);
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chatops_ledger'")
    .get() as { name: string } | undefined;
  if (table === undefined) {
    db.close();
    throw new Error(
      `ChatOps state database ${resolved} has no ChatOps tables yet. Read-only ` +
        `inspection never creates them; this session has not completed a ChatOps pass.`,
    );
  }
  return db;
}

export interface SqliteChatOpsStoreOptions {
  /**
   * Open an existing database for inspection only: no directory is created, no
   * DDL runs, `journal_mode` is left exactly as found, and every write method
   * throws.
   *
   * `chatops-status` documents itself as strictly read-only
   * (`docs/chatops-operations.md` §6), and a status command that brought a
   * database into existence in order to report that it was empty would be a
   * diagnosis that changed what it diagnosed. Refusing a missing database is the
   * honest answer, not a degraded one.
   */
  readOnly?: boolean;
}

export class SqliteChatOpsStore implements ChatOpsStore {
  readonly #db: Database.Database;
  readonly #readOnly: boolean;
  readonly backendId: string | undefined;

  constructor(dbPath?: string, options: SqliteChatOpsStoreOptions = {}) {
    const resolved = dbPath ?? DEFAULT_DB_PATH;
    this.#readOnly = options.readOnly === true;
    if (this.#readOnly) {
      this.#db = openExistingDatabase(resolved);
    } else {
      mkdirSync(join(resolved, ".."), { recursive: true });
      this.#db = new Database(resolved);
      this.#db.exec(PRAGMAS);
      enableWalMode(this.#db);
      // The shared `outbox` upgrades, in the same order `SqliteTaskStore` and
      // `SqliteOutboxStore` run them: the UNIQUE-key rebuild *before* the
      // CREATE TABLE IF NOT EXISTS that would otherwise leave a legacy table
      // untouched, then the additive delivery columns. All four are guarded and
      // idempotent, so on a file either of those stores already upgraded — or a
      // file this store creates fresh — they find nothing to do.
      migrateOutboxTable(this.#db);
      // One `BEGIN IMMEDIATE` around the whole DDL so two processes opening the
      // same file serialize on SQLite's write lock instead of racing — the same
      // shape sqlite-issue-activation-store.ts uses and for the same reason.
      this.#db.transaction(() => {
        this.#db.exec(SCHEMA);
      }).immediate();
      migrateOutboxRetryColumns(this.#db);
      migrateOutboxCancelColumn(this.#db);
      migrateOutboxClaimColumn(this.#db);
    }
    this.backendId = sqliteBackendId(resolved);
  }

  /** {@link SqliteChatOpsStoreOptions.readOnly}, as a named constructor. */
  static openReadOnly(dbPath?: string): SqliteChatOpsStore {
    return new SqliteChatOpsStore(dbPath, { readOnly: true });
  }

  close(): void {
    this.#db.close();
  }

  /** Guards every write path so a read-only store fails loudly, never partially. */
  #assertWritable(operation: string): void {
    if (this.#readOnly) {
      throw new Error(`ChatOps store was opened read-only; ${operation} is not available`);
    }
  }

  /**
   * Refuse a mutation while a maintenance lock is held (issue #818,
   * `docs/retention-backup-contract.md` §9).
   *
   * Called from *inside* the transaction it guards, never before one: a
   * maintenance `acquire()` is itself an IMMEDIATE transaction against this same
   * file, so SQLite's writer serialization is what makes the two mutually
   * exclusive. An independently-timed pre-check would leave the check-to-act gap
   * where a pass writes a ledger row — or enqueues the summary effect for a
   * command it is about to execute — into a file `restore` is already replacing,
   * silently losing the only durable record that the command was claimed.
   *
   * Throws for the reason {@link MaintenanceLockedError} documents: the port's
   * own falsy returns (`commitWithEpoch`'s `null`, `commitCompareAndSwap`'s
   * `false`) already mean "this build decided to write nothing", and reusing them
   * for a refusal would report a routine, correct decline for state that was
   * never persisted. Callers that must keep running translate the typed error
   * into a retryable disposition instead — `runChatOpsPass` reports `delayed`.
   */
  #assertUnlocked(operation: string): void {
    if (isMaintenanceLockHeld(this.#db)) throw new MaintenanceLockedError(`ChatOps ${operation}`);
  }

  /**
   * Whether a maintenance lock is currently held on this database file.
   *
   * A point-in-time read for a caller that needs to *report* contention before it
   * starts — `chatops-scan`'s fail-closed pre-check — never a substitute for the
   * in-transaction guard the mutators apply, which is what makes the exclusion
   * atomic. Mirrors {@link SqliteOutboxStore.isMaintenanceLocked}.
   */
  async isMaintenanceLocked(): Promise<boolean> {
    return isMaintenanceLockHeld(this.#db);
  }

  async getEpoch(identityKey: string): Promise<number> {
    const row = this.#db
      .prepare("SELECT epoch FROM chatops_epoch WHERE identity_key = ?")
      .get(identityKey) as { epoch: number } | undefined;
    return row?.epoch ?? 0;
  }

  async loadScope(scope: ChatOpsScope): Promise<ChatOpsScopeState> {
    const cursorRow = this.#db
      .prepare(
        `SELECT initialized, cursor_created_at, cursor_created_ms, cursor_comment_id
           FROM chatops_cursor WHERE identity_key = ? AND issue_number = ?`,
      )
      .get(scope.identityKey, scope.issueNumber) as CursorRow | undefined;

    const ledger = this.#db
      .prepare(
        `SELECT * FROM chatops_ledger WHERE identity_key = ? AND issue_number = ?
         ORDER BY comment_id`,
      )
      .all(scope.identityKey, scope.issueNumber) as LedgerRawRow[];

    // First-seen records with no ledger row: a fenced scope's deferred claims
    // (see ChatOpsScopeState.pendingFirstSeen). Ordered by creation so a pass
    // processes them in the same order the comments were written.
    const pending = this.#db
      .prepare(
        `SELECT f.* FROM chatops_first_seen f
          WHERE f.identity_key = ? AND f.issue_number = ? AND f.bootstrap = 0
            AND NOT EXISTS (
              SELECT 1 FROM chatops_ledger l
               WHERE l.identity_key = f.identity_key
                 AND l.issue_number = f.issue_number
                 AND l.comment_id = f.comment_id)
          ORDER BY f.created_at, LENGTH(f.comment_id), f.comment_id`,
      )
      .all(scope.identityKey, scope.issueNumber) as FirstSeenRawRow[];

    const reservations = this.#db
      .prepare(
        `SELECT comment_id, ack_attempts, reserved_at FROM chatops_ack_reservation
          WHERE identity_key = ? AND issue_number = ?
          ORDER BY LENGTH(comment_id), comment_id`,
      )
      .all(scope.identityKey, scope.issueNumber) as Array<{
      comment_id: string;
      ack_attempts: number;
      reserved_at: string;
    }>;

    const issueFence = this.#db
      .prepare("SELECT reason, detail, fenced_at FROM chatops_fence WHERE identity_key = ? AND issue_number = ?")
      .get(scope.identityKey, scope.issueNumber) as FenceRawRow | undefined;
    const sessionFence = this.#db
      .prepare("SELECT reason, detail, fenced_at FROM chatops_fence WHERE identity_key = ? AND issue_number = ?")
      .get(scope.identityKey, SESSION_FENCE_ISSUE_NUMBER) as FenceRawRow | undefined;

    const activity = this.#db
      .prepare(
        `SELECT MAX(updated_at) AS last FROM (
           SELECT updated_at FROM chatops_cursor WHERE identity_key = ? AND issue_number = ?
           UNION ALL
           SELECT updated_at FROM chatops_ledger WHERE identity_key = ? AND issue_number = ?
         )`,
      )
      .get(
        scope.identityKey,
        scope.issueNumber,
        scope.identityKey,
        scope.issueNumber,
      ) as { last: string | null } | undefined;

    return {
      cursor: toCursorState(cursorRow),
      rows: ledger.map(toLedgerRow),
      pendingFirstSeen: pending.map(toFirstSeen),
      ackReservations: reservations.map((raw) => ({
        commentId: raw.comment_id,
        ackAttempts: raw.ack_attempts,
        reservedAt: raw.reserved_at,
      })),
      issueFence: toFence(issueFence),
      sessionFence: toFence(sessionFence),
      lastActivityAt: activity?.last ?? null,
    };
  }

  async getFirstSeen(
    scope: ChatOpsScope,
    commentId: string,
  ): Promise<ChatOpsFirstSeenRecord | undefined> {
    const raw = this.#db
      .prepare(
        `SELECT * FROM chatops_first_seen
          WHERE identity_key = ? AND issue_number = ? AND comment_id = ?`,
      )
      .get(scope.identityKey, scope.issueNumber, commentId) as FirstSeenRawRow | undefined;
    return raw ? toFirstSeen(raw) : undefined;
  }

  async listIssueNumbers(identityKey: string): Promise<number[]> {
    const rows = this.#db
      .prepare(
        `SELECT issue_number FROM chatops_cursor WHERE identity_key = ?
         ORDER BY issue_number`,
      )
      .all(identityKey) as Array<{ issue_number: number }>;
    return rows.map((r) => r.issue_number);
  }

  /**
   * Work items whose ledger still owes automation something.
   *
   * "Owes" is deliberately narrow: a row automation can still move on its own
   * (`claimed`, `dispatching`, `awaiting_ack`, `retry_scheduled`), or a settled
   * row whose acknowledgement marker has not been published yet. Nothing else
   * counts — an `ambiguous` row is parked for a human (contract §13.3) and only
   * `chatops-recover` plus an explicit `--issue-number` pass moves it, so
   * treating it as owed work would make a parked scope scan the provider on
   * every pass forever.
   *
   * Like {@link getScanRotation} this is scheduling metadata rather than one of
   * the port's transaction boundaries: it decides which scopes a capped scan
   * bothers to look at, never what any ledger or cursor transition may conclude.
   */
  async listUnsettledIssueNumbers(identityKey: string): Promise<number[]> {
    const rows = this.#db
      .prepare(
        `SELECT DISTINCT issue_number FROM chatops_ledger
          WHERE identity_key = ?
            AND (state NOT IN ('rejected', 'acknowledged', 'ambiguous')
                 OR (state <> 'ambiguous' AND ack_publication = 'pending'))
          ORDER BY issue_number`,
      )
      .all(identityKey) as Array<{ issue_number: number }>;
    return rows.map((r) => r.issue_number);
  }

  /**
   * The work item the next capped scan starts from, or `null` when none has been
   * recorded yet.
   *
   * Not part of {@link ChatOpsStore}: a rotation position is scheduling
   * metadata, not one of the four transaction boundaries the port exists to fix,
   * and no ledger or cursor decision may ever read it. It lives here because the
   * only caller — `chatops-scan`'s work-item selection — already holds this
   * concrete store.
   */
  async getScanRotation(identityKey: string): Promise<number | null> {
    const row = this.#db
      .prepare("SELECT next_issue_number FROM chatops_scan_rotation WHERE identity_key = ?")
      .get(identityKey) as { next_issue_number: number } | undefined;
    return row?.next_issue_number ?? null;
  }

  /**
   * Record where the next capped scan starts.
   *
   * Written when the selection is made rather than when the pass finishes: a
   * pass that dies partway must not leave the window pinned to the work items
   * that killed it, or the rest of the session would never be scanned again.
   */
  async setScanRotation(identityKey: string, nextIssueNumber: number): Promise<void> {
    this.#assertWritable("setScanRotation");
    this.#db.transaction(() => {
      this.#assertUnlocked("scan-rotation write");
      this.#db
        .prepare(
          `INSERT INTO chatops_scan_rotation (identity_key, next_issue_number, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(identity_key) DO UPDATE SET
             next_issue_number = excluded.next_issue_number,
             updated_at = excluded.updated_at`,
        )
        .run(identityKey, nextIssueNumber, new Date().toISOString());
    }).immediate();
  }

  async commit(scope: ChatOpsScope, input: ChatOpsCommitInput): Promise<void> {
    this.#assertWritable("commit");
    this.#db.transaction(() => {
      this.#assertUnlocked("commit");
      this.#apply(scope, input);
    }).immediate();
  }

  async commitWithEpoch(
    scope: ChatOpsScope,
    build: (
      epoch: number,
      persisted: readonly ChatOpsLedgerRow[],
      fences: ChatOpsPersistedFences,
    ) => ChatOpsCommitInput | null,
  ): Promise<number | null> {
    this.#assertWritable("commitWithEpoch");
    // `build` runs inside the transaction so the epoch it stamps and the row
    // that spends it are committed together, or neither is. A `null` return
    // rolls back by writing nothing — better-sqlite3 commits an ordinary
    // callback return, so the epoch bump is issued only once `build` has
    // decided to proceed.
    const run = this.#db.transaction((): number | null => {
      // Before the epoch is read, let alone bumped: this transaction is T2's
      // write-ahead, and everything external a pass does — the claim marker, the
      // operation itself — happens only after it commits. Refusing here is what
      // keeps a maintenance window from being interleaved with a dispatch.
      this.#assertUnlocked("dispatch write-ahead");
      const current = (
        this.#db
          .prepare("SELECT epoch FROM chatops_epoch WHERE identity_key = ?")
          .get(scope.identityKey) as { epoch: number } | undefined
      )?.epoch ?? 0;
      const next = current + 1;
      const input = build(next, this.#persistedRows(scope), this.#persistedFences(scope));
      if (input === null) return null;
      this.#db
        .prepare(
          `INSERT INTO chatops_epoch (identity_key, epoch) VALUES (?, ?)
           ON CONFLICT(identity_key) DO UPDATE SET epoch = excluded.epoch`,
        )
        .run(scope.identityKey, next);
      this.#apply(scope, input);
      return next;
    });
    return run.immediate();
  }

  async commitCompareAndSwap(
    scope: ChatOpsScope,
    build: (
      persisted: readonly ChatOpsLedgerRow[],
      fences: ChatOpsPersistedFences,
    ) => ChatOpsCommitInput | null,
  ): Promise<boolean> {
    this.#assertWritable("commitCompareAndSwap");
    const run = this.#db.transaction((): boolean => {
      this.#assertUnlocked("compare-and-swap commit");
      const input = build(this.#persistedRows(scope), this.#persistedFences(scope));
      if (input === null) return false;
      this.#apply(scope, input);
      return true;
    });
    return run.immediate();
  }

  async reserveAckPublication(
    scope: ChatOpsScope,
    commentId: string,
    accept: (persisted: ChatOpsLedgerRow | undefined) => boolean,
  ): Promise<boolean> {
    this.#assertWritable("reserveAckPublication");
    const run = this.#db.transaction((): boolean => {
      // Before the reservation, so a marker post never begins during maintenance.
      this.#assertUnlocked("acknowledgement reservation");
      const held = this.#db
        .prepare(
          `SELECT 1 FROM chatops_ack_reservation
            WHERE identity_key = ? AND issue_number = ? AND comment_id = ?`,
        )
        .get(scope.identityKey, scope.issueNumber, commentId) as Record<string, unknown> | undefined;
      if (held !== undefined) return false;
      const raw = this.#db
        .prepare(
          `SELECT * FROM chatops_ledger
            WHERE identity_key = ? AND issue_number = ? AND comment_id = ?`,
        )
        .get(scope.identityKey, scope.issueNumber, commentId) as LedgerRawRow | undefined;
      const row = raw === undefined ? undefined : toLedgerRow(raw);
      if (!accept(row)) return false;
      this.#db
        .prepare(
          `INSERT INTO chatops_ack_reservation
             (identity_key, issue_number, comment_id, ack_attempts, reserved_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          scope.identityKey,
          scope.issueNumber,
          commentId,
          row?.ackAttempts ?? 0,
          new Date().toISOString(),
        );
      return true;
    });
    return run.immediate();
  }

  /**
   * The scope's ledger rows re-read under the write lock.
   *
   * `BEGIN IMMEDIATE` makes a second process's transaction wait for this one to
   * commit and then take a fresh snapshot, so these rows are the
   * compare-and-swap baseline that lets `build` notice its caller's copy went
   * stale (see {@link ChatOpsStore.commitWithEpoch}).
   */
  #persistedRows(scope: ChatOpsScope): ChatOpsLedgerRow[] {
    return (
      this.#db
        .prepare(
          `SELECT * FROM chatops_ledger WHERE identity_key = ? AND issue_number = ?
           ORDER BY comment_id`,
        )
        .all(scope.identityKey, scope.issueNumber) as LedgerRawRow[]
    ).map(toLedgerRow);
  }

  /**
   * Both fence grains re-read under the same write lock the ledger rows are.
   *
   * A fence is committed by an ordinary transaction, so it can land between a
   * caller's `loadScope` and its write-ahead; reading it here is what lets the
   * write-ahead decline a dispatch a concurrently committed fence forbids
   * (see {@link ChatOpsStore.commitWithEpoch}).
   */
  #persistedFences(scope: ChatOpsScope): ChatOpsPersistedFences {
    const read = this.#db.prepare(
      "SELECT reason, detail, fenced_at FROM chatops_fence WHERE identity_key = ? AND issue_number = ?",
    );
    return {
      issue: toFence(read.get(scope.identityKey, scope.issueNumber) as FenceRawRow | undefined),
      session: toFence(
        read.get(scope.identityKey, SESSION_FENCE_ISSUE_NUMBER) as FenceRawRow | undefined,
      ),
    };
  }

  async listAudit(scope: ChatOpsScope, commentId?: string): Promise<ChatOpsAuditRecord[]> {
    const rows =
      commentId === undefined
        ? (this.#db
            .prepare(
              `SELECT * FROM chatops_audit WHERE identity_key = ? AND issue_number = ?
               ORDER BY id`,
            )
            .all(scope.identityKey, scope.issueNumber) as Array<Record<string, unknown>>)
        : (this.#db
            .prepare(
              `SELECT * FROM chatops_audit
                WHERE identity_key = ? AND issue_number = ? AND comment_id = ?
                ORDER BY id`,
            )
            .all(scope.identityKey, scope.issueNumber, commentId) as Array<Record<string, unknown>>);
    return rows.map((r) => ({
      requestId: (r.request_id as string | null) ?? null,
      surface: "chatops" as const,
      actorId: r.actor_id as string,
      operationId: (r.operation_id as string | null) ?? null,
      ledgerScope: {
        identity: r.identity_key as string,
        issueNumber: r.issue_number as number,
        commentId: r.comment_id as string,
      },
      row: r.row_number as number,
      kind: r.kind as ChatOpsAuditRecord["kind"],
      dispatched: r.dispatched === 1,
      reason: (r.reason as string | null) ?? null,
    }));
  }

  /** Every write one {@link ChatOpsCommitInput} describes. Callers hold the transaction. */
  #apply(scope: ChatOpsScope, input: ChatOpsCommitInput): void {
    const now = new Date().toISOString();
    const id = identityColumns(scope.identityKey);

    if (input.cursor !== undefined) {
      this.#db
        .prepare(
          `INSERT INTO chatops_cursor
             (identity_key, issue_number, session_id, provider, provider_endpoint,
              provider_owner, provider_repo, initialized, cursor_created_at,
              cursor_created_ms, cursor_comment_id, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(identity_key, issue_number) DO UPDATE SET
             initialized = excluded.initialized,
             cursor_created_at = excluded.cursor_created_at,
             cursor_created_ms = excluded.cursor_created_ms,
             cursor_comment_id = excluded.cursor_comment_id,
             updated_at = excluded.updated_at`,
        )
        .run(
          scope.identityKey,
          scope.issueNumber,
          id.sessionId,
          id.provider,
          id.providerEndpoint,
          id.providerOwner,
          id.providerRepo,
          input.cursor.initialized ? 1 : 0,
          input.cursor.cursor?.createdAt ?? null,
          input.cursor.cursor?.createdAtMs ?? null,
          input.cursor.cursor?.commentId ?? null,
          now,
        );
    }

    if (input.firstSeen?.length) {
      // INSERT OR IGNORE, never an upsert: first-seen rows are insert-only
      // (`docs/chatops-comment-cursor-contract.md` §12).
      const stmt = this.#db.prepare(
        `INSERT OR IGNORE INTO chatops_first_seen
           (identity_key, issue_number, comment_id, author, created_at, updated_at,
            body, body_length, body_sha256, bootstrap, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const record of input.firstSeen) {
        stmt.run(
          scope.identityKey,
          scope.issueNumber,
          record.commentId,
          record.author,
          record.createdAt,
          record.updatedAt,
          record.body,
          record.bodyLength,
          record.bodySha256,
          record.bootstrap ? 1 : 0,
          now,
        );
      }
    }

    if (input.rows?.length) {
      const stmt = this.#db.prepare(
        `INSERT INTO chatops_ledger
           (identity_key, issue_number, comment_id, state, outcome, attempts, epoch,
            attempt_started_ms, ack_publication, ack_attempts, reconcile_attempts,
            evidence, evidence_truncated, evidence_claims, evidence_acks, handoff,
            detail, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(identity_key, issue_number, comment_id) DO UPDATE SET
           state = excluded.state,
           outcome = excluded.outcome,
           attempts = excluded.attempts,
           epoch = excluded.epoch,
           attempt_started_ms = excluded.attempt_started_ms,
           ack_publication = excluded.ack_publication,
           ack_attempts = excluded.ack_attempts,
           reconcile_attempts = excluded.reconcile_attempts,
           evidence = excluded.evidence,
           evidence_truncated = excluded.evidence_truncated,
           evidence_claims = excluded.evidence_claims,
           evidence_acks = excluded.evidence_acks,
           handoff = excluded.handoff,
           detail = excluded.detail,
           updated_at = excluded.updated_at`,
      );
      for (const row of input.rows) {
        stmt.run(
          scope.identityKey,
          scope.issueNumber,
          row.commentId,
          row.state,
          row.outcome,
          row.attempts,
          row.epoch,
          row.attemptStartedAtMs,
          row.ackPublication,
          row.ackAttempts,
          row.reconcileAttempts,
          JSON.stringify(row.evidence),
          row.evidenceTruncated ? 1 : 0,
          row.evidenceClaims,
          row.evidenceAcks,
          row.handoff === null ? null : JSON.stringify(row.handoff),
          row.detail,
          now,
        );
      }
    }

    if (input.audit?.length) {
      const stmt = this.#db.prepare(
        `INSERT INTO chatops_audit
           (identity_key, issue_number, comment_id, request_id, actor_id, operation_id,
            row_number, kind, dispatched, reason, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const record of input.audit) {
        stmt.run(
          record.ledgerScope.identity,
          record.ledgerScope.issueNumber,
          record.ledgerScope.commentId,
          record.requestId,
          record.actorId,
          record.operationId,
          record.row,
          record.kind,
          record.dispatched ? 1 : 0,
          record.reason,
          now,
        );
      }
    }

    if (input.effects?.length) {
      // Same statement `SqliteTaskStore` uses for its transactional enqueue: a
      // duplicate idempotency key is a no-op, so a replayed transition never
      // enqueues a second copy of the same summary.
      const stmt = this.#db.prepare(
        `INSERT OR IGNORE INTO outbox (idempotency_key, topic, payload, created_at)
         VALUES (?, ?, ?, ?)`,
      );
      for (const effect of input.effects) {
        stmt.run(
          effect.idempotencyKey,
          effect.topic,
          JSON.stringify(effect.payload),
          effect.now ?? now,
        );
      }
    }

    if (input.releaseAckReservations?.length) {
      const stmt = this.#db.prepare(
        `DELETE FROM chatops_ack_reservation
          WHERE identity_key = ? AND issue_number = ? AND comment_id = ?`,
      );
      for (const commentId of input.releaseAckReservations) {
        stmt.run(scope.identityKey, scope.issueNumber, commentId);
      }
    }

    if (input.fence !== undefined) {
      const fenceIssue =
        input.fence.grain === "session" ? SESSION_FENCE_ISSUE_NUMBER : scope.issueNumber;
      if (input.fence.record === null) {
        this.#db
          .prepare("DELETE FROM chatops_fence WHERE identity_key = ? AND issue_number = ?")
          .run(scope.identityKey, fenceIssue);
      } else {
        this.#db
          .prepare(
            // `fenced_at` is updated too, not just the reason and detail. The
            // recovery CLI treats (reason, detail, fencedAt) as the fence's
            // version for its compare-and-swap, so a re-raise that kept the old
            // timestamp would be indistinguishable from the fence the operator
            // inspected and could be cleared without authorizing the newer
            // safety signal.
            `INSERT INTO chatops_fence (identity_key, issue_number, reason, detail, fenced_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(identity_key, issue_number) DO UPDATE SET
               reason = excluded.reason,
               detail = excluded.detail,
               fenced_at = excluded.fenced_at`,
          )
          .run(
            scope.identityKey,
            fenceIssue,
            input.fence.record.reason,
            input.fence.record.detail,
            input.fence.record.fencedAt,
          );
      }
    }
  }
}
