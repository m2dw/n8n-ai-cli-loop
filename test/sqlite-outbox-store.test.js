import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SqliteOutboxStore } from '../dist/stores/sqlite-outbox-store.js';

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
