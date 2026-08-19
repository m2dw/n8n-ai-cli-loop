/**
 * Refinement-phase execution through the ordinary phase runner (issue #869
 * review follow-up): a claimed `refinement` task runs on the normal tick, the
 * handler's audit events land with the completion, and the only GitHub side
 * effect any outcome may enqueue is the §13 handoff publication (issue #936).
 * The loop still may not mutate Issue bodies, dependencies, branches, or PRs on
 * its own behalf, and the generic completion builders (handler comment, coarse
 * status labels, PR summary, human-gate summary) stay off this phase entirely.
 *
 * The session deliberately configures the full label set (readyForHuman,
 * needsReview, needsImplementation): for any other phase these completions
 * WOULD enqueue comment/label effects, so an empty outbox on the non-handoff
 * outcomes pins the refinement effect gate, not a fixture accident — and the
 * two rows on the handoff pin that the gate is a gate, not a blackout.
 */
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SqliteTaskStore } from '../dist/stores/sqlite-task-store.js';
import { SqliteOutboxStore } from '../dist/stores/sqlite-outbox-store.js';
import { runNextPhase } from '../dist/core/phase-runner.js';

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

const NOW = '2026-08-10T10:00:00.000Z';
const KEY = { sessionId: 'test-session', issueNumber: 99 };

const REQUEST = {
  sessionId: 'test-session',
  workerId: 'w1',
  runId: 'run-refine-1',
  supportedPhases: ['refinement'],
  now: NOW,
};

async function enqueueRefinementTask(context = {}) {
  return taskStore.enqueueTask({
    sessionId: 'test-session',
    issueNumber: 99,
    phase: 'refinement',
    now: NOW,
    context,
  });
}

async function run(handler) {
  return runNextPhase({
    store: taskStore,
    request: REQUEST,
    handlers: { refinement: handler },
    outboxStore,
    session: SESSION,
    now: NOW,
  });
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'pr-refinement-test-'));
  dbPath = join(tmpDir, 'test.db');
  taskStore = new SqliteTaskStore(dbPath);
  outboxStore = new SqliteOutboxStore(dbPath);
});

afterEach(() => {
  taskStore.close();
  outboxStore.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('runNextPhase — refinement phase (issue #869)', () => {
  test('a refinement-advertising claim executes the handler; acceptance stays queued at this phase for the apply run, with the block, its events, and an empty outbox', async () => {
    await enqueueRefinementTask({ refinement: { state: 'eligible' } });
    const handler = async () => ({
      result: 'success',
      message: 'refinement accepted after 1 round(s)',
      context: { refinement: { state: 'accepted' } },
      extraEvents: [
        { type: 'refinement.critique.passed', data: { issueNumber: 99, round: 1 } },
      ],
    });

    const outcome = await run(handler);

    expect(outcome.status).toBe('completed');
    const task = await taskStore.getTask(KEY);
    // Issue #870: a refinement success is a mid-lane step — the next tick
    // re-claims the row and continues into the application walk (row 22),
    // instead of parking a block that used to have nowhere to go.
    expect(task.status).toBe('queued');
    expect(task.phase).toBe('refinement');
    expect(task.context.refinement.state).toBe('accepted');

    const types = (await taskStore.listEvents(KEY)).map((e) => e.type);
    expect(types).toContain('refinement.critique.passed');
    expect(types).toContain('phase.completed');

    // No comment, no label, no PR summary, no human-gate summary: nothing.
    expect(await outboxStore.listPending()).toHaveLength(0);
  });

  test('an activated application (success + refinementActivation) parks the shared row blocked/implementation in the same transaction (row 45)', async () => {
    await enqueueRefinementTask({
      assignment: { implementationAgent: 'claude', flow: 'code' },
      refinement: { state: 'applying' },
    });
    const handler = async () => ({
      result: 'success',
      message: 'refinement applied and implementation activated',
      context: { refinement: { state: 'activated' } },
      extraEvents: [{ type: 'refinement.activated', data: { issueNumber: 99 } }],
      refinementActivation: { targetStatus: 'blocked', targetPhase: 'implementation' },
    });

    const outcome = await run(handler);

    expect(outcome.status).toBe('completed');
    const task = await taskStore.getTask(KEY);
    // The park and the `activated` block commit together: the row lands at
    // the hold-and-reactivate shape ordinary intake already reactivates
    // (issue #224), with `context.assignment` untouched (§14).
    expect(task.status).toBe('blocked');
    expect(task.phase).toBe('implementation');
    expect(task.context.refinement.state).toBe('activated');
    expect(task.context.assignment).toEqual({ implementationAgent: 'claude', flow: 'code' });

    const types = (await taskStore.listEvents(KEY)).map((e) => e.type);
    expect(types).toContain('refinement.activated');
    expect(types).toContain('phase.completed');

    // The application performed its GitHub writes through the apply port
    // inside the run; the completion itself still enqueues nothing.
    expect(await outboxStore.listPending()).toHaveLength(0);
  });

  test('an escalation (blocked) lands ready_for_human with the handoff block and publishes the §13 label and comment', async () => {
    await enqueueRefinementTask({ refinement: { state: 'eligible' } });
    const handler = async () => ({
      result: 'blocked',
      message: 'refinement escalated to human: no_convergence',
      context: { refinement: { state: 'escalated_human', handoffReason: 'no_convergence' } },
      extraEvents: [
        { type: 'refinement.escalated.human', data: { issueNumber: 99, reason: 'no_convergence' } },
      ],
    });

    const outcome = await run(handler);

    expect(outcome.status).toBe('completed');
    const task = await taskStore.getTask(KEY);
    expect(task.status).toBe('ready_for_human');
    expect(task.phase).toBe('refinement');
    expect(task.context.refinement.handoffReason).toBe('no_convergence');

    const types = (await taskStore.listEvents(KEY)).map((e) => e.type);
    expect(types).toContain('refinement.escalated.human');
    expect(types).toContain('phase.completed');

    // Issue #936: before this, a terminal handoff left the Issue carrying only
    // `status:needs-refinement` — the stop was discoverable through
    // `admin task-status` and nowhere else.
    const rows = await outboxStore.listPending();
    expect(rows.map((r) => r.topic)).toEqual(['gh:label:add', 'gh:comment']);
    expect(rows[0].payload).toMatchObject({ issueNumber: 99, label: 'ai:ready-for-human' });
    expect(rows[1].payload.body).toContain('`no_convergence`');
    // The generic completion builders stay off this phase: no needsReview /
    // needsImplementation cleanup, no handler comment, no coarse `blocked` label.
    // §13 item 2 in particular — the ONLY label this completion touches is the
    // ready-for-human one; the marker is left where it is and no executable
    // `status:*` label is added beside it. (The comment BODY names
    // `status:needs-implementation` as the operator's manual next step, which is
    // why this asserts over the label effects rather than the whole payload.)
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.topic.startsWith('gh:label')).map((r) => r.payload.label)).toEqual([
      'ai:ready-for-human',
    ]);
  });

  test('a terminal agent_unavailable handoff commits its publication in the SAME transaction as the transition', async () => {
    await enqueueRefinementTask({ refinement: { state: 'drafting' } });
    const handler = async () => ({
      result: 'blocked',
      message: 'refinement escalated to human: agent_unavailable',
      context: {
        refinement: {
          state: 'escalated_human',
          handoffReason: 'agent_unavailable',
          counters: {
            rounds: 0,
            malformedAttempts: { refiner: 0, critic: 0 },
            agentFailures: { refiner: 2, critic: 0 },
            staleRestarts: 0,
          },
        },
      },
      extraEvents: [
        { type: 'refinement.escalated.human', data: { issueNumber: 99, reason: 'agent_unavailable' } },
      ],
    });

    const calls = [];
    const recording = new Proxy(taskStore, {
      get(target, prop) {
        const value = target[prop];
        if (typeof value !== 'function') return value;
        return (...args) => {
          calls.push({ method: prop, args });
          return value.apply(target, args);
        };
      },
    });

    const outcome = await runNextPhase({
      store: recording,
      request: REQUEST,
      handlers: { refinement: handler },
      outboxStore,
      session: SESSION,
      now: NOW,
    });

    expect(outcome.status).toBe('completed');
    // The task store and the outbox share the SQLite file, so the effects ride
    // inside `completePhaseWithEffects` rather than being written separately:
    // a handoff cannot commit with its publication missing (issue #701).
    const commits = calls.filter((c) => c.method === 'completePhaseWithEffects');
    expect(commits).toHaveLength(1);
    const [, effects] = commits[0].args;
    expect(effects.map((e) => e.input.topic)).toEqual(['gh:label:add', 'gh:comment']);

    const rows = await outboxStore.listPending();
    expect(rows).toHaveLength(2);
    const body = rows[1].payload.body;
    expect(body).toContain('`agent_unavailable`');
    expect(body).toContain('| Agent process failures (refiner / critic) | 2 / 0');
    expect(body).toContain('admin task cancel');
    // §16: no run id, no artifact path, no raw agent output.
    expect(body).not.toContain('run-refine-1');
  });

  test('a claimed task whose block was ALREADY escalated republishes nothing', async () => {
    await enqueueRefinementTask({
      refinement: { state: 'escalated_human', handoffReason: 'no_convergence' },
    });
    // The loop refuses a terminal block; the runner fails the task and persists
    // no context patch, so there is no escalation "in this delivery" to publish
    // — the earlier run already did.
    const handler = async () => ({
      result: 'failed',
      error: 'refinement block is not runnable (state=escalated_human)',
    });

    const outcome = await run(handler);

    expect(outcome.status).toBe('completed');
    expect((await taskStore.getTask(KEY)).status).toBe('failed');
    expect(await outboxStore.listPending()).toHaveLength(0);
  });

  test('a hold (delayed) releases the task back to queued with its audit event and no quota comment', async () => {
    await enqueueRefinementTask({ refinement: { state: 'pending' } });
    const handler = async () => ({
      result: 'delayed',
      message: 'refinement held: predecessor_not_ready',
      context: { refinement: { state: 'pending' } },
      extraEvents: [
        { type: 'refinement.eligibility.refused', data: { issueNumber: 99, reason: 'predecessor_not_ready' } },
      ],
    });

    const outcome = await run(handler);

    expect(outcome.status).toBe('delayed');
    const task = await taskStore.getTask(KEY);
    expect(task.status).toBe('queued');
    expect(task.phase).toBe('refinement');
    expect(task.notBefore).toBeDefined();

    const types = (await taskStore.listEvents(KEY)).map((e) => e.type);
    expect(types).toContain('refinement.eligibility.refused');
    expect(types).toContain('phase.delayed');

    expect(await outboxStore.listPending()).toHaveLength(0);
  });

  test('a delayed release commits its handler audit events in the same store transaction as the requeue', async () => {
    await enqueueRefinementTask({ refinement: { state: 'drafting' } });
    const handler = async () => ({
      result: 'delayed',
      message: 'refinement refiner process failure (usage_quota) in round 1',
      context: {
        refinement: { state: 'drafting', pendingRetry: { role: 'refiner', round: 1, attempt: 1 } },
      },
      extraEvents: [
        { type: 'refinement.agent.failed', data: { issueNumber: 99, role: 'refiner', failureKind: 'usage_quota' } },
        { type: 'refinement.roles.resolved', data: { issueNumber: 99 } },
      ],
    });

    const calls = [];
    const record = (method) => (...args) => {
      calls.push({ method, args });
      return taskStore[method](...args);
    };
    const recording = {
      backendId: taskStore.backendId,
      enqueueTask: record('enqueueTask'),
      getTask: record('getTask'),
      claimNextTask: record('claimNextTask'),
      transitionTask: record('transitionTask'),
      releaseClaim: record('releaseClaim'),
      appendEvent: record('appendEvent'),
      listEvents: record('listEvents'),
      completePhaseWithEffects: record('completePhaseWithEffects'),
      listSessionTasks: record('listSessionTasks'),
      recoverTask: record('recoverTask'),
      recoverHandoff: record('recoverHandoff'),
      recoverCapHandoff: record('recoverCapHandoff'),
      clearTaskDelay: record('clearTaskDelay'),
      cancelTask: record('cancelTask'),
      cancelTaskWithEffects: record('cancelTaskWithEffects'),
    };

    const outcome = await runNextPhase({
      store: recording,
      request: REQUEST,
      handlers: { refinement: handler },
      outboxStore,
      session: SESSION,
      now: NOW,
    });

    expect(outcome.status).toBe('delayed');

    // The requeue (queued + notBefore + pendingRetry context) and its cause
    // land in ONE transactional store call: a failed event write must refuse
    // the release, never strand a persisted retry position whose hold/failure
    // record is missing from the log for good.
    const commits = calls.filter((c) => c.method === 'completePhaseWithEffects');
    expect(commits).toHaveLength(1);
    const [transition, effects] = commits[0].args;
    expect(transition.patch.status).toBe('queued');
    expect(transition.patch.notBefore).toBeDefined();
    expect([transition.event.type, ...(transition.extraEvents ?? []).map((e) => e.type)]).toEqual([
      'refinement.agent.failed',
      'refinement.roles.resolved',
    ]);
    expect(effects).toHaveLength(0);

    // No refinement.* event travels through a separate best-effort append;
    // only `phase.delayed` keeps that treatment, as on every delayed path.
    const appended = calls.filter((c) => c.method === 'appendEvent').map((c) => c.args[0].type);
    expect(appended.filter((t) => t.startsWith('refinement.'))).toHaveLength(0);
    expect(appended).toContain('phase.delayed');

    const task = await taskStore.getTask(KEY);
    expect(task.status).toBe('queued');
    expect(task.notBefore).toBeDefined();
    expect(task.context.refinement.pendingRetry).toMatchObject({ role: 'refiner', round: 1 });
    const persisted = (await taskStore.listEvents(KEY)).map((e) => e.type);
    expect(persisted).toContain('refinement.agent.failed');
    expect(persisted).toContain('refinement.roles.resolved');
    expect(persisted).toContain('phase.delayed');

    expect(await outboxStore.listPending()).toHaveLength(0);
  });
});
