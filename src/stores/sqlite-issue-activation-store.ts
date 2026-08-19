import Database from "better-sqlite3";
import { homedir } from "os";
import { mkdirSync } from "fs";
import { join } from "path";
import type { IssueActivationStore, IssueAutomationSuspension } from "../core/issue-activation.js";

const DEFAULT_DB_PATH = join(homedir(), ".config", "n8n-ai-cli-loop", "dev_loop.db");

/**
 * How long a connection waits for another process's lock before giving up.
 *
 * 30s rather than the 5s the sibling stores use: every `admin chain` and
 * `admin issue` command constructs this store, so a stampede of processes
 * opening (and first-time-converting) the same file is this store's normal
 * case, and 5s of wall clock proved expirable when the losers compete with the
 * winner for CPU — a loser timed out with `database is locked` under a
 * saturated parallel test run. Waiting longer cannot hang on a dead holder:
 * the OS releases SQLite's file locks when the holding process exits.
 */
const BUSY_TIMEOUT_MS = 30_000;

/**
 * Connection settings, applied outside the migration below: the busy timeout is
 * what makes a process that loses the migration race wait for the winner
 * instead of failing immediately, and it is set FIRST because the WAL switch
 * that follows in {@link enableWalMode} takes a write transaction of its own —
 * exactly what a second process opening the same legacy file at the same moment
 * would collide with. `journal_mode` stays out of this string for the same
 * reason it stays out of the migration: it cannot be set from within a
 * transaction, and unlike everything else it needs a retry the busy handler
 * does not provide.
 */
const PRAGMAS = `
PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};
`;

/** Block the calling thread; the constructor this serves is synchronous. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * True for the `SQLITE_BUSY` family — "database is locked", i.e. retry later.
 * better-sqlite3 sets `code` on the errors it throws; the message is checked as
 * well so a driver that only carries the text is still classified as busy
 * rather than escalated as an unknown failure.
 */
function isBusyError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  if (typeof code === "string" && code.startsWith("SQLITE_BUSY")) return true;
  const message = (err as { message?: unknown } | null | undefined)?.message;
  return typeof message === "string" && /database is locked|SQLITE_BUSY/i.test(message);
}

/**
 * Backoff between WAL-conversion attempts, capped so a long wait is still
 * mostly spent sleeping rather than spinning. The loop below runs until
 * {@link BUSY_TIMEOUT_MS} is exhausted, so this list only shapes the ramp.
 */
const WAL_RETRY_BACKOFF_MS: readonly number[] = [10, 25, 50, 100, 200, 250];

/**
 * Put the connection into WAL mode, retrying while another process holds the
 * lock (issue #791 review).
 *
 * The retry cannot be replaced by `busy_timeout`. Converting a rollback-journal
 * database to WAL bumps the file-format version, which SQLite does by opening a
 * read transaction and then upgrading it to a write transaction — and on that
 * upgrade the busy handler is deliberately NOT invoked, because a connection
 * that already holds a read lock waiting for a writer is how two connections
 * deadlock. So the pragma can come straight back with `database is locked` no
 * matter how large the timeout is, which is what a stampede of first-time
 * openers hit: raising the timeout from 5s to 30s made it rarer, not impossible.
 *
 * Retrying converges rather than merely re-rolling the dice: the loser's next
 * attempt reads a header the winner has already stamped as WAL, and an
 * already-WAL database makes this pragma a no-op that takes no write lock at
 * all. Everything after this point (the migration's `BEGIN IMMEDIATE`, and all
 * normal statements) starts from no transaction, where the busy handler does
 * apply and `busy_timeout` is the whole story.
 */
function enableWalMode(db: Database.Database): void {
  const deadline = Date.now() + BUSY_TIMEOUT_MS;
  for (let attempt = 0; ; attempt += 1) {
    try {
      db.exec("PRAGMA journal_mode = WAL;");
      return;
    } catch (err: unknown) {
      // A non-busy failure is a real problem; surface it unchanged. So is a busy
      // one that outlived the same budget every other lock wait here gets.
      if (!isBusyError(err) || Date.now() >= deadline) throw err;
      sleepSync(WAL_RETRY_BACKOFF_MS[Math.min(attempt, WAL_RETRY_BACKOFF_MS.length - 1)]);
    }
  }
}

/**
 * Restorable-suspension state for `admin issue activate|suspend` (issue
 * #787), keyed by (session, issue) so only the labels a suspend actually
 * removed for THAT issue are ever restored. Shares the SQLite file the task
 * store and session-control tables use. CREATE TABLE IF NOT EXISTS keeps
 * construction order safe regardless of which store class opens the database
 * first (same pattern as session_control in
 * sqlite-session-control-store.ts).
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS issue_automation_suspension (
  session_id       TEXT NOT NULL,
  issue_number     INTEGER NOT NULL,
  labels           TEXT NOT NULL,
  operation_id     TEXT NOT NULL,
  label_operations TEXT,
  suspended_at     TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  rev              INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (session_id, issue_number)
);
`;

/**
 * Columns added after the table shipped, with the `ALTER TABLE` that adds each
 * one. `CREATE TABLE IF NOT EXISTS` leaves an existing table alone, so a
 * database opened by an earlier build needs the column added rather than the
 * schema re-run — same guarded pattern as stores/chain-registry-migration.ts.
 */
const ADDED_COLUMNS: ReadonlyArray<{ column: string; ddl: string }> = [
  {
    column: "label_operations",
    ddl: "ALTER TABLE issue_automation_suspension ADD COLUMN label_operations TEXT",
  },
];

/**
 * Bring `db` up to the current shape: create the table if it is absent, then add
 * any column an earlier build left out.
 *
 * The `CREATE TABLE IF NOT EXISTS`, the `PRAGMA table_info` probes, and the
 * `ALTER TABLE`s they guard all run inside ONE `BEGIN IMMEDIATE` transaction, so
 * two processes opening the same database file serialize on SQLite's write lock
 * instead of racing: the loser blocks until the winner commits, then re-probes
 * and sees the finished schema. Probing outside the transaction let both
 * processes read the column as missing and the loser fail with `duplicate column
 * name` — a real hazard the first time a legacy database is opened, because
 * `admin chain` and `admin issue` commands construct this store on every run
 * (issue #791 review). Same reasoning, and same shape, as
 * `migrateChainRegistrySchema`.
 *
 * The connection PRAGMAs stay outside: `journal_mode` cannot be changed from
 * within a transaction.
 */
function migrate(db: Database.Database): void {
  db.transaction(() => {
    db.exec(SCHEMA);
    const existing = new Set(
      (db.prepare("PRAGMA table_info(issue_automation_suspension)").all() as Array<{ name: string }>).map(
        (c) => c.name,
      ),
    );
    for (const { column, ddl } of ADDED_COLUMNS) {
      if (!existing.has(column)) db.exec(ddl);
    }
  }).immediate();
}

interface RawRow {
  session_id: string;
  issue_number: number;
  labels: string;
  operation_id: string;
  label_operations: string | null;
  suspended_at: string;
  updated_at: string;
  rev: number;
}

/**
 * Per-label attribution as stored, or `undefined` for a row written before the
 * column existed (and for one whose JSON is unreadable — an unparseable map is
 * no attribution at all, and `suspensionLabelOwner` falls back to the
 * record-level operation exactly as those older rows do).
 */
function parseLabelOperations(raw: string | null): Record<string, string> | undefined {
  if (raw === null) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const entries = Object.entries(parsed as Record<string, unknown>).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    );
    return entries.length === 0 ? undefined : Object.fromEntries(entries);
  } catch {
    return undefined;
  }
}

function rowToRecord(row: RawRow): IssueAutomationSuspension {
  const labelOperations = parseLabelOperations(row.label_operations);
  return {
    sessionId: row.session_id,
    issueNumber: row.issue_number,
    labels: JSON.parse(row.labels) as string[],
    operationId: row.operation_id,
    ...(labelOperations === undefined ? {} : { labelOperations }),
    suspendedAt: row.suspended_at,
    updatedAt: row.updated_at,
    rev: row.rev,
  };
}

function labelOperationsColumn(record: IssueAutomationSuspension): string | null {
  return record.labelOperations === undefined ? null : JSON.stringify(record.labelOperations);
}

export class SqliteIssueActivationStore implements IssueActivationStore {
  readonly #db: Database.Database;

  constructor(dbPath?: string) {
    const resolved = dbPath ?? DEFAULT_DB_PATH;
    mkdirSync(join(resolved, ".."), { recursive: true });
    this.#db = new Database(resolved);
    this.#db.exec(PRAGMAS);
    enableWalMode(this.#db);
    migrate(this.#db);
  }

  close(): void {
    this.#db.close();
  }

  async getSuspension(sessionId: string, issueNumber: number): Promise<IssueAutomationSuspension | undefined> {
    const row = this.#db
      .prepare("SELECT * FROM issue_automation_suspension WHERE session_id = ? AND issue_number = ?")
      .get(sessionId, issueNumber) as RawRow | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  async putSuspension(record: IssueAutomationSuspension): Promise<void> {
    this.#db
      .prepare(
        `INSERT INTO issue_automation_suspension
           (session_id, issue_number, labels, operation_id, label_operations, suspended_at, updated_at, rev)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1)
         ON CONFLICT(session_id, issue_number) DO UPDATE SET
           labels = excluded.labels,
           operation_id = excluded.operation_id,
           label_operations = excluded.label_operations,
           updated_at = excluded.updated_at,
           rev = issue_automation_suspension.rev + 1`,
      )
      .run(
        record.sessionId,
        record.issueNumber,
        JSON.stringify(record.labels),
        record.operationId,
        labelOperationsColumn(record),
        record.suspendedAt,
        record.updatedAt,
      );
  }

  async clearSuspension(sessionId: string, issueNumber: number): Promise<void> {
    this.#db
      .prepare("DELETE FROM issue_automation_suspension WHERE session_id = ? AND issue_number = ?")
      .run(sessionId, issueNumber);
  }

  async putSuspensionIfUnchanged(
    record: IssueAutomationSuspension,
    expectedRev: number | undefined,
  ): Promise<boolean> {
    if (expectedRev === undefined) {
      // CAS-create: only commits if no row exists yet — a concurrent writer
      // that already created one must not be silently overwritten.
      const result = this.#db
        .prepare(
          `INSERT INTO issue_automation_suspension
             (session_id, issue_number, labels, operation_id, label_operations, suspended_at, updated_at, rev)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1)
           ON CONFLICT(session_id, issue_number) DO NOTHING`,
        )
        .run(
          record.sessionId,
          record.issueNumber,
          JSON.stringify(record.labels),
          record.operationId,
          labelOperationsColumn(record),
          record.suspendedAt,
          record.updatedAt,
        );
      return result.changes > 0;
    }
    // CAS-update keyed on the monotonic `rev`, not `updated_at` (issue #787
    // review): two concurrent writers can compute the same ISO-millisecond
    // timestamp, which would let a timestamp-only predicate match a row that
    // has actually moved on since this caller's read. `rev` is bumped by this
    // very statement, so it can never collide between two real writes.
    const result = this.#db
      .prepare(
        `UPDATE issue_automation_suspension
           SET labels = ?, operation_id = ?, label_operations = ?, updated_at = ?, rev = rev + 1
         WHERE session_id = ? AND issue_number = ? AND rev = ?`,
      )
      .run(
        JSON.stringify(record.labels),
        record.operationId,
        labelOperationsColumn(record),
        record.updatedAt,
        record.sessionId,
        record.issueNumber,
        expectedRev,
      );
    return result.changes > 0;
  }

  async clearSuspensionIfUnchanged(
    sessionId: string,
    issueNumber: number,
    expectedRev: number,
  ): Promise<boolean> {
    const result = this.#db
      .prepare("DELETE FROM issue_automation_suspension WHERE session_id = ? AND issue_number = ? AND rev = ?")
      .run(sessionId, issueNumber, expectedRev);
    return result.changes > 0;
  }
}
