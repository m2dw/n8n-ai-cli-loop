/**
 * Maintenance-lock exclusion for every outbox enqueue, claim, and dispatch
 * path (issue #818, docs/retention-backup-contract.md §9).
 *
 * The two race boundaries the contract cares about are acquire-vs-enqueue and
 * acquire-vs-claim: in both, the lock read and the mutation must happen inside
 * the SAME SQLite transaction, so a `prune`/`restore` pass can never have a row
 * appear (or be claimed and dispatched) underneath it. These tests pin the
 * observable half of that — refusal while held, normal behavior once released,
 * and, critically, that a refusal mutates NOTHING — plus the symmetric
 * direction (`acquire()` refusing while a claim is live) which together make
 * the two operations mutually exclusive in both orders.
 */
import { jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import { SqliteOutboxStore } from '../dist/stores/sqlite-outbox-store.js';
import { SqliteTaskStore } from '../dist/stores/sqlite-task-store.js';
import { SqliteMaintenanceLock } from '../dist/stores/sqlite-maintenance-lock.js';
import { dispatchOutbox } from '../dist/handlers/gh-dispatcher.js';
import { runNextPhase } from '../dist/core/phase-runner.js';
import { MemoryTaskStore } from '../dist/index.js';
import { MaintenanceLockedError } from '../dist/stores/maintenance-lock-guard.js';

let tmpDir;
let dbPath;
let store;

const COMMENT_PAYLOAD = {
  topic: 'gh:comment',
  owner: 'org',
  repo: 'repo',
  issueNumber: 1,
  body: 'hello',
};

const SUMMARY_PAYLOAD = {
  topic: 'repohost:pr-summary',
  provider: 'github',
  owner: 'org',
  repo: 'repo',
  prNumber: 7,
  marker: '<!-- summary -->',
  body: 'latest',
};

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'outbox-maintenance-lock-test-'));
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

/** Acquire the maintenance lock as an unrelated maintenance process would. */
function holdLock(holder = 'prune:1234', now = '2026-01-01T00:00:00.000Z', opts = {}) {
  const lock = new SqliteMaintenanceLock(dbPath);
  const acquired = lock.acquire(holder, now, opts);
  expect(acquired).toEqual({ ok: true });
  return lock;
}

/**
 * Run `fn` while observing whether this store's `maintenance_lock` read ran
 * inside an open transaction on the same connection.
 *
 * This is the structural half of §9's atomicity requirement — the half a
 * black-box "refuses while held" assertion cannot reach. A pre-check outside
 * the transaction would pass every other test here while still leaving the
 * check-to-act gap a concurrent `acquire()` slips through; `db.inTransaction`
 * at the moment of the lock read is what rules that implementation out.
 */
async function observeLockReadTransaction(fn) {
  const originalPrepare = Database.prototype.prepare;
  let inTransactionAtRead = null;
  const spy = jest.spyOn(Database.prototype, 'prepare').mockImplementation(function (sql, ...rest) {
    const stmt = originalPrepare.call(this, sql, ...rest);
    if (this.name === dbPath && sql.includes('FROM maintenance_lock')) {
      const db = this;
      const originalGet = stmt.get.bind(stmt);
      stmt.get = (...args) => {
        if (inTransactionAtRead === null) inTransactionAtRead = db.inTransaction;
        return originalGet(...args);
      };
    }
    return stmt;
  });
  try {
    await fn();
  } finally {
    spy.mockRestore();
  }
  return inTransactionAtRead;
}

function rawOutboxRows() {
  const raw = new Database(dbPath, { readonly: true });
  try {
    return raw.prepare('SELECT * FROM outbox ORDER BY id ASC').all();
  } finally {
    raw.close();
  }
}

// ---------------------------------------------------------------------------
// Enqueue race boundary
// ---------------------------------------------------------------------------

describe('outbox enqueue vs maintenance lock', () => {
  test('enqueue is refused while the lock is held and inserts nothing', async () => {
    const lock = holdLock();
    try {
      await expect(
        store.enqueue({ idempotencyKey: 'k1', topic: 'gh:comment', payload: COMMENT_PAYLOAD }),
      ).rejects.toMatchObject({ code: 'maintenance_locked' });

      // The refusal must be reported as an error, never as `{ enqueued: false }`
      // — that shape already means "duplicate key, safe no-op" and is ignored by
      // nearly every caller, so reusing it would silently drop the effect.
      expect(rawOutboxRows()).toHaveLength(0);
    } finally {
      lock.release();
      lock.close();
    }
  });

  test('releasing the lock restores normal enqueue', async () => {
    const lock = holdLock();
    await expect(
      store.enqueue({ idempotencyKey: 'k1', topic: 'gh:comment', payload: COMMENT_PAYLOAD }),
    ).rejects.toMatchObject({ code: 'maintenance_locked' });
    lock.release();
    lock.close();

    expect(await store.enqueue({ idempotencyKey: 'k1', topic: 'gh:comment', payload: COMMENT_PAYLOAD }))
      .toEqual({ enqueued: true });
    expect(rawOutboxRows()).toHaveLength(1);
  });

  test('replacePendingPrSummary is refused while held and deletes no pending summary', async () => {
    await store.enqueue({ idempotencyKey: 'sum-1', topic: 'repohost:pr-summary', payload: SUMMARY_PAYLOAD });

    const lock = holdLock();
    try {
      await expect(
        store.replacePendingPrSummary(
          { idempotencyKey: 'sum-2', topic: 'repohost:pr-summary', payload: { ...SUMMARY_PAYLOAD, body: 'newer' } },
          { owner: 'org', repo: 'repo', prNumber: 7, marker: '<!-- summary -->' },
        ),
      ).rejects.toMatchObject({ code: 'maintenance_locked' });

      // Both halves of this path are all-or-nothing: no insert AND no delete of
      // the row a concurrent maintenance pass may already have accounted for.
      const rows = rawOutboxRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].idempotency_key).toBe('sum-1');
    } finally {
      lock.release();
      lock.close();
    }
  });

  // Review follow-up: the batch a separately-backed phase completion writes
  // through (`OutboxStore.enqueueEffects`). Its whole point is that a lock can
  // never split the set in two — refusing the second effect after the first is
  // already durable would leave the outbox announcing a completion that was
  // handed back and will re-run.
  test('enqueueEffects refuses the whole set while held and inserts nothing', async () => {
    const effects = [
      { kind: 'enqueue', input: { idempotencyKey: 'e1', topic: 'gh:comment', payload: COMMENT_PAYLOAD } },
      { kind: 'enqueue', input: { idempotencyKey: 'e2', topic: 'gh:comment', payload: { ...COMMENT_PAYLOAD, body: 'two' } } },
      {
        kind: 'replacePendingPrSummary',
        input: { idempotencyKey: 'e3', topic: 'repohost:pr-summary', payload: SUMMARY_PAYLOAD },
        key: { owner: 'org', repo: 'repo', prNumber: 7, marker: '<!-- summary -->' },
      },
    ];

    const lock = holdLock();
    try {
      await expect(store.enqueueEffects(effects)).rejects.toMatchObject({ code: 'maintenance_locked' });
      expect(rawOutboxRows()).toHaveLength(0);
    } finally {
      lock.release();
      lock.close();
    }

    // Released: the same set lands in full.
    await store.enqueueEffects(effects);
    expect(rawOutboxRows().map((r) => r.idempotency_key)).toEqual(['e1', 'e2', 'e3']);
  });

  test('a failure part-way through an effect set rolls the whole set back', async () => {
    // A payload JSON.stringify cannot serialize makes the SECOND insert throw
    // after the first has run — the shape a per-effect loop would leave
    // half-written, and the shape one transaction must roll back entirely.
    const circular = { ...COMMENT_PAYLOAD };
    circular.self = circular;

    await expect(
      store.enqueueEffects([
        { kind: 'enqueue', input: { idempotencyKey: 'a1', topic: 'gh:comment', payload: COMMENT_PAYLOAD } },
        { kind: 'enqueue', input: { idempotencyKey: 'a2', topic: 'gh:comment', payload: circular } },
      ]),
    ).rejects.toThrow();
    expect(rawOutboxRows()).toHaveLength(0);
  });

  test('the lock read happens inside enqueueEffects\' own transaction, not as a pre-check', async () => {
    const inTransaction = await observeLockReadTransaction(() =>
      store.enqueueEffects([
        { kind: 'enqueue', input: { idempotencyKey: 'b1', topic: 'gh:comment', payload: COMMENT_PAYLOAD } },
      ]),
    );
    expect(inTransaction).toBe(true);
    expect(rawOutboxRows()).toHaveLength(1);
  });

  test('the lock read happens inside enqueue\'s own transaction, not as a pre-check', async () => {
    const inTransaction = await observeLockReadTransaction(() =>
      store.enqueue({ idempotencyKey: 'k1', topic: 'gh:comment', payload: COMMENT_PAYLOAD }),
    );
    expect(inTransaction).toBe(true);
    expect(rawOutboxRows()).toHaveLength(1);
  });

  test('isMaintenanceLocked() tracks the lock through acquire and release', async () => {
    expect(await store.isMaintenanceLocked()).toBe(false);
    const lock = holdLock();
    expect(await store.isMaintenanceLocked()).toBe(true);
    lock.release();
    lock.close();
    expect(await store.isMaintenanceLocked()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Claim race boundary
// ---------------------------------------------------------------------------

describe('outbox claim vs maintenance lock', () => {
  test('claimForDispatch refuses while held, leaves the row unclaimed and pending', async () => {
    await store.enqueue({ idempotencyKey: 'k1', topic: 'gh:comment', payload: COMMENT_PAYLOAD });
    const [row] = rawOutboxRows();

    const lock = holdLock();
    try {
      expect(await store.claimForDispatch(row.id, '2026-01-01T00:00:05.000Z')).toBe(false);
      expect(rawOutboxRows()[0].claimed_at).toBeNull();
      // Refusing a claim must not resolve the row: it stays dispatch-eligible
      // for the run that happens after maintenance releases the lock.
      expect(await store.listPending()).toHaveLength(1);
    } finally {
      lock.release();
      lock.close();
    }

    expect(await store.claimForDispatch(row.id, '2026-01-01T00:00:06.000Z')).toBe(true);
    expect(rawOutboxRows()[0].claimed_at).toBe('2026-01-01T00:00:06.000Z');
  });

  test('the lock read happens inside claimForDispatch\'s own transaction, not as a pre-check', async () => {
    await store.enqueue({ idempotencyKey: 'k1', topic: 'gh:comment', payload: COMMENT_PAYLOAD });
    const [row] = rawOutboxRows();

    let claimed;
    const inTransaction = await observeLockReadTransaction(async () => {
      claimed = await store.claimForDispatch(row.id, '2026-01-01T00:00:05.000Z');
    });
    expect(inTransaction).toBe(true);
    expect(claimed).toBe(true);
  });

  test('the exclusion holds in the other order too: a live claim refuses acquisition', async () => {
    await store.enqueue({ idempotencyKey: 'k1', topic: 'gh:comment', payload: COMMENT_PAYLOAD });
    const [row] = rawOutboxRows();
    expect(await store.claimForDispatch(row.id, '2026-01-01T00:00:00.000Z')).toBe(true);

    // Together with the test above this is what makes claim and acquisition
    // mutually exclusive rather than merely ordered: whichever transaction
    // commits first, the other observes it and refuses.
    const lock = new SqliteMaintenanceLock(dbPath);
    try {
      const acquired = lock.acquire('prune:1234', '2026-01-01T00:00:01.000Z');
      expect(acquired).toMatchObject({ ok: false, reason: 'outbox_claim_active', activeCount: 1 });
    } finally {
      lock.close();
    }
  });

  test('markSent and markFailed stay available while held — they resolve an already-claimed attempt', async () => {
    await store.enqueue({ idempotencyKey: 'k1', topic: 'gh:comment', payload: COMMENT_PAYLOAD });
    await store.enqueue({ idempotencyKey: 'k2', topic: 'gh:comment', payload: COMMENT_PAYLOAD });
    const [first, second] = rawOutboxRows();

    const lock = holdLock();
    try {
      // Deliberately NOT guarded (see stores/maintenance-lock-guard.ts): these
      // record the outcome of an attempt claimed before the lock existed, whose
      // external side effect may already have been published. Refusing them
      // would strand the row or let a concurrent dispatcher duplicate the
      // effect, protecting nothing.
      expect(await store.markSent(first.id, '2026-01-01T00:00:05.000Z')).toEqual({ updated: true });
      expect(await store.markFailed(second.id, 'boom', '2026-01-01T00:00:05.000Z')).toEqual({ deadLettered: false });
    } finally {
      lock.release();
      lock.close();
    }

    const rows = rawOutboxRows();
    expect(rows[0].sent_at).toBe('2026-01-01T00:00:05.000Z');
    expect(rows[1].attempt_count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Operator row mutations
// ---------------------------------------------------------------------------

describe('operator outbox mutations vs maintenance lock', () => {
  test('retryEntry refuses with a typed reason and revives nothing', async () => {
    await store.enqueue({ idempotencyKey: 'k1', topic: 'gh:comment', payload: COMMENT_PAYLOAD });
    const [row] = rawOutboxRows();
    await store.cancelEntry(row.id, '2026-01-01T00:00:00.000Z');

    const lock = holdLock('prune:1234', '2026-01-01T00:00:01.000Z');
    try {
      expect(await store.retryEntry(row.id, '2026-01-01T00:00:02.000Z')).toEqual({
        retried: false,
        reason: 'maintenance_locked',
      });
      const after = rawOutboxRows()[0];
      expect(after.cancelled_at).not.toBeNull();
      expect(after.dead_letter_at).not.toBeNull();
    } finally {
      lock.release();
      lock.close();
    }

    expect(await store.retryEntry(row.id, '2026-01-01T00:00:03.000Z')).toEqual({ retried: true });
  });

  test('cancelEntry refuses with a typed reason and dead-letters nothing', async () => {
    await store.enqueue({ idempotencyKey: 'k1', topic: 'gh:comment', payload: COMMENT_PAYLOAD });
    const [row] = rawOutboxRows();

    const lock = holdLock();
    try {
      expect(await store.cancelEntry(row.id, '2026-01-01T00:00:02.000Z')).toEqual({
        cancelled: false,
        reason: 'maintenance_locked',
      });
      const after = rawOutboxRows()[0];
      expect(after.cancelled_at).toBeNull();
      expect(after.dead_letter_at).toBeNull();
    } finally {
      lock.release();
      lock.close();
    }

    expect(await store.cancelEntry(row.id, '2026-01-01T00:00:03.000Z')).toEqual({ cancelled: true });
  });
});

// ---------------------------------------------------------------------------
// Scan-cursor writes
// ---------------------------------------------------------------------------

describe('outbox scan cursor vs maintenance lock', () => {
  test('setScanCursor refuses while held and persists nothing', async () => {
    await store.setScanCursor('session-a', 5);

    const lock = holdLock();
    try {
      expect(await store.setScanCursor('session-a', 42)).toEqual({ persisted: false });
      // The cursor table lives in the maintained database, so a write here is
      // a write into a file a restore may be replacing. Refusing leaves the
      // last complete run's value intact rather than a partial run's.
      expect(await store.getScanCursor('session-a')).toBe(5);
    } finally {
      lock.release();
      lock.close();
    }

    expect(await store.setScanCursor('session-a', 42)).toEqual({ persisted: true });
    expect(await store.getScanCursor('session-a')).toBe(42);
  });

  test('the lock read happens inside setScanCursor\'s own transaction, not as a pre-check', async () => {
    let outcome;
    const inTransaction = await observeLockReadTransaction(async () => {
      outcome = await store.setScanCursor('session-a', 7);
    });
    expect(inTransaction).toBe(true);
    expect(outcome).toEqual({ persisted: true });
  });
});

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

describe('dispatchOutbox vs maintenance lock', () => {
  test('fails closed before any external side effect and reports maintenanceLocked', async () => {
    await store.enqueue({ idempotencyKey: 'k1', topic: 'gh:comment', payload: COMMENT_PAYLOAD });

    let runnerResolved = false;
    const runner = () => {
      runnerResolved = true;
      return Promise.resolve({ run: () => ({ exitCode: 0, stdout: '', stderr: '' }) });
    };

    const lock = holdLock();
    try {
      const result = await dispatchOutbox(store, runner, { cwd: tmpDir, now: '2026-01-01T00:00:05.000Z' });
      expect(result).toEqual({
        dispatched: 0,
        failed: 0,
        errors: [],
        deadLettered: 0,
        maintenanceLocked: true,
      });
      // No provider request, no comment, not even a credential resolution.
      expect(runnerResolved).toBe(false);
      expect(rawOutboxRows()[0].claimed_at).toBeNull();
      expect(await store.listPending()).toHaveLength(1);
    } finally {
      lock.release();
      lock.close();
    }
  });

  test('a lock acquired mid-drain stops the run; already-dispatched rows keep their outcome', async () => {
    await store.enqueue({ idempotencyKey: 'k1', topic: 'gh:comment', payload: COMMENT_PAYLOAD });
    await store.enqueue({ idempotencyKey: 'k2', topic: 'gh:comment', payload: COMMENT_PAYLOAD });

    // A maintenance pass can legitimately take the lock part-way through a
    // drain — this is the `admin archive rollup` shape (`skipActivityChecks`),
    // which by design does not refuse merely because an outbox claim is in
    // flight, so it can land at any point including mid-attempt. From that
    // moment every further `claimForDispatch` refuses via its own
    // in-transaction check, which is the interleaving this test pins.
    let lock;
    let calls = 0;
    const runner = {
      run: () => {
        calls++;
        if (calls === 1) {
          lock = holdLock('archive-rollup:9999', '2026-01-01T00:00:01.000Z', { skipActivityChecks: true });
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    };

    try {
      const result = await dispatchOutbox(store, runner, { cwd: tmpDir });
      expect(result).toMatchObject({ dispatched: 1, failed: 0, maintenanceLocked: true });
      expect(calls).toBe(1);

      const rows = rawOutboxRows();
      expect(rows[0].sent_at).not.toBeNull();
      expect(rows[1].sent_at).toBeNull();
      expect(rows[1].claimed_at).toBeNull();
    } finally {
      if (lock) {
        lock.release();
        lock.close();
      }
    }

    // Once released, the untouched row drains normally.
    const result = await dispatchOutbox(store, { run: () => ({ exitCode: 0, stdout: '', stderr: '' }) }, { cwd: tmpDir });
    expect(result).toEqual({ dispatched: 1, failed: 0, errors: [], deadLettered: 0 });
  });

  test('a lock acquired after the last claim resolved still blocks the cursor writes', async () => {
    // The gap the in-loop `maintenanceLocked` flag cannot see: the lock lands
    // once every claim of this drain has already been resolved, so the loop
    // never observes a refused claim and reaches cursor persistence with the
    // flag still false. `setScanCursor` is an ordinary write into the
    // maintained database, so it must refuse in-transaction (issue #818 review
    // follow-up) rather than write behind a restore.
    const FOREIGN = { ...COMMENT_PAYLOAD, owner: 'other' };
    await store.enqueue({ idempotencyKey: 'foreign-0', topic: 'gh:comment', payload: FOREIGN });
    await store.enqueue({ idempotencyKey: 'mine-0', topic: 'gh:comment', payload: COMMENT_PAYLOAD });
    const filter = (entry) => entry.payload.owner === COMMENT_PAYLOAD.owner;

    let lock;
    const runner = {
      run: () => {
        // Taken during the only dispatch, i.e. after the final
        // `claimForDispatch` already succeeded — `markSent` still records the
        // published effect (never guarded), and the loop then ends with no
        // further claim to refuse.
        lock = holdLock('archive-rollup:9999', '2026-01-01T00:00:01.000Z', { skipActivityChecks: true });
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    };

    try {
      const result = await dispatchOutbox(store, runner, {
        cwd: tmpDir,
        filter,
        scanCursorKey: 'session-cursor',
      });
      expect(result).toMatchObject({ dispatched: 1, failed: 0, maintenanceLocked: true });

      // Neither the floor cursor nor either derived (`fwd`/`bulk`) cursor was
      // written: the first refusal stops the rest of the block too.
      expect(await store.getScanCursor('session-cursor')).toBeUndefined();
      expect(await store.getScanCursor('14:session-cursor:fwd')).toBeUndefined();
      expect(await store.getScanCursor('14:session-cursor:bulk')).toBeUndefined();
      expect(rawOutboxRows()[1].sent_at).not.toBeNull();
    } finally {
      if (lock) {
        lock.release();
        lock.close();
      }
    }

    // Releasing restores normal cursor persistence: the next run confirms the
    // foreign row and records it, exactly as an unlocked run always would.
    const after = await dispatchOutbox(store, { run: () => { throw new Error('must not dispatch'); } }, {
      cwd: tmpDir,
      filter,
      scanCursorKey: 'session-cursor',
    });
    expect(after).toEqual({ dispatched: 0, failed: 0, errors: [], deadLettered: 0 });
    expect(await store.getScanCursor('session-cursor')).toBe(1);
  });

  test('a normal run reports no maintenanceLocked key at all', async () => {
    await store.enqueue({ idempotencyKey: 'k1', topic: 'gh:comment', payload: COMMENT_PAYLOAD });
    const result = await dispatchOutbox(
      store,
      { run: () => ({ exitCode: 0, stdout: '', stderr: '' }) },
      { cwd: tmpDir },
    );
    expect(result).toEqual({ dispatched: 1, failed: 0, errors: [], deadLettered: 0 });
    expect('maintenanceLocked' in result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// End-to-end: a phase whose completion meets a lock taken mid-run
// ---------------------------------------------------------------------------

const SESSION = {
  sessionId: 'addon-dev',
  repoKey: 'test-repo',
  repoRoot: '/tmp/test-repo',
  githubRepo: 'org/repo',
  artifactDir: '.artifacts',
  artifactRoot: '/tmp/test-repo/.artifacts',
  githubOwner: 'org',
  githubName: 'repo',
  defaults: { implementationAgent: 'claude', reviewAgent: 'codex' },
  verification: {},
  labels: { active: 'ai:active', blocked: 'ai:blocked', readyForHuman: 'ai:ready-for-human' },
  workItemProvider: { provider: 'github-issues', auth: { mode: 'gh' } },
  repoHostProvider: { provider: 'github', auth: { mode: 'gh' } },
};

describe('runNextPhase vs maintenance lock', () => {
  test('a lock taken during the phase makes the completion report maintenance_locked and write nothing', async () => {
    const taskStore = new SqliteTaskStore(dbPath);
    let lock;
    try {
      await taskStore.enqueueTask({
        sessionId: 'addon-dev',
        issueNumber: 42,
        phase: 'implementation',
        now: '2026-01-01T00:00:00.000Z',
      });

      // Maintenance starts while the phase is executing. `skipActivityChecks`
      // is the `admin archive rollup` shape — the one acquisition that does not
      // refuse merely because a phase is live, so it can land right here.
      const handler = async () => {
        lock = holdLock('archive-rollup:7', '2026-01-01T00:00:30.000Z', { skipActivityChecks: true });
        return { result: 'success', context: { prUrl: 'https://github.com/org/repo/pull/5' } };
      };

      const outcome = await runNextPhase({
        store: taskStore,
        request: { sessionId: 'addon-dev', workerId: 'w1', runId: 'run-1', now: '2026-01-01T00:00:10.000Z' },
        handlers: { implementation: handler },
        outboxStore: store,
        session: SESSION,
        now: '2026-01-01T00:00:10.000Z',
      });

      // Refused in full: the #701 transaction commits the transition, its
      // event, and every effect together — or none of them.
      expect(outcome.status).toBe('maintenance_locked');
      const task = await taskStore.getTask({ sessionId: 'addon-dev', issueNumber: 42 });
      expect(rawOutboxRows()).toHaveLength(0);

      // Review follow-up: the runner tries to hand the claim back, but through
      // `completePhaseWithEffects` — the one interface transition that reads the
      // lock inside its own transaction. Here the lock is on the task store's
      // OWN database, so that requeue is refused too and the task stays
      // `running`: writing it anyway (a bare, unguarded `transitionTask`) would
      // push a row into a file `restore` is replacing, losing the write with the
      // file and breaking the exclusion the lock exists to provide. Recovery
      // belongs to the post-maintenance mechanisms — lease expiry and
      // `admin task recover`.
      expect(task.status).toBe('running');
      expect(task.ownerRunId).toBe('run-1');
      // Refused in full means refused for the requeue too: no event, no
      // attempt-count change, nothing at all written under the lock.
      expect(task.attempts.implementation ?? 0).toBe(1);
      expect((await taskStore.listEvents({ sessionId: 'addon-dev', issueNumber: 42 }))
        .some((e) => e.type === 'phase.maintenance_requeued')).toBe(false);
      expect(outcome.task.status).toBe('running');
    } finally {
      if (lock) {
        lock.release();
        lock.close();
      }
      taskStore.close();
    }
  });

  // Review follow-up: the separate-backend pairing runNextPhase explicitly
  // supports (a task store that is NOT the outbox's database). There is no
  // shared transaction to lean on, so the effects must be written to the outbox
  // store on their own — and that write is ordered BEFORE the transition, so
  // the refusal a held lock raises lands while the task has not moved. The
  // earlier ordering (commit, then replay behind a pre-check) could not do
  // this: a lock acquired after the pre-check made the replay throw with the
  // task already `completed` and its comments/labels unrecoverable.
  test('a separately-backed outbox store under maintenance defers the completion instead of dropping its effects', async () => {
    const memoryStore = new MemoryTaskStore();
    await memoryStore.enqueueTask({
      sessionId: 'addon-dev', issueNumber: 55, phase: 'implementation', now: '2026-01-01T00:00:00.000Z',
    });

    const lock = holdLock('restore:4242', '2026-01-01T00:00:05.000Z');
    try {
      const outcome = await runNextPhase({
        store: memoryStore,
        request: { sessionId: 'addon-dev', workerId: 'w1', runId: 'run-2', now: '2026-01-01T00:00:10.000Z' },
        handlers: {
          implementation: async () => ({ result: 'success', context: { prUrl: 'https://github.com/org/repo/pull/5' } }),
        },
        outboxStore: store,
        session: SESSION,
        now: '2026-01-01T00:00:10.000Z',
      });

      expect(outcome.status).toBe('maintenance_locked');
      // The in-memory task store has no maintenance lock of its own, so the
      // effect write meeting the lock is the ONLY thing standing between this
      // task and a completion whose effects were dropped.
      const task = await memoryStore.getTask({ sessionId: 'addon-dev', issueNumber: 55 });
      expect(task.status).toBe('queued');
      expect(task.ownerRunId).toBeUndefined();
      expect(rawOutboxRows()).toHaveLength(0);
    } finally {
      lock.release();
      lock.close();
    }
  });

  // The acquire/enqueue race the pre-check version could not survive: the lock
  // lands DURING the phase — i.e. after any pre-completion read would have seen
  // an unlocked outbox — and the effect write is still refused, with the task
  // left retryable rather than completed-and-effectless. Only an in-transaction
  // guard on the enqueue itself (reached before the transition) can hold this.
  test('a lock acquired mid-phase still refuses a separately-backed outbox write, with nothing completed', async () => {
    const memoryStore = new MemoryTaskStore();
    await memoryStore.enqueueTask({
      sessionId: 'addon-dev', issueNumber: 57, phase: 'implementation', now: '2026-01-01T00:00:00.000Z',
    });

    let lock;
    try {
      const outcome = await runNextPhase({
        store: memoryStore,
        request: { sessionId: 'addon-dev', workerId: 'w1', runId: 'run-4', now: '2026-01-01T00:00:10.000Z' },
        handlers: {
          implementation: async () => {
            // Mid-run acquisition, the `admin archive rollup` shape.
            lock = holdLock('archive-rollup:11', '2026-01-01T00:00:30.000Z', { skipActivityChecks: true });
            return { result: 'success', context: { prUrl: 'https://github.com/org/repo/pull/5' } };
          },
        },
        outboxStore: store,
        session: SESSION,
        now: '2026-01-01T00:00:10.000Z',
      });

      expect(outcome.status).toBe('maintenance_locked');
      const task = await memoryStore.getTask({ sessionId: 'addon-dev', issueNumber: 57 });
      expect(task.status).toBe('queued');
      expect(task.phase).toBe('implementation');
      expect(rawOutboxRows()).toHaveLength(0);
    } finally {
      if (lock) {
        lock.release();
        lock.close();
      }
    }

    // Released: the same phase re-runs intact and its effects land.
    const rerun = await runNextPhase({
      store: memoryStore,
      request: { sessionId: 'addon-dev', workerId: 'w1', runId: 'run-5', now: '2026-01-01T00:01:00.000Z' },
      handlers: {
        implementation: async () => ({ result: 'success', context: { prUrl: 'https://github.com/org/repo/pull/5' } }),
      },
      outboxStore: store,
      session: SESSION,
      now: '2026-01-01T00:01:00.000Z',
    });
    expect(rerun.status).toBe('completed');
    expect(rawOutboxRows().length).toBeGreaterThan(0);
  });

  // The shared-backend pairing must NOT get that pre-transition write: its
  // effects are already covered by `completePhaseWithEffects`'s transaction, so
  // writing them early would put outbox rows in front of a transition that can
  // still fail its CAS — precisely the divergence #701 exists to prevent. A
  // completion whose task was cancelled mid-phase (issue #608's `claim_lost`
  // no-op) is where that would show up.
  test('a shared-backend pairing writes no effects when the completion loses its CAS', async () => {
    const taskStore = new SqliteTaskStore(dbPath);
    try {
      await taskStore.enqueueTask({
        sessionId: 'addon-dev', issueNumber: 58, phase: 'implementation', now: '2026-01-01T00:00:00.000Z',
      });

      const outcome = await runNextPhase({
        store: taskStore,
        request: { sessionId: 'addon-dev', workerId: 'w1', runId: 'run-6', now: '2026-01-01T00:00:10.000Z' },
        handlers: {
          implementation: async () => {
            await taskStore.cancelTask({ sessionId: 'addon-dev', issueNumber: 58 }, { now: '2026-01-01T00:00:20.000Z' });
            return { result: 'success', context: { prUrl: 'https://github.com/org/repo/pull/5' } };
          },
        },
        outboxStore: store,
        session: SESSION,
        now: '2026-01-01T00:00:10.000Z',
      });

      expect(outcome.status).toBe('claim_lost');
      expect(rawOutboxRows()).toHaveLength(0);
    } finally {
      taskStore.close();
    }
  });

  // Review follow-up: the separately-backed write must reach the outbox as ONE
  // transaction, so there is no interleaving in which a lock acquired mid-set
  // leaves earlier effects behind while the completion is handed back.
  test('a separately-backed completion writes its effects through the atomic effect-set API', async () => {
    const memoryStore = new MemoryTaskStore();
    await memoryStore.enqueueTask({
      sessionId: 'addon-dev', issueNumber: 59, phase: 'implementation', now: '2026-01-01T00:00:00.000Z',
    });

    const singleWrites = [];
    const effectSets = [];
    const recordingOutbox = {
      async enqueue(input) {
        singleWrites.push(input.idempotencyKey);
        return store.enqueue(input);
      },
      async replacePendingPrSummary(input, key) {
        singleWrites.push(input.idempotencyKey);
        return store.replacePendingPrSummary(input, key);
      },
      async enqueueEffects(effects) {
        effectSets.push(effects.map((e) => e.input.idempotencyKey));
        return store.enqueueEffects(effects);
      },
    };

    const outcome = await runNextPhase({
      store: memoryStore,
      request: { sessionId: 'addon-dev', workerId: 'w1', runId: 'run-7', now: '2026-01-01T00:00:10.000Z' },
      handlers: {
        implementation: async () => ({ result: 'success', context: { prUrl: 'https://github.com/org/repo/pull/5' } }),
      },
      outboxStore: recordingOutbox,
      session: SESSION,
      now: '2026-01-01T00:00:10.000Z',
    });

    expect(outcome.status).toBe('completed');
    // One batched call covering every effect — never an effect-at-a-time loop,
    // which is where a partially written set becomes possible.
    expect(effectSets).toHaveLength(1);
    expect(effectSets[0].length).toBeGreaterThan(0);
    expect(singleWrites).toEqual([]);
    expect(rawOutboxRows().map((r) => r.idempotency_key).sort())
      .toEqual([...new Set(effectSets[0])].sort());
  });

  // The fallback for a store with no transaction to offer: a refusal that lands
  // mid-set has already made rows durable for this completion, so handing the
  // claim back is no longer the clean retry `maintenance_locked` advertises —
  // the dispatcher would publish those rows for a phase that never committed.
  // The completion commits instead, and the shortfall is recorded.
  test('a mid-set refusal on a store that cannot batch commits the completion instead of reporting a retry', async () => {
    const memoryStore = new MemoryTaskStore();
    await memoryStore.enqueueTask({
      sessionId: 'addon-dev', issueNumber: 60, phase: 'implementation', now: '2026-01-01T00:00:00.000Z',
    });

    let writes = 0;
    const refuseAfterFirst = async (write) => {
      writes += 1;
      if (writes > 1) throw new MaintenanceLockedError('outbox enqueue');
      return write();
    };
    const legacyOutbox = {
      async enqueue(input) {
        return refuseAfterFirst(() => store.enqueue(input));
      },
      async replacePendingPrSummary(input, key) {
        return refuseAfterFirst(() => store.replacePendingPrSummary(input, key));
      },
    };

    const outcome = await runNextPhase({
      store: memoryStore,
      request: { sessionId: 'addon-dev', workerId: 'w1', runId: 'run-8', now: '2026-01-01T00:00:10.000Z' },
      handlers: {
        implementation: async () => ({ result: 'success', context: { prUrl: 'https://github.com/org/repo/pull/5' } }),
      },
      outboxStore: legacyOutbox,
      session: SESSION,
      now: '2026-01-01T00:00:10.000Z',
    });

    // Guard on the premise: the completion really did produce more than one
    // effect, so the refusal landed mid-set rather than before the first write.
    expect(writes).toBeGreaterThan(1);
    expect(outcome.status).toBe('completed');
    expect(rawOutboxRows()).toHaveLength(1);
    const events = await memoryStore.listEvents({ sessionId: 'addon-dev', issueNumber: 60 });
    expect(events.some((e) => e.type === 'outbox.enqueue.failed')).toBe(true);
  });

  // Positive control for the test above: with no lock held, the same
  // separately-backed pairing completes and its effects really do land in the
  // outbox store via the replay — so the refusal above is the guard acting, not
  // a pairing that never wrote anything in the first place.
  test('the same separately-backed pairing completes and replays its effects once no lock is held', async () => {
    const memoryStore = new MemoryTaskStore();
    await memoryStore.enqueueTask({
      sessionId: 'addon-dev', issueNumber: 56, phase: 'implementation', now: '2026-01-01T00:00:00.000Z',
    });

    const outcome = await runNextPhase({
      store: memoryStore,
      request: { sessionId: 'addon-dev', workerId: 'w1', runId: 'run-3', now: '2026-01-01T00:00:10.000Z' },
      handlers: {
        implementation: async () => ({ result: 'success', context: { prUrl: 'https://github.com/org/repo/pull/5' } }),
      },
      outboxStore: store,
      session: SESSION,
      now: '2026-01-01T00:00:10.000Z',
    });

    expect(outcome.status).toBe('completed');
    expect(rawOutboxRows().length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Transactional phase completion (issue #701) under the lock
// ---------------------------------------------------------------------------

describe('completePhaseWithEffects / cancelTaskWithEffects vs maintenance lock', () => {
  let taskStore;

  beforeEach(() => {
    taskStore = new SqliteTaskStore(dbPath);
  });

  afterEach(() => {
    taskStore.close();
  });

  async function enqueueRunning(issueNumber) {
    await taskStore.enqueueTask({
      sessionId: 'addon-dev', issueNumber, phase: 'implementation', now: '2026-01-01T00:00:00.000Z',
    });
    await taskStore.claimNextTask({
      sessionId: 'addon-dev', workerId: 'w', runId: 'run-1', now: '2026-01-01T00:00:01.000Z',
    });
    await taskStore.transitionTask(
      { sessionId: 'addon-dev', issueNumber },
      { status: 'claimed' },
      { status: 'running', now: '2026-01-01T00:00:02.000Z' },
    );
  }

  const completion = (issueNumber) => [
    {
      key: { sessionId: 'addon-dev', issueNumber },
      expected: { status: 'running', phase: 'implementation', ownerRunId: 'run-1' },
      patch: { status: 'ready_for_human', ownerRunId: undefined, leaseExpiresAt: undefined, now: '2026-01-01T00:01:00.000Z' },
      event: {
        task: { sessionId: 'addon-dev', issueNumber },
        type: 'phase.completed',
        runId: 'run-1',
        createdAt: '2026-01-01T00:01:00.000Z',
      },
    },
    [
      {
        kind: 'enqueue',
        input: {
          idempotencyKey: `addon-dev:${issueNumber}:run-1:gh:comment`,
          topic: 'gh:comment',
          payload: { ...COMMENT_PAYLOAD, issueNumber },
        },
      },
    ],
  ];

  test('refuses the whole completion — no transition, no event, no effect', async () => {
    await enqueueRunning(300);
    // A completion can only meet a held lock once its lease has expired
    // (`acquire()` refuses while a phase is live), so release the claim's lease
    // by acquiring well past it.
    const lock = holdLock('restore:4242', '2026-01-02T00:00:00.000Z');
    try {
      const result = await taskStore.completePhaseWithEffects(...completion(300));
      expect(result).toEqual({ ok: false, code: 'maintenance_locked' });

      const task = await taskStore.getTask({ sessionId: 'addon-dev', issueNumber: 300 });
      expect(task.status).toBe('running');
      const events = await taskStore.listEvents({ sessionId: 'addon-dev', issueNumber: 300 });
      expect(events.filter((e) => e.type === 'phase.completed')).toHaveLength(0);
      expect(rawOutboxRows()).toHaveLength(0);
    } finally {
      lock.release();
      lock.close();
    }

    // The same call commits intact once maintenance releases the lock — the
    // #701 guarantee is preserved, not weakened, by the guard.
    const after = await taskStore.completePhaseWithEffects(...completion(300));
    expect(after.ok).toBe(true);
    expect(after.value.status).toBe('ready_for_human');
    expect(rawOutboxRows()).toHaveLength(1);
  });

  // Review follow-up: the generic transition+effects commit operator commands
  // use for their compound task-and-effect writes (admin's fix-mode requeue and
  // review-verification requeue). Before it existed those commands transitioned
  // the task and THEN enqueued their labels/comment through a second
  // connection, so a held lock aborted them mid-sequence — task moved, lane
  // labels never queued.
  test('transitionTaskWithEffects refuses the transition AND its effects together', async () => {
    await enqueueRunning(302);
    const effects = [
      {
        kind: 'enqueue',
        input: {
          idempotencyKey: 'addon-dev:302:requeue:gh:label:add',
          topic: 'gh:label:add',
          payload: { topic: 'gh:label:add', owner: 'org', repo: 'repo', issueNumber: 302, label: 'status:needs-fix' },
        },
      },
    ];
    const args = () => [
      { sessionId: 'addon-dev', issueNumber: 302 },
      { status: 'running' },
      { status: 'queued', phase: 'implementation', ownerRunId: undefined, leaseExpiresAt: undefined, now: '2026-01-02T00:00:01.000Z' },
      effects,
    ];

    const lock = holdLock('prune:99', '2026-01-02T00:00:00.000Z');
    try {
      const result = await taskStore.transitionTaskWithEffects(...args());
      expect(result).toEqual({ ok: false, code: 'maintenance_locked' });
      // Neither half landed: the task is exactly where it was, and no label row
      // exists to be dispatched at a repo that never heard about the move.
      const task = await taskStore.getTask({ sessionId: 'addon-dev', issueNumber: 302 });
      expect(task.status).toBe('running');
      expect(rawOutboxRows()).toHaveLength(0);
    } finally {
      lock.release();
      lock.close();
    }

    // Repeatable: the identical call commits both halves once the lock clears.
    const after = await taskStore.transitionTaskWithEffects(...args());
    expect(after.ok).toBe(true);
    expect(after.value.status).toBe('queued');
    expect(rawOutboxRows()).toHaveLength(1);
  });

  test('transitionTaskWithEffects reads the lock inside its own transaction, not as a pre-check', async () => {
    await enqueueRunning(303);
    const inTransaction = await observeLockReadTransaction(() =>
      taskStore.transitionTaskWithEffects(
        { sessionId: 'addon-dev', issueNumber: 303 },
        { status: 'running' },
        { status: 'queued', phase: 'implementation', now: '2026-01-02T00:00:01.000Z' },
        [],
      ),
    );
    expect(inTransaction).toBe(true);
  });

  test('cancelTaskWithEffects refuses in full so the operator can simply re-run it', async () => {
    await enqueueRunning(301);
    const event = {
      task: { sessionId: 'addon-dev', issueNumber: 301 },
      type: 'task.cancelled',
      runId: 'run-1',
      createdAt: '2026-01-02T00:00:01.000Z',
    };
    const effects = [
      {
        kind: 'enqueue',
        input: {
          idempotencyKey: 'addon-dev:301:cancel:gh:comment',
          topic: 'gh:comment',
          payload: { ...COMMENT_PAYLOAD, issueNumber: 301 },
        },
      },
    ];

    const lock = holdLock('restore:4242', '2026-01-02T00:00:00.000Z');
    try {
      const result = await taskStore.cancelTaskWithEffects(
        { sessionId: 'addon-dev', issueNumber: 301 },
        { reason: 'operator', now: '2026-01-02T00:00:01.000Z' },
        event,
        effects,
      );
      expect(result).toEqual({ ok: false, code: 'maintenance_locked' });
      const task = await taskStore.getTask({ sessionId: 'addon-dev', issueNumber: 301 });
      expect(task.status).toBe('running');
      expect(rawOutboxRows()).toHaveLength(0);
    } finally {
      lock.release();
      lock.close();
    }

    const after = await taskStore.cancelTaskWithEffects(
      { sessionId: 'addon-dev', issueNumber: 301 },
      { reason: 'operator', now: '2026-01-02T00:00:02.000Z' },
      event,
      effects,
    );
    expect(after.ok).toBe(true);
    expect(after.value.status).toBe('cancelled');
    expect(rawOutboxRows()).toHaveLength(1);
  });
});
