/**
 * `admin refinement recover` — §13's operator recovery command
 * (issue #980, docs/issue-refinement-contract.md §13, §12 row 36).
 *
 * Covers the acceptance criteria of the Issue: the preview reports the task,
 * the handoff reason, the observed labels and the planned reset without
 * mutating anything; `--yes` performs row 36 in one guarded transaction; every
 * invalid status/phase/state/label/claim/session/Issue is refused with no
 * partial mutation; a re-run after a successful recovery is a refusal that
 * leaves the fresh attempt alone; the ready-for-human label removal rides the
 * outbox; and the retried attempt's own handoff is published rather than
 * deduped against the one the recovered attempt already posted.
 *
 * Plus the third race (issue #980 review): a recovery that would commit while
 * the handoff's own label add is being dispatched is refused in full rather
 * than applied, since cancelling that row cannot abort the request on the wire.
 */

import { jest } from '@jest/globals';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  DEFAULT_REFINEMENT_MARKER_LABEL,
  IMPLEMENTATION_STATUS_LABEL,
  IssueWorktreeLock,
  MemoryTaskStore,
  SqliteOutboxStore,
  SqliteTaskStore,
  buildRefinementContextBlock,
  cancelPendingOutboxEntriesByKey,
  evaluateRefinementRecoveryLabels,
  evaluateRefinementRecoveryTarget,
  planRefinementRecovery,
  refinementRecoveryCount,
  refinementRecoveryIdempotencyKey,
  recordedRefinementHandoffLabel,
  refinementHandoffEffectFromKey,
  refinementHandoffIdempotencyKey,
  resolveIssueRefinementSettings,
  withRecordedRefinementHandoffLabel,
} from '../dist/index.js';
import {
  parseRefinementRecoverArgs,
  runRefinementRecover,
} from '../dist/cli/issue-refinement-recover.js';
import { COMMANDS } from '../dist/cli/admin.js';
import { OutboxEffectCollector } from '../dist/core/phase-runner.js';
import {
  enqueueRefinementHandoffEffects,
  enqueueRefinementRecoveryEffects,
  refinementHandoffSupersessionEffects,
  refinementRecoverySupersessionEffects,
} from '../dist/core/outbox-effects.js';

const NOW = '2026-08-22T00:00:00.000Z';
const LATER = '2026-08-22T01:00:00.000Z';
const MARKER = DEFAULT_REFINEMENT_MARKER_LABEL;
const LANE_LABELS = { marker: MARKER, implementationStatus: IMPLEMENTATION_STATUS_LABEL };

let tmpDir;
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'refinement-recover-'));
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function settings() {
  const resolution = resolveIssueRefinementSettings({
    enabled: true,
    agents: { refiner: 'claude', critic: 'codex' },
  });
  if (!resolution.ok) throw new Error('bad test settings');
  return resolution.settings;
}

/** A §15 block as it stands after one attempt escalated. */
function escalatedBlock(overrides = {}) {
  const base = buildRefinementContextBlock({
    issueNumber: 951,
    title: 'Downstream Issue',
    body: 'Downstream body',
    labels: ['agent:claude', MARKER],
    agentLabel: 'agent:claude',
    implementationAgent: 'claude',
    refinerAgent: 'claude',
    criticAgent: 'codex',
    settings: settings(),
    laneLabels: LANE_LABELS,
    now: NOW,
  });
  return {
    ...base,
    state: 'escalated_human',
    handoffReason: 'critique_blocked',
    predecessorFingerprint: 'fp-of-the-failed-attempt',
    appliedRegionDigest: 'digest-of-the-failed-attempt',
    predecessors: [{ issueNumber: 950, prNumber: 12, headSha: 'abc', state: 'open' }],
    counters: {
      rounds: 2,
      malformedAttempts: { refiner: 1, critic: 2 },
      agentFailures: { refiner: 3, critic: 0 },
      staleRestarts: 1,
    },
    execution: { runId: 'run-that-failed', refiner: { agentId: 'claude', provider: 'anthropic', model: null, modelSource: 'x', effort: null, effortSource: 'x', invocations: 2, totalDurationMs: 10 }, critic: null },
    accepted: { contract: { summary: 'rejected draft' }, topology: [], refinerConfidence: 'low', criticConfidence: 'low', roundsUsed: 2, regionBytes: 10, acceptedAt: NOW },
    pendingRetry: { role: 'critic', round: 2, attempt: 1, failureKind: 'timeout', recordedAt: NOW },
    apply: { bodyVerified: true, commentPosted: false, commentNonce: 'nonce', transientFailures: 1, updatedAt: NOW },
    appliedRefinements: [
      { predecessorFingerprint: 'fp-of-an-earlier-attempt', fingerprintPrefix: 'fpofanearli', regionDigest: 'd', appliedAt: NOW },
    ],
    progressMilestones: { schemaVersion: 1, emitted: ['m1'] },
    ...overrides,
  };
}

/** The sessions.json entry, as an operator writes it. */
const SESSION = (overrides = {}) => ({
  sessionId: 'ai-cli-loop',
  repoKey: 'repo',
  repoRoot: tmpDir,
  githubRepo: 'm2dw/repo',
  artifactDir: '.artifacts',
  defaults: { implementationAgent: 'claude', reviewAgent: 'codex', researchAgent: 'gemini' },
  verification: { test: 'npm test' },
  labels: { active: 'ai:active', blocked: 'ai:blocked', readyForHuman: 'ai:ready-for-human' },
  issueRefinement: { enabled: true, agents: { refiner: 'claude', critic: 'codex' } },
  ...overrides,
});

/** The same session as the registry resolves it, for the effect builders. */
const RESOLVED_SESSION = (overrides = {}) => ({
  ...SESSION(),
  githubOwner: 'm2dw',
  githubName: 'repo',
  artifactRoot: join(tmpDir, '.artifacts'),
  workItemProvider: { provider: 'github-issues', auth: { mode: 'gh' } },
  ...overrides,
});

// ---------------------------------------------------------------------------
// Pure decisions
// ---------------------------------------------------------------------------

describe('§13 preconditions — pure', () => {
  const task = (overrides = {}) => ({
    sessionId: 'ai-cli-loop',
    issueNumber: 951,
    status: 'ready_for_human',
    phase: 'refinement',
    priority: 'normal',
    attempts: {},
    context: { assignment: { implementationAgent: 'claude' }, refinement: escalatedBlock() },
    createdAt: NOW,
    updatedAt: NOW,
    revision: 4,
    ...overrides,
  });

  test('the admissible label shape is the marker present and no executable status', () => {
    const ok = evaluateRefinementRecoveryLabels(['agent:claude', MARKER], MARKER);
    expect(ok.refusal).toBeNull();
    expect(ok.markerPresent).toBe(true);
    expect(ok.executableStatusLabels).toEqual([]);
  });

  test('an absent marker is refused and reported with the labels actually observed', () => {
    const gone = evaluateRefinementRecoveryLabels(['agent:claude'], MARKER);
    expect(gone.refusal).toBe('marker_label_absent');
    expect(gone.labels).toEqual(['agent:claude']);
  });

  // The `marker_precondition_failed` shape: the lane removed the marker and an
  // operator applied an executable status by hand. Both facts are reported.
  test('an executable status beside the marker is refused (the row-2 shape)', () => {
    const conflict = evaluateRefinementRecoveryLabels(
      ['agent:claude', MARKER, 'status:needs-implementation'],
      MARKER,
    );
    expect(conflict.refusal).toBe('executable_status_label_present');
    expect(conflict.executableStatusLabels).toEqual(['status:needs-implementation']);

    const both = evaluateRefinementRecoveryLabels(['status:needs-fix'], MARKER);
    expect(both.refusal).toBe('marker_label_absent');
    expect(both.executableStatusLabels).toEqual(['status:needs-fix']);
  });

  // §13 recovery re-uses the assignment pinned at admission (§14), so an Issue
  // whose agent label was removed after admission is still recoverable — unlike
  // row 1, which needs the owner to resolve one.
  test('a missing agent label does not block recovery', () => {
    expect(evaluateRefinementRecoveryLabels([MARKER], MARKER).refusal).toBeNull();
  });

  test('a session-renamed marker is honoured', () => {
    expect(evaluateRefinementRecoveryLabels(['needs:refining'], 'needs:refining').refusal).toBeNull();
    expect(evaluateRefinementRecoveryLabels([MARKER], 'needs:refining').refusal).toBe('marker_label_absent');
  });

  test('every task-side precondition answers with its own literal', () => {
    expect(evaluateRefinementRecoveryTarget(undefined, NOW)).toMatchObject({ refusal: 'task_not_found' });
    expect(evaluateRefinementRecoveryTarget(task({ status: 'queued' }), NOW)).toMatchObject({
      refusal: 'status_not_ready_for_human',
    });
    expect(evaluateRefinementRecoveryTarget(task({ phase: 'implementation' }), NOW)).toMatchObject({
      refusal: 'phase_not_refinement',
    });
    expect(evaluateRefinementRecoveryTarget(task({ context: {} }), NOW)).toMatchObject({
      refusal: 'no_refinement_block',
    });
    expect(
      evaluateRefinementRecoveryTarget(
        task({ context: { refinement: escalatedBlock({ state: 'pending' }) } }),
        NOW,
      ),
    ).toMatchObject({ refusal: 'state_not_escalated_human', state: 'pending' });
    expect(evaluateRefinementRecoveryTarget(task(), NOW)).toMatchObject({ ok: true });
  });

  test('a live claim is refused; an expired or leaseless owner is not a claim', () => {
    const claimed = task({ ownerRunId: 'run-live', leaseExpiresAt: LATER });
    expect(evaluateRefinementRecoveryTarget(claimed, NOW)).toMatchObject({ refusal: 'task_claimed' });

    const expired = task({ ownerRunId: 'run-dead', leaseExpiresAt: NOW });
    expect(evaluateRefinementRecoveryTarget(expired, LATER)).toMatchObject({ ok: true });

    // An owner with no lease at all is a leftover, not a live run — refusing it
    // would leave the row recoverable only by editing SQLite by hand, which is
    // the dead end this command exists to remove.
    expect(evaluateRefinementRecoveryTarget(task({ ownerRunId: 'run-leftover' }), NOW))
      .toMatchObject({ ok: true });
  });
});

describe('row 36 — the reset', () => {
  test('clears the attempt and keeps what §13 names as preserved', () => {
    const plan = planRefinementRecovery({ block: escalatedBlock(), now: LATER });

    expect(plan.block.state).toBe('pending');
    expect(plan.block.handoffReason).toBeNull();
    expect(plan.block.predecessorFingerprint).toBeNull();
    expect(plan.block.appliedRegionDigest).toBeNull();
    expect(plan.block.predecessors).toEqual([]);
    expect(plan.block.counters).toEqual({
      rounds: 0,
      malformedAttempts: { refiner: 0, critic: 0 },
      agentFailures: { refiner: 0, critic: 0 },
      staleRestarts: 0,
    });
    expect(plan.block.updatedAt).toBe(LATER);

    // No resumable position of any kind survives: §13 forbids a command that
    // re-runs only the critic or applies a draft the critic rejected.
    expect(plan.block.accepted).toBeUndefined();
    expect(plan.block.pendingRetry).toBeUndefined();
    expect(plan.block.execution).toBeUndefined();
    expect(plan.block.apply).toBeUndefined();

    // §10's trust record and the admission record survive.
    expect(plan.block.appliedRefinements).toHaveLength(1);
    expect(plan.block.activationPlan).toEqual(escalatedBlock().activationPlan);
    expect(plan.block.roles).toEqual(escalatedBlock().roles);
    expect(plan.block.limits).toEqual(escalatedBlock().limits);
    expect(plan.block.markerLabel).toBe(MARKER);
    expect(plan.block.sourceFingerprint).toBe(escalatedBlock().sourceFingerprint);
    expect(plan.block.admittedAt).toBe(NOW);
    expect(plan.block.progressMilestones).toEqual({ schemaVersion: 1, emitted: ['m1'] });

    expect(plan.previousHandoffReason).toBe('critique_blocked');
  });

  test('the recovery ordinal survives the reset that clears every other counter', () => {
    const first = planRefinementRecovery({ block: escalatedBlock(), now: LATER });
    expect(first.recoveries).toBe(1);
    expect(refinementRecoveryCount(first.block)).toBe(1);

    const second = planRefinementRecovery({
      block: { ...first.block, state: 'escalated_human', handoffReason: 'stale_inputs' },
      now: LATER,
    });
    expect(second.recoveries).toBe(2);
    expect(second.block.counters.rounds).toBe(0);
  });

  test('a block written before this slice reads as never recovered', () => {
    expect(refinementRecoveryCount(escalatedBlock())).toBe(0);
    expect(refinementRecoveryCount(undefined)).toBe(0);
    expect(refinementRecoveryCount({ recoveries: 'two' })).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// §16 addressing: the retried attempt's handoff is its own
// ---------------------------------------------------------------------------

describe('handoff keys after a recovery', () => {
  test('a never-recovered row mints exactly the key it always did, and round-trips', () => {
    const key = refinementHandoffIdempotencyKey({
      sessionId: 'ai-cli-loop',
      issueNumber: 951,
      reason: 'critique_blocked',
      effect: 'comment',
    });
    expect(key).toBe('ai-cli-loop:951:refinement-handoff:critique_blocked:comment');
    expect(refinementHandoffEffectFromKey(key)).toEqual({
      sessionId: 'ai-cli-loop',
      issueNumber: 951,
      reason: 'critique_blocked',
      effect: 'comment',
      recoveries: 0,
    });
    // Explicit zero is the same key: absence and zero are one state.
    expect(refinementHandoffIdempotencyKey({
      sessionId: 'ai-cli-loop', issueNumber: 951, reason: 'critique_blocked', effect: 'comment', recoveries: 0,
    })).toBe(key);
  });

  test('a recovered row keys distinctly, and the discriminator survives parsing', () => {
    const key = refinementHandoffIdempotencyKey({
      sessionId: 'ai-cli-loop',
      issueNumber: 951,
      reason: 'critique_blocked',
      effect: 'comment',
      recoveries: 2,
    });
    expect(key).toBe('ai-cli-loop:951:refinement-handoff:recovery-2:critique_blocked:comment');
    expect(refinementHandoffEffectFromKey(key)).toEqual({
      sessionId: 'ai-cli-loop',
      issueNumber: 951,
      reason: 'critique_blocked',
      effect: 'comment',
      recoveries: 2,
    });
  });

  // A session id may contain the separator, so the parse is right-anchored.
  test('a colon-bearing session id still parses on both key shapes', () => {
    for (const recoveries of [0, 3]) {
      const key = refinementHandoffIdempotencyKey({
        sessionId: 'team:ai:loop', issueNumber: 7, reason: 'stale_inputs', effect: 'label', recoveries,
      });
      expect(refinementHandoffEffectFromKey(key)).toEqual({
        sessionId: 'team:ai:loop', issueNumber: 7, reason: 'stale_inputs', effect: 'label', recoveries,
      });
    }
  });

  test('the second attempt publishes its own comment instead of deduping against the first', async () => {
    const dbPath = join(tmpDir, 'handoffs.db');
    const outbox = new SqliteOutboxStore(dbPath);
    try {
      const block = escalatedBlock({ handoffReason: 'agent_unavailable' });
      await enqueueRefinementHandoffEffects(outbox, RESOLVED_SESSION(), { issueNumber: 951 }, { refinement: block }, NOW);
      // The same handoff reason, on the attempt started by the first recovery.
      await enqueueRefinementHandoffEffects(
        outbox,
        RESOLVED_SESSION(),
        { issueNumber: 951 },
        { refinement: { ...block, recoveries: 1 } },
        LATER,
      );

      const comments = (await outbox.listUnsent()).filter((r) => r.topic === 'gh:comment');
      expect(comments).toHaveLength(2);
      expect(new Set(comments.map((r) => r.idempotencyKey)).size).toBe(2);
      // …and the delivery-side marker differs too, since it is derived from the key.
      expect(new Set(comments.map((r) => r.payload.dedupeMarker)).size).toBe(2);
    } finally {
      outbox.close();
    }
  });

  // The label add and the recovery's own removal are separate effects with
  // separate keys, so the second recovery is a second row rather than a
  // duplicate the outbox swallows.
  test('a session with no ready-for-human label enqueues nothing at all', async () => {
    const dbPath = join(tmpDir, 'nolabel.db');
    const outbox = new SqliteOutboxStore(dbPath);
    try {
      const labelless = { ...RESOLVED_SESSION(), labels: { active: 'ai:active' } };
      await enqueueRefinementRecoveryEffects(outbox, labelless, { issueNumber: 951 }, 1, NOW);
      expect(await outbox.listUnsent()).toHaveLength(0);

      await enqueueRefinementRecoveryEffects(outbox, RESOLVED_SESSION(), { issueNumber: 951 }, 1, NOW);
      await enqueueRefinementRecoveryEffects(outbox, RESOLVED_SESSION(), { issueNumber: 951 }, 1, NOW);
      await enqueueRefinementRecoveryEffects(outbox, RESOLVED_SESSION(), { issueNumber: 951 }, 2, NOW);
      const rows = await outbox.listUnsent();
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.topic === 'gh:label:remove')).toBe(true);
    } finally {
      outbox.close();
    }
  });

  // Issue #980 review: the removal alone is not enough. The handoff's own label
  // ADD may still be sitting on the outbox, so recovery has to retire it by key
  // rather than trust that it was already delivered.
  test('the handoff label add is superseded by key, at the ordinal it was raised on', () => {
    const [effect, ...rest] = refinementRecoverySupersessionEffects(
      RESOLVED_SESSION(),
      { issueNumber: 951 },
      { reason: 'critique_blocked', recoveries: 0 },
      NOW,
    );
    expect(rest).toEqual([]);
    expect(effect).toEqual({
      kind: 'cancelPending',
      idempotencyKey: refinementHandoffIdempotencyKey({
        sessionId: 'ai-cli-loop',
        issueNumber: 951,
        reason: 'critique_blocked',
        effect: 'label',
        recoveries: 0,
      }),
      now: NOW,
      // …and, since cancelling cannot abort a request already on the wire, the
      // whole recovery is refused while that row is being dispatched.
      refuseWhileClaimed: true,
    });
    // The SECOND recovery retires the row the FIRST recovery's retry raised.
    expect(
      refinementRecoverySupersessionEffects(
        RESOLVED_SESSION(),
        { issueNumber: 951 },
        { reason: 'stale_inputs', recoveries: 1 },
        NOW,
      )[0].idempotencyKey,
    ).toBe('ai-cli-loop:951:refinement-handoff:recovery-1:stale_inputs:label');
  });

  test('nothing is superseded without a ready-for-human label or a recorded reason', () => {
    const labelless = { ...RESOLVED_SESSION(), labels: { active: 'ai:active' } };
    expect(
      refinementRecoverySupersessionEffects(labelless, { issueNumber: 951 }, { reason: 'stale_inputs', recoveries: 0 }, NOW),
    ).toEqual([]);
    expect(
      refinementRecoverySupersessionEffects(RESOLVED_SESSION(), { issueNumber: 951 }, { reason: null, recoveries: 0 }, NOW),
    ).toEqual([]);
  });

  // The store half of the same guarantee: a `cancelPending` effect commits with
  // the transition and takes the row out of dispatch selection for good, even
  // though the row is delayed rather than due.
  test('a cancelPending effect retires an unsent row and leaves a delivered one alone', async () => {
    const dbPath = join(tmpDir, 'supersede.db');
    const taskStore = new SqliteTaskStore(dbPath);
    const outbox = new SqliteOutboxStore(dbPath);
    try {
      await taskStore.enqueueTask({ sessionId: 'ai-cli-loop', issueNumber: 951, phase: 'refinement' });
      const key = { sessionId: 'ai-cli-loop', issueNumber: 951 };
      await enqueueRefinementHandoffEffects(
        outbox,
        RESOLVED_SESSION(),
        { issueNumber: 951 },
        { refinement: escalatedBlock() },
        NOW,
      );
      const add = (await outbox.listUnsent()).find((r) => r.topic === 'gh:label:add');
      // The state the finding is about: a failed attempt has delayed the add.
      await outbox.markFailed(add.id, 'gh: 502', NOW);
      expect((await outbox.listPending()).map((r) => r.id)).toContain(add.id);

      const before = await taskStore.getTask(key);
      const committed = await taskStore.completePhaseWithEffects(
        {
          key,
          expected: { revision: before.revision },
          patch: { status: 'queued', phase: 'refinement', now: LATER },
          event: { task: key, type: 'refinement.recovery.applied', createdAt: LATER },
        },
        refinementRecoverySupersessionEffects(
          RESOLVED_SESSION(),
          { issueNumber: 951 },
          { reason: 'critique_blocked', recoveries: 0 },
          LATER,
        ),
      );
      expect(committed.ok).toBe(true);

      // Gone from dispatch selection — no retry can re-apply the label…
      expect((await outbox.listPending()).map((r) => r.id)).not.toContain(add.id);
      const retired = (await outbox.listUnsent()).find((r) => r.id === add.id);
      expect(retired.cancelledAt).toBe(LATER);
      expect(retired.deadLetterAt).toBe(LATER);
      // …the failure history survives for `admin outbox list`…
      expect(retired.lastError).toContain('502');
      // …and the handoff comment is left to deliver: it is a record of what
      // happened, not a claim about the row's current state.
      const comment = (await outbox.listPending()).find((r) => r.topic === 'gh:comment');
      expect(comment).toBeDefined();
      expect(comment.cancelledAt).toBeUndefined();

      // A row that already dispatched is never re-marked: what it published is
      // retracted by the compensating effect, not by rewriting delivery state.
      const sent = (await outbox.listUnsent()).find((r) => r.topic === 'gh:comment');
      await outbox.markSent(sent.id, LATER);
      const after = await taskStore.getTask(key);
      await taskStore.completePhaseWithEffects(
        {
          key,
          expected: { revision: after.revision },
          patch: { status: 'queued', now: LATER },
          event: { task: key, type: 'refinement.recovery.applied', createdAt: LATER },
        },
        [{ kind: 'cancelPending', idempotencyKey: sent.idempotencyKey, now: LATER }],
      );
      const untouched = (await outbox.getById(sent.id));
      expect(untouched.sentAt).toBe(LATER);
      expect(untouched.cancelledAt).toBeUndefined();
    } finally {
      outbox.close();
      taskStore.close();
    }
  });

  // The same effect on the two stores that cannot commit it inside a
  // transaction: the in-memory double, and the portable expression the phase
  // runner falls back to when the task and outbox stores sit on different
  // backends.
  test('the retirement is honoured off the SQLite path too', async () => {
    const memory = new MemoryTaskStore();
    const key = { sessionId: 'ai-cli-loop', issueNumber: 951 };
    await memory.enqueueTask({ sessionId: 'ai-cli-loop', issueNumber: 951, phase: 'refinement' });
    const task = await memory.getTask(key);
    await memory.completePhaseWithEffects(
      {
        key,
        expected: { revision: task.revision },
        patch: { status: 'queued', now: LATER },
        event: { task: key, type: 'refinement.recovery.applied', createdAt: LATER },
      },
      [
        { kind: 'enqueue', input: { idempotencyKey: 'k1', topic: 'gh:comment', payload: { topic: 'gh:comment', owner: 'm2dw', repo: 'repo', issueNumber: 951, body: 'kept' } } },
        { kind: 'enqueue', input: { idempotencyKey: 'k2', topic: 'gh:label:add', payload: { topic: 'gh:label:add', owner: 'm2dw', repo: 'repo', issueNumber: 951, label: 'ai:ready-for-human' } } },
        { kind: 'cancelPending', idempotencyKey: 'k2', now: LATER },
      ],
    );
    expect(memory.listOutboxEffects().map((e) => e.idempotencyKey)).toEqual(['k1']);

    const dbPath = join(tmpDir, 'portable.db');
    const outbox = new SqliteOutboxStore(dbPath);
    try {
      await outbox.enqueue({
        idempotencyKey: 'k2',
        topic: 'gh:label:add',
        payload: { topic: 'gh:label:add', owner: 'm2dw', repo: 'repo', issueNumber: 951, label: 'ai:ready-for-human' },
        now: NOW,
      });
      expect(await cancelPendingOutboxEntriesByKey(outbox, 'k2', LATER)).toBe(1);
      expect(await outbox.listPending()).toHaveLength(0);
      // Idempotent: an already-cancelled row is not cancelled twice.
      expect(await cancelPendingOutboxEntriesByKey(outbox, 'k2', LATER)).toBe(0);
      expect(await cancelPendingOutboxEntriesByKey(outbox, 'no-such-key', LATER)).toBe(0);
    } finally {
      outbox.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Issue #980 review: which label the removal names, and which rows a handoff
// raised after a recovery has to retire.
// ---------------------------------------------------------------------------

describe('the ready-for-human label a handoff applied', () => {
  const escalatedContext = (overrides = {}) => ({
    title: 'Downstream Issue',
    refinement: escalatedBlock(overrides),
  });

  test('a completion that publishes a handoff records the label it adds', () => {
    const context = escalatedContext();
    const recorded = withRecordedRefinementHandoffLabel(951, context, 'ai:ready-for-human');

    expect(recorded.refinement.handoffLabel).toBe('ai:ready-for-human');
    expect(recordedRefinementHandoffLabel(recorded.refinement)).toBe('ai:ready-for-human');
    // The rest of the block, and the rest of the context, are carried through
    // untouched — and the input object is never mutated.
    expect(recorded.title).toBe('Downstream Issue');
    expect(recorded.refinement.handoffReason).toBe('critique_blocked');
    expect(context.refinement.handoffLabel).toBeUndefined();
  });

  test('nothing is recorded without a publishable handoff or a configured label', () => {
    // Not escalated: no add is published, so there is no label to record.
    const pending = { refinement: escalatedBlock({ state: 'pending', handoffReason: null }) };
    expect(withRecordedRefinementHandoffLabel(951, pending, 'ai:ready-for-human')).toBe(pending);
    // Escalated with no recognised reason: the publication gate refuses it too.
    const reasonless = { refinement: escalatedBlock({ handoffReason: 'not-a-reason' }) };
    expect(withRecordedRefinementHandoffLabel(951, reasonless, 'ai:ready-for-human')).toBe(reasonless);
    // No label configured: the add itself is a no-op, so is the record.
    const context = escalatedContext();
    expect(withRecordedRefinementHandoffLabel(951, context, undefined)).toBe(context);
    // Already recorded as the same value: no pointless rewrite of the block.
    const recorded = withRecordedRefinementHandoffLabel(951, context, 'ai:ready-for-human');
    expect(withRecordedRefinementHandoffLabel(951, recorded, 'ai:ready-for-human')).toBe(recorded);
  });

  test('the record is read tolerantly and is absent on a pre-#980 block', () => {
    expect(recordedRefinementHandoffLabel(escalatedBlock())).toBeNull();
    expect(recordedRefinementHandoffLabel(undefined)).toBeNull();
    expect(recordedRefinementHandoffLabel({ handoffLabel: 42 })).toBeNull();
    expect(recordedRefinementHandoffLabel({ handoffLabel: '' })).toBeNull();
  });

  // §5.2 (issue #1003): the gate describes the snapshot that stopped, and the
  // retry captures a fresh one — an operator who fixed the declaration must not
  // see the old gaps on the requeued row.
  test('the reset clears the §5.2 evidence gate with the reason it belongs to', () => {
    const plan = planRefinementRecovery({
      block: escalatedBlock({
        handoffReason: 'evidence_required',
        evidenceGate: {
          declared: 1,
          captured: 0,
          optionalGaps: 0,
          gaps: [
            { index: 0, reason: 'missing_path', requirement: 'required', predecessorIssueNumber: 10 },
          ],
          artifact: 'evidence-preflight.json',
          recordedAt: LATER,
        },
      }),
      now: LATER,
    });
    expect(plan.previousHandoffReason).toBe('evidence_required');
    expect(plan.block.evidenceGate).toBeUndefined();
    expect(plan.block.state).toBe('pending');
    expect(plan.reset.cleared.join('\n')).toContain('refinement.evidenceGate');
  });

  // §15 (issue #1176): the critic block names the blocker of the attempt that
  // stopped; the retry is critiqued afresh.
  test('the reset clears the critic block record with the reason it belongs to', () => {
    const plan = planRefinementRecovery({
      block: escalatedBlock({
        handoffReason: 'critique_blocked',
        criticBlock: {
          round: 1,
          blockReason: 'missing_decision',
          objections: [{ field: 'acceptanceCriteria', kind: 'lost_requirement' }],
          recordedAt: LATER,
        },
      }),
      now: LATER,
    });
    expect(plan.previousHandoffReason).toBe('critique_blocked');
    expect(plan.block.criticBlock).toBeUndefined();
    expect(plan.reset.cleared.join('\n')).toContain('refinement.criticBlock');
  });

  test('the reset clears the record, and the plan reports the label it cleared', () => {
    const plan = planRefinementRecovery({
      block: escalatedBlock({ handoffLabel: 'ai:old-ready-for-human' }),
      now: LATER,
    });
    expect(plan.previousHandoffLabel).toBe('ai:old-ready-for-human');
    expect(plan.block.handoffLabel).toBeNull();
    expect(plan.reset.cleared.join('\n')).toContain('refinement.handoffLabel');
    // A block that never recorded one reports null and falls back to config.
    expect(planRefinementRecovery({ block: escalatedBlock(), now: LATER }).previousHandoffLabel).toBeNull();
  });

  // The finding: `labels.readyForHuman` is session config an operator may
  // rename, and this removal compensates for one specific add. Naming the
  // current config would take the NEW label off an Issue wearing the OLD one.
  test('the removal names the label the add used, not the one config holds now', async () => {
    const dbPath = join(tmpDir, 'renamed.db');
    const outbox = new SqliteOutboxStore(dbPath);
    try {
      const renamed = { ...RESOLVED_SESSION(), labels: { ...SESSION().labels, readyForHuman: 'ai:new-ready' } };
      await enqueueRefinementRecoveryEffects(
        outbox, renamed, { issueNumber: 951 }, 1, NOW, 'ai:old-ready',
      );
      const [row] = await outbox.listUnsent();
      expect(row.payload).toMatchObject({ topic: 'gh:label:remove', label: 'ai:old-ready' });

      // No record (a block written before this field existed): session config
      // is the value that block's own handoff read, so it is the fallback.
      await enqueueRefinementRecoveryEffects(outbox, renamed, { issueNumber: 951 }, 2, NOW, null);
      const fallback = (await outbox.listUnsent()).find((r) => r.idempotencyKey.endsWith(':2:label-remove'));
      expect(fallback.payload.label).toBe('ai:new-ready');
    } finally {
      outbox.close();
    }
  });
});

describe('a handoff raised after a recovery', () => {
  test('retires the recovery removal that has not been delivered yet', () => {
    const [effect, ...rest] = refinementHandoffSupersessionEffects(
      RESOLVED_SESSION(), { issueNumber: 951 }, 1, LATER,
    );
    expect(rest).toEqual([]);
    expect(effect).toEqual({
      kind: 'cancelPending',
      idempotencyKey: refinementRecoveryIdempotencyKey({
        sessionId: 'ai-cli-loop', issueNumber: 951, recoveries: 1,
      }),
      now: LATER,
    });
  });

  test('retires nothing when the row was never recovered or configures no label', () => {
    expect(refinementHandoffSupersessionEffects(RESOLVED_SESSION(), { issueNumber: 951 }, 0, LATER)).toEqual([]);
    const labelless = { ...RESOLVED_SESSION(), labels: { active: 'ai:active' } };
    expect(refinementHandoffSupersessionEffects(labelless, { issueNumber: 951 }, 1, LATER)).toEqual([]);
  });

  // The finding, end to end: recovery's removal failed once and is sitting
  // behind its backoff when the recovered attempt escalates again. Without the
  // retirement, that removal retries after the new add lands and strips the
  // label from a row that is `ready_for_human` again.
  test('the delayed removal is cancelled by the transaction that publishes the new handoff', async () => {
    const dbPath = join(tmpDir, 'reescalate.db');
    const taskStore = new SqliteTaskStore(dbPath);
    const outbox = new SqliteOutboxStore(dbPath);
    try {
      const key = { sessionId: 'ai-cli-loop', issueNumber: 951 };
      await taskStore.enqueueTask({ sessionId: 'ai-cli-loop', issueNumber: 951, phase: 'refinement' });
      // The first recovery's removal, delayed by a transient dispatch failure.
      await enqueueRefinementRecoveryEffects(outbox, RESOLVED_SESSION(), { issueNumber: 951 }, 1, NOW);
      const [removal] = await outbox.listUnsent();
      await outbox.markFailed(removal.id, 'gh: 502 Bad Gateway', NOW);
      expect((await outbox.listPending()).map((r) => r.id)).toContain(removal.id);

      // The recovered attempt escalates again.
      const supersessions = await enqueueRefinementHandoffEffects(
        outbox,
        RESOLVED_SESSION(),
        { issueNumber: 951 },
        { refinement: escalatedBlock({ recoveries: 1, handoffReason: 'stale_inputs' }) },
        LATER,
      );
      expect(supersessions).toEqual([
        { kind: 'cancelPending', idempotencyKey: removal.idempotencyKey, now: LATER },
      ]);

      const task = await taskStore.getTask(key);
      const committed = await taskStore.completePhaseWithEffects(
        {
          key,
          expected: { revision: task.revision },
          patch: { status: 'ready_for_human', phase: 'refinement', now: LATER },
          event: { task: key, type: 'refinement.escalated.human', createdAt: LATER },
        },
        supersessions,
      );
      expect(committed.ok).toBe(true);

      const pending = await outbox.listPending();
      expect(pending.map((r) => r.id)).not.toContain(removal.id);
      // The new handoff's own add is the only label row left to dispatch.
      expect(pending.filter((r) => r.topic === 'gh:label:remove')).toHaveLength(0);
      expect(pending.filter((r) => r.topic === 'gh:label:add')).toHaveLength(1);
      expect((await outbox.getById(removal.id)).cancelledAt).toBe(LATER);
    } finally {
      outbox.close();
      taskStore.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Issue #980 review: retiring the add stops its RETRY, but cannot abort a
// request already on the wire. A recovery that commits while the add is being
// dispatched can have that add land after its own removal — `markSent` still
// records the delivery, no further removal is scheduled, and the Issue keeps a
// ready-for-human label on a task that is queued again.
// ---------------------------------------------------------------------------

describe('a handoff label add that is being dispatched right now', () => {
  const KEY = { sessionId: 'ai-cli-loop', issueNumber: 951 };

  /** The row-36 effect set the CLI commits: the retirement, then the removal. */
  async function recoveryEffects(now) {
    const collector = new OutboxEffectCollector();
    await enqueueRefinementRecoveryEffects(
      collector, RESOLVED_SESSION(), { issueNumber: 951 }, 1, now, 'ai:ready-for-human',
    );
    return [
      ...refinementRecoverySupersessionEffects(
        RESOLVED_SESSION(),
        { issueNumber: 951 },
        { reason: 'critique_blocked', recoveries: 0, appliedLabel: 'ai:ready-for-human' },
        now,
      ),
      ...collector.effects,
    ];
  }

  /** A store pair on one file, with the handoff's two rows already enqueued. */
  async function withHandoffRows(name, body) {
    const dbPath = join(tmpDir, name);
    const taskStore = new SqliteTaskStore(dbPath);
    const outbox = new SqliteOutboxStore(dbPath);
    try {
      await taskStore.enqueueTask({
        sessionId: 'ai-cli-loop',
        issueNumber: 951,
        phase: 'refinement',
        context: { refinement: escalatedBlock() },
      });
      await taskStore.transitionTask(KEY, {}, { status: 'ready_for_human', now: NOW });
      await enqueueRefinementHandoffEffects(
        outbox, RESOLVED_SESSION(), { issueNumber: 951 }, { refinement: escalatedBlock() }, NOW,
      );
      const add = (await outbox.listUnsent()).find((r) => r.topic === 'gh:label:add');
      await body({ taskStore, outbox, add });
    } finally {
      outbox.close();
      taskStore.close();
    }
  }

  test('only the operator command asks to be refused; a phase completion never does', () => {
    const [recovery] = refinementRecoverySupersessionEffects(
      RESOLVED_SESSION(), { issueNumber: 951 }, { reason: 'critique_blocked', recoveries: 0 }, LATER,
    );
    expect(recovery.refuseWhileClaimed).toBe(true);
    // The mirror image is committed by a phase completion, which cannot be
    // rolled back over a dispatch it merely raced.
    const [handoff] = refinementHandoffSupersessionEffects(
      RESOLVED_SESSION(), { issueNumber: 951 }, 1, LATER,
    );
    expect(handoff.refuseWhileClaimed).toBeUndefined();
  });

  test('the whole transaction is refused — no reset, no event, no removal, no cancellation', async () => {
    await withHandoffRows('in-flight.db', async ({ taskStore, outbox, add }) => {
      // A dispatcher owns the row and its GitHub call is in flight.
      expect(await outbox.claimForDispatch(add.id, LATER)).toBe(true);

      const before = await taskStore.getTask(KEY);
      const committed = await taskStore.completePhaseWithEffects(
        {
          key: KEY,
          expected: { revision: before.revision },
          patch: { status: 'queued', phase: 'refinement', now: LATER },
          event: { task: KEY, type: 'refinement.recovery.applied', createdAt: LATER },
        },
        await recoveryEffects(LATER),
      );

      expect(committed).toEqual({ ok: false, code: 'effect_in_flight' });
      // Nothing was written: not the transition, not the event, not the
      // removal — and the claimed row is untouched, so the attempt in flight
      // still owns it and can report its own outcome.
      const after = await taskStore.getTask(KEY);
      expect(after.status).toBe('ready_for_human');
      expect(after.revision).toBe(before.revision);
      expect(await taskStore.listEvents(KEY)).toHaveLength(0);
      expect((await outbox.listUnsent()).filter((r) => r.topic === 'gh:label:remove')).toHaveLength(0);
      const claimed = await outbox.getById(add.id);
      expect(claimed.cancelledAt).toBeUndefined();
      expect(claimed.claimedAt).toBe(LATER);

      // Once that attempt resolves it releases the claim, and the identical
      // command succeeds: this is retryable contention, not a wrong row.
      await outbox.markFailed(add.id, 'gh: 502 Bad Gateway', LATER);
      const retried = await taskStore.completePhaseWithEffects(
        {
          key: KEY,
          expected: { revision: before.revision },
          patch: { status: 'queued', phase: 'refinement', now: LATER },
          event: { task: KEY, type: 'refinement.recovery.applied', createdAt: LATER },
        },
        await recoveryEffects(LATER),
      );
      expect(retried.ok).toBe(true);
      expect((await outbox.getById(add.id)).cancelledAt).toBe(LATER);
      expect((await outbox.listPending()).filter((r) => r.topic === 'gh:label:remove')).toHaveLength(1);
    });
  });

  test('a stale claim is an abandoned attempt and does not refuse', async () => {
    await withHandoffRows('stale-claim.db', async ({ taskStore, outbox, add }) => {
      // Claimed an hour ago and never released: a crashed dispatcher, which
      // `claimForDispatch` itself would happily steal. Refusing on this shape
      // would make the row permanently unrecoverable.
      expect(await outbox.claimForDispatch(add.id, NOW)).toBe(true);

      const before = await taskStore.getTask(KEY);
      const committed = await taskStore.completePhaseWithEffects(
        {
          key: KEY,
          expected: { revision: before.revision },
          patch: { status: 'queued', phase: 'refinement', now: LATER },
          event: { task: KEY, type: 'refinement.recovery.applied', createdAt: LATER },
        },
        await recoveryEffects(LATER),
      );

      expect(committed.ok).toBe(true);
      expect((await taskStore.getTask(KEY)).status).toBe('queued');
      expect((await outbox.getById(add.id)).cancelledAt).toBe(LATER);
    });
  });

  test('a delivered add refuses nothing — it is retracted by the removal', async () => {
    await withHandoffRows('delivered.db', async ({ taskStore, outbox, add }) => {
      const claimedAt = LATER;
      expect(await outbox.claimForDispatch(add.id, claimedAt)).toBe(true);
      await outbox.markSent(add.id, claimedAt, claimedAt);

      const before = await taskStore.getTask(KEY);
      const committed = await taskStore.completePhaseWithEffects(
        {
          key: KEY,
          expected: { revision: before.revision },
          patch: { status: 'queued', phase: 'refinement', now: LATER },
          event: { task: KEY, type: 'refinement.recovery.applied', createdAt: LATER },
        },
        await recoveryEffects(LATER),
      );

      expect(committed.ok).toBe(true);
      const sent = await outbox.getById(add.id);
      expect(sent.sentAt).toBe(LATER);
      expect(sent.cancelledAt).toBeUndefined();
      expect((await outbox.listPending()).filter((r) => r.topic === 'gh:label:remove')).toHaveLength(1);
    });
  });
});

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

describe('admin refinement recover — CLI', () => {
  let sessionsPath;
  let dbPath;
  let store;
  let exitSpy;

  const KEY = { sessionId: 'ai-cli-loop', issueNumber: 951 };

  beforeEach(async () => {
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((c) => {
      throw new Error(`exit(${c})`);
    });
    sessionsPath = join(tmpDir, 'sessions.json');
    dbPath = join(tmpDir, 'tasks.db');
    writeFileSync(sessionsPath, JSON.stringify({ sessions: [SESSION()] }), 'utf8');
    store = new SqliteTaskStore(dbPath);
    await store.enqueueTask({
      sessionId: 'ai-cli-loop',
      issueNumber: 951,
      phase: 'refinement',
      context: {
        title: 'Downstream Issue',
        assignment: { implementationAgent: 'claude', source: 'label' },
        refinement: escalatedBlock(),
      },
    });
    await store.transitionTask(KEY, {}, {
      status: 'ready_for_human',
      notBefore: '2026-09-01T00:00:00.000Z',
      ownerRunId: 'run-that-failed',
      leaseExpiresAt: NOW,
      lastError: 'critic blocked the draft',
    });
  });

  afterEach(() => {
    store.close();
    exitSpy.mockRestore();
  });

  const ARGS = (overrides = {}) => ({
    sessionId: 'ai-cli-loop',
    issueNumber: 951,
    sessionsPath,
    dbPath,
    lockDir: join(tmpDir, 'locks'),
    apply: false,
    ...overrides,
  });

  const deps = (overrides = {}) => ({
    store,
    readIssueLabels: async () => ['agent:claude', MARKER],
    issueLock: new IssueWorktreeLock(join(tmpDir, 'locks')),
    now: () => Date.parse(LATER),
    runId: 'run-recover',
    ...overrides,
  });

  /** Run the command, capturing stdout and whether `die` fired. */
  async function run(args, d) {
    const chunks = [];
    const original = process.stdout.write;
    process.stdout.write = (chunk) => {
      chunks.push(String(chunk));
      return true;
    };
    let threw = false;
    try {
      await runRefinementRecover(args, d);
    } catch (err) {
      if (!/^exit\(/.test(err.message)) throw err;
      threw = true;
    } finally {
      process.stdout.write = original;
    }
    return { threw, output: JSON.parse(chunks.join('')) };
  }

  async function unsent() {
    const outbox = new SqliteOutboxStore(dbPath);
    try {
      return await outbox.listUnsent();
    } finally {
      outbox.close();
    }
  }

  test('--session-ref resolves through the shared admin selector and --yes is opt-in', () => {
    writeFileSync(
      sessionsPath,
      JSON.stringify({ sessions: [{ ...SESSION(), sessionNo: 1, aliases: ['loop'] }] }),
      'utf8',
    );
    const parsed = parseRefinementRecoverArgs([
      '--session-ref', 'loop', '--issue-number', '951', '--sessions-path', sessionsPath,
    ]);
    expect(parsed).toMatchObject({ sessionId: 'ai-cli-loop', issueNumber: 951, apply: false });

    const applied = parseRefinementRecoverArgs([
      '--session-id', 'ai-cli-loop', '--issue-number', '951', '--yes',
    ]);
    expect(applied).toMatchObject({ apply: true });

    expect(parseRefinementRecoverArgs(['--issue-number', '951'])).toHaveProperty('error');
    expect(parseRefinementRecoverArgs(['--session-id', 'ai-cli-loop'])).toHaveProperty('error');
    expect(parseRefinementRecoverArgs(['--session-id', 'x', '--issue-number', '0'])).toHaveProperty('error');
    // Exactly one Issue: a repeated flag would otherwise silently keep the last.
    expect(
      parseRefinementRecoverArgs(['--session-id', 'x', '--issue-number', '950', '--issue-number', '951']),
    ).toHaveProperty('error');
    expect(
      parseRefinementRecoverArgs(['--session-id', 'x', '--session-ref', 'y', '--issue-number', '1']),
    ).toHaveProperty('error');
  });

  test('preview reports the task, the handoff reason, the labels, and the reset — and mutates nothing', async () => {
    const before = await store.getTask(KEY);
    const { threw, output } = await run(ARGS(), deps());

    expect(threw).toBe(false);
    expect(output).toMatchObject({
      ok: true,
      command: 'refinement-recover',
      applied: false,
      refusal: null,
      sessionId: 'ai-cli-loop',
      issueNumber: 951,
      previousHandoffReason: 'critique_blocked',
      recoveries: 1,
      readyForHumanLabel: 'ai:ready-for-human',
    });
    expect(output.labels).toMatchObject({ markerPresent: true, executableStatusLabels: [], refusal: null });
    expect(output.reset.cleared.join('\n')).toContain('refinement.handoffReason');
    expect(output.reset.preserved.join('\n')).toContain('refinement.appliedRefinements');

    const task = await store.getTask(KEY);
    expect(task.status).toBe('ready_for_human');
    expect(task.revision).toBe(before.revision);
    expect(task.updatedAt).toBe(before.updatedAt);
    expect(task.context.refinement.state).toBe('escalated_human');
    expect(await unsent()).toHaveLength(0);
    expect(await store.listEvents(KEY)).toHaveLength(0);
  });

  test('--yes performs row 36 in one transaction and requeues the row', async () => {
    const { threw, output } = await run(ARGS({ apply: true }), deps());

    expect(threw).toBe(false);
    expect(output).toMatchObject({
      applied: true,
      refusal: null,
      taskStatus: 'queued',
      taskPhase: 'refinement',
      refinementState: 'pending',
      event: 'refinement.recovery.applied',
      recoveries: 1,
    });

    const task = await store.getTask(KEY);
    expect(task.status).toBe('queued');
    expect(task.phase).toBe('refinement');
    // §13: the task delay, lease, owner, and last error are cleared, so the row
    // is immediately claimable rather than held behind the handoff's leftovers.
    expect(task.notBefore).toBeUndefined();
    expect(task.ownerRunId).toBeUndefined();
    expect(task.leaseExpiresAt).toBeUndefined();
    expect(task.lastError).toBeUndefined();

    const block = task.context.refinement;
    expect(block.state).toBe('pending');
    expect(block.handoffReason).toBeNull();
    expect(block.predecessorFingerprint).toBeNull();
    expect(block.counters.rounds).toBe(0);
    expect(block.accepted).toBeUndefined();
    expect(block.pendingRetry).toBeUndefined();
    expect(block.recoveries).toBe(1);
    // Preserved: §10's trust record, and the assignment §14 pins.
    expect(block.appliedRefinements).toHaveLength(1);
    expect(task.context.assignment).toEqual({ implementationAgent: 'claude', source: 'label' });
    expect(task.context.title).toBe('Downstream Issue');

    const events = await store.listEvents(KEY);
    expect(events.map((e) => e.type)).toEqual(['refinement.recovery.applied']);
    expect(events[0].data).toMatchObject({
      issueNumber: 951,
      previousState: 'escalated_human',
      previousHandoffReason: 'critique_blocked',
      refinementState: 'pending',
      recoveries: 1,
    });
  });

  test('the ready-for-human label removal rides the outbox on a run-independent key', async () => {
    await run(ARGS({ apply: true }), deps());

    const rows = await unsent();
    expect(rows).toHaveLength(1);
    expect(rows[0].topic).toBe('gh:label:remove');
    expect(rows[0].payload).toMatchObject({
      owner: 'm2dw',
      repo: 'repo',
      issueNumber: 951,
      label: 'ai:ready-for-human',
    });
    expect(rows[0].idempotencyKey).toBe(
      refinementRecoveryIdempotencyKey({ sessionId: 'ai-cli-loop', issueNumber: 951, recoveries: 1 }),
    );
    // §13 never touches the marker and never adds an executable status.
    expect(rows.some((r) => r.topic === 'gh:label:add')).toBe(false);
    expect(rows.some((r) => r.topic === 'gh:comment')).toBe(false);
  });

  // Issue #980 review: the session's ready-for-human label was renamed after the
  // handoff added the old one. The removal compensates for that add, so it names
  // the recorded label — removing the newly configured one would leave the label
  // the Issue is actually wearing in place.
  test('the removal names the label the handoff recorded, not a renamed one', async () => {
    const seeded = await store.getTask(KEY);
    await store.transitionTask(KEY, { revision: seeded.revision }, {
      context: { refinement: { ...escalatedBlock(), handoffLabel: 'ai:old-ready-for-human' } },
    });

    const preview = (await run(ARGS(), deps())).output;
    expect(preview.readyForHumanLabel).toBe('ai:old-ready-for-human');
    expect(preview.reset.cleared.join('\n')).toContain('refinement.handoffLabel');

    const { threw } = await run(ARGS({ apply: true }), deps());
    expect(threw).toBe(false);

    const rows = await unsent();
    expect(rows).toHaveLength(1);
    expect(rows[0].payload).toMatchObject({ topic: 'gh:label:remove', label: 'ai:old-ready-for-human' });
    // Cleared with the reason it belongs to, so a later recovery does not
    // compensate for an add that is no longer outstanding.
    expect((await store.getTask(KEY)).context.refinement.handoffLabel).toBeNull();
  });

  // Issue #980 review: the handoff's label ADD had failed once and was sitting
  // delayed behind its backoff. Compensating alone would let the removal
  // dispatch first and the retry re-mark a requeued task as needing a human, so
  // the add is retired by the transaction that performs the reset.
  test('a delayed handoff label add is retired by the same transaction that requeues the row', async () => {
    const seed = new SqliteOutboxStore(dbPath);
    let add;
    try {
      await enqueueRefinementHandoffEffects(
        seed,
        RESOLVED_SESSION(),
        { issueNumber: 951 },
        { refinement: escalatedBlock() },
        NOW,
      );
      add = (await seed.listUnsent()).find((r) => r.topic === 'gh:label:add');
      await seed.markFailed(add.id, 'gh: 502 Bad Gateway', NOW);
      // Still dispatch-eligible at this point — just not yet due.
      expect((await seed.listPending()).map((r) => r.id)).toContain(add.id);
    } finally {
      seed.close();
    }

    const previewOutput = (await run(ARGS(), deps())).output;
    expect(previewOutput.supersededHandoffKeys).toEqual([add.idempotencyKey]);
    // A preview retires nothing.
    const stillPending = new SqliteOutboxStore(dbPath);
    try {
      expect((await stillPending.listPending()).map((r) => r.id)).toContain(add.id);
    } finally {
      stillPending.close();
    }

    const { threw, output } = await run(ARGS({ apply: true }), deps());
    expect(threw).toBe(false);
    expect(output.supersededHandoffKeys).toEqual([add.idempotencyKey]);

    const after = new SqliteOutboxStore(dbPath);
    try {
      const pending = await after.listPending();
      // The add can never dispatch again; the removal is the only label row a
      // dispatcher will act on from here.
      expect(pending.map((r) => r.id)).not.toContain(add.id);
      expect(pending.filter((r) => r.topic === 'gh:label:add')).toHaveLength(0);
      expect(pending.filter((r) => r.topic === 'gh:label:remove')).toHaveLength(1);
      // The handoff comment is a record of what happened and still delivers.
      expect(pending.filter((r) => r.topic === 'gh:comment')).toHaveLength(1);

      const retired = await after.getById(add.id);
      expect(retired.cancelledAt).toBe(LATER);
      expect(retired.lastError).toContain('502');
    } finally {
      after.close();
    }

    expect((await store.getTask(KEY)).status).toBe('queued');
  });

  test('the issue lock is taken for both preview and apply, and released on the way out', async () => {
    const lock = new IssueWorktreeLock(join(tmpDir, 'locks'));
    await run(ARGS(), deps());
    expect(lock.inspect('ai-cli-loop', 951).locked).toBe(false);
    await run(ARGS({ apply: true }), deps());
    expect(lock.inspect('ai-cli-loop', 951).locked).toBe(false);
  });

  // The race §13 cares about: a phase-runner tick already owns this Issue.
  test('a held issue lock refuses the command without reading GitHub or mutating', async () => {
    const other = new IssueWorktreeLock(join(tmpDir, 'locks'));
    expect(other.acquire('run-tick', 'ai-cli-loop', 951).locked).toBe(true);

    let reads = 0;
    const { threw, output } = await run(
      ARGS({ apply: true }),
      deps({ readIssueLabels: async () => { reads++; return [MARKER]; } }),
    );
    expect(threw).toBe(true);
    expect(output.ok).toBe(false);
    expect(output.error).toMatch(/already running/);
    expect(reads).toBe(0);
    expect((await store.getTask(KEY)).status).toBe('ready_for_human');
  });

  // The other race: the row moved between the read and the commit, so the CAS
  // refuses and NOTHING — reset, event, or effect — is persisted.
  test('a task row that moved under the command loses the CAS and persists nothing', async () => {
    const racing = {
      getTask: (key) => store.getTask(key),
      listEvents: (key) => store.listEvents(key),
      completePhaseWithEffects: async (transition, effects) => {
        // Simulate the concurrent tick by bumping the row first.
        await store.transitionTask(KEY, {}, { lastError: 'moved by a tick' });
        return store.completePhaseWithEffects(transition, effects);
      },
    };
    const { threw, output } = await run(ARGS({ apply: true }), deps({ store: racing }));

    expect(threw).toBe(true);
    expect(output.error).toMatch(/refused by the store \(conflict\)/);
    const task = await store.getTask(KEY);
    expect(task.status).toBe('ready_for_human');
    expect(task.context.refinement.state).toBe('escalated_human');
    expect(await unsent()).toHaveLength(0);
    expect(await store.listEvents(KEY)).toHaveLength(0);
  });

  // The third race (issue #980 review): the handoff's label add is on the wire
  // at the moment the operator applies. Cancelling that row would not stop the
  // request, and it could land after this command's removal dispatched.
  test('an add being dispatched right now defers the recovery instead of racing it', async () => {
    const outbox = new SqliteOutboxStore(dbPath);
    let add;
    try {
      await enqueueRefinementHandoffEffects(
        outbox, RESOLVED_SESSION(), { issueNumber: 951 }, { refinement: escalatedBlock() }, NOW,
      );
      add = (await outbox.listUnsent()).find((r) => r.topic === 'gh:label:add');
      expect(await outbox.claimForDispatch(add.id, LATER)).toBe(true);
    } finally {
      outbox.close();
    }

    const { threw, output } = await run(ARGS({ apply: true }), deps());
    expect(threw).toBe(true);
    expect(output.error).toMatch(/being dispatched right now/);
    expect(output.error).toMatch(/re-run in a few seconds/);

    // Nothing moved, and no removal was enqueued beside the handoff's own rows.
    const task = await store.getTask(KEY);
    expect(task.status).toBe('ready_for_human');
    expect(task.context.refinement.state).toBe('escalated_human');
    expect(await store.listEvents(KEY)).toHaveLength(0);
    expect((await unsent()).filter((r) => r.topic === 'gh:label:remove')).toHaveLength(0);
    expect((await unsent()).find((r) => r.id === add.id).cancelledAt).toBeUndefined();

    // A PREVIEW is unaffected: it writes nothing, so it has nothing to race.
    const preview = await run(ARGS(), deps());
    expect(preview.threw).toBe(false);
    expect(preview.output).toMatchObject({ applied: false, refusal: null });
  });

  test('re-running after a successful recovery is a refusal that leaves the fresh attempt alone', async () => {
    await run(ARGS({ apply: true }), deps());
    const after = await store.getTask(KEY);

    const { threw, output } = await run(ARGS({ apply: true }), deps());
    expect(threw).toBe(true);
    expect(output.error).toMatch(/'pending', not 'escalated_human'/);
    expect(output.error).toMatch(/already recovered/);

    const unchanged = await store.getTask(KEY);
    expect(unchanged.revision).toBe(after.revision);
    expect(unchanged.context.refinement.recoveries).toBe(1);
    expect(await unsent()).toHaveLength(1);
  });

  test('an unknown session and an unknown Issue are both refused with no mutation', async () => {
    const noSession = await run(ARGS({ sessionId: 'not-a-session' }), deps());
    expect(noSession.threw).toBe(true);
    expect(noSession.output.ok).toBe(false);

    const noIssue = await run(ARGS({ issueNumber: 4242, apply: true }), deps());
    expect(noIssue.threw).toBe(true);
    expect(noIssue.output.error).toMatch(/No task found for issue #4242/);

    expect((await store.getTask(KEY)).status).toBe('ready_for_human');
    expect(await unsent()).toHaveLength(0);
  });

  test.each([
    ['critique_blocked'],
    ['stale_inputs'],
    ['agent_unavailable'],
  ])('recovers a %s handoff from the same terminal shape', async (reason) => {
    await store.transitionTask(KEY, {}, {
      context: { refinement: escalatedBlock({ handoffReason: reason }) },
    });

    const preview = await run(ARGS(), deps());
    expect(preview.output.previousHandoffReason).toBe(reason);
    expect(preview.output.applied).toBe(false);

    const applied = await run(ARGS({ apply: true }), deps());
    expect(applied.threw).toBe(false);
    expect(applied.output.previousHandoffReason).toBe(reason);
    const task = await store.getTask(KEY);
    expect(task.status).toBe('queued');
    expect(task.context.refinement.state).toBe('pending');
  });

  // §13's label precondition, in the two shapes an operator actually hits after
  // a `marker_precondition_failed` handoff.
  test('a missing marker is previewed with the missing step and refused on apply', async () => {
    const labels = deps({ readIssueLabels: async () => ['agent:claude'] });

    const preview = await run(ARGS(), labels);
    expect(preview.threw).toBe(false);
    expect(preview.output.refusal).toBe('marker_label_absent');
    expect(preview.output.labels.labels).toEqual(['agent:claude']);
    expect(preview.output.applied).toBe(false);

    const applied = await run(ARGS({ apply: true }), labels);
    expect(applied.threw).toBe(true);
    expect(applied.output.error).toContain(MARKER);

    expect((await store.getTask(KEY)).context.refinement.state).toBe('escalated_human');
    expect(await unsent()).toHaveLength(0);
  });

  test('an executable status beside the marker is refused on apply, naming the labels to remove', async () => {
    const labels = deps({
      readIssueLabels: async () => ['agent:claude', MARKER, 'status:needs-implementation'],
    });

    const preview = await run(ARGS(), labels);
    expect(preview.output.refusal).toBe('executable_status_label_present');

    const applied = await run(ARGS({ apply: true }), labels);
    expect(applied.threw).toBe(true);
    expect(applied.output.error).toContain('status:needs-implementation');

    expect((await store.getTask(KEY)).context.refinement.state).toBe('escalated_human');
    expect(await unsent()).toHaveLength(0);
  });

  // An unreadable label set is not an empty one: §13's precondition is simply
  // unverifiable, and applying against an unknown shape is the half-performed
  // recovery the contract refuses.
  test('a failed label read refuses rather than assuming the Issue carries nothing', async () => {
    const { threw, output } = await run(
      ARGS({ apply: true }),
      deps({ readIssueLabels: async () => { throw new Error('gh: 502 Bad Gateway'); } }),
    );
    expect(threw).toBe(true);
    expect(output.error).toMatch(/Failed to read the labels/);
    expect((await store.getTask(KEY)).context.refinement.state).toBe('escalated_human');
    expect(await unsent()).toHaveLength(0);
  });

  // A non-GitHub work-item session has no gh-backed label read to build, so
  // §13's precondition is unverifiable and the command fails closed rather than
  // shelling `gh` against a repo that provider does not serve.
  test('a non-GitHub work-item provider is refused rather than read through gh', async () => {
    writeFileSync(
      sessionsPath,
      JSON.stringify({
        sessions: [SESSION({ workItemProvider: { provider: 'jira', auth: { mode: 'gh' } } })],
      }),
      'utf8',
    );
    const { threw, output } = await run(
      ARGS({ apply: true }),
      { store, issueLock: new IssueWorktreeLock(join(tmpDir, 'locks')), now: () => Date.parse(LATER) },
    );
    expect(threw).toBe(true);
    expect(output.error).toMatch(/cannot read Issue labels for work-item provider/);
    expect((await store.getTask(KEY)).context.refinement.state).toBe('escalated_human');
  });
});

// ---------------------------------------------------------------------------
// Discoverability — the gap issue #951 actually hit was that the documented
// command was not there to be found.
// ---------------------------------------------------------------------------

describe('admin refinement recover — help and dispatch', () => {
  const ADMIN_CLI = new URL('../dist/cli/admin.js', import.meta.url).pathname;

  function run(...argv) {
    try {
      return { stdout: execFileSync(process.execPath, [ADMIN_CLI, ...argv], { encoding: 'utf8' }), code: 0 };
    } catch (err) {
      return { stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? ''), code: err.status };
    }
  }

  test('the command is registered and listed in the human-readable help', () => {
    expect(COMMANDS.map((c) => c.name)).toContain('refinement recover');
    const listed = run('help');
    expect(listed.code).toBe(0);
    expect(listed.stdout).toContain('refinement recover');
  }, 30_000);

  test('"help refinement recover" documents the selector, the preview default, and --yes', () => {
    const help = run('help', 'refinement', 'recover');
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('--session-ref <ref>');
    expect(help.stdout).toContain('--issue-number <n>');
    expect(help.stdout).toContain('--yes');
    expect(help.stdout).toMatch(/Previews by default/);
    // Operator-facing: readable without --json, machine payload behind it.
    expect(help.stdout).toContain('human-readable by default');
  }, 30_000);

  test('the dispatch error names both actions instead of only run', () => {
    const bogus = run('refinement', 'nonsense');
    expect(bogus.code).not.toBe(0);
    expect(`${bogus.stdout}${bogus.stderr}`).toContain('Expected: run | recover');
  }, 30_000);
});
