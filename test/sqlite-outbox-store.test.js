import { jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import { SqliteOutboxStore } from '../dist/stores/sqlite-outbox-store.js';
import { OUTBOX_CLAIM_STALE_MS, OUTBOX_MAX_ATTEMPTS, computeOutboxBackoffMs } from '../dist/core/outbox.js';

let tmpDir;
let dbPath;
let store;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'outbox-store-test-'));
  dbPath = join(tmpDir, 'test.db');
  store = new SqliteOutboxStore(dbPath);
});

afterEach(() => {
  store.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

const COMMENT_PAYLOAD = {
  topic: 'gh:comment',
  owner: 'org',
  repo: 'repo',
  issueNumber: 1,
  body: 'hello',
};

describe('SqliteOutboxStore.enqueue', () => {
  test('enqueues new entry and returns enqueued:true', async () => {
    const result = await store.enqueue({
      idempotencyKey: 'key-1',
      topic: 'gh:comment',
      payload: COMMENT_PAYLOAD,
    });
    expect(result).toEqual({ enqueued: true });
  });

  test('duplicate idempotency key returns enqueued:false', async () => {
    await store.enqueue({ idempotencyKey: 'key-dup', topic: 'gh:comment', payload: COMMENT_PAYLOAD });
    const second = await store.enqueue({ idempotencyKey: 'key-dup', topic: 'gh:comment', payload: COMMENT_PAYLOAD });
    expect(second).toEqual({ enqueued: false });
  });

  test('distinct keys both enqueue', async () => {
    const r1 = await store.enqueue({ idempotencyKey: 'k1', topic: 'gh:comment', payload: COMMENT_PAYLOAD });
    const r2 = await store.enqueue({ idempotencyKey: 'k2', topic: 'gh:comment', payload: COMMENT_PAYLOAD });
    expect(r1.enqueued).toBe(true);
    expect(r2.enqueued).toBe(true);
  });
});

describe('SqliteOutboxStore.listPending', () => {
  test('returns empty array when nothing queued', async () => {
    const pending = await store.listPending();
    expect(pending).toEqual([]);
  });

  test('returns enqueued entries', async () => {
    await store.enqueue({ idempotencyKey: 'k1', topic: 'gh:comment', payload: COMMENT_PAYLOAD });
    const pending = await store.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      idempotencyKey: 'k1',
      topic: 'gh:comment',
      payload: COMMENT_PAYLOAD,
      sentAt: undefined,
    });
    expect(typeof pending[0].id).toBe('number');
  });

  test('excludes sent entries', async () => {
    await store.enqueue({ idempotencyKey: 'k1', topic: 'gh:comment', payload: COMMENT_PAYLOAD });
    await store.enqueue({ idempotencyKey: 'k2', topic: 'gh:comment', payload: { ...COMMENT_PAYLOAD, body: 'b2' } });
    const pending1 = await store.listPending();
    await store.markSent(pending1[0].id);
    const pending2 = await store.listPending();
    expect(pending2).toHaveLength(1);
    expect(pending2[0].idempotencyKey).toBe('k2');
  });

  test('respects limit', async () => {
    for (let i = 0; i < 5; i++) {
      await store.enqueue({ idempotencyKey: `k${i}`, topic: 'gh:comment', payload: COMMENT_PAYLOAD });
    }
    const pending = await store.listPending(3);
    expect(pending).toHaveLength(3);
  });

  test('returns oldest-first', async () => {
    await store.enqueue({ idempotencyKey: 'k1', topic: 'gh:comment', payload: COMMENT_PAYLOAD, now: '2026-01-01T00:00:00.000Z' });
    await store.enqueue({ idempotencyKey: 'k2', topic: 'gh:comment', payload: COMMENT_PAYLOAD, now: '2026-01-02T00:00:00.000Z' });
    const pending = await store.listPending();
    expect(pending[0].idempotencyKey).toBe('k1');
    expect(pending[1].idempotencyKey).toBe('k2');
  });
});

describe('SqliteOutboxStore.markSent', () => {
  test('marks entry as sent with provided timestamp', async () => {
    await store.enqueue({ idempotencyKey: 'k1', topic: 'gh:comment', payload: COMMENT_PAYLOAD });
    const [entry] = await store.listPending();
    await store.markSent(entry.id, '2026-06-07T12:00:00.000Z');

    const pending = await store.listPending();
    expect(pending).toHaveLength(0);
  });

  test('marks entry as sent with default timestamp', async () => {
    await store.enqueue({ idempotencyKey: 'k1', topic: 'gh:comment', payload: COMMENT_PAYLOAD });
    const [entry] = await store.listPending();
    await store.markSent(entry.id);
    expect(await store.listPending()).toHaveLength(0);
  });

  test('idempotent: marking unknown id is no-op', async () => {
    await store.markSent(9999); // should not throw
    expect(await store.listPending()).toHaveLength(0);
  });
});

describe('SqliteOutboxStore.markFailed', () => {
  test('first failure records attempt count, sanitized error, and schedules a future retry', async () => {
    await store.enqueue({ idempotencyKey: 'k1', topic: 'gh:comment', payload: COMMENT_PAYLOAD });
    const [entry] = await store.listPending();

    const result = await store.markFailed(entry.id, 'server error', '2026-01-01T00:00:00.000Z');
    expect(result).toEqual({ deadLettered: false });

    const [updated] = await store.listPending();
    expect(updated.attemptCount).toBe(1);
    expect(updated.lastError).toBe('server error');
    expect(updated.nextAttemptAt).toBe('2026-01-01T00:01:00.000Z'); // base 1-minute backoff
    expect(updated.deadLetterAt).toBeUndefined();
  });

  test('backoff doubles per attempt, bounded by the max delay', async () => {
    await store.enqueue({ idempotencyKey: 'k1', topic: 'gh:comment', payload: COMMENT_PAYLOAD });
    const [entry] = await store.listPending();
    const now = '2026-01-01T00:00:00.000Z';

    await store.markFailed(entry.id, 'err', now); // attempt 1 -> +1m
    let [row] = await store.listPending();
    expect(row.nextAttemptAt).toBe('2026-01-01T00:01:00.000Z');

    await store.markFailed(entry.id, 'err', now); // attempt 2 -> +2m
    [row] = await store.listPending();
    expect(row.nextAttemptAt).toBe('2026-01-01T00:02:00.000Z');

    await store.markFailed(entry.id, 'err', now); // attempt 3 -> +4m
    [row] = await store.listPending();
    expect(row.nextAttemptAt).toBe('2026-01-01T00:04:00.000Z');
  });

  test('a row stays pending (retryable) after fewer than the max-attempt threshold', async () => {
    await store.enqueue({ idempotencyKey: 'k1', topic: 'gh:comment', payload: COMMENT_PAYLOAD });
    const [entry] = await store.listPending();
    for (let i = 0; i < 6; i++) {
      const result = await store.markFailed(entry.id, `err-${i}`, '2026-01-01T00:00:00.000Z');
      expect(result.deadLettered).toBe(false);
    }
    const pending = await store.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0].deadLetterAt).toBeUndefined();
  });

  test('exhausting the retry budget dead-letters the row and excludes it from listPending', async () => {
    await store.enqueue({ idempotencyKey: 'k1', topic: 'gh:comment', payload: COMMENT_PAYLOAD });
    const [entry] = await store.listPending();

    let result;
    for (let i = 0; i < 8; i++) {
      result = await store.markFailed(entry.id, `err-${i}`, '2026-01-01T00:00:00.000Z');
    }
    expect(result).toEqual({ deadLettered: true });
    expect(await store.listPending()).toHaveLength(0);
  });

  test('sanitizes absolute paths and raw tokens out of the persisted error', async () => {
    await store.enqueue({ idempotencyKey: 'k1', topic: 'gh:comment', payload: COMMENT_PAYLOAD });
    const [entry] = await store.listPending();

    await store.markFailed(
      entry.id,
      'gh api failed: /Users/alice/secret-project/.env token ghp_abcdefghijklmnopqrst1234',
      '2026-01-01T00:00:00.000Z',
    );
    const [updated] = await store.listPending();
    expect(updated.lastError).not.toContain('/Users/alice');
    expect(updated.lastError).not.toContain('ghp_abcdefghijklmnopqrst1234');
  });

  test('unknown id is a no-op, mirroring markSent', async () => {
    const result = await store.markFailed(9999, 'boom');
    expect(result).toEqual({ deadLettered: false });
  });
});

describe('SqliteOutboxStore scan cursor (issue #606 review follow-up)', () => {
  test('getScanCursor returns undefined when nothing has been persisted for the key', async () => {
    expect(await store.getScanCursor('session-a')).toBeUndefined();
  });

  test('setScanCursor persists and getScanCursor retrieves it', async () => {
    await store.setScanCursor('session-a', 42);
    expect(await store.getScanCursor('session-a')).toBe(42);
  });

  test('setScanCursor overwrites a previously persisted value for the same key', async () => {
    await store.setScanCursor('session-a', 42);
    await store.setScanCursor('session-a', 100);
    expect(await store.getScanCursor('session-a')).toBe(100);
  });

  test('cursors for distinct keys do not interfere with each other', async () => {
    await store.setScanCursor('session-a', 10);
    await store.setScanCursor('session-b', 20);
    expect(await store.getScanCursor('session-a')).toBe(10);
    expect(await store.getScanCursor('session-b')).toBe(20);
  });
});

describe('SqliteOutboxStore.claimForDispatch / cancelEntry race (issue #607 review follow-up)', () => {
  async function pendingId() {
    await store.enqueue({ idempotencyKey: 'race-k1', topic: 'gh:comment', payload: COMMENT_PAYLOAD });
    const [entry] = await store.listPending();
    return entry.id;
  }

  test('claimForDispatch claims a pending row', async () => {
    const id = await pendingId();
    expect(await store.claimForDispatch(id, '2026-01-01T00:00:00.000Z')).toBe(true);
  });

  test('claimForDispatch refuses a row already claimed (non-stale)', async () => {
    const id = await pendingId();
    expect(await store.claimForDispatch(id, '2026-01-01T00:00:00.000Z')).toBe(true);
    expect(await store.claimForDispatch(id, '2026-01-01T00:00:01.000Z')).toBe(false);
  });

  test('claimForDispatch refuses a sent row', async () => {
    const id = await pendingId();
    await store.markSent(id, '2026-01-01T00:00:00.000Z');
    expect(await store.claimForDispatch(id, '2026-01-01T00:00:01.000Z')).toBe(false);
  });

  test('claimForDispatch refuses a cancelled row', async () => {
    const id = await pendingId();
    await store.cancelEntry(id, '2026-01-01T00:00:00.000Z');
    expect(await store.claimForDispatch(id, '2026-01-01T00:00:01.000Z')).toBe(false);
  });

  test('a stale claim no longer blocks a fresh claimForDispatch attempt', async () => {
    const id = await pendingId();
    const t0 = new Date('2026-01-01T00:00:00.000Z');
    expect(await store.claimForDispatch(id, t0.toISOString())).toBe(true);
    const wayLater = new Date(t0.getTime() + OUTBOX_CLAIM_STALE_MS + 1).toISOString();
    expect(await store.claimForDispatch(id, wayLater)).toBe(true);
  });

  test('markFailed clears the claim so a subsequent claimForDispatch succeeds once due', async () => {
    const id = await pendingId();
    const t0 = new Date('2026-01-01T00:00:00.000Z');
    expect(await store.claimForDispatch(id, t0.toISOString())).toBe(true);
    await store.markFailed(id, 'transient', t0.toISOString());
    // The claim was released, but the row is still delayed by the backoff
    // markFailed just scheduled — a re-claim at the same instant must not
    // bypass it (P2 review follow-up: this is the exact race the fix closes).
    expect(await store.claimForDispatch(id, t0.toISOString())).toBe(false);
    const due = new Date(t0.getTime() + computeOutboxBackoffMs(1)).toISOString();
    expect(await store.claimForDispatch(id, due)).toBe(true);
  });

  test('claimForDispatch refuses a delayed row before its next_attempt_at is due (P2 review follow-up)', async () => {
    const id = await pendingId();
    const t0 = new Date('2026-01-01T00:00:00.000Z');
    expect(await store.claimForDispatch(id, t0.toISOString())).toBe(true);
    await store.markFailed(id, 'transient', t0.toISOString());
    const stillEarly = new Date(t0.getTime() + computeOutboxBackoffMs(1) - 1).toISOString();
    expect(await store.claimForDispatch(id, stillEarly)).toBe(false);
    const due = new Date(t0.getTime() + computeOutboxBackoffMs(1)).toISOString();
    expect(await store.claimForDispatch(id, due)).toBe(true);
  });

  test('cancelEntry refuses a row currently claimed for dispatch, reporting dispatch_in_progress', async () => {
    const id = await pendingId();
    const t0 = '2026-01-01T00:00:00.000Z';
    expect(await store.claimForDispatch(id, t0)).toBe(true);
    const result = await store.cancelEntry(id, t0);
    expect(result).toEqual({ cancelled: false, reason: 'dispatch_in_progress' });
    // The row must not have been mutated into a cancelled/dead-lettered state
    // by the refused cancel — it is still an ordinary claimed-pending row.
    const row = await store.getById(id);
    expect(row.cancelledAt).toBeUndefined();
    expect(row.deadLetterAt).toBeUndefined();
  });

  test('cancelEntry succeeds once the dispatch attempt resolves and releases the claim', async () => {
    const id = await pendingId();
    const t0 = '2026-01-01T00:00:00.000Z';
    expect(await store.claimForDispatch(id, t0)).toBe(true);
    await store.markFailed(id, 'transient', t0); // resolves + releases the claim
    const result = await store.cancelEntry(id, t0);
    expect(result).toEqual({ cancelled: true });
  });

  test('cancelEntry succeeds against a stale (abandoned) claim', async () => {
    const id = await pendingId();
    const t0 = new Date('2026-01-01T00:00:00.000Z');
    expect(await store.claimForDispatch(id, t0.toISOString())).toBe(true);
    const wayLater = new Date(t0.getTime() + OUTBOX_CLAIM_STALE_MS + 1).toISOString();
    const result = await store.cancelEntry(id, wayLater);
    expect(result).toEqual({ cancelled: true });
  });
});

describe('SqliteOutboxStore.renewClaim (issue #607 review follow-up)', () => {
  async function pendingId() {
    await store.enqueue({ idempotencyKey: 'renew-k1', topic: 'gh:comment', payload: COMMENT_PAYLOAD });
    const [entry] = await store.listPending();
    return entry.id;
  }

  test('renewClaim extends a claim past OUTBOX_CLAIM_STALE_MS, keeping it live', async () => {
    const id = await pendingId();
    const t0 = new Date('2026-01-01T00:00:00.000Z');
    expect(await store.claimForDispatch(id, t0.toISOString())).toBe(true);

    // Without renewal, a claim this old would be treated as abandoned (see
    // 'a stale claim no longer blocks a fresh claimForDispatch attempt'
    // above). A long-running dispatch attempt (e.g. `gh`, which has no
    // request timeout) renews its lease instead of letting that happen.
    const wayLater = new Date(t0.getTime() + OUTBOX_CLAIM_STALE_MS + 1).toISOString();
    const renewed = await store.renewClaim(id, t0.toISOString(), wayLater);
    expect(renewed).toBe(wayLater);

    // A concurrent dispatcher's claim attempt, evaluating staleness against
    // its own current time, must still see this as a live claim and refuse
    // it — the renewal must not have been silently ignored.
    expect(await store.claimForDispatch(id, wayLater)).toBe(false);
  });

  test('renewClaim fails once the claim has been released (markSent/markFailed)', async () => {
    const id = await pendingId();
    const t0 = '2026-01-01T00:00:00.000Z';
    expect(await store.claimForDispatch(id, t0)).toBe(true);
    await store.markSent(id, t0); // resolves + releases the claim

    // A heartbeat renewal that fires after the attempt already completed
    // must not resurrect a claim on an already-sent row.
    expect(await store.renewClaim(id, t0, t0)).toBeUndefined();
  });

  test('renewClaim fails once a different attempt has reclaimed the row', async () => {
    const id = await pendingId();
    const t0 = new Date('2026-01-01T00:00:00.000Z');
    expect(await store.claimForDispatch(id, t0.toISOString())).toBe(true);

    // The original claim goes stale (its holder crashed without renewing)
    // and a second dispatcher reclaims the row under a fresh claim token.
    const wayLater = new Date(t0.getTime() + OUTBOX_CLAIM_STALE_MS + 1).toISOString();
    expect(await store.claimForDispatch(id, wayLater)).toBe(true);

    // The first (crashed) attempt's belated renewal, using its stale token,
    // must be a safe no-op — not an overwrite of the second attempt's claim.
    const evenLater = new Date(t0.getTime() + OUTBOX_CLAIM_STALE_MS + 2).toISOString();
    expect(await store.renewClaim(id, t0.toISOString(), evenLater)).toBeUndefined();

    const row = await store.getById(id);
    expect(row.claimedAt).toBe(wayLater);
  });
});

describe('SqliteOutboxStore.retryEntry / cancelEntry race (issue #607 review follow-up)', () => {
  async function deadId() {
    await store.enqueue({ idempotencyKey: 'retry-race-k1', topic: 'gh:comment', payload: COMMENT_PAYLOAD });
    const [entry] = await store.listPending();
    const t0 = '2026-01-01T00:00:00.000Z';
    for (let i = 0; i < OUTBOX_MAX_ATTEMPTS; i++) {
      await store.markFailed(entry.id, 'transient', t0);
    }
    return entry.id;
  }

  test('retryEntry does not reactivate a row a concurrent cancelEntry commits mid-flight', async () => {
    const id = await deadId();
    const t0 = '2026-01-01T00:00:00.000Z';

    // Simulate a second admin process's cancelEntry committing in the exact
    // window between retryEntry's own eligibility SELECT and its UPDATE, by
    // hooking the very first `SELECT * FROM outbox WHERE id = ?` (retryEntry's
    // read) and running a real, independent cancelEntry from a second
    // connection right after it resolves but before retryEntry's UPDATE runs.
    const originalPrepare = Database.prototype.prepare;
    let intercepted = false;
    const prepareSpy = jest.spyOn(Database.prototype, 'prepare').mockImplementation(function (sql, ...rest) {
      const stmt = originalPrepare.call(this, sql, ...rest);
      if (!intercepted && this.name === dbPath && sql === 'SELECT * FROM outbox WHERE id = ?') {
        intercepted = true;
        const originalGet = stmt.get.bind(stmt);
        stmt.get = (...args) => {
          const row = originalGet(...args);
          const racer = new SqliteOutboxStore(dbPath);
          try {
            racer.cancelEntry(id, t0);
          } finally {
            racer.close();
          }
          return row;
        };
      }
      return stmt;
    });

    let retryResult;
    try {
      retryResult = await store.retryEntry(id, t0);
    } finally {
      prepareSpy.mockRestore();
    }

    // The cancel that raced it must be the one that stuck — retryEntry must
    // not have clobbered it and reactivated the row.
    expect(intercepted).toBe(true);
    expect(retryResult).toEqual({ retried: false, reason: 'already_cancelled' });

    const row = await store.getById(id);
    expect(row.cancelledAt).toBeTruthy();
    expect(row.deadLetterAt).toBeTruthy();
  });

  test('retryEntry still recovers a row cancelled in an earlier, non-racing call', async () => {
    const id = await deadId();
    const t0 = '2026-01-01T00:00:00.000Z';
    await store.cancelEntry(id, t0);

    const retryResult = await store.retryEntry(id, t0);
    expect(retryResult).toEqual({ retried: true });

    const row = await store.getById(id);
    expect(row.cancelledAt).toBeUndefined();
    expect(row.deadLetterAt).toBeUndefined();
  });
});

describe('SqliteOutboxStore payload types', () => {
  test('stores and retrieves gh:label:add payload', async () => {
    const payload = { topic: 'gh:label:add', owner: 'o', repo: 'r', issueNumber: 5, label: 'ai:active' };
    await store.enqueue({ idempotencyKey: 'lk', topic: 'gh:label:add', payload });
    const [entry] = await store.listPending();
    expect(entry.payload).toEqual(payload);
  });

  test('stores and retrieves gh:label:remove payload', async () => {
    const payload = { topic: 'gh:label:remove', owner: 'o', repo: 'r', issueNumber: 5, label: 'ai:active' };
    await store.enqueue({ idempotencyKey: 'lrk', topic: 'gh:label:remove', payload });
    const [entry] = await store.listPending();
    expect(entry.payload).toEqual(payload);
  });
});
