import Database from "better-sqlite3";
import { homedir } from "os";
import { mkdirSync } from "fs";
import { join } from "path";
import {
  OUTBOX_MAX_ATTEMPTS,
  OUTBOX_CLAIM_STALE_MS,
  computeOutboxBackoffMs,
  type OutboxEntry,
  type OutboxEnqueueInput,
  type OutboxStore,
  type OutboxPayload,
  type OutboxTopic,
} from "../core/outbox.js";
import type { OutboxEffect } from "../core/task-store.js";
import {
  OUTBOX_SCAN_CURSOR_ROLES,
  scanCursorKeysFor,
  type OutboxScanCursorFence,
  type OutboxScanCursorRole,
} from "../core/outbox-scan-cursor.js";
import {
  migrateOutboxTable,
  migrateOutboxRetryColumns,
  migrateOutboxCancelColumn,
  migrateOutboxClaimColumn,
} from "./outbox-migration.js";
import { sanitizeBody, redactTokens, boundedExcerpt } from "../core/text-sanitize.js";
import { isMaintenanceLockHeld, MaintenanceLockedError } from "./maintenance-lock-guard.js";
import { sqliteBackendId } from "./sqlite-backend-id.js";

export const DEFAULT_DB_PATH = join(
  homedir(),
  ".config",
  "n8n-ai-cli-loop",
  "dev_loop.db",
);

// Only create the outbox-related tables; the rest of the schema lives in
// SqliteTaskStore. Both use CREATE IF NOT EXISTS so order of initialization
// does not matter when sharing the same file.
const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;

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

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key         TEXT PRIMARY KEY,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Persisted per-dispatch-identity scan cursor (issue #606 review follow-up).
-- Brand new table, so plain CREATE TABLE IF NOT EXISTS is sufficient — no
-- migration needed the way the retry columns above required one.
CREATE TABLE IF NOT EXISTS outbox_scan_cursor (
  scan_key  TEXT PRIMARY KEY,
  after_id  INTEGER NOT NULL
);

-- Per-identity rewind generation fencing dispatch cursor writes against a
-- concurrent operator retry (issue #820 review follow-up). Keyed by the
-- *identity* (the "floor" key), not a per-role key, since one retry rewinds all
-- three roles together. Its own table rather than a column on
-- outbox_scan_cursor: the fence must exist for an identity whose cursor rows
-- do not (rule R3 keeps an absent cursor absent, and a run that would create
-- one still has to be fenceable). Brand new table, so plain CREATE TABLE IF NOT
-- EXISTS is sufficient — an existing database simply starts at generation 0,
-- which is exactly what "no retry has rewound this identity" means.
CREATE TABLE IF NOT EXISTS outbox_scan_cursor_fence (
  scan_key  TEXT PRIMARY KEY,
  epoch     INTEGER NOT NULL
);

-- issue #611/#818: whole-file maintenance lock. Created here as well as by
-- stores/sqlite-task-store.ts and stores/sqlite-maintenance-lock.ts so the
-- outbox mutators below can reference it inside their own transactions
-- regardless of which store class opened this file first — CREATE TABLE IF NOT
-- EXISTS makes every construction order safe.
CREATE TABLE IF NOT EXISTS maintenance_lock (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  holder          TEXT NOT NULL,
  acquired_at     TEXT NOT NULL,
  activity_exempt INTEGER NOT NULL DEFAULT 0
);
`;

interface RawOutboxEntry {
  id: number;
  idempotency_key: string;
  topic: string;
  payload: string;
  created_at: string;
  sent_at: string | null;
  attempt_count: number;
  last_error: string | null;
  next_attempt_at: string | null;
  dead_letter_at: string | null;
  cancelled_at: string | null;
  claimed_at: string | null;
}

function rawToEntry(row: RawOutboxEntry): OutboxEntry {
  return {
    id: row.id,
    idempotencyKey: row.idempotency_key,
    topic: row.topic as OutboxTopic,
    payload: JSON.parse(row.payload) as OutboxPayload,
    createdAt: row.created_at,
    sentAt: row.sent_at ?? undefined,
    attemptCount: row.attempt_count,
    lastError: row.last_error ?? undefined,
    nextAttemptAt: row.next_attempt_at ?? undefined,
    deadLetterAt: row.dead_letter_at ?? undefined,
    cancelledAt: row.cancelled_at ?? undefined,
    claimedAt: row.claimed_at ?? undefined,
  };
}

export class SqliteOutboxStore implements OutboxStore {
  #db: InstanceType<typeof Database>;

  /**
   * Identity of the database file this store writes to (issue #818 review
   * follow-up) — see {@link OutboxStore.backendId}. Equal to the paired task
   * store's `backendId` exactly when both were opened on the same file, which
   * is what makes a phase completion's task transition and its outbox rows one
   * transaction.
   */
  readonly backendId: string | undefined;

  constructor(dbPath: string = DEFAULT_DB_PATH) {
    const dir = join(dbPath, "..");
    mkdirSync(dir, { recursive: true });
    this.#db = new Database(dbPath);
    // After the file exists, so the path canonicalizes all the way down to it
    // rather than stopping at the deepest ancestor that happened to exist yet.
    this.backendId = sqliteBackendId(dbPath);
    // Run migration before CREATE TABLE IF NOT EXISTS so legacy rows get a key.
    migrateOutboxTable(this.#db);
    this.#db.exec(SCHEMA);
    migrateOutboxRetryColumns(this.#db);
    migrateOutboxCancelColumn(this.#db);
    migrateOutboxClaimColumn(this.#db);
  }

  /**
   * Threshold below which `claimed_at` is considered stale (abandoned by a
   * crashed dispatch attempt) as of `asOf`. Bound as a parameter — not
   * interpolated — everywhere it is used in a `WHERE claimed_at <= ?` clause.
   */
  #claimStaleBefore(asOf: string): string {
    return new Date(new Date(asOf).getTime() - OUTBOX_CLAIM_STALE_MS).toISOString();
  }

  /**
   * Whether a maintenance lock is currently held on this database file (issue
   * #818). A point-in-time read for callers that need to *report* contention —
   * `dispatchOutbox`'s fail-closed pre-check, the `admin outbox retry/cancel`
   * previews — never a substitute for the in-transaction guard the mutators
   * below apply, which is what actually makes the exclusion atomic.
   */
  async isMaintenanceLocked(): Promise<boolean> {
    return isMaintenanceLockHeld(this.#db);
  }

  async enqueue(input: OutboxEnqueueInput): Promise<{ enqueued: boolean }> {
    // The lock read and the INSERT run in one IMMEDIATE transaction (issue
    // #818, docs/retention-backup-contract.md §9): a maintenance acquisition
    // is itself an IMMEDIATE transaction against this same file, so SQLite's
    // writer serialization makes these two mutually exclusive — whichever
    // commits first is authoritative. A pre-check outside the transaction
    // would leave the check-to-act gap where a row is enqueued into a file
    // `restore` is already replacing, silently losing the effect.
    const run = this.#db.transaction((): { enqueued: boolean } => {
      if (isMaintenanceLockHeld(this.#db)) throw new MaintenanceLockedError("outbox enqueue");
      return this.#insertEnqueue(input);
    });
    return run.immediate();
  }

  async replacePendingPrSummary(
    input: OutboxEnqueueInput,
    key: { owner: string; repo: string; prNumber: number; marker: string },
  ): Promise<{ enqueued: boolean }> {
    const run = this.#db.transaction((): { enqueued: boolean } => {
      // Same in-transaction maintenance guard as `enqueue` (issue #818): this
      // path both inserts *and* deletes pending rows, so running it against a
      // file a `prune`/`restore` pass is working on could destroy a pending
      // summary the maintenance pass had already accounted for.
      if (isMaintenanceLockHeld(this.#db)) throw new MaintenanceLockedError("outbox PR-summary enqueue");
      return this.#insertReplacePendingPrSummary(input, key);
    });
    return run.immediate();
  }

  /**
   * Write a whole completion effect set in one IMMEDIATE transaction behind a
   * single in-transaction lock read (issue #818 review follow-up) — see
   * {@link OutboxStore.enqueueEffects}. Looping over {@link enqueue} instead
   * would give each effect its own transaction, so a lock acquired mid-set
   * would leave the earlier rows durable while the caller's completion is
   * refused and re-run.
   */
  async enqueueEffects(effects: OutboxEffect[]): Promise<void> {
    if (effects.length === 0) return;
    const run = this.#db.transaction((): void => {
      if (isMaintenanceLockHeld(this.#db)) throw new MaintenanceLockedError("outbox effect enqueue");
      for (const effect of effects) {
        if (effect.kind === "enqueue") {
          this.#insertEnqueue(effect.input);
        } else {
          this.#insertReplacePendingPrSummary(effect.input, effect.key);
        }
      }
    });
    run.immediate();
  }

  /**
   * The insert half of {@link enqueue}, without the transaction or the
   * maintenance guard — call only from inside a transaction that has already
   * read the lock.
   */
  #insertEnqueue(input: OutboxEnqueueInput): { enqueued: boolean } {
    const now = input.now ?? new Date().toISOString();
    const result = this.#db
      .prepare(
        `INSERT OR IGNORE INTO outbox (idempotency_key, topic, payload, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(input.idempotencyKey, input.topic, JSON.stringify(input.payload), now);
    return { enqueued: result.changes > 0 };
  }

  /**
   * The insert/supersede half of {@link replacePendingPrSummary}, without the
   * transaction or the maintenance guard — call only from inside a transaction
   * that has already read the lock.
   */
  #insertReplacePendingPrSummary(
    input: OutboxEnqueueInput,
    key: { owner: string; repo: string; prNumber: number; marker: string },
  ): { enqueued: boolean } {
    const now = input.now ?? new Date().toISOString();
    // `dead_letter_at IS NULL` excludes rows that already exhausted retries
    // (issue #606 review follow-up): a dead-lettered summary is unsent but no
    // longer "pending" in the retry sense, and deleting it here would silently
    // discard its failure history before an operator ever gets to inspect or
    // requeue it.
    const deletePending = this.#db.prepare(
      `DELETE FROM outbox
       WHERE topic = 'repohost:pr-summary'
         AND sent_at IS NULL
         AND dead_letter_at IS NULL
         AND idempotency_key != ?
         AND json_extract(payload, '$.owner') = ?
         AND json_extract(payload, '$.repo') = ?
         AND json_extract(payload, '$.prNumber') = ?
         AND json_extract(payload, '$.marker') = ?`,
    );
    const insertEntry = this.#db.prepare(
      `INSERT OR IGNORE INTO outbox (idempotency_key, topic, payload, created_at)
       VALUES (?, ?, ?, ?)`,
    );
    // Insert first so that a duplicate idempotency key is detected before any
    // rows are deleted. If the key already exists (INSERT OR IGNORE → 0 changes),
    // we must not delete a newer pending summary that was queued after the
    // already-seen key was dispatched.
    const insertResult = insertEntry.run(input.idempotencyKey, input.topic, JSON.stringify(input.payload), now);
    if (insertResult.changes > 0) {
      deletePending.run(input.idempotencyKey, key.owner, key.repo, key.prNumber, key.marker);
    }
    return { enqueued: insertResult.changes > 0 };
  }

  async listPending(limit?: number): Promise<OutboxEntry[]> {
    // `limit === undefined` returns every pending row (no LIMIT clause) so a
    // caller that filters in JS (e.g. the session-scoped dispatcher) can apply
    // its own cap *after* filtering rather than having foreign rows consume the
    // fetch window. An explicit limit still caps the raw fetch.
    //
    // A dead-lettered row (`dead_letter_at` set) is permanently excluded here —
    // it has exhausted its retry budget and never becomes eligible again, so it
    // must not occupy a caller's fetch/limit window (issue #606). A merely
    // delayed row (a future `next_attempt_at`) is still returned: due-time
    // eligibility is a dispatch-selection concern the caller applies itself
    // (see `dispatchOutbox`), not a store-read concern.
    const rows = (
      limit === undefined
        ? this.#db
            .prepare(`SELECT * FROM outbox WHERE sent_at IS NULL AND dead_letter_at IS NULL ORDER BY id ASC`)
            .all()
        : this.#db
            .prepare(`SELECT * FROM outbox WHERE sent_at IS NULL AND dead_letter_at IS NULL ORDER BY id ASC LIMIT ?`)
            .all(limit)
    ) as RawOutboxEntry[];
    return rows.map(rawToEntry);
  }

  async listPendingEntries(opts: { limit: number; afterId?: number }): Promise<OutboxEntry[]> {
    // Dead-letter exclusion happens in SQL, but due-time does not: a delayed
    // row (a future `next_attempt_at`) is still returned so the dispatcher's
    // persisted scan cursor can see a delayed row that belongs to it and stop
    // before skipping past its id (issue #606 review follow-up — an earlier
    // version filtered due-time here too, which made a delayed owned row
    // invisible to the scan and let the cursor strand it once it became due).
    // `afterId` is a cursor: each page starts strictly after the last row of
    // the previous page, so pagination never re-reads or skips a row even as
    // new rows are enqueued between pages.
    const rows = this.#db
      .prepare(
        `SELECT * FROM outbox
         WHERE sent_at IS NULL
           AND dead_letter_at IS NULL
           AND id > ?
         ORDER BY id ASC
         LIMIT ?`,
      )
      .all(opts.afterId ?? 0, opts.limit) as RawOutboxEntry[];
    return rows.map(rawToEntry);
  }

  async markSent(id: number, sentAt?: string, claimToken?: string): Promise<{ updated: boolean }> {
    const ts = sentAt ?? new Date().toISOString();
    // Clears `claimed_at` too (issue #607 review follow-up): a dispatch
    // attempt that reaches here has resolved, so its claim (if any — direct
    // callers that bypass `claimForDispatch` never set one) must not linger
    // and block a future claim or cancel of this id. Harmless when unset.
    //
    // Fenced on `claimToken` when the caller supplies one (P2 review
    // follow-up): if this row's claim expired and was reclaimed by another
    // dispatcher before this attempt reached here, its completion is stale
    // and must not clear the newer claim (or stamp `sent_at` over a row now
    // in flight elsewhere) — the `claimed_at = ?` predicate makes that a
    // no-op. Direct callers that never claimed the row (`claimToken` omitted)
    // keep the old unconditional behavior. `changes` reports whether the
    // fenced predicate actually matched a row, so a caller that relies on the
    // fence (the dispatcher) can tell a rejected completion apart from a
    // genuinely persisted one instead of assuming success (P2 review
    // follow-up).
    if (claimToken !== undefined) {
      const result = this.#db
        .prepare(`UPDATE outbox SET sent_at = ?, claimed_at = NULL WHERE id = ? AND claimed_at = ?`)
        .run(ts, id, claimToken);
      return { updated: result.changes > 0 };
    }
    const result = this.#db.prepare(`UPDATE outbox SET sent_at = ?, claimed_at = NULL WHERE id = ?`).run(ts, id);
    return { updated: result.changes > 0 };
  }

  async markFailed(id: number, error: string, now?: string, claimToken?: string): Promise<{ deadLettered: boolean }> {
    const asOf = now ?? new Date().toISOString();
    const sanitized = boundedExcerpt(redactTokens(sanitizeBody(error)), 500);
    const run = this.#db.transaction((): { deadLettered: boolean } => {
      const row = this.#db.prepare(`SELECT attempt_count, claimed_at FROM outbox WHERE id = ?`).get(id) as
        | { attempt_count: number; claimed_at: string | null }
        | undefined;
      if (!row) return { deadLettered: false };
      // Fenced on `claimToken` when supplied (P2 review follow-up), same
      // rationale as `markSent`: a stale failure from an attempt whose claim
      // was already reclaimed by another dispatcher must not clear that newer
      // claim or reschedule/dead-letter the row out from under it.
      if (claimToken !== undefined && row.claimed_at !== claimToken) return { deadLettered: false };

      const attemptCount = row.attempt_count + 1;
      // Both branches also clear `claimed_at` (issue #607 review follow-up):
      // this dispatch attempt has resolved (failed), so its claim must not
      // outlive it and block a future claim or cancel of this id. The
      // `claimed_at IS ?` clause pins the update to the value just observed
      // above, inside the same transaction, so it only commits if nothing
      // else has claimed the row since.
      if (attemptCount >= OUTBOX_MAX_ATTEMPTS) {
        this.#db
          .prepare(
            `UPDATE outbox SET attempt_count = ?, last_error = ?, next_attempt_at = NULL, dead_letter_at = ?, claimed_at = NULL
             WHERE id = ? AND claimed_at IS ?`,
          )
          .run(attemptCount, sanitized, asOf, id, row.claimed_at);
        return { deadLettered: true };
      }

      const nextAttemptAt = new Date(new Date(asOf).getTime() + computeOutboxBackoffMs(attemptCount)).toISOString();
      this.#db
        .prepare(
          `UPDATE outbox SET attempt_count = ?, last_error = ?, next_attempt_at = ?, claimed_at = NULL
           WHERE id = ? AND claimed_at IS ?`,
        )
        .run(attemptCount, sanitized, nextAttemptAt, id, row.claimed_at);
      return { deadLettered: false };
    });
    return run();
  }

  async getScanCursor(key: string): Promise<number | undefined> {
    const row = this.#db.prepare(`SELECT after_id FROM outbox_scan_cursor WHERE scan_key = ?`).get(key) as
      | { after_id: number }
      | undefined;
    return row?.after_id;
  }

  async getScanCursorFence(identityKey: string): Promise<number> {
    return this.#readScanCursorFence(identityKey);
  }

  async setScanCursor(
    key: string,
    id: number,
    fence?: OutboxScanCursorFence,
  ): Promise<{ persisted: boolean; fenceStale?: true }> {
    // Maintenance guard (issue #818 review follow-up), read inside the same
    // IMMEDIATE transaction as the upsert: the cursor table lives in the
    // maintained database, so persisting a cursor after a restore has begun
    // writes into a file the maintenance pass owns. The dispatcher's own
    // pre-check cannot cover this — the lock can be acquired *after* its last
    // claim resolved but before it reaches cursor persistence — so the check
    // belongs here, atomically, exactly like `claimForDispatch`'s. Refusing is
    // non-destructive: the cursor keeps the previous complete run's value.
    //
    // The rewind fence (issue #820 review follow-up) is read in that same
    // transaction and for the same reason: a retry can commit its rewind at any
    // point between the caller's scan-start read and this write, so comparing
    // generations outside the transaction would just move the race. A stale
    // generation means this run's extent was computed before a row was revived
    // under it, so writing it would restore the very cursor position the rewind
    // removed and re-strand the row — permanently, since no further operation
    // would rewind it again. Refusing is again non-destructive: the rewound
    // value stands and the next run resumes from it, re-scanning a bounded span
    // it has already classified once.
    const run = this.#db.transaction((): { persisted: boolean; fenceStale?: true } => {
      if (isMaintenanceLockHeld(this.#db)) return { persisted: false };
      if (fence && this.#readScanCursorFence(fence.identityKey) !== fence.epoch) {
        return { persisted: false, fenceStale: true };
      }
      this.#db
        .prepare(
          `INSERT INTO outbox_scan_cursor (scan_key, after_id) VALUES (?, ?)
           ON CONFLICT(scan_key) DO UPDATE SET after_id = excluded.after_id`,
        )
        .run(key, id);
      return { persisted: true };
    });
    return run.immediate();
  }

  /**
   * Current rewind generation of `identityKey`, or `0` when no fence row exists
   * (issue #820 review follow-up). Synchronous so it can be read inside a
   * transaction alongside the write it fences.
   */
  #readScanCursorFence(identityKey: string): number {
    const row = this.#db
      .prepare(`SELECT epoch FROM outbox_scan_cursor_fence WHERE scan_key = ?`)
      .get(identityKey) as { epoch: number } | undefined;
    return row?.epoch ?? 0;
  }

  /**
   * Advance an identity's rewind generation (issue #820 review follow-up). Call
   * only from inside the transaction that committed a retry for that identity.
   *
   * Bumped on **every** committed retry that supplied a cursor identity, not
   * only on one that actually moved a cursor row: a cursor sitting below the
   * revived row needs no rewind, yet an in-flight dispatch that scanned past
   * that row while it was still dead-lettered (so `listPendingEntries` never
   * returned it) would advance the cursor beyond it anyway. Unlike the rewind
   * itself, this is an upsert — the fence is not a cursor, so R3 ("absent stays
   * absent") does not apply to it, and a missing row simply means generation 0.
   */
  #bumpScanCursorFence(identityKey: string): void {
    this.#db
      .prepare(
        `INSERT INTO outbox_scan_cursor_fence (scan_key, epoch) VALUES (?, 1)
         ON CONFLICT(scan_key) DO UPDATE SET epoch = epoch + 1`,
      )
      .run(identityKey);
  }

  async getById(id: number): Promise<OutboxEntry | undefined> {
    const row = this.#db.prepare(`SELECT * FROM outbox WHERE id = ?`).get(id) as RawOutboxEntry | undefined;
    return row ? rawToEntry(row) : undefined;
  }

  async listUnsent(): Promise<OutboxEntry[]> {
    // Unlike listPending/listPendingEntries, dead-lettered rows are NOT
    // excluded here — an operator diagnosing a poison row via `admin outbox
    // list` (issue #607) needs to see them too, not just dispatch-eligible ones.
    const rows = this.#db
      .prepare(`SELECT * FROM outbox WHERE sent_at IS NULL ORDER BY id ASC`)
      .all() as RawOutboxEntry[];
    return rows.map(rawToEntry);
  }

  async retryEntry(
    id: number,
    now?: string,
    opts?: { cursorIdentityKey?: string },
  ): Promise<{ retried: boolean; reason?: string; cursorsRewound?: OutboxScanCursorRole[] }> {
    const asOf = now ?? new Date().toISOString();
    // Derived *before* the transaction (issue #820) so a malformed identity key
    // throws without having mutated anything: `deriveScanCursorKey` rejects an
    // empty or already-derived-shaped identity, and doing that inside the
    // transaction would abort a retry that had already committed nothing useful
    // while looking, from the caller's side, like a store failure rather than a
    // programming error.
    const cursorIdentityKey = opts?.cursorIdentityKey;
    const cursorKeys = cursorIdentityKey !== undefined ? scanCursorKeysFor(cursorIdentityKey) : undefined;
    // Maintenance guard (issue #818, retention-backup-contract.md §9): an
    // `outbox retry` can move a dead-lettered or cancelled row back into the
    // pending bucket, which is exactly the mutation that would revive a row a
    // prune batch already selected for deletion. Reported through this method's
    // existing `reason` channel rather than thrown — the operator command that
    // calls it already renders a refusal reason. Read inside the same IMMEDIATE
    // transaction as the CAS `UPDATE` below (not before it) so the refusal is
    // atomic with respect to a concurrent acquisition rather than an
    // independently-timed pre-check. The eligibility SELECT deliberately stays
    // *outside* that transaction, exactly as before: holding a write lock
    // across it would block the very concurrent `cancelEntry` the CAS exists to
    // lose to, and the CAS already pins the state this read observed.
    const row = this.#db.prepare(`SELECT * FROM outbox WHERE id = ?`).get(id) as RawOutboxEntry | undefined;
    if (!row) return { retried: false, reason: "not_found" };
    if (row.sent_at !== null) return { retried: false, reason: "already_sent" };
    const isDelayed = row.next_attempt_at !== null && row.next_attempt_at > asOf;
    const isDead = row.dead_letter_at !== null;
    if (!isDelayed && !isDead) return { retried: false, reason: "already_pending" };
    // Compare-and-swap against the exact state just read (issue #607 review
    // follow-up): a concurrent `cancelEntry` can commit between the SELECT
    // above and this UPDATE, and an unconditional write would clear that
    // cancellation and dead-letter marker, silently reactivating a row
    // another process already cancelled — the cancel command would have
    // already reported success while this retry undoes it and lets dispatch
    // publish the side effect anyway. `IS ?` (not `=`) pins next_attempt_at /
    // dead_letter_at / cancelled_at to their observed values including NULL,
    // so the UPDATE only commits if nothing changed underneath us; a
    // deliberate, sequential retry of an already-cancelled row (its
    // cancelled_at read and pinned as non-NULL here) still succeeds, since
    // nothing raced it.
    //
    // The cursor rewind (issue #820) runs inside this same transaction, after
    // and only after the CAS commits a row: a revived row whose cursors were
    // not rewound is stranded below every future scan's `id > afterId` window,
    // so the two writes must land together or not at all. A lost CAS race or a
    // held maintenance lock therefore leaves cursor state untouched.
    const outcome = this.#db
      .transaction((): "maintenance_locked" | false | { rewound: OutboxScanCursorRole[] } => {
        if (isMaintenanceLockHeld(this.#db)) return "maintenance_locked";
        const result = this.#db
          .prepare(
            `UPDATE outbox SET attempt_count = 0, next_attempt_at = NULL, dead_letter_at = NULL, cancelled_at = NULL
             WHERE id = ? AND sent_at IS NULL
               AND next_attempt_at IS ? AND dead_letter_at IS ? AND cancelled_at IS ?`,
          )
          .run(id, row.next_attempt_at, row.dead_letter_at, row.cancelled_at);
        if (result.changes === 0) return false;
        if (!cursorKeys || cursorIdentityKey === undefined) return { rewound: [] };
        // Order inside the transaction is irrelevant to a reader — both writes
        // become visible together — but both must happen: the rewind fixes the
        // cursor positions that exist *now*, and the fence bump (issue #820
        // review follow-up) invalidates the extent any dispatch run already in
        // flight will try to persist afterwards. Without the second, that run's
        // unconditional write would simply restore what the first undid.
        this.#bumpScanCursorFence(cursorIdentityKey);
        return { rewound: this.#rewindScanCursors(cursorKeys, id) };
      })
      .immediate();
    if (outcome === "maintenance_locked") return { retried: false, reason: "maintenance_locked" };
    if (outcome) {
      return cursorKeys ? { retried: true, cursorsRewound: outcome.rewound } : { retried: true };
    }

    // Lost the race — re-read to report why, without mutating anything.
    const fresh = this.#db.prepare(`SELECT * FROM outbox WHERE id = ?`).get(id) as RawOutboxEntry | undefined;
    if (!fresh) return { retried: false, reason: "not_found" };
    if (fresh.sent_at !== null) return { retried: false, reason: "already_sent" };
    if (fresh.cancelled_at !== null) return { retried: false, reason: "already_cancelled" };
    const stillDelayed = fresh.next_attempt_at !== null && fresh.next_attempt_at > asOf;
    const stillDead = fresh.dead_letter_at !== null;
    if (!stillDelayed && !stillDead) return { retried: false, reason: "already_pending" };
    return { retried: false, reason: "concurrent_update" };
  }

  /**
   * Pull every *existing* cursor of one dispatch identity back to `rowId - 1`
   * (issue #820). Call only from inside the transaction that committed the
   * retry of `rowId`.
   *
   * The `after_id >= ?` predicate is the SQL reading of `planScanCursorRewind`
   * — `>=` and not `>`, because the scan predicate is `id > after_id`, so a
   * cursor sitting exactly *on* the revived row already excludes it. `UPDATE`
   * (never upsert) is what keeps an absent cursor absent: a role with no row
   * already reads as "no confirmed progress", the conservative direction, and
   * inventing one would claim progress no run ever made.
   *
   * Returns the roles whose row actually moved, in role order.
   */
  #rewindScanCursors(keys: Record<OutboxScanCursorRole, string>, rowId: number): OutboxScanCursorRole[] {
    const rewind = this.#db.prepare(
      `UPDATE outbox_scan_cursor SET after_id = ? WHERE scan_key = ? AND after_id >= ?`,
    );
    const rewound: OutboxScanCursorRole[] = [];
    for (const role of OUTBOX_SCAN_CURSOR_ROLES) {
      if (rewind.run(rowId - 1, keys[role], rowId).changes > 0) rewound.push(role);
    }
    return rewound;
  }

  async cancelEntry(id: number, now?: string): Promise<{ cancelled: boolean; reason?: string }> {
    const asOf = now ?? new Date().toISOString();
    // Maintenance guard (issue #818), read inside the same IMMEDIATE
    // transaction as the cancelling UPDATE below: an `outbox cancel`
    // dead-letters a pending row, changing which §4 bucket a concurrent prune
    // batch would have classified it into. Reported through the existing
    // `reason` channel, like `retryEntry`.
    const attempt = this.#db
      .transaction((): { cancelled: boolean; reason?: string } | undefined => {
        if (isMaintenanceLockHeld(this.#db)) return { cancelled: false, reason: "maintenance_locked" };
        return this.#cancelEntryLocked(id, asOf);
      })
      .immediate();
    if (attempt) return attempt;

    // The UPDATE matched nothing — read the row to report why, without
    // re-mutating anything (a plain diagnostic SELECT, not a TOCTOU write).
    const row = this.#db.prepare(`SELECT * FROM outbox WHERE id = ?`).get(id) as RawOutboxEntry | undefined;
    if (!row) return { cancelled: false, reason: "not_found" };
    if (row.sent_at !== null) return { cancelled: false, reason: "already_sent" };
    if (row.cancelled_at !== null) return { cancelled: false, reason: "already_cancelled" };
    return { cancelled: false, reason: "dispatch_in_progress" };
  }

  /**
   * The cancelling `UPDATE` of {@link cancelEntry}, run inside its caller's
   * transaction. Returns `undefined` when it matched no row — the caller
   * re-reads outside the transaction to report why.
   */
  #cancelEntryLocked(id: number, asOf: string): { cancelled: boolean; reason?: string } | undefined {
    // Single atomic UPDATE, not a read-then-write (issue #607 review
    // follow-up): a dispatcher that already claimed this row via
    // `claimForDispatch` may be mid-flight on the external side effect, and
    // once it has performed that effect no cancellation can un-do it. The
    // `claimed_at` clause below is the same claim/check mechanism
    // `claimForDispatch` uses, so whichever of a racing claim/cancel pair's
    // `UPDATE` commits first is authoritative — the loser's `WHERE` simply no
    // longer matches, instead of both reads observing "not yet claimed" and
    // proceeding as if they'd won. COALESCE preserves an existing
    // dead_letter_at (set by exhausted retries) so cancelling an
    // already-dead row doesn't overwrite when it actually died.
    const result = this.#db
      .prepare(
        `UPDATE outbox SET dead_letter_at = COALESCE(dead_letter_at, ?), cancelled_at = ?
         WHERE id = ? AND sent_at IS NULL AND cancelled_at IS NULL AND (claimed_at IS NULL OR claimed_at <= ?)`,
      )
      .run(asOf, asOf, id, this.#claimStaleBefore(asOf));
    if (result.changes > 0) return { cancelled: true };
    return undefined;
  }

  async claimForDispatch(id: number, now?: string): Promise<boolean> {
    const asOf = now ?? new Date().toISOString();
    // Maintenance guard (issue #818), read inside the same IMMEDIATE
    // transaction as the claiming UPDATE so a claim can never interleave with
    // a maintenance acquisition: `acquire()` refuses while any non-stale claim
    // exists, and this refuses while a lock row exists, so exactly one of the
    // two commits. Refusing here is non-destructive — nothing is mutated and
    // the row stays pending — and it is what makes the dispatcher fail closed
    // *before* its external side effect rather than after.
    const run = this.#db.transaction((): boolean => {
      if (isMaintenanceLockHeld(this.#db)) return false;
      return this.#claimForDispatchLocked(id, asOf);
    });
    return run.immediate();
  }

  #claimForDispatchLocked(id: number, asOf: string): boolean {
    // Same atomic claim/check mechanism as `cancelEntry` above: only claims a
    // row that is still unsent, uncancelled, not dead-lettered, and not
    // already (non-stale) claimed. The `next_attempt_at` clause (P2 review
    // follow-up) additionally requires the row's backoff to have elapsed: two
    // overlapping dispatchers can both scan the same row while it is still
    // due, then one of them (via `markFailed`) sets a future
    // `next_attempt_at` before the other reaches this claim — without this
    // check the second dispatcher would still claim and dispatch it
    // immediately, bypassing the backoff `markFailed` just scheduled.
    const result = this.#db
      .prepare(
        `UPDATE outbox SET claimed_at = ?
         WHERE id = ? AND sent_at IS NULL AND cancelled_at IS NULL AND dead_letter_at IS NULL
           AND (claimed_at IS NULL OR claimed_at <= ?)
           AND (next_attempt_at IS NULL OR next_attempt_at <= ?)`,
      )
      .run(asOf, id, this.#claimStaleBefore(asOf), asOf);
    return result.changes > 0;
  }

  async renewClaim(id: number, claimedAt: string, now?: string): Promise<string | undefined> {
    const asOf = now ?? new Date().toISOString();
    // Compare-and-swap on the exact `claimed_at` the caller currently holds
    // (issue #607 review follow-up), not on staleness: renewal must succeed
    // regardless of how long ago `claimedAt` was set — that is precisely the
    // case (a slow but still-live external call) this exists to protect. If
    // `claimed_at` no longer equals `claimedAt`, the row already moved on
    // (sent/failed cleared it, or a stale sweep reclaimed it) and this caller
    // must not resurrect a claim it no longer owns.
    const result = this.#db
      .prepare(`UPDATE outbox SET claimed_at = ? WHERE id = ? AND claimed_at = ?`)
      .run(asOf, id, claimedAt);
    return result.changes > 0 ? asOf : undefined;
  }

  close(): void {
    this.#db.close();
  }
}
