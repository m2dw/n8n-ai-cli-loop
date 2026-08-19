/**
 * Integration tests: runNextPhase enqueues outbox side effects after handler
 * completion but does NOT dispatch them inline.
 */
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SqliteTaskStore } from '../dist/stores/sqlite-task-store.js';
import { SqliteOutboxStore } from '../dist/stores/sqlite-outbox-store.js';
import { runNextPhase } from '../dist/core/phase-runner.js';
import { checkReportOnlyAdmission } from '../dist/handlers/report-only-admission.js';

let tmpDir;
let dbPath;
let taskStore;
let outboxStore;

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
  labels: { active: 'ai:active', blocked: 'ai:blocked', readyForHuman: 'ai:ready-for-human' },
  // Resolved provider config (defaults to GitHub over gh, matching ResolvedSession).
  // The repo-host provider drives the public PR-timeline comment routing.
  workItemProvider: { provider: 'github-issues', auth: { mode: 'gh' } },
  repoHostProvider: { provider: 'github', auth: { mode: 'gh' } },
};

const NOW = '2026-06-07T10:00:00.000Z';

const REQUEST = {
  sessionId: 'test-session',
  workerId: 'w1',
  runId: 'run-1',
  now: NOW,
};

async function enqueueTask(phase, context = {}) {
  return taskStore.enqueueTask({
    sessionId: 'test-session',
    issueNumber: 99,
    phase,
    now: NOW,
    context,
  });
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'pr-outbox-test-'));
  dbPath = join(tmpDir, 'test.db');
  taskStore = new SqliteTaskStore(dbPath);
  outboxStore = new SqliteOutboxStore(dbPath);
});

afterEach(() => {
  taskStore.close();
  outboxStore.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('runNextPhase outbox side effects — implementation success', () => {
  test('enqueues comment; no coarse label (queued has no STATUS_LABEL entry)', async () => {
    await enqueueTask('implementation', {});
    const handler = async () => ({
      result: 'success',
      context: { prUrl: 'https://github.com/org/repo/pull/5', artifactDir: '/tmp/artifacts' },
      message: 'PR created',
    });

    const outcome = await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { implementation: handler },
      outboxStore,
      session: SESSION,
      now: NOW,
    });

    expect(outcome.status).toBe('completed');
    const pending = await outboxStore.listPending();

    // Comment is always emitted
    const comment = pending.find(e => e.topic === 'gh:comment');
    expect(comment).toBeDefined();
    expect(comment.payload.body).toContain('Implementation complete');
    expect(comment.payload.body).toContain('https://github.com/org/repo/pull/5');

    // SESSION has no needsReview/needsImplementation keys → no review-queue label effects
    const labelAdds = pending.filter(e => e.topic === 'gh:label:add');
    expect(labelAdds).toHaveLength(0);
    // Default needs-fix label is always removed so a stale status:needs-fix won't re-enter
    // the implementation lane after the task moves to review.
    const labelRemoves = pending.filter(e => e.topic === 'gh:label:remove');
    const removedLabels = labelRemoves.map(e => e.payload.label);
    expect(removedLabels).toContain('status:needs-fix');
  });

  test('enqueues needsReview add and needsImplementation remove when session labels configured', async () => {
    const sessionWithQueueLabels = {
      ...SESSION,
      labels: {
        ...SESSION.labels,
        needsReview: 'status:needs-review',
        needsImplementation: 'status:needs-implementation',
      },
    };
    await enqueueTask('implementation', {});
    const handler = async () => ({
      result: 'success',
      context: { prUrl: 'https://github.com/org/repo/pull/5' },
    });

    await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { implementation: handler },
      outboxStore,
      session: sessionWithQueueLabels,
      now: NOW,
    });

    const pending = await outboxStore.listPending();

    const labelAdds = pending.filter(e => e.topic === 'gh:label:add');
    const addedLabels = labelAdds.map(e => e.payload.label);
    expect(addedLabels).toContain('status:needs-review');

    const labelRemoves = pending.filter(e => e.topic === 'gh:label:remove');
    const removedLabels = labelRemoves.map(e => e.payload.label);
    expect(removedLabels).toContain('status:needs-implementation');
  });

  test('enqueues only needsReview add when needsImplementation not configured', async () => {
    const sessionWithReviewOnly = {
      ...SESSION,
      labels: {
        ...SESSION.labels,
        needsReview: 'status:needs-review',
      },
    };
    await enqueueTask('implementation', {});
    const handler = async () => ({
      result: 'success',
      context: { prUrl: 'https://github.com/org/repo/pull/7' },
    });

    await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { implementation: handler },
      outboxStore,
      session: sessionWithReviewOnly,
      now: NOW,
    });

    const pending = await outboxStore.listPending();

    const labelAdds = pending.filter(e => e.topic === 'gh:label:add');
    expect(labelAdds.map(e => e.payload.label)).toContain('status:needs-review');

    // No needsImplementation configured → no remove for it, but default needs-fix is always removed
    const labelRemoves = pending.filter(e => e.topic === 'gh:label:remove');
    const removedLabels = labelRemoves.map(e => e.payload.label);
    expect(removedLabels).not.toContain('status:needs-implementation');
    expect(removedLabels).toContain('status:needs-fix');
  });

  test('removes configured needsFix label when session.labels.needsFix is set', async () => {
    const sessionWithNeedsFix = {
      ...SESSION,
      labels: {
        ...SESSION.labels,
        needsReview: 'status:needs-review',
        needsFix: 'status:needs-fix',
      },
    };
    await enqueueTask('implementation', {});
    const handler = async () => ({
      result: 'success',
      context: { prUrl: 'https://github.com/org/repo/pull/8' },
    });

    await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { implementation: handler },
      outboxStore,
      session: sessionWithNeedsFix,
      now: NOW,
    });

    const pending = await outboxStore.listPending();
    const removedLabels = pending.filter(e => e.topic === 'gh:label:remove').map(e => e.payload.label);
    expect(removedLabels).toContain('status:needs-fix');
  });

  test('removes needs-fix label derived from task.context.labels when not configured in session', async () => {
    const sessionWithReviewOnly = {
      ...SESSION,
      labels: {
        ...SESSION.labels,
        needsReview: 'status:needs-review',
      },
    };
    await enqueueTask('implementation', { labels: ['agent:claude', 'status:needs-fix'] });
    const handler = async () => ({
      result: 'success',
      context: { prUrl: 'https://github.com/org/repo/pull/9' },
    });

    await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { implementation: handler },
      outboxStore,
      session: sessionWithReviewOnly,
      now: NOW,
    });

    const pending = await outboxStore.listPending();
    const removedLabels = pending.filter(e => e.topic === 'gh:label:remove').map(e => e.payload.label);
    expect(removedLabels).toContain('status:needs-fix');
  });

  test('removes default agentImplementation (agent:claude) even when not configured in session', async () => {
    // Regression: symmetric with the backward path (review→impl) which always adds agent:claude
    // by default. The forward path must always remove it so it doesn't linger on the issue.
    const sessionWithReviewNoAgentImpl = {
      ...SESSION,
      labels: {
        ...SESSION.labels,
        needsReview: 'status:needs-review',
        needsImplementation: 'status:needs-implementation',
        // agentImplementation deliberately omitted
      },
    };
    await enqueueTask('implementation', {});
    const handler = async () => ({
      result: 'success',
      context: { prUrl: 'https://github.com/org/repo/pull/12' },
    });

    await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { implementation: handler },
      outboxStore,
      session: sessionWithReviewNoAgentImpl,
      now: NOW,
    });

    const pending = await outboxStore.listPending();
    const removedLabels = pending.filter(e => e.topic === 'gh:label:remove').map(e => e.payload.label);
    // Default "agent:claude" must be removed even though agentImplementation is not in session config
    expect(removedLabels).toContain('agent:claude');
  });

  test('adds agentReview and removes agentImplementation when agent labels configured', async () => {
    const sessionWithAgentLabels = {
      ...SESSION,
      labels: {
        ...SESSION.labels,
        needsReview: 'status:needs-review',
        needsImplementation: 'status:needs-implementation',
        agentReview: 'agent:codex',
        agentImplementation: 'agent:claude',
      },
    };
    await enqueueTask('implementation', {});
    const handler = async () => ({
      result: 'success',
      context: { prUrl: 'https://github.com/org/repo/pull/10' },
    });

    await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { implementation: handler },
      outboxStore,
      session: sessionWithAgentLabels,
      now: NOW,
    });

    const pending = await outboxStore.listPending();
    const addedLabels = pending.filter(e => e.topic === 'gh:label:add').map(e => e.payload.label);
    const removedLabels = pending.filter(e => e.topic === 'gh:label:remove').map(e => e.payload.label);

    expect(addedLabels).toContain('agent:codex');
    expect(removedLabels).toContain('agent:claude');
  });

  test('adds default review agent label (agent:codex) when agentReview not configured', async () => {
    const sessionWithoutAgentLabels = {
      ...SESSION,
      labels: {
        ...SESSION.labels,
        needsReview: 'status:needs-review',
        needsImplementation: 'status:needs-implementation',
      },
    };
    await enqueueTask('implementation', {});
    const handler = async () => ({
      result: 'success',
      context: { prUrl: 'https://github.com/org/repo/pull/11' },
    });

    await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { implementation: handler },
      outboxStore,
      session: sessionWithoutAgentLabels,
      now: NOW,
    });

    const pending = await outboxStore.listPending();
    const addedLabels = pending.filter(e => e.topic === 'gh:label:add').map(e => e.payload.label);
    const removedLabels = pending.filter(e => e.topic === 'gh:label:remove').map(e => e.payload.label);

    // needsReview is configured → github-intake requires agent:codex + status:needs-review,
    // so default to agent:codex when agentReview is not explicitly set
    expect(addedLabels).toContain('agent:codex');
    expect(addedLabels).not.toContain('agent:claude');
    expect(removedLabels).not.toContain('agent:codex');
    // agentImplementation not configured → falls back to default "agent:claude" removal
    // (symmetric with the unconditional add in the review→implementation backward path)
    expect(removedLabels).toContain('agent:claude');
  });

  test('emits review status label alongside the agent label under minimal config with a persisted assignment', async () => {
    // Regression: a persisted context.assignment always carries a reviewAgent, so
    // `agentReview` is truthy for every intake-created task even when the session
    // omits the needsReview/needsImplementation label keys (minimal config). The
    // forward path must never advertise agent:<reviewAgent> without a review status
    // label; otherwise the issue is left as status:needs-implementation +
    // agent:<reviewAgent> and the next intake scan re-enqueues implementation
    // instead of review (or leaves the review task unadvertised).
    await enqueueTask('implementation', {
      assignment: { implementationAgent: 'claude', reviewAgent: 'gemini', conflictResolutionAgent: 'codex' },
    });
    const handler = async () => ({
      result: 'success',
      context: { prUrl: 'https://github.com/org/repo/pull/13' },
    });

    await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { implementation: handler },
      outboxStore,
      session: SESSION,
      now: NOW,
    });

    const pending = await outboxStore.listPending();
    const addedLabels = pending.filter(e => e.topic === 'gh:label:add').map(e => e.payload.label);
    // The assignment routes review to Gemini, so the agent label reflects the
    // resolved review agent — but it is always paired with a review status label.
    expect(addedLabels).toContain('agent:gemini');
    expect(addedLabels).toContain('status:needs-review');
  });

  test('clears a stale stack-ready marker when a requeued issue is reimplemented', async () => {
    // An issue can carry status:stack-ready from a prior passing review and then
    // be requeued straight into implementation/fix (e.g. a maintainer adds
    // status:needs-fix after requesting changes), bypassing the review-only
    // cleanup path. The successful implementation pushes new, unreviewed commits,
    // so the stale marker must be cleared — otherwise the dependency resolver
    // keeps treating the blocker as a usable stacking base while its latest
    // changes have not passed review (issue #208 review follow-up).
    await enqueueTask('implementation', {});
    const handler = async () => ({
      result: 'success',
      context: { prUrl: 'https://github.com/org/repo/pull/5' },
    });

    await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { implementation: handler },
      outboxStore,
      session: SESSION,
      now: NOW,
    });

    const pending = await outboxStore.listPending();
    const removedLabels = pending.filter(e => e.topic === 'gh:label:remove').map(e => e.payload.label);
    expect(removedLabels).toContain('status:stack-ready');
    // The marker must not be (re-)added by an implementation run.
    const addedLabels = pending.filter(e => e.topic === 'gh:label:add').map(e => e.payload.label);
    expect(addedLabels).not.toContain('status:stack-ready');
  });
});

describe('runNextPhase outbox side effects — implementation failure', () => {
  test('enqueues failure comment without artifactDir when context absent', async () => {
    await enqueueTask('implementation', {});
    const handler = async () => ({
      result: 'failed',
      error: 'git push failed: authentication error',
    });

    await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { implementation: handler },
      outboxStore,
      session: SESSION,
      now: NOW,
    });

    const pending = await outboxStore.listPending();
    const comment = pending.find(e => e.topic === 'gh:comment');
    expect(comment).toBeDefined();
    expect(comment.payload.body).toContain('Implementation failed');
    expect(comment.payload.body).toContain('git push failed');
  });

  test('enqueues failure comment with error when context provided', async () => {
    await enqueueTask('implementation', {});
    const handler = async () => ({
      result: 'failed',
      context: { artifactDir: '/tmp/artifacts/run-1' },
      error: 'Claude exited 1: compilation error',
    });

    await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { implementation: handler },
      outboxStore,
      session: SESSION,
      now: NOW,
    });

    const pending = await outboxStore.listPending();
    const comment = pending.find(e => e.topic === 'gh:comment');
    expect(comment).toBeDefined();
    expect(comment.payload.body).toContain('Implementation failed');
    expect(comment.payload.body).toContain('Claude exited 1');
    expect(comment.payload.body).not.toContain('/tmp/artifacts/run-1');
  });
});

describe('runNextPhase outbox side effects — implementation blocked', () => {
  const SESSION_WITH_IMPL_LABELS = {
    ...SESSION,
    labels: {
      ...SESSION.labels,
      needsImplementation: 'status:needs-implementation',
      agentImplementation: 'agent:claude',
    },
  };

  test('enqueues blocked comment and ai:blocked label (not readyForHuman) — issue #224', async () => {
    // A dependency-blocked implementation task must transition to `blocked` status
    // (not `ready_for_human`) so intake can re-enqueue it when the blocker becomes
    // stack-ready. This means the outbox adds the `blocked` label (ai:blocked),
    // not the `readyForHuman` label.
    await enqueueTask('implementation', {});
    const handler = async () => ({
      result: 'blocked',
      message: 'Open blockers: #50',
      context: {},
    });

    await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { implementation: handler },
      outboxStore,
      session: SESSION_WITH_IMPL_LABELS,
      now: NOW,
    });

    const pending = await outboxStore.listPending();
    const comment = pending.find(e => e.topic === 'gh:comment');
    expect(comment).toBeDefined();
    expect(comment.payload.body).toContain('Implementation blocked');
    expect(comment.payload.body).toContain('#50');

    const labelAdd = pending.find(e => e.topic === 'gh:label:add');
    expect(labelAdd).toBeDefined();
    // Must be ai:blocked (the `blocked` status label), NOT ai:ready-for-human
    expect(labelAdd.payload.label).toBe('ai:blocked');
    expect(labelAdd.payload.label).not.toBe('ai:ready-for-human');
  });

  test('does NOT remove needsImplementation and agentImplementation labels when blocked — issue #224', async () => {
    // A dep-blocked task must keep implementation-lane labels on the GitHub issue
    // so intake can re-find and re-enqueue it when the blocker becomes ready.
    // Previously these labels were removed (treating blocked as a terminal
    // escalation), which prevented re-enqueue.
    await enqueueTask('implementation', {});
    const handler = async () => ({
      result: 'blocked',
      message: 'Open blockers: #50',
      context: {},
    });

    await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { implementation: handler },
      outboxStore,
      session: SESSION_WITH_IMPL_LABELS,
      now: NOW,
    });

    const pending = await outboxStore.listPending();
    const removedLabels = pending.filter(e => e.topic === 'gh:label:remove').map(e => e.payload.label);
    expect(removedLabels).not.toContain('status:needs-implementation');
    expect(removedLabels).not.toContain('agent:claude');
  });

  test('does not remove implementation labels when session has no impl label config', async () => {
    await enqueueTask('implementation', {});
    const handler = async () => ({
      result: 'blocked',
      message: 'Open blockers: #50',
      context: {},
    });

    await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { implementation: handler },
      outboxStore,
      session: SESSION, // no needsImplementation / agentImplementation keys
      now: NOW,
    });

    const pending = await outboxStore.listPending();
    const removedLabels = pending.filter(e => e.topic === 'gh:label:remove').map(e => e.payload.label);
    expect(removedLabels).not.toContain('status:needs-implementation');
  });
});

describe('runNextPhase outbox side effects — implementation needs_fix (verification requeue, issue #934)', () => {
  const sessionWithLaneLabels = {
    ...SESSION,
    labels: {
      ...SESSION.labels,
      needsReview: 'status:needs-review',
      needsImplementation: 'status:needs-implementation',
      needsFix: 'status:needs-fix',
      agentReview: 'agent:codex',
      agentImplementation: 'agent:claude',
    },
  };

  test('requeues to implementation and publishes no comment or lane-label churn', async () => {
    await enqueueTask('implementation', {});
    const handler = async () => ({
      result: 'needs_fix',
      context: { artifactDir: '/tmp/artifacts', verificationRepairCycles: 1 },
      message: "Verification 'test' failed (exit 1) before commit/push; requeueing implementation",
    });

    const outcome = await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { implementation: handler },
      outboxStore,
      session: sessionWithLaneLabels,
      now: NOW,
    });

    expect(outcome.status).toBe('completed');
    expect(outcome.task).toMatchObject({ status: 'queued', phase: 'implementation' });

    const pending = await outboxStore.listPending();
    // No routine public comment for an automatic retry: nothing an operator
    // needs to act on changed.
    expect(pending.filter(e => e.topic === 'gh:comment')).toHaveLength(0);
    expect(pending.filter(e => e.topic === 'repohost:pr-comment')).toHaveLength(0);
    expect(pending.filter(e => e.topic === 'repohost:pr-summary')).toHaveLength(0);
    // The task never left the implementation lane, so its labels are already
    // correct — in particular `status:needs-fix` is NOT added to an issue that
    // may not even have a PR yet.
    expect(pending.filter(e => e.topic.startsWith('gh:label:'))).toHaveLength(0);
  });

  test('a review needs_fix still swaps the lane labels (unchanged)', async () => {
    await enqueueTask('review', { prUrl: 'https://github.com/org/repo/pull/5' });
    const handler = async () => ({
      result: 'needs_fix',
      context: { reviewFeedback: '[P1] fix this', prUrl: 'https://github.com/org/repo/pull/5' },
    });

    await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { review: handler },
      outboxStore,
      session: sessionWithLaneLabels,
      now: NOW,
    });

    const pending = await outboxStore.listPending();
    const added = pending.filter(e => e.topic === 'gh:label:add').map(e => e.payload.label);
    expect(added).toContain('status:needs-fix');
    expect(added).toContain('agent:claude');
  });
});

describe('runNextPhase outbox side effects — review success', () => {
  test('enqueues review success comment and readyForHuman label', async () => {
    await enqueueTask('review', { prUrl: 'https://github.com/org/repo/pull/5', branch: 'ai/issue-99' });
    const handler = async () => ({
      result: 'success',
      context: { artifactDir: '/tmp/review-artifacts', classification: 'success' },
      message: 'No blocking findings detected',
    });

    await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { review: handler },
      outboxStore,
      session: SESSION,
      now: NOW,
    });

    const pending = await outboxStore.listPending();
    const comment = pending.find(e => e.topic === 'gh:comment');
    expect(comment).toBeDefined();
    expect(comment.payload.body).toContain('Review passed');

    // review success → ready_for_human → readyForHuman label
    const labelAdd = pending.find(e => e.topic === 'gh:label:add');
    expect(labelAdd).toBeDefined();
    expect(labelAdd.payload.label).toBe('ai:ready-for-human');

    // Other labels should be removed
    const labelRemoves = pending.filter(e => e.topic === 'gh:label:remove');
    const removedLabels = labelRemoves.map(e => e.payload.label);
    expect(removedLabels).toContain('ai:active');
    expect(removedLabels).toContain('ai:blocked');
  });

  test('dependency-started review success hands off as ready_for_human, not blocked (issue #242)', async () => {
    // A task whose implementation branch was created from a blocker PR head
    // carries dependencyBase in its context. Because the dependent PR targets the
    // session base branch (`main`) like any other PR, a passing review follows the
    // normal ready_for_human handoff. It must NOT be held as blocked merely
    // because dependencyBase is present (issue #242).
    await enqueueTask('review', {
      prUrl: 'https://github.com/org/repo/pull/5',
      branch: 'ai/issue-99',
      dependencyBase: {
        baseIssueNumber: 50,
        basePrNumber: 55,
        baseHeadRefName: 'ai/issue-50',
        basePrUrl: 'https://github.com/org/repo/pull/55',
      },
    });
    const handler = async () => ({
      result: 'success',
      context: { artifactDir: '/tmp/review-artifacts', classification: 'success' },
      message: 'No blocking findings detected',
    });

    const outcome = await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { review: handler },
      outboxStore,
      session: SESSION,
      now: NOW,
    });

    // Normal handoff: ready_for_human, NOT blocked, despite dependencyBase.
    expect(outcome.status).toBe('completed');
    expect(outcome.task.status).toBe('ready_for_human');

    const pending = await outboxStore.listPending();

    // ready_for_human → ready_for_human label added; blocked label NOT added.
    const labelAdds = pending.filter(e => e.topic === 'gh:label:add').map(e => e.payload.label);
    expect(labelAdds).toContain('ai:ready-for-human');
    expect(labelAdds).not.toContain('ai:blocked');

    // A stack-readiness marker IS added so downstream dependents (A<-B<-C) can
    // recognise this reviewed blocker as a usable start point.
    expect(labelAdds).toContain('status:stack-ready');

    // The review-success comment is a normal pass — no "stacked / not mergeable"
    // caveat (issue #242).
    const comment = pending.find(e => e.topic === 'gh:comment');
    expect(comment.payload.body).toContain('Review passed');
    expect(comment.payload.body).not.toContain('stacked on a dependency branch');
  });

  test('non-stacked review success adds the stack-readiness marker (usable base)', async () => {
    await enqueueTask('review', { prUrl: 'https://github.com/org/repo/pull/5', branch: 'ai/issue-99' });
    const handler = async () => ({
      result: 'success',
      context: { artifactDir: '/tmp/review-artifacts', classification: 'success' },
      message: 'No blocking findings detected',
    });

    await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { review: handler },
      outboxStore,
      session: SESSION,
      now: NOW,
    });

    const pending = await outboxStore.listPending();
    const labelAdds = pending.filter(e => e.topic === 'gh:label:add').map(e => e.payload.label);
    // Ordinary review success is merge-ready (ai:ready-for-human) AND a usable
    // stacking base: the stack-ready marker is the success-specific signal the
    // dependency resolver keys on, applied on every passing review — not just a
    // stacked one — because readyForHuman is also applied to escalated reviews
    // that did not pass (issue #208 review follow-up).
    expect(labelAdds).toContain('ai:ready-for-human');
    expect(labelAdds).toContain('status:stack-ready');
  });

  test('lane-swap review success clears the stale implementation agent + queue labels (issue #264)', async () => {
    // A Codex implementation routed to Gemini review carries a stale agent:codex +
    // status:needs-implementation on the issue (added only so Gemini wins intake).
    // On a passing review the ready_for_human handoff must clear them: labelsToPhase
    // keys on an agent:* label, so a lingering agent:codex paired with a status
    // label would let later scans reclassify the already-approved issue back into
    // Codex implementation/review instead of a clean human handoff.
    await enqueueTask('review', {
      prUrl: 'https://github.com/org/repo/pull/7',
      branch: 'ai/issue-99',
      assignment: { implementationAgent: 'codex', reviewAgent: 'gemini', conflictResolutionAgent: 'claude' },
    });
    const handler = async () => ({
      result: 'success',
      context: { artifactDir: '/tmp/review-artifacts', classification: 'success' },
      message: 'No blocking findings detected',
    });

    await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { review: handler },
      outboxStore,
      session: SESSION, // minimal config: no needsReview/needsImplementation keys
      now: NOW,
    });

    const pending = await outboxStore.listPending();
    const removedLabels = pending.filter(e => e.topic === 'gh:label:remove').map(e => e.payload.label);
    // Stale implementation agent label cleared (resolved via the persisted assignment).
    expect(removedLabels).toContain('agent:codex');
    // Resolved review agent label cleared by the review-lane block.
    expect(removedLabels).toContain('agent:gemini');
    // Default implementation queue status label cleared even under the minimal config.
    expect(removedLabels).toContain('status:needs-implementation');
    // Still a clean ready_for_human handoff.
    const addedLabels = pending.filter(e => e.topic === 'gh:label:add').map(e => e.payload.label);
    expect(addedLabels).toContain('ai:ready-for-human');
  });

  test('minimal-config review success clears the default status:needs-review (issue #264)', async () => {
    // Under the minimal label config the implementation→review requeue adds the
    // default `status:needs-review` even though session.labels.needsReview is unset.
    // A passing review must clear that default on the ready_for_human handoff, or
    // the human-ready issue keeps `status:needs-review`; combined with a lingering
    // agent label a later label-driven intake would treat it as queued for review.
    await enqueueTask('review', { prUrl: 'https://github.com/org/repo/pull/9', branch: 'ai/issue-99' });
    const handler = async () => ({
      result: 'success',
      context: { artifactDir: '/tmp/review-artifacts', classification: 'success' },
      message: 'No blocking findings detected',
    });

    await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { review: handler },
      outboxStore,
      session: SESSION, // minimal config: no needsReview key
      now: NOW,
    });

    const pending = await outboxStore.listPending();
    const removedLabels = pending.filter(e => e.topic === 'gh:label:remove').map(e => e.payload.label);
    expect(removedLabels).toContain('status:needs-review');
    const addedLabels = pending.filter(e => e.topic === 'gh:label:add').map(e => e.payload.label);
    expect(addedLabels).toContain('ai:ready-for-human');
    // The default status must not be re-added on the human handoff.
    expect(addedLabels).not.toContain('status:needs-review');
  });
});

describe('runNextPhase outbox side effects — research handoff (issue #264)', () => {
  const SESSION_WITH_RESEARCH = {
    ...SESSION,
    defaults: { ...SESSION.defaults, researchAgent: 'gemini' },
  };

  test('research success clears the research-lane labels on ready_for_human handoff', async () => {
    // Research is terminal: nextPhaseAfter("research", "success") hands off to a
    // human. The research-lane labels (agent:gemini + status:research-needed) must
    // be cleared so a later Codex review intake does not see a stale agent:gemini
    // and misroute the review to Gemini (the agent:codex review rule is suppressed
    // whenever agent:gemini is present).
    await enqueueTask('research', { artifactDir: '/tmp/research-artifacts' });
    const handler = async () => ({
      result: 'success',
      context: { artifactDir: '/tmp/research-artifacts', researchAgentUsed: 'gemini', researchOutput: 'findings' },
      message: 'Research complete',
    });

    const outcome = await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { research: handler },
      outboxStore,
      session: SESSION_WITH_RESEARCH,
      now: NOW,
    });

    expect(outcome.task.status).toBe('ready_for_human');

    const pending = await outboxStore.listPending();
    const removedLabels = pending.filter(e => e.topic === 'gh:label:remove').map(e => e.payload.label);
    expect(removedLabels).toContain('status:research-needed');
    expect(removedLabels).toContain('agent:gemini');
    // Normal human handoff still applies.
    const addedLabels = pending.filter(e => e.topic === 'gh:label:add').map(e => e.payload.label);
    expect(addedLabels).toContain('ai:ready-for-human');
  });
});

describe('runNextPhase outbox side effects — review needs_fix (auto-requeue)', () => {
  test('enqueues requeue comment; no readyForHuman label (task goes to queued impl)', async () => {
    await enqueueTask('review', { prUrl: 'https://github.com/org/repo/pull/5', branch: 'ai/issue-99' });
    const handler = async () => ({
      result: 'needs_fix',
      context: {
        artifactDir: '/tmp/review-artifacts',
        reviewOutputPath: '/tmp/review-artifacts/review-output.md',
        classification: 'needs_fix',
        hasBlockingFindings: true,
        findingCount: 2,
        reviewFeedback: '[P1] Null pointer in auth handler\n[P2] Missing input validation',
      },
      message: 'Review output contains blocking (P1/P2) findings',
    });

    await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { review: handler },
      outboxStore,
      session: SESSION,
      now: NOW,
    });

    const pending = await outboxStore.listPending();
    const comment = pending.find(e => e.topic === 'gh:comment');
    expect(comment).toBeDefined();
    expect(comment.payload.body).toContain('automatically requeuing to fix mode');
    // Should include a bounded excerpt of reviewFeedback
    expect(comment.payload.body).toContain('[P1] Null pointer in auth handler');
    // Should NOT include local filesystem paths
    expect(comment.payload.body).not.toContain('/tmp/review-artifacts/review-output.md');

    // needs_fix → queued implementation (status "queued" has no coarse label)
    const labelAdds = pending.filter(e => e.topic === 'gh:label:add');
    const addedLabels = labelAdds.map(e => e.payload.label);
    expect(addedLabels).not.toContain('ai:ready-for-human');
    // SESSION omits the optional needsReview/agentReview keys, so the review task
    // entered via the default GitHub labels. The needs_fix requeue must still strip
    // the default review lane labels (status:needs-review + agent:codex); otherwise
    // the issue carries both status:needs-review and status:needs-fix and a stale
    // review lane leaks into later label-based scans (issue #264 follow-up). These
    // come after the always-issued stale-marker cleanups (stack-ready +
    // ready-for-human) on a review that requeues the PR for more work — clearing
    // the latter prevents the dependency resolver from treating a blocker PR that
    // now needs fixes as implementation-complete (issue #208 follow-up).
    const removedLabels = pending.filter(e => e.topic === 'gh:label:remove').map(e => e.payload.label);
    expect(removedLabels).toEqual([
      'status:stack-ready',
      'ai:ready-for-human',
      'status:needs-review',
      'agent:codex',
    ]);
  });

  test('removes a stale ready-for-human marker when a later review fails (needs_fix)', async () => {
    // A blocker PR that previously passed review carries ai:ready-for-human. The
    // dependency resolver treats that label as implementation-complete, so a
    // downstream dependent could stack on it. When a later review routes back to
    // needs_fix the PR is no longer ready, so the marker must be cleared even
    // though needs_fix maps to a `queued` status with no coarse label of its own
    // (issue #208 follow-up).
    await enqueueTask('review', { prUrl: 'https://github.com/org/repo/pull/5', branch: 'ai/issue-99' });
    const handler = async () => ({
      result: 'needs_fix',
      context: {
        classification: 'needs_fix',
        hasBlockingFindings: true,
        findingCount: 1,
        reviewFeedback: '[P2] Regression introduced',
      },
      message: 'Review output contains blocking findings',
    });

    await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { review: handler },
      outboxStore,
      session: SESSION,
      now: NOW,
    });

    const pending = await outboxStore.listPending();
    const removedLabels = pending.filter(e => e.topic === 'gh:label:remove').map(e => e.payload.label);
    expect(removedLabels).toContain('ai:ready-for-human');
    // The marker must not be (re-)added on a failing review.
    const addedLabels = pending.filter(e => e.topic === 'gh:label:add').map(e => e.payload.label);
    expect(addedLabels).not.toContain('ai:ready-for-human');
  });

  test('removes a stale stack-ready marker when a later review fails (needs_fix)', async () => {
    // A stacked PR that previously passed review carries status:stack-ready. If a
    // later review (e.g. after the blocker merged and the PR was retargeted) finds
    // blocking fixes and routes back to needs_fix, the stale marker must be
    // removed so downstream intake stops treating the blocker as
    // implementation-complete and does not stack new dependents on a PR that now
    // needs fixes (issue #208 review follow-up).
    await enqueueTask('review', {
      prUrl: 'https://github.com/org/repo/pull/5',
      branch: 'ai/issue-99',
      dependencyBase: {
        baseIssueNumber: 50,
        basePrNumber: 55,
        baseHeadRefName: 'ai/issue-50',
        basePrUrl: 'https://github.com/org/repo/pull/55',
      },
    });
    const handler = async () => ({
      result: 'needs_fix',
      context: {
        artifactDir: '/tmp/review-artifacts',
        classification: 'needs_fix',
        hasBlockingFindings: true,
        findingCount: 1,
        reviewFeedback: '[P2] Regression introduced',
      },
      message: 'Review output contains blocking findings',
    });

    await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { review: handler },
      outboxStore,
      session: SESSION,
      now: NOW,
    });

    const pending = await outboxStore.listPending();
    const removedLabels = pending.filter(e => e.topic === 'gh:label:remove').map(e => e.payload.label);
    expect(removedLabels).toContain('status:stack-ready');
    // The marker must not be (re-)added on a failing review.
    const addedLabels = pending.filter(e => e.topic === 'gh:label:add').map(e => e.payload.label);
    expect(addedLabels).not.toContain('status:stack-ready');
  });

  test('removes needsReview label when session labels configured', async () => {
    const sessionWithQueueLabels = {
      ...SESSION,
      labels: {
        ...SESSION.labels,
        needsReview: 'status:needs-review',
        needsImplementation: 'status:needs-implementation',
      },
    };
    await enqueueTask('review', { prUrl: 'https://github.com/org/repo/pull/5', branch: 'ai/issue-99' });
    const handler = async () => ({
      result: 'needs_fix',
      context: {
        classification: 'needs_fix',
        reviewFeedback: '[P1] Missing validation',
      },
      message: 'Review found blocking findings',
    });

    await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { review: handler },
      outboxStore,
      session: sessionWithQueueLabels,
      now: NOW,
    });

    const pending = await outboxStore.listPending();
    const labelRemoves = pending.filter(e => e.topic === 'gh:label:remove');
    const removedLabels = labelRemoves.map(e => e.payload.label);
    expect(removedLabels).toContain('status:needs-review');
    // needsImplementation is NOT added back (fix mode uses needs-fix label, not needs-implementation)
    const labelAdds = pending.filter(e => e.topic === 'gh:label:add');
    expect(labelAdds.map(e => e.payload.label)).not.toContain('status:needs-implementation');
  });

  test('fix requeue adds the assignment-aware implementation agent label (issue #264 follow-up)', async () => {
    // A Codex implementation → Gemini review task (minimal labels) persists
    // implementationAgent: "codex" in its assignment but carries no
    // agentImplementation session key. When the Gemini review returns needs_fix the
    // requeue must advertise agent:codex — falling back to agent:claude would point
    // label-driven recovery/intake at the wrong worker even though the DB task
    // continues with Codex.
    await enqueueTask('review', {
      prUrl: 'https://github.com/org/repo/pull/5',
      branch: 'ai/issue-99',
      assignment: { implementationAgent: 'codex', reviewAgent: 'gemini', conflictResolutionAgent: 'codex' },
    });
    const handler = async () => ({
      result: 'needs_fix',
      context: {
        classification: 'needs_fix',
        hasBlockingFindings: true,
        findingCount: 1,
        reviewFeedback: '[P1] Missing validation',
      },
      message: 'Review found blocking findings',
    });

    await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { review: handler },
      outboxStore,
      session: SESSION, // no agentImplementation session key
      now: NOW,
    });

    const pending = await outboxStore.listPending();
    const addedLabels = pending.filter(e => e.topic === 'gh:label:add').map(e => e.payload.label);
    expect(addedLabels).toContain('agent:codex');
    expect(addedLabels).not.toContain('agent:claude');
  });

  test('minimal-config needs_fix clears the default status:needs-review (issue #264)', async () => {
    // SESSION omits the optional needsReview/agentReview keys, so the review-queue
    // block added the default status:needs-review when the task was queued. A
    // needs_fix requeue must remove that fallback alongside the agent label;
    // otherwise the issue carries both status:needs-review and status:needs-fix and
    // a transient/partial outbox dispatch lets later label-based scans see the
    // stale review lane. Mirrors the conflict-resolution and ready-for-human
    // cleanup paths.
    await enqueueTask('review', { prUrl: 'https://github.com/org/repo/pull/5', branch: 'ai/issue-99' });
    const handler = async () => ({
      result: 'needs_fix',
      context: {
        classification: 'needs_fix',
        hasBlockingFindings: true,
        findingCount: 1,
        reviewFeedback: '[P1] Missing validation',
      },
      message: 'Review found blocking findings',
    });

    const outcome = await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { review: handler },
      outboxStore,
      session: SESSION, // no needsReview/agentReview keys
      now: NOW,
    });

    expect(outcome.task).toMatchObject({ status: 'queued', phase: 'implementation' });

    const pending = await outboxStore.listPending();
    const removedLabels = pending.filter(e => e.topic === 'gh:label:remove').map(e => e.payload.label);
    const addedLabels = pending.filter(e => e.topic === 'gh:label:add').map(e => e.payload.label);
    expect(removedLabels).toContain('status:needs-review');
    expect(removedLabels).toContain('agent:codex');
    expect(addedLabels).toContain('status:needs-fix');
    // The stale review lane must not also be re-added on the requeue.
    expect(addedLabels).not.toContain('status:needs-review');
  });
});

describe('runNextPhase outbox side effects — review blocked (conflict escalated)', () => {
  test('enqueues escalated comment with conflict note and readyForHuman label', async () => {
    await enqueueTask('review', { prUrl: 'https://github.com/org/repo/pull/5', branch: 'ai/issue-99' });
    const handler = async () => ({
      result: 'blocked',
      context: {
        artifactDir: '/tmp/review-artifacts',
        classification: 'conflict',
        hasConflictSignal: true,
        findingCount: 0,
      },
      message: 'Review output contains merge-conflict signals — escalating to human (conflict resolution not yet automated)',
    });

    await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { review: handler },
      outboxStore,
      session: SESSION,
      now: NOW,
    });

    const pending = await outboxStore.listPending();
    const comment = pending.find(e => e.topic === 'gh:comment');
    expect(comment).toBeDefined();
    expect(comment.payload.body).toContain('Review escalated to human');
    // Conflict-specific guidance only when classification === 'conflict'
    expect(comment.payload.body).toContain('Conflict handling is not automated');

    // blocked → ready_for_human label
    const labelAdd = pending.find(e => e.topic === 'gh:label:add');
    expect(labelAdd).toBeDefined();
    expect(labelAdd.payload.label).toBe('ai:ready-for-human');
  });

  test('enqueues escalated comment WITHOUT conflict note when classification is not conflict', async () => {
    await enqueueTask('review', { prUrl: 'https://github.com/org/repo/pull/5', branch: 'ai/issue-99' });
    const handler = async () => ({
      result: 'blocked',
      context: {
        artifactDir: '/tmp/review-artifacts',
        classification: 'blocked', // empty/ambiguous output, not a conflict
      },
      message: 'Review output was empty or ambiguous',
    });

    await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { review: handler },
      outboxStore,
      session: SESSION,
      now: NOW,
    });

    const pending = await outboxStore.listPending();
    const comment = pending.find(e => e.topic === 'gh:comment');
    expect(comment).toBeDefined();
    expect(comment.payload.body).toContain('Review escalated to human');
    expect(comment.payload.body).toContain('Review output was empty or ambiguous');
    // Must NOT include conflict-specific note
    expect(comment.payload.body).not.toContain('Conflict handling is not automated');
  });

  test('enqueues review loop cap comment when reviewLoopCapReached is true', async () => {
    await enqueueTask('review', { prUrl: 'https://github.com/org/repo/pull/5', branch: 'ai/issue-99' });
    const handler = async () => ({
      result: 'blocked',
      context: {
        artifactDir: '/tmp/review-artifacts',
        classification: 'needs_fix',
        reviewLoopCapReached: true,
        reviewCycles: 5,
        reviewLoopMaxCycles: 5,
      },
      message: 'Review loop cap reached after 5/5 blocking cycles — escalating to human.',
    });

    await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { review: handler },
      outboxStore,
      session: SESSION,
      now: NOW,
    });

    const pending = await outboxStore.listPending();
    const comment = pending.find(e => e.topic === 'gh:comment' && e.payload.issueNumber === 99);
    expect(comment).toBeDefined();
    expect(comment.payload.body).toContain('Review loop cap reached');
    expect(comment.payload.body).toContain('5/5');
    expect(comment.payload.body).toContain('quota consumption');
    // Must NOT show the generic "escalated to human" text
    expect(comment.payload.body).not.toContain('Review escalated to human');
    // readyForHuman label still added
    const labelAdd = pending.find(e => e.topic === 'gh:label:add');
    expect(labelAdd?.payload.label).toBe('ai:ready-for-human');
  });
});

describe('runNextPhase outbox side effects — review failed (codex error)', () => {
  test('enqueues failure comment with output excerpt', async () => {
    await enqueueTask('review', { prUrl: 'https://github.com/org/repo/pull/5', branch: 'ai/issue-99' });
    const handler = async () => ({
      result: 'failed',
      context: {
        artifactDir: '/tmp/review-artifacts',
        reviewOutputPath: '/tmp/review-artifacts/review-output.md',
        reviewFailureOutput: 'ERROR: codex crashed with SIGABRT\nStack trace here',
      },
      error: 'Codex review exited 1: ERROR: codex crashed',
    });

    await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { review: handler },
      outboxStore,
      session: SESSION,
      now: NOW,
    });

    const pending = await outboxStore.listPending();
    const comment = pending.find(e => e.topic === 'gh:comment');
    expect(comment).toBeDefined();
    expect(comment.payload.body).toContain('Review failed');
    expect(comment.payload.body).toContain('Codex review exited 1');
    // Should include output excerpt
    expect(comment.payload.body).toContain('ERROR: codex crashed with SIGABRT');
    // Should NOT include local filesystem paths
    expect(comment.payload.body).not.toContain('/tmp/review-artifacts/review-output.md');
  });
});

describe('runNextPhase outbox side effects — research success', () => {
  test('enqueues comment with research findings excerpt', async () => {
    await enqueueTask('research', {});
    const handler = async () => ({
      result: 'success',
      context: {
        artifactDir: '/tmp/research-artifacts/run-1',
        researchAgentUsed: 'gemini',
        researchOutput: '## Findings\n\nThe memory leak is caused by a dangling event listener.',
      },
    });

    await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { research: handler },
      outboxStore,
      session: SESSION,
      now: NOW,
    });

    const pending = await outboxStore.listPending();
    const comment = pending.find(e => e.topic === 'gh:comment');
    expect(comment).toBeDefined();
    expect(comment.payload.body).toContain('Research complete');
    expect(comment.payload.body).toContain('The memory leak is caused by a dangling event listener');
    expect(comment.payload.body).not.toContain('/tmp/research-artifacts/run-1');
  });

  test('publishes a fixed-form comment when the workspace permission profile was enabled', async () => {
    // issue #826: the profile lets the agent read the workspace with its own
    // tools, so a stale `researchOutput` must never be excerpted on its basis.
    await enqueueTask('research', {});
    const handler = async () => ({
      result: 'success',
      context: {
        artifactDir: '/tmp/research-artifacts/run-1',
        researchAgentUsed: 'gemini',
        workspaceSettingsEnabled: true,
        researchOutput: 'Contents of an ignored local file.',
      },
    });

    await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { research: handler },
      outboxStore,
      session: SESSION,
      now: NOW,
    });

    const pending = await outboxStore.listPending();
    const comment = pending.find(e => e.topic === 'gh:comment');
    expect(comment.payload.body).toContain('Research complete');
    expect(comment.payload.body).toContain('a workspace read-only permission profile was enabled for the run');
    expect(comment.payload.body).not.toContain('ignored local file');
  });

  test('enqueues comment without findings section when researchOutput is absent', async () => {
    await enqueueTask('research', {});
    const handler = async () => ({
      result: 'success',
      context: { artifactDir: '/tmp/research-artifacts/run-1' },
    });

    await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { research: handler },
      outboxStore,
      session: SESSION,
      now: NOW,
    });

    const pending = await outboxStore.listPending();
    const comment = pending.find(e => e.topic === 'gh:comment');
    expect(comment).toBeDefined();
    expect(comment.payload.body).toContain('Research complete');
    expect(comment.payload.body).not.toContain('Research findings');
  });
});

describe('runNextPhase outbox side effects — research failure', () => {
  test('enqueues failure comment with error', async () => {
    await enqueueTask('research', {});
    const handler = async () => ({
      result: 'failed',
      context: { artifactDir: '/tmp/research-artifacts/run-1' },
      error: 'agy: command not found (exit 127)',
    });

    await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { research: handler },
      outboxStore,
      session: SESSION,
      now: NOW,
    });

    const pending = await outboxStore.listPending();
    const comment = pending.find(e => e.topic === 'gh:comment');
    expect(comment).toBeDefined();
    expect(comment.payload.body).toContain('Research failed');
    expect(comment.payload.body).toContain('agy: command not found');
    expect(comment.payload.body).not.toContain('/tmp/research-artifacts/run-1');
  });

  test('enqueues failure comment without artifact path when context absent', async () => {
    await enqueueTask('research', {});
    const handler = async () => ({
      result: 'failed',
      error: 'Unsupported research agent: claude',
    });

    await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { research: handler },
      outboxStore,
      session: SESSION,
      now: NOW,
    });

    const pending = await outboxStore.listPending();
    const comment = pending.find(e => e.topic === 'gh:comment');
    expect(comment).toBeDefined();
    expect(comment.payload.body).toContain('Research failed');
    expect(comment.payload.body).toContain('Unsupported research agent');
  });
});

describe('runNextPhase outbox — no outboxStore → no side effects enqueued', () => {
  test('runs without outboxStore and succeeds', async () => {
    await enqueueTask('implementation', {});
    const handler = async () => ({ result: 'success', context: { prUrl: 'https://github.com/org/repo/pull/1' } });

    const outcome = await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { implementation: handler },
      // no outboxStore, no session
      now: NOW,
    });

    expect(outcome.status).toBe('completed');
    // No outbox store → nothing to check; just confirm no error thrown
  });
});

describe('runNextPhase outbox — idempotency (no duplicate effects on retry)', () => {
  test('same runId produces same idempotency keys → second enqueue is no-op', async () => {
    // Pre-populate outbox with both keys that would be generated (issue + PR comment)
    const { makeOutboxKey } = await import('../dist/core/outbox.js');
    const issueKey = makeOutboxKey('test-session', 99, 'run-1', 'gh:comment', 'review', 'success');
    // The PR-timeline comment is now a repohost:pr-comment row but intentionally
    // keeps the legacy 'gh:comment' key token so dedup stays byte-for-byte equivalent.
    const prKey = makeOutboxKey('test-session', 99, 'run-1', 'gh:comment', 'review', 'success', 'pr');
    await outboxStore.enqueue({
      idempotencyKey: issueKey,
      topic: 'gh:comment',
      payload: { topic: 'gh:comment', owner: 'org', repo: 'repo', issueNumber: 99, body: 'pre-existing-issue' },
    });
    await outboxStore.enqueue({
      idempotencyKey: prKey,
      topic: 'repohost:pr-comment',
      payload: { topic: 'repohost:pr-comment', provider: 'github', owner: 'org', repo: 'repo', prNumber: 5, body: 'pre-existing-pr' },
    });

    await enqueueTask('review', { prUrl: 'https://github.com/org/repo/pull/5', branch: 'ai/issue-99' });
    const handler = async () => ({
      result: 'success',
      context: { artifactDir: '/tmp/a' },
      message: 'clean',
    });

    await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { review: handler },
      outboxStore,
      session: SESSION,
      now: NOW,
    });

    // Both pre-existing entries should still be there, not duplicated
    const pending = await outboxStore.listPending();
    const commentRows = pending.filter(e => e.topic === 'gh:comment' || e.topic === 'repohost:pr-comment');
    expect(commentRows).toHaveLength(2);
    // The issue comment is unchanged
    const issueComment = pending.find(e => e.topic === 'gh:comment' && e.payload.issueNumber === 99);
    expect(issueComment?.payload.body).toBe('pre-existing-issue');
    // The PR comment is unchanged (same idempotency key blocked the re-enqueue)
    const prComment = pending.find(e => e.topic === 'repohost:pr-comment' && e.payload.prNumber === 5);
    expect(prComment?.payload.body).toBe('pre-existing-pr');
  });
});

describe('runNextPhase outbox — review phase posts to PR timeline', () => {
  test('review success enqueues comment on both issue and PR', async () => {
    await enqueueTask('review', { prUrl: 'https://github.com/org/repo/pull/5', branch: 'ai/issue-99' });
    const handler = async () => ({
      result: 'success',
      context: { artifactDir: '/tmp/a', classification: 'success' },
      message: 'No findings',
    });

    await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { review: handler },
      outboxStore,
      session: SESSION,
      now: NOW,
    });

    const pending = await outboxStore.listPending();
    // One comment on the issue (work-item domain), one on the PR (repo-host domain).
    const issueComment = pending.find(e => e.topic === 'gh:comment' && e.payload.issueNumber === 99);
    const prComment = pending.find(e => e.topic === 'repohost:pr-comment' && e.payload.prNumber === 5);
    expect(issueComment).toBeDefined();
    expect(prComment).toBeDefined();
    expect(issueComment.payload.body).toContain('Review passed');
    expect(prComment.payload.body).toContain('Review passed');
  });

  test('review needs_fix enqueues comment on both issue and PR', async () => {
    await enqueueTask('review', { prUrl: 'https://github.com/org/repo/pull/7', branch: 'ai/issue-99' });
    // A verification-failure needs_fix sets `message` to the first 300 chars of
    // raw command stdout/stderr (handlers/review.ts), so the reason is NOT
    // public-safe and must not reach the Tier 2 PR comment.
    const leakyReason = "Verification 'npm test' failed (exit 1): Expected 3 received 4 at internal stack trace";
    const handler = async () => ({
      result: 'needs_fix',
      context: { reviewFeedback: '[P1] Null pointer' },
      message: leakyReason,
    });

    await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { review: handler },
      outboxStore,
      session: SESSION,
      now: NOW,
    });

    const pending = await outboxStore.listPending();
    const issueComment = pending.find(e => e.topic === 'gh:comment' && e.payload.issueNumber === 99);
    const prComment = pending.find(e => e.topic === 'repohost:pr-comment' && e.payload.prNumber === 7);
    expect(issueComment).toBeDefined();
    expect(prComment).toBeDefined();
    expect(prComment.payload.body).toContain('automatically requeuing to fix mode');
    // Tier 1 work-item (issue) comment may carry the bounded review-findings
    // excerpt AND the raw reason; the Tier 2 public PR comment must forward
    // neither the excerpt nor the `Reason:` line (raw command output leaks there).
    expect(issueComment.payload.body).toContain('[P1] Null pointer');
    expect(issueComment.payload.body).toContain(leakyReason);
    expect(prComment.payload.body).not.toContain('[P1] Null pointer');
    expect(prComment.payload.body).not.toContain('Review findings excerpt');
    expect(prComment.payload.body).not.toContain(leakyReason);
    expect(prComment.payload.body).not.toContain('Reason:');
  });

  test('reviewFeedback containing its own ```diff fence does not close the outer excerpt fence early (issue #706)', async () => {
    // Reproduces the #606/#705 comment shape: the review agent's own findings
    // embed a "## Suggested Changes" section wrapped in a ```diff fenced block.
    // A fixed triple-backtick outer fence would be closed by that embedded
    // fence, spilling the heading, diff body, and trailing fence outside the
    // intended <details> block.
    await enqueueTask('review', { prUrl: 'https://github.com/org/repo/pull/7', branch: 'ai/issue-99' });
    const reviewFeedback = [
      '[P1] Missing null check in handler',
      '',
      '## Suggested Changes (review agent edits)',
      '',
      '```diff',
      '--- a/src/handler.ts',
      '+++ b/src/handler.ts',
      '@@ -10,6 +10,9 @@',
      '-function handle(x) {',
      '+function handle(x) {',
      '+  if (!x) return;',
      ' }',
      '```',
      '',
      'Apply the diff above before requeuing.',
    ].join('\n');
    const handler = async () => ({
      result: 'needs_fix',
      context: { reviewFeedback },
      message: 'Review output contains blocking findings',
    });

    await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { review: handler },
      outboxStore,
      session: SESSION,
      now: NOW,
    });

    const pending = await outboxStore.listPending();
    const issueComment = pending.find(e => e.topic === 'gh:comment' && e.payload.issueNumber === 99);
    expect(issueComment).toBeDefined();
    const body = issueComment.payload.body;

    // Balanced <details>/</details> tags: the embedded fence must not have
    // closed the outer one early, which would otherwise leave one of the two
    // <details> blocks (excerpt + run metadata) without its closing tag, or
    // strand a stray </details> from the embedded content outside a block.
    const openCount = (body.match(/<details>/g) || []).length;
    const closeCount = (body.match(/<\/details>/g) || []).length;
    expect(openCount).toBe(closeCount);
    expect(openCount).toBeGreaterThanOrEqual(1);

    // The excerpt section must be delimited by a fence strictly longer than
    // the longest backtick run inside the excerpt (3, from the embedded
    // ```diff block), so the embedded fence cannot close it early.
    const excerptStart = body.indexOf('<summary>Review findings excerpt</summary>');
    expect(excerptStart).toBeGreaterThan(-1);
    const afterSummary = body.slice(excerptStart);
    const fenceMatch = afterSummary.match(/\n(`{3,})\n/);
    expect(fenceMatch).not.toBeNull();
    const outerFenceLen = fenceMatch[1].length;
    expect(outerFenceLen).toBeGreaterThan(3);

    // The full excerpt — heading, diff fence, and trailing prose — renders
    // entirely inside the <details> block, before its closing tag.
    const excerptDetailsEnd = body.indexOf('</details>', excerptStart);
    expect(excerptDetailsEnd).toBeGreaterThan(-1);
    const suggestedIdx = body.indexOf('## Suggested Changes (review agent edits)');
    const diffFenceIdx = body.indexOf('```diff');
    const trailingProseIdx = body.indexOf('Apply the diff above before requeuing.');
    expect(suggestedIdx).toBeGreaterThan(excerptStart);
    expect(suggestedIdx).toBeLessThan(excerptDetailsEnd);
    expect(diffFenceIdx).toBeGreaterThan(excerptStart);
    expect(diffFenceIdx).toBeLessThan(excerptDetailsEnd);
    expect(trailingProseIdx).toBeGreaterThan(excerptStart);
    expect(trailingProseIdx).toBeLessThan(excerptDetailsEnd);
  });

  test('review blocked enqueues comment on both issue and PR', async () => {
    await enqueueTask('review', { prUrl: 'https://github.com/org/repo/pull/8', branch: 'ai/issue-99' });
    const handler = async () => ({
      result: 'blocked',
      context: { classification: 'blocked' },
      message: 'Output was ambiguous',
    });

    await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { review: handler },
      outboxStore,
      session: SESSION,
      now: NOW,
    });

    const pending = await outboxStore.listPending();
    const issueComment = pending.find(e => e.topic === 'gh:comment' && e.payload.issueNumber === 99);
    const prComment = pending.find(e => e.topic === 'repohost:pr-comment' && e.payload.prNumber === 8);
    expect(issueComment).toBeDefined();
    expect(prComment).toBeDefined();
    expect(prComment.payload.body).toContain('Review escalated to human');
  });

  test('review failed enqueues comment on both issue and PR', async () => {
    await enqueueTask('review', { prUrl: 'https://github.com/org/repo/pull/9', branch: 'ai/issue-99' });
    // `error` mirrors handlers/review.ts, which builds it from the first 500 chars
    // of raw review-agent stderr/stdout — not public-safe.
    const handler = async () => ({
      result: 'failed',
      context: { reviewFailureOutput: 'codex crashed' },
      error: 'Review agent (codex) exited 1: TypeError: cannot read RAW_STDERR_LEAK',
    });

    await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { review: handler },
      outboxStore,
      session: SESSION,
      now: NOW,
    });

    const pending = await outboxStore.listPending();
    const issueComment = pending.find(e => e.topic === 'gh:comment' && e.payload.issueNumber === 99);
    const prComment = pending.find(e => e.topic === 'repohost:pr-comment' && e.payload.prNumber === 9);
    expect(issueComment).toBeDefined();
    expect(prComment).toBeDefined();
    expect(prComment.payload.body).toContain('Review failed');
    // Tier 1 work-item (issue) comment may carry the bounded review-output
    // excerpt and the detailed error; the Tier 2 public PR comment must not
    // forward raw review output or the raw `Error:` line (which itself carries
    // raw agent stderr/stdout from handlers/review.ts).
    expect(issueComment.payload.body).toContain('codex crashed');
    expect(issueComment.payload.body).toContain('RAW_STDERR_LEAK');
    expect(prComment.payload.body).not.toContain('codex crashed');
    expect(prComment.payload.body).not.toContain('Review output excerpt');
    expect(prComment.payload.body).not.toContain('RAW_STDERR_LEAK');
    expect(prComment.payload.body).not.toContain('Error:');
  });

  test('review without prUrl in context posts only to issue', async () => {
    await enqueueTask('review', { branch: 'ai/issue-99' }); // no prUrl
    const handler = async () => ({
      result: 'success',
      context: { artifactDir: '/tmp/a' },
      message: 'clean',
    });

    await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { review: handler },
      outboxStore,
      session: SESSION,
      now: NOW,
    });

    const pending = await outboxStore.listPending();
    const issueComments = pending.filter(e => e.topic === 'gh:comment');
    // No prUrl → only the issue comment, no repo-host PR comment.
    expect(issueComments).toHaveLength(1);
    expect(issueComments[0].payload.issueNumber).toBe(99);
    expect(pending.filter(e => e.topic === 'repohost:pr-comment')).toHaveLength(0);
  });
});

describe('runNextPhase outbox — PR number shown in issue comment, issue number shown in PR comment', () => {
  test('implementation success: issue comment shows PR number, not issue number', async () => {
    await enqueueTask('implementation', {});
    const handler = async () => ({
      result: 'success',
      context: { prUrl: 'https://github.com/org/repo/pull/5' },
    });

    await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { implementation: handler },
      outboxStore,
      session: SESSION,
      now: NOW,
    });

    const pending = await outboxStore.listPending();
    const comment = pending.find(e => e.topic === 'gh:comment');
    expect(comment).toBeDefined();
    expect(comment.payload.body).toContain('PR #5');
    expect(comment.payload.body).not.toContain('issue #99');
  });

  test('review success: issue comment shows PR number; PR comment shows issue number', async () => {
    await enqueueTask('review', { prUrl: 'https://github.com/org/repo/pull/5', branch: 'ai/issue-99' });
    const handler = async () => ({
      result: 'success',
      context: { classification: 'success' },
      message: 'No findings',
    });

    await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { review: handler },
      outboxStore,
      session: SESSION,
      now: NOW,
    });

    const pending = await outboxStore.listPending();
    const issueComment = pending.find(e => e.topic === 'gh:comment' && e.payload.issueNumber === 99);
    const prComment = pending.find(e => e.topic === 'repohost:pr-comment' && e.payload.prNumber === 5);

    expect(issueComment.payload.body).toContain('PR #5');
    expect(issueComment.payload.body).not.toContain('issue #99');
    expect(prComment.payload.body).toContain('issue #99');
    expect(prComment.payload.body).not.toContain('PR #5');
  });

  test('review needs_fix: issue comment shows PR number; PR comment shows issue number', async () => {
    await enqueueTask('review', { prUrl: 'https://github.com/org/repo/pull/7', branch: 'ai/issue-99' });
    const handler = async () => ({
      result: 'needs_fix',
      context: { reviewFeedback: '[P1] Null pointer' },
      message: 'Blocking findings',
    });

    await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { review: handler },
      outboxStore,
      session: SESSION,
      now: NOW,
    });

    const pending = await outboxStore.listPending();
    const issueComment = pending.find(e => e.topic === 'gh:comment' && e.payload.issueNumber === 99);
    const prComment = pending.find(e => e.topic === 'repohost:pr-comment' && e.payload.prNumber === 7);

    expect(issueComment.payload.body).toContain('PR #7');
    expect(issueComment.payload.body).not.toContain('issue #99');
    expect(prComment.payload.body).toContain('issue #99');
    expect(prComment.payload.body).not.toContain('PR #7');
  });

  test('review blocked: issue comment shows PR number; PR comment shows issue number', async () => {
    await enqueueTask('review', { prUrl: 'https://github.com/org/repo/pull/8', branch: 'ai/issue-99' });
    const handler = async () => ({
      result: 'blocked',
      context: { classification: 'conflict' },
      message: 'Merge conflict detected',
    });

    await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { review: handler },
      outboxStore,
      session: SESSION,
      now: NOW,
    });

    const pending = await outboxStore.listPending();
    const issueComment = pending.find(e => e.topic === 'gh:comment' && e.payload.issueNumber === 99);
    const prComment = pending.find(e => e.topic === 'repohost:pr-comment' && e.payload.prNumber === 8);

    expect(issueComment.payload.body).toContain('PR #8');
    expect(issueComment.payload.body).not.toContain('issue #99');
    expect(prComment.payload.body).toContain('issue #99');
    expect(prComment.payload.body).not.toContain('PR #8');
  });

  test('review failed: issue comment shows PR number; PR comment shows issue number', async () => {
    await enqueueTask('review', { prUrl: 'https://github.com/org/repo/pull/9', branch: 'ai/issue-99' });
    const handler = async () => ({
      result: 'failed',
      context: { reviewFailureOutput: 'codex crashed' },
      error: 'Codex review exited 1',
    });

    await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { review: handler },
      outboxStore,
      session: SESSION,
      now: NOW,
    });

    const pending = await outboxStore.listPending();
    const issueComment = pending.find(e => e.topic === 'gh:comment' && e.payload.issueNumber === 99);
    const prComment = pending.find(e => e.topic === 'repohost:pr-comment' && e.payload.prNumber === 9);

    expect(issueComment.payload.body).toContain('PR #9');
    expect(issueComment.payload.body).not.toContain('issue #99');
    expect(prComment.payload.body).toContain('issue #99');
    expect(prComment.payload.body).not.toContain('PR #9');
  });

  test('review without prUrl: issue comment falls back to issue number', async () => {
    await enqueueTask('review', { branch: 'ai/issue-99' }); // no prUrl
    const handler = async () => ({
      result: 'success',
      context: {},
      message: 'No findings',
    });

    await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { review: handler },
      outboxStore,
      session: SESSION,
      now: NOW,
    });

    const pending = await outboxStore.listPending();
    const comment = pending.find(e => e.topic === 'gh:comment');
    expect(comment.payload.body).toContain('issue #99');
  });
});

describe('runNextPhase outbox side effects — review conflict routed to resolver', () => {
  test('swaps review labels for needs-conflict-resolution and comments the hand-off', async () => {
    const sessionWithLabels = {
      ...SESSION,
      labels: { ...SESSION.labels, needsReview: 'status:needs-review' },
    };
    await enqueueTask('review', { prUrl: 'https://github.com/org/repo/pull/5', branch: 'ai/issue-99' });
    const handler = async () => ({
      result: 'conflict',
      context: {
        artifactDir: '/tmp/review-artifacts',
        classification: 'conflict',
        hasConflictSignal: true,
        prUrl: 'https://github.com/org/repo/pull/5',
        branch: 'ai/issue-99',
      },
      message: 'Review output contains merge-conflict signals',
    });

    const outcome = await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { review: handler },
      outboxStore,
      session: sessionWithLabels,
      now: NOW,
    });

    // The conflict result routes the task into the conflict-resolution lane.
    expect(outcome.status).toBe('completed');
    expect(outcome.task).toMatchObject({ status: 'queued', phase: 'conflict_resolution' });

    const pending = await outboxStore.listPending();
    const removed = pending.filter(e => e.topic === 'gh:label:remove').map(e => e.payload.label);
    const added = pending.filter(e => e.topic === 'gh:label:add').map(e => e.payload.label);
    expect(removed).toContain('status:needs-review');
    expect(added).toContain('status:needs-conflict-resolution');

    const comment = pending.find(e => e.topic === 'gh:comment');
    expect(comment).toBeDefined();
    expect(comment.payload.body).toContain('Merge conflict detected');
    expect(comment.payload.body).toContain('conflict resolution');
  });

  test('removes default review labels when routing to conflict resolution under minimal session config', async () => {
    // SESSION omits the optional needsReview/agentReview keys, so the review
    // task entered via the default GitHub labels. Routing to the resolver must
    // still strip status:needs-review + agent:codex; otherwise the issue keeps
    // both lane label sets and labelsToPhase() re-selects review on next intake.
    await enqueueTask('review', { prUrl: 'https://github.com/org/repo/pull/5', branch: 'ai/issue-99' });
    const handler = async () => ({
      result: 'conflict',
      context: {
        artifactDir: '/tmp/review-artifacts',
        classification: 'conflict',
        hasConflictSignal: true,
        prUrl: 'https://github.com/org/repo/pull/5',
        branch: 'ai/issue-99',
      },
      message: 'Review output contains merge-conflict signals',
    });

    const outcome = await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { review: handler },
      outboxStore,
      session: SESSION,
      now: NOW,
    });

    expect(outcome.task).toMatchObject({ status: 'queued', phase: 'conflict_resolution' });

    const pending = await outboxStore.listPending();
    const removed = pending.filter(e => e.topic === 'gh:label:remove').map(e => e.payload.label);
    const added = pending.filter(e => e.topic === 'gh:label:add').map(e => e.payload.label);
    expect(removed).toContain('status:needs-review');
    expect(removed).toContain('agent:codex');
    expect(added).toContain('status:needs-conflict-resolution');
  });
});

describe('runNextPhase outbox side effects — conflict_resolution success', () => {
  test('clears conflict-resolution labels and swaps to needs-review on success', async () => {
    const sessionWithLabels = {
      ...SESSION,
      labels: { ...SESSION.labels, needsReview: 'status:needs-review' },
    };
    await enqueueTask('conflict_resolution', { prUrl: 'https://github.com/org/repo/pull/5', branch: 'ai/issue-99' });
    const handler = async () => ({
      result: 'success',
      context: {
        prUrl: 'https://github.com/org/repo/pull/5',
        branch: 'ai/issue-99',
        conflictResolution: { clean: false, resolved: true },
      },
    });

    const outcome = await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { conflict_resolution: handler },
      outboxStore,
      session: sessionWithLabels,
      now: NOW,
    });

    // Success re-queues the task for review.
    expect(outcome.status).toBe('completed');
    expect(outcome.task).toMatchObject({ status: 'queued', phase: 'review' });

    const pending = await outboxStore.listPending();
    const removed = pending.filter(e => e.topic === 'gh:label:remove').map(e => e.payload.label);
    const added = pending.filter(e => e.topic === 'gh:label:add').map(e => e.payload.label);
    // The conflict-resolution lane labels are cleared so intake/public state no
    // longer advertises that conflict resolution is pending.
    expect(removed).toContain('status:needs-conflict-resolution');
    expect(removed).toContain('status:conflict-resolution-in-progress');
    // ...and the task is advertised as ready for review again.
    expect(added).toContain('status:needs-review');
  });

  test('adds default review labels on success under minimal session config', async () => {
    // SESSION omits the optional needsReview/agentReview keys, so the shared
    // review-queue logic adds nothing. The resolver-success path must still
    // advertise the default review lane labels (status:needs-review +
    // agent:codex); otherwise the issue is left with no GitHub lane label
    // while a review task is queued.
    await enqueueTask('conflict_resolution', { prUrl: 'https://github.com/org/repo/pull/5', branch: 'ai/issue-99' });
    const handler = async () => ({
      result: 'success',
      context: {
        prUrl: 'https://github.com/org/repo/pull/5',
        branch: 'ai/issue-99',
        conflictResolution: { clean: false, resolved: true },
      },
    });

    const outcome = await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { conflict_resolution: handler },
      outboxStore,
      session: SESSION,
      now: NOW,
    });

    expect(outcome.status).toBe('completed');
    expect(outcome.task).toMatchObject({ status: 'queued', phase: 'review' });

    const pending = await outboxStore.listPending();
    const removed = pending.filter(e => e.topic === 'gh:label:remove').map(e => e.payload.label);
    const added = pending.filter(e => e.topic === 'gh:label:add').map(e => e.payload.label);
    // Conflict-resolution lane labels are still cleared.
    expect(removed).toContain('status:needs-conflict-resolution');
    expect(removed).toContain('status:conflict-resolution-in-progress');
    // Default review lane labels are added even without configured session keys.
    expect(added).toContain('status:needs-review');
    expect(added).toContain('agent:codex');
  });

  test('enqueues gh:comment on success — clean base merge', async () => {
    await enqueueTask('conflict_resolution', { prUrl: 'https://github.com/org/repo/pull/5', branch: 'ai/issue-99' });
    const handler = async () => ({
      result: 'success',
      context: {
        prUrl: 'https://github.com/org/repo/pull/5',
        branch: 'ai/issue-99',
        conflictedFiles: [],
        conflictResolution: { clean: true, merged: true },
      },
    });

    await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { conflict_resolution: handler },
      outboxStore,
      session: SESSION,
      now: NOW,
    });

    const pending = await outboxStore.listPending();
    const comment = pending.find(e => e.topic === 'gh:comment');
    expect(comment).toBeDefined();
    expect(comment.payload.body).toMatch(/conflict resolved/i);
    expect(comment.payload.body).toMatch(/PR #5/);
    expect(comment.payload.body).toMatch(/clean base merge/i);
    expect(comment.payload.body).toMatch(/returning to review/i);
  });

  test('enqueues gh:comment on success — agent-assisted with conflicted files', async () => {
    await enqueueTask('conflict_resolution', { prUrl: 'https://github.com/org/repo/pull/5', branch: 'ai/issue-99' });
    const handler = async () => ({
      result: 'success',
      context: {
        prUrl: 'https://github.com/org/repo/pull/5',
        branch: 'ai/issue-99',
        conflictedFiles: ['src/foo.ts', 'src/bar.ts'],
        conflictResolution: { clean: false, resolved: true },
      },
    });

    await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { conflict_resolution: handler },
      outboxStore,
      session: SESSION,
      now: NOW,
    });

    const pending = await outboxStore.listPending();
    const comment = pending.find(e => e.topic === 'gh:comment');
    expect(comment).toBeDefined();
    expect(comment.payload.body).toMatch(/conflict resolved/i);
    expect(comment.payload.body).toMatch(/PR #5/);
    expect(comment.payload.body).toMatch(/agent-assisted/i);
    expect(comment.payload.body).toMatch(/2 file\(s\) resolved/i);
    expect(comment.payload.body).toMatch(/returning to review/i);
  });

  test('success comment includes Run metadata block — clean base merge', async () => {
    await enqueueTask('conflict_resolution', { prUrl: 'https://github.com/org/repo/pull/5', branch: 'ai/issue-99' });
    const handler = async () => ({
      result: 'success',
      context: {
        prUrl: 'https://github.com/org/repo/pull/5',
        branch: 'ai/issue-99',
        conflictedFiles: [],
        conflictResolution: { clean: true, merged: true },
        resolvedProfile: {
          agentId: 'claude',
          cmd: 'claude',
          model: 'sonnet',
          modelSource: 'default',
          effort: 'high',
          effortSource: 'label',
        },
      },
    });

    await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { conflict_resolution: handler },
      outboxStore,
      session: SESSION,
      now: NOW,
    });

    const pending = await outboxStore.listPending();
    const comment = pending.find(e => e.topic === 'gh:comment');
    expect(comment).toBeDefined();
    expect(comment.payload.body).toContain('Run metadata');
  });

  test('success comment includes Run metadata block — agent-assisted', async () => {
    await enqueueTask('conflict_resolution', { prUrl: 'https://github.com/org/repo/pull/5', branch: 'ai/issue-99' });
    const handler = async () => ({
      result: 'success',
      context: {
        prUrl: 'https://github.com/org/repo/pull/5',
        branch: 'ai/issue-99',
        conflictedFiles: ['src/foo.ts'],
        conflictResolution: { clean: false, resolved: true },
        resolvedProfile: {
          agentId: 'claude',
          cmd: 'claude',
          model: 'sonnet',
          modelSource: 'default',
          effort: 'high',
          effortSource: 'label',
        },
      },
    });

    await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { conflict_resolution: handler },
      outboxStore,
      session: SESSION,
      now: NOW,
    });

    const pending = await outboxStore.listPending();
    const comment = pending.find(e => e.topic === 'gh:comment');
    expect(comment).toBeDefined();
    expect(comment.payload.body).toContain('Run metadata');
  });
});

describe('runNextPhase outbox side effects — conflict_resolution blocked (human handoff)', () => {
  test('hands off to human: readyForHuman, clears conflict-resolution labels, posts handoff comment', async () => {
    await enqueueTask('conflict_resolution', { prUrl: 'https://github.com/org/repo/pull/5', branch: 'ai/issue-99' });
    const handler = async () => ({
      result: 'blocked',
      context: {
        prUrl: 'https://github.com/org/repo/pull/5',
        branch: 'ai/issue-99',
        conflictedFiles: ['assets/logo.png'],
      },
      message: 'Binary conflict requires human judgement (not auto-resolvable): assets/logo.png',
    });

    const outcome = await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { conflict_resolution: handler },
      outboxStore,
      session: SESSION,
      now: NOW,
    });

    // Blocked hands the task off to a human rather than marking it unrunnable-failed.
    expect(outcome.status).toBe('completed');
    expect(outcome.task).toMatchObject({ status: 'ready_for_human', phase: 'conflict_resolution' });

    const pending = await outboxStore.listPending();
    const removed = pending.filter(e => e.topic === 'gh:label:remove').map(e => e.payload.label);
    const added = pending.filter(e => e.topic === 'gh:label:add').map(e => e.payload.label);
    // The conflict-resolution lane labels are cleared so the issue is not left
    // advertised as pending automated resolution while it awaits human judgement.
    expect(removed).toContain('status:needs-conflict-resolution');
    expect(removed).toContain('status:conflict-resolution-in-progress');
    // ...and it is flagged as ready for human.
    expect(added).toContain(SESSION.labels.readyForHuman);

    // A public handoff comment is posted to the issue.
    const comment = pending.find(e => e.topic === 'gh:comment');
    expect(comment).toBeDefined();
    expect(comment.payload.body).toMatch(/handed off to human/i);
    expect(comment.payload.body).toContain('Binary conflict requires human judgement');
  });

  test('semantic conflict escalation (blocked + cap reached) posts enriched handoff comment with test names, conflicted files, and next actions (issue #537)', async () => {
    await enqueueTask('conflict_resolution', { prUrl: 'https://github.com/org/repo/pull/5', branch: 'ai/issue-99' });
    const handler = async () => ({
      result: 'blocked',
      context: {
        prUrl: 'https://github.com/org/repo/pull/5',
        branch: 'ai/issue-99',
        conflictedFiles: ['src/foo.ts'],
        conflictResolutionVerificationCapReached: true,
        conflictResolutionVerificationAttempts: 2,
        conflictResolutionMaxAttempts: 2,
        semanticConflict: {
          verificationCommandName: 'test',
          verificationCommand: 'npm test',
          exitCode: 1,
          failedTests: ['MySuite › secret internal test name'],
        },
      },
      message: 'Repeated conflict-resolution verification failure — escalating to human.',
    });

    const outcome = await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { conflict_resolution: handler },
      outboxStore,
      session: SESSION,
      now: NOW,
    });

    expect(outcome.task).toMatchObject({ status: 'ready_for_human', phase: 'conflict_resolution' });

    const pending = await outboxStore.listPending();
    const removed = pending.filter(e => e.topic === 'gh:label:remove').map(e => e.payload.label);
    const added = pending.filter(e => e.topic === 'gh:label:add').map(e => e.payload.label);
    // Semantic escalation: lane labels cleared and failure label added (failed lane).
    expect(removed).toContain('status:needs-conflict-resolution');
    expect(removed).toContain('status:conflict-resolution-in-progress');
    expect(added).toContain('status:conflict-resolution-failed');

    const comment = pending.find(e => e.topic === 'gh:comment');
    expect(comment).toBeDefined();
    const body = comment.payload.body;
    // Core identifiers.
    expect(body).toContain('npm test');
    expect(body).toContain('ai/issue-99');
    expect(body).toMatch(/2\/2 attempt/);
    // Exit code exposed (issue #537).
    expect(body).toContain('exited 1');
    // Test names are included in the public comment (issue #537).
    expect(body).toContain('MySuite › secret internal test name');
    // Section header includes count.
    expect(body).toContain('Failed tests (1)');
    // Conflicted files section (issue #537).
    expect(body).toContain('src/foo.ts');
    expect(body).toContain('Conflicted files (1)');
    // Suggested next actions (issue #537).
    expect(body).toMatch(/[Ss]uggested next actions/);
    expect(body).toMatch(/Codex/);
    // Semantic conflict framing.
    expect(body).toContain('semantic conflict');
    // Must not include local paths.
    expect(body).not.toContain('/tmp/');
  });

  test('semantic conflict escalation (blocked + cap reached) suppresses run metadata even when resolvedProfile is present (issue #537)', async () => {
    await enqueueTask('conflict_resolution', { prUrl: 'https://github.com/org/repo/pull/5', branch: 'ai/issue-99' });
    const handler = async () => ({
      result: 'blocked',
      context: {
        prUrl: 'https://github.com/org/repo/pull/5',
        branch: 'ai/issue-99',
        conflictResolutionVerificationCapReached: true,
        conflictResolutionVerificationAttempts: 2,
        conflictResolutionMaxAttempts: 2,
        semanticConflict: {
          verificationCommand: 'npm test',
          exitCode: 1,
          failedTests: [],
        },
        // resolvedProfile is present in production and would normally add "Run ID: ..." to the footer.
        resolvedProfile: { agentId: 'agent-abc123', model: 'claude-sonnet-4-6', modelSource: 'session' },
      },
      message: 'Repeated conflict-resolution verification failure — escalating to human.',
    });

    await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { conflict_resolution: handler },
      outboxStore,
      session: SESSION,
      now: NOW,
    });

    const pending = await outboxStore.listPending();
    const comment = pending.find(e => e.topic === 'gh:comment');
    expect(comment).toBeDefined();
    const body = comment.payload.body;
    // Run metadata footer must be suppressed on semantic conflict safe comments.
    expect(body).not.toMatch(/Run ID:/);
    expect(body).not.toContain('agent-abc123');
    // Core semantic conflict content still present.
    expect(body).toMatch(/escalated/i);
  });
});

describe('runNextPhase outbox side effects — conflict_resolution report-only admission hold (issue #532 review)', () => {
  test('does NOT clear the conflict-resolution queue labels — the hold must stay resumable for intake reactivation', async () => {
    await enqueueTask('conflict_resolution', { prUrl: 'https://github.com/org/repo/pull/5', branch: 'ai/issue-99' });
    const reportOnlySession = { ...SESSION, reportOnly: { enabled: true } };
    let handlerRan = false;

    const outcome = await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { conflict_resolution: async () => { handlerRan = true; return { result: 'success' }; } },
      admitPhase: (task) => checkReportOnlyAdmission(reportOnlySession, task),
      outboxStore,
      session: reportOnlySession,
      now: NOW,
    });

    // The admission preflight rejects before the handler ever runs (side-effect-free contract).
    expect(handlerRan).toBe(false);
    expect(outcome.status).toBe('completed');
    // A hold, not a terminal ready_for_human handoff — must stay eligible for
    // intake reactivation once reportOnly.enabled is turned off (transitions.ts).
    expect(outcome.task).toMatchObject({ status: 'blocked', phase: 'conflict_resolution' });

    const pending = await outboxStore.listPending();
    const removed = pending.filter(e => e.topic === 'gh:label:remove').map(e => e.payload.label);
    // Unlike a genuine handler-decided escalation (see the "human handoff" describe
    // block above), an admission-originated hold must NOT strip the queue labels:
    // intake re-derives the conflict_resolution phase from these labels when it
    // scans the issue again after report-only mode is disabled. Removing them here
    // would strand the task in `blocked` forever (issue #532 review).
    expect(removed).not.toContain('status:needs-conflict-resolution');
    expect(removed).not.toContain('status:conflict-resolution-in-progress');
  });
});

describe('runNextPhase outbox side effects — conflict_resolution failed', () => {
  test('clears conflict-resolution labels and flags the failure on failed result', async () => {
    await enqueueTask('conflict_resolution', { prUrl: 'https://github.com/org/repo/pull/5', branch: 'ai/issue-99' });
    const handler = async () => ({
      result: 'failed',
      context: {
        prUrl: 'https://github.com/org/repo/pull/5',
        branch: 'ai/issue-99',
      },
      error: 'Conflict resolution agent exited 1',
    });

    const outcome = await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { conflict_resolution: handler },
      outboxStore,
      session: SESSION,
      now: NOW,
    });

    expect(outcome.task).toMatchObject({ status: 'failed', phase: 'conflict_resolution' });

    const pending = await outboxStore.listPending();
    const removed = pending.filter(e => e.topic === 'gh:label:remove').map(e => e.payload.label);
    const added = pending.filter(e => e.topic === 'gh:label:add').map(e => e.payload.label);
    // The conflict-resolution lane labels are cleared so the issue is no longer
    // advertised as a runnable resolver lane after the resolver failed.
    expect(removed).toContain('status:needs-conflict-resolution');
    expect(removed).toContain('status:conflict-resolution-in-progress');
    // ...and the failure is flagged for operators/intake.
    expect(added).toContain('status:conflict-resolution-failed');
  });

  test('posts safe comment on env/dependency setup failure — no test names, shows possible setup issue, includes conflicted files and next actions (issue #537)', async () => {
    await enqueueTask('conflict_resolution', { prUrl: 'https://github.com/org/repo/pull/5', branch: 'ai/issue-99' });
    const handler = async () => ({
      result: 'failed',
      context: {
        prUrl: 'https://github.com/org/repo/pull/5',
        branch: 'ai/issue-99',
        conflictedFiles: ['src/foo.ts'],
        semanticConflict: { verificationCommand: 'npm test', exitCode: 1 },
      },
      // error carries raw npm output that must NOT reach the public comment
      error: "Verification 'npm test' failed (exit 1) before committing the merge resolution; aborting to prevent pushing a broken merge",
    });

    await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { conflict_resolution: handler },
      outboxStore,
      session: SESSION,
      now: NOW,
    });

    const pending = await outboxStore.listPending();
    const comment = pending.find(e => e.topic === 'gh:comment');
    expect(comment).toBeDefined();
    const body = comment.payload.body;
    // Safe comment must identify the PR, the failed command, and the base branch.
    expect(body).toContain('ai/issue-99');
    expect(body).toContain('npm test');
    expect(body).toContain('main');
    expect(body).toMatch(/[Hh]uman review/);
    // Distinguishes env/dependency setup failure from semantic conflict (issue #537).
    expect(body).toMatch(/dependency|environment setup/i);
    // Conflicted files section (issue #537).
    expect(body).toContain('src/foo.ts');
    expect(body).toContain('Conflicted files (1)');
    // Suggested next actions (issue #537).
    expect(body).toMatch(/[Ss]uggested next actions/);
    // Safe comment must not contain raw verification output or local paths.
    expect(body).not.toContain('aborting to prevent pushing');
    expect(body).not.toContain('/tmp/');
  });

  test('posts enriched comment on semantic conflict failure with named tests — includes test names and next actions (issue #537)', async () => {
    await enqueueTask('conflict_resolution', { prUrl: 'https://github.com/org/repo/pull/5', branch: 'ai/issue-99' });
    const handler = async () => ({
      result: 'failed',
      context: {
        prUrl: 'https://github.com/org/repo/pull/5',
        branch: 'ai/issue-99',
        conflictedFiles: ['src/auth.ts', 'src/user.ts'],
        semanticConflict: {
          verificationCommandName: 'test',
          verificationCommand: 'npm test',
          exitCode: 1,
          failedTests: ['AuthSuite › login fails', 'UserSuite › create user fails'],
          logExcerpt: 'FAIL tests/auth.test.ts\n\n  ● AuthSuite › login fails\n',
        },
      },
      error: "Verification 'test' failed (exit 1)",
    });

    await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { conflict_resolution: handler },
      outboxStore,
      session: SESSION,
      now: NOW,
    });

    const pending = await outboxStore.listPending();
    const comment = pending.find(e => e.topic === 'gh:comment');
    expect(comment).toBeDefined();
    const body = comment.payload.body;
    // Core identifiers.
    expect(body).toContain('ai/issue-99');
    expect(body).toContain('npm test');
    expect(body).toContain('main');
    expect(body).toMatch(/[Hh]uman review/);
    // Semantic conflict framing — NOT env setup (issue #537).
    expect(body).toContain('semantic conflict');
    expect(body).not.toMatch(/dependency|environment setup/i);
    // Failed test names included (issue #537).
    expect(body).toContain('AuthSuite › login fails');
    expect(body).toContain('UserSuite › create user fails');
    expect(body).toContain('Failed tests (2)');
    // Conflicted files (issue #537).
    expect(body).toContain('src/auth.ts');
    expect(body).toContain('src/user.ts');
    expect(body).toContain('Conflicted files (2)');
    // Exit code (issue #537).
    expect(body).toContain('exited 1');
    // Suggested next actions (issue #537).
    expect(body).toMatch(/[Ss]uggested next actions/);
    expect(body).toMatch(/Codex/);
    // Must not include the raw error string or internal paths.
    expect(body).not.toContain("Verification 'test' failed");
    expect(body).not.toContain('/tmp/');
    // logExcerpt must not appear when failedTests are available (named tests take priority).
    expect(body).not.toContain('FAIL tests/auth.test.ts');
  });

  test('omits raw logExcerpt from public comment when no named test failures are available (issue #537)', async () => {
    await enqueueTask('conflict_resolution', { prUrl: 'https://github.com/org/repo/pull/5', branch: 'ai/issue-99' });
    const handler = async () => ({
      result: 'failed',
      context: {
        prUrl: 'https://github.com/org/repo/pull/5',
        branch: 'ai/issue-99',
        conflictedFiles: [],
        semanticConflict: {
          verificationCommand: 'npm test',
          exitCode: 2,
          failedTests: [],
          logExcerpt: 'Error: Cannot find module jest\nnpm ERR! /home/ci/repo: test failed\n',
        },
      },
      error: "Verification 'npm test' failed",
    });

    await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { conflict_resolution: handler },
      outboxStore,
      session: SESSION,
      now: NOW,
    });

    const pending = await outboxStore.listPending();
    const body = pending.find(e => e.topic === 'gh:comment').payload.body;
    // Raw log output must not appear in the public comment.
    expect(body).not.toContain('Verification output excerpt');
    expect(body).not.toContain('Cannot find module jest');
    expect(body).not.toContain('/home/ci/repo');
    // Env setup framing is still present.
    expect(body).toMatch(/dependency|environment setup/i);
  });

  test('posts a minimal safe comment on non-semantic conflict failure — no raw error string exposed', async () => {
    await enqueueTask('conflict_resolution', { prUrl: 'https://github.com/org/repo/pull/5', branch: 'ai/issue-99' });
    const handler = async () => ({
      result: 'failed',
      context: {
        prUrl: 'https://github.com/org/repo/pull/5',
        branch: 'ai/issue-99',
      },
      error: 'git push origin ai/issue-99 failed (exit 1): /home/ci/repo/.git/refs/heads/ai/issue-99: permission denied',
    });

    await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { conflict_resolution: handler },
      outboxStore,
      session: SESSION,
      now: NOW,
    });

    const pending = await outboxStore.listPending();
    const comment = pending.find(e => e.topic === 'gh:comment');
    expect(comment).toBeDefined();
    const body = comment.payload.body;
    // The comment must not echo the raw error (which contains a local path).
    expect(body).not.toContain('/home/ci/repo');
    expect(body).not.toContain('permission denied');
    expect(body).toContain('Conflict resolution failed');
  });

  test('semantic conflict failure suppresses run metadata even when resolvedProfile is present (issue #537)', async () => {
    await enqueueTask('conflict_resolution', { prUrl: 'https://github.com/org/repo/pull/5', branch: 'ai/issue-99' });
    const handler = async () => ({
      result: 'failed',
      context: {
        prUrl: 'https://github.com/org/repo/pull/5',
        branch: 'ai/issue-99',
        semanticConflict: {
          verificationCommand: 'npm test',
          exitCode: 1,
          failedTests: ['AuthSuite › login fails'],
        },
        // resolvedProfile is present in production and would normally add "Run ID: ..." to the footer.
        resolvedProfile: { agentId: 'agent-xyz789', model: 'claude-sonnet-4-6', modelSource: 'session' },
      },
      error: "Verification 'npm test' failed (exit 1)",
    });

    await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { conflict_resolution: handler },
      outboxStore,
      session: SESSION,
      now: NOW,
    });

    const pending = await outboxStore.listPending();
    const comment = pending.find(e => e.topic === 'gh:comment');
    expect(comment).toBeDefined();
    const body = comment.payload.body;
    // Run metadata footer must be suppressed on semantic conflict safe comments.
    expect(body).not.toMatch(/Run ID:/);
    expect(body).not.toContain('agent-xyz789');
    // Core semantic conflict content still present.
    expect(body).toContain('semantic conflict');
  });
});

describe('runNextPhase outbox — comment body sanitization (no filesystem paths in public comments)', () => {
  test('sanitizes filesystem path in researchOutput before posting', async () => {
    await enqueueTask('research', {});
    const handler = async () => ({
      result: 'success',
      context: {
        artifactDir: '/tmp/research-artifacts/run-1',
        researchOutput: 'Found issue in /home/user/project/src/auth.ts at line 42.',
      },
    });

    await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { research: handler },
      outboxStore,
      session: SESSION,
      now: NOW,
    });

    const pending = await outboxStore.listPending();
    const comment = pending.find(e => e.topic === 'gh:comment');
    expect(comment).toBeDefined();
    expect(comment.payload.body).toContain('Research complete');
    expect(comment.payload.body).not.toContain('/home/user/project/src/auth.ts');
    expect(comment.payload.body).toContain('<path>');
  });

  test('sanitizes filesystem path in reviewFeedback before posting', async () => {
    await enqueueTask('review', { prUrl: 'https://github.com/org/repo/pull/5', branch: 'ai/issue-99' });
    const handler = async () => ({
      result: 'needs_fix',
      context: {
        reviewFeedback: '[P1] Null pointer in /var/www/app/src/handler.ts:99',
      },
      message: 'Blocking findings',
    });

    await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { review: handler },
      outboxStore,
      session: SESSION,
      now: NOW,
    });

    const pending = await outboxStore.listPending();
    const comment = pending.find(e => e.topic === 'gh:comment' && e.payload.issueNumber === 99);
    expect(comment).toBeDefined();
    expect(comment.payload.body).toContain('automatically requeuing to fix mode');
    expect(comment.payload.body).not.toContain('/var/www/app/src/handler.ts');
    expect(comment.payload.body).toContain('<path>');
  });

  test('sanitizes filesystem path in reviewFailureOutput before posting', async () => {
    await enqueueTask('review', { prUrl: 'https://github.com/org/repo/pull/5', branch: 'ai/issue-99' });
    const handler = async () => ({
      result: 'failed',
      context: {
        reviewFailureOutput: 'codex crashed writing to /tmp/codex-output/review.md',
      },
      error: 'Codex review exited 1',
    });

    await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { review: handler },
      outboxStore,
      session: SESSION,
      now: NOW,
    });

    const pending = await outboxStore.listPending();
    const comment = pending.find(e => e.topic === 'gh:comment' && e.payload.issueNumber === 99);
    expect(comment).toBeDefined();
    expect(comment.payload.body).toContain('Review failed');
    expect(comment.payload.body).not.toContain('/tmp/codex-output/review.md');
    expect(comment.payload.body).toContain('<path>');
  });

  test('sanitizes filesystem path in implementation error before posting', async () => {
    await enqueueTask('implementation', {});
    const handler = async () => ({
      result: 'failed',
      error: 'Failed to write /tmp/build/output.js: permission denied',
    });

    await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { implementation: handler },
      outboxStore,
      session: SESSION,
      now: NOW,
    });

    const pending = await outboxStore.listPending();
    const comment = pending.find(e => e.topic === 'gh:comment');
    expect(comment).toBeDefined();
    expect(comment.payload.body).toContain('Implementation failed');
    expect(comment.payload.body).not.toContain('/tmp/build/output.js');
    expect(comment.payload.body).toContain('<path>');
  });

  test('sanitizes filesystem path in research failure error before posting', async () => {
    await enqueueTask('research', {});
    const handler = async () => ({
      result: 'failed',
      error: 'agy: failed to open /home/runner/work/repo/research.md',
    });

    await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { research: handler },
      outboxStore,
      session: SESSION,
      now: NOW,
    });

    const pending = await outboxStore.listPending();
    const comment = pending.find(e => e.topic === 'gh:comment');
    expect(comment).toBeDefined();
    expect(comment.payload.body).toContain('Research failed');
    expect(comment.payload.body).not.toContain('/home/runner/work/repo/research.md');
    expect(comment.payload.body).toContain('<path>');
  });

  test('sanitizes bare root path without child segment before posting', async () => {
    await enqueueTask('implementation', {});
    const handler = async () => ({
      result: 'failed',
      error: 'Error: no space left on /tmp',
    });

    await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { implementation: handler },
      outboxStore,
      session: SESSION,
      now: NOW,
    });

    const pending = await outboxStore.listPending();
    const comment = pending.find(e => e.topic === 'gh:comment');
    expect(comment).toBeDefined();
    expect(comment.payload.body).not.toContain('/tmp');
    expect(comment.payload.body).toContain('<path>');
  });

  test('sanitizes hosted file:// URL with non-localhost authority before posting', async () => {
    await enqueueTask('research', {});
    const handler = async () => ({
      result: 'success',
      context: {
        artifactDir: '/tmp/research-artifacts/run-1',
        researchOutput: 'See file://runner/home/user/repo/src/a.ts for details.',
      },
    });

    await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { research: handler },
      outboxStore,
      session: SESSION,
      now: NOW,
    });

    const pending = await outboxStore.listPending();
    const comment = pending.find(e => e.topic === 'gh:comment');
    expect(comment).toBeDefined();
    expect(comment.payload.body).not.toContain('file://runner/home/user/repo/src/a.ts');
    expect(comment.payload.body).toContain('<path>');
  });

  test('does not redact GitHub PR URLs in comment bodies', async () => {
    await enqueueTask('implementation', {});
    const handler = async () => ({
      result: 'success',
      context: { prUrl: 'https://github.com/org/repo/pull/5' },
    });

    await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { implementation: handler },
      outboxStore,
      session: SESSION,
      now: NOW,
    });

    const pending = await outboxStore.listPending();
    const comment = pending.find(e => e.topic === 'gh:comment');
    expect(comment).toBeDefined();
    expect(comment.payload.body).toContain('https://github.com/org/repo/pull/5');
  });
});

describe('runNextPhase outbox — run metadata block in comments', () => {
  const CLAUDE_PROFILE = {
    agentId: 'claude',
    cmd: 'claude',
    model: 'sonnet',
    modelSource: 'default',
    effort: 'high',
    effortSource: 'label',
  };

  const CODEX_PROFILE = {
    agentId: 'codex',
    cmd: 'codex',
    modelSource: 'cli-default',
    reviewStrength: 'high',
    reviewStrengthSource: 'label',
  };

  const GEMINI_PROFILE = {
    agentId: 'gemini',
    cmd: 'agy',
    cmdSource: 'cli-default',
    modelSource: 'cli-default',
  };

  test('implementation success with resolvedProfile includes metadata block', async () => {
    await enqueueTask('implementation', {});
    const handler = async () => ({
      result: 'success',
      context: {
        prUrl: 'https://github.com/org/repo/pull/5',
        resolvedProfile: CLAUDE_PROFILE,
      },
    });

    await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { implementation: handler },
      outboxStore,
      session: SESSION,
      now: NOW,
    });

    const pending = await outboxStore.listPending();
    const comment = pending.find(e => e.topic === 'gh:comment');
    expect(comment).toBeDefined();
    expect(comment.payload.body).toContain('Implementation complete');
    expect(comment.payload.body).toContain('Run metadata');
    expect(comment.payload.body).toContain('Claude');
    expect(comment.payload.body).toContain('Anthropic');
    expect(comment.payload.body).toContain('sonnet');
    expect(comment.payload.body).toContain('high');
    expect(comment.payload.body).toContain('run-1'); // runId
  });

  test('implementation failure with resolvedProfile includes metadata block', async () => {
    await enqueueTask('implementation', {});
    const handler = async () => ({
      result: 'failed',
      context: { resolvedProfile: CLAUDE_PROFILE },
      error: 'claude exited 1: some error',
    });

    await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { implementation: handler },
      outboxStore,
      session: SESSION,
      now: NOW,
    });

    const pending = await outboxStore.listPending();
    const comment = pending.find(e => e.topic === 'gh:comment');
    expect(comment).toBeDefined();
    expect(comment.payload.body).toContain('Implementation failed');
    expect(comment.payload.body).toContain('Run metadata');
    expect(comment.payload.body).toContain('Claude');
    expect(comment.payload.body).toContain('Anthropic');
  });

  test('implementation blocked with resolvedProfile includes metadata block', async () => {
    await enqueueTask('implementation', {});
    const handler = async () => ({
      result: 'blocked',
      context: { resolvedProfile: CLAUDE_PROFILE },
      message: 'Open dependency blockers',
    });

    await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { implementation: handler },
      outboxStore,
      session: SESSION,
      now: NOW,
    });

    const pending = await outboxStore.listPending();
    const comment = pending.find(e => e.topic === 'gh:comment');
    expect(comment).toBeDefined();
    expect(comment.payload.body).toContain('Implementation blocked');
    expect(comment.payload.body).toContain('Run metadata');
    expect(comment.payload.body).toContain('Claude');
    expect(comment.payload.body).toContain('Anthropic');
  });

  test('review success with codex resolvedProfile shows CLI default model in both issue and PR comments', async () => {
    await enqueueTask('review', { prUrl: 'https://github.com/org/repo/pull/5', branch: 'ai/issue-99' });
    const handler = async () => ({
      result: 'success',
      context: { resolvedProfile: CODEX_PROFILE },
      message: 'No blocking findings',
    });

    await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { review: handler },
      outboxStore,
      session: SESSION,
      now: NOW,
    });

    const pending = await outboxStore.listPending();
    const issueComment = pending.find(e => e.topic === 'gh:comment' && e.payload.issueNumber === 99);
    const prComment = pending.find(e => e.topic === 'repohost:pr-comment' && e.payload.prNumber === 5);

    expect(issueComment.payload.body).toContain('Run metadata');
    expect(issueComment.payload.body).toContain('Codex');
    expect(issueComment.payload.body).toContain('OpenAI');
    expect(issueComment.payload.body).toContain('CLI default');
    // Effort falls back to reviewStrength when effort field absent
    expect(issueComment.payload.body).toContain('high');

    // PR comment also includes the metadata block
    expect(prComment.payload.body).toContain('Run metadata');
    expect(prComment.payload.body).toContain('Codex');
    expect(prComment.payload.body).toContain('CLI default');
  });

  test('research success with gemini resolvedProfile shows CLI default and not-exposed effort', async () => {
    await enqueueTask('research', {});
    const handler = async () => ({
      result: 'success',
      context: {
        researchOutput: 'Found the issue.',
        resolvedProfile: GEMINI_PROFILE,
      },
    });

    await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { research: handler },
      outboxStore,
      session: SESSION,
      now: NOW,
    });

    const pending = await outboxStore.listPending();
    const comment = pending.find(e => e.topic === 'gh:comment');
    expect(comment.payload.body).toContain('Research complete');
    expect(comment.payload.body).toContain('Run metadata');
    expect(comment.payload.body).toContain('Gemini');
    expect(comment.payload.body).toContain('Google');
    expect(comment.payload.body).toContain('CLI default');
    expect(comment.payload.body).toContain('not exposed');
    expect(comment.payload.body).toContain('run-1');
  });

  test('research failure with resolvedProfile includes metadata block', async () => {
    await enqueueTask('research', {});
    const handler = async () => ({
      result: 'failed',
      context: { resolvedProfile: GEMINI_PROFILE },
      error: 'agy: command not found (exit 127)',
    });

    await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { research: handler },
      outboxStore,
      session: SESSION,
      now: NOW,
    });

    const pending = await outboxStore.listPending();
    const comment = pending.find(e => e.topic === 'gh:comment');
    expect(comment.payload.body).toContain('Research failed');
    expect(comment.payload.body).toContain('Run metadata');
    expect(comment.payload.body).toContain('Gemini');
    expect(comment.payload.body).toContain('Google');
  });

  test('comment without resolvedProfile in context has no metadata block', async () => {
    await enqueueTask('implementation', {});
    const handler = async () => ({
      result: 'success',
      context: { prUrl: 'https://github.com/org/repo/pull/5' },
    });

    await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { implementation: handler },
      outboxStore,
      session: SESSION,
      now: NOW,
    });

    const pending = await outboxStore.listPending();
    const comment = pending.find(e => e.topic === 'gh:comment');
    expect(comment).toBeDefined();
    expect(comment.payload.body).toContain('Implementation complete');
    expect(comment.payload.body).not.toContain('Run metadata');
  });

  test('review needs_fix with resolvedProfile shows metadata in both issue and PR comments', async () => {
    await enqueueTask('review', { prUrl: 'https://github.com/org/repo/pull/7', branch: 'ai/issue-99' });
    const handler = async () => ({
      result: 'needs_fix',
      context: {
        reviewFeedback: '[P1] Missing validation',
        resolvedProfile: CODEX_PROFILE,
      },
      message: 'Blocking findings',
    });

    await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { review: handler },
      outboxStore,
      session: SESSION,
      now: NOW,
    });

    const pending = await outboxStore.listPending();
    const issueComment = pending.find(e => e.topic === 'gh:comment' && e.payload.issueNumber === 99);
    const prComment = pending.find(e => e.topic === 'repohost:pr-comment' && e.payload.prNumber === 7);

    expect(issueComment.payload.body).toContain('Run metadata');
    expect(issueComment.payload.body).toContain('Codex');
    expect(prComment.payload.body).toContain('Run metadata');
    expect(prComment.payload.body).toContain('Codex');
  });

  test('review loop cap comment includes metadata block', async () => {
    await enqueueTask('review', { prUrl: 'https://github.com/org/repo/pull/5', branch: 'ai/issue-99' });
    const handler = async () => ({
      result: 'blocked',
      context: {
        classification: 'needs_fix',
        reviewLoopCapReached: true,
        reviewCycles: 5,
        reviewLoopMaxCycles: 5,
        resolvedProfile: CODEX_PROFILE,
      },
      message: 'Review loop cap reached',
    });

    await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { review: handler },
      outboxStore,
      session: SESSION,
      now: NOW,
    });

    const pending = await outboxStore.listPending();
    const issueComment = pending.find(e => e.topic === 'gh:comment' && e.payload.issueNumber === 99);
    expect(issueComment.payload.body).toContain('Review loop cap reached');
    expect(issueComment.payload.body).toContain('Run metadata');
    expect(issueComment.payload.body).toContain('Codex');
    expect(issueComment.payload.body).toContain('OpenAI');
  });

  test('review loop cap reached keeps the findings excerpt off the public PR comment', async () => {
    await enqueueTask('review', { prUrl: 'https://github.com/org/repo/pull/5', branch: 'ai/issue-99' });
    const handler = async () => ({
      result: 'blocked',
      context: {
        classification: 'needs_fix',
        reviewLoopCapReached: true,
        reviewCycles: 5,
        reviewLoopMaxCycles: 5,
        reviewFeedback: '[P1] Latest blocking finding from review',
      },
      message: 'Review loop cap reached',
    });

    await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { review: handler },
      outboxStore,
      session: SESSION,
      now: NOW,
    });

    const pending = await outboxStore.listPending();
    const issueComment = pending.find(e => e.topic === 'gh:comment' && e.payload.issueNumber === 99);
    const prComment = pending.find(e => e.topic === 'repohost:pr-comment' && e.payload.prNumber === 5);
    expect(issueComment).toBeDefined();
    expect(prComment).toBeDefined();
    expect(prComment.payload.body).toContain('Review loop cap reached');
    // Tier 1 issue comment may carry the latest-findings excerpt; the Tier 2
    // public PR comment must not forward raw review output.
    expect(issueComment.payload.body).toContain('[P1] Latest blocking finding');
    expect(prComment.payload.body).not.toContain('[P1] Latest blocking finding');
    expect(prComment.payload.body).not.toContain('Latest review findings');
  });

  test('review loop cap findings excerpt with an embedded ```diff fence stays balanced (issue #706)', async () => {
    await enqueueTask('review', { prUrl: 'https://github.com/org/repo/pull/5', branch: 'ai/issue-99' });
    const reviewFeedback = [
      '[P1] Latest blocking finding from review',
      '',
      '## Suggested Changes (review agent edits)',
      '',
      '```diff',
      '-return null;',
      '+return undefined;',
      '```',
    ].join('\n');
    const handler = async () => ({
      result: 'blocked',
      context: {
        classification: 'needs_fix',
        reviewLoopCapReached: true,
        reviewCycles: 5,
        reviewLoopMaxCycles: 5,
        reviewFeedback,
      },
      message: 'Review loop cap reached',
    });

    await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { review: handler },
      outboxStore,
      session: SESSION,
      now: NOW,
    });

    const pending = await outboxStore.listPending();
    const issueComment = pending.find(e => e.topic === 'gh:comment' && e.payload.issueNumber === 99);
    const body = issueComment.payload.body;
    const openCount = (body.match(/<details>/g) || []).length;
    const closeCount = (body.match(/<\/details>/g) || []).length;
    expect(openCount).toBe(closeCount);

    const excerptStart = body.indexOf('<summary>Latest review findings</summary>');
    expect(excerptStart).toBeGreaterThan(-1);
    const excerptDetailsEnd = body.indexOf('</details>', excerptStart);
    const diffFenceIdx = body.indexOf('```diff');
    expect(diffFenceIdx).toBeGreaterThan(excerptStart);
    expect(diffFenceIdx).toBeLessThan(excerptDetailsEnd);
  });

  test('claude review with env model source shows model source in block', async () => {
    await enqueueTask('review', { prUrl: 'https://github.com/org/repo/pull/5', branch: 'ai/issue-99' });
    const handler = async () => ({
      result: 'success',
      context: {
        resolvedProfile: {
          agentId: 'claude',
          model: 'opus',
          modelSource: 'env',
          effort: 'high',
          effortSource: 'env',
          reviewStrength: 'high',
          reviewStrengthSource: 'default',
        },
      },
    });

    await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { review: handler },
      outboxStore,
      session: SESSION,
      now: NOW,
    });

    const pending = await outboxStore.listPending();
    const comment = pending.find(e => e.topic === 'gh:comment' && e.payload.issueNumber === 99);
    expect(comment.payload.body).toContain('opus');
    expect(comment.payload.body).toContain('Model source: env');
    expect(comment.payload.body).toContain('Effort source: env');
  });

  test('metadata block does not expose configured local filesystem paths', async () => {
    await enqueueTask('implementation', {});
    const handler = async () => ({
      result: 'failed',
      context: { resolvedProfile: CLAUDE_PROFILE },
      error: 'Implementation failed',
    });

    await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { implementation: handler },
      outboxStore,
      session: SESSION,
      now: NOW,
    });

    const pending = await outboxStore.listPending();
    const comment = pending.find(e => e.topic === 'gh:comment');
    expect(comment.payload.body).toContain('Run metadata');
    // Metadata block itself must not contain any filesystem path
    expect(comment.payload.body).not.toContain(SESSION.repoRoot);
    expect(comment.payload.body).not.toContain(SESSION.artifactRoot);
  });
});

// ---------------------------------------------------------------------------
// Tool Request handoff (issue #291)
// ---------------------------------------------------------------------------

describe('runNextPhase outbox side effects — implementation tool_request', () => {
  const TOOL_REQUEST_CONTEXT = {
    artifactDir: '/tmp/test-repo/.artifacts/runs/run-1',
    toolRequest: {
      command: 'npm install left-pad',
      displayCommand: 'npm install left-pad',
      reason: 'The fix depends on left-pad which is not a dependency yet.',
      expectedFiles: ['package.json', 'package-lock.json'],
      necessity: 'required',
      suggestedAction: 'dependencySync',
      requestedBy: 'claude',
      mode: 'new',
      requestedAt: NOW,
      resolved: false,
    },
  };

  test('transitions the task to ready_for_human on the implementation phase', async () => {
    await enqueueTask('implementation', {});
    const handler = async () => ({
      result: 'tool_request',
      context: TOOL_REQUEST_CONTEXT,
      message: 'Implementation agent requested a disallowed command: npm install left-pad',
    });

    const outcome = await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { implementation: handler },
      outboxStore,
      session: SESSION,
      now: NOW,
    });

    expect(outcome.status).toBe('completed');
    expect(outcome.task.status).toBe('ready_for_human');
    expect(outcome.task.phase).toBe('implementation');
    // Structured metadata is preserved in task context for later admin inspection.
    expect(outcome.task.context.toolRequest.command).toBe('npm install left-pad');
  });

  test('enqueues a public comment with command, reason, files, and next action', async () => {
    await enqueueTask('implementation', {});
    const handler = async () => ({
      result: 'tool_request',
      context: TOOL_REQUEST_CONTEXT,
    });

    await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { implementation: handler },
      outboxStore,
      session: SESSION,
      now: NOW,
    });

    const pending = await outboxStore.listPending();
    const comment = pending.find(e => e.topic === 'gh:comment');
    expect(comment).toBeDefined();
    expect(comment.payload.body).toContain('disallowed command');
    expect(comment.payload.body).toContain('npm install left-pad');
    expect(comment.payload.body).toContain('left-pad which is not a dependency');
    expect(comment.payload.body).toContain('package.json, package-lock.json');
    expect(comment.payload.body).toContain('dependencySync');
    expect(comment.payload.body).toContain('Necessity');
    expect(comment.payload.body).toContain('tool-request');
  });

  test('comment shows the redacted display command, never the exact command', async () => {
    await enqueueTask('implementation', {});
    const handler = async () => ({
      result: 'tool_request',
      context: {
        ...TOOL_REQUEST_CONTEXT,
        toolRequest: {
          ...TOOL_REQUEST_CONTEXT.toolRequest,
          command: 'deploy --token=SECRET123',
          displayCommand: 'deploy --token=***',
        },
      },
    });

    await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { implementation: handler },
      outboxStore,
      session: SESSION,
      now: NOW,
    });

    const pending = await outboxStore.listPending();
    const comment = pending.find(e => e.topic === 'gh:comment');
    expect(comment.payload.body).toContain('deploy --token=***');
    expect(comment.payload.body).not.toContain('SECRET123');
  });

  test('comment never leaks server-side paths', async () => {
    await enqueueTask('implementation', {});
    const handler = async () => ({
      result: 'tool_request',
      context: {
        ...TOOL_REQUEST_CONTEXT,
        toolRequest: {
          ...TOOL_REQUEST_CONTEXT.toolRequest,
          // A request that names an absolute path must be redacted.
          expectedFiles: ['/Users/secret/repo/package.json'],
        },
      },
    });

    await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { implementation: handler },
      outboxStore,
      session: SESSION,
      now: NOW,
    });

    const pending = await outboxStore.listPending();
    const comment = pending.find(e => e.topic === 'gh:comment');
    expect(comment.payload.body).not.toContain('/Users/secret');
    expect(comment.payload.body).toContain('<path>');
  });

  test('comment redacts secrets in reason, expectedFiles, and suggestedAction', async () => {
    await enqueueTask('implementation', {});
    const handler = async () => ({
      result: 'tool_request',
      context: {
        ...TOOL_REQUEST_CONTEXT,
        toolRequest: {
          ...TOOL_REQUEST_CONTEXT.toolRequest,
          // A hostile or careless agent can embed a secret in any free-text
          // field, not just the command — these must be redacted too.
          reason: 'Needs ghp_abcdefghijklmnopqrstuvwxyz0123456789 to authenticate.',
          expectedFiles: ['file.txt with Authorization: Bearer ghp_zzzzzzzzzzzzzzzzzzzz'],
          suggestedAction: 'curl -H "X-Api-Key: supersecretvalue" example.com',
        },
      },
    });

    await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { implementation: handler },
      outboxStore,
      session: SESSION,
      now: NOW,
    });

    const pending = await outboxStore.listPending();
    const comment = pending.find(e => e.topic === 'gh:comment');
    expect(comment.payload.body).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    expect(comment.payload.body).not.toContain('ghp_zzzzzzzzzzzzzzzzzzzz');
    expect(comment.payload.body).not.toContain('supersecretvalue');
  });

  test('adds readyForHuman label and clears implementation-lane labels', async () => {
    const sessionWithLanes = {
      ...SESSION,
      labels: {
        ...SESSION.labels,
        needsImplementation: 'status:needs-implementation',
        agentImplementation: 'agent:claude',
      },
    };
    await enqueueTask('implementation', {});
    const handler = async () => ({
      result: 'tool_request',
      context: TOOL_REQUEST_CONTEXT,
    });

    await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { implementation: handler },
      outboxStore,
      session: sessionWithLanes,
      now: NOW,
    });

    const pending = await outboxStore.listPending();
    const addedLabels = pending.filter(e => e.topic === 'gh:label:add').map(e => e.payload.label);
    const removedLabels = pending.filter(e => e.topic === 'gh:label:remove').map(e => e.payload.label);
    expect(addedLabels).toContain('ai:ready-for-human');
    expect(removedLabels).toContain('status:needs-implementation');
    expect(removedLabels).toContain('agent:claude');
  });

  test('removes default status:needs-implementation on handoff under minimal label config', async () => {
    // Regression (issue #291 review follow-up): the base SESSION omits the
    // needsImplementation key. The implementation queue added the default
    // status:needs-implementation under this minimal config, so the Tool Request
    // handoff must remove that default — otherwise the ready-for-human issue keeps
    // advertising runnable implementation work alongside the ready-for-human label.
    await enqueueTask('implementation', {});
    const handler = async () => ({
      result: 'tool_request',
      context: TOOL_REQUEST_CONTEXT,
    });

    await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { implementation: handler },
      outboxStore,
      session: SESSION,
      now: NOW,
    });

    const pending = await outboxStore.listPending();
    const addedLabels = pending.filter(e => e.topic === 'gh:label:add').map(e => e.payload.label);
    const removedLabels = pending.filter(e => e.topic === 'gh:label:remove').map(e => e.payload.label);
    expect(addedLabels).toContain('ai:ready-for-human');
    expect(removedLabels).toContain('status:needs-implementation');
  });

  test('clears the fix-lane status label on a fix-mode tool_request handoff', async () => {
    // Regression (issue #291 review follow-up): a Tool Request emitted while
    // addressing review feedback leaves the issue in the fix lane carrying
    // status:needs-fix, not status:needs-implementation. The handoff must remove
    // the configured needsFix label too, or the ready-for-human issue keeps a fix
    // queue status that can later pair with an agent label to advertise runnable
    // fix work.
    const sessionWithFixLane = {
      ...SESSION,
      labels: {
        ...SESSION.labels,
        needsFix: 'status:needs-fix',
        agentImplementation: 'agent:claude',
      },
    };
    await enqueueTask('implementation', { labels: ['ai:active', 'status:needs-fix', 'agent:claude'] });
    const handler = async () => ({
      result: 'tool_request',
      context: {
        ...TOOL_REQUEST_CONTEXT,
        toolRequest: { ...TOOL_REQUEST_CONTEXT.toolRequest, mode: 'fix' },
      },
    });

    await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { implementation: handler },
      outboxStore,
      session: sessionWithFixLane,
      now: NOW,
    });

    const pending = await outboxStore.listPending();
    const addedLabels = pending.filter(e => e.topic === 'gh:label:add').map(e => e.payload.label);
    const removedLabels = pending.filter(e => e.topic === 'gh:label:remove').map(e => e.payload.label);
    expect(addedLabels).toContain('ai:ready-for-human');
    expect(removedLabels).toContain('status:needs-fix');
  });

  test('removes default status:needs-fix on a fix-mode handoff under minimal label config', async () => {
    // Even when the session omits the needsFix key, the fix lane added the default
    // status:needs-fix during intake, so the handoff must remove that default to
    // avoid leaving the ready-for-human issue advertising runnable fix work.
    await enqueueTask('implementation', { labels: ['ai:active', 'status:needs-fix', 'agent:claude'] });
    const handler = async () => ({
      result: 'tool_request',
      context: {
        ...TOOL_REQUEST_CONTEXT,
        toolRequest: { ...TOOL_REQUEST_CONTEXT.toolRequest, mode: 'fix' },
      },
    });

    await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { implementation: handler },
      outboxStore,
      session: SESSION,
      now: NOW,
    });

    const pending = await outboxStore.listPending();
    const removedLabels = pending.filter(e => e.topic === 'gh:label:remove').map(e => e.payload.label);
    expect(removedLabels).toContain('status:needs-fix');
  });

  test('suppresses the public comment when toolRequestRepeatKind is unresolved-duplicate', async () => {
    await enqueueTask('implementation', {});
    const handler = async () => ({
      result: 'tool_request',
      context: {
        ...TOOL_REQUEST_CONTEXT,
        toolRequestRepeatKind: 'unresolved-duplicate',
      },
    });

    await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { implementation: handler },
      outboxStore,
      session: SESSION,
      now: NOW,
    });

    const pending = await outboxStore.listPending();
    const comment = pending.find(e => e.topic === 'gh:comment');
    // An unresolved duplicate should not post another public comment.
    expect(comment).toBeUndefined();
    // The task still transitions to ready_for_human.
    const tasks = await taskStore.listTasks('test-session', 99);
    expect(tasks[0].status).toBe('ready_for_human');
  });

  test('posts a diagnostic comment when toolRequestRepeatKind is resolved-duplicate', async () => {
    await enqueueTask('implementation', {});
    const handler = async () => ({
      result: 'tool_request',
      context: {
        ...TOOL_REQUEST_CONTEXT,
        toolRequestRepeatKind: 'resolved-duplicate',
      },
    });

    await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { implementation: handler },
      outboxStore,
      session: SESSION,
      now: NOW,
    });

    const pending = await outboxStore.listPending();
    const comment = pending.find(e => e.topic === 'gh:comment');
    expect(comment).toBeDefined();
    expect(comment.payload.body).toContain('Repeated Tool Request');
    expect(comment.payload.body).toContain('previous manual completion did not change the target repository state');
    expect(comment.payload.body).toContain(TOOL_REQUEST_CONTEXT.toolRequest.displayCommand);
  });
});

// ---------------------------------------------------------------------------
// Duration in run metadata block (issue #311)
// ---------------------------------------------------------------------------

describe('runNextPhase outbox — duration in run metadata block', () => {
  const CLAUDE_PROFILE = {
    agentId: 'claude',
    model: 'sonnet',
    modelSource: 'default',
    effort: 'high',
    effortSource: 'label',
  };

  const CODEX_PROFILE = {
    agentId: 'codex',
    modelSource: 'cli-default',
    reviewStrength: 'high',
    reviewStrengthSource: 'label',
  };

  const DURATION_PATTERN = /Duration: (\d+s|\d+m(?: \d+s)?|unknown)/;

  test('implementation success comment includes Duration field in run metadata block', async () => {
    await enqueueTask('implementation', {});
    const handler = async () => ({
      result: 'success',
      context: {
        prUrl: 'https://github.com/org/repo/pull/5',
        resolvedProfile: CLAUDE_PROFILE,
      },
    });

    await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { implementation: handler },
      outboxStore,
      session: SESSION,
      now: NOW,
    });

    const pending = await outboxStore.listPending();
    const comment = pending.find(e => e.topic === 'gh:comment');
    expect(comment).toBeDefined();
    expect(comment.payload.body).toContain('Implementation complete');
    expect(comment.payload.body).toContain('Run metadata');
    expect(comment.payload.body).toContain('Duration:');
    expect(comment.payload.body).toMatch(DURATION_PATTERN);
  });

  test('review needs_fix comment includes Duration field in run metadata block', async () => {
    await enqueueTask('review', { prUrl: 'https://github.com/org/repo/pull/7', branch: 'ai/issue-99' });
    const handler = async () => ({
      result: 'needs_fix',
      context: {
        reviewFeedback: '[P1] Missing validation',
        resolvedProfile: CODEX_PROFILE,
      },
      message: 'Blocking findings',
    });

    await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { review: handler },
      outboxStore,
      session: SESSION,
      now: NOW,
    });

    const pending = await outboxStore.listPending();
    const issueComment = pending.find(e => e.topic === 'gh:comment' && e.payload.issueNumber === 99);
    expect(issueComment).toBeDefined();
    expect(issueComment.payload.body).toContain('automatically requeuing to fix mode');
    expect(issueComment.payload.body).toContain('Run metadata');
    expect(issueComment.payload.body).toContain('Duration:');
    expect(issueComment.payload.body).toMatch(DURATION_PATTERN);
  });

  test('review success comment includes Duration in both issue and PR comments', async () => {
    await enqueueTask('review', { prUrl: 'https://github.com/org/repo/pull/5', branch: 'ai/issue-99' });
    const handler = async () => ({
      result: 'success',
      context: { resolvedProfile: CODEX_PROFILE },
      message: 'No blocking findings',
    });

    await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { review: handler },
      outboxStore,
      session: SESSION,
      now: NOW,
    });

    const pending = await outboxStore.listPending();
    const issueComment = pending.find(e => e.topic === 'gh:comment' && e.payload.issueNumber === 99);
    const prComment = pending.find(e => e.topic === 'repohost:pr-comment' && e.payload.prNumber === 5);
    expect(issueComment.payload.body).toContain('Duration:');
    expect(issueComment.payload.body).toMatch(DURATION_PATTERN);
    expect(prComment.payload.body).toContain('Duration:');
    expect(prComment.payload.body).toMatch(DURATION_PATTERN);
  });

  test('comment without resolvedProfile has no Duration field', async () => {
    await enqueueTask('implementation', {});
    const handler = async () => ({
      result: 'success',
      context: { prUrl: 'https://github.com/org/repo/pull/5' },
      // No resolvedProfile: metadata block is omitted entirely
    });

    await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { implementation: handler },
      outboxStore,
      session: SESSION,
      now: NOW,
    });

    const pending = await outboxStore.listPending();
    const comment = pending.find(e => e.topic === 'gh:comment');
    expect(comment).toBeDefined();
    expect(comment.payload.body).not.toContain('Duration:');
    expect(comment.payload.body).not.toContain('Run metadata');
  });

  test('review blocked (cap reached) comment includes Duration field', async () => {
    await enqueueTask('review', { prUrl: 'https://github.com/org/repo/pull/5', branch: 'ai/issue-99' });
    const handler = async () => ({
      result: 'blocked',
      context: {
        classification: 'needs_fix',
        reviewLoopCapReached: true,
        reviewCycles: 3,
        reviewLoopMaxCycles: 3,
        resolvedProfile: CODEX_PROFILE,
      },
      message: 'Review loop cap reached',
    });

    await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { review: handler },
      outboxStore,
      session: SESSION,
      now: NOW,
    });

    const pending = await outboxStore.listPending();
    const issueComment = pending.find(e => e.topic === 'gh:comment' && e.payload.issueNumber === 99);
    expect(issueComment.payload.body).toContain('Review loop cap reached');
    expect(issueComment.payload.body).toContain('Duration:');
    expect(issueComment.payload.body).toMatch(DURATION_PATTERN);
  });
});

// ---------------------------------------------------------------------------
// Provider routing: a non-GitHub work-item provider (gitea-issues) must receive
// work-item comments and label transitions as provider-neutral `workitem:*`
// rows targeting the Gitea repo — never legacy `gh:*` rows, which the dispatcher
// would hand a failing GitHub runner. Public PR-timeline comments still route to
// the GitHub repo host as `repohost:pr-comment` (issue #382 review follow-up).
// ---------------------------------------------------------------------------

describe('runNextPhase outbox side effects — gitea-issues work-item routing', () => {
  // GitHub remains the repo host; only the work-item provider is Gitea, with its
  // own owner/repo that work-item rows must target.
  const GITEA_SESSION = {
    ...SESSION,
    workItemProvider: {
      provider: 'gitea-issues',
      auth: { mode: 'api-token', tokenEnv: 'GITEA_TOKEN' },
      gitea: { baseUrl: 'https://gitea.example.com', owner: 'ai-private', repo: 'work-items' },
    },
    repoHostProvider: { provider: 'github', auth: { mode: 'gh' } },
  };

  test('implementation success routes comment + label transitions to Gitea, never gh:*', async () => {
    await enqueueTask('implementation', {});
    const handler = async () => ({
      result: 'success',
      context: { prUrl: 'https://github.com/org/repo/pull/5', artifactDir: '/tmp/artifacts' },
      message: 'PR created',
    });

    await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { implementation: handler },
      outboxStore,
      session: GITEA_SESSION,
      now: NOW,
    });

    const pending = await outboxStore.listPending();

    // No legacy GitHub-specific work-item rows survive for a Gitea session.
    expect(pending.filter(e => e.topic.startsWith('gh:'))).toHaveLength(0);

    // The phase-completion comment is a provider-neutral workitem:comment on the
    // Gitea repo, tagged with the gitea-issues provider kind.
    const comment = pending.find(e => e.topic === 'workitem:comment');
    expect(comment).toBeDefined();
    expect(comment.payload.provider).toBe('gitea-issues');
    expect(comment.payload.owner).toBe('ai-private');
    expect(comment.payload.repo).toBe('work-items');
    expect(comment.payload.issueNumber).toBe(99);
    expect(comment.payload.body).toContain('Implementation complete');

    // Every label transition is a workitem:transition on the Gitea repo carrying
    // an add-label / remove-label kind (never a gh:label:* row).
    const transitions = pending.filter(e => e.topic === 'workitem:transition');
    expect(transitions.length).toBeGreaterThan(0);
    for (const t of transitions) {
      expect(t.payload.provider).toBe('gitea-issues');
      expect(t.payload.owner).toBe('ai-private');
      expect(t.payload.repo).toBe('work-items');
      expect(['add-label', 'remove-label']).toContain(t.payload.transition.kind);
    }
    // The default needs-fix removal (see GitHub baseline) is preserved, just as a
    // workitem:transition remove-label rather than gh:label:remove.
    const removedLabels = transitions
      .filter(t => t.payload.transition.kind === 'remove-label')
      .map(t => t.payload.transition.label);
    expect(removedLabels).toContain('status:needs-fix');
  });

  test('review success splits issue comment to Gitea and PR comment to the GitHub repo host', async () => {
    await enqueueTask('review', { prUrl: 'https://github.com/org/repo/pull/5', branch: 'ai/issue-99' });
    const handler = async () => ({
      result: 'success',
      context: { artifactDir: '/tmp/review-artifacts', classification: 'success' },
      message: 'No blocking findings detected',
    });

    await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { review: handler },
      outboxStore,
      session: GITEA_SESSION,
      now: NOW,
    });

    const pending = await outboxStore.listPending();

    // No legacy gh:* rows.
    expect(pending.filter(e => e.topic.startsWith('gh:'))).toHaveLength(0);

    // Tier 1 issue comment → Gitea work item.
    const issueComment = pending.find(e => e.topic === 'workitem:comment');
    expect(issueComment).toBeDefined();
    expect(issueComment.payload.provider).toBe('gitea-issues');
    expect(issueComment.payload.owner).toBe('ai-private');
    expect(issueComment.payload.repo).toBe('work-items');
    expect(issueComment.payload.body).toContain('Review passed');

    // Tier 2 public PR comment → GitHub repo host, NOT Gitea.
    const prComment = pending.find(e => e.topic === 'repohost:pr-comment');
    expect(prComment).toBeDefined();
    expect(prComment.payload.provider).toBe('github');
    expect(prComment.payload.owner).toBe('org');
    expect(prComment.payload.repo).toBe('repo');
    expect(prComment.payload.prNumber).toBe(5);

    // review success → ready_for_human → readyForHuman label, routed to Gitea.
    const labelAdd = pending.find(
      e => e.topic === 'workitem:transition' && e.payload.transition.kind === 'add-label'
        && e.payload.transition.label === 'ai:ready-for-human',
    );
    expect(labelAdd).toBeDefined();
    expect(labelAdd.payload.owner).toBe('ai-private');
    expect(labelAdd.payload.repo).toBe('work-items');
  });

  test('GitHub work-item sessions keep emitting legacy gh:* rows (regression guard)', async () => {
    await enqueueTask('implementation', {});
    const handler = async () => ({
      result: 'success',
      context: { prUrl: 'https://github.com/org/repo/pull/5' },
    });

    await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { implementation: handler },
      outboxStore,
      session: SESSION, // default github-issues work-item provider
      now: NOW,
    });

    const pending = await outboxStore.listPending();
    // The GitHub path is unchanged: a legacy gh:comment row, no workitem:* rows.
    expect(pending.find(e => e.topic === 'gh:comment')).toBeDefined();
    expect(pending.filter(e => e.topic.startsWith('workitem:'))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// content_research outbox side effects (issue #625)
// ---------------------------------------------------------------------------

describe('runNextPhase outbox side effects — content_research success', () => {
  const SESSION_WITH_RESEARCH = {
    ...SESSION,
    defaults: { ...SESSION.defaults, researchAgent: 'gemini' },
  };

  test('enqueues a fixed-outcome success comment without research findings', async () => {
    // Public-status contract: only a fixed outcome status string is published.
    // Research findings, agent output, or any raw content must never appear in
    // the public comment (docs/content-research-mvp-contract.md §Public-Status Contract).
    await enqueueTask('content_research', {});
    const handler = async () => ({
      result: 'success',
      context: {
        artifactDir: '/tmp/content-research-artifacts/run-1',
        contentResearchOutput: 'This is raw research findings — MUST NOT appear in public comment.',
        contentResearchAgentUsed: 'gemini',
      },
    });

    await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { content_research: handler },
      outboxStore,
      session: SESSION_WITH_RESEARCH,
      now: NOW,
    });

    const pending = await outboxStore.listPending();
    const comment = pending.find(e => e.topic === 'gh:comment');
    expect(comment).toBeDefined();
    expect(comment.payload.body).toContain('Content research complete');
    // Raw findings and agent output must never appear in the public comment.
    expect(comment.payload.body).not.toContain('raw research findings');
    expect(comment.payload.body).not.toContain('/tmp/content-research-artifacts');
  });

  test('success clears the content-research lane labels on content_draft transition', async () => {
    // content_research is NOT terminal: nextPhaseAfter("content_research", "success") advances
    // to queued/content_draft. The content-research lane labels (agent:gemini +
    // status:content-needed) must be removed so a later intake scan does not
    // re-enqueue the same issue as content_research or misroute a subsequent
    // review to Gemini (stale agent:gemini causes the same problem as issue #264).
    await enqueueTask('content_research', { artifactDir: '/tmp/content-research-artifacts' });
    const handler = async () => ({
      result: 'success',
      context: { artifactDir: '/tmp/content-research-artifacts', contentResearchAgentUsed: 'gemini' },
    });

    const outcome = await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { content_research: handler },
      outboxStore,
      session: SESSION_WITH_RESEARCH,
      now: NOW,
    });

    expect(outcome.task.status).toBe('queued');

    const pending = await outboxStore.listPending();
    const removedLabels = pending.filter(e => e.topic === 'gh:label:remove').map(e => e.payload.label);
    expect(removedLabels).toContain('status:content-needed');
    expect(removedLabels).toContain('agent:gemini');
  });
});

describe('runNextPhase outbox side effects — content_research failure', () => {
  const SESSION_WITH_RESEARCH = {
    ...SESSION,
    defaults: { ...SESSION.defaults, researchAgent: 'gemini' },
  };

  test('enqueues a fixed-outcome failure comment without error details', async () => {
    // Public-status contract: only a fixed status string is published on failure.
    // Raw error output, stderr, diagnostic strings must not appear in the comment.
    await enqueueTask('content_research', {});
    const handler = async () => ({
      result: 'failed',
      error: 'agy: quota exceeded — MUST NOT appear in public comment',
      context: { artifactDir: '/tmp/content-research-artifacts/run-1' },
    });

    await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { content_research: handler },
      outboxStore,
      session: SESSION_WITH_RESEARCH,
      now: NOW,
    });

    const pending = await outboxStore.listPending();
    const comment = pending.find(e => e.topic === 'gh:comment');
    expect(comment).toBeDefined();
    expect(comment.payload.body).toContain('Content research failed');
    // Raw error detail must never appear in the public comment.
    expect(comment.payload.body).not.toContain('quota exceeded');
    expect(comment.payload.body).not.toContain('/tmp/content-research-artifacts');
  });

  test('failure removes content-research lane labels so intake does not re-advertise the task', async () => {
    // Terminal failure must remove status:content-needed and agent:gemini so the
    // failed issue is not picked up again by a label-driven intake scan.
    await enqueueTask('content_research', { artifactDir: '/tmp/content-research-artifacts' });
    const handler = async () => ({
      result: 'failed',
      error: 'agy: command not found (exit 127)',
      context: { artifactDir: '/tmp/content-research-artifacts' },
    });

    const outcome = await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { content_research: handler },
      outboxStore,
      session: SESSION_WITH_RESEARCH,
      now: NOW,
    });

    expect(outcome.task.status).toBe('failed');

    const pending = await outboxStore.listPending();
    const removedLabels = pending.filter(e => e.topic === 'gh:label:remove').map(e => e.payload.label);
    expect(removedLabels).toContain('status:content-needed');
    expect(removedLabels).toContain('agent:gemini');
  });

  test('failure removes configured needsContentResearch label when session overrides the default', async () => {
    const sessionWithConfiguredLabel = {
      ...SESSION_WITH_RESEARCH,
      labels: { ...SESSION_WITH_RESEARCH.labels, needsContentResearch: 'custom:content-queue' },
    };
    await enqueueTask('content_research', {});
    const handler = async () => ({
      result: 'failed',
      error: 'agy: exit 1',
      context: { artifactDir: '/tmp/artifacts' },
    });

    await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { content_research: handler },
      outboxStore,
      session: sessionWithConfiguredLabel,
      now: NOW,
    });

    const pending = await outboxStore.listPending();
    const removedLabels = pending.filter(e => e.topic === 'gh:label:remove').map(e => e.payload.label);
    expect(removedLabels).toContain('custom:content-queue');
    expect(removedLabels).not.toContain('status:content-needed');
  });

  test('Slack failure notification omits reason — content_research public-status contract', async () => {
    // Public-status contract: Slack notifications for content_research must carry
    // only fixed outcome/status values. Variable diagnostic text from result.error
    // must never be forwarded to Slack.
    const sessionWithSlack = {
      ...SESSION_WITH_RESEARCH,
      notifications: {
        slack: { enabled: true, webhookUrlEnv: 'SLACK_WEBHOOK_URL' },
      },
    };
    await enqueueTask('content_research', {});
    const handler = async () => ({
      result: 'failed',
      error: 'agy: unsupported-agent — MUST NOT appear in Slack reason',
      context: { artifactDir: '/tmp/content-research-artifacts/run-1' },
    });

    await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { content_research: handler },
      outboxStore,
      session: sessionWithSlack,
      now: NOW,
    });

    const pending = await outboxStore.listPending();
    const slackEntry = pending.find(e => e.topic === 'slack:notification');
    expect(slackEntry).toBeDefined();
    expect(slackEntry.payload.phase).toBe('content_research');
    expect(slackEntry.payload.transition).toBe('failed');
    // reason must be absent — no diagnostic text forwarded to Slack
    expect(slackEntry.payload.reason).toBeUndefined();
  });
});

describe('runNextPhase outbox side effects — content_review needs_fix cycle cap (issue #603 review follow-up)', () => {
  const SESSION_WITH_CONTENT = {
    ...SESSION,
    defaults: { ...SESSION.defaults, researchAgent: 'gemini' },
  };
  const needsFixHandler = async () => ({
    result: 'needs_fix',
    context: { artifactDir: '/tmp/content-review-artifacts/run-1' },
    message: 'Editorial findings require revision',
  });

  test('under the cap: requeues to content_draft and reports "returned to draft phase"', async () => {
    await enqueueTask('content_review', {});

    const outcome = await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { content_review: needsFixHandler },
      outboxStore,
      session: SESSION_WITH_CONTENT,
      now: NOW,
    });

    expect(outcome.task.status).toBe('queued');
    expect(outcome.task.phase).toBe('content_draft');
    expect(outcome.task.context.contentReviewNeedsFixCycles).toBe(1);

    const pending = await outboxStore.listPending();
    const comment = pending.find(e => e.topic === 'gh:comment');
    expect(comment.payload.body).toContain('Returned to draft phase');
    expect(comment.payload.body).not.toContain('escalated for human review');
  });

  test('cap reached: escalates to ready_for_human and reports the human handoff, not a draft return', async () => {
    // Seed the task as if two real needs_fix cycles have already completed.
    await enqueueTask('content_review', { contentReviewNeedsFixCycles: 2 });

    const outcome = await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { content_review: needsFixHandler },
      outboxStore,
      session: SESSION_WITH_CONTENT,
      now: NOW,
    });

    expect(outcome.task.status).toBe('ready_for_human');
    expect(outcome.task.phase).toBe('content_review');

    const pending = await outboxStore.listPending();
    const comment = pending.find(e => e.topic === 'gh:comment');
    expect(comment.payload.body).toContain('escalated for human review');
    expect(comment.payload.body).not.toContain('Returned to draft phase');
  });

  test('quota-delayed reclaims do not count toward the cap (issue #603 review follow-up)', async () => {
    // Two quota/rate-limit delays followed by the first real needs_fix must NOT
    // reach the cap — attempts.content_review is inflated by claim-time retries
    // that never produced an editorial verdict.
    await enqueueTask('content_review', {});
    const delayedHandler = async () => ({
      result: 'delayed',
      context: { artifactDir: '/tmp/content-review-artifacts/run-1' },
      retryAfterMs: 1000,
    });

    const delay1 = await runNextPhase({
      store: taskStore,
      request: { ...REQUEST, runId: 'run-delay-1' },
      handlers: { content_review: delayedHandler },
      outboxStore,
      session: SESSION_WITH_CONTENT,
      now: NOW,
    });
    expect(delay1.status).toBe('delayed');

    const afterFirstDelay = new Date(Date.parse(NOW) + 2000).toISOString();
    const delay2 = await runNextPhase({
      store: taskStore,
      request: { ...REQUEST, runId: 'run-delay-2' },
      handlers: { content_review: delayedHandler },
      outboxStore,
      session: SESSION_WITH_CONTENT,
      now: afterFirstDelay,
    });
    expect(delay2.status).toBe('delayed');

    const afterSecondDelay = new Date(Date.parse(NOW) + 4000).toISOString();
    const outcome = await runNextPhase({
      store: taskStore,
      request: { ...REQUEST, runId: 'run-needs-fix-1' },
      handlers: { content_review: needsFixHandler },
      outboxStore,
      session: SESSION_WITH_CONTENT,
      now: afterSecondDelay,
    });

    // Two delayed reclaims inflated attempts.content_review to 3 (the old cap
    // threshold), but only one real needs_fix cycle has completed — so this
    // must requeue to content_draft, not escalate to ready_for_human.
    expect(outcome.task.attempts.content_review).toBe(3);
    expect(outcome.task.status).toBe('queued');
    expect(outcome.task.phase).toBe('content_draft');
    expect(outcome.task.context.contentReviewNeedsFixCycles).toBe(1);
  });
});
