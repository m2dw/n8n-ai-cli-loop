/**
 * Dependency-chain registry schema and migrations (issue #788).
 *
 * The registry shares `dev_loop.db` with the task, outbox, and
 * session-control tables, so the migration has to be additive, repeatable,
 * and blind to everything it does not own. These tests pin exactly that:
 * opening the registry against a populated database leaves it intact, running
 * the migration again changes nothing, and a database created by an earlier
 * build gains the columns it lacks without losing a row.
 */
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  CHAIN_REGISTRY_ADDITIVE_COLUMNS,
  SqliteChainRegistryStore,
  migrateChainRegistrySchema,
} from '../dist/index.js';

const REGISTRY_TABLES = [
  'dependency_chain',
  'dependency_chain_member',
  'dependency_chain_edge',
  'dependency_chain_revision',
  'dependency_chain_alias',
  // Issue #891. Carries `chain_id` like every other child table, so the
  // orphan-row sweep below covers it too, but deliberately without a foreign
  // key — see the migration's header.
  'dependency_chain_frozen_prefix',
];

let tmpDir;
let dbPath;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'chain-registry-migration-'));
  dbPath = join(tmpDir, 'dev_loop.db');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function columnsOf(db, table) {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((c) => c.name);
}

function tableNames(db) {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((r) => r.name);
}

test('a fresh database gets every registry table', () => {
  const store = new SqliteChainRegistryStore(dbPath);
  store.close();

  const db = new Database(dbPath);
  try {
    expect(tableNames(db)).toEqual(expect.arrayContaining(REGISTRY_TABLES));
  } finally {
    db.close();
  }
});

test('every additive column also exists in the freshly created shape', () => {
  // The two halves of the migration must not drift: a column an older
  // database is upgraded to must be one a new database is born with,
  // otherwise the two paths produce different schemas.
  const store = new SqliteChainRegistryStore(dbPath);
  store.close();

  const db = new Database(dbPath);
  try {
    for (const { table, column } of CHAIN_REGISTRY_ADDITIVE_COLUMNS) {
      expect(columnsOf(db, table)).toContain(column);
    }
  } finally {
    db.close();
  }
});

test('an edit-lock table from an earlier build gains the owner columns and keeps its claim', () => {
  // The pre-liveness shape (issue #791 review): a claim recorded without the
  // process that took it. The upgrade must not drop the row — it may be a claim
  // an edit is holding right now — and the rebuilt columns must read as "no pid
  // recorded", which is what puts such a row back on the age-only rule.
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE dependency_chain_edit_lock (
      scope        TEXT PRIMARY KEY,
      owner_id     TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      acquired_at  TEXT NOT NULL
    );
    INSERT INTO dependency_chain_edit_lock (scope, owner_id, operation_id, acquired_at)
      VALUES ('issue:s1:11', 'owner-1', 'admin chain new-10,11', '2026-01-01T00:00:00.000Z');
  `);
  try {
    migrateChainRegistrySchema(db);
    expect(columnsOf(db, 'dependency_chain_edit_lock')).toEqual(
      expect.arrayContaining(['owner_pid', 'owner_host']),
    );
    expect(db.prepare('SELECT * FROM dependency_chain_edit_lock').get()).toEqual({
      scope: 'issue:s1:11',
      owner_id: 'owner-1',
      operation_id: 'admin chain new-10,11',
      acquired_at: '2026-01-01T00:00:00.000Z',
      owner_pid: null,
      owner_host: null,
    });
  } finally {
    db.close();
  }
});

test('the migration is repeatable: running it again changes no column', () => {
  const store = new SqliteChainRegistryStore(dbPath);
  store.close();

  const db = new Database(dbPath);
  try {
    const before = Object.fromEntries(REGISTRY_TABLES.map((t) => [t, columnsOf(db, t)]));
    migrateChainRegistrySchema(db);
    migrateChainRegistrySchema(db);
    const after = Object.fromEntries(REGISTRY_TABLES.map((t) => [t, columnsOf(db, t)]));
    expect(after).toEqual(before);
  } finally {
    db.close();
  }
});

test('re-opening the store over its own data preserves every registry row', async () => {
  const first = new SqliteChainRegistryStore(dbPath);
  const created = await first.createChain({
    sessionId: 's1',
    headIssueNumber: 777,
    members: [{ issueNumber: 777, role: 'head' }, { issueNumber: 778 }],
    edges: [{ blockerIssueNumber: 777, blockedIssueNumber: 778 }],
    now: '2026-08-08T00:00:00.000Z',
  });
  expect(created.ok).toBe(true);
  await first.putChainAlias({ alias: 'rollout', chainId: 'chain_777', now: '2026-08-08T00:00:00.000Z' });
  first.close();

  // Second open re-runs the migration over a populated file.
  const second = new SqliteChainRegistryStore(dbPath);
  try {
    const graph = await second.getChain('chain_777');
    expect(graph.members.map((m) => m.issueNumber)).toEqual([777, 778]);
    expect(graph.edges).toHaveLength(1);
    expect(await second.resolveChainHandle('rollout')).toBe('chain_777');
    expect(await second.listChainRevisions('chain_777')).toHaveLength(1);
  } finally {
    second.close();
  }
});

test('opening the registry leaves unrelated tables and rows untouched', () => {
  const db = new Database(dbPath);
  db.exec('CREATE TABLE tasks (id INTEGER PRIMARY KEY, payload TEXT NOT NULL)');
  db.prepare('INSERT INTO tasks (id, payload) VALUES (1, ?)').run('pre-existing');
  db.close();

  const store = new SqliteChainRegistryStore(dbPath);
  store.close();

  const reopened = new Database(dbPath);
  try {
    expect(reopened.prepare('SELECT payload FROM tasks WHERE id = 1').get()).toEqual({
      payload: 'pre-existing',
    });
    expect(tableNames(reopened)).toEqual(expect.arrayContaining([...REGISTRY_TABLES, 'tasks']));
  } finally {
    reopened.close();
  }
});

test('a database from an earlier build gains its missing columns without losing rows', async () => {
  // Hand-build the pre-additive shape: the columns that were always there,
  // and none of the ones CHAIN_REGISTRY_ADDITIVE_COLUMNS adds.
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE dependency_chain (
      chain_id            TEXT PRIMARY KEY,
      session_id          TEXT NOT NULL,
      origin_issue_number INTEGER NOT NULL,
      head_issue_number   INTEGER NOT NULL,
      created_at          TEXT NOT NULL,
      updated_at          TEXT NOT NULL
    );
    CREATE TABLE dependency_chain_member (
      chain_id     TEXT NOT NULL,
      issue_number INTEGER NOT NULL,
      added_at     TEXT NOT NULL,
      PRIMARY KEY (chain_id, issue_number)
    );
    INSERT INTO dependency_chain
      (chain_id, session_id, origin_issue_number, head_issue_number, created_at, updated_at)
      VALUES ('chain_5', 's1', 5, 5, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    INSERT INTO dependency_chain_member (chain_id, issue_number, added_at)
      VALUES ('chain_5', 5, '2026-01-01T00:00:00.000Z');
  `);
  db.close();

  const store = new SqliteChainRegistryStore(dbPath);
  try {
    const record = await store.getChainRecord('chain_5');
    // The row survived, and the new columns arrived with their declared
    // defaults rather than as nulls the reader would have to guess at.
    expect(record).toEqual({
      chainId: 'chain_5',
      sessionId: 's1',
      originIssueNumber: 5,
      headIssueNumber: 5,
      graphRevision: 1,
      graphFingerprint: '',
      syncStatus: 'unknown',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      rev: 1,
    });

    const graph = await store.getChain('chain_5');
    expect(graph.members).toEqual([
      { chainId: 'chain_5', issueNumber: 5, role: 'node', addedAt: '2026-01-01T00:00:00.000Z' },
    ]);
  } finally {
    store.close();
  }
});

test('an upgraded legacy database is writable through the normal store API', async () => {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE dependency_chain (
      chain_id            TEXT PRIMARY KEY,
      session_id          TEXT NOT NULL,
      origin_issue_number INTEGER NOT NULL,
      head_issue_number   INTEGER NOT NULL,
      created_at          TEXT NOT NULL,
      updated_at          TEXT NOT NULL
    );
    INSERT INTO dependency_chain
      (chain_id, session_id, origin_issue_number, head_issue_number, created_at, updated_at)
      VALUES ('chain_5', 's1', 5, 5, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  `);
  db.close();

  const store = new SqliteChainRegistryStore(dbPath);
  try {
    const written = await store.putChainGraph({
      chainId: 'chain_5',
      members: [{ issueNumber: 5, role: 'head' }, { issueNumber: 6 }],
      edges: [{ blockerIssueNumber: 5, blockedIssueNumber: 6 }],
      now: '2026-08-08T00:00:00.000Z',
    });
    expect(written.ok).toBe(true);
    expect(written.value.chain.graphRevision).toBe(2);
    expect(written.value.edges).toHaveLength(1);

    // A collision against the legacy row still resolves deterministically.
    const created = await store.createChain({
      sessionId: 's1',
      headIssueNumber: 5,
      now: '2026-08-08T00:00:00.000Z',
    });
    expect(created.value.chain.chainId).toBe('chain_5_2');
  } finally {
    store.close();
  }
});

test('deleting a chain in an upgraded legacy database leaves no orphan child rows', async () => {
  // The legacy child tables were created without `ON DELETE CASCADE`, and
  // `CREATE TABLE IF NOT EXISTS` cannot retrofit one, so on this file the
  // cascade the fresh schema relies on simply does not exist. `deleteChain`
  // must still remove everything attached to the chain.
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE dependency_chain (
      chain_id            TEXT PRIMARY KEY,
      session_id          TEXT NOT NULL,
      origin_issue_number INTEGER NOT NULL,
      head_issue_number   INTEGER NOT NULL,
      created_at          TEXT NOT NULL,
      updated_at          TEXT NOT NULL
    );
    CREATE TABLE dependency_chain_member (
      chain_id     TEXT NOT NULL,
      issue_number INTEGER NOT NULL,
      added_at     TEXT NOT NULL,
      PRIMARY KEY (chain_id, issue_number)
    );
    CREATE TABLE dependency_chain_edge (
      chain_id             TEXT NOT NULL,
      blocker_issue_number INTEGER NOT NULL,
      blocked_issue_number INTEGER NOT NULL,
      created_at           TEXT NOT NULL,
      PRIMARY KEY (chain_id, blocker_issue_number, blocked_issue_number)
    );
    CREATE TABLE dependency_chain_revision (
      chain_id    TEXT NOT NULL,
      revision    INTEGER NOT NULL,
      fingerprint TEXT NOT NULL,
      created_at  TEXT NOT NULL,
      PRIMARY KEY (chain_id, revision)
    );
    CREATE TABLE dependency_chain_alias (
      alias      TEXT PRIMARY KEY,
      chain_id   TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    INSERT INTO dependency_chain
      (chain_id, session_id, origin_issue_number, head_issue_number, created_at, updated_at)
      VALUES ('chain_5', 's1', 5, 5, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    INSERT INTO dependency_chain_member (chain_id, issue_number, added_at)
      VALUES ('chain_5', 5, '2026-01-01T00:00:00.000Z'),
             ('chain_5', 6, '2026-01-01T00:00:00.000Z');
    INSERT INTO dependency_chain_edge
      (chain_id, blocker_issue_number, blocked_issue_number, created_at)
      VALUES ('chain_5', 5, 6, '2026-01-01T00:00:00.000Z');
    INSERT INTO dependency_chain_revision (chain_id, revision, fingerprint, created_at)
      VALUES ('chain_5', 1, 'fp1', '2026-01-01T00:00:00.000Z');
    INSERT INTO dependency_chain_alias (alias, chain_id, created_at)
      VALUES ('rollout', 'chain_5', '2026-01-01T00:00:00.000Z');
  `);
  db.close();

  const store = new SqliteChainRegistryStore(dbPath);
  try {
    const deleted = await store.deleteChain('chain_5');
    expect(deleted).toEqual({ ok: true, value: { chainId: 'chain_5', deleted: true } });
  } finally {
    store.close();
  }

  const reopened = new Database(dbPath);
  try {
    // The premise: the migration left these tables cascade-less, so nothing
    // but the explicit deletes could have cleared them.
    expect(reopened.prepare('PRAGMA foreign_key_list(dependency_chain_member)').all()).toEqual([]);

    for (const table of REGISTRY_TABLES) {
      const { n } = reopened.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE chain_id = ?`).get('chain_5');
      expect([table, n]).toEqual([table, 0]);
    }
  } finally {
    reopened.close();
  }
});
