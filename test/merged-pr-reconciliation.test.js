/**
 * Merged-PR task reconciliation — operation core (issue #1047).
 *
 * Behavioral tests for src/core/merged-pr-reconciliation.ts against
 * docs/merged-pr-reconciliation-contract.md: the §7 outcome table in its §7.1
 * precedence order, the §8 atomic transition (status → `done` for the three
 * transitioning statuses, history-only for `failed`/`cancelled`), the §9
 * audit record and §9.4 comment effect, §10 idempotency on the complete
 * (prUrl, prNumber) identity, §11 preview/CAS staleness, and the §12
 * fail-closed refusals. Every refusal is asserted to leave the task
 * byte-identical (§7.2 R5) with no event and no effect.
 */
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import {
  MemoryTaskStore,
  SqliteTaskStore,
  reconcileMergedPrTask,
  assessMergedPrProviderSupport,
  validateMergedPrDispositionHistory,
  MERGED_PR_RECONCILIATIONS_CONTEXT_KEY,
  TASK_MERGED_PR_RECONCILED_EVENT,
} from '../dist/index.js';

const SESSION_ID = 'reconcile-sess';
const ISSUE = 321;
const KEY = { sessionId: SESSION_ID, issueNumber: ISSUE };
const NOW = '2026-09-01T10:00:00.000Z';
const BRANCH = 'ai/issue-321';
const PR_URL = 'https://github.com/m2dw/demo-repo/pull/777';
const PR_NUMBER = 777;
const MERGED_PR = { number: PR_NUMBER, url: PR_URL, headRefName: BRANCH, state: 'MERGED' };

const SESSION = {
  githubOwner: 'm2dw',
  githubName: 'demo-repo',
  repoRoot: '/tmp/reconcile-repo-root',
  artifactRoot: '/tmp/reconcile-artifacts',
  workItemProvider: { provider: 'github-issues', auth: { mode: 'gh' } },
};

const THROWING_REPO_HOST = {
  kind: 'github',
  getPullRequest: () => {
    throw new Error('the provider must not be called on this path');
  },
};

function makeDeps(store, overrides = {}) {
  return {
    store,
    repoHost: { kind: 'github', getPullRequest: () => ({ ok: true, value: { ...MERGED_PR } }) },
    issueLock: { inspect: () => ({ locked: false, stale: null }) },
    session: SESSION,
    ...overrides,
  };
}

function makeRequest(overrides = {}) {
  return {
    sessionId: SESSION_ID,
    issueNumber: ISSUE,
    mode: 'apply',
    runId: 'run-reconcile-1',
    now: NOW,
    ...overrides,
  };
}

async function seedTask(store, { status = 'ready_for_human', phase = 'implementation', context, patch = {} } = {}) {
  await store.enqueueTask({
    sessionId: SESSION_ID,
    issueNumber: ISSUE,
    phase,
    context: context ?? { prUrl: PR_URL, branch: BRANCH },
    now: NOW,
  });
  if (status !== 'queued' || Object.keys(patch).length > 0) {
    await store.transitionTask(KEY, {}, { status, ...patch, now: NOW });
  }
  return store.getTask(KEY);
}

async function expectUntouched(store, before) {
  expect(await store.getTask(KEY)).toEqual(before);
  expect(await store.listEvents(KEY)).toHaveLength(0);
  expect(store.listOutboxEffects()).toHaveLength(0);
}

describe('provider support (§12.4)', () => {
  test('only github can supply the MERGED signal', () => {
    expect(assessMergedPrProviderSupport('github')).toEqual({ supported: true });
    const gitea = assessMergedPrProviderSupport('gitea');
    expect(gitea.supported).toBe(false);
    expect(gitea.reason).toBe('unsupported-provider');
    expect(assessMergedPrProviderSupport('bitbucket').supported).toBe(false);
    expect(assessMergedPrProviderSupport('azure-devops').supported).toBe(false);
  });

  test('an unsupported host refuses before any task is read', async () => {
    const store = {
      getTask: () => {
        throw new Error('the task store must not be read');
      },
    };
    const result = await reconcileMergedPrTask(
      makeRequest(),
      makeDeps(store, { repoHost: { kind: 'gitea', getPullRequest: THROWING_REPO_HOST.getPullRequest } }),
    );
    expect(result.outcome).toBe('unsupported-provider');
  });
});

describe('reconciled transitions (rows 1/3/5, §8.1)', () => {
  for (const status of ['queued', 'blocked', 'ready_for_human']) {
    test(`${status} reconciles to done with record, event, and comment`, async () => {
      const store = new MemoryTaskStore();
      const before = await seedTask(store, { status });
      const result = await reconcileMergedPrTask(makeRequest(), makeDeps(store));

      expect(result.outcome).toBe('reconciled');
      expect(result.applied).toBe(true);

      const after = await store.getTask(KEY);
      expect(after.status).toBe('done');
      expect(after.phase).toBe(before.phase); // §8.1 — phase unchanged
      expect(after.revision).toBe(before.revision + 1);
      expect(after.context.branch).toBe(BRANCH); // other context preserved
      const history = after.context[MERGED_PR_RECONCILIATIONS_CONTEXT_KEY];
      expect(history).toEqual([
        {
          prUrl: PR_URL,
          prNumber: PR_NUMBER,
          providerState: 'MERGED',
          observedAt: NOW,
          previousStatus: status,
          previousPhase: before.phase,
          outcome: 'reconciled',
        },
      ]);

      const events = await store.listEvents(KEY);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe(TASK_MERGED_PR_RECONCILED_EVENT);
      expect(events[0].runId).toBe('run-reconcile-1');
      expect(events[0].data).toEqual(history[0]);
      // §9.1 — the event payload is closed at exactly these fields.
      expect(Object.keys(events[0].data).sort()).toEqual([
        'observedAt',
        'outcome',
        'prNumber',
        'prUrl',
        'previousPhase',
        'previousStatus',
        'providerState',
      ]);

      const effects = store.listOutboxEffects();
      expect(effects).toHaveLength(1);
      expect(effects[0].topic).toBe('gh:comment');
      expect(effects[0].payload.owner).toBe('m2dw');
      expect(effects[0].payload.repo).toBe('demo-repo');
      expect(effects[0].payload.issueNumber).toBe(ISSUE);
      expect(effects[0].payload.body).toContain(PR_URL);
      expect(effects[0].payload.body).toContain(`\`${status}\``);

      // "Prevent future claims": done is never claimable again.
      const claim = await store.claimNextTask({
        sessionId: SESSION_ID,
        workerId: 'w',
        runId: 'r2',
        now: '2026-09-01T12:00:00.000Z',
      });
      expect(claim).toBeUndefined();
    });
  }

  test('a lowercase provider state is compared case-insensitively against MERGED (§5.4)', async () => {
    const store = new MemoryTaskStore();
    await seedTask(store, { status: 'queued' });
    const deps = makeDeps(store, {
      repoHost: { kind: 'github', getPullRequest: () => ({ ok: true, value: { ...MERGED_PR, state: 'Merged' } }) },
    });
    const result = await reconcileMergedPrTask(makeRequest(), deps);
    expect(result.outcome).toBe('reconciled');
    expect(result.record.providerState).toBe('Merged'); // recorded verbatim (§9.1)
  });

  test('a provider-reported merge commit is recorded; absence stays absent (§16)', async () => {
    const store = new MemoryTaskStore();
    await seedTask(store, { status: 'queued' });
    const deps = makeDeps(store, {
      repoHost: {
        kind: 'github',
        getPullRequest: () => ({ ok: true, value: { ...MERGED_PR, mergeCommit: 'abc1234def' } }),
      },
    });
    const result = await reconcileMergedPrTask(makeRequest(), deps);
    expect(result.outcome).toBe('reconciled');
    expect(result.record.mergeCommit).toBe('abc1234def');
    const events = await store.listEvents(KEY);
    expect(events[0].data.mergeCommit).toBe('abc1234def');
  });
});

describe('recorded-terminal (rows 12/14, §8.3)', () => {
  for (const status of ['failed', 'cancelled']) {
    test(`${status} keeps its status and phase and records the disposition`, async () => {
      const store = new MemoryTaskStore();
      const before = await seedTask(store, { status, patch: { lastError: 'phase blew up' } });
      const result = await reconcileMergedPrTask(makeRequest(), makeDeps(store));

      expect(result.outcome).toBe('recorded-terminal');
      expect(result.applied).toBe(true);

      const after = await store.getTask(KEY);
      expect(after.status).toBe(status); // §7.2 R3 — terminal history preserved
      expect(after.phase).toBe(before.phase);
      expect(after.lastError).toBe('phase blew up');
      expect(after.context.branch).toBe(BRANCH);
      expect(after.context[MERGED_PR_RECONCILIATIONS_CONTEXT_KEY]).toEqual([
        expect.objectContaining({
          prUrl: PR_URL,
          prNumber: PR_NUMBER,
          previousStatus: status,
          outcome: 'recorded-terminal',
        }),
      ]);
      expect(await store.listEvents(KEY)).toHaveLength(1);
      const effects = store.listOutboxEffects();
      expect(effects).toHaveLength(1);
      expect(effects[0].payload.body).toContain('preserved');
    });
  }

  test('a superseding merged PR appends beside the earlier entry (§9.2.2/§10.3)', async () => {
    const store = new MemoryTaskStore();
    await seedTask(store, { status: 'failed' });
    const first = await reconcileMergedPrTask(makeRequest(), makeDeps(store));
    expect(first.outcome).toBe('recorded-terminal');

    const prUrlB = 'https://github.com/m2dw/demo-repo/pull/778';
    await store.transitionTask(KEY, {}, { context: { prUrl: prUrlB }, now: NOW });
    const prB = { number: 778, url: prUrlB, headRefName: BRANCH, state: 'MERGED' };
    const deps = makeDeps(store, {
      repoHost: { kind: 'github', getPullRequest: () => ({ ok: true, value: prB }) },
    });
    const second = await reconcileMergedPrTask(makeRequest({ runId: 'run-reconcile-2' }), deps);
    expect(second.outcome).toBe('recorded-terminal');

    const history = (await store.getTask(KEY)).context[MERGED_PR_RECONCILIATIONS_CONTEXT_KEY];
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ prUrl: PR_URL, prNumber: PR_NUMBER }); // A untouched, in place
    expect(history[1]).toMatchObject({ prUrl: prUrlB, prNumber: 778 });
    expect(await store.listEvents(KEY)).toHaveLength(2);
    expect(store.listOutboxEffects()).toHaveLength(2);
  });
});

describe('informative no-ops (rows 11/16, §10)', () => {
  test('done short-circuits with no provider call and no writes', async () => {
    const store = new MemoryTaskStore();
    const before = await seedTask(store, {
      status: 'done',
      // Even an unresolved Tool Request does not displace row 11 (§6.4.2).
      context: { prUrl: PR_URL, branch: BRANCH, toolRequest: { command: 'npm i x', resolved: false } },
    });
    const result = await reconcileMergedPrTask(makeRequest(), makeDeps(store, { repoHost: THROWING_REPO_HOST }));
    expect(result.outcome).toBe('noop-done');
    await expectUntouched(store, before);
  });

  test('a repeat reconciliation of the same PR is already-reconciled and writes nothing', async () => {
    const store = new MemoryTaskStore();
    // `failed` keeps its status after `recorded-terminal`, so the retry
    // reaches row 16; a row the first run moved to `done` short-circuits at
    // row 11 as `noop-done` instead (§10.3).
    await seedTask(store, { status: 'failed' });
    const first = await reconcileMergedPrTask(makeRequest(), makeDeps(store));
    expect(first.outcome).toBe('recorded-terminal');
    const afterFirst = await store.getTask(KEY);

    // A retry under a different run id is still the same PR identity (§10.2).
    const again = await reconcileMergedPrTask(makeRequest({ runId: 'run-retry' }), makeDeps(store));
    expect(again).toEqual({ outcome: 'already-reconciled', prUrl: PR_URL, prNumber: PR_NUMBER });
    expect(await store.getTask(KEY)).toEqual(afterFirst);
    expect(await store.listEvents(KEY)).toHaveLength(1);
    expect(store.listOutboxEffects()).toHaveLength(1);
  });

  test('row 16 outranks execution safety: a claimed row with a recorded entry reports already-reconciled', async () => {
    const store = new MemoryTaskStore();
    await seedTask(store, {
      status: 'claimed',
      context: {
        prUrl: PR_URL,
        branch: BRANCH,
        [MERGED_PR_RECONCILIATIONS_CONTEXT_KEY]: [{ prUrl: PR_URL, prNumber: PR_NUMBER }],
      },
      patch: { ownerRunId: 'run-9', leaseExpiresAt: '2026-09-01T11:00:00.000Z' },
    });
    const result = await reconcileMergedPrTask(makeRequest(), makeDeps(store, { repoHost: THROWING_REPO_HOST }));
    expect(result.outcome).toBe('already-reconciled');
  });

  test('entries carrying unknown extra fields still answer the idempotency check (§9.2.5)', async () => {
    const store = new MemoryTaskStore();
    await seedTask(store, {
      status: 'ready_for_human',
      context: {
        prUrl: PR_URL,
        branch: BRANCH,
        [MERGED_PR_RECONCILIATIONS_CONTEXT_KEY]: [
          { prUrl: PR_URL, prNumber: PR_NUMBER, note: 'hand-annotated', extra: 42 },
        ],
      },
    });
    const result = await reconcileMergedPrTask(makeRequest(), makeDeps(store, { repoHost: THROWING_REPO_HOST }));
    expect(result.outcome).toBe('already-reconciled');
  });
});

describe('execution safety (rows 2-10 and 24-25, §6.2/§6.3)', () => {
  test('a valid claim reports active with no provider call and no writes', async () => {
    const store = new MemoryTaskStore();
    const before = await seedTask(store, {
      status: 'claimed',
      patch: { ownerRunId: 'run-9', leaseExpiresAt: '2026-09-01T11:00:00.000Z' },
    });
    const result = await reconcileMergedPrTask(makeRequest(), makeDeps(store, { repoHost: THROWING_REPO_HOST }));
    expect(result.outcome).toBe('active');
    expect(result.reason).toBe('valid-claim');
    await expectUntouched(store, before);
  });

  test('an expired lease with no live lock defers to recovery (rows 8/10)', async () => {
    const store = new MemoryTaskStore();
    const before = await seedTask(store, {
      status: 'running',
      patch: { ownerRunId: 'run-9', leaseExpiresAt: '2026-09-01T09:00:00.000Z' },
    });
    const result = await reconcileMergedPrTask(makeRequest(), makeDeps(store, { repoHost: THROWING_REPO_HOST }));
    expect(result).toMatchObject({ outcome: 'refused', refusal: 'active-recovery-required' });
    await expectUntouched(store, before);
  });

  test('unusable claim metadata is its own refusal (rows 24/25, §6.3.1)', async () => {
    for (const patch of [
      { ownerRunId: 'run-9' }, // no lease at all
      { ownerRunId: 'run-9', leaseExpiresAt: 'not-a-date' }, // unparsable lease
      { leaseExpiresAt: '2026-09-01T11:00:00.000Z' }, // future lease but no owner
    ]) {
      const store = new MemoryTaskStore();
      const before = await seedTask(store, { status: 'claimed', patch });
      const result = await reconcileMergedPrTask(makeRequest(), makeDeps(store, { repoHost: THROWING_REPO_HOST }));
      expect(result).toMatchObject({ outcome: 'refused', refusal: 'invalid-claim-metadata' });
      await expectUntouched(store, before);
    }
  });

  test('a live Issue lock withholds every writing outcome (rows 2/13)', async () => {
    for (const status of ['queued', 'failed']) {
      const store = new MemoryTaskStore();
      const before = await seedTask(store, { status });
      const liveLock = { inspect: () => ({ locked: true, stale: false }) };
      const result = await reconcileMergedPrTask(
        makeRequest(),
        makeDeps(store, { repoHost: THROWING_REPO_HOST, issueLock: liveLock }),
      );
      expect(result.outcome).toBe('active');
      expect(result.reason).toBe('issue-lock');
      await expectUntouched(store, before);
    }
  });

  test('a stale lock does not protect the row (§6.2)', async () => {
    const store = new MemoryTaskStore();
    await seedTask(store, { status: 'queued' });
    const staleLock = { inspect: () => ({ locked: false, stale: true }) };
    const result = await reconcileMergedPrTask(makeRequest(), makeDeps(store, { issueLock: staleLock }));
    expect(result.outcome).toBe('reconciled');
  });
});

describe('unresolved Tool Requests (row 17, §6.4)', () => {
  for (const status of ['ready_for_human', 'failed']) {
    test(`a live Tool Request refuses the ${status} writing row`, async () => {
      const store = new MemoryTaskStore();
      const before = await seedTask(store, {
        status,
        context: { prUrl: PR_URL, branch: BRANCH, toolRequest: { command: 'npm i x', resolved: false } },
      });
      const result = await reconcileMergedPrTask(makeRequest(), makeDeps(store, { repoHost: THROWING_REPO_HOST }));
      expect(result).toMatchObject({ outcome: 'refused', refusal: 'tool-request-unresolved' });
      await expectUntouched(store, before);
    });
  }

  test('a resolved Tool Request does not block reconciliation', async () => {
    const store = new MemoryTaskStore();
    await seedTask(store, {
      status: 'ready_for_human',
      context: { prUrl: PR_URL, branch: BRANCH, toolRequest: { command: 'npm i x', resolved: true } },
    });
    const result = await reconcileMergedPrTask(makeRequest(), makeDeps(store));
    expect(result.outcome).toBe('reconciled');
  });
});

describe('identity and signal (rows 18-21, §4/§5/§12)', () => {
  test('a task with no recorded prUrl is refused, never derived (row 18)', async () => {
    const store = new MemoryTaskStore();
    const before = await seedTask(store, { status: 'ready_for_human', context: { branch: BRANCH } });
    const result = await reconcileMergedPrTask(makeRequest(), makeDeps(store, { repoHost: THROWING_REPO_HOST }));
    expect(result).toMatchObject({ outcome: 'refused', refusal: 'missing-pr-identity' });
    await expectUntouched(store, before);
  });

  test('a prUrl with no extractable number is refused (row 18)', async () => {
    const store = new MemoryTaskStore();
    await seedTask(store, {
      status: 'ready_for_human',
      context: { prUrl: 'https://github.com/m2dw/demo-repo', branch: BRANCH },
    });
    const result = await reconcileMergedPrTask(makeRequest(), makeDeps(store, { repoHost: THROWING_REPO_HOST }));
    expect(result).toMatchObject({ outcome: 'refused', refusal: 'missing-pr-identity' });
  });

  test('a failed provider read is pr-lookup-failed, never "not merged" (row 19, §12.1)', async () => {
    const store = new MemoryTaskStore();
    const before = await seedTask(store, { status: 'ready_for_human' });
    const deps = makeDeps(store, {
      repoHost: { kind: 'github', getPullRequest: () => ({ ok: false, error: 'boom' }) },
    });
    const result = await reconcileMergedPrTask(makeRequest(), deps);
    expect(result).toMatchObject({ outcome: 'refused', refusal: 'pr-lookup-failed' });
    expect(result.message).toContain('boom');
    await expectUntouched(store, before);
  });

  test('the provider must echo the recorded identity exactly (row 20, §4.3/§4.4)', async () => {
    for (const pr of [
      { ...MERGED_PR, number: 999 }, // different number
      { ...MERGED_PR, url: 'https://github.com/other/repo/pull/777' }, // different URL
      { ...MERGED_PR, headRefName: 'other-branch' }, // recorded branch disagrees
      { url: PR_URL, headRefName: BRANCH, state: 'MERGED' }, // number unreported
    ]) {
      const store = new MemoryTaskStore();
      const before = await seedTask(store, { status: 'ready_for_human' });
      const deps = makeDeps(store, { repoHost: { kind: 'github', getPullRequest: () => ({ ok: true, value: pr }) } });
      const result = await reconcileMergedPrTask(makeRequest(), deps);
      expect(result).toMatchObject({ outcome: 'refused', refusal: 'identity-mismatch' });
      await expectUntouched(store, before);
    }
  });

  test('OPEN, CLOSED, and absent states are all not-merged (row 21, §5.4)', async () => {
    for (const state of ['OPEN', 'CLOSED', undefined]) {
      const store = new MemoryTaskStore();
      const before = await seedTask(store, { status: 'ready_for_human' });
      const pr = { ...MERGED_PR };
      if (state === undefined) delete pr.state;
      else pr.state = state;
      const deps = makeDeps(store, { repoHost: { kind: 'github', getPullRequest: () => ({ ok: true, value: pr }) } });
      const result = await reconcileMergedPrTask(makeRequest(), deps);
      expect(result).toMatchObject({ outcome: 'refused', refusal: 'not-merged' });
      await expectUntouched(store, before);
    }
  });
});

describe('disposition-history validation (row 26, §9.2.4)', () => {
  test('validateMergedPrDispositionHistory accepts absence and well-formed lists', () => {
    expect(validateMergedPrDispositionHistory(undefined)).toEqual({ valid: true, entries: [] });
    expect(validateMergedPrDispositionHistory([])).toEqual({ valid: true, entries: [] });
    const entry = { prUrl: PR_URL, prNumber: 777, note: 'extra fields tolerated' };
    expect(validateMergedPrDispositionHistory([entry])).toEqual({ valid: true, entries: [entry] });
  });

  test('validateMergedPrDispositionHistory rejects every malformed shape', () => {
    for (const bad of [
      null,
      'json-looking string',
      '[]',
      42,
      true,
      {},
      [null],
      [['x']],
      ['a string element'],
      [{ prNumber: 777 }], // no prUrl
      [{ prUrl: '', prNumber: 777 }], // empty prUrl
      [{ prUrl: PR_URL }], // no prNumber
      [{ prUrl: PR_URL, prNumber: '777' }], // wrong type
      [{ prUrl: PR_URL, prNumber: 7.5 }], // not an integer
      [
        { prUrl: PR_URL, prNumber: 777 },
        { prUrl: PR_URL, prNumber: 777 },
      ], // duplicate identity key
    ]) {
      expect(validateMergedPrDispositionHistory(bad).valid).toBe(false);
    }
  });

  test('a malformed persisted history refuses, outranking execution safety, and repairs nothing (§7.1/§9.2.6)', async () => {
    const store = new MemoryTaskStore();
    const before = await seedTask(store, {
      status: 'claimed',
      context: { prUrl: PR_URL, branch: BRANCH, [MERGED_PR_RECONCILIATIONS_CONTEXT_KEY]: { prUrl: PR_URL } },
      patch: { ownerRunId: 'run-9', leaseExpiresAt: '2026-09-01T11:00:00.000Z' },
    });
    const result = await reconcileMergedPrTask(makeRequest(), makeDeps(store, { repoHost: THROWING_REPO_HOST }));
    expect(result).toMatchObject({ outcome: 'refused', refusal: 'malformed-disposition-history' });
    await expectUntouched(store, before); // never coerced, wrapped, or replaced
  });
});

describe('staleness and store refusals (rows 22-23, §11.4/§11.5)', () => {
  test('a concurrent write between read and apply loses the CAS as stale-state', async () => {
    const store = new MemoryTaskStore();
    await seedTask(store, { status: 'ready_for_human' });
    const snapshot = await store.getTask(KEY);
    // A write lands after this invocation's read: only the revision moves.
    await store.transitionTask(KEY, {}, { lastError: 'concurrent write', now: NOW });

    const staleStore = {
      getTask: async () => snapshot,
      completePhaseWithEffects: (transition, effects) => store.completePhaseWithEffects(transition, effects),
    };
    const result = await reconcileMergedPrTask(makeRequest(), makeDeps(staleStore));
    expect(result).toMatchObject({ outcome: 'refused', refusal: 'stale-state' });
    expect((await store.getTask(KEY)).lastError).toBe('concurrent write');
    expect(await store.listEvents(KEY)).toHaveLength(0);
    expect(store.listOutboxEffects()).toHaveLength(0);
  });

  test('a store refusal that is not a lost CAS is store-refused, disjoint from stale-state', async () => {
    const store = new MemoryTaskStore();
    const seeded = await seedTask(store, { status: 'ready_for_human' });
    const refusingStore = {
      getTask: async () => seeded,
      completePhaseWithEffects: async () => ({ ok: false, code: 'maintenance_locked' }),
    };
    const result = await reconcileMergedPrTask(makeRequest(), makeDeps(refusingStore));
    expect(result).toMatchObject({ outcome: 'refused', refusal: 'store-refused' });
  });

  test('a missing task row is reported as an addressing error', async () => {
    const store = new MemoryTaskStore();
    const result = await reconcileMergedPrTask(makeRequest(), makeDeps(store));
    expect(result.outcome).toBe('task-not-found');
  });
});

describe('preview (§11.1-§11.3)', () => {
  test('a preview performs every read, reports the apply outcome, and writes nothing', async () => {
    const store = new MemoryTaskStore();
    const before = await seedTask(store, { status: 'ready_for_human' });
    let providerReads = 0;
    const deps = makeDeps(store, {
      repoHost: {
        kind: 'github',
        getPullRequest: () => {
          providerReads += 1;
          return { ok: true, value: { ...MERGED_PR } };
        },
      },
    });

    const preview = await reconcileMergedPrTask(makeRequest({ mode: 'preview' }), deps);
    expect(preview.outcome).toBe('reconciled');
    expect(preview.applied).toBe(false);
    expect(preview.record).toMatchObject({ prUrl: PR_URL, prNumber: PR_NUMBER, previousStatus: 'ready_for_human' });
    expect(providerReads).toBe(1); // §11.1 — the live provider read still happens
    await expectUntouched(store, before);

    // §11.3 — a preview is not a promise; the apply re-evaluates and commits.
    const applied = await reconcileMergedPrTask(makeRequest(), deps);
    expect(applied.outcome).toBe('reconciled');
    expect(applied.applied).toBe(true);
    expect((await store.getTask(KEY)).status).toBe('done');
  });

  test('a preview reports refusals exactly as the apply would (§11.2)', async () => {
    const store = new MemoryTaskStore();
    await seedTask(store, { status: 'failed', context: { branch: BRANCH } });
    const preview = await reconcileMergedPrTask(
      makeRequest({ mode: 'preview' }),
      makeDeps(store, { repoHost: THROWING_REPO_HOST }),
    );
    expect(preview).toMatchObject({ outcome: 'refused', refusal: 'missing-pr-identity' });
  });
});

describe('work-item comment routing (§9.4)', () => {
  test('a non-GitHub work-item session routes the comment to the provider-neutral topic', async () => {
    const store = new MemoryTaskStore();
    await seedTask(store, { status: 'ready_for_human' });
    const giteaWorkItemSession = {
      ...SESSION,
      workItemProvider: {
        provider: 'gitea-issues',
        auth: { mode: 'api-token', tokenEnv: 'GITEA_TOKEN' },
        gitea: { owner: 'private-owner', repo: 'private-repo' },
      },
    };
    // The repo HOST stays github (it supplies the MERGED signal); only the
    // work-item comment is rerouted to the private tracker.
    const result = await reconcileMergedPrTask(makeRequest(), makeDeps(store, { session: giteaWorkItemSession }));
    expect(result.outcome).toBe('reconciled');
    const effects = store.listOutboxEffects();
    expect(effects).toHaveLength(1);
    expect(effects[0].topic).toBe('workitem:comment');
    expect(effects[0].payload).toMatchObject({
      provider: 'gitea-issues',
      owner: 'private-owner',
      repo: 'private-repo',
      issueNumber: ISSUE,
    });
  });
});

describe('SqliteTaskStore end-to-end (§8.4/§8.5)', () => {
  let tmpDir;
  let dbPath;
  let store;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'merged-pr-reconcile-'));
    dbPath = join(tmpDir, 'test.db');
    store = new SqliteTaskStore(dbPath);
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('the transition, event, and comment effect commit in one transaction', async () => {
    await seedTask(store, { status: 'ready_for_human' });
    const result = await reconcileMergedPrTask(makeRequest(), makeDeps(store));
    expect(result.outcome).toBe('reconciled');
    expect(result.applied).toBe(true);

    const after = await store.getTask(KEY);
    expect(after.status).toBe('done');
    expect(after.context[MERGED_PR_RECONCILIATIONS_CONTEXT_KEY]).toHaveLength(1);

    const events = await store.listEvents(KEY);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe(TASK_MERGED_PR_RECONCILED_EVENT);

    const db = new Database(dbPath);
    const rows = db.prepare('SELECT topic, payload FROM outbox').all();
    db.close();
    expect(rows).toHaveLength(1);
    expect(rows[0].topic).toBe('gh:comment');
    expect(JSON.parse(rows[0].payload).issueNumber).toBe(ISSUE);

    // Idempotent on the durable store too: the row the first run left `done`
    // short-circuits at row 11 and writes nothing (§7.1/§10.3).
    const again = await reconcileMergedPrTask(makeRequest({ runId: 'run-retry' }), makeDeps(store));
    expect(again).toEqual({ outcome: 'noop-done' });
    expect(await store.listEvents(KEY)).toHaveLength(1);
  });

  test('a held maintenance lock refuses the whole call and stays repeatable (§8.5)', async () => {
    await seedTask(store, { status: 'ready_for_human' });
    const db = new Database(dbPath);
    db.prepare("INSERT INTO maintenance_lock (id, holder, acquired_at) VALUES (1, 'test-maintenance', ?)").run(NOW);

    const refused = await reconcileMergedPrTask(makeRequest(), makeDeps(store));
    expect(refused).toMatchObject({ outcome: 'refused', refusal: 'store-refused' });
    expect((await store.getTask(KEY)).status).toBe('ready_for_human');
    expect(await store.listEvents(KEY)).toHaveLength(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM outbox').get().n).toBe(0);

    db.prepare('DELETE FROM maintenance_lock').run();
    db.close();

    const applied = await reconcileMergedPrTask(makeRequest(), makeDeps(store));
    expect(applied.outcome).toBe('reconciled');
    expect((await store.getTask(KEY)).status).toBe('done');
  });
});
