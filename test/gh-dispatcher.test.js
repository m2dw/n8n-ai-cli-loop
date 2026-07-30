import { jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SqliteOutboxStore } from '../dist/stores/sqlite-outbox-store.js';
import { dispatchOutbox } from '../dist/handlers/gh-dispatcher.js';

let tmpDir;
let dbPath;
let store;

const CWD = '/tmp';

const COMMENT = {
  topic: 'gh:comment',
  owner: 'org',
  repo: 'repo',
  issueNumber: 10,
  body: 'test body',
};

const LABEL_ADD = {
  topic: 'gh:label:add',
  owner: 'org',
  repo: 'repo',
  issueNumber: 10,
  label: 'ai:active',
};

const LABEL_REMOVE = {
  topic: 'gh:label:remove',
  owner: 'org',
  repo: 'repo',
  issueNumber: 10,
  label: 'ai:blocked',
};

function makeRunner(results) {
  // results: array of { exitCode, stdout, stderr } consumed in order
  let idx = 0;
  return {
    run(_args, _opts) {
      if (idx >= results.length) throw new Error('Unexpected gh runner call');
      return results[idx++];
    },
    callCount: () => idx,
  };
}

function okResult() { return { exitCode: 0, stdout: '', stderr: '' }; }
function failResult(stderr = 'error') { return { exitCode: 1, stdout: '', stderr }; }

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'gh-dispatcher-test-'));
  dbPath = join(tmpDir, 'test.db');
  store = new SqliteOutboxStore(dbPath);
});

afterEach(() => {
  store.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('dispatchOutbox — comment', () => {
  test('dispatches a comment entry and marks it sent', async () => {
    await store.enqueue({ idempotencyKey: 'k1', topic: 'gh:comment', payload: COMMENT });
    const runner = makeRunner([okResult()]);
    const result = await dispatchOutbox(store, runner, { cwd: CWD });
    expect(result.dispatched).toBe(1);
    expect(result.failed).toBe(0);
    expect(await store.listPending()).toHaveLength(0);
  });

  test('passes correct gh api args for comment', async () => {
    await store.enqueue({ idempotencyKey: 'k1', topic: 'gh:comment', payload: COMMENT });
    let calledArgs;
    const runner = {
      run(args) { calledArgs = args; return okResult(); },
    };
    await dispatchOutbox(store, runner, { cwd: CWD });
    expect(calledArgs).toEqual([
      'api',
      'repos/org/repo/issues/10/comments',
      '--method', 'POST',
      '--field', 'body=test body',
    ]);
  });
});

describe('dispatchOutbox — labels', () => {
  test('dispatches label:add entry', async () => {
    await store.enqueue({ idempotencyKey: 'la', topic: 'gh:label:add', payload: LABEL_ADD });
    const runner = makeRunner([okResult()]);
    const result = await dispatchOutbox(store, runner, { cwd: CWD });
    expect(result.dispatched).toBe(1);
    expect(await store.listPending()).toHaveLength(0);
  });

  test('passes correct gh api args for label:add', async () => {
    await store.enqueue({ idempotencyKey: 'la', topic: 'gh:label:add', payload: LABEL_ADD });
    let calledArgs;
    const runner = { run(args) { calledArgs = args; return okResult(); } };
    await dispatchOutbox(store, runner, { cwd: CWD });
    expect(calledArgs).toEqual([
      'api',
      'repos/org/repo/issues/10/labels',
      '--method', 'POST',
      '--field', 'labels[]=ai:active',
    ]);
  });

  test('dispatches label:remove entry', async () => {
    await store.enqueue({ idempotencyKey: 'lr', topic: 'gh:label:remove', payload: LABEL_REMOVE });
    const runner = makeRunner([okResult()]);
    const result = await dispatchOutbox(store, runner, { cwd: CWD });
    expect(result.dispatched).toBe(1);
    expect(await store.listPending()).toHaveLength(0);
  });

  test('label:remove treats 404 as ok (label already absent)', async () => {
    await store.enqueue({ idempotencyKey: 'lr', topic: 'gh:label:remove', payload: LABEL_REMOVE });
    const runner = makeRunner([{ exitCode: 1, stdout: '', stderr: '404 not found' }]);
    const result = await dispatchOutbox(store, runner, { cwd: CWD });
    expect(result.dispatched).toBe(1);
    expect(result.failed).toBe(0);
  });
});

describe('dispatchOutbox — failure and retry', () => {
  test('failed dispatch leaves entry as pending (retryable)', async () => {
    await store.enqueue({ idempotencyKey: 'k1', topic: 'gh:comment', payload: COMMENT });
    const runner = makeRunner([failResult('server error')]);
    const result = await dispatchOutbox(store, runner, { cwd: CWD });
    expect(result.dispatched).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.errors[0].error).toContain('exit 1');
    // Entry still pending
    expect(await store.listPending()).toHaveLength(1);
  });

  test('partial failure: success first, fail second', async () => {
    await store.enqueue({ idempotencyKey: 'k1', topic: 'gh:comment', payload: COMMENT });
    await store.enqueue({ idempotencyKey: 'k2', topic: 'gh:comment', payload: { ...COMMENT, body: 'b2' } });
    const runner = makeRunner([okResult(), failResult()]);
    const result = await dispatchOutbox(store, runner, { cwd: CWD });
    expect(result.dispatched).toBe(1);
    expect(result.failed).toBe(1);
    expect(await store.listPending()).toHaveLength(1);
  });
});

describe('dispatchOutbox — backoff and dead-letter (issue #606)', () => {
  test('a failed row is not retried again before its backoff delay elapses', async () => {
    await store.enqueue({ idempotencyKey: 'k1', topic: 'gh:comment', payload: COMMENT });
    const t0 = '2026-01-01T00:00:00.000Z';
    const first = await dispatchOutbox(store, makeRunner([failResult('server error')]), { cwd: CWD, now: t0 });
    expect(first.dispatched).toBe(0);
    expect(first.failed).toBe(1);
    expect(first.deadLettered).toBe(0);

    // Still due for the same 1-minute backoff window — must not call the runner.
    const before = await dispatchOutbox(store, makeRunner([]), { cwd: CWD, now: '2026-01-01T00:00:30.000Z' });
    expect(before.dispatched).toBe(0);
    expect(before.failed).toBe(0);

    // Past the backoff window — the row becomes eligible again.
    const after = await dispatchOutbox(store, makeRunner([okResult()]), { cwd: CWD, now: '2026-01-01T00:01:00.000Z' });
    expect(after.dispatched).toBe(1);
    expect(await store.listPending()).toHaveLength(0);
  });

  test('backoff is scheduled from the actual failure time, not the batch-start time (issue #606 review follow-up)', async () => {
    // A dispatch that blocks for a while (e.g. a `gh` call with no timeout)
    // must not have its retry scheduled from the time the run *started* — that
    // would write a `next_attempt_at` already in the past for a long-enough
    // block, immediately defeating the backoff. Simulate the block by
    // advancing the fake clock from inside the mock runner, so `opts.now` is
    // left unset (real clock) and the fix must read the clock again after the
    // dispatch completes rather than reusing the batch-start snapshot.
    await store.enqueue({ idempotencyKey: 'slow', topic: 'gh:comment', payload: COMMENT });

    const batchStart = new Date('2026-01-01T00:00:00.000Z');
    const afterSlowDispatch = new Date('2026-01-01T00:02:00.000Z');

    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    jest.setSystemTime(batchStart);
    try {
      const runner = {
        run: () => {
          jest.setSystemTime(afterSlowDispatch);
          return failResult('boom');
        },
      };
      const result = await dispatchOutbox(store, runner, { cwd: CWD });
      expect(result.failed).toBe(1);
    } finally {
      jest.useRealTimers();
    }

    const [entry] = await store.listPending();
    // A `next_attempt_at` scheduled from `batchStart` (+ ~1 minute base delay)
    // would already be <= `afterSlowDispatch`. It must instead be scheduled
    // from `afterSlowDispatch`, landing after it.
    expect(entry.nextAttemptAt > afterSlowDispatch.toISOString()).toBe(true);
  });

  test('a newer due row dispatches even though an older row is delayed by backoff', async () => {
    await store.enqueue({ idempotencyKey: 'older', topic: 'gh:comment', payload: COMMENT, now: '2025-12-01T00:00:00.000Z' });
    const t0 = '2026-01-01T00:00:00.000Z';
    await dispatchOutbox(store, makeRunner([failResult('server error')]), { cwd: CWD, now: t0 });

    await store.enqueue({ idempotencyKey: 'newer', topic: 'gh:comment', payload: { ...COMMENT, body: 'b2' } });
    // Older row's next_attempt_at is 2026-01-01T00:01:00Z — still in the future.
    const result = await dispatchOutbox(store, makeRunner([okResult()]), {
      cwd: CWD,
      now: '2026-01-01T00:00:30.000Z',
      limit: 1,
    });
    expect(result.dispatched).toBe(1);
    const pending = await store.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0].idempotencyKey).toBe('older');
  });

  test('an unfiltered dispatch is not starved by a delayed prefix larger than the default scan bound (P2 review follow-up)', async () => {
    // No `filter`/`scanCursorKey` is supplied, so there is no persisted cursor
    // to carry scan progress across runs — every run restarts the scan at row
    // 1. The old default `scanLimit` (pageSize * 10 = 2000, since pageSize
    // floors at 200) capped that scan, so a delayed-but-owned prefix bigger
    // than the cap hid every due row behind it, forever, run after run — even
    // though nothing here is foreign or filtered out. 2005 delayed rows sit
    // ahead of a single due row here, past the old 2000-row default cap.
    const t0 = '2026-01-01T00:00:00.000Z';
    const DELAYED_COUNT = 2005;
    for (let i = 0; i < DELAYED_COUNT; i++) {
      await store.enqueue({ idempotencyKey: `delayed-${i}`, topic: 'gh:comment', payload: { ...COMMENT, body: `d${i}` } });
    }
    const delayedRows = await store.listPending();
    for (const row of delayedRows) {
      const r = await store.markFailed(row.id, 'boom', t0);
      expect(r.deadLettered).toBe(false);
    }
    await store.enqueue({ idempotencyKey: 'later', topic: 'gh:comment', payload: { ...COMMENT, body: 'later' } });

    // Still well inside every delayed row's backoff window.
    const result = await dispatchOutbox(store, makeRunner([okResult()]), {
      cwd: CWD,
      now: '2026-01-01T00:00:10.000Z',
    });

    expect(result.dispatched).toBe(1);
    const pending = await store.listPending();
    expect(pending).toHaveLength(DELAYED_COUNT);
    expect(pending.every((e) => e.idempotencyKey !== 'later')).toBe(true);
  }, 20000);

  test('exhausting the retry budget dead-letters the row and it is never dispatched again', async () => {
    await store.enqueue({ idempotencyKey: 'k1', topic: 'gh:comment', payload: COMMENT });
    const [entry] = await store.listPending();
    // Drive the first 7 failures directly against the store (markFailed itself
    // does not gate on due-time — only dispatchOutbox's selection does — so
    // there is no need to advance the clock past each growing backoff step).
    for (let i = 0; i < 7; i++) {
      const r = await store.markFailed(entry.id, `err-${i}`, '2026-01-01T00:00:00.000Z');
      expect(r.deadLettered).toBe(false);
    }

    // The 8th failure, driven through dispatchOutbox itself, must dead-letter it.
    const result = await dispatchOutbox(store, makeRunner([failResult('final')]), {
      cwd: CWD,
      now: '2030-01-01T00:00:00.000Z',
    });
    expect(result.failed).toBe(1);
    expect(result.deadLettered).toBe(1);
    expect(await store.listPending()).toHaveLength(0);

    // A subsequent run must not touch the dead-lettered row at all.
    const after = await dispatchOutbox(store, makeRunner([]), { cwd: CWD, now: '2031-01-01T00:00:00.000Z' });
    expect(after.dispatched).toBe(0);
    expect(after.failed).toBe(0);
  });

  test('a permanently failing row cannot starve newer rows across repeated runs (cap starvation)', async () => {
    // A row that fails every run sits at the front of the table; 5 healthy rows
    // queue up behind it. Even with a limit of 1, repeated runs must not spend
    // every run's single slot retrying the same still-delayed row — they must
    // reach and drain the newer rows instead.
    await store.enqueue({ idempotencyKey: 'poison', topic: 'gh:comment', payload: COMMENT, now: '2025-12-01T00:00:00.000Z' });
    for (let i = 0; i < 5; i++) {
      await store.enqueue({ idempotencyKey: `healthy-${i}`, topic: 'gh:comment', payload: { ...COMMENT, body: `b${i}` } });
    }

    // First run: the poison row fails and is scheduled ~1 minute out.
    await dispatchOutbox(store, makeRunner([failResult('boom')]), { cwd: CWD, now: '2026-01-01T00:00:00.000Z', limit: 1 });

    // Subsequent runs, all before the poison row is due again, must dispatch the
    // healthy rows instead of retrying the still-delayed poison row.
    for (let i = 0; i < 5; i++) {
      const result = await dispatchOutbox(store, makeRunner([okResult()]), {
        cwd: CWD,
        now: '2026-01-01T00:00:10.000Z',
        limit: 1,
      });
      expect(result.dispatched).toBe(1);
    }

    const pending = await store.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0].idempotencyKey).toBe('poison');
  });
});

describe('dispatchOutbox — idempotency (no re-dispatch)', () => {
  test('already-sent entry not in pending list — not re-dispatched', async () => {
    await store.enqueue({ idempotencyKey: 'k1', topic: 'gh:comment', payload: COMMENT });
    const [e] = await store.listPending();
    await store.markSent(e.id);

    const runner = makeRunner([]); // expects zero calls
    const result = await dispatchOutbox(store, runner, { cwd: CWD });
    expect(result.dispatched).toBe(0);
    expect(result.failed).toBe(0);
  });

  test('duplicate idempotency key not re-enqueued', async () => {
    await store.enqueue({ idempotencyKey: 'same-key', topic: 'gh:comment', payload: COMMENT });
    await store.enqueue({ idempotencyKey: 'same-key', topic: 'gh:comment', payload: COMMENT });
    expect(await store.listPending()).toHaveLength(1);
  });
});

describe('dispatchOutbox — cancellation race (issue #607 review follow-up)', () => {
  test('a row cancelled in the window between the scan and the per-entry claim is skipped, never sent', async () => {
    await store.enqueue({ idempotencyKey: 'k1', topic: 'gh:comment', payload: COMMENT });
    const [e] = await store.listPending();

    // Simulate `admin outbox cancel --yes` landing on this exact row in the
    // narrow window between dispatchOutbox's scan (which already captured it
    // as pending) and its per-entry `claimForDispatch` call — the P2 review
    // finding's race. The scan already ran above (`listPending`), so the row
    // would be in `dispatchOutbox`'s in-memory `pending` list regardless of
    // what happens next; monkey-patching `claimForDispatch` to cancel the row
    // immediately before delegating to the real implementation reproduces
    // that exact ordering without needing real concurrent processes.
    const originalClaim = store.claimForDispatch.bind(store);
    store.claimForDispatch = async (id, now) => {
      await store.cancelEntry(id, now);
      return originalClaim(id, now);
    };

    const runner = makeRunner([]); // expects zero calls — cancelled row must never reach the external side effect
    const result = await dispatchOutbox(store, runner, { cwd: CWD });
    expect(result.dispatched).toBe(0);
    expect(result.failed).toBe(0);
    expect(runner.callCount()).toBe(0);

    const row = await store.getById(e.id);
    expect(row.cancelledAt).toBeTruthy();
    expect(row.sentAt).toBeUndefined();
  });

  test('a row already claimed by another dispatch attempt is skipped this run, not double-dispatched', async () => {
    await store.enqueue({ idempotencyKey: 'k1', topic: 'gh:comment', payload: COMMENT });
    const [e] = await store.listPending();
    // Simulate a concurrent dispatchOutbox invocation that has already
    // claimed this row and is mid-flight on its external side effect.
    expect(await store.claimForDispatch(e.id)).toBe(true);

    const runner = makeRunner([]); // expects zero calls — claimed row must never be re-dispatched here
    const result = await dispatchOutbox(store, runner, { cwd: CWD });
    expect(result.dispatched).toBe(0);
    expect(result.failed).toBe(0);
    expect(runner.callCount()).toBe(0);
    // The row is left claimed (still owned by the "other" in-flight attempt),
    // not silently marked sent or failed by this run.
    const row = await store.getById(e.id);
    expect(row.sentAt).toBeUndefined();
    expect(row.claimedAt).toBeTruthy();
  });

  test('cancelling a row while it is claimed for dispatch is refused (dispatch_in_progress)', async () => {
    await store.enqueue({ idempotencyKey: 'k1', topic: 'gh:comment', payload: COMMENT });
    const [e] = await store.listPending();
    expect(await store.claimForDispatch(e.id)).toBe(true);

    const cancelResult = await store.cancelEntry(e.id);
    expect(cancelResult).toEqual({ cancelled: false, reason: 'dispatch_in_progress' });

    // Once the claimed dispatch attempt actually completes and marks the row
    // sent, the row is durably delivered — cancellation must still refuse it,
    // now for the ordinary already_sent reason, never reporting cancelled:true
    // for a row that was actually delivered.
    await store.markSent(e.id);
    const secondCancel = await store.cancelEntry(e.id);
    expect(secondCancel).toEqual({ cancelled: false, reason: 'already_sent' });
  });
});

describe('dispatchOutbox — a row held by a concurrent live claim is never stranded by the scan cursor (issue #607 review follow-up)', () => {
  test('a row claimed elsewhere is left open (not folded into resolvedIds), so the cursor never skips past it', async () => {
    const FOREIGN = { ...COMMENT, owner: 'other', repo: 'repo' };
    await store.enqueue({ idempotencyKey: 'foreign-0', topic: 'gh:comment', payload: FOREIGN });
    await store.enqueue({ idempotencyKey: 'mine-0', topic: 'gh:comment', payload: COMMENT });
    await store.enqueue({ idempotencyKey: 'mine-1', topic: 'gh:comment', payload: COMMENT });
    const [, mine0, mine1] = await store.listPending();

    // Simulate a concurrent dispatchOutbox invocation that already claimed
    // 'mine-0' and is still mid-flight on its external side effect — same
    // setup as the "a row already claimed by another dispatch attempt is
    // skipped this run" test above, but this time under a scanCursorKey so
    // the cursor-advancement bookkeeping is exercised too.
    expect(await store.claimForDispatch(mine0.id, '2026-01-01T00:00:00.000Z')).toBe(true);

    const filter = (entry) => entry.payload.owner === COMMENT.owner && entry.payload.repo === COMMENT.repo;
    const first = await dispatchOutbox(store, makeRunner([okResult()]), {
      cwd: CWD,
      limit: 10,
      filter,
      scanCursorKey: 'session-claim-race',
      now: '2026-01-01T00:00:01.000Z',
    });
    // 'mine-0' is skipped (still claimed elsewhere); 'mine-1' dispatches.
    expect(first.dispatched).toBe(1);
    expect(first.failed).toBe(0);

    // The persisted cursor must not have advanced past 'mine-0' — if it had
    // (the bug: a failed claim was unconditionally folded into resolvedIds),
    // a future run scoped to this key would resume scanning after 'mine-1'
    // and never re-examine 'mine-0' again, even once its claim clears.
    const cursor = await store.getScanCursor('session-claim-race');
    expect(cursor === undefined || cursor < mine0.id).toBe(true);

    // The "other" dispatcher's attempt eventually fails and releases the
    // claim, scheduling a retry.
    await store.markFailed(mine0.id, 'transient', '2026-01-01T00:00:02.000Z');
    const releasedRow = await store.getById(mine0.id);
    expect(releasedRow.claimedAt).toBeUndefined();

    // A later run under the same scanCursorKey must still reach 'mine-0' —
    // it was never permanently stranded behind the cursor.
    const second = await dispatchOutbox(store, makeRunner([okResult()]), {
      cwd: CWD,
      limit: 10,
      filter,
      scanCursorKey: 'session-claim-race',
      now: releasedRow.nextAttemptAt,
    });
    expect(second.dispatched).toBe(1);
    expect(await store.listPending()).toHaveLength(1); // only 'foreign-0' left
  });
});

describe('dispatchOutbox — limit', () => {
  test('respects limit option', async () => {
    for (let i = 0; i < 5; i++) {
      await store.enqueue({ idempotencyKey: `k${i}`, topic: 'gh:comment', payload: COMMENT });
    }
    const runner = { run: () => okResult() };
    const result = await dispatchOutbox(store, runner, { cwd: CWD, limit: 2 });
    expect(result.dispatched).toBe(2);
    expect(await store.listPending()).toHaveLength(3);
  });
});

describe('dispatchOutbox — filter is applied before the limit (no starvation)', () => {
  test('owned rows behind a full window of foreign rows still dispatch', async () => {
    // `limit` older pending rows for a foreign repo sit AHEAD of this session's
    // own row. If the limit were applied before the filter, the foreign rows
    // would fill the fetch window, get filtered out, and the owned row would
    // never be reached — starving the session. The owned row must dispatch.
    const FOREIGN = { ...COMMENT, owner: 'other', repo: 'repo' };
    for (let i = 0; i < 2; i++) {
      await store.enqueue({ idempotencyKey: `foreign-${i}`, topic: 'gh:comment', payload: FOREIGN });
    }
    await store.enqueue({ idempotencyKey: 'mine', topic: 'gh:comment', payload: COMMENT });

    const runner = {
      run: (args) => {
        if (args.join(' ').includes('other/repo')) {
          throw new Error('runner must never touch a foreign repo');
        }
        return okResult();
      },
    };
    const result = await dispatchOutbox(store, runner, {
      cwd: CWD,
      limit: 2,
      filter: (entry) => entry.payload.owner === COMMENT.owner && entry.payload.repo === COMMENT.repo,
    });

    expect(result.dispatched).toBe(1);
    expect(result.failed).toBe(0);
    // Only the two foreign rows remain pending, untouched, for their owning run.
    const pending = await store.listPending();
    expect(pending).toHaveLength(2);
    expect(pending.every((e) => e.payload.owner === 'other')).toBe(true);
  });

  test('caps owned rows to the limit after filtering', async () => {
    // Interleave foreign and owned rows; the limit must cap MATCHING rows.
    const FOREIGN = { ...COMMENT, owner: 'other', repo: 'repo' };
    for (let i = 0; i < 5; i++) {
      await store.enqueue({ idempotencyKey: `foreign-${i}`, topic: 'gh:comment', payload: FOREIGN });
      await store.enqueue({ idempotencyKey: `mine-${i}`, topic: 'gh:comment', payload: COMMENT });
    }

    const runner = { run: () => okResult() };
    const result = await dispatchOutbox(store, runner, {
      cwd: CWD,
      limit: 3,
      filter: (entry) => entry.payload.owner === COMMENT.owner && entry.payload.repo === COMMENT.repo,
    });

    expect(result.dispatched).toBe(3);
    // 5 foreign (never owned) + 2 remaining owned = 7 still pending.
    expect(await store.listPending()).toHaveLength(7);
  });

  test('scanLimit bounds the scan when the filter matches nothing in a large foreign backlog', async () => {
    // A large foreign backlog sits ahead of a single owned row. Without a scan
    // budget the loop pages through the entire due set (each page floors at
    // 200 rows) until it reaches the owned row past the foreign backlog. With
    // `scanLimit` set below the backlog size, the run must stop before ever
    // reaching (or dispatching) the owned row — proving the scan, not just the
    // dispatch count, is bounded.
    const FOREIGN = { ...COMMENT, owner: 'other', repo: 'repo' };
    for (let i = 0; i < 210; i++) {
      await store.enqueue({ idempotencyKey: `foreign-${i}`, topic: 'gh:comment', payload: FOREIGN });
    }
    await store.enqueue({ idempotencyKey: 'mine', topic: 'gh:comment', payload: COMMENT });

    const runner = {
      run: () => {
        throw new Error('runner must never be invoked when the scan is cut off before the owned row');
      },
    };
    const result = await dispatchOutbox(store, runner, {
      cwd: CWD,
      limit: 5,
      scanLimit: 200,
      filter: (entry) => entry.payload.owner === COMMENT.owner && entry.payload.repo === COMMENT.repo,
    });

    expect(result.dispatched).toBe(0);
    expect(result.failed).toBe(0);
    // All 211 rows remain pending, including the owned row the scan never reached.
    expect(await store.listPending()).toHaveLength(211);
  });

  test('scanLimit below the page size bounds each fetch, not just the cumulative scan', async () => {
    // A `scanLimit` smaller than the fetch page size (200) must shrink the
    // fetch itself: the run should never fetch/parse more rows than the
    // remaining scan budget, even on the very first page. Regression test
    // for the case where the first `listPendingEntries` call still requested a
    // full page and matching rows kept being dispatched until `scanned` was
    // checked only *between* pages.
    for (let i = 0; i < 10; i++) {
      await store.enqueue({ idempotencyKey: `mine-${i}`, topic: 'gh:comment', payload: COMMENT });
    }

    const seenLimits = [];
    const originalListPendingEntries = store.listPendingEntries.bind(store);
    store.listPendingEntries = (opts) => {
      seenLimits.push(opts.limit);
      return originalListPendingEntries(opts);
    };

    const runner = { run: () => okResult() };
    const result = await dispatchOutbox(store, runner, {
      cwd: CWD,
      limit: 50,
      scanLimit: 1,
    });

    expect(seenLimits).toEqual([1]);
    expect(result.dispatched).toBe(1);
    expect(result.failed).toBe(0);
    expect(await store.listPending()).toHaveLength(9);
  });

  test('scanCursorKey lets a second capped run advance past a confirmed foreign prefix (issue #606 review follow-up)', async () => {
    // Same shape as the previous test — a foreign backlog larger than
    // scanLimit sits ahead of a single owned row — but this time the caller
    // supplies scanCursorKey so the first run's confirmed-foreign progress is
    // persisted. Without persistence, a second run would re-scan the exact
    // same 200-row foreign prefix and never reach the owned row, returning
    // dispatched: 0 forever.
    const FOREIGN = { ...COMMENT, owner: 'other', repo: 'repo' };
    for (let i = 0; i < 210; i++) {
      await store.enqueue({ idempotencyKey: `foreign-${i}`, topic: 'gh:comment', payload: FOREIGN });
    }
    await store.enqueue({ idempotencyKey: 'mine', topic: 'gh:comment', payload: COMMENT });

    const filter = (entry) => entry.payload.owner === COMMENT.owner && entry.payload.repo === COMMENT.repo;

    const first = await dispatchOutbox(store, { run: () => { throw new Error('must not be called'); } }, {
      cwd: CWD,
      limit: 5,
      scanLimit: 200,
      filter,
      scanCursorKey: 'session-a',
    });
    expect(first.dispatched).toBe(0);
    expect(await store.getScanCursor('session-a')).toBeDefined();

    const runner = makeRunner([okResult()]);
    const second = await dispatchOutbox(store, runner, {
      cwd: CWD,
      limit: 5,
      scanLimit: 200,
      filter,
      scanCursorKey: 'session-a',
    });

    expect(second.dispatched).toBe(1);
    const pending = await store.listPending();
    expect(pending).toHaveLength(210);
    expect(pending.every((e) => e.payload.owner === 'other')).toBe(true);
  });

  test('scanCursorKey never advances past a matching row left pending by the run limit', async () => {
    // Two owned rows sit right after a small foreign prefix, but `limit: 1`
    // only lets the first be dispatched this run. The cursor must not skip
    // past the second (still-pending) owned row, or it would be starved just
    // like the foreign-backlog case this feature fixes.
    const FOREIGN = { ...COMMENT, owner: 'other', repo: 'repo' };
    await store.enqueue({ idempotencyKey: 'foreign-0', topic: 'gh:comment', payload: FOREIGN });
    await store.enqueue({ idempotencyKey: 'mine-0', topic: 'gh:comment', payload: COMMENT });
    await store.enqueue({ idempotencyKey: 'mine-1', topic: 'gh:comment', payload: COMMENT });

    const filter = (entry) => entry.payload.owner === COMMENT.owner && entry.payload.repo === COMMENT.repo;

    const first = await dispatchOutbox(store, makeRunner([okResult()]), {
      cwd: CWD,
      limit: 1,
      filter,
      scanCursorKey: 'session-b',
    });
    expect(first.dispatched).toBe(1);

    const second = await dispatchOutbox(store, makeRunner([okResult()]), {
      cwd: CWD,
      limit: 1,
      filter,
      scanCursorKey: 'session-b',
    });
    expect(second.dispatched).toBe(1);
    expect(await store.listPending()).toHaveLength(1);
    expect((await store.listPending())[0].payload.owner).toBe('other');
  });

  test('scanCursorKey does not strand an owned row that enters backoff before foreign due rows arrive (issue #606 review follow-up)', async () => {
    // The owned row fails first (entering backoff) while it is still the only
    // row in the table, so it is not yet visible to a scan bounded by the
    // persisted cursor. Foreign due rows are enqueued afterward with larger
    // ids. A run while the owned row is still delayed must not advance the
    // persisted cursor past those foreign ids — if it did, the owned row
    // (smaller id, behind the cursor) would be permanently excluded by
    // `id > afterId` once its backoff elapsed.
    const filter = (entry) => entry.payload.owner === COMMENT.owner && entry.payload.repo === COMMENT.repo;
    await store.enqueue({ idempotencyKey: 'mine', topic: 'gh:comment', payload: COMMENT });

    const t0 = '2026-01-01T00:00:00.000Z';
    const failing = await dispatchOutbox(store, makeRunner([failResult('server error')]), {
      cwd: CWD,
      now: t0,
      filter,
      scanCursorKey: 'session-c',
    });
    expect(failing.dispatched).toBe(0);
    expect(failing.failed).toBe(1);

    const FOREIGN = { ...COMMENT, owner: 'other', repo: 'repo' };
    for (let i = 0; i < 5; i++) {
      await store.enqueue({ idempotencyKey: `foreign-${i}`, topic: 'gh:comment', payload: FOREIGN });
    }

    // Still within the owned row's ~1-minute backoff window: nothing to
    // dispatch, but the foreign backlog is scanned.
    const stillDelayed = await dispatchOutbox(store, makeRunner([]), {
      cwd: CWD,
      now: '2026-01-01T00:00:10.000Z',
      filter,
      scanCursorKey: 'session-c',
    });
    expect(stillDelayed.dispatched).toBe(0);
    // The scan must not have persisted a cursor past the owned row's id, even
    // though it walked past 5 confirmed-foreign rows with larger ids.
    expect(await store.getScanCursor('session-c')).toBeUndefined();

    // Past the backoff window: the owned row must still be reachable — the
    // prior run must not have persisted a cursor past its id.
    const after = await dispatchOutbox(store, makeRunner([okResult()]), {
      cwd: CWD,
      now: '2026-01-01T00:01:00.000Z',
      filter,
      scanCursorKey: 'session-c',
    });
    expect(after.dispatched).toBe(1);
    const pending = await store.listPending();
    expect(pending).toHaveLength(5);
    expect(pending.every((e) => e.payload.owner === 'other')).toBe(true);
  });

  test('a persistently delayed owned row does not cap how far scanning can reach a later due owned row across repeated runs (issue #606 review follow-up)', async () => {
    // `early` fails once and then stays delayed for every run below. A large
    // foreign backlog (bigger than `scanLimit`) sits between it and `later`,
    // a fresh due owned row. If the persisted cursor stayed pinned at
    // `early`'s position (the pre-fix behavior), every run would restart
    // scanning from row 1 and never accumulate enough scan budget across runs
    // to reach `later` — it would be starved indefinitely. With the fix, scan
    // progress made confirming the foreign backlog carries over between runs
    // even though `early` never resolves, so `later` is eventually reached.
    const filter = (entry) => entry.payload.owner === COMMENT.owner && entry.payload.repo === COMMENT.repo;
    await store.enqueue({ idempotencyKey: 'early', topic: 'gh:comment', payload: COMMENT });

    const t0 = '2026-01-01T00:00:00.000Z';
    const failing = await dispatchOutbox(store, makeRunner([failResult('boom')]), {
      cwd: CWD,
      now: t0,
      filter,
      scanCursorKey: 'session-d',
    });
    expect(failing.failed).toBe(1);

    const FOREIGN = { ...COMMENT, owner: 'other', repo: 'repo' };
    for (let i = 0; i < 450; i++) {
      await store.enqueue({ idempotencyKey: `foreign-${i}`, topic: 'gh:comment', payload: FOREIGN });
    }
    await store.enqueue({ idempotencyKey: 'later', topic: 'gh:comment', payload: { ...COMMENT, body: 'later' } });

    // Every run below uses a `now` still well inside `early`'s backoff window,
    // so it never becomes due for the rest of this test.
    const now = '2026-01-01T00:00:10.000Z';
    let dispatchedLater = false;
    for (let i = 0; i < 10 && !dispatchedLater; i++) {
      const result = await dispatchOutbox(store, makeRunner([okResult()]), {
        cwd: CWD,
        now,
        filter,
        scanCursorKey: 'session-d',
        scanLimit: 100,
        limit: 5,
      });
      expect(result.dispatched).toBeLessThanOrEqual(1);
      if (result.dispatched === 1) dispatchedLater = true;
    }

    expect(dispatchedLater).toBe(true);
    const pending = await store.listPending();
    expect(pending.some((e) => e.idempotencyKey === 'early')).toBe(true);
    expect(pending.every((e) => e.idempotencyKey !== 'later')).toBe(true);
  });

  test('two persistently delayed owned rows do not cap how far scanning can reach a later due owned row (P1 review follow-up)', async () => {
    // Same shape as the previous test, but *two* owned rows are simultaneously
    // delayed ahead of the foreign backlog rather than one. The prior fix's
    // cursor pair pinned its single forward cursor at the second delayed
    // row's position on every run, discarding whatever progress that same run
    // made scanning past it into the backlog — so `later` was never reached
    // no matter how many runs executed, even though each individual run was
    // itself bounded by `scanLimit`. With the fix, both delayed rows stay
    // independently protected every run while forward progress into the
    // backlog still accumulates across runs.
    const filter = (entry) => entry.payload.owner === COMMENT.owner && entry.payload.repo === COMMENT.repo;
    await store.enqueue({ idempotencyKey: 'early1', topic: 'gh:comment', payload: COMMENT });
    await store.enqueue({ idempotencyKey: 'early2', topic: 'gh:comment', payload: COMMENT });

    const t0 = '2026-01-01T00:00:00.000Z';
    const failing = await dispatchOutbox(store, makeRunner([failResult('boom'), failResult('boom')]), {
      cwd: CWD,
      now: t0,
      filter,
      scanCursorKey: 'session-e',
    });
    expect(failing.failed).toBe(2);

    const FOREIGN = { ...COMMENT, owner: 'other', repo: 'repo' };
    for (let i = 0; i < 450; i++) {
      await store.enqueue({ idempotencyKey: `foreign-${i}`, topic: 'gh:comment', payload: FOREIGN });
    }
    await store.enqueue({ idempotencyKey: 'later', topic: 'gh:comment', payload: { ...COMMENT, body: 'later' } });

    // Every run below uses a `now` still well inside both rows' backoff
    // window, so neither ever becomes due for the rest of this test.
    const now = '2026-01-01T00:00:10.000Z';
    let dispatchedLater = false;
    for (let i = 0; i < 10 && !dispatchedLater; i++) {
      const result = await dispatchOutbox(store, makeRunner([okResult()]), {
        cwd: CWD,
        now,
        filter,
        scanCursorKey: 'session-e',
        scanLimit: 100,
        limit: 5,
      });
      expect(result.dispatched).toBeLessThanOrEqual(1);
      if (result.dispatched === 1) dispatchedLater = true;
    }

    expect(dispatchedLater).toBe(true);
    const pending = await store.listPending();
    expect(pending.some((e) => e.idempotencyKey === 'early1')).toBe(true);
    expect(pending.some((e) => e.idempotencyKey === 'early2')).toBe(true);
    expect(pending.every((e) => e.idempotencyKey !== 'later')).toBe(true);
  });

  test('a delayed zone as large as scanLimit does not consume the entire budget and starve a later due row (P1 review follow-up)', async () => {
    // Enough owned rows fail in the same run that the "protected zone" Phase A
    // must fully re-walk on the next run (floor..zoneEnd) is exactly as large
    // as the `scanLimit` supplied to that next run. Without a dedicated Phase B
    // reserve, Phase A alone would consume the whole budget re-confirming the
    // delayed rows, leaving nothing to reach `later` — starving it until the
    // delayed rows age out of backoff (potentially the full backoff cap).
    const filter = (entry) => entry.payload.owner === COMMENT.owner && entry.payload.repo === COMMENT.repo;
    const DELAYED_COUNT = 25;
    for (let i = 0; i < DELAYED_COUNT; i++) {
      await store.enqueue({ idempotencyKey: `delayed-${i}`, topic: 'gh:comment', payload: COMMENT });
    }

    const t0 = '2026-01-01T00:00:00.000Z';
    const failResults = Array.from({ length: DELAYED_COUNT }, () => failResult('boom'));
    const failing = await dispatchOutbox(store, makeRunner(failResults), {
      cwd: CWD,
      now: t0,
      filter,
      scanCursorKey: 'session-f',
    });
    expect(failing.failed).toBe(DELAYED_COUNT);

    // `later` is enqueued directly after the delayed rows, with no separating
    // foreign backlog — the zone alone is already `scanLimit`-sized.
    await store.enqueue({ idempotencyKey: 'later', topic: 'gh:comment', payload: { ...COMMENT, body: 'later' } });

    // Still well inside every delayed row's backoff window.
    const now = '2026-01-01T00:00:10.000Z';
    const result = await dispatchOutbox(store, makeRunner([okResult()]), {
      cwd: CWD,
      now,
      filter,
      scanCursorKey: 'session-f',
      scanLimit: DELAYED_COUNT,
      limit: 5,
    });

    expect(result.dispatched).toBe(1);
    const pending = await store.listPending();
    expect(pending.every((e) => e.idempotencyKey !== 'later')).toBe(true);
    expect(pending.filter((e) => e.idempotencyKey.startsWith('delayed-'))).toHaveLength(DELAYED_COUNT);
  });

  test('a run limit smaller than the protected zone does not permanently strand the unexamined rows (P1 review follow-up)', async () => {
    // Reproduces the exact failure the review flagged: the zone (5 owned rows)
    // is fully established, and a *separate* earlier run already advanced the
    // bulk cursor past the whole zone plus a foreign backlog. A later run then
    // supplies a `limit` smaller than the zone, so Phase A's scan fills
    // `pending` and stops partway through the zone, leaving some owned rows
    // unexamined. Without the fix, that run would persist a *shrunk* zone-end
    // cursor covering only the examined rows, and since the bulk cursor is
    // already past the true zone end, no future run would ever rescan the
    // unexamined rows again — even once they become due.
    const filter = (entry) => entry.payload.owner === COMMENT.owner && entry.payload.repo === COMMENT.repo;
    const ROWS = ['a', 'b', 'c', 'd', 'e'];
    for (const key of ROWS) {
      await store.enqueue({ idempotencyKey: key, topic: 'gh:comment', payload: { ...COMMENT, body: key } });
    }

    const t0 = '2026-01-01T00:00:00.000Z';
    const failing = await dispatchOutbox(store, makeRunner(ROWS.map(() => failResult('boom'))), {
      cwd: CWD,
      now: t0,
      filter,
      scanCursorKey: 'session-g',
    });
    expect(failing.failed).toBe(ROWS.length);

    // A large foreign backlog behind the zone. A priming run below scans past
    // all of it (and the whole zone, since none of the 5 rows are due yet),
    // advancing the bulk cursor well beyond the zone's end.
    const FOREIGN = { ...COMMENT, owner: 'other', repo: 'repo' };
    for (let i = 0; i < 300; i++) {
      await store.enqueue({ idempotencyKey: `foreign-${i}`, topic: 'gh:comment', payload: FOREIGN });
    }

    // Still well inside every row's 60s backoff window: nothing is due, so
    // this run only re-verifies the zone and scans the foreign backlog.
    const priming = await dispatchOutbox(store, makeRunner([]), {
      cwd: CWD,
      now: '2026-01-01T00:00:10.000Z',
      filter,
      scanCursorKey: 'session-g',
    });
    expect(priming.dispatched).toBe(0);

    // Now every row's backoff has elapsed. Supply a `limit` smaller than the
    // zone so Phase A fills `pending` after only 2 of the 5 rows.
    const capped = await dispatchOutbox(store, makeRunner([failResult('boom'), failResult('boom')]), {
      cwd: CWD,
      now: '2026-01-01T00:01:00.000Z',
      filter,
      scanCursorKey: 'session-g',
      limit: 2,
    });
    expect(capped.failed).toBe(2);

    // A later run, past the second backoff window for `a`/`b` but with room
    // to reach the rest of the zone, must still be able to find and dispatch
    // the three rows the capped run above never got to examine.
    const result = await dispatchOutbox(store, makeRunner([okResult(), okResult(), okResult()]), {
      cwd: CWD,
      now: '2026-01-01T00:02:00.000Z',
      filter,
      scanCursorKey: 'session-g',
      limit: 10,
    });
    expect(result.dispatched).toBe(3);
    const pending = await store.listPending();
    expect(pending.some((e) => e.idempotencyKey === 'c')).toBe(false);
    expect(pending.some((e) => e.idempotencyKey === 'd')).toBe(false);
    expect(pending.some((e) => e.idempotencyKey === 'e')).toBe(false);
  });
});
