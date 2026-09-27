/**
 * Issue #977 — end-to-end observability of the refinement lane
 * (docs/issue-refinement-contract.md §15, §16, §18).
 *
 * #975 persisted the progress milestones; #976 published them as append-only
 * Issue comments. Neither made the lane legible to an operator: "where is this
 * Issue now" was still an `admin task-status --verbose` reading exercise over a
 * §15 block that carries counters but no position.
 *
 * These tests drive the REAL phase runner against a REAL SQLite task store and
 * outbox, then assert that the four records an operator may consult agree at
 * every boundary:
 *
 *   the authoritative task transition
 *     → the persisted `refinement.progress.milestone` event
 *       → the outbox comment effect
 *         → the normalized admin/UI status
 *
 * The direction of that arrow is the contract. Admin status derives from the
 * task row and the milestone events ONLY: nothing here reads a comment back,
 * infers state from outbox delivery, or rebuilds a second progress state
 * machine out of the fine-grained `refinement.*` audit events.
 */
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  REFINEMENT_PROGRESS_EVENT_TYPE,
  REFINEMENT_PROGRESS_SCHEMA_VERSION,
} from '../dist/core/issue-refinement-progress.js';
import {
  REFINEMENT_PROGRESS_COMMENT_UNPUBLISHABLE_EVENT,
  refinementProgressCommentIdempotencyKey,
} from '../dist/core/issue-refinement-progress-publication.js';
import {
  REFINEMENT_PROGRESS_DISPOSITIONS,
  renderRefinementProgressLines,
  summarizeRefinementProgress,
} from '../dist/core/issue-refinement-progress-status.js';
import {
  renderRefinementLines,
  summarizeRefinementStatus,
} from '../dist/core/issue-refinement-status.js';
import {
  buildTaskMenuActions,
  formatRefinementDetail,
  formatTaskDetail,
  hasRefinementState,
} from '../dist/cli/admin-ui.js';
import { ISSUE_REFINEMENT_DEFAULT_LIMITS } from '../dist/core/issue-refinement.js';
import { isDelayed } from '../dist/core/transitions.js';
import { SqliteTaskStore } from '../dist/stores/sqlite-task-store.js';
import { SqliteOutboxStore } from '../dist/stores/sqlite-outbox-store.js';
import { runNextPhase } from '../dist/core/phase-runner.js';

const CLI = new URL('../dist/cli/admin.js', import.meta.url).pathname;

// Deliberately in the future: a `retry_scheduled` deadline is only "still in
// force" relative to a real clock, and the admin CLI subprocess reads the real
// one. Anchoring the whole suite past any plausible run date keeps the delayed
// disposition deterministic instead of expiring the day the fixture ages out.
const NOW = '2099-03-01T10:00:00.000Z';
const LATER = '2099-03-02T10:00:00.000Z';
const FINGERPRINT = 'a'.repeat(64);
const PREDECESSOR_FINGERPRINT = 'b'.repeat(64);

const SESSION = {
  sessionId: 'test-session',
  repoKey: 'test-repo',
  repoRoot: '/tmp/test-repo',
  githubRepo: 'org/repo',
  artifactDir: '.artifacts',
  artifactRoot: '/tmp/test-repo/.artifacts',
  githubOwner: 'org',
  githubName: 'repo',
  defaults: { implementationAgent: 'claude', reviewAgent: 'codex' },
  verification: {},
  labels: {
    active: 'ai:active',
    blocked: 'ai:blocked',
    readyForHuman: 'ai:ready-for-human',
    needsReview: 'status:needs-review',
    needsImplementation: 'status:needs-implementation',
  },
  workItemProvider: { provider: 'github-issues', auth: { mode: 'gh' } },
  repoHostProvider: { provider: 'github', auth: { mode: 'gh' } },
};

const KEY = { sessionId: 'test-session', issueNumber: 99 };
const REQUEST = {
  sessionId: 'test-session',
  workerId: 'w1',
  runId: 'run-refine-1',
  supportedPhases: ['refinement'],
  now: NOW,
};

const block = (over = {}) => ({
  state: 'drafting',
  sourceFingerprint: FINGERPRINT,
  predecessorFingerprint: PREDECESSOR_FINGERPRINT,
  limits: { ...ISSUE_REFINEMENT_DEFAULT_LIMITS },
  roles: { refinerAgent: 'claude', criticAgent: 'codex' },
  counters: { rounds: 1 },
  ...over,
});

const ctx = (over = {}) => ({ title: 'Downstream Issue', refinement: block(over) });

const evt = (type, data = {}) => ({
  type,
  data: {
    issueNumber: 99,
    runId: 'run-refine-1',
    state: 'drafting',
    predecessorFingerprint: PREDECESSOR_FINGERPRINT,
    at: '2099-03-01T09:59:00.000Z',
    ...data,
  },
});

const REFINER_AGENT = {
  agentId: 'claude',
  provider: 'anthropic',
  model: 'claude-opus-5',
  modelSource: 'default',
  effort: 'high',
  effortSource: 'default',
};

const snapshotCaptured = () =>
  evt('refinement.snapshot.captured', { state: 'drafting', predecessorCount: 1 });
const draftRecorded = (over = {}) =>
  evt('refinement.draft.recorded', {
    state: 'critiquing', round: 1, role: 'refiner', ...REFINER_AGENT,
    confidence: 'high', attempt: 1, durationMs: 4200, ...over,
  });
const critiqueRevise = (over = {}) =>
  evt('refinement.critique.revise', {
    state: 'drafting', round: 1, role: 'critic',
    agentId: 'codex', provider: 'openai', model: 'gpt-5',
    attempt: 1, durationMs: 2100, ...over,
  });
const critiquePassed = (over = {}) =>
  evt('refinement.critique.passed', {
    state: 'accepted', round: 1, refinerConfidence: 'high', criticConfidence: 'medium',
    role: 'critic', agentId: 'codex', provider: 'openai', model: 'gpt-5',
    attempt: 1, durationMs: 3100, ...over,
  });
const activatedEvent = () =>
  evt('refinement.activated', {
    state: 'activated', parked: { status: 'blocked', phase: 'implementation' },
  });
const agentFailed = (over = {}) =>
  evt('refinement.agent.failed', {
    state: 'drafting', role: 'refiner', ...REFINER_AGENT,
    failureKind: 'usage_quota', retryable: true, round: 1, attempt: 1, durationMs: 600, ...over,
  });

// ---------------------------------------------------------------------------
// The shared harness: one real runner, one real store, one real outbox
// ---------------------------------------------------------------------------

describe('refinement observability — the authoritative flow', () => {
  let tmpDir;
  let dbPath;
  let taskStore;
  let outboxStore;

  const enqueueTask = async (context) =>
    taskStore.enqueueTask({
      sessionId: 'test-session',
      issueNumber: 99,
      phase: 'refinement',
      now: NOW,
      context,
    });

  const run = async (handler, over = {}) =>
    runNextPhase({
      store: taskStore,
      request: { ...REQUEST, ...(over.request ?? {}) },
      handlers: { refinement: handler },
      outboxStore,
      session: SESSION,
      now: over.now ?? NOW,
    });

  const comments = async () =>
    (await outboxStore.listUnsent()).filter((r) => r.topic === 'gh:comment');

  const events = async () => taskStore.listEvents(KEY);

  const milestones = async () =>
    (await events())
      .filter((e) => e.type === REFINEMENT_PROGRESS_EVENT_TYPE)
      .map((e) => e.data);

  /** The normalized operator view, exactly as `admin task-status` derives it. */
  const status = async (now = NOW) =>
    summarizeRefinementProgress(await taskStore.getTask(KEY), await events(), now);

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'refinement-observability-'));
    dbPath = join(tmpDir, 'test.db');
    taskStore = new SqliteTaskStore(dbPath);
    outboxStore = new SqliteOutboxStore(dbPath);
  });

  afterEach(() => {
    taskStore.close();
    outboxStore.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Start → refiner → critic
  // -------------------------------------------------------------------------

  test('start through refiner and critic completion agrees across all four records', async () => {
    await enqueueTask(ctx({ state: 'eligible' }));
    const outcome = await run(async () => ({
      result: 'success',
      context: ctx({ state: 'drafting', counters: { rounds: 1 } }),
      extraEvents: [snapshotCaptured(), draftRecorded(), critiqueRevise()],
    }));

    // 1. the authoritative transition
    expect(outcome.status).toBe('completed');
    // 2. the persisted milestones
    expect((await milestones()).map((m) => m.kind)).toEqual([
      'started', 'refiner_completed', 'critic_completed',
    ]);
    // 3. the published comments, one per milestone and keyed on it
    const rows = await comments();
    expect(rows.map((r) => r.idempotencyKey)).toEqual(
      (await milestones()).map((m) =>
        refinementProgressCommentIdempotencyKey({
          sessionId: 'test-session', issueNumber: 99, milestoneId: m.milestoneId,
        }),
      ),
    );
    // 4. the operator view — the same position, derived from 1 and 2 only
    const view = await status();
    expect(view).toMatchObject({
      phase: 'refinement',
      refinementState: 'drafting',
      disposition: 'queued',
      round: 1,
      attempt: 1,
      role: 'critic',
      refinerAgent: 'claude',
      criticAgent: 'codex',
      nextAction: 'await_refiner',
      humanActionRequired: false,
      milestonesRecorded: 3,
      unreadableMilestones: 0,
      unpublishableComments: 0,
    });
    expect(view.lastMilestone).toMatchObject({ kind: 'critic_completed', result: 'revise' });
    expect(view.lastMilestone.agent).toMatchObject({ agentId: 'codex', provider: 'openai' });
  });

  test('the refiner boundary reports the refiner agent, the critic boundary the critic', async () => {
    await enqueueTask(ctx({ state: 'eligible' }));
    await run(async () => ({
      result: 'success',
      context: ctx({ state: 'critiquing' }),
      extraEvents: [snapshotCaptured(), draftRecorded()],
    }));
    const afterRefiner = await status();
    expect(afterRefiner.role).toBe('refiner');
    expect(afterRefiner.nextAction).toBe('await_critic');
    expect(afterRefiner.lastMilestone.agent.agentId).toBe('claude');
    expect(afterRefiner.lastMilestone.durationMs).toBe(4200);
  });

  // -------------------------------------------------------------------------
  // Transient failure and the delayed retry
  // -------------------------------------------------------------------------

  test('a transient refiner failure shows delayed with the exact committed deadline', async () => {
    await enqueueTask(ctx({ state: 'drafting' }));
    const outcome = await run(async () => ({
      result: 'delayed',
      message: 'refinement refiner process failure (usage_quota) in round 1',
      context: ctx({
        state: 'drafting',
        pendingRetry: { role: 'refiner', round: 1, attempt: 1, failureKind: 'usage_quota' },
      }),
      extraEvents: [agentFailed()],
    }));
    expect(outcome.status).toBe('delayed');

    const task = await taskStore.getTask(KEY);
    const [milestone] = await milestones();
    // The milestone carries the notBefore the ROW actually committed, and the
    // operator view repeats it verbatim — no re-derivation anywhere.
    expect(milestone.retryNotBefore).toBe(task.notBefore);
    const view = await status();
    expect(view.disposition).toBe('delayed');
    expect(view.retryNotBefore).toBe(task.notBefore);
    expect(view.nextAction).toBe('await_retry');
    expect(view.failureClass).toBe('usage_quota');
    expect(view.role).toBe('refiner');
    expect(view.humanActionRequired).toBe(false);
    // And the comment states the same deadline.
    expect((await comments())[0].payload.body)
      .toContain(`| Retry not before | \`${task.notBefore}\` (UTC) |`);
  });

  test('a transient critic failure is the same boundary under the critic role', async () => {
    await enqueueTask(ctx({ state: 'critiquing' }));
    await run(async () => ({
      result: 'delayed',
      context: ctx({
        state: 'critiquing',
        pendingRetry: { role: 'critic', round: 1, attempt: 1, failureKind: 'agent_error' },
      }),
      extraEvents: [
        agentFailed({
          state: 'critiquing', role: 'critic', failureKind: 'agent_error',
          agentId: 'codex', provider: 'openai', model: 'gpt-5',
        }),
      ],
    }));
    const view = await status();
    expect(view.disposition).toBe('delayed');
    expect(view.role).toBe('critic');
    expect(view.failureClass).toBe('agent_error');
    expect(view.lastMilestone.kind).toBe('retry_scheduled');
  });

  test('once the committed deadline has passed the task reads queued, not delayed', async () => {
    await enqueueTask(ctx({ state: 'drafting' }));
    await run(async () => ({
      result: 'delayed',
      context: ctx({
        state: 'drafting',
        pendingRetry: { role: 'refiner', round: 1, attempt: 1, failureKind: 'usage_quota' },
      }),
      extraEvents: [agentFailed()],
    }));
    const view = await status(LATER);
    expect(view.disposition).toBe('queued');
    // The deadline is no longer the situation, so it is not advertised as one —
    // but the boundary that committed it is still on the record.
    expect(view.retryNotBefore).toBeNull();
    expect(view.lastMilestone.retryNotBefore).not.toBeNull();
  });

  test('the delay verdict follows the scheduler for a second-precision deadline', async () => {
    await enqueueTask(ctx({ state: 'drafting' }));
    await run(async () => ({
      result: 'delayed',
      context: ctx({
        state: 'drafting',
        pendingRetry: { role: 'refiner', round: 1, attempt: 1, failureKind: 'usage_quota' },
      }),
      extraEvents: [agentFailed()],
    }));

    // Both strings are valid ISO-8601 UTC and name the SAME instant, but the
    // second-precision one sorts AFTER the millisecond one ('Z' > '.'). Compared
    // as text the deadline looks unexpired; compared as instants — which is what
    // the claim path does — it has passed.
    const elapsed = { ...(await taskStore.getTask(KEY)), notBefore: '2099-03-02T10:00:00Z' };
    expect(isDelayed(elapsed, LATER)).toBe(false);

    const view = summarizeRefinementProgress(elapsed, await events(), LATER);
    expect(view.disposition).toBe('queued');
    expect(view.retryNotBefore).toBeNull();

    // ...and one millisecond earlier the same row is genuinely still delayed.
    const pending = summarizeRefinementProgress(elapsed, await events(), '2099-03-02T09:59:59.999Z');
    expect(pending.disposition).toBe('delayed');
  });

  // -------------------------------------------------------------------------
  // Acceptance and activation
  // -------------------------------------------------------------------------

  test('acceptance then activation ends at the activated disposition', async () => {
    await enqueueTask(ctx({ state: 'critiquing' }));
    await run(async () => ({
      result: 'success',
      context: ctx({ state: 'accepted' }),
      extraEvents: [critiquePassed()],
    }));
    const accepted = await status();
    expect(accepted.disposition).toBe('queued');
    expect(accepted.lastMilestone.kind).toBe('accepted');
    expect(accepted.nextAction).toBe('await_application');

    const carried = (await taskStore.getTask(KEY)).context;
    await run(async () => ({
      result: 'success',
      context: { ...carried, refinement: { ...carried.refinement, state: 'activated' } },
      // §12 row 45: the row is parked `blocked` at phase `implementation` in the
      // same transaction as the `activated` block.
      refinementActivation: { targetStatus: 'blocked', targetPhase: 'implementation' },
      extraEvents: [activatedEvent()],
    }));
    const parked = await taskStore.getTask(KEY);
    expect({ status: parked.status, phase: parked.phase })
      .toEqual({ status: 'blocked', phase: 'implementation' });

    const activated = await status();
    expect(activated.disposition).toBe('activated');
    expect(activated.refinementState).toBe('activated');
    expect(activated.terminal).toBe(true);
    expect(activated.nextAction).toBe('await_implementation');
    expect(activated.humanActionRequired).toBe(false);
    expect((await milestones()).map((m) => m.kind)).toEqual([
      'critic_completed', 'accepted', 'activated',
    ]);
  });

  test('the reactivated implementation row reads queued, not still activated', async () => {
    await enqueueTask(ctx({ state: 'accepted' }));
    const carried = ctx({ state: 'activated' });
    await run(async () => ({
      result: 'success',
      context: carried,
      refinementActivation: { targetStatus: 'blocked', targetPhase: 'implementation' },
      extraEvents: [activatedEvent()],
    }));
    expect((await status()).disposition).toBe('activated');

    // §12 row 33: ordinary intake reactivates the parked row to `queued` at
    // phase `implementation`. The block keeps `state: "activated"` for good and
    // the `activated` milestone stays on the record — but the Issue is now a
    // normal implementation task waiting for its next worker, and reporting it
    // as still-activating would hide that.
    await taskStore.transitionTask(KEY, { status: 'blocked' }, { status: 'queued', now: LATER });
    const view = await status(LATER);
    expect(view.disposition).toBe('queued');
    expect(view.humanActionRequired).toBe(false);
    // The refinement record itself is untouched by the reclassification.
    expect(view.refinementState).toBe('activated');
    expect(view.terminal).toBe(true);
    expect(view.lastMilestone.kind).toBe('activated');
  });

  // -------------------------------------------------------------------------
  // The two terminal boundaries an operator must be able to tell apart
  // -------------------------------------------------------------------------

  test('a terminal human handoff is distinguishable from a non-retryable failure', async () => {
    await enqueueTask(ctx({ state: 'critiquing' }));
    await run(async () => ({
      result: 'blocked',
      message: 'refinement escalated (no_convergence)',
      context: ctx({ state: 'escalated_human', handoffReason: 'no_convergence' }),
      extraEvents: [
        evt('refinement.escalated.human', { state: 'escalated_human', reason: 'no_convergence' }),
      ],
    }));
    const view = await status();
    expect(view.disposition).toBe('awaiting_human');
    expect(view.humanActionRequired).toBe(true);
    expect(view.handoffReason).toBe('no_convergence');
    expect(view.nextAction).toBe('await_human');
    expect(view.lastMilestone.kind).toBe('human_handoff');
  });

  test('a non-retryable phase failure reads failed, with no invented cause', async () => {
    await enqueueTask(ctx({ state: 'drafting' }));
    const outcome = await run(async () => {
      throw new Error('refinement handler exploded at /tmp/test-repo/.artifacts/run-1');
    });
    expect(outcome.status).toBe('completed');

    const task = await taskStore.getTask(KEY);
    expect(task.status).toBe('failed');
    const view = await status();
    expect(view.disposition).toBe('failed');
    expect(view.humanActionRequired).toBe(true);
    expect(view.failureClass).toBe('phase_failed');
    expect(view.lastMilestone.kind).toBe('failed');
    // The handler's error prose — including the artifact path in it — reaches
    // neither the milestone nor the operator view.
    expect(JSON.stringify(view)).not.toContain('exploded');
    expect(JSON.stringify(view)).not.toContain('/tmp/test-repo');
  });

  test('a hard failure the operator recovered reads by the row, not by the dead milestone', async () => {
    await enqueueTask(ctx({ state: 'drafting' }));
    await run(async () => {
      throw new Error('refinement handler exploded');
    });
    expect((await status()).disposition).toBe('failed');

    // `admin recover` requeues the row; the milestone log still ends at `failed`
    // for good, and reporting the Issue dead would be exactly wrong.
    await taskStore.transitionTask(KEY, { status: 'failed' }, { status: 'queued', now: LATER });
    const view = await status(LATER);
    expect(view.disposition).toBe('queued');
    expect(view.lastMilestone.kind).toBe('failed');
  });

  test('a running claim reads running, and a poll that crosses no boundary adds nothing', async () => {
    await enqueueTask(ctx({ state: 'pending' }));
    const outcome = await run(async () => ({
      result: 'delayed',
      message: 'refinement is not yet eligible',
      context: ctx({ state: 'pending' }),
      extraEvents: [evt('refinement.hold', { state: 'pending', reason: 'predecessor_not_ready' })],
    }));
    expect(outcome.status).toBe('delayed');
    expect(await milestones()).toEqual([]);
    expect(await comments()).toHaveLength(0);

    const view = await status();
    expect(view.lastMilestone).toBeNull();
    expect(view.milestonesRecorded).toBe(0);
    expect(view.nextAction).toBeNull();
    // A held row still gets an honest disposition from the authoritative row.
    expect(view.disposition).toBe('delayed');
  });

  // -------------------------------------------------------------------------
  // Duplicate suppression across replay and recovery
  // -------------------------------------------------------------------------

  test('a replayed transition emits no second milestone, comment, or status change', async () => {
    await enqueueTask(ctx({ state: 'eligible' }));
    const walk = (context) => ({
      result: 'success',
      context,
      extraEvents: [snapshotCaptured(), draftRecorded(), critiquePassed()],
    });
    await run(async () => walk(ctx({ state: 'accepted' })));
    const firstMilestones = await milestones();
    const firstComments = await comments();
    const firstView = await status();
    expect(firstMilestones).toHaveLength(4);

    // The row stayed queued at this phase; a crashed run re-derives the
    // identical walk on the next claim.
    const carried = (await taskStore.getTask(KEY)).context;
    await run(
      async () => walk({ ...carried, refinement: { ...carried.refinement, state: 'accepted' } }),
      { request: { runId: 'run-refine-2' } },
    );
    expect((await milestones()).map((m) => m.milestoneId))
      .toEqual(firstMilestones.map((m) => m.milestoneId));
    expect((await comments()).map((r) => r.idempotencyKey))
      .toEqual(firstComments.map((r) => r.idempotencyKey));
    const secondView = await status();
    expect(secondView).toEqual(firstView);
  });

  test('a lost claim publishes nothing and leaves the operator view untouched', async () => {
    await enqueueTask(ctx({ state: 'eligible' }));
    const outcome = await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: {
        refinement: async () => {
          await taskStore.transitionTask(KEY, {}, { ownerRunId: 'someone-else', now: NOW });
          return {
            result: 'success',
            context: ctx({ state: 'accepted' }),
            extraEvents: [snapshotCaptured(), critiquePassed()],
          };
        },
      },
      outboxStore,
      session: SESSION,
      now: NOW,
    });
    expect(outcome.status).toBe('claim_lost');
    expect(await milestones()).toEqual([]);
    expect(await comments()).toHaveLength(0);
    expect((await status()).lastMilestone).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Unknown persisted data fails closed
  // -------------------------------------------------------------------------

  test('a milestone from a newer schema is refused, counted, and never fabricated', async () => {
    await enqueueTask(ctx({ state: 'eligible' }));
    await run(async () => ({
      result: 'success',
      context: ctx({ state: 'critiquing' }),
      extraEvents: [snapshotCaptured(), draftRecorded()],
    }));
    // Only a producer this build does not have can mint one, so it is appended
    // directly — what matters is what the operator surface does with it.
    await taskStore.appendEvent({
      task: KEY,
      type: REFINEMENT_PROGRESS_EVENT_TYPE,
      createdAt: LATER,
      data: {
        schemaVersion: REFINEMENT_PROGRESS_SCHEMA_VERSION + 1,
        milestoneId: 'c'.repeat(32),
        kind: 'quantum_entangled',
        issueNumber: 99,
        nextAction: 'await_singularity',
        humanActionRequired: true,
        occurredAt: LATER,
      },
    });

    const view = await status();
    expect(view.unreadableMilestones).toBe(1);
    expect(view.milestonesRecorded).toBe(2);
    expect(view.staleAfterUnreadable).toBe(true);
    // The refused record contributes NOTHING: not its kind, not its nextAction,
    // and — the dangerous one — not its human-action claim.
    expect(view.lastMilestone.kind).toBe('refiner_completed');
    expect(JSON.stringify(view)).not.toContain('quantum_entangled');
    expect(JSON.stringify(view)).not.toContain('await_singularity');
    // And the superseded readable boundary stops driving the disposition, which
    // falls back to the authoritative row.
    expect(view.nextAction).toBeNull();
    expect(view.disposition).toBe('queued');
    expect(view.humanActionRequired).toBe(false);
    expect(renderRefinementProgressLines(view).join('\n'))
      .toContain('1 unreadable by this build');
  });

  test('an unknown kind alone is refused the same way', async () => {
    await enqueueTask(ctx({ state: 'drafting' }));
    await taskStore.appendEvent({
      task: KEY,
      type: REFINEMENT_PROGRESS_EVENT_TYPE,
      createdAt: NOW,
      data: {
        schemaVersion: REFINEMENT_PROGRESS_SCHEMA_VERSION,
        milestoneId: 'd'.repeat(32),
        kind: 'refiner_transcended',
        issueNumber: 99,
        nextAction: 'await_critic',
        humanActionRequired: false,
      },
    });
    const view = await status();
    expect(view.unreadableMilestones).toBe(1);
    expect(view.milestonesRecorded).toBe(0);
    expect(view.lastMilestone).toBeNull();
    expect(view.disposition).toBe('queued');
  });

  test('a committed milestone whose comment could not be projected is surfaced as a count', async () => {
    await enqueueTask(ctx({ state: 'drafting' }));
    await taskStore.appendEvent({
      task: KEY,
      type: REFINEMENT_PROGRESS_COMMENT_UNPUBLISHABLE_EVENT,
      createdAt: NOW,
      message: 'progress milestone kind is not one of the 8 published boundaries',
      data: { code: 'unknown_kind', projection: 'refinement-progress', projectionVersion: 1 },
    });
    const view = await status();
    expect(view.unpublishableComments).toBe(1);
    expect(renderRefinementProgressLines(view).join('\n'))
      .toContain('1 not published as a comment');
  });

  // -------------------------------------------------------------------------
  // Outbox backing: shared transaction, and the separately-backed path
  // -------------------------------------------------------------------------

  test('with a shared backend the milestone and its comment commit or fail together', async () => {
    // Same db file for both stores: the runner takes the transactional path, so
    // the claim-loss case above already proved neither survives alone. Here the
    // success case proves they land together and count the same.
    expect(taskStore.backendId).toBeDefined();
    expect(taskStore.backendId).toBe(outboxStore.backendId);
    await enqueueTask(ctx({ state: 'eligible' }));
    await run(async () => ({
      result: 'success',
      context: ctx({ state: 'critiquing' }),
      extraEvents: [snapshotCaptured(), draftRecorded()],
    }));
    expect(await comments()).toHaveLength((await milestones()).length);
  });

  test('a separately-backed outbox still publishes exactly one comment per milestone', async () => {
    const separateOutbox = new SqliteOutboxStore(join(tmpDir, 'outbox.db'));
    try {
      expect(separateOutbox.backendId).not.toBe(taskStore.backendId);
      await enqueueTask(ctx({ state: 'eligible' }));
      const outcome = await runNextPhase({
        store: taskStore,
        request: REQUEST,
        handlers: {
          refinement: async () => ({
            result: 'success',
            context: ctx({ state: 'critiquing' }),
            extraEvents: [snapshotCaptured(), draftRecorded()],
          }),
        },
        outboxStore: separateOutbox,
        session: SESSION,
        now: NOW,
      });
      expect(outcome.status).toBe('completed');

      const ids = (await milestones()).map((m) => m.milestoneId);
      expect(ids).toHaveLength(2);
      const rows = (await separateOutbox.listUnsent()).filter((r) => r.topic === 'gh:comment');
      expect(rows.map((r) => r.idempotencyKey)).toEqual(
        ids.map((milestoneId) =>
          refinementProgressCommentIdempotencyKey({
            sessionId: 'test-session', issueNumber: 99, milestoneId,
          }),
        ),
      );
      // The operator view is derived from the task store alone, so it is the
      // same whichever backend the outbox happens to live on.
      const view = await status();
      expect(view.milestonesRecorded).toBe(2);
      expect(view.lastMilestone.kind).toBe('refiner_completed');
    } finally {
      separateOutbox.close();
    }
  });

  // -------------------------------------------------------------------------
  // What reaches GitHub stays bounded and sanitized
  // -------------------------------------------------------------------------

  test('published comments carry no fingerprint, local path, or artifact reference', async () => {
    await enqueueTask(ctx({ state: 'eligible' }));
    await run(async () => ({
      result: 'success',
      context: ctx({ state: 'accepted' }),
      extraEvents: [snapshotCaptured(), draftRecorded(), critiquePassed()],
    }));
    const rows = await comments();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const body = row.payload.body;
      expect(body).not.toContain(FINGERPRINT);
      expect(body).not.toContain(PREDECESSOR_FINGERPRINT);
      expect(body).not.toContain('/tmp/test-repo');
      expect(body).not.toContain('.artifacts');
      expect(body).not.toContain('test-session');
      expect(body).not.toContain('run-refine-1');
      expect(body).not.toContain('undefined');
      expect(body.length).toBeLessThanOrEqual(1500);
    }
  });

  // -------------------------------------------------------------------------
  // The admin surfaces
  // -------------------------------------------------------------------------

  test('human and --json admin output agree, and JSON keeps the exact UTC deadline', async () => {
    await enqueueTask(ctx({ state: 'drafting' }));
    await run(async () => ({
      result: 'delayed',
      context: ctx({
        state: 'drafting',
        pendingRetry: { role: 'refiner', round: 1, attempt: 1, failureKind: 'usage_quota' },
      }),
      extraEvents: [agentFailed()],
    }));
    const task = await taskStore.getTask(KEY);

    // Read by a SECOND process against the same WAL database — the operator's
    // actual path to this state, and proof the view needs nothing but the row
    // and the event log.
    const args = ['task-status', '--session-id', 'test-session', '--issue-number', '99', '--db-path', dbPath];
    const json = JSON.parse(execFileSync(process.execPath, [CLI, ...args, '--json'], { encoding: 'utf8' }));
    const human = execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });

    const progress = json.tasks[0].refinement.progress;
    expect(progress.disposition).toBe('delayed');
    // The exact persisted instant, byte for byte — not a reformatted copy.
    expect(progress.retryNotBefore).toBe(task.notBefore);
    expect(progress.lastMilestone.retryNotBefore).toBe(task.notBefore);
    expect(progress.lastMilestone.occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/);
    expect(progress.schemaVersion).toBe(REFINEMENT_PROGRESS_SCHEMA_VERSION);
    expect(progress.failureClass).toBe('usage_quota');
    expect(progress.humanActionRequired).toBe(false);

    // Human output states the same facts, and states the deadline clearly.
    expect(human).toContain('progress: delayed');
    expect(human).toContain(`retry not before: ${task.notBefore} (UTC)`);
    expect(human).toContain('last milestone: retry_scheduled');
    expect(human).toContain('failure=usage_quota');

    // Existing defaults are untouched: no --json flag still prints text, the
    // pre-#977 refinement lines are still there, and nothing was mutated.
    expect(() => JSON.parse(human)).toThrow();
    expect(human).toContain('refinement: state=drafting');
    expect(human).toContain('roles: refiner=claude critic=codex');
  }, 30_000);

  test('a task outside the lane renders no progress and pays for no event read', async () => {
    await taskStore.enqueueTask({
      sessionId: 'test-session',
      issueNumber: 101,
      phase: 'implementation',
      now: NOW,
      context: { title: 'Ordinary Issue' },
    });
    const json = JSON.parse(execFileSync(
      process.execPath,
      [CLI, 'task-status', '--session-id', 'test-session', '--issue-number', '101',
        '--db-path', dbPath, '--json'],
      { encoding: 'utf8' },
    ));
    expect(json.tasks[0].refinement).toBeNull();
    expect(json.tasks[0].reviewDispute).toBeNull();
  }, 30_000);

  test('the admin UI renders the same normalized model, and adds no mutation', async () => {
    await enqueueTask(ctx({ state: 'critiquing' }));
    await run(async () => ({
      result: 'blocked',
      message: 'refinement escalated (no_convergence)',
      context: ctx({ state: 'escalated_human', handoffReason: 'no_convergence' }),
      extraEvents: [
        evt('refinement.escalated.human', { state: 'escalated_human', reason: 'no_convergence' }),
      ],
    }));
    const task = await taskStore.getTask(KEY);
    const taskEvents = await events();

    expect(hasRefinementState(task)).toBe(true);
    const uiLines = formatRefinementDetail(task, NOW, taskEvents);
    // The UI block is literally the shared renderer's output, not a second
    // interpretation of the milestones.
    const shared = renderRefinementProgressLines(
      summarizeRefinementProgress(task, taskEvents, NOW), '  ',
    );
    for (const line of shared) expect(uiLines).toContain(line);
    expect(formatTaskDetail(task, NOW, undefined, taskEvents)).toContain('progress: awaiting_human');
    expect(formatTaskDetail(task, NOW, undefined, taskEvents)).toContain('HUMAN ACTION REQUIRED');

    // The UI's refinement PROGRESS action is read-only; it offers no lane
    // mutation, and #977 added no way to re-run a stopped attempt from here.
    const actions = buildTaskMenuActions(task, NOW).map((a) => a.action);
    expect(actions).toContain('refinement');
    expect(actions).not.toContain('refinement-retry');
    // Issue #980 routes this terminal handoff to §13's recovery entry instead of
    // the generic human-handoff view — itself a read-only command view, so the
    // UI still mutates nothing on its own.
    expect(actions).toContain('refinement-recover');
    expect(actions).not.toContain('human-review');

    // And the `admin task-status` renderer prints the very same progress lines.
    const summary = summarizeRefinementStatus(task, taskEvents, NOW);
    const cliLines = renderRefinementLines(summary, '        ');
    for (const line of shared) {
      expect(cliLines.some((l) => l.trimStart() === line.trimStart())).toBe(true);
    }
  });

  test('without task events the UI reports progress as unread rather than as absent', async () => {
    await enqueueTask(ctx({ state: 'drafting' }));
    const task = await taskStore.getTask(KEY);
    const lines = formatRefinementDetail(task, NOW);
    expect(lines.join('\n')).toContain('progress: (task events not read)');
    expect(summarizeRefinementStatus(task).progress).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The normalized model itself
// ---------------------------------------------------------------------------

describe('the normalized refinement progress model', () => {
  const task = (over = {}) => ({
    sessionId: 'test-session',
    issueNumber: 99,
    status: 'queued',
    phase: 'refinement',
    priority: 'normal',
    attempts: {},
    context: { refinement: block() },
    createdAt: NOW,
    updatedAt: NOW,
    revision: 1,
    ...over,
  });

  test('the six dispositions are the closed operator vocabulary', () => {
    expect([...REFINEMENT_PROGRESS_DISPOSITIONS]).toEqual([
      'running', 'queued', 'delayed', 'activated', 'failed', 'awaiting_human',
    ]);
  });

  test('a task outside the lane projects to null', () => {
    expect(summarizeRefinementProgress(task({ context: {} }))).toBeNull();
    expect(summarizeRefinementProgress(task({ context: { refinement: { state: 'nope' } } }))).toBeNull();
  });

  test('a claimed or running row reads running', () => {
    expect(summarizeRefinementProgress(task({ status: 'claimed' }), [], NOW).disposition).toBe('running');
    expect(summarizeRefinementProgress(task({ status: 'running' }), [], NOW).disposition).toBe('running');
  });

  test('the §4 blocked hold reads queued, not failed', () => {
    const view = summarizeRefinementProgress(task({ status: 'blocked' }), [], NOW);
    expect(view.disposition).toBe('queued');
    expect(view.humanActionRequired).toBe(false);
  });

  test('the activation park reads activated only while the row is still parked', () => {
    const parked = task({
      status: 'blocked',
      phase: 'implementation',
      context: { refinement: block({ state: 'activated' }) },
    });
    expect(summarizeRefinementProgress(parked, [], NOW).disposition).toBe('activated');
    // §12 row 33 reactivates that very row; the block still says `activated`.
    const reactivated = summarizeRefinementProgress(
      { ...parked, status: 'queued' },
      [],
      NOW,
    );
    expect(reactivated.disposition).toBe('queued');
    expect(reactivated.refinementState).toBe('activated');
  });

  test('a retained terminal handoff state never overrides a re-queued row', () => {
    const handoff = { refinement: block({ state: 'escalated_human', handoffReason: 'no_convergence' }) };
    expect(
      summarizeRefinementProgress(task({ status: 'blocked', context: handoff }), [], NOW).disposition,
    ).toBe('awaiting_human');
    expect(
      summarizeRefinementProgress(task({ status: 'queued', context: handoff }), [], NOW).disposition,
    ).toBe('queued');
  });

  test('an operator cancellation reads failed', () => {
    expect(summarizeRefinementProgress(task({ status: 'cancelled' }), [], NOW).disposition)
      .toBe('failed');
  });

  test('a drifted block is projected, not hidden, and nothing is invented', () => {
    const view = summarizeRefinementProgress(
      task({ context: { refinement: { state: 'drafting', counters: { rounds: 'two' }, roles: {} } } }),
      [],
      NOW,
    );
    expect(view.refinementState).toBe('drafting');
    expect(view.round).toBeNull();
    expect(view.refinerAgent).toBeNull();
    expect(view.lastMilestone).toBeNull();
  });

  test('the human renderer omits absent fields rather than inventing placeholders', () => {
    const lines = renderRefinementProgressLines(
      summarizeRefinementProgress(task(), [], NOW),
    ).join('\n');
    expect(lines).toContain('progress: queued');
    expect(lines).toContain('last milestone: (none recorded)');
    expect(lines).not.toContain('retry not before');
    expect(lines).not.toContain('undefined');
    expect(lines).not.toContain('null');
  });

  test('the model never carries a fingerprint, a path, or a session id', () => {
    const serialized = JSON.stringify(
      summarizeRefinementProgress(task(), [], NOW),
    );
    expect(serialized).not.toContain(FINGERPRINT);
    expect(serialized).not.toContain(PREDECESSOR_FINGERPRINT);
    expect(serialized).not.toContain('/tmp/');
    expect(serialized).not.toContain('test-session');
  });
});
