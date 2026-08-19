/**
 * SqliteIssueActivationStore (issue #787): restorable-suspension state for
 * `admin issue activate|suspend`, keyed by (session, issue).
 */
import Database from 'better-sqlite3';
import { execFile } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SqliteIssueActivationStore } from '../dist/index.js';

const NOW = '2026-07-28T10:00:00.000Z';
const LATER = '2026-07-28T11:00:00.000Z';

let tmpDir;
let dbPath;
let store;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'issue-activation-store-'));
  dbPath = join(tmpDir, 'dev_loop.db');
  store = new SqliteIssueActivationStore(dbPath);
});

afterEach(() => {
  store.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function record(overrides = {}) {
  return {
    sessionId: 's1',
    issueNumber: 101,
    labels: ['status:needs-implementation', 'agent:claude'],
    operationId: 'op-1',
    suspendedAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

test('getSuspension returns undefined when no record exists', async () => {
  expect(await store.getSuspension('s1', 101)).toBeUndefined();
});

test('putSuspension then getSuspension round-trips the record', async () => {
  await store.putSuspension(record());
  // rev 1: the store's own monotonic revision counter (issue #787 review),
  // bumped starting from the first write regardless of caller-supplied data.
  expect(await store.getSuspension('s1', 101)).toEqual({ ...record(), rev: 1 });
});

test('records are keyed by (sessionId, issueNumber): distinct issues and sessions do not collide', async () => {
  await store.putSuspension(record());
  await store.putSuspension(record({ issueNumber: 102, labels: ['status:needs-review'] }));
  await store.putSuspension(record({ sessionId: 's2', labels: ['agent:codex'] }));

  expect((await store.getSuspension('s1', 101)).labels).toEqual(['status:needs-implementation', 'agent:claude']);
  expect((await store.getSuspension('s1', 102)).labels).toEqual(['status:needs-review']);
  expect((await store.getSuspension('s2', 101)).labels).toEqual(['agent:codex']);
});

test('a repeated putSuspension updates labels/operationId/updatedAt but preserves the original suspendedAt', async () => {
  await store.putSuspension(record());
  await store.putSuspension(
    record({ labels: ['agent:claude'], operationId: 'op-2', suspendedAt: LATER, updatedAt: LATER }),
  );

  const updated = await store.getSuspension('s1', 101);
  expect(updated.labels).toEqual(['agent:claude']);
  expect(updated.operationId).toBe('op-2');
  expect(updated.updatedAt).toBe(LATER);
  // suspendedAt is the ORIGINAL suspension time, not the latest write's value —
  // restoration bookkeeping must not silently move the clock backward/forward.
  expect(updated.suspendedAt).toBe(NOW);
  // rev advanced on the second write (issue #787 review) — it is what CAS
  // callers key on, independent of the wall-clock updatedAt value.
  expect(updated.rev).toBe(2);
});

test('clearSuspension removes the record; a second clear is a safe no-op', async () => {
  await store.putSuspension(record());
  await store.clearSuspension('s1', 101);
  expect(await store.getSuspension('s1', 101)).toBeUndefined();
  await expect(store.clearSuspension('s1', 101)).resolves.toBeUndefined();
});

test('state survives reopening the same database file', async () => {
  await store.putSuspension(record());
  store.close();

  // Reassign so afterEach closes the reopened (still-open) handle rather than
  // double-closing the one already closed above.
  store = new SqliteIssueActivationStore(dbPath);
  expect(await store.getSuspension('s1', 101)).toEqual({ ...record(), rev: 1 });
});

describe('per-label attribution (issue #791 review)', () => {
  test('labelOperations round-trips through every write path', async () => {
    const labelOperations = { 'status:needs-implementation': 'op-1', 'agent:claude': 'op-2' };
    await store.putSuspension(record({ labelOperations }));
    expect((await store.getSuspension('s1', 101)).labelOperations).toEqual(labelOperations);

    expect(
      await store.putSuspensionIfUnchanged(
        record({ labels: ['agent:claude'], labelOperations: { 'agent:claude': 'op-2' }, updatedAt: LATER }),
        1,
      ),
    ).toBe(true);
    expect((await store.getSuspension('s1', 101)).labelOperations).toEqual({ 'agent:claude': 'op-2' });

    await store.clearSuspension('s1', 101);
    expect(await store.putSuspensionIfUnchanged(record({ labelOperations }), undefined)).toBe(true);
    expect((await store.getSuspension('s1', 101)).labelOperations).toEqual(labelOperations);
  });

  test('a record with no attribution reads back without the field rather than with an empty map', async () => {
    await store.putSuspension(record());
    expect(await store.getSuspension('s1', 101)).toEqual({ ...record(), rev: 1 });
    expect((await store.getSuspension('s1', 101)).labelOperations).toBeUndefined();
  });

  test('a database created before the column existed is migrated, and its rows still read', async () => {
    const legacyPath = join(tmpDir, 'legacy.db');
    const legacy = new Database(legacyPath);
    legacy.exec(`
      CREATE TABLE issue_automation_suspension (
        session_id    TEXT NOT NULL,
        issue_number  INTEGER NOT NULL,
        labels        TEXT NOT NULL,
        operation_id  TEXT NOT NULL,
        suspended_at  TEXT NOT NULL,
        updated_at    TEXT NOT NULL,
        rev           INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (session_id, issue_number)
      );
    `);
    legacy
      .prepare(
        `INSERT INTO issue_automation_suspension
           (session_id, issue_number, labels, operation_id, suspended_at, updated_at, rev)
         VALUES ('s1', 101, '["status:needs-implementation"]', 'op-legacy', ?, ?, 1)`,
      )
      .run(NOW, NOW);
    legacy.close();

    const migrated = new SqliteIssueActivationStore(legacyPath);
    try {
      const existing = await migrated.getSuspension('s1', 101);
      expect(existing.labels).toEqual(['status:needs-implementation']);
      // No attribution to read: `suspensionLabelOwner` falls back to the
      // record-level operation, exactly as before the column existed.
      expect(existing.labelOperations).toBeUndefined();
      expect(existing.operationId).toBe('op-legacy');

      // And the column is there for the next write.
      await migrated.putSuspension(
        record({ issueNumber: 102, labelOperations: { 'agent:claude': 'op-2' } }),
      );
      expect((await migrated.getSuspension('s1', 102)).labelOperations).toEqual({ 'agent:claude': 'op-2' });
    } finally {
      migrated.close();
    }
  });

  test('processes opening the same legacy database at once all succeed', async () => {
    // The probe and the ALTER it guards run in one BEGIN IMMEDIATE transaction,
    // so concurrent first-time upgrades serialize on SQLite's write lock. Probing
    // outside it let every process read the column as missing and all but one
    // fail with `duplicate column name` — plausible the first time a chain/issue
    // command runs against an existing database, since each one constructs this
    // store (issue #791 review).
    //
    // The other half of the same race is the WAL switch that precedes the
    // migration: converting a rollback-journal file upgrades a read transaction
    // to a write one, and SQLite skips the busy handler on that upgrade, so a
    // loser came straight back with `database is locked` however large
    // `busy_timeout` was. The store retries the pragma instead of relying on the
    // timeout, so this test covers both failure modes at once.
    const legacyPath = join(tmpDir, 'legacy-concurrent.db');
    const legacy = new Database(legacyPath);
    legacy.exec(`
      CREATE TABLE issue_automation_suspension (
        session_id    TEXT NOT NULL,
        issue_number  INTEGER NOT NULL,
        labels        TEXT NOT NULL,
        operation_id  TEXT NOT NULL,
        suspended_at  TEXT NOT NULL,
        updated_at    TEXT NOT NULL,
        rev           INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (session_id, issue_number)
      );
    `);
    legacy.close();

    const dist = new URL('../dist/index.js', import.meta.url).href;
    const source =
      `import(${JSON.stringify(dist)})` +
      `.then((m) => { const s = new m.SqliteIssueActivationStore(${JSON.stringify(legacyPath)}); s.close(); })` +
      `.catch((e) => { console.error(String(e && e.message ? e.message : e)); process.exit(1); })`;

    const failures = await Promise.all(
      Array.from(
        { length: 6 },
        () =>
          new Promise((resolve) => {
            execFile(process.execPath, ['-e', source], (err, _stdout, stderr) =>
              resolve(err ? stderr.trim() || err.message : null),
            );
          }),
      ),
    );
    expect(failures.filter((f) => f !== null)).toEqual([]);

    const check = new Database(legacyPath);
    try {
      const columns = check
        .prepare('PRAGMA table_info(issue_automation_suspension)')
        .all()
        .map((c) => c.name);
      expect(columns).toContain('label_operations');
    } finally {
      check.close();
    }
    // Six concurrent forks, each paying full Node startup plus an import of the
    // built `dist/index.js`, then serializing on SQLite's write lock. Under the
    // saturated parallel run this outgrew the usual 30s budget, so it sits in
    // the same tier as the suite's other heavy subprocess tests.
  }, 90_000);
});

describe('putSuspensionIfUnchanged / clearSuspensionIfUnchanged (CAS, issue #787 review)', () => {
  test('putSuspensionIfUnchanged(record, undefined) creates only if no row exists yet', async () => {
    expect(await store.putSuspensionIfUnchanged(record(), undefined)).toBe(true);
    expect(await store.getSuspension('s1', 101)).toEqual({ ...record(), rev: 1 });

    // A second CAS-create against the same key loses: a row already exists.
    expect(await store.putSuspensionIfUnchanged(record({ labels: ['agent:codex'] }), undefined)).toBe(false);
    expect((await store.getSuspension('s1', 101)).labels).toEqual(['status:needs-implementation', 'agent:claude']);
  });

  test('putSuspensionIfUnchanged commits only when expectedRev matches the stored rev', async () => {
    await store.putSuspension(record()); // rev 1

    expect(await store.putSuspensionIfUnchanged(record({ labels: ['agent:claude'], updatedAt: LATER }), 99)).toBe(
      false,
    );
    expect((await store.getSuspension('s1', 101)).labels).toEqual(['status:needs-implementation', 'agent:claude']);

    expect(
      await store.putSuspensionIfUnchanged(record({ labels: ['agent:claude'], updatedAt: LATER }), 1),
    ).toBe(true);
    const updated = await store.getSuspension('s1', 101);
    expect(updated.labels).toEqual(['agent:claude']);
    expect(updated.rev).toBe(2);
  });

  test('rejects a stale write even when its updatedAt collides with the current row (issue #787 review)', async () => {
    // Two concurrent writers can independently compute the same
    // ISO-millisecond `now`. A timestamp-only CAS predicate would let the
    // stale writer's `expectedUpdatedAt` match a row a concurrent writer
    // already advanced to, silently clobbering it — rev-based CAS must keep
    // rejecting the stale write regardless of the timestamp collision.
    await store.putSuspensionIfUnchanged(record(), undefined); // rev 1

    // A concurrent writer, reading rev 1, commits first using the SAME
    // updatedAt the stale writer below will also use.
    expect(await store.putSuspensionIfUnchanged(record({ labels: ['agent:claude'], updatedAt: NOW }), 1)).toBe(true); // rev 2

    // The stale writer also read rev 1 and independently computed
    // updatedAt = NOW; its CAS must fail even though NOW matches the row's
    // current updatedAt.
    expect(await store.putSuspensionIfUnchanged(record({ labels: ['status:needs-fix'], updatedAt: NOW }), 1)).toBe(
      false,
    );
    expect((await store.getSuspension('s1', 101)).labels).toEqual(['agent:claude']);
  });

  test('clearSuspensionIfUnchanged deletes only when expectedRev matches, and is false (not a throw) otherwise', async () => {
    await store.putSuspension(record()); // rev 1

    expect(await store.clearSuspensionIfUnchanged('s1', 101, 99)).toBe(false);
    expect(await store.getSuspension('s1', 101)).toEqual({ ...record(), rev: 1 });

    expect(await store.clearSuspensionIfUnchanged('s1', 101, 1)).toBe(true);
    expect(await store.getSuspension('s1', 101)).toBeUndefined();
  });
});
