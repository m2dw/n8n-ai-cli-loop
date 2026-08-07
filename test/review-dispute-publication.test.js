/**
 * Issue #848: the §11 public-comment policy, and the transactional guarantee
 * that carries it (docs/review-dispute-contract.md §9, §11).
 *
 * Three layers, pinned in order:
 *
 *  1. WHAT §11 allows — a pure projection over the typed #840 application. No
 *     store, no session, no I/O.
 *  2. That an authorized comment commits with the transition or not at all —
 *     driven against BOTH TaskStore implementations, because atomicity is
 *     observable contract rather than an implementation detail.
 *  3. That the production path (a real `runNextPhase` completion) routes it
 *     PR-first, falls back to the work item, and stays silent for everything
 *     §11 does not authorize.
 *
 * Every application under test is built by the REAL pipeline — the #843 parser,
 * the #844 writer, the #840 applicator — so no test here can assert a public
 * comment for a lineage state the protocol could not actually produce.
 */
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { MemoryTaskStore, SqliteTaskStore } from '../dist/index.js';
import { SqliteOutboxStore } from '../dist/stores/sqlite-outbox-store.js';
import { runNextPhase } from '../dist/core/phase-runner.js';
import { REVIEW_DISPUTE_DEFAULT_LIMITS, ZERO_LINEAGE_COUNTERS } from '../dist/core/review-dispute.js';
import { parseFixDispositionResponse } from '../dist/core/review-fix-disposition-response.js';
import { persistFixDisputes } from '../dist/core/review-dispute-persistence.js';
import { applyDisputeTransition } from '../dist/core/review-dispute-transition.js';
import {
  REVIEW_DISPUTE_CONTEXT_KEY,
  commitDisputeTransition,
} from '../dist/core/review-dispute-commit.js';
import {
  currentPrNumber,
  disputeOutcomeIdempotencyKey,
  disputePublicationTarget,
  publishableDisputeOutcomes,
  renderDisputeOutcomeComment,
} from '../dist/core/review-dispute-publication.js';

const SESSION_ID = 'pub-session';
const ISSUE = 848;
const KEY = { sessionId: SESSION_ID, issueNumber: ISSUE };
const LINEAGE_A = 'ln-aaaaaaaaaaaa';
const LINEAGE_B = 'ln-bbbbbbbbbbbb';
const BOUNDARY_A = 'src/auth/handler.ts';
const BOUNDARY_B = 'src/core/session.ts';
const ARGUMENT =
  'The null session is already rejected by the middleware, so the cited crash cannot occur.';
const RUN_ID = 'run-impl-1';
const NOW = '2026-08-06T12:00:00.000Z';

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
    affectedBoundary: BOUNDARY_A,
    ...rest,
  };
}

function context(lineages) {
  return { version: 1, reviewStructure: 'structured', lineages };
}

function fixedRecord(id) {
  return { lineageId: id, version: 1, disposition: 'fixed', note: 'Added the null guard.' };
}

function blockedRecord(id) {
  return {
    lineageId: id,
    version: 1,
    disposition: 'blocked',
    note: 'Needs a credential automation cannot supply.',
  };
}

function disputeRecord(id, version = 1) {
  return {
    lineageId: id,
    version,
    disposition: 'review_disputed',
    dispute: {
      challenged: { lineageId: id, version },
      rebuttalReason: 'false_premise',
      argument: ARGUMENT,
      evidenceRefs: [{ kind: 'file', path: BOUNDARY_A, startLine: 30, endLine: 36 }],
      whyNoChange: 'A second guard would duplicate the existing one without changing behavior.',
    },
  };
}

function promptFindings(ctx) {
  return Object.values(ctx.lineages)
    .filter((l) => l.state === 'open' || l.state === 'binding')
    .map((l) => ({
      lineageId: l.lineageId,
      version: l.version,
      state: l.state,
      severity: l.severity,
      affectedBoundary: l.affectedBoundary,
      allowedDispositions: ['fixed', 'review_disputed', 'blocked'],
    }));
}

/** One fix run's application, built exactly as the implementation handler builds it. */
function application(ctx, records, { runId = RUN_ID, diff = false, current = ctx } = {}) {
  const outcome = parseFixDispositionResponse({
    response: `\`\`\`json\n${JSON.stringify(records)}\n\`\`\``,
    findings: promptFindings(ctx),
    lineages: ctx.lineages,
    reviewStructure: ctx.reviewStructure,
    runProducedFileChanges: diff,
    resolveEvidenceRef: () => true,
    limits: REVIEW_DISPUTE_DEFAULT_LIMITS,
  });
  const persisted = persistFixDisputes({
    context: current,
    outcome,
    run: { runId, agentId: 'claude', timestamp: NOW },
    runProducedFileChanges: diff,
  });
  if (!persisted.ok) throw new Error(`fixture not persisted: ${JSON.stringify(persisted.failure)}`);
  const result = applyDisputeTransition({
    context: current,
    decision: { kind: 'dispositions', persistence: persisted.value, outcome, runProducedFileChanges: diff },
    run: { runId, actor: 'implementer' },
  });
  if (!result.ok) throw new Error(`transition failed: ${JSON.stringify(result.failure)}`);
  return result.value;
}

function reopenApplication(ctx, lineageId, runId = 'run-operator-1') {
  const result = applyDisputeTransition({
    context: ctx,
    decision: { kind: 'reopen_request', lineageId },
    run: { runId, actor: 'runner' },
  });
  if (!result.ok) throw new Error(`transition failed: ${JSON.stringify(result.failure)}`);
  return result.value;
}

function task(overrides = {}) {
  return {
    sessionId: SESSION_ID,
    issueNumber: ISSUE,
    status: 'running',
    phase: 'implementation',
    priority: 'normal',
    attempts: {},
    context: {},
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. §11 policy — which lineages may be published at all
// ---------------------------------------------------------------------------

describe('§11 — only a terminal resolution or human escalation is published', () => {
  test('a `fixed` disposition publishes exactly the six allowed fields', () => {
    const ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A) });
    const outcomes = publishableDisputeOutcomes(application(ctx, [fixedRecord(LINEAGE_A)], { diff: true }));

    expect(outcomes).toHaveLength(1);
    // The whole value, not a subset: anything §11 does not name would show up
    // here as an extra key, and a projection that silently gained one is exactly
    // the regression this asserts against.
    expect(outcomes[0]).toEqual({
      lineageId: LINEAGE_A,
      severity: 'P1',
      affectedBoundary: BOUNDARY_A,
      outcome: 'resolved_fixed',
      versions: 1,
      arbitrationPasses: 0,
    });
  });

  test('a `blocked` disposition publishes the human escalation', () => {
    const ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A) });
    const outcomes = publishableDisputeOutcomes(application(ctx, [blockedRecord(LINEAGE_A)]));
    expect(outcomes.map((o) => o.outcome)).toEqual(['escalated_human']);
  });

  test('a humanGate finding escalates at dispute admission and is published', () => {
    const ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A, { humanGate: true }) });
    const outcomes = publishableDisputeOutcomes(application(ctx, [disputeRecord(LINEAGE_A)]));
    expect(outcomes.map((o) => o.outcome)).toEqual(['escalated_human']);
  });

  test('an admitted dispute (`disputed`) is intermediate and publishes nothing', () => {
    const ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A) });
    const value = application(ctx, [disputeRecord(LINEAGE_A)]);
    // The transition really happened — this is a silent state change, not a
    // no-op the policy is accidentally right about.
    expect(value.context.lineages[LINEAGE_A].state).toBe('disputed');
    expect(publishableDisputeOutcomes(value)).toEqual([]);
  });

  test('a replayed delivery publishes nothing, even though the lineage IS terminal', () => {
    const ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A) });
    const first = application(ctx, [fixedRecord(LINEAGE_A)], { diff: true });
    expect(publishableDisputeOutcomes(first)).toHaveLength(1);

    // The same run redelivered against the block its first delivery produced.
    const replay = application(ctx, [fixedRecord(LINEAGE_A)], { diff: true, current: first.context });
    expect(replay.replayed).toBe(true);
    expect(publishableDisputeOutcomes(replay)).toEqual([]);
  });

  test('a §6.4 reopen request does not re-announce the resolution it flags', () => {
    const ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A) });
    const resolved = application(ctx, [fixedRecord(LINEAGE_A)], { diff: true });
    const reopened = reopenApplication(resolved.context, LINEAGE_A);

    // A real applied transition with a real audit event — and still no comment,
    // because the lineage did not move and was already published when it did.
    expect(reopened.applied).toHaveLength(1);
    expect(reopened.applied[0].auditEvent).toBe('dispute.reopen.requested');
    expect(reopened.context.lineages[LINEAGE_A].reopenRequested).toBe(true);
    expect(publishableDisputeOutcomes(reopened)).toEqual([]);
  });

  test('multiple lineages publish once each, in lineage-id order', () => {
    const ctx = context({
      [LINEAGE_B]: lineage(LINEAGE_B, { affectedBoundary: BOUNDARY_B, severity: 'P2' }),
      [LINEAGE_A]: lineage(LINEAGE_A),
    });
    const outcomes = publishableDisputeOutcomes(
      application(ctx, [fixedRecord(LINEAGE_A), blockedRecord(LINEAGE_B)], { diff: true }),
    );
    expect(outcomes.map((o) => o.lineageId)).toEqual([LINEAGE_A, LINEAGE_B]);
    expect(outcomes.map((o) => o.outcome)).toEqual(['resolved_fixed', 'escalated_human']);
    expect(outcomes[1].severity).toBe('P2');
    expect(outcomes[1].affectedBoundary).toBe(BOUNDARY_B);
  });
});

// ---------------------------------------------------------------------------
// 2. §11 body — bounded fields only
// ---------------------------------------------------------------------------

describe('§11 — the rendered body carries only bounded fields', () => {
  const ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A) });
  const body = renderDisputeOutcomeComment(
    publishableDisputeOutcomes(application(ctx, [fixedRecord(LINEAGE_A)], { diff: true })),
  );

  test('states the outcome with its lineage, severity, boundary, and counts', () => {
    expect(body).toContain(LINEAGE_A);
    expect(body).toContain('P1');
    expect(body).toContain(BOUNDARY_A);
    expect(body).toContain('resolved_fixed');
    expect(body).toContain('Review dispute outcome');
  });

  test('never carries rebuttal prose, run/session identifiers, or a local path', () => {
    expect(body).not.toContain(ARGUMENT);
    expect(body).not.toContain('null guard');
    expect(body).not.toContain(RUN_ID);
    expect(body).not.toContain(SESSION_ID);
    expect(body).not.toMatch(/confidence/i);
    expect(body).not.toMatch(/\/Users\//);
    expect(body).not.toMatch(/\/tmp\//);
    // No absolute path anywhere: every line that mentions a file mentions the
    // admission-normalized repository-relative boundary and nothing else.
    expect(body).not.toMatch(/(^|[\s`(])\/[A-Za-z]/);
  });

  test('escalation and resolution are summarized separately', () => {
    const escalation = renderDisputeOutcomeComment(
      publishableDisputeOutcomes(application(context({ [LINEAGE_A]: lineage(LINEAGE_A) }), [blockedRecord(LINEAGE_A)])),
    );
    expect(escalation).toContain('escalated to a human');
    expect(body).toContain('1 resolved');
    expect(body).not.toContain('escalated to a human');
  });

  test('a boundary containing a pipe cannot break the table it renders into', () => {
    const rendered = renderDisputeOutcomeComment([
      {
        lineageId: LINEAGE_A,
        severity: 'P1',
        affectedBoundary: 'src/a|b.ts',
        outcome: 'resolved_fixed',
        versions: 1,
        arbitrationPasses: 0,
      },
    ]);
    const row = rendered.split('\n').find((l) => l.includes(LINEAGE_A));
    expect(row).toContain('src/a\\|b.ts');
    // Six columns, so seven pipes — the escaped one does not add a cell.
    expect(row.split(/(?<!\\)\|/)).toHaveLength(8);
  });
});

// ---------------------------------------------------------------------------
// 3. PR-first routing and idempotency keys
// ---------------------------------------------------------------------------

describe('§11 delivery — PR-first routing', () => {
  test('a task with a current PR routes to that PR', () => {
    const t = task({ context: { prUrl: 'https://github.com/org/repo/pull/42' } });
    expect(disputePublicationTarget(t)).toEqual({ kind: 'pr', prNumber: 42 });
  });

  test('a Gitea `/pulls/<n>` URL routes to the PR too', () => {
    const t = task({ context: { prUrl: 'https://gitea.test/org/repo/pulls/7' } });
    expect(currentPrNumber(t)).toBe(7);
  });

  test('a task with no PR falls back to the work item', () => {
    expect(disputePublicationTarget(task())).toEqual({ kind: 'work-item', issueNumber: ISSUE });
  });

  test("the completing run's own PR wins over the task's stored one", () => {
    const t = task({ context: { prUrl: 'https://github.com/org/repo/pull/1' } });
    expect(disputePublicationTarget(t, 'https://github.com/org/repo/pull/2')).toEqual({
      kind: 'pr',
      prNumber: 2,
    });
  });

  test('a non-PR URL is not mistaken for one', () => {
    expect(currentPrNumber(task({ context: { prUrl: 'https://github.com/org/repo/issues/9' } }))).toBeUndefined();
  });
});

describe('§11 delivery — idempotency keys', () => {
  const outcome = {
    lineageId: LINEAGE_A,
    severity: 'P1',
    affectedBoundary: BOUNDARY_A,
    outcome: 'resolved_fixed',
    versions: 1,
    arbitrationPasses: 0,
  };
  const base = { sessionId: SESSION_ID, issueNumber: ISSUE, surface: 'pr', outcome };

  test('is stable across runs, so a re-derived completion cannot double-post', () => {
    // Deliberately no run id anywhere in the key: a phase re-run after a lost CAS
    // re-derives the same completion under a NEW run id, and #701 relies on that
    // producing the same effects.
    expect(disputeOutcomeIdempotencyKey(base)).toBe(disputeOutcomeIdempotencyKey({ ...base }));
    expect(disputeOutcomeIdempotencyKey(base)).not.toContain(RUN_ID);
  });

  test('distinguishes task, lineage, version, outcome, and surface', () => {
    const key = disputeOutcomeIdempotencyKey(base);
    expect(disputeOutcomeIdempotencyKey({ ...base, issueNumber: 999 })).not.toBe(key);
    expect(disputeOutcomeIdempotencyKey({ ...base, surface: 'work-item' })).not.toBe(key);
    expect(
      disputeOutcomeIdempotencyKey({ ...base, outcome: { ...outcome, versions: 2 } }),
    ).not.toBe(key);
    expect(
      disputeOutcomeIdempotencyKey({ ...base, outcome: { ...outcome, outcome: 'resolved_overruled' } }),
    ).not.toBe(key);
    expect(
      disputeOutcomeIdempotencyKey({ ...base, outcome: { ...outcome, lineageId: LINEAGE_B } }),
    ).not.toBe(key);
  });
});

// ---------------------------------------------------------------------------
// 4. Atomicity — the effect commits with the transition or not at all
// ---------------------------------------------------------------------------

const BACKENDS = [
  {
    name: 'MemoryTaskStore',
    create: () => {
      const store = new MemoryTaskStore();
      return {
        store,
        effects: async () => store.listOutboxEffects(),
        cleanup: () => {},
      };
    },
  },
  {
    name: 'SqliteTaskStore',
    create: () => {
      const dir = mkdtempSync(join(tmpdir(), 'dispute-pub-'));
      const dbPath = join(dir, 'test.db');
      const store = new SqliteTaskStore(dbPath);
      const outbox = new SqliteOutboxStore(dbPath);
      return {
        store,
        effects: async () => outbox.listPending(),
        cleanup: () => {
          outbox.close();
          store.close();
          rmSync(dir, { recursive: true, force: true });
        },
      };
    },
  },
];

describe.each(BACKENDS)('commitDisputeTransition — public effect atomicity ($name)', ({ create }) => {
  let store;
  let effects;
  let cleanup;

  beforeEach(async () => {
    ({ store, effects, cleanup } = create());
    await store.enqueueTask({
      sessionId: SESSION_ID,
      issueNumber: ISSUE,
      phase: 'implementation',
      priority: 'normal',
      context: {},
      now: '2026-08-06T11:00:00.000Z',
    });
  });

  afterEach(() => cleanup());

  function effectFor(outcomes) {
    return {
      kind: 'enqueue',
      input: {
        idempotencyKey: disputeOutcomeIdempotencyKey({
          sessionId: SESSION_ID,
          issueNumber: ISSUE,
          surface: 'pr',
          outcome: outcomes[0],
        }),
        topic: 'repohost:pr-comment',
        payload: {
          topic: 'repohost:pr-comment',
          provider: 'github',
          owner: 'org',
          repo: 'repo',
          prNumber: 42,
          body: renderDisputeOutcomeComment(outcomes),
        },
        now: NOW,
      },
    };
  }

  test('the patch, the audit event, and the comment commit together', async () => {
    const ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A) });
    const value = application(ctx, [fixedRecord(LINEAGE_A)], { diff: true });
    const outcomes = publishableDisputeOutcomes(value);

    const result = await commitDisputeTransition({
      store,
      key: KEY,
      expected: { status: 'queued' },
      application: value,
      runId: RUN_ID,
      now: NOW,
      effects: [effectFor(outcomes)],
    });

    expect(result.status).toBe('applied');
    const stored = await store.getTask(KEY);
    expect(stored.context[REVIEW_DISPUTE_CONTEXT_KEY].lineages[LINEAGE_A].state).toBe('resolved_fixed');
    const rows = await effects();
    expect(rows).toHaveLength(1);
    expect(rows[0].topic).toBe('repohost:pr-comment');
    expect(rows[0].payload.body).toContain('resolved_fixed');
  });

  test('a lost CAS leaves no orphan comment behind', async () => {
    const ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A) });
    const value = application(ctx, [fixedRecord(LINEAGE_A)], { diff: true });

    const result = await commitDisputeTransition({
      store,
      key: KEY,
      // The task is `queued`; this guard names a claim nobody holds.
      expected: { status: 'running', ownerRunId: 'someone-else' },
      application: value,
      runId: RUN_ID,
      now: NOW,
      effects: [effectFor(publishableDisputeOutcomes(value))],
    });

    expect(result.status).toBe('claim_lost');
    // Nothing moved, and — the point of this test — nothing was published for a
    // transition that never landed.
    const stored = await store.getTask(KEY);
    expect(stored.context[REVIEW_DISPUTE_CONTEXT_KEY]).toBeUndefined();
    expect(await effects()).toHaveLength(0);
    const events = await store.listEvents(KEY);
    expect(events.filter((e) => e.type.startsWith('review.dispute.'))).toHaveLength(0);
  });

  test('a replayed delivery enqueues nothing at all', async () => {
    const ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A) });
    const first = application(ctx, [fixedRecord(LINEAGE_A)], { diff: true });
    await commitDisputeTransition({
      store,
      key: KEY,
      expected: { status: 'queued' },
      application: first,
      runId: RUN_ID,
      now: NOW,
      effects: [effectFor(publishableDisputeOutcomes(first))],
    });

    const replay = application(ctx, [fixedRecord(LINEAGE_A)], { diff: true, current: first.context });
    const result = await commitDisputeTransition({
      store,
      key: KEY,
      expected: { status: 'queued' },
      application: replay,
      runId: RUN_ID,
      now: NOW,
      // Even if a caller handed a stale effect list over, the duplicate check
      // short-circuits the write before it is reached.
      effects: [effectFor(publishableDisputeOutcomes(first))],
    });

    expect(result.status).toBe('duplicate');
    expect(await effects()).toHaveLength(1);
  });

  test('a second delivery of the same outcome dedupes on its idempotency key', async () => {
    const ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A) });
    const value = application(ctx, [fixedRecord(LINEAGE_A)], { diff: true });
    const effect = effectFor(publishableDisputeOutcomes(value));

    await commitDisputeTransition({
      store, key: KEY, expected: { status: 'queued' }, application: value, runId: RUN_ID, now: NOW,
      effects: [effect],
    });
    // A DIFFERENT run re-deriving the same completion (the #701 phase re-run
    // shape) produces the same key, so the outbox keeps one row.
    await commitDisputeTransition({
      store,
      key: KEY,
      expected: { status: 'queued', phase: 'review' },
      application: application(context({ [LINEAGE_A]: lineage(LINEAGE_A) }), [fixedRecord(LINEAGE_A)], {
        diff: true,
        runId: 'run-impl-2',
      }),
      runId: 'run-impl-2',
      now: NOW,
      effects: [effect],
    });

    expect(await effects()).toHaveLength(1);
  });

  test('an intermediate transition commits with no effect at all', async () => {
    const ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A) });
    const value = application(ctx, [disputeRecord(LINEAGE_A)]);

    const result = await commitDisputeTransition({
      store,
      key: KEY,
      expected: { status: 'queued' },
      application: value,
      runId: RUN_ID,
      now: NOW,
      effects: publishableDisputeOutcomes(value).map((o) => effectFor([o])),
    });

    expect(result.status).toBe('applied');
    expect((await store.getTask(KEY)).context[REVIEW_DISPUTE_CONTEXT_KEY].lineages[LINEAGE_A].state).toBe(
      'disputed',
    );
    expect(await effects()).toHaveLength(0);
  });

  test('an operator audit event rides in the same transaction as the §10.3 event', async () => {
    const ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A) });
    const resolved = application(ctx, [fixedRecord(LINEAGE_A)], { diff: true });
    await commitDisputeTransition({
      store, key: KEY, expected: { status: 'queued' }, application: resolved, runId: RUN_ID, now: NOW,
    });

    const reopened = reopenApplication(resolved.context, LINEAGE_A);
    const result = await commitDisputeTransition({
      store,
      key: KEY,
      expected: { status: 'queued', phase: 'review' },
      application: reopened,
      runId: 'run-operator-1',
      now: NOW,
      extraEvents: [
        {
          task: KEY,
          type: 'review.dispute.operator',
          runId: 'run-operator-1',
          data: { action: 'reopen_request', lineageId: LINEAGE_A, version: 1 },
          createdAt: NOW,
        },
      ],
      effects: [],
    });

    expect(result.status).toBe('applied');
    const events = await store.listEvents(KEY);
    expect(events.filter((e) => e.type === 'review.dispute.operator')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'review.dispute.transition')).toHaveLength(2);
    // §6.4: flagged, not overturned.
    const stored = await store.getTask(KEY);
    expect(stored.context[REVIEW_DISPUTE_CONTEXT_KEY].lineages[LINEAGE_A].state).toBe('resolved_fixed');
    expect(stored.context[REVIEW_DISPUTE_CONTEXT_KEY].lineages[LINEAGE_A].reopenRequested).toBe(true);
    expect(stored.status).toBe('ready_for_human');
    expect(await effects()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 5. The production path — a real runNextPhase completion
// ---------------------------------------------------------------------------

const BASE_SESSION = {
  sessionId: SESSION_ID,
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
  reviewDispute: { enabled: true },
};

describe('runNextPhase — §11 publication', () => {
  let dir;
  let taskStore;
  let outboxStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dispute-pub-runner-'));
    const dbPath = join(dir, 'test.db');
    taskStore = new SqliteTaskStore(dbPath);
    outboxStore = new SqliteOutboxStore(dbPath);
  });

  afterEach(() => {
    outboxStore.close();
    taskStore.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const request = {
    sessionId: SESSION_ID,
    workerId: 'w',
    runId: RUN_ID,
    supportedPhases: ['implementation'],
    now: NOW,
  };

  async function enqueue(ctx, extraContext = {}) {
    await taskStore.enqueueTask({
      sessionId: SESSION_ID,
      issueNumber: ISSUE,
      phase: 'implementation',
      priority: 'normal',
      context: { [REVIEW_DISPUTE_CONTEXT_KEY]: ctx, ...extraContext },
      now: '2026-08-06T11:00:00.000Z',
    });
  }

  function handlerReturning(value, handlerContext = {}) {
    return async () => ({
      result: 'success',
      context: { branch: 'ai/issue-848', ...handlerContext },
      ...(value ? { disputeTransition: value } : {}),
    });
  }

  async function run(value, { session = BASE_SESSION, handlerContext = {} } = {}) {
    return runNextPhase({
      store: taskStore,
      request,
      handlers: { implementation: handlerReturning(value, handlerContext) },
      outboxStore,
      session,
      now: NOW,
    });
  }

  /** The dispute comment among a completion's other side effects, if any. */
  async function disputeRows() {
    const pending = await outboxStore.listPending();
    return pending.filter((e) => String(e.payload?.body ?? '').includes('Review dispute outcome'));
  }

  test('a resolved lineage is published on the current PR, not the work item', async () => {
    const ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A) });
    await enqueue(ctx);
    const outcome = await run(application(ctx, [fixedRecord(LINEAGE_A)], { diff: true }), {
      handlerContext: { prUrl: 'https://github.com/org/repo/pull/42' },
    });
    expect(outcome.status).toBe('completed');

    const rows = await disputeRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].topic).toBe('repohost:pr-comment');
    expect(rows[0].payload.prNumber).toBe(42);
    expect(rows[0].payload.body).toContain(LINEAGE_A);
    expect(rows[0].payload.body).toContain('resolved_fixed');
    // PR-first means exactly one surface: no duplicate detailed comment on the
    // Issue timeline.
    expect(rows.filter((r) => r.topic === 'gh:comment')).toHaveLength(0);
  });

  test('a task with no PR falls back to the work-item surface', async () => {
    const ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A) });
    await enqueue(ctx);
    await run(application(ctx, [blockedRecord(LINEAGE_A)]));

    const rows = await disputeRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].topic).toBe('gh:comment');
    expect(rows[0].payload.issueNumber).toBe(ISSUE);
    expect(rows[0].payload.body).toContain('escalated_human');
  });

  test('an intermediate state creates no public status noise', async () => {
    const ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A) });
    await enqueue(ctx);
    await run(application(ctx, [disputeRecord(LINEAGE_A)]), {
      handlerContext: { prUrl: 'https://github.com/org/repo/pull/42' },
    });

    const stored = await taskStore.getTask(KEY);
    expect(stored.context[REVIEW_DISPUTE_CONTEXT_KEY].lineages[LINEAGE_A].state).toBe('disputed');
    expect(await disputeRows()).toHaveLength(0);
  });

  test('a task-level handoff that transitions no lineage manufactures no comment', async () => {
    // The review-loop cap handoff (§9): the task parks for a human, no lineage
    // changes state, and §11 therefore has nothing to announce.
    const ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A) });
    await enqueue(ctx, { reviewLoopCapReached: true });
    await run(undefined, { handlerContext: { prUrl: 'https://github.com/org/repo/pull/42' } });
    expect(await disputeRows()).toHaveLength(0);
  });

  test('a session with the protocol disabled publishes nothing', async () => {
    const ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A) });
    await enqueue(ctx);
    await run(application(ctx, [fixedRecord(LINEAGE_A)], { diff: true }), {
      session: { ...BASE_SESSION, reviewDispute: { enabled: false } },
      handlerContext: { prUrl: 'https://github.com/org/repo/pull/42' },
    });
    expect(await disputeRows()).toHaveLength(0);
  });

  test('a gitea repo host is addressed at its configured code repository', async () => {
    // The dispatcher builds the repo-host provider from the row's own
    // owner/repo, and a self-hosted Gitea code repo has no relationship to
    // `githubRepo` — addressing the row with the GitHub tuple would post the
    // outcome to the wrong repository (or 404 forever).
    const ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A) });
    await enqueue(ctx);
    await run(application(ctx, [fixedRecord(LINEAGE_A)], { diff: true }), {
      session: {
        ...BASE_SESSION,
        repoHostProvider: {
          provider: 'gitea',
          auth: { mode: 'api-token', tokenEnv: 'GITEA_TOKEN' },
          gitea: { baseUrl: 'https://gitea.test', owner: 'code-org', repo: 'code-repo' },
        },
      },
      handlerContext: { prUrl: 'https://gitea.test/code-org/code-repo/pulls/42' },
    });

    const rows = await disputeRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].topic).toBe('repohost:pr-comment');
    expect(rows[0].payload.provider).toBe('gitea');
    expect(rows[0].payload.owner).toBe('code-org');
    expect(rows[0].payload.repo).toBe('code-repo');
    expect(rows[0].payload.prNumber).toBe(42);
  });

  test('a github repo host keeps the session repository tuple', async () => {
    const ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A) });
    await enqueue(ctx);
    await run(application(ctx, [fixedRecord(LINEAGE_A)], { diff: true }), {
      handlerContext: { prUrl: 'https://github.com/org/repo/pull/42' },
    });

    const rows = await disputeRows();
    expect(rows[0].payload.owner).toBe('org');
    expect(rows[0].payload.repo).toBe('repo');
  });

  test('the published body passes the same path sanitization every comment does', async () => {
    const ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A) });
    await enqueue(ctx);
    await run(application(ctx, [fixedRecord(LINEAGE_A)], { diff: true }), {
      handlerContext: { prUrl: 'https://github.com/org/repo/pull/42', artifactDir: '/tmp/test-repo/.artifacts' },
    });

    const body = (await disputeRows())[0].payload.body;
    expect(body).not.toContain('/tmp/test-repo');
    expect(body).not.toMatch(/\/Users\//);
    expect(body).not.toContain(RUN_ID);
    expect(body).not.toContain(ARGUMENT);
  });
});
