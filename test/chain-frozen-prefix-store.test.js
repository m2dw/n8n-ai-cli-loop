/**
 * Persisted frozen prefixes and the atomic application port (issue #891).
 *
 * Two guarantees are pinned here and nowhere else:
 *
 *   - a freeze either records its snapshot *and* advances its task, or does
 *     neither — there is no half-frozen state a retry cannot tell apart;
 *   - a repeated freeze is a no-op that keeps the first freeze's provenance,
 *     while a *different* contract at the same key is refused rather than
 *     overwriting the ancestry a task is already running against.
 */
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  CorruptFrozenPrefixError,
  SqliteChainRegistryStore,
  SqliteTaskStore,
  buildFrozenPrefix,
  checkFrozenPrefixes,
} from '../dist/index.js';

const NOW = '2026-08-08T10:00:00.000Z';
const LATER = '2026-08-08T11:00:00.000Z';

const LINEAR = {
  members: [{ issueNumber: 1, role: 'head' }, { issueNumber: 2 }, { issueNumber: 3 }],
  edges: [
    { blockerIssueNumber: 1, blockedIssueNumber: 2 },
    { blockerIssueNumber: 2, blockedIssueNumber: 3 },
  ],
};

let tmpDir;
let dbPath;
let registry;
let tasks;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'chain-frozen-prefix-'));
  dbPath = join(tmpDir, 'dev_loop.db');
  registry = new SqliteChainRegistryStore(dbPath);
  tasks = new SqliteTaskStore(dbPath);
  const created = await registry.createChain({
    sessionId: 's1',
    headIssueNumber: 1,
    members: LINEAR.members,
    edges: LINEAR.edges,
    now: NOW,
  });
  if (!created.ok) throw new Error(`createChain failed: ${created.code}`);
});

afterEach(() => {
  tasks.close();
  registry.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function snapshotFor(issueNumber = 3, overrides = {}) {
  return buildFrozenPrefix({
    sessionId: 's1',
    issueNumber,
    chainId: 'chain_1',
    graph: LINEAR,
    graphRevision: 1,
    graphFingerprint: 'sha256:accepted',
    base: { kind: 'stacked', baseRef: 'ai/issue-2', baseIssueNumber: 2 },
    source: 'intake',
    frozenAt: NOW,
    ...overrides,
  });
}

async function enqueue(issueNumber = 3) {
  const result = await tasks.enqueueTask({
    sessionId: 's1',
    issueNumber,
    phase: 'implementation',
    now: NOW,
  });
  if (!result.ok) throw new Error(`enqueueTask failed: ${result.code}`);
  return result.value;
}

function startTransition(issueNumber = 3, overrides = {}) {
  return {
    key: { sessionId: 's1', issueNumber },
    expected: { status: 'queued' },
    patch: { status: 'running', ownerRunId: 'run-1', now: LATER },
    event: {
      task: { sessionId: 's1', issueNumber },
      type: 'chain.prefix.frozen',
      createdAt: LATER,
    },
    ...overrides,
  };
}

/* ---------------------------------------------------------------------
 * Plain snapshot storage
 * ------------------------------------------------------------------ */

test('a snapshot round-trips through the registry store unchanged', async () => {
  const snapshot = snapshotFor();
  const written = await registry.putFrozenPrefix(snapshot);

  expect(written.ok).toBe(true);
  expect(written.value).toEqual(snapshot);
  expect(await registry.getFrozenPrefix({ sessionId: 's1', issueNumber: 3 })).toEqual(snapshot);
  expect(await registry.listFrozenPrefixes({ chainId: 'chain_1' })).toEqual([snapshot]);
});

test('re-recording the same contract keeps the first freeze provenance', async () => {
  await registry.putFrozenPrefix(snapshotFor());
  // Same contract, taken later and from a newer accepted revision.
  const again = await registry.putFrozenPrefix(
    snapshotFor(3, { graphRevision: 7, graphFingerprint: 'sha256:newer', frozenAt: LATER }),
  );

  expect(again.ok).toBe(true);
  expect(again.value).toMatchObject({
    graphRevision: 1,
    graphFingerprint: 'sha256:accepted',
    frozenAt: NOW,
  });
});

test('a different contract at the same key is refused, not overwritten', async () => {
  await registry.putFrozenPrefix(snapshotFor());
  const conflicting = await registry.putFrozenPrefix(
    snapshotFor(3, { base: { kind: 'default', baseRef: 'origin/main' } }),
  );

  expect(conflicting).toEqual({
    ok: false,
    code: 'already_exists',
    detail: 'issue 3 is already frozen with a different prefix',
  });
  expect((await registry.getFrozenPrefix({ sessionId: 's1', issueNumber: 3 })).base).toEqual({
    kind: 'stacked',
    baseRef: 'ai/issue-2',
    baseIssueNumber: 2,
  });
});

test('freezing against a chain that does not exist is refused', async () => {
  const result = await registry.putFrozenPrefix(snapshotFor(3, { chainId: 'chain_9' }));

  expect(result).toEqual({ ok: false, code: 'not_found', detail: 'no such chain: chain_9' });
});

test("freezing against another session's chain is refused", async () => {
  // Chain IDs are global; ownership is not. A prefix pinned to a chain this
  // session does not own would come back out of `listFrozenPrefixes({ chainId })`
  // as a constraint on a run whose ancestry it never described.
  const other = await registry.createChain({
    sessionId: 's2',
    chainId: 'chain_77',
    headIssueNumber: 1,
    members: LINEAR.members,
    edges: LINEAR.edges,
    now: NOW,
  });
  expect(other.ok).toBe(true);

  const result = await registry.putFrozenPrefix(snapshotFor(3, { chainId: 'chain_77' }));

  expect(result.ok).toBe(false);
  expect(result.code).toBe('not_found');
  expect(result.detail).toMatch(/chain chain_77 belongs to session s2, not s1/);
  expect(await registry.listFrozenPrefixes()).toEqual([]);
});

test('a malformed snapshot never reaches the table', async () => {
  const result = await registry.putFrozenPrefix({ ...snapshotFor(), ancestors: [1] });

  expect(result.ok).toBe(false);
  expect(result.code).toBe('invalid_input');
  expect(await registry.listFrozenPrefixes()).toEqual([]);
});

test('deleting a frozen prefix is idempotent', async () => {
  await registry.putFrozenPrefix(snapshotFor());

  expect(await registry.deleteFrozenPrefix({ sessionId: 's1', issueNumber: 3 })).toEqual({
    ok: true,
    value: { deleted: true },
  });
  expect(await registry.deleteFrozenPrefix({ sessionId: 's1', issueNumber: 3 })).toEqual({
    ok: true,
    value: { deleted: false },
  });
});

test('deleting a chain takes its frozen prefixes with it', async () => {
  await registry.putFrozenPrefix(snapshotFor());
  await registry.deleteChain('chain_1');

  expect(await registry.listFrozenPrefixes()).toEqual([]);
});

test('several started issues in one chain are listed together, ascending', async () => {
  await registry.putFrozenPrefix(snapshotFor(2));
  await registry.putFrozenPrefix(snapshotFor(3));

  expect((await registry.listFrozenPrefixes({ sessionId: 's1' })).map((s) => s.issueNumber)).toEqual([
    2, 3,
  ]);
});

test('stored snapshots guard a candidate graph end to end', async () => {
  await registry.putFrozenPrefix(snapshotFor(3));
  const snapshots = await registry.listFrozenPrefixes({ chainId: 'chain_1' });

  // Appending below 3 is fine; prepending above it is not.
  expect(
    checkFrozenPrefixes({
      candidate: {
        members: [...LINEAR.members, { issueNumber: 4 }],
        edges: [...LINEAR.edges, { blockerIssueNumber: 3, blockedIssueNumber: 4 }],
      },
      snapshots,
    }),
  ).toEqual({ ok: true, evaluated: 1 });

  const prepended = checkFrozenPrefixes({
    candidate: {
      members: [...LINEAR.members, { issueNumber: 9 }],
      edges: [...LINEAR.edges, { blockerIssueNumber: 9, blockedIssueNumber: 1 }],
    },
    snapshots,
  });
  expect(prepended.code).toBe('frozen_prefix_conflict');
  expect(prepended.violations.map((v) => v.code)).toContain('ancestor_added');
});

test('a row edited into a different contract is refused, not handed to the guard', async () => {
  await registry.putFrozenPrefix(snapshotFor(3));

  // Still well-formed JSON, still a list of issue numbers — but no longer the
  // ancestry the fingerprint was taken over. Decoding it would hand the guard a
  // prefix nobody ever froze, which is the one input it cannot check itself.
  const db = new Database(dbPath);
  try {
    db.prepare('UPDATE dependency_chain_frozen_prefix SET ancestors = ?').run('[1]');
  } finally {
    db.close();
  }

  await expect(registry.listFrozenPrefixes({ chainId: 'chain_1' })).rejects.toThrow(
    CorruptFrozenPrefixError,
  );
  await expect(registry.getFrozenPrefix({ sessionId: 's1', issueNumber: 3 })).rejects.toThrow(
    /fingerprint does not match/,
  );
});

/* ---------------------------------------------------------------------
 * The atomic application port
 * ------------------------------------------------------------------ */

test('a freeze records the snapshot and advances the task in one write', async () => {
  await enqueue();
  const snapshot = snapshotFor();

  const result = await tasks.freezeChainPrefix({ snapshot, transition: startTransition() });

  expect(result.ok).toBe(true);
  expect(result.alreadyFrozen).toBe(false);
  expect(result.snapshot).toEqual(snapshot);
  expect(result.task.status).toBe('running');
  // Written through the task store's connection, readable through the
  // registry's: one table, one file.
  expect(await registry.getFrozenPrefix({ sessionId: 's1', issueNumber: 3 })).toEqual(snapshot);
  expect((await tasks.listEvents({ sessionId: 's1', issueNumber: 3 })).map((e) => e.type)).toEqual([
    'chain.prefix.frozen',
  ]);
});

test('repeating the same freeze is a no-op and does not re-run the transition', async () => {
  await enqueue();
  await tasks.freezeChainPrefix({ snapshot: snapshotFor(), transition: startTransition() });

  // The task has legitimately moved on since; the repeat must not fail on a
  // compare-and-set that describes a state the first freeze already left.
  const repeat = await tasks.freezeChainPrefix({
    snapshot: snapshotFor(3, { graphRevision: 4, frozenAt: LATER }),
    transition: startTransition(),
  });

  expect(repeat.ok).toBe(true);
  expect(repeat.alreadyFrozen).toBe(true);
  expect(repeat.snapshot).toMatchObject({ graphRevision: 1, frozenAt: NOW });
  expect(repeat.task.status).toBe('running');
  // No second event: the repeat wrote nothing at all.
  expect(await tasks.listEvents({ sessionId: 's1', issueNumber: 3 })).toHaveLength(1);
});

test('a different contract for an already-frozen task is a frozen_prefix_conflict', async () => {
  await enqueue();
  await tasks.freezeChainPrefix({ snapshot: snapshotFor(), transition: startTransition() });

  const conflicting = await tasks.freezeChainPrefix({
    snapshot: snapshotFor(3, { base: { kind: 'default', baseRef: 'origin/main' } }),
    transition: startTransition(3, { expected: { status: 'running' }, patch: { status: 'done' } }),
  });

  expect(conflicting.ok).toBe(false);
  expect(conflicting.code).toBe('frozen_prefix_conflict');
  expect(conflicting.frozen.base).toEqual({
    kind: 'stacked',
    baseRef: 'ai/issue-2',
    baseIssueNumber: 2,
  });
  // The refusal left the task exactly where it was.
  expect((await tasks.getTask({ sessionId: 's1', issueNumber: 3 })).status).toBe('running');
});

test('a lost compare-and-set persists no snapshot at all', async () => {
  await enqueue();

  const result = await tasks.freezeChainPrefix({
    snapshot: snapshotFor(),
    transition: startTransition(3, { expected: { status: 'running' } }),
  });

  expect(result.ok).toBe(false);
  expect(result.code).toBe('conflict');
  expect(result.current.status).toBe('queued');
  // The whole point of the port: no half-applied freeze to reason about.
  expect(await registry.getFrozenPrefix({ sessionId: 's1', issueNumber: 3 })).toBeUndefined();
  expect(await tasks.listEvents({ sessionId: 's1', issueNumber: 3 })).toEqual([]);
});

test('a freeze against an unknown chain advances nothing', async () => {
  await enqueue();

  const result = await tasks.freezeChainPrefix({
    snapshot: snapshotFor(3, { chainId: 'chain_9' }),
    transition: startTransition(),
  });

  expect(result).toMatchObject({ ok: false, code: 'not_found' });
  expect((await tasks.getTask({ sessionId: 's1', issueNumber: 3 })).status).toBe('queued');
  expect(await registry.listFrozenPrefixes()).toEqual([]);
});

test("a freeze against another session's chain advances nothing", async () => {
  await enqueue();
  const other = await registry.createChain({
    sessionId: 's2',
    chainId: 'chain_77',
    headIssueNumber: 1,
    members: LINEAR.members,
    edges: LINEAR.edges,
    now: NOW,
  });
  expect(other.ok).toBe(true);

  const result = await tasks.freezeChainPrefix({
    snapshot: snapshotFor(3, { chainId: 'chain_77' }),
    transition: startTransition(),
  });

  expect(result.ok).toBe(false);
  expect(result.code).toBe('not_found');
  expect(result.detail).toMatch(/chain chain_77 belongs to session s2, not s1/);
  expect((await tasks.getTask({ sessionId: 's1', issueNumber: 3 })).status).toBe('queued');
  expect(await registry.listFrozenPrefixes()).toEqual([]);
});

test('a freeze for a task that does not exist writes nothing', async () => {
  const result = await tasks.freezeChainPrefix({
    snapshot: snapshotFor(),
    transition: startTransition(),
  });

  expect(result).toMatchObject({ ok: false, code: 'not_found', detail: 'no such task' });
  expect(await registry.listFrozenPrefixes()).toEqual([]);
});

test('a snapshot paired with another task key is refused before anything is written', async () => {
  await enqueue(2);
  await enqueue(3);

  const result = await tasks.freezeChainPrefix({
    snapshot: snapshotFor(3),
    transition: startTransition(2),
  });

  expect(result.ok).toBe(false);
  expect(result.code).toBe('invalid_input');
  expect(result.detail).toMatch(/snapshot names s1#3 but the transition names s1#2/);
  expect(await registry.listFrozenPrefixes()).toEqual([]);
  expect((await tasks.getTask({ sessionId: 's1', issueNumber: 2 })).status).toBe('queued');
});

test('a malformed snapshot is refused before the transition is attempted', async () => {
  await enqueue();

  const result = await tasks.freezeChainPrefix({
    snapshot: { ...snapshotFor(), graphFingerprint: '' },
    transition: startTransition(),
  });

  expect(result).toMatchObject({ ok: false, code: 'invalid_input' });
  expect((await tasks.getTask({ sessionId: 's1', issueNumber: 3 })).status).toBe('queued');
});

test('two started issues in one chain each freeze independently', async () => {
  await enqueue(2);
  await enqueue(3);

  const two = await tasks.freezeChainPrefix({
    snapshot: snapshotFor(2, { base: { kind: 'stacked', baseRef: 'ai/issue-1', baseIssueNumber: 1 } }),
    transition: startTransition(2),
  });
  const three = await tasks.freezeChainPrefix({
    snapshot: snapshotFor(3),
    transition: startTransition(3),
  });

  expect([two.ok, three.ok]).toEqual([true, true]);
  const stored = await registry.listFrozenPrefixes({ chainId: 'chain_1' });
  expect(stored.map((s) => [s.issueNumber, s.ancestors])).toEqual([
    [2, [1]],
    [3, [1, 2]],
  ]);
});

test('the task store brings the frozen-prefix table with it, whichever store opens the file first', () => {
  // The freeze path writes this table from the task store's own connection, so
  // it must not depend on `SqliteChainRegistryStore` ever having opened the
  // file. A fresh path nothing else has touched proves that.
  const soloPath = join(tmpDir, 'solo.db');
  const solo = new SqliteTaskStore(soloPath);
  solo.close();

  const db = new Database(soloPath);
  try {
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r) => r.name);
    expect(names).toEqual(
      expect.arrayContaining(['tasks', 'dependency_chain', 'dependency_chain_frozen_prefix']),
    );
  } finally {
    db.close();
  }
});

test('a snapshot written through the task store is readable through the registry store', async () => {
  await enqueue();
  await tasks.freezeChainPrefix({ snapshot: snapshotFor(), transition: startTransition() });

  // Different connection, same file, same serialization — the freeze is not a
  // private encoding the guard cannot read back.
  const reopened = new SqliteChainRegistryStore(dbPath);
  try {
    expect(await reopened.listFrozenPrefixes({ chainId: 'chain_1' })).toEqual([snapshotFor()]);
  } finally {
    reopened.close();
  }
});
