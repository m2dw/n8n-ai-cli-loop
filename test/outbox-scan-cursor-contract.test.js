/**
 * Behavioral tests for the persisted three-cursor outbox scan contract
 * (issue #819) — docs/outbox-scan-cursor-contract.md.
 *
 * These pin the cursor *state* the dispatcher persists, not just the rows it
 * happens to dispatch: the roles are only meaningful if `floor` stays behind
 * every still-open owned row, `fwd` never shrinks past protection it still
 * owes, and `bulk` keeps accumulating forward progress. Dispatch-outcome-only
 * assertions would pass for several broken cursor states that strand a row two
 * runs later.
 */
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SqliteOutboxStore } from '../dist/stores/sqlite-outbox-store.js';
import { dispatchOutbox } from '../dist/handlers/gh-dispatcher.js';
import {
  deriveOwnershipScanCursorKey,
  deriveScanCursorKey,
  scanCursorKeysFor,
} from '../dist/core/outbox-scan-cursor.js';

let tmpDir;
let dbPath;
let store;

const CWD = '/tmp';

const OWNED = { topic: 'gh:comment', owner: 'org', repo: 'repo', issueNumber: 10, body: 'owned' };
const FOREIGN = { ...OWNED, owner: 'other', repo: 'repo' };

const ownedFilter = (entry) => entry.payload.owner === 'org' && entry.payload.repo === 'repo';
const foreignFilter = (entry) => entry.payload.owner === 'other' && entry.payload.repo === 'repo';

// The identity a real session-bound dispatch would use, so these tests exercise
// the same key space production does (a JSON ownership tuple, §4.2) rather than
// a bare string only tests ever produce.
const IDENTITY = deriveOwnershipScanCursorKey({ sessionId: 's', githubOwner: 'org', githubName: 'repo' });
const KEYS = scanCursorKeysFor(IDENTITY);

function okResult() { return { exitCode: 0, stdout: '', stderr: '' }; }
function failResult(stderr = 'boom') { return { exitCode: 1, stdout: '', stderr }; }

/** A runner yielding `n` identical results; throws if called more often. */
function runnerOf(result, n) {
  let idx = 0;
  return {
    run() {
      if (idx++ >= n) throw new Error('Unexpected gh runner call');
      return result;
    },
  };
}

/** Wraps a store, recording every `listPendingEntries` request. */
function recordingStore(inner) {
  const fetches = [];
  return {
    fetches,
    listPendingEntries(opts) { fetches.push({ ...opts }); return inner.listPendingEntries(opts); },
    listPending: (limit) => inner.listPending(limit),
    getScanCursor: (key) => inner.getScanCursor(key),
    setScanCursor: (key, id) => inner.setScanCursor(key, id),
    claimForDispatch: (id, at) => inner.claimForDispatch(id, at),
    renewClaim: (id, token) => inner.renewClaim(id, token),
    markSent: (id, at, token) => inner.markSent(id, at, token),
    markFailed: (id, err, at, token) => inner.markFailed(id, err, at, token),
    getById: (id) => inner.getById(id),
    isMaintenanceLocked: () => inner.isMaintenanceLocked(),
  };
}

async function enqueue(key, payload) {
  await store.enqueue({ idempotencyKey: key, topic: 'gh:comment', payload });
  const rows = await store.listPending();
  return rows.find((r) => r.idempotencyKey === key)?.id;
}

async function enqueueMany(prefix, count, payload) {
  for (let i = 0; i < count; i++) {
    await store.enqueue({ idempotencyKey: `${prefix}-${i}`, topic: 'gh:comment', payload });
  }
}

async function cursors() {
  return {
    floor: await store.getScanCursor(KEYS.floor),
    fwd: await store.getScanCursor(KEYS.fwd),
    bulk: await store.getScanCursor(KEYS.bulk),
  };
}

async function pendingKeys() {
  return (await store.listPending()).map((e) => e.idempotencyKey);
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'outbox-cursor-contract-'));
  dbPath = join(tmpDir, 'test.db');
  store = new SqliteOutboxStore(dbPath);
});

afterEach(() => {
  store.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// §3 / §8 — the three roles are three distinct persisted rows
// ---------------------------------------------------------------------------

describe('three-cursor contract — persisted key set', () => {
  test('a run persists exactly the three derived keys and nothing else', async () => {
    await enqueueMany('foreign', 3, FOREIGN);
    await enqueue('mine', OWNED);
    // Fail the owned row so it stays open: that is the state in which all three
    // roles are written (floor held back, zone end, bulk extent).
    await dispatchOutbox(store, runnerOf(failResult(), 1), {
      cwd: CWD,
      now: '2026-01-01T00:00:00.000Z',
      filter: ownedFilter,
      scanCursorKey: IDENTITY,
    });
    await enqueueMany('foreign-b', 3, FOREIGN);
    await enqueue('mine-2', OWNED);
    await dispatchOutbox(store, runnerOf(failResult(), 2), {
      cwd: CWD,
      now: '2026-01-01T00:01:30.000Z',
      filter: ownedFilter,
      scanCursorKey: IDENTITY,
    });

    const db = new Database(dbPath, { readonly: true });
    const keys = db.prepare('SELECT scan_key FROM outbox_scan_cursor ORDER BY scan_key').all().map((r) => r.scan_key);
    db.close();
    expect(new Set(keys)).toEqual(new Set([KEYS.floor, KEYS.fwd, KEYS.bulk]));
    // The floor key is the identity verbatim — the pre-#819 key shape (§11).
    expect(keys).toContain(IDENTITY);
  });
});

// ---------------------------------------------------------------------------
// §10.1 — multiple delayed rows
// ---------------------------------------------------------------------------

describe('three-cursor contract — multiple delayed rows', () => {
  test('several simultaneously delayed owned rows hold the floor, stay inside the zone, and all dispatch once due', async () => {
    const foreignHead = 2;
    await enqueueMany('head', foreignHead, FOREIGN);
    const delayedIds = [];
    for (const key of ['d1', 'd2', 'd3', 'd4']) delayedIds.push(await enqueue(key, OWNED));

    const t0 = '2026-01-01T00:00:00.000Z';
    const first = await dispatchOutbox(store, runnerOf(failResult(), 4), {
      cwd: CWD,
      now: t0,
      filter: ownedFilter,
      scanCursorKey: IDENTITY,
    });
    expect(first.failed).toBe(4);

    // Floor stops before the *earliest* delayed row; the zone end reaches the
    // latest, so every one of the four is inside `(floor, fwd]` (I3).
    let state = await cursors();
    expect(state.floor).toBe(delayedIds[0] - 1);
    expect(state.fwd).toBe(delayedIds[delayedIds.length - 1]);

    // A large foreign backlog plus a newer owned due row behind it.
    await enqueueMany('backlog', 300, FOREIGN);
    const laterId = await enqueue('later', OWNED);

    // Repeated bounded runs, all inside the delayed rows' backoff window.
    const now = '2026-01-01T00:00:10.000Z';
    let reachedLater = false;
    for (let i = 0; i < 12 && !reachedLater; i++) {
      const result = await dispatchOutbox(store, runnerOf(okResult(), 1), {
        cwd: CWD,
        now,
        filter: ownedFilter,
        scanCursorKey: IDENTITY,
        scanLimit: 60,
        limit: 5,
      });
      if (result.dispatched === 1) reachedLater = true;
      // The delayed rows must never be crossed, however far bulk scanning got.
      const s = await cursors();
      expect(s.floor).toBe(delayedIds[0] - 1);
      expect(s.fwd).toBeGreaterThanOrEqual(delayedIds[delayedIds.length - 1]);
    }
    expect(reachedLater).toBe(true);
    expect(await pendingKeys()).not.toContain('later');

    // Bulk progress crossed the backlog even though the zone never resolved.
    state = await cursors();
    expect(state.bulk).toBeGreaterThan(laterId - 300);

    // Past the backoff window every delayed row is still reachable (I1).
    const drained = await dispatchOutbox(store, runnerOf(okResult(), 4), {
      cwd: CWD,
      now: '2026-01-01T00:02:00.000Z',
      filter: ownedFilter,
      scanCursorKey: IDENTITY,
      limit: 10,
    });
    expect(drained.dispatched).toBe(4);
    const remaining = await pendingKeys();
    expect(remaining.every((k) => k.startsWith('head') || k.startsWith('backlog'))).toBe(true);
    expect(remaining).toHaveLength(foreignHead + 300);
  });
});

// ---------------------------------------------------------------------------
// §10.3 — foreign backlog
// ---------------------------------------------------------------------------

describe('three-cursor contract — foreign backlog', () => {
  test('bulk accumulates across bounded runs while the floor stays pinned by a delayed row', async () => {
    const delayedId = await enqueue('delayed', OWNED);
    const t0 = '2026-01-01T00:00:00.000Z';
    await dispatchOutbox(store, runnerOf(failResult(), 1), {
      cwd: CWD,
      now: t0,
      filter: ownedFilter,
      scanCursorKey: IDENTITY,
    });
    await enqueueMany('backlog', 400, FOREIGN);

    const now = '2026-01-01T00:00:10.000Z';
    const seen = [];
    for (let i = 0; i < 5; i++) {
      await dispatchOutbox(store, runnerOf(okResult(), 0), {
        cwd: CWD,
        now,
        filter: ownedFilter,
        scanCursorKey: IDENTITY,
        scanLimit: 40,
        limit: 5,
      });
      const s = await cursors();
      // I2: the floor never crosses the still-open row, whatever bulk does.
      expect(s.floor === undefined || s.floor < delayedId).toBe(true);
      seen.push(s.bulk ?? 0);
    }

    // I5: monotonic non-decreasing, and actually advancing.
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
    expect(seen[seen.length - 1]).toBeGreaterThan(seen[0]);
  });

  test('a run that scans no foreign row cannot regress the bulk cursor', async () => {
    await enqueueMany('backlog', 250, FOREIGN);
    await dispatchOutbox(store, runnerOf(okResult(), 0), {
      cwd: CWD,
      now: '2026-01-01T00:00:00.000Z',
      filter: ownedFilter,
      scanCursorKey: IDENTITY,
    });
    const afterFirst = await cursors();
    expect(afterFirst.bulk).toBeGreaterThan(0);

    // Nothing new to scan: every row is already behind both cursors.
    await dispatchOutbox(store, runnerOf(okResult(), 0), {
      cwd: CWD,
      now: '2026-01-01T00:00:05.000Z',
      filter: ownedFilter,
      scanCursorKey: IDENTITY,
    });
    const afterSecond = await cursors();
    expect(afterSecond.bulk).toBeGreaterThanOrEqual(afterFirst.bulk);
  });
});

// ---------------------------------------------------------------------------
// §10.4 — scan and page limits change between runs
// ---------------------------------------------------------------------------

describe('three-cursor contract — changed scan/page limits', () => {
  test('shrinking the run limit below the zone size never shrinks the zone or strands its tail', async () => {
    await enqueueMany('head', 2, FOREIGN);
    const zoneIds = [];
    for (const key of ['a', 'b', 'c', 'd', 'e', 'f']) zoneIds.push(await enqueue(key, OWNED));
    const zoneEnd = zoneIds[zoneIds.length - 1];

    // Run 1, generous budget: establishes the whole zone.
    await dispatchOutbox(store, runnerOf(failResult(), 6), {
      cwd: CWD,
      now: '2026-01-01T00:00:00.000Z',
      filter: ownedFilter,
      scanCursorKey: IDENTITY,
      limit: 50,
    });
    await enqueueMany('backlog', 300, FOREIGN);
    // Run 2, generous budget, nothing due: pushes bulk past the whole zone.
    await dispatchOutbox(store, runnerOf(okResult(), 0), {
      cwd: CWD,
      now: '2026-01-01T00:00:10.000Z',
      filter: ownedFilter,
      scanCursorKey: IDENTITY,
      limit: 50,
    });
    const primed = await cursors();
    expect(primed.fwd).toBe(zoneEnd);
    expect(primed.bulk).toBeGreaterThan(zoneEnd);

    // Run 3, budget shrunk to below the zone size, everything now due: Phase A
    // fills `pending` partway through the zone and stops.
    const capped = await dispatchOutbox(store, runnerOf(failResult(), 2), {
      cwd: CWD,
      now: '2026-01-01T00:01:00.000Z',
      filter: ownedFilter,
      scanCursorKey: IDENTITY,
      limit: 2,
      scanLimit: 3,
    });
    expect(capped.failed).toBe(2);
    const shrunk = await cursors();
    // §8.2: an incomplete walk may only grow the zone, never shrink it to the
    // examined prefix — the unexamined tail is still owed protection.
    expect(shrunk.fwd).toBeGreaterThanOrEqual(zoneEnd);
    expect(shrunk.floor).toBeLessThan(zoneIds[0]);

    // Run 4, budget raised again and past every backoff window (the two rows
    // run 3 retried are on their second, 120s, delay): the rows run 3 never
    // examined are still found, together with the ones it did.
    const drained = await dispatchOutbox(store, runnerOf(okResult(), 6), {
      cwd: CWD,
      now: '2026-01-01T00:05:00.000Z',
      filter: ownedFilter,
      scanCursorKey: IDENTITY,
      limit: 50,
    });
    expect(drained.dispatched).toBe(6);
    const remaining = await pendingKeys();
    expect(remaining.every((k) => k.startsWith('head') || k.startsWith('backlog'))).toBe(true);
  });

  test('raising scanLimit after a sequence of tiny-budget runs reaches the owned row without rescanning', async () => {
    await enqueueMany('backlog', 120, FOREIGN);
    const ownedId = await enqueue('mine', OWNED);

    let previousBulk = 0;
    for (let i = 0; i < 4; i++) {
      await dispatchOutbox(store, runnerOf(okResult(), 0), {
        cwd: CWD,
        now: '2026-01-01T00:00:00.000Z',
        filter: ownedFilter,
        scanCursorKey: IDENTITY,
        scanLimit: 5,
        limit: 1,
      });
      const { bulk } = await cursors();
      expect(bulk).toBeGreaterThanOrEqual(previousBulk);
      previousBulk = bulk ?? 0;
    }
    expect(previousBulk).toBeLessThan(ownedId);

    const wrapped = recordingStore(store);
    const result = await dispatchOutbox(wrapped, runnerOf(okResult(), 1), {
      cwd: CWD,
      now: '2026-01-01T00:00:30.000Z',
      filter: ownedFilter,
      scanCursorKey: IDENTITY,
      scanLimit: 500,
      limit: 5,
    });
    expect(result.dispatched).toBe(1);
    // Resumed from the accumulated bulk extent rather than restarting at row 1.
    expect(wrapped.fetches[0].afterId).toBe(previousBulk);
  });
});

// ---------------------------------------------------------------------------
// §10.5 / §4.6 — ownership scope change
// ---------------------------------------------------------------------------

describe('three-cursor contract — ownership scope change', () => {
  test('repointing the repository orphans the old cursor instead of skipping the new scope rows', async () => {
    // Rows for the repo the session will be repointed *to*. Under the old scope
    // they are foreign, so the old identity's cursors advance right past them.
    await enqueueMany('newrepo', 6, FOREIGN);
    const oldIdentity = IDENTITY;
    await dispatchOutbox(store, runnerOf(okResult(), 0), {
      cwd: CWD,
      now: '2026-01-01T00:00:00.000Z',
      filter: ownedFilter,
      scanCursorKey: oldIdentity,
    });
    const oldFloor = await store.getScanCursor(deriveScanCursorKey(oldIdentity, 'floor'));
    expect(oldFloor).toBe(6);

    // The operator repoints the session: same session id, different repo. The
    // ownership tuple — and therefore all three keys — change.
    const newIdentity = deriveOwnershipScanCursorKey({
      sessionId: 's',
      githubOwner: 'other',
      githubName: 'repo',
    });
    expect(newIdentity).not.toBe(oldIdentity);

    const result = await dispatchOutbox(store, runnerOf(okResult(), 6), {
      cwd: CWD,
      now: '2026-01-01T00:00:10.000Z',
      filter: foreignFilter,
      scanCursorKey: newIdentity,
    });
    // Every row below the old cursor is still reachable under the new scope.
    expect(result.dispatched).toBe(6);
    expect(await pendingKeys()).toHaveLength(0);

    // The old key's rows are orphaned, not rewritten or deleted.
    expect(await store.getScanCursor(deriveScanCursorKey(oldIdentity, 'floor'))).toBe(oldFloor);
    // The new identity confirmed nothing foreign (every scanned row was its
    // own, and all resolved), so it has no extent to record yet — it did not
    // inherit the old scope's position.
    expect(await store.getScanCursor(deriveScanCursorKey(newIdentity, 'floor'))).toBeUndefined();
  });

  test('two differently scoped sessions never read each other cursors', async () => {
    const a = deriveOwnershipScanCursorKey({ sessionId: 's', githubOwner: 'org', githubName: 'repo' });
    const b = deriveOwnershipScanCursorKey({
      sessionId: 's',
      githubOwner: 'org',
      githubName: 'repo',
      gitea: { owner: 'org', repo: 'repo', baseUrl: 'https://gitea.example.com' },
    });
    expect(a).not.toBe(b);

    await enqueueMany('foreign', 5, FOREIGN);
    await dispatchOutbox(store, runnerOf(okResult(), 0), {
      cwd: CWD,
      now: '2026-01-01T00:00:00.000Z',
      filter: ownedFilter,
      scanCursorKey: a,
    });
    expect(await store.getScanCursor(deriveScanCursorKey(a, 'floor'))).toBe(5);
    for (const role of ['floor', 'fwd', 'bulk']) {
      expect(await store.getScanCursor(deriveScanCursorKey(b, role))).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// §11 — compatibility with cursors persisted before this contract
// ---------------------------------------------------------------------------

describe('three-cursor contract — compatibility', () => {
  test('a cursor persisted under the pre-#819 key is honored, with fwd/bulk absent', async () => {
    await enqueueMany('foreign', 5, FOREIGN);
    const ownedId = await enqueue('mine', OWNED);
    // Exactly the state issue #606 left behind: one row keyed by the dispatch
    // identity itself, no derived rows at all.
    await store.setScanCursor(IDENTITY, 5);
    expect(await store.getScanCursor(KEYS.fwd)).toBeUndefined();
    expect(await store.getScanCursor(KEYS.bulk)).toBeUndefined();

    const wrapped = recordingStore(store);
    const result = await dispatchOutbox(wrapped, runnerOf(okResult(), 1), {
      cwd: CWD,
      now: '2026-01-01T00:00:00.000Z',
      filter: ownedFilter,
      scanCursorKey: IDENTITY,
    });
    expect(result.dispatched).toBe(1);
    // The legacy value is read as the floor: the scan resumes after it instead
    // of re-walking the confirmed-foreign prefix from row 1.
    expect(wrapped.fetches[0].afterId).toBe(5);
    expect(wrapped.fetches.every((f) => (f.afterId ?? 0) >= 5)).toBe(true);
    expect(ownedId).toBe(6);
  });

  test('a stale fwd/bulk value at or behind the floor is ignored rather than migrated', async () => {
    await enqueueMany('foreign', 4, FOREIGN);
    await enqueue('mine', OWNED);
    await store.setScanCursor(KEYS.floor, 4);
    await store.setScanCursor(KEYS.fwd, 2);
    await store.setScanCursor(KEYS.bulk, 3);

    const wrapped = recordingStore(store);
    const result = await dispatchOutbox(wrapped, runnerOf(okResult(), 1), {
      cwd: CWD,
      now: '2026-01-01T00:00:00.000Z',
      filter: ownedFilter,
      scanCursorKey: IDENTITY,
    });
    expect(result.dispatched).toBe(1);
    // Neither stale value pulled the scan back behind the floor.
    expect(wrapped.fetches.every((f) => (f.afterId ?? 0) >= 4)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §10.2 / I1 — retry, dead-letter, and the no-permanent-skip property
// ---------------------------------------------------------------------------

describe('three-cursor contract — retry and dead-letter', () => {
  test('a dead-lettered row releases the floor it was holding', async () => {
    const poisonId = await enqueue('poison', OWNED);
    await enqueueMany('foreign', 5, FOREIGN);

    // Seven failures recorded directly; the eighth (through the dispatcher)
    // exhausts the retry budget and dead-letters the row.
    for (let i = 0; i < 7; i++) {
      await store.markFailed(poisonId, `err-${i}`, '2026-01-01T00:00:00.000Z');
    }
    const holding = await dispatchOutbox(store, runnerOf(failResult(), 1), {
      cwd: CWD,
      now: '2027-01-01T00:00:00.000Z',
      filter: ownedFilter,
      scanCursorKey: IDENTITY,
    });
    expect(holding.deadLettered).toBe(1);

    // Resolved, so it no longer holds the floor back: the floor may now advance
    // over the confirmed-foreign rows behind it.
    const state = await cursors();
    expect(state.floor).toBe(6);
  });

  test('no owned pending row is permanently skipped across many runs with varying budgets', async () => {
    // Owned rows interleaved through a foreign backlog, one of them driven into
    // backoff first so a protected zone exists from the very first run.
    const ownedKeys = [];
    for (let i = 0; i < 24; i++) {
      if (i % 6 === 0) {
        const key = `mine-${i}`;
        ownedKeys.push(key);
        await enqueue(key, OWNED);
      } else {
        await enqueue(`foreign-${i}`, FOREIGN);
      }
    }

    expect(ownedKeys).toHaveLength(4);

    const t0 = '2026-01-01T00:00:00.000Z';
    await dispatchOutbox(store, runnerOf(failResult(), 4), {
      cwd: CWD,
      now: t0,
      filter: ownedFilter,
      scanCursorKey: IDENTITY,
      limit: 4,
    });
    expect((await pendingKeys()).filter((k) => k.startsWith('mine'))).toHaveLength(4);

    // Budgets rotate between runs — the cursors must stay meaningful under any
    // combination, and the clock advances past each backoff window.
    const limits = [1, 3, 2, 5, 1];
    const scanLimits = [1, 4, 2, 30, 7];
    for (let i = 0; i < 20; i++) {
      const minute = 2 + i * 30;
      await dispatchOutbox(store, runnerOf(okResult(), 8), {
        cwd: CWD,
        now: new Date(Date.parse(t0) + minute * 60_000).toISOString(),
        filter: ownedFilter,
        scanCursorKey: IDENTITY,
        limit: limits[i % limits.length],
        scanLimit: scanLimits[i % scanLimits.length],
      });
    }

    const remaining = await pendingKeys();
    expect(remaining.filter((k) => k.startsWith('mine'))).toEqual([]);
    // Foreign rows are untouched — bounded progress, not indiscriminate drain.
    expect(remaining).toHaveLength(20);
  });
});
