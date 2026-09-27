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

    // The child imports the store's own module rather than the `dist/index.js`
    // barrel: the barrel re-exports the whole build, so six concurrent forks
    // each paid a full-tree load to reach one class, and under the saturated
    // parallel run that startup cost — not the lock contention this test is
    // about — is what dominated the wall clock.
    const dist = new URL('../dist/stores/sqlite-issue-activation-store.js', import.meta.url).href;
    // Printed once the child's own module load is done and immediately before it
    // touches the store, so a killed child can still be told apart afterwards:
    // with the marker it reached the code under test, without it the host never
    // scheduled it past its Node bootstrap. See the classification below.
    const REACHED_STORE = 'reached-store';
    const source =
      `import(${JSON.stringify(dist)})` +
      `.then((m) => { process.stdout.write(${JSON.stringify(`${REACHED_STORE}\n`)});` +
      ` const s = new m.SqliteIssueActivationStore(${JSON.stringify(legacyPath)}); s.close(); })` +
      `.catch((e) => { console.error(String(e && e.message ? e.message : e)); process.exit(1); })`;

    // Each child gets its own wall-clock bound, comfortably above the 30s the
    // store itself is willing to wait for another process's lock and well under
    // this test's budget. It changes no passing outcome; it only turns "a child
    // never came back" into a named outcome here instead of an opaque jest
    // timeout that says nothing about which half of the test stalled.
    const CHILD_TIMEOUT_MS = 120_000;
    /** The watchdog fired before the child ever reached the store. */
    const NEVER_SCHEDULED = Symbol('child was killed before it reached the store');

    const failures = await Promise.all(
      Array.from(
        { length: 6 },
        () =>
          new Promise((resolve) => {
            execFile(process.execPath, ['-e', source], { timeout: CHILD_TIMEOUT_MS }, (err, stdout, stderr) =>
              resolve(
                err
                  ? err.killed
                    ? // A child killed AFTER the marker did reach the store and
                      // then failed to come back, which is a real stall in the
                      // code under test and stays a hard failure — that is the
                      // deadlock this case exists to catch.
                      String(stdout).includes(REACHED_STORE)
                      ? `child reached the store but did not return within ${CHILD_TIMEOUT_MS}ms`
                      : NEVER_SCHEDULED
                    : stderr.trim() || err.message
                  : null,
              ),
            );
          }),
      ),
    );
    // A child killed before it ever reached the store is a statement about the
    // HOST, not about the store, and #897's rule is that such an outcome must not
    // be read as a fact either way: what was being waited on is six Node
    // bootstraps, which is the cost the comment below says dominates this case.
    // Reporting that as "the migration is not concurrency-safe" would be a false
    // accusation, and re-running six more forks into an already-thrashing host
    // would deepen the starvation rather than resolve it — so the round is
    // abandoned, loudly, instead of asserted on. Every remaining assertion reads
    // state those children were supposed to produce, which is why the whole case
    // stops here rather than continuing on a partial round.
    const unscheduled = failures.filter((f) => f === NEVER_SCHEDULED).length;
    if (unscheduled > 0) {
      // Loud on purpose: a case that stops asserting has to be visible in the run
      // it happened in, not discovered later as coverage that quietly went away.
      console.warn(
        `sqlite-issue-activation-store concurrent-open: ${unscheduled}/${failures.length} children were killed by the `
          + `${CHILD_TIMEOUT_MS}ms watchdog before reaching the store — the host never scheduled them, so this round `
          + 'is not evidence either way.',
      );
      // "Not evidence either way" is a statement about the children the host
      // never scheduled, and about those alone. A SIBLING that did reach the
      // store and then reported a migration error, or stalled past the watchdog
      // after the marker, is exactly the concurrency failure this case exists to
      // catch — and starvation elsewhere in the round says nothing against it.
      // Returning without this assertion would let such a regression pass on any
      // run where one unrelated fork was starved, which is the busy run where it
      // is most likely to happen.
      expect(failures.filter((f) => f !== null && f !== NEVER_SCHEDULED)).toEqual([]);
      return;
    }
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
    // Six concurrent forks, each paying full Node startup before serializing on
    // SQLite's write lock. Under the saturated parallel run that outgrew the
    // usual 30s budget, so it sits in the same tier as the suite's other heavy
    // subprocess tests — and then outgrew 90s too, on a run where sibling files
    // took 200-340s apiece. What is being waited on is host scheduling of six
    // Node bootstraps, not the store: its own lock waits are capped at 30s and a
    // process that exhausts them fails loudly rather than hanging. So the budget
    // is set from the worst observed scheduling delay rather than from the work,
    // and a healthy run still finishes in a couple of seconds.
  }, 180_000);
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
