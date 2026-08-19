import { MemoryTaskStore, nextPhaseAfter, runNextPhase } from '../dist/index.js';

describe('MemoryTaskStore', () => {
  test('claims one runnable task atomically for a session', async () => {
    const store = new MemoryTaskStore();
    await store.enqueueTask({
      sessionId: 'addon-dev',
      issueNumber: 134,
      phase: 'implementation',
      priority: 'normal',
      now: '2026-06-06T00:00:00.000Z',
    });

    const claimed = await store.claimNextTask({
      sessionId: 'addon-dev',
      workerId: 'worker-a',
      runId: 'run-1',
      now: '2026-06-06T00:01:00.000Z',
      leaseMs: 60000,
    });
    const secondClaim = await store.claimNextTask({
      sessionId: 'addon-dev',
      workerId: 'worker-b',
      runId: 'run-2',
      now: '2026-06-06T00:01:01.000Z',
      leaseMs: 60000,
    });

    expect(claimed).toMatchObject({
      issueNumber: 134,
      status: 'claimed',
      ownerRunId: 'run-1',
      context: { workerId: 'worker-a' },
    });
    expect(secondClaim).toBeUndefined();
  });

  test('does not claim tasks from another session', async () => {
    const store = new MemoryTaskStore();
    await store.enqueueTask({
      sessionId: 'addon-dev',
      issueNumber: 134,
      phase: 'implementation',
      now: '2026-06-06T00:00:00.000Z',
    });

    const claimed = await store.claimNextTask({
      sessionId: 'workflow-dev',
      workerId: 'worker-a',
      runId: 'run-1',
      now: '2026-06-06T00:01:00.000Z',
    });

    expect(claimed).toBeUndefined();
  });

  test('transitionTask uses compare-and-swap expectations', async () => {
    const store = new MemoryTaskStore();
    await store.enqueueTask({
      sessionId: 'addon-dev',
      issueNumber: 134,
      phase: 'implementation',
      now: '2026-06-06T00:00:00.000Z',
    });
    await store.claimNextTask({
      sessionId: 'addon-dev',
      workerId: 'worker-a',
      runId: 'run-1',
      now: '2026-06-06T00:01:00.000Z',
    });

    const conflict = await store.transitionTask(
      { sessionId: 'addon-dev', issueNumber: 134 },
      { status: 'queued' },
      { status: 'running', now: '2026-06-06T00:02:00.000Z' },
    );
    const updated = await store.transitionTask(
      { sessionId: 'addon-dev', issueNumber: 134 },
      { status: 'claimed', ownerRunId: 'run-1' },
      { status: 'running', now: '2026-06-06T00:02:00.000Z' },
    );

    expect(conflict).toMatchObject({ ok: false, code: 'conflict' });
    expect(updated).toMatchObject({ ok: true, value: { status: 'running', ownerRunId: 'run-1' } });
  });

  test('releaseClaim only releases the matching owner', async () => {
    const store = new MemoryTaskStore();
    await store.enqueueTask({
      sessionId: 'addon-dev',
      issueNumber: 134,
      phase: 'implementation',
      now: '2026-06-06T00:00:00.000Z',
    });
    await store.claimNextTask({
      sessionId: 'addon-dev',
      workerId: 'worker-a',
      runId: 'run-1',
      now: '2026-06-06T00:01:00.000Z',
    });

    const wrongOwner = await store.releaseClaim({ sessionId: 'addon-dev', issueNumber: 134 }, 'run-2');
    const released = await store.releaseClaim({ sessionId: 'addon-dev', issueNumber: 134 }, 'run-1');

    expect(wrongOwner).toMatchObject({ ok: false, code: 'conflict' });
    expect(released).toMatchObject({ ok: true, value: { status: 'queued' } });
  });

  test('expired claims become runnable again', async () => {
    const store = new MemoryTaskStore();
    await store.enqueueTask({
      sessionId: 'addon-dev',
      issueNumber: 134,
      phase: 'implementation',
      now: '2026-06-06T00:00:00.000Z',
    });
    await store.claimNextTask({
      sessionId: 'addon-dev',
      workerId: 'worker-a',
      runId: 'run-1',
      now: '2026-06-06T00:01:00.000Z',
      leaseMs: 1000,
    });

    const reclaimed = await store.claimNextTask({
      sessionId: 'addon-dev',
      workerId: 'worker-b',
      runId: 'run-2',
      now: '2026-06-06T00:01:02.000Z',
    });

    expect(reclaimed).toMatchObject({
      issueNumber: 134,
      status: 'claimed',
      ownerRunId: 'run-2',
      context: { workerId: 'worker-b' },
    });
  });
});

describe('phase transitions', () => {
  test('dispatches one phase at a time without encoding n8n node order', () => {
    expect(nextPhaseAfter('implementation', 'success')).toEqual({
      status: 'queued',
      phase: 'review',
    });
    expect(nextPhaseAfter('review', 'conflict')).toEqual({
      status: 'queued',
      phase: 'conflict_resolution',
    });
    expect(nextPhaseAfter('conflict_resolution', 'success')).toEqual({
      status: 'queued',
      phase: 'review',
    });
  });

  test('an implementation needs_fix requeues the same task at implementation (issue #934)', () => {
    // A verification failure the implementation agent can keep working on: the
    // handler already decided the task may go round again (and owns the cycle
    // cap), so this table only names the destination.
    expect(nextPhaseAfter('implementation', 'needs_fix')).toEqual({
      status: 'queued',
      phase: 'implementation',
    });
  });

  test('a blocked conflict_resolution result escalates to ready_for_human by default', () => {
    // A genuine handler-decided escalation (e.g. a non-auto-resolvable or
    // repeated semantic conflict) is a terminal human handoff, unaffected by
    // the admission-rejected hold below.
    expect(nextPhaseAfter('conflict_resolution', 'blocked')).toEqual({
      status: 'ready_for_human',
      phase: 'conflict_resolution',
    });
  });

  test('a report-only admission rejection of conflict_resolution stays a resumable hold (issue #532 review)', () => {
    // The phase-admission preflight (report-only mode) rejects the task before
    // the lock/worktree/handler ever ran, so — unlike a genuine handler-decided
    // escalation — it must stay eligible for reactivation once report-only mode
    // is disabled, mirroring the dependency-blocked implementation hold below.
    expect(nextPhaseAfter('conflict_resolution', 'blocked', undefined, true)).toEqual({
      status: 'blocked',
      phase: 'conflict_resolution',
    });
  });

  test('admissionRejected has no effect on phases other than conflict_resolution', () => {
    expect(nextPhaseAfter('implementation', 'blocked', undefined, true)).toEqual({
      status: 'blocked',
      phase: 'implementation',
    });
    expect(nextPhaseAfter('review', 'blocked', undefined, true)).toEqual({
      status: 'ready_for_human',
      phase: 'review',
    });
  });

  test('review success becomes ready_for_human', () => {
    expect(nextPhaseAfter('review', 'success')).toEqual({
      status: 'ready_for_human',
      phase: 'review',
    });
    expect(nextPhaseAfter('review', 'success', { context: { prUrl: 'x' } })).toEqual({
      status: 'ready_for_human',
      phase: 'review',
    });
  });

  test('review success on a dependency-started task hands off as ready_for_human, not blocked (issue #242)', () => {
    // A dependency-started PR targets the session base branch (`main`) like any
    // other PR, so a passing review follows the normal ready_for_human handoff.
    // The presence of dependencyBase metadata must NOT hold it blocked.
    const task = {
      context: {
        dependencyBase: {
          baseIssueNumber: 50,
          basePrNumber: 55,
          baseHeadRefName: 'ai/issue-50',
          basePrUrl: 'https://github.com/owner/repo/pull/55',
        },
      },
    };
    expect(nextPhaseAfter('review', 'success', task)).toEqual({
      status: 'ready_for_human',
      phase: 'review',
    });
  });

  test('content_review needs_fix requeues to content_draft while under the cycle cap (issue #603)', () => {
    expect(nextPhaseAfter('content_review', 'needs_fix', { context: {} })).toEqual({
      status: 'queued',
      phase: 'content_draft',
      contextPatch: { contentReviewNeedsFixCycles: 1 },
    });
    expect(nextPhaseAfter('content_review', 'needs_fix', { context: { contentReviewNeedsFixCycles: 1 } })).toEqual({
      status: 'queued',
      phase: 'content_draft',
      contextPatch: { contentReviewNeedsFixCycles: 2 },
    });
    // No task/context supplied at all — treated as the first cycle, not capped.
    expect(nextPhaseAfter('content_review', 'needs_fix')).toEqual({
      status: 'queued',
      phase: 'content_draft',
      contextPatch: { contentReviewNeedsFixCycles: 1 },
    });
  });

  test('content_review needs_fix escalates to ready_for_human once the cycle cap is reached (issue #603)', () => {
    expect(nextPhaseAfter('content_review', 'needs_fix', { context: { contentReviewNeedsFixCycles: 2 } })).toEqual({
      status: 'ready_for_human',
      phase: 'content_review',
    });
    expect(nextPhaseAfter('content_review', 'needs_fix', { context: { contentReviewNeedsFixCycles: 3 } })).toEqual({
      status: 'ready_for_human',
      phase: 'content_review',
    });
  });

  test('content_review needs_fix restores artifactDir from researchArtifactDir only while under the cap', () => {
    // content_draft reads context.artifactDir as the research dir on every run,
    // so the requeue-to-content_draft branch must restore it from
    // researchArtifactDir (stashed by content_draft's success context) —
    // but only when actually continuing the cycle, not on the terminal
    // ready_for_human path (issue #604 review follow-up).
    expect(
      nextPhaseAfter('content_review', 'needs_fix', {
        context: { artifactDir: '/artifacts/runs/draft-1', researchArtifactDir: '/artifacts/runs/research-1' },
      }),
    ).toEqual({
      status: 'queued',
      phase: 'content_draft',
      contextPatch: { contentReviewNeedsFixCycles: 1, artifactDir: '/artifacts/runs/research-1' },
    });

    // Cap reached: no contextPatch at all, so the caller's artifactDir
    // (left as the draft dir by the content_review handler) is untouched.
    expect(
      nextPhaseAfter('content_review', 'needs_fix', {
        context: {
          artifactDir: '/artifacts/runs/draft-1',
          researchArtifactDir: '/artifacts/runs/research-1',
          contentReviewNeedsFixCycles: 2,
        },
      }),
    ).toEqual({
      status: 'ready_for_human',
      phase: 'content_review',
    });
  });

  test('content_review needs_fix cap counts only real needs_fix cycles, not quota-delayed attempts (issue #603)', () => {
    // A high `attempts.content_review` (inflated by quota/rate-limit delayed
    // retries that never produced a verdict) must NOT trip the cap — only the
    // context-tracked count of actual needs_fix outcomes matters.
    expect(
      nextPhaseAfter('content_review', 'needs_fix', {
        attempts: { content_review: 10 },
        context: {},
      }),
    ).toEqual({
      status: 'queued',
      phase: 'content_draft',
      contextPatch: { contentReviewNeedsFixCycles: 1 },
    });
  });
});

describe('runNextPhase', () => {
  test('runs only the claimed phase and persists the next state', async () => {
    const store = new MemoryTaskStore();
    await store.enqueueTask({
      sessionId: 'addon-dev',
      issueNumber: 134,
      phase: 'implementation',
      implementationAgent: 'claude',
      reviewAgent: 'codex',
      now: '2026-06-06T00:00:00.000Z',
    });

    const outcome = await runNextPhase({
      store,
      request: {
        sessionId: 'addon-dev',
        workerId: 'worker-a',
        runId: 'run-1',
        now: '2026-06-06T00:01:00.000Z',
      },
      handlers: {
        implementation: async (task) => ({
          result: 'success',
          context: { handledIssue: task.issueNumber },
        }),
      },
    });

    expect(outcome).toMatchObject({
      status: 'completed',
      task: {
        status: 'queued',
        phase: 'review',
        ownerRunId: undefined,
        context: { handledIssue: 134 },
        attempts: { implementation: 1 },
      },
    });
    await expect(store.listEvents({ sessionId: 'addon-dev', issueNumber: 134 })).resolves.toMatchObject([
      { type: 'phase.started', runId: 'run-1' },
      { type: 'phase.completed', runId: 'run-1' },
    ]);
  });

  test('moves missing phase handlers to human review', async () => {
    const store = new MemoryTaskStore();
    await store.enqueueTask({
      sessionId: 'addon-dev',
      issueNumber: 135,
      phase: 'review',
      now: '2026-06-06T00:00:00.000Z',
    });

    const outcome = await runNextPhase({
      store,
      request: {
        sessionId: 'addon-dev',
        workerId: 'worker-a',
        runId: 'run-1',
        now: '2026-06-06T00:01:00.000Z',
      },
      handlers: {},
    });

    expect(outcome).toMatchObject({
      status: 'phase_missing',
      task: {
        status: 'ready_for_human',
        phase: 'review',
        lastError: 'No handler registered for phase: review',
      },
    });
  });
});

describe('MemoryTaskStore — supportedPhases filtering', () => {
  test('claimNextTask skips tasks whose phase is not in supportedPhases', async () => {
    const store = new MemoryTaskStore();
    await store.enqueueTask({ sessionId: 'addon-dev', issueNumber: 1, phase: 'implementation', now: '2026-06-07T00:00:00.000Z' });

    const claimed = await store.claimNextTask({
      sessionId: 'addon-dev', workerId: 'w', runId: 'r1',
      now: '2026-06-07T00:01:00.000Z',
      supportedPhases: ['research'],
    });
    expect(claimed).toBeUndefined();
  });

  test('claimNextTask claims task whose phase is in supportedPhases', async () => {
    const store = new MemoryTaskStore();
    await store.enqueueTask({ sessionId: 'addon-dev', issueNumber: 2, phase: 'research', now: '2026-06-07T00:00:00.000Z' });

    const claimed = await store.claimNextTask({
      sessionId: 'addon-dev', workerId: 'w', runId: 'r1',
      now: '2026-06-07T00:01:00.000Z',
      supportedPhases: ['research'],
    });
    expect(claimed).toMatchObject({ phase: 'research', status: 'claimed' });
  });

  test('claimNextTask with supportedPhases picks research over implementation', async () => {
    const store = new MemoryTaskStore();
    await store.enqueueTask({ sessionId: 'addon-dev', issueNumber: 10, phase: 'implementation', now: '2026-06-07T00:00:00.000Z' });
    await store.enqueueTask({ sessionId: 'addon-dev', issueNumber: 11, phase: 'research', now: '2026-06-07T00:00:01.000Z' });

    const claimed = await store.claimNextTask({
      sessionId: 'addon-dev', workerId: 'w', runId: 'r1',
      now: '2026-06-07T00:01:00.000Z',
      supportedPhases: ['research'],
    });
    expect(claimed).toMatchObject({ issueNumber: 11, phase: 'research' });

    // implementation task must remain queued
    const impl = await store.getTask({ sessionId: 'addon-dev', issueNumber: 10 });
    expect(impl?.status).toBe('queued');
  });

  test('claimNextTask with no supportedPhases remains backward compatible', async () => {
    const store = new MemoryTaskStore();
    await store.enqueueTask({ sessionId: 'addon-dev', issueNumber: 20, phase: 'implementation', now: '2026-06-07T00:00:00.000Z' });

    const claimed = await store.claimNextTask({
      sessionId: 'addon-dev', workerId: 'w', runId: 'r1',
      now: '2026-06-07T00:01:00.000Z',
    });
    expect(claimed).toMatchObject({ phase: 'implementation' });
  });
});

// issue #677 review follow-up: mirror the SqliteTaskStore guard — a review-phase
// row carrying an unresolved implementation Tool Request (however it reached
// queued/review) must never be claimed, so the review handler's own `failed`
// backstop never fires and overwrites the real ready_for_human/implementation
// handoff.
describe('MemoryTaskStore — claimNextTask refuses a review-phase task with an unresolved Tool Request (issue #677)', () => {
  async function seedBypassedReviewRow(store, issueNumber) {
    await store.enqueueTask({
      sessionId: 'addon-dev',
      issueNumber,
      phase: 'review',
      reviewAgent: 'gemini',
      now: '2026-06-07T00:00:00.000Z',
    });
    await store.transitionTask(
      { sessionId: 'addon-dev', issueNumber },
      { status: 'queued' },
      {
        status: 'queued',
        phase: 'review',
        now: '2026-06-07T00:01:00.000Z',
        context: {
          toolRequest: {
            command: 'npm install left-pad',
            displayCommand: 'npm install left-pad',
            reason: 'needed for the fix',
            expectedFiles: ['package.json'],
            necessity: 'required',
            requestedBy: 'claude',
            mode: 'new',
            requestedAt: '2026-06-07T00:01:00.000Z',
            resolved: false,
          },
        },
      },
    );
  }

  test('claimNextTask skips the row instead of claiming it into running/review', async () => {
    const store = new MemoryTaskStore();
    await seedBypassedReviewRow(store, 400);

    const claimed = await store.claimNextTask({
      sessionId: 'addon-dev', workerId: 'w', runId: 'r1',
      now: '2026-06-07T00:02:00.000Z',
    });

    expect(claimed).toBeUndefined();
    const task = await store.getTask({ sessionId: 'addon-dev', issueNumber: 400 });
    expect(task).toMatchObject({ status: 'queued', phase: 'review' });
    expect(task.context.toolRequest.resolved).toBe(false);
  });

  test('a resolved Tool Request no longer blocks the claim', async () => {
    const store = new MemoryTaskStore();
    await seedBypassedReviewRow(store, 401);
    await store.transitionTask(
      { sessionId: 'addon-dev', issueNumber: 401 },
      { status: 'queued' },
      {
        context: {
          toolRequest: {
            command: 'npm install left-pad',
            displayCommand: 'npm install left-pad',
            reason: 'needed for the fix',
            expectedFiles: ['package.json'],
            necessity: 'required',
            requestedBy: 'claude',
            mode: 'new',
            requestedAt: '2026-06-07T00:01:00.000Z',
            resolved: true,
            resolution: { action: 'manual-done', resolvedAt: '2026-06-07T00:01:30.000Z' },
          },
        },
        now: '2026-06-07T00:01:45.000Z',
      },
    );

    const claimed = await store.claimNextTask({
      sessionId: 'addon-dev', workerId: 'w', runId: 'r1',
      now: '2026-06-07T00:02:00.000Z',
    });

    expect(claimed).toMatchObject({ status: 'claimed', phase: 'review', issueNumber: 401 });
  });
});

describe('MemoryTaskStore — completePhaseWithEffects (issue #701)', () => {
  test('commits the transition and its event; a CAS conflict leaves the task untouched', async () => {
    const store = new MemoryTaskStore();
    await store.enqueueTask({ sessionId: 'addon-dev', issueNumber: 500, phase: 'implementation', now: '2026-06-07T00:00:00.000Z' });
    await store.claimNextTask({ sessionId: 'addon-dev', workerId: 'w', runId: 'run-1', now: '2026-06-07T00:00:01.000Z' });
    await store.transitionTask(
      { sessionId: 'addon-dev', issueNumber: 500 },
      { status: 'claimed' },
      { status: 'running', now: '2026-06-07T00:00:02.000Z' },
    );

    const ok = await store.completePhaseWithEffects(
      {
        key: { sessionId: 'addon-dev', issueNumber: 500 },
        expected: { status: 'running', phase: 'implementation', ownerRunId: 'run-1' },
        patch: { status: 'ready_for_human', ownerRunId: undefined, leaseExpiresAt: undefined, now: '2026-06-07T00:00:03.000Z' },
        event: { task: { sessionId: 'addon-dev', issueNumber: 500 }, type: 'phase.completed', runId: 'run-1', createdAt: '2026-06-07T00:00:03.000Z' },
      },
      [
        {
          kind: 'enqueue',
          input: {
            idempotencyKey: 'addon-dev:500:run-1:gh:comment',
            topic: 'gh:comment',
            payload: { topic: 'gh:comment', owner: 'org', repo: 'repo', issueNumber: 500, body: 'done' },
          },
        },
      ],
    );

    expect(ok.ok).toBe(true);
    expect(ok.value.status).toBe('ready_for_human');
    const events = await store.listEvents({ sessionId: 'addon-dev', issueNumber: 500 });
    expect(events.map((e) => e.type)).toContain('phase.completed');

    // A conflicting expected leaves the task and its events untouched.
    const conflict = await store.completePhaseWithEffects(
      {
        key: { sessionId: 'addon-dev', issueNumber: 500 },
        expected: { status: 'running' },
        patch: { status: 'failed', now: '2026-06-07T00:00:04.000Z' },
        event: { task: { sessionId: 'addon-dev', issueNumber: 500 }, type: 'phase.completed', runId: 'run-2', createdAt: '2026-06-07T00:00:04.000Z' },
      },
      [],
    );
    expect(conflict.ok).toBe(false);
    expect(conflict.code).toBe('conflict');
    const task = await store.getTask({ sessionId: 'addon-dev', issueNumber: 500 });
    expect(task.status).toBe('ready_for_human');
  });
});

describe('MemoryTaskStore — cancelTaskWithEffects (issue #608 review)', () => {
  test('commits the cancel transition, its task.cancelled event, and the outbox comment together', async () => {
    const store = new MemoryTaskStore();
    await store.enqueueTask({ sessionId: 'addon-dev', issueNumber: 620, phase: 'implementation', now: '2026-06-07T00:00:00.000Z' });

    const ok = await store.cancelTaskWithEffects(
      { sessionId: 'addon-dev', issueNumber: 620 },
      { reason: 'operator abandoned', now: '2026-06-07T00:01:00.000Z' },
      {
        task: { sessionId: 'addon-dev', issueNumber: 620 },
        type: 'task.cancelled',
        runId: 'admin-task-cancel-1',
        message: 'operator abandoned',
        createdAt: '2026-06-07T00:01:00.000Z',
      },
      [
        {
          kind: 'enqueue',
          input: {
            idempotencyKey: 'addon-dev:620:admin-task-cancel-1:gh:comment:task-cancel',
            topic: 'gh:comment',
            payload: { topic: 'gh:comment', owner: 'org', repo: 'repo', issueNumber: 620, body: 'cancelled' },
          },
        },
      ],
    );

    expect(ok.ok).toBe(true);
    expect(ok.value.status).toBe('cancelled');
    const events = await store.listEvents({ sessionId: 'addon-dev', issueNumber: 620 });
    expect(events.map((e) => e.type)).toContain('task.cancelled');

    // A repeat cancellation loses the CAS and must not append a second event.
    const already = await store.cancelTaskWithEffects(
      { sessionId: 'addon-dev', issueNumber: 620 },
      { now: '2026-06-07T00:02:00.000Z' },
      {
        task: { sessionId: 'addon-dev', issueNumber: 620 },
        type: 'task.cancelled',
        runId: 'admin-task-cancel-2',
        createdAt: '2026-06-07T00:02:00.000Z',
      },
      [],
    );
    expect(already.ok).toBe(false);
    expect(already.code).toBe('already_cancelled');
    const eventsAfter = await store.listEvents({ sessionId: 'addon-dev', issueNumber: 620 });
    expect(eventsAfter.filter((e) => e.type === 'task.cancelled')).toHaveLength(1);
  });
});

// Port conformance (issue #613/P1): recoverTask/recoverHandoff/recoverCapHandoff/
// clearTaskDelay/listSessionTasks were promoted onto the `TaskStore` interface so
// MemoryTaskStore is a legitimate fake for admin resource-module tests. These
// mirror the SqliteTaskStore coverage in test/sqlite-task-store.test.js.
describe('MemoryTaskStore — recoverTask', () => {
  test('recovers a failed task back to queued and advances revision', async () => {
    const store = new MemoryTaskStore();
    await store.enqueueTask({ sessionId: 'addon-dev', issueNumber: 400, phase: 'implementation', now: '2026-06-06T00:00:00.000Z' });
    await store.transitionTask(
      { sessionId: 'addon-dev', issueNumber: 400 },
      { status: 'queued' },
      { status: 'failed', now: '2026-06-06T00:01:00.000Z' },
    );
    const before = await store.getTask({ sessionId: 'addon-dev', issueNumber: 400 });

    const result = await store.recoverTask(
      { sessionId: 'addon-dev', issueNumber: 400 },
      { now: '2026-06-06T00:02:00.000Z' },
    );

    expect(result.ok).toBe(true);
    expect(result.value.status).toBe('queued');
    expect(result.value.revision).toBeGreaterThan(before.revision);
  });

  test('refuses a queued task (conflict)', async () => {
    const store = new MemoryTaskStore();
    await store.enqueueTask({ sessionId: 'addon-dev', issueNumber: 401, phase: 'implementation', now: '2026-06-06T00:00:00.000Z' });

    const result = await store.recoverTask({ sessionId: 'addon-dev', issueNumber: 401 });

    expect(result.ok).toBe(false);
    expect(result.code).toBe('conflict');
  });

  test('refuses an unexpired claimed/running lease', async () => {
    const store = new MemoryTaskStore();
    await store.enqueueTask({ sessionId: 'addon-dev', issueNumber: 402, phase: 'implementation', now: '2026-06-06T00:00:00.000Z' });
    await store.claimNextTask({ sessionId: 'addon-dev', workerId: 'w', runId: 'r', now: '2026-06-06T00:01:00.000Z', leaseMs: 600000 });

    const result = await store.recoverTask({ sessionId: 'addon-dev', issueNumber: 402 }, { now: '2026-06-06T00:02:00.000Z' });

    expect(result.ok).toBe(false);
    expect(result.code).toBe('conflict');
  });

  test('returns not_found for a missing task', async () => {
    const store = new MemoryTaskStore();
    const result = await store.recoverTask({ sessionId: 'addon-dev', issueNumber: 40199 });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('not_found');
  });
});

describe('MemoryTaskStore — recoverCapHandoff', () => {
  async function seedCapHandoffTask(store, issueNumber) {
    await store.enqueueTask({ sessionId: 'addon-dev', issueNumber, phase: 'review', now: '2026-06-06T00:00:00.000Z' });
    await store.transitionTask(
      { sessionId: 'addon-dev', issueNumber },
      { status: 'queued' },
      {
        status: 'ready_for_human',
        phase: 'review',
        now: '2026-06-06T00:01:00.000Z',
        context: { reviewLoopCapReached: true, escalatedEffort: true, reviewCycles: 3 },
      },
    );
  }

  test('recovers a cap-handoff task to queued/review, clears cap context, and advances revision', async () => {
    const store = new MemoryTaskStore();
    await seedCapHandoffTask(store, 410);
    const before = await store.getTask({ sessionId: 'addon-dev', issueNumber: 410 });

    const result = await store.recoverCapHandoff(
      { sessionId: 'addon-dev', issueNumber: 410 },
      { now: '2026-06-06T00:02:00.000Z' },
    );

    expect(result.ok).toBe(true);
    expect(result.value).toMatchObject({ status: 'queued', phase: 'review' });
    expect(result.value.context.reviewLoopCapReached).toBeUndefined();
    expect(result.value.context.reviewCycles).toBe(0);
    expect(result.value.revision).toBeGreaterThan(before.revision);
  });

  test('refuses a ready_for_human task without the cap flag', async () => {
    const store = new MemoryTaskStore();
    await store.enqueueTask({ sessionId: 'addon-dev', issueNumber: 411, phase: 'review', now: '2026-06-06T00:00:00.000Z' });
    await store.transitionTask(
      { sessionId: 'addon-dev', issueNumber: 411 },
      { status: 'queued' },
      { status: 'ready_for_human', phase: 'review', now: '2026-06-06T00:01:00.000Z' },
    );

    const result = await store.recoverCapHandoff({ sessionId: 'addon-dev', issueNumber: 411 });

    expect(result.ok).toBe(false);
    expect(result.code).toBe('conflict');
  });

  test('refuses a non-ready_for_human status', async () => {
    const store = new MemoryTaskStore();
    await store.enqueueTask({ sessionId: 'addon-dev', issueNumber: 412, phase: 'implementation', now: '2026-06-06T00:00:00.000Z' });

    const result = await store.recoverCapHandoff({ sessionId: 'addon-dev', issueNumber: 412 });

    expect(result.ok).toBe(false);
    expect(result.code).toBe('conflict');
  });
});

describe('MemoryTaskStore — clearTaskDelay', () => {
  test('clears notBefore on a queued task and advances revision', async () => {
    const store = new MemoryTaskStore();
    await store.enqueueTask({ sessionId: 'addon-dev', issueNumber: 420, phase: 'implementation', now: '2026-06-06T00:00:00.000Z' });
    await store.transitionTask(
      { sessionId: 'addon-dev', issueNumber: 420 },
      { status: 'queued' },
      { status: 'queued', notBefore: '2026-06-07T00:00:00.000Z', now: '2026-06-06T00:01:00.000Z' },
    );
    const before = await store.getTask({ sessionId: 'addon-dev', issueNumber: 420 });

    const result = await store.clearTaskDelay(
      { sessionId: 'addon-dev', issueNumber: 420 },
      { now: '2026-06-06T00:02:00.000Z' },
    );

    expect(result.ok).toBe(true);
    expect(result.value.notBefore).toBeUndefined();
    expect(result.value.revision).toBeGreaterThan(before.revision);
  });

  test('refuses a non-queued task', async () => {
    const store = new MemoryTaskStore();
    await store.enqueueTask({ sessionId: 'addon-dev', issueNumber: 421, phase: 'implementation', now: '2026-06-06T00:00:00.000Z' });
    await store.claimNextTask({ sessionId: 'addon-dev', workerId: 'w', runId: 'r', now: '2026-06-06T00:01:00.000Z' });

    const result = await store.clearTaskDelay({ sessionId: 'addon-dev', issueNumber: 421 });

    expect(result.ok).toBe(false);
    expect(result.code).toBe('conflict');
  });

  test('returns not_found for a missing task', async () => {
    const store = new MemoryTaskStore();
    const result = await store.clearTaskDelay({ sessionId: 'addon-dev', issueNumber: 42199 });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('not_found');
  });
});

// Issue #608: first-class task cancellation. Mirrors the SqliteTaskStore
// `cancelTask` suite so both port implementations pin the same contract.
describe('MemoryTaskStore — cancelTask', () => {
  test('cancels a queued task, clears owner/lease/delay, and advances revision', async () => {
    const store = new MemoryTaskStore();
    await store.enqueueTask({ sessionId: 'addon-dev', issueNumber: 600, phase: 'implementation', now: '2026-06-06T00:00:00.000Z' });
    const before = await store.getTask({ sessionId: 'addon-dev', issueNumber: 600 });

    const result = await store.cancelTask(
      { sessionId: 'addon-dev', issueNumber: 600 },
      { reason: 'operator abandoned', now: '2026-06-06T00:01:00.000Z' },
    );

    expect(result.ok).toBe(true);
    expect(result.value.status).toBe('cancelled');
    expect(result.value.ownerRunId).toBeUndefined();
    expect(result.value.context.cancelledAt).toBe('2026-06-06T00:01:00.000Z');
    expect(result.value.context.cancelReason).toBe('operator abandoned');
    expect(result.value.revision).toBeGreaterThan(before.revision);
  });

  test('cancels a claimed task', async () => {
    const store = new MemoryTaskStore();
    await store.enqueueTask({ sessionId: 'addon-dev', issueNumber: 601, phase: 'implementation', now: '2026-06-06T00:00:00.000Z' });
    await store.claimNextTask({ sessionId: 'addon-dev', workerId: 'w', runId: 'r', now: '2026-06-06T00:01:00.000Z' });

    const result = await store.cancelTask({ sessionId: 'addon-dev', issueNumber: 601 }, { now: '2026-06-06T00:02:00.000Z' });

    expect(result.ok).toBe(true);
    expect(result.value.status).toBe('cancelled');
  });

  test('refuses a done task (conflict)', async () => {
    const store = new MemoryTaskStore();
    await store.enqueueTask({ sessionId: 'addon-dev', issueNumber: 605, phase: 'review', now: '2026-06-06T00:00:00.000Z' });
    await store.transitionTask(
      { sessionId: 'addon-dev', issueNumber: 605 },
      { status: 'queued' },
      { status: 'done', now: '2026-06-06T00:01:00.000Z' },
    );

    const result = await store.cancelTask({ sessionId: 'addon-dev', issueNumber: 605 });

    expect(result.ok).toBe(false);
    expect(result.code).toBe('conflict');
  });

  test('repeated cancellation returns already_cancelled', async () => {
    const store = new MemoryTaskStore();
    await store.enqueueTask({ sessionId: 'addon-dev', issueNumber: 607, phase: 'implementation', now: '2026-06-06T00:00:00.000Z' });
    const first = await store.cancelTask({ sessionId: 'addon-dev', issueNumber: 607 }, { now: '2026-06-06T00:01:00.000Z' });
    expect(first.ok).toBe(true);

    const second = await store.cancelTask({ sessionId: 'addon-dev', issueNumber: 607 }, { now: '2026-06-06T00:02:00.000Z' });

    expect(second.ok).toBe(false);
    expect(second.code).toBe('already_cancelled');
  });

  test('returns not_found for a missing task', async () => {
    const store = new MemoryTaskStore();
    const result = await store.cancelTask({ sessionId: 'addon-dev', issueNumber: 60899 });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('not_found');
  });

  test('a cancelled task is never claimed by claimNextTask', async () => {
    const store = new MemoryTaskStore();
    await store.enqueueTask({ sessionId: 'addon-dev', issueNumber: 608, phase: 'implementation', now: '2026-06-06T00:00:00.000Z' });
    await store.cancelTask({ sessionId: 'addon-dev', issueNumber: 608 }, { now: '2026-06-06T00:01:00.000Z' });

    const claimed = await store.claimNextTask({
      sessionId: 'addon-dev', workerId: 'w', runId: 'r', now: '2026-06-06T00:02:00.000Z',
    });

    expect(claimed).toBeUndefined();
  });
});

describe('MemoryTaskStore — listSessionTasks', () => {
  test('lists every task row for a session, none for another', async () => {
    const store = new MemoryTaskStore();
    await store.enqueueTask({ sessionId: 'addon-dev', issueNumber: 430, phase: 'implementation', now: '2026-06-06T00:00:00.000Z' });
    await store.enqueueTask({ sessionId: 'addon-dev', issueNumber: 431, phase: 'review', now: '2026-06-06T00:00:00.000Z' });
    await store.enqueueTask({ sessionId: 'other-session', issueNumber: 432, phase: 'implementation', now: '2026-06-06T00:00:00.000Z' });

    const tasks = await store.listSessionTasks('addon-dev');

    expect(tasks.map((t) => t.issueNumber).sort()).toEqual([430, 431]);
    expect(await store.listSessionTasks('unknown-session')).toEqual([]);
  });
});

describe('MemoryTaskStore — recoverHandoff (issue #677 Tool Request guard parity)', () => {
  test('refuses to move a ready_for_human task with an unresolved Tool Request', async () => {
    const store = new MemoryTaskStore();
    await store.enqueueTask({ sessionId: 'addon-dev', issueNumber: 440, phase: 'implementation', now: '2026-06-06T00:00:00.000Z' });
    await store.transitionTask(
      { sessionId: 'addon-dev', issueNumber: 440 },
      { status: 'queued' },
      {
        status: 'ready_for_human',
        phase: 'implementation',
        now: '2026-06-06T00:01:00.000Z',
        context: {
          toolRequest: {
            command: 'npm install left-pad',
            displayCommand: 'npm install left-pad',
            reason: 'needed for the fix',
            expectedFiles: ['package.json'],
            necessity: 'required',
            requestedBy: 'claude',
            mode: 'new',
            requestedAt: '2026-06-06T00:01:00.000Z',
            resolved: false,
          },
        },
      },
    );

    const result = await store.recoverHandoff(
      { sessionId: 'addon-dev', issueNumber: 440 },
      { fromStatus: 'ready_for_human', phase: 'review', now: '2026-06-06T00:02:00.000Z' },
    );

    expect(result.ok).toBe(false);
    expect(result.code).toBe('tool_request_unresolved');
  });

  test('recovers to queued at the target phase and advances revision when there is no live Tool Request', async () => {
    const store = new MemoryTaskStore();
    await store.enqueueTask({ sessionId: 'addon-dev', issueNumber: 441, phase: 'review', now: '2026-06-06T00:00:00.000Z' });
    await store.transitionTask(
      { sessionId: 'addon-dev', issueNumber: 441 },
      { status: 'queued' },
      { status: 'ready_for_human', phase: 'review', now: '2026-06-06T00:01:00.000Z' },
    );
    const before = await store.getTask({ sessionId: 'addon-dev', issueNumber: 441 });

    const result = await store.recoverHandoff(
      { sessionId: 'addon-dev', issueNumber: 441 },
      { fromStatus: 'ready_for_human', phase: 'conflict_resolution', now: '2026-06-06T00:02:00.000Z' },
    );

    expect(result.ok).toBe(true);
    expect(result.value).toMatchObject({ status: 'queued', phase: 'conflict_resolution' });
    expect(result.value.revision).toBeGreaterThan(before.revision);
  });

  test('refuses a mismatched fromStatus (conflict)', async () => {
    const store = new MemoryTaskStore();
    await store.enqueueTask({ sessionId: 'addon-dev', issueNumber: 442, phase: 'implementation', now: '2026-06-06T00:00:00.000Z' });

    const result = await store.recoverHandoff(
      { sessionId: 'addon-dev', issueNumber: 442 },
      { fromStatus: 'ready_for_human', phase: 'review', now: '2026-06-06T00:02:00.000Z' },
    );

    expect(result.ok).toBe(false);
    expect(result.code).toBe('conflict');
  });

  test('returns not_found for a missing task', async () => {
    const store = new MemoryTaskStore();
    const result = await store.recoverHandoff(
      { sessionId: 'addon-dev', issueNumber: 44299 },
      { fromStatus: 'ready_for_human', phase: 'review' },
    );
    expect(result.ok).toBe(false);
    expect(result.code).toBe('not_found');
  });
});

describe('MemoryTaskStore appendEventOnce (issue #936 review)', () => {
  const key = { sessionId: 'addon-dev', issueNumber: 697 };

  function event(idempotencyKey) {
    return {
      task: key,
      type: 'refinement.handoff.comment.undeliverable',
      data: { idempotencyKey },
      createdAt: '2026-06-06T00:00:00.000Z',
    };
  }

  test('behaves as the SQLite store does: once per effect, and it says which call wrote it', async () => {
    const store = new MemoryTaskStore();

    expect(await store.appendEventOnce(event('key-a'), { field: 'idempotencyKey', value: 'key-a' })).toBe(true);
    expect(await store.appendEventOnce(event('key-a'), { field: 'idempotencyKey', value: 'key-a' })).toBe(false);
    // A different effect on the same task is a different fact.
    expect(await store.appendEventOnce(event('key-b'), { field: 'idempotencyKey', value: 'key-b' })).toBe(true);

    expect(await store.listEvents(key)).toHaveLength(2);
  });

  test('two concurrent appends of the same effect write it once', async () => {
    const store = new MemoryTaskStore();
    const dedupe = { field: 'idempotencyKey', value: 'key-a' };

    const results = await Promise.all([
      store.appendEventOnce(event('key-a'), dedupe),
      store.appendEventOnce(event('key-a'), dedupe),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await store.listEvents(key)).toHaveLength(1);
  });
});
