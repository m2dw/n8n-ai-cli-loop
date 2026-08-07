/**
 * Retry-triggered scan-cursor rewind (issue #820) —
 * docs/outbox-scan-cursor-contract.md §13.
 *
 * `admin outbox retry` is the only operation that moves a row *backward* into
 * the pending set. Every cursor rule elsewhere in the contract assumes rows only
 * ever leave it, so a retry of a row the cursors already passed produces a row
 * that is pending and yet permanently invisible: `listPendingEntries` selects
 * `id > afterId` and never looks back.
 *
 * These tests pin the cursor *state* around a retry, not just its return value —
 * a rewind that reports the right roles but writes the wrong `after_id` (or
 * creates a cursor row that did not exist) strands or re-dispatches rows two
 * runs later, which no return-value assertion would catch.
 */
import { jest } from '@jest/globals';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SqliteOutboxStore } from '../dist/stores/sqlite-outbox-store.js';
import { SqliteMaintenanceLock } from '../dist/stores/sqlite-maintenance-lock.js';
import { dispatchOutbox } from '../dist/handlers/gh-dispatcher.js';
import { OUTBOX_MAX_ATTEMPTS } from '../dist/core/outbox.js';
import {
  deriveOwnershipScanCursorKey,
  planScanCursorRewind,
  scanCursorKeysFor,
} from '../dist/core/outbox-scan-cursor.js';

let tmpDir;
let dbPath;
let store;

const CWD = '/tmp';
const T0 = '2026-01-01T00:00:00.000Z';

const OWNED = { topic: 'gh:comment', owner: 'org', repo: 'repo', issueNumber: 10, body: 'owned' };
const FOREIGN = { ...OWNED, owner: 'other', repo: 'repo' };
const ownedFilter = (entry) => entry.payload.owner === 'org' && entry.payload.repo === 'repo';

// The identity a real session-bound dispatch resolves (§4.2), so the tests
// exercise the production key space rather than a bare string.
const IDENTITY = deriveOwnershipScanCursorKey({ sessionId: 's', githubOwner: 'org', githubName: 'repo' });
const KEYS = scanCursorKeysFor(IDENTITY);
const OTHER_IDENTITY = deriveOwnershipScanCursorKey({
  sessionId: 'other',
  githubOwner: 'org',
  githubName: 'repo',
});
const OTHER_KEYS = scanCursorKeysFor(OTHER_IDENTITY);

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'outbox-retry-rewind-'));
  dbPath = join(tmpDir, 'test.db');
  store = new SqliteOutboxStore(dbPath);
});

afterEach(() => {
  try {
    store.close();
  } catch {
    // already closed by a test
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

async function enqueue(key, payload = OWNED) {
  await store.enqueue({ idempotencyKey: key, topic: 'gh:comment', payload });
  const rows = await store.listUnsent();
  return rows.find((r) => r.idempotencyKey === key).id;
}

/** Enqueue a row and exhaust its retry budget so it is dead-lettered. */
async function deadRow(key, payload = OWNED) {
  const id = await enqueue(key, payload);
  for (let i = 0; i < OUTBOX_MAX_ATTEMPTS; i++) {
    await store.markFailed(id, 'transient', T0);
  }
  return id;
}

/** Read the persisted cursor rows directly — absent must be distinguishable from 0. */
function rawCursors() {
  const db = new Database(dbPath, { readonly: true });
  const rows = db.prepare('SELECT scan_key, after_id FROM outbox_scan_cursor').all();
  db.close();
  return Object.fromEntries(rows.map((r) => [r.scan_key, r.after_id]));
}

async function setAllCursors(afterId, keys = KEYS) {
  for (const key of [keys.floor, keys.fwd, keys.bulk]) {
    expect(await store.setScanCursor(key, afterId)).toEqual({ persisted: true });
  }
}

/**
 * A runner that commits an `admin outbox retry` of `rowId` from a second
 * connection *while the dispatch it races is inside its external call* — i.e.
 * after that run read its cursors and before it persists them, which is exactly
 * the window §13.5 is about.
 *
 * `retryEntry` performs every SQLite write synchronously (better-sqlite3 has no
 * async path), so the retry has committed by the time this synchronous runner
 * returns; its promise is collected so the test can assert the outcome.
 */
function retryingRunner(rowId, identity = IDENTITY) {
  const retries = [];
  return {
    retries,
    run() {
      const racer = new SqliteOutboxStore(dbPath);
      try {
        retries.push(racer.retryEntry(rowId, T0, { cursorIdentityKey: identity }));
      } finally {
        racer.close();
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  };
}

function okRunner(n = 1) {
  let idx = 0;
  return {
    run() {
      if (idx++ >= n) throw new Error('Unexpected gh runner call');
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  };
}

// ---------------------------------------------------------------------------
// §13.2 — the rule, as a pure function
// ---------------------------------------------------------------------------

describe('planScanCursorRewind — the rewind rule (§13.2)', () => {
  test('selects every role whose cursor sits at or past the retried row', () => {
    expect(planScanCursorRewind({ floor: 12, fwd: 12, bulk: 40 }, 12)).toEqual({
      required: true,
      targetAfterId: 11,
      roles: ['floor', 'fwd', 'bulk'],
    });
  });

  test('R1: a cursor exactly ON the row is affected — the scan predicate is strict', () => {
    // `id > afterId`, so after_id === id already hides the row. Using `>` here
    // would leave exactly this row stranded, which is the whole bug.
    expect(planScanCursorRewind({ floor: 7 }, 7)).toEqual({
      required: true,
      targetAfterId: 6,
      roles: ['floor'],
    });
  });

  test('a cursor strictly behind the row needs no rewind', () => {
    expect(planScanCursorRewind({ floor: 6, fwd: 6, bulk: 6 }, 7)).toEqual({
      required: false,
      targetAfterId: 6,
      roles: [],
    });
  });

  test('R3: an absent role is never selected, and absent is not 0', () => {
    expect(planScanCursorRewind({ bulk: 40 }, 5)).toEqual({
      required: true,
      targetAfterId: 4,
      roles: ['bulk'],
    });
    expect(planScanCursorRewind({}, 5)).toEqual({ required: false, targetAfterId: 4, roles: [] });
    // after_id 0 is a real, persisted "nothing confirmed yet" — never >= a row id.
    expect(planScanCursorRewind({ floor: 0 }, 1)).toEqual({
      required: false,
      targetAfterId: 0,
      roles: [],
    });
  });

  test('roles are reported in role order regardless of object key order', () => {
    expect(planScanCursorRewind({ bulk: 9, floor: 9, fwd: 9 }, 9).roles).toEqual(['floor', 'fwd', 'bulk']);
  });
});

// ---------------------------------------------------------------------------
// §13.2 R1/R2/R3 — what the store actually writes
// ---------------------------------------------------------------------------

describe('retryEntry cursor rewind — persisted state (§13.2)', () => {
  test('rewinds all three roles to id - 1 and reports them', async () => {
    const id = await deadRow('mine');
    await setAllCursors(id + 30);

    expect(await store.retryEntry(id, T0, { cursorIdentityKey: IDENTITY })).toEqual({
      retried: true,
      cursorsRewound: ['floor', 'fwd', 'bulk'],
    });

    expect(rawCursors()).toEqual({
      [KEYS.floor]: id - 1,
      [KEYS.fwd]: id - 1,
      [KEYS.bulk]: id - 1,
    });
  });

  test('R2: rewinds no further than id - 1, and leaves a cursor already behind the row alone', async () => {
    const older = await enqueue('older');
    const id = await deadRow('mine');
    await store.setScanCursor(KEYS.floor, older - 1);
    await store.setScanCursor(KEYS.fwd, id);
    await store.setScanCursor(KEYS.bulk, id + 100);

    expect(await store.retryEntry(id, T0, { cursorIdentityKey: IDENTITY })).toEqual({
      retried: true,
      cursorsRewound: ['fwd', 'bulk'],
    });

    expect(rawCursors()).toEqual({
      [KEYS.floor]: older - 1, // untouched: already behind the row
      [KEYS.fwd]: id - 1,
      [KEYS.bulk]: id - 1,
    });
  });

  test('R3: a role with no persisted cursor stays absent — the rewind never creates one', async () => {
    const id = await deadRow('mine');
    await store.setScanCursor(KEYS.bulk, id + 5);

    expect(await store.retryEntry(id, T0, { cursorIdentityKey: IDENTITY })).toEqual({
      retried: true,
      cursorsRewound: ['bulk'],
    });

    const rows = rawCursors();
    expect(rows).toEqual({ [KEYS.bulk]: id - 1 });
    expect(Object.keys(rows)).not.toContain(KEYS.floor);
    expect(Object.keys(rows)).not.toContain(KEYS.fwd);
  });

  test('only the retrying identity is rewound — another session keeps its cursors', async () => {
    const id = await deadRow('mine');
    await setAllCursors(id + 10);
    await setAllCursors(id + 10, OTHER_KEYS);

    await store.retryEntry(id, T0, { cursorIdentityKey: IDENTITY });

    const rows = rawCursors();
    expect(rows[KEYS.floor]).toBe(id - 1);
    expect(rows[OTHER_KEYS.floor]).toBe(id + 10);
    expect(rows[OTHER_KEYS.fwd]).toBe(id + 10);
    expect(rows[OTHER_KEYS.bulk]).toBe(id + 10);
  });

  test('reports an empty rewound list when every cursor is already behind the row', async () => {
    const id = await deadRow('mine');
    await setAllCursors(id - 1);

    expect(await store.retryEntry(id, T0, { cursorIdentityKey: IDENTITY })).toEqual({
      retried: true,
      cursorsRewound: [],
    });
    expect(rawCursors()[KEYS.floor]).toBe(id - 1);
  });

  test('without a cursor scope the pre-#820 behavior is unchanged — no cursor is read or written', async () => {
    const id = await deadRow('mine');
    await setAllCursors(id + 10);

    expect(await store.retryEntry(id, T0)).toEqual({ retried: true });

    expect(rawCursors()).toEqual({
      [KEYS.floor]: id + 10,
      [KEYS.fwd]: id + 10,
      [KEYS.bulk]: id + 10,
    });
  });

  test('rewinding to 0 is representable — retrying row 1 does not underflow into an invalid cursor', async () => {
    const id = await deadRow('mine');
    expect(id).toBe(1);
    await setAllCursors(5);

    expect(await store.retryEntry(id, T0, { cursorIdentityKey: IDENTITY })).toEqual({
      retried: true,
      cursorsRewound: ['floor', 'fwd', 'bulk'],
    });
    expect(rawCursors()[KEYS.floor]).toBe(0);
  });

  test('a malformed identity key is rejected before anything is mutated', async () => {
    const id = await deadRow('mine');
    await setAllCursors(id + 10);

    // Derived-key shape: accepting it would let one identity own another's
    // cursor row (§4.5). Rejecting it must not half-apply the retry.
    await expect(store.retryEntry(id, T0, { cursorIdentityKey: '3:foo:fwd' })).rejects.toThrow(
      /derived-key shape/,
    );

    expect((await store.getById(id)).deadLetterAt).toBeTruthy();
    expect(rawCursors()[KEYS.floor]).toBe(id + 10);
  });
});

// ---------------------------------------------------------------------------
// §13.2 R4/R5 — atomicity, races, idempotency
// ---------------------------------------------------------------------------

describe('retryEntry cursor rewind — atomicity and races (§13.3)', () => {
  test('R5: a no-op retry of an already-pending row moves nothing (idempotency)', async () => {
    const id = await deadRow('mine');
    await setAllCursors(id + 10);

    expect(await store.retryEntry(id, T0, { cursorIdentityKey: IDENTITY })).toEqual({
      retried: true,
      cursorsRewound: ['floor', 'fwd', 'bulk'],
    });
    // Cursors advance again as if a later dispatch run had confirmed progress.
    await setAllCursors(id + 10);

    // The second, redundant retry finds the row already pending: no state
    // change at all, including no rewind. A rewind here would silently undo a
    // legitimate dispatch run's progress every time an operator re-ran the
    // command.
    expect(await store.retryEntry(id, T0, { cursorIdentityKey: IDENTITY })).toEqual({
      retried: false,
      reason: 'already_pending',
    });
    expect(rawCursors()).toEqual({
      [KEYS.floor]: id + 10,
      [KEYS.fwd]: id + 10,
      [KEYS.bulk]: id + 10,
    });
  });

  test('R5: a maintenance-locked refusal leaves every cursor unchanged', async () => {
    const id = await deadRow('mine');
    await setAllCursors(id + 10);

    const lock = new SqliteMaintenanceLock(dbPath);
    expect(lock.acquire('prune:1', T0)).toEqual({ ok: true });
    try {
      expect(await store.retryEntry(id, '2026-01-01T00:00:01.000Z', { cursorIdentityKey: IDENTITY })).toEqual({
        retried: false,
        reason: 'maintenance_locked',
      });
    } finally {
      lock.release();
      lock.close();
    }

    expect(rawCursors()).toEqual({
      [KEYS.floor]: id + 10,
      [KEYS.fwd]: id + 10,
      [KEYS.bulk]: id + 10,
    });
  });

  test('R4/R5: a lost compare-and-set race commits neither the row nor a rewind', async () => {
    const id = await deadRow('mine');
    await setAllCursors(id + 10);

    // A second admin process cancels the row in the exact window between this
    // retry's eligibility SELECT and its guarded UPDATE (the same interception
    // point test/sqlite-outbox-store.test.js uses for the #607 race).
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
            racer.cancelEntry(id, T0);
          } finally {
            racer.close();
          }
          return row;
        };
      }
      return stmt;
    });

    let result;
    try {
      result = await store.retryEntry(id, T0, { cursorIdentityKey: IDENTITY });
    } finally {
      prepareSpy.mockRestore();
    }

    expect(intercepted).toBe(true);
    expect(result).toEqual({ retried: false, reason: 'already_cancelled' });
    // The row stayed cancelled, so rewinding would have re-opened a span for a
    // recovery that never happened.
    expect(rawCursors()).toEqual({
      [KEYS.floor]: id + 10,
      [KEYS.fwd]: id + 10,
      [KEYS.bulk]: id + 10,
    });
  });

  test('R5: a claim race that sends the row mid-retry leaves the cursors unchanged', async () => {
    const id = await enqueue('mine');
    // Delayed (backing off), so the retry is eligible at T0...
    await store.markFailed(id, 'transient', T0);
    await setAllCursors(id + 10);
    const later = '2026-01-01T01:00:00.000Z';

    // ...but a dispatcher claims and completes it in the retry's race window.
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
            racer.claimForDispatch(id, later);
            racer.markSent(id, later, later);
          } finally {
            racer.close();
          }
          return row;
        };
      }
      return stmt;
    });

    let result;
    try {
      result = await store.retryEntry(id, T0, { cursorIdentityKey: IDENTITY });
    } finally {
      prepareSpy.mockRestore();
    }

    expect(intercepted).toBe(true);
    expect(result).toEqual({ retried: false, reason: 'already_sent' });
    expect((await store.getById(id)).sentAt).toBe(later);
    expect(rawCursors()).toEqual({
      [KEYS.floor]: id + 10,
      [KEYS.fwd]: id + 10,
      [KEYS.bulk]: id + 10,
    });
  });
});

// ---------------------------------------------------------------------------
// §13.1 — the stranded row, end to end
// ---------------------------------------------------------------------------

describe('a previously stranded row becomes discoverable again (§13.1)', () => {
  test('a retried dead-letter row below the cursors is dispatched by the next run', async () => {
    const stranded = await deadRow('stranded');
    // A realistic backlog: later foreign rows carried every cursor far past the
    // dead-lettered row, exactly as §8 prescribes once it stopped being open.
    for (let i = 0; i < 5; i++) {
      await store.enqueue({ idempotencyKey: `foreign-${i}`, topic: 'gh:comment', payload: FOREIGN });
    }
    await dispatchOutbox(store, okRunner(0), {
      cwd: CWD,
      now: T0,
      filter: ownedFilter,
      scanCursorKey: IDENTITY,
    });
    const before = rawCursors();
    expect(before[KEYS.floor]).toBeGreaterThanOrEqual(stranded);

    // Without the rewind this run would dispatch nothing: the row is pending
    // again but sits below every cursor's `id > afterId` window. Expected roles
    // are derived from the cursors the dispatcher actually wrote, so the
    // assertion pins the rule (existing ∧ `>= id`) rather than a snapshot of
    // which roles this particular run happened to persist.
    const expectedRoles = ['floor', 'fwd', 'bulk'].filter(
      (role) => before[KEYS[role]] !== undefined && before[KEYS[role]] >= stranded,
    );
    expect(expectedRoles.length).toBeGreaterThan(0);
    expect(await store.retryEntry(stranded, T0, { cursorIdentityKey: IDENTITY })).toEqual({
      retried: true,
      cursorsRewound: expectedRoles,
    });
    // R3 in situ: the rewind moved rows, it did not add any.
    expect(Object.keys(rawCursors()).sort()).toEqual(Object.keys(before).sort());

    const runner = okRunner(1);
    const result = await dispatchOutbox(store, runner, {
      cwd: CWD,
      now: '2026-01-01T02:00:00.000Z',
      filter: ownedFilter,
      scanCursorKey: IDENTITY,
    });
    expect(result.dispatched).toBe(1);
    expect((await store.getById(stranded)).sentAt).toBeTruthy();
  });

  test('control: the same row is NOT reached when the cursors are left in place', async () => {
    const stranded = await deadRow('stranded');
    for (let i = 0; i < 5; i++) {
      await store.enqueue({ idempotencyKey: `foreign-${i}`, topic: 'gh:comment', payload: FOREIGN });
    }
    await dispatchOutbox(store, okRunner(0), {
      cwd: CWD,
      now: T0,
      filter: ownedFilter,
      scanCursorKey: IDENTITY,
    });

    // Same recovery, no cursor scope — the pre-#820 behavior, kept as the
    // control that proves the rewind (not something else) is what unstrands it.
    expect(await store.retryEntry(stranded, T0)).toEqual({ retried: true });

    const result = await dispatchOutbox(store, okRunner(1), {
      cwd: CWD,
      now: '2026-01-01T02:00:00.000Z',
      filter: ownedFilter,
      scanCursorKey: IDENTITY,
    });
    expect(result.dispatched).toBe(0);
    expect((await store.getById(stranded)).sentAt).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// §13.5 — fencing a dispatch run that raced the retry
// ---------------------------------------------------------------------------

/**
 * The retry transaction alone only makes the row update and the rewind
 * inseparable. It says nothing about a drain that read the cursors *before*
 * either happened and writes its extent back *after* both: that write is an
 * unconditional upsert, so it restores the pre-retry position and re-strands the
 * recovered row — permanently, since the recovery command has already returned.
 * These tests pin the fence that makes the overlap safe.
 */
describe('a drain racing the retry cannot undo the rewind (§13.5)', () => {
  test('F4: the in-flight run is refused and the rewound cursors stand', async () => {
    const stranded = await deadRow('stranded'); // id 1 — dead-lettered
    const live = await enqueue('live'); // id 2 — owned and due, so the runner runs
    await enqueue('foreign', FOREIGN); // id 3 — carries this run's extent past the row
    // The cursors sit on the dead-lettered row, as §10.2 leaves them once it
    // stops holding the floor.
    await setAllCursors(stranded);

    // The retry commits inside the dispatch of row 2 — after the cursors were
    // read, before they are written.
    const runner = retryingRunner(stranded);
    const result = await dispatchOutbox(store, runner, {
      cwd: CWD,
      now: T0,
      filter: ownedFilter,
      scanCursorKey: IDENTITY,
    });

    expect(await runner.retries[0]).toEqual({
      retried: true,
      cursorsRewound: ['floor', 'fwd', 'bulk'],
    });
    // The drain still did its work — fencing suppresses cursor persistence, not
    // dispatch — and reports why its scan progress was dropped.
    expect(result.dispatched).toBe(1);
    expect((await store.getById(live)).sentAt).toBeTruthy();
    expect(result.cursorFenceStale).toBe(true);
    expect(result.maintenanceLocked).toBeUndefined();

    // Every cursor still sits where the rewind put it. Unfenced, this run wrote
    // its own extent (row 3, past the revived row) over all of them.
    expect(rawCursors()).toEqual({
      [KEYS.floor]: stranded - 1,
      [KEYS.fwd]: stranded - 1,
      [KEYS.bulk]: stranded - 1,
    });

    // Which is the whole point: the recovery still recovers.
    const next = await dispatchOutbox(store, okRunner(1), {
      cwd: CWD,
      now: '2026-01-01T02:00:00.000Z',
      filter: ownedFilter,
      scanCursorKey: IDENTITY,
    });
    expect(next.dispatched).toBe(1);
    expect(next.cursorFenceStale).toBeUndefined();
    expect((await store.getById(stranded)).sentAt).toBeTruthy();
  });

  test('F2: a retry that rewinds nothing still fences the run that would strand the row', async () => {
    // No cursor row exists yet, so there is nothing at or past the revived row
    // to rewind (R3 keeps absent absent) — a fence derived from cursor *values*
    // would let this run through. The danger is unchanged: the run scanned past
    // the row while it was dead-lettered (`listPendingEntries` never returns a
    // dead-lettered row), so the extent it is about to persist covers it.
    const stranded = await deadRow('stranded'); // id 1
    const live = await enqueue('live'); // id 2
    await enqueue('foreign', FOREIGN); // id 3
    expect(rawCursors()).toEqual({});

    const runner = retryingRunner(stranded);
    const result = await dispatchOutbox(store, runner, {
      cwd: CWD,
      now: T0,
      filter: ownedFilter,
      scanCursorKey: IDENTITY,
    });

    expect(await runner.retries[0]).toEqual({ retried: true, cursorsRewound: [] });
    expect(result.dispatched).toBe(1);
    expect((await store.getById(live)).sentAt).toBeTruthy();
    expect(result.cursorFenceStale).toBe(true);
    // Refused, so no cursor row was created either — the next run starts from
    // row 1 and sees the recovered row.
    expect(rawCursors()).toEqual({});

    const next = await dispatchOutbox(store, okRunner(1), {
      cwd: CWD,
      now: '2026-01-01T02:00:00.000Z',
      filter: ownedFilter,
      scanCursorKey: IDENTITY,
    });
    expect(next.dispatched).toBe(1);
    expect((await store.getById(stranded)).sentAt).toBeTruthy();
  });

  test('F2: a no-op retry does not fence — the run keeps the progress it made', async () => {
    // Fencing costs a run its scan progress, so only a *committed* recovery may
    // trigger it. An operator re-running `outbox retry` on an already-pending
    // row must not silently reset a concurrent drain's forward progress.
    const alreadyPending = await enqueue('foreign-pending', FOREIGN); // id 1
    const live = await enqueue('live'); // id 2
    const foreign = await enqueue('foreign-tail', FOREIGN); // id 3

    const runner = retryingRunner(alreadyPending);
    const result = await dispatchOutbox(store, runner, {
      cwd: CWD,
      now: T0,
      filter: ownedFilter,
      scanCursorKey: IDENTITY,
    });

    expect(await runner.retries[0]).toEqual({ retried: false, reason: 'already_pending' });
    expect(result.dispatched).toBe(1);
    expect(result.cursorFenceStale).toBeUndefined();
    expect(rawCursors()[KEYS.floor]).toBe(foreign);
    expect((await store.getById(live)).sentAt).toBeTruthy();
  });

  test('F1: the fence is per identity — another session\'s retry does not refuse this run', async () => {
    const stranded = await deadRow('stranded'); // id 1
    const live = await enqueue('live'); // id 2
    const foreign = await enqueue('foreign-tail', FOREIGN); // id 3
    await setAllCursors(stranded);
    await setAllCursors(stranded, OTHER_KEYS);

    // The racing retry carries a *different* dispatch identity, so it rewinds
    // that identity's cursors and bumps that identity's generation only.
    const runner = retryingRunner(stranded, OTHER_IDENTITY);
    const result = await dispatchOutbox(store, runner, {
      cwd: CWD,
      now: T0,
      filter: ownedFilter,
      scanCursorKey: IDENTITY,
    });

    expect(await runner.retries[0]).toEqual({
      retried: true,
      cursorsRewound: ['floor', 'fwd', 'bulk'],
    });
    expect(result.cursorFenceStale).toBeUndefined();
    expect(rawCursors()[KEYS.floor]).toBe(foreign);
    expect(rawCursors()[OTHER_KEYS.floor]).toBe(stranded - 1);
    expect((await store.getById(live)).sentAt).toBeTruthy();
  });
});

describe('the fence generation itself (§13.5 F1–F3)', () => {
  test('starts at 0, advances once per committed retry, and only for the retried identity', async () => {
    const first = await deadRow('first');
    const second = await deadRow('second');
    expect(await store.getScanCursorFence(IDENTITY)).toBe(0);

    await store.retryEntry(first, T0, { cursorIdentityKey: IDENTITY });
    expect(await store.getScanCursorFence(IDENTITY)).toBe(1);
    expect(await store.getScanCursorFence(OTHER_IDENTITY)).toBe(0);

    await store.retryEntry(second, T0, { cursorIdentityKey: IDENTITY });
    expect(await store.getScanCursorFence(IDENTITY)).toBe(2);
  });

  test('a retry with no cursor scope leaves the generation alone (pre-#820 callers)', async () => {
    const id = await deadRow('mine');
    expect(await store.retryEntry(id, T0)).toEqual({ retried: true });
    expect(await store.getScanCursorFence(IDENTITY)).toBe(0);
  });

  test('a refused retry leaves the generation alone', async () => {
    const id = await deadRow('mine');
    await store.retryEntry(id, T0, { cursorIdentityKey: IDENTITY });
    expect(await store.getScanCursorFence(IDENTITY)).toBe(1);

    // Now already pending: R5 says nothing moves, and the generation is state
    // like any other.
    expect(await store.retryEntry(id, T0, { cursorIdentityKey: IDENTITY })).toEqual({
      retried: false,
      reason: 'already_pending',
    });
    expect(await store.getScanCursorFence(IDENTITY)).toBe(1);
  });

  test('F4: a write carrying a stale generation persists nothing; the current one commits', async () => {
    const id = await deadRow('mine');
    await setAllCursors(id + 10);
    const observed = await store.getScanCursorFence(IDENTITY);

    await store.retryEntry(id, T0, { cursorIdentityKey: IDENTITY });

    expect(
      await store.setScanCursor(KEYS.floor, id + 10, { identityKey: IDENTITY, epoch: observed }),
    ).toEqual({ persisted: false, fenceStale: true });
    expect(rawCursors()[KEYS.floor]).toBe(id - 1);

    // A run that started *after* the retry read the new generation and is free
    // to advance normally — the fence blocks stale writes, not all writes.
    expect(
      await store.setScanCursor(KEYS.floor, id + 10, {
        identityKey: IDENTITY,
        epoch: await store.getScanCursorFence(IDENTITY),
      }),
    ).toEqual({ persisted: true });
    expect(rawCursors()[KEYS.floor]).toBe(id + 10);
  });

  test('an unfenced write keeps its pre-#820 unconditional behavior', async () => {
    const id = await deadRow('mine');
    await setAllCursors(id + 10);
    await store.retryEntry(id, T0, { cursorIdentityKey: IDENTITY });

    // Callers that pass no fence (admin tooling, stores without the capability)
    // are unaffected by the generation bump.
    expect(await store.setScanCursor(KEYS.floor, id + 4)).toEqual({ persisted: true });
    expect(rawCursors()[KEYS.floor]).toBe(id + 4);
  });

  test('a maintenance refusal is still reported as contention, not a stale fence', async () => {
    const lock = new SqliteMaintenanceLock(dbPath);
    expect(lock.acquire('prune:1', T0)).toEqual({ ok: true });
    try {
      expect(
        await store.setScanCursor(KEYS.floor, 7, { identityKey: IDENTITY, epoch: 0 }),
      ).toEqual({ persisted: false });
    } finally {
      lock.release();
      lock.close();
    }
    expect(rawCursors()).toEqual({});
  });
});
