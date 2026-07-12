/**
 * Tests for L3 intervention aggregation (issue #588).
 *
 * Uses in-memory better-sqlite3 databases seeded with representative event
 * fixtures so the tests run without touching the host filesystem.
 */
import Database from 'better-sqlite3';
import {
  aggregateL3Interventions,
  L3_EVENT_TYPE_MAP,
  UNOBSERVABLE_L3_SIGNALS,
} from '../dist/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create an in-memory SQLite DB with the events and tasks schema. */
function createDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE events (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id   TEXT NOT NULL,
      issue_number INTEGER NOT NULL,
      type         TEXT NOT NULL,
      run_id       TEXT,
      message      TEXT,
      data         TEXT,
      created_at   TEXT NOT NULL
    );
    CREATE TABLE tasks (
      session_id   TEXT NOT NULL,
      issue_number INTEGER NOT NULL,
      status       TEXT NOT NULL DEFAULT 'queued',
      phase        TEXT NOT NULL DEFAULT 'implementation',
      priority     TEXT NOT NULL DEFAULT 'normal',
      attempts     TEXT NOT NULL DEFAULT '{}',
      context      TEXT NOT NULL DEFAULT '{}',
      created_at   TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z',
      updated_at   TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z',
      PRIMARY KEY (session_id, issue_number)
    );
  `);
  return db;
}

function insertEvent(db, sessionId, issueNumber, type, createdAt = '2026-01-15T10:00:00.000Z') {
  db.prepare(
    'INSERT INTO events (session_id, issue_number, type, created_at) VALUES (?, ?, ?, ?)',
  ).run(sessionId, issueNumber, type, createdAt);
}

function insertTask(db, sessionId, issueNumber, context = {}) {
  db.prepare(
    `INSERT INTO tasks (session_id, issue_number, context, created_at, updated_at)
     VALUES (?, ?, ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
  ).run(sessionId, issueNumber, JSON.stringify(context));
}

// ---------------------------------------------------------------------------
// L3_EVENT_TYPE_MAP integrity
// ---------------------------------------------------------------------------

describe('L3_EVENT_TYPE_MAP', () => {
  test('maps human_review_return events to the correct signal', () => {
    expect(L3_EVENT_TYPE_MAP['human_review_return']).toBe('human_review_return');
    expect(L3_EVENT_TYPE_MAP['github_app_review_return']).toBe('human_review_return');
  });

  test('maps tool_request events to the tool_request_resolution signal', () => {
    expect(L3_EVENT_TYPE_MAP['tool_request_resolved']).toBe('tool_request_resolution');
    expect(L3_EVENT_TYPE_MAP['tool_request_grant_executed']).toBe('tool_request_resolution');
    expect(L3_EVENT_TYPE_MAP['tool_request_grant_failed']).toBe('tool_request_resolution');
  });

  test('does not include non-L3 event types', () => {
    const mapped = Object.keys(L3_EVENT_TYPE_MAP);
    expect(mapped).not.toContain('phase.started');
    expect(mapped).not.toContain('phase.completed');
    expect(mapped).not.toContain('assignment_changed');
  });
});

// ---------------------------------------------------------------------------
// UNOBSERVABLE_L3_SIGNALS
// ---------------------------------------------------------------------------

describe('UNOBSERVABLE_L3_SIGNALS', () => {
  test('includes expected unobservable signal kinds', () => {
    expect(UNOBSERVABLE_L3_SIGNALS).toContain('admin_recover');
    expect(UNOBSERVABLE_L3_SIGNALS).toContain('quarantine');
    expect(UNOBSERVABLE_L3_SIGNALS).toContain('task_recreation');
    expect(UNOBSERVABLE_L3_SIGNALS).toContain('manual_db_repair');
  });

  test('does not include observable signals', () => {
    expect(UNOBSERVABLE_L3_SIGNALS).not.toContain('human_review_return');
    expect(UNOBSERVABLE_L3_SIGNALS).not.toContain('tool_request_resolution');
  });
});

// ---------------------------------------------------------------------------
// aggregateL3Interventions — empty / no events
// ---------------------------------------------------------------------------

describe('aggregateL3Interventions — empty database', () => {
  test('returns zero totals for a session with no events', () => {
    const db = createDb();
    const result = aggregateL3Interventions(db, 'test-session');
    db.close();

    expect(result.sessionId).toBe('test-session');
    expect(result.total).toBe(0);
    expect(result.byIssue).toEqual([]);
    expect(result.bySignal).toEqual({});
    expect(result.unobservableSignals).toEqual(expect.arrayContaining(['admin_recover']));
  });

  test('returns empty result when session has events of non-L3 types only', () => {
    const db = createDb();
    insertEvent(db, 'sess', 42, 'phase.started');
    insertEvent(db, 'sess', 42, 'phase.completed');
    insertEvent(db, 'sess', 42, 'assignment_changed');

    const result = aggregateL3Interventions(db, 'sess');
    db.close();

    expect(result.total).toBe(0);
    expect(result.byIssue).toHaveLength(0);
  });

  test('does not cross-count across sessions', () => {
    const db = createDb();
    insertEvent(db, 'other-session', 42, 'human_review_return');

    const result = aggregateL3Interventions(db, 'my-session');
    db.close();

    expect(result.total).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// aggregateL3Interventions — human_review_return
// ---------------------------------------------------------------------------

describe('aggregateL3Interventions — human_review_return signal', () => {
  test('counts human_review_return events', () => {
    const db = createDb();
    insertEvent(db, 'sess', 10, 'human_review_return');
    insertEvent(db, 'sess', 10, 'human_review_return');

    const result = aggregateL3Interventions(db, 'sess');
    db.close();

    expect(result.total).toBe(2);
    expect(result.bySignal['human_review_return']).toBe(2);
    expect(result.byIssue).toHaveLength(1);
    expect(result.byIssue[0]).toMatchObject({
      issueNumber: 10,
      total: 2,
      bySignal: { human_review_return: 2 },
    });
  });

  test('counts github_app_review_return as the human_review_return signal', () => {
    const db = createDb();
    insertEvent(db, 'sess', 11, 'github_app_review_return');

    const result = aggregateL3Interventions(db, 'sess');
    db.close();

    expect(result.bySignal['human_review_return']).toBe(1);
    expect(result.total).toBe(1);
  });

  test('combines human_review_return and github_app_review_return into the same signal', () => {
    const db = createDb();
    insertEvent(db, 'sess', 5, 'human_review_return');
    insertEvent(db, 'sess', 5, 'github_app_review_return');

    const result = aggregateL3Interventions(db, 'sess');
    db.close();

    expect(result.bySignal['human_review_return']).toBe(2);
    expect(result.byIssue[0].bySignal['human_review_return']).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// aggregateL3Interventions — tool_request_resolution signal
// ---------------------------------------------------------------------------

describe('aggregateL3Interventions — tool_request_resolution signal', () => {
  test.each([
    ['tool_request_resolved'],
    ['tool_request_grant_executed'],
    ['tool_request_grant_failed'],
  ])('counts %s as tool_request_resolution', (eventType) => {
    const db = createDb();
    insertEvent(db, 'sess', 20, eventType);

    const result = aggregateL3Interventions(db, 'sess');
    db.close();

    expect(result.bySignal['tool_request_resolution']).toBe(1);
    expect(result.total).toBe(1);
  });

  test('accumulates multiple tool_request events for the same issue', () => {
    const db = createDb();
    insertEvent(db, 'sess', 30, 'tool_request_resolved');
    insertEvent(db, 'sess', 30, 'tool_request_grant_executed');
    insertEvent(db, 'sess', 30, 'tool_request_grant_failed');

    const result = aggregateL3Interventions(db, 'sess');
    db.close();

    expect(result.bySignal['tool_request_resolution']).toBe(3);
    expect(result.byIssue[0].total).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// aggregateL3Interventions — task context fallback
// ---------------------------------------------------------------------------

describe('aggregateL3Interventions — task context toolRequest fallback', () => {
  test('counts resolved toolRequest context when no resolution events exist', () => {
    const db = createDb();
    insertTask(db, 'sess', 99, { toolRequest: { command: 'npm install', resolved: true } });

    const result = aggregateL3Interventions(db, 'sess');
    db.close();

    expect(result.bySignal['tool_request_resolution']).toBe(1);
    expect(result.total).toBe(1);
  });

  test('does not count unresolved toolRequest context (active handoff)', () => {
    const db = createDb();
    insertTask(db, 'sess', 99, { toolRequest: { command: 'npm install', resolved: false } });

    const result = aggregateL3Interventions(db, 'sess');
    db.close();

    expect(result.total).toBe(0);
  });

  test('does not count toolRequest context with no resolved field', () => {
    const db = createDb();
    insertTask(db, 'sess', 99, { toolRequest: { command: 'npm install' } });

    const result = aggregateL3Interventions(db, 'sess');
    db.close();

    expect(result.total).toBe(0);
  });

  test('does not double-count when resolution event AND context flag both present', () => {
    const db = createDb();
    insertEvent(db, 'sess', 99, 'tool_request_resolved');
    insertTask(db, 'sess', 99, { toolRequest: { command: 'npm install', resolved: true } });

    const result = aggregateL3Interventions(db, 'sess');
    db.close();

    // Only the event is counted; context fallback is skipped.
    expect(result.bySignal['tool_request_resolution']).toBe(1);
    expect(result.total).toBe(1);
  });

  test('ignores falsy toolRequest context values', () => {
    const db = createDb();
    insertTask(db, 'sess', 7, { toolRequest: false });
    insertTask(db, 'sess', 8, { toolRequest: null });
    insertTask(db, 'sess', 9, {}); // no toolRequest key

    const result = aggregateL3Interventions(db, 'sess');
    db.close();

    expect(result.total).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// aggregateL3Interventions — multi-issue aggregation
// ---------------------------------------------------------------------------

describe('aggregateL3Interventions — multi-issue aggregation', () => {
  test('produces per-issue breakdown sorted by issue number', () => {
    const db = createDb();
    insertEvent(db, 'sess', 200, 'human_review_return');
    insertEvent(db, 'sess', 100, 'tool_request_resolved');
    insertEvent(db, 'sess', 200, 'tool_request_grant_executed');

    const result = aggregateL3Interventions(db, 'sess');
    db.close();

    expect(result.byIssue).toHaveLength(2);
    expect(result.byIssue[0].issueNumber).toBe(100);
    expect(result.byIssue[1].issueNumber).toBe(200);
    expect(result.byIssue[0].total).toBe(1);
    expect(result.byIssue[1].total).toBe(2);
  });

  test('aggregates bySignal across all issues', () => {
    const db = createDb();
    insertEvent(db, 'sess', 1, 'human_review_return');
    insertEvent(db, 'sess', 2, 'human_review_return');
    insertEvent(db, 'sess', 2, 'tool_request_resolved');

    const result = aggregateL3Interventions(db, 'sess');
    db.close();

    expect(result.bySignal['human_review_return']).toBe(2);
    expect(result.bySignal['tool_request_resolution']).toBe(1);
    expect(result.total).toBe(3);
  });

  test('includes unobservableSignals in every result', () => {
    const db = createDb();

    const result = aggregateL3Interventions(db, 'sess');
    db.close();

    expect(Array.isArray(result.unobservableSignals)).toBe(true);
    expect(result.unobservableSignals.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// aggregateL3Interventions — filters
// ---------------------------------------------------------------------------

describe('aggregateL3Interventions — issueNumber filter', () => {
  test('restricts results to the specified issue', () => {
    const db = createDb();
    insertEvent(db, 'sess', 10, 'human_review_return');
    insertEvent(db, 'sess', 20, 'human_review_return');

    const result = aggregateL3Interventions(db, 'sess', { issueNumber: 10 });
    db.close();

    expect(result.byIssue).toHaveLength(1);
    expect(result.byIssue[0].issueNumber).toBe(10);
    expect(result.total).toBe(1);
  });

  test('returns empty result when issue has no L3 events', () => {
    const db = createDb();
    insertEvent(db, 'sess', 99, 'human_review_return');

    const result = aggregateL3Interventions(db, 'sess', { issueNumber: 1 });
    db.close();

    expect(result.total).toBe(0);
    expect(result.byIssue).toHaveLength(0);
  });
});

describe('aggregateL3Interventions — since / until filters', () => {
  test('since filter excludes events before the timestamp', () => {
    const db = createDb();
    insertEvent(db, 'sess', 1, 'human_review_return', '2026-01-01T00:00:00.000Z');
    insertEvent(db, 'sess', 1, 'human_review_return', '2026-06-01T00:00:00.000Z');

    const result = aggregateL3Interventions(db, 'sess', { since: '2026-03-01T00:00:00.000Z' });
    db.close();

    expect(result.total).toBe(1);
  });

  test('until filter excludes events at or after the timestamp', () => {
    const db = createDb();
    insertEvent(db, 'sess', 1, 'human_review_return', '2026-01-01T00:00:00.000Z');
    insertEvent(db, 'sess', 1, 'human_review_return', '2026-06-01T00:00:00.000Z');

    const result = aggregateL3Interventions(db, 'sess', { until: '2026-03-01T00:00:00.000Z' });
    db.close();

    expect(result.total).toBe(1);
  });

  test('since and until together define a closed window', () => {
    const db = createDb();
    insertEvent(db, 'sess', 1, 'human_review_return', '2026-01-01T00:00:00.000Z');
    insertEvent(db, 'sess', 1, 'human_review_return', '2026-04-01T00:00:00.000Z');
    insertEvent(db, 'sess', 1, 'human_review_return', '2026-07-01T00:00:00.000Z');

    const result = aggregateL3Interventions(db, 'sess', {
      since: '2026-03-01T00:00:00.000Z',
      until: '2026-05-01T00:00:00.000Z',
    });
    db.close();

    expect(result.total).toBe(1);
    expect(result.since).toBe('2026-03-01T00:00:00.000Z');
    expect(result.until).toBe('2026-05-01T00:00:00.000Z');
  });

  test('since / until are absent from result when not supplied', () => {
    const db = createDb();

    const result = aggregateL3Interventions(db, 'sess');
    db.close();

    expect(result.since).toBeUndefined();
    expect(result.until).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// aggregateL3Interventions — task context fallback respects time filters
// ---------------------------------------------------------------------------

describe('aggregateL3Interventions — task context fallback time filtering', () => {
  test('since filter excludes context fallback resolved before the window', () => {
    const db = createDb();
    insertTask(db, 'sess', 99, {
      toolRequest: { command: 'npm install', resolved: true, resolvedAt: '2026-01-01T00:00:00.000Z' },
    });

    const result = aggregateL3Interventions(db, 'sess', { since: '2026-03-01T00:00:00.000Z' });
    db.close();

    expect(result.total).toBe(0);
  });

  test('until filter excludes context fallback resolved at or after the window', () => {
    const db = createDb();
    insertTask(db, 'sess', 99, {
      toolRequest: { command: 'npm install', resolved: true, resolvedAt: '2026-06-01T00:00:00.000Z' },
    });

    const result = aggregateL3Interventions(db, 'sess', { until: '2026-03-01T00:00:00.000Z' });
    db.close();

    expect(result.total).toBe(0);
  });

  test('context fallback is included when resolvedAt falls within the window', () => {
    const db = createDb();
    insertTask(db, 'sess', 99, {
      toolRequest: { command: 'npm install', resolved: true, resolvedAt: '2026-04-01T00:00:00.000Z' },
    });

    const result = aggregateL3Interventions(db, 'sess', {
      since: '2026-03-01T00:00:00.000Z',
      until: '2026-05-01T00:00:00.000Z',
    });
    db.close();

    expect(result.total).toBe(1);
    expect(result.bySignal['tool_request_resolution']).toBe(1);
  });

  test('context fallback without resolvedAt is excluded when a time bound is supplied', () => {
    const db = createDb();
    insertTask(db, 'sess', 99, {
      toolRequest: { command: 'npm install', resolved: true },
    });

    const result = aggregateL3Interventions(db, 'sess', { since: '2026-01-01T00:00:00.000Z' });
    db.close();

    // Cannot place the resolution in the window — skip rather than over-count.
    expect(result.total).toBe(0);
  });

  test('context fallback without resolvedAt is included when no time bound is supplied', () => {
    const db = createDb();
    insertTask(db, 'sess', 99, {
      toolRequest: { command: 'npm install', resolved: true },
    });

    const result = aggregateL3Interventions(db, 'sess');
    db.close();

    expect(result.total).toBe(1);
  });

  test('since filter reads nested resolution.resolvedAt for persisted StoredToolRequest records', () => {
    const db = createDb();
    insertTask(db, 'sess', 99, {
      toolRequest: {
        command: 'npm install',
        resolved: true,
        resolution: { resolvedAt: '2026-01-01T00:00:00.000Z', outcome: 'granted' },
      },
    });

    const result = aggregateL3Interventions(db, 'sess', { since: '2026-03-01T00:00:00.000Z' });
    db.close();

    // resolvedAt is before the window — should be excluded
    expect(result.total).toBe(0);
  });

  test('until filter reads nested resolution.resolvedAt for persisted StoredToolRequest records', () => {
    const db = createDb();
    insertTask(db, 'sess', 99, {
      toolRequest: {
        command: 'npm install',
        resolved: true,
        resolution: { resolvedAt: '2026-06-01T00:00:00.000Z', outcome: 'granted' },
      },
    });

    const result = aggregateL3Interventions(db, 'sess', { until: '2026-03-01T00:00:00.000Z' });
    db.close();

    // resolvedAt is at or after the window end — should be excluded
    expect(result.total).toBe(0);
  });

  test('nested resolution.resolvedAt is included when it falls within the window', () => {
    const db = createDb();
    insertTask(db, 'sess', 99, {
      toolRequest: {
        command: 'npm install',
        resolved: true,
        resolution: { resolvedAt: '2026-04-01T00:00:00.000Z', outcome: 'granted' },
      },
    });

    const result = aggregateL3Interventions(db, 'sess', {
      since: '2026-03-01T00:00:00.000Z',
      until: '2026-05-01T00:00:00.000Z',
    });
    db.close();

    expect(result.total).toBe(1);
    expect(result.bySignal['tool_request_resolution']).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// aggregateL3Interventions — missing tables (graceful degradation)
// ---------------------------------------------------------------------------

describe('aggregateL3Interventions — graceful degradation', () => {
  test('returns empty result when events table is absent', () => {
    const db = new Database(':memory:');
    // No schema — events and tasks tables do not exist.

    const result = aggregateL3Interventions(db, 'sess');
    db.close();

    expect(result.total).toBe(0);
    expect(result.byIssue).toEqual([]);
  });
});
