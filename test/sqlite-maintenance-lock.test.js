import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SqliteTaskStore } from '../dist/stores/sqlite-task-store.js';
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
