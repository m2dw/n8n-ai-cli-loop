import { mkdtempSync, mkdirSync, rmSync, existsSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import { SqliteTaskStore } from '../dist/stores/sqlite-task-store.js';
import {
  createBackup,
  listBackups,
  restoreBackup,
  pinBackup,
  unpinBackup,
  BACKUP_RETENTION_FLOOR,
} from '../dist/stores/sqlite-backup-store.js';

let tmpDir;
let dbPath;
let backupDir;
let store;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'sqlite-backup-store-test-'));
  dbPath = join(tmpDir, 'test.db');
  backupDir = join(tmpDir, 'backups');
  store = new SqliteTaskStore(dbPath);
});

afterEach(() => {
  if (store.open) store.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('createBackup', () => {
  test('produces a verified backup that passes integrity_check and matches the source row count', async () => {
    await store.enqueueTask({ sessionId: 's1', issueNumber: 1, phase: 'implementation', now: '2026-01-01T00:00:00.000Z' });
    await store.enqueueTask({ sessionId: 's1', issueNumber: 2, phase: 'implementation', now: '2026-01-01T00:00:00.000Z' });

    const result = await createBackup(dbPath, backupDir, '2026-01-01T00:05:00.000Z');
    expect(result.ok).toBe(true);
    expect(result.entry.taskCount).toBe(2);
    expect(existsSync(result.entry.backupPath)).toBe(true);

    const backupDb = new Database(result.entry.backupPath, { readonly: true });
    const integrity = backupDb.pragma('integrity_check');
    expect(integrity[0].integrity_check).toBe('ok');
    const count = backupDb.prepare('SELECT COUNT(*) AS c FROM tasks').get().c;
    expect(count).toBe(2);
    backupDb.close();
  });

  test('does not block a concurrent writer on the same WAL database (online backup, §8)', async () => {
    await store.enqueueTask({ sessionId: 's1', issueNumber: 1, phase: 'implementation', now: '2026-01-01T00:00:00.000Z' });

    const backupPromise = createBackup(dbPath, backupDir, '2026-01-01T00:05:00.000Z');
    const writer = new SqliteTaskStore(dbPath);
    await writer.enqueueTask({ sessionId: 's1', issueNumber: 2, phase: 'implementation', now: '2026-01-01T00:05:01.000Z' });
    writer.close();

    const result = await backupPromise;
    expect(result.ok).toBe(true);
  });

  test('two concurrent creates sharing the same millisecond timestamp get distinct ids and files (issue #611 review)', async () => {
    await store.enqueueTask({ sessionId: 's1', issueNumber: 1, phase: 'implementation', now: '2026-01-01T00:00:00.000Z' });

    const sameNow = '2026-01-01T00:05:00.000Z';
    const [a, b] = await Promise.all([
      createBackup(dbPath, backupDir, sameNow),
      createBackup(dbPath, backupDir, sameNow),
    ]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(a.entry.id).not.toBe(b.entry.id);
    expect(a.entry.backupPath).not.toBe(b.entry.backupPath);
    expect(existsSync(a.entry.backupPath)).toBe(true);
    expect(existsSync(b.entry.backupPath)).toBe(true);

    const entries = listBackups(dbPath, backupDir);
    expect(entries.map((e) => e.id)).toEqual(expect.arrayContaining([a.entry.id, b.entry.id]));
  });

  test('retains only the most recent verified backups per dbPath (rotation floor)', async () => {
    await store.enqueueTask({ sessionId: 's1', issueNumber: 1, phase: 'implementation', now: '2026-01-01T00:00:00.000Z' });
    for (let i = 0; i < BACKUP_RETENTION_FLOOR + 1; i++) {
      const result = await createBackup(dbPath, backupDir, `2026-01-0${i + 1}T00:00:00.000Z`);
      expect(result.ok).toBe(true);
    }
    const entries = listBackups(dbPath, backupDir);
    expect(entries.length).toBe(BACKUP_RETENTION_FLOOR);
    // The oldest backup file must actually be gone from disk, not just the manifest.
    const ids = entries.map((e) => e.id);
    expect(ids).not.toContain('2026-01-01T00-00-00-000Z');
  });

  test('a pinned backup survives rotation even after more than the retention floor of newer backups are created (issue #611 review)', async () => {
    await store.enqueueTask({ sessionId: 's1', issueNumber: 1, phase: 'implementation', now: '2026-01-01T00:00:00.000Z' });
    const first = await createBackup(dbPath, backupDir, '2026-01-01T00:00:00.000Z');
    expect(first.ok).toBe(true);

    const pinResult = await pinBackup(dbPath, first.entry.id, 'holder-a', backupDir);
    expect(pinResult.ok).toBe(true);

    // Simulate a concurrent backup-rotation process creating more backups
    // than the retention floor while the pinned backup is still in use as a
    // prune run's recovery point — ordinary rotation would otherwise delete it.
    for (let i = 0; i < BACKUP_RETENTION_FLOOR + 1; i++) {
      const result = await createBackup(dbPath, backupDir, `2026-01-0${i + 2}T00:00:00.000Z`);
      expect(result.ok).toBe(true);
    }

    const entries = listBackups(dbPath, backupDir);
    const ids = entries.map((e) => e.id);
    expect(ids).toContain(first.entry.id);
    expect(existsSync(first.entry.backupPath)).toBe(true);

    // Once unpinned, the next rotation is free to remove it again.
    await unpinBackup(dbPath, first.entry.id, 'holder-a', backupDir);
    await createBackup(dbPath, backupDir, '2026-02-01T00:00:00.000Z');
    const idsAfterUnpin = listBackups(dbPath, backupDir).map((e) => e.id);
    expect(idsAfterUnpin).not.toContain(first.entry.id);
  });

  test('a second holder pinning the same backup keeps it pinned after the first holder unpins (issue #611 review, refcounted pin)', async () => {
    await store.enqueueTask({ sessionId: 's1', issueNumber: 1, phase: 'implementation', now: '2026-01-01T00:00:00.000Z' });
    const first = await createBackup(dbPath, backupDir, '2026-01-01T00:00:00.000Z');
    expect(first.ok).toBe(true);

    // Simulate two concurrent `prune run --yes` invocations both selecting
    // and pinning the same fresh backup before either has finished.
    expect((await pinBackup(dbPath, first.entry.id, 'holder-a', backupDir)).ok).toBe(true);
    expect((await pinBackup(dbPath, first.entry.id, 'holder-b', backupDir)).ok).toBe(true);

    // The losing invocation's cleanup unpins only its own holder token — the
    // still-running winner's pin must survive.
    await unpinBackup(dbPath, first.entry.id, 'holder-a', backupDir);

    for (let i = 0; i < BACKUP_RETENTION_FLOOR + 1; i++) {
      const result = await createBackup(dbPath, backupDir, `2026-01-0${i + 2}T00:00:00.000Z`);
      expect(result.ok).toBe(true);
    }

    const idsWhileHolderBPinned = listBackups(dbPath, backupDir).map((e) => e.id);
    expect(idsWhileHolderBPinned).toContain(first.entry.id);
    expect(existsSync(first.entry.backupPath)).toBe(true);

    // Only once the last holder releases its pin is the backup free to rotate.
    await unpinBackup(dbPath, first.entry.id, 'holder-b', backupDir);
    await createBackup(dbPath, backupDir, '2026-02-01T00:00:00.000Z');
    const idsAfterLastUnpin = listBackups(dbPath, backupDir).map((e) => e.id);
    expect(idsAfterLastUnpin).not.toContain(first.entry.id);
  });

  test('never rotates a different dbPath sharing the same backup directory', async () => {
    const otherDbPath = join(tmpDir, 'other.db');
    const otherStore = new SqliteTaskStore(otherDbPath);
    await otherStore.enqueueTask({ sessionId: 's1', issueNumber: 1, phase: 'implementation', now: '2026-01-01T00:00:00.000Z' });

    for (let i = 0; i < BACKUP_RETENTION_FLOOR + 1; i++) {
      await createBackup(dbPath, backupDir, `2026-01-0${i + 1}T00:00:00.000Z`);
    }
    await createBackup(otherDbPath, backupDir, '2026-02-01T00:00:00.000Z');
    otherStore.close();

    expect(listBackups(dbPath, backupDir).length).toBe(BACKUP_RETENTION_FLOOR);
    expect(listBackups(otherDbPath, backupDir).length).toBe(1);
  });

  test('fails when the database file does not exist', async () => {
    const result = await createBackup(join(tmpDir, 'missing.db'), backupDir);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not found/);
  });
});

describe('restoreBackup', () => {
  test('restores a verified backup, replacing the live database, and preserves the file it replaced', async () => {
    await store.enqueueTask({ sessionId: 's1', issueNumber: 1, phase: 'implementation', now: '2026-01-01T00:00:00.000Z' });
    const backupResult = await createBackup(dbPath, backupDir, '2026-01-01T00:05:00.000Z');
    expect(backupResult.ok).toBe(true);

    // Mutate the live DB after the backup was taken.
    await store.enqueueTask({ sessionId: 's1', issueNumber: 2, phase: 'implementation', now: '2026-01-01T00:10:00.000Z' });
    store.close();

    const restoreResult = await restoreBackup(dbPath, backupResult.entry.id, backupDir, '2026-01-01T00:15:00.000Z');
    expect(restoreResult.ok).toBe(true);
    expect(existsSync(restoreResult.preRestorePath)).toBe(true);

    const restored = new SqliteTaskStore(dbPath);
    const tasks = await restored.listSessionTasks('s1');
    expect(tasks.map((t) => t.issueNumber)).toEqual([1]); // issue 2 postdates the backup, so it's gone after restore
    restored.close();
  });

  test('never opens the backup file for writing: the same backup id can be restored twice', async () => {
    await store.enqueueTask({ sessionId: 's1', issueNumber: 1, phase: 'implementation', now: '2026-01-01T00:00:00.000Z' });
    const backupResult = await createBackup(dbPath, backupDir, '2026-01-01T00:05:00.000Z');
    store.close();

    const first = await restoreBackup(dbPath, backupResult.entry.id, backupDir, '2026-01-01T00:10:00.000Z');
    expect(first.ok).toBe(true);
    const second = await restoreBackup(dbPath, backupResult.entry.id, backupDir, '2026-01-01T00:11:00.000Z');
    expect(second.ok).toBe(true);
  });

  test('fails for an unknown backup id', async () => {
    const result = await restoreBackup(dbPath, 'nonexistent', backupDir);
    expect(result.ok).toBe(false);
  });

  test('carries a caller-held maintenance lock into the replacement file before the rename (issue #611 review)', async () => {
    await store.enqueueTask({ sessionId: 's1', issueNumber: 1, phase: 'implementation', now: '2026-01-01T00:00:00.000Z' });
    const backupResult = await createBackup(dbPath, backupDir, '2026-01-01T00:05:00.000Z');
    store.close();

    const result = await restoreBackup(dbPath, backupResult.entry.id, backupDir, '2026-01-01T00:10:00.000Z', {
      carryLock: { holder: 'restore:123:test', acquiredAt: '2026-01-01T00:10:00.000Z' },
    });
    expect(result.ok).toBe(true);

    const restored = new Database(dbPath, { readonly: true });
    const lockRow = restored.prepare('SELECT holder FROM maintenance_lock WHERE id = 1').get();
    expect(lockRow.holder).toBe('restore:123:test');
    restored.close();
  });

  test('refuses to complete when a task references an artifact directory that no longer exists under artifactRoot, and never touches the live DB', async () => {
    const artifactRoot = join(tmpDir, 'artifacts');
    const runDir = join(artifactRoot, 'runs', 'run-1');
    mkdirSync(runDir, { recursive: true });
    await store.enqueueTask({ sessionId: 's1', issueNumber: 1, phase: 'implementation', now: '2026-01-01T00:00:00.000Z' });
    const raw = new Database(dbPath);
    raw.prepare(`UPDATE tasks SET context = ? WHERE session_id = 's1' AND issue_number = 1`).run(
      JSON.stringify({ artifactDir: runDir }),
    );
    raw.close();
    const backupResult = await createBackup(dbPath, backupDir, '2026-01-01T00:05:00.000Z');
    store.close();

    // The referenced directory is gone by restore time.
    rmSync(runDir, { recursive: true, force: true });

    const result = await restoreBackup(dbPath, backupResult.entry.id, backupDir, '2026-01-01T00:10:00.000Z', {
      artifactRoot,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/artifactDir/);

    // The live DB must be untouched — restore failed before the rename.
    const stillLive = new SqliteTaskStore(dbPath);
    const tasks = await stillLive.listSessionTasks('s1');
    expect(tasks.map((t) => t.issueNumber)).toEqual([1]);
    stillLive.close();
  });

  test('succeeds when a referenced artifact directory still exists under artifactRoot', async () => {
    const artifactRoot = join(tmpDir, 'artifacts');
    const runDir = join(artifactRoot, 'runs', 'run-1');
    mkdirSync(runDir, { recursive: true });
    await store.enqueueTask({ sessionId: 's1', issueNumber: 1, phase: 'implementation', now: '2026-01-01T00:00:00.000Z' });
    const raw = new Database(dbPath);
    raw.prepare(`UPDATE tasks SET context = ? WHERE session_id = 's1' AND issue_number = 1`).run(
      JSON.stringify({ artifactDir: runDir }),
    );
    raw.close();
    const backupResult = await createBackup(dbPath, backupDir, '2026-01-01T00:05:00.000Z');
    store.close();

    const result = await restoreBackup(dbPath, backupResult.entry.id, backupDir, '2026-01-01T00:10:00.000Z', {
      artifactRoot,
    });
    expect(result.ok).toBe(true);
  });

  test('scopes artifact-reference validation to artifactRootSessionId, ignoring other sessions\' roots (issue #611 review)', async () => {
    // Two sessions share one database but use different artifact roots.
    // Session A's root does not contain session B's artifactDir at all —
    // that must not fail a restore that only validates session A.
    const artifactRootA = join(tmpDir, 'artifacts-a');
    const artifactRootB = join(tmpDir, 'artifacts-b');
    const runDirA = join(artifactRootA, 'runs', 'run-1');
    const runDirB = join(artifactRootB, 'runs', 'run-1');
    mkdirSync(runDirA, { recursive: true });
    mkdirSync(runDirB, { recursive: true });

    await store.enqueueTask({ sessionId: 'session-a', issueNumber: 1, phase: 'implementation', now: '2026-01-01T00:00:00.000Z' });
    await store.enqueueTask({ sessionId: 'session-b', issueNumber: 1, phase: 'implementation', now: '2026-01-01T00:00:00.000Z' });
    const raw = new Database(dbPath);
    raw.prepare(`UPDATE tasks SET context = ? WHERE session_id = 'session-a' AND issue_number = 1`).run(
      JSON.stringify({ artifactDir: runDirA }),
    );
    raw.prepare(`UPDATE tasks SET context = ? WHERE session_id = 'session-b' AND issue_number = 1`).run(
      JSON.stringify({ artifactDir: runDirB }),
    );
    raw.close();
    const backupResult = await createBackup(dbPath, backupDir, '2026-01-01T00:05:00.000Z');
    store.close();

    const scoped = await restoreBackup(dbPath, backupResult.entry.id, backupDir, '2026-01-01T00:10:00.000Z', {
      artifactRoot: artifactRootA,
      artifactRootSessionId: 'session-a',
    });
    expect(scoped.ok).toBe(true);

    // Without scoping, the same artifactRoot rejects session B's row.
    const unscoped = await restoreBackup(dbPath, backupResult.entry.id, backupDir, '2026-01-01T00:11:00.000Z', {
      artifactRoot: artifactRootA,
    });
    expect(unscoped.ok).toBe(false);
    expect(unscoped.error).toMatch(/artifactDir/);
  });

  test('refuses to complete when a task references a reviewArtifactDir that no longer exists under artifactRoot (issue #837 review)', async () => {
    // `reviewArtifactDir` is the dedicated, never-overwritten reference to the
    // review run that produced `review-findings.json`, carried forward across
    // implementation retries. It must be validated the same as `artifactDir`.
    const artifactRoot = join(tmpDir, 'artifacts');
    const runDir = join(artifactRoot, 'runs', 'review-run-1');
    mkdirSync(runDir, { recursive: true });
    await store.enqueueTask({ sessionId: 's1', issueNumber: 1, phase: 'implementation', now: '2026-01-01T00:00:00.000Z' });
    const raw = new Database(dbPath);
    raw.prepare(`UPDATE tasks SET context = ? WHERE session_id = 's1' AND issue_number = 1`).run(
      JSON.stringify({ reviewArtifactDir: runDir }),
    );
    raw.close();
    const backupResult = await createBackup(dbPath, backupDir, '2026-01-01T00:05:00.000Z');
    store.close();

    // The referenced directory is gone by restore time.
    rmSync(runDir, { recursive: true, force: true });

    const result = await restoreBackup(dbPath, backupResult.entry.id, backupDir, '2026-01-01T00:10:00.000Z', {
      artifactRoot,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/reviewArtifactDir/);

    // The live DB must be untouched — restore failed before the rename.
    const stillLive = new SqliteTaskStore(dbPath);
    const tasks = await stillLive.listSessionTasks('s1');
    expect(tasks.map((t) => t.issueNumber)).toEqual([1]);
    stillLive.close();
  });

  test('preserves the live file it replaced via a hard link, not a rename, so dbPath is never briefly absent (issue #611 review)', async () => {
    await store.enqueueTask({ sessionId: 's1', issueNumber: 1, phase: 'implementation', now: '2026-01-01T00:00:00.000Z' });
    const backupResult = await createBackup(dbPath, backupDir, '2026-01-01T00:05:00.000Z');
    const liveInoBeforeRestore = statSync(dbPath).ino;
    store.close();

    const result = await restoreBackup(dbPath, backupResult.entry.id, backupDir, '2026-01-01T00:10:00.000Z');
    expect(result.ok).toBe(true);

    // A hard link shares the pre-restore file's inode; a rename-then-replace
    // would instead have left the pre-restore path pointing at a distinct,
    // never-absent-but-copied file.
    expect(statSync(result.preRestorePath).ino).toBe(liveInoBeforeRestore);
    expect(statSync(dbPath).ino).not.toBe(liveInoBeforeRestore);
  });
});
