// Issue #1042 — the task-scoped operator surface of
// docs/verification-amendment-contract.md §11 (§15 slice A4), minus its argv.
//
// Pins the parts of the §16 "Surface (§11)" and "States (§7)" rows this slice
// owns: the read-only view (drift reported, nothing written), preview-by-default
// and `--yes` applying, the §5.3 rule 3 replay recognition ahead of the status
// table, the §7.3 rule 3 plan-digest guard, the §9.2 rule 3 continuation
// refusal, and the reset's return to the unamended baseline through operations
// rather than deletions.
import {
  MemoryTaskStore,
  amendTaskVerification,
  describeTaskVerificationPlan,
  diffTaskVerificationReset,
  resetTaskVerification,
  taskVerificationResetOperations,
  deriveRequirementCommandId,
  resolveEffectiveVerificationPlan,
  VERIFICATION_AMENDMENTS_CONTEXT_KEY,
} from '../dist/index.js';
import { extractIssueVerificationSections } from '../dist/handlers/issue-verification-extractor.js';

const SESSION = 'sess-amend';
const SESSION_VERIFICATION = { test: 'npm test' };
const REQ = (command) => deriveRequirementCommandId(command);

let issueCounter = 0;
let store;

function issueBody(commands) {
  return ['## Verification', ...commands.map((command) => `- \`${command}\``)].join('\n');
}

async function seedTask(options = {}) {
  const issueNumber = (issueCounter += 1);
  const key = { sessionId: SESSION, issueNumber };
  const enqueued = await store.enqueueTask({
    sessionId: SESSION,
    issueNumber,
    phase: options.phase ?? 'review',
    context: { body: options.body ?? issueBody(['npm run e2e']), title: 'a task', ...(options.context ?? {}) },
  });
  expect(enqueued.ok).toBe(true);
  if (options.status && options.status !== 'queued') {
    const moved = await store.transitionTask(key, {}, {
      status: options.status,
      ...(options.ownerRunId !== undefined ? { ownerRunId: options.ownerRunId } : {}),
    });
    expect(moved.ok).toBe(true);
  }
  return key;
}

function deps() {
  return { store, extract: extractIssueVerificationSections };
}

function amendInput(key, operations, overrides = {}) {
  return {
    key,
    sessionVerification: SESSION_VERIFICATION,
    actorId: 'admin',
    reason: 'the Issue named the wrong command',
    operations,
    ...overrides,
  };
}

const addRequirement = (command, reason = 'the Issue named the wrong command') => ({
  kind: 'add',
  layer: 'requirement',
  command,
  reason,
});

async function readContext(key) {
  const task = await store.getTask(key);
  return task.context ?? {};
}

beforeEach(() => {
  store = new MemoryTaskStore();
});

describe('describeTaskVerificationPlan — the read-only view', () => {
  test('reports the effective plan, slot origins, and evidence status without writing', async () => {
    const key = await seedTask({
      status: 'ready_for_human',
      context: {
        manualVerificationEvidence: [{ command: 'npm run e2e', exitCode: 0, source: 'operator_input' }],
      },
    });

    const outcome = await describeTaskVerificationPlan(deps(), {
      key,
      sessionVerification: SESSION_VERIFICATION,
    });
    expect(outcome.status).toBe('ok');
    const view = outcome.view;
    expect(view.reconciliation).toBe('unamended');
    expect(view.amendable).toBe(true);
    expect(view.defaultContinuation).toBe('review');
    expect(view.plan.execution.map((slot) => slot.commandId)).toEqual(['exec:test']);
    expect(view.plan.execution[0].origin).toBe('session-default');
    expect(view.plan.requirement.map((slot) => slot.commandId)).toEqual([REQ('npm run e2e')]);
    expect(view.plan.requirement[0].origin).toBe('issue-requirement');
    expect(view.requirementStatus[0]).toMatchObject({ status: 'passed', satisfiedBy: 'manual-evidence' });
    expect(view.revisions).toEqual([]);
    expect(view.checkpoint).toBeUndefined();

    expect((await readContext(key))[VERIFICATION_AMENDMENTS_CONTEXT_KEY]).toBeUndefined();
  });

  test('reports why an amendment would refuse instead of refusing the read itself', async () => {
    const key = await seedTask({ status: 'claimed', ownerRunId: 'run-7' });
    const outcome = await describeTaskVerificationPlan(deps(), {
      key,
      sessionVerification: SESSION_VERIFICATION,
    });
    expect(outcome.status).toBe('ok');
    expect(outcome.view.amendable).toBe(false);
    expect(outcome.view.amendmentRefusal.reason).toBe('task_active');
    expect(outcome.view.amendmentRefusal.detail).toContain('run-7');
    expect(outcome.view.defaultContinuation).toBe('none');
  });

  test('a task with no row refuses, naming it', async () => {
    const outcome = await describeTaskVerificationPlan(deps(), {
      key: { sessionId: SESSION, issueNumber: 9999 },
      sessionVerification: SESSION_VERIFICATION,
    });
    expect(outcome).toMatchObject({ status: 'refused', reason: 'task_not_found' });
  });

  test('a hand-edited chain the recorded baseline cannot explain refuses unrepaired', async () => {
    const key = await seedTask({ status: 'ready_for_human' });
    const applied = await amendTaskVerification(
      deps(),
      amendInput(key, [addRequirement('npm run lint')], { apply: true }),
    );
    expect(applied.status).toBe('applied');

    // Simulate a direct edit of the stored plan digest — the thing §11 rule 6
    // says must be detectable. The edit moves the chain head's digest with the
    // checkpoint's, so the block still satisfies #1038's §5.5 rule 3 structural
    // check and the refusal has to come from §6.4 rule 3's replay, not from the
    // shape validator.
    const context = await readContext(key);
    const block = JSON.parse(JSON.stringify(context[VERIFICATION_AMENDMENTS_CONTEXT_KEY]));
    block.checkpoint.planDigest = 'f'.repeat(64);
    block.revisions[block.revisions.length - 1].planDigest = 'f'.repeat(64);
    const patched = await store.transitionTask(key, {}, {
      context: { [VERIFICATION_AMENDMENTS_CONTEXT_KEY]: block },
    });
    expect(patched.ok).toBe(true);

    const outcome = await describeTaskVerificationPlan(deps(), {
      key,
      sessionVerification: SESSION_VERIFICATION,
    });
    expect(outcome).toMatchObject({ status: 'refused', reason: 'unreconciled' });
    // Nothing was repaired: the doctored digest is still exactly what it was.
    const after = await readContext(key);
    expect(after[VERIFICATION_AMENDMENTS_CONTEXT_KEY].checkpoint.planDigest).toBe('f'.repeat(64));
  });
});

describe('amendTaskVerification — preview, apply, and the refusals', () => {
  test('previews without writing and applies the same revision under --yes', async () => {
    const key = await seedTask({ status: 'ready_for_human' });
    const operations = [addRequirement('npm run lint')];

    const preview = await amendTaskVerification(deps(), amendInput(key, operations));
    expect(preview.status).toBe('preview');
    expect(preview.report.operations).toHaveLength(1);
    expect(preview.report.basePlanDigest).not.toBe(preview.report.planDigest);
    // Issue #1043: with nothing typed, the row default IS the route an apply
    // would take, and the preview reports it.
    expect(preview.report.continuation).toBe('review');
    expect(preview.report.defaultContinuation).toBe('review');
    expect((await readContext(key))[VERIFICATION_AMENDMENTS_CONTEXT_KEY]).toBeUndefined();

    const applied = await amendTaskVerification(deps(), amendInput(key, operations, { apply: true }));
    expect(applied.status).toBe('applied');
    expect(applied.revision.revisionOrdinal).toBe(1);
    expect(applied.revision.source).toBe('admin-cli');
    expect(applied.report.revisionId).toBe(preview.report.revisionId);
    expect(applied.report.planDigest).toBe(preview.report.planDigest);

    const block = (await readContext(key))[VERIFICATION_AMENDMENTS_CONTEXT_KEY];
    expect(block.revisions).toHaveLength(1);
    expect(block.checkpoint.planDigest).toBe(applied.report.planDigest);
  });

  test('an unchanged rerun of an applied invocation is a replay, not a second revision', async () => {
    const key = await seedTask({ status: 'ready_for_human' });
    const operations = [addRequirement('npm run lint')];
    const first = await amendTaskVerification(deps(), amendInput(key, operations, { apply: true }));
    expect(first.status).toBe('applied');

    const second = await amendTaskVerification(deps(), amendInput(key, operations, { apply: true }));
    expect(second.status).toBe('replay');
    expect(second.revision.revisionId).toBe(first.revision.revisionId);
    expect((await readContext(key))[VERIFICATION_AMENDMENTS_CONTEXT_KEY].revisions).toHaveLength(1);
  });

  test('a replay is recognized even after the task was claimed', async () => {
    const key = await seedTask({ status: 'ready_for_human' });
    const operations = [addRequirement('npm run lint')];
    const first = await amendTaskVerification(deps(), amendInput(key, operations, { apply: true }));
    expect(first.status).toBe('applied');
    await store.transitionTask(key, {}, { status: 'claimed', ownerRunId: 'run-9' });

    const replay = await amendTaskVerification(deps(), amendInput(key, operations, { apply: true }));
    expect(replay.status).toBe('replay');
    expect(replay.revision.revisionId).toBe(first.revision.revisionId);
  });

  test('retyping only the reason does not manufacture a second revision', async () => {
    const key = await seedTask({ status: 'ready_for_human' });
    const first = await amendTaskVerification(
      deps(),
      amendInput(key, [addRequirement('npm run lint', 'first wording')], {
        apply: true,
        reason: 'first wording',
      }),
    );
    expect(first.status).toBe('applied');

    const retyped = await amendTaskVerification(
      deps(),
      amendInput(key, [addRequirement('npm run lint', 'second wording')], {
        apply: true,
        reason: 'second wording',
      }),
    );
    expect(retyped.status).toBe('replay');
    expect(retyped.revision.revisionId).toBe(first.revision.revisionId);
  });

  test('an applying amendment on a claimed task refuses and writes nothing', async () => {
    const key = await seedTask({ status: 'claimed', ownerRunId: 'run-3' });
    const outcome = await amendTaskVerification(
      deps(),
      amendInput(key, [addRequirement('npm run lint')], { apply: true }),
    );
    expect(outcome).toMatchObject({ status: 'refused', reason: 'task_active' });
    expect(outcome.detail).toContain('run-3');
    expect((await readContext(key))[VERIFICATION_AMENDMENTS_CONTEXT_KEY]).toBeUndefined();
  });

  test('a preview on a claimed task still shows the composition (it writes nothing on any status)', async () => {
    const key = await seedTask({ status: 'claimed', ownerRunId: 'run-3' });
    const preview = await amendTaskVerification(deps(), amendInput(key, [addRequirement('npm run lint')]));
    expect(preview.status).toBe('preview');
  });

  test('--expect-plan-digest refuses on a mismatch and passes on the digest it named', async () => {
    const key = await seedTask({ status: 'ready_for_human' });
    const operations = [addRequirement('npm run lint')];
    const preview = await amendTaskVerification(deps(), amendInput(key, operations));

    const mismatch = await amendTaskVerification(
      deps(),
      amendInput(key, operations, { apply: true, expectedPlanDigest: 'a'.repeat(64) }),
    );
    expect(mismatch).toMatchObject({ status: 'refused', reason: 'plan_digest_mismatch' });
    expect((await readContext(key))[VERIFICATION_AMENDMENTS_CONTEXT_KEY]).toBeUndefined();

    const ok = await amendTaskVerification(
      deps(),
      amendInput(key, operations, { apply: true, expectedPlanDigest: preview.report.basePlanDigest }),
    );
    expect(ok.status).toBe('applied');
  });

  test('an empty reason, an out-of-pattern request key, and an empty operation list each refuse', async () => {
    const key = await seedTask({ status: 'ready_for_human' });
    const operations = [addRequirement('npm run lint')];
    expect(
      await amendTaskVerification(deps(), amendInput(key, operations, { apply: true, reason: '   ' })),
    ).toMatchObject({ status: 'refused', reason: 'invalid_reason' });
    expect(
      await amendTaskVerification(deps(), amendInput(key, operations, { apply: true, requestKey: 'not a key!' })),
    ).toMatchObject({ status: 'refused', reason: 'invalid_request_key' });
    expect(
      await amendTaskVerification(deps(), amendInput(key, [], { apply: true })),
    ).toMatchObject({ status: 'refused', reason: 'invalid_operations' });
    expect((await readContext(key))[VERIFICATION_AMENDMENTS_CONTEXT_KEY]).toBeUndefined();
  });

  test('one invalid operation refuses the whole revision — nothing partial applies', async () => {
    const key = await seedTask({ status: 'ready_for_human' });
    const outcome = await amendTaskVerification(
      deps(),
      amendInput(
        key,
        [addRequirement('npm run lint'), { kind: 'retire', commandId: REQ('never in this plan'), reason: 'x' }],
        { apply: true },
      ),
    );
    expect(outcome).toMatchObject({ status: 'refused', reason: 'invalid_revision' });
    expect(outcome.detail).toContain('unknown_slot');
    expect((await readContext(key))[VERIFICATION_AMENDMENTS_CONTEXT_KEY]).toBeUndefined();
  });

  test('a replace of a slot added earlier in the same revision previews AND applies (issue #1043 review, P2)', async () => {
    // Sequential composition (§5.3 rule 7) makes add-then-replace a valid
    // proposal; the apply must accept the same revision even though the
    // pre-revision plan cannot carry the added slot's bytes — the preceding
    // add supplies them.
    const key = await seedTask({
      status: 'ready_for_human',
      context: {
        manualVerificationEvidence: [{
          command: 'npm run smoke',
          exitCode: 0,
          output: 'ok',
          recordedAt: '2026-01-01T00:00:00.000Z',
          source: 'operator_input',
        }],
      },
    });
    const operations = [
      addRequirement('npm run smoke'),
      { kind: 'replace', commandId: REQ('npm run smoke'), command: 'npm run smoke -- --ci', reason: 'the Issue named the wrong command' },
    ];

    const preview = await amendTaskVerification(deps(), amendInput(key, operations));
    expect(preview.status).toBe('preview');

    const applied = await amendTaskVerification(deps(), amendInput(key, operations, { apply: true }));
    expect(applied.status).toBe('applied');
    expect(applied.report.planDigest).toBe(preview.report.planDigest);

    const context = await readContext(key);
    const resolved = resolveEffectiveVerificationPlan({
      sessionVerification: SESSION_VERIFICATION,
      issueRequirements: ['npm run e2e'],
      amendments: context[VERIFICATION_AMENDMENTS_CONTEXT_KEY],
    });
    expect(resolved.status).toBe('resolved');
    const slot = resolved.plan.requirement.find((entry) => entry.commandId === REQ('npm run smoke'));
    expect(slot).toMatchObject({ state: 'active', command: 'npm run smoke -- --ci' });
    // §8.3 rule 1 rides the same apply: the superseded bytes are the ADD's
    // own, so passing evidence matching them is invalidated for the slot.
    expect(context.manualVerificationEvidence[0].invalidations).toEqual([
      { commandId: REQ('npm run smoke'), supersededByRevision: applied.revision.revisionId },
    ]);
  });

  test('§9.2 rule 3: no continuation unparks a row the table parks', async () => {
    const parked = await seedTask({ status: 'queued', phase: 'implementation' });
    const refused = await amendTaskVerification(
      deps(),
      amendInput(parked, [addRequirement('npm run lint')], { apply: true, requestedContinuation: 'review' }),
    );
    expect(refused).toMatchObject({ status: 'refused', reason: 'continuation_not_permitted' });

    const allowed = await amendTaskVerification(
      deps(),
      amendInput(parked, [addRequirement('npm run lint')], { apply: true, requestedContinuation: 'none' }),
    );
    expect(allowed.status).toBe('applied');
    // The recorded continuation is the one taken: `none` on a parked row.
    expect(allowed.revision.continuation).toBe('none');
    // Recorded only (§9.2): the row is not re-queued and stays exactly where
    // its owning surface put it.
    const task = await store.getTask(parked);
    expect(task.status).toBe('queued');
    expect(task.phase).toBe('implementation');
  });

  test('a retired slot is reported retired and is never a pass', async () => {
    const key = await seedTask({ status: 'ready_for_human' });
    const applied = await amendTaskVerification(
      deps(),
      amendInput(key, [{ kind: 'retire', commandId: REQ('npm run e2e'), reason: 'the check was wrong' }], {
        apply: true,
      }),
    );
    expect(applied.status).toBe('applied');

    const view = (await describeTaskVerificationPlan(deps(), { key, sessionVerification: SESSION_VERIFICATION }))
      .view;
    expect(view.plan.requirement[0].state).toBe('retired');
    expect(view.requirementStatus[0].status).toBe('retired');
    expect(view.reconciliation).toBe('consistent');
  });
});

describe('reset — the append-only return to the unamended baseline', () => {
  test('derives restore, revert, and retire from the amended plan, in a composable order', () => {
    const plan = resolveEffectiveVerificationPlan({
      sessionVerification: SESSION_VERIFICATION,
      issueRequirements: ['npm run e2e'],
      amendments: undefined,
    }).plan;
    expect(diffTaskVerificationReset(plan)).toEqual({ restores: [], reverts: [], retirements: [] });

    const diff = {
      restores: [{ commandId: 'exec:test', layer: 'execution', command: 'npm test', originCommand: 'npm test' }],
      reverts: [{ commandId: REQ('a'), layer: 'requirement', command: 'b', originCommand: 'a' }],
      retirements: [{ commandId: REQ('c'), layer: 'requirement', command: 'c', originCommand: 'c' }],
    };
    expect(taskVerificationResetOperations(diff, { reason: 'r', allowRetire: false }).map((o) => o.kind)).toEqual([
      'restore',
      'replace',
    ]);
    expect(taskVerificationResetOperations(diff, { reason: 'r', allowRetire: true }).map((o) => o.kind)).toEqual([
      'restore',
      'replace',
      'retire',
    ]);
  });

  test('reverts a replaced slot and restores a retired one, leaving the baseline digest', async () => {
    const key = await seedTask({ status: 'ready_for_human' });
    const baseline = (await describeTaskVerificationPlan(deps(), {
      key,
      sessionVerification: SESSION_VERIFICATION,
    })).view.plan.planDigest;

    const amended = await amendTaskVerification(
      deps(),
      amendInput(
        key,
        [
          { kind: 'replace', commandId: REQ('npm run e2e'), command: 'npm run e2e -- --ci', reason: 'typo' },
          { kind: 'retire', commandId: 'exec:test', reason: 'temporarily off' },
        ],
        { apply: true },
      ),
    );
    expect(amended.status).toBe('applied');
    expect(amended.report.planDigest).not.toBe(baseline);

    const result = await resetTaskVerification(deps(), {
      key,
      sessionVerification: SESSION_VERIFICATION,
      actorId: 'admin',
      reason: 'the amendments were wrong; back to the baseline',
      apply: true,
    });
    expect(result.outcome.status).toBe('applied');
    expect(result.outcome.report.operations.map((operation) => operation.kind)).toEqual(['restore', 'replace']);
    // A reversal is a revision: the chain grew, and the plan is the baseline.
    expect(result.outcome.report.planDigest).toBe(baseline);
    const block = (await readContext(key))[VERIFICATION_AMENDMENTS_CONTEXT_KEY];
    expect(block.revisions).toHaveLength(2);
  });

  test('a task-local addition is withheld without allowRetire and retired with it', async () => {
    const key = await seedTask({ status: 'ready_for_human' });
    const added = await amendTaskVerification(
      deps(),
      amendInput(key, [addRequirement('npm run lint')], { apply: true }),
    );
    expect(added.status).toBe('applied');

    const withheld = await resetTaskVerification(deps(), {
      key,
      sessionVerification: SESSION_VERIFICATION,
      actorId: 'admin',
      reason: 'undo it',
      apply: true,
    });
    expect(withheld.outcome.status).toBe('no_change');
    expect(withheld.withheldRetirements.map((entry) => entry.commandId)).toEqual([REQ('npm run lint')]);
    expect((await readContext(key))[VERIFICATION_AMENDMENTS_CONTEXT_KEY].revisions).toHaveLength(1);

    const applied = await resetTaskVerification(deps(), {
      key,
      sessionVerification: SESSION_VERIFICATION,
      actorId: 'admin',
      reason: 'undo it',
      allowRetire: true,
      apply: true,
    });
    expect(applied.outcome.status).toBe('applied');
    expect(applied.outcome.report.operations.map((operation) => operation.kind)).toEqual(['retire']);

    // The added slot is retired, not deleted — §8.4 rule 1's "not a pass".
    const view = (await describeTaskVerificationPlan(deps(), { key, sessionVerification: SESSION_VERIFICATION }))
      .view;
    const slot = view.plan.requirement.find((entry) => entry.commandId === REQ('npm run lint'));
    expect(slot.state).toBe('retired');
    expect(view.requirementStatus.find((entry) => entry.commandId === slot.commandId).status).toBe('retired');
  });

  test('a retried reset is a replay, whether or not it still carries the digest guard', async () => {
    const key = await seedTask({ status: 'ready_for_human' });
    const amended = await amendTaskVerification(
      deps(),
      amendInput(key, [{ kind: 'replace', commandId: REQ('npm run e2e'), command: 'npm run e2e -- --ci', reason: 'typo' }], {
        apply: true,
      }),
    );
    expect(amended.status).toBe('applied');

    // The command line the preview named: the digest it read, and the request
    // key it derived, passed back verbatim.
    const invocation = {
      key,
      sessionVerification: SESSION_VERIFICATION,
      actorId: 'admin',
      reason: 'the amendment was wrong',
      apply: true,
      requestKey: 'reset-lost-response-1',
      expectedPlanDigest: amended.report.planDigest,
    };
    const first = await resetTaskVerification(deps(), invocation);
    expect(first.outcome.status).toBe('applied');

    // §5.3 rule 3: the rerun reads the plan its own first attempt produced, so
    // the guard it still carries names a digest that has moved — and it is
    // recognized as a repeat rather than refused as stale.
    const rerun = await resetTaskVerification(deps(), invocation);
    expect(rerun.outcome).toMatchObject({ status: 'replay' });
    expect(rerun.outcome.revision.revisionId).toBe(first.outcome.revision.revisionId);
    expect(rerun.outcome.revision.revisionOrdinal).toBe(first.outcome.revision.revisionOrdinal);

    // And the same rerun without the guard, which now has nothing left to
    // derive: still the replay, never `no_change`.
    const { expectedPlanDigest: _guard, ...unguarded } = invocation;
    const again = await resetTaskVerification(deps(), unguarded);
    expect(again.outcome).toMatchObject({ status: 'replay' });
    expect(again.outcome.revision.revisionId).toBe(first.outcome.revision.revisionId);

    // Nothing was written twice, and a preview — which writes nothing on any
    // path — is exempt from the lookup and reports what it read.
    expect((await readContext(key))[VERIFICATION_AMENDMENTS_CONTEXT_KEY].revisions).toHaveLength(2);
    const preview = await resetTaskVerification(deps(), { ...unguarded, apply: false });
    expect(preview.outcome.status).toBe('no_change');
  });

  test('an unamended plan resets to nothing, records no revision, and is not a refusal', async () => {
    const key = await seedTask({ status: 'ready_for_human' });
    const result = await resetTaskVerification(deps(), {
      key,
      sessionVerification: SESSION_VERIFICATION,
      actorId: 'admin',
      reason: 'nothing to undo',
      apply: true,
    });
    expect(result.outcome).toMatchObject({ status: 'no_change' });
    expect((await readContext(key))[VERIFICATION_AMENDMENTS_CONTEXT_KEY]).toBeUndefined();
  });

  test('an applying reset with nothing to do still refuses on an active task (§7.2 rule 4)', async () => {
    const key = await seedTask({ status: 'claimed', ownerRunId: 'run-11' });
    const result = await resetTaskVerification(deps(), {
      key,
      sessionVerification: SESSION_VERIFICATION,
      actorId: 'admin',
      reason: 'nothing to undo',
      apply: true,
    });
    expect(result.outcome).toMatchObject({ status: 'refused', reason: 'task_active' });
  });

  test('an empty reason refuses even when there is nothing to undo', async () => {
    const key = await seedTask({ status: 'ready_for_human' });
    const result = await resetTaskVerification(deps(), {
      key,
      sessionVerification: SESSION_VERIFICATION,
      actorId: 'admin',
      reason: '  ',
      apply: true,
    });
    expect(result.outcome).toMatchObject({ status: 'refused', reason: 'invalid_reason' });
  });
});

// Issue #1043 (§9.2): continuation wiring — the post-amendment re-queue, the
// stale-park-state invalidation, evidence preservation, and the fail-closed
// arms of the continuation table.
describe('continuation — the §9.2 re-queue', () => {
  const PARK_CONTEXT = {
    missingVerificationCommands: ['npm run e2e'],
    issueRequiredVerifications: [{ command: 'npm run e2e', status: 'not_run' }],
    verificationEvidenceBinding: { planDigest: 'a'.repeat(64), commandIds: {} },
    manualVerificationEvidence: [{ command: 'npm test', exitCode: 0, source: 'operator_input' }],
    reviewCycles: 2,
  };

  test('a ready_for_human/review park re-queues {queued, review} by default, clearing the stale missing-command state', async () => {
    const key = await seedTask({ status: 'ready_for_human', context: PARK_CONTEXT });
    const applied = await amendTaskVerification(
      deps(),
      amendInput(key, [{ kind: 'replace', commandId: REQ('npm run e2e'), command: 'npm test', reason: 'typo' }], {
        apply: true,
      }),
    );
    expect(applied.status).toBe('applied');
    expect(applied.report.continuation).toBe('review');
    expect(applied.revision.continuation).toBe('review');
    expect(applied.task.status).toBe('queued');
    expect(applied.task.phase).toBe('review');

    const task = await store.getTask(key);
    expect(task.status).toBe('queued');
    expect(task.phase).toBe('review');
    expect(task.ownerRunId).toBeUndefined();
    // The stale park state is invalidated so it cannot repeat...
    expect(task.context.missingVerificationCommands).toBeUndefined();
    expect(task.context.issueRequiredVerifications).toBeUndefined();
    expect(task.context.verificationEvidenceBinding).toBeUndefined();
    // ...while evidence is preserved (§8.1) and the review-loop counters are
    // neither spent nor refunded.
    expect(task.context.manualVerificationEvidence).toHaveLength(1);
    expect(task.context.reviewCycles).toBe(2);
    // Recompute-before-routing (§9.2 rule 2): the re-queued row already
    // carries the amended plan and its digest.
    expect(task.context[VERIFICATION_AMENDMENTS_CONTEXT_KEY].checkpoint.planDigest).toBe(
      applied.report.planDigest,
    );

    const events = await store.listEvents(key);
    const appliedEvent = events.find((event) => event.type === 'verification.amendment.applied');
    expect(appliedEvent.data.continuation).toBe('review');
  });

  test('a blocked/review park re-queues too, and an explicit implementation override routes there', async () => {
    const blocked = await seedTask({ status: 'blocked', context: PARK_CONTEXT });
    const routed = await amendTaskVerification(
      deps(),
      amendInput(blocked, [addRequirement('npm run lint')], { apply: true }),
    );
    expect(routed.status).toBe('applied');
    expect((await store.getTask(blocked)).status).toBe('queued');
    expect((await store.getTask(blocked)).phase).toBe('review');

    const other = await seedTask({ status: 'ready_for_human', context: PARK_CONTEXT });
    const toImpl = await amendTaskVerification(
      deps(),
      amendInput(other, [addRequirement('npm run lint')], {
        apply: true,
        requestedContinuation: 'implementation',
      }),
    );
    expect(toImpl.status).toBe('applied');
    expect(toImpl.revision.continuation).toBe('implementation');
    const task = await store.getTask(other);
    expect(task.status).toBe('queued');
    expect(task.phase).toBe('implementation');
  });

  test('an explicit none on a re-queueable row records the revision and routes nothing', async () => {
    const key = await seedTask({ status: 'ready_for_human', context: PARK_CONTEXT });
    const applied = await amendTaskVerification(
      deps(),
      amendInput(key, [addRequirement('npm run lint')], { apply: true, requestedContinuation: 'none' }),
    );
    expect(applied.status).toBe('applied');
    expect(applied.revision.continuation).toBe('none');
    const task = await store.getTask(key);
    expect(task.status).toBe('ready_for_human');
    expect(task.phase).toBe('review');
    // Recorded only: the park state is owned by the park and stays untouched.
    expect(task.context.missingVerificationCommands).toEqual(['npm run e2e']);
  });

  test('one amendment covering several missing commands is one coherent handoff: a single re-queue', async () => {
    const body = issueBody(['npm run e2e', 'npm run typechek']);
    const key = await seedTask({
      status: 'ready_for_human',
      body,
      context: { missingVerificationCommands: ['npm run e2e', 'npm run typechek'] },
    });
    const applied = await amendTaskVerification(
      deps(),
      amendInput(
        key,
        [
          { kind: 'replace', commandId: REQ('npm run e2e'), command: 'npm test', reason: 'wrong command' },
          { kind: 'replace', commandId: REQ('npm run typechek'), command: 'npm run typecheck', reason: 'typo' },
        ],
        { apply: true },
      ),
    );
    expect(applied.status).toBe('applied');
    expect(applied.revision.operations).toHaveLength(2);
    const task = await store.getTask(key);
    expect(task.status).toBe('queued');
    expect(task.phase).toBe('review');
    expect(task.context.missingVerificationCommands).toBeUndefined();
    const events = await store.listEvents(key);
    expect(events.filter((event) => event.type === 'verification.amendment.applied')).toHaveLength(1);
  });

  test('crash-retry: rerunning a routed apply is a replay that re-queues nothing twice', async () => {
    const key = await seedTask({ status: 'ready_for_human', context: PARK_CONTEXT });
    const operations = [addRequirement('npm run lint')];
    const first = await amendTaskVerification(deps(), amendInput(key, operations, { apply: true }));
    expect(first.status).toBe('applied');
    const afterFirst = await store.getTask(key);
    expect(afterFirst.status).toBe('queued');

    const rerun = await amendTaskVerification(deps(), amendInput(key, operations, { apply: true }));
    expect(rerun.status).toBe('replay');
    expect(rerun.revision.revisionId).toBe(first.revision.revisionId);
    const task = await store.getTask(key);
    expect(task.revision).toBe(afterFirst.revision);
    expect(task.status).toBe('queued');
    expect(task.phase).toBe('review');
    expect((await store.listEvents(key)).filter((event) => event.type === 'verification.amendment.applied')).toHaveLength(1);
  });

  test('a failed (terminal) task refuses with the reactivation message and routes nothing', async () => {
    const key = await seedTask({ status: 'failed', context: PARK_CONTEXT });
    const outcome = await amendTaskVerification(
      deps(),
      amendInput(key, [addRequirement('npm run lint')], { apply: true }),
    );
    expect(outcome).toMatchObject({ status: 'refused', reason: 'task_terminal' });
    const task = await store.getTask(key);
    expect(task.status).toBe('failed');
    expect(task.context.missingVerificationCommands).toEqual(['npm run e2e']);
  });

  test('a routed reset takes the row default exactly as a hand-typed revision would', async () => {
    const key = await seedTask({ status: 'queued', context: {} });
    const amended = await amendTaskVerification(
      deps(),
      amendInput(key, [{ kind: 'replace', commandId: REQ('npm run e2e'), command: 'npm test', reason: 'typo' }], {
        apply: true,
      }),
    );
    expect(amended.status).toBe('applied');
    // Park it the way a review escalation would, then reset: the reset is an
    // ordinary revision, so the §9.2 default routes it back to review.
    await store.transitionTask(key, {}, { status: 'ready_for_human' });
    const result = await resetTaskVerification(deps(), {
      key,
      sessionVerification: SESSION_VERIFICATION,
      actorId: 'admin',
      reason: 'back to the baseline',
      apply: true,
    });
    expect(result.outcome.status).toBe('applied');
    expect(result.outcome.revision.continuation).toBe('review');
    const task = await store.getTask(key);
    expect(task.status).toBe('queued');
    expect(task.phase).toBe('review');
  });

  // Issue #1043 review: the surface passes the resolved session through to the
  // store write, which retracts the parked review's success-only stack-ready
  // marker and swaps the lane labels atomically with the re-queue.
  const ROUTING_SESSION = {
    sessionId: SESSION,
    repoKey: 'some-repo',
    repoRoot: '/tmp/nowhere',
    githubRepo: 'm2dw/some-repo',
    githubOwner: 'm2dw',
    githubName: 'some-repo',
    workItemProvider: { provider: 'github-issues' },
    defaults: { implementationAgent: 'claude', reviewAgent: 'codex' },
    labels: {
      active: 'ai:active',
      blocked: 'ai:blocked',
      readyForHuman: 'ai:ready-for-human',
      agentReview: 'agent:codex',
    },
  };

  test('a routed amend with the session retracts stack-ready and swaps lane labels with the re-queue', async () => {
    const key = await seedTask({ status: 'ready_for_human', context: PARK_CONTEXT });
    const applied = await amendTaskVerification(
      deps(),
      amendInput(key, [addRequirement('npm run lint')], { apply: true, session: ROUTING_SESSION }),
    );
    expect(applied.status).toBe('applied');
    const rows = store.listOutboxEffects().map((effect) => `${effect.topic} ${effect.payload.label}`);
    expect(rows).toContain('gh:label:remove status:stack-ready');
    expect(rows).toContain('gh:label:remove ai:ready-for-human');
    expect(rows).toContain('gh:label:add status:needs-review');
  });

  test('a recorded-only amendment enqueues no label effect — nothing moved, nothing to retract', async () => {
    const key = await seedTask({ status: 'queued', context: {} });
    const applied = await amendTaskVerification(
      deps(),
      amendInput(key, [addRequirement('npm run lint')], { apply: true, session: ROUTING_SESSION }),
    );
    expect(applied.status).toBe('applied');
    // Issue #1044 (§12.2): the applied revision still reports itself — one
    // work-item comment, which a `none` continuation does not suppress. What
    // a recorded-only amendment must not enqueue is a LABEL effect: the task
    // did not move, so there is no lane to swap and no park marker to retract.
    expect(store.listOutboxEffects().map((effect) => effect.topic)).toEqual(['gh:comment']);
  });
});

// Issue #1043 review (§8.3 rule 1): a `replace` invalidates the evidence its
// superseded bytes admitted in the same CAS. The byte mismatch alone only
// hides the old evidence — the evaluator matches by content, so restoring the
// old bytes later would re-admit the superseded pass without a rerun.
describe('requirement replace — evidence supersession through the surface', () => {
  test('restoring replaced bytes does not re-admit superseded evidence', async () => {
    const key = await seedTask({
      status: 'queued',
      context: {
        manualVerificationEvidence: [{ command: 'npm run e2e', exitCode: 0, source: 'operator_input' }],
      },
    });

    const replaced = await amendTaskVerification(
      deps(),
      amendInput(
        key,
        [{ kind: 'replace', commandId: REQ('npm run e2e'), command: 'npm run e2e -- --ci', reason: 'typo' }],
        { apply: true },
      ),
    );
    expect(replaced.status).toBe('applied');

    // The entry is preserved (§8.1), carrying the per-slot record naming the
    // revision that superseded it (§8.3 rule 1).
    const afterReplace = (await store.getTask(key)).context.manualVerificationEvidence;
    expect(afterReplace).toHaveLength(1);
    expect(afterReplace[0].invalidations).toEqual([
      { commandId: REQ('npm run e2e'), supersededByRevision: replaced.revision.revisionId },
    ]);

    const restored = await amendTaskVerification(
      deps(),
      amendInput(
        key,
        [{ kind: 'replace', commandId: REQ('npm run e2e'), command: 'npm run e2e', reason: 'undo' }],
        { apply: true },
      ),
    );
    expect(restored.status).toBe('applied');

    // The slot carries its original bytes again, but the invalidated entry
    // stays inadmissible for it: a fresh run is required, not a stale pass.
    const view = await describeTaskVerificationPlan(deps(), { key, sessionVerification: SESSION_VERIFICATION });
    expect(view.status).toBe('ok');
    const slot = view.view.requirementStatus.find((entry) => entry.commandId === REQ('npm run e2e'));
    expect(slot.command).toBe('npm run e2e');
    expect(slot.status).toBe('not_run');
  });
});
