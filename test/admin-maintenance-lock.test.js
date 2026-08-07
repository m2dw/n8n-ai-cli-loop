import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import { SqliteTaskStore } from '../dist/index.js';
import { SqliteOutboxStore } from '../dist/stores/sqlite-outbox-store.js';
import { SqliteMaintenanceLock, seedMaintenanceLock } from '../dist/stores/sqlite-maintenance-lock.js';

// Issue #817 — guarded status/force-release recovery for the whole-file
// maintenance lock (issue #611, docs/retention-backup-contract.md §9). A
// maintenance process killed before its finally/close() path runs leaves
// `maintenance_lock` populated with no live holder able to call release() —
// these commands are the supported recovery path (previously only direct
// SQLite editing).

const CLI = new URL('../dist/cli/admin.js', import.meta.url).pathname;

let tmpDir;
let dbPath;

function run(...args) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
    return { code: 0, stdout };
  } catch (err) {
    return { code: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

function parse(result) {
  return JSON.parse(result.stdout.trim());
}

function initDb() {
  const store = new SqliteTaskStore(dbPath);
  store.close();
  // Run the outbox claimed_at/cancelled_at migration up front: a DB touched
  // only by SqliteTaskStore lacks those columns, and SqliteMaintenanceLock
  // deliberately never migrates (issue #817 review — it must stay read-only
  // so it can inspect a legacy or read-only database), so raw seeding below
  // needs SqliteOutboxStore's own migration to have already run.
  new SqliteOutboxStore(dbPath).close();
}

// Simulates a stranded lock: writes the row directly, the way a real
// maintenance process would have via `acquire()` before being killed before
// its `finally`/`close()` path ran — never releasing via this process.
function seedStrandedLock(holder, acquiredAt) {
  const db = new Database(dbPath);
  seedMaintenanceLock(db, holder, acquiredAt);
  db.close();
}

async function seedClaimedTask(issueNumber, leaseExpiresAt) {
  const store = new SqliteTaskStore(dbPath);
  await store.enqueueTask({ sessionId: 'addon-dev', issueNumber, phase: 'implementation' });
  store.close();
  const db = new Database(dbPath);
  db.prepare(`UPDATE tasks SET status = 'claimed', lease_expires_at = ? WHERE session_id = ? AND issue_number = ?`).run(
    leaseExpiresAt,
    'addon-dev',
    issueNumber,
  );
  db.close();
}

function seedOutboxClaim(idempotencyKey, claimedAt) {
  const db = new Database(dbPath);
  db.prepare(
    `INSERT INTO outbox (idempotency_key, topic, payload, created_at, claimed_at) VALUES (?, 'gh:comment', '{}', ?, ?)`,
  ).run(idempotencyKey, claimedAt, claimedAt);
  db.close();
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'admin-maintenance-lock-test-'));
  dbPath = join(tmpDir, 'dev_loop.db');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('admin maintenance-lock status', () => {
  test('missing database reports unheld without error', () => {
    const r = run('maintenance-lock', 'status', '--session-id', 'addon-dev', '--db-path', dbPath, '--json');
    expect(r.code).toBe(0);
    const out = parse(r);
    expect(out.ok).toBe(true);
    expect(out.held).toBe(false);
  });

  test('reports an unheld lock with zero activity counts', () => {
    initDb();
    const r = run('maintenance-lock', 'status', '--session-id', 'addon-dev', '--db-path', dbPath, '--json');
    expect(r.code).toBe(0);
    const out = parse(r);
    expect(out.held).toBe(false);
    expect(out.holder).toBeUndefined();
    expect(out.phaseActiveCount).toBe(0);
    expect(out.outboxClaimActiveCount).toBe(0);
  });

  test('a deliberately stranded lock is visible through status: holder, acquiredAt, age', () => {
    initDb();
    const acquiredAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    seedStrandedLock('prune:1234:deadbeef', acquiredAt);

    const r = run('maintenance-lock', 'status', '--session-id', 'addon-dev', '--db-path', dbPath, '--json');
    expect(r.code).toBe(0);
    const out = parse(r);
    expect(out.held).toBe(true);
    expect(out.holder).toBe('prune:1234:deadbeef');
    expect(out.acquiredAt).toBe(acquiredAt);
    expect(out.ageMs).toBeGreaterThanOrEqual(5 * 60 * 1000 - 1000);
    // Public output never carries the local database path.
    expect(r.stdout).not.toContain(dbPath);
  });

  test('reports a live task phase and a non-stale outbox claim', async () => {
    initDb();
    await seedClaimedTask(55, new Date(Date.now() + 60 * 60 * 1000).toISOString());
    seedOutboxClaim('claim-key-1', new Date().toISOString());

    const r = run('maintenance-lock', 'status', '--session-id', 'addon-dev', '--db-path', dbPath, '--json');
    expect(r.code).toBe(0);
    const out = parse(r);
    expect(out.phaseActiveCount).toBe(1);
    expect(out.outboxClaimActiveCount).toBe(1);
  });

  test('human-readable output by default (no --json)', () => {
    initDb();
    seedStrandedLock('prune:1:aaaa', new Date().toISOString());
    const r = run('maintenance-lock', 'status', '--session-id', 'addon-dev', '--db-path', dbPath);
    expect(r.code).toBe(0);
    expect(() => JSON.parse(r.stdout.trim())).toThrow();
    expect(r.stdout).toContain('Held: yes');
    expect(r.stdout).toContain('prune:1:aaaa');
  });

  test('rejects unknown flags (fail fast)', () => {
    const r = run('maintenance-lock', 'status', '--session-id', 'addon-dev', '--db-path', dbPath, '--bogus');
    expect(r.code).toBe(1);
  });
});

describe('admin maintenance-lock release', () => {
  test('re-running release against an already-unlocked database is a safe no-op', () => {
    initDb();
    const r = run('maintenance-lock', 'release', '--session-id', 'addon-dev', '--db-path', dbPath, '--yes', '--json');
    expect(r.code).toBe(0);
    const out = parse(r);
    expect(out.ok).toBe(true);
    expect(out.released).toBe(false);
    expect(out.reason).toBe('not_held');
  });

  test('missing database is a safe no-op', () => {
    const r = run('maintenance-lock', 'release', '--session-id', 'addon-dev', '--db-path', dbPath, '--yes', '--json');
    expect(r.code).toBe(0);
    const out = parse(r);
    expect(out.released).toBe(false);
    expect(out.reason).toBe('no_database');
  });

  test('preview does not mutate the lock', () => {
    initDb();
    const acquiredAt = new Date(Date.now() - 60 * 1000).toISOString();
    seedStrandedLock('prune:1:bbbb', acquiredAt);

    const r = run('maintenance-lock', 'release', '--session-id', 'addon-dev', '--db-path', dbPath, '--json');
    expect(r.code).toBe(0);
    const out = parse(r);
    expect(out.wouldRelease).toBe(true);
    expect(out.holder).toBe('prune:1:bbbb');

    const lock = new SqliteMaintenanceLock(dbPath);
    expect(lock.inspect()).toEqual({ held: true, holder: 'prune:1:bbbb', acquiredAt });
    lock.close();
  });

  test('--yes alone is refused for a normal (non-exempt) holder — the exact race the review flagged (issue #817 review, P1)', () => {
    // A live `prune run --yes`/`restore` acquires an ordinary,
    // non-activityExempt lock and does its own destructive work without
    // ever creating a task lease or outbox claim — so zero of both counts
    // is not evidence it has finished, and --yes alone must not delete it.
    initDb();
    const acquiredAt = new Date(Date.now() - 60 * 1000).toISOString();
    seedStrandedLock('prune:1:cccc', acquiredAt);

    const r = run('maintenance-lock', 'release', '--session-id', 'addon-dev', '--db-path', dbPath, '--yes', '--json');
    expect(r.code).toBe(1);
    const out = parse(r);
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('confirmation_required');

    const lock = new SqliteMaintenanceLock(dbPath);
    expect(lock.inspect().held).toBe(true);
    lock.close();
  });

  test('--yes --confirm-stranded releases an inactive stranded lock', () => {
    initDb();
    const acquiredAt = new Date(Date.now() - 60 * 1000).toISOString();
    seedStrandedLock('prune:1:cccc', acquiredAt);

    const r = run(
      'maintenance-lock',
      'release',
      '--session-id',
      'addon-dev',
      '--db-path',
      dbPath,
      '--yes',
      '--confirm-stranded',
      '--json',
    );
    expect(r.code).toBe(0);
    const out = parse(r);
    expect(out.released).toBe(true);
    expect(out.holder).toBe('prune:1:cccc');
    // Never exposes the local database path.
    expect(r.stdout).not.toContain(dbPath);

    const lock = new SqliteMaintenanceLock(dbPath);
    expect(lock.inspect()).toEqual({ held: false });
    lock.close();
  });

  test('release is refused while a live claimed task phase exists, --yes included', async () => {
    initDb();
    seedStrandedLock('prune:1:dddd', new Date().toISOString());
    await seedClaimedTask(66, new Date(Date.now() + 60 * 60 * 1000).toISOString());

    const r = run('maintenance-lock', 'release', '--session-id', 'addon-dev', '--db-path', dbPath, '--yes', '--json');
    expect(r.code).toBe(1);
    const out = parse(r);
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('phase_active');
    expect(out.activeCount).toBe(1);

    const lock = new SqliteMaintenanceLock(dbPath);
    expect(lock.inspect().held).toBe(true);
    lock.close();
  });

  test('release is refused while a non-stale outbox dispatch claim exists, --yes included', () => {
    initDb();
    seedStrandedLock('prune:1:eeee', new Date().toISOString());
    seedOutboxClaim('claim-key-2', new Date().toISOString());

    const r = run('maintenance-lock', 'release', '--session-id', 'addon-dev', '--db-path', dbPath, '--yes', '--json');
    expect(r.code).toBe(1);
    const out = parse(r);
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('outbox_claim_active');
    expect(out.activeCount).toBe(1);

    const lock = new SqliteMaintenanceLock(dbPath);
    expect(lock.inspect().held).toBe(true);
    lock.close();
  });

  test('preview reports the refusal reason without releasing', async () => {
    initDb();
    seedStrandedLock('prune:1:ffff', new Date().toISOString());
    await seedClaimedTask(77, new Date(Date.now() + 60 * 60 * 1000).toISOString());

    const r = run('maintenance-lock', 'release', '--session-id', 'addon-dev', '--db-path', dbPath, '--json');
    expect(r.code).toBe(0);
    const out = parse(r);
    expect(out.wouldRelease).toBe(false);
    expect(out.phaseActiveCount).toBe(1);

    const lock = new SqliteMaintenanceLock(dbPath);
    expect(lock.inspect().held).toBe(true);
    lock.close();
  });

  test('force-release ignores the recorded holder', () => {
    initDb();
    // A stranded lock has no live holder able to call release() — force
    // release must still succeed, unauthenticated against any specific
    // holder, as long as no live phase/outbox claim exists and the operator
    // explicitly confirms.
    seedStrandedLock('some-other-process:9999:whatever', new Date(Date.now() - 60_000).toISOString());

    const r = run(
      'maintenance-lock',
      'release',
      '--session-id',
      'addon-dev',
      '--db-path',
      dbPath,
      '--yes',
      '--confirm-stranded',
      '--json',
    );
    expect(r.code).toBe(0);
    const out = parse(r);
    expect(out.released).toBe(true);
    expect(out.holder).toBe('some-other-process:9999:whatever');
  });

  test('existing owner-fenced normal release behavior is unchanged', () => {
    initDb();
    const lock = new SqliteMaintenanceLock(dbPath);
    const acquired = lock.acquire('archive-rollup:1:token', new Date().toISOString(), { skipActivityChecks: true });
    expect(acquired.ok).toBe(true);
    // The owning instance's own release() still works exactly as before —
    // unaffected by the new force-release recovery path.
    lock.release();
    expect(lock.inspect()).toEqual({ held: false });
    lock.close();
  });

  test('human-readable output by default (no --json)', () => {
    initDb();
    seedStrandedLock('prune:1:gggg', new Date().toISOString());
    const r = run('maintenance-lock', 'release', '--session-id', 'addon-dev', '--db-path', dbPath, '--yes', '--confirm-stranded');
    expect(r.code).toBe(0);
    expect(() => JSON.parse(r.stdout.trim())).toThrow();
    expect(r.stdout).toContain('prune:1:gggg');
  });

  test('rejects unknown flags (fail fast)', () => {
    const r = run('maintenance-lock', 'release', '--session-id', 'addon-dev', '--db-path', dbPath, '--bogus');
    expect(r.code).toBe(1);
  });
});

describe('unknown maintenance-lock action', () => {
  test('exits non-zero', () => {
    const r = run('maintenance-lock', 'bogus', '--session-id', 'addon-dev', '--db-path', dbPath);
    expect(r.code).toBe(1);
  });
});

// Issue #817 review, P1: the force-release guard must not remove a live
// archive-rollup lock — `admin archive rollup` acquires with
// `skipActivityChecks: true` and shows zero live task phases and zero
// non-stale outbox claims even while genuinely still running.
describe('admin maintenance-lock release — activity-exempt holder (issue #817 review)', () => {
  function seedActivityExemptLock(holder, acquiredAt) {
    seedStrandedLock(holder, acquiredAt);
    const db = new Database(dbPath);
    db.prepare('UPDATE maintenance_lock SET activity_exempt = 1 WHERE id = 1').run();
    db.close();
  }

  test('status reports activityExempt for a lock acquired via skipActivityChecks', () => {
    initDb();
    seedActivityExemptLock('archive-rollup:1:token', new Date().toISOString());

    const r = run('maintenance-lock', 'status', '--session-id', 'addon-dev', '--db-path', dbPath, '--json');
    expect(r.code).toBe(0);
    const out = parse(r);
    expect(out.held).toBe(true);
    expect(out.activityExempt).toBe(true);
  });

  test('preview reports zero live phases/claims but still requires --confirm-stranded', () => {
    initDb();
    seedActivityExemptLock('archive-rollup:1:token', new Date().toISOString());

    const r = run('maintenance-lock', 'release', '--session-id', 'addon-dev', '--db-path', dbPath, '--json');
    expect(r.code).toBe(0);
    const out = parse(r);
    expect(out.wouldRelease).toBe(true);
    expect(out.activityExempt).toBe(true);
    expect(out.hint).toContain('--confirm-stranded');
  });

  test('--yes alone is refused for an activity-exempt lock — the exact race the review flagged', () => {
    initDb();
    seedActivityExemptLock('archive-rollup:1:token', new Date().toISOString());

    const r = run('maintenance-lock', 'release', '--session-id', 'addon-dev', '--db-path', dbPath, '--yes', '--json');
    expect(r.code).toBe(1);
    const out = parse(r);
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('confirmation_required');
    expect(out.activityExempt).toBe(true);

    const lock = new SqliteMaintenanceLock(dbPath);
    expect(lock.inspect().held).toBe(true);
    lock.close();
  });

  test('--yes --confirm-stranded releases an activity-exempt lock', () => {
    initDb();
    seedActivityExemptLock('archive-rollup:1:token', new Date().toISOString());

    const r = run(
      'maintenance-lock',
      'release',
      '--session-id',
      'addon-dev',
      '--db-path',
      dbPath,
      '--yes',
      '--confirm-stranded',
      '--json',
    );
    expect(r.code).toBe(0);
    const out = parse(r);
    expect(out.released).toBe(true);
    expect(out.holder).toBe('archive-rollup:1:token');

    const lock = new SqliteMaintenanceLock(dbPath);
    expect(lock.inspect().held).toBe(false);
    lock.close();
  });
});

// Issue #817 review, P2: `status` and release-preview must stay strictly
// read-only — never creating `maintenance_lock` on a legacy database that
// predates it.
describe('admin maintenance-lock status/release — read-only inspection (issue #817 review)', () => {
  function tableExists(name) {
    const db = new Database(dbPath, { readonly: true });
    try {
      return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
    } finally {
      db.close();
    }
  }

  test('status never creates maintenance_lock on a database that predates it', () => {
    initDb();
    const db = new Database(dbPath);
    db.exec('DROP TABLE maintenance_lock');
    db.close();
    expect(tableExists('maintenance_lock')).toBe(false);

    const r = run('maintenance-lock', 'status', '--session-id', 'addon-dev', '--db-path', dbPath, '--json');
    expect(r.code).toBe(0);
    expect(parse(r).held).toBe(false);
    expect(tableExists('maintenance_lock')).toBe(false);
  });

  test('release preview (no --yes) never creates maintenance_lock on a database that predates it', () => {
    initDb();
    const db = new Database(dbPath);
    db.exec('DROP TABLE maintenance_lock');
    db.close();

    const r = run('maintenance-lock', 'release', '--session-id', 'addon-dev', '--db-path', dbPath, '--json');
    expect(r.code).toBe(0);
    expect(parse(r).reason).toBe('not_held');
    expect(tableExists('maintenance_lock')).toBe(false);
  });
});
