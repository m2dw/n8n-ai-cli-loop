// Issue #1041 — refresh a task's verification requirements from the LIVE Issue
// (docs/verification-amendment-contract.md §10, §15 slice A6).
//
// Pins the §16 "Refresh (§10)" row: requirement-layer operations only, no
// `replace` ever, one-to-one matching by effective bytes before identity,
// restore-not-add for a retired slot, withheld-but-reported retirements,
// fail-closed provider/body handling, the recorded `issueBodyDigest`, and the
// no-difference no-op. Plus the §5.3 rule 1–2 derivations this slice adds and
// the concurrent-Issue-edit guard between preview and apply.
import {
  MemoryTaskStore,
  amendTaskVerification,
  refreshIssueVerification,
  diffIssueVerificationRefresh,
  verificationRefreshOperations,
  verificationOperationsIdentityForm,
  deriveVerificationRevisionId,
  deriveVerificationRequestKey,
  deriveIssueBodyDigest,
  defaultVerificationContinuation,
  resolveEffectiveVerificationPlan,
  deriveRequirementCommandId,
  deriveSessionBaselineDigest,
  VERIFICATION_AMENDMENTS_CONTEXT_KEY,
  VERIFICATION_AMENDMENT_APPLIED_EVENT,
} from '../dist/index.js';
import { extractIssueVerificationSections } from '../dist/handlers/issue-verification-extractor.js';

const SESSION = 'sess-refresh';
const SESSION_VERIFICATION = { test: 'npm test' };
const REQ = (command) => deriveRequirementCommandId(command);

let issueCounter = 0;

/** An Issue body whose Verification section lists exactly `commands`. */
function issueBody(commands, extra = '') {
  return [
    '## Background',
    'Some background prose that mentions `npm run irrelevant` outside any section.',
    '',
    '## Verification',
    ...commands.map((command) => `- \`${command}\``),
    extra,
  ].join('\n');
}

function sourceFor(body) {
  return { readIssue: async (number) => ({ number, body }) };
}

async function seedTask(store, options = {}) {
  const issueNumber = (issueCounter += 1);
  const key = { sessionId: SESSION, issueNumber };
  const enqueued = await store.enqueueTask({
    sessionId: SESSION,
    issueNumber,
    phase: options.phase ?? 'review',
    context: {
      body: options.body ?? issueBody(['npm test']),
      title: 'a task whose scope must not move',
      ...(options.context ?? {}),
    },
  });
  expect(enqueued.ok).toBe(true);
  if (options.status && options.status !== 'queued') {
    const moved = await store.transitionTask(key, {}, { status: options.status });
    expect(moved.ok).toBe(true);
  }
  return key;
}

/** The §12.1 amendment events on a task, ignoring the store's own lifecycle ones. */
async function amendmentEvents(store, key) {
  const events = await store.listEvents(key);
  return events.filter((event) => String(event.type).startsWith('verification.amendment.'));
}

function refreshDeps(store, body) {
  return { store, source: sourceFor(body), extract: extractIssueVerificationSections };
}

function refreshInput(key, overrides = {}) {
  return {
    key,
    sessionVerification: SESSION_VERIFICATION,
    actorId: 'admin',
    reason: 'the Issue verification section was corrected after intake',
    ...overrides,
  };
}

/** The §11 `amend` surface, used to move a task's plan out from under a refresh. */
function amendDeps(store) {
  return { store, extract: extractIssueVerificationSections };
}

function amendFor(key, operations) {
  return {
    key,
    sessionVerification: SESSION_VERIFICATION,
    actorId: 'admin',
    reason: 'an operator correction this refresh did not make',
    operations,
    apply: true,
  };
}

/** The plan a task's pinned body + session map resolve to, with no amendments. */
function planFor(body, amendments) {
  const resolved = resolveEffectiveVerificationPlan({
    sessionVerification: SESSION_VERIFICATION,
    issueRequirements: extractIssueVerificationSections(body).commands,
    ...(amendments ? { amendments } : {}),
  });
  expect(resolved.status).toBe('resolved');
  return resolved.plan;
}

describe('§10 rule 3 — the matcher', () => {
  test('a live command an active slot already carries produces no operation', () => {
    const plan = planFor(issueBody(['npm test', 'npm run e2e']));
    const result = diffIssueVerificationRefresh({ plan, liveCommands: ['npm test', 'npm run e2e'] });
    expect(result.status).toBe('ok');
    expect(result.diff.unchanged.map((entry) => entry.commandId)).toEqual([
      REQ('npm test'),
      REQ('npm run e2e'),
    ]);
    expect(result.diff.adds).toEqual([]);
    expect(result.diff.restores).toEqual([]);
    expect(result.diff.proposedRetirements).toEqual([]);
  });

  test('after a `replace`, a live Issue naming the NEW bytes matches the slot and proposes nothing', () => {
    // The duplicate-and-retire failure §10 rule 3 case 1 exists to prevent:
    // the slot keeps A's commandId while carrying B's bytes.
    const slotId = REQ('npm run e2e');
    const plan = planFor(issueBody(['npm test', 'npm run e2e']), {
      revisions: [
        {
          revisionId: 'vamd-0000000000000001',
          revisionOrdinal: 1,
          requestKey: 'k1',
          scope: 'task',
          source: 'admin-cli',
          actor: { kind: 'operator', id: 'admin' },
          reason: 'the Issue named the wrong script',
          operations: [
            { kind: 'replace', commandId: slotId, command: 'npm run e2e:ci', reason: 'corrected' },
          ],
          basePlanDigest: 'a'.repeat(64),
          planDigest: 'b'.repeat(64),
          sessionBaselineDigest: deriveSessionBaselineDigest([{ name: 'test', command: 'npm test' }]),
          continuation: 'none',
          createdAt: '2026-09-02T00:00:00.000Z',
          observedTaskRevision: 0,
        },
      ],
      checkpoint: {
        planDigest: 'b'.repeat(64),
        sessionBaseline: [{ name: 'test', command: 'npm test' }],
        sessionBaselineDigest: deriveSessionBaselineDigest([{ name: 'test', command: 'npm test' }]),
        appliedThroughOrdinal: 1,
        updatedAt: '2026-09-02T00:00:00.000Z',
        updatedBy: 'revision',
      },
    });

    const result = diffIssueVerificationRefresh({
      plan,
      liveCommands: ['npm test', 'npm run e2e:ci'],
    });
    expect(result.status).toBe('ok');
    expect(result.diff.unchanged.map((entry) => entry.commandId)).toContain(slotId);
    expect(result.diff.adds).toEqual([]);
    expect(result.diff.proposedRetirements).toEqual([]);
  });

  test('an equivalent shell-wrapped live command matches the slot rather than duplicating it', () => {
    const plan = planFor(issueBody(['npm test']));
    const result = diffIssueVerificationRefresh({ plan, liveCommands: ["bash -lc 'npm test'"] });
    expect(result.status).toBe('ok');
    expect(result.diff.adds).toEqual([]);
    expect(result.diff.unchanged).toHaveLength(1);
  });

  test('matching is one-to-one: each live command consumes at most one slot', () => {
    const plan = planFor(issueBody(['npm test', 'npm run e2e']));
    const result = diffIssueVerificationRefresh({
      plan,
      liveCommands: ["bash -lc 'npm test'", 'npm run e2e'],
    });
    expect(result.status).toBe('ok');
    expect(result.diff.unchanged.map((entry) => entry.commandId)).toEqual([
      REQ('npm test'),
      REQ('npm run e2e'),
    ]);
    expect(result.diff.adds).toEqual([]);
    expect(result.diff.proposedRetirements).toEqual([]);
  });

  test('a live command matching a retired slot becomes a restore, not an add', () => {
    const plan = planFor(issueBody(['npm test']));
    const retired = {
      ...plan,
      requirement: plan.requirement.map((slot) => ({ ...slot, state: 'retired' })),
    };
    const result = diffIssueVerificationRefresh({ plan: retired, liveCommands: ['npm test'] });
    expect(result.status).toBe('ok');
    expect(result.diff.adds).toEqual([]);
    expect(result.diff.restores).toEqual([
      {
        commandId: REQ('npm test'),
        liveCommand: 'npm test',
        reinstatedCommand: 'npm test',
        matchedBy: 'bytes',
        reinstatedBytesDiffer: false,
      },
    ]);
  });

  test('a retired slot matched by IDENTITY reinstates its corrected bytes and reports the difference', () => {
    const plan = planFor(issueBody(['npm run e2e']));
    // The slot keeps the identity of the original bytes while carrying the
    // corrected ones, then was retired.
    const retired = {
      ...plan,
      requirement: plan.requirement.map((slot) => ({
        ...slot,
        state: 'retired',
        command: 'npm run e2e:ci',
      })),
    };
    const result = diffIssueVerificationRefresh({ plan: retired, liveCommands: ['npm run e2e'] });
    expect(result.status).toBe('ok');
    expect(result.diff.restores).toEqual([
      {
        commandId: REQ('npm run e2e'),
        liveCommand: 'npm run e2e',
        reinstatedCommand: 'npm run e2e:ci',
        matchedBy: 'identity',
        reinstatedBytesDiffer: true,
      },
    ]);
    // Still no `replace` — §10 rule 3 reports the difference and emits none.
    const operations = verificationRefreshOperations(result.diff, { reason: 'r', allowRetire: true });
    expect(operations.every((operation) => operation.kind !== 'replace')).toBe(true);
  });

  test('an unmatched active slot is a proposed retirement; an unmatched retired slot produces nothing', () => {
    const plan = planFor(issueBody(['npm test', 'npm run e2e']));
    const mixed = {
      ...plan,
      requirement: [
        plan.requirement[0],
        { ...plan.requirement[1], state: 'retired' },
      ],
    };
    const result = diffIssueVerificationRefresh({ plan: mixed, liveCommands: [] });
    expect(result.status).toBe('ok');
    expect(result.diff.proposedRetirements).toEqual([
      { commandId: REQ('npm test'), command: 'npm test' },
    ]);
  });

  test('execution-layer slots are never touched by a refresh', () => {
    const plan = planFor(issueBody(['npm test']));
    expect(plan.execution).toHaveLength(1);
    const result = diffIssueVerificationRefresh({ plan, liveCommands: [] });
    const operations = verificationRefreshOperations(result.diff, { reason: 'r', allowRetire: true });
    expect(operations.every((operation) => operation.layer !== 'execution')).toBe(true);
    expect(operations.every((operation) => !String(operation.commandId ?? '').startsWith('exec:'))).toBe(true);
  });

  test('a diff the rules cannot map refuses rather than authoring a colliding add', () => {
    const plan = planFor(issueBody(['npm test']));
    const result = diffIssueVerificationRefresh({
      plan,
      liveCommands: ["bash -lc 'npm test'", 'npm test'],
    });
    expect(result.status).toBe('ambiguous');
    expect(result.detail).toContain(REQ('npm test'));
  });
});

describe('§5.3 rules 1–2 — the derivations', () => {
  const operations = [
    { kind: 'add', layer: 'requirement', command: 'npm run e2e', reason: 'the Issue now requires it' },
  ];

  test('the identity form omits every operation reason and nothing else', () => {
    expect(verificationOperationsIdentityForm(operations)).toEqual([
      { kind: 'add', layer: 'requirement', command: 'npm run e2e' },
    ]);
  });

  test('revisionId is "vamd-" + 16 hex and is blind to the reason wording', () => {
    const base = { sessionId: SESSION, issueNumber: 7, requestKey: 'k', basePlanDigest: 'a'.repeat(64) };
    const a = deriveVerificationRevisionId({ ...base, operations });
    const b = deriveVerificationRevisionId({
      ...base,
      operations: [{ ...operations[0], reason: 'entirely different wording' }],
    });
    expect(a).toMatch(/^vamd-[0-9a-f]{16}$/);
    expect(a).toBe(b);
  });

  test('revisionId changes with the base plan; the derived requestKey does not', () => {
    const operationsInput = { sessionId: SESSION, issueNumber: 7, requestKey: 'k', operations };
    expect(
      deriveVerificationRevisionId({ ...operationsInput, basePlanDigest: 'a'.repeat(64) }),
    ).not.toBe(deriveVerificationRevisionId({ ...operationsInput, basePlanDigest: 'c'.repeat(64) }));

    const key = deriveVerificationRequestKey({
      sessionId: SESSION,
      issueNumber: 7,
      source: 'issue-refresh',
      requestedContinuation: null,
      operations,
    });
    expect(key).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/);
    expect(key).toBe(
      deriveVerificationRequestKey({
        sessionId: SESSION,
        issueNumber: 7,
        source: 'issue-refresh',
        requestedContinuation: null,
        operations: [{ ...operations[0], reason: 'reworded on the retry' }],
      }),
    );
  });

  test('the §9.2 default is review only on a re-queueable row', () => {
    expect(defaultVerificationContinuation({ status: 'ready_for_human', phase: 'review' })).toBe('review');
    expect(defaultVerificationContinuation({ status: 'blocked', phase: 'review' })).toBe('review');
    expect(defaultVerificationContinuation({ status: 'ready_for_human', phase: 'implementation' })).toBe('none');
    expect(defaultVerificationContinuation({ status: 'queued', phase: 'review' })).toBe('none');
  });
});

describe('refreshIssueVerification — preview and apply', () => {
  let store;

  beforeEach(() => {
    store = new MemoryTaskStore();
  });

  test('previews the difference and writes nothing without apply', async () => {
    const pinned = issueBody(['npm test']);
    const key = await seedTask(store, { body: pinned, status: 'ready_for_human' });
    const live = issueBody(['npm test', 'npm run e2e']);

    const outcome = await refreshIssueVerification(refreshDeps(store, live), refreshInput(key));
    expect(outcome.status).toBe('preview');
    expect(outcome.report.diff.adds).toEqual([
      { commandId: REQ('npm run e2e'), command: 'npm run e2e' },
    ]);
    expect(outcome.report.issueBodyDigest).toBe(deriveIssueBodyDigest(live));
    expect(outcome.report.defaultContinuation).toBe('review');
    // Issue #1043: the row default is the route an apply would take.
    expect(outcome.report.continuation).toBe('review');

    const task = await store.getTask(key);
    expect(task.context[VERIFICATION_AMENDMENTS_CONTEXT_KEY]).toBeUndefined();
    expect(await amendmentEvents(store, key)).toEqual([]);
  });

  test('applies the addition as one issue-refresh revision that pins the read', async () => {
    const pinned = issueBody(['npm test']);
    const key = await seedTask(store, { body: pinned, status: 'ready_for_human' });
    const live = issueBody(['npm test', 'npm run e2e']);

    const outcome = await refreshIssueVerification(
      refreshDeps(store, live),
      refreshInput(key, { apply: true }),
    );
    expect(outcome.status).toBe('applied');
    expect(outcome.revision.source).toBe('issue-refresh');
    expect(outcome.revision.scope).toBe('task');
    expect(outcome.revision.issueBodyDigest).toBe(deriveIssueBodyDigest(live));
    expect(outcome.revision.revisionOrdinal).toBe(1);
    expect(outcome.revision.operations).toEqual([
      { kind: 'add', layer: 'requirement', command: 'npm run e2e', reason: outcome.revision.reason },
    ]);
    // Issue #1043: a refresh on a review-lane park takes the §9.2 default and
    // re-queues {queued, review} in the same transaction as the plan persist.
    expect(outcome.revision.continuation).toBe('review');
    expect(outcome.task.status).toBe('queued');
    expect(outcome.task.phase).toBe('review');

    const task = await store.getTask(key);
    // §10 rule 1: the intake snapshot and every scope field are untouched;
    // only the §9.2 re-queue moved the row.
    expect(task.context.body).toBe(pinned);
    expect(task.context.title).toBe('a task whose scope must not move');
    expect(task.status).toBe('queued');
    expect(task.phase).toBe('review');

    // The amended plan now carries both requirements.
    const amended = resolveEffectiveVerificationPlan({
      sessionVerification: SESSION_VERIFICATION,
      issueRequirements: extractIssueVerificationSections(task.context.body).commands,
      amendments: task.context[VERIFICATION_AMENDMENTS_CONTEXT_KEY],
    });
    expect(amended.status).toBe('resolved');
    expect(amended.plan.requirement.map((slot) => slot.command)).toEqual(['npm test', 'npm run e2e']);

    const applied = (await amendmentEvents(store, key)).filter(
      (event) => event.type === VERIFICATION_AMENDMENT_APPLIED_EVENT,
    );
    expect(applied).toHaveLength(1);
    expect(applied[0].data.source).toBe('issue-refresh');
    expect(JSON.stringify(applied[0].data)).not.toContain('npm run e2e');
  });

  test('a rerun after a lost response is a REPLAY of the stored revision, not a bare no-op', async () => {
    const key = await seedTask(store, { body: issueBody(['npm test']), status: 'ready_for_human' });
    const live = issueBody(['npm test', 'npm run e2e']);
    const first = await refreshIssueVerification(
      refreshDeps(store, live),
      refreshInput(key, { apply: true }),
    );
    expect(first.status).toBe('applied');
    const eventsAfterFirst = await amendmentEvents(store, key);

    // The operator's `--yes` committed and the response was lost, so they rerun
    // the same command line. The diff is taken against the EFFECTIVE plan, which
    // now carries what the first attempt added, so the rerun has nothing to
    // apply — and §5.3 rules 1/3 say what it gets back is the stored revision,
    // not an answer indistinguishable from a refresh that never applied
    // anything. The refresh derives its key from the operations its own read
    // produced, so this rerun cannot re-derive it; it recognizes its own first
    // attempt by the pinned body digest and that revision's derived key.
    const second = await refreshIssueVerification(
      refreshDeps(store, live),
      refreshInput(key, { apply: true }),
    );
    expect(second.status).toBe('replay');
    expect(second.revision.revisionId).toBe(first.revision.revisionId);
    expect(second.revision.revisionOrdinal).toBe(1);
    expect(second.revision.requestKey).toBe(first.revision.requestKey);
    expect(second.checkpoint.planDigest).toBe(first.checkpoint.planDigest);

    // A replay writes nothing: no second revision, no ordinal, no event.
    const task = await store.getTask(key);
    expect(task.context[VERIFICATION_AMENDMENTS_CONTEXT_KEY].revisions).toHaveLength(1);
    expect(await amendmentEvents(store, key)).toEqual(eventsAfterFirst);
  });

  test('a keyless rerun replays even after a worker claimed the re-queued task (issue #1043 review, P2)', async () => {
    const key = await seedTask(store, { body: issueBody(['npm test']), status: 'ready_for_human' });
    const live = issueBody(['npm test', 'npm run e2e']);
    const first = await refreshIssueVerification(refreshDeps(store, live), refreshInput(key, { apply: true }));
    expect(first.status).toBe('applied');
    const eventsAfterFirst = await amendmentEvents(store, key);

    // The §9.2 re-queue makes the task claimable, so a worker can own it
    // before the operator's lost-response retry arrives. The retry derives no
    // key the supplied-key lookup could match; without derived recognition
    // ahead of the guard it would fall through to the §7.1 task_active
    // refusal — reporting an applied request as refused.
    const claimed = await store.transitionTask(key, {}, { status: 'claimed', ownerRunId: 'run-42' });
    expect(claimed.ok).toBe(true);

    const second = await refreshIssueVerification(refreshDeps(store, live), refreshInput(key, { apply: true }));
    expect(second.status).toBe('replay');
    expect(second.revision.revisionId).toBe(first.revision.revisionId);
    expect(second.revision.requestKey).toBe(first.revision.requestKey);

    // Recognition is a read: nothing written, the worker's claim untouched.
    const task = await store.getTask(key);
    expect(task.status).toBe('claimed');
    expect(task.ownerRunId).toBe('run-42');
    expect(task.context[VERIFICATION_AMENDMENTS_CONTEXT_KEY].revisions).toHaveLength(1);
    expect(await amendmentEvents(store, key)).toEqual(eventsAfterFirst);
  });

  test('a keyless rerun that still has something to apply refuses task_active, not replay (issue #1043 review, P2)', async () => {
    // The stored revision's body digest and its own derived key match ANY
    // later keyless refresh of the unchanged body — including one whose
    // operation set differs. Only an invocation with nothing left to apply is
    // the lost-response repeat; this one still carries the retirement the
    // first refresh withheld.
    const key = await seedTask(store, {
      body: issueBody(['npm test', 'npm run lint']),
      status: 'ready_for_human',
    });
    const live = issueBody(['npm test', 'npm run e2e']);
    const first = await refreshIssueVerification(refreshDeps(store, live), refreshInput(key, { apply: true }));
    expect(first.status).toBe('applied');
    expect(first.revision.operations.map((operation) => operation.kind)).toEqual(['add']);
    expect(first.report.withheldRetirements.map((entry) => entry.command)).toEqual(['npm run lint']);

    const claimed = await store.transitionTask(key, {}, { status: 'claimed', ownerRunId: 'run-42' });
    expect(claimed.ok).toBe(true);

    // With --allow-retire this is a NEW request over a distinct operation set
    // — the retirement of `npm run lint` — that the first refresh never
    // applied. Reporting the stored revision as a replay would swallow it.
    const retiring = await refreshIssueVerification(
      refreshDeps(store, live),
      refreshInput(key, { apply: true, allowRetire: true }),
    );
    expect(retiring.status).toBe('refused');
    expect(retiring.reason).toBe('task_active');

    // Without the opt-in the pending retirement is still the §10 rule 4
    // difference the replay shape has nowhere to report, mirroring the main
    // path's suppression on the empty diff: the refusal stays the answer.
    const withheld = await refreshIssueVerification(refreshDeps(store, live), refreshInput(key, { apply: true }));
    expect(withheld.status).toBe('refused');
    expect(withheld.reason).toBe('task_active');

    // Nothing written on either path: the claim and the single stored
    // revision are untouched.
    const task = await store.getTask(key);
    expect(task.status).toBe('claimed');
    expect(task.ownerRunId).toBe('run-42');
    expect(task.context[VERIFICATION_AMENDMENTS_CONTEXT_KEY].revisions).toHaveLength(1);
  });

  test('a keyless retry against a claimed task falls back to task_active when the live read fails', async () => {
    const key = await seedTask(store, { body: issueBody(['npm test']), status: 'ready_for_human' });
    const live = issueBody(['npm test', 'npm run e2e']);
    const first = await refreshIssueVerification(refreshDeps(store, live), refreshInput(key, { apply: true }));
    expect(first.status).toBe('applied');
    const claimed = await store.transitionTask(key, {}, { status: 'claimed', ownerRunId: 'run-42' });
    expect(claimed.ok).toBe(true);

    // The refusal is decidable without the provider, so a failed recognition
    // read degrades to it rather than surfacing a provider error.
    const outcome = await refreshIssueVerification(
      {
        store,
        source: { readIssue: async () => { throw new Error('boom: transient 500'); } },
        extract: extractIssueVerificationSections,
      },
      refreshInput(key, { apply: true }),
    );
    expect(outcome.status).toBe('refused');
    expect(outcome.reason).toBe('task_active');
  });

  test('a supplied --request-key replays before the plan and the §7.1 status are even read', async () => {
    // §5.3 rule 1: the chain lookup precedes every plan comparison and the
    // status table. An operator-supplied token is caller-stable by
    // construction, so the retry is a replay however far the task and the Issue
    // moved since — and the provider is never touched.
    const key = await seedTask(store, { body: issueBody(['npm test']), status: 'ready_for_human' });
    const applied = await refreshIssueVerification(
      refreshDeps(store, issueBody(['npm test', 'npm run e2e'])),
      refreshInput(key, { apply: true, requestKey: 'ops-2026-09-03.1' }),
    );
    expect(applied.status).toBe('applied');
    expect(applied.revision.requestKey).toBe('ops-2026-09-03.1');

    const claimed = await store.transitionTask(key, {}, { status: 'claimed', ownerRunId: 'run-7' });
    expect(claimed.ok).toBe(true);

    const retried = await refreshIssueVerification(
      {
        store,
        source: { readIssue: async () => { throw new Error('must not be reached'); } },
        extract: extractIssueVerificationSections,
      },
      refreshInput(key, { apply: true, requestKey: 'ops-2026-09-03.1' }),
    );
    expect(retried.status).toBe('replay');
    expect(retried.revision.revisionId).toBe(applied.revision.revisionId);
    expect((await store.getTask(key)).context[VERIFICATION_AMENDMENTS_CONTEXT_KEY].revisions).toHaveLength(1);
  });

  test('a DISTINCT --request-key on an empty diff stays a no-op, not a false replay', async () => {
    // §5.3 rule 3: supplying a distinct token is how an operator asks for a
    // second application, so it is never matched against another key's
    // revision. There is simply nothing left to apply.
    const key = await seedTask(store, { body: issueBody(['npm test']), status: 'ready_for_human' });
    const live = issueBody(['npm test', 'npm run e2e']);
    const first = await refreshIssueVerification(
      refreshDeps(store, live),
      refreshInput(key, { apply: true }),
    );
    expect(first.status).toBe('applied');

    const second = await refreshIssueVerification(
      refreshDeps(store, live),
      refreshInput(key, { apply: true, requestKey: 'a-deliberately-new-token' }),
    );
    expect(second.status).toBe('no_change');
    expect((await store.getTask(key)).context[VERIFICATION_AMENDMENTS_CONTEXT_KEY].revisions).toHaveLength(1);
  });

  test('a rerun still holding a withheld retirement reports it rather than replaying', async () => {
    // §10 rule 4 outranks the replay convenience here: the rerun carries a
    // difference `--allow-retire` would apply, so it is not merely a repeat and
    // the withheld retirement must stay in the output — which the replay shape
    // has nowhere to put.
    const key = await seedTask(store, {
      body: issueBody(['npm test', 'npm run e2e']),
      status: 'ready_for_human',
    });
    const live = issueBody(['npm test', 'npm run lint']);
    const first = await refreshIssueVerification(
      refreshDeps(store, live),
      refreshInput(key, { apply: true }),
    );
    expect(first.status).toBe('applied');
    expect(first.revision.operations).toEqual([
      { kind: 'add', layer: 'requirement', command: 'npm run lint', reason: first.revision.reason },
    ]);
    expect(first.report.withheldRetirements.map((entry) => entry.commandId)).toEqual([REQ('npm run e2e')]);

    const second = await refreshIssueVerification(
      refreshDeps(store, live),
      refreshInput(key, { apply: true }),
    );
    expect(second.status).toBe('no_change');
    expect(second.withheldRetirements.map((entry) => entry.commandId)).toEqual([REQ('npm run e2e')]);
    expect((await store.getTask(key)).context[VERIFICATION_AMENDMENTS_CONTEXT_KEY].revisions).toHaveLength(1);

    // And the opt-in still applies it as its own revision.
    const retired = await refreshIssueVerification(
      refreshDeps(store, live),
      refreshInput(key, { apply: true, allowRetire: true }),
    );
    expect(retired.status).toBe('applied');
    expect(retired.revision.operations).toEqual([
      { kind: 'retire', commandId: REQ('npm run e2e'), reason: retired.revision.reason },
    ]);
  });

  test('a PREVIEW after the applied refresh still shows the diff rather than a replay', async () => {
    // §11 rules 1 and 5: a preview writes nothing on any path, so the empty
    // diff it exists to show stays more useful than a repeat notice.
    const key = await seedTask(store, { body: issueBody(['npm test']), status: 'ready_for_human' });
    const live = issueBody(['npm test', 'npm run e2e']);
    expect(
      (await refreshIssueVerification(refreshDeps(store, live), refreshInput(key, { apply: true }))).status,
    ).toBe('applied');

    const preview = await refreshIssueVerification(refreshDeps(store, live), refreshInput(key));
    expect(preview.status).toBe('no_change');
    expect(preview.diff.adds).toEqual([]);
    expect(preview.diff.unchanged.map((entry) => entry.commandId)).toContain(REQ('npm run e2e'));
  });

  test('a refresh of a DIFFERENT live body after an applied one is never read as its replay', async () => {
    const key = await seedTask(store, { body: issueBody(['npm test']), status: 'ready_for_human' });
    const first = await refreshIssueVerification(
      refreshDeps(store, issueBody(['npm test', 'npm run e2e'])),
      refreshInput(key, { apply: true }),
    );
    expect(first.status).toBe('applied');

    // The Issue moved on: a second, real difference applies as its own revision.
    const second = await refreshIssueVerification(
      refreshDeps(store, issueBody(['npm test', 'npm run e2e', 'npm run lint'])),
      refreshInput(key, { apply: true }),
    );
    expect(second.status).toBe('applied');
    expect(second.revision.revisionOrdinal).toBe(2);
    expect(second.revision.operations).toEqual([
      { kind: 'add', layer: 'requirement', command: 'npm run lint', reason: second.revision.reason },
    ]);
  });

  test('a no-difference refresh is a no-op: no revision, no ordinal, no event', async () => {
    const body = issueBody(['npm test']);
    const key = await seedTask(store, { body, status: 'ready_for_human' });
    const outcome = await refreshIssueVerification(
      refreshDeps(store, body),
      refreshInput(key, { apply: true }),
    );
    expect(outcome.status).toBe('no_change');
    expect(outcome.withheldRetirements).toEqual([]);
    const task = await store.getTask(key);
    expect(task.context[VERIFICATION_AMENDMENTS_CONTEXT_KEY]).toBeUndefined();
    expect(await amendmentEvents(store, key)).toEqual([]);
  });

  test('a retirement is withheld and still reported without the opt-in, and applies with it', async () => {
    const pinned = issueBody(['npm test', 'npm run e2e']);
    const live = issueBody(['npm test']);
    const withheldKey = await seedTask(store, { body: pinned, status: 'ready_for_human' });

    const withheld = await refreshIssueVerification(
      refreshDeps(store, live),
      refreshInput(withheldKey, { apply: true }),
    );
    expect(withheld.status).toBe('no_change');
    expect(withheld.withheldRetirements.map((entry) => entry.commandId)).toEqual([REQ('npm run e2e')]);
    expect((await store.getTask(withheldKey)).context[VERIFICATION_AMENDMENTS_CONTEXT_KEY]).toBeUndefined();

    const allowedKey = await seedTask(store, { body: pinned, status: 'ready_for_human' });
    const allowed = await refreshIssueVerification(
      refreshDeps(store, live),
      refreshInput(allowedKey, { apply: true, allowRetire: true }),
    );
    expect(allowed.status).toBe('applied');
    expect(allowed.revision.operations).toEqual([
      { kind: 'retire', commandId: REQ('npm run e2e'), reason: allowed.revision.reason },
    ]);
  });

  test('a restore applies without the retire opt-in', async () => {
    const pinned = issueBody(['npm test', 'npm run e2e']);
    const key = await seedTask(store, { body: pinned, status: 'ready_for_human' });
    // Retire the second requirement through a refresh, then let the Issue ask
    // for it again: the slot comes back rather than being duplicated.
    const retired = await refreshIssueVerification(
      refreshDeps(store, issueBody(['npm test'])),
      refreshInput(key, { apply: true, allowRetire: true }),
    );
    expect(retired.status).toBe('applied');

    const restored = await refreshIssueVerification(
      refreshDeps(store, pinned),
      refreshInput(key, { apply: true }),
    );
    expect(restored.status).toBe('applied');
    expect(restored.revision.operations).toEqual([
      { kind: 'restore', commandId: REQ('npm run e2e'), reason: restored.revision.reason },
    ]);
    expect(restored.revision.revisionOrdinal).toBe(2);
  });

  test('a non-verification Issue edit changes nothing', async () => {
    const pinned = issueBody(['npm test']);
    const key = await seedTask(store, { body: pinned, status: 'ready_for_human' });
    const edited = `${issueBody(['npm test'])}\n\n## Notes\nA whole new paragraph of scope prose and \`npm run something-else\`.`;
    const outcome = await refreshIssueVerification(
      refreshDeps(store, edited),
      refreshInput(key, { apply: true }),
    );
    expect(outcome.status).toBe('no_change');
    expect((await store.getTask(key)).context.body).toBe(pinned);
  });
});

describe('refreshIssueVerification — fail-closed outcomes', () => {
  let store;

  beforeEach(() => {
    store = new MemoryTaskStore();
  });

  test('an unsupported provider refuses before any read', async () => {
    const key = await seedTask(store, { status: 'ready_for_human' });
    const outcome = await refreshIssueVerification(
      { store, source: undefined, extract: extractIssueVerificationSections },
      refreshInput(key, { apply: true, providerKind: 'gitea-issues' }),
    );
    expect(outcome.status).toBe('refused');
    expect(outcome.reason).toBe('unsupported_provider');
    expect(outcome.detail).toContain('gitea-issues');
  });

  test('a provider failure refuses whole and is never read as "requires nothing"', async () => {
    const key = await seedTask(store, { body: issueBody(['npm test']), status: 'ready_for_human' });
    const outcome = await refreshIssueVerification(
      {
        store,
        source: { readIssue: async () => { throw new Error('gh issue view failed (exit 1): timeout'); } },
        extract: extractIssueVerificationSections,
      },
      refreshInput(key, { apply: true }),
    );
    expect(outcome.status).toBe('refused');
    expect(outcome.reason).toBe('provider_error');
    expect((await store.getTask(key)).context[VERIFICATION_AMENDMENTS_CONTEXT_KEY]).toBeUndefined();
  });

  test('a missing Issue refuses with its own reason', async () => {
    const key = await seedTask(store, { status: 'ready_for_human' });
    const outcome = await refreshIssueVerification(
      {
        store,
        source: { readIssue: async () => { throw new Error('Could not resolve to an Issue with the number of 9999.'); } },
        extract: extractIssueVerificationSections,
      },
      refreshInput(key, { apply: true }),
    );
    expect(outcome.status).toBe('refused');
    expect(outcome.reason).toBe('issue_not_found');
  });

  test('a body with no supported verification section refuses instead of retiring everything', async () => {
    const key = await seedTask(store, { body: issueBody(['npm test']), status: 'ready_for_human' });
    const outcome = await refreshIssueVerification(
      refreshDeps(store, '## Background\nThe section was renamed away.'),
      refreshInput(key, { apply: true, allowRetire: true }),
    );
    expect(outcome.status).toBe('refused');
    expect(outcome.reason).toBe('missing_section');
    expect((await store.getTask(key)).context[VERIFICATION_AMENDMENTS_CONTEXT_KEY]).toBeUndefined();
  });

  test('a section that lists nothing is a legitimate removal, not a missing section', async () => {
    const key = await seedTask(store, { body: issueBody(['npm test']), status: 'ready_for_human' });
    const outcome = await refreshIssueVerification(
      refreshDeps(store, '## Verification\nNothing is required for this change.'),
      refreshInput(key, { apply: true, allowRetire: true }),
    );
    expect(outcome.status).toBe('applied');
    expect(outcome.revision.operations.map((operation) => operation.kind)).toEqual(['retire']);
  });

  test('a body that moved since the preview refuses stale without mutation', async () => {
    const pinned = issueBody(['npm test']);
    const key = await seedTask(store, { body: pinned, status: 'ready_for_human' });
    const live = issueBody(['npm test', 'npm run e2e']);
    const preview = await refreshIssueVerification(refreshDeps(store, live), refreshInput(key));
    expect(preview.status).toBe('preview');

    const moved = issueBody(['npm test', 'npm run e2e', 'npm run lint']);
    const outcome = await refreshIssueVerification(
      refreshDeps(store, moved),
      refreshInput(key, { apply: true, expectedIssueBodyDigest: preview.report.issueBodyDigest }),
    );
    expect(outcome.status).toBe('refused');
    expect(outcome.reason).toBe('stale_preview');
    expect((await store.getTask(key)).context[VERIFICATION_AMENDMENTS_CONTEXT_KEY]).toBeUndefined();

    // The same digest guard passes when the body did not move.
    const unchanged = await refreshIssueVerification(
      refreshDeps(store, live),
      refreshInput(key, { apply: true, expectedIssueBodyDigest: preview.report.issueBodyDigest }),
    );
    expect(unchanged.status).toBe('applied');
  });

  // Issue #1044 review (P2): the derived-replay lookup matches ANY earlier
  // keyless refresh of this same body, so a HISTORICAL one must not be allowed
  // to answer a guard it was never applied under. Otherwise the apply exits zero
  // reporting that older revision's ordinal, for a plan the operator never saw
  // and that revision was never applied to.
  test('an unrelated earlier refresh does not replay past the plan guard', async () => {
    const key = await seedTask(store, { body: issueBody(['npm test']), status: 'ready_for_human' });
    const live = issueBody(['npm test', 'npm run e2e']);

    // Refresh B: the earlier, unrelated apply whose body digest keeps matching.
    const applied = await refreshIssueVerification(
      refreshDeps(store, live),
      refreshInput(key, { apply: true }),
    );
    expect(applied.status).toBe('applied');

    // A task-local requirement the live Issue does not name, so the next
    // refresh proposes retiring it.
    const added = await amendTaskVerification(amendDeps(store), amendFor(key, [
      { kind: 'add', layer: 'requirement', command: 'npm run lint', reason: 'the lint gate is required too' },
    ]));
    expect(added.status).toBe('applied');

    const preview = await refreshIssueVerification(
      refreshDeps(store, live),
      refreshInput(key, { allowRetire: true }),
    );
    expect(preview.status).toBe('preview');
    expect(preview.report.operations.map((operation) => operation.kind)).toEqual(['retire']);

    // Someone else retires it first: the refresh now has nothing left to do,
    // against a plan digest the operator never previewed.
    const retired = await amendTaskVerification(amendDeps(store), amendFor(key, [
      { kind: 'retire', commandId: REQ('npm run lint'), reason: 'retired here instead' },
    ]));
    expect(retired.status).toBe('applied');

    const outcome = await refreshIssueVerification(
      refreshDeps(store, live),
      refreshInput(key, {
        apply: true,
        allowRetire: true,
        expectedPlanDigest: preview.report.basePlanDigest,
      }),
    );
    expect(outcome.status).toBe('refused');
    expect(outcome.reason).toBe('stale_preview');
    expect(outcome.detail).toContain(preview.report.basePlanDigest);
    // Nothing was written: only the three revisions that actually applied.
    expect((await store.getTask(key)).context[VERIFICATION_AMENDMENTS_CONTEXT_KEY].revisions).toHaveLength(3);
  });

  test('the lost-response retry still replays through the guard it carries', async () => {
    // The one bypass the guard has, from the other side: this invocation's OWN
    // committed revision is what moved the plan off the digest it names, which
    // is exactly the `basePlanDigest` test. Refusing here would report a
    // lost-response repeat as a concurrent-edit conflict.
    const key = await seedTask(store, { body: issueBody(['npm test']), status: 'ready_for_human' });
    const live = issueBody(['npm test', 'npm run e2e']);
    const preview = await refreshIssueVerification(refreshDeps(store, live), refreshInput(key));
    expect(preview.status).toBe('preview');

    const guarded = { apply: true, expectedPlanDigest: preview.report.basePlanDigest };
    const applied = await refreshIssueVerification(refreshDeps(store, live), refreshInput(key, guarded));
    expect(applied.status).toBe('applied');

    const retried = await refreshIssueVerification(refreshDeps(store, live), refreshInput(key, guarded));
    expect(retried.status).toBe('replay');
    expect(retried.revision.revisionId).toBe(applied.revision.revisionId);
    expect((await store.getTask(key)).context[VERIFICATION_AMENDMENTS_CONTEXT_KEY].revisions).toHaveLength(1);
  });

  test('an empty reason and a malformed request key each refuse before the provider is touched', async () => {
    const key = await seedTask(store, { status: 'ready_for_human' });
    const exploding = {
      store,
      source: { readIssue: async () => { throw new Error('must not be reached'); } },
      extract: extractIssueVerificationSections,
    };
    const emptyReason = await refreshIssueVerification(exploding, refreshInput(key, { reason: '   ' }));
    expect(emptyReason.status).toBe('refused');
    expect(emptyReason.reason).toBe('invalid_reason');

    const badKey = await refreshIssueVerification(exploding, refreshInput(key, { requestKey: 'not a key!' }));
    expect(badKey.status).toBe('refused');
    expect(badKey.reason).toBe('invalid_request_key');
  });

  test('an active task refuses unconditionally (§7.1)', async () => {
    const key = await seedTask(store, { body: issueBody(['npm test']), status: 'queued' });
    const claimed = await store.transitionTask(key, {}, { status: 'claimed', ownerRunId: 'run-1' });
    expect(claimed.ok).toBe(true);
    const outcome = await refreshIssueVerification(
      refreshDeps(store, issueBody(['npm test', 'npm run e2e'])),
      refreshInput(key, { apply: true }),
    );
    expect(outcome.status).toBe('refused');
    expect(outcome.reason).toBe('task_active');
  });

  test('an inadmissible task refuses even when the live Issue matches the plan (§7.2 rules 1, 2 and 4)', async () => {
    // §10 rule 7's no-op exit is not a way around §7.1: a refresh that finds
    // nothing to change against a `claimed`, `running`, or terminal task is
    // still an apply against a task that may not be amended, so it refuses
    // non-zero rather than reporting an allowed success.
    const body = issueBody(['npm test']);
    for (const [status, reason] of [
      ['claimed', 'task_active'],
      ['running', 'task_active'],
      ['done', 'task_terminal'],
      ['cancelled', 'task_terminal'],
    ]) {
      const key = await seedTask(store, { body, status: 'queued' });
      const moved = await store.transitionTask(key, {}, { status, ownerRunId: 'run-1' });
      expect(moved.ok).toBe(true);

      const outcome = await refreshIssueVerification(
        refreshDeps(store, body),
        refreshInput(key, { apply: true }),
      );
      expect(outcome.status).toBe('refused');
      expect(outcome.reason).toBe(reason);
      expect(outcome.detail).toContain(status);
      expect((await store.getTask(key)).context[VERIFICATION_AMENDMENTS_CONTEXT_KEY]).toBeUndefined();
      expect(await amendmentEvents(store, key)).toEqual([]);
    }
  });

  test('an active task refuses BEFORE the §6.4 rule 5 checkpoint rebase can write', async () => {
    // A previously amended task whose session layer then moved classifies
    // `drifted`, and the drifted arm re-anchors the checkpoint before the apply
    // runs its own status check. That rebase CASes on the task revision only,
    // so without the pre-write guard it would commit a checkpoint and a
    // `verification.amendment.rebased` event onto an in-flight task the apply
    // then refuses — the write §7.2 rule 2 forbids.
    const key = await seedTask(store, { body: issueBody(['npm test']), status: 'ready_for_human' });
    const applied = await refreshIssueVerification(
      refreshDeps(store, issueBody(['npm test', 'npm run e2e'])),
      refreshInput(key, { apply: true }),
    );
    expect(applied.status).toBe('applied');
    const before = (await store.getTask(key)).context[VERIFICATION_AMENDMENTS_CONTEXT_KEY];
    const eventsBefore = await amendmentEvents(store, key);

    const claimed = await store.transitionTask(key, {}, { status: 'claimed', ownerRunId: 'run-9' });
    expect(claimed.ok).toBe(true);

    const outcome = await refreshIssueVerification(
      refreshDeps(store, issueBody(['npm test', 'npm run e2e', 'npm run lint'])),
      refreshInput(key, {
        apply: true,
        // The session layer moved since the amendment: drift, so the apply path
        // would rebase the checkpoint first.
        sessionVerification: { ...SESSION_VERIFICATION, typecheck: 'npm run typecheck' },
      }),
    );
    expect(outcome.status).toBe('refused');
    expect(outcome.reason).toBe('task_active');
    expect(outcome.detail).toContain('run-9');

    const after = (await store.getTask(key)).context[VERIFICATION_AMENDMENTS_CONTEXT_KEY];
    expect(after).toEqual(before);
    expect(await amendmentEvents(store, key)).toEqual(eventsBefore);
  });

  test('a preview is a read: it reports against an active task and writes nothing', async () => {
    // §11 rules 1 and 5: a preview mutates nothing on any status and exits
    // zero, exactly like `plan`. Only the applying invocation is an amendment.
    const key = await seedTask(store, { body: issueBody(['npm test']), status: 'queued' });
    const claimed = await store.transitionTask(key, {}, { status: 'claimed', ownerRunId: 'run-1' });
    expect(claimed.ok).toBe(true);

    const outcome = await refreshIssueVerification(
      refreshDeps(store, issueBody(['npm test', 'npm run e2e'])),
      refreshInput(key),
    );
    expect(outcome.status).toBe('preview');
    expect((await store.getTask(key)).context[VERIFICATION_AMENDMENTS_CONTEXT_KEY]).toBeUndefined();
    expect(await amendmentEvents(store, key)).toEqual([]);
  });

  test('an unknown task refuses without reading the Issue', async () => {
    const outcome = await refreshIssueVerification(
      {
        store,
        source: { readIssue: async () => { throw new Error('must not be reached'); } },
        extract: extractIssueVerificationSections,
      },
      refreshInput({ sessionId: SESSION, issueNumber: 99999 }, { apply: true }),
    );
    expect(outcome.status).toBe('refused');
    expect(outcome.reason).toBe('task_not_found');
  });

  test('an operation naming a pinned entry refuses the whole refresh', async () => {
    const pinned = issueBody(['npm test', 'npm run e2e']);
    const key = await seedTask(store, { body: pinned, status: 'ready_for_human' });
    const outcome = await refreshIssueVerification(
      refreshDeps(store, issueBody(['npm test'])),
      refreshInput(key, {
        apply: true,
        allowRetire: true,
        pinnedCommandIds: [REQ('npm run e2e')],
      }),
    );
    expect(outcome.status).toBe('refused');
    expect(outcome.reason).toBe('invalid_revision');
    expect((await store.getTask(key)).context[VERIFICATION_AMENDMENTS_CONTEXT_KEY]).toBeUndefined();
  });
});
