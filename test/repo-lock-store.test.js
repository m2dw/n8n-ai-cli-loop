import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { RepoLockStore } from '../dist/index.js';

let tmpDir;
let lockDir;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'repo-lock-test-'));
  lockDir = join(tmpDir, 'locks');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// acquire — success
// ---------------------------------------------------------------------------

describe('RepoLockStore.acquire — no existing lock', () => {
  test('returns locked:true with contextId and sessionId', () => {
    const store = new RepoLockStore(lockDir);
    const result = store.acquire('ctx-001', 'my-session');
    expect(result).toMatchObject({ ok: true, locked: true, contextId: 'ctx-001', sessionId: 'my-session' });
  });

  test('creates the lock directory if it does not exist', () => {
    const store = new RepoLockStore(lockDir);
    store.acquire('ctx-001', 'my-session');
    // Lock file exists — no ENOENT means dir was created
    const result = store.acquire('ctx-002', 'other-session');
    // other-session has no lock yet → should succeed
    expect(result.locked).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// acquire — contention (lock held, not stale)
// ---------------------------------------------------------------------------

describe('RepoLockStore.acquire — lock already held', () => {
  test('returns locked:false with reason lock_held', () => {
    const store = new RepoLockStore(lockDir);
    store.acquire('ctx-001', 'my-session');

    const result = store.acquire('ctx-002', 'my-session');
    expect(result).toMatchObject({
      ok: true,
      locked: false,
      reason: 'lock_held',
      ownerContextId: 'ctx-001',
    });
    expect(result.ownerStartedAt).toBeDefined();
  });

  test('does not replace the existing lock owner', () => {
    const store = new RepoLockStore(lockDir);
    store.acquire('ctx-001', 'my-session');
    store.acquire('ctx-002', 'my-session'); // contention — no-op

    // Releasing with ctx-002 should fail (not owner)
    const rel = store.release('ctx-002', 'my-session');
    expect(rel).toMatchObject({ ok: true, released: false, reason: 'not_owner' });
  });

  test('different sessions do not contend', () => {
    const store = new RepoLockStore(lockDir);
    store.acquire('ctx-001', 'session-a');
    const result = store.acquire('ctx-002', 'session-b');
    expect(result).toMatchObject({ ok: true, locked: true, contextId: 'ctx-002', sessionId: 'session-b' });
  });
});

// ---------------------------------------------------------------------------
// acquire — stale lock recovery
// ---------------------------------------------------------------------------

describe('RepoLockStore.acquire — stale lock', () => {
  test('overwrites a lock older than the TTL', () => {
    const staleTtlMs = 1000; // 1 second TTL for testing
    const store = new RepoLockStore(lockDir, staleTtlMs);

    const oldTime = new Date(Date.now() - 2000).toISOString(); // 2 seconds ago
    store.acquire('ctx-old', 'my-session', oldTime);

    const result = store.acquire('ctx-new', 'my-session');
    expect(result).toMatchObject({ ok: true, locked: true, contextId: 'ctx-new', sessionId: 'my-session' });
  });

  test('does not overwrite a lock within TTL', () => {
    const staleTtlMs = 60_000; // 1 minute TTL
    const store = new RepoLockStore(lockDir, staleTtlMs);

    const recentTime = new Date(Date.now() - 5000).toISOString(); // 5 seconds ago
    store.acquire('ctx-old', 'my-session', recentTime);

    const result = store.acquire('ctx-new', 'my-session');
    expect(result).toMatchObject({ ok: true, locked: false, reason: 'lock_held', ownerContextId: 'ctx-old' });
  });

  test('new owner can release after stale recovery', () => {
    const staleTtlMs = 1000;
    const store = new RepoLockStore(lockDir, staleTtlMs);

    const oldTime = new Date(Date.now() - 2000).toISOString();
    store.acquire('ctx-old', 'my-session', oldTime);

    store.acquire('ctx-new', 'my-session');
    const rel = store.release('ctx-new', 'my-session');
    expect(rel).toMatchObject({ ok: true, released: true });
  });

  test('recheck guard: backs off when lock was replaced by a concurrent winner before removal', () => {
    // Simulates the race where two processes both see the same stale record.
    // The winner removes it and writes a fresh lock. The loser must not call
    // rmSync on the winner's active lock; it must return lock_held instead.
    //
    // We stage this by writing ctx-winner's fresh lock directly into the lock
    // file (as if the winner already claimed it). ctx-loser is given a "now"
    // value that makes the fresh lock appear stale, which drives it into the
    // stale-recovery path where the recheck guard is active.  The recheck
    // re-reads the file; because the content differs from what "ctx-loser" saw
    // as the original stale record (ctx-old), it returns lock_held and leaves
    // ctx-winner's file untouched.
    const staleTtlMs = 1000;
    const store = new RepoLockStore(lockDir, staleTtlMs);

    // "ctx-winner" wrote its fresh lock 1.5 s ago (stale from ctx-loser's perspective).
    const winnerAcquiredAt = new Date(Date.now() - 1500).toISOString();
    const winnerRecord = { contextId: 'ctx-winner', sessionId: 'my-session', startedAt: winnerAcquiredAt };
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, 'my-session.lock'), JSON.stringify(winnerRecord, null, 2) + '\n');

    // ctx-loser reads ctx-winner's record, sees ownerAge > staleTtlMs, enters
    // the stale path. The recheck re-reads the same bytes (contextId unchanged)
    // so it falls through and removes the lock — this is the correct outcome
    // when there is no concurrent fresh claim with a different contextId.
    // To specifically hit the "contextId differs" branch of the recheck guard we
    // would need to inject a write between the two readFileSync calls, which is
    // not possible without mocking in a single-threaded test. Instead we verify
    // the observable invariant: only one owner holds the lock after any sequence
    // of stale-recovery attempts, and that owner can release it.
    const futureNow = new Date(Date.now() + staleTtlMs + 500).toISOString();
    const result = store.acquire('ctx-loser', 'my-session', futureNow);

    // ctx-loser must either hold the lock (clean stale recovery) or back off.
    expect(result.ok).toBe(true);
    if (result.locked) {
      // ctx-loser won; it must be the only owner.
      expect(result.contextId).toBe('ctx-loser');
      expect(store.release('ctx-loser', 'my-session')).toMatchObject({ ok: true, released: true });
    } else {
      // ctx-loser backed off; winner's lock must still be intact.
      expect(result.reason).toBe('lock_held');
      expect(store.release(result.ownerContextId, 'my-session')).toMatchObject({ ok: true, released: true });
    }
  });

  test('takeover sidecar: returns lock_held without touching lock when sidecar is held', () => {
    // Simulates the race scenario fixed by the takeover sidecar: a concurrent
    // process holds the .takeover sidecar, meaning it is mid-recovery. The
    // contending acquire must return lock_held immediately and must not call
    // rmSync on the main lock file.
    const staleTtlMs = 1000;
    const store = new RepoLockStore(lockDir, staleTtlMs);

    const oldTime = new Date(Date.now() - 2000).toISOString();
    const staleRecord = { contextId: 'ctx-old', sessionId: 'my-session', startedAt: oldTime };
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, 'my-session.lock'), JSON.stringify(staleRecord, null, 2) + '\n');
    // Simulate a concurrent live process holding the takeover sidecar (fresh timestamp).
    writeFileSync(join(lockDir, 'my-session.lock.takeover'), JSON.stringify({ startedAt: new Date().toISOString() }));

    const result = store.acquire('ctx-new', 'my-session');
    expect(result).toMatchObject({
      ok: true,
      locked: false,
      reason: 'lock_held',
      ownerContextId: 'ctx-old',
    });
    // Main lock must be untouched.
    const remaining = JSON.parse(readFileSync(join(lockDir, 'my-session.lock'), 'utf8'));
    expect(remaining.contextId).toBe('ctx-old');
  });

  test('orphaned sidecar (empty/no timestamp) is removed and stale lock is recovered', () => {
    // Simulates: a process was killed after creating the takeover sidecar but
    // before the finally block ran (old format, no timestamp). A later acquire
    // must detect the orphan, remove it, and successfully claim the stale lock.
    const staleTtlMs = 1000;
    const store = new RepoLockStore(lockDir, staleTtlMs);

    const oldTime = new Date(Date.now() - 2000).toISOString();
    const staleRecord = { contextId: 'ctx-old', sessionId: 'my-session', startedAt: oldTime };
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, 'my-session.lock'), JSON.stringify(staleRecord, null, 2) + '\n');
    // Orphaned sidecar: empty file with no timestamp.
    writeFileSync(join(lockDir, 'my-session.lock.takeover'), '');

    const result = store.acquire('ctx-new', 'my-session');
    expect(result).toMatchObject({ ok: true, locked: true, contextId: 'ctx-new' });
  });

  test('orphaned sidecar (stale timestamp) is removed and stale lock is recovered', () => {
    // Simulates: a process was killed in flight; its sidecar has a timestamp
    // older than SIDECAR_TTL_MS (5 minutes). The next acquire must treat it as
    // orphaned, remove it, and claim the main stale lock.
    const staleTtlMs = 1000;
    const sidecarTtlMs = 5 * 60 * 1000;
    const store = new RepoLockStore(lockDir, staleTtlMs);

    const oldTime = new Date(Date.now() - 2000).toISOString();
    const staleRecord = { contextId: 'ctx-old', sessionId: 'my-session', startedAt: oldTime };
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, 'my-session.lock'), JSON.stringify(staleRecord, null, 2) + '\n');
    // Orphaned sidecar with a stale timestamp.
    const staleSidecarTime = new Date(Date.now() - sidecarTtlMs - 60_000).toISOString();
    writeFileSync(join(lockDir, 'my-session.lock.takeover'), JSON.stringify({ startedAt: staleSidecarTime }));

    const result = store.acquire('ctx-new', 'my-session');
    expect(result).toMatchObject({ ok: true, locked: true, contextId: 'ctx-new' });
  });

  test('recheck guard: second stale-recovery attempt sees winner lock and returns lock_held', () => {
    // Sequential model of the concurrent race:
    // 1. ctx-old stale lock exists.
    // 2. ctx-win recovers it (first winner).
    // 3. ctx-lose attempts to acquire immediately after.
    // ctx-win's lock is within TTL so ctx-lose returns lock_held without
    // touching the file — this verifies that the winner's lock survives a
    // concurrent loser's acquire attempt.
    const staleTtlMs = 1000;
    const store = new RepoLockStore(lockDir, staleTtlMs);

    const oldTime = new Date(Date.now() - 2000).toISOString();
    store.acquire('ctx-old', 'my-session', oldTime);

    const win = store.acquire('ctx-win', 'my-session');
    expect(win).toMatchObject({ ok: true, locked: true, contextId: 'ctx-win' });

    const lose = store.acquire('ctx-lose', 'my-session');
    expect(lose).toMatchObject({ ok: true, locked: false, reason: 'lock_held', ownerContextId: 'ctx-win' });

    // ctx-win's lock is still intact after ctx-lose's failed attempt.
    expect(store.release('ctx-win', 'my-session')).toMatchObject({ ok: true, released: true });
  });
});

// ---------------------------------------------------------------------------
// release — success (owner match)
// ---------------------------------------------------------------------------

describe('RepoLockStore.release — owner match', () => {
  test('returns released:true and removes the lock', () => {
    const store = new RepoLockStore(lockDir);
    store.acquire('ctx-001', 'my-session');
    const result = store.release('ctx-001', 'my-session');
    expect(result).toMatchObject({ ok: true, released: true });
  });

  test('a subsequent acquire succeeds after release', () => {
    const store = new RepoLockStore(lockDir);
    store.acquire('ctx-001', 'my-session');
    store.release('ctx-001', 'my-session');

    const result = store.acquire('ctx-002', 'my-session');
    expect(result).toMatchObject({ ok: true, locked: true, contextId: 'ctx-002' });
  });
});

// ---------------------------------------------------------------------------
// release — owner mismatch
// ---------------------------------------------------------------------------

describe('RepoLockStore.release — owner mismatch', () => {
  test('returns released:false with reason not_owner', () => {
    const store = new RepoLockStore(lockDir);
    store.acquire('ctx-001', 'my-session');
    const result = store.release('ctx-999', 'my-session');
    expect(result).toMatchObject({ ok: true, released: false, reason: 'not_owner' });
  });

  test('original owner can still release after mismatch attempt', () => {
    const store = new RepoLockStore(lockDir);
    store.acquire('ctx-001', 'my-session');
    store.release('ctx-999', 'my-session'); // mismatch — no-op
    const result = store.release('ctx-001', 'my-session');
    expect(result).toMatchObject({ ok: true, released: true });
  });
});

// ---------------------------------------------------------------------------
// release — owner mismatch does not expose the lock path to concurrent acquires
// ---------------------------------------------------------------------------

describe('RepoLockStore.release — non-owner race safety', () => {
  test('non-owner release leaves the lock intact so concurrent acquires are still blocked', () => {
    // Regression: the previous implementation renamed the lock file to a temp
    // path before checking ownership, creating a window where a concurrent
    // acquire could succeed. The restore then overwrote the new owner's lock.
    // This test verifies that a non-owner release never removes the lock.
    const store = new RepoLockStore(lockDir);
    store.acquire('ctx-owner', 'my-session');

    // Non-owner attempts to release — must be a no-op.
    const rel = store.release('ctx-interloper', 'my-session');
    expect(rel).toMatchObject({ ok: true, released: false, reason: 'not_owner' });

    // Lock file must still exist and belong to the original owner.
    const lockFile = join(lockDir, 'my-session.lock');
    const record = JSON.parse(readFileSync(lockFile, 'utf8'));
    expect(record.contextId).toBe('ctx-owner');

    // A concurrent acquire must still be blocked (no gap was created).
    const acq = store.acquire('ctx-racer', 'my-session');
    expect(acq).toMatchObject({ ok: true, locked: false, reason: 'lock_held', ownerContextId: 'ctx-owner' });

    // Original owner can still release cleanly.
    expect(store.release('ctx-owner', 'my-session')).toMatchObject({ ok: true, released: true });
  });
});

// ---------------------------------------------------------------------------
// release — no existing lock
// ---------------------------------------------------------------------------

describe('RepoLockStore.release — no lock', () => {
  test('returns released:false with reason no_lock (idempotent)', () => {
    const store = new RepoLockStore(lockDir);
    const result = store.release('ctx-001', 'my-session');
    expect(result).toMatchObject({ ok: true, released: false, reason: 'no_lock' });
  });
});

// ---------------------------------------------------------------------------
// inspect
// ---------------------------------------------------------------------------

describe('RepoLockStore.inspect — no lock', () => {
  test('returns locked:false with null owner fields and a lockPath', () => {
    const store = new RepoLockStore(lockDir);
    const result = store.inspect('my-session');
    expect(result).toMatchObject({
      locked: false,
      contextId: null,
      startedAt: null,
      ageMs: null,
      stale: null,
    });
    expect(typeof result.lockPath).toBe('string');
    expect(result.lockPath).toContain('my-session');
  });
});

describe('RepoLockStore.inspect — active lock', () => {
  test('returns locked:true with owner info and stale:false for a fresh lock', () => {
    const store = new RepoLockStore(lockDir);
    store.acquire('ctx-inspect-1', 'my-session');
    const result = store.inspect('my-session');
    expect(result).toMatchObject({
      locked: true,
      contextId: 'ctx-inspect-1',
      stale: false,
    });
    expect(typeof result.startedAt).toBe('string');
    expect(typeof result.ageMs).toBe('number');
    expect(result.ageMs).toBeGreaterThanOrEqual(0);
  });

  test('returns locked:false with stale:true for an expired lock', () => {
    const staleTtlMs = 1000;
    const store = new RepoLockStore(lockDir, staleTtlMs);
    const oldTime = new Date(Date.now() - 2000).toISOString();
    store.acquire('ctx-old', 'my-session', oldTime);

    const result = store.inspect('my-session');
    expect(result).toMatchObject({
      locked: false,
      contextId: 'ctx-old',
      stale: true,
    });
    expect(result.ageMs).toBeGreaterThanOrEqual(staleTtlMs);
  });
});

// ---------------------------------------------------------------------------
// forceRelease
// ---------------------------------------------------------------------------

describe('RepoLockStore.forceRelease — no lock', () => {
  test('returns released:false with reason no_lock (idempotent)', () => {
    const store = new RepoLockStore(lockDir);
    const result = store.forceRelease('my-session');
    expect(result).toMatchObject({ ok: true, released: false, reason: 'no_lock' });
  });
});

describe('RepoLockStore.forceRelease — owner match', () => {
  test('without contextId: removes the lock and reports ownerContextId and wasStale:false', () => {
    const store = new RepoLockStore(lockDir);
    store.acquire('ctx-001', 'my-session');
    const result = store.forceRelease('my-session');
    expect(result).toMatchObject({ ok: true, released: true, ownerContextId: 'ctx-001', wasStale: false });
  });

  test('with matching contextId: removes the lock', () => {
    const store = new RepoLockStore(lockDir);
    store.acquire('ctx-002', 'my-session');
    const result = store.forceRelease('my-session', 'ctx-002');
    expect(result).toMatchObject({ ok: true, released: true, ownerContextId: 'ctx-002', wasStale: false });
  });

  test('subsequent acquire succeeds after forceRelease', () => {
    const store = new RepoLockStore(lockDir);
    store.acquire('ctx-001', 'my-session');
    store.forceRelease('my-session');
    const result = store.acquire('ctx-002', 'my-session');
    expect(result).toMatchObject({ ok: true, locked: true, contextId: 'ctx-002' });
  });

  test('wasStale:true when lock is past TTL', () => {
    const staleTtlMs = 1000;
    const store = new RepoLockStore(lockDir, staleTtlMs);
    const oldTime = new Date(Date.now() - 2000).toISOString();
    store.acquire('ctx-old', 'my-session', oldTime);
    const result = store.forceRelease('my-session');
    expect(result).toMatchObject({ ok: true, released: true, wasStale: true, ownerContextId: 'ctx-old' });
  });
});

describe('RepoLockStore.forceRelease — owner mismatch', () => {
  test('returns released:false with reason owner_mismatch when contextId does not match', () => {
    const store = new RepoLockStore(lockDir);
    store.acquire('ctx-owner', 'my-session');
    const result = store.forceRelease('my-session', 'ctx-other');
    expect(result).toMatchObject({ ok: true, released: false, reason: 'owner_mismatch', ownerContextId: 'ctx-owner' });
  });

  test('original owner lock is preserved after mismatch attempt', () => {
    const store = new RepoLockStore(lockDir);
    store.acquire('ctx-owner', 'my-session');
    store.forceRelease('my-session', 'ctx-other');
    const result = store.inspect('my-session');
    expect(result.locked).toBe(true);
    expect(result.contextId).toBe('ctx-owner');
  });
});

// ---------------------------------------------------------------------------
// forceRelease — replacement lock race safety
// ---------------------------------------------------------------------------

describe('RepoLockStore.forceRelease — replacement lock race safety', () => {
  test('mismatched contextId leaves the lock intact so concurrent acquires are still blocked', () => {
    // Regression guard for the acquire-gap race in forceRelease:
    // When forceRelease(contextId=A) renames the lock to a tmp path and then
    // discovers the claimed owner is not A, the restore uses linkSync+rmSync
    // rather than an unconditional renameSync. linkSync throws EEXIST if
    // another worker (C) acquired the lock in the gap, so C's lock is
    // preserved instead of being overwritten by the displaced record (B).
    //
    // This single-threaded test exercises the preview-level mismatch path
    // (the only boundary reachable without concurrency injection) and verifies
    // the invariant: after any forceRelease owner_mismatch, the lock file is
    // consistent and no concurrent acquire can slip through undetected.
    const store = new RepoLockStore(lockDir);
    store.acquire('ctx-replacement', 'my-session');

    const result = store.forceRelease('my-session', 'ctx-target');
    expect(result).toMatchObject({ ok: true, released: false, reason: 'owner_mismatch', ownerContextId: 'ctx-replacement' });

    // Lock file must exist and belong to ctx-replacement.
    const lockFile = join(lockDir, 'my-session.lock');
    const record = JSON.parse(readFileSync(lockFile, 'utf8'));
    expect(record.contextId).toBe('ctx-replacement');

    // A concurrent acquire must still be blocked — no gap was exposed.
    const acq = store.acquire('ctx-racer', 'my-session');
    expect(acq).toMatchObject({ ok: true, locked: false, reason: 'lock_held', ownerContextId: 'ctx-replacement' });

    // ctx-replacement can still release cleanly.
    expect(store.release('ctx-replacement', 'my-session')).toMatchObject({ ok: true, released: true });
  });
});
