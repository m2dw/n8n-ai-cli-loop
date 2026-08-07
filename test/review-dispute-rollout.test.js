/**
 * Rollout and rollback of the review-dispute protocol (issue #849;
 * docs/review-dispute-operations.md, docs/review-dispute-contract.md §13).
 *
 * The protocol ships default-off, and the only supported way to turn it off
 * again is the same flag that turned it on. There is no second switch, no
 * migration, and no cleanup step — which is only safe if three things hold, and
 * this file exists to hold them:
 *
 *  1. **Default-off is genuinely legacy.** An omitted `reviewDispute`, and an
 *     explicit `enabled: false`, resolve to exactly the same disabled settings,
 *     and a run under one publishes nothing and records nothing.
 *  2. **Disabling preserves the audit trail.** A task that already carries a
 *     §10.1 block keeps it byte-for-byte across a disabled run, keeps its legacy
 *     `reviewFeedback` alongside it, and keeps every §10.3 event it accumulated.
 *     Nothing is deleted, rewritten, or migrated.
 *  3. **Re-enabling finds the same history.** A terminal lineage is an immutable
 *     audit record (§6.4), so a disable/re-enable round trip must leave it
 *     identical — including its outcome literal and every counter.
 *
 * And the fourth, which is a limitation rather than a guarantee: an in-flight
 * task is recovered through supported admin commands, and `admin dispute
 * reopen` is NOT one of them while the protocol is off.
 */
import { jest } from '@jest/globals';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SqliteTaskStore } from '../dist/index.js';
import { SqliteOutboxStore } from '../dist/stores/sqlite-outbox-store.js';
import { runNextPhase } from '../dist/core/phase-runner.js';
import {
  REVIEW_DISPUTE_DEFAULT_LIMITS,
  ZERO_LINEAGE_COUNTERS,
  resolveReviewDisputeSettings,
} from '../dist/core/review-dispute.js';
import { parseFixDispositionResponse } from '../dist/core/review-fix-disposition-response.js';
import { persistFixDisputes } from '../dist/core/review-dispute-persistence.js';
import { applyDisputeTransition } from '../dist/core/review-dispute-transition.js';
import {
  REVIEW_DISPUTE_CONTEXT_KEY,
  REVIEW_DISPUTE_TRANSITION_EVENT,
} from '../dist/core/review-dispute-commit.js';
import { summarizeDisputeStatus } from '../dist/core/review-dispute-status.js';

jest.setTimeout(30_000);

const CLI = new URL('../dist/cli/admin.js', import.meta.url).pathname;
const SESSION = 'rollout-session';
const ISSUE = 849;
const KEY = { sessionId: SESSION, issueNumber: ISSUE };
const LINEAGE_A = 'ln-aaaaaaaaaaaa';
const BOUNDARY = 'src/auth/handler.ts';
const ARGUMENT = 'The null session is already rejected by the middleware, so the cited crash cannot occur.';
const LEGACY_FEEDBACK = 'Legacy prose from before the protocol was ever enabled.';
const NOW = '2026-08-06T12:00:00.000Z';
const PR_URL = 'https://github.com/org/repo/pull/42';

let tmpDir;
let dbPath;
let sessionsPath;
let store;
let outboxStore;

const BASE_SESSION = {
  sessionId: SESSION,
  repoKey: 'test-repo',
  repoRoot: '/tmp/test-repo',
  githubRepo: 'org/repo',
  artifactDir: '.artifacts',
  artifactRoot: '/tmp/test-repo/.artifacts',
  githubOwner: 'org',
  githubName: 'repo',
  defaults: { implementationAgent: 'claude', reviewAgent: 'codex' },
  verification: {},
  labels: { active: 'ai:active', blocked: 'ai:blocked', readyForHuman: 'ai:ready-for-human' },
  workItemProvider: { provider: 'github-issues', auth: { mode: 'gh' } },
  repoHostProvider: { provider: 'github', auth: { mode: 'gh' } },
};

function writeSessions(reviewDispute) {
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
          ...(reviewDispute === undefined ? {} : { reviewDispute }),
        },
      ],
    }),
  );
}

function cli(...args) {
  try {
    return { code: 0, stdout: execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8' }), stderr: '' };
  } catch (err) {
    return { code: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

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

function application(ctx, records, { diff = false, runId = 'run-impl-1' } = {}) {
  const outcome = parseFixDispositionResponse({
    response: `\`\`\`json\n${JSON.stringify(records)}\n\`\`\``,
    findings: Object.values(ctx.lineages).map((l) => ({
      lineageId: l.lineageId,
      version: l.version,
      state: l.state,
      severity: l.severity,
      affectedBoundary: l.affectedBoundary,
      allowedDispositions: ['fixed', 'review_disputed', 'blocked'],
    })),
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
    limits: REVIEW_DISPUTE_DEFAULT_LIMITS,
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

async function enqueue(extraContext = {}) {
  await store.enqueueTask({
    sessionId: SESSION,
    issueNumber: ISSUE,
    phase: 'implementation',
    priority: 'normal',
    context: { reviewFeedback: LEGACY_FEEDBACK, ...extraContext },
    now: '2026-08-06T11:00:00.000Z',
  });
}

async function runPhase({ session, value, runId = 'run-impl-1', phase = 'implementation' }) {
  return runNextPhase({
    store,
    request: { sessionId: SESSION, workerId: 'w', runId, supportedPhases: [phase], now: NOW },
    handlers: {
      [phase]: async () => ({
        result: 'success',
        context: { branch: 'ai/issue-849', prUrl: PR_URL },
        ...(value ? { disputeTransition: value } : {}),
      }),
    },
    outboxStore,
    session,
    now: NOW,
  });
}

async function disputeComments() {
  const pending = await outboxStore.listPending();
  return pending.filter((e) => String(e.payload?.body ?? '').includes('Review dispute outcome'));
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'dispute-rollout-'));
  dbPath = join(tmpDir, 'test.db');
  sessionsPath = join(tmpDir, 'sessions.json');
  store = new SqliteTaskStore(dbPath);
  outboxStore = new SqliteOutboxStore(dbPath);
  writeSessions({ enabled: true });
});

afterEach(() => {
  outboxStore.close();
  store.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe('default-off is the legacy behavior', () => {
  test('an omitted flag and an explicit false resolve identically', () => {
    const omitted = resolveReviewDisputeSettings(undefined);
    const explicit = resolveReviewDisputeSettings({ enabled: false });
    expect(omitted.ok).toBe(true);
    expect(explicit.ok).toBe(true);
    expect(omitted.settings.enabled).toBe(false);
    expect(omitted.settings).toEqual(explicit.settings);
    // The limits an operator would read are the §6.1 defaults either way — the
    // flag gates the behavior, it does not change the contract's constants.
    expect(omitted.settings.limits).toEqual(REVIEW_DISPUTE_DEFAULT_LIMITS);
  });

  test('a brand-new task under a disabled session never grows a protocol block', async () => {
    await enqueue();
    const outcome = await runPhase({ session: { ...BASE_SESSION, reviewDispute: { enabled: false } } });
    expect(outcome.status).toBe('completed');

    const task = await store.getTask(KEY);
    expect(task.context[REVIEW_DISPUTE_CONTEXT_KEY]).toBeUndefined();
    expect(task.context.reviewFeedback).toBe(LEGACY_FEEDBACK);
    expect(task.phase).toBe('review');
    const events = await store.listEvents(KEY);
    expect(events.filter((e) => e.type === REVIEW_DISPUTE_TRANSITION_EVENT)).toHaveLength(0);
    expect(await disputeComments()).toHaveLength(0);
  });

  test('a session that omits the key behaves exactly like one that sets false', async () => {
    await enqueue();
    await runPhase({ session: BASE_SESSION });
    const task = await store.getTask(KEY);
    expect(task.context[REVIEW_DISPUTE_CONTEXT_KEY]).toBeUndefined();
    expect(await disputeComments()).toHaveLength(0);
  });
});

describe('disabling preserves the audit trail', () => {
  /** A task carrying a real, terminal §10.1 block plus its §10.3 event. */
  async function seedTerminal() {
    const ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A) });
    await enqueue({ [REVIEW_DISPUTE_CONTEXT_KEY]: ctx });
    await runPhase({
      session: { ...BASE_SESSION, reviewDispute: { enabled: true } },
      value: application(ctx, [record(LINEAGE_A, 'fixed')], { diff: true }),
    });
    return store.getTask(KEY);
  }

  test('a persisted block, its legacy prose, and its events all survive a disabled run', async () => {
    const before = await seedTerminal();
    expect(before.context[REVIEW_DISPUTE_CONTEXT_KEY].lineages[LINEAGE_A].state).toBe('resolved_fixed');
    const beforeEvents = await store.listEvents(KEY);
    const beforeComments = await disputeComments();
    expect(beforeComments).toHaveLength(1);

    // The operator turns the protocol off. The task is queued at `review`; the
    // next run is an ordinary legacy one, with no application to fold.
    await runPhase({
      session: { ...BASE_SESSION, reviewDispute: { enabled: false } },
      runId: 'run-review-2',
      phase: 'review',
    });

    const after = await store.getTask(KEY);
    // Byte-for-byte: not migrated, not summarized, not deleted.
    expect(after.context[REVIEW_DISPUTE_CONTEXT_KEY]).toEqual(before.context[REVIEW_DISPUTE_CONTEXT_KEY]);
    expect(after.context.reviewFeedback).toBe(LEGACY_FEEDBACK);
    const afterEvents = await store.listEvents(KEY);
    expect(afterEvents.filter((e) => e.type === REVIEW_DISPUTE_TRANSITION_EVENT))
      .toEqual(beforeEvents.filter((e) => e.type === REVIEW_DISPUTE_TRANSITION_EVENT));
    // …and the disabled run adds no second public comment for old history.
    expect(await disputeComments()).toHaveLength(1);
  });

  test('a terminal lineage is identical across a disable / re-enable round trip', async () => {
    const before = await seedTerminal();
    const snapshot = JSON.stringify(before.context[REVIEW_DISPUTE_CONTEXT_KEY]);

    await runPhase({
      session: { ...BASE_SESSION, reviewDispute: { enabled: false } },
      runId: 'run-review-2',
      phase: 'review',
    });
    // Re-enabled. There is no migration step and nothing to replay.
    writeSessions({ enabled: true });
    const after = await store.getTask(KEY);
    expect(JSON.stringify(after.context[REVIEW_DISPUTE_CONTEXT_KEY])).toBe(snapshot);

    const status = JSON.parse(
      cli('dispute', 'status', '--session-id', SESSION, '--issue-number', String(ISSUE),
        '--db-path', dbPath, '--sessions-path', sessionsPath, '--json').stdout.trim(),
    );
    expect(status.dispute.lineages[0]).toMatchObject({
      lineageId: LINEAGE_A,
      state: 'resolved_fixed',
      outcome: 'resolved_fixed',
      terminal: true,
    });
  });

  test('`dispute status` still reads a disabled session\'s history — it is inert, not hidden', async () => {
    await seedTerminal();
    writeSessions({ enabled: false });
    const r = cli('dispute', 'status', '--session-id', SESSION, '--issue-number', String(ISSUE),
      '--db-path', dbPath, '--sessions-path', sessionsPath, '--json');
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout.trim()).dispute.lineages[0].state).toBe('resolved_fixed');
  });

  test('`dispute metrics` still reports a disabled session\'s recorded history', async () => {
    await seedTerminal();
    writeSessions({ enabled: false });
    const m = JSON.parse(
      cli('dispute', 'metrics', '--session-id', SESSION, '--db-path', dbPath,
        '--sessions-path', sessionsPath, '--json').stdout.trim(),
    ).metrics;
    expect(m.terminalOutcomes.resolved_fixed).toBe(1);
    expect(m.transitionEvents).toBe(1);
  });
});

describe('rollback distinguishes disablement from recovery', () => {
  test('`dispute reopen` refuses outright while the protocol is off, and points at `admin recover`', async () => {
    const ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A) });
    await enqueue({ [REVIEW_DISPUTE_CONTEXT_KEY]: ctx });
    await runPhase({
      session: { ...BASE_SESSION, reviewDispute: { enabled: true } },
      value: application(ctx, [record(LINEAGE_A, 'fixed')], { diff: true }),
    });
    const before = await store.getTask(KEY);

    writeSessions({ enabled: false });
    const r = cli('dispute', 'reopen', '--session-id', SESSION, '--issue-number', String(ISSUE),
      '--lineage-id', LINEAGE_A, '--version', '1', '--yes',
      '--db-path', dbPath, '--sessions-path', sessionsPath, '--json');
    expect(r.code).not.toBe(0);
    const payload = JSON.parse(r.stdout.trim());
    expect(payload.reason).toBe('protocol_disabled');
    expect(payload.detail).toContain('admin recover');
    // Refused BEFORE the store was opened: nothing moved.
    const after = await store.getTask(KEY);
    expect(after.revision).toBe(before.revision);
    expect(after.context[REVIEW_DISPUTE_CONTEXT_KEY]).toEqual(before.context[REVIEW_DISPUTE_CONTEXT_KEY]);
  });

  test('an in-flight task parked by the protocol is recovered with the ordinary handoff command', async () => {
    const ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A) });
    await enqueue({ [REVIEW_DISPUTE_CONTEXT_KEY]: ctx });
    await runPhase({
      session: { ...BASE_SESSION, reviewDispute: { enabled: true } },
      value: application(ctx, [record(LINEAGE_A, 'review_disputed')]),
    });
    const parked = await store.getTask(KEY);
    expect(parked.status).toBe('ready_for_human');
    // The stop reason an operator reads before deciding anything.
    const summary = summarizeDisputeStatus(parked, await store.listEvents(KEY));
    expect(summary.nextAction.authorized).toBe(false);
    expect(summary.nextAction.reason).toBe('undispatched_turn');

    // The protocol is turned off mid-flight; the task is recovered as an
    // ordinary human handoff, which is a task action and not a protocol one.
    writeSessions({ enabled: false });
    const r = cli('recover', '--session-id', SESSION, '--issue-number', String(ISSUE),
      '--from', 'ready_for_human', '--phase', 'implementation',
      '--db-path', dbPath, '--sessions-path', sessionsPath, '--json');
    expect(r.code).toBe(0);

    const recovered = await store.getTask(KEY);
    expect(recovered.status).toBe('queued');
    expect(recovered.phase).toBe('implementation');
    // Recovery is a task transition, never an edit of the audit block: the
    // `disputed` lineage is still on file exactly as the protocol left it.
    expect(recovered.context[REVIEW_DISPUTE_CONTEXT_KEY]).toEqual(parked.context[REVIEW_DISPUTE_CONTEXT_KEY]);
    expect(recovered.context[REVIEW_DISPUTE_CONTEXT_KEY].lineages[LINEAGE_A].state).toBe('disputed');
  });

  test('a disabled session runs the recovered task on the legacy path, block untouched', async () => {
    const ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A) });
    await enqueue({ [REVIEW_DISPUTE_CONTEXT_KEY]: ctx });
    await runPhase({
      session: { ...BASE_SESSION, reviewDispute: { enabled: true } },
      value: application(ctx, [record(LINEAGE_A, 'review_disputed')]),
    });
    const parked = await store.getTask(KEY);
    const recovered = await store.recoverHandoff(KEY, {
      fromStatus: 'ready_for_human',
      phase: 'implementation',
      now: NOW,
    });
    expect(recovered.ok).toBe(true);

    // A legacy run: no application, protocol disabled.
    const outcome = await runPhase({
      session: { ...BASE_SESSION, reviewDispute: { enabled: false } },
      runId: 'run-impl-2',
    });
    expect(outcome.status).toBe('completed');

    const after = await store.getTask(KEY);
    expect(after.context[REVIEW_DISPUTE_CONTEXT_KEY]).toEqual(parked.context[REVIEW_DISPUTE_CONTEXT_KEY]);
    expect(after.context.reviewFeedback).toBe(LEGACY_FEEDBACK);
    expect(after.phase).toBe('review');
    expect(await disputeComments()).toHaveLength(0);
  });
});
