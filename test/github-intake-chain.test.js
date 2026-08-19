/**
 * Incremental chain registration during GitHub intake (issue #790) —
 * end-to-end through `runIntake` against a temp SQLite file.
 *
 * Covers the acceptance scenarios: new chain, append, fan-in, repeated
 * intake, existing task, transient failure, duplicate-comment suppression,
 * and frozen-prefix conflict — plus the resolved-error label cleanup and the
 * Gate-2 stacked base decision.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  SqliteChainRegistryStore,
  SqliteOutboxStore,
  SqliteTaskStore,
} from '../dist/index.js';
import { SqliteMaintenanceLock } from '../dist/stores/sqlite-maintenance-lock.js';
import { runIntake } from '../dist/cli/github-intake.js';

const SESSION = {
  sessionId: 'addon-dev',
  repoKey: 'thunderbird-auth-results-filter',
  repoRoot: '/Users/moto/git/thunderbird-auth-results-filter',
  githubRepo: 'm2dw/thunderbird-auth-results-filter',
  artifactDir: '.n8n-artifacts',
  defaults: { implementationAgent: 'claude', reviewAgent: 'codex', researchAgent: 'gemini' },
  verification: { test: 'npm test' },
  labels: { active: 'ai:active', blocked: 'ai:blocked', readyForHuman: 'ai:ready-for-human' },
};

const IMPL = ['agent:claude', 'status:needs-implementation'];

function issue(number, labels = IMPL) {
  return {
    number,
    title: `Issue ${number}`,
    url: `https://github.com/m2dw/thunderbird-auth-results-filter/issues/${number}`,
    labels: labels.map((name) => ({ name })),
  };
}

function ghWith(...issues) {
  return { listIssues: () => issues };
}

/** Dep checker answering from a `{ [issueNumber]: BlockedByEntry[] }` map. */
function checker(map) {
  return { getBlockedBy: async (n) => map[n] ?? [] };
}

const done = (n) => ({ issueNumber: n, state: 'closed', stateReason: 'completed' });

let tmpDir;
let sessionsPath;
let dbPath;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'github-intake-chain-test-'));
  sessionsPath = join(tmpDir, 'sessions.json');
  dbPath = join(tmpDir, 'dev_loop.db');
  writeFileSync(sessionsPath, JSON.stringify({ sessions: [SESSION] }), 'utf8');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

async function intake(gh, depChecker, stackReadyResolver) {
  const args = {
    sessionId: 'addon-dev',
    sessionsPath,
    dbPath,
    limit: 100,
    dryRun: false,
    supportedPhases: ['implementation', 'review'],
  };
  const chunks = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => { chunks.push(chunk); return true; };
  try {
    await runIntake(args, gh, depChecker, stackReadyResolver);
  } finally {
    process.stdout.write = origWrite;
  }
  return JSON.parse(chunks.join('').trim());
}

async function withChainStore(fn) {
  const store = new SqliteChainRegistryStore(dbPath);
  try {
    return await fn(store);
  } finally {
    store.close();
  }
}

async function listOutbox() {
  const outbox = new SqliteOutboxStore(dbPath);
  try {
    return await outbox.listPending();
  } finally {
    outbox.close();
  }
}

const key = (issueNumber) => ({ sessionId: 'addon-dev', issueNumber });

test('a first-time candidate creates its chain and freezes the prefix with the created task', async () => {
  const out = await intake(ghWith(issue(101)), checker({}));
  expect(out).toMatchObject({ ok: true, enqueued: 1, chainBlocked: 0, chainDeferred: 0 });

  await withChainStore(async (store) => {
    const chains = await store.listChainsForIssue(101, { sessionId: 'addon-dev' });
    expect(chains).toHaveLength(1);
    expect(chains[0]).toMatchObject({
      chainId: 'chain_101',
      headIssueNumber: 101,
      graphRevision: 1,
      acceptedRevision: 1,
    });
    const frozen = await store.getFrozenPrefix(key(101));
    expect(frozen).toMatchObject({
      chainId: 'chain_101',
      ancestors: [],
      predecessors: [],
      base: { kind: 'default', baseRef: 'main' },
      source: 'github-intake',
    });
  });

  const tasks = new SqliteTaskStore(dbPath);
  expect(await tasks.getTask(key(101))).toMatchObject({ status: 'queued', phase: 'implementation' });
  tasks.close();
});

test('a downstream candidate appends to its blocker chain with its incoming edge', async () => {
  await intake(ghWith(issue(101)), checker({}));
  const out = await intake(ghWith(issue(101), issue(102)), checker({ 102: [done(101)] }));
  expect(out).toMatchObject({ ok: true, enqueued: 1, alreadyExists: 1, chainBlocked: 0 });

  await withChainStore(async (store) => {
    const graph = await store.getChain('chain_101');
    expect(graph.members.map((m) => m.issueNumber).sort((a, b) => a - b)).toEqual([101, 102]);
    expect(graph.edges).toEqual([
      expect.objectContaining({ blockerIssueNumber: 101, blockedIssueNumber: 102 }),
    ]);
    expect(graph.chain.acceptedRevision).toBe(2);
    const frozen = await store.getFrozenPrefix(key(102));
    expect(frozen).toMatchObject({
      chainId: 'chain_101',
      ancestors: [101],
      predecessors: [101],
      order: [101, 102],
    });
  });
});

test('valid fan-in at a new downstream issue joins the chain without rewriting started ancestry', async () => {
  await intake(ghWith(issue(101)), checker({}));
  await intake(ghWith(issue(101), issue(102)), checker({ 102: [done(101)] }));

  const before = await withChainStore(async (store) => ({
    frozen101: await store.getFrozenPrefix(key(101)),
    frozen102: await store.getFrozenPrefix(key(102)),
  }));

  const out = await intake(
    ghWith(issue(101), issue(102), issue(103)),
    checker({ 102: [done(101)], 103: [done(101), done(102)] }),
  );
  expect(out).toMatchObject({ ok: true, enqueued: 1, alreadyExists: 2, chainBlocked: 0 });

  await withChainStore(async (store) => {
    const graph = await store.getChain('chain_101');
    expect(graph.members.map((m) => m.issueNumber).sort((a, b) => a - b)).toEqual([101, 102, 103]);
    const edges = graph.edges
      .map((e) => [e.blockerIssueNumber, e.blockedIssueNumber])
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    expect(edges).toEqual([
      [101, 102],
      [101, 103],
      [102, 103],
    ]);
    const frozen103 = await store.getFrozenPrefix(key(103));
    expect(frozen103).toMatchObject({ ancestors: [101, 102], predecessors: [101, 102] });
    // Fan-in must not have moved the already-started Issues' contracts.
    expect(await store.getFrozenPrefix(key(101))).toEqual(before.frozen101);
    expect(await store.getFrozenPrefix(key(102))).toEqual(before.frozen102);
  });
}, 30_000);

test('repeated intake is idempotent: no new chain state, no re-freeze, already_exists', async () => {
  await intake(ghWith(issue(101), issue(102)), checker({ 102: [done(101)] }));
  const before = await withChainStore(async (store) => ({
    record: (await store.listChainsForIssue(101, { sessionId: 'addon-dev' }))[0],
    frozen102: await store.getFrozenPrefix(key(102)),
  }));

  const out = await intake(ghWith(issue(101), issue(102)), checker({ 102: [done(101)] }));
  expect(out).toMatchObject({ ok: true, enqueued: 0, alreadyExists: 2, chainBlocked: 0, chainDeferred: 0 });

  await withChainStore(async (store) => {
    const after = (await store.listChainsForIssue(101, { sessionId: 'addon-dev' }))[0];
    expect(after.graphRevision).toBe(before.record.graphRevision);
    expect(after.acceptedRevision).toBe(before.record.acceptedRevision);
    expect(await store.listChainsForIssue(102, { sessionId: 'addon-dev' })).toHaveLength(1);
    expect(await store.getFrozenPrefix(key(102))).toEqual(before.frozen102);
  });
});

test('an existing task is left untouched: chain registered, nothing frozen retroactively', async () => {
  const tasks = new SqliteTaskStore(dbPath);
  await tasks.enqueueTask({ sessionId: 'addon-dev', issueNumber: 101, phase: 'implementation' });
  tasks.close();

  const out = await intake(ghWith(issue(101)), checker({}));
  expect(out).toMatchObject({ ok: true, enqueued: 0, alreadyExists: 1 });
  expect(out.results.find((r) => r.issueNumber === 101)).toMatchObject({ action: 'already_exists' });

  await withChainStore(async (store) => {
    expect(await store.listChainsForIssue(101, { sessionId: 'addon-dev' })).toHaveLength(1);
    // The freeze belongs to task creation; a pre-existing task is not
    // retroactively pinned by a later poll.
    expect(await store.getFrozenPrefix(key(101))).toBeUndefined();
  });
});

test('a transient relationship failure holds the candidate with no public effects and no error record', async () => {
  const throwing = { getBlockedBy: async () => { throw new Error('boom'); } };
  const out = await intake(ghWith(issue(101)), throwing);
  // Fail closed at the dependency gate: the issue is not even a candidate.
  expect(out).toMatchObject({ ok: true, candidates: 0, enqueued: 0, chainBlocked: 0 });

  expect(await listOutbox()).toEqual([]);
  await withChainStore(async (store) => {
    expect(await store.getChainIntakeError(key(101))).toBeUndefined();
    expect(await store.listChainsForIssue(101, { sessionId: 'addon-dev' })).toEqual([]);
  });
});

test('blockers spanning two chains refuse structurally with one idempotent comment and label', async () => {
  await intake(ghWith(issue(101), issue(104)), checker({}));

  const out = await intake(
    ghWith(issue(101), issue(104), issue(105)),
    checker({ 105: [done(101), done(104)] }),
  );
  expect(out).toMatchObject({ ok: true, enqueued: 0, alreadyExists: 2, chainBlocked: 1 });
  expect(out.results.find((r) => r.issueNumber === 105)).toMatchObject({
    action: 'chain_blocked',
    kind: 'structural',
    commented: true,
  });

  const tasks = new SqliteTaskStore(dbPath);
  expect(await tasks.getTask(key(105))).toBeUndefined();
  tasks.close();

  const pending = await listOutbox();
  const labels = pending.filter(
    (e) => e.topic === 'gh:label:add' && e.payload.issueNumber === 105 && e.payload.label === 'ai:blocked',
  );
  const comments = pending.filter((e) => e.topic === 'gh:comment' && e.payload.issueNumber === 105);
  expect(labels).toHaveLength(1);
  expect(comments).toHaveLength(1);
  expect(comments[0].payload.body).toContain('Dependency chain registration blocked');
  expect(comments[0].payload.body).toContain('#101');
  expect(comments[0].payload.body).toContain('#104');

  await withChainStore(async (store) => {
    expect(await store.getChainIntakeError(key(105))).toMatchObject({ kind: 'structural' });
    // The prior graphs were preserved.
    expect((await store.getChain('chain_101')).chain.acceptedRevision).toBe(1);
    expect((await store.getChain('chain_104')).chain.acceptedRevision).toBe(1);
  });

  // Same failure on the next poll: suppressed, not re-published.
  const again = await intake(
    ghWith(issue(101), issue(104), issue(105)),
    checker({ 105: [done(101), done(104)] }),
  );
  expect(again.results.find((r) => r.issueNumber === 105)).toMatchObject({
    action: 'chain_blocked',
    commented: false,
  });
  const pendingAgain = await listOutbox();
  expect(
    pendingAgain.filter((e) => e.topic === 'gh:comment' && e.payload.issueNumber === 105),
  ).toHaveLength(1);
  expect(
    pendingAgain.filter(
      (e) => e.topic === 'gh:label:add' && e.payload.issueNumber === 105 && e.payload.label === 'ai:blocked',
    ),
  ).toHaveLength(1);
}, 30_000);

test('a frozen-prefix conflict blocks enqueue, preserves the prior graph, and clears safely once resolved', async () => {
  await intake(ghWith(issue(101)), checker({}));
  await intake(ghWith(issue(101), issue(102)), checker({ 102: [done(101)] }));

  // The observed relationships then drop 102's pinned incoming edge.
  const out = await intake(ghWith(issue(101), issue(102)), checker({ 102: [] }));
  expect(out).toMatchObject({ ok: true, chainBlocked: 1 });
  expect(out.results.find((r) => r.issueNumber === 102)).toMatchObject({
    action: 'chain_blocked',
    kind: 'frozen_prefix',
    commented: true,
  });

  await withChainStore(async (store) => {
    // Last-known-good graph preserved: the pinned edge is still on record.
    const graph = await store.getChain('chain_101');
    expect(graph.edges).toEqual([
      expect.objectContaining({ blockerIssueNumber: 101, blockedIssueNumber: 102 }),
    ]);
    expect(graph.chain.acceptedRevision).toBe(2);
    expect(await store.getChainIntakeError(key(102))).toMatchObject({ kind: 'frozen_prefix' });
  });

  // The relationship is restored: registration succeeds again, the error
  // record is cleared, and the blocked label is removed — the ordinary
  // dependency gate already re-admitted the issue, so nothing still needs it.
  const resolved = await intake(ghWith(issue(101), issue(102)), checker({ 102: [done(101)] }));
  expect(resolved).toMatchObject({ ok: true, chainBlocked: 0, alreadyExists: 2 });

  await withChainStore(async (store) => {
    expect(await store.getChainIntakeError(key(102))).toBeUndefined();
  });
  const pending = await listOutbox();
  const removal = pending.find(
    (e) =>
      e.topic === 'gh:label:remove' &&
      e.payload.issueNumber === 102 &&
      e.payload.label === 'ai:blocked' &&
      e.idempotencyKey.includes('chain-intake-resolved'),
  );
  expect(removal).toBeDefined();
}, 30_000);

test('a resolved error survives an outbox maintenance lock so the label removal is retried', async () => {
  await intake(ghWith(issue(101)), checker({}));
  await intake(ghWith(issue(101), issue(102)), checker({ 102: [done(101)] }));
  await intake(ghWith(issue(101), issue(102)), checker({ 102: [] }));

  const removals = (pending) =>
    pending.filter(
      (e) =>
        e.topic === 'gh:label:remove' &&
        e.payload.issueNumber === 102 &&
        e.idempotencyKey.includes('chain-intake-resolved'),
    );

  // The relationship is restored while a maintenance pass holds the outbox
  // lock, so the label-removal enqueue is refused. The error record must
  // outlive the refusal — deleting it first would leave no later poll with
  // any reason to retry, stranding `ai:blocked` on the issue forever.
  const lock = new SqliteMaintenanceLock(dbPath);
  expect(lock.acquire('prune:test', '2026-01-01T00:00:00.000Z')).toEqual({ ok: true });
  try {
    const locked = await intake(ghWith(issue(101), issue(102)), checker({ 102: [done(101)] }));
    expect(locked.ok).toBe(true);
  } finally {
    lock.release();
    lock.close();
  }

  await withChainStore(async (store) => {
    expect(await store.getChainIntakeError(key(102))).toMatchObject({ kind: 'frozen_prefix' });
  });
  expect(removals(await listOutbox())).toHaveLength(0);

  // Once the lock is released, the retained record drives the retry: the
  // removal is enqueued and only then is the record cleared.
  const retried = await intake(ghWith(issue(101), issue(102)), checker({ 102: [done(101)] }));
  expect(retried).toMatchObject({ ok: true, chainBlocked: 0 });

  await withChainStore(async (store) => {
    expect(await store.getChainIntakeError(key(102))).toBeUndefined();
  });
  expect(removals(await listOutbox())).toHaveLength(1);
}, 30_000);

test('a Gate-2 stackable candidate freezes a stacked base naming its open blocker', async () => {
  const out = await intake(
    ghWith(issue(110)),
    checker({ 110: [{ issueNumber: 99, state: 'open' }] }),
    async () => true,
  );
  expect(out).toMatchObject({ ok: true, enqueued: 1, chainBlocked: 0 });

  await withChainStore(async (store) => {
    const graph = await store.getChain('chain_110');
    expect(graph.members.map((m) => m.issueNumber).sort((a, b) => a - b)).toEqual([99, 110]);
    expect(graph.edges).toEqual([
      expect.objectContaining({ blockerIssueNumber: 99, blockedIssueNumber: 110 }),
    ]);
    const frozen = await store.getFrozenPrefix(key(110));
    expect(frozen).toMatchObject({
      ancestors: [99],
      predecessors: [99],
      base: { kind: 'stacked', baseRef: 'ai/issue-99', baseIssueNumber: 99 },
    });
  });
});
