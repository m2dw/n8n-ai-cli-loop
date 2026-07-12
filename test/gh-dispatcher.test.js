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
});
