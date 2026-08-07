import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { sqliteBackendId } from '../dist/stores/sqlite-backend-id.js';
import { SqliteTaskStore } from '../dist/stores/sqlite-task-store.js';
import { SqliteOutboxStore } from '../dist/stores/sqlite-outbox-store.js';

let tmpDir;

beforeEach(() => {
  // realpath the temp root itself: on macOS /var is a symlink to /private/var,
  // so the un-canonicalized spelling would differ from every id we compute.
  tmpDir = realpathSync(mkdtempSync(join(tmpdir(), 'backend-id-test-')));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('sqliteBackendId', () => {
  test('returns undefined for in-memory databases', () => {
    expect(sqliteBackendId('')).toBeUndefined();
    expect(sqliteBackendId(':memory:')).toBeUndefined();
    expect(sqliteBackendId('file::memory:?cache=shared')).toBeUndefined();
  });

  test('gives the same id to a file and its symlinked directory spelling', () => {
    const realDir = join(tmpDir, 'real');
    mkdirSync(realDir);
    const dbPath = join(realDir, 'state.db');
    writeFileSync(dbPath, '');
    const linkDir = join(tmpDir, 'link');
    symlinkSync(realDir, linkDir);

    expect(sqliteBackendId(join(linkDir, 'state.db'))).toBe(sqliteBackendId(dbPath));
  });

  test('gives the same id to a file and a symlink pointing at it', () => {
    const dbPath = join(tmpDir, 'state.db');
    writeFileSync(dbPath, '');
    const linkPath = join(tmpDir, 'alias.db');
    symlinkSync(dbPath, linkPath);

    expect(sqliteBackendId(linkPath)).toBe(sqliteBackendId(dbPath));
  });

  test('still resolves symlinked ancestors when the database file does not exist yet', () => {
    const realDir = join(tmpDir, 'real');
    mkdirSync(realDir);
    const linkDir = join(tmpDir, 'link');
    symlinkSync(realDir, linkDir);

    expect(sqliteBackendId(join(linkDir, 'nested', 'state.db'))).toBe(
      sqliteBackendId(join(realDir, 'nested', 'state.db')),
    );
  });

  test('keeps distinct files distinct', () => {
    expect(sqliteBackendId(join(tmpDir, 'a.db'))).not.toBe(sqliteBackendId(join(tmpDir, 'b.db')));
  });
});

describe('store backend identity', () => {
  test('task and outbox stores opened through a symlink share one backendId', () => {
    const realDir = join(tmpDir, 'real');
    mkdirSync(realDir);
    const linkDir = join(tmpDir, 'link');
    symlinkSync(realDir, linkDir);
    const dbPath = join(realDir, 'state.db');

    const taskStore = new SqliteTaskStore(dbPath);
    const outboxStore = new SqliteOutboxStore(join(linkDir, 'state.db'));
    try {
      expect(taskStore.backendId).toBeDefined();
      expect(outboxStore.backendId).toBe(taskStore.backendId);
    } finally {
      taskStore.close();
      outboxStore.close();
    }
  });

  test('stores on genuinely different files do not share a backendId', () => {
    const taskStore = new SqliteTaskStore(join(tmpDir, 'tasks.db'));
    const outboxStore = new SqliteOutboxStore(join(tmpDir, 'outbox.db'));
    try {
      expect(outboxStore.backendId).not.toBe(taskStore.backendId);
    } finally {
      taskStore.close();
      outboxStore.close();
    }
  });
});
