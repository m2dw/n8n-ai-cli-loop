/**
 * Tests for the outbox table migration.
 * Verifies that a legacy DB (outbox without idempotency_key) is transparently
 * upgraded when SqliteTaskStore or SqliteOutboxStore opens it.
 */
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SqliteOutboxStore } from '../dist/stores/sqlite-outbox-store.js';
import { SqliteTaskStore } from '../dist/stores/sqlite-task-store.js';

let tmpDir;
let dbPath;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'outbox-migration-test-'));
  dbPath = join(tmpDir, 'test.db');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function createLegacyOutbox(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS outbox (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      topic       TEXT NOT NULL,
      payload     TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      sent_at     TEXT
    );
  `);
}

function insertLegacyRow(db, topic, payload) {
  db.prepare(
    `INSERT INTO outbox (topic, payload, created_at) VALUES (?, ?, ?)`,
  ).run(topic, JSON.stringify(payload), '2026-01-01T00:00:00.000Z');
}

describe('outbox migration via SqliteOutboxStore', () => {
  test('opens legacy DB and upgrades outbox table transparently', () => {
    // Create legacy DB with old outbox schema
    const raw = new Database(dbPath);
    createLegacyOutbox(raw);
    insertLegacyRow(raw, 'gh:comment', { topic: 'gh:comment', owner: 'o', repo: 'r', issueNumber: 1, body: 'old' });
    raw.close();

    // Opening SqliteOutboxStore should migrate without error
    const store = new SqliteOutboxStore(dbPath);
    expect(store).toBeDefined();
    store.close();
  });

  test('legacy rows survive migration with generated idempotency keys', () => {
    const raw = new Database(dbPath);
    createLegacyOutbox(raw);
    insertLegacyRow(raw, 'gh:comment', { topic: 'gh:comment', owner: 'o', repo: 'r', issueNumber: 1, body: 'old' });
    raw.close();

    const store = new SqliteOutboxStore(dbPath);
    // The old row should still be visible as a pending entry (sent_at IS NULL)
    // and should have a generated idempotency_key like "legacy-1"
    const verify = new Database(dbPath);
    const rows = verify.prepare('SELECT idempotency_key FROM outbox').all();
    verify.close();
    store.close();

    expect(rows).toHaveLength(1);
    expect(rows[0].idempotency_key).toMatch(/^legacy-/);
  });

  test('after migration, new enqueue works with idempotency', async () => {
    const raw = new Database(dbPath);
    createLegacyOutbox(raw);
    raw.close();

    const store = new SqliteOutboxStore(dbPath);
    const payload = { topic: 'gh:comment', owner: 'o', repo: 'r', issueNumber: 2, body: 'new' };
    const r1 = await store.enqueue({ idempotencyKey: 'new-key', topic: 'gh:comment', payload });
    const r2 = await store.enqueue({ idempotencyKey: 'new-key', topic: 'gh:comment', payload });
    expect(r1.enqueued).toBe(true);
    expect(r2.enqueued).toBe(false);
    store.close();
  });

  test('migration is idempotent: opening already-migrated DB is no-op', async () => {
    // First open migrates
    const s1 = new SqliteOutboxStore(dbPath);
    const payload = { topic: 'gh:comment', owner: 'o', repo: 'r', issueNumber: 3, body: 'b' };
    await s1.enqueue({ idempotencyKey: 'idem-1', topic: 'gh:comment', payload });
    s1.close();

    // Second open should not corrupt data
    const s2 = new SqliteOutboxStore(dbPath);
    const pending = await s2.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0].idempotencyKey).toBe('idem-1');
    s2.close();
  });
});

describe('outbox migration via SqliteTaskStore', () => {
  test('SqliteTaskStore migrates legacy outbox when it opens the same DB', async () => {
    // Create legacy outbox first
    const raw = new Database(dbPath);
    createLegacyOutbox(raw);
    insertLegacyRow(raw, 'gh:comment', { topic: 'gh:comment', owner: 'o', repo: 'r', issueNumber: 1, body: 'old' });
    raw.close();

    // SqliteTaskStore opens the same file — should migrate
    const taskStore = new SqliteTaskStore(dbPath);
    taskStore.close();

    // Now outbox store can use it
    const outboxStore = new SqliteOutboxStore(dbPath);
    const payload = { topic: 'gh:comment', owner: 'o', repo: 'r', issueNumber: 10, body: 'new' };
    const result = await outboxStore.enqueue({ idempotencyKey: 'after-task-store', topic: 'gh:comment', payload });
    expect(result.enqueued).toBe(true);
    outboxStore.close();
  });
});

describe('outbox retry-column migration (issue #606)', () => {
  function createPreRetryOutbox(db) {
    // The idempotency_key-era schema (#506), before attempt_count/last_error/
    // next_attempt_at/dead_letter_at existed.
    db.exec(`
      CREATE TABLE IF NOT EXISTS outbox (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        idempotency_key   TEXT NOT NULL UNIQUE,
        topic             TEXT NOT NULL,
        payload           TEXT NOT NULL,
        created_at        TEXT NOT NULL,
        sent_at           TEXT
      );
    `);
  }

  test('adds retry columns to a pre-#606 DB (idempotency_key present, retry columns absent)', async () => {
    const raw = new Database(dbPath);
    createPreRetryOutbox(raw);
    raw.prepare(
      `INSERT INTO outbox (idempotency_key, topic, payload, created_at) VALUES (?, ?, ?, ?)`,
    ).run('pre-retry-1', 'gh:comment', JSON.stringify({ topic: 'gh:comment', owner: 'o', repo: 'r', issueNumber: 1, body: 'old' }), '2026-01-01T00:00:00.000Z');
    raw.close();

    const store = new SqliteOutboxStore(dbPath);
    const [entry] = await store.listPending();
    expect(entry.idempotencyKey).toBe('pre-retry-1');
    expect(entry.attemptCount).toBe(0);
    expect(entry.lastError).toBeUndefined();
    expect(entry.nextAttemptAt).toBeUndefined();
    expect(entry.deadLetterAt).toBeUndefined();

    // markFailed works against the migrated row
    const result = await store.markFailed(entry.id, 'boom', '2026-01-01T00:00:00.000Z');
    expect(result).toEqual({ deadLettered: false });
    store.close();
  });

  test('adds retry columns even on a fully-legacy DB (neither idempotency_key nor retry columns)', async () => {
    const raw = new Database(dbPath);
    createLegacyOutbox(raw);
    insertLegacyRow(raw, 'gh:comment', { topic: 'gh:comment', owner: 'o', repo: 'r', issueNumber: 1, body: 'old' });
    raw.close();

    const store = new SqliteOutboxStore(dbPath);
    const [entry] = await store.listPending();
    expect(entry.idempotencyKey).toMatch(/^legacy-/);
    expect(entry.attemptCount).toBe(0);
    store.close();
  });

  test('migration is idempotent: opening an already-migrated retry-column DB is a no-op', async () => {
    const s1 = new SqliteOutboxStore(dbPath);
    const payload = { topic: 'gh:comment', owner: 'o', repo: 'r', issueNumber: 2, body: 'b' };
    await s1.enqueue({ idempotencyKey: 'idem-retry-1', topic: 'gh:comment', payload });
    const [entry] = await s1.listPending();
    await s1.markFailed(entry.id, 'transient', '2026-01-01T00:00:00.000Z');
    s1.close();

    const s2 = new SqliteOutboxStore(dbPath);
    const [reopened] = await s2.listPending();
    expect(reopened.attemptCount).toBe(1);
    expect(reopened.lastError).toBe('transient');
    s2.close();
  });
});

describe('outbox claim-column migration (issue #607 review follow-up)', () => {
  function createPreClaimOutbox(db) {
    // The #607-era schema (cancelled_at present, before claimed_at existed).
    db.exec(`
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
        cancelled_at      TEXT
      );
    `);
  }

  test('adds the claimed_at column to a pre-claim-column DB', async () => {
    const raw = new Database(dbPath);
    createPreClaimOutbox(raw);
    raw.prepare(
      `INSERT INTO outbox (idempotency_key, topic, payload, created_at) VALUES (?, ?, ?, ?)`,
    ).run('pre-claim-1', 'gh:comment', JSON.stringify({ topic: 'gh:comment', owner: 'o', repo: 'r', issueNumber: 1, body: 'old' }), '2026-01-01T00:00:00.000Z');
    raw.close();

    const store = new SqliteOutboxStore(dbPath);
    const [entry] = await store.listPending();
    expect(entry.claimedAt).toBeUndefined();
    expect(await store.claimForDispatch(entry.id, '2026-01-01T00:00:00.000Z')).toBe(true);
    store.close();
  });

  test('migration is idempotent: opening an already-migrated claim-column DB is a no-op', async () => {
    const s1 = new SqliteOutboxStore(dbPath);
    const payload = { topic: 'gh:comment', owner: 'o', repo: 'r', issueNumber: 4, body: 'b' };
    await s1.enqueue({ idempotencyKey: 'idem-claim-1', topic: 'gh:comment', payload });
    const [entry] = await s1.listPending();
    await s1.claimForDispatch(entry.id, '2026-01-01T00:00:00.000Z');
    s1.close();

    const s2 = new SqliteOutboxStore(dbPath);
    const [reopened] = await s2.listPending();
    expect(reopened.claimedAt).toBe('2026-01-01T00:00:00.000Z');
    s2.close();
  });
});
