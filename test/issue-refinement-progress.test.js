/**
 * Issue refinement progress milestones (issue #975,
 * docs/issue-refinement-contract.md §15) — the stable, versioned projection
 * over the fine-grained `refinement.*` audit events.
 *
 * What these tests pin, in the order the contract states it:
 *
 *  - the milestone contract itself: the eight kinds, the bounded field set,
 *    and the machine-readable `nextAction` / human-action flag;
 *  - deterministic identity — the same semantic transition hashes to the same
 *    `milestoneId` regardless of run id, clock, or which attempt happened to
 *    succeed, and different transitions do not collide;
 *  - durable idempotency — the block-resident ledger suppresses a replay, and
 *    the ledger is bounded by the §8 caps rather than growing without limit;
 *  - the noise boundary — polls, holds, malformed retries, stale restarts,
 *    duplicate intake, and the internal application events cross none of the
 *    eight boundaries and produce nothing;
 *  - sanitization — raw agent output, absolute paths, and credentials in event
 *    data have no field to reach a milestone through.
 *
 * The retry-deadline and transactional halves are pinned against the real
 * phase runner and a real SQLite store at the bottom of the file: a
 * `retry_scheduled` milestone must carry the notBefore the ROW committed, and
 * milestones must never outlive a transition that lost its claim.
 */
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  REFINEMENT_PHASE_FAILED_CLASS,
  REFINEMENT_PROGRESS_EVENT_TYPE,
  REFINEMENT_PROGRESS_MILESTONE_KINDS,
  REFINEMENT_PROGRESS_NEXT_ACTIONS,
  REFINEMENT_PROGRESS_SCHEMA_VERSION,
  appendRefinementProgressLedger,
  computeRefinementMilestoneId,
  prepareRefinementProgressCommit,
  projectRefinementProgress,
  readRefinementProgressBlock,
  readRefinementProgressLedger,
  refinementProgressEvent,
  refinementProgressLedgerCap,
  stampRefinementRetryDeadline,
} from '../dist/core/issue-refinement-progress.js';
import { ISSUE_REFINEMENT_DEFAULT_LIMITS } from '../dist/core/issue-refinement.js';
import { SqliteTaskStore } from '../dist/stores/sqlite-task-store.js';
import { SqliteOutboxStore } from '../dist/stores/sqlite-outbox-store.js';
import { runNextPhase } from '../dist/core/phase-runner.js';

const NOW = '2026-08-10T10:00:00.000Z';
const FINGERPRINT = 'a'.repeat(64);
const PREDECESSOR_FINGERPRINT = 'b'.repeat(64);

const block = (over = {}) => ({
  state: 'drafting',
  sourceFingerprint: FINGERPRINT,
  predecessorFingerprint: PREDECESSOR_FINGERPRINT,
  limits: { ...ISSUE_REFINEMENT_DEFAULT_LIMITS },
  ...over,
});

const ctx = (over = {}) => ({ title: 'Downstream Issue', refinement: block(over) });

/** The §15 envelope every loop/apply event carries, plus the event's own data. */
const evt = (type, data = {}) => ({
  type,
  data: {
    issueNumber: 99,
    runId: 'run-refine-1',
    state: 'drafting',
    predecessors: [12],
    predecessorFingerprint: PREDECESSOR_FINGERPRINT,
    counters: { rounds: 0 },
    at: '2026-08-10T09:59:00.000Z',
    ...data,
  },
});

const REFINER_AGENT = {
  agentId: 'claude',
  provider: 'anthropic',
  model: 'opus',
  modelSource: 'default',
  effort: 'high',
  effortSource: 'default',
};
const CRITIC_AGENT = {
  role: 'critic',
  agentId: 'codex',
  provider: 'openai',
  model: 'gpt-5',
  modelSource: 'default',
  effort: 'high',
  effortSource: 'default',
};

const snapshotCaptured = () =>
  evt('refinement.snapshot.captured', {
    state: 'drafting',
    predecessorCount: 1,
    totalTextBytes: 1200,
    truncatedFields: 0,
  });

const draftRecorded = (round = 1, attempt = 1) =>
  evt('refinement.draft.recorded', {
    state: 'critiquing',
    round,
    role: 'refiner',
    ...REFINER_AGENT,
    confidence: 'high',
    topologyProposals: 0,
    regionBytes: 900,
    attempt,
    durationMs: 4200,
  });

const critiquePassed = (round = 1, attempt = 1) =>
  evt('refinement.critique.passed', {
    state: 'accepted',
    round,
    refinerConfidence: 'high',
    criticConfidence: 'medium',
    ...CRITIC_AGENT,
    attempt,
    durationMs: 3100,
  });

const critiqueRevise = (round = 1, attempt = 1) =>
  evt('refinement.critique.revise', {
    state: 'critiquing',
    round,
    objections: [{ field: 'acceptanceCriteria', kind: 'unsupported' }],
    criticConfidence: 'medium',
    ...CRITIC_AGENT,
    attempt,
    durationMs: 2900,
  });

const agentFailed = (role = 'refiner', round = 1, attempt = 1) =>
  evt('refinement.agent.failed', {
    state: role === 'refiner' ? 'drafting' : 'critiquing',
    role,
    ...(role === 'refiner' ? REFINER_AGENT : CRITIC_AGENT),
    failureKind: 'usage_quota',
    retryable: true,
    round,
    attempt,
    durationMs: 600,
  });

const escalated = (reason, data = {}) =>
  evt('refinement.escalated.human', { state: 'escalated_human', reason, ...data });

const activated = () =>
  evt('refinement.activated', {
    state: 'activated',
    parked: { status: 'blocked', phase: 'implementation' },
    agentLabel: 'agent:claude',
    implementationAgent: 'claude',
  });

/** The commit shape both real call sites use. */
const commit = ({ context, events, result = 'success', notBefore = null }) =>
  prepareRefinementProgressCommit({
    issueNumber: 99,
    context,
    events,
    result,
    notBefore,
    now: NOW,
  });

// ---------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------

describe('refinement progress milestones — the contract', () => {
  test('emits exactly the eight coarse kinds', () => {
    expect([...REFINEMENT_PROGRESS_MILESTONE_KINDS]).toEqual([
      'started',
      'refiner_completed',
      'critic_completed',
      'retry_scheduled',
      'accepted',
      'activated',
      'human_handoff',
      'failed',
    ]);
  });

  test('a successful run records one ordered sequence: started → refiner → critic → accepted', () => {
    const prepared = commit({
      context: ctx({ state: 'accepted' }),
      events: [
        evt('refinement.roles.resolved'),
        evt('refinement.eligibility.granted'),
        snapshotCaptured(),
        draftRecorded(),
        critiquePassed(),
      ],
    });

    expect(prepared.milestones.map((m) => m.kind)).toEqual([
      'started',
      'refiner_completed',
      'critic_completed',
      'accepted',
    ]);
    expect(prepared.milestones.map((m) => m.nextAction)).toEqual([
      'await_refiner',
      'await_critic',
      'await_acceptance',
      'await_application',
    ]);
    for (const m of prepared.milestones) {
      expect(m.schemaVersion).toBe(REFINEMENT_PROGRESS_SCHEMA_VERSION);
      expect(m.issueNumber).toBe(99);
      expect(m.sourceFingerprint).toBe(FINGERPRINT);
      expect(m.predecessorFingerprint).toBe(PREDECESSOR_FINGERPRINT);
      expect(m.humanActionRequired).toBe(false);
      expect(REFINEMENT_PROGRESS_NEXT_ACTIONS).toContain(m.nextAction);
      expect(m.milestoneId).toMatch(/^[0-9a-f]{32}$/);
      // A run that committed no delay states no deadline.
      expect(m.retryNotBefore).toBeUndefined();
    }
  });

  test('a role completion carries the round, the attempt, its per-turn duration, and the agent that ran it', () => {
    const prepared = commit({
      context: ctx({ state: 'accepted' }),
      events: [snapshotCaptured(), draftRecorded(1, 2), critiquePassed()],
    });
    const refiner = prepared.milestones.find((m) => m.kind === 'refiner_completed');
    expect(refiner).toMatchObject({
      round: 1,
      role: 'refiner',
      attempt: 2,
      durationMs: 4200,
      result: 'high',
      state: 'critiquing',
      agent: {
        agentId: 'claude',
        provider: 'anthropic',
        model: 'opus',
        effort: 'high',
        modelSource: 'default',
        effortSource: 'default',
      },
    });
    const critic = prepared.milestones.find((m) => m.kind === 'critic_completed');
    expect(critic).toMatchObject({
      round: 1,
      role: 'critic',
      result: 'pass',
      durationMs: 3100,
      agent: { agentId: 'codex', provider: 'openai', model: 'gpt-5' },
    });
    // Acceptance is a boundary of its own, not a role turn.
    const accepted = prepared.milestones.find((m) => m.kind === 'accepted');
    expect(accepted.role).toBeUndefined();
    expect(accepted.round).toBe(1);
    expect(accepted.result).toBe('medium');
  });

  test('a revise verdict records a critic completion that points back at the refiner', () => {
    const prepared = commit({
      context: ctx({ state: 'critiquing' }),
      events: [snapshotCaptured(), draftRecorded(1), critiqueRevise(1)],
    });
    expect(prepared.milestones.map((m) => m.kind)).toEqual([
      'started',
      'refiner_completed',
      'critic_completed',
    ]);
    const critic = prepared.milestones[2];
    expect(critic.result).toBe('revise');
    expect(critic.nextAction).toBe('await_refiner');
    expect(critic.humanActionRequired).toBe(false);
  });

  test('an escalation records a human handoff with the closed-set reason and the human flag', () => {
    const prepared = commit({
      context: ctx({ state: 'escalated_human', handoffReason: 'no_convergence' }),
      result: 'blocked',
      events: [snapshotCaptured(), draftRecorded(1), escalated('no_convergence', { round: 2 })],
    });
    const handoff = prepared.milestones.find((m) => m.kind === 'human_handoff');
    expect(handoff).toMatchObject({
      reason: 'no_convergence',
      nextAction: 'await_human',
      humanActionRequired: true,
      state: 'escalated_human',
      round: 2,
    });
  });

  test('an unrecognized handoff reason becomes the `unknown` literal rather than free text', () => {
    const prepared = commit({
      context: ctx({ state: 'escalated_human' }),
      result: 'blocked',
      events: [escalated('because the model said so, at /Users/me/secret')],
    });
    expect(prepared.milestones[0].reason).toBe('unknown');
  });

  test('activation records the terminal handover to implementation', () => {
    const prepared = commit({
      context: ctx({ state: 'activated' }),
      events: [evt('refinement.applied'), evt('refinement.comment.posted'), activated()],
    });
    expect(prepared.milestones.map((m) => m.kind)).toEqual(['activated']);
    expect(prepared.milestones[0]).toMatchObject({
      nextAction: 'await_implementation',
      state: 'activated',
      humanActionRequired: false,
    });
  });

  test('a non-retryable terminal failure records the failed milestone and the human flag', () => {
    const prepared = commit({
      context: ctx({ state: 'applying' }),
      result: 'failed',
      events: [],
    });
    expect(prepared.milestones).toHaveLength(1);
    expect(prepared.milestones[0]).toMatchObject({
      kind: 'failed',
      failureClass: REFINEMENT_PHASE_FAILED_CLASS,
      nextAction: 'await_human',
      humanActionRequired: true,
      state: 'applying',
    });
  });
});

// ---------------------------------------------------------------------------
// Noise boundary
// ---------------------------------------------------------------------------

describe('refinement progress milestones — noise boundary', () => {
  test('an eligibility hold produces no milestone at all', () => {
    expect(
      commit({
        context: ctx({ state: 'pending' }),
        result: 'delayed',
        events: [
          evt('refinement.eligibility.refused', {
            state: 'pending',
            reason: 'predecessor_not_ready',
            predecessors: [12],
          }),
        ],
      }),
    ).toBeNull();
  });

  test('an idle/polling run with no events and no failure produces nothing', () => {
    expect(commit({ context: ctx(), events: [] })).toBeNull();
  });

  test('the internal events that cross no boundary produce nothing', () => {
    expect(
      commit({
        context: ctx({ state: 'applying' }),
        events: [
          evt('refinement.roles.resolved'),
          evt('refinement.eligibility.granted'),
          evt('refinement.draft.malformed', { round: 1, attempt: 1 }),
          evt('refinement.critique.malformed', { round: 1, attempt: 1 }),
          evt('refinement.topology.recorded'),
          evt('refinement.stale.detected', { trigger: 'fingerprint' }),
          evt('refinement.accepted.persisted'),
          evt('refinement.applied'),
          evt('refinement.comment.posted'),
          evt('refinement.implementation.held'),
          evt('refinement.recovery.applied'),
          evt('refinement.execution.suspended'),
        ],
      }),
    ).toBeNull();
  });

  test('a task with no refinement block at all is not projected', () => {
    expect(commit({ context: { title: 'unrelated' }, events: [snapshotCaptured()] })).toBeNull();
    expect(commit({ context: undefined, result: 'failed', events: [] })).toBeNull();
    // A block too incomplete to identify (no source fingerprint, no limits)
    // fails closed to no milestones rather than to a half-identified one.
    expect(
      commit({ context: { refinement: { state: 'drafting' } }, events: [snapshotCaptured()] }),
    ).toBeNull();
  });

  test('a retryable agent failure that scheduled no retry mints no retry milestone', () => {
    // Same event, but the transition delayed for an eligibility hold: no
    // `pendingRetry` was committed, so no role is waiting to resume.
    expect(
      commit({
        context: ctx({ state: 'drafting' }),
        result: 'delayed',
        notBefore: '2026-08-10T11:00:00.000Z',
        events: [agentFailed('refiner')],
      }),
    ).toBeNull();
    // And the same event on a run that escalated instead of retrying.
    const escalatedRun = commit({
      context: ctx({ state: 'escalated_human' }),
      result: 'blocked',
      events: [
        evt('refinement.agent.failed', {
          role: 'refiner',
          failureKind: 'spawn-missing-binary',
          retryable: false,
          round: 1,
          attempt: 2,
        }),
        escalated('agent_unavailable', { round: 1 }),
      ],
    });
    expect(escalatedRun.milestones.map((m) => m.kind)).toEqual(['human_handoff']);
  });
});

// ---------------------------------------------------------------------------
// Deterministic identity and durable suppression
// ---------------------------------------------------------------------------

describe('refinement progress milestones — identity and suppression', () => {
  test('the id depends on identity and the semantic transition, and on nothing else', () => {
    const base = {
      issueNumber: 99,
      sourceFingerprint: FINGERPRINT,
      kind: 'refiner_completed',
      round: 1,
      role: 'refiner',
      transition: 'refinement.draft.recorded',
    };
    expect(computeRefinementMilestoneId(base)).toBe(computeRefinementMilestoneId({ ...base }));
    // Every coordinate moves the id.
    expect(computeRefinementMilestoneId({ ...base, round: 2 })).not.toBe(
      computeRefinementMilestoneId(base),
    );
    expect(computeRefinementMilestoneId({ ...base, kind: 'critic_completed' })).not.toBe(
      computeRefinementMilestoneId(base),
    );
    expect(computeRefinementMilestoneId({ ...base, role: 'critic' })).not.toBe(
      computeRefinementMilestoneId(base),
    );
    expect(computeRefinementMilestoneId({ ...base, issueNumber: 100 })).not.toBe(
      computeRefinementMilestoneId(base),
    );
    expect(computeRefinementMilestoneId({ ...base, sourceFingerprint: 'c'.repeat(64) })).not.toBe(
      computeRefinementMilestoneId(base),
    );
  });

  test('the same transition delivered under a different run id and clock keeps its id', () => {
    const events = [snapshotCaptured(), draftRecorded(), critiquePassed()];
    const first = commit({ context: ctx({ state: 'accepted' }), events });
    const replayedEvents = events.map((e) => ({
      ...e,
      data: { ...e.data, runId: 'run-refine-2', at: '2027-01-01T00:00:00.000Z' },
    }));
    const second = prepareRefinementProgressCommit({
      issueNumber: 99,
      context: ctx({ state: 'accepted' }),
      events: replayedEvents,
      result: 'success',
      now: '2027-01-01T00:00:00.000Z',
    });
    expect(second.milestones.map((m) => m.milestoneId)).toEqual(
      first.milestones.map((m) => m.milestoneId),
    );
  });

  test('a role completion keeps its id when the replay succeeds on a different attempt', () => {
    // A re-run after a claim loss may take a different number of malformed
    // attempts to produce the same round's draft; that is the SAME semantic
    // transition, so it must not mint a second milestone.
    const first = commit({ context: ctx(), events: [draftRecorded(1, 1)] });
    const second = prepareRefinementProgressCommit({
      issueNumber: 99,
      context: {
        refinement: {
          ...block(),
          progressMilestones: first.context.refinement.progressMilestones,
        },
      },
      events: [draftRecorded(1, 3)],
      result: 'success',
      now: NOW,
    });
    expect(second).toBeNull();
  });

  test('replaying a committed transition against the persisted ledger adds nothing', () => {
    const events = [snapshotCaptured(), draftRecorded(), critiquePassed()];
    const first = commit({ context: ctx({ state: 'accepted' }), events });
    expect(first.milestones).toHaveLength(4);
    const ledger = first.context.refinement.progressMilestones;
    expect(ledger.schemaVersion).toBe(REFINEMENT_PROGRESS_SCHEMA_VERSION);
    expect(ledger.emitted).toEqual(first.milestones.map((m) => m.milestoneId));

    const replay = commit({
      context: { refinement: { ...block({ state: 'accepted' }), progressMilestones: ledger } },
      events,
    });
    expect(replay).toBeNull();
  });

  test('a second bounded round adds only its own milestones', () => {
    const roundOne = commit({
      context: ctx({ state: 'critiquing' }),
      events: [snapshotCaptured(), draftRecorded(1), critiqueRevise(1)],
    });
    const roundTwo = prepareRefinementProgressCommit({
      issueNumber: 99,
      context: {
        refinement: {
          ...block({ state: 'accepted' }),
          progressMilestones: roundOne.context.refinement.progressMilestones,
        },
      },
      // The resumed walk re-captures its snapshot and re-emits round 1 nothing;
      // round 2 is what is new.
      events: [snapshotCaptured(), draftRecorded(2), critiquePassed(2)],
      result: 'success',
      now: NOW,
    });
    expect(roundTwo.milestones.map((m) => m.kind)).toEqual([
      'refiner_completed',
      'critic_completed',
      'accepted',
    ]);
    expect(roundTwo.milestones.map((m) => m.round)).toEqual([2, 2, 2]);
    // The ledger accumulates; nothing from round 1 is re-emitted or lost.
    expect(roundTwo.context.refinement.progressMilestones.emitted).toEqual([
      ...roundOne.context.refinement.progressMilestones.emitted,
      ...roundTwo.milestones.map((m) => m.milestoneId),
    ]);
  });

  test('a block written before this slice, or with an unreadable ledger, still projects', () => {
    expect(readRefinementProgressLedger(undefined)).toEqual([]);
    expect(readRefinementProgressLedger({})).toEqual([]);
    expect(readRefinementProgressLedger({ progressMilestones: 'nope' })).toEqual([]);
    expect(readRefinementProgressLedger({ progressMilestones: { schemaVersion: 99, emitted: ['x'] } }))
      .toEqual([]);
    expect(
      readRefinementProgressLedger({
        progressMilestones: { schemaVersion: 1, emitted: ['abc', 7, '', 'def'] },
      }),
    ).toEqual(['abc', 'def']);

    // A legacy block (no ledger key at all) is readable and projectable.
    const legacy = commit({ context: ctx(), events: [snapshotCaptured()] });
    expect(legacy.milestones.map((m) => m.kind)).toEqual(['started']);
    expect(legacy.context.refinement.progressMilestones.emitted).toHaveLength(1);
  });

  test('the ledger is bounded by the existing refinement caps', () => {
    const cap = refinementProgressLedgerCap(ISSUE_REFINEMENT_DEFAULT_LIMITS);
    // 8 headroom + (2 rounds + 1 stale restart + 1) * (2 roles + 2*2 retries)
    expect(cap).toBe(8 + 4 * 6);
    const overflowing = Array.from({ length: cap + 5 }, (_, i) => `id-${i}`);
    const ledger = appendRefinementProgressLedger([], overflowing, cap, NOW);
    expect(ledger.emitted).toHaveLength(cap);
    expect(ledger.emitted[0]).toBe('id-5');
    expect(ledger.updatedAt).toBe(NOW);
    // Re-appending an id already present does not grow the ledger.
    expect(appendRefinementProgressLedger(['a', 'b'], ['b'], cap, NOW).emitted).toEqual(['a', 'b']);
  });

  test('the ledger travels back in the same context patch as the block it belongs to', () => {
    const prepared = commit({ context: ctx({ state: 'accepted' }), events: [snapshotCaptured()] });
    // Nothing else in the context is disturbed, and the block is otherwise itself.
    expect(prepared.context.title).toBe('Downstream Issue');
    expect(prepared.context.refinement.state).toBe('accepted');
    expect(prepared.context.refinement.sourceFingerprint).toBe(FINGERPRINT);
  });
});

// ---------------------------------------------------------------------------
// Bounded and sanitized fields
// ---------------------------------------------------------------------------

describe('refinement progress milestones — bounded and sanitized', () => {
  // Every one of these is a value a compromised or confused producer could put
  // on an audit event: a local path, a credential, a transcript fragment.
  const HOSTILE = {
    provider: '/Users/moto/creds "token=sk-fake-1"',
    model: 'C:\\Users\\moto\\models\\opus',
    modelSource: '../../etc/passwd',
    effort: 'high; export TOKEN=ghp_fake1',
    effortSource: 'anthropic\n\nRAW MODEL OUTPUT: rewrite the issue as follows',
  };

  test('raw output, paths, and credentials in event data cannot reach a milestone', () => {
    const prepared = commit({
      context: ctx(),
      events: [
        evt('refinement.draft.recorded', {
          round: 1,
          role: 'refiner',
          agentId: 'claude',
          ...HOSTILE,
          confidence: 'high',
          attempt: 1,
          durationMs: 10,
          // Fields with no milestone home are dropped wholesale.
          rawStdout: 'the entire transcript, all 1MB of it',
          artifactDir: '/tmp/test-repo/.artifacts/issue-refinement/issue-99/run-1',
        }),
      ],
    });
    const serialized = JSON.stringify(prepared.milestones);
    expect(serialized).not.toContain('sk-fake');
    expect(serialized).not.toContain('ghp_');
    expect(serialized).not.toContain('/Users/');
    expect(serialized).not.toContain('C:\\');
    expect(serialized).not.toContain('..');
    expect(serialized).not.toContain('RAW MODEL OUTPUT');
    expect(serialized).not.toContain('the entire transcript');
    expect(serialized).not.toContain('.artifacts');
    expect(serialized).not.toContain('etc');
    expect(serialized).not.toContain('passwd');

    // A non-identifier is not scrubbed into a shorter non-identifier — it is
    // refused, because a scrubbed credential is still a credential.
    expect(prepared.milestones[0].agent).toBeUndefined();
  });

  test('the identifier fields that survive are identifiers, and bounded', () => {
    const prepared = commit({
      context: ctx(),
      events: [snapshotCaptured(), draftRecorded(), critiquePassed()],
    });
    for (const m of prepared.milestones) {
      for (const value of Object.values(m.agent ?? {})) {
        if (value === null) continue;
        expect(value).toMatch(/^[A-Za-z0-9._:-]+$/);
        expect(value.length).toBeLessThanOrEqual(64);
      }
      for (const field of [m.result, m.reason, m.failureClass]) {
        if (field === undefined) continue;
        expect(field).toMatch(/^[A-Za-z0-9._:-]+$/);
        expect(field.length).toBeLessThanOrEqual(64);
      }
    }
  });

  test('an over-long identifier is dropped rather than truncated into a new value', () => {
    const prepared = commit({
      context: ctx(),
      events: [
        evt('refinement.draft.recorded', {
          round: 1,
          agentId: 'claude',
          provider: 'anthropic',
          model: 'm'.repeat(65),
          effort: 'e'.repeat(41),
        }),
      ],
    });
    expect(prepared.milestones[0].agent).toEqual({
      agentId: 'claude',
      provider: 'anthropic',
      model: null,
      effort: null,
    });
  });

  test('a milestone carries only the contract fields', () => {
    const prepared = commit({
      context: ctx(),
      events: [snapshotCaptured(), draftRecorded(), critiqueRevise()],
    });
    const allowed = new Set([
      'schemaVersion', 'milestoneId', 'kind', 'issueNumber', 'sourceFingerprint',
      'predecessorFingerprint', 'state', 'round', 'role', 'attempt', 'agent',
      'durationMs', 'result', 'reason', 'failureClass', 'nextAction',
      'retryNotBefore', 'humanActionRequired', 'occurredAt',
    ]);
    for (const m of prepared.milestones) {
      for (const key of Object.keys(m)) expect(allowed.has(key)).toBe(true);
      if (m.agent) {
        for (const key of Object.keys(m.agent)) {
          expect(['agentId', 'provider', 'model', 'effort', 'modelSource', 'effortSource'])
            .toContain(key);
        }
      }
    }
  });

  test('out-of-range counters and unknown literals are dropped, not passed through', () => {
    const prepared = commit({
      context: ctx(),
      events: [
        evt('refinement.draft.recorded', {
          round: -3,
          attempt: 'many',
          durationMs: -1,
          confidence: 'extremely high',
          agentId: '   ',
          provider: 'anthropic',
        }),
      ],
    });
    const m = prepared.milestones[0];
    expect(m.round).toBeUndefined();
    expect(m.attempt).toBeUndefined();
    expect(m.durationMs).toBeUndefined();
    expect(m.result).toBeUndefined();
    // An agent id that sanitizes to nothing takes the whole record with it.
    expect(m.agent).toBeUndefined();
  });

  test('the persisted event is the milestone itself, under one type', () => {
    const prepared = commit({ context: ctx(), events: [snapshotCaptured()] });
    const event = refinementProgressEvent(prepared.milestones[0]);
    expect(event.type).toBe(REFINEMENT_PROGRESS_EVENT_TYPE);
    expect(event.data).toEqual(prepared.milestones[0]);
  });
});

// ---------------------------------------------------------------------------
// The retry deadline
// ---------------------------------------------------------------------------

describe('refinement progress milestones — the retry deadline', () => {
  const retryContext = () =>
    ctx({
      state: 'drafting',
      pendingRetry: { role: 'refiner', round: 1, attempt: 1, failureKind: 'usage_quota' },
    });

  test('a committed role retry records one retry_scheduled with the given deadline', () => {
    const prepared = commit({
      context: retryContext(),
      result: 'delayed',
      notBefore: '2026-08-10T15:00:00.000Z',
      events: [snapshotCaptured(), agentFailed('refiner', 1, 1)],
    });
    expect(prepared.milestones.map((m) => m.kind)).toEqual(['started', 'retry_scheduled']);
    expect(prepared.milestones[1]).toMatchObject({
      role: 'refiner',
      round: 1,
      attempt: 1,
      failureClass: 'usage_quota',
      nextAction: 'await_retry',
      retryNotBefore: '2026-08-10T15:00:00.000Z',
      humanActionRequired: false,
    });
  });

  test('a second retry in the same round is its own milestone; a replay of either is not', () => {
    const first = commit({
      context: retryContext(),
      result: 'delayed',
      notBefore: '2026-08-10T15:00:00.000Z',
      events: [agentFailed('refiner', 1, 1)],
    });
    const second = prepareRefinementProgressCommit({
      issueNumber: 99,
      context: {
        refinement: {
          ...retryContext().refinement,
          progressMilestones: first.context.refinement.progressMilestones,
        },
      },
      events: [agentFailed('refiner', 1, 1), agentFailed('refiner', 1, 2)],
      result: 'delayed',
      notBefore: '2026-08-10T20:00:00.000Z',
      now: NOW,
    });
    expect(second.milestones).toHaveLength(1);
    expect(second.milestones[0]).toMatchObject({
      attempt: 2,
      retryNotBefore: '2026-08-10T20:00:00.000Z',
    });
  });

  test('a retry milestone with no committed deadline is dropped, and stays unsuppressed', () => {
    // Nothing produces this today — the projection only drafts a retry for a
    // delayed transition — but a deadline-less retry milestone would be a lie,
    // and burning its id would suppress the real one forever.
    const projected = projectRefinementProgress({
      issueNumber: 99,
      block: block({
        pendingRetry: { role: 'refiner', round: 1, attempt: 1, failureKind: 'usage_quota' },
      }),
      events: [agentFailed('refiner', 1, 1)],
      result: 'delayed',
      now: NOW,
    });
    expect(projected.map((m) => m.kind)).toEqual(['retry_scheduled']);
    expect(stampRefinementRetryDeadline(projected, null)).toEqual([]);
    expect(stampRefinementRetryDeadline(projected, undefined)).toEqual([]);
    expect(stampRefinementRetryDeadline(projected, '')).toEqual([]);
    const kept = stampRefinementRetryDeadline(projected, '2026-08-10T15:00:00.000Z');
    expect(kept[0].retryNotBefore).toBe('2026-08-10T15:00:00.000Z');
    // Non-retry milestones pass through untouched either way.
    const started = projectRefinementProgress({
      issueNumber: 99,
      block: block(),
      events: [snapshotCaptured()],
      result: 'success',
      now: NOW,
    });
    expect(stampRefinementRetryDeadline(started, null)).toEqual(started);
  });

  test('readRefinementProgressBlock reads the block a transition is committing', () => {
    expect(readRefinementProgressBlock(undefined)).toBeNull();
    expect(readRefinementProgressBlock({ refinement: null })).toBeNull();
    expect(readRefinementProgressBlock({ refinement: [] })).toBeNull();
    expect(readRefinementProgressBlock({ refinement: { state: 'nonsense' } })).toBeNull();
    const view = readRefinementProgressBlock(ctx({ state: 'accepted' }));
    expect(view).toMatchObject({ state: 'accepted', sourceFingerprint: FINGERPRINT });
  });
});

// ---------------------------------------------------------------------------
// Durability: the real runner, the real store
// ---------------------------------------------------------------------------

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

describe('refinement progress milestones — committed with the transition', () => {
  let tmpDir;
  let taskStore;
  let outboxStore;

  const enqueue = async (context) =>
    taskStore.enqueueTask({
      sessionId: 'test-session',
      issueNumber: 99,
      phase: 'refinement',
      now: NOW,
      context,
    });

  const run = async (handler) =>
    runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: { refinement: handler },
      outboxStore,
      session: SESSION,
      now: NOW,
    });

  const milestonesOf = async () =>
    (await taskStore.listEvents(KEY))
      .filter((e) => e.type === REFINEMENT_PROGRESS_EVENT_TYPE)
      .map((e) => e.data);

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'refinement-progress-test-'));
    const dbPath = join(tmpDir, 'test.db');
    taskStore = new SqliteTaskStore(dbPath);
    outboxStore = new SqliteOutboxStore(dbPath);
  });

  afterEach(() => {
    taskStore.close();
    outboxStore.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('a successful refinement run persists its milestones and its ledger in SQLite', async () => {
    await enqueue(ctx({ state: 'eligible' }));
    const outcome = await run(async () => ({
      result: 'success',
      message: 'refinement accepted after 1 round(s)',
      context: ctx({ state: 'accepted' }),
      extraEvents: [snapshotCaptured(), draftRecorded(), critiquePassed()],
    }));
    expect(outcome.status).toBe('completed');

    const persisted = await milestonesOf();
    expect(persisted.map((m) => m.kind)).toEqual([
      'started',
      'refiner_completed',
      'critic_completed',
      'accepted',
    ]);
    // The audit events keep their own record; the milestones are additive.
    const types = (await taskStore.listEvents(KEY)).map((e) => e.type);
    expect(types).toContain('refinement.snapshot.captured');
    expect(types).toContain('refinement.critique.passed');
    // Ordered behind the fine-grained events they project from.
    expect(types.indexOf('refinement.snapshot.captured'))
      .toBeLessThan(types.indexOf(REFINEMENT_PROGRESS_EVENT_TYPE));

    const task = await taskStore.getTask(KEY);
    expect(task.context.refinement.progressMilestones.emitted).toEqual(
      persisted.map((m) => m.milestoneId),
    );
  });

  test('a restart replaying the same transition writes no duplicate milestone', async () => {
    await enqueue(ctx({ state: 'eligible' }));
    const handlerResult = () => ({
      result: 'success',
      context: ctx({ state: 'accepted' }),
      extraEvents: [snapshotCaptured(), draftRecorded(), critiquePassed()],
    });
    await run(async () => handlerResult());
    const first = await milestonesOf();
    expect(first).toHaveLength(4);

    // The task stayed queued at this phase (a refinement success is mid-lane),
    // so the next tick re-claims it. A crashed run that re-derives the same
    // walk must add nothing — and the ledger it reads is the one on the row,
    // not anything this process remembers.
    const replayContext = (await taskStore.getTask(KEY)).context;
    await run(async () => ({
      result: 'success',
      context: { ...replayContext, refinement: { ...replayContext.refinement, state: 'accepted' } },
      extraEvents: [snapshotCaptured(), draftRecorded(), critiquePassed()],
    }));
    const second = await milestonesOf();
    expect(second.map((m) => m.milestoneId)).toEqual(first.map((m) => m.milestoneId));
  });

  test('a committed role retry records the EXACT notBefore the row carries', async () => {
    await enqueue(ctx({ state: 'drafting' }));
    const outcome = await run(async () => ({
      result: 'delayed',
      message: 'refinement refiner process failure (usage_quota) in round 1',
      context: ctx({
        state: 'drafting',
        pendingRetry: { role: 'refiner', round: 1, attempt: 1, failureKind: 'usage_quota' },
      }),
      extraEvents: [agentFailed('refiner', 1, 1)],
    }));
    expect(outcome.status).toBe('delayed');

    const task = await taskStore.getTask(KEY);
    const persisted = await milestonesOf();
    expect(persisted.map((m) => m.kind)).toEqual(['retry_scheduled']);
    // Not an estimate, not the handler's guess: the value on the row.
    expect(persisted[0].retryNotBefore).toBe(task.notBefore);
    expect(persisted[0].retryNotBefore).toBe(outcome.notBefore);
    expect(task.context.refinement.progressMilestones.emitted)
      .toEqual([persisted[0].milestoneId]);
    // The resumable position the milestone describes is on the same row.
    expect(task.context.refinement.pendingRetry.role).toBe('refiner');
  });

  test('a lost claim commits no milestone', async () => {
    await enqueue(ctx({ state: 'eligible' }));
    const outcome = await runNextPhase({
      store: taskStore,
      request: REQUEST,
      handlers: {
        refinement: async () => {
          // A concurrent owner takes the row while the handler runs: the
          // completion CAS fails, so nothing — milestones included — commits.
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
    expect(await milestonesOf()).toHaveLength(0);
    const task = await taskStore.getTask(KEY);
    expect(task.context.refinement.progressMilestones).toBeUndefined();
  });

  test('a non-retryable phase failure records the terminal milestone', async () => {
    await enqueue(ctx({ state: 'applying' }));
    const outcome = await run(async () => ({
      result: 'failed',
      error: 'refinement application is not runnable (state:activated)',
      context: ctx({ state: 'applying' }),
    }));
    expect(outcome.status).toBe('completed');
    expect((await taskStore.getTask(KEY)).status).toBe('failed');

    const persisted = await milestonesOf();
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      kind: 'failed',
      humanActionRequired: true,
      nextAction: 'await_human',
    });
    // The prose error stays on the task row, never inside the milestone.
    expect(JSON.stringify(persisted[0])).not.toContain('not runnable');
  });

  test('a handler that THREW still records the terminal milestone, off the committed block', async () => {
    // The runner synthesizes `{ result: "failed" }` from the error, so there is
    // no handler-authored context patch at all — and this is the commonest way
    // refinement ends non-retryably. The block the task already holds carries
    // the identity the milestone needs.
    await enqueue(ctx({ state: 'drafting' }));
    const outcome = await run(async () => {
      throw new Error('ENOENT: /Users/someone/artifacts/refiner-round1-stdout.txt');
    });
    expect(outcome.status).toBe('completed');
    expect((await taskStore.getTask(KEY)).status).toBe('failed');

    const persisted = await milestonesOf();
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      kind: 'failed',
      state: 'drafting',
      sourceFingerprint: FINGERPRINT,
      humanActionRequired: true,
      nextAction: 'await_human',
      failureClass: REFINEMENT_PHASE_FAILED_CLASS,
    });
    // Neither the thrown message nor the absolute path it named reaches the
    // milestone — the failure class is the whole of what it may say.
    const encoded = JSON.stringify(persisted[0]);
    expect(encoded).not.toContain('ENOENT');
    expect(encoded).not.toContain('/Users/');

    // The ledger commits with it, on the one-key patch — the rest of the
    // committed context is left exactly as the task already held it.
    const task = await taskStore.getTask(KEY);
    expect(task.context.refinement.progressMilestones.emitted).toEqual([
      persisted[0].milestoneId,
    ]);
    expect(task.context.refinement.state).toBe('drafting');
  });

  test('a polling tick over a non-refinement phase projects nothing', async () => {
    await taskStore.enqueueTask({
      sessionId: 'test-session',
      issueNumber: 99,
      phase: 'implementation',
      now: NOW,
      context: ctx({ state: 'activated' }),
    });
    const outcome = await runNextPhase({
      store: taskStore,
      request: { ...REQUEST, supportedPhases: ['implementation'] },
      handlers: {
        implementation: async () => ({
          result: 'success',
          // Even carrying a refinement block and a refinement audit event, a
          // phase that is not `refinement` projects nothing: the milestones are
          // deliberately not generalized to other phases.
          context: ctx({ state: 'activated' }),
          extraEvents: [activated()],
        }),
      },
      now: NOW,
    });
    expect(outcome.status).toBe('completed');
    expect(await milestonesOf()).toHaveLength(0);
  });
});
