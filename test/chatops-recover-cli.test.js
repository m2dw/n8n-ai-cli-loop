/**
 * `chatops-recover --clear-fence` clears the fence the operator *read* (#1024).
 *
 * A fence is the one signal that stops dispatch, and clearing one is an operator
 * action taken minutes after reading `chatops-status`. In between, a scheduled
 * pass can raise a *different* fence — §9.2's witness detector and §11's
 * regression predicate both commit in ordinary transactions — and an
 * unconditional delete would lift that brand-new fence under a clearance granted
 * for the old one, letting the next pass dispatch exactly when it must not.
 *
 * So the clear is a compare-and-swap against the fence the committing
 * transaction itself reads, with `--fenced-at` as the explicit operator-named
 * form. These cases pin both halves, plus the two ordinary outcomes (a fence
 * cleared, and no fence to clear).
 *
 * Everything runs in-process against the exported `main()` with the CLI's IO
 * sink rebound; nothing here talks to a provider.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { main } from '../dist/cli/chatops-recover.js';
import { SqliteChatOpsStore } from '../dist/stores/sqlite-chatops-store.js';
import { JsonSessionRegistry } from '../dist/registries/json-session-registry.js';
import {
  chatOpsIdentityKey,
  deriveChatOpsProviderIdentity,
} from '../dist/core/chatops-identity.js';
import { CliExit, resetCliIoSink, setCliIoSink } from '../dist/cli/cli-io.js';

let tmpDir;
let sessionsPath;
let dbPath;

const OLD_FENCE = {
  reason: 'restore-detected',
  detail: 'epoch witness ahead of the database',
  fencedAt: '2026-01-01T00:00:00.000Z',
};
/** What a pass running concurrently with the operator's clear would record. */
const NEW_FENCE = {
  reason: 'conflicting-evidence',
  detail: 'marker for a comment with no dispatch',
  fencedAt: '2026-02-02T00:00:00.000Z',
};

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'chatops-recover-cli-'));
  sessionsPath = join(tmpDir, 'sessions.json');
  dbPath = join(tmpDir, 'dev_loop.db');
  writeFileSync(
    sessionsPath,
    JSON.stringify({
      sessions: [
        {
          sessionId: 'chatops-cli',
          repoKey: 'demo',
          repoRoot: tmpDir,
          githubRepo: 'm2dw/demo',
          artifactDir: '.artifacts',
          defaults: { implementationAgent: 'claude', reviewAgent: 'codex' },
          verification: {},
          labels: {
            active: 'ai:active',
            blocked: 'ai:blocked',
            readyForHuman: 'ai:ready-for-human',
          },
          chatOps: { enabled: true, authorAllowlist: ['alice'], automationLogins: ['demo-bot'] },
        },
      ],
    }),
    'utf8',
  );
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

async function identityKey() {
  const registry = new JsonSessionRegistry(sessionsPath);
  const session = await registry.getSessionById('chatops-cli');
  return chatOpsIdentityKey(deriveChatOpsProviderIdentity(session));
}

const SCOPE = async () => ({ identityKey: await identityKey(), issueNumber: 42 });

/** The parked row both operator transitions decide from (contract rows 21, 22). */
const AMBIGUOUS_ROW = (overrides = {}) => ({
  commentId: '7',
  state: 'ambiguous',
  outcome: null,
  attempts: 1,
  epoch: 1,
  attemptStartedAtMs: Date.parse('2026-01-01T00:00:00Z'),
  ackPublication: 'not-required',
  ackAttempts: 0,
  reconcileAttempts: 1,
  evidence: [],
  evidenceTruncated: false,
  evidenceClaims: 1,
  evidenceAcks: 0,
  handoff: { reason: 'reconcile-inconclusive', detail: null, fenceScope: false },
  detail: 'a claim marker with no acknowledgement',
  ...overrides,
});

async function writeRow(row) {
  const store = new SqliteChatOpsStore(dbPath);
  try {
    await store.commit(await SCOPE(), { rows: [row] });
  } finally {
    store.close();
  }
}

async function readRow(commentId = '7') {
  const store = new SqliteChatOpsStore(dbPath);
  try {
    return (await store.loadScope(await SCOPE())).rows.find((r) => r.commentId === commentId);
  } finally {
    store.close();
  }
}

/**
 * A store that reports `observed` as the ledger row while the database holds
 * whatever a concurrent writer has since committed — the interleaving the
 * compare-and-swap exists for, and one a second in-process connection cannot
 * produce because a SQLite transaction is not re-entrant.
 */
function staleRowStore(observed) {
  const real = new SqliteChatOpsStore(dbPath);
  return {
    getEpoch: (key) => real.getEpoch(key),
    loadScope: async (scope) => ({ ...(await real.loadScope(scope)), rows: [observed] }),
    getFirstSeen: (scope, commentId) => real.getFirstSeen(scope, commentId),
    listIssueNumbers: (key) => real.listIssueNumbers(key),
    commit: (scope, input) => real.commit(scope, input),
    commitCompareAndSwap: (scope, build) => real.commitCompareAndSwap(scope, build),
    reserveAckPublication: (scope, commentId, accept) =>
      real.reserveAckPublication(scope, commentId, accept),
    listAudit: (scope, commentId) => real.listAudit(scope, commentId),
    close: () => real.close(),
  };
}

async function writeFence(record) {
  const store = new SqliteChatOpsStore(dbPath);
  try {
    await store.commit(await SCOPE(), { fence: { grain: 'issue', record } });
  } finally {
    store.close();
  }
}

async function readFence() {
  const store = new SqliteChatOpsStore(dbPath);
  try {
    return (await store.loadScope(await SCOPE())).issueFence;
  } finally {
    store.close();
  }
}

async function runRecover(args, deps = {}) {
  const stdout = [];
  const stderr = [];
  let exitCode;
  setCliIoSink({
    stdout: (chunk) => stdout.push(chunk),
    stderr: (chunk) => stderr.push(chunk),
    exit(code) {
      exitCode = code;
      throw new CliExit(code);
    },
  });
  try {
    await main([...args], deps);
  } catch (err) {
    if (!(err instanceof CliExit)) throw err;
  } finally {
    resetCliIoSink();
  }
  return { code: exitCode ?? 0, json: JSON.parse(stdout.join('')), stderr: stderr.join('') };
}

const CLEAR_ARGS = () => [
  '--session-id',
  'chatops-cli',
  '--sessions-path',
  sessionsPath,
  '--db-path',
  dbPath,
  '--clear-fence',
  '--grain',
  'issue',
  '--issue-number',
  '42',
];

describe('chatops-recover --clear-fence', () => {
  test('clears the fence it was shown', async () => {
    await writeFence(OLD_FENCE);

    const { code, json } = await runRecover(CLEAR_ARGS());

    expect(code).toBe(0);
    expect(json).toMatchObject({
      ok: true,
      action: 'clear-fence',
      grain: 'issue',
      issueNumber: 42,
      cleared: true,
      fence: { reason: 'restore-detected', fencedAt: OLD_FENCE.fencedAt },
    });
    expect(await readFence()).toBeNull();
  });

  test('reports a recorded no-op when there is no fence at that grain', async () => {
    // The database exists but the scope was never fenced.
    new SqliteChatOpsStore(dbPath).close();

    const { code, json } = await runRecover(CLEAR_ARGS());

    expect(code).toBe(0);
    expect(json).toMatchObject({ ok: true, action: 'clear-fence', cleared: false });
    expect(json.note).toMatch(/no issue-grain fence/);
  });

  test('refuses when a concurrent pass fenced the scope after the operator read it', async () => {
    await writeFence(NEW_FENCE);
    // The store this command sees reports the fence as it was *before* the
    // concurrent pass committed — the interleaving the compare-and-swap exists
    // for, and one a second in-process connection cannot produce because a
    // SQLite transaction is not re-entrant.
    const real = new SqliteChatOpsStore(dbPath);
    const stale = {
      getEpoch: (key) => real.getEpoch(key),
      loadScope: async (scope) => ({ ...(await real.loadScope(scope)), issueFence: OLD_FENCE }),
      commit: (scope, input) => real.commit(scope, input),
      commitCompareAndSwap: (scope, build) => real.commitCompareAndSwap(scope, build),
      close: () => real.close(),
    };

    const { code, json } = await runRecover(CLEAR_ARGS(), { store: stale });

    expect(code).toBe(1);
    expect(json.ok).toBe(false);
    expect(json.error).toMatch(/fence changed while it was being cleared/);
    expect(json.error).toMatch(/conflicting-evidence/);
    // The bug this pins: the new fence must survive a clear aimed at the old one.
    expect(await readFence()).toMatchObject({ reason: 'conflicting-evidence' });
  });

  test('refuses a --fenced-at that names a different fence, and leaves it in place', async () => {
    await writeFence(NEW_FENCE);

    const { code, json } = await runRecover([...CLEAR_ARGS(), '--fenced-at', OLD_FENCE.fencedAt]);

    expect(code).toBe(1);
    expect(json.error).toMatch(/does not name the issue-grain fence/);
    expect(await readFence()).toMatchObject({ fencedAt: NEW_FENCE.fencedAt });
  });

  /**
   * A re-raise carries the same reason and detail as the fence already on the
   * row, so `fencedAt` is the only part of the fence version that moves. If the
   * upsert kept the stored timestamp, the operator's stale `--fenced-at` would
   * still match and clear a fence raised by an observation they never saw.
   */
  test('a re-raised fence advances fencedAt, so a stale --fenced-at is refused', async () => {
    await writeFence(OLD_FENCE);
    const reRaised = { ...OLD_FENCE, fencedAt: '2026-03-03T00:00:00.000Z' };
    await writeFence(reRaised);

    expect(await readFence()).toMatchObject({ fencedAt: reRaised.fencedAt });

    const { code, json } = await runRecover([...CLEAR_ARGS(), '--fenced-at', OLD_FENCE.fencedAt]);

    expect(code).toBe(1);
    expect(json.error).toMatch(/does not name the issue-grain fence/);
    expect(await readFence()).toMatchObject({ fencedAt: reRaised.fencedAt });
  });

  test('clears the fence a matching --fenced-at names', async () => {
    await writeFence(NEW_FENCE);

    const { code, json } = await runRecover([...CLEAR_ARGS(), '--fenced-at', NEW_FENCE.fencedAt]);

    expect(code).toBe(0);
    expect(json).toMatchObject({ cleared: true });
    expect(await readFence()).toBeNull();
  });

  test('refuses --fenced-at without --clear-fence rather than ignoring it', async () => {
    const { code, json } = await runRecover([
      '--session-id',
      'chatops-cli',
      '--sessions-path',
      sessionsPath,
      '--db-path',
      dbPath,
      '--seed-witness',
      '--fenced-at',
      OLD_FENCE.fencedAt,
    ]);

    expect(code).toBe(1);
    expect(json.error).toMatch(/--fenced-at only applies to --clear-fence/);
  });
});

/**
 * The same hazard on the two operator transitions. `--resolve` and `--retry`
 * both decide from a row an operator *read*, minutes earlier, in
 * `chatops-status`. Between that reading and the write, a second operator (or a
 * retried n8n step running this same command) can settle the row — and an
 * unconditional upsert would apply a decision about a state that no longer
 * exists, silently replacing the earlier outcome. Worse for `--resolve`: the
 * summary effect is keyed on the ledger row, so the outbox keeps whichever
 * caller enqueued it first, and the published comment would then describe an
 * outcome the ledger no longer records.
 */
describe('chatops-recover — operator transitions are compare-and-swapped', () => {
  const OPERATOR_ARGS = (action, extra = []) => [
    '--session-id',
    'chatops-cli',
    '--sessions-path',
    sessionsPath,
    '--db-path',
    dbPath,
    '--issue-number',
    '42',
    '--comment-id',
    '7',
    '--operator',
    'alice',
    action,
    ...extra,
  ];

  test('--resolve applies to the row it was shown', async () => {
    await writeRow(AMBIGUOUS_ROW());

    const { code, json } = await runRecover(
      OPERATOR_ARGS('--resolve', ['--outcome', 'executed']),
    );

    expect(code).toBe(0);
    expect(json).toMatchObject({ ok: true, action: 'resolve', row: 21, state: 'awaiting_ack' });
    expect(await readRow()).toMatchObject({ state: 'awaiting_ack', outcome: 'executed' });
  });

  test('--resolve refuses when another writer already settled the row', async () => {
    // The winner: a first `--resolve executed` that already landed.
    await writeRow(
      AMBIGUOUS_ROW({
        state: 'awaiting_ack',
        outcome: 'executed',
        ackPublication: 'pending',
        handoff: null,
        detail: 'resolved by bob as executed',
      }),
    );

    const { code, json } = await runRecover(
      OPERATOR_ARGS('--resolve', ['--outcome', 'rejected']),
      { store: staleRowStore(AMBIGUOUS_ROW()) },
    );

    expect(code).toBe(1);
    expect(json.ok).toBe(false);
    expect(json.error).toMatch(/changed while it was being recorded/);
    // The bug this pins: the second decision must not replace the first, whose
    // summary comment the outbox has already accepted under the same key.
    expect(await readRow()).toMatchObject({
      state: 'awaiting_ack',
      outcome: 'executed',
      detail: 'resolved by bob as executed',
    });
  });

  test('--retry applies to the row it was shown', async () => {
    await writeRow(AMBIGUOUS_ROW());

    const { code, json } = await runRecover(
      OPERATOR_ARGS('--retry', ['--reason', 'the grant never ran']),
    );

    expect(code).toBe(0);
    expect(json).toMatchObject({ ok: true, action: 'retry', row: 22, state: 'retry_scheduled' });
    expect(await readRow()).toMatchObject({
      state: 'retry_scheduled',
      detail: 'retry authorized by alice: the grant never ran',
    });
  });

  test('--retry refuses when another writer already settled the row', async () => {
    // The winner: a first `--retry` recorded against a different operator and
    // reason. Losing that record is losing the whole point of row 22.
    await writeRow(
      AMBIGUOUS_ROW({
        state: 'retry_scheduled',
        handoff: null,
        reconcileAttempts: 0,
        detail: 'retry authorized by bob: the operation timed out',
      }),
    );

    const { code, json } = await runRecover(
      OPERATOR_ARGS('--retry', ['--reason', 'the grant never ran']),
      { store: staleRowStore(AMBIGUOUS_ROW()) },
    );

    expect(code).toBe(1);
    expect(json.ok).toBe(false);
    expect(json.error).toMatch(/changed while it was being recorded/);
    expect(await readRow()).toMatchObject({
      state: 'retry_scheduled',
      detail: 'retry authorized by bob: the operation timed out',
    });
  });

  /**
   * A state the ledger refuses outright is still reported as a refusal — the
   * compare-and-swap must not turn every unhappy path into "the row changed".
   */
  test('a state the ledger refuses is reported as a refusal, not a lost race', async () => {
    await writeRow(AMBIGUOUS_ROW({ state: 'claimed', handoff: null }));

    const { code, json } = await runRecover(
      OPERATOR_ARGS('--resolve', ['--outcome', 'executed']),
    );

    expect(code).toBe(1);
    expect(json.error).toMatch(/resolve refused/);
    expect(json.error).toMatch(/illegal-transition/);
    expect(await readRow()).toMatchObject({ state: 'claimed' });
  });
});
