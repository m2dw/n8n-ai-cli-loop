/**
 * End-to-end tests for the bounded ChatOps pass (issue #1024).
 *
 * These drive `runChatOpsPass` — the whole chain, from a provider-shaped comment
 * list through recognition, the durable cursor and execution ledger, operation
 * mapping and dispatch, to bounded result publication — against an in-memory
 * store and a fake comment port. The store is a faithful port implementation
 * rather than a stub: it enforces the two rules the SQLite one does (first-seen
 * rows are insert-only, an epoch is allocated only by the transaction that
 * spends it), because those are exactly the properties the at-most-once
 * guarantee rests on.
 *
 * The scenarios are the ones the issue's acceptance criteria name: a happy path
 * that dispatches exactly once, a replay that dispatches zero more times, and
 * the explicit outcomes for disabled ChatOps, unauthorized authors, marker
 * comments, unsupported and edited commands, incomplete pagination, a restored
 * epoch, provider failures, dispatch failures, and publication retries.
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runChatOpsPass } from '../dist/handlers/chatops-pass.js';
import { chatOpsIdentityKey } from '../dist/core/chatops-identity.js';
import { createChatOpsHarness } from './helpers/chatops-harness.js';
import {
  createOperationRegistry,
  operationExecuted,
  operationFailed,
} from '../dist/core/operation-port.js';
import { CHATOPS_SUMMARY_HEADER } from '../dist/core/chatops-result.js';
import { CHATOPS_MAX_ACK_PUBLICATION_ATTEMPTS as MAX_ACK_PUBLICATION_ATTEMPTS } from '../dist/core/chatops-execution-ledger.js';

const IDENTITY = {
  sessionId: 'chatops-test',
  provider: 'github-issues',
  providerEndpoint: 'github.com',
  providerOwner: 'm2dw',
  providerRepo: 'demo',
};
const IDENTITY_KEY = chatOpsIdentityKey(IDENTITY);
const ISSUE = 42;
const BASE_MS = Date.parse('2026-03-01T00:00:00Z');

// ---------------------------------------------------------------------------
// In-memory ChatOpsStore + fake comment port
// ---------------------------------------------------------------------------

// Both live in `test/helpers/chatops-harness.js` since issue #1031, when
// `chatops-tool-request-operations.test.js` needed the same faithful store: a
// second copy would be a second chance for one of them to stop enforcing the
// insert-only and epoch-allocation rules the at-most-once guarantee rests on.
const { createMemoryStore, comment, createFakePort } = createChatOpsHarness({
  identityKey: IDENTITY_KEY,
  issue: ISSUE,
  baseMs: BASE_MS,
});

// ---------------------------------------------------------------------------
// Session + registry fixtures
// ---------------------------------------------------------------------------

let workspace;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'chatops-runtime-'));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

function session(overrides = {}) {
  const repoRoot = join(workspace, 'repo');
  return {
    sessionId: IDENTITY.sessionId,
    repoKey: 'demo',
    repoRoot,
    githubRepo: 'm2dw/demo',
    artifactDir: '.artifacts',
    artifactRoot: join(repoRoot, '.artifacts'),
    githubOwner: 'm2dw',
    githubName: 'demo',
    defaults: {},
    verification: {},
    labels: {},
    workItemProvider: { provider: 'github-issues', auth: { mode: 'gh' } },
    repoHostProvider: { provider: 'github', auth: { mode: 'gh' } },
    repoHostProviderConfigured: false,
    chatOps: { enabled: true, authorAllowlist: ['alice'], automationLogins: ['loop-bot'] },
    ...overrides,
  };
}

function witnessPath() {
  return join(workspace, 'witness', 'epoch-witness.json');
}

function seedWitness(epoch) {
  mkdirSync(join(workspace, 'witness'), { recursive: true });
  writeFileSync(witnessPath(), JSON.stringify({ epoch }), 'utf8');
}

function grantRegistry(run) {
  return createOperationRegistry([
    {
      id: 'tool-request.run',
      summary: 'Guided-run the approved command for this issue.',
      mutating: true,
      scope: 'issue',
      params: [{ name: 'disposition', type: 'string' }],
      run,
    },
  ]);
}

async function pass(store, port, extra = {}) {
  return runChatOpsPass({
    session: extra.session ?? session(),
    identity: IDENTITY,
    store,
    port,
    registry: extra.registry ?? grantRegistry(() => operationExecuted('ran the approved command')),
    issueNumbers: [ISSUE],
    witnessPath: witnessPath(),
    now: () => BASE_MS + (extra.nowOffsetMs ?? 0),
    ...(extra.maxScanPages === undefined ? {} : { maxScanPages: extra.maxScanPages }),
  });
}

/** Bootstrap the scope so later passes see a genuinely new comment. */
async function bootstrap(store, port, extra = {}) {
  return pass(store, port, extra);
}

const GRANT = (id, offset) => comment(id, 'alice', '/grant --disposition commit', offset);

// ---------------------------------------------------------------------------

describe('chatops pass — enablement gate', () => {
  test('a disabled session touches nothing at all', async () => {
    const store = createMemoryStore();
    const port = createFakePort([GRANT(1, 10)]);
    const result = await pass(store, port, {
      session: session({ chatOps: { enabled: false } }),
    });
    expect(result.outcome).toBe('disabled');
    expect(result.issues).toEqual([]);
    expect(port.posted).toEqual([]);
    expect(store.rowsFor()).toEqual([]);
    expect(store.cursorFor()).toBeUndefined();
  });
});

describe('chatops pass — bootstrap', () => {
  test('a pre-existing command is recorded, reported, and never run', async () => {
    const store = createMemoryStore();
    const port = createFakePort([GRANT(1, 10)]);
    const result = await pass(store, port);
    const issue = result.issues[0];
    expect(issue.bootstrapped).toBe(true);
    expect(issue.bootstrapSkipped).toBe(1);
    expect(issue.claimed).toBe(0);
    expect(port.posted).toEqual([]);
    expect(store.row('1').state).toBe('rejected');
    expect(store.auditFor('1')[0]).toMatchObject({
      kind: 'rejection',
      dispatched: false,
      reason: 'bootstrap-backlog',
      operationId: null,
      requestId: null,
    });
    // The sentinel is persisted even though the position is not null, so the
    // next scan is never mistaken for a first-ever one.
    expect(store.cursorFor().initialized).toBe(true);
  });

  test('an issue with no comments still records the initialization sentinel', async () => {
    const store = createMemoryStore();
    const port = createFakePort([]);
    await pass(store, port);
    expect(store.cursorFor()).toEqual({ initialized: true, cursor: null });
  });
});

describe('chatops pass — the happy path', () => {
  test('discovers, authorizes, maps, dispatches once, and publishes the contracted result', async () => {
    const store = createMemoryStore();
    const port = createFakePort([comment(1, 'alice', 'context, not a command', 10)]);
    await bootstrap(store, port);

    port.comments.push(GRANT(2, 20));
    const invocations = [];
    const result = await pass(store, port, {
      registry: grantRegistry((invocation) => {
        invocations.push(invocation);
        return operationExecuted('ran the approved command');
      }),
    });

    expect(result.outcome).toBe('processed');
    expect(invocations).toHaveLength(1);
    // The trusted half is built from ledger-scope facts, never from the body.
    expect(invocations[0].context).toMatchObject({
      surface: 'chatops',
      actor: { kind: 'human', id: 'alice' },
      sessionId: IDENTITY.sessionId,
      issueNumber: ISSUE,
      confirmed: true,
    });
    expect(invocations[0].request).toEqual({
      operationId: 'tool-request.run',
      params: { disposition: 'commit' },
    });

    // Claim marker first, then the operation, then the acknowledgement marker.
    expect(port.posted.map((p) => p.body)).toEqual([
      '<!-- chatops-claimed:2 -->',
      '<!-- chatops-ack:2:executed -->',
    ]);

    const row = store.row('2');
    expect(row).toMatchObject({
      state: 'acknowledged',
      outcome: 'executed',
      attempts: 1,
      ackPublication: 'published',
    });

    const summary = store.effects().find((e) => e.idempotencyKey.includes('chatops-summary'));
    expect(summary.topic).toBe('workitem:comment');
    expect(summary.payload.body.split('\n')[0]).toBe(CHATOPS_SUMMARY_HEADER);
    expect(summary.payload.body).toContain('ran the approved command');
    // The summary is a separate comment; it never carries marker-shaped content.
    expect(summary.payload.body).not.toContain('chatops-ack:');

    expect(store.auditFor('2')).toEqual([
      expect.objectContaining({
        kind: 'success',
        dispatched: true,
        reason: null,
        operationId: 'tool-request.run',
        surface: 'chatops',
        actorId: 'alice',
      }),
    ]);
  });

  test('dispatches in the provider comment order, not in numeric id order', async () => {
    const store = createMemoryStore();
    const port = createFakePort([]);
    await bootstrap(store, port);

    // Ascending by the contract's order key — (createdAt, id) — but *descending*
    // by id, the shape an issue imported from another tracker has: the original
    // timestamps are preserved under freshly-minted ids. Comment 5 is the
    // earlier command and must run first; sorting by id would run 2 first and
    // could execute a later command before the earlier one it depends on.
    port.comments.push(GRANT(5, 10), GRANT(2, 20));

    const result = await pass(store, port);

    expect(result.outcome).toBe('processed');
    expect(port.posted.map((p) => p.body).filter((b) => b.includes('chatops-claimed'))).toEqual([
      '<!-- chatops-claimed:5 -->',
      '<!-- chatops-claimed:2 -->',
    ]);
  });

  test('replaying the same comment neither re-dispatches nor duplicates the acknowledgement', async () => {
    const store = createMemoryStore();
    const port = createFakePort([]);
    await bootstrap(store, port);
    port.comments.push(GRANT(2, 20));

    let calls = 0;
    const registry = grantRegistry(() => {
      calls += 1;
      return operationExecuted('ran the approved command');
    });
    await pass(store, port, { registry });
    const postedAfterFirst = port.posted.length;
    const effectsAfterFirst = store.effects().length;

    const second = await pass(store, port, { registry, nowOffsetMs: 120_000 });

    expect(calls).toBe(1);
    expect(second.issues[0].dispatchAttempts).toBe(0);
    expect(port.posted.length).toBe(postedAfterFirst);
    expect(store.effects().length).toBe(effectsAfterFirst);
    expect(store.row('2').state).toBe('acknowledged');
    // No fence: the claim and ack markers the first pass posted are exactly the
    // evidence one recorded attempt justifies, so §11.1's predicate stays false.
    expect(store.fenceFor()).toBeUndefined();
  });
});

describe('chatops pass — refusals never reach the port', () => {
  async function refuse(body, author = 'alice', edited) {
    const store = createMemoryStore();
    const port = createFakePort([]);
    await bootstrap(store, port);
    port.comments.push(comment(2, author, body, 20, edited));
    let calls = 0;
    const result = await pass(store, port, {
      registry: grantRegistry(() => {
        calls += 1;
        return operationExecuted('should never run');
      }),
    });
    return { store, port, result, calls };
  }

  test('an unauthorized author is refused silently', async () => {
    const { store, port, calls } = await refuse('/grant --disposition commit', 'mallory');
    expect(calls).toBe(0);
    expect(port.posted).toEqual([]);
    expect(store.row('2').state).toBe('rejected');
    expect(store.auditFor('2')[0]).toMatchObject({ reason: 'unauthorized-author', dispatched: false });
  });

  test('an unsupported verb is refused', async () => {
    const { store, calls } = await refuse('/deploy');
    expect(calls).toBe(0);
    expect(store.auditFor('2')[0]).toMatchObject({ reason: 'unsupported-command' });
  });

  test('an unsupported parameter is refused as invalid-argument', async () => {
    const { store, calls } = await refuse('/grant --bogus x');
    expect(calls).toBe(0);
    expect(store.auditFor('2')[0]).toMatchObject({ reason: 'invalid-argument' });
  });

  test('an edited command is refused as ambiguous rather than guessed at', async () => {
    const { store, calls } = await refuse('/grant --disposition commit', 'alice', 30);
    expect(calls).toBe(0);
    expect(store.auditFor('2')[0]).toMatchObject({ reason: 'ambiguous-edit' });
  });

  test("the system's own marker is never read as a command", async () => {
    const { store, calls } = await refuse('<!-- chatops-claimed:999 -->', 'loop-bot');
    expect(calls).toBe(0);
    expect(store.auditFor('2')[0]).toMatchObject({ reason: 'marker-comment' });
    // A marker naming a comment this scope has no record of is a reported
    // defect, not evidence — so it never fences the scope.
    expect(store.fenceFor()).toBeUndefined();
  });

  test('every refusal is terminal with no publication owed', async () => {
    const { store } = await refuse('/deploy');
    expect(store.row('2')).toMatchObject({ state: 'rejected', ackPublication: 'not-required' });
    expect(store.effects()).toEqual([]);
  });
});

describe('chatops pass — fail-closed scanning', () => {
  test('an incomplete window advances nothing and asks to be called again', async () => {
    const store = createMemoryStore();
    const port = createFakePort([]);
    await bootstrap(store, port);
    const before = store.cursorFor();

    port.alwaysHasMore = true;
    port.comments.push(GRANT(2, 20));
    const result = await pass(store, port, { maxScanPages: 2 });

    expect(result.outcome).toBe('delayed');
    expect(store.cursorFor()).toEqual(before);
    expect(store.row('2')).toBeUndefined();
    expect(port.posted).toEqual([]);
  });

  test('a provider read failure is retryable and advances nothing', async () => {
    const store = createMemoryStore();
    const port = createFakePort([], { listFailure: 'gh api list comments failed (exit 1)' });
    const result = await pass(store, port);
    expect(result.outcome).toBe('delayed');
    expect(store.cursorFor()).toBeUndefined();
  });
});

describe('chatops pass — restore detection', () => {
  test('a witness ahead of the database fences the session and dispatches nothing', async () => {
    const store = createMemoryStore();
    const port = createFakePort([]);
    await bootstrap(store, port);
    port.comments.push(GRANT(2, 20));

    seedWitness(7); // the filesystem witnessed more dispatch history than the DB has
    let calls = 0;
    const result = await pass(store, port, {
      registry: grantRegistry(() => {
        calls += 1;
        return operationExecuted('should never run');
      }),
    });

    expect(result.epoch.verdict).toBe('restore-detected');
    expect(result.outcome).toBe('failed');
    expect(calls).toBe(0);
    expect(port.posted).toEqual([]);
    expect(store.fenceFor()).toMatchObject({ reason: 'restore-detected' });
    // Discovery still happened (§12) but the claim was deferred rather than written.
    expect(store.row('2')).toBeUndefined();
    const state = await store.loadScope({ identityKey: IDENTITY_KEY, issueNumber: ISSUE });
    expect(state.pendingFirstSeen.map((r) => r.commentId)).toEqual(['2']);
  });

  test('a deferred claim is recovered once the fence is cleared', async () => {
    const store = createMemoryStore();
    const port = createFakePort([]);
    await bootstrap(store, port);
    port.comments.push(GRANT(2, 20));
    seedWitness(7);
    await pass(store, port);

    // The operator clears the fence and re-seeds the witness (chatops-recover).
    await store.commit(
      { identityKey: IDENTITY_KEY, issueNumber: ISSUE },
      { fence: { grain: 'session', record: null } },
    );
    seedWitness(0);

    let calls = 0;
    const result = await pass(store, port, {
      registry: grantRegistry(() => {
        calls += 1;
        return operationExecuted('ran the approved command');
      }),
    });
    expect(calls).toBe(1);
    expect(result.outcome).toBe('processed');
    expect(store.row('2').state).toBe('acknowledged');
  });
});

describe('chatops pass — dispatch and publication failures', () => {
  test('an unconfirmed claim-marker post leaves the row mid-flight, never re-dispatched', async () => {
    const store = createMemoryStore();
    const port = createFakePort([]);
    await bootstrap(store, port);
    port.comments.push(GRANT(2, 20));
    port.postFailure = 'connection reset';

    let calls = 0;
    const result = await pass(store, port, {
      registry: grantRegistry(() => {
        calls += 1;
        return operationExecuted('should never run');
      }),
    });

    expect(result.outcome).toBe('delayed');
    expect(calls).toBe(0);
    expect(store.row('2')).toMatchObject({ state: 'dispatching', attempts: 1 });

    // A second pass must not re-enter dispatch without a verdict.
    port.postFailure = null;
    const second = await pass(store, port, {
      registry: grantRegistry(() => {
        calls += 1;
        return operationExecuted('should never run');
      }),
      nowOffsetMs: 1_000,
    });
    expect(calls).toBe(0);
    expect(second.issues[0].dispatchAttempts).toBe(0);
    expect(store.row('2').attempts).toBe(1);
  });

  test('an indeterminate operation failure records nothing at all', async () => {
    const store = createMemoryStore();
    const port = createFakePort([]);
    await bootstrap(store, port);
    port.comments.push(GRANT(2, 20));

    const result = await pass(store, port, {
      registry: grantRegistry(() => operationFailed('unavailable', 'unknown', 'lost the connection')),
    });

    expect(result.outcome).toBe('delayed');
    // `effect: "unknown"` means the operation cannot vouch for what it did, so
    // the row stays open for reconciliation rather than being retried.
    expect(store.row('2')).toMatchObject({ state: 'dispatching', attempts: 1 });
    expect(store.effects()).toEqual([]);
  });

  test('a proven-no-effect failure schedules a bounded retry', async () => {
    const store = createMemoryStore();
    const port = createFakePort([]);
    await bootstrap(store, port);
    port.comments.push(GRANT(2, 20));

    const result = await pass(store, port, {
      registry: grantRegistry(() => operationFailed('unavailable', 'none', 'nothing ran')),
    });
    expect(result.outcome).toBe('delayed');
    expect(store.row('2')).toMatchObject({ state: 'retry_scheduled', attempts: 1 });
  });

  test('an unregistered operation is a definite, acknowledged rejection', async () => {
    const store = createMemoryStore();
    const port = createFakePort([]);
    await bootstrap(store, port);
    port.comments.push(GRANT(2, 20));

    const result = await pass(store, port, { registry: createOperationRegistry([]) });

    expect(result.outcome).toBe('processed');
    expect(store.row('2')).toMatchObject({ state: 'acknowledged', outcome: 'rejected' });
    expect(store.auditFor('2')[0]).toMatchObject({
      kind: 'rejection',
      dispatched: true,
      reason: 'unknown-operation',
      operationId: 'tool-request.run',
    });
    expect(port.posted.map((p) => p.body)).toEqual([
      '<!-- chatops-claimed:2 -->',
      '<!-- chatops-ack:2:rejected -->',
    ]);
  });

  test('a failed acknowledgement post is retried without repeating the operation', async () => {
    const store = createMemoryStore();
    const port = createFakePort([]);
    await bootstrap(store, port);
    port.comments.push(GRANT(2, 20));

    let calls = 0;
    const registry = grantRegistry(() => {
      calls += 1;
      return operationExecuted('ran the approved command');
    });
    port.postFailure = (body) => (body.startsWith('<!-- chatops-ack:') ? 'rate limited' : null);
    const first = await pass(store, port, { registry });

    expect(calls).toBe(1);
    expect(first.outcome).toBe('delayed');
    expect(store.row('2')).toMatchObject({
      state: 'awaiting_ack',
      outcome: 'executed',
      ackPublication: 'pending',
      ackAttempts: 1,
    });
    const effectsAfterFirst = store.effects().length;

    port.postFailure = null;
    const second = await pass(store, port, { registry, nowOffsetMs: 1_000 });

    expect(calls).toBe(1);
    expect(second.issues[0].acknowledged).toBe(1);
    expect(store.row('2')).toMatchObject({ state: 'acknowledged', ackPublication: 'published' });
    // The summary was enqueued once, at the outcome commit — never re-rendered.
    expect(store.effects().length).toBe(effectsAfterFirst);
  });

  test('publication is abandoned to a person once the attempt cap is spent', async () => {
    const store = createMemoryStore();
    const port = createFakePort([]);
    await bootstrap(store, port);
    port.comments.push(GRANT(2, 20));

    let calls = 0;
    const registry = grantRegistry(() => {
      calls += 1;
      return operationExecuted('ran the approved command');
    });
    port.postFailure = (body) => (body.startsWith('<!-- chatops-ack:') ? 'rate limited' : null);

    let last;
    for (let attempt = 0; attempt < MAX_ACK_PUBLICATION_ATTEMPTS; attempt += 1) {
      last = await pass(store, port, { registry, nowOffsetMs: attempt * 1_000 });
    }

    // Every pass retried the marker and none of them re-ran the command.
    expect(calls).toBe(1);
    expect(last.outcome).toBe('failed');
    expect(store.row('2')).toMatchObject({
      state: 'acknowledged',
      outcome: 'executed',
      ackPublication: 'abandoned',
      ackAttempts: MAX_ACK_PUBLICATION_ATTEMPTS,
      handoff: { reason: 'ack-publication-abandoned' },
    });
    // Nothing is left reserved behind a terminal row.
    expect(store.reservationsFor()).toEqual([]);
    expect(store.auditFor('2').at(-1)).toMatchObject({ kind: 'human-handoff' });
  });
});

describe('chatops pass — bounded by construction', () => {
  test('the per-pass dispatch budget caps how many commands one invocation runs', async () => {
    const store = createMemoryStore();
    const port = createFakePort([]);
    await bootstrap(store, port);
    port.comments.push(GRANT(2, 20), GRANT(3, 30), GRANT(4, 40));

    let calls = 0;
    const result = await pass(store, port, {
      session: session({
        chatOps: {
          enabled: true,
          authorAllowlist: ['alice'],
          automationLogins: ['loop-bot'],
          maxDispatchesPerPass: 2,
        },
      }),
      registry: grantRegistry(() => {
        calls += 1;
        return operationExecuted('ran the approved command');
      }),
    });

    expect(calls).toBe(2);
    expect(result.issues[0].dispatchAttempts).toBe(2);
    expect(store.row('4').state).toBe('claimed');
  });
});

describe('chatops pass — overlapping invocations', () => {
  /**
   * Nothing stops an operator (or a retrying n8n step) from starting a second
   * pass while the first is still running, and both will have loaded the same
   * `claimed` row. The write-ahead is where that has to be settled: the loser
   * must see the winner's committed row and decline, because past this point the
   * next thing either would do is invoke the operation.
   */
  test('a row another pass already claimed is not dispatched a second time', async () => {
    const store = createMemoryStore();
    const port = createFakePort([]);
    await bootstrap(store, port);
    port.comments.push(GRANT(2, 20));

    let calls = 0;
    const registry = grantRegistry(() => {
      calls += 1;
      return operationExecuted('ran the approved command');
    });

    // The overlapping pass, standing in for a second process: it commits its own
    // write-ahead for this comment in the window between this pass reading the
    // row and reaching its own T2.
    let raced = false;
    const contended = {
      ...store,
      async commitWithEpoch(scope, build) {
        if (!raced) {
          raced = true;
          const mine = (await store.loadScope(scope)).rows.find((r) => r.commentId === '2');
          await store.commit(scope, {
            rows: [
              {
                ...mine,
                state: 'dispatching',
                attempts: mine.attempts + 1,
                epoch: 1,
                attemptStartedAtMs: BASE_MS,
              },
            ],
          });
        }
        return store.commitWithEpoch(scope, build);
      },
    };

    const result = await pass(contended, port, { registry });

    expect(calls).toBe(0);
    // Not even a second claim marker: the decline happens before any external
    // effect, so reconciliation is never handed two markers for one command.
    expect(port.posted).toHaveLength(0);
    // Still in flight somewhere else, so this pass reports "call again" rather
    // than concluding the command.
    expect(result.outcome).toBe('delayed');
    // The winner's row is intact: no second epoch was spent and its attempt
    // count was not overwritten by the loser's stale copy.
    expect(store.row('2')).toMatchObject({ state: 'dispatching', attempts: 1, epoch: 1 });
  });

  /**
   * A fence bars new execution, and the write-ahead is the instant a dispatch
   * becomes new execution. An overlapping pass's reconciliation can commit a
   * fence after this pass reconciled, so the fence the write-ahead obeys has to
   * be the one its own transaction reads — a decision made from the pre-fence
   * snapshot would invoke the operation the fence exists to stop.
   */
  test('a fence committed after this pass reconciled still stops the dispatch', async () => {
    const store = createMemoryStore();
    const port = createFakePort([]);
    await bootstrap(store, port);
    port.comments.push(GRANT(2, 20));

    let calls = 0;
    const registry = grantRegistry(() => {
      calls += 1;
      return operationExecuted('ran the approved command');
    });

    // The overlapping pass, standing in for a second process: its reconciliation
    // fences the scope in the window between this pass's reconciliation and its
    // own T2.
    let raced = false;
    const contended = {
      ...store,
      async commitWithEpoch(scope, build) {
        if (!raced) {
          raced = true;
          await store.commit(scope, {
            fence: {
              grain: 'issue',
              record: {
                reason: 'ledger-regression',
                detail: 'markers claim more attempts than the ledger recorded',
                fencedAt: new Date(BASE_MS).toISOString(),
              },
            },
          });
        }
        return store.commitWithEpoch(scope, build);
      },
    };

    const result = await pass(contended, port, { registry });

    expect(calls).toBe(0);
    // Nothing external either: the refusal happens before the claim marker.
    expect(port.posted).toHaveLength(0);
    // And nothing durable: no epoch spent, no attempt recorded, no write-ahead.
    expect(store.row('2')).toMatchObject({ state: 'claimed', attempts: 0 });
    expect(result.outcome).toBe('failed');
    expect(result.issues[0].fenced).toMatchObject({ reason: 'ledger-regression' });
  });

  /**
   * The same hazard on the far side of the operation: a fence committed while
   * the operation is in flight moves this row to `ambiguous`, and a result
   * upserted from the pass's own `dispatching` copy would erase that handoff and
   * publish a summary contradicting the fence.
   */
  test('a dispatch result never overwrites a row a concurrent fence parked', async () => {
    const store = createMemoryStore();
    const port = createFakePort([]);
    await bootstrap(store, port);
    port.comments.push(GRANT(2, 20));

    const scope = { identityKey: IDENTITY_KEY, issueNumber: ISSUE };
    // The overlapping pass, standing in for a second process: it fences the
    // scope and parks this row while the operation is still running.
    const registry = grantRegistry(async () => {
      const mine = (await store.loadScope(scope)).rows.find((r) => r.commentId === '2');
      await store.commit(scope, {
        rows: [
          {
            ...mine,
            state: 'ambiguous',
            handoff: 'ledger-regression',
            detail: 'restored from an earlier state',
          },
        ],
        fence: {
          grain: 'issue',
          record: {
            reason: 'ledger-regression',
            detail: null,
            fencedAt: new Date(BASE_MS).toISOString(),
          },
        },
      });
      return operationExecuted('ran the approved command');
    });

    const result = await pass(store, port, { registry });

    // The fence's handoff row stands, unchanged by the result that arrived after it.
    expect(store.row('2')).toMatchObject({
      state: 'ambiguous',
      handoff: 'ledger-regression',
      outcome: null,
    });
    // ...and no summary comment contradicting the fence was enqueued.
    expect(store.effects().some((e) => e.idempotencyKey.includes('chatops-summary'))).toBe(false);
    // The parked row is an operator's to resolve, so the pass reports a handoff.
    expect(result.outcome).toBe('failed');
  });

  /**
   * And once more on the near side of the operation. An unwritable epoch witness
   * abandons the attempt before anything external happens, which is a truthful
   * no-effect verdict — but the write-ahead is already durable, so an overlapping
   * pass can fence and park this row while the witness write is failing. Upserting
   * the verdict from the pass's own `dispatching` copy would replace that handoff
   * with `retry_scheduled`, and the command would resume by itself the moment the
   * fence was cleared.
   */
  test('a failed epoch witness write never overwrites a row a concurrent fence parked', async () => {
    const store = createMemoryStore();
    const port = createFakePort([]);
    await bootstrap(store, port);
    port.comments.push(GRANT(2, 20));

    // The witness cannot be written: its temp path is a directory, so the
    // write-then-rename that makes the witness atomic has nowhere to land.
    mkdirSync(`${witnessPath()}.tmp`, { recursive: true });

    let calls = 0;
    const registry = grantRegistry(() => {
      calls += 1;
      return operationExecuted('ran the approved command');
    });

    // The overlapping pass, standing in for a second process: it fences the scope
    // and parks this row in the window between this pass's write-ahead and the
    // no-effect verdict the failed witness produces.
    let raced = false;
    const contended = {
      ...store,
      async commitWithEpoch(scope, build) {
        const epoch = await store.commitWithEpoch(scope, build);
        if (epoch !== null && !raced) {
          raced = true;
          const mine = (await store.loadScope(scope)).rows.find((r) => r.commentId === '2');
          await store.commit(scope, {
            rows: [
              {
                ...mine,
                state: 'ambiguous',
                handoff: 'ledger-regression',
                detail: 'restored from an earlier state',
              },
            ],
            fence: {
              grain: 'issue',
              record: {
                reason: 'ledger-regression',
                detail: null,
                fencedAt: new Date(BASE_MS).toISOString(),
              },
            },
          });
        }
        return epoch;
      },
    };

    const result = await pass(contended, port, { registry });

    // Nothing external happened: the abort is before the claim marker.
    expect(calls).toBe(0);
    expect(port.posted).toHaveLength(0);
    // The fence's handoff row stands, and in particular is not `retry_scheduled`.
    expect(store.row('2')).toMatchObject({
      state: 'ambiguous',
      handoff: 'ledger-regression',
      outcome: null,
    });
    expect(result.outcome).toBe('failed');
  });

  /** A crashed dispatch, left with its claim marker and nothing beside it. */
  async function crashedDispatch(store, port) {
    await bootstrap(store, port);
    port.comments.push(GRANT(2, 20));
    // `effect: "unknown"` means the operation cannot vouch for what it did, so
    // the row stays open for reconciliation.
    await pass(store, port, {
      registry: grantRegistry(() => operationFailed('unavailable', 'unknown', 'lost the connection')),
    });
    expect(store.row('2')).toMatchObject({ state: 'dispatching', attempts: 1 });
  }

  test('a claim marker with no acknowledgement past quiescence is a human handoff', async () => {
    const store = createMemoryStore();
    const port = createFakePort([]);
    await crashedDispatch(store, port);

    const second = await pass(store, port, { nowOffsetMs: 120_000 });

    // Row 11: something ran and no evidence can say what it did.
    expect(second.outcome).toBe('failed');
    expect(store.row('2')).toMatchObject({ state: 'ambiguous' });
  });

  /**
   * Reconciliation decides from the ledger, so it carries T2's hazard: a pass
   * that scanned before another pass resolved the command would otherwise upsert
   * its own stale `dispatching` copy — as `ambiguous`, row 11 — over the terminal
   * row the winner committed. Later reconciliation skips `ambiguous` rows, so the
   * finished command would stay parked for manual recovery forever.
   */
  test('a row another pass already resolved is not reconciled back to ambiguous', async () => {
    const store = createMemoryStore();
    const port = createFakePort([]);
    await crashedDispatch(store, port);

    // The overlapping pass, standing in for a second process: it resolves the
    // command in the window between this pass's scan and the commit its
    // reconciliation verdict would land in. A pass's first compare-and-swap is
    // T1's discovery commit; reconciliation's is the second, which is the one
    // this race has to land in front of.
    let swaps = 0;
    const contended = {
      ...store,
      async commitCompareAndSwap(scope, build) {
        swaps += 1;
        if (swaps === 2) {
          const mine = (await store.loadScope(scope)).rows.find((r) => r.commentId === '2');
          await store.commit(scope, {
            rows: [
              { ...mine, state: 'acknowledged', outcome: 'executed', ackPublication: 'published' },
            ],
          });
        }
        return store.commitCompareAndSwap(scope, build);
      },
    };

    const result = await pass(contended, port, { nowOffsetMs: 120_000 });

    expect(store.row('2')).toMatchObject({
      state: 'acknowledged',
      outcome: 'executed',
      ackPublication: 'published',
    });
    expect(result.outcome).not.toBe('failed');
  });

  /**
   * Discovery carries the same hazard one layer earlier: two passes can read the
   * same new comment before either commits T1. A discovery that wrote its scan
   * snapshot over whatever is stored would put a fresh `claimed` row on top of a
   * row the other pass has already dispatched — rolling the ledger back to a
   * state that dispatches the command a second time.
   */
  test('discovery never writes a claim over a row an overlapping pass advanced', async () => {
    const store = createMemoryStore();
    const port = createFakePort([]);
    await bootstrap(store, port);
    port.comments.push(GRANT(2, 20));

    let calls = 0;
    const registry = grantRegistry(() => {
      calls += 1;
      return operationExecuted('ran the approved command');
    });

    // The overlapping pass, standing in for a second process: it discovered the
    // same comment first and has already carried it through dispatch by the time
    // this pass's T1 commits.
    let raced = false;
    const contended = {
      ...store,
      async commitCompareAndSwap(scope, build) {
        if (!raced) {
          raced = true;
          await store.commit(scope, {
            rows: [
              {
                commentId: '2',
                state: 'awaiting_ack',
                outcome: 'executed',
                attempts: 1,
                epoch: 1,
                attemptStartedAtMs: BASE_MS,
                ackPublication: 'pending',
                ackAttempts: 0,
                reconcileAttempts: 0,
                evidence: [],
                evidenceTruncated: false,
                evidenceClaims: 0,
                evidenceAcks: 0,
                handoff: null,
                detail: null,
              },
            ],
          });
        }
        return store.commitCompareAndSwap(scope, build);
      },
    };

    await pass(contended, port, { registry });

    // The winner's row is never rolled back to `claimed`, so this pass finishes
    // the acknowledgement the winner still owed instead of dispatching again.
    expect(store.row('2')).toMatchObject({
      state: 'acknowledged',
      outcome: 'executed',
      attempts: 1,
      ackPublication: 'published',
    });
    expect(calls).toBe(0);
    expect(port.posted.filter((p) => p.body.startsWith('<!-- chatops-ack:2:'))).toHaveLength(1);
    // The first-seen record is still written: a ledger row whose input cannot be
    // re-derived is the one thing T1 may never leave behind.
    expect(await store.getFirstSeen({ identityKey: IDENTITY_KEY, issueNumber: ISSUE }, '2')).toBeDefined();
  });

  /**
   * The acknowledgement post sits between two transactions, which is the one
   * place the ledger's compare-and-set cannot reach: both passes hold the same
   * `awaiting_ack` row and neither has committed. Only the pass that reserves
   * the publication may post, so one command never carries two ack markers.
   */
  test('only one pass publishes the acknowledgement for a command', async () => {
    const store = createMemoryStore();
    const port = createFakePort([]);
    await bootstrap(store, port);
    port.comments.push(GRANT(2, 20));

    port.postFailure = (body) => (body.startsWith('<!-- chatops-ack:') ? 'rate limited' : null);
    await pass(store, port);
    expect(store.row('2')).toMatchObject({ state: 'awaiting_ack', ackPublication: 'pending' });
    port.postFailure = null;
    const postedBefore = port.posted.length;

    // The overlapping pass, standing in for a second process: it takes the
    // reservation in the window between this pass loading the row and reaching
    // its own post.
    const contended = {
      ...store,
      async reserveAckPublication(scope, commentId, accept) {
        store.reserve(commentId, scope.issueNumber);
        return store.reserveAckPublication(scope, commentId, accept);
      },
    };

    const result = await pass(contended, port, { nowOffsetMs: 1_000 });

    // No second marker, and no attempt spent on one: the publication belongs to
    // whoever holds the reservation.
    expect(port.posted.length).toBe(postedBefore);
    expect(result.outcome).toBe('delayed');
    expect(store.row('2')).toMatchObject({
      state: 'awaiting_ack',
      ackPublication: 'pending',
      ackAttempts: 1,
    });
  });

  /**
   * A reservation that outlives its pass means the post is *unconfirmed* — the
   * same state a dropped claim-marker post leaves behind. Nothing is assumed
   * about whether the marker landed: the attempt is settled as one failure
   * (row 18), the reservation is released, and a later pass republishes.
   */
  test('a publication reservation left by a dead pass is settled and then retried', async () => {
    const store = createMemoryStore();
    const port = createFakePort([]);
    await bootstrap(store, port);
    port.comments.push(GRANT(2, 20));

    port.postFailure = (body) => (body.startsWith('<!-- chatops-ack:') ? 'rate limited' : null);
    await pass(store, port);
    port.postFailure = null;
    const postedBefore = port.posted.length;

    // The dead pass: it reserved the publication and never recorded a result.
    store.reserve('2');

    const recovering = await pass(store, port, { nowOffsetMs: 1_000 });

    // Nothing is posted while the unconfirmed attempt is outstanding, and the
    // attempt it stands for is counted exactly once.
    expect(port.posted.length).toBe(postedBefore);
    expect(recovering.outcome).toBe('delayed');
    expect(store.row('2')).toMatchObject({
      state: 'awaiting_ack',
      ackPublication: 'pending',
      ackAttempts: 2,
    });
    expect(store.reservationsFor()).toEqual([]);

    const republished = await pass(store, port, { nowOffsetMs: 2_000 });

    expect(republished.issues[0].acknowledged).toBe(1);
    expect(port.posted.length).toBe(postedBefore + 1);
    expect(store.row('2')).toMatchObject({
      state: 'acknowledged',
      ackPublication: 'published',
    });
    expect(store.reservationsFor()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Database maintenance (issue #818, docs/retention-backup-contract.md §9)
//
// A `prune`/`restore` holds a file-level lock, and ChatOps runs ahead of the
// outbox dispatcher in the scheduled child workflow — so it is the first thing
// that could write into a file maintenance is replacing. The guard belongs on
// each write, not on the pass entry: the lock can be acquired between two of one
// pass's transactions, and the ordering rule (write-ahead → claim marker →
// operation) is what makes a refusal there provably effect-free.
// ---------------------------------------------------------------------------

describe('chatops pass — database maintenance lock', () => {
  test('a lock held before the first write leaves the scope untouched and reports delayed', async () => {
    const store = createMemoryStore();
    const port = createFakePort([]);
    await bootstrap(store, port);

    port.comments.push(GRANT(1, 100));
    const runs = [];
    store.lockMaintenanceAfter(0);

    const result = await pass(store, port, {
      registry: grantRegistry((request) => {
        runs.push(request);
        return operationExecuted('ran the approved command');
      }),
    });

    // Retryable, not a failure: nothing is wrong with the scope, the command, or
    // the provider — the next scheduled pass finishes the work.
    expect(result.outcome).toBe('delayed');
    expect(result.issues[0].fenced).toBeNull();
    expect(result.issues[0].notes.join(' ')).toMatch(/maintenance lock/);
    // No claim, no marker, no operation, and the cursor never moved past the
    // comment — so nothing about it has been lost.
    expect(store.row('1')).toBeUndefined();
    expect(port.posted).toEqual([]);
    expect(runs).toEqual([]);
  });

  test('a lock acquired mid-pass stops the write-ahead before any external effect', async () => {
    const store = createMemoryStore();
    const port = createFakePort([]);
    await bootstrap(store, port);

    port.comments.push(GRANT(1, 100));
    const runs = [];
    // Discovery and reconciliation commit; the dispatch write-ahead is the first
    // write to meet the lock.
    store.lockMaintenanceAfter(2);

    const result = await pass(store, port, {
      registry: grantRegistry((request) => {
        runs.push(request);
        return operationExecuted('ran the approved command');
      }),
    });

    expect(result.outcome).toBe('delayed');
    expect(result.issues[0].dispatchAttempts).toBe(0);
    expect(result.issues[0].notes.join(' ')).toMatch(/maintenance lock/);
    // The claim survived, and nothing external was attempted against it: T2 is
    // what precedes the claim marker and the operation, so a refusal there is
    // provably effect-free.
    expect(store.row('1').state).toBe('claimed');
    expect(store.row('1').attempts).toBe(0);
    expect(port.posted).toEqual([]);
    expect(runs).toEqual([]);
  });

  test('the deferred work completes on the next pass once the lock is released', async () => {
    const store = createMemoryStore();
    const port = createFakePort([]);
    await bootstrap(store, port);

    port.comments.push(GRANT(1, 100));
    store.lockMaintenanceAfter(0);
    expect((await pass(store, port)).outcome).toBe('delayed');

    store.lockMaintenanceAfter(Infinity);
    const recovered = await pass(store, port, { nowOffsetMs: 1_000 });

    expect(recovered.issues[0].dispatchResults).toBe(1);
    expect(store.row('1')).toMatchObject({ state: 'acknowledged', outcome: 'executed' });
    // Exactly once, despite the refused pass having read the same comment.
    expect(store.rowsFor()).toHaveLength(1);
  });
});
