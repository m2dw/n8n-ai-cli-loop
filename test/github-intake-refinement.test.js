/**
 * Chain-aware progressive Issue refinement — intake foundation (issue #867).
 *
 * Covers the acceptance criteria of the Issue against the live intake CLI:
 * stale execution labels, missing configuration, idempotent intake, restart
 * persistence, and the unchanged implementation/review/research routing.
 */

import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SqliteOutboxStore, SqliteTaskStore } from '../dist/index.js';
import { runIntake } from '../dist/cli/github-intake.js';
import { runNextPhase } from '../dist/core/phase-runner.js';

const CLI = new URL('../dist/cli/github-intake.js', import.meta.url).pathname;
const ADMIN_CLI = new URL('../dist/cli/admin.js', import.meta.url).pathname;

const BASE_SESSION = {
  sessionId: 'addon-dev',
  repoKey: 'thunderbird-auth-results-filter',
  repoRoot: '/Users/moto/git/thunderbird-auth-results-filter',
  githubRepo: 'm2dw/thunderbird-auth-results-filter',
  artifactDir: '.n8n-artifacts',
  defaults: { implementationAgent: 'claude', reviewAgent: 'codex', researchAgent: 'gemini' },
  verification: { test: 'npm test' },
  labels: { active: 'ai:active', blocked: 'ai:blocked', readyForHuman: 'ai:ready-for-human' },
};

/** No-op dep checker: no issue is blocked. */
const noBlockerChecker = { getBlockedBy: async () => [] };

let tmpDir;
let sessionsPath;
let dbPath;

function writeSession(overrides = {}) {
  writeFileSync(
    sessionsPath,
    JSON.stringify({ sessions: [{ ...BASE_SESSION, ...overrides }] }),
    'utf8',
  );
}

function issue(number, labels, extra = {}) {
  return {
    number,
    title: `Issue ${number}`,
    url: `https://github.com/m2dw/thunderbird-auth-results-filter/issues/${number}`,
    labels: labels.map((name) => ({ name })),
    ...extra,
  };
}

async function intake(issues, { depChecker = noBlockerChecker, supportedPhases, dryRun = false, stackReadyResolver } = {}) {
  const args = {
    sessionId: 'addon-dev',
    sessionsPath,
    dbPath,
    limit: 100,
    dryRun,
    supportedPhases: supportedPhases ?? ['implementation', 'review', 'research', 'content_research'],
  };
  const chunks = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => { chunks.push(chunk); return true; };
  try {
    await runIntake(args, { listIssues: () => issues }, depChecker, stackReadyResolver);
  } finally {
    process.stdout.write = origWrite;
  }
  return JSON.parse(chunks.join('').trim());
}

/**
 * Run the intake CLI as a subprocess. Needed for config-error cases: `die()`
 * calls `process.exit`, which would take the test worker with it in-process.
 */
function runCli() {
  try {
    const stdout = execFileSync(
      process.execPath,
      [CLI, '--session-id', 'addon-dev', '--sessions-path', sessionsPath, '--db-path', dbPath],
      { encoding: 'utf8' },
    );
    return { code: 0, out: JSON.parse(stdout.trim()) };
  } catch (err) {
    return { code: err.status ?? 1, out: JSON.parse((err.stdout ?? '').trim()) };
  }
}

async function readTask(issueNumber) {
  const store = new SqliteTaskStore(dbPath);
  try {
    return await store.getTask({ sessionId: 'addon-dev', issueNumber });
  } finally {
    store.close();
  }
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'intake-refinement-'));
  sessionsPath = join(tmpDir, 'sessions.json');
  dbPath = join(tmpDir, 'dev_loop.db');
  writeSession({ issueRefinement: { enabled: true } });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// §19 rollout gate
// ---------------------------------------------------------------------------

describe('intake refinement — §19 the lane is off by default', () => {
  test('with the lane disabled the marker is inert and today’s routing stands', async () => {
    writeSession();
    const out = await intake([
      issue(101, ['status:needs-refinement', 'agent:claude', 'status:needs-implementation']),
      issue(102, ['status:needs-refinement', 'agent:claude']),
    ]);
    expect(out.refinementEnabled).toBe(false);
    expect(out.refinementAdmitted).toBe(0);
    expect(out.refinementRefused).toBe(0);
    // #101 routes to implementation exactly as it does today; #102 matches no
    // intake rule and is simply not a candidate.
    expect(out.results).toEqual([{ issueNumber: 101, action: 'enqueued', phase: 'implementation' }]);
    expect((await readTask(101)).phase).toBe('implementation');
    expect(await readTask(102)).toBeUndefined();
  });

  test('an unknown issueRefinement setting is rejected at session load', () => {
    writeSession({ issueRefinement: { enabled: true, rounds: 5 } });
    const r = runCli();
    expect(r.code).not.toBe(0);
    expect(r.out).toMatchObject({
      ok: false,
      error: expect.stringContaining('not a known issue-refinement setting'),
    });
  }, 30_000);

  test('a limit the lane cannot run at is rejected at session load', () => {
    writeSession({ issueRefinement: { enabled: true, limits: { maxRefinementRoundsPerIssue: 0 } } });
    const r = runCli();
    expect(r.code).not.toBe(0);
    expect(r.out).toMatchObject({
      ok: false,
      error: expect.stringContaining('MAX_REFINEMENT_ROUNDS_PER_ISSUE'),
    });
  }, 30_000);

  test('a limit raised above the contract maximum is rejected at session load', () => {
    writeSession({ issueRefinement: { enabled: true, limits: { maxPredecessorsPerRefinement: 9 } } });
    const r = runCli();
    expect(r.code).not.toBe(0);
    expect(r.out.error).toContain('may only be lowered');
  }, 30_000);
});

// ---------------------------------------------------------------------------
// §12 row 1 — admission
// ---------------------------------------------------------------------------

describe('intake refinement — §12 row 1 admission', () => {
  test('the marker maps to a refinement task, not an implementation task', async () => {
    const out = await intake([issue(867, ['status:needs-refinement', 'agent:claude'], { body: 'Rough.' })]);
    expect(out.refinementAdmitted).toBe(1);
    expect(out.results).toEqual([{ issueNumber: 867, action: 'enqueued', phase: 'refinement' }]);

    const task = await readTask(867);
    expect(task.phase).toBe('refinement');
    expect(task.status).toBe('queued');
    expect(task.implementationAgent).toBe('claude');
    expect(task.context.refinement.state).toBe('pending');
    expect(task.context.body).toBe('Rough.');
  });

  test('§14: the deferred implementation assignment is resolved and persisted', async () => {
    await intake([issue(867, ['status:needs-refinement', 'agent:codex'])]);
    const task = await readTask(867);
    // The assignment is the source of truth (docs/assignment-profiles.md); the
    // `agent:*` label only seeded it.
    expect(task.context.assignment.implementationAgent).toBe('codex');
    expect(task.context.refinement.activationPlan).toMatchObject({
      targetPhase: 'implementation',
      targetStatus: 'blocked',
      implementationMode: 'new',
      implementationAgent: 'codex',
      agentLabel: 'agent:codex',
      markerLabel: 'status:needs-refinement',
      implementationStatusLabel: 'status:needs-implementation',
    });
  });

  test('§11 step 7: a renamed needsImplementation label never reaches the activation plan', async () => {
    // `labelsToPhase` gates pickup on the literal `status:needs-implementation`
    // and never on a session's alias (the asymmetry core/issue-activation.ts
    // documents). Persisting the alias here would have activation park an
    // implementation row that ordinary intake could never route.
    writeSession({
      issueRefinement: { enabled: true },
      labels: { ...BASE_SESSION.labels, needsRefinement: 'status:rough', needsImplementation: 'status:go' },
    });
    await intake([issue(867, ['status:rough', 'agent:codex'])]);
    const task = await readTask(867);
    expect(task.phase).toBe('refinement');
    // The marker IS the session's — it is only ever read.
    expect(task.context.refinement.markerLabel).toBe('status:rough');
    expect(task.context.refinement.activationPlan).toMatchObject({
      markerLabel: 'status:rough',
      implementationStatusLabel: 'status:needs-implementation',
    });
  });

  test('§14: refiner and critic come from the assignment profile, never from labels', async () => {
    writeSession({
      issueRefinement: { enabled: true, agents: { refiner: 'gemini' } },
      assignmentProfiles: {
        code: { implementation: 'claude', review: 'codex', refinement: 'claude', refinement_critic: 'codex' },
      },
      flowRules: [{ flow: 'code', default: true }],
    });
    await intake([issue(867, ['status:needs-refinement', 'agent:claude'])]);
    const task = await readTask(867);
    // The profile wins over the session-level `issueRefinement.agents` fallback.
    expect(task.context.refinement.roles).toEqual({
      implementationAgent: 'claude',
      refinerAgent: 'claude',
      criticAgent: 'codex',
      allowSameProvider: false,
    });
    expect(task.context.assignment.refinementAgent).toBe('claude');
    expect(task.context.assignment.refinementCriticAgent).toBe('codex');
  });

  test('with no profile role configured, the session fallback fills it and the rest stays null', async () => {
    writeSession({ issueRefinement: { enabled: true, agents: { refiner: 'gemini' } } });
    await intake([issue(867, ['status:needs-refinement', 'agent:claude'])]);
    const roles = (await readTask(867)).context.refinement.roles;
    expect(roles.refinerAgent).toBe('gemini');
    expect(roles.criticAgent).toBeNull();
  });

  test('admission needs no relationship query — a failing dependency check does not hold it', async () => {
    // §12 row 1 is decided on `intake.scanned` from labels alone. Conditions 2–5
    // (rows 3–7) are the separate predecessor-resolution event.
    const throwingChecker = { getBlockedBy: async () => { throw new Error('graphql down'); } };
    const out = await intake([issue(867, ['status:needs-refinement', 'agent:claude'])], {
      depChecker: throwingChecker,
    });
    expect(out.refinementAdmitted).toBe(1);
    expect((await readTask(867)).phase).toBe('refinement');
  });

  test('admission is not gated on the runner’s supported phases', async () => {
    // `--supported-phases` answers "can this runner EXECUTE the phase?", and
    // admission runs nothing; `issueRefinement.enabled` is the lane's one gate.
    const out = await intake([issue(867, ['status:needs-refinement', 'agent:claude'])], {
      supportedPhases: ['research'],
    });
    expect(out.refinementAdmitted).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// §3 / §12 rows 2 and 47 — an Issue awaiting refinement cannot enter execution
// ---------------------------------------------------------------------------

describe('intake refinement — stale execution labels are refused (row 2)', () => {
  test.each([
    ['status:needs-implementation'],
    ['status:needs-fix'],
    ['status:needs-review'],
    ['status:needs-conflict-resolution'],
  ])('marker + %s refuses admission entirely and creates no task', async (executable) => {
    const out = await intake([issue(867, ['status:needs-refinement', executable, 'agent:claude'])]);
    expect(out.refinementAdmitted).toBe(0);
    expect(out.refinementRefused).toBe(1);
    expect(out.enqueued).toBe(0);
    expect(out.results).toEqual([
      {
        issueNumber: 867,
        action: 'refinement_refused',
        phase: 'refinement',
        title: 'Issue 867',
        reason: 'conflicting_markers',
        markerLabel: 'status:needs-refinement',
        conflictingLabels: [executable],
      },
    ]);
    // The whole point: it neither refines nor implements it.
    expect(await readTask(867)).toBeUndefined();
  });

  test('a stale research pair beside the marker is refused, not routed to research', async () => {
    const out = await intake([issue(867, ['status:needs-refinement', 'status:research-needed', 'agent:gemini'])]);
    expect(out.refinementRefused).toBe(1);
    expect(await readTask(867)).toBeUndefined();
  });

  test('the refusal is re-evaluated on the next poll once the labels are fixed', async () => {
    await intake([issue(867, ['status:needs-refinement', 'status:needs-fix', 'agent:claude'])]);
    expect(await readTask(867)).toBeUndefined();

    const out = await intake([issue(867, ['status:needs-refinement', 'agent:claude'])]);
    expect(out.refinementAdmitted).toBe(1);
    expect((await readTask(867)).phase).toBe('refinement');
  });
});

// ---------------------------------------------------------------------------
// §3.1 — the marker also stops a task that already exists
// ---------------------------------------------------------------------------

describe('intake refinement — §3.1 the marker stops an existing executable task', () => {
  test('a queued executable task is suspended when the marker appears beside its status', async () => {
    await intake([issue(867, ['agent:claude', 'status:needs-implementation'])]);
    expect((await readTask(867)).status).toBe('queued');

    const out = await intake([
      issue(867, ['status:needs-refinement', 'agent:claude', 'status:needs-implementation']),
    ]);
    expect(out.refinementSuspended).toBe(1);
    expect(out.refinementRefused).toBe(1);
    // The suspension is decided before any candidate is enqueued; the refusal is
    // reported at the end of the poll, as it already was.
    expect(out.results).toEqual([
      {
        issueNumber: 867,
        action: 'refinement_execution_suspended',
        phase: 'implementation',
        previousStatus: 'queued',
        markerLabel: 'status:needs-refinement',
        reason: 'execution_marker_conflict',
        conflictingLabels: ['status:needs-implementation'],
      },
      {
        issueNumber: 867,
        action: 'refinement_refused',
        phase: 'refinement',
        title: 'Issue 867',
        reason: 'conflicting_markers',
        markerLabel: 'status:needs-refinement',
        conflictingLabels: ['status:needs-implementation'],
      },
    ]);

    const task = await readTask(867);
    // Parked for a human: `ready_for_human` is not claimable, so the task can no
    // longer execute or publish against the rough contract.
    expect(task.status).toBe('ready_for_human');
    expect(task.phase).toBe('implementation');
    expect(task.context.refinementExecutionConflict).toMatchObject({
      reason: 'execution_marker_conflict',
      markerLabel: 'status:needs-refinement',
      conflictingLabels: ['status:needs-implementation'],
      previousStatus: 'queued',
      previousPhase: 'implementation',
    });
    expect(task.lastError).toContain('execution_marker_conflict');
  });

  test('a claimed task is suspended too, and its claim is released', async () => {
    await intake([issue(867, ['agent:claude', 'status:needs-implementation'])]);
    const store = new SqliteTaskStore(dbPath);
    let claimed;
    try {
      claimed = await store.claimNextTask({ sessionId: 'addon-dev', workerId: 'w1', runId: 'run-1' });
    } finally {
      store.close();
    }
    expect(claimed.status).toBe('claimed');

    const out = await intake([
      issue(867, ['status:needs-refinement', 'agent:claude', 'status:needs-fix']),
    ]);
    expect(out.refinementSuspended).toBe(1);

    const task = await readTask(867);
    expect(task.status).toBe('ready_for_human');
    expect(task.ownerRunId).toBeUndefined();
    expect(task.leaseExpiresAt).toBeUndefined();
    expect(task.context.refinementExecutionConflict.previousStatus).toBe('claimed');
  });

  test('the suspension records its own audit event and changes no label', async () => {
    await intake([issue(867, ['agent:codex', 'status:needs-review'])]);
    await intake([issue(867, ['status:needs-refinement', 'agent:codex', 'status:needs-review'])]);

    const store = new SqliteTaskStore(dbPath);
    let events;
    try {
      events = await store.listEvents({ sessionId: 'addon-dev', issueNumber: 867 });
    } finally {
      store.close();
    }
    const suspended = events.filter((e) => e.type === 'refinement.execution.suspended');
    expect(suspended).toHaveLength(1);
    expect(suspended[0].data).toMatchObject({
      reason: 'execution_marker_conflict',
      previousPhase: 'review',
      previousStatus: 'queued',
    });

    // §3.1: the guard changes no labels — both were applied by an operator and
    // deciding which one wins is the human decision the handoff requests.
    const outbox = new SqliteOutboxStore(dbPath);
    let pending;
    try {
      pending = await outbox.listUnsent();
    } finally {
      outbox.close();
    }
    expect(pending.filter((e) => String(e.topic).startsWith('gh:'))).toEqual([]);
  });

  test('the guard is idempotent — a repeated poll neither re-suspends nor rewrites the row', async () => {
    await intake([issue(867, ['agent:claude', 'status:needs-implementation'])]);
    const marked = [issue(867, ['status:needs-refinement', 'agent:claude', 'status:needs-implementation'])];
    await intake(marked);
    const first = await readTask(867);

    const out = await intake(marked);
    expect(out.refinementSuspended).toBe(0);
    const after = await readTask(867);
    expect(after.revision).toBe(first.revision);
    expect(after.updatedAt).toBe(first.updatedAt);
  });

  test('a refinement row is never suspended by the marker that admitted it', async () => {
    await intake([issue(867, ['status:needs-refinement', 'agent:claude'])]);
    const out = await intake([issue(867, ['status:needs-refinement', 'agent:claude'])]);
    expect(out.refinementSuspended).toBe(0);
    expect((await readTask(867)).status).toBe('queued');
  });
});

// ---------------------------------------------------------------------------
// Recovery: a row from the lane the Issue LEFT must not strand the lane
// ---------------------------------------------------------------------------

describe('intake refinement — an old executable row does not block admission', () => {
  async function withStore(fn) {
    const store = new SqliteTaskStore(dbPath);
    try {
      return await fn(store);
    } finally {
      store.close();
    }
  }

  test('after the conflicting task is cancelled, a clean marker admits refinement', async () => {
    await intake([issue(867, ['agent:claude', 'status:needs-implementation'])]);
    // The disposal an operator performs after resolving a marker conflict.
    await withStore((store) =>
      store.cancelTask({ sessionId: 'addon-dev', issueNumber: 867 }, { reason: 'superseded by refinement' }),
    );
    expect((await readTask(867)).status).toBe('cancelled');

    const out = await intake([issue(867, ['status:needs-refinement', 'agent:claude'], { body: 'Rough.' })]);
    expect(out.refinementAdmitted).toBe(1);
    expect(out.results).toEqual([
      {
        issueNumber: 867,
        action: 'replaced',
        phase: 'refinement',
        previousPhase: 'implementation',
        previousStatus: 'cancelled',
      },
    ]);

    const task = await readTask(867);
    expect(task.phase).toBe('refinement');
    expect(task.status).toBe('queued');
    expect(task.context.refinement.state).toBe('pending');
    expect(task.context.body).toBe('Rough.');
  });

  test('the replacement starts clean — no key from the lane the Issue left survives', async () => {
    await intake([issue(867, ['agent:claude', 'status:needs-implementation'])]);
    const before = await readTask(867);
    // The implementation lane wrote both of these at intake.
    expect(before.context.implementationMode).toBe('new');
    expect(before.context.dependencyDecision).toBeDefined();

    await withStore((store) => store.cancelTask({ sessionId: 'addon-dev', issueNumber: 867 }));
    await intake([issue(867, ['status:needs-refinement', 'agent:claude'])]);

    const task = await readTask(867);
    expect(task.context.implementationMode).toBeUndefined();
    expect(task.context.dependencyDecision).toBeUndefined();
    expect(task.attempts).toEqual({});
    expect(task.lastError).toBeUndefined();
    expect(task.ownerRunId).toBeUndefined();
    // The pinned assignment is this lane's own, resolved at this admission.
    expect(task.context.assignment.implementationAgent).toBe('claude');
    expect(task.context.refinement.activationPlan.implementationAgent).toBe('claude');
  });

  test('a finished row is replaced as well, so the Issue can be refined again', async () => {
    await intake([issue(867, ['agent:claude', 'status:needs-implementation'])]);
    await withStore((store) =>
      store.transitionTask({ sessionId: 'addon-dev', issueNumber: 867 }, { status: 'queued' }, { status: 'done' }),
    );

    const out = await intake([issue(867, ['status:needs-refinement', 'agent:claude'])]);
    expect(out.refinementAdmitted).toBe(1);
    expect(out.results[0]).toMatchObject({ action: 'replaced', previousStatus: 'done' });
    expect((await readTask(867)).phase).toBe('refinement');
  });

  test('a live row is suspended first and replaced on the next poll — never both at once', async () => {
    await intake([issue(867, ['agent:claude', 'status:needs-implementation'])]);

    // Poll 1: the labels are already clean, but the row is still runnable, so
    // the §3.1 guard stops it and admits nothing.
    const first = await intake([issue(867, ['status:needs-refinement', 'agent:claude'])]);
    expect(first.refinementSuspended).toBe(1);
    expect(first.refinementAdmitted).toBe(0);
    expect(first.results).toEqual([
      {
        issueNumber: 867,
        action: 'refinement_execution_suspended',
        phase: 'implementation',
        previousStatus: 'queued',
        markerLabel: 'status:needs-refinement',
        reason: 'execution_marker_conflict',
      },
    ]);
    const parked = await readTask(867);
    expect(parked.status).toBe('ready_for_human');
    expect(parked.phase).toBe('implementation');

    // Poll 2: the row is parked, so the lane starts on its own.
    const second = await intake([issue(867, ['status:needs-refinement', 'agent:claude'])]);
    expect(second.refinementAdmitted).toBe(1);
    expect(second.results[0]).toMatchObject({
      action: 'replaced',
      previousPhase: 'implementation',
      previousStatus: 'ready_for_human',
    });
    const task = await readTask(867);
    expect(task.phase).toBe('refinement');
    expect(task.context.refinementExecutionConflict).toBeUndefined();

    // And it stays put from there: the third poll is the ordinary idempotent one.
    const third = await intake([issue(867, ['status:needs-refinement', 'agent:claude'])]);
    expect(third.results).toEqual([{ issueNumber: 867, action: 'already_exists', phase: 'refinement' }]);
  });
});

describe('intake refinement — missing configuration is refused (row 47)', () => {
  test('the marker with no implementation-lane agent label creates no task', async () => {
    const out = await intake([issue(867, ['status:needs-refinement', 'complexity:high'])]);
    expect(out.refinementRefused).toBe(1);
    expect(out.results).toEqual([
      {
        issueNumber: 867,
        action: 'refinement_refused',
        phase: 'refinement',
        title: 'Issue 867',
        reason: 'no_implementation_agent',
        markerLabel: 'status:needs-refinement',
      },
    ]);
    expect(await readTask(867)).toBeUndefined();
  });

  test('an assignment the session cannot resolve fails closed without activating implementation', async () => {
    // An assignment profile naming an unsupported conflict-resolution agent is
    // the existing fail-closed shape; for the refinement lane it means the
    // deferred implementation owner is unknown, so the Issue is refused rather
    // than admitted and later activated against an assignment nobody chose.
    writeSession({
      issueRefinement: { enabled: true },
      assignmentProfiles: { code: { implementation: 'claude', review: 'codex', conflict_resolution: 'codex' } },
      flowRules: [{ flow: 'code', default: true }],
    });
    const out = await intake([issue(867, ['status:needs-refinement', 'agent:claude'])]);
    expect(out.refinementRefused).toBe(1);
    expect(out.results[0]).toMatchObject({ action: 'refinement_refused', reason: 'no_implementation_agent' });
    expect(await readTask(867)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Idempotency and restart persistence
// ---------------------------------------------------------------------------

describe('intake refinement — idempotent intake and restart persistence', () => {
  test('a repeated poll finds the row and leaves its state untouched', async () => {
    const issues = [issue(867, ['status:needs-refinement', 'agent:claude'], { body: 'Rough.' })];
    await intake(issues);
    const first = await readTask(867);

    const second = await intake(issues);
    expect(second.results).toEqual([{ issueNumber: 867, action: 'already_exists', phase: 'refinement' }]);
    expect(second.enqueued).toBe(0);
    expect(second.alreadyExists).toBe(1);

    const after = await readTask(867);
    expect(after.context.refinement).toEqual(first.context.refinement);
    expect(after.revision).toBe(first.revision);
  });

  test('refinement state survives a restart — it is read back from SQLite, not rebuilt', async () => {
    await intake([issue(867, ['status:needs-refinement', 'agent:claude'], { body: 'Rough.' })]);
    const before = (await readTask(867)).context.refinement;

    // A fresh store handle over the same file is exactly what a restarted
    // process gets.
    const store = new SqliteTaskStore(dbPath);
    let reloaded;
    try {
      reloaded = await store.getTask({ sessionId: 'addon-dev', issueNumber: 867 });
    } finally {
      store.close();
    }
    expect(reloaded.phase).toBe('refinement');
    expect(reloaded.context.refinement).toEqual(before);
    expect(reloaded.context.refinement.sourceFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(reloaded.context.refinement.limits.maxRefinementRoundsPerIssue).toBe(2);
  });

  test('an existing refinement row is not disturbed by a later label edit', async () => {
    await intake([issue(867, ['status:needs-refinement', 'agent:claude'])]);
    const before = await readTask(867);

    // The operator adds an executable status; the marker is still present, so
    // admission would now refuse — but the refusal decides only whether a NEW
    // task is created, and this row is left exactly as it was.
    const out = await intake([issue(867, ['status:needs-refinement', 'status:needs-fix', 'agent:claude'])]);
    expect(out.refinementRefused).toBe(1);
    const after = await readTask(867);
    expect(after.phase).toBe('refinement');
    expect(after.context.refinement).toEqual(before.context.refinement);
  });
});

// ---------------------------------------------------------------------------
// Existing intake behavior is unchanged
// ---------------------------------------------------------------------------

describe('intake refinement — existing intake behavior is unchanged', () => {
  test('implementation, review, and research intake are untouched with the lane enabled', async () => {
    const out = await intake([
      issue(101, ['agent:claude', 'status:needs-implementation']),
      issue(102, ['agent:codex', 'status:needs-review']),
      issue(103, ['agent:gemini', 'status:research-needed']),
      issue(104, ['bug']),
    ]);
    expect(out.results).toEqual([
      { issueNumber: 101, action: 'enqueued', phase: 'implementation' },
      { issueNumber: 102, action: 'enqueued', phase: 'review' },
      { issueNumber: 103, action: 'enqueued', phase: 'research' },
    ]);
    expect(out.refinementAdmitted).toBe(0);
    expect(out.refinementRefused).toBe(0);
    expect((await readTask(101)).context.refinement).toBeUndefined();
  });

  test('the dependency gate still holds a blocked issue while refinement is admitted', async () => {
    // A review task with an open blocker is not the Gate 2 stackable shape, so
    // the close-only gate holds it — unchanged. The refinement lane deliberately
    // admits shapes the implementation start gates do not (§4).
    const blocked = { getBlockedBy: async (n) => (n === 102 ? [{ issueNumber: 99, state: 'open' }] : []) };
    const out = await intake(
      [
        issue(102, ['agent:codex', 'status:needs-review']),
        issue(867, ['status:needs-refinement', 'agent:claude']),
      ],
      { depChecker: blocked },
    );
    expect(out.results).toEqual([{ issueNumber: 867, action: 'enqueued', phase: 'refinement' }]);
    expect(await readTask(102)).toBeUndefined();
  });

  test('a refinement candidate is previewed by --dry-run without being enqueued', async () => {
    const out = await intake([issue(867, ['status:needs-refinement', 'agent:claude'])], { dryRun: true });
    expect(out.results).toEqual([
      { issueNumber: 867, action: 'dry_run', phase: 'refinement', title: 'Issue 867' },
    ]);
    expect(await readTask(867)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Operator surfaces
// ---------------------------------------------------------------------------

describe('intake refinement — admin task-status exposes the state', () => {
  function admin(...args) {
    try {
      return { code: 0, stdout: execFileSync(process.execPath, [ADMIN_CLI, ...args], { encoding: 'utf8' }) };
    } catch (err) {
      return { code: err.status ?? 1, stdout: err.stdout ?? '' };
    }
  }

  test('the refinement block is projected into JSON and human output', async () => {
    await intake([issue(867, ['status:needs-refinement', 'agent:codex'])]);

    const json = admin('task-status', '--session-id', 'addon-dev', '--db-path', dbPath, '--json');
    expect(json.code).toBe(0);
    const task = JSON.parse(json.stdout.trim()).tasks[0];
    expect(task).toMatchObject({ issueNumber: 867, phase: 'refinement' });
    expect(task.refinement).toMatchObject({
      state: 'pending',
      terminal: false,
      predecessors: [],
      activation: { targetPhase: 'implementation', targetStatus: 'blocked', implementationAgent: 'codex' },
    });

    const text = admin('task-status', '--session-id', 'addon-dev', '--db-path', dbPath);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain('refinement: state=pending');
    expect(text.stdout).toContain('activation: blocked/implementation');
  }, 30_000);

  test('a task from another lane still renders exactly as before', async () => {
    await intake([issue(101, ['agent:claude', 'status:needs-implementation'])]);
    const json = admin('task-status', '--session-id', 'addon-dev', '--db-path', dbPath, '--json');
    expect(JSON.parse(json.stdout.trim()).tasks[0].refinement).toBeNull();

    const text = admin('task-status', '--session-id', 'addon-dev', '--db-path', dbPath);
    expect(text.stdout).not.toContain('refinement:');
  }, 30_000);
});

// ---------------------------------------------------------------------------
// §11 step 7 / §12 rows 33 & 45 — the activation handover into the
// implementation lane (issue #871)
//
// The slices before this one pinned each stage in isolation: admission
// (#867), the loop (#869), the application walk and the row-45 park (#870).
// What none of them pinned is the seam that makes the lane self-driving —
// a row the runner parked at `blocked`/`implementation` being picked up by
// ORDINARY intake, on an ordinary poll, through the issue-#224 reactivation
// branch, once the activated Issue carries `status:needs-implementation`
// and Gate 2 confirms its predecessor stack-ready.
// ---------------------------------------------------------------------------

describe('intake refinement — activation hands the parked row to ordinary intake (issue #871)', () => {
  const PARK_SESSION = {
    ...BASE_SESSION,
    githubOwner: 'm2dw',
    githubName: 'thunderbird-auth-results-filter',
    labels: {
      ...BASE_SESSION.labels,
      needsReview: 'status:needs-review',
      needsImplementation: 'status:needs-implementation',
    },
    workItemProvider: { provider: 'github-issues', auth: { mode: 'gh' } },
    repoHostProvider: { provider: 'github', auth: { mode: 'gh' } },
  };

  const ACTIVATED_LABELS = ['agent:claude', 'status:needs-implementation'];

  /** The target's one open blocker is its predecessor; nothing else is blocked. */
  function predecessorChecker(target, predecessor) {
    return {
      getBlockedBy: async (n) =>
        n === target ? [{ issueNumber: predecessor, state: 'open' }] : [],
    };
  }

  /**
   * Commit the §12 row-45 park exactly as production does: claim the queued
   * refinement row through runNextPhase and complete it with the application
   * walk's `activated` outcome — success + `refinementActivation` taken from
   * the §14 activation plan intake persisted at admission. The handler stands
   * in for the (separately tested) apply walk; the park transaction is real.
   */
  async function parkViaRunner(issueNumber) {
    const taskStore = new SqliteTaskStore(dbPath);
    const outboxStore = new SqliteOutboxStore(dbPath);
    try {
      const before = await taskStore.getTask({ sessionId: 'addon-dev', issueNumber });
      const block = before.context.refinement;
      const outcome = await runNextPhase({
        store: taskStore,
        request: {
          sessionId: 'addon-dev',
          workerId: 'w1',
          runId: 'run-refinement-park',
          supportedPhases: ['refinement'],
          now: new Date().toISOString(),
        },
        handlers: {
          refinement: async () => ({
            result: 'success',
            message: 'refinement applied and implementation activated',
            context: { refinement: { ...block, state: 'activated' } },
            extraEvents: [{ type: 'refinement.activated', data: { issueNumber } }],
            refinementActivation: {
              targetStatus: block.activationPlan.targetStatus,
              targetPhase: block.activationPlan.targetPhase,
            },
          }),
        },
        outboxStore,
        session: PARK_SESSION,
        now: new Date().toISOString(),
      });
      expect(outcome.status).toBe('completed');
    } finally {
      taskStore.close();
      outboxStore.close();
    }
  }

  test('a refinement-activated row is reactivated dep-stacked with its pinned assignment and audit block intact', async () => {
    // Poll 1 — the marker admits the refinement row with the §14 assignment
    // pinned in context. The open predecessor never holds admission (§4
    // condition 1 is a pure label test).
    const admitted = await intake(
      [issue(101, ['agent:claude', 'status:needs-refinement'])],
      { depChecker: predecessorChecker(101, 55) },
    );
    expect(admitted.results).toEqual([{ issueNumber: 101, action: 'enqueued', phase: 'refinement' }]);
    const pinnedAssignment = (await readTask(101)).context.assignment;
    expect(pinnedAssignment).toBeDefined();

    // Row 45: the walk activates and the runner parks the shared row at the
    // issue-#224 hold-and-reactivate shape.
    await parkViaRunner(101);
    expect(await readTask(101)).toMatchObject({ status: 'blocked', phase: 'implementation' });

    // The session's defaults change between the polls. Reactivation must
    // restore the assignment pinned at admission (issue #259), so the new
    // default must NOT leak into the row.
    writeSession({
      issueRefinement: { enabled: true },
      defaults: { ...BASE_SESSION.defaults, reviewAgent: 'gemini' },
    });

    // Poll 2 — activation's GitHub end state: marker gone, the executable
    // implementation status present, the agent label untouched (§11 step 5).
    // Gate 2 sees the predecessor as the single open, stack-ready blocker.
    const out = await intake(
      [issue(101, ACTIVATED_LABELS)],
      { depChecker: predecessorChecker(101, 55), stackReadyResolver: async () => true },
    );
    expect(out.results).toEqual([{ issueNumber: 101, action: 'reactivated', phase: 'implementation' }]);

    const reactivated = await readTask(101);
    expect(reactivated.status).toBe('queued');
    expect(reactivated.phase).toBe('implementation');
    // §14: the pinned assignment survives verbatim — poll 2's re-resolution
    // (which would now pick reviewAgent 'gemini') is discarded.
    expect(reactivated.context.assignment).toEqual(pinnedAssignment);
    // The §15 audit block rides along into the implementation lane.
    expect(reactivated.context.refinement).toMatchObject({ state: 'activated' });
    // The fresh dependency snapshot is what the implementation handler stacks
    // on: the predecessor is the one open blocker of a `new`-mode candidate,
    // so implementation continues from the predecessor's PR head.
    expect(reactivated.context.implementationMode).toBe('new');
    expect(reactivated.context.dependencyDecision).toMatchObject({
      blocked: true,
      blockedBy: [{ issueNumber: 55, state: 'open' }],
    });
    expect(reactivated.context.labels).toContain('status:needs-implementation');
  });

  test('the crash-window duplicate refusal is transient: already_exists while un-parked, reactivated after the park (§11/§18)', async () => {
    await intake(
      [issue(101, ['agent:claude', 'status:needs-refinement'])],
      { depChecker: predecessorChecker(101, 55) },
    );

    // Crash window: the labels were delivered on GitHub but the process died
    // before the park committed — the row still sits at phase `refinement`.
    // Ordinary intake must refuse the implementation enqueue as a duplicate:
    // no error, no second row, and the refinement row left untouched.
    const held = await intake(
      [issue(101, ACTIVATED_LABELS)],
      { depChecker: predecessorChecker(101, 55), stackReadyResolver: async () => true },
    );
    expect(held.results).toEqual([{ issueNumber: 101, action: 'already_exists', phase: 'implementation' }]);
    expect(await readTask(101)).toMatchObject({ status: 'queued', phase: 'refinement' });

    // Recovery: the re-claimed apply walk converges on `activated` and the
    // park commits (row 45); the next ordinary poll takes the reactivation
    // branch. The refusal was transient, exactly as §11 requires.
    await parkViaRunner(101);
    const out = await intake(
      [issue(101, ACTIVATED_LABELS)],
      { depChecker: predecessorChecker(101, 55), stackReadyResolver: async () => true },
    );
    expect(out.results).toEqual([{ issueNumber: 101, action: 'reactivated', phase: 'implementation' }]);
    expect(await readTask(101)).toMatchObject({ status: 'queued', phase: 'implementation' });
  });
});
