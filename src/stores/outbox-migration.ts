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

/**
 * Add per-row delivery-state columns to an existing `outbox` table: attempt
 * count, last error, next-retry time, and dead-letter timestamp (issue #606).
 *
 * Unlike {@link migrateOutboxTable}, these columns are nullable with no UNIQUE
 * constraint, so a plain `ALTER TABLE ... ADD COLUMN` (guarded by a
 * `PRAGMA table_info` probe) is sufficient — no table rebuild needed.
 * Idempotent: a column already present is left untouched, and a table created
 * fresh by the current SCHEMA already has all four so this is a no-op.
 *
 * The probe and the ALTERs run inside a single `BEGIN IMMEDIATE` transaction
 * so concurrent processes upgrading the same pre-#606 database serialize on
 * SQLite's write lock instead of racing: the loser blocks (up to
 * `busy_timeout`) until the winner commits, then re-probes and finds the
 * columns already present, rather than reading the old schema and failing
 * with `duplicate column name`.
 */
export function migrateOutboxRetryColumns(db: InstanceType<typeof Database>): void {
  const probe = () =>
    db.prepare("PRAGMA table_info(outbox)").all() as Array<{ name: string }>;

  // Table doesn't exist yet — nothing to migrate (CREATE TABLE will handle it)
  if (probe().length === 0) return;

  db.transaction(() => {
    const cols = probe();
    if (cols.length === 0) return;

    const names = new Set(cols.map((c) => c.name));
    if (!names.has("attempt_count")) {
      db.exec("ALTER TABLE outbox ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0");
    }
    if (!names.has("last_error")) {
      db.exec("ALTER TABLE outbox ADD COLUMN last_error TEXT");
    }
    if (!names.has("next_attempt_at")) {
      db.exec("ALTER TABLE outbox ADD COLUMN next_attempt_at TEXT");
    }
    if (!names.has("dead_letter_at")) {
      db.exec("ALTER TABLE outbox ADD COLUMN dead_letter_at TEXT");
    }
  }).immediate();
}

/**
 * Add the `cancelled_at` column to an existing `outbox` table (issue #607):
 * set when an operator explicitly cancels a row via `admin outbox cancel`, as
 * opposed to an automatic dead-letter from exhausting the retry budget. Same
 * idempotent `ALTER TABLE` pattern as {@link migrateOutboxRetryColumns}, run
 * inside its own `BEGIN IMMEDIATE` transaction so concurrent upgraders
 * serialize instead of racing on `duplicate column name`.
 */
export function migrateOutboxCancelColumn(db: InstanceType<typeof Database>): void {
  const probe = () =>
    db.prepare("PRAGMA table_info(outbox)").all() as Array<{ name: string }>;

  // Table doesn't exist yet — nothing to migrate (CREATE TABLE will handle it)
  if (probe().length === 0) return;

  db.transaction(() => {
    const cols = probe();
    if (cols.length === 0) return;

    const names = new Set(cols.map((c) => c.name));
    if (!names.has("cancelled_at")) {
      db.exec("ALTER TABLE outbox ADD COLUMN cancelled_at TEXT");
    }
  }).immediate();
}

/**
 * Add the `claimed_at` column to an existing `outbox` table (issue #607 review
 * follow-up): set for the duration of a single dispatch attempt so
 * `admin outbox cancel` can atomically detect an in-flight dispatch and refuse
 * to report `cancelled: true` for a row that may already have been delivered.
 * Same idempotent `ALTER TABLE` pattern as {@link migrateOutboxCancelColumn}.
 */
export function migrateOutboxClaimColumn(db: InstanceType<typeof Database>): void {
  const probe = () =>
    db.prepare("PRAGMA table_info(outbox)").all() as Array<{ name: string }>;

  // Table doesn't exist yet — nothing to migrate (CREATE TABLE will handle it)
  if (probe().length === 0) return;

  db.transaction(() => {
    const cols = probe();
    if (cols.length === 0) return;

    const names = new Set(cols.map((c) => c.name));
    if (!names.has("claimed_at")) {
      db.exec("ALTER TABLE outbox ADD COLUMN claimed_at TEXT");
    }
  }).immediate();
}
