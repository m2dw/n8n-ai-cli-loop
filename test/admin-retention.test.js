import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import { SqliteTaskStore } from '../dist/index.js';

// Issue #611 — retention/archival/pruning/SQLite-backup admin commands.

const CLI = new URL('../dist/cli/admin.js', import.meta.url).pathname;
const OLD_TERMINAL = '2024-01-01T00:00:00.000Z'; // safely > 180 days before any realistic test-run clock

let tmpDir;
let dbPath;
let sessionsPath;
let backupDir;

function run(...args) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
    return { code: 0, stdout };
  } catch (err) {
    return { code: err.status ?? 1, stdout: err.stdout ?? '' };
  }
}

function parse(result) {
  return JSON.parse(result.stdout.trim());
}

function writeSession(overrides = {}) {
  const session = {
    sessionId: 'addon-dev',
    repoKey: 'some-repo',
    repoRoot: join(tmpDir, 'repo'),
    githubRepo: 'm2dw/some-repo',
    artifactDir: '.n8n-artifacts',
    defaults: { implementationAgent: 'claude', reviewAgent: 'codex' },
    verification: {},
    labels: { active: 'ai:active', blocked: 'ai:blocked', readyForHuman: 'ai:ready-for-human' },
    ...overrides,
  };
  writeFileSync(sessionsPath, JSON.stringify({ sessions: [session] }), 'utf8');
  return session;
}

async function seedOldDoneTaskWithReviewEvent(issueNumber) {
  const store = new SqliteTaskStore(dbPath);
  await store.enqueueTask({ sessionId: 'addon-dev', issueNumber, phase: 'implementation', now: OLD_TERMINAL });
  await store.transitionTask(
    { sessionId: 'addon-dev', issueNumber },
    { status: 'queued' },
    { status: 'done', now: OLD_TERMINAL },
  );
  await store.appendEvent({
    task: { sessionId: 'addon-dev', issueNumber },
    type: 'human_review_return',
    createdAt: OLD_TERMINAL,
  });
  store.close();
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'admin-retention-test-'));
  dbPath = join(tmpDir, 'dev_loop.db');
  sessionsPath = join(tmpDir, 'sessions.json');
  backupDir = join(tmpDir, 'backups');
  writeSession();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('admin backup', () => {
  test('create produces a verified backup; list shows it', async () => {
    const store = new SqliteTaskStore(dbPath);
    await store.enqueueTask({ sessionId: 'addon-dev', issueNumber: 1, phase: 'implementation' });
    store.close();

    const created = parse(run('backup', 'create', '--db-path', dbPath, '--backup-dir', backupDir));
    expect(created.ok).toBe(true);
    expect(created.entry.taskCount).toBe(1);

    const listed = parse(run('backup', 'list', '--db-path', dbPath, '--backup-dir', backupDir));
    expect(listed.ok).toBe(true);
    expect(listed.entries.length).toBe(1);
    expect(listed.entries[0].id).toBe(created.entry.id);
  });

  test('restore requires --yes and preserves the file it replaces', async () => {
    const store = new SqliteTaskStore(dbPath);
    await store.enqueueTask({ sessionId: 'addon-dev', issueNumber: 1, phase: 'implementation' });
    store.close();
    const created = parse(run('backup', 'create', '--db-path', dbPath, '--backup-dir', backupDir));

    const preview = parse(run('backup', 'restore', '--db-path', dbPath, '--backup-dir', backupDir, '--id', created.entry.id));
    expect(preview.wouldRestore).toBe(true);

    const restored = parse(
      run('backup', 'restore', '--db-path', dbPath, '--backup-dir', backupDir, '--id', created.entry.id, '--yes'),
    );
    expect(restored.ok).toBe(true);
    expect(restored.preRestorePath).toBeTruthy();
    expect(restored.artifactCheckSkipped).toBe(true);

    // The restored (now-live) file carries a lock this invocation released
    // cleanly on exit — no lock row left behind (issue #611 review).
    const db = new Database(dbPath, { readonly: true });
    const lockRow = db.prepare('SELECT holder FROM maintenance_lock WHERE id = 1').get();
    expect(lockRow).toBeUndefined();
    db.close();
  });

  test('restore succeeds when the live database is missing, seeding a protected lock before the swap (issue #611 review)', async () => {
    const store = new SqliteTaskStore(dbPath);
    await store.enqueueTask({ sessionId: 'addon-dev', issueNumber: 1, phase: 'implementation' });
    store.close();
    const created = parse(run('backup', 'create', '--db-path', dbPath, '--backup-dir', backupDir));

    // Simulate a deleted/missing live database — restore must fail closed
    // (seed a protected stub + lock) rather than skip lock acquisition, or a
    // worker recreating dbPath in the gap could have its write silently
    // overwritten by the restored backup.
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-wal`, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });

    const restored = parse(
      run('backup', 'restore', '--db-path', dbPath, '--backup-dir', backupDir, '--id', created.entry.id, '--yes'),
    );
    expect(restored.ok).toBe(true);

    // The restored file carries the task from the backup, and the lock this
    // invocation seeded/adopted was released cleanly on exit.
    const db = new Database(dbPath, { readonly: true });
    const taskCount = db.prepare('SELECT COUNT(*) AS c FROM tasks').get().c;
    expect(taskCount).toBe(1);
    const lockRow = db.prepare('SELECT holder FROM maintenance_lock WHERE id = 1').get();
    expect(lockRow).toBeUndefined();
    db.close();
  });

  test('restore refuses when --artifact-root is given and a referenced artifact directory is gone', async () => {
    const artifactRoot = join(tmpDir, 'artifacts');
    const runDir = join(artifactRoot, 'runs', 'run-1');
    mkdirSync(runDir, { recursive: true });

    const store = new SqliteTaskStore(dbPath);
    await store.enqueueTask({ sessionId: 'addon-dev', issueNumber: 1, phase: 'implementation' });
    store.close();
    const raw = new Database(dbPath);
    raw.prepare(`UPDATE tasks SET context = ? WHERE session_id = 'addon-dev' AND issue_number = 1`).run(
      JSON.stringify({ artifactDir: runDir }),
    );
    raw.close();

    const created = parse(run('backup', 'create', '--db-path', dbPath, '--backup-dir', backupDir));
    rmSync(runDir, { recursive: true, force: true });

    const restored = run(
      'backup',
      'restore',
      '--db-path',
      dbPath,
      '--backup-dir',
      backupDir,
      '--id',
      created.entry.id,
      '--artifact-root',
      artifactRoot,
      '--yes',
    );
    expect(restored.code).not.toBe(0);
    const parsed = parse(restored);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(/artifactDir/);

    // The live DB (still holding issue 1) must be untouched.
    const stillLive = new SqliteTaskStore(dbPath);
    const task = await stillLive.getTask({ sessionId: 'addon-dev', issueNumber: 1 });
    stillLive.close();
    expect(task).toBeDefined();
  });
});

describe('admin maintenance preview', () => {
  test('reports eligible and excluded task counts without mutating anything', async () => {
    await seedOldDoneTaskWithReviewEvent(1);
    const store = new SqliteTaskStore(dbPath);
    await store.enqueueTask({ sessionId: 'addon-dev', issueNumber: 2, phase: 'implementation' }); // active — stays queued
    store.close();

    const preview = parse(run('maintenance', 'preview', '--session-id', 'addon-dev', '--db-path', dbPath, '--json'));
    expect(preview.eligible.map((c) => c.issueNumber)).toEqual([1]);
    expect(preview.excluded.active).toBe(1);

    // Preview must not have mutated anything.
    const store2 = new SqliteTaskStore(dbPath);
    const task = await store2.getTask({ sessionId: 'addon-dev', issueNumber: 1 });
    store2.close();
    expect(task).toBeDefined();
  });

  test('never creates retention_* tables on the database (read-only, issue #611 review)', async () => {
    await seedOldDoneTaskWithReviewEvent(1);

    parse(run('maintenance', 'preview', '--session-id', 'addon-dev', '--db-path', dbPath, '--json'));

    const raw = new Database(dbPath, { readonly: true });
    const tables = raw.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'retention_%'`).all();
    raw.close();
    expect(tables).toEqual([]);
  });
});

describe('admin prune run gating', () => {
  test('refuses without --yes to mutate, and refuses --yes without a fresh backup', async () => {
    await seedOldDoneTaskWithReviewEvent(1);

    const dryRun = parse(run('prune', 'run', '--session-id', 'addon-dev', '--db-path', dbPath, '--json'));
    expect(dryRun.wouldPrune).toBe(true);

    // No backup created yet — --yes must refuse (§8's hard precondition).
    const noBackup = parse(run('prune', 'run', '--session-id', 'addon-dev', '--db-path', dbPath, '--backup-dir', backupDir, '--yes', '--json'));
    expect(noBackup.ok).toBe(false);
    expect(noBackup.reason).toBe('backup_precondition_failed');
  });

  test('an old task with an unresolved Tool Request does not block coverage gating for other eligible tasks (issue #611 review)', async () => {
    // Issue #1: old, terminal, but carries an unresolved Tool Request — never
    // eligible for deletion regardless of age.
    await seedOldDoneTaskWithReviewEvent(1);
    const raw = new Database(dbPath);
    raw
      .prepare(`UPDATE tasks SET context = ? WHERE session_id = 'addon-dev' AND issue_number = 1`)
      .run(JSON.stringify({ toolRequest: {} }));
    raw.close();

    // Issue #2: old, terminal, no Tool Request — eligible, and updated later
    // than issue #1.
    const store = new SqliteTaskStore(dbPath);
    await store.enqueueTask({ sessionId: 'addon-dev', issueNumber: 2, phase: 'implementation', now: '2024-06-01T00:00:00.000Z' });
    await store.transitionTask(
      { sessionId: 'addon-dev', issueNumber: 2 },
      { status: 'queued' },
      { status: 'done', now: '2024-06-01T00:00:00.000Z' },
    );
    store.close();

    // Rollup coverage starts after issue #1's updatedAt but still covers
    // issue #2's — issue #1 (never a deletion candidate) is deliberately left
    // uncovered.
    run('archive', 'rollup', '--session-id', 'addon-dev', '--db-path', dbPath, '--since', '2024-02-01T00:00:00.000Z', '--json');
    run('backup', 'create', '--db-path', dbPath, '--backup-dir', backupDir);

    const result = parse(
      run('prune', 'run', '--session-id', 'addon-dev', '--db-path', dbPath, '--backup-dir', backupDir, '--yes', '--json'),
    );
    expect(result.ok).toBe(true);
    expect(result.reason).not.toBe('rollup_coverage_missing');
    expect(result.tasksDeleted).toBe(1);

    const store2 = new SqliteTaskStore(dbPath);
    const task1 = await store2.getTask({ sessionId: 'addon-dev', issueNumber: 1 });
    const task2 = await store2.getTask({ sessionId: 'addon-dev', issueNumber: 2 });
    store2.close();
    expect(task1).toBeDefined(); // unresolved Tool Request — never pruned
    expect(task2).toBeUndefined(); // eligible — pruned
  });

  test('refuses --yes without rollup coverage even when a fresh backup exists', async () => {
    await seedOldDoneTaskWithReviewEvent(1);
    run('backup', 'create', '--db-path', dbPath, '--backup-dir', backupDir);

    const result = parse(run('prune', 'run', '--session-id', 'addon-dev', '--db-path', dbPath, '--backup-dir', backupDir, '--yes', '--json'));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('rollup_coverage_missing');
  });
});

describe('admin interventions reproducibility after prune (§6)', () => {
  test('a rollup generated before pruning keeps the intervention count intact after the raw event row is gone', async () => {
    await seedOldDoneTaskWithReviewEvent(42);

    const before = parse(run('interventions', '--session-id', 'addon-dev', '--db-path', dbPath, '--json'));
    expect(before.bySignal.human_review_return).toBe(1);

    const rollup = parse(run('archive', 'rollup', '--session-id', 'addon-dev', '--db-path', dbPath, '--json'));
    expect(rollup.entriesWritten).toBeGreaterThanOrEqual(1);

    const backup = parse(run('backup', 'create', '--db-path', dbPath, '--backup-dir', backupDir));
    expect(backup.ok).toBe(true);

    const pruneResult = parse(
      run('prune', 'run', '--session-id', 'addon-dev', '--db-path', dbPath, '--backup-dir', backupDir, '--yes', '--json'),
    );
    expect(pruneResult.ok).toBe(true);
    expect(pruneResult.tasksDeleted).toBe(1);

    // Raw task+event rows are gone...
    const store = new SqliteTaskStore(dbPath);
    const task = await store.getTask({ sessionId: 'addon-dev', issueNumber: 42 });
    store.close();
    expect(task).toBeUndefined();

    // ...but `admin interventions` still reports the same count, from the rollup.
    const after = parse(run('interventions', '--session-id', 'addon-dev', '--db-path', dbPath, '--json'));
    expect(after.bySignal.human_review_return).toBe(1);
    expect(after.total).toBe(before.total);
  });

  test('prune status reflects a completed watermark after a successful run', async () => {
    await seedOldDoneTaskWithReviewEvent(7);
    run('archive', 'rollup', '--session-id', 'addon-dev', '--db-path', dbPath, '--json');
    run('backup', 'create', '--db-path', dbPath, '--backup-dir', backupDir);
    run('prune', 'run', '--session-id', 'addon-dev', '--db-path', dbPath, '--backup-dir', backupDir, '--yes', '--json');

    const status = parse(run('prune', 'status', '--session-id', 'addon-dev', '--db-path', dbPath, '--json'));
    expect(status.watermark.status).toBe('complete');
  });
});
