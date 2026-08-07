/**
 * Issue #848: the operator surfaces of the review-dispute protocol.
 *
 * `admin dispute status`, `admin dispute reopen`, the `task-status` extension,
 * and the admin UI's task detail all render ONE projection
 * (`summarizeDisputeStatus`), so the tests below assert parity between them
 * rather than three independent formats. What they pin:
 *
 *  - the persisted lineage/counter state and the routing/stop reason reach the
 *    operator, from task context and bounded task events only;
 *  - a "next action" is offered only where the contract defines a continuation,
 *    and the stop reason is stated verbatim where it does not;
 *  - the one mutating action (§6.4) is exact-lineage/version CAS'd, previews by
 *    default, and cannot touch a lineage that is not terminal, a version that
 *    has moved, or a task a run is holding;
 *  - a legacy task — no protocol block — keeps byte-identical output.
 */
// `jest` is not a global under `--experimental-vm-modules`; the ESM suites that
// need the object import it explicitly.
import { jest } from '@jest/globals';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SqliteTaskStore } from '../dist/index.js';
import { REVIEW_DISPUTE_DEFAULT_LIMITS, ZERO_LINEAGE_COUNTERS } from '../dist/core/review-dispute.js';
import { parseFixDispositionResponse } from '../dist/core/review-fix-disposition-response.js';
import { persistFixDisputes } from '../dist/core/review-dispute-persistence.js';
import { applyDisputeTransition } from '../dist/core/review-dispute-transition.js';
import {
  commitDisputeTransition,
  REVIEW_DISPUTE_CONTEXT_KEY,
  REVIEW_DISPUTE_TRANSITION_EVENT,
} from '../dist/core/review-dispute-commit.js';
import { disputeReopenArgv, summarizeDisputeStatus } from '../dist/core/review-dispute-status.js';
import { buildDisputeStatusArgv, buildTaskMenuActions, formatTaskDetail } from '../dist/cli/admin-ui.js';

// Every case below spawns the real CLI (several times, for the preview/apply
// pairs). Jest's 5s default is a coin flip for that under a parallel run, so the
// whole file gets the same headroom the other subprocess-spawning suites give
// their individual cases.
jest.setTimeout(30_000);

const CLI = new URL('../dist/cli/admin.js', import.meta.url).pathname;
const SESSION = 'test-session';
const ISSUE = 848;
const KEY = { sessionId: SESSION, issueNumber: ISSUE };
const LINEAGE_A = 'ln-aaaaaaaaaaaa';
const LINEAGE_B = 'ln-bbbbbbbbbbbb';
const BOUNDARY = 'src/auth/handler.ts';
const ARGUMENT = 'The null session is already rejected by the middleware, so the cited crash cannot occur.';
const NOW = '2026-08-06T12:00:00.000Z';

let tmpDir;
let dbPath;
let sessionsPath;

function run(...args) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    return { code: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

function parse(result) {
  return JSON.parse(result.stdout.trim());
}

function writeSessions(reviewDispute = { enabled: true }) {
  writeFileSync(
    sessionsPath,
    JSON.stringify({
      sessions: [
        {
          sessionId: SESSION,
          repoKey: 'test-repo',
          repoRoot: tmpDir,
          githubRepo: 'org/repo',
          artifactDir: '.n8n-artifacts',
          baseBranch: 'main',
          defaults: { implementationAgent: 'claude', reviewAgent: 'codex' },
          verification: { test: 'npm test' },
          labels: { active: 'ai:active', blocked: 'ai:blocked', readyForHuman: 'ai:ready-for-human' },
          reviewDispute,
        },
      ],
    }),
  );
}

// --- protocol fixtures, built by the real pipeline -------------------------

function lineage(id, overrides = {}) {
  const { counters: counterOverrides, ...rest } = overrides;
  return {
    lineageId: id,
    state: 'open',
    version: 1,
    counters: { ...ZERO_LINEAGE_COUNTERS, ...counterOverrides },
    rebuttedVersions: [],
    humanGate: false,
    severity: 'P1',
    affectedBoundary: BOUNDARY,
    ...rest,
  };
}

function context(lineages) {
  return { version: 1, reviewStructure: 'structured', lineages };
}

function record(id, disposition) {
  if (disposition === 'fixed') return { lineageId: id, version: 1, disposition: 'fixed', note: 'Added the guard.' };
  if (disposition === 'blocked') {
    return { lineageId: id, version: 1, disposition: 'blocked', note: 'Needs a credential automation cannot supply.' };
  }
  return {
    lineageId: id,
    version: 1,
    disposition: 'review_disputed',
    dispute: {
      challenged: { lineageId: id, version: 1 },
      rebuttalReason: 'false_premise',
      argument: ARGUMENT,
      evidenceRefs: [{ kind: 'file', path: BOUNDARY, startLine: 30, endLine: 36 }],
      whyNoChange: 'A second guard would duplicate the existing one without changing behavior.',
    },
  };
}

function applied(ctx, records, { diff = false, runId = 'run-impl-1' } = {}) {
  const findings = Object.values(ctx.lineages)
    .filter((l) => l.state === 'open' || l.state === 'binding')
    .map((l) => ({
      lineageId: l.lineageId,
      version: l.version,
      state: l.state,
      severity: l.severity,
      affectedBoundary: l.affectedBoundary,
      allowedDispositions: ['fixed', 'review_disputed', 'blocked'],
    }));
  const outcome = parseFixDispositionResponse({
    response: `\`\`\`json\n${JSON.stringify(records)}\n\`\`\``,
    findings,
    lineages: ctx.lineages,
    reviewStructure: ctx.reviewStructure,
    runProducedFileChanges: diff,
    resolveEvidenceRef: () => true,
    limits: REVIEW_DISPUTE_DEFAULT_LIMITS,
  });
  const persisted = persistFixDisputes({
    context: ctx,
    outcome,
    run: { runId, agentId: 'claude', timestamp: NOW },
    runProducedFileChanges: diff,
  });
  if (!persisted.ok) throw new Error(`fixture not persisted: ${JSON.stringify(persisted.failure)}`);
  const result = applyDisputeTransition({
    context: ctx,
    decision: { kind: 'dispositions', persistence: persisted.value, outcome, runProducedFileChanges: diff },
    run: { runId, actor: 'implementer' },
  });
  if (!result.ok) throw new Error(`transition failed: ${JSON.stringify(result.failure)}`);
  return result.value;
}

/** Seed a task whose §10.1 block and §10.3 event come from a real application. */
async function seed(application, { status = 'ready_for_human', extraContext = {}, undispatchedTurn } = {}) {
  const store = new SqliteTaskStore(dbPath);
  try {
    await store.enqueueTask({
      sessionId: SESSION,
      issueNumber: ISSUE,
      phase: 'review',
      priority: 'normal',
      context: {},
      now: '2026-08-06T11:00:00.000Z',
    });
    const patched = await store.transitionTask(
      KEY,
      { status: 'queued' },
      {
        status,
        context: {
          ...(application ? { [REVIEW_DISPUTE_CONTEXT_KEY]: application.context } : {}),
          ...extraContext,
        },
        now: NOW,
      },
    );
    if (!patched.ok) throw new Error(`seed transition failed: ${patched.code}`);
    if (application) {
      await store.appendEvent({
        task: KEY,
        type: REVIEW_DISPUTE_TRANSITION_EVENT,
        runId: 'run-impl-1',
        data: {
          ...application.event,
          ...(undispatchedTurn ? { undispatchedTurn } : {}),
        },
        createdAt: NOW,
      });
    }
    return await store.getTask(KEY);
  } finally {
    store.close();
  }
}

async function readTask() {
  const store = new SqliteTaskStore(dbPath);
  try {
    return await store.getTask(KEY);
  } finally {
    store.close();
  }
}

async function readEvents() {
  const store = new SqliteTaskStore(dbPath);
  try {
    return await store.listEvents(KEY);
  } finally {
    store.close();
  }
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'admin-dispute-'));
  dbPath = join(tmpDir, 'test.db');
  sessionsPath = join(tmpDir, 'sessions.json');
  writeSessions();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// dispute status
// ---------------------------------------------------------------------------

describe('admin dispute status', () => {
  test('shows every persisted lineage field and counter', async () => {
    const ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A) });
    await seed(applied(ctx, [record(LINEAGE_A, 'blocked')]));

    const r = run('dispute', 'status', '--session-id', SESSION, '--issue-number', String(ISSUE),
      '--db-path', dbPath, '--sessions-path', sessionsPath);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(LINEAGE_A);
    expect(r.stdout).toContain('escalated_human');
    expect(r.stdout).toContain('P1');
    expect(r.stdout).toContain(BOUNDARY);
    expect(r.stdout).toContain('rebuttals=0');
    expect(r.stdout).toContain('arbitrationPasses=0');
    expect(r.stdout).toContain('malformedArbiter=0');
    expect(r.stdout).toContain('evidenceRounds=0');
  });

  test('--json exposes the same state as stable fields', async () => {
    const ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A) });
    await seed(applied(ctx, [record(LINEAGE_A, 'blocked')]));

    const payload = parse(
      run('dispute', 'status', '--session-id', SESSION, '--issue-number', String(ISSUE),
        '--db-path', dbPath, '--json'),
    );
    expect(payload.ok).toBe(true);
    expect(payload.dispute.lineages).toHaveLength(1);
    expect(payload.dispute.lineages[0]).toMatchObject({
      lineageId: LINEAGE_A,
      version: 1,
      state: 'escalated_human',
      outcome: 'escalated_human',
      terminal: true,
      severity: 'P1',
      affectedBoundary: BOUNDARY,
      humanGate: false,
      reopenRequested: false,
      counters: {
        rebuttals: 0,
        reconsiderations: 0,
        arbitrationPasses: 0,
        malformedArbiterAttempts: 0,
        evidenceRoundsUsed: 0,
      },
    });
    expect(payload.dispute.routing.outcome).toBe('human_handoff');
  });

  test('never emits an absolute local path', async () => {
    const ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A) });
    await seed(applied(ctx, [record(LINEAGE_A, 'blocked')]));
    const r = run('dispute', 'status', '--session-id', SESSION, '--issue-number', String(ISSUE),
      '--db-path', dbPath);
    expect(r.stdout).not.toContain(tmpDir);
    expect(r.stdout).not.toMatch(/\/Users\//);
  });

  test('the suggested reopen command keeps a custom registry and store, as placeholders', async () => {
    const ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A) });
    await seed(applied(ctx, [record(LINEAGE_A, 'fixed')], { diff: true }));

    const r = run('dispute', 'status', '--session-id', SESSION, '--issue-number', String(ISSUE),
      '--db-path', dbPath, '--sessions-path', sessionsPath);
    expect(r.code).toBe(0);
    // `dispute reopen` resolves the session for its §6.1 limits, so a command
    // that dropped the flag would run against the default registry.
    expect(r.stdout).toContain('--sessions-path');
    expect(r.stdout).toContain('--db-path');
    // Still no absolute local path in output that gets forwarded and recorded.
    expect(r.stdout).not.toContain(tmpDir);
    expect(r.stdout).toContain('<SESSIONS_PATH>');
    expect(r.stdout).toContain('<DB_PATH>');
  });

  test('the default registry adds no flag to the suggested reopen command', async () => {
    const ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A) });
    await seed(applied(ctx, [record(LINEAGE_A, 'fixed')], { diff: true }));

    const r = run('dispute', 'status', '--session-id', SESSION, '--issue-number', String(ISSUE),
      '--db-path', dbPath);
    expect(r.stdout).toContain('dispute reopen');
    expect(r.stdout).not.toContain('--sessions-path');
  });

  test('reports a task with no protocol block without inventing state', async () => {
    await seed(undefined, { status: 'queued' });
    const r = run('dispute', 'status', '--session-id', SESSION, '--issue-number', String(ISSUE),
      '--db-path', dbPath);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('No review-dispute state');
    const payload = parse(
      run('dispute', 'status', '--session-id', SESSION, '--issue-number', String(ISSUE),
        '--db-path', dbPath, '--json'),
    );
    expect(payload.dispute).toBeNull();
  });

  test('rejects an unknown option instead of silently ignoring it', () => {
    const r = run('dispute', 'status', '--session-id', SESSION, '--issue-number', String(ISSUE), '--lineage');
    expect(r.code).not.toBe(0);
    expect(r.stderr + r.stdout).toContain('--lineage');
  });

  test('rejects an unknown dispute action', () => {
    const r = run('dispute', 'resolve', '--session-id', SESSION);
    expect(r.code).not.toBe(0);
    expect(r.stderr + r.stdout).toContain('Unknown dispute action');
  });
});

// ---------------------------------------------------------------------------
// Next action — authorized vs. fail-closed
// ---------------------------------------------------------------------------

describe('supported next action', () => {
  test('an escalated lineage states that no automated action is authorized', async () => {
    const ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A) });
    await seed(applied(ctx, [record(LINEAGE_A, 'blocked')]));

    const payload = parse(
      run('dispute', 'status', '--session-id', SESSION, '--issue-number', String(ISSUE),
        '--db-path', dbPath, '--json'),
    );
    expect(payload.dispute.nextAction.authorized).toBe(false);
    expect(payload.dispute.nextAction.reason).toBe('lineage_escalated_human');
    expect(payload.dispute.nextAction.description).toContain('escalated_human');
    // The gap is stated, not papered over with a command that would loop.
    expect(payload.dispute.nextAction.description).toContain('no transition');
  });

  test('an undispatched §7.1 turn reports the exact stop reason', async () => {
    const ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A) });
    await seed(applied(ctx, [record(LINEAGE_A, 'disputed')]), { undispatchedTurn: 'reviewer' });

    const payload = parse(
      run('dispute', 'status', '--session-id', SESSION, '--issue-number', String(ISSUE),
        '--db-path', dbPath, '--json'),
    );
    expect(payload.dispute.routing.undispatchedTurn).toBe('reviewer');
    expect(payload.dispute.nextAction.authorized).toBe(false);
    expect(payload.dispute.nextAction.reason).toBe('undispatched_turn');
    expect(payload.dispute.nextAction.description).toContain('reviewer');
    expect(payload.dispute.nextAction.description).toContain('Do not requeue it into review');
  });

  test('a review-loop cap handoff routes to the existing cap-reset command', async () => {
    const ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A) });
    await seed(applied(ctx, [record(LINEAGE_A, 'disputed')]), { extraContext: { reviewLoopCapReached: true } });

    const payload = parse(
      run('dispute', 'status', '--session-id', SESSION, '--issue-number', String(ISSUE),
        '--db-path', dbPath, '--json'),
    );
    expect(payload.dispute.nextAction.authorized).toBe(true);
    expect(payload.dispute.nextAction.action).toBe('recover_cap_handoff');
    expect(payload.dispute.nextAction.command).toContain('recover-cap-handoff');
  });

  test('a live task needs no operator action', async () => {
    const ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A) });
    await seed(applied(ctx, [record(LINEAGE_A, 'disputed')]), { status: 'queued' });

    const payload = parse(
      run('dispute', 'status', '--session-id', SESSION, '--issue-number', String(ISSUE),
        '--db-path', dbPath, '--json'),
    );
    expect(payload.dispute.nextAction.authorized).toBe(true);
    expect(payload.dispute.nextAction.action).toBe('await_automation');
  });

  test('a resolved lineage offers the §6.4 request and nothing broader', async () => {
    const ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A) });
    await seed(applied(ctx, [record(LINEAGE_A, 'fixed')], { diff: true }));

    const r = run('dispute', 'status', '--session-id', SESSION, '--issue-number', String(ISSUE),
      '--db-path', dbPath);
    expect(r.stdout).toContain('§6.4 reopen request available for');
    expect(r.stdout).toContain(`dispute reopen --session-id ${SESSION}`);
    expect(r.stdout).toContain(`--lineage-id ${LINEAGE_A}`);
    // No generic recovery or counter-reset command is ever suggested here.
    expect(r.stdout).not.toContain('dispute reset');
  });
});

// ---------------------------------------------------------------------------
// dispute reopen — the one guarded mutation
// ---------------------------------------------------------------------------

describe('admin dispute reopen', () => {
  async function seedResolved(opts = {}) {
    const ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A) });
    return seed(applied(ctx, [record(LINEAGE_A, 'fixed')], { diff: true }), opts);
  }

  const args = (...extra) => [
    'dispute', 'reopen',
    '--session-id', SESSION,
    '--issue-number', String(ISSUE),
    '--lineage-id', LINEAGE_A,
    '--version', '1',
    '--db-path', dbPath,
    '--sessions-path', sessionsPath,
    ...extra,
  ];

  test('previews by default and writes nothing', async () => {
    await seedResolved();
    const r = run(...args());
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Preview');
    expect(r.stdout).toContain('Run with --yes to apply');

    const task = await readTask();
    expect(task.context[REVIEW_DISPUTE_CONTEXT_KEY].lineages[LINEAGE_A].reopenRequested).toBeUndefined();
    expect(task.status).toBe('ready_for_human');
    expect((await readEvents()).filter((e) => e.type === 'review.dispute.operator')).toHaveLength(0);
  });

  test('--yes records the flag, parks the task, and preserves the terminal state', async () => {
    await seedResolved();
    const r = run(...args('--yes'));
    expect(r.code).toBe(0);

    const task = await readTask();
    const stored = task.context[REVIEW_DISPUTE_CONTEXT_KEY].lineages[LINEAGE_A];
    expect(stored.reopenRequested).toBe(true);
    // §6.4: flagged, not overturned — the terminal state and every counter are
    // exactly what they were.
    expect(stored.state).toBe('resolved_fixed');
    expect(stored.outcome).toBe('resolved_fixed');
    expect(stored.version).toBe(1);
    expect(stored.counters).toEqual(ZERO_LINEAGE_COUNTERS);
    expect(task.status).toBe('ready_for_human');

    const events = await readEvents();
    expect(events.filter((e) => e.type === 'review.dispute.operator')).toHaveLength(1);
    expect(events.find((e) => e.type === 'review.dispute.operator').data).toMatchObject({
      action: 'reopen_request',
      lineageId: LINEAGE_A,
      version: 1,
    });
    // The §10.3 transition event is still emitted: an operator transition is a
    // protocol transition and leaves the same audit record.
    const transitions = events.filter((e) => e.type === REVIEW_DISPUTE_TRANSITION_EVENT);
    expect(transitions[transitions.length - 1].data.applied[0].auditEvent).toBe('dispute.reopen.requested');
  });

  test('a stale version is refused rather than applied to the current one', async () => {
    await seedResolved();
    const r = run(
      'dispute', 'reopen', '--session-id', SESSION, '--issue-number', String(ISSUE),
      '--lineage-id', LINEAGE_A, '--version', '2',
      '--db-path', dbPath, '--sessions-path', sessionsPath, '--yes',
    );
    expect(r.code).not.toBe(0);
    expect(r.stdout + r.stderr).toContain('is at version 1, not 2');
    const task = await readTask();
    expect(task.context[REVIEW_DISPUTE_CONTEXT_KEY].lineages[LINEAGE_A].reopenRequested).toBeUndefined();
  });

  test('a non-terminal lineage is refused', async () => {
    const ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A) });
    await seed(applied(ctx, [record(LINEAGE_A, 'disputed')]));
    const r = run(...args('--yes'));
    expect(r.code).not.toBe(0);
    expect(r.stdout + r.stderr).toContain('applies only to a terminal lineage');
  });

  test('an escalated lineage is refused even though its state is terminal', async () => {
    // `escalated_human` passes the terminal gate but is not a RESOLUTION: §6.4
    // asks for a resolution to be revisited, and this lineage is already with a
    // human. Recording the flag would re-escalate it and leave an audit event
    // claiming a decision was requested.
    const ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A) });
    await seed(applied(ctx, [record(LINEAGE_A, 'blocked')]));

    const r = run(...args('--yes'));
    expect(r.code).not.toBe(0);
    expect(r.stdout + r.stderr).toContain('already with a human');
    // Nothing written: no flag, no operator event.
    const task = await readTask();
    expect(task.context[REVIEW_DISPUTE_CONTEXT_KEY].lineages[LINEAGE_A].reopenRequested).toBeUndefined();
    expect(task.context[REVIEW_DISPUTE_CONTEXT_KEY].lineages[LINEAGE_A].state).toBe('escalated_human');
    expect((await readEvents()).filter((e) => e.type === 'review.dispute.operator')).toHaveLength(0);

    // The status projection says the same thing, so the command and the surface
    // that advertises it cannot disagree.
    const summary = summarizeDisputeStatus(task, await readEvents());
    expect(summary.reopenEligibleLineageIds).toHaveLength(0);
    expect(summary.nextAction.authorized).toBe(false);
  });

  test('an unknown lineage is refused', async () => {
    await seedResolved();
    const r = run(
      'dispute', 'reopen', '--session-id', SESSION, '--issue-number', String(ISSUE),
      '--lineage-id', LINEAGE_B, '--version', '1',
      '--db-path', dbPath, '--sessions-path', sessionsPath, '--yes',
    );
    expect(r.code).not.toBe(0);
    expect(r.stdout + r.stderr).toContain('no lineage');
  });

  test('a claimed/running task is refused before any write', async () => {
    await seedResolved({ status: 'running' });
    const r = run(...args('--yes'));
    expect(r.code).not.toBe(0);
    expect(r.stdout + r.stderr).toContain('running');
    const task = await readTask();
    expect(task.context[REVIEW_DISPUTE_CONTEXT_KEY].lineages[LINEAGE_A].reopenRequested).toBeUndefined();
  });

  test('a session with the protocol disabled is refused even when the task carries a valid block', async () => {
    // The block is real — it was written while the protocol was enabled — but
    // the session has since been switched to the legacy flow, which ignores
    // structured dispute state entirely. Writing here would park the task at
    // `ready_for_human` and record a §6.4 request nothing in this session can
    // act on, and §11 would not publish it either.
    await seedResolved();
    writeSessions({ enabled: false });

    const r = run(...args('--yes'));
    expect(r.code).not.toBe(0);
    expect(r.stdout + r.stderr).toContain('reviewDispute.enabled: false');

    const task = await readTask();
    expect(task.context[REVIEW_DISPUTE_CONTEXT_KEY].lineages[LINEAGE_A].reopenRequested).toBeUndefined();
    expect(task.status).toBe('ready_for_human');
    expect((await readEvents()).filter((e) => e.type === 'review.dispute.operator')).toHaveLength(0);

    const payload = parse(run(...args('--yes', '--json')));
    expect(payload.ok).toBe(false);
    expect(payload.reason).toBe('protocol_disabled');
  });

  test('a task with no protocol block is refused, not silently created', async () => {
    await seed(undefined);
    const r = run(...args('--yes'));
    expect(r.code).not.toBe(0);
    expect(r.stdout + r.stderr).toContain('no reviewDispute block');
    expect((await readTask()).context[REVIEW_DISPUTE_CONTEXT_KEY]).toBeUndefined();
  });

  test('re-running after a successful request is an informative no-op', async () => {
    await seedResolved();
    expect(run(...args('--yes')).code).toBe(0);
    const second = run(...args('--yes'));
    expect(second.code).toBe(0);
    expect(second.stdout).toContain('already recorded');
    // Exactly one operator event: the second run wrote nothing.
    expect((await readEvents()).filter((e) => e.type === 'review.dispute.operator')).toHaveLength(1);
  });

  // The guard the CLI hands `commitDisputeTransition` is exactly this shape. Two
  // operators racing on a `ready_for_human` task both leave status and phase
  // alone and can land in the same millisecond, so `updatedAt` cannot separate
  // them — `revision` can. Asserted at the seam the CLI commits through, because
  // a real read/write interleave is not reachable from a spawned subprocess.
  test('the commit guard rejects a stale writer whose status, phase, and updatedAt all still match', async () => {
    const before = await seedResolved();
    const runId = `admin-dispute-reopen-${LINEAGE_A}-v1`;
    const application = applyDisputeTransition({
      context: before.context[REVIEW_DISPUTE_CONTEXT_KEY],
      decision: { kind: 'reopen_request', lineageId: LINEAGE_A },
      run: { runId, actor: 'runner' },
      limits: REVIEW_DISPUTE_DEFAULT_LIMITS,
    });
    expect(application.ok).toBe(true);

    const store = new SqliteTaskStore(dbPath);
    try {
      // The competing write: no status or phase change, and the same timestamp
      // reused — the exact collision `revision` exists for.
      const raced = await store.transitionTask(
        KEY,
        { status: before.status },
        { status: before.status, now: before.updatedAt },
      );
      expect(raced.ok).toBe(true);
      expect(raced.value.updatedAt).toBe(before.updatedAt);
      expect(raced.value.revision).toBeGreaterThan(before.revision);

      const guarded = await commitDisputeTransition({
        store,
        key: KEY,
        expected: {
          status: before.status,
          phase: before.phase,
          updatedAt: before.updatedAt,
          revision: before.revision,
        },
        application: application.value,
        runId,
        now: NOW,
        effects: [],
      });
      expect(guarded.status).toBe('claim_lost');
      const unwritten = await store.getTask(KEY);
      expect(unwritten.context[REVIEW_DISPUTE_CONTEXT_KEY].lineages[LINEAGE_A].reopenRequested).toBeUndefined();

      // Drop `revision` and the same stale writer sails through, overwriting
      // newer state — which is why the CLI includes it.
      const unguarded = await commitDisputeTransition({
        store,
        key: KEY,
        expected: { status: before.status, phase: before.phase, updatedAt: before.updatedAt },
        application: application.value,
        runId,
        now: NOW,
        effects: [],
      });
      expect(unguarded.status).toBe('applied');
    } finally {
      store.close();
    }
  });

  test('rejects a malformed lineage id rather than interpolating it', () => {
    const r = run(
      'dispute', 'reopen', '--session-id', SESSION, '--issue-number', String(ISSUE),
      '--lineage-id', '../../etc/passwd', '--version', '1',
      '--db-path', dbPath, '--sessions-path', sessionsPath, '--yes',
    );
    expect(r.code).not.toBe(0);
    expect(r.stdout + r.stderr).toContain('runner-minted lineage id');
  });

  test('requires --lineage-id and --version', () => {
    const missingLineage = run('dispute', 'reopen', '--session-id', SESSION, '--issue-number', String(ISSUE));
    expect(missingLineage.code).not.toBe(0);
    expect(missingLineage.stdout + missingLineage.stderr).toContain('--lineage-id is required');

    const missingVersion = run('dispute', 'reopen', '--session-id', SESSION, '--issue-number', String(ISSUE),
      '--lineage-id', LINEAGE_A);
    expect(missingVersion.code).not.toBe(0);
    expect(missingVersion.stdout + missingVersion.stderr).toContain('--version is required');
  });

  test('rejects a misspelled flag instead of treating it as a preview', () => {
    const r = run(...args('--ye'));
    expect(r.code).not.toBe(0);
    expect(r.stdout + r.stderr).toContain('--ye');
  });
});

// ---------------------------------------------------------------------------
// task-status extension and UI parity
// ---------------------------------------------------------------------------

describe('task-status — dispute extension', () => {
  test('human output carries the lineage state, counters, and next action', async () => {
    const ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A) });
    await seed(applied(ctx, [record(LINEAGE_A, 'blocked')]));

    const r = run('task-status', '--session-id', SESSION, '--issue-number', String(ISSUE), '--db-path', dbPath);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('review dispute: 1 lineage(s)');
    expect(r.stdout).toContain(LINEAGE_A);
    expect(r.stdout).toContain('escalated_human');
    expect(r.stdout).toContain('next action: none (lineage_escalated_human)');
  });

  test('--json exposes reviewDispute alongside the existing stable fields', async () => {
    const ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A) });
    await seed(applied(ctx, [record(LINEAGE_A, 'blocked')]));

    const payload = parse(
      run('task-status', '--session-id', SESSION, '--issue-number', String(ISSUE), '--db-path', dbPath, '--json'),
    );
    const t = payload.tasks[0];
    // The pre-existing fields are untouched.
    expect(t.issueNumber).toBe(ISSUE);
    expect(t.status).toBe('ready_for_human');
    expect(t.phase).toBe('review');
    expect(t.reviewDispute.lineages[0].state).toBe('escalated_human');
    expect(t.reviewDispute.nextAction.reason).toBe('lineage_escalated_human');
  });

  test('a legacy task keeps its existing output and reports a null block', async () => {
    await seed(undefined, { status: 'queued' });

    const human = run('task-status', '--session-id', SESSION, '--issue-number', String(ISSUE), '--db-path', dbPath);
    expect(human.code).toBe(0);
    expect(human.stdout).not.toContain('review dispute');
    expect(human.stdout).not.toContain('next action');

    const payload = parse(
      run('task-status', '--session-id', SESSION, '--issue-number', String(ISSUE), '--db-path', dbPath, '--json'),
    );
    expect(payload.tasks[0].reviewDispute).toBeNull();
  });
});

describe('admin UI — dispute parity', () => {
  test('task detail renders the same lineage state and counters the CLI does', async () => {
    const ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A) });
    const task = await seed(applied(ctx, [record(LINEAGE_A, 'blocked')]));
    const events = await readEvents();

    const detail = formatTaskDetail(task, NOW, undefined, events);
    const summary = summarizeDisputeStatus(task, events);

    expect(detail).toContain(LINEAGE_A);
    expect(detail).toContain('escalated_human');
    expect(detail).toContain(BOUNDARY);
    expect(detail).toContain('reb=0 recon=0 arb=0 malformedArb=0 evidence=0');
    // Same projection, so the UI's "next action" is the CLI's by construction.
    expect(detail).toContain(`next action: none (${summary.nextAction.reason})`);
    // And never the content the protocol keeps out of every surface.
    expect(detail).not.toContain(ARGUMENT);
  });

  test('the commands the UI prints carry the registry and store it was started with', () => {
    // The UI is interactive and local, so it passes the real paths rather than
    // the CLI's placeholders — but the flags are present either way, which is
    // what keeps a copied command on the same session the operator selected.
    const task = { sessionId: SESSION, issueNumber: ISSUE };
    expect(buildDisputeStatusArgv(task, '/tmp/x.db', '/tmp/sessions.json')).toEqual([
      'dispute', 'status', '--session-id', SESSION, '--issue-number', String(ISSUE),
      '--db-path', '/tmp/x.db', '--sessions-path', '/tmp/sessions.json',
    ]);
    expect(
      disputeReopenArgv({
        sessionId: SESSION,
        issueNumber: ISSUE,
        lineageId: LINEAGE_A,
        version: 3,
        dbPath: '/tmp/x.db',
        sessionsPath: '/tmp/sessions.json',
      }),
    ).toEqual([
      'dispute', 'reopen', '--session-id', SESSION, '--issue-number', String(ISSUE),
      '--lineage-id', LINEAGE_A, '--version', '3',
      '--db-path', '/tmp/x.db', '--sessions-path', '/tmp/sessions.json',
    ]);
    // A UI on the default registry emits neither flag.
    expect(
      disputeReopenArgv({ sessionId: SESSION, issueNumber: ISSUE, lineageId: LINEAGE_A, version: 3 }),
    ).not.toContain('--sessions-path');
  });

  test('the dispute action appears only for a task carrying protocol state', async () => {
    const ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A) });
    const withState = await seed(applied(ctx, [record(LINEAGE_A, 'blocked')]));
    expect(buildTaskMenuActions(withState, NOW).map((a) => a.action)).toContain('dispute');

    rmSync(dbPath, { force: true });
    const legacy = await seed(undefined, { status: 'queued' });
    expect(buildTaskMenuActions(legacy, NOW).map((a) => a.action)).not.toContain('dispute');
    // A legacy task's detail view is unchanged.
    expect(formatTaskDetail(legacy, NOW)).not.toContain('Dispute:');
  });
});
