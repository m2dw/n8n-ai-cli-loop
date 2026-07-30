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
import {
  migrateOutboxTable,
  migrateOutboxRetryColumns,
  migrateOutboxCancelColumn,
  migrateOutboxClaimColumn,
} from "./outbox-migration.js";
import { sanitizeBody, redactTokens, boundedExcerpt } from "../core/text-sanitize.js";

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

  constructor(dbPath: string = DEFAULT_DB_PATH) {
    const dir = join(dbPath, "..");
    mkdirSync(dir, { recursive: true });
    this.#db = new Database(dbPath);
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

  async enqueue(input: OutboxEnqueueInput): Promise<{ enqueued: boolean }> {
    const now = input.now ?? new Date().toISOString();
    const result = this.#db
      .prepare(
        `INSERT OR IGNORE INTO outbox (idempotency_key, topic, payload, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(input.idempotencyKey, input.topic, JSON.stringify(input.payload), now);
    return { enqueued: result.changes > 0 };
  }

  async replacePendingPrSummary(
    input: OutboxEnqueueInput,
    key: { owner: string; repo: string; prNumber: number; marker: string },
  ): Promise<{ enqueued: boolean }> {
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
    const run = this.#db.transaction(() => {
      // Insert first so that a duplicate idempotency key is detected before any
      // rows are deleted. If the key already exists (INSERT OR IGNORE → 0 changes),
      // we must not delete a newer pending summary that was queued after the
      // already-seen key was dispatched.
      const insertResult = insertEntry.run(input.idempotencyKey, input.topic, JSON.stringify(input.payload), now);
      if (insertResult.changes > 0) {
        deletePending.run(input.idempotencyKey, key.owner, key.repo, key.prNumber, key.marker);
      }
      return insertResult;
    });
    const result = run();
    return { enqueued: result.changes > 0 };
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

  async setScanCursor(key: string, id: number): Promise<void> {
    this.#db
      .prepare(
        `INSERT INTO outbox_scan_cursor (scan_key, after_id) VALUES (?, ?)
         ON CONFLICT(scan_key) DO UPDATE SET after_id = excluded.after_id`,
      )
      .run(key, id);
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

  async retryEntry(id: number, now?: string): Promise<{ retried: boolean; reason?: string }> {
    const asOf = now ?? new Date().toISOString();
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
    const result = this.#db
      .prepare(
        `UPDATE outbox SET attempt_count = 0, next_attempt_at = NULL, dead_letter_at = NULL, cancelled_at = NULL
         WHERE id = ? AND sent_at IS NULL
           AND next_attempt_at IS ? AND dead_letter_at IS ? AND cancelled_at IS ?`,
      )
      .run(id, row.next_attempt_at, row.dead_letter_at, row.cancelled_at);
    if (result.changes > 0) return { retried: true };

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

  async cancelEntry(id: number, now?: string): Promise<{ cancelled: boolean; reason?: string }> {
    const asOf = now ?? new Date().toISOString();
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

    // The UPDATE matched nothing — read the row to report why, without
    // re-mutating anything (a plain diagnostic SELECT, not a TOCTOU write).
    const row = this.#db.prepare(`SELECT * FROM outbox WHERE id = ?`).get(id) as RawOutboxEntry | undefined;
    if (!row) return { cancelled: false, reason: "not_found" };
    if (row.sent_at !== null) return { cancelled: false, reason: "already_sent" };
    if (row.cancelled_at !== null) return { cancelled: false, reason: "already_cancelled" };
    return { cancelled: false, reason: "dispatch_in_progress" };
  }

  async claimForDispatch(id: number, now?: string): Promise<boolean> {
    const asOf = now ?? new Date().toISOString();
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
