// Issue #1099 — durable stage state: the persistence half of
// docs/staged-verification-contract.md §13's S4.
//
// Pins what the contracts make normative about persisted stage evidence: the
// ordinal allocated before launch with its identity (#1096 §4.3 rule 1, §7.1
// rule 2), the two observable states and nothing between them (§7.1 rule 3),
// idempotent recording on the stage run id (§7.1 rule 5), an allocation with no
// bundle reading as interrupted and crediting nothing (§7.1 rule 4), the bundle
// integrity rules that keep a stage from reading complete when it is not
// (#1094 §6.2), R1/R3/R4 retention, the migration rules (#1096 §8: absence is
// the initial state, no backfill, legacy evidence reads all-`unknown`), and the
// redaction posture of the audit events.
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  SqliteTaskStore,
  SqliteOutboxStore,
  MemoryTaskStore,
  allocateStageRun,
  recordStageRun,
  readStagedVerificationState,
  validateStagedVerificationState,
  deriveStageSelectionDigest,
  deriveStageBundleCompleteness,
  latestStageBundle,
  lastPassedFinalBundle,
  grantingFinalBundle,
  pendingStageRunInterruption,
  stageRunLedgerEntry,
  stageRunBundle,
  stageRunKey,
  legacyStageEvidenceIdentity,
  resolveEffectiveVerificationPlan,
  MAX_STAGE_BUNDLE_CHECKS,
  MAX_STAGE_ORDINAL_CURSORS,
  MAX_VERIFICATION_AMENDMENT_OPERATIONS,
  MAX_VERIFICATION_AMENDMENT_REVISIONS,
  MAX_VERIFICATION_PLAN_REQUIREMENTS,
  MAX_VERIFICATION_SESSION_BASELINE_ENTRIES,
  STAGED_VERIFICATION_CONTEXT_KEY,
  STAGED_VERIFICATION_STATE_VERSION,
  STAGED_VERIFICATION_LEGACY_STATE_VERSION,
  STAGE_RUN_ALLOCATED_EVENT,
  STAGE_RUN_RECORDED_EVENT,
  STAGE_IDENTITY_COMPONENTS,
} from '../dist/index.js';

const SESSION = 'sess-stage';
const HEAD = 'a'.repeat(40);
const PLAN_DIGEST = 'b'.repeat(64);
const digest = (ch) => ch.repeat(64);

let issueCounter = 0;

function identity(overrides = {}) {
  return {
    testedRevision: { state: 'value', value: HEAD },
    workingTreeState: { state: 'value', value: 'clean' },
    planDigest: { state: 'value', value: PLAN_DIGEST },
    planRevisionOrdinal: { state: 'value', value: '0' },
    sessionBaselineDigest: { state: 'value', value: digest('s') },
    selectionPolicyDigest: { state: 'value', value: digest('p') },
    // A session with no `environmentPrepare` block declares nothing, which is
    // `none` and never `unknown` (#1096 §4.1 rule 1).
    environmentIdentity: { state: 'none', source: 'no-environment-sources-declared' },
    ...overrides,
  };
}

function makeBundle(stageRunId, options = {}) {
  const verdicts = options.verdicts ?? { 'exec:test': 'passed' };
  const checkIds = options.checkIds ?? Object.keys(verdicts);
  const checks = checkIds.map((checkId) => ({
    checkId,
    name: checkId.startsWith('exec:') ? checkId.slice('exec:'.length) : undefined,
    commandDigest: digest('c'),
    verdict: verdicts[checkId],
    durationMs: 12,
    ...(verdicts[checkId] === 'not-run'
      ? { notRunKind: options.notRunKind ?? 'first-failure-stop' }
      : {}),
    ...(verdicts[checkId] === 'failed' ? { exitCode: 1, outputTail: 'FAIL src/x.test.ts' } : {}),
  }));
  return {
    stageRunId,
    planDigest: PLAN_DIGEST,
    headSha: HEAD,
    selection: {
      checkIds,
      selectionDigest: deriveStageSelectionDigest(checkIds),
      full: options.full ?? true,
    },
    outcome: options.outcome ?? 'passed',
    complete: options.complete ?? deriveStageBundleCompleteness(checkIds, checks),
    checks,
    durationMs: 1234,
    ...(options.identityRecheck !== undefined ? { identityRecheck: options.identityRecheck } : {}),
  };
}

async function freshTask(store, context = { keep: 'me' }) {
  const key = { sessionId: SESSION, issueNumber: (issueCounter += 1) };
  const enqueued = await store.enqueueTask({
    sessionId: key.sessionId,
    issueNumber: key.issueNumber,
    phase: 'review',
    context,
  });
  expect(enqueued.ok).toBe(true);
  return key;
}

async function allocate(store, key, overrides = {}) {
  const task = await store.getTask(key);
  return allocateStageRun({
    store,
    key,
    observedTaskRevision: overrides.observedTaskRevision ?? task.revision,
    requestKey: overrides.requestKey ?? `alloc-${task.revision}`,
    taskAttempt: overrides.taskAttempt ?? 1,
    lane: overrides.lane ?? 'review',
    stage: overrides.stage ?? 'final',
    identity: overrides.identity ?? identity(),
    ...(overrides.runId !== undefined ? { runId: overrides.runId } : {}),
    ...(overrides.effects !== undefined ? { effects: overrides.effects } : {}),
    ...(overrides.now !== undefined ? { now: overrides.now } : {}),
  });
}

async function record(store, key, bundle, overrides = {}) {
  const task = await store.getTask(key);
  return recordStageRun({
    store,
    key,
    observedTaskRevision: overrides.observedTaskRevision ?? task.revision,
    bundle,
    ...(overrides.runId !== undefined ? { runId: overrides.runId } : {}),
    ...(overrides.effects !== undefined ? { effects: overrides.effects } : {}),
    ...(overrides.grantsStackReady !== undefined
      ? { grantsStackReady: overrides.grantsStackReady }
      : {}),
  });
}

async function storedState(store, key) {
  const read = await readStagedVerificationState(store, key);
  expect(read.status).toBe('ok');
  return read.state;
}

async function writeStoredBlock(store, key, block) {
  const written = await store.transitionTask(key, {}, {
    context: { [STAGED_VERIFICATION_CONTEXT_KEY]: block },
  });
  expect(written.ok).toBe(true);
  return written.value;
}

describe('stage run allocation (SqliteTaskStore)', () => {
  let tmpDir;
  let store;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'staged-verification-test-'));
    store = new SqliteTaskStore(join(tmpDir, 'test.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // #1094 §2: `stageOrdinal` starts at 0 per attempt, lane and stage.
  test('allocates ordinal 0 with its launch identity, before any bundle exists', async () => {
    const key = await freshTask(store);
    const outcome = await allocate(store, key, { runId: 'run-1' });

    expect(outcome.status).toBe('allocated');
    expect(outcome.entry.stageRunId).toEqual({
      taskAttempt: 1,
      lane: 'review',
      stage: 'final',
      stageOrdinal: 0,
    });
    expect(outcome.entry.state).toBe('allocated');
    expect(outcome.entry.identity.testedRevision).toEqual({ state: 'value', value: HEAD });

    const state = await storedState(store, key);
    // The first observable state: an ordinal and an identity, and no bundle.
    expect(state.loopBundles).toEqual([]);
    expect(state.finalBundles).toEqual([]);
    expect(pendingStageRunInterruption(state)).toBeDefined();
    expect((await store.getTask(key)).context.keep).toBe('me');

    const events = await store.listEvents(key);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe(STAGE_RUN_ALLOCATED_EVENT);
    expect(events[0].runId).toBe('run-1');
    expect(events[0].data.stageOrdinal).toBe(0);
    // #1096 §8 rule 10: component names and STATES, never their values.
    expect(events[0].data.identityStates).toEqual({
      testedRevision: 'value',
      workingTreeState: 'value',
      planDigest: 'value',
      planRevisionOrdinal: 'value',
      sessionBaselineDigest: 'value',
      selectionPolicyDigest: 'value',
      environmentIdentity: 'none',
    });
    expect(JSON.stringify(events[0].data)).not.toContain(HEAD);
  });

  test('ordinals advance per launched run and are never reused', async () => {
    const key = await freshTask(store);
    await allocate(store, key, { requestKey: 'a-1' });
    await record(store, key, makeBundle({ taskAttempt: 1, lane: 'review', stage: 'final', stageOrdinal: 0 }));
    const second = await allocate(store, key, { requestKey: 'a-2' });

    expect(second.status).toBe('allocated');
    expect(second.entry.stageRunId.stageOrdinal).toBe(1);

    // A different lane and a different stage keep their own cursors.
    const loop = await allocate(store, key, { requestKey: 'a-3', lane: 'implementation', stage: 'loop' });
    expect(loop.entry.stageRunId.stageOrdinal).toBe(0);
  });

  // Task attempts advance per phase, so a busy lane's attempt number says
  // nothing about a quiet one's. Cursor eviction that ranked every lane by
  // `taskAttempt` would drop the quiet lane's live cursor and re-mint its
  // ordinal, which the next read then refuses as a duplicate stage run.
  test('a busy lane cannot evict a quiet lane\'s live ordinal cursor', async () => {
    const key = await freshTask(store);
    // Past the cursor budget, all in one lane, one attempt each.
    for (let attempt = 1; attempt <= MAX_STAGE_ORDINAL_CURSORS + 1; attempt += 1) {
      const outcome = await allocate(store, key, { requestKey: `busy-${attempt}`, taskAttempt: attempt });
      expect(outcome.status).toBe('allocated');
    }

    const quietFirst = await allocate(store, key, {
      requestKey: 'quiet-1', taskAttempt: 1, lane: 'implementation', stage: 'loop',
    });
    const quietSecond = await allocate(store, key, {
      requestKey: 'quiet-2', taskAttempt: 1, lane: 'implementation', stage: 'loop',
    });

    expect(quietFirst.entry.stageRunId.stageOrdinal).toBe(0);
    expect(quietSecond.entry.stageRunId.stageOrdinal).toBe(1);
    // The state stays readable: a reused ordinal would be a duplicate stage run.
    const read = await readStagedVerificationState(store, key);
    expect(read.status).toBe('ok');
  }, 30_000);

  // #1096 §7.1 rule 2: ordinals are never reused. An attempt its own lane and
  // stage has already moved past can no longer extend its ordinals — and once
  // its cursor has been evicted, allocating for it again would read the absence
  // as "never allocated" and hand out ordinal 0 a second time.
  test('an attempt the lane has already moved past is refused, not re-minted', async () => {
    const key = await freshTask(store);
    await allocate(store, key, { requestKey: 'a-1', taskAttempt: 1 });
    await allocate(store, key, { requestKey: 'a-2', taskAttempt: 2 });

    const retired = await allocate(store, key, { requestKey: 'a-3', taskAttempt: 1 });
    expect(retired.status).toBe('refused');
    expect(retired.reason).toBe('retired_task_attempt');

    // Refused means nothing was written: no ordinal, no ledger entry, no event.
    const state = await storedState(store, key);
    expect(state.runs.map((entry) => entry.stageRunId.stageOrdinal)).toEqual([0, 0]);
    expect(state.runs.map((entry) => entry.stageRunId.taskAttempt)).toEqual([1, 2]);
    expect(await store.listEvents(key)).toHaveLength(2);
  });

  test('an attempt whose cursor has been evicted cannot re-mint its ordinals', async () => {
    const key = await freshTask(store);
    // Attempt 1 runs a final stage to completion, so its bundle is retained.
    await allocate(store, key, { requestKey: 'r-1', taskAttempt: 1 });
    const recorded = await record(store, key, makeBundle({
      taskAttempt: 1, lane: 'review', stage: 'final', stageOrdinal: 0,
    }));
    expect(recorded.status).toBe('recorded');

    // Then the lane runs far enough past it to evict attempt 1's cursor.
    for (let attempt = 2; attempt <= MAX_STAGE_ORDINAL_CURSORS + 2; attempt += 1) {
      const outcome = await allocate(store, key, { requestKey: `r-${attempt}`, taskAttempt: attempt });
      expect(outcome.status).toBe('allocated');
    }

    const revived = await allocate(store, key, { requestKey: 'revived', taskAttempt: 1 });
    expect(revived.status).toBe('refused');
    expect(revived.reason).toBe('retired_task_attempt');

    // The pin that matters: a second `1/review/final/0` would make the whole
    // state unreadable, taking the retained evidence with it.
    const read = await readStagedVerificationState(store, key);
    expect(read.status).toBe('ok');
    expect(lastPassedFinalBundle(read.state).stageRunId)
      .toEqual({ taskAttempt: 1, lane: 'review', stage: 'final', stageOrdinal: 0 });
  }, 30_000);

  test('a repeated allocation call with the same requestKey replays and burns no ordinal', async () => {
    const key = await freshTask(store);
    const first = await allocate(store, key, { requestKey: 'same' });
    const revisionAfterFirst = (await store.getTask(key)).revision;

    const repeat = await allocate(store, key, { requestKey: 'same' });
    expect(repeat.status).toBe('replay');
    expect(repeat.entry.stageRunId).toEqual(first.entry.stageRunId);
    expect((await store.getTask(key)).revision).toBe(revisionAfterFirst);
    expect(await store.listEvents(key)).toHaveLength(1);
  });

  test('a stale observed revision refuses with nothing allocated', async () => {
    const key = await freshTask(store);
    const outcome = await allocate(store, key, { observedTaskRevision: 99 });

    expect(outcome.status).toBe('stale');
    const state = await storedState(store, key);
    expect(state).toBeUndefined();
    expect(await store.listEvents(key)).toHaveLength(0);
  });

  test('an allocation still open is marked interrupted by the next one, and can never record', async () => {
    const key = await freshTask(store);
    const crashed = await allocate(store, key, { requestKey: 'crashed' });
    const restarted = await allocate(store, key, { requestKey: 'restarted' });

    expect(restarted.status).toBe('allocated');
    expect(restarted.entry.stageRunId.stageOrdinal).toBe(1);

    const state = await storedState(store, key);
    expect(stageRunLedgerEntry(state, crashed.entry.stageRunId).state).toBe('interrupted');
    expect(pendingStageRunInterruption(state).stageRunId.stageOrdinal).toBe(1);

    // §7.1 rule 4: interrupted is never resumed and never partially credited.
    const late = await record(store, key, makeBundle(crashed.entry.stageRunId));
    expect(late.status).toBe('refused');
    expect(late.reason).toBe('stage_run_interrupted');
    expect(latestStageBundle(await storedState(store, key), 'final')).toBeUndefined();
  });

  test('a terminal task allocates nothing', async () => {
    const key = await freshTask(store);
    const cancelled = await store.cancelTask(key);
    expect(cancelled.ok).toBe(true);

    const outcome = await allocate(store, key);
    expect(outcome.status).toBe('refused');
    expect(outcome.reason).toBe('task_terminal');
  });

  test('an identity short a component is refused, never defaulted', async () => {
    const key = await freshTask(store);
    const partial = identity();
    delete partial.environmentIdentity;

    const outcome = await allocate(store, key, { identity: partial });
    expect(outcome.status).toBe('refused');
    expect(outcome.reason).toBe('invalid_input');
    expect(outcome.detail).toContain('environmentIdentity');
  });
});

describe('stage evidence recording (SqliteTaskStore)', () => {
  let tmpDir;
  let store;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'staged-verification-test-'));
    store = new SqliteTaskStore(join(tmpDir, 'test.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('commits the bundle, stamps the allocation identity on it, and closes the ledger entry', async () => {
    const key = await freshTask(store);
    const allocated = await allocate(store, key, { requestKey: 'r-1' });
    const outcome = await record(store, key, makeBundle(allocated.entry.stageRunId), { runId: 'run-2' });

    expect(outcome.status).toBe('recorded');
    expect(outcome.bundle.identity).toEqual(allocated.entry.identity);
    expect(outcome.bundle.startedAt).toBe(allocated.entry.allocatedAt);
    expect(outcome.bundle.recordedAt).toBeDefined();

    const state = await storedState(store, key);
    expect(stageRunLedgerEntry(state, allocated.entry.stageRunId).state).toBe('recorded');
    expect(pendingStageRunInterruption(state)).toBeUndefined();
    const bundle = latestStageBundle(state, 'final');
    expect(bundle.outcome).toBe('passed');
    expect(bundle.complete).toBe(true);
    expect(bundle.checks[0].durationMs).toBe(12);
    expect((await store.getTask(key)).context.keep).toBe('me');

    const recorded = (await store.listEvents(key)).find((event) => event.type === STAGE_RUN_RECORDED_EVENT);
    expect(recorded.runId).toBe('run-2');
    expect(recorded.data.outcome).toBe('passed');
    expect(recorded.data.complete).toBe(true);
    expect(recorded.data.selection).toEqual({
      full: true,
      count: 1,
      selectionDigest: deriveStageSelectionDigest(['exec:test']),
    });
    expect(recorded.data.verdicts).toEqual({
      passed: 1, failed: 0, 'timed-out': 0, 'not-run': 0, unknown: 0,
    });
  });

  test('a failing bundle carries no output bytes and no log paths into its event', async () => {
    const key = await freshTask(store);
    const allocated = await allocate(store, key);
    const bundle = makeBundle(allocated.entry.stageRunId, {
      verdicts: { 'exec:test': 'failed', 'exec:lint': 'not-run' },
      outcome: 'code-failed',
    });
    bundle.checks[1].logArtifact = 'verification/review-verification-lint.log';

    const outcome = await record(store, key, bundle);
    expect(outcome.status).toBe('recorded');
    expect(outcome.bundle.complete).toBe(false);

    const recorded = (await store.listEvents(key)).find((event) => event.type === STAGE_RUN_RECORDED_EVENT);
    const serialized = JSON.stringify(recorded.data);
    expect(serialized).not.toContain('FAIL src/x.test.ts');
    expect(serialized).not.toContain('review-verification-lint.log');
    expect(recorded.data.verdicts).toEqual({
      passed: 0, failed: 1, 'timed-out': 0, 'not-run': 1, unknown: 0,
    });
    // The bytes still live on the retained bundle, for the operator.
    expect(latestStageBundle(await storedState(store, key), 'final').checks[0].outputTail)
      .toBe('FAIL src/x.test.ts');
  });

  test('a replayed recording re-records nothing and re-enqueues nothing', async () => {
    const key = await freshTask(store);
    const allocated = await allocate(store, key);
    const bundle = makeBundle(allocated.entry.stageRunId);
    const first = await record(store, key, bundle, { runId: 'run-1' });
    expect(first.status).toBe('recorded');
    const revisionAfterFirst = (await store.getTask(key)).revision;

    const replay = await record(store, key, bundle, { runId: 'run-1' });
    expect(replay.status).toBe('replay');
    expect(replay.bundle.recordedAt).toBe(first.bundle.recordedAt);

    expect((await store.getTask(key)).revision).toBe(revisionAfterFirst);
    const state = await storedState(store, key);
    expect(state.finalBundles).toHaveLength(1);
    expect((await store.listEvents(key)).filter((e) => e.type === STAGE_RUN_RECORDED_EVENT))
      .toHaveLength(1);
  });

  test('a bundle with no open allocation is refused', async () => {
    const key = await freshTask(store);
    const outcome = await record(store, key, makeBundle({
      taskAttempt: 1, lane: 'review', stage: 'final', stageOrdinal: 1,
    }));

    expect(outcome.status).toBe('refused');
    expect(outcome.reason).toBe('no_active_stage_run');
    expect(await storedState(store, key)).toBeUndefined();
  });

  test('a bundle cannot claim a completeness its verdicts contradict', async () => {
    const key = await freshTask(store);
    const allocated = await allocate(store, key);
    const outcome = await record(store, key, makeBundle(allocated.entry.stageRunId, {
      verdicts: { 'exec:test': 'passed', 'exec:lint': 'not-run' },
      outcome: 'code-failed',
      complete: true,
    }));

    expect(outcome.status).toBe('refused');
    expect(outcome.reason).toBe('invalid_input');
    expect(outcome.detail).toContain('complete');
  });

  test('an `unknown` verdict leaves the bundle incomplete and can never read passed', async () => {
    const key = await freshTask(store);
    const allocated = await allocate(store, key);
    const lost = makeBundle(allocated.entry.stageRunId, {
      verdicts: { 'exec:test': 'unknown' },
      outcome: 'passed',
    });
    expect(lost.complete).toBe(false);

    const refused = await record(store, key, lost);
    expect(refused.status).toBe('refused');
    expect(refused.detail).toContain('"passed" on an incomplete bundle');

    const outcome = await record(store, key, { ...lost, outcome: 'unknown' });
    expect(outcome.status).toBe('recorded');
    expect(outcome.bundle.complete).toBe(false);
  });

  test('an interrupted outcome is never complete', async () => {
    const key = await freshTask(store);
    const allocated = await allocate(store, key);
    const outcome = await record(store, key, makeBundle(allocated.entry.stageRunId, {
      outcome: 'interrupted',
    }));

    expect(outcome.status).toBe('refused');
    expect(outcome.detail).toContain('"interrupted" on a complete bundle');
  });

  test('a selected check with no record at all is refused', async () => {
    const key = await freshTask(store);
    const allocated = await allocate(store, key);
    const bundle = makeBundle(allocated.entry.stageRunId, {
      verdicts: { 'exec:test': 'failed', 'exec:lint': 'not-run' },
      outcome: 'code-failed',
    });
    bundle.checks = bundle.checks.slice(0, 1);

    const outcome = await record(store, key, bundle);
    expect(outcome.status).toBe('refused');
    expect(outcome.detail).toContain('no record for selected check exec:lint');
  });

  // #1094 §6.2: the cause is what separates an accounted skip from lost
  // evidence, and the two contribute differently to the stage outcome. A write
  // that cannot name one records an absence nobody can interpret.
  test('a not-run record with no recorded cause is refused', async () => {
    const key = await freshTask(store);
    const allocated = await allocate(store, key);
    const bundle = makeBundle(allocated.entry.stageRunId, {
      verdicts: { 'exec:test': 'failed', 'exec:lint': 'not-run' },
      outcome: 'code-failed',
    });
    bundle.checks = bundle.checks.map((check) => {
      const copy = { ...check };
      delete copy.notRunKind;
      return copy;
    });

    const outcome = await record(store, key, bundle);
    expect(outcome.status).toBe('refused');
    expect(outcome.reason).toBe('invalid_input');
    expect(outcome.detail).toContain('notRunKind');
    expect(await storedState(store, key)).toBeDefined();
    expect((await storedState(store, key)).finalBundles).toEqual([]);

    // An unrecognized cause is refused on the write for the same reason.
    const unrecognized = makeBundle(allocated.entry.stageRunId, {
      verdicts: { 'exec:test': 'failed', 'exec:lint': 'not-run' },
      outcome: 'code-failed',
      notRunKind: 'gave-up',
    });
    const second = await record(store, key, unrecognized);
    expect(second.status).toBe('refused');
    expect(second.detail).toContain('closed cause set');
  });

  test('an empty selection is recorded as what it is, not refused', async () => {
    // A session configuring no verification command has an empty required set.
    // Persistence records that honestly; what an empty bundle may buy is the
    // stage model's and the row-7 precondition's call, not this layer's.
    const key = await freshTask(store);
    const allocated = await allocate(store, key);
    const outcome = await record(store, key, makeBundle(allocated.entry.stageRunId, {
      verdicts: {},
      checkIds: [],
    }));

    expect(outcome.status).toBe('recorded');
    expect(outcome.bundle.selection.checkIds).toEqual([]);
    expect(outcome.bundle.complete).toBe(true);

    const recorded = (await store.listEvents(key)).find((event) => event.type === STAGE_RUN_RECORDED_EVENT);
    expect(recorded.data.selection.count).toBe(0);
  });

  // The bundle bound is the effective plan's own ceiling, never a smaller
  // number of this layer's invention: a full final stage runs every slot the
  // plan holds, so a bound below that would refuse evidence for a plan the
  // runner itself resolves and leave its allocation open forever.
  test('a full stage over a plan at the requirement + session ceiling is recorded', async () => {
    const resolved = resolveEffectiveVerificationPlan({
      sessionVerification: { test: 'npm test' },
      issueRequirements: Array.from(
        { length: MAX_VERIFICATION_PLAN_REQUIREMENTS },
        (_unused, index) => `npm test -- src/part-${index}.test.js`,
      ),
    });
    expect(resolved.status).toBe('resolved');
    const checkIds = [
      ...resolved.plan.execution.map((slot) => slot.commandId),
      ...resolved.plan.requirement.map((slot) => slot.commandId),
    ];
    expect(checkIds).toHaveLength(MAX_VERIFICATION_PLAN_REQUIREMENTS + 1);

    const key = await freshTask(store);
    const allocated = await allocate(store, key);
    const outcome = await record(store, key, makeBundle(allocated.entry.stageRunId, {
      verdicts: Object.fromEntries(checkIds.map((checkId) => [checkId, 'passed'])),
      checkIds,
    }));

    expect(outcome.status).toBe('recorded');
    expect(outcome.bundle.outcome).toBe('passed');
    const state = await storedState(store, key);
    expect(latestStageBundle(state, 'final').selection.checkIds).toHaveLength(checkIds.length);
  }, 30_000);

  test('the bundle bound covers the session and amendment layers too', async () => {
    // Every slot an accepted plan can carry: the Issue requirements, the
    // session layer, and one added slot per recorded amendment operation (a
    // colliding `add` materializes nothing, so that is the ceiling).
    expect(MAX_STAGE_BUNDLE_CHECKS).toBe(
      MAX_VERIFICATION_PLAN_REQUIREMENTS
        + MAX_VERIFICATION_SESSION_BASELINE_ENTRIES
        + MAX_VERIFICATION_AMENDMENT_REVISIONS * MAX_VERIFICATION_AMENDMENT_OPERATIONS,
    );

    // One past that could not have come out of a plan, so it is corruption.
    const key = await freshTask(store);
    const allocated = await allocate(store, key);
    const checkIds = Array.from(
      { length: MAX_STAGE_BUNDLE_CHECKS + 1 },
      (_unused, index) => `req:${index}`,
    );
    const outcome = await record(store, key, makeBundle(allocated.entry.stageRunId, {
      verdicts: Object.fromEntries(checkIds.map((checkId) => [checkId, 'passed'])),
      checkIds,
    }));

    expect(outcome.status).toBe('refused');
    expect(outcome.detail).toContain(`${MAX_STAGE_BUNDLE_CHECKS}-check bound`);
    // Refused whole: the allocation stays open rather than half-recorded.
    expect(latestStageBundle(await storedState(store, key), 'final')).toBeUndefined();
  }, 30_000);

  test('a bundle whose plan digest differs from its own launch identity is refused', async () => {
    const key = await freshTask(store);
    const allocated = await allocate(store, key);
    const outcome = await record(store, key, {
      ...makeBundle(allocated.entry.stageRunId),
      planDigest: digest('f'),
    });

    expect(outcome.status).toBe('refused');
    expect(outcome.detail).toContain('planDigest');
  });

  test('effects ride the same transaction as the bundle', async () => {
    const key = await freshTask(store);
    const allocated = await allocate(store, key);
    const outcome = await record(store, key, makeBundle(allocated.entry.stageRunId), {
      effects: [
        {
          kind: 'enqueue',
          input: {
            idempotencyKey: `${SESSION}:${key.issueNumber}:stage-1:gh:comment`,
            topic: 'gh:comment',
            payload: {
              topic: 'gh:comment',
              owner: 'org',
              repo: 'repo',
              issueNumber: key.issueNumber,
              body: 'stage recorded',
            },
          },
        },
      ],
    });
    expect(outcome.status).toBe('recorded');

    const outbox = new SqliteOutboxStore(join(tmpDir, 'test.db'));
    try {
      const pending = await outbox.listPending();
      expect(pending.map((entry) => entry.idempotencyKey))
        .toContain(`${SESSION}:${key.issueNumber}:stage-1:gh:comment`);
    } finally {
      outbox.close();
    }
  });
});

describe('retention (#1094 §6.3)', () => {
  let store;

  beforeEach(() => {
    store = new MemoryTaskStore();
  });

  async function runStage(key, options) {
    const allocated = await allocate(store, key, {
      requestKey: options.requestKey,
      lane: options.lane ?? 'review',
      stage: options.stage,
    });
    expect(allocated.status).toBe('allocated');
    const outcome = await record(
      store,
      key,
      makeBundle(allocated.entry.stageRunId, options.bundle ?? {}),
      options.grantsStackReady !== undefined
        ? { grantsStackReady: options.grantsStackReady }
        : {},
    );
    expect(outcome.status).toBe('recorded');
    return outcome.bundle;
  }

  test('R3: the next loop bundle in a lane supersedes the previous one, and lanes do not', async () => {
    const key = await freshTask(store);
    await runStage(key, { requestKey: 'l-1', stage: 'loop', lane: 'implementation' });
    await runStage(key, { requestKey: 'l-2', stage: 'loop', lane: 'implementation' });
    await runStage(key, { requestKey: 'l-3', stage: 'loop', lane: 'review' });

    const state = await storedState(store, key);
    expect(state.loopBundles).toHaveLength(2);
    expect(latestStageBundle(state, 'loop', 'implementation').stageRunId.stageOrdinal).toBe(1);
    expect(latestStageBundle(state, 'loop', 'review').stageRunId.stageOrdinal).toBe(0);
  });

  // Issue #1155 removed R3's one exception with #1094 §7 row 5's full-set
  // re-run of a first `unknown` loop stage: a stage run already covers the
  // entire required set, so there is no widened re-run to retain a pair for.
  // R3 is now unconditional in every lane and for every outcome.
  test('R3 is unconditional: the next loop bundle in the lane supersedes an unknown one', async () => {
    const key = await freshTask(store);
    const first = await runStage(key, {
      requestKey: 'u-1',
      stage: 'loop',
      lane: 'implementation',
      bundle: {
        verdicts: { 'exec:test': 'passed', 'exec:lint': 'unknown' },
        outcome: 'unknown',
      },
    });
    const retry = await runStage(key, {
      requestKey: 'u-2',
      stage: 'loop',
      lane: 'implementation',
      bundle: { verdicts: { 'exec:test': 'passed', 'exec:lint': 'passed' } },
    });

    const state = await storedState(store, key);
    expect(state.loopBundles).toHaveLength(1);
    expect(latestStageBundle(state, 'loop', 'implementation').stageRunId).toEqual(retry.stageRunId);
    expect(stageRunBundle(state, first.stageRunId)).toBeUndefined();
  });

  test('a re-run after a code failure supersedes it the same way', async () => {
    const key = await freshTask(store);
    const failed = await runStage(key, {
      requestKey: 'c-1',
      stage: 'loop',
      lane: 'implementation',
      bundle: { verdicts: { 'exec:test': 'failed' }, outcome: 'code-failed' },
    });
    await runStage(key, { requestKey: 'c-2', stage: 'loop', lane: 'implementation' });

    const state = await storedState(store, key);
    expect(state.loopBundles).toHaveLength(1);
    expect(stageRunBundle(state, failed.stageRunId)).toBeUndefined();
  });

  test('R1: a complete passing final bundle survives the failing final run that supersedes it', async () => {
    const key = await freshTask(store);
    await runStage(key, { requestKey: 'f-1', stage: 'final' });
    await runStage(key, {
      requestKey: 'f-2',
      stage: 'final',
      bundle: { verdicts: { 'exec:test': 'failed' }, outcome: 'code-failed' },
    });

    const state = await storedState(store, key);
    expect(latestStageBundle(state, 'final').outcome).toBe('code-failed');
    const granting = lastPassedFinalBundle(state);
    expect(granting.stageRunId.stageOrdinal).toBe(0);
    expect(granting.complete).toBe(true);
  });

  // #1094 §4.3: a final run that selected less than the whole required set is a
  // partial bundle and cannot grant, however green its own checks came back.
  // Persistence accepts such a bundle (deciding what `full` buys is the stage
  // model's), so retention must not treat it as the replacement grant — the R1
  // floor runs until the task is terminal, and this run published nothing that
  // could have replaced the live grant.
  test('R1: a passing but partial final run does not displace the granting bundle', async () => {
    const key = await freshTask(store);
    await runStage(key, { requestKey: 'f-1', stage: 'final' });
    await runStage(key, {
      requestKey: 'f-2',
      stage: 'final',
      bundle: { checkIds: ['exec:test'], verdicts: { 'exec:test': 'passed' }, full: false },
    });

    const state = await storedState(store, key);
    expect(latestStageBundle(state, 'final').stageRunId.stageOrdinal).toBe(1);
    const granting = lastPassedFinalBundle(state);
    expect(granting.stageRunId.stageOrdinal).toBe(0);
    expect(granting.selection.full).toBe(true);
    // Both survive: the live grant's evidence beside the newest final run.
    expect(state.finalBundles).toHaveLength(2);
  });

  // The R1 floor is about the grant that is LIVE, not about the newest green
  // run: a later full-set pass that enqueued no replacement grant leaves the
  // earlier marker exactly where it was, so the evidence behind it must stay.
  test('R1: a later full-set pass that published no grant does not evict the granting bundle', async () => {
    const key = await freshTask(store);
    const granted = await runStage(key, { requestKey: 'f-1', stage: 'final', grantsStackReady: true });
    const later = await runStage(key, { requestKey: 'f-2', stage: 'final' });

    const state = await storedState(store, key);
    expect(state.grantingStageRunKey).toBe(stageRunKey(granted.stageRunId));
    // The live grant's own evidence, readable after the restart this read is.
    expect(grantingFinalBundle(state).stageRunId).toEqual(granted.stageRunId);
    expect(stageRunBundle(state, granted.stageRunId).checks).toHaveLength(1);
    // ...beside the newest final run, which is what a later stage reads.
    expect(latestStageBundle(state, 'final').stageRunId).toEqual(later.stageRunId);
    expect(lastPassedFinalBundle(state).stageRunId).toEqual(later.stageRunId);
    expect(state.finalBundles).toHaveLength(2);
  });

  test('R1: the pin moves only when a later transaction publishes the replacement grant', async () => {
    const key = await freshTask(store);
    const first = await runStage(key, { requestKey: 'f-1', stage: 'final', grantsStackReady: true });
    const second = await runStage(key, { requestKey: 'f-2', stage: 'final', grantsStackReady: true });

    const state = await storedState(store, key);
    expect(grantingFinalBundle(state).stageRunId).toEqual(second.stageRunId);
    // The superseded grant's evidence goes with the grant it backed.
    expect(stageRunBundle(state, first.stageRunId)).toBeUndefined();
    expect(state.finalBundles).toHaveLength(1);
  });

  // A non-passing final run clears the marker (§7 rule 2) through effects of its
  // own; retention still keeps the granting bundle, because R1 runs to the
  // task's terminal state and over-retaining one bundle breaches nothing.
  test('R1: the granting bundle outlives the failing final run that follows it', async () => {
    const key = await freshTask(store);
    const granted = await runStage(key, { requestKey: 'f-1', stage: 'final', grantsStackReady: true });
    await runStage(key, {
      requestKey: 'f-2',
      stage: 'final',
      bundle: { verdicts: { 'exec:test': 'failed' }, outcome: 'code-failed' },
    });

    const state = await storedState(store, key);
    expect(grantingFinalBundle(state).stageRunId).toEqual(granted.stageRunId);
    expect(lastPassedFinalBundle(state).stageRunId).toEqual(granted.stageRunId);
    // The pin and the granting-shaped slot are the same bundle here.
    expect(state.finalBundles).toHaveLength(2);
  });

  test('a task that never published a grant has no R1 pin', async () => {
    const key = await freshTask(store);
    await runStage(key, { requestKey: 'f-1', stage: 'final' });

    const state = await storedState(store, key);
    expect(state.grantingStageRunKey).toBeUndefined();
    expect(grantingFinalBundle(state)).toBeUndefined();
    // The granting-shaped slot still covers a grant this module never saw.
    expect(lastPassedFinalBundle(state).stageRunId.stageOrdinal).toBe(0);
  });

  test('a grant declaration the bundle could not have earned is refused', async () => {
    const key = await freshTask(store);
    for (const bundle of [
      { checkIds: ['exec:test'], verdicts: { 'exec:test': 'passed' }, full: false },
      { verdicts: { 'exec:test': 'failed' }, outcome: 'code-failed' },
    ]) {
      const allocated = await allocate(store, key, { requestKey: `bad-${bundle.full}-${bundle.outcome}`, stage: 'final' });
      expect(allocated.status).toBe('allocated');
      const outcome = await record(
        store,
        key,
        makeBundle(allocated.entry.stageRunId, bundle),
        { grantsStackReady: true },
      );
      expect(outcome.status).toBe('refused');
      expect(outcome.reason).toBe('invalid_input');
      expect(outcome.detail).toContain('grantsStackReady');
      expect((await storedState(store, key)).grantingStageRunKey).toBeUndefined();
    }
  });

  test('the loop stage never grants, however green and full its bundle', async () => {
    const key = await freshTask(store);
    const allocated = await allocate(store, key, { requestKey: 'l-grant', stage: 'loop' });
    const outcome = await record(
      store,
      key,
      makeBundle(allocated.entry.stageRunId),
      { grantsStackReady: true },
    );
    expect(outcome.status).toBe('refused');
    expect(outcome.detail).toContain('the loop stage never grants');
  });

  test('a passing but partial final bundle is never the R1 bundle', async () => {
    const key = await freshTask(store);
    await runStage(key, {
      requestKey: 'f-1',
      stage: 'final',
      bundle: { checkIds: ['exec:test'], verdicts: { 'exec:test': 'passed' }, full: false },
    });

    const state = await storedState(store, key);
    expect(latestStageBundle(state, 'final').complete).toBe(true);
    expect(lastPassedFinalBundle(state)).toBeUndefined();
  });

  test('an incomplete passing-looking final bundle is never the R1 bundle', async () => {
    const key = await freshTask(store);
    await runStage(key, {
      requestKey: 'f-1',
      stage: 'final',
      bundle: {
        verdicts: { 'exec:test': 'passed', 'exec:lint': 'not-run' },
        notRunKind: 'evidence-lost',
        outcome: 'unknown',
      },
    });

    expect(lastPassedFinalBundle(await storedState(store, key))).toBeUndefined();
  });
});

describe('selection digest and completeness derivation', () => {
  test('the digest changes with membership and not with resolution order', () => {
    expect(deriveStageSelectionDigest(['exec:test', 'exec:lint']))
      .toBe(deriveStageSelectionDigest(['exec:lint', 'exec:test']));
    expect(deriveStageSelectionDigest(['exec:test']))
      .not.toBe(deriveStageSelectionDigest(['exec:test', 'exec:lint']));
  });

  test('only passed, failed and timed-out are terminal', () => {
    const ids = ['exec:test'];
    expect(deriveStageBundleCompleteness(ids, [{ checkId: 'exec:test', verdict: 'passed' }])).toBe(true);
    expect(deriveStageBundleCompleteness(ids, [{ checkId: 'exec:test', verdict: 'failed' }])).toBe(true);
    expect(deriveStageBundleCompleteness(ids, [{ checkId: 'exec:test', verdict: 'timed-out' }])).toBe(true);
    expect(deriveStageBundleCompleteness(ids, [{ checkId: 'exec:test', verdict: 'not-run' }])).toBe(false);
    expect(deriveStageBundleCompleteness(ids, [{ checkId: 'exec:test', verdict: 'unknown' }])).toBe(false);
    expect(deriveStageBundleCompleteness(ids, [])).toBe(false);
  });

  test('a stored selection digest that does not cover its ids fails closed', () => {
    const validation = validateStagedVerificationState({
      version: 1,
      ordinals: [],
      runs: [],
      loopBundles: [],
      finalBundles: [{
        stageRunId: { taskAttempt: 1, lane: 'review', stage: 'final', stageOrdinal: 1 },
        planDigest: PLAN_DIGEST,
        selection: {
          checkIds: ['exec:test'],
          selectionDigest: digest('0'),
          full: true,
        },
        outcome: 'passed',
        complete: true,
        checks: [{ checkId: 'exec:test', verdict: 'passed' }],
        identity: identity(),
        startedAt: '2026-09-12T00:00:00.000Z',
        recordedAt: '2026-09-12T00:01:00.000Z',
      }],
    });

    expect(validation.valid).toBe(false);
    expect(validation.detail).toContain('selectionDigest');
  });
});

describe('migration and legacy rows (#1096 §8)', () => {
  let store;

  beforeEach(() => {
    store = new MemoryTaskStore();
  });

  test('absence is the initial state, and nothing is backfilled from legacy context', async () => {
    const key = await freshTask(store, {
      verificationNames: ['test'],
      verificationPassed: true,
    });

    const read = await readStagedVerificationState(store, key);
    expect(read.status).toBe('ok');
    expect(read.state).toBeUndefined();
    expect(latestStageBundle(read.state, 'final')).toBeUndefined();
    expect(lastPassedFinalBundle(read.state)).toBeUndefined();

    // And the legacy keys survive the first stage write untouched.
    const allocated = await allocate(store, key);
    await record(store, key, makeBundle(allocated.entry.stageRunId));
    const task = await store.getTask(key);
    expect(task.context.verificationNames).toEqual(['test']);
    expect(task.context.verificationPassed).toBe(true);
  });

  test('a bundle persisted before the identity existed reads all-unknown', async () => {
    const key = await freshTask(store);
    const legacy = {
      stageRunId: { taskAttempt: 1, lane: 'review', stage: 'final', stageOrdinal: 1 },
      planDigest: PLAN_DIGEST,
      selection: {
        checkIds: ['exec:test'],
        selectionDigest: deriveStageSelectionDigest(['exec:test']),
        full: true,
      },
      outcome: 'passed',
      complete: true,
      checks: [{ checkId: 'exec:test', verdict: 'passed' }],
      startedAt: '2026-09-12T00:00:00.000Z',
      recordedAt: '2026-09-12T00:01:00.000Z',
    };
    // No `version` and no `identity`: exactly what a pre-component row holds.
    await writeStoredBlock(store, key, { runs: [], ordinals: [], loopBundles: [], finalBundles: [legacy] });

    const state = await storedState(store, key);
    expect(state.version).toBe(STAGED_VERIFICATION_LEGACY_STATE_VERSION);
    const bundle = latestStageBundle(state, 'final');
    for (const component of STAGE_IDENTITY_COMPONENTS) {
      expect(bundle.identity[component]).toEqual({ state: 'unknown', reason: 'legacy-record' });
    }
    expect(bundle.identity).toEqual(legacyStageEvidenceIdentity());
    // The evidence itself is intact and still readable.
    expect(bundle.outcome).toBe('passed');
    expect(stageRunBundle(state, bundle.stageRunId)).toBeDefined();
  });

  // #1094 §6.2: the cause is a closed set whose absent and unrecognized cases
  // both read `evidence-lost` — the cause that credits the least. The read
  // coerces so a row written before the cause was required stays legible; the
  // write refuses one, so no live writer can produce it.
  test('a stored not-run record with no recognized cause reads as evidence-lost', async () => {
    const key = await freshTask(store);
    const allocated = await allocate(store, key);
    await record(store, key, makeBundle(allocated.entry.stageRunId, {
      verdicts: { 'exec:test': 'failed', 'exec:lint': 'not-run', 'exec:types': 'not-run' },
      outcome: 'code-failed',
    }));

    const task = await store.getTask(key);
    const block = JSON.parse(JSON.stringify(task.context[STAGED_VERIFICATION_CONTEXT_KEY]));
    const checks = block.finalBundles[0].checks;
    delete checks.find((check) => check.checkId === 'exec:lint').notRunKind;
    checks.find((check) => check.checkId === 'exec:types').notRunKind = 'gave-up';
    await writeStoredBlock(store, key, block);

    const bundle = latestStageBundle(await storedState(store, key), 'final');
    const kinds = Object.fromEntries(bundle.checks.map((check) => [check.checkId, check.notRunKind]));
    expect(kinds['exec:lint']).toBe('evidence-lost');
    expect(kinds['exec:types']).toBe('evidence-lost');
    // The rest of the bundle is untouched, and a terminal verdict carries none.
    expect(kinds['exec:test']).toBeUndefined();
    expect(bundle.outcome).toBe('code-failed');
    expect(bundle.complete).toBe(false);
  });

  test('an unreadable identity component reads unknown rather than refusing the whole record', async () => {
    const key = await freshTask(store);
    const allocated = await allocate(store, key);
    await record(store, key, makeBundle(allocated.entry.stageRunId));

    const task = await store.getTask(key);
    const block = JSON.parse(JSON.stringify(task.context[STAGED_VERIFICATION_CONTEXT_KEY]));
    block.finalBundles[0].identity.workingTreeState = { state: 'sideways' };
    await writeStoredBlock(store, key, block);

    const bundle = latestStageBundle(await storedState(store, key), 'final');
    expect(bundle.identity.workingTreeState).toEqual({ state: 'unknown', reason: 'unreadable-record' });
    expect(bundle.identity.planDigest).toEqual({ state: 'value', value: PLAN_DIGEST });
  });

  test('a persisted end-of-run recheck is normalized like the launch identity', async () => {
    const key = await freshTask(store);
    const allocated = await allocate(store, key);
    await record(store, key, makeBundle(allocated.entry.stageRunId, {
      identityRecheck: identity(),
    }));

    const task = await store.getTask(key);
    const block = JSON.parse(JSON.stringify(task.context[STAGED_VERIFICATION_CONTEXT_KEY]));
    // One component written before it existed, one the reader cannot parse.
    delete block.finalBundles[0].identityRecheck.environmentIdentity;
    block.finalBundles[0].identityRecheck.workingTreeState = { state: 'sideways' };
    await writeStoredBlock(store, key, block);

    const bundle = latestStageBundle(await storedState(store, key), 'final');
    expect(bundle.identityRecheck.environmentIdentity)
      .toEqual({ state: 'unknown', reason: 'legacy-record' });
    expect(bundle.identityRecheck.workingTreeState)
      .toEqual({ state: 'unknown', reason: 'unreadable-record' });
    expect(bundle.identityRecheck.planDigest).toEqual({ state: 'value', value: PLAN_DIGEST });
    // The launch identity is untouched by the recheck's normalization.
    expect(bundle.identity).toEqual(identity());

    // And an absent recheck stays absent: "no recheck was made" is a different
    // fact from "the recheck could not be read", and only the second is unknown.
    const other = await freshTask(store);
    const otherRun = await allocate(store, other);
    await record(store, other, makeBundle(otherRun.entry.stageRunId));
    const otherBundle = latestStageBundle(await storedState(store, other), 'final');
    expect(otherBundle.identityRecheck).toBeUndefined();
  });

  test('a replayed completion is recognized after the ledger window turns over', async () => {
    const key = await freshTask(store);
    const allocated = await allocate(store, key, { requestKey: 'final-1' });
    const bundle = makeBundle(allocated.entry.stageRunId);
    expect((await record(store, key, bundle)).status).toBe('recorded');

    // Enough unrelated loop allocations to turn the bounded ledger over.
    for (let i = 0; i < 50; i += 1) {
      const outcome = await allocate(store, key, { requestKey: `loop-${i}`, stage: 'loop' });
      expect(outcome.status).toBe('allocated');
    }

    const state = await storedState(store, key);
    // Retention still holds the final bundle, so pruning kept its entry: the
    // ledger is bounded, and what bounds it never shortens retention.
    expect(state.runs.length).toBe(50);
    expect(stageRunBundle(state, allocated.entry.stageRunId)).toBeDefined();
    expect(stageRunLedgerEntry(state, allocated.entry.stageRunId).state).toBe('recorded');

    const replay = await record(store, key, bundle);
    expect(replay.status).toBe('replay');
    expect(replay.bundle.outcome).toBe('passed');
    expect(replay.entry.state).toBe('recorded');
  });

  test('a retained bundle whose ledger entry is gone still recognizes its replay', async () => {
    const key = await freshTask(store);
    const allocated = await allocate(store, key, { requestKey: 'final-1' });
    const bundle = makeBundle(allocated.entry.stageRunId);
    expect((await record(store, key, bundle)).status).toBe('recorded');

    // A state that has lost the entry — one this module does not write, but one
    // a persisted or externally written block can still express.
    const task = await store.getTask(key);
    const block = JSON.parse(JSON.stringify(task.context[STAGED_VERIFICATION_CONTEXT_KEY]));
    block.runs = [];
    await writeStoredBlock(store, key, block);

    const replay = await record(store, key, bundle);
    expect(replay.status).toBe('replay');
    expect(replay.bundle.recordedAt).toBeDefined();
    expect(replay.entry).toBeUndefined();
  });

  test('a block written by a newer runner fails closed', async () => {
    const key = await freshTask(store);
    await writeStoredBlock(store, key, {
      version: STAGED_VERIFICATION_STATE_VERSION + 1,
      ordinals: [],
      runs: [],
      loopBundles: [],
      finalBundles: [],
    });

    const read = await readStagedVerificationState(store, key);
    expect(read.status).toBe('malformed');
    expect(read.detail).toContain('newer runner');

    const outcome = await allocate(store, key);
    expect(outcome.status).toBe('refused');
    expect(outcome.reason).toBe('malformed_state');
  });

  test('two runs allocated at once is corruption, not a state', () => {
    const entry = (stageOrdinal, requestKey) => ({
      stageRunId: { taskAttempt: 1, lane: 'review', stage: 'final', stageOrdinal },
      requestKey,
      identity: identity(),
      allocatedAt: '2026-09-12T00:00:00.000Z',
      state: 'allocated',
    });
    const validation = validateStagedVerificationState({
      version: 1,
      ordinals: [],
      runs: [entry(1, 'a'), entry(2, 'b')],
      loopBundles: [],
      finalBundles: [],
    });

    expect(validation.valid).toBe(false);
    expect(validation.detail).toContain('allocated at once');
  });

  // #1094 §2: `stageOrdinal` starts at 0, so a first-run bundle, its ledger
  // entry and its cursor all carry 0 and must read back as written.
  test('the contract\'s zero-based first ordinal reads back, in every place it is stored', () => {
    const stageRunId = { taskAttempt: 1, lane: 'review', stage: 'final', stageOrdinal: 0 };
    const validation = validateStagedVerificationState({
      version: 1,
      ordinals: [{ taskAttempt: 1, lane: 'review', stage: 'final', lastOrdinal: 0 }],
      runs: [{
        stageRunId,
        requestKey: 'a',
        identity: identity(),
        allocatedAt: '2026-09-12T00:00:00.000Z',
        state: 'recorded',
        recordedAt: '2026-09-12T00:01:00.000Z',
        outcome: 'passed',
        complete: true,
      }],
      loopBundles: [],
      finalBundles: [{
        stageRunId,
        planDigest: PLAN_DIGEST,
        selection: {
          checkIds: ['exec:test'],
          selectionDigest: deriveStageSelectionDigest(['exec:test']),
          full: true,
        },
        outcome: 'passed',
        complete: true,
        checks: [{ checkId: 'exec:test', verdict: 'passed' }],
        identity: identity(),
        startedAt: '2026-09-12T00:00:00.000Z',
        recordedAt: '2026-09-12T00:01:00.000Z',
      }],
    });

    expect(validation.valid).toBe(true);
    expect(validation.state.ordinals[0].lastOrdinal).toBe(0);
    expect(validation.state.runs[0].stageRunId.stageOrdinal).toBe(0);
    expect(lastPassedFinalBundle(validation.state).stageRunId.stageOrdinal).toBe(0);
  });

  // #1096 §8: absence is the initial state here too. A row written before the
  // pointer existed carries no grant this module can attest to, and nothing is
  // inferred from the granting-shaped bundle it may still hold.
  test('a legacy row has no R1 pin, and a malformed one fails closed', async () => {
    const key = await freshTask(store);
    const allocated = await allocate(store, key, { requestKey: 'f-1', stage: 'final' });
    const recorded = await record(store, key, makeBundle(allocated.entry.stageRunId));
    expect(recorded.status).toBe('recorded');
    const block = (await store.getTask(key)).context[STAGED_VERIFICATION_CONTEXT_KEY];
    expect(block.grantingStageRunKey).toBeUndefined();
    expect(grantingFinalBundle(await storedState(store, key))).toBeUndefined();
    expect(lastPassedFinalBundle(await storedState(store, key)).stageRunId)
      .toEqual(recorded.bundle.stageRunId);

    const malformed = validateStagedVerificationState({ ...block, grantingStageRunKey: 7 });
    expect(malformed.valid).toBe(false);
    expect(malformed.detail).toContain('grantingStageRunKey');
  });

  // Retention already failed if this happens, and answering `malformed` would
  // leave the task unable to record any further evidence at all.
  test('a pointer whose bundle is gone reads as no granting bundle, not as a broken block', async () => {
    const key = await freshTask(store);
    const allocated = await allocate(store, key, { requestKey: 'f-1', stage: 'final' });
    expect((await record(store, key, makeBundle(allocated.entry.stageRunId))).status)
      .toBe('recorded');
    const block = (await store.getTask(key)).context[STAGED_VERIFICATION_CONTEXT_KEY];
    await writeStoredBlock(store, key, {
      ...block,
      grantingStageRunKey: '1/review/final/99',
    });

    const state = await storedState(store, key);
    expect(state.grantingStageRunKey).toBe('1/review/final/99');
    expect(grantingFinalBundle(state)).toBeUndefined();
  });

  test('an unrecognized lane, stage or verdict fails closed', () => {
    const base = {
      version: 1,
      ordinals: [],
      runs: [],
      loopBundles: [],
      finalBundles: [],
    };
    const withLane = validateStagedVerificationState({
      ...base,
      ordinals: [{ taskAttempt: 1, lane: 'refinement', stage: 'loop', lastOrdinal: 1 }],
    });
    expect(withLane.valid).toBe(false);
    expect(withLane.detail).toContain('lane');

    const withVerdict = validateStagedVerificationState({
      ...base,
      loopBundles: [{
        stageRunId: { taskAttempt: 1, lane: 'review', stage: 'loop', stageOrdinal: 1 },
        planDigest: PLAN_DIGEST,
        selection: {
          checkIds: ['exec:test'],
          selectionDigest: deriveStageSelectionDigest(['exec:test']),
          full: true,
        },
        outcome: 'passed',
        complete: true,
        checks: [{ checkId: 'exec:test', verdict: 'green' }],
        identity: identity(),
        startedAt: '2026-09-12T00:00:00.000Z',
        recordedAt: '2026-09-12T00:01:00.000Z',
      }],
    });
    expect(withVerdict.valid).toBe(false);
    expect(withVerdict.detail).toContain('verdict');
  });
});

describe('evidence survives a restart', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'staged-verification-restart-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('a new process reads the committed bundle, its identity and its ledger', async () => {
    const dbPath = join(tmpDir, 'test.db');
    const first = new SqliteTaskStore(dbPath);
    let key;
    let stageRunId;
    try {
      key = await freshTask(first);
      const allocated = await allocate(first, key, { requestKey: 'restart-1' });
      stageRunId = allocated.entry.stageRunId;
      const outcome = await record(first, key, makeBundle(stageRunId, {
        verdicts: { 'exec:test': 'failed' },
        outcome: 'code-failed',
        identityRecheck: identity({ workingTreeState: { state: 'value', value: digest('9') } }),
      }));
      expect(outcome.status).toBe('recorded');
    } finally {
      first.close();
    }

    const reopened = new SqliteTaskStore(dbPath);
    try {
      const read = await readStagedVerificationState(reopened, key);
      expect(read.status).toBe('ok');
      const bundle = stageRunBundle(read.state, stageRunId);
      expect(bundle.outcome).toBe('code-failed');
      expect(bundle.checks[0].exitCode).toBe(1);
      expect(bundle.checks[0].durationMs).toBe(12);
      expect(bundle.durationMs).toBe(1234);
      expect(bundle.identity.planDigest).toEqual({ state: 'value', value: PLAN_DIGEST });
      expect(bundle.identityRecheck.workingTreeState).toEqual({ state: 'value', value: digest('9') });
      expect(stageRunLedgerEntry(read.state, stageRunId).state).toBe('recorded');
      // #1094 §2: the first run of a lane and stage is ordinal 0.
      expect(stageRunKey(stageRunId)).toBe('1/review/final/0');

      // Reading is not routing: the task is where the last process left it.
      const task = await reopened.getTask(key);
      expect(task.phase).toBe('review');
      expect(task.status).toBe('queued');
    } finally {
      reopened.close();
    }
  });

  // R1's point is auditability: the marker outlives the process that granted
  // it, so the bundle behind it has to come back with its checks intact even
  // after a later final run wrote over the newest slot.
  test('the granting bundle and its pin come back after a restart', async () => {
    const dbPath = join(tmpDir, 'test.db');
    const first = new SqliteTaskStore(dbPath);
    let key;
    let grantedRunId;
    try {
      key = await freshTask(first);
      const granting = await allocate(first, key, { requestKey: 'grant-1' });
      grantedRunId = granting.entry.stageRunId;
      const granted = await record(first, key, makeBundle(grantedRunId), {
        grantsStackReady: true,
      });
      expect(granted.status).toBe('recorded');

      const later = await allocate(first, key, { requestKey: 'grant-2' });
      expect((await record(first, key, makeBundle(later.entry.stageRunId))).status)
        .toBe('recorded');
    } finally {
      first.close();
    }

    const reopened = new SqliteTaskStore(dbPath);
    try {
      const read = await readStagedVerificationState(reopened, key);
      expect(read.status).toBe('ok');
      expect(read.state.grantingStageRunKey).toBe(stageRunKey(grantedRunId));
      const bundle = grantingFinalBundle(read.state);
      expect(bundle.stageRunId).toEqual(grantedRunId);
      expect(bundle.checks[0].verdict).toBe('passed');
      // The later run is still the newest final bundle; the grant sits beside it.
      expect(latestStageBundle(read.state, 'final').stageRunId.stageOrdinal).toBe(1);
    } finally {
      reopened.close();
    }
  });

  test('an interrupted allocation is still visible after a restart and credits nothing', async () => {
    const dbPath = join(tmpDir, 'test.db');
    const first = new SqliteTaskStore(dbPath);
    let key;
    try {
      key = await freshTask(first);
      await allocate(first, key, { requestKey: 'crash-1' });
    } finally {
      first.close();
    }

    const reopened = new SqliteTaskStore(dbPath);
    try {
      const read = await readStagedVerificationState(reopened, key);
      const pending = pendingStageRunInterruption(read.state);
      expect(pending.stageRunId.stageOrdinal).toBe(0);
      expect(read.state.finalBundles).toEqual([]);
      expect(lastPassedFinalBundle(read.state)).toBeUndefined();

      // The next run is a new run: fresh ordinal, fresh identity, no resumption.
      const next = await allocate(reopened, key, { requestKey: 'crash-2' });
      expect(next.entry.stageRunId.stageOrdinal).toBe(1);
    } finally {
      reopened.close();
    }
  });
});
