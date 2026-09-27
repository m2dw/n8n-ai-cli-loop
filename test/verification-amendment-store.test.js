// Issue #1038 — task-scoped verification plan revisions and amendments, the
// persistence slice (docs/verification-amendment-contract.md §15 slice A2).
// Pins the store behavior the contract makes normative: create, append,
// stale-write rejection with no partial write, replay recognition before any
// staleness comparison, the §7.1 status refusals, fail-closed malformed
// state, legacy-task compatibility, bounded inputs, the checkpoint rebase,
// and the §12.1 audit events carrying no command bytes and no reasons.
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  SqliteTaskStore,
  SqliteOutboxStore,
  MemoryTaskStore,
  applyVerificationAmendmentRevision,
  rebaseVerificationPlanCheckpoint,
  readVerificationAmendmentState,
  validateVerificationAmendmentState,
  canonicalJsonStringify,
  deriveExecutionCommandId,
  deriveRequirementCommandId,
  deriveSessionBaselineDigest,
  VERIFICATION_AMENDMENTS_CONTEXT_KEY,
  VERIFICATION_AMENDMENT_APPLIED_EVENT,
  VERIFICATION_AMENDMENT_REBASED_EVENT,
  MAX_VERIFICATION_AMENDMENT_REVISIONS,
  MAX_VERIFICATION_AMENDMENT_OPERATIONS,
  MAX_VERIFICATION_AMENDMENT_REASON_CHARS,
} from '../dist/index.js';

const SESSION = 'sess-amend';
const digest = (ch) => ch.repeat(64);
const revisionId = (n) => `vamd-${n.toString(16).padStart(16, '0')}`;

const BASELINE = [{ name: 'test', command: 'npm test' }];
const BASELINE_DIGEST = deriveSessionBaselineDigest(BASELINE);

let issueCounter = 0;

function makeRevisionInput(overrides = {}) {
  return {
    revisionId: revisionId(0),
    requestKey: 'req-1',
    source: 'admin-cli',
    actor: { kind: 'operator', id: 'moto' },
    reason: 'session default names the wrong script',
    operations: [
      { kind: 'replace', commandId: 'exec:test', command: 'npm test', reason: 'typo in the recorded bytes' },
    ],
    basePlanDigest: digest('a'),
    planDigest: digest('b'),
    sessionBaselineDigest: BASELINE_DIGEST,
    // `none` because the shared seed is a queued/implementation row, whose
    // §9.2 continuation table row is `Recorded only` (issue #1043): a routing
    // continuation on it would refuse. Routing has its own describe below.
    continuation: 'none',
    ...overrides,
  };
}

function makeCheckpointInput(planDigest, baseline = BASELINE) {
  return {
    planDigest,
    sessionBaseline: baseline,
    sessionBaselineDigest: deriveSessionBaselineDigest(baseline),
  };
}

const SLOT_COUNTS = { execution: { active: 1, retired: 0 }, requirement: { active: 0, retired: 0 } };

function applyInput(store, key, overrides = {}) {
  const revision = makeRevisionInput(overrides.revision ?? {});
  return {
    store,
    key,
    observedTaskRevision: 0,
    revision,
    checkpoint: makeCheckpointInput(revision.planDigest),
    slotCounts: SLOT_COUNTS,
    ...('observedTaskRevision' in overrides ? { observedTaskRevision: overrides.observedTaskRevision } : {}),
    ...(overrides.checkpoint ? { checkpoint: overrides.checkpoint } : {}),
    ...(overrides.runId ? { runId: overrides.runId } : {}),
  };
}

async function freshTask(store, context = { keep: 'me' }) {
  const key = { sessionId: SESSION, issueNumber: (issueCounter += 1) };
  const enqueued = await store.enqueueTask({
    sessionId: key.sessionId,
    issueNumber: key.issueNumber,
    phase: 'implementation',
    context,
  });
  expect(enqueued.ok).toBe(true);
  return key;
}

/** A fully-formed STORED revision record, for hand-writing persisted state. */
function storedRecord(ordinal, overrides = {}) {
  return {
    ...makeRevisionInput({ requestKey: `stored-${ordinal}`, revisionId: revisionId(1000 + ordinal) }),
    revisionOrdinal: ordinal,
    scope: 'task',
    createdAt: '2026-09-02T00:00:00.000Z',
    observedTaskRevision: 0,
    ...overrides,
  };
}

function storedCheckpoint(appliedThroughOrdinal, overrides = {}) {
  return {
    planDigest: digest('b'),
    sessionBaseline: BASELINE,
    sessionBaselineDigest: BASELINE_DIGEST,
    appliedThroughOrdinal,
    updatedAt: '2026-09-02T00:00:00.000Z',
    updatedBy: 'revision',
    ...overrides,
  };
}

async function writeStoredState(store, key, block) {
  const written = await store.transitionTask(key, {}, {
    context: { [VERIFICATION_AMENDMENTS_CONTEXT_KEY]: block },
  });
  expect(written.ok).toBe(true);
  return written.value;
}

describe('verification amendment persistence (SqliteTaskStore)', () => {
  let tmpDir;
  let store;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'verification-amendment-test-'));
    store = new SqliteTaskStore(join(tmpDir, 'test.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('creates the first revision, checkpoint, and audit event in one write', async () => {
    const key = await freshTask(store);
    const outcome = await applyVerificationAmendmentRevision(applyInput(store, key, { runId: 'run-1' }));

    expect(outcome.status).toBe('applied');
    expect(outcome.revision.revisionOrdinal).toBe(1);
    expect(outcome.revision.scope).toBe('task');
    expect(outcome.revision.observedTaskRevision).toBe(0);
    expect(outcome.checkpoint.appliedThroughOrdinal).toBe(1);
    expect(outcome.checkpoint.updatedBy).toBe('revision');

    const task = await store.getTask(key);
    expect(task.revision).toBe(1);
    expect(task.context.keep).toBe('me');
    const state = task.context[VERIFICATION_AMENDMENTS_CONTEXT_KEY];
    expect(state.revisions).toHaveLength(1);
    expect(state.revisions[0].requestKey).toBe('req-1');
    expect(state.checkpoint.planDigest).toBe(digest('b'));

    const events = await store.listEvents(key);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe(VERIFICATION_AMENDMENT_APPLIED_EVENT);
    expect(events[0].runId).toBe('run-1');
    expect(events[0].data.revisionId).toBe(revisionId(0));
    expect(events[0].data.revisionOrdinal).toBe(1);
    expect(events[0].data.actorId).toBe('moto');
    expect(events[0].data.operations).toEqual([
      { kind: 'replace', commandId: 'exec:test', layer: 'execution' },
    ]);
    expect(events[0].data.slotCounts).toEqual(SLOT_COUNTS);
    expect(events[0].data.continuation).toBe('none');
    // §12.1: no command bytes and no operator reasons in the event.
    const serialized = JSON.stringify(events[0].data);
    expect(serialized).not.toContain('npm test');
    expect(serialized).not.toContain('typo in the recorded bytes');
    expect(serialized).not.toContain('session default names the wrong script');
  });

  test('appends a second revision and replaces the checkpoint, leaving the first record untouched', async () => {
    const key = await freshTask(store);
    await applyVerificationAmendmentRevision(applyInput(store, key));
    const before = JSON.parse(JSON.stringify(
      (await store.getTask(key)).context[VERIFICATION_AMENDMENTS_CONTEXT_KEY].revisions[0],
    ));

    const outcome = await applyVerificationAmendmentRevision(applyInput(store, key, {
      observedTaskRevision: 1,
      revision: {
        requestKey: 'req-2',
        revisionId: revisionId(1),
        basePlanDigest: digest('b'),
        planDigest: digest('c'),
      },
    }));
    expect(outcome.status).toBe('applied');
    expect(outcome.revision.revisionOrdinal).toBe(2);

    const task = await store.getTask(key);
    expect(task.revision).toBe(2);
    const state = task.context[VERIFICATION_AMENDMENTS_CONTEXT_KEY];
    expect(state.revisions).toHaveLength(2);
    // §5.3 rule 6: append-only — the earlier record is byte-identical.
    expect(state.revisions[0]).toEqual(before);
    expect(state.checkpoint.planDigest).toBe(digest('c'));
    expect(state.checkpoint.appliedThroughOrdinal).toBe(2);
    expect(await store.listEvents(key)).toHaveLength(2);
  });

  test('a stale observedTaskRevision refuses through the CAS with no partial write', async () => {
    const key = await freshTask(store);
    await applyVerificationAmendmentRevision(applyInput(store, key));

    // basePlanDigest matches the current checkpoint, so only the CAS refuses.
    const outcome = await applyVerificationAmendmentRevision(applyInput(store, key, {
      observedTaskRevision: 0,
      revision: {
        requestKey: 'req-stale',
        revisionId: revisionId(2),
        basePlanDigest: digest('b'),
        planDigest: digest('d'),
      },
    }));
    expect(outcome.status).toBe('stale');
    expect(outcome.observedTaskRevision).toBe(0);
    expect(outcome.currentTaskRevision).toBe(1);
    expect(outcome.currentPlanDigest).toBe(digest('b'));

    // §7.3/§5.3: nothing written — no revision, no ordinal, no event.
    const task = await store.getTask(key);
    expect(task.revision).toBe(1);
    expect(task.context[VERIFICATION_AMENDMENTS_CONTEXT_KEY].revisions).toHaveLength(1);
    expect(await store.listEvents(key)).toHaveLength(1);
  });

  test('a revision authored against a superseded plan refuses stale, naming both digests', async () => {
    const key = await freshTask(store);
    await applyVerificationAmendmentRevision(applyInput(store, key));

    const outcome = await applyVerificationAmendmentRevision(applyInput(store, key, {
      observedTaskRevision: 1,
      revision: {
        requestKey: 'req-old-base',
        revisionId: revisionId(3),
        basePlanDigest: digest('a'), // the pre-amendment plan
        planDigest: digest('d'),
      },
    }));
    expect(outcome.status).toBe('stale');
    expect(outcome.observedPlanDigest).toBe(digest('a'));
    expect(outcome.currentPlanDigest).toBe(digest('b'));
    expect((await store.getTask(key)).revision).toBe(1);
  });

  test('replay: the same requestKey is recognized before any staleness comparison', async () => {
    const key = await freshTask(store);
    await applyVerificationAmendmentRevision(applyInput(store, key));

    // Wildly stale observed revision AND base digest: the requestKey lookup
    // must still win (§5.3 rules 1 and 3).
    const outcome = await applyVerificationAmendmentRevision(applyInput(store, key, {
      observedTaskRevision: 0,
    }));
    expect(outcome.status).toBe('replay');
    expect(outcome.revision.revisionOrdinal).toBe(1);
    expect(outcome.checkpoint.planDigest).toBe(digest('b'));

    const task = await store.getTask(key);
    expect(task.revision).toBe(1);
    expect(task.context[VERIFICATION_AMENDMENTS_CONTEXT_KEY].revisions).toHaveLength(1);
    expect(await store.listEvents(key)).toHaveLength(1);
  });

  test('replay is recognized when the first attempt landed between read and write', async () => {
    const key = await freshTask(store);
    const staleSnapshot = await store.getTask(key);
    await applyVerificationAmendmentRevision(applyInput(store, key));

    // Simulate the race: the retry read the row BEFORE its first attempt
    // committed, so the pre-write replay lookup misses and the CAS conflicts.
    const racingStore = {
      getTask: async () => staleSnapshot,
      completePhaseWithEffects: (transition, effects) => store.completePhaseWithEffects(transition, effects),
    };
    const outcome = await applyVerificationAmendmentRevision(applyInput(racingStore, key));
    expect(outcome.status).toBe('replay');
    expect(outcome.revision.revisionOrdinal).toBe(1);
    expect(await store.listEvents(key)).toHaveLength(1);
  });

  test('a new requestKey reusing an applied revisionId refuses before the write', async () => {
    const key = await freshTask(store);
    await applyVerificationAmendmentRevision(applyInput(store, key));

    // Fresh observedTaskRevision and a matching basePlanDigest, so ONLY the
    // duplicate-id guard can refuse: committing this chain would make every
    // subsequent read classify it as malformed (§5.3 rule 1).
    const outcome = await applyVerificationAmendmentRevision(applyInput(store, key, {
      observedTaskRevision: 1,
      revision: {
        requestKey: 'req-reused-id',
        revisionId: revisionId(0), // already names revision ordinal 1
        basePlanDigest: digest('b'),
        planDigest: digest('d'),
      },
    }));
    expect(outcome.status).toBe('refused');
    expect(outcome.reason).toBe('invalid_input');
    expect(outcome.detail).toContain('duplicate');

    // Nothing written — the chain stays valid and further amendments still land.
    const task = await store.getTask(key);
    expect(task.revision).toBe(1);
    expect(task.context[VERIFICATION_AMENDMENTS_CONTEXT_KEY].revisions).toHaveLength(1);
    expect(await store.listEvents(key)).toHaveLength(1);
    const next = await applyVerificationAmendmentRevision(applyInput(store, key, {
      observedTaskRevision: 1,
      revision: {
        requestKey: 'req-reused-id',
        revisionId: revisionId(4),
        basePlanDigest: digest('b'),
        planDigest: digest('d'),
      },
    }));
    expect(next.status).toBe('applied');
    expect(next.revision.revisionOrdinal).toBe(2);
  });

  test('§7.1: claimed and running refuse as active, naming the owner', async () => {
    for (const status of ['claimed', 'running']) {
      const key = await freshTask(store);
      await store.transitionTask(key, {}, { status, ownerRunId: 'run-9' });
      const outcome = await applyVerificationAmendmentRevision(applyInput(store, key, { observedTaskRevision: 1 }));
      expect(outcome.status).toBe('refused');
      expect(outcome.reason).toBe('task_active');
      expect(outcome.taskStatus).toBe(status);
      expect(outcome.ownerRunId).toBe('run-9');
      const task = await store.getTask(key);
      expect(task.context[VERIFICATION_AMENDMENTS_CONTEXT_KEY]).toBeUndefined();
      expect(await store.listEvents(key)).toHaveLength(0);
    }
  });

  test('§7.1: terminal statuses refuse with a distinguishable reason', async () => {
    for (const status of ['done', 'failed', 'cancelled']) {
      const key = await freshTask(store);
      await store.transitionTask(key, {}, { status });
      const outcome = await applyVerificationAmendmentRevision(applyInput(store, key, { observedTaskRevision: 1 }));
      expect(outcome.status).toBe('refused');
      expect(outcome.reason).toBe('task_terminal');
      expect(outcome.taskStatus).toBe(status);
      expect(await store.listEvents(key)).toHaveLength(0);
    }
  });

  test('§7.1: blocked and ready_for_human are amendable', async () => {
    for (const status of ['blocked', 'ready_for_human']) {
      const key = await freshTask(store);
      await store.transitionTask(key, {}, { status });
      const outcome = await applyVerificationAmendmentRevision(applyInput(store, key, { observedTaskRevision: 1 }));
      expect(outcome.status).toBe('applied');
    }
  });

  test('structurally invalid input refuses the whole revision and writes nothing', async () => {
    const key = await freshTask(store);
    const invalidRevisions = [
      // unrecognized kind
      { operations: [{ kind: 'reorder', commandId: 'exec:test', reason: 'r' }] },
      // requirement-layer add carries no name (§5.2)
      { operations: [{ kind: 'add', layer: 'requirement', name: 'x', command: 'npm run e2e', reason: 'r' }] },
      // unexpected extra field
      { operations: [{ kind: 'retire', commandId: 'exec:test', reason: 'r', command: 'npm test' }] },
      // missing required field
      { operations: [{ kind: 'replace', commandId: 'exec:test', reason: 'r' }] },
      // empty reason (after trimming)
      { operations: [{ kind: 'retire', commandId: 'exec:test', reason: '   ' }] },
      // command bytes not end-trimmed (§2)
      { operations: [{ kind: 'replace', commandId: 'exec:test', command: ' npm test', reason: 'r' }] },
      // execution add violating the §5.1 name character rule
      { operations: [{ kind: 'add', layer: 'execution', name: '../evil', command: 'npm test', reason: 'r' }] },
      // malformed identity and digest forms
      { revisionId: 'not-an-id' },
      { basePlanDigest: 'abc' },
      { requestKey: '-leading-dash' },
      // issueBodyDigest without the issue-refresh source (§10 rule 6)
      { issueBodyDigest: digest('e') },
      // oversized operator text
      { reason: 'x'.repeat(MAX_VERIFICATION_AMENDMENT_REASON_CHARS + 1) },
      // too many operations in one revision
      {
        operations: Array.from({ length: MAX_VERIFICATION_AMENDMENT_OPERATIONS + 1 }, (_, i) => ({
          kind: 'annotate', commandId: 'exec:test', reason: `note ${i}`,
        })),
      },
    ];
    for (const revision of invalidRevisions) {
      const outcome = await applyVerificationAmendmentRevision(applyInput(store, key, { revision }));
      expect(outcome.status).toBe('refused');
      expect(outcome.reason).toBe('invalid_input');
    }
    const task = await store.getTask(key);
    expect(task.revision).toBe(0);
    expect(task.context[VERIFICATION_AMENDMENTS_CONTEXT_KEY]).toBeUndefined();
    expect(await store.listEvents(key)).toHaveLength(0);
  });

  test('an invalid caller-supplied timestamp refuses both writes before anything lands', async () => {
    // Persisting an unparseable createdAt/updatedAt would make the next read
    // classify the whole block as malformed and block all further amendments.
    // Parseable is not the rule either: Date.parse tolerates locale-ish and
    // offset forms whose meaning is environment-dependent, and the contract
    // requires ISO-8601 UTC — the canonical Date#toISOString representation.
    const badTimestamps = [
      'not-a-date',
      '09/02/2026',
      '2026-09-02T09:00:00.000+09:00',
      '2026-09-02T00:00:00Z', // parseable UTC, but not the canonical form
    ];
    const key = await freshTask(store);
    for (const now of badTimestamps) {
      const applied = await applyVerificationAmendmentRevision({
        ...applyInput(store, key),
        now,
      });
      expect(applied.status).toBe('refused');
      expect(applied.reason).toBe('invalid_input');
      expect(applied.detail).toContain('now');
    }
    const task = await store.getTask(key);
    expect(task.revision).toBe(0);
    expect(task.context[VERIFICATION_AMENDMENTS_CONTEXT_KEY]).toBeUndefined();
    expect(await store.listEvents(key)).toHaveLength(0);

    await applyVerificationAmendmentRevision(applyInput(store, key));
    for (const now of badTimestamps) {
      const rebased = await rebaseVerificationPlanCheckpoint({
        store,
        key,
        observedTaskRevision: 1,
        checkpoint: makeCheckpointInput(digest('d'), [{ name: 'test', command: 'npm test --ci' }]),
        now,
      });
      expect(rebased.status).toBe('refused');
      expect(rebased.reason).toBe('invalid_input');
      expect(rebased.detail).toContain('now');
    }
    expect((await store.getTask(key)).context[VERIFICATION_AMENDMENTS_CONTEXT_KEY].checkpoint.planDigest).toBe(digest('b'));
  });

  test('malformed persisted state fails closed and is never repaired', async () => {
    const malformedBlocks = [
      // chain with no checkpoint beside it (§5.5)
      { revisions: [storedRecord(1)] },
      // checkpoint ordinal disagreeing with the chain's highest ordinal (§5.5)
      { revisions: [storedRecord(1)], checkpoint: storedCheckpoint(2) },
      // ordinal gap
      { revisions: [storedRecord(1), storedRecord(3)], checkpoint: storedCheckpoint(2) },
      // duplicate requestKey (§5.3 rule 1)
      {
        revisions: [storedRecord(1), storedRecord(2, { requestKey: 'stored-1' })],
        checkpoint: storedCheckpoint(2),
      },
      // not an object at all
      'scribble',
      // empty chain beside a checkpoint
      { revisions: [], checkpoint: storedCheckpoint(1) },
      // checkpoint whose recorded digest does not cover its recorded baseline
      {
        revisions: [storedRecord(1)],
        checkpoint: storedCheckpoint(1, { sessionBaselineDigest: digest('f') }),
      },
      // checkpoint landed by a revision but carrying a planDigest the final
      // revision never produced — a partial or tampered apply (§5.5 rule 3)
      {
        revisions: [storedRecord(1)],
        checkpoint: storedCheckpoint(1, { planDigest: digest('e') }),
      },
      // parseable but non-UTC createdAt — the contract requires the
      // canonical ISO-8601 UTC form, not whatever Date.parse tolerates
      {
        revisions: [storedRecord(1, { createdAt: '2026-09-02T09:00:00.000+09:00' })],
        checkpoint: storedCheckpoint(1),
      },
      // chain longer than the bound — no admissible write produces one, so
      // an over-limit stored chain is corruption, not history (issue #1038)
      {
        revisions: Array.from(
          { length: MAX_VERIFICATION_AMENDMENT_REVISIONS + 1 },
          (_, i) => storedRecord(i + 1),
        ),
        checkpoint: storedCheckpoint(MAX_VERIFICATION_AMENDMENT_REVISIONS + 1),
      },
    ];
    for (const block of malformedBlocks) {
      const key = await freshTask(store);
      const written = await writeStoredState(store, key, block);
      const bytesBefore = JSON.stringify(written.context[VERIFICATION_AMENDMENTS_CONTEXT_KEY]);

      const read = await readVerificationAmendmentState(store, key);
      expect(read.status).toBe('malformed');

      const outcome = await applyVerificationAmendmentRevision(applyInput(store, key, { observedTaskRevision: 1 }));
      expect(outcome.status).toBe('refused');
      expect(outcome.reason).toBe('malformed_state');

      // Never repaired, never overwritten (§5.5).
      const after = await store.getTask(key);
      expect(JSON.stringify(after.context[VERIFICATION_AMENDMENTS_CONTEXT_KEY])).toBe(bytesBefore);
      expect(await store.listEvents(key)).toHaveLength(0);
    }
  });

  test('a legacy task without the context key reads as no revisions and stays amendable', async () => {
    const key = await freshTask(store, { manualVerificationEvidence: [], other: 1 });
    const read = await readVerificationAmendmentState(store, key);
    expect(read.status).toBe('ok');
    expect(read.state).toBeUndefined();
    expect(validateVerificationAmendmentState(undefined)).toEqual({ valid: true, state: undefined });

    const outcome = await applyVerificationAmendmentRevision(applyInput(store, key));
    expect(outcome.status).toBe('applied');
    const task = await store.getTask(key);
    expect(task.context.other).toBe(1);
  });

  test('a full chain refuses further amendment without truncating anything', async () => {
    const key = await freshTask(store);
    const revisions = Array.from({ length: MAX_VERIFICATION_AMENDMENT_REVISIONS }, (_, i) =>
      storedRecord(i + 1),
    );
    await writeStoredState(store, key, {
      revisions,
      checkpoint: storedCheckpoint(MAX_VERIFICATION_AMENDMENT_REVISIONS),
    });

    const outcome = await applyVerificationAmendmentRevision(applyInput(store, key, {
      observedTaskRevision: 1,
      revision: { requestKey: 'req-one-more', revisionId: revisionId(4), basePlanDigest: digest('b') },
    }));
    expect(outcome.status).toBe('refused');
    expect(outcome.reason).toBe('chain_full');
    const task = await store.getTask(key);
    expect(task.context[VERIFICATION_AMENDMENTS_CONTEXT_KEY].revisions).toHaveLength(
      MAX_VERIFICATION_AMENDMENT_REVISIONS,
    );
  });

  test('rebase re-anchors the checkpoint without touching the chain or consuming an ordinal', async () => {
    const key = await freshTask(store);
    await applyVerificationAmendmentRevision(applyInput(store, key));
    const revisionsBefore = JSON.parse(JSON.stringify(
      (await store.getTask(key)).context[VERIFICATION_AMENDMENTS_CONTEXT_KEY].revisions,
    ));

    const movedBaseline = [{ name: 'test', command: 'npm test --runInBand' }];
    const outcome = await rebaseVerificationPlanCheckpoint({
      store,
      key,
      observedTaskRevision: 1,
      checkpoint: makeCheckpointInput(digest('d'), movedBaseline),
      dispositions: { masked: ['exec:test'], orphaned: [] },
      runId: 'run-2',
    });
    expect(outcome.status).toBe('rebased');
    expect(outcome.checkpoint.updatedBy).toBe('rebase');
    // §6.4 rule 5: no revision applied, so no ordinal consumed.
    expect(outcome.checkpoint.appliedThroughOrdinal).toBe(1);

    const task = await store.getTask(key);
    const state = task.context[VERIFICATION_AMENDMENTS_CONTEXT_KEY];
    expect(state.revisions).toEqual(revisionsBefore);
    expect(state.checkpoint.planDigest).toBe(digest('d'));
    expect(state.checkpoint.sessionBaselineDigest).toBe(deriveSessionBaselineDigest(movedBaseline));
    // A rebase may legitimately move the checkpoint digest away from the
    // final revision's — only updatedBy "revision" pins them together.
    expect(validateVerificationAmendmentState(state).valid).toBe(true);

    const events = await store.listEvents(key);
    expect(events).toHaveLength(2);
    const rebased = events[1];
    expect(rebased.type).toBe(VERIFICATION_AMENDMENT_REBASED_EVENT);
    expect(rebased.data.previousPlanDigest).toBe(digest('b'));
    expect(rebased.data.planDigest).toBe(digest('d'));
    expect(rebased.data.previousSessionBaselineDigest).toBe(BASELINE_DIGEST);
    expect(rebased.data.sessionBaselineDigest).toBe(deriveSessionBaselineDigest(movedBaseline));
    expect(rebased.data.masked).toEqual(['exec:test']);
    // §12.1: dispositions by commandId, never by command bytes.
    expect(JSON.stringify(rebased.data)).not.toContain('npm test');
  });

  test('rebase refusals: unchanged baseline, stale CAS, and no chain', async () => {
    const key = await freshTask(store);
    await applyVerificationAmendmentRevision(applyInput(store, key));

    // §6.4 rule 2: no baseline movement, nothing to rebase.
    const unchanged = await rebaseVerificationPlanCheckpoint({
      store, key, observedTaskRevision: 1, checkpoint: makeCheckpointInput(digest('d')),
    });
    expect(unchanged.status).toBe('refused');
    expect(unchanged.reason).toBe('invalid_input');

    const movedBaseline = [{ name: 'test', command: 'npm test --ci' }];
    const stale = await rebaseVerificationPlanCheckpoint({
      store, key, observedTaskRevision: 0, checkpoint: makeCheckpointInput(digest('d'), movedBaseline),
    });
    expect(stale.status).toBe('stale');
    expect(stale.currentTaskRevision).toBe(1);
    expect((await store.getTask(key)).context[VERIFICATION_AMENDMENTS_CONTEXT_KEY].checkpoint.planDigest).toBe(digest('b'));

    const bare = await freshTask(store);
    const noChain = await rebaseVerificationPlanCheckpoint({
      store, key: bare, observedTaskRevision: 0, checkpoint: makeCheckpointInput(digest('d'), movedBaseline),
    });
    expect(noChain.status).toBe('refused');
    expect(noChain.reason).toBe('no_chain');
  });
});

describe('verification amendment persistence (MemoryTaskStore parity)', () => {
  test('create, stale refusal, and replay behave identically in memory', async () => {
    const store = new MemoryTaskStore();
    const key = await freshTask(store);

    const applied = await applyVerificationAmendmentRevision(applyInput(store, key));
    expect(applied.status).toBe('applied');
    expect((await store.getTask(key)).revision).toBe(1);

    const stale = await applyVerificationAmendmentRevision(applyInput(store, key, {
      observedTaskRevision: 0,
      revision: { requestKey: 'req-2', revisionId: revisionId(5), basePlanDigest: digest('b') },
    }));
    expect(stale.status).toBe('stale');
    expect(stale.currentTaskRevision).toBe(1);

    const replay = await applyVerificationAmendmentRevision(applyInput(store, key, { observedTaskRevision: 0 }));
    expect(replay.status).toBe('replay');
    expect(replay.revision.revisionOrdinal).toBe(1);

    const state = (await store.getTask(key)).context[VERIFICATION_AMENDMENTS_CONTEXT_KEY];
    expect(state.revisions).toHaveLength(1);
    expect(await store.listEvents(key)).toHaveLength(1);
  });
});

// Issue #1043 (§9.2 rule 2): the continuation re-queue rides the SAME
// CAS-guarded transaction as the plan persist, against the real SQLite store.
describe('continuation routing at the store (SqliteTaskStore)', () => {
  let tmpDir;
  let store;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'verification-continuation-test-'));
    store = new SqliteTaskStore(join(tmpDir, 'test.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function parkedReviewTask() {
    const key = await freshTask(store, {
      keep: 'me',
      missingVerificationCommands: ['npm run e2e'],
      issueRequiredVerifications: [{ command: 'npm run e2e', status: 'not_run' }],
      verificationEvidenceBinding: { planDigest: digest('a'), commandIds: {} },
      manualVerificationEvidence: [{ command: 'npm test', exitCode: 0, source: 'operator_input' }],
    });
    const parked = await store.transitionTask(key, {}, { status: 'ready_for_human', phase: 'review' });
    expect(parked.ok).toBe(true);
    return { key, revision: parked.value.revision };
  }

  test('a review continuation re-queues, clears the stale park state, and persists the plan in one write', async () => {
    const { key, revision } = await parkedReviewTask();
    const outcome = await applyVerificationAmendmentRevision(applyInput(store, key, {
      observedTaskRevision: revision,
      revision: { continuation: 'review' },
    }));
    expect(outcome.status).toBe('applied');
    expect(outcome.task.status).toBe('queued');
    expect(outcome.task.phase).toBe('review');

    const task = await store.getTask(key);
    expect(task.status).toBe('queued');
    expect(task.phase).toBe('review');
    expect(task.ownerRunId).toBeUndefined();
    expect(task.lastError).toBeUndefined();
    expect(task.context.keep).toBe('me');
    expect(task.context.missingVerificationCommands).toBeUndefined();
    expect(task.context.issueRequiredVerifications).toBeUndefined();
    expect(task.context.verificationEvidenceBinding).toBeUndefined();
    expect(task.context.manualVerificationEvidence).toHaveLength(1);
    expect(task.context[VERIFICATION_AMENDMENTS_CONTEXT_KEY].checkpoint.planDigest).toBe(digest('b'));
    const events = await store.listEvents(key);
    expect(events).toHaveLength(1);
    expect(events[0].data.continuation).toBe('review');
  });

  test('a routing continuation on a Recorded-only row refuses whole: no revision, no move, no event', async () => {
    const key = await freshTask(store); // queued / implementation
    const outcome = await applyVerificationAmendmentRevision(applyInput(store, key, {
      revision: { continuation: 'review' },
    }));
    expect(outcome).toMatchObject({ status: 'refused', reason: 'continuation_not_permitted' });
    const task = await store.getTask(key);
    expect(task.status).toBe('queued');
    expect(task.phase).toBe('implementation');
    expect(task.context[VERIFICATION_AMENDMENTS_CONTEXT_KEY]).toBeUndefined();
    expect(await store.listEvents(key)).toHaveLength(0);
  });

  test('a concurrent claim between the read and the routed write fails closed as stale — nothing moves', async () => {
    const { key, revision } = await parkedReviewTask();
    // The competing transition the CAS must observe: the row left the park.
    const moved = await store.transitionTask(key, {}, { status: 'queued', phase: 'implementation' });
    expect(moved.ok).toBe(true);
    const outcome = await applyVerificationAmendmentRevision(applyInput(store, key, {
      observedTaskRevision: revision,
      revision: { continuation: 'review' },
    }));
    expect(outcome.status).toBe('stale');
    const task = await store.getTask(key);
    expect(task.status).toBe('queued');
    expect(task.phase).toBe('implementation');
    expect(task.context[VERIFICATION_AMENDMENTS_CONTEXT_KEY]).toBeUndefined();
    expect(await store.listEvents(key)).toHaveLength(0);
  });

  test('an implementation continuation routes to the implementation lane', async () => {
    const { key, revision } = await parkedReviewTask();
    const outcome = await applyVerificationAmendmentRevision(applyInput(store, key, {
      observedTaskRevision: revision,
      revision: { continuation: 'implementation' },
    }));
    expect(outcome.status).toBe('applied');
    const task = await store.getTask(key);
    expect(task.status).toBe('queued');
    expect(task.phase).toBe('implementation');
  });

  test('a routing revision on a claimed task refuses under the §7.1 lease rule — the claim owns the plan', async () => {
    const { key, revision } = await parkedReviewTask();
    const claimed = await store.transitionTask(key, {}, { status: 'claimed', ownerRunId: 'run-9' });
    expect(claimed.ok).toBe(true);
    const outcome = await applyVerificationAmendmentRevision(applyInput(store, key, {
      observedTaskRevision: revision + 1,
      revision: { continuation: 'review' },
    }));
    expect(outcome).toMatchObject({ status: 'refused', reason: 'task_active' });
    const task = await store.getTask(key);
    expect(task.status).toBe('claimed');
    expect(task.ownerRunId).toBe('run-9');
    expect(task.context.missingVerificationCommands).toEqual(['npm run e2e']);
    expect(task.context[VERIFICATION_AMENDMENTS_CONTEXT_KEY]).toBeUndefined();
    expect(await store.listEvents(key)).toHaveLength(0);
  });

  // Issue #1043 review: a ready_for_human/review park that came from a passing
  // review still carries the success-only stack-ready marker — the signal
  // dependency-plan.ts accepts as implementation-complete on its own — so the
  // re-queue must retract it in the same transaction, not best-effort after.
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

  async function labelRows() {
    const outbox = new SqliteOutboxStore(join(tmpDir, 'test.db'));
    try {
      const entries = await outbox.listPending();
      return entries
        .filter((entry) => entry.topic.startsWith('gh:label:'))
        .map((entry) => `${entry.topic} ${entry.payload.label}`);
    } finally {
      outbox.close();
    }
  }

  test('a routed re-queue with the session retracts stack-ready and swaps the lane labels in the same transaction', async () => {
    const { key, revision } = await parkedReviewTask();
    const outcome = await applyVerificationAmendmentRevision({
      ...applyInput(store, key, {
        observedTaskRevision: revision,
        revision: { continuation: 'review' },
      }),
      session: ROUTING_SESSION,
    });
    expect(outcome.status).toBe('applied');
    const rows = await labelRows();
    expect(rows).toContain('gh:label:remove status:stack-ready');
    expect(rows).toContain('gh:label:remove ai:ready-for-human');
    expect(rows).toContain('gh:label:add status:needs-review');
    expect(rows).toContain('gh:label:add agent:codex');
    // The blocked retraction is scoped to a blocked source (issue #1043
    // review, P2): a ready_for_human park never carried the coarse blocked
    // label, so this edge enqueues no removal for it.
    expect(rows).not.toContain('gh:label:remove ai:blocked');
  });

  test('a blocked/review park retracts the coarse blocked label in the same transaction as the re-queue (issue #1043 review, P2)', async () => {
    // `queued` maps to no coarse label, so the shared helper's removals on
    // this edge are the review-lane markers only — without the explicit
    // retraction the work item would advertise blocked and freshly-queued
    // review at once, indefinitely.
    const key = await freshTask(store, { keep: 'me' });
    const parked = await store.transitionTask(key, {}, { status: 'blocked', phase: 'review' });
    expect(parked.ok).toBe(true);
    const outcome = await applyVerificationAmendmentRevision({
      ...applyInput(store, key, {
        observedTaskRevision: parked.value.revision,
        revision: { continuation: 'review' },
      }),
      session: ROUTING_SESSION,
    });
    expect(outcome.status).toBe('applied');
    const task = await store.getTask(key);
    expect(task.status).toBe('queued');
    expect(task.phase).toBe('review');
    const rows = await labelRows();
    expect(rows).toContain('gh:label:remove ai:blocked');
    expect(rows).toContain('gh:label:remove ai:ready-for-human');
    expect(rows).toContain('gh:label:add status:needs-review');
  });

  test('an implementation continuation retracts stack-ready too — new work is pending either way', async () => {
    const { key, revision } = await parkedReviewTask();
    const outcome = await applyVerificationAmendmentRevision({
      ...applyInput(store, key, {
        observedTaskRevision: revision,
        revision: { continuation: 'implementation' },
      }),
      session: ROUTING_SESSION,
    });
    expect(outcome.status).toBe('applied');
    const rows = await labelRows();
    expect(rows).toContain('gh:label:remove status:stack-ready');
    expect(rows).toContain('gh:label:remove ai:ready-for-human');
  });

  test('a stale routed write enqueues no label effect — the effects ride the refused CAS', async () => {
    const { key, revision } = await parkedReviewTask();
    const moved = await store.transitionTask(key, {}, { status: 'queued', phase: 'implementation' });
    expect(moved.ok).toBe(true);
    const outcome = await applyVerificationAmendmentRevision({
      ...applyInput(store, key, {
        observedTaskRevision: revision,
        revision: { continuation: 'review' },
      }),
      session: ROUTING_SESSION,
    });
    expect(outcome.status).toBe('stale');
    expect(await labelRows()).toHaveLength(0);
  });
});

// Issue #1043 review (§8.3 rules 1–3): a requirement-layer `replace` stamps
// the per-slot invalidation record onto the passing evidence its superseded
// bytes admitted, inside the same CAS that persists the replacement — the
// byte mismatch alone only hides the old evidence until a later revision
// restores the old bytes.
describe('requirement replace — §8.3 evidence invalidation', () => {
  const E2E = 'npm run e2e';
  const REQ_E2E = deriveRequirementCommandId(E2E);
  let store;

  beforeEach(() => {
    store = new MemoryTaskStore();
  });

  const replaceRevision = (overrides = {}) => ({
    operations: [{ kind: 'replace', commandId: REQ_E2E, command: `${E2E} -- --ci`, reason: 'typo' }],
    ...overrides,
  });

  test('stamps {commandId, supersededByRevision} onto matching passing evidence, preserving every entry', async () => {
    const key = await freshTask(store, {
      manualVerificationEvidence: [
        { command: E2E, exitCode: 0, source: 'operator_input' },
        { command: E2E, exitCode: 1, source: 'operator_input' },
        { command: 'npm run lint', exitCode: 0, source: 'operator_input' },
      ],
    });
    const outcome = await applyVerificationAmendmentRevision({
      ...applyInput(store, key, { revision: replaceRevision() }),
      baseRequirementCommands: { [REQ_E2E]: E2E },
    });
    expect(outcome.status).toBe('applied');
    const evidence = (await store.getTask(key)).context.manualVerificationEvidence;
    expect(evidence).toHaveLength(3);
    // The superseded pass is preserved (§8.1) and carries the record (§8.3
    // rule 1); the failing and unrelated entries are untouched.
    expect(evidence[0]).toEqual({
      command: E2E,
      exitCode: 0,
      source: 'operator_input',
      invalidations: [{ commandId: REQ_E2E, supersededByRevision: revisionId(0) }],
    });
    expect(evidence[1].invalidations).toBeUndefined();
    expect(evidence[2].invalidations).toBeUndefined();
  });

  test('evidence bound to the slot by its recorded #1040 identity is stamped even when its bytes differ', async () => {
    const key = await freshTask(store, {
      manualVerificationEvidence: [
        { command: `${E2E} --equivalent-form`, exitCode: 0, source: 'operator_input', commandId: REQ_E2E },
      ],
    });
    const outcome = await applyVerificationAmendmentRevision({
      ...applyInput(store, key, { revision: replaceRevision() }),
      baseRequirementCommands: { [REQ_E2E]: E2E },
    });
    expect(outcome.status).toBe('applied');
    const evidence = (await store.getTask(key)).context.manualVerificationEvidence;
    expect(evidence[0].invalidations).toEqual([{ commandId: REQ_E2E, supersededByRevision: revisionId(0) }]);
  });

  test('an entry already invalidated for the slot keeps its earlier record untouched (§8.3 rule 3)', async () => {
    const earlier = { commandId: REQ_E2E, supersededByRevision: revisionId(7) };
    const key = await freshTask(store, {
      manualVerificationEvidence: [
        { command: E2E, exitCode: 0, source: 'operator_input', invalidations: [earlier] },
      ],
    });
    const outcome = await applyVerificationAmendmentRevision({
      ...applyInput(store, key, { revision: replaceRevision() }),
      baseRequirementCommands: { [REQ_E2E]: E2E },
    });
    expect(outcome.status).toBe('applied');
    const evidence = (await store.getTask(key)).context.manualVerificationEvidence;
    expect(evidence[0].invalidations).toEqual([earlier]);
  });

  test('a requirement replace without its pre-revision bytes refuses whole (§8.3 rule 1)', async () => {
    const key = await freshTask(store, {
      manualVerificationEvidence: [{ command: E2E, exitCode: 0, source: 'operator_input' }],
    });
    const outcome = await applyVerificationAmendmentRevision(
      applyInput(store, key, { revision: replaceRevision() }),
    );
    expect(outcome).toMatchObject({ status: 'refused', reason: 'invalid_input' });
    expect(outcome.detail).toContain('baseRequirementCommands');
    const task = await store.getTask(key);
    expect(task.context[VERIFICATION_AMENDMENTS_CONTEXT_KEY]).toBeUndefined();
    expect(task.context.manualVerificationEvidence[0].invalidations).toBeUndefined();
    expect(await store.listEvents(key)).toHaveLength(0);
  });

  test('an execution-layer replace stamps nothing — the execution layer invalidates by identity, not record (§8.2)', async () => {
    const key = await freshTask(store, {
      manualVerificationEvidence: [{ command: 'npm test', exitCode: 0, source: 'operator_input' }],
    });
    const outcome = await applyVerificationAmendmentRevision(
      applyInput(store, key, {
        revision: {
          operations: [{ kind: 'replace', commandId: 'exec:test', command: 'npm test -- --ci', reason: 'flag' }],
        },
      }),
    );
    expect(outcome.status).toBe('applied');
    const evidence = (await store.getTask(key)).context.manualVerificationEvidence;
    expect(evidence[0].invalidations).toBeUndefined();
  });
});

describe('identity and digest helpers', () => {
  test('requirement identity is byte-preserving: interior whitespace distinguishes slots', () => {
    expect(deriveRequirementCommandId("printf 'a  b'")).not.toBe(deriveRequirementCommandId("printf 'a b'"));
    expect(deriveRequirementCommandId('npm run e2e')).toMatch(/^req:[0-9a-f]{16}$/);
    expect(deriveExecutionCommandId('test')).toBe('exec:test');
  });

  test('canonical JSON sorts keys at every level and omits absent fields', () => {
    expect(canonicalJsonStringify({ b: 1, a: { d: undefined, c: [1, 'x'] } })).toBe('{"a":{"c":[1,"x"]},"b":1}');
  });

  test('the session baseline digest is insensitive to entry key order and extra fields', () => {
    const a = deriveSessionBaselineDigest([{ name: 'n', command: 'c' }]);
    const b = deriveSessionBaselineDigest([{ command: 'c', name: 'n', stray: true }]);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});
