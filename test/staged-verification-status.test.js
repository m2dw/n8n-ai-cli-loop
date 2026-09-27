// Issue #1107 — staged verification status on the existing operator surfaces
// (docs/staged-verification-contract.md §10 rules 5–6, slice S11).
//
// Pins: the pure stage view separates review approval, pending final
// verification and completed final evidence; it reports selected/required
// checks, durations and invalidation without output bytes; and the Human Gate
// summary states the final stage idempotently — the same completion renders the
// same body under the same key, and a session that has not opted in renders
// exactly what it rendered before.
//
// Issue #1155 removed the regression set and the loop pin set from the view
// with the group selection they narrowed, so the view no longer carries a pin
// reason of any kind.

import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { runFinalStageVerification } from '../dist/handlers/stage-verification.js';
import {
  describeStagedVerificationStatus,
  hasStagedVerificationSurface,
} from '../dist/core/staged-verification-status.js';
import {
  renderHumanGateSummary,
  humanGateFinalStageOf,
} from '../dist/core/human-gate-summary.js';
import { enqueueHumanGateSummaryEffect } from '../dist/core/outbox-effects.js';

const HEAD = 'a'.repeat(40);
const OUTPUT_TOKEN = 'STATUS-VIEW-OUTPUT-BYTES';
const STAGED = { enabled: true };
const VERIFICATION = { test: 'npm test', lint: 'npm run lint' };

let tmpDir;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'staged-status-test-'));
  mkdirSync(join(tmpDir, 'artifacts'), { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function runner({ results = {} } = {}) {
  return {
    run(cmd, args) {
      const argv = [cmd, ...args].join(' ');
      if (cmd === 'git' && args[0] === 'rev-parse') return { stdout: `${HEAD}\n`, stderr: '', exitCode: 0 };
      if (cmd === 'git' && args[0] === 'status') return { stdout: '', stderr: '', exitCode: 0 };
      return results[argv] ?? { stdout: OUTPUT_TOKEN, stderr: '', exitCode: 0 };
    },
  };
}

async function finalContext(results) {
  const run = await runFinalStageVerification({
    runner: runner({ results }),
    session: { verification: VERIFICATION, stagedVerification: STAGED },
    task: { sessionId: 'sess', issueNumber: 7, phase: 'review', status: 'running', revision: 1, attempts: { review: 1 }, context: {} },
    cwd: tmpDir,
    runId: 'run-1',
    taskAttempt: 1,
    artifactDir: join(tmpDir, 'artifacts'),
  });
  expect(run.status).toBe('recorded');
  return run.context;
}

const planFor = (planDigest, lint = 'active') => ({
  planDigest,
  execution: [
    { commandId: 'exec:test', state: 'active' },
    { commandId: 'exec:lint', state: lint },
  ],
  requirement: [],
});

const FAILING = { 'npm test': { stdout: OUTPUT_TOKEN, stderr: '', exitCode: 1 } };

describe('describeStagedVerificationStatus — progress', () => {
  test('a session that has not opted in and holds no state is disabled', () => {
    const view = describeStagedVerificationStatus({ stagedVerification: undefined, context: {} });
    expect(view.progress).toBe('disabled');
    expect(hasStagedVerificationSurface(undefined, {})).toBe(false);
    expect(hasStagedVerificationSurface(STAGED, {})).toBe(true);
  });

  test('enabled with no final stage is not verified evidence', () => {
    const view = describeStagedVerificationStatus({ stagedVerification: STAGED, context: {} });
    expect(view.progress).toBe('no-final-evidence');
    expect(view.state).toBe('absent');
    // Issue #1155 removed the loop pin set and the regression set from the view
    // with the selection they narrowed; nothing replaces them.
    expect(view.loopPinSet).toBeUndefined();
    expect(view.regressionSet).toBeUndefined();
  });

  test('an approval waiting on its final stage is pending full verification', () => {
    const view = describeStagedVerificationStatus({
      stagedVerification: STAGED,
      context: { finalStageApproval: { headSha: HEAD, approval: { result: 'success' } } },
    });
    expect(view.progress).toBe('final-pending');
    expect(view.pendingApprovalHeadSha).toBe(HEAD);
  });

  test('a complete passing final bundle bound to the current plan is completed final evidence', async () => {
    const context = await finalContext();
    const digest = context.stagedVerification.finalBundles[0].planDigest;
    const view = describeStagedVerificationStatus({ stagedVerification: STAGED, context, plan: planFor(digest) });
    expect(view.progress).toBe('final-passed');
    expect(view.requiredChecks).toBe(2);
    expect(view.lastFinal).toMatchObject({
      stage: 'final',
      outcome: 'passed',
      complete: true,
      full: true,
      selected: 2,
      required: 2,
      notSelected: [],
      row: 7,
      disposition: 'grant',
      granting: true,
      invalidations: [],
    });
    expect(view.lastFinal.checks.map((check) => check.checkId).sort()).toEqual(['exec:lint', 'exec:test']);
    expect(typeof view.lastFinal.durationMs === 'number' || view.lastFinal.durationMs === undefined).toBe(true);
    expect(JSON.stringify(view)).not.toContain(OUTPUT_TOKEN);
  });

  test('a plan revision after the grant invalidates the evidence', async () => {
    const context = await finalContext();
    const view = describeStagedVerificationStatus({ stagedVerification: STAGED, context, plan: planFor('f'.repeat(64)) });
    expect(view.progress).toBe('final-invalidated');
    expect(view.lastFinal.invalidations).toContain('plan-digest-changed');
  });

  // Issue #1155 retired the regression set with the selection it was unioned
  // into. What a failing final stage still has to report is the bundle itself:
  // the withheld progress, the row, both dispositions, and — still — the checks
  // the run left without a pass, by id and never as a pass.
  test('a failing final stage is withheld and names the checks it did not prove', async () => {
    const context = await finalContext(FAILING);
    const digest = context.stagedVerification.finalBundles[0].planDigest;
    const view = describeStagedVerificationStatus({ stagedVerification: STAGED, context, plan: planFor(digest, 'retired') });
    expect(view.progress).toBe('final-withheld');
    expect(view.lastFinal).toMatchObject({ outcome: 'code-failed', row: 9, routedDisposition: 'repair', disposition: 'repair', granting: false });
    const failing = view.lastFinal.checks.find((check) => check.checkId === 'exec:test');
    expect(failing.verdict).not.toBe('passed');
    expect(view.regressionSet).toBeUndefined();
    expect(view.regressionSetOverflowed).toBeUndefined();
    expect(JSON.stringify(view)).not.toContain(OUTPUT_TOKEN);
  });

  // Review feedback (P2): the runner overrides the bundle's route — a passing
  // bundle whose head moved is `rerun`, an exhausted budget is `operator` — so
  // the view reports the persisted disposition, keeping the routed one apart.
  test('the persisted final-stage disposition wins over the bundle-derived route', async () => {
    const context = await finalContext();
    const digest = context.stagedVerification.finalBundles[0].planDigest;
    for (const disposition of ['rerun', 'operator']) {
      const view = describeStagedVerificationStatus({
        stagedVerification: STAGED,
        context: { ...context, finalStageVerification: { ...context.finalStageVerification, granted: false, disposition } },
        plan: planFor(digest),
      });
      expect(view.lastFinal).toMatchObject({ outcome: 'passed', row: 7, routedDisposition: 'grant', disposition });
    }

    const unmatched = describeStagedVerificationStatus({
      stagedVerification: STAGED,
      context: { ...context, finalStageVerification: { ...context.finalStageVerification, stageRunKey: 'other', disposition: 'rerun' } },
      plan: planFor(digest),
    });
    expect(unmatched.lastFinal.routedDisposition).toBe('grant');
    expect(unmatched.lastFinal.disposition).toBeUndefined();
  });

  test('a withheld public record is newer than any retained bundle', async () => {
    const context = await finalContext();
    const view = describeStagedVerificationStatus({
      stagedVerification: STAGED,
      context: { ...context, finalStageVerification: { status: 'withheld', disposition: 'operator', reason: 'recovery-budget-exhausted' } },
    });
    expect(view.progress).toBe('final-withheld');
    expect(view.lastFinalRecord).toEqual({ status: 'withheld', reason: 'recovery-budget-exhausted' });
  });

  test('unreadable stage state credits nothing and is reported, not thrown', () => {
    const view = describeStagedVerificationStatus({ stagedVerification: STAGED, context: { stagedVerification: 'garbage' } });
    expect(view.state).toBe('unreadable');
    expect(view.progress).toBe('no-final-evidence');
    expect(view.stateDetail).toContain('stagedVerification');
  });

  test('recovery counters are read from the persisted streaks', () => {
    const view = describeStagedVerificationStatus({
      stagedVerification: { enabled: true, maxStageRecoveryAttempts: 5 },
      context: { stagedLoopRecovery: { streak: 2, lastOutcome: 'infrastructure' } },
    });
    expect(view.recovery).toEqual({ maxStageRecoveryAttempts: 5, finalStreak: 0, loopStreak: 2, loopLastOutcome: 'infrastructure' });
  });
});

// ---------------------------------------------------------------------------
// Human Gate summary: the public statement (§10 rule 5)
// ---------------------------------------------------------------------------

function makeSession(overrides = {}) {
  return {
    sessionId: 'sess',
    repoRoot: '/tmp/repo',
    artifactRoot: '/tmp/artifacts',
    githubOwner: 'org',
    githubName: 'repo',
    githubRepo: 'org/repo',
    verification: VERIFICATION,
    repoHostProvider: { provider: 'github' },
    workItemProvider: { provider: 'github-issues' },
    labels: {},
    ...overrides,
  };
}

const TASK = {
  sessionId: 'sess',
  issueNumber: 7,
  status: 'running',
  phase: 'review',
  context: { title: 'Staged', prUrl: 'https://github.com/org/repo/pull/42' },
};

function makeStore() {
  const entries = [];
  const add = (input) => {
    const dup = entries.some((e) => e.idempotencyKey === input.idempotencyKey);
    if (!dup) entries.push(input);
    return Promise.resolve({ enqueued: !dup });
  };
  return {
    enqueued: entries,
    enqueue: add,
    replacePendingPrSummary: add,
    listPending: () => Promise.resolve([]),
    markSent: () => Promise.resolve(),
  };
}

async function gateBody(session, context, store = makeStore(), runId = 'run-1', result = 'success', extra = {}) {
  await enqueueHumanGateSummaryEffect(
    store, session, TASK, 'review',
    { result, ...extra, context: { prUrl: 'https://github.com/org/repo/pull/42', ...context } },
    runId, '2026-09-13T10:00:00.000Z',
  );
  return store;
}

const BASE_INPUT = { issueNumber: 7, phase: 'review', phaseResult: 'success', runId: 'run-1' };

describe('Human Gate summary — final stage line', () => {
  test('without a final stage input the summary carries no final verification line', () => {
    expect(renderHumanGateSummary(BASE_INPUT)).not.toContain('Final verification');
  });

  test('the stored record projects to counts and scope only', async () => {
    const context = await finalContext();
    const projected = humanGateFinalStageOf(context.finalStageVerification);
    expect(projected).toEqual({ status: 'recorded', granted: true, outcome: 'passed', full: true, complete: true, selected: 2, passed: 2 });
    expect(humanGateFinalStageOf(undefined)).toEqual({ status: 'absent' });
    expect(humanGateFinalStageOf({ status: 'passed' })).toEqual({ status: 'absent' });
  });

  test('completed final evidence, pending verification and a withheld stage read differently', async () => {
    const context = await finalContext();
    const passed = (await gateBody(makeSession({ stagedVerification: STAGED }), context)).enqueued[0].payload.body;
    expect(passed).toContain('Final verification (full required set): ✅ passed — 2/2 checks passed, full required set; stack-ready granted.');
    expect(passed).not.toContain(OUTPUT_TOKEN);

    const pending = (await gateBody(makeSession({ stagedVerification: STAGED }), {})).enqueued[0].payload.body;
    expect(pending).toContain('Final verification (full required set): ⏳ pending');

  });

  // Review feedback (P2): the review handler completes an operator-withheld
  // final stage as `blocked` and a failing one as `needs_fix`, never `success`.
  // Those real result types must still rewrite the sticky summary.
  test('an operator-withheld final stage completing blocked publishes the withheld summary', async () => {
    const store = await gateBody(makeSession({ stagedVerification: STAGED }), {
      classification: 'blocked',
      finalStageVerification: { status: 'withheld', disposition: 'operator', reason: 'recovery-budget-exhausted' },
    }, makeStore(), 'run-withheld', 'blocked');
    expect(store.enqueued).toHaveLength(1);
    const body = store.enqueued[0].payload.body;
    expect(body).toContain('⏳ withheld (recovery-budget-exhausted)');
    expect(body).toContain('Result: blocked');
  });

  test('a failing final stage completing needs_fix publishes the failed summary', async () => {
    const store = await gateBody(makeSession({ stagedVerification: STAGED }), {
      classification: 'needs_fix',
      finalStageVerification: {
        status: 'recorded',
        row: 9,
        disposition: 'repair',
        granted: false,
        summary: { outcome: 'failed', full: true, complete: true, counts: { selected: 2, passed: 1 } },
      },
    }, makeStore(), 'run-failed', 'needs_fix');
    expect(store.enqueued).toHaveLength(1);
    const body = store.enqueued[0].payload.body;
    expect(body).toContain('Final verification (full required set): ❌ failed — 1/2 checks passed, full required set; stack-ready withheld (repair).');
    expect(body).toContain('Result: needs_fix');
  });

  // Review feedback (P2): a passed final bundle whose grant marker a later guard
  // cleared must not read as stack-ready granted.
  test('a passed final stage on a blocked completion without a live grant does not claim stack-ready', async () => {
    const context = await finalContext();
    const store = await gateBody(makeSession({ stagedVerification: STAGED }), {
      ...context,
      finalStageGrant: null,
    }, makeStore(), 'run-1', 'blocked');
    const body = store.enqueued[0].payload.body;
    expect(body).toContain('✅ passed — 2/2 checks passed, full required set; stack-ready not granted by this completion.');
    expect(body).not.toContain('stack-ready granted');

    const otherRun = (await gateBody(makeSession({ stagedVerification: STAGED }), context, makeStore(), 'run-2')).enqueued[0].payload.body;
    expect(otherRun).not.toContain('stack-ready granted');
  });

  // Review feedback (P2): the delayed release is the real pending path.
  test('a delayed final-stage release publishes a pending summary even over a passed record', async () => {
    const context = await finalContext();
    const store = await gateBody(makeSession({ stagedVerification: STAGED }), context, makeStore(), 'run-d', 'delayed', { withdrawStackReady: true });
    expect(store.enqueued).toHaveLength(1);
    const body = store.enqueued[0].payload.body;
    expect(body).toContain('Final verification (full required set): ⏳ pending — the review approval is retained');
    expect(body).not.toContain('✅ passed');
    expect(body).not.toContain('stack-ready granted');

    expect((await gateBody(makeSession({ stagedVerification: STAGED }), context, makeStore(), 'run-e', 'delayed')).enqueued).toHaveLength(0);
    expect((await gateBody(makeSession(), context, makeStore(), 'run-f', 'delayed', { withdrawStackReady: true })).enqueued).toHaveLength(0);
  });

  // Review feedback (P2): no aggregate pass is asserted for a non-success completion.
  test('a failing final stage does not report the configured commands as passed', async () => {
    const body = (await gateBody(makeSession({ stagedVerification: STAGED }), {
      finalStageVerification: {
        status: 'recorded', row: 9, disposition: 'repair', granted: false,
        summary: { outcome: 'failed', full: true, complete: true, counts: { selected: 2, passed: 1 } },
      },
    }, makeStore(), 'run-g', 'needs_fix')).enqueued[0].payload.body;
    expect(body).not.toContain('test, lint: ✅ passed');
    expect(body).not.toContain('unknown — not recorded for this phase.');
  });

  test('an unsuccessful review with no final-stage record, or without opt-in, publishes nothing', async () => {
    for (const result of ['blocked', 'needs_fix']) {
      expect((await gateBody(makeSession({ stagedVerification: STAGED }), {}, makeStore(), 'run-x', result)).enqueued).toHaveLength(0);
      expect((await gateBody(makeSession(), {
        finalStageVerification: { status: 'withheld', disposition: 'operator', reason: 'recovery-budget-exhausted' },
      }, makeStore(), 'run-y', result)).enqueued).toHaveLength(0);
    }
    expect((await gateBody(makeSession({ stagedVerification: STAGED }), {
      finalStageVerification: { status: 'withheld', disposition: 'operator', reason: 'recovery-budget-exhausted' },
    }, makeStore(), 'run-z', 'failed')).enqueued).toHaveLength(0);
  });

  test('a session that has not opted in renders no final stage line even with a record present', async () => {
    const context = await finalContext();
    const body = (await gateBody(makeSession(), context)).enqueued[0].payload.body;
    expect(body).not.toContain('Final verification');
  });

  test('a replayed completion enqueues once, and renders the same body under the same key', async () => {
    const context = await finalContext();
    const session = makeSession({ stagedVerification: STAGED });
    const store = makeStore();
    await gateBody(session, context, store);
    await gateBody(session, context, store);
    expect(store.enqueued).toHaveLength(1);

    const other = await gateBody(session, context);
    expect(other.enqueued[0].idempotencyKey).toBe(store.enqueued[0].idempotencyKey);
    expect(other.enqueued[0].payload.body).toBe(store.enqueued[0].payload.body);
  });
});
