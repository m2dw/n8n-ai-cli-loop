import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SqliteTaskStore } from '../dist/stores/sqlite-task-store.js';
import { SqliteOutboxStore } from '../dist/stores/sqlite-outbox-store.js';
import Database from 'better-sqlite3';
import { SqliteMaintenanceLock, seedMaintenanceLock } from '../dist/stores/sqlite-maintenance-lock.js';

let tmpDir;
let dbPath;
let store;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'sqlite-maintenance-lock-test-'));
  dbPath = join(tmpDir, 'test.db');
  store = new SqliteTaskStore(dbPath);
});

afterEach(() => {
  if (store.open) store.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('SqliteMaintenanceLock', () => {
  test('acquires when idle and refuses a second concurrent acquisition', () => {
    const lockA = new SqliteMaintenanceLock(dbPath);
    const lockB = new SqliteMaintenanceLock(dbPath);
    try {
      const a = lockA.acquire('holder-a', '2026-01-01T00:00:00.000Z');
      expect(a).toEqual({ ok: true });

      const b = lockB.acquire('holder-b', '2026-01-01T00:00:01.000Z');
      expect(b.ok).toBe(false);
      expect(b.reason).toBe('already_held');
      expect(b.holder).toBe('holder-a');
    } finally {
      lockA.close();
      lockB.close();
    }
  });

  test('refuses to acquire while a phase is actively running (non-expired claim)', async () => {
    await store.enqueueTask({ sessionId: 's1', issueNumber: 1, phase: 'implementation', now: '2026-01-01T00:00:00.000Z' });
    await store.claimNextTask({
      sessionId: 's1',
      workerId: 'w1',
      runId: 'run-1',
      now: '2026-01-01T00:00:00.000Z',
      leaseMs: 60_000,
    });

    const lock = new SqliteMaintenanceLock(dbPath);
    try {
      const result = lock.acquire('holder-a', '2026-01-01T00:00:01.000Z');
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('phase_active');
    } finally {
      lock.close();
    }
  });

  test('acquires despite a stale (lease-expired) claim — recoverable, never assumed live', async () => {
    await store.enqueueTask({ sessionId: 's1', issueNumber: 1, phase: 'implementation', now: '2026-01-01T00:00:00.000Z' });
    await store.claimNextTask({
      sessionId: 's1',
      workerId: 'w1',
      runId: 'run-1',
      now: '2026-01-01T00:00:00.000Z',
      leaseMs: 1000,
    });

    const lock = new SqliteMaintenanceLock(dbPath);
    try {
      const result = lock.acquire('holder-a', '2026-01-01T01:00:00.000Z');
      expect(result.ok).toBe(true);
    } finally {
      lock.close();
    }
  });

  test('release() frees the lock for a subsequent acquisition', () => {
    const lock = new SqliteMaintenanceLock(dbPath);
    try {
      expect(lock.acquire('holder-a').ok).toBe(true);
      lock.release();
      expect(lock.inspect().held).toBe(false);
      expect(lock.acquire('holder-b').ok).toBe(true);
    } finally {
      lock.close();
    }
  });

  test('claimNextTask refuses atomically while the maintenance lock is held (§9 phase-start race)', async () => {
    await store.enqueueTask({ sessionId: 's1', issueNumber: 1, phase: 'implementation', now: '2026-01-01T00:00:00.000Z' });

    const lock = new SqliteMaintenanceLock(dbPath);
    const acquired = lock.acquire('prune-holder', '2026-01-01T00:00:00.000Z');
    expect(acquired.ok).toBe(true);

    try {
      const claimed = await store.claimNextTask({
        sessionId: 's1',
        workerId: 'w1',
        runId: 'run-1',
        now: '2026-01-01T00:00:01.000Z',
        leaseMs: 60_000,
      });
      expect(claimed).toBeUndefined();
    } finally {
      lock.close();
    }

    // Once the lock is released (lock.close() releases it), claiming succeeds again.
    const claimedAfterRelease = await store.claimNextTask({
      sessionId: 's1',
      workerId: 'w1',
      runId: 'run-2',
      now: '2026-01-01T00:00:02.000Z',
      leaseMs: 60_000,
    });
    expect(claimedAfterRelease).toMatchObject({ issueNumber: 1, status: 'claimed' });
  });

  test('adopt() takes over a lock row seeded directly on the file, and release() only removes a lock this instance owns (issue #611 review)', () => {
    // Simulate restore: seed a lock row directly on the (not-yet-live) file
    // connection, as restoreBackup does before renaming it into place.
    const raw = new Database(dbPath);
    seedMaintenanceLock(raw, 'restore-holder', '2026-01-01T00:00:00.000Z');
    raw.close();

    const lock = new SqliteMaintenanceLock(dbPath);
    const adopted = lock.adopt('restore-holder');
    expect(adopted.ok).toBe(true);
    expect(lock.inspect()).toMatchObject({ held: true, holder: 'restore-holder' });

    lock.release();
    expect(lock.inspect().held).toBe(false);
    lock.close();
  });

  test('adopt() refuses when the row holder does not match, and release() then leaves the other holder\'s lock intact', () => {
    const raw = new Database(dbPath);
    seedMaintenanceLock(raw, 'someone-else', '2026-01-01T00:00:00.000Z');
    raw.close();

    const lock = new SqliteMaintenanceLock(dbPath);
    const adopted = lock.adopt('this-invocation');
    expect(adopted.ok).toBe(false);

    // release() must be a no-op here — this instance never actually held
    // the lock, so it must never delete `someone-else`'s row.
    lock.release();
    expect(lock.inspect()).toMatchObject({ held: true, holder: 'someone-else' });
    lock.close();
  });
});

// Issue #817 — guarded status/force-release recovery. A maintenance process
// killed before its finally/close() path runs leaves no live holder able to
// call release(); status()/forceRelease() are the store-level primitives the
// `admin maintenance-lock status|release` CLI command is built on.
describe('SqliteMaintenanceLock status/forceRelease (issue #817)', () => {
  test('status() reports unheld with zero activity counts on an idle lock', () => {
    const lock = new SqliteMaintenanceLock(dbPath);
    const status = lock.status('2026-01-01T00:00:00.000Z');
    expect(status.held).toBe(false);
    expect(status.holder).toBeUndefined();
    expect(status.phaseActiveCount).toBe(0);
    expect(status.outboxClaimActiveCount).toBe(0);
    lock.close();
  });

  test('status() reports holder/acquiredAt for a lock this process never acquired (a stranded lock)', () => {
    const raw = new Database(dbPath);
    seedMaintenanceLock(raw, 'prune:9999:stranded', '2026-01-01T00:00:00.000Z');
    raw.close();

    const lock = new SqliteMaintenanceLock(dbPath);
    const status = lock.status('2026-01-01T00:05:00.000Z');
    expect(status.held).toBe(true);
    expect(status.holder).toBe('prune:9999:stranded');
    expect(status.acquiredAt).toBe('2026-01-01T00:00:00.000Z');
    lock.close();
  });

  test('status() activity counts mirror acquire()\'s own refusal predicates', async () => {
    await store.enqueueTask({ sessionId: 's1', issueNumber: 1, phase: 'implementation', now: '2026-01-01T00:00:00.000Z' });
    await store.claimNextTask({
      sessionId: 's1',
      workerId: 'w1',
      runId: 'run-1',
      now: '2026-01-01T00:00:00.000Z',
      leaseMs: 60_000,
    });

    const lock = new SqliteMaintenanceLock(dbPath);
    expect(lock.status('2026-01-01T00:00:01.000Z').phaseActiveCount).toBe(1);
    expect(lock.acquire('holder-a', '2026-01-01T00:00:01.000Z').reason).toBe('phase_active');
    lock.close();
  });

  test('forceRelease() on an unheld lock is a safe no-op', () => {
    const lock = new SqliteMaintenanceLock(dbPath);
    const result = lock.forceRelease('2026-01-01T00:00:00.000Z');
    expect(result).toEqual({ ok: true, released: false });
    lock.close();
  });

  test('forceRelease() ignores the recorded holder — the whole reason it exists', () => {
    const raw = new Database(dbPath);
    seedMaintenanceLock(raw, 'some-other-process:1:token', '2026-01-01T00:00:00.000Z');
    raw.close();

    // This instance never acquired or adopted the lock — release() alone
    // could never touch it, which is exactly the stranded-lock scenario.
    const lock = new SqliteMaintenanceLock(dbPath);
    lock.release();
    expect(lock.inspect().held).toBe(true);

    const result = lock.forceRelease('2026-01-01T00:00:01.000Z', { confirmStranded: true });
    expect(result).toEqual({ ok: true, released: true, holder: 'some-other-process:1:token', acquiredAt: '2026-01-01T00:00:00.000Z' });
    expect(lock.inspect().held).toBe(false);
    lock.close();
  });

  test('forceRelease() refuses a normal holder without --confirm-stranded even with zero live phases/claims (issue #817 review, P1)', () => {
    // A live `prune run --yes` acquires an ordinary, non-activityExempt lock
    // and does its own destructive work without ever creating a task lease
    // or outbox claim — so zero of both counts is not evidence it has
    // finished, exactly like an activityExempt holder.
    const raw = new Database(dbPath);
    seedMaintenanceLock(raw, 'prune:1:token', '2026-01-01T00:00:00.000Z');
    raw.close();

    const lock = new SqliteMaintenanceLock(dbPath);
    const result = lock.forceRelease('2026-01-01T00:00:01.000Z');
    expect(result).toEqual({
      ok: false,
      reason: 'confirmation_required',
      holder: 'prune:1:token',
      acquiredAt: '2026-01-01T00:00:00.000Z',
      activityExempt: false,
    });
    expect(lock.inspect()).toMatchObject({ held: true, holder: 'prune:1:token' });
    lock.close();
  });

  test('forceRelease() releases a normal holder once --confirm-stranded is given', () => {
    const raw = new Database(dbPath);
    seedMaintenanceLock(raw, 'prune:1:token', '2026-01-01T00:00:00.000Z');
    raw.close();

    const lock = new SqliteMaintenanceLock(dbPath);
    const result = lock.forceRelease('2026-01-01T00:00:01.000Z', { confirmStranded: true });
    expect(result).toEqual({
      ok: true,
      released: true,
      holder: 'prune:1:token',
      acquiredAt: '2026-01-01T00:00:00.000Z',
    });
    expect(lock.inspect().held).toBe(false);
    lock.close();
  });

  test('forceRelease() refuses while a phase is actively running, and leaves the lock intact', async () => {
    // Claim the task before the lock exists at all: claimNextTask's own
    // IMMEDIATE-transaction check refuses to claim while a maintenance_lock
    // row is present (issue #611), so seeding the stranded lock first would
    // make the "phase active" state below unreachable. Seeding it *after*
    // the claim matches the real recoverable scenario this guard exists for
    // — a lock written directly into the file (e.g. by restore) while a
    // phase claimed earlier is still running.
    await store.enqueueTask({ sessionId: 's1', issueNumber: 1, phase: 'implementation', now: '2026-01-01T00:00:00.000Z' });
    await store.claimNextTask({
      sessionId: 's1',
      workerId: 'w1',
      runId: 'run-1',
      now: '2026-01-01T00:00:00.000Z',
      leaseMs: 60_000,
    });

    const raw = new Database(dbPath);
    seedMaintenanceLock(raw, 'stranded-holder', '2026-01-01T00:00:00.000Z');
    raw.close();

    const lock = new SqliteMaintenanceLock(dbPath);
    const result = lock.forceRelease('2026-01-01T00:00:01.000Z');
    expect(result).toEqual({ ok: false, reason: 'phase_active', activeCount: 1 });
    expect(lock.inspect()).toMatchObject({ held: true, holder: 'stranded-holder' });
    lock.close();
  });

  test('forceRelease() refuses while a non-stale outbox dispatch claim exists, and leaves the lock intact', () => {
    // Run the outbox claimed_at migration up front: `store` above (a plain
    // SqliteTaskStore) creates `outbox` without a claimed_at column, and
    // SqliteMaintenanceLock deliberately never migrates (issue #817 review —
    // it must stay read-only), so raw-seeding below needs
    // SqliteOutboxStore's own migration to have already run.
    new SqliteOutboxStore(dbPath).close();

    const raw = new Database(dbPath);
    seedMaintenanceLock(raw, 'stranded-holder', '2026-01-01T00:00:00.000Z');
    raw
      .prepare(`INSERT INTO outbox (idempotency_key, topic, payload, created_at, claimed_at) VALUES (?, 'gh:comment', '{}', ?, ?)`)
      .run('claim-1', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    raw.close();

    const lock = new SqliteMaintenanceLock(dbPath);
    const result = lock.forceRelease('2026-01-01T00:00:01.000Z');
    expect(result).toEqual({ ok: false, reason: 'outbox_claim_active', activeCount: 1 });
    expect(lock.inspect()).toMatchObject({ held: true, holder: 'stranded-holder' });
    lock.close();
  });

  test('release() by the true owner is unaffected by forceRelease existing (regression)', () => {
    const lock = new SqliteMaintenanceLock(dbPath);
    expect(lock.acquire('holder-a', '2026-01-01T00:00:00.000Z').ok).toBe(true);
    lock.release();
    expect(lock.inspect().held).toBe(false);
    lock.close();
  });
});

// Issue #817 review — the force-release guard must not clear a live
// archive-rollup lock. `admin archive rollup` acquires with
// `skipActivityChecks: true` and is expected to show zero live task phases
// and zero non-stale outbox claims even while genuinely still running, so
// those two checks passing is not evidence a rollup-held lock is stranded.
describe('SqliteMaintenanceLock activity-exempt force-release guard (issue #817 review)', () => {
  test('acquire() with skipActivityChecks persists activityExempt, visible via status()', () => {
    const lock = new SqliteMaintenanceLock(dbPath);
    expect(lock.acquire('archive-rollup:1:token', '2026-01-01T00:00:00.000Z', { skipActivityChecks: true }).ok).toBe(
      true,
    );
    const status = lock.status('2026-01-01T00:00:01.000Z');
    expect(status.held).toBe(true);
    expect(status.activityExempt).toBe(true);
    lock.close();
  });

  test('acquire() without skipActivityChecks records activityExempt: false', () => {
    const lock = new SqliteMaintenanceLock(dbPath);
    expect(lock.acquire('prune:1:token', '2026-01-01T00:00:00.000Z').ok).toBe(true);
    expect(lock.status('2026-01-01T00:00:01.000Z').activityExempt).toBe(false);
    lock.close();
  });

  test('forceRelease() refuses an activity-exempt holder despite zero live phases/claims, and leaves the lock intact', () => {
    const raw = new Database(dbPath);
    seedMaintenanceLock(raw, 'archive-rollup:1:token', '2026-01-01T00:00:00.000Z');
    raw.close();
    // Simulate a live, still-running rollup: flag the row activity-exempt
    // directly, mirroring what acquire({ skipActivityChecks: true }) writes.
    const flag = new Database(dbPath);
    flag.prepare('UPDATE maintenance_lock SET activity_exempt = 1 WHERE id = 1').run();
    flag.close();

    const lock = new SqliteMaintenanceLock(dbPath);
    const result = lock.forceRelease('2026-01-01T00:00:01.000Z');
    expect(result).toEqual({
      ok: false,
      reason: 'confirmation_required',
      holder: 'archive-rollup:1:token',
      acquiredAt: '2026-01-01T00:00:00.000Z',
      activityExempt: true,
    });
    expect(lock.inspect()).toMatchObject({ held: true, holder: 'archive-rollup:1:token' });
    lock.close();
  });

  test('forceRelease() releases an activity-exempt holder when the caller explicitly confirms', () => {
    const raw = new Database(dbPath);
    seedMaintenanceLock(raw, 'archive-rollup:1:token', '2026-01-01T00:00:00.000Z');
    raw.close();
    const flag = new Database(dbPath);
    flag.prepare('UPDATE maintenance_lock SET activity_exempt = 1 WHERE id = 1').run();
    flag.close();

    const lock = new SqliteMaintenanceLock(dbPath);
    const result = lock.forceRelease('2026-01-01T00:00:01.000Z', { confirmStranded: true });
    expect(result).toEqual({
      ok: true,
      released: true,
      holder: 'archive-rollup:1:token',
      acquiredAt: '2026-01-01T00:00:00.000Z',
    });
    expect(lock.inspect().held).toBe(false);
    lock.close();
  });
});

// Issue #817 review — `status`/release-preview must stay strictly read-only:
// no schema creation, no migration, against a legacy database that predates
// `maintenance_lock` entirely (or a filesystem-read-only backup).
describe('SqliteMaintenanceLock readonly mode (issue #817 review)', () => {
  test('a readonly instance never creates maintenance_lock on a database that lacks it', () => {
    // `store` (SqliteTaskStore) already created `maintenance_lock` as part of
    // its own schema; drop it to simulate a genuinely pre-#611 database.
    const raw = new Database(dbPath);
    raw.exec('DROP TABLE maintenance_lock');
    raw.close();

    const lock = new SqliteMaintenanceLock(dbPath, { readonly: true });
    expect(lock.status('2026-01-01T00:00:00.000Z').held).toBe(false);
    expect(lock.inspect()).toEqual({ held: false });
    lock.close();

    const check = new Database(dbPath, { readonly: true });
    const tables = check
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'maintenance_lock'")
      .all();
    expect(tables).toEqual([]);
    check.close();
  });
});
