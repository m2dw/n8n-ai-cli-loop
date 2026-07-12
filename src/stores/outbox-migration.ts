import type Database from "better-sqlite3";

/**
 * Migrate the `outbox` table to the schema that includes `idempotency_key`.
 *
 * SQLite does not allow adding a UNIQUE constraint via ALTER TABLE, so we
 * detect the legacy schema and recreate the table if necessary.
 *
 * Migration is idempotent: if the column already exists nothing happens.
 * Existing rows receive a `legacy-<id>` key so the UNIQUE constraint is
 * satisfied without losing any data.
 */
export function migrateOutboxTable(db: InstanceType<typeof Database>): void {
  const cols = db
    .prepare("PRAGMA table_info(outbox)")
    .all() as Array<{ name: string }>;

  // Table doesn't exist yet — nothing to migrate (CREATE TABLE will handle it)
  if (cols.length === 0) return;

  const hasKey = cols.some((c) => c.name === "idempotency_key");
  if (hasKey) return; // already up to date

  // Recreate with new schema, preserve existing rows.
  db.transaction(() => {
    db.exec(`
      CREATE TABLE outbox_v2 (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        idempotency_key   TEXT NOT NULL UNIQUE,
        topic             TEXT NOT NULL,
        payload           TEXT NOT NULL,
        created_at        TEXT NOT NULL,
        sent_at           TEXT
      );

      INSERT INTO outbox_v2 (id, idempotency_key, topic, payload, created_at, sent_at)
        SELECT id,
               'legacy-' || id,
               topic,
               payload,
               created_at,
               sent_at
        FROM outbox;

      DROP TABLE outbox;
      ALTER TABLE outbox_v2 RENAME TO outbox;
    `);
  })();
}
