import Database from "better-sqlite3";
import { homedir } from "os";
import { mkdirSync } from "fs";
import { join } from "path";
import type { OutboxEntry, OutboxEnqueueInput, OutboxStore, OutboxPayload, OutboxTopic } from "../core/outbox.js";
import { migrateOutboxTable } from "./outbox-migration.js";

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
  sent_at           TEXT
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key         TEXT PRIMARY KEY,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
`;

interface RawOutboxEntry {
  id: number;
  idempotency_key: string;
  topic: string;
  payload: string;
  created_at: string;
  sent_at: string | null;
}

function rawToEntry(row: RawOutboxEntry): OutboxEntry {
  return {
    id: row.id,
    idempotencyKey: row.idempotency_key,
    topic: row.topic as OutboxTopic,
    payload: JSON.parse(row.payload) as OutboxPayload,
    createdAt: row.created_at,
    sentAt: row.sent_at ?? undefined,
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
    const deletePending = this.#db.prepare(
      `DELETE FROM outbox
       WHERE topic = 'repohost:pr-summary'
         AND sent_at IS NULL
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
    const rows = (
      limit === undefined
        ? this.#db.prepare(`SELECT * FROM outbox WHERE sent_at IS NULL ORDER BY id ASC`).all()
        : this.#db
            .prepare(`SELECT * FROM outbox WHERE sent_at IS NULL ORDER BY id ASC LIMIT ?`)
            .all(limit)
    ) as RawOutboxEntry[];
    return rows.map(rawToEntry);
  }

  async markSent(id: number, sentAt?: string): Promise<void> {
    const ts = sentAt ?? new Date().toISOString();
    this.#db.prepare(`UPDATE outbox SET sent_at = ? WHERE id = ?`).run(ts, id);
  }

  close(): void {
    this.#db.close();
  }
}
