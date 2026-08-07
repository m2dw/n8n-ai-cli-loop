import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SqliteOutboxStore } from '../dist/index.js';
import { OUTBOX_MAX_ATTEMPTS } from '../dist/core/outbox.js';
import { deriveOwnershipScanCursorKey, scanCursorKeysFor } from '../dist/core/outbox-scan-cursor.js';

// Issue #607 — `admin outbox list|retry|cancel`: operator-supported inspection
// and recovery of outbox delivery state, without raw SQLite editing.

const CLI = new URL('../dist/cli/admin.js', import.meta.url).pathname;

let tmpDir;
let dbPath;
let sessionsPath;
let repoRoot;

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

function writeSession(overrides = {}) {
  const session = {
    sessionId: 'addon-dev',
    repoKey: 'some-repo',
    repoRoot,
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

async function enqueue(overrides = {}) {
  const store = new SqliteOutboxStore(dbPath);
  try {
    const key = overrides.idempotencyKey ?? `key-${Math.random()}`;
    await store.enqueue({
      idempotencyKey: key,
      topic: 'gh:comment',
      payload: {
        topic: 'gh:comment',
        owner: 'm2dw',
        repo: 'some-repo',
        issueNumber: 1,
        body: 'hello',
        ...overrides.payload,
      },
    });
    const [entry] = (await store.listUnsent()).filter((e) => e.idempotencyKey === key);
    return entry.id;
  } finally {
    store.close();
  }
}

async function makeDelayed(id) {
  const store = new SqliteOutboxStore(dbPath);
  try {
    await store.markFailed(id, 'transient error');
  } finally {
    store.close();
  }
}

async function makeDead(id) {
  const store = new SqliteOutboxStore(dbPath);
  try {
    for (let i = 0; i < OUTBOX_MAX_ATTEMPTS; i++) {
      await store.markFailed(id, `boom-${i}`, '2026-01-01T00:00:00.000Z');
    }
  } finally {
    store.close();
  }
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'admin-outbox-test-'));
  dbPath = join(tmpDir, 'test.db');
  sessionsPath = join(tmpDir, 'sessions.json');
  repoRoot = tmpDir;
  writeSession();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('admin outbox list', () => {
  test('human output reports pending/delayed/dead counts', async () => {
    const pendingId = await enqueue();
    const delayedId = await enqueue();
    await makeDelayed(delayedId);
    const deadId = await enqueue();
    await makeDead(deadId);

    const r = run('outbox', 'list', '--session-id', 'addon-dev', '--sessions-path', sessionsPath, '--db-path', dbPath);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('1 pending, 1 delayed, 0 in-flight, 1 dead');
    expect(r.stdout).toContain(`#${pendingId}`);
    expect(r.stdout).toContain(`#${delayedId}`);
    expect(r.stdout).toContain(`#${deadId}`);
  });

  test('--json emits a stable machine payload with a safe summary (no raw body)', async () => {
    const id = await enqueue({ payload: { body: 'secret internal details' } });

    const r = run(
      'outbox', 'list', '--session-id', 'addon-dev',
      '--sessions-path', sessionsPath, '--db-path', dbPath, '--json',
    );
    expect(r.code).toBe(0);
    const out = parse(r);
    expect(out.ok).toBe(true);
    expect(out.counts).toEqual({ pending: 1, delayed: 0, in_flight: 0, dead: 0 });
    expect(out.entries).toHaveLength(1);
    const entry = out.entries[0];
    expect(entry.id).toBe(id);
    expect(entry.owner).toBe('m2dw');
    expect(entry.repo).toBe('some-repo');
    expect(entry.issueNumber).toBe(1);
    expect(entry.status).toBe('pending');
    expect(entry).not.toHaveProperty('body');
    expect(JSON.stringify(out)).not.toContain('secret internal details');
  });

  test('--status filters to a single delivery status', async () => {
    const deadId = await enqueue();
    await makeDead(deadId);
    await enqueue(); // pending, should be excluded by the filter

    const r = run(
      'outbox', 'list', '--session-id', 'addon-dev', '--status', 'dead',
      '--sessions-path', sessionsPath, '--db-path', dbPath, '--json',
    );
    expect(r.code).toBe(0);
    const out = parse(r);
    expect(out.entries).toHaveLength(1);
    expect(out.entries[0].id).toBe(deadId);
    expect(out.entries[0].status).toBe('dead');
    // Counts always reflect the full matching set, not just the filter.
    expect(out.counts).toEqual({ pending: 1, delayed: 0, in_flight: 0, dead: 1 });
  });

  // issue #607 review follow-up: a row an active dispatch attempt currently
  // holds a claim on is not dispatch-eligible right now (a dispatcher cannot
  // claim it, and `outbox cancel` refuses it with dispatch_in_progress), so
  // it must not be reported as `pending`.
  test('reports a row with an active dispatch claim as in_flight, not pending', async () => {
    const id = await enqueue();
    const store = new SqliteOutboxStore(dbPath);
    try {
      expect(await store.claimForDispatch(id)).toBe(true);
    } finally {
      store.close();
    }

    const r = run(
      'outbox', 'list', '--session-id', 'addon-dev',
      '--sessions-path', sessionsPath, '--db-path', dbPath, '--json',
    );
    expect(r.code).toBe(0);
    const out = parse(r);
    expect(out.entries).toHaveLength(1);
    expect(out.entries[0].status).toBe('in_flight');
    expect(out.entries[0].claimedAt).toBeTruthy();
    expect(out.counts).toEqual({ pending: 0, delayed: 0, in_flight: 1, dead: 0 });

    const filtered = run(
      'outbox', 'list', '--session-id', 'addon-dev', '--status', 'in_flight',
      '--sessions-path', sessionsPath, '--db-path', dbPath, '--json',
    );
    const filteredOut = parse(filtered);
    expect(filteredOut.entries.map((e) => e.id)).toEqual([id]);

    const pendingOnly = run(
      'outbox', 'list', '--session-id', 'addon-dev', '--status', 'pending',
      '--sessions-path', sessionsPath, '--db-path', dbPath, '--json',
    );
    expect(parse(pendingOnly).entries).toHaveLength(0);
  });

  test('session scoping excludes rows belonging to a different repo', async () => {
    await enqueue(); // belongs to addon-dev's repo
    await enqueue({ payload: { owner: 'other-org', repo: 'other-repo' } });

    const r = run(
      'outbox', 'list', '--session-id', 'addon-dev',
      '--sessions-path', sessionsPath, '--db-path', dbPath, '--json',
    );
    expect(r.code).toBe(0);
    const out = parse(r);
    expect(out.entries).toHaveLength(1);
    expect(out.entries[0].owner).toBe('m2dw');
  });

  test('rejects an unknown flag', () => {
    const r = run(
      'outbox', 'list', '--session-id', 'addon-dev',
      '--sessions-path', sessionsPath, '--db-path', dbPath, '--bogus', 'x', '--json',
    );
    expect(r.code).not.toBe(0);
    const out = parse(r);
    expect(out.ok).toBe(false);
    expect(out.error).toContain('--bogus');
  });

  test('redacts session-specific checkout paths from lastError even under a nonstandard root', async () => {
    // Persistence (markFailed) only runs `sanitizeBody(error)` with no configured
    // paths, so a checkout under a root name the generic heuristic doesn't
    // recognize (e.g. /company/... rather than /Users/... or /home/...) survives
    // into the stored lastError. `outbox list` must re-sanitize using the
    // session's own repoRoot before rendering (issue #607 review follow-up).
    writeSession({ repoRoot: '/company/internal/repo' });
    const id = await enqueue();
    const store = new SqliteOutboxStore(dbPath);
    try {
      await store.markFailed(id, 'dispatch failed: /company/internal/repo/output.log not found');
    } finally {
      store.close();
    }

    const r = run(
      'outbox', 'list', '--session-id', 'addon-dev',
      '--sessions-path', sessionsPath, '--db-path', dbPath, '--json',
    );
    expect(r.code).toBe(0);
    const out = parse(r);
    const entry = out.entries.find((e) => e.id === id);
    expect(entry.lastError).toBeDefined();
    expect(JSON.stringify(out)).not.toContain('/company/internal/repo');
  });

  test('rejects an invalid --status value', () => {
    const r = run(
      'outbox', 'list', '--session-id', 'addon-dev',
      '--sessions-path', sessionsPath, '--db-path', dbPath, '--status', 'bogus', '--json',
    );
    expect(r.code).not.toBe(0);
    const out = parse(r);
    expect(out.ok).toBe(false);
    expect(out.error).toContain('--status');
  });

  test('supports --session-ref through the shared option path', async () => {
    writeSession({ sessionNo: 7 });
    await enqueue();

    const r = run(
      'outbox', 'list', '--session-ref', '7',
      '--sessions-path', sessionsPath, '--db-path', dbPath, '--json',
    );
    expect(r.code).toBe(0);
    const out = parse(r);
    expect(out.ok).toBe(true);
    expect(out.sessionId).toBe('addon-dev');
  });
});

describe('admin outbox retry', () => {
  test('previews by default without mutating state', async () => {
    const id = await enqueue();
    await makeDead(id);

    const r = run(
      'outbox', 'retry', '--session-id', 'addon-dev', '--id', String(id),
      '--sessions-path', sessionsPath, '--db-path', dbPath,
    );
    expect(r.code).toBe(0);
    const out = parse(r);
    expect(out.ok).toBe(true);
    expect(out.wouldRetry).toBe(true);
    expect(out.retried).toBe(false);
    expect(out.status).toBe('dead');

    const store = new SqliteOutboxStore(dbPath);
    const row = await store.getById(id);
    store.close();
    expect(row.deadLetterAt).toBeTruthy();
  });

  test('--yes recovers a dead-lettered row for another dispatch attempt', async () => {
    const id = await enqueue();
    await makeDead(id);

    const r = run(
      'outbox', 'retry', '--session-id', 'addon-dev', '--id', String(id), '--yes',
      '--sessions-path', sessionsPath, '--db-path', dbPath,
    );
    expect(r.code).toBe(0);
    const out = parse(r);
    expect(out.ok).toBe(true);
    expect(out.retried).toBe(true);

    const store = new SqliteOutboxStore(dbPath);
    const row = await store.getById(id);
    store.close();
    expect(row.deadLetterAt).toBeUndefined();
    expect(row.nextAttemptAt).toBeUndefined();
    expect(row.attemptCount).toBe(0);
  });

  test('is a safe no-op for an already-pending row', async () => {
    const id = await enqueue();

    const r = run(
      'outbox', 'retry', '--session-id', 'addon-dev', '--id', String(id), '--yes',
      '--sessions-path', sessionsPath, '--db-path', dbPath,
    );
    expect(r.code).toBe(0);
    const out = parse(r);
    expect(out.ok).toBe(true);
    expect(out.retried).toBe(false);
    expect(out.reason).toBe('already_pending');
  });

  test('preview reports wouldRetry: false for an already-pending row instead of promising a recovery', async () => {
    const id = await enqueue();

    const r = run(
      'outbox', 'retry', '--session-id', 'addon-dev', '--id', String(id),
      '--sessions-path', sessionsPath, '--db-path', dbPath,
    );
    expect(r.code).toBe(0);
    const out = parse(r);
    expect(out.ok).toBe(true);
    expect(out.wouldRetry).toBe(false);
    expect(out.reason).toBe('already_pending');
    expect(out.hint).not.toContain('--yes to retry');
  });

  test('preview reports wouldRetry: false for an already-sent row instead of promising a recovery', async () => {
    const id = await enqueue();
    const store = new SqliteOutboxStore(dbPath);
    try {
      await store.markSent(id);
    } finally {
      store.close();
    }

    const r = run(
      'outbox', 'retry', '--session-id', 'addon-dev', '--id', String(id),
      '--sessions-path', sessionsPath, '--db-path', dbPath,
    );
    expect(r.code).toBe(0);
    const out = parse(r);
    expect(out.ok).toBe(true);
    expect(out.wouldRetry).toBe(false);
    expect(out.reason).toBe('already_sent');
    expect(out.hint).not.toContain('--yes to retry');
  });

  test('rejects an unknown row id', () => {
    const r = run(
      'outbox', 'retry', '--session-id', 'addon-dev', '--id', '999999', '--yes',
      '--sessions-path', sessionsPath, '--db-path', dbPath,
    );
    expect(r.code).not.toBe(0);
    const out = parse(r);
    expect(out.ok).toBe(false);
    expect(out.error).toContain('999999');
  });

  test('rejects a row that does not belong to the given session', async () => {
    const id = await enqueue({ payload: { owner: 'other-org', repo: 'other-repo' } });

    const r = run(
      'outbox', 'retry', '--session-id', 'addon-dev', '--id', String(id), '--yes',
      '--sessions-path', sessionsPath, '--db-path', dbPath,
    );
    expect(r.code).not.toBe(0);
    const out = parse(r);
    expect(out.ok).toBe(false);
    expect(out.error).toContain(String(id));
    expect(out.error).toContain('addon-dev');
  });
});

// ---------------------------------------------------------------------------
// Issue #820 — retrying a row the persisted scan cursors already passed must
// rewind those cursors, or the "recovered" row stays invisible to every future
// dispatch (`listPendingEntries` selects `id > afterId`). See
// docs/outbox-scan-cursor-contract.md §13.
// ---------------------------------------------------------------------------

describe('admin outbox retry — scan cursor rewind (issue #820)', () => {
  // The identity the session config resolves to, derived exactly as
  // dispatch-outbox.ts derives it. Building it here from the session fields
  // (not copying a literal out of the CLI) is what makes this a check that the
  // CLI used the *config-derived* scope.
  const IDENTITY = deriveOwnershipScanCursorKey({
    sessionId: 'addon-dev',
    githubOwner: 'm2dw',
    githubName: 'some-repo',
  });
  const KEYS = scanCursorKeysFor(IDENTITY);

  async function setCursors(afterId, keys = KEYS) {
    const store = new SqliteOutboxStore(dbPath);
    try {
      for (const key of [keys.floor, keys.fwd, keys.bulk]) {
        await store.setScanCursor(key, afterId);
      }
    } finally {
      store.close();
    }
  }

  async function readCursors(keys = KEYS) {
    const store = new SqliteOutboxStore(dbPath);
    try {
      return {
        floor: await store.getScanCursor(keys.floor),
        fwd: await store.getScanCursor(keys.fwd),
        bulk: await store.getScanCursor(keys.bulk),
      };
    } finally {
      store.close();
    }
  }

  test('preview reports the required rewind and the affected roles without mutating anything', async () => {
    const id = await enqueue();
    await makeDead(id);
    await setCursors(id + 10);

    const r = run(
      'outbox', 'retry', '--session-id', 'addon-dev', '--id', String(id),
      '--sessions-path', sessionsPath, '--db-path', dbPath,
    );
    expect(r.code).toBe(0);
    const out = parse(r);
    expect(out.wouldRetry).toBe(true);
    expect(out.cursorRewind.required).toBe(true);
    expect(out.cursorRewind.roles).toEqual(['floor', 'fwd', 'bulk']);
    expect(out.cursorRewind.targetAfterId).toBe(id - 1);
    expect(out.hint).toContain('--yes');

    // Non-mutating: neither the row nor a single cursor moved.
    expect(await readCursors()).toEqual({ floor: id + 10, fwd: id + 10, bulk: id + 10 });
    const store = new SqliteOutboxStore(dbPath);
    const row = await store.getById(id);
    store.close();
    expect(row.deadLetterAt).toBeTruthy();
  });

  test('preview reports required: false when the cursors are already behind the row', async () => {
    const id = await enqueue();
    await makeDead(id);
    await setCursors(id - 1);

    const out = parse(run(
      'outbox', 'retry', '--session-id', 'addon-dev', '--id', String(id),
      '--sessions-path', sessionsPath, '--db-path', dbPath,
    ));
    expect(out.cursorRewind.required).toBe(false);
    expect(out.cursorRewind.roles).toEqual([]);
  });

  test('preview reports only the cursor roles that actually exist', async () => {
    const id = await enqueue();
    await makeDead(id);
    const store = new SqliteOutboxStore(dbPath);
    try {
      await store.setScanCursor(KEYS.bulk, id + 3);
    } finally {
      store.close();
    }

    const out = parse(run(
      'outbox', 'retry', '--session-id', 'addon-dev', '--id', String(id),
      '--sessions-path', sessionsPath, '--db-path', dbPath,
    ));
    expect(out.cursorRewind.required).toBe(true);
    expect(out.cursorRewind.roles).toEqual(['bulk']);
    expect(out.cursorRewind.cursors).toEqual({ bulk: id + 3 });
  });

  test('--yes rewinds the session identity cursors and reports the roles moved', async () => {
    const id = await enqueue();
    await makeDead(id);
    await setCursors(id + 10);

    const out = parse(run(
      'outbox', 'retry', '--session-id', 'addon-dev', '--id', String(id), '--yes',
      '--sessions-path', sessionsPath, '--db-path', dbPath,
    ));
    expect(out.retried).toBe(true);
    expect(out.cursorsRewound).toEqual(['floor', 'fwd', 'bulk']);
    expect(await readCursors()).toEqual({ floor: id - 1, fwd: id - 1, bulk: id - 1 });
  });

  test('--yes never creates a cursor row that did not already exist', async () => {
    const id = await enqueue();
    await makeDead(id);

    const out = parse(run(
      'outbox', 'retry', '--session-id', 'addon-dev', '--id', String(id), '--yes',
      '--sessions-path', sessionsPath, '--db-path', dbPath,
    ));
    expect(out.retried).toBe(true);
    expect(out.cursorsRewound).toEqual([]);
    expect(await readCursors()).toEqual({ floor: undefined, fwd: undefined, bulk: undefined });
  });

  test('uses the config-derived scope: a Gitea work-item session rewinds its own cursors, not the GitHub-only ones', async () => {
    // Repointing the session at a split-provider Gitea config changes the
    // ownership tuple, hence the identity (§4.2/§4.6). The retry must follow
    // the session's *current* config, so the GitHub-only identity's cursors —
    // which no dispatch of this session will ever read — stay untouched.
    writeSession({
      workItemProvider: {
        provider: 'gitea-issues',
        auth: { mode: 'api-token', tokenEnv: 'GITEA_TOKEN' },
        gitea: { baseUrl: 'https://gitea.example', owner: 'gt', repo: 'gt-repo' },
      },
    });
    const giteaKeys = scanCursorKeysFor(deriveOwnershipScanCursorKey({
      sessionId: 'addon-dev',
      githubOwner: 'm2dw',
      githubName: 'some-repo',
      gitea: { owner: 'gt', repo: 'gt-repo', baseUrl: 'https://gitea.example' },
    }));

    const id = await enqueue();
    await makeDead(id);
    await setCursors(id + 10);
    await setCursors(id + 10, giteaKeys);

    const out = parse(run(
      'outbox', 'retry', '--session-id', 'addon-dev', '--id', String(id), '--yes',
      '--sessions-path', sessionsPath, '--db-path', dbPath,
    ));
    expect(out.retried).toBe(true);
    expect(out.cursorsRewound).toEqual(['floor', 'fwd', 'bulk']);
    expect(await readCursors(giteaKeys)).toEqual({ floor: id - 1, fwd: id - 1, bulk: id - 1 });
    // The GitHub-only identity is a different scope and must be left alone.
    expect(await readCursors()).toEqual({ floor: id + 10, fwd: id + 10, bulk: id + 10 });
  });

  test('a repeated retry is idempotent and does not re-rewind a cursor a later dispatch advanced', async () => {
    const id = await enqueue();
    await makeDead(id);
    await setCursors(id + 10);

    expect(parse(run(
      'outbox', 'retry', '--session-id', 'addon-dev', '--id', String(id), '--yes',
      '--sessions-path', sessionsPath, '--db-path', dbPath,
    )).retried).toBe(true);

    // A dispatch run afterwards legitimately advances the cursors again.
    await setCursors(id + 10);

    const second = parse(run(
      'outbox', 'retry', '--session-id', 'addon-dev', '--id', String(id), '--yes',
      '--sessions-path', sessionsPath, '--db-path', dbPath,
    ));
    expect(second.retried).toBe(false);
    expect(second.reason).toBe('already_pending');
    expect(second.cursorsRewound).toBeUndefined();
    expect(await readCursors()).toEqual({ floor: id + 10, fwd: id + 10, bulk: id + 10 });
  }, 30_000);
});

describe('admin outbox cancel', () => {
  test('previews by default without mutating state', async () => {
    const id = await enqueue();

    const r = run(
      'outbox', 'cancel', '--session-id', 'addon-dev', '--id', String(id),
      '--sessions-path', sessionsPath, '--db-path', dbPath,
    );
    expect(r.code).toBe(0);
    const out = parse(r);
    expect(out.ok).toBe(true);
    expect(out.wouldCancel).toBe(true);
    expect(out.cancelled).toBe(false);

    const store = new SqliteOutboxStore(dbPath);
    const row = await store.getById(id);
    store.close();
    expect(row.cancelledAt).toBeUndefined();
  });

  test('--yes cancels a pending row, excluding it from dispatch', async () => {
    const id = await enqueue();

    const r = run(
      'outbox', 'cancel', '--session-id', 'addon-dev', '--id', String(id), '--yes',
      '--sessions-path', sessionsPath, '--db-path', dbPath,
    );
    expect(r.code).toBe(0);
    const out = parse(r);
    expect(out.ok).toBe(true);
    expect(out.cancelled).toBe(true);

    const store = new SqliteOutboxStore(dbPath);
    const row = await store.getById(id);
    store.close();
    expect(row.cancelledAt).toBeTruthy();
    expect(row.deadLetterAt).toBeTruthy();

    // Shows up under the `dead` filter in `outbox list`.
    const listResult = run(
      'outbox', 'list', '--session-id', 'addon-dev', '--status', 'dead',
      '--sessions-path', sessionsPath, '--db-path', dbPath, '--json',
    );
    const listOut = parse(listResult);
    expect(listOut.entries.map((e) => e.id)).toContain(id);
  });

  test('is a safe no-op for an already-cancelled row', async () => {
    const id = await enqueue();
    run(
      'outbox', 'cancel', '--session-id', 'addon-dev', '--id', String(id), '--yes',
      '--sessions-path', sessionsPath, '--db-path', dbPath,
    );

    const r = run(
      'outbox', 'cancel', '--session-id', 'addon-dev', '--id', String(id), '--yes',
      '--sessions-path', sessionsPath, '--db-path', dbPath,
    );
    expect(r.code).toBe(0);
    const out = parse(r);
    expect(out.ok).toBe(true);
    expect(out.cancelled).toBe(false);
    expect(out.reason).toBe('already_cancelled');
  });

  test('preview reports wouldCancel: false for an already-cancelled row instead of promising a cancel', async () => {
    const id = await enqueue();
    run(
      'outbox', 'cancel', '--session-id', 'addon-dev', '--id', String(id), '--yes',
      '--sessions-path', sessionsPath, '--db-path', dbPath,
    );

    const r = run(
      'outbox', 'cancel', '--session-id', 'addon-dev', '--id', String(id),
      '--sessions-path', sessionsPath, '--db-path', dbPath,
    );
    expect(r.code).toBe(0);
    const out = parse(r);
    expect(out.ok).toBe(true);
    expect(out.wouldCancel).toBe(false);
    expect(out.reason).toBe('already_cancelled');
    expect(out.hint).not.toContain('--yes to cancel');
  });

  test('preview reports wouldCancel: false for an already-sent row instead of promising a cancel', async () => {
    const id = await enqueue();
    const store = new SqliteOutboxStore(dbPath);
    try {
      await store.markSent(id);
    } finally {
      store.close();
    }

    const r = run(
      'outbox', 'cancel', '--session-id', 'addon-dev', '--id', String(id),
      '--sessions-path', sessionsPath, '--db-path', dbPath,
    );
    expect(r.code).toBe(0);
    const out = parse(r);
    expect(out.ok).toBe(true);
    expect(out.wouldCancel).toBe(false);
    expect(out.reason).toBe('already_sent');
    expect(out.hint).not.toContain('--yes to cancel');
  });

  test('a cancelled row can be recovered later with outbox retry', async () => {
    const id = await enqueue();
    run(
      'outbox', 'cancel', '--session-id', 'addon-dev', '--id', String(id), '--yes',
      '--sessions-path', sessionsPath, '--db-path', dbPath,
    );

    const r = run(
      'outbox', 'retry', '--session-id', 'addon-dev', '--id', String(id), '--yes',
      '--sessions-path', sessionsPath, '--db-path', dbPath,
    );
    expect(r.code).toBe(0);
    const out = parse(r);
    expect(out.retried).toBe(true);

    const store = new SqliteOutboxStore(dbPath);
    const row = await store.getById(id);
    store.close();
    expect(row.cancelledAt).toBeUndefined();
    expect(row.deadLetterAt).toBeUndefined();
  });

  test('rejects a row that does not belong to the given session', async () => {
    const id = await enqueue({ payload: { owner: 'other-org', repo: 'other-repo' } });

    const r = run(
      'outbox', 'cancel', '--session-id', 'addon-dev', '--id', String(id), '--yes',
      '--sessions-path', sessionsPath, '--db-path', dbPath,
    );
    expect(r.code).not.toBe(0);
    const out = parse(r);
    expect(out.ok).toBe(false);
  });

  // issue #607 review follow-up: cancellation must not race dispatch-outbox.
  // A dispatcher claims a row atomically immediately before performing its
  // external side effect; while that claim is held, cancel must refuse rather
  // than report cancelled:true for a row that may already have been delivered.
  test('--yes refuses a row claimed by an in-flight dispatch attempt (dispatch_in_progress)', async () => {
    const id = await enqueue();
    const store = new SqliteOutboxStore(dbPath);
    try {
      expect(await store.claimForDispatch(id)).toBe(true);
    } finally {
      store.close();
    }

    const r = run(
      'outbox', 'cancel', '--session-id', 'addon-dev', '--id', String(id), '--yes',
      '--sessions-path', sessionsPath, '--db-path', dbPath,
    );
    expect(r.code).toBe(0);
    const out = parse(r);
    expect(out.ok).toBe(true);
    expect(out.cancelled).toBe(false);
    expect(out.reason).toBe('dispatch_in_progress');

    const verify = new SqliteOutboxStore(dbPath);
    const row = await verify.getById(id);
    verify.close();
    expect(row.cancelledAt).toBeUndefined();
    expect(row.deadLetterAt).toBeUndefined();
  });

  test('preview reports wouldCancel: false while a dispatch attempt holds the claim', async () => {
    const id = await enqueue();
    const store = new SqliteOutboxStore(dbPath);
    try {
      expect(await store.claimForDispatch(id)).toBe(true);
    } finally {
      store.close();
    }

    const r = run(
      'outbox', 'cancel', '--session-id', 'addon-dev', '--id', String(id),
      '--sessions-path', sessionsPath, '--db-path', dbPath,
    );
    expect(r.code).toBe(0);
    const out = parse(r);
    expect(out.ok).toBe(true);
    expect(out.wouldCancel).toBe(false);
    expect(out.reason).toBe('dispatch_in_progress');
    expect(out.hint).not.toContain('--yes to cancel');
  });
});
