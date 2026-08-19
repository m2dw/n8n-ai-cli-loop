import type Database from "better-sqlite3";

/**
 * Schema and forward migrations for the dependency-chain registry (issue
 * #788).
 *
 * The registry shares the same SQLite file as the task, outbox, and
 * session-control tables, so every statement here is additive and guarded:
 * `CREATE TABLE IF NOT EXISTS` keeps construction order irrelevant no matter
 * which store opens the database first, and no statement drops, rewrites, or
 * reads a table this module does not own. Opening the registry against an
 * existing `dev_loop.db` therefore leaves every pre-existing table and row
 * exactly as it found them.
 */

/**
 * Tables as a *fresh* database gets them — the full current shape, created in
 * one step. A database created by an earlier build is brought forward by
 * {@link CHAIN_REGISTRY_ADDITIVE_COLUMNS} instead; the two are kept in sync by
 * `test/chain-registry-migration.test.js`, which fails if an additive column
 * is missing from the freshly created shape.
 *
 * `dependency_chain_edge` carries composite foreign keys into
 * `dependency_chain_member` rather than plain issue numbers: that is what
 * makes "an edge may only name members of its own chain" a storage rule
 * instead of an application convention. `SqliteChainRegistryStore` enables
 * `PRAGMA foreign_keys` on its connection so these are enforced rather than
 * decorative.
 *
 * `dependency_chain_frozen_prefix` (issue #891) is the one table here that
 * deliberately carries *no* foreign key on `chain_id`. It is written from two
 * connections — `SqliteChainRegistryStore`, which enables `PRAGMA
 * foreign_keys`, and `SqliteTaskStore`, which does not, because a freeze has to
 * commit in the same transaction as the task transition it belongs to. A
 * constraint enforced from one writer and silently ignored from the other is
 * worse than no constraint at all: it would make the same call succeed or fail
 * depending on which store made it. Both writers check the chain exists inside
 * their own transaction instead, and `deleteChain` removes these rows
 * explicitly.
 *
 * `dependency_chain_edit_lock` (issue #791 review) holds the exclusive scopes of
 * one in-flight linear chain edit — see `core/chain-edit-lock.ts` for what a
 * scope means and why an edit needs one. Like the intake-error table it carries
 * no `chain_id`: a scope names an Issue or a not-yet-registered chain name, both
 * of which exist before (and independently of) any chain row. `owner_pid` /
 * `owner_host` name the process holding the claim: a lock is taken over only
 * once its owner is *gone*, because a run blocked in a `spawnSync` provider call
 * fires no heartbeat and would otherwise be superseded mid-mutation. Both are
 * nullable — a row written by an older build, or by a caller that cannot answer
 * for a pid, is judged on age alone as it always was.
 *
 * `dependency_chain_intake_error` (issue #790) records the last durable
 * chain-registration refusal per (session, Issue) — the fingerprint intake's
 * once-per-distinct-failure comment keys on. It carries no `chain_id` at all:
 * a refusal can predate any chain existing for the Issue (a rejected create),
 * so the row is keyed by the candidate, not by a chain.
 */
export const CHAIN_REGISTRY_SCHEMA = `
CREATE TABLE IF NOT EXISTS dependency_chain (
  chain_id            TEXT PRIMARY KEY,
  session_id          TEXT NOT NULL,
  origin_issue_number INTEGER NOT NULL,
  head_issue_number   INTEGER NOT NULL,
  title               TEXT,
  graph_revision      INTEGER NOT NULL DEFAULT 1,
  graph_fingerprint   TEXT NOT NULL DEFAULT '',
  accepted_revision   INTEGER,
  sync_status         TEXT NOT NULL DEFAULT 'unknown',
  sync_error          TEXT,
  sync_checked_at     TEXT,
  synced_at           TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  rev                 INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS dependency_chain_member (
  chain_id     TEXT NOT NULL REFERENCES dependency_chain(chain_id) ON DELETE CASCADE,
  issue_number INTEGER NOT NULL,
  role         TEXT NOT NULL DEFAULT 'node',
  added_at     TEXT NOT NULL,
  PRIMARY KEY (chain_id, issue_number)
);

CREATE TABLE IF NOT EXISTS dependency_chain_edge (
  chain_id              TEXT NOT NULL REFERENCES dependency_chain(chain_id) ON DELETE CASCADE,
  blocker_issue_number  INTEGER NOT NULL,
  blocked_issue_number  INTEGER NOT NULL,
  created_at            TEXT NOT NULL,
  PRIMARY KEY (chain_id, blocker_issue_number, blocked_issue_number),
  CHECK (blocker_issue_number <> blocked_issue_number),
  FOREIGN KEY (chain_id, blocker_issue_number)
    REFERENCES dependency_chain_member(chain_id, issue_number) ON DELETE CASCADE,
  FOREIGN KEY (chain_id, blocked_issue_number)
    REFERENCES dependency_chain_member(chain_id, issue_number) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS dependency_chain_revision (
  chain_id    TEXT NOT NULL REFERENCES dependency_chain(chain_id) ON DELETE CASCADE,
  revision    INTEGER NOT NULL,
  fingerprint TEXT NOT NULL,
  state       TEXT NOT NULL DEFAULT 'candidate',
  source      TEXT,
  note        TEXT,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (chain_id, revision)
);

CREATE TABLE IF NOT EXISTS dependency_chain_alias (
  alias      TEXT PRIMARY KEY,
  chain_id   TEXT NOT NULL REFERENCES dependency_chain(chain_id) ON DELETE CASCADE,
  reason     TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS dependency_chain_frozen_prefix (
  session_id         TEXT NOT NULL,
  issue_number       INTEGER NOT NULL,
  chain_id           TEXT NOT NULL,
  graph_revision     INTEGER NOT NULL,
  graph_fingerprint  TEXT NOT NULL,
  prefix_fingerprint TEXT NOT NULL,
  ancestors          TEXT NOT NULL,
  predecessors       TEXT NOT NULL,
  edges              TEXT NOT NULL,
  prefix_order       TEXT NOT NULL,
  base_kind          TEXT NOT NULL,
  base_ref           TEXT NOT NULL,
  base_issue_number  INTEGER,
  source             TEXT,
  note               TEXT,
  frozen_at          TEXT NOT NULL,
  PRIMARY KEY (session_id, issue_number)
);

CREATE TABLE IF NOT EXISTS dependency_chain_edit_lock (
  scope        TEXT PRIMARY KEY,
  owner_id     TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  acquired_at  TEXT NOT NULL,
  owner_pid    INTEGER,
  owner_host   TEXT
);

CREATE TABLE IF NOT EXISTS dependency_chain_intake_error (
  session_id   TEXT NOT NULL,
  issue_number INTEGER NOT NULL,
  fingerprint  TEXT NOT NULL,
  kind         TEXT NOT NULL,
  message      TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (session_id, issue_number)
);
`;

/**
 * Indexes for the registry's read paths. Created after the column migration
 * so an index may reference a column an older database only just gained.
 */
export const CHAIN_REGISTRY_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_dependency_chain_session
  ON dependency_chain(session_id);
CREATE INDEX IF NOT EXISTS idx_dependency_chain_head
  ON dependency_chain(head_issue_number);
CREATE INDEX IF NOT EXISTS idx_dependency_chain_member_issue
  ON dependency_chain_member(issue_number);
CREATE INDEX IF NOT EXISTS idx_dependency_chain_edge_blocked
  ON dependency_chain_edge(chain_id, blocked_issue_number);
CREATE INDEX IF NOT EXISTS idx_dependency_chain_alias_chain
  ON dependency_chain_alias(chain_id);
CREATE INDEX IF NOT EXISTS idx_dependency_chain_frozen_prefix_chain
  ON dependency_chain_frozen_prefix(chain_id);
`;

/**
 * Columns that a database created by an earlier build of this store may be
 * missing, with the `ALTER TABLE` that adds each one.
 *
 * Only columns that can be added this way belong here: SQLite's
 * `ALTER TABLE ... ADD COLUMN` cannot introduce a `PRIMARY KEY`, a `UNIQUE`
 * constraint, or a `NOT NULL` column without a constant default, so every
 * entry is nullable or carries a default. Anything needing a table rebuild
 * would follow the copy-and-rename pattern in `outbox-migration.ts` instead.
 */
export const CHAIN_REGISTRY_ADDITIVE_COLUMNS: ReadonlyArray<{
  table: string;
  column: string;
  ddl: string;
}> = [
  { table: "dependency_chain", column: "title", ddl: "ALTER TABLE dependency_chain ADD COLUMN title TEXT" },
  {
    table: "dependency_chain",
    column: "graph_revision",
    ddl: "ALTER TABLE dependency_chain ADD COLUMN graph_revision INTEGER NOT NULL DEFAULT 1",
  },
  {
    table: "dependency_chain",
    column: "graph_fingerprint",
    ddl: "ALTER TABLE dependency_chain ADD COLUMN graph_fingerprint TEXT NOT NULL DEFAULT ''",
  },
  {
    table: "dependency_chain",
    column: "accepted_revision",
    ddl: "ALTER TABLE dependency_chain ADD COLUMN accepted_revision INTEGER",
  },
  {
    table: "dependency_chain",
    column: "sync_status",
    ddl: "ALTER TABLE dependency_chain ADD COLUMN sync_status TEXT NOT NULL DEFAULT 'unknown'",
  },
  { table: "dependency_chain", column: "sync_error", ddl: "ALTER TABLE dependency_chain ADD COLUMN sync_error TEXT" },
  {
    table: "dependency_chain",
    column: "sync_checked_at",
    ddl: "ALTER TABLE dependency_chain ADD COLUMN sync_checked_at TEXT",
  },
  { table: "dependency_chain", column: "synced_at", ddl: "ALTER TABLE dependency_chain ADD COLUMN synced_at TEXT" },
  {
    table: "dependency_chain",
    column: "rev",
    ddl: "ALTER TABLE dependency_chain ADD COLUMN rev INTEGER NOT NULL DEFAULT 1",
  },
  {
    table: "dependency_chain_member",
    column: "role",
    ddl: "ALTER TABLE dependency_chain_member ADD COLUMN role TEXT NOT NULL DEFAULT 'node'",
  },
  {
    table: "dependency_chain_revision",
    column: "state",
    ddl: "ALTER TABLE dependency_chain_revision ADD COLUMN state TEXT NOT NULL DEFAULT 'candidate'",
  },
  {
    table: "dependency_chain_revision",
    column: "source",
    ddl: "ALTER TABLE dependency_chain_revision ADD COLUMN source TEXT",
  },
  {
    table: "dependency_chain_revision",
    column: "note",
    ddl: "ALTER TABLE dependency_chain_revision ADD COLUMN note TEXT",
  },
  { table: "dependency_chain_alias", column: "reason", ddl: "ALTER TABLE dependency_chain_alias ADD COLUMN reason TEXT" },
  {
    table: "dependency_chain_edit_lock",
    column: "owner_pid",
    ddl: "ALTER TABLE dependency_chain_edit_lock ADD COLUMN owner_pid INTEGER",
  },
  {
    table: "dependency_chain_edit_lock",
    column: "owner_host",
    ddl: "ALTER TABLE dependency_chain_edit_lock ADD COLUMN owner_host TEXT",
  },
];

/**
 * Bring `db` up to the current registry schema, creating what is absent and
 * adding any column an older build left out.
 *
 * Repeatable by construction: every create is `IF NOT EXISTS` and every
 * `ALTER` is guarded by a `PRAGMA table_info` probe, so a second run finds
 * nothing to do and a database already at the current shape is untouched.
 *
 * The probes and the statements they guard run inside one `BEGIN IMMEDIATE`
 * transaction, so two processes upgrading the same file serialize on SQLite's
 * write lock instead of racing: the loser blocks until the winner commits,
 * then re-probes and sees the finished schema, rather than reading the old
 * shape and failing with `duplicate column name` (the same reasoning as
 * `migrateOutboxRetryColumns`). A failure anywhere rolls the whole upgrade
 * back — an interrupted migration leaves the old schema, never a half-built
 * one.
 */
export function migrateChainRegistrySchema(db: InstanceType<typeof Database>): void {
  db.transaction(() => {
    db.exec(CHAIN_REGISTRY_SCHEMA);

    const columnsOf = (table: string) =>
      new Set(
        (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name),
      );

    const cache = new Map<string, Set<string>>();
    for (const { table, column, ddl } of CHAIN_REGISTRY_ADDITIVE_COLUMNS) {
      let names = cache.get(table);
      if (!names) {
        names = columnsOf(table);
        cache.set(table, names);
      }
      // A table absent even after CHAIN_REGISTRY_SCHEMA ran cannot be
      // altered; skipping keeps the migration a no-op instead of throwing.
      if (names.size === 0) continue;
      if (names.has(column)) continue;
      db.exec(ddl);
      names.add(column);
    }

    db.exec(CHAIN_REGISTRY_INDEXES);
  }).immediate();
}
