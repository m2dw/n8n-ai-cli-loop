import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SqliteTaskStore } from '../dist/index.js';
import {
  ACTIVE_STATUSES,
  isActiveStatus,
  leaseState,
  attemptsCapState,
  issueTitle,
  blockerSummary,
  artifactPathForTask,
  isRecoverable,
  isCapRecoverable,
  isToolRequestHandoff,
  isHumanReviewHandoff,
  collectActiveTasks,
  partitionByGitHubState,
  buildGhIssueStateReader,
  buildCachingReader,
  populateStateCache,
  buildClosedTaskMenuActions,
  buildRecoverArgv,
  buildCapResetArgv,
  buildToolRequestResolveArgv,
  buildToolRequestGrantArgv,
  buildHumanReviewReturnArgv,
  buildTaskMenuActions,
  buildLockReleaseArgv,
  buildStatusArgv,
  formatAdminCommand,
  formatTaskLine,
  formatTaskDetail,
  taskColumns,
  parseUiArgs,
  resolveSessionIds,
  nonTtyHelp,
  DEFAULT_PAGE_SIZE,
  pageCount,
  clampPage,
  pageForIndex,
  pageSlice,
  moveSelectionByPage,
  moveSelectionByRow,
  formatPageStatus,
  applyFilter,
  isFilterActive,
  formatFilterStatus,
  formatSessionScope,
  sessionIdsForScope,
} from '../dist/cli/admin-ui.js';

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

function mkTask(overrides = {}) {
  const now = '2026-06-20T00:00:00.000Z';
  return {
    sessionId: 'session-a',
    issueNumber: 1,
    status: 'queued',
    phase: 'implementation',
    priority: 'normal',
    attempts: {},
    context: {},
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'admin-ui-test-'));
  dbPath = join(tmpDir, 'dev_loop.db');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Command routing & help
// ---------------------------------------------------------------------------

describe('admin ui — help routing', () => {
  test('"help" lists the ui command', () => {
    const r = run('help');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('ui');
  });

  test('"help ui" shows its options', () => {
    const r = run('help', 'ui');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('ui');
    expect(r.stdout).toContain('--session-id');
    expect(r.stdout).toContain('--session-ref');
    expect(r.stdout).toContain('--db-path');
  });
});

describe('admin ui — argument validation', () => {
  test('rejects both --session-id and --session-ref', () => {
    const r = run('ui', '--session-id', 'a', '--session-ref', 'b', '--db-path', dbPath);
    expect(r.code).not.toBe(0);
    expect(parse(r)).toMatchObject({ ok: false, error: expect.stringContaining('only one') });
  });

  test('rejects a trailing flag with no value', () => {
    const r = run('ui', '--session-id', 'prod', '--db-path');
    expect(r.code).not.toBe(0);
    expect(parse(r)).toMatchObject({ ok: false, error: expect.stringContaining('--db-path requires a value') });
  });

  test('rejects a flag whose value is the next flag', () => {
    const r = run('ui', '--session-id', '--db-path', dbPath);
    expect(r.code).not.toBe(0);
    expect(parse(r)).toMatchObject({ ok: false, error: expect.stringContaining('--session-id requires a value') });
  });

  test('rejects a non-flag positional argument', () => {
    const r = run('ui', 'stray');
    expect(r.code).not.toBe(0);
    expect(parse(r)).toMatchObject({ ok: false, error: expect.stringContaining('Unexpected argument') });
  });

  test('rejects an unknown option', () => {
    const r = run('ui', '--session-id', 'prod', '--bogus', 'x');
    expect(r.code).not.toBe(0);
    expect(parse(r)).toMatchObject({ ok: false, error: expect.stringContaining('bogus') });
  });
});

// ---------------------------------------------------------------------------
// Non-TTY degradation
// ---------------------------------------------------------------------------

describe('admin ui — non-TTY behaviour', () => {
  test('exits non-zero and prints the equivalent non-interactive commands', () => {
    // execFileSync gives the child a piped (non-TTY) stdin/stdout.
    const r = run('ui', '--db-path', dbPath);
    expect(r.code).not.toBe(0);
    const out = r.stdout + (r.stderr ?? '');
    expect(out).toContain('TTY');
    expect(out).toContain('admin recover');
    expect(out).toContain('admin recover-cap-handoff');
    expect(out).toContain('admin list-stuck');
  });

  test('does not mutate the database in non-TTY mode', async () => {
    const store = new SqliteTaskStore(dbPath);
    await store.enqueueTask({ sessionId: 'session-a', issueNumber: 7, phase: 'review' });
    store.close();

    run('ui', '--session-id', 'session-a', '--db-path', dbPath);

    const verify = new SqliteTaskStore(dbPath);
    const tasks = verify.listTasks('session-a');
    verify.close();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].status).toBe('queued');
  });

  test('nonTtyHelp lists the high-frequency operator commands', () => {
    const help = nonTtyHelp();
    expect(help).toContain('admin recover');
    expect(help).toContain('admin task-status');
  });
});

// ---------------------------------------------------------------------------
// Pure helpers — status / lease / cap
// ---------------------------------------------------------------------------

describe('admin ui — status helpers', () => {
  test('isActiveStatus covers everything except done', () => {
    for (const s of ACTIVE_STATUSES) expect(isActiveStatus(s)).toBe(true);
    expect(isActiveStatus('done')).toBe(false);
  });

  test('leaseState reflects expiry only for claimed/running', () => {
    const now = '2026-06-20T12:00:00.000Z';
    expect(leaseState(mkTask({ status: 'queued' }), now)).toBe('none');
    expect(
      leaseState(mkTask({ status: 'running', leaseExpiresAt: '2026-06-20T13:00:00.000Z' }), now),
    ).toBe('active');
    expect(
      leaseState(mkTask({ status: 'claimed', leaseExpiresAt: '2026-06-20T11:00:00.000Z' }), now),
    ).toBe('expired');
    expect(leaseState(mkTask({ status: 'running' }), now)).toBe('none');
  });

  test('attemptsCapState shows current-phase attempts and the cap flag', () => {
    expect(attemptsCapState(mkTask({ phase: 'review', attempts: { review: 2 } }))).toBe('2');
    expect(
      attemptsCapState(
        mkTask({ phase: 'review', attempts: { review: 3 }, context: { reviewLoopCapReached: true } }),
      ),
    ).toBe('3 CAP');
    expect(attemptsCapState(mkTask({ phase: 'implementation' }))).toBe('0');
  });

  test('issueTitle, blockerSummary and artifactPathForTask read context safely', () => {
    expect(issueTitle(mkTask({ context: { title: 'Fix the thing' } }))).toBe('Fix the thing');
    expect(issueTitle(mkTask())).toBe('');
    expect(blockerSummary(mkTask({ lastError: 'boom\n  at line' }))).toBe('boom at line');
    expect(blockerSummary(mkTask({ context: { reviewLoopCapReached: true } }))).toBe(
      'review-loop cap reached',
    );
    expect(blockerSummary(mkTask())).toBe('');
    expect(artifactPathForTask(mkTask({ context: { artifactDir: '/runs/abc' } }))).toBe('/runs/abc');
    expect(artifactPathForTask(mkTask())).toBeNull();
  });

  test('isRecoverable / isCapRecoverable match the admin command preconditions', () => {
    const now = '2026-06-20T12:00:00.000Z';
    expect(isRecoverable(mkTask({ status: 'failed' }), now)).toBe(true);
    expect(
      isRecoverable(mkTask({ status: 'claimed', leaseExpiresAt: '2026-06-20T11:00:00.000Z' }), now),
    ).toBe(true);
    expect(
      isRecoverable(mkTask({ status: 'running', leaseExpiresAt: '2026-06-20T13:00:00.000Z' }), now),
    ).toBe(false);
    expect(isRecoverable(mkTask({ status: 'queued' }), now)).toBe(false);

    expect(
      isCapRecoverable(mkTask({ status: 'ready_for_human', context: { reviewLoopCapReached: true } })),
    ).toBe(true);
    expect(isCapRecoverable(mkTask({ status: 'ready_for_human' }))).toBe(false);
    expect(isCapRecoverable(mkTask({ status: 'failed', context: { reviewLoopCapReached: true } }))).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// Pure helpers — command building & formatting
// ---------------------------------------------------------------------------

describe('admin ui — command building', () => {
  test('buildRecoverArgv targets the exact task', () => {
    const argv = buildRecoverArgv(mkTask({ sessionId: 'sx', issueNumber: 42 }), '/tmp/db');
    expect(argv).toEqual([
      'recover',
      '--session-id',
      'sx',
      '--issue-number',
      '42',
      '--db-path',
      '/tmp/db',
    ]);
  });

  test('buildRecoverArgv surfaces a <phase> placeholder (not current phase) for ready_for_human handoffs', () => {
    const argv = buildRecoverArgv(
      mkTask({ sessionId: 'sx', issueNumber: 42, status: 'ready_for_human', phase: 'review' }),
    );
    // The phase must NOT be hard-coded to the task's current phase: a human
    // handoff may need a different lane (e.g. conflict_resolution), so the
    // operator fills in the placeholder. This argv is copy/paste-only and is
    // never auto-executed for a ready_for_human task.
    expect(argv).toEqual([
      'recover',
      '--session-id',
      'sx',
      '--issue-number',
      '42',
      '--from',
      'ready_for_human',
      '--phase',
      '<phase>',
    ]);
  });

  test('isHumanReviewHandoff matches plain ready_for_human handoffs only', () => {
    // Plain human handoff (no cap, no tool request).
    expect(isHumanReviewHandoff(mkTask({ status: 'ready_for_human', phase: 'review' }))).toBe(true);
    // A resolved Tool Request is no longer a live handoff -> treated as a plain
    // human handoff that the operator must route deliberately.
    expect(
      isHumanReviewHandoff(
        mkTask({ status: 'ready_for_human', context: { toolRequest: { command: 'x', resolved: true } } }),
      ),
    ).toBe(true);
    // Cap and live Tool Request handoffs have their own dedicated flows.
    expect(
      isHumanReviewHandoff(mkTask({ status: 'ready_for_human', context: { reviewLoopCapReached: true } })),
    ).toBe(false);
    expect(
      isHumanReviewHandoff(mkTask({ status: 'ready_for_human', context: { toolRequest: { command: 'x' } } })),
    ).toBe(false);
    // Not a human handoff at all.
    expect(isHumanReviewHandoff(mkTask({ status: 'failed' }))).toBe(false);
  });

  test('buildHumanReviewReturnArgv targets the dedicated review-return flow', () => {
    const task = mkTask({ sessionId: 'sx', issueNumber: 42 });
    expect(
      buildHumanReviewReturnArgv(task, ['--feedback-source', 'issue-comment'], '/tmp/db'),
    ).toEqual([
      'human-review-return',
      '--session-id',
      'sx',
      '--issue-number',
      '42',
      '--feedback-source',
      'issue-comment',
      '--db-path',
      '/tmp/db',
    ]);
    // Operator-supplied feedback flag is threaded through verbatim.
    expect(buildHumanReviewReturnArgv(task, ['--feedback', '<operator note>'])).toContain('--feedback');
    // human-review-return loads sessions.json unless told otherwise, so a custom
    // registry the UI was launched with must thread through.
    expect(
      buildHumanReviewReturnArgv(task, ['--feedback-source', 'issue-comment'], undefined, '/custom/sessions.json'),
    ).toEqual([
      'human-review-return',
      '--session-id',
      'sx',
      '--issue-number',
      '42',
      '--feedback-source',
      'issue-comment',
      '--sessions-path',
      '/custom/sessions.json',
    ]);
    expect(buildHumanReviewReturnArgv(task, ['--feedback-source', 'issue-comment'])).not.toContain(
      '--sessions-path',
    );
  });

  test('buildCapResetArgv defaults to phase review, matching the CLI contract', () => {
    // No explicit phase (e.g. the copyable-command view) must preserve the
    // documented `recover-cap-handoff` default of `review`, not silently emit
    // `implementation`.
    const argv = buildCapResetArgv(mkTask({ sessionId: 'sx', issueNumber: 42 }));
    expect(argv).toEqual([
      'recover-cap-handoff',
      '--session-id',
      'sx',
      '--issue-number',
      '42',
      '--phase',
      'review',
    ]);
  });

  test('buildCapResetArgv accepts explicit phase override (UI selector default implementation)', () => {
    const argv = buildCapResetArgv(mkTask({ sessionId: 'sx', issueNumber: 42 }), undefined, 'implementation');
    expect(argv).toEqual([
      'recover-cap-handoff',
      '--session-id',
      'sx',
      '--issue-number',
      '42',
      '--phase',
      'implementation',
    ]);
  });

  test('buildTaskMenuActions routes cap handoffs to cap-reset, hiding generic recover', () => {
    const now = '2026-06-20T12:00:00.000Z';
    const capHandoff = mkTask({
      status: 'ready_for_human',
      phase: 'review',
      context: { reviewLoopCapReached: true },
    });
    const capActions = buildTaskMenuActions(capHandoff, now).map((a) => a.action);
    expect(capActions).toContain('cap-reset');
    expect(capActions).not.toContain('recover');

    // Tool Request handoffs route to the dedicated tool-request flow, NOT
    // generic recover (which would requeue the request unresolved).
    const toolRequestHandoff = mkTask({
      status: 'ready_for_human',
      phase: 'implementation',
      context: { toolRequest: { command: 'x' } },
    });
    const trActions = buildTaskMenuActions(toolRequestHandoff, now).map((a) => a.action);
    expect(trActions).toContain('tool-request');
    expect(trActions).not.toContain('recover');
    expect(trActions).not.toContain('cap-reset');

    // A plain failed task with no special handoff still gets generic recover.
    const failed = mkTask({ status: 'failed' });
    const failedActions = buildTaskMenuActions(failed, now).map((a) => a.action);
    expect(failedActions).toContain('recover');
    expect(failedActions).not.toContain('tool-request');

    // A plain ready_for_human handoff (no cap, no tool request) routes to the
    // human-review command view, NOT auto-running generic recover at the current
    // phase — which could put a review return in the wrong lane.
    const plainHandoff = mkTask({ status: 'ready_for_human', phase: 'review' });
    const plainActions = buildTaskMenuActions(plainHandoff, now).map((a) => a.action);
    expect(plainActions).toContain('human-review');
    expect(plainActions).not.toContain('recover');
  });

  test('buildTaskMenuActions hides recover for states admin recover cannot move', () => {
    const now = '2026-06-20T12:00:00.000Z';

    // `blocked` is a documented no-op for `admin recover`; don't offer it.
    const blockedActions = buildTaskMenuActions(mkTask({ status: 'blocked' }), now).map(
      (a) => a.action,
    );
    expect(blockedActions).not.toContain('recover');

    // A claimed/running task whose lease is still active is not recoverable yet.
    const activeLeaseActions = buildTaskMenuActions(
      mkTask({ status: 'running', leaseExpiresAt: '2026-06-20T13:00:00.000Z' }),
      now,
    ).map((a) => a.action);
    expect(activeLeaseActions).not.toContain('recover');

    // An expired claimed/running lease is recoverable.
    const expiredLeaseActions = buildTaskMenuActions(
      mkTask({ status: 'claimed', leaseExpiresAt: '2026-06-20T11:00:00.000Z' }),
      now,
    ).map((a) => a.action);
    expect(expiredLeaseActions).toContain('recover');

    // A resolved Tool Request stays ready_for_human but is no longer a live
    // handoff, so it routes to the human-review command view (operator picks the
    // lane), not the tool-request menu and not an auto-run generic recover.
    const resolvedTr = mkTask({
      status: 'ready_for_human',
      context: { toolRequest: { command: 'x', resolved: true } },
    });
    const resolvedActions = buildTaskMenuActions(resolvedTr, now).map((a) => a.action);
    expect(resolvedActions).not.toContain('tool-request');
    expect(resolvedActions).not.toContain('recover');
    expect(resolvedActions).toContain('human-review');
  });

  test('isToolRequestHandoff matches ready_for_human tasks carrying a toolRequest', () => {
    expect(
      isToolRequestHandoff(
        mkTask({ status: 'ready_for_human', context: { toolRequest: { command: 'x' } } }),
      ),
    ).toBe(true);
    // No toolRequest metadata, or not a human handoff -> not a tool-request handoff.
    expect(isToolRequestHandoff(mkTask({ status: 'ready_for_human' }))).toBe(false);
    expect(
      isToolRequestHandoff(mkTask({ status: 'failed', context: { toolRequest: { command: 'x' } } })),
    ).toBe(false);
    // Non-object metadata is ignored.
    expect(
      isToolRequestHandoff(mkTask({ status: 'ready_for_human', context: { toolRequest: 'x' } })),
    ).toBe(false);
    // A resolved request (e.g. after `tool-request resolve --action reject`) is
    // not a live handoff: tool-request list omits it and resolve/grant fail.
    expect(
      isToolRequestHandoff(
        mkTask({
          status: 'ready_for_human',
          context: { toolRequest: { command: 'x', resolved: true } },
        }),
      ),
    ).toBe(false);
  });

  test('buildToolRequestResolveArgv / grant target the dedicated tool-request flow', () => {
    const task = mkTask({ sessionId: 'sx', issueNumber: 42 });
    expect(buildToolRequestResolveArgv(task, 'manual-done', '/tmp/db')).toEqual([
      'tool-request',
      'resolve',
      '--session-id',
      'sx',
      '--issue-number',
      '42',
      '--action',
      'manual-done',
      '--db-path',
      '/tmp/db',
    ]);
    // reject surfaces a placeholder note (the resolve command requires --message).
    expect(buildToolRequestResolveArgv(task, 'reject')).toContain('--message');
    expect(buildToolRequestGrantArgv(task)).toEqual([
      'tool-request',
      'grant',
      '--session-id',
      'sx',
      '--issue-number',
      '42',
    ]);
  });

  test('buildToolRequestResolveArgv / grant preserve a custom sessions path', () => {
    const task = mkTask({ sessionId: 'sx', issueNumber: 42 });
    // resolve/grant load DEFAULT_SESSIONS_PATH unless --sessions-path is passed,
    // so a custom registry the UI was launched with must thread through.
    expect(buildToolRequestResolveArgv(task, 'manual-done', '/tmp/db', '/custom/sessions.json')).toEqual([
      'tool-request',
      'resolve',
      '--session-id',
      'sx',
      '--issue-number',
      '42',
      '--action',
      'manual-done',
      '--db-path',
      '/tmp/db',
      '--sessions-path',
      '/custom/sessions.json',
    ]);
    expect(buildToolRequestGrantArgv(task, undefined, '/custom/sessions.json')).toEqual([
      'tool-request',
      'grant',
      '--session-id',
      'sx',
      '--issue-number',
      '42',
      '--sessions-path',
      '/custom/sessions.json',
    ]);
    // No sessions path → no --sessions-path flag (default registry stays implicit).
    expect(buildToolRequestGrantArgv(task)).not.toContain('--sessions-path');
  });

  test('formatAdminCommand quotes arguments that need it', () => {
    expect(formatAdminCommand(['recover', '--session-id', 'sx'])).toBe('admin recover --session-id sx');
    expect(formatAdminCommand(['recover', '--session-id', 'a b'])).toContain("'a b'");
  });

  test('formatTaskLine and formatTaskDetail surface key fields', () => {
    const now = '2026-06-20T12:00:00.000Z';
    const task = mkTask({
      sessionId: 'sx',
      issueNumber: 9,
      status: 'failed',
      phase: 'review',
      context: { title: 'Title here' },
      lastError: 'kaboom',
    });
    const line = formatTaskLine(task, now);
    expect(line).toContain('#9');
    expect(line).toContain('failed');
    expect(line).toContain('kaboom');

    const detail = formatTaskDetail(task, now);
    expect(detail).toContain('Issue:');
    expect(detail).toContain('Title here');
    expect(detail).toContain('Blocker:');
  });

  test('taskColumns returns the documented column set', () => {
    const cols = taskColumns(mkTask({ issueNumber: 3 }), '2026-06-20T12:00:00.000Z');
    expect(Object.keys(cols).sort()).toEqual(
      ['attempts', 'blocker', 'issue', 'lease', 'phase', 'session', 'status', 'title', 'updated'].sort(),
    );
    expect(cols.issue).toBe('3');
  });
});

// ---------------------------------------------------------------------------
// Cross-session collection & session resolution
// ---------------------------------------------------------------------------

describe('admin ui — collectActiveTasks', () => {
  test('aggregates active tasks across sessions, newest first', async () => {
    const store = new SqliteTaskStore(dbPath);
    await store.enqueueTask({ sessionId: 'session-a', issueNumber: 1, phase: 'research', now: '2026-06-20T01:00:00.000Z' });
    await store.enqueueTask({ sessionId: 'session-b', issueNumber: 2, phase: 'implementation', now: '2026-06-20T03:00:00.000Z' });
    await store.enqueueTask({ sessionId: 'session-a', issueNumber: 3, phase: 'review', now: '2026-06-20T02:00:00.000Z' });

    const tasks = await collectActiveTasks(store, ['session-a', 'session-b']);
    store.close();

    expect(tasks).toHaveLength(3);
    // newest updatedAt first
    expect(tasks[0].issueNumber).toBe(2);
    const sessions = new Set(tasks.map((t) => t.sessionId));
    expect(sessions).toEqual(new Set(['session-a', 'session-b']));
  });

  test('is read-only and excludes done tasks', async () => {
    const store = new SqliteTaskStore(dbPath);
    await store.enqueueTask({ sessionId: 'session-a', issueNumber: 1, phase: 'research' });
    const claimed = await store.claimNextTask({ sessionId: 'session-a', runId: 'r1', workerId: 'w' });
    await store.transitionTask(
      { sessionId: 'session-a', issueNumber: claimed.issueNumber },
      { status: claimed.status },
      { status: 'done' },
    );

    const tasks = await collectActiveTasks(store, ['session-a']);
    store.close();
    expect(tasks).toHaveLength(0);
  });
});

describe('admin ui — resolveSessionIds', () => {
  test('returns a single session when --session-id is given', async () => {
    const ids = await resolveSessionIds(parseUiArgs(['--session-id', 'only-one']));
    expect(ids).toEqual(['only-one']);
  });

  test('enumerates all sessions from sessions.json when unfiltered', async () => {
    const sessionsPath = join(tmpDir, 'sessions.json');
    writeFileSync(
      sessionsPath,
      JSON.stringify({
        sessions: [
          {
            sessionId: 's1',
            repoKey: 'k1',
            repoRoot: '/tmp/r1',
            githubRepo: 'o/r1',
            artifactDir: '.art',
            defaults: { implementationAgent: 'claude', reviewAgent: 'codex' },
            labels: { active: 'ai:active', blocked: 'ai:blocked', readyForHuman: 'ai:ready' },
            verification: {},
          },
          {
            sessionId: 's2',
            repoKey: 'k2',
            repoRoot: '/tmp/r2',
            githubRepo: 'o/r2',
            artifactDir: '.art',
            defaults: { implementationAgent: 'claude', reviewAgent: 'codex' },
            labels: { active: 'ai:active', blocked: 'ai:blocked', readyForHuman: 'ai:ready' },
            verification: {},
          },
        ],
      }),
      'utf8',
    );
    const ids = await resolveSessionIds(parseUiArgs(['--sessions-path', sessionsPath]));
    expect(ids.sort()).toEqual(['s1', 's2']);
  });

  test('throws a helpful error when sessions.json is missing and no session given', async () => {
    const missing = join(tmpDir, 'nope.json');
    await expect(resolveSessionIds(parseUiArgs(['--sessions-path', missing]))).rejects.toThrow(
      /Sessions file not found/,
    );
  });
});

// ---------------------------------------------------------------------------
// Pagination helpers — bounded, keyboard-navigable task list
// ---------------------------------------------------------------------------

describe('admin ui — pagination helpers', () => {
  test('DEFAULT_PAGE_SIZE is a bounded, sensible page size', () => {
    expect(DEFAULT_PAGE_SIZE).toBeGreaterThanOrEqual(20);
    expect(DEFAULT_PAGE_SIZE).toBeLessThanOrEqual(25);
  });

  test('pageCount rounds up and is always at least 1', () => {
    expect(pageCount(0, 20)).toBe(1); // empty list still has one (empty) page
    expect(pageCount(1, 20)).toBe(1);
    expect(pageCount(20, 20)).toBe(1);
    expect(pageCount(21, 20)).toBe(2);
    expect(pageCount(174, 20)).toBe(9);
    expect(pageCount(40, 20)).toBe(2);
  });

  test('clampPage keeps the page within [0, pageCount-1]', () => {
    expect(clampPage(-5, 174, 20)).toBe(0);
    expect(clampPage(0, 174, 20)).toBe(0);
    expect(clampPage(8, 174, 20)).toBe(8); // last page
    expect(clampPage(99, 174, 20)).toBe(8); // clamped to last
    expect(clampPage(3, 0, 20)).toBe(0); // empty list → only page 0
  });

  test('pageForIndex maps a global index to its page', () => {
    expect(pageForIndex(0, 20)).toBe(0);
    expect(pageForIndex(19, 20)).toBe(0);
    expect(pageForIndex(20, 20)).toBe(1);
    expect(pageForIndex(41, 20)).toBe(2);
    expect(pageForIndex(-3, 20)).toBe(0);
  });

  test('pageSlice returns only the rows for the requested page', () => {
    const items = Array.from({ length: 174 }, (_, i) => i);
    expect(pageSlice(items, 0, 20)).toEqual(items.slice(0, 20));
    expect(pageSlice(items, 1, 20)).toEqual(items.slice(20, 40));
    // Last page is short (174 = 8*20 + 14).
    expect(pageSlice(items, 8, 20)).toEqual(items.slice(160, 174));
    expect(pageSlice(items, 8, 20)).toHaveLength(14);
    // Out-of-range page is clamped to the last page, never empty when items exist.
    expect(pageSlice(items, 99, 20)).toEqual(items.slice(160, 174));
  });

  test('moveSelectionByRow steps one row and clamps to the ends', () => {
    expect(moveSelectionByRow(5, 1, 174)).toBe(6);
    expect(moveSelectionByRow(5, -1, 174)).toBe(4);
    expect(moveSelectionByRow(0, -1, 174)).toBe(0); // clamp at top
    expect(moveSelectionByRow(173, 1, 174)).toBe(173); // clamp at bottom
    expect(moveSelectionByRow(0, -1, 0)).toBe(0); // empty list
  });

  test('moveSelectionByPage preserves the row offset within the page', () => {
    // Row 3 of page 0 → row 3 of page 1 (same position on screen).
    expect(moveSelectionByPage(3, 1, 174, 20)).toBe(23);
    // Row 3 of page 1 → row 3 of page 0 going back.
    expect(moveSelectionByPage(23, -1, 174, 20)).toBe(3);
    // Paging back from the first page stays put.
    expect(moveSelectionByPage(3, -1, 174, 20)).toBe(3);
    // Paging forward from the last page stays on the last page.
    expect(moveSelectionByPage(165, 1, 174, 20)).toBe(165);
  });

  test('moveSelectionByPage clamps the offset to the short final page', () => {
    // 174 items: last page (page 8) holds indices 160..173 (14 rows). Paging
    // from row 18 of page 7 would land at 178 — clamp to the last valid index.
    expect(moveSelectionByPage(158, 1, 174, 20)).toBe(173);
  });

  test('moveSelectionByPage handles an empty list', () => {
    expect(moveSelectionByPage(0, 1, 0, 20)).toBe(0);
  });

  test('formatPageStatus shows the page and item range', () => {
    expect(formatPageStatus(0, 174, 20)).toBe('Page 1/9 · tasks 1-20 of 174');
    expect(formatPageStatus(1, 174, 20)).toBe('Page 2/9 · tasks 21-40 of 174');
    expect(formatPageStatus(8, 174, 20)).toBe('Page 9/9 · tasks 161-174 of 174');
    // Out-of-range page is clamped before formatting.
    expect(formatPageStatus(99, 174, 20)).toBe('Page 9/9 · tasks 161-174 of 174');
    // Empty list.
    expect(formatPageStatus(0, 0, 20)).toBe('Page 0/0 · 0 tasks');
  });

  test('paging across a full list visits every item exactly once', () => {
    const total = 57;
    const pageSize = 20;
    const seen = new Set();
    for (let page = 0; page < pageCount(total, pageSize); page++) {
      for (const i of pageSlice(Array.from({ length: total }, (_, n) => n), page, pageSize)) {
        seen.add(i);
      }
    }
    expect(seen.size).toBe(total);
  });
});

// ---------------------------------------------------------------------------
// GitHub issue state filtering — partitionByGitHubState
// ---------------------------------------------------------------------------

describe('admin ui — partitionByGitHubState', () => {
  test('moves confirmed-closed issues to closedResidual', () => {
    const tasks = [
      mkTask({ issueNumber: 1 }),
      mkTask({ issueNumber: 2 }),
      mkTask({ issueNumber: 3 }),
    ];
    const reader = (_sid, n) => (n === 2 ? 'closed' : 'open');
    const { active, closedResidual, warning } = partitionByGitHubState(tasks, reader);
    expect(active.map((t) => t.issueNumber)).toEqual([1, 3]);
    expect(closedResidual.map((t) => t.issueNumber)).toEqual([2]);
    expect(warning).toBeNull();
  });

  test('keeps open-issue tasks in the active list', () => {
    const tasks = [mkTask({ issueNumber: 5 })];
    const { active, closedResidual, warning } = partitionByGitHubState(tasks, () => 'open');
    expect(active).toHaveLength(1);
    expect(closedResidual).toHaveLength(0);
    expect(warning).toBeNull();
  });

  test('includes unknown-state tasks in active list and adds a warning', () => {
    const tasks = [mkTask({ issueNumber: 1 }), mkTask({ issueNumber: 2 })];
    const reader = (_sid, n) => (n === 1 ? 'open' : 'unknown');
    const { active, closedResidual, warning } = partitionByGitHubState(tasks, reader);
    expect(active).toHaveLength(2); // fail-safe: unknown stays in active
    expect(closedResidual).toHaveLength(0);
    expect(warning).not.toBeNull();
    expect(warning).toContain('unverified');
    expect(warning).toContain('1 of 2');
  });

  test('emits DB-local-only warning when all task states are unknown', () => {
    const tasks = [mkTask({ issueNumber: 1 }), mkTask({ issueNumber: 2 })];
    const { active, closedResidual, warning } = partitionByGitHubState(tasks, () => 'unknown');
    expect(active).toHaveLength(2); // fail-safe: include all
    expect(closedResidual).toHaveLength(0);
    expect(warning).toContain('DB-local');
  });

  test('returns no warning when all states are known and no closed issues', () => {
    const tasks = [mkTask({ issueNumber: 1 }), mkTask({ issueNumber: 2 })];
    const { warning } = partitionByGitHubState(tasks, () => 'open');
    expect(warning).toBeNull();
  });

  test('handles an empty task list without warning', () => {
    const { active, closedResidual, warning } = partitionByGitHubState([], () => 'open');
    expect(active).toHaveLength(0);
    expect(closedResidual).toHaveLength(0);
    expect(warning).toBeNull();
  });

  test('can have all tasks closed when all issues are closed', () => {
    const tasks = [mkTask({ issueNumber: 1 }), mkTask({ issueNumber: 2 })];
    const { active, closedResidual, warning } = partitionByGitHubState(tasks, () => 'closed');
    expect(active).toHaveLength(0);
    expect(closedResidual).toHaveLength(2);
    expect(warning).toBeNull(); // no unknown states
  });
});

// ---------------------------------------------------------------------------
// Closed-issue task menu — buildClosedTaskMenuActions
// ---------------------------------------------------------------------------

describe('admin ui — buildClosedTaskMenuActions', () => {
  test('contains only inspect-oriented actions', () => {
    const actions = buildClosedTaskMenuActions().map((a) => a.action);
    expect(actions).toContain('events');
    expect(actions).toContain('artifacts');
    expect(actions).toContain('inspect');
    expect(actions).toContain('back');
    expect(actions).toContain('quit');
  });

  test('omits all state-changing actions', () => {
    const actions = buildClosedTaskMenuActions().map((a) => a.action);
    expect(actions).not.toContain('recover');
    expect(actions).not.toContain('cap-reset');
    expect(actions).not.toContain('tool-request');
    expect(actions).not.toContain('human-review');
    expect(actions).not.toContain('copy');
  });
});

// ---------------------------------------------------------------------------
// buildCachingReader and populateStateCache — non-blocking startup
// ---------------------------------------------------------------------------

describe('admin ui — buildCachingReader and populateStateCache', () => {
  test('caching reader returns unknown for all tasks when cache is empty (fast startup)', () => {
    const cache = new Map();
    const reader = buildCachingReader(cache);
    const tasks = Array.from({ length: 5 }, (_, i) =>
      mkTask({ sessionId: 'session-a', issueNumber: i + 1 }),
    );
    const { active, warning } = partitionByGitHubState(tasks, reader);
    expect(active).toHaveLength(5);
    expect(warning).toContain('DB-local');
  });

  test('does not invoke the real reader before explicit refresh — even with many tasks', () => {
    // Verifies the acceptance criterion: startup with 174+ tasks never calls gh.
    const cache = new Map();
    const cachingReader = buildCachingReader(cache);
    let realReaderCallCount = 0;
    const realReader = () => { realReaderCallCount++; return 'open'; };

    const manyTasks = Array.from({ length: 174 }, (_, i) =>
      mkTask({ sessionId: `session-${i % 5}`, issueNumber: i + 1 }),
    );

    // Startup path: caching reader only — zero calls to the real reader.
    partitionByGitHubState(manyTasks, cachingReader);
    expect(realReaderCallCount).toBe(0);

    // Only after explicit refresh does the real reader get called.
    populateStateCache(manyTasks, realReader, cache);
    expect(realReaderCallCount).toBe(174);
  });

  test('populateStateCache fills cache and caching reader reflects updated states', () => {
    const cache = new Map();
    const reader = buildCachingReader(cache);
    const tasks = [
      mkTask({ sessionId: 'session-a', issueNumber: 1 }),
      mkTask({ sessionId: 'session-a', issueNumber: 2 }),
      mkTask({ sessionId: 'session-a', issueNumber: 3 }),
    ];

    // Before refresh: all unknown (fast startup path).
    expect(reader('session-a', 1)).toBe('unknown');
    expect(reader('session-a', 2)).toBe('unknown');

    let callCount = 0;
    const realReader = (sid, n) => { callCount++; return n === 2 ? 'closed' : 'open'; };

    populateStateCache(tasks, realReader, cache);

    // After refresh: cache is populated and reader reflects verified states.
    expect(callCount).toBe(3);
    expect(reader('session-a', 1)).toBe('open');
    expect(reader('session-a', 2)).toBe('closed');
    expect(reader('session-a', 3)).toBe('open');

    const { active, closedResidual, warning } = partitionByGitHubState(tasks, reader);
    expect(active).toHaveLength(2);
    expect(closedResidual).toHaveLength(1);
    expect(closedResidual[0].issueNumber).toBe(2);
    expect(warning).toBeNull();
  });

  test('populateStateCache with failed/slow reader stores unknown — tasks stay visible (fail-safe)', () => {
    // Simulates gh auth failure or network timeout during explicit refresh:
    // buildGhIssueStateReader catches subprocess errors and returns "unknown",
    // so populateStateCache stores "unknown" and tasks remain in the active list.
    const cache = new Map();
    const tasks = [
      mkTask({ sessionId: 'session-a', issueNumber: 1 }),
      mkTask({ sessionId: 'session-a', issueNumber: 2 }),
    ];

    const failSafeReader = () => 'unknown'; // buildGhIssueStateReader returns this on any error
    populateStateCache(tasks, failSafeReader, cache);

    const reader = buildCachingReader(cache);
    expect(reader('session-a', 1)).toBe('unknown');
    expect(reader('session-a', 2)).toBe('unknown');

    const { active, closedResidual, warning } = partitionByGitHubState(tasks, reader);
    expect(active).toHaveLength(2); // fail-safe: not hidden
    expect(closedResidual).toHaveLength(0);
    expect(warning).toContain('DB-local');
  });

  test('populateStateCache overwrites stale cache entries on re-refresh', () => {
    const cache = new Map();
    const tasks = [mkTask({ sessionId: 'session-a', issueNumber: 1 })];

    // First refresh: issue is open.
    populateStateCache(tasks, () => 'open', cache);
    expect(buildCachingReader(cache)('session-a', 1)).toBe('open');

    // Issue is now closed on GitHub — second refresh updates the cache.
    populateStateCache(tasks, () => 'closed', cache);
    expect(buildCachingReader(cache)('session-a', 1)).toBe('closed');
  });

  test('caching reader returns unknown for sessionIds not present in cache', () => {
    const cache = new Map([['session-a:1', 'open']]);
    const reader = buildCachingReader(cache);
    expect(reader('session-a', 1)).toBe('open');
    expect(reader('session-b', 1)).toBe('unknown'); // different session
    expect(reader('session-a', 2)).toBe('unknown'); // different issue
  });
});

// ---------------------------------------------------------------------------
// buildGhIssueStateReader — fail-safe on missing session or error
// ---------------------------------------------------------------------------

describe('admin ui — buildGhIssueStateReader', () => {
  test('returns "unknown" when the sessionId is not in the map', () => {
    const reader = buildGhIssueStateReader(new Map());
    expect(reader('missing-session', 1)).toBe('unknown');
  });

  test('returns "unknown" when gh subprocess fails', () => {
    // Inject a runner that always throws to guarantee a local failure without
    // any network call or dependency on gh being installed.
    const sessionMap = new Map([
      ['s', { githubRepo: 'owner/repo', repoRoot: tmpDir }],
    ]);
    const failingRunner = () => { throw new Error('forced subprocess failure'); };
    const reader = buildGhIssueStateReader(sessionMap, failingRunner);
    expect(reader('s', 9999)).toBe('unknown');
  });

  test('passes timeout: 5000 to GhRunner.run for App auth sessions', () => {
    const capturedOpts = {};
    const appRunner = {
      run(args, opts) {
        Object.assign(capturedOpts, opts);
        return { exitCode: 0, stdout: JSON.stringify({ state: 'OPEN' }), stderr: '' };
      },
    };
    const sessionMap = new Map([
      ['s', { githubRepo: 'owner/repo', repoRoot: tmpDir, runner: appRunner }],
    ]);
    const reader = buildGhIssueStateReader(sessionMap);
    expect(reader('s', 42)).toBe('open');
    expect(capturedOpts.timeout).toBe(5000);
  });

  test('returns "unknown" when App auth GhRunner.run times out (throws)', () => {
    const timedOutRunner = {
      run() { throw new Error('spawnSync ETIMEDOUT'); },
    };
    const sessionMap = new Map([
      ['s', { githubRepo: 'owner/repo', repoRoot: tmpDir, runner: timedOutRunner }],
    ]);
    const reader = buildGhIssueStateReader(sessionMap);
    expect(reader('s', 42)).toBe('unknown');
  });

  test('returns "unknown" and does not fall back to raw gh when App auth failed (runner === null)', () => {
    // runner === null signals that a non-gh auth (e.g. github-app) was
    // configured but credential resolution failed. The reader must not
    // silently use the operator's raw gh credentials in this case.
    const rawGhCalled = { called: false };
    const rawGhRunner = () => {
      rawGhCalled.called = true;
      return JSON.stringify({ state: 'OPEN' });
    };
    const sessionMap = new Map([
      ['s', { githubRepo: 'owner/repo', repoRoot: tmpDir, runner: null }],
    ]);
    const reader = buildGhIssueStateReader(sessionMap, rawGhRunner);
    expect(reader('s', 42)).toBe('unknown');
    expect(rawGhCalled.called).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// applyFilter, isFilterActive, formatFilterStatus — pure filter helpers
// ---------------------------------------------------------------------------

describe('admin ui — filtering helpers', () => {
  function mkTasks() {
    return [
      mkTask({ issueNumber: 10, status: 'failed', phase: 'implementation', context: { title: 'Auth bug fix' }, lastError: 'permission denied' }),
      mkTask({ issueNumber: 20, status: 'queued', phase: 'review', context: { title: 'Add search endpoint' } }),
      mkTask({ issueNumber: 30, status: 'blocked', phase: 'implementation', context: { title: 'Refactor DB layer' } }),
      mkTask({ issueNumber: 42, status: 'failed', phase: 'research', context: { title: 'Token refresh' }, lastError: 'auth failure' }),
    ];
  }

  test('isFilterActive returns false for empty filter', () => {
    expect(isFilterActive({})).toBe(false);
  });

  test('isFilterActive returns true when issueNumber is set', () => {
    expect(isFilterActive({ issueNumber: 10 })).toBe(true);
  });

  test('isFilterActive returns true when status is set', () => {
    expect(isFilterActive({ status: 'failed' })).toBe(true);
  });

  test('isFilterActive returns true when phase is set', () => {
    expect(isFilterActive({ phase: 'review' })).toBe(true);
  });

  test('isFilterActive returns true when text is non-empty', () => {
    expect(isFilterActive({ text: 'auth' })).toBe(true);
  });

  test('isFilterActive returns false when text is empty string', () => {
    expect(isFilterActive({ text: '' })).toBe(false);
  });

  test('formatFilterStatus returns empty string for empty filter', () => {
    expect(formatFilterStatus({})).toBe('');
  });

  test('formatFilterStatus formats issueNumber', () => {
    expect(formatFilterStatus({ issueNumber: 42 })).toBe('issue:#42');
  });

  test('formatFilterStatus formats status', () => {
    expect(formatFilterStatus({ status: 'failed' })).toBe('status:failed');
  });

  test('formatFilterStatus formats phase', () => {
    expect(formatFilterStatus({ phase: 'review' })).toBe('phase:review');
  });

  test('formatFilterStatus formats text search', () => {
    expect(formatFilterStatus({ text: 'auth' })).toBe('search:"auth"');
  });

  test('formatFilterStatus composes multiple active filters with separator', () => {
    const result = formatFilterStatus({ status: 'failed', phase: 'implementation' });
    expect(result).toContain('status:failed');
    expect(result).toContain('phase:implementation');
    expect(result).toContain(' · ');
  });

  test('applyFilter with issueNumber returns only matching task', () => {
    const tasks = mkTasks();
    const result = applyFilter(tasks, { issueNumber: 20 });
    expect(result).toHaveLength(1);
    expect(result[0].issueNumber).toBe(20);
  });

  test('applyFilter with unknown issueNumber returns empty array', () => {
    const tasks = mkTasks();
    expect(applyFilter(tasks, { issueNumber: 999 })).toHaveLength(0);
  });

  test('applyFilter with status=failed returns only failed tasks', () => {
    const tasks = mkTasks();
    const result = applyFilter(tasks, { status: 'failed' });
    expect(result).toHaveLength(2);
    expect(result.every(t => t.status === 'failed')).toBe(true);
  });

  test('applyFilter with status=queued returns only queued tasks', () => {
    const tasks = mkTasks();
    const result = applyFilter(tasks, { status: 'queued' });
    expect(result).toHaveLength(1);
    expect(result[0].issueNumber).toBe(20);
  });

  test('applyFilter with phase=implementation returns only implementation tasks', () => {
    const tasks = mkTasks();
    const result = applyFilter(tasks, { phase: 'implementation' });
    expect(result).toHaveLength(2);
    expect(result.every(t => t.phase === 'implementation')).toBe(true);
  });

  test('applyFilter with text matches issue title (case-insensitive)', () => {
    const tasks = mkTasks();
    const result = applyFilter(tasks, { text: 'auth' });
    // "Auth bug fix" (title of #10) and "auth failure" (blocker of #42)
    expect(result.map(t => t.issueNumber)).toContain(10);
    expect(result.map(t => t.issueNumber)).toContain(42);
  });

  test('applyFilter with text matches blocker summary', () => {
    const tasks = mkTasks();
    const result = applyFilter(tasks, { text: 'permission denied' });
    expect(result).toHaveLength(1);
    expect(result[0].issueNumber).toBe(10);
  });

  test('applyFilter with text that matches nothing returns empty array', () => {
    const tasks = mkTasks();
    expect(applyFilter(tasks, { text: 'zzznomatch' })).toHaveLength(0);
  });

  test('applyFilter composes status and phase (AND semantics)', () => {
    const tasks = mkTasks();
    const result = applyFilter(tasks, { status: 'failed', phase: 'implementation' });
    expect(result).toHaveLength(1);
    expect(result[0].issueNumber).toBe(10);
  });

  test('applyFilter with empty filter returns all tasks', () => {
    const tasks = mkTasks();
    expect(applyFilter(tasks, {})).toHaveLength(tasks.length);
  });

  test('pagination reflects filtered task count correctly', () => {
    const tasks = mkTasks();
    const filtered = applyFilter(tasks, { status: 'failed' });
    expect(pageCount(filtered.length, 20)).toBe(1);
    expect(pageCount(filtered.length, 1)).toBe(2);
  });

  test('pageSlice on filtered tasks is consistent with the filtered total', () => {
    const tasks = mkTasks();
    const filtered = applyFilter(tasks, { phase: 'implementation' });
    const page = pageSlice(filtered, 0, 20);
    expect(page).toHaveLength(filtered.length);
    expect(page.every(t => t.phase === 'implementation')).toBe(true);
  });

  test('session filter from CLI args is not affected by applyFilter', () => {
    // applyFilter always operates on the already-session-scoped set returned by
    // collectActiveTasks; it never sees tasks from other sessions.
    const sessionATasks = [
      mkTask({ sessionId: 'session-a', issueNumber: 1, status: 'failed' }),
      mkTask({ sessionId: 'session-a', issueNumber: 2, status: 'queued' }),
    ];
    const filtered = applyFilter(sessionATasks, { status: 'failed' });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].sessionId).toBe('session-a');
  });
});

// ---------------------------------------------------------------------------
// Session scope helpers
// ---------------------------------------------------------------------------

describe('admin ui — session scope helpers', () => {
  const sessions = ['session-a', 'session-b', 'session-c'];

  test('formatSessionScope for "all" includes the total count', () => {
    const label = formatSessionScope({ kind: 'all' }, sessions.length);
    expect(label).toContain('all');
    expect(label).toContain(String(sessions.length));
  });

  test('formatSessionScope for "one" returns the session id', () => {
    const label = formatSessionScope({ kind: 'one', sessionId: 'session-b' }, sessions.length);
    expect(label).toBe('session-b');
  });

  test('sessionIdsForScope "all" returns every id', () => {
    const ids = sessionIdsForScope({ kind: 'all' }, sessions);
    expect(ids).toEqual(sessions);
  });

  test('sessionIdsForScope "one" returns only the selected id', () => {
    const ids = sessionIdsForScope({ kind: 'one', sessionId: 'session-b' }, sessions);
    expect(ids).toEqual(['session-b']);
  });

  test('collectActiveTasks scoped to one session returns only that session\'s tasks', async () => {
    const store = new SqliteTaskStore(dbPath);
    await store.enqueueTask({ sessionId: 'session-a', issueNumber: 1, phase: 'implementation' });
    await store.enqueueTask({ sessionId: 'session-b', issueNumber: 2, phase: 'implementation' });

    const scopedIds = sessionIdsForScope({ kind: 'one', sessionId: 'session-a' }, ['session-a', 'session-b']);
    const tasks = await collectActiveTasks(store, scopedIds);
    store.close();

    expect(tasks).toHaveLength(1);
    expect(tasks[0].sessionId).toBe('session-a');
  });

  test('collectActiveTasks scoped to "all" returns tasks from all sessions', async () => {
    const store = new SqliteTaskStore(dbPath);
    await store.enqueueTask({ sessionId: 'session-a', issueNumber: 1, phase: 'implementation' });
    await store.enqueueTask({ sessionId: 'session-b', issueNumber: 2, phase: 'implementation' });

    const scopedIds = sessionIdsForScope({ kind: 'all' }, ['session-a', 'session-b']);
    const tasks = await collectActiveTasks(store, scopedIds);
    store.close();

    expect(tasks).toHaveLength(2);
    expect(tasks.map(t => t.sessionId).sort()).toEqual(['session-a', 'session-b']);
  });

  test('switching scope from "all" to "one" filters the task list', async () => {
    const store = new SqliteTaskStore(dbPath);
    await store.enqueueTask({ sessionId: 'session-a', issueNumber: 1, phase: 'implementation' });
    await store.enqueueTask({ sessionId: 'session-b', issueNumber: 2, phase: 'implementation' });

    const allScope = { kind: 'all' };
    const allTasks = await collectActiveTasks(store, sessionIdsForScope(allScope, ['session-a', 'session-b']));
    expect(allTasks).toHaveLength(2);

    const oneScope = { kind: 'one', sessionId: 'session-b' };
    const scopedTasks = await collectActiveTasks(store, sessionIdsForScope(oneScope, ['session-a', 'session-b']));
    store.close();
    expect(scopedTasks).toHaveLength(1);
    expect(scopedTasks[0].sessionId).toBe('session-b');
  });
});

// ---------------------------------------------------------------------------
// Worktree-aware UI helpers (issue #447)
// ---------------------------------------------------------------------------

describe('admin ui — worktree lock awareness', () => {
  const now = '2026-06-20T12:00:00.000Z';

  test('buildTaskMenuActions routes a LIVE held lock to lock-force-release, not lock-release', () => {
    // A held lock is always within its TTL (the reader reports locked = !stale), so
    // `worktree release-lock` refuses it without --force. The plain `--yes`
    // lock-release action would no-op, so the live lock must be routed to the
    // distinct force-release action instead.
    const task = mkTask({ status: 'failed' });
    const actions = buildTaskMenuActions(task, now, { held: true, stale: false }).map(a => a.action);
    expect(actions).toContain('lock-force-release');
    expect(actions).not.toContain('lock-release');
  });

  test('buildTaskMenuActions routes a stale lock file to lock-release, not lock-force-release', () => {
    const task = mkTask({ status: 'failed' });
    const actions = buildTaskMenuActions(task, now, { held: false, stale: true }).map(a => a.action);
    expect(actions).toContain('lock-release');
    expect(actions).not.toContain('lock-force-release');
  });

  test('buildTaskMenuActions offers no lock action when lock is free and not stale', () => {
    const task = mkTask({ status: 'failed' });
    const actions = buildTaskMenuActions(task, now, { held: false, stale: false }).map(a => a.action);
    expect(actions).not.toContain('lock-release');
    expect(actions).not.toContain('lock-force-release');
  });

  test('buildTaskMenuActions offers no lock action when no lockState is provided', () => {
    const task = mkTask({ status: 'failed' });
    const actions = buildTaskMenuActions(task, now).map(a => a.action);
    expect(actions).not.toContain('lock-release');
    expect(actions).not.toContain('lock-force-release');
  });

  test('buildTaskMenuActions always includes status action', () => {
    const task = mkTask({ status: 'queued' });
    const actions = buildTaskMenuActions(task, now);
    expect(actions.map(a => a.action)).toContain('status');
  });

  test('buildLockReleaseArgv generates correct worktree release-lock argv', () => {
    const task = mkTask({ sessionId: 'sx', issueNumber: 42 });
    const argv = buildLockReleaseArgv(task);
    expect(argv).toEqual([
      'worktree',
      'release-lock',
      '--session-id',
      'sx',
      '--issue-number',
      '42',
      '--yes',
    ]);
    // `worktree release-lock` previews by default; the UI already confirms the
    // action, so --yes must be present for the lock to actually be released.
    expect(argv).toContain('--yes');
    // Without an explicit force opt-in, --force must not be added: the default
    // release path targets stale locks, which release without it.
    expect(argv).not.toContain('--force');
  });

  test('buildLockReleaseArgv appends --force (with --yes) for a live-lock force-release', () => {
    const task = mkTask({ sessionId: 'sx', issueNumber: 42 });
    const argv = buildLockReleaseArgv(task, { force: true });
    // A live (within-TTL) lock is refused unless --force accompanies --yes; both
    // must be present or the confirmed force-release would silently no-op.
    expect(argv).toContain('--yes');
    expect(argv).toContain('--force');
    expect(argv).toEqual([
      'worktree',
      'release-lock',
      '--session-id',
      'sx',
      '--issue-number',
      '42',
      '--yes',
      '--force',
    ]);
  });

  test('buildStatusArgv generates correct admin status argv with optional paths', () => {
    const task = mkTask({ sessionId: 'sx', issueNumber: 42 });
    expect(buildStatusArgv(task)).toEqual([
      'status',
      '--session-id',
      'sx',
      '--issue-number',
      '42',
    ]);
    expect(buildStatusArgv(task, '/tmp/db', '/tmp/sessions.json')).toEqual([
      'status',
      '--session-id',
      'sx',
      '--issue-number',
      '42',
      '--db-path',
      '/tmp/db',
      '--sessions-path',
      '/tmp/sessions.json',
    ]);
  });

  test('formatTaskDetail includes worktree lock line when lockState is provided', () => {
    const task = mkTask({ sessionId: 'sx', issueNumber: 1 });
    const detail = formatTaskDetail(task, now, { held: true, stale: null });
    expect(detail).toContain('Wt lock:');
    expect(detail).toContain('held');
  });

  test('formatTaskDetail shows stale indicator when lock is stale', () => {
    const task = mkTask({ sessionId: 'sx', issueNumber: 1 });
    const detail = formatTaskDetail(task, now, { held: true, stale: true });
    expect(detail).toContain('STALE');
  });

  test('formatTaskDetail omits worktree lock line when no lockState is provided', () => {
    const task = mkTask({ sessionId: 'sx', issueNumber: 1 });
    const detail = formatTaskDetail(task, now);
    expect(detail).not.toContain('Wt lock:');
  });

  test('nonTtyHelp mentions admin status and worktree release-lock', () => {
    const help = nonTtyHelp();
    expect(help).toContain('admin status');
    expect(help).toContain('worktree release-lock');
  });
});
