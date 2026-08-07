/**
 * End-to-end review-dispute lifecycles (issue #849;
 * docs/review-dispute-contract.md, docs/review-dispute-operations.md).
 *
 * Every other suite in this chain pins ONE layer: the parsers, the persistence
 * writer, the transition applicator, the publication policy, the operator
 * surfaces. This one pins them **composed** — the real `runNextPhase`, the real
 * TaskStore transaction boundary, the real outbox effects, and the real admin
 * projections, driven through a whole disagreement from the finding that opened
 * it to the outcome that closed it.
 *
 * Ground rules, all of them deliberate:
 *
 *  - **No hand-built protocol state.** Every decision fed to a run is produced
 *    by the real predecessor module (#843's parser, #844's writer, #845's
 *    `decideRevision`, #846's response parser, #847's router), so no scenario
 *    here can walk a path the contract would never have produced.
 *  - **No agents, no network.** The handlers are fakes that return an
 *    already-computed application. Nothing spawns a CLI, calls GitHub or Slack,
 *    or touches the network.
 *  - **No manual SQLite edits.** Where a lifecycle cannot continue on its own,
 *    it is continued through the same supported store port `admin recover
 *    --from ready_for_human` uses, and the park it resumes from is asserted
 *    first. That park is not a defect in the test: §7.1's reviewer, evidence,
 *    and runner turns have no dispatcher in this codebase yet (contract §15 G2),
 *    so an operator continuation is what the rollout actually looks like today.
 *  - **Human escalations stop.** A scenario that escalates is complete when it
 *    parks at `ready_for_human` with the documented reason and `admin dispute
 *    status` reports no authorized action. None of them is nudged onwards.
 *
 * The shared lifecycle matrix runs against BOTH TaskStore implementations.
 * Publication, restart, maintenance-lock and CLI cases are SQLite-only, because
 * that is where those contracts exist.
 */
import { jest } from '@jest/globals';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { MemoryTaskStore, SqliteTaskStore } from '../dist/index.js';
import { SqliteOutboxStore } from '../dist/stores/sqlite-outbox-store.js';
import { SqliteMaintenanceLock } from '../dist/stores/sqlite-maintenance-lock.js';
import { runNextPhase } from '../dist/core/phase-runner.js';
import { REVIEW_DISPUTE_DEFAULT_LIMITS, ZERO_LINEAGE_COUNTERS } from '../dist/core/review-dispute.js';
import { parseFixDispositionResponse } from '../dist/core/review-fix-disposition-response.js';
import { persistFixDisputes } from '../dist/core/review-dispute-persistence.js';
import { decideRevision } from '../dist/core/review-revision-decision.js';
import { parseArbitrationResponse } from '../dist/core/review-arbitration-response.js';
import { arbitrationRunKey } from '../dist/core/review-arbitration-prompt.js';
import { routeArbitrationOutcome } from '../dist/core/review-arbitration-route.js';
import { applyDisputeTransition } from '../dist/core/review-dispute-transition.js';
import {
  REVIEW_DISPUTE_CONTEXT_KEY,
  REVIEW_DISPUTE_TRANSITION_EVENT,
} from '../dist/core/review-dispute-commit.js';
import { summarizeDisputeStatus } from '../dist/core/review-dispute-status.js';
import { aggregateDisputeMetrics } from '../dist/core/review-dispute-metrics.js';

// Several cases spawn the real admin CLI; the rest open SQLite files. Jest's 5s
// default is a coin flip for either under a parallel run.
jest.setTimeout(60_000);

const CLI = new URL('../dist/cli/admin.js', import.meta.url).pathname;
const SESSION = 'e2e-session';
const ISSUE = 849;
const KEY = { sessionId: SESSION, issueNumber: ISSUE };
const LINEAGE_A = 'ln-aaaaaaaaaaaa';
const LINEAGE_B = 'ln-bbbbbbbbbbbb';
const BOUNDARY = 'src/auth/handler.ts';
const ARGUMENT = 'The null session is already rejected by the middleware, so the cited crash cannot occur.';
const RATIONALE = 'RATIONALE-ONLY-TOKEN: the rebuttal misreads the acceptance criterion.';
const NOW = '2026-08-06T12:00:00.000Z';
const PR_URL = 'https://github.com/org/repo/pull/42';

const REVIEWER_META = {
  agentId: 'codex',
  model: 'gpt-5-codex',
  effort: 'high',
  reviewRunId: 'run-review-1',
  timestamp: '2026-08-06T10:00:00.000Z',
};

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
  reviewDispute: { enabled: true },
};

// ---------------------------------------------------------------------------
// Protocol fixtures — the same shapes the predecessor suites use
// ---------------------------------------------------------------------------

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

function context(lineages, overrides = {}) {
  return { version: 1, reviewStructure: 'structured', lineages, ...overrides };
}

function fixedRecord(id, version = 1) {
  return { lineageId: id, version, disposition: 'fixed', note: 'Added the null guard.' };
}

function blockedRecord(id, version = 1) {
  return { lineageId: id, version, disposition: 'blocked', note: 'Needs a credential automation cannot supply.' };
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
      evidenceRefs: [{ kind: 'file', path: BOUNDARY, startLine: 30, endLine: 36 }],
      whyNoChange: 'A second guard would duplicate the existing one without changing behavior.',
    },
  };
}

/** The #837 prompt view of every lineage still awaiting a disposition. */
function promptFindings(ctx) {
  return Object.values(ctx.lineages)
    .filter((l) => l.state === 'open' || l.state === 'binding')
    .map((l) => ({
      lineageId: l.lineageId,
      version: l.version,
      state: l.state,
      severity: l.severity,
      affectedBoundary: l.affectedBoundary,
      allowedDispositions: l.state === 'binding' ? ['fixed', 'blocked'] : ['fixed', 'review_disputed', 'blocked'],
    }));
}

function findingBody(overrides = {}) {
  return {
    version: 1,
    severity: 'P1',
    violatedContract: 'Acceptance criterion 3: the retry cursor must rewind inside the CAS transaction.',
    preconditions: 'A retry arrives after the forward cursor advanced past the retried entry.',
    failureScenario: 'retryEntry leaves the cursor ahead, so the retried row is never rescanned.',
    affectedBoundary: BOUNDARY,
    requiredOutcome: 'The cursor rewinds to the retried entry before the transaction commits.',
    evidenceRefs: [{ kind: 'file', path: BOUNDARY, startLine: 10, endLine: 20 }],
    ...overrides,
  };
}

function recordedVersion(id, overrides = {}) {
  return { ...findingBody(overrides), lineageId: id, humanGate: false, reviewerMeta: REVIEWER_META };
}

function revisionRecord({ successor = {}, ...overrides } = {}) {
  return {
    predecessorVersion: 1,
    changedFields: ['preconditions'],
    revisionKind: 'corrected_premise',
    materialityClaim: true,
    successor: findingBody({ version: 2, ...successor }),
    ...overrides,
  };
}

/** §5 material: the successor's `preconditions` genuinely differ. */
const MATERIAL_REVISION = revisionRecord({
  successor: { preconditions: 'A retry arrives while the bulk cursor is mid-scan and the forward cursor is absent.' },
});
/** §5 never-material: the same sentence, reordered. */
const REWORDED_REVISION = revisionRecord({
  changedFields: ['failureScenario'],
  successor: { failureScenario: 'So the retried row is never rescanned: retryEntry leaves the cursor ahead.' },
});
/** §5 undecidable: a genuine rewrite the structural check cannot classify. */
const AMBIGUOUS_REVISION = revisionRecord({
  changedFields: ['failureScenario'],
  successor: { failureScenario: 'The scan skips an entry whose visibility window closed mid-transaction.' },
});

// --- #846/#847 arbitration fixtures ----------------------------------------

function profileSummary() {
  return {
    agentId: 'gemini',
    provider: 'google',
    model: 'gemini-3-pro',
    effort: 'high',
    toolPolicy: 'no-tools',
    candidateIndex: 0,
    minConfidence: 0.7,
    sameProviderFallback: false,
    sharedProviderWith: [],
  };
}

function invocationSummary({ lineageId, version, runId, ...overrides }) {
  return {
    lineageId,
    version,
    runKey: arbitrationRunKey({ lineageId, version, runId }),
    bundleDigest: 'f'.repeat(64),
    promptBytes: 4096,
    bundleEntries: 5,
    rawOutputBytes: 512,
    bundleArtifact: `arbitration-bundle-${lineageId}.json`,
    rawArtifact: `arbitration-raw-${lineageId}.txt`,
    stderrArtifact: null,
    runnerErrorArtifact: null,
    verdictArtifact: `arbitration-${lineageId}.json`,
    excerpts: 2,
    unresolvedExcerpts: 0,
    exitCode: 0,
    durationMs: 1200,
    profile: profileSummary(),
    verdict: null,
    failure: null,
    ...overrides,
  };
}

function invocationOk(target, { verdict, confidence, runId = 'run-arb-1', minConfidence = 0.7 }) {
  const record = { lineageId: target.lineageId, version: target.version, verdict, confidence, rationale: RATIONALE };
  const parsed = parseArbitrationResponse({
    response: ['Here is my judgement.', '', '```json', JSON.stringify(record, null, 2), '```', ''].join('\n'),
    pending: { lineageId: target.lineageId, version: target.version },
    lineages: { [target.lineageId]: target },
    minConfidence,
  });
  if (parsed.admitted === null) throw new Error(`fixture not admitted: ${JSON.stringify(parsed.failure)}`);
  return {
    ok: true,
    admitted: parsed.admitted,
    confidence: parsed.confidence,
    bundle: { entries: [] },
    artifacts: [],
    summary: invocationSummary({
      lineageId: target.lineageId,
      version: target.version,
      runId,
      verdict: parsed.summary,
    }),
  };
}

function invocationFailed(target, { kind, detail = null, runId = 'run-arb-1' }) {
  return {
    ok: false,
    failure: { kind, detail },
    bundle: null,
    artifacts: [],
    summary: invocationSummary({ lineageId: target.lineageId, version: target.version, runId, failure: { kind, detail } }),
  };
}

// ---------------------------------------------------------------------------
// Decisions — each one is a typed predecessor output, never a hand-built row
// ---------------------------------------------------------------------------

/**
 * `current` is the block the decision is APPLIED to, which is not always the
 * block it was computed from: a retried worker re-reads a block its own first
 * delivery already moved, and that is exactly how the transition layer
 * recognizes the redelivery as a replay. `findings` is the prompt view the run
 * was given, which likewise does not change under it.
 */
function dispositionsDecision(
  ctx,
  records,
  { diff = false, runId, limits = REVIEW_DISPUTE_DEFAULT_LIMITS, current = ctx, findings } = {},
) {
  const outcome = parseFixDispositionResponse({
    response: `\`\`\`json\n${JSON.stringify(records)}\n\`\`\``,
    findings: findings ?? promptFindings(ctx),
    lineages: ctx.lineages,
    reviewStructure: ctx.reviewStructure,
    runProducedFileChanges: diff,
    resolveEvidenceRef: () => true,
    limits,
  });
  const persisted = persistFixDisputes({
    context: current,
    outcome,
    run: { runId, agentId: 'claude', timestamp: NOW },
    runProducedFileChanges: diff,
    limits,
  });
  if (!persisted.ok) throw new Error(`fixture not persisted: ${JSON.stringify(persisted.failure)}`);
  return { kind: 'dispositions', persistence: persisted.value, outcome, runProducedFileChanges: diff };
}

function reconsiderationDecision(ctx, id, kind, { revision, limits } = {}) {
  const record = {
    lineageId: id,
    version: ctx.lineages[id].version,
    reconsideration: kind,
    rationale: 'The premise was wrong; the corrected one still shows the defect.',
    ...(revision === undefined ? {} : { revision }),
  };
  const admitted = { record, lineage: ctx.lineages[id] };
  if (kind !== 'revise') return { kind: 'reconsideration', admitted };
  return {
    kind: 'reconsideration',
    admitted,
    revision: decideRevision({
      admitted,
      versions: [recordedVersion(id)],
      ...(limits === undefined ? {} : { limits }),
    }),
  };
}

function arbitrationDecision(ctx, id, outcome, { limits } = {}) {
  const target = ctx.lineages[id];
  return {
    kind: 'arbitration',
    decision: routeArbitrationOutcome({
      lineage: target,
      version: target.version,
      outcome,
      ...(limits === undefined ? {} : { limits }),
    }),
  };
}

function verdictDecision(ctx, id, options) {
  return arbitrationDecision(ctx, id, { kind: 'invocation', result: invocationOk(ctx.lineages[id], options) }, options);
}

function malformedDecision(ctx, id, options = {}) {
  return arbitrationDecision(
    ctx,
    id,
    { kind: 'invocation', result: invocationFailed(ctx.lineages[id], { kind: 'malformed-response', ...options }) },
    options,
  );
}

function unavailableArbiterDecision(ctx, id, runId = 'run-arb-1') {
  return arbitrationDecision(ctx, id, {
    kind: 'profile',
    resolution: {
      kind: 'human_handoff',
      lineageId: id,
      reason: 'no-acceptable-candidate',
      row: 19,
      rejections: [{ index: 0, candidate: 'claude', reason: 'same-provider-not-allowed', detail: 'implementation' }],
    },
    run: { runId },
  });
}

// ---------------------------------------------------------------------------
// The driver
// ---------------------------------------------------------------------------

/**
 * One phase run.
 *
 * Reads the task's CURRENT phase and CURRENT §10.1 block, asks the caller for a
 * decision against that block, applies it with the real transition layer, and
 * hands the result to `runNextPhase` exactly as a phase handler would. Nothing
 * about the task is written by this function: `runNextPhase` owns every write.
 */
async function step(h, { decide, runId, actor = 'implementer', handlerContext = {}, limits } = {}) {
  const before = await h.store.getTask(KEY);
  if (!before) throw new Error('no task to run');
  const ctx = before.context[REVIEW_DISPUTE_CONTEXT_KEY];
  let application;
  if (decide) {
    const decision = decide(ctx);
    const result = applyDisputeTransition({
      context: ctx,
      decision,
      run: { runId, actor },
      ...(limits === undefined ? {} : { limits }),
    });
    if (!result.ok) throw new Error(`transition refused: ${JSON.stringify(result.failure)}`);
    application = result.value;
  }
  const outcome = await runNextPhase({
    store: h.store,
    request: {
      sessionId: SESSION,
      workerId: 'w',
      runId,
      supportedPhases: [before.phase],
      now: NOW,
    },
    handlers: {
      [before.phase]: async () => ({
        result: 'success',
        context: { branch: 'ai/issue-849', ...handlerContext },
        ...(application ? { disputeTransition: application } : {}),
      }),
    },
    ...(h.outboxStore ? { outboxStore: h.outboxStore } : {}),
    ...(h.session ? { session: h.session } : {}),
    now: NOW,
  });
  return { outcome, application, task: await h.store.getTask(KEY) };
}

/**
 * Continue a task the runner parked because §7.1 named a turn it cannot
 * dispatch (contract §15 G2).
 *
 * This is the SUPPORTED operator path — the same store port `admin recover
 * --from ready_for_human --phase <p>` calls — not a hand edit. Callers assert
 * the park and its reason BEFORE resuming, so a scenario can never silently
 * paper over a stop that should have ended it.
 */
async function resume(h, phase) {
  const before = await h.store.getTask(KEY);
  expect(before.status).toBe('ready_for_human');
  const result = await h.store.recoverHandoff(KEY, { fromStatus: 'ready_for_human', phase, now: NOW });
  expect(result.ok).toBe(true);
  return result.value;
}

function blockOf(task) {
  return task.context[REVIEW_DISPUTE_CONTEXT_KEY];
}

async function transitionEvents(h) {
  const events = await h.store.listEvents(KEY);
  return events.filter((e) => e.type === REVIEW_DISPUTE_TRANSITION_EVENT);
}

const BACKENDS = [
  {
    name: 'MemoryTaskStore',
    create: () => ({ store: new MemoryTaskStore(), cleanup: () => {} }),
  },
  {
    name: 'SqliteTaskStore',
    create: () => {
      const dir = mkdtempSync(join(tmpdir(), 'dispute-e2e-'));
      const store = new SqliteTaskStore(join(dir, 'test.db'));
      return {
        store,
        cleanup: () => {
          store.close();
          rmSync(dir, { recursive: true, force: true });
        },
      };
    },
  },
];

// ===========================================================================
// 1. The lifecycle matrix — both stores
// ===========================================================================

describe.each(BACKENDS)('review-dispute lifecycles ($name)', ({ create }) => {
  let h;

  beforeEach(() => {
    const created = create();
    h = { store: created.store, cleanup: created.cleanup };
  });

  afterEach(() => {
    h.cleanup();
  });

  async function enqueue(ctx, extraContext = {}) {
    await h.store.enqueueTask({
      sessionId: SESSION,
      issueNumber: ISSUE,
      phase: 'implementation',
      priority: 'normal',
      context: {
        ...(ctx === undefined ? {} : { [REVIEW_DISPUTE_CONTEXT_KEY]: ctx }),
        ...extraContext,
      },
      now: '2026-08-06T11:00:00.000Z',
    });
  }

  /** The shared opening move: the implementer disputes the only finding. */
  async function openDispute() {
    const ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A) });
    await enqueue(ctx);
    const { task } = await step(h, {
      runId: 'run-impl-1',
      decide: (c) => dispositionsDecision(c, [disputeRecord(LINEAGE_A)], { runId: 'run-impl-1' }),
    });
    expect(blockOf(task).lineages[LINEAGE_A].state).toBe('disputed');
    // §7.1 rule 2 names the reviewer turn; this codebase cannot dispatch it, so
    // the task parks rather than handing a `disputed` lineage to a run that
    // could not discharge it.
    expect(task.status).toBe('ready_for_human');
    return task;
  }

  // --- scenario 1 ---------------------------------------------------------

  test('dispute → reviewer withdrawal resolves the lineage as resolved_withdrawn', async () => {
    await openDispute();
    await resume(h, 'review');

    const { task } = await step(h, {
      runId: 'run-review-2',
      actor: 'reviewer',
      decide: (c) => reconsiderationDecision(c, LINEAGE_A, 'withdraw'),
    });

    const l = blockOf(task).lineages[LINEAGE_A];
    expect(l.state).toBe('resolved_withdrawn');
    expect(l.outcome).toBe('resolved_withdrawn');
    expect(l.counters).toMatchObject({ rebuttals: 1, reconsiderations: 1, arbitrationPasses: 0 });
    // §7.1 rule 4: a fully structured review that produced no diff resolves
    // without changes rather than looping back for another fix run.
    expect(blockOf(task).resolvedWithoutChanges).toBe(true);

    const events = await transitionEvents(h);
    expect(events).toHaveLength(2);
    expect(events[1].data.auditEvents).toEqual(['dispute.resolved']);
    expect(events[1].data.routing).toMatchObject({ rule: 4, outcome: 'resolved_without_changes' });
    // The whole disagreement closed with no human in it.
    const metrics = aggregateDisputeMetrics({
      sessionId: SESSION,
      tasks: [{ issueNumber: ISSUE, events: await h.store.listEvents(KEY) }],
    });
    expect(metrics.terminalOutcomes.resolved_withdrawn).toBe(1);
    expect(metrics.humanEscalations).toBe(0);
    expect(metrics.lineagesResolvedWithoutHuman).toBe(1);
  });

  // --- scenario 2 ---------------------------------------------------------

  test('dispute → uphold → reviewer_correct makes the finding binding, then fixed and re-reviewed', async () => {
    await openDispute();
    await resume(h, 'review');

    const upheld = await step(h, {
      runId: 'run-review-2',
      actor: 'reviewer',
      decide: (c) => reconsiderationDecision(c, LINEAGE_A, 'uphold'),
    });
    expect(blockOf(upheld.task).lineages[LINEAGE_A].state).toBe('arbitration_pending');
    // The runner turn advances arbitration; it too has no dispatcher yet.
    expect(upheld.task.status).toBe('ready_for_human');

    await resume(h, 'review');
    const arbitrated = await step(h, {
      runId: 'run-arb-3',
      actor: 'arbiter',
      decide: (c) => verdictDecision(c, LINEAGE_A, { verdict: 'reviewer_correct', confidence: 0.92, runId: 'run-arb-3' }),
    });
    const bound = blockOf(arbitrated.task).lineages[LINEAGE_A];
    expect(bound.state).toBe('binding');
    expect(bound.counters.arbitrationPasses).toBe(1);
    // §11: `binding` is not a resolution. Routing hands the finding back to the
    // implementer for its one final response.
    expect(arbitrated.task.status).toBe('queued');
    expect(arbitrated.task.phase).toBe('implementation');

    const fixed = await step(h, {
      runId: 'run-impl-4',
      decide: (c) => dispositionsDecision(c, [fixedRecord(LINEAGE_A)], { diff: true, runId: 'run-impl-4' }),
    });
    expect(blockOf(fixed.task).lineages[LINEAGE_A].state).toBe('resolved_fixed');
    // Rule 3: every lineage terminal, an unreviewed diff on the branch.
    expect(fixed.task.status).toBe('queued');
    expect(fixed.task.phase).toBe('review');

    const metrics = aggregateDisputeMetrics({
      sessionId: SESSION,
      tasks: [{ issueNumber: ISSUE, events: await h.store.listEvents(KEY) }],
    });
    expect(metrics.arbitration).toEqual({ verdicts: 1, malformedAttempts: 0 });
    expect(metrics.terminalOutcomes.resolved_fixed).toBe(1);
    expect(metrics.humanEscalations).toBe(0);
  });

  // --- scenario 3 ---------------------------------------------------------

  test('dispute → uphold → implementer_correct overrules the finding', async () => {
    await openDispute();
    await resume(h, 'review');
    await step(h, {
      runId: 'run-review-2',
      actor: 'reviewer',
      decide: (c) => reconsiderationDecision(c, LINEAGE_A, 'uphold'),
    });
    await resume(h, 'review');
    const { task } = await step(h, {
      runId: 'run-arb-3',
      actor: 'arbiter',
      decide: (c) => verdictDecision(c, LINEAGE_A, { verdict: 'implementer_correct', confidence: 0.88, runId: 'run-arb-3' }),
    });

    const l = blockOf(task).lineages[LINEAGE_A];
    expect(l.state).toBe('resolved_overruled');
    expect(l.outcome).toBe('resolved_overruled');
    // §6.1: nothing exceeded a cap on the way here.
    expect(l.counters).toEqual({
      rebuttals: 1,
      reconsiderations: 1,
      arbitrationPasses: 1,
      malformedArbiterAttempts: 0,
      evidenceRoundsUsed: 0,
    });
    expect(l.version).toBe(1);
  });

  // --- scenario 4 ---------------------------------------------------------

  test('a material revision admits version 2 and grants exactly one final implementation response', async () => {
    await openDispute();
    await resume(h, 'review');

    const revised = await step(h, {
      runId: 'run-review-2',
      actor: 'reviewer',
      decide: (c) => reconsiderationDecision(c, LINEAGE_A, 'revise', { revision: MATERIAL_REVISION }),
    });
    const v2 = blockOf(revised.task).lineages[LINEAGE_A];
    expect(v2.version).toBe(2);
    expect(v2.state).toBe('open');
    // Row 11 has a dispatcher: the implementer's final response.
    expect(revised.task.status).toBe('queued');
    expect(revised.task.phase).toBe('implementation');

    const fixed = await step(h, {
      runId: 'run-impl-3',
      decide: (c) => dispositionsDecision(c, [fixedRecord(LINEAGE_A, 2)], { diff: true, runId: 'run-impl-3' }),
    });
    expect(blockOf(fixed.task).lineages[LINEAGE_A].state).toBe('resolved_fixed');
    expect(blockOf(fixed.task).lineages[LINEAGE_A].version).toBe(2);
    expect(blockOf(fixed.task).lineages[LINEAGE_A].counters.reconsiderations).toBe(1);
  });

  test('a version-2 dispute goes straight to arbitration — there is no second reconsideration', async () => {
    await openDispute();
    await resume(h, 'review');
    await step(h, {
      runId: 'run-review-2',
      actor: 'reviewer',
      decide: (c) => reconsiderationDecision(c, LINEAGE_A, 'revise', { revision: MATERIAL_REVISION }),
    });

    const { task } = await step(h, {
      runId: 'run-impl-3',
      decide: (c) => dispositionsDecision(c, [disputeRecord(LINEAGE_A, 2)], { runId: 'run-impl-3' }),
    });
    const l = blockOf(task).lineages[LINEAGE_A];
    expect(l.state).toBe('arbitration_pending');
    expect(l.counters.reconsiderations).toBe(1);
    expect(l.counters.rebuttals).toBe(2);
    const events = await transitionEvents(h);
    expect(events[events.length - 1].data.applied[0].reason).toBe('dispute-final-version');
  });

  // --- scenario 5 ---------------------------------------------------------

  test.each([
    ['non-material', REWORDED_REVISION, 'dispute.revision.non_material'],
    ['ambiguous', AMBIGUOUS_REVISION, 'dispute.revision.ambiguous'],
  ])('a %s revision arbitrates without admitting the candidate version', async (_name, revision, auditEvent) => {
    await openDispute();
    await resume(h, 'review');

    const { task } = await step(h, {
      runId: 'run-review-2',
      actor: 'reviewer',
      decide: (c) => reconsiderationDecision(c, LINEAGE_A, 'revise', { revision }),
    });
    const l = blockOf(task).lineages[LINEAGE_A];
    expect(l.state).toBe('arbitration_pending');
    // §4.2: the candidate travels to the arbiter but is never persisted.
    expect(l.version).toBe(1);
    expect(l.affectedBoundary).toBe(BOUNDARY);
    const events = await transitionEvents(h);
    expect(events[events.length - 1].data.applied[0]).toMatchObject({ row: 12, auditEvent, versionAfter: 1 });
    expect(task.status).toBe('ready_for_human');
  });

  // --- scenario 6 ---------------------------------------------------------

  test('one bounded evidence round, then a decisive verdict', async () => {
    await openDispute();
    await resume(h, 'review');
    await step(h, {
      runId: 'run-review-2',
      actor: 'reviewer',
      decide: (c) => reconsiderationDecision(c, LINEAGE_A, 'uphold'),
    });

    await resume(h, 'review');
    const requested = await step(h, {
      runId: 'run-arb-3',
      actor: 'arbiter',
      decide: (c) =>
        verdictDecision(c, LINEAGE_A, { verdict: 'insufficient_evidence', confidence: 0.8, runId: 'run-arb-3' }),
    });
    expect(blockOf(requested.task).lineages[LINEAGE_A].state).toBe('evidence_requested');
    expect(requested.task.status).toBe('ready_for_human');

    await resume(h, 'review');
    const collected = await step(h, {
      runId: 'run-evidence-4',
      actor: 'runner',
      decide: () => ({ kind: 'evidence_round', lineageId: LINEAGE_A, version: 1, attachmentsRecorded: 2 }),
    });
    const afterRound = blockOf(collected.task).lineages[LINEAGE_A];
    expect(afterRound.state).toBe('arbitration_pending');
    expect(afterRound.counters.evidenceRoundsUsed).toBe(1);

    await resume(h, 'review');
    const decided = await step(h, {
      runId: 'run-arb-5',
      actor: 'arbiter',
      decide: (c) => verdictDecision(c, LINEAGE_A, { verdict: 'reviewer_correct', confidence: 0.95, runId: 'run-arb-5' }),
    });
    expect(blockOf(decided.task).lineages[LINEAGE_A].state).toBe('binding');
    // §6.1: one round is the whole budget, and it is spent.
    expect(blockOf(decided.task).lineages[LINEAGE_A].counters.evidenceRoundsUsed)
      .toBe(REVIEW_DISPUTE_DEFAULT_LIMITS.maxEvidenceRoundsPerLineage);
  });

  test('a second insufficient_evidence with the round spent escalates instead of asking again', async () => {
    await openDispute();
    await resume(h, 'review');
    await step(h, {
      runId: 'run-review-2',
      actor: 'reviewer',
      decide: (c) => reconsiderationDecision(c, LINEAGE_A, 'uphold'),
    });
    await resume(h, 'review');
    await step(h, {
      runId: 'run-arb-3',
      actor: 'arbiter',
      decide: (c) => verdictDecision(c, LINEAGE_A, { verdict: 'insufficient_evidence', confidence: 0.8, runId: 'run-arb-3' }),
    });
    await resume(h, 'review');
    await step(h, {
      runId: 'run-evidence-4',
      actor: 'runner',
      decide: () => ({ kind: 'evidence_round', lineageId: LINEAGE_A, version: 1, attachmentsRecorded: 0 }),
    });
    await resume(h, 'review');
    const { task } = await step(h, {
      runId: 'run-arb-5',
      actor: 'arbiter',
      decide: (c) => verdictDecision(c, LINEAGE_A, { verdict: 'insufficient_evidence', confidence: 0.8, runId: 'run-arb-5' }),
    });

    const l = blockOf(task).lineages[LINEAGE_A];
    expect(l.state).toBe('escalated_human');
    expect(l.counters.evidenceRoundsUsed).toBe(1);
    expect(task.status).toBe('ready_for_human');
    const summary = summarizeDisputeStatus(task, await h.store.listEvents(KEY));
    expect(summary.nextAction.authorized).toBe(false);
    expect(summary.nextAction.reason).toBe('lineage_escalated_human');
  });

  // --- scenario 7: every documented stop ----------------------------------

  describe('human escalation stops deterministically', () => {
    /** Drive the shared prefix up to a pending arbitration turn. */
    async function untilArbitration() {
      await openDispute();
      await resume(h, 'review');
      await step(h, {
        runId: 'run-review-2',
        actor: 'reviewer',
        decide: (c) => reconsiderationDecision(c, LINEAGE_A, 'uphold'),
      });
      await resume(h, 'review');
    }

    async function expectParked(task, { state, reason }) {
      expect(blockOf(task).lineages[LINEAGE_A].state).toBe(state);
      expect(task.status).toBe('ready_for_human');
      const summary = summarizeDisputeStatus(task, await h.store.listEvents(KEY));
      expect(summary.nextAction.authorized).toBe(false);
      expect(summary.nextAction.reason).toBe(reason);
      // Nothing about the stop invites automation to continue.
      expect(summary.nextAction.description.length).toBeGreaterThan(0);
    }

    test('spec_ambiguous escalates whatever its confidence', async () => {
      await untilArbitration();
      const { task } = await step(h, {
        runId: 'run-arb-3',
        actor: 'arbiter',
        decide: (c) => verdictDecision(c, LINEAGE_A, { verdict: 'spec_ambiguous', confidence: 0.99, runId: 'run-arb-3' }),
      });
      await expectParked(task, { state: 'escalated_human', reason: 'lineage_escalated_human' });
      const events = await transitionEvents(h);
      expect(events[events.length - 1].data.applied[0].reason).toBe('spec-ambiguous');
    });

    test('a decisive verdict below the confidence threshold decides nothing', async () => {
      await untilArbitration();
      const { task } = await step(h, {
        runId: 'run-arb-3',
        actor: 'arbiter',
        decide: (c) =>
          verdictDecision(c, LINEAGE_A, { verdict: 'reviewer_correct', confidence: 0.4, runId: 'run-arb-3' }),
      });
      await expectParked(task, { state: 'escalated_human', reason: 'lineage_escalated_human' });
      const events = await transitionEvents(h);
      expect(events[events.length - 1].data.applied[0].reason).toBe('low-confidence-verdict');
    });

    test('no acceptable independent arbiter escalates and spends no counter', async () => {
      await untilArbitration();
      const before = blockOf(await h.store.getTask(KEY)).lineages[LINEAGE_A].counters;
      const { task } = await step(h, {
        runId: 'run-arb-3',
        actor: 'arbiter',
        decide: (c) => unavailableArbiterDecision(c, LINEAGE_A, 'run-arb-3'),
      });
      await expectParked(task, { state: 'escalated_human', reason: 'lineage_escalated_human' });
      expect(blockOf(task).lineages[LINEAGE_A].counters).toEqual(before);
    });

    test('a below-cap malformed arbiter answer retries; the cap-reaching one escalates', async () => {
      await untilArbitration();
      const first = await step(h, {
        runId: 'run-arb-3',
        actor: 'arbiter',
        decide: (c) => malformedDecision(c, LINEAGE_A, { runId: 'run-arb-3' }),
      });
      const afterFirst = blockOf(first.task).lineages[LINEAGE_A];
      expect(afterFirst.state).toBe('arbitration_pending');
      expect(afterFirst.counters.malformedArbiterAttempts).toBe(1);
      expect(afterFirst.counters.arbitrationPasses).toBe(0);

      await resume(h, 'review');
      // A DIFFERENT run id: the retry is a new turn, not a re-delivery of the
      // first (the transition key is deliberately row-free).
      const second = await step(h, {
        runId: 'run-arb-4',
        actor: 'arbiter',
        decide: (c) => malformedDecision(c, LINEAGE_A, { runId: 'run-arb-4' }),
      });
      const afterSecond = blockOf(second.task).lineages[LINEAGE_A];
      expect(afterSecond.counters.malformedArbiterAttempts)
        .toBe(REVIEW_DISPUTE_DEFAULT_LIMITS.maxMalformedArbiterAttemptsPerLineage);
      await expectParked(second.task, { state: 'escalated_human', reason: 'lineage_escalated_human' });
      const events = await transitionEvents(h);
      expect(events[events.length - 1].data.applied[0].reason).toBe('malformed-arbiter-cap-reached');
    });

    test('a human-gated finding escalates at dispute admission, before any debate', async () => {
      const ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A, { humanGate: true }) });
      await enqueue(ctx);
      const { task } = await step(h, {
        runId: 'run-impl-1',
        decide: (c) => dispositionsDecision(c, [disputeRecord(LINEAGE_A)], { runId: 'run-impl-1' }),
      });
      await expectParked(task, { state: 'escalated_human', reason: 'lineage_escalated_human' });
      const l = blockOf(task).lineages[LINEAGE_A];
      // The gate escalates AT admission: no reconsideration, no arbitration.
      expect(l.counters.reconsiderations).toBe(0);
      expect(l.counters.arbitrationPasses).toBe(0);
    });

    test('a `blocked` disposition parks the task with the lineage escalated', async () => {
      const ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A) });
      await enqueue(ctx);
      const { task } = await step(h, {
        runId: 'run-impl-1',
        decide: (c) => dispositionsDecision(c, [blockedRecord(LINEAGE_A)], { diff: true, runId: 'run-impl-1' }),
      });
      await expectParked(task, { state: 'escalated_human', reason: 'lineage_escalated_human' });
    });

    test('an undispatchable turn is reported as its own stop reason, not as an escalation', async () => {
      const task = await openDispute();
      const summary = summarizeDisputeStatus(task, await h.store.listEvents(KEY));
      expect(blockOf(task).lineages[LINEAGE_A].state).toBe('disputed');
      expect(summary.routing.undispatchedTurn).toBe('reviewer');
      expect(summary.nextAction.authorized).toBe(false);
      expect(summary.nextAction.reason).toBe('undispatched_turn');
    });
  });

  // --- scenario 8: legacy / mixed / structured ----------------------------

  describe('§13 review-structure compatibility', () => {
    test('a legacy free-form review keeps its behavior exactly', async () => {
      await enqueue(undefined, { reviewFeedback: 'Please fix the null guard.' });
      const { task, outcome } = await step(h, { runId: 'run-impl-1' });
      expect(outcome.status).toBe('completed');
      expect(task.context[REVIEW_DISPUTE_CONTEXT_KEY]).toBeUndefined();
      expect(task.context.reviewFeedback).toBe('Please fix the null guard.');
      expect(task.phase).toBe('review');
      expect(await transitionEvents(h)).toHaveLength(0);
    });

    test('a mixed review keeps its prose and its legacy blocking force', async () => {
      const ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A) }, { reviewStructure: 'mixed' });
      await enqueue(ctx, { reviewFeedback: 'Also: the retry path is untested.' });
      // §3.4 + §13: the free-form half is not discharged by the structured
      // lineage, so this run may NOT end with zero file changes.
      const outcome = parseFixDispositionResponse({
        response: `\`\`\`json\n${JSON.stringify([disputeRecord(LINEAGE_A)])}\n\`\`\``,
        findings: promptFindings(ctx),
        lineages: ctx.lineages,
        reviewStructure: 'mixed',
        runProducedFileChanges: false,
        resolveEvidenceRef: () => true,
        limits: REVIEW_DISPUTE_DEFAULT_LIMITS,
      });
      expect(outcome.zeroChangeAdmissible).toBe(false);

      const { task } = await step(h, {
        runId: 'run-impl-1',
        decide: (c) => dispositionsDecision(c, [fixedRecord(LINEAGE_A)], { diff: true, runId: 'run-impl-1' }),
      });
      expect(blockOf(task).lineages[LINEAGE_A].state).toBe('resolved_fixed');
      // The mode survives the transition, and so does the legacy payload.
      expect(blockOf(task).reviewStructure).toBe('mixed');
      expect(task.context.reviewFeedback).toBe('Also: the retry path is untested.');
      // Rule 4 never fires for a mixed review: the accumulated diff goes back
      // to review rather than being declared resolved without changes.
      expect(blockOf(task).resolvedWithoutChanges).toBeUndefined();
    });

    test('a fully structured review may complete a dispute run with zero file changes', async () => {
      const ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A) });
      const outcome = parseFixDispositionResponse({
        response: `\`\`\`json\n${JSON.stringify([disputeRecord(LINEAGE_A)])}\n\`\`\``,
        findings: promptFindings(ctx),
        lineages: ctx.lineages,
        reviewStructure: 'structured',
        runProducedFileChanges: false,
        resolveEvidenceRef: () => true,
        limits: REVIEW_DISPUTE_DEFAULT_LIMITS,
      });
      // The contract decision that lets an evidence-backed dispute complete
      // without edits (§3.4).
      expect(outcome.zeroChangeAdmissible).toBe(true);

      await enqueue(ctx);
      const { task, outcome: runOutcome } = await step(h, {
        runId: 'run-impl-1',
        decide: (c) => dispositionsDecision(c, [disputeRecord(LINEAGE_A)], { runId: 'run-impl-1' }),
      });
      expect(runOutcome.status).toBe('completed');
      expect(blockOf(task).lineages[LINEAGE_A].state).toBe('disputed');
      expect(blockOf(task).reviewStructure).toBe('structured');
    });
  });

  // --- scenario 10: retry, duplicates, CAS --------------------------------

  describe('delivery hazards', () => {
    test('re-delivering the identical decision applies nothing twice', async () => {
      const ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A) });
      const findings = promptFindings(ctx);
      await enqueue(ctx);
      const first = await step(h, {
        runId: 'run-impl-1',
        decide: (c) => dispositionsDecision(c, [disputeRecord(LINEAGE_A)], { runId: 'run-impl-1' }),
      });
      const firstBlock = blockOf(first.task);

      await resume(h, 'implementation');
      // The same run delivering again, exactly as a retried worker does it: it
      // re-reads the block its own first delivery moved and re-computes the
      // decision against it, so the transition ledger recognizes its own digest.
      const second = await step(h, {
        runId: 'run-impl-1',
        decide: (c) =>
          dispositionsDecision(ctx, [disputeRecord(LINEAGE_A)], { runId: 'run-impl-1', current: c, findings }),
      });
      expect(second.application.replayed).toBe(true);
      expect(second.outcome.status).toBe('completed');

      const task = second.task;
      expect(blockOf(task)).toEqual(firstBlock);
      // The retry re-parks the task identically rather than slipping past the
      // reviewer turn this time.
      expect(task.status).toBe('ready_for_human');
      // One transition event, not two: the replay short-circuits the write.
      expect(await transitionEvents(h)).toHaveLength(1);
      const metrics = aggregateDisputeMetrics({
        sessionId: SESSION,
        tasks: [{ issueNumber: ISSUE, events: await h.store.listEvents(KEY) }],
      });
      expect(metrics.rebuttalsRecorded).toBe(1);
    });

    test('a lost claim commits neither the protocol block nor its audit event', async () => {
      const ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A) });
      await enqueue(ctx);
      const before = await h.store.getTask(KEY);
      const decision = dispositionsDecision(before.context[REVIEW_DISPUTE_CONTEXT_KEY], [fixedRecord(LINEAGE_A)], {
        diff: true,
        runId: 'run-impl-1',
      });
      const application = applyDisputeTransition({
        context: before.context[REVIEW_DISPUTE_CONTEXT_KEY],
        decision,
        run: { runId: 'run-impl-1', actor: 'implementer' },
      });
      expect(application.ok).toBe(true);

      const outcome = await runNextPhase({
        store: h.store,
        request: { sessionId: SESSION, workerId: 'w', runId: 'run-impl-1', supportedPhases: ['implementation'], now: NOW },
        handlers: {
          implementation: async () => {
            // Someone else takes the claim while the handler is running, so the
            // completion's CAS is already lost when the fold reaches the store.
            await h.store.transitionTask(
              KEY,
              { status: 'running', ownerRunId: 'run-impl-1' },
              { status: 'queued', ownerRunId: undefined, leaseExpiresAt: undefined, now: NOW },
            );
            return { result: 'success', context: {}, disputeTransition: application.value };
          },
        },
        now: NOW,
      });
      expect(outcome.status).toBe('claim_lost');

      const task = await h.store.getTask(KEY);
      expect(blockOf(task).lineages[LINEAGE_A].state).toBe('open');
      expect(await transitionEvents(h)).toHaveLength(0);
    });

    test('a decision computed against a block that has since moved is refused, not applied', async () => {
      const ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A), [LINEAGE_B]: lineage(LINEAGE_B) });
      await enqueue(ctx);
      // Run A's decision is computed here, against the pristine block…
      const stale = dispositionsDecision(ctx, [disputeRecord(LINEAGE_A)], { runId: 'run-impl-1' });
      // …but B moves first.
      const moved = await step(h, {
        runId: 'run-impl-0',
        decide: (c) => dispositionsDecision(c, [disputeRecord(LINEAGE_B)], { runId: 'run-impl-0' }),
      });
      // A is still `open`, so §7.1 rule 2 keeps the implementer turn: this run
      // routes the task straight back to `implementation` with no park in
      // between, which is what puts run A's stale decision in front of a block
      // it never saw.
      expect(moved.task.status).toBe('queued');
      expect(moved.task.phase).toBe('implementation');

      const current = blockOf(await h.store.getTask(KEY));
      const result = applyDisputeTransition({
        context: current,
        decision: stale,
        run: { runId: 'run-impl-1', actor: 'implementer' },
      });
      expect(result.ok).toBe(false);
      expect(result.failure.detail).toContain(LINEAGE_B);
    });
  });
});

// ===========================================================================
// 2. SQLite-only: publication, restart, maintenance, and the operator CLI
// ===========================================================================

describe('review-dispute lifecycles — durable behavior (SqliteTaskStore)', () => {
  let dir;
  let dbPath;
  let sessionsPath;
  let h;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dispute-e2e-sqlite-'));
    dbPath = join(dir, 'test.db');
    sessionsPath = join(dir, 'sessions.json');
    // The registry's own shape — deliberately NOT `BASE_SESSION`, which is the
    // already-resolved session object `runNextPhase` takes in process.
    writeFileSync(
      sessionsPath,
      JSON.stringify({
        sessions: [
          {
            sessionId: SESSION,
            repoKey: 'test-repo',
            repoRoot: dir,
            githubRepo: 'org/repo',
            artifactDir: '.n8n-artifacts',
            baseBranch: 'main',
            defaults: { implementationAgent: 'claude', reviewAgent: 'codex' },
            verification: { test: 'npm test' },
            labels: { active: 'ai:active', blocked: 'ai:blocked', readyForHuman: 'ai:ready-for-human' },
            reviewDispute: { enabled: true },
          },
        ],
      }),
    );
    h = {
      store: new SqliteTaskStore(dbPath),
      outboxStore: new SqliteOutboxStore(dbPath),
      session: BASE_SESSION,
    };
  });

  afterEach(() => {
    h.outboxStore?.close();
    h.store?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function enqueue(ctx, extraContext = {}) {
    await h.store.enqueueTask({
      sessionId: SESSION,
      issueNumber: ISSUE,
      phase: 'implementation',
      priority: 'normal',
      context: { [REVIEW_DISPUTE_CONTEXT_KEY]: ctx, ...extraContext },
      now: '2026-08-06T11:00:00.000Z',
    });
  }

  async function disputeComments() {
    const pending = await h.outboxStore.listPending();
    return pending.filter((e) => String(e.payload?.body ?? '').includes('Review dispute outcome'));
  }

  function cli(...args) {
    try {
      return { code: 0, stdout: execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8' }), stderr: '' };
    } catch (err) {
      return { code: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
    }
  }

  // --- scenario 11 --------------------------------------------------------

  test('a lifecycle that ends on a PR publishes exactly one bounded outcome comment', async () => {
    await enqueue(context({ [LINEAGE_A]: lineage(LINEAGE_A) }));
    await step(h, {
      runId: 'run-impl-1',
      handlerContext: { prUrl: PR_URL },
      decide: (c) => dispositionsDecision(c, [disputeRecord(LINEAGE_A)], { runId: 'run-impl-1' }),
    });
    // Intermediate state: nothing public.
    expect(await disputeComments()).toHaveLength(0);

    await resume(h, 'review');
    await step(h, {
      runId: 'run-review-2',
      actor: 'reviewer',
      handlerContext: { prUrl: PR_URL },
      decide: (c) => reconsiderationDecision(c, LINEAGE_A, 'withdraw'),
    });

    const rows = await disputeComments();
    expect(rows).toHaveLength(1);
    expect(rows[0].topic).toBe('repohost:pr-comment');
    expect(rows[0].payload.prNumber).toBe(42);
    expect(rows[0].payload.body).toContain('resolved_withdrawn');
    expect(rows[0].payload.body).toContain(BOUNDARY);
    // §11: never the prose, never a local path, never a run id.
    expect(rows[0].payload.body).not.toContain(ARGUMENT);
    expect(rows[0].payload.body).not.toContain('run-review-2');
    expect(rows[0].payload.body).not.toMatch(/\/Users\//);
  });

  test('the same lifecycle with no PR falls back to the work item', async () => {
    await enqueue(context({ [LINEAGE_A]: lineage(LINEAGE_A) }));
    await step(h, {
      runId: 'run-impl-1',
      decide: (c) => dispositionsDecision(c, [disputeRecord(LINEAGE_A)], { runId: 'run-impl-1' }),
    });
    await resume(h, 'review');
    await step(h, {
      runId: 'run-review-2',
      actor: 'reviewer',
      decide: (c) => reconsiderationDecision(c, LINEAGE_A, 'withdraw'),
    });

    const rows = await disputeComments();
    expect(rows).toHaveLength(1);
    expect(rows[0].topic).toBe('gh:comment');
    expect(rows[0].payload.issueNumber).toBe(ISSUE);
  });

  test('a re-delivered terminal transition posts no second comment and appends no second event', async () => {
    const ctx = context({ [LINEAGE_A]: lineage(LINEAGE_A) });
    const findings = promptFindings(ctx);
    await enqueue(ctx);
    await step(h, {
      runId: 'run-impl-1',
      handlerContext: { prUrl: PR_URL },
      decide: (c) => dispositionsDecision(c, [fixedRecord(LINEAGE_A)], { diff: true, runId: 'run-impl-1' }),
    });
    expect(await disputeComments()).toHaveLength(1);

    // The same run delivering again after a retry: §7.1 rule 3 left the task at
    // `review`, and the decision is re-computed against the block the first
    // delivery committed, which is what makes it read as the replay it is.
    const second = await step(h, {
      runId: 'run-impl-1',
      handlerContext: { prUrl: PR_URL },
      decide: (c) =>
        dispositionsDecision(ctx, [fixedRecord(LINEAGE_A)], {
          diff: true,
          runId: 'run-impl-1',
          current: c,
          findings,
        }),
    });
    expect(second.application.replayed).toBe(true);
    expect(await disputeComments()).toHaveLength(1);
    const events = (await h.store.listEvents(KEY)).filter((e) => e.type === REVIEW_DISPUTE_TRANSITION_EVENT);
    expect(events).toHaveLength(1);
  });

  // --- scenario 10 (durable half) -----------------------------------------

  test('a held maintenance lock refuses the whole completion and leaves nothing half-applied', async () => {
    await enqueue(context({ [LINEAGE_A]: lineage(LINEAGE_A) }));
    const before = await h.store.getTask(KEY);
    const application = applyDisputeTransition({
      context: before.context[REVIEW_DISPUTE_CONTEXT_KEY],
      decision: dispositionsDecision(before.context[REVIEW_DISPUTE_CONTEXT_KEY], [fixedRecord(LINEAGE_A)], {
        diff: true,
        runId: 'run-impl-1',
      }),
      run: { runId: 'run-impl-1', actor: 'implementer' },
    });
    expect(application.ok).toBe(true);

    const lock = new SqliteMaintenanceLock(dbPath);
    let outcome;
    try {
      outcome = await runNextPhase({
        store: h.store,
        request: { sessionId: SESSION, workerId: 'w', runId: 'run-impl-1', supportedPhases: ['implementation'], now: NOW },
        handlers: {
          implementation: async () => {
            // Maintenance starts while the phase is mid-flight.
            expect(lock.acquire('prune:e2e', NOW, { skipActivityChecks: true }).ok).toBe(true);
            return { result: 'success', context: { prUrl: PR_URL }, disputeTransition: application.value };
          },
        },
        outboxStore: h.outboxStore,
        session: h.session,
        now: NOW,
      });
    } finally {
      lock.release();
      lock.close();
    }

    expect(outcome.status).toBe('maintenance_locked');
    const task = await h.store.getTask(KEY);
    expect(blockOf(task).lineages[LINEAGE_A].state).toBe('open');
    const events = (await h.store.listEvents(KEY)).filter((e) => e.type === REVIEW_DISPUTE_TRANSITION_EVENT);
    expect(events).toHaveLength(0);
    expect(await disputeComments()).toHaveLength(0);

    // The refusal came from the task store's OWN database, so the runner's
    // claim-requeue is refused by the same lock and the task is deliberately
    // left `running` (phase-runner.ts, `requeueClaimForMaintenance`). Recovery
    // is the documented post-maintenance path — lease expiry plus `admin task
    // recover`, i.e. this store port — not a hand edit.
    expect(task.status).toBe('running');
    const recovered = await h.store.recoverTask(KEY, { now: '2026-08-06T13:00:00.000Z' });
    expect(recovered.ok).toBe(true);
    expect(recovered.value.status).toBe('queued');

    // Repeatable once maintenance releases: the same run applies cleanly.
    const retry = await runNextPhase({
      store: h.store,
      request: { sessionId: SESSION, workerId: 'w', runId: 'run-impl-1', supportedPhases: ['implementation'], now: NOW },
      handlers: {
        implementation: async () => ({
          result: 'success',
          context: { prUrl: PR_URL },
          disputeTransition: application.value,
        }),
      },
      outboxStore: h.outboxStore,
      session: h.session,
      now: NOW,
    });
    expect(retry.status).toBe('completed');
    expect(blockOf(await h.store.getTask(KEY)).lineages[LINEAGE_A].state).toBe('resolved_fixed');
    expect(await disputeComments()).toHaveLength(1);
  });

  test('a process restart reads back the identical lineage state, events, and metrics', async () => {
    await enqueue(context({ [LINEAGE_A]: lineage(LINEAGE_A) }));
    await step(h, {
      runId: 'run-impl-1',
      decide: (c) => dispositionsDecision(c, [disputeRecord(LINEAGE_A)], { runId: 'run-impl-1' }),
    });
    await resume(h, 'review');
    await step(h, {
      runId: 'run-review-2',
      actor: 'reviewer',
      decide: (c) => reconsiderationDecision(c, LINEAGE_A, 'uphold'),
    });

    const beforeTask = await h.store.getTask(KEY);
    const beforeEvents = await h.store.listEvents(KEY);
    const beforeMetrics = aggregateDisputeMetrics({
      sessionId: SESSION,
      tasks: [{ issueNumber: ISSUE, events: beforeEvents }],
    });

    // Restart: close every handle and reopen the same file.
    h.outboxStore.close();
    h.store.close();
    h.store = new SqliteTaskStore(dbPath);
    h.outboxStore = new SqliteOutboxStore(dbPath);

    const afterTask = await h.store.getTask(KEY);
    const afterEvents = await h.store.listEvents(KEY);
    expect(blockOf(afterTask)).toEqual(blockOf(beforeTask));
    expect(afterTask.status).toBe(beforeTask.status);
    expect(afterEvents).toEqual(beforeEvents);
    expect(
      aggregateDisputeMetrics({ sessionId: SESSION, tasks: [{ issueNumber: ISSUE, events: afterEvents }] }),
    ).toEqual(beforeMetrics);
  });

  // --- scenario 12 --------------------------------------------------------

  test('`admin dispute status` reports the task the scenario actually produced', async () => {
    await enqueue(context({ [LINEAGE_A]: lineage(LINEAGE_A) }));
    await step(h, {
      runId: 'run-impl-1',
      decide: (c) => dispositionsDecision(c, [disputeRecord(LINEAGE_A)], { runId: 'run-impl-1' }),
    });
    await resume(h, 'review');
    await step(h, {
      runId: 'run-review-2',
      actor: 'reviewer',
      decide: (c) => reconsiderationDecision(c, LINEAGE_A, 'withdraw'),
    });

    const json = JSON.parse(
      cli('dispute', 'status', '--session-id', SESSION, '--issue-number', String(ISSUE),
        '--db-path', dbPath, '--sessions-path', sessionsPath, '--json').stdout.trim(),
    );
    expect(json.ok).toBe(true);
    expect(json.dispute.lineages).toHaveLength(1);
    expect(json.dispute.lineages[0]).toMatchObject({
      lineageId: LINEAGE_A,
      state: 'resolved_withdrawn',
      outcome: 'resolved_withdrawn',
      terminal: true,
      affectedBoundary: BOUNDARY,
    });
    expect(json.dispute.reopenEligibleLineageIds).toEqual([LINEAGE_A]);

    // Human rendering of the same projection.
    const human = cli('dispute', 'status', '--session-id', SESSION, '--issue-number', String(ISSUE),
      '--db-path', dbPath, '--sessions-path', sessionsPath);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain(LINEAGE_A);
    expect(human.stdout).toContain('resolved_withdrawn');
  });

  test('`admin dispute reopen` flags the produced lineage without overturning it', async () => {
    await enqueue(context({ [LINEAGE_A]: lineage(LINEAGE_A) }));
    await step(h, {
      runId: 'run-impl-1',
      decide: (c) => dispositionsDecision(c, [fixedRecord(LINEAGE_A)], { diff: true, runId: 'run-impl-1' }),
    });

    const preview = cli('dispute', 'reopen', '--session-id', SESSION, '--issue-number', String(ISSUE),
      '--lineage-id', LINEAGE_A, '--version', '1', '--db-path', dbPath, '--sessions-path', sessionsPath, '--json');
    expect(preview.code).toBe(0);
    expect(JSON.parse(preview.stdout.trim())).toMatchObject({ wouldRecord: true, lineageState: 'resolved_fixed' });
    // Preview really is read-only.
    expect(blockOf(await h.store.getTask(KEY)).lineages[LINEAGE_A].reopenRequested).toBeUndefined();

    const applied = cli('dispute', 'reopen', '--session-id', SESSION, '--issue-number', String(ISSUE),
      '--lineage-id', LINEAGE_A, '--version', '1', '--db-path', dbPath, '--sessions-path', sessionsPath, '--yes', '--json');
    expect(applied.code).toBe(0);
    expect(JSON.parse(applied.stdout.trim()).recorded).toBe(true);

    const task = await h.store.getTask(KEY);
    const l = blockOf(task).lineages[LINEAGE_A];
    // §6.4: the resolution is flagged, never reversed, and no counter moved.
    expect(l.reopenRequested).toBe(true);
    expect(l.state).toBe('resolved_fixed');
    expect(l.outcome).toBe('resolved_fixed');
    expect(l.counters).toEqual(ZERO_LINEAGE_COUNTERS);
    expect(task.status).toBe('ready_for_human');
    // §11 publishes resolutions and escalations, not requests.
    expect(await disputeComments()).toHaveLength(1);
  });

  test('`admin dispute metrics` counts the lifecycle the scenario produced', async () => {
    await enqueue(context({ [LINEAGE_A]: lineage(LINEAGE_A) }));
    await step(h, {
      runId: 'run-impl-1',
      decide: (c) => dispositionsDecision(c, [disputeRecord(LINEAGE_A)], { runId: 'run-impl-1' }),
    });
    await resume(h, 'review');
    await step(h, {
      runId: 'run-review-2',
      actor: 'reviewer',
      decide: (c) => reconsiderationDecision(c, LINEAGE_A, 'uphold'),
    });
    await resume(h, 'review');
    await step(h, {
      runId: 'run-arb-3',
      actor: 'arbiter',
      decide: (c) => verdictDecision(c, LINEAGE_A, { verdict: 'implementer_correct', confidence: 0.9, runId: 'run-arb-3' }),
    });

    const json = JSON.parse(
      cli('dispute', 'metrics', '--session-id', SESSION, '--db-path', dbPath,
        '--sessions-path', sessionsPath, '--json').stdout.trim(),
    );
    expect(json.ok).toBe(true);
    expect(json.metrics).toMatchObject({
      tasksScanned: 1,
      tasksWithDisputeActivity: 1,
      rebuttalsRecorded: 1,
      reconsiderations: 1,
      humanEscalations: 0,
      reopenRequests: 0,
      lineagesReachedTerminal: 1,
      lineagesResolvedWithoutHuman: 1,
      tasksResolvedWithoutHuman: 1,
    });
    expect(json.metrics.arbitration).toEqual({ verdicts: 1, malformedAttempts: 0 });
    expect(json.metrics.terminalOutcomes.resolved_overruled).toBe(1);
    expect(json.metrics.terminalOutcomes.escalated_human).toBe(0);
  });
});
