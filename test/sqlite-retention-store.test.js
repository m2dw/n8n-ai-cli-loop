import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import { SqliteTaskStore } from '../dist/stores/sqlite-task-store.js';
import { SqliteRetentionStore } from '../dist/stores/sqlite-retention-store.js';

const NOW = '2026-06-01T00:00:00.000Z';
const OLD_TERMINAL = '2025-11-01T00:00:00.000Z'; // > 180d before NOW
const RECENT_TERMINAL = '2026-05-01T00:00:00.000Z'; // < 180d before NOW
const OLD_CANCELLED = '2026-04-01T00:00:00.000Z'; // > 30d before NOW
const FAR_FUTURE = '2099-01-01T00:00:00.000Z';

let tmpDir;
let dbPath;
let db;
let retentionStore;

function seedTask(
  sessionId,
  issueNumber,
  {
    status,
    updatedAt,
    createdAt = updatedAt,
    context = {},
    notBefore = null,
    leaseExpiresAt = null,
    phase = 'implementation',
  },
) {
  db.prepare(
    `INSERT INTO tasks (session_id, issue_number, status, phase, priority, attempts, context, created_at, updated_at, not_before, lease_expires_at, revision)
     VALUES (?, ?, ?, ?, 'normal', '{}', ?, ?, ?, ?, ?, 0)`,
  ).run(sessionId, issueNumber, status, phase, JSON.stringify(context), createdAt, updatedAt, notBefore, leaseExpiresAt);
}

function seedEvent(sessionId, issueNumber, type, createdAt) {
  db.prepare(`INSERT INTO events (session_id, issue_number, type, created_at) VALUES (?, ?, ?, ?)`).run(
    sessionId,
    issueNumber,
    type,
    createdAt,
  );
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'sqlite-retention-store-test-'));
  dbPath = join(tmpDir, 'test.db');
  // Establish the tasks/events schema (SqliteRetentionStore requires the file
  // to already exist and own no schema of its own beyond its retention_* tables).
  const bootstrap = new SqliteTaskStore(dbPath);
  bootstrap.close();
  db = new Database(dbPath);
  retentionStore = undefined;
});

afterEach(() => {
  retentionStore?.close();
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('readonly mode (issue #611 review)', () => {
  test('preview works against a fresh database and never creates the retention_* tables', () => {
    seedTask('s1', 1, { status: 'done', updatedAt: OLD_TERMINAL });

    const readonlyStore = new SqliteRetentionStore(dbPath, { readonly: true });
    try {
      const preview = readonlyStore.previewTaskPruneCandidates('s1', NOW);
      expect(preview.eligible.map((c) => c.issueNumber)).toEqual([1]);
      expect(preview.rollupCovered).toBe(false); // no rollup exists — table absent, not just empty
    } finally {
      readonlyStore.close();
    }

    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'retention_%'`).all();
    expect(tables).toEqual([]);
  });
});

describe('previewTaskPruneCandidates', () => {
  beforeEach(() => {
    retentionStore = new SqliteRetentionStore(dbPath);
  });

  test('excludes active, delayed, and human-gated tasks regardless of age', () => {
    seedTask('s1', 1, { status: 'queued', updatedAt: OLD_TERMINAL }); // active
    seedTask('s1', 2, { status: 'queued', updatedAt: OLD_TERMINAL, notBefore: FAR_FUTURE }); // delayed
    seedTask('s1', 3, { status: 'ready_for_human', updatedAt: OLD_TERMINAL }); // human_gated
    seedTask('s1', 4, { status: 'blocked', updatedAt: OLD_TERMINAL }); // human_gated
    seedTask('s1', 5, { status: 'claimed', updatedAt: OLD_TERMINAL, leaseExpiresAt: OLD_TERMINAL }); // active (stale claim is still active — recovery concern, not retention)

    const preview = retentionStore.previewTaskPruneCandidates('s1', NOW);
    expect(preview.eligible).toEqual([]);
    expect(preview.excluded.active).toBe(2);
    expect(preview.excluded.delayed).toBe(1);
    expect(preview.excluded.human_gated).toBe(2);
  });

  test('terminal and cancelled tasks are within-floor until they age past their respective retention floor', () => {
    seedTask('s1', 1, { status: 'done', updatedAt: RECENT_TERMINAL });
    seedTask('s1', 2, { status: 'done', updatedAt: OLD_TERMINAL });
    seedTask('s1', 3, { status: 'cancelled', updatedAt: OLD_CANCELLED });

    const preview = retentionStore.previewTaskPruneCandidates('s1', NOW);
    expect(preview.excluded.within_floor).toBe(1);
    expect(preview.eligible.map((c) => c.issueNumber).sort()).toEqual([2, 3]);
    expect(preview.eligible.find((c) => c.issueNumber === 2).bucket).toBe('terminal');
    expect(preview.eligible.find((c) => c.issueNumber === 3).bucket).toBe('cancelled');
  });

  test('excludes a task carrying an unresolved Tool Request regardless of status or age', () => {
    seedTask('s1', 1, {
      status: 'done',
      updatedAt: OLD_TERMINAL,
      context: { toolRequest: { command: 'npm install x', resolved: false } },
    });

    const preview = retentionStore.previewTaskPruneCandidates('s1', NOW);
    expect(preview.eligible).toEqual([]);
    expect(preview.excluded.unresolved_tool_request).toBe(1);
  });

  test('reports rollup coverage as missing when eligible candidates exist but no rollup has been generated', () => {
    seedTask('s1', 1, { status: 'done', updatedAt: OLD_TERMINAL });
    const preview = retentionStore.previewTaskPruneCandidates('s1', NOW);
    expect(preview.rollupCovered).toBe(false);
    expect(preview.rollupCoverageReason).toMatch(/no intervention rollup/);
  });

  test('reports rollup coverage as satisfied (vacuously) when there is nothing eligible', () => {
    seedTask('s1', 1, { status: 'queued', updatedAt: OLD_TERMINAL });
    const preview = retentionStore.previewTaskPruneCandidates('s1', NOW);
    expect(preview.rollupCovered).toBe(true);
  });
});

describe('generateInterventionRollup + checkRollupCoverageForCandidates', () => {
  beforeEach(() => {
    retentionStore = new SqliteRetentionStore(dbPath);
  });

  test('a generated rollup covers the current time and satisfies the coverage check for eligible candidates', () => {
    seedTask('s1', 1, { status: 'done', updatedAt: OLD_TERMINAL });
    seedEvent('s1', 1, 'human_review_return', OLD_TERMINAL);

    const rollup = retentionStore.generateInterventionRollup('s1', {}, NOW);
    expect(rollup.entriesWritten).toBe(1);

    const preview = retentionStore.previewTaskPruneCandidates('s1', NOW);
    expect(preview.rollupCovered).toBe(true);
  });

  test('does not cover a window newer than the rollup was generated for', () => {
    seedTask('s1', 1, { status: 'done', updatedAt: OLD_TERMINAL });
    retentionStore.generateInterventionRollup('s1', {}, OLD_TERMINAL); // rollup generated far in the past

    const coverage = retentionStore.checkRollupCoverageForCandidates('s1', [
      { issueNumber: 1, bucket: 'terminal', updatedAt: NOW, ageMs: 0 },
    ]);
    expect(coverage.covered).toBe(false);
  });

  test('a limited rollup does not authorize deleting a task whose L3 event predates --since even though updated_at falls inside the window (issue #611 review)', () => {
    // The task's own updated_at falls inside [since, until) ...
    seedTask('s1', 1, { status: 'done', updatedAt: '2025-11-15T00:00:00.000Z' });
    // ... but the event it owns is older than --since, so a rollup limited to
    // --since excludes it (generateInterventionRollup's own inWindow filter).
    seedEvent('s1', 1, 'human_review_return', '2025-10-01T00:00:00.000Z');
    const rollup = retentionStore.generateInterventionRollup('s1', { since: '2025-11-10T00:00:00.000Z' }, NOW);
    expect(rollup.entriesWritten).toBe(0);

    // Checking updated_at alone (the pre-fix behavior) would report this
    // covered, since '2025-11-10' <= '2025-11-15' <= NOW — letting prune
    // delete a task whose earlier event was never recorded in any rollup.
    const coverage = retentionStore.checkRollupCoverageForCandidates('s1', [
      { issueNumber: 1, bucket: 'terminal', updatedAt: '2025-11-15T00:00:00.000Z', ageMs: 0 },
    ]);
    expect(coverage.covered).toBe(false);
  });
});

describe('pruneTasks', () => {
  beforeEach(() => {
    retentionStore = new SqliteRetentionStore(dbPath);
  });

  function primeCoverage(sessionId, now = NOW) {
    retentionStore.generateInterventionRollup(sessionId, {}, now);
  }

  test('deletes only eligible terminal/cancelled tasks and their events, leaving active/human-gated rows untouched', () => {
    seedTask('s1', 1, { status: 'done', updatedAt: OLD_TERMINAL });
    seedEvent('s1', 1, 'phase.completed', OLD_TERMINAL);
    seedTask('s1', 2, { status: 'queued', updatedAt: OLD_TERMINAL }); // active — must survive
    seedTask('s1', 3, { status: 'ready_for_human', updatedAt: OLD_TERMINAL }); // human-gated — must survive
    primeCoverage('s1');

    const result = retentionStore.pruneTasks('s1', NOW, {});
    expect(result.status).toBe('complete');
    expect(result.tasksDeleted).toBe(1);
    expect(result.eventsDeleted).toBe(1);

    const remaining = db.prepare('SELECT issue_number FROM tasks WHERE session_id = ? ORDER BY issue_number').all('s1');
    expect(remaining.map((r) => r.issue_number)).toEqual([2, 3]);
  });

  test('a session-scoped prune never touches another session sharing the same file', () => {
    seedTask('s1', 1, { status: 'done', updatedAt: OLD_TERMINAL });
    seedTask('s2', 1, { status: 'done', updatedAt: OLD_TERMINAL });
    primeCoverage('s1');

    const result = retentionStore.pruneTasks('s1', NOW, {});
    expect(result.tasksDeleted).toBe(1);

    const s2Count = db.prepare('SELECT COUNT(*) AS c FROM tasks WHERE session_id = ?').get('s2').c;
    expect(s2Count).toBe(1);
  });

  test('idempotent rerun: pruning again after completion finds nothing further to delete', () => {
    seedTask('s1', 1, { status: 'done', updatedAt: OLD_TERMINAL });
    primeCoverage('s1');

    const first = retentionStore.pruneTasks('s1', NOW, {});
    expect(first.tasksDeleted).toBe(1);

    const second = retentionStore.pruneTasks('s1', NOW, {});
    expect(second.tasksDeleted).toBe(0);
    expect(second.status).toBe('no_candidates');
  });

  test('resumes from an in-progress watermark rather than re-scanning the already-covered range', () => {
    // A prior run is simulated as having already progressed through issue 15
    // before crashing; issue 5 is deliberately seeded fresh, below the
    // watermark cursor, to prove a resumed run does not rescan below it.
    seedTask('s1', 5, { status: 'done', updatedAt: OLD_TERMINAL });
    seedTask('s1', 20, { status: 'done', updatedAt: OLD_TERMINAL });
    primeCoverage('s1');
    db.prepare(
      `INSERT INTO retention_prune_watermark (session_id, data_class, status, last_issue_number, started_at, updated_at)
       VALUES ('s1', 'tasks', 'in_progress', 15, ?, ?)`,
    ).run(NOW, NOW);

    const result = retentionStore.pruneTasks('s1', NOW, { batchSize: 10 });
    expect(result.tasksDeleted).toBe(1);

    const remaining = db.prepare('SELECT issue_number FROM tasks WHERE session_id = ?').all('s1').map((r) => r.issue_number);
    expect(remaining).toEqual([5]);
  });

  test('refuses to delete raw rows the rollup does not cover, and preserves resumability', () => {
    seedTask('s1', 1, { status: 'done', updatedAt: OLD_TERMINAL });
    // No rollup generated at all.
    const result = retentionStore.pruneTasks('s1', NOW, {});
    expect(result.status).toBe('rollup_coverage_missing');
    expect(result.tasksDeleted).toBe(0);

    const remaining = db.prepare('SELECT COUNT(*) AS c FROM tasks WHERE session_id = ?').get('s1').c;
    expect(remaining).toBe(1);
  });

  test('a limited rollup does not authorize pruning a task whose earlier L3 event it excluded (issue #611 review)', () => {
    seedTask('s1', 1, { status: 'done', updatedAt: '2025-11-15T00:00:00.000Z' });
    seedEvent('s1', 1, 'human_review_return', '2025-10-01T00:00:00.000Z');
    retentionStore.generateInterventionRollup('s1', { since: '2025-11-10T00:00:00.000Z' }, NOW);

    const result = retentionStore.pruneTasks('s1', NOW, {});
    expect(result.status).toBe('rollup_coverage_missing');
    expect(result.tasksDeleted).toBe(0);
    expect(result.eventsDeleted).toBe(0);

    // The task row and its never-rolled-up event both survive — deleting
    // either here without a rollup entry recorded for the event would make
    // `admin interventions` silently undercount it forever.
    const remainingTasks = db.prepare('SELECT COUNT(*) AS c FROM tasks WHERE session_id = ?').get('s1').c;
    expect(remainingTasks).toBe(1);
    const remainingEvents = db.prepare('SELECT COUNT(*) AS c FROM events WHERE session_id = ?').get('s1').c;
    expect(remainingEvents).toBe(1);
  });

  test('a task requeued/resolved between selection and delete survives the batch (commit-time re-validation)', () => {
    seedTask('s1', 1, {
      status: 'done',
      updatedAt: OLD_TERMINAL,
      context: { toolRequest: { command: 'x', resolved: false } },
    });
    primeCoverage('s1');

    const result = retentionStore.pruneTasks('s1', NOW, {});
    // The candidate scan's own WHERE clause (issue #611 review) already
    // excludes an unresolved Tool Request row, so this task is never offered
    // as a candidate here — but the conditional DELETE's WHERE clause
    // independently re-checks the same exclusion at commit time (§9's second
    // compliant race-closure option), which is what actually guards the case
    // this test's name describes: a request resolved between an earlier
    // selection and the delete. Either way the task survives.
    expect(result.tasksDeleted).toBe(0);
    const remaining = db.prepare('SELECT COUNT(*) AS c FROM tasks WHERE session_id = ?').get('s1').c;
    expect(remaining).toBe(1);
  });

  test('an unresolved Tool Request on an old row does not block coverage gating for other eligible rows in the same batch (issue #611 review)', () => {
    // Issue #1 is never a deletion candidate (unresolved Tool Request), and
    // its updatedAt deliberately predates the rollup's coverage window.
    seedTask('s1', 1, {
      status: 'done',
      updatedAt: OLD_TERMINAL,
      context: { toolRequest: { command: 'x', resolved: false } },
    });
    // Issue #2 is a real, eligible candidate, updated later than issue #1
    // but still past the terminal retention floor.
    seedTask('s1', 2, { status: 'done', updatedAt: '2025-11-20T00:00:00.000Z' });
    // Coverage starts after issue #1's updatedAt but before issue #2's —
    // issue #1 (never a candidate) is deliberately left uncovered.
    retentionStore.generateInterventionRollup('s1', { since: '2025-11-10T00:00:00.000Z' }, NOW);

    const result = retentionStore.pruneTasks('s1', NOW, {});
    expect(result.status).not.toBe('rollup_coverage_missing');
    expect(result.status).toBe('complete');
    expect(result.tasksDeleted).toBe(1);

    const remaining = db.prepare('SELECT issue_number FROM tasks WHERE session_id = ?').all('s1').map((r) => r.issue_number);
    expect(remaining).toEqual([1]);
  });

  test('marks an orphaned artifact directory pending rather than deleting it (automatic deletion disabled until outbox references are resolvable)', () => {
    const artifactRoot = join(tmpDir, 'artifacts');
    const dirShared = join(artifactRoot, 'runs', 'run-shared');
    const dirOrphaned = join(artifactRoot, 'runs', 'run-orphaned');
    mkdirSync(dirShared, { recursive: true });
    mkdirSync(dirOrphaned, { recursive: true });

    seedTask('s1', 1, { status: 'done', updatedAt: OLD_TERMINAL, context: { artifactDir: dirShared } });
    seedTask('s1', 2, { status: 'queued', updatedAt: OLD_TERMINAL, context: { artifactDir: dirShared } }); // active, keeps dirShared alive
    seedTask('s1', 3, { status: 'done', updatedAt: OLD_TERMINAL, context: { artifactDir: dirOrphaned } });
    primeCoverage('s1');

    const result = retentionStore.pruneTasks('s1', NOW, { artifactRoot });
    expect(result.tasksDeleted).toBe(2);
    // Neither directory is ever auto-deleted: dirShared is still referenced,
    // and dirOrphaned's eligibility can't rule out a live outbox reference
    // today, so it lands in `artifactsPending`, never `artifactsDeleted`.
    expect(existsSync(dirShared)).toBe(true);
    expect(existsSync(dirOrphaned)).toBe(true);
    expect(result.artifactsDeleted).toEqual([]);
    expect(result.artifactsPending).toEqual([dirOrphaned]);
    expect(result.artifactsSkipped).toEqual([dirShared]);
  });

  test('never deletes an artifact directory outside artifactRoot even if context claims one is there (symlink/escape safety)', () => {
    const artifactRoot = join(tmpDir, 'artifacts');
    mkdirSync(artifactRoot, { recursive: true });
    const outside = join(tmpDir, 'outside-secret');
    mkdirSync(outside, { recursive: true });

    seedTask('s1', 1, { status: 'done', updatedAt: OLD_TERMINAL, context: { artifactDir: outside } });
    primeCoverage('s1');

    const result = retentionStore.pruneTasks('s1', NOW, { artifactRoot });
    expect(result.tasksDeleted).toBe(1);
    expect(existsSync(outside)).toBe(true);
    expect(result.artifactsDeleted).toEqual([]);
  });
});
